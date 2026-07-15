// db_export.rs — SQL 执行并流式写文件
//
// 流程：execute SQL → row-by-row → 按格式编码 → BufWriter → 磁盘
// 内存占用：
//   PostgreSQL — sqlx 使用 server-side cursor，真正流式，O(1) 内存
//   MySQL      — MySQL 协议在客户端缓冲结果；Rust 侧仍逐行写盘，无额外拷贝
// 取消：每 CANCEL_CHECK_INTERVAL 行检查 AtomicBool；取消后自动删除残留文件
// 编码：UTF-8 / UTF-8 BOM / GBK（使用 encoding_rs）

use std::collections::HashMap;
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
    Ok(normalized)
}

#[tauri::command]
pub fn db_create_export_workspace(task_id: String) -> Result<String, String> {
    if task_id.is_empty() || !task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("导出任务 ID 无效".into());
    }
    let dir = std::env::temp_dir().join(format!("dbterm-export-{task_id}"));
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| format!("清理临时目录失败: {e}"))?; }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn db_cleanup_export_workspace(workspace: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(workspace);
    if !path.exists() { return Ok(()); }
    let canonical = path.canonicalize().map_err(|e| format!("读取临时目录失败: {e}"))?;
    let temp_root = std::env::temp_dir().canonicalize().map_err(|e| format!("读取系统临时目录失败: {e}"))?;
    if !canonical.starts_with(temp_root) || !canonical.file_name().and_then(|n| n.to_str()).unwrap_or("").starts_with("dbterm-export-") {
        return Err("拒绝清理非 DBTerm 导出临时目录".into());
    }
    std::fs::remove_dir_all(canonical).map_err(|e| format!("清理临时目录失败: {e}"))
}

#[tauri::command]
pub fn db_pack_export_archive(path: String, workspace: String, entries: Vec<ArchiveEntry>, cleanup: Option<bool>) -> Result<u64, String> {
    use std::io::{BufReader, BufWriter, Write};
    super::db_extra::validate_path(&path)?;
    let workspace_path = std::path::PathBuf::from(&workspace);
    let canonical_workspace = workspace_path.canonicalize().map_err(|e| format!("临时目录不存在: {e}"))?;
    let temp_root = std::env::temp_dir().canonicalize().map_err(|e| format!("读取系统临时目录失败: {e}"))?;
    if !canonical_workspace.starts_with(temp_root) { return Err("临时目录不在系统临时目录内".into()); }

    let result = (|| -> Result<u64, String> {
        let file = std::fs::File::create(&path).map_err(|e| format!("创建 ZIP 失败: {e}"))?;
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
        zip.finish().map_err(|e| format!("完成 ZIP 失败: {e}"))?;
        Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
    })();
    if cleanup.unwrap_or(true) { let _ = std::fs::remove_dir_all(&canonical_workspace); }
    if result.is_err() { let _ = std::fs::remove_file(&path); }
    result
}

const PROGRESS_INTERVAL: u64 = 1_000;   // 大表持续反馈进度，避免长时间看起来卡死
const CANCEL_CHECK_INTERVAL: u64 = 500; // 每 N 行检查取消标志
const XLSX_MAX_ROWS: u64 = 1_048_576;

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

async fn open_conn(id: &str, storage: &State<'_, StorageState>, database: Option<&str>) -> Result<DbConn, String> {
    let cfgs = storage.lock().unwrap().load()?;
    let mut config = cfgs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    // 查询页选中的 schema/库覆盖连接默认库（与 execute_query 一致），避免「No database selected」
    if let Some(db) = database.filter(|s| !s.is_empty()) {
        config.database = Some(db.to_string());
    }

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
            let (conn, tun) = crate::commands::query::pg_connect(&config, Some(pwd)).await?;
            Ok(DbConn::Pg(conn, tun))
        }
        ConnType::Sqlite => {
            use crate::commands::query::sqlite_url;
            use sqlx::{ConnectOptions, sqlite::SqliteConnectOptions};
            use std::str::FromStr;
            let url = sqlite_url(&config).map_err(|e| format!("SQLite URL: {e}"))?;
            let opts = SqliteConnectOptions::from_str(&url)
                .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
                .log_statements(log::LevelFilter::Off);
            let conn = opts.connect().await
                .map_err(|e| format!("SQLite 连接失败: {e}"))?;
            Ok(DbConn::Sqlite(conn))
        }
        _ => Err("暂不支持此连接类型的流式导出".into()),
    }
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
    fn write_header_to(&mut self, out: &mut String, cols: &[String]) {
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
    }

    fn write_row_to(&mut self, out: &mut String, cols: &[String], vals: &[Option<String>]) {
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
}

impl XlsxWriter {
    fn new(file: std::fs::File) -> Result<Self, String> {
        use zip::write::SimpleFileOptions;
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1024 * 1024, file));

        zip.start_file("[Content_Types].xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("_rels/.rels", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("xl/_rels/workbook.xml.rels", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("xl/workbook.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="查询结果" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#.as_bytes()).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("xl/styles.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("docProps/core.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>DBterm</dc:creator></cp:coreProperties>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("docProps/app.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DBterm</Application></Properties>"#).map_err(|e| format!("写入 XLSX 失败: {e}"))?;

        zip.start_file("xl/worksheets/sheet1.xml", options).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#)
            .map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        Ok(Self { zip, row: 0 })
    }

    fn write_row(&mut self, vals: &[Option<String>]) -> Result<(), String> {
        self.row += 1;
        if self.row > XLSX_MAX_ROWS {
            return Err(format!("Excel 单个工作表最多支持 {XLSX_MAX_ROWS} 行，请改用 CSV / TSV / JSON Lines"));
        }
        write!(self.zip, r#"<row r="{}">"#, self.row).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        for (idx, val) in vals.iter().enumerate() {
            if let Some(s) = val {
                let cell = xlsx_cell_ref(idx, self.row);
                write!(self.zip, r#"<c r="{cell}" t="inlineStr"><is><t xml:space="preserve">"#)
                    .map_err(|e| format!("写入 XLSX 失败: {e}"))?;
                write_xml_text(&mut self.zip, s).map_err(|e| format!("写入 XLSX 失败: {e}"))?;
                self.zip.write_all(b"</t></is></c>").map_err(|e| format!("写入 XLSX 失败: {e}"))?;
            }
        }
        self.zip.write_all(b"</row>").map_err(|e| format!("写入 XLSX 失败: {e}"))
    }

    fn finish(mut self) -> Result<(), String> {
        self.zip.write_all(b"</sheetData></worksheet>").map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        self.zip.finish().map_err(|e| format!("写入 XLSX 失败: {e}"))?;
        Ok(())
    }
}

fn xlsx_cell_ref(mut col: usize, row: u64) -> String {
    let mut letters = Vec::new();
    loop {
        let rem = col % 26;
        letters.push((b'A' + rem as u8) as char);
        col /= 26;
        if col == 0 { break; }
        col -= 1;
    }
    letters.iter().rev().collect::<String>() + &row.to_string()
}

fn write_xml_text(w: &mut impl Write, s: &str) -> std::io::Result<()> {
    for ch in s.chars() {
        match ch {
            '&' => w.write_all(b"&amp;")?,
            '<' => w.write_all(b"&lt;")?,
            '>' => w.write_all(b"&gt;")?,
            '"' => w.write_all(b"&quot;")?,
            '\'' => w.write_all(b"&apos;")?,
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' => w.write_all(b" ")?,
            _ => {
                let mut buf = [0u8; 4];
                w.write_all(ch.encode_utf8(&mut buf).as_bytes())?;
            }
        }
    }
    Ok(())
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
                let (encoded, _, _) = encoding_rs::GBK.encode(s);
                self.inner.write_all(&encoded)
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
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
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;
    let mut buf = String::with_capacity(8 * 1024);

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            buf.clear();
            fmt.write_header_to(&mut buf, &names);
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::mysql_cell(&row, i)).collect();

        buf.clear();
        fmt.write_row_to(&mut buf, col_names, &vals);
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
    let mut stream = sqlx::query(sql).fetch(&mut *conn);
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;
    let mut buf = String::with_capacity(8 * 1024);

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            buf.clear();
            fmt.write_header_to(&mut buf, &names);
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::pg_cell(&row, i)).collect();

        buf.clear();
        fmt.write_row_to(&mut buf, col_names, &vals);
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
    let mut buf = String::with_capacity(8 * 1024);

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            buf.clear();
            fmt.write_header_to(&mut buf, &names);
            ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::sqlite_cell(&row, i)).collect();

        buf.clear();
        fmt.write_row_to(&mut buf, col_names, &vals);
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
    let mut rows = 0u64;

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::mysql_cell(&row, i)).collect();
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
    let mut rows = 0u64;

    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_none() {
            let names: Vec<String> = row.columns().iter().map(|c| c.name().to_owned()).collect();
            xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::pg_cell(&row, i)).collect();
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
            xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
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
    let mut buf = String::with_capacity(8 * 1024);

    while let Some(item) = stream.try_next().await.map_err(|e| format!("SQL Server 读取失败: {e}"))? {
        match item {
            QueryItem::Metadata(meta) => {
                if cols.is_none() {
                    let names: Vec<String> = meta.columns().iter().map(|c| c.name().to_string()).collect();
                    buf.clear();
                    fmt.write_header_to(&mut buf, &names);
                    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                    cols = Some(names);
                }
            }
            QueryItem::Row(row) => {
                if cols.is_none() {
                    let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
                    buf.clear();
                    fmt.write_header_to(&mut buf, &names);
                    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
                    cols = Some(names);
                }
                let col_names = cols.as_ref().unwrap();
                let vals: Vec<Option<String>> = (0..col_names.len())
                    .map(|i| crate::commands::sqlserver::cell_to_string(&row, i)).collect();
                buf.clear();
                fmt.write_row_to(&mut buf, col_names, &vals);
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
                    xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
                    cols = Some(names);
                }
            }
            QueryItem::Row(row) => {
                if cols.is_none() {
                    let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
                    xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
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
            fmt.write_header_to(&mut buf, &names);
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
            fmt.write_row_to(&mut buf, col_names, &vals);
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
    let client = crate::commands::clickhouse_tcp::connect(config, crate::keychain::get_password(&config.id)?.as_deref()).await?;
    let mut stream = client.query_raw(sql).await
        .map_err(|e| format!("ClickHouse 查询失败: {e}"))?;
    let mut cols: Option<Vec<String>> = None;
    let mut rows = 0u64;

    while let Some(block) = stream.next().await {
        let block = block.map_err(|e| format!("ClickHouse 读取数据块失败: {e}"))?;
        if cols.is_none() && !block.column_types.is_empty() {
            let names: Vec<String> = block.column_types.keys().cloned().collect();
            xw.write_row(&names.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
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
    let mut buf = String::with_capacity(16 * 1024);
    export_clickhouse_http_rows(
        config,
        sql,
        |cols, vals| {
            buf.clear();
            if let Some(vals) = vals {
                fmt.write_row_to(&mut buf, cols, vals);
            } else {
                fmt.write_header_to(&mut buf, cols);
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
                xw.write_row(&cols.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())
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
) -> Result<u64, String> {
    let lib_path = crate::commands::duckdb::get_duck_lib_path_pub(registry).await?;
    let conn = crate::commands::duckdb::get_or_open_pub(id, config, pool, &lib_path).await?;
    let path_esc = path.replace('\'', "''");
    let base = sql.trim().trim_end_matches(';');
    let copy_sql = format!("COPY ({base}) TO '{path_esc}' (FORMAT CSV, HEADER TRUE)");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        crate::commands::duckdb::run_query_sync_pub(&guard, &copy_sql, 0).map(|r| r.rows_affected)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

fn duckdb_temp_csv_path(task_id: &str) -> String {
    let mut p = std::env::temp_dir();
    p.push(format!("dbterm_export_{task_id}.csv"));
    p.to_string_lossy().to_string()
}

async fn export_duckdb_via_temp_csv(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    task_id: &str,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    let tmp = duckdb_temp_csv_path(task_id);
    let _ = std::fs::remove_file(&tmp);
    duckdb_copy_to_path(id, config, sql, &tmp, pool, registry).await?;

    let file = std::fs::File::open(&tmp).map_err(|e| format!("读取 DuckDB 临时导出失败: {e}"))?;
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let headers = rdr.headers().map_err(|e| format!("读取 DuckDB CSV 表头失败: {e}"))?
        .iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut buf = String::with_capacity(16 * 1024);
    fmt.write_header_to(&mut buf, &headers);
    ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;

    let mut rows = 0u64;
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("读取 DuckDB CSV 行失败: {e}"))?;
        let vals: Vec<Option<String>> = rec.iter().map(|s| {
            if s.is_empty() { None } else { Some(s.to_string()) }
        }).collect();
        buf.clear();
        fmt.write_row_to(&mut buf, &headers, &vals);
        ew.write_str(&buf).map_err(|e| format!("写入失败: {e}"))?;
        rows += 1;
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tmp);
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
    let _ = std::fs::remove_file(&tmp);
    Ok(rows)
}

async fn export_xlsx_duckdb_via_temp_csv(
    id: &str,
    config: &crate::models::ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    task_id: &str,
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    let tmp = duckdb_temp_csv_path(task_id);
    let _ = std::fs::remove_file(&tmp);
    duckdb_copy_to_path(id, config, sql, &tmp, pool, registry).await?;

    let file = std::fs::File::open(&tmp).map_err(|e| format!("读取 DuckDB 临时导出失败: {e}"))?;
    let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let headers = rdr.headers().map_err(|e| format!("读取 DuckDB CSV 表头失败: {e}"))?
        .iter().map(|s| Some(s.to_string())).collect::<Vec<_>>();
    xw.write_row(&headers)?;

    let mut rows = 0u64;
    for rec in rdr.records() {
        let rec = rec.map_err(|e| format!("读取 DuckDB CSV 行失败: {e}"))?;
        let vals: Vec<Option<String>> = rec.iter().map(|s| {
            if s.is_empty() { None } else { Some(s.to_string()) }
        }).collect();
        xw.write_row(&vals)?;
        rows += 1;
        if rows % CANCEL_CHECK_INTERVAL == 0 && cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tmp);
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
    let _ = std::fs::remove_file(&tmp);
    Ok(rows)
}

async fn export_oracle(
    config: crate::models::ConnConfig,
    sql: &str,
    registry: &DriverRegistry,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    let password = crate::keychain::get_password(&config.id)?;
    let mut buf = String::with_capacity(16 * 1024);
    let mut rows = 0u64;
    crate::commands::oracle::stream_query_rows(
        config,
        sql.to_string(),
        password,
        registry,
        |cols, vals| {
            buf.clear();
            if let Some(vals) = vals {
                fmt.write_row_to(&mut buf, cols, vals);
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
                fmt.write_header_to(&mut buf, cols);
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
    xw: &mut XlsxWriter,
    cancel: &Arc<AtomicBool>,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    let password = crate::keychain::get_password(&config.id)?;
    let mut rows = 0u64;
    crate::commands::oracle::stream_query_rows(
        config,
        sql.to_string(),
        password,
        registry,
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
                xw.write_row(&cols.iter().map(|s| Some(s.clone())).collect::<Vec<_>>())?;
            }
            Ok(())
        },
    ).await?;
    Ok(rows)
}

fn finish_text_export_result(
    result: Result<u64, String>,
    ew: &mut EncodedWriter,
    fmt: &mut RowWriter<'_>,
    file_path: &str,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    match result {
        Ok(rows) => {
            let mut tail = String::new();
            fmt.write_finish_to(&mut tail);
            if !tail.is_empty() {
                let _ = ew.write_str(&tail);
            }
            let _ = ew.flush();
            let file_bytes = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes, done: true, cancelled: false, error: None,
            });
            Ok(rows)
        }
        Err(e) if e == "已取消" => {
            std::fs::remove_file(file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: true, error: None,
            });
            Err(e)
        }
        Err(e) => {
            std::fs::remove_file(file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
            });
            Err(e)
        }
    }
}

fn finish_xlsx_export_result(
    result: Result<u64, String>,
    xw: XlsxWriter,
    file_path: &str,
    app: &tauri::AppHandle,
    event: &str,
    start: Instant,
) -> Result<u64, String> {
    match result {
        Ok(rows) => {
            if let Err(e) = xw.finish() {
                std::fs::remove_file(file_path).ok();
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(event, ExportProgressEvt {
                    rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                    file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
                });
                return Err(e);
            }
            let file_bytes = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes, done: true, cancelled: false, error: None,
            });
            Ok(rows)
        }
        Err(e) if e == "已取消" => {
            drop(xw);
            std::fs::remove_file(file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: true, error: None,
            });
            Err(e)
        }
        Err(e) => {
            drop(xw);
            std::fs::remove_file(file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
            });
            Err(e)
        }
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
    if format == "parquet" {
        return Err("Parquet 仅支持 DuckDB 原生流式导出".to_string());
    }
    super::db_extra::validate_path(&file_path)?;
    let path = std::path::Path::new(&file_path);
    if let Some(dir) = path.parent() {
        if !dir.exists() { return Err(format!("目录不存在: {}", dir.display())); }
    }

    // 注册取消标志（提前注册，确保 cancel_export 在 export 开始前也能设置）
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_map.lock().unwrap().insert(task_id.clone(), cancel.clone());

    let event = format!("export_progress_{task_id}");
    let start = Instant::now();

    if format == "xlsx" {
        let file = match std::fs::File::create(&file_path) {
            Ok(f) => f,
            Err(e) => {
                cancel_map.lock().unwrap().remove(&task_id);
                return Err(format!("无法创建文件: {e}"));
            }
        };

        let mut xw = match XlsxWriter::new(file) {
            Ok(w) => w,
            Err(e) => {
                cancel_map.lock().unwrap().remove(&task_id);
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
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                cfg.database = Some(db.to_string());
            }
            let result = export_xlsx_sqlserver(&id, &cfg, &sql, &ss_pool, &mut xw, &cancel, &app, &event, start).await;
            cancel_map.lock().unwrap().remove(&task_id);
            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::ClickHouse)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                cfg.database = Some(db.to_string());
            }
            let result = if crate::commands::clickhouse_tcp::use_tcp(&cfg) {
                export_xlsx_clickhouse_tcp(&cfg, &sql, &mut xw, &cancel, &app, &event, start).await
            } else {
                export_xlsx_clickhouse_http(&cfg, &sql, &mut xw, &cancel, &app, &event, start).await
            };
            cancel_map.lock().unwrap().remove(&task_id);
            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::Duckdb)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                cfg.database = Some(db.to_string());
            }
            let result = export_xlsx_duckdb_via_temp_csv(
                &id, &cfg, &sql, &duck_pool, &registry, &task_id, &mut xw, &cancel, &app, &event, start
            ).await;
            cancel_map.lock().unwrap().remove(&task_id);
            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }
        if matches!(conn_type, Some(ConnType::Oracle)) {
            let mut cfg = storage.lock().unwrap().load()?
                .into_iter().find(|c| c.id == id)
                .ok_or_else(|| format!("连接不存在: {id}"))?;
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                cfg.database = Some(db.to_string());
            }
            let result = export_xlsx_oracle(cfg, &sql, &registry, &mut xw, &cancel, &app, &event, start).await;
            cancel_map.lock().unwrap().remove(&task_id);
            return finish_xlsx_export_result(result, xw, &file_path, &app, &event, start);
        }

        let mut conn = match open_conn(&id, &storage, database.as_deref()).await {
            Ok(c) => c,
            Err(e) => {
                cancel_map.lock().unwrap().remove(&task_id);
                std::fs::remove_file(&file_path).ok();
                return Err(e);
            }
        };

        let result = match &mut conn {
            DbConn::MySql(c, _t) => export_xlsx_mysql(c, &sql, &mut xw, &cancel, &app, &event, start).await,
            DbConn::Pg(c, _t)    => export_xlsx_pg(c, &sql, &mut xw, &cancel, &app, &event, start).await,
            DbConn::Sqlite(c)    => export_xlsx_sqlite(c, &sql, &mut xw, &cancel, &app, &event, start).await,
        };

        cancel_map.lock().unwrap().remove(&task_id);

        match result {
            Ok(rows) => {
                if let Err(e) = xw.finish() {
                    std::fs::remove_file(&file_path).ok();
                    let ms = start.elapsed().as_millis() as u64;
                    let _ = app.emit(&event, ExportProgressEvt {
                        rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                        file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
                    });
                    return Err(e);
                }
                let file_bytes = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(&event, ExportProgressEvt {
                    rows, elapsed_ms: ms,
                    rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                    file_bytes, done: true, cancelled: false, error: None,
                });
                return Ok(rows);
            }
            Err(e) if e == "已取消" => {
                drop(xw);
                std::fs::remove_file(&file_path).ok();
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(&event, ExportProgressEvt {
                    rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                    file_bytes: 0, done: true, cancelled: true, error: None,
                });
                return Err(e);
            }
            Err(e) => {
                drop(xw);
                std::fs::remove_file(&file_path).ok();
                let ms = start.elapsed().as_millis() as u64;
                let _ = app.emit(&event, ExportProgressEvt {
                    rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                    file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
                });
                return Err(e);
            }
        }
    }

    // 建立文件（出错时不留残留）
    let file = match std::fs::File::create(&file_path) {
        Ok(f) => f,
        Err(e) => {
            cancel_map.lock().unwrap().remove(&task_id);
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
            cancel_map.lock().unwrap().remove(&task_id);
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
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            cfg.database = Some(db.to_string());
        }
        let result = export_sqlserver(&id, &cfg, &sql, &ss_pool, &mut ew, &mut fmt, &cancel, &app, &event, start).await;
        cancel_map.lock().unwrap().remove(&task_id);
        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::ClickHouse)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            cfg.database = Some(db.to_string());
        }
        let result = if crate::commands::clickhouse_tcp::use_tcp(&cfg) {
            export_clickhouse_tcp(&cfg, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await
        } else {
            export_clickhouse_http(&cfg, &sql, &mut ew, &mut fmt, &cancel, &app, &event, start).await
        };
        cancel_map.lock().unwrap().remove(&task_id);
        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::Duckdb)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            cfg.database = Some(db.to_string());
        }
        let result = export_duckdb_via_temp_csv(
            &id, &cfg, &sql, &duck_pool, &registry, &task_id, &mut ew, &mut fmt, &cancel, &app, &event, start
        ).await;
        cancel_map.lock().unwrap().remove(&task_id);
        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }
    if matches!(conn_type, Some(ConnType::Oracle)) {
        let mut cfg = storage.lock().unwrap().load()?
            .into_iter().find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在: {id}"))?;
        if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
            cfg.database = Some(db.to_string());
        }
        let result = export_oracle(cfg, &sql, &registry, &mut ew, &mut fmt, &cancel, &app, &event, start).await;
        cancel_map.lock().unwrap().remove(&task_id);
        return finish_text_export_result(result, &mut ew, &mut fmt, &file_path, &app, &event, start);
    }

    // 建立 DB 连接
    let mut conn = match open_conn(&id, &storage, database.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            cancel_map.lock().unwrap().remove(&task_id);
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

    cancel_map.lock().unwrap().remove(&task_id);

    match result {
        Ok(rows) => {
            let mut tail = String::new();
            fmt.write_finish_to(&mut tail);
            if !tail.is_empty() {
                let _ = ew.write_str(&tail);
            }
            let _ = ew.flush();
            let file_bytes = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(&event, ExportProgressEvt {
                rows, elapsed_ms: ms,
                rows_per_sec: if ms > 0 { rows * 1000 / ms } else { 0 },
                file_bytes, done: true, cancelled: false, error: None,
            });
            Ok(rows)
        }
        Err(e) if e == "已取消" => {
            std::fs::remove_file(&file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(&event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: true, error: None,
            });
            Err(e)
        }
        Err(e) => {
            std::fs::remove_file(&file_path).ok();
            let ms = start.elapsed().as_millis() as u64;
            let _ = app.emit(&event, ExportProgressEvt {
                rows: 0, elapsed_ms: ms, rows_per_sec: 0,
                file_bytes: 0, done: true, cancelled: false, error: Some(e.clone()),
            });
            Err(e)
        }
    }
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

    fn unique_id(label: &str) -> String {
        format!("{label}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0))
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
        standard.write_row_to(&mut pg_sql, &cols, &vals);
        assert!(pg_sql.contains("INSERT INTO \"users\""));
        assert!(pg_sql.contains("'O''Reilly\\docs'"));
        assert!(pg_sql.contains("0xABCD"));

        let mut sqlserver = RowWriter::Sql {
            table: "users", quote: IdentQuote::Bracket, mysql_escape: false,
        };
        let mut ss_sql = String::new();
        sqlserver.write_row_to(&mut ss_sql, &cols, &vals);
        assert!(ss_sql.contains("[na]]me]"));
        assert!(ss_sql.contains("'O''Reilly\\docs'"));

        let mut mysql = RowWriter::Sql {
            table: "users", quote: IdentQuote::Backtick, mysql_escape: true,
        };
        let mut mysql_sql = String::new();
        mysql.write_row_to(&mut mysql_sql, &cols, &vals);
        assert!(mysql_sql.contains("'O\\'Reilly\\\\docs'"));
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
