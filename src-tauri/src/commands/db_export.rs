// db_export.rs — SQL 执行并流式写文件
//
// 流程：execute SQL → row-by-row → 按格式编码 → BufWriter → 磁盘
// 内存占用：
//   PostgreSQL — sqlx 使用 server-side cursor，真正流式，O(1) 内存
//   MySQL      — MySQL 协议在客户端缓冲结果；Rust 侧仍逐行写盘，无额外拷贝
// 取消：每 CANCEL_CHECK_INTERVAL 行检查 AtomicBool；取消后自动删除残留文件
// 编码：UTF-8 / UTF-8 BOM / GBK（使用 encoding_rs）

use std::collections::HashMap;
use std::fmt::Write as FmtWrite;
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Instant;
use futures::TryStreamExt;
use futures::StreamExt;
use tauri::{State, Emitter};
use crate::{models::ConnType, storage::StorageState};
use crate::commands::sqlserver::SsPool;
use crate::commands::duckdb::DuckPool;
use crate::commands::driver::DriverRegistry;

pub type ExportCancelMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Write into the destination directory; failure must never truncate an existing export.
pub(crate) struct StagedExport {
    pub(crate) path: String,
    destination: std::path::PathBuf,
    committed: bool,
}

impl StagedExport {
    pub(crate) fn new(destination: &str) -> Result<Self, String> {
        let destination = std::path::PathBuf::from(destination);
        let directory = destination.parent().ok_or("导出文件缺少父目录")?;
        let path = directory.join(format!("dbterm-export-{}.part", uuid::Uuid::new_v4().simple()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)
            .map_err(|e| format!("创建临时导出文件失败: {e}"))?;
        Ok(Self { path: path.to_string_lossy().into_owned(), destination, committed: false })
    }

    pub(crate) fn commit(&mut self) -> Result<(), String> {
        std::fs::OpenOptions::new().write(true).open(&self.path)
            .and_then(|file| file.sync_all()).map_err(|e| format!("导出文件落盘失败，原文件未修改: {e}"))?;
        std::fs::rename(&self.path, &self.destination)
            .map_err(|e| format!("提交导出文件失败，原文件未主动删除: {e}"))?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for StagedExport {
    fn drop(&mut self) {
        if !self.committed { let _ = std::fs::remove_file(&self.path); }
    }
}

/// 写入前端生成的二进制导出文件（例如多结果集 Excel）。路径仍经过
/// 与流式导出相同的绝对路径/目录校验，避免任意路径写入。
#[tauri::command]
pub fn write_export_bytes(file_path: String, data: Vec<u8>) -> Result<(), String> {
    super::db_extra::validate_path(&file_path)?;
    let path = std::path::Path::new(&file_path);
    if let Some(dir) = path.parent() {
        if !dir.exists() { return Err(format!("目录不存在: {}", dir.display())); }
    }
    let mut staged = StagedExport::new(&file_path)?;
    std::fs::write(&staged.path, data).map_err(|e| format!("写入导出文件失败: {e}"))?;
    staged.commit()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    #[serde(default)]
    pub header: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub binary: bool,
}

fn safe_archive_name(name: &str) -> Result<String, String> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains('\0')
        || normalized.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("ZIP 条目名称无效".into());
    }
    // A drive-qualified name is rooted on Windows even though Path::is_absolute
    // on non-Windows hosts cannot recognize it. Reject it on Windows before
    // creating an archive entry.
    #[cfg(target_os = "windows")]
    if normalized.as_bytes().get(1) == Some(&b':') {
        return Err("ZIP 条目名称无效".into());
    }
    Ok(normalized)
}

#[tauri::command]
pub fn db_create_export_workspace(task_id: String) -> Result<String, String> {
    if task_id.is_empty() || !task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("导出任务 ID 无效".into());
    }
    let dir = std::env::temp_dir().join(format!("dbterm-export-{task_id}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

fn validated_export_workspace(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("读取临时目录失败: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err("拒绝清理非 DBTerm 导出临时目录".into()); }
    let canonical = path.canonicalize().map_err(|e| format!("读取临时目录失败: {e}"))?;
    let temp_root = std::env::temp_dir().canonicalize().map_err(|e| format!("读取系统临时目录失败: {e}"))?;
    if canonical.parent() != Some(temp_root.as_path())
        || !canonical.file_name().and_then(|n| n.to_str()).unwrap_or("").starts_with("dbterm-export-") {
        return Err("拒绝清理非 DBTerm 导出临时目录".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn db_cleanup_export_workspace(workspace: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(workspace);
    if !path.try_exists().map_err(|e| format!("读取临时目录失败: {e}"))? { return Ok(()); }
    let canonical = validated_export_workspace(&path)?;
    std::fs::remove_dir_all(canonical).map_err(|e| format!("清理临时目录失败: {e}"))
}

#[tauri::command]
pub fn db_pack_export_archive(path: String, workspace: String, entries: Vec<ArchiveEntry>, cleanup: Option<bool>) -> Result<u64, String> {
    use std::io::{BufReader, BufWriter, Write};
    super::db_extra::validate_path(&path)?;
    let workspace_path = std::path::PathBuf::from(&workspace);
    let canonical_workspace = validated_export_workspace(&workspace_path)?;

    let result = (|| -> Result<u64, String> {
        let mut staged = StagedExport::new(&path)?;
        let file = std::fs::File::create(&staged.path).map_err(|e| format!("创建 ZIP 失败: {e}"))?;
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1024 * 1024, file));
        // 所有条目预先启用 ZIP64，避免未知大小的表 SQL 超过 4 GiB 后在收尾阶段失败。
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        for entry in entries {
            zip.start_file(safe_archive_name(&entry.name)?, options).map_err(|e| format!("创建 ZIP 条目失败: {e}"))?;
            if !entry.binary && !entry.header.is_empty() {
                zip.write_all(entry.header.as_bytes()).map_err(|e| format!("写入 ZIP 失败: {e}"))?;
                if !entry.header.ends_with('\n') { zip.write_all(b"\n").map_err(|e| format!("写入 ZIP 失败: {e}"))?; }
            }
            if let Some(source) = entry.source_path {
                let canonical_source = std::path::PathBuf::from(source).canonicalize().map_err(|e| format!("临时导出文件不存在: {e}"))?;
                if !canonical_source.starts_with(&canonical_workspace) { return Err("ZIP 源文件不在导出临时目录内".into()); }
                let source_file = std::fs::File::open(canonical_source).map_err(|e| format!("读取临时导出文件失败: {e}"))?;
                std::io::copy(&mut BufReader::new(source_file), &mut zip).map_err(|e| format!("写入 ZIP 数据失败: {e}"))?;
            }
        }
        let mut writer = zip.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
        writer.flush().map_err(|e| format!("写入 ZIP 失败: {e}"))?;
        drop(writer);
        staged.commit()?;
        Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
    })();
    if cleanup.unwrap_or(true) { let _ = std::fs::remove_dir_all(&canonical_workspace); }
    result
}

const PROGRESS_INTERVAL: u64 = 1_000;   // 大表持续反馈进度，避免长时间看起来卡死
const CANCEL_CHECK_INTERVAL: u64 = 500; // 每 N 行检查取消标志
const XLSX_MAX_ROWS: u64 = 1_048_576;
const TEXT_EXPORT_FLUSH_BYTES: usize = 1024 * 1024;
const XLSX_SHEET_FLUSH_BYTES: usize = 4 * 1024 * 1024;

// ── 事件 ──────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ExportProgressEvt {
    pub rows: u64,
    pub elapsed_ms: u64,
    pub rows_per_sec: u64,
    pub file_bytes: u64,  // 仅最终事件非零
    pub done: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

// ── 连接 ──────────────────────────────────────────────────────────────────────

enum DbConn {
    // 第二个字段是 SSH 隧道守卫，需在导出期间保持存活（仅 RAII，不读取）
    MySql(sqlx::mysql::MySqlConnection, #[allow(dead_code)] Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>),
    Pg(sqlx::postgres::PgConnection, #[allow(dead_code)] Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>),
    Sqlite(sqlx::sqlite::SqliteConnection),
}

fn prepare_export_target(config: &mut crate::models::ConnConfig, selected: Option<&str>) -> Result<Option<String>, String> {
    // Same engine-aware routing as execute_query: a PG schema must never replace
    // the physical database, and a fresh SQLite connection has no attachments.
    let schema = crate::commands::query::apply_selected_query_target(config, selected)?;
    Ok(schema.map(|name| format!("\"{}\"", name.replace('"', "\"\""))))
}

fn prepare_native_export_target(config: &mut crate::models::ConnConfig, selected: Option<&str>) -> Result<Option<String>, String> {
    crate::commands::query::apply_selected_query_target(config, selected)
}

fn export_requires_readonly(config: &crate::models::ConnConfig) -> Result<bool, String> {
    let extra = match config.extra_json.as_deref() {
        Some(raw) => serde_json::from_str::<serde_json::Value>(raw).map_err(|_| "导出连接扩展配置无效")?,
        None => serde_json::json!({}),
    };
    Ok(config.read_only == Some(true)
        || (config.conn_type == ConnType::Sqlite && (extra.get("sqliteReadonly").and_then(|v|v.as_bool()) == Some(true)
            || extra.get("sqliteImmutable").and_then(|v|v.as_bool()) == Some(true)))
        || (config.conn_type == ConnType::Duckdb && extra.get("duckAccessMode").and_then(|v|v.as_str()) == Some("read_only")))
}

fn validate_export_readonly_sql(config: &crate::models::ConnConfig, sql: &str) -> Result<(), String> {
    if !export_requires_readonly(config)? { return Ok(()); }
    if sql.contains("/*!") || sql.contains("/*M!") {
        return Err("只读导出不接受可执行注释指令".into());
    }
    if !crate::commands::query::is_read_only_safe_stmt(sql, &config.conn_type) {
        return Err("此连接为只读模式，导出已拒绝非只读 SQL".into());
    }
    use sqlparser::{dialect::GenericDialect, tokenizer::{Token, Tokenizer}};
    let tokens=Tokenizer::new(&GenericDialect {}, sql).tokenize()
        .map_err(|_| "无法安全识别导出 SQL，只读连接已拒绝执行")?;
    let mut ended=false;
    let mut seen=false;
    for token in tokens {
        if matches!(token,Token::Whitespace(_)) { continue; }
        if token == Token::SemiColon { ended=true; continue; }
        if ended { return Err("只读导出仅接受单条查询，已拒绝多语句脚本".into()); }
        seen=true;
        if let Token::Word(word)=token {
            if word.quote_style.is_none() && ["INSERT","UPDATE","DELETE","MERGE","DROP","CREATE","ALTER","TRUNCATE","GRANT","REVOKE","REPLACE","CALL","EXEC","EXECUTE","INTO","ATTACH","DETACH","VACUUM","PRAGMA","SET","COPY","INSTALL","LOAD"].contains(&word.value.to_ascii_uppercase().as_str()) {
                return Err("只读导出 SQL 包含写入或会话修改指令，已拒绝执行".into());
            }
        }
    }
    if !seen { return Err("导出 SQL 为空".into()); }
    Ok(())
}

async fn open_conn(id: &str, storage: &State<'_, StorageState>, database: Option<&str>, sql: &str) -> Result<DbConn, String> {
    let cfgs = storage.lock().unwrap().load()?;
    let mut config = cfgs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    validate_export_readonly_sql(&config,sql)?;
    let selected_schema_path = prepare_export_target(&mut config, database)?;

    let pwd = crate::keychain::get_password(id)?;
    let pwd = pwd.as_deref().unwrap_or("");

    match config.conn_type {
        // 复用 query 模块的连接（带 SSH 隧道 / SSL / charset 等），与查询结果区走完全一致的连接，
        // 避免导出走简化直连导致连到不同目标 / 取不到数据。
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            let (conn, tun) = crate::commands::query::mysql_connect(&config, Some(pwd)).await?;
            Ok(DbConn::MySql(conn, tun))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            let (mut conn, tun) = crate::commands::query::pg_connect(&config, Some(pwd)).await?;
            if let Some(path) = selected_schema_path {
                // Apply after saved session initialization, on the exact session
                // which streams untouched export SQL. Bound and quoted as one schema.
                sqlx::query("SELECT set_config('search_path', $1, false)")
                    .bind(path).execute(&mut conn).await
                    .map_err(|e| format!("选择导出 schema 失败: {e}"))?;
            }
            Ok(DbConn::Pg(conn, tun))
        }
        ConnType::Sqlite => {
            let conn = open_sqlite_export_connection(&config).await?;
            Ok(DbConn::Sqlite(conn))
        }
        _ => Err("暂不支持此连接类型的流式导出".into()),
    }
}

async fn open_sqlite_export_connection(config: &crate::models::ConnConfig) -> Result<sqlx::sqlite::SqliteConnection, String> {
    use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
    use std::str::FromStr;
    let url = crate::commands::query::sqlite_url(config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .log_statements(log::LevelFilter::Off);
    let mut conn=opts.connect().await.map_err(|e| format!("SQLite 连接失败: {e}"))?;
    if export_requires_readonly(config)? {
        sqlx::query("PRAGMA query_only=ON").execute(&mut conn).await
            .map_err(|e| format!("设置导出只读会话失败: {e}"))?;
    }
    Ok(conn)
}

// ── 格式写入 ──────────────────────────────────────────────────────────────────

fn sql_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('\'', "\\'")
     .replace('\0', "\\0")
     .replace('\n', "\\n")
     .replace('\r', "\\r")
     .replace('\x1a', "\\Z")
}

/// SQL 导出时的标识符引号风格（按方言）。
#[derive(Clone, Copy)]
enum IdentQuote {
    Backtick, // MySQL 系：`x`，内部 ` 翻倍
    Double,   // PG/SQLite/DuckDB/Oracle 等：\"x\"，内部 \" 翻倍
    Bracket,  // SQL Server：[x]，内部 ] 翻倍
}

impl IdentQuote {
    fn from_conn(ct: &ConnType) -> Self {
        match ct {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase | ConnType::ClickHouse => Self::Backtick,
            ConnType::SqlServer => Self::Bracket,
            _ => Self::Double,
        }
    }
    /// 转义并加引号；内部引号字符翻倍，防止标识符借引号逃逸（导出写入、回放触发注入）。
    fn quote(&self, s: &str) -> String {
        match self {
            Self::Backtick => format!("`{}`", s.replace('`', "``")),
            Self::Double   => format!("\"{}\"", s.replace('"', "\"\"")),
            Self::Bracket  => format!("[{}]", s.replace(']', "]]")),
        }
    }
}

enum RowWriter<'a> {
    Csv { sep: u8 },                     // CSV or TSV
    Jsonl,
    Json { wrote_any: bool },
    Md,
    Sql { table: &'a str, quote: IdentQuote, mysql_escape: bool },
}

impl<'a> RowWriter<'a> {
    fn validate_columns(&self, cols: &[String]) -> Result<(),String> {
        if matches!(self,Self::Jsonl|Self::Json {..}|Self::Sql {..}) {
            let fold=matches!(self,Self::Sql {quote:IdentQuote::Backtick|IdentQuote::Bracket,..});
            let mut seen=std::collections::HashSet::new();
            for column in cols {
                let key=if fold {column.to_ascii_lowercase()} else {column.clone()};
                if !seen.insert(key) {
                    return Err(format!("结果包含重复列名 {}，此格式无法无损表示；请为每列设置唯一别名，已停止导出",column));
                }
            }
        }
        Ok(())
    }

    fn write_header_to(&mut self, out: &mut String, cols: &[String]) -> Result<(),String> {
        self.validate_columns(cols)?;
        match self {
            Self::Csv { sep } => {
                push_delimited_line(out, *sep, cols.iter().map(|c| Some(c.as_str())));
            }
            Self::Md => {
                out.push('|');
                for col in cols {
                    out.push(' ');
                    push_md_cell(out, col);
                    out.push_str(" |");
                }
                out.push('\n');
                out.push('|');
                for col in cols {
                    out.push(' ');
                    out.push_str(&"-".repeat(col.chars().count().max(3)));
                    out.push_str(" |");
                }
                out.push('\n');
            }
            Self::Json { .. } => out.push_str("[\n"),
            Self::Sql { .. } | Self::Jsonl => {}
        }
        Ok(())
    }

    fn write_row_to(&mut self, out: &mut String, cols: &[String], vals: &[Option<String>]) -> Result<(),String> {
        self.validate_columns(cols)?;
        if cols.len()!=vals.len() { return Err("导出行与字段数量不一致，已停止导出".into()); }
        match self {
            Self::Csv { sep } => {
                push_delimited_line(out, *sep, vals.iter().map(|v| v.as_deref()));
            }
            Self::Jsonl => {
                let mut obj = serde_json::Map::new();
                for (c, v) in cols.iter().zip(vals.iter()) {
                    obj.insert(c.clone(), match v {
                        None    => serde_json::Value::Null,
                        Some(s) => serde_json::Value::String(s.clone()),
                    });
                }
                let mut line = serde_json::to_string(&obj).unwrap_or_default();
                line.push('\n');
                out.push_str(&line);
            }
            Self::Json { wrote_any } => {
                if *wrote_any {
                    out.push_str(",\n");
                }
                let mut obj = serde_json::Map::new();
                for (c, v) in cols.iter().zip(vals.iter()) {
                    obj.insert(c.clone(), match v {
                        None    => serde_json::Value::Null,
                        Some(s) => serde_json::Value::String(s.clone()),
                    });
                }
                out.push_str(&serde_json::to_string(&obj).unwrap_or_default());
                *wrote_any = true;
            }
            Self::Md => {
                out.push('|');
                for val in vals {
                    out.push(' ');
                    push_md_cell(out, val.as_deref().unwrap_or("NULL"));
                    out.push_str(" |");
                }
                out.push('\n');
            }
            Self::Sql { table, quote, mysql_escape } => {
                // 按方言加引号；内部引号翻倍，防止标识符借引号逃逸（导出写入、回放触发注入）
                out.push_str("INSERT INTO ");
                out.push_str(&quote.quote(table));
                out.push_str(" (");
                for (idx, col) in cols.iter().enumerate() {
                    if idx > 0 { out.push_str(", "); }
                    out.push_str(&quote.quote(col));
                }
                out.push_str(") VALUES (");
                for (idx, val) in vals.iter().enumerate() {
                    if idx > 0 { out.push_str(", "); }
                    match val {
                        None => out.push_str("NULL"),
                        Some(s) => {
                            if s.starts_with("0x") && s.len() > 2 && s[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                                out.push_str(s);
                            } else {
                                out.push('\'');
                                if *mysql_escape { out.push_str(&sql_escape(s)); }
                                else { out.push_str(&s.replace('\'', "''")); }
                                out.push('\'');
                            }
                        }
                    }
                }
                out.push_str(");\n");
            }
        }
        Ok(())
    }

    fn write_finish_to(&mut self, out: &mut String) {
        if matches!(self, Self::Json { .. }) {
            out.push_str("\n]\n");
        }
    }
}

fn push_delimited_line<'a>(out: &mut String, sep: u8, cells: impl Iterator<Item = Option<&'a str>>) {
    let mut first = true;
    for cell in cells {
        if !first { out.push(sep as char); }
        first = false;
        if let Some(s) = cell {
            if sep == b',' {
                push_csv_cell(out, s);
            } else {
                push_tsv_cell(out, s);
            }
        }
    }
    out.push('\n');
}

fn push_csv_cell(out: &mut String, s: &str) {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        out.push('"');
        for ch in s.chars() {
            if ch == '"' {
                out.push_str("\"\"");
            } else {
                out.push(ch);
            }
        }
        out.push('"');
    } else {
        out.push_str(s);
    }
}

fn push_tsv_cell(out: &mut String, s: &str) {
    for ch in s.chars() {
        if matches!(ch, '\t' | '\n' | '\r') {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
}

fn push_md_cell(out: &mut String, s: &str) {
    for ch in s.chars() {
        if ch == '|' {
            out.push_str("\\|");
        } else if ch == '\n' || ch == '\r' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
}

// ── XLSX 流式写入 ────────────────────────────────────────────────────────────

struct XlsxWriter {
    zip: zip::ZipWriter<BufWriter<std::fs::File>>,
    row: u64,
    sheet: u32,
    max_rows_per_sheet: u64,
    header: Option<Vec<Option<String>>>,
    col_refs: Vec<String>,
    row_buf: String,
    sheet_buf: String,
}

enum XlsxCell {
    Text(String),
    Number(String),
}

impl XlsxWriter {
    fn new(file: std::fs::File) -> Result<Self, String> {
        Self::new_with_row_limit(file, XLSX_MAX_ROWS)
    }

    #[cfg(test)]
    fn new_with_row_limit_for_test(file: std::fs::File, max_rows_per_sheet: u64) -> Result<Self, String> {
        Self::new_with_row_limit(file, max_rows_per_sheet)
    }

    fn new_with_row_limit(file: std::fs::File, max_rows_per_sheet: u64) -> Result<Self, String> {
        if max_rows_per_sheet < 2 {
            return Err("Excel 每个工作表至少需要 2 行容量（表头 + 数据）".into());
        }
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1024 * 1024, file));

        Self::start_sheet_file(&mut zip, 1)?;
        Ok(Self {
            zip,
            row: 0,
            sheet: 1,
            max_rows_per_sheet,
            header: None,
            col_refs: Vec::new(),
            row_buf: String::with_capacity(16 * 1024),
            sheet_buf: String::with_capacity(XLSX_SHEET_FLUSH_BYTES + 64 * 1024),
        })
    }

    fn start_sheet_file(
        zip: &mut zip::ZipWriter<BufWriter<std::fs::File>>,
        sheet: u32,
    ) -> Result<(), String> {
        let options = xlsx_sheet_options();
        zip.start_file(format!("xl/worksheets/sheet{sheet}.xml"), options)
            .map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#)
            .map_err(|e| format!("写入 XLSX 失败: {e}"))
    }

    fn close_sheet(&mut self) -> Result<(), String> {
        self.flush_sheet_buf()?;
        self.zip.write_all(b"</sheetData></worksheet>").map_err(|e| format!("写入 XLSX 失败: {e}"))
    }

    fn write_header(&mut self, vals: &[Option<String>]) -> Result<(), String> {
        if vals.len()>16384 {return Err("Excel 每个工作表最多 16384 列，已停止导出".into());}
        self.header = Some(vals.to_vec());
        self.col_refs = (0..vals.len()).map(xlsx_col_ref).collect();
        self.write_row_raw(vals)
    }

    fn rollover_sheet(&mut self) -> Result<(), String> {
        self.close_sheet()?;
        self.sheet += 1;
        self.row = 0;
        Self::start_sheet_file(&mut self.zip, self.sheet)?;
        if let Some(header) = self.header.clone() {
            self.write_row_raw(&header)?;
        }
        Ok(())
    }

    fn write_row(&mut self, vals: &[Option<String>]) -> Result<(), String> {
        let cells: Vec<Option<XlsxCell>> = vals.iter()
            .map(|v| v.as_ref().map(|s| XlsxCell::Text(s.clone())))
            .collect();
        self.write_row_cells(&cells)
    }

    fn write_row_cells(&mut self, vals: &[Option<XlsxCell>]) -> Result<(), String> {
        if self.row >= self.max_rows_per_sheet {
            self.rollover_sheet()?;
        }
        self.write_cells_raw(vals)
    }

    fn write_row_raw(&mut self, vals: &[Option<String>]) -> Result<(), String> {
        let cells: Vec<Option<XlsxCell>> = vals.iter()
            .map(|v| v.as_ref().map(|s| XlsxCell::Text(s.clone())))
            .collect();
        self.write_cells_raw(&cells)
    }

    fn write_cells_raw(&mut self, vals: &[Option<XlsxCell>]) -> Result<(), String> {
        if vals.len()>16384 || self.header.as_ref().is_some_and(|header|header.len()!=vals.len()) {
            return Err("Excel 导出行与表头列数不一致或超过列数上限，已停止导出".into());
        }
        self.row += 1;
        self.row_buf.clear();
        write!(&mut self.row_buf, r#"<row r="{}">"#, self.row).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        for (idx, val) in vals.iter().enumerate() {
            if let Some(cell_value) = val {
                let col_ref = self.col_refs.get(idx).map(String::as_str).unwrap_or("");
                match cell_value {
                    XlsxCell::Text(s) => {
                        write!(&mut self.row_buf, r#"<c r="{col_ref}{}" t="inlineStr"><is><t xml:space="preserve">"#, self.row)
                            .map_err(|e| format!("写入 XLSX 失败: {e}"))?;
                        push_xml_text(&mut self.row_buf, s);
                        self.row_buf.push_str("</t></is></c>");
                    }
                    XlsxCell::Number(s) => {
                        write!(&mut self.row_buf, r#"<c r="{col_ref}{}"><v>{s}</v></c>"#, self.row)
                            .map_err(|e| format!("写入 XLSX 失败: {e}"))?;
                    }
                }
            }
        }
        self.row_buf.push_str("</row>");
        self.sheet_buf.push_str(&self.row_buf);
        if self.sheet_buf.len() >= XLSX_SHEET_FLUSH_BYTES {
            self.flush_sheet_buf()?;
        }
        Ok(())
    }

    fn flush_sheet_buf(&mut self) -> Result<(), String> {
        if self.sheet_buf.is_empty() {
            return Ok(());
        }
        self.zip.write_all(self.sheet_buf.as_bytes()).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.sheet_buf.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let options = xlsx_meta_options();

        self.close_sheet()?;

        self.zip.start_file("[Content_Types].xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        for sheet in 1..=self.sheet {
            writeln!(
                self.zip,
                r#"<Override PartName="/xl/worksheets/sheet{sheet}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
            ).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        }
        self.zip.write_all(br#"<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("_rels/.rels", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("xl/_rels/workbook.xml.rels", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        for sheet in 1..=self.sheet {
            writeln!(
                self.zip,
                r#"<Relationship Id="rId{sheet}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{sheet}.xml"/>"#
            ).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        }
        writeln!(
            self.zip,
            r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
            self.sheet + 1,
        ).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(b"</Relationships>").map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("xl/workbook.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        for sheet in 1..=self.sheet {
            write!(
                self.zip,
                r#"<sheet name="查询结果{sheet}" sheetId="{sheet}" r:id="rId{sheet}"/>"#
            ).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        }
        self.zip.write_all(b"</sheets></workbook>").map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("xl/styles.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("docProps/core.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>DBterm</dc:creator></cp:coreProperties>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        self.zip.start_file("docProps/app.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DBterm</Application></Properties>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        let mut writer = self.zip.finish().map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        writer.flush().map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        Ok(())
    }
}

fn xlsx_sheet_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(1))
        .large_file(true)
}

fn xlsx_meta_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true)
}

fn xlsx_col_ref(mut col: usize) -> String {
    let mut letters = Vec::new();
    loop {
        let rem = col % 26;
        letters.push((b'A' + rem as u8) as char);
        col /= 26;
        if col == 0 { break; }
        col -= 1;
    }
    letters.iter().rev().collect()
}

fn push_xml_text(out: &mut String, s: &str) {
    for (index,ch) in s.char_indices() {
        // Escape a literal OOXML escape prefix so Excel never interprets user
        // text such as _x0041_ as the character A.
        if ch=='_' {
            let tail=&s.as_bytes()[index..];
            if tail.len()>=7 && tail[1]==b'x' && tail[2..6].iter().all(u8::is_ascii_hexdigit) && tail[6]==b'_' {
                out.push_str("_x005F_");
                continue;
            }
        }
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{0}'..='\u{8}' | '\u{B}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}' => {
                // XML1.0 cannot carry these controls directly; CR also needs
                // escaping because XML parsers normalize it into LF.
                write!(out,"_x{:04X}_",ch as u32).expect("String write cannot fail");
            }
            _ => out.push(ch),
        }
    }
}

#[derive(Clone, Copy)]
enum MySqlExportCellKind {
    I8,
    I16,
    I32,
    I64,
    U8,
    U16,
    U32,
    U64,
    F32,
    F64,
    Date,
    DateTime,
    MySqlTime,
    Text,
    Bytes,
    UncheckedText,
    Unknown,
}

fn mysql_export_cell_kinds(columns: &[sqlx::mysql::MySqlColumn]) -> Vec<MySqlExportCellKind> {
    use sqlx::{Column, TypeInfo};
    columns.iter().map(|col| {
        let ty = col.type_info().name().to_ascii_uppercase();
        match ty.as_str() {
            "TINYINT" => MySqlExportCellKind::I8,
            "SMALLINT" => MySqlExportCellKind::I16,
            "MEDIUMINT" | "INT" | "INTEGER" => MySqlExportCellKind::I32,
            "BIGINT" => MySqlExportCellKind::I64,
            "TINYINT UNSIGNED" => MySqlExportCellKind::U8,
            "SMALLINT UNSIGNED" => MySqlExportCellKind::U16,
            "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "INTEGER UNSIGNED" => MySqlExportCellKind::U32,
            "BIGINT UNSIGNED" => MySqlExportCellKind::U64,
            "FLOAT" => MySqlExportCellKind::F32,
            "DOUBLE" | "REAL" => MySqlExportCellKind::F64,
            "DATE" => MySqlExportCellKind::Date,
            "DATETIME" | "TIMESTAMP" => MySqlExportCellKind::DateTime,
            "TIME" => MySqlExportCellKind::MySqlTime,
            "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT"
            | "ENUM" | "SET" | "JSON" => MySqlExportCellKind::Text,
            "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB"
            | "BIT" => MySqlExportCellKind::Bytes,
            "DECIMAL" | "NEWDECIMAL" => MySqlExportCellKind::UncheckedText,
            _ => MySqlExportCellKind::Unknown,
        }
    }).collect()
}

fn mysql_export_cell(row: &sqlx::mysql::MySqlRow, i: usize, kind: MySqlExportCellKind) -> Option<String> {
    use sqlx::Row;
    match kind {
        MySqlExportCellKind::I8 => row.try_get::<Option<i8>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::I16 => row.try_get::<Option<i16>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::I32 => row.try_get::<Option<i32>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::I64 => row.try_get::<Option<i64>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::U8 => row.try_get::<Option<u8>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::U16 => row.try_get::<Option<u16>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::U32 => row.try_get::<Option<u32>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::U64 => row.try_get::<Option<u64>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::F32 => row.try_get::<Option<f32>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::F64 => row.try_get::<Option<f64>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::Date => row.try_get::<Option<chrono::NaiveDate>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::DateTime => row.try_get_unchecked::<Option<chrono::NaiveDateTime>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::MySqlTime => row.try_get::<Option<sqlx::mysql::types::MySqlTime>, _>(i).ok().flatten().map(|v| v.to_string()),
        MySqlExportCellKind::Text => row.try_get::<Option<String>, _>(i).ok().flatten()
            .or_else(|| row.try_get::<Option<Vec<u8>>, _>(i).ok().flatten().and_then(|b| String::from_utf8(b).ok())),
        MySqlExportCellKind::Bytes => row.try_get::<Option<Vec<u8>>, _>(i).ok().flatten()
            .map(|b| String::from_utf8(b).unwrap_or_else(|e| format!("0x{}", hex::encode(e.into_bytes())))),
        MySqlExportCellKind::UncheckedText => row.try_get_unchecked::<Option<String>, _>(i).ok().flatten()
            .or_else(|| row.try_get_unchecked::<Option<Vec<u8>>, _>(i).ok().flatten().and_then(|b| String::from_utf8(b).ok())),
        MySqlExportCellKind::Unknown => crate::commands::query::mysql_cell(row, i),
    }
}

pub(crate) fn mysql_export_values_checked(row: &sqlx::mysql::MySqlRow) -> Result<Vec<Option<String>>,String> {
    use sqlx::Row;
    let kinds=mysql_export_cell_kinds(row.columns());
    (0..kinds.len()).map(|i|mysql_export_cell_checked(row,i,kinds[i])).collect()
}

/// Never confuse a failed conversion with a genuine protocol NULL.
fn mysql_export_cell_checked(row: &sqlx::mysql::MySqlRow, i: usize, kind: MySqlExportCellKind) -> Result<Option<String>, String> {
    use sqlx::{Column, Row, TypeInfo, Decode, MySql};
    let fail = || format!("列 {}（{}）无法无损导出，已停止且未发布文件", row.column(i).name(), row.column(i).type_info().name());
    let raw = row.try_get_raw(i).map_err(|_| fail())?;
    let bytes = match <&[u8] as Decode<MySql>>::decode(raw) {
        Ok(bytes) => bytes,
        Err(error) if error.is::<sqlx::error::UnexpectedNullError>() => return Ok(None),
        Err(_) => return Err(fail()),
    };
    if matches!(kind, MySqlExportCellKind::Bytes) {
        return Ok(Some(format!("0x{}", hex::encode(bytes))));
    }
    if row.column(i).type_info().name().eq_ignore_ascii_case("YEAR") {
        return row.try_get_unchecked::<u16,_>(i).map(|v|Some(v.to_string())).map_err(|_|fail());
    }
    if row.column(i).type_info().name().eq_ignore_ascii_case("BOOLEAN") {
        return row.try_get::<i8,_>(i).map(|v|Some(v.to_string()))
            .or_else(|_| row.try_get::<u8,_>(i).map(|v|Some(v.to_string()))).map_err(|_|fail());
    }
    if matches!(kind, MySqlExportCellKind::Unknown) { return Err(fail()); }
    mysql_export_cell(row,i,kind).map(Some).ok_or_else(fail)
}

/// SQL values must retain type information: display text cannot distinguish a BLOB
/// from text beginning with `0x`, or a decode failure from a database NULL.
pub(crate) fn mysql_sql_values(row: &sqlx::mysql::MySqlRow) -> Result<Vec<String>, String> {
    use sqlx::{Column, Row, TypeInfo, ValueRef};
    let kinds = mysql_export_cell_kinds(row.columns());
    row.columns().iter().enumerate().map(|(i, col)| {
        let fail = || format!("列 {}（{}）无法无损导出，已终止导出", col.name(), col.type_info().name());
        if row.try_get_raw(i).map_err(|_| fail())?.is_null() {
            // sqlx reports zero dates as NULL too. A direct bytes decode succeeds
            // for a zero date but fails for a genuine protocol NULL.
            if matches!(kinds[i], MySqlExportCellKind::Date | MySqlExportCellKind::DateTime)
                && row.try_get_unchecked::<Vec<u8>, _>(i).is_ok() {
                return Err(fail());
            }
            return Ok("NULL".into());
        }
        let kind = kinds[i];
        // Raw result ENUM/SET text does not retain member identity (empty and
        // comma-bearing members collide). Table exports use numeric projections.
        if matches!(col.type_info().name(), "ENUM" | "SET") {
            return Err(format!("列 {} 的 ENUM/SET 文本无法证明成员身份，请使用表 SQL 导出（内部序号/位图投影）或显式 CAST AS UNSIGNED 后导出", col.name()));
        }
        if matches!(kind, MySqlExportCellKind::Bytes) {
            let bytes: Vec<u8> = row.try_get_unchecked(i).map_err(|_| fail())?;
            if col.type_info().name().eq_ignore_ascii_case("BIT") {
                if bytes.len() > 8 { return Err(fail()); }
                let value = bytes.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
                return Ok(value.to_string());
            }
            return Ok(format!("X'{}'", hex::encode(bytes)));
        }
        let value = if col.type_info().name().eq_ignore_ascii_case("BOOLEAN") {
            row.try_get::<i8, _>(i).map(|n| n.to_string())
                .or_else(|_| row.try_get::<u8, _>(i).map(|n| n.to_string())).map_err(|_| fail())?
        } else if col.type_info().name().eq_ignore_ascii_case("YEAR") {
            row.try_get_unchecked::<u16, _>(i).map(|n| n.to_string()).map_err(|_| fail())?
        } else {
            if matches!(kind, MySqlExportCellKind::Unknown) { return Err(fail()); }
            mysql_export_cell(row, i, kind).ok_or_else(fail)?
        };
        if matches!(kind, MySqlExportCellKind::I8 | MySqlExportCellKind::I16 | MySqlExportCellKind::I32
            | MySqlExportCellKind::I64 | MySqlExportCellKind::U8 | MySqlExportCellKind::U16
            | MySqlExportCellKind::U32 | MySqlExportCellKind::U64 | MySqlExportCellKind::F32
            | MySqlExportCellKind::F64 | MySqlExportCellKind::UncheckedText)
            || matches!(col.type_info().name(), "YEAR" | "BOOLEAN") {
            return Ok(value);
        }
        // Hex-encoded UTF-8 text is independent of NO_BACKSLASH_ESCAPES and
        // preserves NUL, backslashes, quotes, empty strings, and literal "0x...".
        Ok(format!("CONVERT(X'{}' USING utf8mb4)", hex::encode(value.as_bytes())))
    }).collect()
}

pub(crate) async fn mysql_export_session_header(conn: &mut sqlx::mysql::MySqlConnection) -> Result<String, String> {
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut *conn).await
        .map_err(|e| format!("读取导出 SQL 模式失败: {e}"))?;
    sqlx::query("SET time_zone = '+00:00'").execute(conn).await
        .map_err(|e| format!("设置导出时区失败: {e}"))?;
    Ok(format!("SET @DBTERM_OLD_SQL_MODE=@@SESSION.sql_mode;\nSET @DBTERM_OLD_TIME_ZONE=@@SESSION.time_zone;\nSET SQL_MODE=CONCAT(CONVERT(X'{}' USING utf8mb4), ',NO_AUTO_VALUE_ON_ZERO');\nSET TIME_ZONE='+00:00';\n", hex::encode(mode.as_bytes())))
}

pub(crate) const MYSQL_EXPORT_SESSION_FOOTER: &str = "SET SQL_MODE=@DBTERM_OLD_SQL_MODE;\nSET TIME_ZONE=@DBTERM_OLD_TIME_ZONE;\n";

/// Explicit columns include INVISIBLE data and omit server-generated values.
pub(crate) async fn mysql_export_projection(
    conn: &mut sqlx::mysql::MySqlConnection,
    target: &str,
) -> Result<String, String> {
    use sqlx::Row;
    let rows = sqlx::query(&format!("SHOW FULL COLUMNS FROM {target}"))
        .fetch_all(conn).await.map_err(|e| format!("读取导出列失败: {e}"))?;
    let mut columns = Vec::new();
    for row in rows {
        let extra: String = row.try_get("Extra").map_err(|e| format!("读取导出列属性失败: {e}"))?;
        let extra = extra.to_ascii_uppercase();
        if extra.contains("VIRTUAL GENERATED") || extra.contains("STORED GENERATED")
            || extra.contains("PERSISTENT GENERATED") { continue; }
        let name: String = row.try_get("Field").map_err(|e| format!("读取导出列名称失败: {e}"))?;
        let quoted = IdentQuote::Backtick.quote(&name);
        // SHOW FULL COLUMNS may flag Type as binary/BLOB (notably ENUM/SET).
        // Its documented textual metadata still requires valid UTF-8; never decode lossily.
        let kind: String = row.try_get_unchecked("Type").map_err(|e| format!("读取导出列类型失败: {e}"))?;
        let kind = kind.to_ascii_lowercase();
        columns.push(if kind.starts_with("enum(") || kind.starts_with("set(") {
            // Preserve ordinal/bitmask, including an empty member and ENUM zero.
            format!("CAST({quoted} AS UNSIGNED) AS {quoted}")
        } else { quoted });
    }
    if columns.is_empty() { return Err("表没有可导出的非生成列".into()); }
    Ok(columns.join(", "))
}

fn mysql_xlsx_cell(row: &sqlx::mysql::MySqlRow, i: usize, kind: MySqlExportCellKind) -> Result<Option<XlsxCell>, String> {
    let is_numeric = matches!(
        kind,
        MySqlExportCellKind::I8
            | MySqlExportCellKind::I16
            | MySqlExportCellKind::I32
            | MySqlExportCellKind::I64
            | MySqlExportCellKind::U8
            | MySqlExportCellKind::U16
            | MySqlExportCellKind::U32
            | MySqlExportCellKind::U64
            | MySqlExportCellKind::F32
            | MySqlExportCellKind::F64
            | MySqlExportCellKind::UncheckedText
    );
    Ok(mysql_export_cell_checked(row, i, kind)?.map(|v| {
        if is_numeric && is_xlsx_number_literal(&v) {
            XlsxCell::Number(v)
        } else {
            XlsxCell::Text(v)
        }
    }))
}

#[derive(Clone, Copy)]
enum PgExportCellKind {
    Bool,
    I16,
    I32,
    I64,
    F32,
    F64,
    Date,
    DateTime,
    Time,
    DateTimeTz,
    Text,
    Bytes,
    Unknown,
}

fn pg_export_cell_kinds(columns: &[sqlx::postgres::PgColumn]) -> Vec<PgExportCellKind> {
    use sqlx::{Column, TypeInfo};
    columns.iter().map(|col| {
        match col.type_info().name().to_ascii_uppercase().as_str() {
            "BOOL" | "BOOLEAN" => PgExportCellKind::Bool,
            "INT2" | "SMALLINT" => PgExportCellKind::I16,
            "INT4" | "INTEGER" => PgExportCellKind::I32,
            "INT8" | "BIGINT" => PgExportCellKind::I64,
            "FLOAT4" | "REAL" => PgExportCellKind::F32,
            "FLOAT8" | "DOUBLE PRECISION" => PgExportCellKind::F64,
            "DATE" => PgExportCellKind::Date,
            "TIMESTAMP" => PgExportCellKind::DateTime,
            "TIME" => PgExportCellKind::Time,
            "TIMESTAMPTZ" => PgExportCellKind::DateTimeTz,
            "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "NUMERIC" | "DECIMAL"
            | "JSON" | "JSONB" | "UUID" | "INET" | "CIDR" | "MACADDR" => PgExportCellKind::Text,
            "BYTEA" => PgExportCellKind::Bytes,
            _ => PgExportCellKind::Unknown,
        }
    }).collect()
}

fn pg_export_cell(row: &sqlx::postgres::PgRow, i: usize, kind: PgExportCellKind) -> Option<String> {
    use sqlx::Row;
    match kind {
        PgExportCellKind::Bool => row.try_get::<Option<bool>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::I16 => row.try_get::<Option<i16>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::I32 => row.try_get::<Option<i32>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::I64 => row.try_get::<Option<i64>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::F32 => row.try_get::<Option<f32>, _>(i).ok().flatten().map(super::db_extra::fmt_f32),
        PgExportCellKind::F64 => row.try_get::<Option<f64>, _>(i).ok().flatten().map(super::db_extra::fmt_f64),
        PgExportCellKind::Date => row.try_get::<Option<chrono::NaiveDate>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::DateTime => row.try_get::<Option<chrono::NaiveDateTime>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::Time => row.try_get::<Option<chrono::NaiveTime>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::DateTimeTz => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i).ok().flatten().map(|v| v.to_string()),
        PgExportCellKind::Text => row.try_get::<Option<String>, _>(i).ok().flatten(),
        PgExportCellKind::Bytes => row.try_get::<Option<Vec<u8>>, _>(i).ok().flatten().map(|b| format!("0x{}", hex::encode(b))),
        PgExportCellKind::Unknown => crate::commands::query::pg_cell(row, i),
    }
}

/// PostgreSQL SQL dumps use the simple-query text protocol: PostgreSQL's own
/// output/input representation retains NUMERIC, arrays, UUID, JSON, and BYTEA.
/// This helper must only receive rows fetched with raw_sql (not binary queries).
pub(crate) fn pg_sql_values(row: &sqlx::postgres::PgRow) -> Result<Vec<String>, String> {
    use sqlx::{Column, Row, TypeInfo, ValueRef};
    row.columns().iter().enumerate().map(|(i, col)| {
        if row.try_get_raw(i).map_err(|e| e.to_string())?.is_null() { return Ok("NULL".into()); }
        if col.type_info().name().eq_ignore_ascii_case("MONEY") {
            return Err(format!("列 {} 的 MONEY 值依赖服务器区域设置，暂不支持无损 SQL 导出", col.name()));
        }
        let text: String = row.try_get_unchecked(i)
            .map_err(|e| format!("列 {} 无法无损导出: {e}", col.name()))?;
        Ok(format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''")))
    }).collect()
}

pub(crate) async fn pg_prepare_sql_export(conn: &mut sqlx::postgres::PgConnection) -> Result<(), String> {
    for statement in ["SET DateStyle='ISO, YMD'", "SET IntervalStyle='postgres'", "SET extra_float_digits=3"] {
        sqlx::query(statement).execute(&mut *conn).await.map_err(|e| format!("设置 PostgreSQL 导出格式失败: {e}"))?;
    }
    Ok(())
}

/// SQLite's decimal parser is not always correctly rounded (e.g. tiny REALs).
/// Rebuild the exact IEEE-754 value using an integer significand and powers of 2.
/// Every intermediate value is exact, so import preserves all finite f64 bits.
fn sqlite_real_literal(value: f64) -> String {
    let bits = value.to_bits();
    let fraction = bits & ((1u64 << 52) - 1);
    let encoded_exponent = ((bits >> 52) & 0x7ff) as i32;
    let (mantissa, mut exponent) = if encoded_exponent == 0 { (fraction, -1074) }
        else { (fraction | (1u64 << 52), encoded_exponent - 1023 - 52) };
    let sign = if bits >> 63 != 0 { "-" } else { "" };
    let mut expression = format!("CAST({sign}{mantissa} AS REAL)");
    while exponent != 0 {
        let shift = exponent.unsigned_abs().min(32);
        let factor = 1u64 << shift;
        if exponent > 0 { expression.push_str(&format!(" * {factor}")); exponent -= shift as i32; }
        else { expression.push_str(&format!(" / {factor}")); exponent += shift as i32; }
    }
    format!("({expression})")
}

pub(crate) fn sqlite_sql_values(row: &sqlx::sqlite::SqliteRow) -> Result<Vec<String>, String> {
    use sqlx::{Column, Row, TypeInfo, ValueRef};
    row.columns().iter().enumerate().map(|(i, col)| {
        let raw = row.try_get_raw(i).map_err(|e| e.to_string())?;
        if raw.is_null() { return Ok("NULL".into()); }
        let err = |e| format!("列 {} 无法无损导出: {e}", col.name());
        match raw.type_info().name() {
            "INTEGER" | "INT" | "BOOLEAN" => row.try_get_unchecked::<i64, _>(i).map(|n| n.to_string()).map_err(err),
            "REAL" | "FLOAT" => {
                let value: f64 = row.try_get_unchecked(i).map_err(err)?;
                if !value.is_finite() { return Err(format!("列 {} 包含非有限浮点数，暂不支持无损 SQL 导出", col.name())); }
                Ok(sqlite_real_literal(value))
            }
            "BLOB" => row.try_get_unchecked::<Vec<u8>, _>(i).map(|b| format!("X'{}'", hex::encode(b))).map_err(err),
            "TEXT" => row.try_get_unchecked::<String, _>(i).map(|text| format!("CAST(X'{}' AS TEXT)", hex::encode(text.as_bytes()))).map_err(err),
            ty => Err(format!("列 {} 的类型 {ty} 暂不支持无损 SQL 导出", col.name())),
        }
    }).collect()
}

fn sqlserver_text_literal(text: &str) -> String {
    let bytes = text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    format!("CONVERT(nvarchar(max),0x{})", hex::encode(bytes))
}

pub(crate) fn sqlserver_sql_values(row: &tiberius::Row) -> Result<Vec<String>, String> {
    use tiberius::ColumnData as D;
    row.cells().enumerate().map(|(i, (column, value))| {
        macro_rules! scalar { ($v:expr) => { Ok($v.as_ref().map(ToString::to_string).unwrap_or_else(|| "NULL".into())) }; }
        macro_rules! temporal { ($v:expr, $ty:ty, $sql_ty:expr) => {{
            if $v.is_none() { return Ok("NULL".into()); }
            let value = row.try_get::<$ty, _>(i).map_err(|e| format!("列 {} 无法无损导出: {e}", column.name()))?
                .ok_or_else(|| format!("列 {} 解码丢失了非空值", column.name()))?;
            Ok(format!("CONVERT({}, '{}', 127)", $sql_ty, value.to_string().replacen(' ', "T", 1).replace(' ', "")))
        }}; }
        if matches!(column.column_type(), tiberius::ColumnType::Money | tiberius::ColumnType::Money4) {
            return Err(format!("列 {} 的 MONEY 值已被驱动转换为浮点数，暂不支持无损 SQL 导出", column.name()));
        }
        match value {
            D::U8(v) => scalar!(v), D::I16(v) => scalar!(v), D::I32(v) => scalar!(v), D::I64(v) => scalar!(v),
            D::F32(v) => { if v.is_some_and(|x| !x.is_finite()) { return Err("非有限浮点数无法无损导出".into()); } scalar!(v) }
            D::F64(v) => { if v.is_some_and(|x| !x.is_finite()) { return Err("非有限浮点数无法无损导出".into()); } scalar!(v) }
            D::Bit(v) => Ok(v.map(|x| if x { "1" } else { "0" }).unwrap_or("NULL").into()),
            D::String(v) => Ok(v.as_ref().map(|x| sqlserver_text_literal(x)).unwrap_or_else(|| "NULL".into())),
            D::Binary(v) => Ok(v.as_ref().map(|x| format!("0x{}", hex::encode(x))).unwrap_or_else(|| "NULL".into())),
            D::Guid(v) => Ok(v.as_ref().map(|x| format!("'{x}'")).unwrap_or_else(|| "NULL".into())),
            D::Numeric(v) => v.as_ref().map(|n| scaled_decimal(&n.value().to_string(), n.scale() as usize)).unwrap_or_else(|| Ok("NULL".into())),
            D::Xml(v) => Ok(v.as_ref().map(|x| sqlserver_text_literal(&x.to_string())).unwrap_or_else(|| "NULL".into())),
            D::DateTime(v) => temporal!(v, chrono::NaiveDateTime, "datetime"),
            D::SmallDateTime(v) => temporal!(v, chrono::NaiveDateTime, "smalldatetime"),
            D::Date(v) => temporal!(v, chrono::NaiveDate, "date"),
            D::Time(v) => temporal!(v, chrono::NaiveTime, "time(7)"),
            D::DateTime2(v) => temporal!(v, chrono::NaiveDateTime, "datetime2(7)"),
            D::DateTimeOffset(v) => temporal!(v, chrono::DateTime<chrono::FixedOffset>, "datetimeoffset(7)"),
        }
    }).collect()
}

fn scaled_decimal(raw: &str, scale: usize) -> Result<String, String> {
    if scale > 76 { return Err("Decimal 小数位超出支持范围".into()); }
    let (sign, digits) = raw.strip_prefix('-').map(|s| ("-", s)).unwrap_or(("", raw));
    if !digits.bytes().all(|c| c.is_ascii_digit()) || digits.is_empty() { return Err("Decimal 数据无效".into()); }
    if scale == 0 { return Ok(format!("{sign}{digits}")); }
    let digits = format!("{:0>width$}", digits, width = (scale + 1).max(digits.len()));
    let pos = digits.len() - scale;
    Ok(format!("{sign}{}.{}", &digits[..pos], &digits[pos..]))
}

fn clickhouse_sql_value(value: &klickhouse::Value) -> Result<String, String> {
    use klickhouse::Value as V;
    macro_rules! decimal { ($n:expr, $scale:expr, $bits:expr) => {
        Ok(format!("toDecimal{}('{}', {})", $bits, scaled_decimal(&$n.to_string(), *$scale)?, $scale))
    }; }
    match value {
        V::Null => Ok("NULL".into()),
        V::String(bytes) => Ok(format!("unhex('{}')", hex::encode(bytes))),
        V::Int8(v) => Ok(v.to_string()), V::Int16(v) => Ok(v.to_string()), V::Int32(v) => Ok(v.to_string()), V::Int64(v) => Ok(v.to_string()),
        V::UInt8(v) => Ok(v.to_string()), V::UInt16(v) => Ok(v.to_string()), V::UInt32(v) => Ok(v.to_string()), V::UInt64(v) => Ok(v.to_string()),
        V::Int128(v) => Ok(format!("toInt128('{v}')")), V::Int256(v) => Ok(format!("toInt256('{v}')")),
        V::UInt128(v) => Ok(format!("toUInt128('{v}')")), V::UInt256(v) => Ok(format!("toUInt256('{v}')")),
        V::Float32(v) => Ok(format!("toFloat32('{v}')")), V::Float64(v) => Ok(format!("toFloat64('{v}')")),
        V::Decimal32(scale, n) => decimal!(n, scale, 32), V::Decimal64(scale, n) => decimal!(n, scale, 64),
        V::Decimal128(scale, n) => decimal!(n, scale, 128), V::Decimal256(scale, n) => decimal!(n, scale, 256),
        V::Uuid(v) => Ok(format!("toUUID('{v}')")),
        V::Enum8(v) => Ok(v.to_string()), V::Enum16(v) => Ok(v.to_string()),
        V::Date(v) => Ok(format!("toDate({})", v.0)),
        V::DateTime(v) => Ok(format!("toDateTime({}, '{}')", v.1, v.0)),
        V::DateTime64(v) => {
            if v.2 > 9 { return Err("DateTime64 精度不受支持".into()); }
            let nanos = i64::try_from((v.1 as i64 as i128) * 10i128.pow(9 - v.2 as u32))
                .map_err(|_| "DateTime64 超出无损纳秒导出范围".to_string())?;
            Ok(format!("fromUnixTimestamp64Nano(toInt64('{nanos}'), '{}')", v.0))
        }
        V::Array(values) => Ok(format!("[{}]", values.iter().map(clickhouse_sql_value).collect::<Result<Vec<_>, _>>()?.join(", "))),
        V::Tuple(values) => Ok(format!("tuple({})", values.iter().map(clickhouse_sql_value).collect::<Result<Vec<_>, _>>()?.join(", "))),
        V::Map(keys, values) => {
            if keys.len() != values.len() { return Err("Map 键值数量不一致".into()); }
            let pairs = keys.iter().zip(values).map(|(k, v)| Ok(format!("{}, {}", clickhouse_sql_value(k)?, clickhouse_sql_value(v)?))).collect::<Result<Vec<_>, String>>()?;
            Ok(format!("map({})", pairs.join(", ")))
        }
        V::Ipv4(v) => Ok(format!("toIPv4('{v}')")), V::Ipv6(v) => Ok(format!("toIPv6('{v}')")),
        V::Point(_) | V::Ring(_) | V::Polygon(_) | V::MultiPolygon(_) => Err("地理类型暂不支持无损 SQL 导出".into()),
    }
}

fn write_sql_literals(fmt: &RowWriter<'_>, out: &mut String, columns: &[String], values: &[String]) -> Result<(),String> {
    fmt.validate_columns(columns)?;
    if columns.len()!=values.len(){return Err("导出行与字段数量不一致，已停止导出".into());}
    if let RowWriter::Sql { table, quote, .. } = fmt {
        let columns = columns.iter().map(|c| quote.quote(c)).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("INSERT INTO {} ({columns}) VALUES ({});\n", quote.quote(table), values.join(", ")));
    }
    Ok(())
}

fn pg_xlsx_cell(row: &sqlx::postgres::PgRow, i: usize, kind: PgExportCellKind) -> Option<XlsxCell> {
    let is_numeric = matches!(
        kind,
        PgExportCellKind::I16
            | PgExportCellKind::I32
            | PgExportCellKind::I64
            | PgExportCellKind::F32
            | PgExportCellKind::F64
    );
    pg_export_cell(row, i, kind).map(|v| {
        if is_numeric && is_xlsx_number_literal(&v) {
            XlsxCell::Number(v)
        } else {
            XlsxCell::Text(v)
        }
    })
}

fn is_xlsx_number_literal(s: &str) -> bool {
    let Ok(value)=s.parse::<f64>() else {return false;};
    if !value.is_finite() || (value!=0.0 && value.abs()<f64::MIN_POSITIVE) {return false;}
    // Excel stores numbers with at most 15 significant decimal digits. Keep
    // database bigint/decimal values outside that guarantee as inline text.
    let mantissa=s.split(['e','E']).next().unwrap_or(s);
    let digits=mantissa.bytes().filter(u8::is_ascii_digit).skip_while(|b|*b==b'0').collect::<Vec<_>>();
    if value==0.0 && digits.iter().any(|b|*b!=b'0') {return false;}
    digits.len()<=15
}

// ── 编码写入包装 ───────────────────────────────────────────────────────────────

struct EncodedWriter {
    inner: BufWriter<std::fs::File>,
    encoding: Enc,
}

enum Enc { Utf8, Gbk }

impl EncodedWriter {
    fn write_str(&mut self, s: &str) -> std::io::Result<()> {
        match self.encoding {
            Enc::Utf8 => self.inner.write_all(s.as_bytes()),
            Enc::Gbk  => {
                let (encoded, _, unmappable) = encoding_rs::GBK.encode(s);
                if unmappable { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "导出内容包含 GBK 无法表示的字符，请选择 UTF-8")); }
                self.inner.write_all(&encoded)
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
}

fn flush_text_export_buffer(ew: &mut EncodedWriter, out: &mut String) -> Result<(), String> {
    if out.is_empty() {
        return Ok(());
    }
    ew.write_str(out).map_err(|e| format!("写入失败: {e}"))?;
    out.clear();
    Ok(())
}

// ── 流式导出核心 ──────────────────────────────────────────────────────────────

async fn export_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let session_header = if matches!(fmt, RowWriter::Sql { .. }) { Some(mysql_export_session_header(conn).await?) } else { None };
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut cell_kinds: Vec<MySqlExportCellKind> = Vec::new();
    let mut rows = 0u64;
    let mut out = String::with_capacity(TEXT_EXPORT_FLUSH_BYTES + 64 * 1024);

    if let Some(header) = &session_header { out.push_str(header); }

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            cell_kinds = mysql_export_cell_kinds(row.columns());
            fmt.write_header_to(&mut out, &names)?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| mysql_export_cell_checked(&row, i, cell_kinds[i])).collect::<Result<_,_>>()?;

        if let RowWriter::Sql { table, quote, .. } = fmt {
            let values = mysql_sql_values(&row)?;
            let columns = col_names.iter().map(|c| quote.quote(c)).collect::<Vec<_>>().join(", ");
            out.push_str(&format!("INSERT INTO {} ({columns}) VALUES ({});\n", quote.quote(table), values.join(", ")));
        } else {
            fmt.write_row_to(&mut out, col_names, &vals)?;
        }
        rows += 1;

        if out.len() >= TEXT_EXPORT_FLUSH_BYTES {
            flush_text_export_buffer(ew, &mut out)?;
        }
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    if session_header.is_some() { out.push_str(MYSQL_EXPORT_SESSION_FOOTER); }
    flush_text_export_buffer(ew, &mut out)?;
    Ok(rows)
}

async fn export_pg(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let sql_dump = matches!(fmt, RowWriter::Sql { .. });
    if sql_dump { pg_prepare_sql_export(conn).await?; }
    let mut stream = if sql_dump { sqlx::Executor::fetch(&mut *conn, sql) }
        else { sqlx::query(sql).fetch(&mut *conn) };
    let mut cols: Option<Vec<String>> = None;
    let mut cell_kinds: Vec<PgExportCellKind> = Vec::new();
    let mut rows = 0u64;
    let mut out = String::with_capacity(TEXT_EXPORT_FLUSH_BYTES + 64 * 1024);

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            cell_kinds = pg_export_cell_kinds(row.columns());
            fmt.write_header_to(&mut out, &names)?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| pg_export_cell(&row, i, cell_kinds[i])).collect();

        if sql_dump {
            let mut statement = String::new();
            write_sql_literals(fmt, &mut statement, col_names, &pg_sql_values(&row)?)?;
            out.push_str(&statement.replacen(") VALUES (", ") OVERRIDING SYSTEM VALUE VALUES (", 1));
        }
        else { fmt.write_row_to(&mut out, col_names, &vals)?; }
        rows += 1;

        if out.len() >= TEXT_EXPORT_FLUSH_BYTES {
            flush_text_export_buffer(ew, &mut out)?;
        }
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    flush_text_export_buffer(ew, &mut out)?;
    Ok(rows)
}

async fn export_sqlite(
    conn: &mut sqlx::sqlite::SqliteConnection,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;
    let mut out = String::with_capacity(TEXT_EXPORT_FLUSH_BYTES + 64 * 1024);

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            fmt.write_header_to(&mut out, &names)?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::sqlite_cell(&row, i)).collect();

        if matches!(fmt, RowWriter::Sql { .. }) { write_sql_literals(fmt, &mut out, col_names, &sqlite_sql_values(&row)?)?; }
        else { fmt.write_row_to(&mut out, col_names, &vals)?; }
        rows += 1;

        if out.len() >= TEXT_EXPORT_FLUSH_BYTES {
            flush_text_export_buffer(ew, &mut out)?;
        }
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    flush_text_export_buffer(ew, &mut out)?;
    Ok(rows)
}

async fn export_xlsx_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut cell_kinds: Vec<MySqlExportCellKind> = Vec::new();
    let mut rows = 0u64;

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            cell_kinds = mysql_export_cell_kinds(row.columns());
            xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<XlsxCell>> = (0..col_names.len())
            .map(|i| mysql_xlsx_cell(&row, i, cell_kinds[i])).collect::<Result<_,_>>()?;
        xw.write_row_cells(&vals)?;
        rows += 1;

        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    Ok(rows)
}

async fn export_xlsx_pg(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut cell_kinds: Vec<PgExportCellKind> = Vec::new();
    let mut rows = 0u64;

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            cell_kinds = pg_export_cell_kinds(row.columns());
            xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<XlsxCell>> = (0..col_names.len())
            .map(|i| pg_xlsx_cell(&row, i, cell_kinds[i])).collect();
        xw.write_row_cells(&vals)?;
        rows += 1;

        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    Ok(rows)
}

async fn export_xlsx_sqlite(
    conn: &mut sqlx::sqlite::SqliteConnection,
    sql: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    use sqlx::{Row, Column};
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::sqlite_cell(&row, i)).collect();
        xw.write_row(&vals)?;
        rows += 1;

        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    Ok(rows)
}

async fn export_sqlserver(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    ss_pool: &SsPool,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    use tiberius::QueryItem;
    let entry_arc = crate::commands::sqlserver::get_entry(
        id,
        ss_pool,
        config,
        crate::keychain::get_password(id)?.as_deref(),
    ).await?;
    let mut entry = entry_arc.lock().await;
    let mut stream = entry.client.simple_query(sql).await
        .map_err(|e| format!("SQL Server 查询失败: {e}"))?;

    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;
    let mut identity_guard_written = false;
    let mut buf = String::with_capacity(8 * 1024);

    while let Some(item) = stream.try_next().await.map_err(|e| format!("SQL Server 读取失败: {e}"))? {
        match item {
            QueryItem::Metadata(meta) => {
                if cols.is_none() {
                    let names: Vec<String> = meta.columns().iter().map(|c| c.name().to_string()).collect();
                    buf.clear();
                    fmt.write_header_to(&mut buf, &names)?;
                    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                    cols = Some(names);
                }
            }
            QueryItem::Row(row) => {
                if cols.is_none() {
                    let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
                    buf.clear();
                    fmt.write_header_to(&mut buf, &names)?;
                    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                    cols = Some(names);
                }
                let col_names = cols.as_ref().unwrap();
                let vals: Vec<Option<String>> = if matches!(fmt, RowWriter::Sql { .. }) { Vec::new() }
                    else { (0..col_names.len()).map(|i| crate::commands::sqlserver::cell_to_string(&row, i)).collect() };
                buf.clear();
                if let RowWriter::Sql { table, quote, .. } = fmt {
                    if !identity_guard_written {
                        let target = quote.quote(table);
                        let name_literals = col_names.iter().map(|name| sqlserver_text_literal(name)).collect::<Vec<_>>().join(", ");
                        buf.push_str(&format!("DECLARE @DBTERM_HAS_IDENTITY bit = CASE WHEN EXISTS (SELECT 1 FROM sys.identity_columns WHERE object_id=OBJECT_ID({}) AND name IN ({name_literals})) THEN 1 ELSE 0 END;\nIF @DBTERM_HAS_IDENTITY=1 SET IDENTITY_INSERT {target} ON;\n", sqlserver_text_literal(&target)));
                        identity_guard_written = true;
                    }
                    write_sql_literals(fmt, &mut buf, col_names, &sqlserver_sql_values(&row)?)?;
                }
                else { fmt.write_row_to(&mut buf, col_names, &vals)?; }
                ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                rows += 1;

                if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                if rows % PROGRESS_INTERVAL == 0 {
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(event, ExportProgressEvt {
                        rows, elapsed_ms: ms,
                        rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                        file_bytes: 0, done: false, cancelled: false, error: None,
                    });
                }
            }
        }
    }
    if identity_guard_written {
        if let RowWriter::Sql { table, quote, .. } = fmt {
            ew.write_str(&format!("IF @DBTERM_HAS_IDENTITY=1 SET IDENTITY_INSERT {} OFF;\n", quote.quote(table))).map_err(|e| format!("写入失败: {e}"))?;
        }
    }
    Ok(rows)
}

async fn export_xlsx_sqlserver(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    ss_pool: &SsPool,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    use tiberius::QueryItem;
    let entry_arc = crate::commands::sqlserver::get_entry(
        id,
        ss_pool,
        config,
        crate::keychain::get_password(id)?.as_deref(),
    ).await?;
    let mut entry = entry_arc.lock().await;
    let mut stream = entry.client.simple_query(sql).await
        .map_err(|e| format!("SQL Server 查询失败: {e}"))?;

    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;

    while let Some(item) = stream.try_next().await.map_err(|e| format!("SQL Server 读取失败: {e}"))? {
        match item {
            QueryItem::Metadata(meta) => {
                if cols.is_none() {
                    let names: Vec<String> = meta.columns().iter().map(|c| c.name().to_string()).collect();
                    xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
                    cols = Some(names);
                }
            }
            QueryItem::Row(row) => {
                if cols.is_none() {
                    let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
                    xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
                    cols = Some(names);
                }
                let col_names = cols.as_ref().unwrap();
                let vals: Vec<Option<String>> = (0..col_names.len())
                    .map(|i| crate::commands::sqlserver::cell_to_string(&row, i)).collect();
                xw.write_row(&vals)?;
                rows += 1;

                if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                if rows % PROGRESS_INTERVAL == 0 {
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(event, ExportProgressEvt {
                        rows, elapsed_ms: ms,
                        rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                        file_bytes: 0, done: false, cancelled: false, error: None,
                    });
                }
            }
        }
    }
    Ok(rows)
}

async fn export_clickhouse_tcp(
    config: &crate::models::ConnConfig,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    let client = crate::commands::clickhouse_tcp::connect(config, crate::keychain::get_password(&config.id)?.as_deref()).await?;
    let mut stream = client.query_raw(sql).await
        .map_err(|e| format!("ClickHouse 查询失败: {e}"))?;
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;
    let mut buf = String::with_capacity(16 * 1024);

    while let Some(block) = stream.next().await {
        let block = block.map_err(|e| format!("ClickHouse 读取数据块失败: {e}"))?;
        if cols.is_none() && !block.column_types.is_empty() {
            let names: Vec<String> = block.column_types.keys().cloned().collect();
            buf.clear();
            fmt.write_header_to(&mut buf, &names)?;
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let Some(col_names) = cols.as_ref() else { continue };
        for row_idx in 0..block.rows as usize {
            let vals: Vec<Option<String>> = col_names.iter()
                .map(|col| block.column_data.get(col)
                    .and_then(|vals| vals.get(row_idx))
                    .and_then(crate::commands::clickhouse_tcp::value_to_string))
                .collect();
            buf.clear();
            if matches!(fmt, RowWriter::Sql { .. }) {
                let values = col_names.iter().map(|col| {
                    let value = block.column_data.get(col).and_then(|v| v.get(row_idx)).ok_or_else(|| format!("列 {col} 缺少数据"))?;
                    clickhouse_sql_value(value)
                }).collect::<Result<Vec<_>, String>>()?;
                write_sql_literals(fmt, &mut buf, col_names, &values)?;
            } else { fmt.write_row_to(&mut buf, col_names, &vals)?; }
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            rows += 1;
            if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            if rows % PROGRESS_INTERVAL == 0 {
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(event, ExportProgressEvt {
                    rows, elapsed_ms: ms,
                    rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                    file_bytes: 0, done: false, cancelled: false, error: None,
                });
            }
        }
    }
    Ok(rows)
}

async fn export_xlsx_clickhouse_tcp(
    config: &crate::models::ConnConfig,
    sql: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    let client = crate::commands::clickhouse_tcp::connect(config, crate::keychain::get_password(&config.id)?.as_deref()).await?;
    let mut stream = client.query_raw(sql).await
        .map_err(|e| format!("ClickHouse 查询失败: {e}"))?;
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;

    while let Some(block) = stream.next().await {
        let block = block.map_err(|e| format!("ClickHouse 读取数据块失败: {e}"))?;
        if cols.is_none() && !block.column_types.is_empty() {
            let names: Vec<String> = block.column_types.keys().cloned().collect();
            xw.write_header(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let Some(col_names) = cols.as_ref() else { continue };
        for row_idx in 0..block.rows as usize {
            let vals: Vec<Option<String>> = col_names.iter()
                .map(|col| block.column_data.get(col)
                    .and_then(|vals| vals.get(row_idx))
                    .and_then(crate::commands::clickhouse_tcp::value_to_string))
                .collect();
            xw.write_row(&vals)?;
            rows += 1;
            if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            if rows % PROGRESS_INTERVAL == 0 {
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(event, ExportProgressEvt {
                    rows, elapsed_ms: ms,
                    rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                    file_bytes: 0, done: false, cancelled: false, error: None,
                });
            }
        }
    }
    Ok(rows)
}

fn json_value_to_string(v: &serde_json::Value) -> Option<String> {
    if v.is_null() {
        None
    } else if let Some(s) = v.as_str() {
        Some(s.to_string())
    } else {
        Some(v.to_string())
    }
}

fn clickhouse_http_request(
    config: &crate::models::ConnConfig,
    sql: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let password = crate::keychain::get_password(&config.id)?;
    let mut req = crate::commands::clickhouse::client()?
        .post(crate::commands::clickhouse::base_url(config))
        .header("X-ClickHouse-User", config.username.as_deref().unwrap_or("default"));
    if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
        req = req.header("X-ClickHouse-Key", p);
    }
    if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
        req = req.query(&[("database", db)]);
    }
    Ok(req.body(sql.to_string()))
}

async fn export_clickhouse_http_rows(
    config: &crate::models::ConnConfig,
    sql: &str,
    mut on_item: impl FnMut(&[String], Option<&[Option<String>]>) -> Result<(), String>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    let base = sql.trim().trim_end_matches(';');
    let stream_sql = format!("SELECT * FROM ({base}) FORMAT JSONCompactEachRowWithNamesAndTypes");
    let resp = clickhouse_http_request(config, &stream_sql)?
        .send().await
        .map_err(|e| format!("ClickHouse 请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("ClickHouse 错误（HTTP {}）：{}", status.as_u16(), text.trim()));
    }

    let mut stream = resp.bytes_stream();
    let mut pending = Vec::<u8>::new();
    let mut line_no = 0u64;
    let mut rows = 0u64;
    let mut cols: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("ClickHouse 读取响应失败: {e}"))?;
        pending.extend_from_slice(&chunk);
        while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
            let line = pending.drain(..=pos).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            if line.is_empty() { continue; }
            line_no += 1;
            let arr: Vec<serde_json::Value> = serde_json::from_str(&line)
                .map_err(|e| format!("解析 ClickHouse 流式行失败: {e}"))?;
            if line_no == 1 {
                cols = arr.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect();
                on_item(&cols, None)?;
            } else if line_no == 2 {
                continue;
            } else {
                let vals: Vec<Option<String>> = arr.iter().map(json_value_to_string).collect();
                on_item(&cols, Some(&vals))?;
                rows += 1;
                if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                if rows % PROGRESS_INTERVAL == 0 {
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(event, ExportProgressEvt {
                        rows, elapsed_ms: ms,
                        rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                        file_bytes: 0, done: false, cancelled: false, error: None,
                    });
                }
            }
        }
    }
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending).trim().to_string();
        if !line.is_empty() {
            line_no += 1;
            let arr: Vec<serde_json::Value> = serde_json::from_str(&line)
                .map_err(|e| format!("解析 ClickHouse 流式行失败: {e}"))?;
            if line_no == 1 {
                cols = arr.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect();
                on_item(&cols, None)?;
            } else if line_no > 2 {
                let vals: Vec<Option<String>> = arr.iter().map(json_value_to_string).collect();
                on_item(&cols, Some(&vals))?;
                rows += 1;
            }
        }
    }
    Ok(rows)
}

async fn export_clickhouse_http(
    config: &crate::models::ConnConfig,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    if let RowWriter::Sql { table, .. } = fmt {
        if matches!(ew.encoding, Enc::Gbk) {
            return Err("ClickHouse 原生 SQL 导出仅支持 UTF-8，请更改编码".into());
        }
        // Let ClickHouse serialize its native values; JSON display strings lose
        // invalid UTF-8, large decimals, and nested type information.
        let base = sql.trim().trim_end_matches(';');
        let query = format!("SELECT * FROM ({base}) FORMAT SQLInsert");
        let response = clickhouse_http_request(config, &query)?
            .query(&[("output_format_sql_insert_table_name", *table),
                ("output_format_sql_insert_include_column_names", "1"),
                ("output_format_sql_insert_quote_names", "1"),
                ("output_format_sql_insert_max_batch_size", "1")])
            .send().await.map_err(|e| format!("ClickHouse SQL 导出失败: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("ClickHouse SQL 导出失败: {}", response.text().await.unwrap_or_default()));
        }
        let mut bytes = response.bytes_stream();
        let mut rows = 0;
        while let Some(chunk) = bytes.next().await {
            if cancel.load(Ordering::Relaxed) { return Err("已取消".into()); }
            let chunk = chunk.map_err(|e| format!("ClickHouse SQL 导出读取失败: {e}"))?;
            // SQLInsert emits one INSERT per line with batch size 1 below.
            rows += chunk.iter().filter(|b| **b == b'\n').count() as u64;
            ew.inner.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        }
        return Ok(rows);
    }
    let mut buf = String::with_capacity(16 * 1024);
    export_clickhouse_http_rows(
        config,
        sql,
        |cols, vals| {
            buf.clear();
            if let Some(vals) = vals {
                fmt.write_row_to(&mut buf, cols, vals)?;
            } else {
                fmt.write_header_to(&mut buf, cols)?;
            }
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))
        },
        cancel,
        app,
        event,
        start,
    ).await
}

async fn export_xlsx_clickhouse_http(
    config: &crate::models::ConnConfig,
    sql: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    export_clickhouse_http_rows(
        config,
        sql,
        |cols, vals| {
            if let Some(vals) = vals {
                xw.write_row(vals)
            } else {
                xw.write_header(&cols.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())
            }
        },
        cancel,
        app,
        event,
        start,
    ).await
}

async fn duckdb_copy_to_path(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    path: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    catalog: Option<String>,
) -> Result<u64, String> {
    validate_export_readonly_sql(config,sql)?;
    let lib_path = crate::commands::duckdb::get_duck_lib_path_pub(registry).await?;
    let conn = crate::commands::duckdb::get_or_open_pub(id, config, pool, &lib_path).await?;
    let path_esc = path.replace('\'', "''");
    let base = sql.trim().trim_end_matches(';');
    let copy_sql = format!("COPY ({base}) TO '{path_esc}' (FORMAT CSV, HEADER TRUE)");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        if let Some(catalog) = catalog {
            crate::commands::duckdb::select_catalog_on_connection(&guard, &catalog)?;
        }
        crate::commands::duckdb::run_query_sync_pub(&guard, &copy_sql, 0).map(|r| r.rows_affected)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

struct DuckDbTempCsv {
    directory: std::path::PathBuf,
    path: std::path::PathBuf,
}

impl DuckDbTempCsv {
    fn new() -> Result<Self, String> {
        for _ in 0..8 {
            let directory = std::env::temp_dir().join(format!("dbterm-duck-export-{}", uuid::Uuid::new_v4().simple()));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&directory) {
                Ok(()) => {
                    return Ok(Self { path: directory.join("result.csv"), directory });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("创建 DuckDB 临时目录失败: {e}")),
            }
        }
        Err("无法分配唯一 DuckDB 临时目录".into())
    }
}

impl Drop for DuckDbTempCsv {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.directory); }
}

async fn export_duckdb_via_temp_csv(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    catalog: Option<String>,
    _task_id: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    if matches!(fmt, RowWriter::Sql { .. }) {
        return Err("此驱动尚无无损 SQL 值编码器；请使用 CSV/JSON 导出或数据库原生备份工具".into());
    }

    let temp = DuckDbTempCsv::new()?;
    let tmp = temp.path.to_string_lossy().into_owned();
    duckdb_copy_to_path(id, config, sql, &tmp, pool, registry, catalog).await?;

    let file = std::fs::File::open(&tmp).map_err(|e| format!("读取 DuckDB 临时导出失败: {e}"))?;
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let headers = rdr.headers().map_err(|e| format!("读取 DuckDB CSV 表头失败: {e}"))?
        .iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut buf = String::with_capacity(16 * 1024);
    fmt.write_header_to(&mut buf, &headers)?;
    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;

    let mut rows = 0u64;
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("读取 DuckDB CSV 行失败: {e}"))?;
        let vals: Vec<Option<String>> = rec.iter().map(|s| {
            if s.is_empty() { None } else { Some(s.to_string()) }
        }).collect();
        buf.clear();
        fmt.write_row_to(&mut buf, &headers, &vals)?;
        ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
        rows += 1;
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    Ok(rows)
}

async fn export_xlsx_duckdb_via_temp_csv(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    catalog: Option<String>,
    _task_id: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    let temp = DuckDbTempCsv::new()?;
    let tmp = temp.path.to_string_lossy().into_owned();
    duckdb_copy_to_path(id, config, sql, &tmp, pool, registry, catalog).await?;

    let file = std::fs::File::open(&tmp).map_err(|e| format!("读取 DuckDB 临时导出失败: {e}"))?;
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let headers = rdr.headers().map_err(|e| format!("读取 DuckDB CSV 表头失败: {e}"))?
        .iter().map(|s| Some(s.to_string())).collect::<Vec<_>>();
    xw.write_header(&headers)?;

    let mut rows = 0u64;
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("读取 DuckDB CSV 行失败: {e}"))?;
        let vals: Vec<Option<String>> = rec.iter().map(|s| {
            if s.is_empty() { None } else { Some(s.to_string()) }
        }).collect();
        xw.write_row(&vals)?;
        rows += 1;
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if rows % PROGRESS_INTERVAL == 0 {
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes: 0, done: false, cancelled: false, error: None,
            });
        }
    }
    Ok(rows)
}

async fn export_oracle(
    config: crate::models::ConnConfig,
    sql: &str,
    registry: &DriverRegistry,
    schema: Option<String>,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(&config,sql)?;
    if matches!(fmt, RowWriter::Sql { .. }) {
        return Err("此驱动尚无无损 SQL 值编码器；请使用 CSV/JSON 导出或数据库原生备份工具".into());
    }

    let password = crate::keychain::get_password(&config.id)?;
    let mut buf = String::with_capacity(16 * 1024);
    let mut rows = 0u64;
    crate::commands::oracle::stream_query_rows_in_schema(
        config,
        sql.to_string(),
        password,
        registry,
        schema,
        |cols, vals| {
            buf.clear();
            if let Some(vals) = vals {
                fmt.write_row_to(&mut buf, cols, vals)?;
                ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                rows += 1;
                if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                if rows % PROGRESS_INTERVAL == 0 {
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(event, ExportProgressEvt {
                        rows, elapsed_ms: ms,
                        rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                        file_bytes: 0, done: false, cancelled: false, error: None,
                    });
                }
            } else {
                fmt.write_header_to(&mut buf, cols)?;
                ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            }
            Ok(())
        },
    ).await?;
    Ok(rows)
}

async fn export_xlsx_oracle(
    config: crate::models::ConnConfig,
    sql: &str,
    registry: &DriverRegistry,
    schema: Option<String>,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    validate_export_readonly_sql(&config,sql)?;
    let password = crate::keychain::get_password(&config.id)?;
    let mut rows = 0u64;
    crate::commands::oracle::stream_query_rows_in_schema(
        config,
        sql.to_string(),
        password,
        registry,
        schema,
        |cols, vals| {
            if let Some(vals) = vals {
                xw.write_row(vals)?;
                rows += 1;
                if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
                    return Err("已取消".into());
                }
                if rows % PROGRESS_INTERVAL == 0 {
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(event, ExportProgressEvt {
                        rows, elapsed_ms: ms,
                        rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                        file_bytes: 0, done: false, cancelled: false, error: None,
                    });
                }
            } else {
                xw.write_header(&cols.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            }
            Ok(())
        },
    ).await?;
    Ok(rows)
}

fn finish_text_export_result(
    result: Result<u64, String>, ew: &mut EncodedWriter, fmt: &mut RowWriter<'_>,
    _file_path: &str, _app: &tauri::AppHandle, _event: &str, _start: Instant,
) -> Result<u64, String> {
    let rows = result?;
    finalize_text_writer(ew, fmt)?;
    Ok(rows)
}

fn finalize_text_writer(ew: &mut EncodedWriter, fmt: &mut RowWriter<'_>) -> Result<(), String> {
    let mut tail = String::new();
    fmt.write_finish_to(&mut tail);
    if !tail.is_empty() { ew.write_str(&tail).map_err(|e| format!("写入导出结尾失败: {e}"))?; }
    ew.flush().map_err(|e| format!("导出文件刷新失败: {e}"))
}

fn finish_xlsx_export_result(
    result: Result<u64, String>, xw: XlsxWriter, _file_path: &str,
    _app: &tauri::AppHandle, _event: &str, _start: Instant,
) -> Result<u64, String> {
    let rows = result?;
    xw.finish()?;
    Ok(rows)
}

struct ExportCancelRegistration {
    map: ExportCancelMap,
    task_id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for ExportCancelRegistration {
    fn drop(&mut self) {
        let mut map = self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.get(&self.task_id).is_some_and(|flag| Arc::ptr_eq(flag, &self.flag)) { map.remove(&self.task_id); }
    }
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 执行 SQL 并将结果流式写入文件
///
/// - `format`  : "csv" | "tsv" | "jsonl" | "sql"
/// - `encoding`: "utf8" | "utf8bom" | "gbk"
/// - `insert_table`: format=sql 时的目标表名
/// - `task_id` : 用于区分进度事件和取消操作
/// - 进度事件名: `export_progress_{task_id}`
#[tauri::command]
pub async fn db_stream_export(
    id: String,
    sql: String,
    file_path: String,
    format: String,
    encoding: String,
    insert_table: String,
    task_id: String,
    database: Option<String>,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    cancel_map: State<'_, ExportCancelMap>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    super::db_extra::validate_path(&file_path)?;
    let config=storage.lock().map_err(|_| "读取导出连接失败")?.load()?
        .into_iter().find(|config|config.id == id).ok_or_else(||format!("连接不存在: {id}"))?;
    validate_export_readonly_sql(&config,&sql)?;
    let mut staged = StagedExport::new(&file_path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = cancel_map.lock().map_err(|_| "导出取消状态不可用")?;
        if map.contains_key(&task_id) { return Err("导出任务 ID 已在使用中".into()); }
        map.insert(task_id.clone(), Arc::clone(&cancel));
    }
    let _registration = ExportCancelRegistration { map: Arc::clone(&cancel_map), task_id: task_id.clone(), flag: Arc::clone(&cancel) };
    let event = format!("export_progress_{task_id}");
    let start = Instant::now();
    let result = db_stream_export_staged(id, sql, staged.path.clone(), format, encoding, insert_table, task_id, database, storage, ss_pool, duck_pool, registry, app.clone(), Arc::clone(&cancel)).await
        .and_then(|rows| {
            if cancel.load(Ordering::Relaxed) { return Err("已取消".into()); }
            staged.commit()?;
            Ok(rows)
        });
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let (rows, cancelled, error) = match &result {
        Ok(rows) => (*rows, false, None),
        Err(error) if error == "已取消" || error == "导出已取消" => (0, true, None),
        Err(error) => (0, false, Some(error.clone())),
    };
    let _ = app.emit(&event, ExportProgressEvt { rows, elapsed_ms,
        rows_per_sec: if elapsed_ms > 0 { rows * 1000 / elapsed_ms } else { 0 },
        file_bytes: if result.is_ok() { std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0) } else { 0 },
        done: true, cancelled, error,
    });
    result
}

async fn db_stream_export_staged(
    id: String,
    sql: String,
    file_path: String,
    format: String,
    encoding: String,
    insert_table: String,
    task_id: String,
    database: Option<String>,
    storage: State<'_, StorageState>,
    ss_pool: State<'_, SsPool>,
    duck_pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
    app: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    let config=storage.lock().map_err(|_| "读取导出连接失败")?.load()?
        .into_iter().find(|config|config.id == id).ok_or_else(||format!("连接不存在: {id}"))?;
    validate_export_readonly_sql(&config,&sql)?;
    if format == "parquet" {
        return Err("Parquet 仅支持 DuckDB 原生流式导出".to_string());
    }
    super::db_extra::validate_path(&file_path)?;
    let path = std::path::Path::new(&file_path);
    if let Some(dir) = path.parent() {
        if !dir.exists() { return Err(format!("目录不存在: {}", dir.display())); }
    }

    let event = format!("export_progress_{task_id}");
    let start = Instant::now();

    if format == "xlsx" {
        let file = match std::fs::File::create(&file_path) {
            Ok(f) => f,
            Err(e) => {
                return Err(format!("无法创建文件: {e}"));
            }
        };

        let mut xw = match XlsxWriter::new(file) {
            Ok(w) => w,
            Err(e) => {
                std::fs::remove_file(&file_path).ok();
                return Err(e);
            }
        };

        let conn_type = storage.lock().unwrap().load().ok()
            .and_then(|cfgs| cfgs.into_iter().find(|c| c.id == id).map(|c| c.conn_type));
        if matches!(conn_type, Some(ConnType::SqlServer)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            let _ = prepare_native_export_target(&mut cfg, database.as_deref())?;
            let result = export_xlsx_sqlserver(&id, &cfg, &sql, &ss_pool, &mut xw, &cancel, &app, &event, start).await;

            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::ClickHouse)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            let _ = prepare_native_export_target(&mut cfg, database.as_deref())?;
            let result = if crate::commands::clickhouse_tcp::use_tcp(&cfg) {
                export_xlsx_clickhouse_tcp(&cfg, &sql, &mut xw, &cancel, &app, &event, start).await
            } else {
                export_xlsx_clickhouse_http(&cfg, &sql, &mut xw, &cancel, &app, &event, start).await
            };

            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::Duckdb)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            let selected_target = prepare_native_export_target(&mut cfg, database.as_deref())?;
            let result = export_xlsx_duckdb_via_temp_csv(
                &id, &cfg, &sql, &duck_pool, &registry, selected_target, &task_id, &mut xw, &cancel, &app, &event, start
            ).await;

            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::Oracle)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            let selected_target = prepare_native_export_target(&mut cfg, database.as_deref())?;
            let result = export_xlsx_oracle(cfg, &sql, &registry, selected_target, &mut xw, &cancel, &app, &event, start).await;

            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }

        let mut conn = match open_conn(&id, &storage, database.as_deref(), &sql).await {
            Ok(c) => c,
            Err(e) => {
                std::fs::remove_file(&file_path).ok();
                return Err(e);
            }
        };

        let result = match &mut conn {
            DbConn::MySql(c, _t) => export_xlsx_mysql(c, &sql, &mut xw, &cancel, &app, &event, start).await,
            DbConn::Pg(c, _t)    => export_xlsx_pg(c, &sql, &mut xw, &cancel, &app, &event, start).await,
            DbConn::Sqlite(c)    => export_xlsx_sqlite(c, &sql, &mut xw, &cancel, &app, &event, start).await,
        };



        return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
    }

    // 建立文件（出错时不留残留）
    let file = match std::fs::File::create(&file_path) {
        Ok(f) => f,
        Err(e) => {
            return Err(format!("无法创建文件: {e}"));
        }
    };

    let enc = match encoding.as_str() {
        "gbk" => Enc::Gbk,
        _     => Enc::Utf8,
    };
    let mut ew = EncodedWriter { inner: BufWriter::with_capacity(1024 * 1024, file), encoding: enc };

    // UTF-8 BOM（utf8bom 编码模式）
    if encoding == "utf8bom" {
        if let Err(e) = ew.inner.write_all(b"\xEF\xBB\xBF") {

            std::fs::remove_file(&file_path).ok();
            return Err(format!("写入失败: {e}"));
        }
    }

    // SQL 格式需按源连接方言选择标识符引号；查不到连接时回退双引号（更通用）
    let (ident_quote, mysql_escape) = {
        let ct = storage.lock().unwrap().load().ok()
            .and_then(|cfgs| cfgs.into_iter().find(|c| c.id == id).map(|c| c.conn_type));
        match ct {
            Some(ct) => (
                IdentQuote::from_conn(&ct),
                matches!(ct, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase),
            ),
            None => (IdentQuote::Double, false),
        }
    };

    // 选择格式
    let mut fmt: RowWriter = match format.as_str() {
        "tsv"  => RowWriter::Csv { sep: b'\t' },
        "jsonl"=> RowWriter::Jsonl,
        "json" => RowWriter::Json { wrote_any: false },
        "md"   => RowWriter::Md,
        "sql"  => RowWriter::Sql { table: &insert_table, quote: ident_quote, mysql_escape },
        _      => RowWriter::Csv { sep: b',' },  // csv (default)
    };

    let conn_type = storage.lock().unwrap().load().ok()
        .and_then(|cfgs| cfgs.into_iter().find(|c| c.id == id).map(|c| c.conn_type));
    if matches!(conn_type, Some(ConnType::SqlServer)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        let _ = prepare_native_export_target(&mut cfg, database.as_deref())?;
        let result = export_sqlserver(&id, &cfg, &sql, &ss_pool, &mut ew, &mut fmt, &cancel, &app, &event, start).await;

        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::ClickHouse)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        let _ = prepare_native_export_target(&mut cfg, database.as_deref())?;
        let result = if crate::commands::clickhouse_tcp::use_tcp(&cfg) {
            export_clickhouse_tcp(&cfg, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await
        } else {
            export_clickhouse_http(&cfg, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await
        };

        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::Duckdb)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        let selected_target = prepare_native_export_target(&mut cfg, database.as_deref())?;
        let result = export_duckdb_via_temp_csv(
            &id, &cfg, &sql, &duck_pool, &registry, selected_target, &task_id, &mut ew, &mut fmt, &cancel, &app, &event, start
        ).await;

        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::Oracle)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        let selected_target = prepare_native_export_target(&mut cfg, database.as_deref())?;
        let result = export_oracle(cfg, &sql, &registry, selected_target, &mut ew, &mut fmt, &cancel, &app, &event, start).await;

        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }

    // 建立 DB 连接
    let mut conn = match open_conn(&id, &storage, database.as_deref(), &sql).await {
        Ok(c) => c,
        Err(e) => {
            std::fs::remove_file(&file_path).ok();
            return Err(e);
        }
    };

    // 流式导出
    let result = match &mut conn {
        DbConn::MySql(c, _t) => export_mysql(c, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await,
        DbConn::Pg(c, _t)    => export_pg(c, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await,
        DbConn::Sqlite(c)    => export_sqlite(c, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await,
    };



    finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start)
}

/// 取消正在进行的导出任务
#[tauri::command]
pub async fn db_cancel_export(
    task_id: String,
    cancel_map: State<'_, ExportCancelMap>,
) -> Result<(), String> {
    if let Some(flag) = cancel_map.lock().unwrap().get(&task_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 与实际导入共用CSV/TSV解码器，返回第一条逻辑记录（支持引号和换行）。
#[tauri::command]
pub async fn read_delimited_file_header(path: String, format: String) -> Result<Vec<String>, String> {
    super::db_extra::validate_path(&path)?;
    let file = std::fs::File::open(&path).map_err(|e| format!("无法读取文件: {e}"))?;
    super::import_records::header(std::io::BufReader::new(file), &format)
}

/// 读取文件第一行（供 ImportDialog CSV 字段映射预览用）
#[tauri::command]
pub async fn read_file_first_line(path: String) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    super::db_extra::validate_path(&path)?;
    let p = std::path::Path::new(&path);
    let file = std::fs::File::open(p).map_err(|e| format!("无法读取文件: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| format!("读取失败: {e}"))?;
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use std::io::{Read, Write};

    fn export_route_config(kind: &str) -> crate::models::ConnConfig {
        serde_json::from_value(serde_json::json!({
            "id":"export-routing-test","name":"test only","type":kind,
            "host":"db.internal","port":5433,"username":"saved-user",
            "database":"physical_db","filePath":"/tmp/original.sqlite",
            "useSsl":true,"readOnly":true,"createdAt":0,"updatedAt":0,
            "extraJson":serde_json::json!({"pgSearchPath":"saved","sslMode":"verify-full","sshHost":"jump.internal"}).to_string()
        })).unwrap()
    }

    #[tokio::test]
    async fn sqlite_export_readonly_blocks_temp_writes_on_actual_connection() {
        use sqlx::Connection;
        let temp=std::env::temp_dir().join(format!("dbterm-readonly-export-{}.db",uuid::Uuid::new_v4().simple()));
        std::fs::File::create(&temp).unwrap();
        let mut config=export_route_config("sqlite");
        config.file_path=Some(temp.to_string_lossy().into_owned());
        let mut evidence=Vec::new();
        for mode in ["global","sqliteReadonly","sqliteImmutable"] {
            config.read_only=Some(mode == "global");
            config.extra_json=Some(if mode == "global" { "{}".into() } else { serde_json::json!({mode:true}).to_string() });
            let mut connection=open_sqlite_export_connection(&config).await.unwrap();
            let query_only:i64=sqlx::query_scalar("PRAGMA query_only").fetch_one(&mut connection).await.unwrap();
            let write=sqlx::query("CREATE TEMP TABLE export_bypass(v TEXT)").execute(&mut connection).await;
            connection.close().await.unwrap();
            evidence.push((mode,query_only,write.is_err()));
        }
        std::fs::remove_file(&temp).unwrap();
        for (mode,query_only,write_failed) in evidence {
            assert_eq!(query_only,1,"{mode}: SQLite export must enforce query_only, not just file mode=ro");
            assert!(write_failed,"{mode}: read-only file mode still permits TEMP writes without query_only");
        }
    }

    #[test]
    fn export_readonly_sql_guard_rejects_mutation_batches_and_hidden_writes() {
        for kind in ["sqlite","mysql","postgres","sqlServer","clickHouse","duckdb","oracle"] {
            let mut config=export_route_config(kind);
            for sql in ["DELETE FROM t","SELECT 1; DELETE FROM t","WITH x AS (SELECT 1) DELETE FROM t","EXPLAIN ANALYZE DELETE FROM t","PRAGMA query_only=OFF","ATTACH DATABASE 'x' AS y","SELECT * INTO backup FROM t","SELECT 1 /*! INTO OUTFILE '/tmp/no' */"] {
                assert!(validate_export_readonly_sql(&config,sql).is_err(),"{kind}: {sql}");
            }
            for sql in ["SELECT id FROM t","SELECT 'text; -- literal' AS v;","WITH x AS (SELECT 1) SELECT * FROM x"] {
                assert!(validate_export_readonly_sql(&config,sql).is_ok(),"{kind}: {sql}");
            }
            config.read_only=Some(false);
            assert!(validate_export_readonly_sql(&config,"DELETE FROM t").is_ok());
        }
    }

    #[test]
    fn export_selected_target_preserves_pg_database_and_security_config() {
        for kind in ["postgres","kingBase","openGauss"] {
            let mut config = export_route_config(kind);
            let saved = config.clone();
            let target = prepare_export_target(&mut config, Some("a\"b;SELECT 1")).unwrap();
            assert_eq!(target.as_deref(), Some("\"a\"\"b;SELECT 1\""));
            assert_eq!(config.database, saved.database);
            assert_eq!(config.host, saved.host);
            assert_eq!(config.port, saved.port);
            assert_eq!(config.username, saved.username);
            assert_eq!(config.use_ssl, saved.use_ssl);
            assert_eq!(config.read_only, saved.read_only);
            let extra:serde_json::Value=serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
            assert_eq!(extra["sslMode"],"verify-full");
            assert_eq!(extra["sshHost"],"jump.internal");
            assert_eq!(extra["pgSearchPath"],"saved");
            let mut actual=serde_json::to_value(&config).unwrap();
            actual["extraJson"]=serde_json::to_value(saved.extra_json.clone()).unwrap();
            assert_eq!(actual,serde_json::to_value(&saved).unwrap());
        }
    }

    #[test]
    fn export_selected_target_routes_mysql_database_and_rejects_sqlite_attachments() {
        for kind in ["mysql","mariadb","tidb","oceanBase"] {
            let mut config=export_route_config(kind);
            assert_eq!(prepare_export_target(&mut config,Some("target_db")).unwrap(),None);
            assert_eq!(config.database.as_deref(),Some("target_db"));
        }
        let mut config=export_route_config("sqlite");
        let saved=serde_json::to_value(&config).unwrap();
        assert_eq!(prepare_export_target(&mut config,Some("main")).unwrap(),None);
        assert_eq!(serde_json::to_value(&config).unwrap(),saved);
        assert!(prepare_export_target(&mut config,Some("attached")).unwrap_err().contains("main"));
    }

    #[test]
    fn export_selected_target_none_keeps_saved_target_and_invalid_schema_refuses() {
        let mut config=export_route_config("postgres");
        let saved=serde_json::to_value(&config).unwrap();
        assert_eq!(prepare_export_target(&mut config,None).unwrap(),None);
        assert_eq!(serde_json::to_value(&config).unwrap(),saved);
        assert!(prepare_export_target(&mut config,Some("bad\nname")).is_err());
        prepare_export_target(&mut config,Some("selected_schema")).unwrap();
        assert_eq!(prepare_export_target(&mut config,None).unwrap(),None);
        let extra:serde_json::Value=serde_json::from_str(config.extra_json.as_deref().unwrap()).unwrap();
        assert!(extra.get("__dbtermSelectedQuerySchema").is_none());
        assert_eq!(config.database.as_deref(),Some("physical_db"));
    }

    #[test]
    fn native_export_target_preserves_oracle_service_and_duck_file_but_routes_physical_databases() {
        for kind in ["oracle","duckdb"] {
            let mut config=export_route_config(kind);
            let saved=config.clone();
            assert_eq!(prepare_native_export_target(&mut config,Some("selected_owner")).unwrap().as_deref(),Some("selected_owner"));
            assert_eq!(config.database,saved.database);
            assert_eq!(config.file_path,saved.file_path);
            assert_eq!(config.host,saved.host);
            assert_eq!(config.username,saved.username);
            assert_eq!(config.use_ssl,saved.use_ssl);
        }
        for kind in ["sqlServer","clickHouse"] {
            let mut config=export_route_config(kind);
            assert_eq!(prepare_native_export_target(&mut config,Some("selected_db")).unwrap(),None);
            assert_eq!(config.database.as_deref(),Some("selected_db"));
        }
    }

    #[test]
    fn duckdb_temp_csv_paths_are_unique_and_cleanup_on_drop() {
        let first = DuckDbTempCsv::new().unwrap();
        let second = DuckDbTempCsv::new().unwrap();
        assert_ne!(first.directory, second.directory);
        assert_ne!(first.path, second.path);
        assert_eq!(first.path.parent(), Some(first.directory.as_path()));
        assert!(!first.path.exists());
        std::fs::write(&first.path, b"sensitive export").unwrap();
        let directory = first.directory.clone();
        drop(first);
        assert!(!directory.exists());
        assert!(second.directory.exists());
    }

    #[test]
    fn duckdb_temp_csv_cleans_up_early_error_and_unwind() {
        let mut failed_directory = None;
        let result = (|| -> Result<(), String> {
            let temp = DuckDbTempCsv::new()?;
            failed_directory = Some(temp.directory.clone());
            std::fs::write(&temp.path, b"partial").unwrap();
            Err("simulated COPY error".into())
        })();
        assert!(result.is_err());
        assert!(!failed_directory.unwrap().exists());
        let mut panic_directory = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let temp = DuckDbTempCsv::new().unwrap();
            panic_directory = Some(temp.directory.clone());
            std::fs::write(&temp.path, b"partial").unwrap();
            panic!("simulated export panic");
        }));
        assert!(result.is_err());
        assert!(!panic_directory.unwrap().exists());
    }

    #[cfg(unix)]
    #[test]
    fn duckdb_temp_csv_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let temp = DuckDbTempCsv::new().unwrap();
        assert_eq!(std::fs::metadata(&temp.directory).unwrap().permissions().mode() & 0o777, 0o700);
    }

    fn unique_id(label: &str) -> String {
        format!("{label}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0))
    }

    #[tokio::test]
    async fn sqlite_sql_export_round_trips_storage_classes_and_bytes() {
        use sqlx::{Connection, Row};
        let mut conn = sqlx::sqlite::SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::query("CREATE TABLE src(id INTEGER, value)").execute(&mut conn).await.unwrap();
        sqlx::query("CREATE TABLE dst(id INTEGER, value)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO src VALUES (1,X'00ff415c27'),(2,'0xABCD'),(3,CAST(X'00615c27e4b8ad' AS TEXT)),(4,NULL),(5,9223372036854775807),(6,-9223372036854775808),(7,1.0),(8,1e-300),(9,-0.0),(10,X''),(11,'')")
            .execute(&mut conn).await.unwrap();
        let rows = sqlx::query("SELECT id,value FROM src ORDER BY id").fetch_all(&mut conn).await.unwrap();
        for row in &rows {
            let values = sqlite_sql_values(row).unwrap();
            sqlx::query(&format!("INSERT INTO dst(id,value) VALUES ({})", values.join(","))).execute(&mut conn).await.unwrap();
        }
        let signature = |table: &str| format!("SELECT id,typeof(value),hex(value),quote(value) FROM {table} ORDER BY id");
        let mut signatures = Vec::new();
        for table in ["src", "dst"] {
            let rows = sqlx::query(&signature(table)).fetch_all(&mut conn).await.unwrap();
            signatures.push(rows.iter().map(|row| (row.get::<i64,_>(0),row.get::<String,_>(1),row.get::<String,_>(2),row.get::<String,_>(3))).collect::<Vec<_>>());
        }
        let real_source: f64 = sqlx::query_scalar("SELECT value FROM src WHERE id=8").fetch_one(&mut conn).await.unwrap();
        let real_target: f64 = sqlx::query_scalar("SELECT value FROM dst WHERE id=8").fetch_one(&mut conn).await.unwrap();
        assert_eq!(real_source.to_bits(), real_target.to_bits());
        assert_eq!(signatures[0], signatures[1]);
        let infinity = sqlx::query("SELECT 1e999 AS infinity").fetch_one(&mut conn).await.unwrap();
        assert!(sqlite_sql_values(&infinity).is_err());
    }

    #[test]
    fn clickhouse_sql_literals_preserve_bytes_small_decimals_and_nested_values() {
        use klickhouse::Value as V;
        assert_eq!(clickhouse_sql_value(&V::String(vec![0, 255, 39, 92])).unwrap(), "unhex('00ff275c')");
        assert_eq!(clickhouse_sql_value(&V::String(Vec::new())).unwrap(), "unhex('')");
        assert_eq!(clickhouse_sql_value(&V::Decimal64(6, 123)).unwrap(), "toDecimal64('0.000123', 6)");
        assert_eq!(clickhouse_sql_value(&V::Decimal32(2, -5)).unwrap(), "toDecimal32('-0.05', 2)");
        assert_eq!(clickhouse_sql_value(&V::Decimal128(0, i128::MIN)).unwrap(), format!("toDecimal128('{}', 0)", i128::MIN));
        assert_eq!(clickhouse_sql_value(&V::UInt64(u64::MAX)).unwrap(), u64::MAX.to_string());
        let nested = V::Map(vec![V::String(b"a".to_vec())], vec![V::Tuple(vec![V::Null,V::Array(vec![V::String(b"0xABCD".to_vec())])])]);
        assert_eq!(clickhouse_sql_value(&nested).unwrap(), "map(unhex('61'), tuple(NULL, [unhex('307841424344')]))");
        assert!(scaled_decimal("1", 77).is_err());
    }

    #[test]
    fn sqlserver_unicode_literal_preserves_utf16_nul_quotes_and_astral_text() {
        assert_eq!(sqlserver_text_literal(""), "CONVERT(nvarchar(max),0x)");
        assert_eq!(sqlserver_text_literal("0xABCD"), "CONVERT(nvarchar(max),0x300078004100420043004400)");
        assert_eq!(sqlserver_text_literal("中\0'\\😀"), "CONVERT(nvarchar(max),0x2d4e000027005c003dd800de)");
    }

    #[test]
    fn export_workspaces_are_unique_and_preserve_existing_contents() {
        let task = unique_id("workspace-repeat");
        let first = db_create_export_workspace(task.clone()).unwrap();
        let marker = std::path::Path::new(&first).join("keep");
        std::fs::write(&marker, b"original").unwrap();
        let second = db_create_export_workspace(task).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&marker).unwrap(), b"original");
        db_cleanup_export_workspace(first).unwrap();
        db_cleanup_export_workspace(second).unwrap();
    }

    #[test]
    fn export_cleanup_rejects_nested_temp_directories() {
        let workspace = db_create_export_workspace(unique_id("nested-cleanup")).unwrap();
        let nested = std::path::Path::new(&workspace).join("dbterm-export-nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(db_cleanup_export_workspace(nested.to_string_lossy().into_owned()).is_err());
        assert!(nested.exists());
        db_cleanup_export_workspace(workspace).unwrap();
    }

    #[test]
    fn gbk_export_rejects_unmappable_characters_without_writing_replacements() {
        let destination = std::env::temp_dir().join(format!("{}.txt", unique_id("gbk")));
        let mut writer = EncodedWriter { inner: BufWriter::new(std::fs::File::create(&destination).unwrap()), encoding: Enc::Gbk };
        assert!(writer.write_str("中文😀").is_err());
        writer.flush().unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"");
        drop(writer);
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn staged_exports_preserve_existing_destination_on_failure_and_commit_on_success() {
        let destination = std::env::temp_dir().join(format!("{}.txt", unique_id("staging")));
        std::fs::write(&destination, b"original").unwrap();
        let abandoned;
        {
            let staged = StagedExport::new(destination.to_str().unwrap()).unwrap();
            abandoned = staged.path.clone();
            std::fs::write(&staged.path, b"partial").unwrap();
        }
        assert!(!std::path::Path::new(&abandoned).exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        let mut staged = StagedExport::new(destination.to_str().unwrap()).unwrap();
        std::fs::write(&staged.path, b"complete").unwrap();
        staged.commit().unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
        std::fs::remove_file(destination).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_export_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let destination = std::env::temp_dir().join(unique_id("export-permissions"));
        let staged = StagedExport::new(destination.to_str().unwrap()).unwrap();
        let mode = std::fs::metadata(&staged.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn final_text_tail_and_buffer_flush_errors_propagate() {
        let path = std::env::temp_dir().join(format!("{}.txt", unique_id("flush")));
        std::fs::write(&path, b"original").unwrap();
        // A read-only file produces a real write error without special devices.
        let mut tail_writer = EncodedWriter { inner: BufWriter::with_capacity(0, std::fs::File::open(&path).unwrap()), encoding: Enc::Utf8 };
        assert!(finalize_text_writer(&mut tail_writer, &mut RowWriter::Json { wrote_any: true }).unwrap_err().contains("结尾"));
        let mut flush_writer = EncodedWriter { inner: BufWriter::new(std::fs::File::open(&path).unwrap()), encoding: Enc::Utf8 };
        flush_writer.write_str("buffered").unwrap();
        assert!(finalize_text_writer(&mut flush_writer, &mut RowWriter::Csv { sep: b',' }).unwrap_err().contains("刷新"));
        drop(tail_writer); drop(flush_writer);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cancellation_registration_cleans_up_early_returns_without_removing_replacements() {
        let map: ExportCancelMap = Arc::new(Mutex::new(HashMap::new()));
        let flag = Arc::new(AtomicBool::new(false));
        map.lock().unwrap().insert("task".into(), Arc::clone(&flag));
        { let _registration = ExportCancelRegistration { map: Arc::clone(&map), task_id: "task".into(), flag: Arc::clone(&flag) }; }
        assert!(map.lock().unwrap().is_empty());
        let replacement = Arc::new(AtomicBool::new(false));
        map.lock().unwrap().insert("task".into(), Arc::clone(&replacement));
        { let _registration = ExportCancelRegistration { map: Arc::clone(&map), task_id: "task".into(), flag }; }
        assert!(Arc::ptr_eq(map.lock().unwrap().get("task").unwrap(), &replacement));
    }

    #[test]
    fn archive_failure_keeps_existing_output_and_removes_staging_file() {
        let directory = db_create_export_workspace(unique_id("archive-failure")).unwrap();
        let destination = std::path::Path::new(&directory).join("existing.zip");
        std::fs::write(&destination, b"original").unwrap();
        let result = db_pack_export_archive(destination.to_string_lossy().into_owned(), directory.clone(),
            vec![ArchiveEntry { name: "../escape.sql".into(), header: String::new(), source_path: None, binary: false }], Some(false));
        assert!(result.is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        db_cleanup_export_workspace(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn export_cleanup_rejects_symlink_workspace() {
        let workspace = db_create_export_workspace(unique_id("symlink-target")).unwrap();
        let link = std::env::temp_dir().join(format!("dbterm-export-{}", unique_id("symlink")));
        std::os::unix::fs::symlink(&workspace, &link).unwrap();
        assert!(db_cleanup_export_workspace(link.to_string_lossy().into_owned()).is_err());
        assert!(std::path::Path::new(&workspace).is_dir());
        std::fs::remove_file(link).unwrap();
        db_cleanup_export_workspace(workspace).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires DBTERM_EXPORT_TEST_URL pointing at disposable MySQL"]
    async fn mysql_sql_export_preserves_enum_and_set_internal_members() {
        use sqlx::{Connection,Column,Row};
        let url=std::env::var("DBTERM_EXPORT_TEST_URL").unwrap();
        let mut conn=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        sqlx::query("SET sql_mode=''").execute(&mut conn).await.unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbterm_members_src(id INT PRIMARY KEY, s SET('','a'), e ENUM('','x','1','2'))").execute(&mut conn).await.unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbterm_members_dst LIKE dbterm_members_src").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO dbterm_members_src VALUES(1,0,0),(2,1,1),(3,3,2),(4,NULL,NULL),(5,2,3),(6,3,4)").execute(&mut conn).await.unwrap();
        let raw=sqlx::query("SELECT s,e FROM dbterm_members_src WHERE id=2").fetch_one(&mut conn).await.unwrap();
        assert!(mysql_sql_values(&raw).is_err(), "ambiguous raw member text must fail rather than generate changed data");
        let projection=mysql_export_projection(&mut conn,"dbterm_members_src").await.unwrap();
        let rows=sqlx::query(&format!("SELECT {projection} FROM dbterm_members_src ORDER BY id")).fetch_all(&mut conn).await.unwrap();
        let columns=rows[0].columns().iter().map(|c|IdentQuote::Backtick.quote(c.name())).collect::<Vec<_>>().join(",");
        for row in rows {
            let values=mysql_sql_values(&row).unwrap();
            sqlx::query(&format!("INSERT INTO dbterm_members_dst ({columns}) VALUES({})",values.join(","))).execute(&mut conn).await.unwrap();
        }
        let mut signatures=Vec::new();
        for table in ["dbterm_members_src","dbterm_members_dst"] {
            let values:Vec<(i32,Option<u64>,Option<u64>)>=sqlx::query_as(&format!("SELECT id,CAST(s AS UNSIGNED),CAST(e AS UNSIGNED) FROM {table} ORDER BY id")).fetch_all(&mut conn).await.unwrap();
            signatures.push(values);
        }
        assert_eq!(signatures[0],signatures[1],"export must preserve selected empty SET/ENUM members and error zero");
    }

    #[tokio::test]
    #[ignore = "requires DBTERM_EXPORT_TEST_URL pointing at disposable MySQL"]
    async fn mysql_tabular_exports_never_silently_turn_decode_errors_into_null() {
        use sqlx::{Connection,Row};
        let url=std::env::var("DBTERM_EXPORT_TEST_URL").unwrap();
        let mut conn=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        sqlx::query("SET sql_mode=''").execute(&mut conn).await.unwrap();
        let row=sqlx::query("SELECT CAST('0000-00-00' AS DATE) AS bad_date, NULL AS genuine_null, X'4142' AS raw, '0x4142' AS text").fetch_one(&mut conn).await.unwrap();
        let kinds=mysql_export_cell_kinds(row.columns());
        assert!(mysql_export_cell_checked(&row,0,kinds[0]).is_err());
        assert!(mysql_export_values_checked(&row).is_err());
        assert_eq!(mysql_export_cell_checked(&row,1,kinds[1]).unwrap(),None);
        assert_eq!(mysql_export_cell_checked(&row,2,kinds[2]).unwrap().as_deref(),Some("0x4142"));
        assert_eq!(mysql_export_cell_checked(&row,3,kinds[3]).unwrap().as_deref(),Some("0x4142"));
        let spatial=sqlx::query("SELECT ST_GeomFromText('POINT(1 2)') AS geom").fetch_one(&mut conn).await.unwrap();
        let kinds=mysql_export_cell_kinds(spatial.columns());
        assert!(mysql_export_cell_checked(&spatial,0,kinds[0]).is_err());
        sqlx::query("CREATE TEMPORARY TABLE dbterm_tabular_year(y YEAR, b TINYINT(1))").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO dbterm_tabular_year VALUES(2026,-1)").execute(&mut conn).await.unwrap();
        let row=sqlx::query("SELECT * FROM dbterm_tabular_year").fetch_one(&mut conn).await.unwrap();
        let kinds=mysql_export_cell_kinds(row.columns());
        assert_eq!(mysql_export_cell_checked(&row,0,kinds[0]).unwrap().as_deref(),Some("2026"));
        assert_eq!(mysql_export_cell_checked(&row,1,kinds[1]).unwrap().as_deref(),Some("-1"));
    }

    #[test]
    fn json_export_duplicate_columns_must_not_silently_drop_first_value() {
        let mut writer=RowWriter::Jsonl;
        let mut out=String::new();
        let error=writer.write_row_to(&mut out,&["id".into(),"id".into()],&[Some("first".into()),Some("second".into())]).unwrap_err();
        assert!(error.contains("重复列名"));
        assert!(out.is_empty(),"invalid results must emit no partial row");
        writer.write_row_to(&mut out,&["source_id".into(),"target_id".into()],&[Some("first".into()),Some("second".into())]).unwrap();
        let object:serde_json::Value=serde_json::from_str(&out).unwrap();
        assert_eq!(object.as_object().unwrap().len(),2);
        assert_eq!(object["source_id"],"first");
        assert_eq!(object["target_id"],"second");
    }

    #[test]
    fn export_rejects_ambiguous_object_keys_but_preserves_positional_formats() {
        let columns=vec!["id".into(),"id".into()];
        for mut writer in [RowWriter::Jsonl,RowWriter::Json {wrote_any:false},RowWriter::Sql {table:"t",quote:IdentQuote::Double,mysql_escape:false}] {
            let mut out=String::new();
            assert!(writer.write_header_to(&mut out,&columns).is_err());
            assert!(out.is_empty());
        }
        let mut mysql=RowWriter::Sql {table:"t",quote:IdentQuote::Backtick,mysql_escape:true};
        assert!(mysql.write_header_to(&mut String::new(),&["id".into(),"ID".into()]).is_err());
        let mut csv=RowWriter::Csv {sep:b','};
        let mut out=String::new();
        csv.write_header_to(&mut out,&columns).unwrap();
        csv.write_row_to(&mut out,&columns,&[Some("first".into()),Some("second".into())]).unwrap();
        assert!(out.contains("first,second"));
        let original=out.clone();
        assert!(csv.write_row_to(&mut out,&columns,&[Some("only".into())]).is_err());
        assert_eq!(out,original);
    }

    #[tokio::test]
    async fn sqlite_duplicate_projection_fails_before_replacing_existing_json_export() {
        use sqlx::{Connection,Column,Row};
        let mut conn=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let row=sqlx::query("SELECT 'first' AS id,'second' AS id").fetch_one(&mut conn).await.unwrap();
        let columns=row.columns().iter().map(|c|c.name().to_string()).collect::<Vec<_>>();
        let destination=std::env::temp_dir().join(format!("{}.jsonl",unique_id("duplicate")));
        std::fs::write(&destination,"original").unwrap();
        {
            let staged=StagedExport::new(destination.to_str().unwrap()).unwrap();
            let mut writer=RowWriter::Jsonl;
            let mut out=String::new();
            let values=(0..row.len()).map(|i|row.try_get::<Option<String>,_>(i).unwrap()).collect::<Vec<_>>();
            assert!(writer.write_row_to(&mut out,&columns,&values).is_err());
            assert!(out.is_empty());
            drop(staged);
        }
        assert_eq!(std::fs::read_to_string(&destination).unwrap(),"original");
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn xlsx_numeric_cells_do_not_round_large_database_identifiers_or_decimals() {
        for value in ["18446744073709551615","9223372036854775807","123456789012345.12345678","1e-320","1e999","0.1234567890123456"] {
            assert!(!is_xlsx_number_literal(value),"{value} must be preserved as text");
        }
        for value in ["12345.67","-12","0","0.000000000000001","1.25e10"] {
            assert!(is_xlsx_number_literal(value),"ordinary numeric value {value} should remain numeric");
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable MySQL DBTERM_EXPORT_TEST_URL"]
    async fn mysql_xlsx_large_ids_and_decimals_are_text_with_exact_digits() {
        use sqlx::{Connection,Row};
        let url=std::env::var("DBTERM_EXPORT_TEST_URL").unwrap();
        let mut conn=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let row=sqlx::query("SELECT CAST(18446744073709551615 AS UNSIGNED) AS id,CAST(123456789012345.12345678 AS DECIMAL(23,8)) AS amount,CAST(123.5 AS DECIMAL(5,1)) AS ordinary").fetch_one(&mut conn).await.unwrap();
        let kinds=mysql_export_cell_kinds(row.columns());
        let cells=(0..kinds.len()).map(|i|mysql_xlsx_cell(&row,i,kinds[i])).collect::<Result<Vec<_>,_>>().unwrap();
        assert!(matches!(&cells[0],Some(XlsxCell::Text(v)) if v=="18446744073709551615"));
        assert!(matches!(&cells[1],Some(XlsxCell::Text(v)) if v=="123456789012345.12345678"));
        assert!(matches!(&cells[2],Some(XlsxCell::Number(v)) if v=="123.5"));
        let path=std::env::temp_dir().join(format!("{}.xlsx",unique_id("exact-ids")));
        let mut writer=XlsxWriter::new(std::fs::File::create(&path).unwrap()).unwrap();
        writer.write_header(&[Some("id".into()),Some("amount".into()),Some("ordinary".into())]).unwrap();
        writer.write_row_cells(&cells).unwrap();
        writer.finish().unwrap();
        let mut zip=zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut xml=String::new();
        use std::io::Read;
        zip.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(xml.contains("18446744073709551615</t>"));
        assert!(xml.contains("123456789012345.12345678</t>"));
        assert!(xml.contains("<v>123.5</v>"));
        drop(zip);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn xlsx_text_preserves_controls_and_literal_ooxml_escape_sequences() {
        let mut out=String::new();
        push_xml_text(&mut out,"a\0b\rc_x0041_\u{ffff}&");
        assert_eq!(out,"a_x0000_b_x000D_c_x005F_x0041__xFFFF_&amp;");
    }

    #[test]
    fn xlsx_rejects_column_overflow_and_row_shape_without_publishing_cells() {
        let path=std::env::temp_dir().join(format!("{}.xlsx",unique_id("shape")));
        let mut writer=XlsxWriter::new(std::fs::File::create(&path).unwrap()).unwrap();
        assert!(writer.write_header(&vec![None;16385]).is_err(),"Excel maximum is 16384 columns");
        writer.write_header(&[Some("one".into()),Some("two".into())]).unwrap();
        let before=writer.row;
        assert!(writer.write_row(&[Some("missing".into())]).is_err());
        assert_eq!(writer.row,before);
        drop(writer);
        std::fs::remove_file(path).unwrap();
    }

    /// Opt-in integration test. Only an explicitly supplied disposable database is used.
    #[tokio::test]
    #[ignore = "requires DBTERM_EXPORT_TEST_URL pointing at a disposable MySQL 8 database"]
    async fn mysql_sql_export_round_trips_typed_values() {
        use sqlx::{Connection, Row};
        let url = std::env::var("DBTERM_EXPORT_TEST_URL").expect("disposable MySQL URL required");
        let mut conn = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        sqlx::query("SET SQL_MODE='NO_BACKSLASH_ESCAPES,ANSI_QUOTES,NO_AUTO_VALUE_ON_ZERO'").execute(&mut conn).await.unwrap();
        sqlx::query("SET time_zone = '+08:00'").execute(&mut conn).await.unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbterm_export_src (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, txt TEXT, raw VARBINARY(20), empty_raw BLOB, bits BIT(64), num BIGINT UNSIGNED, deci DECIMAL(30,10), day DATE, stamp TIMESTAMP(6), duration TIME(6), hidden VARCHAR(20) INVISIBLE, derived INT GENERATED ALWAYS AS (LENGTH(txt)) VIRTUAL)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO dbterm_export_src (id,txt,raw,empty_raw,bits,num,deci,day,stamp,duration,hidden) VALUES (0,CONVERT(X'307841424344005c2722e4b8ad' USING utf8mb4),X'0041ff5c27',X'',18446744073709551615,18446744073709551615,12345678901234567890.1234567890,'2024-02-29','2024-02-29 12:13:14.123456','-838:59:59.123456','invisible'),(1,'',NULL,NULL,0,0,0,NULL,NULL,NULL,NULL)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbterm_export_dst LIKE dbterm_export_src").execute(&mut conn).await.unwrap();
        let header = mysql_export_session_header(&mut conn).await.unwrap();
        let projection = mysql_export_projection(&mut conn, "dbterm_export_src").await.unwrap();
        assert!(projection.contains("`hidden`"));
        assert!(!projection.contains("derived"));
        let rows = sqlx::query(&format!("SELECT {projection} FROM dbterm_export_src ORDER BY id")).fetch_all(&mut conn).await.unwrap();
        let values = rows.iter().map(mysql_sql_values).collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(values[0][2], "X'0041ff5c27'");
        assert_eq!(values[0][3], "X''");
        assert_eq!(values[0][4], "18446744073709551615");
        assert_eq!(values[1][2], "NULL");
        sqlx::query("SET SQL_MODE='STRICT_ALL_TABLES';").execute(&mut conn).await.unwrap();
        sqlx::query("SET time_zone = '-05:00'").execute(&mut conn).await.unwrap();
        sqlx::raw_sql(&header).execute(&mut conn).await.unwrap();
        for row in values {
            sqlx::query(&format!("INSERT INTO dbterm_export_dst ({projection}) VALUES ({})", row.join(", "))).execute(&mut conn).await.unwrap();
        }
        let signature = |table: &str| format!("SELECT CONCAT_WS('|',id,COALESCE(HEX(txt),'NULL'),COALESCE(HEX(raw),'NULL'),COALESCE(HEX(empty_raw),'NULL'),bits+0,num,deci,COALESCE(CAST(day AS CHAR),'NULL'),COALESCE(CAST(stamp AS CHAR),'NULL'),COALESCE(CAST(duration AS CHAR),'NULL'),COALESCE(HEX(hidden),'NULL'),derived) FROM {table} ORDER BY id");
        let source: Vec<String> = sqlx::query_scalar(&signature("dbterm_export_src")).fetch_all(&mut conn).await.unwrap();
        let target: Vec<String> = sqlx::query_scalar(&signature("dbterm_export_dst")).fetch_all(&mut conn).await.unwrap();
        assert_eq!(source, target);
        let zero = sqlx::query("SELECT CAST('0000-00-00' AS DATE) AS zero_date").fetch_one(&mut conn).await.unwrap();
        assert!(mysql_sql_values(&zero).is_err(), "zero date must never become NULL");
        let spatial = sqlx::query("SELECT ST_GeomFromText('POINT(1 2)') AS geometry").fetch_one(&mut conn).await.unwrap();
        assert!(mysql_sql_values(&spatial).is_err(), "unsupported types must never become NULL");
        sqlx::raw_sql(MYSQL_EXPORT_SESSION_FOOTER).execute(&mut conn).await.unwrap();
        let restored: String = sqlx::query_scalar("SELECT @@SESSION.time_zone").fetch_one(&mut conn).await.unwrap();
        assert_eq!(restored, "-05:00");
        assert_eq!(rows[0].columns().len(), 11);
        sqlx::query("CREATE TEMPORARY TABLE dbterm_export_year (y YEAR, signed_flag TINYINT(1), unsigned_flag TINYINT(1) UNSIGNED)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO dbterm_export_year VALUES (0,-1,255)").execute(&mut conn).await.unwrap();
        let year = sqlx::query("SELECT * FROM dbterm_export_year").fetch_one(&mut conn).await.unwrap();
        assert_eq!(mysql_sql_values(&year).unwrap(), vec!["0", "-1", "255"]);
    }

    #[test]
    fn packs_one_sql_file_per_table() {
        let id = unique_id("schema-archive");
        let workspace = db_create_export_workspace(id.clone()).unwrap();
        let source = std::path::Path::new(&workspace).join("users-data.sql");
        std::fs::write(&source, "INSERT INTO users (id) VALUES ('1');\n").unwrap();
        let output = std::env::temp_dir().join(format!("{id}.zip"));

        let bytes = db_pack_export_archive(
            output.to_string_lossy().into_owned(),
            workspace,
            vec![ArchiveEntry {
                name: "tables/users.sql".into(),
                header: "CREATE TABLE users (id INTEGER);".into(),
                source_path: Some(source.to_string_lossy().into_owned()),
                binary: false,
            }],
            Some(true),
        ).unwrap();
        assert!(bytes > 0);

        let file = std::fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 1);
        let mut sql = String::new();
        archive.by_name("tables/users.sql").unwrap().read_to_string(&mut sql).unwrap();
        assert!(sql.contains("CREATE TABLE users"));
        assert!(sql.contains("INSERT INTO users"));
        std::fs::remove_file(output).ok();
    }

    #[test]
    fn packs_schema_zips_inside_database_zip() {
        let id = unique_id("database-archive");
        let workspace = db_create_export_workspace(id.clone()).unwrap();
        let schema_zip = std::path::Path::new(&workspace).join("sales.zip");
        {
            let file = std::fs::File::create(&schema_zip).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("tables/orders.sql", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"CREATE TABLE orders (id INTEGER);").unwrap();
            zip.finish().unwrap();
        }
        let output = std::env::temp_dir().join(format!("{id}.zip"));
        db_pack_export_archive(
            output.to_string_lossy().into_owned(),
            workspace,
            vec![ArchiveEntry {
                name: "sales.zip".into(), header: String::new(),
                source_path: Some(schema_zip.to_string_lossy().into_owned()), binary: true,
            }],
            Some(true),
        ).unwrap();

        let outer_file = std::fs::File::open(&output).unwrap();
        let mut outer = zip::ZipArchive::new(outer_file).unwrap();
        let mut nested_bytes = Vec::new();
        outer.by_name("sales.zip").unwrap().read_to_end(&mut nested_bytes).unwrap();
        let mut inner = zip::ZipArchive::new(std::io::Cursor::new(nested_bytes)).unwrap();
        assert!(inner.by_name("tables/orders.sql").is_ok());
        std::fs::remove_file(output).ok();
    }

    #[test]
    fn rejects_archive_path_traversal() {
        assert!(safe_archive_name("../secret.sql").is_err());
        assert!(safe_archive_name("tables/../../secret.sql").is_err());
        assert!(safe_archive_name("tables/users.sql").is_ok());
    }

    #[test]
    fn stream_sql_writer_uses_dialect_quotes_and_escaping() {
        let cols = vec!["na]me".to_string(), "payload".to_string()];
        let vals = vec![Some("O'Reilly\\docs".to_string()), Some("0xABCD".to_string())];

        let mut standard = RowWriter::Sql {
            table: "users", quote: IdentQuote::Double, mysql_escape: false,
        };
        let mut pg_sql = String::new();
        standard.write_row_to(&mut pg_sql, &cols, &vals).unwrap();
        assert!(pg_sql.contains("INSERT INTO \"users\""));
        assert!(pg_sql.contains("'O''Reilly\\docs'"));
        assert!(pg_sql.contains("0xABCD"));

        let mut sqlserver = RowWriter::Sql {
            table: "users", quote: IdentQuote::Bracket, mysql_escape: false,
        };
        let mut ss_sql = String::new();
        sqlserver.write_row_to(&mut ss_sql, &cols, &vals).unwrap();
        assert!(ss_sql.contains("[na]]me]"));
        assert!(ss_sql.contains("'O''Reilly\\docs'"));

        let mut mysql = RowWriter::Sql {
            table: "users", quote: IdentQuote::Backtick, mysql_escape: true,
        };
        let mut mysql_sql = String::new();
        mysql.write_row_to(&mut mysql_sql, &cols, &vals).unwrap();
        assert!(mysql_sql.contains("'O\\'Reilly\\\\docs'"));
    }

    #[test]
    fn xlsx_writer_rolls_over_to_new_sheet_and_repeats_header() {
        let id = unique_id("xlsx-rollover");
        let output = std::env::temp_dir().join(format!("{id}.xlsx"));
        let file = std::fs::File::create(&output).unwrap();
        let mut writer = XlsxWriter::new_with_row_limit_for_test(file, 3).unwrap();
        let header = vec![Some("id".to_string()), Some("name".to_string())];

        writer.write_header(&header).unwrap();
        writer.write_row(&[Some("1".into()), Some("Alice".into())]).unwrap();
        writer.write_row(&[Some("2".into()), Some("Bob".into())]).unwrap();
        writer.write_row(&[Some("3".into()), Some("Carol".into())]).unwrap();
        writer.finish().unwrap();

        let file = std::fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut workbook = String::new();
        archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut workbook).unwrap();
        assert!(workbook.contains(r#"name="查询结果1""#));
        assert!(workbook.contains(r#"name="查询结果2""#));

        let mut rels = String::new();
        archive.by_name("xl/_rels/workbook.xml.rels").unwrap().read_to_string(&mut rels).unwrap();
        assert!(rels.contains("worksheets/sheet1.xml"));
        assert!(rels.contains("worksheets/sheet2.xml"));

        let mut sheet2 = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut sheet2).unwrap();
        assert!(sheet2.contains("<row r=\"1\""));
        assert!(sheet2.contains(">id<"));
        assert!(sheet2.contains(">3<"));
        assert!(sheet2.contains(">Carol<"));
        std::fs::remove_file(output).ok();
    }

    #[test]
    fn xlsx_writer_deflates_large_worksheet_xml_with_fast_level() {
        assert_eq!(xlsx_sheet_options().get_compression_level(), Some(1));
        let id = unique_id("xlsx-fast-deflate-sheet");
        let output = std::env::temp_dir().join(format!("{id}.xlsx"));
        let file = std::fs::File::create(&output).unwrap();
        let mut writer = XlsxWriter::new(file).unwrap();

        writer.write_header(&[Some("id".to_string())]).unwrap();
        writer.write_row(&[Some("1".to_string())]).unwrap();
        writer.finish().unwrap();

        let file = std::fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let sheet = archive.by_name("xl/worksheets/sheet1.xml").unwrap();
        assert_eq!(sheet.compression(), zip::CompressionMethod::Deflated);
        std::fs::remove_file(output).ok();
    }

    #[test]
    fn xlsx_writer_writes_number_cells_without_inline_string_markup() {
        let id = unique_id("xlsx-number-cell");
        let output = std::env::temp_dir().join(format!("{id}.xlsx"));
        let file = std::fs::File::create(&output).unwrap();
        let mut writer = XlsxWriter::new(file).unwrap();

        writer.write_header(&[Some("amount".to_string())]).unwrap();
        writer.write_row_cells(&[Some(XlsxCell::Number("12345.67".to_string()))]).unwrap();
        writer.finish().unwrap();

        let file = std::fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut sheet = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains(r#"<c r="A2"><v>12345.67</v></c>"#));
        assert!(!sheet.contains(r#"<c r="A2" t="inlineStr""#));
        std::fs::remove_file(output).ok();
    }

    #[test]
    fn test_safe_archive_name_valid_paths() {
        assert!(safe_archive_name("data.sql").is_ok());
        assert!(safe_archive_name("tables/users.sql").is_ok());
        assert!(safe_archive_name("schemas/public/tables/customers.sql").is_ok());
        assert!(safe_archive_name("exports/2024/backup.sql").is_ok());
    }

    #[test]
    fn test_safe_archive_name_absolute_paths() {
        assert!(safe_archive_name("/etc/passwd").is_err());
        assert!(safe_archive_name("/Users/test/file.sql").is_err());
        // Windows风格的绝对路径在非Windows系统上可能不被识别为绝对路径
        #[cfg(target_os = "windows")]
        assert!(safe_archive_name("C:\\Windows\\System32\\file.sql").is_err());
    }

    #[test]
    fn test_safe_archive_name_parent_traversal() {
        assert!(safe_archive_name("../passwords.sql").is_err());
        assert!(safe_archive_name("tables/../../secrets.sql").is_err());
        assert!(safe_archive_name("a/../b/../../../etc/passwd").is_err());
    }

    #[test]
    fn test_archive_entry_construction() {
        let entry = ArchiveEntry {
            name: "test.sql".to_string(),
            header: "CREATE TABLE test;".to_string(),
            source_path: Some("/tmp/test.sql".to_string()),
            binary: false,
        };

        assert_eq!(entry.name, "test.sql");
        assert_eq!(entry.header, "CREATE TABLE test;");
        assert_eq!(entry.source_path, Some("/tmp/test.sql".to_string()));
        assert!(!entry.binary);
    }

    #[test]
    fn test_archive_entry_binary() {
        let entry = ArchiveEntry {
            name: "image.jpg".to_string(),
            header: String::new(),
            source_path: Some("/tmp/image.jpg".to_string()),
            binary: true,
        };

        assert!(entry.binary);
        assert_eq!(entry.header, "");
    }

    #[test]
    fn test_ident_quote_double() {
        let quote = IdentQuote::Double;
        assert_eq!(quote.quote("tablename"), "\"tablename\"");
        assert_eq!(quote.quote("column"), "\"column\"");
        assert_eq!(quote.quote("test\"name"), "\"test\"\"name\""); // 双引号转义
    }

    #[test]
    fn test_ident_quote_backtick() {
        let quote = IdentQuote::Backtick;
        assert_eq!(quote.quote("tablename"), "`tablename`");
        assert_eq!(quote.quote("column"), "`column`");
        assert_eq!(quote.quote("test`name"), "`test``name`"); // 反引号转义
    }

    #[test]
    fn test_ident_quote_bracket() {
        let quote = IdentQuote::Bracket;
        assert_eq!(quote.quote("tablename"), "[tablename]");
        assert_eq!(quote.quote("column"), "[column]");
        assert_eq!(quote.quote("test]name"), "[test]]name]"); // 方括号转义
    }

    #[test]
    fn test_row_writer_csv_variant() {
        let csv_writer = RowWriter::Csv { sep: b',' };
        let tsv_writer = RowWriter::Csv { sep: b'\t' };

        match csv_writer {
            RowWriter::Csv { sep } => assert_eq!(sep, b','),
            _ => panic!("Expected CSV variant"),
        }

        match tsv_writer {
            RowWriter::Csv { sep } => assert_eq!(sep, b'\t'),
            _ => panic!("Expected CSV variant with tab separator"),
        }
    }

    #[test]
    fn test_row_writer_json_variant() {
        let json_writer = RowWriter::Json { wrote_any: false };

        match json_writer {
            RowWriter::Json { wrote_any } => assert!(!wrote_any),
            _ => panic!("Expected JSON variant"),
        }
    }

    #[test]
    fn test_row_writer_jsonl_variant() {
        let jsonl_writer = RowWriter::Jsonl;

        match jsonl_writer {
            RowWriter::Jsonl => {},
            _ => panic!("Expected JSONL variant"),
        }
    }

    #[test]
    fn test_row_writer_md_variant() {
        let md_writer = RowWriter::Md;

        match md_writer {
            RowWriter::Md => {},
            _ => panic!("Expected Md variant"),
        }
    }

    #[test]
    fn test_row_writer_sql_pg() {
        let pg_writer = RowWriter::Sql {
            table: "users",
            quote: IdentQuote::Double,
            mysql_escape: false,
        };

        match pg_writer {
            RowWriter::Sql { table, quote, mysql_escape } => {
                assert_eq!(table, "users");
                assert!(!mysql_escape);
                match quote {
                    IdentQuote::Double => {},
                    _ => panic!("Expected Double quote"),
                }
            }
            _ => panic!("Expected SQL variant"),
        }
    }

    #[test]
    fn test_row_writer_sql_mysql() {
        let mysql_writer = RowWriter::Sql {
            table: "products",
            quote: IdentQuote::Backtick,
            mysql_escape: true,
        };

        match mysql_writer {
            RowWriter::Sql { table, quote, mysql_escape } => {
                assert_eq!(table, "products");
                assert!(mysql_escape);
                match quote {
                    IdentQuote::Backtick => {},
                    _ => panic!("Expected Backtick quote"),
                }
            }
            _ => panic!("Expected SQL variant"),
        }
    }
}

/// 用系统文件管理器打开文件所在目录
#[tauri::command]
pub async fn reveal_in_folder(file_path: String) -> Result<(), String> {
    super::db_extra::validate_path(&file_path)?;
    let path = std::path::Path::new(&file_path);
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(dir).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(dir).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
