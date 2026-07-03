use serde::{Deserialize, Serialize};

/// 连接类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnType {
    Local,  // 本地终端（仅前端使用，存于同一 connections.json）
    Ssh,
    Mysql,
    Postgres,
    Sqlite,
    Redis,
    // 国产数据库（通过兼容协议连接）
    Tidb,       // MySQL 协议
    OceanBase,  // MySQL 协议
    Mariadb,    // MySQL 协议
    KingBase,   // PostgreSQL 协议
    OpenGauss,  // PostgreSQL 协议
    ClickHouse, // HTTP 接口
    Mongodb,    // MongoDB，官方纯 Rust 驱动
    Duckdb,     // DuckDB，libduckdb C API 动态加载
    SqlServer,  // SQL Server，tiberius 纯 Rust 驱动
    Oracle,     // Oracle，OCI 动态加载（libloading + Instant Client）
}

impl ConnType {
    #[allow(dead_code)]
    pub fn default_port(&self) -> u16 {
        match self {
            Self::Local => 0,
            Self::Ssh => 22,
            Self::Mysql | Self::Tidb | Self::OceanBase | Self::Mariadb => 3306,
            Self::Postgres | Self::KingBase | Self::OpenGauss => 5432,
            Self::Sqlite => 0,
            Self::Redis => 6379,
            Self::ClickHouse => 8123,
            Self::Mongodb => 27017,
            Self::Duckdb => 0,
            Self::SqlServer => 1433,
            Self::Oracle => 1521,
        }
    }
}

/// 连接配置（不含密码，密码存于系统钥匙串）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub conn_type: ConnType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub database: Option<String>,
    pub file_path: Option<String>,
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    pub use_ssl: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 用户自定义颜色标签（十六进制色值）
    #[serde(default)]
    pub color: Option<String>,
    /// 连接类型专有扩展配置（JSON 字符串，SSH extra / 本地终端 extra）
    #[serde(default)]
    pub extra_json: Option<String>,
    /// 只读模式（SQLite/通用）
    #[serde(default)]
    pub read_only: Option<bool>,
    /// 环境标签：prod / staging / test（生产环境写操作前二次确认）
    #[serde(default)]
    pub env_label: Option<String>,
}

/// 连接测试结果
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

/// 单个磁盘分区信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEntry {
    pub mount: String,
    pub total: u64,
    pub used:  u64,
}

/// 服务器性能数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPerf {
    pub hostname:  String,
    pub username:  String,
    pub uptime:    String,
    pub os:        String,
    pub ip:        String,   // 连接 IP（来自配置）
    pub cpu_total: f32,
    pub cpu_cores: Vec<f32>,
    pub cpu_count: u32,      // 逻辑核心数
    pub mem_total: u64,      // bytes
    pub mem_used:  u64,
    pub swap_total: u64,
    pub swap_used:  u64,
    pub disk_total: u64,     // 根分区 bytes（兼容旧字段）
    pub disk_used:  u64,
    pub disks:      Vec<DiskEntry>,  // 所有真实分区
    pub net_rx: u64,         // cumulative bytes
    pub net_tx: u64,
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid:     u32,
    pub name:    String,
    pub cpu_pct: f32,
    pub mem_mb:  f32,
    pub status:  String,
}

/// SQL 查询结果
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    pub execution_time_ms: u64,
    #[serde(default)]
    pub truncated: bool,
    /// 是否是 SELECT 类查询（即使返回 0 行也为 true）
    #[serde(default)]
    pub is_select: bool,
}

/// 数据库表/视图信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub is_view: bool,
}

/// 表列结构信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,          // PRI / UNI / MUL / 空
    pub default_value: Option<String>,
}

/// 存储过程/函数/触发器信息（RoutineInfo 移至 models 避免 query↔sqlserver 循环依赖）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name:         String,
    pub routine_type: String,  // PROCEDURE | FUNCTION | TRIGGER | SYNONYM | OTHER
}

/// 远程文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name:        String,
    pub path:        String,
    pub is_dir:      bool,
    pub size:        u64,
    pub modified:    String,
    pub permissions: String,
}
