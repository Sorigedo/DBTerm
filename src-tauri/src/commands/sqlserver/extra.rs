// MS5.x: SQL Server 专业 DBA 补强（CDC / Resource Governor / 链接服务器等）
use serde::Serialize;
use tauri::State;

use super::{SsPool, load_conn};
use crate::storage::StorageState;

// ── MS5.1: 变更数据捕获（CDC）与变更跟踪（CT）状态 ──────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsCdcStatus {
    pub database_name: String,
    pub cdc_enabled: bool,
    pub ct_enabled: bool,
    pub cdc_tables: Vec<SsCdcTable>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsCdcTable {
    pub capture_instance: String,
    pub source_schema: String,
    pub source_table: String,
    pub start_lsn: String,
    pub job_type: String,
}

/// MS5.1: CDC / Change Tracking 状态（当前数据库）
#[tauri::command]
pub async fn ss_cdc_status(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsCdcStatus, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // CDC 与 CT 开启状态
    let rows = entry.client.simple_query(
        "SELECT d.name,
                CAST(d.is_cdc_enabled AS INT) AS cdc_enabled,
                CAST(ISNULL(ct.is_auto_cleanup_on, 0) AS INT) AS ct_enabled
         FROM sys.databases d
         LEFT JOIN sys.change_tracking_databases ct ON d.database_id = ct.database_id
         WHERE d.database_id = DB_ID()"
    ).await.map_err(|e| format!("查询 CDC/CT 状态失败: {e}"))?
        .into_first_result().await.unwrap_or_default();

    let (db_name, cdc_enabled, ct_enabled) = rows.first().map(|r| (
        r.get::<&str, _>(0).unwrap_or("").to_string(),
        r.get::<i32, _>(1).unwrap_or(0) != 0,
        r.get::<i32, _>(2).unwrap_or(0) != 0,
    )).unwrap_or_default();

    // CDC 捕获实例
    let cdc_rows = entry.client.simple_query(
        "SELECT capture_instance, source_schema, source_name,
                ISNULL(CONVERT(VARCHAR(64), start_lsn, 1), '') AS start_lsn,
                ISNULL(object_name(object_id), '') AS job_type
         FROM cdc.change_tables ORDER BY source_schema, source_name"
    ).await;

    let cdc_tables: Vec<SsCdcTable> = match cdc_rows {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default()
            .iter().map(|r| SsCdcTable {
                capture_instance: r.get::<&str, _>(0).unwrap_or("").to_string(),
                source_schema:    r.get::<&str, _>(1).unwrap_or("").to_string(),
                source_table:     r.get::<&str, _>(2).unwrap_or("").to_string(),
                start_lsn:        r.get::<&str, _>(3).unwrap_or("").to_string(),
                job_type:         r.get::<&str, _>(4).unwrap_or("").to_string(),
            }).collect(),
        Err(_) => vec![],  // CDC 未启用则 cdc schema 不存在
    };

    Ok(SsCdcStatus { database_name: db_name, cdc_enabled, ct_enabled, cdc_tables })
}

// ── MS5.2: Resource Governor ──────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsResourcePool {
    pub pool_name: String,
    pub is_default: bool,
    pub min_cpu_pct: i32,
    pub max_cpu_pct: i32,
    pub min_memory_pct: i32,
    pub max_memory_pct: i32,
    pub used_memory_kb: i64,
    pub workgroup_count: i32,
}

/// MS5.2: Resource Governor 资源池状态
#[tauri::command]
pub async fn ss_resource_pools(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsResourcePool>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // used_memory_kb 是 sys.dm_resource_governor_resource_pools 自身的列，无需自连接
    let sql = "\
SELECT p.name AS pool_name, p.is_default,
       p.min_cpu_percent, p.max_cpu_percent,
       p.min_memory_percent, p.max_memory_percent,
       ISNULL(p.used_memory_kb, 0) AS used_memory_kb,
       (SELECT COUNT(*) FROM sys.dm_resource_governor_workload_groups wg WHERE wg.pool_id = p.pool_id) AS workgroup_count
FROM sys.dm_resource_governor_resource_pools p
ORDER BY p.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询资源池失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取资源池失败: {e}"))?;

    Ok(rows.iter().map(|r| SsResourcePool {
        pool_name:       r.get::<&str, _>(0).unwrap_or("").to_string(),
        is_default:      r.get::<bool, _>(1).unwrap_or(false),
        min_cpu_pct:     r.get::<i32, _>(2).unwrap_or(0),
        max_cpu_pct:     r.get::<i32, _>(3).unwrap_or(100),
        min_memory_pct:  r.get::<i32, _>(4).unwrap_or(0),
        max_memory_pct:  r.get::<i32, _>(5).unwrap_or(100),
        used_memory_kb:  r.get::<i64, _>(6).unwrap_or(0),
        workgroup_count: r.get::<i32, _>(7).unwrap_or(0),
    }).collect())
}

// ── MS5.4: 链接服务器 ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsLinkedServer {
    pub server_name: String,
    pub product: String,
    pub provider: String,
    pub data_source: Option<String>,
    pub is_linked: bool,
    pub is_remote_login_enabled: bool,
    pub is_rpc_out_enabled: bool,
    pub modify_date: String,
}

/// MS5.4: 链接服务器列表（sys.servers）
#[tauri::command]
pub async fn ss_linked_servers(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsLinkedServer>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s.name, s.product, s.provider, s.data_source,
       s.is_linked, s.is_remote_login_enabled, s.is_rpc_out_enabled,
       ISNULL(CONVERT(VARCHAR(23), s.modify_date, 120), '') AS modify_date
FROM sys.servers s
WHERE s.server_id > 0   -- 排除本地服务器
ORDER BY s.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询链接服务器失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取链接服务器失败: {e}"))?;

    Ok(rows.iter().map(|r| SsLinkedServer {
        server_name:              r.get::<&str, _>(0).unwrap_or("").to_string(),
        product:                  r.get::<&str, _>(1).unwrap_or("").to_string(),
        provider:                 r.get::<&str, _>(2).unwrap_or("").to_string(),
        data_source:              r.get::<&str, _>(3).map(|s| s.to_string()),
        is_linked:                r.get::<bool, _>(4).unwrap_or(false),
        is_remote_login_enabled:  r.get::<bool, _>(5).unwrap_or(false),
        is_rpc_out_enabled:       r.get::<bool, _>(6).unwrap_or(false),
        modify_date:              r.get::<&str, _>(7).unwrap_or("").to_string(),
    }).collect())
}

// ── MS5.5: Service Broker ──────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsBrokerQueue {
    pub schema_name: String,
    pub queue_name: String,
    pub is_receive_enabled: bool,
    pub is_enqueue_enabled: bool,
    pub message_count: i64,
    pub activation_proc: Option<String>,
}

/// MS5.5: Service Broker 队列状态与消息堆积
#[tauri::command]
pub async fn ss_broker_queues(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsBrokerQueue>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 先检查当前库是否启用 Service Broker
    let sb_rows = entry.client.simple_query(
        "SELECT CAST(is_broker_enabled AS INT) FROM sys.databases WHERE database_id = DB_ID()"
    ).await.map_err(|e| format!("查询 Broker 状态失败: {e}"))?
        .into_first_result().await.unwrap_or_default();

    let broker_enabled = sb_rows.first().and_then(|r| r.get::<i32, _>(0)).unwrap_or(0) != 0;
    if !broker_enabled {
        return Ok(vec![]);
    }

    let sql = "\
SELECT s.name AS schema_name, q.name AS queue_name,
       q.is_receive_enabled, q.is_enqueue_enabled,
       ISNULL((SELECT SUM(message_count) FROM sys.transmission_queue WHERE from_service_name IN (
           SELECT name FROM sys.services sv WHERE sv.service_queue_id = q.object_id
       )), 0) AS message_count,
       OBJECT_NAME(q.activation_procedure) AS activation_proc
FROM sys.service_queues q
JOIN sys.schemas s ON q.schema_id = s.schema_id
WHERE q.is_ms_shipped = 0
ORDER BY s.name, q.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询 Broker 队列失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取 Broker 队列失败: {e}"))?;

    Ok(rows.iter().map(|r| SsBrokerQueue {
        schema_name:          r.get::<&str, _>(0).unwrap_or("").to_string(),
        queue_name:           r.get::<&str, _>(1).unwrap_or("").to_string(),
        is_receive_enabled:   r.get::<bool, _>(2).unwrap_or(false),
        is_enqueue_enabled:   r.get::<bool, _>(3).unwrap_or(false),
        message_count:        r.get::<i64, _>(4).unwrap_or(0),
        activation_proc:      r.get::<&str, _>(5).map(|s| s.to_string()),
    }).collect())
}

// ── 可选增强: Query Store (MS1.2+) ───────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsQueryStorePlan {
    pub query_id: i64,
    pub plan_id: i64,
    pub query_text: String,
    pub is_forced: bool,
    pub last_execution_time: String,
    pub avg_duration_ms: f64,
    pub avg_logical_reads: f64,
    pub execution_count: i64,
}

/// MS1.2+ Query Store: 列出计划（forced_only=true 仅返回被强制的计划）
#[tauri::command]
pub async fn ss_query_store_plans(
    id: String,
    top_n: Option<i32>,
    forced_only: Option<bool>,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsQueryStorePlan>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let n = top_n.unwrap_or(50).clamp(1, 500);
    let forced_filter = if forced_only.unwrap_or(false) { "WHERE p.is_forced_plan = 1" } else { "" };
    let sql = format!("\
SELECT TOP {n}
    q.query_id, p.plan_id,
    SUBSTRING(qt.query_sql_text, 1, 600) AS query_text,
    CAST(p.is_forced_plan AS INT) AS is_forced,
    ISNULL(CONVERT(VARCHAR(23), p.last_execution_time, 120), '') AS last_exec_time,
    ISNULL(rs.avg_dur_ms, 0.0) AS avg_duration_ms,
    ISNULL(rs.avg_reads, 0.0) AS avg_logical_reads,
    ISNULL(rs.exec_count, 0) AS execution_count
FROM sys.query_store_plan p
JOIN sys.query_store_query q ON p.query_id = q.query_id
JOIN sys.query_store_query_text qt ON q.query_text_id = qt.query_text_id
LEFT JOIN (
    SELECT plan_id,
           AVG(CAST(avg_duration AS FLOAT)) / 1000.0 AS avg_dur_ms,
           AVG(CAST(avg_logical_io_reads AS FLOAT)) AS avg_reads,
           SUM(count_executions) AS exec_count
    FROM sys.query_store_runtime_stats
    GROUP BY plan_id
) rs ON p.plan_id = rs.plan_id
{forced_filter}
ORDER BY rs.exec_count DESC");

    let rows = match entry.client.simple_query(&sql).await {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default(),
        Err(e) => {
            let msg = e.to_string();
            // Query Store 可能未启用
            if msg.contains("query_store") || msg.contains("111233") {
                return Ok(vec![]);
            }
            return Err(format!("查询 Query Store 失败: {msg}"));
        }
    };

    Ok(rows.iter().map(|r| SsQueryStorePlan {
        query_id:            r.get::<i64, _>(0).unwrap_or(0),
        plan_id:             r.get::<i64, _>(1).unwrap_or(0),
        query_text:          r.get::<&str, _>(2).unwrap_or("").to_string(),
        is_forced:           r.get::<i32, _>(3).unwrap_or(0) != 0,
        last_execution_time: r.get::<&str, _>(4).unwrap_or("").to_string(),
        avg_duration_ms:     r.get::<f64, _>(5).unwrap_or(0.0),
        avg_logical_reads:   r.get::<f64, _>(6).unwrap_or(0.0),
        execution_count:     r.get::<i64, _>(7).unwrap_or(0),
    }).collect())
}

/// MS1.2+ Query Store: 强制执行计划（强确认由前端保证）
#[tauri::command]
pub async fn ss_force_plan(
    id: String,
    query_id: i64,
    plan_id: i64,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<(), String> {
    if query_id <= 0 || plan_id <= 0 {
        return Err("query_id 和 plan_id 必须大于 0".to_string());
    }
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = format!("EXEC sp_query_store_force_plan @query_id = {query_id}, @plan_id = {plan_id}");
    entry.client.simple_query(&sql).await
        .map_err(|e| format!("强制计划失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("强制计划读取失败: {e}"))?;
    Ok(())
}

/// MS1.2+ Query Store: 取消强制执行计划
#[tauri::command]
pub async fn ss_unforce_plan(
    id: String,
    query_id: i64,
    plan_id: i64,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<(), String> {
    if query_id <= 0 || plan_id <= 0 {
        return Err("query_id 和 plan_id 必须大于 0".to_string());
    }
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = format!("EXEC sp_query_store_unforce_plan @query_id = {query_id}, @plan_id = {plan_id}");
    entry.client.simple_query(&sql).await
        .map_err(|e| format!("取消强制计划失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("取消强制计划读取失败: {e}"))?;
    Ok(())
}

// ── 可选增强: 缺失索引一键脚本 (MS2.2+) ────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsMissingIndexScript {
    pub index_handle: i32,
    pub table_name: String,
    pub create_index_sql: String,
    pub estimated_improvement_pct: f64,
    pub user_seeks: i64,
    pub user_scans: i64,
}

/// MS2.2+ 缺失索引: 生成 CREATE INDEX 脚本（只读，脚本由前端复制执行）
#[tauri::command]
pub async fn ss_missing_index_scripts(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsMissingIndexScript>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT TOP 30
    mid.index_handle,
    mid.statement AS full_table_name,
    ISNULL(mid.equality_columns, '') AS eq_cols,
    ISNULL(mid.inequality_columns, '') AS ineq_cols,
    ISNULL(mid.included_columns, '') AS inc_cols,
    CAST(migs.avg_total_user_cost * migs.avg_user_impact AS FLOAT) AS estimated_improvement,
    migs.user_seeks, migs.user_scans
FROM sys.dm_db_missing_index_groups mig
JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
WHERE mid.database_id = DB_ID()
ORDER BY estimated_improvement DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询缺失索引失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取缺失索引失败: {e}"))?;

    let mut result = Vec::new();
    for r in &rows {
        let handle = r.get::<i32, _>(0).unwrap_or(0);
        let full_table = r.get::<&str, _>(1).unwrap_or("").to_string();
        let eq_cols = r.get::<&str, _>(2).unwrap_or("").to_string();
        let ineq_cols = r.get::<&str, _>(3).unwrap_or("").to_string();
        let inc_cols = r.get::<&str, _>(4).unwrap_or("").to_string();
        let improvement = r.get::<f64, _>(5).unwrap_or(0.0);
        let seeks = r.get::<i64, _>(6).unwrap_or(0);
        let scans = r.get::<i64, _>(7).unwrap_or(0);

        // mid.statement 形如 [db].[schema].[table]，CREATE INDEX 的 ON 子句不能带库名，
        // 取后两段 [schema].[table]
        let seg: Vec<&str> = full_table.split('.').collect();
        let on_table = if seg.len() >= 2 {
            seg[seg.len() - 2..].join(".")
        } else {
            full_table.clone()
        };
        let table_short = full_table.split('.').last().unwrap_or(&full_table).trim_matches(['[', ']']);
        let mut key_cols = eq_cols.clone();
        if !ineq_cols.is_empty() {
            if key_cols.is_empty() { key_cols = ineq_cols.clone(); }
            else { key_cols = format!("{key_cols}, {ineq_cols}"); }
        }
        let idx_name = format!("IX_{}_MissingIdx_{handle}", table_short.replace(' ', "_"));
        let include_clause = if inc_cols.is_empty() {
            String::new()
        } else {
            format!("\nINCLUDE ({inc_cols})")
        };
        let sql_script = format!(
            "CREATE INDEX [{idx_name}]\nON {on_table} ({key_cols}){include_clause};"
        );

        result.push(SsMissingIndexScript {
            index_handle: handle,
            table_name: full_table,
            create_index_sql: sql_script,
            estimated_improvement_pct: improvement,
            user_seeks: seeks,
            user_scans: scans,
        });
    }
    Ok(result)
}

// ── 可选增强: Extended Events 会话列表 (MS1+) ────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsXeSession {
    pub name: String,
    pub status: String,
    pub create_time: String,
    pub pending_buffers: i32,
    pub total_buffers: i32,
    pub total_buffer_mb: f64,
    pub dropped_event_count: i64,
    pub event_count: i32,
}

/// MS1+ Extended Events: 列出 XE 会话（只读）
#[tauri::command]
pub async fn ss_xe_sessions(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsXeSession>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s.name,
       CASE s.status WHEN 0 THEN 'STOPPED' WHEN 1 THEN 'STARTED' ELSE 'UNKNOWN' END AS status,
       ISNULL(CONVERT(VARCHAR(23), s.create_time, 120), '') AS create_time,
       s.pending_buffers, s.total_buffers,
       CAST(s.total_buffer_size AS FLOAT) / 1048576.0 AS total_buffer_mb,
       s.dropped_event_count,
       (SELECT COUNT(*) FROM sys.dm_xe_session_events e
        WHERE e.event_session_address = s.address) AS event_count
FROM sys.dm_xe_sessions s
ORDER BY s.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询 XE 会话失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取 XE 会话失败: {e}"))?;

    Ok(rows.iter().map(|r| SsXeSession {
        name:                r.get::<&str, _>(0).unwrap_or("").to_string(),
        status:              r.get::<&str, _>(1).unwrap_or("").to_string(),
        create_time:         r.get::<&str, _>(2).unwrap_or("").to_string(),
        pending_buffers:     r.get::<i32, _>(3).unwrap_or(0),
        total_buffers:       r.get::<i32, _>(4).unwrap_or(0),
        total_buffer_mb:     r.get::<f64, _>(5).unwrap_or(0.0),
        dropped_event_count: r.get::<i64, _>(6).unwrap_or(0),
        event_count:         r.get::<i32, _>(7).unwrap_or(0),
    }).collect())
}

// ── 可选增强: Azure SQL DTU/vCore 指标 (MS1.5+) ──────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsAzureMetrics {
    pub is_azure: bool,
    pub engine_edition: i32,
    pub dtu_limit: Option<i32>,
    pub dtu_used: Option<f64>,
    pub cpu_percent: Option<f64>,
    pub data_io_percent: Option<f64>,
    pub log_write_percent: Option<f64>,
    pub storage_percent: Option<f64>,
    pub workers_percent: Option<f64>,
    pub sessions_percent: Option<f64>,
}

/// MS1.5+ Azure SQL: DTU/vCore 使用率（本地 SQL Server 返回 is_azure=false）
#[tauri::command]
pub async fn ss_azure_metrics(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsAzureMetrics, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 检测 EngineEdition：5=Azure SQL DB，8=Azure SQL MI，其他=本地
    let ee_rows = entry.client.simple_query(
        "SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT) AS ee"
    ).await.map_err(|e| format!("查询 EngineEdition 失败: {e}"))?
        .into_first_result().await.unwrap_or_default();

    let engine_edition = ee_rows.first()
        .and_then(|r| r.get::<i32, _>(0))
        .unwrap_or(2);

    // EngineEdition 5=Azure SQL Database, 8=Azure SQL Managed Instance
    if engine_edition != 5 && engine_edition != 8 {
        return Ok(SsAzureMetrics { is_azure: false, engine_edition, ..Default::default() });
    }

    // Azure SQL 专有视图 sys.dm_db_resource_stats（每 15 秒一行历史，最近一行）
    let metrics_rows = entry.client.simple_query("\
SELECT TOP 1
    CAST(ISNULL(dtu_limit, 0) AS INT) AS dtu_limit,
    CAST(ISNULL(dtu_used, 0) AS FLOAT) AS dtu_used,
    CAST(ISNULL(avg_cpu_percent, 0) AS FLOAT) AS cpu_pct,
    CAST(ISNULL(avg_data_io_percent, 0) AS FLOAT) AS data_io_pct,
    CAST(ISNULL(avg_log_write_percent, 0) AS FLOAT) AS log_write_pct,
    CAST(ISNULL(avg_storage_percent, 0) AS FLOAT) AS storage_pct,
    CAST(ISNULL(max_worker_percent, 0) AS FLOAT) AS workers_pct,
    CAST(ISNULL(max_session_percent, 0) AS FLOAT) AS sessions_pct
FROM sys.dm_db_resource_stats
ORDER BY end_time DESC"
    ).await;

    match metrics_rows {
        Ok(stream) => {
            let rows = stream.into_first_result().await.unwrap_or_default();
            if let Some(r) = rows.first() {
                Ok(SsAzureMetrics {
                    is_azure: true,
                    engine_edition,
                    dtu_limit:        Some(r.get::<i32, _>(0).unwrap_or(0)),
                    dtu_used:         Some(r.get::<f64, _>(1).unwrap_or(0.0)),
                    cpu_percent:      Some(r.get::<f64, _>(2).unwrap_or(0.0)),
                    data_io_percent:  Some(r.get::<f64, _>(3).unwrap_or(0.0)),
                    log_write_percent: Some(r.get::<f64, _>(4).unwrap_or(0.0)),
                    storage_percent:  Some(r.get::<f64, _>(5).unwrap_or(0.0)),
                    workers_percent:  Some(r.get::<f64, _>(6).unwrap_or(0.0)),
                    sessions_percent: Some(r.get::<f64, _>(7).unwrap_or(0.0)),
                })
            } else {
                Ok(SsAzureMetrics { is_azure: true, engine_edition, ..Default::default() })
            }
        }
        Err(_) => Ok(SsAzureMetrics { is_azure: true, engine_edition, ..Default::default() }),
    }
}

impl Default for SsAzureMetrics {
    fn default() -> Self {
        Self {
            is_azure: false, engine_edition: 0,
            dtu_limit: None, dtu_used: None,
            cpu_percent: None, data_io_percent: None,
            log_write_percent: None, storage_percent: None,
            workers_percent: None, sessions_percent: None,
        }
    }
}

// ── 可选增强: PolyBase 外部数据源 (MS0.4+) ───────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsExternalDataSource {
    pub name: String,
    pub location: String,
    pub type_desc: String,
    pub credential_name: Option<String>,
    pub database_name: Option<String>,
}

/// MS0.4+ PolyBase: 外部数据源列表（sys.external_data_sources）
#[tauri::command]
pub async fn ss_external_data_sources(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsExternalDataSource>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT eds.name,
       ISNULL(eds.location, '') AS location,
       ISNULL(eds.type_desc, '') AS type_desc,
       cred.name AS credential_name,
       eds.database_name
FROM sys.external_data_sources eds
LEFT JOIN sys.database_scoped_credentials cred ON eds.credential_id = cred.credential_id
ORDER BY eds.name";

    let rows = match entry.client.simple_query(sql).await {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default(),
        Err(e) => {
            let msg = e.to_string();
            // 视图不存在（极旧版本）才降级；"208" 是通用"对象名无效"错误号，过宽不可用作判据
            if msg.contains("external_data_sources") || msg.contains("Invalid object name") {
                return Ok(vec![]);
            }
            return Err(format!("查询外部数据源失败: {msg}"));
        }
    };

    Ok(rows.iter().map(|r| SsExternalDataSource {
        name:            r.get::<&str, _>(0).unwrap_or("").to_string(),
        location:        r.get::<&str, _>(1).unwrap_or("").to_string(),
        type_desc:       r.get::<&str, _>(2).unwrap_or("").to_string(),
        credential_name: r.get::<&str, _>(3).map(|s| s.to_string()),
        database_name:   r.get::<&str, _>(4).map(|s| s.to_string()),
    }).collect())
}
