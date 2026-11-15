// SQLite 管理命令（S0.3 ATTACH/DETACH + S0.4 连接信息 + S2 维护诊断面板）
// 与 query.rs 通用 SQL 链路严格隔离：专属管理类 PRAGMA 命令在此文件
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use crate::storage::StorageState;
use crate::models::ConnConfig;

// S0.3 ATTACH 状态：conn_id → Vec<(alias, file_path)>
pub type SqliteAttachMap = Arc<std::sync::Mutex<HashMap<String, Vec<(String, String)>>>>;

// S0 文件监控状态：conn_id → notify watcher（drop 即停止监控）
pub type SqliteWatcherMap = Arc<std::sync::Mutex<HashMap<String, notify::RecommendedWatcher>>>;

// ── 连接打开辅助（复用 query.rs 的 sqlite_open 逻辑） ────────────────────────
// 为避免跨模块调用，此处内联轻量版本（只需 PRAGMA 命令，无需 busy_timeout/FK 等）
fn sqlite_admin_readonly(config: &ConnConfig) -> bool {
    let extra = config.extra_json.as_deref().and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).unwrap_or_default();
    config.read_only == Some(true) || ["sqliteReadonly", "sqliteImmutable"].iter().any(|key| extra.get(*key).and_then(|v| v.as_bool()) == Some(true))
}

fn require_admin_write(config: &ConnConfig) -> Result<(), String> {
    if sqlite_admin_readonly(config) { return Err("只读连接不允许修改数据库或恢复备份".into()); }
    Ok(())
}

struct NewSqliteOutput {
    staged: super::db_export::StagedExport,
    destination: std::path::PathBuf,
}

impl NewSqliteOutput {
    fn new(path: &str, source: &str) -> Result<Self, String> {
        super::db_extra::validate_path(path)?;
        let destination = std::path::PathBuf::from(path);
        let parent = destination.parent().ok_or("输出目录不存在")?.canonicalize().map_err(|e| e.to_string())?;
        let target = parent.join(destination.file_name().ok_or("输出文件名无效")?);
        let source = std::path::Path::new(source).canonicalize().map_err(|e| e.to_string())?;
        if ["", "-wal", "-shm", "-journal"].iter().any(|suffix| target == std::path::PathBuf::from(format!("{}{suffix}", source.display()))) {
            return Err("输出路径不能是源数据库或其日志文件".into());
        }
        if std::fs::symlink_metadata(&destination).is_ok() { return Err("输出文件已存在，请选择新文件，原文件未修改".into()); }
        Ok(Self { staged: super::db_export::StagedExport::new(path)?, destination })
    }

    fn publish(&self) -> Result<(), String> {
        std::fs::OpenOptions::new().write(true).open(&self.staged.path).and_then(|file| file.sync_all()).map_err(|e| format!("输出落盘失败: {e}"))?;
        // Atomic no-replace publication, even if another process creates the
        // destination after preflight. The staging guard removes its link.
        std::fs::hard_link(&self.staged.path, &self.destination).map_err(|e| format!("发布新输出文件失败，已有文件未修改: {e}"))
    }
}

async fn vacuum_into_new_file(config: &ConnConfig, path: &str) -> Result<(), String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;
    let source = config.file_path.as_deref().ok_or("SQLite 文件路径不能为空")?;
    let output = NewSqliteOutput::new(path, source)?;
    // File-mode readonly protects the source while permitting VACUUM INTO's
    // separate output DB; query_only would also reject this legitimate backup.
    let mut conn = SqliteConnectOptions::from_str(&super::query::sqlite_url(config)?).map_err(|e| e.to_string())?
        .read_only(true).busy_timeout(std::time::Duration::from_secs(30)).log_statements(log::LevelFilter::Off)
        .connect().await.map_err(|e| e.to_string())?;
    sqlx::query("VACUUM INTO ?").bind(&output.staged.path).execute(&mut conn).await.map_err(|e| format!("备份失败: {e}"))?;
    output.publish()
}

async fn admin_conn(config: &ConnConfig) -> Result<sqlx::sqlite::SqliteConnection, String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;
    let url = super::query::sqlite_url(config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .read_only(sqlite_admin_readonly(config))
        .busy_timeout(std::time::Duration::from_secs(5))
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("SQLite 打开失败: {e}"))?;
    if sqlite_admin_readonly(config) {
        sqlx::query("PRAGMA query_only=ON").execute(&mut conn).await.map_err(|e| format!("设置只读模式失败: {e}"))?;
    }
    Ok(conn)
}

fn load_config(storage: &StorageState, conn_id: &str) -> Result<ConnConfig, String> {
    let guard = storage.lock().map_err(|e| format!("存储锁失败: {e}"))?;
    let all = guard.load()?;
    all.into_iter().find(|c| c.id == conn_id)
        .ok_or_else(|| format!("找不到连接 {conn_id}"))
}

// ─── S0.4 连接信息 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteConnInfo {
    pub sqlite_version: String,
    pub journal_mode: String,
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    pub encoding: String,
    pub file_size_bytes: u64,
    pub user_version: i64,
    pub application_id: i64,
    pub foreign_keys: bool,
    pub wal_size_bytes: u64,
    pub shm_size_bytes: u64,
}

#[tauri::command]
pub async fn sqlite_conn_info(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<SqliteConnInfo, String> {
    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    macro_rules! pragma_str {
        ($conn:expr, $name:expr) => {{
            sqlx::query(&format!("PRAGMA {}", $name))
                .fetch_one(&mut $conn).await
                .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
                .unwrap_or_default()
        }};
    }
    macro_rules! pragma_u64 {
        ($conn:expr, $name:expr) => {{
            sqlx::query(&format!("PRAGMA {}", $name))
                .fetch_one(&mut $conn).await
                .map(|r| r.try_get::<i64, _>(0).unwrap_or(0) as u64)
                .unwrap_or(0)
        }};
    }
    macro_rules! pragma_i64 {
        ($conn:expr, $name:expr) => {{
            sqlx::query(&format!("PRAGMA {}", $name))
                .fetch_one(&mut $conn).await
                .map(|r| r.try_get::<i64, _>(0).unwrap_or(0))
                .unwrap_or(0)
        }};
    }

    let version   = pragma_str!(conn, "data_version");
    let sqlite_ver: String = sqlx::query("SELECT sqlite_version()")
        .fetch_one(&mut conn).await
        .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
        .unwrap_or_default();
    let journal   = pragma_str!(conn, "journal_mode");
    let page_size = pragma_u64!(conn, "page_size");
    let page_count= pragma_u64!(conn, "page_count");
    let freelist  = pragma_u64!(conn, "freelist_count");
    let encoding  = pragma_str!(conn, "encoding");
    let user_ver  = pragma_i64!(conn, "user_version");
    let app_id    = pragma_i64!(conn, "application_id");
    let fk_on     = pragma_i64!(conn, "foreign_keys");
    let _ = version; // used for compile

    // 文件大小
    let path = config.file_path.as_deref().unwrap_or("");
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let wal_size  = std::fs::metadata(&format!("{path}-wal")).map(|m| m.len()).unwrap_or(0);
    let shm_size  = std::fs::metadata(&format!("{path}-shm")).map(|m| m.len()).unwrap_or(0);

    Ok(SqliteConnInfo {
        sqlite_version: sqlite_ver,
        journal_mode: journal,
        page_size,
        page_count,
        freelist_count: freelist,
        encoding,
        file_size_bytes: file_size,
        user_version: user_ver,
        application_id: app_id,
        foreign_keys: fk_on != 0,
        wal_size_bytes: wal_size,
        shm_size_bytes: shm_size,
    })
}

// ─── S0.1 文件健康预检（打开前调用） ─────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteFileHealth {
    pub valid_magic: bool,
    pub has_journal: bool,
    pub has_wal: bool,
    pub has_shm: bool,
    pub journal_size_bytes: u64,
    pub wal_size_bytes: u64,
    pub file_size_bytes: u64,
}

#[tauri::command]
pub async fn sqlite_file_health(path: String) -> Result<SqliteFileHealth, String> {
    // 读取前 16 字节校验魔数
    let magic = b"SQLite format 3\0";
    let mut header = [0u8; 16];
    let valid = if let Ok(mut f) = std::fs::File::open(&path) {
        use std::io::Read;
        f.read_exact(&mut header).is_ok() && &header == magic
    } else {
        false
    };
    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let journal_size = std::fs::metadata(&format!("{path}-journal")).map(|m| m.len()).unwrap_or(0);
    let wal_size     = std::fs::metadata(&format!("{path}-wal")).map(|m| m.len()).unwrap_or(0);
    let shm_size     = std::fs::metadata(&format!("{path}-shm")).map(|m| m.len()).unwrap_or(0);
    Ok(SqliteFileHealth {
        valid_magic: valid,
        has_journal: journal_size > 0,
        has_wal: wal_size > 0,
        has_shm: shm_size > 0,
        journal_size_bytes: journal_size,
        wal_size_bytes: wal_size,
        file_size_bytes: file_size,
    })
}

// ─── S2.1 完整性检查 ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityResult {
    pub ok: bool,
    pub issues: Vec<String>,
    pub fk_violations: Vec<String>,
}

#[tauri::command]
pub async fn sqlite_integrity_check(
    id: String,
    quick: bool,
    storage: State<'_, StorageState>,
) -> Result<IntegrityResult, String> {
    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    let pragma = if quick { "PRAGMA quick_check" } else { "PRAGMA integrity_check" };
    let rows = sqlx::query(pragma).fetch_all(&mut conn).await
        .map_err(|e| format!("完整性检查失败: {e}"))?;
    let mut issues: Vec<String> = rows.iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .filter(|s| s != "ok")
        .collect();

    // 外键检查
    let fk_rows = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut conn).await
        .unwrap_or_default();
    let fk_violations: Vec<String> = fk_rows.iter()
        .filter_map(|r| {
            let tbl = r.try_get::<String, _>(0).unwrap_or_default();
            let row_id = r.try_get::<i64, _>(1).unwrap_or(0);
            let ref_tbl = r.try_get::<String, _>(2).unwrap_or_default();
            Some(format!("表 `{tbl}` rowid={row_id} → 缺少 `{ref_tbl}` 的外键记录"))
        }).collect();

    if !fk_violations.is_empty() {
        issues.extend_from_slice(&fk_violations);
    }
    Ok(IntegrityResult {
        ok: issues.is_empty(),
        issues: issues.clone(),
        fk_violations,
    })
}

// ─── S2.2 维护操作 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sqlite_vacuum(
    id: String,
    into_path: Option<String>, // VACUUM INTO 备份路径，None = 原地 VACUUM
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let config = load_config(&storage, &id)?;
    if let Some(path) = into_path {
        vacuum_into_new_file(&config, &path).await?;
        return Ok("VACUUM INTO 完成".into());
    }
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    sqlx::query("VACUUM").execute(&mut conn).await
        .map_err(|e| format!("VACUUM 失败: {e}"))?;
    Ok("VACUUM 完成".to_string())
}

#[tauri::command]
pub async fn sqlite_analyze(
    id: String,
    table: Option<String>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    let sql = if let Some(t) = table {
        format!("ANALYZE '{}'", t.replace('\'', "''"))
    } else {
        "ANALYZE".to_string()
    };
    sqlx::query(&sql).execute(&mut conn).await
        .map_err(|e| format!("ANALYZE 失败: {e}"))?;
    Ok("ANALYZE 完成".to_string())
}

#[tauri::command]
pub async fn sqlite_optimize(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    sqlx::query("PRAGMA optimize").execute(&mut conn).await
        .map_err(|e| format!("PRAGMA optimize 失败: {e}"))?;
    Ok("optimize 完成".to_string())
}

// ─── S2.3 空间统计 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteSpaceStats {
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub fragmentation_pct: f64,
    pub tables: Vec<TableSpaceInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpaceInfo {
    pub name: String,
    pub pages: u64,
    pub bytes: u64,
}

#[tauri::command]
pub async fn sqlite_space_stats(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<SqliteSpaceStats, String> {
    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    let page_size: u64   = sqlx::query("PRAGMA page_size").fetch_one(&mut conn).await
        .map(|r| r.try_get::<i64, _>(0).unwrap_or(0) as u64).unwrap_or(4096);
    let page_count: u64  = sqlx::query("PRAGMA page_count").fetch_one(&mut conn).await
        .map(|r| r.try_get::<i64, _>(0).unwrap_or(0) as u64).unwrap_or(0);
    let freelist: u64    = sqlx::query("PRAGMA freelist_count").fetch_one(&mut conn).await
        .map(|r| r.try_get::<i64, _>(0).unwrap_or(0) as u64).unwrap_or(0);

    let total_bytes = page_count * page_size;
    let free_bytes  = freelist  * page_size;
    let frag_pct    = if page_count > 0 { freelist as f64 / page_count as f64 * 100.0 } else { 0.0 };

    // 按表统计（dbstat 虚拟表，若不可用则跳过）
    let tables = sqlx::query(
        "SELECT name, sum(pageno) as pages FROM dbstat WHERE aggregate=1 AND name NOT LIKE 'sqlite_%' GROUP BY name ORDER BY pages DESC LIMIT 50"
    ).fetch_all(&mut conn).await.unwrap_or_default().into_iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let pages: i64   = r.try_get(1).ok()?;
            Some(TableSpaceInfo { name, pages: pages as u64, bytes: pages as u64 * page_size })
        }).collect();

    Ok(SqliteSpaceStats { page_size, page_count, freelist_count: freelist,
        total_bytes, free_bytes, fragmentation_pct: frag_pct, tables })
}

// ─── S2.4 WAL / journal 管理 ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalStatus {
    pub journal_mode: String,
    pub wal_file_bytes: u64,
    pub shm_file_bytes: u64,
    pub checkpoint_result: Option<CheckpointResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResult {
    pub busy: i64,
    pub log_frames: i64,
    pub checkpointed_frames: i64,
}

#[tauri::command]
pub async fn sqlite_wal_status(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<WalStatus, String> {
    let config = load_config(&storage, &id)?;
    let path = config.file_path.as_deref().unwrap_or("").to_string();
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    let journal_mode: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&mut conn).await
        .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
        .unwrap_or_default();

    let wal_size = std::fs::metadata(&format!("{path}-wal")).map(|m| m.len()).unwrap_or(0);
    let shm_size = std::fs::metadata(&format!("{path}-shm")).map(|m| m.len()).unwrap_or(0);

    Ok(WalStatus { journal_mode, wal_file_bytes: wal_size, shm_file_bytes: shm_size, checkpoint_result: None })
}

#[tauri::command]
pub async fn sqlite_wal_checkpoint(
    id: String,
    mode: String, // PASSIVE | FULL | TRUNCATE | RESTART
    storage: State<'_, StorageState>,
) -> Result<CheckpointResult, String> {
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    let safe_mode = match mode.to_uppercase().as_str() {
        "FULL" => "FULL", "TRUNCATE" => "TRUNCATE", "RESTART" => "RESTART", _ => "PASSIVE",
    };
    let row = sqlx::query(&format!("PRAGMA wal_checkpoint({})", safe_mode))
        .fetch_one(&mut conn).await
        .map_err(|e| format!("WAL checkpoint 失败: {e}"))?;
    Ok(CheckpointResult {
        busy: row.try_get::<i64, _>(0).unwrap_or(0),
        log_frames: row.try_get::<i64, _>(1).unwrap_or(0),
        checkpointed_frames: row.try_get::<i64, _>(2).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn sqlite_set_journal_mode(
    id: String,
    mode: String, // WAL | DELETE | TRUNCATE | MEMORY | OFF
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    let safe_mode = match mode.to_uppercase().as_str() {
        "WAL" => "WAL", "TRUNCATE" => "TRUNCATE", "MEMORY" => "MEMORY",
        "OFF" => "OFF", _ => "DELETE",
    };
    let row = sqlx::query(&format!("PRAGMA journal_mode={}", safe_mode))
        .fetch_one(&mut conn).await
        .map_err(|e| format!("设置 journal_mode 失败: {e}"))?;
    Ok(row.try_get::<String, _>(0).unwrap_or_default())
}

// ─── S2.5 PRAGMA 浏览器 ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PragmaEntry {
    pub name: String,
    pub value: String,
    pub writable: bool,
    pub group: String,
}

#[tauri::command]
pub async fn sqlite_pragma_list(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<PragmaEntry>, String> {
    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;

    // 常用 PRAGMA 分组
    let pragmas: &[(&str, &str, bool)] = &[
        // (name, group, writable)
        ("page_size",          "性能", false),
        ("page_count",         "性能", false),
        ("freelist_count",     "性能", false),
        ("cache_size",         "性能", true),
        ("mmap_size",          "性能", true),
        ("wal_autocheckpoint", "性能", true),
        ("busy_timeout",       "性能", true),
        ("synchronous",        "性能", true),
        ("journal_mode",       "性能", true),
        ("temp_store",         "性能", true),
        ("foreign_keys",       "安全", true),
        ("query_only",         "安全", true),
        ("secure_delete",      "安全", true),
        ("user_version",       "兼容", true),
        ("application_id",     "兼容", true),
        ("data_version",       "兼容", false),
        ("encoding",           "兼容", false),
        ("recursive_triggers", "兼容", true),
        ("defer_foreign_keys", "兼容", true),
    ];
    let mut result = vec![];
    for &(name, group, writable) in pragmas {
        let val = sqlx::query(&format!("PRAGMA {name}"))
            .fetch_one(&mut conn).await
            .map(|r| {
                r.try_get::<i64, _>(0).map(|v| v.to_string())
                    .or_else(|_| r.try_get::<String, _>(0))
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        result.push(PragmaEntry { name: name.to_string(), value: val, writable, group: group.to_string() });
    }
    Ok(result)
}

#[tauri::command]
pub async fn sqlite_set_pragma(
    id: String,
    name: String,
    value: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    // 白名单防注入
    let allowed = ["cache_size","mmap_size","wal_autocheckpoint","busy_timeout","synchronous",
                   "foreign_keys","query_only","secure_delete","user_version","application_id",
                   "recursive_triggers","defer_foreign_keys","temp_store"];
    if !allowed.contains(&name.as_str()) {
        return Err(format!("PRAGMA `{name}` 不在可写白名单"));
    }
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let mut conn = admin_conn(&config).await?;
    use sqlx::Row;
    let sql = format!("PRAGMA {name}={value}");
    let row = sqlx::query(&sql).fetch_one(&mut conn).await
        .map_err(|e| format!("设置 PRAGMA {name} 失败: {e}"))?;
    Ok(row.try_get::<i64, _>(0).map(|v| v.to_string())
        .or_else(|_| row.try_get::<String, _>(0))
        .unwrap_or_default())
}

// ─── S2.6 锁与并发诊断 ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockProcess {
    pub pid: String,
    pub command: String,
    pub user: String,
    pub fd: String,
    pub lock_type: String, // READ / WRITE / UNKNOWN
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockDiagnosis {
    pub processes: Vec<LockProcess>,
    pub wal_checkpoint: Option<CheckpointResult>,
    pub wal_file_bytes: u64,
    pub summary: String,
}

#[tauri::command]
pub async fn sqlite_lock_diagnosis(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<LockDiagnosis, String> {
    let config = load_config(&storage, &id)?;
    let path = config.file_path.as_deref().unwrap_or("").to_string();

    // 检测持锁进程（macOS/Linux: lsof）
    let processes = detect_locking_processes(&path);

    // WAL checkpoint 探测（PASSIVE，不阻塞）
    let (wal_checkpoint, wal_size) = if let Ok(mut conn) = async { require_admin_write(&config)?; admin_conn(&config).await }.await {
        use sqlx::Row;
        let wal_sz = std::fs::metadata(&format!("{path}-wal")).map(|m| m.len()).unwrap_or(0);
        let cp = sqlx::query("PRAGMA wal_checkpoint(PASSIVE)")
            .fetch_one(&mut conn).await.ok().map(|r| CheckpointResult {
                busy: r.try_get::<i64, _>(0).unwrap_or(0),
                log_frames: r.try_get::<i64, _>(1).unwrap_or(0),
                checkpointed_frames: r.try_get::<i64, _>(2).unwrap_or(0),
            });
        (cp, wal_sz)
    } else {
        (None, 0)
    };

    let summary = build_lock_summary(&processes, &wal_checkpoint, wal_size);

    Ok(LockDiagnosis {
        processes,
        wal_checkpoint,
        wal_file_bytes: wal_size,
        summary,
    })
}

fn detect_locking_processes(path: &str) -> Vec<LockProcess> {
    // Use lsof to find processes with this file open
    let output = std::process::Command::new("lsof")
        .args(["-F", "pcuft", path]) // machine-readable output
        .output();
    let Ok(out) = output else { return vec![]; };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut procs: Vec<LockProcess> = Vec::new();
    let mut pid = String::new();
    let mut command = String::new();
    let mut user = String::new();
    let mut fd = String::new();

    for line in text.lines() {
        if line.is_empty() { continue; }
        match line.chars().next() {
            Some('p') => { pid = line[1..].to_string(); }
            Some('c') => { command = line[1..].to_string(); }
            Some('u') => { user = line[1..].to_string(); }
            Some('f') => { fd = line[1..].to_string(); }
            Some('t') => {
                let lock_type = line[1..].to_string();
                // Record an entry for each fd we see
                if !pid.is_empty() {
                    procs.push(LockProcess {
                        pid: pid.clone(), command: command.clone(),
                        user: user.clone(), fd: fd.clone(),
                        lock_type: classify_fd_lock(&lock_type),
                    });
                }
            }
            _ => {}
        }
    }
    procs.dedup_by(|a, b| a.pid == b.pid); // one entry per process
    procs
}

fn classify_fd_lock(fd_type: &str) -> String {
    match fd_type {
        "REG" => "READ/WRITE".to_string(),
        _ => fd_type.to_string(),
    }
}

fn build_lock_summary(
    processes: &[LockProcess],
    wal_cp: &Option<CheckpointResult>,
    wal_size: u64,
) -> String {
    let mut parts = Vec::new();
    if processes.is_empty() {
        parts.push("未检测到其他进程持锁".to_string());
    } else {
        let pids: Vec<&str> = processes.iter().map(|p| p.pid.as_str()).collect();
        parts.push(format!("检测到 {} 个进程持锁（PID: {}）", processes.len(), pids.join(", ")));
    }
    if let Some(cp) = wal_cp {
        if cp.busy > 0 {
            parts.push(format!("WAL checkpoint 受阻（{} 个 reader 持锁，{}/{} 帧已检查点）",
                cp.busy, cp.checkpointed_frames, cp.log_frames));
        } else {
            parts.push(format!("WAL checkpoint 正常（{}/{} 帧已检查点）",
                cp.checkpointed_frames, cp.log_frames));
        }
    }
    if wal_size > 1024 * 1024 {
        parts.push(format!("WAL 文件较大（{}MB），建议执行 FULL checkpoint", wal_size / 1024 / 1024));
    }
    parts.join("；")
}

// ─── S2.7 索引顾问 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSuggestion {
    pub table: String,
    pub columns: Vec<String>,
    pub reason: String,
    pub create_sql: String,
    pub is_redundant_candidate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexAdvisorResult {
    pub suggestions: Vec<IndexSuggestion>,
    pub redundant_indexes: Vec<RedundantIndex>,
    pub scan_nodes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedundantIndex {
    pub name: String,
    pub table: String,
    pub covered_by: String,
    pub drop_sql: String,
}

#[tauri::command]
pub async fn sqlite_index_advisor(
    id: String,
    sql: String,
    storage: State<'_, StorageState>,
) -> Result<IndexAdvisorResult, String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Row};
    use std::str::FromStr;

    let config = load_config(&storage, &id)?;
    let url = sqlite_url(&config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("URL 解析失败: {e}"))?
        .busy_timeout(std::time::Duration::from_secs(5))
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("连接失败: {e}"))?;

    // Run EXPLAIN QUERY PLAN
    let eqp_sql = format!("EXPLAIN QUERY PLAN {}", sql.trim());
    let rows = sqlx::query(&eqp_sql).fetch_all(&mut conn).await
        .map_err(|e| format!("EXPLAIN QUERY PLAN 失败: {e}"))?;

    let mut scan_nodes = Vec::new();
    let mut suggestions: Vec<IndexSuggestion> = Vec::new();

    for row in &rows {
        let detail: String = row.try_get(3).unwrap_or_default();
        if detail.contains("SCAN") && !detail.contains("USING") && !detail.contains("COVERING") {
            scan_nodes.push(detail.clone());
            // Extract table name from detail like "SCAN table_name"
            if let Some(tbl) = extract_scan_table(&detail) {
                // Generate a basic index suggestion
                let idx_name = format!("idx_{}_{}", tbl, chrono_secs());
                let create_sql = format!("CREATE INDEX {idx_name} ON {tbl} (/* 添加 WHERE/JOIN 中使用的列 */);");
                suggestions.push(IndexSuggestion {
                    table: tbl.clone(),
                    columns: vec!["/* 需要手动指定列 */".to_string()],
                    reason: format!("检测到全表扫描: {detail}"),
                    create_sql,
                    is_redundant_candidate: false,
                });
            }
        }
        if detail.contains("AUTO INDEX") {
            scan_nodes.push(detail.clone());
        }
    }

    // Detect redundant indexes (prefix-covered)
    let redundant_indexes = detect_redundant_indexes(&mut conn).await?;

    Ok(IndexAdvisorResult { suggestions, redundant_indexes, scan_nodes })
}

fn extract_scan_table(detail: &str) -> Option<String> {
    // "SCAN table_name" or "SCAN table_name AS alias"
    let upper = detail.to_uppercase();
    let pos = upper.find("SCAN")?;
    let rest = detail[pos + 4..].trim();
    let tbl = rest.split_whitespace().next()?;
    Some(tbl.trim_matches('"').to_string())
}

fn chrono_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn detect_redundant_indexes(conn: &mut sqlx::sqlite::SqliteConnection) -> Result<Vec<RedundantIndex>, String> {
    use sqlx::Row;
    // Get all user-defined indexes
    let idx_rows = sqlx::query(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_autoindex_%'"
    ).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询索引失败: {e}"))?;

    let mut result = Vec::new();

    for row in &idx_rows {
        let idx_name: String = row.try_get(0).unwrap_or_default();
        let tbl_name: String = row.try_get(1).unwrap_or_default();

        // Get columns for this index
        let col_rows = sqlx::query(&format!("PRAGMA index_info(\"{}\")", idx_name.replace('"', "\"\"")))
            .fetch_all(&mut *conn).await.unwrap_or_default();
        let cols: Vec<String> = col_rows.iter()
            .filter_map(|r| r.try_get::<String, _>(2).ok())
            .collect();
        if cols.is_empty() { continue; }

        // Check if this index is a prefix of another index on the same table
        for row2 in &idx_rows {
            let idx2_name: String = row2.try_get(0).unwrap_or_default();
            let tbl2_name: String = row2.try_get(1).unwrap_or_default();
            if idx2_name == idx_name || tbl2_name != tbl_name { continue; }

            let col2_rows = sqlx::query(&format!("PRAGMA index_info(\"{}\")", idx2_name.replace('"', "\"\"")))
                .fetch_all(&mut *conn).await.unwrap_or_default();
            let cols2: Vec<String> = col2_rows.iter()
                .filter_map(|r| r.try_get::<String, _>(2).ok())
                .collect();
            // If cols is a prefix of cols2, then idx may be redundant
            if cols2.len() > cols.len() && cols2.starts_with(&cols) {
                result.push(RedundantIndex {
                    name: idx_name.clone(),
                    table: tbl_name.clone(),
                    covered_by: idx2_name.clone(),
                    drop_sql: format!("DROP INDEX \"{}\"; -- 被 {} 覆盖", idx_name, idx2_name),
                });
                break;
            }
        }
    }

    Ok(result)
}

// ─── S3.1 在线备份 ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub path: String,
    pub created_at: u64,
    pub size_bytes: u64,
    pub note: String,
}

fn backup_history_path(db_path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(db_path);
    let stem = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let dir = p.parent().unwrap_or(std::path::Path::new("."));
    dir.join(format!(".{stem}.backup_history.json"))
}

fn load_backup_history(db_path: &str) -> Vec<BackupRecord> {
    let hp = backup_history_path(db_path);
    let Ok(data) = std::fs::read_to_string(&hp) else { return vec![] };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_backup_history(db_path: &str, records: &[BackupRecord]) {
    let hp = backup_history_path(db_path);
    if let Ok(json) = serde_json::to_string_pretty(records) {
        let _ = std::fs::write(hp, json);
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn sqlite_backup(
    id: String,
    dir: Option<String>,
    note: Option<String>,
    storage: State<'_, StorageState>,
) -> Result<BackupRecord, String> {
    let config = load_config(&storage, &id)?;
    let db_path = config.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;

    // Determine backup directory
    let out_dir = if let Some(d) = dir.as_ref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(d)
    } else {
        let p = std::path::Path::new(db_path);
        let parent = p.parent().unwrap_or(std::path::Path::new("."));
        parent.join("backups")
    };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    // Build backup file name: {stem}_{timestamp}.db
    let stem = std::path::Path::new(db_path)
        .file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "db".into());
    let ts = unix_now();
    let backup_name = format!("{stem}_{ts}.db");
    let backup_path = out_dir.join(&backup_name);
    let backup_path_str = backup_path.to_string_lossy().to_string();

    vacuum_into_new_file(&config, &backup_path_str).await?;

    let size = std::fs::metadata(&backup_path).map(|m| m.len()).unwrap_or(0);
    let record = BackupRecord {
        path: backup_path_str,
        created_at: ts,
        size_bytes: size,
        note: note.unwrap_or_default(),
    };

    // Append to history
    let mut history = load_backup_history(db_path);
    history.push(record.clone());
    save_backup_history(db_path, &history);

    Ok(record)
}

#[tauri::command]
pub async fn sqlite_backup_list(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<BackupRecord>, String> {
    let config = load_config(&storage, &id)?;
    let db_path = config.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;
    let mut records = load_backup_history(db_path);
    // Filter to existing files only
    records.retain(|r| std::path::Path::new(&r.path).exists());
    // Sort newest first
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(records)
}

#[tauri::command]
pub async fn sqlite_restore_backup(
    id: String,
    backup_path: String,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    let config = load_config(&storage, &id)?;
    restore_backup_with_config(&config, backup_path).await
}

async fn restore_backup_with_config(config: &ConnConfig, backup_path: String) -> Result<String, String> {
    require_admin_write(&config)?;
    let db_path = config.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;

    let src = std::path::Path::new(&backup_path);
    if !src.exists() {
        return Err(format!("备份文件不存在: {backup_path}"));
    }
    // Validate backup is a valid SQLite file
    {
        use std::io::Read;
        let mut f = std::fs::File::open(src).map_err(|e| format!("无法打开备份文件: {e}"))?;
        let mut magic = [0u8; 16];
        f.read_exact(&mut magic).map_err(|_| "备份文件过短，不是有效的 SQLite 数据库".to_string())?;
        if &magic != b"SQLite format 3\0" {
            return Err("备份文件 magic 校验失败，不是有效的 SQLite 数据库".to_string());
        }
    }

    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Connection};
    let db_canonical = std::path::Path::new(db_path).canonicalize().map_err(|e| e.to_string())?;
    let backup_canonical = src.canonicalize().map_err(|e| e.to_string())?;
    if db_canonical == backup_canonical { return Err("备份不能是当前数据库".into()); }
    if same_file::is_same_file(&db_canonical, &backup_canonical).map_err(|e| format!("校验恢复文件标识失败: {e}"))? {
        return Err("备份不能是当前数据库的硬链接".into());
    }
    let mut source = SqliteConnectOptions::new().filename(&backup_canonical).read_only(true).connect().await.map_err(|e| format!("打开备份失败: {e}"))?;
    let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check").fetch_all(&mut source).await.map_err(|e| format!("校验备份失败: {e}"))?;
    if checks.as_slice() != ["ok"] { return Err(format!("备份完整性检查未通过: {}", checks.join("; "))); }
    let mut destination = admin_conn(config).await?;
    // Keep the active database inode and WAL/SHM ownership intact.
    let archive_path = format!("{db_path}.{}.bak", uuid::Uuid::new_v4().simple());
    sqlx::query("VACUUM INTO ?").bind(&archive_path).execute(&mut destination).await.map_err(|e| format!("创建恢复前备份失败，原库未修改: {e}"))?;
    copy_sqlite_backup(&mut source, &mut destination).await?;
    destination.close().await.map_err(|e| format!("恢复已提交，关闭连接失败，请核验: {e}"))?;
    Ok(format!("恢复成功。原库一致性备份: {archive_path}"))
}

async fn copy_sqlite_backup(source: &mut sqlx::SqliteConnection, destination: &mut sqlx::SqliteConnection) -> Result<(), String> {
    let mut source_handle = source.lock_handle().await.map_err(|e| e.to_string())?;
    let mut destination_handle = destination.lock_handle().await.map_err(|e| e.to_string())?;
    // Locked SQLx handles exclude their background workers during FFI.
    // DONE commits atomically; finish rolls back any incomplete backup.
    let status = unsafe {
        let backup = libsqlite3_sys::sqlite3_backup_init(destination_handle.as_raw_handle().as_ptr(), c"main".as_ptr(), source_handle.as_raw_handle().as_ptr(), c"main".as_ptr());
        if backup.is_null() { return Err("无法启动原子恢复，目标库未替换".into()); }
        let step = libsqlite3_sys::sqlite3_backup_step(backup, -1);
        let finish = libsqlite3_sys::sqlite3_backup_finish(backup);
        (step, finish)
    };
    if status != (libsqlite3_sys::SQLITE_DONE, libsqlite3_sys::SQLITE_OK) {
        return Err(format!("恢复未完成（SQLite code {}/{}），未完成的备份事务已回滚，原库未被文件替换", status.0, status.1));
    }
    Ok(())
}

// ─── S4.4 数据字典导出 ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDictTable {
    pub name: String,
    pub sql: String,
    pub row_count: i64,
    pub columns: Vec<DataDictColumn>,
    pub indexes: Vec<DataDictIndex>,
    pub foreign_keys: Vec<DataDictFk>,
    pub triggers: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDictColumn {
    pub cid: i64,
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub default_value: Option<String>,
    pub pk: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDictIndex {
    pub name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDictFk {
    pub from_col: String,
    pub to_table: String,
    pub to_col: String,
    pub on_update: String,
    pub on_delete: String,
}

#[tauri::command]
pub async fn sqlite_data_dictionary(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<DataDictTable>, String> {
    use sqlx::Row;

    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;

    let tbl_rows = sqlx::query(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name"
    ).fetch_all(&mut conn).await.map_err(|e| format!("读取表列表失败: {e}"))?;

    let mut result = Vec::new();
    for row in &tbl_rows {
        let name: String = row.try_get(0).unwrap_or_default();
        let sql: String = row.try_get(1).unwrap_or_default();
        let q_name = format!("\"{}\"", name.replace('"', "\"\""));

        let row_count: i64 = sqlx::query(&format!("SELECT COUNT(*) FROM {q_name}"))
            .fetch_one(&mut conn).await.and_then(|r| r.try_get(0)).unwrap_or(0);

        let col_rows = sqlx::query(&format!("PRAGMA table_info({q_name})"))
            .fetch_all(&mut conn).await.unwrap_or_default();
        let columns: Vec<DataDictColumn> = col_rows.iter().map(|r| DataDictColumn {
            cid: r.try_get(0).unwrap_or(0),
            name: r.try_get(1).unwrap_or_default(),
            data_type: r.try_get(2).unwrap_or_default(),
            not_null: r.try_get::<i64, _>(3).unwrap_or(0) != 0,
            default_value: r.try_get::<Option<String>, _>(4).unwrap_or(None),
            pk: r.try_get::<i64, _>(5).unwrap_or(0) != 0,
        }).collect();

        let idx_list = sqlx::query(&format!("PRAGMA index_list({q_name})"))
            .fetch_all(&mut conn).await.unwrap_or_default();
        let mut indexes = Vec::new();
        for ir in &idx_list {
            let idx_name: String = ir.try_get(1).unwrap_or_default();
            let unique: i64 = ir.try_get(2).unwrap_or(0);
            let idx_info = sqlx::query(&format!("PRAGMA index_info(\"{}\")", idx_name.replace('"', "\"\"")))
                .fetch_all(&mut conn).await.unwrap_or_default();
            let cols: Vec<String> = idx_info.iter().filter_map(|r| r.try_get(2).ok()).collect();
            indexes.push(DataDictIndex { name: idx_name, unique: unique != 0, columns: cols });
        }

        let fk_rows = sqlx::query(&format!("PRAGMA foreign_key_list({q_name})"))
            .fetch_all(&mut conn).await.unwrap_or_default();
        let foreign_keys: Vec<DataDictFk> = fk_rows.iter().map(|r| DataDictFk {
            from_col: r.try_get(3).unwrap_or_default(),
            to_table: r.try_get(2).unwrap_or_default(),
            to_col: r.try_get(4).unwrap_or_default(),
            on_update: r.try_get(5).unwrap_or_default(),
            on_delete: r.try_get(6).unwrap_or_default(),
        }).collect();

        let trig_rows = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?"
        ).bind(&name).fetch_all(&mut conn).await.unwrap_or_default();
        let triggers: Vec<String> = trig_rows.iter().filter_map(|r| r.try_get(0).ok()).collect();

        result.push(DataDictTable { name, sql, row_count, columns, indexes, foreign_keys, triggers });
    }

    Ok(result)
}

// ─── S4.1 一键健康巡检报告 ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub score: u8,
    pub checks: Vec<HealthCheck>,
    pub markdown: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub category: String,
    pub item: String,
    pub status: String,   // "ok" | "warn" | "error"
    pub detail: String,
    pub score_impact: i8, // negative = deduct points
}

#[tauri::command]
pub async fn sqlite_health_report(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<HealthReport, String> {
    use sqlx::Row;

    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;
    let db_path = config.file_path.as_deref().unwrap_or("unknown");
    let mut checks: Vec<HealthCheck> = Vec::new();
    let mut score: i16 = 100;

    // ── 1. 完整性检查 ─────────────────────────────────────────────────────────
    match sqlx::query("PRAGMA quick_check").fetch_all(&mut conn).await {
        Err(e) => {
            checks.push(HealthCheck { category: "完整性".into(), item: "快速完整性".into(),
                status: "error".into(), detail: format!("检查失败: {e}"), score_impact: -30 });
            score -= 30;
        }
        Ok(rows) => {
            let first: String = rows.first().and_then(|r| r.try_get(0).ok()).unwrap_or_default();
            if first == "ok" {
                checks.push(HealthCheck { category: "完整性".into(), item: "快速完整性".into(),
                    status: "ok".into(), detail: "通过".into(), score_impact: 0 });
            } else {
                let issues: Vec<String> = rows.iter().filter_map(|r| r.try_get(0).ok()).collect();
                checks.push(HealthCheck { category: "完整性".into(), item: "快速完整性".into(),
                    status: "error".into(), detail: issues.join("; "), score_impact: -30 });
                score -= 30;
            }
        }
    }

    // ── 2. 碎片率 ─────────────────────────────────────────────────────────────
    let page_count: i64 = sqlx::query("PRAGMA page_count").fetch_one(&mut conn).await
        .and_then(|r| r.try_get(0)).unwrap_or(0);
    let freelist: i64 = sqlx::query("PRAGMA freelist_count").fetch_one(&mut conn).await
        .and_then(|r| r.try_get(0)).unwrap_or(0);
    let frag_pct = if page_count > 0 { freelist * 100 / page_count } else { 0 };
    let (frag_status, frag_impact): (&str, i8) = if frag_pct > 30 { ("error", -15) }
        else if frag_pct > 10 { ("warn", -5) } else { ("ok", 0) };
    score += frag_impact as i16;
    checks.push(HealthCheck { category: "空间".into(), item: "碎片率".into(),
        status: frag_status.into(), detail: format!("{frag_pct}% (空闲 {freelist}/{page_count} 页)"), score_impact: frag_impact });

    // ── 3. 统计陈旧度 ─────────────────────────────────────────────────────────
    let stat_rows = sqlx::query("SELECT COUNT(*) FROM sqlite_stat1").fetch_one(&mut conn).await;
    let (stat_status, stat_impact, stat_detail): (&str, i8, String) = match stat_rows {
        Err(_) => ("warn", -5, "sqlite_stat1 不存在，尚未执行 ANALYZE".into()),
        Ok(r) => {
            let cnt: i64 = r.try_get(0).unwrap_or(0);
            if cnt == 0 { ("warn", -5, "已执行 ANALYZE 但统计表为空".into()) }
            else { ("ok", 0, format!("统计 {cnt} 条记录")) }
        }
    };
    score += stat_impact as i16;
    checks.push(HealthCheck { category: "优化器".into(), item: "统计信息".into(),
        status: stat_status.into(), detail: stat_detail, score_impact: stat_impact });

    // ── 4. WAL 状态 ───────────────────────────────────────────────────────────
    let journal_mode: String = sqlx::query("PRAGMA journal_mode").fetch_one(&mut conn).await
        .and_then(|r| r.try_get(0)).unwrap_or_default();
    if journal_mode.to_uppercase() == "WAL" {
        let wal_path = format!("{db_path}-wal");
        let wal_bytes = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        let (wal_status, wal_impact, wal_detail) = if wal_bytes > 100 * 1024 * 1024 {
            ("warn", -5i8, format!("WAL 文件 {:.1}MB，建议 checkpoint", wal_bytes as f64 / 1e6))
        } else {
            ("ok", 0i8, format!("WAL 模式，{:.1}KB", wal_bytes as f64 / 1024.0))
        };
        score += wal_impact as i16;
        checks.push(HealthCheck { category: "WAL".into(), item: "WAL 文件大小".into(),
            status: wal_status.into(), detail: wal_detail, score_impact: wal_impact });
    } else {
        let (jm_status, jm_impact) = match journal_mode.to_uppercase().as_str() {
            "OFF" => ("error", -20i8),
            "MEMORY" => ("warn", -10i8),
            _ => ("ok", 0i8),
        };
        score += jm_impact as i16;
        checks.push(HealthCheck { category: "WAL".into(), item: "日志模式".into(),
            status: jm_status.into(),
            detail: format!("journal_mode={journal_mode}，生产建议使用 WAL 模式"),
            score_impact: jm_impact });
    }

    // ── 5. 外键约束 ───────────────────────────────────────────────────────────
    let fk_on: i64 = sqlx::query("PRAGMA foreign_keys").fetch_one(&mut conn).await
        .and_then(|r| r.try_get(0)).unwrap_or(0);
    checks.push(HealthCheck { category: "约束".into(), item: "外键约束".into(),
        status: if fk_on == 1 { "ok" } else { "warn" }.into(),
        detail: if fk_on == 1 { "已开启".into() } else { "未开启（建议开启 PRAGMA foreign_keys=ON）".into() },
        score_impact: if fk_on == 0 { -5 } else { 0 } });
    if fk_on == 0 { score -= 5; }

    // ── 6. 冗余索引（从 index_advisor 功能复用逻辑） ─────────────────────────
    let idx_rows = sqlx::query(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_autoindex_%'"
    ).fetch_all(&mut conn).await.unwrap_or_default();
    let redundant_count = detect_redundant_indexes(&mut conn).await.map(|v| v.len()).unwrap_or(0);
    let (idx_status, idx_impact) = if redundant_count > 3 { ("warn", -5i8) }
        else if redundant_count > 0 { ("warn", -2i8) } else { ("ok", 0i8) };
    score += idx_impact as i16;
    checks.push(HealthCheck { category: "索引".into(), item: "冗余索引".into(),
        status: idx_status.into(),
        detail: format!("共 {} 个索引，{redundant_count} 个可能冗余", idx_rows.len()),
        score_impact: idx_impact });

    score = score.max(0).min(100);

    // Build Markdown report
    let mut md = format!("# SQLite 健康巡检报告\n\n**数据库**: {db_path}  \n**得分**: {score}/100\n\n");
    md.push_str("## 检查项\n\n");
    md.push_str("| 类别 | 检查项 | 状态 | 详情 |\n|---|---|---|---|\n");
    for c in &checks {
        let icon = match c.status.as_str() { "ok" => "✅", "warn" => "⚠️", _ => "❌" };
        md.push_str(&format!("| {} | {} | {} | {} |\n", c.category, c.item, icon, c.detail));
    }
    let summary = if score >= 90 { "数据库健康状况良好" }
        else if score >= 70 { "存在一些需要关注的问题" }
        else if score >= 50 { "存在多项问题，建议尽快处理" }
        else { "数据库健康状况较差，请立即处理" };
    md.push_str(&format!("\n## 总结\n\n{summary}\n"));

    Ok(HealthReport { score: score as u8, checks, markdown: md })
}

// ─── S3.5 SQLite ↔ SQLite 库对比 ─────────────────────────────────────────────

#[cfg(test)]
mod db_compare_boundary_tests {
    #[tokio::test]
    async fn real_sqlite_dump_and_rescue_keep_legal_sqlite_prefix_table() {
        use sqlx::Connection;
        let root = std::env::temp_dir().join(format!("dbterm-export-prefix-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.db");
        std::fs::File::create(&source).unwrap();
        let config = policy_config(&source, "writable");
        let mut conn = super::admin_conn(&config).await.unwrap();
        sqlx::query("CREATE TABLE sqliteXlegal(v INTEGER); INSERT INTO sqliteXlegal VALUES(17)").execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        let mut evidence = Vec::new();
        for rescue in [false, true] {
            let output = root.join(format!("dump-{rescue}.sql"));
            if rescue { super::rescue_with_config(&config, output.to_string_lossy().into_owned()).await.unwrap(); }
            else { super::dump_sql_with_config(&config, output.to_string_lossy().into_owned(), None).await.unwrap(); }
            let script = std::fs::read_to_string(output).unwrap();
            let mut restored = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
            sqlx::raw_sql(&script).execute(&mut restored).await.unwrap();
            let value = sqlx::query_scalar::<_, i64>("SELECT v FROM sqliteXlegal").fetch_one(&mut restored).await.ok();
            restored.close().await.unwrap(); evidence.push((rescue, value));
        }
        std::fs::remove_dir_all(root).unwrap();
        for (rescue, value) in evidence { assert_eq!(value, Some(17), "rescue={rescue}: legal sqliteX table lost from export"); }
    }

    #[tokio::test]
    async fn real_sqlite_backup_restore_failure_preserves_database_and_output_publication() {
        use sqlx::Connection;
        let root = std::env::temp_dir().join(format!("dbterm-admin-boundaries-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.db");
        let destination = root.join("destination.db");
        for (path, value) in [(&source, 11), (&destination, 7)] {
            std::fs::File::create(path).unwrap();
            let mut conn = super::admin_conn(&policy_config(path, "writable")).await.unwrap();
            sqlx::query(&format!("CREATE TABLE sentinel(v); INSERT INTO sentinel VALUES({value})")).execute(&mut conn).await.unwrap();
            conn.close().await.unwrap();
        }
        let mut src = super::admin_conn(&policy_config(&source, "global")).await.unwrap();
        let mut dst = super::admin_conn(&policy_config(&destination, "writable")).await.unwrap();
        let mut writer = super::admin_conn(&policy_config(&destination, "writable")).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE; UPDATE sentinel SET v=8").execute(&mut writer).await.unwrap();
        let denied = super::copy_sqlite_backup(&mut src, &mut dst).await.is_err();
        sqlx::query("ROLLBACK").execute(&mut writer).await.unwrap();
        let value: i64 = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut dst).await.unwrap();
        writer.close().await.unwrap(); dst.close().await.unwrap(); src.close().await.unwrap();
        let final_path = root.join("race.sql");
        let staging = super::NewSqliteOutput::new(final_path.to_str().unwrap(), source.to_str().unwrap()).unwrap();
        std::fs::write(&staging.staged.path, b"new output").unwrap();
        std::fs::write(&final_path, b"concurrent owner").unwrap();
        assert!(staging.publish().is_err());
        assert_eq!(std::fs::read(&final_path).unwrap(), b"concurrent owner");
        let staged_path = staging.staged.path.clone(); drop(staging);
        assert!(!std::path::Path::new(&staged_path).exists());
        let new_path = root.join("new.sql");
        let success = super::dump_sql_with_config(&policy_config(&source, "global"), new_path.to_string_lossy().into_owned(), None).await;
        let backup = root.join("readonly-backup.db");
        super::vacuum_into_new_file(&policy_config(&source, "global"), backup.to_str().unwrap()).await.unwrap();
        let mut verify = super::admin_conn(&policy_config(&backup, "global")).await.unwrap();
        let backup_value: i64 = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut verify).await.unwrap();
        verify.close().await.unwrap();
        assert_eq!(backup_value, 11);
        let mut sidecar = source.as_os_str().to_os_string(); sidecar.push("-wal");
        assert!(super::NewSqliteOutput::new(std::path::Path::new(&sidecar).to_str().unwrap(), source.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
        assert!(denied); assert_eq!(value, 7); assert!(success.is_ok());
    }

    #[tokio::test]
    async fn real_sqlite_restore_keeps_open_connection_on_same_database() {
        use sqlx::Connection;
        let root = std::env::temp_dir().join(format!("dbterm-restore-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let database = root.join("active.db");
        let backup = root.join("backup.db");
        for (path, value) in [(&database, 7), (&backup, 11)] {
            std::fs::File::create(path).unwrap();
            let mut conn = super::admin_conn(&policy_config(path, "writable")).await.unwrap();
            sqlx::query(&format!("PRAGMA journal_mode=WAL; CREATE TABLE sentinel(v); INSERT INTO sentinel VALUES({value})")).execute(&mut conn).await.unwrap();
            conn.close().await.unwrap();
        }
        let config = policy_config(&database, "writable");
        let mut existing = super::admin_conn(&config).await.unwrap();
        let before: i64 = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut existing).await.unwrap();
        let alias = root.join("source-alias.db");
        std::fs::hard_link(&database, &alias).unwrap();
        let alias_refused = super::restore_backup_with_config(&config, alias.to_string_lossy().into_owned()).await.is_err();
        let archives_before = std::fs::read_dir(&root).unwrap().filter_map(Result::ok).filter(|entry| entry.path().extension().is_some_and(|e| e == "bak")).count();
        let result = super::restore_backup_with_config(&config, backup.to_string_lossy().into_owned()).await;
        let old_view: Result<i64, _> = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut existing).await;
        let mut reopened = super::admin_conn(&config).await.unwrap();
        let new_view: i64 = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut reopened).await.unwrap();
        existing.close().await.unwrap(); reopened.close().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
        result.unwrap();
        assert!(alias_refused, "same-inode source must be refused");
        assert_eq!(archives_before, 0, "alias rejection must happen before archive side effects");
        assert_eq!(before, 7);
        assert_eq!(old_view.unwrap(), 11, "existing connection stayed on renamed original instead of restored database");
        assert_eq!(new_view, 11);
    }

    #[tokio::test]
    async fn real_sqlite_dump_and_rescue_never_overwrite_source_or_existing_output() {
        use sqlx::Connection;
        let root = std::env::temp_dir().join(format!("dbterm-admin-output-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut evidence = Vec::new();
        for rescue in [false, true] {
            for alias in [false, true] {
                let source = root.join(format!("source-{rescue}-{alias}.db"));
                std::fs::File::create(&source).unwrap();
                let config = policy_config(&source, "global");
                let mut writable = config.clone(); writable.read_only = Some(false);
                let mut conn = super::admin_conn(&writable).await.unwrap();
                sqlx::query("CREATE TABLE sentinel(v); INSERT INTO sentinel VALUES('keep')").execute(&mut conn).await.unwrap();
                conn.close().await.unwrap();
                let before = std::fs::read(&source).unwrap();
                let output = root.join(format!("out-{rescue}-{alias}.sql"));
                if alias { std::fs::hard_link(&source, &output).unwrap(); } else { std::fs::write(&output, b"existing output").unwrap(); }
                let output_before = std::fs::read(&output).unwrap();
                let failed = if rescue { super::rescue_with_config(&config, output.to_string_lossy().into_owned()).await.is_err() }
                    else { super::dump_sql_with_config(&config, output.to_string_lossy().into_owned(), None).await.is_err() };
                evidence.push((rescue, alias, failed, before == std::fs::read(&source).unwrap(), output_before == std::fs::read(&output).unwrap()));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
        for (rescue, alias, failed, source_kept, output_kept) in evidence {
            assert!(failed, "rescue={rescue}, alias={alias}: existing output must be rejected");
            assert!(source_kept && output_kept, "rescue={rescue}, alias={alias}: source or existing output overwritten");
        }
    }

    fn policy_config(path: &std::path::Path, mode: &str) -> crate::models::ConnConfig {
        let mut config: crate::models::ConnConfig = serde_json::from_value(serde_json::json!({
            "id":"sqlite-admin-policy","name":"test","type":"sqlite",
            "useSsl":false,"createdAt":0,"updatedAt":0
        })).unwrap();
        config.file_path = Some(path.to_string_lossy().into_owned());
        config.read_only = Some(mode == "global");
        config.extra_json = Some(serde_json::json!({ mode: true }).to_string());
        config
    }

    #[tokio::test]
    async fn real_sqlite_admin_connection_enforces_every_readonly_policy() {
        use sqlx::Connection;
        let path = std::env::temp_dir().join(format!("dbterm-admin-policy-{}.db", uuid::Uuid::new_v4()));
        std::fs::File::create(&path).unwrap();
        let mut setup = super::admin_conn(&policy_config(&path, "writable")).await.unwrap();
        sqlx::query("CREATE TABLE sentinel(v INTEGER); INSERT INTO sentinel VALUES(7)").execute(&mut setup).await.unwrap();
        setup.close().await.unwrap();
        let mut evidence = Vec::new();
        for mode in ["global", "sqliteReadonly", "sqliteImmutable"] {
            let mut conn = super::admin_conn(&policy_config(&path, mode)).await.unwrap();
            let update = sqlx::query("UPDATE sentinel SET v=99").execute(&mut conn).await;
            let temp = sqlx::query("CREATE TEMP TABLE bypass(v)").execute(&mut conn).await;
            let value: i64 = sqlx::query_scalar("SELECT v FROM sentinel").fetch_one(&mut conn).await.unwrap();
            conn.close().await.unwrap();
            evidence.push((mode, update.is_err(), temp.is_err(), value));
        }
        std::fs::remove_file(path).unwrap();
        for (mode, update_blocked, temp_blocked, value) in evidence {
            assert!(update_blocked, "{mode}: maintenance connection bypassed main DB write protection");
            assert!(temp_blocked, "{mode}: maintenance connection bypassed TEMP write protection");
            assert_eq!(value, 7, "{mode}: protected data changed");
        }
    }

    #[tokio::test]
    async fn real_sqlite_compare_keeps_legal_sqlite_prefix_names() {
        use sqlx::{Connection, Executor};
        let root = std::env::temp_dir().join(format!("dbterm-compare-prefix-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let left = root.join("left.sqlite");
        let right = root.join("right.sqlite");
        for (path, kind) in [(&left, "TEXT"), (&right, "INTEGER")] {
            std::fs::File::create(path).unwrap();
            let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}", path.display())).await.unwrap();
            conn.execute(format!("CREATE TABLE sqliteXlegal(value {kind})").as_str()).await.unwrap();
            conn.close().await.unwrap();
        }
        let result = super::sqlite_compare_files(left.to_str().unwrap(), right.to_str().unwrap(), None).await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.ddl_diff.iter().any(|d| d.name == "sqliteXlegal" && d.kind == "changed"), "legal sqliteX table must not be filtered as internal sqlite_ object");
    }

    #[test]
    fn equal_counts_report_never_claims_data_equality_or_generates_sync_sql() {
        let text = super::sqlite_count_only_report(&[("same".into(), 1, 1)]);
        assert!(text.contains("内容未校验"));
        assert!(!text.contains("INSERT"));
        assert!(!text.contains("DELETE"));
        assert!(!text.contains("数据一致"));
    }

    #[tokio::test]
    async fn real_sqlite_equal_count_different_values_is_explicitly_unchecked() {
        use sqlx::{Connection, Executor};
        let root = std::env::temp_dir().join(format!("dbterm-sqlite-compare-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let left = root.join("left.sqlite");
        let right = root.join("right.sqlite");
        for (path, value) in [(&left, 1), (&right, 2)] {
            std::fs::File::create(path).unwrap();
            let mut conn = sqlx::SqliteConnection::connect(&format!("sqlite://{}", path.display())).await.unwrap();
            conn.execute("CREATE TABLE data(id INTEGER PRIMARY KEY, value INTEGER); CREATE INDEX value_index ON data(value)").await.unwrap();
            conn.execute(format!("INSERT INTO data VALUES(1,{value})").as_str()).await.unwrap();
            conn.close().await.unwrap();
        }
        let result = super::sqlite_compare_files(left.to_str().unwrap(), right.to_str().unwrap(), None).await.unwrap();
        assert!(result.ddl_diff.is_empty());
        assert_eq!(result.data_changes, 0);
        assert!(result.data_script.contains("内容未校验"));
        assert!(!result.data_script.contains("INSERT"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn sqlite_count_only_report(rows: &[(String, i64, i64)]) -> String {
    let mut lines = vec!["-- 仅行数比较；内容未校验，不生成同步 SQL。".to_string()];
    for (table, left, right) in rows {
        lines.push(format!("-- 表 {table:?}: 左 {left} 行，右 {right} 行；内容未校验"));
    }
    lines.join("\n")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDiffResult {
    pub ddl_diff: Vec<DdlDiffEntry>,
    pub data_script: String,
    pub data_changes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlDiffEntry {
    pub kind: String,   // "added" | "removed" | "changed"
    pub name: String,
    pub obj_type: String,
    pub left_sql: Option<String>,
    pub right_sql: Option<String>,
}

#[tauri::command]
pub async fn sqlite_db_diff(
    left_id: String,
    right_id: String,
    tables: Option<Vec<String>>,
    storage: State<'_, StorageState>,
) -> Result<DbDiffResult, String> {
    let left_cfg = load_config(&storage, &left_id)?;
    let right_cfg = load_config(&storage, &right_id)?;
    if left_cfg.conn_type != crate::models::ConnType::Sqlite || right_cfg.conn_type != crate::models::ConnType::Sqlite { return Err("仅支持 SQLite 文件连接对比".into()); }

    let left_path = left_cfg.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "左侧 SQLite 文件路径不能为空".to_string())?;
    let right_path = right_cfg.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "右侧 SQLite 文件路径不能为空".to_string())?;
    sqlite_compare_files(left_path, right_path, tables).await
}

async fn sqlite_compare_files(left_path: &str, right_path: &str, tables: Option<Vec<String>>) -> Result<DbDiffResult, String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Row};
    use std::str::FromStr;

    // Open left as main, attach right as 'rdb'
    let left_url = format!("sqlite://{}?mode=ro", left_path);
    let opts = SqliteConnectOptions::from_str(&left_url)
        .map_err(|e| format!("URL 解析失败: {e}"))?
        .busy_timeout(std::time::Duration::from_secs(10))
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("打开左库失败: {e}"))?;

    if !std::path::Path::new(right_path).is_file() { return Err("右侧 SQLite 文件不存在，已拒绝对比".into()); }
    sqlx::query("PRAGMA query_only=ON").execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("ATTACH DATABASE ? AS rdb").bind(right_path).execute(&mut conn).await.map_err(|e| format!("ATTACH 右库失败: {e}"))?;
    sqlx::query("BEGIN").execute(&mut conn).await.map_err(|e| format!("开启对比快照失败: {e}"))?;
    sqlx::query("SELECT (SELECT COUNT(*) FROM main.sqlite_master),(SELECT COUNT(*) FROM rdb.sqlite_master)").fetch_one(&mut conn).await.map_err(|e| format!("固定对比读取快照失败: {e}"))?;

    // ── DDL diff ──────────────────────────────────────────────────────────────
    let left_objs = sqlx::query(
        "SELECT type, name, sql FROM main.sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type, name"
    ).fetch_all(&mut conn).await.map_err(|e| format!("读取左库对象失败: {e}"))?;

    let right_objs = sqlx::query(
        "SELECT type, name, sql FROM rdb.sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type, name"
    ).fetch_all(&mut conn).await.map_err(|e| format!("读取右库对象失败: {e}"))?;

    let mut left_map: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
    for row in &left_objs {
        let ty: String = row.try_get(0).map_err(|e| format!("解析对象类型失败: {e}"))?;
        let name: String = row.try_get(1).map_err(|e| format!("解析对象名称失败: {e}"))?;
        let sql: String = row.try_get(2).map_err(|e| format!("解析对象定义失败: {e}"))?;
        left_map.insert(format!("{ty}::{name}"), (ty, sql));
    }
    let mut right_map: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
    for row in &right_objs {
        let ty: String = row.try_get(0).map_err(|e| format!("解析对象类型失败: {e}"))?;
        let name: String = row.try_get(1).map_err(|e| format!("解析对象名称失败: {e}"))?;
        let sql: String = row.try_get(2).map_err(|e| format!("解析对象定义失败: {e}"))?;
        right_map.insert(format!("{ty}::{name}"), (ty, sql));
    }

    let mut ddl_diff: Vec<DdlDiffEntry> = Vec::new();
    for (key, (ty, lsql)) in &left_map {
        let name = key.splitn(2, "::").nth(1).unwrap_or("").to_string();
        match right_map.get(key) {
            None => ddl_diff.push(DdlDiffEntry { kind: "removed".into(), name, obj_type: ty.clone(), left_sql: Some(lsql.clone()), right_sql: None }),
            Some((_, rsql)) if lsql != rsql => ddl_diff.push(DdlDiffEntry { kind: "changed".into(), name, obj_type: ty.clone(), left_sql: Some(lsql.clone()), right_sql: Some(rsql.clone()) }),
            _ => {}
        }
    }
    for (key, (ty, rsql)) in &right_map {
        if !left_map.contains_key(key) {
            let name = key.splitn(2, "::").nth(1).unwrap_or("").to_string();
            ddl_diff.push(DdlDiffEntry { kind: "added".into(), name, obj_type: ty.clone(), left_sql: None, right_sql: Some(rsql.clone()) });
        }
    }

    // ── Data diff (tables only, by rowid or first PK) ─────────────────────────
    let target_tables: Vec<String> = if let Some(t) = tables.as_ref() {
        t.clone()
    } else {
        left_map.iter()
            .filter(|(k, (ty, _))| ty == "table" && right_map.contains_key(*k))
            .map(|(k, _)| k.splitn(2, "::").nth(1).unwrap_or("").to_string())
            .collect()
    };

    let mut counts = Vec::new();
    let mut data_changes = 0u64;
    for table in &target_tables {
        let quoted = table.replace('"', "\"\"");
        let (left, right): (i64, i64) = sqlx::query_as(&format!("SELECT (SELECT COUNT(*) FROM main.\"{quoted}\"),(SELECT COUNT(*) FROM rdb.\"{quoted}\")"))
            .fetch_one(&mut conn).await.map_err(|e| format!("读取表 {table} 行数失败，未生成完整报告: {e}"))?;
        data_changes = data_changes.saturating_add(left.abs_diff(right));
        counts.push((table.clone(), left, right));
    }
    let data_script = sqlite_count_only_report(&counts);
    sqlx::query("ROLLBACK").execute(&mut conn).await.map_err(|e| format!("结束对比快照失败: {e}"))?;

    let _ = sqlx::query("DETACH DATABASE rdb").execute(&mut conn).await;

    Ok(DbDiffResult {
        ddl_diff,
        data_script,
        data_changes,
    })
}

// ─── S3.4 损坏库抢救 ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescueResult {
    pub out_path: String,
    pub tables_attempted: usize,
    pub tables_rescued: usize,
    pub rows_rescued: u64,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn sqlite_rescue(
    id: String,
    out_path: String,
    storage: State<'_, StorageState>,
) -> Result<RescueResult, String> {
    let config = load_config(&storage, &id)?;
    rescue_with_config(&config, out_path).await
}

async fn rescue_with_config(config: &ConnConfig, out_path: String) -> Result<RescueResult, String> {
    let result = export_sqlite_file(config, &out_path, None, true).await?;
    Ok(RescueResult { out_path, tables_attempted: result.attempted, tables_rescued: result.tables, rows_rescued: result.rows, errors: result.errors })
}

// ─── S3.2 整库 SQL dump ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpResult {
    pub path: String,
    pub size_bytes: u64,
    pub table_count: usize,
    pub row_count: u64,
}

// ─── S4.6 脱敏规则 ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskingRule {
    pub table: String,
    pub column: String,
    pub rule: String, // "phone" | "email" | "mask" | "hash" | "null"
}

fn apply_mask(val: &str, rule: &str) -> String {
    match rule {
        "null" => "NULL".to_string(),
        "mask" => "'***'".to_string(),
        "hash" => {
            // Simple FNV-1a hash as hex (no crypto dep)
            let mut h: u64 = 14695981039346656037;
            for b in val.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(1099511628211);
            }
            format!("'{h:016x}'")
        }
        "phone" => {
            // 按字符切片，避免多字节字符（中文等）落在字节边界中间触发 panic
            let chars: Vec<char> = val.chars().collect();
            if chars.len() >= 7 {
                let prefix: String = chars.iter().take(3).collect();
                let suffix: String = chars.iter().skip(chars.len() - 4).collect();
                format!("'{}'", format!("{prefix}****{suffix}").replace('\'', "''"))
            } else {
                "'***'".to_string()
            }
        }
        "email" => {
            if let Some(at) = val.find('@') {
                let user = &val[..at];
                let domain = &val[at..];
                let uc: Vec<char> = user.chars().collect();
                let masked_user = if uc.len() <= 2 { "*".repeat(uc.len()) }
                    else { format!("{}***", uc.iter().take(2).collect::<String>()) };
                format!("'{}'", format!("{masked_user}{domain}").replace('\'', "''"))
            } else {
                "'***'".to_string()
            }
        }
        _ => format!("'{}'", val.replace('\'', "''")),
    }
}

#[tauri::command]
pub async fn sqlite_dump_sql(
    id: String,
    out_path: String,
    masking_rules: Option<Vec<MaskingRule>>,
    storage: State<'_, StorageState>,
) -> Result<DumpResult, String> {
    let config = load_config(&storage, &id)?;
    dump_sql_with_config(&config, out_path, masking_rules).await
}

async fn dump_sql_with_config(config: &ConnConfig, out_path: String, masking_rules: Option<Vec<MaskingRule>>) -> Result<DumpResult, String> {
    let result = export_sqlite_file(config, &out_path, masking_rules.as_deref(), false).await?;
    let size_bytes = std::fs::metadata(&out_path).map_err(|e| e.to_string())?.len();
    Ok(DumpResult { path: out_path, size_bytes, table_count: result.tables, row_count: result.rows })
}

struct SqliteFileExport { attempted: usize, tables: usize, rows: u64, errors: Vec<String> }

async fn export_sqlite_file(config: &ConnConfig, out_path: &str, masking: Option<&[MaskingRule]>, rescue: bool) -> Result<SqliteFileExport, String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Connection, Row};
    use futures::TryStreamExt;
    use std::{io::Write, str::FromStr};
    let source = config.file_path.as_deref().ok_or("SQLite 文件路径不能为空")?;
    let mut conn = SqliteConnectOptions::from_str(&super::query::sqlite_url(config)?).map_err(|e| e.to_string())?
        .read_only(true).busy_timeout(std::time::Duration::from_secs(10)).log_statements(log::LevelFilter::Off).connect().await.map_err(|e| e.to_string())?;
    // One read transaction covers sqlite_master, every table and sequence.
    let mut snapshot = conn.begin().await.map_err(|e| e.to_string())?;
    let objects = sqlx::query("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY rowid")
        .fetch_all(&mut *snapshot).await.map_err(|e| e.to_string())?;
    let table_kinds = sqlx::query("PRAGMA main.table_list").fetch_all(&mut *snapshot).await.map_err(|e| format!("无法识别虚拟表及影子表，已停止导出: {e}"))?;
    if table_kinds.is_empty() { return Err("SQLite 版本缺少 table_list，无法安全识别影子表".into()); }
    let shadows: std::collections::HashSet<String> = table_kinds.iter().filter(|r| r.try_get::<String,_>(2).ok().as_deref() == Some("shadow")).filter_map(|r| r.try_get(1).ok()).collect();
    let output = NewSqliteOutput::new(out_path, source)?;
    let file = std::fs::OpenOptions::new().write(true).open(&output.staged.path).map_err(|e| e.to_string())?;
    let mut buf = std::io::BufWriter::new(file);
    writeln!(buf, "-- SQLite {} by DBTerm\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;", if rescue { "rescue (check reported errors)" } else { "dump" }).map_err(|e| e.to_string())?;
    let mut result = SqliteFileExport { attempted: 0, tables: 0, rows: 0, errors: vec![] };
    // Recreate tables first. Triggers/indexes/views are replayed only after data.
    for object in &objects {
        let kind: String = object.try_get(0).map_err(|e| e.to_string())?;
        let name: String = object.try_get(1).map_err(|e| e.to_string())?;
        if kind != "table" || shadows.contains(&name) { continue; }
        let ddl: String = object.try_get(2).map_err(|e| e.to_string())?;
        writeln!(buf, "{ddl};").map_err(|e| e.to_string())?;
    }
    for object in &objects {
        let kind: String = object.try_get(0).map_err(|e| e.to_string())?;
        let name: String = object.try_get(1).map_err(|e| e.to_string())?;
        if kind != "table" || shadows.contains(&name) { continue; }
        result.attempted += 1;
        let table_result: Result<u64,String> = async {
            let table = q_dq_s(&name);
            let ddl: String = object.try_get(2).map_err(|e| e.to_string())?;
            let definition = ddl.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
            if definition.contains("usingfts") && ["content=''", "content=\"\""].iter().any(|option| definition.contains(option)) {
                return Err("无内容 FTS 表不能通过可见字段还原词项索引；请使用数据库文件备份".into());
            }
            let metadata = sqlx::query(&format!("PRAGMA table_xinfo({table})")).fetch_all(&mut *snapshot).await.map_err(|e| e.to_string())?;
            let mut names: Vec<String> = metadata.iter().filter(|r| r.try_get::<i64,_>(6).ok() == Some(0)).map(|r| r.try_get(1).map_err(|e| e.to_string())).collect::<Result<_,_>>()?;
            if names.is_empty() { return Err("没有可安全写入的普通字段".into()); }
            // Preserve anonymous rowids (including FTS rowids) when addressable.
            let virtual_table = table_kinds.iter().any(|r| r.try_get::<String,_>(1).ok().as_deref() == Some(name.as_str()) && r.try_get::<String,_>(2).ok().as_deref() == Some("virtual"));
            let without_rowid = table_kinds.iter().any(|r| r.try_get::<String,_>(1).ok().as_deref() == Some(name.as_str()) && r.try_get::<i64,_>(4).ok() == Some(1));
            if !without_rowid {
                if let Some(alias) = ["rowid", "_rowid_", "oid"].into_iter().find(|alias| !metadata.iter().any(|r| r.try_get::<String,_>(1).is_ok_and(|name| name.eq_ignore_ascii_case(alias)))) {
                    // Virtual modules may expose their own rowid; failure is explicit.
                    names.insert(0, alias.into());
                } else if virtual_table { return Err("虚拟表 rowid 无法无损读取".into()); }
            }
            let columns = names.iter().map(|n| q_dq_s(n)).collect::<Vec<_>>().join(",");
            let sql = format!("SELECT {columns} FROM {table}");
            let mut stream = sqlx::query(&sql).fetch(&mut *snapshot);
            let mut count = 0;
            while let Some(row) = stream.try_next().await.map_err(|e| e.to_string())? {
                let mut values = Vec::with_capacity(names.len());
                for (index,column) in names.iter().enumerate() {
                    let raw = dump_value(&row,index)?;
                    let value = if let Some(rule) = masking.and_then(|rules| rules.iter().find(|r| r.table.eq_ignore_ascii_case(&name) && r.column.eq_ignore_ascii_case(column))) {
                        use sqlx::ValueRef;
                        if row.try_get_raw(index).map_err(|e| e.to_string())?.is_null() { raw }
                        else if let Ok(text) = row.try_get::<String,_>(index) { apply_mask(&text,&rule.rule) }
                        else if rule.rule == "null" { "NULL".into() } else { return Err(format!("字段 {column} 不是文本，无法应用指定脱敏规则")); }
                    } else { raw };
                    values.push(value);
                }
                writeln!(buf, "INSERT INTO {table}({columns}) VALUES({});", values.join(",")).map_err(|e| e.to_string())?; count += 1;
            }
            Ok(count)
        }.await;
        match table_result {
            Ok(count) => { result.tables += 1; result.rows += count; },
            Err(error) if rescue => {
                let error = format!("{name:?}: {error}");
                writeln!(buf, "-- Rescue incomplete: {}", error.replace(['\n','\r'], " " )).map_err(|e| e.to_string())?;
                if result.errors.len() < 100 { result.errors.push(error); }
            },
            Err(error) => return Err(format!("导出表 {name:?} 失败，未发布文件: {error}")),
        }
    }
    let has_sequence: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence'").fetch_one(&mut *snapshot).await.map_err(|e| e.to_string())?;
    if has_sequence != 0 {
        writeln!(buf, "DELETE FROM sqlite_sequence;").map_err(|e| e.to_string())?;
        let rows = sqlx::query("SELECT name,seq FROM sqlite_sequence").fetch_all(&mut *snapshot).await.map_err(|e| e.to_string())?;
        for row in rows { writeln!(buf, "INSERT INTO sqlite_sequence(name,seq) VALUES({},{});", dump_value(&row,0)?, dump_value(&row,1)?).map_err(|e| e.to_string())?; }
    }
    for object in &objects {
        let kind: String = object.try_get(0).map_err(|e| e.to_string())?;
        if kind == "table" { continue; }
        let ddl: String = object.try_get(2).map_err(|e| e.to_string())?;
        writeln!(buf, "{ddl};").map_err(|e| e.to_string())?;
    }
    writeln!(buf, "COMMIT;").map_err(|e| e.to_string())?;
    buf.flush().map_err(|e| e.to_string())?; drop(buf);
    snapshot.commit().await.map_err(|e| e.to_string())?;
    output.publish()?; Ok(result)
}

fn dump_value(row: &sqlx::sqlite::SqliteRow, idx: usize) -> Result<String,String> {
    use sqlx::{Row, TypeInfo, ValueRef};
    let value = row.try_get_raw(idx).map_err(|e| e.to_string())?;
    if value.is_null() { return Ok("NULL".into()); }
    match value.type_info().name() {
        "INTEGER" | "INT" => row.try_get::<i64,_>(idx).map(|v|v.to_string()).map_err(|e|e.to_string()),
        "REAL" => row.try_get::<f64,_>(idx).map(|v| if v == f64::INFINITY { "9e999".into() } else if v == f64::NEG_INFINITY { "-9e999".into() } else { format!("{v:?}") }).map_err(|e|e.to_string()),
        "BLOB" => row.try_get::<Vec<u8>,_>(idx).map(|v|format!("X'{}'",hex::encode(v))).map_err(|e|e.to_string()),
        _ => row.try_get_unchecked::<Vec<u8>,_>(idx).map(|v| format!("CAST(X'{}' AS TEXT)",hex::encode(v))).map_err(|e|format!("无法无损读取字段: {e}")),
    }
}

#[cfg(test)]
#[path = "export_safety_tests.rs"]
mod export_safety_tests;

// ─── S0.3 ATTACH / DETACH 多库 ───────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedDb {
    pub alias: String,
    pub path: String,
}

#[tauri::command]
pub async fn sqlite_attach(
    id: String,
    alias: String,
    path: String,
    attach_map: State<'_, SqliteAttachMap>,
) -> Result<(), String> {
    // 校验 alias 只含字母数字下划线（防止 SQL 注入于 ATTACH 语句）
    if alias.is_empty() || !alias.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("数据库别名只能包含字母、数字和下划线".to_string());
    }
    // 校验目标文件是 SQLite 数据库（读魔数）
    let magic = b"SQLite format 3\0";
    let mut header = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open(&path) {
        use std::io::Read;
        if !f.read_exact(&mut header).is_ok() || &header != magic {
            return Err("目标文件不是有效的 SQLite 数据库".to_string());
        }
    } else {
        return Err(format!("无法打开文件: {path}"));
    }
    let mut map = attach_map.lock().unwrap();
    let list = map.entry(id).or_default();
    if list.iter().any(|(a, _)| a == &alias) {
        return Err(format!("别名 '{alias}' 已被使用，请先 DETACH"));
    }
    list.push((alias, path));
    Ok(())
}

#[tauri::command]
pub async fn sqlite_detach(
    id: String,
    alias: String,
    attach_map: State<'_, SqliteAttachMap>,
) -> Result<(), String> {
    let mut map = attach_map.lock().unwrap();
    if let Some(list) = map.get_mut(&id) {
        list.retain(|(a, _)| a != &alias);
    }
    Ok(())
}

#[tauri::command]
pub async fn sqlite_list_attached(
    id: String,
    attach_map: State<'_, SqliteAttachMap>,
) -> Result<Vec<AttachedDb>, String> {
    let list = attach_map.lock().unwrap().get(&id).cloned().unwrap_or_default();
    Ok(list.into_iter().map(|(alias, path)| AttachedDb { alias, path }).collect())
}

// ─── S1.7 ALTER TABLE 向导（SQLite 方言）────────────────────────────────────
#[path = "sqlite_alter_plan.rs"]
mod sqlite_alter_plan;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterColDef {
    pub original_name: Option<String>, // None = 新列
    pub new_name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: String,
    pub is_deleted: bool,
    pub is_primary_key: bool,
    pub generated_expr: String, // 生成列表达式，空=普通列
    pub generated_stored: bool, // true=STORED, false=VIRTUAL
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterTablePreview {
    pub kind: String,    // "simple" | "rebuild"
    pub sql_script: String,
}

fn q_dq_s(s: &str) -> String { format!("\"{}\"", s.replace('"', "\"\"")) }

// SQLite live metadata guard for native ALTER and rebuild.
async fn classify_changes(conn: &mut sqlx::sqlite::SqliteConnection, table: &str, cols: &[AlterColDef]) -> Result<&'static str, String> {
    sqlite_alter_plan::verify_change_set(conn, table, cols).await
}

async fn get_table_indexes_triggers(
    conn: &mut sqlx::sqlite::SqliteConnection,
    table: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>), String> {
    use sqlx::Row;
    // Indexes (non-autoindex)
    let idx_rows = sqlx::query(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? \
         AND sql IS NOT NULL"
    ).bind(table).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询索引失败: {e}"))?;
    let indexes: Vec<String> = idx_rows.iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect();

    // Triggers
    let trig_rows = sqlx::query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?"
    ).bind(table).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询触发器失败: {e}"))?;
    let triggers: Vec<String> = trig_rows.iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect();

    // Views that reference this table (for warning, not automatic rebuild)
    let view_rows = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type='view' AND sql LIKE ?"
    ).bind(format!("%{}%", table)).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询视图失败: {e}"))?;
    let views: Vec<String> = view_rows.iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect();

    Ok((indexes, triggers, views))
}

fn col_def_sql(col: &AlterColDef) -> String {
    let name = q_dq_s(&col.new_name);
    let dtype = if col.data_type.is_empty() { "TEXT".to_string() } else { col.data_type.clone() };
    if !col.generated_expr.is_empty() {
        let stored = if col.generated_stored { "STORED" } else { "VIRTUAL" };
        return format!("{name} {dtype} GENERATED ALWAYS AS ({}) {stored}", col.generated_expr);
    }
    let mut s = format!("{name} {dtype}");
    if !col.nullable { s.push_str(" NOT NULL"); }
    if !col.default_value.is_empty() {
        s.push_str(&format!(" DEFAULT {}", col.default_value));
    }
    s
}

pub async fn build_rebuild_script(
    conn: &mut sqlx::sqlite::SqliteConnection,
    table: &str,
    cols: &[AlterColDef],
) -> Result<String, String> {
    sqlite_alter_plan::build_rebuild_script(conn, table, cols).await
}

#[tauri::command]
pub async fn sqlite_alter_table_preview(
    id: String,
    table: String,
    cols: Vec<AlterColDef>,
    storage: State<'_, StorageState>,
) -> Result<AlterTablePreview, String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;

    let config = load_config(&storage, &id)?;
    let url = sqlite_url(&config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("URL 解析失败: {e}"))?
        .busy_timeout(std::time::Duration::from_secs(5))
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("连接失败: {e}"))?;

    // Determine if simple or rebuild
    let kind = classify_changes(&mut conn, &table, &cols).await?;
    let sql_script = if kind == "simple" {
        build_simple_alter_sql(&table, &cols)
    } else {
        build_rebuild_script(&mut conn, &table, &cols).await?
    };

    Ok(AlterTablePreview { kind: kind.to_string(), sql_script })
}

fn build_simple_alter_sql(table: &str, cols: &[AlterColDef]) -> String {
    let tq = q_dq_s(table);
    let mut parts = Vec::new();
    for col in cols {
        if col.is_deleted {
            if let Some(orig) = &col.original_name {
                parts.push(format!("ALTER TABLE {tq} DROP COLUMN {};", q_dq_s(orig)));
            }
        } else if col.original_name.is_none() {
            // New column
            parts.push(format!("ALTER TABLE {tq} ADD COLUMN {};", col_def_sql(col)));
        } else if let Some(orig) = &col.original_name {
            if orig != &col.new_name {
                parts.push(format!("ALTER TABLE {tq} RENAME COLUMN {} TO {};",
                    q_dq_s(orig), q_dq_s(&col.new_name)));
            }
        }
    }
    if parts.is_empty() { "-- 无变更".to_string() } else { parts.join("\n") }
}

#[tauri::command]
pub async fn sqlite_alter_table_execute(
    id: String,
    table: String,
    cols: Vec<AlterColDef>,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    use std::str::FromStr;

    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    let url = sqlite_url(&config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("URL 解析失败: {e}"))?
        .busy_timeout(std::time::Duration::from_secs(30))
        .log_statements(log::LevelFilter::Off);
    let mut conn = opts.connect().await.map_err(|e| format!("连接失败: {e}"))?;

    execute_column_changes(&mut conn, &table, &cols).await
}

async fn execute_column_changes(conn: &mut sqlx::SqliteConnection, table: &str, cols: &[AlterColDef]) -> Result<String, String> {
    use sqlx::Connection;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let action = async {
        // The write reservation precedes metadata classification and planning.
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(|e| e.to_string())?;
        let result = async {
            let kind = classify_changes(&mut tx, table, cols).await?;
            if kind == "simple" {
                let script = build_simple_alter_sql(table, cols);
                if script == "-- 无变更" { return Ok("无变更".to_string()); }
                alter_execute::simple(&mut tx, &script).await?;
            } else {
                let script = build_rebuild_script(&mut tx, table, cols).await?;
                execute_rebuild_script(&mut tx, &script).await?;
            }
            Ok::<String, String>(kind.to_string())
        }.await;
        match result {
            Ok(kind) => { tx.commit().await.map_err(|e| format!("提交结果未确认，请核实数据库状态，勿盲目重试: {e}"))?; Ok(kind) },
            Err(error) => { tx.rollback().await.map_err(|rollback| format!("{error}；回滚未确认: {rollback}"))?; Err(error) },
        }
    }.await;
    let restored = sqlx::query(if foreign_keys == 0 { "PRAGMA foreign_keys=OFF" } else { "PRAGMA foreign_keys=ON" }).execute(&mut *conn).await;
    match (action, restored) {
        (result, Ok(_)) => result,
        (result, Err(error)) => Err(format!("{}；恢复外键设置失败: {error}", result.err().unwrap_or_else(|| "结构修改已提交".into()))),
    }
}

#[cfg(test)]
#[path = "sqlite_alter_atomicity_tests.rs"]
mod sqlite_alter_atomicity_tests;

#[path = "sqlite_alter_execute.rs"]
mod alter_execute;

async fn execute_rebuild_script(conn: &mut sqlx::SqliteConnection, script: &str) -> Result<(), String> {
    alter_execute::rebuild(conn, script).await
}

// ── 可选增强 S1.6: EXPLAIN 字节码视图 ────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteOpcode {
    pub addr: i64,
    pub opcode: String,
    pub p1: i64,
    pub p2: i64,
    pub p3: i64,
    pub p4: String,
    pub p5: String,
    pub comment: String,
}

/// S1.6: EXPLAIN <sql> 完整 opcode 字节码表格（只读分析，不执行）
#[tauri::command]
pub async fn sqlite_explain_bytecode(
    id: String,
    sql: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<SqliteOpcode>, String> {
    use sqlx::Row;
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    let config = load_config(&storage, &id)?;
    // 打开只读连接，确保 EXPLAIN 不产生副作用
    let mut conn = {
        use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
        let path = config.file_path.as_deref().filter(|s| !s.is_empty())
            .ok_or_else(|| "SQLite 文件路径不能为空".to_string())?;
        // 用 SqliteConnectOptions::filename + .read_only(true) 真正只读打开
        // （sqlx 不解析 URL 里的 ?mode=ro 查询参数，须用 API）
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .log_statements(log::LevelFilter::Off);
        opts.connect().await.map_err(|e| format!("打开失败: {e}"))?
    };

    let explain_sql = format!("EXPLAIN {}", sql.trim_end_matches(';'));
    let rows = sqlx::query(&explain_sql)
        .fetch_all(&mut conn)
        .await
        .map_err(|e| format!("EXPLAIN 执行失败: {e}"))?;

    Ok(rows.iter().map(|r| SqliteOpcode {
        addr:    r.try_get::<i64, _>(0).unwrap_or(0),
        opcode:  r.try_get::<String, _>(1).unwrap_or_default(),
        p1:      r.try_get::<i64, _>(2).unwrap_or(0),
        p2:      r.try_get::<i64, _>(3).unwrap_or(0),
        p3:      r.try_get::<i64, _>(4).unwrap_or(0),
        p4:      r.try_get::<String, _>(5).unwrap_or_default(),
        p5:      r.try_get::<String, _>(6).unwrap_or_default(),
        comment: r.try_get::<String, _>(7).unwrap_or_default(),
    }).collect())
}

// ── 可选增强 S2.5: sqlite_sequence 管理 ──────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteSequenceEntry {
    pub table_name: String,
    pub seq: i64,
}

/// S2.5: 查看 sqlite_sequence 表（AUTOINCREMENT 计数器）
/// 只在使用 AUTOINCREMENT 关键字的表中存在，WITHOUT ROWID 表不出现
#[tauri::command]
pub async fn sqlite_sequence_list(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<SqliteSequenceEntry>, String> {
    use sqlx::Row;
    let config = load_config(&storage, &id)?;
    let mut conn = admin_conn(&config).await?;

    // sqlite_sequence 仅在含 AUTOINCREMENT 列的库中存在
    let rows = match sqlx::query("SELECT name, seq FROM sqlite_sequence ORDER BY name")
        .fetch_all(&mut conn).await
    {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("no such table") {
                return Ok(vec![]); // 无 AUTOINCREMENT 表的库
            }
            return Err(format!("查询 sqlite_sequence 失败: {e}"));
        }
    };

    Ok(rows.iter().map(|r| SqliteSequenceEntry {
        table_name: r.try_get::<String, _>(0).unwrap_or_default(),
        seq:        r.try_get::<i64, _>(1).unwrap_or(0),
    }).collect())
}

/// S2.5: 重置 AUTOINCREMENT 计数器（强确认由前端保证，危险操作）
/// new_seq = -1 表示删除该行（下次插入从 max(rowid)+1 开始）
#[tauri::command]
pub async fn sqlite_sequence_reset(
    id: String,
    table_name: String,
    new_seq: i64,
    storage: State<'_, StorageState>,
) -> Result<(), String> {
    if table_name.is_empty() {
        return Err("表名不能为空".to_string());
    }
    let config = load_config(&storage, &id)?;
    require_admin_write(&config)?;
    // 只读模式禁止重置
    if config.read_only == Some(true) {
        return Err("只读模式下不允许修改 sqlite_sequence".to_string());
    }
    let mut conn = admin_conn(&config).await?;

    // 先确认表存在于 sqlite_sequence
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT seq FROM sqlite_sequence WHERE name = ?"
    ).bind(&table_name).fetch_optional(&mut conn).await
        .map_err(|e| format!("查询失败: {e}"))?;

    if exists.is_none() {
        return Err(format!("表 {table_name} 不在 sqlite_sequence 中（未使用 AUTOINCREMENT）"));
    }

    if new_seq < 0 {
        // 删除行：下次 INSERT 从 max(existing rowid)+1 开始，等效于"重置为自然值"
        sqlx::query("DELETE FROM sqlite_sequence WHERE name = ?")
            .bind(&table_name).execute(&mut conn).await
            .map_err(|e| format!("删除 sqlite_sequence 行失败: {e}"))?;
    } else {
        sqlx::query("UPDATE sqlite_sequence SET seq = ? WHERE name = ?")
            .bind(new_seq).bind(&table_name).execute(&mut conn).await
            .map_err(|e| format!("重置 sqlite_sequence 失败: {e}"))?;
    }
    Ok(())
}

// ── S0 文件外部变更监控 ────────────────────────────────────────────────────────

/// 开始监控 SQLite 库文件（及 -wal）外部变更，变更时向前端发 `sqlite-file-changed` 事件（payload=连接 ID）。
/// 幂等：重复调用会替换旧 watcher。
#[tauri::command]
pub fn sqlite_watch_start(
    id: String,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
    watchers: State<'_, SqliteWatcherMap>,
) -> Result<(), String> {
    use notify::{Watcher, RecursiveMode, Event};
    use tauri::Emitter;
    use std::path::Path;

    let config = load_config(&storage, &id)?;
    let path = config.file_path.as_deref().filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 文件路径为空".to_string())?
        .to_string();
    if !Path::new(&path).exists() {
        return Err("SQLite 文件不存在".to_string());
    }

    let app2 = app.clone();
    let id2 = id.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(ev) = res {
            // 仅在写入/创建/删除类事件时通知（忽略纯访问事件）
            if ev.kind.is_modify() || ev.kind.is_create() || ev.kind.is_remove() {
                let _ = app2.emit("sqlite-file-changed", &id2);
            }
        }
    }).map_err(|e| format!("创建文件监控失败: {e}"))?;

    // 监控库文件本身
    watcher.watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("监控库文件失败: {e}"))?;
    // 监控 -wal（WAL 模式下写入主要落在 wal）；不存在则忽略错误
    let wal = format!("{path}-wal");
    if Path::new(&wal).exists() {
        let _ = watcher.watch(Path::new(&wal), RecursiveMode::NonRecursive);
    }

    watchers.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(id, watcher);
    Ok(())
}

/// 停止监控（drop watcher）
#[tauri::command]
pub fn sqlite_watch_stop(
    id: String,
    watchers: State<'_, SqliteWatcherMap>,
) -> Result<(), String> {
    watchers.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
    Ok(())
}
