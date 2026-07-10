//! ClickHouse 驱动（HTTP 回退层）
//!
//! 默认走 clickhouse_tcp（原生二进制协议，9000）；仅当连接开启 SSL 时自动回退此 HTTP 实现。
//! 安全：认证走 X-ClickHouse-User/Key 请求头（不进 URL，避免日志泄漏）；
//! 元数据查询全部使用 ClickHouse 原生参数绑定（{name:String}），杜绝拼接注入。

use std::time::Instant;
use serde::Serialize;
use tauri::State;
use crate::models::{ColumnInfo, ConnConfig, ConnType, QueryResult, TableInfo};
use crate::storage::StorageState;

pub(crate) fn base_url(config: &ConnConfig) -> String {
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(8123);
    let scheme = if config.use_ssl { "https" } else { "http" };
    format!("{scheme}://{host}:{port}/")
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    // 复用单个 reqwest::Client（内部按 host 维护 keep-alive 连接池），避免每次查询重建 → 每查询一次 TCP/TLS 握手。
    // Client::clone 很廉价（内部 Arc）；不同 ClickHouse 主机共享同一 Client 也安全（按 host 分池）。
    use std::sync::OnceLock;
    static SHARED: OnceLock<reqwest::Client> = OnceLock::new();
    Ok(SHARED.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }).clone())
}

/// 执行 SQL，返回 ClickHouse JSON 格式响应；params 走原生参数绑定
async fn raw_query(
    config: &ConnConfig,
    password: Option<&str>,
    sql: &str,
    params: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let mut req = client()?
        .post(base_url(config))
        .query(&[("default_format", "JSON")])
        .header("X-ClickHouse-User", config.username.as_deref().unwrap_or("default"));
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        req = req.header("X-ClickHouse-Key", p);
    }
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        req = req.query(&[("database", db)]);
    }
    for (k, v) in params {
        req = req.query(&[(format!("param_{k}"), *v)]);
    }

    let resp = req.body(sql.to_string()).send().await
        .map_err(|e| format!("ClickHouse 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取 ClickHouse 响应失败: {e}"))?;
    if !status.is_success() {
        // 401/403 给友好提示，其余原样透出服务器错误
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("ClickHouse 认证失败，请检查用户名和密码：{}", text.trim()));
        }
        return Err(format!("ClickHouse 错误（HTTP {}）：{}", status.as_u16(), text.trim()));
    }
    if text.trim().is_empty() {
        // DDL / INSERT 成功时无响应体
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析 ClickHouse 响应失败: {e}"))
}

fn cell_to_string(v: &serde_json::Value) -> Option<String> {
    if v.is_null() { return None; }
    if let Some(s) = v.as_str() { return Some(s.to_string()); }
    Some(v.to_string())
}

pub async fn query(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<QueryResult, String> {
    // 原生 TCP 开关：仅 chProtocol="tcp" 时走 TCP，否则保持原 HTTP 实现不变
    if super::clickhouse_tcp::use_tcp(config) {
        return super::clickhouse_tcp::query(config, password, sql).await;
    }
    let started = Instant::now();
    let v = raw_query(config, password, sql, &[]).await?;

    let columns: Vec<String> = v["meta"].as_array()
        .map(|m| m.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let rows: Vec<Vec<Option<String>>> = v["data"].as_array()
        .map(|arr| arr.iter()
            .map(|row| columns.iter().map(|c| cell_to_string(&row[c.as_str()])).collect())
            .collect())
        .unwrap_or_default();

    Ok(QueryResult {
        rows_affected: if columns.is_empty() { 0 } else { rows.len() as u64 },
        is_select: !columns.is_empty(),
        columns,
        rows,
        execution_time_ms: started.elapsed().as_millis() as u64,
        truncated: false,
    })
}

pub async fn schemas(config: &ConnConfig, password: Option<&str>) -> Result<Vec<String>, String> {
    if super::clickhouse_tcp::use_tcp(config) {
        return super::clickhouse_tcp::schemas(config, password).await;
    }
    let v = raw_query(config, password,
        "SELECT name FROM system.databases ORDER BY name", &[]).await?;
    Ok(v["data"].as_array().map(|arr| {
        arr.iter().filter_map(|r| r["name"].as_str().map(String::from)).collect()
    }).unwrap_or_default())
}

pub async fn tables(config: &ConnConfig, password: Option<&str>, schema: &str) -> Result<Vec<TableInfo>, String> {
    if super::clickhouse_tcp::use_tcp(config) {
        return super::clickhouse_tcp::tables(config, password, schema).await;
    }
    let v = raw_query(config, password,
        "SELECT name, engine LIKE '%View' AS is_view FROM system.tables \
         WHERE database = {db:String} ORDER BY name",
        &[("db", schema)]).await?;
    Ok(v["data"].as_array().map(|arr| {
        arr.iter().filter_map(|r| Some(TableInfo {
            name: r["name"].as_str()?.to_string(),
            is_view: r["is_view"].as_u64().unwrap_or(0) == 1
                || r["is_view"].as_str() == Some("1"),
        })).collect()
    }).unwrap_or_default())
}

pub async fn columns(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    if super::clickhouse_tcp::use_tcp(config) {
        return super::clickhouse_tcp::columns(config, password, schema, table).await;
    }
    let v = raw_query(config, password,
        "SELECT name, type, default_expression, is_in_primary_key FROM system.columns \
         WHERE database = {db:String} AND table = {t:String} ORDER BY position",
        &[("db", schema), ("t", table)]).await?;
    Ok(v["data"].as_array().map(|arr| {
        arr.iter().filter_map(|r| {
            let data_type = r["type"].as_str().unwrap_or("").to_string();
            let pk = r["is_in_primary_key"].as_u64().unwrap_or(0) == 1
                || r["is_in_primary_key"].as_str() == Some("1");
            Some(ColumnInfo {
                name: r["name"].as_str()?.to_string(),
                nullable: data_type.starts_with("Nullable("),
                key: if pk { "PRI".into() } else { String::new() },
                default_value: r["default_expression"].as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                data_type,
            })
        }).collect()
    }).unwrap_or_default())
}

/// 连接测试：SELECT 1
pub async fn test(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    if super::clickhouse_tcp::use_tcp(config) {
        return super::clickhouse_tcp::test(config, password).await;
    }
    let v = raw_query(config, password, "SELECT 1 AS ok", &[]).await?;
    let ok = v["data"].as_array()
        .and_then(|a| a.first())
        .map(|r| !r["ok"].is_null())
        .unwrap_or(false);
    if ok {
        Ok("ClickHouse 连接成功".to_string())
    } else {
        Err("ClickHouse 响应异常".to_string())
    }
}

fn load_conn(id: &str, storage: &State<'_, StorageState>) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().map_err(|_| "存储锁失败".to_string())?.load()?;
    let config = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

// ── 可选增强 CH3: Kafka / RabbitMQ 引擎消费者状态 ────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChKafkaConsumer {
    pub database: String,
    pub table: String,
    pub consumer_id: String,
    pub last_exception_time: String,
    pub last_exception: String,
    pub last_poll_time: String,
    pub num_messages_read: u64,
    pub num_bytes_read: u64,
    pub num_commits: u64,
    pub num_rebalances: u64,
}

/// CH3: 查询 system.kafka_consumers（ClickHouse 22.3+）
/// Kafka/RabbitMQ 引擎表的消费者状态；若视图不存在则返回空列表（graceful）
#[tauri::command]
pub async fn ch_kafka_consumers(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<ChKafkaConsumer>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::ClickHouse) {
        return Err("此命令仅适用于 ClickHouse 连接".to_string());
    }

    let sql = "SELECT \
        database, table, consumer_id,
        toString(last_exception_time) AS last_exception_time,
        last_exception,
        toString(last_poll_time) AS last_poll_time,
        num_messages_read, num_bytes_read,
        num_commits, num_rebalances
    FROM system.kafka_consumers
    ORDER BY database, table, consumer_id";

    let v = match raw_query(&config, password.as_deref(), sql, &[]).await {
        Ok(v) => v,
        Err(e) => {
            // ClickHouse < 22.3 该系统表不存在才降级；不可用表名子串匹配，否则会吞掉超时/权限等真实错误
            if e.contains("UNKNOWN_TABLE") || e.contains("doesn't exist") {
                return Ok(vec![]);
            }
            return Err(e);
        }
    };

    Ok(v["data"].as_array().map(|arr| {
        arr.iter().filter_map(|r| Some(ChKafkaConsumer {
            database:            r["database"].as_str()?.to_string(),
            table:               r["table"].as_str()?.to_string(),
            consumer_id:         r["consumer_id"].as_str()?.to_string(),
            last_exception_time: r["last_exception_time"].as_str().unwrap_or("").to_string(),
            last_exception:      r["last_exception"].as_str().unwrap_or("").to_string(),
            last_poll_time:      r["last_poll_time"].as_str().unwrap_or("").to_string(),
            num_messages_read:   r["num_messages_read"].as_str()
                .and_then(|s| s.parse().ok()).unwrap_or(0),
            num_bytes_read:      r["num_bytes_read"].as_str()
                .and_then(|s| s.parse().ok()).unwrap_or(0),
            num_commits:         r["num_commits"].as_str()
                .and_then(|s| s.parse().ok()).unwrap_or(0),
            num_rebalances:      r["num_rebalances"].as_str()
                .and_then(|s| s.parse().ok()).unwrap_or(0),
        })).collect()
    }).unwrap_or_default())
}

// ── 可选增强 CH1: S3/HDFS 外部表查询助手 ─────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChExternalTable {
    pub database: String,
    pub name: String,
    pub engine: String,
    pub engine_full: String,
    pub create_table_query: String,
}

/// CH1+: 列出 S3/HDFS/URL 引擎的外部表（system.tables WHERE engine LIKE 'S3%'）
#[tauri::command]
pub async fn ch_external_tables(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<ChExternalTable>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::ClickHouse) {
        return Err("此命令仅适用于 ClickHouse 连接".to_string());
    }

    let sql = "SELECT database, name, engine, engine_full,
        SUBSTRING(create_table_query, 1, 2000) AS create_table_query
    FROM system.tables
    WHERE engine IN ('S3','S3Queue','HDFS','URL','AzureBlobStorage','AzureQueue',
                     'DeltaLake','Iceberg','Hudi','Hive')
       OR engine LIKE 'S3%' OR engine LIKE 'HDFS%'
    ORDER BY database, name";

    let v = raw_query(&config, password.as_deref(), sql, &[]).await?;

    Ok(v["data"].as_array().map(|arr| {
        arr.iter().filter_map(|r| Some(ChExternalTable {
            database:           r["database"].as_str()?.to_string(),
            name:               r["name"].as_str()?.to_string(),
            engine:             r["engine"].as_str().unwrap_or("").to_string(),
            engine_full:        r["engine_full"].as_str().unwrap_or("").to_string(),
            create_table_query: r["create_table_query"].as_str().unwrap_or("").to_string(),
        })).collect()
    }).unwrap_or_default())
}

// ── 可选增强 CH3.1: 物化视图链路血缘 ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChLineageNode {
    pub id: String,        // database.name
    pub database: String,
    pub name: String,
    pub engine: String,
    pub is_mv: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChLineageEdge {
    pub from: String,   // 上游表 id
    pub to: String,     // 下游（依赖方）id
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChLineage {
    pub nodes: Vec<ChLineageNode>,
    pub edges: Vec<ChLineageEdge>,
}

/// CH3.1: 物化视图数据血缘（source → MV/下游表）
/// 基于 system.tables 的 dependencies_database/table（"依赖当前表的下游对象"）构建有向图，
/// 只返回 MV 及与其相连的节点，前端自绘 DAG。
#[tauri::command]
pub async fn ch_mv_lineage(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<ChLineage, String> {
    use std::collections::{HashMap, HashSet};
    let (config, password) = load_conn(&id, &storage)?;
    if !matches!(config.conn_type, ConnType::ClickHouse) {
        return Err("此命令仅适用于 ClickHouse 连接".to_string());
    }

    let sql = "SELECT database, name, engine, dependencies_database, dependencies_table \
        FROM system.tables \
        WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') \
        ORDER BY database, name";
    let v = raw_query(&config, password.as_deref(), sql, &[]).await?;

    let data = v["data"].as_array().cloned().unwrap_or_default();
    let mut all_nodes: HashMap<String, ChLineageNode> = HashMap::new();
    let mut edges: Vec<ChLineageEdge> = Vec::new();
    let mut mv_ids: HashSet<String> = HashSet::new();

    for r in &data {
        let db = r["database"].as_str().unwrap_or("");
        let name = r["name"].as_str().unwrap_or("");
        if db.is_empty() || name.is_empty() { continue; }
        let engine = r["engine"].as_str().unwrap_or("").to_string();
        let node_id = format!("{db}.{name}");
        let is_mv = engine.contains("MaterializedView");
        if is_mv { mv_ids.insert(node_id.clone()); }
        all_nodes.entry(node_id.clone()).or_insert(ChLineageNode {
            id: node_id.clone(), database: db.to_string(), name: name.to_string(), engine, is_mv,
        });
        // dependencies：依赖当前表的下游对象（数据从当前表流向它们）
        let dep_dbs = r["dependencies_database"].as_array();
        let dep_tbls = r["dependencies_table"].as_array();
        if let (Some(dbs), Some(tbls)) = (dep_dbs, dep_tbls) {
            for (ddb, dtbl) in dbs.iter().zip(tbls.iter()) {
                let (ddb, dtbl) = (ddb.as_str().unwrap_or(""), dtbl.as_str().unwrap_or(""));
                if ddb.is_empty() || dtbl.is_empty() { continue; }
                edges.push(ChLineageEdge { from: node_id.clone(), to: format!("{ddb}.{dtbl}") });
            }
        }
    }

    // 只保留与 MV 相连（直接相邻）的节点，避免返回整库无关表
    let mut keep: HashSet<String> = mv_ids.clone();
    for e in &edges {
        if mv_ids.contains(&e.from) || mv_ids.contains(&e.to) {
            keep.insert(e.from.clone());
            keep.insert(e.to.clone());
        }
    }
    let edges: Vec<ChLineageEdge> = edges.into_iter()
        .filter(|e| keep.contains(&e.from) && keep.contains(&e.to))
        .collect();
    // 补齐边引用但 system.tables 未列出的节点（如外部目标表）
    for e in &edges {
        for nid in [&e.from, &e.to] {
            if !all_nodes.contains_key(nid) {
                let (d, n) = nid.split_once('.').unwrap_or(("", nid.as_str()));
                all_nodes.insert(nid.clone(), ChLineageNode {
                    id: nid.clone(), database: d.to_string(), name: n.to_string(),
                    engine: String::new(), is_mv: false,
                });
            }
        }
    }
    let nodes: Vec<ChLineageNode> = all_nodes.into_values()
        .filter(|n| keep.contains(&n.id))
        .collect();

    Ok(ChLineage { nodes, edges })
}
