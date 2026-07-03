use tauri::State;
use crate::{models::TestResult, pty::PtyState};

/// 启动本地终端 Shell
#[tauri::command]
pub fn spawn_local_shell(
    id:          String,
    shell:       String,
    cols:        u16,
    rows:        u16,
    cwd:         Option<String>,
    init_cmd:    Option<String>,
    app:         tauri::AppHandle,
    state:       State<'_, PtyState>,
) -> Result<(), String> {
    crate::pty::spawn_shell(id, shell, cols, rows, cwd, init_cmd, state.inner(), app)
}

/// 向本地终端写入数据（键盘输入）
#[tauri::command]
pub fn write_to_pty(
    id:    String,
    data:  Vec<u8>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let mut map = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let handle = map.get_mut(&id).ok_or_else(|| format!("本地终端不存在: {id}"))?;
    handle.write_data(&data)
}

/// 调整本地终端 PTY 大小
#[tauri::command]
pub fn resize_local_pty(
    id:   String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let map = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let handle = map.get(&id).ok_or_else(|| format!("本地终端不存在: {id}"))?;
    handle.resize(cols, rows)
}

/// 关闭本地终端（移除句柄，后台线程会自动退出）
#[tauri::command]
pub fn close_pty(
    id:    String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
    Ok(())
}

/// 查询本地终端会话是否仍存活（标签撕离：新窗口判断能否直接接管现有 PTY）
#[tauri::command]
pub fn pty_alive(id: String, state: State<'_, PtyState>) -> bool {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains_key(&id)
}

/// 测试本地 Shell 是否可用
#[tauri::command]
pub fn test_local_shell(shell: String) -> TestResult {
    let shell_path = if shell.is_empty() {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    } else {
        // 预设 shell 名称 → 解析完整路径
        match shell.as_str() {
            "bash"        => "/bin/bash".into(),
            "zsh"         => "/bin/zsh".into(),
            "fish"        => which_shell("fish"),
            "powershell"  => which_shell("powershell"),
            "powershell7" => which_shell("pwsh"),
            "cmd"         => "cmd.exe".into(),
            "wsl"         => "wsl.exe".into(),
            other         => other.into(),
        }
    };

    if std::path::Path::new(&shell_path).exists() {
        TestResult { success: true, message: format!("Shell 可用: {shell_path}"), latency_ms: None }
    } else {
        // 尝试 which（仅 Unix；Windows 走 PATH 遍历，无需调 which）
        #[cfg(windows)]
        let _ = &shell_path; // 消除 unused warning
        #[cfg(windows)]
        return TestResult { success: false, message: format!("Shell 未找到: {shell_path}"), latency_ms: None };
        #[cfg(not(windows))]
        match std::process::Command::new("which").arg(&shell_path).output() {
            Ok(out) if out.status.success() => {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                TestResult { success: true, message: format!("Shell 可用: {p}"), latency_ms: None }
            }
            _ => TestResult { success: false, message: format!("Shell 未找到: {shell_path}"), latency_ms: None },
        }
    }
}

/// 扫描 $PATH 中所有可执行命令名，供前端补全使用
#[tauri::command]
pub fn list_path_commands() -> Vec<String> {
    use std::{collections::HashSet, path::Path};
    let mut names: HashSet<String> = HashSet::new();
    // PATH 分隔符：Windows 为 ';'，Unix 为 ':'
    let sep = if cfg!(windows) { ';' } else { ':' };
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(sep) {
            if dir.is_empty() { continue; }
            let Ok(entries) = std::fs::read_dir(Path::new(dir)) else { continue };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                let ft = entry.file_type().unwrap_or_else(|_| meta.file_type());
                let is_regular = meta.is_file() || ft.is_symlink();
                // 可执行判定：Unix 看权限位，Windows 看扩展名
                #[cfg(unix)]
                let is_exec = {
                    use std::os::unix::fs::PermissionsExt;
                    is_regular && meta.permissions().mode() & 0o111 != 0
                };
                #[cfg(windows)]
                let is_exec = is_regular
                    && entry
                        .path()
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| {
                            matches!(
                                e.to_ascii_lowercase().as_str(),
                                "exe" | "bat" | "cmd" | "com" | "ps1"
                            )
                        })
                        .unwrap_or(false);
                if is_exec {
                    if let Some(s) = entry.file_name().to_str() {
                        names.insert(s.to_string());
                    }
                }
            }
        }
    }
    let mut v: Vec<String> = names.into_iter().collect();
    v.sort();
    v
}

fn which_shell(name: &str) -> String {
    std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()
        .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
        .unwrap_or_else(|| name.into())
}
