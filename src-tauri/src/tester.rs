use std::time::{Duration, Instant};
use crate::models::{ConnConfig, ConnType, TestResult};

/// 从 extraJson 里取 SSL + SSH 隧道所需字段（与前端 DbExtra 对应）
#[derive(serde::Deserialize, Default)]
struct DbExtraCfg {
    // SSL
    #[serde(rename = "sslMode",  default)] ssl_mode: String,
    #[serde(rename = "sslCa",   default)] ssl_ca:   String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    // SSH Tunnel
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] ssh_host:      String,
    #[serde(rename = "sshPort",     default)] ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path:  String,
}

/// 展开路径中的 ~ (HOME)
pub fn expand_home(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(p)
}

/// 对外接口：测试任意类型连接
pub async fn test(config: &ConnConfig, password: Option<&str>) -> TestResult {
    let start = Instant::now();

    let result: Result<String, String> = match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            test_mysql(config, password).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            test_postgres(config, password).await
        }
        ConnType::Sqlite => test_sqlite(config).await,
        ConnType::Redis => test_redis(config, password).await,
        ConnType::ClickHouse => {
            crate::commands::clickhouse::test(config, password).await
        }
        ConnType::Ssh => {
            let result = crate::ssh::exec_command(config, password, "echo ok").await;
            return match result {
                Ok(_) => TestResult {
                    success: true,
                    message: "SSH 认证成功，连接正常".to_string(),
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                },
                Err(e) => TestResult {
                    success: false,
                    message: e,
                    latency_ms: Some(start.elapsed().as_millis() as u64),
                },
            };
        }
        ConnType::Mongodb => {
            test_mongo(config, password).await
        }
        ConnType::Duckdb => {
            return TestResult {
                success: false,
                message: "DuckDB 请先在\"驱动管理\"标签下载 libduckdb，然后使用连接测试".to_string(),
                latency_ms: None,
            };
        }
        ConnType::SqlServer => {
            crate::commands::sqlserver::test_connection(config, password).await
        }
        ConnType::Oracle => {
            // Oracle 连接测试由 commands/db.rs 的 Oracle 分支提前处理，不应到达此处
            return TestResult {
                success: false,
                message: "Oracle 连接测试请通过「驱动管理」下载 Instant Client 后重试".to_string(),
                latency_ms: None,
            };
        }
        ConnType::Local => {
            let shell_path = config.host.clone().unwrap_or_default();
            let shell_path = if shell_path.is_empty() {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
            } else {
                match shell_path.as_str() {
                    "bash" => "/bin/bash".into(),
                    "zsh"  => "/bin/zsh".into(),
                    other  => other.into(),
                }
            };
            return if std::path::Path::new(&shell_path).exists() {
                TestResult { success: true, message: format!("Shell 可用: {shell_path}"), latency_ms: None }
            } else {
                TestResult { success: false, message: format!("Shell 未找到: {shell_path}"), latency_ms: None }
            };
        }
    };

    let latency = start.elapsed().as_millis() as u64;
    match result {
        Ok(msg) => TestResult { success: true, message: msg, latency_ms: Some(latency) },
        Err(e) => TestResult { success: false, message: e, latency_ms: Some(latency) },
    }
}

async fn test_mongo(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    use mongodb::{Client, options::ClientOptions};
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(27017);
    let uri = match (&config.username, password) {
        (Some(u), Some(p)) if !u.is_empty() => {
            format!("mongodb://{}:{}@{}:{}/",
                urlencoding::encode(u), urlencoding::encode(p), host, port)
        }
        _ => format!("mongodb://{}:{}/", host, port),
    };
    let opts = ClientOptions::parse(&uri).await
        .map_err(|e| format!("URI 解析失败: {e}"))?;
    let client = Client::with_options(opts)
        .map_err(|e| format!("客户端初始化失败: {e}"))?;
    client.database("admin")
        .run_command(bson::doc! { "ping": 1 }).await
        .map_err(|e| format!("MongoDB 连接失败: {e}"))?;
    Ok(format!("MongoDB 连接成功 ({}:{})", host, port))
}

async fn test_mysql(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    use sqlx::ConnectOptions;
    use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
    use crate::commands::query::MySqlPwdExt;
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};

    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(3306);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let extra: DbExtraCfg = config.extra_json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // ── SSH 隧道（如果启用，先建隧道，连接改到本地端口）──
    let _tunnel: Option<DbTunnel>;
    let (conn_host, conn_port) = if extra.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host:      extra.ssh_host.clone(),
            port:      extra.ssh_port,
            user:      extra.ssh_user.clone(),
            auth_type: extra.ssh_auth_type.clone(),
            password:  extra.ssh_password.clone(),
            key_path:  extra.ssh_key_path.clone(),  // ~ 展开统一在 DbTunnel::open 内处理
        };
        let t = DbTunnel::open(&tcfg, host, port).await?;
        let p = t.local_port;
        _tunnel = Some(t);
        ("127.0.0.1".to_string(), p)
    } else {
        _tunnel = None;
        (host.to_string(), port)
    };

    // ── 构建连接选项（含 SSL）──────────────────────────────
    let mut opts = MySqlConnectOptions::new()
        .host(&conn_host).port(conn_port).username(user).password_opt(pwd);

    if !db.is_empty() { opts = opts.database(db); }

    opts = opts.ssl_mode(match extra.ssl_mode.as_str() {
        "require"     => MySqlSslMode::Required,
        "verify-ca"   => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _             => MySqlSslMode::Disabled,
    });
    if !extra.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&extra.ssl_ca)); }
    if !extra.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&extra.ssl_cert)); }
    if !extra.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&extra.ssl_key)); }

    let fut = opts.connect();
    let mut conn = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .map_err(|_| "连接超时（10 秒）".to_string())?
        .map_err(|e| friendly_err(e))?;

    sqlx::query("SELECT 1").execute(&mut conn).await
        .map_err(|e| format!("测试查询失败: {e}"))?;

    let mut notes = Vec::new();
    if extra.ssh_tunnel   { notes.push("SSH 隧道"); }
    if extra.ssl_mode != "disabled" && !extra.ssl_mode.is_empty() {
        notes.push(&extra.ssl_mode);
    }
    Ok(if notes.is_empty() { "连接成功".to_string() }
       else { format!("连接成功（{}）", notes.join("  ·  ")) })
}

async fn test_postgres(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    use sqlx::ConnectOptions;
    use sqlx::postgres::{PgConnectOptions, PgSslMode};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};

    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(5432);
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let extra: DbExtraCfg = config.extra_json.as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // ── SSH 隧道 ──────────────────────────────────────────
    let _tunnel: Option<DbTunnel>;
    let (conn_host, conn_port) = if extra.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host:      extra.ssh_host.clone(),
            port:      extra.ssh_port,
            user:      extra.ssh_user.clone(),
            auth_type: extra.ssh_auth_type.clone(),
            password:  extra.ssh_password.clone(),
            key_path:  extra.ssh_key_path.clone(),  // ~ 展开统一在 DbTunnel::open 内处理
        };
        let t = DbTunnel::open(&tcfg, host, port).await?;
        let p = t.local_port;
        _tunnel = Some(t);
        ("127.0.0.1".to_string(), p)
    } else {
        _tunnel = None;
        (host.to_string(), port)
    };

    // ── 构建连接选项（含 SSL）──────────────────────────────
    let mut opts = PgConnectOptions::new()
        .host(&conn_host).port(conn_port).username(user).password(pwd).database(db);

    opts = opts.ssl_mode(match extra.ssl_mode.as_str() {
        "require"     => PgSslMode::Require,
        "verify-ca"   => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _             => PgSslMode::Disable,
    });
    if !extra.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&extra.ssl_ca)); }
    if !extra.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&extra.ssl_cert)); }
    if !extra.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&extra.ssl_key)); }

    let fut = opts.connect();
    let mut conn = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .map_err(|_| "连接超时（10 秒）".to_string())?
        .map_err(|e| friendly_err(e))?;

    sqlx::query("SELECT 1").execute(&mut conn).await
        .map_err(|e| format!("测试查询失败: {e}"))?;

    let mut notes = Vec::new();
    if extra.ssh_tunnel { notes.push("SSH 隧道"); }
    if extra.ssl_mode != "disabled" && !extra.ssl_mode.is_empty() {
        notes.push(&extra.ssl_mode);
    }
    Ok(if notes.is_empty() { "连接成功".to_string() }
       else { format!("连接成功（{}）", notes.join("  ·  ")) })
}

async fn test_sqlite(config: &ConnConfig) -> Result<String, String> {
    use sqlx::Connection;

    let path = config.file_path.as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;

    let url = format!("sqlite://{path}");
    let fut = sqlx::sqlite::SqliteConnection::connect(&url);
    let mut conn = tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .map_err(|_| "打开文件超时".to_string())?
        .map_err(|e| format!("打开数据库失败: {e}"))?;

    sqlx::query("SELECT 1")
        .execute(&mut conn)
        .await
        .map_err(|e| format!("测试查询失败: {e}"))?;

    Ok("连接成功".to_string())
}

async fn test_redis(config: &ConnConfig, password: Option<&str>) -> Result<String, String> {
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(6379);
    // database 字段用于 Redis DB 编号（0-15）
    let db_num = config.database.as_deref().unwrap_or("0");

    let url = match password.filter(|p| !p.is_empty()) {
        Some(pwd) => format!("redis://:{}@{}:{}/{}", encode(pwd), host, port, db_num),
        None      => format!("redis://{}:{}/{}", host, port, db_num),
    };

    let client = redis::Client::open(url.as_str())
        .map_err(|e| format!("Redis URL 无效: {e}"))?;

    let fut = client.get_multiplexed_async_connection();
    let mut conn = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .map_err(|_| "连接超时（10 秒）".to_string())?
        .map_err(|e| friendly_err(e))?;

    let pong: String = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| format!("PING 失败: {e}"))?;

    if pong.to_uppercase() != "PONG" {
        return Err(format!("服务端响应异常: {pong}"));
    }

    Ok("连接成功".to_string())
}

/// 对特殊字符进行百分比编码（用于 URL 中的用户名/密码）
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            b => {
                use std::fmt::Write;
                write!(out, "%{b:02X}").unwrap();
            }
        }
    }
    out
}


/// 过滤错误信息中可能包含的密码（仅处理 URL 格式 scheme://user:password@host）
fn mask_pwd(msg: String) -> String {
    // 只有包含 :// 的 URL 格式才可能在 @ 前含密码；
    // "ProxySQL Error:user@host" 之类的错误信息不应被误脱敏
    if !msg.contains("://") { return msg }
    if let Some(at) = msg.find('@') {
        if let Some(colon) = msg[..at].rfind(':') {
            // 确保冒号前不是 scheme 末尾（即 :// 不算密码分隔）
            let after_colon = &msg[colon + 1..];
            if after_colon.starts_with("//") { return msg }
            let before = &msg[..colon + 1];
            let after  = &msg[at..];
            return format!("{before}[已隐藏]{after}");
        }
    }
    msg
}

/// 将常见英文数据库错误转成可读的中文提示
fn friendly_err(e: impl std::fmt::Display) -> String {
    let s = mask_pwd(e.to_string());
    // TCP 连接被拒绝
    if s.contains("Connection refused") || s.contains("os error 61") || s.contains("os error 111") {
        return "连接被拒绝：目标主机拒绝了 TCP 连接。\n请确认：① 数据库服务已启动  ② 端口号正确  ③ 防火墙已放行该端口".to_string();
    }
    // 连接超时（网络不可达）
    if s.contains("timed out") || s.contains("os error 110") || s.contains("os error 60") || s.contains("ETIMEDOUT") {
        return "连接超时：无法到达目标主机。\n请确认：① IP 地址正确  ② 网络可达  ③ 防火墙/安全组已放行".to_string();
    }
    // 认证失败
    if s.contains("Access denied") || s.contains("access denied") || s.contains("password") && s.contains("denied") {
        return "认证失败：用户名或密码错误，或该用户没有从当前 IP 连接的权限".to_string();
    }
    // 主机名解析失败
    if s.contains("No such host") || s.contains("Name or service not known")
        || s.contains("nodename nor servname") || s.contains("failed to lookup") {
        return "主机名无法解析：请检查主机地址是否拼写正确，或改用 IP 直连".to_string();
    }
    // 数据库不存在
    if s.contains("Unknown database") {
        let db = s.split('\'').nth(1).unwrap_or("?");
        return format!("数据库「{db}」不存在，请填写已存在的数据库名或留空");
    }
    // SSL 相关
    if s.contains("SSL") || s.contains("TLS") || s.contains("certificate") {
        return format!("SSL/TLS 握手失败：{s}");
    }
    // ProxySQL / 连接池错误
    if s.contains("hostgroup") || s.contains("Max connect timeout") {
        return format!("ProxySQL 无法路由到后端数据库（hostgroup 超时）：{s}");
    }
    s
}
