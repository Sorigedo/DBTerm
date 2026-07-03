use tauri::{Manager, State};
use tokio::sync::mpsc;
use crate::{
    keychain,
    models::{ConnConfig, DiskEntry, FileEntry, ProcessInfo, ServerPerf},
    ssh::{safe_lock, SshCmd, SshHandle, SshState},
    storage::StorageState,
};

/// 建立 SSH 连接
/// session_id: 每个 Tab 的唯一 ID（用作状态 key，事件 payload 中的 id）
/// conn_id:    连接配置 ID（用于查找主机/用户名/密码等）
#[tauri::command]
pub async fn connect_ssh(
    session_id: String,
    conn_id: String,
    app: tauri::AppHandle,
    ssh_state: State<'_, SshState>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    // 加载连接配置（按 conn_id 查找）
    let configs = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).load()?;
    let config: ConnConfig = configs
        .into_iter()
        .find(|c| c.id == conn_id)
        .ok_or_else(|| format!("连接不存在: {conn_id}"))?;

    // 从密码文件读取密码
    let password = keychain::get_password(&conn_id)?;

    let (tx, rx) = mpsc::unbounded_channel::<SshCmd>();
    let run_id = uuid::Uuid::new_v4().to_string();

    // 取旧句柄（同 sessionId 的重连场景），插入新句柄
    let old_tx = {
        let mut map = safe_lock(&ssh_state);
        let old = map.get(&session_id).map(|h| h.tx.clone());
        map.insert(session_id.clone(), SshHandle { tx, run_id: run_id.clone(), conn_id: conn_id.clone() });
        old
    };
    if let Some(old) = old_tx {
        let _ = old.send(SshCmd::Disconnect);
    }

    // 在 tokio 后台运行 SSH 会话（以 session_id 为事件 ID）
    let app_clone = app.clone();
    let sid_clone = session_id.clone();
    let state_clone = ssh_state.inner().clone();
    let run_id_clone = run_id.clone();
    tokio::spawn(async move {
        crate::ssh::run_session(sid_clone.clone(), run_id_clone.clone(), config, password, rx, app_clone).await;
        let mut map = safe_lock(&state_clone);
        if map.get(&sid_clone).map(|h| h.run_id == run_id_clone).unwrap_or(false) {
            map.remove(&sid_clone);
        }
    });

    Ok(run_id)
}

/// 向 SSH 通道写入数据（键盘输入）
#[tauri::command]
pub fn write_to_ssh(
    id: String,
    data: Vec<u8>,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let map = ssh_state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let handle = map.get(&id).ok_or_else(|| format!("SSH 会话不存在: {id}"))?;
    handle.tx.send(SshCmd::Write(data)).map_err(|_| "会话已断开".to_string())
}

/// 调整 PTY 大小
#[tauri::command]
pub fn resize_pty(
    id: String,
    cols: u32,
    rows: u32,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let map = ssh_state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let handle = map.get(&id).ok_or_else(|| format!("SSH 会话不存在: {id}"))?;
    handle.tx.send(SshCmd::Resize { cols, rows }).map_err(|_| "会话已断开".to_string())
}

/// 同步全局代理设置（设置中心 → 后端；连接级未配置代理时生效）
#[tauri::command]
pub fn set_global_proxy(
    proxy_type: String,
    host: String,
    port: u16,
    username: String,
    password: String,
) -> Result<(), String> {
    crate::ssh::set_global_proxy(crate::ssh::GlobalProxy {
        proxy_type, host, port, username, password,
    });
    Ok(())
}

/// 应答 MFA 交互式认证提示（answers 为 null 表示用户取消）
#[tauri::command]
pub fn respond_ssh_mfa(
    request_id: String,
    answers: Option<Vec<String>>,
) -> Result<(), String> {
    crate::ssh::mfa_respond(&request_id, answers)
}

/// 主动断开 SSH 连接
#[tauri::command]
pub fn disconnect_ssh(
    id: String,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let conn_id = {
        let map = ssh_state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = map.get(&id);
        if let Some(h) = handle { h.tx.send(SshCmd::Disconnect).ok(); }
        handle.map(|h| h.conn_id.clone())
    };
    // 用户主动断开：一并释放该连接缓存的 SFTP 会话。
    // 注意：SFTP 池以「连接 ID」为键，而 id 是 tab.id（会话 key），必须用句柄里的 conn_id 反查，否则永不命中 → 句柄泄漏。
    if let Some(cid) = conn_id {
        crate::ssh::sftp::invalidate(&cid);
    }
    Ok(())
}

/// 查询某 sessionId 的 SSH 会话是否仍存活（标签撕离：新窗口判断能否直接接管）
#[tauri::command]
pub fn ssh_session_alive(id: String, ssh_state: State<'_, SshState>) -> bool {
    safe_lock(&ssh_state).contains_key(&id)
}

/// 取某 sessionId 当前 SSH 会话的 runId（接管后用于过滤旧事件；不存在返回 None）
#[tauri::command]
pub fn ssh_session_runid(id: String, ssh_state: State<'_, SshState>) -> Option<String> {
    safe_lock(&ssh_state).get(&id).map(|h| h.run_id.clone())
}

// ── 辅助：加载配置 + 密码 ─────────────────────────────

async fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).load()?;
    let config = configs
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// 在 SSH 服务器上执行单条命令并返回输出
/// 安全限制：长度上限 4096 字节，拒绝管道/重定向/命令替换等危险 shell 元字符
#[tauri::command]
pub async fn exec_ssh_command(
    id: String,
    command: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    if command.len() > 4096 {
        return Err("命令长度超过上限（4096 字节）".to_string());
    }
    // 拒绝 shell 元字符：管道、重定向、命令替换、后台执行、换行符等
    const FORBIDDEN: &[char] = &['|', ';', '>', '<', '&', '`', '\0', '\n', '\r'];
    if command.chars().any(|c| FORBIDDEN.contains(&c)) {
        return Err("命令含危险字符（禁止管道/重定向/命令替换等 shell 元字符）".to_string());
    }
    if command.contains("$(") || command.contains("${") {
        return Err("命令含危险字符（禁止命令/变量替换）".to_string());
    }
    let (config, password) = load_conn(&id, &storage).await?;
    crate::ssh::exec_command(&config, password.as_deref(), &command).await
}

/// 获取服务器性能数据
#[tauri::command]
pub async fn get_server_perf(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<ServerPerf, String> {
    let (config, password) = load_conn(&id, &storage).await?;

    let script = r#"/bin/sh -c '
echo "===CPU1===";
cat /proc/stat | head -65;
sleep 0.3;
echo "===CPU2===";
cat /proc/stat | head -65;
echo "===MEM===";
cat /proc/meminfo | head -10;
echo "===NET===";
cat /proc/net/dev;
echo "===PS===";
ps -eo pid,comm,%cpu,%mem,rss --sort=-%cpu --no-headers 2>/dev/null | head -300;
echo "===HOST===";
hostname 2>/dev/null;
echo "===USER===";
whoami;
echo "===OS===";
cat /etc/os-release 2>/dev/null | grep -m1 PRETTY_NAME | tr -d "\"" | sed "s/PRETTY_NAME=//";
echo "===UPTIME===";
uptime | sed "s/.*up //" | sed "s/,  [0-9]* user.*//";
echo "===DISK===";
df -P --block-size=1 -x tmpfs -x squashfs -x devtmpfs -x overlay 2>/dev/null | grep -v "^Filesystem";
echo "===END==="
'"#;

    let ip = config.host.clone().unwrap_or_default();
    let raw = crate::ssh::exec_command(&config, password.as_deref(), script).await?;
    parse_perf_output(&raw, &ip)
}

/// 杀死远程进程
#[tauri::command]
pub async fn kill_process(
    id: String,
    pid: u32,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    // 拒绝特殊 PID：0 发信号给整个进程组，1 为 init
    if pid == 0 || pid == 1 {
        return Err(format!("不允许对 PID={pid} 发送 kill 信号"));
    }
    let (config, password) = load_conn(&id, &storage).await?;
    crate::ssh::exec_command(&config, password.as_deref(), &format!("kill -9 {pid}")).await?;
    Ok(())
}

fn parse_perf_output(raw: &str, ip: &str) -> Result<ServerPerf, String> {
    let mut sections: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    let mut cur_key: Option<&str> = None;
    let mut cur_lines: Vec<&str> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("===") && trimmed.ends_with("===") {
            if let Some(key) = cur_key {
                sections.insert(key, cur_lines.clone());
            }
            cur_key = Some(trimmed);
            cur_lines = Vec::new();
        } else {
            cur_lines.push(line);
        }
    }
    if let Some(key) = cur_key {
        sections.insert(key, cur_lines);
    }

    let cpu1_lines = sections.get("===CPU1===").cloned().unwrap_or_default();
    let cpu2_lines = sections.get("===CPU2===").cloned().unwrap_or_default();
    let mem_lines  = sections.get("===MEM===").cloned().unwrap_or_default();
    let net_lines  = sections.get("===NET===").cloned().unwrap_or_default();
    let ps_lines   = sections.get("===PS===").cloned().unwrap_or_default();
    let disk_lines = sections.get("===DISK===").cloned().unwrap_or_default();

    let hostname = sections.get("===HOST===")
        .and_then(|v| v.first())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let username = sections.get("===USER===")
        .and_then(|v| v.first())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let os = sections.get("===OS===")
        .and_then(|v| v.first())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Linux".into());

    let uptime = sections.get("===UPTIME===")
        .and_then(|v| v.first())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let (cpu_total, cpu_cores) = calc_cpu_usage(&cpu1_lines, &cpu2_lines);
    let cpu_count = cpu_cores.len() as u32;
    let (mem_total, mem_used, swap_total, swap_used) = parse_meminfo(&mem_lines);
    let (net_rx, net_tx) = parse_net_dev(&net_lines);
    let disks = parse_disks(&disk_lines);
    // 合计所有真实分区，反映服务器实际总存储
    let disk_total: u64 = disks.iter().map(|d| d.total).sum();
    let disk_used:  u64 = disks.iter().map(|d| d.used).sum();
    let processes = parse_processes(&ps_lines);

    Ok(ServerPerf {
        hostname, username, os, uptime,
        ip: ip.to_string(),
        cpu_total, cpu_cores, cpu_count,
        mem_total, mem_used, swap_total, swap_used,
        disk_total, disk_used, disks,
        net_rx, net_tx,
        processes,
    })
}

#[derive(Default)]
struct CpuTimes { user: u64, nice: u64, sys: u64, idle: u64, iowait: u64, irq: u64, softirq: u64, steal: u64 }

impl CpuTimes {
    fn total(&self) -> u64 { self.user + self.nice + self.sys + self.idle + self.iowait + self.irq + self.softirq + self.steal }
    fn idle_total(&self) -> u64 { self.idle + self.iowait }
}

fn parse_cpu_line(line: &str) -> Option<CpuTimes> {
    let nums: Vec<u64> = line.split_whitespace().skip(1).take(8)
        .filter_map(|s| s.parse().ok()).collect();
    if nums.len() < 4 { return None; }
    Some(CpuTimes {
        user: nums[0], nice: nums[1], sys: nums[2], idle: nums[3],
        iowait: nums.get(4).copied().unwrap_or(0),
        irq:    nums.get(5).copied().unwrap_or(0),
        softirq:nums.get(6).copied().unwrap_or(0),
        steal:  nums.get(7).copied().unwrap_or(0),
    })
}

fn cpu_pct(b: &CpuTimes, a: &CpuTimes) -> f32 {
    let total = a.total().saturating_sub(b.total());
    let idle  = a.idle_total().saturating_sub(b.idle_total());
    if total == 0 { return 0.0; }
    ((1.0 - idle as f32 / total as f32) * 100.0).clamp(0.0, 100.0)
}

fn calc_cpu_usage(before: &[&str], after: &[&str]) -> (f32, Vec<f32>) {
    let b_map: std::collections::HashMap<String, CpuTimes> = before.iter()
        .filter(|l| l.starts_with("cpu"))
        .filter_map(|l| {
            let key = l.split_whitespace().next()?.to_string();
            Some((key, parse_cpu_line(l)?))
        }).collect();

    let mut total = 0.0f32;
    let mut cores = Vec::new();
    let mut core_idx = 0u32;

    for line in after.iter().filter(|l| l.starts_with("cpu")) {
        let key = match line.split_whitespace().next() { Some(k) => k, None => continue };
        let a = match parse_cpu_line(line) { Some(t) => t, None => continue };
        if let Some(b) = b_map.get(key) {
            let pct = cpu_pct(b, &a);
            if key == "cpu" {
                total = pct;
            } else if key.starts_with("cpu") && key[3..].parse::<u32>().is_ok() {
                while cores.len() < core_idx as usize { cores.push(0.0); }
                cores.push(pct);
                core_idx += 1;
            }
        }
    }
    (total, cores)
}

fn parse_meminfo(lines: &[&str]) -> (u64, u64, u64, u64) {
    let mut vals: std::collections::HashMap<&str, u64> = std::collections::HashMap::new();
    for line in lines {
        if let Some((key, rest)) = line.split_once(':') {
            let kb: u64 = rest.split_whitespace().next()
                .and_then(|s| s.parse().ok()).unwrap_or(0);
            vals.insert(key.trim(), kb * 1024);
        }
    }
    let mem_total  = *vals.get("MemTotal").unwrap_or(&0);
    let mem_avail  = *vals.get("MemAvailable")
        .or_else(|| vals.get("MemFree")).unwrap_or(&0);
    let mem_used   = mem_total.saturating_sub(mem_avail);
    let swap_total = *vals.get("SwapTotal").unwrap_or(&0);
    let swap_free  = *vals.get("SwapFree").unwrap_or(&0);
    let swap_used  = swap_total.saturating_sub(swap_free);
    (mem_total, mem_used, swap_total, swap_used)
}

fn parse_net_dev(lines: &[&str]) -> (u64, u64) {
    let mut rx_total = 0u64;
    let mut tx_total = 0u64;
    for line in lines {
        let t = line.trim();
        if !t.contains(':') || t.starts_with("Inter") || t.starts_with("face") { continue; }
        let after_colon = match t.split_once(':') { Some((iface, rest)) => {
            if iface.trim() == "lo" { continue; }
            rest
        }, None => continue };
        let nums: Vec<u64> = after_colon.split_whitespace()
            .filter_map(|s| s.parse().ok()).collect();
        if nums.len() >= 9 {
            rx_total += nums[0];
            tx_total += nums[8];
        }
    }
    (rx_total, tx_total)
}

fn parse_processes(lines: &[&str]) -> Vec<ProcessInfo> {
    lines.iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 { return None; }
            Some(ProcessInfo {
                pid:     parts[0].parse().ok()?,
                name:    parts[1].to_string(),
                cpu_pct: parts[2].parse().unwrap_or(0.0),
                mem_mb:  parts[4].parse::<f32>().unwrap_or(0.0) / 1024.0,
                status:  String::new(),
            })
        })
        .collect()
}

fn parse_disks(lines: &[&str]) -> Vec<DiskEntry> {
    // df -P --block-size=1 POSIX 格式: Filesystem 1B-blocks Used Available Capacity% Mountpoint
    lines.iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 6 { return None; }
            let total: u64 = parts[1].parse().ok()?;
            let used:  u64 = parts[2].parse().ok()?;
            Some(DiskEntry { mount: parts[5].to_string(), total, used })
        })
        .collect()
}

/// 连接是否启用 SFTP 协议（默认启用；关闭后回退 exec 命令模式）
fn sftp_enabled(config: &ConnConfig) -> bool {
    crate::ssh::SshExtra::from_config(config).enable_sftp
}

/// 列出远程目录
#[tauri::command]
pub async fn list_files(
    id: String,
    path: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<FileEntry>, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::list_dir(&config, password.as_deref(), &path).await;
    }
    crate::ssh::validate_remote_path(&path)?;
    // ls -la with a parseable format
    let cmd = format!(
        r#"ls -la --time-style='+%Y-%m-%d %H:%M' "{}" 2>&1 | tail -n +2"#,
        path.replace('"', "\\\"")
    );
    let raw = crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(parse_ls_output(&raw, &path))
}

/// 文件管理器起始路径：SFTP 默认路径或远程 $HOME；附带非致命警告
#[tauri::command]
pub async fn get_file_start_path(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<crate::ssh::sftp::StartPath, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::resolve_start_path(&config, password.as_deref()).await;
    }
    let home = crate::ssh::exec_command(&config, password.as_deref(), "echo \"$HOME\"").await?;
    let home = home.trim();
    Ok(crate::ssh::sftp::StartPath {
        path: if home.is_empty() { "/".to_string() } else { home.to_string() },
        warning: None,
    })
}

/// 取消正在进行的 SFTP 传输
#[tauri::command]
pub fn cancel_sftp_transfer(transfer_id: String) -> Result<(), String> {
    crate::ssh::sftp::cancel_transfer(&transfer_id);
    Ok(())
}

fn parse_ls_output(raw: &str, base_path: &str) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // --time-style='+%Y-%m-%d %H:%M' 产生 2 个日期字段，名称在 index 7
        // 普通 ls -l 产生 3 个日期字段(月 日 时间)，名称在 index 8
        // 统一：至少 8 个字段，并根据第 5 字段格式判断偏移
        if parts.len() < 8 { continue; }
        let perms = parts[0];
        let is_dir = perms.starts_with('d');
        let is_link = perms.starts_with('l');
        let size: u64 = parts[4].parse().unwrap_or(0);
        // 如果 parts[5] 包含 '-' 则是 YYYY-MM-DD 格式（--time-style），name 在 index 7
        // 否则是 "Mon Day HH:MM" 格式，name 在 index 8
        let (date, name_start) = if parts[5].contains('-') {
            (format!("{} {}", parts[5], parts[6]), 7)
        } else {
            (format!("{} {} {}", parts[5], parts[6], parts.get(7).unwrap_or(&"")), 8)
        };
        if parts.len() <= name_start { continue; }
        let name_part = parts[name_start..].join(" ");
        // Remove link target (name -> target)
        let name = if is_link {
            name_part.split(" -> ").next().unwrap_or(&name_part).to_string()
        } else {
            name_part.clone()
        };
        if name == "." || name == ".." { continue; }
        let path = format!("{}/{}", base_path.trim_end_matches('/'), name);
        entries.push(FileEntry {
            name,
            path,
            is_dir: is_dir || is_link,
            size: if is_dir { 0 } else { size },
            modified: date,
            permissions: perms.to_string(),
        });
    }
    // Dirs first
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    entries
}

/// 删除远程文件或目录
#[tauri::command]
pub async fn delete_file(
    id: String,
    path: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::remove(&config, password.as_deref(), &path).await;
    }
    crate::ssh::validate_remote_path(&path)?;
    let cmd = format!(r#"rm -rf "{}""#, path.replace('"', "\\\""));
    crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(())
}

/// 重命名/移动远程文件
#[tauri::command]
pub async fn rename_file(
    id: String,
    from: String,
    to: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::rename(&config, password.as_deref(), &from, &to).await;
    }
    crate::ssh::validate_remote_path(&from)?;
    crate::ssh::validate_remote_path(&to)?;
    let cmd = format!(
        r#"mv "{}" "{}""#,
        from.replace('"', "\\\""),
        to.replace('"', "\\\"")
    );
    crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(())
}

/// 创建远程目录
#[tauri::command]
pub async fn create_dir(
    id: String,
    path: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::mkdir(&config, password.as_deref(), &path).await;
    }
    crate::ssh::validate_remote_path(&path)?;
    let cmd = format!(r#"mkdir -p "{}""#, path.replace('"', "\\\""));
    crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(())
}

/// 下载远程文件，保存到本地 Downloads 目录，返回本地路径
#[tauri::command]
pub async fn download_file(
    id: String,
    remote_path: String,
    transfer_id: Option<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        let download_dir = app.path().download_dir()
            .map_err(|e| format!("无法获取下载目录: {e}"))?;
        let tid = transfer_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        return crate::ssh::sftp::download(
            &config, password.as_deref(), &remote_path, &download_dir, &tid, &app,
        ).await;
    }
    crate::ssh::validate_remote_path(&remote_path)?;
    let cmd = format!(r#"base64 "{}" 2>&1"#, remote_path.replace('"', "\\\""));
    let b64 = crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;

    use base64::{engine::general_purpose::STANDARD, Engine};
    let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = STANDARD.decode(&cleaned)
        .map_err(|e| format!("base64 解码失败: {e}"))?;

    let filename = remote_path.split('/').last().unwrap_or("download").to_string();
    let download_dir = app.path().download_dir()
        .map_err(|e| format!("无法获取下载目录: {e}"))?;
    let local_path = download_dir.join(&filename);

    std::fs::write(&local_path, &bytes)
        .map_err(|e| format!("写入本地文件失败: {e}"))?;

    Ok(local_path.to_string_lossy().into_owned())
}

/// 修改远程文件权限
#[tauri::command]
pub async fn chmod_file(
    id: String,
    path: String,
    mode: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    // mode 仅允许 3-4 位八进制
    let valid = (3..=4).contains(&mode.len())
        && mode.chars().all(|c| ('0'..='7').contains(&c));
    if !valid {
        return Err("权限必须是 3-4 位八进制数字，如 644 或 0755".to_string());
    }
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        let bits = u32::from_str_radix(&mode, 8).map_err(|_| "权限格式错误".to_string())?;
        return crate::ssh::sftp::chmod(&config, password.as_deref(), &path, bits).await;
    }
    crate::ssh::validate_remote_path(&path)?;
    let cmd = format!(r#"chmod {mode} "{path}""#);
    crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(())
}

/// 清除指定主机的 known_hosts 记录（用于 TOFU 密钥变更后重新信任）
#[tauri::command]
pub async fn clear_host_key(host: String, port: u16) -> Result<(), String> {
    crate::ssh::clear_host_key(&host, port)
}

/// 上传本地文件到远程服务器（exec channel + base64 传输，SFTP 关闭时的回退路径）
#[tauri::command]
pub async fn upload_file(
    id: String,
    remote_path: String,
    content_base64: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    crate::ssh::validate_remote_path(&remote_path)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let cleaned: String = content_base64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = STANDARD.decode(&cleaned).map_err(|e| format!("base64解码失败: {e}"))?;

    let (config, password) = load_conn(&id, &storage).await?;
    crate::ssh::upload_bytes(&config, password.as_deref(), &remote_path, &bytes).await
}

/// 按本地路径流式上传（SFTP 优先；回退模式整文件读入后走 exec+base64）
#[tauri::command]
pub async fn upload_file_path(
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let local = std::path::PathBuf::from(&local_path);
    if sftp_enabled(&config) {
        let tid = transfer_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        return crate::ssh::sftp::upload(
            &config, password.as_deref(), &local, &remote_path, &tid, &app,
        ).await;
    }
    crate::ssh::validate_remote_path(&remote_path)?;
    if !local.is_absolute() {
        return Err("本地路径必须是绝对路径".to_string());
    }
    let bytes = tokio::fs::read(&local).await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    crate::ssh::upload_bytes(&config, password.as_deref(), &remote_path, &bytes).await
}

/// 递归下载远程目录到本地下载目录，返回本地路径
#[tauri::command]
pub async fn download_dir(
    id: String,
    remote_path: String,
    transfer_id: String,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if !sftp_enabled(&config) {
        return Err("该连接未启用 SFTP，无法下载目录".to_string());
    }
    let download_dir = app.path().download_dir()
        .map_err(|e| format!("无法获取下载目录: {e}"))?;
    crate::ssh::sftp::download_dir(&config, password.as_deref(), &remote_path, &download_dir, &transfer_id, &app).await
}

/// 递归上传本地目录到远程路径下
#[tauri::command]
pub async fn upload_dir(
    id: String,
    remote_base: String,
    local_path: String,
    transfer_id: String,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    if !sftp_enabled(&config) {
        return Err("该连接未启用 SFTP，无法上传目录".to_string());
    }
    let local = std::path::PathBuf::from(&local_path);
    crate::ssh::sftp::upload_dir(&config, password.as_deref(), &local, &remote_base, &transfer_id, &app).await
}

// ── 远程文件在线编辑 ──────────────────────────────────────

const REMOTE_EDIT_MAX_BYTES: u64 = 1024 * 1024; // 1 MB 上限（文本文件够用）

/// 读取远程文件内容（SFTP 优先；回退 base64 exec）
#[tauri::command]
pub async fn read_remote_file(
    id: String,
    path: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    crate::ssh::validate_remote_path(&path)?;
    let (config, password) = load_conn(&id, &storage).await?;
    if sftp_enabled(&config) {
        return crate::ssh::sftp::read_text_file(&config, password.as_deref(), &path, REMOTE_EDIT_MAX_BYTES).await;
    }
    // 回退：exec base64 解码
    let cmd = format!(r#"wc -c < "{}" 2>/dev/null && base64 "{}" 2>&1"#,
        path.replace('"', "\\\""), path.replace('"', "\\\""));
    let raw = crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    let mut lines = raw.lines();
    // 第一行是文件大小
    let size: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    if size > REMOTE_EDIT_MAX_BYTES {
        return Err(format!("文件过大（{} 字节），在线编辑限制 1 MB", size));
    }
    let b64: String = lines.collect::<Vec<_>>().join("");
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD.decode(b64.chars().filter(|c| !c.is_whitespace()).collect::<String>())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "文件包含非 UTF-8 内容，无法在线编辑".to_string())
}

/// 保存远程文件（SFTP write；回退 base64 echo）
#[tauri::command]
pub async fn write_remote_file(
    id: String,
    path: String,
    content: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    crate::ssh::validate_remote_path(&path)?;
    let (config, password) = load_conn(&id, &storage).await?;
    let bytes = content.into_bytes();
    if sftp_enabled(&config) {
        return crate::ssh::sftp::write_file(&config, password.as_deref(), &path, bytes).await;
    }
    // 回退：base64 + exec
    use base64::{engine::general_purpose::STANDARD, Engine};
    let b64 = STANDARD.encode(&bytes);
    // base64 -d 是 GNU/Linux 写法；macOS/BSD 用 base64 -D（大写）
    // python3 作为跨平台回退
    let cmd = format!(
        r#"printf '%s' '{}' | python3 -c "import sys,base64;sys.stdout.buffer.write(base64.b64decode(sys.stdin.read().strip()))" > "{}" 2>/dev/null || printf '%s' '{}' | base64 -d > "{}" 2>/dev/null || printf '%s' '{}' | base64 -D > "{}""#,
        b64.replace('\'', "'\\''"), path.replace('"', "\\\""),
        b64.replace('\'', "'\\''"), path.replace('"', "\\\""),
        b64.replace('\'', "'\\''"), path.replace('"', "\\\""),
    );
    crate::ssh::exec_command(&config, password.as_deref(), &cmd).await?;
    Ok(())
}

// ── SSH Config 文件导入 ───────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub identity_file: String,
    pub proxy_jump: String,
}

/// 解析 ~/.ssh/config 返回所有 Host 块（*通配符跳过）
#[tauri::command]
pub fn parse_ssh_config() -> Result<Vec<SshConfigHost>, String> {
    let path = crate::tester::expand_home("~/.ssh/config");
    if !path.exists() { return Ok(vec![]); }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut cur: Option<SshConfigHost> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        if let Some((key, val)) = trimmed.split_once(|c: char| c.is_whitespace()) {
            let key = key.trim().to_lowercase();
            let val = val.trim().to_string();
            match key.as_str() {
                "host" => {
                    if let Some(h) = cur.take() {
                        if !h.alias.contains('*') && !h.hostname.is_empty() {
                            hosts.push(h);
                        }
                    }
                    cur = Some(SshConfigHost {
                        alias: val, hostname: String::new(),
                        user: String::new(), port: 22,
                        identity_file: String::new(), proxy_jump: String::new(),
                    });
                }
                "hostname"     => { if let Some(h) = &mut cur { h.hostname = val; } }
                "user"         => { if let Some(h) = &mut cur { h.user = val; } }
                "port"         => { if let Some(h) = &mut cur { h.port = val.parse().unwrap_or(22); } }
                "identityfile" => { if let Some(h) = &mut cur { h.identity_file = val; } }
                "proxyjump"    => { if let Some(h) = &mut cur { h.proxy_jump = val; } }
                _ => {}
            }
        }
    }
    if let Some(h) = cur {
        if !h.alias.contains('*') && !h.hostname.is_empty() {
            hosts.push(h);
        }
    }
    Ok(hosts)
}

// ── 连接配置导出/备份（XOR stream cipher using SHA256 keystream） ──

/// 导出所有连接配置（含 keychain 密码）为加密 JSON，password 为加密口令
#[tauri::command]
pub fn export_connections_encrypted(
    password: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use base64::{engine::general_purpose::STANDARD, Engine};

    let conns = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).load()?;
    // 收集密码
    let mut export_rows: Vec<serde_json::Value> = Vec::new();
    for c in &conns {
        let pwd = crate::keychain::get_password(&c.id).unwrap_or(None);
        let mut row = serde_json::to_value(c).map_err(|e| e.to_string())?;
        if let Some(p) = pwd {
            row["_password"] = serde_json::Value::String(p);
        }
        export_rows.push(row);
    }
    let plain = serde_json::to_string(&export_rows).map_err(|e| e.to_string())?.into_bytes();

    // 使用 uuid v4 生成真正密码学安全的随机 16 字节 salt
    let salt: Vec<u8> = uuid::Uuid::new_v4().as_bytes().to_vec();

    // 派生密钥流
    let key_material: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(password.as_bytes());
        h.update(&salt);
        h.finalize().to_vec()
    };

    // XOR 加密（counter 模式）
    let mut cipher = Vec::with_capacity(plain.len());
    let mut buf = key_material.clone();
    let mut idx = 0usize;
    for b in &plain {
        if idx >= buf.len() {
            let mut h = Sha256::new();
            h.update(&buf);
            h.update(&(cipher.len() as u32).to_le_bytes());
            buf = h.finalize().to_vec();
            idx = 0;
        }
        cipher.push(b ^ buf[idx]);
        idx += 1;
    }

    // 最终格式：salt(16B) + cipher
    let mut out = salt;
    out.extend(cipher);
    Ok(STANDARD.encode(&out))
}

/// 从加密 JSON 导入连接配置
#[tauri::command]
pub fn import_connections_encrypted(
    data: String,
    password: String,
    storage: State<'_, StorageState>,
) -> Result<usize, String> {
    use sha2::{Digest, Sha256};
    use base64::{engine::general_purpose::STANDARD, Engine};

    let raw = STANDARD.decode(data.trim()).map_err(|e| format!("解码失败: {e}"))?;
    if raw.len() < 17 { return Err("数据格式错误".to_string()); }
    let salt = &raw[..16];
    let cipher = &raw[16..];

    // 派生密钥
    let key_material: Vec<u8> = {
        let mut h = Sha256::new();
        h.update(password.as_bytes());
        h.update(salt);
        h.finalize().to_vec()
    };

    // XOR 解密
    let mut plain = Vec::with_capacity(cipher.len());
    let mut buf = key_material.clone();
    let mut idx = 0usize;
    for b in cipher {
        if idx >= buf.len() {
            let mut h = Sha256::new();
            h.update(&buf);
            h.update(&(plain.len() as u32).to_le_bytes());
            buf = h.finalize().to_vec();
            idx = 0;
        }
        plain.push(b ^ buf[idx]);
        idx += 1;
    }

    let rows: Vec<serde_json::Value> = serde_json::from_slice(&plain)
        .map_err(|_| "口令错误或数据已损坏".to_string())?;

    // 第一遍：全部解析完毕才写入，防止 JSON 格式错误导致部分导入留下脏数据
    let mut parsed: Vec<(crate::models::ConnConfig, Option<String>)> = Vec::new();
    for row in rows {
        let pwd = row.get("_password").and_then(|v| v.as_str()).map(|s| s.to_string());
        let mut config_val = row.clone();
        config_val.as_object_mut().map(|m| m.remove("_password"));
        let config: crate::models::ConnConfig = serde_json::from_value(config_val)
            .map_err(|e| format!("连接格式错误: {e}"))?;
        parsed.push((config, pwd));
    }
    // 第二遍：写入存储 + keychain
    let mut count = 0;
    for (config, pwd) in parsed {
        let id = config.id.clone();
        storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).upsert(config)?;
        if let Some(p) = pwd {
            if let Err(e) = crate::keychain::set_password(&id, &p) {
                // keychain 写入失败时记录警告，不中断导入（连接仍可手动输入密码）
                log::warn!("导入：连接 {id} 密码写入 keychain 失败: {e}");
            }
        }
        count += 1;
    }
    Ok(count)
}
