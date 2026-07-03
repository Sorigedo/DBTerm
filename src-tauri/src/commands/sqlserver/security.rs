// MS4.x: SQL Server 安全审计 + DBA 巡检 + 配置（完全隔离）
use serde::Serialize;
use tauri::State;

use super::{SsPool, load_conn};
use crate::storage::StorageState;

// ── MS4.1: 登录/用户/角色 ────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsLogin {
    pub name: String,
    pub login_type: String,
    pub is_disabled: bool,
    pub default_database: String,
    pub create_date: String,
    pub is_sysadmin: bool,
}

/// MS4.1: 服务器登录名列表
#[tauri::command]
pub async fn ss_list_logins(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsLogin>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT p.name, p.type_desc AS login_type, p.is_disabled,
       ISNULL(p.default_database_name, 'master') AS default_database,
       ISNULL(CONVERT(VARCHAR(23), p.create_date, 120), '') AS create_date,
       CAST(CASE WHEN IS_SRVROLEMEMBER('sysadmin', p.name) = 1 THEN 1 ELSE 0 END AS INT) AS is_sysadmin
FROM sys.server_principals p
WHERE p.type IN ('S','U','G')
  AND p.name NOT LIKE '##%'
ORDER BY p.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询登录名失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取登录名失败: {e}"))?;

    Ok(rows.iter().map(|r| SsLogin {
        name:             r.get::<&str, _>(0).unwrap_or("").to_string(),
        login_type:       r.get::<&str, _>(1).unwrap_or("").to_string(),
        is_disabled:      r.get::<bool, _>(2).unwrap_or(false),
        default_database: r.get::<&str, _>(3).unwrap_or("master").to_string(),
        create_date:      r.get::<&str, _>(4).unwrap_or("").to_string(),
        is_sysadmin:      r.get::<i32, _>(5).unwrap_or(0) != 0,
    }).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsDbUser {
    pub name: String,
    pub login_name: Option<String>,
    pub user_type: String,
    pub default_schema: String,
    pub roles: Vec<String>,
}

/// MS4.1: 当前数据库用户列表
#[tauri::command]
pub async fn ss_list_db_users(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsDbUser>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT u.name, sl.name AS login_name, u.type_desc AS user_type,
       ISNULL(u.default_schema_name, 'dbo') AS default_schema,
       STUFF((SELECT ',' + r.name
              FROM sys.database_role_members rm
              JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id
              WHERE rm.member_principal_id = u.principal_id
              FOR XML PATH('')), 1, 1, '') AS roles
FROM sys.database_principals u
LEFT JOIN sys.server_principals sl ON u.sid = sl.sid
WHERE u.type IN ('S','U','G')
  AND u.name NOT IN ('guest','INFORMATION_SCHEMA','sys')
ORDER BY u.name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询数据库用户失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取数据库用户失败: {e}"))?;

    Ok(rows.iter().map(|r| SsDbUser {
        name:           r.get::<&str, _>(0).unwrap_or("").to_string(),
        login_name:     r.get::<&str, _>(1).map(|s| s.to_string()),
        user_type:      r.get::<&str, _>(2).unwrap_or("").to_string(),
        default_schema: r.get::<&str, _>(3).unwrap_or("dbo").to_string(),
        roles:          r.get::<&str, _>(4)
            .map(|s| s.split(',').map(|r| r.to_string()).collect())
            .unwrap_or_default(),
    }).collect())
}

// ── MS4.2: 安全特性状态 ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsSecurityFeatures {
    pub tde_databases: Vec<String>,
    pub always_encrypted_columns: Vec<SsEncryptedColumn>,
    pub rls_tables: Vec<String>,
    pub masked_columns: Vec<SsMaskedColumn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsEncryptedColumn {
    pub table_name: String,
    pub column_name: String,
    pub encryption_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsMaskedColumn {
    pub table_name: String,
    pub column_name: String,
    pub masking_function: String,
}

/// MS4.2: 安全特性（TDE、Always Encrypted、RLS、DDM）
#[tauri::command]
pub async fn ss_security_features(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsSecurityFeatures, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // TDE：encryption_state != 0（视图不存在/旧版本时降级为空，不整体失败）
    let tde_databases: Vec<String> = match entry.client.simple_query(
        "SELECT d.name FROM sys.databases d
         JOIN sys.dm_database_encryption_keys dek ON d.database_id = dek.database_id
         WHERE dek.encryption_state <> 0 ORDER BY d.name"
    ).await {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default()
            .iter().filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string())).collect(),
        Err(_) => vec![],
    };

    // Always Encrypted（SQL 2016+；encryption_type 列在旧版本不存在，降级为空）
    let always_encrypted_columns: Vec<SsEncryptedColumn> = match entry.client.simple_query(
        "SELECT t.name, c.name, c.encryption_type_desc
         FROM sys.columns c JOIN sys.tables t ON c.object_id = t.object_id
         WHERE c.encryption_type IS NOT NULL ORDER BY t.name, c.name"
    ).await {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default()
            .iter().map(|r| SsEncryptedColumn {
                table_name:      r.get::<&str, _>(0).unwrap_or("").to_string(),
                column_name:     r.get::<&str, _>(1).unwrap_or("").to_string(),
                encryption_type: r.get::<&str, _>(2).unwrap_or("").to_string(),
            }).collect(),
        Err(_) => vec![],
    };

    // RLS（SQL 2016+；security_predicates 视图旧版本不存在，降级为空）
    let rls_tables: Vec<String> = match entry.client.simple_query(
        "SELECT DISTINCT OBJECT_NAME(target_object_id)
         FROM sys.security_predicates sp
         JOIN sys.security_policies p ON sp.object_id = p.object_id
         WHERE p.is_enabled = 1 ORDER BY 1"
    ).await {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default()
            .iter().filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string())).collect(),
        Err(_) => vec![],
    };

    // 动态数据脱敏（sys.masked_columns SQL 2016+，旧版可能无此视图）
    let ddm_rows = entry.client.simple_query(
        "SELECT t.name, c.name, c.masking_function
         FROM sys.masked_columns c JOIN sys.tables t ON c.object_id = t.object_id
         ORDER BY t.name, c.name"
    ).await;
    let masked_columns: Vec<SsMaskedColumn> = match ddm_rows {
        Ok(stream) => stream.into_first_result().await.unwrap_or_default()
            .iter().map(|r| SsMaskedColumn {
                table_name:       r.get::<&str, _>(0).unwrap_or("").to_string(),
                column_name:      r.get::<&str, _>(1).unwrap_or("").to_string(),
                masking_function: r.get::<&str, _>(2).unwrap_or("").to_string(),
            }).collect(),
        Err(_) => vec![],
    };

    Ok(SsSecurityFeatures { tde_databases, always_encrypted_columns, rls_tables, masked_columns })
}

// ── MS4.5: 一键健康巡检 ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsHealthItem {
    pub category: String,
    pub item: String,
    pub status: String,
    pub detail: String,
}

/// MS4.5: SQL Server 专项健康巡检
#[tauri::command]
pub async fn ss_health_check(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsHealthItem>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut items: Vec<SsHealthItem> = Vec::new();
    let mut entry = entry_arc.lock().await;

    // 每个检查项：query → await → process → push → 再 query（串行，无 block_on）

    // 1. PLE
    let rows = entry.client.simple_query(
        "SELECT cntr_value FROM sys.dm_os_performance_counters
         WHERE counter_name = 'Page life expectancy' AND object_name LIKE '%Buffer Manager%'"
    ).await.map_err(|e| format!("巡检(PLE)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let ple = rows.first().and_then(|r| r.get::<i64, _>(0)).unwrap_or(0);
    items.push(SsHealthItem {
        category: "内存".to_string(),
        item: "Page Life Expectancy (PLE)".to_string(),
        status: if ple < 300 { "WARNING" } else { "OK" }.to_string(),
        detail: format!("当前 PLE = {ple}s（建议 > 300s）"),
    });

    // 2. xp_cmdshell（BIGINT 强制转型避免 sql_variant）
    let rows = entry.client.simple_query(
        "SELECT CAST(value_in_use AS BIGINT) FROM sys.configurations WHERE name = 'xp_cmdshell'"
    ).await.map_err(|e| format!("巡检(xp_cmdshell)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let xp_on = rows.first().and_then(|r| r.get::<i64, _>(0)).unwrap_or(0) != 0;
    items.push(SsHealthItem {
        category: "安全".to_string(),
        item: "xp_cmdshell".to_string(),
        status: if xp_on { "ERROR" } else { "OK" }.to_string(),
        detail: if xp_on { "已启用（可执行操作系统命令，高风险）".to_string() }
                else { "已禁用".to_string() },
    });

    // 3. sa 账户启用状态
    let rows = entry.client.simple_query(
        "SELECT CAST(is_disabled AS INT) FROM sys.server_principals WHERE name = 'sa'"
    ).await.map_err(|e| format!("巡检(sa)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let sa_disabled = rows.first().and_then(|r| r.get::<i32, _>(0)).unwrap_or(1) != 0;
    items.push(SsHealthItem {
        category: "安全".to_string(),
        item: "sa 账户".to_string(),
        status: if !sa_disabled { "WARNING" } else { "OK" }.to_string(),
        detail: if !sa_disabled { "sa 账户已启用（建议禁用并使用命名管理员账户）".to_string() }
                else { "sa 账户已禁用".to_string() },
    });

    // 4. 7天内完整备份次数
    let rows = entry.client.simple_query(
        "SELECT COUNT(*) FROM msdb.dbo.backupset
         WHERE type = 'D' AND backup_start_date > DATEADD(DAY, -7, GETDATE())"
    ).await.map_err(|e| format!("巡检(备份)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let cnt = rows.first().and_then(|r| r.get::<i32, _>(0)).unwrap_or(0);
    items.push(SsHealthItem {
        category: "备份".to_string(),
        item: "7天内完整备份".to_string(),
        status: if cnt == 0 { "ERROR" } else { "OK" }.to_string(),
        detail: format!("最近7天完整备份次数: {cnt}"),
    });

    // 5. tempdb 数据文件数 vs CPU 核心数
    let rows = entry.client.simple_query(
        "SELECT (SELECT COUNT(*) FROM sys.master_files WHERE database_id = 2 AND type = 0),
                cpu_count FROM sys.dm_os_sys_info"
    ).await.map_err(|e| format!("巡检(tempdb)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let (data_files, cpu_count) = rows.first()
        .map(|r| (r.get::<i32, _>(0).unwrap_or(0), r.get::<i32, _>(1).unwrap_or(1)))
        .unwrap_or((0, 1));
    let recommended = cpu_count.min(8);
    items.push(SsHealthItem {
        category: "tempdb".to_string(),
        item: "tempdb 数据文件数".to_string(),
        status: if data_files < recommended { "WARNING" } else { "OK" }.to_string(),
        detail: format!("当前 {data_files} 个，CPU {cpu_count} 核，建议 {recommended} 个"),
    });

    // 6. 高碎片索引数（碎片率 > 30% 且页数 > 1000）
    let rows = entry.client.simple_query(
        "SELECT COUNT(*) FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED')
         WHERE avg_fragmentation_in_percent > 30 AND page_count > 1000 AND index_id > 0"
    ).await.map_err(|e| format!("巡检(碎片)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    let frag_cnt = rows.first().and_then(|r| r.get::<i32, _>(0)).unwrap_or(0);
    items.push(SsHealthItem {
        category: "索引".to_string(),
        item: "高碎片索引（>30%，>1000页）".to_string(),
        status: if frag_cnt > 0 { "WARNING" } else { "OK" }.to_string(),
        detail: format!("共 {frag_cnt} 个索引碎片率 > 30%（建议 REBUILD）"),
    });

    // 7. Top 3 等待类型
    let rows = entry.client.simple_query(
        "SELECT TOP 3 wait_type, wait_time_ms FROM sys.dm_os_wait_stats
         WHERE wait_type NOT IN (
             'SLEEP_TASK','SLEEP_SYSTEMTASK','WAITFOR','XE_DISPATCHER_WAIT',
             'SOS_WORK_DISPATCHER','REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE',
             'BROKER_TO_FLUSH','CLR_AUTO_EVENT','CLR_MANUAL_EVENT')
           AND waiting_tasks_count > 0
         ORDER BY wait_time_ms DESC"
    ).await.map_err(|e| format!("巡检(等待)失败: {e}"))?
        .into_first_result().await.unwrap_or_default();
    for r in &rows {
        let wt = r.get::<&str, _>(0).unwrap_or("");
        let ms = r.get::<i64, _>(1).unwrap_or(0);
        items.push(SsHealthItem {
            category: "等待统计".to_string(),
            item: wt.to_string(),
            status: "INFO".to_string(),
            detail: format!("累计等待 {ms} ms"),
        });
    }

    Ok(items)
}

// ── MS4.7: 关键配置项 ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsConfigItem {
    pub name: String,
    pub value: i64,
    pub value_in_use: i64,
    pub minimum: i64,
    pub maximum: i64,
    pub description: String,
    pub is_dynamic: bool,
    pub is_advanced: bool,
}

/// MS4.7: 关键 sys.configurations 配置项（只读展示）
#[tauri::command]
pub async fn ss_configurations(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<Vec<SsConfigItem>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    // CAST sql_variant 字段为 BIGINT 避免类型不匹配
    let sql = "\
SELECT name,
       CAST(value AS BIGINT)        AS value,
       CAST(value_in_use AS BIGINT) AS value_in_use,
       CAST(minimum AS BIGINT)      AS minimum,
       CAST(maximum AS BIGINT)      AS maximum,
       description, is_dynamic, is_advanced
FROM sys.configurations
WHERE name IN (
    'max server memory (MB)', 'min server memory (MB)',
    'max degree of parallelism', 'cost threshold for parallelism',
    'max worker threads', 'remote query timeout (s)',
    'query wait (s)', 'fill factor (%)',
    'recovery interval (min)', 'lightweight pooling',
    'priority boost', 'xp_cmdshell',
    'clr enabled', 'contained database authentication',
    'cross db ownership chaining', 'remote admin connections',
    'remote access', 'show advanced options'
)
ORDER BY name";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询配置失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取配置失败: {e}"))?;

    Ok(rows.iter().map(|r| SsConfigItem {
        name:         r.get::<&str, _>(0).unwrap_or("").to_string(),
        value:        r.get::<i64, _>(1).unwrap_or(0),
        value_in_use: r.get::<i64, _>(2).unwrap_or(0),
        minimum:      r.get::<i64, _>(3).unwrap_or(0),
        maximum:      r.get::<i64, _>(4).unwrap_or(0),
        description:  r.get::<&str, _>(5).unwrap_or("").to_string(),
        is_dynamic:   r.get::<bool, _>(6).unwrap_or(false),
        is_advanced:  r.get::<bool, _>(7).unwrap_or(false),
    }).collect())
}

// ── MS4.8: 实例基础信息 ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsServerInfo {
    pub server_name: String,
    pub version_string: String,
    pub product_version: String,
    pub product_level: String,
    pub edition: String,
    pub engine_edition: i32,
    pub collation: String,
    pub is_clustered: bool,
    pub is_hadr_enabled: bool,
    pub cpu_count: i32,
    pub physical_memory_mb: i64,
    pub sqlserver_start_time: String,
}

/// MS4.8: 实例基础信息
#[tauri::command]
pub async fn ss_server_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, SsPool>,
) -> Result<SsServerInfo, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let entry_arc = super::get_entry(&id, &pool, &config, password.as_deref()).await?;
    let mut entry = entry_arc.lock().await;

    let sql = "\
SELECT @@SERVERNAME,
       @@VERSION,
       CAST(SERVERPROPERTY('ProductVersion')   AS NVARCHAR(64)),
       CAST(SERVERPROPERTY('ProductLevel')     AS NVARCHAR(64)),
       CAST(SERVERPROPERTY('Edition')          AS NVARCHAR(128)),
       CAST(SERVERPROPERTY('EngineEdition')    AS INT),
       CAST(SERVERPROPERTY('Collation')        AS NVARCHAR(128)),
       CAST(SERVERPROPERTY('IsClustered')      AS INT),
       CAST(SERVERPROPERTY('IsHadrEnabled')    AS INT),
       si.cpu_count,
       si.physical_memory_kb / 1024 AS physical_memory_mb,
       ISNULL(CONVERT(VARCHAR(23), si.sqlserver_start_time, 120), '') AS start_time
FROM sys.dm_os_sys_info si";

    let rows = entry.client.simple_query(sql).await
        .map_err(|e| format!("查询实例信息失败: {e}"))?
        .into_first_result().await
        .map_err(|e| format!("读取实例信息失败: {e}"))?;

    let r = rows.first().ok_or("未获取到实例信息")?;
    Ok(SsServerInfo {
        server_name:          r.get::<&str, _>(0).unwrap_or("").to_string(),
        version_string:       r.get::<&str, _>(1).unwrap_or("").lines().next().unwrap_or("").to_string(),
        product_version:      r.get::<&str, _>(2).unwrap_or("").to_string(),
        product_level:        r.get::<&str, _>(3).unwrap_or("").to_string(),
        edition:              r.get::<&str, _>(4).unwrap_or("").to_string(),
        engine_edition:       r.get::<i32, _>(5).unwrap_or(0),
        collation:            r.get::<&str, _>(6).unwrap_or("").to_string(),
        is_clustered:         r.get::<i32, _>(7).unwrap_or(0) != 0,
        is_hadr_enabled:      r.get::<i32, _>(8).unwrap_or(0) != 0,
        cpu_count:            r.get::<i32, _>(9).unwrap_or(0),
        physical_memory_mb:   r.get::<i64, _>(10).unwrap_or(0),
        sqlserver_start_time: r.get::<&str, _>(11).unwrap_or("").to_string(),
    })
}
