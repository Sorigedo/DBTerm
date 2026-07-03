// MS3.x: SQL Server 高可用 + 备份 + 分区 + SQL Agent（完全隔离）
use serde::Serialize;
use tauri::State;

use super::{SsPool, load_conn};
use crate::storage::StorageState;

// ── MS3.1: Always On 可用性组 ────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsAgReplica {
    pub ag_name: String,
    pub replica_server: String,
    pub role: String,              // "PRIMARY" | "SECONDARY" | "RESOLVING"
    pub availability_mode: String, // "SYNCHRONOUS_COMMIT" | "ASYNCHRONOUS_COMMIT"
    pub failover_mode: String,     // "AUTOMATIC" | "MANUAL"
    pub sync_state: String,        // "SYNCHRONIZED" | "SYNCHRONIZING" | "NOT SYNCHRONIZING"
    pub operational_state: String,
    pub log_send_queue_kb: i64,
    pub redo_queue_kb: i64,
    pub connected_state: String,
}

/// MS3.1: Always On AG 副本状态（仅只读展示，故障转移引导用外部工具）
#[tauri::command]
pub async fn ss_ag_status(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsAgReplica>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT ag.name AS ag_name,
       ar.replica_server_name AS replica_server,
       ars.role_desc AS role,
       ar.availability_mode_desc AS availability_mode,
       ar.failover_mode_desc AS failover_mode,
       drs.synchronization_state_desc AS sync_state,
       ars.operational_state_desc AS operational_state,
       ISNULL(drs.log_send_queue_size, 0) AS log_send_queue_kb,
       ISNULL(drs.redo_queue_size, 0) AS redo_queue_kb,
       ars.connected_state_desc AS connected_state
FROM sys.availability_groups ag
JOIN sys.availability_replicas ar ON ag.group_id = ar.group_id
JOIN sys.dm_hadr_availability_replica_states ars ON ar.replica_id = ars.replica_id
LEFT JOIN sys.dm_hadr_database_replica_states drs ON ar.replica_id = drs.replica_id
ORDER BY ag.name, ars.role_desc";

    let rows = match entry.client.simple_query(sql).await {
        Ok(r) => r.into_first_result().await
            .map_err(|e| format!("读取 AG 状态失败: {e}"))?,
        Err(e) => {
            // 此实例无 Always On（Standard 版或未配置），返回空列表
            let msg = e.to_string();
            if msg.contains("availability_groups") || msg.contains("hadr") {
                return Ok(vec![]);
            }
            return Err(format!("查询 AG 状态失败: {e}"));
        }
    };

    Ok(rows.iter().map(|r| SsAgReplica {
        ag_name:           r.get::<&str, _>(0).unwrap_or("").to_string(),
        replica_server:    r.get::<&str, _>(1).unwrap_or("").to_string(),
        role:              r.get::<&str, _>(2).unwrap_or("").to_string(),
        availability_mode: r.get::<&str, _>(3).unwrap_or("").to_string(),
        failover_mode:     r.get::<&str, _>(4).unwrap_or("").to_string(),
        sync_state:        r.get::<&str, _>(5).unwrap_or("").to_string(),
        operational_state: r.get::<&str, _>(6).unwrap_or("").to_string(),
        log_send_queue_kb: r.get::<i64, _>(7).unwrap_or(0),
        redo_queue_kb:     r.get::<i64, _>(8).unwrap_or(0),
        connected_state:   r.get::<&str, _>(9).unwrap_or("").to_string(),
    }).collect())
}

// ── MS3.3: 备份历史 ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsBackupRecord {
    pub database_name: String,
    pub backup_type: String,      // "D"=Full "I"=Differential "L"=Log
    pub backup_start: String,
    pub backup_finish: String,
    pub size_mb: i64,
    pub physical_device_name: String,
    pub is_copy_only: bool,
    pub server_name: String,
}

/// MS3.3: 最近备份历史（msdb.dbo.backupset）
#[tauri::command]
pub async fn ss_backup_history(
    id: String,
    database_name: Option<String>,
    top_n: Option<i32>,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsBackupRecord>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let n = top_n.unwrap_or(50).clamp(1, 500);
    let db_filter = database_name
        .filter(|s| !s.is_empty())
        .map(|db| format!("AND bs.database_name = N'{}'", db.replace('\'', "''")))
        .unwrap_or_default();
    let mut entry = entry_arc.lock().await;

    let sql = format!("\
SELECT TOP {n} bs.database_name,
       bs.type AS backup_type,
       ISNULL(CONVERT(VARCHAR(23), bs.backup_start_date, 120), '') AS backup_start,
       ISNULL(CONVERT(VARCHAR(23), bs.backup_finish_date, 120), '') AS backup_finish,
       CAST(bs.backup_size / 1048576 AS BIGINT) AS size_mb,
       ISNULL(bmf.physical_device_name, '') AS physical_device_name,
       bs.is_copy_only,
       bs.server_name
FROM msdb.dbo.backupset bs
JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
WHERE 1=1 {db_filter}
ORDER BY bs.backup_start_date DESC");

    let rows = entry.client.simple_query(&sql).await
        .map_err(|e| format!("查询备份历史失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取备份历史失败: {e}"))?;

    Ok(rows.iter().map(|r| SsBackupRecord {
        database_name:       r.get::<&str, _>(0).unwrap_or("").to_string(),
        backup_type:         r.get::<&str, _>(1).unwrap_or("").to_string(),
        backup_start:        r.get::<&str, _>(2).unwrap_or("").to_string(),
        backup_finish:       r.get::<&str, _>(3).unwrap_or("").to_string(),
        size_mb:             r.get::<i64, _>(4).unwrap_or(0),
        physical_device_name: r.get::<&str, _>(5).unwrap_or("").to_string(),
        // is_copy_only: bit → bool
        is_copy_only:        r.get::<bool, _>(6).unwrap_or(false),
        server_name:         r.get::<&str, _>(7).unwrap_or("").to_string(),
    }).collect())
}

// ── MS3.4: 分区表管理 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsPartitionInfo {
    pub schema_name: String,
    pub table_name: String,
    pub partition_number: i32,
    pub rows: i64,
    pub data_compression: String,
    pub boundary_value: Option<String>,
    pub filegroup_name: String,
}

/// MS3.4: 当前数据库分区表信息
#[tauri::command]
pub async fn ss_partition_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsPartitionInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT s.name AS schema_name, t.name AS table_name,
       p.partition_number,
       p.rows,
       p.data_compression_desc AS data_compression,
       CAST(rv.value AS NVARCHAR(100)) AS boundary_value,
       ISNULL(ds.name, 'PRIMARY') AS filegroup_name
FROM sys.partitions p
JOIN sys.indexes i ON p.object_id = i.object_id AND p.index_id = i.index_id
JOIN sys.tables t ON p.object_id = t.object_id
JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.partition_schemes ps ON i.data_space_id = ps.data_space_id
LEFT JOIN sys.partition_functions pf ON ps.function_id = pf.function_id
LEFT JOIN sys.partition_range_values rv ON pf.function_id = rv.function_id
    AND rv.boundary_id = p.partition_number - 1
LEFT JOIN sys.destination_data_spaces dds ON ps.data_space_id = dds.partition_scheme_id
    AND dds.destination_id = p.partition_number
LEFT JOIN sys.data_spaces ds ON dds.data_space_id = ds.data_space_id
WHERE i.index_id IN (0, 1)   -- heap 或 clustered index
  AND (SELECT COUNT(*) FROM sys.partition_schemes ps2
       WHERE ps2.data_space_id = i.data_space_id) > 0
ORDER BY s.name, t.name, p.partition_number";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询分区信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取分区信息失败: {e}"))?;

    Ok(rows.iter().map(|r| SsPartitionInfo {
        schema_name:       r.get::<&str, _>(0).unwrap_or("").to_string(),
        table_name:        r.get::<&str, _>(1).unwrap_or("").to_string(),
        partition_number:  r.get::<i32, _>(2).unwrap_or(0),
        rows:              r.get::<i64, _>(3).unwrap_or(0),
        data_compression:  r.get::<&str, _>(4).unwrap_or("NONE").to_string(),
        boundary_value:    r.get::<&str, _>(5).map(|s| s.to_string()),
        filegroup_name:    r.get::<&str, _>(6).unwrap_or("PRIMARY").to_string(),
    }).collect())
}

// ── MS3.5: SQL Agent 作业 ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsAgentJob {
    pub job_name: String,
    pub enabled: bool,
    pub description: String,
    pub last_run_date: String,
    pub last_run_time: String,
    pub last_run_outcome: String,  // "Succeeded" | "Failed" | "Retry" | "Cancelled" | "Unknown"
    pub next_run_date: String,
    pub category: String,
}

/// MS3.5: SQL Agent 作业列表（msdb）
#[tauri::command]
pub async fn ss_agent_jobs(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsAgentJob>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT j.name AS job_name, j.enabled,
       ISNULL(j.description, '') AS description,
       ISNULL(CONVERT(VARCHAR(10), CAST(CAST(jh.run_date AS VARCHAR(8)) AS DATE), 120), '') AS last_run_date,
       CASE WHEN jh.run_time IS NULL THEN ''
            ELSE RIGHT('00' + CAST(jh.run_time / 10000 AS VARCHAR(2)), 2) + ':' +
                 RIGHT('00' + CAST(jh.run_time % 10000 / 100 AS VARCHAR(2)), 2) + ':' +
                 RIGHT('00' + CAST(jh.run_time % 100 AS VARCHAR(2)), 2)
       END AS last_run_time,
       CASE jh.run_status WHEN 0 THEN 'Failed' WHEN 1 THEN 'Succeeded'
           WHEN 2 THEN 'Retry' WHEN 3 THEN 'Cancelled' ELSE 'Unknown' END AS last_run_outcome,
       ISNULL(CONVERT(VARCHAR(10), msdb.dbo.agent_datetime(js.next_run_date, js.next_run_time), 120), '') AS next_run_date,
       ISNULL(c.name, 'Uncategorized') AS category
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
OUTER APPLY (
    SELECT TOP 1 run_date, run_time, run_status
    FROM msdb.dbo.sysjobhistory h
    WHERE h.job_id = j.job_id AND h.step_id = 0
    ORDER BY run_date DESC, run_time DESC
) jh
LEFT JOIN msdb.dbo.sysjobschedules js ON j.job_id = js.job_id
ORDER BY j.name";

    let rows = match entry.client.simple_query(sql).await {
        Ok(r) => r.into_first_result().await
            .map_err(|e| format!("读取 Agent 作业失败: {e}"))?,
        Err(e) => {
            // Azure SQL 或无 SQL Agent 权限，返回空
            let msg = e.to_string();
            if msg.contains("sysjobs") || msg.contains("msdb") {
                return Ok(vec![]);
            }
            return Err(format!("查询 Agent 作业失败: {e}"));
        }
    };

    Ok(rows.iter().map(|r| SsAgentJob {
        job_name:         r.get::<&str, _>(0).unwrap_or("").to_string(),
        enabled:          r.get::<u8, _>(1).unwrap_or(0) != 0,
        description:      r.get::<&str, _>(2).unwrap_or("").to_string(),
        last_run_date:    r.get::<&str, _>(3).unwrap_or("").to_string(),
        last_run_time:    r.get::<&str, _>(4).unwrap_or("").to_string(),
        last_run_outcome: r.get::<&str, _>(5).unwrap_or("Unknown").to_string(),
        next_run_date:    r.get::<&str, _>(6).unwrap_or("").to_string(),
        category:         r.get::<&str, _>(7).unwrap_or("").to_string(),
    }).collect())
}
