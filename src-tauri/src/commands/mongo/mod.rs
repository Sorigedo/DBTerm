// MongoDB 命令域 — 完全隔离，不碰 SQL 侧 / SSH 侧
// MO0: 连接层（Client 缓存 + 认证 + SSH 隧道）
// MO1: 库/集合浏览
// MO2: 文档查看与编辑
// MO6: 监控（serverStatus / currentOp）

pub mod browse;
pub mod crud;
pub mod admin;
pub mod aggregate;
pub mod index;
pub mod transfer;
pub mod security;
pub mod inspect;
pub mod schema;
pub mod tx;
pub mod gridfs;
pub mod stream;

use std::{collections::HashMap, sync::Arc};
use mongodb::{Client, options::{AuthMechanism, ClientOptions, Credential, Tls, TlsOptions}};
use serde::Deserialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::{models::ConnConfig, storage::StorageState};

/// MongoDB 连接池：conn_id → mongodb::Client（自带内置连接池）
pub type MongoPool = Arc<Mutex<HashMap<String, MongoEntry>>>;

pub struct MongoEntry {
    pub client: Client,
    /// 保持 SSH 隧道存活（若经隧道连接）
    pub _tunnel: Option<Arc<crate::db_tunnel::DbTunnel>>,
}

/// MongoDB 额外配置（存于 ConnConfig.extra_json）
#[derive(Deserialize, Default)]
#[allow(dead_code)]
pub struct MongoConnCfg {
    // 连接串模式
    #[serde(rename = "mongoUri", default)]
    pub mongo_uri: String,
    // 认证
    #[serde(rename = "authSource",    default)] pub auth_source:    String,
    #[serde(rename = "authMechanism", default)] pub auth_mechanism: String,
    // TLS
    #[serde(rename = "tlsCaFile",   default)] pub tls_ca_file:   String,
    #[serde(rename = "tlsCertFile", default)] pub tls_cert_file: String,
    #[serde(rename = "tlsKeyFile",  default)] pub tls_key_file:  String,
    // 显式「接受无效/自签证书」开关，默认关闭——否则启 TLS 即等于无校验，等同明文可被中间人
    #[serde(rename = "tlsAllowInvalid", default)] pub tls_allow_invalid: bool,
    // SSH 隧道
    #[serde(rename = "sshTunnel",   default)] pub ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] pub ssh_host:      String,
    #[serde(rename = "sshPort",     default)] pub ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] pub ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] pub ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] pub ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] pub ssh_key_path:  String,
    // 读偏好
    #[serde(rename = "readPreference", default)] pub read_preference: String,
}

impl MongoConnCfg {
    pub fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
}

/// 获取或创建 MongoDB 客户端（带缓存）
pub async fn get_client(
    conn_id: &str,
    pool: &MongoPool,
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<Client, String> {
    {
        let guard = pool.lock().await;
        if let Some(e) = guard.get(conn_id) {
            return Ok(e.client.clone());
        }
    }

    let cfg = MongoConnCfg::from_config(config);
    let tunnel_arc: Option<Arc<crate::db_tunnel::DbTunnel>>;

    // SSH 隧道
    let (host, port) = if cfg.ssh_tunnel {
        let tcfg = crate::db_tunnel::DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.ssh_password.clone(), key_path: cfg.ssh_key_path.clone(),
        };
        let t = crate::db_tunnel::DbTunnel::open_shared(
            conn_id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(27017),
        ).await?;
        let lp = t.local_port;
        tunnel_arc = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel_arc = None;
        (
            config.host.clone().unwrap_or_else(|| "127.0.0.1".to_string()),
            config.port.unwrap_or(27017),
        )
    };

    // 构建连接 URI
    let uri = if !cfg.mongo_uri.is_empty() {
        cfg.mongo_uri.clone()
    } else {
        let user = config.username.as_deref().unwrap_or("");
        let pwd  = password.unwrap_or("");
        let auth_src = if cfg.auth_source.is_empty() { "admin" } else { &cfg.auth_source };
        let db   = config.database.as_deref().filter(|s| !s.is_empty()).unwrap_or(auth_src);
        // SSH 隧道时加 directConnection=true，避免驱动尝试发现副本集拓扑
        let direct = if cfg.ssh_tunnel { "&directConnection=true" } else { "" };
        if user.is_empty() {
            format!("mongodb://{}:{}/{}?{}", host, port, db, direct.trim_start_matches('&'))
        } else {
            let enc_user = urlencoding::encode(user);
            let enc_pwd  = urlencoding::encode(pwd);
            format!("mongodb://{}:{}@{}:{}/{}?authSource={}{}", enc_user, enc_pwd, host, port, db, auth_src, direct)
        }
    };

    let mut client_opts = ClientOptions::parse(&uri).await
        // 不回显 {e}：解析错误信息会带上含 user:password@host 的完整 URI，避免密码泄漏到前端/日志
        .map_err(|_| "MongoDB 连接串解析失败，请检查主机/端口/用户名/认证库等配置".to_string())?;
    // 限制每个连接的最大 socket 数（默认 ~100）：多连接/多窗口下避免服务端连接数暴增
    client_opts.max_pool_size = Some(10);
    client_opts.min_pool_size = Some(0);

    // MO0.3 TLS 配置
    let tls_enabled = !cfg.tls_ca_file.is_empty() || !cfg.tls_cert_file.is_empty();
    if tls_enabled {
        let mut tls_opts = TlsOptions::builder().build();
        if !cfg.tls_ca_file.is_empty() {
            tls_opts.ca_file_path = Some(std::path::PathBuf::from(&cfg.tls_ca_file));
        }
        if !cfg.tls_cert_file.is_empty() {
            tls_opts.cert_key_file_path = Some(std::path::PathBuf::from(&cfg.tls_cert_file));
        }
        // 默认校验服务端证书（用 ca_file 验证自签链）；仅在用户显式勾选时才放宽
        if cfg.tls_allow_invalid {
            tls_opts.allow_invalid_certificates = Some(true);
        }
        client_opts.tls = Some(Tls::Enabled(tls_opts));
    }

    // MO0.3 认证机制（x.509）
    if cfg.auth_mechanism == "MONGODB-X509" {
        let cred = Credential::builder()
            .mechanism(AuthMechanism::MongoDbX509)
            .build();
        client_opts.credential = Some(cred);
    } else if cfg.auth_mechanism == "SCRAM-SHA-256" {
        if let Some(cred) = client_opts.credential.as_mut() {
            cred.mechanism = Some(AuthMechanism::ScramSha256);
        }
    } else if cfg.auth_mechanism == "SCRAM-SHA-1" {
        if let Some(cred) = client_opts.credential.as_mut() {
            cred.mechanism = Some(AuthMechanism::ScramSha1);
        }
    }

    let client = Client::with_options(client_opts)
        .map_err(|e| format!("创建 MongoDB 客户端失败: {e}"))?;

    // 连通性验证
    client.database("admin")
        .run_command(bson::doc! { "ping": 1 }).await
        .map_err(|e| format!("MongoDB 连接失败: {e}"))?;

    let entry = MongoEntry { client: client.clone(), _tunnel: tunnel_arc };
    pool.lock().await.insert(conn_id.to_string(), entry);
    Ok(client)
}

/// 列出 MongoDB 全部数据库名，供资产树「自动获取数据库列表」使用。
pub async fn list_db_schemas(
    id: &str,
    pool: &State<'_, MongoPool>,
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<Vec<String>, String> {
    let client = get_client(id, pool, config, password).await?;
    let dbs = client.list_databases().await
        .map_err(|e| format!("列出数据库失败: {e}"))?;
    Ok(dbs.into_iter().map(|d| d.name).collect())
}

// ── 公共辅助：从 StorageState 读取连接配置和密码 ─────────────────────────

pub fn load_conn(id: &str, storage: &StorageState) -> Result<(ConnConfig, Option<String>), String> {
    let guard = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = guard.load()?;
    let config = list.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接 {id} 不存在"))?;
    drop(guard);
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// Tauri 命令：断开 MongoDB 连接（从缓存移除，关闭隧道）
#[tauri::command]
pub async fn mongo_disconnect(
    id: String,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    pool.lock().await.remove(&id);
    Ok(())
}

/// Tauri 命令：测试 MongoDB 连接
#[tauri::command]
pub async fn mongo_test(
    config: ConnConfig,
    password: Option<String>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let client = get_client(&config.id, &pool, &config, password.as_deref()).await?;
    let info = client.database("admin")
        .run_command(bson::doc! { "buildInfo": 1 }).await
        .map_err(|e| format!("MongoDB 连接测试失败: {e}"))?;
    let version = info.get_str("version").unwrap_or("未知版本");
    Ok(format!("MongoDB {version} 连接成功"))
}
