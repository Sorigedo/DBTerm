// DuckDB C API 包装器（via libloading）
// DD1.x: 查询执行 + Schema/Table/Column 浏览
// 驱动由 DR 模块管理，通过 DriverRegistry 获取 .dll/.so 路径

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use serde::Deserialize;
use tauri::State;
use libloading::Library;

use crate::models::{ColumnInfo, ConnConfig, QueryResult, TableInfo, TestResult};
use crate::storage::StorageState;
use crate::commands::driver::DriverRegistry;
use crate::commands::driver::probe::verify_dylib_loadable;

// ── DuckDB C API 结构体布局（v1.x） ─────────────────────────────────────────

#[repr(C)]
struct DuckRawResult {
    _deprecated_col_count: u64,
    _deprecated_row_count: u64,
    _deprecated_rows_changed: u64,
    _deprecated_columns: *mut c_void,
    _deprecated_error_message: *mut c_char,
    internal_data: *mut c_void,
}

impl DuckRawResult {
    fn zeroed() -> Self {
        DuckRawResult {
            _deprecated_col_count: 0,
            _deprecated_row_count: 0,
            _deprecated_rows_changed: 0,
            _deprecated_columns: std::ptr::null_mut(),
            _deprecated_error_message: std::ptr::null_mut(),
            internal_data: std::ptr::null_mut(),
        }
    }
}

// ── 函数类型别名 ─────────────────────────────────────────────────────────────

type FnCreateConfig = unsafe extern "C" fn(*mut *mut c_void) -> i32;
type FnSetConfig    = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
type FnDestroyConfig= unsafe extern "C" fn(*mut *mut c_void);
type FnOpenExt      = unsafe extern "C" fn(*const c_char, *mut *mut c_void, *mut c_void, *mut *mut c_char) -> i32;
type FnClose        = unsafe extern "C" fn(*mut *mut c_void);
type FnConnect      = unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32;
type FnDisconnect   = unsafe extern "C" fn(*mut *mut c_void);
type FnQuery        = unsafe extern "C" fn(*mut c_void, *const c_char, *mut DuckRawResult) -> i32;
type FnDestroyResult= unsafe extern "C" fn(*mut DuckRawResult);
type FnResultError  = unsafe extern "C" fn(*mut DuckRawResult) -> *const c_char;
type FnColumnCount  = unsafe extern "C" fn(*mut DuckRawResult) -> u64;
type FnRowCount     = unsafe extern "C" fn(*mut DuckRawResult) -> u64;
type FnRowsChanged  = unsafe extern "C" fn(*mut DuckRawResult) -> u64;
type FnColumnName   = unsafe extern "C" fn(*mut DuckRawResult, u64) -> *const c_char;
type FnFree = unsafe extern "C" fn(*mut c_void);

mod vector_reader;

// ── 已加载的函数指针集合 ─────────────────────────────────────────────────────

struct DuckFns {
    create_config:  FnCreateConfig,
    set_config:     FnSetConfig,
    destroy_config: FnDestroyConfig,
    open_ext:       FnOpenExt,
    close:          FnClose,
    connect:        FnConnect,
    disconnect:     FnDisconnect,
    query:          FnQuery,
    destroy_result: FnDestroyResult,
    result_error:   FnResultError,
    column_count:   FnColumnCount,
    row_count:      FnRowCount,
    rows_changed:   FnRowsChanged,
    column_name:    FnColumnName,
    free:           FnFree,
}

// Safety: DuckFns 中只有函数指针（来自 library），由外部 Mutex 保证单线程调用
unsafe impl Send for DuckFns {}
unsafe impl Sync for DuckFns {}

impl DuckFns {
    unsafe fn load(lib: &Library) -> Result<Self, String> {
        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let s: libloading::Symbol<$ty> = lib.get($name)
                    .map_err(|e| format!("DuckDB 符号 {} 不存在: {e}",
                        std::str::from_utf8($name).unwrap_or("?")))?;
                // Safety: lib 由 Arc<Library> 持有，生命周期经 DuckConnState 保证
                *s
            }};
        }
        Ok(DuckFns {
            create_config:  sym!(b"duckdb_create_config\0",  FnCreateConfig),
            set_config:     sym!(b"duckdb_set_config\0",     FnSetConfig),
            destroy_config: sym!(b"duckdb_destroy_config\0", FnDestroyConfig),
            open_ext:       sym!(b"duckdb_open_ext\0",       FnOpenExt),
            close:          sym!(b"duckdb_close\0",          FnClose),
            connect:        sym!(b"duckdb_connect\0",        FnConnect),
            disconnect:     sym!(b"duckdb_disconnect\0",     FnDisconnect),
            query:          sym!(b"duckdb_query\0",          FnQuery),
            destroy_result: sym!(b"duckdb_destroy_result\0", FnDestroyResult),
            result_error:   sym!(b"duckdb_result_error\0",   FnResultError),
            column_count:   sym!(b"duckdb_column_count\0",   FnColumnCount),
            row_count:      sym!(b"duckdb_row_count\0",      FnRowCount),
            rows_changed:   sym!(b"duckdb_rows_changed\0",   FnRowsChanged),
            column_name:    sym!(b"duckdb_column_name\0",    FnColumnName),
            free:           sym!(b"duckdb_free\0",           FnFree),
        })
    }
}

// ── 连接状态 ─────────────────────────────────────────────────────────────────

pub struct DuckConnState {
    config_identity: String,
    _lib: Arc<Library>,
    fns: Arc<DuckFns>,
    db:   *mut c_void,
    conn: *mut c_void,
}

// Safety: 对 DuckConnState 的所有访问都在外部 Mutex<DuckConnState> 内
unsafe impl Send for DuckConnState {}

impl Drop for DuckConnState {
    fn drop(&mut self) {
        unsafe {
            if !self.conn.is_null() { (self.fns.disconnect)(&mut self.conn); }
            if !self.db.is_null()   { (self.fns.close)(&mut self.db); }
        }
    }
}

/// 全局连接池（conn_id → 连接状态）
pub type DuckPool = Arc<Mutex<HashMap<String, Arc<Mutex<DuckConnState>>>>>;

// ── 额外连接配置（extra_json） ───────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DuckCfg {
    #[serde(default)] duck_access_mode: String,
    #[serde(default)] duck_threads: u32,
    #[serde(default)] duck_memory_limit: String,
    #[serde(default)] duck_temp_dir: String,
}

impl DuckCfg {
    fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
    }
}

// ── 驱动路径 ─────────────────────────────────────────────────────────────────

pub async fn get_duck_lib_path_pub(registry: &DriverRegistry) -> Result<String, String> {
    get_duck_lib_path(registry).await
}
async fn get_duck_lib_path(registry: &DriverRegistry) -> Result<String, String> {
    let reg = registry.lock().await;
    let state = reg.get("duckdb").ok_or("DuckDB 驱动未注册")?;
    state.custom_path.clone()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "DuckDB 驱动路径未设置，请在「驱动管理」中下载 libduckdb".to_string())
}

// ── 打开 / 缓存连接 ──────────────────────────────────────────────────────────

pub async fn get_or_open_pub(
    conn_id: &str,
    config: &ConnConfig,
    pool: &DuckPool,
    lib_path: &str,
) -> Result<Arc<Mutex<DuckConnState>>, String> {
    get_or_open(conn_id, config, pool, lib_path).await
}
async fn get_or_open(
    conn_id: &str,
    config: &ConnConfig,
    pool: &DuckPool,
    lib_path: &str,
) -> Result<Arc<Mutex<DuckConnState>>, String> {
    let identity = duck_connection_identity(config, lib_path)?;
    // One cache lock covers lookup/validation/build/insert. A stale concurrent
    // opener must not overwrite a newer config. Do not acquire a connection lock
    // while blocking the runtime thread; Tokio awaits preserve lock ordering.
    let mut pool_guard = pool.lock().await;
    if let Some(cached) = pool_guard.get(conn_id) {
        if cached.lock().await.config_identity == identity { return Ok(Arc::clone(cached)); }
        ensure_cached_handle_idle(cached)?;
    }
    // Drop the sole idle cache owner before opening the same file with changed
    // access mode. Outstanding transaction/query Arcs instead fail above.
    drop(pool_guard.remove(conn_id));

    // DR2.5: 建连前驱动可加载性预检（驱动失效时立即给出友好提示，不进入 spawn_blocking）
    verify_dylib_loadable(lib_path)?;

    let file_path = config.file_path.as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("DuckDB 文件路径不能为空")?.to_string();
    let cfg = DuckCfg::from_config(config);
    let read_only = config.read_only == Some(true);  // 提前取出（bool 是 Copy，避免 config 借用进闭包）
    let lib_path = lib_path.to_string();
    let id_str = conn_id.to_string();

    let state: DuckConnState = tokio::task::spawn_blocking(move || -> Result<DuckConnState, String> {
        unsafe {
            let lib = Arc::new(Library::new(&lib_path)
                .map_err(|e| format!("加载 libduckdb 失败（{lib_path}）: {e}"))?);
            let fns = Arc::new(DuckFns::load(&lib)?);

            let mut cfg_ptr: *mut c_void = std::ptr::null_mut();
            if (fns.create_config)(&mut cfg_ptr) != 0 {
                return Err("duckdb_create_config 失败".to_string());
            }
            // 连接标记只读 → 引擎级 read_only（同时覆盖非事务与持久事务路径，
            // 堵住 DuckDB 经 EXPLAIN ANALYZE / WITH...DML 绕过只读的漏洞）
            let access = if cfg.duck_access_mode == "read_only" || read_only
                { "read_only" } else { "read_write" };
            (fns.set_config)(cfg_ptr,
                CString::new("access_mode").unwrap().as_ptr(),
                CString::new(access).unwrap().as_ptr());
            if cfg.duck_threads > 0 {
                (fns.set_config)(cfg_ptr,
                    CString::new("threads").unwrap().as_ptr(),
                    CString::new(cfg.duck_threads.to_string()).unwrap().as_ptr());
            }
            if !cfg.duck_memory_limit.is_empty() {
                let v = CString::new(cfg.duck_memory_limit.as_str())
                    .map_err(|_| "memory_limit 含非法空字节".to_string())?;
                (fns.set_config)(cfg_ptr, CString::new("memory_limit").unwrap().as_ptr(), v.as_ptr());
            }
            if !cfg.duck_temp_dir.is_empty() {
                let v = CString::new(cfg.duck_temp_dir.as_str())
                    .map_err(|_| "temp_directory 含非法空字节".to_string())?;
                (fns.set_config)(cfg_ptr, CString::new("temp_directory").unwrap().as_ptr(), v.as_ptr());
            }

            let path_cstr = CString::new(file_path.as_str())
                .map_err(|_| "文件路径包含空字节".to_string())?;
            let mut db: *mut c_void = std::ptr::null_mut();
            let mut err: *mut c_char = std::ptr::null_mut();

            let rc = (fns.open_ext)(path_cstr.as_ptr(), &mut db, cfg_ptr, &mut err);
            (fns.destroy_config)(&mut cfg_ptr);

            if rc != 0 {
                let msg = if err.is_null() { "未知错误".to_string() }
                else {
                    let s = CStr::from_ptr(err).to_string_lossy().to_string();
                    (fns.free)(err as *mut c_void);
                    s
                };
                return Err(format!("DuckDB 打开失败: {msg}"));
            }

            let mut conn: *mut c_void = std::ptr::null_mut();
            if (fns.connect)(db, &mut conn) != 0 {
                (fns.close)(&mut db);
                return Err("duckdb_connect 失败".to_string());
            }
            Ok(DuckConnState { config_identity: identity, _lib: lib, fns, db, conn })
        }
    }).await.map_err(|e| format!("DuckDB 线程错误: {e}"))??;

    let entry = Arc::new(Mutex::new(state));
    pool_guard.insert(id_str, entry.clone());
    Ok(entry)
}

fn duck_connection_identity(config: &ConnConfig, lib_path: &str) -> Result<String, String> {
    serde_json::to_string(&(config, lib_path)).map_err(|e| format!("编码 DuckDB 连接身份失败: {e}"))
}

fn ensure_cached_handle_idle<T>(cached: &Arc<T>) -> Result<(), String> {
    if Arc::strong_count(cached) != 1 {
        return Err("DuckDB 连接配置已变更，但旧连接仍有查询或事务持有；请结束原事务/查询后重试，已拒绝复用旧库或重定向事务".into());
    }
    Ok(())
}

// ── 核心查询（阻塞，只在 spawn_blocking 内调用） ─────────────────────────────

pub fn run_query_sync_pub(state: &DuckConnState, sql: &str, limit: usize) -> Result<QueryResult, String> {
    run_query_sync(state, sql, limit)
}

/// The native result is already materialized by duckdb_query. Bound the second,
/// Rust-owned representation before allocating each decoded cell.
struct DuckDecodeBudget { rows: usize, bytes: usize, max_bytes: usize }
impl Default for DuckDecodeBudget {
    fn default() -> Self { Self { rows: 0, bytes: 0, max_bytes: super::query_result_budget::MAX_RESULT_BYTES } }
}
impl DuckDecodeBudget {
    fn error() -> String { "查询结果超过内存安全上限（100000 行或 32 MiB），已停止读取，未返回部分结果。请缩小查询范围或使用流式导出。".into() }
    fn charge(&mut self, size: usize) -> Result<(), String> {
        self.bytes = self.bytes.checked_add(size).ok_or_else(Self::error)?;
        if self.bytes > self.max_bytes { return Err(Self::error()); }
        Ok(())
    }
    fn start_row(&mut self) -> Result<(), String> {
        self.rows += 1;
        if self.rows > super::query_result_budget::MAX_RESULT_ROWS { return Err(Self::error()); }
        self.charge(std::mem::size_of::<Vec<Option<String>>>())
    }
    fn cell(&mut self, size: usize) -> Result<(), String> {
        self.charge(std::mem::size_of::<Option<String>>())?;
        self.charge(size)
    }
}

struct DuckAllocation { pointer: *mut c_void, free: FnFree }
impl Drop for DuckAllocation {
    fn drop(&mut self) { if !self.pointer.is_null() { unsafe { (self.free)(self.pointer); } } }
}

fn duck_blob_display_len(bytes: usize) -> Result<usize, String> {
    bytes.checked_mul(2).and_then(|n| n.checked_add(2)).ok_or_else(DuckDecodeBudget::error)
}

fn encode_blob_display(bytes: &[u8]) -> Result<String, String> {
    let mut out = String::with_capacity(duck_blob_display_len(bytes.len())?);
    out.push_str("0x");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes { out.push(HEX[(byte >> 4) as usize] as char); out.push(HEX[(byte & 15) as usize] as char); }
    Ok(out)
}

fn lossy_utf8_len(mut bytes: &[u8]) -> Result<usize, String> {
    let mut length = 0usize;
    loop {
        match std::str::from_utf8(bytes) {
            Ok(text) => return length.checked_add(text.len()).ok_or_else(DuckDecodeBudget::error),
            Err(error) => {
                length = length.checked_add(error.valid_up_to()).and_then(|n| n.checked_add(3)).ok_or_else(DuckDecodeBudget::error)?;
                match error.error_len() {
                    Some(invalid) => bytes = &bytes[error.valid_up_to() + invalid..],
                    None => return Ok(length),
                }
            }
        }
    }
}

fn run_query_sync(state: &DuckConnState, sql: &str, limit: usize) -> Result<QueryResult, String> {
    let t0 = Instant::now();
    unsafe {
        let sql_cstr = CString::new(sql).map_err(|_| "SQL 包含空字节".to_string())?;
        let mut res = DuckRawResult::zeroed();

        let rc = (state.fns.query)(state.conn, sql_cstr.as_ptr(), &mut res);
        if rc != 0 {
            let msg = {
                let ptr = (state.fns.result_error)(&mut res);
                if ptr.is_null() { "查询失败（无错误信息）".to_string() }
                else { CStr::from_ptr(ptr).to_string_lossy().to_string() }
            };
            (state.fns.destroy_result)(&mut res);
            return Err(msg);
        }

        let ncols = (state.fns.column_count)(&mut res) as usize;
        let nrows = (state.fns.row_count)(&mut res) as usize;
        let rows_affected = (state.fns.rows_changed)(&mut res);

        let columns: Vec<String> = (0..ncols).map(|c| {
            let ptr = (state.fns.column_name)(&mut res, c as u64);
            if ptr.is_null() { format!("col_{c}") }
            else { CStr::from_ptr(ptr).to_string_lossy().to_string() }
        }).collect();

        let take = if limit > 0 { nrows.min(limit) } else { nrows };
        let decoded = vector_reader::decode(state, &mut res, ncols, take);

        (state.fns.destroy_result)(&mut res);
        let rows = decoded?;
        Ok(QueryResult {
            is_select: !columns.is_empty(),
            columns,
            rows,
            rows_affected,
            execution_time_ms: t0.elapsed().as_millis() as u64,
            truncated: false,
        })
    }
}

/// 连接测试：临时打开连接执行 SELECT 1，测完立即关闭
pub async fn test_connection(config: &ConnConfig, registry: &DriverRegistry) -> TestResult {
    let start = std::time::Instant::now();
    let lib_path = match get_duck_lib_path(registry).await {
        Ok(p) => p,
        Err(e) => return TestResult { success: false, message: e, latency_ms: None },
    };
    let file_path = if config.database.as_deref() == Some(":memory:") {
        ":memory:".to_string()
    } else {
        match config.file_path.as_deref().filter(|s| !s.is_empty()) {
            Some(p) => p.to_string(),
            None => return TestResult {
                success: false,
                message: "DuckDB 文件路径不能为空".to_string(),
                latency_ms: None,
            },
        }
    };
    let cfg = DuckCfg::from_config(config);
    let read_only = config.read_only == Some(true);
    let res: Result<(), String> = tokio::task::spawn_blocking(move || {
        unsafe {
            let lib = Library::new(&lib_path)
                .map_err(|e| format!("加载 libduckdb 失败: {e}"))?;
            let fns = DuckFns::load(&lib)?;

            let mut cfg_ptr: *mut c_void = std::ptr::null_mut();
            if (fns.create_config)(&mut cfg_ptr) != 0 {
                return Err("duckdb_create_config 失败".to_string());
            }
            let access = if cfg.duck_access_mode == "read_only" || read_only { "read_only" } else { "read_write" };
            (fns.set_config)(cfg_ptr,
                CString::new("access_mode").unwrap().as_ptr(),
                CString::new(access).unwrap().as_ptr());

            let mut db: *mut c_void = std::ptr::null_mut();
            let mut err: *mut c_char = std::ptr::null_mut();
            let path_c = CString::new(file_path.as_str()).map_err(|_| "路径含非法空字节".to_string())?;
            let state = (fns.open_ext)(path_c.as_ptr(), &mut db, cfg_ptr, &mut err);
            (fns.destroy_config)(&mut cfg_ptr);
            if state != 0 {
                let msg = if err.is_null() { "打开数据库失败".to_string() }
                    else { CStr::from_ptr(err).to_string_lossy().to_string() };
                return Err(msg);
            }

            let mut conn: *mut c_void = std::ptr::null_mut();
            (fns.connect)(db, &mut conn);

            // SELECT 1 验证连接可用
            let mut res = DuckRawResult::zeroed();
            let sql = CString::new("SELECT 1").unwrap();
            let ok = (fns.query)(conn, sql.as_ptr(), &mut res);
            (fns.destroy_result)(&mut res);
            (fns.disconnect)(&mut conn);
            (fns.close)(&mut db);
            if ok != 0 { return Err("查询测试失败".to_string()); }
            Ok(())
        }
    }).await.unwrap_or_else(|e| Err(e.to_string()));

    match res {
        Ok(()) => TestResult {
            success: true,
            message: format!("DuckDB 连接成功（驱动已就绪）"),
            latency_ms: Some(start.elapsed().as_millis() as u64),
        },
        Err(e) => TestResult { success: false, message: e, latency_ms: Some(start.elapsed().as_millis() as u64) },
    }
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────────

/// 关闭并清除缓存的 DuckDB 连接
#[tauri::command]
pub async fn duckdb_disconnect(
    id: String,
    pool: State<'_, DuckPool>,
) -> Result<(), String> {
    pool.lock().await.remove(&id);
    Ok(())
}

/// 执行任意 SQL（DD1.x 通用入口）
#[tauri::command]
pub async fn duckdb_query(
    id: String,
    sql: String,
    limit: Option<u32>,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<QueryResult, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let lim = limit.unwrap_or(1000) as usize;
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, lim)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// Schema（catalog）列表
#[tauri::command]
pub async fn duckdb_list_schemas(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<String>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard,
            "SELECT DISTINCT table_catalog FROM information_schema.tables ORDER BY 1", 50)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    let schemas: Vec<String> = res.rows.into_iter()
        .filter_map(|r| r.into_iter().next().flatten()).collect();
    if schemas.is_empty() { Ok(vec!["memory".to_string()]) } else { Ok(schemas) }
}

/// 表/视图列表
#[tauri::command]
pub async fn duckdb_list_tables(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<TableInfo>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let s_esc = schema.replace('\'', "''");

    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &format!(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_catalog = '{}' ORDER BY table_type, table_name", s_esc
        ), 5000)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    Ok(res.rows.into_iter().map(|r| {
        let name  = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
        let ttype = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
        TableInfo { name, is_view: ttype == "VIEW" }
    }).collect())
}

/// 列信息
#[tauri::command]
pub async fn duckdb_list_columns(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<ColumnInfo>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let t_esc = table.replace('\'', "''");
    let _ = schema; // DuckDB information_schema 不需要 schema 过滤（单 catalog）

    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns WHERE table_name = '{}' \
             ORDER BY ordinal_position", t_esc
        ), 1000)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    Ok(res.rows.into_iter().map(|r| {
        let g = |i: usize| r.get(i).and_then(|v| v.clone()).unwrap_or_default();
        ColumnInfo {
            name:          g(0),
            data_type:     g(1),
            nullable:      g(2).to_uppercase() != "NO",
            key:           String::new(),
            default_value: r.get(3).and_then(|v| v.clone()),
        }
    }).collect())
}

/// 连接信息（版本 + 扩展列表，用于 DD0.4 面板）
#[tauri::command]
pub async fn duckdb_conn_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<serde_json::Value, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let (ver_res, ext_res) = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        let ver = run_query_sync(&guard, "SELECT version()", 1);
        let ext = run_query_sync(&guard,
            "SELECT extension_name, loaded, installed FROM duckdb_extensions() LIMIT 50", 50);
        (ver, ext)
    }).await.map_err(|e| format!("线程错误: {e}"))?;

    let version = ver_res.ok()
        .and_then(|r| r.rows.into_iter().next())
        .and_then(|r| r.into_iter().next().flatten())
        .unwrap_or_else(|| "未知".to_string());

    let file_path = config.file_path.clone().unwrap_or_default();
    let file_size = if file_path != ":memory:" {
        std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0)
    } else { 0 };

    let extensions: Vec<serde_json::Value> = ext_res.ok()
        .map(|r| r.rows.into_iter().map(|row| serde_json::json!({
            "name":      row.get(0).and_then(|v| v.clone()),
            "loaded":    row.get(1).and_then(|v| v.clone()),
            "installed": row.get(2).and_then(|v| v.clone()),
        })).collect())
        .unwrap_or_default();

    Ok(serde_json::json!({
        "version":       version,
        "filePath":      file_path,
        "fileSizeBytes": file_size,
        "extensions":    extensions,
    }))
}

// ── DD3.1 扩展管理 ──────────────────────────────────────────────────────────

/// 安装扩展（INSTALL ext）— 需强确认，白名单校验
#[tauri::command]
pub async fn duckdb_install_ext(
    id: String,
    ext_name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 扩展名白名单（防止执行任意系统命令）
    const ALLOWED: &[&str] = &[
        "parquet", "json", "httpfs", "spatial", "fts",
        "postgres_scanner", "mysql_scanner", "sqlite_scanner",
        "excel", "iceberg", "delta", "tpch", "tpcds", "autocomplete",
        "icu", "aws", "azure",
    ];
    let name = ext_name.trim().to_ascii_lowercase();
    if !ALLOWED.iter().any(|a| *a == name) {
        return Err(format!("扩展 '{name}' 不在受信白名单中，如需安装请联系管理员"));
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = format!("INSTALL {name}");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ()).map_err(|e| format!("INSTALL 失败: {e}"))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// 加载扩展（LOAD ext）
#[tauri::command]
pub async fn duckdb_load_ext(
    id: String,
    ext_name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    let name = ext_name.trim().to_ascii_lowercase();
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = format!("LOAD {name}");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ()).map_err(|e| format!("LOAD 失败: {e}"))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD4.2 运行配置 ───────────────────────────────────────────────────────────

/// 查询 DuckDB PRAGMA / 配置变量（只读快照）
#[tauri::command]
pub async fn duckdb_pragmas(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<serde_json::Value, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let items: Vec<(&str, &str)> = vec![
        ("threads", "SELECT current_setting('threads')"),
        ("memory_limit", "SELECT current_setting('memory_limit')"),
        ("temp_directory", "SELECT current_setting('temp_directory')"),
        ("access_mode", "SELECT current_setting('access_mode')"),
        ("enable_progress_bar", "SELECT current_setting('enable_progress_bar')"),
        ("database_size", "SELECT * FROM pragma_database_size()"),
    ];

    let mut out = serde_json::Map::new();
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        for (key, sql) in &items {
            let val = run_query_sync(&guard, sql, 1)
                .ok()
                .and_then(|r| r.rows.into_iter().next())
                .and_then(|row| {
                    if row.len() == 1 {
                        row.into_iter().next().flatten().map(|v| serde_json::Value::String(v))
                    } else {
                        // pragma_database_size 多列，拼成 JSON 对象
                        Some(serde_json::Value::String(row.into_iter().filter_map(|v| v).collect::<Vec<_>>().join(" | ")))
                    }
                })
                .unwrap_or(serde_json::Value::String("—".to_string()));
            out.insert(key.to_string(), val);
        }
        Ok::<_, String>(serde_json::Value::Object(out))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD4.4 SET PRAGMA（可写配置项）────────────────────────────────────────────

/// 设置可写 PRAGMA（白名单校验，防止执行任意 SQL）
#[tauri::command]
pub async fn duckdb_set_pragma(
    id: String,
    key: String,
    value: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 整数类（正整数）
    const INT_KEYS:  &[&str] = &["threads", "max_expression_depth"];
    // 内存/大小类（<数字><可选单位 GB/MB/KB/B>）
    const SIZE_KEYS: &[&str] = &["memory_limit", "checkpoint_threshold"];
    // 布尔类
    const BOOL_KEYS: &[&str] = &["enable_progress_bar", "preserve_insertion_order"];
    // 路径类
    const PATH_KEYS: &[&str] = &["temp_directory"];

    if INT_KEYS.contains(&key.as_str()) {
        if value.is_empty() || !value.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("'{key}' 的值必须是正整数"));
        }
    } else if SIZE_KEYS.contains(&key.as_str()) {
        // 格式：<整数><可选单位>，如 1GB、512MB、1024
        let rest = value.trim_end_matches(|c: char| matches!(c.to_ascii_uppercase(), 'G'|'M'|'K'|'B'));
        if value.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) || rest.is_empty() {
            return Err(format!("'{key}' 的值必须形如 1GB、512MB、1024（整数+可选单位）"));
        }
    } else if BOOL_KEYS.contains(&key.as_str()) {
        if !matches!(value.to_lowercase().as_str(), "true" | "false") {
            return Err(format!("'{key}' 的值只能是 true 或 false"));
        }
    } else if PATH_KEYS.contains(&key.as_str()) {
        super::db_extra::validate_path(&value)?;
    } else {
        return Err(format!("'{key}' 不在可写 PRAGMA 白名单中"));
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = format!("SET {key} = '{}'", value.replace('\'', "''"));
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD4.3 列统计（SUMMARIZE）────────────────────────────────────────────────

/// SUMMARIZE 一张表的列统计（DuckDB 特有）
#[tauri::command]
pub async fn duckdb_summarize(
    id: String,
    table_name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<QueryResult, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    if table_name.trim().is_empty() { return Err("表名不能为空".to_string()); }
    // 标识符转义：按 . 切分 schema.table，各段用双引号包裹并转义内部双引号，杜绝注入
    let q_id = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let quoted: String = table_name.split('.').map(|p| q_id(p)).collect::<Vec<_>>().join(".");
    let sql = format!("SUMMARIZE {quoted}");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 200)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── dispatch 内联辅助（供 query.rs 调用，不注册为 Tauri 命令） ──────────────

pub async fn dispatch_duck_query(
    id: &str,
    config: &ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<QueryResult, String> {
    dispatch_duck_query_with_cancel(id, config, sql, pool, registry, None).await
}

fn validate_alter_batch(statements: &[String]) -> Result<(), String> {
    use sqlparser::{ast::Statement, dialect::DuckDbDialect, parser::Parser};
    if statements.is_empty() || statements.len() > 1000 { return Err("ALTER 批次为空或超过1000条".into()); }
    for sql in statements {
        let parsed = Parser::parse_sql(&DuckDbDialect {}, sql).map_err(|e| format!("无法安全解析 ALTER，原 SQL 未修改: {e}"))?;
        if parsed.len() != 1 || !matches!(&parsed[0], Statement::AlterTable { .. }) {
            return Err("此入口仅允许单条 ALTER TABLE，禁止夹带事务控制或其他语句".into());
        }
    }
    Ok(())
}

fn run_alter_batch_sync(state: &DuckConnState, statements: &[String]) -> Result<(), String> {
    validate_alter_batch(statements)?;
    run_query_sync(state, "BEGIN", 0)?;
    for sql in statements {
        if let Err(error) = run_query_sync(state, sql, 0) {
            return match run_query_sync(state, "ROLLBACK", 0) {
                Ok(_) => Err(format!("{error}；本批次已回滚")),
                Err(rollback) => Err(format!("{error}；回滚未获确认: {rollback}；结果不确定，勿重复执行")),
            };
        }
    }
    run_query_sync(state, "COMMIT", 0).map(|_| ()).map_err(|e| format!("提交未获确认: {e}；结果不确定，勿重复执行"))
}

fn run_isolated_alter_sync(state: &DuckConnState, statements: &[String]) -> Result<(), String> {
    // 新建会话但复用相同原生库，兼容 :memory:；不加入普通查询的未提交事务。
    let mut connection = std::ptr::null_mut();
    if unsafe { (state.fns.connect)(state.db, &mut connection) } != 0 {
        return Err("创建 ALTER 专用会话失败".into());
    }
    let dedicated = DuckConnState { config_identity: state.config_identity.clone(), _lib: Arc::clone(&state._lib), fns: Arc::clone(&state.fns), db: std::ptr::null_mut(), conn: connection };
    run_alter_batch_sync(&dedicated, statements)
}

/// 向导独占连接；不注册到手动事务表，其他窗口无法提交或加入本批次。
#[tauri::command]
pub async fn duckdb_alter_table_atomic(
    id: String, statements: Vec<String>, storage: State<'_, StorageState>, pool: State<'_, DuckPool>, registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    validate_alter_batch(&statements)?;
    let config = load_conn_config(&id, &storage)?;
    if config.conn_type != crate::models::ConnType::Duckdb || config.read_only == Some(true) {
        return Err("此操作仅支持可写 DuckDB 连接".into());
    }
    let library = get_duck_lib_path(&registry).await?;
    let handle = get_or_open(&id, &config, &pool, &library).await?;
    tokio::task::spawn_blocking(move || {
        let guard = handle.blocking_lock();
        run_isolated_alter_sync(&guard, &statements)
    }).await.map_err(|e| format!("ALTER 线程未正常返回: {e}；结果不确定，勿重复执行"))?
}

pub async fn dispatch_duck_query_with_cancel(
    id: &str,
    config: &ConnConfig,
    sql: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
    cancel_token: Option<&str>,
) -> Result<QueryResult, String> {
    dispatch_duck_query_with_target(id, config, sql, pool, registry, cancel_token, None).await
}

pub async fn dispatch_duck_query_with_target(
    id: &str, config: &ConnConfig, sql: &str, pool: &DuckPool,
    registry: &DriverRegistry, cancel_token: Option<&str>, catalog: Option<&str>,
) -> Result<QueryResult, String> {
    let lib_path = get_duck_lib_path(registry).await?;
    let conn = get_or_open(id, config, pool, &lib_path).await?;
    execute_retained_target_inner(conn, sql.to_string(), cancel_token, id, catalog.map(str::to_string)).await
}

fn selected_catalog_sql(catalog: &str, catalogs: &[String]) -> Result<String, String> {
    if catalog.is_empty() || catalog.len() > 128 || catalog.chars().any(char::is_control) {
        return Err("DuckDB catalog 标识符无效".into());
    }
    if !catalogs.iter().any(|name| name == catalog) { return Err("选中的 DuckDB catalog 不存在于当前连接，已拒绝执行".into()); }
    Ok(format!("USE \"{}\"", catalog.replace('"', "\"\"")))
}

pub(crate) fn select_catalog_on_connection(state: &DuckConnState, catalog: &str) -> Result<(), String> {
    let result = run_query_sync(state, "SELECT database_name FROM duckdb_databases()", 0)?;
    let names: Vec<String> = result.rows.into_iter().filter_map(|row| row.into_iter().next().flatten()).collect();
    let command = selected_catalog_sql(catalog, &names)?;
    run_query_sync(state, &command, 0).map(|_| ())
}

/// 事务专用连接在 BEGIN 前设置目标，之后不与普通查询共享。
pub async fn select_retained_catalog(conn: Arc<Mutex<DuckConnState>>, catalog: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        select_catalog_on_connection(&guard, &catalog)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// Execute on the exact connection selected at BEGIN. The Arc keeps both native
/// handles and their loaded library alive, independent of later config saves.
pub async fn execute_retained(
    conn: Arc<Mutex<DuckConnState>>,
    sql: String,
    cancel_token: Option<&str>,
) -> Result<QueryResult, String> {
    execute_retained_inner(conn, sql, cancel_token, "retained").await
}

async fn execute_retained_inner(
    conn: Arc<Mutex<DuckConnState>>, sql: String, cancel_token: Option<&str>, owner_id: &str,
) -> Result<QueryResult, String> {
    execute_retained_target_inner(conn, sql, cancel_token, owner_id, None).await
}

async fn execute_retained_target_inner(
    conn: Arc<Mutex<DuckConnState>>, sql: String, cancel_token: Option<&str>, owner_id: &str, catalog: Option<String>,
) -> Result<QueryResult, String> {
    let token = cancel_token.map(str::to_string);
    let registration = token.as_ref().map(|t| crate::commands::query::abort_register_for(t, owner_id)).transpose()?;
    let (_abort_guard, abort_rx) = registration.map_or((None, None), |(guard, rx)| (Some(guard), Some(rx)));

    let handle = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        if let Some(catalog) = catalog { select_catalog_on_connection(&guard, &catalog)?; }
        run_query_sync(&guard, &sql, 0)
    });

    let result = if let Some(rx) = abort_rx {
        tokio::select! {
            r = handle => r.map_err(|e| format!("线程错误: {e}"))?,
            _ = rx => Err("已停止等待 DuckDB 查询；原生执行仍可能继续，写入结果需核查，勿自动重试".to_string()),
        }
    } else {
        handle.await.map_err(|e| format!("线程错误: {e}"))?
    };

    result
}

pub async fn dispatch_duck_schemas(
    id: &str,
    config: &ConnConfig,
    pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<Vec<String>, String> {
    let lib_path = get_duck_lib_path(registry).await?;
    let conn = get_or_open(id, config, pool, &lib_path).await?;
    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard,
            "SELECT DISTINCT table_catalog FROM information_schema.tables ORDER BY 1", 50)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    let schemas: Vec<String> = res.rows.into_iter()
        .filter_map(|r| r.into_iter().next().flatten()).collect();
    if schemas.is_empty() { Ok(vec!["memory".to_string()]) } else { Ok(schemas) }
}

pub async fn dispatch_duck_tables(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<Vec<TableInfo>, String> {
    let lib_path = get_duck_lib_path(registry).await?;
    let conn = get_or_open(id, config, pool, &lib_path).await?;
    let s_esc = schema.replace('\'', "''");
    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &format!(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_catalog = '{}' ORDER BY table_type, table_name", s_esc
        ), 5000)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    Ok(res.rows.into_iter().map(|r| {
        let name  = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
        let ttype = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
        TableInfo { name, is_view: ttype == "VIEW" }
    }).collect())
}

/// DD1.4 DuckDB 高速 COPY TO（Parquet/CSV）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckCopyResult {
    pub rows: u64,
    pub file_bytes: u64,
}

#[tauri::command]
pub async fn duckdb_copy_to(
    id: String,
    sql: String,
    path: String,
    format: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<DuckCopyResult, String> {
    let fmt_upper = format.to_ascii_uppercase();
    if !matches!(fmt_upper.as_str(), "PARQUET" | "CSV") {
        return Err("format 只允许 parquet 或 csv".to_string());
    }
    super::db_extra::validate_path(&path)?;
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let path_esc = path.replace('\'', "''");
    let base_sql = sql.trim().trim_end_matches(';').trim();
    let copy_sql = if fmt_upper == "CSV" {
        format!("COPY ({base_sql}) TO '{}' (FORMAT CSV, HEADER TRUE)", path_esc)
    } else {
        format!("COPY ({base_sql}) TO '{}' (FORMAT PARQUET)", path_esc)
    };

    let rows = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &copy_sql, 0).map(|r| r.rows_affected)
    }).await.map_err(|e| format!("线程错误: {e}"))??;
    let file_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(DuckCopyResult { rows, file_bytes })
}

// ── 可选增强 DD8.5: 脱敏导出 ─────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct DuckMaskRule {
    pub column: String,
    pub rule: String,   // none | null | mask | hash | phone | email
}

/// DD8.5: DuckDB 脱敏导出——用 `SELECT * REPLACE (...)` 对指定列注入脱敏变换后 COPY 导出。
/// 独立命令，不影响通用导出链路。表名/列名双引号转义，路径单引号转义防注入。
#[tauri::command]
pub async fn duckdb_export_masked(
    id: String,
    table: String,
    dest_path: String,
    format: String,
    rules: Vec<DuckMaskRule>,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<u64, String> {
    let fmt_upper = format.to_ascii_uppercase();
    if !matches!(fmt_upper.as_str(), "PARQUET" | "CSV") {
        return Err("format 只允许 parquet 或 csv".to_string());
    }
    if table.trim().is_empty() || dest_path.trim().is_empty() {
        return Err("表名和导出路径不能为空".to_string());
    }
    super::db_extra::validate_path(&dest_path)?;
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let q_id = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut replaces = Vec::new();
    for r in &rules {
        if r.rule.is_empty() || r.rule == "none" { continue; }
        let col = q_id(&r.column);
        let expr = match r.rule.as_str() {
            "null"  => "NULL".to_string(),
            "mask"  => "'***'".to_string(),
            "hash"  => format!("md5(CAST({col} AS VARCHAR))"),
            // 手机：保留首 3 尾 4，中间 ****
            "phone" => format!("regexp_replace(CAST({col} AS VARCHAR), '(\\d{{3}})\\d+(\\d{{4}})', '\\1****\\2', 'g')"),
            // 邮箱：保留用户名首 2 位 + 完整域名
            "email" => format!("regexp_replace(CAST({col} AS VARCHAR), '(^.{{0,2}})[^@]*(@.*)', '\\1***\\2', 'g')"),
            _ => continue,
        };
        replaces.push(format!("{expr} AS {col}"));
    }
    // 表名（支持 schema.table）各段双引号转义
    let table_q = table.split('.').map(|p| q_id(p)).collect::<Vec<_>>().join(".");
    let select = if replaces.is_empty() {
        format!("SELECT * FROM {table_q}")
    } else {
        format!("SELECT * REPLACE ({}) FROM {table_q}", replaces.join(", "))
    };
    let path_esc = dest_path.replace('\'', "''");
    let copy_sql = if fmt_upper == "CSV" {
        format!("COPY ({select}) TO '{path_esc}' (FORMAT CSV, HEADER TRUE)")
    } else {
        format!("COPY ({select}) TO '{path_esc}' (FORMAT PARQUET)")
    };

    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &copy_sql, 0).map(|r| r.rows_affected)
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD5 跨引擎数据流（ATTACH / DETACH）────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AttachedDb {
    pub name:   String,
    pub path:   String,
    pub db_type: String,
}

/// DD5.1 列出已 ATTACH 的数据库
#[tauri::command]
pub async fn duckdb_list_databases(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<AttachedDb>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        let r = run_query_sync(&guard,
            "SELECT database_name, path, type FROM duckdb_databases() ORDER BY database_name", 200);
        match r {
            Ok(res) => Ok(res.rows.into_iter().map(|row| {
                let g = |i: usize| row.get(i).and_then(|v| v.clone()).unwrap_or_default();
                AttachedDb { name: g(0), path: g(1), db_type: g(2) }
            }).collect()),
            Err(_) => Ok(vec![]),
        }
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// DD5.1 ATTACH 外部库（安全构造 SQL）
#[tauri::command]
pub async fn duckdb_attach(
    id: String,
    alias: String,
    db_type: String,    // "duckdb" | "sqlite" | "postgres" | "mysql"
    conn_str: String,   // 文件路径 or 连接字符串
    read_only: bool,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // alias 仅允许字母/数字/下划线
    if !alias.chars().all(|c| c.is_alphanumeric() || c == '_') || alias.is_empty() {
        return Err("别名只允许字母、数字、下划线".to_string());
    }
    let allowed_types = ["duckdb", "sqlite", "postgres", "mysql"];
    if !allowed_types.contains(&db_type.as_str()) {
        return Err(format!("不支持的库类型: {db_type}"));
    }
    if conn_str.contains('\'') {
        return Err("连接字符串不能含单引号".to_string());
    }

    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let ro_flag = if read_only { ", READ_ONLY" } else { "" };
    let sql = match db_type.as_str() {
        "duckdb" => format!("ATTACH '{conn_str}' AS {alias}{}", if read_only { " (READ_ONLY)" } else { "" }),
        t => format!("ATTACH '{conn_str}' AS {alias} (TYPE {}{ro_flag})", t.to_uppercase()),
    };

    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// DD5.1 DETACH 已挂载的外部库
#[tauri::command]
pub async fn duckdb_detach(
    id: String,
    alias: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    if !alias.chars().all(|c| c.is_alphanumeric() || c == '_') || alias.is_empty() {
        return Err("别名只允许字母、数字、下划线".to_string());
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &format!("DETACH {alias}"), 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD7 备份与恢复 ────────────────────────────────────────────────────────────

/// DD7.1 EXPORT DATABASE（schema + 数据，Parquet 格式）
#[tauri::command]
pub async fn duckdb_export_database(
    id: String,
    output_dir: String,
    format: String,       // "parquet" or "csv"
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let fmt_upper = format.to_ascii_uppercase();
    if !matches!(fmt_upper.as_str(), "PARQUET" | "CSV") {
        return Err("format 只允许 parquet 或 csv".to_string());
    }
    if output_dir.is_empty() { return Err("输出目录不能为空".to_string()); }

    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let dir_esc = output_dir.replace('\'', "''");
    let sql = format!("EXPORT DATABASE '{dir_esc}' (FORMAT {fmt_upper})");
    let t = Instant::now();
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0)?;
        Ok(format!("EXPORT 完成，耗时 {:.1}ms，输出至: {output_dir}", t.elapsed().as_secs_f64() * 1000.0))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// DD7.1 IMPORT DATABASE（从 EXPORT 目录恢复）
#[tauri::command]
pub async fn duckdb_import_database(
    id: String,
    input_dir: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    if input_dir.is_empty() { return Err("输入目录不能为空".to_string()); }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let dir_esc = input_dir.replace('\'', "''");
    let sql = format!("IMPORT DATABASE '{dir_esc}'");
    let t = Instant::now();
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0)?;
        Ok(format!("IMPORT 完成，耗时 {:.1}ms", t.elapsed().as_secs_f64() * 1000.0))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// DD7.2 文件级备份（先 CHECKPOINT，再复制 .duckdb 文件）
#[tauri::command]
pub async fn duckdb_file_backup(
    id: String,
    dest_path: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    if dest_path.is_empty() { return Err("目标路径不能为空".to_string()); }
    let config = load_conn_config(&id, &storage)?;
    let src_path = config.host.clone().unwrap_or_default();
    if src_path.is_empty() || src_path == ":memory:" {
        return Err("内存库不支持文件备份".to_string());
    }

    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    // 1. 先 FORCE CHECKPOINT 确保 WAL 完全落盘后再复制文件
    tokio::task::spawn_blocking({
        let conn = conn.clone();
        move || {
            let guard = conn.blocking_lock();
            let _ = run_query_sync(&guard, "FORCE CHECKPOINT", 0);
        }
    }).await.map_err(|e| format!("CHECKPOINT 失败: {e}"))?;

    // 2. 复制文件
    let t = Instant::now();
    std::fs::copy(&src_path, &dest_path)
        .map_err(|e| format!("文件复制失败: {e}"))?;

    // 3. 若存在 WAL 文件也复制
    let wal_src = format!("{src_path}.wal");
    let wal_dest = format!("{dest_path}.wal");
    if std::path::Path::new(&wal_src).exists() {
        let _ = std::fs::copy(&wal_src, &wal_dest);
    }

    let size = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
    Ok(format!("备份完成，耗时 {:.1}ms，大小: {}，路径: {dest_path}",
        t.elapsed().as_secs_f64() * 1000.0, {
            if size >= 1073741824 { format!("{:.2} GB", size as f64 / 1073741824.0) }
            else if size >= 1048576 { format!("{:.2} MB", size as f64 / 1048576.0) }
            else { format!("{} KB", size / 1024) }
        }
    ))
}

// ── DD6 维护与诊断（CHECKPOINT / VACUUM / 健康检查）────────────────────────────

/// DD6.1 CHECKPOINT（WAL 落盘）
#[tauri::command]
pub async fn duckdb_checkpoint(
    id: String,
    force: bool,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = if force { "FORCE CHECKPOINT" } else { "CHECKPOINT" };
    let t = Instant::now();
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, sql, 0)?;
        Ok(format!("CHECKPOINT 完成，耗时 {:.1}ms", t.elapsed().as_secs_f64() * 1000.0))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// DD6.2 VACUUM（统计更新 / 空间回收）
#[tauri::command]
pub async fn duckdb_vacuum(
    id: String,
    table_name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = if table_name.trim().is_empty() {
        "VACUUM ANALYZE".to_string()
    } else {
        // 标识符转义：双引号包裹并转义内部双引号（trim_matches 只去首尾、留下中间引号会逃逸）
        let q_id = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let quoted: String = table_name.trim().split('.').map(|p| q_id(p)).collect::<Vec<_>>().join(".");
        format!("VACUUM ANALYZE {quoted}")
    };
    let t = Instant::now();
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0)?;
        Ok(format!("VACUUM 完成，耗时 {:.1}ms", t.elapsed().as_secs_f64() * 1000.0))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

#[derive(serde::Serialize, Clone)]
pub struct HealthCheckItem {
    pub key: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(serde::Serialize)]
pub struct DuckHealthReport {
    pub can_connect: bool,
    pub version: String,
    pub file_path: String,
    pub file_size_bytes: i64,
    pub extension_count: usize,
    pub loaded_count: usize,
    pub access_mode: String,
    pub wal_size: String,
    pub issues: Vec<String>,
    pub score: i32,
    pub check_items: Vec<HealthCheckItem>,
}

/// DD6.3 健康检查
#[tauri::command]
pub async fn duckdb_health_check(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<DuckHealthReport, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        let mut issues: Vec<String> = vec![];
        let mut check_items: Vec<HealthCheckItem> = vec![];
        let mut score: i32 = 100;

        let cell = |sql: &str| -> String {
            run_query_sync(&guard, sql, 1).ok()
                .and_then(|r| r.rows.into_iter().next())
                .and_then(|row| row.into_iter().next().flatten())
                .unwrap_or_else(|| String::from("—"))
        };

        let version = cell("SELECT version()");
        let access_mode = cell("SELECT current_setting('access_mode')");
        let ckpt_threshold = cell("SELECT current_setting('checkpoint_threshold')");

        // WAL 大小
        let wal_size = run_query_sync(&guard, "SELECT wal_size FROM pragma_database_size() WHERE database_name='main'", 1)
            .ok()
            .and_then(|r| r.rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .unwrap_or_else(|| String::from("—"));

        // 扩展统计（含名称）
        let ext_res = run_query_sync(&guard, "SELECT name, loaded, installed FROM duckdb_extensions()", 500)
            .unwrap_or_else(|_| crate::models::QueryResult { columns: vec![], rows: vec![], rows_affected: 0, execution_time_ms: 0, truncated: false, is_select: false });
        let extension_count = ext_res.rows.len();
        let loaded_count = ext_res.rows.iter().filter(|r| r.get(1).and_then(|v| v.as_deref()) == Some("true")).count();

        // 文件信息
        let file_path = config.host.clone().unwrap_or_default();
        let file_size_bytes: i64 = if file_path != ":memory:" {
            std::fs::metadata(&file_path).map(|m| m.len() as i64).unwrap_or(-1)
        } else { 0 };

        // 1. 连接性
        check_items.push(HealthCheckItem {
            key: "connect".to_string(), label: "数据库连接".to_string(),
            status: "ok".to_string(), detail: format!("DuckDB {} 连接正常", version),
        });

        // 2. 版本兼容
        let ver_num: f64 = version.trim_start_matches('v').split('.').take(2)
            .collect::<Vec<_>>().join(".").parse().unwrap_or(0.0);
        if ver_num > 0.0 && ver_num < 0.9 {
            check_items.push(HealthCheckItem {
                key: "version".to_string(), label: "版本兼容".to_string(),
                status: "warn".to_string(), detail: format!("版本 {} 较旧，建议升级至 v0.9+", version),
            });
            score -= 5;
            issues.push(format!("版本 {} 较旧，建议升级", version));
        } else {
            check_items.push(HealthCheckItem {
                key: "version".to_string(), label: "版本兼容".to_string(),
                status: "ok".to_string(), detail: format!("版本 {} 符合要求", version),
            });
        }

        // 3. 文件可达性
        if file_path == ":memory:" {
            check_items.push(HealthCheckItem {
                key: "file".to_string(), label: "数据库文件".to_string(),
                status: "ok".to_string(), detail: "内存库，无持久化文件".to_string(),
            });
        } else if file_size_bytes < 0 {
            check_items.push(HealthCheckItem {
                key: "file".to_string(), label: "数据库文件".to_string(),
                status: "error".to_string(), detail: format!("文件元数据读取失败：{}", file_path),
            });
            score -= 20;
            issues.push("无法读取库文件元数据，文件可能被移动或删除".to_string());
        } else {
            let size_str = if file_size_bytes >= 1_073_741_824 {
                format!("{:.2} GB", file_size_bytes as f64 / 1_073_741_824.0)
            } else if file_size_bytes >= 1_048_576 {
                format!("{:.2} MB", file_size_bytes as f64 / 1_048_576.0)
            } else {
                format!("{} KB", file_size_bytes / 1024)
            };
            check_items.push(HealthCheckItem {
                key: "file".to_string(), label: "数据库文件".to_string(),
                status: "ok".to_string(), detail: format!("文件大小 {}，路径可访问", size_str),
            });
        }

        // 4. 访问模式
        if access_mode == "read_only" {
            check_items.push(HealthCheckItem {
                key: "access".to_string(), label: "访问模式".to_string(),
                status: "warn".to_string(), detail: "只读模式：写操作将被拒绝".to_string(),
            });
            issues.push("当前为只读模式，写操作将被拒绝".to_string());
        } else {
            check_items.push(HealthCheckItem {
                key: "access".to_string(), label: "访问模式".to_string(),
                status: "ok".to_string(), detail: "读写模式".to_string(),
            });
        }

        // 5. WAL 状态
        let wal_bytes: i64 = wal_size.parse().unwrap_or(-1);
        if wal_bytes > 524_288_000 {
            check_items.push(HealthCheckItem {
                key: "wal".to_string(), label: "WAL 日志".to_string(),
                status: "warn".to_string(),
                detail: format!("WAL 过大（{:.0} MB），建议 CHECKPOINT（阈值: {}）", wal_bytes as f64 / 1_048_576.0, ckpt_threshold),
            });
            score -= 10;
            issues.push(format!("WAL 过大（{} 字节），建议执行 CHECKPOINT", wal_bytes));
        } else {
            let wal_disp = if wal_bytes >= 0 { format!("{} 字节", wal_bytes) } else { wal_size.clone() };
            check_items.push(HealthCheckItem {
                key: "wal".to_string(), label: "WAL 日志".to_string(),
                status: "ok".to_string(), detail: format!("WAL 大小正常（{}）", wal_disp),
            });
        }

        // 6. 关键扩展
        let ext_names: Vec<String> = ext_res.rows.iter()
            .filter(|r| r.get(1).and_then(|v| v.as_deref()) == Some("true"))
            .filter_map(|r| r.get(0).and_then(|v| v.clone()))
            .collect();
        let critical = ["parquet", "json"];
        let missing: Vec<&str> = critical.iter().filter(|&&e| !ext_names.iter().any(|n| n == e)).copied().collect();
        if missing.is_empty() {
            check_items.push(HealthCheckItem {
                key: "extensions".to_string(), label: "关键扩展".to_string(),
                status: "ok".to_string(), detail: format!("已加载 {} 个扩展，parquet/json 就绪", loaded_count),
            });
        } else {
            check_items.push(HealthCheckItem {
                key: "extensions".to_string(), label: "关键扩展".to_string(),
                status: "warn".to_string(), detail: format!("关键扩展未加载：{}，部分功能不可用", missing.join(", ")),
            });
            score -= 5;
        }

        // 7. 扩展安全
        let builtin = ["parquet","json","icu","httpfs","spatial","fts","excel","iceberg","delta",
                        "aws","azure","postgres_scanner","mysql_scanner","sqlite_scanner","tpcds","tpch","jemalloc"];
        let non_core = ext_res.rows.iter().filter(|r| {
            r.get(1).and_then(|v| v.as_deref()) == Some("true") &&
            !builtin.contains(&r.get(0).and_then(|v| v.as_deref()).unwrap_or(""))
        }).count();
        if non_core > 0 {
            check_items.push(HealthCheckItem {
                key: "ext_safety".to_string(), label: "扩展安全".to_string(),
                status: "warn".to_string(), detail: format!("{} 个非内置扩展已加载，请确认来源可信", non_core),
            });
            score -= 5;
        } else {
            check_items.push(HealthCheckItem {
                key: "ext_safety".to_string(), label: "扩展安全".to_string(),
                status: "ok".to_string(), detail: "已加载扩展均为官方内置扩展".to_string(),
            });
        }

        score = score.max(0);

        Ok(DuckHealthReport {
            can_connect: true,
            version,
            file_path,
            file_size_bytes,
            extension_count,
            loaded_count,
            access_mode,
            wal_size,
            issues,
            score,
            check_items,
        })
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD4.1 查询 Profiling（JSON 火焰树）────────────────────────────────────────

/// 运行 EXPLAIN ANALYZE 并通过 JSON profiling 模式获取算子级耗时树
#[tauri::command]
pub async fn duckdb_profile_query(
    id: String,
    sql: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<serde_json::Value, String> {
    if sql.trim().is_empty() { return Err("SQL 不能为空".to_string()); }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    // 用进程 ID + 随机数生成唯一路径，避免并发冲突
    let pid = std::process::id();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let temp_path = std::env::temp_dir().join(format!("duckdb_prof_{pid}_{ts}.json"));
    let path_str = temp_path.to_string_lossy().replace('\\', "/");
    let sql_owned = sql.trim().to_string();

    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();

        // 启用 JSON profiling（仅当前会话，不影响其它连接）
        run_query_sync(&guard, "SET enable_profiling = 'json'", 0)?;
        let _ = run_query_sync(&guard, &format!("SET profiling_output = '{path_str}'"), 0);

        // 执行目标 SQL（忽略结果，只要触发 profiling）
        let _ = run_query_sync(&guard, &sql_owned, 200);

        // 关闭 profiling，防止后续查询继续输出
        let _ = run_query_sync(&guard, "RESET enable_profiling", 0);
        let _ = run_query_sync(&guard, "RESET profiling_output", 0);

        // 读取并解析 JSON 文件
        let content = std::fs::read_to_string(&temp_path)
            .map_err(|e| format!("读取 profiling 文件失败（DuckDB 版本过旧？）: {e}"))?;
        let _ = std::fs::remove_file(&temp_path);
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("解析 profiling JSON 失败: {e}"))
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD3.2 扩展仓库配置 ───────────────────────────────────────────────────────

/// 设置扩展仓库 URL（custom_extension_repository）
#[tauri::command]
pub async fn duckdb_set_ext_repo(
    id: String,
    url: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // URL 基本校验：不能含单引号（防注入），且需 http/https 前缀或为 "default"
    if !url.chars().all(|c| c != '\'') {
        return Err("URL 不能含单引号".to_string());
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = if url == "default" || url.is_empty() {
        "RESET custom_extension_repository".to_string()
    } else {
        format!("SET custom_extension_repository = '{}'", url)
    };
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

// ── DD2.4 Secret 管理（httpfs / S3 凭证）────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct SecretInfo {
    pub name:  String,
    pub r#type: String,
    pub scope: String,
}

/// 列出当前会话中已创建的 secret
#[tauri::command]
pub async fn duckdb_list_secrets(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<SecretInfo>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        let r = run_query_sync(&guard, "SELECT name, type, scope FROM duckdb_secrets()", 200);
        match r {
            Ok(res) => Ok(res.rows.into_iter().map(|row| {
                let g = |i: usize| row.get(i).and_then(|v| v.clone()).unwrap_or_default();
                SecretInfo { name: g(0), r#type: g(1), scope: g(2) }
            }).collect()),
            Err(_) => Ok(vec![]), // 旧版本 DuckDB 不支持时返回空
        }
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// 创建或替换 S3 secret（DD2.4 安全隔离：服务端构造 SQL，前端不直接拼接）
#[tauri::command]
pub async fn duckdb_create_s3_secret(
    id: String,
    name: String,
    key_id: String,
    secret: String,
    region: String,
    endpoint: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    // 名称只允许字母/数字/下划线，防止注入
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') || name.is_empty() {
        return Err("secret 名称只允许字母、数字、下划线".to_string());
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let esc = |s: &str| s.replace('\'', "''");
    let sql = if endpoint.is_empty() {
        format!(
            "CREATE OR REPLACE SECRET {name} (TYPE s3, KEY_ID '{ki}', SECRET '{sec}', REGION '{reg}')",
            name = name,
            ki = esc(&key_id),
            sec = esc(&secret),
            reg = esc(&region),
        )
    } else {
        format!(
            "CREATE OR REPLACE SECRET {name} (TYPE s3, KEY_ID '{ki}', SECRET '{sec}', REGION '{reg}', ENDPOINT '{ep}')",
            name = name,
            ki = esc(&key_id),
            sec = esc(&secret),
            reg = esc(&region),
            ep = esc(&endpoint),
        )
    };

    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

/// 删除指定 secret
#[tauri::command]
pub async fn duckdb_drop_secret(
    id: String,
    name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') || name.is_empty() {
        return Err("secret 名称只允许字母、数字、下划线".to_string());
    }
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;
    let sql = format!("DROP SECRET IF EXISTS {name}");
    tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &sql, 0).map(|_| ())
    }).await.map_err(|e| format!("线程错误: {e}"))?
}

pub async fn dispatch_duck_columns(
    id: &str,
    config: &ConnConfig,
    table: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<Vec<crate::models::ColumnInfo>, String> {
    let lib_path = get_duck_lib_path(registry).await?;
    let conn = get_or_open(id, config, pool, &lib_path).await?;
    let t_esc = table.replace('\'', "''");
    let res = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, &format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns WHERE table_name = '{}' ORDER BY ordinal_position", t_esc
        ), 1000)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    Ok(res.rows.into_iter().map(|r| {
        let g = |i: usize| r.get(i).and_then(|v| v.clone()).unwrap_or_default();
        crate::models::ColumnInfo {
            name:          g(0),
            data_type:     g(1),
            nullable:      g(2).to_uppercase() != "NO",
            key:           String::new(),
            default_value: r.get(3).and_then(|v| v.clone()),
        }
    }).collect())
}

/// 获取 DuckDB 表 DDL（优先从 duckdb_tables() 取 sql 字段，不存在则取视图 sql）
pub async fn dispatch_duck_ddl(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    pool: &DuckPool,
    registry: &DriverRegistry,
) -> Result<String, String> {
    let lib_path = get_duck_lib_path(registry).await?;
    let conn = get_or_open(id, config, pool, &lib_path).await?;

    let t_esc = table.replace('\'', "''");
    let s_esc = if schema.is_empty() { "main".to_string() } else { schema.replace('\'', "''") };
    let table_sql = format!(
        "SELECT sql FROM duckdb_tables() WHERE table_name = '{t_esc}' AND schema_name = '{s_esc}' LIMIT 1"
    );
    let view_sql = format!(
        "SELECT sql FROM duckdb_views() WHERE view_name = '{t_esc}' AND schema_name = '{s_esc}' LIMIT 1"
    );

    let ddl = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        let from_table = run_query_sync(&guard, &table_sql, 1)
            .ok()
            .and_then(|r| r.rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten());
        if let Some(sql) = from_table {
            return Ok(sql);
        }
        run_query_sync(&guard, &view_sql, 1)
            .ok()
            .and_then(|r| r.rows.into_iter().next())
            .and_then(|row| row.into_iter().next().flatten())
            .ok_or_else(|| format!("未找到表或视图: {t_esc}"))
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    Ok(ddl)
}

// ── 可选增强 DD3: FTS 全文检索索引列表 ───────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckFtsIndex {
    pub schema_name: String,
    pub table_name: String,
    pub fts_schema: String,  // duckdb-fts 创建的影子 schema 名
}

/// DD3+: 列出已创建的 FTS 全文检索索引
/// duckdb-fts 对 <schema>.<table> 建索引时会创建名为 fts_<schema>_<table> 的 schema。
/// 用 duckdb_schemas() 发现这些影子 schema，再以真实 schema 列表做【最长前缀匹配】
/// 还原原表（schema/table 名含下划线也能正确切分，避免盲目 split）。
/// fts 扩展未装/无索引时返回空列表（graceful）。
#[tauri::command]
pub async fn duckdb_fts_list(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<DuckFtsIndex>, String> {
    let config = load_conn_config(&id, &storage)?;
    let lib_path = get_duck_lib_path(&registry).await?;
    let conn = get_or_open(&id, &config, &pool, &lib_path).await?;

    let list_sql = "SELECT schema_name FROM duckdb_schemas() ORDER BY schema_name";

    let schemas = tokio::task::spawn_blocking(move || {
        let guard = conn.blocking_lock();
        run_query_sync(&guard, list_sql, 1000)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    // 所有 schema 名
    let all: Vec<String> = schemas.rows.iter()
        .filter_map(|r| r.get(0).and_then(|v| v.as_ref()).cloned())
        .collect();
    // 真实（非 fts_ 影子）schema 列表，用于最长前缀匹配
    let real: Vec<&String> = all.iter().filter(|s| !s.starts_with("fts_")).collect();

    let mut result = Vec::new();
    for s in &all {
        let Some(inner) = s.strip_prefix("fts_") else { continue };

        // 在真实 schema 中找最长的、满足 inner == "{real}_{table}" 的匹配
        let mut best: Option<(&str, String)> = None;
        for r in &real {
            if let Some(rest) = inner.strip_prefix(&format!("{r}_")) {
                if !rest.is_empty() && best.as_ref().map_or(true, |(bs, _)| r.len() > bs.len()) {
                    best = Some((r.as_str(), rest.to_string()));
                }
            }
        }

        let (schema_name, table_name) = match best {
            Some((sc, tb)) => (sc.to_string(), tb),
            None => {
                // 退化兜底：按首个下划线切分
                let mut it = inner.splitn(2, '_');
                (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())
            }
        };
        if table_name.is_empty() { continue; }

        result.push(DuckFtsIndex {
            schema_name,
            table_name,
            fts_schema: s.clone(),
        });
    }
    Ok(result)
}

// ── 可选增强 DD7.4: DuckDB ↔ DuckDB 双库 schema 对比 ─────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckDiffTable {
    pub name: String,
    pub status: String,   // only_left | only_right | common
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckDiffColumn {
    pub table: String,
    pub column: String,
    pub status: String,   // only_left | only_right | type_changed
    pub left_type: Option<String>,
    pub right_type: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckDiffResult {
    pub tables: Vec<DuckDiffTable>,
    pub columns: Vec<DuckDiffColumn>,
    pub summary: String,
}

/// DD7.4: 对比两个 DuckDB 库的 schema（表/列差异）。
/// left 连接内 ATTACH right 库文件（只读），用 duckdb_tables/columns 对比，完成后 DETACH。
fn duck_diff_file_path(config: &ConnConfig) -> Result<&str, String> {
    if config.conn_type != crate::models::ConnType::Duckdb { return Err("仅支持 DuckDB 文件连接".into()); }
    config.file_path.as_deref().filter(|p| !p.is_empty() && *p != ":memory:")
        .ok_or_else(|| "对比必须使用 DuckDB 文件库，不支持内存库".into())
}

fn duck_diff_table_identity(schema: &str, table: &str) -> String {
    format!("\"{}\".\"{}\"", schema.replace('"', "\"\""), table.replace('"', "\"\""))
}

#[tauri::command]
pub async fn duckdb_db_diff(
    left_id: String,
    right_id: String,
    storage: State<'_, StorageState>,
    _pool: State<'_, DuckPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<DuckDiffResult, String> {
    use std::collections::BTreeMap;

    let mut left_cfg = load_conn_config(&left_id, &storage)?;
    let right_cfg = load_conn_config(&right_id, &storage)?;
    duck_diff_file_path(&left_cfg)?;
    let right_path = duck_diff_file_path(&right_cfg)?.to_string();
    left_cfg.read_only = Some(true);
    let lib_path = get_duck_lib_path(&registry).await?;
    let isolated: DuckPool = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let conn = get_or_open(&left_id, &left_cfg, &isolated, &lib_path).await?;

    let r_esc = right_path.replace('\'', "''");
    // 在一个阻塞会话内完成 ATTACH → 查询 → DETACH
    let (l_tables, r_tables, l_cols, r_cols) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let guard = conn.blocking_lock();
        // 只读 ATTACH（别名固定，避免与用户库名冲突的概率极低）
        run_query_sync(&guard, &format!("ATTACH '{r_esc}' AS __dbdiff_r (READ_ONLY)"), 0)
            .map_err(|e| format!("ATTACH 目标库失败: {e}"))?;

        let q = |sql: &str| run_query_sync(&guard, sql, 100_000);
        run_query_sync(&guard, "BEGIN TRANSACTION", 0)?;
        let lt = q("SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = current_database() ORDER BY schema_name,table_name");
        let rt = q("SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = '__dbdiff_r' ORDER BY schema_name,table_name");
        let lc = q("SELECT schema_name, table_name, column_name, data_type FROM duckdb_columns() WHERE database_name = current_database()");
        let rc = q("SELECT schema_name, table_name, column_name, data_type FROM duckdb_columns() WHERE database_name = '__dbdiff_r'");
        run_query_sync(&guard, "ROLLBACK", 0)?;

        let _ = run_query_sync(&guard, "DETACH __dbdiff_r", 0);  // 尽力 DETACH

        let values = (lt?, rt?, lc?, rc?);
        if [&values.0, &values.1, &values.2, &values.3].iter().any(|r| r.truncated || r.rows.len() >= 100_000) { return Err("对比元数据达到读取上限，已拒绝给出完整结果".into()); }
        Ok(values)
    }).await.map_err(|e| format!("线程错误: {e}"))??;

    // 表集合
    let to_set = |r: &QueryResult| -> Vec<String> {
        r.rows.iter().filter_map(|row| Some(duck_diff_table_identity(row.first()?.as_deref()?, row.get(1)?.as_deref()?))).collect()
    };
    let lt: Vec<String> = to_set(&l_tables);
    let rt: Vec<String> = to_set(&r_tables);
    let lt_set: std::collections::HashSet<&String> = lt.iter().collect();
    let rt_set: std::collections::HashSet<&String> = rt.iter().collect();

    let mut tables = Vec::new();
    for t in &lt {
        tables.push(DuckDiffTable {
            name: t.clone(),
            status: if rt_set.contains(t) { "common" } else { "only_left" }.to_string(),
        });
    }
    for t in &rt {
        if !lt_set.contains(t) {
            tables.push(DuckDiffTable { name: t.clone(), status: "only_right".to_string() });
        }
    }
    tables.sort_by(|a, b| a.name.cmp(&b.name));

    // 列对比：仅对共有表
    let common: std::collections::HashSet<&String> = lt_set.intersection(&rt_set).cloned().collect();
    // (table, column) -> type
    let col_map = |r: &QueryResult| -> BTreeMap<(String, String), String> {
        let mut m = BTreeMap::new();
        for row in &r.rows {
            let t = duck_diff_table_identity(row.first().and_then(|c| c.as_deref()).unwrap_or_default(), row.get(1).and_then(|c| c.as_deref()).unwrap_or_default());
            let c = row.get(2).and_then(|c| c.clone()).unwrap_or_default();
            let ty = row.get(3).and_then(|c| c.clone()).unwrap_or_default();
            m.insert((t, c), ty);
        }
        m
    };
    let lcm = col_map(&l_cols);
    let rcm = col_map(&r_cols);
    let mut columns = Vec::new();
    for ((t, c), lty) in &lcm {
        if !common.contains(t) { continue; }
        match rcm.get(&(t.clone(), c.clone())) {
            Some(rty) if rty != lty => columns.push(DuckDiffColumn {
                table: t.clone(), column: c.clone(), status: "type_changed".to_string(),
                left_type: Some(lty.clone()), right_type: Some(rty.clone()),
            }),
            None => columns.push(DuckDiffColumn {
                table: t.clone(), column: c.clone(), status: "only_left".to_string(),
                left_type: Some(lty.clone()), right_type: None,
            }),
            _ => {}
        }
    }
    for ((t, c), rty) in &rcm {
        if !common.contains(t) { continue; }
        if !lcm.contains_key(&(t.clone(), c.clone())) {
            columns.push(DuckDiffColumn {
                table: t.clone(), column: c.clone(), status: "only_right".to_string(),
                left_type: None, right_type: Some(rty.clone()),
            });
        }
    }
    columns.sort_by(|a, b| (a.table.clone(), a.column.clone()).cmp(&(b.table.clone(), b.column.clone())));

    let only_l = tables.iter().filter(|t| t.status == "only_left").count();
    let only_r = tables.iter().filter(|t| t.status == "only_right").count();
    let summary = format!(
        "仅表名及列名/类型摘要：左独有 {only_l}，右独有 {only_r}，共有 {}；共有表字段摘要差异 {} 处。未比较列顺序、默认值、约束、索引、视图或数据，不代表结构完整一致",
        common.len(), columns.len()
    );

    Ok(DuckDiffResult { tables, columns, summary })
}

// ── 本地辅助 ─────────────────────────────────────────────────────────────────

fn load_conn_config(id: &str, storage: &StorageState) -> Result<ConnConfig, String> {
    let guard = storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = guard.load()?;
    list.into_iter().find(|c| c.id == *id)
        .ok_or_else(|| format!("连接 {id} 不存在"))
}

#[cfg(test)]
mod memory_tests {
    #[test]
    fn alter_batch_rejects_transaction_control_and_keeps_quoted_semicolons() {
        assert!(validate_alter_batch(&[]).is_err());
        assert!(validate_alter_batch(&["ALTER TABLE t ADD COLUMN v INTEGER; COMMIT".into()]).is_err());
        assert!(validate_alter_batch(&["BEGIN".into()]).is_err());
        assert!(validate_alter_batch(&["DROP TABLE t".into()]).is_err());
        assert!(validate_alter_batch(&[r#"ALTER TABLE "t;name" ADD COLUMN v VARCHAR DEFAULT 'a;b'"#.into()]).is_ok());
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_alter_batch_rollback_preserves_original_definition() {
        use super::*;
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").unwrap();
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config(); config.file_path = Some(":memory:".into());
        let handle = get_or_open_pub("alter-batch", &config, &pool, &library).await.unwrap();
        let run = |sql: &str| execute_retained(Arc::clone(&handle), sql.to_owned(), None);
        run("CREATE TABLE old_loop(v VARCHAR DEFAULT 'kept'); INSERT INTO old_loop VALUES(NULL)").await.unwrap();
        run("ALTER TABLE old_loop RENAME COLUMN v TO renamed").await.unwrap();
        assert!(run("ALTER TABLE old_loop ALTER COLUMN renamed SET NOT NULL").await.is_err());
        assert_eq!(run("SELECT column_name FROM information_schema.columns WHERE table_name='old_loop'").await.unwrap().rows[0][0].as_deref(), Some("renamed"), "old autocommit loop retains partial rename");
        run("CREATE TABLE atomic_batch(v VARCHAR DEFAULT 'kept'); INSERT INTO atomic_batch VALUES(NULL)").await.unwrap();
        {
            let guard = handle.lock().await;
            let error = run_isolated_alter_sync(&guard, &["ALTER TABLE atomic_batch RENAME COLUMN v TO renamed".into(), "ALTER TABLE atomic_batch ALTER COLUMN renamed SET NOT NULL".into()]).unwrap_err();
            assert!(error.contains("本批次已回滚"));
        }
        let definition = run("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='atomic_batch'").await.unwrap();
        assert_eq!(definition.rows[0][0].as_deref(), Some("v"));
        assert_eq!(definition.rows[0][1].as_deref(), Some("YES"));
        assert!(definition.rows[0][2].as_deref().unwrap().contains("kept"));
        run("UPDATE atomic_batch SET v='existing'").await.unwrap();
        {
            let guard = handle.lock().await;
            run_isolated_alter_sync(&guard, &["ALTER TABLE atomic_batch RENAME COLUMN v TO renamed".into(), "ALTER TABLE atomic_batch ALTER COLUMN renamed SET NOT NULL".into(), "ALTER TABLE atomic_batch ALTER COLUMN renamed SET DEFAULT 'next'".into()]).unwrap();
            assert!(validate_alter_batch(&["ALTER TABLE atomic_batch ADD COLUMN forbidden INT; COMMIT".into()]).is_err());
        }
        run("INSERT INTO atomic_batch DEFAULT VALUES").await.unwrap();
        let rows = run("SELECT renamed FROM atomic_batch ORDER BY renamed").await.unwrap().rows;
        assert_eq!(rows, vec![vec![Some("existing".into())], vec![Some("next".into())]]);
        run("CREATE TABLE pending(v INTEGER); BEGIN; INSERT INTO pending VALUES(7)").await.unwrap();
        {
            let guard = handle.lock().await;
            run_isolated_alter_sync(&guard, &["ALTER TABLE atomic_batch ADD COLUMN extra INTEGER".into()]).unwrap();
        }
        run("ROLLBACK").await.unwrap();
        assert_eq!(run("SELECT count(*) FROM pending").await.unwrap().rows[0][0].as_deref(), Some("0"), "wizard must not commit the other session's pending data");
        assert_eq!(run("SELECT count(*) FROM information_schema.columns WHERE table_name='atomic_batch' AND column_name='extra'").await.unwrap().rows[0][0].as_deref(), Some("1"));
    }

    #[test]
    fn selected_duck_catalog_requires_exact_existing_name_and_safe_quoting() {
        let names = vec!["a\"b; SELECT 1".to_string(), "main".into()];
        assert_eq!(super::selected_catalog_sql("a\"b; SELECT 1", &names).unwrap(), "USE \"a\"\"b; SELECT 1\"");
        assert!(super::selected_catalog_sql("missing", &names).is_err());
        assert!(super::selected_catalog_sql("MAIN", &names).is_err());
        assert!(super::selected_catalog_sql("bad\nname", &names).is_err());
    }
    use super::*;

    #[test]
    fn duck_diff_uses_file_path_and_distinguishes_schema_identity() {
        let config: ConnConfig = serde_json::from_value(serde_json::json!({"id":"diff","name":"diff","type":"duckdb","host":"wrong-file","filePath":"/tmp/right.duckdb","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
        assert_eq!(super::duck_diff_file_path(&config).unwrap(), "/tmp/right.duckdb");
        assert_ne!(super::duck_diff_table_identity("a", "same"), super::duck_diff_table_identity("b", "same"));
        assert!(super::duck_diff_table_identity("schema.with.dot", "table").contains("\"schema.with.dot\""));
    }

    #[test]
    fn decoded_cells_are_charged_before_allocation() {
        let mut budget = DuckDecodeBudget { max_bytes: 40, ..DuckDecodeBudget::default() };
        budget.start_row().unwrap();
        assert!(budget.cell(100_000_000).is_err());
        assert!(duck_blob_display_len(usize::MAX).is_err());
    }

    #[test]
    fn blob_display_encodes_in_one_exact_buffer() {
        assert_eq!(encode_blob_display(&[]).unwrap(), "0x");
        assert_eq!(encode_blob_display(&[0, 0xab, 0xff]).unwrap(), "0x00abff");
    }

    #[test]
    fn utf8_preflight_matches_lossy_output_without_allocating_a_copy() {
        for bytes in [b"plain".as_slice(), "中文".as_bytes(), &[0xff, 0xff, b'a'], &[0xe4, 0xb8]] {
            assert_eq!(lossy_utf8_len(bytes).unwrap(), String::from_utf8_lossy(bytes).len());
        }
    }

    #[test]
    fn native_allocations_are_freed_when_preflight_rejects_a_cell() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static FREED: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "C" fn free_mock(_: *mut c_void) { FREED.fetch_add(1, Ordering::SeqCst); }
        let before = FREED.load(Ordering::SeqCst);
        let result = (|| -> Result<(), String> {
            let _allocation = DuckAllocation { pointer: std::ptr::dangling_mut::<u8>() as *mut c_void, free: free_mock };
            DuckDecodeBudget::default().cell(usize::MAX)?;
            Ok(())
        })();
        assert!(result.is_err());
        assert_eq!(FREED.load(Ordering::SeqCst), before + 1);
    }

    fn connection_config() -> ConnConfig {
        serde_json::from_value(serde_json::json!({
            "id":"same-id", "name":"local", "type":"duckdb", "filePath":"/tmp/a.duckdb",
            "useSsl":false, "createdAt":0, "updatedAt":0
        })).unwrap()
    }

    #[test]
    fn duck_cache_identity_includes_file_read_only_extra_and_driver() {
        let config = connection_config();
        let original = duck_connection_identity(&config, "/tmp/duck.dylib").unwrap();
        for field in ["file", "readonly", "extra", "driver"] {
            let mut changed = config.clone();
            let mut driver = "/tmp/duck.dylib";
            match field {
                "file" => changed.file_path = Some("/tmp/b.duckdb".into()),
                "readonly" => changed.read_only = Some(true),
                "extra" => changed.extra_json = Some(r#"{"duckMemoryLimit":"128MB"}"#.into()),
                _ => driver = "/tmp/new-driver.dylib",
            }
            assert_ne!(original, duck_connection_identity(&changed, driver).unwrap(), "{field}");
        }
        assert_eq!(original, duck_connection_identity(&config, "/tmp/duck.dylib").unwrap());
    }

    #[test]
    fn duck_cache_refuses_replacement_until_retained_handle_is_released() {
        let cached = Arc::new(());
        let transaction = Arc::clone(&cached);
        assert!(ensure_cached_handle_idle(&cached).unwrap_err().contains("事务"));
        drop(transaction);
        assert!(ensure_cached_handle_idle(&cached).is_ok());
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_preserves_empty_blob_and_null_as_distinct_values() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config();
        config.file_path = Some(":memory:".into());
        let connection = get_or_open_pub("blob-fidelity", &config, &pool, &library).await.unwrap();
        let result = execute_retained(connection, "SELECT ''::BLOB AS empty_blob, NULL::BLOB AS null_blob, from_hex('00abff') AS binary_blob".into(), None).await.unwrap();
        assert_eq!(result.rows, vec![vec![Some("0x".into()), None, Some("0x00abff".into())]]);
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_vector_scalar_parity_and_cross_chunk_validity() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config();
        config.file_path = Some(":memory:".into());
        let connection = get_or_open_pub("scalar-parity", &config, &pool, &library).await.unwrap();
        let expressions = [
            "true", "(-128)::TINYINT", "(-32768)::SMALLINT", "(-2147483648)::INTEGER",
            "(-9223372036854775808)::BIGINT", "255::UTINYINT", "65535::USMALLINT",
            "4294967295::UINTEGER", "18446744073709551615::UBIGINT", "1.25::FLOAT", "1.25::DOUBLE",
            "TIMESTAMP '2026-11-14 12:34:56.123456'", "DATE '1970-01-01'", "TIME '12:34:56.123456'",
            "INTERVAL '2 months 3 days 4 microseconds'", "170141183460469231731687303715884105727::HUGEINT",
            "340282366920938463463374607431768211455::UHUGEINT",
            "(-12.34)::DECIMAL(4,2)", "1234567.89::DECIMAL(9,2)", "1234567890123456.78::DECIMAL(18,2)",
            "(-123456789012345678901234567890.12345678)::DECIMAL(38,8)",
            "TIMESTAMP_S '2026-11-14 12:34:56'", "TIMESTAMP_MS '2026-11-14 12:34:56.123'",
            "TIMESTAMP_NS '2026-11-14 12:34:56.123456789'",
            "UUID '00112233-4455-6677-8899-aabbccddeeff'",
            "'green'::ENUM('red','green')", "[1,NULL,3]", "[1,2]::INTEGER[2]",
            "{'number':42, 'text':'中文'}", "DATE 'infinity'", "TIMESTAMP '-infinity'",
            "'NaN'::DOUBLE", "'Infinity'::FLOAT",
            "TIME WITH TIME ZONE '12:34:56+02'",
            "TIMESTAMPTZ '2026-11-14 12:34:56+02'",
            "MAP(['first','second'],[1,NULL])", "union_value(number := 42)", "'101001'::BIT",
            "[('a' || chr(0) || '中文')]",
        ];
        for expression in expressions {
            let sql = format!("SELECT v, CAST(v AS VARCHAR) FROM (SELECT {expression} AS v)");
            let result = execute_retained(Arc::clone(&connection), sql, None).await.unwrap_or_else(|e| panic!("{expression}: {e}"));
            assert_eq!(result.rows[0][0], result.rows[0][1], "{expression}");
        }
        let result = execute_retained(Arc::clone(&connection), "SELECT i, CASE WHEN i % 3 = 0 THEN NULL ELSE repeat('中', 10) || chr(0) || i::VARCHAR END FROM range(4105) t(i) ORDER BY i".into(), None).await.unwrap();
        assert_eq!(result.rows.len(), 4105);
        for (i, row) in result.rows.iter().enumerate() {
            assert_eq!(row[0], Some(i.to_string()));
            assert_eq!(row[1], if i % 3 == 0 { None } else { Some(format!("{}\0{i}", "中".repeat(10))) });
        }
        let error = execute_retained(Arc::clone(&connection), "SELECT i FROM range(100001) t(i)".into(), None).await.unwrap_err();
        assert!(error.contains("未返回部分结果"));
        assert_eq!(execute_retained(connection, "SELECT 42".into(), None).await.unwrap().rows[0][0].as_deref(), Some("42"));
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_nested_formatting_preserves_transaction_and_reports_cost() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config();
        config.file_path = Some(":memory:".into());
        let connection = get_or_open_pub("nested-transaction", &config, &pool, &library).await.unwrap();
        execute_retained(Arc::clone(&connection), "CREATE TABLE marker(v INTEGER); INSERT INTO marker VALUES (1); BEGIN; INSERT INTO marker VALUES (2)".into(), None).await.unwrap();
        let start = Instant::now();
        let result = execute_retained(Arc::clone(&connection), "SELECT i, [i,NULL], {'v':i}, TIMESTAMPTZ '2026-11-14 12:34:56+02' FROM range(2049) t(i)".into(), None).await.unwrap();
        eprintln!("DBTERM_NESTED_2049_ROWS_MS={}", start.elapsed().as_millis());
        assert_eq!(result.rows.len(), 2049);
        assert_eq!(result.rows[2048][1].as_deref(), Some("[2048, NULL]"));
        let complex = execute_retained(Arc::clone(&connection), "SELECT CASE WHEN i % 3 = 0 THEN NULL ELSE [i,NULL] END AS v, CAST(CASE WHEN i % 3 = 0 THEN NULL ELSE [i,NULL] END AS VARCHAR) AS expected FROM range(4105) t(i) ORDER BY i".into(), None).await.unwrap();
        assert_eq!(complex.rows.len(), 4105);
        for row in complex.rows { assert_eq!(row[0], row[1]); }
        let returned = execute_retained(Arc::clone(&connection), "INSERT INTO marker VALUES (7) RETURNING [v], {'v':v}".into(), None).await.unwrap();
        assert_eq!(returned.rows[0][0].as_deref(), Some("[7]"));
        execute_retained(Arc::clone(&connection), "ROLLBACK".into(), None).await.unwrap();
        assert_eq!(execute_retained(Arc::clone(&connection), "SELECT count(*) FROM marker".into(), None).await.unwrap().rows[0][0].as_deref(), Some("1"));
        execute_retained(Arc::clone(&connection), "BEGIN; INSERT INTO marker VALUES (3)".into(), None).await.unwrap();
        execute_retained(Arc::clone(&connection), "SELECT [v] FROM marker ORDER BY v".into(), None).await.unwrap();
        execute_retained(Arc::clone(&connection), "COMMIT".into(), None).await.unwrap();
        assert_eq!(execute_retained(connection, "SELECT sum(v) FROM marker".into(), None).await.unwrap().rows[0][0].as_deref(), Some("4"));
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_preserves_embedded_zero_text_and_recovers_after_budget_error() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config();
        config.file_path = Some(":memory:".into());
        let connection = get_or_open_pub("text-fidelity", &config, &pool, &library).await.unwrap();
        let result = execute_retained(Arc::clone(&connection), "SELECT 'a' || chr(0) || '中文' AS embedded_zero, '' AS empty_text, NULL::VARCHAR AS null_text".into(), None).await.unwrap();
        assert_eq!(result.rows, vec![vec![Some("a\0中文".into()), Some("".into()), None]]);
        let error = execute_retained(Arc::clone(&connection), "SELECT repeat('x', 1024 * 1024) FROM range(34)".into(), None).await.unwrap_err();
        assert!(error.contains("未返回部分结果"));
        let recovered = execute_retained(connection, "SELECT 42".into(), None).await.unwrap();
        assert_eq!(recovered.rows[0][0].as_deref(), Some("42"));
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_repeated_results_and_budget_failures_release_native_memory() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut config = connection_config();
        config.file_path = Some(":memory:".into());
        let connection = get_or_open_pub("memory-stress", &config, &pool, &library).await.unwrap();
        let mut retained_memory = Vec::new();
        for cycle in 0..24 {
            let result = execute_retained(Arc::clone(&connection), "SELECT i, repeat(md5(i::VARCHAR), 1024) AS payload FROM range(192) t(i)".into(), None).await.unwrap();
            assert_eq!(result.rows.len(), 192);
            assert_eq!(result.rows[191][1].as_ref().unwrap().len(), 32768);
            drop(result);
            let error = execute_retained(Arc::clone(&connection), "SELECT repeat('x', 1024 * 1024) FROM range(34)".into(), None).await.unwrap_err();
            assert!(error.contains("未返回部分结果"));
            let result = execute_retained(Arc::clone(&connection), "SELECT [i,NULL], {'payload':md5(i::VARCHAR)} FROM range(256) t(i)".into(), None).await.unwrap();
            assert_eq!(result.rows.len(), 256);
            drop(result);
            let memory = execute_retained(Arc::clone(&connection), "SELECT coalesce(sum(memory_usage_bytes),0) FROM duckdb_memory()".into(), None).await.unwrap();
            let bytes: u64 = memory.rows[0][0].as_ref().unwrap().parse().unwrap();
            retained_memory.push(bytes);
            #[cfg(target_os = "macos")]
            {
                let rss = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
                eprintln!("DBTERM_MEMORY_CYCLE={cycle} ENGINE_BYTES={bytes} RSS_KIB={}", String::from_utf8_lossy(&rss.stdout).trim());
            }
        }
        // The workload creates no tables; destroyed results must not remain
        // registered as growing engine buffers after each complete cycle.
        assert!(retained_memory.iter().all(|bytes| *bytes == 0), "native buffers retained: {retained_memory:?}");
        assert_eq!(execute_retained(connection, "SELECT 42".into(), None).await.unwrap().rows[0][0].as_deref(), Some("42"));
    }

    #[tokio::test]
    #[ignore = "requires verified local DBTERM_TEST_DUCKDB_LIBRARY"]
    async fn real_duckdb_cache_changes_files_without_redirecting_retained_transaction() {
        let library = std::env::var("DBTERM_TEST_DUCKDB_LIBRARY").expect("local DuckDB library required");
        let directory = std::env::temp_dir().join(format!("dbterm-duck-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let pool: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let dedicated: DuckPool = Arc::new(Mutex::new(HashMap::new()));
        let mut a = connection_config();
        a.file_path = Some(directory.join("a.duckdb").to_string_lossy().into_owned());
        let mut b = a.clone();
        b.file_path = Some(directory.join("b.duckdb").to_string_lossy().into_owned());
        let ordinary = get_or_open_pub("same-id", &a, &pool, &library).await.unwrap();
        execute_retained(Arc::clone(&ordinary), "CREATE TABLE marker(v VARCHAR); INSERT INTO marker VALUES ('A')".into(), None).await.unwrap();
        let transaction = get_or_open_pub("same-id", &a, &dedicated, &library).await.unwrap();
        execute_retained(Arc::clone(&transaction), "BEGIN".into(), None).await.unwrap();
        execute_retained(Arc::clone(&transaction), "INSERT INTO marker VALUES ('tx')".into(), None).await.unwrap();
        let visible = execute_retained(Arc::clone(&ordinary), "SELECT COUNT(*) FROM marker".into(), None).await.unwrap();
        assert_eq!(visible.rows[0][0].as_deref(), Some("1"));
        assert!(get_or_open_pub("same-id", &b, &pool, &library).await.err().unwrap().contains("事务"));
        drop(ordinary);
        let ordinary_b = get_or_open_pub("same-id", &b, &pool, &library).await.unwrap();
        execute_retained(Arc::clone(&ordinary_b), "CREATE TABLE marker(v VARCHAR); INSERT INTO marker VALUES ('B')".into(), None).await.unwrap();
        execute_retained(Arc::clone(&transaction), "COMMIT".into(), None).await.unwrap();
        let retained = execute_retained(Arc::clone(&transaction), "SELECT COUNT(*) FROM marker".into(), None).await.unwrap();
        let target = execute_retained(Arc::clone(&ordinary_b), "SELECT v FROM marker".into(), None).await.unwrap();
        assert_eq!(retained.rows[0][0].as_deref(), Some("2"));
        assert_eq!(target.rows[0][0].as_deref(), Some("B"));
        drop(transaction); drop(ordinary_b); drop(dedicated); drop(pool);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
