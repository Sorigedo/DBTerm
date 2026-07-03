//! ClickHouse 原生 TCP 协议驱动（端口 9000，默认启用）
//!
//! 走 klickhouse crate 的原生二进制列式协议，吞吐与延迟优于 HTTP+JSON。
//! SSL 连接自动回退 HTTP(8123)，在 clickhouse.rs 的 use_tcp() 里判断。
//!
//! 连接池：每个连接 ID 缓存一个 klickhouse::Client（内部 channel-based，
//! Clone 共享同一条 TCP）。连接失败时自动重建，消除每次查询的 TCP 握手。
//!
//! 安全：密码取自 keychain，不进日志；标识符走白名单校验 + 单引号转义（纵深防御）。

use std::time::Instant;
use std::collections::HashMap;
use std::sync::Mutex;
use futures::StreamExt;
use klickhouse::{Client, ClientOptions, Value};

use crate::models::{ColumnInfo, ConnConfig, QueryResult, TableInfo};

// ── 协议选择 ────────────────────────────────────────────────────────────────

/// 是否对该连接走原生 TCP（默认是；SSL 时回退 HTTP，因为 klickhouse 暂不支持 TLS）。
pub fn use_tcp(config: &ConnConfig) -> bool {
    if config.use_ssl { return false; }
    // 显式设置 chProtocol="http" 才走 HTTP（主要供测试/兼容用）
    !config.extra_json.as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v["chProtocol"].as_str().map(|p| p.eq_ignore_ascii_case("http")))
        .unwrap_or(false)
}

// ── 连接池 ──────────────────────────────────────────────────────────────────

fn pool() -> &'static Mutex<HashMap<String, Client>> {
    static P: std::sync::OnceLock<Mutex<HashMap<String, Client>>> = std::sync::OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn invalidate(id: &str) {
    if let Ok(mut m) = pool().lock() { m.remove(id); }
}

async fn get_or_connect(config: &ConnConfig, password: Option<&str>) -> Result<Client, String> {
    // 先查池（clone 廉价，共享底层 TCP channel）
    if let Ok(m) = pool().lock() {
        if let Some(c) = m.get(&config.id) {
            return Ok(c.clone());
        }
    }
    // 建新连接
    let client = do_connect(config, password).await?;
    if let Ok(mut m) = pool().lock() {
        m.insert(config.id.clone(), client.clone());
    }
    Ok(client)
}

async fn do_connect(config: &ConnConfig, password: Option<&str>) -> Result<Client, String> {
    let host = config.host.as_deref().filter(|s| !s.is_empty()).unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(9000);
    let opts = ClientOptions {
        username: config.username.as_deref().filter(|s| !s.is_empty()).unwrap_or("default").to_string(),
        password: password.unwrap_or("").to_string(),
        default_database: config.database.as_deref().unwrap_or("").to_string(),
        tcp_nodelay: true,
    };
    Client::connect(format!("{host}:{port}"), opts).await
        .map_err(|e| format!("ClickHouse TCP 连接失败（{host}:{port}）：{e}"))
}

/// 带自动重连：第一次失败时驱逐旧连接再重试一次
async fn connect(config: &ConnConfig, password: Option<&str>) -> Result<Client, String> {
    match get_or_connect(config, password).await {
        Ok(c) => Ok(c),
        Err(e) => {
            // 可能是缓存的连接已断开，驱逐后重试
            invalidate(&config.id);
            get_or_connect(config, password).await.map_err(|e2| format!("{e} / 重连失败：{e2}"))
        }
    }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/// 单引号转义（安全拼入字符串字面量）
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// 标识符白名单校验（库名/表名只允许 ASCII 字母、数字、_ - .）
fn validate_ident(s: &str, label: &str) -> Result<(), String> {
    if s.is_empty() { return Err(format!("ClickHouse {label} 不能为空")); }
    if s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        Ok(())
    } else {
        Err(format!("ClickHouse {label} 包含非法字符：{s:?}"))
    }
}

/// 把 ClickHouse 原生 Value 转为表格展示用的纯文本（NULL → None）
fn value_to_string(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => return None,
        Value::Int8(x)   => x.to_string(),
        Value::Int16(x)  => x.to_string(),
        Value::Int32(x)  => x.to_string(),
        Value::Int64(x)  => x.to_string(),
        Value::Int128(x) => x.to_string(),
        Value::Int256(x) => format!("{x}"),
        Value::UInt8(x)   => x.to_string(),
        Value::UInt16(x)  => x.to_string(),
        Value::UInt32(x)  => x.to_string(),
        Value::UInt64(x)  => x.to_string(),
        Value::UInt128(x) => x.to_string(),
        Value::UInt256(x) => format!("{x}"),
        Value::Float32(x) => x.to_string(),
        Value::Float64(x) => x.to_string(),
        Value::Decimal32(..) | Value::Decimal64(..) | Value::Decimal128(..) => v.to_string(),
        Value::Decimal256(..) => "<decimal256>".to_string(), // Display 对该变体会 panic
        Value::String(b) => String::from_utf8(b.to_vec())
            .unwrap_or_else(|_| format!("0x{}", hex::encode(b))),
        Value::Uuid(u)   => u.to_string(),
        Value::Enum8(x)  => x.to_string(),
        Value::Enum16(x) => x.to_string(),
        Value::Date(_) | Value::DateTime(_) | Value::DateTime64(..) => clean_temporal(&v.to_string()),
        Value::Ipv4(_) | Value::Ipv6(_) => v.to_string().trim_matches('\'').to_string(),
        Value::Array(items) | Value::Tuple(items) => {
            let inner: Vec<String> = items.iter()
                .map(|i| value_to_string(i).unwrap_or_else(|| "NULL".to_string()))
                .collect();
            format!("[{}]", inner.join(", "))
        }
        Value::Map(keys, vals) => {
            let pairs: Vec<String> = keys.iter().zip(vals.iter())
                .map(|(k, val)| format!("{}: {}",
                    value_to_string(k).unwrap_or_default(),
                    value_to_string(val).unwrap_or_else(|| "NULL".to_string())))
                .collect();
            format!("{{{}}}", pairs.join(", "))
        }
        Value::Point(x)        => format!("{x:?}"),
        Value::Ring(x)         => format!("{x:?}"),
        Value::Polygon(x)      => format!("{x:?}"),
        Value::MultiPolygon(x) => format!("{x:?}"),
    })
}

/// 剥出可读时间串：parseDateTime[64]BestEffort('2024-..') → 2024-.. ；makeDate(y,m,d) → y-m-d
fn clean_temporal(s: &str) -> String {
    if let (Some(a), Some(b)) = (s.find('\''), s.rfind('\'')) {
        if b > a { return s[a + 1..b].to_string(); }
    }
    if let Some(inner) = s.strip_prefix("makeDate(").and_then(|x| x.strip_suffix(")")) {
        let p: Vec<&str> = inner.split(',').collect();
        if p.len() == 3 {
            return format!("{}-{:0>2}-{:0>2}", p[0].trim(), p[1].trim(), p[2].trim());
        }
    }
    s.to_string()
}

/// 执行 SQL，收集所有数据块为 (列名, 行)
async fn fetch(client: &Client, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    let mut stream = client.query_raw(sql).await
        .map_err(|e| format!("ClickHouse 查询失败：{e}"))?;
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    while let Some(block) = stream.next().await {
        let block = block.map_err(|e| format!("ClickHouse 读取数据块失败：{e}"))?;
        if columns.is_empty() && !block.column_types.is_empty() {
            columns = block.column_types.keys().cloned().collect();
        }
        for i in 0..block.rows as usize {
            let mut row = Vec::with_capacity(columns.len());
            for col in &columns {
                let cell = block.column_data.get(col).and_then(|vals| vals.get(i));
                row.push(cell.and_then(value_to_string));
            }
            rows.push(row);
        }
    }
    Ok((columns, rows))
}

// ── 公共 API ────────────────────────────────────────────────────────────────

pub async fn query(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<QueryResult, String> {
    let client = connect(config, password).await?;
    let start = Instant::now();
    let (columns, rows) = fetch(&client, sql).await?;
    Ok(QueryResult {
        rows_affected: if columns.is_empty() { 0 } else { rows.len() as u64 },
        is_select: !columns.is_empty(),
        columns,
        rows,
        execution_time_ms: start.elapsed().as_millis() as u64,
        truncated: false,
    })
}

pub async fn schemas(config: &ConnConfig, password: Option<&str>) -> Result<Vec<String>, String> {
    let client = connect(config, password).await?;
    let (_, rows) = fetch(&client, "SELECT name FROM system.databases ORDER BY name").await?;
    Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
}

pub async fn tables(config: &ConnConfig, password: Option<&str>, schema: &str) -> Result<Vec<TableInfo>, String> {
    validate_ident(schema, "database")?;
    let client = connect(config, password).await?;
    let sql = format!(
        "SELECT name, engine LIKE '%View' AS is_view FROM system.tables \
         WHERE database = '{}' ORDER BY name", esc(schema));
    let (_, rows) = fetch(&client, &sql).await?;
    Ok(rows.into_iter().filter_map(|r| {
        let name = r.first().cloned().flatten()?;
        let is_view = r.get(1).cloned().flatten().as_deref() == Some("1");
        Some(TableInfo { name, is_view })
    }).collect())
}

pub async fn columns(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    validate_ident(schema, "database")?;
    validate_ident(table, "table")?;
    let client = connect(config, password).await?;
    let sql = format!(
        "SELECT name, type, default_expression, is_in_primary_key FROM system.columns \
         WHERE database = '{}' AND table = '{}' ORDER BY position", esc(schema), esc(table));
    let (_, rows) = fetch(&client, &sql).await?;
    Ok(rows.into_iter().filter_map(|r| {
        let name = r.first().cloned().flatten()?;
        let data_type = r.get(1).cloned().flatten().unwrap_or_default();
        let default_value = r.get(2).cloned().flatten().filter(|s| !s.is_empty());
        let pk = r.get(3).cloned().flatten().as_deref() == Some("1");
        Some(ColumnInfo {
            nullable: data_type.starts_with("Nullable("),
            key: if pk { "PRI".into() } else { String::new() },
            default_value,
            data_type,
            name,
        })
    }).collect())
}

pub async fn test(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    let client = connect(config, password).await?;
    let (_, rows) = fetch(&client, "SELECT 1 AS ok").await?;
    if rows.first().and_then(|r| r.first()).and_then(|c| c.as_deref()) == Some("1") {
        Ok("ClickHouse 连接成功（原生 TCP）".to_string())
    } else {
        Err("ClickHouse 响应异常".to_string())
    }
}
