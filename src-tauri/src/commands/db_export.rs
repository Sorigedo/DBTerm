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
use tauri::{State, Emitter};
use crate::{models::ConnType, storage::StorageState};

pub type ExportCancelMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

const PROGRESS_INTERVAL: u64 = 2_000;   // 每 N 行发一次进度事件
const CANCEL_CHECK_INTERVAL: u64 = 500; // 每 N 行检查取消标志

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

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

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
    Double,   // PG/SQLite/DuckDB/SqlServer 等：\"x\"，内部 \" 翻倍
}

impl IdentQuote {
    fn from_conn(ct: &ConnType) -> Self {
        match ct {
            ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => Self::Backtick,
            _ => Self::Double, // Postgres/KingBase/OpenGauss/Sqlite/Duckdb/SqlServer 等统一双引号
        }
    }
    /// 转义并加引号；内部引号字符翻倍，防止标识符借引号逃逸（导出写入、回放触发注入）。
    fn quote(&self, s: &str) -> String {
        match self {
            Self::Backtick => format!("`{}`", s.replace('`', "``")),
            Self::Double   => format!("\"{}\"", s.replace('"', "\"\"")),
        }
    }
}

enum RowWriter<'a> {
    Csv { sep: u8 },                     // CSV or TSV
    Jsonl,
    Sql { table: &'a str, quote: IdentQuote },
}

impl<'a> RowWriter<'a> {
    fn write_header(&self, w: &mut impl Write, cols: &[String]) -> std::io::Result<()> {
        match self {
            Self::Csv { sep } => {
                let line = cols.iter().map(|c| if *sep == b',' { csv_escape(c) } else { c.replace('\t', " ") })
                    .collect::<Vec<_>>().join(&(*sep as char).to_string());
                writeln!(w, "{}", line)
            }
            Self::Sql { .. } | Self::Jsonl => Ok(()),
        }
    }

    fn write_row(&self, w: &mut impl Write, cols: &[String], vals: &[Option<String>]) -> std::io::Result<()> {
        match self {
            Self::Csv { sep } => {
                let line = vals.iter().map(|v| match v {
                    None    => String::new(),
                    Some(s) => if *sep == b',' { csv_escape(s) } else { s.replace('\t', " ").replace('\n', " ") },
                }).collect::<Vec<_>>().join(&(*sep as char).to_string());
                writeln!(w, "{}", line)
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
                w.write_all(line.as_bytes())
            }
            Self::Sql { table, quote } => {
                // 按方言加引号；内部引号翻倍，防止标识符借引号逃逸（导出写入、回放触发注入）
                let cols_s = cols.iter().map(|c| quote.quote(c)).collect::<Vec<_>>().join(", ");
                let vals_s = vals.iter().map(|v| match v {
                    None    => "NULL".to_string(),
                    Some(s) => format!("'{}'", sql_escape(s)),
                }).collect::<Vec<_>>().join(", ");
                writeln!(w, "INSERT INTO {} ({}) VALUES ({});", quote.quote(table), cols_s, vals_s)
            }
        }
    }
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

// RowWriter 需要一个 impl Write；当编码为 GBK 时不能直接用 BufWriter，
// 因为 GBK 需要整行转换。用 String buffer 中转。
struct StringBuf(String);
impl Write for StringBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.push_str(std::str::from_utf8(b).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

// ── 流式导出核心 ──────────────────────────────────────────────────────────────

async fn export_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
    ew: &mut EncodedWriter,
    fmt: &RowWriter<'_>,
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
            let mut buf = StringBuf(String::new());
            fmt.write_header(&mut buf, &names).map_err(|e| format!("写入失败: {e}"))?;
            ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::mysql_cell(&row, i)).collect();

        let mut buf = StringBuf(String::new());
        fmt.write_row(&mut buf, col_names, &vals).map_err(|e| format!("写入失败: {e}"))?;
        ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
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
    fmt: &RowWriter<'_>,
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
            let mut buf = StringBuf(String::new());
            fmt.write_header(&mut buf, &names).map_err(|e| format!("写入失败: {e}"))?;
            ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::pg_cell(&row, i)).collect();

        let mut buf = StringBuf(String::new());
        fmt.write_row(&mut buf, col_names, &vals).map_err(|e| format!("写入失败: {e}"))?;
        ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
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
    fmt: &RowWriter<'_>,
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
            let mut buf = StringBuf(String::new());
            fmt.write_header(&mut buf, &names).map_err(|e| format!("写入失败: {e}"))?;
            ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
            cols = Some(names);
        }
        let col_names = cols.as_ref().unwrap();
        let vals: Vec<Option<String>> = (0..col_names.len())
            .map(|i| crate::commands::query::sqlite_cell(&row, i)).collect();

        let mut buf = StringBuf(String::new());
        fmt.write_row(&mut buf, col_names, &vals).map_err(|e| format!("写入失败: {e}"))?;
        ew.write_str(&buf.0).map_err(|e| format!("写入失败: {e}"))?;
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
    cancel_map: State<'_, ExportCancelMap>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
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
    let mut ew = EncodedWriter { inner: BufWriter::new(file), encoding: enc };

    // UTF-8 BOM（utf8bom 编码模式）
    if encoding == "utf8bom" {
        if let Err(e) = ew.inner.write_all(b"\xEF\xBB\xBF") {
            cancel_map.lock().unwrap().remove(&task_id);
            std::fs::remove_file(&file_path).ok();
            return Err(format!("写入失败: {e}"));
        }
    }

    // SQL 格式需按源连接方言选择标识符引号；查不到连接时回退双引号（更通用）
    let ident_quote = {
        let ct = storage.lock().unwrap().load().ok()
            .and_then(|cfgs| cfgs.into_iter().find(|c| c.id == id).map(|c| c.conn_type));
        match ct {
            Some(ct) => IdentQuote::from_conn(&ct),
            None     => IdentQuote::Double,
        }
    };

    // 选择格式
    let fmt: RowWriter = match format.as_str() {
        "tsv"  => RowWriter::Csv { sep: b'\t' },
        "jsonl"=> RowWriter::Jsonl,
        "sql"  => RowWriter::Sql { table: &insert_table, quote: ident_quote },
        _      => RowWriter::Csv { sep: b',' },  // csv (default)
    };

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
        DbConn::MySql(c, _t) => export_mysql(c, &sql, &mut ew, &fmt, &cancel, &app, &event, start).await,
        DbConn::Pg(c, _t)    => export_pg(c, &sql, &mut ew, &fmt, &cancel, &app, &event, start).await,
        DbConn::Sqlite(c)    => export_sqlite(c, &sql, &mut ew, &fmt, &cancel, &app, &event, start).await,
    };

    cancel_map.lock().unwrap().remove(&task_id);

    match result {
        Ok(rows) => {
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

/// 用系统文件管理器打开文件所在目录
#[tauri::command]
pub async fn reveal_in_folder(file_path: String) -> Result<(), String> {
    super::db_extra::validate_path(&file_path)?;
    let path = std::path::Path::new(&file_path);
    let dir = path.parent().unwrap_or(path);
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(dir).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(dir).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
