use super::*;
use sqlx::Row;
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTableDiff {
    table: String,
    diff: StructureDiff,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTableIssue {
    table: String,
    reason: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshotDiff {
    database_definition: DatabaseDefinitionDiff,
    missing_tables: Vec<String>,
    extra_tables: Vec<String>,
    changed_tables: Vec<SchemaTableDiff>,
    uncomparable_tables: Vec<SchemaTableIssue>,
    compared_tables: usize,
    alter_sql: String,
    danger_drops: Vec<String>,
    comparison_scope: String,
}
struct Snapshot {
    conn: sqlx::mysql::MySqlConnection,
    _tunnel: Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>,
    ddl: String,
    names: Vec<(String, String)>,
    tables: std::collections::BTreeMap<String, (Vec<ColumnInfo>, String)>,
    mode: String,
}
fn collect_table_result(
    table: &str,
    result: Result<StructureDiff, String>,
    changed_tables: &mut Vec<SchemaTableDiff>,
    uncomparable_tables: &mut Vec<SchemaTableIssue>,
) {
    match result {
        Ok(diff) if !diff.added.is_empty() || !diff.removed.is_empty() || !diff.modified.is_empty() || diff.table_options.is_some() => {
            changed_tables.push(SchemaTableDiff { table: table.to_string(), diff });
        }
        Ok(_) => {}
        Err(reason) => uncomparable_tables.push(SchemaTableIssue {
            table: table.to_string(),
            reason: format!("表完整结构无法安全比对：{reason}"),
        }),
    }
}
async fn database_ddl(c: &mut sqlx::mysql::MySqlConnection, s: &str) -> Result<String, String> {
    sqlx::query(&format!("SHOW CREATE DATABASE {}", q_mysql(s)))
        .fetch_one(c)
        .await
        .map_err(|e| e.to_string())?
        .try_get(1)
        .map_err(|e| e.to_string())
}
async fn names(
    c: &mut sqlx::mysql::MySqlConnection,
    s: &str,
) -> Result<Vec<(String, String)>, String> {
    sqlx::query_as("SELECT CAST(TABLE_NAME AS CHAR CHARACTER SET utf8mb4),CAST(TABLE_TYPE AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME LIMIT 2001").bind(s).fetch_all(c).await.map_err(|e|format!("读取表清单失败: {e}"))
}
async fn recheck(x: &mut Snapshot, s: &str) -> Result<(), String> {
    if names(&mut x.conn, s).await? != x.names || database_ddl(&mut x.conn, s).await? != x.ddl {
        return Err(
            "结构比对期间数据库定义或对象清单发生变化，已丢弃结果；请暂停 DDL 后重试".into(),
        );
    }
    Ok(())
}
async fn capture(cfg: &ConnConfig, pwd: Option<&str>, s: &str) -> Result<Snapshot, String> {
    let (mut conn, tunnel) = mysql_connect(cfg, pwd).await?;
    sqlx::query("SET SESSION lock_wait_timeout=5")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    // Rechecks must see new dictionary rows, while table MDL still lasts until disconnect.
    sqlx::Executor::execute(
        &mut conn,
        sqlx::raw_sql("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"),
    )
    .await
    .map_err(|e| e.to_string())?;
    sqlx::Executor::execute(&mut conn, sqlx::raw_sql("START TRANSACTION READ ONLY"))
        .await
        .map_err(|e| e.to_string())?;
    let ddl = database_ddl(&mut conn, s).await?;
    let before = names(&mut conn, s).await?;
    if before.len() > 2000 {
        return Err("表清单超过 2000 个对象安全预算，请分批按表比对".into());
    }
    let mut tables = std::collections::BTreeMap::new();
    let mut bytes = 0usize;
    for (name, kind) in &before {
        if kind != "BASE TABLE" {
            continue;
        }
        let value = mysql_schema_compare_read(&mut conn, s, name).await?;
        bytes = bytes.saturating_add(value.1.len());
        if bytes > 64 * 1024 * 1024 {
            return Err("结构定义超过 64 MiB 安全预算，请分批按表比对".into());
        }
        tables.insert(name.clone(), value);
    }
    let mode = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let mut x = Snapshot {
        conn,
        _tunnel: tunnel,
        ddl,
        names: before,
        tables,
        mode,
    };
    recheck(&mut x, s).await?;
    Ok(x)
}
fn compare(
    src: &Snapshot,
    ss: &str,
    dst: &Snapshot,
    ds: &str,
) -> Result<SchemaSnapshotDiff, String> {
    validate_schema_sql_modes(&src.mode, &dst.mode)?;
    let database_definition = DatabaseDefinitionDiff {
        identical: mysql_database_signature(&src.ddl, ss)?
            == mysql_database_signature(&dst.ddl, ds)?,
        source_ddl: src.ddl.clone(),
        target_ddl: dst.ddl.clone(),
    };
    let missing_tables = src
        .tables
        .keys()
        .filter(|n| !dst.tables.contains_key(*n))
        .cloned()
        .collect();
    let extra_tables = dst
        .tables
        .keys()
        .filter(|n| !src.tables.contains_key(*n))
        .cloned()
        .collect();
    let mut changed_tables = Vec::new();
    let mut uncomparable_tables = Vec::new();
    let mut compared_tables = 0;
    for (n, (sc, sd)) in &src.tables {
        if let Some((dc, dd)) = dst.tables.get(n) {
            compared_tables += 1;
            let diff = mysql_structure_diff_from_definition(
                sc.clone(),
                sd.clone(),
                n,
                dc.clone(),
                dd.clone(),
                ds,
                n,
                &dst.mode,
            );
            collect_table_result(n, diff, &mut changed_tables, &mut uncomparable_tables);
        }
    }
    let alter_sql = changed_tables
        .iter()
        .map(|i| i.diff.alter_sql.as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let danger_drops = changed_tables
        .iter()
        .flat_map(|i| {
            i.diff
                .danger_drops
                .iter()
                .map(|c| format!("{}.{}", i.table, c))
        })
        .collect();
    Ok(SchemaSnapshotDiff {
        database_definition,
        missing_tables,
        extra_tables,
        changed_tables,
        uncomparable_tables,
        compared_tables,
        alter_sql,
        danger_drops,
        comparison_scope: "当前账号可见的普通表对象".to_string(),
    })
}
pub(super) async fn compare_configs(
    src: &ConnConfig,
    sp: Option<&str>,
    ss: &str,
    dst: &ConnConfig,
    dp: Option<&str>,
    ds: &str,
) -> Result<SchemaSnapshotDiff, String> {
    require_complete_schema_compare(struct_family(&src.conn_type))?;
    require_complete_schema_compare(struct_family(&dst.conn_type))?;
    let mut source = capture(src, sp, ss).await?;
    let mut target = capture(dst, dp, ds).await?;
    let result = compare(&source, ss, &target, ds)?;
    recheck(&mut source, ss).await?;
    recheck(&mut target, ds).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_compare_keeps_processing_after_uncomparable_table() {
        let mut changed = Vec::new();
        let mut issues = Vec::new();
        collect_table_result("first", Err("索引差异".into()), &mut changed, &mut issues);
        collect_table_result("second", Ok(StructureDiff {
            added: vec![], removed: vec![], modified: vec![], alter_sql: "".into(), danger_drops: vec![], table_options: None, alter_block_reason: None,
        }), &mut changed, &mut issues);
        collect_table_result("third", Ok(StructureDiff {
            added: vec![ColumnInfo { name: "id".into(), data_type: "INT".into(), nullable: false, default_value: None, key: String::new() }],
            removed: vec![], modified: vec![], alter_sql: "ALTER TABLE third ADD id INT".into(), danger_drops: vec![], table_options: None, alter_block_reason: None,
        }), &mut changed, &mut issues);
        assert_eq!(issues[0].table, "first");
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].table, "third");
    }
    fn config(port: u16) -> ConnConfig {
        serde_json::from_value(serde_json::json!({"id":"snapshot-test","name":"snapshot-test","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap()
    }
    #[tokio::test]
    #[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
    async fn schema_snapshot_preserves_unicode_and_rejects_functional_index_mismatch() {
        let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap().parse().unwrap();
        let cfg = config(port);
        let (mut admin, _) = mysql_connect(&cfg, None).await.unwrap();
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let source = format!("dbterm_ddl_src_{suffix}");
        let target = format!("dbterm_ddl_dst_{suffix}");
        for schema in [&source, &target] {
            sqlx::query(&format!("CREATE DATABASE {} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci", q_mysql(schema))).execute(&mut admin).await.unwrap();
            sqlx::query(&format!("CREATE TABLE {} (`编号` INT PRIMARY KEY, `名称` VARCHAR(64) NOT NULL DEFAULT '你好🌍' COMMENT '中文备注', UNIQUE KEY `uk_name` ((NULLIF(`名称`,_utf8mb4'')))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='表说明'", mysql_qualified(schema, "demo"))).execute(&mut admin).await.unwrap();
        }
        let equal = compare_configs(&cfg, None, &source, &cfg, None, &target).await.unwrap();
        assert!(equal.database_definition.identical);
        assert!(equal.changed_tables.is_empty());
        assert_eq!(equal.compared_tables, 1);
        let (_, raw) = mysql_schema_compare_read(&mut admin, &source, "demo").await.unwrap();
        assert!(raw.contains("`名称`"));
        assert!(raw.contains("COMMENT '中文备注'"));
        assert!(raw.contains("COMMENT='表说明'"));
        assert!(raw.contains("0xE4BDA0E5A5BDF09F8C8D"));
        assert!(raw.contains("((nullif(`名称`,_utf8mb4'')))"));
        sqlx::query(&format!("ALTER TABLE {} DROP INDEX `uk_name`, ADD UNIQUE KEY `uk_name` (`名称`)", mysql_qualified(&target, "demo"))).execute(&mut admin).await.unwrap();
        let mismatch = compare_configs(&cfg, None, &source, &cfg, None, &target).await;
        assert!(mismatch.err().is_some_and(|e| e.contains("索引、约束或表选项存在差异")));
        sqlx::query(&format!("ALTER TABLE {} DROP INDEX `uk_name`, ADD UNIQUE KEY `uk_name` ((NULLIF(`名称`,_utf8mb4'')))", mysql_qualified(&target, "demo"))).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("ALTER TABLE {} MODIFY COLUMN `名称` VARCHAR(64) NOT NULL DEFAULT '你好🌍' COMMENT '目标备注'", mysql_qualified(&target, "demo"))).execute(&mut admin).await.unwrap();
        let changed = compare_configs(&cfg, None, &source, &cfg, None, &target).await.unwrap();
        assert_eq!(changed.changed_tables.len(), 1);
        assert!(changed.alter_sql.contains("COMMENT '中文备注'"));
        assert!(changed.alter_sql.contains("DEFAULT 0xE4BDA0E5A5BDF09F8C8D"));
        for schema in [&source, &target] {
            sqlx::query(&format!("DROP DATABASE {}", q_mysql(schema))).execute(&mut admin).await.unwrap();
        }
    }
    #[tokio::test]
    #[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
    async fn mysql_schema_snapshot_keeps_all_table_locks_detects_new_tables_and_refuses_partial_visibility(
    ) {
        let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let cfg = config(port);
        let (mut admin, _) = mysql_connect(&cfg, None).await.unwrap();
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let a = format!("dbterm_snap_a_{suffix}");
        let b = format!("dbterm_snap_b_{suffix}");
        let user = format!("ss_{}", &suffix[..12]);
        for schema in [&a, &b] {
            sqlx::query(&format!("CREATE DATABASE {}", q_mysql(schema)))
                .execute(&mut admin)
                .await
                .unwrap();
            for table in ["one", "two"] {
                sqlx::query(&format!("CREATE TABLE {}(id INT PRIMARY KEY,v VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_bin DEFAULT '/*keep*/' COMMENT 'original') ENGINE=InnoDB",mysql_qualified(schema,table))).execute(&mut admin).await.unwrap();
            }
        }
        let baseline = compare_configs(&cfg, None, &a, &cfg, None, &b)
            .await
            .unwrap();
        assert_eq!(baseline.compared_tables, 2);
        assert!(baseline.changed_tables.is_empty());
        let mut source = capture(&cfg, None, &a).await.unwrap();
        let target = capture(&cfg, None, &b).await.unwrap();
        sqlx::query("SET SESSION lock_wait_timeout=1")
            .execute(&mut admin)
            .await
            .unwrap();
        let blocked = sqlx::query(&format!(
            "ALTER TABLE {} ADD COLUMN surprise INT",
            mysql_qualified(&a, "one")
        ))
        .execute(&mut admin)
        .await
        .unwrap_err();
        assert!(blocked.to_string().contains("1205"), "{blocked}");
        sqlx::query(&format!(
            "CREATE TABLE {}(id INT)",
            mysql_qualified(&a, "new_table")
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        assert!(recheck(&mut source, &a)
            .await
            .unwrap_err()
            .contains("清单发生变化"));
        drop(source);
        drop(target);
        sqlx::query(&format!("DROP TABLE {}", mysql_qualified(&a, "new_table")))
            .execute(&mut admin)
            .await
            .unwrap();
        sqlx::query(&format!("ALTER TABLE {} MODIFY COLUMN v VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_bin DEFAULT '/*keep*/' COMMENT 'changed'",mysql_qualified(&b,"one"))).execute(&mut admin).await.unwrap();
        let changed = compare_configs(&cfg, None, &a, &cfg, None, &b)
            .await
            .unwrap();
        assert_eq!(changed.changed_tables.len(), 1);
        assert!(changed.alter_sql.contains("COMMENT 'original'"));
        assert!(changed
            .alter_sql
            .contains("CHARACTER SET latin1 COLLATE latin1_bin"));
        sqlx::query(&format!(
            "ALTER TABLE {} ADD KEY idx_v(v)",
            mysql_qualified(&b, "two")
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        let index_error = compare_configs(&cfg, None, &a, &cfg, None, &b)
            .await
            .err()
            .unwrap();
        assert!(index_error.contains("索引、约束或表选项存在差异"));
        sqlx::query(&format!(
            "ALTER TABLE {} DROP KEY idx_v",
            mysql_qualified(&b, "two")
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        sqlx::Executor::execute(&mut admin, sqlx::raw_sql(&format!(
            "ALTER DATABASE {} COLLATE utf8mb4_bin", q_mysql(&b)
        )))
        .await
        .unwrap();
        assert!(
            !compare_configs(&cfg, None, &a, &cfg, None, &b)
                .await
                .unwrap()
                .database_definition
                .identical
        );
        sqlx::query(&format!(
            "CREATE USER '{user}'@'127.0.0.1' IDENTIFIED BY 'test-only-password'"
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        sqlx::query(&format!(
            "GRANT SELECT,TRIGGER ON {} TO '{user}'@'127.0.0.1'",
            mysql_qualified(&a, "one")
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        let mut restricted = cfg.clone();
        restricted.username = Some(user.clone());
        // The account can read one table's DDL. A direct-grant lookup must not
        // reject it merely because the privilege came from a table grant.
        let mut restricted_snapshot = capture(&restricted, Some("test-only-password"), &a)
            .await
            .unwrap();
        assert_eq!(restricted_snapshot.tables.len(), 1);
        assert!(restricted_snapshot.tables.contains_key("one"));
        assert!(recheck(&mut restricted_snapshot, &a).await.is_ok());
        sqlx::query(&format!(
            "GRANT SELECT,TRIGGER ON {}.* TO '{user}'@'127.0.0.1'",
            q_mysql(&a)
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        let visible = capture(&restricted, Some("test-only-password"), &a)
            .await
            .unwrap();
        assert_eq!(visible.tables.len(), 2);
        drop(visible);
        sqlx::query(&format!("DROP USER '{user}'@'127.0.0.1'"))
            .execute(&mut admin)
            .await
            .unwrap();
        for schema in [&a, &b] {
            sqlx::query(&format!("DROP DATABASE {}", q_mysql(schema)))
                .execute(&mut admin)
                .await
                .unwrap();
        }
    }
}
