use super::*;
use sqlx::Connection;

fn config() -> ConnConfig {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT").expect("isolated PostgreSQL port required").parse().unwrap();
    serde_json::from_value(serde_json::json!({
        "id": "pg-delete-isolated", "name": "pg-delete-isolated", "type": "postgres",
        "host": "127.0.0.1", "port": port, "username": "postgres", "database": "postgres",
        "useSsl": false, "createdAt": 0, "updatedAt": 0
    })).unwrap()
}

async fn fixture() -> (ConnConfig, sqlx::postgres::PgConnection, String) {
    let config = config();
    let (mut conn, _) = pg_connect(&config, None).await.unwrap();
    let schema = format!("dbterm_pg_del_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {schema}.items (id integer NOT NULL, scope text NOT NULL, note text, PRIMARY KEY (id,scope))"))
        .execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {schema}.items (id,scope,note) VALUES (1,'A','Exact'),(2,'B','space '),(3,'C',NULL)"))
        .execute(&mut conn).await.unwrap();
    (config, conn, schema)
}

fn keys() -> Vec<String> { vec!["id".into(), "scope".into()] }
fn baseline(rows: Vec<Vec<Option<&str>>>) -> DeleteBaseline {
    DeleteBaseline {
        columns: vec!["id".into(), "scope".into(), "note".into()],
        rows: rows.into_iter().map(|row| row.into_iter().map(|v| v.map(str::to_string)).collect()).collect(),
    }
}
fn values(rows: Vec<(i32, &str)>) -> Vec<Vec<Option<String>>> {
    rows.into_iter().map(|(id, scope)| vec![Some(id.to_string()), Some(scope.into())]).collect()
}
async fn count(conn: &mut sqlx::postgres::PgConnection, schema: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {schema}.items")).fetch_one(conn).await.unwrap()
}
async fn cleanup(mut conn: sqlx::postgres::PgConnection, schema: &str) {
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&mut conn).await.unwrap();
    conn.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL DBTERM_TEST_PG_PORT"]
async fn pg_composite_integer_key_deletes_selected_rows_only() {
    let (config, mut conn, schema) = fixture().await;
    let pk = keys();
    let selected = values(vec![(1, "A"), (3, "C")]);
    let base = baseline(vec![vec![Some("1"),Some("A"),Some("Exact")],vec![Some("3"),Some("C"),None]]);
    base.validate(&pk, &selected).unwrap();
    let result = optimistic_delete::pg_delete_rows(&config, None, &schema, "items", &pk, &selected, &base).await;
    let remaining: Vec<(i32,String)> = sqlx::query_as(&format!("SELECT id,scope FROM {schema}.items ORDER BY id"))
        .fetch_all(&mut conn).await.unwrap();
    cleanup(conn, &schema).await;
    assert_eq!(result.unwrap(), 2);
    assert_eq!(remaining, vec![(2,"B".into())]);
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL DBTERM_TEST_PG_PORT"]
async fn pg_case_space_and_null_baseline_changes_refuse_delete() {
    let (config, mut conn, schema) = fixture().await;
    let pk = keys();
    for (id, scope, expected) in [(1,"A",Some("exact")),(2,"B",Some("space")),(3,"C",Some(""))] {
        let selected = values(vec![(id, scope)]);
        let base = baseline(vec![vec![Some(&id.to_string()),Some(scope),expected]]);
        base.validate(&pk, &selected).unwrap();
        let result = optimistic_delete::pg_delete_rows(&config, None, &schema, "items", &pk, &selected, &base).await;
        assert!(result.is_err(), "{id}/{scope}: changed baseline must be rejected");
    }
    assert_eq!(count(&mut conn, &schema).await, 3);
    cleanup(conn, &schema).await;
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL DBTERM_TEST_PG_PORT"]
async fn pg_later_stale_row_rolls_back_prior_delete() {
    let (config, mut conn, schema) = fixture().await;
    let pk = keys();
    let selected = values(vec![(1, "A"), (2, "B")]);
    let base = baseline(vec![vec![Some("1"),Some("A"),Some("Exact")],vec![Some("2"),Some("B"),Some("space")]]);
    base.validate(&pk, &selected).unwrap();
    let result = optimistic_delete::pg_delete_rows(&config, None, &schema, "items", &pk, &selected, &base).await;
    let rows: Vec<(i32,String,Option<String>)> = sqlx::query_as(&format!("SELECT id,scope,note FROM {schema}.items ORDER BY id"))
        .fetch_all(&mut conn).await.unwrap();
    cleanup(conn, &schema).await;
    assert!(result.is_err());
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].0, 1, "first delete must roll back");
    assert_eq!(rows[1].2.as_deref(), Some("space "));
}
