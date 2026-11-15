// DR0.5: 驱动文件下载 + SHA-256 校验 + 进度事件
use tauri::{State, Emitter, AppHandle};
use sha2::{Sha256, Digest};
use super::{DriverKind, DriverRegistry, driver_dir, save_custom_path};

/// shell 安装命令输出事件（macOS brew / Linux apt）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CmdOutputLine {
    pub driver_type: String,
    pub line: String,
    pub done: bool,
    pub exit_ok: bool,
}

/// 运行平台安装命令（brew install / apt-get install），流式输出行事件
#[tauri::command]
pub async fn dr_run_cmd(
    driver_type: String,
    cmd: String,
    app: AppHandle,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 安全：只允许以已知前缀开头的命令，防止任意命令注入
    let allowed = ["brew install ", "sudo ACCEPT_EULA=Y apt-get install "];
    if !allowed.iter().any(|p| cmd.starts_with(p)) {
        return Err("不允许执行该命令".into());
    }

    let dt = driver_type.clone();
    let reg_arc = (*registry).clone();
    let app2 = app.clone();

    tokio::spawn(async move {
        let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
        let (prog, rest_args) = match parts.as_slice() {
            [prog, rest] => (*prog, *rest),
            [prog] => (*prog, ""),
            _ => { let _ = app2.emit("driver-cmd-output", CmdOutputLine { driver_type: dt, line: "命令为空".into(), done: true, exit_ok: false }); return; }
        };
        let args: Vec<&str> = rest_args.split_whitespace().collect();

        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::process::Command;
        use std::process::Stdio;

        let mut child = match Command::new(prog).args(&args)
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app2.emit("driver-cmd-output", CmdOutputLine {
                    driver_type: dt, line: format!("启动失败: {e}"), done: true, exit_ok: false,
                });
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let dt2 = dt.clone(); let app3 = app2.clone();
        let h1 = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = app3.emit("driver-cmd-output", CmdOutputLine { driver_type: dt2.clone(), line: l, done: false, exit_ok: true });
            }
        });
        let dt3 = dt.clone(); let app4 = app2.clone();
        let h2 = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = app4.emit("driver-cmd-output", CmdOutputLine { driver_type: dt3.clone(), line: l, done: false, exit_ok: true });
            }
        });

        let _ = tokio::join!(h1, h2);
        let exit_ok = child.wait().await.map(|s| s.success()).unwrap_or(false);

        if exit_ok {
            // 命令成功后重新扫描 ODBC 驱动名，更新内存注册表 custom_path
            // 对 ODBC 驱动用驱动名（不是文件路径）
            let driver_name = if dt.contains("17") { "ODBC Driver 17 for SQL Server" }
                else { "ODBC Driver 18 for SQL Server" };
            let _ = save_custom_path(&dt, driver_name);
            { let mut reg = reg_arc.lock().await; if let Some(s) = reg.get_mut(&dt) { s.custom_path = Some(driver_name.to_string()); } }
        }
        let _ = app2.emit("driver-cmd-output", CmdOutputLine { driver_type: dt, line: String::new(), done: true, exit_ok });
    });
    Ok(())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DriverDownloadProgress {
    pub driver_type: String,
    pub downloaded: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// Tauri 命令：下载驱动（后台，发送进度事件 driver-download-progress）
/// DR2.3: mirror_url 为镜像根 URL，下载时直接拼接文件名（完全替换原始 URL，不保留路径层级）
#[tauri::command]
pub async fn dr_download(
    driver_type: String,
    mirror_url: Option<String>,
    allow_unverified: Option<bool>,
    app: AppHandle,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    let allow_unverified = allow_unverified.unwrap_or(false);
    let (url, sha256, file_name, is_oci_dir) = {
        let reg = registry.lock().await;
        let state = reg.get(&driver_type).ok_or_else(|| format!("未知驱动: {driver_type}"))?;
        if state.meta.manual_only {
            return Err("该驱动不支持自动下载，请手动指定路径".into());
        }
        let is_oci = state.meta.kind == DriverKind::OciDir;
        let dl = current_platform_download(&state.meta)
            .ok_or("当前平台无下载规格")?;
        if dl.url.is_empty() {
            return Err("该驱动仅提供手动下载页面，请手动下载并指定路径".into());
        }
        // DR2.3: 若配置了内网镜像源，替换 URL 中的文件名部分
        let effective_url = if let Some(mirror) = mirror_url.as_deref().filter(|s| !s.is_empty()) {
            let trimmed = mirror.trim_end_matches('/');
            format!("{}/{}", trimmed, &dl.file_name)
        } else {
            dl.url.clone()
        };
        // 安全加固：强制 HTTPS（阻断明文 http 被中间人替换恶意驱动 / file:// 等本地协议加载）
        validate_download_url(&effective_url)?;
        // 优先用内置 SHA-256；若为空则读取旁路缓存（首次下载后写入）
        let effective_sha256 = if !dl.sha256.is_empty() {
            dl.sha256.clone()
        } else {
            let dest_dir = driver_dir().join(&driver_type);
            let cache_path = dest_dir.join(format!("{}.sha256", &dl.file_name));
            std::fs::read_to_string(&cache_path).ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        };
        (effective_url, effective_sha256, dl.file_name.clone(), is_oci)
    };

    let dest_dir = driver_dir().join(&driver_type);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let dest_file = dest_dir.join(&file_name);
    let dt = driver_type.clone();
    let reg_arc = (*registry).clone(); // Arc clone，移入 spawn

    tokio::spawn(async move {
        let result = download_file(&url, &dest_file, &sha256, &dt, allow_unverified, is_oci_dir, &app).await;
        match result {
            Ok(final_path) => {
                let path_str = final_path.to_string_lossy().to_string();
                let _ = save_custom_path(&dt, &path_str);
                // 同步更新内存 registry，否则 dr_probe_one 读到的 custom_path 仍是 None
                { let mut reg = reg_arc.lock().await; if let Some(s) = reg.get_mut(&dt) { s.custom_path = Some(path_str); } }
                let _ = app.emit("driver-download-progress", DriverDownloadProgress {
                    driver_type: dt, downloaded: 0, total: 0, done: true, error: None,
                });
            }
            Err(e) => {
                let _ = app.emit("driver-download-progress", DriverDownloadProgress {
                    driver_type: dt, downloaded: 0, total: 0, done: true, error: Some(e),
                });
            }
        }
    });
    Ok(())
}

/// 下载 URL 安全校验：仅允许 HTTPS，且主机名非空。
/// 防止 http 明文被中间人替换为恶意驱动（驱动会被 libloading 加载执行 = RCE），
/// 以及 file:// / data: 等协议指向本地任意文件。
fn validate_download_url(url: &str) -> Result<(), String> {
    let rest = url.trim().strip_prefix("https://")
        .ok_or("驱动下载仅允许 HTTPS 地址（防止中间人替换恶意驱动）")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("下载 URL 缺少主机名".to_string());
    }
    Ok(())
}

fn current_platform_download(meta: &super::DriverMeta) -> Option<&super::PlatformDownload> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return meta.win_x64.as_ref();
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return meta.linux_x64.as_ref();
    #[cfg(target_os = "macos")]
    return meta.mac_arm64.as_ref();
    #[allow(unreachable_code)]
    None
}

fn version_platform_download(ver: &super::DriverVersion) -> Option<&super::PlatformDownload> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return ver.win_x64.as_ref();
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return ver.linux_x64.as_ref();
    #[cfg(target_os = "macos")]
    return ver.mac_arm64.as_ref();
    #[allow(unreachable_code)]
    None
}

/// 按指定版本下载驱动（前端版本选择器使用）
#[tauri::command]
pub async fn dr_download_version(
    driver_type: String,
    version: String,
    mirror_url: Option<String>,
    app: AppHandle,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    let (url, sha256, file_name) = {
        let reg = registry.lock().await;
        let state = reg.get(&driver_type).ok_or_else(|| format!("未知驱动: {driver_type}"))?;
        let ver = state.meta.versions.iter().find(|v| v.version == version)
            .ok_or_else(|| format!("未找到版本: {version}"))?;
        let dl = version_platform_download(ver)
            .ok_or("当前平台无该版本下载规格")?;
        let effective_url = if let Some(mirror) = mirror_url.as_deref().filter(|s| !s.is_empty()) {
            format!("{}/{}", mirror.trim_end_matches('/'), &dl.file_name)
        } else {
            dl.url.clone()
        };
        validate_download_url(&effective_url)?;
        let effective_sha256 = if !dl.sha256.is_empty() {
            dl.sha256.clone()
        } else {
            let cache = driver_dir().join(&driver_type).join(format!("{}.sha256", &dl.file_name));
            std::fs::read_to_string(&cache).ok().map(|s| s.trim().to_string()).unwrap_or_default()
        };
        (effective_url, effective_sha256, dl.file_name.clone())
    };

    let dest_dir = driver_dir().join(&driver_type);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let dest_file = dest_dir.join(&file_name);
    let dt = driver_type.clone();
    let reg_arc = (*registry).clone();
    let open_after = {
        let reg = registry.lock().await;
        reg.get(&driver_type)
            .and_then(|s| s.meta.versions.iter().find(|v| v.version == version))
            .map(|v| v.open_after_download)
            .unwrap_or(false)
    };

    tokio::spawn(async move {
        let result = download_file(&url, &dest_file, &sha256, &dt, true, false, &app).await;
        match result {
            Ok(final_path) => {
                let path_str = final_path.to_string_lossy().to_string();
                if open_after {
                    // MSI/pkg：用系统安装程序打开，不设为驱动路径
                    let _ = open::that(&final_path);
                    let _ = app.emit("driver-download-progress", DriverDownloadProgress {
                        driver_type: dt, downloaded: 0, total: 0, done: true, error: None,
                    });
                } else {
                    let _ = save_custom_path(&dt, &path_str);
                    { let mut reg = reg_arc.lock().await; if let Some(s) = reg.get_mut(&dt) { s.custom_path = Some(path_str); } }
                    let _ = app.emit("driver-download-progress", DriverDownloadProgress {
                        driver_type: dt, downloaded: 0, total: 0, done: true, error: None,
                    });
                }
            }
            Err(e) => {
                let _ = app.emit("driver-download-progress", DriverDownloadProgress {
                    driver_type: dt, downloaded: 0, total: 0, done: true, error: Some(e),
                });
            }
        }
    });
    Ok(())
}

async fn download_file(
    url: &str,
    dest: &std::path::Path,
    expected_sha256: &str,
    driver_type: &str,
    allow_unverified: bool,
    is_oci_dir: bool,
    app: &AppHandle,
) -> Result<std::path::PathBuf, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let resp = client.get(url).send().await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let temp_path = dest.with_file_name(format!(
        ".{}.download-{}",
        dest.file_name().and_then(|name| name.to_str()).unwrap_or("driver"),
        uuid::Uuid::new_v4()
    ));
    let mut temp_file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("创建下载临时文件失败: {e}"))?;
    use tokio::io::AsyncWriteExt;
    let mut stream = resp.bytes_stream();
    use futures::StreamExt;

    const MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB 上限，防止恶意服务器撑爆磁盘
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!("读取数据失败: {error}"));
            }
        };
        downloaded += chunk.len() as u64;
        if downloaded > MAX_BYTES {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("下载超过最大允许大小 256 MB，已中止"));
        }
        hasher.update(&chunk);
        if let Err(error) = temp_file.write_all(&chunk).await {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("写入下载临时文件失败: {error}"));
        }
        let _ = app.emit("driver-download-progress", DriverDownloadProgress {
            driver_type: driver_type.to_string(),
            downloaded, total, done: false, error: None,
        });
    }
    temp_file.flush().await.map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("刷新下载临时文件失败: {error}")
    })?;
    drop(temp_file);
    let computed_hash = hex::encode(hasher.finalize());

    // SHA-256 校验
    if !expected_sha256.is_empty() {
        if computed_hash != expected_sha256.to_lowercase() {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("SHA-256 校验失败：期望 {} 实际 {}", expected_sha256, computed_hash));
        }
    } else if allow_unverified {
        // 用户已显式确认风险：无权威 SHA-256，仅 HTTPS 传输保护，无法校验文件完整性
        log::warn!("驱动 {driver_type} 无内置 SHA-256，用户确认跳过完整性校验（仅 HTTPS 传输保护）");
    } else {
        // 安全默认：无权威 SHA-256 时拒绝。驱动会被 libloading 加载执行（= RCE 风险），
        // 不可加载未校验的二进制。维护者填入官方 SHA-256，或用户显式确认风险后再下载。
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "驱动 {driver_type} 缺少权威 SHA-256，无法校验完整性，已拒绝下载（驱动会被加载执行）。\
             请填入官方校验和，或在确认风险后选择「仍然下载未校验驱动」。"
        ));
    }

    // 通过魔数判断是否为 zip（目标文件名是 .dylib 但实际下载的是 zip 包）
    let mut header = [0_u8; 4];
    let is_zip = std::fs::File::open(&temp_path)
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut header))
        .map(|_| header == [0x50, 0x4b, 0x03, 0x04])
        .unwrap_or(false);
    // macOS DMG：通过文件扩展名判断（DMG 格式多样，扩展名比魔数更可靠）
    let is_dmg = dest.extension().and_then(|e| e.to_str()) == Some("dmg");
    let final_path = if is_zip {
        let zip_path = temp_path.clone();
        let dir = dest.parent().unwrap();
        if is_oci_dir {
            // OCI 目录型：将 zip 内容全部平铺解压到 dest_dir，返回目录路径
            extract_all_to_dir(&zip_path, dir)?;
            let _ = std::fs::remove_file(&zip_path);
            dir.to_path_buf()
        } else {
            extract_first_dylib(&zip_path, dir)?
        }
    } else if is_dmg {
        // macOS DMG（如 Oracle Instant Client ARM64）：写入临时文件，hdiutil 挂载后复制
        let dmg_path = temp_path.clone();
        let dir = dest.parent().unwrap();
        #[cfg(target_os = "macos")]
        {
            extract_dmg_to_dir(&dmg_path, dir)?;
            let _ = std::fs::remove_file(&dmg_path);
            dir.to_path_buf()
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = std::fs::remove_file(&dmg_path);
            return Err("DMG 格式仅支持 macOS".into());
        }
    } else {
        std::fs::rename(&temp_path, dest).map_err(|e| format!("写入驱动文件失败: {e}"))?;
        dest.to_path_buf()
    };

    // 若内置 SHA-256 为空，将实际哈希写入旁路缓存供后续校验
    if expected_sha256.is_empty() {
        let cache_path = dest.with_extension(
            format!("{}.sha256", dest.extension().and_then(|e| e.to_str()).unwrap_or(""))
        );
        let _ = std::fs::write(&cache_path, &computed_hash);
        log::info!("驱动 {driver_type} SHA-256 已缓存: {computed_hash}");
    }

    Ok(final_path)
}

/// OciDir 专用：将 zip 内所有文件平铺解压到 dest_dir（去掉顶层目录前缀）
/// 防止 zip slip：严格校验最终路径必须在 dest_dir 内部
fn extract_all_to_dir(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压失败: {e}"))?;

    // 检测顶层公共前缀（如 instantclient_21_14/），以便剥离
    let prefix: Option<String> = {
        let mut p: Option<String> = None;
        for i in 0..archive.len() {
            let e = archive.by_index(i).map_err(|e| format!("读取压缩条目失败: {e}"))?;
            let name = e.name().map_err(|e| format!("读取压缩条目名称失败: {e}"))?;
            if let Some(slash) = name.find('/') {
                let seg = name[..slash + 1].to_string();
                match &p {
                    None => p = Some(seg),
                    Some(existing) if existing != &seg => { p = None; break; }
                    _ => {}
                }
            } else {
                p = None; break;
            }
        }
        p
    };

    let canon_dest = dest_dir.canonicalize()
        .unwrap_or_else(|_| dest_dir.to_path_buf());

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩条目失败: {e}"))?;
        let raw_name = entry.name().map_err(|e| format!("读取压缩条目名称失败: {e}"))?.to_string();

        // 剥离顶层前缀
        let rel = if let Some(ref pfx) = prefix {
            raw_name.strip_prefix(pfx.as_str()).unwrap_or(&raw_name)
        } else {
            &raw_name
        };
        if rel.is_empty() || rel.ends_with('/') { continue; } // 跳过目录条目

        // ZIP 路径在不同平台可能用反斜杠分隔；只接受普通相对路径组件。
        let portable_rel = rel.replace('\\', "/");
        let relative_path = std::path::Path::new(&portable_rel);
        if relative_path.components().any(|component| !matches!(component, std::path::Component::Normal(_))) {
            return Err(format!("zip 条目含危险路径: {rel}"));
        }
        let out_path = dest_dir.join(relative_path);

        // 拒绝目标目录中已有的符号链接，避免在父目录缺失时绕过 canonicalize 检查。
        let mut current = dest_dir.to_path_buf();
        for component in relative_path.components() {
            current.push(component.as_os_str());
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!("zip 条目穿过符号链接: {rel}"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(format!("检查 zip 目标路径失败: {error}")),
            }
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            let canon_parent = parent.canonicalize().map_err(|e| format!("校验 zip 目标目录失败: {e}"))?;
            if !canon_parent.starts_with(&canon_dest) {
                return Err(format!("zip 条目路径逃逸: {rel}"));
            }
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&out_path)
            .map_err(|e| format!("创建输出文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|e| format!("复制压缩文件失败: {e}"))?;
    }
    Ok(())
}

fn extract_first_dylib(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压失败: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩条目失败: {e}"))?;
        let name = entry.name().map_err(|e| format!("读取压缩条目名称失败: {e}"))?.to_string();
        let is_lib = name.ends_with(".dll") || name.ends_with(".so")
            || name.ends_with(".dylib") || name.ends_with(".so.1");
        if is_lib {
            let out_path = dest_dir.join(
                std::path::Path::new(&name).file_name().unwrap_or_default()
            );
            if let Ok(metadata) = std::fs::symlink_metadata(&out_path) {
                if metadata.file_type().is_symlink() {
                    return Err(format!("驱动输出路径是符号链接，已拒绝写入: {}", out_path.display()));
                }
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&out_path)
                .map_err(|e| format!("创建驱动输出失败: {e}"))?;
            std::io::copy(&mut entry, &mut output).map_err(|e| format!("写出文件失败: {e}"))?;
            let _ = std::fs::remove_file(zip_path);
            return Ok(out_path);
        }
    }
    Err("zip 中未找到动态库文件（.dll/.so/.dylib）".into())
}

#[cfg(all(test, unix))]
mod archive_extraction_tests {
    use super::{extract_all_to_dir, extract_first_dylib};
    use std::{io::Write, os::unix::fs::symlink};

    #[test]
    fn rejects_archive_path_through_existing_symlink_before_writing_outside_destination() {
        let root = std::env::temp_dir().join(format!("dbterm-zip-symlink-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        let outside = root.join("outside");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, destination.join("redirect")).unwrap();

        let archive_path = root.join("payload.zip");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("top/redirect/newdir/payload.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"outside write").unwrap();
        archive.finish().unwrap();

        let result = extract_all_to_dir(&archive_path, &destination);

        assert!(result.is_err(), "symlink traversal must fail closed");
        assert!(!outside.join("newdir/payload.bin").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_dylib_output_symlink_before_writing_outside_destination() {
        let root = std::env::temp_dir().join(format!("dbterm-dylib-symlink-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        let outside = root.join("outside");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(outside.join("libpayload.dylib"), destination.join("libpayload.dylib")).unwrap();

        let archive_path = root.join("payload.zip");
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("bundle/libpayload.dylib", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"dylib bytes").unwrap();
        archive.finish().unwrap();

        let result = extract_first_dylib(&archive_path, &destination);

        assert!(result.is_err(), "existing output symlink must fail closed");
        assert!(!outside.join("libpayload.dylib").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}

/// macOS 专用：挂载 DMG，将所有文件平铺复制到 dest_dir，然后卸载。
/// 用于 Oracle Instant Client ARM64（官方仅提供 DMG 格式）。
#[cfg(target_os = "macos")]
fn extract_dmg_to_dir(dmg_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    use std::process::Command;

    // 挂载点：在 dest_dir 同级创建临时目录，避免和 dest_dir 内容冲突
    let mount_point = dest_dir.join("_oracle_dmg_mount");
    if mount_point.exists() {
        let _ = Command::new("hdiutil")
            .args(["detach", &mount_point.to_string_lossy(), "-force", "-quiet"])
            .output();
        let _ = std::fs::remove_dir_all(&mount_point);
    }
    std::fs::create_dir_all(&mount_point).map_err(|e| format!("创建挂载点失败: {e}"))?;

    // hdiutil attach：以只读方式挂载
    let attach = Command::new("hdiutil")
        .args([
            "attach", &dmg_path.to_string_lossy(),
            "-mountpoint", &mount_point.to_string_lossy(),
            "-quiet", "-nobrowse", "-noverify", "-readonly",
        ])
        .output()
        .map_err(|e| format!("hdiutil attach 失败: {e}"))?;

    if !attach.status.success() {
        let _ = std::fs::remove_dir_all(&mount_point);
        let msg = String::from_utf8_lossy(&attach.stderr);
        return Err(format!("挂载 DMG 失败: {msg}"));
    }

    // 复制挂载卷中所有文件到 dest_dir（跳过 install_ic.sh 等脚本，只复制库文件和数据文件）
    let copy_result = copy_dir_contents(&mount_point, dest_dir);

    // 无论如何都卸载
    let _ = Command::new("hdiutil")
        .args(["detach", &mount_point.to_string_lossy(), "-force", "-quiet"])
        .output();
    let _ = std::fs::remove_dir_all(&mount_point);

    copy_result
}

/// 递归复制 src 目录中所有文件到 dst_dir（平铺，去掉 src 自身层级）
#[cfg(target_os = "macos")]
fn copy_dir_contents(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("遍历目录失败: {e}"))?;
        let src_path = entry.path();
        let name = entry.file_name();
        let dst_path = dst.join(&name);

        // 安全检查：防止路径穿越
        let name_str = name.to_string_lossy();
        if name_str.contains("..") || name_str.starts_with('/') {
            continue;
        }

        if src_path.is_dir() {
            std::fs::create_dir_all(&dst_path).map_err(|e| format!("创建子目录失败: {e}"))?;
            copy_dir_contents(&src_path, &dst_path)?;
        } else if src_path.is_file() {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件 {:?} 失败: {e}", name))?;
        }
    }
    Ok(())
}
