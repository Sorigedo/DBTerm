// MS0.x + MS1.x: SQL Server 命令域（纯 Rust tiberius，无需外部驱动）
// 完全隔离：不碰 MySQL/PG/SQLite/Redis/MongoDB/DuckDB 侧代码
pub mod admin;
pub mod ha;
pub mod security;
pub mod extra;
use std::{collections::HashMap, sync::Arc};
use serde::Deserialize;
use tauri::State;
use tokio::sync::Mutex;
use tiberius::{Client, Config, AuthMethod, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::{models::ConnConfig, storage::StorageState};

// ── 连接池 ─────────────────────────────────────────────────────────────────────

pub struct SsEntry {
    pub client: Client<Compat<TcpStream>>,
    pub _tunnel: Option<Arc<crate::db_tunnel::DbTunnel>>,
}

// 每个连接包一层独立 Mutex：外层 Mutex 仅在"查找/插入连接"时短暂持有，
// 长查询只锁该连接自身，不阻塞对其他 SQL Server 连接的操作。
pub type SsPool = Arc<Mutex<HashMap<String, Arc<Mutex<SsEntry>>>>>;

/// SQL Server 额外配置（存于 ConnConfig.extra_json）
#[derive(Deserialize, Default)]
#[allow(dead_code)]
pub struct SsConnCfg {
    #[serde(rename = "instance",              default)] pub instance:       String,   // 命名实例（MSSQL\INSTANCE）
    #[serde(rename = "encrypt",               default = "default_true")] pub encrypt: bool, // 强制加密（SQL Server 2022 默认 true）
    #[serde(rename = "trustServerCert",       default = "default_true")] pub trust_cert: bool, // 跳过证书校验
    #[serde(rename = "appIntent",             default)] pub app_intent:     String,   // ReadOnly / ReadWrite
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
    // 快路径：已缓存则直接返回该连接的独立锁句柄
    {
        let guard = pool.lock().await;
        if let Some(e) = guard.get(conn_id) { return Ok(e.clone()); }
    }

    let cfg = SsConnCfg::from_config(config);
    let tunnel_arc: Option<Arc<crate::db_tunnel::DbTunnel>>;

    let (host, port) = if cfg.ssh_tunnel {
        let tcfg = crate::db_tunnel::DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
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

    let entry = Arc::new(Mutex::new(SsEntry { client, _tunnel: tunnel_arc }));

    // 双重检查插入：并发建连时复用先插入者，丢弃本次多建的连接
    let mut guard = pool.lock().await;
    if let Some(e) = guard.get(conn_id) { return Ok(e.clone()); }
    guard.insert(conn_id.to_string(), entry.clone());
    Ok(entry)
}

// ── 辅助：从存储加载连接配置 ─────────────────────────────────────────────────────

pub fn load_conn(id: &str, storage: &StorageState) -> Result<(ConnConfig, Option<String>), String> {
    let guard = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = guard.load()?;
    let config = list.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接 {id} 不存在"))?;
    drop(guard);
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

pub fn rows_to_result(
    columns: Vec<String>,
    raw_rows: Vec<tiberius::Row>,
    rows_affected: u64,
    elapsed_ms: u64,
) -> crate::models::QueryResult {
    let rows = raw_rows.iter().map(|row| {
        (0..columns.len()).map(|i| cell_to_string(row, i)).collect()
    }).collect();
    let is_sel = !columns.is_empty();
    crate::models::QueryResult { columns, rows, rows_affected, execution_time_ms: elapsed_ms, truncated: false, is_select: is_sel }
}

// ── 核心执行函数（供 query.rs dispatch 调用）──────────────────────────────────────

pub async fn dispatch_ss_query(
    id: &str,
    config: &ConnConfig,
    sql: &str,
    pool: &SsPool,
) -> Result<crate::models::QueryResult, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;

    let t0 = std::time::Instant::now();
    let mut entry = entry_arc.lock().await;

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
    let result = entry.client.simple_query(&tagged).await
        .map_err(|e| format!("SQL Server 查询失败: {e}"))?;

    let mut sets = result.into_results().await
        .map_err(|e| format!("读取结果集失败: {e}"))?;

    let elapsed = t0.elapsed().as_millis() as u64;

    if is_dml {
        // 最后一个结果集是 @@ROWCOUNT
        let rc = sets.pop()
            .and_then(|s| s.into_iter().next())
            .and_then(|r| r.get::<i32, _>(0))
            .unwrap_or(0) as u64;
        // 若 DML 带 OUTPUT 子句还会返回数据集，一并展示
        if let Some(fs) = sets.into_iter().next() {
            if !fs.is_empty() {
                let columns: Vec<String> = fs[0].columns().iter().map(|c| c.name().to_string()).collect();
                return Ok(rows_to_result(columns, fs, rc, elapsed));
            }
        }
        return Ok(crate::models::QueryResult {
            columns: vec![], rows: vec![], rows_affected: rc, execution_time_ms: elapsed, truncated: false, is_select: false,
        });
    }

    // 非 DML：取第一个结果集（最常见情况）
    if let Some(first_set) = sets.into_iter().next() {
        if first_set.is_empty() {
            return Ok(crate::models::QueryResult {
                columns: vec![], rows: vec![], rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: false,
            });
        }
        let columns: Vec<String> = first_set[0].columns().iter().map(|c| c.name().to_string()).collect();
        return Ok(rows_to_result(columns, first_set, 0, elapsed));
    }

    Ok(crate::models::QueryResult {
        columns: vec![], rows: vec![], rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: false,
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
pub async fn dispatch_ss_tables_meta(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    pool: &SsPool,
) -> Result<Vec<crate::commands::query::TableMetaInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 切换到目标数据库（dm_db_partition_stats 是库级 DMV，需先 USE）
    let db_context = if !schema.is_empty() && schema != "master" {
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
         FROM sys.objects o \
         LEFT JOIN sys.extended_properties ep \
           ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' \
         LEFT JOIN ( \
           SELECT object_id, \
             SUM(CASE WHEN index_id IN (0,1) THEN row_count ELSE 0 END) AS rows, \
             SUM(CAST(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count AS BIGINT)) * 8192 AS data_bytes, \
             (SUM(CAST(used_page_count AS BIGINT)) - SUM(CAST(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count AS BIGINT))) * 8192 AS index_bytes \
           FROM sys.dm_db_partition_stats GROUP BY object_id \
         ) ps ON ps.object_id = o.object_id \
         WHERE o.type IN ('U','V') \
         ORDER BY o.name"
    );
    let rows = entry.client.simple_query(&sql).await
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

pub async fn dispatch_ss_columns(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    pool: &SsPool,
) -> Result<Vec<crate::models::ColumnInfo>, String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let db_context = if !schema.is_empty() { format!("USE [{}]; ", schema.replace(']', "]]")) } else { String::new() };
    // 使用参数化查询防止表名注入（@P1 替代字符串拼接）
    let sql = format!(
        "{db_context}SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
         CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END AS key_type, \
         c.COLUMN_DEFAULT \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN ( \
           SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME \
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @P1 \
         ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME \
         WHERE c.TABLE_NAME = @P1 \
         ORDER BY c.ORDINAL_POSITION"
    );
    let mut q = tiberius::Query::new(sql);
    q.bind(table);
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
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let db_context = if !schema.is_empty() { format!("USE [{}]; ", schema.replace(']', "]]")) } else { String::new() };

    // ① 判定对象类型；视图/函数/存储过程直接返回真实定义（OBJECT_DEFINITION），
    //    基表（type='U'）才在 Rust 端逐列重建 DDL（避免 STRING_AGG，全版本兼容）。
    let meta_sql = format!(
        "{db_context}SELECT RTRIM(o.type), OBJECT_DEFINITION(o.object_id) \
         FROM sys.objects o WHERE o.object_id = OBJECT_ID(@P1)"
    );
    let mut mq = tiberius::Query::new(meta_sql);
    mq.bind(table);
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
        return Ok(obj_def.unwrap_or_default());
    }

    // ② 列定义（不聚合，逐行取回在 Rust 拼装）
    let cols_sql = format!(
        "{db_context}SELECT c.name, tp.name, c.max_length, c.precision, c.scale, \
         c.is_nullable, c.is_identity, OBJECT_DEFINITION(c.default_object_id), \
         CAST(ic.seed_value AS VARCHAR(40)), CAST(ic.increment_value AS VARCHAR(40)) \
         FROM sys.columns c \
         JOIN sys.types tp ON c.user_type_id = tp.user_type_id \
         LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID(@P1) ORDER BY c.column_id"
    );
    let mut cq = tiberius::Query::new(cols_sql);
    cq.bind(table);
    let col_rows = cq.query(&mut entry.client).await
        .map_err(|e| format!("获取列信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取列信息失败: {e}"))?;
    if col_rows.is_empty() { return Err(format!("表无列信息: {table}")); }

    let mut lines: Vec<String> = Vec::new();
    for r in &col_rows {
        let name       = r.get::<&str, _>(0).unwrap_or("");
        let type_name  = r.get::<&str, _>(1).unwrap_or("");
        let max_length = r.get::<i16, _>(2).unwrap_or(0);
        let precision  = r.get::<u8, _>(3).unwrap_or(0);
        let scale      = r.get::<u8, _>(4).unwrap_or(0);
        let nullable   = r.get::<bool, _>(5).unwrap_or(true);
        let is_ident   = r.get::<bool, _>(6).unwrap_or(false);
        let default_def= r.get::<&str, _>(7);
        let seed       = r.get::<&str, _>(8);
        let inc        = r.get::<&str, _>(9);

        let type_sql = ss_format_coltype(type_name, max_length, precision, scale);
        let mut col = format!("  [{}] {}", name.replace(']', "]]"), type_sql);
        if is_ident {
            col.push_str(&format!(" IDENTITY({},{})", seed.unwrap_or("1"), inc.unwrap_or("1")));
        }
        col.push_str(if nullable { " NULL" } else { " NOT NULL" });
        if let Some(def) = default_def {
            if !def.is_empty() { col.push_str(&format!(" DEFAULT {def}")); }
        }
        lines.push(col);
    }

    // ③ 主键
    let pk_sql = format!(
        "{db_context}SELECT col.name FROM sys.indexes i \
         JOIN sys.index_columns ixc ON ixc.object_id = i.object_id AND ixc.index_id = i.index_id \
         JOIN sys.columns col ON col.object_id = i.object_id AND col.column_id = ixc.column_id \
         WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID(@P1) ORDER BY ixc.key_ordinal"
    );
    let mut pq = tiberius::Query::new(pk_sql);
    pq.bind(table);
    let pk_rows = pq.query(&mut entry.client).await
        .map_err(|e| format!("获取主键失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取主键失败: {e}"))?;
    let pk_cols: Vec<String> = pk_rows.iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| format!("[{}]", s.replace(']', "]]"))))
        .collect();
    if !pk_cols.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    let tbl_ref = if schema.is_empty() {
        format!("[{}]", table.replace(']', "]]"))
    } else {
        format!("[{}].[{}]", schema.replace(']', "]]"), table.replace(']', "]]"))
    };
    Ok(format!("CREATE TABLE {tbl_ref} (\n{}\n);", lines.join(",\n")))
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
pub async fn ss_update_cell(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    column: &str,
    new_value: Option<String>,
    pk_columns: &[String],
    pk_values: &[Option<String>],
    pool: &SsPool,
) -> Result<(), String> {
    let entry_arc = get_entry(id, pool, config, crate::keychain::get_password(id)?.as_deref()).await?;

    // T-SQL 标识符引用：[name]，内部 ] 转义为 ]]
    let q_br = |s: &str| format!("[{}]", s.replace(']', "]]"));

    let target = if schema.is_empty() {
        q_br(table)
    } else {
        format!("{}.{}", q_br(schema), q_br(table))
    };

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
            where_parts.push(format!("{} = @P{next_p}", q_br(c)));
            next_p += 1;
        } else {
            where_parts.push(format!("{} IS NULL", q_br(c)));
        }
    }

    let sql = format!("UPDATE {target} SET {set_part} WHERE {}", where_parts.join(" AND "));

    let mut entry = entry_arc.lock().await;

    let mut query = tiberius::Query::new(sql);
    if let Some(ref val) = new_value { query.bind(val.as_str()); }
    for v in pk_values {
        if let Some(ref pv) = v { query.bind(pv.as_str()); }
    }

    let result = query.execute(&mut entry.client).await
        .map_err(|e| format!("更新失败: {e}"))?;
    let affected = result.total();
    if affected == 0 { return Err("未找到匹配行（影响行数为 0），更新已取消".to_string()); }
    if affected > 1 { return Err(format!("安全拦截：条件匹配了 {affected} 行，拒绝多行更新")); }
    Ok(())
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
