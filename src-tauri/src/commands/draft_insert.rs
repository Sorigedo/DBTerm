use super::*;
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertDraft {
    pub columns: Vec<String>,
    pub values: Vec<Option<String>>,
}
pub fn validate_drafts(schema: &str, table: &str, rows: &[InsertDraft]) -> Result<(), String> {
    validate_ident(table)?;
    if !schema.is_empty() {
        validate_ident(schema)?;
    }
    if rows.is_empty() || rows.len() > 10000 {
        return Err("新增行数量必须介于 1 和 10000".into());
    }
    let mut size = 0usize;
    for (index, row) in rows.iter().enumerate() {
        if row.columns.is_empty()
            || row.columns.len() != row.values.len()
            || row.columns.len() > 2000
        {
            return Err(format!("第 {} 行字段数量无效，未执行写入", index + 1));
        }
        let mut seen = std::collections::HashSet::new();
        for column in &row.columns {
            validate_ident(column)?;
            if !seen.insert(column.to_lowercase()) {
                return Err(format!("第 {} 行含重复字段，未执行写入", index + 1));
            }
        }
        size = size.saturating_add(serde_json::to_vec(row).map_err(|e| e.to_string())?.len());
        if size > 8 * 1024 * 1024 {
            return Err("新增数据超过 8 MiB 安全上限，未执行写入".into());
        }
    }
    Ok(())
}
fn writable(config: &ConnConfig) -> Result<(), String> {
    ensure_writable(config)?;
    let extra = config
        .extra_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or_default();
    if (config.conn_type == ConnType::Sqlite
        && ["sqliteReadonly", "sqliteImmutable"]
            .iter()
            .any(|k| extra.get(*k).and_then(|v| v.as_bool()) == Some(true)))
        || (config.conn_type == ConnType::Duckdb
            && extra
                .get("duckAccessMode")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("READ_ONLY")))
    {
        return Err("该连接为只读模式，已拒绝新增行".into());
    }
    Ok(())
}
pub async fn db_insert_drafts(
    id: String,
    schema: String,
    table: String,
    ss_schema: Option<String>,
    rows: Vec<InsertDraft>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<u64, String> {
    validate_drafts(&schema, &table, &rows)?;
    let (config, password) = load_conn(&id, &storage).await?;
    writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_drafts(&config, password.as_deref(), &schema, &table, &rows).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_drafts(&config, password.as_deref(), &schema, &table, &rows).await
        }
        ConnType::Sqlite => sqlite_drafts(&config, &schema, &table, &rows).await,
        ConnType::Duckdb => duck_drafts(&id, &config, &schema, &table, rows, &registry).await,
        ConnType::SqlServer => ss_drafts(&id, &config, &schema, &table, rows, ss_schema.as_deref()).await,
        ConnType::Oracle => {
            super::super::oracle::insert_drafts_impl(
                config, password, schema, table, rows, &registry,
            )
            .await
        }
        _ => Err("此连接类型不支持新增行事务".into()),
    }
}
fn insert_sql(row: &InsertDraft, target: &str, mysql: bool, pg: bool) -> String {
    let cols = row
        .columns
        .iter()
        .map(|c| if mysql { q_mysql(c) } else { q_dq(c) })
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = (0..row.values.len())
        .map(|i| {
            if pg {
                format!("${index}", index = i + 1)
            } else {
                "?".into()
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("INSERT INTO {target} ({cols}) VALUES ({placeholders})")
}
async fn sqlite_drafts(
    config: &ConnConfig,
    schema: &str,
    table: &str,
    rows: &[InsertDraft],
) -> Result<u64, String> {
    use sqlx::{ConnectOptions, Connection};
    use std::str::FromStr;
    validate_drafts(schema, table, rows)?;
    writable(config)?;
    let mut conn =
        sqlx::sqlite::SqliteConnectOptions::from_str(&super::super::query::sqlite_url(config)?)
            .map_err(|e| e.to_string())?
            .busy_timeout(std::time::Duration::from_secs(5))
            .foreign_keys(true)
            .connect()
            .await
            .map_err(|e| e.to_string())?;
    let target = if schema.is_empty() {
        q_dq(table)
    } else {
        format!("{}.{}", q_dq(schema), q_dq(table))
    };
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let mut total = 0;
    for row in rows {
        let sql = insert_sql(row, &target, false, false);
        let mut query = sqlx::query(&sql);
        for value in &row.values {
            query = query.bind(value.as_deref());
        }
        match query.execute(&mut *tx).await {
            Ok(r) => total += r.rows_affected(),
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("新增失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("新增失败，整批已回滚: {e}"));
            }
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("新增提交未获确认，结果未知，请核验，禁止自动重试: {e}"))?;
    Ok(total)
}
async fn mysql_drafts(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
    table: &str,
    rows: &[InsertDraft],
) -> Result<u64, String> {
    use sqlx::{Connection, Row};
    validate_drafts(schema, table, rows)?;
    writable(config)?;
    let (mut conn, _guard) = mysql_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    super::super::query::mysql_require_atomic_table(&mut *tx, schema, table).await?;
    let target = if schema.is_empty() {
        q_mysql(table)
    } else {
        format!("{}.{}", q_mysql(schema), q_mysql(table))
    };
    let mut total = 0;
    let mut offset = 0;
    while offset < rows.len() {
        let first = &rows[offset];
        let limit = (65535 / first.columns.len()).min(200);
        let end = (offset + 1..rows.len().min(offset + limit))
            .find(|&i| rows[i].columns != first.columns)
            .unwrap_or(rows.len().min(offset + limit));
        let columns = first
            .columns
            .iter()
            .map(|c| q_mysql(c))
            .collect::<Vec<_>>()
            .join(",");
        let values = (offset..end)
            .map(|_| format!("({})", vec!["?"; first.columns.len()].join(",")))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("INSERT INTO {target} ({columns}) VALUES {values}");
        let mut query = sqlx::query(&sql);
        for row in &rows[offset..end] {
            for value in &row.values {
                query = query.bind(value.as_deref());
            }
        }
        match query.execute(&mut *tx).await {
            Ok(r) => total += r.rows_affected(),
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("新增失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("新增失败，整批已回滚: {e}"));
            }
        }
        let warning = sqlx::Executor::fetch_one(&mut *tx, "SHOW COUNT(*) WARNINGS")
            .await
            .map_err(|e| e.to_string())?;
        let count: u64 = warning.try_get(0).map_err(|e| e.to_string())?;
        if count > 0 {
            tx.rollback()
                .await
                .map_err(|e| format!("转换警告，回滚未确认: {e}"))?;
            return Err("新增出现数据库转换警告，整批已回滚".into());
        }
        offset = end;
    }
    tx.commit()
        .await
        .map_err(|e| format!("新增提交未获确认，结果未知，请核验，禁止自动重试: {e}"))?;
    Ok(total)
}
async fn pg_drafts(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
    table: &str,
    rows: &[InsertDraft],
) -> Result<u64, String> {
    use sqlx::Connection;
    validate_drafts(schema, table, rows)?;
    writable(config)?;
    let (mut conn, _guard) = pg_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let target = format!(
        "{}.{}",
        q_dq(if schema.is_empty() { "public" } else { schema }),
        q_dq(table)
    );
    let mut total = 0;
    let types=super::pg_write_types::target_types(&mut tx,if schema.is_empty(){"public"}else{schema},table).await?;
    for row in rows {
        let types = row
            .columns
            .iter()
            .map(|column| {
                types
                    .get(column)
                    .cloned()
                    .ok_or_else(|| format!("目标字段不存在: {column}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let cols = row
            .columns
            .iter()
            .map(|c| q_dq(c))
            .collect::<Vec<_>>()
            .join(",");
        let ph = types
            .iter()
            .enumerate()
            .map(|(i, kind)| format!("CAST(${}::text AS {kind})", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("INSERT INTO {target} ({cols}) VALUES ({ph})");
        let mut query = sqlx::query(&sql);
        for value in &row.values {
            query = query.bind(value.as_deref());
        }
        match query.execute(&mut *tx).await {
            Ok(r) => total += r.rows_affected(),
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("新增失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("新增失败，整批已回滚: {e}"));
            }
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("新增提交未获确认，结果未知，请核验，禁止自动重试: {e}"))?;
    Ok(total)
}

async fn duck_drafts(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    rows: Vec<InsertDraft>,
    registry: &DriverRegistry,
) -> Result<u64, String> {
    use super::super::duckdb::{get_duck_lib_path_pub, get_or_open_pub, run_query_sync_pub};
    let dedicated: DuckPool =
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let library = get_duck_lib_path_pub(registry).await?;
    let handle = get_or_open_pub(id, config, &dedicated, &library).await?;
    let target = q_dq(table);
    let catalog = schema.to_string();
    tokio::task::spawn_blocking(move || {
        let guard = handle.blocking_lock();
        if !catalog.is_empty() {
            super::super::duckdb::select_catalog_on_connection(&guard, &catalog)?;
        }
        let statements = rows.iter().map(|row| native_statement(row, &target, false));
        run_atomic_native_batch("BEGIN", statements, |sql| {
            run_query_sync_pub(&guard, sql, 0).map(|r| r.rows_affected)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn native_statement(row: &InsertDraft, target: &str, sqlserver: bool) -> String {
    let columns = row
        .columns
        .iter()
        .map(|c| {
            if sqlserver {
                format!("[{}]", c.replace(']', "]]"))
            } else {
                q_dq(c)
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let values = row
        .values
        .iter()
        .map(|value| match value {
            None => "NULL".into(),
            Some(text) => format!(
                "{}'{}'",
                if sqlserver { "N" } else { "" },
                text.replace(char::from(39), "''")
            ),
        })
        .collect::<Vec<String>>()
        .join(",");
    format!("INSERT INTO {target} ({columns}) VALUES ({values})")
}
async fn ss_drafts(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    rows: Vec<InsertDraft>,
    ss_schema: Option<&str>,
) -> Result<u64, String> {
    use super::super::sqlserver::{get_entry, resolve_table_target_in_schema, table_write_config};
    let dedicated: SsPool =
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let password = crate::keychain::get_password(id)?;
    let effective = table_write_config(config, schema);
    let handle = get_entry(id, &dedicated, &effective, password.as_deref()).await?;
    let mut entry = handle.lock().await;
    let target = resolve_table_target_in_schema(&mut entry, table, ss_schema).await?;
    let statements = rows.iter().map(|row| native_statement(row, &target, true));
    run_atomic_ss_batch(&mut *entry, statements, execute_ss_batch_statement).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires explicitly disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
    async fn real_mysql_insert_commit_disconnect_checks_complete_batch_and_unknown_receipt() {
        crate::commands::query::commit_disconnect_tests::assert_mysql_batch_commit_faults(true, |config, db| async move {
            let rows = [("1","a"),("2","b")].map(|(id,value)| InsertDraft {
                columns: vec!["id".into(),"v".into()], values: vec![Some(id.into()),Some(value.into())],
            });
            mysql_drafts(&config, None, &db, "t", &rows).await
        }).await;
    }
    #[tokio::test]
    #[ignore = "requires explicitly disposable DBTERM_DRAFT_MYSQL_URL"]
    async fn mysql_variable_columns_defaults_and_later_chunk_rollback() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_DRAFT_MYSQL_URL").unwrap();
        let mut admin = sqlx::MySqlConnection::connect(&url).await.unwrap();
        let options: sqlx::mysql::MySqlConnectOptions = url.parse().unwrap();
        let db = format!("drafts_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {}", q_mysql(&db)))
            .execute(&mut admin)
            .await
            .unwrap();
        let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"draft-mysql","name":"test","type":"mysql","host":options.get_host(),"port":options.get_port(),"username":options.get_username(),"database":db,"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        let result: Result<(), String> = async {
            sqlx::query(&format!(
                "CREATE TABLE {}.t(id INT PRIMARY KEY,v VARCHAR(20) DEFAULT 'd') ENGINE=InnoDB",
                q_mysql(&db)
            ))
            .execute(&mut admin)
            .await
            .map_err(|e| e.to_string())?;
            let good = [
                row(&["id"], &[Some("1")]),
                row(&["id", "v"], &[Some("2"), Some("NULL")]),
            ];
            assert_eq!(mysql_drafts(&cfg, None, &db, "t", &good).await?, 2);
            let actual: Vec<(i32, String)> =
                sqlx::query_as(&format!("SELECT id,v FROM {}.t ORDER BY id", q_mysql(&db)))
                    .fetch_all(&mut admin)
                    .await
                    .map_err(|e| e.to_string())?;
            assert_eq!(actual, vec![(1, "d".into()), (2, "NULL".into())]);
            let mut bad = (3..404)
                .map(|i| InsertDraft {
                    columns: vec!["id".into()],
                    values: vec![Some(i.to_string())],
                })
                .collect::<Vec<_>>();
            bad.push(row(&["id"], &[Some("1")]));
            assert!(mysql_drafts(&cfg, None, &db, "t", &bad).await.is_err());
            let count: i64 =
                sqlx::query_scalar(&format!("SELECT count(*) FROM {}.t", q_mysql(&db)))
                    .fetch_one(&mut admin)
                    .await
                    .map_err(|e| e.to_string())?;
            assert_eq!(count, 2);
            Ok(())
        }
        .await;
        sqlx::query(&format!("DROP DATABASE {}", q_mysql(&db)))
            .execute(&mut admin)
            .await
            .unwrap();
        result.unwrap();
    }
    #[tokio::test]
    #[ignore = "requires explicitly disposable DBTERM_DRAFT_PG_URL"]
    async fn postgres_draft_text_parameters_cast_to_target_types() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_DRAFT_PG_URL").unwrap();
        let mut admin = sqlx::PgConnection::connect(&url).await.unwrap();
        let options: sqlx::postgres::PgConnectOptions = url.parse().unwrap();
        let schema = format!("drafts_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {}", q_dq(&schema)))
            .execute(&mut admin)
            .await
            .unwrap();
        let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"draft-pg","name":"test","type":"postgres","host":options.get_host(),"port":options.get_port(),"username":options.get_username(),"database":options.get_database().unwrap_or("postgres"),"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        sqlx::query(&format!(
            "CREATE TABLE {}.t(id INT PRIMARY KEY,n NUMERIC(10,2) DEFAULT 2.5,b BOOLEAN)",
            q_dq(&schema)
        ))
        .execute(&mut admin)
        .await
        .unwrap();
        let outcome = pg_drafts(
            &cfg,
            std::env::var("DBTERM_DRAFT_PG_PASSWORD").ok().as_deref(),
            &schema,
            "t",
            &[
                row(&["id", "b"], &[Some("1"), Some("true")]),
                row(&["id", "n"], &[Some("2"), Some("3.25")]),
            ],
        )
        .await;
        let rejected=pg_drafts(&cfg,None,&schema,"t",&[row(&["id"],&[Some("3")]),row(&["id"],&[Some("1")])]).await;
        let rollback_count:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM {}.t WHERE id=3",q_dq(&schema))).fetch_one(&mut admin).await.unwrap();
        assert!(rejected.is_err());assert_eq!(rollback_count,0);
        sqlx::query(&format!("CREATE DOMAIN {}.positive AS INT CHECK(VALUE>0)",q_dq(&schema))).execute(&mut admin).await.unwrap();
        sqlx::query(&format!("CREATE TABLE {}.typed(id INT PRIMARY KEY,n {}.positive,a INT[],v VARCHAR(3))",q_dq(&schema),q_dq(&schema))).execute(&mut admin).await.unwrap();
        pg_drafts(&cfg,None,&schema,"typed",&[row(&["id","n","a","v"],&[Some("1"),Some("2"),Some("{1,2}"),Some("001")])]).await.unwrap();
        let oversized=pg_drafts(&cfg,None,&schema,"typed",&[row(&["id","v"],&[Some("2"),Some("long")])]).await;
        let domain=pg_drafts(&cfg,None,&schema,"typed",&[row(&["id","n"],&[Some("3"),Some("-1")])]).await;
        assert!(oversized.is_err());assert!(domain.is_err());
        let actual: Vec<(i32, String, Option<bool>)> = sqlx::query_as(&format!(
            "SELECT id,n::text,b FROM {}.t ORDER BY id",
            q_dq(&schema)
        ))
        .fetch_all(&mut admin)
        .await
        .unwrap();
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", q_dq(&schema)))
            .execute(&mut admin)
            .await
            .unwrap();
        assert_eq!(outcome.unwrap(), 2);
        assert_eq!(
            actual,
            vec![(1, "2.50".into(), Some(true)), (2, "3.25".into(), None)]
        );
    }
    fn row(columns: &[&str], values: &[Option<&str>]) -> InsertDraft {
        InsertDraft {
            columns: columns.iter().map(|s| s.to_string()).collect(),
            values: values.iter().map(|v| v.map(str::to_string)).collect(),
        }
    }
    #[test]
    fn drafts_reject_bad_shape_duplicates_payload_and_quote_native_data() {
        for rows in [
            vec![],
            vec![row(&[], &[])],
            vec![row(&["a"], &[])],
            vec![row(&["a", "A"], &[None, None])],
            vec![row(&["id;DROP"], &[None])],
        ] {
            assert!(validate_drafts("main", "t", &rows).is_err());
        }
        let large = InsertDraft {
            columns: vec!["v".into()],
            values: vec![Some("x".repeat(8 * 1024 * 1024))],
        };
        assert!(validate_drafts("main", "t", &[large]).is_err());
        assert_eq!(
            native_statement(&row(&["v", "n"], &[Some("O'Reilly"), None]), "target", true),
            "INSERT INTO target ([v],[n]) VALUES (N'O''Reilly',NULL)"
        );
    }
    #[tokio::test]
    async fn readonly_drafts_refuse_before_nonexistent_file_connection() {
        let mut cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"none","name":"test","type":"sqlite","filePath":"/no/such/dbterm.db","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        for mode in ["global", "sqliteReadonly", "sqliteImmutable"] {
            cfg.read_only = Some(mode == "global");
            cfg.extra_json = Some(serde_json::json!({mode:true}).to_string());
            assert!(
                sqlite_drafts(&cfg, "main", "t", &[row(&["v"], &[Some("1")])])
                    .await
                    .unwrap_err()
                    .contains("只读")
            );
        }
    }
    #[test]
    fn native_draft_statements_share_transaction_and_later_error_rolls_back() {
        use sqlx::Connection;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut conn = rt
            .block_on(sqlx::SqliteConnection::connect("sqlite::memory:"))
            .unwrap();
        rt.block_on(
            sqlx::query("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT DEFAULT 'd')")
                .execute(&mut conn),
        )
        .unwrap();
        let rows = [
            row(&["id"], &[Some("1")]),
            row(&["id", "v"], &[Some("1"), Some("later")]),
        ];
        let result = run_atomic_native_batch(
            "BEGIN",
            rows.iter().map(|r| native_statement(r, "t", false)),
            |sql| {
                rt.block_on(sqlx::query(sql).execute(&mut conn))
                    .map(|r| r.rows_affected())
                    .map_err(|e| e.to_string())
            },
        );
        assert!(result.is_err());
        let count: i64 = rt
            .block_on(sqlx::query_scalar("SELECT count(*) FROM t").fetch_one(&mut conn))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn sqlite_variable_columns_keep_defaults_null_text_and_rollback_later_error() {
        use sqlx::Connection;
        let path = std::env::temp_dir().join(format!("dbterm-drafts-{}.db", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"fixture","name":"test","type":"sqlite","filePath":path,"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        let mut conn =
            sqlx::SqliteConnection::connect(&super::super::super::query::sqlite_url(&cfg).unwrap())
                .await
                .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT DEFAULT 'default',n TEXT DEFAULT 'n')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let row = |columns: Vec<&str>, values: Vec<Option<&str>>| InsertDraft {
            columns: columns.into_iter().map(str::to_string).collect(),
            values: values.into_iter().map(|v| v.map(str::to_string)).collect(),
        };
        let good = vec![
            row(vec!["id"], vec![Some("1")]),
            row(vec!["id", "v"], vec![Some("2"), Some("NULL")]),
            row(vec!["id", "n"], vec![Some("3"), None]),
        ];
        let inserted = sqlite_drafts(&cfg, "main", "t", &good).await.unwrap();
        let actual: Vec<(i64, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT id,v,n FROM t ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        let bad = vec![
            row(vec!["id", "v"], vec![Some("4"), Some("first")]),
            row(vec!["id"], vec![Some("1")]),
        ];
        let failure = sqlite_drafts(&cfg, "main", "t", &bad).await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM t WHERE id=4")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(inserted, 3);
        assert_eq!(
            actual,
            vec![
                (1, Some("default".into()), Some("n".into())),
                (2, Some("NULL".into()), Some("n".into())),
                (3, Some("default".into()), None)
            ]
        );
        assert!(failure.is_err());
        assert_eq!(count, 0);
    }
}
