use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;

mod commands;
mod db_tunnel;
mod keychain;
mod models;
mod pty;
mod ssh;
mod storage;
mod tester;

use commands::db_export::ExportCancelMap;
use commands::db_tx::TxState;
use commands::driver::DriverRegistry;
use commands::duckdb::DuckPool;
use commands::mongo::tx::MongoTxMap;
use commands::mongo::MongoPool;
use commands::redis::server::RedisReadonly;
use commands::redis::RedisPool;
use commands::sqlite_admin::SqliteAttachMap;
use commands::sqlserver::SsPool;
use pty::PtyState;
use ssh::SshState;
use storage::{Storage, StorageState};

#[derive(serde::Serialize)]
struct DocumentConverterProbe {
    available: bool,
    path: Option<String>,
    message: String,
}

#[derive(serde::Serialize)]
struct DocumentConvertResult {
    path: String,
    engine: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DocumentConverterInstallProgress {
    component: String,
    stage: String,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

fn validate_local_path(path: &str, action: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("只允许绝对路径".to_string());
    }
    if p.components().any(
        |c| matches!(c, std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.')),
    ) {
        return Err(format!("不允许{action}隐藏目录或隐藏文件"));
    }
    Ok(p)
}

fn find_command(candidates: &[PathBuf], version_arg: &str) -> Option<PathBuf> {
    for path in candidates {
        let output = Command::new(path).arg(version_arg).output();
        if output.is_ok() {
            return Some(path.clone());
        }
    }
    None
}

fn bundled_converter_roots(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(path) = std::env::var("DBTERM_CONVERTER_DIR") {
        roots.push(PathBuf::from(path));
    }
    if let Some(app) = app {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            roots.push(app_data_dir.join("converters"));
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            roots.push(resource_dir.join("converters"));
            roots.push(resource_dir.join("resources").join("converters"));
        }
    }
    roots
}

fn app_converter_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取组件目录失败：{e}"))
        .map(|dir| dir.join("converters"))
}

fn bundled_soffice_candidates(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in bundled_converter_roots(app) {
        candidates.extend([
            root.join("libreoffice")
                .join("macos")
                .join("LibreOffice.app")
                .join("Contents")
                .join("MacOS")
                .join("soffice"),
            root.join("libreoffice")
                .join("macos")
                .join("program")
                .join("soffice"),
            root.join("libreoffice").join("macos").join("soffice"),
            root.join("libreoffice")
                .join("windows")
                .join("program")
                .join("soffice.exe"),
            root.join("libreoffice").join("windows").join("soffice.exe"),
            root.join("libreoffice")
                .join("linux")
                .join("program")
                .join("soffice"),
            root.join("libreoffice").join("linux").join("soffice"),
        ]);
    }
    candidates
}

fn system_soffice_candidates() -> Vec<PathBuf> {
    [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/Applications/OpenOffice.app/Contents/MacOS/soffice",
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files\\OpenOffice 4\\program\\soffice.exe",
        "/usr/bin/soffice",
        "/usr/local/bin/soffice",
        "/snap/bin/libreoffice",
        "soffice",
        "soffice.exe",
        "libreoffice",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn find_soffice(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    let mut candidates = bundled_soffice_candidates(app);
    candidates.extend(system_soffice_candidates());
    find_command(&candidates, "--version")
}

fn find_pdftotext(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for root in bundled_converter_roots(app) {
        candidates.extend([
            root.join("poppler").join("macos").join("pdftotext"),
            root.join("poppler").join("windows").join("pdftotext.exe"),
            root.join("poppler").join("linux").join("pdftotext"),
        ]);
    }
    candidates.extend(
        [
            "pdftotext",
            "/opt/homebrew/bin/pdftotext",
            "/usr/local/bin/pdftotext",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    find_command(&candidates, "-v")
}

fn file_stem(path: &Path) -> Result<String, String> {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "无法识别文件名".to_string())
}

fn find_generated_document(temp_dir: &Path, input: &Path, target_ext: &str) -> Result<PathBuf, String> {
    let exact = temp_dir.join(format!("{}.{}", file_stem(input)?, target_ext));
    if exact.exists() {
        return Ok(exact);
    }

    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(temp_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_file() {
            candidates.push(path);
        }
    }

    candidates
        .iter()
        .find(|path| {
            path.extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case(target_ext))
                .unwrap_or(false)
        })
        .cloned()
        .ok_or_else(|| format!("转换器未生成目标文件，输出目录内容：{:?}", candidates))
}

#[tauri::command]
fn write_local_file(path: String, content: String) -> Result<(), String> {
    let p = validate_local_path(&path, "写入")?;
    std::fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_local_file(path: String) -> Result<String, String> {
    let p = validate_local_path(&path, "读取")?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_local_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let p = validate_local_path(&path, "写入")?;
    std::fs::write(p, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn document_converter_probe(app: tauri::AppHandle) -> DocumentConverterProbe {
    if let Some(path) = find_soffice(Some(&app)) {
        return DocumentConverterProbe {
            available: true,
            path: Some(path.to_string_lossy().to_string()),
            message: "已找到内置文档转换引擎，可转换 Word、Excel、PPT、TXT、HTML、PDF 等文档。"
                .to_string(),
        };
    }
    DocumentConverterProbe {
        available: false,
        path: None,
        message: "当前安装包未包含文档转换组件，无法进行 Office/PDF 互转。请使用包含转换组件的完整安装包。".to_string(),
    }
}

#[tauri::command]
fn open_document_converter_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app_converter_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建组件目录失败：{e}"))?;
    open::that(&dir).map_err(|e| format!("打开组件目录失败：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

fn emit_converter_install_progress(
    app: &tauri::AppHandle,
    component: &str,
    stage: &str,
    downloaded: u64,
    total: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "document-converter-install-progress",
        DocumentConverterInstallProgress {
            component: component.to_string(),
            stage: stage.to_string(),
            downloaded,
            total,
            done,
            error,
        },
    );
}

fn validate_https_download_url(url: &str) -> Result<(), String> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .ok_or_else(|| "转换组件下载仅允许 HTTPS 地址".to_string())?;
    if rest.split(['/', '?', '#']).next().unwrap_or("").is_empty() {
        return Err("转换组件下载地址缺少主机名".to_string());
    }
    Ok(())
}

fn libreoffice_download_spec() -> Result<(&'static str, &'static str, &'static str), String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok((
            "https://download.documentfoundation.org/libreoffice/stable/26.2.5/win/x86_64/LibreOffice_26.2.5_Win_x86-64.msi",
            "LibreOffice_26.2.5_Win_x86-64.msi",
            "f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok((
            "https://download.documentfoundation.org/libreoffice/stable/26.2.5/mac/aarch64/LibreOffice_26.2.5_MacOS_aarch64.dmg",
            "LibreOffice_26.2.5_MacOS_aarch64.dmg",
            "c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok((
            "https://download.documentfoundation.org/libreoffice/stable/26.2.5/mac/x86_64/LibreOffice_26.2.5_MacOS_x86-64.dmg",
            "LibreOffice_26.2.5_MacOS_x86-64.dmg",
            "e26180298685274b54aa7fe6e1101c65465a372f457a6748ebd642720811db36",
        ));
    }
    #[allow(unreachable_code)]
    Err("当前平台暂不支持自动下载 LibreOffice 转换组件".to_string())
}

#[cfg(target_os = "windows")]
fn poppler_download_spec() -> Result<(&'static str, &'static str, &'static str), String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok((
            "https://github.com/oschwartz10612/poppler-windows/releases/download/v26.02.0-0/Release-26.02.0-0.zip",
            "Release-26.02.0-0.zip",
            "993e4a94376ed712fafc7058d724ea0b943d118bbd2305cd9ed55174eb85cda5",
        ));
    }
    #[allow(unreachable_code)]
    Err("当前平台暂不需要自动下载 Poppler 组件".to_string())
}

async fn download_converter_package(
    app: &tauri::AppHandle,
    component: &str,
    url: &str,
    file_name: &str,
    expected_sha256: &str,
    work_dir: &Path,
) -> Result<PathBuf, String> {
    validate_https_download_url(url)?;
    std::fs::create_dir_all(work_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let dest = work_dir.join(file_name);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded = 0_u64;
    let mut hasher = Sha256::new();
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("创建下载文件失败：{e}"))?;
    let mut stream = response.bytes_stream();
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    const MAX_BYTES: u64 = 900 * 1024 * 1024;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载数据失败：{e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_BYTES {
            return Err("下载文件超过 900 MB，已中止".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入下载文件失败：{e}"))?;
        emit_converter_install_progress(app, component, "下载中", downloaded, total, false, None);
    }
    file.flush()
        .await
        .map_err(|e| format!("刷新下载文件失败：{e}"))?;

    let actual = hex::encode(hasher.finalize());
    if actual != expected_sha256 {
        let _ = std::fs::remove_file(&dest);
        return Err(format!(
            "SHA-256 校验失败：期望 {expected_sha256}，实际 {actual}"
        ));
    }
    Ok(dest)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败：{e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("遍历目录失败：{e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if src_path.is_file() {
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
            }
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("复制文件失败 {:?}: {e}", src_path))?;
        }
    }
    Ok(())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn find_file_by_name(root: &Path, file_name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case(file_name))
                .unwrap_or(false)
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_file_by_name(&path, file_name) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn install_libreoffice_package(package: &Path, target_dir: &Path, work_dir: &Path) -> Result<(), String> {
    let extract_dir = work_dir.join("libreoffice-msi");
    if extract_dir.exists() {
        let _ = std::fs::remove_dir_all(&extract_dir);
    }
    std::fs::create_dir_all(&extract_dir).map_err(|e| format!("创建解包目录失败：{e}"))?;
    let status = Command::new("msiexec")
        .arg("/a")
        .arg(package)
        .arg("/qn")
        .arg(format!("TARGETDIR={}", extract_dir.to_string_lossy()))
        .status()
        .map_err(|e| format!("启动 MSI 解包失败：{e}"))?;
    if !status.success() {
        return Err(format!("MSI 解包失败，退出码：{status}"));
    }
    let soffice = find_file_by_name(&extract_dir, "soffice.exe")
        .ok_or_else(|| "LibreOffice 包内未找到 soffice.exe".to_string())?;
    let source_root = soffice
        .parent()
        .and_then(|p| {
            if p.file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case("program"))
                .unwrap_or(false)
            {
                p.parent()
            } else {
                Some(p)
            }
        })
        .ok_or_else(|| "无法识别 LibreOffice 解包目录".to_string())?;
    if target_dir.exists() {
        let _ = std::fs::remove_dir_all(target_dir);
    }
    copy_dir_recursive(source_root, target_dir)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_libreoffice_package(package: &Path, target_dir: &Path, work_dir: &Path) -> Result<(), String> {
    let mount_dir = work_dir.join("libreoffice-dmg");
    if mount_dir.exists() {
        let _ = Command::new("hdiutil")
            .args(["detach", &mount_dir.to_string_lossy(), "-force", "-quiet"])
            .output();
        let _ = std::fs::remove_dir_all(&mount_dir);
    }
    std::fs::create_dir_all(&mount_dir).map_err(|e| format!("创建挂载目录失败：{e}"))?;
    let attach = Command::new("hdiutil")
        .args([
            "attach",
            &package.to_string_lossy(),
            "-mountpoint",
            &mount_dir.to_string_lossy(),
            "-quiet",
            "-nobrowse",
            "-noverify",
            "-readonly",
        ])
        .output()
        .map_err(|e| format!("挂载 DMG 失败：{e}"))?;
    if !attach.status.success() {
        let _ = std::fs::remove_dir_all(&mount_dir);
        return Err(format!(
            "挂载 DMG 失败：{}",
            String::from_utf8_lossy(&attach.stderr)
        ));
    }

    let copy_result = (|| {
        let app_path = mount_dir.join("LibreOffice.app");
        if !app_path.exists() {
            return Err("DMG 内未找到 LibreOffice.app".to_string());
        }
        std::fs::create_dir_all(target_dir).map_err(|e| format!("创建组件目录失败：{e}"))?;
        let target_app = target_dir.join("LibreOffice.app");
        if target_app.exists() {
            let _ = std::fs::remove_dir_all(&target_app);
        }
        let status = Command::new("cp")
            .arg("-R")
            .arg(&app_path)
            .arg(target_dir)
            .status()
            .map_err(|e| format!("复制 LibreOffice.app 失败：{e}"))?;
        if !status.success() {
            return Err(format!("复制 LibreOffice.app 失败，退出码：{status}"));
        }
        Ok(())
    })();

    let _ = Command::new("hdiutil")
        .args(["detach", &mount_dir.to_string_lossy(), "-force", "-quiet"])
        .output();
    let _ = std::fs::remove_dir_all(&mount_dir);
    copy_result
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn install_libreoffice_package(_package: &Path, _target_dir: &Path, _work_dir: &Path) -> Result<(), String> {
    Err("当前平台暂不支持自动安装 LibreOffice 转换组件".to_string())
}

#[cfg(target_os = "windows")]
fn install_poppler_package(package: &Path, target_dir: &Path) -> Result<(), String> {
    use std::io::Read;
    let file = std::fs::File::open(package).map_err(|e| format!("打开 Poppler 包失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 Poppler zip 失败：{e}"))?;
    let staging = target_dir.with_file_name("windows-staging");
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建 Poppler 解压目录失败：{e}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取 Poppler 压缩条目失败：{e}"))?;
        let raw_name = entry.name().replace('\\', "/");
        let Some((_, rel)) = raw_name.split_once("/Library/bin/").or_else(|| {
            raw_name
                .strip_prefix("Library/bin/")
                .map(|rest| ("", rest))
        }) else {
            continue;
        };
        if rel.is_empty() || rel.ends_with('/') || rel.contains("..") || rel.contains('/') {
            continue;
        }
        let out_path = staging.join(rel);
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 Poppler 文件失败：{e}"))?;
        std::fs::write(&out_path, bytes).map_err(|e| format!("写出 Poppler 文件失败：{e}"))?;
    }

    if !staging.join("pdftotext.exe").exists() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("Poppler 包内未找到 pdftotext.exe".to_string());
    }
    if target_dir.exists() {
        let _ = std::fs::remove_dir_all(target_dir);
    }
    if let Some(parent) = target_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Poppler 目录失败：{e}"))?;
    }
    std::fs::rename(&staging, target_dir).or_else(|_| {
        copy_dir_recursive(&staging, target_dir)?;
        let _ = std::fs::remove_dir_all(&staging);
        Ok::<(), String>(())
    })?;
    Ok(())
}

#[tauri::command]
async fn install_document_converter_components(
    app: tauri::AppHandle,
) -> Result<DocumentConverterProbe, String> {
    let root = app_converter_dir(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建组件目录失败：{e}"))?;
    let work_dir =
        std::env::temp_dir().join(format!("dbterm-converter-install-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let result = async {
        if find_soffice(Some(&app)).is_none() {
            let (default_url, file_name, sha256) = libreoffice_download_spec()?;
            let url = std::env::var("DBTERM_LIBREOFFICE_URL").unwrap_or_else(|_| default_url.to_string());
            emit_converter_install_progress(&app, "LibreOffice", "准备下载", 0, 0, false, None);
            let package =
                download_converter_package(&app, "LibreOffice", &url, file_name, sha256, &work_dir)
                    .await?;
            emit_converter_install_progress(&app, "LibreOffice", "安装中", 0, 0, false, None);
            install_libreoffice_package(&package, &root.join("libreoffice").join(current_os()), &work_dir)?;
        }

        #[cfg(target_os = "windows")]
        if find_pdftotext(Some(&app)).is_none() {
            let (default_url, file_name, sha256) = poppler_download_spec()?;
            let url = std::env::var("DBTERM_POPPLER_URL").unwrap_or_else(|_| default_url.to_string());
            emit_converter_install_progress(&app, "Poppler", "准备下载", 0, 0, false, None);
            let package =
                download_converter_package(&app, "Poppler", &url, file_name, sha256, &work_dir)
                    .await?;
            emit_converter_install_progress(&app, "Poppler", "安装中", 0, 0, false, None);
            install_poppler_package(&package, &root.join("poppler").join("windows"))?;
        }

        Ok::<(), String>(())
    }
    .await;

    let _ = std::fs::remove_dir_all(&work_dir);
    match result {
        Ok(()) => {
            emit_converter_install_progress(&app, "全部组件", "安装完成", 0, 0, true, None);
            Ok(document_converter_probe(app))
        }
        Err(error) => {
            emit_converter_install_progress(
                &app,
                "转换组件",
                "安装失败",
                0,
                0,
                true,
                Some(error.clone()),
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn convert_document_file(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    output_format: String,
) -> Result<DocumentConvertResult, String> {
    let input = validate_local_path(&input_path, "读取")?;
    let output = validate_local_path(&output_path, "写入")?;
    if !input.exists() {
        return Err("源文件不存在".to_string());
    }
    let target_ext = output_format.trim().trim_start_matches('.').to_lowercase();
    if target_ext.is_empty() {
        return Err("目标格式不能为空".to_string());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let input_ext = input
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if input_ext == "pdf" && matches!(target_ext.as_str(), "xls" | "xlsx" | "ppt" | "pptx") {
        return Err("PDF 转 Excel/PPT 需要专门的表格或版面识别引擎，当前内置 LibreOffice 不支持该转换。请先转 Word 或 TXT。".to_string());
    }
    if input_ext == "pdf" && target_ext == "txt" {
        if let Some(pdftotext) = find_pdftotext(Some(&app)) {
            let out = Command::new(&pdftotext)
                .arg("-layout")
                .arg("-enc")
                .arg("UTF-8")
                .arg(&input)
                .arg(&output)
                .output()
                .map_err(|e| format!("启动 pdftotext 失败：{e}"))?;
            if out.status.success() {
                return Ok(DocumentConvertResult {
                    path: output.to_string_lossy().to_string(),
                    engine: "pdftotext".to_string(),
                });
            }
        }
    }

    let soffice = find_soffice(Some(&app)).ok_or_else(|| {
        "当前安装包未包含文档转换组件，无法进行 Office/PDF 互转。请使用包含转换组件的完整安装包。".to_string()
    })?;
    let temp_dir =
        std::env::temp_dir().join(format!("dbterm-doc-convert-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let profile_dir = temp_dir.join("profile");

    let mut cmd = Command::new(&soffice);
    cmd.arg("--headless")
        .arg("--nologo")
        .arg("--nofirststartwizard")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg(format!(
            "-env:UserInstallation=file://{}",
            profile_dir.to_string_lossy()
        ));
    if input_ext == "pdf" && matches!(target_ext.as_str(), "doc" | "docx" | "odt" | "rtf" | "txt") {
        cmd.arg("--infilter=writer_pdf_import");
    }
    cmd.arg("--convert-to")
        .arg(&target_ext)
        .arg("--outdir")
        .arg(&temp_dir)
        .arg(&input);

    let out = cmd
        .output()
        .map_err(|e| format!("启动 LibreOffice 失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("转换失败：{}{}", stdout, stderr));
    }

    let generated = match find_generated_document(&temp_dir, &input, &target_ext) {
        Ok(path) => path,
        Err(error) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
        let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(format!("{error}。转换器输出：{}{}", stdout, stderr));
        }
    };
    std::fs::rename(&generated, &output)
        .or_else(|_| std::fs::copy(&generated, &output).map(|_| ()))
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&temp_dir);
    Ok(DocumentConvertResult {
        path: output.to_string_lossy().to_string(),
        engine: soffice.to_string_lossy().to_string(),
    })
}

/// 退出守卫标志：仅当前端确认「仍要退出」后置 true，届时不再拦截退出。
static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// 前端确认「仍要退出」后调用：标记已确认并触发真正退出。
#[tauri::command]
fn confirm_app_exit(app: tauri::AppHandle) {
    EXIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("只允许打开 HTTPS 链接".into());
    }
    open::that(&url).map_err(|e| format!("打开链接失败: {e}"))
}

#[tauri::command]
fn current_os() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
    #[allow(unreachable_code)]
    "unknown"
}

/// macOS：覆写 NSApp delegate 的 applicationShouldTerminate:，拦截程序坞/Cmd+Q/菜单退出。
/// Tauri 的 prevent_exit 挂不到 AppKit 的优雅终止路径，必须在此返回 NSTerminateCancel。
#[cfg(target_os = "macos")]
mod macos_quit {
    use objc2::runtime::{AnyObject, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    static APP: OnceLock<AppHandle> = OnceLock::new();

    // 返回 NSApplicationTerminateReply：0=Cancel，1=Now，2=Later
    extern "C-unwind" fn should_terminate(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if super::EXIT_CONFIRMED.load(Ordering::SeqCst) {
            return 1; // NSTerminateNow
        }
        if let Some(h) = APP.get() {
            let _ = h.emit("app:quit-requested", ());
        }
        0 // NSTerminateCancel —— 阻止退出，等前端确认
    }

    pub fn install(app: AppHandle) {
        let _ = APP.set(app);
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                return;
            }
            let cls: *const objc2::runtime::AnyClass = msg_send![delegate, class];
            let imp: unsafe extern "C-unwind" fn() = std::mem::transmute(
                should_terminate
                    as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            );
            // 替换（或新增）applicationShouldTerminate: 方法；类型编码 Q@:@（NSUInteger, self, _cmd, id）
            objc2::ffi::class_replaceMethod(
                cls as *mut _,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 连接配置存储 & 密码文件存储
            // debug 构建用独立的 -dev 子目录，与 release 数据隔离，避免测试连接污染生产包
            let prod_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            let data_dir = if cfg!(debug_assertions) {
                // 取 prod 目录名追加 -dev（不硬编码 identifier，改名也不会漂移）
                match (prod_dir.parent(), prod_dir.file_name()) {
                    (Some(parent), Some(name)) => {
                        parent.join(format!("{}-dev", name.to_string_lossy()))
                    }
                    _ => prod_dir,
                }
            } else {
                prod_dir
            };
            keychain::init(&data_dir);
            ssh::init_known_hosts(&data_dir);
            commands::redis::slowlog_store::init(&data_dir);
            let storage = Storage::new(data_dir.clone()).expect("无法初始化配置存储");
            app.manage(Mutex::new(storage) as StorageState);

            // SSH 会话状态
            let ssh_state: SshState = Arc::new(Mutex::new(HashMap::new()));
            app.manage(ssh_state);

            // 本地 PTY 会话状态
            let pty_state: PtyState = Arc::new(Mutex::new(HashMap::new()));
            app.manage(pty_state);

            // DB 持久事务状态（每个连接最多一个活跃事务）
            let tx_state: TxState = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            // 后台定时清理僵尸事务：被遗弃（未提交/回滚）的事务连接会一直占着 DB 行锁/表锁，
            // 每 5 分钟扫描一次，回收空闲超过 30 分钟的事务（移除后 SQLx 自动 ROLLBACK 释放锁）。
            {
                let tx_state_bg = tx_state.clone();
                tauri::async_runtime::spawn(async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5 * 60));
                    loop {
                        tick.tick().await;
                        let n = commands::db_tx::cleanup_stale_txns(&tx_state_bg).await;
                        if n > 0 {
                            log::info!("已回收 {n} 个僵尸事务（释放 DB 锁）");
                        }
                    }
                });
            }
            app.manage(tx_state);

            // 流式导出取消标志（task_id → AtomicBool）
            let export_cancel: ExportCancelMap = Arc::new(Mutex::new(HashMap::new()));
            app.manage(export_cancel);

            // Redis 连接池（(conn_id, db) → 连接 + SSH 隧道守卫）
            let redis_pool: RedisPool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            app.manage(redis_pool);

            // Redis 只读模式集合
            let redis_readonly: RedisReadonly =
                Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()));
            app.manage(redis_readonly);

            // SQLite ATTACH 状态（conn_id → Vec<(alias, path)>）
            let sqlite_attach: SqliteAttachMap = Arc::new(std::sync::Mutex::new(HashMap::new()));
            app.manage(sqlite_attach);

            // SQLite 文件监控状态（conn_id → notify watcher）
            let sqlite_watchers: commands::sqlite_admin::SqliteWatcherMap =
                Arc::new(std::sync::Mutex::new(HashMap::new()));
            app.manage(sqlite_watchers);

            // MongoDB 连接池（conn_id → Client + 隧道守卫）
            let mongo_pool: MongoPool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            app.manage(mongo_pool);

            // MongoDB 多文档事务状态（MO10.7）
            let mongo_tx: MongoTxMap = commands::mongo::tx::init_tx_map();
            app.manage(mongo_tx);

            // MongoDB Change Streams 监听任务状态（MO11.2）
            let mongo_watch: commands::mongo::stream::MongoWatchMap =
                commands::mongo::stream::init_watch_map();
            app.manage(mongo_watch);

            // DuckDB 连接池（conn_id → DuckConnState，通过 libloading C API 访问）
            let duck_pool: DuckPool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            app.manage(duck_pool);

            // 外部驱动注册表（DuckDB/DM/Oracle/SQL Server），init_registry 内部调用 init_dir
            let driver_reg_map = commands::driver::init_registry(&data_dir);
            let driver_registry: DriverRegistry = Arc::new(tokio::sync::Mutex::new(driver_reg_map));
            app.manage(driver_registry);

            // SQL Server 连接池（MS0.x，tiberius 纯 Rust）
            let ss_pool: SsPool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
            app.manage(ss_pool);

            // Oracle 手动事务连接池（持久 OciHandles，conn_id → Arc<Mutex<OciHandles>>）
            app.manage(commands::oracle::OracleTxPool::new());

            // Windows：关闭 WebView2 浏览器加速键（Ctrl+P 打印 / Ctrl+R 整页刷新 / Ctrl+F 查找 /
            // Ctrl+U 源代码 等），让应用自身快捷键拥有最高优先级。不影响 Ctrl+C/V/X/A 等编辑键。
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows::core::Interface;
                let _ = win.with_webview(|webview| unsafe {
                    if let Ok(core) = webview.controller().CoreWebView2() {
                        if let Ok(settings) = core.Settings() {
                            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            // 连接管理
            commands::db::list_connections,
            commands::db::save_connection,
            commands::db::delete_connection,
            commands::db::get_connection_password,
            commands::db::wipe_local_data,
            commands::db::test_connection,
            // SSH 终端
            commands::ssh::connect_ssh,
            commands::ssh::write_to_ssh,
            commands::ssh::resize_pty,
            commands::ssh::disconnect_ssh,
            commands::ssh::ssh_session_alive,
            commands::ssh::ssh_session_runid,
            commands::ssh::respond_ssh_mfa,
            commands::ssh_config::list_known_hosts,
            commands::ssh_config::delete_known_host,
            commands::ssh::set_global_proxy,
            // SSH 辅助功能
            commands::ssh::exec_ssh_command,
            commands::ssh::clear_host_key,
            commands::ssh::chmod_file,
            commands::ssh::get_server_perf,
            commands::ssh::kill_process,
            commands::ssh::list_local_files,
            commands::ssh::get_local_start_path,
            commands::ssh::delete_local_file,
            commands::ssh::rename_local_file,
            commands::ssh::create_local_dir,
            commands::ssh::list_files,
            commands::ssh::delete_file,
            commands::ssh::rename_file,
            commands::ssh::create_dir,
            commands::ssh::download_file,
            commands::ssh::download_file_to,
            commands::ssh::upload_file,
            commands::ssh::upload_file_path,
            commands::ssh::get_file_start_path,
            commands::ssh::cancel_sftp_transfer,
            commands::ssh::download_dir,
            commands::ssh::download_dir_to,
            commands::ssh::upload_dir,
            // 远程文件在线编辑
            commands::ssh::read_remote_file,
            commands::ssh::write_remote_file,
            // SSH Config 导入
            commands::ssh::parse_ssh_config,
            // 连接导出/备份
            commands::ssh::export_connections_encrypted,
            commands::ssh::import_connections_encrypted,
            // SSH 密钥管理
            commands::ssh_keys::list_ssh_keys,
            commands::ssh_keys::generate_ssh_key,
            commands::ssh_keys::get_public_key,
            commands::ssh_keys::import_ssh_key,
            commands::ssh_keys::delete_ssh_key,
            // 本地终端 PTY
            commands::pty::spawn_local_shell,
            commands::pty::write_to_pty,
            commands::pty::resize_local_pty,
            commands::pty::close_pty,
            commands::pty::pty_alive,
            commands::pty::test_local_shell,
            commands::pty::list_path_commands,
            // SQL 编辑器
            commands::query::execute_query,
            commands::query::list_schemas,
            commands::query::list_tables,
            commands::query::list_ss_db_schemas,
            commands::query::list_ss_schema_tables,
            commands::query::table_columns,
            commands::query::schema_columns,
            commands::query::update_cell,
            commands::query::list_routines,
            commands::query::list_tables_meta,
            commands::query::get_table_ddl,
            commands::query::get_routine_ddl,
            commands::query::sqlite_list_objects,
            commands::query::sqlite_table_flags,
            // Redis 核心（R0–R1）
            commands::redis::redis_scan,
            commands::redis::redis_get,
            commands::redis::redis_del,
            commands::redis::redis_set,
            commands::redis::redis_expire,
            commands::redis::redis_bigkey_scan,
            commands::redis::redis_slowlog_get,
            commands::redis::slowlog_store::redis_slowlog_snapshot,
            commands::redis::slowlog_store::redis_slowlog_history,
            commands::redis::slowlog_store::redis_slowlog_history_clear,
            commands::redis::redis_batch_del,
            commands::redis::redis_scan_pattern,
            commands::redis::redis_batch_expire,
            commands::redis::redis_scan_with_ttl,
            commands::redis::redis_server_caps,
            commands::redis::redis_db_info,
            commands::redis::redis_disconnect,
            // Redis Key 操作（R1）
            commands::redis::keys::redis_key_detail,
            commands::redis::keys::redis_rename_key,
            commands::redis::keys::redis_copy_key,
            commands::redis::keys::redis_delete_large,
            // Redis 全类型编辑（R2）
            commands::redis::value::redis_hash_scan,
            commands::redis::value::redis_hash_set,
            commands::redis::value::redis_hash_del,
            commands::redis::value::redis_list_range,
            commands::redis::value::redis_list_push,
            commands::redis::value::redis_list_set,
            commands::redis::value::redis_list_remove,
            commands::redis::value::redis_set_scan,
            commands::redis::value::redis_set_add,
            commands::redis::value::redis_set_remove,
            commands::redis::value::redis_zset_range,
            commands::redis::value::redis_zset_add,
            commands::redis::value::redis_zset_remove,
            commands::redis::value::redis_stream_range,
            commands::redis::value::redis_stream_add,
            commands::redis::value::redis_stream_groups,
            commands::redis::value::redis_create_key,
            // Redis CLI + 监控（R3/R4）
            commands::redis::server::redis_cli_exec,
            commands::redis::server::redis_info_stats,
            commands::redis::server::redis_client_list,
            commands::redis::server::redis_client_kill,
            commands::redis::server::redis_config_get,
            commands::redis::server::redis_config_set,
            commands::redis::server::redis_slowlog_reset,
            commands::redis::server::redis_bgsave,
            commands::redis::server::redis_bgrewriteaof,
            // Redis R3.4 BUSY 急救
            commands::redis::server::redis_check_busy,
            commands::redis::server::redis_script_kill,
            commands::redis::server::redis_function_kill,
            // Redis R4.3 LATENCY
            commands::redis::server::redis_latency_latest,
            commands::redis::server::redis_latency_doctor,
            // Redis R4.4 内存分析
            commands::redis::server::redis_memory_analysis,
            // Redis R4.6 热/冷 key
            commands::redis::server::redis_hotkey_scan,
            commands::redis::server::redis_coldkey_scan,
            // Redis R4.7 主从复制
            commands::redis::server::redis_replication_info,
            // Redis R7.1 只读模式
            commands::redis::server::redis_set_readonly,
            commands::redis::server::redis_is_readonly,
            // Redis R8 DBA 管理工具
            commands::redis::server::redis_inspect_report,
            commands::redis::server::redis_config_risks,
            commands::redis::server::redis_acl_list,
            commands::redis::server::redis_acl_whoami,
            commands::redis::server::redis_acl_cat,
            commands::redis::server::redis_acl_setuser,
            commands::redis::server::redis_acl_deluser,
            // Redis 可选增强：键空间通知 / 内存碎片 / 模块列表 / 双实例配置对比
            commands::redis::server::redis_keyspace_notify_get,
            commands::redis::server::redis_keyspace_notify_set,
            commands::redis::server::redis_memory_purge,
            commands::redis::server::redis_module_list,
            commands::redis::server::redis_config_compare,
            // Redis R5 PubSub
            commands::redis::pubsub::redis_pubsub_channels,
            commands::redis::pubsub::redis_pubsub_numsub,
            commands::redis::pubsub::redis_publish,
            commands::redis::pubsub::redis_subscribe,
            // Redis R6 导入导出
            commands::redis::transfer::redis_export_keys,
            commands::redis::transfer::redis_import_keys,
            commands::redis::transfer::redis_cross_copy,
            commands::redis::transfer::redis_batch_preview,
            // DB 持久事务
            commands::db_tx::db_begin_tx,
            commands::db_tx::db_exec_in_tx,
            commands::db_tx::db_commit_tx,
            commands::db_tx::db_rollback_tx,
            commands::db_tx::db_tx_status,
            commands::db_tx::db_cleanup_stale_tx,
            // 数据对比（分块 merge-join，支持大表 / 跨连接）
            commands::db_diff::db_diff_data,
            // 流式导出
            commands::db_export::db_stream_export,
            commands::db_export::db_create_export_workspace,
            commands::db_export::db_cleanup_export_workspace,
            commands::db_export::db_pack_export_archive,
            commands::db_export::db_cancel_export,
            commands::db_export::reveal_in_folder,
            commands::db_export::read_file_first_line,
            // 高级数据库操作
            commands::db_extra::db_insert_rows,
            commands::db_extra::db_delete_rows,
            commands::db_extra::db_truncate_table,
            commands::db_extra::db_drop_table,
            commands::db_extra::db_rename_table,
            commands::db_extra::db_copy_table,
            commands::db_extra::db_export_table,
            commands::db_extra::db_export_schema,
            commands::db_extra::db_import_csv,
            commands::db_extra::db_exec_sql_file,
            commands::db_extra::db_diff_structure,
            commands::db_extra::db_migrate_table,
            commands::db_extra::db_logical_backup,
            commands::db_extra::db_process_list,
            commands::db_extra::db_kill_process,
            commands::db_extra::db_terminate_process,
            commands::db_extra::db_cancel_query,
            // F2 容量统计 / F5 变量状态 / R10 实例信息 / R1 库管理
            commands::db_extra::db_table_sizes,
            commands::db_extra::db_show_variables,
            commands::db_extra::db_instance_info,
            commands::db_extra::db_create_database,
            commands::db_extra::db_drop_database,
            // E3 EXPLAIN 执行计划
            commands::db_extra::db_explain,
            // F3 慢查询 / F4 用户权限
            commands::db_extra::db_slow_queries,
            commands::db_extra::db_list_users,
            // DBA 面板（跨方言）
            commands::db_dba::db_dba_query,
            commands::db_dba::db_dba_health,
            commands::db_dba::db_dba_kill_session,
            // R3 存储过程/函数管理
            commands::db_extra::db_drop_routine,
            commands::db_extra::db_call_procedure,
            // H4 健康巡检
            commands::db_extra::db_health_check,
            // Q6 迁移后校验
            commands::db_extra::db_verify_migration,
            // H2 主从复制状态
            commands::db_extra::db_replication_status,
            // G4 备份完整性校验
            commands::db_extra::db_backup_integrity,
            // L3 序列/自增管理
            commands::db_extra::db_list_sequences,
            commands::db_extra::db_set_auto_increment,
            // R4 分区表管理
            commands::db_extra::db_list_partitions,
            commands::db_extra::db_drop_partition,
            commands::db_extra::db_truncate_partition,
            // I4 用户权限管理（写）
            commands::db_extra::db_create_user,
            commands::db_extra::db_drop_user,
            commands::db_extra::db_grant_privilege,
            commands::db_extra::db_revoke_privilege,
            commands::db_extra::db_change_password,
            commands::db_extra::db_set_user_lock,
            // Q4 增量迁移
            commands::db_extra::db_incremental_migrate,
            // M2 数据字典
            commands::db_extra::db_data_dictionary,
            // H1 实例仪表盘
            commands::db_extra::db_instance_metrics,
            // M1 ER 关系图
            commands::db_extra::db_er_data,
            // J4 数据全文检索
            commands::db_extra::db_fulltext_search,
            // DB 能力探测（MA0.2 / PG0.2 / CH0.3）
            commands::db_caps::detect_db_caps,
            // MariaDB 专属命令（MA1.1 / MA1.2 / MA3.3 …）
            commands::mariadb_admin::mariadb_list_sequences,
            commands::mariadb_admin::mariadb_galera_status,
            commands::mariadb_admin::mariadb_table_extra_info,
            // MariaDB 可选增强：MyRocks 指标 / binlog 浏览 / MaxScale 探测
            commands::mariadb_admin::mariadb_rocksdb_stats,
            commands::mariadb_admin::mariadb_binlog_files,
            commands::mariadb_admin::mariadb_binlog_events,
            commands::mariadb_admin::mariadb_maxscale_detect,
            // TiDB TiCDC 同步任务状态（HTTP API）
            commands::tidb_cdc::tidb_ticdc_changefeeds,
            // MongoDB 命令域（MO0–MO7）
            commands::mongo::mongo_disconnect,
            commands::mongo::mongo_test,
            commands::mongo::browse::mongo_list_databases,
            commands::mongo::browse::mongo_list_collections,
            commands::mongo::browse::mongo_find_docs,
            commands::mongo::browse::mongo_count_docs,
            commands::mongo::browse::mongo_coll_stats,
            commands::mongo::browse::mongo_get_doc,
            commands::mongo::crud::mongo_insert_one,
            commands::mongo::crud::mongo_replace_one,
            commands::mongo::crud::mongo_delete_one,
            commands::mongo::crud::mongo_count_preview,
            commands::mongo::crud::mongo_delete_many,
            commands::mongo::crud::mongo_update_many,
            commands::mongo::crud::mongo_drop_collection,
            commands::mongo::crud::mongo_create_collection,
            commands::mongo::admin::mongo_server_status,
            commands::mongo::admin::mongo_current_op,
            commands::mongo::admin::mongo_build_info,
            commands::mongo::admin::mongo_list_indexes,
            commands::mongo::admin::mongo_drop_index,
            commands::mongo::admin::mongo_kill_op,
            commands::mongo::admin::mongo_run_command,
            commands::mongo::admin::mongo_config_risks,
            commands::mongo::admin::mongo_repl_set_status,
            commands::mongo::admin::mongo_oplog_info,
            commands::mongo::admin::mongo_get_profile_status,
            commands::mongo::admin::mongo_set_profile_level,
            commands::mongo::admin::mongo_slow_queries,
            commands::mongo::admin::mongo_db_storage,
            commands::mongo::admin::mongo_shard_status,
            commands::mongo::admin::mongo_shard_key_info,
            commands::mongo::admin::mongo_balancer_window_get,
            commands::mongo::admin::mongo_balancer_window_set,
            commands::mongo::admin::mongo_recovery_guide,
            commands::mongo::aggregate::mongo_aggregate,
            commands::mongo::aggregate::mongo_aggregate_explain,
            commands::mongo::aggregate::mongo_sample_fields,
            commands::mongo::index::mongo_create_index,
            commands::mongo::index::mongo_index_advisor,
            commands::mongo::transfer::mongo_export_collection,
            commands::mongo::transfer::mongo_export_collection_masked,
            commands::mongo::transfer::mongo_import_collection,
            // MongoDB 可选增强：逻辑备份 / 跨实例复制 / GridFS / Change Streams
            commands::mongo::transfer::mongo_logical_backup,
            commands::mongo::transfer::mongo_copy_collection,
            commands::mongo::gridfs::mongo_gridfs_list,
            commands::mongo::gridfs::mongo_gridfs_upload,
            commands::mongo::gridfs::mongo_gridfs_download,
            commands::mongo::gridfs::mongo_gridfs_delete,
            commands::mongo::stream::mongo_watch_start,
            commands::mongo::stream::mongo_watch_stop,
            // MO10.1+MO10.2: 一键巡检
            commands::mongo::inspect::mongo_inspect,
            // MO10.3: schema 分析
            commands::mongo::schema::mongo_schema_analyze,
            // MO10.7: 多文档事务
            commands::mongo::tx::mongo_tx_begin,
            commands::mongo::tx::mongo_tx_exec,
            commands::mongo::tx::mongo_tx_commit,
            commands::mongo::tx::mongo_tx_abort,
            commands::mongo::tx::mongo_tx_list,
            commands::mongo::tx::mongo_tx_cleanup,
            // MO9.3: 用户与角色管理
            commands::mongo::security::mongo_users_info,
            commands::mongo::security::mongo_roles_info,
            commands::mongo::security::mongo_create_user,
            commands::mongo::security::mongo_update_user_password,
            commands::mongo::security::mongo_drop_user,
            commands::mongo::security::mongo_grant_roles_to_user,
            commands::mongo::security::mongo_revoke_roles_from_user,
            // 本地文件导出
            read_local_file,
            write_local_file,
            write_local_bytes,
            document_converter_probe,
            open_document_converter_dir,
            install_document_converter_components,
            convert_document_file,
            // SQLite 可选增强：EXPLAIN 字节码 / AUTOINCREMENT 计数器 / 文件变更监控
            commands::sqlite_admin::sqlite_explain_bytecode,
            commands::sqlite_admin::sqlite_sequence_list,
            commands::sqlite_admin::sqlite_sequence_reset,
            commands::sqlite_admin::sqlite_watch_start,
            commands::sqlite_admin::sqlite_watch_stop,
            // SQLite 管理（S0.4 + S2）
            commands::sqlite_admin::sqlite_conn_info,
            commands::sqlite_admin::sqlite_file_health,
            commands::sqlite_admin::sqlite_attach,
            commands::sqlite_admin::sqlite_detach,
            commands::sqlite_admin::sqlite_list_attached,
            commands::sqlite_admin::sqlite_alter_table_preview,
            commands::sqlite_admin::sqlite_alter_table_execute,
            commands::sqlite_admin::sqlite_lock_diagnosis,
            commands::sqlite_admin::sqlite_index_advisor,
            commands::sqlite_admin::sqlite_backup,
            commands::sqlite_admin::sqlite_backup_list,
            commands::sqlite_admin::sqlite_restore_backup,
            commands::sqlite_admin::sqlite_dump_sql,
            commands::sqlite_admin::sqlite_rescue,
            commands::sqlite_admin::sqlite_db_diff,
            commands::sqlite_admin::sqlite_health_report,
            commands::sqlite_admin::sqlite_data_dictionary,
            commands::sqlite_admin::sqlite_integrity_check,
            commands::sqlite_admin::sqlite_vacuum,
            commands::sqlite_admin::sqlite_analyze,
            commands::sqlite_admin::sqlite_optimize,
            commands::sqlite_admin::sqlite_space_stats,
            commands::sqlite_admin::sqlite_wal_status,
            commands::sqlite_admin::sqlite_wal_checkpoint,
            commands::sqlite_admin::sqlite_set_journal_mode,
            commands::sqlite_admin::sqlite_pragma_list,
            commands::sqlite_admin::sqlite_set_pragma,
            // DuckDB 可选增强：FTS 索引列表 / 双库 schema 对比 / 脱敏导出
            commands::duckdb::duckdb_fts_list,
            commands::duckdb::duckdb_db_diff,
            commands::duckdb::duckdb_export_masked,
            // DuckDB 命令（DD1.x）
            commands::duckdb::duckdb_disconnect,
            commands::duckdb::duckdb_query,
            commands::duckdb::duckdb_list_schemas,
            commands::duckdb::duckdb_list_tables,
            commands::duckdb::duckdb_list_columns,
            commands::duckdb::duckdb_conn_info,
            commands::duckdb::duckdb_install_ext,
            commands::duckdb::duckdb_load_ext,
            commands::duckdb::duckdb_pragmas,
            commands::duckdb::duckdb_summarize,
            commands::duckdb::duckdb_copy_to,
            commands::duckdb::duckdb_list_databases,
            commands::duckdb::duckdb_attach,
            commands::duckdb::duckdb_detach,
            commands::duckdb::duckdb_export_database,
            commands::duckdb::duckdb_import_database,
            commands::duckdb::duckdb_file_backup,
            commands::duckdb::duckdb_checkpoint,
            commands::duckdb::duckdb_vacuum,
            commands::duckdb::duckdb_health_check,
            commands::duckdb::duckdb_profile_query,
            commands::duckdb::duckdb_set_ext_repo,
            commands::duckdb::duckdb_set_pragma,
            commands::duckdb::duckdb_list_secrets,
            commands::duckdb::duckdb_create_s3_secret,
            commands::duckdb::duckdb_drop_secret,
            // SQL Server 命令（MS0.x）
            commands::sqlserver::ss_disconnect,
            commands::sqlserver::ss_test,
            // SQL Server EXPLAIN（MS0.6）
            commands::sqlserver::admin::ss_explain,
            // SQL Server DMV 监控（MS1.x）
            commands::sqlserver::admin::ss_session_list,
            commands::sqlserver::admin::ss_kill_spid,
            commands::sqlserver::admin::ss_top_sql,
            commands::sqlserver::admin::ss_lock_info,
            commands::sqlserver::admin::ss_wait_stats,
            commands::sqlserver::admin::ss_instance_metrics,
            // SQL Server 索引/统计/tempdb/容量（MS2.x）
            commands::sqlserver::admin::ss_index_frag,
            commands::sqlserver::admin::ss_missing_indexes,
            commands::sqlserver::admin::ss_unused_indexes,
            commands::sqlserver::admin::ss_stale_stats,
            commands::sqlserver::admin::ss_tempdb_info,
            commands::sqlserver::admin::ss_db_sizes,
            // SQL Server 高可用/备份/分区/Agent（MS3.x）
            commands::sqlserver::ha::ss_ag_status,
            commands::sqlserver::ha::ss_backup_history,
            commands::sqlserver::ha::ss_partition_info,
            commands::sqlserver::ha::ss_agent_jobs,
            // SQL Server 安全/巡检/配置/实例信息（MS4.x）
            commands::sqlserver::security::ss_list_logins,
            commands::sqlserver::security::ss_list_db_users,
            commands::sqlserver::security::ss_security_features,
            commands::sqlserver::security::ss_health_check,
            commands::sqlserver::security::ss_configurations,
            commands::sqlserver::security::ss_server_info,
            // SQL Server DBA 补强（MS5.x）
            commands::sqlserver::extra::ss_cdc_status,
            commands::sqlserver::extra::ss_resource_pools,
            commands::sqlserver::extra::ss_linked_servers,
            commands::sqlserver::extra::ss_broker_queues,
            // SQL Server 可选增强：Query Store / Extended Events / Azure / PolyBase
            commands::sqlserver::extra::ss_query_store_plans,
            commands::sqlserver::extra::ss_force_plan,
            commands::sqlserver::extra::ss_unforce_plan,
            commands::sqlserver::extra::ss_missing_index_scripts,
            commands::sqlserver::extra::ss_xe_sessions,
            commands::sqlserver::extra::ss_azure_metrics,
            commands::sqlserver::extra::ss_external_data_sources,
            // PostgreSQL 可选增强：pgvector / 索引顾问 / EXPLAIN JSON / PgBouncer / 配置对比
            commands::pg_admin::pg_vector_info,
            commands::pg_admin::pg_index_advisor,
            commands::pg_admin::pg_explain_json,
            commands::pg_admin::pg_pgbouncer_detect,
            commands::pg_admin::pg_settings_diff,
            // ClickHouse 可选增强：Kafka 消费者 / 外部表 / 物化视图血缘
            commands::clickhouse::ch_kafka_consumers,
            commands::clickhouse::ch_external_tables,
            commands::clickhouse::ch_mv_lineage,
            // Oracle 命令（OR0-OR4）
            commands::oracle::oracle_test_connection,
            // OR1：通用查询 + Schema 浏览
            commands::oracle::oracle_execute_query,
            commands::oracle::oracle_list_schemas,
            commands::oracle::oracle_list_tables,
            commands::oracle::oracle_table_columns,
            commands::oracle::oracle_get_table_ddl,
            commands::oracle::oracle_list_indexes,
            commands::oracle::oracle_list_constraints,
            commands::oracle::oracle_list_routines,
            commands::oracle::oracle_list_triggers,
            commands::oracle::oracle_list_sequences,
            // OR2：DML / DDL 操作
            commands::oracle::oracle_update_cell,
            commands::oracle::oracle_delete_rows,
            commands::oracle::oracle_insert_rows,
            commands::oracle::oracle_drop_table,
            commands::oracle::oracle_truncate_table,
            commands::oracle::oracle_rename_table,
            commands::oracle::oracle_drop_routine,
            commands::oracle::oracle_get_routine_source,
            // OR3：DBA 监控
            commands::oracle::oracle_session_list,
            commands::oracle::oracle_kill_session,
            commands::oracle::oracle_top_sql,
            commands::oracle::oracle_awr_snapshots,
            commands::oracle::oracle_tablespace_usage,
            commands::oracle::oracle_lock_info,
            commands::oracle::oracle_instance_metrics,
            // OR4：安全与维护
            commands::oracle::oracle_list_users,
            commands::oracle::oracle_create_user,
            commands::oracle::oracle_drop_user,
            commands::oracle::oracle_set_user_lock,
            commands::oracle::oracle_change_password,
            commands::oracle::oracle_list_privileges,
            commands::oracle::oracle_grant_privilege,
            commands::oracle::oracle_revoke_privilege,
            commands::oracle::oracle_audit_trail,
            commands::oracle::oracle_list_partitions,
            commands::oracle::oracle_drop_partition,
            commands::oracle::oracle_truncate_partition,
            commands::oracle::oracle_health_check,
            commands::oracle::oracle_undo_redo_stats,
            commands::oracle::oracle_wait_events,
            commands::oracle::oracle_data_guard_status,
            commands::oracle::oracle_invalid_objects,
            commands::oracle::oracle_stale_stats,
            // DR 模块：外部驱动管理
            commands::driver::probe::dr_probe_all,
            commands::driver::probe::dr_probe_one,
            commands::driver::probe::dr_set_path,
            commands::driver::probe::dr_clear_path,
            commands::driver::probe::dr_list,
            commands::driver::probe::dr_file_hash,
            commands::driver::download::dr_download,
            commands::driver::download::dr_download_version,
            commands::driver::download::dr_run_cmd,
            current_os,
            open_url,
            confirm_app_exit,
        ])
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用时出错")
        .run(|app_handle, event| {
            match event {
                // 应用就绪后再安装 macOS 终止钩子：此时 NSApp delegate 已设置
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Ready => {
                    macos_quit::install(app_handle.clone());
                }
                // 退出守卫：拦截一切退出（Cmd+Q / 程序坞退出 / 菜单退出 / 关闭最后窗口），
                // 除非前端已确认（EXIT_CONFIRMED=true，由 confirm_app_exit 设置后 app.exit 触发）。
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if !EXIT_CONFIRMED.load(Ordering::SeqCst) {
                        api.prevent_exit();
                        let _ = app_handle.emit("app:quit-requested", ());
                    }
                }
                _ => {}
            }
        });
}
