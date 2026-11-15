use super::*;
#[tokio::test]
#[ignore = "requires disposable local DBTERM_TEST_MYSQL_PORT"]
async fn mysql_skip_retains_valid_rows_and_rejects_nontransactional_target() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"import-test","name":"test","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut conn, _) = mysql_connect(&cfg, None).await.unwrap();
    let db = format!("dbterm_import_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {}", q_mysql(&db)))
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE {}.t(id INT PRIMARY KEY,v DECIMAL(4,1)) ENGINE=InnoDB",
        q_mysql(&db)
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let rows = vec![
        vec![Some("1".into()), Some("1.0".into())],
        vec![Some("1".into()), Some("2.0".into())],
        vec![Some("2".into()), Some("1.25".into())],
        vec![Some("3".into()), Some("3.0".into())],
    ];
    let outcome = mysql_import_rows(
        &cfg,
        None,
        &db,
        "t",
        &["id".into(), "v".into()],
        &rows,
        true,
        "skip",
    )
    .await;
    let actual: Vec<(i32, String)> = sqlx::query_as(&format!(
        "SELECT id,CAST(v AS CHAR) FROM {}.t ORDER BY id",
        q_mysql(&db)
    ))
    .fetch_all(&mut conn)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE {}.legacy(id INT) ENGINE=MyISAM",
        q_mysql(&db)
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let legacy = mysql_import_rows(
        &cfg,
        None,
        &db,
        "legacy",
        &["id".into()],
        &[vec![Some("1".into())]],
        false,
        "skip",
    )
    .await;
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}.legacy", q_mysql(&db)))
        .fetch_one(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!("DROP DATABASE {}", q_mysql(&db)))
        .execute(&mut conn)
        .await
        .unwrap();
    let result = outcome.unwrap();
    assert_eq!((result.inserted, result.skipped), (2, 2));
    assert_eq!(actual, vec![(1, "1.0".into()), (3, "3.0".into())]);
    assert!(legacy.is_err());
    assert_eq!(count, 0);
}
#[tokio::test]
#[ignore = "requires disposable local DBTERM_TEST_PG_PORT"]
async fn pg_skip_handles_typed_columns_and_bad_rows_without_aborting_valid_records() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"import-test","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut conn, _) = pg_connect(&cfg, None).await.unwrap();
    let schema = format!("dbterm_import_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE {schema}.t(id INT PRIMARY KEY,v TEXT)"
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let rows = vec![
        vec![Some("1".into()), Some("001".into())],
        vec![Some("1".into()), Some("duplicate".into())],
        vec![Some("bad".into()), Some("bad".into())],
        vec![Some("2".into()), None],
    ];
    let outcome = pg_import_rows(
        &cfg,
        None,
        &schema,
        "t",
        &["id".into(), "v".into()],
        &rows,
        true,
        "skip",
    )
    .await;
    let actual: Vec<(i32, Option<String>)> =
        sqlx::query_as(&format!("SELECT id,v FROM {schema}.t ORDER BY id"))
            .fetch_all(&mut conn)
            .await
            .unwrap();
    sqlx::query(&format!("CREATE FUNCTION {schema}.reject_five() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.id=5 THEN RAISE EXCEPTION ''blocked''; END IF; RETURN NEW; END'")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER reject_five BEFORE INSERT ON {schema}.t FOR EACH ROW EXECUTE FUNCTION {schema}.reject_five()")).execute(&mut conn).await.unwrap();
    let mut fatal_rows = (1000..1202)
        .map(|i| vec![Some(i.to_string()), None])
        .collect::<Vec<_>>();
    fatal_rows.push(vec![Some("5".into()), None]);
    let fatal = pg_import_rows(
        &cfg,
        None,
        &schema,
        "t",
        &["id".into(), "v".into()],
        &fatal_rows,
        false,
        "skip",
    )
    .await;
    let after_fatal: i64 =
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {schema}.t WHERE id>=4"))
            .fetch_one(&mut conn)
            .await
            .unwrap();
    sqlx::query(&format!("DROP TRIGGER reject_five ON {schema}.t"))
        .execute(&mut conn)
        .await
        .unwrap();
    let mut many = (10..412)
        .map(|i| vec![Some(i.to_string()), Some(format!("v{i}"))])
        .collect::<Vec<_>>();
    many.push(vec![Some("10".into()), None]);
    let cross = pg_import_rows(
        &cfg,
        None,
        &schema,
        "t",
        &["id".into(), "v".into()],
        &many,
        false,
        "skip",
    )
    .await
    .unwrap();
    let cross_count: i64 =
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {schema}.t WHERE id>=10"))
            .fetch_one(&mut conn)
            .await
            .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut conn)
        .await
        .unwrap();
    assert!(fatal.is_err());
    assert_eq!(
        after_fatal, 0,
        "fatal batch must not retain valid neighboring rows"
    );
    assert_eq!((cross.inserted, cross.skipped, cross_count), (402, 1, 402));
    let result = outcome.unwrap();
    assert_eq!((result.inserted, result.skipped), (2, 2));
    assert_eq!(actual, vec![(1, Some("001".into())), (2, None)]);
}

#[tokio::test]
#[ignore = "requires disposable local DBTERM_TEST_PG_PORT"]
async fn json_pg_import_keeps_exact_numeric_precision_and_literal_null_text() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"json-import","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut conn, _) = pg_connect(&cfg, None).await.unwrap();
    let schema = format!("dbterm_json_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE {schema}.t(id NUMERIC(30,0),v NUMERIC(30,20),s TEXT,n TEXT)"
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let columns = ["id", "v", "s", "n"].map(String::from);
    let rows = super::super::import_json::records(
        r#"[{"id":123456789012345678901234567890,"v":1.23456789012345678901,"s":"NULL","n":null}]"#,
        &columns,
        "NULL",
    )
    .unwrap();
    let result = import_rows_stop(&cfg, None, &schema, "t", &columns, &rows).await;
    let actual: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as(&format!("SELECT id::text,v::text,s,n FROM {schema}.t"))
            .fetch_all(&mut conn)
            .await
            .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(result.unwrap().inserted, 1);
    assert_eq!(
        actual,
        vec![(
            "123456789012345678901234567890".into(),
            "1.23456789012345678901".into(),
            "NULL".into(),
            None
        )]
    );
}
