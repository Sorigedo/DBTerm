//! DB 能力探测（MA0.2 / PG0.2 / CH0.3）
//!
//! 连接后读取 VERSION() 等轻量信息，解析为能力位图供前端显隐专属功能。
//! 安全：全部为只读 SELECT / SHOW，不执行任何写操作。

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{
    models::{ConnConfig, ConnType},
    storage::StorageState,
};

// ── 扩展连接配置（与前端 DbExtra 对应，与其他命令文件保持一致）─────────────────

#[derive(serde::Deserialize, Default)]
struct DbConnCfg {
    #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
    #[serde(rename = "sslMode",  default)] ssl_mode:  String,
    #[serde(rename = "sslCa",   default)] ssl_ca:    String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:   bool,
    #[serde(rename = "sshHost",     default)] ssh_host:     String,
    #[serde(rename = "sshPort",     default)] ssh_port:     u16,
    #[serde(rename = "sshUser",     default)] ssh_user:     String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password: String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path: String,
}
impl DbConnCfg {
    fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            if self.connect_timeout == 0 { 15 } else { self.connect_timeout.clamp(3, 60) }
        )
    }
}

// ── 能力结构体 ────────────────────────────────────────────────────────────────

/// 连接后探测到的数据库能力位图，供前端按类型显隐功能。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbCapabilities {
    /// 版本字符串（原始）
    pub version_str: String,
    /// 数据库类型标识：mysql | mariadb | tidb | oceanbase | postgres | kingbase | opengauss | clickhouse | sqlite
    pub db_flavor: String,
    pub version_major: u32,
    pub version_minor: u32,
    pub version_patch: u32,

    // ── MySQL / MariaDB 家族 ─────────────────────────────────────────────────
    /// 是否 MariaDB（VERSION() 含 MariaDB 字样）
    pub is_maria_db: bool,
    /// 是否 TiDB（VERSION() 含 TiDB 字样）
    pub is_ti_db: bool,
    /// 是否 OceanBase（VERSION() 含 OceanBase 字样）
    pub is_ocean_base: bool,
    /// 序列（MariaDB 10.3+）
    pub has_sequences: bool,
    /// 系统版本化表（MariaDB 10.3.4+）
    pub has_system_versioning: bool,
    /// INVISIBLE 列（MariaDB 10.3+）
    pub has_invisible_columns: bool,
    /// Galera 集群（wsrep_on = ON）
    pub has_galera: bool,
    /// performance_schema 可用
    pub has_performance_schema: bool,
    /// MGR / 半同步（MySQL 5.7+）
    pub has_mgr_replication: bool,

    // ── PostgreSQL 家族 ──────────────────────────────────────────────────────
    /// 人大金仓（KingBase）
    pub is_king_base: bool,
    /// openGauss
    pub is_open_gauss: bool,
    /// server_version_num（如 140002 = PG14.0.2）
    pub server_version_num: u32,
    /// pg_stat_statements 扩展已安装
    pub has_pg_stat_statements: bool,
    /// 声明式分区（PG10+）
    pub has_declarative_partitioning: bool,
    /// 逻辑复制（PG10+）
    pub has_logical_replication: bool,
    /// 并行 VACUUM（PG13+）
    pub has_parallel_vacuum: bool,
    /// MERGE 语句（PG15+）
    pub has_merge: bool,

    // ── ClickHouse ───────────────────────────────────────────────────────────
    /// async_insert（CH 21.11+）
    pub has_async_insert: bool,
    /// Projection（CH 21.6+）
    pub has_projections: bool,
    /// Lightweight DELETE（CH 22.8+）
    pub has_lightweight_delete: bool,
    /// 是否为集群模式（system.clusters 可查到非空 cluster）
    pub ch_is_cluster: bool,
}

// ── 版本解析工具 ──────────────────────────────────────────────────────────────

/// 从 VERSION() 字符串中提取第一组 X.Y.Z，例：
/// "10.11.4-MariaDB" → (10, 11, 4)
/// "8.0.35" → (8, 0, 35)
fn parse_semver(s: &str) -> (u32, u32, u32) {
    let nums: Vec<u32> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|t| !t.is_empty())
        .take(3)
        .map(|t| t.parse().unwrap_or(0))
        .collect();
    (
        nums.first().copied().unwrap_or(0),
        nums.get(1).copied().unwrap_or(0),
        nums.get(2).copied().unwrap_or(0),
    )
}

fn version_ge(major: u32, minor: u32, patch: u32, req_maj: u32, req_min: u32, req_pat: u32) -> bool {
    (major, minor, patch) >= (req_maj, req_min, req_pat)
}

// ── 各方言探测函数 ────────────────────────────────────────────────────────────

async fn detect_mysql_caps(config: &ConnConfig, password: Option<&str>) -> Result<DbCapabilities, String> {
    use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions, MySqlSslMode}, Row};
    use crate::commands::query::MySqlPwdExt;
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
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

    // 读取版本
    let version_str: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&mut conn)
        .await
        .unwrap_or_else(|_| "unknown".to_string());

    let lower = version_str.to_lowercase();
    let is_mariadb   = lower.contains("mariadb");
    let is_tidb      = lower.contains("tidb");
    let is_oceanbase = lower.contains("oceanbase");

    let (maj, min, pat) = parse_semver(&version_str);

    // MariaDB 能力（按版本推算，不再发额外查询）
    let has_sequences         = is_mariadb && version_ge(maj, min, pat, 10, 3, 0);
    let has_system_versioning = is_mariadb && version_ge(maj, min, pat, 10, 3, 4);
    let has_invisible_columns = is_mariadb && version_ge(maj, min, pat, 10, 3, 0);

    // Galera 检测：只读查询，失败则视为无 Galera
    let has_galera = {
        let row = sqlx::query("SHOW GLOBAL STATUS LIKE 'wsrep_on'")
            .fetch_optional(&mut conn)
            .await
            .unwrap_or(None);
        row.and_then(|r| r.try_get::<String, _>(1).ok())
            .map(|v| v.eq_ignore_ascii_case("on") || v.eq_ignore_ascii_case("1"))
            .unwrap_or(false)
    };

    // performance_schema 可用性（SHOW VARIABLES 兼容所有 MySQL 5.6+ / MariaDB 版本）
    let has_perf_schema = {
        let row = sqlx::query("SHOW VARIABLES LIKE 'performance_schema'")
            .fetch_optional(&mut conn)
            .await
            .unwrap_or(None);
        row.and_then(|r| r.try_get::<String, _>(1).ok())
            .map(|v| v.eq_ignore_ascii_case("on") || v.eq_ignore_ascii_case("1"))
            .unwrap_or(false)
    };

    // MGR（MySQL 8+）或半同步可用
    let has_mgr = !is_mariadb && !is_tidb && !is_oceanbase && maj >= 8;

    let db_flavor = if is_mariadb { "mariadb" }
        else if is_tidb { "tidb" }
        else if is_oceanbase { "oceanbase" }
        else { "mysql" };

    drop(tunnel);

    Ok(DbCapabilities {
        version_str,
        db_flavor: db_flavor.to_string(),
        version_major: maj,
        version_minor: min,
        version_patch: pat,
        is_maria_db: is_mariadb,
        is_ti_db: is_tidb,
        is_ocean_base: is_oceanbase,
        has_sequences,
        has_system_versioning,
        has_invisible_columns,
        has_galera,
        has_performance_schema: has_perf_schema,
        has_mgr_replication: has_mgr,
        ..Default::default()
    })
}

async fn detect_pg_caps(config: &ConnConfig, password: Option<&str>) -> Result<DbCapabilities, String> {
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
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
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

    // 不在启动参数里设 application_name（兼容 PG 8.x，9.0 之前会拒绝该参数）
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

    // 读版本字符串 + server_version_num
    let version_str: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(&mut conn)
        .await
        .unwrap_or_else(|_| "unknown".to_string());

    let server_version_num: i32 = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut conn)
        .await
        .unwrap_or_else(|_| {
            // 降级：尝试 current_setting
            0i32
        });
    let svn = server_version_num.max(0) as u32;

    let lower = version_str.to_lowercase();
    let is_kingbase  = lower.contains("kingbase") || lower.contains("人大金仓")
        || matches!(config.conn_type, ConnType::KingBase);
    let is_opengauss = lower.contains("opengauss") || lower.contains("gaussdb")
        || matches!(config.conn_type, ConnType::OpenGauss);

    let (maj, min, pat) = parse_semver(&version_str);

    // pg_stat_statements 扩展检测（失败则视为无）
    let has_pss: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pg_extension WHERE extname = 'pg_stat_statements'")
        .fetch_optional(&mut conn)
        .await
        .ok()
        .flatten()
        .map(|n| n > 0)
        .unwrap_or(false);

    // 版本特性门控
    let has_declarative_part = svn >= 100_000;   // PG10+
    let has_logical_rep      = svn >= 100_000;   // PG10+
    let has_parallel_vacuum  = svn >= 130_000;   // PG13+
    let has_merge            = svn >= 150_000;   // PG15+

    let db_flavor = if is_kingbase  { "kingbase" }
        else if is_opengauss { "opengauss" }
        else                 { "postgres" };

    drop(tunnel);

    Ok(DbCapabilities {
        version_str,
        db_flavor: db_flavor.to_string(),
        version_major: maj,
        version_minor: min,
        version_patch: pat,
        is_king_base: is_kingbase,
        is_open_gauss: is_opengauss,
        server_version_num: svn,
        has_pg_stat_statements: has_pss,
        has_declarative_partitioning: has_declarative_part,
        has_logical_replication: has_logical_rep,
        has_parallel_vacuum,
        has_merge,
        ..Default::default()
    })
}

/// ClickHouse 轻量 HTTP 查询（仅用于能力探测，独立实现避免跨模块私有函数依赖）
async fn ch_http_query(config: &ConnConfig, password: Option<&str>, sql: &str) -> Option<serde_json::Value> {
    let host   = config.host.as_deref().unwrap_or("127.0.0.1");
    let port   = config.port.unwrap_or(8123);
    let scheme = if config.use_ssl { "https" } else { "http" };
    let url    = format!("{scheme}://{host}:{port}/");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build().ok()?;
    let mut req = client.post(&url)
        .query(&[("default_format", "JSON")])
        .header("X-ClickHouse-User", config.username.as_deref().unwrap_or("default"));
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        req = req.header("X-ClickHouse-Key", p);
    }
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        req = req.query(&[("database", db)]);
    }
    let resp = req.body(sql.to_string()).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let text = resp.text().await.ok()?;
    serde_json::from_str(&text).ok()
}

async fn detect_ch_caps(config: &ConnConfig, password: Option<&str>) -> Result<DbCapabilities, String> {
    let version_str = ch_http_query(config, password, "SELECT version() AS v")
        .await
        .and_then(|v| v["data"].as_array()?.first()?["v"].as_str().map(String::from))
        .unwrap_or_default();

    let (maj, min, pat) = parse_semver(&version_str);

    let has_projections        = version_ge(maj, min, pat, 21, 6, 0);
    let has_async_insert       = version_ge(maj, min, pat, 21, 11, 0);
    let has_lightweight_delete = version_ge(maj, min, pat, 22, 8, 0);

    let ch_is_cluster = ch_http_query(config, password,
        "SELECT COUNT(*) AS n FROM system.clusters WHERE cluster != ''")
        .await
        .and_then(|v| {
            v["data"].as_array()?.first()?["n"]
                .as_str()?.parse::<u64>().ok()
                .map(|n| n > 0)
        })
        .unwrap_or(false);

    Ok(DbCapabilities {
        version_str,
        db_flavor: "clickhouse".to_string(),
        version_major: maj,
        version_minor: min,
        version_patch: pat,
        has_projections,
        has_async_insert,
        has_lightweight_delete,
        ch_is_cluster,
        ..Default::default()
    })
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

fn load_conn(id: &str, storage: &State<'_, StorageState>) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().map_err(|_| "存储锁失败".to_string())?.load()?;
    let config  = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// 探测数据库能力，供前端缓存并按能力显隐专属功能。
/// 全部为只读查询，绝不修改任何数据。
#[tauri::command]
pub async fn detect_db_caps(
    conn_id: String,
    storage: State<'_, StorageState>,
) -> Result<DbCapabilities, String> {
    let (config, password) = load_conn(&conn_id, &storage)?;
    drop(storage);

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            detect_mysql_caps(&config, password.as_deref()).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            detect_pg_caps(&config, password.as_deref()).await
        }
        ConnType::ClickHouse => {
            detect_ch_caps(&config, password.as_deref()).await
        }
        ConnType::Sqlite => Ok(DbCapabilities {
            db_flavor: "sqlite".to_string(), ..Default::default()
        }),
        ConnType::Redis => Ok(DbCapabilities {
            db_flavor: "redis".to_string(), ..Default::default()
        }),
        _ => Ok(DbCapabilities::default()),
    }
}
