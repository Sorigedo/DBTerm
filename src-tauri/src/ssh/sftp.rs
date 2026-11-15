//! 真 SFTP 实现：会话池复用 + 流式传输进度 + SUDO 模式
//!
//! 安全：所有路径直接走 SFTP 协议报文，无 shell 拼接，从根本上消除命令注入面。
//! 性能：每个连接缓存一条 SSH+SFTP 会话复用，避免每次文件操作重新握手认证。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

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

fn cached_session<T>(sessions: &Mutex<HashMap<String, Arc<T>>>, conn_id: &str) -> Option<Arc<T>> {
    safe_lock(sessions).get(conn_id).cloned()
}

pub fn invalidate(conn_id: &str) {
    safe_lock(pool()).remove(conn_id);
}

/// A failed operation must never evict a replacement installed by another task.
fn invalidate_session(conn_id: &str, failed: &Arc<SftpConn>) {
    let mut sessions = safe_lock(pool());
    remove_matching_session(&mut sessions, conn_id, failed);
}

/// Early returns (including cancellation/timeouts) must not leave an uncertain
/// transfer session in the pool. Existing concurrent users retain their Arc.
struct TransferSessionGuard {
    conn_id: String,
    conn: Arc<SftpConn>,
    succeeded: bool,
}

impl TransferSessionGuard {
    fn new(conn_id: &str, conn: &Arc<SftpConn>) -> Self {
        Self { conn_id: conn_id.into(), conn: conn.clone(), succeeded: false }
    }
    fn succeed(&mut self) { self.succeeded = true; }
}

impl Drop for TransferSessionGuard {
    fn drop(&mut self) {
        if !self.succeeded { invalidate_session(&self.conn_id, &self.conn); }
    }
}

async fn create_upload_temp(sftp: &SftpSession, target: &str) -> Result<(String, russh_sftp::client::fs::File), String> {
    use russh_sftp::protocol::OpenFlags;
    let parent = target.rsplit_once('/').map(|(p, _)| p).unwrap_or(".");
    let temporary = format!("{parent}/.dbterm-upload-{}", uuid::Uuid::new_v4());
    let mut attributes = FileAttributes::empty();
    // A failed/cancelled upload may leave the staging file behind. Its data
    // must never be exposed through a permissive server umask.
    attributes.permissions = Some(0o600);
    let file = sftp.open_with_flags_and_attributes(&temporary,
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE, attributes).await
        .map_err(|e| format!("创建上传临时文件失败: {e}"))?;
    Ok((temporary, file))
}

async fn preserve_upload_attributes(sftp: &SftpSession, temporary: &str, target: &str) -> Result<(), String> {
    match sftp.symlink_metadata(target).await {
        Ok(original) => {
            if original.is_symlink() { return Err("目标是符号链接，已拒绝替换链接本身，请选择真实文件路径".into()); }
            let mut attrs = FileAttributes::empty();
            attrs.permissions = Some(original.permissions.ok_or("服务器未返回原文件权限，无法安全替换")? & 0o7777);
            attrs.uid = original.uid;
            attrs.gid = original.gid;
            sftp.set_metadata(temporary, attrs).await
                .map_err(|e| format!("保留原文件权限/所有者失败，原文件未修改: {e}"))?;
        }
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => {}
        Err(error) => return Err(format!("检查目标文件失败，已拒绝提交上传: {error}")),
    }
    Ok(())
}

async fn commit_upload(sftp: &SftpSession, temporary: &str, target: &str) -> Result<(), String> {
    preserve_upload_attributes(sftp, temporary, target).await
        .map_err(|e| format!("{e}；临时文件位于 {temporary}"))?;
    // Standard SFTP servers may reject overwrite. Never delete the original as
    // a fallback: failure must preserve it even if atomic replacement is absent.
    sftp.rename(temporary, target).await.map_err(|e|
        format!("提交上传失败，未删除原文件；临时文件位于 {temporary}: {e}"))
}

async fn cleanup_upload_temp(sftp: &SftpSession, temporary: &str) {
    let _ = sftp.remove_file(temporary).await;
}

async fn commit_upload_unless_cancelled(
    sftp: &SftpSession, temporary: &str, target: &str, cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }
    commit_upload(sftp, temporary, target).await
}

fn remove_matching_session<T>(sessions: &mut HashMap<String, Arc<T>>, conn_id: &str, failed: &Arc<T>) {
    if sessions.get(conn_id).is_some_and(|current| Arc::ptr_eq(current, failed)) {
        sessions.remove(conn_id);
    }
}

/// 取会话：命中缓存直接复用；返回 (会话, 是否来自缓存)
async fn acquire(config: &ConnConfig, password: Option<&str>) -> Result<(Arc<SftpConn>, bool), String> {
    // Drop the MutexGuard before the if body: a guard in an `if let`
    // scrutinee lives through the body and would deadlock on invalidation.
    let cached = cached_session(pool(), &config.id);
    if let Some(c) = cached {
        if c.updated_at == config.updated_at && !c._handle.is_closed() {
            return Ok((c, true));
        }
        invalidate_session(&config.id, &c);
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
    let lower = msg.to_ascii_lowercase();
    msg.contains("I/O:") || msg == "Timeout" || msg.ends_with(": Timeout")
        || msg.contains("Unexpected packet") || msg.contains("SendError") || msg.contains("RecvError")
        || msg.contains("Unexpected EOF")
        // russh-sftp formats its local transport status as `7: Connection lost`
        // and `6: No connection`; neither contains the old matcher tokens above.
        || lower.contains("7: connection lost") || lower.contains("6: no connection")
        || lower.contains("sender dropped") || lower.contains("session closed")
}

/// 统一重试包装：缓存会话遇传输层错误时重建会话再试一次
macro_rules! with_retry {
    ($config:expr, $password:expr, |$sftp:ident| $body:expr) => {{
        let (conn, from_cache) = acquire($config, $password).await?;
        let $sftp = &conn.sftp;
        let first = $body;
        match first {
            Err(ref e) if from_cache && is_transport_err(e) => {
                invalidate_session(&$config.id, &conn);
                let (conn, _) = acquire($config, $password).await?;
                let $sftp = &conn.sftp;
                $body
            }
            other => other,
        }
    }};
}

// A transport failure may happen after the server applied a mutation. Never
// replay delete/rename/mkdir/chmod automatically: reconnect only on the next
// explicit operation, and tell the caller the outcome needs verification.
macro_rules! with_mutation {
    ($config:expr, $password:expr, |$sftp:ident| $body:expr) => {{
        let (conn, _) = acquire($config, $password).await?;
        let $sftp = &conn.sftp;
        let result = $body;
        match result {
            Err(ref e) if is_transport_err(e) => {
                invalidate_session(&$config.id, &conn);
                Err(format!("连接中断，操作结果未确认，请刷新核对后再操作: {e}"))
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

fn safe_download_entry_name(name: &str) -> bool {
    name != "." && name != ".." && !name.contains('/') && !name.contains('\\') && !name.contains('\0')
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
    with_mutation!(config, password, |sftp| {
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
    with_mutation!(config, password, |sftp| {
        sftp.rename(from, to).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("重命名失败: {e}"))
}

pub async fn mkdir(config: &ConnConfig, password: Option<&str>, path: &str) -> Result<(), String> {
    validate_sftp_path(path)?;
    with_mutation!(config, password, |sftp| {
        sftp.create_dir(path).await.map_err(|e| e.to_string())
    }).map_err(|e| format!("创建目录失败: {e}"))
}

pub async fn chmod(config: &ConnConfig, password: Option<&str>, path: &str, mode: u32) -> Result<(), String> {
    validate_sftp_path(path)?;
    // 只携带 permissions 属性：附带 size 等字段会触发 SETSTAT 截断文件
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(mode);
    with_mutation!(config, password, |sftp| {
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

struct CancelState {
    flag: Arc<AtomicBool>,
    registered: bool,
    created_at: std::time::Instant,
}

static CANCELS: OnceLock<Mutex<HashMap<String, CancelState>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, CancelState>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cancel_transfer(transfer_id: &str) {
    let mut states = safe_lock(cancels());
    states.retain(|_, state| state.registered || state.created_at.elapsed().as_secs() < 120);
    if let Some(state) = states.get(transfer_id) {
        state.flag.store(true, Ordering::Relaxed);
    } else if !transfer_id.is_empty() && states.values().filter(|state| !state.registered).count() < 1024 {
        states.insert(transfer_id.to_string(), CancelState {
            flag: Arc::new(AtomicBool::new(true)), registered: false, created_at: std::time::Instant::now(),
        });
    }
}

struct CancelGuard { id: String, flag: Arc<AtomicBool> }
impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut states = safe_lock(cancels());
        if states.get(&self.id).is_some_and(|state| Arc::ptr_eq(&state.flag, &self.flag)) {
            states.remove(&self.id);
        }
    }
}

fn register_cancel(transfer_id: &str) -> (Arc<AtomicBool>, CancelGuard) {
    let mut states = safe_lock(cancels());
    states.retain(|_, state| state.registered || state.created_at.elapsed().as_secs() < 120);
    let flag = match states.remove(transfer_id) {
        Some(state) if !state.registered => state.flag,
        _ => Arc::new(AtomicBool::new(false)),
    };
    states.insert(transfer_id.to_string(), CancelState {
        flag: flag.clone(), registered: true, created_at: std::time::Instant::now(),
    });
    (flag.clone(), CancelGuard { id: transfer_id.to_string(), flag })
}

/// Keep incomplete downloads in a unique sibling until every byte is flushed.
/// Dropping an uncommitted stage removes only our own temporary path.
struct LocalDownloadStage { path: PathBuf, directory: bool, committed: bool }

impl LocalDownloadStage {
    fn temporary_path(target: &Path) -> Result<PathBuf, String> {
        let parent = target.parent().ok_or("下载目标没有父目录")?;
        Ok(parent.join(format!(".dbterm-download-{}", uuid::Uuid::new_v4())))
    }

    async fn file(target: &Path) -> Result<(Self, tokio::fs::File), String> {
        let path = Self::temporary_path(target)?;
        let file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await
            .map_err(|e| format!("创建下载临时文件失败: {e}"))?;
        Ok((Self { path, directory: false, committed: false }, file))
    }

    async fn directory(target: &Path) -> Result<Self, String> {
        if tokio::fs::symlink_metadata(target).await.is_ok() {
            return Err(format!("本地目录已存在，已拒绝覆盖: {}", target.display()));
        }
        let path = Self::temporary_path(target)?;
        tokio::fs::create_dir(&path).await.map_err(|e| format!("创建下载临时目录失败: {e}"))?;
        Ok(Self { path, directory: true, committed: false })
    }

    fn path(&self) -> &Path { &self.path }

    async fn commit(mut self, target: &Path) -> Result<(), String> {
        if self.directory && tokio::fs::symlink_metadata(target).await.is_ok() {
            return Err(format!("本地目录已存在，已拒绝覆盖: {}", target.display()));
        }
        if !self.directory {
            match tokio::fs::symlink_metadata(target).await {
                Ok(metadata) if !metadata.file_type().is_file() =>
                    return Err(format!("本地目标不是普通文件，已拒绝覆盖: {}", target.display())),
                Err(error) if error.kind() != std::io::ErrorKind::NotFound =>
                    return Err(format!("检查本地目标失败，原目标未修改: {error}")),
                _ => {}
            }
        }
        tokio::fs::rename(&self.path, target).await
            .map_err(|e| format!("提交本地下载失败，原目标未修改: {e}"))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for LocalDownloadStage {
    fn drop(&mut self) {
        if self.committed { return; }
        if self.directory { let _ = std::fs::remove_dir_all(&self.path); }
        else { let _ = std::fs::remove_file(&self.path); }
    }
}

async fn copy_download_stream<R: AsyncRead + Unpin>(
    remote: &mut R,
    local: &mut tokio::fs::File,
    cancel: &AtomicBool,
    transferred: &mut u64,
    mut tick: impl FnMut(u64),
) -> Result<(), String> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }
        let n = tokio::time::timeout(std::time::Duration::from_secs(60), remote.read(&mut buf)).await
            .map_err(|_| "读取远程文件超时".to_string())?
            .map_err(|e| format!("读取远程文件失败: {e}"))?;
        if n == 0 { break; }
        local.write_all(&buf[..n]).await.map_err(|e| format!("写入本地文件失败: {e}"))?;
        *transferred += n as u64;
        tick(*transferred);
    }
    local.flush().await.map_err(|e| format!("刷新本地文件失败: {e}"))?;
    Ok(())
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
    let (cancel, _guard) = register_cancel(transfer_id);
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }

    let (conn, from_cache) = acquire(config, password).await?;
    // 打开远程文件（传输层错误重试一次）
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let open = conn.sftp.open(remote_path).await;
    let (conn, file) = match open {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate_session(&config.id, &conn);
            let (conn, _) = acquire(config, password).await?;
            session_guard.conn = conn.clone();
            let f = conn.sftp.open(remote_path).await
                .map_err(|e| format!("打开远程文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("打开远程文件失败: {e}")),
    };

    session_guard.conn = conn.clone();
    let total = file.metadata().await.ok().and_then(|m| m.size).unwrap_or(0);
    let mut remote = tokio::io::BufReader::with_capacity(CHUNK * 4, file);
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }
    let (stage, mut local) = LocalDownloadStage::file(&local_path).await?;

    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id, &filename, "download", total);
    let mut transferred: u64 = 0;
    if let Err(error) = copy_download_stream(&mut remote, &mut local, &cancel, &mut transferred,
        |n| emitter.tick(n)).await {
        emitter.finish(transferred, Some(error.clone()));
        return Err(error);
    }
    drop(local);
    if cancel.load(Ordering::Relaxed) {
        emitter.finish(transferred, Some("已取消".to_string()));
        return Err("传输已取消".to_string());
    }
    stage.commit(&local_path).await?;
    session_guard.succeed();
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
    let (cancel, _guard) = register_cancel(transfer_id);
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }
    let meta = tokio::fs::metadata(local_path).await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("只支持上传单个文件".to_string());
    }
    let total = meta.len();
    let filename = local_path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string());

    let mut local = tokio::fs::File::open(local_path).await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let (conn, _) = acquire(config, password).await?;
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let (temporary, file) = create_upload_temp(&conn.sftp, remote_path).await?;
    let mut remote = tokio::io::BufWriter::with_capacity(CHUNK * 4, file);

    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id, &filename, "upload", total);
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            emitter.finish(transferred, Some("已取消".to_string()));
            cleanup_upload_temp(&conn.sftp, &temporary).await;
            return Err("传输已取消".to_string());
        }
        let n = match local.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                emitter.finish(transferred, Some(e.to_string()));
                cleanup_upload_temp(&conn.sftp, &temporary).await;
                return Err(format!("读取本地文件失败: {e}"));
            }
        };
        if n == 0 { break; }
        let write = tokio::time::timeout(std::time::Duration::from_secs(60), remote.write_all(&buf[..n])).await;
        let write_error = match write {
            Err(_) => Some("写入远程文件超时".to_string()),
            Ok(Err(e)) => Some(format!("写入远程文件失败: {e}")),
            Ok(Ok(())) => None,
        };
        if let Some(error) = write_error {
            emitter.finish(transferred, Some(error.clone()));
            cleanup_upload_temp(&conn.sftp, &temporary).await;
            return Err(error);
        }
        transferred += n as u64;
        emitter.tick(transferred);
    }
    if let Err(e) = remote.flush().await {
        cleanup_upload_temp(&conn.sftp, &temporary).await;
        return Err(format!("刷新远程文件失败: {e}"));
    }
    if let Err(e) = remote.into_inner().shutdown().await {
        cleanup_upload_temp(&conn.sftp, &temporary).await;
        return Err(format!("关闭上传文件失败: {e}"));
    }
    if let Err(e) = commit_upload_unless_cancelled(&conn.sftp, &temporary, remote_path, &cancel).await {
        if e != "传输已取消" && is_transport_err(&e) {
            return Err(format!("{e}；远端临时文件可能残留于 {temporary}"));
        }
        cleanup_upload_temp(&conn.sftp, &temporary).await;
        emitter.finish(transferred, Some(e.clone()));
        return Err(e);
    }
    session_guard.succeed();
    drop(conn);
    emitter.finish(transferred, None);
    Ok(())
}

// ── 递归目录传输 ──────────────────────────────────────────────

const MAX_DIR_FILES: usize = 10_000;
const MAX_DIR_ENTRIES: usize = 50_000;

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
    let (cancel, _guard) = register_cancel(transfer_id);
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }

    let (conn, from_cache) = acquire(config, password).await?;
    // 验证是目录
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let meta_res = conn.sftp.metadata(remote_path).await;
    let (conn, meta) = match meta_res {
        Ok(m) => (conn, m),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate_session(&config.id, &conn);
            let (c2, _) = acquire(config, password).await?;
            session_guard.conn = c2.clone();
            let meta = c2.sftp.metadata(remote_path).await.map_err(|e| format!("读取目录信息失败: {e}"))?;
            (c2, meta)
        }
        Err(e) => return Err(format!("读取目录信息失败: {e}")),
    };
    if !meta.is_dir() {
        return Err("目标不是目录".to_string());
    }

    session_guard.conn = conn.clone();
    // 预扫描：(远程路径, 大小)；相对路径用于创建本地文件
    let mut remote_files: Vec<(String, u64)> = Vec::new();
    let mut stack = vec![remote_path.to_string()];
    let mut visited_entries = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = conn.sftp.read_dir(&dir).await
            .map_err(|e| format!("读取目录失败 {dir}: {e}"))?;
        for e in entries {
            let name = e.file_name();
            if !safe_download_entry_name(&name) {
                log::warn!("SFTP 下载：服务器返回含路径分隔符的文件名 {:?}，已跳过", name);
                continue;
            }
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > MAX_DIR_ENTRIES {
                return Err(format!("目录条目过多（>{MAX_DIR_ENTRIES}），请分批下载"));
            }
            let ep = join_path(&dir, &name);
            let attrs = e.metadata();
            if attrs.is_dir() && !attrs.is_symlink() {
                stack.push(ep);
            } else if !attrs.is_symlink() {
                remote_files.push((ep, attrs.size.unwrap_or(0)));
                if remote_files.len() > MAX_DIR_FILES {
                    return Err(format!("目录文件过多（>{MAX_DIR_FILES}），请分批下载"));
                }
            }
        }
    }

    let total_bytes = remote_files.iter().try_fold(0u64, |sum, (_, size)| sum.checked_add(*size))
        .ok_or("目录总大小超出可支持范围")?;

    let mut emitter = ProgressEmitter::new(app, &config.id, transfer_id,
        &format!("{dirname}/"), "download", total_bytes);
    let mut transferred_bytes: u64 = 0;
    if cancel.load(Ordering::Relaxed) {
        emitter.finish(0, Some("已取消".to_string()));
        return Err("传输已取消".to_string());
    }
    let stage = LocalDownloadStage::directory(&local_dest).await?;

    let prefix = remote_path.trim_end_matches('/');
    for (remote_file, _) in &remote_files {
        if cancel.load(Ordering::Relaxed) {
            emitter.finish(transferred_bytes, Some("已取消".to_string()));
            return Err("传输已取消".to_string());
        }
        let rel = remote_file.strip_prefix(prefix).unwrap_or(remote_file.as_str()).trim_start_matches('/');
        let local_file = stage.path().join(rel);
        if let Some(parent) = local_file.parent() {
            tokio::fs::create_dir_all(parent).await
                .map_err(|e| format!("创建本地目录失败: {e}"))?;
        }

        let file = conn.sftp.open(remote_file).await
            .map_err(|e| format!("打开远程文件失败 {remote_file}: {e}"))?;
        let mut remote_reader = tokio::io::BufReader::with_capacity(CHUNK * 4, file);
        let mut local_writer = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&local_file).await
            .map_err(|e| format!("创建本地文件失败: {e}"))?;

        if let Err(error) = copy_download_stream(&mut remote_reader, &mut local_writer, &cancel,
            &mut transferred_bytes, |n| emitter.tick(n)).await {
            emitter.finish(transferred_bytes, Some(error.clone()));
            return Err(error);
        }
    }
    if cancel.load(Ordering::Relaxed) {
        emitter.finish(transferred_bytes, Some("已取消".to_string()));
        return Err("传输已取消".to_string());
    }
    stage.commit(&local_dest).await?;

    drop(conn);
    emitter.finish(transferred_bytes, None);
    session_guard.succeed();
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
    let (cancel, _guard) = register_cancel(transfer_id);
    if cancel.load(Ordering::Relaxed) { return Err("传输已取消".to_string()); }
    let dirname = local_path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string());

    // 收集所有本地文件（绝对路径, 大小）
    let mut local_files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut dir_stack = vec![local_path.to_path_buf()];
    let mut visited_entries = 0usize;
    while let Some(dir) = dir_stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await
            .map_err(|e| format!("读取本地目录失败: {e}"))?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| format!("读取条目失败: {e}"))? {
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > MAX_DIR_ENTRIES {
                return Err(format!("本地目录条目过多（>{MAX_DIR_ENTRIES}），请分批上传"));
            }
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

    let total_bytes = local_files.iter().try_fold(0u64, |sum, (_, size)| sum.checked_add(*size))
        .ok_or("本地目录总大小超出可支持范围")?;

    let (conn, _) = acquire(config, password).await?;
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let remote_root = join_path(remote_base, &dirname);

    // 预建目录
    let mk_res = conn.sftp.create_dir(&remote_root).await;
    if let Err(e) = mk_res {
        if is_transport_err(&e.to_string()) {
            return Err(format!("创建远程目录连接中断，请刷新核对: {e}"));
        }
        let attributes = conn.sftp.metadata(&remote_root).await
            .map_err(|_| format!("创建远程目录失败: {e}"))?;
        if !attributes.is_dir() { return Err(format!("目标路径不是目录: {remote_root}")); }
    }

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
        let (temporary, file) = create_upload_temp(&conn.sftp, &remote_file).await?;
        let mut remote_writer = tokio::io::BufWriter::with_capacity(CHUNK * 4, file);

        let mut buf = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                emitter.finish(transferred_bytes, Some("已取消".to_string()));
                cleanup_upload_temp(&conn.sftp, &temporary).await;
                return Err("传输已取消".to_string());
            }
            let n = match local_reader.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => {
                    emitter.finish(transferred_bytes, Some(e.to_string()));
                    cleanup_upload_temp(&conn.sftp, &temporary).await;
                    return Err(format!("读取本地文件失败: {e}"));
                }
            };
            if n == 0 { break; }
            let write = tokio::time::timeout(std::time::Duration::from_secs(60), remote_writer.write_all(&buf[..n])).await;
            let write_error = match write {
                Err(_) => Some("写入超时".to_string()),
                Ok(Err(e)) => Some(format!("写入远程文件失败: {e}")),
                Ok(Ok(())) => None,
            };
            if let Some(error) = write_error {
                emitter.finish(transferred_bytes, Some(error.clone()));
                cleanup_upload_temp(&conn.sftp, &temporary).await;
                return Err(error);
            }
            transferred_bytes += n as u64;
            emitter.tick(transferred_bytes);
        }
        if let Err(e) = remote_writer.flush().await {
            cleanup_upload_temp(&conn.sftp, &temporary).await;
            return Err(format!("刷新远程文件失败: {e}"));
        }
        if let Err(e) = remote_writer.into_inner().shutdown().await {
            cleanup_upload_temp(&conn.sftp, &temporary).await;
            return Err(format!("关闭上传文件失败: {e}"));
        }
        if let Err(e) = commit_upload_unless_cancelled(&conn.sftp, &temporary, &remote_file, &cancel).await {
            if e != "传输已取消" && is_transport_err(&e) {
                return Err(format!("{e}；远端临时文件可能残留于 {temporary}"));
            }
            cleanup_upload_temp(&conn.sftp, &temporary).await;
            emitter.finish(transferred_bytes, Some(e.clone()));
            return Err(e);
        }
    }

    drop(conn);
    emitter.finish(transferred_bytes, None);
    session_guard.succeed();
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
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let open = conn.sftp.open(path).await;
    let (conn, file) = match open {
        Ok(f) => (conn, f),
        Err(e) if from_cache && is_transport_err(&e.to_string()) => {
            invalidate_session(&config.id, &conn);
            let (conn, _) = acquire(config, password).await?;
            session_guard.conn = conn.clone();
            let f = conn.sftp.open(path).await.map_err(|e| format!("打开远程文件失败: {e}"))?;
            (conn, f)
        }
        Err(e) => return Err(format!("打开远程文件失败: {e}")),
    };
    session_guard.conn = conn.clone();
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
    let text = String::from_utf8(buf).map_err(|_| "文件包含非 UTF-8 内容，无法在线编辑".to_string())?;
    session_guard.succeed();
    Ok(text)
}

/// 在线编辑：原子写远程文件（写临时文件 → rename，失败时不破坏原文件）
pub async fn write_file(
    config: &ConnConfig,
    password: Option<&str>,
    path: &str,
    content: Vec<u8>,
) -> Result<(), String> {
    validate_sftp_path(path)?;
    let (conn, _) = acquire(config, password).await?;
    let mut session_guard = TransferSessionGuard::new(&config.id, &conn);
    let (tmp_path, mut file) = create_upload_temp(&conn.sftp, path).await?;
    let write_res = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        async {
            file.write_all(&content).await.map_err(|e| format!("写入失败: {e}"))?;
            file.flush().await.map_err(|e| format!("刷新失败: {e}"))?;
            file.shutdown().await.map_err(|e| format!("关闭文件失败: {e}"))
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
    // No destructive fallback when the destination already exists.
    if let Err(e) = commit_upload(&conn.sftp, &tmp_path, path).await {
        let _ = conn.sftp.remove_file(&tmp_path).await;
        drop(conn);
        return Err(format!("重命名临时文件失败: {e}"));
    }
    drop(conn);
    session_guard.succeed();
    Ok(())
}

#[cfg(test)]
#[path = "sftp_integration_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::{cached_session, cancel_transfer, cancels, copy_download_stream, is_transport_err, register_cancel, remove_matching_session, LocalDownloadStage};
    use std::{collections::HashMap, io, pin::Pin, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, task::{Context, Poll}};
    use tokio::io::{AsyncRead, AsyncWriteExt};

    #[test]
    fn directory_download_rejects_dot_components_and_path_separators() {
        for unsafe_name in [".", "..", "../outside", "nested/file", r"nested\file", "nul\0name"] {
            assert!(!super::safe_download_entry_name(unsafe_name), "accepted unsafe remote entry {unsafe_name:?}");
        }
        for safe_name in ["report.csv", "中文 文件.txt", "..."] {
            assert!(super::safe_download_entry_name(safe_name), "rejected ordinary filename {safe_name:?}");
        }
    }

    struct FailingReader { sent: bool }
    impl AsyncRead for FailingReader {
        fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> Poll<io::Result<()>> {
            if self.sent { return Poll::Ready(Err(io::Error::other("injected read failure"))); }
            self.sent = true;
            buf.put_slice(b"partial");
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn cancellation_before_transfer_registration_is_not_lost() {
        let id = format!("early-cancel-{}", uuid::Uuid::new_v4());
        cancel_transfer(&id);
        let (flag, guard) = register_cancel(&id);
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        drop(guard);
        assert!(!cancels().lock().unwrap().contains_key(&id));
    }

    #[tokio::test]
    async fn local_download_stage_preserves_original_until_commit() {
        let root = std::env::temp_dir().join(format!("dbterm-download-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = root.join("existing.txt");
        tokio::fs::write(&target, b"original").await.unwrap();
        {
            let (stage, mut file) = LocalDownloadStage::file(&target).await.unwrap();
            file.write_all(b"partial").await.unwrap();
            drop(file);
            drop(stage);
        }
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        let (stage, mut file) = LocalDownloadStage::file(&target).await.unwrap();
        file.write_all(b"complete").await.unwrap();
        file.flush().await.unwrap();
        drop(file);
        stage.commit(&target).await.unwrap();
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"complete");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[tokio::test]
    async fn failed_or_cancelled_download_keeps_old_bytes() {
        let root = std::env::temp_dir().join(format!("dbterm-download-fail-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = root.join("existing.txt");
        tokio::fs::write(&target, b"original").await.unwrap();
        let (stage, mut file) = LocalDownloadStage::file(&target).await.unwrap();
        let mut transferred = 0;
        let error = copy_download_stream(&mut FailingReader { sent: false }, &mut file,
            &AtomicBool::new(false), &mut transferred, |_| {}).await.unwrap_err();
        assert!(error.contains("injected read failure"));
        drop(file);
        drop(stage);
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        let (stage, mut file) = LocalDownloadStage::file(&target).await.unwrap();
        let cancel = AtomicBool::new(false);
        let mut transferred = 0;
        let error = copy_download_stream(&mut tokio::io::repeat(1), &mut file, &cancel,
            &mut transferred, |_| { cancel.store(true, Ordering::Relaxed) }).await.unwrap_err();
        assert_eq!(error, "传输已取消");
        drop(file);
        drop(stage);
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[tokio::test]
    async fn directory_stage_does_not_merge_or_overwrite_existing_destination() {
        let root = std::env::temp_dir().join(format!("dbterm-dir-test-{}", uuid::Uuid::new_v4()));
        let target = root.join("existing");
        tokio::fs::create_dir_all(&target).await.unwrap();
        tokio::fs::write(target.join("old.txt"), b"original").await.unwrap();
        assert!(LocalDownloadStage::directory(&target).await.is_err());
        assert_eq!(tokio::fs::read(target.join("old.txt")).await.unwrap(), b"original");
        let fresh = root.join("fresh");
        {
            let stage = LocalDownloadStage::directory(&fresh).await.unwrap();
            tokio::fs::write(stage.path().join("partial.txt"), b"partial").await.unwrap();
            drop(stage);
        }
        assert!(!fresh.exists());
        let stage = LocalDownloadStage::directory(&fresh).await.unwrap();
        tokio::fs::write(stage.path().join("done.txt"), b"complete").await.unwrap();
        stage.commit(&fresh).await.unwrap();
        assert_eq!(tokio::fs::read(fresh.join("done.txt")).await.unwrap(), b"complete");
        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[test]
    fn cached_lookup_releases_pool_lock_before_invalidation() {
        let original = Arc::new(1);
        let pool = Mutex::new(HashMap::from([("server".to_string(), original.clone())]));
        if let Some(cached) = cached_session(&pool, "server") {
            let mut guard = pool.try_lock().expect("cached lookup must release the lock before its caller's if body");
            remove_matching_session(&mut guard, "server", &cached);
        }
        assert!(pool.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_failure_does_not_evict_a_reconnected_session() {
        let stale = Arc::new(1);
        let replacement = Arc::new(2);
        let mut pool = HashMap::from([("server".to_string(), replacement.clone())]);
        remove_matching_session(&mut pool, "server", &stale);
        assert!(Arc::ptr_eq(pool.get("server").unwrap(), &replacement));
        remove_matching_session(&mut pool, "server", &replacement);
        assert!(pool.is_empty());
    }

    #[test]
    fn recognizes_closed_sftp_session_errors_as_retryable() {
        assert!(is_transport_err("7: Connection lost"));
        assert!(is_transport_err("sender dropped"));
        assert!(is_transport_err("session closed"));
        assert!(is_transport_err("I/O: broken pipe"));
        assert!(is_transport_err("读取文件信息失败: I/O: broken pipe"));
        assert!(is_transport_err("删除失败: Timeout"));
        assert!(!is_transport_err("3: Permission denied"));
        assert!(!is_transport_err("2: No such file"));
    }
}
