//! # Data Models Module
//!
//! Core data structures for DBTerm, defining connection configurations,
//! query results, database metadata, and system information.
//!
//! ## Key Types
//!
//! - [`ConnType`] - Supported database types (MySQL, PostgreSQL, SQLite, Redis, etc.)
//! - [`ConnConfig`] - Database connection configuration
//! - [`QueryResult`] - Query execution results with metadata
//! - [`TableInfo`] - Database table metadata
//! - [`ServerPerf`] - System performance metrics
//!
//! ## Examples
//!
//! ```rust
//! use app_lib::models::{ConnType, ConnConfig};
//!
//! // Create a MySQL connection configuration
//! let config = ConnConfig {
//!     id: "conn-1".to_string(),
//!     name: "Production MySQL".to_string(),
//!     conn_type: ConnType::Mysql,
//!     host: Some("localhost".to_string()),
//!     port: Some(3306),
//!     username: Some("root".to_string()),
//!     database: Some("mydb".to_string()),
//!     file_path: None,
//!     ssh_key_path: None,
//!     use_ssl: false,
//!     created_at: 1724601600000,
//!     updated_at: 1724601600000,
//!     color: Some("#FF5733".to_string()),
//!     extra_json: None,
//!     read_only: Some(false),
//!     env_label: Some("prod".to_string()),
//! };
//! ```

use serde::{Deserialize, Serialize};

/// Supported database connection types
///
/// DBTerm supports multiple database engines with native and compatible protocols:
///
/// ## Native Support
/// - `Mysql` - MySQL 5.7+
/// - `Postgres` - PostgreSQL 10+
/// - `Sqlite` - SQLite 3.x
/// - `Redis` - Redis 6.0+
/// - `Mongodb` - MongoDB 4.0+
/// - `Duckdb` - DuckDB 0.8+
/// - `SqlServer` - SQL Server 2012+
/// - `Oracle` - Oracle 11g+
///
/// ## Compatible Protocols (Chinese Databases)
/// - `Tidb` - Uses MySQL protocol
/// - `OceanBase` - Uses MySQL protocol
/// - `Mariadb` - Uses MySQL protocol
/// - `KingBase` - Uses PostgreSQL protocol
/// - `OpenGauss` - Uses PostgreSQL protocol
/// - `ClickHouse` - Uses HTTP interface
///
/// ## Special Types
/// - `Local` - Local terminal (frontend only)
/// - `Ssh` - SSH connection
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
    /// Returns the default port number for this database type
    ///
    /// # Returns
    /// Standard port number for the database type, or 0 for file-based databases
    ///
    /// # Examples
    ///
    /// ```rust
    /// use app_lib::models::ConnType;
    ///
    /// assert_eq!(ConnType::Mysql.default_port(), 3306);
    /// assert_eq!(ConnType::Postgres.default_port(), 5432);
    /// assert_eq!(ConnType::Redis.default_port(), 6379);
    /// assert_eq!(ConnType::Sqlite.default_port(), 0); // File-based
    /// ```
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

/// Database connection configuration
///
/// Stores connection parameters for all supported database types.
/// Passwords are stored separately in the system keychain for security.
///
/// # Fields
///
/// - `id` - Unique identifier (UUID format)
/// - `name` - User-friendly display name
/// - `conn_type` - Database type (see [`ConnType`])
/// - `host` - Database server hostname or IP address
/// - `port` - Server port number (None uses default port)
/// - `username` - Authentication username
/// - `database` - Default database/schema name
/// - `file_path` - File path for file-based databases (SQLite, DuckDB)
/// - `ssh_key_path` - SSH key path for SSH connections
/// - `use_ssl` - Enable SSL/TLS encryption
/// - `created_at` - Creation timestamp (Unix milliseconds)
/// - `updated_at` - Last modification timestamp (Unix milliseconds)
/// - `color` - Custom color tag (hex format: #RRGGBB)
/// - `extra_json` - Type-specific extended configuration (JSON string)
/// - `read_only` - Read-only mode flag
/// - `env_label` - Environment label (prod/staging/test) for safety warnings
///
/// # Examples
///
/// ```rust
/// use app_lib::models::{ConnType, ConnConfig};
///
/// let config = ConnConfig {
///     id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
///     name: "Production PostgreSQL".to_string(),
///     conn_type: ConnType::Postgres,
///     host: Some("db.example.com".to_string()),
///     port: Some(5432),
///     username: Some("appuser".to_string()),
///     database: Some("app_production".to_string()),
///     file_path: None,
///     ssh_key_path: None,
///     use_ssl: true,
///     created_at: 1724601600000,
///     updated_at: 1724601600000,
///     color: Some("#3B82F6".to_string()),
///     extra_json: Some(r#"{"connectTimeout":5000,"sslMode":"require"}"#.to_string()),
///     read_only: Some(false),
///     env_label: Some("prod".to_string()),
/// };
/// ```
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

/// Connection test result
///
/// Contains the outcome of a database connection test, including
/// success status, diagnostic message, and latency measurement.
///
/// # Fields
///
/// - `success` - Whether the connection test succeeded
/// - `message` - Human-readable result message (error details on failure)
/// - `latency_ms` - Connection latency in milliseconds (None on failure)
///
/// # Examples
///
/// ```rust
/// use app_lib::models::TestResult;
///
/// // Successful connection
/// let success = TestResult {
///     success: true,
///     message: "Connected successfully".to_string(),
///     latency_ms: Some(23),
/// };
///
/// // Failed connection
/// let failure = TestResult {
///     success: false,
///     message: "Connection timeout after 5s".to_string(),
///     latency_ms: None,
/// };
/// ```
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

/// Disk partition information
///
/// Represents a single mounted filesystem with size information.
///
/// # Fields
///
/// - `mount` - Mount point path (e.g., "/", "/data", "C:\")
/// - `total` - Total capacity in bytes
/// - `used` - Used space in bytes
///
/// # Examples
///
/// ```rust
/// use app_lib::models::DiskEntry;
///
/// let disk = DiskEntry {
///     mount: "/data".to_string(),
///     total: 1_000_000_000_000, // 1TB
///     used: 450_000_000_000,    // 450GB
/// };
///
/// let usage_pct = (disk.used as f64 / disk.total as f64) * 100.0;
/// println!("Disk usage: {:.1}%", usage_pct); // "Disk usage: 45.0%"
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEntry {
    pub mount: String,
    pub total: u64,
    pub used:  u64,
}

/// Server performance metrics
///
/// Aggregates system resource usage including CPU, memory, disk, and network statistics.
/// Collected via system calls or SSH remote execution.
///
/// # Fields
///
/// - `hostname` - Server hostname
/// - `username` - Current user
/// - `cpu_usage` - CPU usage percentage (0.0-100.0)
/// - `mem_total` - Total physical memory in bytes
/// - `mem_used` - Used memory in bytes
/// - `disks` - List of mounted filesystems (see [`DiskEntry`])
/// - `net_rx` - Network receive bytes
/// - `net_tx` - Network transmit bytes
/// - `uptime_secs` - System uptime in seconds
///
/// # Examples
///
/// ```rust
/// use app_lib::models::{ServerPerf, DiskEntry};
///
/// let perf = ServerPerf {
///     hostname: "web-01".to_string(),
///     username: "appuser".to_string(),
///     cpu_usage: 23.5,
///     mem_total: 16_000_000_000, // 16GB
///     mem_used: 8_000_000_000,   // 8GB
///     disks: vec![
///         DiskEntry {
///             mount: "/".to_string(),
///             total: 500_000_000_000,
///             used: 200_000_000_000,
///         },
///     ],
///     net_rx: 1_024_000_000, // 1GB received
///     net_tx: 512_000_000,   // 512MB sent
///     uptime_secs: 864_000,  // 10 days
/// };
/// ```
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

/// Process information for system monitoring
///
/// Represents a single running process with resource usage metrics.
///
/// # Fields
///
/// - `pid` - Process ID
/// - `name` - Process name/command
/// - `cpu_pct` - CPU usage percentage (0.0-100.0)
/// - `mem_mb` - Memory usage in megabytes
/// - `status` - Process status (running/sleeping/stopped/zombie)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid:     u32,
    pub name:    String,
    pub cpu_pct: f32,
    pub mem_mb:  f32,
    pub status:  String,
}

/// SQL query execution result
///
/// Contains the complete result set from a SQL query, including
/// column headers, row data, affected rows count, and execution timing.
///
/// # Fields
///
/// - `columns` - Column names in result order
/// - `rows` - Result rows as 2D array (each cell is Option<String>)
/// - `rows_affected` - Number of rows affected by DML statements
/// - `execution_time_ms` - Query execution time in milliseconds
/// - `truncated` - Whether result was truncated to row limit
/// - `is_select` - Whether this was a SELECT query (true even if 0 rows)
///
/// # Examples
///
/// ```rust
/// use app_lib::models::QueryResult;
///
/// // SELECT query result
/// let result = QueryResult {
///     columns: vec!["id".to_string(), "name".to_string(), "age".to_string()],
///     rows: vec![
///         vec![Some("1".to_string()), Some("Alice".to_string()), Some("30".to_string())],
///         vec![Some("2".to_string()), Some("Bob".to_string()), None], // NULL age
///     ],
///     rows_affected: 2,
///     execution_time_ms: 45,
///     truncated: false,
///     is_select: true,
/// };
///
/// // INSERT/UPDATE result
/// let insert_result = QueryResult {
///     columns: vec![],
///     rows: vec![],
///     rows_affected: 3,
///     execution_time_ms: 12,
///     truncated: false,
///     is_select: false,
/// };
/// ```
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

/// Database table or view metadata
///
/// Basic information about a database table or view.
///
/// # Fields
///
/// - `name` - Table or view name
/// - `is_view` - Whether this is a view (false for tables)
///
/// # Examples
///
/// ```rust
/// use app_lib::models::TableInfo;
///
/// let table = TableInfo {
///     name: "users".to_string(),
///     is_view: false,
/// };
///
/// let view = TableInfo {
///     name: "active_users_view".to_string(),
///     is_view: true,
/// };
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub is_view: bool,
}

/// Table column structure information
///
/// Describes a single column in a database table, including its
/// data type, nullability, key constraints, and default value.
///
/// # Fields
///
/// - `name` - Column name
/// - `data_type` - SQL data type (e.g., "int", "varchar(255)", "timestamp")
/// - `nullable` - Whether NULL values are allowed
/// - `key` - Key type: "PRI" (primary key), "UNI" (unique), "MUL" (indexed), "" (none)
/// - `default_value` - Default value expression (None if no default)
///
/// # Examples
///
/// ```rust
/// use app_lib::models::ColumnInfo;
///
/// let id_col = ColumnInfo {
///     name: "id".to_string(),
///     data_type: "int".to_string(),
///     nullable: false,
///     key: "PRI".to_string(),
///     default_value: None,
/// };
///
/// let email_col = ColumnInfo {
///     name: "email".to_string(),
///     data_type: "varchar(255)".to_string(),
///     nullable: false,
///     key: "UNI".to_string(),
///     default_value: None,
/// };
///
/// let created_col = ColumnInfo {
///     name: "created_at".to_string(),
///     data_type: "timestamp".to_string(),
///     nullable: false,
///     key: "".to_string(),
///     default_value: Some("CURRENT_TIMESTAMP".to_string()),
/// };
/// ```
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conn_type_default_ports() {
        assert_eq!(ConnType::Mysql.default_port(), 3306);
        assert_eq!(ConnType::Tidb.default_port(), 3306);
        assert_eq!(ConnType::Mariadb.default_port(), 3306);
        assert_eq!(ConnType::Postgres.default_port(), 5432);
        assert_eq!(ConnType::KingBase.default_port(), 5432);
        assert_eq!(ConnType::Redis.default_port(), 6379);
        assert_eq!(ConnType::Mongodb.default_port(), 27017);
        assert_eq!(ConnType::SqlServer.default_port(), 1433);
        assert_eq!(ConnType::Oracle.default_port(), 1521);
        assert_eq!(ConnType::ClickHouse.default_port(), 8123);
        assert_eq!(ConnType::Ssh.default_port(), 22);
        assert_eq!(ConnType::Sqlite.default_port(), 0);
        assert_eq!(ConnType::Duckdb.default_port(), 0);
    }

    #[test]
    fn test_conn_config_serde() {
        let config = ConnConfig {
            id: "test-1".to_string(),
            name: "Test MySQL".to_string(),
            conn_type: ConnType::Mysql,
            host: Some("localhost".to_string()),
            port: Some(3306),
            username: Some("root".to_string()),
            database: Some("testdb".to_string()),
            file_path: None,
            ssh_key_path: None,
            use_ssl: false,
            created_at: 1640000000,
            updated_at: 1640000000,
            color: Some("#ff0000".to_string()),
            extra_json: None,
            read_only: Some(false),
            env_label: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: ConnConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "test-1");
        assert_eq!(parsed.name, "Test MySQL");
        assert_eq!(parsed.conn_type, ConnType::Mysql);
        assert_eq!(parsed.host, Some("localhost".to_string()));
        assert_eq!(parsed.port, Some(3306));
    }

    #[test]
    fn test_conn_type_serde_camelcase() {
        // JSON使用camelCase
        let json = r#"{"connType":"mysql"}"#;
        #[derive(Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wrapper { conn_type: ConnType }

        let parsed: Wrapper = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.conn_type, ConnType::Mysql);
    }

    #[test]
    fn test_test_result_serialization() {
        let result = TestResult {
            success: true,
            message: "Connection successful".to_string(),
            latency_ms: Some(50),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"latencyMs\":50"));
    }

    #[test]
    fn test_query_result_defaults() {
        let json = r#"{
            "columns": ["id", "name"],
            "rows": [["1", "Alice"]],
            "rowsAffected": 1,
            "executionTimeMs": 50
        }"#;

        let result: QueryResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.truncated, false);
        assert_eq!(result.is_select, false);
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.rows_affected, 1);
    }

    #[test]
    fn test_column_info_nullable() {
        let col = ColumnInfo {
            name: "email".to_string(),
            data_type: "varchar(255)".to_string(),
            nullable: true,
            key: "".to_string(),
            default_value: None,
        };

        assert_eq!(col.name, "email");
        assert!(col.nullable);
        assert!(col.default_value.is_none());
    }

    #[test]
    fn test_column_info_primary_key() {
        let col = ColumnInfo {
            name: "id".to_string(),
            data_type: "int".to_string(),
            nullable: false,
            key: "PRI".to_string(),
            default_value: None,
        };

        assert_eq!(col.key, "PRI");
        assert!(!col.nullable);
    }

    #[test]
    fn test_routine_info_types() {
        let procedure = RoutineInfo {
            name: "calculate_total".to_string(),
            routine_type: "PROCEDURE".to_string(),
        };
        assert_eq!(procedure.routine_type, "PROCEDURE");

        let function = RoutineInfo {
            name: "get_user_count".to_string(),
            routine_type: "FUNCTION".to_string(),
        };
        assert_eq!(function.routine_type, "FUNCTION");
    }

    #[test]
    fn test_table_info_view_flag() {
        let table = TableInfo {
            name: "users".to_string(),
            is_view: false,
        };
        assert!(!table.is_view);

        let view = TableInfo {
            name: "active_users".to_string(),
            is_view: true,
        };
        assert!(view.is_view);
    }

    #[test]
    fn test_disk_entry_usage() {
        let disk = DiskEntry {
            mount: "/".to_string(),
            total: 1000000,
            used: 500000,
        };

        assert_eq!(disk.mount, "/");
        let usage_pct = (disk.used as f64 / disk.total as f64) * 100.0;
        assert!((usage_pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_file_entry_directory() {
        let file = FileEntry {
            name: "config.json".to_string(),
            path: "/etc/config.json".to_string(),
            is_dir: false,
            size: 1024,
            modified: "2024-01-01".to_string(),
            permissions: "rw-r--r--".to_string(),
        };

        assert!(!file.is_dir);
        assert_eq!(file.size, 1024);
    }
}
