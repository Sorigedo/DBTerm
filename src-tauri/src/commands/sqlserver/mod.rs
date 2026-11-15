// MS0.x + MS1.x: SQL Server 命令域（纯 Rust tiberius，无需外部驱动）
// 完全隔离：不碰 MySQL/PG/SQLite/Redis/MongoDB/DuckDB 侧代码
pub mod admin;
pub mod ha;
pub mod security;
pub mod extra;
mod ddl_columns;
mod ddl_indexes;
mod ddl_constraints;
mod ddl_triggers;
mod ddl_properties;
pub(crate) mod ddl_script;
pub(crate) mod backup_target;
use std::{collections::HashMap, sync::Arc};
use serde::Deserialize;
use tauri::State;
use tokio::sync::Mutex;
use tiberius::{Client, Config, AuthMethod, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::{models::{ConnConfig, ConnType}, storage::StorageState};
use super::query::pool_identity as connection_identity;

// ── 连接池 ─────────────────────────────────────────────────────────────────────

pub struct SsEntry {
    identity: [u8; 32],
    pub client: Client<Compat<TcpStream>>,
    pub _tunnel: Option<Arc<crate::db_tunnel::DbTunnel>>,
}

// 每个连接包一层独立 Mutex：外层 Mutex 仅在"查找/插入连接"时短暂持有，
// 长查询只锁该连接自身，不阻塞对其他 SQL Server 连接的操作。
pub type SsPool = Arc<Mutex<HashMap<String, Arc<Mutex<SsEntry>>>>>;

/// SQL Server 额外配置（存于 ConnConfig.extra_json）
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct SsConnCfg {
    #[serde(rename = "ssInstance", alias = "instance", default)] pub instance: String,
    #[serde(rename = "ssEncrypt", alias = "encrypt", default = "default_true")] pub encrypt: bool,
    #[serde(rename = "ssTrustCert", alias = "trustServerCert", default)] pub trust_cert: bool,
    #[serde(rename = "ssAppIntent", alias = "appIntent", default)] pub app_intent: String,
    #[serde(rename = "applicationName",       default)] pub app_name:       String,
    #[serde(rename = "connectTimeout",        default)] pub connect_timeout: u64,
    // SSH 隧道
    #[serde(rename = "sshTunnel",   default)] pub ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] pub ssh_host:      String,
    #[serde(rename = "sshPort",     default)] pub ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] pub ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] pub ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] pub ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] pub ssh_key_path:  String,
}
fn default_true() -> bool { true }
impl Default for SsConnCfg {
    fn default() -> Self {
        serde_json::from_str("{}").expect("empty SQL Server config has valid secure defaults")
    }
}

impl SsConnCfg {
    pub fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
}

// ── 连接建立 ───────────────────────────────────────────────────────────────────

/// 获取或创建 SQL Server 连接，返回该连接的独立锁句柄。
/// 外层池锁仅在查找/插入时短暂持有；调用方拿到 `Arc<Mutex<SsEntry>>` 后自行 `.lock()`，
/// 长查询只锁住该连接，不会阻塞其他连接。
pub async fn get_entry(
    conn_id: &str,
    pool: &SsPool,
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<Arc<Mutex<SsEntry>>, String> {
    require_sqlserver(config)?;
    let cfg = SsConnCfg::from_config(config);
    let tunnel_password = if cfg.ssh_tunnel && cfg.ssh_password.is_empty() {
        crate::keychain::get_password(&format!("{conn_id}::ssh-tunnel"))?.unwrap_or_default()
    } else { cfg.ssh_password.clone() };
    let identity = connection_identity(config, password, &tunnel_password)?;
    let build_lock = super::query::pool_build_lock(conn_id).await;
    let _building = build_lock.lock().await;
    let cached = { pool.lock().await.get(conn_id).cloned() };
    if let Some(entry) = cached {
        let matches = {
            let cached = entry.lock().await;
            cached.identity == identity
                && cached._tunnel.as_ref().is_none_or(|t| t.is_alive())
        };
        if matches { return Ok(entry); }
    }
    let tunnel_arc: Option<Arc<crate::db_tunnel::DbTunnel>>;

    let (host, port) = if cfg.ssh_tunnel {
        let tcfg = crate::db_tunnel::DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: tunnel_password, key_path: cfg.ssh_key_path.clone(),
        };
        let t = crate::db_tunnel::DbTunnel::open_shared(
            conn_id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(1433),
        ).await?;
        let lp = t.local_port;
        tunnel_arc = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel_arc = None;
        (
            config.host.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
            config.port.unwrap_or(1433),
        )
    };

    let mut tc = Config::new();
    tc.host(&host);
    tc.port(port);
    tc.readonly(cfg.app_intent.eq_ignore_ascii_case("ReadOnly"));

    // 命名实例
    if !cfg.instance.is_empty() {
        tc.instance_name(&cfg.instance);
    }

    // 数据库
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        tc.database(db);
    }

    // 认证（SQL Server 认证）
    let user = config.username.as_deref().unwrap_or("sa");
    let pwd  = password.unwrap_or("");
    tc.authentication(AuthMethod::sql_server(user, pwd));

    // 加密
    if cfg.encrypt {
        tc.encryption(EncryptionLevel::Required);
    } else {
        tc.encryption(EncryptionLevel::Off);
    }
    if cfg.trust_cert {
        tc.trust_cert();
    }

    // 连接超时
    let timeout_secs = if cfg.connect_timeout == 0 { 30 } else { cfg.connect_timeout.clamp(3, 300) };

    let addr = tc.get_addr();
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        TcpStream::connect(addr),
    ).await
        .map_err(|_| format!("SQL Server 连接超时（{}s）", timeout_secs))?
        .map_err(|e| format!("TCP 连接失败: {e}"))?;
    tcp.set_nodelay(true).map_err(|e| format!("set_nodelay 失败: {e}"))?;

    let client = Client::connect(tc, tcp.compat_write()).await
        .map_err(|e| format!("SQL Server 握手失败: {e}"))?;

    let entry = Arc::new(Mutex::new(SsEntry { identity, client, _tunnel: tunnel_arc }));

    // Builders are serialized; issued handles may finish on their original endpoint.
    let mut guard = pool.lock().await;
    guard.insert(conn_id.to_string(), entry.clone());
    Ok(entry)
}

// ── 辅助：从存储加载连接配置 ─────────────────────────────────────────────────────

fn load_config(id: &str, storage: &StorageState) -> Result<ConnConfig, String> {
    let guard = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = guard.load()?;
    let config = list.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接 {id} 不存在"))?;
    drop(guard);
    require_sqlserver(&config)?;
    Ok(config)
}

fn require_sqlserver(config: &ConnConfig) -> Result<(), String> {
    if config.conn_type != ConnType::SqlServer { return Err("连接类型不是 SQL Server，已拒绝操作".into()); }
    Ok(())
}

fn require_write(config: &ConnConfig) -> Result<(), String> {
    require_sqlserver(config)?;
    if config.read_only == Some(true) { return Err("该连接为只读模式，已拒绝写操作".into()); }
    Ok(())
}

fn require_sql(config: &ConnConfig, sql: &str) -> Result<(), String> {
    require_sqlserver(config)?;
    if config.read_only == Some(true) && !super::query::is_read_only_safe_stmt(sql, &config.conn_type) {
        return Err("该连接为只读模式，已拒绝写操作".into());
    }
    Ok(())
}

pub fn load_conn(id: &str, storage: &StorageState) -> Result<(ConnConfig, Option<String>), String> {
    let config = load_config(id, storage)?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

fn load_write_conn(id: &str, storage: &StorageState) -> Result<(ConnConfig, Option<String>), String> {
    let config = load_config(id, storage)?;
    require_write(&config)?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

// ── 类型转换：Row → Vec<Option<String>> ─────────────────────────────────────────

pub(crate) fn cell_to_string(row: &tiberius::Row, idx: usize) -> Option<String> {
    use tiberius::ColumnType;
    let col_type = row.columns()[idx].column_type();
    match col_type {
        ColumnType::Null => None,
        ColumnType::Bit | ColumnType::Bitn => {
            row.get::<bool, _>(idx).map(|v| if v { "1" } else { "0" }.to_string())
        }
        ColumnType::Int1 => row.get::<u8, _>(idx).map(|v| v.to_string()),
        ColumnType::Int2 => row.get::<i16, _>(idx).map(|v| v.to_string()),
        ColumnType::Int4 => row.get::<i32, _>(idx).map(|v| v.to_string()),
        ColumnType::Int8 => row.get::<i64, _>(idx).map(|v| v.to_string()),
        ColumnType::Float4 => row.get::<f32, _>(idx).map(|v| v.to_string()),
        ColumnType::Float8 | ColumnType::Floatn => row.get::<f64, _>(idx).map(|v| v.to_string()),
        ColumnType::Datetime | ColumnType::Datetime2 | ColumnType::Datetimen
        | ColumnType::Datetime4 => {
            row.get::<chrono::NaiveDateTime, _>(idx).map(|v| v.to_string())
        }
        ColumnType::Daten => row.get::<chrono::NaiveDate, _>(idx).map(|v| v.to_string()),
        ColumnType::Timen => row.get::<chrono::NaiveTime, _>(idx).map(|v| v.to_string()),
        // datetimeoffset：tiberius 仅实现 DateTime<Utc>（已折算偏移），转 UTC 字符串
        ColumnType::DatetimeOffsetn => {
            row.get::<chrono::DateTime<chrono::Utc>, _>(idx).map(|v| v.to_string())
        }
        // decimal/numeric/money/smallmoney → rust_decimal::Decimal（否则读为 NULL）
        ColumnType::Decimaln | ColumnType::Numericn
        | ColumnType::Money | ColumnType::Money4 => {
            row.get::<rust_decimal::Decimal, _>(idx).map(|v| v.to_string())
        }
        ColumnType::Guid => row.get::<uuid::Uuid, _>(idx).map(|v| v.to_string()),
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => {
            row.get::<&[u8], _>(idx).map(|v| format!("0x{}", hex::encode(v)))
        }
        // 其余（XML、字符串类型 NVarchar/Varchar/NChar/Char/Text/NText 等）统一走 &str
        _ => row.get::<&str, _>(idx).map(|v| v.to_string()),
    }
}

// ── 核心执行函数（供 query.rs dispatch 调用）──────────────────────────────────────

pub async fn dispatch_ss_query(
    id: &str,
    config: &ConnConfig,
    sql: &str,
    pool: &SsPool,
) -> Result<crate::models::QueryResult, String> {
    require_sql(config, sql)?;
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    query_on_entry(&entry_arc, sql).await
}

/// Explicit transactions execute on a retained session without loading new config.
pub async fn query_on_entry(
    entry_arc: &Arc<Mutex<SsEntry>>,
    sql: &str,
) -> Result<crate::models::QueryResult, String> {
    let mut entry = entry_arc.lock().await;
    query_on_locked_entry(&mut entry, sql).await
}

pub async fn query_on_locked_entry(
    entry: &mut SsEntry,
    sql: &str,
) -> Result<crate::models::QueryResult, String> {
    let t0 = std::time::Instant::now();

    // 仅对 DML 追加 SELECT @@ROWCOUNT 取受影响行数（DDL 如 CREATE PROCEDURE 必须独占批次，不能追加）
    let first_kw = sql.trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .next().unwrap_or("").to_ascii_uppercase();
    let is_dml = matches!(first_kw.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE");

    let tagged = if is_dml {
        format!("/* DBTerm */ {sql}\n;SELECT @@ROWCOUNT AS [__dbterm_rc__]")
    } else {
        format!("/* DBTerm */ {sql}")
    };
    let mut stream = entry.client.simple_query(&tagged).await
        .map_err(|e| format!("SQL Server 查询失败: {e}"))?;
    use futures::TryStreamExt;
    let mut budget = crate::commands::query_result_budget::ResultBudget::default();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut affected = 0;
    // Drain all result sets, but decode only the first. DML's final @@ROWCOUNT
    // remains separate, so OUTPUT and affected-row semantics are preserved.
    while let Some(item) = stream.try_next().await.map_err(|e| format!("读取结果集失败: {e}"))? {
        match item {
            tiberius::QueryItem::Metadata(meta) if meta.result_index() == 0 => {
                columns = meta.columns().iter().map(|c| c.name().to_string()).collect();
            }
            tiberius::QueryItem::Row(row) => {
                if is_dml && row.columns().first().is_some_and(|c| c.name() == "__dbterm_rc__") {
                    affected = row.get::<i32, _>(0).unwrap_or(0) as u64;
                } else if row.result_index() == 0 {
                    budget.start_row()?;
                    let mut decoded = Vec::new();
                    for i in 0..columns.len() {
                        let cell = cell_to_string(&row, i);
                        budget.cell(cell.as_deref())?;
                        decoded.push(cell);
                    }
                    rows.push(decoded);
                }
            }
            _ => {}
        }
    }
    if columns.first().is_some_and(|c| c == "__dbterm_rc__") { columns.clear(); }
    Ok(crate::models::QueryResult {
        is_select: !columns.is_empty(), columns, rows, rows_affected: affected,
        execution_time_ms: t0.elapsed().as_millis() as u64, truncated: false,
    })
}

pub async fn dispatch_ss_schemas(
    id: &str,
    config: &ConnConfig,
    pool: &SsPool,
) -> Result<Vec<String>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let stream = entry.client
        .simple_query("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name").await
        .map_err(|e| format!("获取数据库列表失败: {e}"))?;
    let rows = stream.into_first_result().await
        .map_err(|e| format!("读取数据库列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string())).collect())
}

pub async fn dispatch_ss_tables(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    pool: &SsPool,
) -> Result<Vec<crate::models::TableInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 切换到目标数据库（如果提供）
    let db_context = if !schema.is_empty() && schema != "master" {
        format!("USE [{}]; ", schema.replace(']', "]]"))
    } else {
        String::new()
    };

    let sql = format!(
        "{db_context}SELECT t.name, t.type_desc FROM sys.objects t WHERE t.type IN ('U','V') ORDER BY t.name"
    );
    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("获取表列表失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取表列表失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        let name = r.get::<&str, _>(0)?.to_string();
        let type_desc = r.get::<&str, _>(1).unwrap_or("USER_TABLE");
        Some(crate::models::TableInfo { name, is_view: type_desc == "VIEW" })
    }).collect())
}

/// 列出指定数据库内的用户创建 Schema（dbo/HumanResources 等，过滤系统 schema）
pub async fn dispatch_ss_db_schemas(
    id: &str,
    config: &ConnConfig,
    database: &str,
    pool: &SsPool,
) -> Result<Vec<String>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let db_ctx = if database.is_empty() { String::new() } else {
        format!("USE [{}]; ", database.replace(']', "]]"))
    };
    // 过滤 SQL Server 内置系统 schema；只保留用户创建的
    let sql = format!(
        "{db_ctx}SELECT name FROM sys.schemas \
         WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner',\
         'db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator',\
         'db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') \
         ORDER BY name"
    );
    let stream = entry.client.simple_query(&sql).await
        .map_err(|e| format!("获取 Schema 列表失败: {e}"))?;
    let rows = stream.into_first_result().await
        .map_err(|e| format!("读取 Schema 列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string())).collect())
}

/// 列出指定 database.ss_schema 下的表和视图
pub async fn dispatch_ss_schema_tables(
    id: &str,
    config: &ConnConfig,
    database: &str,
    ss_schema: &str,
    pool: &SsPool,
) -> Result<Vec<crate::models::TableInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let db_ctx = if database.is_empty() { String::new() } else {
        format!("USE [{}]; ", database.replace(']', "]]"))
    };
    // 对 ss_schema 参数使用 N'' 参数化样式（tiberius 不支持绑定参数的 simple_query，
    // 改用字符串转义：将单引号替换为双单引号）
    let esc_schema = ss_schema.replace('\'', "''");
    let sql = format!(
        "{db_ctx}SELECT t.name, t.type_desc \
         FROM sys.objects t \
         JOIN sys.schemas s ON t.schema_id = s.schema_id \
         WHERE t.type IN ('U','V') AND s.name = '{esc_schema}' \
         ORDER BY t.name"
    );
    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("获取表列表失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取表列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| {
        let name = r.get::<&str, _>(0)?.to_string();
        let type_desc = r.get::<&str, _>(1).unwrap_or("USER_TABLE");
        Some(crate::models::TableInfo { name, is_view: type_desc == "VIEW" })
    }).collect())
}

/// 表/视图元数据（SchemaBrowser 用）——返回 U(表) 与 V(视图)
pub async fn dispatch_ss_tables_meta_in_schema(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    ss_schema: Option<&str>,
    pool: &SsPool,
) -> Result<Vec<crate::commands::query::TableMetaInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 切换到目标数据库（dm_db_partition_stats 是库级 DMV，需先 USE）
    let db_context = if !schema.is_empty() {
        format!("USE [{}]; ", schema.replace(']', "]]"))
    } else {
        String::new()
    };

    // 行数与空间统计走 sys.dm_db_partition_stats（视图无分区统计 → 自动为 0）
    // 注释取扩展属性 MS_Description；时间用 CONVERT(120) 输出 'YYYY-MM-DD HH:MM:SS'
    let sql = format!(
        "{db_context}SELECT o.name AS tname, \
         CAST(ISNULL(ep.value, '') AS NVARCHAR(MAX)) AS tcomment, \
         CAST(ISNULL(ps.rows, 0) AS BIGINT) AS row_count, \
         CAST(ISNULL(ps.data_bytes, 0) AS BIGINT) AS data_bytes, \
         CAST(ISNULL(ps.index_bytes, 0) AS BIGINT) AS index_bytes, \
         CONVERT(VARCHAR(19), o.modify_date, 120) AS modified, \
         CONVERT(VARCHAR(19), o.create_date, 120) AS created, \
         o.type_desc AS type_desc \
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
         LEFT JOIN ( \
           SELECT object_id, \
             SUM(CASE WHEN index_id IN (0,1) THEN row_count ELSE 0 END) AS rows, \
             SUM(CAST(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count AS BIGINT)) * 8192 AS data_bytes, \
             (SUM(CAST(used_page_count AS BIGINT)) - SUM(CAST(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count AS BIGINT))) * 8192 AS index_bytes \
           FROM sys.dm_db_partition_stats GROUP BY object_id \
         ) ps ON ps.object_id = o.object_id \
         WHERE o.type IN ('U','V') AND (@P1 IS NULL OR s.name = @P1) \
         ORDER BY o.name"
    );
    let mut query = tiberius::Query::new(sql);
    query.bind(ss_schema);
    let rows = query.query(&mut entry.client).await
        .map_err(|e| format!("获取表元数据失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取表元数据失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        let name = r.get::<&str, _>(0)?.to_string();
        let comment = r.get::<&str, _>(1).unwrap_or("").to_string();
        let row_count = r.get::<i64, _>(2).unwrap_or(0);
        let data_length = r.get::<i64, _>(3).unwrap_or(0).max(0);
        let index_length = r.get::<i64, _>(4).unwrap_or(0).max(0);
        let updated_at = r.get::<&str, _>(5).map(|s| s.to_string());
        let created_at = r.get::<&str, _>(6).map(|s| s.to_string());
        let table_type = if r.get::<&str, _>(7).unwrap_or("USER_TABLE") == "VIEW" {
            "VIEW".to_string()
        } else {
            "BASE TABLE".to_string()
        };
        Some(crate::commands::query::TableMetaInfo {
            name, comment, row_count, data_length, index_length,
            auto_increment: None, engine: String::new(), charset: String::new(),
            updated_at, created_at, table_type,
        })
    }).collect())
}

/// 整库「表名 → 列名」映射（SQL 编辑器智能补全批量加载用）
pub async fn dispatch_ss_schema_columns(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    pool: &SsPool,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let db_context = if !schema.is_empty() && schema != "master" {
        format!("USE [{}]; ", schema.replace(']', "]]"))
    } else {
        String::new()
    };
    let sql = format!(
        "{db_context}SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
         ORDER BY TABLE_NAME, ORDINAL_POSITION"
    );
    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("获取列信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取列信息失败: {e}"))?;
    let mut map = std::collections::HashMap::<String, Vec<String>>::new();
    for r in &rows {
        if let (Some(t), Some(c)) = (r.get::<&str, _>(0), r.get::<&str, _>(1)) {
            map.entry(t.to_string()).or_default().push(c.to_string());
        }
    }
    Ok(map)
}

fn unique_metadata_schema(table: &str, schemas: &[String]) -> Result<String, String> {
    match schemas {
        [schema] => Ok(schema.clone()),
        [] => Err(format!("目标对象 {table} 不存在或无权限读取，已停止加载字段")),
        _ => Err(format!("目标对象 {table} 匹配多个 schema，当前入口未指定 schema，已停止加载字段，避免混用同名对象")),
    }
}

pub async fn dispatch_ss_columns(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    pool: &SsPool,
) -> Result<Vec<crate::models::ColumnInfo>, String> {
    dispatch_ss_columns_in_schema(id, config, schema, table, None, pool).await
}

pub async fn dispatch_ss_columns_in_schema(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    ss_schema: Option<&str>,
    pool: &SsPool,
) -> Result<Vec<crate::models::ColumnInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let db_context = if !schema.is_empty() { format!("USE [{}]; ", schema.replace(']', "]]")) } else { String::new() };
    let mut target = tiberius::Query::new(format!(
        "{db_context}SELECT s.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.name=@P1 AND o.type IN ('U','V') AND (@P2 IS NULL OR s.name=@P2)"
    ));
    target.bind(table);
    target.bind(ss_schema);
    let targets = target.query(&mut entry.client).await
        .map_err(|e| format!("字段目标定位失败: {e}"))?
        .into_first_result().await.map_err(|e| format!("字段目标定位失败: {e}"))?;
    let schemas: Vec<String> = targets.iter().filter_map(|row| row.get::<&str, _>(0).map(str::to_string)).collect();
    let object_schema = unique_metadata_schema(table, &schemas)?;
    // 使用参数化查询防止表名注入（@P1 替代字符串拼接）
    let sql = format!(
        "{db_context}SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
         CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END AS key_type, \
         c.COLUMN_DEFAULT \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN ( \
           SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
             ON tc.CONSTRAINT_CATALOG = ku.CONSTRAINT_CATALOG \
            AND tc.CONSTRAINT_SCHEMA = ku.CONSTRAINT_SCHEMA \
            AND tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME \
            AND tc.TABLE_CATALOG = ku.TABLE_CATALOG \
            AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA AND tc.TABLE_NAME = ku.TABLE_NAME \
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @P1 AND tc.TABLE_SCHEMA = @P2 \
         ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME \
         WHERE c.TABLE_NAME = @P1 AND c.TABLE_SCHEMA = @P2 \
         ORDER BY c.ORDINAL_POSITION"
    );
    let mut q = tiberius::Query::new(sql);
    q.bind(table);
    q.bind(object_schema);
    let rows = q.query(&mut entry.client).await
        .map_err(|e| format!("获取列信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取列信息失败: {e}"))?;

    Ok(rows.iter().map(|r| crate::models::ColumnInfo {
        name:          r.get::<&str, _>(0).unwrap_or("").to_string(),
        data_type:     r.get::<&str, _>(1).unwrap_or("").to_string(),
        nullable:      r.get::<&str, _>(2).map(|s| s == "YES").unwrap_or(true),
        key:           r.get::<&str, _>(3).unwrap_or("").to_string(),
        default_value: r.get::<&str, _>(4).map(|s| s.to_string()),
    }).collect())
}

pub async fn dispatch_ss_ddl(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    pool: &SsPool,
) -> Result<String, String> {
    dispatch_ss_ddl_in_schema(id, config, schema, table, None, pool).await
}

pub async fn dispatch_ss_ddl_in_schema(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    ss_schema: Option<&str>,
    pool: &SsPool,
) -> Result<String, String> {
    Ok(dispatch_ss_archive_ddl(id, config, schema, table, ss_schema, pool).await?.complete())
}

pub(crate) async fn dispatch_ss_archive_ddl(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    ss_schema: Option<&str>,
    pool: &SsPool,
) -> Result<ddl_script::TableScript, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let db_context = if !schema.is_empty() { format!("USE [{}]; ", schema.replace(']', "]]")) } else { String::new() };

    let mut target = tiberius::Query::new(format!(
        "{db_context}SELECT s.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.name=@P1 AND o.type IN ('U','V','P','FN','IF','TF') AND (@P2 IS NULL OR s.name=@P2)"
    ));
    target.bind(table);
    target.bind(ss_schema);
    let targets = target.query(&mut entry.client).await.map_err(|e| format!("DDL目标定位失败: {e}"))?
        .into_first_result().await.map_err(|e| format!("DDL目标定位失败: {e}"))?;
    let schemas: Vec<String> = targets.iter().filter_map(|r| r.get::<&str, _>(0).map(str::to_string)).collect();
    let object_schema = unique_metadata_schema(table, &schemas)?;
    let object_ref = format!("[{}].[{}]", object_schema.replace(']', "]]"), table.replace(']', "]]"));

    // ① 判定对象类型；视图/函数/存储过程直接返回真实定义（OBJECT_DEFINITION），
    //    基表（type='U'）才在 Rust 端逐列重建 DDL（避免 STRING_AGG，全版本兼容）。
    let meta_sql = format!(
        "{db_context}SELECT RTRIM(o.type), OBJECT_DEFINITION(o.object_id), sm.uses_ansi_nulls, sm.uses_quoted_identifier \
         FROM sys.objects o LEFT JOIN sys.sql_modules sm ON sm.object_id = o.object_id WHERE o.object_id = OBJECT_ID(@P1)"
    );
    let mut mq = tiberius::Query::new(meta_sql);
    mq.bind(object_ref.as_str());
    let meta = mq.query(&mut entry.client).await
        .map_err(|e| format!("获取对象信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取对象信息失败: {e}"))?;
    let (obj_type, obj_def) = match meta.first() {
        Some(r) => (
            r.get::<&str, _>(0).unwrap_or("U").trim().to_string(),
            r.get::<&str, _>(1).map(|s| s.to_string()),
        ),
        None => return Err(format!("对象不存在: {table}")),
    };
    if obj_type != "U" {
        // 视图 V / 存储过程 P / 函数 FN/IF/TF：直接返回定义脚本
        let definition = obj_def.filter(|s| !s.trim().is_empty()).ok_or("对象定义不可读或已加密，已停止生成DDL")?;
        let row = meta.first().ok_or("模块元数据不存在")?;
        let ansi = row.get::<bool, _>(2).ok_or("模块ANSI_NULLS创建属性不可读，已停止导出")?;
        let quoted = row.get::<bool, _>(3).ok_or("模块QUOTED_IDENTIFIER创建属性不可读，已停止导出")?;
        return Ok(ddl_script::TableScript { definition, post_data: Vec::new(), constraints: Vec::new(), triggers: Vec::new(), module_session: Some((ansi, quoted)) });
    }

    // ② 列定义（不聚合，逐行取回在 Rust 拼装）
    let cols_sql = format!(
        "{db_context}SELECT c.name, tp.name, c.max_length, c.precision, c.scale, \
         c.is_nullable, c.is_identity, OBJECT_DEFINITION(c.default_object_id), \
         CAST(ic.seed_value AS VARCHAR(40)), CAST(ic.increment_value AS VARCHAR(40)), \
         c.collation_name, c.is_computed, cc.definition, cc.is_persisted, dc.name, \
         tp.is_user_defined, SCHEMA_NAME(tp.schema_id), ic.is_not_for_replication, \
         c.is_rowguidcol, c.is_sparse, c.is_filestream, c.default_object_id \
         FROM sys.columns c \
         JOIN sys.types tp ON c.user_type_id = tp.user_type_id \
         LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         WHERE c.object_id = OBJECT_ID(@P1) ORDER BY c.column_id"
    );
    let mut cq = tiberius::Query::new(cols_sql);
    cq.bind(object_ref.as_str());
    let col_rows = cq.query(&mut entry.client).await
        .map_err(|e| format!("获取列信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取列信息失败: {e}"))?;
    if col_rows.is_empty() { return Err(format!("表无列信息: {table}")); }

    let mut lines: Vec<String> = Vec::new();
    for r in &col_rows {
        let text = |i| r.get::<&str, _>(i).map(str::to_string);
        let computed = r.get::<bool, _>(11).ok_or("DDL计算列标记不可见")?;
        let identity = r.get::<bool, _>(6).ok_or("DDL字段IDENTITY属性不可见")?;
        if r.get::<i32, _>(21).ok_or("DDL默认对象标记不可见")? != 0
            && text(7).as_deref().is_none_or(|s| s.trim().is_empty()) {
            return Err("字段存在默认对象但无法读取定义，已停止生成DDL".into());
        }
        let definition = ddl_columns::ColumnDefinition {
            name: text(0).ok_or("DDL字段名称不可见")?,
            type_name: text(1).ok_or("DDL字段类型不可见")?,
            max_length: r.get::<i16, _>(2).ok_or("DDL字段长度不可见")?,
            precision: r.get::<u8, _>(3).ok_or("DDL字段精度不可见")?,
            scale: r.get::<u8, _>(4).ok_or("DDL字段小数位不可见")?,
            nullable: r.get::<bool, _>(5).ok_or("DDL字段NULL属性不可见")?,
            identity,
            default_definition: text(7), seed: text(8), increment: text(9),
            collation: text(10),
            computed,
            expression: text(12),
            persisted: if computed { r.get::<bool, _>(13).ok_or("DDL计算列持久化标记不可见")? } else { false },
            default_name: text(14),
            user_defined: r.get::<bool, _>(15).ok_or("DDL自定义类型标记不可见")?,
            type_schema: text(16),
            not_for_replication: if identity { r.get::<bool, _>(17).ok_or("DDL自增复制属性不可见")? } else { false },
            rowguid: r.get::<bool, _>(18).ok_or("DDL ROWGUIDCOL属性不可见")?,
            sparse: r.get::<bool, _>(19).ok_or("DDL SPARSE属性不可见")?,
            filestream: r.get::<bool, _>(20).ok_or("DDL FILESTREAM属性不可见")?,
        };
        lines.push(definition.render()?);
    }

    let tbl_ref = if schema.is_empty() {
        object_ref.clone()
    } else {
        format!("[{}].{object_ref}", schema.replace(']', "]]"))
    };
    let (keys, indexes) = ddl_indexes::read_indexes(&mut entry, &db_context, &object_ref, &tbl_ref).await?;
    lines.extend(keys);
    let mut definition = format!("CREATE TABLE {tbl_ref} (\n{}\n);", lines.join(",\n"));
    for property in ddl_properties::read_properties(&mut entry, &db_context, &object_ref, &object_schema, table).await? {
        definition.push_str("\nGO\n"); definition.push_str(&property); definition.push_str("\nGO\n");
    }
    let constraints = ddl_constraints::read_constraints(&mut entry, &db_context, &object_ref, &tbl_ref).await?;
    let triggers = ddl_triggers::read_triggers(&mut entry, &db_context, &object_ref, &tbl_ref).await?;
    Ok(ddl_script::TableScript { definition, post_data: indexes, constraints, triggers, module_session: None })
}

/// 把 sys.columns 的类型 + 长度/精度还原为 T-SQL 类型片段（nchar/nvarchar 字节长度需 /2）
fn ss_format_coltype(type_name: &str, max_length: i16, precision: u8, scale: u8) -> String {
    let t = type_name.to_lowercase();
    match t.as_str() {
        "varchar" | "char" | "varbinary" | "binary" =>
            if max_length == -1 { format!("{t}(max)") } else { format!("{t}({max_length})") },
        "nvarchar" | "nchar" =>
            if max_length == -1 { format!("{t}(max)") } else { format!("{t}({})", max_length / 2) },
        "decimal" | "numeric" => format!("{t}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{t}({scale})"),
        _ => t,
    }
}

/// MS0.1: 测试连接可达性（不使用连接池，专为 tester.rs 提供）
pub async fn test_connection(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    let cfg = SsConnCfg::from_config(config);
    let host = config.host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
    let port = config.port.unwrap_or(1433);

    let mut tc = Config::new();
    tc.host(&host);
    tc.port(port);
    tc.readonly(cfg.app_intent.eq_ignore_ascii_case("ReadOnly"));
    if !cfg.instance.is_empty() { tc.instance_name(&cfg.instance); }
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) { tc.database(db); }
    let user = config.username.as_deref().unwrap_or("sa");
    tc.authentication(AuthMethod::sql_server(user, password.unwrap_or("")));
    if cfg.encrypt { tc.encryption(EncryptionLevel::Required); } else { tc.encryption(EncryptionLevel::Off); }
    if cfg.trust_cert { tc.trust_cert(); }

    let timeout_secs = if cfg.connect_timeout == 0 { 30 } else { cfg.connect_timeout.clamp(3, 300) };
    let addr = tc.get_addr();
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        TcpStream::connect(addr),
    ).await
        .map_err(|_| format!("SQL Server 连接超时（{}s）", timeout_secs))?
        .map_err(|e| format!("TCP 连接失败: {e}"))?;
    tcp.set_nodelay(true).map_err(|e| format!("set_nodelay 失败: {e}"))?;

    let mut client = Client::connect(tc, tcp.compat_write()).await
        .map_err(|e| format!("SQL Server 握手失败: {e}"))?;
    let rows = client.simple_query("SELECT @@VERSION").await
        .map_err(|e| format!("版本查询失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取版本失败: {e}"))?;
    let version = rows.first()
        .and_then(|r| r.get::<&str, _>(0))
        .unwrap_or("SQL Server");
    let short = version.lines().next().unwrap_or(version);
    Ok(format!("{short} 连接成功"))
}

/// MS0.5: 行内单元格更新（参数绑定防注入，影响行数 ≠ 1 则拒绝）
pub(crate) fn table_write_config(config: &ConnConfig, database: &str) -> ConnConfig {
    let mut effective = config.clone();
    if !database.is_empty() { effective.database = Some(database.into()); }
    effective
}

fn qualified_resolved_target(database: &str, table: &str, schemas: &[String]) -> Result<String, String> {
    if schemas.len() != 1 { return Err(format!("目标表 {table} 无法唯一定位（匹配 {} 个 schema），已拒绝写操作", schemas.len())); }
    let quote = |s: &str| format!("[{}]", s.replace(']', "]]"));
    Ok(format!("{}.{}.{}", quote(database), quote(&schemas[0]), quote(table)))
}

pub(crate) async fn resolve_table_target(entry: &mut SsEntry, table: &str) -> Result<String, String> {
    resolve_table_target_in_schema(entry, table, None).await
}

pub(crate) async fn resolve_table_target_in_schema(entry: &mut SsEntry, table: &str, ss_schema: Option<&str>) -> Result<String, String> {
    let mut query = tiberius::Query::new("SELECT DB_NAME() AS database_name,s.name AS schema_name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.name=@P1 AND (@P2 IS NULL OR s.name=@P2)");
    query.bind(table);
    query.bind(ss_schema);
    let rows = query.query(&mut entry.client).await.map_err(|e| format!("目标表定位失败: {e}"))?
        .into_first_result().await.map_err(|e| format!("目标表定位失败: {e}"))?;
    let database = rows.first().and_then(|r| r.get::<&str,_>(0)).unwrap_or("");
    let schemas: Vec<String> = rows.iter().filter_map(|r| r.get::<&str,_>(1).map(str::to_string)).collect();
    qualified_resolved_target(database, table, &schemas)
}

async fn finish_single_row_update<S>(
    session: &mut S, result: Result<u64, String>,
    mut execute: impl for<'a> FnMut(&'a mut S, &'a str) -> futures::future::BoxFuture<'a, Result<u64, String>>,
) -> Result<(), String> {
    let checked = result.and_then(|count| if count == 1 { Ok(()) } else { Err(format!("预期影响 1 行，实际影响 {count} 行")) });
    if let Err(error) = checked {
        return match execute(session, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await {
            Ok(_) => Err(format!("{error}；已回滚")),
            Err(rollback) => Err(format!("{error}；回滚失败，事务结果未知: {rollback}")),
        };
    }
    execute(session, "COMMIT TRANSACTION").await.map(|_| ())
        .map_err(|e| format!("提交失败，提交结果未知；请核实数据库状态，勿重复提交: {e}"))
}

fn execute_locked_update_control<'a>(
    entry: &'a mut SsEntry, sql: &'a str,
) -> futures::future::BoxFuture<'a, Result<u64, String>> {
    Box::pin(async move { query_on_locked_entry(entry, sql).await.map(|r| r.rows_affected) })
}

pub async fn ss_update_cell(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    column: &str,
    new_value: Option<String>,
    pk_columns: &[String],
    pk_values: &[Option<String>],
    expected_value: &Option<String>,
    _pool: &SsPool,
    ss_schema: Option<&str>,
) -> Result<(), String> {
    require_write(config)?;
    super::db_extra::validate_native_insert_rows(pk_columns, &[pk_values.to_vec()])?;
    let dedicated: SsPool = Arc::new(Mutex::new(HashMap::new()));
    let effective = table_write_config(config, schema);
    let entry_arc = get_entry(id, &dedicated, &effective, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let target = resolve_table_target_in_schema(&mut entry, table, ss_schema).await?;

    query_on_locked_entry(&mut entry, "SET XACT_ABORT ON; BEGIN TRANSACTION").await.map_err(|e|format!("开启更新事务失败: {e}"))?;
    query_on_locked_entry(&mut entry,&format!("SELECT TOP 1 1 FROM {target} WITH (TABLOCKX,HOLDLOCK)")).await?;
    for checked in std::iter::once(column).chain(pk_columns.iter().map(String::as_str)){
      let type_sql=format!("SELECT TYPE_NAME(c.system_type_id) AS kind FROM sys.columns c WHERE c.object_id=OBJECT_ID(N'{}') AND c.name=N'{}'",target.replace('\'',"''"),checked.replace('\'',"''"));
      let kinds=query_on_locked_entry(&mut entry,&type_sql).await?;
      if !kinds.rows.first().and_then(|r|r.first()).and_then(|v|v.as_deref()).is_some_and(|kind|matches!(kind,"varchar"|"nvarchar"|"char"|"nchar"|"tinyint"|"smallint"|"int"|"bigint"|"decimal"|"numeric")){return Err("字段或定位键尚不能恢复精确并发基线，请使用显式 SQL".into());}
    }

    // T-SQL 标识符引用：[name]，内部 ] 转义为 ]]
    let q_br = |s: &str| format!("[{}]", s.replace(']', "]]"));

    // 顺序分配参数位 @P1, @P2, ...
    let mut next_p: usize = 1;
    let set_part = if new_value.is_some() {
        let r = format!("{} = @P{next_p}", q_br(column));
        next_p += 1;
        r
    } else {
        format!("{} = NULL", q_br(column))
    };

    let mut where_parts: Vec<String> = Vec::with_capacity(pk_columns.len());
    for (c, v) in pk_columns.iter().zip(pk_values.iter()) {
        if v.is_some() {
            where_parts.push(format!("CONVERT(varbinary(max),CONVERT(nvarchar(max),{})) = CONVERT(varbinary(max),CAST(@P{next_p} AS nvarchar(max)))", q_br(c)));
            next_p += 1;
        } else {
            where_parts.push(format!("{} IS NULL", q_br(c)));
        }
    }

    where_parts.push(if expected_value.is_some() { format!("CONVERT(varbinary(max),CONVERT(nvarchar(max),{})) = CONVERT(varbinary(max),CAST(@P{next_p} AS nvarchar(max)))",q_br(column)) } else { format!("{} IS NULL",q_br(column)) });
    let sql = format!("UPDATE {target} SET {set_part} WHERE {}", where_parts.join(" AND "));


    let mut query = tiberius::Query::new(sql);
    if let Some(ref val) = new_value { query.bind(val.as_str()); }
    for v in pk_values {
        if let Some(ref pv) = v { query.bind(pv.as_str()); }
    }

    if let Some(value)=expected_value { query.bind(value.as_str()); }
    let result = query.execute(&mut entry.client).await
        .map(|r| r.total()).map_err(|e| format!("更新失败: {e}"));
    finish_single_row_update(&mut *entry, result, execute_locked_update_control).await
}

/// MS0.4: 存储过程/函数/触发器/视图对象列表（RoutineInfo）
pub async fn dispatch_ss_routines(
    id: &str,
    config: &ConnConfig,
    schema: &str,    // 数据库名（SQL Server 三层：db.schema.object）
    password: Option<&str>,
    pool: &SsPool,
) -> Result<Vec<crate::models::RoutineInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.or_else(|| password.map(|s| s.to_string())).as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let db_ctx = if !schema.is_empty() { format!("USE [{}]; ", schema.replace(']', "]]")) } else { String::new() };
    let sql = format!(
        "{db_ctx}SELECT o.name, o.type_desc FROM sys.objects o \
         WHERE o.type IN ('P','FN','IF','TF','TR','SN')  -- 存储过程/函数/触发器/同义词 \
         ORDER BY o.type_desc, o.name"
    );

    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("获取对象列表失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取对象列表失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        let name = r.get::<&str, _>(0)?.to_string();
        let type_desc = r.get::<&str, _>(1).unwrap_or("SQL_STORED_PROCEDURE").to_string();
        let routine_type = match type_desc.as_str() {
            "SQL_STORED_PROCEDURE" | "CLR_STORED_PROCEDURE" | "EXTENDED_STORED_PROCEDURE" => "PROCEDURE",
            "SQL_SCALAR_FUNCTION" | "CLR_SCALAR_FUNCTION" | "SQL_INLINE_TABLE_VALUED_FUNCTION"
            | "SQL_TABLE_VALUED_FUNCTION" | "CLR_TABLE_VALUED_FUNCTION" => "FUNCTION",
            "SQL_TRIGGER" | "CLR_TRIGGER" => "TRIGGER",
            "SYNONYM" => "SYNONYM",
            _ => "OTHER",
        };
        Some(crate::models::RoutineInfo { name, routine_type: routine_type.to_string() })
    }).collect())
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// MS0.2: 断开 SQL Server 连接
#[tauri::command]
pub async fn ss_disconnect(
    id: String,
    pool: State<'_, SsPool>,
) -> Result<(), String> {
    pool.lock().await.remove(&id);
    Ok(())
}

/// MS0.2: 测试 SQL Server 连接
#[tauri::command]
pub async fn ss_test(
    config: ConnConfig,
    password: Option<String>,
    pool: State<'_, SsPool>,
) -> Result<String, String> {
    let entry_arc = get_entry(&config.id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    let rows = entry.client.simple_query("SELECT @@VERSION").await
        .map_err(|e| format!("测试查询失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取版本失败: {e}"))?;
    let version = rows.first()
        .and_then(|r| r.get::<&str, _>(0))
        .unwrap_or("SQL Server");
    // 只取第一行（版本字符串很长）
    let short = version.lines().next().unwrap_or(version);
    Ok(format!("{short} 连接成功"))
}

#[cfg(test)]
mod pool_identity_tests {
    #[test]
    fn column_metadata_refuses_missing_or_ambiguous_schema_instead_of_mixing_rows() {
        assert_eq!(super::unique_metadata_schema("same", &["ops'.]中文".into()]).unwrap(), "ops'.]中文");
        assert!(super::unique_metadata_schema("same", &[]).unwrap_err().contains("不存在"));
        assert!(super::unique_metadata_schema("same", &["dbo".into(), "ops".into()]).unwrap_err().contains("多个 schema"));
    }

    #[test]
    fn selected_database_target_requires_one_actual_table_schema() {
        assert_eq!(super::qualified_resolved_target("B]db", "t]able", &["actual]schema".into()]).unwrap(), "[B]]db].[actual]]schema].[t]]able]");
        assert!(super::qualified_resolved_target("B", "t", &[]).is_err());
        assert!(super::qualified_resolved_target("B", "t", &["a".into(),"b".into()]).is_err());
        let config: crate::models::ConnConfig = serde_json::from_value(serde_json::json!({
            "id":"target","name":"target","type":"sqlServer","database":"A",
            "useSsl":false,"createdAt":0,"updatedAt":0
        })).unwrap();
        assert_eq!(super::table_write_config(&config, "B").database.as_deref(), Some("B"));
    }
    #[tokio::test]
    async fn sqlserver_single_update_does_not_commit_multiple_rows_or_retry_lost_commit() {
        struct Fake { calls: Vec<String>, count: u64, lost_commit: bool, lost_rollback: bool }
        fn execute<'a>(state: &'a mut Fake, sql: &'a str) -> futures::future::BoxFuture<'a, Result<u64, String>> {
            Box::pin(async move {
                state.calls.push(sql.into());
                if state.lost_rollback && sql == "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION" { return Err("lost rollback".into()); }
                if state.lost_commit && sql == "COMMIT TRANSACTION" { return Err("lost commit".into()); }
                Ok(state.count)
            })
        }
        let mut multiple = Fake { calls: vec![], count: 2, lost_commit: false, lost_rollback: false };
        let error = super::finish_single_row_update(&mut multiple, Ok(2), execute).await.unwrap_err();
        assert!(error.contains("已回滚"));
        assert_eq!(multiple.calls, ["IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"]);
        let mut failed = Fake { calls: vec![], count: 0, lost_commit: false, lost_rollback: true };
        let error = super::finish_single_row_update(&mut failed, Err("write failed".into()), execute).await.unwrap_err();
        assert!(error.contains("write failed") && error.contains("lost rollback") && error.contains("未知"));
        let mut commit = Fake { calls: vec![], count: 1, lost_commit: true, lost_rollback: false };
        assert!(super::finish_single_row_update(&mut commit, Ok(1), execute).await.unwrap_err().contains("未知"));
        assert_eq!(commit.calls, ["COMMIT TRANSACTION"]);
    }
    #[test]
    fn sqlserver_ui_security_fields_and_safe_defaults_are_honored() {
        let defaults: super::SsConnCfg = serde_json::from_str("{}").unwrap();
        assert!(defaults.encrypt);
        assert!(!defaults.trust_cert);
        let cfg: super::SsConnCfg = serde_json::from_value(serde_json::json!({
            "ssInstance": "NAMED", "ssEncrypt": false, "ssTrustCert": false,
            "ssAppIntent": "ReadOnly"
        })).unwrap();
        assert_eq!(cfg.instance, "NAMED");
        assert!(!cfg.encrypt);
        assert!(!cfg.trust_cert);
        assert_eq!(cfg.app_intent, "ReadOnly");
        let explicit: super::SsConnCfg = serde_json::from_value(serde_json::json!({ "ssTrustCert": true })).unwrap();
        assert!(explicit.trust_cert);
        let legacy: super::SsConnCfg = serde_json::from_value(serde_json::json!({ "trustServerCert": true, "encrypt": false })).unwrap();
        assert!(legacy.trust_cert);
        assert!(!legacy.encrypt);
    }
    #[test]
    fn same_id_changed_endpoint_or_credentials_never_matches() {
        let base: crate::models::ConnConfig = serde_json::from_value(serde_json::json!({
            "id": "pool-identity", "name": "test", "type": "sqlServer",
            "host": "server-a", "port": 9000, "username": "user",
            "database": "db-a", "useSsl": false, "createdAt": 0, "updatedAt": 0
        })).unwrap();
        let original = super::connection_identity(&base, Some("password-a"), "ssh-a").unwrap();
        assert_eq!(original, super::connection_identity(&base, Some("password-a"), "ssh-a").unwrap());
        for field in ["host", "database", "username", "port", "extraJson", "readOnly", "useSsl"] {
            let mut value = serde_json::to_value(&base).unwrap();
            value[field] = match field {
                "readOnly" | "useSsl" => serde_json::json!(true),
                "port" => serde_json::json!(9001),
                _ => serde_json::json!("changed"),
            };
            let changed = serde_json::from_value(value).unwrap();
            assert_ne!(original, super::connection_identity(&changed, Some("password-a"), "ssh-a").unwrap(), "{field}");
        }
        assert_ne!(original, super::connection_identity(&base, Some("password-b"), "ssh-a").unwrap());
        assert_ne!(original, super::connection_identity(&base, Some("password-a"), "ssh-b").unwrap());
    }
}

#[cfg(test)]
mod authorization_tests;
