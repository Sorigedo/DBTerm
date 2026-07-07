// db_tx.rs — 持久事务支持
//
// 每个连接 ID 最多持有一个活跃事务连接。
// 所有事务期间的查询都通过持久连接执行，而非新建连接。
// 事务连接被 Drop 时，SQLx 自动回滚未提交的事务（安全保底）。
//
// 与 SSH 侧完全无关，只操作 DB 连接。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use crate::{
    models::{ConnConfig, ConnType, QueryResult},
    storage::StorageState,
};
use super::duckdb::{DuckPool, dispatch_duck_query};
use super::sqlserver::{SsPool, dispatch_ss_query};
use super::oracle::{OracleTxPool, oracle_begin_tx, oracle_exec_in_tx, oracle_commit_tx, oracle_rollback_tx};
use super::driver::DriverRegistry;

// ── 事务连接类型 ─────────────────────────────────────────────────────────────

pub enum TxConn {
    MySql(sqlx::mysql::MySqlConnection),
    Pg(sqlx::postgres::PgConnection),
    Sqlite(sqlx::sqlite::SqliteConnection),
    // DuckDB/SqlServer/Oracle 使用连接池或持久句柄，此变体仅存连接 ID
    Duckdb(String),
    SqlServer(String),
    Oracle(String),
}

#[allow(dead_code)]
pub struct ActiveTx {
    pub conn: TxConn,
    pub started_at: Instant,
    /// 最近一次执行语句的时刻：僵尸回收按「空闲时长」判定，避免误杀活跃的长事务。
    pub last_used: Instant,
    /// 事务级只读：连接标记只读时，BEGIN 用 READ ONLY 起，并在 exec 处拦截写语句（双保险）。
    pub read_only: bool,
}

/// 全局事务状态：每个 DB 连接 ID 最多一个活跃事务。
/// 两级锁：外层 map 锁只在「取出/插入/移除 per-连接锁」时瞬时持有；
/// DB 查询 / COMMIT / ROLLBACK 的 await 只持有内层 per-连接锁。
/// 这样连接 A 的事务语句在 DB 层阻塞（等行锁）时，不会占住全局锁把连接 B 的
/// commit/rollback 也挡住——避免「A 等 B 的行锁、B 等 A 的应用锁」式应用级死锁。
pub type TxState = Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<ActiveTx>>>>>;

// ── 辅助 ─────────────────────────────────────────────────────────────────────

async fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let cfg = storage.lock().unwrap().load()?;
    let config = cfg.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

const CLIENT_TAG: &str = "/* DBTerm */";
fn tag(s: &str) -> String { format!("{CLIENT_TAG} {s}") }

// ── 建立持久连接（复用 db_extra 的连接逻辑，但返回裸 Connection） ─────────────

async fn open_mysql(config: &ConnConfig, password: Option<&str>)
    -> Result<sqlx::mysql::MySqlConnection, String>
{
    use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions, MySqlSslMode}};
    use crate::commands::query::MySqlPwdExt;
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};

    #[derive(serde::Deserialize, Default)]
    struct Cfg {
        #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
        #[serde(rename = "sslMode",  default)] ssl_mode: String,
        #[serde(rename = "sslCa",   default)] ssl_ca:   String,
        #[serde(rename = "sslCert", default)] ssl_cert:  String,
        #[serde(rename = "sslKey",  default)] ssl_key:   String,
        #[serde(rename = "sshTunnel",   default)] ssh_tunnel:  bool,
        #[serde(rename = "sshHost",     default)] ssh_host:    String,
        #[serde(rename = "sshPort",     default)] ssh_port:    u16,
        #[serde(rename = "sshUser",     default)] ssh_user:    String,
        #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
        #[serde(rename = "sshPassword", default)] ssh_password: String,
        #[serde(rename = "sshKeyPath",  default)] ssh_key_path: String,
    }
    let cfg: Cfg = config.extra_json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let timeout = std::time::Duration::from_secs(
        if cfg.connect_timeout == 0 { 30 } else { cfg.connect_timeout.clamp(3, 300) }
    );
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    // SSH 隧道：使用全局共享池（隧道在应用生命周期内保持，事务期间不会断开）
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(3306)).await?;
        ("127.0.0.1".to_string(), t.local_port)
    } else {
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(),
         config.port.unwrap_or(3306))
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&h).port(p).username(user).password_opt(pwd);
    if !db.is_empty() { opts = opts.database(db); }
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => MySqlSslMode::Required,
        "verify-ca"   => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _             => MySqlSslMode::Disabled,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let conn = tokio::time::timeout(timeout, opts.connect())
        .await.map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;
    Ok(conn)
}

async fn open_pg(config: &ConnConfig, password: Option<&str>)
    -> Result<sqlx::postgres::PgConnection, String>
{
    use sqlx::{ConnectOptions, postgres::{PgConnectOptions, PgSslMode}};
    use crate::tester::expand_home;

    #[derive(serde::Deserialize, Default)]
    struct Cfg {
        #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
        #[serde(rename = "sslMode",  default)] ssl_mode: String,
        #[serde(rename = "sslCa",   default)] ssl_ca:   String,
        #[serde(rename = "sslCert", default)] ssl_cert:  String,
        #[serde(rename = "sslKey",  default)] ssl_key:   String,
    }
    let cfg: Cfg = config.extra_json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let timeout = std::time::Duration::from_secs(
        if cfg.connect_timeout == 0 { 30 } else { cfg.connect_timeout.clamp(3, 300) }
    );
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(5432);

    let mut opts = PgConnectOptions::new()
        .host(host).port(port).username(user).password(pwd).database(db)
        .application_name("DBTerm");
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => PgSslMode::Require,
        "verify-ca"   => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _             => PgSslMode::Disable,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let conn = tokio::time::timeout(timeout, opts.connect())
        .await.map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;
    Ok(conn)
}

// ── 执行任意查询并转换为 QueryResult ─────────────────────────────────────────

async fn run_on_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
) -> Result<QueryResult, String> {
    use sqlx::{Row, Column, TypeInfo};
    let tagged = tag(sql);
    let t0 = Instant::now();

    // 关键：MySQL 下 DML 经 fetch_all 已执行一次（返回 Ok+空集），绝不能在 is_empty 分支再 execute 一次，
    // 否则事务内 INSERT/UPDATE/DELETE 会被执行两遍。判据与 PG/SQLite 一致：fetch_all 出 Err 才当 DML 走 execute。
    match sqlx::query(&tagged).fetch_all(&mut *conn).await {
        Ok(rows) => {
            let elapsed = t0.elapsed().as_millis() as u64;
            if rows.is_empty() {
                return Ok(QueryResult {
                    columns: vec![], rows: vec![],
                    rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: true,
                });
            }
            let columns: Vec<String> = rows[0].columns()
                .iter().map(|c| c.name().to_string()).collect();
            let result_rows: Vec<Vec<Option<String>>> = rows.iter().map(|row| {
                columns.iter().enumerate().map(|(i, _)| {
                    let ti = row.column(i).type_info();
                    let tn = ti.name();
                    if matches!(tn, "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "TINYBLOB") {
                        return Some("<BLOB>".to_string());
                    }
                    row.try_get::<Option<String>, _>(i).ok().flatten()
                }).collect()
            }).collect();
            let row_count = result_rows.len() as u64;
            Ok(QueryResult {
                columns, rows: result_rows,
                rows_affected: row_count, execution_time_ms: elapsed, truncated: false, is_select: true,
            })
        }
        Err(_) => {
            let affected = sqlx::query(&tagged)
                .execute(&mut *conn).await
                .map(|r| r.rows_affected())
                .map_err(|e| format!("{e}"))?;
            let elapsed = t0.elapsed().as_millis() as u64;
            Ok(QueryResult {
                columns: vec![], rows: vec![],
                rows_affected: affected, execution_time_ms: elapsed, truncated: false, is_select: false,
            })
        }
    }
}

async fn mysql_exec_text(conn: &mut sqlx::mysql::MySqlConnection, sql: &str) -> Result<(), String> {
    use sqlx::Executor;
    conn.execute(sqlx::raw_sql(sql)).await
        .map(|_| ())
        .map_err(|e| format!("{e}"))
}

async fn run_on_pg(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
) -> Result<QueryResult, String> {
    use sqlx::{Row, Column, TypeInfo};
    let tagged = tag(sql);
    let t0 = Instant::now();
    let elapsed;

    // 先尝试 SELECT
    match sqlx::query(&tagged).fetch_all(&mut *conn).await {
        Ok(rows) => {
            elapsed = t0.elapsed().as_millis() as u64;
            if rows.is_empty() {
                return Ok(QueryResult {
                    columns: vec![], rows: vec![],
                    rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: true,
                });
            }
            let columns: Vec<String> = rows[0].columns()
                .iter().map(|c| c.name().to_string()).collect();
            let result_rows = rows.iter().map(|row| {
                columns.iter().enumerate().map(|(i, _)| {
                    let ti = row.column(i).type_info();
                    if ti.name() == "BYTEA" { return Some("<BYTEA>".to_string()); }
                    row.try_get::<Option<String>, _>(i).ok().flatten()
                }).collect()
            }).collect();
            Ok(QueryResult { columns, rows: result_rows, rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: true })
        }
        Err(_) => {
            // 可能是 DML，尝试 execute
            let affected = sqlx::query(&tagged)
                .execute(&mut *conn).await
                .map(|r| r.rows_affected())
                .map_err(|e| format!("{e}"))?;
            elapsed = t0.elapsed().as_millis() as u64;
            Ok(QueryResult {
                columns: vec![], rows: vec![],
                rows_affected: affected, execution_time_ms: elapsed, truncated: false, is_select: false,
            })
        }
    }
}

async fn open_sqlite(config: &ConnConfig) -> Result<sqlx::sqlite::SqliteConnection, String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{ConnectOptions, Connection, sqlite::{SqliteConnectOptions, SqliteConnection}};
    use std::str::FromStr;
    let url = sqlite_url(config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .log_statements(log::LevelFilter::Off);
    SqliteConnection::connect_with(&opts).await
        .map_err(|e| format!("SQLite 连接失败: {e}"))
}

async fn run_on_sqlite(
    conn: &mut sqlx::sqlite::SqliteConnection,
    sql:  &str,
) -> Result<QueryResult, String> {
    use sqlx::{Row, Column};
    let t0 = Instant::now();

    match sqlx::query(sql).fetch_all(&mut *conn).await {
        Ok(rows) => {
            let elapsed = t0.elapsed().as_millis() as u64;
            if rows.is_empty() {
                return Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: false });
            }
            let columns: Vec<String> = rows[0].columns()
                .iter().map(|c| c.name().to_string()).collect();
            let result_rows = rows.iter().map(|row| {
                columns.iter().enumerate().map(|(i, _)| {
                    row.try_get::<Option<String>, _>(i).ok().flatten()
                        .or_else(|| row.try_get::<Option<i64>, _>(i).ok().flatten().map(|v| v.to_string()))
                        .or_else(|| row.try_get::<Option<f64>, _>(i).ok().flatten().map(|v| v.to_string()))
                }).collect()
            }).collect();
            Ok(QueryResult { columns, rows: result_rows, rows_affected: 0, execution_time_ms: elapsed, truncated: false, is_select: true })
        }
        Err(_) => {
            let affected = sqlx::query(sql)
                .execute(&mut *conn).await
                .map(|r| r.rows_affected())
                .map_err(|e| format!("{e}"))?;
            let elapsed = t0.elapsed().as_millis() as u64;
            Ok(QueryResult { columns: vec![], rows: vec![], rows_affected: affected, execution_time_ms: elapsed, truncated: false, is_select: false })
        }
    }
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 开始事务：建立持久连接并执行 BEGIN
#[tauri::command]
pub async fn db_begin_tx(
    id: String,
    database: Option<String>,
    storage: State<'_, StorageState>,
    tx_state: State<'_, TxState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    oracle_tx_pool: State<'_, OracleTxPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 检查是否已有活跃事务
    {
        let guard = tx_state.lock().await;
        if guard.contains_key(&id) {
            return Err("此连接已有活跃事务，请先提交或回滚".to_string());
        }
    }

    let (mut config, password) = load_conn(&id, &storage).await?;
    let pwd = password.as_deref();
    // 只读连接：事务整体以 READ ONLY 起，写操作由引擎直接拒绝（最强保证）
    let read_only = config.read_only == Some(true);

    let conn = match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                config.database = Some(db.to_string());
            }
            let mut c = open_mysql(&config, pwd).await?;
            if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
                mysql_exec_text(&mut c, &format!("USE `{}`", db.replace('`', "``"))).await
                    .map_err(|e| format!("切换数据库失败: {e}"))?;
            }
            let begin = if read_only { "START TRANSACTION READ ONLY" } else { "BEGIN" };
            mysql_exec_text(&mut c, begin).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::MySql(c)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let mut c = open_pg(&config, pwd).await?;
            if let Some(schema) = database.as_deref().filter(|s| !s.is_empty()) {
                let safe_schema = schema.replace('"', "\"\"");
                sqlx::query(&format!("SET search_path TO \"{safe_schema}\"")).execute(&mut c).await
                    .map_err(|e| format!("切换 schema 失败: {e}"))?;
            }
            let begin = if read_only { "BEGIN READ ONLY" } else { "BEGIN" };
            sqlx::query(begin).execute(&mut c).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::Pg(c)
        }
        ConnType::Sqlite => {
            let mut c = open_sqlite(&config).await?;
            if read_only {
                // 只读：query_only 阻止任何写；用 DEFERRED BEGIN（不抢写锁）
                sqlx::query("PRAGMA query_only=ON").execute(&mut c).await
                    .map_err(|e| format!("设置只读失败: {e}"))?;
                sqlx::query("BEGIN").execute(&mut c).await
                    .map_err(|e| format!("BEGIN 失败: {e}"))?;
            } else {
                // BEGIN IMMEDIATE 立即获取写锁，避免 SQLITE_BUSY 在 COMMIT 时突发
                sqlx::query("BEGIN IMMEDIATE").execute(&mut c).await
                    .map_err(|e| format!("BEGIN IMMEDIATE 失败: {e}"))?;
            }
            TxConn::Sqlite(c)
        }
        ConnType::Duckdb => {
            dispatch_duck_query(&id, &config, "BEGIN", &duck_pool, &registry).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::Duckdb(id.clone())
        }
        ConnType::SqlServer => {
            dispatch_ss_query(&id, &config, "BEGIN TRANSACTION", &ss_pool).await
                .map_err(|e| format!("BEGIN TRANSACTION 失败: {e}"))?;
            TxConn::SqlServer(id.clone())
        }
        ConnType::Oracle => {
            oracle_begin_tx(id.clone(), config, password, &*registry, &oracle_tx_pool).await?;
            TxConn::Oracle(id.clone())
        }
        _ => return Err("此连接类型不支持手动事务".to_string()),
    };

    // 二次检查：并发 begin 时避免覆盖（极小概率，但保持与池一致的语义）
    let mut guard = tx_state.lock().await;
    if guard.contains_key(&id) {
        return Err("此连接已有活跃事务，请先提交或回滚".to_string());
    }
    let now = Instant::now();
    guard.insert(id, Arc::new(AsyncMutex::new(ActiveTx { conn, started_at: now, last_used: now, read_only })));
    Ok(())
}

/// 在当前事务连接上执行 SQL（事务期间所有语句必须走此命令）
#[tauri::command]
pub async fn db_exec_in_tx(
    id: String,
    sql: String,
    tx_state: State<'_, TxState>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    oracle_tx_pool: State<'_, OracleTxPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<QueryResult, String> {
    // 瞬时持外层锁取出 per-连接锁后立即释放；DB 执行只持内层锁
    let tx_arc = {
        let guard = tx_state.lock().await;
        guard.get(&id).cloned().ok_or("没有活跃事务，请先执行 BEGIN")?
    };
    let mut tx = tx_arc.lock().await;

    // 只读事务：拦截写语句（双保险；引擎层也已 READ ONLY，但 DuckDB 仅靠此处）
    if tx.read_only && !super::query::is_query_stmt(&sql) {
        return Err("只读连接：事务中不允许写操作".to_string());
    }
    tx.last_used = Instant::now();

    match &mut tx.conn {
        TxConn::MySql(conn)    => run_on_mysql(conn, &sql).await,
        TxConn::Pg(conn)       => run_on_pg(conn, &sql).await,
        TxConn::Sqlite(conn)   => run_on_sqlite(conn, &sql).await,
        TxConn::Duckdb(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_duck_query(&conn_id, &config, &sql, &duck_pool, &registry).await
        }
        TxConn::SqlServer(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_ss_query(&conn_id, &config, &sql, &ss_pool).await
        }
        TxConn::Oracle(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            oracle_exec_in_tx(&conn_id, sql, &oracle_tx_pool, Instant::now()).await
        }
    }
}

/// 提交事务
#[tauri::command]
pub async fn db_commit_tx(
    id: String,
    tx_state: State<'_, TxState>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    oracle_tx_pool: State<'_, OracleTxPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 先从 map 移除（后续无新语句可进），再持内层锁提交；连接随后 Drop
    let tx_arc = {
        let mut guard = tx_state.lock().await;
        guard.remove(&id).ok_or("没有活跃事务")?
    };
    let mut tx = tx_arc.lock().await;
    match &mut tx.conn {
        TxConn::MySql(conn)  => mysql_exec_text(conn, "COMMIT").await
            .map_err(|e| format!("COMMIT 失败: {e}")),
        TxConn::Pg(conn)     => sqlx::query("COMMIT").execute(&mut *conn).await
            .map(|_| ()).map_err(|e| format!("COMMIT 失败: {e}")),
        TxConn::Sqlite(conn) => sqlx::query("COMMIT").execute(&mut *conn).await
            .map(|_| ()).map_err(|e| format!("COMMIT 失败: {e}")),
        TxConn::Duckdb(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_duck_query(&conn_id, &config, "COMMIT", &duck_pool, &registry).await
                .map(|_| ()).map_err(|e| format!("COMMIT 失败: {e}"))
        }
        TxConn::SqlServer(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_ss_query(&conn_id, &config, "COMMIT TRANSACTION", &ss_pool).await
                .map(|_| ()).map_err(|e| format!("COMMIT 失败: {e}"))
        }
        TxConn::Oracle(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            oracle_commit_tx(&conn_id, &oracle_tx_pool).await
        }
    }
}

/// 回滚事务
#[tauri::command]
pub async fn db_rollback_tx(
    id: String,
    tx_state: State<'_, TxState>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    oracle_tx_pool: State<'_, OracleTxPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    let tx_arc = {
        let mut guard = tx_state.lock().await;
        guard.remove(&id).ok_or("没有活跃事务")?
    };
    let mut tx = tx_arc.lock().await;
    match &mut tx.conn {
        TxConn::MySql(conn)  => mysql_exec_text(conn, "ROLLBACK").await
            .map_err(|e| format!("ROLLBACK 失败: {e}")),
        TxConn::Pg(conn)     => sqlx::query("ROLLBACK").execute(&mut *conn).await
            .map(|_| ()).map_err(|e| format!("ROLLBACK 失败: {e}")),
        TxConn::Sqlite(conn) => sqlx::query("ROLLBACK").execute(&mut *conn).await
            .map(|_| ()).map_err(|e| format!("ROLLBACK 失败: {e}")),
        TxConn::Duckdb(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_duck_query(&conn_id, &config, "ROLLBACK", &duck_pool, &registry).await
                .map(|_| ()).map_err(|e| format!("ROLLBACK 失败: {e}"))
        }
        TxConn::SqlServer(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            let (config, _) = load_conn(&conn_id, &storage).await?;
            dispatch_ss_query(&conn_id, &config, "ROLLBACK TRANSACTION", &ss_pool).await
                .map(|_| ()).map_err(|e| format!("ROLLBACK 失败: {e}"))
        }
        TxConn::Oracle(conn_id) => {
            let conn_id = conn_id.clone();
            drop(tx);
            oracle_rollback_tx(&conn_id, &oracle_tx_pool).await
        }
    }
}

/// 查询当前连接是否有活跃事务（前端刷新时检查）
#[tauri::command]
pub async fn db_tx_status(
    id: String,
    tx_state: State<'_, TxState>,
) -> Result<bool, String> {
    Ok(tx_state.lock().await.contains_key(&id))
}

/// 清理「空闲」超过 30 分钟的僵尸事务，返回清理数量。命令与后台定时任务共用。
/// 关键：按 last_used（最近一次执行）判定空闲，而非 started_at（BEGIN 时刻）——
/// 否则一个用了半小时仍在用的长事务会被误杀，未提交数据被 SQLx 自动 ROLLBACK 静默丢失。
/// 移除后 ActiveTx 被 Drop，SQLx 自动 ROLLBACK，释放 DB 端残留的行锁/表锁。
pub async fn cleanup_stale_txns(tx_state: &TxState) -> u32 {
    let mut guard = tx_state.lock().await;
    let before = guard.len();
    let threshold = std::time::Duration::from_secs(30 * 60); // 空闲 30 分钟
    guard.retain(|_, arc| match arc.try_lock() {
        Ok(tx) => tx.last_used.elapsed() < threshold, // 空闲超时则清理
        Err(_) => true,                               // 正在执行：保留
    });
    (before - guard.len()) as u32
}

/// 清理超过 30 分钟的僵尸事务（前端可手动触发；另由 setup 中的后台任务定期驱动）
#[tauri::command]
pub async fn db_cleanup_stale_tx(tx_state: State<'_, TxState>) -> Result<u32, String> {
    Ok(cleanup_stale_txns(&tx_state).await)
}
