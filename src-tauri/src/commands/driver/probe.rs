// DR0.2: 驱动探测 + DR0.3: 动态库加载校验
// DR1.6: 加载失败诊断（缺少依赖/位数不匹配/版本不兼容/unixODBC 缺失）
use tauri::State;
use super::{DriverRegistry, DriverStatus, DriverKind, save_custom_path, clear_custom_path};

/// Tauri 命令：批量探测所有驱动状态
#[tauri::command]
pub async fn dr_probe_all(
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<super::DriverState>, String> {
    let mut reg = registry.lock().await;
    for state in reg.values_mut() {
        let path_opt = state.custom_path.clone();
        let (status, err) = probe_driver(&state.meta.driver_type, &state.meta.kind, path_opt.as_deref());
        state.status = status;
        state.load_error = err;
    }
    Ok(reg.values().cloned().collect())
}

/// Tauri 命令：探测单个驱动
#[tauri::command]
pub async fn dr_probe_one(
    driver_type: String,
    registry: State<'_, DriverRegistry>,
) -> Result<super::DriverState, String> {
    let mut reg = registry.lock().await;
    let state = reg.get_mut(&driver_type).ok_or_else(|| format!("未知驱动类型: {driver_type}"))?;
    let path_opt = state.custom_path.clone();
    let (status, err) = probe_driver(&state.meta.driver_type, &state.meta.kind, path_opt.as_deref());
    state.status = status;
    state.load_error = err;
    Ok(state.clone())
}

/// Tauri 命令：设置自定义驱动路径并重新探测
#[tauri::command]
pub async fn dr_set_path(
    driver_type: String,
    path: String,
    registry: State<'_, DriverRegistry>,
) -> Result<super::DriverState, String> {
    let mut reg = registry.lock().await;
    let state = reg.get_mut(&driver_type).ok_or_else(|| format!("未知驱动类型: {driver_type}"))?;
    if path.is_empty() {
        state.custom_path = None;
        clear_custom_path(&driver_type).ok();
    } else {
        state.custom_path = Some(path.clone());
        save_custom_path(&driver_type, &path)
            .map_err(|e| format!("保存路径失败: {e}"))?;
    }
    let path_opt = state.custom_path.clone();
    let (status, err) = probe_driver(&state.meta.driver_type, &state.meta.kind, path_opt.as_deref());
    state.status = status;
    state.load_error = err;
    Ok(state.clone())
}

/// Tauri 命令：清除自定义路径
#[tauri::command]
pub async fn dr_clear_path(
    driver_type: String,
    registry: State<'_, DriverRegistry>,
) -> Result<super::DriverState, String> {
    let mut reg = registry.lock().await;
    let state = reg.get_mut(&driver_type).ok_or_else(|| format!("未知驱动类型: {driver_type}"))?;
    state.custom_path = None;
    clear_custom_path(&driver_type).ok();
    state.status = DriverStatus::NotAvailable;
    state.load_error = None;
    Ok(state.clone())
}

/// Tauri 命令：获取所有驱动状态（不重新探测）
#[tauri::command]
pub async fn dr_list(
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<super::DriverState>, String> {
    let reg = registry.lock().await;
    Ok(reg.values().cloned().collect())
}

/// 探测指定驱动，返回 (状态, 可选诊断信息)
fn probe_driver(driver_type: &str, kind: &DriverKind, custom_path: Option<&str>) -> (DriverStatus, Option<String>) {
    match kind {
        DriverKind::Dylib   => probe_dylib(custom_path),
        DriverKind::Odbc    => probe_odbc(driver_type, custom_path),
        DriverKind::OciDir  => probe_oci_dir(custom_path),
    }
}

/// 探测动态库（DuckDB）—— 文件存在 + 可动态加载
fn probe_dylib(custom_path: Option<&str>) -> (DriverStatus, Option<String>) {
    let path = match custom_path {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return (DriverStatus::NotAvailable, None),
    };
    if !std::path::Path::new(&path).exists() {
        return (DriverStatus::NotAvailable, Some("文件不存在，请重新指定路径".to_string()));
    }
    match try_load_dylib(&path) {
        Ok(_) => (DriverStatus::Ready, None),
        Err(raw) => {
            let diag = classify_dylib_error(&raw);
            (DriverStatus::AvailableAt { path }, Some(diag))
        }
    }
}

fn try_load_dylib(path: &str) -> Result<(), String> {
    unsafe {
        libloading::Library::new(path)
            .map(|_lib| ())
            .map_err(|e| e.to_string())
    }
}

/// DR2.5: 建连前驱动可加载性预检 —— 供各 DB 模块在建连前调用
/// 返回 Ok(()) 表示驱动可正常加载；Err 包含人类可读诊断（中文）
pub fn verify_dylib_loadable(path: &str) -> Result<(), String> {
    if !std::path::Path::new(path).exists() {
        return Err(format!(
            "驱动文件不存在：{path}\n请在「驱动管理」中重新指定或下载驱动。"
        ));
    }
    try_load_dylib(path).map_err(|raw| {
        let diag = classify_dylib_error(&raw);
        format!("驱动文件已失效，请在「驱动管理」中重新指定或下载。\n诊断：{diag}")
    })
}

/// DR1.6: 将 libloading 原始错误转为人类可读诊断 + 修复建议
fn classify_dylib_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("not a valid win32 application")
        || lower.contains("bad image")
        || lower.contains("invalid image format")
        || lower.contains("exec format error")
    {
        "位数不匹配：驱动文件架构与当前系统不符（请下载 64 位版本）".to_string()
    } else if lower.contains("the specified module could not be found")
        || lower.contains("no such file or directory")
        || lower.contains("image not found")
        || lower.contains("cannot open shared object")
    {
        concat!(
            "缺少依赖库：驱动依赖的运行时库缺失。",
            "Windows 请安装 Visual C++ Redistributable（x64）；",
            "Linux 请运行 ldd 检查缺失 .so；",
            "macOS 请检查 otool -L 输出"
        ).to_string()
    } else if lower.contains("version") || lower.contains("exports") || lower.contains("symbol") {
        "版本不兼容：驱动接口与当前版本不匹配，请更新到最新版驱动".to_string()
    } else if lower.contains("access denied") || lower.contains("permission denied") {
        "权限不足：无法读取驱动文件，请检查文件权限（chmod +x 或以管理员运行）".to_string()
    } else {
        format!("加载失败：{raw}（请检查文件完整性或重新下载驱动）")
    }
}

/// 探测 ODBC 驱动（DM/Oracle/SQL Server）
fn probe_odbc(driver_type: &str, custom_path: Option<&str>) -> (DriverStatus, Option<String>) {
    if let Some(path) = custom_path.filter(|p| !p.is_empty()) {
        if std::path::Path::new(path).exists() {
            return (DriverStatus::AvailableAt { path: path.to_string() }, None);
        } else {
            return (DriverStatus::NotAvailable, Some("指定的驱动路径不存在，请重新指定".to_string()));
        }
    }
    let driver_name = odbc_driver_name(driver_type);
    if !driver_name.is_empty() && check_odbc_driver_registered(driver_name) {
        return (DriverStatus::Ready, None);
    }
    // DR1.6: 检测 unixODBC 是否缺失（非 Windows）
    let diag = odbc_diagnose(driver_type, driver_name);
    (DriverStatus::NotAvailable, Some(diag))
}

fn odbc_driver_name(driver_type: &str) -> &'static str {
    match driver_type {
        "dm"        => "DM8 ODBC DRIVER",
        "oracle"    => "Oracle in instantclient",
        "sqlserver" => "ODBC Driver 18 for SQL Server",
        _           => "",
    }
}

#[cfg(target_os = "windows")]
fn check_odbc_driver_registered(driver_name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\ODBC\ODBCINST.INI", "/f", driver_name, "/k"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    matches!(output, Ok(o) if o.status.success())
}

#[cfg(not(target_os = "windows"))]
fn check_odbc_driver_registered(driver_name: &str) -> bool {
    let output = std::process::Command::new("odbcinst")
        .args(["-q", "-d", "-n", driver_name])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

/// DR1.6: ODBC 诊断信息
#[cfg(target_os = "windows")]
fn odbc_diagnose(driver_type: &str, driver_name: &str) -> String {
    match driver_type {
        "dm"        => format!("未找到达梦 ODBC 驱动（{}）。请安装达梦 DM8 客户端并在安装时勾选 ODBC 驱动", driver_name),
        "oracle"    => format!("未找到 Oracle ODBC 驱动（{}）。请下载 Oracle Instant Client + ODBC 补丁包并运行安装程序", driver_name),
        "sqlserver" => format!("未找到 SQL Server ODBC 驱动（{}）。请从 Microsoft 下载并安装 ODBC Driver 17/18 for SQL Server", driver_name),
        _           => "未找到 ODBC 驱动，请手动安装".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
fn odbc_diagnose(driver_type: &str, driver_name: &str) -> String {
    // 先检测 unixODBC 是否安装
    let has_unix_odbc = std::process::Command::new("odbcinst")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_unix_odbc {
        let pkg_hint = if cfg!(target_os = "macos") {
            "brew install unixodbc"
        } else {
            "sudo apt install unixodbc-dev  # 或  sudo yum install unixODBC-devel"
        };
        return format!(
            "缺少 unixODBC：ODBC 驱动需要先安装 unixODBC 框架。\n修复：{pkg_hint}"
        );
    }

    match driver_type {
        "dm"        => format!("未找到达梦 ODBC 驱动（{}）。请安装达梦 DM8 Linux 客户端并运行 odbcinst -i -d 注册驱动", driver_name),
        "oracle"    => format!("未找到 Oracle ODBC 驱动（{}）。请下载 Oracle Instant Client + ODBC 补丁并运行 odbcinst -i -d 注册", driver_name),
        "sqlserver" => format!("未找到 SQL Server ODBC 驱动（{}）。请参考微软文档安装 msodbcsql18 包", driver_name),
        _           => "未找到 ODBC 驱动，请手动安装".to_string(),
    }
}

/// 探测 OCI 目录型驱动（Oracle Instant Client）
/// custom_path 应为 Instant Client 的解压目录，包含 oci.dll / libclntsh.so / libclntsh.dylib
fn probe_oci_dir(custom_path: Option<&str>) -> (DriverStatus, Option<String>) {
    let dir_str = match custom_path.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => return (DriverStatus::NotAvailable, Some(
            "未配置 Oracle Instant Client 目录。请在驱动管理页面下载或手动指定目录。".into()
        )),
    };

    let dir = std::path::Path::new(dir_str);
    if !dir.exists() {
        return (DriverStatus::NotAvailable, Some(format!("目录不存在：{dir_str}")));
    }
    if !dir.is_dir() {
        return (DriverStatus::NotAvailable, Some(format!("路径不是目录：{dir_str}（需指定 Instant Client 解压目录）")));
    }

    #[cfg(windows)]              let lib_name = "oci.dll";
    #[cfg(target_os = "linux")]  let lib_name = "libclntsh.so";
    #[cfg(target_os = "macos")]  let lib_name = "libclntsh.dylib";
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    let lib_name = "libclntsh.so";

    let lib_path = dir.join(lib_name);
    if lib_path.exists() {
        (DriverStatus::Ready, None)
    } else {
        (DriverStatus::NotAvailable, Some(format!(
            "目录 {dir_str} 中未找到 {lib_name}。\n\
             请确认已正确解压 Oracle Instant Client（解压 zip 后选择包含 {lib_name} 的目录）。"
        )))
    }
}

/// DR2.1 手动文件指纹：计算指定文件的 SHA-256（供 DriverManager 展示）
#[tauri::command]
pub async fn dr_file_hash(path: String) -> Result<String, String> {
    use sha2::{Sha256, Digest};
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}
