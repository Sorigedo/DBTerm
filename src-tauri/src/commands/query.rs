//! # Database Query Module
//!
//! Core database query execution and metadata retrieval for all supported database types.
//!
//! This module provides:
//! - SQL query execution with cancellation support
//! - Connection pooling for MySQL, PostgreSQL, Redis, MongoDB, DuckDB, SQL Server
//! - Database/schema/table/column metadata queries
//! - DDL (CREATE TABLE) generation
//! - Stored procedures/functions/triggers listing
//! - Multi-database abstraction via connection dispatching
//!
//! ## Supported Database Types
//!
//! - **MySQL/MariaDB/TiDB/OceanBase** - via `mysql_async`
//! - **PostgreSQL/KingBase/OpenGauss** - via `tokio-postgres`
//! - **SQLite** - via `rusqlite`
//! - **Redis** - via `redis` crate
//! - **MongoDB** - via `mongodb` official driver
//! - **DuckDB** - via C API dynamic loading
//! - **SQL Server** - via `tiberius` pure Rust driver
//! - **Oracle** - via OCI dynamic loading
//! - **ClickHouse** - via HTTP interface
//!
//! ## Architecture
//!
//! All queries are tagged with `/* DBTerm */` comment for identification in
//! database process lists and slow query logs.
//!
//! Connection configurations are parsed from `extra_json` field in [`ConnConfig`],
//! supporting SSL/TLS, SSH tunneling, and database-specific options.

use std::time::{Duration, Instant};
use tauri::State;
use tracing::{info, warn, instrument};
use crate::{
    models::{ColumnInfo, ConnConfig, ConnType, QueryResult, TableInfo},
    storage::StorageState,
    tracing_utils::Timer,
};
use super::sqlite_admin::SqliteAttachMap;
use super::duckdb::{DuckPool, dispatch_duck_query_with_target, dispatch_duck_schemas, dispatch_duck_tables, dispatch_duck_ddl, dispatch_duck_columns};
use super::driver::DriverRegistry;
use super::sqlserver::{SsPool, dispatch_ss_query, dispatch_ss_schemas, dispatch_ss_tables, dispatch_ss_schema_columns, dispatch_ss_ddl, dispatch_ss_routines, dispatch_ss_db_schemas, dispatch_ss_schema_tables};

// ── Client identification & connection configuration ─────────────────────────

/// SQL client tag added to all queries for identification in database logs
///
/// This comment appears in:
/// - MySQL: `SHOW PROCESSLIST`
/// - PostgreSQL: `pg_stat_activity`
/// - SQL Server: `sys.dm_exec_requests`
/// - Slow query logs
const CLIENT_TAG: &str = "/* DBTerm */";

/// Prepends client tag to SQL statement
fn tag_sql(sql: &str) -> String { format!("{CLIENT_TAG} {sql}") }

/// Extended connection configuration parsed from `ConnConfig.extra_json`
///
/// This structure maps to the frontend `DbExtra` type (camelCase JSON).
/// All fields are optional with sensible defaults.
///
/// # SSL/TLS Configuration
///
/// - `ssl_mode` - "require", "prefer", "disable", "verify-ca", "verify-full"
/// - `ssl_ca` - CA certificate file path
/// - `ssl_cert` - Client certificate file path
/// - `ssl_key` - Client private key file path
///
/// # SSH Tunnel Configuration
///
/// - `ssh_tunnel` - Enable SSH tunneling
/// - `ssh_host` - Jump host address
/// - `ssh_port` - SSH port (default: 22)
/// - `ssh_user` - SSH username
/// - `ssh_auth_type` - "password" or "key"
/// - `ssh_password` - SSH password (for password auth)
/// - `ssh_key_path` - SSH private key path (for key auth)
///
/// # Database-Specific Options
///
/// ## SQLite
/// - `sqlite_readonly` - Open database in read-only mode
/// - `sqlite_busy_timeout` - Lock timeout in milliseconds (default: 5000)
/// - `sqlite_foreign_keys` - Enable foreign key constraints (default: true)
/// - `sqlite_immutable` - Open as immutable (memory-mapped read-only)
///
/// ## PostgreSQL
/// - `pg_search_path` - Schema search path (e.g., "app,public")
/// - `pg_app_name` - Application name shown in `pg_stat_activity`
///
/// # Examples
///
/// ```json
/// {
///   "connectTimeout": 5000,
///   "encoding": "utf8mb4",
///   "sslMode": "require",
///   "sslCa": "/etc/ssl/ca.pem",
///   "initSql": "SET time_zone = '+00:00'"
/// }
/// ```
#[derive(serde::Deserialize, Default)]
struct DbConnCfg {
    #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
    #[serde(rename = "encoding",       default)] encoding:        String,
    #[serde(rename = "initSql",        default)] init_sql:        String,
    // SSL
    #[serde(rename = "sslMode",  default)] ssl_mode: String,
    #[serde(rename = "sslCa",   default)] ssl_ca:   String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    // SSH 隧道
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] ssh_host:      String,
    #[serde(rename = "sshPort",     default)] ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path:  String,
    // SQLite 专属
    #[serde(rename = "sqliteReadonly",     default)] sqlite_readonly:      bool,
    #[serde(rename = "sqliteBusyTimeout",  default)] sqlite_busy_timeout:  u32,  // ms, 0=默认5000
    #[serde(rename = "sqliteForeignKeys",  default = "default_true")] sqlite_foreign_keys: bool,
    #[serde(rename = "sqliteImmutable",    default)] sqlite_immutable:     bool,
    // PostgreSQL 专属
    #[serde(rename = "pgSearchPath", default)] pg_search_path: String,
    #[serde(rename = "pgAppName",    default)] pg_app_name:    String,
}
fn default_true() -> bool { true }

impl DbConnCfg {
    fn from_config(c: &ConnConfig) -> Result<Self,String> {
        let Some(raw)=c.extra_json.as_deref().filter(|s|!s.trim().is_empty())else{return Ok(Self::default())};
        let error=||"数据库连接配置格式错误，已拒绝连接；请检查连接设置".to_string();
        let value:serde_json::Value=serde_json::from_str(raw).map_err(|_|error())?;
        if !value.is_object(){return Err(error())}
        serde_json::from_value(value).map_err(|_|error())
    }
    fn timeout(&self) -> Duration {
        Duration::from_secs(if self.connect_timeout == 0 { 30 } else { self.connect_timeout.clamp(3, 300) })
    }
    /// 取 SSH 隧道密码：优先 extra_json 中的值（老数据/测试时直传），
    /// 若为空则从 keychain 读取（save_connection 已将其迁入 keychain）。
    fn tunnel_password(&self, conn_id: &str) -> Result<String,String> {
        self.tunnel_password_with(conn_id,crate::keychain::get_password)
    }
    fn tunnel_password_with(&self,conn_id:&str,lookup:impl FnOnce(&str)->Result<Option<String>,String>)->Result<String,String>{
        if matches!(self.ssh_auth_type.as_str(),"agent"|"none"){return Ok(String::new())}
        if !self.ssh_password.is_empty() { return Ok(self.ssh_password.clone()); }
        lookup(&format!("{conn_id}::ssh-tunnel")).map(|password|password.unwrap_or_default())
            .map_err(|_|"读取数据库 SSH 隧道凭据失败，已拒绝连接；请检查凭据存储后重试".to_string())
    }
}

pub(crate) fn resolve_sql_tls_mode(config: &ConnConfig, explicit: &str) -> Result<&'static str, String> {
    if let Some(raw) = config.extra_json.as_deref().filter(|s| !s.trim().is_empty()) {
        let extra: serde_json::Value = serde_json::from_str(raw).map_err(|_| "连接扩展配置损坏，无法核验 TLS 模式，已拒绝连接".to_string())?;
        if !extra.is_object() || extra.get("sslMode").is_some_and(|v| !v.is_string()) {
            return Err("TLS 模式配置类型无效，已拒绝连接".into());
        }
        if extra.get("sslMode").and_then(|v| v.as_str()).is_some_and(|mode| mode != explicit) {
            return Err("连接配置解析失败，TLS 模式与原始设置不一致，已拒绝连接".into());
        }
    }
    match explicit {
        "" if config.use_ssl => Ok("require"),
        "" | "disabled" => Ok("disabled"),
        "require" => Ok("require"),
        "verify-ca" => Ok("verify-ca"),
        "verify-full" => Ok("verify-full"),
        _ => Err("未知 TLS 模式，已拒绝连接；请在连接设置中明确选择加密策略".into()),
    }
}

pub(crate) fn mysql_tls_mode(config: &ConnConfig, explicit: &str) -> Result<sqlx::mysql::MySqlSslMode, String> {
    use sqlx::mysql::MySqlSslMode;
    Ok(match resolve_sql_tls_mode(config, explicit)? {
        "require" => MySqlSslMode::Required,
        "verify-ca" => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Disabled,
    })
}

pub(crate) fn pg_tls_mode(config: &ConnConfig, explicit: &str) -> Result<sqlx::postgres::PgSslMode, String> {
    use sqlx::postgres::PgSslMode;
    Ok(match resolve_sql_tls_mode(config, explicit)? {
        "require" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _ => PgSslMode::Disable,
    })
}

fn validate_read_only_init_sql(cfg: &DbConnCfg, read_only: bool) -> Result<(), String> {
    if read_only && !cfg.init_sql.trim().is_empty() {
        return Err("只读连接不能执行初始化 SQL；请移除初始化语句后连接".into());
    }
    Ok(())
}

/// Include all persisted settings, database credentials and effective tunnel
/// credentials. IDs are only lookup keys; never evidence that endpoints match.
pub(crate) fn pool_identity(config: &ConnConfig, password: Option<&str>, tunnel_password: &str) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};
    static SALT: std::sync::OnceLock<[u8; 16]> = std::sync::OnceLock::new();
    let serialized = serde_json::to_vec(config).map_err(|_| "无法核验连接配置")?;
    let mut hash = Sha256::new();
    hash.update(SALT.get_or_init(|| *uuid::Uuid::new_v4().as_bytes()));
    for bytes in [serialized.as_slice(), password.unwrap_or("").as_bytes(), tunnel_password.as_bytes()] {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(hash.finalize().into())
}

pub(crate) async fn pool_build_lock(id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, OnceLock, Weak};
    type Locks = std::collections::HashMap<String, Weak<tokio::sync::Mutex<()>>>;
    static LOCKS: OnceLock<tokio::sync::Mutex<Locks>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(|| tokio::sync::Mutex::new(Locks::new())).lock().await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(Weak::upgrade) { return lock; }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(id.to_string(), Arc::downgrade(&lock));
    lock
}

const QUERY_POOL_CACHE_IDLE: Duration = Duration::from_secs(300);

fn reap_idle_query_pools(now: std::time::Instant) {
    // Dropping only the registry reference leaves pool clones/checkouts alive.
    mysql_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|_, cached| now.saturating_duration_since(cached.last_used) < QUERY_POOL_CACHE_IDLE);
    pg_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|_, cached| now.saturating_duration_since(cached.last_used) < QUERY_POOL_CACHE_IDLE);
    sqlite_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|_, cached| now.saturating_duration_since(cached.last_used) < QUERY_POOL_CACHE_IDLE);
}

fn start_query_pool_maintenance() {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            let mut interval=tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                reap_idle_query_pools(std::time::Instant::now());
            }
        });
    });
}

/// 为 MySQL 连接选项按需设置密码：
/// 空密码时**不调用** `.password()`，否则 sqlx 会对空串做散列并以「using password: YES」发送握手，
/// 导致无密码账号（如默认 TiDB / OceanBase 的 root）返回 1045 拒绝。
pub(crate) trait MySqlPwdExt {
    fn password_opt(self, pwd: &str) -> Self;
}
impl MySqlPwdExt for sqlx::mysql::MySqlConnectOptions {
    fn password_opt(self, pwd: &str) -> Self {
        if pwd.is_empty() { self } else { self.password(pwd) }
    }
}

/// 建立 MySQL/MariaDB 连接，自动处理 SSH 隧道、SSL、超时、init SQL
/// 返回 `(连接, 隧道守卫)`；隧道守卫必须与连接同生命周期
#[instrument(skip(config, password), fields(conn_id = %config.id, conn_type = "MySQL"))]
pub(crate) async fn mysql_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::mysql::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    let _timer = Timer::new("mysql_connect");
    use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions}};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config)?;
    validate_read_only_init_sql(&cfg, config.read_only == Some(true))?;
    let tls_mode = mysql_tls_mode(config, &cfg.ssl_mode)?;
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    // SSH 隧道（按连接 ID 复用，避免每次查询重新登录跳板机）
    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id)?, key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(3306)).await?;
        let lp = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(3306))
    };

    let mut opts = MySqlConnectOptions::new().host(&h).port(p).username(user).password_opt(pwd);
    if !db.is_empty() { opts = opts.database(db); }

    // SSL
    opts = opts.ssl_mode(tls_mode);
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let mut conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    // 字符集（非 UTF-8 时显式 SET NAMES）
    if matches!(cfg.encoding.as_str(), "GBK" | "GB2312") {
        sqlx::query("SET NAMES gbk").execute(&mut conn).await.map_err(|e| format!("设置连接字符集失败: {e}"))?;
    } else if cfg.encoding == "Latin-1" {
        sqlx::query("SET NAMES latin1").execute(&mut conn).await.map_err(|e| format!("设置连接字符集失败: {e}"))?;
    }

    // 初始化 SQL（跳过注释行）
    for stmt in cfg.init_sql.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("--"))
    {
        sqlx::query(stmt).execute(&mut conn).await
            .map_err(|e| format!("初始化 SQL 失败 [{stmt}]: {e}"))?;
    }

    // 只读模式：会话级 READ ONLY（引擎级强制；失败则 fail-closed 不放行）
    if config.read_only == Some(true) {
        sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(&mut conn).await
            .map_err(|e| format!("设置只读会话失败: {e}"))?;
    }

    Ok((conn, tunnel))
}

// ── MySQL 连接池 ───────────────────────────────────────────────────────────────
// 仅供「非取消、高频」的元数据/浏览路径(schemas/tables/columns)复用，缓解每查询新建连接导致的连接数暴增。
// 查询执行路径(mysql_query)仍用独占连接：取消要靠关连接中止，不能走池。
struct CachedMyPool {
    pool: sqlx::mysql::MySqlPool,
    identity: [u8; 32],
    last_used: std::time::Instant,
    // 持有隧道 Arc，保证池存在期间 SSH 隧道不被关闭
    _tunnel: Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>,
}

fn mysql_pool_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedMyPool>> {
    static P: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedMyPool>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 失效某连接的 MySQL 池（保存/删除连接配置后调用，使新主机/密码/只读等生效）。
pub fn invalidate_mysql_pool(id: &str) {
    if let Ok(mut m) = mysql_pool_reg().lock() { m.remove(id); }
}

/// 取得（或惰性建立）该连接的 MySQL 连接池；隧道已死则重建。
#[instrument(skip(config, password), fields(conn_id = %config.id))]
async fn mysql_pool(config: &ConnConfig, password: Option<&str>) -> Result<sqlx::mysql::MySqlPool, String> {
    start_query_pool_maintenance();
    let _timer = Timer::new("mysql_pool");
    let cfg = DbConnCfg::from_config(config)?;
    validate_read_only_init_sql(&cfg, config.read_only == Some(true))?;
    let tls_mode = mysql_tls_mode(config, &cfg.ssl_mode)?;
    let tunnel_password = if cfg.ssh_tunnel { cfg.tunnel_password(&config.id)? } else { String::new() };
    let identity = pool_identity(config, password, &tunnel_password)?;
    let build_lock = pool_build_lock(&config.id).await;
    let _build_guard = build_lock.lock().await;
    {
        let mut m = mysql_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get_mut(&config.id) {
            if c.identity == identity && !c.pool.is_closed() && c._tunnel.as_ref().map_or(true, |t| t.is_alive()) {
                info!("Reusing existing MySQL pool");
                c.last_used=std::time::Instant::now();
                return Ok(c.pool.clone());
            }
            warn!("MySQL pool tunnel dead, rebuilding");
        }
    }
    invalidate_mysql_pool(&config.id);

    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port, user: cfg.ssh_user.clone(),
            auth_type: cfg.ssh_auth_type.clone(), password: tunnel_password, key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"), config.port.unwrap_or(3306)).await?;
        let lp = t.local_port; tunnel = Some(t); ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(3306))
    };

    let mut opts = MySqlConnectOptions::new().host(&h).port(p).username(user).password_opt(pwd);
    if !db.is_empty() { opts = opts.database(db); }
    opts = opts.ssl_mode(tls_mode);
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    // 每条池连接建立后做与 mysql_connect 等价的会话初始化（编码 / init_sql / 只读）
    let encoding = cfg.encoding.clone();
    let init_sql = cfg.init_sql.clone();
    let read_only = config.read_only == Some(true);
    let pool_tunnel=tunnel.clone();
    let pool = MySqlPoolOptions::new()
        .max_connections(10)   // 元数据/浏览/补全并发较多，适当放大并发上限（每连接独立池）
        .idle_timeout(Some(Duration::from_secs(300)))   // 空闲 5min 自动回收，避免久挂占连接
        .acquire_timeout(cfg.timeout())
        .after_connect(move |conn, _meta| {
            let _keep_tunnel=&pool_tunnel;
            let (encoding, init_sql) = (encoding.clone(), init_sql.clone());
            Box::pin(async move {
                if matches!(encoding.as_str(), "GBK" | "GB2312") { sqlx::query("SET NAMES gbk").execute(&mut *conn).await?; }
                else if encoding == "Latin-1" { sqlx::query("SET NAMES latin1").execute(&mut *conn).await?; }
                for stmt in init_sql.split(';').map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("--")) {
                    sqlx::query(stmt).execute(&mut *conn).await?;
                }
                if read_only { sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(&mut *conn).await?; }
                Ok(())
            })
        })
        .connect_lazy_with(opts);

    mysql_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(config.id.clone(), CachedMyPool { pool: pool.clone(), identity, last_used: std::time::Instant::now(), _tunnel: tunnel });
    Ok(pool)
}

/// 建立 PostgreSQL 连接，自动处理 SSH 隧道、SSL、超时、init SQL、application_name
#[instrument(skip(config, password), fields(conn_id = %config.id, conn_type = "PostgreSQL"))]
pub(crate) async fn pg_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::postgres::PgConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    let _timer = Timer::new("pg_connect");
    use sqlx::{ConnectOptions, postgres::{PgConnectOptions}};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config)?;
    validate_read_only_init_sql(&cfg, config.read_only == Some(true))?;
    let tls_mode = pg_tls_mode(config, &cfg.ssl_mode)?;
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id)?, key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(5432)).await?;
        let lp = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(5432))
    };

    // application_name 不写入启动参数（PG 9.0 前会拒绝该参数导致连接失败）
    // 改为连接成功后 SET，PG 8.4+ 支持，更老版本会静默忽略失败
    let mut opts = PgConnectOptions::new()
        .host(&h).port(p).username(user).password(pwd).database(db);

    opts = opts.ssl_mode(tls_mode);
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let mut conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    // 兼容 PG 8.4+：连接后 SET application_name（PG 9.0 前无法在启动参数里设置）
    let app_name = if cfg.pg_app_name.is_empty() { "DBTerm" } else { &cfg.pg_app_name };
    let _ = sqlx::query(&format!("SET application_name = '{}'", app_name.replace('\'', "''")))
        .execute(&mut conn).await; // 旧版 PG 不认识该参数时静默忽略

    // PG0.4: 只读模式双保险（ConnConfig 级别）；失败则 fail-closed（不放行可写连接）
    if config.read_only == Some(true) {
        sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut conn).await
            .map_err(|e| format!("设置只读会话失败: {e}"))?;
    }

    // PG0.1: 自定义 search_path（逐项校验防止 SQL 注入）
    if !cfg.pg_search_path.is_empty() {
        let mut safe_parts: Vec<String> = Vec::new();
        for s in cfg.pg_search_path.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if s == "$user" {
                safe_parts.push("\"$user\"".to_string());
            } else if s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
                safe_parts.push(format!("\"{}\"", s.replace('"', "\"\"")));
            } else {
                log::warn!("search_path 含非法 schema 名 '{s}'，已跳过");
            }
        }
        if !safe_parts.is_empty() {
            let _ = sqlx::query(&format!("SET search_path TO {}", safe_parts.join(", ")))
                .execute(&mut conn).await;
        }
    }

    // 初始化 SQL
    for stmt in cfg.init_sql.split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("--"))
    {
        sqlx::query(stmt).execute(&mut conn).await
            .map_err(|e| format!("初始化 SQL 失败 [{stmt}]: {e}"))?;
    }

    Ok((conn, tunnel))
}

// ── PostgreSQL 连接池（同 MySQL：仅供浏览路径复用；查询执行仍用独占连接以支持取消）──
struct CachedPgPool {
    pool: sqlx::postgres::PgPool,
    identity: [u8; 32],
    last_used: std::time::Instant,
    _tunnel: Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>,
}
fn pg_pool_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedPgPool>> {
    static P: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedPgPool>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
pub fn invalidate_pg_pool(id: &str) {
    if let Ok(mut m) = pg_pool_reg().lock() { m.remove(id); }
}
#[instrument(skip(config, password), fields(conn_id = %config.id))]
async fn pg_pool(config: &ConnConfig, password: Option<&str>) -> Result<sqlx::postgres::PgPool, String> {
    start_query_pool_maintenance();
    let _timer = Timer::new("pg_pool");
    let cfg = DbConnCfg::from_config(config)?;
    validate_read_only_init_sql(&cfg, config.read_only == Some(true))?;
    let tls_mode = pg_tls_mode(config, &cfg.ssl_mode)?;
    let tunnel_password = if cfg.ssh_tunnel { cfg.tunnel_password(&config.id)? } else { String::new() };
    let identity = pool_identity(config, password, &tunnel_password)?;
    let build_lock = pool_build_lock(&config.id).await;
    let _build_guard = build_lock.lock().await;
    {
        let mut m = pg_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get_mut(&config.id) {
            if c.identity == identity && !c.pool.is_closed() && c._tunnel.as_ref().map_or(true, |t| t.is_alive()) {
                info!("Reusing existing PostgreSQL pool");
                c.last_used=std::time::Instant::now();
                return Ok(c.pool.clone());
            }
            warn!("PostgreSQL pool tunnel dead, rebuilding");
        }
    }
    invalidate_pg_pool(&config.id);

    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port, user: cfg.ssh_user.clone(),
            auth_type: cfg.ssh_auth_type.clone(), password: tunnel_password, key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"), config.port.unwrap_or(5432)).await?;
        let lp = t.local_port; tunnel = Some(t); ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(5432))
    };

    // application_name 不写入启动参数（兼容 PG 8.x）
    let mut opts = PgConnectOptions::new().host(&h).port(p).username(user).password(pwd)
        .database(db);
    opts = opts.ssl_mode(tls_mode);
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    // 预先构造安全的 search_path SQL（逐项校验，防注入），在 after_connect 里执行
    let search_sql: Option<String> = if cfg.pg_search_path.is_empty() { None } else {
        let mut parts: Vec<String> = Vec::new();
        for s in cfg.pg_search_path.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if s == "$user" { parts.push("\"$user\"".to_string()); }
            else if s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
                parts.push(format!("\"{}\"", s.replace('"', "\"\"")));
            } else { log::warn!("search_path 含非法 schema 名 '{s}'，已跳过"); }
        }
        if parts.is_empty() { None } else { Some(format!("SET search_path TO {}", parts.join(", "))) }
    };
    let read_only = config.read_only == Some(true);
    let init_sql = cfg.init_sql.clone();
    let pool_tunnel=tunnel.clone();
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .idle_timeout(Some(Duration::from_secs(300)))
        .acquire_timeout(cfg.timeout())
        .after_connect(move |conn, _meta| {
            let _keep_tunnel=&pool_tunnel;
            let (search_sql, init_sql) = (search_sql.clone(), init_sql.clone());
            Box::pin(async move {
                if read_only { sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").execute(&mut *conn).await?; }
                if let Some(s) = &search_sql { let _ = sqlx::query(s).execute(&mut *conn).await; }
                for stmt in init_sql.split(';').map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("--")) {
                    sqlx::query(stmt).execute(&mut *conn).await?;
                }
                Ok(())
            })
        })
        .connect_lazy_with(opts);

    pg_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(config.id.clone(), CachedPgPool { pool: pool.clone(), identity, last_used: std::time::Instant::now(), _tunnel: tunnel });
    Ok(pool)
}

// ── SQLite 浏览连接池（只供 list_tables / list_columns / list_tables_meta）──
// SQLite 读操作可并发（WAL 模式下）；写路径仍用独占连接。
struct CachedSqlitePool { pool: sqlx::SqlitePool, identity: [u8; 32], last_used: std::time::Instant }

fn sqlite_pool_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedSqlitePool>> {
    static P: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedSqlitePool>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn invalidate_sqlite_pool(id: &str) {
    if let Ok(mut m) = sqlite_pool_reg().lock() { m.remove(id); }
}

#[instrument(skip(config), fields(conn_id = %config.id))]
async fn sqlite_browse_pool(config: &ConnConfig) -> Result<sqlx::SqlitePool, String> {
    start_query_pool_maintenance();
    let _timer = Timer::new("sqlite_browse_pool");
    let identity = pool_identity(config, None, "")?;
    let build_lock = pool_build_lock(&config.id).await;
    let _build_guard = build_lock.lock().await;
    {
        let mut m = sqlite_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get_mut(&config.id) {
            if c.identity == identity && !c.pool.is_closed() {
                info!("Reusing existing SQLite pool");
                c.last_used=std::time::Instant::now();
                return Ok(c.pool.clone());
            }
            warn!("SQLite pool closed, rebuilding");
        }
    }
    invalidate_sqlite_pool(&config.id);
    use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, ConnectOptions};
    use std::str::FromStr;
    let cfg = DbConnCfg::from_config(config)?;
    let url = sqlite_url(config)?;
    let busy_ms = if cfg.sqlite_busy_timeout == 0 { 5000 } else { cfg.sqlite_busy_timeout };
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .read_only(true)          // 浏览池强制只读
        .busy_timeout(Duration::from_millis(busy_ms as u64))
        .foreign_keys(false)      // 元数据查询不需要外键约束
        .log_statements(log::LevelFilter::Off);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_lazy_with(opts);
    sqlite_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(config.id.clone(), CachedSqlitePool { pool: pool.clone(), identity, last_used: std::time::Instant::now() });
    Ok(pool)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

const SELECTED_QUERY_SCHEMA: &str = "__dbtermSelectedQuerySchema";

/// UI 的选中项在 PG/Oracle 中是 schema，而不是物理数据库。
/// 仅修改本次查询的有效配置；不改保存的连接，也不改用户 SQL。
pub(crate) fn apply_selected_query_target(config: &mut ConnConfig, selected: Option<&str>) -> Result<Option<String>, String> {
    // 内部临时字段不能从保存的扩展配置继承为隐式目标。
    if let Some(raw) = config.extra_json.as_deref() {
        if let Ok(mut extra) = serde_json::from_str::<serde_json::Value>(raw) {
            if extra.as_object_mut().is_some_and(|object| object.remove(SELECTED_QUERY_SCHEMA).is_some()) {
                config.extra_json = Some(extra.to_string());
            }
        }
    }
    let Some(selected) = selected.filter(|name| !name.is_empty()) else { return Ok(None); };
    validate_ident(selected)?;
    match config.conn_type {
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss | ConnType::Duckdb => {
            let mut extra = match config.extra_json.as_deref() {
                Some(raw) => serde_json::from_str::<serde_json::Value>(raw)
                    .map_err(|_| "连接扩展配置无效，无法安全选择 schema".to_string())?,
                None => serde_json::json!({}),
            };
            let object = extra.as_object_mut().ok_or_else(|| "连接扩展配置必须是对象".to_string())?;
            object.insert(SELECTED_QUERY_SCHEMA.into(), serde_json::Value::String(selected.into()));
            // PG/DuckDB 缓存身份包含 extra_json，不同选择不会继承对方的会话目标。
            config.extra_json = Some(extra.to_string());
            Ok(Some(selected.into()))
        }
        ConnType::Oracle => Ok(Some(selected.into())),
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase
        | ConnType::ClickHouse | ConnType::SqlServer => {
            config.database = Some(selected.into());
            Ok(None)
        }
        ConnType::Sqlite if selected == "main" => Ok(None),
        ConnType::Sqlite => Err("当前查询会话仅连接 SQLite main 库，不能安全切换到附加库；请为目标文件单独建立连接".into()),
        _ => Ok(None),
    }
}

fn selected_pg_search_path(config: &ConnConfig) -> Result<Option<String>, String> {
    let Some(raw) = config.extra_json.as_deref() else { return Ok(None); };
    let extra: serde_json::Value = serde_json::from_str(raw).map_err(|_| "连接扩展配置无效".to_string())?;
    let Some(value) = extra.get(SELECTED_QUERY_SCHEMA) else { return Ok(None); };
    let schema = value.as_str().ok_or_else(|| "查询 schema 配置无效".to_string())?;
    validate_ident(schema)?;
    Ok(Some(q_dq(schema)))
}

#[tauri::command]
pub async fn execute_query(
    id: String,
    sql: String,
    database: Option<String>,   // 查询页选中的 schema/库：按引擎应用，保留 PG/Oracle 物理服务
    row_limit: Option<u64>,     // 前端行数上限（None = 全量，Some(n) = 追加 LIMIT n）
    cancel_token: Option<String>, // 查询取消令牌：独立 IPC 参数，不写入 SQL 文本
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<QueryResult, String> {
    let (mut config, password) = load_conn(&id, &storage)?;
    validate_cancel_token(cancel_token.as_deref())?;
    // 集中只读护栏（fail-closed）：只读连接拒绝非查询语句。覆盖所有引擎——
    // MySQL/DuckDB/SQLServer/ClickHouse 的单独路径此前没有引擎级只读，这里统一兜底。
    // 引擎级只读（PG/SQLite session、MySQL session、DuckDB access_mode）作为更精确的第二重保障。
    if config.read_only == Some(true) && !is_read_only_safe_stmt(&sql, &config.conn_type) {
        return Err("该连接为只读模式，已拒绝写操作".to_string());
    }
    let selected_schema = apply_selected_query_target(&mut config, database.as_deref())?;

    let (effective_sql, limit_applied) = apply_query_row_limit(&sql, row_limit, &config.conn_type);
    if config.conn_type == ConnType::SqlServer {
        let mut r = dispatch_ss_query(&id, &config, &effective_sql, &ss_pool).await?;
        r.truncated = limit_applied;
        return Ok(r);
    }
    if config.conn_type == ConnType::Oracle {
        let mut r = super::oracle::execute_query_in_schema_impl(config, effective_sql, password, &*registry, selected_schema).await?;
        r.truncated = limit_applied;
        return Ok(r);
    }

    if config.conn_type == ConnType::Duckdb {
        let mut r = dispatch_duck_query_with_target(&id, &config, &effective_sql, &duck_pool, &registry, cancel_token.as_deref(), selected_schema.as_deref()).await?;
        r.truncated = limit_applied;
        return Ok(r);
    }
    drop(storage);
    let mut r = dispatch_query(&config, password.as_deref(), &effective_sql, cancel_token.as_deref()).await?;
    r.truncated = limit_applied;
    Ok(r)
}

#[tauri::command]
pub async fn list_schemas(
    id: String,
    storage: State<'_, StorageState>,
    attach_map: State<'_, SqliteAttachMap>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
    redis_pool: State<'_, super::redis::RedisPool>,
    mongo_pool: State<'_, super::mongo::MongoPool>,
) -> Result<Vec<String>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.conn_type == ConnType::Duckdb {
        return dispatch_duck_schemas(&id, &config, &duck_pool, &registry).await;
    }
    if config.conn_type == ConnType::SqlServer {
        return dispatch_ss_schemas(&id, &config, &ss_pool).await;
    }
    if config.conn_type == ConnType::Oracle {
        return super::oracle::list_schemas_impl(config, password, &*registry).await;
    }
    // Redis / MongoDB：用各自的连接池列出逻辑库（资产树「自动获取数据库列表」）
    if config.conn_type == ConnType::Redis {
        return super::redis::list_db_schemas(&id, &redis_pool, &storage).await;
    }
    if config.conn_type == ConnType::Mongodb {
        return super::mongo::list_db_schemas(&id, &mongo_pool, &config, password.as_deref()).await;
    }
    let attaches = attach_map.lock().unwrap().get(&id).cloned().unwrap_or_default();
    drop(storage);
    drop(attach_map);
    if matches!(config.conn_type, ConnType::Sqlite) {
        let mut schemas = vec!["main".to_string()];
        schemas.extend(attaches.into_iter().map(|(alias, _)| alias));
        Ok(schemas)
    } else {
        dispatch_schemas(&config, password.as_deref()).await
    }
}

/// SQL Server 专属：列出某数据库内的 SS-level Schema（dbo/HumanResources 等）
#[tauri::command]
pub async fn list_ss_db_schemas(
    id: String,
    database: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
) -> Result<Vec<String>, String> {
    let (config, _) = load_conn(&id, &storage)?;
    dispatch_ss_db_schemas(&id, &config, &database, &ss_pool).await
}

/// SQL Server 专属：列出 database.ss_schema 下的表和视图
#[tauri::command]
pub async fn list_ss_schema_tables(
    id: String,
    database: String,
    ss_schema: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
) -> Result<Vec<crate::models::TableInfo>, String> {
    let (config, _) = load_conn(&id, &storage)?;
    dispatch_ss_schema_tables(&id, &config, &database, &ss_schema, &ss_pool).await
}

#[tauri::command]
pub async fn list_tables(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    attach_map: State<'_, SqliteAttachMap>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<Vec<TableInfo>, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    if config.conn_type == ConnType::Duckdb {
        return dispatch_duck_tables(&id, &config, &schema, &duck_pool, &registry).await;
    }
    if config.conn_type == ConnType::SqlServer {
        return dispatch_ss_tables(&id, &config, &schema, &ss_pool).await;
    }
    if config.conn_type == ConnType::Oracle {
        return super::oracle::list_tables_impl(config, schema, password, &*registry).await;
    }
    let attaches = attach_map.lock().unwrap().get(&id).cloned().unwrap_or_default();
    drop(storage);
    drop(attach_map);
    if matches!(config.conn_type, ConnType::Sqlite) && !schema.is_empty() && schema != "main" {
        if let Some((_, path)) = attaches.iter().find(|(a, _)| a == &schema) {
            let mut conn = sqlite_open(&config).await?;
            let attach_sql = format!("ATTACH DATABASE '{}' AS \"{}\"",
                path.replace('\'', "''"), schema.replace('"', "\"\""));
            sqlx::query(&attach_sql).execute(&mut conn).await
                .map_err(|e| format!("ATTACH {schema} 失败: {e}"))?;
            use sqlx::Row;
            let rows = sqlx::query(
                &format!("SELECT name, type FROM \"{schema}\".sqlite_master \
                          WHERE type IN ('table','view') ORDER BY name"),
            ).fetch_all(&mut conn).await
                .map_err(|e| format!("获取 {schema} 表列表失败: {e}"))?;
            return Ok(rows.iter().filter_map(|r| {
                let name = r.try_get::<String, _>(0).ok()?;
                let kind = r.try_get::<String, _>(1).unwrap_or_default();
                Some(TableInfo { name, is_view: kind == "view" })
            }).collect());
        }
        return Err(format!("找不到附加库 '{schema}'"));
    }
    dispatch_tables(&config, password.as_deref(), &schema).await
}

#[tauri::command]
pub async fn table_columns(
    id: String,
    schema: String,
    table: String,
    ss_schema: Option<String>,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<ColumnInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_columns(&config, password.as_deref(), &schema, &table).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_columns(&config, password.as_deref(), &schema, &table).await
        }
        ConnType::Sqlite => { let p = sqlite_browse_pool(&config).await?; sqlite_columns(&p, &table).await }

        ConnType::ClickHouse => {
            super::clickhouse::columns(&config, password.as_deref(), &schema, &table).await
        }
        ConnType::SqlServer => super::sqlserver::dispatch_ss_columns_in_schema(&id, &config, &schema, &table, ss_schema.as_deref(), &ss_pool).await,
        ConnType::Duckdb => dispatch_duck_columns(&id, &config, &table, &duck_pool, &registry).await,
        ConnType::Oracle => super::oracle::table_columns_impl(config, schema, table, password, &*registry).await,
        _ => Err("此连接类型不支持表结构查看".into()),
    }
}

/// 一次性拉取整个 schema 的「表名 → 列名」映射，供 SQL 编辑器智能补全用。
/// 用单条 information_schema/系统表查询，替代前端「逐表 N 次往返」（远程库可省几十次 RTT）。
/// 仅 MySQL 系 / PG 系 / SQLite 走此快路径；其它方言返回 Err，由前端回退逐表加载。
#[tauri::command]
pub async fn schema_columns(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    use sqlx::Row;
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    // SQL Server / Oracle 各自批量实现（DuckDB 走前端逐表回退：其批量查询有行上限会截断）
    match config.conn_type {
        ConnType::SqlServer =>
            return dispatch_ss_schema_columns(&id, &config, &schema, &ss_pool).await,
        ConnType::Oracle =>
            return super::oracle::schema_columns_impl(config, schema, password, &*registry).await,
        _ => {}
    }
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let pool = mysql_pool(&config, password.as_deref()).await?;
            let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
            let rows = sqlx::query(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            )
            .bind(&schema)
            .fetch_all(&mut *conn).await
            .map_err(|e| format!("获取列信息失败: {e}"))?;
            // information_schema 文本列在部分 MySQL 上为二进制字符集，需鲁棒解码
            let getstr = |r: &sqlx::mysql::MySqlRow, i: usize| -> Option<String> {
                r.try_get::<String, _>(i).ok()
                    .or_else(|| r.try_get_unchecked::<String, _>(i).ok())
                    .or_else(|| r.try_get::<Vec<u8>, _>(i).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
            };
            for r in &rows {
                if let (Some(t), Some(c)) = (getstr(r, 0), getstr(r, 1)) {
                    map.entry(t).or_default().push(c);
                }
            }
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let pool = pg_pool(&config, password.as_deref()).await?;
            let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
            let rows = sqlx::query(
                "SELECT table_name, column_name FROM information_schema.columns \
                 WHERE table_schema = $1 ORDER BY table_name, ordinal_position",
            )
            .bind(&schema)
            .fetch_all(&mut *conn).await
            .map_err(|e| format!("获取列信息失败: {e}"))?;
            for r in &rows {
                if let (Ok(t), Ok(c)) = (r.try_get::<String, _>(0), r.try_get::<String, _>(1)) {
                    map.entry(t).or_default().push(c);
                }
            }
        }
        ConnType::Sqlite => {
            let pool = sqlite_browse_pool(&config).await?;
            let mut conn = pool.acquire().await.map_err(|e| format!("获取 SQLite 连接失败: {e}"))?;
            let rows = sqlx::query(
                "SELECT m.name AS t, p.name AS c \
                 FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' ORDER BY m.name, p.cid",
            )
            .fetch_all(&mut *conn).await
            .map_err(|e| format!("获取列信息失败: {e}"))?;
            for r in &rows {
                if let (Ok(t), Ok(c)) = (r.try_get::<String, _>(0), r.try_get::<String, _>(1)) {
                    map.entry(t).or_default().push(c);
                }
            }
        }
        _ => return Err("该连接类型不支持整库列名批量加载".into()),
    }
    Ok(map)
}

// ── 表元数据（SchemaBrowser 用）────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct TableMetaInfo {
    pub name: String,
    pub comment: String,
    #[serde(rename = "rowCount")]      pub row_count: i64,
    #[serde(rename = "dataLength")]    pub data_length: i64,
    #[serde(rename = "indexLength")]   pub index_length: i64,
    #[serde(rename = "autoIncrement")] pub auto_increment: Option<i64>,
    pub engine: String,
    pub charset: String,
    #[serde(rename = "updatedAt")]     pub updated_at: Option<String>,
    #[serde(rename = "createdAt")]     pub created_at: Option<String>,
    #[serde(rename = "tableType")]     pub table_type: String,
}

#[tauri::command]
pub async fn list_tables_meta(
    id: String,
    schema: String,
    ss_schema: Option<String>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<Vec<TableMetaInfo>, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    match config.conn_type {
        ConnType::SqlServer =>
            super::sqlserver::dispatch_ss_tables_meta_in_schema(&id, &config, &schema, ss_schema.as_deref(), &ss_pool).await,
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase =>
            mysql_tables_meta(&config, password.as_deref(), &schema).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss =>
            pg_tables_meta(&config, password.as_deref(), &schema).await,
        ConnType::Sqlite => { let p = sqlite_browse_pool(&config).await?; sqlite_tables_meta(&p).await }
        ConnType::Duckdb => duck_tables_meta(&id, &config, &schema, &duck_pool, &registry).await,
        ConnType::Oracle => super::oracle::tables_meta_impl(config, schema, password, &*registry).await,
        ConnType::ClickHouse => ch_tables_meta(&config, password.as_deref(), &schema).await,

        _ => Err("此连接类型不支持表元数据浏览".into()),
    }
}

// ── 例程 & DDL ───────────────────────────────────────────────────────────────

// RoutineInfo 已移至 models.rs（避免与 sqlserver/mod.rs 的循环依赖）
pub use crate::models::RoutineInfo;

#[tauri::command]
pub async fn list_routines(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<RoutineInfo>, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    match config.conn_type {
        ConnType::SqlServer =>
            dispatch_ss_routines(&id, &config, &schema, password.as_deref(), &ss_pool).await,
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase =>
            mysql_routines(&config, password.as_deref(), &schema).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss =>
            pg_routines(&config, password.as_deref(), &schema).await,
        ConnType::Oracle =>
            super::oracle::list_routines_impl(config, schema, password, &*registry).await,
        _ => Ok(vec![]),
    }
}

// ── SQLite 对象列表（S1.1：索引 + 触发器）─────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SqliteExtraObject {
    pub name:     String,
    pub tbl_name: String,
}

#[derive(serde::Serialize)]
pub struct SqliteExtraObjects {
    pub indexes:  Vec<SqliteExtraObject>,
    pub triggers: Vec<SqliteExtraObject>,
}

#[tauri::command]
pub async fn sqlite_list_objects(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<SqliteExtraObjects, String> {
    let (config, _) = load_conn(&id, &storage)?;
    drop(storage);
    if !matches!(config.conn_type, ConnType::Sqlite) {
        return Err("仅 SQLite 连接支持此操作".into());
    }
    use sqlx::{sqlite::SqliteConnection, Connection, Row};
    let url = sqlite_url(&config)?;
    let mut conn = SqliteConnection::connect(&url).await
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT type, name, tbl_name FROM sqlite_master \
         WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' \
         ORDER BY type, tbl_name, name",
    ).fetch_all(&mut conn).await
     .map_err(|e| format!("查询对象列表失败: {e}"))?;

    let mut indexes  = vec![];
    let mut triggers = vec![];
    for r in &rows {
        let kind:     String = r.try_get(0).unwrap_or_default();
        let name:     String = r.try_get(1).unwrap_or_default();
        let tbl_name: String = r.try_get(2).unwrap_or_default();
        let obj = SqliteExtraObject { name, tbl_name };
        match kind.as_str() {
            "index"   => indexes.push(obj),
            "trigger" => triggers.push(obj),
            _ => {}
        }
    }
    Ok(SqliteExtraObjects { indexes, triggers })
}

// ── SQLite 表标志（S1.2：STRICT / WITHOUT ROWID）─────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteTableFlags {
    pub is_strict:        bool,
    pub is_without_rowid: bool,
}

#[tauri::command]
pub async fn sqlite_table_flags(
    id: String,
    table: String,
    storage: State<'_, StorageState>,
) -> Result<SqliteTableFlags, String> {
    let (config, _) = load_conn(&id, &storage)?;
    drop(storage);
    if !matches!(config.conn_type, ConnType::Sqlite) {
        return Err("仅 SQLite 连接支持此命令".into());
    }
    validate_ident(&table)?;
    use sqlx::{sqlite::SqliteConnection, Connection, Row};
    let url = sqlite_url(&config)?;
    let mut conn = SqliteConnection::connect(&url).await
        .map_err(|e| format!("打开数据库失败: {e}"))?;

    // PRAGMA table_list 在 SQLite 3.37+ 可用；返回 wr(WITHOUT ROWID) 与 strict 列
    let tl_sql = format!("PRAGMA table_list(\"{}\")", table.replace('"', "\"\""));
    if let Ok(rows) = sqlx::query(&tl_sql).fetch_all(&mut conn).await {
        for r in &rows {
            let name: String = r.try_get("name").unwrap_or_default();
            if name == table {
                let wr:     i64 = r.try_get("wr").unwrap_or(0);
                let strict: i64 = r.try_get("strict").unwrap_or(0);
                return Ok(SqliteTableFlags {
                    is_strict:        strict != 0,
                    is_without_rowid: wr != 0,
                });
            }
        }
    }

    // 降级：从 sqlite_master.sql 解析（SQLite < 3.37）
    let create_sql: String = sqlx::query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=? COLLATE NOCASE",
    )
    .bind(&table)
    .fetch_optional(&mut conn).await
    .map_err(|e| format!("查询失败: {e}"))?
    .and_then(|r| r.try_get::<String, _>(0).ok())
    .unwrap_or_default();

    // 在右括号之后检查 WITHOUT ROWID / STRICT 关键字（不区分大小写）
    // 注：STRICT 表格特性从 SQLite 3.37 引入，而 PRAGMA table_list 也在 3.37 加入。
    // 因此能走到此降级路径的版本（< 3.37）不存在 STRICT 表，is_strict 必然为 false。
    // WITHOUT ROWID 从 SQLite 3.8.2 起存在，此降级路径有意义。
    let upper = create_sql.to_ascii_uppercase();
    let is_without_rowid = upper.contains("WITHOUT ROWID");
    // STRICT 在此降级路径下恒为 false（< 3.37 无 STRICT 表），直接返回 false。
    let is_strict = false;

    Ok(SqliteTableFlags { is_strict, is_without_rowid })
}

#[tauri::command]
pub async fn get_table_ddl(
    id: String,
    schema: String,
    table: String,
    ss_schema: Option<String>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<String, String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase =>
            mysql_table_ddl(&config, password.as_deref(), &schema, &table).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss =>
            pg_table_ddl(&config, password.as_deref(), &schema, &table).await,
        ConnType::Sqlite => sqlite_ddl(&sqlite_url(&config)?, &table).await,
        ConnType::Duckdb => dispatch_duck_ddl(&id, &config, &schema, &table, &duck_pool, &registry).await,
        ConnType::SqlServer => super::sqlserver::dispatch_ss_ddl_in_schema(&id, &config, &schema, &table, ss_schema.as_deref(), &ss_pool).await,
        ConnType::Oracle => super::oracle::get_table_ddl_impl(config, schema, table, password, &*registry).await,
        _ => Err("此连接类型不支持查看 DDL".into()),
    }
}

/// 按方言取「函数 / 存储过程」定义脚本。kind: "function" | "procedure"。
#[tauri::command]
pub async fn get_mysql_archive_object_sql(
    id: String, schema: String, name: String, kind: String,
    storage: State<'_, StorageState>,
) -> Result<String,String> {
    validate_ident(&name)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config,password)=load_conn(&id,&storage)?;
    if !matches!(config.conn_type,ConnType::Mysql|ConnType::Mariadb|ConnType::Tidb|ConnType::OceanBase) { return Err("此归档上下文仅支持 MySQL 系".into()); }
    let (mut conn,_tunnel)=mysql_connect(&config,password.as_deref()).await?;
    mysql_archive_object_sql(&mut conn,&schema,&name,&kind).await
}

async fn mysql_archive_object_sql(conn: &mut sqlx::mysql::MySqlConnection,schema:&str,name:&str,kind:&str) -> Result<String,String> {
    use sqlx::Row;
    if matches!(kind,"function"|"procedure") { return Err("例程归档暂不支持可靠重放创建时数据库排序规则，已停止导出；源定义未修改".into()); }
    if kind!="view" { return Err("归档对象类型无效".into()); }
    let target=if schema.is_empty() { q_mysql(name) } else { format!("{}.{}",q_mysql(schema),q_mysql(name)) };
    let row=sqlx::query(&format!("SHOW CREATE VIEW {target}")).fetch_one(&mut *conn).await.map_err(|e|format!("读取归档对象失败: {e}"))?;
    let ddl:String=row.try_get(1).map_err(|e|format!("读取归档定义失败: {e}"))?;
    if ddl.trim().is_empty() { return Err("归档对象定义为空".into()); }
    let mode:String=sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
    let charset:String=row.try_get(2).map_err(|e|format!("读取对象字符集失败: {e}"))?;
    let collation:String=row.try_get(3).map_err(|e|format!("读取对象排序规则失败: {e}"))?;
    if charset!="utf8mb4" || !collation.chars().all(|c|c.is_ascii_alphanumeric()||c=='_') {
        return Err("对象创建字符集不是 utf8mb4 或排序规则无法安全导出，已停止；未修改源定义".into());
    }
    let (prefix,suffix)=("",";\n");
    Ok(format!("SET @DBTERM_OBJECT_OLD_SQL_MODE=@@SESSION.sql_mode;\nSET @DBTERM_OBJECT_OLD_CHARSET=@@SESSION.character_set_client;\nSET @DBTERM_OBJECT_OLD_COLLATION=@@SESSION.collation_connection;\nSET SQL_MODE=CONVERT(X'{}' USING utf8mb4);\nSET character_set_client=utf8mb4;\nSET collation_connection={collation};\n{prefix}{ddl}{suffix}SET SQL_MODE=@DBTERM_OBJECT_OLD_SQL_MODE;\nSET character_set_client=@DBTERM_OBJECT_OLD_CHARSET;\nSET collation_connection=@DBTERM_OBJECT_OLD_COLLATION;\n",hex::encode(mode.as_bytes())))
}

/// MySQL=SHOW CREATE，PG=pg_get_functiondef，SQL Server=OBJECT_DEFINITION，Oracle=ALL_SOURCE。
#[tauri::command]
pub async fn get_routine_ddl(
    id: String,
    schema: String,
    name: String,
    kind: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<String, String> {
    validate_ident(&name)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase =>
            mysql_routine_ddl(&config, password.as_deref(), &schema, &name, &kind).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss =>
            pg_routine_ddl(&config, password.as_deref(), &schema, &name).await,
        // SQL Server：dispatch_ss_ddl 对非基表(视图/函数/存过)直接返回 OBJECT_DEFINITION
        ConnType::SqlServer => dispatch_ss_ddl(&id, &config, &schema, &name, &ss_pool).await,
        ConnType::Oracle => {
            let rtype = if kind.eq_ignore_ascii_case("function") { "FUNCTION" } else { "PROCEDURE" };
            super::oracle::routine_source_impl(config, schema, name, rtype.into(), password, &*registry).await
        }
        _ => Err("此连接类型暂不支持获取函数/存储过程定义".into()),
    }
}

async fn mysql_routine_ddl(config: &ConnConfig, password: Option<&str>, schema: &str, name: &str, kind: &str)
    -> Result<String, String>
{
    use sqlx::Row;
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let kw = if kind.eq_ignore_ascii_case("function") { "FUNCTION" } else { "PROCEDURE" };
    // SHOW CREATE accepts a fully-qualified routine name.  Using the schema
    // explicitly avoids relying on a pooled connection's session database
    // (which may be empty or belong to a different request).
    let selected_schema = if !schema.is_empty() {
        Some(schema)
    } else {
        config.database.as_deref().filter(|s| !s.is_empty())
    };
    let routine_ref = if let Some(db) = selected_schema {
        format!("{}.{}", q_mysql(db), q_mysql(name))
    } else {
        q_mysql(name)
    };
    // 兼容不接受 SHOW CREATE 带库名的旧版 MySQL 系服务器。
    let qualified_sql = format!("SHOW CREATE {kw} {routine_ref}");
    let row = match sqlx::query(&qualified_sql).fetch_one(&mut *conn).await {
        Ok(row) => row,
        Err(_) if selected_schema.is_some() => {
            let db = selected_schema.expect("checked above");
            sqlx::query(&format!("USE {}", q_mysql(db)))
                .execute(&mut *conn).await
                .map_err(|e| format!("获取定义失败: {e}"))?;
            sqlx::query(&format!("SHOW CREATE {kw} {}", q_mysql(name)))
                .fetch_one(&mut *conn).await
                .map_err(|e| format!("获取定义失败: {e}"))?
        }
        Err(e) => return Err(format!("获取定义失败: {e}")),
    };
    // 结果列：Procedure/Function | sql_mode | Create Procedure/Function | ...
    let ddl: String = row.try_get::<String, _>(2)
        .or_else(|_| row.try_get::<String, _>("Create Procedure"))
        .or_else(|_| row.try_get::<String, _>("Create Function"))
        .unwrap_or_default();
    if ddl.is_empty() { return Err(format!("未找到 {kw} {name} 的定义")); }
    Ok(ddl)
}

async fn pg_routine_ddl(config: &ConnConfig, password: Option<&str>, schema: &str, name: &str)
    -> Result<String, String>
{
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let sch = if schema.is_empty() { "public" } else { schema };
    let row = sqlx::query(
        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid LIMIT 1",
    ).bind(sch).bind(name)
     .fetch_optional(&mut *conn).await
     .map_err(|e| format!("获取定义失败: {e}"))?;
    match row {
        Some(r) => Ok(r.try_get::<String, _>(0).unwrap_or_default()),
        None => Err(format!("未找到函数/存储过程 {name} 的定义")),
    }
}

// ── 单元格行内编辑 ────────────────────────────────────────────────────────────

/// 标识符校验：拦截控制字符与超长；引用转义由各方言 quote 函数负责
fn validate_ident(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 || s.chars().any(|c| c.is_control()) {
        return Err("非法标识符".to_string());
    }
    Ok(())
}

fn q_mysql(s: &str) -> String { format!("`{}`", s.replace('`', "``")) }
fn mysql_use_database_sql(database: &str) -> String { format!("USE {}", q_mysql(database)) }
fn q_dq(s: &str)    -> String { format!("\"{}\"", s.replace('"', "\"\"")) }

/// 更新单个单元格：参数绑定防注入；事务内校验影响行数 == 1，否则回滚
#[tauri::command]
pub async fn update_cell(
    id: String,
    schema: String,
    table: String,
    ss_schema: Option<String>,
    column: String,
    new_value: Option<String>,
    pk_columns: Vec<String>,
    pk_values: Vec<Option<String>>,
    expected_values: Option<Vec<Option<String>>>,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    if pk_columns.is_empty() || pk_columns.len() != pk_values.len() {
        return Err("主键信息无效，无法定位行".to_string());
    }
    validate_ident(&table)?;
    validate_ident(&column)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    for c in &pk_columns { validate_ident(c)?; }

    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    // 只读护栏（fail-closed）：行内编辑不走 execute_query，须在此单独拦截，否则只读连接仍可改数。
    if config.read_only == Some(true) {
        return Err("该连接为只读模式，已拒绝写操作".to_string());
    }
    let expected=expected_values.ok_or("缺少原始值并发校验基线，请刷新结果后重试")?;
    if expected.len()!=1{return Err("原始值基线数量无效".into());}
    let changes=vec![CellRowUpdate{columns:vec![column.clone()],values:vec![new_value.clone()],pk_columns:pk_columns.clone(),pk_values:pk_values.clone(),expected_values:Some(expected.clone())}];
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_update_cells(&config,password.as_deref(),&schema,&table,&changes).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_update_cells(&config,password.as_deref(),&schema,&table,&changes).await
        }
        ConnType::Sqlite => {
            sqlite_update_cells(&sqlite_url(&config)?,&table,&changes).await
        }
        ConnType::SqlServer => {
            super::sqlserver::ss_update_cell(&id, &config, &schema, &table, &column,
                new_value, &pk_columns, &pk_values, &expected[0], &ss_pool, ss_schema.as_deref()).await
        }
        ConnType::Oracle => {
            super::oracle::update_cell_impl(config, schema, table, column,
                new_value, pk_columns, pk_values, expected[0].clone(), password, &*registry).await
        }
        _ => Err("此连接类型不支持行内编辑".into()),
    }
}

/// Caller owns transaction/locks; the SELECT holds metadata stable until its boundary.
pub(crate) async fn mysql_require_atomic_table(
    conn: &mut sqlx::mysql::MySqlConnection, schema: &str, table: &str,
) -> Result<(), String> {
    let schema = if schema.is_empty() {
        sqlx::query_scalar::<_, Option<String>>("SELECT DATABASE()")
            .fetch_one(&mut *conn).await.map_err(|e| format!("读取当前数据库失败: {e}"))?
            .ok_or_else(|| "未选定数据库，已拒绝写入".to_string())?
    } else { schema.to_string() };
    let target = format!("{}.{}", q_mysql(&schema), q_mysql(table));
    sqlx::query(&format!("SELECT * FROM {target} LIMIT 0"))
        .execute(&mut *conn).await.map_err(|e| format!("取得表元数据锁失败，已拒绝写入: {e}"))?;
    let (engine, kind): (Option<String>, String) = sqlx::query_as(
        "SELECT CAST(ENGINE AS CHAR), CAST(TABLE_TYPE AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?")
        .bind(&schema).bind(table).fetch_one(&mut *conn).await
        .map_err(|e| format!("核验表引擎失败，已拒绝写入: {e}"))?;
    // I_S.TRIGGERS hides rows without TRIGGER. Role-only grants fail closed.
    let visible: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT(CHAR(39),REPLACE(CURRENT_USER(),'@',CONCAT(CHAR(39),'@',CHAR(39))),CHAR(39)) AND PRIVILEGE_TYPE='TRIGGER') OR EXISTS(SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=CONCAT(CHAR(39),REPLACE(CURRENT_USER(),'@',CONCAT(CHAR(39),'@',CHAR(39))),CHAR(39)) AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER') OR EXISTS(SELECT 1 FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=CONCAT(CHAR(39),REPLACE(CURRENT_USER(),'@',CONCAT(CHAR(39),'@',CHAR(39))),CHAR(39)) AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER')")
        .bind(&schema).bind(&schema).bind(table).fetch_one(&mut *conn).await
        .map_err(|e| format!("核验触发器可见性失败，已拒绝写入: {e}"))?;
    let triggers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?")
        .bind(&schema).bind(table).fetch_one(&mut *conn).await
        .map_err(|e| format!("核验触发器失败，已拒绝写入: {e}"))?;
    validate_mysql_inline_edit(engine.as_deref(), &kind, visible != 0, triggers)?;
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut *conn).await
        .map_err(|e| format!("核验严格模式失败，已拒绝写入: {e}"))?;
    if !mode.split(',').any(|m| matches!(m, "STRICT_TRANS_TABLES" | "STRICT_ALL_TABLES")) {
        return Err("当前连接未开启严格 SQL 模式，无法防止数据静默截断，已拒绝写入".into());
    }
    Ok(())
}

fn validate_mysql_inline_edit(engine: Option<&str>, kind: &str, visible: bool, triggers: i64) -> Result<(), String> {
    if kind != "BASE TABLE" || !engine.is_some_and(|e| e.eq_ignore_ascii_case("InnoDB")) {
        return Err("安全写入仅支持 InnoDB 普通表，当前对象无法保证事务回滚，已拒绝写入".into());
    }
    if !visible { return Err("无法完整核验触发器：当前账号需要目标表、数据库或全局的直接 TRIGGER 权限；仅角色授权暂不支持，已拒绝写入".into()); }
    if triggers != 0 { return Err("目标表存在触发器，无法保证触发器对其他对象的事务安全，已拒绝写入".into()); }
    Ok(())
}

fn update_rollback_error<E: std::fmt::Display>(reason: &str, rollback: Result<(), E>) -> String {
    match rollback {
        Ok(()) => format!("{reason}；已回滚"),
        Err(e) => format!("{reason}；回滚未确认: {e}；请核查数据库，勿重复写入"),
    }
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRowUpdate {
    columns: Vec<String>,
    values: Vec<Option<String>>,
    pk_columns: Vec<String>,
    pk_values: Vec<Option<String>>,
    #[serde(default)]
    expected_values: Option<Vec<Option<String>>>,
}

#[tauri::command]
pub async fn update_cells(id: String, schema: String, table: String, changes: Vec<CellRowUpdate>, storage: State<'_, StorageState>) -> Result<(), String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    if changes.is_empty() || changes.len() > 10000 { return Err("批量修改行数必须介于 1 和 10000".into()); }
    for change in &changes {
        if change.columns.is_empty() || change.columns.len() != change.values.len() || change.pk_columns.is_empty() || change.pk_columns.len() != change.pk_values.len() {
            return Err("批量修改字段或定位信息无效，未执行任何修改".into());
        }
        validate_update_baseline(change)?;
        let mut seen = std::collections::HashSet::new();
        for c in &change.columns { validate_ident(c)?; if !seen.insert(c) { return Err("同一行包含重复修改字段，未执行任何修改".into()); } }
        for c in &change.pk_columns { validate_ident(c)?; }
    }
    if changes.len() > 1 && changes.iter().any(|change| change.columns.iter().any(|c| change.pk_columns.contains(c))) {
        return Err("多行修改同时改变定位字段，可能重定向后续记录；请先单独保存该行，暂存变更已保留".into());
    }
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    if config.read_only == Some(true) { return Err("该连接为只读模式，已拒绝写操作".into()); }
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => mysql_update_cells(&config, password.as_deref(), &schema, &table, &changes).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => pg_update_cells(&config, password.as_deref(), &schema, &table, &changes).await,
        ConnType::Sqlite => sqlite_update_cells(&sqlite_url(&config)?, &table, &changes).await,
        _ => Err("当前数据库暂不支持多项修改的原子保存，请每次仅保留一项修改后提交".into()),
    }
}

#[cfg(test)]
#[path = "optimistic_update_tests.rs"]
mod optimistic_update_tests;
#[cfg(test)]
#[path = "commit_disconnect_tests.rs"]
pub(crate) mod commit_disconnect_tests;

fn validate_update_baseline(change:&CellRowUpdate)->Result<&[Option<String>],String>{
    change.expected_values.as_deref().filter(|values|values.len()==change.columns.len()).ok_or_else(||"缺少原始值并发校验基线或数量无效，请刷新后重试".into())
}
fn update_conflict()->String{"记录已被其他会话修改或原始值无法精确核验，未覆盖新值；请刷新后重新编辑".into()}

fn cell_update_sql(target: &str, change: &CellRowUpdate, mysql: bool, pg_types: Option<&[String]>) -> (String, String) {
    let quote = |s: &str| if mysql { q_mysql(s) } else { q_dq(s) };
    let mut index = 0;
    let mut placeholder = || { index += 1; if pg_types.is_some() { format!("${index}") } else { "?".into() } };
    let set: Vec<String> = change.columns.iter().zip(&change.values).enumerate().map(|(i, (c, v))| {
        let value = if v.is_some() { let p = placeholder(); if let Some(types) = pg_types { format!("CAST({p} AS {})", types[i]) } else { p } } else { "NULL".into() };
        format!("{} = {value}", quote(c))
    }).collect();
    let predicates: Vec<String> = change.pk_columns.iter().zip(&change.pk_values).map(|(c, v)| {
        if v.is_some() { let p = placeholder(); format!("{}{} = {p}", quote(c), if pg_types.is_some() { "::text" } else { "" }) }
        else { format!("{} IS NULL", quote(c)) }
    }).collect();
    let predicate = predicates.join(" AND ");
    (format!("UPDATE {target} SET {} WHERE {predicate}", set.join(", ")), predicate)
}

async fn mysql_update_cells(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str, changes: &[CellRowUpdate]) -> Result<(), String> {
    use sqlx::Connection;
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result: Result<(), String> = async {
        mysql_require_atomic_table(&mut tx, schema, table).await?;
        let target = if schema.is_empty() { q_mysql(table) } else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
        for change in changes {
            let expected=validate_update_baseline(change)?;
            let (sql, predicate) = cell_update_sql(&target, change, true, None);
            let lookup_sql = format!("SELECT {} FROM {target} WHERE {predicate} LIMIT 2 FOR UPDATE",change.columns.iter().chain(&change.pk_columns).map(|c|q_mysql(c)).collect::<Vec<_>>().join(","));
            let mut lookup = sqlx::query(&lookup_sql);
            for v in change.pk_values.iter().flatten() { lookup = lookup.bind(v); }
            let rows=lookup.fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
            if rows.len()!=1{return Err(update_count_err(rows.len() as u64));}
            use sqlx::{Row,Column,TypeInfo};
            for (i,value) in expected.iter().chain(&change.pk_values).enumerate(){
                if value.is_none(){
                    use sqlx::Decode;
                    let raw=rows[0].try_get_raw(i).map_err(|e|e.to_string())?;
                    if !matches!(<&[u8] as Decode<sqlx::MySql>>::decode(raw),Err(e) if e.is::<sqlx::error::UnexpectedNullError>()){return Err(update_conflict());}
                }
                let typ=rows[0].columns()[i].type_info().name().to_ascii_uppercase();
                // Binary collations can label ordinary VARCHAR as VARBINARY.
                // Declared binary/blob types are rejected below from authoritative column metadata.
                if typ.contains("FLOAT")||typ.contains("DOUBLE")||typ=="BIT"{return Err("该字段显示值不能恢复精确并发基线，已拒绝覆盖；请使用显式 SQL".into());}
                if mysql_cell(&rows[0],i)!=*value{return Err(update_conflict());}
            }
            let schema_name=if schema.is_empty(){sqlx::query_scalar::<_,String>("SELECT DATABASE()").fetch_one(&mut *tx).await.map_err(|e|e.to_string())?}else{schema.to_string()};
            for column in change.columns.iter().chain(&change.pk_columns){
                let (typ,extra):(String,String)=sqlx::query_as("SELECT CAST(DATA_TYPE AS CHAR),CAST(EXTRA AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?").bind(&schema_name).bind(table).bind(column).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                if matches!(typ.as_str(),"binary"|"varbinary"|"tinyblob"|"blob"|"mediumblob"|"longblob"|"bit"){return Err("该字段显示值不能恢复精确并发基线，已拒绝覆盖；请使用显式 SQL".into());}
                if matches!(typ.as_str(),"enum"|"set")||extra.contains("GENERATED")&&!extra.contains("DEFAULT_GENERATED"){return Err("枚举、集合或生成列无法从结果显示恢复精确编辑基线，已拒绝更新".into());}
            }
            let mut query = sqlx::query(&sql);
            for v in change.values.iter().chain(&change.pk_values).flatten() { query = query.bind(v); }
            let count = query.execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
            let warnings = sqlx::Executor::fetch_one(&mut *tx, "SHOW COUNT(*) WARNINGS").await.map_err(|e| e.to_string())?;
            let warnings: u64 = sqlx::Row::try_get(&warnings, 0).map_err(|e| e.to_string())?;
            if warnings != 0 { return Err("更新产生服务端警告，拒绝提交".into()); }
            if count != 1 { return Err(update_count_err(count)); }
        }
        Ok(())
    }.await;
    if let Err(e) = result { return Err(update_rollback_error(&e, tx.rollback().await)); }
    tx.commit().await.map_err(|e| format!("提交未得到成功确认: {e}；请核查数据库，勿重复写入"))
}

async fn pg_update_cells(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str, changes: &[CellRowUpdate]) -> Result<(), String> {
    use sqlx::Connection;
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result: Result<(), String> = async {
        let schema = if schema.is_empty() { "public" } else { schema };
        let target = format!("{}.{}", q_dq(schema), q_dq(table));
        for change in changes {
            let expected=validate_update_baseline(change)?;
            let predicates=change.pk_columns.iter().enumerate().map(|(i,n)|format!("{}::text IS NOT DISTINCT FROM ${}",q_dq(n),i+1)).collect::<Vec<_>>().join(" AND ");
            let lookup=format!("SELECT {} FROM {target} WHERE {predicates} LIMIT 2 FOR UPDATE",change.columns.iter().chain(&change.pk_columns).map(|n|q_dq(n)).collect::<Vec<_>>().join(","));
            let mut q=sqlx::query(&lookup);for value in &change.pk_values{q=q.bind(value.as_deref());}
            let rows=q.fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;if rows.len()!=1{return Err(update_count_err(rows.len() as u64));}
            for(i,value)in expected.iter().chain(&change.pk_values).enumerate(){use sqlx::{Row,ValueRef,Column,TypeInfo};let typ=rows[0].columns()[i].type_info().name();if !matches!(typ,"BOOL"|"INT2"|"INT4"|"INT8"|"FLOAT4"|"FLOAT8"|"TEXT"|"VARCHAR"|"BPCHAR"|"DATE"|"TIME"|"TIMESTAMP"|"TIMESTAMPTZ"){return Err("字段类型无法恢复精确编辑基线，请使用显式 SQL".into());}let raw=rows[0].try_get_raw(i).map_err(|e|e.to_string())?;if value.is_none()!=raw.is_null()||pg_cell(&rows[0],i)!=*value{return Err(update_conflict());}}
            let mut types = Vec::new();
            for column in &change.columns {
                let (kind, udt): (String, String) = sqlx::query_as("SELECT data_type, udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3")
                    .bind(schema).bind(table).bind(column).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                let kind = if matches!(kind.as_str(), "ARRAY" | "USER-DEFINED") { q_dq(&udt) } else {
                    if !kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')' | ',')) { return Err("列类型暂不支持批量修改".into()); }
                    kind
                };
                types.push(kind);
            }
            let (sql, _) = cell_update_sql(&target, change, false, Some(&types));
            let mut query = sqlx::query(&sql);
            for v in change.values.iter().chain(&change.pk_values).flatten() { query = query.bind(v); }
            let count = query.execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
            if count != 1 { return Err(update_count_err(count)); }
        }
        Ok(())
    }.await;
    if let Err(e) = result { return Err(update_rollback_error(&e, tx.rollback().await)); }
    tx.commit().await.map_err(|e| format!("提交未得到成功确认: {e}；请核查数据库，勿重复写入"))
}

async fn sqlite_update_cells(url: &str, table: &str, changes: &[CellRowUpdate]) -> Result<(), String> {
    use sqlx::Connection;
    let mut conn = sqlx::sqlite::SqliteConnection::connect(url).await.map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result: Result<(), String> = async {
        for change in changes {
            let expected=validate_update_baseline(change)?;
            let predicates=change.pk_columns.iter().map(|n|format!("{} IS ?",q_dq(n))).collect::<Vec<_>>().join(" AND ");
            let lookup=format!("SELECT {} FROM {} WHERE {predicates} LIMIT 2",change.columns.iter().chain(&change.pk_columns).map(|n|q_dq(n)).collect::<Vec<_>>().join(","),q_dq(table));
            let mut q=sqlx::query(&lookup);for value in &change.pk_values{q=q.bind(value.as_deref());}
            let rows=q.fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;if rows.len()!=1{return Err(update_count_err(rows.len() as u64));}
            for(i,value)in expected.iter().chain(&change.pk_values).enumerate(){use sqlx::{Row,ValueRef,TypeInfo};let raw=rows[0].try_get_raw(i).map_err(|e|e.to_string())?;if !matches!(raw.type_info().name(),"NULL"|"INTEGER"|"REAL"|"TEXT"){return Err("字段类型无法恢复精确编辑基线，请使用显式 SQL".into());}if value.is_none()!=raw.is_null()||sqlite_cell(&rows[0],i)!=*value{return Err(update_conflict());}}
            let (sql, _) = cell_update_sql(&q_dq(table), change, false, None);
            let mut query = sqlx::query(&sql);
            for v in change.values.iter().chain(&change.pk_values).flatten() { query = query.bind(v); }
            let count = query.execute(&mut *tx).await.map_err(|e| e.to_string())?.rows_affected();
            if count != 1 { return Err(update_count_err(count)); }
        }
        Ok(())
    }.await;
    if let Err(e) = result { return Err(update_rollback_error(&e, tx.rollback().await)); }
    tx.commit().await.map_err(|e| format!("提交未得到成功确认: {e}；请核查数据库，勿重复写入"))
}

#[cfg(test)]
async fn mysql_update_cell(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str, column: &str,
    new_value: Option<String>, pk_columns: &[String], pk_values: &[Option<String>],
) -> Result<(), String> {
    use sqlx::Connection;
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;
    mysql_require_atomic_table(&mut tx, schema, table).await?;

    let target = if schema.is_empty() { q_mysql(table) } else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
    let set_part = if new_value.is_some() { format!("{} = ?", q_mysql(column)) } else { format!("{} = NULL", q_mysql(column)) };
    let where_parts: Vec<String> = pk_columns.iter().zip(pk_values)
        .map(|(c, v)| if v.is_some() { format!("{} = ?", q_mysql(c)) } else { format!("{} IS NULL", q_mysql(c)) })
        .collect();
    let sql = format!("UPDATE {target} SET {set_part} WHERE {}", where_parts.join(" AND "));
    let lookup_sql = format!("SELECT 1 FROM {target} WHERE {} LIMIT 2 FOR UPDATE", where_parts.join(" AND "));
    let mut lookup = sqlx::query(&lookup_sql);
    for v in pk_values.iter().flatten() { lookup = lookup.bind(v); }
    let matches = lookup.fetch_all(&mut *tx).await.map_err(|e| format!("锁定目标行失败: {e}"))?.len() as u64;
    if matches != 1 {
        return Err(update_rollback_error(&update_count_err(matches), tx.rollback().await));
    }

    let mut q = sqlx::query(&sql);
    if let Some(v) = &new_value { q = q.bind(v); }
    for v in pk_values.iter().flatten() { q = q.bind(v); }
    let res = match q.execute(&mut *tx).await {
        Ok(res) => res,
        Err(e) => return Err(update_rollback_error(&format!("更新失败: {e}"), tx.rollback().await)),
    };
    let warnings = match sqlx::Executor::fetch_one(&mut *tx, "SHOW COUNT(*) WARNINGS").await
        .and_then(|row| sqlx::Row::try_get::<u64, _>(&row, 0)) {
        Ok(n) => n,
        Err(e) => return Err(update_rollback_error(&format!("无法确认更新警告状态: {e}"), tx.rollback().await)),
    };
    if warnings != 0 {
        return Err(update_rollback_error("更新产生服务端警告，拒绝提交以防数据截断或转换", tx.rollback().await));
    }

    let n = res.rows_affected();
    if n != 1 {
        return Err(update_rollback_error(&update_count_err(n), tx.rollback().await));
    }
    tx.commit().await.map_err(|e| format!("提交未得到成功确认: {e}；请核查数据库，勿重复写入"))
}

#[cfg(test)]
async fn sqlite_update_cell(
    url: &str, table: &str, column: &str,
    new_value: Option<String>, pk_columns: &[String], pk_values: &[Option<String>],
) -> Result<(), String> {
    use sqlx::{sqlite::SqliteConnection, Connection};
    let mut conn = SqliteConnection::connect(url).await
        .map_err(|e| format!("连接失败: {e}"))?;
    let mut tx = conn.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;

    let set_part = if new_value.is_some() { format!("{} = ?", q_dq(column)) } else { format!("{} = NULL", q_dq(column)) };
    let where_parts: Vec<String> = pk_columns.iter().zip(pk_values)
        .map(|(c, v)| if v.is_some() { format!("{} = ?", q_dq(c)) } else { format!("{} IS NULL", q_dq(c)) })
        .collect();
    let sql = format!("UPDATE {} SET {set_part} WHERE {}", q_dq(table), where_parts.join(" AND "));

    let mut q = sqlx::query(&sql);
    if let Some(v) = &new_value { q = q.bind(v); }
    for v in pk_values.iter().flatten() { q = q.bind(v); }
    let res = match q.execute(&mut *tx).await {
        Ok(res) => res,
        Err(e) => return Err(update_rollback_error(&format!("更新失败: {e}"), tx.rollback().await)),
    };

    let n = res.rows_affected();
    if n != 1 {
        return Err(update_rollback_error(&update_count_err(n), tx.rollback().await));
    }
    tx.commit().await.map_err(|e| format!("提交未得到成功确认: {e}；请核查数据库，勿重复写入"))
}

fn update_count_err(n: u64) -> String {
    if n == 0 {
        "未找到匹配行（或值未变化）".to_string()
    } else {
        format!("预期影响 1 行，实际影响 {n} 行")
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().unwrap().load()?;
    let config = configs
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// 去掉 SQL 开头的注释（块注释 /* ... */ 与行注释 -- ...）和空白，便于按首关键字判断语句类型。
pub(crate) fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => { s = rest[end + 2..].trim_start(); continue; }
                None => break, // 注释未闭合，放弃剥离
            }
        }
        if s.starts_with("--") {
            match s.find('\n') {
                Some(nl) => { s = s[nl + 1..].trim_start(); continue; }
                None => break,
            }
        }
        break;
    }
    s
}

// ── 查询取消登记表：token -> 中止信号发送端 ────────────────────────────
// 取消时直接「中止正在执行该查询的那条连接」（客户端关闭连接）。这比从另一条连接去 KILL
// 可靠得多：MGR / 代理多节点下，另开连接可能落到别的节点，KILL 会报「Unknown thread id」。
struct AbortEntry {
    owner: String,
    generation: uuid::Uuid,
    sender: Option<tokio::sync::oneshot::Sender<()>>,
}
fn abort_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, AbortEntry>> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, AbortEntry>>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A pooled session is reusable only after its entire request succeeds.
/// Cancellation can drop the future before an explicit error branch runs.
struct QueryLease<DB: sqlx::Database> { connection: sqlx::pool::PoolConnection<DB>, complete: bool }
impl<DB: sqlx::Database> QueryLease<DB> {
    fn new(connection: sqlx::pool::PoolConnection<DB>) -> Self { Self { connection, complete: false } }
    fn mark_complete(&mut self) { self.complete = true; }
}
impl<DB: sqlx::Database> std::ops::Deref for QueryLease<DB> {
    type Target = DB::Connection;
    fn deref(&self) -> &Self::Target { &self.connection }
}
impl<DB: sqlx::Database> std::ops::DerefMut for QueryLease<DB> {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.connection }
}
impl<DB: sqlx::Database> Drop for QueryLease<DB> {
    fn drop(&mut self) { if !self.complete { self.connection.close_on_drop(); } }
}

pub(crate) struct AbortGuard { token: String, generation: uuid::Uuid }
impl Drop for AbortGuard {
    fn drop(&mut self) {
        let mut registry = abort_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if registry.get(&self.token).is_some_and(|entry| entry.generation == self.generation) {
            registry.remove(&self.token);
        }
    }
}

pub(crate) fn abort_register_for(token: &str, owner: &str)
    -> Result<(AbortGuard, tokio::sync::oneshot::Receiver<()>), String>
{
    validate_cancel_token(Some(token))?;
    let mut registry = abort_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if registry.contains_key(token) { return Err("取消令牌正在使用，已拒绝重复请求".into()); }
    let generation = uuid::Uuid::new_v4();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    registry.insert(token.into(), AbortEntry { owner: owner.into(), generation, sender: Some(sender) });
    Ok((AbortGuard { token: token.into(), generation }, receiver))
}

/// Signal only the matching request. Keep the entry reserved until its owner exits.
/// Never reconnect by mutable config and terminate a process ID on another server.
pub fn cancel_abort_for(token: &str, owner: &str) -> bool {
    let mut registry = abort_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    registry.get_mut(token).filter(|entry| entry.owner == owner)
        .and_then(|entry| entry.sender.take()).is_some_and(|sender| sender.send(()).is_ok())
}

pub(crate) fn validate_cancel_token(token: Option<&str>) -> Result<(), String> {
    if let Some(token) = token {
        if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("无效的取消令牌".into());
        }
    }
    Ok(())
}
/// 整词扫描写/DDL 关键字——仅用于「无引擎级只读」的引擎(SQLServer/ClickHouse)在只读模式下兜底，
/// 防 WITH/EXPLAIN 前缀夹带 DML。只读连接上偶有误拦合法读属可接受(fail-closed)。
fn contains_write_keyword(sql: &str) -> bool {
    const KW: &[&str] = &["INSERT","UPDATE","DELETE","MERGE","DROP","CREATE","ALTER",
        "TRUNCATE","GRANT","REVOKE","REPLACE","CALL","EXEC","EXECUTE","INTO"];
    let up = strip_leading_comments(sql).to_uppercase();
    up.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|tok| KW.contains(&tok))
}

pub(crate) fn is_read_only_safe_stmt(sql: &str, kind: &ConnType) -> bool {
    if !is_query_stmt(sql) { return false; }
    let needs_app_guard = matches!(kind, ConnType::SqlServer | ConnType::ClickHouse | ConnType::Duckdb | ConnType::Oracle);
    !needs_app_guard || !contains_write_keyword(sql)
}

/// 检测 SQL 中是否已含 FETCH FIRST/NEXT 或 ROWNUM 子句（Oracle 分页语法）。
fn top_level_words(sql: &str) -> Vec<String> {
    use sqlparser::{dialect::GenericDialect, tokenizer::{Token, Tokenizer}};
    let Ok(tokens) = Tokenizer::new(&GenericDialect {}, sql).tokenize() else { return Vec::new(); };
    let mut words = Vec::new();
    let mut depth = 0usize;
    for token in tokens {
        match token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            Token::Word(word) if depth == 0 && word.quote_style.is_none() => words.push(word.value.to_ascii_uppercase()),
            _ => {}
        }
    }
    words
}

fn has_fetch_clause(sql: &str, kind: &ConnType) -> bool {
    let words = top_level_words(sql);
    (*kind == ConnType::Oracle && words.iter().any(|w| w == "ROWNUM"))
        || words.windows(2).any(|w| w[0] == "FETCH" && (w[1] == "FIRST" || w[1] == "NEXT"))
}

/// Appending LIMIT/FETCH after a locking clause is invalid in MySQL/PostgreSQL/Oracle.
/// Leave such queries unchanged; the decoded-result budget remains the hard fallback.
fn has_locking_clause(sql: &str) -> bool {
    let words = top_level_words(sql);
    words.windows(2).any(|w| w[0] == "FOR" && matches!(w[1].as_str(), "UPDATE" | "SHARE"))
        || words.windows(4).any(|w| w == ["LOCK", "IN", "SHARE", "MODE"])
        || words.windows(4).any(|w| w == ["FOR", "NO", "KEY", "UPDATE"])
        || words.windows(3).any(|w| w == ["FOR", "KEY", "SHARE"])
        || words.windows(4).any(|w| w == ["FOR", "NO", "KEY", "SHARE"])
}

fn has_limit_clause(sql: &str) -> bool {
    top_level_words(sql).iter().any(|w| w == "LIMIT")
}

pub(crate) fn apply_query_row_limit(sql: &str, row_limit: Option<u64>, kind: &ConnType) -> (String, bool) {
    if *kind == ConnType::SqlServer { return apply_sqlserver_row_limit(sql, row_limit); }
    if !supports_auto_row_limit(sql) || has_limit_clause(sql) || has_fetch_clause(sql, kind) || has_locking_clause(sql) {
        return (sql.to_string(), false);
    }
    let Some(limit) = row_limit else { return (sql.to_string(), false); };
    let base = sql.trim_end().trim_end_matches(';').trim_end();
    if *kind == ConnType::Oracle {
        (format!("{base}\nFETCH FIRST {limit} ROWS ONLY"), true)
    } else {
        (format!("{base}\nLIMIT {limit}"), true)
    }
}

fn has_sqlserver_row_limit(sql: &str) -> bool {
    let words = top_level_words(sql);
    words.iter().any(|w| matches!(w.as_str(), "TOP" | "FETCH" | "OFFSET"))
}

fn sqlserver_top_insert_at(sql: &str) -> Option<usize> {
    use sqlparser::{dialect::MsSqlDialect, tokenizer::{Location, Token, Tokenizer}};
    let tokens = Tokenizer::new(&MsSqlDialect {}, sql).tokenize_with_location().ok()?;
    let mut top = Vec::new();
    let mut depth = 0usize;
    for token in tokens {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.checked_sub(1)?,
            Token::Whitespace(_) => {},
            other if depth == 0 => top.push((other, token.span.end)),
            _ => {},
        }
    }
    if depth != 0 { return None; }
    let head = match &top.first()?.0 {
        Token::Word(word) if word.quote_style.is_none() => word.value.to_ascii_uppercase(),
        _ => return None,
    };
    if head != "SELECT" && head != "WITH" { return None; }
    // TOP applies to one SELECT arm, not to a UNION/EXCEPT/INTERSECT result.
    // Rewriting those would change which rows are selected, so leave them alone.
    if top.iter().enumerate().any(|(i, (token, _))| {
        matches!(token, Token::SemiColon) && i + 1 != top.len()
            || matches!(token, Token::Word(word) if word.quote_style.is_none()
                && matches!(word.value.to_ascii_uppercase().as_str(), "UNION" | "EXCEPT" | "INTERSECT" | "INTO"))
    }) { return None; }
    let select = if head == "SELECT" { 0 } else {
        // The first top-level command after the CTE definitions must be SELECT.
        // A later SELECT in INSERT ... SELECT is part of a write statement.
        let command = top.iter().position(|(token, _)| matches!(token, Token::Word(word)
            if word.quote_style.is_none() && matches!(word.value.to_ascii_uppercase().as_str(),
                "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE")))?;
        if !matches!(&top[command].0, Token::Word(word) if word.value.eq_ignore_ascii_case("SELECT")) {
            return None;
        }
        command
    };
    let mut end = top[select].1;
    if let Some((Token::Word(word), modifier_end)) = top.get(select + 1) {
        if word.quote_style.is_none() && (word.value.eq_ignore_ascii_case("DISTINCT")
            || word.value.eq_ignore_ascii_case("ALL")) {
            end = *modifier_end;
        }
    }
    // Tokenizer locations count characters, while Rust slices use UTF-8 bytes.
    let mut line = 1u64;
    let mut column = 1u64;
    for (offset, ch) in sql.char_indices() {
        if Location::new(line, column) == end { return Some(offset); }
        if ch == '\n' { line += 1; column = 1; } else { column += 1; }
    }
    (Location::new(line, column) == end).then_some(sql.len())
}

fn apply_sqlserver_row_limit(sql: &str, row_limit: Option<u64>) -> (String, bool) {
    let Some(lim) = row_limit else { return (sql.to_string(), false) };
    if lim == 0 || !supports_auto_row_limit(sql) || has_sqlserver_row_limit(sql) {
        return (sql.to_string(), false);
    }
    if let Some(pos) = sqlserver_top_insert_at(sql) {
        let mut out = String::with_capacity(sql.len() + 16);
        out.push_str(&sql[..pos]);
        out.push_str(&format!(" TOP {lim}"));
        out.push_str(&sql[pos..]);
        (out, true)
    } else {
        (sql.to_string(), false)
    }
}

pub(crate) fn is_query_stmt(sql: &str) -> bool {
    let up = strip_leading_comments(sql).to_uppercase();
    up.starts_with("SELECT")
        || up.starts_with("SHOW")
        || up.starts_with("DESC")
        || up.starts_with("EXPLAIN")
        || up.starts_with("WITH")
        || up.starts_with("PRAGMA")
}

fn supports_auto_row_limit(sql: &str) -> bool {
    let up = strip_leading_comments(sql).to_uppercase();
    up.starts_with("SELECT") || up.starts_with("WITH")
}

/// Decode one driver row at a time; never retain both full raw and decoded results.
/// Overflow returns an error instead of presenting an incomplete result as complete.
pub(crate) async fn collect_query_rows<S, R, F>(mut stream: S, mut decode: F)
    -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String>
where
    S: futures::Stream<Item = Result<R, sqlx::Error>> + Unpin,
    R: sqlx::Row,
    F: FnMut(&R, usize) -> Option<String>,
{
    use futures::TryStreamExt;
    use sqlx::Column;
    let mut budget = super::query_result_budget::ResultBudget::default();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    while let Some(row) = stream.try_next().await.map_err(|e| format!("读取查询结果失败: {e}"))? {
        budget.start_row()?;
        if columns.is_empty() { columns = row.columns().iter().map(|c| c.name().to_string()).collect(); }
        let mut decoded = Vec::new();
        for i in 0..row.columns().len() {
            let cell = decode(&row, i);
            budget.cell(cell.as_deref())?;
            decoded.push(cell);
        }
        rows.push(decoded);
    }
    Ok((columns, rows))
}

// ── dispatch ──────────────────────────────────────────────────────────────────

pub(crate) async fn dispatch_query(
    config: &ConnConfig,
    password: Option<&str>,
    sql: &str,
    cancel_token: Option<&str>,
) -> Result<QueryResult, String> {
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_query(config, password, sql, cancel_token).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_query(config, password, sql, cancel_token).await
        }
        ConnType::Sqlite => {
            let conn = sqlite_open(config).await?;
            sqlite_query_conn(conn, sql, cancel_token, &config.id).await
        }
        ConnType::Redis     => Err("Redis 不支持 SQL 查询".into()),
        ConnType::ClickHouse => super::clickhouse::query(config, password, sql).await,
        ConnType::Mongodb   => Err("MongoDB 请使用专属 mongo_* 命令".into()),
        ConnType::Duckdb    => Err("DuckDB 请通过 execute_query（含 duck_pool/registry）调用".into()),
        ConnType::SqlServer => Err("SQL Server 请通过顶层 execute_query 命令调用（需要 SsPool）".into()),
        ConnType::Oracle    => Err("Oracle 请通过顶层 execute_query 命令调用（需要 registry）".into()),
        ConnType::Ssh | ConnType::Local => Err("此连接类型不是数据库连接".into()),
    }
}

async fn dispatch_schemas(
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<Vec<String>, String> {
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_schemas(config, password).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_schemas(config, password).await
        }
        ConnType::Sqlite => Ok(vec!["main".into()]),
        ConnType::ClickHouse => super::clickhouse::schemas(config, password).await,
        ConnType::Mongodb   => Err("MongoDB 请使用 mongo_list_databases".into()),
        _ => Err("此连接类型不支持 schema 浏览".into()),
    }
}

async fn dispatch_tables(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
) -> Result<Vec<TableInfo>, String> {
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_tables(config, password, schema).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_tables(config, password, schema).await
        }
        ConnType::Sqlite => { let p = sqlite_browse_pool(config).await?; sqlite_tables(&p).await }
        ConnType::ClickHouse => super::clickhouse::tables(config, password, schema).await,
        ConnType::Mongodb   => Err("MongoDB 请使用 mongo_list_collections".into()),
        _ => Err("此连接类型不支持表浏览".into()),
    }
}

// ── URL builders ──────────────────────────────────────────────────────────────

pub fn sqlite_url(config: &ConnConfig) -> Result<String, String> {
    let path = config
        .file_path
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;
    // 路径安全校验：拒绝 URL 特殊字符（防止注入 ?mode=rw 等参数覆盖安全设置）
    if path.contains('?') || path.contains('#') || path.contains('\0') {
        return Err("SQLite 文件路径包含非法字符（?/#/\\0）".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("SQLite 文件路径必须是绝对路径".to_string());
    }
    let cfg = DbConnCfg::from_config(config)?;
    let readonly = cfg.sqlite_readonly || config.read_only.unwrap_or(false);
    if cfg.sqlite_immutable {
        Ok(format!("sqlite://{}?immutable=1", path))
    } else if readonly {
        Ok(format!("sqlite://{}?mode=ro", path))
    } else {
        Ok(format!("sqlite://{path}"))
    }
}

/// 建立 SQLite 连接，应用 busy_timeout / foreign_keys / query_only
async fn sqlite_open(config: &ConnConfig) -> Result<sqlx::sqlite::SqliteConnection, String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;
    let url = sqlite_url(config)?;
    let cfg = DbConnCfg::from_config(config)?;
    let busy_ms = if cfg.sqlite_busy_timeout == 0 { 5000 } else { cfg.sqlite_busy_timeout };
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .busy_timeout(std::time::Duration::from_millis(busy_ms as u64))
        .foreign_keys(cfg.sqlite_foreign_keys)
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
    // 只读双保险（readonly 或 immutable 均强制 query_only）
    if cfg.sqlite_readonly || config.read_only.unwrap_or(false) || cfg.sqlite_immutable {
        sqlx::query("PRAGMA query_only=ON").execute(&mut conn).await
            .map_err(|e| format!("设置 query_only 失败: {e}"))?;
    }
    Ok(conn)
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

/// Commands that MySQL does not support via the prepared-statement protocol.
/// These must be sent as raw text queries.
pub(crate) fn needs_text_protocol(sql: &str) -> bool {
    let upper = strip_leading_comments(sql).to_uppercase();
    // 存储程序 DDL（函数/存储过程/触发器/事件，含 BEGIN...END 复合体）在 prepared 协议下报 1295，
    // 必须走文本协议；文本协议对任何 DDL 都安全，故仅按 CREATE/DROP/ALTER 起始 + 对象类型判断。
    let is_routine_ddl = (upper.starts_with("CREATE") || upper.starts_with("DROP") || upper.starts_with("ALTER"))
        && (upper.contains(" FUNCTION") || upper.contains(" PROCEDURE")
            || upper.contains(" TRIGGER") || upper.contains(" EVENT"));
    // CALL 存储过程（可能返回结果集）在 prepared 协议下报 1295；执行页的「SET @x;CALL ...」组合也需文本协议
    let is_call = upper.starts_with("CALL ") || (upper.starts_with("SET @") && upper.contains("CALL "));
    // MySQL 用户级 PREPARE/EXECUTE/DEALLOCATE PREPARE 本身就是服务端预编译语句控制命令，
    // 不能再包进客户端 prepared-statement 协议，否则 MySQL 返回 1295。
    let is_user_prepared_stmt = has_mysql_user_prepared_stmt_command(sql);
    is_routine_ddl
        || is_call
        || is_user_prepared_stmt
        || has_mysql_user_variable(sql)
        || upper.starts_with("CHECK TABLE")
        || upper.starts_with("ANALYZE TABLE")
        || upper.starts_with("OPTIMIZE TABLE")
        || upper.starts_with("REPAIR TABLE")
        || upper.starts_with("FLUSH")
        || upper.starts_with("USE ")   // USE `db` 在 prepared 协议下报 1295，必须走文本协议
}

fn has_mysql_user_prepared_stmt_command(sql: &str) -> bool {
    sql.split(';').any(|stmt| {
        let upper = strip_leading_comments(stmt).to_uppercase();
        upper.starts_with("PREPARE ")
            || upper.starts_with("EXECUTE ")
            || upper.starts_with("DEALLOCATE PREPARE ")
            || upper.starts_with("DROP PREPARE ")
    })
}

/// Split a MySQL session-state script without splitting semicolons inside
/// strings or comments. This is intentionally limited to scripts containing
/// user variables / PREPARE; routine bodies use the single raw_sql path below.
fn split_mysql_session_script(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut start = 0usize;
    let bytes = sql.as_bytes();
    let mut i = 0usize;
    let mut quote: Option<u8> = None;
    let mut line_comment = false;
    let mut block_comment = false;
    while i < bytes.len() {
        let ch = bytes[i];
        if line_comment {
            if ch == b'\n' { line_comment = false; }
            i += 1;
            continue;
        }
        if block_comment {
            if ch == b'*' && bytes.get(i + 1) == Some(&b'/') {
                block_comment = false;
                i += 2;
            } else { i += 1; }
            continue;
        }
        if let Some(q) = quote {
            if ch == b'\\' { i = (i + 2).min(bytes.len()); continue; }
            if ch == q {
                if bytes.get(i + 1) == Some(&q) { i += 2; continue; }
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == b'-' && bytes.get(i + 1) == Some(&b'-') {
            line_comment = true; i += 2; continue;
        }
        if ch == b'#' { line_comment = true; i += 1; continue; }
        if ch == b'/' && bytes.get(i + 1) == Some(&b'*') {
            block_comment = true; i += 2; continue;
        }
        if matches!(ch, b'\'' | b'"' | b'`') { quote = Some(ch); i += 1; continue; }
        if ch == b';' {
            let part = sql[start..i].trim();
            if !part.is_empty() { statements.push(part.to_string()); }
            start = i + 1;
        }
        i += 1;
    }
    let tail = sql[start..].trim();
    if !tail.is_empty() { statements.push(tail.to_string()); }
    statements
}

fn has_mysql_user_variable(sql: &str) -> bool {
    let mut chars = sql.char_indices().peekable();
    let mut quote: Option<char> = None;
    let mut line_comment = false;
    let mut block_comment = false;
    while let Some((i, ch)) = chars.next() {
        let next = chars.peek().map(|(_, c)| *c);
        if line_comment {
            if ch == '\n' { line_comment = false; }
            continue;
        }
        if block_comment {
            if ch == '*' && next == Some('/') {
                block_comment = false;
                let _ = chars.next();
            }
            continue;
        }
        if let Some(q) = quote {
            if ch == '\\' {
                let _ = chars.next();
                continue;
            }
            if ch == q && next == Some(q) {
                let _ = chars.next();
                continue;
            }
            if ch == q { quote = None; }
            continue;
        }
        if ch == '-' && next == Some('-') {
            line_comment = true;
            let _ = chars.next();
            continue;
        }
        if ch == '#' {
            line_comment = true;
            continue;
        }
        if ch == '/' && next == Some('*') {
            block_comment = true;
            let _ = chars.next();
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            quote = Some(ch);
            continue;
        }
        if ch == '@' {
            let prev = sql[..i].chars().next_back().unwrap_or(' ');
            if prev.is_ascii_alphanumeric() || prev == '_' { continue; }
            let after = &sql[i + ch.len_utf8()..];
            if after.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "requires explicitly disposable DBTERM_TEST_PG_PORT and DBTERM_TEST_PG_DATA_DIR"]
    async fn postgres_ddl_batch_executes_and_rolls_back_as_one_request() {
        use sqlx::Connection;
        let port: u16 = std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
        let expected = std::path::PathBuf::from(std::env::var("DBTERM_TEST_PG_DATA_DIR").unwrap()).canonicalize().unwrap();
        assert!(expected.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("dbterm-isolated-databases-"));
        let options = sqlx::postgres::PgConnectOptions::new().host("127.0.0.1").port(port).username("postgres").database("postgres").ssl_mode(sqlx::postgres::PgSslMode::Disable);
        let mut admin = sqlx::PgConnection::connect_with(&options).await.unwrap();
        let actual: String = sqlx::query_scalar("SHOW data_directory").fetch_one(&mut admin).await.unwrap();
        assert_eq!(std::path::PathBuf::from(actual).canonicalize().unwrap(), expected);
        let schema = format!("ddl_batch_{}", uuid::Uuid::new_v4().simple());
        let mut config = pool_test_config();
        config.id = schema.clone(); config.conn_type = crate::models::ConnType::Postgres;
        config.host = Some("127.0.0.1".into()); config.port = Some(port);
        config.username = Some("postgres".into()); config.database = Some("postgres".into());
        sqlx::raw_sql(&format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.sample(old_name text DEFAULT 'old'); INSERT INTO {schema}.sample VALUES ('existing');")).execute(&mut admin).await.unwrap();
        let batch = format!("ALTER TABLE {schema}.sample ALTER COLUMN old_name TYPE varchar(128); ALTER TABLE {schema}.sample ALTER COLUMN old_name SET NOT NULL; ALTER TABLE {schema}.sample ALTER COLUMN old_name SET DEFAULT 'next'; ALTER TABLE {schema}.sample RENAME COLUMN old_name TO new_name;");
        let success = super::dispatch_query(&config, None, &batch, None).await;
        let column: Option<(String, String, String)> = sqlx::query_as("SELECT column_name::text,data_type::text,is_nullable::text FROM information_schema.columns WHERE table_schema=$1 AND table_name='sample'").bind(&schema).fetch_optional(&mut admin).await.unwrap();
        let failed = super::dispatch_query(&config, None, &format!("ALTER TABLE {schema}.sample ADD COLUMN must_rollback integer; ALTER TABLE {schema}.sample ALTER COLUMN nonexistent SET NOT NULL;"), None).await;
        let leftovers: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND column_name='must_rollback'").bind(&schema).fetch_one(&mut admin).await.unwrap();
        let default_value = if success.is_ok() { Some(sqlx::query_scalar::<_,String>(&format!("INSERT INTO {schema}.sample DEFAULT VALUES RETURNING new_name")).fetch_one(&mut admin).await.unwrap()) } else { None };
        let existing: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.sample")).fetch_one(&mut admin).await.unwrap();
        super::invalidate_pg_pool(&config.id);
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&mut admin).await.unwrap();
        assert!(success.is_ok(), "multi-DDL production dispatch failed: {success:?}");
        assert_eq!(column, Some(("new_name".into(), "character varying".into(), "NO".into())));
        assert!(failed.is_err()); assert_eq!(leftovers, 0, "failed batch left partially committed DDL");
        assert_eq!(default_value.as_deref(), Some("next")); assert_eq!(existing, 2);
    }

    #[tokio::test]
    async fn idle_pool_cache_reaps_mysql_pg_but_preserves_recent_entries_and_clones() {
        let mut config=pool_test_config();
        config.id=format!("idle-native-{}",uuid::Uuid::new_v4().simple());
        let mysql=super::mysql_pool(&config,None).await.unwrap();
        config.conn_type=crate::models::ConnType::Postgres;
        let pg=super::pg_pool(&config,None).await.unwrap();
        let now=std::time::Instant::now();
        super::reap_idle_query_pools(now);
        assert!(super::mysql_pool_reg().lock().unwrap().contains_key(&config.id));
        assert!(super::pg_pool_reg().lock().unwrap().contains_key(&config.id));
        super::mysql_pool_reg().lock().unwrap().get_mut(&config.id).unwrap().last_used=now-std::time::Duration::from_secs(301);
        super::pg_pool_reg().lock().unwrap().get_mut(&config.id).unwrap().last_used=now-std::time::Duration::from_secs(301);
        super::reap_idle_query_pools(now);
        assert!(!super::mysql_pool_reg().lock().unwrap().contains_key(&config.id));
        assert!(!super::pg_pool_reg().lock().unwrap().contains_key(&config.id));
        assert!(!mysql.is_closed()); assert!(!pg.is_closed());
        mysql.close().await; pg.close().await;
    }
    #[tokio::test]
    async fn pool_callback_owner_survives_cache_drop_and_active_checkout() {
        let owner=std::sync::Arc::new(());
        let weak=std::sync::Arc::downgrade(&owner);
        let captured=owner.clone();
        let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
            .after_connect(move |_,_| {
                let _owner=&captured;
                Box::pin(async { Ok(()) })
            }).connect("sqlite::memory:").await.unwrap();
        let returned=pool.clone();
        let mut checkout=returned.acquire().await.unwrap();
        drop(owner); drop(pool);
        assert!(weak.upgrade().is_some(),"returned pool clone must retain closure owner");
        drop(returned);
        assert!(weak.upgrade().is_some(),"checkout must retain pool options owner");
        let value:i64=sqlx::query_scalar("SELECT 11").fetch_one(&mut *checkout).await.unwrap();
        assert_eq!(value,11);
        drop(checkout);
        tokio::time::timeout(std::time::Duration::from_secs(2),async {
            while weak.upgrade().is_some() { tokio::task::yield_now().await; }
        }).await.expect("unused closed pool must release owner");
    }
    #[tokio::test]
    async fn idle_pool_cache_reaps_registry_without_closing_active_sqlite_handles() {
        let temp=std::env::temp_dir().join(format!("dbterm-pool-idle-{}.db",uuid::Uuid::new_v4().simple()));
        std::fs::File::create(&temp).unwrap();
        let mut config=pool_test_config();
        config.id=format!("idle-test-{}",uuid::Uuid::new_v4().simple());
        config.conn_type=crate::models::ConnType::Sqlite;
        config.file_path=Some(temp.to_string_lossy().into_owned());
        let pool=super::sqlite_browse_pool(&config).await.unwrap();
        let mut active=pool.acquire().await.unwrap();
        super::sqlite_pool_reg().lock().unwrap().get_mut(&config.id).unwrap().last_used=
            std::time::Instant::now()-std::time::Duration::from_secs(301);
        super::reap_idle_query_pools(std::time::Instant::now());
        assert!(!super::sqlite_pool_reg().lock().unwrap().contains_key(&config.id));
        assert!(!pool.is_closed(),"eviction must drop cache ownership, never close borrowed pool");
        let value:i64=sqlx::query_scalar("SELECT 7").fetch_one(&mut *active).await.unwrap();
        assert_eq!(value,7);
        drop(active); pool.close().await;
        std::fs::remove_file(temp).unwrap();
    }
    #[test]
    fn selected_query_target_preserves_physical_database_for_schema_engines() {
        use crate::models::ConnType;
        for kind in [ConnType::Postgres, ConnType::KingBase, ConnType::OpenGauss, ConnType::Oracle] {
            let mut config = pool_test_config();
            config.conn_type = kind;
            config.extra_json = Some(serde_json::json!({"pgSearchPath":"saved","initSql":"SELECT 1"}).to_string());
            let schema = super::apply_selected_query_target(&mut config, Some("a\"b; SELECT 1")).unwrap();
            assert_eq!(config.database.as_deref(), Some("db-a"));
            assert_eq!(schema.as_deref(), Some("a\"b; SELECT 1"));
            let extra: serde_json::Value = serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
            assert_eq!(extra["pgSearchPath"], "saved");
            assert_eq!(extra["initSql"], "SELECT 1");
            if config.conn_type != ConnType::Oracle {
                assert_eq!(super::selected_pg_search_path(&config).unwrap().as_deref(), Some("\"a\"\"b; SELECT 1\""));
            }
        }
    }

    #[test]
    fn selected_query_target_routes_database_engines_and_preserves_file_engines() {
        use crate::models::ConnType;
        for kind in [ConnType::Mysql, ConnType::Mariadb, ConnType::Tidb, ConnType::OceanBase, ConnType::ClickHouse, ConnType::SqlServer] {
            let mut config = pool_test_config(); config.conn_type = kind;
            assert_eq!(super::apply_selected_query_target(&mut config, Some("db-b")).unwrap(), None);
            assert_eq!(config.database.as_deref(), Some("db-b"));
        }
        for kind in [ConnType::Sqlite, ConnType::Duckdb] {
            let mut config = pool_test_config(); config.conn_type = kind;
            config.file_path = Some("/tmp/original.db".into());
            let before = serde_json::to_value(&config).unwrap();
            if config.conn_type == ConnType::Sqlite { super::apply_selected_query_target(&mut config, Some("main")).unwrap(); }
            if config.conn_type == ConnType::Sqlite { assert!(super::apply_selected_query_target(&mut config, Some("attached")).is_err()); }
            else { assert_eq!(super::apply_selected_query_target(&mut config, Some("attached")).unwrap().as_deref(), Some("attached")); }
            if config.conn_type == ConnType::Sqlite { assert_eq!(serde_json::to_value(&config).unwrap(), before); }
            else {
                assert_eq!(config.database.as_deref(), Some("db-a"));
                assert_eq!(config.file_path.as_deref(), Some("/tmp/original.db"));
                assert!(config.extra_json.as_deref().unwrap().contains("attached"));
            }
        }
    }

    #[test]
    fn selected_query_target_no_selection_is_unchanged_and_schemas_isolate_pool_identity() {
        let mut config = pool_test_config(); config.conn_type = crate::models::ConnType::Postgres;
        let before = serde_json::to_value(&config).unwrap();
        for selection in [None, Some("")] {
            assert_eq!(super::apply_selected_query_target(&mut config, selection).unwrap(), None);
            assert_eq!(serde_json::to_value(&config).unwrap(), before);
        }
        let mut other = config.clone();
        super::apply_selected_query_target(&mut config, Some("schema-a")).unwrap();
        super::apply_selected_query_target(&mut other, Some("schema-b")).unwrap();
        assert_ne!(super::pool_identity(&config,None,"").unwrap(),super::pool_identity(&other,None,"").unwrap());
        assert!(super::apply_selected_query_target(&mut config, Some("invalid\nowner")).is_err());
        super::apply_selected_query_target(&mut config, None).unwrap();
        assert_eq!(super::selected_pg_search_path(&config).unwrap(), None);
    }
    #[test]
    fn database_switch_sql_preserves_identifier_bytes() {
        assert_eq!(super::mysql_use_database_sql("a`b"), format!("USE {}", super::q_mysql("a`b")));
        assert_ne!(super::mysql_use_database_sql("a`b"), super::mysql_use_database_sql("ab"));
    }
    #[tokio::test]
    #[ignore = "requires isolated MySQL at DBTERM_TEST_MYSQL_PORT"]
    async fn real_mysql_cancelled_query_does_not_reuse_its_interrupted_connection() {
        let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap().parse().unwrap();
        let config: crate::models::ConnConfig = serde_json::from_value(serde_json::json!({
            "id":format!("cancel{}",uuid::Uuid::new_v4().simple()), "name":"isolated cancel", "type":"mysql",
            "host":"127.0.0.1", "port":port, "username":"root", "useSsl":false, "createdAt":0, "updatedAt":0
        })).unwrap();
        let token = format!("cancelLive{}",uuid::Uuid::new_v4().simple());
        let pool = super::mysql_pool(&config,None).await.unwrap();
        // Occupy the other nine slots so the running request and probe use
        // the sole remaining pool session, not a different healthy idle one.
        let mut held = Vec::new();
        for _ in 0..9 { held.push(pool.acquire().await.unwrap()); }
        let mut before = pool.acquire().await.unwrap();
        let old_id:u64=sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *before).await.unwrap();
        drop(before);
        let runner_config=config.clone(); let runner_token=token.clone();
        let task=tokio::spawn(async move { super::mysql_query(&runner_config,None,"SELECT SLEEP(2)",Some(&runner_token)).await });
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                if super::abort_reg().lock().unwrap().contains_key(&token) { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(!super::cancel_abort_for(&token,"another-database"));
        assert!(super::cancel_abort_for(&token,&config.id));
        assert!(tokio::time::timeout(std::time::Duration::from_secs(3),task).await.unwrap().unwrap().is_err());
        let mut after=pool.acquire().await.unwrap();
        let new_id:u64=sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *after).await.unwrap();
        assert_ne!(old_id,new_id,"cancelled query session must not return to pool");
        assert!(!super::cancel_abort_for(&token,&config.id));
        drop(after); drop(held); pool.close().await; super::invalidate_mysql_pool(&config.id);
    }
    #[tokio::test]
    async fn interrupted_query_lease_never_returns_its_session_to_pool() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let mut lease = super::QueryLease::new(pool.acquire().await.unwrap());
        sqlx::query("CREATE TEMP TABLE request_marker(id INTEGER)").execute(&mut *lease).await.unwrap();
        drop(lease);
        let mut next = pool.acquire().await.unwrap();
        assert!(sqlx::query("SELECT * FROM request_marker").fetch_all(&mut *next).await.is_err(), "interrupted session must close rather than reenter the pool");
    }

    #[tokio::test]
    async fn completed_query_lease_preserves_healthy_pool_reuse() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let mut lease = super::QueryLease::new(pool.acquire().await.unwrap());
        sqlx::query("CREATE TEMP TABLE healthy_marker(id INTEGER)").execute(&mut *lease).await.unwrap();
        lease.mark_complete();
        drop(lease);
        let mut next = pool.acquire().await.unwrap();
        assert!(sqlx::query("SELECT * FROM healthy_marker").fetch_all(&mut *next).await.is_ok());
    }
    #[tokio::test]
    async fn cancel_registration_duplicate_must_not_cancel_existing_query() {
        let token = format!("cancelDuplicate{}", uuid::Uuid::new_v4().simple());
        let (_guard, mut original) = super::abort_register_for(&token, "owner").unwrap();
        assert!(super::abort_register_for(&token, "owner").is_err());
        assert!(matches!(original.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)), "registering a duplicate must not close the original query's cancel channel");
    }

    #[tokio::test]
    async fn cancellation_is_owner_scoped_and_token_stays_reserved_until_request_exit() {
        let token = format!("cancelOwner{}", uuid::Uuid::new_v4().simple());
        let (guard, mut receiver) = super::abort_register_for(&token, "databaseA").unwrap();
        assert!(!super::cancel_abort_for(&token, "databaseB"));
        assert!(matches!(receiver.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
        assert!(super::cancel_abort_for(&token, "databaseA"));
        assert!(receiver.await.is_ok());
        assert!(!super::cancel_abort_for(&token, "databaseA"));
        assert!(super::abort_register_for(&token, "databaseA").is_err());
        drop(guard);
        assert!(super::abort_register_for(&token, "databaseA").is_ok());
    }

    #[tokio::test]
    async fn cancellation_guard_unregisters_when_request_future_is_dropped() {
        let token = format!("cancelDrop{}", uuid::Uuid::new_v4().simple());
        let request = async {
            let (_guard, _receiver) = super::abort_register_for(&token, "databaseA").unwrap();
            std::future::pending::<()>().await;
        };
        assert!(tokio::time::timeout(std::time::Duration::from_millis(1), request).await.is_err());
        assert!(!super::cancel_abort_for(&token, "databaseA"));
        assert!(super::abort_register_for(&token, "databaseA").is_ok());
    }

    #[test]
    fn old_cancellation_guard_cannot_remove_a_new_generation() {
        let token = format!("cancelGeneration{}", uuid::Uuid::new_v4().simple());
        let (guard, _receiver) = super::abort_register_for(&token, "databaseA").unwrap();
        let generation = uuid::Uuid::new_v4();
        let (sender, _new_receiver) = tokio::sync::oneshot::channel();
        super::abort_reg().lock().unwrap().insert(token.clone(), super::AbortEntry { owner: "databaseA".into(), generation, sender: Some(sender) });
        drop(guard);
        assert_eq!(super::abort_reg().lock().unwrap().get(&token).unwrap().generation, generation);
        super::abort_reg().lock().unwrap().remove(&token);
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_archive_object_preserves_raw_view_ddl_and_refuses_unsafe_routine() {
        use sqlx::{Connection,Row};
        let url=std::env::var("DBTERM_TEST_MYSQL_URL").unwrap();
        let mut conn=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database=format!("dbterm_archive_{}",uuid::Uuid::new_v4().simple());
        sqlx::Executor::execute(&mut conn,format!("CREATE DATABASE `{database}`").as_str()).await.unwrap();
        let result:Result<(),String>=async {
            sqlx::Executor::execute(&mut conn,"SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'").await.map_err(|e|e.to_string())?;
            let ddl=format!("CREATE VIEW `{database}`.literal_mode AS SELECT 'a\\b' AS value");
            sqlx::Executor::execute(&mut conn,ddl.as_str()).await.map_err(|e|e.to_string())?;
            let row=sqlx::query(&format!("SHOW CREATE VIEW `{database}`.literal_mode")).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;
            let raw:String=row.try_get(1).map_err(|e|e.to_string())?;
            let archived=super::mysql_archive_object_sql(&mut conn,&database,"literal_mode","view").await?;
            if !archived.contains(&raw) || !archived.contains(&hex::encode("NO_BACKSLASH_ESCAPES")) { return Err("raw DDL or source sql_mode changed".into()); }
            if !archived.contains("SET SQL_MODE=@DBTERM_OBJECT_OLD_SQL_MODE") { return Err("session restoration missing".into()); }
            if !super::mysql_archive_object_sql(&mut conn,&database,"unread_routine","procedure").await.unwrap_err().contains("排序规则") { return Err("unsafe routine archive was not refused".into()); }
            Ok(())
        }.await;
        sqlx::Executor::execute(&mut conn,format!("DROP DATABASE `{database}`").as_str()).await.unwrap();
        result.unwrap();
    }
    use super::{
        apply_sqlserver_row_limit,
        has_limit_clause,
        has_mysql_user_variable,
        is_query_stmt,
        needs_text_protocol,
        split_mysql_session_script,
        supports_auto_row_limit,
    };

    #[test]
    fn inline_edit_safety_rejects_nontransactional_views_and_invisible_triggers() {
        assert!(super::validate_mysql_inline_edit(Some("InnoDB"), "BASE TABLE", true, 0).is_ok());
        for engine in [Some("MyISAM"), Some("MEMORY"), None] {
            assert!(super::validate_mysql_inline_edit(engine, "BASE TABLE", true, 0).is_err());
        }
        assert!(super::validate_mysql_inline_edit(Some("InnoDB"), "VIEW", true, 0).is_err());
        assert!(super::validate_mysql_inline_edit(Some("InnoDB"), "BASE TABLE", false, 0).is_err());
        assert!(super::validate_mysql_inline_edit(Some("InnoDB"), "BASE TABLE", true, 1).is_err());
    }

    #[test]
    fn rollback_failure_never_claims_inline_edit_was_rolled_back() {
        let message = super::update_rollback_error("更新失败", Err("connection lost"));
        assert!(message.contains("回滚未确认"));
        assert!(!message.contains("已回滚"));
        assert!(super::update_rollback_error("更新失败", Ok::<(), &str>(())).contains("已回滚"));
    }

    #[tokio::test]
    async fn sqlite_inline_edit_multiple_matches_rolls_back_rows_and_trigger_writes() {
        use sqlx::{Connection, Executor};
        let path = std::env::temp_dir().join(format!("dbterm-inline-{}.sqlite", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        let mut conn = sqlx::SqliteConnection::connect(&url).await.unwrap();
        conn.execute("CREATE TABLE data (id INTEGER, value TEXT); CREATE TABLE audit (value TEXT); CREATE TRIGGER changed AFTER UPDATE ON data BEGIN INSERT INTO audit VALUES (new.value); END; INSERT INTO data VALUES (1,'a'),(1,'b')").await.unwrap();
        let error = super::sqlite_update_cell(&url, "data", "value", Some("changed".into()), &["id".into()], &[Some("1".into())]).await.unwrap_err();
        assert!(error.contains("已回滚"));
        let rows: Vec<String> = sqlx::query_scalar("SELECT value FROM data ORDER BY value").fetch_all(&mut conn).await.unwrap();
        assert_eq!(rows, vec!["a", "b"]);
        let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit").fetch_one(&mut conn).await.unwrap();
        assert_eq!(audit, 0);
        conn.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn sqlite_bulk_edit_later_failure_rolls_back_earlier_primary_key_change() {
        use sqlx::{Connection, Executor};
        let path = std::env::temp_dir().join(format!("dbterm-bulk-edit-{}.sqlite", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        let mut conn = sqlx::SqliteConnection::connect(&url).await.unwrap();
        conn.execute("CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT CHECK(value <> 'bad')); INSERT INTO data VALUES (1,'a'),(2,'b')").await.unwrap();
        let changes = vec![
            super::CellRowUpdate { columns: vec!["id".into(), "value".into()], values: vec![Some("3".into()), Some("changed".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("1".into())], expected_values: Some(vec![Some("1".into()),Some("a".into())]) },
            super::CellRowUpdate { columns: vec!["value".into()], values: vec![Some("bad".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("2".into())], expected_values: Some(vec![Some("b".into())]) },
        ];
        assert!(super::sqlite_update_cells(&url, "data", &changes).await.unwrap_err().contains("已回滚"));
        let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id,value FROM data ORDER BY id").fetch_all(&mut conn).await.unwrap();
        assert_eq!(rows, vec![(1, "a".into()), (2, "b".into())]);
        super::sqlite_update_cells(&url, "data", &changes[..1]).await.unwrap();
        let row: (i64, String) = sqlx::query_as("SELECT id,value FROM data WHERE id=3").fetch_one(&mut conn).await.unwrap();
        assert_eq!(row, (3, "changed".into()));
        conn.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn bulk_edit_pg_placeholders_preserve_nulls_and_primary_key_binding_order() {
        let change = super::CellRowUpdate { columns: vec!["id".into(), "value".into()], values: vec![Some("3".into()), None], pk_columns: vec!["id".into(), "scope".into()], pk_values: vec![Some("1".into()), None], expected_values: None };
        let (sql, _) = super::cell_update_sql("t", &change, false, Some(&["bigint".into(), "text".into()]));
        assert_eq!(sql, "UPDATE t SET \"id\" = CAST($1 AS bigint), \"value\" = NULL WHERE \"id\"::text = $2 AND \"scope\" IS NULL");
    }

    #[tokio::test]
    #[ignore = "requires isolated MySQL at DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_inline_edit_rejects_unsafe_tables_and_rolls_back_warnings() {
        use sqlx::{Connection, Executor};
        let url = std::env::var("DBTERM_TEST_MYSQL_URL").unwrap();
        let mut conn = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let db = format!("dbterm_update_{}", uuid::Uuid::new_v4().simple());
        conn.execute(format!("CREATE DATABASE `{db}`").as_str()).await.unwrap();
        conn.execute(format!("USE `{db}`").as_str()).await.unwrap();
        conn.execute("CREATE TABLE data (id INT, value VARCHAR(8)) ENGINE=InnoDB; INSERT INTO data VALUES (1,'a'),(1,'b'); CREATE TABLE legacy (id INT) ENGINE=MyISAM; CREATE TABLE audit (value VARCHAR(8)) ENGINE=InnoDB").await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(super::mysql_require_atomic_table(&mut tx, "", "data").await.is_ok());
        assert!(super::mysql_require_atomic_table(&mut tx, &db, "legacy").await.unwrap_err().contains("InnoDB"));
        tx.rollback().await.unwrap();
        conn.execute("CREATE TRIGGER changes AFTER UPDATE ON data FOR EACH ROW INSERT INTO audit VALUES (new.value)").await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(super::mysql_require_atomic_table(&mut tx, &db, "data").await.unwrap_err().contains("触发器"));
        tx.rollback().await.unwrap();
        conn.execute("DROP TRIGGER changes").await.unwrap();
        let mut config = pool_test_config();
        let parsed: sqlx::mysql::MySqlConnectOptions = url.parse().unwrap();
        config.host = Some(parsed.get_host().to_string());
        config.port = Some(parsed.get_port());
        config.username = Some(parsed.get_username().to_string());
        config.database = Some(db.clone());
        let password = std::env::var("DBTERM_TEST_MYSQL_PASSWORD").ok();
        let password = password.as_deref();
        let restricted_name = format!("dbt_{}", &uuid::Uuid::new_v4().simple().to_string()[..20]);
        conn.execute(format!("CREATE USER '{restricted_name}'@'%' IDENTIFIED BY 'isolated-test-only'").as_str()).await.unwrap();
        conn.execute(format!("GRANT SELECT, UPDATE ON `{db}`.* TO '{restricted_name}'@'%'").as_str()).await.unwrap();
        let mut restricted = config.clone();
        restricted.username = Some(restricted_name.clone());
        let error = super::mysql_update_cell(&restricted, Some("isolated-test-only"), &db, "data", "value", Some("unsafe".into()), &["id".into()], &[Some("1".into())]).await.unwrap_err();
        assert!(error.contains("TRIGGER 权限"), "{error}");
        conn.execute(format!("DROP USER '{restricted_name}'@'%'").as_str()).await.unwrap();
        let error = super::mysql_update_cell(&config, password, &db, "data", "value", Some("changed".into()), &["id".into()], &[Some("1".into())]).await.unwrap_err();
        assert!(error.contains("实际影响 2 行"), "{error}");
        let unchanged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data WHERE value IN ('a','b')").fetch_one(&mut conn).await.unwrap();
        assert_eq!(unchanged, 2);
        conn.execute("INSERT INTO data VALUES (2,'c')").await.unwrap();
        let error = super::mysql_update_cell(&config, password, &db, "data", "value", Some("too-long-for-column".into()), &["id".into()], &[Some("2".into())]).await.unwrap_err();
        assert!(error.contains("已回滚"), "{error}");
        let unchanged: String = sqlx::query_scalar("SELECT value FROM data WHERE id=2").fetch_one(&mut conn).await.unwrap();
        assert_eq!(unchanged, "c");
        super::mysql_update_cell(&config, password, &db, "data", "value", Some("ok".into()), &["id".into()], &[Some("2".into())]).await.unwrap();
        let updated: String = sqlx::query_scalar("SELECT value FROM data WHERE id=2").fetch_one(&mut conn).await.unwrap();
        assert_eq!(updated, "ok");
        conn.execute("ALTER TABLE data ADD COLUMN amount DECIMAL(3,1) NOT NULL DEFAULT 1.0").await.unwrap();
        let error = super::mysql_update_cell(&config, password, &db, "data", "amount", Some("1.25".into()), &["id".into()], &[Some("2".into())]).await.unwrap_err();
        assert!(error.contains("警告") && error.contains("已回滚"), "{error}");
        let amount: String = sqlx::query_scalar("SELECT CAST(amount AS CHAR) FROM data WHERE id=2").fetch_one(&mut conn).await.unwrap();
        assert_eq!(amount, "1.0");
        let bulk = vec![
            super::CellRowUpdate { columns: vec!["id".into(), "value".into()], values: vec![Some("3".into()), Some("bulk".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("2".into())], expected_values: Some(vec![Some("2".into()),Some("ok".into())]) },
            super::CellRowUpdate { columns: vec!["value".into()], values: vec![Some("missing".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("999".into())], expected_values: Some(vec![None]) },
        ];
        assert!(super::mysql_update_cells(&config, password, &db, "data", &bulk).await.unwrap_err().contains("已回滚"));
        let unchanged: String = sqlx::query_scalar("SELECT value FROM data WHERE id=2").fetch_one(&mut conn).await.unwrap();
        assert_eq!(unchanged, "ok");
        super::mysql_update_cells(&config, password, &db, "data", &bulk[..1]).await.unwrap();
        let changed: String = sqlx::query_scalar("SELECT value FROM data WHERE id=3").fetch_one(&mut conn).await.unwrap();
        assert_eq!(changed, "bulk");
        conn.execute(format!("DROP DATABASE `{db}`").as_str()).await.unwrap();
    }

    fn pool_test_config() -> crate::models::ConnConfig {
        serde_json::from_value(serde_json::json!({
            "id": "identity-test", "name": "test", "type": "mysql",
            "host": "server-a", "port": 3306, "username": "user",
            "database": "db-a", "useSsl": false, "createdAt": 0, "updatedAt": 0
        })).unwrap()
    }

    #[test]
    fn sql_tls_policy_preserves_explicit_disable_and_requires_legacy_ssl() {
        let mut config = pool_test_config();
        config.use_ssl = true;
        assert_eq!(super::resolve_sql_tls_mode(&config, "").unwrap(), "require");
        assert_eq!(super::resolve_sql_tls_mode(&config, "disabled").unwrap(), "disabled");
        assert!(super::resolve_sql_tls_mode(&config, "verify-ful").is_err());
        config.use_ssl = false;
        assert_eq!(super::resolve_sql_tls_mode(&config, "").unwrap(), "disabled");
        for mode in ["require", "verify-ca", "verify-full"] { assert_eq!(super::resolve_sql_tls_mode(&config, mode).unwrap(), mode); }
        config.extra_json = Some("{\"sslMode\":123}".into());
        assert!(super::resolve_sql_tls_mode(&config, "").is_err());
        config.extra_json = Some("{broken".into());
        assert!(super::resolve_sql_tls_mode(&config, "").is_err());
        config.extra_json = Some("{\"sslMode\":\"require\",\"connectTimeout\":\"bad\"}".into());
        assert!(super::resolve_sql_tls_mode(&config, "").is_err());
    }

    #[tokio::test]
    async fn unknown_sql_tls_modes_fail_before_network_and_pool_reuse() {
        let mut config = pool_test_config();
        config.host = Some("127.0.0.1".into()); config.port = Some(1);
        config.extra_json = Some(serde_json::json!({"sslMode":"typo-mode"}).to_string());
        let error = match super::mysql_connect(&config, None).await { Ok(_) => panic!("unexpected connection"), Err(e) => e };
        assert!(error.contains("TLS 模式"), "{error}");
        let error = match super::mysql_pool(&config, None).await { Ok(_) => panic!("unexpected pool"), Err(e) => e };
        assert!(error.contains("TLS 模式"), "{error}");
        config.conn_type = crate::models::ConnType::Postgres;
        let error = match super::pg_connect(&config, None).await { Ok(_) => panic!("unexpected connection"), Err(e) => e };
        assert!(error.contains("TLS 模式"), "{error}");
        let error = match super::pg_pool(&config, None).await { Ok(_) => panic!("unexpected pool"), Err(e) => e };
        assert!(error.contains("TLS 模式"), "{error}");
    }

    #[test]
    fn pool_identity_includes_full_config_and_credentials() {
        let base = pool_test_config();
        let identity = super::pool_identity(&base, Some("first"), "ssh-first").unwrap();
        assert_eq!(identity, super::pool_identity(&base.clone(), Some("first"), "ssh-first").unwrap());
        for field in ["host", "database", "username", "filePath", "extraJson", "readOnly", "useSsl", "port"] {
            let mut value = serde_json::to_value(&base).unwrap();
            value[field] = match field {
                "readOnly" | "useSsl" => serde_json::json!(true),
                "port" => serde_json::json!(3307),
                _ => serde_json::json!("changed"),
            };
            let changed = serde_json::from_value(value).unwrap();
            assert_ne!(identity, super::pool_identity(&changed, Some("first"), "ssh-first").unwrap(), "{field}");
        }
        assert_ne!(identity, super::pool_identity(&base, Some("other"), "ssh-first").unwrap());
        assert_ne!(identity, super::pool_identity(&base, Some("first"), "ssh-other").unwrap());
    }

    #[tokio::test]
    async fn read_only_init_sql_is_rejected_before_any_pool_reuse() {
        let mut config = pool_test_config();
        config.id = format!("readonly-test-{}", uuid::Uuid::new_v4());
        config.read_only = Some(true);
        config.extra_json = Some(serde_json::json!({"initSql": "SET TRANSACTION READ WRITE"}).to_string());
        let identity = super::pool_identity(&config, None, "").unwrap();
        let mysql = sqlx::mysql::MySqlPoolOptions::new().connect_lazy_with(sqlx::mysql::MySqlConnectOptions::new());
        super::mysql_pool_reg().lock().unwrap().insert(config.id.clone(), super::CachedMyPool { pool: mysql.clone(), identity, last_used: std::time::Instant::now(), _tunnel: None });
        assert!(super::mysql_pool(&config, None).await.err().unwrap().contains("初始化"));
        super::invalidate_mysql_pool(&config.id);
        mysql.close().await;
        config.conn_type = crate::models::ConnType::Postgres;
        let identity = super::pool_identity(&config, None, "").unwrap();
        let pg = sqlx::postgres::PgPoolOptions::new().connect_lazy_with(sqlx::postgres::PgConnectOptions::new());
        super::pg_pool_reg().lock().unwrap().insert(config.id.clone(), super::CachedPgPool { pool: pg.clone(), identity, last_used: std::time::Instant::now(), _tunnel: None });
        assert!(super::pg_pool(&config, None).await.err().unwrap().contains("初始化"));
        super::invalidate_pg_pool(&config.id);
        pg.close().await;
        assert!(super::validate_read_only_init_sql(&super::DbConnCfg::default(), true).is_ok());
    }

    #[tokio::test]
    async fn sqlite_pool_never_reuses_different_file_with_same_connection_id() {
        use sqlx::Connection;
        let directory = std::env::temp_dir().join(format!("dbterm-pool-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut config = pool_test_config();
        config.id = format!("sqlite-pool-test-{}", uuid::Uuid::new_v4());
        config.conn_type = crate::models::ConnType::Sqlite;
        let paths = [directory.join("a.db"), directory.join("b.db")];
        for (index, path) in paths.iter().enumerate() {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(true);
            let mut conn = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("CREATE TABLE endpoint(value INTEGER)").execute(&mut conn).await.unwrap();
            sqlx::query("INSERT INTO endpoint VALUES (?)").bind(index as i64).execute(&mut conn).await.unwrap();
            conn.close().await.unwrap();
        }
        config.file_path = Some(paths[0].to_string_lossy().into_owned());
        let old_pool = super::sqlite_browse_pool(&config).await.unwrap();
        let mut changed = config.clone();
        changed.file_path = Some(paths[1].to_string_lossy().into_owned());
        for cfg in [&changed, &config, &changed] {
            let pool = super::sqlite_browse_pool(cfg).await.unwrap();
            let value: i64 = sqlx::query_scalar("SELECT value FROM endpoint").fetch_one(&pool).await.unwrap();
            assert_eq!(value, if cfg.file_path == config.file_path { 0 } else { 1 });
            pool.close().await;
        }
        old_pool.close().await;
        super::invalidate_sqlite_pool(&config.id);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn limit_detection_only_accepts_top_level_unquoted_clause() {
        for sql in ["SELECT 'LIMIT' FROM users", "SELECT * FROM users -- LIMIT 1", "SELECT * FROM users /* LIMIT 1 */", "SELECT * FROM (SELECT * FROM users LIMIT 1) nested", "SELECT \"LIMIT\" FROM users"] {
            assert!(!has_limit_clause(sql), "{sql}");
        }
        assert!(has_limit_clause("SELECT * FROM users LIMIT 100"));
        assert!(has_limit_clause("WITH x AS (SELECT 1 LIMIT 1) SELECT * FROM x LIMIT 2"));
    }

    #[test]
    fn automatic_limits_preserve_writes_and_survive_trailing_comments() {
        use crate::models::ConnType;
        for sql in ["UPDATE users SET id=2", "SHOW PROCESSLIST", "BEGIN"] {
            assert_eq!(super::apply_query_row_limit(sql, Some(200), &ConnType::Mysql), (sql.to_string(), false));
        }
        let (sql, limited) = super::apply_query_row_limit("SELECT * FROM users -- LIMIT 1", Some(200), &ConnType::Mysql);
        assert!(limited);
        assert!(sql.ends_with("\nLIMIT 200"));
        assert!(super::has_limit_clause(&sql));
        let original = "SELECT * FROM users FETCH FIRST 5 ROWS ONLY";
        assert_eq!(super::apply_query_row_limit(original, Some(200), &ConnType::Postgres), (original.to_string(), false));
    }

    #[test]
    fn automatic_limits_do_not_append_after_row_lock_clauses() {
        use crate::models::ConnType;
        for (sql, kind) in [
            ("SELECT * FROM jobs FOR UPDATE", ConnType::Mysql),
            ("SELECT * FROM jobs FOR NO KEY UPDATE", ConnType::Postgres),
            ("SELECT * FROM jobs LOCK IN SHARE MODE", ConnType::Mysql),
            ("SELECT * FROM jobs FOR SHARE", ConnType::Postgres),
        ] {
            assert_eq!(super::apply_query_row_limit(sql, Some(200), &kind), (sql.to_string(), false));
        }
    }

    #[test]
    fn sqlserver_limit_handles_multiline_select() {
        use crate::models::ConnType;
        let (sql, applied) = super::apply_query_row_limit("SELECT\nDISTINCT id FROM t", Some(100), &ConnType::SqlServer);
        assert!(applied);
        assert_eq!(sql, "SELECT\nDISTINCT TOP 100 id FROM t");
        let (sql, applied) = super::apply_query_row_limit("SELECT\tid FROM t", Some(20), &ConnType::SqlServer);
        assert!(applied);
        assert_eq!(sql, "SELECT TOP 20\tid FROM t");
    }

    #[test]
    fn sqlserver_cte_limit_targets_outer_select_and_preserves_sql() {
        use crate::models::ConnType;
        for (original, expected) in [
            ("WITH c AS (SELECT id FROM t) SELECT id FROM c",
             "WITH c AS (SELECT id FROM t) SELECT TOP 25 id FROM c"),
            ("WITH c AS (SELECT id FROM a UNION SELECT id FROM b), d(x) AS (SELECT id FROM c)\nSELECT\nDISTINCT x FROM d;  ",
             "WITH c AS (SELECT id FROM a UNION SELECT id FROM b), d(x) AS (SELECT id FROM c)\nSELECT\nDISTINCT TOP 25 x FROM d;  "),
            ("/* 查询 */ WITH [select] AS (SELECT 'UNION' AS x) SELECT ALL x FROM [select]",
             "/* 查询 */ WITH [select] AS (SELECT 'UNION' AS x) SELECT ALL TOP 25 x FROM [select]"),
            ("WITH c AS (SELECT id FROM t) -- 注释\nSELECT id FROM c",
             "WITH c AS (SELECT id FROM t) -- 注释\nSELECT TOP 25 id FROM c"),
        ] {
            assert_eq!(super::apply_query_row_limit(original, Some(25), &ConnType::SqlServer),
                (expected.to_string(), true), "{original}");
        }
    }

    #[test]
    fn sqlserver_limit_leaves_set_operations_and_cte_writes_unchanged() {
        use crate::models::ConnType;
        for sql in [
            "WITH c AS (SELECT id FROM t) SELECT id FROM c UNION SELECT id FROM u",
            "SELECT id FROM t UNION ALL SELECT id FROM u",
            "WITH c AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM c)",
            "WITH c AS (SELECT id FROM t) INSERT INTO archive SELECT id FROM c",
            "WITH c AS (SELECT id FROM t) SELECT id INTO archive FROM c",
            "WITH c AS (SELECT id FROM t) SELECT TOP 5 id FROM c",
            "WITH c AS (SELECT id FROM t) SELECT id FROM c; SELECT id FROM t",
        ] {
            assert_eq!(super::apply_query_row_limit(sql, Some(25), &ConnType::SqlServer),
                (sql.to_string(), false), "{sql}");
        }
    }

    #[test]
    fn rownum_identifier_only_suppresses_oracle_limit() {
        use crate::models::ConnType;
        assert!(super::apply_query_row_limit("SELECT rownum FROM t", Some(200), &ConnType::Postgres).1);
        assert!(!super::apply_query_row_limit("SELECT rownum FROM t", Some(200), &ConnType::Oracle).1);
        assert!(!super::is_read_only_safe_stmt("WITH x AS (SELECT 1) DELETE FROM t", &ConnType::Oracle));
    }

    #[test]
    fn read_only_guard_rejects_dml_hidden_behind_cte_or_explain() {
        use crate::models::ConnType;
        let sql = "WITH victim AS (SELECT id FROM dbo.t) DELETE FROM dbo.t WHERE id IN (SELECT id FROM victim)";
        assert!(super::is_query_stmt(sql));
        for kind in [ConnType::SqlServer, ConnType::ClickHouse, ConnType::Duckdb] {
            assert!(!super::is_read_only_safe_stmt(sql, &kind));
            assert!(super::is_read_only_safe_stmt("SELECT id FROM dbo.t", &kind));
        }
        assert!(!super::is_read_only_safe_stmt("DELETE FROM t", &ConnType::Postgres));
    }

    #[tokio::test]
    async fn bounded_sqlite_results_reject_overflow_without_committing_transaction() {
        use sqlx::{Connection, Executor};
        let mut conn = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        conn.execute("CREATE TABLE pending (id INTEGER); BEGIN; INSERT INTO pending VALUES (7)").await.unwrap();
        let sql = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100001) SELECT x FROM n";
        let error = super::collect_query_rows(sqlx::query(sql).fetch(&mut conn), super::sqlite_cell).await.unwrap_err();
        assert!(error.contains("未返回部分结果"));
        conn.execute("ROLLBACK").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pending").fetch_one(&mut conn).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn empty_sqlite_result_preserves_column_names() {
        use sqlx::Connection;
        let conn = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        let result = super::sqlite_query_conn(conn, "SELECT 1 AS value WHERE 0", None, "test").await.unwrap();
        assert_eq!(result.columns, vec!["value"]);
        assert!(result.rows.is_empty());
        assert!(result.is_select);
    }

    #[test]
    fn mysql_session_script_split_keeps_quoted_semicolons() {
        let sql = "SET @x := 'a;b'; PREPARE s FROM @x; EXECUTE s; DEALLOCATE PREPARE s;";
        assert_eq!(split_mysql_session_script(sql), vec![
            "SET @x := 'a;b'",
            "PREPARE s FROM @x",
            "EXECUTE s",
            "DEALLOCATE PREPARE s",
        ]);
    }

    #[test]
    fn mysql_session_script_split_ignores_comment_semicolons() {
        let sql = "SET @x := 1 /* ; */; -- ;\n EXECUTE s;";
        assert_eq!(split_mysql_session_script(sql), vec![
            "SET @x := 1 /* ; */",
            "-- ;\n EXECUTE s",
        ]);
    }

    #[test]
    fn mysql_user_prepared_statement_commands_use_text_protocol() {
        assert!(needs_text_protocol(r#"PREPARE stmt FROM "SELECT 1 LIMIT 1""#));
        assert!(needs_text_protocol("EXECUTE stmt"));
        assert!(needs_text_protocol("DEALLOCATE PREPARE stmt"));
        assert!(needs_text_protocol("DROP PREPARE stmt"));
        assert!(needs_text_protocol("/* app comment */ PREPARE stmt FROM 'SELECT 1'"));
        assert!(needs_text_protocol("SET @sql = 'SELECT 1'; PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt"));
    }

    #[test]
    fn mysql_user_variables_ignore_strings_and_comments() {
        assert!(has_mysql_user_variable("SET @x := 1"));
        assert!(has_mysql_user_variable("SELECT @x"));
        assert!(!has_mysql_user_variable("SELECT 'a@b'"));
        assert!(!has_mysql_user_variable("-- @x\nSELECT 1"));
    }

    #[test]
    fn management_queries_are_query_results_but_not_auto_limited() {
        for sql in [
            "SHOW PROCESSLIST",
            "SHOW FULL PROCESSLIST",
            "DESC users",
            "DESCRIBE users",
            "EXPLAIN SELECT * FROM users",
            "PRAGMA table_info(users)",
        ] {
            assert!(is_query_stmt(sql), "{sql}");
            assert!(!supports_auto_row_limit(sql), "{sql}");
        }
    }

    #[test]
    fn select_queries_support_auto_row_limit_after_comments() {
        assert!(supports_auto_row_limit("SELECT * FROM users"));
        assert!(supports_auto_row_limit("/* app comment */ SELECT * FROM users"));
        assert!(supports_auto_row_limit("-- comment\nWITH x AS (SELECT 1) SELECT * FROM x"));
    }

    #[test]
    fn sqlserver_top_is_not_added_to_management_queries() {
        assert_eq!(apply_sqlserver_row_limit("SHOW PROCESSLIST", Some(200)), ("SHOW PROCESSLIST".to_string(), false));
        assert_eq!(apply_sqlserver_row_limit("EXPLAIN SELECT * FROM users", Some(200)), ("EXPLAIN SELECT * FROM users".to_string(), false));
        assert_eq!(apply_sqlserver_row_limit("SELECT * FROM users", Some(200)), ("SELECT TOP 200 * FROM users".to_string(), true));
    }

    #[test]
    fn test_tag_sql_basic() {
        use super::tag_sql;
        assert_eq!(tag_sql("SELECT 1"), "/* DBTerm */ SELECT 1");
        assert_eq!(tag_sql("UPDATE t SET a=1"), "/* DBTerm */ UPDATE t SET a=1");
        assert_eq!(tag_sql(""), "/* DBTerm */ ");
    }

    #[test]
    fn test_db_conn_cfg_default() {
        use super::DbConnCfg;
        let cfg = DbConnCfg::default();
        assert_eq!(cfg.connect_timeout, 0);
        assert_eq!(cfg.encoding, "");
        assert_eq!(cfg.ssl_mode, "");
        assert!(!cfg.ssh_tunnel);
        // sqlite_foreign_keys使用default_true，但Default::default()会得到false
        assert!(!cfg.sqlite_foreign_keys);
    }

    #[tokio::test]
    async fn malformed_db_options_never_fall_back_to_direct_or_writable(){
        use super::{ConnConfig,mysql_connect,pg_connect,sqlite_url};
        let make=|kind:&str,extra:serde_json::Value|serde_json::from_value::<ConnConfig>(serde_json::json!({"id":"malformed-fixture","name":"test","type":kind,"host":"127.0.0.1","port":1,"filePath":"/tmp/dbterm-never-open.sqlite","extraJson":extra.to_string(),"useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        let mysql=make("mysql",serde_json::json!({"sshTunnel":true,"sshPort":"invalid"}));
        let error=mysql_connect(&mysql,None).await.err().expect("malformed MySQL config must reject");assert_eq!(error,"数据库连接配置格式错误，已拒绝连接；请检查连接设置");
        let pg=make("postgres",serde_json::json!({"sshTunnel":true,"encoding":42}));
        let error=pg_connect(&pg,None).await.err().expect("malformed PG config must reject");assert_eq!(error,"数据库连接配置格式错误，已拒绝连接；请检查连接设置");
        let sqlite=make("sqlite",serde_json::json!({"sqliteReadonly":true,"encoding":42}));
        assert!(sqlite_url(&sqlite).is_err(),"malformed config must not remove SQLite readonly");
    }

    #[test]
    fn query_tunnel_credential_lookup_is_fail_closed_and_auth_aware(){
        use super::DbConnCfg;
        let cfg=DbConnCfg{ssh_auth_type:"password".into(),..Default::default()};
        assert!(cfg.tunnel_password_with("fixture",|_|Err("fixture unavailable".into())).is_err());
        for auth in ["agent","none"]{let cfg=DbConnCfg{ssh_auth_type:auth.into(),..Default::default()};assert!(cfg.tunnel_password_with("fixture",|_|panic!("unused credential lookup")).unwrap().is_empty());}
        for auth in ["password","key","mfa"]{let cfg=DbConnCfg{ssh_auth_type:auth.into(),..Default::default()};let password=cfg.tunnel_password_with("fixture",|key|{assert_eq!(key,"fixture::ssh-tunnel");Ok(Some("fixture-saved".into()))}).unwrap();assert!(password=="fixture-saved");}
        let cfg=DbConnCfg{ssh_auth_type:"key".into(),..Default::default()};assert!(cfg.tunnel_password_with("fixture",|_|Ok(None)).unwrap().is_empty());
    }
    #[test]
    fn query_config_rejects_nonobjects_and_preserves_valid_options(){
        let mut config:super::ConnConfig=serde_json::from_value(serde_json::json!({"id":"parse-fixture","name":"test","type":"sqlite","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        for raw in ["{","[]","null","42","{\"sqliteReadonly\":\"yes\"}"]{config.extra_json=Some(raw.into());assert!(super::DbConnCfg::from_config(&config).is_err());}
        for raw in [None,Some(""),Some("  "),Some("{}")]{config.extra_json=raw.map(str::to_string);assert!(super::DbConnCfg::from_config(&config).is_ok());}
        config.extra_json=Some("{\"sshTunnel\":true,\"sshPort\":22,\"sqliteReadonly\":true}".into());let cfg=super::DbConnCfg::from_config(&config).unwrap();assert!(cfg.ssh_tunnel);assert_eq!(cfg.ssh_port,22);assert!(cfg.sqlite_readonly);
    }
    #[tokio::test]
    async fn malformed_pg_options_reject_before_direct_connection(){
        let config:super::ConnConfig=serde_json::from_value(serde_json::json!({"id":"pg-malformed-fixture","name":"test","type":"postgres","host":"127.0.0.1","port":1,"extraJson":"{\"sshTunnel\":true,\"encoding\":42}","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        let error=super::pg_connect(&config,None).await.err().unwrap();assert_eq!(error,"数据库连接配置格式错误，已拒绝连接；请检查连接设置");
    }
    #[test]
    fn malformed_sqlite_options_cannot_discard_readonly(){
        let config:super::ConnConfig=serde_json::from_value(serde_json::json!({"id":"sqlite-malformed-fixture","name":"test","type":"sqlite","filePath":"/tmp/dbterm-never-open.sqlite","extraJson":"{\"sqliteReadonly\":true,\"encoding\":42}","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        assert!(super::sqlite_url(&config).is_err(),"invalid option must not silently discard requested readonly");
    }

    #[test]
    fn test_db_conn_cfg_timeout_clamping() {
        use super::DbConnCfg;
        use std::time::Duration;

        let cfg1 = DbConnCfg { connect_timeout: 0, ..Default::default() };
        assert_eq!(cfg1.timeout(), Duration::from_secs(30)); // 默认30秒

        let cfg2 = DbConnCfg { connect_timeout: 1, ..Default::default() };
        assert_eq!(cfg2.timeout(), Duration::from_secs(3)); // 最小3秒

        let cfg3 = DbConnCfg { connect_timeout: 60, ..Default::default() };
        assert_eq!(cfg3.timeout(), Duration::from_secs(60)); // 正常值

        let cfg4 = DbConnCfg { connect_timeout: 500, ..Default::default() };
        assert_eq!(cfg4.timeout(), Duration::from_secs(300)); // 最大300秒
    }

    #[test]
    fn test_db_conn_cfg_tunnel_password() {
        use super::DbConnCfg;

        let cfg1 = DbConnCfg {
            ssh_password: "explicit-pass".to_string(),
            ..Default::default()
        };
        assert_eq!(cfg1.tunnel_password_with("test-conn",|_|panic!("legacy must bypass lookup")).unwrap(), "explicit-pass");

        // 空密码时应该尝试从keychain读取（这里会返回空，因为没有设置）
        let cfg2 = DbConnCfg::default();
        assert_eq!(cfg2.tunnel_password_with("fixture",|_|Ok(None)).unwrap(), "");
    }

    #[test]
    fn test_mysql_pwd_ext_empty_password() {
        use sqlx::mysql::MySqlConnectOptions;
        use super::MySqlPwdExt;

        // 空密码不应该调用password方法
        let opts = MySqlConnectOptions::new()
            .host("localhost")
            .username("root")
            .password_opt("");

        // 这里只是验证可以构造，实际密码处理在连接时
        assert_eq!(format!("{:?}", opts).contains("password"), true);
    }

    #[test]
    fn test_mysql_pwd_ext_non_empty_password() {
        use sqlx::mysql::MySqlConnectOptions;
        use super::MySqlPwdExt;

        let opts = MySqlConnectOptions::new()
            .host("localhost")
            .username("root")
            .password_opt("test123");

        assert_eq!(format!("{:?}", opts).contains("password"), true);
    }

    #[test]
    fn test_invalidate_mysql_pool() {
        use super::invalidate_mysql_pool;
        // 测试invalidate函数不会panic
        invalidate_mysql_pool("test-conn-id");
        // 多次调用应该安全
        invalidate_mysql_pool("test-conn-id");
        invalidate_mysql_pool("another-id");
    }

    #[test]
    fn test_invalidate_pg_pool() {
        use super::invalidate_pg_pool;
        invalidate_pg_pool("test-pg-id");
        invalidate_pg_pool("test-pg-id");
    }

    #[test]
    fn test_invalidate_sqlite_pool() {
        use super::invalidate_sqlite_pool;
        invalidate_sqlite_pool("test-sqlite-id");
        invalidate_sqlite_pool("test-sqlite-id");
    }

    #[test]
    fn test_validate_cancel_token_valid() {
        use super::validate_cancel_token;
        assert!(validate_cancel_token(Some("validtoken123")).is_ok());
        assert!(validate_cancel_token(Some("a")).is_ok()); // 单字符也可以
        assert!(validate_cancel_token(Some("ABC123def")).is_ok());
        assert!(validate_cancel_token(None).is_ok()); // None也是有效的
    }

    #[test]
    fn test_validate_cancel_token_invalid() {
        use super::validate_cancel_token;
        assert!(validate_cancel_token(Some("")).is_err());
        assert!(validate_cancel_token(Some("token-with-dash")).is_err()); // 只允许字母数字
        assert!(validate_cancel_token(Some("token.dot")).is_err());
        assert!(validate_cancel_token(Some("token with space")).is_err());
        assert!(validate_cancel_token(Some("token\nwith\nnewline")).is_err());
    }
}

/// Admin commands like CHECK/ANALYZE/OPTIMIZE TABLE require text protocol.
/// Returns BoxFuture<'static, ...> so its Send-ness is trivially known to the
/// compiler without HRTB analysis — preventing HRTB errors in callers.
fn mysql_admin_query(
    mut conn: sqlx::mysql::MySqlConnection,
    _tunnel: Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>,
    tagged_sql: String,
    database: Option<String>,
    cancel_token: Option<String>,
    owner_id: String,
    start: Instant,
) -> futures::future::BoxFuture<'static, Result<QueryResult, String>> {
    Box::pin(async move {
        use sqlx::{Column, Executor, Row};
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            (&mut conn)
                .execute(sqlx::raw_sql(&mysql_use_database_sql(db)))
                .await
                .map_err(|e| format!("切换数据库失败: {e}"))?;
        }
        let registration = cancel_token.as_ref().map(|t| abort_register_for(t, &owner_id)).transpose()?;
        let (_abort_guard, abort_rx) = registration.map_or((None, None), |(guard, rx)| (Some(guard), Some(rx)));
        let run = async {
            // User variables and server-side prepared statements are connection
            // scoped. Execute each statement sequentially on this detached
            // connection so a pool checkout can never lose the session state.
            let script_head = strip_leading_comments(&tagged_sql).trim_start().to_uppercase();
            let routine_statement = (script_head.starts_with("CREATE ")
                || script_head.starts_with("DROP ")
                || script_head.starts_with("ALTER "))
                && (script_head.contains(" FUNCTION")
                    || script_head.contains(" PROCEDURE")
                    || script_head.contains(" TRIGGER")
                    || script_head.contains(" EVENT"));
            let session_script = !routine_statement
                && (has_mysql_user_variable(&tagged_sql)
                    || has_mysql_user_prepared_stmt_command(&tagged_sql));
            let statements = if session_script {
                split_mysql_session_script(&tagged_sql)
            } else {
                vec![tagged_sql.clone()]
            };
            let mut columns = Vec::new();
            let mut data = Vec::new();
            let mut affected = 0u64;
            let mut saw_result = false;
            let mut budget = super::query_result_budget::ResultBudget::default();
            for statement in statements {
                let head = strip_leading_comments(&statement).trim_start().to_uppercase();
                let returns_rows = is_query_stmt(&statement)
                    || head.starts_with("EXECUTE ")
                    || head.starts_with("CALL ");
                if returns_rows {
                    let mut stream = (&mut conn).fetch(sqlx::raw_sql(&statement));
                    use futures::TryStreamExt;
                    while let Some(row) = stream.try_next().await.map_err(|e| format!("执行失败: {e}"))? {
                        if columns.is_empty() { columns = row.columns().iter().map(|c| c.name().to_string()).collect(); }
                        budget.start_row()?;
                        let mut decoded = Vec::new();
                        for i in 0..row.columns().len() {
                            let cell = mysql_cell(&row, i);
                            budget.cell(cell.as_deref())?;
                            decoded.push(cell);
                        }
                        data.push(decoded);
                        saw_result = true;
                    }
                    drop(stream);
                    if columns.is_empty() {
                        columns = (&mut conn).describe(&statement).await
                            .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                            .unwrap_or_default();
                    }
                    saw_result |= !columns.is_empty();
                } else {
                    let result = (&mut conn)
                        .execute(sqlx::raw_sql(&statement))
                        .await
                        .map_err(|e| format!("执行失败: {e}"))?;
                    affected = affected.saturating_add(result.rows_affected());
                }
            }
            let row_count = data.len() as u64;
            Ok(QueryResult {
                columns, rows: data,
                rows_affected: if saw_result { row_count } else { affected },
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: saw_result,
            })
        };
        let result = if let Some(rx) = abort_rx {
            tokio::pin!(run);
            tokio::select! {
                r = &mut run => r,
                _ = rx => Err("已停止等待执行；写入是否生效尚未确认，请核查数据库，勿自动重试".to_string()),
            }
        } else {
            run.await
        };
        result
    })
}

async fn mysql_query(config: &ConnConfig, password: Option<&str>, sql: &str, cancel_token: Option<&str>) -> Result<QueryResult, String> {
    use sqlx::Column;
    let tagged = tag_sql(sql);
    // 复用池连接：跳过每次重建 TCP+SSH 握手，首次执行后速度显著提升。
    let pool = mysql_pool(config, password).await?;

    // Commands like CHECK/ANALYZE/OPTIMIZE/REPAIR TABLE don't work with prepared
    // statements (MySQL error 1295). Use raw_sql (text protocol) for them.
    if needs_text_protocol(sql) {
        let conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?.detach();
        let start = Instant::now();
        return mysql_admin_query(conn, None, tagged, config.database.clone(), cancel_token.map(str::to_string), config.id.clone(), start).await;
    }

    let mut conn = QueryLease::new(pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?);
    // 池连接按 config.id 缓存，但用户可能切换了 schema，每次确保 USE 到正确数据库。
    // USE 属于 DDL-like 命令，必须走文本协议（raw_sql），不能用 prepared statement（MySQL 1295）。
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        use sqlx::Executor;
        (&mut *conn).execute(sqlx::raw_sql(&mysql_use_database_sql(db)))
            .await.map_err(|e| format!("切换数据库失败: {e}"))?;
    }
    // 池连接已就绪，计时从这里开始（不含握手）
    let start = Instant::now();

    // 取消：登记请求专属中止通道；QueryLease 在未完整成功时丢弃会话。
    // 服务端实际中止与写入结果仍取决于断连处理，不能据此确认回滚。
    // 取消只作用于该请求；错误路径明确关闭连接，不回池，也不按可变配置跨节点 KILL。
    let token = cancel_token.map(str::to_string);
    let registration = token.as_ref().map(|t| abort_register_for(t, &config.id)).transpose()?;
    let (_abort_guard, abort_rx) = registration.map_or((None, None), |(guard, rx)| (Some(guard), Some(rx)));
    let run = async {
        if is_query_stmt(sql) {
            let (mut columns, data) = collect_query_rows(
                sqlx::query(&tagged).fetch(&mut *conn), mysql_cell,
            ).await?;
            if columns.is_empty() {
                use sqlx::Executor;
                columns = (&mut *conn).describe(&tagged).await
                    .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default();
            }
            Ok(QueryResult { columns, rows: data, rows_affected: 0,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: true })
        } else {
            sqlx::query(&tagged).execute(&mut *conn).await
                .map(|res| QueryResult { columns: vec![], rows: vec![],
                    rows_affected: res.rows_affected(),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    truncated: false, is_select: false })
                .map_err(|e| format!("执行失败: {e}"))
        }
    };

    let result = if let Some(rx) = abort_rx {
        tokio::pin!(run);
        tokio::select! {
            r = &mut run => r,
            // 取消后 QueryLease 未标记成功，显式 close_on_drop，禁止会话回池。
            _ = rx => Err("已停止等待执行；写入是否生效尚未确认，请核查数据库，勿自动重试".to_string()),
        }
    } else {
        run.await
    };

    if result.is_ok() { conn.mark_complete(); }
    result
}

pub(crate) fn mysql_cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    use sqlx::Row;
    if matches!(row.try_get::<Option<String>, _>(i), Ok(None)) { return None; }
    // 注意：MySQL 没有原生 bool（即 TINYINT(1)），不能先探测 bool，
    // 否则任意非零整数都会被 sqlx 解码成 true/false，污染所有整数列。
    None
        .or_else(|| row.try_get::<i8,  _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i16, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i32, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<u8,  _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<u16, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<u32, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<u64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f32, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::NaiveDate, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::NaiveDateTime, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::NaiveTime, _>(i).ok().map(|v| v.to_string()))
        // MySQL TIME 全范围（>24h / 负数）NaiveTime 解不出，用 MySqlTime 兜底，否则显示成 (bin)
        .or_else(|| row.try_get::<sqlx::mysql::types::MySqlTime, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<String, _>(i).ok())
        // 二进制字符集列（如 information_schema）/ binary 字符串：按 UTF-8 兜底解码
        .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().and_then(|b| String::from_utf8(b).ok()))
        // DECIMAL/NEWDECIMAL 等以 ASCII 文本编码，但不被 String/Vec<u8> 的兼容检查接受；
        // try_get_unchecked 跳过兼容检查直接 decode（NULL → Err → 落到下面的 (bin)，但 NULL 早已在最前排除）
        .or_else(|| row.try_get_unchecked::<String, _>(i).ok())
        .or_else(|| row.try_get_unchecked::<Vec<u8>, _>(i).ok().and_then(|b| String::from_utf8(b).ok()))
        // 真二进制（非 UTF-8）：hex 展示而非丢成 "(bin)"，避免看不到内容/复制丢数据
        .or_else(|| row.try_get_unchecked::<Vec<u8>, _>(i).ok().map(|b| format!("0x{}", hex::encode(b))))
        .or(Some("(bin)".to_string()))
}

/// 按列索引提取字符串，兼容 VARCHAR / binary-charset / BLOB 返回
fn mysql_str_col(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    use sqlx::Row;
    row.try_get::<String, _>(i).ok()
        .or_else(|| row.try_get::<Vec<u8>, _>(i).ok()
            .and_then(|b| String::from_utf8(b).ok()))
}

/// 第 0 列（SHOW DATABASES 用 "Database" 列名兜底）
fn mysql_str0(row: &sqlx::mysql::MySqlRow) -> Option<String> {
    use sqlx::Row;
    row.try_get::<String, _>("Database").ok()
        .or_else(|| mysql_str_col(row, 0))
}

async fn mysql_schemas(config: &ConnConfig, password: Option<&str>) -> Result<Vec<String>, String> {
    // 浏览路径走连接池（复用连接，降低连接数）；取一条连接，函数内多条 SELECT 共用同一连接
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let mut diag: Vec<String> = Vec::new();

    // 1. SHOW DATABASES
    match sqlx::query("SHOW DATABASES").fetch_all(&mut *conn).await {
        Ok(rows) => {
            let names: Vec<String> = rows.iter().filter_map(mysql_str0).collect();
            if !names.is_empty() { return Ok(names); }
            diag.push(format!("SHOW DATABASES: 返回 {} 行但解析为空（列类型可能异常）", rows.len()));
        }
        Err(e) => diag.push(format!("SHOW DATABASES 失败: {e}")),
    }

    // 2. information_schema.schemata
    match sqlx::query(
        "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    ).fetch_all(&mut *conn).await {
        Ok(rows) => {
            let names: Vec<String> = rows.iter().filter_map(mysql_str0).collect();
            if !names.is_empty() { return Ok(names); }
            diag.push(format!("information_schema.schemata: {} 行解析为空", rows.len()));
        }
        Err(e) => diag.push(format!("information_schema.schemata 失败: {e}")),
    }

    // 3. information_schema.tables
    match sqlx::query(
        "SELECT DISTINCT table_schema FROM information_schema.tables ORDER BY table_schema",
    ).fetch_all(&mut *conn).await {
        Ok(rows) => {
            let names: Vec<String> = rows.iter().filter_map(mysql_str0).collect();
            if !names.is_empty() { return Ok(names); }
            diag.push(format!("information_schema.tables: {} 行解析为空", rows.len()));
        }
        Err(e) => diag.push(format!("information_schema.tables 失败: {e}")),
    }

    // 4. SELECT DATABASE()
    match sqlx::query("SELECT DATABASE()").fetch_one(&mut *conn).await {
        Ok(row) => {
            use sqlx::Row;
            match row.try_get::<Option<String>, _>(0) {
                Ok(Some(db)) if !db.is_empty() => return Ok(vec![db]),
                Ok(v) => diag.push(format!("SELECT DATABASE(): {:?}", v)),
                Err(e) => diag.push(format!("SELECT DATABASE() 解析失败: {e}")),
            }
        }
        Err(e) => diag.push(format!("SELECT DATABASE() 执行失败: {e}")),
    }

    // 5. 连接配置 database 字段兜底
    if let Some(db) = config.database.as_deref() {
        if !db.is_empty() { return Ok(vec![db.to_string()]); }
    }

    Err(format!(
        "无法获取数据库列表，诊断：\n{}",
        diag.join("\n")
    ))
}

async fn mysql_tables(config: &ConnConfig, password: Option<&str>, schema: &str) -> Result<Vec<TableInfo>, String> {
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let sql = format!("SHOW FULL TABLES FROM `{}`", schema.replace('`', "``"));
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await
        .map_err(|e| format!("获取表列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| {
        let name = mysql_str_col(r, 0)?;
        let kind = mysql_str_col(r, 1).unwrap_or_default();
        Some(TableInfo { name, is_view: kind == "VIEW" })
    }).collect())
}

// ── Postgres ──────────────────────────────────────────────────────────────────

async fn pg_query(config: &ConnConfig, password: Option<&str>, sql: &str, cancel_token: Option<&str>) -> Result<QueryResult, String> {
    use sqlx::Column;
    let tagged = tag_sql(sql);
    // 复用池连接：跳过每次重建 TCP+SSH 握手
    let pool = pg_pool(config, password).await?;
    let mut conn = QueryLease::new(pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?);
    let start = Instant::now();

    // 取消：登记请求专属中止通道；错误连接关闭，不重新按配置终止服务端 PID。
    let token = cancel_token.map(str::to_string);
    let registration = token.as_ref().map(|t| abort_register_for(t, &config.id)).transpose()?;
    let (_abort_guard, abort_rx) = registration.map_or((None, None), |(guard, rx)| (Some(guard), Some(rx)));
    let pg_cancel=conn.cancel_token();
    let run = async {
        if let Some(path) = selected_pg_search_path(config)? {
            // 在连接初始化之后、本次原始 SQL 之前设置；值参数绑定，名称整体双引号引用。
            sqlx::query("SELECT set_config('search_path', $1, false)").bind(path)
                .execute(&mut *conn).await.map_err(|e| format!("选择查询 schema 失败: {e}"))?;
        }
        if is_query_stmt(sql) {
            let (mut columns, data) = collect_query_rows(
                sqlx::query(&tagged).fetch(&mut *conn), pg_cell,
            ).await?;
            if columns.is_empty() {
                use sqlx::Executor;
                columns = (&mut *conn).describe(&tagged).await
                    .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default();
            }
            Ok(QueryResult { columns, rows: data, rows_affected: 0,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: true })
        } else {
            // 原文批量协议支持向导生成的多条 DDL；不拆分执行，避免逐条提交。
            sqlx::Executor::execute(&mut *conn, tagged.as_str()).await
                .map(|res| QueryResult { columns: vec![], rows: vec![],
                    rows_affected: res.rows_affected(),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    truncated: false, is_select: false })
                .map_err(|e| format!("执行失败: {e}"))
        }
    };

    let result = if let Some(rx) = abort_rx {
        super::pg_cancel::run(run,rx,pg_cancel).await.0
    } else {
        run.await
    };

    if result.is_ok() { conn.mark_complete(); }
    result
}

pub(crate) fn pg_cell(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
    use sqlx::Row;
    if matches!(row.try_get::<Option<String>, _>(i), Ok(None)) { return None; }
    None
        .or_else(|| row.try_get::<bool, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i16, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i32, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f32, _>(i).ok().map(super::db_extra::fmt_f32))
        .or_else(|| row.try_get::<f64, _>(i).ok().map(super::db_extra::fmt_f64))
        .or_else(|| row.try_get::<chrono::NaiveDate, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::NaiveDateTime, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::NaiveTime, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<chrono::DateTime<chrono::Utc>, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<String, _>(i).ok())
        // bytea 等二进制：hex 展示而非丢成 "(bin)"
        .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().map(|b| format!("0x{}", hex::encode(b))))
        .or(Some("(bin)".to_string()))
}

async fn pg_schemas(config: &ConnConfig, password: Option<&str>) -> Result<Vec<String>, String> {
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' \
           AND schema_name != 'information_schema' \
         ORDER BY schema_name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("获取 schema 列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
}

async fn pg_tables(config: &ConnConfig, password: Option<&str>, schema: &str) -> Result<Vec<TableInfo>, String> {
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT table_name, table_type \
         FROM information_schema.tables \
         WHERE table_schema = $1 \
         ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("获取表列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| {
        let name = r.try_get::<String, _>(0).ok()?;
        let kind = r.try_get::<String, _>(1).unwrap_or_default();
        Some(TableInfo { name, is_view: kind == "VIEW" })
    }).collect())
}

// ── SQLite ────────────────────────────────────────────────────────────────────

async fn sqlite_query_conn(mut conn: sqlx::sqlite::SqliteConnection, sql: &str, cancel_token: Option<&str>, owner_id: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let token = cancel_token.map(str::to_string);
    let registration = token.as_ref().map(|t| abort_register_for(t, owner_id)).transpose()?;
    let (_abort_guard, abort_rx) = registration.map_or((None, None), |(guard, rx)| (Some(guard), Some(rx)));

    let run = async {
        if is_query_stmt(sql) {
            let (mut columns, data) = collect_query_rows(
                sqlx::query(sql).fetch(&mut conn), sqlite_cell,
            ).await?;
            if columns.is_empty() {
                use sqlx::{Executor, Column};
                columns = (&mut conn).describe(sql).await
                    .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default();
            }
            Ok(QueryResult { columns, rows: data, rows_affected: 0,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: true })
        } else {
            let res = sqlx::query(sql).execute(&mut conn).await
                .map_err(|e| format!("执行失败: {e}"))?;
            Ok(QueryResult { columns: vec![], rows: vec![],
                rows_affected: res.rows_affected(),
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: false })
        }
    };

    let result = if let Some(rx) = abort_rx {
        tokio::pin!(run);
        tokio::select! {
            r = &mut run => r,
            _ = rx => Err("已停止等待执行；写入是否生效尚未确认，请核查数据库，勿自动重试".to_string()),
        }
    } else {
        run.await
    };

    result
}

pub(crate) fn sqlite_cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Option<String> {
    use sqlx::Row;
    if matches!(row.try_get::<Option<String>, _>(i), Ok(None)) { return None; }
    // SQLite 无原生 BOOLEAN 类型，0/1 统一作为整数展示，不转 true/false
    None
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<f64, _>(i).ok().map(|v| v.to_string()))
        .or_else(|| row.try_get::<String, _>(i).ok())
        // BLOB：hex 展示而非丢成 "(bin)"
        .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().map(|b| format!("0x{}", hex::encode(b))))
        .or(Some("(bin)".to_string()))
}

// ── 表结构 ────────────────────────────────────────────────────────────────────

async fn mysql_columns(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    use sqlx::Row;
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("获取列信息失败: {e}"))?;
    // information_schema 的文本/枚举列在部分 MySQL 上为二进制字符集，
    // try_get::<String> 会失败（COLUMN_KEY 全部变空 → 识别不到主键 → 结果不可编辑）。
    // 用 try_get_unchecked + Vec<u8> 兜底鲁棒解码。
    let getstr = |r: &sqlx::mysql::MySqlRow, i: usize| -> Option<String> {
        r.try_get::<String, _>(i).ok()
            .or_else(|| r.try_get_unchecked::<String, _>(i).ok())
            .or_else(|| r.try_get::<Vec<u8>, _>(i).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
            .or_else(|| r.try_get_unchecked::<Vec<u8>, _>(i).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))
    };
    Ok(rows.iter().filter_map(|r| {
        Some(ColumnInfo {
            name: getstr(r, 0)?,
            data_type: getstr(r, 1).unwrap_or_default(),
            nullable: getstr(r, 2).map(|v| v == "YES").unwrap_or(false),
            key: getstr(r, 3).unwrap_or_default(),
            default_value: getstr(r, 4),
        })
    }).collect())
}

async fn pg_columns(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
                COALESCE(( \
                  SELECT 'PRI' FROM information_schema.table_constraints tc \
                  JOIN information_schema.key_column_usage kcu \
                    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                  WHERE tc.constraint_type = 'PRIMARY KEY' \
                    AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name \
                    AND kcu.column_name = c.column_name \
                  LIMIT 1), '') AS col_key \
         FROM information_schema.columns c \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("获取列信息失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| {
        Some(ColumnInfo {
            name: r.try_get::<String, _>(0).ok()?,
            data_type: r.try_get::<String, _>(1).unwrap_or_default(),
            nullable: r.try_get::<String, _>(2).map(|v| v == "YES").unwrap_or(false),
            key: r.try_get::<String, _>(4).unwrap_or_default(),
            default_value: r.try_get::<Option<String>, _>(3).ok().flatten(),
        })
    }).collect())
}

async fn sqlite_columns(pool: &sqlx::SqlitePool, table: &str) -> Result<Vec<ColumnInfo>, String> {
    use sqlx::Row;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取 SQLite 连接失败: {e}"))?;
    // table_xinfo 相比 table_info 多出 hidden 列（3.26+）
    // hidden: 0=普通列, 1=虚拟生成列, 2=存储生成列, 3=rowid 隐藏列（WITHOUT ROWID 表的别名）
    let escaped = table.replace('"', "\"\"");
    let sql = format!(r#"PRAGMA table_xinfo("{escaped}")"#);
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await
        .unwrap_or_else(|_| Vec::new());
    // 降级到 table_info（SQLite 3.26 以下）
    let rows = if rows.is_empty() {
        let sql2 = format!(r#"PRAGMA table_info("{escaped}")"#);
        sqlx::query(&sql2).fetch_all(&mut *conn).await
            .unwrap_or_default()
    } else { rows };

    Ok(rows.iter().filter_map(|r| {
        let name = r.try_get::<String, _>("name").ok()?;
        let hidden: i64 = r.try_get("hidden").unwrap_or(0);
        // hidden=3 是 WITHOUT ROWID 表的 rowid 影子列，不显示
        if hidden == 3 { return None; }
        let pk = r.try_get::<i64, _>("pk").unwrap_or(0) > 0;
        let key = if pk { "PRI".to_string() }
            else if hidden == 1 { "VIRT".to_string() }
            else if hidden == 2 { "GEN".to_string() }
            else { String::new() };
        Some(ColumnInfo {
            name,
            data_type: r.try_get::<String, _>("type").unwrap_or_default(),
            nullable: r.try_get::<i64, _>("notnull").map(|v| v == 0).unwrap_or(true),
            key,
            default_value: r.try_get::<Option<String>, _>("dflt_value").ok().flatten(),
        })
    }).collect())
}

async fn sqlite_tables(pool: &sqlx::SqlitePool) -> Result<Vec<TableInfo>, String> {
    use sqlx::Row;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取 SQLite 连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table','view') \
         ORDER BY name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| format!("获取表列表失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| {
        let name = r.try_get::<String, _>(0).ok()?;
        let kind = r.try_get::<String, _>(1).unwrap_or_default();
        Some(TableInfo { name, is_view: kind == "view" })
    }).collect())
}

// ── Routines ──────────────────────────────────────────────────────────────────

async fn mysql_routines(config: &ConnConfig, password: Option<&str>, schema: &str)
    -> Result<Vec<RoutineInfo>, String>
{
    
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    // 同 mysql_tables_meta：绕过 information_schema 元数据缓存，保证新建/删除例程后列表实时
    sqlx::query("SET SESSION information_schema_stats_expiry = 0").execute(&mut *conn).await.ok();
    let rows = sqlx::query(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE \
         FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = ? \
         ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
    ).bind(schema).fetch_all(&mut *conn).await
     .map_err(|e| format!("获取例程失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| Some(RoutineInfo {
        name:         mysql_str_col(r, 0)?,
        routine_type: mysql_str_col(r, 1).unwrap_or_default(),
    })).collect())
}

async fn pg_routines(config: &ConnConfig, password: Option<&str>, schema: &str)
    -> Result<Vec<RoutineInfo>, String>
{
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT p.proname, \
                CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END \
         FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.prokind IN ('f','p') \
         ORDER BY 2, 1",
    ).bind(schema).fetch_all(&mut *conn).await
     .map_err(|e| format!("获取例程失败: {e}"))?;
    Ok(rows.iter().filter_map(|r| Some(RoutineInfo {
        name:         r.try_get::<String, _>(0).ok()?,
        routine_type: r.try_get::<String, _>(1).unwrap_or_default(),
    })).collect())
}

// ── DDL ───────────────────────────────────────────────────────────────────────

async fn mysql_table_ddl(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str)
    -> Result<String, String>
{
    use sqlx::Row;
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let sql = format!(
        "SHOW CREATE TABLE `{}`.`{}`",
        schema.replace('`', "``"),
        table.replace('`', "``"),
    );
    let row = sqlx::query(&sql).fetch_one(&mut conn).await
        .map_err(|e| format!("获取 DDL 失败: {e}"))?;
    // SHOW CREATE TABLE → col[1] = "Create Table" / "Create View"
    row.try_get::<String, _>(1).map_err(|e| format!("解析 DDL 失败: {e}"))
}

async fn pg_table_ddl(config: &ConnConfig, password: Option<&str>, schema: &str, table: &str)
    -> Result<String, String>
{
    use sqlx::Row;
    let (mut conn, _tunnel) = pg_connect(config, password).await?;

    // 视图 / 物化视图：直接返回视图定义（pg_get_viewdef），不要按列重建成 CREATE TABLE
    if let Ok(Some(row)) = sqlx::query(
        "SELECT c.relkind::text, pg_get_viewdef(c.oid, true) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v','m')",
    ).bind(schema).bind(table).fetch_optional(&mut conn).await {
        let kind: String = row.try_get::<String, _>(0).unwrap_or_default();
        let def: String = row.try_get::<String, _>(1).unwrap_or_default();
        let head = if kind == "m" { "CREATE MATERIALIZED VIEW" } else { "CREATE OR REPLACE VIEW" };
        return Ok(format!("{head} \"{schema}\".\"{table}\" AS\n{}", def.trim()));
    }

    // Column definitions
    let col_rows = sqlx::query(
        "SELECT column_name, \
          CASE \
            WHEN data_type = 'character varying' \
              THEN 'varchar(' || COALESCE(character_maximum_length::text, '') || ')' \
            WHEN data_type = 'character' \
              THEN 'char(' || COALESCE(character_maximum_length::text, '') || ')' \
            WHEN data_type = 'numeric' AND numeric_precision IS NOT NULL \
              THEN 'numeric(' || numeric_precision || ',' || COALESCE(numeric_scale::text,'0') || ')' \
            ELSE data_type \
          END, \
          is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 \
         ORDER BY ordinal_position",
    ).bind(schema).bind(table).fetch_all(&mut conn).await
     .map_err(|e| format!("获取列信息失败: {e}"))?;

    if col_rows.is_empty() {
        return Err(format!("表 {schema}.{table} 不存在"));
    }

    let cols: Vec<String> = col_rows.iter().filter_map(|r| {
        let name    = r.try_get::<String, _>(0).ok()?;
        let typ     = r.try_get::<String, _>(1).unwrap_or_default();
        let notnull = r.try_get::<String, _>(2).map(|v| v == "NO").unwrap_or(false);
        let def     = r.try_get::<Option<String>, _>(3).ok().flatten();
        let mut s   = format!("  {name} {typ}");
        if notnull { s.push_str(" NOT NULL"); }
        if let Some(d) = def { s.push_str(&format!(" DEFAULT {d}")); }
        Some(s)
    }).collect();

    // Primary key
    let pk_rows = sqlx::query(
        "SELECT kcu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
           AND tc.table_schema   = kcu.table_schema \
         WHERE tc.constraint_type = 'PRIMARY KEY' \
           AND tc.table_schema = $1 AND tc.table_name = $2 \
         ORDER BY kcu.ordinal_position",
    ).bind(schema).bind(table).fetch_all(&mut conn).await.unwrap_or_default();

    let pks: Vec<String> = pk_rows.iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .map(|c| format!("\"{c}\""))
        .collect();

    let mut parts = cols;
    if !pks.is_empty() {
        parts.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
    }

    // 外键 / 唯一 / 检查约束：用 pg_get_constraintdef 直接拿现成定义（FOREIGN KEY/UNIQUE/CHECK）
    let con_rows = sqlx::query(
        "SELECT pg_get_constraintdef(c.oid) \
         FROM pg_constraint c \
         JOIN pg_class t ON t.oid = c.conrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('f','u','c') \
         ORDER BY c.contype DESC, c.conname",
    ).bind(schema).bind(table).fetch_all(&mut conn).await.unwrap_or_default();
    for r in &con_rows {
        if let Ok(def) = r.try_get::<String, _>(0) {
            parts.push(format!("  {def}"));
        }
    }

    let mut out = format!(
        "CREATE TABLE \"{schema}\".\"{table}\" (\n{}\n);",
        parts.join(",\n")
    );

    // 普通索引（排除主键/唯一约束自动创建的索引，避免重复）
    let idx_rows = sqlx::query(
        "SELECT indexdef FROM pg_indexes \
         WHERE schemaname = $1 AND tablename = $2 \
           AND indexname NOT IN ( \
             SELECT c.conname FROM pg_constraint c \
             JOIN pg_class t ON t.oid = c.conrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('p','u')) \
         ORDER BY indexname",
    ).bind(schema).bind(table).fetch_all(&mut conn).await.unwrap_or_default();
    for r in &idx_rows {
        if let Ok(def) = r.try_get::<String, _>(0) {
            out.push_str(&format!("\n{def};"));
        }
    }

    // 表注释
    if let Ok(Some(r)) = sqlx::query(
        "SELECT obj_description(c.oid, 'pg_class') \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    ).bind(schema).bind(table).fetch_optional(&mut conn).await {
        if let Ok(Some(c)) = r.try_get::<Option<String>, _>(0) {
            if !c.is_empty() {
                out.push_str(&format!("\nCOMMENT ON TABLE \"{schema}\".\"{table}\" IS '{}';", c.replace('\'', "''")));
            }
        }
    }

    Ok(out)
}

// ── 表元数据 helpers ──────────────────────────────────────────────────────────

fn mysql_u64_col(row: &sqlx::mysql::MySqlRow, i: usize) -> u64 {
    use sqlx::Row;
    row.try_get::<u64, _>(i).ok()
        .or_else(|| row.try_get::<i64, _>(i).ok().map(|v| v as u64))
        .or_else(|| mysql_str_col(row, i).and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn mysql_opt_u64_col(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<u64> {
    use sqlx::Row;
    row.try_get::<Option<u64>, _>(i).ok().flatten()
        .or_else(|| row.try_get::<Option<i64>, _>(i).ok().flatten().map(|v| v as u64))
        .or_else(|| mysql_str_col(row, i).and_then(|s| s.parse().ok()))
}

async fn mysql_tables_meta(config: &ConnConfig, password: Option<&str>, schema: &str)
    -> Result<Vec<TableMetaInfo>, String>
{
    use std::collections::HashMap;
    let pool = mysql_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    // 关键：表「清单」必须来自 SHOW FULL TABLES（读实时数据字典，与左侧树同源、绝不滞后）。
    // information_schema.TABLES 仅用于补充统计元数据（行数/大小等），其统计列受
    // information_schema_stats_expiry（默认 24h）缓存影响会滞后——这正是「预览总比树少一个、像缓存」的根因。
    sqlx::query("SET SESSION information_schema_stats_expiry = 0").execute(&mut *conn).await.ok();

    // 1. 权威清单（含 Table_type：BASE TABLE / VIEW / SYSTEM VIEW）
    let show_rows = sqlx::query(&format!("SHOW FULL TABLES FROM `{}`", schema.replace('`', "``")))
        .fetch_all(&mut *conn).await
        .map_err(|e| format!("获取表清单失败: {e}"))?;
    let listing: Vec<(String, String)> = show_rows.iter().filter_map(|r| {
        let name  = mysql_str_col(r, 0)?;
        let ttype = mysql_str_col(r, 1).unwrap_or_else(|| "BASE TABLE".to_string());
        Some((name, ttype))
    }).collect();

    // 2. 统计元数据（可能滞后；缺失用默认值，保证新表立即出现）
    let meta_rows = sqlx::query(
        "SELECT TABLE_NAME, COALESCE(TABLE_COMMENT,''), \
         COALESCE(TABLE_ROWS,0), COALESCE(DATA_LENGTH,0), COALESCE(INDEX_LENGTH,0), \
         AUTO_INCREMENT, COALESCE(ENGINE,''), COALESCE(TABLE_COLLATION,''), \
         DATE_FORMAT(UPDATE_TIME,'%Y-%m-%d %H:%i:%S'), \
         DATE_FORMAT(CREATE_TIME,'%Y-%m-%d %H:%i:%S') \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    ).bind(schema).fetch_all(&mut *conn).await.unwrap_or_default();
    let mut meta: HashMap<String, TableMetaInfo> = HashMap::new();
    for r in &meta_rows {
        if let Some(name) = mysql_str_col(r, 0) {
            meta.insert(name.clone(), TableMetaInfo {
                name,
                comment:        mysql_str_col(r, 1).unwrap_or_default(),
                row_count:      mysql_u64_col(r, 2) as i64,
                data_length:    mysql_u64_col(r, 3) as i64,
                index_length:   mysql_u64_col(r, 4) as i64,
                auto_increment: mysql_opt_u64_col(r, 5).map(|v| v as i64),
                engine:         mysql_str_col(r, 6).unwrap_or_default(),
                charset:        mysql_str_col(r, 7).unwrap_or_default(),
                updated_at:     mysql_str_col(r, 8),
                created_at:     mysql_str_col(r, 9),
                table_type:     String::new(),
            });
        }
    }

    // 3. 以权威清单为准合并（清单里的 Table_type 最准）
    Ok(listing.into_iter().map(|(name, table_type)| {
        let mut m = meta.remove(&name).unwrap_or(TableMetaInfo {
            name: name.clone(), comment: String::new(), row_count: 0, data_length: 0, index_length: 0,
            auto_increment: None, engine: String::new(), charset: String::new(),
            updated_at: None, created_at: None, table_type: String::new(),
        });
        m.table_type = table_type;
        m
    }).collect())
}

async fn pg_tables_meta(config: &ConnConfig, password: Option<&str>, schema: &str)
    -> Result<Vec<TableMetaInfo>, String>
{
    use sqlx::Row;
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let rows = sqlx::query(
        "SELECT t.table_name, \
         COALESCE((SELECT obj_description(c.oid) \
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
           WHERE c.relname=t.table_name AND n.nspname=t.table_schema LIMIT 1), '') as comment, \
         COALESCE((SELECT s.n_live_tup FROM pg_stat_user_tables s \
           WHERE s.relname=t.table_name AND s.schemaname=t.table_schema LIMIT 1), 0)::bigint, \
         0::bigint, 0::bigint, NULL::bigint, '' as engine, '' as charset, \
         NULL::text, NULL::text, t.table_type \
         FROM information_schema.tables t WHERE t.table_schema=$1 ORDER BY t.table_name",
    ).bind(schema).fetch_all(&mut *conn).await
     .map_err(|e| format!("获取表元数据失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        let name          = r.try_get::<String, _>(0).ok()?;
        let comment       = r.try_get::<String, _>(1).unwrap_or_default();
        let row_count     = r.try_get::<i64, _>(2).unwrap_or(0);
        let data_length   = r.try_get::<i64, _>(3).unwrap_or(0);
        let index_length  = r.try_get::<i64, _>(4).unwrap_or(0);
        let auto_increment: Option<i64> = r.try_get::<Option<i64>, _>(5).ok().flatten();
        let engine        = r.try_get::<String, _>(6).unwrap_or_default();
        let charset       = r.try_get::<String, _>(7).unwrap_or_default();
        let updated_at: Option<String> = r.try_get::<Option<String>, _>(8).ok().flatten();
        let created_at: Option<String> = r.try_get::<Option<String>, _>(9).ok().flatten();
        let table_type    = r.try_get::<String, _>(10).unwrap_or_else(|_| "BASE TABLE".to_string());
        Some(TableMetaInfo { name, comment, row_count, data_length, index_length,
            auto_increment, engine, charset, updated_at, created_at, table_type })
    }).collect())
}

async fn sqlite_tables_meta(pool: &sqlx::SqlitePool) -> Result<Vec<TableMetaInfo>, String> {
    use sqlx::Row;
    use std::collections::HashMap;
    let tables = sqlite_tables(pool).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取 SQLite 连接失败: {e}"))?;

    // 每个 b-tree（表/各索引）占用字节，来自 dbstat 虚表（构建未启用则忽略，大小记 0）
    let mut size_by_name: HashMap<String, i64> = HashMap::new();
    if let Ok(rows) = sqlx::query("SELECT name, SUM(pgsize) AS sz FROM dbstat GROUP BY name")
        .fetch_all(&mut *conn).await
    {
        for r in rows {
            if let (Ok(n), Ok(sz)) = (r.try_get::<String, _>(0), r.try_get::<i64, _>(1)) {
                size_by_name.insert(n, sz);
            }
        }
    }
    // 索引 → 所属表，用于把索引占用计入对应表的「索引大小」
    let mut idx_of_table: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(rows) = sqlx::query("SELECT name, tbl_name FROM sqlite_master WHERE type='index'")
        .fetch_all(&mut *conn).await
    {
        for r in rows {
            if let (Ok(idx), Ok(tbl)) = (r.try_get::<String, _>(0), r.try_get::<String, _>(1)) {
                idx_of_table.entry(tbl).or_default().push(idx);
            }
        }
    }

    let mut out = Vec::with_capacity(tables.len());
    for t in tables {
        let data_length = *size_by_name.get(&t.name).unwrap_or(&0);
        let index_length: i64 = idx_of_table.get(&t.name)
            .map(|ids| ids.iter().map(|i| size_by_name.get(i).copied().unwrap_or(0)).sum())
            .unwrap_or(0);
        // 视图无数据；表的精确行数（SQLite 无估算值，只能 COUNT）
        let row_count = if t.is_view { 0 } else {
            let q = format!("SELECT COUNT(*) FROM \"{}\"", t.name.replace('"', "\"\""));
            sqlx::query(&q).fetch_one(&mut *conn).await.ok()
                .and_then(|r| r.try_get::<i64, _>(0).ok()).unwrap_or(0)
        };
        out.push(TableMetaInfo {
            name: t.name,
            comment: String::new(),
            row_count, data_length, index_length, auto_increment: None,
            engine: "SQLite".to_string(), charset: "UTF-8".to_string(),
            updated_at: None, created_at: None,
            table_type: if t.is_view { "VIEW".to_string() } else { "BASE TABLE".to_string() },
        });
    }
    Ok(out)
}

async fn duck_tables_meta(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    duck_pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<Vec<TableMetaInfo>, String> {
    use super::duckdb::{get_or_open_pub, run_query_sync_pub};
    let lib_path = super::duckdb::get_duck_lib_path_pub(registry).await?;
    let conn = get_or_open_pub(id, config, duck_pool, &lib_path).await?;
    let s_esc = schema.replace('\'', "''");

    // 表：从 duckdb_tables() 取 estimated_size
    let sql_tables = format!(
        "SELECT t.table_name, COALESCE(dt.estimated_size, 0), 'BASE TABLE' \
         FROM information_schema.tables t \
         LEFT JOIN duckdb_tables() dt ON dt.schema_name = t.table_schema AND dt.table_name = t.table_name \
         WHERE t.table_schema = '{}' AND t.table_type = 'BASE TABLE' \
         ORDER BY t.table_name", s_esc
    );
    // 视图
    let sql_views = format!(
        "SELECT table_name, 0, 'VIEW' \
         FROM information_schema.tables \
         WHERE table_schema = '{}' AND table_type = 'VIEW' \
         ORDER BY table_name", s_esc
    );

    let conn2 = conn.clone();
    let (tables_res, views_res) = tokio::join!(
        tokio::task::spawn_blocking(move || {
            let g = conn.blocking_lock(); run_query_sync_pub(&g, &sql_tables, 5000)
        }),
        tokio::task::spawn_blocking(move || {
            let g = conn2.blocking_lock(); run_query_sync_pub(&g, &sql_views, 5000)
        })
    );

    let mut out: Vec<TableMetaInfo> = Vec::new();
    for res in [tables_res.map_err(|e| e.to_string())?, views_res.map_err(|e| e.to_string())?] {
        let qr = res?;
        for r in qr.rows {
            let name       = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let data_len   = r.get(1).and_then(|v| v.clone()).unwrap_or_default().parse::<i64>().unwrap_or(0);
            let table_type = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            out.push(TableMetaInfo {
                name, comment: String::new(),
                row_count: 0, data_length: data_len, index_length: 0,
                auto_increment: None,
                engine: "DuckDB".to_string(), charset: "UTF-8".to_string(),
                updated_at: None, created_at: None, table_type,
            });
        }
    }
    Ok(out)
}

// ClickHouse 表元数据：取自 system.tables（行数 / 磁盘字节 / 引擎 / 注释 / 修改时间）。
// engine 以 View 结尾即视图（普通视图 / 物化视图），前端据 tableType 拆分「表 / 视图」。
async fn ch_tables_meta(config: &ConnConfig, password: Option<&str>, schema: &str)
    -> Result<Vec<TableMetaInfo>, String>
{
    let s_esc = schema.replace('\'', "''");
    let sql = format!(
        "SELECT name, engine, comment, \
                toString(coalesce(total_rows, 0)) AS rows, \
                toString(coalesce(total_bytes, 0)) AS bytes, \
                toString(metadata_modification_time) AS modified, \
                if(engine LIKE '%View', 'VIEW', 'BASE TABLE') AS tbl_type \
         FROM system.tables WHERE database = '{s_esc}' ORDER BY name"
    );
    let qr = super::clickhouse::query(config, password, &sql).await?;
    let cell = |r: &[Option<String>], i: usize| r.get(i).and_then(|v| v.clone()).unwrap_or_default();
    Ok(qr.rows.iter().map(|r| {
        let modified = cell(r, 5);
        TableMetaInfo {
            name:          cell(r, 0),
            comment:       cell(r, 2),
            row_count:     cell(r, 3).parse::<i64>().unwrap_or(0),
            data_length:   cell(r, 4).parse::<i64>().unwrap_or(0),
            index_length:  0,
            auto_increment: None,
            engine:        cell(r, 1),
            charset:       "UTF-8".to_string(),
            // 1970 纪元默认值视为无修改时间
            updated_at:    if modified.starts_with("1970") || modified.is_empty() { None } else { Some(modified) },
            created_at:    None,
            table_type:    cell(r, 6),
        }
    }).collect())
}

async fn sqlite_ddl(url: &str, table: &str) -> Result<String, String> {
    use sqlx::{sqlite::SqliteConnection, Connection, Row};
    let mut conn = SqliteConnection::connect(url).await
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    let sql = format!(
        "SELECT sql FROM sqlite_master \
         WHERE name = '{}' AND type IN ('table','view')",
        table.replace('\'', "''")
    );
    let row = sqlx::query(&sql).fetch_optional(&mut conn).await
        .map_err(|e| format!("获取 DDL 失败: {e}"))?
        .ok_or_else(|| format!("表 {table} 不存在"))?;
    row.try_get::<String, _>(0).map_err(|e| format!("解析 DDL 失败: {e}"))
}
