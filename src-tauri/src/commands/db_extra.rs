// db_extra.rs — 高级数据库操作命令（插入/删除/截断/导出/导入/迁移/备份/进程管理等）
//
// 与 query.rs 完全隔离：所有辅助函数在本文件内独立定义，不引用 query.rs 的私有符号。

use std::time::Instant;
use tauri::{Emitter, State};
use crate::{
    models::{ColumnInfo, ConnConfig, ConnType},
    storage::StorageState,
};
use super::duckdb::{DuckPool, dispatch_duck_query};
use super::sqlserver::{SsPool, dispatch_ss_query, dispatch_ss_columns, dispatch_ss_ddl};
use super::driver::DriverRegistry;

// ── 客户端标识 ────────────────────────────────────────────────────────────────

const CLIENT_TAG: &str = "/* DBTerm */";
fn tag_sql(sql: &str) -> String { format!("{CLIENT_TAG} {sql}") }

// ── 扩展连接配置（与前端 DbExtra 对应）────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
struct DbConnCfg {
    #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
    #[serde(rename = "sslMode",  default)] ssl_mode: String,
    #[serde(rename = "sslCa",   default)] ssl_ca:   String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:    bool,
    #[serde(rename = "sshHost",     default)] ssh_host:      String,
    #[serde(rename = "sshPort",     default)] ssh_port:      u16,
    #[serde(rename = "sshUser",     default)] ssh_user:      String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password:  String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path:  String,
    #[serde(rename = "pgSearchPath", default)] pg_search_path: String,
    #[serde(rename = "pgAppName",    default)] pg_app_name:    String,
}

impl DbConnCfg {
    fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
    }
    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            if self.connect_timeout == 0 { 30 } else { self.connect_timeout.clamp(3, 300) }
        )
    }
    /// 取 SSH 隧道密码：优先 extra_json 中的值，若为空则从 keychain 读取。
    fn tunnel_password(&self, conn_id: &str) -> String {
        if !self.ssh_password.is_empty() { return self.ssh_password.clone(); }
        crate::keychain::get_password(&format!("{conn_id}::ssh-tunnel"))
            .ok().flatten().unwrap_or_default()
    }
}

// ── 本地 helpers ──────────────────────────────────────────────────────────────

async fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().unwrap().load()?;
    let config = configs
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

/// 只读护栏：连接标记只读时拒绝写/DDL/管理操作（应用层，引擎无关，不依赖会话只读语义对 DDL 的覆盖）。
fn ensure_writable(config: &ConnConfig) -> Result<(), String> {
    if config.read_only == Some(true) {
        return Err("该连接为只读模式，已拒绝写/DDL/管理操作".to_string());
    }
    Ok(())
}

/// 标识符校验：只允许字母、数字、下划线、美元符和 Unicode 字母字符
fn validate_ident(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 {
        return Err(format!("非法标识符: {s:?}"));
    }
    if s.chars().any(|c| !c.is_alphanumeric() && c != '_' && c != '$') {
        return Err(format!("标识符含非法字符（只允许字母、数字、_ 和 $）: {s:?}"));
    }
    Ok(())
}

/// MySQL 标识符引用（反引号，内部反引号转义为双反引号）
fn q_mysql(s: &str) -> String { format!("`{}`", s.replace('`', "``")) }

/// 双引号标识符引用（PostgreSQL / ANSI SQL）
fn q_dq(s: &str) -> String { format!("\"{}\"", s.replace('"', "\"\"")) }

/// WHERE 子句安全校验：用 sqlparser 解析 AST，只允许安全的比较/逻辑表达式
/// 拒绝：子查询、UNION、INSERT/UPDATE/DELETE、存储过程调用、不安全函数等
fn validate_where(w: &str) -> Result<(), String> {
    if w.trim().is_empty() {
        return Ok(());
    }
    use sqlparser::{dialect::GenericDialect, parser::Parser};
    use sqlparser::ast::{Statement, SetExpr};

    let dummy = format!("SELECT 1 WHERE {w}");
    let stmts = Parser::parse_sql(&GenericDialect {}, &dummy)
        .map_err(|e| format!("WHERE 子句语法错误: {e}"))?;

    let expr = match stmts.first() {
        Some(Statement::Query(q)) => match q.body.as_ref() {
            SetExpr::Select(sel) => sel.selection.clone(),
            _ => None,
        },
        _ => None,
    }.ok_or("WHERE 子句解析失败")?;

    check_safe_expr(&expr, 0)
}

/// 递归校验 WHERE 表达式 AST，白名单允许安全节点；depth 防止深度嵌套栈溢出。
fn check_safe_expr(expr: &sqlparser::ast::Expr, depth: u32) -> Result<(), String> {
    if depth > 64 {
        return Err("WHERE 子句嵌套层数超过上限（64 层），请简化条件".to_string());
    }
    use sqlparser::ast::{Expr, FunctionArg, FunctionArgExpr, FunctionArguments};
    let d = depth + 1;
    match expr {
        // 基本运算：比较、逻辑、算术
        Expr::BinaryOp { left, right, .. } => {
            check_safe_expr(left, d)?;
            check_safe_expr(right, d)
        }
        Expr::UnaryOp { expr, .. } => check_safe_expr(expr, d),
        Expr::Nested(e) => check_safe_expr(e, d),

        // NULL 判断
        Expr::IsNull(e) | Expr::IsNotNull(e) => check_safe_expr(e, d),
        Expr::IsTrue(e) | Expr::IsFalse(e) | Expr::IsUnknown(e)
        | Expr::IsNotTrue(e) | Expr::IsNotFalse(e) | Expr::IsNotUnknown(e) => check_safe_expr(e, d),

        // 范围与集合
        Expr::Between { expr, low, high, .. } => {
            check_safe_expr(expr, d)?;
            check_safe_expr(low, d)?;
            check_safe_expr(high, d)
        }
        Expr::InList { expr, list, .. } => {
            check_safe_expr(expr, d)?;
            for e in list { check_safe_expr(e, d)?; }
            Ok(())
        }

        // 模糊匹配（any 字段为 sqlparser ≥ 0.40 新增，忽略即可）
        Expr::Like { expr, pattern, .. }
        | Expr::ILike { expr, pattern, .. }
        | Expr::SimilarTo { expr, pattern, .. } => {
            check_safe_expr(expr, d)?;
            check_safe_expr(pattern, d)
        }

        // 字面量与列名（安全）
        Expr::Value(_) => Ok(()),
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => Ok(()),
        Expr::TypedString { .. } => Ok(()), // DATE '2024-01-01' 等类型前缀字面量

        // CAST（sqlparser ≥ 0.40 合并了 TryCast/SafeCast 为 Cast 带参数）
        Expr::Cast { expr, .. } => check_safe_expr(expr, d),

        // CASE WHEN … THEN … END：条件表达式
        Expr::Case { operand, conditions, results, else_result } => {
            if let Some(op) = operand { check_safe_expr(op, d)?; }
            for c in conditions { check_safe_expr(c, d)?; }
            for r in results { check_safe_expr(r, d)?; }
            if let Some(e) = else_result { check_safe_expr(e, d)?; }
            Ok(())
        }

        // 函数调用：白名单
        Expr::Function(f) => {
            let name = f.name.to_string().to_uppercase();
            // 允许的标量函数白名单（覆盖 MySQL / PostgreSQL / SQLite 常用函数）
            const SAFE: &[&str] = &[
                // 字符串
                "LOWER","UPPER","TRIM","LTRIM","RTRIM","LENGTH","LEN","CHAR_LENGTH",
                "SUBSTR","SUBSTRING","LEFT","RIGHT","REPLACE","CONCAT","CONCAT_WS",
                "INSTR","LOCATE","POSITION","LPAD","RPAD","REPEAT","REVERSE",
                "SPACE","FORMAT","CHAR","ASCII","ORD","HEX","UNHEX",
                "REGEXP_LIKE","REGEXP_REPLACE","REGEXP_SUBSTR",
                // 数值
                "ABS","CEIL","CEILING","FLOOR","ROUND","TRUNCATE","TRUNC",
                "MOD","POWER","POW","SQRT","EXP","LOG","LOG2","LOG10",
                "SIGN","GREATEST","LEAST","RAND",
                // 日期时间
                "NOW","SYSDATE","CURRENT_DATE","CURRENT_TIME","CURRENT_TIMESTAMP",
                "DATE","TIME","YEAR","MONTH","DAY","HOUR","MINUTE","SECOND",
                "DATE_FORMAT","TO_DATE","TO_CHAR","TO_TIMESTAMP",
                "DATE_ADD","DATE_SUB","DATEDIFF","TIMESTAMPDIFF","TIMEDIFF",
                "ADDDATE","SUBDATE","LAST_DAY","DAYOFWEEK","DAYOFYEAR","WEEK",
                "FROM_UNIXTIME","UNIX_TIMESTAMP","EXTRACT",
                // 类型转换
                "CAST","CONVERT","TO_NUMBER","PARSE_DATE",
                // 空值处理
                "COALESCE","IFNULL","NULLIF","ISNULL","NVL","NVL2",
                // JSON（PostgreSQL/MySQL 8+）
                "JSON_VALUE","JSON_EXTRACT","JSON_CONTAINS","JSON_ARRAY_LENGTH",
                "JSONB_EXTRACT_PATH","JSONB_EXTRACT_PATH_TEXT",
                // 聚合（允许在 HAVING 中使用）
                "COUNT","SUM","AVG","MIN","MAX",
                // 其他安全函数
                "IF","IIF","DECODE","MD5","SHA1","SHA2","UUID",
            ];
            if !SAFE.iter().any(|&s| s == name.as_str()) {
                return Err(format!(
                    "WHERE 子句不允许调用函数 `{name}`（如确有需要请在 SQL 编辑器中执行）"
                ));
            }
            // 递归校验函数参数
            if let FunctionArguments::List(list) = &f.args {
                for arg in &list.args {
                    match arg {
                        FunctionArg::Unnamed(FunctionArgExpr::Expr(e))
                        | FunctionArg::Named { arg: FunctionArgExpr::Expr(e), .. } => {
                            check_safe_expr(e, d)?;
                        }
                        _ => {}
                    }
                }
            }
            Ok(())
        }

        // 明确拒绝危险构造
        Expr::Subquery(_) => Err("WHERE 子句不允许子查询（Subquery）".to_string()),
        Expr::Exists { .. }  => Err("WHERE 子句不允许 EXISTS 子查询".to_string()),
        Expr::InSubquery { .. } => Err("WHERE 子句不允许 IN (子查询)".to_string()),
        Expr::AnyOp { .. } | Expr::AllOp { .. } => Err("WHERE 子句不允许 ANY/ALL 子查询".to_string()),

        // 其他未知节点：拒绝（宁可严格误拒，不可放行注入）
        other => Err(format!(
            "WHERE 子句包含不支持的表达式（请在 SQL 编辑器中执行复杂查询）: {other}"
        )),
    }
}

/// 文件路径安全校验：必须绝对路径，禁止 `..` 上跳、隐藏分量、NUL、Windows 设备命名空间。
pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("文件路径包含非法字符（NUL）".to_string());
    }
    // Windows 设备/verbatim 命名空间 \\?\ \\.\ 可绕过路径规范化，拒绝
    if path.starts_with(r"\\?\") || path.starts_with(r"\\.\") {
        return Err("文件路径不允许使用设备命名空间".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("文件路径必须是绝对路径".to_string());
    }
    for c in p.components() {
        match c {
            // `..` 上跳是目录穿越的主要载体（原实现只挡 .foo 隐藏项，漏了 ParentDir）
            std::path::Component::ParentDir => {
                return Err("文件路径不允许包含 .. 上跳分量".to_string());
            }
            std::path::Component::Normal(s) if s.to_string_lossy().starts_with('.') => {
                return Err("文件路径不允许包含隐藏目录或隐藏文件（以 . 开头的路径分量）".to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

// ── 本地连接函数 ──────────────────────────────────────────────────────────────

async fn mysql_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::mysql::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions, MySqlSslMode}};
    use crate::commands::query::MySqlPwdExt;
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("root");
    let db   = config.database.as_deref().unwrap_or("");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(3306)).await?;
        let lp = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(3306))
    };

    let mut opts = MySqlConnectOptions::new().host(&h).port(p).username(user).password_opt(pwd);
    if !db.is_empty() { opts = opts.database(db); }

    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => MySqlSslMode::Required,
        "verify-ca"   => MySqlSslMode::VerifyCa,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _             => MySqlSslMode::Disabled,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_ca(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    Ok((conn, tunnel))
}

async fn pg_connect(config: &ConnConfig, password: Option<&str>)
    -> Result<(sqlx::postgres::PgConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String>
{
    use sqlx::{ConnectOptions, postgres::{PgConnectOptions, PgSslMode}};
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use crate::tester::expand_home;

    let cfg  = DbConnCfg::from_config(config);
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host: cfg.ssh_host.clone(), port: cfg.ssh_port,
            user: cfg.ssh_user.clone(), auth_type: cfg.ssh_auth_type.clone(),
            password: cfg.tunnel_password(&config.id), key_path: cfg.ssh_key_path.clone(),
        };
        let t = DbTunnel::open_shared(&config.id, &tcfg,
            config.host.as_deref().unwrap_or("127.0.0.1"),
            config.port.unwrap_or(5432)).await?;
        let lp = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), lp)
    } else {
        tunnel = None;
        (config.host.as_deref().unwrap_or("127.0.0.1").to_string(), config.port.unwrap_or(5432))
    };

    let app_name = if cfg.pg_app_name.is_empty() { "DBTerm" } else { cfg.pg_app_name.as_str() };
    let mut opts = PgConnectOptions::new()
        .host(&h).port(p).username(user).password(pwd).database(db)
        .application_name(app_name);

    opts = opts.ssl_mode(match cfg.ssl_mode.as_str() {
        "require"     => PgSslMode::Require,
        "verify-ca"   => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _             => PgSslMode::Disable,
    });
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let mut conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    // PG0.4: 只读双保险
    if config.read_only == Some(true) {
        sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut conn).await.ok();
    }

    // PG0.1: 自定义 search_path（逐项白名单校验防止 SQL 注入，与 query.rs 保持一致）
    if !cfg.pg_search_path.is_empty() {
        let mut safe_parts: Vec<String> = Vec::new();
        for s in cfg.pg_search_path.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if s == "$user" {
                safe_parts.push("\"$user\"".to_string());
            } else if s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
                safe_parts.push(format!("\"{}\"", s.replace('"', "\"\"")));
            } else {
                log::warn!("search_path 含非法 schema 名 '{s}'，已跳过");
            }
        }
        if !safe_parts.is_empty() {
            let _ = sqlx::query(&format!("SET search_path TO {}", safe_parts.join(", ")))
                .execute(&mut conn).await;
        }
    }

    Ok((conn, tunnel))
}

/// 从 information_schema 获取 MySQL 列信息
async fn mysql_get_columns(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    use sqlx::Row;
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(schema).bind(table)
    .fetch_all(&mut conn).await
    .map_err(|e| format!("获取列信息失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        Some(ColumnInfo {
            name:          r.try_get::<String, _>(0).ok()?,
            data_type:     r.try_get::<String, _>(1).unwrap_or_default(),
            nullable:      r.try_get::<String, _>(2).map(|v| v == "YES").unwrap_or(false),
            key:           r.try_get::<String, _>(3).unwrap_or_default(),
            default_value: r.try_get::<Option<String>, _>(4).ok().flatten(),
        })
    }).collect())
}

/// 从 information_schema 获取 PG 列信息
async fn pg_get_columns(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    use sqlx::Row;
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let rows = sqlx::query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
                COALESCE(( \
                  SELECT 'PRI' FROM information_schema.table_constraints tc \
                  JOIN information_schema.key_column_usage kcu \
                    ON tc.constraint_name = kcu.constraint_name \
                   AND tc.table_schema    = kcu.table_schema \
                  WHERE tc.constraint_type = 'PRIMARY KEY' \
                    AND tc.table_schema = c.table_schema \
                    AND tc.table_name   = c.table_name \
                    AND kcu.column_name = c.column_name \
                  LIMIT 1), '') AS col_key \
         FROM information_schema.columns c \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema).bind(table)
    .fetch_all(&mut conn).await
    .map_err(|e| format!("获取列信息失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        Some(ColumnInfo {
            name:          r.try_get::<String, _>(0).ok()?,
            data_type:     r.try_get::<String, _>(1).unwrap_or_default(),
            nullable:      r.try_get::<String, _>(2).map(|v| v == "YES").unwrap_or(false),
            key:           r.try_get::<String, _>(4).unwrap_or_default(),
            default_value: r.try_get::<Option<String>, _>(3).ok().flatten(),
        })
    }).collect())
}

/// MySQL Row → Vec<Option<String>>（与 query.rs mysql_cell 一致）
fn mysql_row_to_strings(row: &sqlx::mysql::MySqlRow) -> Vec<Option<String>> {
    use sqlx::Row;
    (0..row.columns().len()).map(|i| {
        if matches!(row.try_get::<Option<String>, _>(i), Ok(None)) { return None; }
        // 注意：MySQL 无真正布尔类型（BOOL=TINYINT(1)）；若先尝试 bool，
        // 值为 0/1 的整数列会被解码成 "true"/"false" 导致导出/显示错误，故整数优先。
        None
            .or_else(|| row.try_get::<i8,   _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i16,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i32,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i64,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<u8,   _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<u16,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<u32,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<u64,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<f32,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<f64,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::NaiveDate,     _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::NaiveDateTime, _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::NaiveTime,     _>(i).ok().map(|v| v.to_string()))
            // MySQL TIME 范围（-838:59:59 ~ 838:59:59）超出 NaiveTime（仅 0~24h）；
            // duration 类列常 >24h，必须用 MySqlTime 兜底，否则非空值会被读成 None 写入 NULL
            .or_else(|| row.try_get::<sqlx::mysql::types::MySqlTime, _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<String, _>(i).ok())
            .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().map(|b|
                // 二进制：优先尝试 UTF-8，否则导出为 MySQL hex 字面量 0xABCD
                String::from_utf8(b.clone()).unwrap_or_else(|_| format!("0x{}", hex::encode(&b)))
            ))
            // 最终兜底：DECIMAL/NEWDECIMAL 等以 ASCII 文本编码，但其类型不被 String/Vec<u8> 的兼容
            // 检查接受（compatible 不含 NewDecimal），会被上面所有解码器漏掉而误判为 NULL。
            // try_get_unchecked 跳过类型兼容检查直接 decode：DECIMAL → "123.45"，SQL NULL → Err → None。
            .or_else(|| row.try_get_unchecked::<String, _>(i).ok())
            .or_else(|| row.try_get_unchecked::<Vec<u8>, _>(i).ok().map(|b|
                String::from_utf8(b.clone()).unwrap_or_else(|_| format!("0x{}", hex::encode(&b)))))
    }).collect()
}

/// PG Row → Vec<Option<String>>
fn pg_row_to_strings(row: &sqlx::postgres::PgRow) -> Vec<Option<String>> {
    use sqlx::Row;
    (0..row.columns().len()).map(|i| {
        if matches!(row.try_get::<Option<String>, _>(i), Ok(None)) { return None; }
        None
            .or_else(|| row.try_get::<bool,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i16,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i32,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<i64,  _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<f32,  _>(i).ok().map(|v| fmt_f32(v)))
            .or_else(|| row.try_get::<f64,  _>(i).ok().map(|v| fmt_f64(v)))
            .or_else(|| row.try_get::<chrono::NaiveDate,          _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::NaiveDateTime,      _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::NaiveTime,          _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<chrono::DateTime<chrono::Utc>, _>(i).ok().map(|v| v.to_string()))
            .or_else(|| row.try_get::<String, _>(i).ok())
            // bytea：hex 展示，与 pg_cell 保持一致
            .or_else(|| row.try_get::<Vec<u8>, _>(i).ok().map(|b| format!("0x{}", hex::encode(b))))
            .or(Some("(bin)".to_string()))
    }).collect()
}

pub(crate) fn fmt_f32(v: f32) -> String {
    if v.is_nan() { "NaN".into() }
    else if v == f32::INFINITY { "Infinity".into() }
    else if v == f32::NEG_INFINITY { "-Infinity".into() }
    else { v.to_string() }
}

pub(crate) fn fmt_f64(v: f64) -> String {
    if v.is_nan() { "NaN".into() }
    else if v == f64::INFINITY { "Infinity".into() }
    else if v == f64::NEG_INFINITY { "-Infinity".into() }
    else { v.to_string() }
}

/// CSV 单元格转义：字符串加双引号，内部双引号转义为双双引号
fn csv_escape(v: &Option<String>) -> String {
    match v {
        None => String::new(),
        Some(s) => {
            if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.clone()
            }
        }
    }
}

/// SQL INSERT VALUES 中的字符串转义（MySQL 风格：反斜杠 + 单引号 + 控制字符）
/// 0xABCD 格式的 hex 字面量直接透传，不加引号（BLOB 导出）
fn sql_escape_value(v: &Option<String>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(s) => {
            // hex 字面量（BLOB 二进制）：0x 后全为十六进制字符，直接透传
            if s.starts_with("0x") && s.len() > 2 && s[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                return s.clone();
            }
            let escaped = s.replace('\\', "\\\\")
                .replace('\'', "\\'")
                .replace('\0', "\\0")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
                .replace('\x1a', "\\Z");
            format!("'{escaped}'")
        }
    }
}

/// 标准 SQL 字符串转义（PG / SQLite / Oracle / SQLServer / DuckDB / ClickHouse）：
/// 仅把单引号翻倍，不用 MySQL 的反斜杠转义（这些库默认不识别反斜杠转义，会损坏数据）。
fn sql_escape_value_std(v: &Option<String>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(s) => {
            if s.starts_with("0x") && s.len() > 2 && s[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                return s.clone();
            }
            format!("'{}'", s.replace('\'', "''"))
        }
    }
}

// ── 结果结构体 ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub inserted: u64,
    pub skipped:  u64,
    pub errors:   Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecResult {
    pub executed: u64,
    pub failed:   u64,
    pub errors:   Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnChange {
    pub name:   String,
    pub before: ColumnInfo,
    pub after:  ColumnInfo,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureDiff {
    pub added:        Vec<ColumnInfo>,
    pub removed:      Vec<ColumnInfo>,
    pub modified:     Vec<ColumnChange>,
    pub alter_sql:    String,
    pub danger_drops: Vec<String>, // DROP COLUMN 列名，前端高亮警告
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateResult {
    pub total_rows:    u64,
    pub migrated_rows: u64,
    pub skipped_rows:  u64,
    pub failed_rows:   u64,
    pub elapsed_ms:    u64,
    pub errors:        Vec<String>,
}

/// 迁移高级选项（全部可选，未传时取默认值——保持旧行为）
#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrateOptions {
    /// 冲突处理：error（默认，主键冲突报错）| ignore（跳过冲突行）| upsert（按主键更新）
    pub conflict_mode:   Option<String>,
    /// 迁移内容：both（默认，结构+数据）| structure（仅结构）| data（仅数据）
    pub content:         Option<String>,
    /// 只迁移满足条件的行（不含 WHERE 关键字）
    pub where_clause:    Option<String>,
    /// 限制迁移行数（0 / 不传 = 不限制）
    pub row_limit:       Option<u64>,
    /// 迁移期间禁用外键检查
    pub disable_fk:      Option<bool>,
    /// 整表事务包裹，出错回滚（仅写入阶段）
    pub use_transaction: Option<bool>,
    /// 遇错处理：stop（默认，遇错停止）| skip（跳过错误行继续，并记录）
    pub error_mode:      Option<String>,
    /// 列映射：[源列, 目标列] 对；提供时仅迁移这些列并按映射写入
    pub column_map:      Option<Vec<[String; 2]>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub tables_done: u64,
    pub total_rows:  u64,
    pub file_size:   u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub process_id: u64,
    pub user:       String,
    pub host:       String,
    pub database:   String,
    pub command:    String,
    pub time_secs:  u64,
    pub state:      String,
    pub info:       Option<String>,
}

// ── 1. db_insert_rows ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_insert_rows(
    id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<u64, String> {
    if columns.is_empty() { return Err("列名列表不能为空".to_string()); }
    if rows.is_empty()    { return Ok(0); }
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    for col in &columns   { validate_ident(col)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_insert_rows(&config, password.as_deref(), &schema, &table, &columns, &rows).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_insert_rows(&config, password.as_deref(), &schema, &table, &columns, &rows).await
        }
        ConnType::Sqlite => {
            sqlite_insert_rows_impl(&config, &schema, &table, &columns, &rows).await
        }
        ConnType::Oracle => {
            super::oracle::insert_rows_impl(config, password, schema, table, columns, rows, &*registry).await
        }
        ConnType::Duckdb => {
            duck_insert_rows_impl(&id, &config, &table, &columns, &rows, &duck_pool, &*registry).await
        }
        ConnType::SqlServer => {
            ss_insert_rows_impl(&id, &config, &schema, &table, &columns, &rows, &ss_pool).await
        }
        _ => Err("此连接类型不支持行插入操作".into()),
    }
}

async fn mysql_insert_rows(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
    columns: &[String], rows: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let target = if schema.is_empty() { q_mysql(table) }
                 else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
    let col_list = columns.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
    let n_cols = columns.len();
    // 构建 VALUES (?,?,...), (?,?,...)
    let row_placeholders = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
    let all_placeholders = rows.iter().map(|_| format!("({row_placeholders})")).collect::<Vec<_>>().join(", ");
    let sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES {all_placeholders}"));

    let mut q = sqlx::query(&sql);
    for row in rows {
        for val in row {
            q = q.bind(val.as_deref());
        }
    }
    let res = q.execute(&mut conn).await.map_err(|e| format!("插入失败: {e}"))?;
    Ok(res.rows_affected())
}

async fn pg_insert_rows(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
    columns: &[String], rows: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let schema_name = if schema.is_empty() { "public" } else { schema };
    let target = format!("{}.{}", q_dq(schema_name), q_dq(table));
    let col_list = columns.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
    let n_cols = columns.len();

    const PG_BATCH: usize = 200;
    let mut total: u64 = 0;
    for chunk in rows.chunks(PG_BATCH) {
        let mut idx = 1usize;
        let all_ph = chunk.iter().map(|_| {
            let row_ph = (0..n_cols).map(|_| { let s = format!("${idx}"); idx += 1; s }).collect::<Vec<_>>().join(", ");
            format!("({row_ph})")
        }).collect::<Vec<_>>().join(", ");
        let sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES {all_ph}"));
        let mut q = sqlx::query(&sql);
        for row in chunk {
            for val in row {
                q = q.bind(val.as_deref());
            }
        }
        let res = q.execute(&mut conn).await.map_err(|e| format!("插入失败: {e}"))?;
        total += res.rows_affected();
    }
    Ok(total)
}

// ── 2. db_delete_rows ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_delete_rows(
    id: String,
    schema: String,
    table: String,
    pk_columns: Vec<String>,
    pk_values_list: Vec<Vec<Option<String>>>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<u64, String> {
    if pk_columns.is_empty() { return Err("主键列名不能为空".to_string()); }
    if pk_values_list.is_empty() { return Ok(0); }
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    for c in &pk_columns { validate_ident(c)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_delete_rows(&config, password.as_deref(), &schema, &table, &pk_columns, &pk_values_list).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_delete_rows(&config, password.as_deref(), &schema, &table, &pk_columns, &pk_values_list).await
        }
        ConnType::Sqlite => {
            sqlite_delete_rows_impl(&config, &schema, &table, &pk_columns, &pk_values_list).await
        }
        ConnType::Oracle => {
            super::oracle::delete_rows_impl(config, password, schema, table, pk_columns, pk_values_list, &*registry).await
        }
        ConnType::Duckdb => {
            duck_delete_rows_impl(&id, &config, &table, &pk_columns, &pk_values_list, &duck_pool, &*registry).await
        }
        ConnType::SqlServer => {
            ss_delete_rows_impl(&id, &config, &schema, &table, &pk_columns, &pk_values_list, &ss_pool).await
        }
        _ => Err("此连接类型不支持行删除操作".into()),
    }
}

async fn mysql_delete_rows(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
    pk_columns: &[String], pk_values_list: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let target = if schema.is_empty() { q_mysql(table) }
                 else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
    let where_template: Vec<String> = pk_columns.iter()
        .map(|c| format!("{} = ?", q_mysql(c)))
        .collect();
    let where_clause = where_template.join(" AND ");
    let sql = tag_sql(&format!("DELETE FROM {target} WHERE {where_clause}"));

    let mut total: u64 = 0;
    for pk_values in pk_values_list {
        let mut q = sqlx::query(&sql);
        for val in pk_values {
            q = q.bind(val.as_deref());
        }
        let res = q.execute(&mut conn).await.map_err(|e| format!("删除失败: {e}"))?;
        total += res.rows_affected();
    }
    Ok(total)
}

async fn pg_delete_rows(
    config: &ConnConfig, password: Option<&str>,
    schema: &str, table: &str,
    pk_columns: &[String], pk_values_list: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let schema_name = if schema.is_empty() { "public" } else { schema };
    let target = format!("{}.{}", q_dq(schema_name), q_dq(table));
    let where_template: Vec<String> = pk_columns.iter().enumerate()
        .map(|(i, c)| format!("{}::text = ${}", q_dq(c), i + 1))
        .collect();
    let where_clause = where_template.join(" AND ");
    let sql = tag_sql(&format!("DELETE FROM {target} WHERE {where_clause}"));

    let mut total: u64 = 0;
    for pk_values in pk_values_list {
        let mut q = sqlx::query(&sql);
        for val in pk_values {
            q = q.bind(val.as_deref());
        }
        let res = q.execute(&mut conn).await.map_err(|e| format!("删除失败: {e}"))?;
        total += res.rows_affected();
    }
    Ok(total)
}

// ── SQLite insert/delete helpers ──────────────────────────────────────────────

async fn sqlite_insert_rows_impl(
    config: &ConnConfig, schema: &str, table: &str,
    columns: &[String], rows: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let url = super::query::sqlite_url(config)?;
    let pool = sqlx::sqlite::SqlitePool::connect(&url).await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
    let target = if schema.is_empty() || schema == "main" { q_dq(table) }
                 else { format!("{}.{}", q_dq(schema), q_dq(table)) };
    let col_list = columns.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
    let mut total: u64 = 0;
    for row in rows {
        let placeholders = (0..row.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!("INSERT INTO {target} ({col_list}) VALUES ({placeholders})");
        let mut q = sqlx::query(&sql);
        for val in row { q = q.bind(val.as_deref()); }
        let res = q.execute(&pool).await.map_err(|e| format!("插入失败: {e}"))?;
        total += res.rows_affected();
    }
    Ok(total)
}

async fn sqlite_delete_rows_impl(
    config: &ConnConfig, schema: &str, table: &str,
    pk_columns: &[String], pk_values_list: &[Vec<Option<String>>],
) -> Result<u64, String> {
    let url = super::query::sqlite_url(config)?;
    let pool = sqlx::sqlite::SqlitePool::connect(&url).await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
    let target = if schema.is_empty() || schema == "main" { q_dq(table) }
                 else { format!("{}.{}", q_dq(schema), q_dq(table)) };
    let where_clause = pk_columns.iter()
        .map(|c| format!("{} = ?", q_dq(c)))
        .collect::<Vec<_>>().join(" AND ");
    let sql = format!("DELETE FROM {target} WHERE {where_clause}");
    let mut total: u64 = 0;
    for pk_values in pk_values_list {
        let mut q = sqlx::query(&sql);
        for val in pk_values { q = q.bind(val.as_deref()); }
        let res = q.execute(&pool).await.map_err(|e| format!("删除失败: {e}"))?;
        total += res.rows_affected();
    }
    Ok(total)
}

// ── DuckDB insert/delete helpers ──────────────────────────────────────────────

async fn duck_insert_rows_impl(
    id: &str, config: &ConnConfig, table: &str,
    columns: &[String], rows: &[Vec<Option<String>>],
    duck_pool: &DuckPool, registry: &DriverRegistry,
) -> Result<u64, String> {
    let col_list = columns.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(", ");
    let mut total: u64 = 0;
    for row in rows {
        let val_list = row.iter().map(|v| match v {
            None => "NULL".to_string(),
            Some(s) => format!("'{}'", s.replace('\'', "''")),
        }).collect::<Vec<_>>().join(", ");
        let sql = format!("INSERT INTO \"{}\" ({col_list}) VALUES ({val_list})", table.replace('"', "\"\""));
        let res = dispatch_duck_query(id, config, &sql, duck_pool, registry).await?;
        total += res.rows_affected;
    }
    Ok(total)
}

async fn duck_delete_rows_impl(
    id: &str, config: &ConnConfig, table: &str,
    pk_columns: &[String], pk_values_list: &[Vec<Option<String>>],
    duck_pool: &DuckPool, registry: &DriverRegistry,
) -> Result<u64, String> {
    let mut total: u64 = 0;
    for pk_values in pk_values_list {
        let where_clause = pk_columns.iter().zip(pk_values.iter())
            .map(|(col, val)| {
                let lhs = format!("\"{}\"", col.replace('"', "\"\""));
                match val {
                    None => format!("{lhs} IS NULL"),
                    Some(v) => format!("{lhs} = '{}'", v.replace('\'', "''")),
                }
            })
            .collect::<Vec<_>>().join(" AND ");
        let sql = format!("DELETE FROM \"{}\" WHERE {where_clause}", table.replace('"', "\"\""));
        let res = dispatch_duck_query(id, config, &sql, duck_pool, registry).await?;
        total += res.rows_affected;
    }
    Ok(total)
}

// ── SQL Server insert/delete helpers ─────────────────────────────────────────

async fn ss_insert_rows_impl(
    id: &str, config: &ConnConfig, schema: &str, table: &str,
    columns: &[String], rows: &[Vec<Option<String>>],
    ss_pool: &SsPool,
) -> Result<u64, String> {
    use super::sqlserver::dispatch_ss_query;
    let target = if schema.is_empty() { format!("[{}]", table.replace(']', "]]")) }
                 else { format!("[{}].[{}]", schema.replace(']', "]]"), table.replace(']', "]]")) };
    let col_list = columns.iter().map(|c| format!("[{}]", c.replace(']', "]]"))).collect::<Vec<_>>().join(", ");
    let mut total: u64 = 0;
    for row in rows {
        let val_list = row.iter().map(|v| match v {
            None => "NULL".to_string(),
            Some(s) => format!("N'{}'", s.replace('\'', "''")),
        }).collect::<Vec<_>>().join(", ");
        let sql = format!("INSERT INTO {target} ({col_list}) VALUES ({val_list})");
        let res = dispatch_ss_query(id, config, &sql, ss_pool).await?;
        total += res.rows_affected;
    }
    Ok(total)
}

async fn ss_delete_rows_impl(
    id: &str, config: &ConnConfig, schema: &str, table: &str,
    pk_columns: &[String], pk_values_list: &[Vec<Option<String>>],
    ss_pool: &SsPool,
) -> Result<u64, String> {
    use super::sqlserver::dispatch_ss_query;
    let target = if schema.is_empty() { format!("[{}]", table.replace(']', "]]")) }
                 else { format!("[{}].[{}]", schema.replace(']', "]]"), table.replace(']', "]]")) };
    let mut total: u64 = 0;
    for pk_values in pk_values_list {
        let where_clause = pk_columns.iter().zip(pk_values.iter())
            .map(|(col, val)| {
                let lhs = format!("[{}]", col.replace(']', "]]"));
                match val {
                    None => format!("{lhs} IS NULL"),
                    Some(v) => format!("{lhs} = N'{}'", v.replace('\'', "''")),
                }
            })
            .collect::<Vec<_>>().join(" AND ");
        let sql = format!("DELETE FROM {target} WHERE {where_clause}");
        let res = dispatch_ss_query(id, config, &sql, ss_pool).await?;
        total += res.rows_affected;
    }
    Ok(total)
}

// ── 3. db_truncate_table ──────────────────────────────────────────────────────

// SQL Server 方括号引用：schema=数据库，需 USE 切库前缀
fn ss_use_prefix(schema: &str) -> String {
    if schema.is_empty() { String::new() } else { format!("USE [{}]; ", schema.replace(']', "]]")) }
}
fn ss_bracket(name: &str) -> String { format!("[{}]", name.replace(']', "]]")) }

// SQLite 执行一条 DDL（SQLite 无 schema 命名空间）
async fn sqlite_exec_ddl(config: &ConnConfig, sql: &str) -> Result<(), String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;
    let url = sqlite_url(config)?;
    let mut conn = SqliteConnectOptions::from_str(&url).map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
    sqlx::query(sql).execute(&mut conn).await.map_err(|e| format!("执行失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn db_truncate_table(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let target = if schema.is_empty() { q_mysql(&table) }
                         else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            sqlx::query(&tag_sql(&format!("TRUNCATE TABLE {target}")))
                .execute(&mut conn).await
                .map_err(|e| format!("截断表失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let target = format!("{}.{}", q_dq(schema_name), q_dq(&table));
            sqlx::query(&tag_sql(&format!("TRUNCATE TABLE {target}")))
                .execute(&mut conn).await
                .map_err(|e| format!("截断表失败: {e}"))?;
            Ok(())
        }
        ConnType::SqlServer => {
            let sql = format!("{}TRUNCATE TABLE {}", ss_use_prefix(&schema), ss_bracket(&table));
            dispatch_ss_query(&id, &config, &sql, &ss_pool).await.map(|_| ())
        }
        ConnType::Oracle => {
            let tgt = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            super::oracle::execute_query_impl(config, format!("TRUNCATE TABLE {tgt}"), password, &*registry).await.map(|_| ())
        }
        ConnType::Duckdb => {
            let tgt = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            dispatch_duck_query(&id, &config, &format!("TRUNCATE {tgt}"), &duck_pool, &registry).await.map(|_| ())
        }
        ConnType::Sqlite => sqlite_exec_ddl(&config, &format!("DELETE FROM {}", q_dq(&table))).await,  // SQLite 无 TRUNCATE
        ConnType::ClickHouse => {
            // ClickHouse 的 schema 即数据库名；标识符用反引号
            let tgt = if schema.is_empty() { q_mysql(&table) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            super::query::dispatch_query(&config, password.as_deref(), &format!("TRUNCATE TABLE {tgt}")).await.map(|_| ())
        }
        _ => Err("此连接类型不支持 TRUNCATE 操作".into()),
    }
}

// ── 4. db_drop_table ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_drop_table(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let target = if schema.is_empty() { q_mysql(&table) }
                         else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {target}")))
                .execute(&mut conn).await
                .map_err(|e| format!("删除表失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let target = format!("{}.{}", q_dq(schema_name), q_dq(&table));
            sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {target}")))
                .execute(&mut conn).await
                .map_err(|e| format!("删除表失败: {e}"))?;
            Ok(())
        }
        ConnType::SqlServer => {
            // SQL Server 2016+ 支持 DROP TABLE IF EXISTS
            let sql = format!("{}DROP TABLE IF EXISTS {}", ss_use_prefix(&schema), ss_bracket(&table));
            dispatch_ss_query(&id, &config, &sql, &ss_pool).await.map(|_| ())
        }
        ConnType::Oracle => {
            let tgt = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            super::oracle::execute_query_impl(config, format!("DROP TABLE {tgt}"), password, &*registry).await.map(|_| ())
        }
        ConnType::Duckdb => {
            let tgt = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            dispatch_duck_query(&id, &config, &format!("DROP TABLE IF EXISTS {tgt}"), &duck_pool, &registry).await.map(|_| ())
        }
        ConnType::Sqlite => sqlite_exec_ddl(&config, &format!("DROP TABLE IF EXISTS {}", q_dq(&table))).await,
        ConnType::ClickHouse => {
            // ClickHouse 的 schema 即数据库名；标识符用反引号
            let tgt = if schema.is_empty() { q_mysql(&table) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            super::query::dispatch_query(&config, password.as_deref(), &format!("DROP TABLE IF EXISTS {tgt}")).await.map(|_| ())
        }
        _ => Err("此连接类型不支持 DROP TABLE 操作".into()),
    }
}

// ── 5. db_rename_table ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_rename_table(
    id: String,
    schema: String,
    old_name: String,
    new_name: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    validate_ident(&old_name)?;
    validate_ident(&new_name)?;
    if !schema.is_empty() { validate_ident(&schema)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let src = if schema.is_empty() { q_mysql(&old_name) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&old_name)) };
            let dst = if schema.is_empty() { q_mysql(&new_name) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&new_name)) };
            sqlx::query(&tag_sql(&format!("RENAME TABLE {src} TO {dst}")))
                .execute(&mut conn).await
                .map_err(|e| format!("重命名表失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let src = format!("{}.{}", q_dq(schema_name), q_dq(&old_name));
            sqlx::query(&tag_sql(&format!("ALTER TABLE {src} RENAME TO {}", q_dq(&new_name))))
                .execute(&mut conn).await
                .map_err(|e| format!("重命名表失败: {e}"))?;
            Ok(())
        }
        ConnType::SqlServer => {
            // SQL Server 用 sp_rename（新名不带 schema 限定）
            let old_esc = old_name.replace('\'', "''");
            let new_esc = new_name.replace('\'', "''");
            let sql = format!("{}EXEC sp_rename '{old_esc}', '{new_esc}'", ss_use_prefix(&schema));
            dispatch_ss_query(&id, &config, &sql, &ss_pool).await.map(|_| ())
        }
        ConnType::Oracle => {
            let src = if schema.is_empty() { q_dq(&old_name) } else { format!("{}.{}", q_dq(&schema), q_dq(&old_name)) };
            super::oracle::execute_query_impl(config, format!("ALTER TABLE {src} RENAME TO {}", q_dq(&new_name)), password, &*registry).await.map(|_| ())
        }
        ConnType::Duckdb => {
            let src = if schema.is_empty() { q_dq(&old_name) } else { format!("{}.{}", q_dq(&schema), q_dq(&old_name)) };
            dispatch_duck_query(&id, &config, &format!("ALTER TABLE {src} RENAME TO {}", q_dq(&new_name)), &duck_pool, &registry).await.map(|_| ())
        }
        ConnType::Sqlite => sqlite_exec_ddl(&config, &format!("ALTER TABLE {} RENAME TO {}", q_dq(&old_name), q_dq(&new_name))).await,
        ConnType::ClickHouse => {
            // ClickHouse 的 schema 即数据库名；标识符用反引号
            let src = if schema.is_empty() { q_mysql(&old_name) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&old_name)) };
            let dst = if schema.is_empty() { q_mysql(&new_name) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&new_name)) };
            super::query::dispatch_query(&config, password.as_deref(), &format!("RENAME TABLE {src} TO {dst}")).await.map(|_| ())
        }
        _ => Err("此连接类型不支持重命名表操作".into()),
    }
}

// ── 6. db_copy_table ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_copy_table(
    id: String,
    schema: String,
    src_table: String,
    dst_table: String,
    copy_data: bool,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&src_table)?;
    validate_ident(&dst_table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let src = if schema.is_empty() { q_mysql(&src_table) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&src_table)) };
            let dst = if schema.is_empty() { q_mysql(&dst_table) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&dst_table)) };
            sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} LIKE {src}")))
                .execute(&mut conn).await
                .map_err(|e| format!("复制表结构失败: {e}"))?;
            if copy_data {
                sqlx::query(&tag_sql(&format!("INSERT INTO {dst} SELECT * FROM {src}")))
                    .execute(&mut conn).await
                    .map_err(|e| format!("复制表数据失败: {e}"))?;
            }
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let src = format!("{}.{}", q_dq(schema_name), q_dq(&src_table));
            let dst = format!("{}.{}", q_dq(schema_name), q_dq(&dst_table));
            if copy_data {
                sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} AS SELECT * FROM {src}")))
                    .execute(&mut conn).await
                    .map_err(|e| format!("复制表失败: {e}"))?;
            } else {
                sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} AS SELECT * FROM {src} LIMIT 0")))
                    .execute(&mut conn).await
                    .map_err(|e| format!("复制表结构失败: {e}"))?;
            }
            Ok(())
        }
        _ => Err("此连接类型不支持复制表操作".into()),
    }
}

// ── 7. db_export_table ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_export_table(
    id: String,
    schema: String,
    table: String,
    format: String,
    where_clause: Option<String>,
    path: String,
    // 结构导出（仅 format="sql" 生效）："only"=仅结构 / "with"=结构+数据 / None=仅数据
    structure: Option<String>,
    task_id: Option<String>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, super::duckdb::DuckPool>,
    ss_pool: State<'_, super::sqlserver::SsPool>,
    registry: State<'_, super::driver::DriverRegistry>,
    app_handle: tauri::AppHandle,
) -> Result<u64, String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    if let Some(ref w) = where_clause { validate_where(w)?; }
    validate_path(&path)?;

    let (config, password) = load_conn(&id, &storage).await?;
    let export_started = Instant::now();
    let progress_event = task_id.as_ref().map(|tid| format!("export_progress_{tid}"));
    let emit_progress = |rows: u64, done: bool, file_bytes: u64| {
        if let Some(ref event) = progress_event {
            let elapsed_ms = export_started.elapsed().as_millis() as u64;
            let _ = app_handle.emit(event, crate::commands::db_export::ExportProgressEvt {
                rows,
                elapsed_ms,
                rows_per_sec: if elapsed_ms > 0 { rows * 1000 / elapsed_ms } else { 0 },
                file_bytes,
                done,
                cancelled: false,
                error: None,
            });
        }
    };
    emit_progress(0, false, 0);
    // 提前留存连接类型：Oracle 分支会 move config，后续写文件头/行/尾仍需按方言判断
    let conn_type = config.conn_type.clone();

    // 构建 SELECT 语句（各数据库引号风格不同）
    let (schema_ref, table_ref, where_prefix) = match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let tgt = if schema.is_empty() { q_mysql(&table) }
                      else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            (schema.clone(), table.clone(), tgt)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss | ConnType::Duckdb => {
            let s = if schema.is_empty() { "public".to_string() } else { schema.clone() };
            let tgt = format!("{}.{}", q_dq(&s), q_dq(&table));
            (s, table.clone(), tgt)
        }
        ConnType::Sqlite => {
            let tgt = q_dq(&table);
            (String::new(), table.clone(), tgt)
        }
        ConnType::Oracle => {
            let s_up = if schema.is_empty() { String::new() } else { schema.to_uppercase() };
            let t_up = table.to_uppercase();
            let tgt = if s_up.is_empty() { q_dq(&t_up) }
                      else { format!("{}.{}", q_dq(&s_up), q_dq(&t_up)) };
            (s_up, t_up, tgt)
        }
        ConnType::SqlServer => {
            // SQL Server 的「schema」实为数据库名：用三段式名 [库].dbo.[表] 跨库读，
            // 否则两段式 [schema].[表] 会被当成「当前库里的 schema」，读到错库/不存在表。
            // schema 为空时退回连接初始库的 dbo（用两段式 dbo.[表]）。
            let tgt = if schema.is_empty() {
                format!("dbo.[{}]", table.replace(']', "]]"))
            } else {
                format!("[{}].dbo.[{}]", schema.replace(']', "]]"), table.replace(']', "]]"))
            };
            (schema.clone(), table.clone(), tgt)
        }
        ConnType::ClickHouse => {
            let tgt = if schema.is_empty() { format!("`{}`", table.replace('`', "``")) }
                      else { format!("`{}`.`{}`", schema.replace('`', "``"), table.replace('`', "``")) };
            (schema.clone(), table.clone(), tgt)
        }
        _ => return Err("此连接类型暂不支持导出操作".into()),
    };
    let _ = (schema_ref, table_ref);

    let select_sql = match &where_clause {
        Some(w) if !w.trim().is_empty() => format!("SELECT * FROM {where_prefix} WHERE {w}"),
        _ => format!("SELECT * FROM {where_prefix}"),
    };
    let tagged_sql = tag_sql(&select_sql);

    let sqlserver_has_identity = if matches!(config.conn_type, ConnType::SqlServer) && format == "sql" {
        let db_context = if schema.is_empty() { String::new() } else {
            format!("USE [{}]; ", schema.replace(']', "]]"))
        };
        let object_name = format!("[dbo].[{}]", table.replace(']', "]]"));
        let identity_sql = format!(
            "{db_context}SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.identity_columns WHERE object_id=OBJECT_ID(N'{}')) THEN 1 ELSE 0 END AS has_identity",
            object_name.replace('\'', "''")
        );
        super::sqlserver::dispatch_ss_query(&id, &config, &identity_sql, &*ss_pool).await
            .ok().and_then(|r| r.rows.first().and_then(|row| row.first()).cloned().flatten())
            .as_deref() == Some("1")
    } else { false };

    // 结构导出仅支持 MySQL 系（SHOW CREATE TABLE）
    if structure.is_some()
        && !matches!(config.conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) {
        return Err("结构导出目前仅支持 MySQL 系数据库".into());
    }
    let structure_only = structure.as_deref() == Some("only");
    let ddl_str: Option<String> = None;

    // 辅助：XML/Excel 转义
    fn xml_esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
         .replace('"', "&quot;").replace('\'', "&apos;")
    }
    fn xml_esc_val(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }
    fn is_plain_number(s: &str) -> bool {
        if s.is_empty() { return false; }
        let body = s.strip_prefix('-').unwrap_or(s);
        if body.len() > 1 && body.starts_with('0') && !body.starts_with("0.") { return false; }
        s.parse::<f64>().is_ok() && !s.contains(['e', 'E', 'x', 'X'])
    }
    fn xml_tag(s: &str) -> String {
        let t: String = s.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        match t.chars().next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' => t,
            _ => format!("_{t}"),
        }
    }
    fn html_esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }

    // 流式写入：避免大表全量加载到内存
    // 1. 建立文件写入器
    let file = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut w = std::io::BufWriter::new(file);
    use std::io::Write as IoWrite;

    // 2. 写文件头（格式相关）
    match format.as_str() {
        "sql" => {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let schema_disp = if schema.is_empty() { "-" } else { schema.as_str() };
            write!(w, "/*\n DBTerm SQL Dump\n Schema  : {schema_disp}\n Table   : {table}\n\n Date    : {now}\n*/\n\n").ok();
            // SET NAMES / FOREIGN_KEY_CHECKS 为 MySQL 专有，其它方言不输出，避免导回报错
            if matches!(conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) {
                write!(w, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n").ok();
            }
            if let Some(ref d) = ddl_str {
                let tbl_ref = q_mysql(&table);
                write!(w, "-- ----------------------------\n-- Table structure for {table}\n-- ----------------------------\n").ok();
                write!(w, "DROP TABLE IF EXISTS {tbl_ref};\n").ok();
                let ddl = d.trim_end();
                write!(w, "{ddl}").ok();
                if !ddl.ends_with(';') { write!(w, ";").ok(); }
                write!(w, "\n\n").ok();
            }
        }
        "html" => {
            let t_name = html_esc(&table);
            write!(w, "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>{t_name}</title>\n").ok();
            write!(w, "<style>table{{border-collapse:collapse;font-family:-apple-system,Segoe UI,sans-serif;font-size:13px}}\
                       th,td{{border:1px solid #ccc;padding:6px 10px;text-align:left;white-space:nowrap}}\
                       th{{background:#f2f2f2;font-weight:600}}tr:nth-child(even) td{{background:#fafafa}}</style>\n").ok();
            write!(w, "</head>\n<body>\n<table>\n<thead>\n<tr>").ok();
        }
        "excel" | "xls" | "xlsx" => {
            write!(w, "<?xml version=\"1.0\"?>\n<?mso-application progid=\"Excel.Sheet\"?>\n\
                       <Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" \
                       xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">\n\
                       <Worksheet ss:Name=\"Sheet1\">\n<Table>\n").ok();
        }
        "xml" => {
            let root = xml_tag(&table);
            write!(w, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<{root}>\n").ok();
        }
        "json" => {
            write!(w, "[\n").ok();
        }
        _ => {} // csv / tsv / txt / markdown：列头在知道列名后写
    }

    // 3. 流式读取并写入每行
    let mut row_count: u64 = 0;
    let mut col_names: Vec<String> = Vec::new();
    let mut first_json_row = true;

    macro_rules! write_row {
        ($row_vals:expr) => {{
            let vals: &[Option<String>] = $row_vals;
            match format.as_str() {
                "csv" => {
                    if row_count == 0 {
                        let hdr = col_names.iter().map(|c| csv_escape(&Some(c.clone()))).collect::<Vec<_>>().join(",");
                        write!(w, "{hdr}\n").ok();
                    }
                    let line = vals.iter().map(csv_escape).collect::<Vec<_>>().join(",");
                    write!(w, "{line}\n").ok();
                }
                "tsv" | "txt" => {
                    if row_count == 0 {
                        let hdr = col_names.iter().map(|c| c.replace('\t', " ")).collect::<Vec<_>>().join("\t");
                        write!(w, "{hdr}\n").ok();
                    }
                    let line = vals.iter().map(|v| match v {
                        None => String::new(),
                        Some(s) => s.replace('\t', " ").replace(['\n', '\r'], " "),
                    }).collect::<Vec<_>>().join("\t");
                    write!(w, "{line}\n").ok();
                }
                "markdown" => {
                    if row_count == 0 {
                        write!(w, "| {} |\n", col_names.join(" | ")).ok();
                        write!(w, "| {} |\n", col_names.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")).ok();
                    }
                    let cells = vals.iter().map(|v| v.as_deref().unwrap_or("").replace('|', "\\|")).collect::<Vec<_>>().join(" | ");
                    write!(w, "| {cells} |\n").ok();
                }
                "sql" => {
                    // 标识符引号与值转义按方言走，避免对 PG/SQLite/Oracle/MSSQL 等生成 MySQL 反引号+反斜杠的非法 dump
                    let q = |name: &str| match conn_type {
                        ConnType::SqlServer => format!("[{}]", name.replace(']', "]]")),
                        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase | ConnType::ClickHouse => q_mysql(name),
                        _ => q_dq(name),
                    };
                    let is_my = matches!(conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase);
                    if row_count == 0 {
                        write!(w, "-- ----------------------------\n-- Records of {table}\n-- ----------------------------\n").ok();
                        // Oracle 的 BEGIN 是 PL/SQL 块起始；SQL Server 需明确写 BEGIN TRANSACTION。
                        if matches!(conn_type, ConnType::SqlServer) {
                            write!(w, "BEGIN TRANSACTION;\n").ok();
                        } else if !matches!(conn_type, ConnType::Oracle) {
                            write!(w, "BEGIN;\n").ok();
                        }
                        if sqlserver_has_identity {
                            write!(w, "SET IDENTITY_INSERT [{}] ON;\n", table.replace(']', "]]" )).ok();
                        }
                    }
                    let tbl_ref = q(&table);
                    let col_list = col_names.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");
                    let vstr = vals.iter().map(|v| if is_my { sql_escape_value(v) } else { sql_escape_value_std(v) }).collect::<Vec<_>>().join(", ");
                    write!(w, "INSERT INTO {tbl_ref} ({col_list}) VALUES ({vstr});\n").ok();
                }
                "json" => {
                    let mut obj = serde_json::Map::new();
                    for (c, v) in col_names.iter().zip(vals.iter()) {
                        obj.insert(c.clone(), match v {
                            None    => serde_json::Value::Null,
                            Some(s) => serde_json::Value::String(s.clone()),
                        });
                    }
                    let line = serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default();
                    if !first_json_row { write!(w, ",\n").ok(); }
                    write!(w, "  {line}").ok();
                    first_json_row = false;
                }
                "html" => {
                    if row_count == 0 {
                        for c in &col_names { write!(w, "<th>{}</th>", html_esc(c)).ok(); }
                        write!(w, "</tr>\n</thead>\n<tbody>\n").ok();
                    }
                    write!(w, "<tr>").ok();
                    for v in vals {
                        match v {
                            None    => write!(w, "<td></td>").ok(),
                            Some(s) => write!(w, "<td>{}</td>", html_esc(s)).ok(),
                        };
                    }
                    write!(w, "</tr>\n").ok();
                }
                "excel" | "xls" | "xlsx" => {
                    if row_count == 0 {
                        write!(w, "<Row>").ok();
                        for c in &col_names {
                            write!(w, "<Cell><Data ss:Type=\"String\">{}</Data></Cell>", xml_esc(c)).ok();
                        }
                        write!(w, "</Row>\n").ok();
                    }
                    write!(w, "<Row>").ok();
                    for v in vals {
                        match v {
                            None => write!(w, "<Cell/>").ok(),
                            Some(s) => if is_plain_number(s) {
                                write!(w, "<Cell><Data ss:Type=\"Number\">{}</Data></Cell>", xml_esc(s)).ok()
                            } else {
                                write!(w, "<Cell><Data ss:Type=\"String\">{}</Data></Cell>", xml_esc(s)).ok()
                            },
                        };
                    }
                    write!(w, "</Row>\n").ok();
                }
                "xml" => {
                    let tags: Vec<String> = col_names.iter().map(|c| xml_tag(c)).collect();
                    write!(w, "  <row>\n").ok();
                    for (t, v) in tags.iter().zip(vals.iter()) {
                        match v {
                            None    => write!(w, "    <{t}/>\n").ok(),
                            Some(s) => write!(w, "    <{t}>{}</{t}>\n", xml_esc_val(s)).ok(),
                        };
                    }
                    write!(w, "  </row>\n").ok();
                }
                _ => {}
            }
            row_count += 1;
            if row_count == 1 || row_count % 1_000 == 0 {
                emit_progress(row_count, false, 0);
            }
        }};
    }

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::{Column, Row};
            use futures::TryStreamExt;
            if !structure_only {
                let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
                let mut stream = sqlx::query(&tagged_sql).fetch(&mut conn);
                while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
                    if col_names.is_empty() {
                        col_names = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    let vals = mysql_row_to_strings(&row);
                    write_row!(&vals);
                }
            }
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::{Column, Row};
            use futures::TryStreamExt;
            if !structure_only {
                let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
                let mut stream = sqlx::query(&tagged_sql).fetch(&mut conn);
                while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
                    if col_names.is_empty() {
                        col_names = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    let vals = pg_row_to_strings(&row);
                    write_row!(&vals);
                }
            }
        }
        ConnType::Sqlite => {
            use sqlx::{Column, Row};
            use futures::TryStreamExt;
            use super::query::sqlite_url;
            use sqlx::{ConnectOptions, Connection, sqlite::{SqliteConnectOptions, SqliteConnection}};
            use std::str::FromStr;
            let url = sqlite_url(&config)?;
            let opts = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .log_statements(log::LevelFilter::Off);
            let mut conn = SqliteConnection::connect_with(&opts).await
                .map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let mut stream = sqlx::query(&select_sql).fetch(&mut conn);
            while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
                if col_names.is_empty() {
                    col_names = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                let vals = sqlite_row_to_strings(&row);
                write_row!(&vals);
            }
        }
        ConnType::Duckdb => {
            let duck_result = super::duckdb::dispatch_duck_query(&id, &config, &select_sql, &*duck_pool, &*registry).await
                .map_err(|e| format!("DuckDB 查询失败: {e}"))?;
            col_names = duck_result.columns;
            for row in &duck_result.rows {
                write_row!(row);
            }
        }
        ConnType::Oracle => {
            let result = super::oracle::execute_query_impl(config, select_sql, password, &*registry).await
                .map_err(|e| format!("Oracle 查询失败: {e}"))?;
            col_names = result.columns;
            for row in &result.rows {
                write_row!(row);
            }
        }
        ConnType::ClickHouse => {
            let result = super::clickhouse_tcp::query(&config, password.as_deref(), &select_sql).await
                .map_err(|e| format!("ClickHouse 查询失败: {e}"))?;
            col_names = result.columns;
            for row in &result.rows {
                write_row!(row);
            }
        }
        ConnType::SqlServer => {
            let result = super::sqlserver::dispatch_ss_query(&id, &config, &select_sql, &*ss_pool).await
                .map_err(|e| format!("SQL Server 查询失败: {e}"))?;
            col_names = result.columns;
            for row in &result.rows {
                write_row!(row);
            }
        }
        _ => unreachable!(),
    }

    // 4. 写文件尾
    match format.as_str() {
        "sql" => {
            // Oracle 不用 BEGIN/COMMIT 包裹（BEGIN 为 PL/SQL 块）；SET FOREIGN_KEY_CHECKS 仅 MySQL
            if row_count > 0 && sqlserver_has_identity {
                write!(w, "SET IDENTITY_INSERT [{}] OFF;\n", table.replace(']', "]]" )).ok();
            }
            if row_count > 0 && !matches!(conn_type, ConnType::Oracle) { write!(w, "COMMIT;\n").ok(); }
            if matches!(conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) {
                write!(w, "\nSET FOREIGN_KEY_CHECKS = 1;\n").ok();
            }
        }
        "html" => {
            if row_count == 0 {
                // 没有数据行，仍需关闭表头
                for c in &col_names { write!(w, "<th>{}</th>", html_esc(c)).ok(); }
                write!(w, "</tr>\n</thead>\n<tbody>\n").ok();
            }
            write!(w, "</tbody>\n</table>\n</body>\n</html>\n").ok();
        }
        "excel" | "xls" | "xlsx" => {
            if row_count == 0 && !col_names.is_empty() {
                write!(w, "<Row>").ok();
                for c in &col_names {
                    write!(w, "<Cell><Data ss:Type=\"String\">{}</Data></Cell>", xml_esc(c)).ok();
                }
                write!(w, "</Row>\n").ok();
            }
            write!(w, "</Table>\n</Worksheet>\n</Workbook>\n").ok();
        }
        "xml" => {
            let root = xml_tag(&table);
            write!(w, "</{root}>\n").ok();
        }
        "json" => {
            if row_count > 0 { write!(w, "\n").ok(); }
            write!(w, "]\n").ok();
        }
        _ => {}
    }

    if let Err(e) = w.flush() { return Err(format!("刷新文件失败: {e}")); }
    let file_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    emit_progress(row_count, true, file_bytes);
    Ok(row_count)
}

// ── 7b. db_export_schema：整库导出（Navicat 风格，仅 MySQL 系）──────────────────
/// 导出整个 schema 的所有基表为单个 .sql 文件
/// - `structure`: "only"=仅结构 / 其他(含 "with"/None)=结构+数据
/// 返回导出的表数量
#[tauri::command]
pub async fn db_export_schema(
    id: String,
    schema: String,
    structure: Option<String>,
    path: String,
    storage: State<'_, StorageState>,
) -> Result<u64, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    validate_path(&path)?;

    let (config, password) = load_conn(&id, &storage).await?;
    if !matches!(config.conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) {
        return Err("整库导出目前仅支持 MySQL 系数据库".into());
    }
    let structure_only = structure.as_deref() == Some("only");

    use sqlx::{Row, Executor};
    let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
    let db_ref = q_mysql(&schema);
    // 切到目标库，便于 SHOW CREATE FUNCTION/PROCEDURE 使用裸名
    conn.execute(sqlx::raw_sql(&tag_sql(&format!("USE {db_ref}")))).await
        .map_err(|e| format!("切换数据库失败: {e}"))?;

    // 列出基表 / 视图
    let list_base = tag_sql(&format!("SHOW FULL TABLES FROM {db_ref} WHERE Table_type = 'BASE TABLE'"));
    let tables: Vec<String> = sqlx::query(&list_base).fetch_all(&mut conn).await
        .map_err(|e| format!("列出表失败: {e}"))?
        .iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
    let list_view = tag_sql(&format!("SHOW FULL TABLES FROM {db_ref} WHERE Table_type = 'VIEW'"));
    let views: Vec<String> = sqlx::query(&list_view).fetch_all(&mut conn).await
        .map_err(|e| format!("列出视图失败: {e}"))?
        .iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
    // 列出函数 / 存储过程
    let esc = schema.replace('\'', "''");
    let funcs: Vec<String> = sqlx::query(&tag_sql(&format!("SHOW FUNCTION STATUS WHERE Db = '{esc}'")))
        .fetch_all(&mut conn).await.map_err(|e| format!("列出函数失败: {e}"))?
        .iter().filter_map(|r| r.try_get::<String, _>("Name").ok()).collect();
    let procs: Vec<String> = sqlx::query(&tag_sql(&format!("SHOW PROCEDURE STATUS WHERE Db = '{esc}'")))
        .fetch_all(&mut conn).await.map_err(|e| format!("列出存储过程失败: {e}"))?
        .iter().filter_map(|r| r.try_get::<String, _>("Name").ok()).collect();

    let obj_count = (tables.len() + views.len() + funcs.len() + procs.len()) as u64;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");

    // 流式写入：避免将整个 dump 拼接为字符串（大库 OOM）
    use std::io::{BufWriter, Write as IoWrite2};
    let file = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut w = BufWriter::with_capacity(65536, file);

    write!(w, "/*\n DBTerm SQL Dump (整库)\n Schema  : {schema}\n 表 {} · 视图 {} · 函数 {} · 存储过程 {}\n\n Date    : {now}\n*/\n\n",
        tables.len(), views.len(), funcs.len(), procs.len()).map_err(|e| format!("写入失败: {e}"))?;
    write!(w, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nUSE {db_ref};\n\n").map_err(|e| format!("写入失败: {e}"))?;

    for tbl in &tables {
        let tref = q_mysql(tbl);
        let dr = sqlx::query(&tag_sql(&format!("SHOW CREATE TABLE {db_ref}.{tref}")))
            .fetch_one(&mut conn).await
            .map_err(|e| format!("获取 {tbl} 建表语句失败: {e}"))?;
        let ddl = dr.try_get::<String, _>(1).unwrap_or_default();
        write!(w, "-- ----------------------------\n-- Table structure for {tbl}\n-- ----------------------------\n").map_err(|e| format!("写入失败: {e}"))?;
        write!(w, "DROP TABLE IF EXISTS {tref};\n").map_err(|e| format!("写入失败: {e}"))?;
        let ddl_t = ddl.trim_end();
        write!(w, "{ddl_t}").map_err(|e| format!("写入失败: {e}"))?;
        if !ddl_t.ends_with(';') { write!(w, ";").map_err(|e| format!("写入失败: {e}"))?; }
        write!(w, "\n\n").map_err(|e| format!("写入失败: {e}"))?;

        // 数据：流式，每行写完即释放（不整表装入内存）
        if !structure_only {
            use futures::TryStreamExt;
            write!(w, "-- ----------------------------\n-- Records of {tbl}\n-- ----------------------------\n").map_err(|e| format!("写入失败: {e}"))?;
            let select_sql = tag_sql(&format!("SELECT * FROM {db_ref}.{tref}"));
            let mut stream = sqlx::query(&select_sql).fetch(&mut conn);
            let mut col_list: Option<String> = None;
            let mut has_rows = false;
            while let Some(row) = stream.try_next().await.map_err(|e| format!("查询 {tbl} 数据失败: {e}"))? {
                if col_list.is_none() {
                    use sqlx::Column;
                    let cols: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
                    col_list = Some(cols.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", "));
                    write!(w, "BEGIN;\n").map_err(|e| format!("写入失败: {e}"))?;
                    has_rows = true;
                }
                let row_strs = mysql_row_to_strings(&row);
                let vals = row_strs.iter().map(sql_escape_value).collect::<Vec<_>>().join(", ");
                write!(w, "INSERT INTO {tref} ({}) VALUES ({vals});\n", col_list.as_deref().unwrap()).map_err(|e| format!("写入失败: {e}"))?;
            }
            if has_rows { write!(w, "COMMIT;\n").map_err(|e| format!("写入失败: {e}"))?; }
            write!(w, "\n").map_err(|e| format!("写入失败: {e}"))?;
        }
    }

    for v in &views {
        let vref = q_mysql(v);
        let dr = sqlx::query(&tag_sql(&format!("SHOW CREATE VIEW {db_ref}.{vref}")))
            .fetch_one(&mut conn).await.map_err(|e| format!("获取视图 {v} 失败: {e}"))?;
        let ddl = dr.try_get::<String, _>(1).unwrap_or_default();
        write!(w, "-- ----------------------------\n-- View structure for {v}\n-- ----------------------------\n").map_err(|e| format!("写入失败: {e}"))?;
        write!(w, "DROP VIEW IF EXISTS {vref};\n").map_err(|e| format!("写入失败: {e}"))?;
        let ddl_t = ddl.trim_end();
        write!(w, "{ddl_t}").map_err(|e| format!("写入失败: {e}"))?;
        if !ddl_t.ends_with(';') { write!(w, ";").map_err(|e| format!("写入失败: {e}"))?; }
        write!(w, "\n\n").map_err(|e| format!("写入失败: {e}"))?;
    }

    for (kind, names, drop_kw, show_kw, col) in [
        ("Function",  &funcs, "FUNCTION",  "FUNCTION",  2usize),
        ("Procedure", &procs, "PROCEDURE", "PROCEDURE", 2usize),
    ] {
        for name in names {
            let nref = q_mysql(name);
            let dr = sqlx::query(&tag_sql(&format!("SHOW CREATE {show_kw} {nref}")))
                .fetch_one(&mut conn).await.map_err(|e| format!("获取{kind} {name} 失败: {e}"))?;
            let ddl = dr.try_get::<String, _>(col).unwrap_or_default();
            if ddl.trim().is_empty() { continue; }
            write!(w, "-- ----------------------------\n-- {kind} structure for {name}\n-- ----------------------------\n").map_err(|e| format!("写入失败: {e}"))?;
            write!(w, "DROP {drop_kw} IF EXISTS {nref};\nDELIMITER ;;\n").map_err(|e| format!("写入失败: {e}"))?;
            write!(w, "{}", ddl.trim_end()).map_err(|e| format!("写入失败: {e}"))?;
            write!(w, "\n;;\nDELIMITER ;\n\n").map_err(|e| format!("写入失败: {e}"))?;
        }
    }

    write!(w, "SET FOREIGN_KEY_CHECKS = 1;\n").map_err(|e| format!("写入失败: {e}"))?;
    w.flush().map_err(|e| format!("刷新文件失败: {e}"))?;
    Ok(obj_count)
}

// ── 8. db_import_csv ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_import_csv(
    id: String,
    schema: String,
    table: String,
    path: String,
    columns: Vec<String>,
    has_header: bool,
    null_value: String,
    on_error: String,
    // 导入格式："csv"（默认）| "tsv" | "txt" | "json" | "xml" | "excel"
    format: Option<String>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, super::driver::DriverRegistry>,
) -> Result<ImportResult, String> {
    validate_ident(&table)?;
    if !schema.is_empty() { validate_ident(&schema)?; }
    for col in &columns { validate_ident(col)?; }
    validate_path(&path)?;

    let fmt = format.as_deref().unwrap_or("csv");
    let is_excel = matches!(fmt, "excel" | "xlsx" | "xls");
    // Excel 为二进制，不能按文本读取
    let content = if is_excel { String::new() } else {
        std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?
    };

    let delim: char = if fmt == "tsv" || fmt == "txt" { '\t' } else { ',' };

    // 分隔符行解析（支持引号转义；delim 可为 , 或 \t）
    let parse_delim_line = |line: &str| -> Vec<Option<String>> {
        let mut fields = Vec::new();
        let mut field = String::new();
        let mut in_quotes = false;
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '"' if in_quotes => {
                    if chars.peek() == Some(&'"') { field.push('"'); chars.next(); }
                    else { in_quotes = false; }
                }
                '"' => { in_quotes = true; }
                c if c == delim && !in_quotes => {
                    fields.push(if field == null_value { None } else { Some(field.clone()) });
                    field.clear();
                }
                other => { field.push(other); }
            }
        }
        fields.push(if field == null_value { None } else { Some(field) });
        fields
    };

    // 统一解析为行集合 rows
    let rows: Vec<Vec<Option<String>>> = if fmt == "json" {
        let v: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("解析 JSON 失败: {e}"))?;
        let arr = v.as_array().ok_or("JSON 根节点必须是对象数组")?;
        arr.iter().map(|item| {
            columns.iter().map(|c| match item.get(c) {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(s)) => if *s == null_value { None } else { Some(s.clone()) },
                Some(other) => Some(other.to_string()),
            }).collect()
        }).collect()
    } else if is_excel {
        use calamine::{Reader, open_workbook_auto, Data};
        let mut wb = open_workbook_auto(&path).map_err(|e| format!("打开 Excel 失败: {e}"))?;
        let range = wb.worksheet_range_at(0)
            .ok_or("Excel 无工作表")?
            .map_err(|e| format!("读取工作表失败: {e}"))?;
        let cell_to_opt = |c: &Data| -> Option<String> {
            match c {
                Data::Empty => None,
                Data::String(s) => if *s == null_value { None } else { Some(s.clone()) },
                other => { let s = other.to_string(); if s == null_value { None } else { Some(s) } }
            }
        };
        let all: Vec<&[Data]> = range.rows().collect();
        if has_header && !all.is_empty() {
            // 按表头名匹配目标列
            let header: Vec<String> = all[0].iter().map(|c| c.to_string()).collect();
            let idx: Vec<Option<usize>> = columns.iter()
                .map(|col| header.iter().position(|h| h == col)).collect();
            all[1..].iter().map(|r| {
                idx.iter().map(|oi| oi.and_then(|i| r.get(i)).and_then(|c| cell_to_opt(c))).collect()
            }).collect()
        } else {
            // 无表头：按位置映射
            all.iter().map(|r| {
                (0..columns.len()).map(|i| r.get(i).and_then(|c| cell_to_opt(c))).collect()
            }).collect()
        }
    } else if fmt == "xml" {
        // 轻量解析：逐个 <row>…</row>，块内按列名取 <col>…</col>（兼容本工具导出的 XML）
        fn unescape(s: &str) -> String {
            s.replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
        }
        let mut rows_out: Vec<Vec<Option<String>>> = Vec::new();
        let mut rest = content.as_str();
        while let Some(start) = rest.find("<row>") {
            let after = &rest[start + 5..];
            let Some(end) = after.find("</row>") else { break };
            let block = &after[..end];
            rest = &after[end + 6..];
            let cells: Vec<Option<String>> = columns.iter().map(|col| {
                let open  = format!("<{col}>");
                let close = format!("</{col}>");
                if let Some(s) = block.find(&open) {
                    let b = &block[s + open.len()..];
                    if let Some(e) = b.find(&close) {
                        let val = unescape(&b[..e]);
                        return if val == null_value { None } else { Some(val) };
                    }
                }
                None
            }).collect();
            rows_out.push(cells);
        }
        rows_out
    } else {
        let mut lines: Vec<&str> = content.lines().collect();
        if has_header && !lines.is_empty() { lines.remove(0); }
        lines.iter().map(|l| parse_delim_line(l)).collect()
    };

    if rows.is_empty() {
        return Ok(ImportResult { inserted: 0, skipped: 0, errors: vec![] });
    }

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;

    let mut inserted: u64 = 0;
    let mut skipped:  u64 = 0;
    let mut errors:   Vec<String> = Vec::new();

    const BATCH: usize = 100;

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let target = if schema.is_empty() { q_mysql(&table) }
                         else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            let col_list = columns.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
            let n_cols = columns.len();
            let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");

            // 批量插入
            for chunk in rows.chunks(BATCH) {
                let all_ph = chunk.iter().map(|_| format!("({row_ph})")).collect::<Vec<_>>().join(", ");
                let sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES {all_ph}"));
                let mut q = sqlx::query(&sql);
                for row in chunk {
                    for val in row {
                        q = q.bind(val.as_deref());
                    }
                }
                match q.execute(&mut conn).await {
                    Ok(r) => inserted += r.rows_affected(),
                    Err(e) => {
                        let msg = format!("批量插入失败: {e}");
                        if on_error == "stop" {
                            errors.push(msg);
                            return Ok(ImportResult { inserted, skipped, errors });
                        }
                        skipped += chunk.len() as u64;
                        errors.push(msg);
                    }
                }
            }
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let target = format!("{}.{}", q_dq(schema_name), q_dq(&table));
            let col_list = columns.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let n_cols = columns.len();

            const PG_BATCH: usize = 200;
            let header_offset = if has_header { 1 } else { 0 };
            for (chunk_start, chunk) in rows.chunks(PG_BATCH).enumerate() {
                let mut idx = 1usize;
                let all_ph = chunk.iter().map(|_| {
                    let row_ph = (0..n_cols).map(|_| { let s = format!("${idx}"); idx += 1; s }).collect::<Vec<_>>().join(", ");
                    format!("({row_ph})")
                }).collect::<Vec<_>>().join(", ");
                let sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES {all_ph}"));
                let mut q = sqlx::query(&sql);
                for row in chunk {
                    for val in row {
                        q = q.bind(val.as_deref());
                    }
                }
                match q.execute(&mut conn).await {
                    Ok(r) => inserted += r.rows_affected(),
                    Err(e) => {
                        // 批量失败时回退为逐行以精确定位并支持 skip 模式
                        let base_line = chunk_start * PG_BATCH + header_offset + 1;
                        let placeholders = (1..=n_cols).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                        let row_sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES ({placeholders})"));
                        if on_error == "stop" {
                            let msg = format!("第 {base_line} 行附近批量插入失败: {e}");
                            errors.push(msg);
                            return Ok(ImportResult { inserted, skipped, errors });
                        }
                        for (i, row) in chunk.iter().enumerate() {
                            let mut q2 = sqlx::query(&row_sql);
                            for val in row { q2 = q2.bind(val.as_deref()); }
                            match q2.execute(&mut conn).await {
                                Ok(_) => inserted += 1,
                                Err(e2) => {
                                    skipped += 1;
                                    errors.push(format!("第 {} 行插入失败: {e2}", base_line + i));
                                }
                            }
                        }
                    }
                }
            }
        }
        ConnType::Sqlite => {
            use sqlx::{sqlite::SqliteConnection, Connection};
            use crate::commands::query::sqlite_url;
            let url = sqlite_url(&config)?;
            let mut conn = SqliteConnection::connect(&url).await
                .map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let target = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            let col_list = columns.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let n_cols = columns.len();
            let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = tag_sql(&format!("INSERT INTO {target} ({col_list}) VALUES ({row_ph})"));

            for (line_no, row) in rows.iter().enumerate() {
                let mut q = sqlx::query(&sql);
                for val in row {
                    q = q.bind(val.as_deref());
                }
                match q.execute(&mut conn).await {
                    Ok(_) => inserted += 1,
                    Err(e) => {
                        let msg = format!("第 {} 行插入失败: {e}", line_no + 1 + if has_header { 1 } else { 0 });
                        if on_error == "stop" {
                            errors.push(msg);
                            return Ok(ImportResult { inserted, skipped, errors });
                        }
                        skipped += 1;
                        errors.push(msg);
                    }
                }
            }
        }
        ConnType::Duckdb => {
            ensure_writable(&config)?;
            // DuckDB COPY 命令原生支持 CSV/JSON/Parquet 导入，性能最优
            let target = if schema.is_empty() { q_dq(&table) } else { format!("{}.{}", q_dq(&schema), q_dq(&table)) };
            let delim_str = if fmt == "tsv" || fmt == "txt" { "\t" } else { "," };
            let header_opt = if has_header { "TRUE" } else { "FALSE" };
            let null_opt = if null_value.is_empty() { "NULL".to_string() } else { format!("'{}'", null_value.replace('\'', "''")) };
            // DuckDB COPY 的列过滤通过 SELECT + INSERT 实现
            let col_list = if !columns.is_empty() {
                format!(" ({})", columns.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", "))
            } else { String::new() };
            let safe_path = path.replace('\'', "''");
            let copy_sql = match fmt {
                "json" => format!("INSERT INTO {target}{col_list} SELECT * FROM read_json_auto('{safe_path}')"),
                _ => format!(
                    "COPY {target}{col_list} FROM '{safe_path}' (HEADER {header_opt}, DELIMITER '{delim_str}', NULLSTR {null_opt})"
                ),
            };
            match dispatch_duck_query(&id, &config, &copy_sql, &duck_pool, &registry).await {
                Ok(r) => { inserted = r.rows_affected; }
                Err(e) => {
                    if on_error == "stop" {
                        return Err(format!("DuckDB 导入失败: {e}"));
                    }
                    errors.push(format!("导入失败: {e}"));
                }
            }
        }
        _ => return Err("此连接类型不支持 CSV 导入操作".into()),
    }

    Ok(ImportResult { inserted, skipped, errors })
}

// ── 9. db_exec_sql_file ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_exec_sql_file(
    id: String,
    path: String,
    // 可选：先 USE 指定库（MySQL 系），让无库前缀的脚本落到目标库
    schema: Option<String>,
    app_handle: tauri::AppHandle,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, super::driver::DriverRegistry>,
) -> Result<SqlExecResult, String> {
    validate_path(&path)?;
    if let Some(ref s) = schema { if !s.is_empty() { validate_ident(s)?; } }

    // 清洗单条语句：去除 /* */ 块注释与 -- 行注释，返回 trim 后的纯 SQL
    fn clean_stmt(chunk: &str) -> String {
        let mut s = chunk.to_string();
        loop {
            match (s.find("/*"), s.find("*/")) {
                (Some(a), Some(b)) if b > a => { s.replace_range(a..b + 2, ""); }
                _ => break,
            }
        }
        s.lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string()
    }

    // BufReader 流式解析：避免将整个大 SQL 文件读入内存
    // 支持 DELIMITER 指令（存储过程/函数 dump 使用 ;; 分隔符）
    let statements: Vec<String> = {
        use std::io::BufRead;
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("打开 SQL 文件失败: {e}"))?;
        let reader = std::io::BufReader::with_capacity(65536, file);
        let mut out: Vec<String> = Vec::new();
        let mut delim = ";".to_string();
        let mut buf = String::new();
        for line_result in reader.lines() {
            let line = line_result.map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
            let trimmed = line.trim();
            // DELIMITER 指令：切换分隔符，本行不计入语句
            if trimmed.to_ascii_uppercase().starts_with("DELIMITER ") {
                let s = clean_stmt(&buf); if !s.is_empty() { out.push(s); }
                buf.clear();
                let d = trimmed[10..].trim();
                delim = if d.is_empty() { ";".to_string() } else { d.to_string() };
                continue;
            }
            if !buf.is_empty() { buf.push('\n'); }
            buf.push_str(&line);
            let bt = buf.trim_end().to_string();
            if bt.ends_with(&delim) {
                let stmt = bt[..bt.len() - delim.len()].to_string();
                let s = clean_stmt(&stmt); if !s.is_empty() { out.push(s); }
                buf.clear();
            }
        }
        let s = clean_stmt(&buf); if !s.is_empty() { out.push(s); }
        out
    };

    let total = statements.len() as u64;
    let mut executed: u64 = 0;
    let mut failed:   u64 = 0;
    let mut errors:   Vec<String> = Vec::new();

    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;

    // 发送进度事件（节流：每 100 条或最后一条才 emit，防止 10 万行文件产生 10 万次 IPC 事件）
    let emit_progress = |current: u64, sql: &str, error: Option<&str>| {
        if current % 100 != 0 && current != total && error.is_none() { return; }
        #[derive(serde::Serialize, Clone)]
        struct Progress {
            current: u64,
            total: u64,
            sql: String,
            error: Option<String>,
        }
        let payload = Progress {
            current,
            total,
            sql: sql.chars().take(200).collect(),
            error: error.map(|s| s.to_string()),
        };
        let _ = app_handle.emit("sql_file_progress", payload);
    };

    use sqlx::Executor;  // 文本协议执行（raw_sql），避免预处理触碰 information_schema
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            if let Some(ref s) = schema {
                if !s.is_empty() {
                    conn.execute(sqlx::raw_sql(&tag_sql(&format!("USE {}", q_mysql(s))))).await
                        .map_err(|e| format!("切换数据库 {s} 失败: {e}"))?;
                }
            }
            for (i, stmt) in statements.iter().enumerate() {
                match conn.execute(sqlx::raw_sql(&tag_sql(stmt))).await {
                    Ok(_) => {
                        executed += 1;
                        emit_progress(i as u64 + 1, stmt, None);
                    }
                    Err(e) => {
                        failed += 1;
                        let msg = format!("语句 {} 失败: {e}", i + 1);
                        errors.push(msg.clone());
                        emit_progress(i as u64 + 1, stmt, Some(&msg));
                    }
                }
            }
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            for (i, stmt) in statements.iter().enumerate() {
                match conn.execute(sqlx::raw_sql(&tag_sql(stmt))).await {
                    Ok(_) => {
                        executed += 1;
                        emit_progress(i as u64 + 1, stmt, None);
                    }
                    Err(e) => {
                        failed += 1;
                        let msg = format!("语句 {} 失败: {e}", i + 1);
                        errors.push(msg.clone());
                        emit_progress(i as u64 + 1, stmt, Some(&msg));
                    }
                }
            }
        }
        ConnType::Sqlite => {
            use sqlx::{sqlite::SqliteConnection, Connection};
            use crate::commands::query::sqlite_url;
            let url = sqlite_url(&config)?;
            let mut conn = SqliteConnection::connect(&url).await
                .map_err(|e| format!("SQLite 连接失败: {e}"))?;
            for (i, stmt) in statements.iter().enumerate() {
                match conn.execute(sqlx::raw_sql(&tag_sql(stmt))).await {
                    Ok(_) => {
                        executed += 1;
                        emit_progress(i as u64 + 1, stmt, None);
                    }
                    Err(e) => {
                        failed += 1;
                        let msg = format!("语句 {} 失败: {e}", i + 1);
                        errors.push(msg.clone());
                        emit_progress(i as u64 + 1, stmt, Some(&msg));
                    }
                }
            }
        }
        ConnType::Duckdb => {
            ensure_writable(&config)?;
            for (i, stmt) in statements.iter().enumerate() {
                match dispatch_duck_query(&id, &config, stmt, &duck_pool, &registry).await {
                    Ok(_) => {
                        executed += 1;
                        emit_progress(i as u64 + 1, stmt, None);
                    }
                    Err(e) => {
                        failed += 1;
                        let msg = format!("语句 {} 失败: {e}", i + 1);
                        errors.push(msg.clone());
                        emit_progress(i as u64 + 1, stmt, Some(&msg));
                    }
                }
            }
        }
        _ => return Err("此连接类型不支持执行 SQL 文件".into()),
    }

    Ok(SqlExecResult { executed, failed, errors })
}

// ── 10. db_diff_structure ─────────────────────────────────────────────────────
// 支持跨连接对比：src_id 与 dst_id 可以是不同实例（同类型数据库族）
// 以 src 为基准：src 有 dst 无 → ADD；dst 有 src 无 → DROP（高危）；两者都有但不同 → MODIFY

/// 同族结构对比的连接「族」编号（0 = 不支持）。
fn struct_family(ct: &ConnType) -> u8 {
    match ct {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => 1,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => 2,
        ConnType::Oracle => 3,
        ConnType::SqlServer => 4,
        ConnType::ClickHouse => 5,
        _ => 0,
    }
}

/// 通用取列：复用各方言的列获取 helper（与 table_columns 命令同套路），供结构对比/迁移使用。
async fn get_cols_any(
    id: &str, config: &ConnConfig, password: Option<&str>, schema: &str, table: &str,
    ss_pool: &SsPool, registry: &DriverRegistry,
) -> Result<Vec<ColumnInfo>, String> {
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase =>
            mysql_get_columns(config, password, schema, table).await,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let s = if schema.is_empty() { "public" } else { schema };
            pg_get_columns(config, password, s, table).await
        }
        ConnType::SqlServer => dispatch_ss_columns(id, config, schema, table, ss_pool).await,
        ConnType::ClickHouse => super::clickhouse::columns(config, password, schema, table).await,
        ConnType::Oracle => super::oracle::table_columns_impl(
            config.clone(), schema.to_string(), table.to_string(), password.map(|s| s.to_string()), registry).await,
        _ => Err("此连接类型不支持读取列结构".into()),
    }
}

#[tauri::command]
pub async fn db_diff_structure(
    src_id:     String,
    src_schema: String,
    src_table:  String,
    dst_id:     String,
    dst_schema: String,
    dst_table:  String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<StructureDiff, String> {
    validate_ident(&src_table)?;
    validate_ident(&dst_table)?;
    if !src_schema.is_empty() { validate_ident(&src_schema)?; }
    if !dst_schema.is_empty() { validate_ident(&dst_schema)?; }

    let (src_cfg, src_pwd) = load_conn(&src_id, &storage).await?;
    let (dst_cfg, dst_pwd) = load_conn(&dst_id, &storage).await?;

    let sf = struct_family(&src_cfg.conn_type);
    let df = struct_family(&dst_cfg.conn_type);
    if sf == 0 { return Err("此连接类型不支持结构对比".into()); }
    if sf != df {
        return Err("源连接与目标连接类型不兼容（结构对比需同族数据库）".into());
    }
    let cols_src = get_cols_any(&src_id, &src_cfg, src_pwd.as_deref(), &src_schema, &src_table, &ss_pool, &registry).await?;
    let cols_dst = get_cols_any(&dst_id, &dst_cfg, dst_pwd.as_deref(), &dst_schema, &dst_table, &ss_pool, &registry).await?;

    use std::collections::HashMap;
    let map_src: HashMap<&str, &ColumnInfo> = cols_src.iter().map(|c| (c.name.as_str(), c)).collect();
    let map_dst: HashMap<&str, &ColumnInfo> = cols_dst.iter().map(|c| (c.name.as_str(), c)).collect();

    let mut added:    Vec<ColumnInfo>  = Vec::new();
    let mut removed:  Vec<ColumnInfo>  = Vec::new();
    let mut modified: Vec<ColumnChange> = Vec::new();

    // src 有 → dst 需要 ADD 或 MODIFY
    for col_src in &cols_src {
        if let Some(&col_dst) = map_dst.get(col_src.name.as_str()) {
            if col_src.data_type    != col_dst.data_type
                || col_src.nullable != col_dst.nullable
                || col_src.default_value != col_dst.default_value
            {
                modified.push(ColumnChange {
                    name:   col_src.name.clone(),
                    before: col_dst.clone(), // dst 当前状态
                    after:  col_src.clone(), // src 目标状态
                });
            }
        } else {
            added.push(col_src.clone());
        }
    }

    // dst 有但 src 无 → DROP（高危）
    for col_dst in &cols_dst {
        if !map_src.contains_key(col_dst.name.as_str()) {
            removed.push(col_dst.clone());
        }
    }

    let danger_drops: Vec<String> = removed.iter().map(|c| c.name.clone()).collect();

    // 生成 ALTER SQL（针对 dst 表，按 dst 方言）
    let alter_sql = match df {
        1 => {
            let ds = if dst_schema.is_empty() { src_schema.as_str() } else { dst_schema.as_str() };
            let target = if ds.is_empty() { q_mysql(&dst_table) }
                         else { format!("{}.{}", q_mysql(ds), q_mysql(&dst_table)) };
            let mut parts: Vec<String> = Vec::new();
            for col in &added {
                let null_part = if col.nullable { "" } else { " NOT NULL" };
                let def_part  = col.default_value.as_deref()
                    .map(|d| format!(" DEFAULT '{}'", d.replace('\'', "''"))).unwrap_or_default();
                parts.push(format!("ADD COLUMN {} {}{}{}", q_mysql(&col.name), col.data_type, null_part, def_part));
            }
            for ch in &modified {
                let null_part = if ch.after.nullable { "" } else { " NOT NULL" };
                let def_part  = ch.after.default_value.as_deref()
                    .map(|d| format!(" DEFAULT '{}'", d.replace('\'', "''"))).unwrap_or_default();
                parts.push(format!("MODIFY COLUMN {} {}{}{}", q_mysql(&ch.name), ch.after.data_type, null_part, def_part));
            }
            for col in &removed { parts.push(format!("DROP COLUMN {}", q_mysql(&col.name))); }
            if parts.is_empty() { String::new() } else { format!("ALTER TABLE {target}\n  {};", parts.join(",\n  ")) }
        }
        2 => {
            let sd = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.clone() };
            let target = format!("{}.{}", q_dq(&sd), q_dq(&dst_table));
            let mut stmts: Vec<String> = Vec::new();
            for col in &added {
                let null_part = if col.nullable { "" } else { " NOT NULL" };
                let def_part  = col.default_value.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                stmts.push(format!("ALTER TABLE {target} ADD COLUMN {} {}{}{};", q_dq(&col.name), col.data_type, null_part, def_part));
            }
            for ch in &modified {
                stmts.push(format!("ALTER TABLE {target} ALTER COLUMN {} TYPE {};", q_dq(&ch.name), ch.after.data_type));
                if !ch.after.nullable && ch.before.nullable {
                    stmts.push(format!("ALTER TABLE {target} ALTER COLUMN {} SET NOT NULL;", q_dq(&ch.name)));
                } else if ch.after.nullable && !ch.before.nullable {
                    stmts.push(format!("ALTER TABLE {target} ALTER COLUMN {} DROP NOT NULL;", q_dq(&ch.name)));
                }
            }
            for col in &removed { stmts.push(format!("ALTER TABLE {target} DROP COLUMN {};", q_dq(&col.name))); }
            stmts.join("\n")
        }
        3 => {
            // Oracle：owner.table，双引号标识符；ADD/MODIFY 用括号包列
            let qid = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
            let target = if dst_schema.is_empty() { qid(&dst_table) } else { format!("{}.{}", qid(&dst_schema), qid(&dst_table)) };
            let mut stmts: Vec<String> = Vec::new();
            for col in &added {
                let nn = if col.nullable { "" } else { " NOT NULL" };
                let def = col.default_value.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                stmts.push(format!("ALTER TABLE {target} ADD ({} {}{}{});", qid(&col.name), col.data_type, def, nn));
            }
            for ch in &modified {
                let def = ch.after.default_value.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                stmts.push(format!("ALTER TABLE {target} MODIFY ({} {}{});", qid(&ch.name), ch.after.data_type, def));
            }
            for col in &removed { stmts.push(format!("ALTER TABLE {target} DROP COLUMN {};", qid(&col.name))); }
            stmts.join("\n")
        }
        4 => {
            // SQL Server：schema 实为数据库名 → [库].dbo.[表]，方括号标识符
            let qid = |s: &str| format!("[{}]", s.replace(']', "]]"));
            let target = if dst_schema.is_empty() { format!("dbo.{}", qid(&dst_table)) } else { format!("{}.dbo.{}", qid(&dst_schema), qid(&dst_table)) };
            let mut stmts: Vec<String> = Vec::new();
            for col in &added {
                let nn = if col.nullable { " NULL" } else { " NOT NULL" };
                let def = col.default_value.as_deref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                stmts.push(format!("ALTER TABLE {target} ADD {} {}{}{};", qid(&col.name), col.data_type, nn, def));
            }
            for ch in &modified {
                let nn = if ch.after.nullable { " NULL" } else { " NOT NULL" };
                stmts.push(format!("ALTER TABLE {target} ALTER COLUMN {} {}{};", qid(&ch.name), ch.after.data_type, nn));
            }
            for col in &removed { stmts.push(format!("ALTER TABLE {target} DROP COLUMN {};", qid(&col.name))); }
            stmts.join("\n")
        }
        _ => {
            // ClickHouse：schema 实为数据库名 → 库.表，反引号标识符（无 NULL/DEFAULT 约束差异概念）
            let qid = |s: &str| format!("`{}`", s.replace('`', "\\`"));
            let target = if dst_schema.is_empty() { qid(&dst_table) } else { format!("{}.{}", qid(&dst_schema), qid(&dst_table)) };
            let mut stmts: Vec<String> = Vec::new();
            for col in &added { stmts.push(format!("ALTER TABLE {target} ADD COLUMN {} {};", qid(&col.name), col.data_type)); }
            for ch in &modified { stmts.push(format!("ALTER TABLE {target} MODIFY COLUMN {} {};", qid(&ch.name), ch.after.data_type)); }
            for col in &removed { stmts.push(format!("ALTER TABLE {target} DROP COLUMN {};", qid(&col.name))); }
            stmts.join("\n")
        }
    };

    Ok(StructureDiff { added, removed, modified, alter_sql, danger_drops })
}

// ── 11. db_migrate_table ──────────────────────────────────────────────────────

// ── 同引擎迁移（Oracle / SQLServer / ClickHouse）：服务端 SQL 优先 ──────────────

async fn mig_run(
    config: &ConnConfig, password: Option<&str>, id: &str, sql: &str,
    ss_pool: &SsPool, registry: &DriverRegistry,
) -> Result<crate::models::QueryResult, String> {
    match config.conn_type {
        ConnType::Oracle => super::oracle::execute_query_impl(config.clone(), sql.to_string(), password.map(|s| s.to_string()), registry).await,
        ConnType::SqlServer => dispatch_ss_query(id, config, sql, ss_pool).await,
        ConnType::ClickHouse => super::query::dispatch_query(config, password, sql).await,
        _ => Err("不支持的连接类型".into()),
    }
}

fn mig_qid(ct: &ConnType, s: &str) -> String {
    match ct {
        ConnType::Oracle => format!("\"{}\"", s.replace('"', "\"\"")),
        ConnType::SqlServer => format!("[{}]", s.replace(']', "]]")),
        _ => format!("`{}`", s.replace('`', "``")),
    }
}

fn mig_table_ref(ct: &ConnType, schema: &str, table: &str) -> String {
    match ct {
        ConnType::SqlServer => if schema.is_empty() { format!("dbo.{}", mig_qid(ct, table)) }
                               else { format!("{}.dbo.{}", mig_qid(ct, schema), mig_qid(ct, table)) },
        _ => if schema.is_empty() { mig_qid(ct, table) } else { format!("{}.{}", mig_qid(ct, schema), mig_qid(ct, table)) },
    }
}

async fn mig_table_exists(
    ct: &ConnType, config: &ConnConfig, password: Option<&str>, id: &str,
    schema: &str, table: &str, ss_pool: &SsPool, registry: &DriverRegistry,
) -> Result<bool, String> {
    let sql = match ct {
        ConnType::Oracle => format!("SELECT 1 FROM all_tables WHERE owner='{}' AND table_name='{}'",
            schema.to_uppercase().replace('\'', "''"), table.to_uppercase().replace('\'', "''")),
        // schema 为空表示用当前库，须省略库限定符（否则 [].INFORMATION_SCHEMA 为非法标识符）
        ConnType::SqlServer => {
            let prefix = if schema.is_empty() { String::new() } else { format!("[{}].", schema.replace(']', "]]")) };
            format!("SELECT 1 FROM {prefix}INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='{}'", table.replace('\'', "''"))
        }
        _ => {
            // ClickHouse: schema 为空时用 currentDatabase() 避免 WHERE database='' 恒假
            let db_expr = if schema.is_empty() { "currentDatabase()".to_string() } else { format!("'{}'", schema.replace('\'', "''")) };
            format!("SELECT 1 FROM system.tables WHERE database={db_expr} AND name='{}'", table.replace('\'', "''"))
        }
    };
    Ok(!mig_run(config, password, id, &sql, ss_pool, registry).await?.rows.is_empty())
}

fn mig_is_numeric(t: &str) -> bool {
    let u = t.to_uppercase();
    ["INT", "NUMBER", "DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "REAL", "BIGINT", "SMALLINT", "TINYINT", "MONEY", "BIT", "UINT"]
        .iter().any(|k| u.contains(k))
}

#[allow(clippy::too_many_arguments)]
async fn migrate_same_engine(
    ct: ConnType,
    src_config: &ConnConfig, src_pwd: Option<&str>, src_id: &str, src_schema: &str, src_table: &str,
    dst_config: &ConnConfig, dst_pwd: Option<&str>, dst_id: &str, dst_schema: &str, dst_table: &str,
    strategy: &str, do_structure: bool, do_data: bool, clear_before: bool,
    sel_cols: Option<&[String]>, map_dst_cols: Option<&[String]>, where_sql: &str, row_limit: u64,
    _conflict_mode: &str, error_mode: &str,
    ss_pool: &SsPool, registry: &DriverRegistry,
) -> Result<MigrateResult, String> {
    let start = Instant::now();
    let same_conn = src_id == dst_id;
    let src_ref = mig_table_ref(&ct, src_schema, src_table);
    let dst_ref = mig_table_ref(&ct, dst_schema, dst_table);
    let mut errors: Vec<String> = Vec::new();

    let exists = mig_table_exists(&ct, dst_config, dst_pwd, dst_id, dst_schema, dst_table, ss_pool, registry).await.unwrap_or(false);
    if strategy == "skip" && exists {
        return Ok(MigrateResult { total_rows: 0, migrated_rows: 0, skipped_rows: 0, failed_rows: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, errors: vec!["目标表已存在，按「跳过」策略未迁移".into()] });
    }

    // 源列：用于列名、跨连接建表、INSERT 时按类型决定是否加引号
    let cols = get_cols_any(src_id, src_config, src_pwd, src_schema, src_table, ss_pool, registry).await?;
    let col_names: Vec<String> = match sel_cols { Some(sc) => sc.to_vec(), None => cols.iter().map(|c| c.name.clone()).collect() };
    // map_dst_cols 提供列名映射时，INSERT 目标列用目标名，SELECT 源列用源名
    let dst_col_names: Vec<String> = match map_dst_cols { Some(dc) => dc.to_vec(), None => col_names.clone() };
    let src_col_list = col_names.iter().map(|c| mig_qid(&ct, c)).collect::<Vec<_>>().join(", ");
    let dst_col_list = dst_col_names.iter().map(|c| mig_qid(&ct, c)).collect::<Vec<_>>().join(", ");

    // 行数上限（按方言）：前缀(SQLServer TOP) / 后缀(Oracle FETCH / ClickHouse LIMIT)
    let (sel_prefix, sel_suffix) = if row_limit > 0 {
        match ct {
            ConnType::SqlServer => (format!("TOP {row_limit} "), String::new()),
            ConnType::Oracle    => (String::new(), format!(" FETCH FIRST {row_limit} ROWS ONLY")),
            _                   => (String::new(), format!(" LIMIT {row_limit}")),
        }
    } else { (String::new(), String::new()) };

    // ── 结构 ──
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let mut same_engine_bak: Option<String> = None; // replace 策略下的备份表引用
    if do_structure && (!exists || strategy == "replace") {
        if exists && strategy == "replace" {
            // RENAME 旧表为备份（加时间戳防并发冲突），建表失败时还原
            let bak_table = format!("__mig_bak_{}_{}", dst_table, ts);
            let bak_ref = mig_table_ref(&ct, dst_schema, &bak_table);
            let rename_sql = match ct {
                ConnType::Oracle    => format!("ALTER TABLE {dst_ref} RENAME TO {}", mig_qid(&ct, &bak_table)),
                ConnType::SqlServer => format!("EXEC sp_rename '{}', '{}'", dst_ref.replace('\'', "''"), bak_table.replace('\'', "''")),
                _                   => format!("RENAME TABLE {dst_ref} TO {bak_ref}"), // ClickHouse
            };
            // 先清理可能残留的备份表
            let _ = mig_run(dst_config, dst_pwd, dst_id, &format!("DROP TABLE IF EXISTS {bak_ref}"), ss_pool, registry).await;
            mig_run(dst_config, dst_pwd, dst_id, &rename_sql, ss_pool, registry).await
                .map_err(|e| format!("备份旧表失败: {e}"))?;
            same_engine_bak = Some(bak_ref);
        }
        let create_result: Result<(), String> = (async {
            if same_conn {
                let create = match ct {
                    ConnType::Oracle    => format!("CREATE TABLE {dst_ref} AS SELECT * FROM {src_ref} WHERE 1=0"),
                    ConnType::SqlServer => format!("SELECT * INTO {dst_ref} FROM {src_ref} WHERE 1=0"),
                    _                   => format!("CREATE TABLE {dst_ref} AS {src_ref}"), // ClickHouse
                };
                mig_run(dst_config, dst_pwd, dst_id, &create, ss_pool, registry).await.map_err(|e| format!("创建目标表失败: {e}"))?;
            } else {
                match ct {
                    ConnType::ClickHouse => return Err("跨连接 ClickHouse 迁移需目标表先存在（CH 建表须指定 ENGINE）".into()),
                    _ => {
                        let defs = cols.iter().map(|c| {
                            let nn = if c.nullable { "" } else { " NOT NULL" };
                            format!("{} {}{}", mig_qid(&ct, &c.name), c.data_type, nn)
                        }).collect::<Vec<_>>().join(", ");
                        mig_run(dst_config, dst_pwd, dst_id, &format!("CREATE TABLE {dst_ref} ({defs})"), ss_pool, registry).await
                            .map_err(|e| format!("创建目标表失败: {e}"))?;
                    }
                }
            }
            Ok(())
        }).await;
        if let Err(e) = create_result {
            // 建表失败 → 还原备份
            if let Some(ref bak_ref) = same_engine_bak {
                let restore_sql = match ct {
                    ConnType::Oracle    => format!("ALTER TABLE {bak_ref} RENAME TO {}", mig_qid(&ct, dst_table)),
                    ConnType::SqlServer => format!("EXEC sp_rename '{}', '{}'", bak_ref.replace('\'', "''"), dst_table.replace('\'', "''")),
                    _                   => format!("RENAME TABLE {bak_ref} TO {dst_ref}"),
                };
                let _ = mig_run(dst_config, dst_pwd, dst_id, &restore_sql, ss_pool, registry).await;
            }
            return Err(e);
        }
    }

    // 本次迁移是否新建了目标表结构（CTAS / CREATE 均以源列名建表）
    let structure_created = do_structure && (!exists || strategy == "replace");

    // TRUNCATE 在「清空重写」且本次未新建表结构时执行（新建的表本就为空）。
    // 不依赖 exists 探测（探测可能因瞬时失败返回 false），直接执行并上抛错误：
    // 表不存在时 TRUNCATE 报错是正确行为——告知用户需先建表。
    if clear_before && !structure_created {
        mig_run(dst_config, dst_pwd, dst_id, &format!("TRUNCATE TABLE {dst_ref}"), ss_pool, registry).await
            .map_err(|e| format!("清空目标表失败: {e}"))?;
    }

    // ── 数据 ──
    let mut migrated: u64 = 0;
    let mut failed: u64 = 0;
    let mut src_total: u64 = 0;   // 跨连接路径下源端总行数（用于统计 stop 中止后未处理的行）
    // INSERT 目标列名：新建表带源列名 → 用源名；写入已有外部表才用映射后的目标名
    let insert_col_list = if structure_created { &src_col_list } else { &dst_col_list };

    // 列重命名（map_dst_cols）与 structure_created（CTAS 以源列名建表）不兼容：
    // CTAS 无法在建表时重命名列，继续执行将静默丢失用户配置的目标列名映射。
    if structure_created && map_dst_cols.is_some() {
        return Err("同引擎迁移的「建表+数据」模式不支持列重命名：CTAS 以源列名建表，列映射无法生效。请先手动建好目标表，再选「仅数据」模式并配置列映射。".into());
    }

    if do_data {
        let sel = if sel_cols.is_some() { src_col_list.clone() } else { "*".to_string() };
        if same_conn {
            // 服务端 INSERT ... SELECT，零数据往返、类型零损失
            // ClickHouse 的 INSERT...SELECT 不返回 rows_affected，需要前后差值补偿；
            // Oracle / SQL Server 返回可靠的 rows_affected，无需 COUNT 扫描。
            let pre_count = if matches!(ct, ConnType::ClickHouse) {
                mig_run(dst_config, dst_pwd, dst_id, &format!("SELECT COUNT(*) FROM {dst_ref}"), ss_pool, registry).await.ok()
                    .and_then(|c| c.rows.first().and_then(|r| r.first()).and_then(|v| v.as_deref()).and_then(|s| s.parse::<u64>().ok()))
            } else { None };
            let sql = format!("INSERT INTO {dst_ref} ({insert_col_list}) SELECT {sel_prefix}{sel} FROM {src_ref}{where_sql}{sel_suffix}");
            let r = mig_run(dst_config, dst_pwd, dst_id, &sql, ss_pool, registry).await.map_err(|e| format!("迁移数据失败: {e}"))?;
            migrated = r.rows_affected;
            if migrated == 0 {
                if let Some(pre) = pre_count {
                    // pre_count 成功时才用差值补偿，失败则 migrated 维持 0（不虚报）
                    let post = mig_run(dst_config, dst_pwd, dst_id, &format!("SELECT COUNT(*) FROM {dst_ref}"), ss_pool, registry).await.ok()
                        .and_then(|c| c.rows.first().and_then(|r| r.first()).and_then(|v| v.as_deref()).and_then(|s| s.parse::<u64>().ok()))
                        .unwrap_or(pre);
                    migrated = post.saturating_sub(pre);
                }
            }
        } else {
            // 跨连接：读源行 + 分批 INSERT（按列类型决定数值不加引号 / 文本加引号转义）
            let read_sql = format!("SELECT {sel_prefix}{sel} FROM {src_ref}{where_sql}{sel_suffix}");
            let src_rows = mig_run(src_config, src_pwd, src_id, &read_sql, ss_pool, registry).await.map_err(|e| format!("读取源数据失败: {e}"))?;
            src_total = src_rows.rows.len() as u64;
            let numeric: Vec<bool> = col_names.iter()
                .map(|n| cols.iter().find(|c| &c.name == n).map(|c| mig_is_numeric(&c.data_type)).unwrap_or(false)).collect();
            'batch: for batch in src_rows.rows.chunks(500) {
                let values = batch.iter().map(|row| {
                    let vs = row.iter().enumerate().map(|(i, v)| match v {
                        None => "NULL".to_string(),
                        Some(s) => if *numeric.get(i).unwrap_or(&false) { s.clone() } else { format!("'{}'", s.replace('\'', "''")) },
                    }).collect::<Vec<_>>().join(", ");
                    format!("({vs})")
                }).collect::<Vec<_>>().join(", ");
                match mig_run(dst_config, dst_pwd, dst_id, &format!("INSERT INTO {dst_ref} ({insert_col_list}) VALUES {values}"), ss_pool, registry).await {
                    Ok(_) => migrated += batch.len() as u64,
                    Err(e) => {
                        failed += batch.len() as u64;
                        errors.push(format!("批量插入失败: {e}"));
                        if error_mode == "stop" { break 'batch; }
                    }
                }
            }
        }
    }

    // replace 策略数据传输完成后：全部成功则删备份，有失败则忽略（部分数据已写入，不回滚到旧状态）
    if let Some(ref bak_ref) = same_engine_bak {
        if failed == 0 {
            let _ = mig_run(dst_config, dst_pwd, dst_id, &format!("DROP TABLE IF EXISTS {bak_ref}"), ss_pool, registry).await;
        }
        // failed > 0：保留备份供用户手动恢复，不自动还原（部分行已写入新表，还原会静默丢失新增行）
    }

    // stop 模式中途 break 后剩余未处理的行计入 skipped，使前端能区分「完成」与「中止」
    let skipped = src_total.saturating_sub(migrated + failed);
    let total = if src_total > 0 { src_total } else { migrated + failed };
    Ok(MigrateResult {
        total_rows: total, migrated_rows: migrated, skipped_rows: skipped, failed_rows: failed,
        elapsed_ms: start.elapsed().as_millis() as u64, errors,
    })
}

#[tauri::command]
pub async fn db_migrate_table(
    src_id:     String,
    src_schema: String,
    src_table:  String,
    dst_id:     String,
    dst_schema: String,
    dst_table:  String,
    strategy:   String,
    batch_size: u64,
    options:    Option<MigrateOptions>,
    app_handle: tauri::AppHandle,
    storage:    State<'_, StorageState>,
    duck_pool:  State<'_, DuckPool>,
    registry:   State<'_, super::driver::DriverRegistry>,
    ss_pool:    State<'_, SsPool>,
) -> Result<MigrateResult, String> {
    validate_ident(&src_table)?;
    validate_ident(&dst_table)?;
    if !src_schema.is_empty() { validate_ident(&src_schema)?; }
    if !dst_schema.is_empty() { validate_ident(&dst_schema)?; }

    // ── 解析高级选项 ──────────────────────────────────────────────────────────
    let opts = options.unwrap_or_default();
    let conflict   = opts.conflict_mode.clone().unwrap_or_else(|| "error".into());
    let content    = opts.content.clone().unwrap_or_else(|| "both".into());
    let error_mode = opts.error_mode.clone().unwrap_or_else(|| "stop".into());
    let disable_fk = opts.disable_fk.unwrap_or(false);
    let use_tx     = opts.use_transaction.unwrap_or(false);
    let row_limit  = opts.row_limit.unwrap_or(0);
    let where_clause = opts.where_clause.clone().filter(|w| !w.trim().is_empty());
    if let Some(ref w) = where_clause { validate_where(w)?; }

    // 列映射：源列 / 目标列；未提供则迁移全部列（1:1）
    let (sel_cols, map_dst_cols): (Option<Vec<String>>, Option<Vec<String>>) = match &opts.column_map {
        Some(m) if !m.is_empty() => {
            for p in m { validate_ident(&p[0])?; validate_ident(&p[1])?; }
            (Some(m.iter().map(|p| p[0].clone()).collect()),
             Some(m.iter().map(|p| p[1].clone()).collect()))
        }
        _ => (None, None),
    };

    let do_structure = content != "data";       // 创建/重建目标表结构
    let do_data      = content != "structure";   // 写入数据
    // 仅数据时，覆盖/截断都表现为「先清空再写入」
    let clear_before_insert = (strategy == "truncate")
        || (strategy == "replace" && !do_structure);

    let where_sql = where_clause.as_ref().map(|w| format!(" WHERE {w}")).unwrap_or_default();
    let limit_sql = if row_limit > 0 { format!(" LIMIT {row_limit}") } else { String::new() };

    let start = Instant::now();
    let batch = batch_size.max(1).min(10_000);

    let (src_config, src_pwd) = load_conn(&src_id, &storage).await?;
    let (dst_config, dst_pwd) = load_conn(&dst_id, &storage).await?;
    ensure_writable(&dst_config)?;   // 迁移写入目标连接，目标只读则拒绝

    // 同引擎（Oracle / SQL Server / ClickHouse）迁移走专用路径：
    // 同连接用服务端 CTAS + INSERT...SELECT（零数据往返、类型零损失）；跨连接读+写。
    if src_config.conn_type == dst_config.conn_type
        && matches!(src_config.conn_type, ConnType::Oracle | ConnType::SqlServer | ConnType::ClickHouse)
    {
        // Oracle / SQL Server / ClickHouse 同引擎路径暂未实现冲突合并（各方言 MERGE 语法差异大）。
        // 明确拒绝而非静默忽略，避免用户误以为「忽略冲突 / UPSERT」策略已生效。
        if conflict != "error" {
            return Err("Oracle / SQL Server / ClickHouse 迁移暂不支持「忽略冲突 / 按主键更新」，请将冲突处理改为「报错中止」".into());
        }
        return migrate_same_engine(
            src_config.conn_type.clone(),
            &src_config, src_pwd.as_deref(), &src_id, &src_schema, &src_table,
            &dst_config, dst_pwd.as_deref(), &dst_id, &dst_schema, &dst_table,
            &strategy, do_structure, do_data, clear_before_insert,
            sel_cols.as_deref(), map_dst_cols.as_deref(), &where_sql, row_limit,
            &conflict, &error_mode, &ss_pool, &registry,
        ).await;
    }

    let emit_progress = |stage: &str, total_rows: u64, migrated_rows: u64| {
        #[derive(serde::Serialize, Clone)]
        struct Progress { stage: String, total_rows: u64, migrated_rows: u64 }
        let _ = app_handle.emit("migrate_progress", Progress {
            stage: stage.to_string(), total_rows, migrated_rows,
        });
    };

    // ── 0. 大表流式直传：MySQL / PostgreSQL / SQLite，游标边读边写，内存恒定 ──────────
    // 仅覆盖常规策略（replace/truncate/append/skip）+ 无列映射；其余组合走下方一次性读取。
    // 镜像/影子表策略已在后续分支处理，此处 strategy 匹配自然排除它们。
    let can_stream = sel_cols.is_none() && do_data
        && matches!(strategy.as_str(), "replace" | "truncate" | "append" | "skip")
        && is_sql_engine(&src_config.conn_type) && is_sql_engine(&dst_config.conn_type);
    if can_stream {
        use sqlx::Row;
        use futures::{StreamExt, TryStreamExt};
        emit_progress("reading", 0, 0);
        let batch_usize = batch as usize;
        let skip_errors = error_mode == "skip";
        let skip_result = |est: u64| MigrateResult { total_rows: est, migrated_rows: 0, skipped_rows: est, failed_rows: 0, elapsed_ms: start.elapsed().as_millis() as u64, errors: vec![] };

        match src_config.conn_type {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                let (mut src_conn, _g) = mysql_connect(&src_config, src_pwd.as_deref()).await?;
                let schema_q = if src_schema.is_empty() { src_config.database.clone().unwrap_or_default() } else { src_schema.clone() };
                let src = if src_schema.is_empty() { q_mysql(&src_table) } else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
                let meta = sqlx::query("SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION")
                    .bind(&schema_q).bind(&src_table).fetch_all(&mut src_conn).await.map_err(|e| format!("读取源表结构失败: {e}"))?;
                let col_names: Vec<String> = meta.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                let col_types: Vec<String> = meta.iter().filter_map(|r| r.try_get::<String, _>(1).ok()).collect();
                if col_names.is_empty() { return Err("无法确定源表列，迁移中止".into()); }
                let total_est: u64 = sqlx::query("SELECT TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?")
                    .bind(&schema_q).bind(&src_table).fetch_optional(&mut src_conn).await.ok().flatten()
                    .and_then(|r| r.try_get::<i64, _>(0).ok()).unwrap_or(0).max(0) as u64;
                let dst_is_mysql = matches!(dst_config.conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase);
                let can_like = dst_is_mysql && (src_id == dst_id || src_config.host == dst_config.host);
                // MySQL→MySQL 时始终从源端取 SHOW CREATE TABLE：
                // - 跨服务器：主路径（目标无法引用源端表名）
                // - 同主机跨库：LIKE 成功时忽略 native_ddl；LIKE 因权限/版本失败时用作精确 fallback
                //   （LIKE 失败只有 col_types 时列长度/charset/索引丢失，3098 等问题会重现）
                let native_ddl: Option<String> = if dst_is_mysql && do_structure {
                    sqlx::query(&format!("SHOW CREATE TABLE {src}")).fetch_one(&mut src_conn).await.ok()
                        .and_then(|r| r.try_get::<String, _>(1).ok())
                } else { None };
                let setup = match open_stream_dst(&dst_config, dst_pwd.as_deref(), &dst_schema, &dst_table, &strategy, do_structure, clear_before_insert, disable_fk, use_tx, &col_names, &col_types, can_like, &src, &src_config.conn_type, native_ddl.as_deref()).await? {
                    None => { emit_progress("done", total_est, 0); return Ok(skip_result(total_est)); }
                    Some(s) => s,
                };
                // replace 策略备份清理信息（drive_stream 会消耗 setup，提前取出）
                let bak_q = setup.bak_q.clone();
                let orig_q = setup.orig_q.clone();
                let sel = tag_sql(&format!("SELECT {} FROM {src}{where_sql}{limit_sql}", col_names.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ")));
                let stream = sqlx::query(&sel).fetch(&mut src_conn).map_ok(|r| mysql_row_to_strings(&r)).boxed();
                let result = drive_stream(stream, setup, &col_names, &conflict, skip_errors, use_tx, disable_fk, batch_usize, total_est, &emit_progress, start).await;
                // 迁移完成后处理备份表
                if let (Some(bq), Some(oq)) = (bak_q, orig_q) {
                    if let Ok((mut c, _g)) = mysql_connect(&dst_config, dst_pwd.as_deref()).await {
                        if result.is_ok() {
                            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut c).await;
                        } else {
                            // 数据传输失败：删新表、恢复备份
                            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {oq}")).execute(&mut c).await;
                            let _ = sqlx::query(&format!("RENAME TABLE {bq} TO {oq}")).execute(&mut c).await;
                        }
                    }
                }
                return result;
            }
            ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                let (mut src_conn, _g) = pg_connect(&src_config, src_pwd.as_deref()).await?;
                let ss = if src_schema.is_empty() { "public".to_string() } else { src_schema.clone() };
                let src = format!("{}.{}", q_dq(&ss), q_dq(&src_table));
                let meta = sqlx::query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position")
                    .bind(&ss).bind(&src_table).fetch_all(&mut src_conn).await.map_err(|e| format!("读取源表结构失败: {e}"))?;
                let col_names: Vec<String> = meta.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                let col_types: Vec<String> = meta.iter().filter_map(|r| r.try_get::<String, _>(1).ok()).collect();
                if col_names.is_empty() { return Err("无法确定源表列，迁移中止".into()); }
                let total_est: u64 = sqlx::query("SELECT reltuples::bigint FROM pg_class WHERE oid = ($1)::regclass")
                    .bind(&src).fetch_optional(&mut src_conn).await.ok().flatten()
                    .and_then(|r| r.try_get::<i64, _>(0).ok()).unwrap_or(0).max(0) as u64;
                let can_like = matches!(dst_config.conn_type, ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss) && src_id == dst_id;
                let setup = match open_stream_dst(&dst_config, dst_pwd.as_deref(), &dst_schema, &dst_table, &strategy, do_structure, clear_before_insert, disable_fk, use_tx, &col_names, &col_types, can_like, &src, &src_config.conn_type, None).await? {
                    None => { emit_progress("done", total_est, 0); return Ok(skip_result(total_est)); }
                    Some(s) => s,
                };
                let bak_q = setup.bak_q.clone();
                let orig_q = setup.orig_q.clone();
                let sel = tag_sql(&format!("SELECT {} FROM {src}{where_sql}{limit_sql}", col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ")));
                let stream = sqlx::query(&sel).fetch(&mut src_conn).map_ok(|r| pg_row_to_strings(&r)).boxed();
                let result = drive_stream(stream, setup, &col_names, &conflict, skip_errors, use_tx, disable_fk, batch_usize, total_est, &emit_progress, start).await;
                if let (Some(bq), Some(oq)) = (bak_q, orig_q) {
                    if let Ok((mut c, _g)) = pg_connect(&dst_config, dst_pwd.as_deref()).await {
                        if result.is_ok() {
                            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut c).await;
                        } else {
                            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {oq}")).execute(&mut c).await;
                            let _ = sqlx::query(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(&dst_table))).execute(&mut c).await;
                        }
                    }
                }
                return result;
            }
            ConnType::Sqlite => {
                use crate::commands::query::sqlite_url;
                use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
                use std::str::FromStr;
                let url = sqlite_url(&src_config)?;
                let mut src_conn = SqliteConnectOptions::from_str(&url).map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                    .read_only(true).busy_timeout(std::time::Duration::from_secs(30)).log_statements(log::LevelFilter::Off)
                    .connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
                let src = if src_schema.is_empty() { q_dq(&src_table) } else { format!("{}.{}", q_dq(&src_schema), q_dq(&src_table)) };
                let pragma = sqlx::query(&format!("PRAGMA table_info({src})")).fetch_all(&mut src_conn).await.map_err(|e| format!("读取源表结构失败: {e}"))?;
                let col_names: Vec<String> = pragma.iter().filter_map(|r| r.try_get::<String, _>("name").ok()).collect();
                let col_types: Vec<String> = pragma.iter().filter_map(|r| r.try_get::<String, _>("type").ok()).collect();
                if col_names.is_empty() { return Err("无法确定源表列，迁移中止".into()); }
                let total_est = 0u64; // SQLite 无瞬时行数估算
                let can_like = matches!(dst_config.conn_type, ConnType::Sqlite) && src_id == dst_id;
                let setup = match open_stream_dst(&dst_config, dst_pwd.as_deref(), &dst_schema, &dst_table, &strategy, do_structure, clear_before_insert, disable_fk, use_tx, &col_names, &col_types, can_like, &src, &src_config.conn_type, None).await? {
                    None => { emit_progress("done", total_est, 0); return Ok(skip_result(total_est)); }
                    Some(s) => s,
                };
                let bak_q = setup.bak_q.clone();
                let orig_q = setup.orig_q.clone();
                let sel = format!("SELECT {} FROM {src}{where_sql}{limit_sql}", col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", "));
                let stream = sqlx::query(&sel).fetch(&mut src_conn).map_ok(|r| sqlite_row_to_strings(&r)).boxed();
                let result = drive_stream(stream, setup, &col_names, &conflict, skip_errors, use_tx, disable_fk, batch_usize, total_est, &emit_progress, start).await;
                if let (Some(bq), Some(oq)) = (bak_q, orig_q) {
                    use crate::commands::query::sqlite_url;
                    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
                    use std::str::FromStr;
                    if let Ok(url) = sqlite_url(&dst_config) {
                        if let Ok(opts) = SqliteConnectOptions::from_str(&url) {
                            if let Ok(mut c) = opts.log_statements(log::LevelFilter::Off).connect().await {
                                if result.is_ok() {
                                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut c).await;
                                } else {
                                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {oq}")).execute(&mut c).await;
                                    let _ = sqlx::query(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(&dst_table))).execute(&mut c).await;
                                }
                            }
                        }
                    }
                }
                return result;
            }
            _ => {}
        }
    }

    // ── 1. 读取源数据 ──────────────────────────────────────────────────────────
    emit_progress("reading", 0, 0);

    let mut col_types: Vec<String> = vec![];
    let mut meta_names: Vec<String> = vec![]; // 元数据列名（结果集为空时回退用）
    let (rows_cols, all_rows): (Vec<String>, Vec<Vec<Option<String>>>) = match src_config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::{Column, Row};
            let (mut conn, _t) = mysql_connect(&src_config, src_pwd.as_deref()).await?;
            let src = if src_schema.is_empty() { q_mysql(&src_table) }
                      else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
            let schema_q = if src_schema.is_empty() {
                src_config.database.clone().unwrap_or_default()
            } else { src_schema.clone() };
            if !schema_q.is_empty() {
                if let Ok(type_rows) = sqlx::query(
                    "SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION"
                ).bind(&schema_q).bind(&src_table).fetch_all(&mut conn).await {
                    meta_names = type_rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                    col_types  = type_rows.iter().filter_map(|r| r.try_get::<String, _>(1).ok()).collect();
                }
            }
            let sel = match &sel_cols {
                Some(c) => c.iter().map(|x| q_mysql(x)).collect::<Vec<_>>().join(", "),
                None => "*".into(),
            };
            let sql = tag_sql(&format!("SELECT {sel} FROM {src}{where_sql}{limit_sql}"));
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("读取源数据失败: {e}"))?;
            let cols = rows.first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows.iter().map(|r| mysql_row_to_strings(r)).collect();
            (cols, data)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::{Column, Row};
            let (mut conn, _t) = pg_connect(&src_config, src_pwd.as_deref()).await?;
            let ss = if src_schema.is_empty() { "public".to_string() } else { src_schema.clone() };
            let src = format!("{}.{}", q_dq(&ss), q_dq(&src_table));
            if let Ok(name_rows) = sqlx::query(
                "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position"
            ).bind(&ss).bind(&src_table).fetch_all(&mut conn).await {
                meta_names = name_rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                col_types  = name_rows.iter().filter_map(|r| r.try_get::<String, _>(1).ok()).collect();
            }
            let sel = match &sel_cols {
                Some(c) => c.iter().map(|x| q_dq(x)).collect::<Vec<_>>().join(", "),
                None => "*".into(),
            };
            let sql = tag_sql(&format!("SELECT {sel} FROM {src}{where_sql}{limit_sql}"));
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("读取源数据失败: {e}"))?;
            let cols = rows.first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows.iter().map(|r| pg_row_to_strings(r)).collect();
            (cols, data)
        }
        ConnType::Sqlite => {
            use sqlx::{Column, Row};
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(&src_config)?;
            let opts2 = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .read_only(true)
                .busy_timeout(std::time::Duration::from_secs(10))
                .log_statements(log::LevelFilter::Off);
            let mut conn = opts2.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let src_q = if src_schema.is_empty() { q_dq(&src_table) }
                        else { format!("{}.{}", q_dq(&src_schema), q_dq(&src_table)) };
            if let Ok(pragma_rows) = sqlx::query(&format!("PRAGMA {}.table_info({})",
                if src_schema.is_empty() { "main".to_string() } else { q_dq(&src_schema) },
                q_dq(&src_table)
            )).fetch_all(&mut conn).await {
                meta_names = pragma_rows.iter().filter_map(|r| r.try_get::<String, _>(1).ok()).collect();
                col_types  = pragma_rows.iter().filter_map(|r| r.try_get::<String, _>(2).ok()).collect();
            }
            let sel = match &sel_cols {
                Some(c) => c.iter().map(|x| q_dq(x)).collect::<Vec<_>>().join(", "),
                None => "*".into(),
            };
            let rows = sqlx::query(&format!("SELECT {sel} FROM {src_q}{where_sql}{limit_sql}"))
                .fetch_all(&mut conn).await
                .map_err(|e| format!("读取源数据失败: {e}"))?;
            let cols: Vec<String> = rows.first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let data = rows.iter().map(|r| sqlite_row_to_strings(r)).collect();
            (cols, data)
        }
        ConnType::Duckdb => {
            // DD1.5 DuckDB 作为迁移源
            let src_q = if src_schema.is_empty() {
                format!("\"{}\"", src_table.replace('"', "\"\""))
            } else {
                format!("\"{}\".\"{}\"", src_schema.replace('"', "\"\""), src_table.replace('"', "\"\""))
            };
            let sel = match &sel_cols {
                Some(c) => c.iter().map(|x| format!("\"{}\"", x.replace('"', "\"\""))).collect::<Vec<_>>().join(", "),
                None => "*".into(),
            };
            let sql = format!("SELECT {sel} FROM {src_q}{where_sql}{limit_sql}");
            let result = dispatch_duck_query(&src_id, &src_config, &sql, &duck_pool, &registry).await
                .map_err(|e| format!("读取 DuckDB 源数据失败: {e}"))?;
            (result.columns, result.rows)
        }
        _ => return Err("源连接类型不支持迁移".into()),
    };

    // 实际源列名（结果集为空时回退到元数据列名）
    let src_cols: Vec<String> = if let Some(sc) = &sel_cols { sc.clone() }
        else if !rows_cols.is_empty() { rows_cols }
        else { meta_names.clone() };
    if src_cols.is_empty() {
        return Err("无法确定源表列，迁移中止".into());
    }
    // 写入目标的列名（列映射时取目标列名）
    let col_names: Vec<String> = map_dst_cols.clone().unwrap_or_else(|| src_cols.clone());
    // 列映射时类型对齐失效，建表退化为 TEXT
    if sel_cols.is_some() { col_types.clear(); }

    let total_rows = all_rows.len() as u64;
    emit_progress("migrating", total_rows, 0);

    // ── 2. 目标存在性检查 ──────────────────────────────────────────────────────
    let target_exists: bool = match dst_config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&dst_config, dst_pwd.as_deref()).await?;
            let dst = if dst_schema.is_empty() { q_mysql(&dst_table) }
                      else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&dst_table)) };
            sqlx::query(&tag_sql(&format!("SELECT 1 FROM {dst} LIMIT 1")))
                .fetch_optional(&mut conn).await.is_ok()
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&dst_config, dst_pwd.as_deref()).await?;
            let ds = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.clone() };
            let dst = format!("{}.{}", q_dq(&ds), q_dq(&dst_table));
            sqlx::query(&tag_sql(&format!("SELECT 1 FROM {dst} LIMIT 1")))
                .fetch_optional(&mut conn).await.is_ok()
        }
        ConnType::Sqlite => {
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(&dst_config)?;
            let opts2 = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .busy_timeout(std::time::Duration::from_secs(10))
                .log_statements(log::LevelFilter::Off);
            let mut conn = opts2.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let dst_q = q_dq(&dst_table);
            sqlx::query(&format!("SELECT 1 FROM {dst_q} LIMIT 1"))
                .fetch_optional(&mut conn).await.is_ok()
        }
        ConnType::Duckdb => {
            let dst_q = format!("\"{}\"", dst_table.replace('"', "\"\""));
            dispatch_duck_query(&dst_id, &dst_config, &format!("SELECT 1 FROM {dst_q} LIMIT 1"), &duck_pool, &registry)
                .await.is_ok()
        }
        _ => return Err("目标连接类型不支持迁移".into()),
    };

    // 跳过策略：目标已存在 → 整表跳过
    if strategy == "skip" && target_exists {
        emit_progress("done", total_rows, 0);
        return Ok(MigrateResult {
            total_rows, migrated_rows: 0, skipped_rows: total_rows, failed_rows: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, errors: vec![],
        });
    }
    if (strategy == "truncate" || (strategy == "append" && !do_structure)) && !target_exists {
        return Err(format!("目标表不存在，{}策略要求目标表已存在",
            if strategy == "truncate" { "截断" } else { "追加" }));
    }

    // ── 镜像同步 / 原子替换（影子表）：MySQL / PostgreSQL / SQLite ──────────────────
    if strategy == "mirror" || strategy == "shadow" {
        use sqlx::Row;
        if !do_data {
            return Err("「镜像同步 / 原子替换」需要写入数据，请将迁移内容设为「结构 + 数据」或「仅数据」".into());
        }

        // —— PostgreSQL（同库用 LIKE INCLUDING ALL 保留完整结构，跨库退化为 TEXT 列）——
        if matches!(dst_config.conn_type, ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss) {
            let (mut conn, _t) = pg_connect(&dst_config, dst_pwd.as_deref()).await?;
            let ds = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.clone() };
            let dst = format!("{}.{}", q_dq(&ds), q_dq(&dst_table));
            let ss = if src_schema.is_empty() { "public".to_string() } else { src_schema.clone() };
            let src_q = format!("{}.{}", q_dq(&ss), q_dq(&src_table));
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let n_cols = col_names.len();
            let same_conn = sel_cols.is_none() && src_id == dst_id; // PG 跨库无法 LIKE 引用源表
            let mut migrated_rows: u64 = 0;
            let mut errors: Vec<String> = vec![];

            if strategy == "shadow" {
                let shadow = format!("{dst_table}__dbterm_shadow");
                validate_ident(&shadow)?;
                let shadow_q = format!("{}.{}", q_dq(&ds), q_dq(&shadow));
                let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
                if same_conn {
                    sqlx::query(&tag_sql(&format!("CREATE TABLE {shadow_q} (LIKE {src_q} INCLUDING ALL)")))
                        .execute(&mut conn).await.map_err(|e| format!("创建影子表失败: {e}"))?;
                } else {
                    create_pg_table_mapped(&mut conn, &shadow_q, &col_names, &col_types).await?;
                }
                for chunk in all_rows.chunks(batch as usize) {
                    for row in chunk {
                        let ph = (1..=n_cols).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                        let sql = tag_sql(&format!("INSERT INTO {shadow_q} ({col_list}) VALUES ({ph})"));
                        let mut q = sqlx::query(&sql);
                        for v in row { q = q.bind(v.as_deref()); }
                        if let Err(e) = q.execute(&mut conn).await {
                            let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
                            return Err(format!("影子表写入失败: {e}"));
                        }
                        migrated_rows += 1;
                    }
                    emit_progress("migrating", total_rows, migrated_rows);
                }
                // 事务内原子切换
                let old = format!("{dst_table}__dbterm_old");
                validate_ident(&old)?;
                let old_q = format!("{}.{}", q_dq(&ds), q_dq(&old));
                let mut swap_err: Option<String> = None;
                if let Err(e) = sqlx::query("BEGIN").execute(&mut conn).await { swap_err = Some(e.to_string()); }
                if swap_err.is_none() && target_exists {
                    if let Err(e) = sqlx::query(&tag_sql(&format!("ALTER TABLE {dst} RENAME TO {}", q_dq(&old)))).execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if swap_err.is_none() {
                    if let Err(e) = sqlx::query(&tag_sql(&format!("ALTER TABLE {shadow_q} RENAME TO {}", q_dq(&dst_table)))).execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if swap_err.is_none() {
                    if let Err(e) = sqlx::query("COMMIT").execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if let Some(e) = swap_err {
                    let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
                    return Err(format!("原子切换失败: {e}"));
                }
                if target_exists { let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {old_q}"))).execute(&mut conn).await; }
            } else {
                // 镜像同步
                if !target_exists {
                    if same_conn {
                        sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} (LIKE {src_q} INCLUDING ALL)")))
                            .execute(&mut conn).await.map_err(|e| format!("创建目标表失败: {e}"))?;
                    } else {
                        create_pg_table_mapped(&mut conn, &dst, &col_names, &col_types).await?;
                    }
                }
                let pk: Vec<String> = sqlx::query(
                    "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema \
                     WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=$1 AND tc.table_name=$2 ORDER BY kcu.ordinal_position"
                ).bind(&ds).bind(&dst_table).fetch_all(&mut conn).await.ok()
                 .map(|rs| rs.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
                 .unwrap_or_default();
                if pk.is_empty() { return Err("镜像同步要求目标表有主键（用于识别并删除源中已删除的行）".into()); }
                let pk_idx: Vec<usize> = match pk.iter().map(|p| col_names.iter().position(|c| c == p)).collect() {
                    Some(v) => v, None => return Err("镜像同步要求迁移列包含全部主键列".into()),
                };
                let pk_set: std::collections::HashSet<&String> = pk.iter().collect();
                let conflict_target = pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                let sets = col_names.iter().filter(|c| !pk_set.contains(*c))
                    .map(|c| { let qc = q_dq(c); format!("{qc}=EXCLUDED.{qc}") }).collect::<Vec<_>>().join(", ");
                let suffix = if sets.is_empty() { format!(" ON CONFLICT ({conflict_target}) DO NOTHING") }
                             else { format!(" ON CONFLICT ({conflict_target}) DO UPDATE SET {sets}") };
                for chunk in all_rows.chunks(batch as usize) {
                    for row in chunk {
                        let ph = (1..=n_cols).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                        let sql = tag_sql(&format!("INSERT INTO {dst} ({col_list}) VALUES ({ph}){suffix}"));
                        let mut q = sqlx::query(&sql);
                        for v in row { q = q.bind(v.as_deref()); }
                        if let Err(e) = q.execute(&mut conn).await { return Err(format!("镜像写入失败: {e}")); }
                        migrated_rows += 1;
                    }
                    emit_progress("migrating", total_rows, migrated_rows);
                }
                if all_rows.is_empty() {
                    if let Err(e) = sqlx::query(&tag_sql(&format!("DELETE FROM {dst}"))).execute(&mut conn).await { errors.push(format!("删除孤立行失败: {e}")); }
                } else {
                    let pk_cols_q = pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                    let tmp = "_dbterm_mirror_pk";
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                    if let Err(e) = sqlx::query(&tag_sql(&format!("CREATE TEMP TABLE {tmp} AS SELECT {pk_cols_q} FROM {dst} WHERE false"))).execute(&mut conn).await {
                        errors.push(format!("创建主键临时表失败，跳过删除孤立行: {e}"));
                    } else {
                        let mut ok = true;
                        for chunk in all_rows.chunks(batch as usize) {
                            for row in chunk {
                                let ph = (1..=pk.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                                let sql = format!("INSERT INTO {tmp} ({pk_cols_q}) VALUES ({ph})");
                                let mut q = sqlx::query(&sql);
                                for &i in &pk_idx { q = q.bind(row[i].as_deref()); }
                                if let Err(e) = q.execute(&mut conn).await { errors.push(format!("收集源主键失败: {e}")); ok = false; break; }
                            }
                            if !ok { break; }
                        }
                        if ok {
                            let on = pk.iter().map(|c| { let qc = q_dq(c); format!("t.{qc}=d.{qc}") }).collect::<Vec<_>>().join(" AND ");
                            let del = tag_sql(&format!("DELETE FROM {dst} d WHERE NOT EXISTS (SELECT 1 FROM {tmp} t WHERE {on})"));
                            if let Err(e) = sqlx::query(&del).execute(&mut conn).await { errors.push(format!("删除孤立行失败: {e}")); }
                        }
                        let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                    }
                }
            }
            emit_progress("done", total_rows, migrated_rows);
            return Ok(MigrateResult { total_rows, migrated_rows, skipped_rows: 0, failed_rows: 0,
                elapsed_ms: start.elapsed().as_millis() as u64, errors });
        }

        // —— SQLite（同库用 AS SELECT 复制列与亲和类型；注意 SQLite 无 LIKE，主键/索引不会复制到影子表）——
        if matches!(dst_config.conn_type, ConnType::Sqlite) {
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(&dst_config)?;
            let opts2 = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .busy_timeout(std::time::Duration::from_secs(30))
                .log_statements(log::LevelFilter::Off);
            let mut conn = opts2.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let dst_q = q_dq(&dst_table);
            let src_qq = if src_schema.is_empty() { q_dq(&src_table) } else { format!("{}.{}", q_dq(&src_schema), q_dq(&src_table)) };
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let n_cols = col_names.len();
            let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
            let same_conn = sel_cols.is_none() && src_id == dst_id;
            let mut migrated_rows: u64 = 0;
            let mut errors: Vec<String> = vec![];

            if strategy == "shadow" {
                let shadow = format!("{dst_table}__dbterm_shadow");
                validate_ident(&shadow)?;
                let shadow_q = q_dq(&shadow);
                let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {shadow_q}")).execute(&mut conn).await;
                if same_conn {
                    sqlx::query(&format!("CREATE TABLE {shadow_q} AS SELECT * FROM {src_qq} WHERE 0"))
                        .execute(&mut conn).await.map_err(|e| format!("创建影子表失败: {e}"))?;
                } else {
                    create_sqlite_table_mapped(&mut conn, &shadow_q, &col_names, &col_types, &src_config.conn_type).await?;
                }
                for chunk in all_rows.chunks(batch as usize) {
                    for row in chunk {
                        let sql = format!("INSERT INTO {shadow_q} ({col_list}) VALUES ({row_ph})");
                        let mut q = sqlx::query(&sql);
                        for v in row { q = q.bind(v.as_deref()); }
                        if let Err(e) = q.execute(&mut conn).await {
                            let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {shadow_q}")).execute(&mut conn).await;
                            return Err(format!("影子表写入失败: {e}"));
                        }
                        migrated_rows += 1;
                    }
                    emit_progress("migrating", total_rows, migrated_rows);
                }
                let mut swap_err: Option<String> = None;
                if let Err(e) = sqlx::query("BEGIN").execute(&mut conn).await { swap_err = Some(e.to_string()); }
                if swap_err.is_none() && target_exists {
                    if let Err(e) = sqlx::query(&format!("DROP TABLE {dst_q}")).execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if swap_err.is_none() {
                    if let Err(e) = sqlx::query(&format!("ALTER TABLE {shadow_q} RENAME TO {dst_q}")).execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if swap_err.is_none() {
                    if let Err(e) = sqlx::query("COMMIT").execute(&mut conn).await { swap_err = Some(e.to_string()); }
                }
                if let Some(e) = swap_err {
                    let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {shadow_q}")).execute(&mut conn).await;
                    return Err(format!("原子切换失败: {e}"));
                }
            } else {
                // 镜像同步
                if !target_exists {
                    if same_conn {
                        sqlx::query(&format!("CREATE TABLE {dst_q} AS SELECT * FROM {src_qq} WHERE 0"))
                            .execute(&mut conn).await.map_err(|e| format!("创建目标表失败: {e}"))?;
                    } else {
                        create_sqlite_table_mapped(&mut conn, &dst_q, &col_names, &col_types, &src_config.conn_type).await?;
                    }
                }
                let pk: Vec<String> = sqlx::query(&format!("PRAGMA table_info({dst_q})")).fetch_all(&mut conn).await.ok()
                    .map(|rs| {
                        let mut v: Vec<(i64, String)> = rs.iter().filter_map(|r| {
                            let o = r.try_get::<i64, _>("pk").ok()?;
                            if o > 0 { Some((o, r.try_get::<String, _>("name").ok()?)) } else { None }
                        }).collect();
                        v.sort_by_key(|(o, _)| *o);
                        v.into_iter().map(|(_, n)| n).collect()
                    }).unwrap_or_default();
                if pk.is_empty() { return Err("镜像同步要求目标表有主键（用于识别并删除源中已删除的行）".into()); }
                let pk_idx: Vec<usize> = match pk.iter().map(|p| col_names.iter().position(|c| c == p)).collect() {
                    Some(v) => v, None => return Err("镜像同步要求迁移列包含全部主键列".into()),
                };
                let pk_set: std::collections::HashSet<&String> = pk.iter().collect();
                let conflict_target = pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                let sets = col_names.iter().filter(|c| !pk_set.contains(*c))
                    .map(|c| { let qc = q_dq(c); format!("{qc}=excluded.{qc}") }).collect::<Vec<_>>().join(", ");
                let suffix = if sets.is_empty() { format!(" ON CONFLICT ({conflict_target}) DO NOTHING") }
                             else { format!(" ON CONFLICT ({conflict_target}) DO UPDATE SET {sets}") };
                for chunk in all_rows.chunks(batch as usize) {
                    for row in chunk {
                        let sql = format!("INSERT INTO {dst_q} ({col_list}) VALUES ({row_ph}){suffix}");
                        let mut q = sqlx::query(&sql);
                        for v in row { q = q.bind(v.as_deref()); }
                        if let Err(e) = q.execute(&mut conn).await { return Err(format!("镜像写入失败: {e}")); }
                        migrated_rows += 1;
                    }
                    emit_progress("migrating", total_rows, migrated_rows);
                }
                if all_rows.is_empty() {
                    if let Err(e) = sqlx::query(&format!("DELETE FROM {dst_q}")).execute(&mut conn).await { errors.push(format!("删除孤立行失败: {e}")); }
                } else {
                    let pk_cols_q = pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                    let tmp = "_dbterm_mirror_pk";
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                    if let Err(e) = sqlx::query(&format!("CREATE TEMP TABLE {tmp} AS SELECT {pk_cols_q} FROM {dst_q} WHERE 0")).execute(&mut conn).await {
                        errors.push(format!("创建主键临时表失败，跳过删除孤立行: {e}"));
                    } else {
                        let pk_ph = (0..pk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                        let mut ok = true;
                        for chunk in all_rows.chunks(batch as usize) {
                            for row in chunk {
                                let sql = format!("INSERT INTO {tmp} ({pk_cols_q}) VALUES ({pk_ph})");
                                let mut q = sqlx::query(&sql);
                                for &i in &pk_idx { q = q.bind(row[i].as_deref()); }
                                if let Err(e) = q.execute(&mut conn).await { errors.push(format!("收集源主键失败: {e}")); ok = false; break; }
                            }
                            if !ok { break; }
                        }
                        if ok {
                            // SQLite 子查询用表名限定外层列，避免依赖 DELETE 别名（旧版本不支持）
                            let on = pk.iter().map(|c| { let qc = q_dq(c); format!("t.{qc}={dst_q}.{qc}") }).collect::<Vec<_>>().join(" AND ");
                            let del = format!("DELETE FROM {dst_q} WHERE NOT EXISTS (SELECT 1 FROM {tmp} t WHERE {on})");
                            if let Err(e) = sqlx::query(&del).execute(&mut conn).await { errors.push(format!("删除孤立行失败: {e}")); }
                        }
                        let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                    }
                }
            }
            emit_progress("done", total_rows, migrated_rows);
            return Ok(MigrateResult { total_rows, migrated_rows, skipped_rows: 0, failed_rows: 0,
                elapsed_ms: start.elapsed().as_millis() as u64, errors });
        }

        // —— MySQL 系 ——
        if !matches!(dst_config.conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase) {
            return Err("「镜像同步 / 原子替换」仅支持 MySQL / PostgreSQL / SQLite 目标库".into());
        }
        let (mut conn, _t) = mysql_connect(&dst_config, dst_pwd.as_deref()).await?;
        let dst = if dst_schema.is_empty() { q_mysql(&dst_table) }
                  else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&dst_table)) };
        let src_q = if src_schema.is_empty() { q_mysql(&src_table) }
                    else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
        let col_list = col_names.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
        let n_cols = col_names.len();
        let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
        // MySQL 预处理参数上限 65535：每批行数按列数封顶，避免宽表报错
        let max_rows = if n_cols == 0 { batch as usize } else { ((65535 / n_cols).max(1)).min(batch as usize) };
        // 同服务器且未做列映射时用 CREATE TABLE LIKE 保留完整结构，否则按列建表
        let same_server = sel_cols.is_none() && (src_id == dst_id || src_config.host == dst_config.host);

        if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=0").execute(&mut conn).await; }
        let mut migrated_rows: u64 = 0;
        let mut errors: Vec<String> = vec![];

        if strategy == "shadow" {
            // 影子表：建临时表 → 灌数据 → RENAME 原子切换（近零停机，目标表切换前一直可用）
            let shadow = format!("{dst_table}__dbterm_shadow");
            validate_ident(&shadow)?;
            let shadow_q = if dst_schema.is_empty() { q_mysql(&shadow) }
                           else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&shadow)) };
            let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
            create_mysql_like_or_columns(&mut conn, &shadow_q, same_server, &src_q, &col_names, &col_types).await?;
            for chunk in all_rows.chunks(max_rows) {
                let all_ph = chunk.iter().map(|_| format!("({row_ph})")).collect::<Vec<_>>().join(", ");
                let sql = tag_sql(&format!("INSERT INTO {shadow_q} ({col_list}) VALUES {all_ph}"));
                let mut q = sqlx::query(&sql);
                for r in chunk { for v in r { q = q.bind(v.as_deref()); } }
                if let Err(e) = q.execute(&mut conn).await {
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
                    if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                    return Err(format!("影子表写入失败: {e}"));
                }
                migrated_rows += chunk.len() as u64;
                emit_progress("migrating", total_rows, migrated_rows);
            }
            // 原子切换：RENAME TABLE 对多表是原子操作
            let swap = if target_exists {
                let old = format!("{dst_table}__dbterm_old");
                validate_ident(&old)?;
                let old_q = if dst_schema.is_empty() { q_mysql(&old) }
                            else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&old)) };
                let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {old_q}"))).execute(&mut conn).await;
                sqlx::query(&tag_sql(&format!("RENAME TABLE {dst} TO {old_q}, {shadow_q} TO {dst}")))
                    .execute(&mut conn).await.map(|_| Some(old_q))
            } else {
                sqlx::query(&tag_sql(&format!("RENAME TABLE {shadow_q} TO {dst}")))
                    .execute(&mut conn).await.map(|_| None)
            };
            match swap {
                Ok(old_opt) => { if let Some(old_q) = old_opt {
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {old_q}"))).execute(&mut conn).await;
                }}
                Err(e) => {
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {shadow_q}"))).execute(&mut conn).await;
                    if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                    return Err(format!("原子切换失败: {e}"));
                }
            }
        } else {
            // 镜像同步：目标不存在则建表；按主键 UPSERT 写入；删除源中已不存在的行
            if !target_exists {
                create_mysql_like_or_columns(&mut conn, &dst, same_server, &src_q, &col_names, &col_types).await?;
            }
            let schema_q = if dst_schema.is_empty() { dst_config.database.clone().unwrap_or_default() } else { dst_schema.clone() };
            let pk: Vec<String> = sqlx::query(
                "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX"
            ).bind(&schema_q).bind(&dst_table).fetch_all(&mut conn).await.ok()
             .map(|rs| rs.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
             .unwrap_or_default();
            if pk.is_empty() {
                if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                return Err("镜像同步要求目标表有主键（用于识别并删除源中已删除的行）".into());
            }
            let pk_idx: Option<Vec<usize>> = pk.iter().map(|p| col_names.iter().position(|c| c == p)).collect();
            let pk_idx = match pk_idx {
                Some(v) => v,
                None => {
                    if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                    return Err("镜像同步要求迁移列包含全部主键列".into());
                }
            };
            // UPSERT 灌入全部源行
            let pk_set: std::collections::HashSet<&String> = pk.iter().collect();
            let sets = col_names.iter().filter(|c| !pk_set.contains(*c))
                .map(|c| { let qc = q_mysql(c); format!("{qc}=VALUES({qc})") }).collect::<Vec<_>>().join(", ");
            let dup = if sets.is_empty() { String::new() } else { format!(" ON DUPLICATE KEY UPDATE {sets}") };
            for chunk in all_rows.chunks(max_rows) {
                let all_ph = chunk.iter().map(|_| format!("({row_ph})")).collect::<Vec<_>>().join(", ");
                let sql = tag_sql(&format!("INSERT INTO {dst} ({col_list}) VALUES {all_ph}{dup}"));
                let mut q = sqlx::query(&sql);
                for r in chunk { for v in r { q = q.bind(v.as_deref()); } }
                if let Err(e) = q.execute(&mut conn).await {
                    if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                    return Err(format!("镜像写入失败: {e}"));
                }
                migrated_rows += chunk.len() as u64;
                emit_progress("migrating", total_rows, migrated_rows);
            }
            // 删除源中已不存在的行：用临时表收集源主键，再 LEFT JOIN 反查删除（避免超长 NOT IN / 参数上限）
            if all_rows.is_empty() {
                if let Err(e) = sqlx::query(&tag_sql(&format!("DELETE FROM {dst}"))).execute(&mut conn).await {
                    errors.push(format!("删除孤立行失败: {e}"));
                }
            } else {
                let pk_cols_q = pk.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
                let pk_ph = (0..pk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                let tmp = "_dbterm_mirror_pk";
                let _ = sqlx::query(&format!("DROP TEMPORARY TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                // CTAS 复制主键列的精确类型（WHERE 1=0 不取数据）
                if let Err(e) = sqlx::query(&tag_sql(&format!("CREATE TEMPORARY TABLE {tmp} AS SELECT {pk_cols_q} FROM {dst} WHERE 1=0")))
                    .execute(&mut conn).await {
                    errors.push(format!("创建主键临时表失败，跳过删除孤立行: {e}"));
                } else {
                    let _ = sqlx::query(&format!("ALTER TABLE {tmp} ADD INDEX idx_pk ({pk_cols_q})")).execute(&mut conn).await;
                    let max_pk_rows = ((65535 / pk.len()).max(1)).min(batch as usize);
                    let mut ok = true;
                    for chunk in all_rows.chunks(max_pk_rows) {
                        let all_ph = chunk.iter().map(|_| format!("({pk_ph})")).collect::<Vec<_>>().join(", ");
                        let sql = format!("INSERT INTO {tmp} ({pk_cols_q}) VALUES {all_ph}");
                        let mut q = sqlx::query(&sql);
                        for r in chunk { for &i in &pk_idx { q = q.bind(r[i].as_deref()); } }
                        if let Err(e) = q.execute(&mut conn).await { errors.push(format!("收集源主键失败: {e}")); ok = false; break; }
                    }
                    if ok {
                        let on = pk.iter().map(|c| { let qc = q_mysql(c); format!("d.{qc}=t.{qc}") }).collect::<Vec<_>>().join(" AND ");
                        let first_pk = q_mysql(&pk[0]);
                        let del = tag_sql(&format!("DELETE d FROM {dst} d LEFT JOIN {tmp} t ON {on} WHERE t.{first_pk} IS NULL"));
                        if let Err(e) = sqlx::query(&del).execute(&mut conn).await { errors.push(format!("删除孤立行失败: {e}")); }
                    }
                    let _ = sqlx::query(&format!("DROP TEMPORARY TABLE IF EXISTS {tmp}")).execute(&mut conn).await;
                }
            }
        }

        if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
        emit_progress("done", total_rows, migrated_rows);
        return Ok(MigrateResult {
            total_rows, migrated_rows, skipped_rows: 0, failed_rows: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, errors,
        });
    }

    // ── 3. 结构准备（DDL，非事务）────────────────────────────────────────────
    if do_structure && (strategy == "replace" || (strategy == "skip" && !target_exists)) {
        let backup_first = strategy == "replace" && target_exists;
        // 时间戳后缀防止并发任务备份表名冲突
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        match dst_config.conn_type {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                let (mut conn, _t) = mysql_connect(&dst_config, dst_pwd.as_deref()).await?;
                let dst = if dst_schema.is_empty() { q_mysql(&dst_table) }
                          else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&dst_table)) };
                if backup_first {
                    let bak = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = if dst_schema.is_empty() { q_mysql(&bak) }
                             else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&bak)) };
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                    sqlx::query(&tag_sql(&format!("RENAME TABLE {dst} TO {bq}")))
                        .execute(&mut conn).await.map_err(|e| format!("备份旧表失败: {e}"))?;
                    let create_r = if sel_cols.is_none() && (src_id == dst_id || src_config.host == dst_config.host) {
                        let src = if src_schema.is_empty() { q_mysql(&src_table) }
                                  else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
                        sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} LIKE {src}")))
                            .execute(&mut conn).await.map(|_| ()).map_err(|e| format!("创建目标表失败: {e}"))
                    } else if !col_types.is_empty() {
                        create_mysql_table_mapped(&mut conn, &dst, &col_names, &col_types).await
                    } else {
                        create_mysql_table_from_columns(&mut conn, &dst, &col_names).await
                    };
                    if let Err(e) = create_r {
                        let _ = sqlx::query(&tag_sql(&format!("RENAME TABLE {bq} TO {dst}"))).execute(&mut conn).await;
                        return Err(e);
                    }
                    // 成功后清理备份（流式迁移成功后的备份清理在 drive_stream 之后；此处非流式暂在结构准备后立即清理不合适——数据写入还没开始）
                    // bq 留到数据写入成功后由调用方清理；此处仅在建表失败时还原，建表成功后继续走数据写入。
                    // 数据写入失败无法自动还原（非流式路径不支持备份追踪），bq 残留为安全边界。
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                } else {
                    if sel_cols.is_none() && (src_id == dst_id || src_config.host == dst_config.host) {
                        let src = if src_schema.is_empty() { q_mysql(&src_table) }
                                  else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
                        sqlx::query(&tag_sql(&format!("CREATE TABLE {dst} LIKE {src}")))
                            .execute(&mut conn).await.map_err(|e| format!("创建目标表失败: {e}"))?;
                    } else if !col_types.is_empty() {
                        create_mysql_table_mapped(&mut conn, &dst, &col_names, &col_types).await?;
                    } else {
                        create_mysql_table_from_columns(&mut conn, &dst, &col_names).await?;
                    }
                }
            }
            ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                let (mut conn, _t) = pg_connect(&dst_config, dst_pwd.as_deref()).await?;
                let ds = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.clone() };
                let dst = format!("{}.{}", q_dq(&ds), q_dq(&dst_table));
                if backup_first {
                    let bak = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = format!("{}.{}", q_dq(&ds), q_dq(&bak));
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                    sqlx::query(&tag_sql(&format!("ALTER TABLE {dst} RENAME TO {}", q_dq(&bak))))
                        .execute(&mut conn).await.map_err(|e| format!("备份旧表失败: {e}"))?;
                    if let Err(e) = create_pg_table_mapped(&mut conn, &dst, &col_names, &col_types).await {
                        let _ = sqlx::query(&tag_sql(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(&dst_table)))).execute(&mut conn).await;
                        return Err(e);
                    }
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                } else {
                    create_pg_table_mapped(&mut conn, &dst, &col_names, &col_types).await?;
                }
            }
            ConnType::Sqlite => {
                use crate::commands::query::sqlite_url;
                use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
                use std::str::FromStr;
                let url = sqlite_url(&dst_config)?;
                let opts2 = SqliteConnectOptions::from_str(&url)
                    .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                    .busy_timeout(std::time::Duration::from_secs(10))
                    .log_statements(log::LevelFilter::Off);
                let mut conn = opts2.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
                let dst_q = q_dq(&dst_table);
                if backup_first {
                    let bak = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = q_dq(&bak);
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut conn).await;
                    sqlx::query(&format!("ALTER TABLE {dst_q} RENAME TO {}", q_dq(&bak)))
                        .execute(&mut conn).await.map_err(|e| format!("备份旧表失败: {e}"))?;
                    if let Err(e) = create_sqlite_table_mapped(&mut conn, &dst_q, &col_names, &col_types, &src_config.conn_type).await {
                        let _ = sqlx::query(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(&dst_table))).execute(&mut conn).await;
                        return Err(e);
                    }
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut conn).await;
                } else {
                    create_sqlite_table_mapped(&mut conn, &dst_q, &col_names, &col_types, &src_config.conn_type).await?;
                }
            }
            ConnType::Duckdb => {
                // DD1.5 DuckDB 建表：映射列类型，DuckDB 支持标准 SQL 类型
                let dst_q = format!("\"{}\"", dst_table.replace('"', "\"\""));
                // DuckDB 支持 ALTER TABLE RENAME TO，replace 策略先备份再建表
                let duck_bak_q: Option<String> = if backup_first {
                    let bak = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = format!("\"{}\"", bak.replace('"', "\"\""));
                    let _ = dispatch_duck_query(&dst_id, &dst_config,
                        &format!("DROP TABLE IF EXISTS {bq}"), &duck_pool, &registry).await;
                    dispatch_duck_query(&dst_id, &dst_config,
                        &format!("ALTER TABLE {dst_q} RENAME TO {bq}"), &duck_pool, &registry).await
                        .map_err(|e| format!("备份旧表失败: {e}"))?;
                    Some(bq)
                } else { None };
                // 列类型映射：从源类型推断 DuckDB 类型
                let duckdb_cols: Vec<String> = col_names.iter().enumerate().map(|(i, name)| {
                    let qn = format!("\"{}\"", name.replace('"', "\"\""));
                    let t = col_types.get(i).map(|s| s.to_uppercase()).unwrap_or_default();
                    let duck_type = if t.contains("INT") { "BIGINT" }
                        else if t.contains("FLOAT") || t.contains("DOUBLE") || t.contains("REAL") { "DOUBLE" }
                        else if t.contains("DECIMAL") || t.contains("NUMERIC") { "DECIMAL" }
                        else if t.contains("BOOL") { "BOOLEAN" }
                        else if t.contains("DATE") && !t.contains("TIME") { "DATE" }
                        else if t.contains("TIMESTAMP") || t.contains("DATETIME") { "TIMESTAMP" }
                        else if t.contains("BLOB") || t.contains("BINARY") { "BLOB" }
                        else { "VARCHAR" };
                    format!("{qn} {duck_type}")
                }).collect();
                let create_sql = format!("CREATE TABLE {dst_q} ({})", duckdb_cols.join(", "));
                if let Err(e) = dispatch_duck_query(&dst_id, &dst_config, &create_sql, &duck_pool, &registry).await {
                    // 建表失败 → 还原备份
                    if let Some(ref bq) = duck_bak_q {
                        let _ = dispatch_duck_query(&dst_id, &dst_config,
                            &format!("ALTER TABLE {bq} RENAME TO {dst_q}"), &duck_pool, &registry).await;
                    }
                    return Err(format!("创建 DuckDB 目标表失败: {e}"));
                }
                // 建表成功后清理备份
                if let Some(ref bq) = duck_bak_q {
                    let _ = dispatch_duck_query(&dst_id, &dst_config,
                        &format!("DROP TABLE IF EXISTS {bq}"), &duck_pool, &registry).await;
                }
            }
            _ => return Err("目标连接类型不支持迁移".into()),
        }
    }

    // 仅结构：到此结束，不写数据
    if !do_data {
        emit_progress("done", total_rows, 0);
        return Ok(MigrateResult {
            total_rows: 0, migrated_rows: 0, skipped_rows: 0, failed_rows: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, errors: vec![],
        });
    }

    // ── 4. 写入数据（可选事务 / 外键禁用 / 冲突处理 / 容错）──────────────────────
    let mut migrated_rows: u64 = 0;
    let mut failed_rows:   u64 = 0;
    let mut errors: Vec<String> = vec![];
    let n_cols = col_names.len();
    let skip_errors = error_mode == "skip";

    match dst_config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&dst_config, dst_pwd.as_deref()).await?;
            let dst = if dst_schema.is_empty() { q_mysql(&dst_table) }
                      else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&dst_table)) };
            let col_list = col_names.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
            let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
            let verb = if conflict == "ignore" { "INSERT IGNORE INTO" } else { "INSERT INTO" };
            let dup = if conflict == "upsert" {
                let sets = col_names.iter().map(|c| { let qc = q_mysql(c); format!("{qc}=VALUES({qc})") })
                    .collect::<Vec<_>>().join(", ");
                format!(" ON DUPLICATE KEY UPDATE {sets}")
            } else { String::new() };

            if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=0").execute(&mut conn).await; }
            if use_tx { sqlx::query("START TRANSACTION").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            if clear_before_insert {
                if let Err(e) = sqlx::query(&tag_sql(&format!("TRUNCATE TABLE {dst}"))).execute(&mut conn).await {
                    if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                    if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                    return Err(format!("清空目标表失败: {e}"));
                }
            }

            if skip_errors {
                for row in &all_rows {
                    let sql = tag_sql(&format!("{verb} {dst} ({col_list}) VALUES ({row_ph}){dup}"));
                    let mut q = sqlx::query(&sql);
                    for val in row { q = q.bind(val.as_deref()); }
                    match q.execute(&mut conn).await {
                        Ok(_)  => migrated_rows += 1,
                        Err(e) => { failed_rows += 1; if errors.len() < 50 { errors.push(format!("行写入失败: {e}")); } }
                    }
                    if (migrated_rows + failed_rows) % batch == 0 { emit_progress("migrating", total_rows, migrated_rows); }
                }
            } else {
                for chunk in all_rows.chunks(batch as usize) {
                    let all_ph = chunk.iter().map(|_| format!("({row_ph})")).collect::<Vec<_>>().join(", ");
                    let sql = tag_sql(&format!("{verb} {dst} ({col_list}) VALUES {all_ph}{dup}"));
                    let mut q = sqlx::query(&sql);
                    for row in chunk { for val in row { q = q.bind(val.as_deref()); } }
                    if let Err(e) = q.execute(&mut conn).await {
                        if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                        if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
                        return Err(format!("批量写入失败: {e}"));
                    }
                    migrated_rows += chunk.len() as u64;
                    emit_progress("migrating", total_rows, migrated_rows);
                }
            }

            if use_tx { sqlx::query("COMMIT").execute(&mut conn).await.map_err(|e| format!("提交事务失败: {e}"))?; }
            if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut conn).await; }
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&dst_config, dst_pwd.as_deref()).await?;
            let ds = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.clone() };
            let dst = format!("{}.{}", q_dq(&ds), q_dq(&dst_table));
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            // upsert 需要主键作为冲突目标
            let suffix = match conflict.as_str() {
                "ignore" => " ON CONFLICT DO NOTHING".to_string(),
                "upsert" => {
                    let pk: Vec<String> = sqlx::query(
                        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                         JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema \
                         WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=$1 AND tc.table_name=$2"
                    ).bind(&ds).bind(&dst_table).fetch_all(&mut conn).await.ok()
                     .map(|rs| rs.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect())
                     .unwrap_or_default();
                    if pk.is_empty() {
                        errors.push("目标表无主键，UPSERT 退化为忽略冲突".into());
                        " ON CONFLICT DO NOTHING".to_string()
                    } else {
                        let pk_set: std::collections::HashSet<&String> = pk.iter().collect();
                        let target = pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                        let sets = col_names.iter().filter(|c| !pk_set.contains(*c))
                            .map(|c| { let qc = q_dq(c); format!("{qc}=EXCLUDED.{qc}") })
                            .collect::<Vec<_>>().join(", ");
                        if sets.is_empty() { format!(" ON CONFLICT ({target}) DO NOTHING") }
                        else { format!(" ON CONFLICT ({target}) DO UPDATE SET {sets}") }
                    }
                }
                _ => String::new(),
            };

            if use_tx { sqlx::query("BEGIN").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            if clear_before_insert {
                if let Err(e) = sqlx::query(&tag_sql(&format!("TRUNCATE TABLE {dst}"))).execute(&mut conn).await {
                    if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                    return Err(format!("清空目标表失败: {e}"));
                }
            }

            for chunk in all_rows.chunks(batch as usize) {
                for row in chunk {
                    let placeholders = (1..=n_cols).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                    let sql = tag_sql(&format!("INSERT INTO {dst} ({col_list}) VALUES ({placeholders}){suffix}"));
                    let mut q = sqlx::query(&sql);
                    for val in row { q = q.bind(val.as_deref()); }
                    match q.execute(&mut conn).await {
                        Ok(_)  => migrated_rows += 1,
                        Err(e) => {
                            if skip_errors {
                                // PG 事务出错后需回滚到 savepoint，简化处理：非事务模式下跳过
                                failed_rows += 1;
                                if errors.len() < 50 { errors.push(format!("行写入失败: {e}")); }
                                if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; return Err(format!("事务内写入失败（请关闭事务以启用跳过）: {e}")); }
                            } else {
                                if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                                return Err(format!("写入失败: {e}"));
                            }
                        }
                    }
                }
                emit_progress("migrating", total_rows, migrated_rows);
            }

            if use_tx { sqlx::query("COMMIT").execute(&mut conn).await.map_err(|e| format!("提交事务失败: {e}"))?; }
        }
        ConnType::Sqlite => {
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(&dst_config)?;
            let opts2 = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .busy_timeout(std::time::Duration::from_secs(30))
                .log_statements(log::LevelFilter::Off);
            let mut conn = opts2.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let dst_q = q_dq(&dst_table);
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let row_ph = (0..n_cols).map(|_| "?").collect::<Vec<_>>().join(", ");
            let verb = match conflict.as_str() {
                "ignore" => "INSERT OR IGNORE INTO",
                "upsert" => "INSERT OR REPLACE INTO",
                _ => "INSERT INTO",
            };

            if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut conn).await; }
            if use_tx { sqlx::query("BEGIN").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            if clear_before_insert {
                if let Err(e) = sqlx::query(&format!("DELETE FROM {dst_q}")).execute(&mut conn).await {
                    if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                    if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=ON").execute(&mut conn).await; }
                    return Err(format!("清空目标表失败: {e}"));
                }
            }

            for chunk in all_rows.chunks(batch as usize) {
                for row in chunk {
                    let sql = format!("{verb} {dst_q} ({col_list}) VALUES ({row_ph})");
                    let mut q = sqlx::query(&sql);
                    for val in row { q = q.bind(val.as_deref()); }
                    match q.execute(&mut conn).await {
                        Ok(_)  => migrated_rows += 1,
                        Err(e) => {
                            if skip_errors && !use_tx {
                                failed_rows += 1;
                                if errors.len() < 50 { errors.push(format!("行写入失败: {e}")); }
                            } else {
                                if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut conn).await; }
                                if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=ON").execute(&mut conn).await; }
                                return Err(format!("SQLite 写入失败: {e}"));
                            }
                        }
                    }
                }
                emit_progress("migrating", total_rows, migrated_rows);
            }

            if use_tx { sqlx::query("COMMIT").execute(&mut conn).await.map_err(|e| format!("提交事务失败: {e}"))?; }
            if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=ON").execute(&mut conn).await; }
        }
        ConnType::Duckdb => {
            // DD1.5 DuckDB 作为迁移目标（使用 dispatch_duck_query，INSERT VALUES 语句）
            let dst_q = format!("\"{}\"", dst_table.replace('"', "\"\""));
            let col_list = col_names.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(", ");

            if use_tx {
                dispatch_duck_query(&dst_id, &dst_config, "BEGIN", &duck_pool, &registry)
                    .await.map_err(|e| format!("DuckDB 开启事务失败: {e}"))?;
            }
            if clear_before_insert {
                dispatch_duck_query(&dst_id, &dst_config, &format!("DELETE FROM {dst_q}"), &duck_pool, &registry)
                    .await.map_err(|e| format!("清空 DuckDB 目标表失败: {e}"))?;
            }

            for chunk in all_rows.chunks(batch as usize) {
                // DuckDB 不支持参数绑定，构造字面值 SQL
                let rows_sql: Vec<String> = chunk.iter().map(|row| {
                    let vals = row.iter().map(|v| match v {
                        None => "NULL".to_string(),
                        Some(s) => format!("'{}'", s.replace('\'', "''")),
                    }).collect::<Vec<_>>().join(", ");
                    format!("({vals})")
                }).collect();
                let insert_sql = format!("INSERT INTO {dst_q} ({col_list}) VALUES {}", rows_sql.join(", "));
                match dispatch_duck_query(&dst_id, &dst_config, &insert_sql, &duck_pool, &registry).await {
                    Ok(r) => migrated_rows += r.rows_affected,
                    Err(e) => {
                        if skip_errors {
                            failed_rows += chunk.len() as u64;
                            if errors.len() < 50 { errors.push(format!("批量写入失败: {e}")); }
                        } else {
                            if use_tx {
                                let _ = dispatch_duck_query(&dst_id, &dst_config, "ROLLBACK", &duck_pool, &registry).await;
                            }
                            return Err(format!("DuckDB 写入失败: {e}"));
                        }
                    }
                }
                emit_progress("migrating", total_rows, migrated_rows);
            }

            if use_tx {
                dispatch_duck_query(&dst_id, &dst_config, "COMMIT", &duck_pool, &registry)
                    .await.map_err(|e| format!("DuckDB 提交事务失败: {e}"))?;
            }
        }
        _ => return Err("目标连接类型不支持迁移".into()),
    }

    emit_progress("done", total_rows, migrated_rows);
    Ok(MigrateResult {
        total_rows,
        migrated_rows,
        skipped_rows: 0,
        failed_rows,
        elapsed_ms: start.elapsed().as_millis() as u64,
        errors,
    })
}

// ── S3.3 跨引擎迁移辅助 ─────────────────────────────────────────────────────

fn sqlite_row_to_strings(row: &sqlx::sqlite::SqliteRow) -> Vec<Option<String>> {
    use sqlx::Row;
    let n = row.columns().len();
    (0..n).map(|i| {
        if let Ok(v) = row.try_get::<Option<String>, _>(i) { return v; }
        if let Ok(v) = row.try_get::<Option<i64>, _>(i) { return v.map(|n| n.to_string()); }
        if let Ok(v) = row.try_get::<Option<f64>, _>(i) { return v.map(|n| n.to_string()); }
        if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            // 0x 前缀与其他函数保持一致，sql_escape_value 依赖此前缀识别 hex 字面量
            return v.map(|b| format!("0x{}", hex::encode(b)));
        }
        None
    }).collect()
}

fn map_sqlite_type(mysql_type: &str) -> &'static str {
    let upper = mysql_type.to_uppercase();
    let base = upper.split('(').next().unwrap_or("").trim();
    match base {
        "INT" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "BIGINT" |
        "INT2" | "INT4" | "INT8" | "INTEGER" | "BOOLEAN" | "BOOL" => "INTEGER",
        "FLOAT" | "DOUBLE" | "FLOAT4" | "FLOAT8" | "REAL" | "DOUBLE PRECISION" => "REAL",
        "DECIMAL" | "NUMERIC" => "NUMERIC",
        "BYTEA" | "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => "BLOB",
        _ => "TEXT",
    }
}

/// 拆出类型的基名(大写)与括号内参数，如 "varchar(255)" → ("VARCHAR", Some("255"))
fn base_and_len(raw: &str) -> (String, Option<String>) {
    let s = raw.trim();
    match (s.find('('), s.rfind(')')) {
        (Some(a), Some(b)) if b > a => (s[..a].trim().to_uppercase(), Some(s[a + 1..b].trim().to_string())),
        _ => (s.to_uppercase(), None),
    }
}

/// 任意方言源类型 → MySQL 类型（跨方言迁移建表用，尽量保留长度/精度）
fn to_mysql_type(raw: &str) -> String {
    let (base, len) = base_and_len(raw);
    match base.as_str() {
        "VARCHAR" | "CHARACTER VARYING" | "VARCHAR2" | "NVARCHAR" | "NVARCHAR2" =>
            format!("VARCHAR({})", len.unwrap_or_else(|| "255".into())),
        "CHAR" | "CHARACTER" | "NCHAR" | "BPCHAR" =>
            format!("CHAR({})", len.unwrap_or_else(|| "1".into())),
        "TEXT" | "CLOB" | "NCLOB" | "NTEXT" | "LONGTEXT" | "MEDIUMTEXT" | "TINYTEXT" | "STRING" | "FIXEDSTRING" => "LONGTEXT".into(),
        "TINYINT" => "TINYINT".into(),
        "SMALLINT" | "INT2" => "SMALLINT".into(),
        "MEDIUMINT" => "MEDIUMINT".into(),
        "INT" | "INTEGER" | "INT4" | "SERIAL" => "INT".into(),
        "BIGINT" | "INT8" | "BIGSERIAL" => "BIGINT".into(),
        "DECIMAL" | "NUMERIC" | "NUMBER" => match len { Some(a) => format!("DECIMAL({a})"), None => "DECIMAL(38,10)".into() },
        "REAL" | "FLOAT" | "FLOAT4" | "BINARY_FLOAT" => "FLOAT".into(),
        "DOUBLE" | "DOUBLE PRECISION" | "FLOAT8" | "BINARY_DOUBLE" => "DOUBLE".into(),
        "BOOL" | "BOOLEAN" | "BIT" => "TINYINT(1)".into(),
        "DATE" => "DATE".into(),
        "TIME" => "TIME".into(),
        "TIMESTAMP" | "TIMESTAMPTZ" | "DATETIME" | "DATETIME2" | "SMALLDATETIME" | "DATETIMEOFFSET"
        | "TIMESTAMP WITHOUT TIME ZONE" | "TIMESTAMP WITH TIME ZONE" => "DATETIME".into(),
        "BLOB" | "BYTEA" | "BINARY" | "VARBINARY" | "IMAGE" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "RAW" => "LONGBLOB".into(),
        "JSON" | "JSONB" => "JSON".into(),
        "UUID" | "UNIQUEIDENTIFIER" => "CHAR(36)".into(),
        _ => "LONGTEXT".into(),
    }
}

/// 任意方言源类型 → PostgreSQL 类型
fn to_pg_type(raw: &str) -> String {
    let (base, len) = base_and_len(raw);
    match base.as_str() {
        "VARCHAR" | "CHARACTER VARYING" | "VARCHAR2" | "NVARCHAR" | "NVARCHAR2" =>
            format!("VARCHAR({})", len.unwrap_or_else(|| "255".into())),
        "CHAR" | "CHARACTER" | "NCHAR" | "BPCHAR" =>
            format!("CHAR({})", len.unwrap_or_else(|| "1".into())),
        "TEXT" | "CLOB" | "NCLOB" | "NTEXT" | "LONGTEXT" | "MEDIUMTEXT" | "TINYTEXT" | "STRING" | "FIXEDSTRING" => "TEXT".into(),
        "TINYINT" | "SMALLINT" | "INT2" => "SMALLINT".into(),
        "MEDIUMINT" | "INT" | "INTEGER" | "INT4" => "INTEGER".into(),
        "BIGINT" | "INT8" => "BIGINT".into(),
        "DECIMAL" | "NUMERIC" | "NUMBER" => match len { Some(a) => format!("NUMERIC({a})"), None => "NUMERIC(38,10)".into() },
        "REAL" | "FLOAT" | "FLOAT4" | "BINARY_FLOAT" => "REAL".into(),
        "DOUBLE" | "DOUBLE PRECISION" | "FLOAT8" | "BINARY_DOUBLE" => "DOUBLE PRECISION".into(),
        "BOOL" | "BOOLEAN" | "BIT" => "BOOLEAN".into(),
        "DATE" => "DATE".into(),
        "TIME" => "TIME".into(),
        "TIMESTAMP" | "TIMESTAMPTZ" | "DATETIME" | "DATETIME2" | "SMALLDATETIME" | "DATETIMEOFFSET"
        | "TIMESTAMP WITHOUT TIME ZONE" | "TIMESTAMP WITH TIME ZONE" => "TIMESTAMP".into(),
        "BLOB" | "BYTEA" | "BINARY" | "VARBINARY" | "IMAGE" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "RAW" => "BYTEA".into(),
        "JSONB" => "JSONB".into(),
        "JSON" => "JSON".into(),
        "UUID" | "UNIQUEIDENTIFIER" => "UUID".into(),
        _ => "TEXT".into(),
    }
}

async fn create_sqlite_table_mapped(
    conn: &mut sqlx::sqlite::SqliteConnection,
    tbl: &str,
    col_names: &[String],
    col_types: &[String],
    src_type: &ConnType,
) -> Result<(), String> {
    let cols: Vec<String> = col_names.iter().enumerate().map(|(i, name)| {
        let raw_type = col_types.get(i).map(|s| s.as_str()).unwrap_or("");
        let sqlite_type = match src_type {
            ConnType::Sqlite => if raw_type.is_empty() { "TEXT" } else { raw_type },
            _ => map_sqlite_type(raw_type),
        };
        format!("  {} {}", q_dq(name), sqlite_type)
    }).collect();
    let sql = format!("CREATE TABLE {} (\n{}\n)", tbl, cols.join(",\n"));
    sqlx::query(&sql).execute(conn).await
        .map_err(|e| format!("创建 SQLite 目标表失败: {e}"))?;
    Ok(())
}

async fn create_mysql_table_mapped(
    conn: &mut sqlx::mysql::MySqlConnection,
    tbl: &str,
    col_names: &[String],
    col_types: &[String],
) -> Result<(), String> {
    let cols: Vec<String> = col_names.iter().enumerate().map(|(i, name)| {
        let raw_type = col_types.get(i).map(|s| s.as_str()).unwrap_or("");
        let mysql_type = if raw_type.is_empty() { "LONGTEXT".to_string() } else { to_mysql_type(raw_type) };
        format!("  {} {}", q_mysql(name), mysql_type)
    }).collect();
    let sql = tag_sql(&format!("CREATE TABLE {} (\n{}\n)", tbl, cols.join(",\n")));
    sqlx::query(&sql).execute(conn).await
        .map_err(|e| format!("创建 MySQL 目标表失败: {e}"))?;
    Ok(())
}

/// 跨方言迁移：按源列类型映射建 PG 表（col_types 为空时退化为 TEXT）
async fn create_pg_table_mapped(
    conn: &mut sqlx::postgres::PgConnection,
    dst: &str,
    col_names: &[String],
    col_types: &[String],
) -> Result<(), String> {
    let cols: Vec<String> = col_names.iter().enumerate().map(|(i, name)| {
        let raw_type = col_types.get(i).map(|s| s.as_str()).unwrap_or("");
        let pg_type = if raw_type.is_empty() { "TEXT".to_string() } else { to_pg_type(raw_type) };
        format!("  {} {}", q_dq(name), pg_type)
    }).collect();
    let sql = tag_sql(&format!("CREATE TABLE {} (\n{}\n)", dst, cols.join(",\n")));
    sqlx::query(&sql).execute(conn).await
        .map_err(|e| format!("创建 PG 目标表失败: {e}"))?;
    Ok(())
}

// ── 流式迁移基础设施（MySQL / PostgreSQL / SQLite）────────────────────────────────
fn is_sql_engine(t: &ConnType) -> bool {
    matches!(t, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase
        | ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss | ConnType::Sqlite)
}

/// 流式写入的目标连接（按方言分派）
/// field 1 的 Arc<DbTunnel> 不被直接读取，但必须持有以保持 SSH 隧道存活（Drop 守卫）
#[allow(dead_code)]
enum StreamDst {
    My(sqlx::mysql::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>),
    Pg(sqlx::postgres::PgConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>),
    Lite(sqlx::sqlite::SqliteConnection),
}

struct DstSetup {
    dst: StreamDst,
    dst_q: String,           // 目标表（含 schema、按方言引用）
    pg_pk: Vec<String>,      // 仅 PG upsert 用
    /// replace 策略下备份旧表的引用名；drive_stream 成功后 DROP，失败后 RENAME 回原表
    bak_q: Option<String>,
    orig_q: Option<String>,  // bak_q 对应的原始表名（用于失败后恢复）
}

/// 建立流式写入目标：连接 + 存在性/策略校验 + DDL + 事务/清空。
/// 返回 None 表示「跳过策略且目标已存在」，调用方按整表跳过处理。
#[allow(clippy::too_many_arguments)]
/// MySQL 8.0 的 `_0900_` 系列 collation（基于 Unicode 9.0.0）在 MySQL 5.7 / MariaDB 上不存在；
/// 降级到最接近的通用兼容版本，防止跨版本迁移时 DDL 建表失败（1273 Unknown collation）。
fn compat_mysql_collation(s: &str) -> String {
    const MAP: &[(&str, &str)] = &[
        ("utf8mb4_0900_ai_ci",  "utf8mb4_unicode_ci"),
        ("utf8mb4_0900_ai_cs",  "utf8mb4_unicode_ci"),
        ("utf8mb4_0900_as_ci",  "utf8mb4_unicode_ci"),
        ("utf8mb4_0900_as_cs",  "utf8mb4_bin"),
        ("utf8mb4_0900_bin",    "utf8mb4_bin"),
        ("utf8_0900_ai_ci",     "utf8_unicode_ci"),
        ("utf8_0900_ai_cs",     "utf8_unicode_ci"),
        ("utf8_0900_as_ci",     "utf8_unicode_ci"),
        ("utf8_0900_as_cs",     "utf8_bin"),
        ("utf8_0900_bin",       "utf8_bin"),
        // MySQL 8.4 引入的新 uca1400 系列（MariaDB 暂不支持）
        ("utf8mb4_uca1400_ai_ci", "utf8mb4_unicode_ci"),
        ("utf8mb4_uca1400_as_cs", "utf8mb4_bin"),
    ];
    let mut out = s.to_string();
    for (from, to) in MAP { out = out.replace(from, to); }
    out
}

/// 把源端 SHOW CREATE TABLE 的输出改名到目标表，并剥掉外键约束。
/// - 保留：列类型、主键、索引、AUTO_INCREMENT、ENGINE/字符集等
/// - 剥外键：与「覆盖重建丢失外键」既有约定一致，且避免目标库依赖顺序导致建表失败
/// - 降级 collation：MySQL 8.0 的 _0900_ 系列在 MySQL 5.7 / MariaDB 上不支持，自动替换
fn mysql_apply_ddl(raw: &str, dst_q: &str) -> String {
    let mut def_lines: Vec<String> = Vec::new();
    let mut footer: Option<String> = None;
    for line in raw.lines().skip(1) {  // 跳过首行 `CREATE TABLE \`name\` (`
        let t = line.trim_start();
        if t.starts_with(')') { footer = Some(compat_mysql_collation(line)); break; }
        if t.starts_with("CONSTRAINT") && t.contains("FOREIGN KEY") { continue; }
        if t.starts_with("FOREIGN KEY") { continue; }
        def_lines.push(compat_mysql_collation(line.trim_end()));
    }
    // 剥外键后最后一行定义可能悬空逗号，去掉
    if let Some(last) = def_lines.last_mut() {
        if last.ends_with(',') { last.pop(); }
    }
    let footer = footer.unwrap_or_else(|| ")".to_string());
    format!("CREATE TABLE {dst_q} (\n{}\n{}", def_lines.join("\n"), footer)
}

async fn open_stream_dst(
    dst_config: &ConnConfig, dst_pwd: Option<&str>,
    dst_schema: &str, dst_table: &str,
    strategy: &str, do_structure: bool, clear_before_insert: bool,
    disable_fk: bool, use_tx: bool,
    col_names: &[String], col_types: &[String],
    can_like: bool, src_like_q: &str, src_type: &ConnType,
    native_ddl: Option<&str>,
) -> Result<Option<DstSetup>, String> {
    let truncate_needs_exist = |exists: bool| (strategy == "truncate" || (strategy == "append" && !do_structure)) && !exists;
    let need_ddl = |exists: bool| do_structure && (strategy == "replace" || (strategy == "skip" && !exists));
    match dst_config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, g) = mysql_connect(dst_config, dst_pwd).await?;
            let dst_q = if dst_schema.is_empty() { q_mysql(dst_table) } else { format!("{}.{}", q_mysql(dst_schema), q_mysql(dst_table)) };
            // 用 INFORMATION_SCHEMA 判断目标表是否存在（避免 SELECT 权限不足时误判）
            let sch = if dst_schema.is_empty() { "DATABASE()".to_string() } else { format!("'{}'", dst_schema.replace('\'', "\\'")) };
            let exists_sql = format!(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA={sch} AND TABLE_NAME='{}'",
                dst_table.replace('\'', "\\'")
            );
            let exists: bool = sqlx::query_scalar::<_, i64>(&exists_sql).fetch_one(&mut conn).await.unwrap_or(0) > 0;
            if strategy == "skip" && exists { return Ok(None); }
            if truncate_needs_exist(exists) { return Err(format!("目标表不存在，{}策略要求目标表已存在", if strategy == "truncate" { "截断" } else { "追加" })); }
            // replace 策略：先把旧表 RENAME 为备份，建新表失败时自动恢复，避免旧数据丢失
            let mut bak_q: Option<String> = None;
            if need_ddl(exists) {
                if strategy == "replace" && exists {
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
                    let bak_name = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = if dst_schema.is_empty() { q_mysql(&bak_name) } else { format!("{}.{}", q_mysql(dst_schema), q_mysql(&bak_name)) };
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                    sqlx::query(&tag_sql(&format!("RENAME TABLE {dst_q} TO {bq}"))).execute(&mut conn).await
                        .map_err(|e| format!("备份旧表失败（可能权限不足 RENAME）: {e}"))?;
                    bak_q = Some(bq);
                } else if strategy == "replace" {
                    // 目标表不存在，无需备份，也无需 DROP
                }
                // CREATE TABLE ... LIKE 需要 SELECT 权限；失败时降级到 DDL/列定义方式
                let mut create_ok = false;
                if can_like {
                    create_ok = sqlx::query(&tag_sql(&format!("CREATE TABLE {dst_q} LIKE {src_like_q}"))).execute(&mut conn).await.is_ok();
                }
                if !create_ok {
                    let r = if let Some(raw) = native_ddl {
                        sqlx::query(&tag_sql(&mysql_apply_ddl(raw, &dst_q))).execute(&mut conn).await
                            .map(|_| ()).map_err(|e| format!("创建目标表失败: {e}"))
                    } else if !col_types.is_empty() {
                        create_mysql_table_mapped(&mut conn, &dst_q, col_names, col_types).await
                    } else {
                        create_mysql_table_from_columns(&mut conn, &dst_q, col_names).await
                    };
                    if let Err(e) = r {
                        // 建表失败 → 把备份 RENAME 回原表，确保旧数据不丢
                        if let Some(ref bq) = bak_q {
                            let _ = sqlx::query(&tag_sql(&format!("RENAME TABLE {bq} TO {dst_q}"))).execute(&mut conn).await;
                        }
                        return Err(e);
                    }
                }
            }
            if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=0").execute(&mut conn).await; }
            if use_tx { sqlx::query("START TRANSACTION").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            // MySQL TRUNCATE 是 DDL，会隐式提交事务无法回滚；事务模式改用 DELETE FROM（可回滚）
            if clear_before_insert {
                let clear_sql = if use_tx { format!("DELETE FROM {dst_q}") } else { format!("TRUNCATE TABLE {dst_q}") };
                sqlx::query(&tag_sql(&clear_sql)).execute(&mut conn).await.map_err(|e| format!("清空目标表失败: {e}"))?;
            }
            Ok(Some(DstSetup { dst: StreamDst::My(conn, g), dst_q: dst_q.clone(), pg_pk: vec![], bak_q, orig_q: Some(dst_q) }))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, g) = pg_connect(dst_config, dst_pwd).await?;
            let ds = if dst_schema.is_empty() { "public".to_string() } else { dst_schema.to_string() };
            let dst_q = format!("{}.{}", q_dq(&ds), q_dq(dst_table));
            // 用 information_schema 判断存在，避免 SELECT 权限不足时误判
            let exists: bool = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2"
            ).bind(&ds).bind(dst_table).fetch_one(&mut conn).await.unwrap_or(0) > 0;
            if strategy == "skip" && exists { return Ok(None); }
            if truncate_needs_exist(exists) { return Err(format!("目标表不存在，{}策略要求目标表已存在", if strategy == "truncate" { "截断" } else { "追加" })); }
            // PG replace：先 ALTER TABLE RENAME 备份，建表失败则还原
            let mut pg_bak_q: Option<String> = None;
            if need_ddl(exists) {
                if strategy == "replace" && exists {
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
                    let bak_name = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = format!("{}.{}", q_dq(&ds), q_dq(&bak_name));
                    let _ = sqlx::query(&tag_sql(&format!("DROP TABLE IF EXISTS {bq}"))).execute(&mut conn).await;
                    sqlx::query(&tag_sql(&format!("ALTER TABLE {dst_q} RENAME TO {}", q_dq(&bak_name)))).execute(&mut conn).await
                        .map_err(|e| format!("备份旧表失败: {e}"))?;
                    pg_bak_q = Some(bq);
                }
                let create_result = if can_like {
                    sqlx::query(&tag_sql(&format!("CREATE TABLE {dst_q} (LIKE {src_like_q} INCLUDING ALL)"))).execute(&mut conn).await
                        .map(|_| ()).map_err(|e| format!("创建目标表失败: {e}"))
                } else {
                    create_pg_table_mapped(&mut conn, &dst_q, col_names, col_types).await
                };
                if let Err(e) = create_result {
                    if let Some(ref bq) = pg_bak_q {
                        let _ = sqlx::query(&tag_sql(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(dst_table)))).execute(&mut conn).await;
                    }
                    return Err(e);
                }
            }
            let pg_pk: Vec<String> = sqlx::query(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=$1 AND tc.table_name=$2 ORDER BY kcu.ordinal_position"
            ).bind(&ds).bind(dst_table).fetch_all(&mut conn).await.ok()
             .map(|rs| rs.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect()).unwrap_or_default();
            if use_tx { sqlx::query("BEGIN").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            if clear_before_insert { sqlx::query(&tag_sql(&format!("TRUNCATE TABLE {dst_q}"))).execute(&mut conn).await.map_err(|e| format!("清空目标表失败: {e}"))?; }
            Ok(Some(DstSetup { dst: StreamDst::Pg(conn, g), dst_q: dst_q.clone(), pg_pk, bak_q: pg_bak_q, orig_q: Some(dst_q) }))
        }
        ConnType::Sqlite => {
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(dst_config)?;
            let mut conn = SqliteConnectOptions::from_str(&url).map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .busy_timeout(std::time::Duration::from_secs(30)).log_statements(log::LevelFilter::Off)
                .connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
            let dst_q = q_dq(dst_table);
            let exists = sqlx::query(&format!("SELECT 1 FROM {dst_q} LIMIT 1")).fetch_optional(&mut conn).await.is_ok();
            if strategy == "skip" && exists { return Ok(None); }
            if truncate_needs_exist(exists) { return Err(format!("目标表不存在，{}策略要求目标表已存在", if strategy == "truncate" { "截断" } else { "追加" })); }
            let mut lite_bak_q: Option<String> = None;
            if need_ddl(exists) {
                if strategy == "replace" && exists {
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
                    let bak_name = format!("__mig_bak_{}_{}", dst_table, ts);
                    let bq = q_dq(&bak_name);
                    let _ = sqlx::query(&format!("DROP TABLE IF EXISTS {bq}")).execute(&mut conn).await;
                    sqlx::query(&format!("ALTER TABLE {dst_q} RENAME TO {}", q_dq(&bak_name))).execute(&mut conn).await
                        .map_err(|e| format!("备份旧表失败: {e}"))?;
                    lite_bak_q = Some(bq);
                }
                let create_result = if can_like {
                    sqlx::query(&format!("CREATE TABLE {dst_q} AS SELECT * FROM {src_like_q} WHERE 0")).execute(&mut conn).await
                        .map(|_| ()).map_err(|e| format!("创建目标表失败: {e}"))
                } else {
                    create_sqlite_table_mapped(&mut conn, &dst_q, col_names, col_types, src_type).await
                };
                if let Err(e) = create_result {
                    if let Some(ref bq) = lite_bak_q {
                        let _ = sqlx::query(&format!("ALTER TABLE {bq} RENAME TO {}", q_dq(dst_table))).execute(&mut conn).await;
                    }
                    return Err(e);
                }
            }
            if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut conn).await; }
            if use_tx { sqlx::query("BEGIN").execute(&mut conn).await.map_err(|e| format!("开启事务失败: {e}"))?; }
            if clear_before_insert { sqlx::query(&format!("DELETE FROM {dst_q}")).execute(&mut conn).await.map_err(|e| format!("清空目标表失败: {e}"))?; }
            Ok(Some(DstSetup { dst: StreamDst::Lite(conn), dst_q: dst_q.clone(), pg_pk: vec![], bak_q: lite_bak_q, orig_q: Some(dst_q) }))
        }
        _ => Err("目标连接类型不支持流式迁移".into()),
    }
}

/// 写入一个数据块，返回 (成功行数, 失败行数)
async fn stream_write_chunk(
    setup: &mut DstSetup, col_names: &[String], conflict: &str, skip_errors: bool,
    chunk: &[Vec<Option<String>>],
) -> Result<(u64, u64), String> {
    let dst = setup.dst_q.clone();
    let pg_pk = setup.pg_pk.clone();
    match &mut setup.dst {
        StreamDst::My(conn, _) => {
            let col_list = col_names.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
            let row_ph = (0..col_names.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
            let verb = if conflict == "ignore" { "INSERT IGNORE INTO" } else { "INSERT INTO" };
            let dup = if conflict == "upsert" {
                let sets = col_names.iter().map(|c| { let qc = q_mysql(c); format!("{qc}=VALUES({qc})") }).collect::<Vec<_>>().join(", ");
                format!(" ON DUPLICATE KEY UPDATE {sets}")
            } else { String::new() };
            if skip_errors {
                let (mut ok, mut bad) = (0u64, 0u64);
                for r in chunk {
                    let sql = tag_sql(&format!("{verb} {dst} ({col_list}) VALUES ({row_ph}){dup}"));
                    let mut q = sqlx::query(&sql); for v in r { q = q.bind(v.as_deref()); }
                    match q.execute(&mut *conn).await { Ok(_) => ok += 1, Err(_) => bad += 1 }
                }
                Ok((ok, bad))
            } else {
                let all_ph = chunk.iter().map(|_| format!("({row_ph})")).collect::<Vec<_>>().join(", ");
                let sql = tag_sql(&format!("{verb} {dst} ({col_list}) VALUES {all_ph}{dup}"));
                let mut q = sqlx::query(&sql); for r in chunk { for v in r { q = q.bind(v.as_deref()); } }
                q.execute(&mut *conn).await.map_err(|e| format!("批量写入失败: {e}"))?;
                Ok((chunk.len() as u64, 0))
            }
        }
        StreamDst::Pg(conn, _) => {
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let n = col_names.len();
            let suffix = match conflict {
                "ignore" => " ON CONFLICT DO NOTHING".to_string(),
                "upsert" if !pg_pk.is_empty() => {
                    let pkset: std::collections::HashSet<&String> = pg_pk.iter().collect();
                    let tgt = pg_pk.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                    let sets = col_names.iter().filter(|c| !pkset.contains(*c)).map(|c| { let qc = q_dq(c); format!("{qc}=EXCLUDED.{qc}") }).collect::<Vec<_>>().join(", ");
                    if sets.is_empty() { format!(" ON CONFLICT ({tgt}) DO NOTHING") } else { format!(" ON CONFLICT ({tgt}) DO UPDATE SET {sets}") }
                }
                "upsert" => " ON CONFLICT DO NOTHING".to_string(),
                _ => String::new(),
            };
            let ph = (1..=n).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
            let (mut ok, mut bad) = (0u64, 0u64);
            for r in chunk {
                let sql = tag_sql(&format!("INSERT INTO {dst} ({col_list}) VALUES ({ph}){suffix}"));
                let mut q = sqlx::query(&sql); for v in r { q = q.bind(v.as_deref()); }
                match q.execute(&mut *conn).await {
                    Ok(_) => ok += 1,
                    Err(e) => { if skip_errors { bad += 1; } else { return Err(format!("写入失败: {e}")); } }
                }
            }
            Ok((ok, bad))
        }
        StreamDst::Lite(conn) => {
            let col_list = col_names.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
            let row_ph = (0..col_names.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
            let verb = match conflict { "ignore" => "INSERT OR IGNORE INTO", "upsert" => "INSERT OR REPLACE INTO", _ => "INSERT INTO" };
            let (mut ok, mut bad) = (0u64, 0u64);
            for r in chunk {
                let sql = format!("{verb} {dst} ({col_list}) VALUES ({row_ph})");
                let mut q = sqlx::query(&sql); for v in r { q = q.bind(v.as_deref()); }
                match q.execute(&mut *conn).await {
                    Ok(_) => ok += 1,
                    Err(e) => { if skip_errors { bad += 1; } else { return Err(format!("SQLite 写入失败: {e}")); } }
                }
            }
            Ok((ok, bad))
        }
    }
}

async fn stream_finish(setup: &mut DstSetup, use_tx: bool, disable_fk: bool) -> Result<(), String> {
    match &mut setup.dst {
        StreamDst::My(conn, _) => {
            if use_tx { sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| format!("提交事务失败: {e}"))?; }
            if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut *conn).await; }
        }
        StreamDst::Pg(conn, _) => { if use_tx { sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| format!("提交事务失败: {e}"))?; } }
        StreamDst::Lite(conn) => {
            if use_tx { sqlx::query("COMMIT").execute(&mut *conn).await.map_err(|e| format!("提交事务失败: {e}"))?; }
            if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=ON").execute(&mut *conn).await; }
        }
    }
    Ok(())
}

async fn stream_rollback(setup: &mut DstSetup, use_tx: bool, disable_fk: bool) {
    match &mut setup.dst {
        StreamDst::My(conn, _) => { if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await; } if disable_fk { let _ = sqlx::query("SET FOREIGN_KEY_CHECKS=1").execute(&mut *conn).await; } }
        StreamDst::Pg(conn, _) => { if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await; } }
        StreamDst::Lite(conn) => { if use_tx { let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await; } if disable_fk { let _ = sqlx::query("PRAGMA foreign_keys=ON").execute(&mut *conn).await; } }
    }
}

/// 驱动一个行流：缓冲到分批阈值后写入，内存与表大小无关
#[allow(clippy::too_many_arguments)]
async fn drive_stream(
    mut stream: futures::stream::BoxStream<'_, Result<Vec<Option<String>>, sqlx::Error>>,
    mut setup: DstSetup,
    col_names: &[String], conflict: &str, skip_errors: bool, use_tx: bool, disable_fk: bool,
    batch_usize: usize, total_est: u64,
    emit: &(dyn Fn(&str, u64, u64) + Send + Sync),
    start: Instant,
) -> Result<MigrateResult, String> {
    use futures::TryStreamExt;
    let n_cols = col_names.len().max(1);
    let max_rows = ((65535 / n_cols).max(1)).min(batch_usize.max(1));
    let mut buf: Vec<Vec<Option<String>>> = Vec::with_capacity(max_rows);
    let (mut migrated, mut failed) = (0u64, 0u64);
    let errors: Vec<String> = vec![]; // 流式跳过错误行只计数，不逐条收集消息
    let mut read_err: Option<String> = None;
    let mut done = false;
    while !done {
        match stream.try_next().await {
            Ok(Some(row)) => buf.push(row),
            Ok(None) => done = true,
            Err(e) => { read_err = Some(format!("读取源数据失败: {e}")); break; }
        }
        if buf.len() >= max_rows || (done && !buf.is_empty()) {
            match stream_write_chunk(&mut setup, col_names, conflict, skip_errors, &buf).await {
                Ok((ok, bad)) => { migrated += ok; failed += bad; }
                Err(e) => { drop(stream); stream_rollback(&mut setup, use_tx, disable_fk).await; return Err(e); }
            }
            buf.clear();
            emit("migrating", total_est.max(migrated + failed), migrated);
        }
    }
    drop(stream);
    if let Some(e) = read_err { stream_rollback(&mut setup, use_tx, disable_fk).await; return Err(e); }
    stream_finish(&mut setup, use_tx, disable_fk).await?;
    let total = migrated + failed;
    emit("done", total, migrated);
    Ok(MigrateResult { total_rows: total, migrated_rows: migrated, skipped_rows: 0, failed_rows: failed, elapsed_ms: start.elapsed().as_millis() as u64, errors })
}

/// 镜像同步 / 影子表建表：同服务器用 CREATE TABLE LIKE 保留完整结构，跨库退化为按列建表
async fn create_mysql_like_or_columns(
    conn: &mut sqlx::mysql::MySqlConnection,
    tbl: &str,
    same_server: bool,
    src_q: &str,
    col_names: &[String],
    col_types: &[String],
) -> Result<(), String> {
    if same_server {
        sqlx::query(&tag_sql(&format!("CREATE TABLE {tbl} LIKE {src_q}"))).execute(conn).await
            .map(|_| ()).map_err(|e| format!("创建表失败: {e}"))
    } else if !col_types.is_empty() {
        create_mysql_table_mapped(conn, tbl, col_names, col_types).await
    } else {
        create_mysql_table_from_columns(conn, tbl, col_names).await
    }
}

/// 跨连接迁移时，当无法 CREATE LIKE，基于列名创建全 TEXT 列的 MySQL 表
async fn create_mysql_table_from_columns(
    conn: &mut sqlx::mysql::MySqlConnection,
    dst: &str,
    col_names: &[String],
) -> Result<(), String> {
    let cols = col_names.iter()
        .map(|c| format!("  {} TEXT", q_mysql(c)))
        .collect::<Vec<_>>()
        .join(",\n");
    let sql = tag_sql(&format!("CREATE TABLE {dst} (\n{cols}\n)"));
    sqlx::query(&sql).execute(conn).await
        .map_err(|e| format!("创建目标表失败: {e}"))?;
    Ok(())
}

// ── 12. db_logical_backup ─────────────────────────────────────────────────────
// G1 优化：流式写文件（BufWriter）+ 每 1000 行发一次进度事件 + 取消支持

const BACKUP_PROGRESS_INTERVAL: u64 = 1_000;

#[tauri::command]
pub async fn db_logical_backup(
    id:      String,
    schema:  String,
    tables:  Vec<String>,
    // 额外导出的对象（仅 MySQL 系；视图/函数/存储过程导出的是结构）
    views:   Option<Vec<String>>,
    funcs:   Option<Vec<String>>,
    procs:   Option<Vec<String>>,
    // MariaDB 原生序列（10.3+）；非 MariaDB 忽略
    seqs:    Option<Vec<String>>,
    path:    String,
    // 导出内容："structure" 仅结构 / "data" 仅数据 / 其他(both) 结构+数据
    content: Option<String>,
    // 实例级导出：为 true 时在文件头写入 CREATE DATABASE IF NOT EXISTS + USE，
    // 让每个 .sql 都能单独还原（仅 MySQL 系；单库 BackupPanel 传 None/false 即老行为）
    create_db: Option<bool>,
    task_id: Option<String>,
    app_handle: tauri::AppHandle,
    cancel_map: State<'_, crate::commands::db_export::ExportCancelMap>,
    storage:    State<'_, StorageState>,
    ss_pool:    State<'_, SsPool>,
) -> Result<BackupResult, String> {
    use std::io::{BufWriter, Write};
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
    use futures::TryStreamExt;

    if !schema.is_empty() { validate_ident(&schema)?; }
    for t in &tables { validate_ident(t)?; }
    validate_path(&path)?;

    // 取消标志（复用导出取消机制）
    let cancel_flag: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    if let Some(ref tid) = task_id {
        cancel_map.lock().unwrap().insert(tid.clone(), Arc::clone(&cancel_flag));
    }
    let cleanup_cancel = || {
        if let Some(ref tid) = task_id {
            cancel_map.lock().unwrap().remove(tid);
        }
    };

    let with_structure = content.as_deref() != Some("data");
    let with_data      = content.as_deref() != Some("structure");

    let (config, password) = load_conn(&id, &storage).await?;

    // 调用方传入明确的对象名单（按类型勾选 → 该类型全量名单 / 或具体多选）
    let table_list: Vec<String> = tables.clone();

    let total_tables = table_list.len() as u64;

    // SQL Server 大库按表拆分，避免单个 SQL 文件过大，也便于按表恢复。
    if config.conn_type == ConnType::SqlServer {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = std::fs::File::create(&path).map_err(|e| format!("创建备份文件失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1024 * 1024, file));
        // 表数据量不可预知，始终使用 ZIP64 条目；否则单表 SQL 超过 4 GiB 会在导出末尾失败。
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);

        let emit = |current_table: &str, done: u64, current_rows: u64| {
            #[derive(serde::Serialize, Clone)]
            #[serde(rename_all = "camelCase")]
            struct P { current_table: String, total_tables: u64, done_tables: u64, current_rows: u64 }
            let payload = P { current_table: current_table.to_string(), total_tables, done_tables: done, current_rows };
            let _ = app_handle.emit("backup_progress", payload.clone());
            if let Some(ref tid) = task_id {
                let _ = app_handle.emit(&format!("backup_progress_{tid}"), payload);
            }
        };

        let q = |name: &str| format!("[{}]", name.replace(']', "]]"));
        // SchemaBrowser 的 `schema` 对 SQL Server 表示数据库名；当前平铺列表使用默认 dbo schema。
        let database_name = schema.as_str();
        let schema_name = "dbo";
        let mut tables_done = 0u64;
        let mut total_rows_backed = 0u64;

        for tbl in &table_list {
            if cancel_flag.load(Ordering::Relaxed) {
                cleanup_cancel();
                drop(zip);
                let _ = std::fs::remove_file(&path);
                return Err("备份已取消".into());
            }
            emit(tbl, tables_done, 0);
            let entry_name = format!("tables/{}.sql", tbl.replace(['/', '\\', ':'], "_"));
            zip.start_file(entry_name, options).map_err(|e| format!("创建 ZIP 条目失败: {e}"))?;
            writeln!(zip, "-- DBTerm SQL Server logical backup\n-- Database: {}\n-- Table: {}.{}\nSET NOCOUNT ON;\n", database_name, schema_name, tbl)
                .map_err(|e| format!("写入备份失败: {e}"))?;

            let table_ref = format!("{}.{}", q(schema_name), q(tbl));
            if with_structure {
                let ddl = dispatch_ss_ddl(&id, &config, database_name, tbl, &ss_pool).await?;
                writeln!(zip, "IF OBJECT_ID(N'{}', N'U') IS NOT NULL DROP TABLE {};\n{}\nGO\n", table_ref.replace('\'', "''"), table_ref, ddl)
                    .map_err(|e| format!("写入表结构失败: {e}"))?;
            }

            let mut row_count = 0u64;
            if with_data {
                use futures::TryStreamExt;
                use tiberius::QueryItem;
                let entry_arc = super::sqlserver::get_entry(&id, &ss_pool, &config, password.as_deref()).await?;
                let mut entry = entry_arc.lock().await;
                let db_context = if database_name.is_empty() { String::new() } else { format!("USE {}; ", q(database_name)) };
                let identity_sql = format!(
                    "{db_context}SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.identity_columns WHERE object_id = OBJECT_ID(N'{}')) THEN 1 ELSE 0 END",
                    table_ref.replace('\'', "''")
                );
                let has_identity = entry.client.simple_query(identity_sql).await
                    .map_err(|e| format!("读取表 {tbl} 自增信息失败: {e}"))?
                    .into_row().await
                    .map_err(|e| format!("读取表 {tbl} 自增信息失败: {e}"))?
                    .and_then(|r| r.get::<i32, _>(0)).unwrap_or(0) == 1;
                if has_identity {
                    writeln!(zip, "SET IDENTITY_INSERT {table_ref} ON;")
                        .map_err(|e| format!("写入表 {tbl} 数据失败: {e}"))?;
                }
                let mut stream = entry.client.simple_query(format!("{db_context}SELECT * FROM {table_ref}")).await
                    .map_err(|e| format!("读取表 {tbl} 失败: {e}"))?;
                let mut columns: Vec<String> = Vec::new();
                while let Some(item) = stream.try_next().await.map_err(|e| format!("读取表 {tbl} 失败: {e}"))? {
                    match item {
                        QueryItem::Metadata(meta) => {
                            if columns.is_empty() { columns = meta.columns().iter().map(|c| q(c.name())).collect(); }
                        }
                        QueryItem::Row(row) => {
                            if columns.is_empty() { columns = row.columns().iter().map(|c| q(c.name())).collect(); }
                            let vals: Vec<Option<String>> = (0..columns.len())
                                .map(|i| super::sqlserver::cell_to_string(&row, i)).collect();
                            let values = vals.iter().map(sql_escape_value_std).collect::<Vec<_>>().join(", ");
                            writeln!(zip, "INSERT INTO {table_ref} ({}) VALUES ({values});", columns.join(", "))
                                .map_err(|e| format!("写入表 {tbl} 数据失败: {e}"))?;
                            row_count += 1;
                            if row_count % BACKUP_PROGRESS_INTERVAL == 0 {
                                emit(tbl, tables_done, row_count);
                                if cancel_flag.load(Ordering::Relaxed) {
                                    drop(stream); drop(entry); cleanup_cancel(); drop(zip);
                                    let _ = std::fs::remove_file(&path);
                                    return Err("备份已取消".into());
                                }
                            }
                        }
                    }
                }
                if has_identity {
                    writeln!(zip, "SET IDENTITY_INSERT {table_ref} OFF;")
                        .map_err(|e| format!("写入表 {tbl} 数据失败: {e}"))?;
                }
            }
            total_rows_backed += row_count;
            tables_done += 1;
            emit(tbl, tables_done, row_count);
        }

        if with_structure {
            for (dir, names) in [
                ("views", views.as_deref().unwrap_or(&[])),
                ("functions", funcs.as_deref().unwrap_or(&[])),
                ("procedures", procs.as_deref().unwrap_or(&[])),
            ] {
                for name in names {
                    if cancel_flag.load(Ordering::Relaxed) {
                        cleanup_cancel(); drop(zip); let _ = std::fs::remove_file(&path);
                        return Err("备份已取消".into());
                    }
                    let ddl = dispatch_ss_ddl(&id, &config, database_name, name, &ss_pool).await?;
                    let entry_name = format!("{dir}/{}.sql", name.replace(['/', '\\', ':'], "_"));
                    zip.start_file(entry_name, options).map_err(|e| format!("创建 ZIP 条目失败: {e}"))?;
                    writeln!(zip, "-- DBTerm SQL Server logical backup\n-- Object: {name}\n{ddl}\nGO")
                        .map_err(|e| format!("写入对象 {name} 失败: {e}"))?;
                }
            }
        }

        zip.finish().map_err(|e| format!("完成 ZIP 备份失败: {e}"))?;
        cleanup_cancel();
        let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        return Ok(BackupResult { tables_done, total_rows: total_rows_backed, file_size });
    }

    // 打开输出文件（流式写）
    let file = std::fs::File::create(&path).map_err(|e| format!("创建备份文件失败: {e}"))?;
    let mut writer = BufWriter::new(file);

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    writeln!(writer, "-- DBTerm logical backup").ok();
    writeln!(writer, "-- Schema: {}", if schema.is_empty() { "(current)" } else { &schema }).ok();
    writeln!(writer, "-- Date: {now}").ok();
    writeln!(writer, "-- Tables: {total_tables}").ok();
    writeln!(writer).ok();

    // 实例级导出：写入建库 + USE，使单文件可独立还原（仅 MySQL 系，且指定了库名）
    if create_db == Some(true) && !schema.is_empty() {
        if let ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase = config.conn_type {
            writeln!(writer, "CREATE DATABASE IF NOT EXISTS {};", q_mysql(&schema)).ok();
            writeln!(writer, "USE {};", q_mysql(&schema)).ok();
            writeln!(writer).ok();
        }
    }

    let emit = |current_table: &str, done: u64, current_rows: u64| {
        #[derive(serde::Serialize, Clone)]
        #[serde(rename_all = "camelCase")]
        struct P { current_table: String, total_tables: u64, done_tables: u64, current_rows: u64 }
        let payload = P {
            current_table: current_table.to_string(),
            total_tables,
            done_tables: done,
            current_rows,
        };
        let _ = app_handle.emit("backup_progress", payload.clone());
        if let Some(ref tid) = task_id {
            let event = format!("backup_progress_{tid}");
            let _ = app_handle.emit(&event, payload);
        }
    };

    let mut tables_done: u64 = 0;
    let mut total_rows_backed: u64 = 0;

    macro_rules! check_cancel {
        () => {
            if cancel_flag.load(Ordering::Relaxed) {
                cleanup_cancel();
                drop(writer);
                let _ = std::fs::remove_file(&path);
                return Err("备份已取消".into());
            }
        };
    }

    for tbl in &table_list {
        emit(tbl, tables_done, 0);
        check_cancel!();

        match config.conn_type {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
                let tgt = if schema.is_empty() { q_mysql(tbl) }
                          else { format!("{}.{}", q_mysql(&schema), q_mysql(tbl)) };

                // DDL
                use sqlx::Row;
                if with_structure {
                    let ddl_sql = format!("SHOW CREATE TABLE {tgt}");
                    match sqlx::query(&ddl_sql).fetch_one(&mut conn).await {
                        Ok(row) => {
                            let ddl = row.try_get::<String, _>(1).unwrap_or_default();
                            writeln!(writer, "-- Table: {tbl}").ok();
                            writeln!(writer, "DROP TABLE IF EXISTS {tgt};").ok();
                            writeln!(writer, "{ddl};").ok();
                            writeln!(writer).ok();
                        }
                        Err(e) => { writeln!(writer, "-- 获取 DDL 失败: {e}").ok(); writeln!(writer).ok(); }
                    }
                }

                // Data — streaming
                let mut row_count = 0u64;
                if with_data {
                    use sqlx::Column;
                    let data_sql = tag_sql(&format!("SELECT * FROM {tgt}"));
                    let mut stream = sqlx::query(&data_sql).fetch(&mut conn);
                    let mut col_list_opt: Option<String> = None;
                    while let Some(row) = stream.try_next().await
                        .map_err(|e| format!("读取表 {tbl} 数据失败: {e}"))?
                    {
                        if col_list_opt.is_none() {
                            let names: Vec<String> = row.columns().iter().map(|c| q_mysql(c.name())).collect();
                            col_list_opt = Some(names.join(", "));
                        }
                        let vals = mysql_row_to_strings(&row);
                        let val_str = vals.iter().map(sql_escape_value).collect::<Vec<_>>().join(", ");
                        if let Some(ref cl) = col_list_opt {
                            writeln!(writer, "INSERT INTO {tgt} ({cl}) VALUES ({val_str});").ok();
                        }
                        row_count += 1;
                        if row_count % BACKUP_PROGRESS_INTERVAL == 0 {
                            emit(tbl, tables_done, row_count);
                            check_cancel!();
                        }
                    }
                    writeln!(writer).ok();
                }
                total_rows_backed += row_count;
                emit(tbl, tables_done, row_count);
            }
            ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                let s = if schema.is_empty() { "public" } else { &schema };
                let tgt = format!("{}.{}", q_dq(s), q_dq(tbl));
                let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;

                use sqlx::{Column, Row};
                let col_rows = sqlx::query(
                    "SELECT column_name, data_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = $1 AND table_name = $2 \
                     ORDER BY ordinal_position"
                ).bind(s).bind(tbl.as_str()).fetch_all(&mut conn).await
                 .map_err(|e| format!("获取列信息失败: {e}"))?;

                if with_structure {
                    let col_defs: Vec<String> = col_rows.iter().filter_map(|r| {
                        let name    = r.try_get::<String, _>(0).ok()?;
                        let typ     = r.try_get::<String, _>(1).unwrap_or_default();
                        let notnull = r.try_get::<String, _>(2).map(|v| v == "NO").unwrap_or(false);
                        let def     = r.try_get::<Option<String>, _>(3).ok().flatten();
                        let mut sd = format!("  {} {}", q_dq(&name), typ);
                        if notnull { sd.push_str(" NOT NULL"); }
                        if let Some(d) = def { sd.push_str(&format!(" DEFAULT {d}")); }
                        Some(sd)
                    }).collect();

                    writeln!(writer, "-- Table: {tbl}").ok();
                    writeln!(writer, "DROP TABLE IF EXISTS {tgt};").ok();
                    writeln!(writer, "CREATE TABLE {tgt} (\n{}\n);", col_defs.join(",\n")).ok();
                    writeln!(writer).ok();
                }

                // Data — streaming
                let mut row_count = 0u64;
                if with_data {
                    let data_sql = tag_sql(&format!("SELECT * FROM {tgt}"));
                    let mut stream = sqlx::query(&data_sql).fetch(&mut conn);
                    let mut col_list_opt: Option<String> = None;
                    while let Some(row) = stream.try_next().await
                        .map_err(|e| format!("读取表 {tbl} 数据失败: {e}"))?
                    {
                        if col_list_opt.is_none() {
                            let names: Vec<String> = row.columns().iter().map(|c| q_dq(c.name())).collect();
                            col_list_opt = Some(names.join(", "));
                        }
                        let vals = pg_row_to_strings(&row);
                        let val_str = vals.iter().map(sql_escape_value).collect::<Vec<_>>().join(", ");
                        if let Some(ref cl) = col_list_opt {
                            writeln!(writer, "INSERT INTO {tgt} ({cl}) VALUES ({val_str});").ok();
                        }
                        row_count += 1;
                        if row_count % BACKUP_PROGRESS_INTERVAL == 0 {
                            emit(tbl, tables_done, row_count);
                            check_cancel!();
                        }
                    }
                    writeln!(writer).ok();
                }
                total_rows_backed += row_count;
                emit(tbl, tables_done, row_count);
            }
            _ => return Err("此连接类型不支持逻辑备份".into()),
        }

        tables_done += 1;
    }

    // 视图 / 函数 / 存储过程（仅结构，MySQL 系；仅数据模式下不导出这些定义）
    let views = views.unwrap_or_default();
    let funcs = funcs.unwrap_or_default();
    let procs = procs.unwrap_or_default();
    if with_structure
        && matches!(config.conn_type, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase)
        && (!views.is_empty() || !funcs.is_empty() || !procs.is_empty())
    {
        use sqlx::{Row, Executor};
        let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
        if !schema.is_empty() {
            let _ = conn.execute(sqlx::raw_sql(&tag_sql(&format!("USE {}", q_mysql(&schema))))).await;
        }
        for v in &views {
            check_cancel!();
            if let Ok(row) = sqlx::query(&tag_sql(&format!("SHOW CREATE VIEW {}", q_mysql(v))))
                .fetch_one(&mut conn).await {
                let ddl = row.try_get::<String, _>(1).unwrap_or_default();
                writeln!(writer, "-- View: {v}").ok();
                writeln!(writer, "DROP VIEW IF EXISTS {};", q_mysql(v)).ok();
                writeln!(writer, "{ddl};\n").ok();
            }
        }
        for (names, kw) in [(&funcs, "FUNCTION"), (&procs, "PROCEDURE")] {
            for n in names {
                check_cancel!();
                if let Ok(row) = sqlx::query(&tag_sql(&format!("SHOW CREATE {kw} {}", q_mysql(n))))
                    .fetch_one(&mut conn).await {
                    let ddl = row.try_get::<String, _>(2).unwrap_or_default();
                    if ddl.trim().is_empty() { continue; }
                    writeln!(writer, "-- {kw}: {n}").ok();
                    writeln!(writer, "DROP {kw} IF EXISTS {};", q_mysql(n)).ok();
                    writeln!(writer, "DELIMITER ;;").ok();
                    writeln!(writer, "{}\n;;", ddl.trim_end()).ok();
                    writeln!(writer, "DELIMITER ;\n").ok();
                }
            }
        }
    }

    // MariaDB 原生序列（仅结构，10.3+）
    let seqs = seqs.unwrap_or_default();
    if with_structure && matches!(config.conn_type, ConnType::Mariadb) && !seqs.is_empty() {
        use sqlx::{Row, Executor};
        let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
        if !schema.is_empty() {
            let _ = conn.execute(sqlx::raw_sql(&tag_sql(&format!("USE {}", q_mysql(&schema))))).await;
        }
        for seq in &seqs {
            check_cancel!();
            let sref = q_mysql(seq);
            if let Ok(row) = sqlx::query(&tag_sql(&format!("SHOW CREATE SEQUENCE {sref}")))
                .fetch_one(&mut conn).await {
                let ddl: String = row.try_get(1).unwrap_or_default();
                if !ddl.trim().is_empty() {
                    writeln!(writer, "-- Sequence: {seq}").ok();
                    writeln!(writer, "DROP SEQUENCE IF EXISTS {sref};").ok();
                    writeln!(writer, "{ddl};\n").ok();
                }
            }
        }
    }

    writer.flush().map_err(|e| format!("写入备份文件失败: {e}"))?;
    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    cleanup_cancel();
    Ok(BackupResult { tables_done, total_rows: total_rows_backed, file_size })
}

// ── 13. db_process_list ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_process_list(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<ProcessEntry>, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            mysql_process_list(&config, password.as_deref()).await
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            pg_process_list(&config, password.as_deref()).await
        }
        _ => Err("此连接类型不支持进程列表查询".into()),
    }
}

async fn mysql_process_list(
    config: &ConnConfig, password: Option<&str>,
) -> Result<Vec<ProcessEntry>, String> {
    use sqlx::Row;
    let (mut conn, _t) = mysql_connect(config, password).await?;
    let rows = sqlx::query("SHOW FULL PROCESSLIST")
        .fetch_all(&mut conn).await
        .map_err(|e| format!("获取进程列表失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        // SHOW FULL PROCESSLIST 列顺序: Id, User, Host, db, Command, Time, State, Info
        let process_id = r.try_get::<u64, _>("Id")
            .or_else(|_| r.try_get::<i64, _>("Id").map(|v| v as u64))
            .unwrap_or(0);
        let user     = r.try_get::<String, _>("User").unwrap_or_default();
        let host     = r.try_get::<String, _>("Host").unwrap_or_default();
        let database = r.try_get::<Option<String>, _>("db").ok().flatten().unwrap_or_default();
        let command  = r.try_get::<String, _>("Command").unwrap_or_default();
        let time_secs= r.try_get::<u64, _>("Time")
            .or_else(|_| r.try_get::<i64, _>("Time").map(|v| v as u64))
            .unwrap_or(0);
        let state    = r.try_get::<Option<String>, _>("State").ok().flatten().unwrap_or_default();
        let info     = r.try_get::<Option<String>, _>("Info").ok().flatten();
        Some(ProcessEntry { process_id, user, host, database, command, time_secs, state, info })
    }).collect())
}

async fn pg_process_list(
    config: &ConnConfig, password: Option<&str>,
) -> Result<Vec<ProcessEntry>, String> {
    use sqlx::Row;
    let (mut conn, _t) = pg_connect(config, password).await?;
    let rows = sqlx::query(
        "SELECT pid, usename, client_addr, datname, state, \
                EXTRACT(EPOCH FROM (now() - query_start))::bigint, \
                state_change::text, query \
         FROM pg_stat_activity \
         WHERE pid != pg_backend_pid() \
         ORDER BY pid"
    ).fetch_all(&mut conn).await
     .map_err(|e| format!("获取进程列表失败: {e}"))?;

    Ok(rows.iter().filter_map(|r| {
        let process_id = r.try_get::<i32, _>(0).map(|v| v as u64).unwrap_or(0);
        let user     = r.try_get::<Option<String>, _>(1).ok().flatten().unwrap_or_default();
        let host     = r.try_get::<Option<String>, _>(2).ok().flatten()
            .unwrap_or_else(|| "local".to_string());
        let database = r.try_get::<Option<String>, _>(3).ok().flatten().unwrap_or_default();
        let state    = r.try_get::<Option<String>, _>(4).ok().flatten().unwrap_or_default();
        let time_secs= r.try_get::<Option<i64>, _>(5).ok().flatten()
            .map(|v| v.max(0) as u64).unwrap_or(0);
        let state_change = r.try_get::<Option<String>, _>(6).ok().flatten().unwrap_or_default();
        let info     = r.try_get::<Option<String>, _>(7).ok().flatten();
        Some(ProcessEntry {
            process_id,
            user,
            host,
            database,
            command: state_change,
            time_secs,
            state,
            info,
        })
    }).collect())
}

// ── 14. db_kill_process ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_kill_process(
    id: String,
    process_id: u64,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            // process_id 来自服务端，用字面量拼接（不是用户输入的字符串，无注入风险）
            sqlx::query(&tag_sql(&format!("KILL QUERY {process_id}")))
                .execute(&mut conn).await
                .map_err(|e| format!("终止进程失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            // pg_cancel_backend 接受 int4，用参数绑定
            let row = sqlx::query(
                &tag_sql("SELECT pg_cancel_backend($1::int4)")
            )
            .bind(process_id as i64)
            .fetch_one(&mut conn).await
            .map_err(|e| format!("取消查询失败: {e}"))?;
            let ok = row.try_get::<bool, _>(0).unwrap_or(false);
            if !ok {
                return Err(format!("进程 {process_id} 不存在或无权限取消"));
            }
            Ok(())
        }
        _ => Err("此连接类型不支持终止进程操作".into()),
    }
}

// PG5.1 — pg_terminate_backend（强制断开，需强确认在前端完成）
#[tauri::command]
pub async fn db_terminate_process(
    id:         String,
    process_id: u64,
    storage:    State<'_, StorageState>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let row = sqlx::query(&tag_sql("SELECT pg_terminate_backend($1::int4)"))
                .bind(process_id as i64)
                .fetch_one(&mut conn).await
                .map_err(|e| format!("强制断开失败: {e}"))?;
            let ok = row.try_get::<bool, _>(0).unwrap_or(false);
            if !ok {
                return Err(format!("进程 {process_id} 不存在或无权限终止"));
            }
            Ok(())
        }
        _ => Err("pg_terminate_backend 仅支持 PostgreSQL 兼容数据库".into()),
    }
}

// ── 14b. db_cancel_query：按取消令牌主动终止正在运行的查询 ────────────────────
// 前端执行查询时在 SQL 前注入注释 /* dbterm-cancel:TOKEN */，该注释会出现在
// SHOW FULL PROCESSLIST.Info / pg_stat_activity.query 中。此处按令牌定位该会话并取消，
// 无需改动核心 execute_query，也无需在执行连接上预取 pid。
#[tauri::command]
pub async fn db_cancel_query(
    id: String,
    token: String,
    storage: State<'_, StorageState>,
) -> Result<bool, String> {
    // 令牌仅允许字母数字，杜绝借 LIKE/拼接注入
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("无效的取消令牌".into());
    }
    let known_pid = crate::commands::query::cancel_pid(&token);
    // 中止正在执行该查询的那条连接（关连接 → 取数据类查询服务端会随之中止；客户端立即解阻塞）。
    let aborted = crate::commands::query::cancel_abort(&token);
    let (config, password) = load_conn(&id, &storage).await?;
    let marker = format!("dbterm-cancel:{token}");
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            // 用 `KILL <id>`（终止整条会话线程，连同其正在跑的查询），而非 `KILL QUERY`（只停语句、线程仍在）
            // —— 确保不留僵尸后台线程。杀的是本应用自己发起的查询连接（同用户），无需 SUPER 权限。
            // 为彻底起见：已记录的 pid 与「按取消标记扫进程列表命中的线程」都杀一遍（不提前 return）。
            let mut acted = false;
            // 1) 直接杀登记的执行连接线程（线程可能已因客户端断连被回收 → KILL 报错属正常，无残留）
            if let Some(pid) = known_pid {
                if pid > 0 && sqlx::query(&format!("KILL {pid}")).execute(&mut conn).await.is_ok() {
                    acted = true;
                }
            }
            // 2) 再按取消标记在进程列表里定位仍残留的线程并杀掉（命中说明就在本连接所在节点，可靠清除）
            if let Ok(rows) = sqlx::query("SHOW FULL PROCESSLIST").fetch_all(&mut conn).await {
                for r in &rows {
                    let info = r.try_get::<Option<String>, _>("Info").ok().flatten().unwrap_or_default();
                    if info.contains(&marker) {
                        let pid = r.try_get::<u64, _>("Id")
                            .or_else(|_| r.try_get::<i64, _>("Id").map(|v| v as u64))
                            .unwrap_or(0);
                        if pid != 0 && sqlx::query(&format!("KILL {pid}")).execute(&mut conn).await.is_ok() {
                            acted = true;
                        }
                    }
                }
            }
            Ok(acted || aborted) // acted=确实杀了线程；aborted=至少已断开客户端连接
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            // 用 pg_terminate_backend（终止整个后端连接，连同其正在跑的查询）而非 pg_cancel_backend
            // （只取消语句、后端仍在）—— 确保不留残留后端。已记录 pid 与按标记定位的后端都终止一遍。
            let mut acted = false;
            if let Some(pid) = known_pid {
                if pid > 0 && sqlx::query("SELECT pg_terminate_backend($1::int4)").bind(pid as i32)
                    .execute(&mut conn).await.is_ok() {
                    acted = true;
                }
            }
            let pat = format!("%{marker}%");
            if let Ok(rows) = sqlx::query(
                "SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()")
                .bind(&pat).fetch_all(&mut conn).await {
                for r in &rows {
                    let pid: i32 = r.try_get(0).unwrap_or(0);
                    if pid != 0 && sqlx::query("SELECT pg_terminate_backend($1::int4)").bind(pid)
                        .execute(&mut conn).await.is_ok() {
                        acted = true;
                    }
                }
            }
            Ok(acted || aborted)
        }
        ConnType::Sqlite | ConnType::Duckdb => {
            // SQLite/DuckDB 通过 abort 信号中断 select!，无需服务端 KILL
            Ok(aborted)
        }
        _ => Err("此连接类型暂不支持取消查询".into()),
    }
}

// ── 15. db_table_sizes (F2 容量统计) ─────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSizeEntry {
    pub table_name:   String,
    pub table_rows:   u64,
    pub data_bytes:   u64,
    pub index_bytes:  u64,
    pub total_bytes:  u64,
}

#[tauri::command]
pub async fn db_table_sizes(
    id:     String,
    schema: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<TableSizeEntry>, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let sc = if schema.is_empty() { "DATABASE()".to_string() }
                     else { format!("'{}'", schema.replace('\'', "''")) };
            let sql = format!(
                "SELECT TABLE_NAME, \
                        IFNULL(TABLE_ROWS, 0), \
                        IFNULL(DATA_LENGTH, 0), \
                        IFNULL(INDEX_LENGTH, 0) \
                 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {sc} AND TABLE_TYPE = 'BASE TABLE' \
                 ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC"
            );
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("获取表大小失败: {e}"))?;
            Ok(rows.iter().filter_map(|r| {
                let name   = r.try_get::<String, _>(0).ok()?;
                let rows_n = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
                let data   = r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
                let idx    = r.try_get::<i64, _>(3).unwrap_or(0).max(0) as u64;
                Some(TableSizeEntry { table_name: name, table_rows: rows_n, data_bytes: data, index_bytes: idx, total_bytes: data + idx })
            }).collect())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let s = if schema.is_empty() { "public" } else { &schema };
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let rows = sqlx::query(
                "SELECT relname, \
                        n_live_tup, \
                        pg_relation_size(c.oid), \
                        pg_indexes_size(c.oid) \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind = 'r' \
                 ORDER BY (pg_relation_size(c.oid) + pg_indexes_size(c.oid)) DESC"
            ).bind(s).fetch_all(&mut conn).await
             .map_err(|e| format!("获取表大小失败: {e}"))?;
            Ok(rows.iter().filter_map(|r| {
                let name   = r.try_get::<String, _>(0).ok()?;
                let rows_n = r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
                let data   = r.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
                let idx    = r.try_get::<i64, _>(3).unwrap_or(0).max(0) as u64;
                Some(TableSizeEntry { table_name: name, table_rows: rows_n, data_bytes: data, index_bytes: idx, total_bytes: data + idx })
            }).collect())
        }
        _ => Err("此连接类型不支持容量统计".into()),
    }
}

// ── 16. db_show_variables (F5 变量/状态) ──────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarEntry {
    pub name:  String,
    pub value: String,
}

#[tauri::command]
pub async fn db_show_variables(
    id:       String,
    kind:     String, // "variables" | "status" | "global_variables" | "global_status"
    storage: State<'_, StorageState>,
) -> Result<Vec<VarEntry>, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let sql = match (config.conn_type.clone(), kind.as_str()) {
        (ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase, "variables")        => "SHOW SESSION VARIABLES".to_string(),
        (ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase, "status")           => "SHOW SESSION STATUS".to_string(),
        (ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase, "global_variables") => "SHOW GLOBAL VARIABLES".to_string(),
        (ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase, "global_status")    => "SHOW GLOBAL STATUS".to_string(),
        (ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss, _) => {
            "SELECT name, COALESCE(setting, '') FROM pg_settings ORDER BY name".to_string()
        }
        _ => return Err("此连接类型不支持变量查看".into()),
    };
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("查询变量失败: {e}"))?;
            Ok(rows.iter().map(|r| VarEntry {
                name:  r.try_get::<String, _>(0).unwrap_or_default(),
                value: r.try_get::<String, _>(1).unwrap_or_default(),
            }).collect())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("查询变量失败: {e}"))?;
            Ok(rows.iter().map(|r| VarEntry {
                name:  r.try_get::<String, _>(0).unwrap_or_default(),
                value: r.try_get::<String, _>(1).unwrap_or_default(),
            }).collect())
        }
        _ => unreachable!(),
    }
}

// ── 17. db_instance_info (R10 实例信息) ───────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub version:      String,
    pub version_full: String,
    pub uptime_secs:  u64,
    pub charset:      String,
    pub timezone:     String,
    pub max_conn:     u64,
    pub curr_conn:    u64,
    pub db_size_bytes: u64,
}

#[tauri::command]
pub async fn db_instance_info(
    id:     String,
    schema: String,
    storage: State<'_, StorageState>,
) -> Result<InstanceInfo, String> {
    if !schema.is_empty() { validate_ident(&schema)?; }
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let ver_row = sqlx::query("SELECT @@version, @@version_comment, @@global.uptime, @@character_set_server, @@time_zone, @@max_connections")
                .fetch_one(&mut conn).await.map_err(|e| format!("获取实例信息失败: {e}"))?;
            let version      = ver_row.try_get::<String, _>(0).unwrap_or_default();
            let version_full = format!("{} - {}", &version, ver_row.try_get::<String, _>(1).unwrap_or_default());
            let uptime_secs  = ver_row.try_get::<i64, _>(2).unwrap_or(0).max(0) as u64;
            let charset      = ver_row.try_get::<String, _>(3).unwrap_or_default();
            let timezone     = ver_row.try_get::<String, _>(4).unwrap_or_default();
            let max_conn     = ver_row.try_get::<i64, _>(5).unwrap_or(0).max(0) as u64;

            let curr_row = sqlx::query("SELECT COUNT(*) FROM information_schema.PROCESSLIST")
                .fetch_one(&mut conn).await.map_err(|e| format!("获取连接数失败: {e}"))?;
            let curr_conn = curr_row.try_get::<i64, _>(0).unwrap_or(0).max(0) as u64;

            let sc = if schema.is_empty() { "DATABASE()".to_string() }
                     else { format!("'{}'", schema.replace('\'', "''")) };
            let size_sql = format!(
                "SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {sc} AND TABLE_TYPE = 'BASE TABLE'"
            );
            let sz_row = sqlx::query(&size_sql).fetch_one(&mut conn).await
                .map_err(|e| format!("获取库大小失败: {e}"))?;
            let db_size_bytes = sz_row.try_get::<Option<i64>, _>(0).ok().flatten().unwrap_or(0).max(0) as u64;

            Ok(InstanceInfo { version, version_full, uptime_secs, charset, timezone, max_conn, curr_conn, db_size_bytes })
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let s = if schema.is_empty() { "public" } else { &schema };
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let ver_row = sqlx::query(
                "SELECT version(), \
                        EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint, \
                        pg_encoding_to_char(encoding), \
                        current_setting('TimeZone'), \
                        current_setting('max_connections')::bigint \
                 FROM pg_database WHERE datname = current_database()"
            ).fetch_one(&mut conn).await.map_err(|e| format!("获取实例信息失败: {e}"))?;
            let version_full = ver_row.try_get::<String, _>(0).unwrap_or_default();
            let version = version_full.split_whitespace().nth(1).unwrap_or(&version_full).to_string();
            let uptime_secs = ver_row.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64;
            let charset     = ver_row.try_get::<String, _>(2).unwrap_or_default();
            let timezone    = ver_row.try_get::<String, _>(3).unwrap_or_default();
            let max_conn    = ver_row.try_get::<i64, _>(4).unwrap_or(0).max(0) as u64;

            let curr_row = sqlx::query(
                "SELECT COUNT(*) FROM pg_stat_activity"
            ).fetch_one(&mut conn).await.map_err(|_| "获取连接数失败".to_string())?;
            let curr_conn = curr_row.try_get::<i64, _>(0).unwrap_or(0).max(0) as u64;

            let sz_row = sqlx::query(
                "SELECT SUM(pg_relation_size(c.oid) + pg_indexes_size(c.oid)) \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind = 'r'"
            ).bind(s).fetch_one(&mut conn).await.map_err(|_| "获取库大小失败".to_string())?;
            let db_size_bytes = sz_row.try_get::<Option<i64>, _>(0).ok().flatten().unwrap_or(0).max(0) as u64;

            Ok(InstanceInfo { version, version_full, uptime_secs, charset, timezone, max_conn, curr_conn, db_size_bytes })
        }
        _ => Err("此连接类型不支持实例信息查看".into()),
    }
}

// ── 18. db_create_database / db_drop_database (R1 库管理) ────────────────────

#[tauri::command]
pub async fn db_create_database(
    id:      String,
    db_name: String,
    charset: String,
    collate: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&db_name)?;
    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let mut sql = format!("CREATE DATABASE {}", q_mysql(&db_name));
            if !charset.is_empty() {
                validate_ident(&charset)?;
                sql.push_str(&format!(" CHARACTER SET {charset}"));
                if !collate.is_empty() {
                    validate_ident(&collate)?;
                    sql.push_str(&format!(" COLLATE {collate}"));
                }
            }
            sqlx::query(&tag_sql(&sql)).execute(&mut conn).await
                .map_err(|e| format!("创建数据库失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let mut sql = format!("CREATE DATABASE {}", q_dq(&db_name));
            if !charset.is_empty() {
                validate_ident(&charset)?;
                sql.push_str(&format!(" ENCODING = '{charset}'"));
            }
            sqlx::query(&tag_sql(&sql)).execute(&mut conn).await
                .map_err(|e| format!("创建数据库失败: {e}"))?;
            Ok(())
        }
        _ => Err("此连接类型不支持创建数据库".into()),
    }
}

#[tauri::command]
pub async fn db_drop_database(
    id:      String,
    db_name: String,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&db_name)?;
    // 后端防线：禁止删除系统库（误删会毁掉实例）
    {
        let n = db_name.to_lowercase();
        const SYS: &[&str] = &["mysql", "information_schema", "performance_schema", "sys",
            "pg_catalog", "pg_toast"];
        if SYS.contains(&n.as_str()) || n.starts_with("pg_") {
            return Err(format!("禁止删除系统数据库：{db_name}"));
        }
    }
    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            sqlx::query(&tag_sql(&format!("DROP DATABASE IF EXISTS {}", q_mysql(&db_name))))
                .execute(&mut conn).await
                .map_err(|e| format!("删除数据库失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            sqlx::query(&tag_sql(&format!("DROP DATABASE IF EXISTS {}", q_dq(&db_name))))
                .execute(&mut conn).await
                .map_err(|e| format!("删除数据库失败: {e}"))?;
            Ok(())
        }
        _ => Err("此连接类型不支持删除数据库".into()),
    }
}

// ── 19. db_explain (E3 EXPLAIN 执行计划) ──────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRow {
    pub id:            Option<String>,
    pub select_type:   Option<String>,
    pub table:         Option<String>,
    pub partitions:    Option<String>,
    pub access_type:   Option<String>,
    pub possible_keys: Option<String>,
    pub key:           Option<String>,
    pub key_len:       Option<String>,
    pub r#ref:         Option<String>,
    pub rows:          Option<String>,
    pub filtered:      Option<String>,
    pub extra:         Option<String>,
    pub is_danger:     bool,   // ALL/index/filesort/temporary
}

#[tauri::command]
pub async fn db_explain(
    id:     String,
    sql_text: String,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<ExplainRow>, String> {
    if sql_text.trim().is_empty() { return Err("SQL 不能为空".into()); }
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let explain_sql = format!("EXPLAIN {}", sql_text.trim());
            let rows = sqlx::query(&tag_sql(&explain_sql)).fetch_all(&mut conn).await
                .map_err(|e| format!("EXPLAIN 执行失败: {e}"))?;
            Ok(rows.iter().map(|r| {
                let access_type   = r.try_get::<Option<String>, _>("type").ok().flatten();
                let extra         = r.try_get::<Option<String>, _>("Extra").ok().flatten();
                let is_danger = access_type.as_deref().map(|t| matches!(t, "ALL" | "index")).unwrap_or(false)
                    || extra.as_deref().map(|e| e.contains("filesort") || e.contains("temporary")).unwrap_or(false);
                ExplainRow {
                    id:            r.try_get::<Option<i64>, _>("id").ok().flatten().map(|v| v.to_string()),
                    select_type:   r.try_get::<Option<String>, _>("select_type").ok().flatten(),
                    table:         r.try_get::<Option<String>, _>("table").ok().flatten(),
                    partitions:    r.try_get::<Option<String>, _>("partitions").ok().flatten(),
                    access_type:   access_type.clone(),
                    possible_keys: r.try_get::<Option<String>, _>("possible_keys").ok().flatten(),
                    key:           r.try_get::<Option<String>, _>("key").ok().flatten(),
                    key_len:       r.try_get::<Option<String>, _>("key_len").ok().flatten(),
                    r#ref:         r.try_get::<Option<String>, _>("ref").ok().flatten(),
                    rows:          r.try_get::<Option<i64>, _>("rows").ok().flatten().map(|v| v.to_string()),
                    filtered:      r.try_get::<Option<f64>, _>("filtered").ok().flatten().map(|v| format!("{v:.1}%")),
                    extra:         extra.clone(),
                    is_danger,
                }
            }).collect())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let explain_sql = format!("EXPLAIN ANALYZE {}", sql_text.trim());
            let rows = sqlx::query(&tag_sql(&explain_sql)).fetch_all(&mut conn).await
                .map_err(|e| format!("EXPLAIN ANALYZE 执行失败: {e}"))?;
            let lines: Vec<String> = rows.iter()
                .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
                .collect();
            // PG EXPLAIN 返回文本行，包装成单行 ExplainRow（每行一条记录）
            Ok(lines.into_iter().enumerate().map(|(i, line)| {
                let is_danger = line.contains("Seq Scan") || line.contains("Sort Method");
                ExplainRow {
                    id: Some((i + 1).to_string()),
                    select_type: None, table: None, partitions: None,
                    access_type: None, possible_keys: None, key: None,
                    key_len: None, r#ref: None, rows: None, filtered: None,
                    extra: Some(line),
                    is_danger,
                }
            }).collect())
        }
        ConnType::Sqlite => {
            use sqlx::{sqlite::SqliteConnection, Connection, Row};
            use crate::commands::query::sqlite_url;
            let url = sqlite_url(&config)?;
            let mut conn = SqliteConnection::connect(&url).await
                .map_err(|e| format!("打开 SQLite 失败: {e}"))?;
            let eqp_sql = format!("EXPLAIN QUERY PLAN {}", sql_text.trim());
            let rows = sqlx::query(&eqp_sql).fetch_all(&mut conn).await
                .map_err(|e| format!("EXPLAIN QUERY PLAN 执行失败: {e}"))?;
            Ok(rows.iter().map(|r| {
                let id:     i64 = r.try_get(0).unwrap_or(0);
                let parent: i64 = r.try_get(1).unwrap_or(0);
                let detail: String = r.try_get(3).unwrap_or_default();
                // 全表扫描：SCAN 且没有 USING (INDEX|COVERING)
                let is_scan = detail.contains("SCAN") && !detail.contains("USING");
                // SQLite 自动建临时索引：性能差，需关注
                let is_auto = detail.contains("AUTO INDEX");
                let is_danger = is_scan || is_auto;
                ExplainRow {
                    id:            Some(id.to_string()),
                    select_type:   Some(parent.to_string()),  // 复用 select_type 存 parent id
                    table:         None, partitions: None, access_type: None,
                    possible_keys: None, key: None, key_len: None,
                    r#ref: None, rows: None, filtered: None,
                    extra: Some(detail),
                    is_danger,
                }
            }).collect())
        }
        ConnType::Duckdb => {
            // DD1.6: DuckDB EXPLAIN ANALYZE，输出文本行，复用 PG 路径渲染
            let explain_sql = format!("EXPLAIN ANALYZE {}", sql_text.trim());
            let result = dispatch_duck_query(&id, &config, &explain_sql, &duck_pool, &registry).await?;
            Ok(result.rows.into_iter().enumerate().map(|(i, row)| {
                let line = row.into_iter().filter_map(|v| v).collect::<Vec<_>>().join(" ");
                let is_danger = line.contains("SEQ_SCAN") || line.contains("Index Scan (No Statistics)");
                ExplainRow {
                    id: Some((i + 1).to_string()),
                    select_type: None, table: None, partitions: None,
                    access_type: None, possible_keys: None, key: None,
                    key_len: None, r#ref: None, rows: None, filtered: None,
                    extra: Some(line),
                    is_danger,
                }
            }).collect())
        }
        ConnType::Oracle => {
            // OR1.5: 两步 EXPLAIN PLAN（EXPLAIN PLAN FOR + DBMS_XPLAN.DISPLAY）
            let lines = super::oracle::oracle_explain_plan_impl(config, sql_text, password, &*registry).await?;
            Ok(lines.into_iter().enumerate().map(|(i, line)| {
                let is_danger = line.contains("TABLE ACCESS FULL") || line.contains("INDEX FAST FULL SCAN");
                ExplainRow {
                    id: Some((i + 1).to_string()),
                    select_type: None, table: None, partitions: None,
                    access_type: None, possible_keys: None, key: None,
                    key_len: None, r#ref: None, rows: None, filtered: None,
                    extra: Some(line),
                    is_danger,
                }
            }).collect())
        }
        _ => Err("此连接类型不支持 EXPLAIN".into()),
    }
}

// ── 20. db_slow_queries (F3 慢查询) ───────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowQueryEntry {
    pub query:              String,
    pub exec_count:         u64,
    pub total_time_ms:      f64,
    pub avg_time_ms:        f64,
    pub max_time_ms:        f64,
    pub rows_sent:          u64,
    pub rows_examined:      u64,
    // PG5.2 — shared buffer hit rate (None for non-PG)
    pub shared_blks_hit:    Option<u64>,
    pub shared_blks_read:   Option<u64>,
}

#[tauri::command]
pub async fn db_slow_queries(
    id:     String,
    limit:  u64,
    storage: State<'_, StorageState>,
) -> Result<Vec<SlowQueryEntry>, String> {
    let lim = limit.clamp(1, 200);
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            // 使用 performance_schema.events_statements_summary_by_digest（5.7+ 默认开启）
            let sql = format!(
                "SELECT DIGEST_TEXT AS query, \
                        COUNT_STAR AS exec_count, \
                        SUM_TIMER_WAIT / 1000000000 AS total_time_ms, \
                        AVG_TIMER_WAIT / 1000000000 AS avg_time_ms, \
                        MAX_TIMER_WAIT / 1000000000 AS max_time_ms, \
                        SUM_ROWS_SENT AS rows_sent, \
                        SUM_ROWS_EXAMINED AS rows_examined \
                 FROM performance_schema.events_statements_summary_by_digest \
                 WHERE DIGEST_TEXT IS NOT NULL \
                 ORDER BY SUM_TIMER_WAIT DESC \
                 LIMIT {lim}"
            );
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("获取慢查询失败（需要 performance_schema）: {e}"))?;
            Ok(rows.iter().map(|r| SlowQueryEntry {
                query:            r.try_get::<String, _>(0).unwrap_or_default(),
                exec_count:       r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64,
                total_time_ms:    r.try_get::<f64, _>(2).unwrap_or(0.0),
                avg_time_ms:      r.try_get::<f64, _>(3).unwrap_or(0.0),
                max_time_ms:      r.try_get::<f64, _>(4).unwrap_or(0.0),
                rows_sent:        r.try_get::<i64, _>(5).unwrap_or(0).max(0) as u64,
                rows_examined:    r.try_get::<i64, _>(6).unwrap_or(0).max(0) as u64,
                shared_blks_hit:  None,
                shared_blks_read: None,
            }).collect())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let sql = format!(
                "SELECT query, calls, total_exec_time, \
                        total_exec_time / NULLIF(calls, 0) AS avg_ms, \
                        max_exec_time, rows, \
                        shared_blks_hit, shared_blks_read \
                 FROM pg_stat_statements \
                 ORDER BY total_exec_time DESC \
                 LIMIT {lim}"
            );
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("获取慢查询失败（需要 pg_stat_statements 扩展）: {e}"))?;
            Ok(rows.iter().map(|r| SlowQueryEntry {
                query:            r.try_get::<String, _>(0).unwrap_or_default(),
                exec_count:       r.try_get::<i64, _>(1).unwrap_or(0).max(0) as u64,
                total_time_ms:    r.try_get::<f64, _>(2).unwrap_or(0.0),
                avg_time_ms:      r.try_get::<Option<f64>, _>(3).ok().flatten().unwrap_or(0.0),
                max_time_ms:      r.try_get::<f64, _>(4).unwrap_or(0.0),
                rows_sent:        r.try_get::<i64, _>(5).unwrap_or(0).max(0) as u64,
                rows_examined:    0,
                shared_blks_hit:  Some(r.try_get::<i64, _>(6).unwrap_or(0).max(0) as u64),
                shared_blks_read: Some(r.try_get::<i64, _>(7).unwrap_or(0).max(0) as u64),
            }).collect())
        }
        _ => Err("此连接类型不支持慢查询查看".into()),
    }
}

// ── 21. db_list_users (F4 用户权限只读) ──────────────────────────────────────

/// 读 MySQL 行的字符串列：mysql.user 的 User/plugin 等列常为 utf8mb3 字符集，
/// sqlx 的 try_get::<String> 可能解不出 → 回退按字节读再 UTF-8 转换，避免显示成空。
fn mysql_row_str(row: &sqlx::mysql::MySqlRow, idx: usize) -> String {
    use sqlx::Row;
    row.try_get::<String, _>(idx)
        .or_else(|_| row.try_get::<Vec<u8>, _>(idx).map(|b| String::from_utf8_lossy(&b).into_owned()))
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEntry {
    pub name:             String,
    pub host:             String,
    pub auth_plugin:      String,
    pub password_expired: bool,
    pub account_locked:   bool,
    pub super_priv:       bool,
    pub grants:           Vec<String>,
}

/// 无 mysql.user 读取权限时（托管/共享实例常见，错误 1142）的降级：
/// 仅返回当前登录账号——`SELECT CURRENT_USER()` 与 `SHOW GRANTS`（针对自身）始终可用。
async fn mysql_current_user_only(
    conn: &mut sqlx::mysql::MySqlConnection,
) -> Result<Vec<UserEntry>, String> {
    use sqlx::Row;
    let cur = sqlx::query("SELECT CURRENT_USER()").fetch_one(&mut *conn).await
        .map_err(|e| e.to_string())?;
    let cu: String = cur.try_get::<String, _>(0).unwrap_or_default();
    let (name, host) = match cu.split_once('@') {
        Some((u, h)) => (u.to_string(), h.to_string()),
        None => (cu.clone(), String::new()),
    };
    // SHOW GRANTS 不带 FOR 子句即为当前账号，无需 mysql.user 权限
    let grants: Vec<String> = match sqlx::query("SHOW GRANTS").fetch_all(&mut *conn).await {
        Ok(grs) => grs.iter().filter_map(|g| g.try_get::<String, _>(0).ok()).collect(),
        Err(_) => vec!["(无权限查看)".to_string()],
    };
    let super_priv = grants.iter().any(|g| {
        let up = g.to_uppercase();
        up.contains("ALL PRIVILEGES ON *.*") || up.contains("SUPER")
    });
    Ok(vec![UserEntry {
        name, host,
        auth_plugin: String::new(),
        password_expired: false,
        account_locked: false,
        super_priv,
        grants,
    }])
}

#[tauri::command]
pub async fn db_list_users(
    id:     String,
    storage: State<'_, StorageState>,
) -> Result<Vec<UserEntry>, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            // MariaDB 的 mysql.user 无 account_locked 列（MySQL 5.7+ 专有），
            // 锁定状态存于 mysql.global_priv 的 JSON（$.account_locked），需单独适配。
            let is_maria = matches!(config.conn_type, ConnType::Mariadb);
            let sql = if is_maria {
                "SELECT u.User, u.Host, u.plugin, u.password_expired, \
                        COALESCE(JSON_VALUE(gp.Priv, '$.account_locked'), 'false') AS account_locked, \
                        u.Super_priv \
                 FROM mysql.user u \
                 LEFT JOIN mysql.global_priv gp ON gp.User = u.User AND gp.Host = u.Host \
                 ORDER BY u.User, u.Host"
            } else {
                "SELECT User, Host, plugin, password_expired, account_locked, Super_priv \
                 FROM mysql.user ORDER BY User, Host"
            };
            let rows = match sqlx::query(sql).fetch_all(&mut conn).await {
                Ok(r) => r,
                // 读不到 mysql.user（如 1142 权限不足）：降级为仅展示当前登录账号
                Err(_) => return mysql_current_user_only(&mut conn).await,
            };

            let mut users: Vec<UserEntry> = Vec::new();
            for r in &rows {
                let name             = mysql_row_str(r, 0);
                let host             = mysql_row_str(r, 1);
                let auth_plugin      = mysql_row_str(r, 2);
                let password_expired = mysql_row_str(r, 3);
                let account_locked   = mysql_row_str(r, 4);
                let super_priv       = mysql_row_str(r, 5);
                let grant_sql = format!("SHOW GRANTS FOR '{}'@'{}'",
                    name.replace('\'', "''"), host.replace('\'', "''"));
                let grants: Vec<String> = match sqlx::query(&grant_sql).fetch_all(&mut conn).await {
                    Ok(grs) => grs.iter().filter_map(|g| g.try_get::<String, _>(0).ok()).collect(),
                    Err(_) => vec!["(无权限查看)".to_string()],
                };
                users.push(UserEntry {
                    name,
                    host,
                    auth_plugin,
                    password_expired: password_expired.eq_ignore_ascii_case("Y"),
                    // MySQL 用 'Y'/'N'；MariaDB 的 JSON 值为 'true'/'1'
                    account_locked:   account_locked.eq_ignore_ascii_case("Y")
                                        || account_locked.eq_ignore_ascii_case("true")
                                        || account_locked == "1",
                    super_priv:       super_priv.eq_ignore_ascii_case("Y"),
                    grants,
                });
            }
            Ok(users)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let rows = sqlx::query(
                "SELECT rolname, rolsuper, rolcanlogin, \
                        COALESCE((SELECT array_to_string(array_agg(privilege_type || ' ON ' || table_schema || '.' || table_name), '; ') \
                                  FROM information_schema.role_table_grants \
                                  WHERE grantee = pg_roles.rolname LIMIT 1), '') \
                 FROM pg_roles ORDER BY rolname"
            ).fetch_all(&mut conn).await
             .map_err(|e| format!("获取用户列表失败: {e}"))?;
            Ok(rows.iter().map(|r| {
                let name:       String = r.try_get(0).unwrap_or_default();
                let super_priv: bool   = r.try_get(1).unwrap_or(false);
                let can_login:  bool   = r.try_get(2).unwrap_or(false);
                let grant_str:  String = r.try_get(3).unwrap_or_default();
                let grants = if grant_str.is_empty() { vec![] } else { vec![grant_str] };
                UserEntry {
                    name,
                    host: String::new(),
                    auth_plugin: String::new(),
                    password_expired: false,
                    account_locked: !can_login,
                    super_priv,
                    grants,
                }
            }).collect())
        }
        _ => Err("此连接类型不支持用户管理".into()),
    }
}

// ── 22. db_health_check (H4 一键健康巡检) ────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthItem {
    pub category:    String,
    pub name:        String,
    pub status:      String, // "ok" | "warn" | "error"
    pub detail:      String,
    pub suggestion:  String,
}

#[tauri::command]
pub async fn db_health_check(
    id:     String,
    schema: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<HealthItem>, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let mut items: Vec<HealthItem> = Vec::new();

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() {
                // use current database
                let r = sqlx::query("SELECT DATABASE()").fetch_one(&mut conn).await
                    .map_err(|e| format!("获取当前库失败: {e}"))?;
                r.try_get::<Option<String>, _>(0).unwrap_or(None).unwrap_or_default()
            } else { schema.clone() };

            // 1. 无主键表
            if let Ok(rows) = sqlx::query(
                "SELECT TABLE_NAME FROM information_schema.TABLES t \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c \
                     WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA \
                       AND c.TABLE_NAME = t.TABLE_NAME \
                       AND c.CONSTRAINT_TYPE = 'PRIMARY KEY' \
                   )",
            ).bind(&schema_name).fetch_all(&mut conn).await {
                let names: Vec<String> = rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                let status = if names.is_empty() { "ok" } else { "warn" };
                items.push(HealthItem {
                    category:   "结构".into(),
                    name:       "无主键表".into(),
                    status:     status.into(),
                    detail:     if names.is_empty() { "全部表均有主键".into() }
                                else { format!("发现 {} 张无主键表: {}", names.len(), names.join(", ")) },
                    suggestion: "为无主键表添加主键，避免行数据无法唯一定位".into(),
                });
            }

            // 2. 碎片率高 (data_free / data_length > 20%)
            if let Ok(rows) = sqlx::query(
                "SELECT TABLE_NAME, DATA_FREE, DATA_LENGTH FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND ENGINE = 'InnoDB' \
                   AND DATA_LENGTH > 0 AND DATA_FREE/DATA_LENGTH > 0.2 \
                 ORDER BY DATA_FREE DESC LIMIT 10",
            ).bind(&schema_name).fetch_all(&mut conn).await {
                let frags: Vec<String> = rows.iter().map(|r| {
                    let name: String = r.try_get(0).unwrap_or_default();
                    let free: u64    = r.try_get(1).unwrap_or(0);
                    let len: u64     = r.try_get(2).unwrap_or(1);
                    format!("{} ({}%)", name, free * 100 / len.max(1))
                }).collect();
                let status = if frags.is_empty() { "ok" } else { "warn" };
                items.push(HealthItem {
                    category:   "性能".into(),
                    name:       "高碎片表".into(),
                    status:     status.into(),
                    detail:     if frags.is_empty() { "无高碎片表".into() }
                                else { format!("发现 {} 张碎片率 >20% 的表: {}", frags.len(), frags.join(", ")) },
                    suggestion: "执行 OPTIMIZE TABLE 重整表数据".into(),
                });
            }

            // 3. 长事务 (>60s)
            if let Ok(rows) = sqlx::query(
                "SELECT COUNT(*) FROM information_schema.INNODB_TRX \
                 WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 60",
            ).fetch_one(&mut conn).await {
                let cnt: i64 = rows.try_get(0).unwrap_or(0);
                items.push(HealthItem {
                    category:   "事务".into(),
                    name:       "长事务 (>60s)".into(),
                    status:     if cnt == 0 { "ok" } else { "warn" }.into(),
                    detail:     if cnt == 0 { "无长事务".into() }
                                else { format!("发现 {cnt} 个运行超 60 秒的事务") },
                    suggestion: "检查并终止长期阻塞的事务".into(),
                });
            }

            // 4. 慢查询比例 (slow_queries / questions)
            if let Ok(row) = sqlx::query(
                "SELECT VARIABLE_VALUE FROM performance_schema.global_status \
                 WHERE VARIABLE_NAME = 'Slow_queries'",
            ).fetch_one(&mut conn).await {
                let slow: u64 = row.try_get::<String, _>(0).unwrap_or_default().parse().unwrap_or(0);
                let status = if slow < 100 { "ok" } else if slow < 1000 { "warn" } else { "error" };
                items.push(HealthItem {
                    category:   "性能".into(),
                    name:       "慢查询数".into(),
                    status:     status.into(),
                    detail:     format!("自实例启动以来共 {slow} 次慢查询"),
                    suggestion: "开启慢日志分析，为高频慢查询建索引".into(),
                });
            }

            // 5. 连接使用率
            if let Ok(row) = sqlx::query(
                "SELECT (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected'), \
                        (SELECT VARIABLE_VALUE FROM performance_schema.global_variables WHERE VARIABLE_NAME = 'max_connections')",
            ).fetch_one(&mut conn).await {
                let conn_cur: u64 = row.try_get::<String, _>(0).unwrap_or_default().parse().unwrap_or(0);
                let conn_max: u64 = row.try_get::<String, _>(1).unwrap_or_default().parse().unwrap_or(100);
                let pct = conn_cur * 100 / conn_max.max(1);
                let status = if pct < 70 { "ok" } else if pct < 90 { "warn" } else { "error" };
                items.push(HealthItem {
                    category:   "连接".into(),
                    name:       "连接使用率".into(),
                    status:     status.into(),
                    detail:     format!("当前连接 {conn_cur} / 最大 {conn_max} ({pct}%)"),
                    suggestion: "连接数超 90% 时应使用连接池或增大 max_connections".into(),
                });
            }

            // 6. 冗余索引（同一表有两个索引前缀相同）
            if let Ok(rows) = sqlx::query(
                "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND SEQ_IN_INDEX = 1 \
                 GROUP BY TABLE_NAME, COLUMN_NAME \
                 HAVING COUNT(*) > 1 LIMIT 10",
            ).bind(&schema_name).fetch_all(&mut conn).await {
                let dup: Vec<String> = rows.iter().map(|r| {
                    let t: String = r.try_get(0).unwrap_or_default();
                    let col: String = r.try_get(2).unwrap_or_default();
                    format!("{t}.{col}")
                }).collect();
                let status = if dup.is_empty() { "ok" } else { "warn" };
                items.push(HealthItem {
                    category:   "索引".into(),
                    name:       "疑似冗余索引".into(),
                    status:     status.into(),
                    detail:     if dup.is_empty() { "未发现明显冗余索引".into() }
                                else { format!("以下列存在多个以其为首列的索引: {}", dup.join(", ")) },
                    suggestion: "合并或删除冗余索引，降低写操作开销".into(),
                });
            }

            Ok(items)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };

            // 1. 无主键表
            if let Ok(rows) = sqlx::query(
                "SELECT tablename FROM pg_tables t \
                 WHERE schemaname = $1 \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM pg_constraint c \
                     JOIN pg_class cl ON cl.oid = c.conrelid \
                     WHERE cl.relname = t.tablename \
                       AND c.contype = 'p' \
                   )",
            ).bind(schema_name).fetch_all(&mut conn).await {
                let names: Vec<String> = rows.iter().filter_map(|r| r.try_get::<String, _>(0).ok()).collect();
                items.push(HealthItem {
                    category:   "结构".into(),
                    name:       "无主键表".into(),
                    status:     if names.is_empty() { "ok" } else { "warn" }.into(),
                    detail:     if names.is_empty() { "全部表均有主键".into() }
                                else { format!("发现 {} 张无主键表: {}", names.len(), names.join(", ")) },
                    suggestion: "为无主键表添加主键".into(),
                });
            }

            // 2. 表膨胀（dead_tup_ratio > 20%）
            if let Ok(rows) = sqlx::query(
                "SELECT relname, n_dead_tup, n_live_tup FROM pg_stat_user_tables \
                 WHERE schemaname = $1 AND n_live_tup > 0 \
                   AND n_dead_tup::float / (n_live_tup + n_dead_tup) > 0.2 \
                 ORDER BY n_dead_tup DESC LIMIT 10",
            ).bind(schema_name).fetch_all(&mut conn).await {
                let bloat: Vec<String> = rows.iter().map(|r| {
                    let name: String = r.try_get(0).unwrap_or_default();
                    let dead: i64    = r.try_get(1).unwrap_or(0);
                    let live: i64    = r.try_get(2).unwrap_or(1);
                    format!("{} ({}%)", name, dead * 100 / (live + dead).max(1))
                }).collect();
                items.push(HealthItem {
                    category:   "性能".into(),
                    name:       "表膨胀 (dead tuples >20%)".into(),
                    status:     if bloat.is_empty() { "ok" } else { "warn" }.into(),
                    detail:     if bloat.is_empty() { "无膨胀表".into() }
                                else { format!("发现 {} 张膨胀表: {}", bloat.len(), bloat.join(", ")) },
                    suggestion: "对膨胀表执行 VACUUM ANALYZE 或 VACUUM FULL".into(),
                });
            }

            // 3. 长事务
            if let Ok(row) = sqlx::query(
                "SELECT COUNT(*) FROM pg_stat_activity \
                 WHERE state = 'active' AND query_start < NOW() - INTERVAL '60 seconds' \
                   AND pid <> pg_backend_pid()",
            ).fetch_one(&mut conn).await {
                let cnt: i64 = row.try_get(0).unwrap_or(0);
                items.push(HealthItem {
                    category:   "事务".into(),
                    name:       "长事务 (>60s)".into(),
                    status:     if cnt == 0 { "ok" } else { "warn" }.into(),
                    detail:     if cnt == 0 { "无长事务".into() }
                                else { format!("发现 {cnt} 个运行超 60 秒的查询") },
                    suggestion: "使用 pg_terminate_backend() 终止长事务".into(),
                });
            }

            // 4. 连接使用率
            if let Ok(row) = sqlx::query(
                "SELECT numbackends, \
                        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') \
                 FROM pg_stat_database WHERE datname = current_database()",
            ).fetch_one(&mut conn).await {
                let cur: i64 = row.try_get(0).unwrap_or(0);
                let max: i64 = row.try_get(1).unwrap_or(100);
                let pct = cur * 100 / max.max(1);
                let status = if pct < 70 { "ok" } else if pct < 90 { "warn" } else { "error" };
                items.push(HealthItem {
                    category:   "连接".into(),
                    name:       "连接使用率".into(),
                    status:     status.into(),
                    detail:     format!("当前连接 {cur} / 最大 {max} ({pct}%)"),
                    suggestion: "连接数超 90% 时使用 PgBouncer 等连接池".into(),
                });
            }

            Ok(items)
        }
        _ => Err("此连接类型不支持健康巡检".into()),
    }
}

// ── 23. db_drop_routine (R3 删除存储过程/函数) ───────────────────────────────

#[tauri::command]
pub async fn db_drop_routine(
    id:           String,
    schema:       String,
    name:         String,
    routine_type: String, // "PROCEDURE" | "FUNCTION"
    storage:      State<'_, StorageState>,
) -> Result<(), String> {
    let kind = match routine_type.to_uppercase().as_str() {
        "PROCEDURE" => "PROCEDURE",
        "FUNCTION"  => "FUNCTION",
        other => return Err(format!("不支持的例程类型: {other}")),
    };
    let (config, password) = load_conn(&id, &storage).await?;
    ensure_writable(&config)?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let qualified = if schema.is_empty() { q_mysql(&name) }
                            else { format!("{}.{}", q_mysql(&schema), q_mysql(&name)) };
            let sql = tag_sql(&format!("DROP {kind} IF EXISTS {qualified}"));
            sqlx::query(&sql).execute(&mut conn).await
                .map_err(|e| format!("删除 {kind} 失败: {e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let qualified = format!("{}.{}", q_dq(schema_name), q_dq(&name));
            let sql = tag_sql(&format!("DROP {kind} IF EXISTS {qualified}"));
            sqlx::query(&sql).execute(&mut conn).await
                .map_err(|e| format!("删除 {kind} 失败: {e}"))?;
            Ok(())
        }
        _ => Err("此连接类型不支持删除例程".into()),
    }
}

// ── 23. db_call_procedure (R3 执行存储过程) ──────────────────────────────────

#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub struct ProcParam {
    pub name:  String,
    pub value: String,
}

#[tauri::command]
pub async fn db_call_procedure(
    id:     String,
    schema: String,
    name:   String,
    params: Vec<ProcParam>,
    storage: State<'_, StorageState>,
) -> Result<serde_json::Value, String> {
    let (config, password) = load_conn(&id, &storage).await?;
    let param_values: Vec<&str> = params.iter().map(|p| p.value.as_str()).collect();

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::Row;
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let qualified = if schema.is_empty() { q_mysql(&name) }
                            else { format!("{}.{}", q_mysql(&schema), q_mysql(&name)) };
            let placeholders = (0..param_values.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = tag_sql(&format!("CALL {qualified}({placeholders})"));
            let mut q = sqlx::query(&sql);
            for v in &param_values { q = q.bind(v); }
            // CALL may return result sets; execute and capture rows from first result
            let rows = q.fetch_all(&mut conn).await.map_err(|e| format!("执行存储过程失败: {e}"))?;
            let result: Vec<serde_json::Value> = rows.iter().map(|r| {
                let mut obj = serde_json::Map::new();
                for i in 0..r.len() {
                    let val: String = r.try_get(i).unwrap_or_else(|_| "NULL".to_string());
                    obj.insert(format!("col{i}"), serde_json::Value::String(val));
                }
                serde_json::Value::Object(obj)
            }).collect();
            Ok(serde_json::json!({ "rows": result, "message": format!("执行成功，返回 {} 行", result.len()) }))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::Row;
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let qualified = format!("{}.{}", q_dq(schema_name), q_dq(&name));
            let placeholders = (1..=param_values.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
            let sql = tag_sql(&format!("CALL {qualified}({placeholders})"));
            let mut q = sqlx::query(&sql);
            for v in &param_values { q = q.bind(v); }
            let rows = q.fetch_all(&mut conn).await.map_err(|e| format!("执行存储过程失败: {e}"))?;
            let result: Vec<serde_json::Value> = rows.iter().map(|r| {
                let mut obj = serde_json::Map::new();
                for i in 0..r.len() {
                    let val: String = r.try_get(i).unwrap_or_else(|_| "NULL".to_string());
                    obj.insert(format!("col{i}"), serde_json::Value::String(val));
                }
                serde_json::Value::Object(obj)
            }).collect();
            Ok(serde_json::json!({ "rows": result, "message": format!("执行成功，返回 {} 行", result.len()) }))
        }
        _ => Err("此连接类型不支持执行存储过程".into()),
    }
}

// ── 25. db_verify_migration (Q6 迁移后校验) ──────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyTableResult {
    pub table:       String,
    pub src_count:   i64,
    pub dst_count:   i64,
    pub count_match: bool,
    pub sample_ok:   bool,
    pub error:       Option<String>,
}

#[tauri::command]
pub async fn db_verify_migration(
    src_id:     String,
    src_schema: String,
    dst_id:     String,
    dst_schema: String,
    tables:     Vec<String>,
    storage:    State<'_, StorageState>,
    duck_pool:  State<'_, DuckPool>,
    registry:   State<'_, super::driver::DriverRegistry>,
) -> Result<Vec<VerifyTableResult>, String> {
    let (src_cfg, src_pwd) = load_conn(&src_id, &storage).await?;
    let (dst_cfg, dst_pwd) = load_conn(&dst_id, &storage).await?;

    let mut results: Vec<VerifyTableResult> = Vec::new();

    for table in &tables {
        let result = verify_one_table(
            &src_cfg, src_pwd.as_deref(), &src_schema,
            &dst_cfg, dst_pwd.as_deref(), &dst_schema,
            table,
            &duck_pool, &registry,
        ).await;
        results.push(result);
    }

    Ok(results)
}

async fn verify_one_table(
    src_cfg: &ConnConfig, src_pwd: Option<&str>, src_schema: &str,
    dst_cfg: &ConnConfig, dst_pwd: Option<&str>, dst_schema: &str,
    table: &str,
    duck_pool: &DuckPool, registry: &super::driver::DriverRegistry,
) -> VerifyTableResult {
    // Count from source
    let src_count = match get_table_count(src_cfg, src_pwd, src_schema, table, duck_pool, registry).await {
        Ok(n) => n,
        Err(e) => return VerifyTableResult {
            table: table.to_string(), src_count: -1, dst_count: -1,
            count_match: false, sample_ok: false,
            error: Some(format!("源库计数失败: {e}")),
        },
    };

    // Count from dest
    let dst_count = match get_table_count(dst_cfg, dst_pwd, dst_schema, table, duck_pool, registry).await {
        Ok(n) => n,
        Err(e) => return VerifyTableResult {
            table: table.to_string(), src_count, dst_count: -1,
            count_match: false, sample_ok: false,
            error: Some(format!("目标库计数失败: {e}")),
        },
    };

    let count_match = src_count == dst_count;

    VerifyTableResult {
        table: table.to_string(),
        src_count,
        dst_count,
        count_match,
        sample_ok: count_match,
        error: None,
    }
}

async fn get_table_count(
    cfg: &ConnConfig, pwd: Option<&str>, schema: &str, table: &str,
    duck_pool: &DuckPool, registry: &super::driver::DriverRegistry,
) -> Result<i64, String> {
    use sqlx::Row;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(cfg, pwd).await?;
            let target = if schema.is_empty() { q_mysql(table) }
                         else { format!("{}.{}", q_mysql(schema), q_mysql(table)) };
            let sql = format!("SELECT COUNT(*) FROM {target}");
            let row = sqlx::query(&sql).fetch_one(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            Ok(row.try_get::<i64, _>(0).unwrap_or(0))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(cfg, pwd).await?;
            let schema_name = if schema.is_empty() { "public" } else { schema };
            let sql = format!("SELECT COUNT(*) FROM {}.{}", q_dq(schema_name), q_dq(table));
            let row = sqlx::query(&sql).fetch_one(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            Ok(row.try_get::<i64, _>(0).unwrap_or(0))
        }
        ConnType::Sqlite => {
            use crate::commands::query::sqlite_url;
            use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
            let url = sqlite_url(cfg)?;
            let opts = url.parse::<SqliteConnectOptions>().map_err(|e| e.to_string())?
                .read_only(true);
            let mut conn = opts.connect().await.map_err(|e| e.to_string())?;
            let sql = format!("SELECT COUNT(*) FROM {}", q_dq(table));
            let row = sqlx::query(&sql).fetch_one(&mut conn).await.map_err(|e| format!("{e}"))?;
            Ok(row.try_get::<i64, _>(0).unwrap_or(0))
        }
        ConnType::Duckdb => {
            let target = if schema.is_empty() { q_dq(table) } else { format!("{}.{}", q_dq(schema), q_dq(table)) };
            let result = dispatch_duck_query(&cfg.id, cfg, &format!("SELECT COUNT(*) FROM {target}"), duck_pool, registry).await?;
            let count = result.rows.first().and_then(|r| r.first())
                .and_then(|v| v.as_deref()).and_then(|s| s.parse().ok()).unwrap_or(0);
            Ok(count)
        }
        _ => Err("不支持的连接类型".into()),
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// H2 — 主从复制状态
// ══════════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationStatus {
    pub is_replica:       bool,
    pub replica_running:  bool,
    pub source_host:      String,
    pub source_port:      u16,
    pub replica_io_state: String,
    pub lag_seconds:      Option<f64>,
    pub binlog_file:      String,
    pub binlog_pos:       u64,
    pub error_msg:        String,
    /// For PG: streaming replication
    pub sent_lsn:         String,
    pub replay_lsn:       String,
}

#[tauri::command]
pub async fn db_replication_status(
    id:      String,
    storage: State<'_, StorageState>,
) -> Result<ReplicationStatus, String> {
    use sqlx::Row;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            // Try SHOW REPLICA STATUS first (8.0.22+), fall back to SHOW SLAVE STATUS
            let rows_result = sqlx::query("SHOW REPLICA STATUS").fetch_all(&mut conn).await;
            let rows = match rows_result {
                Ok(r) => r,
                Err(_) => sqlx::query("SHOW SLAVE STATUS").fetch_all(&mut conn).await
                    .map_err(|e| format!("{e}"))?,
            };
            if rows.is_empty() {
                return Ok(ReplicationStatus { is_replica: false, ..Default::default() });
            }
            let row = &rows[0];
            let get_str = |col: &str| row.try_get::<Option<String>, _>(col).ok().flatten().unwrap_or_default();
            let get_u16 = |col: &str| row.try_get::<Option<u16>, _>(col).ok().flatten().unwrap_or(0);
            let get_u64 = |col: &str| row.try_get::<Option<u64>, _>(col).ok().flatten().unwrap_or(0);
            let io_run  = get_str("Replica_IO_Running").to_ascii_uppercase() == "YES"
                || get_str("Slave_IO_Running").to_ascii_uppercase() == "YES";
            let sql_run = get_str("Replica_SQL_Running").to_ascii_uppercase() == "YES"
                || get_str("Slave_SQL_Running").to_ascii_uppercase() == "YES";
            let lag_str = row.try_get::<Option<f64>, _>("Seconds_Behind_Source").ok().flatten()
                .or_else(|| row.try_get::<Option<f64>, _>("Seconds_Behind_Master").ok().flatten());
            let err1 = get_str("Last_IO_Error");
            let err2 = get_str("Last_SQL_Error");
            let error_msg = if !err1.is_empty() { err1 } else { err2 };
            let source_host = get_str("Source_Host").max(get_str("Master_Host"));
            let source_port = if get_u16("Source_Port") > 0 { get_u16("Source_Port") } else { get_u16("Master_Port") };
            let binlog_file = get_str("Relay_Source_Log_File").max(get_str("Relay_Master_Log_File"));
            Ok(ReplicationStatus {
                is_replica: true,
                replica_running: io_run && sql_run,
                source_host,
                source_port,
                replica_io_state: get_str("Replica_IO_State").max(get_str("Slave_IO_State")),
                lag_seconds: lag_str,
                binlog_file,
                binlog_pos: get_u64("Exec_Source_Log_Pos").max(get_u64("Exec_Master_Log_Pos")),
                error_msg,
                sent_lsn: String::new(),
                replay_lsn: String::new(),
            })
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            // Check if this is a standby
            let is_standby: bool = sqlx::query("SELECT pg_is_in_recovery()")
                .fetch_one(&mut conn).await.map_err(|e| format!("{e}"))?
                .try_get::<bool, _>(0).unwrap_or(false);
            if !is_standby {
                return Ok(ReplicationStatus { is_replica: false, ..Default::default() });
            }
            let row = sqlx::query(
                "SELECT sent_lsn::text, replay_lsn::text,
                        EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag_s
                 FROM pg_stat_replication LIMIT 1"
            ).fetch_optional(&mut conn).await.map_err(|e| format!("{e}"))?;
            let (sent_lsn, replay_lsn, lag_s) = match row {
                Some(r) => (
                    r.try_get::<String, _>(0).unwrap_or_default(),
                    r.try_get::<String, _>(1).unwrap_or_default(),
                    r.try_get::<Option<f64>, _>(2).ok().flatten(),
                ),
                None => (String::new(), String::new(), None),
            };
            Ok(ReplicationStatus {
                is_replica: true,
                replica_running: true,
                source_host: String::new(),
                source_port: 0,
                replica_io_state: "streaming".into(),
                lag_seconds: lag_s,
                binlog_file: String::new(),
                binlog_pos: 0,
                error_msg: String::new(),
                sent_lsn,
                replay_lsn,
            })
        }
        _ => Err("不支持的连接类型".into()),
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// G4 — 备份完整性校验（逐表行数对比）
// ══════════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupIntegrityItem {
    pub table:        String,
    pub db_count:     i64,
    pub backup_count: i64,
    pub match_ok:     bool,
    pub error:        Option<String>,
}

#[tauri::command]
pub async fn db_backup_integrity(
    id:          String,
    schema:      String,
    backup_path: String,
    storage:     State<'_, StorageState>,
    duck_pool:   State<'_, DuckPool>,
    registry:    State<'_, super::driver::DriverRegistry>,
) -> Result<Vec<BackupIntegrityItem>, String> {
    validate_path(&backup_path)?;
    // Parse the backup file to count INSERT statements per table
    let content = std::fs::read_to_string(&backup_path)
        .map_err(|e| format!("无法读取备份文件: {e}"))?;

    let mut backup_counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for line in content.lines() {
        let upper = line.trim_start().to_ascii_uppercase();
        if upper.starts_with("INSERT INTO ") {
            // Extract table name: INSERT INTO `table` or INSERT INTO table
            if let Some(rest) = upper.strip_prefix("INSERT INTO ") {
                let tbl = rest.trim_start_matches('`').trim_start_matches('"')
                    .split(|c: char| c == '`' || c == '"' || c == ' ' || c == '(')
                    .next().unwrap_or("").to_ascii_lowercase();
                if !tbl.is_empty() {
                    *backup_counts.entry(tbl).or_insert(0) += 1;
                }
            }
        }
    }

    if backup_counts.is_empty() {
        return Ok(vec![]);
    }

    let (cfg, pwd) = load_conn(&id, &storage).await?;
    let mut results = Vec::new();
    for (table, backup_count) in &backup_counts {
        let db_count = get_table_count(&cfg, pwd.as_deref(), &schema, table, &duck_pool, &registry).await;
        results.push(match db_count {
            Ok(n) => BackupIntegrityItem {
                table: table.clone(), db_count: n, backup_count: *backup_count,
                match_ok: n == *backup_count, error: None,
            },
            Err(e) => BackupIntegrityItem {
                table: table.clone(), db_count: -1, backup_count: *backup_count,
                match_ok: false, error: Some(e),
            },
        });
    }
    results.sort_by(|a, b| a.table.cmp(&b.table));
    Ok(results)
}

// ══════════════════════════════════════════════════════════════════════════════
// L3 — 序列/自增管理
// ══════════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub table_name:    String,
    pub column_name:   String,
    pub current_value: i64,
    pub seq_name:      Option<String>, // PG only
}

#[tauri::command]
pub async fn db_list_sequences(
    id:      String,
    schema:  String,
    storage: State<'_, StorageState>,
) -> Result<Vec<SequenceInfo>, String> {
    use sqlx::Row;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { cfg.database.as_deref().unwrap_or("") } else { &schema };
            let sql = format!(
                "SELECT TABLE_NAME, AUTO_INCREMENT FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = '{}' AND AUTO_INCREMENT IS NOT NULL ORDER BY TABLE_NAME",
                schema_name.replace('\'', "\\'")
            );
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            let mut out = Vec::new();
            for row in rows {
                let tbl: String = row.try_get(0).unwrap_or_default();
                let ai: Option<u64> = row.try_get(1).unwrap_or(None);
                // Find the auto_increment column
                let col_sql = format!(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' AND EXTRA LIKE '%auto_increment%' LIMIT 1",
                    schema_name.replace('\'', "\\'"),
                    tbl.replace('\'', "\\'")
                );
                let col_row = sqlx::query(&col_sql).fetch_optional(&mut conn).await.ok().flatten();
                let col_name = col_row.map(|r| r.try_get::<String, _>(0).unwrap_or_default()).unwrap_or_default();
                out.push(SequenceInfo {
                    table_name: tbl,
                    column_name: col_name,
                    current_value: ai.map(|v| v as i64).unwrap_or(1),
                    seq_name: None,
                });
            }
            Ok(out)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let sql = "SELECT s.sequence_schema, s.sequence_name, \
                        pg_sequences.last_value, \
                        a.table_name, a.column_name \
                 FROM information_schema.sequences s \
                 JOIN pg_sequences ON pg_sequences.schemaname = s.sequence_schema \
                   AND pg_sequences.sequencename = s.sequence_name \
                 LEFT JOIN information_schema.columns a \
                   ON a.column_default LIKE '%' || s.sequence_name || '%' \
                   AND a.table_schema = s.sequence_schema \
                 WHERE s.sequence_schema = $1 \
                 ORDER BY s.sequence_name";
            let rows = sqlx::query(sql).bind(schema_name).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            let mut out = Vec::new();
            for row in rows {
                let seq_name: String = row.try_get(1).unwrap_or_default();
                let last_val: Option<i64> = row.try_get(2).unwrap_or(None);
                let tbl: Option<String> = row.try_get(3).unwrap_or(None);
                let col: Option<String> = row.try_get(4).unwrap_or(None);
                out.push(SequenceInfo {
                    table_name: tbl.unwrap_or_default(),
                    column_name: col.unwrap_or_default(),
                    current_value: last_val.unwrap_or(1),
                    seq_name: Some(seq_name),
                });
            }
            Ok(out)
        }
        _ => Err("不支持的连接类型".into()),
    }
}

#[tauri::command]
pub async fn db_set_auto_increment(
    id:      String,
    schema:  String,
    table:   String,
    value:   i64,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&table)?;
    if value < 1 {
        return Err("AUTO_INCREMENT 值必须大于等于 1".to_string());
    }
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            validate_ident(&schema)?;
            let target = if schema.is_empty() { q_mysql(&table) } else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            let sql = format!("ALTER TABLE {target} AUTO_INCREMENT = {value}");
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
            Ok(())
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            // table here is the sequence name
            validate_ident(&table)?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let sql = format!("SELECT setval({}.{}, {})", q_dq(schema_name), q_dq(&table), value);
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
            Ok(())
        }
        _ => Err("不支持的连接类型".into()),
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// R4 — 分区表管理
// ══════════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionInfo {
    pub name:            String,
    pub method:          String,
    pub expression:      String,
    pub description:     String,
    pub row_count:       i64,
    pub data_length_mb:  f64,
    pub created_time:    String,
}

#[tauri::command]
pub async fn db_list_partitions(
    id:      String,
    schema:  String,
    table:   String,
    storage: State<'_, StorageState>,
) -> Result<Vec<PartitionInfo>, String> {
    use sqlx::Row;
    validate_ident(&table)?;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { cfg.database.as_deref().unwrap_or("") } else { &schema };
            let sql = format!(
                "SELECT PARTITION_NAME, PARTITION_METHOD, PARTITION_EXPRESSION, \
                        PARTITION_DESCRIPTION, TABLE_ROWS, DATA_LENGTH, CREATE_TIME \
                 FROM information_schema.PARTITIONS \
                 WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' AND PARTITION_NAME IS NOT NULL \
                 ORDER BY PARTITION_ORDINAL_POSITION",
                schema_name.replace('\'', "\\'"),
                table.replace('\'', "\\'")
            );
            let rows = sqlx::query(&sql).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            let mut out = Vec::new();
            for row in rows {
                let name: String         = row.try_get(0).unwrap_or_default();
                let method: String       = row.try_get(1).unwrap_or_default();
                let expr: String         = row.try_get(2).unwrap_or_default();
                let desc: String         = row.try_get(3).unwrap_or_default();
                let rows_: Option<u64>   = row.try_get(4).unwrap_or(None);
                let data: Option<u64>    = row.try_get(5).unwrap_or(None);
                let created: Option<String> = row.try_get(6).unwrap_or(None);
                out.push(PartitionInfo {
                    name,
                    method,
                    expression: expr,
                    description: desc,
                    row_count: rows_.map(|v| v as i64).unwrap_or(0),
                    data_length_mb: data.map(|v| v as f64 / 1_048_576.0).unwrap_or(0.0),
                    created_time: created.unwrap_or_default(),
                });
            }
            Ok(out)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            // Get child partition tables
            let sql = "SELECT child.relname, parent.relname, pg_get_expr(c.relpartbound, c.oid) \
                       FROM pg_inherits \
                       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid \
                       JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid \
                       JOIN pg_class c      ON c.oid = child.oid \
                       JOIN pg_namespace ns ON ns.oid = parent.relnamespace \
                       WHERE parent.relname = $1 AND ns.nspname = $2 \
                       ORDER BY child.relname";
            let rows = sqlx::query(sql).bind(&table).bind(schema_name).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;
            let mut out = Vec::new();
            for row in rows {
                let part_name: String = row.try_get(0).unwrap_or_default();
                let desc: String      = row.try_get(2).unwrap_or_default();
                // get row count for partition
                let cnt_sql = format!("SELECT COUNT(*) FROM {}.{}", q_dq(schema_name), q_dq(&part_name));
                let cnt: i64 = sqlx::query(&cnt_sql).fetch_one(&mut conn).await
                    .ok().map(|r| r.try_get::<i64, _>(0).unwrap_or(0)).unwrap_or(0);
                out.push(PartitionInfo {
                    name: part_name,
                    method: "PARTITION".into(),
                    expression: String::new(),
                    description: desc,
                    row_count: cnt,
                    data_length_mb: 0.0,
                    created_time: String::new(),
                });
            }
            Ok(out)
        }
        _ => Err("不支持的连接类型".into()),
    }
}

#[tauri::command]
pub async fn db_drop_partition(
    id:             String,
    schema:         String,
    table:          String,
    partition_name: String,
    storage:        State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&table)?;
    validate_ident(&partition_name)?;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            validate_ident(&schema)?;
            let tref = if schema.is_empty() { q_mysql(&table) } else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            let sql = format!("ALTER TABLE {tref} DROP PARTITION {}", q_mysql(&partition_name));
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            // In PG, partitions are child tables — DROP the child table
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let sql = format!("DROP TABLE IF EXISTS {}.{}", q_dq(schema_name), q_dq(&partition_name));
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn db_truncate_partition(
    id:             String,
    schema:         String,
    table:          String,
    partition_name: String,
    storage:        State<'_, StorageState>,
) -> Result<(), String> {
    validate_ident(&table)?;
    validate_ident(&partition_name)?;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            validate_ident(&schema)?;
            let tref = if schema.is_empty() { q_mysql(&table) } else { format!("{}.{}", q_mysql(&schema), q_mysql(&table)) };
            let sql = format!("ALTER TABLE {tref} TRUNCATE PARTITION {}", q_mysql(&partition_name));
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };
            let sql = format!("TRUNCATE {}.{}", q_dq(schema_name), q_dq(&partition_name));
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// I4 — 用户权限管理（写操作：建用户/授权/回收/改密）
// ══════════════════════════════════════════════════════════════════════════════

/// 用户名/主机名安全校验（不允许特殊字符）
fn validate_username(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 64 {
        return Err("用户名长度必须在 1-64 字符之间".into());
    }
    if s.chars().any(|c| c == '\'' || c == '"' || c == '\\' || c == '\0') {
        return Err("用户名包含非法字符".into());
    }
    Ok(())
}

fn validate_host(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 60 {
        return Err("主机名长度必须在 1-60 字符之间".into());
    }
    if s.chars().any(|c| c == '\'' || c == '"' || c == '\\' || c == '\0') {
        return Err("主机名包含非法字符".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn db_create_user(
    id:       String,
    username: String,
    host:     String,
    password: String,
    storage:  State<'_, StorageState>,
) -> Result<(), String> {
    validate_username(&username)?;
    validate_host(&host)?;
    if password.is_empty() {
        return Err("密码不能为空".to_string());
    }
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            // Use parameterized user/host literals with MySQL string escaping
            let sql = format!(
                "CREATE USER '{}' @ '{}' IDENTIFIED BY '{}'",
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
                password.replace('\'', "\\'")
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            // PG 默认 standard_conforming_strings=on，字符串字面量用单引号翻倍转义（非 MySQL 反斜杠）
            let sql = format!(
                "CREATE ROLE {} WITH LOGIN PASSWORD '{}'",
                q_dq(&username),
                password.replace('\'', "''")
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn db_drop_user(
    id:       String,
    username: String,
    host:     String,
    storage:  State<'_, StorageState>,
) -> Result<(), String> {
    validate_username(&username)?;
    validate_host(&host)?;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!("DROP USER IF EXISTS '{}'@'{}'",
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!("DROP ROLE IF EXISTS {}", q_dq(&username));
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn db_grant_privilege(
    id:           String,
    username:     String,
    host:         String,
    privilege:    String,
    target:       String,
    grant_option: Option<bool>,
    storage:      State<'_, StorageState>,
) -> Result<String, String> {
    validate_username(&username)?;
    validate_host(&host)?;
    // privilege must be simple keyword(s), no semicolons
    if privilege.contains(';') || privilege.contains('\'') {
        return Err("权限包含非法字符".into());
    }
    // target: *.* or db.* or db.table — validate
    if target.contains(';') || target.contains('\'') {
        return Err("目标包含非法字符".into());
    }
    let with_grant = grant_option.unwrap_or(false);
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    let preview;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!(
                "GRANT {} ON {} TO '{}'@'{}'{}",
                privilege,
                target,
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
                if with_grant { " WITH GRANT OPTION" } else { "" },
            );
            preview = sql.clone();
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
            sqlx::query("FLUSH PRIVILEGES").execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!("GRANT {} ON {} TO {}{}", privilege, target, q_dq(&username),
                if with_grant { " WITH GRANT OPTION" } else { "" });
            preview = sql.clone();
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(preview)
}

/// 锁定 / 解锁账号：MySQL 系 ALTER USER ... ACCOUNT LOCK/UNLOCK；PG 系 ALTER ROLE ... NOLOGIN/LOGIN
#[tauri::command]
pub async fn db_set_user_lock(
    id:       String,
    username: String,
    host:     String,
    locked:   bool,
    storage:  State<'_, StorageState>,
) -> Result<(), String> {
    validate_username(&username)?;
    validate_host(&host)?;
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!(
                "ALTER USER '{}'@'{}' ACCOUNT {}",
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
                if locked { "LOCK" } else { "UNLOCK" },
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!("ALTER ROLE {} {}", q_dq(&username), if locked { "NOLOGIN" } else { "LOGIN" });
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

#[tauri::command]
pub async fn db_revoke_privilege(
    id:        String,
    username:  String,
    host:      String,
    privilege: String,
    target:    String,
    storage:   State<'_, StorageState>,
) -> Result<String, String> {
    validate_username(&username)?;
    validate_host(&host)?;
    if privilege.contains(';') || privilege.contains('\'') {
        return Err("权限包含非法字符".into());
    }
    if target.contains(';') || target.contains('\'') {
        return Err("目标包含非法字符".into());
    }
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    let preview;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!(
                "REVOKE {} ON {} FROM '{}'@'{}'",
                privilege, target,
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
            );
            preview = sql.clone();
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
            sqlx::query("FLUSH PRIVILEGES").execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!("REVOKE {} ON {} FROM {}", privilege, target, q_dq(&username));
            preview = sql.clone();
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(preview)
}

#[tauri::command]
pub async fn db_change_password(
    id:           String,
    username:     String,
    host:         String,
    new_password: String,
    storage:      State<'_, StorageState>,
) -> Result<(), String> {
    validate_username(&username)?;
    validate_host(&host)?;
    if new_password.is_empty() {
        return Err("新密码不能为空".to_string());
    }
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    ensure_writable(&cfg)?;
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let sql = format!(
                "ALTER USER '{}'@'{}' IDENTIFIED BY '{}'",
                username.replace('\'', "\\'"),
                host.replace('\'', "\\'"),
                new_password.replace('\'', "\\'"),
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            // PG 字符串字面量：单引号翻倍（standard_conforming_strings）
            let sql = format!(
                "ALTER ROLE {} WITH PASSWORD '{}'",
                q_dq(&username),
                new_password.replace('\'', "''"),
            );
            sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
        }
        _ => return Err("不支持的连接类型".into()),
    }
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// Q4 — 增量迁移（按主键/时间列只迁新增数据）
// ══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn db_incremental_migrate(
    src_id:     String,
    src_schema: String,
    src_table:  String,
    dst_id:     String,
    dst_schema: String,
    dst_table:  String,
    pk_col:     String,
    last_value: String,   // last migrated pk/time value (as string)
    batch_size: u64,
    app:        tauri::AppHandle,
    storage:    State<'_, StorageState>,
) -> Result<serde_json::Value, String> {
    use sqlx::Row;
    validate_ident(&src_table)?;
    validate_ident(&dst_table)?;
    validate_ident(&pk_col)?;
    if batch_size == 0 || batch_size > 100_000 {
        return Err("batch_size 必须在 1-100000 之间".into());
    }

    let (src_cfg, src_pwd) = load_conn(&src_id, &storage).await?;
    let (dst_cfg, dst_pwd) = load_conn(&dst_id, &storage).await?;
    ensure_writable(&dst_cfg)?;   // 增量迁移写入目标连接，目标只读则拒绝

    // Only source is read; dest is written
    let total_migrated = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
    let total_migrated_c = total_migrated.clone();

    let result: Result<i64, String> = (async {
        // 1. Get columns from source
        let cols = match src_cfg.conn_type {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                let (mut conn, _t) = mysql_connect(&src_cfg, src_pwd.as_deref()).await?;
                let schema_name = if src_schema.is_empty() { src_cfg.database.as_deref().unwrap_or("") } else { &src_schema };
                let sql = format!(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
                    schema_name.replace('\'', "\\'"), src_table.replace('\'', "\\'")
                );
                sqlx::query(&sql).fetch_all(&mut conn).await
                    .map_err(|e| format!("{e}"))?
                    .iter().map(|r| r.try_get::<String, _>(0).unwrap_or_default()).collect::<Vec<_>>()
            }
            ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                let (mut conn, _t) = pg_connect(&src_cfg, src_pwd.as_deref()).await?;
                let schema_name = if src_schema.is_empty() { "public" } else { &src_schema };
                let sql = "SELECT column_name FROM information_schema.columns \
                           WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position";
                sqlx::query(sql).bind(schema_name).bind(&src_table).fetch_all(&mut conn).await
                    .map_err(|e| format!("{e}"))?
                    .iter().map(|r| r.try_get::<String, _>(0).unwrap_or_default()).collect::<Vec<_>>()
            }
            ConnType::Sqlite => {
                use sqlx::{sqlite::SqliteConnection, Connection};
                use crate::commands::query::sqlite_url;
                let url = sqlite_url(&src_cfg)?;
                let mut conn = SqliteConnection::connect(&url).await.map_err(|e| e.to_string())?;
                let sql = format!("PRAGMA {}.table_info({})", if src_schema.is_empty() { "main" } else { &src_schema }, q_dq(&src_table));
                sqlx::query(&sql).fetch_all(&mut conn).await.map_err(|e| format!("{e}"))?
                    .iter().map(|r| r.try_get::<String, _>(1).unwrap_or_default()).collect::<Vec<_>>()
            }
            _ => return Err("不支持的连接类型".into()),
        };

        if cols.is_empty() {
            return Err(format!("表 {src_table} 没有列"));
        }

        // 2. Read new rows from source (WHERE pk_col > last_value) in batches
        let mut offset: u64 = 0;
        let mut rows_migrated: i64 = 0;

        loop {
            let batch_rows: Vec<Vec<Option<String>>> = match src_cfg.conn_type {
                ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                    let (mut conn, _t) = mysql_connect(&src_cfg, src_pwd.as_deref()).await?;
                    let src_ref = if src_schema.is_empty() { q_mysql(&src_table) }
                                  else { format!("{}.{}", q_mysql(&src_schema), q_mysql(&src_table)) };
                    let where_clause = if last_value.is_empty() { String::new() }
                                       else { format!("WHERE {} > '{}'", q_mysql(&pk_col), last_value.replace('\'', "\\'")) };
                    let sql = format!("SELECT * FROM {src_ref} {where_clause} ORDER BY {} LIMIT {} OFFSET {}",
                        q_mysql(&pk_col), batch_size, offset);
                    let rows = sqlx::query(&sql).fetch_all(&mut conn).await.map_err(|e| format!("{e}"))?;
                    rows.iter().map(|row| {
                        (0..cols.len()).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect()
                    }).collect()
                }
                ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                    let (mut conn, _t) = pg_connect(&src_cfg, src_pwd.as_deref()).await?;
                    let schema_name = if src_schema.is_empty() { "public" } else { &src_schema };
                    let src_ref = format!("{}.{}", q_dq(schema_name), q_dq(&src_table));
                    let where_clause = if last_value.is_empty() { String::new() }
                                       else { format!("WHERE {} > '{}'", q_dq(&pk_col), last_value.replace('\'', "''")) };
                    let sql = format!("SELECT * FROM {src_ref} {where_clause} ORDER BY {} LIMIT {} OFFSET {}",
                        q_dq(&pk_col), batch_size, offset);
                    let rows = sqlx::query(&sql).fetch_all(&mut conn).await.map_err(|e| format!("{e}"))?;
                    rows.iter().map(|row| {
                        (0..cols.len()).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect()
                    }).collect()
                }
                ConnType::Sqlite => {
                    use sqlx::{sqlite::SqliteConnection, Connection};
                    use crate::commands::query::sqlite_url;
                    let url = sqlite_url(&src_cfg)?;
                    let mut conn = SqliteConnection::connect(&url).await.map_err(|e| e.to_string())?;
                    let src_ref = if src_schema.is_empty() { q_dq(&src_table) } else { format!("{}.{}", q_dq(&src_schema), q_dq(&src_table)) };
                    let where_clause = if last_value.is_empty() { String::new() }
                                       else { format!("WHERE {} > '{}'", q_dq(&pk_col), last_value.replace('\'', "''")) };
                    let sql = format!("SELECT * FROM {src_ref} {where_clause} ORDER BY {} LIMIT {} OFFSET {}",
                        q_dq(&pk_col), batch_size, offset);
                    let rows = sqlx::query(&sql).fetch_all(&mut conn).await.map_err(|e| format!("{e}"))?;
                    rows.iter().map(|row| {
                        (0..cols.len()).map(|i| row.try_get::<Option<String>, _>(i).ok().flatten()).collect()
                    }).collect()
                }
                _ => return Err("不支持的连接类型".into()),
            };

            if batch_rows.is_empty() { break; }
            let batch_count = batch_rows.len() as u64;

            // 3. Insert batch into destination
            match dst_cfg.conn_type {
                ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
                    let (mut conn, _t) = mysql_connect(&dst_cfg, dst_pwd.as_deref()).await?;
                    let dst_ref = if dst_schema.is_empty() { q_mysql(&dst_table) }
                                  else { format!("{}.{}", q_mysql(&dst_schema), q_mysql(&dst_table)) };
                    let col_list = cols.iter().map(|c| q_mysql(c)).collect::<Vec<_>>().join(", ");
                    for row in &batch_rows {
                        let vals = row.iter().map(|v| match v {
                            None => "NULL".to_string(),
                            Some(s) => format!("'{}'", s.replace('\'', "\\'")),
                        }).collect::<Vec<_>>().join(", ");
                        let sql = format!("INSERT IGNORE INTO {dst_ref} ({col_list}) VALUES ({vals})");
                        sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
                    }
                }
                ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
                    let (mut conn, _t) = pg_connect(&dst_cfg, dst_pwd.as_deref()).await?;
                    let schema_name = if dst_schema.is_empty() { "public" } else { &dst_schema };
                    let dst_ref = format!("{}.{}", q_dq(schema_name), q_dq(&dst_table));
                    let col_list = cols.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                    for row in &batch_rows {
                        let vals = row.iter().map(|v| match v {
                            None => "NULL".to_string(),
                            Some(s) => format!("'{}'", s.replace('\'', "''")),
                        }).collect::<Vec<_>>().join(", ");
                        let sql = format!("INSERT INTO {dst_ref} ({col_list}) VALUES ({vals}) ON CONFLICT DO NOTHING");
                        sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
                    }
                }
                ConnType::Sqlite => {
                    use sqlx::{sqlite::SqliteConnection, Connection};
                    use crate::commands::query::sqlite_url;
                    let url = sqlite_url(&dst_cfg)?;
                    let mut conn = SqliteConnection::connect(&url).await.map_err(|e| e.to_string())?;
                    let dst_ref = if dst_schema.is_empty() { q_dq(&dst_table) } else { format!("{}.{}", q_dq(&dst_schema), q_dq(&dst_table)) };
                    let col_list = cols.iter().map(|c| q_dq(c)).collect::<Vec<_>>().join(", ");
                    for row in &batch_rows {
                        let vals = row.iter().map(|v| match v {
                            None => "NULL".to_string(),
                            Some(s) => format!("'{}'", s.replace('\'', "''")),
                        }).collect::<Vec<_>>().join(", ");
                        let sql = format!("INSERT OR IGNORE INTO {dst_ref} ({col_list}) VALUES ({vals})");
                        sqlx::query(&sql).execute(&mut conn).await.map_err(|e| format!("{e}"))?;
                    }
                }
                _ => return Err("不支持的连接类型".into()),
            }

            rows_migrated += batch_count as i64;
            total_migrated_c.store(rows_migrated, std::sync::atomic::Ordering::SeqCst);

            let _ = app.emit("incremental_migrate_progress", serde_json::json!({
                "rows": rows_migrated,
                "batchRows": batch_count,
            }));

            offset += batch_count;
            if batch_count < batch_size { break; }
        }
        Ok(rows_migrated)
    }).await;

    match result {
        Ok(n) => Ok(serde_json::json!({ "rowsMigrated": n })),
        Err(e) => Err(e),
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// M2 — 数据字典导出
// ══════════════════════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictTable {
    pub name:    String,
    pub comment: String,
    pub columns: Vec<DictColumn>,
    pub indexes: Vec<DictIndex>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictColumn {
    pub name:         String,
    pub data_type:    String,
    pub nullable:     bool,
    pub key_type:     String,
    pub default_val:  String,
    pub extra:        String,
    pub comment:      String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictIndex {
    pub name:     String,
    pub columns:  String,
    pub unique:   bool,
    pub index_type: String,
}

#[tauri::command]
pub async fn db_data_dictionary(
    id:      String,
    schema:  String,
    // 可选：仅生成这些表的字典（单表/多选）；None 或空 → 整库全部基表
    tables:  Option<Vec<String>>,
    storage: State<'_, StorageState>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, super::driver::DriverRegistry>,
    ss_pool: State<'_, SsPool>,
) -> Result<Vec<DictTable>, String> {
    use sqlx::Row;
    let only: Option<std::collections::HashSet<String>> =
        tables.filter(|v| !v.is_empty()).map(|v| v.into_iter().collect());
    let (cfg, pwd) = load_conn(&id, &storage).await?;
    // 通用：把列结果行（name,dtype,nullable,keyType,default,comment）解析为 DictColumn
    fn dict_cols(rows: Vec<Vec<Option<String>>>) -> Vec<DictColumn> {
        rows.into_iter().map(|r| {
            let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            let n = g(2);
            DictColumn {
                name: g(0), data_type: g(1),
                nullable: n.eq_ignore_ascii_case("YES") || n.eq_ignore_ascii_case("Y") || n == "1",
                key_type: g(3), default_val: g(4), extra: String::new(), comment: g(5),
            }
        }).collect()
    }
    match cfg.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { cfg.database.as_deref().unwrap_or("") } else { &schema };

            // Get tables with comments
            let tbl_sql = format!(
                "SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = '{}' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
                schema_name.replace('\'', "\\'")
            );
            let tbl_rows = sqlx::query(&tbl_sql).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;

            let mut tables = Vec::new();
            for trow in &tbl_rows {
                let tname: String  = trow.try_get(0).unwrap_or_default();
                if let Some(ref set) = only { if !set.contains(&tname) { continue; } }
                let tcomment: String = trow.try_get(1).unwrap_or_default();

                // Columns
                // CAST AS CHAR：information_schema 的 mediumtext/text 列在 sqlx 里会按二进制解码，
                // 不 CAST 则 try_get::<String> 失败 → 取空串（类型/键/注释全空）。
                let col_sql = format!(
                    "SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE AS CHAR), \
                            CAST(COLUMN_KEY AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR), CAST(COLUMN_COMMENT AS CHAR) \
                     FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
                    schema_name.replace('\'', "\\'"), tname.replace('\'', "\\'")
                );
                let col_rows = sqlx::query(&col_sql).fetch_all(&mut conn).await.unwrap_or_default();
                let columns = col_rows.iter().map(|r| DictColumn {
                    name:        r.try_get(0).unwrap_or_default(),
                    data_type:   r.try_get(1).unwrap_or_default(),
                    nullable:    r.try_get::<String, _>(2).unwrap_or_default().to_ascii_uppercase() == "YES",
                    key_type:    r.try_get(3).unwrap_or_default(),
                    default_val: r.try_get::<Option<String>, _>(4).unwrap_or(None).unwrap_or_default(),
                    extra:       r.try_get(5).unwrap_or_default(),
                    comment:     r.try_get(6).unwrap_or_default(),
                }).collect();

                // Indexes
                let idx_sql = format!(
                    "SELECT CAST(INDEX_NAME AS CHAR), CAST(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS CHAR), \
                            NOT NON_UNIQUE, CAST(INDEX_TYPE AS CHAR) \
                     FROM information_schema.STATISTICS \
                     WHERE TABLE_SCHEMA = '{}' AND TABLE_NAME = '{}' \
                     GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME",
                    schema_name.replace('\'', "\\'"), tname.replace('\'', "\\'")
                );
                let idx_rows = sqlx::query(&idx_sql).fetch_all(&mut conn).await.unwrap_or_default();
                let indexes = idx_rows.iter().map(|r| DictIndex {
                    name:       r.try_get(0).unwrap_or_default(),
                    columns:    r.try_get(1).unwrap_or_default(),
                    unique:     r.try_get::<i32, _>(2).unwrap_or(0) != 0,
                    index_type: r.try_get(3).unwrap_or_default(),
                }).collect();

                tables.push(DictTable { name: tname, comment: tcomment, columns, indexes });
            }
            Ok(tables)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&cfg, pwd.as_deref()).await?;
            let schema_name = if schema.is_empty() { "public" } else { &schema };

            let tbl_sql = "SELECT c.relname, obj_description(c.oid) \
                           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                           WHERE c.relkind = 'r' AND n.nspname = $1 ORDER BY c.relname";
            let tbl_rows = sqlx::query(tbl_sql).bind(schema_name).fetch_all(&mut conn).await
                .map_err(|e| format!("{e}"))?;

            let mut tables = Vec::new();
            for trow in &tbl_rows {
                let tname: String    = trow.try_get(0).unwrap_or_default();
                if let Some(ref set) = only { if !set.contains(&tname) { continue; } }
                let tcomment: Option<String> = trow.try_get(1).unwrap_or(None);

                let col_sql = "SELECT column_name, data_type, is_nullable, '', column_default, '', \
                                      col_description((table_schema||'.'||table_name)::regclass::oid, ordinal_position::int) \
                               FROM information_schema.columns \
                               WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position";
                let col_rows = sqlx::query(col_sql).bind(schema_name).bind(&tname)
                    .fetch_all(&mut conn).await.unwrap_or_default();
                let columns = col_rows.iter().map(|r| DictColumn {
                    name:        r.try_get(0).unwrap_or_default(),
                    data_type:   r.try_get(1).unwrap_or_default(),
                    nullable:    r.try_get::<String, _>(2).unwrap_or_default().to_ascii_uppercase() == "YES",
                    key_type:    String::new(),
                    default_val: r.try_get::<Option<String>, _>(4).unwrap_or(None).unwrap_or_default(),
                    extra:       String::new(),
                    comment:     r.try_get::<Option<String>, _>(6).unwrap_or(None).unwrap_or_default(),
                }).collect();

                let idx_sql = "SELECT i.relname, array_to_string(array_agg(a.attname ORDER BY ia.indnatts), ', '), \
                                      ix.indisunique, am.amname \
                               FROM pg_index ix \
                               JOIN pg_class t  ON t.oid  = ix.indrelid \
                               JOIN pg_class i  ON i.oid  = ix.indexrelid \
                               JOIN pg_am am    ON am.oid = i.relam \
                               JOIN pg_namespace n ON n.oid = t.relnamespace \
                               CROSS JOIN LATERAL unnest(ix.indkey) AS ia(indnatts) \
                               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ia.indnatts \
                               WHERE t.relname = $1 AND n.nspname = $2 \
                               GROUP BY i.relname, ix.indisunique, am.amname ORDER BY i.relname";
                let idx_rows = sqlx::query(idx_sql).bind(&tname).bind(schema_name)
                    .fetch_all(&mut conn).await.unwrap_or_default();
                let indexes = idx_rows.iter().map(|r| DictIndex {
                    name:       r.try_get(0).unwrap_or_default(),
                    columns:    r.try_get(1).unwrap_or_default(),
                    unique:     r.try_get(2).unwrap_or(false),
                    index_type: r.try_get(3).unwrap_or_default(),
                }).collect();

                tables.push(DictTable {
                    name: tname,
                    comment: tcomment.unwrap_or_default(),
                    columns, indexes,
                });
            }
            Ok(tables)
        }
        ConnType::Duckdb => {
            // DD8.3 DuckDB 数据字典（information_schema.columns）
            let schema_name = if schema.is_empty() { "main" } else { &schema };
            let sql = format!(
                "SELECT table_name, column_name, data_type, is_nullable, column_default \
                 FROM information_schema.columns WHERE table_schema = '{}' \
                 ORDER BY table_name, ordinal_position",
                schema_name.replace('\'', "''")
            );
            let result = dispatch_duck_query(&id, &cfg, &sql, &duck_pool, &registry).await?;

            // 按 table_name 分组
            let mut map: std::collections::BTreeMap<String, Vec<DictColumn>> = std::collections::BTreeMap::new();
            for row in result.rows {
                let g = |i: usize| row.get(i).and_then(|v| v.clone()).unwrap_or_default();
                let tbl = g(0);
                if let Some(ref set) = only { if !set.contains(&tbl) { continue; } }
                let col = DictColumn {
                    name: g(1), data_type: g(2),
                    nullable: g(3).to_uppercase() == "YES",
                    key_type: String::new(),
                    default_val: row.get(4).and_then(|v| v.clone()).unwrap_or_default(),
                    extra: String::new(),
                    comment: String::new(),
                };
                map.entry(tbl).or_default().push(col);
            }
            Ok(map.into_iter().map(|(name, columns)| DictTable {
                name, comment: String::new(), columns, indexes: vec![],
            }).collect())
        }
        ConnType::Sqlite => {
            use sqlx::{Row, sqlite::SqliteConnectOptions, ConnectOptions};
            use crate::commands::query::sqlite_url;
            use std::str::FromStr;
            let schema_name = if schema.is_empty() { "main" } else { &schema };
            let url = sqlite_url(&cfg)?;
            let opts = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .read_only(true)
                .busy_timeout(std::time::Duration::from_secs(10))
                .log_statements(log::LevelFilter::Off);
            let mut conn = opts.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;

            // 列出所有普通表（type='table'，排除系统表）
            let tbl_rows = sqlx::query(&format!(
                "SELECT name FROM {}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                q_dq(schema_name)
            )).fetch_all(&mut conn).await.map_err(|e| format!("{e}"))?;

            let mut tables_out = Vec::new();
            for trow in &tbl_rows {
                let tname: String = trow.try_get(0).unwrap_or_default();
                if let Some(ref set) = only { if !set.contains(&tname) { continue; } }

                // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
                let pragma_q = format!("PRAGMA {}.table_info({})", q_dq(schema_name), q_dq(&tname));
                let col_rows = sqlx::query(&pragma_q).fetch_all(&mut conn).await.unwrap_or_default();
                let columns: Vec<DictColumn> = col_rows.iter().map(|r| {
                    let notnull: i64 = r.try_get(3).unwrap_or(0);
                    let pk: i64      = r.try_get(5).unwrap_or(0);
                    DictColumn {
                        name:        r.try_get(1).unwrap_or_default(),
                        data_type:   r.try_get(2).unwrap_or_default(),
                        nullable:    notnull == 0,
                        key_type:    if pk > 0 { "PRI".into() } else { String::new() },
                        default_val: r.try_get::<Option<String>, _>(4).unwrap_or(None).unwrap_or_default(),
                        extra:       String::new(),
                        comment:     String::new(),
                    }
                }).collect();

                // PRAGMA index_list: seq, name, unique, origin, partial
                let idxlist_q = format!("PRAGMA {}.index_list({})", q_dq(schema_name), q_dq(&tname));
                let idx_list_rows = sqlx::query(&idxlist_q).fetch_all(&mut conn).await.unwrap_or_default();
                let mut indexes: Vec<DictIndex> = Vec::new();
                for irow in &idx_list_rows {
                    let iname: String = irow.try_get(1).unwrap_or_default();
                    let unique: i64   = irow.try_get(2).unwrap_or(0);
                    // PRAGMA index_info: seqno, cid, name
                    let iinfo_q = format!("PRAGMA {}.index_info({})", q_dq(schema_name), q_dq(&iname));
                    let iinfo_rows = sqlx::query(&iinfo_q).fetch_all(&mut conn).await.unwrap_or_default();
                    let col_names: Vec<String> = iinfo_rows.iter()
                        .filter_map(|r| r.try_get::<String, _>(2).ok())
                        .collect();
                    indexes.push(DictIndex {
                        name:       iname,
                        columns:    col_names.join(", "),
                        unique:     unique != 0,
                        index_type: "BTREE".into(),
                    });
                }

                tables_out.push(DictTable { name: tname, comment: String::new(), columns, indexes });
            }
            Ok(tables_out)
        }
        ConnType::Oracle => {
            let owner = schema.to_uppercase();
            // 懒加载：指定表则直接用，否则列举全部基表
            let names: Vec<String> = if let Some(set) = &only {
                set.iter().cloned().collect()
            } else {
                let tr = super::oracle::execute_query_impl(cfg.clone(),
                    format!("SELECT table_name FROM all_tables WHERE owner='{owner}' ORDER BY table_name"),
                    pwd.clone(), &registry).await?;
                tr.rows.iter().filter_map(|r| r.get(0).cloned().flatten()).collect()
            };
            let mut out = Vec::new();
            for tname in names {
                if tname.is_empty() { continue; }
                let tn = tname.replace('\'', "''");
                // 注：all_tab_columns.data_default 是 LONG 类型，用在子查询/函数里会 ORA-00997，
                //     且 OCI 取 LONG 也不可靠 → 默认值置空，仅取 名称/类型/可空/主键/注释。
                let col_sql = format!(
                    "SELECT c.column_name, c.data_type, c.nullable, \
                       CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END, \
                       '', \
                       (SELECT comments FROM all_col_comments cc WHERE cc.owner=c.owner AND cc.table_name=c.table_name AND cc.column_name=c.column_name AND ROWNUM=1) \
                     FROM all_tab_columns c \
                     LEFT JOIN (SELECT acc.column_name FROM all_constraints ct JOIN all_cons_columns acc ON acc.owner=ct.owner AND acc.constraint_name=ct.constraint_name \
                       WHERE ct.constraint_type='P' AND ct.owner='{owner}' AND ct.table_name='{tn}') pk ON pk.column_name=c.column_name \
                     WHERE c.owner='{owner}' AND c.table_name='{tn}' ORDER BY c.column_id");
                let cr = super::oracle::execute_query_impl(cfg.clone(), col_sql, pwd.clone(), &registry).await?;
                out.push(DictTable { name: tname, comment: String::new(), columns: dict_cols(cr.rows), indexes: vec![] });
            }
            Ok(out)
        }
        ConnType::SqlServer => {
            // SQL Server 的「schema」实为数据库名：用三段式名 [库].INFORMATION_SCHEMA.xxx 跨库查
            let db = schema.replace(']', "]]");
            let names: Vec<String> = if let Some(set) = &only {
                set.iter().cloned().collect()
            } else {
                let tr = dispatch_ss_query(&id, &cfg,
                    &format!("SELECT TABLE_NAME FROM [{db}].INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"),
                    &ss_pool).await?;
                tr.rows.iter().filter_map(|r| r.get(0).cloned().flatten()).collect()
            };
            let mut out = Vec::new();
            for tname in names {
                if tname.is_empty() { continue; }
                let tn = tname.replace('\'', "''");
                let col_sql = format!(
                    "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
                       CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END, \
                       ISNULL(c.COLUMN_DEFAULT,''), '' \
                     FROM [{db}].INFORMATION_SCHEMA.COLUMNS c \
                     LEFT JOIN (SELECT ku.COLUMN_NAME FROM [{db}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                         JOIN [{db}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=ku.TABLE_SCHEMA \
                         WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY' AND tc.TABLE_NAME='{tn}') pk ON pk.COLUMN_NAME=c.COLUMN_NAME \
                     WHERE c.TABLE_NAME='{tn}' ORDER BY c.ORDINAL_POSITION",
                    db = db, tn = tn);
                let cr = dispatch_ss_query(&id, &cfg, &col_sql, &ss_pool).await?;
                out.push(DictTable { name: tname, comment: String::new(), columns: dict_cols(cr.rows), indexes: vec![] });
            }
            Ok(out)
        }
        ConnType::ClickHouse => {
            let sc = schema.replace('\'', "''");
            let cr = super::query::dispatch_query(&cfg, pwd.as_deref(),
                &format!("SELECT table, name, type, if(startsWith(type,'Nullable'),'YES',''), \
                    if(is_in_primary_key=1,'PRI',''), default_expression, comment \
                  FROM system.columns WHERE database='{sc}' ORDER BY table, position")).await?;
            let mut map: std::collections::BTreeMap<String, Vec<DictColumn>> = std::collections::BTreeMap::new();
            for r in cr.rows {
                let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                let tname = g(0);
                if let Some(ref set) = only { if !set.contains(&tname) { continue; } }
                let n = g(3);
                map.entry(tname).or_default().push(DictColumn {
                    name: g(1), data_type: g(2),
                    nullable: n == "YES", key_type: g(4), default_val: g(5), extra: String::new(), comment: g(6),
                });
            }
            Ok(map.into_iter().map(|(name, columns)| DictTable { name, comment: String::new(), columns, indexes: vec![] }).collect())
        }
        _ => Err("不支持的连接类型".into()),
    }
}



// ──────────────────────────────────────────────────────────────────────────────
// H1 — 实例仪表盘：周期性指标采样
// ──────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceMetrics {
    pub queries:         u64,
    pub connections:     u64,
    pub threads_running: u64,
    pub uptime_s:        u64,
    pub buf_pool_hit:    f64,   // 0.0‥1.0, MySQL only; PG returns -1
    pub db_type:         String,
}

#[tauri::command]
pub async fn db_instance_metrics(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<InstanceMetrics, String> {
    use sqlx::Row;
    let (config, password) = load_conn(&id, &storage).await?;
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let rows = sqlx::query(
                "SHOW GLOBAL STATUS WHERE Variable_name IN \
                 ('Queries','Threads_connected','Threads_running','Uptime',\
                 'Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests')")
                .fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
            let mut m = std::collections::HashMap::<String, u64>::new();
            for r in &rows {
                let k: String = r.try_get(0).unwrap_or_default();
                let v: String = r.try_get(1).unwrap_or_default();
                m.insert(k, v.parse().unwrap_or(0));
            }
            let reads = *m.get("Innodb_buffer_pool_reads").unwrap_or(&0) as f64;
            let reqs  = *m.get("Innodb_buffer_pool_read_requests").unwrap_or(&1) as f64;
            let hit   = if reqs > 0.0 { 1.0 - reads / reqs } else { -1.0 };
            Ok(InstanceMetrics {
                queries:         *m.get("Queries").unwrap_or(&0),
                connections:     *m.get("Threads_connected").unwrap_or(&0),
                threads_running: *m.get("Threads_running").unwrap_or(&0),
                uptime_s:        *m.get("Uptime").unwrap_or(&0),
                buf_pool_hit:    hit,
                db_type:         "mysql".into(),
            })
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let xact_total: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(xact_commit + xact_rollback),0)::bigint FROM pg_stat_database")
                .fetch_one(&mut conn).await.unwrap_or(0);
            let conns: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM pg_stat_activity")
                .fetch_one(&mut conn).await.unwrap_or(0);
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::bigint FROM pg_stat_activity WHERE state='active'")
                .fetch_one(&mut conn).await.unwrap_or(0);
            let uptime: i64 = sqlx::query_scalar(
                "SELECT EXTRACT(EPOCH FROM (NOW()-pg_postmaster_start_time()))::bigint")
                .fetch_one(&mut conn).await.unwrap_or(0);
            Ok(InstanceMetrics {
                queries:         xact_total.max(0) as u64,
                connections:     conns.max(0) as u64,
                threads_running: active.max(0) as u64,
                uptime_s:        uptime.max(0) as u64,
                buf_pool_hit:    -1.0,
                db_type:         "postgres".into(),
            })
        }
        _ => Err("不支持的连接类型".into()),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// M1 — ER 关系图数据：表 / 列 / 外键
// ──────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErColumn {
    pub name:        String,
    pub data_type:   String,
    pub is_pk:       bool,
    pub is_nullable: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTable {
    pub name:    String,
    pub columns: Vec<ErColumn>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErFk {
    pub from_table: String,
    pub from_col:   String,
    pub to_table:   String,
    pub to_col:     String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErData {
    pub tables: Vec<ErTable>,
    pub fks:    Vec<ErFk>,
}

#[tauri::command]
pub async fn db_er_data(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<ErData, String> {
    use sqlx::Row;
    let (config, password) = load_conn(&id, &storage).await?;
    // 把标准结果行（tname,cname,dtype,nullable,keyflag）/（ftable,fcol,ttable,tcol）解析为 ErData。
    // 供 Oracle / SQLServer / ClickHouse / DuckDB / SQLite 等走通用查询分发的分支复用。
    fn build_tables(rows: Vec<Vec<Option<String>>>) -> Vec<ErTable> {
        let mut map: std::collections::BTreeMap<String, Vec<ErColumn>> = std::collections::BTreeMap::new();
        for r in rows {
            let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            let n = g(3);
            map.entry(g(0)).or_default().push(ErColumn {
                name: g(1), data_type: g(2),
                is_pk: g(4) == "PRI",
                is_nullable: n.eq_ignore_ascii_case("YES") || n.eq_ignore_ascii_case("Y") || n == "1",
            });
        }
        map.into_iter().map(|(name, columns)| ErTable { name, columns }).collect()
    }
    fn build_fks(rows: Vec<Vec<Option<String>>>) -> Vec<ErFk> {
        rows.into_iter().map(|r| {
            let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            ErFk { from_table: g(0), from_col: g(1), to_table: g(2), to_col: g(3) }
        }).collect()
    }
    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;
            let col_rows = sqlx::query(
                "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
            let mut table_map: std::collections::BTreeMap<String, Vec<ErColumn>> = std::collections::BTreeMap::new();
            for r in &col_rows {
                let tname: String = r.try_get(0).unwrap_or_default();
                let key_str: String = r.try_get(4).unwrap_or_default();
                let nullable_str: String = r.try_get(3).unwrap_or_default();
                table_map.entry(tname).or_default().push(ErColumn {
                    name:        r.try_get(1).unwrap_or_default(),
                    data_type:   r.try_get(2).unwrap_or_default(),
                    is_pk:       key_str == "PRI",
                    is_nullable: nullable_str.eq_ignore_ascii_case("YES"),
                });
            }
            let tables = table_map.into_iter().map(|(name, columns)| ErTable { name, columns }).collect();
            let fk_rows = sqlx::query(
                "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
            let fks = fk_rows.iter().map(|r| ErFk {
                from_table: r.try_get(0).unwrap_or_default(),
                from_col:   r.try_get(1).unwrap_or_default(),
                to_table:   r.try_get(2).unwrap_or_default(),
                to_col:     r.try_get(3).unwrap_or_default(),
            }).collect();
            Ok(ErData { tables, fks })
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;
            let col_rows = sqlx::query(
                "SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, \
                 CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END \
                 FROM information_schema.columns c \
                 LEFT JOIN (\
                   SELECT ku.table_name, ku.column_name \
                   FROM information_schema.table_constraints tc \
                   JOIN information_schema.key_column_usage ku \
                     ON tc.constraint_name=ku.constraint_name AND tc.table_schema=ku.table_schema \
                   WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=$1\
                 ) pk ON c.table_name=pk.table_name AND c.column_name=pk.column_name \
                 WHERE c.table_schema=$1 ORDER BY c.table_name, c.ordinal_position")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
            let mut table_map: std::collections::BTreeMap<String, Vec<ErColumn>> = std::collections::BTreeMap::new();
            for r in &col_rows {
                let tname: String = r.try_get(0).unwrap_or_default();
                let key_str: String = r.try_get(4).unwrap_or_default();
                let nullable_str: String = r.try_get(3).unwrap_or_default();
                table_map.entry(tname).or_default().push(ErColumn {
                    name:        r.try_get(1).unwrap_or_default(),
                    data_type:   r.try_get(2).unwrap_or_default(),
                    is_pk:       key_str == "PRI",
                    is_nullable: nullable_str.eq_ignore_ascii_case("YES"),
                });
            }
            let tables = table_map.into_iter().map(|(name, columns)| ErTable { name, columns }).collect();
            let fk_rows = sqlx::query(
                "SELECT kcu.table_name, kcu.column_name, ccu.table_name, ccu.column_name \
                 FROM information_schema.referential_constraints rc \
                 JOIN information_schema.key_column_usage kcu \
                   ON kcu.constraint_name=rc.constraint_name AND kcu.constraint_schema=rc.constraint_schema \
                 JOIN information_schema.constraint_column_usage ccu \
                   ON ccu.constraint_name=rc.unique_constraint_name \
                   AND ccu.constraint_schema=rc.unique_constraint_schema \
                 WHERE rc.constraint_schema=$1")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
            let fks = fk_rows.iter().map(|r| ErFk {
                from_table: r.try_get(0).unwrap_or_default(),
                from_col:   r.try_get(1).unwrap_or_default(),
                to_table:   r.try_get(2).unwrap_or_default(),
                to_col:     r.try_get(3).unwrap_or_default(),
            }).collect();
            Ok(ErData { tables, fks })
        }
        ConnType::Oracle => {
            // Oracle：owner 默认大写；列/主键来自 all_tab_columns + all_constraints(P)
            let owner = schema.to_uppercase();
            let col_sql = format!(
                "SELECT c.table_name, c.column_name, c.data_type, c.nullable, \
                   CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE 'N' END \
                 FROM all_tab_columns c \
                 LEFT JOIN (SELECT cc.table_name, cc.column_name FROM all_constraints ct \
                     JOIN all_cons_columns cc ON cc.owner=ct.owner AND cc.constraint_name=ct.constraint_name \
                     WHERE ct.constraint_type='P' AND ct.owner='{owner}') pk \
                   ON c.table_name=pk.table_name AND c.column_name=pk.column_name \
                 WHERE c.owner='{owner}' ORDER BY c.table_name, c.column_id");
            let cr = super::oracle::execute_query_impl(config.clone(), col_sql, password.clone(), &registry).await?;
            let fk_sql = format!(
                "SELECT a.table_name, a.column_name, pk.table_name, pkc.column_name \
                 FROM all_constraints c \
                 JOIN all_cons_columns a ON a.owner=c.owner AND a.constraint_name=c.constraint_name \
                 JOIN all_constraints pk ON pk.owner=c.r_owner AND pk.constraint_name=c.r_constraint_name \
                 JOIN all_cons_columns pkc ON pkc.owner=pk.owner AND pkc.constraint_name=pk.constraint_name AND pkc.position=a.position \
                 WHERE c.constraint_type='R' AND c.owner='{owner}'");
            let fr = super::oracle::execute_query_impl(config.clone(), fk_sql, password.clone(), &registry).await?;
            Ok(ErData { tables: build_tables(cr.rows), fks: build_fks(fr.rows) })
        }
        ConnType::SqlServer => {
            // SQL Server 的「schema」实为数据库名。用三段式名 [库].INFORMATION_SCHEMA.xxx 直接跨库查
            // （不能用 USE [库];SELECT 多语句——dispatch_ss_query 只取第一个结果集，会拿到 USE 的空集）。
            let db = schema.replace(']', "]]");
            let col_sql = format!(
                "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
                   CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END \
                 FROM [{db}].INFORMATION_SCHEMA.COLUMNS c \
                 LEFT JOIN (SELECT ku.TABLE_NAME, ku.COLUMN_NAME FROM [{db}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                     JOIN [{db}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=ku.TABLE_SCHEMA \
                     WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY') pk \
                   ON c.TABLE_NAME=pk.TABLE_NAME AND c.COLUMN_NAME=pk.COLUMN_NAME \
                 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION");
            let cr = dispatch_ss_query(&id, &config, &col_sql, &ss_pool).await?;
            let fk_sql = format!(
                "SELECT fk.TABLE_NAME, cu.COLUMN_NAME, pk.TABLE_NAME, pt.COLUMN_NAME \
                 FROM [{db}].INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc \
                 JOIN [{db}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS fk ON fk.CONSTRAINT_NAME=rc.CONSTRAINT_NAME \
                 JOIN [{db}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS pk ON pk.CONSTRAINT_NAME=rc.UNIQUE_CONSTRAINT_NAME \
                 JOIN [{db}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu ON cu.CONSTRAINT_NAME=rc.CONSTRAINT_NAME \
                 JOIN [{db}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE pt ON pt.CONSTRAINT_NAME=rc.UNIQUE_CONSTRAINT_NAME AND pt.ORDINAL_POSITION=cu.ORDINAL_POSITION");
            let fr = dispatch_ss_query(&id, &config, &fk_sql, &ss_pool).await?;
            Ok(ErData { tables: build_tables(cr.rows), fks: build_fks(fr.rows) })
        }
        ConnType::ClickHouse => {
            // ClickHouse 无外键概念；列来自 system.columns，主键用 is_in_primary_key
            let col_sql = format!(
                "SELECT table, name, type, if(startsWith(type,'Nullable'),'YES',''), \
                   if(is_in_primary_key=1,'PRI','') \
                 FROM system.columns WHERE database='{}' ORDER BY table, position",
                schema.replace('\'', "''"));
            let cr = super::query::dispatch_query(&config, password.as_deref(), &col_sql).await?;
            Ok(ErData { tables: build_tables(cr.rows), fks: vec![] })
        }
        ConnType::Duckdb => {
            // DuckDB 走 information_schema；外键约束元数据有限，仅取列（关系靠前端命名推断）
            let col_sql = format!(
                "SELECT table_name, column_name, data_type, is_nullable, '' \
                 FROM information_schema.columns WHERE table_schema='{}' \
                 ORDER BY table_name, ordinal_position",
                schema.replace('\'', "''"));
            let cr = dispatch_duck_query(&id, &config, &col_sql, &duck_pool, &registry).await?;
            Ok(ErData { tables: build_tables(cr.rows), fks: vec![] })
        }
        ConnType::Sqlite => {
            // SQLite：sqlite_master 取表名，逐表 PRAGMA table_info / foreign_key_list
            let dq = |sql: String| {
                let config = config.clone();
                async move { super::query::dispatch_query(&config, None, &sql).await }
            };
            let tbl_rows = dq("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name".into()).await?;
            let mut tables: Vec<ErTable> = Vec::new();
            let mut fks: Vec<ErFk> = Vec::new();
            for tr in tbl_rows.rows {
                let tname = tr.get(0).cloned().flatten().unwrap_or_default();
                if tname.is_empty() { continue; }
                let q = format!("\"{}\"", tname.replace('"', "\"\""));
                // 列：cid,name,type,notnull,dflt,pk
                let ci = dq(format!("PRAGMA table_info({q})")).await?;
                let columns = ci.rows.iter().map(|r| {
                    let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                    ErColumn { name: g(1), data_type: g(2), is_pk: g(5) != "0" && !g(5).is_empty(), is_nullable: g(3) == "0" }
                }).collect();
                tables.push(ErTable { name: tname.clone(), columns });
                // 外键：id,seq,table,from,to,...
                let fl = dq(format!("PRAGMA foreign_key_list({q})")).await?;
                for r in &fl.rows {
                    let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                    fks.push(ErFk { from_table: tname.clone(), from_col: g(3), to_table: g(2), to_col: g(4) });
                }
            }
            Ok(ErData { tables, fks })
        }
        _ => Err("不支持的连接类型".into()),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// J4 — 数据全文检索（参数化 LIKE，绝不拼字符串值到 SQL）
// ──────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub table_name:  String,
    pub column_name: String,
    pub row_preview: Vec<String>,
}

#[tauri::command]
pub async fn db_fulltext_search(
    id: String,
    schema: String,
    tables: Vec<String>,
    search: String,
    limit_per_table: Option<i64>,
    storage: State<'_, StorageState>,
) -> Result<Vec<SearchHit>, String> {
    use sqlx::Row;
    if search.is_empty() { return Ok(vec![]); }
    let per = limit_per_table.unwrap_or(20).min(100);
    let (config, password) = load_conn(&id, &storage).await?;

    let is_mysql = matches!(config.conn_type,
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase);
    let is_pg = matches!(config.conn_type,
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss);
    if !is_mysql && !is_pg { return Err("不支持的连接类型".into()); }

    // LIKE 模式：转义 % 和 _，值由驱动绑定
    let pattern = format!("%{}%",
        search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));

    let mut hits: Vec<SearchHit> = vec![];

    if is_mysql {
        let (mut conn, _t) = mysql_connect(&config, password.as_deref()).await?;

        let target_tables: Vec<String> = if !tables.is_empty() {
            tables
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT TABLE_NAME FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' LIMIT 50")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?
        };

        for tname in target_tables.iter().take(20) {
            let text_cols: Vec<String> = sqlx::query_scalar::<_, String>(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME=? \
                 AND DATA_TYPE IN ('varchar','char','text','tinytext','mediumtext','longtext','enum','set') \
                 ORDER BY ORDINAL_POSITION LIMIT 20")
                .bind(&schema).bind(tname).fetch_all(&mut conn).await.unwrap_or_default();
            if text_cols.is_empty() { continue; }

            let schema_q = format!("`{}`.`{}`",
                schema.replace('`', "``"), tname.replace('`', "``"));
            let where_parts: Vec<String> = text_cols.iter()
                .map(|c| format!("`{}` LIKE ? ESCAPE '\\\\'", c.replace('`', "``"))).collect();
            let sql = format!("SELECT * FROM {} WHERE {} LIMIT {}", schema_q, where_parts.join(" OR "), per);
            let mut q = sqlx::query(&sql);
            for _ in &text_cols { q = q.bind(&pattern); }
            let rows = q.fetch_all(&mut conn).await.unwrap_or_default();

            for row in rows {
                for (ci, col) in text_cols.iter().enumerate() {
                    let val: Option<String> = row.try_get(ci).ok().flatten();
                    if let Some(v) = val {
                        if v.to_lowercase().contains(&search.to_lowercase()) {
                            let ncols = row.len();
                            let preview: Vec<String> = (0..5usize.min(ncols))
                                .map(|i| row.try_get::<Option<String>, _>(i).ok()
                                    .flatten().unwrap_or_else(|| "NULL".into())).collect();
                            hits.push(SearchHit {
                                table_name: tname.clone(),
                                column_name: col.clone(),
                                row_preview: preview,
                            });
                            break;
                        }
                    }
                }
            }
            if hits.len() > 500 { break; }
        }
    } else {
        let (mut conn, _t) = pg_connect(&config, password.as_deref()).await?;

        let target_tables: Vec<String> = if !tables.is_empty() {
            tables
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema=$1 AND table_type='BASE TABLE' LIMIT 50")
                .bind(&schema).fetch_all(&mut conn).await.map_err(|e| e.to_string())?
        };

        for tname in target_tables.iter().take(20) {
            let text_cols: Vec<String> = sqlx::query_scalar::<_, String>(
                "SELECT column_name FROM information_schema.columns \
                 WHERE table_schema=$1 AND table_name=$2 \
                 AND data_type IN ('character varying','character','text','name') \
                 ORDER BY ordinal_position LIMIT 20")
                .bind(&schema).bind(tname).fetch_all(&mut conn).await.unwrap_or_default();
            if text_cols.is_empty() { continue; }

            let schema_q = format!("\"{}\".\"{}\"",
                schema.replace('"', "\"\""), tname.replace('"', "\"\""));
            let where_parts: Vec<String> = text_cols.iter().enumerate()
                .map(|(i, c)| format!("\"{}\" ILIKE ${}", c.replace('"', "\"\""), i + 1)).collect();
            let sql = format!("SELECT * FROM {} WHERE {} LIMIT {}", schema_q, where_parts.join(" OR "), per);
            let mut q = sqlx::query(&sql);
            for _ in &text_cols { q = q.bind(&pattern); }
            let rows = q.fetch_all(&mut conn).await.unwrap_or_default();

            for row in rows {
                for (ci, col) in text_cols.iter().enumerate() {
                    let val: Option<String> = row.try_get(ci).ok().flatten();
                    if let Some(v) = val {
                        if v.to_lowercase().contains(&search.to_lowercase()) {
                            let ncols = row.len();
                            let preview: Vec<String> = (0..5usize.min(ncols))
                                .map(|i| row.try_get::<Option<String>, _>(i).ok()
                                    .flatten().unwrap_or_else(|| "NULL".into())).collect();
                            hits.push(SearchHit {
                                table_name: tname.clone(),
                                column_name: col.clone(),
                                row_preview: preview,
                            });
                            break;
                        }
                    }
                }
            }
            if hits.len() > 500 { break; }
        }
    }
    Ok(hits)
}
