// db_dba.rs — 跨方言 DBA 面板（会话 / 指标 / 空间 / Top SQL / 锁 / 健康检查）
//
// 统一返回 DbaResult { columns, rows }，前端用一张通用表格渲染。
// MySQL 系 / PG 系：sqlx 直连拼 SQL。
// ClickHouse / SQL Server / SQLite / DuckDB：复用各自 dispatch/query，转 DbaResult。
// Redis / MongoDB：非 SQL，发命令后解析为表格。

use std::collections::HashMap;
use tauri::State;
use sqlx::{Row, Column};
use crate::{
    models::{ConnConfig, ConnType, QueryResult},
    storage::StorageState,
};
use crate::commands::query::{mysql_connect, pg_connect};
use super::sqlserver::{SsPool, dispatch_ss_query};
use super::duckdb::{DuckPool, dispatch_duck_query};
use super::driver::DriverRegistry;

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbaResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

// ── helpers ──────────────────────────────────────────────────────────────────

async fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().unwrap().load()?;
    let config = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

fn from_qr(qr: QueryResult) -> DbaResult { DbaResult { columns: qr.columns, rows: qr.rows } }
fn note(msg: &str) -> DbaResult { DbaResult { columns: vec!["说明".into()], rows: vec![vec![Some(msg.into())]] } }

fn mysql_cell(row: &sqlx::mysql::MySqlRow, idx: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) { return v; }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(idx) { return v.map(|b| String::from_utf8_lossy(&b).into_owned()); }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) { return v.map(|x| x.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) { return v.map(|x| x.to_string()); }
    None
}
fn pg_cell(row: &sqlx::postgres::PgRow, idx: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) { return v; }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) { return v.map(|x| x.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) { return v.map(|x| x.to_string()); }
    None
}
fn sqlite_cell(row: &sqlx::sqlite::SqliteRow, idx: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(idx) { return v; }
    if let Ok(v) = row.try_get::<Option<i64>, _>(idx) { return v.map(|x| x.to_string()); }
    if let Ok(v) = row.try_get::<Option<f64>, _>(idx) { return v.map(|x| x.to_string()); }
    None
}

async fn mysql_exec(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<DbaResult, String> {
    let (mut conn, _t) = mysql_connect(config, password).await?;
    let rows = sqlx::query(sql).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default();
    let out = rows.iter().map(|r| (0..columns.len()).map(|i| mysql_cell(r, i)).collect()).collect();
    Ok(DbaResult { columns, rows: out })
}
async fn pg_exec(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<DbaResult, String> {
    let (mut conn, _t) = pg_connect(config, password).await?;
    let rows = sqlx::query(sql).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default();
    let out = rows.iter().map(|r| (0..columns.len()).map(|i| pg_cell(r, i)).collect()).collect();
    Ok(DbaResult { columns, rows: out })
}
async fn sqlite_exec(config: &ConnConfig, sql: &str) -> Result<DbaResult, String> {
    use sqlx::{sqlite::SqliteConnection, Connection};
    let url = crate::commands::query::sqlite_url(config)?;
    let mut conn = SqliteConnection::connect(&url).await.map_err(|e| format!("打开数据库失败: {e}"))?;
    let rows = sqlx::query(sql).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
    let columns: Vec<String> = rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default();
    let out = rows.iter().map(|r| (0..columns.len()).map(|i| sqlite_cell(r, i)).collect()).collect();
    Ok(DbaResult { columns, rows: out })
}

fn is_mysql_fam(ct: &ConnType) -> bool { matches!(ct, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) }
fn is_pg_fam(ct: &ConnType) -> bool { matches!(ct, ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss) }

// ── MySQL / PG SQL ───────────────────────────────────────────────────────────

fn mysql_sql(ct: &ConnType, kind: &str) -> Option<String> {
    let s = match kind {
        "sessions" => "SELECT CAST(ID AS CHAR) AS `会话ID`, USER AS `用户`, HOST AS `来源`, IFNULL(DB,'') AS `数据库`, COMMAND AS `命令`, CAST(TIME AS CHAR) AS `时长(s)`, IFNULL(STATE,'') AS `状态`, IFNULL(LEFT(INFO,300),'') AS `SQL` FROM information_schema.PROCESSLIST ORDER BY TIME DESC",
        "metrics" => "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Queries','Slow_queries','Com_select','Com_insert','Com_update','Com_delete','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Bytes_sent','Bytes_received','Aborted_connects','Aborted_clients','Open_tables','Table_locks_waited','Created_tmp_disk_tables')",
        "space" => "SELECT TABLE_SCHEMA AS `数据库`, TABLE_NAME AS `表`, CAST(ROUND((DATA_LENGTH+INDEX_LENGTH)/1048576,2) AS CHAR) AS `总大小(MB)`, CAST(ROUND(DATA_LENGTH/1048576,2) AS CHAR) AS `数据(MB)`, CAST(ROUND(INDEX_LENGTH/1048576,2) AS CHAR) AS `索引(MB)`, CAST(IFNULL(TABLE_ROWS,0) AS CHAR) AS `估算行数`, IFNULL(ENGINE,'') AS `引擎` FROM information_schema.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC LIMIT 200",
        "topsql" => "SELECT IFNULL(SCHEMA_NAME,'') AS `库`, LEFT(DIGEST_TEXT,300) AS `SQL摘要`, CAST(COUNT_STAR AS CHAR) AS `执行次数`, CAST(ROUND(SUM_TIMER_WAIT/1e12,3) AS CHAR) AS `总耗时(s)`, CAST(ROUND(AVG_TIMER_WAIT/1e9,3) AS CHAR) AS `平均(ms)`, CAST(SUM_ROWS_EXAMINED AS CHAR) AS `扫描行`, CAST(SUM_ROWS_SENT AS CHAR) AS `返回行` FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 50",
        "locks" => if matches!(ct, ConnType::Mariadb) {
            "SELECT CAST(r.trx_mysql_thread_id AS CHAR) AS `等待线程`, IFNULL(LEFT(r.trx_query,200),'') AS `等待SQL`, CAST(b.trx_mysql_thread_id AS CHAR) AS `阻塞线程`, IFNULL(LEFT(b.trx_query,200),'') AS `阻塞SQL`, CAST(TIMESTAMPDIFF(SECOND,r.trx_wait_started,NOW()) AS CHAR) AS `等待(s)` FROM information_schema.INNODB_LOCK_WAITS w JOIN information_schema.INNODB_TRX r ON r.trx_id=w.requesting_trx_id JOIN information_schema.INNODB_TRX b ON b.trx_id=w.blocking_trx_id"
        } else {
            "SELECT CAST(r.trx_mysql_thread_id AS CHAR) AS `等待线程`, IFNULL(LEFT(r.trx_query,200),'') AS `等待SQL`, CAST(b.trx_mysql_thread_id AS CHAR) AS `阻塞线程`, IFNULL(LEFT(b.trx_query,200),'') AS `阻塞SQL`, CAST(TIMESTAMPDIFF(SECOND,r.trx_wait_started,NOW()) AS CHAR) AS `等待(s)` FROM performance_schema.data_lock_waits w JOIN information_schema.innodb_trx r ON r.trx_id=w.requesting_engine_transaction_id JOIN information_schema.innodb_trx b ON b.trx_id=w.blocking_engine_transaction_id"
        },
        _ => return None,
    };
    Some(s.to_string())
}

fn pg_sql(kind: &str) -> Option<String> {
    let s = match kind {
        "sessions" => "SELECT pid::text AS \"会话PID\", usename AS \"用户\", COALESCE(application_name,'') AS \"应用\", COALESCE(client_addr::text,'') AS \"来源\", state AS \"状态\", COALESCE(wait_event_type,'') AS \"等待类型\", COALESCE(left(query,300),'') AS \"SQL\", COALESCE(date_trunc('second', now()-query_start)::text,'') AS \"持续\" FROM pg_stat_activity WHERE backend_type='client backend' ORDER BY query_start NULLS LAST",
        "metrics" => "SELECT '活动连接' AS \"指标\", count(*) FILTER (WHERE state='active')::text AS \"值\" FROM pg_stat_activity UNION ALL SELECT '总连接', count(*)::text FROM pg_stat_activity UNION ALL SELECT 'max_connections', setting FROM pg_settings WHERE name='max_connections' UNION ALL SELECT '事务提交', COALESCE(sum(xact_commit),0)::text FROM pg_stat_database UNION ALL SELECT '事务回滚', COALESCE(sum(xact_rollback),0)::text FROM pg_stat_database UNION ALL SELECT '缓存命中率', COALESCE(round(sum(blks_hit)*100.0/nullif(sum(blks_hit)+sum(blks_read),0),2),0)::text||'%' FROM pg_stat_database UNION ALL SELECT '死锁累计', COALESCE(sum(deadlocks),0)::text FROM pg_stat_database UNION ALL SELECT '当前库大小', pg_size_pretty(pg_database_size(current_database())) UNION ALL SELECT '运行时长', date_trunc('second', now()-pg_postmaster_start_time())::text",
        "space" => "SELECT schemaname AS \"模式\", relname AS \"表\", pg_size_pretty(pg_total_relation_size(relid)) AS \"总大小\", pg_size_pretty(pg_relation_size(relid)) AS \"数据\", pg_size_pretty(pg_indexes_size(relid)) AS \"索引\", COALESCE(n_live_tup,0)::text AS \"估算行数\" FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 200",
        "topsql" => "SELECT left(query,300) AS \"SQL\", calls::text AS \"执行次数\", round(total_exec_time::numeric,2)::text AS \"总耗时(ms)\", round(mean_exec_time::numeric,3)::text AS \"平均(ms)\", rows::text AS \"返回行\" FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 50",
        "locks" => "SELECT bl.pid::text AS \"等待PID\", a.usename AS \"等待用户\", COALESCE(left(a.query,200),'') AS \"等待SQL\", kl.pid::text AS \"阻塞PID\", ka.usename AS \"阻塞用户\", COALESCE(left(ka.query,200),'') AS \"阻塞SQL\" FROM pg_locks bl JOIN pg_stat_activity a ON a.pid=bl.pid JOIN pg_locks kl ON kl.locktype=bl.locktype AND kl.database IS NOT DISTINCT FROM bl.database AND kl.relation IS NOT DISTINCT FROM bl.relation AND kl.pid<>bl.pid AND kl.granted JOIN pg_stat_activity ka ON ka.pid=kl.pid WHERE NOT bl.granted",
        _ => return None,
    };
    Some(s.to_string())
}

// ── ClickHouse SQL ───────────────────────────────────────────────────────────

fn ch_sql(kind: &str) -> Option<String> {
    let s = match kind {
        "sessions" => "SELECT query_id AS `查询ID`, user AS `用户`, query_kind AS `类型`, formatReadableTimeDelta(elapsed) AS `已运行`, toString(read_rows) AS `读行`, formatReadableSize(memory_usage) AS `内存`, substring(query,1,300) AS `SQL` FROM system.processes ORDER BY elapsed DESC",
        "metrics" => "SELECT metric AS `指标`, toString(value) AS `值` FROM system.metrics WHERE metric IN ('Query','Merge','PartMutation','ReplicatedFetch','ReplicatedSend','BackgroundMergesAndMutationsPoolTask','TCPConnection','HTTPConnection','MemoryTracking','ReadonlyReplica','DistributedSend','DelayedInserts') ORDER BY metric",
        "space" => "SELECT database AS `库`, table AS `表`, formatReadableSize(sum(bytes_on_disk)) AS `磁盘大小`, toString(sum(rows)) AS `行数`, toString(count()) AS `分片数` FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT 200",
        "topsql" => "SELECT substring(query,1,300) AS `SQL`, toString(count()) AS `次数`, toString(round(avg(query_duration_ms),2)) AS `平均ms`, toString(sum(read_rows)) AS `读行`, formatReadableSize(sum(read_bytes)) AS `读字节` FROM system.query_log WHERE type=2 AND event_time > now()-3600 GROUP BY query ORDER BY avg(query_duration_ms) DESC LIMIT 50",
        "locks" => "SELECT database AS `库`, table AS `表`, formatReadableTimeDelta(elapsed) AS `已运行`, toString(round(progress,3)) AS `进度`, toString(num_parts) AS `分片数`, is_mutation AS `是否变更` FROM system.merges ORDER BY elapsed DESC",
        _ => return None,
    };
    Some(s.to_string())
}

// ── SQL Server SQL ───────────────────────────────────────────────────────────

fn ss_sql(kind: &str) -> Option<String> {
    let s = match kind {
        "sessions" => "SELECT s.session_id AS [会话ID], s.login_name AS [登录名], ISNULL(s.host_name,'') AS [主机], ISNULL(s.program_name,'') AS [程序], s.status AS [状态], ISNULL(r.command,'') AS [命令], ISNULL(SUBSTRING(t.text,1,300),'') AS [SQL] FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id=s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE s.is_user_process=1 ORDER BY s.session_id",
        "metrics" => "SELECT [指标],[值] FROM (SELECT 1 o,'版本' AS [指标], CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) AS [值] UNION ALL SELECT 2,'版次', CAST(SERVERPROPERTY('Edition') AS varchar(80)) UNION ALL SELECT 3,'用户连接数', CAST(COUNT(*) AS varchar(20)) FROM sys.dm_exec_sessions WHERE is_user_process=1 UNION ALL SELECT 4,'活动请求', CAST(COUNT(*) AS varchar(20)) FROM sys.dm_exec_requests WHERE session_id>50 UNION ALL SELECT 5,'阻塞请求', CAST(COUNT(*) AS varchar(20)) FROM sys.dm_exec_requests WHERE blocking_session_id<>0) x ORDER BY o",
        "space" => "SELECT DB_NAME() AS [库], t.name AS [表], CAST(CAST(SUM(a.total_pages)*8/1024.0 AS decimal(12,2)) AS varchar(30)) AS [大小MB], CAST(SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS varchar(20)) AS [行数] FROM sys.tables t JOIN sys.partitions p ON p.object_id=t.object_id JOIN sys.allocation_units a ON a.container_id=p.partition_id GROUP BY t.name ORDER BY SUM(a.total_pages) DESC",
        "topsql" => "SELECT TOP 50 SUBSTRING(t.text,1,300) AS [SQL], CAST(qs.execution_count AS varchar(20)) AS [执行次数], CAST(qs.total_elapsed_time/1000 AS varchar(20)) AS [总耗时ms], CAST(qs.total_elapsed_time/NULLIF(qs.execution_count,0)/1000 AS varchar(20)) AS [平均ms], CAST(qs.total_logical_reads AS varchar(20)) AS [逻辑读] FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t ORDER BY qs.total_elapsed_time DESC",
        "locks" => "SELECT CAST(r.session_id AS varchar(20)) AS [等待会话], CAST(r.blocking_session_id AS varchar(20)) AS [阻塞会话], r.wait_type AS [等待类型], CAST(r.wait_time AS varchar(20)) AS [等待ms], ISNULL(SUBSTRING(t.text,1,200),'') AS [SQL] FROM sys.dm_exec_requests r OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.blocking_session_id<>0",
        _ => return None,
    };
    Some(s.to_string())
}

// ── SQLite / DuckDB ──────────────────────────────────────────────────────────

fn sqlite_sql(kind: &str) -> Option<String> {
    let s = match kind {
        "metrics" => "SELECT '页数' AS 指标, CAST((SELECT page_count FROM pragma_page_count()) AS TEXT) AS 值 \
            UNION ALL SELECT '页大小', CAST((SELECT page_size FROM pragma_page_size()) AS TEXT) \
            UNION ALL SELECT '空闲页', CAST((SELECT freelist_count FROM pragma_freelist_count()) AS TEXT) \
            UNION ALL SELECT '数据库大小(MB)', CAST(ROUND((SELECT page_count FROM pragma_page_count())*(SELECT page_size FROM pragma_page_size())/1048576.0,2) AS TEXT) \
            UNION ALL SELECT '日志模式', (SELECT journal_mode FROM pragma_journal_mode()) \
            UNION ALL SELECT 'SQLite版本', sqlite_version()",
        "space" => "SELECT name AS 名称, type AS 类型, IFNULL(tbl_name,'') AS 所属表 FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, tbl_name, name",
        "health" => "SELECT '完整性' AS 类别, '快速校验' AS 检查项, CASE WHEN (SELECT quick_check FROM pragma_quick_check() LIMIT 1)='ok' THEN '正常' ELSE '警告' END AS 状态, (SELECT quick_check FROM pragma_quick_check() LIMIT 1) AS 详情 \
            UNION ALL SELECT '存储','空闲页比例','信息', CAST((SELECT freelist_count FROM pragma_freelist_count()) AS TEXT)||' / '||CAST((SELECT page_count FROM pragma_page_count()) AS TEXT) \
            UNION ALL SELECT '配置','外键约束', CASE WHEN (SELECT foreign_keys FROM pragma_foreign_keys())=1 THEN '正常' ELSE '提示' END, CASE WHEN (SELECT foreign_keys FROM pragma_foreign_keys())=1 THEN '已开启' ELSE '未开启' END",
        _ => return None,
    };
    Some(s.to_string())
}

fn duck_sql(kind: &str) -> Option<String> {
    let s = match kind {
        "metrics" => "SELECT database_name AS 库, CAST(database_size AS VARCHAR) AS 大小, CAST(memory_usage AS VARCHAR) AS 内存占用, CAST(memory_limit AS VARCHAR) AS 内存上限, CAST(wal_size AS VARCHAR) AS WAL, CAST(block_size AS VARCHAR) AS 块大小 FROM pragma_database_size()",
        "space" => "SELECT schema_name AS 模式, table_name AS 表, CAST(estimated_size AS VARCHAR) AS 估算行数, CAST(column_count AS VARCHAR) AS 列数, CAST(index_count AS VARCHAR) AS 索引数 FROM duckdb_tables() ORDER BY estimated_size DESC LIMIT 200",
        "health" => "SELECT '实例' AS 类别, 'DuckDB版本' AS 检查项, '信息' AS 状态, version() AS 详情 UNION ALL SELECT '存储','数据库大小','信息',(SELECT CAST(database_size AS VARCHAR) FROM pragma_database_size() LIMIT 1) UNION ALL SELECT '内存','内存占用','信息',(SELECT CAST(memory_usage AS VARCHAR) FROM pragma_database_size() LIMIT 1)",
        _ => return None,
    };
    Some(s.to_string())
}

// ── 命令：通用查询 ────────────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_dba_query(
    id: String,
    kind: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<DbaResult, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let ct = config.conn_type.clone();
    let pwd = password.as_deref();

    if is_mysql_fam(&ct) {
        let sql = mysql_sql(&ct, &kind).ok_or_else(|| "不支持的查询类型".to_string())?;
        return mysql_exec(&config, pwd, &sql).await.map_err(|e| friendly_err(&kind, &e));
    }
    if is_pg_fam(&ct) {
        let sql = pg_sql(&kind).ok_or_else(|| "不支持的查询类型".to_string())?;
        return pg_exec(&config, pwd, &sql).await.map_err(|e| friendly_err(&kind, &e));
    }
    match ct {
        ConnType::ClickHouse => {
            let sql = ch_sql(&kind).ok_or_else(|| "不支持的查询类型".to_string())?;
            super::clickhouse::query(&config, pwd, &sql).await.map(from_qr).map_err(|e| friendly_err(&kind, &e))
        }
        ConnType::SqlServer => {
            let sql = ss_sql(&kind).ok_or_else(|| "不支持的查询类型".to_string())?;
            dispatch_ss_query(&id, &config, &sql, &ss_pool).await.map(from_qr).map_err(|e| friendly_err(&kind, &e))
        }
        ConnType::Sqlite => match kind.as_str() {
            "sessions" | "locks" => Ok(note("SQLite 为嵌入式数据库，无会话 / 锁概念")),
            "topsql" => Ok(note("SQLite 不提供查询统计")),
            _ => { let sql = sqlite_sql(&kind).ok_or_else(|| "不支持的查询类型".to_string())?; sqlite_exec(&config, &sql).await }
        },
        ConnType::Duckdb => match kind.as_str() {
            "sessions" | "locks" => Ok(note("DuckDB 为嵌入式数据库，无会话 / 锁概念")),
            "topsql" => Ok(note("DuckDB 不提供查询统计")),
            _ => { let sql = duck_sql(&kind).ok_or_else(|| "不支持的查询类型".to_string())?; dispatch_duck_query(&id, &config, &sql, &duck_pool, &registry).await.map(from_qr) }
        },
        _ => Err("该数据库类型的 DBA 面板暂未支持".into()),
    }
}

fn friendly_err(kind: &str, e: &str) -> String {
    let low = e.to_lowercase();
    // 权限不足（MySQL 1142 / PG 42501 / 各类 access denied）：给出按需权限提示，不再甩裸 SQL 错误
    let denied = low.contains("command denied") || low.contains("1142")
        || low.contains("access denied") || low.contains("permission denied")
        || low.contains("42501") || low.contains("insufficient privilege");
    if denied {
        return match kind {
            "sessions" => "当前账号权限不足：查看全部会话需 PROCESS 权限（MySQL）或相应监控权限。低权限账号通常只能看到自己的连接。".into(),
            "space"    => "当前账号权限不足：空间统计需对 information_schema 的访问权限。".into(),
            "topsql"   => "当前账号权限不足：Top SQL 需要 performance_schema（MySQL）/ pg_stat_statements（PG）的 SELECT 权限。".into(),
            "locks"    => "当前账号权限不足：锁与阻塞分析需要 performance_schema / information_schema 锁视图的 SELECT 权限。".into(),
            "metrics"  => "当前账号权限不足：实例指标需要 SHOW STATUS / 监控视图权限。".into(),
            _          => "当前账号权限不足，无法读取该指标，请改用更高权限的账号。".into(),
        };
    }
    if kind == "topsql" && (low.contains("pg_stat_statements") || low.contains("doesn't exist") || low.contains("does not exist") || low.contains("events_statements_summary") || low.contains("query_log")) {
        return "Top SQL 需开启统计组件：MySQL/MariaDB 启用 performance_schema；PostgreSQL 安装 pg_stat_statements；ClickHouse 启用 query_log。".into();
    }
    if kind == "locks" && (low.contains("doesn't exist") || low.contains("does not exist")) {
        return "当前实例不支持该锁视图（或无阻塞）。".into();
    }
    format!("查询失败: {e}")
}

// ── 命令：健康检查 ────────────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_dba_health(
    id: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<DbaResult, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let ct = config.conn_type.clone();
    let pwd = password.as_deref();
    let columns = vec!["类别".to_string(), "检查项".to_string(), "状态".to_string(), "详情".to_string()];

    if is_mysql_fam(&ct) {
        let (mut conn, _t) = mysql_connect(&config, pwd).await?;
        let mut m: HashMap<String, f64> = HashMap::new();
        let mut sm: HashMap<String, String> = HashMap::new();
        for r in &sqlx::query("SHOW GLOBAL STATUS").fetch_all(&mut conn).await.map_err(|e| e.to_string())? {
            let k = mysql_cell(r, 0).unwrap_or_default(); let v = mysql_cell(r, 1).unwrap_or_default();
            if let Ok(n) = v.parse::<f64>() { m.insert(k.clone(), n); }
            sm.insert(k, v);
        }
        for r in &sqlx::query("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','version')").fetch_all(&mut conn).await.map_err(|e| e.to_string())? {
            sm.insert(mysql_cell(r, 0).unwrap_or_default(), mysql_cell(r, 1).unwrap_or_default());
        }
        let g = |k: &str| m.get(k).copied().unwrap_or(0.0);
        let max_conn = sm.get("max_connections").and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let conn_now = g("Threads_connected");
        let conn_pct = if max_conn > 0.0 { conn_now / max_conn * 100.0 } else { 0.0 };
        let rr = g("Innodb_buffer_pool_read_requests"); let rd = g("Innodb_buffer_pool_reads");
        let hit = if rr > 0.0 { (1.0 - rd / rr) * 100.0 } else { 100.0 };
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut push = |c: &str, i: &str, s: &str, d: String| rows.push(vec![Some(c.into()), Some(i.into()), Some(s.into()), Some(d)]);
        push("实例", "版本", "信息", sm.get("version").cloned().unwrap_or_default());
        push("实例", "运行时长", "信息", fmt_uptime(g("Uptime")));
        push("连接", "连接使用率", if conn_pct >= 85.0 { "警告" } else { "正常" }, format!("{conn_now:.0} / {max_conn:.0}（{conn_pct:.1}%）"));
        push("连接", "中断连接(Aborted_connects)", if g("Aborted_connects") > 0.0 { "警告" } else { "正常" }, format!("{:.0}", g("Aborted_connects")));
        push("性能", "InnoDB 缓冲池命中率", if hit < 99.0 { "警告" } else { "正常" }, format!("{hit:.2}%"));
        push("性能", "慢查询(Slow_queries)", if g("Slow_queries") > 0.0 { "提示" } else { "正常" }, format!("{:.0}", g("Slow_queries")));
        push("性能", "磁盘临时表(Created_tmp_disk_tables)", if g("Created_tmp_disk_tables") > 0.0 { "提示" } else { "正常" }, format!("{:.0}", g("Created_tmp_disk_tables")));
        push("锁", "等待表锁(Table_locks_waited)", if g("Table_locks_waited") > 0.0 { "提示" } else { "正常" }, format!("{:.0}", g("Table_locks_waited")));
        return Ok(DbaResult { columns, rows });
    }
    if is_pg_fam(&ct) {
        let sql = "SELECT '实例' AS c, '版本' AS i, '信息' AS s, current_setting('server_version') AS d \
            UNION ALL SELECT '实例','运行时长','信息', date_trunc('second', now()-pg_postmaster_start_time())::text \
            UNION ALL SELECT '连接','连接使用率', CASE WHEN (SELECT count(*) FROM pg_stat_activity)::float/NULLIF(current_setting('max_connections')::float,0) >= 0.85 THEN '警告' ELSE '正常' END, (SELECT count(*) FROM pg_stat_activity)::text||' / '||current_setting('max_connections') \
            UNION ALL SELECT '性能','缓存命中率', CASE WHEN COALESCE((SELECT round(sum(blks_hit)*100.0/nullif(sum(blks_hit)+sum(blks_read),0),2) FROM pg_stat_database),100) < 99 THEN '警告' ELSE '正常' END, COALESCE((SELECT round(sum(blks_hit)*100.0/nullif(sum(blks_hit)+sum(blks_read),0),2) FROM pg_stat_database),100)::text||'%' \
            UNION ALL SELECT '性能','累计死锁', CASE WHEN COALESCE((SELECT sum(deadlocks) FROM pg_stat_database),0) > 0 THEN '警告' ELSE '正常' END, COALESCE((SELECT sum(deadlocks) FROM pg_stat_database),0)::text \
            UNION ALL SELECT '事务','空闲事务(idle in transaction)', CASE WHEN (SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction') > 0 THEN '提示' ELSE '正常' END, (SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction')::text \
            UNION ALL SELECT '锁','未授予锁(阻塞)', CASE WHEN (SELECT count(*) FROM pg_locks WHERE NOT granted) > 0 THEN '警告' ELSE '正常' END, (SELECT count(*) FROM pg_locks WHERE NOT granted)::text";
        return pg_exec(&config, pwd, sql).await.map_err(|e| format!("健康检查失败: {e}"));
    }
    match ct {
        ConnType::ClickHouse => {
            let sql = "SELECT '实例' AS `类别`,'版本' AS `检查项`,'信息' AS `状态`, version() AS `详情` \
                UNION ALL SELECT '实例','运行时长','信息', formatReadableTimeDelta(uptime()) \
                UNION ALL SELECT '负载','当前查询', if((SELECT count() FROM system.processes)>50,'提示','正常'), toString((SELECT count() FROM system.processes)) \
                UNION ALL SELECT '副本','只读副本', if((SELECT value FROM system.metrics WHERE metric='ReadonlyReplica')>0,'警告','正常'), toString((SELECT value FROM system.metrics WHERE metric='ReadonlyReplica')) \
                UNION ALL SELECT '内存','内存追踪','信息', formatReadableSize((SELECT value FROM system.metrics WHERE metric='MemoryTracking'))";
            return super::clickhouse::query(&config, pwd, sql).await.map(from_qr).map_err(|e| format!("健康检查失败: {e}"));
        }
        ConnType::SqlServer => {
            let sql = "SELECT [类别],[检查项],[状态],[详情] FROM (\
                SELECT 1 o,'实例' [类别],'版本' [检查项],'信息' [状态], CAST(SERVERPROPERTY('ProductVersion') AS varchar(50)) [详情] \
                UNION ALL SELECT 2,'连接','用户连接数','信息', CAST((SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process=1) AS varchar(20)) \
                UNION ALL SELECT 3,'锁','阻塞请求', CASE WHEN (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id<>0)>0 THEN '警告' ELSE '正常' END, CAST((SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id<>0) AS varchar(20)) \
                ) x ORDER BY o";
            return dispatch_ss_query(&id, &config, sql, &ss_pool).await.map(from_qr).map_err(|e| format!("健康检查失败: {e}"));
        }
        ConnType::Sqlite => {
            let sql = sqlite_sql("health").unwrap();
            return sqlite_exec(&config, &sql).await.map_err(|e| format!("健康检查失败: {e}"));
        }
        ConnType::Duckdb => {
            let sql = duck_sql("health").unwrap();
            return dispatch_duck_query(&id, &config, &sql, &duck_pool, &registry).await.map(from_qr).map_err(|e| format!("健康检查失败: {e}"));
        }
        _ => Err("该数据库类型的 DBA 面板暂未支持".into()),
    }
}

fn fmt_uptime(secs: f64) -> String {
    let s = secs as u64;
    let d = s / 86400; let h = (s % 86400) / 3600; let m = (s % 3600) / 60;
    if d > 0 { format!("{d}天 {h}小时 {m}分") } else if h > 0 { format!("{h}小时 {m}分") } else { format!("{m}分") }
}

// ── 命令：终止会话 ────────────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_dba_kill_session(
    id: String,
    session_id: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let ct = config.conn_type.clone();
    let pwd = password.as_deref();
    let numeric = !session_id.is_empty() && session_id.chars().all(|c| c.is_ascii_digit());

    if is_mysql_fam(&ct) {
        if !numeric { return Err("无效的会话 ID".into()); }
        let (mut conn, _t) = mysql_connect(&config, pwd).await?;
        sqlx::query(&format!("KILL {session_id}")).execute(&mut conn).await.map_err(|e| e.to_string())?;
        return Ok(format!("已终止会话 {session_id}"));
    }
    if is_pg_fam(&ct) {
        if !numeric { return Err("无效的会话 ID".into()); }
        let (mut conn, _t) = pg_connect(&config, pwd).await?;
        sqlx::query(&format!("SELECT pg_terminate_backend({session_id})")).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
        return Ok(format!("已终止会话 {session_id}"));
    }
    match ct {
        ConnType::SqlServer => {
            if !numeric { return Err("无效的会话 ID".into()); }
            dispatch_ss_query(&id, &config, &format!("KILL {session_id}"), &ss_pool).await?;
            Ok(format!("已终止会话 {session_id}"))
        }
        ConnType::ClickHouse => {
            // query_id 为字符串，转义单引号
            let qid = session_id.replace('\'', "''");
            super::clickhouse::query(&config, pwd, &format!("KILL QUERY WHERE query_id='{qid}'")).await?;
            Ok("已发送终止查询请求".into())
        }
        _ => Err("该数据库类型不支持终止会话".into()),
    }
}
