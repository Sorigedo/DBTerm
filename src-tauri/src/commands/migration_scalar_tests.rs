use super::*;
#[tokio::test]
#[ignore = "requires explicitly disposable local PostgreSQL DBTERM_TEST_PG_PORT"]
async fn postgres_failed_restore_reports_and_preserves_backup_when_target_cannot_be_dropped() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"pg-restore-acceptance","name":"disposable","type":"postgres","host":"127.0.0.1",
        "port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0
    })).unwrap();
    let (mut conn, _) = pg_connect(&config, None).await.unwrap();
    let schema = format!("dbterm_restore_{}", uuid::Uuid::new_v4().simple());
    let backup = format!("{}.{}", q_dq(&schema), q_dq("__mig_bak_fixture"));
    let target = format!("{}.{}", q_dq(&schema), q_dq("target"));
    sqlx::query(&format!("CREATE SCHEMA {}", q_dq(&schema))).execute(&mut conn).await.unwrap();
    let fk_target = format!("{}.{}", q_dq(&schema), q_dq("fk_target"));
    sqlx::query(&format!("CREATE TABLE {fk_target}(id int primary key)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {fk_target} VALUES(11)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {}.fk_dependent(id int references {fk_target}(id))", q_dq(&schema))).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {}.fk_dependent VALUES(11)", q_dq(&schema))).execute(&mut conn).await.unwrap();
    let columns = vec!["id".to_string()];
    let types = vec!["integer".to_string()];
    let error = match open_stream_dst(&config, None, &schema, "fk_target", "replace", true, false, false, false,
        &columns, &types, false, "", &ConnType::Postgres, "source", None, None).await {
        Err(error) => error,
        Ok(_) => panic!("replacement must reject a target referenced by a foreign key"),
    };
    assert!(error.contains("外键引用"), "{error}");
    let fk_value: i32 = sqlx::query_scalar(&format!("SELECT id FROM {fk_target}")).fetch_one(&mut conn).await.unwrap();
    assert_eq!(fk_value, 11, "foreign-key protected target must remain unchanged");
    sqlx::query(&format!("CREATE TABLE {backup}(id int primary key)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {backup} VALUES(7)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {target}(id int primary key)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {target} VALUES(9)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {}.dependent(id int references {target}(id))", q_dq(&schema)))
        .execute(&mut conn).await.unwrap();

    let error = pg_restore_backup(&mut conn, Some(&backup), &target, "target", None).await.unwrap_err();
    assert!(error.contains("恢复") && error.contains(&backup), "recovery failure must identify retained backup: {error}");
    let backup_id: i32 = sqlx::query_scalar(&format!("SELECT id FROM {backup}")).fetch_one(&mut conn).await.unwrap();
    let target_id: i32 = sqlx::query_scalar(&format!("SELECT id FROM {target}")).fetch_one(&mut conn).await.unwrap();
    assert_eq!((backup_id, target_id), (7, 9), "failed recovery must preserve both old backup and blocking target");
    sqlx::query(&format!("DROP TABLE {}.dependent, {target}", q_dq(&schema))).execute(&mut conn).await.unwrap();
    pg_restore_backup(&mut conn, Some(&backup), &target, "target", None).await.unwrap();
    let restored: i32 = sqlx::query_scalar(&format!("SELECT id FROM {target}")).fetch_one(&mut conn).await.unwrap();
    assert_eq!(restored, 7, "recovery succeeds after conflicting table is removed");
    sqlx::query(&format!("CREATE TABLE {}.new_target(id int)", q_dq(&schema))).execute(&mut conn).await.unwrap();
    let new_target = format!("{}.{}", q_dq(&schema), q_dq("new_target"));
    let new_oid = pg_relation_oid(&mut conn, &new_target).await.unwrap();
    pg_restore_backup(&mut conn, None, &new_target, "new_target", new_oid).await.unwrap();
    assert!(pg_relation_oid(&mut conn, &new_target).await.unwrap().is_none(), "failed first migration removes only its own new target");
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", q_dq(&schema))).execute(&mut conn).await.unwrap();
}

#[test]
fn postgres_commit_error_is_not_treated_as_confirmed_rollback_for_table_recovery() {
    assert!(pg_commit_outcome_unknown("提交事务失败: connection lost"));
    assert!(pg_commit_outcome_unknown("提交事务失败: server closed the connection"));
    assert!(!pg_commit_outcome_unknown("读取源数据失败: timeout"));
}

#[tokio::test]
#[ignore = "requires explicitly disposable local PostgreSQL DBTERM_TEST_PG_PORT"]
async fn postgres_restore_transaction_rolls_back_target_drop_if_backup_rename_fails() {
    let port: u16 = std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"pg-restore-transaction","name":"disposable","type":"postgres","host":"127.0.0.1",
        "port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0
    })).unwrap();
    let (mut conn, _) = pg_connect(&config, None).await.unwrap();
    let schema = format!("dbterm_restore_tx_{}", uuid::Uuid::new_v4().simple());
    let backup = format!("{}.{}", q_dq(&schema), q_dq("backup"));
    let target = format!("{}.{}", q_dq(&schema), q_dq("target"));
    sqlx::query(&format!("CREATE SCHEMA {}", q_dq(&schema))).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {backup}(id int primary key)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("CREATE TABLE {target}(id int primary key)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {backup} VALUES(7)")).execute(&mut conn).await.unwrap();
    sqlx::query(&format!("INSERT INTO {target} VALUES(9)")).execute(&mut conn).await.unwrap();
    let target_oid = pg_relation_oid(&mut conn, &target).await.unwrap();
    let missing_backup = format!("{}.{}", q_dq(&schema), q_dq("missing_backup"));
    let error = pg_restore_backup(&mut conn, Some(&missing_backup), &target, "target", target_oid).await.unwrap_err();
    assert!(error.contains("正式表恢复失败") && error.contains(&missing_backup), "must reach ALTER after successful DROP: {error}");
    assert_eq!(pg_relation_oid(&mut conn, &target).await.unwrap(), target_oid, "failed backup rename must rollback target drop with original identity");
    let value: i32 = sqlx::query_scalar(&format!("SELECT id FROM {target}")).fetch_one(&mut conn).await.unwrap();
    assert_eq!(value, 9, "rollback must restore target contents");
    assert!(pg_relation_oid(&mut conn, &backup).await.unwrap().is_some(), "failed backup restore must keep backup");
    pg_restore_backup(&mut conn, Some(&backup), &target, "target", target_oid).await.unwrap();
    let restored: i32 = sqlx::query_scalar(&format!("SELECT id FROM {target}")).fetch_one(&mut conn).await.unwrap();
    assert_eq!(restored, 7, "same connection must remain usable for successful recovery");
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", q_dq(&schema))).execute(&mut conn).await.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn mysql_stream_preserves_set_bitmasks_even_when_text_labels_collide() {
    use futures::{StreamExt, TryStreamExt};
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"scalar","name":"scalar","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut c, _) = mysql_connect(&cfg, None).await.unwrap();
    let db = format!("dbterm_scalar_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
    let src = mysql_qualified(&db, "source");
    let dst = mysql_qualified(&db, "target");
    sqlx::query(&format!(
        "CREATE TABLE {src}(id INT PRIMARY KEY,s SET('','a'),e ENUM('2','1')) ENGINE=InnoDB"
    ))
    .execute(&mut c)
    .await
    .unwrap();
    sqlx::query(&format!("INSERT INTO {src} VALUES(1,0,1),(2,1,2)"))
        .execute(&mut c)
        .await
        .unwrap();
    let raw = mysql_read_ddl(&mut c, &src).await.unwrap();
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut c)
        .await
        .unwrap();
    let cols = vec!["id".to_string(), "s".to_string(), "e".to_string()];
    let types = vec!["int".into(), "set('','a')".into(), "enum('2','1')".into()];
    let setup = open_stream_dst(
        &cfg,
        None,
        &db,
        "target",
        "replace",
        true,
        false,
        false,
        true,
        &cols,
        &types,
        false,
        "",
        &ConnType::Mysql,
        "source",
        Some(&raw),
        Some(&mode),
    )
    .await
    .unwrap()
    .unwrap();
    let select = format!(
        "SELECT {} FROM {src} ORDER BY id",
        mysql_migration_projection(&cols, &types).unwrap()
    );
    let stream = sqlx::query(&select)
        .fetch(&mut c)
        .and_then(|row| async move { mysql_transfer_row(&row) })
        .boxed();
    let result = drive_stream(
        stream,
        setup,
        &cols,
        "error",
        false,
        true,
        false,
        1,
        2,
        &|_, _, _| {},
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(result.migrated_rows, 2);

    let enum_values: Vec<u64> = sqlx::query_scalar(&format!(
        "SELECT CAST(e AS UNSIGNED) FROM {dst} ORDER BY id"
    ))
    .fetch_all(&mut c)
    .await
    .unwrap();
    assert_eq!(enum_values, vec![1, 2]);
    let values: Vec<u64> = sqlx::query_scalar(&format!(
        "SELECT CAST(s AS UNSIGNED) FROM {dst} ORDER BY id"
    ))
    .fetch_all(&mut c)
    .await
    .unwrap();
    sqlx::query(&format!("DROP DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
    assert_eq!(
        values,
        vec![0, 1],
        "text transfer maps distinct valid SET bitmasks to the same target value"
    );
}
#[test]
fn active_stream_uses_scalar_projection_and_rechecks_unsupported_types_before_target_setup() {
    let source = include_str!("db_extra.rs");
    let start = source.find("// ── 0. 大表流式直传").unwrap();
    let end = source[start..].find("ConnType::Postgres |").unwrap() + start;
    let active = &source[start..end];
    assert!(active.contains("mysql_migration_projection(&col_names, &col_types)?"));
    assert!(
        active.find("unsupported_transfer_type").unwrap() < active.find("open_stream_dst").unwrap()
    );
    for typ in ["float", "double", "binary", "varbinary", "blob", "bit"] {
        assert!(super::super::mysql_migration_safety::unsupported_transfer_type(typ, ""));
    }
    for typ in ["enum", "set", "date", "datetime", "timestamp"] {
        assert!(!super::super::mysql_migration_safety::unsupported_transfer_type(typ, ""));
    }
}
#[tokio::test]
#[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn mysql_stream_zero_date_strict_failure_preserves_existing_target() {
    use futures::{StreamExt, TryStreamExt};
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"zero-scalar","name":"scalar","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut c, _) = mysql_connect(&cfg, None).await.unwrap();
    let db = format!("dbterm_scalar_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
    let src = mysql_qualified(&db, "source");
    let dst = mysql_qualified(&db, "target");
    sqlx::query(&format!(
        "CREATE TABLE {src}(id INT PRIMARY KEY,d DATE) ENGINE=InnoDB"
    ))
    .execute(&mut c)
    .await
    .unwrap();
    sqlx::query(&format!("CREATE TABLE {dst} LIKE {src}"))
        .execute(&mut c)
        .await
        .unwrap();
    sqlx::query(&format!("INSERT INTO {dst} VALUES(99,'2026-01-01')"))
        .execute(&mut c)
        .await
        .unwrap();
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut c)
        .await
        .unwrap();
    sqlx::query("SET SESSION sql_mode=''")
        .execute(&mut c)
        .await
        .unwrap();
    sqlx::query(&format!("INSERT INTO {src} VALUES(1,'0000-00-00')"))
        .execute(&mut c)
        .await
        .unwrap();
    sqlx::query("SET SESSION sql_mode=?")
        .bind(&mode)
        .execute(&mut c)
        .await
        .unwrap();
    let raw = mysql_read_ddl(&mut c, &src).await.unwrap();
    let cols = vec!["id".into(), "d".into()];
    let types = vec!["int".into(), "date".into()];
    let setup = open_stream_dst(
        &cfg,
        None,
        &db,
        "target",
        "replace",
        true,
        false,
        false,
        true,
        &cols,
        &types,
        false,
        "",
        &ConnType::Mysql,
        "source",
        Some(&raw),
        Some(&mode),
    )
    .await
    .unwrap()
    .unwrap();
    let select = format!(
        "SELECT {} FROM {src}",
        mysql_migration_projection(&cols, &types).unwrap()
    );
    let stream = sqlx::query(&select)
        .fetch(&mut c)
        .and_then(|row| async move { mysql_transfer_row(&row) })
        .boxed();
    let error = drive_stream(
        stream,
        setup,
        &cols,
        "error",
        false,
        true,
        false,
        10,
        1,
        &|_, _, _| {},
        Instant::now(),
    )
    .await
    .err()
    .expect("strict zero-date write must not silently turn NULL or report success");
    assert!(error.contains("批量写入失败"));
    let ids: Vec<i32> = sqlx::query_scalar(&format!("SELECT id FROM {dst}"))
        .fetch_all(&mut c)
        .await
        .unwrap();
    assert_eq!(ids, vec![99]);
    sqlx::query(&format!("DROP DATABASE {db}"))
        .execute(&mut c)
        .await
        .unwrap();
}


#[tokio::test]
#[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn mysql_migration_metadata_decodes_all_text_and_preserves_safety_checks() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap().parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"migration-metadata-test", "name":"disposable", "type":"mysql", "host":"127.0.0.1",
        "port":port, "username":"root", "useSsl":false, "createdAt":0, "updatedAt":0
    })).unwrap();
    let (mut conn, _) = mysql_connect(&config, None).await.unwrap();
    let db = format!("dbterm_metadata_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {}", q_mysql(&db))).execute(&mut conn).await.unwrap();
    let result = async {
        sqlx::Executor::execute(&mut conn, sqlx::raw_sql(&format!("USE {}", q_mysql(&db)))).await.unwrap();
        sqlx::query(include_str!("fixtures/mc_pos_settlement_company.sql")).execute(&mut conn).await.unwrap();
        let columns = mysql_migration_column_safety(&mut conn, &db, "mc_pos_settlement_company").await?;
        assert_eq!(columns.len(), 13);
        assert_eq!(columns[0], ("id".into(), "bigint".into(), "auto_increment".into()));
        assert_eq!(columns[1], ("plan_name".into(), "varchar".into(), "".into()));
        assert!(columns.iter().all(|(_, typ, extra)| !super::super::mysql_migration_safety::unsupported_transfer_type(typ, extra)));
        sqlx::query("CREATE TABLE unsafe_types (id int, payload blob, derived int GENERATED ALWAYS AS (id+1) STORED)").execute(&mut conn).await.unwrap();
        let columns = mysql_migration_column_safety(&mut conn, &db, "unsafe_types").await?;
        assert!(super::super::mysql_migration_safety::unsupported_transfer_type(&columns[1].1, &columns[1].2));
        assert!(super::super::mysql_migration_safety::unsupported_transfer_type(&columns[2].1, &columns[2].2));
        Ok::<(), String>(())
    }.await;
    sqlx::query(&format!("DROP DATABASE {}", q_mysql(&db))).execute(&mut conn).await.unwrap();
    result.unwrap();
}
