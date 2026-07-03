//! 真 SFTP 实现：会话池复用 + 流式传输进度 + SUDO 模式
//!
//! 安全：所有路径直接走 SFTP 协议报文，无 shell 拼接，从根本上消除命令注入面。
//! 性能：每个连接缓存一条 SSH+SFTP 会话复用，避免每次文件操作重新握手认证。

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use russh::client;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::models::{ConnConfig, FileEntry};
use super::{connect_and_auth, safe_lock, SshExtra, SshHandler};

/// SFTP 路径校验：无 shell 参与，只拦截空路径/超长/控制字符
pub fn validate_sftp_path(path: &str) -> Result<(), String> {
    if path.is_empty() { return Err("路径不能为空".to_string()); }
    if path.len() > 4096 { return Err("路径过长".to_string()); }
    if path.chars().any(|c| c.is_control()) {
        return Err("路径包含非法控制字符".to_string());
    }
    Ok(())
}

// ── 会话池 ────────────────────────────────────────────────

pub struct SftpConn {
    pub sftp: SftpSession,
    /// 保活：SSH 句柄随 SftpConn 一起释放
    _handle: client::Handle<SshHandler>,
    /// 配置版本：连接配置更新后淘汰旧会话
    updated_at: i64,
}

type Pool = Mutex<HashMap<String, Arc<SftpConn>>>;
static POOL: OnceLock<Pool> = OnceLock::new();

fn pool() -> &'static Pool {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn invalidate(conn_id: &str) {
    safe_lock(pool()).remove(conn_id);
}

/// 取会话：命中缓存直接复用；返回 (会话, 是否来自缓存)
async fn acquire(config: &ConnConfig, password: Option<&str>) -> Result<(Arc<SftpConn>, bool), String> {
    if let Some(c) = safe_lock(pool()).get(&config.id).cloned() {
        if c.updated_at == config.updated_at {
            return Ok((c, true));
        }
        // 配置已变更，淘汰旧会话
        safe_lock(pool()).remove(&config.id);
    }
    let conn = Arc::new(open_session(config, password).await?);
    safe_lock(pool()).insert(config.id.clone(), conn.clone());
    Ok((conn, false))
}

async fn open_session(config: &ConnConfig, password: Option<&str>) -> Result<SftpConn, String> {
    let extra = SshExtra::from_config(config);
    let (handle, _) = connect_and_auth(config, password, None).await?;
    let channel = handle.channel_open_session().await
        .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;

    let stream = if extra.sftp_sudo && !extra.sftp_command.trim().is_empty() {
        let cmd = extra.sftp_command.trim();
        // 严格白名单：按空白拆 token，每个 token 仅允许「路径/参数」安全字符（字母数字 . _ / = : - +）。
        // 拒绝空格逃逸、引号、shell 元字符等——denylist 太脆弱，改成 allowlist。
        let tokens: Vec<&str> = cmd.split_whitespace().collect();
        let token_ok = |t: &str| !t.is_empty() && t.chars().all(|c|
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '=' | ':' | '-' | '+'));
        if tokens.is_empty() || !tokens.iter().all(|t| token_ok(t)) {
            return Err("SFTP 命令只允许「绝对路径 + 安全参数」（字母数字及 . _ / = : - +），已拒绝".to_string());
        }
        // SUDO 模式：exec 启动 sftp-server
        channel.exec(true, cmd).await
            .map_err(|e| format!("启动 SFTP-SUDO 命令失败: {e}"))?;
        let mut s = channel.into_stream();
        // 仅当确实是 `sudo -S ...`（首 token=sudo 且含独立 -S 参数）才从 stdin 喂密码，
        // 避免 contains 子串误判把登录密码喂给无关命令
        if tokens.first() == Some(&"sudo") && tokens.iter().any(|t| *t == "-S") {
            if let Some(pwd) = password {
                s.write_all(format!("{pwd}\n").as_bytes()).await
                    .map_err(|e| format!("发送 sudo 密码失败: {e}"))?;
            }
        }
        s
    } else {
        channel.request_subsystem(true, "sftp").await
            .map_err(|e| format!("请求 SFTP 子系统失败（服务器可能未启用 SFTP）: {e}"))?;
        channel.into_stream()
    };

    let sftp = SftpSession::new(stream).await
        .map_err(|e| format!("SFTP 协议初始化失败: {e}"))?;
    sftp.set_timeout(30);

    Ok(SftpConn { sftp, _handle: handle, updated_at: config.updated_at })
}

/// 判断错误是否为传输层故障（值得淘汰会话重试一次）
fn is_transport_err(msg: &str) -> bool {
    msg.starts_with("I/O") || msg == "Timeout"
        || msg.contains("Unexpected packet") || msg.contains("SendError") || msg.contains("RecvError")
}

/// 统一重试包装：缓存会话遇传输层错误时重建会话再试一次
macro_rules! with_retry {
    ($config:expr, $password:expr, |$sftp:ident| $body:expr) => {{
        let (conn, from_cache) = acquire($config, $password).await?;
        let $sftp = &conn.sftp;
        let first = $body;
        match first {
            Err(ref e) if from_cache && is_transport_err(e) => {
                invalidate(&$config.id);
                let (conn, _) = acquire($config, $password).await?;
                let $sftp = &conn.sftp;
                $body
            }
            other => other,
        }
    }};
}

// ── 元数据辅助 ────────────────────────────────────────────

fn fmt_permissions(attrs: &FileAttributes) -> String {
    let mode = attrs.permissions.unwrap_or(0);
    let kind = if attrs.is_dir() { 'd' } else if attrs.is_symlink() { 'l' } else { '-' };
    let mut s = String::with_capacity(10);
    s.push(kind);
    for shift in [6u32, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        s.push(if bits & 0o4 != 0 { 'r' } else { '-' });
        s.push(if bits & 0o2 != 0 { 'w' } else { '-' });
        s.push(if bits & 0o1 != 0 { 'x' } else { '-' });
    }
    s
}

fn fmt_mtime(attrs: &FileAttributes) -> String {
    use chrono::TimeZone;
    attrs.mtime
        .and_then(|t| chrono::Local.timestamp_opt(t as i64, 0).single())
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn join_path(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
}

// ── 目录与文件操作 ────────────────────────────────────────

pub async fn list_dir(
    config: &ConnConfig,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    validate_sftp_path(path)?;
    let entries = with_retry!(config, password, |sftp| {
        sftp.read_dir(path).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("读取目录失败: {e}"))?;

    let mut out: Vec<FileEntry> = entries
        .filter(|e| { let n = e.file_name(); n != "." && n != ".." })
        .map(|e| {
            let name = e.file_name();
            let attrs = e.metadata();
            let is_dir = attrs.is_dir() || attrs.is_symlink();
            FileEntry {
                path: join_path(path, &name),
                is_dir,
                size: if attrs.is_dir() { 0 } else { attrs.size.unwrap_or(0) },
                modified: fmt_mtime(&attrs),
                permissions: fmt_permissions(&attrs),
                name,
            }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize)]
pub struct StartPath {
    pub path: String,
    /// 配置的默认路径不可用时的提示（非致命）
    pub warning: Option<String>,
}

/// 解析起始路径：配置的 SFTP 默认路径 → 远程 $HOME → 根目录，逐级兜底并附带警告
pub async fn resolve_start_path(config: &ConnConfig, password: Option<&str>) -> Result<StartPath, String> {
    let extra = SshExtra::from_config(config);
    let custom = extra.sftp_default_path.trim().to_string();

    if !custom.is_empty() {
        validate_sftp_path(&custom)?;
        let got = with_retry!(config, password, |sftp| {
            sftp.canonicalize(custom.as_str()).await.map_err(|e| e.to_string())
        });
        match got {
            Ok(p) => return Ok(StartPath { path: p, warning: None }),
            Err(e) => {
                let warning = Some(format!("SFTP 默认路径 {custom} 不可访问（{e}），已回退到主目录"));
                let home = with_retry!(config, password, |sftp| {
                    sftp.canonicalize(".").await.map_err(|e| e.to_string())
                });
                return Ok(StartPath { path: home.unwrap_or_else(|_| "/".into()), warning });
            }
        }
    }

    let home = with_retry!(config, password, |sftp| {
        sftp.canonicalize(".").await.map_err(|e| e.to_string())
    }).map_err(|e| format!("解析起始路径失败: {e}"))?;
    Ok(StartPath { path: home, warning: None })
}

pub async fn remove(config: &ConnConfig, password: Option<&str>, path: &str) -> Result<(), String> {
    validate_sftp_path(path)?;
    with_retry!(config, password, |sftp| {
        remove_recursive(sftp, path).await
    })
}

/// 递归删除：迭代式遍历，符号链接只删链接本身不跟随，防止误删链接目标
async fn remove_recursive(sftp: &SftpSession, root: &str) -> Result<(), String> {
    const MAX_ENTRIES: usize = 50_000;
    let meta = sftp.symlink_metadata(root).await
        .map_err(|e| format!("读取文件信息失败: {e}"))?;
    if !meta.is_dir() || meta.is_symlink() {
        return sftp.remove_file(root).await.map_err(|e| format!("删除失败: {e}"));
    }

    let mut visited = 0usize;
    let mut stack = vec![root.to_string()];
    let mut dirs: Vec<String> = Vec::new();
    while let Some(dir) = stack.pop() {
        dirs.push(dir.clone());
        let entries = sftp.read_dir(&dir).await
            .map_err(|e| format!("读取目录失败: {e}"))?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." { continue; }
            visited += 1;
            if visited > MAX_ENTRIES {
                return Err("目录条目过多（>50000），请改用终端手动删除".to_string());
            }
            let child = join_path(&dir, &name);
            let attrs = e.metadata();
            if attrs.is_dir() && !attrs.is_symlink() {
                stack.push(child);
            } else {
                sftp.remove_file(&child).await.map_err(|e| format!("删除 {child} 失败: {e}"))?;
            }
        }
    }
    for d in dirs.iter().rev() {
        sftp.remove_dir(d).await.map_err(|e| format!("删除目录 {d} 失败: {e}"))?;
    }
    Ok(())
}

pub async fn rename(config: &ConnConfig, password: Option<&str>, from: &str, to: &str) -> Result<(), String> {
    validate_sftp_path(from)?;
    validate_sftp_path(to)?;
    with_retry!(config, password, |sftp| {
        sftp.rename(from, to).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("重命名失败: {e}"))
}

pub async fn mkdir(config: &ConnConfig, password: Option<&str>, path: &str) -> Result<(), String> {
    validate_sftp_path(path)?;
    with_retry!(config, password, |sftp| {
        sftp.create_dir(path).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("创建目录失败: {e}"))
}

pub async fn chmod(config: &ConnConfig, password: Option<&str>, path: &str, mode: u32) -> Result<(), String> {
    validate_sftp_path(path)?;
    // 只携带 permissions 属性：附带 size 等字段会触发 SETSTAT 截断文件
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(mode);
    with_retry!(config, password, |sftp| {
        sftp.set_metadata(path, attrs.clone()).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("修改权限失败: {e}"))
}

// ── 传输（流式 + 进度事件 + 可取消） ──────────────────────

#[derive(Clone, Serialize)]
pub struct TransferProgress {
    pub id: String,
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    pub name: String,
    pub direction: String, // upload | download
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cancel_transfer(transfer_id: &str) {
    if let Some(flag) = safe_lock(cancels()).get(transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

struct CancelGuard(String);
impl Drop for CancelGuard {
    fn drop(&mut self) { safe_lock(cancels()).remove(&self.0); }
}

fn register_cancel(transfer_id: &str) -> (Arc<AtomicBool>, CancelGuard) {
    let flag = Arc::new(AtomicBool::new(false));
    safe_lock(cancels()).insert(transfer_id.to_string(), flag.clone());
    (flag, CancelGuard(transfer_id.to_string()))
}

const CHUNK: usize = 64 * 1024;
/// 进度节流：至少传输 512KB 或距上次 ≥150ms 才发事件，避免事件风暴拖慢传输
const PROGRESS_BYTES: u64 = 512 * 1024;
const PROGRESS_MS: u128 = 150;

struct ProgressEmitter<'a> {
    app: &'a tauri::AppHandle,
    base: TransferProgress,
    last_bytes: u64,
    last_at: std::time::Instant,
}

impl<'a> ProgressEmitter<'a> {
    fn new(app: &'a tauri::AppHandle, conn_id: &str, transfer_id: &str, name: &str, direction: &str, total: u64) -> Self {
        Self {
            app,
            base: TransferProgress {
                id: conn_id.to_string(),
                transfer_id: transfer_id.to_string(),
                name: name.to_string(),
                direction: direction.to_string(),
                transferred: 0,
                total,
                done: false,
                error: None,
            },
            last_bytes: 0,
            last_at: std::time::Instant::now(),
        }
    }

    fn tick(&mut self, transferred: u64) {
        if transferred - self.last_bytes < PROGRESS_BYTES
            && self.last_at.elapsed().as_millis() < PROGRESS_MS {
            return;
        }
        self.last_bytes = transferred;
        self.last_at = std::time::Instant::now();
        let mut p = self.base.clone();
        p.transferred = transferred;
        let _ = self.app.emit("sftp:progress", p);
    }

    fn finish(&self, transferred: u64, error: Option<String>) {
        let mut p = self.base.clone();
        p.transferred = transferred;
        p.done = true;
        p.error = error;
        let _ = self.app.emit("sftp:progress", p);
    }
}

/// 下载远程文件到本地目录，返回本地路径
pub async fn download(
    config: &ConnConfig,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &std::path::Path,
    transfer_id: &str,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    validate_sftp_path(remote_path)?;
    let filename = remote_path.rsplit('/').next().unwrap_or("download").to_string();
    let local_path = local_dir.join(&filename);

    let (conn, from_cache) = acquire(config, password).await?;
    // 打开远程文件（传输层错误重试一次）
    let open = conn.sftp.open(remote_path).await;
    let (conn, file) = match open {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate(&config.id);
            let (conn, _) = acquire(config, password).await?;
            let f = conn.sftp.open(remote_path).await
                .map_err(|e| format!("打开远程文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("打开远程文件失败: {e}")),
    };

    let total = file.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
    let mut remote = tokio::io::BufReader::with_capacity(CHUNK * 4, file);
    let mut local = tokio::fs::File::create(&local_path).await
        .map_err(|e| format!("创建本地文件失败: {e}"))?;

    let (cancel, _guard) = register_cancel(transfer_id);
    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id, &filename, "download", total);
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(local);
            let _ = tokio::fs::remove_file(&local_path).await;
            emitter.finish(transferred, Some("已取消".to_string()));
            return Err("传输已取消".to_string());
        }
        let n = tokio::time::timeout(std::time::Duration::from_secs(60), remote.read(&mut buf)).await
            .map_err(|_| { emitter.finish(transferred, Some("读取超时".into())); "读取远程文件超时".to_string() })?;
        let n = n.map_err(|e| { emitter.finish(transferred, Some(e.to_string())); format!("读取远程文件失败: {e}") })?;
        if n == 0 { break; }
        local.write_all(&buf[..n]).await
            .map_err(|e| { emitter.finish(transferred, Some(e.to_string())); format!("写入本地文件失败: {e}") })?;
        transferred += n as u64;
        emitter.tick(transferred);
    }
    local.flush().await.map_err(|e| format!("刷新本地文件失败: {e}"))?;
    drop(conn);
    emitter.finish(transferred, None);
    Ok(local_path.to_string_lossy().into_owned())
}

/// 从本地路径流式上传到远程
pub async fn upload(
    config: &ConnConfig,
    password: Option<&str>,
    local_path: &std::path::Path,
    remote_path: &str,
    transfer_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    validate_sftp_path(remote_path)?;
    if !local_path.is_absolute() {
        return Err("本地路径必须是绝对路径".to_string());
    }
    let meta = tokio::fs::metadata(local_path).await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("只支持上传单个文件".to_string());
    }
    let total = meta.len();
    let filename = local_path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string());

    let (conn, from_cache) = acquire(config, password).await?;
    let create = conn.sftp.create(remote_path).await;
    let (conn, file) = match create {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate(&config.id);
            let (conn, _) = acquire(config, password).await?;
            let f = conn.sftp.create(remote_path).await
                .map_err(|e| format!("创建远程文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("创建远程文件失败: {e}")),
    };

    let mut local = tokio::fs::File::open(local_path).await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let mut remote = tokio::io::BufWriter::with_capacity(CHUNK * 4, file);

    let (cancel, _guard) = register_cancel(transfer_id);
    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id, &filename, "upload", total);
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            emitter.finish(transferred, Some("已取消".to_string()));
            return Err("传输已取消".to_string());
        }
        let n = local.read(&mut buf).await
            .map_err(|e| { emitter.finish(transferred, Some(e.to_string())); format!("读取本地文件失败: {e}") })?;
        if n == 0 { break; }
        tokio::time::timeout(std::time::Duration::from_secs(60), remote.write_all(&buf[..n])).await
            .map_err(|_| { emitter.finish(transferred, Some("写入超时".into())); "写入远程文件超时".to_string() })?
            .map_err(|e| { emitter.finish(transferred, Some(e.to_string())); format!("写入远程文件失败: {e}") })?;
        transferred += n as u64;
        emitter.tick(transferred);
    }
    remote.flush().await.map_err(|e| format!("刷新远程文件失败: {e}"))?;
    remote.into_inner().shutdown().await.ok();
    drop(conn);
    emitter.finish(transferred, None);
    Ok(())
}

// ── 递归目录传输 ──────────────────────────────────────────────

const MAX_DIR_FILES: usize = 10_000;

/// 递归下载远程目录到本地 → 返回本地路径
pub async fn download_dir(
    config: &ConnConfig,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &std::path::Path,
    transfer_id: &str,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    validate_sftp_path(remote_path)?;
    let dirname = remote_path.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string();
    let local_dest = local_dir.join(&dirname);

    let (conn, from_cache) = acquire(config, password).await?;
    // 验证是目录
    let meta_res = conn.sftp.metadata(remote_path).await;
    let meta = match meta_res {
        Ok(m) => m,
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate(&config.id);
            let (c2, _) = acquire(config, password).await?;
            c2.sftp.metadata(remote_path).await.map_err(|e| format!("读取目录信息失败: {e}"))?
        }
        Err(e) => return Err(format!("读取目录信息失败: {e}")),
    };
    if !meta.is_dir() {
        return Err("目标不是目录".to_string());
    }

    // 预扫描：(远程路径, 大小)；相对路径用于创建本地文件
    let mut remote_files: Vec<(String, u64)> = Vec::new();
    let mut stack = vec![remote_path.to_string()];
    while let Some(dir) = stack.pop() {
        let entries = conn.sftp.read_dir(&dir).await
            .map_err(|e| format!("读取目录失败 {dir}: {e}"))?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." { continue; }
            // 拒绝服务器回传的含路径分隔符或 ".." 组件的文件名（zip-slip / path traversal 防护）
            if name.contains('/') || name.contains('\\') || name.contains('\0') {
                log::warn!("SFTP 下载：服务器返回含路径分隔符的文件名 {:?}，已跳过", name);
                continue;
            }
            let ep = join_path(&dir, &name);
            let attrs = e.metadata();
            if attrs.is_dir() {
                stack.push(ep);
            } else {
                remote_files.push((ep, attrs.size.unwrap_or(0)));
            }
            if remote_files.len() > MAX_DIR_FILES {
                return Err(format!("目录文件过多（>{MAX_DIR_FILES}），请分批下载"));
            }
        }
    }

    let total_bytes: u64 = remote_files.iter().map(|(_, s)| *s).sum();

    let (cancel, _guard) = register_cancel(transfer_id);
    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id,
        &format!("{dirname}/"), "download", total_bytes);
    let mut transferred_bytes: u64 = 0;

    let prefix = remote_path.trim_end_matches('/');
    for (remote_file, _) in &remote_files {
        if cancel.load(Ordering::Relaxed) {
            emitter.finish(transferred_bytes, Some("已取消".to_string()));
            return Err("传输已取消".to_string());
        }
        let rel = remote_file.strip_prefix(prefix).unwrap_or(remote_file.as_str()).trim_start_matches('/');
        let local_file = local_dest.join(rel);
        if let Some(parent) = local_file.parent() {
            tokio::fs::create_dir_all(parent).await
                .map_err(|e| format!("创建本地目录失败: {e}"))?;
        }

        let file = conn.sftp.open(remote_file).await
            .map_err(|e| format!("打开远程文件失败 {remote_file}: {e}"))?;
        let mut remote_reader = tokio::io::BufReader::with_capacity(CHUNK * 4, file);
        let mut local_writer = tokio::fs::File::create(&local_file).await
            .map_err(|e| format!("创建本地文件失败: {e}"))?;

        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(local_writer);
                let _ = tokio::fs::remove_file(&local_file).await;
                emitter.finish(transferred_bytes, Some("已取消".to_string()));
                return Err("传输已取消".to_string());
            }
            let n = tokio::time::timeout(std::time::Duration::from_secs(60), remote_reader.read(&mut buf)).await
                .map_err(|_| { emitter.finish(transferred_bytes, Some("读取超时".into())); "读取超时".to_string() })?;
            let n = n.map_err(|e| { emitter.finish(transferred_bytes, Some(e.to_string())); format!("读取失败: {e}") })?;
            if n == 0 { break; }
            local_writer.write_all(&buf[..n]).await
                .map_err(|e| { emitter.finish(transferred_bytes, Some(e.to_string())); format!("写入失败: {e}") })?;
            transferred_bytes += n as u64;
            emitter.tick(transferred_bytes);
        }
        local_writer.flush().await.map_err(|e| format!("刷新文件失败: {e}"))?;
    }

    drop(conn);
    emitter.finish(transferred_bytes, None);
    Ok(local_dest.to_string_lossy().into_owned())
}

/// 递归上传本地目录到远程 remote_base/dirname/...
pub async fn upload_dir(
    config: &ConnConfig,
    password: Option<&str>,
    local_path: &std::path::Path,
    remote_base: &str,
    transfer_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    validate_sftp_path(remote_base)?;
    if !local_path.is_absolute() {
        return Err("本地路径必须是绝对路径".to_string());
    }
    let dirname = local_path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string());

    // 收集所有本地文件（绝对路径, 大小）
    let mut local_files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut dir_stack = vec![local_path.to_path_buf()];
    while let Some(dir) = dir_stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await
            .map_err(|e| format!("读取本地目录失败: {e}"))?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| format!("读取条目失败: {e}"))? {
            let ft = entry.file_type().await.map_err(|e| format!("读取文件类型失败: {e}"))?;
            if ft.is_dir() {
                dir_stack.push(entry.path());
            } else if ft.is_file() {
                let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                local_files.push((entry.path(), size));
            }
            if local_files.len() > MAX_DIR_FILES {
                return Err(format!("本地目录文件过多（>{MAX_DIR_FILES}），请分批上传"));
            }
        }
    }

    let total_bytes: u64 = local_files.iter().map(|(_, s)| *s).sum();

    let (conn, from_cache) = acquire(config, password).await?;
    let remote_root = join_path(remote_base, &dirname);

    // 预建目录
    let mk_res = conn.sftp.create_dir(&remote_root).await;
    if let Err(e) = mk_res {
        if from_cache && is_transport_err(&e.to_string()) {
            invalidate(&config.id);
            let (c2, _) = acquire(config, password).await?;
            c2.sftp.create_dir(&remote_root).await.ok();
        }
        // 目录已存在 → 忽略
    }

    let (cancel, _guard) = register_cancel(transfer_id);
    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id,
        &format!("{dirname}/"), "upload", total_bytes);
    let mut transferred_bytes: u64 = 0;

    let local_prefix = local_path;
    for (local_file, _) in &local_files {
        if cancel.load(Ordering::Relaxed) {
            emitter.finish(transferred_bytes, Some("已取消".to_string()));
            return Err("传输已取消".to_string());
        }
        let rel = local_file.strip_prefix(local_prefix)
            .map_err(|_| "路径前缀错误".to_string())?;
        // 将 OS 路径分隔符转为 SFTP 用的 /
        let rel_str: String = rel.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>().join("/");
        let remote_file = join_path(&remote_root, &rel_str);

        // 确保父目录存在
        if let Some(p) = std::path::Path::new(&remote_file).parent() {
            let pd = p.to_string_lossy().into_owned();
            conn.sftp.create_dir(&pd).await.ok(); // 已存在时忽略错误
        }

        let mut local_reader = tokio::fs::File::open(local_file).await
            .map_err(|e| format!("打开本地文件失败: {e}"))?;
        let file = conn.sftp.create(&remote_file).await
            .map_err(|e| format!("创建远程文件失败 {remote_file}: {e}"))?;
        let mut remote_writer = tokio::io::BufWriter::with_capacity(CHUNK * 4, file);

        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                emitter.finish(transferred_bytes, Some("已取消".to_string()));
                return Err("传输已取消".to_string());
            }
            let n = local_reader.read(&mut buf).await
                .map_err(|e| { emitter.finish(transferred_bytes, Some(e.to_string())); format!("读取本地文件失败: {e}") })?;
            if n == 0 { break; }
            tokio::time::timeout(std::time::Duration::from_secs(60), remote_writer.write_all(&buf[..n])).await
                .map_err(|_| { emitter.finish(transferred_bytes, Some("写入超时".into())); "写入超时".to_string() })?
                .map_err(|e| { emitter.finish(transferred_bytes, Some(e.to_string())); format!("写入远程文件失败: {e}") })?;
            transferred_bytes += n as u64;
            emitter.tick(transferred_bytes);
        }
        remote_writer.flush().await.map_err(|e| format!("刷新远程文件失败: {e}"))?;
        remote_writer.into_inner().shutdown().await.ok();
    }

    drop(conn);
    emitter.finish(transferred_bytes, None);
    Ok(())
}

/// 在线编辑：读远程文本文件（最大 max_bytes）
pub async fn read_text_file(
    config: &ConnConfig,
    password: Option<&str>,
    path: &str,
    max_bytes: u64,
) -> Result<String, String> {
    validate_sftp_path(path)?;
    let (conn, from_cache) = acquire(config, password).await?;
    let open = conn.sftp.open(path).await;
    let (conn, file) = match open {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate(&config.id);
            let (conn, _) = acquire(config, password).await?;
            let f = conn.sftp.open(path).await.map_err(|e| format!("打开远程文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("打开远程文件失败: {e}")),
    };
    // metadata 失败不降级，避免绕过大小检查
    let meta_size = file.metadata().await
        .map_err(|e| format!("获取文件元数据失败: {e}"))?
        .size;  // Option<u64>，None 表示服务器未上报文件大小

    // 服务器明确上报 size 且超限，提前拒绝，避免无效读取
    if let Some(size) = meta_size {
        if size > max_bytes {
            return Err(format!("文件过大（{} MB），在线编辑限制 {} MB",
                size / 1024 / 1024, max_bytes / 1024 / 1024));
        }
    }
    // take(max_bytes+1) 双重保护：即使服务器谎报 size 或未上报，也截止于 max_bytes
    let cap = meta_size.unwrap_or(0).min(max_bytes) as usize;
    let mut remote = tokio::io::AsyncReadExt::take(
        tokio::io::BufReader::with_capacity(CHUNK * 4, file),
        max_bytes + 1,
    );
    let mut buf = Vec::with_capacity(cap);
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        remote.read_to_end(&mut buf),
    ).await
        .map_err(|_| "读取超时（30s）".to_string())?
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if buf.len() as u64 > max_bytes {
        return Err(format!("文件实际内容超过在线编辑限制 {} MB", max_bytes / 1024 / 1024));
    }
    drop(conn);
    String::from_utf8(buf).map_err(|_| "文件包含非 UTF-8 内容，无法在线编辑".to_string())
}

/// 在线编辑：原子写远程文件（写临时文件 → rename，失败时不破坏原文件）
pub async fn write_file(
    config: &ConnConfig,
    password: Option<&str>,
    path: &str,
    content: Vec<u8>,
) -> Result<(), String> {
    validate_sftp_path(path)?;
    let (conn, from_cache) = acquire(config, password).await?;
    let tmp_path = format!("{path}.dbterm_tmp");
    let open = conn.sftp.create(&tmp_path).await;
    let (conn, mut file) = match open {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate(&config.id);
            let (conn, _) = acquire(config, password).await?;
            let f = conn.sftp.create(&tmp_path).await.map_err(|e| format!("创建临时文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("创建临时文件失败: {e}")),
    };
    let write_res = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        async {
            file.write_all(&content).await.map_err(|e| format!("写入失败: {e}"))?;
            file.flush().await.map_err(|e| format!("刷新失败: {e}"))
        },
    ).await;
    // 超时与写失败都需要清理临时文件；分别处理以保证 cleanup 路径覆盖完整
    match write_res {
        Err(_elapsed) => {
            // 写入超时，尽力清理临时文件
            let _ = conn.sftp.remove_file(&tmp_path).await;
            drop(conn);
            return Err("写入超时（30s）".to_string());
        }
        Ok(Err(e)) => {
            // write_all / flush 失败，尽力清理临时文件
            let _ = conn.sftp.remove_file(&tmp_path).await;
            drop(conn);
            return Err(e);
        }
        Ok(Ok(())) => {}
    }
    drop(file);
    // 原子替换；rename 失败时清理临时文件
    if let Err(e) = conn.sftp.rename(&tmp_path, path).await {
        let _ = conn.sftp.remove_file(&tmp_path).await;
        drop(conn);
        return Err(format!("重命名临时文件失败: {e}"));
    }
    drop(conn);
    Ok(())
}
