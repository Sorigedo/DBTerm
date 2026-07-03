use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
pub mod sftp;
pub mod tunnel;

use async_trait::async_trait;
use russh::{client, ChannelMsg, Disconnect, Pty};
use russh_keys::key::PublicKey;
use tokio::sync::mpsc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use crate::models::ConnConfig;

// ── SSH 扩展配置（来自 ConnConfig.extra_json） ────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SshEnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SshTunnel {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub tunnel_type: String, // local | remote | dynamic
    #[serde(rename = "bindIP", default)]
    pub bind_ip: String,
    #[serde(rename = "bindPort", default)]
    pub bind_port: u16,
    #[serde(rename = "targetIP", default)]
    pub target_ip: String,
    #[serde(rename = "targetPort", default)]
    pub target_port: u16,
    #[serde(default)]
    pub disabled: bool,
}

/// 额外跳板节点（多跳 ProxyJump 链）
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtraJump {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,  // password | key | agent
    pub key_path: String,
    pub password: String,
}

impl ExtraJump {
    fn effective_port(&self) -> u16 {
        if self.port == 0 { 22 } else { self.port }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SshExtra {
    pub connect_timeout: u64,
    pub heartbeat_interval: u64,
    pub env_vars: Vec<SshEnvVar>,
    pub terminal_type: String,
    pub auth_type: String,           // password | key | mfa | agent | none
    pub proxy_type: String,          // none | http | socks5
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_username: String,
    pub proxy_password: String,
    pub tunnels: Vec<SshTunnel>,
    pub record_log: bool,
    pub enable_sftp: bool,
    pub sftp_sudo: bool,
    pub sftp_command: String,
    pub sftp_default_path: String,
    pub encoding: String,            // UTF-8 | GBK | GB2312 | Latin-1
    pub enable_compression: bool,    // zlib 传输压缩（慢速链路提速）
    pub idle_timeout_minutes: u64,   // 空闲自动断开（分钟，0=不断开）
    pub host_key_policy: String,     // tofu | strict | skip
    // ── 跳板机（ProxyJump）──
    pub jump_enabled: bool,
    pub jump_host: String,
    pub jump_port: u16,
    pub jump_username: String,
    pub jump_auth_type: String,      // password | key | agent
    pub jump_key_path: String,
    pub jump_password: String,       // 跳板机密码 / 密钥口令（与代理密码同样存于 extra_json）
    pub extra_jumps: Vec<ExtraJump>, // 多跳链：第一跳后的额外节点（按顺序）
    // ── Agent 转发 ──
    pub agent_forwarding: bool,
}

impl Default for SshExtra {
    fn default() -> Self {
        Self {
            connect_timeout: 30,
            heartbeat_interval: 30,
            env_vars: Vec::new(),
            terminal_type: "xterm-256color".into(),
            auth_type: "password".into(),
            proxy_type: "none".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
            proxy_password: String::new(),
            tunnels: Vec::new(),
            record_log: false,
            enable_sftp: true,
            sftp_sudo: false,
            sftp_command: String::new(),
            sftp_default_path: String::new(),
            encoding: "UTF-8".into(),
            enable_compression: false,
            idle_timeout_minutes: 0,
            host_key_policy: "tofu".into(),
            jump_enabled: false,
            jump_host: String::new(),
            jump_port: 22,
            jump_username: String::new(),
            jump_auth_type: "password".into(),
            jump_key_path: String::new(),
            jump_password: String::new(),
            extra_jumps: Vec::new(),
            agent_forwarding: false,
        }
    }
}

/// 编码名 → encoding_rs 编码（UTF-8 返回 None 走零开销直通）
fn lookup_encoding(name: &str) -> Option<&'static encoding_rs::Encoding> {
    match name {
        "GBK" | "GB2312" => Some(encoding_rs::GBK),
        "Latin-1"        => Some(encoding_rs::WINDOWS_1252),
        _                => None,
    }
}

/// 流式解码一段远程输出为 UTF-8（解码器跨包维护多字节状态）
fn decode_chunk(decoder: &mut encoding_rs::Decoder, src: &[u8]) -> Vec<u8> {
    let cap = decoder.max_utf8_buffer_length(src.len()).unwrap_or(src.len() * 3 + 4);
    let mut dst = String::with_capacity(cap);
    let _ = decoder.decode_to_string(src, &mut dst, false);
    dst.into_bytes()
}

impl SshExtra {
    pub fn from_config(config: &ConnConfig) -> Self {
        let mut e: SshExtra = config.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        // 凭据落盘加固：代理/跳板密码已迁出 extra_json（明文）→ keychain。
        // extra_json 中为空时回退到 keychain 取（旧连接仍把明文留在 extra_json，原样可用，下次保存时迁移）。
        if e.proxy_password.is_empty() {
            if let Ok(Some(p)) = crate::keychain::get_password(&format!("{}::proxy", config.id)) { e.proxy_password = p; }
        }
        if e.jump_password.is_empty() {
            if let Ok(Some(p)) = crate::keychain::get_password(&format!("{}::jump", config.id)) { e.jump_password = p; }
        }
        e
    }
}

/// 保存 SSH 连接前调用：把 extra_json 里的代理/跳板密码迁入 keychain（Windows DPAPI 加密 + 移出明文配置文件），
/// 并在 extra_json 中置空。语义关键：**仅当字段非空时才迁移并置空**——为空表示「未改动」，
/// 保留 keychain 既有值，从而编辑重存不会误删已存密码（避免丢密码）。
pub fn stash_secrets(config: &mut ConnConfig) -> Result<(), String> {
    let Some(raw) = config.extra_json.as_deref() else { return Ok(()) };
    let mut v: serde_json::Value = match serde_json::from_str(raw) { Ok(v) => v, Err(_) => return Ok(()) };
    let Some(obj) = v.as_object_mut() else { return Ok(()) };
    let mut changed = false;
    for (field, suffix) in [("proxyPassword", "proxy"), ("jumpPassword", "jump")] {
        let pw = obj.get(field).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(pw) = pw {
            crate::keychain::set_password(&format!("{}::{}", config.id, suffix), &pw)?;
            obj.insert(field.to_string(), serde_json::Value::String(String::new()));
            changed = true;
        }
    }
    if changed {
        config.extra_json = Some(serde_json::to_string(&v).map_err(|e| format!("序列化 extra_json 失败: {e}"))?);
    }
    Ok(())
}

/// 将 DB 连接的 SSH 隧道密码从 extra_json 明文迁入 keychain。
/// 与 `stash_secrets`（SSH 连接专用）对称，供 DB 连接类型调用。
pub fn stash_db_tunnel_secret(config: &mut crate::models::ConnConfig) -> Result<(), String> {
    let Some(raw) = config.extra_json.as_deref() else { return Ok(()) };
    let mut v: serde_json::Value = match serde_json::from_str(raw) { Ok(v) => v, Err(_) => return Ok(()) };
    let Some(obj) = v.as_object_mut() else { return Ok(()) };
    // sshTunnel 未开启时不处理
    if !obj.get("sshTunnel").and_then(|x| x.as_bool()).unwrap_or(false) { return Ok(()); }
    let pw = obj.get("sshPassword").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(pw) = pw {
        crate::keychain::set_password(&format!("{}::ssh-tunnel", config.id), &pw)?;
        obj.insert("sshPassword".to_string(), serde_json::Value::String(String::new()));
        config.extra_json = Some(serde_json::to_string(&v).map_err(|e| format!("序列化失败: {e}"))?);
    }
    Ok(())
}

/// 删除 SSH 连接时清理其代理/跳板密码 keychain 条目（避免泄漏/泄留）。
pub fn purge_secrets(id: &str) {
    let _ = crate::keychain::delete_password(&format!("{id}::proxy"));
    let _ = crate::keychain::delete_password(&format!("{id}::jump"));
    let _ = crate::keychain::delete_password(&format!("{id}::ssh-tunnel"));
}

/// Mutex 防毒锁：持锁线程 panic 后仍可恢复数据，避免连锁崩溃
pub fn safe_lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ── 消息类型 ──────────────────────────────────────────────

#[derive(Debug)]
pub enum SshCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

// ── 会话句柄（存入全局状态） ──────────────────────────────

pub struct SshHandle {
    pub tx: mpsc::UnboundedSender<SshCmd>,
    pub run_id: String,
    pub conn_id: String,   // 连接配置 ID（断开时据此释放 SFTP 池，避免句柄泄漏）
}

pub type SshState = Arc<Mutex<HashMap<String, SshHandle>>>;

// ── 事件载荷（发往前端） ──────────────────────────────────

#[derive(Clone, Serialize)]
pub struct SshDataPayload {
    pub id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct SshStatusPayload {
    pub id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub message: String,
}

// ── MFA 交互式认证（keyboard-interactive 提示转发到前端） ──

#[derive(Clone, Serialize)]
pub struct MfaPromptItem {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Clone, Serialize)]
pub struct SshMfaPromptPayload {
    pub id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub name: String,
    pub instruction: String,
    pub prompts: Vec<MfaPromptItem>,
}

/// 终端会话上下文：仅主 PTY 会话支持弹窗交互，辅助连接（文件/性能）仍自动应答
#[derive(Clone, Copy)]
pub struct MfaUi<'a> {
    pub app: &'a tauri::AppHandle,
    pub session_id: &'a str,
    pub run_id: &'a str,
}

type MfaSender = tokio::sync::oneshot::Sender<Option<Vec<String>>>;
static MFA_PENDING: OnceLock<Mutex<HashMap<String, MfaSender>>> = OnceLock::new();

fn mfa_pending() -> &'static Mutex<HashMap<String, MfaSender>> {
    MFA_PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 前端应答入口：answers=None 表示用户取消认证
pub fn mfa_respond(request_id: &str, answers: Option<Vec<String>>) -> Result<(), String> {
    let sender = safe_lock(mfa_pending())
        .remove(request_id)
        .ok_or_else(|| "认证请求不存在或已过期".to_string())?;
    sender.send(answers).map_err(|_| "认证流程已结束".to_string())
}

// ── Known-hosts TOFU ─────────────────────────────────────

static KNOWN_HOSTS_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init_known_hosts(app_data_dir: &PathBuf) {
    let _ = KNOWN_HOSTS_PATH.set(app_data_dir.join("known_hosts.json"));
}

/// 删除整个 known_hosts 文件（清空本机数据用，不可恢复）。
pub fn clear_known_hosts() -> Result<(), String> {
    let _lock = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(path) = KNOWN_HOSTS_PATH.get() {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("删除 known_hosts 失败: {e}"))?;
        }
    }
    Ok(())
}

static KNOWN_HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn tofu_check(fingerprint: &str, host: &str, port: u16, strict: bool) -> Result<(), String> {
    let path = KNOWN_HOSTS_PATH.get()
        .cloned()
        .ok_or_else(|| "known_hosts 路径未初始化，请重启应用".to_string())?;

    // 互斥锁保护整个读-改-写事务，防止并发连接互相覆盖条目
    let _lock = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    let mut map: HashMap<String, String> = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    let key = format!("{host}:{port}");
    match map.get(&key) {
        None if strict => Err(format!(
            "严格校验模式：主机 {host}:{port} 的密钥指纹不在信任列表中。\
             请先用「首次信任 (TOFU)」模式成功连接一次，再切回严格模式。"
        )),
        None => {
            map.insert(key, fingerprint.to_string());
            let json = serde_json::to_string_pretty(&map)
                .map_err(|e| format!("序列化 known_hosts 失败: {e}"))?;
            // 原子写：先写临时文件，再 rename
            let tmp = path.with_extension("tmp");
            std::fs::write(&tmp, &json)
                .map_err(|e| format!("写入 known_hosts 临时文件失败: {e}"))?;
            crate::keychain::restrict_permissions(&tmp);
            std::fs::rename(&tmp, &path)
                .map_err(|e| format!("重命名 known_hosts 失败: {e}"))?;
            Ok(())
        }
        Some(known) if known == fingerprint => Ok(()),
        Some(known) => Err(format!(
            "⚠️ 主机 {host}:{port} 密钥已变更，疑似中间人攻击！\n\
             已信任指纹: {known}\n\
             本次出示: {fingerprint}\n\
             请通过带外渠道核对本次指纹；确认主机确实重装/换密钥后，\
             删除 known_hosts.json 中 \"{host}:{port}\" 条目再重连。"
        )),
    }
}

// ── russh 客户端 Handler ──────────────────────────────────

pub struct SshHandler {
    host: String,
    port: u16,
    /// 主机密钥校验策略：tofu（首次信任）| strict（仅信任已知）| skip（跳过校验，不安全）
    host_key_policy: String,
    tofu_err: Arc<Mutex<Option<String>>>,
    /// 远程转发映射：服务器侧绑定端口 → 本地目标 (ip, port)
    forwards: Arc<Mutex<HashMap<u32, (String, u16)>>>,
}

#[async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        if self.host_key_policy == "skip" {
            log::warn!("已跳过 {}:{} 的主机密钥校验（连接配置选择了跳过模式）", self.host, self.port);
            return Ok(true);
        }
        let fp = server_public_key.fingerprint();
        let strict = self.host_key_policy == "strict";
        match tofu_check(&fp, &self.host, self.port, strict) {
            Ok(()) => Ok(true),
            Err(e) => {
                *safe_lock(&self.tofu_err) = Some(e);
                Ok(false)
            }
        }
    }

    /// SSH Agent 转发：服务器开 auth-agent 通道时，代理到本地 SSH_AUTH_SOCK
    #[cfg_attr(not(target_family = "unix"), allow(unused_variables))]
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        #[cfg(unix)]
        {
            let sock = match std::env::var("SSH_AUTH_SOCK") {
                Ok(p) => p,
                Err(_) => {
                    log::warn!("Agent 转发：SSH_AUTH_SOCK 未设置");
                    return Err(russh::Error::RequestDenied);
                }
            };
            tokio::spawn(async move {
                match tokio::net::UnixStream::connect(&sock).await {
                    Ok(mut agent_sock) => {
                        let mut ch = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut ch, &mut agent_sock).await;
                    }
                    Err(e) => {
                        log::warn!("Agent 转发：连接 SSH_AUTH_SOCK 失败: {e}");
                        let _ = channel.close().await;
                    }
                }
            });
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err(russh::Error::RequestDenied)
    }

    /// 远程隧道：服务器侧有连接进来，转接到本地目标
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = safe_lock(&self.forwards).get(&connected_port).cloned();
        if let Some((ip, port)) = target {
            tokio::spawn(async move {
                match tokio::net::TcpStream::connect((ip.as_str(), port)).await {
                    Ok(mut tcp) => {
                        let mut ch = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
                    }
                    Err(_) => { let _ = channel.close().await; }
                }
            });
        }
        Ok(())
    }
}

/// 内部：在已持 KNOWN_HOSTS_LOCK 的情况下从文件中移除指定 key，原子写。
fn remove_host_key_locked(path: &std::path::Path, key: &str) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let mut map: HashMap<String, String> = std::fs::read_to_string(path)
        .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if map.remove(key).is_none() { return Ok(()); }
    let json = serde_json::to_string_pretty(&map).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("写入临时文件失败: {e}"))?;
    crate::keychain::restrict_permissions(&tmp);
    std::fs::rename(&tmp, path).map_err(|e| format!("重命名失败: {e}"))
}

pub fn clear_host_key(host: &str, port: u16) -> Result<(), String> {
    let path = KNOWN_HOSTS_PATH.get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("known_hosts.json"));
    // 与 tofu_check 共用同一把锁，防止并发读-改-写丢失更新
    let _lock = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    remove_host_key_locked(&path, &format!("{host}:{port}"))
}

/// 按 "host:port" 字符串删除 known_hosts 条目（供 ssh_config 命令调用）。
pub fn delete_host_key(host_port: &str) -> Result<(), String> {
    let path = KNOWN_HOSTS_PATH.get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("known_hosts.json"));
    let _lock = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    remove_host_key_locked(&path, host_port)
}

/// 列出所有已信任主机指纹：返回 (host:port, fingerprint)，按 host 排序。
pub fn list_known_hosts() -> Vec<(String, String)> {
    let path = KNOWN_HOSTS_PATH.get().cloned()
        .unwrap_or_else(|| PathBuf::from("known_hosts.json"));
    if !path.exists() { return vec![]; }
    let map: HashMap<String, String> = std::fs::read_to_string(&path).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let mut v: Vec<(String, String)> = map.into_iter().collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

// ── 路径安全校验 ──────────────────────────────────────────

pub fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() { return Err("路径不能为空".to_string()); }
    if path.len() > 4096 { return Err("路径过长".to_string()); }
    // 双引号内 ` $ \ " 仍会被 bash 解释（变量展开/转义/提前闭合），一律拒绝；
    // ; | & < > 等元字符纵深防御一并拒绝
    for ch in path.chars() {
        if ch.is_control() {
            return Err("路径包含非法控制字符".to_string());
        }
        if matches!(ch, '`' | '$' | '\\' | '"' | ';' | '|' | '&' | '<' | '>') {
            return Err(format!("路径包含非法字符: {ch}"));
        }
    }
    Ok(())
}

// ── 全局代理（设置中心配置，连接级未配置代理时生效） ─────

#[derive(Clone, Default)]
pub struct GlobalProxy {
    pub proxy_type: String, // none | http | socks5
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

static GLOBAL_PROXY: OnceLock<Mutex<GlobalProxy>> = OnceLock::new();

fn global_proxy() -> &'static Mutex<GlobalProxy> {
    GLOBAL_PROXY.get_or_init(|| Mutex::new(GlobalProxy::default()))
}

pub fn set_global_proxy(p: GlobalProxy) {
    *safe_lock(global_proxy()) = p;
}

fn proxy_usable(ptype: &str, host: &str, port: u16) -> bool {
    (ptype == "http" || ptype == "socks5") && !host.trim().is_empty() && port > 0
}

/// 生效代理：连接级配置优先，未配置时回退全局代理。
/// - 连接级显式启用代理但配置不完整 → 明确报错（静默直连会造成用户以为流量走了代理）
/// - 全局代理只是兜底：配置不完整时静默忽略，按直连处理
fn effective_proxy(extra: &SshExtra) -> Result<GlobalProxy, String> {
    if extra.proxy_type == "http" || extra.proxy_type == "socks5" {
        if !proxy_usable(&extra.proxy_type, &extra.proxy_host, extra.proxy_port) {
            return Err("此连接已启用代理，但代理主机/端口未配置完整，请在连接设置的「代理」页补全或关闭代理".to_string());
        }
        return Ok(GlobalProxy {
            proxy_type: extra.proxy_type.clone(),
            host: extra.proxy_host.trim().to_string(),
            port: extra.proxy_port,
            username: extra.proxy_username.clone(),
            password: extra.proxy_password.clone(),
        });
    }
    let g = safe_lock(global_proxy()).clone();
    Ok(if proxy_usable(&g.proxy_type, &g.host, g.port) { g } else { GlobalProxy::default() })
}

// ── 传输层（直连 / HTTP CONNECT / SOCKS5 代理） ──────────

pub trait Transport: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Transport for T {}

async fn open_transport(extra: &SshExtra, host: &str, port: u16) -> Result<Box<dyn Transport>, String> {
    use tokio::net::TcpStream;
    let proxy = effective_proxy(extra)?;
    match proxy.proxy_type.as_str() {
        "http" => {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut s = TcpStream::connect((proxy.host.as_str(), proxy.port)).await
                .map_err(|e| format!("连接 HTTP 代理失败: {e}"))?;
            let auth = if proxy.username.is_empty() { String::new() } else {
                use base64::{engine::general_purpose::STANDARD, Engine};
                let cred = STANDARD.encode(format!("{}:{}", proxy.username, proxy.password));
                format!("Proxy-Authorization: Basic {cred}\r\n")
            };
            let req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n");
            s.write_all(req.as_bytes()).await.map_err(|e| format!("代理握手发送失败: {e}"))?;
            // 逐字节读到头部结束，避免吞掉 SSH banner
            let mut head = Vec::with_capacity(256);
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if head.len() > 8192 { return Err("代理响应头过大".into()); }
                let n = s.read(&mut byte).await.map_err(|e| format!("读取代理响应失败: {e}"))?;
                if n == 0 { return Err("代理提前关闭连接".into()); }
                head.push(byte[0]);
            }
            let line = String::from_utf8_lossy(&head);
            let ok = line.starts_with("HTTP/1.1 200") || line.starts_with("HTTP/1.0 200");
            if !ok {
                let status = line.lines().next().unwrap_or("").to_string();
                if status.contains(" 407") {
                    return Err("HTTP 代理要求身份验证，请在代理设置中配置用户名和密码".to_string());
                }
                return Err(format!("HTTP 代理拒绝连接: {status}"));
            }
            Ok(Box::new(s))
        }
        "socks5" => {
            let proxy_addr = (proxy.host.as_str(), proxy.port);
            let target = (host, port);
            let s = if proxy.username.is_empty() {
                tokio_socks::tcp::Socks5Stream::connect(proxy_addr, target).await
            } else {
                tokio_socks::tcp::Socks5Stream::connect_with_password(
                    proxy_addr, target, &proxy.username, &proxy.password,
                ).await
            }.map_err(|e| format!("SOCKS5 代理连接失败: {e}"))?;
            Ok(Box::new(s))
        }
        _ => {
            let s = TcpStream::connect((host, port)).await
                .map_err(|e| format!("TCP 连接失败: {e}"))?;
            Ok(Box::new(s))
        }
    }
}

// ── 跳板机：通道流封装（保持跳板连接句柄存活）────────────

use std::pin::Pin;
use std::task::{Context, Poll};

struct JumpedStream {
    inner: Pin<Box<russh::ChannelStream<russh::client::Msg>>>,
    _jumps: Vec<client::Handle<SshHandler>>, // 所有跳板句柄（保持连接存活）
}

impl Unpin for JumpedStream {}

impl tokio::io::AsyncRead for JumpedStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for JumpedStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        self.inner.as_mut().poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_shutdown(cx)
    }
}

/// 跨平台连接 ssh-agent 并用其中的密钥尝试认证。
/// - Unix(含 macOS）：经 `SSH_AUTH_SOCK` 连接 unix socket（行为同原实现）
/// - Windows：连接 OpenSSH 的命名管道 `\\.\pipe\openssh-ssh-agent`
async fn authenticate_with_agent(
    handle: &mut client::Handle<SshHandler>,
    user: &str,
) -> Result<bool, String> {
    #[cfg(unix)]
    let mut agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| format!("连接 ssh-agent 失败（请确认已启动并设置 SSH_AUTH_SOCK）: {e}"))?;
    #[cfg(windows)]
    let mut agent = {
        let pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(r"\\.\pipe\openssh-ssh-agent")
            .map_err(|e| {
                format!("连接 ssh-agent 失败（请确认 Windows 的 OpenSSH Authentication Agent 服务已启动）: {e}")
            })?;
        russh_keys::agent::client::AgentClient::connect(pipe)
    };

    let keys = agent
        .request_identities()
        .await
        .map_err(|e| format!("读取 agent 密钥列表失败: {e}"))?;
    if keys.is_empty() {
        return Err("ssh-agent 中没有可用密钥，请先 ssh-add".to_string());
    }
    let mut ok = false;
    let mut agent_opt = Some(agent);
    for key in keys {
        let (a, res) = handle
            .authenticate_future(user, key, agent_opt.take().expect("agent"))
            .await;
        agent_opt = Some(a);
        match res {
            Ok(true) => {
                ok = true;
                break;
            }
            Ok(false) => {}
            Err(e) => log::debug!("agent 密钥认证尝试失败: {e}"),
        }
    }
    Ok(ok)
}

/// 跳板机认证
async fn authenticate_jump(
    handle: &mut client::Handle<SshHandler>,
    extra: &SshExtra,
) -> Result<(), String> {
    let user = &extra.jump_username;
    let ok = match extra.jump_auth_type.as_str() {
        "agent" => authenticate_with_agent(handle, user).await?,
        "key" => {
            if extra.jump_key_path.is_empty() {
                return Err("跳板机私钥路径不能为空".to_string());
            }
            let pass = if extra.jump_password.is_empty() { None } else { Some(extra.jump_password.as_str()) };
            let key = russh_keys::load_secret_key(crate::tester::expand_home(&extra.jump_key_path), pass)
                .map_err(|e| format!("加载跳板机密钥失败: {e}"))?;
            handle.authenticate_publickey(user, Arc::new(key)).await
                .map_err(|e| format!("跳板机密钥认证失败: {e}"))?
        }
        _ => {
            handle.authenticate_password(user, &extra.jump_password).await
                .map_err(|e| format!("跳板机密码认证失败: {e}"))?
        }
    };
    if !ok { return Err("跳板机认证被拒绝，请检查认证配置".to_string()); }
    Ok(())
}

/// 认证额外跳板节点
async fn authenticate_extra_jump(
    handle: &mut client::Handle<SshHandler>,
    hop: &ExtraJump,
) -> Result<(), String> {
    let user = &hop.username;
    let ok = match hop.auth_type.as_str() {
        "agent" => authenticate_with_agent(handle, user).await?,
        "key" => {
            if hop.key_path.is_empty() {
                return Err("私钥路径不能为空".to_string());
            }
            let pass = if hop.password.is_empty() { None } else { Some(hop.password.as_str()) };
            let key = russh_keys::load_secret_key(crate::tester::expand_home(&hop.key_path), pass)
                .map_err(|e| format!("加载私钥失败: {e}"))?;
            handle.authenticate_publickey(user, Arc::new(key)).await
                .map_err(|e| format!("密钥认证失败: {e}"))?
        }
        _ => {
            handle.authenticate_password(user, &hop.password).await
                .map_err(|e| format!("密码认证失败: {e}"))?
        }
    };
    if !ok { return Err("认证被拒绝，请检查用户名和认证配置".to_string()); }
    Ok(())
}

/// 通过跳板机链建立到目标主机的传输通道（支持多跳 ProxyJump）
async fn open_jump_transport(
    extra: &SshExtra,
    target_host: &str,
    target_port: u16,
) -> Result<Box<dyn Transport>, String> {
    if extra.jump_host.trim().is_empty() {
        return Err("跳板机地址不能为空".to_string());
    }

    let timeout_secs = extra.connect_timeout.clamp(5, 300);
    let mut all_handles: Vec<client::Handle<SshHandler>> = Vec::new();

    // ── 第一跳：经代理/直连到 jump_host ──
    let jump_stream = open_transport(extra, &extra.jump_host, extra.jump_port).await
        .map_err(|e| format!("连接跳板机 {}:{} 失败: {e}", extra.jump_host, extra.jump_port))?;

    let tofu_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = SshHandler {
        host: extra.jump_host.clone(),
        port: extra.jump_port,
        host_key_policy: extra.host_key_policy.clone(),
        tofu_err: tofu_err.clone(),
        forwards: Arc::new(Mutex::new(HashMap::new())),
    };
    let mut cur_handle = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        client::connect_stream(Arc::new(client::Config::default()), jump_stream, handler),
    ).await
    .map_err(|_| format!("跳板机 {}:{} 连接超时（{timeout_secs}秒）", extra.jump_host, extra.jump_port))?
    .map_err(|e| {
        if let Some(err) = safe_lock(&tofu_err).take() { return err; }
        format!("跳板机 SSH 握手失败: {e}")
    })?;

    if let Some(err) = safe_lock(&tofu_err).take() {
        return Err(err);
    }
    authenticate_jump(&mut cur_handle, extra).await?;

    // ── 额外跳：每跳从前一个 handle 打开 direct-tcpip，再做 SSH 握手 + 认证 ──
    for hop in extra.extra_jumps.iter().filter(|h| !h.host.trim().is_empty()) {
        let hop_port = hop.effective_port();

        let channel = cur_handle.channel_open_direct_tcpip(
            &hop.host, hop_port as u32,
            "127.0.0.1", 0,
        ).await
        .map_err(|e| format!("打开下一跳 {}:{} 通道失败: {e}", hop.host, hop_port))?;

        all_handles.push(cur_handle);
        let channel_stream = channel.into_stream();

        let tofu_err2: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let handler2 = SshHandler {
            host: hop.host.clone(),
            port: hop_port,
            host_key_policy: extra.host_key_policy.clone(),
            tofu_err: tofu_err2.clone(),
            forwards: Arc::new(Mutex::new(HashMap::new())),
        };
        let mut next_handle = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            client::connect_stream(Arc::new(client::Config::default()), channel_stream, handler2),
        ).await
        .map_err(|_| format!("经跳板机连接 {}:{} 超时", hop.host, hop_port))?
        .map_err(|e| {
            if let Some(err) = safe_lock(&tofu_err2).take() { return err; }
            format!("经跳板机连接 {}:{} SSH 握手失败: {e}", hop.host, hop_port)
        })?;

        if let Some(err) = safe_lock(&tofu_err2).take() {
            return Err(err);
        }
        authenticate_extra_jump(&mut next_handle, hop).await
            .map_err(|e| format!("跳板机 {}:{} 认证失败: {e}", hop.host, hop_port))?;

        cur_handle = next_handle;
    }

    // ── 最后：从末端 handle 打开到目标的通道 ──
    let channel = cur_handle.channel_open_direct_tcpip(
        target_host, target_port as u32,
        "127.0.0.1", 0,
    ).await
    .map_err(|e| format!("打开目标通道 {target_host}:{target_port} 失败: {e}"))?;

    all_handles.push(cur_handle);

    Ok(Box::new(JumpedStream {
        inner: Box::pin(channel.into_stream()),
        _jumps: all_handles,
    }))
}

// ── 连接 + 认证 ───────────────────────────────────────────

type ForwardMap = Arc<Mutex<HashMap<u32, (String, u16)>>>;

pub(crate) async fn connect_and_auth(
    config: &ConnConfig,
    password: Option<&str>,
    mfa_ui: Option<MfaUi<'_>>,
) -> Result<(client::Handle<SshHandler>, ForwardMap), String> {
    let host = config.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let port = config.port.unwrap_or(22) as u16;
    let user = config.username.clone().unwrap_or_else(|| "root".into());
    let pwd  = password.unwrap_or("").to_string();
    let extra = SshExtra::from_config(config);
    let timeout_secs = extra.connect_timeout.clamp(5, 300);

    let tofu_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let forwards: ForwardMap = Arc::new(Mutex::new(HashMap::new()));
    let handler = SshHandler {
        host: host.clone(),
        port,
        host_key_policy: extra.host_key_policy.clone(),
        tofu_err: tofu_err.clone(),
        forwards: forwards.clone(),
    };

    let mut ssh_cfg = client::Config::default();
    if extra.heartbeat_interval > 0 {
        ssh_cfg.keepalive_interval = Some(std::time::Duration::from_secs(extra.heartbeat_interval.clamp(5, 600)));
        ssh_cfg.keepalive_max = 3;
    }
    if extra.enable_compression {
        // zlib 优先，服务器不支持时自动协商回退 none
        const COMPRESS_PREF: &[russh::compression::Name] = &[
            russh::compression::ZLIB,
            russh::compression::ZLIB_LEGACY,
            russh::compression::NONE,
        ];
        ssh_cfg.preferred.compression = std::borrow::Cow::Borrowed(COMPRESS_PREF);
    }
    let ssh_cfg = Arc::new(ssh_cfg);

    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        async {
            let stream = if extra.jump_enabled && !extra.jump_host.trim().is_empty() {
                open_jump_transport(&extra, &host, port).await?
            } else {
                open_transport(&extra, &host, port).await?
            };
            client::connect_stream(ssh_cfg, stream, handler).await.map_err(|e| {
                if let Some(err) = safe_lock(&tofu_err).take() { return err; }
                format!("SSH 连接失败: {e}")
            })
        },
    )
    .await
    .map_err(|_| format!("SSH 连接超时（{timeout_secs} 秒）"))??;

    let authenticated = match extra.auth_type.as_str() {
        "agent" => authenticate_with_agent(&mut handle, &user).await?,
        "mfa" => {
            use client::KeyboardInteractiveAuthResponse as Kb;
            let mut resp = handle.authenticate_keyboard_interactive_start(&user, None).await
                .map_err(|e| format!("交互式认证启动失败: {e}"))?;
            let mut rounds = 0;
            let mut pwd_auto_used = false;
            loop {
                match resp {
                    Kb::Success => break true,
                    Kb::Failure => break false,
                    Kb::InfoRequest { name, instructions, prompts } => {
                        rounds += 1;
                        if rounds > 10 {
                            return Err("交互式认证轮次过多，已中止".to_string());
                        }
                        let answers: Vec<String> = match mfa_ui {
                            // 无 UI 通道（exec/文件/性能等辅助连接）：保持原行为，全部用密码应答
                            None => prompts.iter().map(|_| pwd.clone()).collect(),
                            Some(ui) => {
                                let pw_like = |p: &str| {
                                    let l = p.to_lowercase();
                                    l.contains("password") || p.contains("密码")
                                };
                                if prompts.is_empty() {
                                    Vec::new()
                                } else if !pwd_auto_used && !pwd.is_empty()
                                    && prompts.iter().all(|p| pw_like(&p.prompt))
                                {
                                    // 首轮纯密码提示自动应答；之后再出现说明密码不对，转交用户
                                    pwd_auto_used = true;
                                    prompts.iter().map(|_| pwd.clone()).collect()
                                } else {
                                    let request_id = uuid::Uuid::new_v4().to_string();
                                    let (ans_tx, ans_rx) = tokio::sync::oneshot::channel();
                                    safe_lock(mfa_pending()).insert(request_id.clone(), ans_tx);
                                    let _ = ui.app.emit("ssh:mfa-prompt", SshMfaPromptPayload {
                                        id: ui.session_id.to_string(),
                                        run_id: ui.run_id.to_string(),
                                        request_id: request_id.clone(),
                                        name: name.clone(),
                                        instruction: instructions.clone(),
                                        prompts: prompts.iter()
                                            .map(|p| MfaPromptItem { prompt: p.prompt.clone(), echo: p.echo })
                                            .collect(),
                                    });
                                    let got = tokio::time::timeout(
                                        std::time::Duration::from_secs(180), ans_rx,
                                    ).await;
                                    safe_lock(mfa_pending()).remove(&request_id);
                                    match got {
                                        Err(_) => return Err("等待验证输入超时（180 秒），连接已中止".to_string()),
                                        Ok(Err(_)) => return Err("认证流程被中断".to_string()),
                                        Ok(Ok(None)) => return Err("已取消多因素认证".to_string()),
                                        Ok(Ok(Some(mut ans))) => {
                                            ans.resize(prompts.len(), String::new());
                                            ans
                                        }
                                    }
                                }
                            }
                        };
                        resp = handle.authenticate_keyboard_interactive_respond(answers).await
                            .map_err(|e| format!("交互式认证应答失败: {e}"))?;
                    }
                }
            }
        }
        "none" => {
            handle.authenticate_none(&user).await
                .map_err(|e| format!("无认证登录失败: {e}"))?
        }
        _ => {
            // password / key：密钥路径存在则走公钥，否则密码
            if let Some(kp) = config.ssh_key_path.as_deref().filter(|s| !s.is_empty()) {
                let pass = if pwd.is_empty() { None } else { Some(pwd.as_str()) };
                let key = russh_keys::load_secret_key(crate::tester::expand_home(kp), pass)
                    .map_err(|e| format!("加载密钥文件失败: {e}"))?;
                handle.authenticate_publickey(&user, Arc::new(key))
                    .await
                    .map_err(|e| format!("密钥认证失败: {e}"))?
            } else {
                handle.authenticate_password(&user, &pwd)
                    .await
                    .map_err(|e| format!("密码认证失败: {e}"))?
            }
        }
    };

    if !authenticated {
        return Err("认证被拒绝，请检查认证配置".to_string());
    }
    Ok((handle, forwards))
}

// ── DB 隧道专用 SSH 连接（简化版 connect_and_auth，无 MFA / 代理）──

pub async fn connect_for_db_tunnel(
    cfg: &crate::db_tunnel::DbTunnelCfg,
) -> Result<client::Handle<SshHandler>, String> {
    // 构造一个最小 ConnConfig，复用现有 connect_and_auth 逻辑
    let tunnel_conn = crate::models::ConnConfig {
        id:           String::new(),
        name:         String::new(),
        conn_type:    crate::models::ConnType::Ssh,
        host:         Some(cfg.host.clone()),
        port:         Some(cfg.effective_port()),
        username:     Some(cfg.user.clone()),
        database:     None,
        file_path:    None,
        // 密钥路径存在时走公钥认证，否则密码认证
        ssh_key_path: if cfg.auth_type == "key" && !cfg.key_path.is_empty() {
            Some(cfg.key_path.clone())
        } else {
            None
        },
        use_ssl:    false,
        created_at: 0,
        updated_at: 0,
        color:      None,
        extra_json: Some(serde_json::json!({
            "authType":          cfg.auth_type,
            "connectTimeout":    20,
            "heartbeatInterval": 0,
            "hostKeyPolicy":     "tofu",
            "proxyType":         "none",
            "jumpEnabled":       false,
        }).to_string()),
        read_only:  None,
        env_label:  None,
    };
    // agent / none 认证时 password 参数无意义
    let pwd = if cfg.auth_type == "agent" || cfg.auth_type == "none" { "" } else { &cfg.password };
    let (handle, _) = connect_and_auth(&tunnel_conn, Some(pwd), None).await?;
    Ok(handle)
}

// ── 独立 exec 连接 ────────────────────────────────────────

pub async fn exec_command(
    config: &ConnConfig,
    password: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let (handle, _) = connect_and_auth(config, password, None).await?;
    let mut channel = handle.channel_open_session().await
        .map_err(|e| format!("打开通道失败: {e}"))?;
    channel.exec(true, command).await
        .map_err(|e| format!("执行命令失败: {e}"))?;

    let mut output = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => output.extend_from_slice(data),
            Some(ChannelMsg::ExtendedData { ref data, .. }) => output.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }
    handle.disconnect(Disconnect::ByApplication, "", "English").await.ok();
    Ok(String::from_utf8_lossy(&output).into_owned())
}

// ── 上传文件（exec channel + base64） ────────────────────

pub async fn upload_bytes(
    config: &ConnConfig,
    password: Option<&str>,
    remote_path: &str,
    data: &[u8],
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let b64 = STANDARD.encode(data);

    let (handle, _) = connect_and_auth(config, password, None).await?;
    let mut channel = handle.channel_open_session().await
        .map_err(|e| format!("打开通道失败: {e}"))?;

    let cmd = format!(r#"base64 -d > "{}""#, remote_path.replace('"', "\\\""));
    channel.exec(true, cmd.as_str()).await
        .map_err(|e| format!("执行上传命令失败: {e}"))?;
    channel.data(b64.as_bytes()).await
        .map_err(|e| format!("发送数据失败: {e}"))?;
    channel.eof().await
        .map_err(|e| format!("发送 EOF 失败: {e}"))?;

    loop {
        match channel.wait().await {
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                if exit_status != 0 {
                    return Err(format!("上传失败，远程命令退出码: {exit_status}"));
                }
                break;
            }
            Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }
    handle.disconnect(Disconnect::ByApplication, "", "English").await.ok();
    Ok(())
}

// ── 主 PTY 会话 ───────────────────────────────────────────

pub async fn run_session(
    session_id: String,
    run_id: String,
    config: ConnConfig,
    password: Option<String>,
    mut cmd_rx: mpsc::UnboundedReceiver<SshCmd>,
    app: tauri::AppHandle,
) {
    let result = run_pty_session(
        &session_id, &run_id, &config, password.as_deref(), &mut cmd_rx, &app,
    ).await;

    if let Err(e) = result {
        let _ = app.emit("ssh:error", SshStatusPayload { id: session_id.clone(), run_id: run_id.clone(), message: e });
    }
    let _ = app.emit("ssh:disconnected", SshStatusPayload { id: session_id, run_id, message: String::new() });
}

async fn run_pty_session(
    session_id: &str,
    run_id: &str,
    config: &ConnConfig,
    password: Option<&str>,
    cmd_rx: &mut mpsc::UnboundedReceiver<SshCmd>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let t0 = std::time::Instant::now();
    let (mut handle, forwards) = connect_and_auth(
        config,
        password,
        Some(MfaUi { app, session_id, run_id }),
    ).await?;
    let connect_ms = t0.elapsed().as_millis() as u64;

    // 发布连接延迟事件（含 SSH 握手 + 认证全程耗时）
    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct SshStats { id: String, conn_id: String, connect_ms: u64 }
    let _ = app.emit("ssh:stats", SshStats {
        id: session_id.to_string(),
        conn_id: config.id.clone(),
        connect_ms,
    });

    let extra = SshExtra::from_config(config);

    // 远程隧道注册（需独占 handle，在 Arc 包装前完成）
    for t in extra.tunnels.iter().filter(|t| !t.disabled && t.tunnel_type == "remote") {
        let bind = if t.bind_ip.is_empty() { "0.0.0.0".to_string() } else { t.bind_ip.clone() };
        match handle.tcpip_forward(bind, t.bind_port as u32).await {
            Ok(bound) => {
                let actual = if bound == 0 { t.bind_port as u32 } else { bound };
                safe_lock(&forwards).insert(actual, (t.target_ip.clone(), t.target_port));
                log::info!("远程隧道 {} 已注册，服务器端口 {actual}", t.name);
            }
            Err(e) => log::warn!("远程隧道 {} 注册失败: {e}", t.name),
        }
    }

    let handle = Arc::new(handle);

    // 本地/动态隧道随会话启动，会话结束时一并终止
    let mut tunnel_tasks = Vec::new();
    for t in extra.tunnels.iter().filter(|t| !t.disabled) {
        match t.tunnel_type.as_str() {
            "local"   => tunnel_tasks.push(tokio::spawn(tunnel::run_local_forward(handle.clone(), t.clone()))),
            "dynamic" => tunnel_tasks.push(tokio::spawn(tunnel::run_dynamic_forward(handle.clone(), t.clone()))),
            _ => {}
        }
    }

    let mut channel = handle.channel_open_session().await
        .map_err(|e| format!("打开通道失败: {e}"))?;
    for ev in &extra.env_vars {
        // 变量名仅允许字母数字下划线，且不以数字开头
        let valid = !ev.name.is_empty()
            && !ev.name.chars().next().is_some_and(|c| c.is_ascii_digit())
            && ev.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid {
            channel.set_env(false, ev.name.as_str(), ev.value.as_str()).await.ok();
        }
    }
    let term = if extra.terminal_type.is_empty() { "xterm-256color" } else { extra.terminal_type.as_str() };
    // 关闭 XON/XOFF 流控：远程 tty 默认开启 IXON，vim/less 等全屏应用里误按 Ctrl+S 会发 XOFF
    // 冻住整个画面（按 Ctrl+Q 才解冻）。xterm.js 走 raw 模式无需软件流控，显式关掉避免假死。
    let pty_modes: &[(Pty, u32)] = &[(Pty::IXON, 0), (Pty::IXOFF, 0), (Pty::IXANY, 0)];
    channel.request_pty(false, term, 80, 24, 0, 0, pty_modes).await
        .map_err(|e| format!("申请 PTY 失败: {e}"))?;
    if extra.agent_forwarding {
        if let Err(e) = channel.agent_forward(false).await {
            log::warn!("请求 Agent 转发失败（服务器可能不支持）: {e}");
        }
    }
    channel.request_shell(false).await
        .map_err(|e| format!("启动 Shell 失败: {e}"))?;

    let _ = app.emit("ssh:connected", SshStatusPayload {
        id: session_id.to_string(),
        run_id: run_id.to_string(),
        message: String::new(),
    });

    // 非 UTF-8 编码：输出流式解码 → UTF-8，输入反向编码；UTF-8 直通零开销
    let encoding = lookup_encoding(&extra.encoding);
    let mut decoder = encoding.map(|e| e.new_decoder());

    // 会话日志：开启后原样落盘（含 ANSI 序列，与 script(1) 行为一致）
    let mut log_file: Option<std::fs::File> = if extra.record_log {
        use tauri::Manager;
        app.path().app_data_dir().ok().and_then(|dir| {
            let logs = dir.join("logs");
            std::fs::create_dir_all(&logs).ok()?;
            let date = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let path = logs.join(format!("{session_id}-{date}.log"));
            let f = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()?;
            crate::keychain::restrict_permissions(&path);
            log::info!("会话日志记录到 {}", path.display());
            Some(f)
        })
    } else { None };

    // 空闲自动断开：0 表示关闭；任意输入/输出都重置计时
    let idle_limit = std::time::Duration::from_secs(extra.idle_timeout_minutes.min(24 * 60) * 60);
    let idle_on = !idle_limit.is_zero();
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)), if idle_on => {
                if last_activity.elapsed() >= idle_limit {
                    let note = format!("\r\n\x1b[33m[空闲超过 {} 分钟，已自动断开]\x1b[0m\r\n", extra.idle_timeout_minutes);
                    let _ = app.emit("ssh:data", SshDataPayload {
                        id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        data: note.into_bytes(),
                    });
                    break;
                }
            }
            msg = channel.wait() => {
                if idle_on { last_activity = tokio::time::Instant::now(); }
                match msg {
                    Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let bytes = match decoder.as_mut() {
                            Some(d) => decode_chunk(d, data),
                            None => data.to_vec(),
                        };
                        if let Some(f) = log_file.as_mut() {
                            use std::io::Write;
                            let _ = f.write_all(&bytes);
                        }
                        let _ = app.emit("ssh:data", SshDataPayload {
                            id: session_id.to_string(),
                            run_id: run_id.to_string(),
                            data: bytes,
                        });
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => break,
                    _ => {}
                }
            }
            cmd = cmd_rx.recv() => {
                if idle_on { last_activity = tokio::time::Instant::now(); }
                match cmd {
                    Some(SshCmd::Write(data)) => {
                        // 非 UTF-8 编码：把前端的 UTF-8 输入编码为远端编码
                        let data = match encoding {
                            Some(enc) => {
                                let s = String::from_utf8_lossy(&data);
                                let (encoded, _, _) = enc.encode(&s);
                                encoded.into_owned()
                            }
                            None => data,
                        };
                        channel.data(data.as_ref()).await
                            .map_err(|e| format!("写入通道失败: {e}"))?;
                    }
                    Some(SshCmd::Resize { cols, rows }) => {
                        channel.window_change(cols, rows, 0, 0).await.ok();
                    }
                    Some(SshCmd::Disconnect) | None => break,
                }
            }
        }
    }

    // 会话结束：终止所有隧道任务
    for task in tunnel_tasks {
        task.abort();
    }
    handle.disconnect(Disconnect::ByApplication, "", "English").await.ok();
    Ok(())
}
