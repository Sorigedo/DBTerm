use super::*;
#[tokio::test]
#[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
async fn pg_grid_insert_typed_values_keep_text_and_roll_back_later_conversion() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"pg-grid-fidelity","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut conn, _) = pg_connect(&cfg, None).await.unwrap();
    let schema = format!("grid_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE TABLE {schema}.t(id INT PRIMARY KEY,n NUMERIC(20,4),b BOOLEAN,v VARCHAR(8),u UUID,a INT[],j JSONB)")).execute(&mut conn).await.unwrap();
    let columns = ["id", "n", "b", "v", "u", "a", "j"].map(String::from);
    let values = [
        "1",
        "123456789012.3400",
        "true",
        "001",
        "123e4567-e89b-12d3-a456-426614174000",
        "{1,2}",
        "{\"中文\":1}",
    ]
    .map(|v| Some(v.to_string()))
    .to_vec();
    let outcome = pg_insert_rows(&cfg, None, &schema, "t", &columns, &[values]).await;
    let actual: Vec<(i32, String, bool, String, String, String, String)> = sqlx::query_as(
        &format!("SELECT id,n::text,b,v,u::text,a::text,j::text FROM {schema}.t"),
    )
    .fetch_all(&mut conn)
    .await
    .unwrap();
    let bad = (2..204)
        .map(|i| {
            vec![
                Some(i.to_string()),
                Some(if i == 203 {
                    "bad".to_string()
                } else {
                    "2.0000".to_string()
                }),
            ]
        })
        .collect::<Vec<_>>();
    let failure = pg_insert_rows(&cfg, None, &schema, "t", &["id".into(), "n".into()], &bad).await;
    let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.t WHERE id>=2"))
        .fetch_one(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(outcome.unwrap(), 1);
    assert_eq!(actual.len(), 1);
    assert_eq!(actual[0].1, "123456789012.3400");
    assert!(actual[0].2);
    assert_eq!(actual[0].3, "001");
    assert_eq!(actual[0].5, "{1,2}");
    assert!(failure.is_err());
    assert_eq!(count, 0);
}
#[tokio::test]
#[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
async fn pg_grid_insert_rejects_oversized_text_and_retains_domain_constraints() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"pg-domain-fidelity","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut conn, _) = pg_connect(&cfg, None).await.unwrap();
    let schema = format!("grid_domain_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE DOMAIN {schema}.positive AS INT CHECK(VALUE>0)"
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TABLE {schema}.t(id INT PRIMARY KEY,v VARCHAR(3),n {schema}.positive)"
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let cols = ["id", "v", "n"].map(str::to_string);
    let make = |id: &str, v: &str, n: &str| [id, v, n].map(|s| Some(s.to_string())).to_vec();
    let good = pg_insert_rows(&cfg, None, &schema, "t", &cols, &[make("1", "001", "2")]).await;
    let oversized = pg_insert_rows(
        &cfg,
        None,
        &schema,
        "t",
        &cols,
        &[make("2", "ok", "3"), make("3", "long", "4")],
    )
    .await;
    let domain = pg_insert_rows(
        &cfg,
        None,
        &schema,
        "t",
        &cols,
        &[make("4", "ok", "3"), make("5", "bad", "-1")],
    )
    .await;
    let actual: Vec<(i32, String, i32)> =
        sqlx::query_as(&format!("SELECT id,v,n::int FROM {schema}.t"))
            .fetch_all(&mut conn)
            .await
            .unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(good.unwrap(), 1);
    assert!(oversized.is_err(), "varchar(3) must not truncate");
    assert!(domain.is_err());
    assert_eq!(actual, vec![(1, "001".into(), 2)]);
}
#[tokio::test]
#[ignore="requires disposable DBTERM_TEST_PG_PORT"]
async fn pg_type_planning_locks_target_until_transaction_finishes(){
 use sqlx::Connection;
 let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"pg-type-lock","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
 let(mut writer,_)=pg_connect(&cfg,None).await.unwrap();let(mut ddl,_)=pg_connect(&cfg,None).await.unwrap();let schema=format!("grid_lock_{}",uuid::Uuid::new_v4().simple());
 sqlx::query(&format!("CREATE SCHEMA {schema}")).execute(&mut ddl).await.unwrap();sqlx::query(&format!("CREATE TABLE {schema}.t(v TEXT)")).execute(&mut ddl).await.unwrap();
 let mut tx=writer.begin().await.unwrap();let types=pg_write_types::target_types(&mut tx,&schema,"t").await.unwrap();assert!(types.contains_key("v"));
 sqlx::query("SET lock_timeout='100ms'").execute(&mut ddl).await.unwrap();let alteration=sqlx::query(&format!("ALTER TABLE {schema}.t ALTER v TYPE INT USING v::int")).execute(&mut ddl).await;
 tx.rollback().await.unwrap();sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&mut ddl).await.unwrap();assert!(alteration.is_err(),"target must remain locked between type metadata lookup and INSERT");
}
