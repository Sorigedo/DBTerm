use std::time::{Duration, Instant};
use tauri::State;
use crate::{
    models::{ColumnInfo, ConnConfig, ConnType, QueryResult, TableInfo},
    storage::StorageState,
};
use super::sqlite_admin::SqliteAttachMap;
use super::duckdb::{DuckPool, dispatch_duck_query, dispatch_duck_schemas, dispatch_duck_tables, dispatch_duck_ddl, dispatch_duck_columns};
use super::driver::DriverRegistry;
use super::sqlserver::{SsPool, dispatch_ss_query, dispatch_ss_schemas, dispatch_ss_tables, dispatch_ss_columns, dispatch_ss_schema_columns, dispatch_ss_ddl, dispatch_ss_routines, dispatch_ss_db_schemas, dispatch_ss_schema_tables};

// ── 客户端标识 & 连接扩展配置 ─────────────────────────────────────────────────

/// 所有 SQL 前加注释：在 SHOW PROCESSLIST / pg_stat_activity / 慢查询日志中可见
const CLIENT_TAG: &str = "/* DBTerm */";
fn tag_sql(sql: &str) -> String { format!("{CLIENT_TAG} {sql}") }

/// 从 extra_json 读取连接扩展配置（与前端 DbExtra 对应）
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
    fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
    }
    fn timeout(&self) -> Duration {
        Duration::from_secs(if self.connect_timeout == 0 { 30 } else { self.connect_timeout.clamp(3, 300) })
    }
    /// 取 SSH 隧道密码：优先 extra_json 中的值（老数据/测试时直传），
    /// 若为空则从 keychain 读取（save_connection 已将其迁入 keychain）。
    fn tunnel_password(&self, conn_id: &str) -> String {
        if !self.ssh_password.is_empty() { return self.ssh_password.clone(); }
        crate::keychain::get_password(&format!("{conn_id}::ssh-tunnel"))
            .ok().flatten().unwrap_or_default()
    }
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
pub(crate) async fn mysql_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::mysql::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions, MySqlSslMode}};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    // SSH 隧道（按连接 ID 复用，避免每次查询重新登录跳板机）
    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
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
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => MySqlSslMode::Required,
        "verify-ca"   => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _             => MySqlSslMode::Disabled,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let mut conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    // 字符集（非 UTF-8 时显式 SET NAMES）
    if matches!(cfg.encoding.as_str(), "GBK" | "GB2312") {
        sqlx::query("SET NAMES gbk").execute(&mut conn).await.ok();
    } else if cfg.encoding == "Latin-1" {
        sqlx::query("SET NAMES latin1").execute(&mut conn).await.ok();
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
async fn mysql_pool(config: &ConnConfig, password: Option<&str>) -> Result<sqlx::mysql::MySqlPool, String> {
    {
        let m = mysql_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get(&config.id) {
            if c._tunnel.as_ref().map_or(true, |t| t.is_alive()) {
                return Ok(c.pool.clone());
            }
        }
    }
    invalidate_mysql_pool(&config.id);

    use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode, MySqlPoolOptions};
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};
    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port, user: cfg.ssh_user.clone(),
            auth_type: cfg.ssh_auth_type.clone(), password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
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
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require" => MySqlSslMode::Required, "verify-ca" => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity, _ => MySqlSslMode::Disabled });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    // 每条池连接建立后做与 mysql_connect 等价的会话初始化（编码 / init_sql / 只读）
    let encoding = cfg.encoding.clone();
    let init_sql = cfg.init_sql.clone();
    let read_only = config.read_only == Some(true);
    let pool = MySqlPoolOptions::new()
        .max_connections(10)   // 元数据/浏览/补全并发较多，适当放大并发上限（每连接独立池）
        .idle_timeout(Some(Duration::from_secs(300)))   // 空闲 5min 自动回收，避免久挂占连接
        .acquire_timeout(cfg.timeout())
        .after_connect(move |conn, _meta| {
            let (encoding, init_sql) = (encoding.clone(), init_sql.clone());
            Box::pin(async move {
                if matches!(encoding.as_str(), "GBK" | "GB2312") { let _ = sqlx::query("SET NAMES gbk").execute(&mut *conn).await; }
                else if encoding == "Latin-1" { let _ = sqlx::query("SET NAMES latin1").execute(&mut *conn).await; }
                for stmt in init_sql.split(';').map(str::trim).filter(|s| !s.is_empty() && !s.starts_with("--")) {
                    sqlx::query(stmt).execute(&mut *conn).await?;
                }
                if read_only { sqlx::query("SET SESSION TRANSACTION READ ONLY").execute(&mut *conn).await?; }
                Ok(())
            })
        })
        .connect_lazy_with(opts);

    mysql_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(config.id.clone(), CachedMyPool { pool: pool.clone(), _tunnel: tunnel });
    Ok(pool)
}

/// 建立 PostgreSQL 连接，自动处理 SSH 隧道、SSL、超时、init SQL、application_name
pub(crate) async fn pg_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::postgres::PgConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    use sqlx::{ConnectOptions, postgres::{PgConnectOptions, PgSslMode}};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
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

    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => PgSslMode::Require,
        "verify-ca"   => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _             => PgSslMode::Disable,
    });
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
    _tunnel: Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>,
}
fn pg_pool_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedPgPool>> {
    static P: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedPgPool>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
pub fn invalidate_pg_pool(id: &str) {
    if let Ok(mut m) = pg_pool_reg().lock() { m.remove(id); }
}
async fn pg_pool(config: &ConnConfig, password: Option<&str>) -> Result<sqlx::postgres::PgPool, String> {
    {
        let m = pg_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get(&config.id) {
            if c._tunnel.as_ref().map_or(true, |t| t.is_alive()) { return Ok(c.pool.clone()); }
        }
    }
    invalidate_pg_pool(&config.id);

    use sqlx::postgres::{PgConnectOptions, PgSslMode, PgPoolOptions};
    use crate::{db_tunnel::{DbTunnel, DbTunnelCfg}, tester::expand_home};
    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port, user: cfg.ssh_user.clone(),
            auth_type: cfg.ssh_auth_type.clone(), password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
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
    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require" => PgSslMode::Require, "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull, _ => PgSslMode::Disable });
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
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .idle_timeout(Some(Duration::from_secs(300)))
        .acquire_timeout(cfg.timeout())
        .after_connect(move |conn, _meta| {
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
        .insert(config.id.clone(), CachedPgPool { pool: pool.clone(), _tunnel: tunnel });
    Ok(pool)
}

// ── SQLite 浏览连接池（只供 list_tables / list_columns / list_tables_meta）──
// SQLite 读操作可并发（WAL 模式下）；写路径仍用独占连接。
struct CachedSqlitePool { pool: sqlx::SqlitePool }

fn sqlite_pool_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedSqlitePool>> {
    static P: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedSqlitePool>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn invalidate_sqlite_pool(id: &str) {
    if let Ok(mut m) = sqlite_pool_reg().lock() { m.remove(id); }
}

async fn sqlite_browse_pool(config: &ConnConfig) -> Result<sqlx::SqlitePool, String> {
    {
        let m = sqlite_pool_reg().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = m.get(&config.id) {
            if !c.pool.is_closed() { return Ok(c.pool.clone()); }
        }
    }
    invalidate_sqlite_pool(&config.id);
    use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, ConnectOptions};
    use std::str::FromStr;
    let cfg = DbConnCfg::from_config(config);
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
        .insert(config.id.clone(), CachedSqlitePool { pool: pool.clone() });
    Ok(pool)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn execute_query(
    id: String,
    sql: String,
    database: Option<String>,   // 查询页选中的 schema/库：覆盖连接默认库（Navicat 风格切库，无需 USE）
    row_limit: Option<u64>,     // 前端行数上限（None = 全量，Some(n) = 追加 LIMIT n）
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<QueryResult, String> {
    let (mut config, password) = load_conn(&id, &storage)?;
    // 集中只读护栏（fail-closed）：只读连接拒绝非查询语句。覆盖所有引擎——
    // MySQL/DuckDB/SQLServer/ClickHouse 的单独路径此前没有引擎级只读，这里统一兜底。
    // 引擎级只读（PG/SQLite session、MySQL session、DuckDB access_mode）作为更精确的第二重保障。
    if config.read_only == Some(true) {
        // SQLServer/ClickHouse 无引擎级只读，仅靠此处；而 is_query_stmt 放行 WITH/EXPLAIN，
        // SQLServer 可用 `WITH x AS(...) DELETE ...` 藏写操作 → 对这两类再做写关键字扫描兜底。
        let no_engine_ro = matches!(config.conn_type, ConnType::SqlServer | ConnType::ClickHouse);
        if !is_query_stmt(&sql) || (no_engine_ro && contains_write_keyword(&sql)) {
            return Err("该连接为只读模式，已拒绝写操作".to_string());
        }
    }
    if let Some(db) = database.as_deref() {
        if !db.is_empty() { config.database = Some(db.to_string()); }
    }

    if config.conn_type == ConnType::SqlServer {
        let (ss_sql, limit_applied) = apply_sqlserver_row_limit(&sql, row_limit);
        let mut r = dispatch_ss_query(&id, &config, &ss_sql, &ss_pool).await?;
        r.truncated = limit_applied;
        return Ok(r);
    }
    // Oracle 不支持 LIMIT，用 FETCH FIRST n ROWS ONLY；已含 FETCH/ROWNUM 子句时不再追加
    if config.conn_type == ConnType::Oracle {
        let oracle_sql = if is_query_stmt(&sql) && !has_limit_clause(&sql) && !has_fetch_clause(&sql) {
            if let Some(lim) = row_limit {
                let base = sql.trim_end().trim_end_matches(';').trim_end();
                format!("{base} FETCH FIRST {lim} ROWS ONLY")
            } else { sql.clone() }
        } else { sql.clone() };
        return super::oracle::execute_query_impl(config, oracle_sql, password, &*registry).await;
    }

    // 行数限制：仅对 SELECT 类语句且用户未在 SQL 中自写 LIMIT/FETCH 时注入
    let (effective_sql, limit_applied) = if is_query_stmt(&sql) && !has_limit_clause(&sql) {
        if let Some(lim) = row_limit {
            let base = sql.trim_end().trim_end_matches(';').trim_end();
            (format!("{base} LIMIT {lim}"), true)
        } else {
            (sql.clone(), false)
        }
    } else {
        (sql.clone(), false)
    };

    if config.conn_type == ConnType::Duckdb {
        let mut r = dispatch_duck_query(&id, &config, &effective_sql, &duck_pool, &registry).await?;
        r.truncated = limit_applied;
        return Ok(r);
    }
    drop(storage);
    let mut r = dispatch_query(&config, password.as_deref(), &effective_sql).await?;
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
        ConnType::SqlServer => dispatch_ss_columns(&id, &config, &schema, &table, &ss_pool).await,
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
            super::sqlserver::dispatch_ss_tables_meta(&id, &config, &schema, &ss_pool).await,
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
        ConnType::SqlServer => dispatch_ss_ddl(&id, &config, &schema, &table, &ss_pool).await,
        ConnType::Oracle => super::oracle::get_table_ddl_impl(config, schema, table, password, &*registry).await,
        _ => Err("此连接类型不支持查看 DDL".into()),
    }
}

/// 按方言取「函数 / 存储过程」定义脚本。kind: "function" | "procedure"。
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
    if !schema.is_empty() {
        let _ = sqlx::query(&format!("USE {}", q_mysql(schema))).execute(&mut *conn).await;
    }
    let kw = if kind.eq_ignore_ascii_case("function") { "FUNCTION" } else { "PROCEDURE" };
    let row = sqlx::query(&format!("SHOW CREATE {kw} {}", q_mysql(name)))
        .fetch_one(&mut *conn).await
        .map_err(|e| format!("获取定义失败: {e}"))?;
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
fn q_dq(s: &str)    -> String { format!("\"{}\"", s.replace('"', "\"\"")) }

/// 更新单个单元格：参数绑定防注入；事务内校验影响行数 == 1，否则回滚
#[tauri::command]
pub async fn update_cell(
    id: String,
    schema: String,
    table: String,
    column: String,
    new_value: Option<String>,
    pk_columns: Vec<String>,
    pk_values: Vec<Option<String>>,
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
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_update_cell(&config, password.as_deref(),
                &schema, &table, &column, new_value, &pk_columns, &pk_values).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_update_cell(&config, password.as_deref(),
                &schema, &table, &column, new_value, &pk_columns, &pk_values).await
        }
        ConnType::Sqlite => {
            sqlite_update_cell(&sqlite_url(&config)?,
                &table, &column, new_value, &pk_columns, &pk_values).await
        }
        ConnType::SqlServer => {
            super::sqlserver::ss_update_cell(&id, &config, &schema, &table, &column,
                new_value, &pk_columns, &pk_values, &ss_pool).await
        }
        ConnType::Oracle => {
            super::oracle::update_cell_impl(config, schema, table, column,
                new_value, pk_columns, pk_values, password, &*registry).await
        }
        _ => Err("此连接类型不支持行内编辑".into()),
    }
}

async fn mysql_update_cell(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str, column: &str,
    new_value: Option<String>, pk_columns: &[String], pk_values: &[Option<String>],
) -> Result<(), String> {
    use sqlx::Connection;
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;

    let target = if schema.is_empty() { q_mysql(table) } else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
    let set_part = if new_value.is_some() { format!("{} = ?", q_mysql(column)) } else { format!("{} = NULL", q_mysql(column)) };
    let where_parts: Vec<String> = pk_columns.iter().zip(pk_values)
        .map(|(c, v)| if v.is_some() { format!("{} = ?", q_mysql(c)) } else { format!("{} IS NULL", q_mysql(c)) })
        .collect();
    let sql = format!("UPDATE {target} SET {set_part} WHERE {} LIMIT 1", where_parts.join(" AND "));

    let mut q = sqlx::query(&sql);
    if let Some(v) = &new_value { q = q.bind(v); }
    for v in pk_values.iter().flatten() { q = q.bind(v); }
    let res = q.execute(&mut *tx).await.map_err(|e| format!("更新失败: {e}"))?;

    let n = res.rows_affected();
    if n != 1 {
        // drop tx 自动回滚
        return Err(update_count_err(n));
    }
    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))
}

async fn pg_update_cell(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str, column: &str,
    new_value: Option<String>, pk_columns: &[String], pk_values: &[Option<String>],
) -> Result<(), String> {
    use sqlx::Connection;
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let mut tx = conn.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;

    let schema_name = if schema.is_empty() { "public" } else { schema };
    // 查目标列类型用于 CAST（来源是服务器元数据，仍做字符白名单校验）
    let dt: Option<(String, String)> = sqlx::query_as(
        "SELECT data_type, udt_name FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 AND column_name = $3")
        .bind(schema_name).bind(table).bind(column)
        .fetch_optional(&mut *tx).await
        .map_err(|e| format!("查询列类型失败: {e}"))?;
    let (data_type, udt_name) = dt.ok_or_else(|| format!("列 {column} 不存在"))?;
    let cast_type = match data_type.as_str() {
        "ARRAY" | "USER-DEFINED" => q_dq(&udt_name),
        _ => data_type.clone(),
    };
    if data_type != "ARRAY" && data_type != "USER-DEFINED"
        && !cast_type.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '(' || c == ')' || c == ',') {
        return Err(format!("列类型 {cast_type} 暂不支持行内编辑"));
    }

    let target = format!("{}.{}", q_dq(schema_name), q_dq(table));
    let mut bind_idx = 0usize;
    let set_part = if new_value.is_some() {
        bind_idx += 1;
        format!("{} = CAST($1 AS {cast_type})", q_dq(column))
    } else {
        format!("{} = NULL", q_dq(column))
    };
    let where_parts: Vec<String> = pk_columns.iter().zip(pk_values)
        .map(|(c, v)| {
            if v.is_some() {
                bind_idx += 1;
                // 列侧 cast 为 text 与字符串参数比较，规避参数类型推断问题
                format!("{}::text = ${bind_idx}", q_dq(c))
            } else {
                format!("{} IS NULL", q_dq(c))
            }
        })
        .collect();
    let sql = format!("UPDATE {target} SET {set_part} WHERE {}", where_parts.join(" AND "));

    let mut q = sqlx::query(&sql);
    if let Some(v) = &new_value { q = q.bind(v); }
    for v in pk_values.iter().flatten() { q = q.bind(v); }
    let res = q.execute(&mut *tx).await.map_err(|e| format!("更新失败: {e}"))?;

    let n = res.rows_affected();
    if n != 1 {
        // drop tx 自动回滚
        return Err(update_count_err(n));
    }
    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))
}

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
    let res = q.execute(&mut *tx).await.map_err(|e| format!("更新失败: {e}"))?;

    let n = res.rows_affected();
    if n != 1 {
        return Err(update_count_err(n));
    }
    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))
}

fn update_count_err(n: u64) -> String {
    if n == 0 {
        "未找到匹配行（或值未变化），已回滚".to_string()
    } else {
        format!("预期影响 1 行，实际影响 {n} 行，已回滚以保护数据")
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
/// 关键：前端会注入 `/* dbterm-cancel:token */` 取消标记，若不剥离会导致 SELECT 被误判为写语句。
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
fn abort_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static R: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>> = std::sync::OnceLock::new();
    R.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
pub(crate) fn abort_register(token: &str) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut m) = abort_reg().lock() { m.insert(token.to_string(), tx); }
    rx
}
pub(crate) fn abort_unregister(token: &str) {
    if let Ok(mut m) = abort_reg().lock() { m.remove(token); }
}
/// 触发取消：取出该 token 的发送端并发信号 → 执行端 select! 命中取消分支、丢弃查询并关连接。
pub fn cancel_abort(token: &str) -> bool {
    let tx = abort_reg().lock().ok().and_then(|mut m| m.remove(token));
    if let Some(tx) = tx { let _ = tx.send(()); true } else { false }
}

// 同时登记执行查询的后端连接/进程 id：取消时再额外尝试服务端 KILL（同节点时能立刻停掉
// SLEEP 这类不靠 I/O 的查询；多节点/代理下可能落到别的节点而失败，失败忽略即可）。
fn pid_reg() -> &'static std::sync::Mutex<std::collections::HashMap<String, i64>> {
    static R: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> = std::sync::OnceLock::new();
    R.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
fn pid_register(token: &str, pid: i64) { if let Ok(mut m) = pid_reg().lock() { m.insert(token.to_string(), pid); } }
fn pid_unregister(token: &str) { if let Ok(mut m) = pid_reg().lock() { m.remove(token); } }
pub fn cancel_pid(token: &str) -> Option<i64> { pid_reg().lock().ok()?.get(token).copied() }
/// 从 SQL 里提取 `/* dbterm-cancel:<token> */` 的 token
pub(crate) fn extract_cancel_token(sql: &str) -> Option<String> {
    let i = sql.find("dbterm-cancel:")?;
    let tok: String = sql[i + "dbterm-cancel:".len()..]
        .chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if tok.is_empty() { None } else { Some(tok) }
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

/// 检测 SQL 中是否已含 FETCH FIRST/NEXT 或 ROWNUM 子句（Oracle 分页语法）。
fn has_fetch_clause(sql: &str) -> bool {
    let upper = sql.to_uppercase();
    upper.contains("FETCH FIRST") || upper.contains("FETCH NEXT") || upper.contains("ROWNUM")
}

/// 检测 SQL 中是否已含 LIMIT 子句（按词边界匹配，避免误判字符串字面量中的 "LIMIT"）。
fn has_limit_clause(sql: &str) -> bool {
    let upper = sql.to_uppercase();
    let bytes = upper.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    while i + 5 <= n {
        if bytes[i..i+5] == *b"LIMIT" {
            let before_ok = i == 0 || !(bytes[i-1].is_ascii_alphanumeric() || bytes[i-1] == b'_');
            let after_ok  = i + 5 >= n || !(bytes[i+5].is_ascii_alphanumeric() || bytes[i+5] == b'_');
            if before_ok && after_ok { return true; }
        }
        i += 1;
    }
    false
}

fn has_sqlserver_row_limit(sql: &str) -> bool {
    let upper = strip_leading_comments(sql).to_uppercase();
    upper.starts_with("SELECT TOP ")
        || upper.starts_with("SELECT DISTINCT TOP ")
        || upper.contains(" FETCH NEXT ")
        || upper.contains(" FETCH FIRST ")
        || upper.contains(" OFFSET ")
}

fn apply_sqlserver_row_limit(sql: &str, row_limit: Option<u64>) -> (String, bool) {
    let Some(lim) = row_limit else { return (sql.to_string(), false) };
    if lim == 0 || !is_query_stmt(sql) || has_sqlserver_row_limit(sql) {
        return (sql.to_string(), false);
    }

    let base = sql.trim_end().trim_end_matches(';').trim_end();
    let rest = strip_leading_comments(base);
    let prefix_len = base.len().saturating_sub(rest.len());
    let upper = rest.to_uppercase();
    let insert_at = if upper.starts_with("SELECT DISTINCT ") {
        Some("SELECT DISTINCT".len())
    } else if upper.starts_with("SELECT ") {
        Some("SELECT".len())
    } else {
        None
    };

    if let Some(pos) = insert_at {
        let abs = prefix_len + pos;
        let mut out = String::with_capacity(base.len() + 16);
        out.push_str(&base[..abs]);
        out.push_str(&format!(" TOP {lim}"));
        out.push_str(&base[abs..]);
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

// ── dispatch ──────────────────────────────────────────────────────────────────

pub(crate) async fn dispatch_query(
    config: &ConnConfig,
    password: Option<&str>,
    sql: &str,
) -> Result<QueryResult, String> {
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_query(config, password, sql).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_query(config, password, sql).await
        }
        ConnType::Sqlite => {
            let conn = sqlite_open(config).await?;
            sqlite_query_conn(conn, sql).await
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
    let cfg = DbConnCfg::from_config(config);
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
    let cfg = DbConnCfg::from_config(config);
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
    use super::{has_mysql_user_variable, needs_text_protocol};

    #[test]
    fn mysql_user_prepared_statement_commands_use_text_protocol() {
        assert!(needs_text_protocol(r#"PREPARE stmt FROM "SELECT 1 LIMIT 1""#));
        assert!(needs_text_protocol("EXECUTE stmt"));
        assert!(needs_text_protocol("DEALLOCATE PREPARE stmt"));
        assert!(needs_text_protocol("DROP PREPARE stmt"));
        assert!(needs_text_protocol("/* dbterm-cancel:abc123 */ PREPARE stmt FROM 'SELECT 1'"));
        assert!(needs_text_protocol("SET @sql = 'SELECT 1'; PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt"));
    }

    #[test]
    fn mysql_user_variables_ignore_strings_and_comments() {
        assert!(has_mysql_user_variable("SET @x := 1"));
        assert!(has_mysql_user_variable("SELECT @x"));
        assert!(!has_mysql_user_variable("SELECT 'a@b'"));
        assert!(!has_mysql_user_variable("-- @x\nSELECT 1"));
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
    start: Instant,
) -> futures::future::BoxFuture<'static, Result<QueryResult, String>> {
    Box::pin(async move {
        use sqlx::{Column, Executor, Row};
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            (&mut conn)
                .execute(sqlx::raw_sql(&format!("USE `{}`", db.replace('`', ""))))
                .await
                .map_err(|e| format!("切换数据库失败: {e}"))?;
        }
        let rows = (&mut conn)
            .fetch_all(sqlx::raw_sql(&tagged_sql))
            .await
            .map_err(|e| format!("执行失败: {e}"))?;
        let columns = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
        let data = rows.iter()
            .map(|r| (0..r.columns().len()).map(|i| mysql_cell(r, i)).collect())
            .collect();
        Ok(QueryResult {
            columns, rows: data,
            rows_affected: rows.len() as u64,
            execution_time_ms: start.elapsed().as_millis() as u64,
            truncated: false, is_select: true,
        })
    })
}

async fn mysql_query(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<QueryResult, String> {
    use sqlx::{Column, Row};
    let tagged = tag_sql(sql);
    // 复用池连接：跳过每次重建 TCP+SSH 握手，首次执行后速度显著提升。
    let pool = mysql_pool(config, password).await?;

    // Commands like CHECK/ANALYZE/OPTIMIZE/REPAIR TABLE don't work with prepared
    // statements (MySQL error 1295). Use raw_sql (text protocol) for them.
    if needs_text_protocol(sql) {
        let conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?.detach();
        let start = Instant::now();
        return mysql_admin_query(conn, None, tagged, config.database.clone(), start).await;
    }

    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    // 池连接按 config.id 缓存，但用户可能切换了 schema，每次确保 USE 到正确数据库。
    // USE 属于 DDL-like 命令，必须走文本协议（raw_sql），不能用 prepared statement（MySQL 1295）。
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        use sqlx::Executor;
        (&mut *conn).execute(sqlx::raw_sql(&format!("USE `{}`", db.replace('`', ""))))
            .await.map_err(|e| format!("切换数据库失败: {e}"))?;
    }
    // 池连接已就绪，计时从这里开始（不含握手）
    let start = Instant::now();

    // 取消：登记中止通道（停止时 drop PoolConnection → socket 关闭 → 服务端中止查询）
    // + 登记 CONNECTION_ID（取消时尝试服务端 KILL，多节点下不保证同节点但失败可忽略）
    let token = extract_cancel_token(sql);
    let abort_rx = token.as_ref().map(|t| abort_register(t));
    if let Some(ref t) = token {
        if let Ok(row) = sqlx::query("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await {
            let cid = row.try_get::<u64, _>(0).map(|v| v as i64)
                .or_else(|_| row.try_get::<i64, _>(0)).unwrap_or(0);
            if cid != 0 { pid_register(t, cid); }
        }
    }

    let run = async {
        if is_query_stmt(sql) {
            let rows = sqlx::query(&tagged).fetch_all(&mut *conn).await
                .map_err(|e| format!("查询失败: {e}"))?;
            // 即使 0 行也要拿列名：先从首行取，取不到则用 describe（防止 0 行丢失列头）
            let columns: Vec<String> = if let Some(first) = rows.first() {
                first.columns().iter().map(|c| c.name().to_string()).collect()
            } else {
                use sqlx::Executor;
                (&mut *conn).describe(&tagged).await
                    .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default()
            };
            let data = rows.iter()
                .map(|r| (0..r.columns().len()).map(|i| mysql_cell(r, i)).collect())
                .collect();
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
            // 取消：drop conn → PoolConnection 检测到查询中途 → socket 关闭并从池中驱逐
            _ = rx => Err("查询已取消".to_string()),
        }
    } else {
        run.await
    };

    if let Some(ref t) = token { abort_unregister(t); pid_unregister(t); }
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

async fn pg_query(config: &ConnConfig, password: Option<&str>, sql: &str) -> Result<QueryResult, String> {
    use sqlx::{Column, Row};
    let tagged = tag_sql(sql);
    // 复用池连接：跳过每次重建 TCP+SSH 握手
    let pool = pg_pool(config, password).await?;
    let mut conn = pool.acquire().await.map_err(|e| format!("获取连接失败: {e}"))?;
    let start = Instant::now();

    // 取消：登记中止通道 + backend pid（停止时 drop PoolConnection → socket 关闭 + 尝试 pg_cancel_backend）
    let token = extract_cancel_token(sql);
    let abort_rx = token.as_ref().map(|t| abort_register(t));
    if let Some(ref t) = token {
        if let Ok(row) = sqlx::query("SELECT pg_backend_pid()").fetch_one(&mut *conn).await {
            let pid: i32 = row.try_get(0).unwrap_or(0);
            if pid != 0 { pid_register(t, pid as i64); }
        }
    }

    let run = async {
        if is_query_stmt(sql) {
            let rows = sqlx::query(&tagged).fetch_all(&mut *conn).await
                .map_err(|e| format!("查询失败: {e}"))?;
            let columns: Vec<String> = if let Some(first) = rows.first() {
                first.columns().iter().map(|c| c.name().to_string()).collect()
            } else {
                use sqlx::Executor;
                (&mut *conn).describe(&tagged).await
                    .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default()
            };
            let data = rows.iter()
                .map(|r| (0..r.columns().len()).map(|i| pg_cell(r, i)).collect())
                .collect();
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
            _ = rx => Err("查询已取消".to_string()),
        }
    } else {
        run.await
    };

    if let Some(ref t) = token { abort_unregister(t); pid_unregister(t); }
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

async fn sqlite_query_conn(mut conn: sqlx::sqlite::SqliteConnection, sql: &str) -> Result<QueryResult, String> {
    use sqlx::{Column, Row};
    let start = Instant::now();
    let token = extract_cancel_token(sql);
    let abort_rx = token.as_ref().map(|t| abort_register(t));

    let run = async {
        if is_query_stmt(sql) {
            let rows = sqlx::query(sql)
                .fetch_all(&mut conn)
                .await
                .map_err(|e| format!("查询失败: {e}"))?;
            let columns = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows.iter()
                .map(|r| (0..r.columns().len()).map(|i| sqlite_cell(r, i)).collect())
                .collect();
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
            _ = rx => Err("查询已取消".to_string()),
        }
    } else {
        run.await
    };

    if let Some(ref t) = token { abort_unregister(t); }
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
