use super::*;
use sqlx::Connection;

#[tokio::test]
async fn production_column_changes_preserve_constraints_on_later_ddl_failure() {
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys=ON; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT CHECK(length(v)>0)); INSERT INTO t VALUES(1,'kept');").execute(&mut conn).await.unwrap();
    let make = |original: Option<&str>, name: &str, kind: &str, deleted: bool, primary: bool| AlterColDef { original_name: original.map(str::to_string), new_name: name.into(), data_type: kind.into(), nullable: true, default_value: String::new(), is_deleted: deleted, is_primary_key: primary, generated_expr: String::new(), generated_stored: false };
    let cols = vec![make(Some("id"),"id","INTEGER",true,true), make(Some("v"),"v","TEXT",false,false), make(None,"added","TEXT",false,false)];
    assert!(execute_column_changes(&mut conn, "t", &cols).await.is_err());
    let value: String = sqlx::query_scalar("SELECT v FROM t WHERE id=1").fetch_one(&mut conn).await.unwrap();
    assert_eq!(value, "kept");
    let enabled: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut conn).await.unwrap();
    assert_eq!(enabled, 1);
}

#[tokio::test]
async fn simple_alter_rejects_transaction_control_injected_through_column_definition() {
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1);").execute(&mut conn).await.unwrap();
    let col = AlterColDef { original_name: None, new_name: "v".into(), data_type: "TEXT; COMMIT; DELETE FROM t; --".into(), nullable: true, default_value: String::new(), is_deleted: false, is_primary_key: false, generated_expr: String::new(), generated_stored: false };
    let script = build_simple_alter_sql("t", &[col]);
    assert!(alter_execute::simple(&mut conn, &script).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM t").fetch_one(&mut conn).await.unwrap();
    assert_eq!(count, 1, "DDL fragment must never commit a hidden second statement");
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('t')").fetch_all(&mut conn).await.unwrap();
    assert_eq!(cols, ["id"]);
}

#[tokio::test]
async fn simple_alter_later_error_rolls_back_first_column_and_preserves_literal() {
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE t(id INTEGER PRIMARY KEY)").execute(&mut conn).await.unwrap();
    let error = alter_execute::simple(&mut conn, "ALTER TABLE t ADD COLUMN added TEXT;\nALTER TABLE t ADD COLUMN id TEXT;").await.unwrap_err();
    assert!(error.contains("回滚"));
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('t')").fetch_all(&mut conn).await.unwrap();
    assert_eq!(cols, ["id"]);
    alter_execute::simple(&mut conn, "ALTER TABLE t ADD COLUMN v TEXT DEFAULT 'a;\nb';").await.unwrap();
    sqlx::query("INSERT INTO t(id) VALUES(1)").execute(&mut conn).await.unwrap();
    let value: String = sqlx::query_scalar("SELECT v FROM t").fetch_one(&mut conn).await.unwrap();
    assert_eq!(value, "a;\nb");
}

#[tokio::test]
async fn rebuild_foreign_key_violation_rolls_back_all_changes() {
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(pid INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1);").execute(&mut conn).await.unwrap();
    let result = execute_rebuild_script(&mut conn, "PRAGMA foreign_keys = OFF;\nBEGIN;\nDELETE FROM parent;\nPRAGMA foreign_key_check;\nCOMMIT;\nPRAGMA foreign_keys = ON;\n").await;
    assert!(result.is_err(), "foreign key result rows must prevent commit");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM parent").fetch_one(&mut conn).await.unwrap();
    assert_eq!(count, 1);
    let enabled: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut conn).await.unwrap();
    assert_eq!(enabled, 1);
}

#[tokio::test]
async fn rebuild_preserves_trigger_body_semicolons_and_multiline_text() {
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql("CREATE TABLE t(v TEXT); CREATE TABLE log(v TEXT);").execute(&mut conn).await.unwrap();
    let result = execute_rebuild_script(&mut conn, "PRAGMA foreign_keys = OFF;\nBEGIN;\nCREATE TRIGGER keep AFTER INSERT ON t BEGIN INSERT INTO log VALUES('first;\nsecond');\nINSERT INTO log VALUES('last');\nEND;\nPRAGMA foreign_key_check;\nCOMMIT;\nPRAGMA foreign_keys = ON;\n").await;
    assert!(result.is_ok(), "trigger must remain a single statement: {result:?}");
    sqlx::query("INSERT INTO t VALUES('v')").execute(&mut conn).await.unwrap();
    let rows: Vec<String> = sqlx::query_scalar("SELECT v FROM log ORDER BY rowid").fetch_all(&mut conn).await.unwrap();
    assert_eq!(rows, ["first;\nsecond", "last"]);
}
