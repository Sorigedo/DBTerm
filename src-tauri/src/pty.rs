use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Emitter;

pub struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // 必须持有 slave，否则 macOS 关闭 slave fd 后 shell 收到 SIGHUP 立即退出
    _slave: Box<dyn SlavePty + Send>,
    /// 当同 ID 被新会话取代时置 true，旧 reader 线程据此跳过 pty:disconnected 事件
    cancelled: Arc<AtomicBool>,
}

impl PtyHandle {
    pub fn write_data(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer.write_all(data).map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }
}

pub type PtyState = Arc<Mutex<HashMap<String, PtyHandle>>>;

/// 在系统 PATH 中查找 shell 短名，返回绝对路径
fn resolve_shell_in_path(name: &str) -> Result<String, String> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';

    #[cfg(windows)]
    let exts = ["", ".exe", ".cmd", ".bat"];
    #[cfg(not(windows))]
    let exts = [""];

    for dir in path_env.split(sep) {
        for ext in exts {
            let candidate = std::path::Path::new(dir).join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    Err(format!("找不到 Shell \"{name}\"，请在连接设置中填写绝对路径"))
}

/// 启动本地 Shell，后台线程持续读取输出并通过事件推送到前端
pub fn spawn_shell(
    id:       String,
    shell:    String,
    cols:     u16,
    rows:     u16,
    cwd:      Option<String>,
    init_cmd: Option<String>,
    state:    &PtyState,
    app:      tauri::AppHandle,
) -> Result<(), String> {
    // 取消旧会话的 reader 线程（防止它在 drop 后发出误导性的 pty:disconnected）
    if let Some(old) = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&id) {
        old.cancelled.store(true, Ordering::SeqCst);
    }
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 创建失败: {e}"))?;

    let shell_path = if shell.is_empty() {
        if cfg!(windows) {
            std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        }
    } else {
        // 安全校验：拒绝路径穿越和非法字符
        if shell.len() > 512 || shell.contains('\0') || shell.contains("..") {
            return Err(format!("Shell 路径非法: {shell:?}"));
        }
        if std::path::Path::new(&shell).is_absolute() {
            shell
        } else {
            // 短名（如 "powershell"、"bash"）：在 PATH 中解析为绝对路径
            resolve_shell_in_path(&shell)?
        }
    };

    let mut cmd = CommandBuilder::new(&shell_path);
    // macOS/Linux：以 login shell 启动，确保 /etc/zprofile 被 source，
    // Homebrew(/opt/homebrew/bin) 等由系统 profile 注入的路径才能生效。
    #[cfg(not(target_os = "windows"))]
    {
        let bn = std::path::Path::new(&shell_path)
            .file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(bn, "zsh" | "bash" | "fish" | "sh") {
            cmd.arg("-l");
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // 对 zsh 注入 ZDOTDIR：自动加载用户原有 .zshrc + 尝试加载 zsh-syntax-highlighting
    // 无需用户手动修改 .zshrc，安装了插件就自动生效
    let shell_basename = std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if shell_basename == "zsh" {
        if let Ok(home) = std::env::var("HOME") {
            let zdotdir = format!("{home}/.config/dbterm/zsh");
            if std::fs::create_dir_all(&zdotdir).is_ok() {
                let zshrc_path = format!("{zdotdir}/.zshrc");
                let zshrc = "\
# DBTerm — 透明代理 zsh 初始化，额外加载语法高亮\n\
export ZDOTDIR=\"$HOME\"\n\
[ -f \"$HOME/.zshrc\" ] && source \"$HOME/.zshrc\"\n\
# 仅当插件未加载时尝试加载（避免重复）\n\
if [ -z \"$ZSH_HIGHLIGHT_VERSION\" ]; then\n\
  for _hl in \\\n\
    \"/opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh\" \\\n\
    \"/usr/local/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh\" \\\n\
    \"$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh\"; do\n\
    [ -f \"$_hl\" ] && { source \"$_hl\"; break; }\n\
  done\n\
  unset _hl\n\
fi\n";
                // 每次写入确保内容是最新版本；先检查路径非符号链接，防止覆盖用户真实配置
                let should_write = match std::fs::symlink_metadata(&zshrc_path) {
                    Ok(m) => !m.file_type().is_symlink(),
                    Err(_) => true, // 不存在则创建
                };
                if should_write {
                    let _ = std::fs::write(&zshrc_path, zshrc);
                }
                cmd.env("ZDOTDIR", zdotdir);
            }
        }
    }

    // 设置工作目录
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        let expanded = if dir.starts_with('~') {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
            dir.replacen('~', &home, 1)
        } else {
            dir
        };
        cmd.cwd(expanded);
    }

    let _ = init_cmd; // 初始命令由前端 Terminal 在 pty:connected 后写入

    let portable_pty::PtyPair { master, slave } = pair;

    slave
        .spawn_command(cmd)
        .map_err(|e| format!("Shell 启动失败 ({shell_path}): {e}"))?;

    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;

    let cancelled = Arc::new(AtomicBool::new(false));

    // slave 必须保留，不能 drop，否则 macOS 会立即 SIGHUP 子进程
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id.clone(), PtyHandle {
        master, writer, _slave: slave, cancelled: cancelled.clone(),
    });

    let _ = app.emit("pty:connected", serde_json::json!({ "id": &id }));

    let app_clone   = app.clone();
    let id_clone    = id.clone();
    let state_clone = state.clone();

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let _ = app_clone.emit(
                        "pty:data",
                        serde_json::json!({ "id": &id_clone, "data": data }),
                    );
                }
            }
        }
        // 若已被新会话取代，不发送 disconnected，避免误杀新会话的状态
        if !cancelled.load(Ordering::SeqCst) {
            state_clone.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id_clone);
            let _ = app_clone.emit("pty:disconnected", serde_json::json!({ "id": &id_clone }));
        }
    });

    Ok(())
}
