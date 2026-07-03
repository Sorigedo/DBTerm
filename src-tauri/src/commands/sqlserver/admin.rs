// MS1.x: SQL Server DMV 监控命令（完全隔离，不碰其他数据库侧代码）
// tiberius 列类型映射: tinyint→u8, smallint→i16, int→i32, bigint→i64, float(53)→f64, varchar→&str
use serde::Serialize;
use tauri::State;

use super::{SsPool, load_conn};
use crate::storage::StorageState;

// ── MS1.1: 会话与请求 ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsSession {
    pub spid: i32,
    pub login_name: String,
    pub host_name: String,
    pub program_name: String,
    pub status: String,
    pub database_name: String,
    pub cpu_time: i64,
    pub memory_pages: i64,
    pub last_request_start: String,
    pub reads: i64,
    pub writes: i64,
    pub logical_reads: i64,
    pub sql_text: Option<String>,
    pub wait_type: Option<String>,
    pub wait_time_ms: i64,
    pub blocking_spid: Option<i32>,
}

/// MS1.1: 当前会话列表（含活跃请求 SQL 文本）
#[tauri::command]
pub async fn ss_session_list(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsSession>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s.session_id, s.login_name, s.host_name, s.program_name, s.status,
       ISNULL(DB_NAME(s.database_id), '') AS database_name,
       s.cpu_time, s.memory_usage,
       ISNULL(CONVERT(VARCHAR(23), s.last_request_start_time, 120), '') AS last_request_start,
       s.reads, s.writes, s.logical_reads,
       t.text AS sql_text,
       r.wait_type,
       ISNULL(r.wait_time, 0) AS wait_time_ms,
       NULLIF(r.blocking_session_id, 0) AS blocking_spid
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1
ORDER BY s.cpu_time DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询会话失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取会话失败: {e}"))?;

    Ok(rows.iter().map(|r| SsSession {
        // session_id: smallint → i16
        spid:               r.get::<i16, _>(0).unwrap_or(0) as i32,
        login_name:         r.get::<&str, _>(1).unwrap_or("").to_string(),
        host_name:          r.get::<&str, _>(2).unwrap_or("").to_string(),
        program_name:       r.get::<&str, _>(3).unwrap_or("").to_string(),
        status:             r.get::<&str, _>(4).unwrap_or("").to_string(),
        database_name:      r.get::<&str, _>(5).unwrap_or("").to_string(),
        // cpu_time: int → i32
        cpu_time:           r.get::<i32, _>(6).unwrap_or(0) as i64,
        // memory_usage: int (8KB pages) → i32
        memory_pages:       r.get::<i32, _>(7).unwrap_or(0) as i64,
        last_request_start: r.get::<&str, _>(8).unwrap_or("").to_string(),
        // reads/writes/logical_reads: bigint → i64
        reads:              r.get::<i64, _>(9).unwrap_or(0),
        writes:             r.get::<i64, _>(10).unwrap_or(0),
        logical_reads:      r.get::<i64, _>(11).unwrap_or(0),
        sql_text:           r.get::<&str, _>(12).map(|s| s.to_string()),
        wait_type:          r.get::<&str, _>(13).map(|s| s.to_string()),
        // wait_time: int → i32
        wait_time_ms:       r.get::<i32, _>(14).unwrap_or(0) as i64,
        // blocking_session_id: smallint nullable → i16
        blocking_spid:      r.get::<i16, _>(15).map(|v| v as i32),
    }).collect())
}

/// MS1.1: KILL 指定 SPID（危险操作，前端须强确认后调用）
#[tauri::command]
pub async fn ss_kill_spid(
    id: String,
    spid: i32,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<(), String> {
    if !(1..=32767).contains(&spid) {
        return Err(format!("SPID {spid} 超出有效范围"));
    }
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;
    // spid 已验证为正整数，无注入风险
    entry.client.simple_query(&format!("KILL {spid}")).await
        .map_err(|e| format!("KILL {spid} 失败: {e}"))?;
    Ok(())
}

// ── MS1.2: TopSQL（执行统计） ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsTopSql {
    pub sql_text: String,
    pub execution_count: i64,
    pub total_worker_time: i64,
    pub avg_worker_time: i64,
    pub total_logical_reads: i64,
    pub avg_logical_reads: i64,
    pub total_elapsed_time: i64,
    pub avg_elapsed_time: i64,
    pub last_execution_time: String,
}

/// MS1.2: TopSQL —— 按维度排序
#[tauri::command]
pub async fn ss_top_sql(
    id: String,
    sort_by: String,
    top_n: Option<i32>,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsTopSql>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let n = top_n.unwrap_or(20).clamp(1, 100);
    let order = match sort_by.as_str() {
        "reads"      => "qs.total_logical_reads",
        "elapsed"    => "qs.total_elapsed_time",
        "executions" => "qs.execution_count",
        _            => "qs.total_worker_time",
    };
    let mut entry = entry_arc.lock().await;

    let sql = format!("\
SELECT TOP {n}
    SUBSTRING(qt.text, (qs.statement_start_offset/2)+1,
        ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(qt.text)
          ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS sql_text,
    qs.execution_count,
    qs.total_worker_time,
    qs.total_worker_time / qs.execution_count AS avg_worker_time,
    qs.total_logical_reads,
    qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
    qs.total_elapsed_time,
    qs.total_elapsed_time / qs.execution_count AS avg_elapsed_time,
    ISNULL(CONVERT(VARCHAR(23), qs.last_execution_time, 120), '') AS last_execution_time
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
ORDER BY {order} DESC");

    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("查询 TopSQL 失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取 TopSQL 失败: {e}"))?;

    Ok(rows.iter().map(|r| SsTopSql {
        sql_text:            r.get::<&str, _>(0).unwrap_or("").to_string(),
        // all bigint → i64
        execution_count:     r.get::<i64, _>(1).unwrap_or(0),
        total_worker_time:   r.get::<i64, _>(2).unwrap_or(0),
        avg_worker_time:     r.get::<i64, _>(3).unwrap_or(0),
        total_logical_reads: r.get::<i64, _>(4).unwrap_or(0),
        avg_logical_reads:   r.get::<i64, _>(5).unwrap_or(0),
        total_elapsed_time:  r.get::<i64, _>(6).unwrap_or(0),
        avg_elapsed_time:    r.get::<i64, _>(7).unwrap_or(0),
        last_execution_time: r.get::<&str, _>(8).unwrap_or("").to_string(),
    }).collect())
}

// ── MS1.3: 锁与阻塞 ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsLockInfo {
    pub request_spid: i32,
    pub resource_type: String,
    pub resource_description: String,
    pub request_mode: String,
    pub request_status: String,
    pub blocking_spid: i32,
    pub wait_time_ms: i64,
    pub database_name: String,
}

/// MS1.3: 锁与阻塞链
#[tauri::command]
pub async fn ss_lock_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsLockInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT l.request_session_id,
       l.resource_type, l.resource_description,
       l.request_mode, l.request_status,
       ISNULL(CAST(wt.blocking_session_id AS SMALLINT), 0) AS blocking_spid,
       ISNULL(wt.wait_duration_ms, 0) AS wait_time_ms,
       ISNULL(DB_NAME(l.resource_database_id), '') AS database_name
FROM sys.dm_tran_locks l
LEFT JOIN sys.dm_os_waiting_tasks wt ON l.lock_owner_address = wt.resource_address
WHERE l.request_session_id <> @@SPID
ORDER BY wt.wait_duration_ms DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询锁信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取锁信息失败: {e}"))?;

    Ok(rows.iter().map(|r| SsLockInfo {
        // request_session_id: smallint → i16
        request_spid:         r.get::<i16, _>(0).unwrap_or(0) as i32,
        resource_type:        r.get::<&str, _>(1).unwrap_or("").to_string(),
        resource_description: r.get::<&str, _>(2).unwrap_or("").to_string(),
        request_mode:         r.get::<&str, _>(3).unwrap_or("").to_string(),
        request_status:       r.get::<&str, _>(4).unwrap_or("").to_string(),
        // blocking_session_id: CAST AS SMALLINT → i16
        blocking_spid:        r.get::<i16, _>(5).unwrap_or(0) as i32,
        // wait_duration_ms: bigint → i64
        wait_time_ms:         r.get::<i64, _>(6).unwrap_or(0),
        database_name:        r.get::<&str, _>(7).unwrap_or("").to_string(),
    }).collect())
}

// ── MS1.4: 等待统计 ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsWaitStat {
    pub wait_type: String,
    pub waiting_tasks_count: i64,
    pub wait_time_ms: i64,
    pub max_wait_time_ms: i64,
    pub signal_wait_time_ms: i64,
}

/// MS1.4: Top 等待统计（排除 SQL Server 内部空闲等待）
#[tauri::command]
pub async fn ss_wait_stats(
    id: String,
    top_n: Option<i32>,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsWaitStat>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let n = top_n.unwrap_or(20).clamp(1, 50);
    let mut entry = entry_arc.lock().await;

    let sql = format!("\
SELECT TOP {n} wait_type, waiting_tasks_count, wait_time_ms,
       max_wait_time_ms, signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE waiting_tasks_count > 0
  AND wait_type NOT IN (
    'SLEEP_TASK','SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP','SLEEP_DBSTARTUP',
    'SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED',
    'SLEEP_MSDBSTARTUP','WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT',
    'SOS_WORK_DISPATCHER','REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE',
    'SERVER_IDLE_CHECK','SLEEP_DCOMSTARTUP','SLEEP_LOCALHOST',
    'SQLTRACE_BUFFER_FLUSH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
    'DISPATCHER_QUEUE_SEMAPHORE','BROKER_TO_FLUSH','BROKER_TASK_STOP',
    'CLR_AUTO_EVENT','CLR_MANUAL_EVENT','FT_IFTS_SCHEDULER_IDLE_WAIT',
    'HADR_WORK_QUEUE','ONDEMAND_TASK_QUEUE','REDO_THREAD_PENDING_WORK',
    'SP_SERVER_DIAGNOSTICS_SLEEP','WAIT_XTP_OFFLINE_CKPT_NEW_LOG')
ORDER BY wait_time_ms DESC");

    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("查询等待统计失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取等待统计失败: {e}"))?;

    Ok(rows.iter().map(|r| SsWaitStat {
        wait_type:            r.get::<&str, _>(0).unwrap_or("").to_string(),
        // all bigint → i64
        waiting_tasks_count:  r.get::<i64, _>(1).unwrap_or(0),
        wait_time_ms:         r.get::<i64, _>(2).unwrap_or(0),
        max_wait_time_ms:     r.get::<i64, _>(3).unwrap_or(0),
        signal_wait_time_ms:  r.get::<i64, _>(4).unwrap_or(0),
    }).collect())
}

// ── MS1.5: 实例仪表盘 ──────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SsInstanceMetrics {
    pub version: String,
    pub edition: String,
    pub engine_edition: i32,
    pub uptime_seconds: i64,
    pub batch_requests_sec: i64,
    pub connections: i64,
    pub page_life_expectancy: i64,
    pub total_memory_mb: i64,
    pub free_memory_mb: i64,
    pub max_memory_mb: i64,
}

/// MS1.5: 实例仪表盘（版本/连接/内存/PLE）
#[tauri::command]
pub async fn ss_instance_metrics(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsInstanceMetrics, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 版本 + 运行时长（DATEDIFF 返回 int → i32）
    let ver_rows = entry.client.simple_query(
        "SELECT @@VERSION,
                CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)),
                CAST(SERVERPROPERTY('EngineEdition') AS INT),
                DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) AS uptime_seconds
         FROM sys.dm_os_sys_info"
    ).await
        .map_err(|e| format!("获取版本信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取版本信息失败: {e}"))?;

    let (version, edition, engine_edition, uptime_seconds) = ver_rows.first()
        .map(|r| (
            r.get::<&str, _>(0).unwrap_or("").lines().next().unwrap_or("").to_string(),
            r.get::<&str, _>(1).unwrap_or("").to_string(),
            r.get::<i32, _>(2).unwrap_or(0),
            r.get::<i32, _>(3).unwrap_or(0) as i64,
        ))
        .unwrap_or_default();

    // 性能计数器（WHERE 括号保证 AND/OR 正确优先级）
    let perf_rows = entry.client.simple_query(
        "SELECT counter_name, cntr_value FROM sys.dm_os_performance_counters
         WHERE counter_name IN (
             'Batch Requests/sec', 'Page life expectancy',
             'User Connections', 'Total Server Memory (KB)', 'Free Memory (KB)'
         )
         AND (object_name LIKE '%SQL Statistics%'
              OR object_name LIKE '%Buffer Manager%'
              OR object_name LIKE '%Memory Manager%'
              OR object_name LIKE '%General Statistics%')"
    ).await
        .map_err(|e| format!("获取性能计数器失败: {e}"))?
        .into_first_result().await
        .unwrap_or_default();

    let mut batch_req = 0i64;
    let mut ple = 0i64;
    let mut connections = 0i64;
    let mut total_mem_kb = 0i64;
    let mut free_mem_kb = 0i64;

    for r in &perf_rows {
        let name = r.get::<&str, _>(0).unwrap_or("").trim().to_lowercase();
        // cntr_value: bigint → i64
        let val = r.get::<i64, _>(1).unwrap_or(0);
        if name.contains("batch requests")        { batch_req    = val; }
        else if name.contains("page life")        { ple          = val; }
        else if name.contains("user connections") { connections  = val; }
        else if name.contains("total server")     { total_mem_kb = val; }
        else if name.contains("free memory")      { free_mem_kb  = val; }
    }

    // Batch Requests/sec 计数器是自启动以来的累计值，采样 1 秒求差才是真实每秒速率
    // （per-connection 锁，sleep 仅占用本连接，不阻塞对其他 SQL Server 连接的操作）
    let batch1 = batch_req;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let batch_per_sec = match entry.client.simple_query(
        "SELECT cntr_value FROM sys.dm_os_performance_counters
         WHERE counter_name = 'Batch Requests/sec' AND object_name LIKE '%SQL Statistics%'"
    ).await {
        Ok(stream) => {
            let v = stream.into_first_result().await.unwrap_or_default()
                .first().and_then(|r| r.get::<i64, _>(0)).unwrap_or(batch1);
            (v - batch1).max(0)
        }
        Err(_) => 0,
    };

    // max server memory (MB) from sys.configurations (BIGINT 强制转换保证类型正确)
    let cfg_rows = entry.client.simple_query(
        "SELECT CAST(value_in_use AS BIGINT) FROM sys.configurations WHERE name = 'max server memory (MB)'"
    ).await
        .map_err(|e| format!("获取内存配置失败: {e}"))?
        .into_first_result().await
        .unwrap_or_default();

    let max_memory_mb = cfg_rows.first()
        .and_then(|r| r.get::<i64, _>(0))
        .unwrap_or(total_mem_kb / 1024);

    Ok(SsInstanceMetrics {
        version,
        edition,
        engine_edition,
        uptime_seconds,
        batch_requests_sec: batch_per_sec,
        connections,
        page_life_expectancy: ple,
        total_memory_mb: total_mem_kb / 1024,
        free_memory_mb: free_mem_kb / 1024,
        max_memory_mb,
    })
}

// ── MS0.6: EXPLAIN 执行计划 ──────────────────────────────────────────────────

/// MS0.6: SQL Server 执行计划（estimated = SHOWPLAN_TEXT，actual = STATISTICS TEXT）
/// 返回计划文本行列表，前端用 ExplainPanel 渲染（与 PG 文本行格式一致）
#[tauri::command]
pub async fn ss_explain(
    id: String,
    sql_text: String,
    analyze: bool,   // true = STATISTICS TEXT (执行后返回实际计划)
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<String>, String> {
    if sql_text.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // 开启执行计划模式（不执行 DML，仅展示计划）
    let set_on  = if analyze { "SET STATISTICS TEXT ON"  } else { "SET SHOWPLAN_TEXT ON" };
    let set_off = if analyze { "SET STATISTICS TEXT OFF" } else { "SET SHOWPLAN_TEXT OFF" };

    // 三条语句合为一批：SET ON; {sql}; SET OFF;
    // tiberius simple_query 支持批处理，结果包含多个 result set
    let batch = format!("{set_on};\n{}\n{set_off}", sql_text.trim());

    let results = entry.client.simple_query(&batch).await
        .map_err(|e| format!("执行计划失败: {e}"))?
        .into_results().await
        .map_err(|e| format!("读取执行计划失败: {e}"))?;

    let mut lines: Vec<String> = Vec::new();
    for result_set in results {
        for row in result_set {
            // SHOWPLAN_TEXT/STATISTICS TEXT 的结果列为 nvarchar
            if let Some(s) = row.get::<&str, _>(0) {
                if !s.trim().is_empty() {
                    lines.push(s.to_string());
                }
            }
        }
    }
    Ok(lines)
}

// ── MS2.1: 索引碎片分析 ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsIndexFrag {
    pub schema_name: String,
    pub table_name: String,
    pub index_name: String,
    pub index_type: String,
    pub avg_frag_pct: f64,
    pub page_count: i64,
    pub record_count: i64,
    pub suggestion: String,  // "REORGANIZE" | "REBUILD" | "OK"
}

/// MS2.1: 索引碎片分析（扫描当前数据库所有用户表）
#[tauri::command]
pub async fn ss_index_frag(
    id: String,
    min_page_count: Option<i32>,  // 默认 1000 页以上才分析（避免扫描微型表）
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsIndexFrag>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let min_pages = min_page_count.unwrap_or(1000).clamp(0, 1_000_000);
    let mut entry = entry_arc.lock().await;

    let sql = format!("\
SELECT s.name AS schema_name, t.name AS table_name,
       ISNULL(i.name, '(heap)') AS index_name,
       f.index_type_desc AS index_type,
       f.avg_fragmentation_in_percent AS avg_frag_pct,
       f.page_count,
       f.record_count
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') f
JOIN sys.tables t ON f.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.indexes i ON f.object_id = i.object_id AND f.index_id = i.index_id
WHERE f.page_count >= {min_pages}
  AND f.index_id > 0
ORDER BY f.avg_fragmentation_in_percent DESC");

    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("索引碎片分析失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取碎片数据失败: {e}"))?;

    Ok(rows.iter().map(|r| {
        // 列顺序: 0=schema_name 1=table_name 2=index_name 3=index_type 4=avg_frag_pct 5=page_count 6=record_count
        let frag = r.get::<f64, _>(4).unwrap_or(0.0);
        let suggestion = if frag >= 30.0 { "REBUILD" }
                         else if frag >= 5.0 { "REORGANIZE" }
                         else { "OK" };
        SsIndexFrag {
            schema_name:  r.get::<&str, _>(0).unwrap_or("").to_string(),
            table_name:   r.get::<&str, _>(1).unwrap_or("").to_string(),
            index_name:   r.get::<&str, _>(2).unwrap_or("").to_string(),
            index_type:   r.get::<&str, _>(3).unwrap_or("").to_string(),
            avg_frag_pct: frag,
            page_count:   r.get::<i64, _>(5).unwrap_or(0),
            record_count: r.get::<i64, _>(6).unwrap_or(0),
            suggestion:   suggestion.to_string(),
        }
    }).collect())
}

// ── MS2.2: 缺失索引建议 ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsMissingIndex {
    pub database_name: String,
    pub schema_name: String,
    pub table_name: String,
    pub equality_columns: Option<String>,
    pub inequality_columns: Option<String>,
    pub included_columns: Option<String>,
    pub user_seeks: i64,
    pub user_scans: i64,
    pub avg_total_user_cost: f64,
    pub avg_user_impact: f64,
    pub estimated_benefit: f64,  // seeks * avg_cost * avg_impact / 100
}

/// MS2.2: 缺失索引建议（sys.dm_db_missing_index_*）
#[tauri::command]
pub async fn ss_missing_indexes(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsMissingIndex>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT d.statement AS full_name,
       mid.equality_columns, mid.inequality_columns, mid.included_columns,
       migs.user_seeks, migs.user_scans,
       migs.avg_total_user_cost, migs.avg_user_impact,
       migs.user_seeks * migs.avg_total_user_cost * migs.avg_user_impact / 100 AS estimated_benefit
FROM sys.dm_db_missing_index_group_stats migs
JOIN sys.dm_db_missing_index_groups mig ON migs.group_handle = mig.index_group_handle
JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
CROSS APPLY (SELECT DB_NAME(mid.database_id) + '.' + mid.statement) d(statement)
ORDER BY estimated_benefit DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询缺失索引失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取缺失索引失败: {e}"))?;

    Ok(rows.iter().map(|r| {
        let full_name = r.get::<&str, _>(0).unwrap_or("").to_string();
        // "db.schema.table" 或 "[db].[schema].[table]" 格式
        let parts: Vec<&str> = full_name.splitn(3, '.').collect();
        let (db, schema, table) = match parts.as_slice() {
            [a, b, c] => (a.trim_matches('[').trim_matches(']').to_string(),
                          b.trim_matches('[').trim_matches(']').to_string(),
                          c.trim_matches('[').trim_matches(']').to_string()),
            _ => (String::new(), String::new(), full_name.clone()),
        };
        SsMissingIndex {
            database_name:        db,
            schema_name:          schema,
            table_name:           table,
            equality_columns:     r.get::<&str, _>(1).map(|s| s.to_string()),
            inequality_columns:   r.get::<&str, _>(2).map(|s| s.to_string()),
            included_columns:     r.get::<&str, _>(3).map(|s| s.to_string()),
            user_seeks:           r.get::<i64, _>(4).unwrap_or(0),
            user_scans:           r.get::<i64, _>(5).unwrap_or(0),
            avg_total_user_cost:  r.get::<f64, _>(6).unwrap_or(0.0),
            avg_user_impact:      r.get::<f64, _>(7).unwrap_or(0.0),
            estimated_benefit:    r.get::<f64, _>(8).unwrap_or(0.0),
        }
    }).collect())
}

/// MS2.2: 未使用索引（seeks=0 且 scans=0 但有 updates → 纯开销）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsUnusedIndex {
    pub schema_name: String,
    pub table_name: String,
    pub index_name: String,
    pub user_seeks: i64,
    pub user_scans: i64,
    pub user_updates: i64,  // 越高代表维护成本越大
    pub page_count: i64,
}

#[tauri::command]
pub async fn ss_unused_indexes(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsUnusedIndex>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name,
       ISNULL(us.user_seeks, 0) AS user_seeks,
       ISNULL(us.user_scans, 0) AS user_scans,
       ISNULL(us.user_updates, 0) AS user_updates,
       ISNULL(p.page_count, 0) AS page_count
FROM sys.indexes i
JOIN sys.tables t ON i.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.dm_db_index_usage_stats us ON i.object_id = us.object_id
    AND i.index_id = us.index_id AND us.database_id = DB_ID()
LEFT JOIN (
    SELECT object_id, index_id, SUM(page_count) AS page_count
    FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED')
    GROUP BY object_id, index_id
) p ON i.object_id = p.object_id AND i.index_id = p.index_id
WHERE i.type_desc <> 'HEAP'
  AND i.is_primary_key = 0
  AND i.is_unique_constraint = 0
  AND ISNULL(us.user_seeks, 0) = 0
  AND ISNULL(us.user_scans, 0) = 0
  AND ISNULL(us.user_updates, 0) > 0
ORDER BY us.user_updates DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询未用索引失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取未用索引失败: {e}"))?;

    Ok(rows.iter().map(|r| SsUnusedIndex {
        schema_name:  r.get::<&str, _>(0).unwrap_or("").to_string(),
        table_name:   r.get::<&str, _>(1).unwrap_or("").to_string(),
        index_name:   r.get::<&str, _>(2).unwrap_or("").to_string(),
        user_seeks:   r.get::<i64, _>(3).unwrap_or(0),
        user_scans:   r.get::<i64, _>(4).unwrap_or(0),
        user_updates: r.get::<i64, _>(5).unwrap_or(0),
        page_count:   r.get::<i64, _>(6).unwrap_or(0),
    }).collect())
}

// ── MS2.3: 统计信息陈旧检测 ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsStatInfo {
    pub schema_name: String,
    pub table_name: String,
    pub stat_name: String,
    pub last_updated: String,
    pub row_count: i64,
    pub rows_sampled: i64,
    pub is_stale: bool,  // 超过 20% 行变化或超过 7 天未更新
}

/// MS2.3: 统计信息陈旧检测
#[tauri::command]
pub async fn ss_stale_stats(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsStatInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s2.name AS schema_name, t.name AS table_name, s.name AS stat_name,
       ISNULL(CONVERT(VARCHAR(23), sp.last_updated, 120), '') AS last_updated,
       ISNULL(sp.rows, 0) AS row_count,
       ISNULL(sp.rows_sampled, 0) AS rows_sampled,
       CASE WHEN sp.last_updated IS NULL THEN 1
            WHEN DATEDIFF(DAY, sp.last_updated, GETDATE()) > 7 THEN 1
            WHEN sp.rows > 0 AND (sp.rows - sp.rows_sampled) * 100.0 / sp.rows > 20 THEN 1
            ELSE 0
       END AS is_stale
FROM sys.stats s
JOIN sys.tables t ON s.object_id = t.object_id
JOIN sys.schemas s2 ON t.schema_id = s2.schema_id
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE t.type = 'U'
ORDER BY is_stale DESC, sp.last_updated ASC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询统计信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取统计信息失败: {e}"))?;

    Ok(rows.iter().map(|r| SsStatInfo {
        schema_name:  r.get::<&str, _>(0).unwrap_or("").to_string(),
        table_name:   r.get::<&str, _>(1).unwrap_or("").to_string(),
        stat_name:    r.get::<&str, _>(2).unwrap_or("").to_string(),
        last_updated: r.get::<&str, _>(3).unwrap_or("").to_string(),
        row_count:    r.get::<i64, _>(4).unwrap_or(0),
        rows_sampled: r.get::<i64, _>(5).unwrap_or(0),
        // is_stale: SQL CASE WHEN 返回 int (0/1) → i32
        is_stale:     r.get::<i32, _>(6).unwrap_or(0) != 0,
    }).collect())
}

// ── MS2.4: tempdb 监控 ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsTempdbInfo {
    pub total_space_mb: i64,
    pub used_space_mb: i64,
    pub free_space_mb: i64,
    pub version_store_mb: i64,
    pub internal_objects_mb: i64,
    pub user_objects_mb: i64,
    pub file_count: i32,
    pub data_file_count: i32,
    pub log_file_count: i32,
}

/// MS2.4: tempdb 空间使用与配置建议
#[tauri::command]
pub async fn ss_tempdb_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsTempdbInfo, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT
    SUM(total_page_count) * 8 / 1024 AS total_space_mb,
    SUM(allocated_extent_page_count) * 8 / 1024 AS used_space_mb,
    SUM(unallocated_extent_page_count) * 8 / 1024 AS free_space_mb,
    SUM(version_store_reserved_page_count) * 8 / 1024 AS version_store_mb,
    SUM(internal_object_reserved_page_count) * 8 / 1024 AS internal_objects_mb,
    SUM(user_object_reserved_page_count) * 8 / 1024 AS user_objects_mb
FROM sys.dm_db_file_space_usage
WHERE database_id = 2";

    let space_rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询 tempdb 空间失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取 tempdb 空间失败: {e}"))?;

    let (total, used, free, vs, internal, user_obj) = space_rows.first()
        .map(|r| (
            r.get::<i64, _>(0).unwrap_or(0),
            r.get::<i64, _>(1).unwrap_or(0),
            r.get::<i64, _>(2).unwrap_or(0),
            r.get::<i64, _>(3).unwrap_or(0),
            r.get::<i64, _>(4).unwrap_or(0),
            r.get::<i64, _>(5).unwrap_or(0),
        ))
        .unwrap_or_default();

    let file_rows = entry.client.simple_query(
        "SELECT COUNT(*) AS total_files,
                SUM(CASE WHEN type = 0 THEN 1 ELSE 0 END) AS data_files,
                SUM(CASE WHEN type = 1 THEN 1 ELSE 0 END) AS log_files
         FROM sys.master_files WHERE database_id = 2"
    ).await
        .map_err(|e| format!("查询 tempdb 文件数失败: {e}"))?
        .into_first_result().await
        .unwrap_or_default();

    let (file_count, data_file_count, log_file_count) = file_rows.first()
        .map(|r| (
            r.get::<i32, _>(0).unwrap_or(0),
            r.get::<i32, _>(1).unwrap_or(0),
            r.get::<i32, _>(2).unwrap_or(0),
        ))
        .unwrap_or_default();

    Ok(SsTempdbInfo {
        total_space_mb: total,
        used_space_mb: used,
        free_space_mb: free,
        version_store_mb: vs,
        internal_objects_mb: internal,
        user_objects_mb: user_obj,
        file_count,
        data_file_count,
        log_file_count,
    })
}

// ── MS2.5: 存储与容量统计 ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsDbSize {
    pub database_name: String,
    pub data_size_mb: i64,
    pub log_size_mb: i64,
    pub total_size_mb: i64,
    pub state_desc: String,
}

/// MS2.5: 所有数据库容量一览（sys.master_files）
#[tauri::command]
pub async fn ss_db_sizes(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsDbSize>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // f.size 是 int（页数），SUM 后仍 int，大库 *8 易溢出且 i64 读取不匹配；
    // 先 CAST 每个 size 为 BIGINT 再聚合，结果列为 bigint，对应 i64
    let sql = "\
SELECT d.name AS database_name,
       SUM(CASE WHEN f.type = 0 THEN CAST(f.size AS BIGINT) ELSE 0 END) * 8 / 1024 AS data_size_mb,
       SUM(CASE WHEN f.type = 1 THEN CAST(f.size AS BIGINT) ELSE 0 END) * 8 / 1024 AS log_size_mb,
       SUM(CAST(f.size AS BIGINT)) * 8 / 1024 AS total_size_mb,
       d.state_desc
FROM sys.databases d
JOIN sys.master_files f ON d.database_id = f.database_id
GROUP BY d.name, d.state_desc
ORDER BY total_size_mb DESC";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询数据库容量失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取数据库容量失败: {e}"))?;

    Ok(rows.iter().map(|r| SsDbSize {
        database_name: r.get::<&str, _>(0).unwrap_or("").to_string(),
        data_size_mb:  r.get::<i64, _>(1).unwrap_or(0),
        log_size_mb:   r.get::<i64, _>(2).unwrap_or(0),
        total_size_mb: r.get::<i64, _>(3).unwrap_or(0),
        state_desc:    r.get::<&str, _>(4).unwrap_or("").to_string(),
    }).collect())
}
