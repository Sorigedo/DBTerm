use super::*;
#[tokio::test]
async fn sqlite_delete_refuses_row_changed_after_grid_read() {
    let path =
        std::env::temp_dir().join(format!("dbterm-delete-opt-{}.sqlite", uuid::Uuid::new_v4()));
    std::fs::File::create(&path).unwrap();
    let config:ConnConfig=serde_json::from_value(serde_json::json!({"id":"delete-opt","name":"delete-opt","type":"sqlite","filePath":path.to_str().unwrap(),"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let pool = sqlx::SqlitePool::connect(&super::super::query::sqlite_url(&config).unwrap())
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'newer')")
        .execute(&pool)
        .await
        .unwrap();
    let result = optimistic_delete::sqlite_delete_rows_impl(
        &config,
        "main",
        "t",
        &["id".into()],
        &[vec![Some("1".into())]],
        &DeleteBaseline {
            columns: vec!["id".into(), "v".into()],
            rows: vec![vec![Some("1".into()), Some("old".into())]],
        },
    )
    .await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM t")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    std::fs::remove_file(path).unwrap();
    assert!(
        result.is_err(),
        "row read as old but now newer must not be deleted"
    );
    assert_eq!(count, 1);
}
#[tokio::test]
async fn legacy_pk_only_delete_demonstrates_newer_row_would_be_lost() {
    let path = std::env::temp_dir().join(format!(
        "dbterm-delete-legacy-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    std::fs::File::create(&path).unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"legacy-delete","name":"delete","type":"sqlite","filePath":path.to_str().unwrap(),"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let pool = sqlx::SqlitePool::connect(&super::super::query::sqlite_url(&cfg).unwrap())
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'newer')")
        .execute(&pool)
        .await
        .unwrap();
    let deleted =
        sqlite_delete_rows_impl(&cfg, "main", "t", &["id".into()], &[vec![Some("1".into())]])
            .await
            .unwrap();
    assert_eq!(
        deleted, 1,
        "historical unsafe helper deletes newer row using only stale PK"
    );
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
#[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn mysql_delete_baseline_is_exact_and_later_stale_row_rolls_back() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"delete-opt","name":"delete","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut c, _) = mysql_connect(&cfg, None).await.unwrap();
    let db = format!("dbterm_delete_opt_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
    sqlx::query(&format!("CREATE TABLE {db}.t(id INT PRIMARY KEY,v VARCHAR(30) COLLATE utf8mb4_0900_ai_ci) ENGINE=InnoDB")).execute(&mut c).await.unwrap();
    sqlx::query(&format!("INSERT INTO {db}.t VALUES(1,'newer'),(2,'keep')"))
        .execute(&mut c)
        .await
        .unwrap();
    let base = DeleteBaseline {
        columns: vec!["id".into(), "v".into()],
        rows: vec![
            vec![Some("2".into()), Some("keep".into())],
            vec![Some("1".into()), Some("old".into())],
        ],
    };
    let keys = vec!["id".into()];
    let values = vec![vec![Some("2".into())], vec![Some("1".into())]];
    assert!(
        optimistic_delete::mysql_delete_rows(&cfg, None, &db, "t", &keys, &values, &base)
            .await
            .unwrap_err()
            .contains("已回滚")
    );
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {db}.t"))
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let base = DeleteBaseline {
        columns: vec!["id".into(), "v".into()],
        rows: vec![vec![Some("1".into()), Some("NEWER".into())]],
    };
    assert!(
        optimistic_delete::mysql_delete_rows(&cfg, None, &db, "t", &keys, &values[1..], &base)
            .await
            .is_err()
    );
    let base = DeleteBaseline {
        columns: vec!["id".into(), "v".into()],
        rows: vec![vec![Some("1".into()), Some("newer".into())]],
    };
    assert_eq!(
        optimistic_delete::mysql_delete_rows(&cfg, None, &db, "t", &keys, &values[1..], &base)
            .await
            .unwrap(),
        1
    );
    sqlx::query(&format!("DROP DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
}
#[test]
fn delete_baseline_requires_unique_columns_original_keys_and_complete_rows() {
    let keys = vec!["id".into()];
    let values = vec![vec![Some("1".into())]];
    let valid = DeleteBaseline {
        columns: vec!["id".into(), "v".into()],
        rows: vec![vec![Some("1".into()), None]],
    };
    assert!(valid.validate(&keys, &values).is_ok());
    for bad in [
        DeleteBaseline {
            columns: vec!["v".into()],
            rows: vec![vec![None]],
        },
        DeleteBaseline {
            columns: vec!["id".into(), "id".into()],
            rows: vec![vec![Some("1".into()), Some("1".into())]],
        },
        DeleteBaseline {
            columns: vec!["id".into()],
            rows: vec![vec![Some("2".into())]],
        },
    ] {
        assert!(bad.validate(&keys, &values).is_err());
    }
}
