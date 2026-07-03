// DR 模块：外部驱动管理
// DR0: 注册表 + 探测 + 动态加载 + 下载器
// 仅服务于 DuckDB(libloading) / DM / Oracle / SQL Server(ODBC)
// 原生内置驱动(MySQL/PG/SQLite/Redis/MongoDB/ClickHouse)不经此模块

pub mod probe;
pub mod download;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use std::path::PathBuf;

static DRIVER_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init_dir(app_data_dir: &PathBuf) {
    let dir = app_data_dir.join("drivers");
    let _ = std::fs::create_dir_all(&dir);
    DRIVER_DIR.get_or_init(|| dir);
}

pub fn driver_dir() -> &'static PathBuf {
    DRIVER_DIR.get().expect("driver_dir 未初始化")
}

/// 驱动种类
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DriverKind {
    Dylib,   // 动态库直载(DuckDB)
    Odbc,    // ODBC 桥接(DM/SQL Server)
    OciDir,  // Oracle Instant Client 目录（运行时 libloading 加载 oci.dll）
}

/// 驱动状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DriverStatus {
    Unknown,
    NotAvailable,
    AvailableAt { path: String },
    Ready,
}

/// 下载规格（单平台）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformDownload {
    pub url: String,          // 官方下载 URL（空字符串表示"仅手动指定"）
    pub sha256: String,       // 空字符串表示无校验和
    pub file_name: String,
}

/// 可选版本条目（前端版本选择器使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverVersion {
    pub version: String,
    pub label: String,
    pub win_x64: Option<PlatformDownload>,
    pub linux_x64: Option<PlatformDownload>,
    pub mac_arm64: Option<PlatformDownload>,
    /// 下载后用系统程序打开（MSI 安装包）而非作为驱动路径
    pub open_after_download: bool,
    /// macOS 一键安装命令（brew install ...）
    pub mac_cmd: Option<String>,
    /// Linux 一键安装命令（apt install ...）
    pub linux_cmd: Option<String>,
}

/// 驱动元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverMeta {
    pub driver_type: String,     // "duckdb" | "dm" | "oracle" | "sqlserver"
    pub kind: DriverKind,
    pub display_name: String,
    pub vendor: String,
    pub notes: String,           // 说明，\n 分行
    pub manual_only: bool,       // 是否只能手动指定（无直链）
    pub install_guide_url: Option<String>, // manual_only 时打开的安装指引页
    pub win_x64: Option<PlatformDownload>,
    pub linux_x64: Option<PlatformDownload>,
    pub mac_arm64: Option<PlatformDownload>,
    pub min_version: String,
    pub system_prereq: String,   // "unixODBC" on Linux/Mac for ODBC
    /// 多版本列表（可为空；非空时前端显示版本选择器）
    pub versions: Vec<DriverVersion>,
}

/// 驱动运行时状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverState {
    pub meta: DriverMeta,
    pub status: DriverStatus,
    pub custom_path: Option<String>,   // 用户手动指定的路径
    pub installed_version: Option<String>,
    pub load_error: Option<String>,    // DR1.6: 加载失败原因（人类可读诊断）
}

/// 全局驱动注册表 State
pub type DriverRegistry = Arc<Mutex<HashMap<String, DriverState>>>;

/// 内置驱动元数据注册表
pub fn builtin_registry() -> Vec<DriverMeta> {
    vec![
        DriverMeta {
            driver_type: "duckdb".into(),
            kind: DriverKind::Dylib,
            display_name: "DuckDB".into(),
            vendor: "DuckDB Foundation".into(),
            notes: "开源免费，官方直链可自动下载".into(),
            manual_only: false,
            install_guide_url: Some("https://duckdb.org/docs/installation/".into()),
            win_x64: Some(PlatformDownload {
                url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-windows-amd64.zip".into(),
                sha256: "11842aca19ec7a415ffbb732ec4818a1562111fb4151fd59d1b3a40b551db26e".into(),
                file_name: "duckdb.dll".into(),
            }),
            linux_x64: Some(PlatformDownload {
                url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-linux-amd64.zip".into(),
                sha256: "0a926eba5bce0abc0010f4b9109133e4440cb74e97bd10fd2d0fc2a721621b05".into(),
                file_name: "libduckdb.so".into(),
            }),
            mac_arm64: Some(PlatformDownload {
                url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-osx-universal.zip".into(),
                sha256: "386f8e8b3b4bc8d128762327121e22065ce45f2ee55ef1b1f412ce11e0e6c51f".into(),
                file_name: "libduckdb.dylib".into(),
            }),
            min_version: "1.1.0".into(),
            system_prereq: "".into(),
            versions: vec![
                DriverVersion {
                    version: "1.5.3".into(), label: "v1.5.3（推荐，最新稳定）".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-windows-amd64.zip".into(),
                        sha256: "11842aca19ec7a415ffbb732ec4818a1562111fb4151fd59d1b3a40b551db26e".into(),
                        file_name: "duckdb.dll".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-linux-amd64.zip".into(),
                        sha256: "0a926eba5bce0abc0010f4b9109133e4440cb74e97bd10fd2d0fc2a721621b05".into(),
                        file_name: "libduckdb.so".into(),
                    }),
                    mac_arm64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.5.3/libduckdb-osx-universal.zip".into(),
                        sha256: "386f8e8b3b4bc8d128762327121e22065ce45f2ee55ef1b1f412ce11e0e6c51f".into(),
                        file_name: "libduckdb.dylib".into(),
                    }),
                },
                DriverVersion {
                    version: "1.2.2".into(), label: "v1.2.2".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.2.2/libduckdb-windows-amd64.zip".into(),
                        sha256: "".into(), file_name: "duckdb.dll".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.2.2/libduckdb-linux-amd64.zip".into(),
                        sha256: "".into(), file_name: "libduckdb.so".into(),
                    }),
                    mac_arm64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.2.2/libduckdb-osx-universal.zip".into(),
                        sha256: "".into(), file_name: "libduckdb.dylib".into(),
                    }),
                },
                DriverVersion {
                    version: "1.1.3".into(), label: "v1.1.3".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.1.3/libduckdb-windows-amd64.zip".into(),
                        sha256: "".into(), file_name: "duckdb.dll".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.1.3/libduckdb-linux-amd64.zip".into(),
                        sha256: "".into(), file_name: "libduckdb.so".into(),
                    }),
                    mac_arm64: Some(PlatformDownload {
                        url: "https://github.com/duckdb/duckdb/releases/download/v1.1.3/libduckdb-osx-universal.zip".into(),
                        sha256: "".into(), file_name: "libduckdb.dylib".into(),
                    }),
                },
            ],
        },
        DriverMeta {
            driver_type: "dm".into(),
            kind: DriverKind::Odbc,
            display_name: "达梦 DM8".into(),
            vendor: "武汉达梦数据库股份有限公司".into(),
            notes: "商业授权，需从达梦官网下载 DM8 客户端并安装 ODBC 驱动".into(),
            manual_only: true,
            install_guide_url: Some("https://eco.dameng.com/download/".into()),
            win_x64: None, linux_x64: None, mac_arm64: None,
            min_version: "DM 8.0".into(),
            system_prereq: "unixODBC（Linux/macOS）".into(),
            versions: vec![],
        },
        DriverMeta {
            driver_type: "oracle".into(),
            kind: DriverKind::OciDir,
            display_name: "Oracle Instant Client".into(),
            vendor: "Oracle Corporation".into(),
            notes: "Oracle Instant Client Basic Lite（Linux/Win 自动下载 ZIP）\n解压后通过 libloading 运行时加载，无需安装 ODBC\n21c 支持 Oracle 11g R2+；12.2 支持 Oracle 10g R2+\nmacOS ARM64：官方仅提供 DMG，请从官网下载后「手动指定」目录".into(),
            manual_only: false,
            install_guide_url: Some("https://www.oracle.com/database/technologies/instant-client/macos-arm64-downloads.html".into()),
            win_x64: Some(PlatformDownload {
                url: "https://download.oracle.com/otn_software/nt/instantclient/2114000/instantclient-basiclite-windows.x64-21.14.0.0.0dbru.zip".into(),
                sha256: "".into(),
                file_name: "instantclient-basiclite-windows.x64-21.14.0.0.0dbru.zip".into(),
            }),
            linux_x64: Some(PlatformDownload {
                url: "https://download.oracle.com/otn_software/linux/instantclient/2114000/instantclient-basiclite-linux.x64-21.14.0.0.0dbru.zip".into(),
                sha256: "".into(),
                file_name: "instantclient-basiclite-linux.x64-21.14.0.0.0dbru.zip".into(),
            }),
            mac_arm64: Some(PlatformDownload {
                // Oracle ARM64 官方仅提供 DMG；下载器会自动 hdiutil attach + 复制文件
                url: "https://download.oracle.com/otn_software/mac/instantclient/instantclient-basiclite-macos-arm64.dmg".into(),
                sha256: "".into(),
                file_name: "instantclient-basiclite-macos-arm64.dmg".into(),
            }),
            min_version: "21c Basic Lite".into(),
            system_prereq: "".into(),
            versions: vec![
                DriverVersion {
                    version: "21.14".into(),
                    label: "21c Basic Lite（推荐 · Oracle 11g R2+，全平台）".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/nt/instantclient/2114000/instantclient-basiclite-windows.x64-21.14.0.0.0dbru.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-windows.x64-21.14.0.0.0dbru.zip".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/linux/instantclient/2114000/instantclient-basiclite-linux.x64-21.14.0.0.0dbru.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-linux.x64-21.14.0.0.0dbru.zip".into(),
                    }),
                    mac_arm64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/mac/instantclient/instantclient-basiclite-macos-arm64.dmg".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-macos-arm64.dmg".into(),
                    }),
                },
                DriverVersion {
                    version: "19.23".into(),
                    label: "19c Basic Lite（Oracle 11g R2+ · Linux/Win x64）".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/nt/instantclient/1923000/instantclient-basiclite-windows.x64-19.23.0.0.0dbru.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-windows.x64-19.23.0.0.0dbru.zip".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/linux/instantclient/1923000/instantclient-basiclite-linux.x64-19.23.0.0.0dbru.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-linux.x64-19.23.0.0.0dbru.zip".into(),
                    }),
                    mac_arm64: None, // Oracle 19c 无 macOS ARM64 包
                },
                DriverVersion {
                    version: "12.2.0.1".into(),
                    label: "12.2 Basic Lite（Oracle 10g R2+ 老版本兼容 · Linux/Win x64）".into(),
                    open_after_download: false, mac_cmd: None, linux_cmd: None,
                    win_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/nt/instantclient/122010/instantclient-basiclite-windows.x64-12.2.0.1.0.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-windows.x64-12.2.0.1.0.zip".into(),
                    }),
                    linux_x64: Some(PlatformDownload {
                        url: "https://download.oracle.com/otn_software/linux/instantclient/122010/instantclient-basiclite-linux.x64-12.2.0.1.0.zip".into(),
                        sha256: "".into(),
                        file_name: "instantclient-basiclite-linux.x64-12.2.0.1.0.zip".into(),
                    }),
                    mac_arm64: None, // Oracle 12.2 无 macOS ARM64 包
                },
            ],
        },
        DriverMeta {
            driver_type: "sqlserver".into(),
            kind: DriverKind::Odbc,
            display_name: "SQL Server".into(),
            vendor: "Microsoft".into(),
            notes: "微软官方 ODBC Driver for SQL Server\nWindows：直接下载 MSI 安装包到本地\nmacOS：brew install unixodbc msodbcsql18".into(),
            manual_only: false,
            install_guide_url: None,
            win_x64: None, linux_x64: None, mac_arm64: None,
            min_version: "ODBC Driver 17".into(),
            system_prereq: "unixODBC（Linux/macOS）".into(),
            versions: vec![
                DriverVersion {
                    version: "18".into(), label: "ODBC Driver 18（推荐）".into(),
                    open_after_download: true, // MSI：下载后用系统安装程序打开
                    mac_cmd: Some("brew install unixodbc msodbcsql18".into()),
                    linux_cmd: Some("sudo ACCEPT_EULA=Y apt-get install -y unixodbc-dev msodbcsql18".into()),
                    win_x64: Some(PlatformDownload {
                        url: "https://go.microsoft.com/fwlink/?linkid=2249004".into(),
                        sha256: "".into(),
                        file_name: "msodbcsql18.msi".into(),
                    }),
                    linux_x64: None,
                    mac_arm64: None,
                },
                DriverVersion {
                    version: "17".into(), label: "ODBC Driver 17".into(),
                    open_after_download: true,
                    mac_cmd: Some("brew install unixodbc msodbcsql17".into()),
                    linux_cmd: Some("sudo ACCEPT_EULA=Y apt-get install -y unixodbc-dev msodbcsql17".into()),
                    win_x64: Some(PlatformDownload {
                        url: "https://go.microsoft.com/fwlink/?linkid=2187214".into(),
                        sha256: "".into(),
                        file_name: "msodbcsql17.msi".into(),
                    }),
                    linux_x64: None,
                    mac_arm64: None,
                },
            ],
        },
    ]
}

/// 初始化注册表（在 init_dir 之后调用）
pub fn init_registry(app_data_dir: &PathBuf) -> HashMap<String, DriverState> {
    init_dir(app_data_dir);
    let mut map = HashMap::new();
    for meta in builtin_registry() {
        let dt = meta.driver_type.clone();
        let custom_path = load_custom_path(&dt);
        map.insert(dt, DriverState {
            meta,
            status: DriverStatus::Unknown,
            custom_path,
            installed_version: None,
            load_error: None,
        });
    }
    map
}

fn load_custom_path(driver_type: &str) -> Option<String> {
    let path = driver_dir().join(format!("{driver_type}.path"));
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn save_custom_path(driver_type: &str, path: &str) -> std::io::Result<()> {
    let file = driver_dir().join(format!("{driver_type}.path"));
    std::fs::write(file, path)
}

pub fn clear_custom_path(driver_type: &str) -> std::io::Result<()> {
    let file = driver_dir().join(format!("{driver_type}.path"));
    if file.exists() { std::fs::remove_file(file) } else { Ok(()) }
}
