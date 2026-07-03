// Oracle 数据库支持 — 通过 libloading 在运行时动态加载 OCI（Oracle Call Interface）。
// 无编译时依赖，用户通过驱动管理器下载 Oracle Instant Client 后即可使用。
// 后端代码完全隔离，不影响任何现有方言。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use crate::{
    models::{ConnConfig, TestResult, TableInfo as DbTableInfo},
    storage::StorageState,
};
use super::driver::DriverRegistry;

// ── 前端返回类型 ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleExecResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected_rows: Option<u64>,
    pub is_query: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTableInfo {
    pub name: String,
    pub object_type: String,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleColumnInfo {
    pub name: String,
    pub data_type: String,
    pub data_length: Option<String>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: String,
    pub unique: bool,
    pub index_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    pub constraint_type: String,
    pub columns: String,
    pub ref_table: Option<String>,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name: String,
    pub routine_type: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub table_name: String,
    pub trigger_type: String,
    pub event: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub name: String,
    pub min_value: String,
    pub max_value: String,
    pub increment_by: String,
    pub cycle: bool,
}

// ── Oracle 专属扩展配置 ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OracleExtra {
    #[serde(rename = "oraConnMode",    default)] pub conn_mode:    String,
    #[serde(rename = "oraServiceName", default)] pub service_name: String,
    #[serde(rename = "oraSid",         default)] pub sid:          String,
    #[serde(rename = "oraTnsAlias",    default)] pub tns_alias:    String,
    #[serde(rename = "oraRole",        default)] pub role:         String,
    #[serde(rename = "oraSchema",      default)] pub schema:       String,
}

impl OracleExtra {
    pub fn from_config(c: &ConnConfig) -> Self {
        c.extra_json.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }

    pub fn connect_string(&self, host: &str, port: u16) -> String {
        match self.conn_mode.as_str() {
            "sid" => format!(
                "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT={port}))\
                 (CONNECT_DATA=(SID={})))",
                if self.sid.is_empty() { "orcl" } else { &self.sid }
            ),
            "tns" => {
                if self.tns_alias.is_empty() { "orcl".to_string() } else { self.tns_alias.clone() }
            }
            _ => {
                let sn = if self.service_name.is_empty() { "orcl" } else { &self.service_name };
                format!("{host}:{port}/{sn}")
            }
        }
    }
}

// ── OCI 数值类型别名 ───────────────────────────────────────────────────────────

type Sword = i32;
type Ub4   = u32;
type Ub2   = u16;
type Sb4   = i32;
type OciHp = *mut std::ffi::c_void;

// ── OCI 返回码 ─────────────────────────────────────────────────────────────────

const OCI_SUCCESS:           Sword = 0;
const OCI_SUCCESS_WITH_INFO: Sword = 1;
const OCI_NO_DATA:           Sword = 100;

// ── OCI 句柄类型 ───────────────────────────────────────────────────────────────

const OCI_HTYPE_ENV:     Ub4 = 1;
const OCI_HTYPE_ERROR:   Ub4 = 2;
const OCI_HTYPE_SVCCTX:  Ub4 = 3;
const OCI_HTYPE_STMT:    Ub4 = 4;
#[allow(dead_code)]
const OCI_HTYPE_DEFINE:  Ub4 = 6;
const OCI_HTYPE_SERVER:  Ub4 = 8;
const OCI_HTYPE_SESSION: Ub4 = 9;

// ── OCI 描述符类型 ────────────────────────────────────────────────────────────

const OCI_DTYPE_PARAM: Ub4 = 53;

// ── OCI 属性类型 ───────────────────────────────────────────────────────────────

const OCI_ATTR_SERVER:      Ub4 = 6;
const OCI_ATTR_SESSION:     Ub4 = 7;
const OCI_ATTR_ROW_COUNT:   Ub4 = 9;
const OCI_ATTR_NAME:        Ub4 = 4;
#[allow(dead_code)]
const OCI_ATTR_DATA_SIZE:   Ub4 = 1;
const OCI_ATTR_PARAM_COUNT: Ub4 = 18;
const OCI_ATTR_USERNAME:    Ub4 = 22;
const OCI_ATTR_PASSWORD:    Ub4 = 23;

// ── OCI 模式常量 ───────────────────────────────────────────────────────────────

const OCI_DEFAULT:     Ub4 = 0;
const OCI_THREADED:    Ub4 = 1;
const OCI_SYSDBA:      Ub4 = 2;
const OCI_SYSOPER:     Ub4 = 4;
const OCI_CRED_RDBMS:  Ub4 = 1;
const OCI_NTV_SYNTAX:  Ub4 = 1;
const OCI_FETCH_NEXT:  Ub2 = 2;
const SQLT_CHR:        Ub2 = 1;

// 查询每列最大缓冲区（4K）；DDL/CLOB 使用更大缓冲
const QUERY_BUF_SIZE: usize = 4096;
const DDL_BUF_SIZE:   usize = 65536;
const MAX_FETCH_ROWS: usize = 50_000;

// ── OCI 函数指针类型 ───────────────────────────────────────────────────────────

type FnEnvCreate   = unsafe extern "C" fn(*mut OciHp,Ub4,OciHp,OciHp,OciHp,OciHp,usize,*mut OciHp) -> Sword;
type FnHandleAlloc = unsafe extern "C" fn(OciHp,*mut OciHp,Ub4,usize,*mut OciHp) -> Sword;
type FnHandleFree  = unsafe extern "C" fn(OciHp,Ub4) -> Sword;
type FnServerAtt   = unsafe extern "C" fn(OciHp,OciHp,*const u8,Sb4,Ub4) -> Sword;
type FnServerDet   = unsafe extern "C" fn(OciHp,OciHp,Ub4) -> Sword;
type FnAttrSet     = unsafe extern "C" fn(OciHp,Ub4,*const std::ffi::c_void,Ub4,Ub4,OciHp) -> Sword;
type FnAttrGet     = unsafe extern "C" fn(OciHp,Ub4,*mut std::ffi::c_void,*mut Ub4,Ub4,OciHp) -> Sword;
type FnSessBegin   = unsafe extern "C" fn(OciHp,OciHp,OciHp,Ub4,Ub4) -> Sword;
type FnSessEnd     = unsafe extern "C" fn(OciHp,OciHp,OciHp,Ub4) -> Sword;
type FnStmtPrep2   = unsafe extern "C" fn(OciHp,*mut OciHp,OciHp,*const u8,Ub4,*const u8,Ub4,Ub4,Ub4) -> Sword;
type FnStmtRel     = unsafe extern "C" fn(OciHp,OciHp,*const u8,Ub4,Ub4) -> Sword;
type FnStmtExec    = unsafe extern "C" fn(OciHp,OciHp,OciHp,Ub4,Ub4,OciHp,OciHp,Ub4) -> Sword;
type FnDefByPos    = unsafe extern "C" fn(OciHp,*mut OciHp,OciHp,Ub4,*mut std::ffi::c_void,Sb4,Ub2,*mut i16,*mut Ub2,*mut Ub2,Ub4) -> Sword;
type FnFetch2      = unsafe extern "C" fn(OciHp,OciHp,Ub4,Ub2,Sb4,Ub4) -> Sword;
type FnErrGet      = unsafe extern "C" fn(OciHp,Ub4,*mut u8,*mut i32,*mut u8,Ub4,Ub4) -> Sword;
type FnParamGet    = unsafe extern "C" fn(OciHp,Ub4,OciHp,*mut OciHp,Ub4) -> Sword;
type FnTransCommit   = unsafe extern "C" fn(OciHp,OciHp,Ub4) -> Sword;
type FnTransRollback = unsafe extern "C" fn(OciHp,OciHp,Ub4) -> Sword;

// ── OCI 动态库封装 ─────────────────────────────────────────────────────────────

struct OciLib {
    env_create:   FnEnvCreate,
    handle_alloc: FnHandleAlloc,
    handle_free:  FnHandleFree,
    server_att:   FnServerAtt,
    server_det:   FnServerDet,
    attr_set:     FnAttrSet,
    attr_get:     FnAttrGet,
    sess_begin:   FnSessBegin,
    sess_end:     FnSessEnd,
    stmt_prep2:   FnStmtPrep2,
    stmt_rel:     FnStmtRel,
    stmt_exec:    FnStmtExec,
    def_by_pos:   FnDefByPos,
    fetch2:       FnFetch2,
    err_get:      FnErrGet,
    param_get:    FnParamGet,
    trans_commit:   FnTransCommit,
    trans_rollback: FnTransRollback,
    // _lib 必须最后声明：Rust 按声明逆序 drop 字段，保证清理期间库仍已加载
    _lib:           libloading::Library,
}

impl OciLib {
    fn load(oci_dir: &Path) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let dir_str = oci_dir.to_string_lossy();
            let current = std::env::var("PATH").unwrap_or_default();
            if !current.to_lowercase().contains(dir_str.to_lowercase().as_str()) {
                unsafe { std::env::set_var("PATH", format!("{};{}", dir_str, current)); }
            }
        }
        #[cfg(target_os = "linux")]
        {
            let dir_str = oci_dir.to_string_lossy();
            let current = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            if !current.contains(dir_str.as_ref()) {
                unsafe { std::env::set_var("LD_LIBRARY_PATH", format!("{}:{}", dir_str, current)); }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let dir_str = oci_dir.to_string_lossy();
            let current = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
            if !current.contains(dir_str.as_ref()) {
                unsafe { std::env::set_var("DYLD_LIBRARY_PATH", format!("{}:{}", dir_str, current)); }
            }
        }

        #[cfg(windows)]              let lib_name = "oci.dll";
        #[cfg(target_os = "linux")]  let lib_name = "libclntsh.so";
        #[cfg(target_os = "macos")]  let lib_name = "libclntsh.dylib";
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        let lib_name = "libclntsh.so";

        let lib_path = oci_dir.join(lib_name);
        // 必须用 RTLD_GLOBAL：OCI 内部通过全局符号表解析依赖，
        // RTLD_LOCAL（libloading 默认）会导致 OCIEnvCreate 内 SIGSEGV。
        let lib = unsafe {
            #[cfg(unix)]
            {
                use libloading::os::unix::{Library as UnixLib, RTLD_LAZY, RTLD_GLOBAL};
                let ul = UnixLib::open(Some(&lib_path), RTLD_LAZY | RTLD_GLOBAL)
                    .map_err(|e| format!(
                        "无法加载 Oracle Instant Client（{lib_name}）。\n\
                         请确认已下载并解压到正确目录，且文件完整。\n错误：{e}"
                    ))?;
                libloading::Library::from(ul)
            }
            #[cfg(not(unix))]
            {
                libloading::Library::new(&lib_path).map_err(|e| format!(
                    "无法加载 Oracle Instant Client（{lib_name}）。\n\
                     请确认已下载并解压到正确目录，且文件完整。\n错误：{e}"
                ))?
            }
        };

        macro_rules! sym {
            ($name:literal, $t:ty) => {{
                let s: libloading::Symbol<$t> = unsafe {
                    lib.get($name).map_err(|e| format!(
                        "OCI 函数 {} 未找到（可能是 Instant Client 版本过低）：{e}",
                        String::from_utf8_lossy($name)
                    ))?
                };
                *s
            }};
        }

        Ok(Self {
            env_create:   sym!(b"OCIEnvCreate",    FnEnvCreate),
            handle_alloc: sym!(b"OCIHandleAlloc",  FnHandleAlloc),
            handle_free:  sym!(b"OCIHandleFree",   FnHandleFree),
            server_att:   sym!(b"OCIServerAttach", FnServerAtt),
            server_det:   sym!(b"OCIServerDetach", FnServerDet),
            attr_set:     sym!(b"OCIAttrSet",      FnAttrSet),
            attr_get:     sym!(b"OCIAttrGet",      FnAttrGet),
            sess_begin:   sym!(b"OCISessionBegin", FnSessBegin),
            sess_end:     sym!(b"OCISessionEnd",   FnSessEnd),
            stmt_prep2:   sym!(b"OCIStmtPrepare2", FnStmtPrep2),
            stmt_rel:     sym!(b"OCIStmtRelease",  FnStmtRel),
            stmt_exec:    sym!(b"OCIStmtExecute",  FnStmtExec),
            def_by_pos:   sym!(b"OCIDefineByPos",  FnDefByPos),
            fetch2:       sym!(b"OCIStmtFetch2",   FnFetch2),
            err_get:      sym!(b"OCIErrorGet",     FnErrGet),
            param_get:    sym!(b"OCIParamGet",     FnParamGet),
            trans_commit:   sym!(b"OCITransCommit",   FnTransCommit),
            trans_rollback: sym!(b"OCITransRollback", FnTransRollback),
            _lib:           lib,
        })
    }

    fn oci_errmsg(&self, errhp: OciHp) -> String {
        let mut buf = vec![0u8; 1024];
        let mut code: i32 = 0;
        unsafe {
            (self.err_get)(errhp, 1, std::ptr::null_mut(), &mut code,
                buf.as_mut_ptr(), buf.len() as Ub4, OCI_HTYPE_ERROR);
        }
        let msg = String::from_utf8_lossy(&buf)
            .trim_end_matches('\0').trim().to_string();
        if msg.is_empty() { format!("ORA-{code:05}") } else { msg }
    }

    fn ok(&self, rc: Sword, errhp: OciHp, op: &str) -> Result<(), String> {
        match rc {
            OCI_SUCCESS | OCI_SUCCESS_WITH_INFO => Ok(()),
            _ => Err(format!("{op}: {}", self.oci_errmsg(errhp))),
        }
    }
}

// ── OCI 会话句柄（带 Drop 自动清理）─────────────────────────────────────────────

struct OciHandles {
    errhp:           OciHp,
    srvhp:           OciHp,
    svchp:           OciHp,
    usrhp:           OciHp,
    env:             OciHp,
    session_open:    bool,
    server_attached: bool,
    oci:             OciLib,
}

impl Drop for OciHandles {
    fn drop(&mut self) {
        unsafe {
            if self.session_open {
                (self.oci.sess_end)(self.svchp, self.errhp, self.usrhp, OCI_DEFAULT);
            }
            if self.server_attached {
                (self.oci.server_det)(self.srvhp, self.errhp, OCI_DEFAULT);
            }
            if !self.usrhp.is_null() { (self.oci.handle_free)(self.usrhp, OCI_HTYPE_SESSION); }
            if !self.svchp.is_null() { (self.oci.handle_free)(self.svchp, OCI_HTYPE_SVCCTX); }
            if !self.srvhp.is_null() { (self.oci.handle_free)(self.srvhp, OCI_HTYPE_SERVER); }
            if !self.errhp.is_null() { (self.oci.handle_free)(self.errhp, OCI_HTYPE_ERROR); }
            if !self.env.is_null()   { (self.oci.handle_free)(self.env,   OCI_HTYPE_ENV); }
        }
    }
}

unsafe impl Send for OciHandles {}

impl OciHandles {
    fn connect(oci: OciLib, user: &str, pass: &str, conn_str: &str, auth_mode: Ub4)
        -> Result<Self, String>
    {
        let null_hp: OciHp = std::ptr::null_mut();
        let mut env:   OciHp = null_hp;
        let mut errhp: OciHp = null_hp;
        let mut srvhp: OciHp = null_hp;
        let mut svchp: OciHp = null_hp;
        let mut usrhp: OciHp = null_hp;

        // 确保 OCI 使用 UTF-8，避免中文等多字节字符返回 '??'
        if std::env::var("NLS_LANG").is_err() {
            unsafe { std::env::set_var("NLS_LANG", "AMERICAN_AMERICA.AL32UTF8") };
        }
        let rc = unsafe {
            (oci.env_create)(&mut env, OCI_THREADED, null_hp, null_hp, null_hp, null_hp, 0, std::ptr::null_mut())
        };
        if rc != OCI_SUCCESS && rc != OCI_SUCCESS_WITH_INFO {
            return Err("OCIEnvCreate 失败：无法初始化 Oracle 环境，请确认 Instant Client 版本兼容".into());
        }

        let alloc = |typ: Ub4, out: *mut OciHp, op: &str| -> Result<(), String> {
            let rc = unsafe { (oci.handle_alloc)(env, out, typ, 0, std::ptr::null_mut()) };
            if rc != OCI_SUCCESS { Err(format!("{op} 句柄分配失败")) } else { Ok(()) }
        };
        alloc(OCI_HTYPE_ERROR,   &mut errhp, "OCIHandleAlloc(error)")?;
        alloc(OCI_HTYPE_SERVER,  &mut srvhp, "OCIHandleAlloc(server)")?;
        alloc(OCI_HTYPE_SVCCTX,  &mut svchp, "OCIHandleAlloc(svcctx)")?;
        alloc(OCI_HTYPE_SESSION, &mut usrhp, "OCIHandleAlloc(session)")?;

        let mut h = OciHandles {
            oci, env, errhp, srvhp, svchp, usrhp,
            session_open: false, server_attached: false,
        };

        let cs = conn_str.as_bytes();
        let rc = unsafe { (h.oci.server_att)(srvhp, errhp, cs.as_ptr(), cs.len() as Sb4, OCI_DEFAULT) };
        h.oci.ok(rc, errhp, "OCIServerAttach")?;
        h.server_attached = true;

        let rc = unsafe { (h.oci.attr_set)(svchp, OCI_HTYPE_SVCCTX, srvhp, 0, OCI_ATTR_SERVER, errhp) };
        h.oci.ok(rc, errhp, "OCIAttrSet(server)")?;

        let ub = user.as_bytes();
        let rc = unsafe { (h.oci.attr_set)(usrhp, OCI_HTYPE_SESSION, ub.as_ptr().cast(), ub.len() as Ub4, OCI_ATTR_USERNAME, errhp) };
        h.oci.ok(rc, errhp, "OCIAttrSet(username)")?;

        let pb = pass.as_bytes();
        let rc = unsafe { (h.oci.attr_set)(usrhp, OCI_HTYPE_SESSION, pb.as_ptr().cast(), pb.len() as Ub4, OCI_ATTR_PASSWORD, errhp) };
        h.oci.ok(rc, errhp, "OCIAttrSet(password)")?;

        let rc = unsafe { (h.oci.sess_begin)(svchp, errhp, usrhp, OCI_CRED_RDBMS, auth_mode) };
        h.oci.ok(rc, errhp, "OCISessionBegin")?;
        h.session_open = true;

        let rc = unsafe { (h.oci.attr_set)(svchp, OCI_HTYPE_SVCCTX, usrhp, 0, OCI_ATTR_SESSION, errhp) };
        h.oci.ok(rc, errhp, "OCIAttrSet(session)")?;

        Ok(h)
    }

    fn test_query(&self) -> Result<(), String> {
        let sql = b"SELECT 1 FROM DUAL";
        let mut stmthp: OciHp = std::ptr::null_mut();
        let rc = unsafe {
            (self.oci.stmt_prep2)(self.svchp, &mut stmthp, self.errhp,
                sql.as_ptr(), sql.len() as Ub4,
                std::ptr::null(), 0, OCI_NTV_SYNTAX, OCI_DEFAULT)
        };
        self.oci.ok(rc, self.errhp, "OCIStmtPrepare2")?;

        let rc = unsafe {
            (self.oci.stmt_exec)(self.svchp, stmthp, self.errhp,
                0, 0, std::ptr::null_mut(), std::ptr::null_mut(), OCI_DEFAULT)
        };
        if let Err(e) = self.oci.ok(rc, self.errhp, "OCIStmtExecute") {
            unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
            return Err(e);
        }

        let mut buf = [0u8; 32];
        let mut ind: i16 = 0;
        let mut rlen: Ub2 = 0;
        let mut rcode: Ub2 = 0;
        let mut defhp: OciHp = std::ptr::null_mut();
        let rc = unsafe {
            (self.oci.def_by_pos)(stmthp, &mut defhp, self.errhp,
                1, buf.as_mut_ptr().cast(), buf.len() as Sb4,
                SQLT_CHR, &mut ind, &mut rlen, &mut rcode, OCI_DEFAULT)
        };
        let _ = self.oci.ok(rc, self.errhp, "OCIDefineByPos");
        let rc = unsafe { (self.oci.fetch2)(stmthp, self.errhp, 1, OCI_FETCH_NEXT, 0, OCI_DEFAULT) };
        let _ = self.oci.ok(rc, self.errhp, "OCIStmtFetch2");
        unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
        Ok(())
    }

    /// 执行 SELECT，返回 (列名列表, 行数据)；每列最多 QUERY_BUF_SIZE 字节
    fn query_rows(&self, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
        self.query_rows_impl(sql, QUERY_BUF_SIZE)
    }

    /// 执行单列大文本查询（DDL/CLOB），返回第一行第一列字符串
    fn query_single_text(&self, sql: &str) -> Result<Option<String>, String> {
        let (_, rows) = self.query_rows_impl(sql, DDL_BUF_SIZE)?;
        Ok(rows.into_iter().next().and_then(|r| r.into_iter().next().flatten()))
    }

    fn query_rows_impl(&self, sql: &str, buf_size: usize) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
        let sql_bytes = sql.as_bytes();
        let mut stmthp: OciHp = std::ptr::null_mut();

        let rc = unsafe {
            (self.oci.stmt_prep2)(self.svchp, &mut stmthp, self.errhp,
                sql_bytes.as_ptr(), sql_bytes.len() as Ub4,
                std::ptr::null(), 0, OCI_NTV_SYNTAX, OCI_DEFAULT)
        };
        self.oci.ok(rc, self.errhp, "OCIStmtPrepare2")?;

        let exec_rc = unsafe {
            (self.oci.stmt_exec)(self.svchp, stmthp, self.errhp,
                0, 0, std::ptr::null_mut(), std::ptr::null_mut(), OCI_DEFAULT)
        };
        if let Err(e) = self.oci.ok(exec_rc, self.errhp, "OCIStmtExecute") {
            unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
            return Err(e);
        }

        // 获取列数
        let mut col_count: Ub4 = 0;
        let rc = unsafe {
            (self.oci.attr_get)(
                stmthp, OCI_HTYPE_STMT,
                (&mut col_count as *mut Ub4).cast(),
                std::ptr::null_mut(), OCI_ATTR_PARAM_COUNT, self.errhp,
            )
        };
        if let Err(e) = self.oci.ok(rc, self.errhp, "OCIAttrGet(param_count)") {
            unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
            return Err(e);
        }
        let ncols = col_count as usize;
        if ncols == 0 {
            unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
            return Ok((vec![], vec![]));
        }

        // 获取列名并分配缓冲区
        let mut col_names: Vec<String> = Vec::with_capacity(ncols);
        // 每列一个堆分配缓冲，地址固定（不 resize）
        let mut buffers: Vec<Vec<u8>> = (0..ncols).map(|_| vec![0u8; buf_size]).collect();
        let mut indicators: Vec<i16> = vec![0i16; ncols];
        let mut ret_lens:   Vec<Ub2>  = vec![0u16; ncols];
        let mut ret_codes:  Vec<Ub2>  = vec![0u16; ncols];

        for i in 0..ncols {
            let mut col_desc: OciHp = std::ptr::null_mut();
            let rc = unsafe {
                (self.oci.param_get)(stmthp, OCI_HTYPE_STMT, self.errhp, &mut col_desc, (i + 1) as Ub4)
            };
            if let Err(e) = self.oci.ok(rc, self.errhp, "OCIParamGet") {
                unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
                return Err(e);
            }

            let mut name_ptr: *mut u8 = std::ptr::null_mut();
            let mut name_len: Ub4 = 0;
            unsafe {
                (self.oci.attr_get)(
                    col_desc, OCI_DTYPE_PARAM,
                    (&mut name_ptr as *mut *mut u8).cast(),
                    &mut name_len, OCI_ATTR_NAME, self.errhp,
                );
            }
            let name = if !name_ptr.is_null() && name_len > 0 {
                unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(name_ptr, name_len as usize)).to_string() }
            } else {
                format!("COL{}", i + 1)
            };
            col_names.push(name);
        }

        // 预先获取各 Vec 的稳定原始指针（不 resize，地址不变）
        let ind_ptr   = indicators.as_mut_ptr();
        let rlen_ptr  = ret_lens.as_mut_ptr();
        let rcode_ptr = ret_codes.as_mut_ptr();

        // 绑定每列输出缓冲
        for i in 0..ncols {
            let buf_ptr = buffers[i].as_mut_ptr();
            let mut defhp: OciHp = std::ptr::null_mut();
            let rc = unsafe {
                (self.oci.def_by_pos)(
                    stmthp, &mut defhp, self.errhp,
                    (i + 1) as Ub4,
                    buf_ptr.cast(), buf_size as Sb4,
                    SQLT_CHR,
                    ind_ptr.add(i),
                    rlen_ptr.add(i),
                    rcode_ptr.add(i),
                    OCI_DEFAULT,
                )
            };
            if let Err(e) = self.oci.ok(rc, self.errhp, "OCIDefineByPos") {
                unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
                return Err(e);
            }
        }

        // Fetch 循环
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        loop {
            if rows.len() >= MAX_FETCH_ROWS { break; }
            let rc = unsafe {
                (self.oci.fetch2)(stmthp, self.errhp, 1, OCI_FETCH_NEXT, 0, OCI_DEFAULT)
            };
            if rc == OCI_NO_DATA { break; }
            if let Err(e) = self.oci.ok(rc, self.errhp, "OCIStmtFetch2") {
                unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
                return Err(e);
            }
            let mut row = Vec::with_capacity(ncols);
            for i in 0..ncols {
                let ind = unsafe { *ind_ptr.add(i) };
                if ind == -1 {
                    row.push(None);
                } else {
                    let len = unsafe { *rlen_ptr.add(i) } as usize;
                    let s = String::from_utf8_lossy(&buffers[i][..len]).to_string();
                    row.push(Some(s));
                }
            }
            rows.push(row);
        }

        unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
        Ok((col_names, rows))
    }

    /// 执行 DML（iters=1），提交，返回受影响行数
    fn execute_dml(&self, sql: &str) -> Result<u64, String> {
        self.execute_stmt_internal(sql, true)
    }

    /// 执行 DDL（Oracle 自动提交，无需显式 commit）
    fn execute_ddl(&self, sql: &str) -> Result<(), String> {
        self.execute_stmt_internal(sql, false).map(|_| ())
    }

    /// DML in transaction（不提交，供手动事务使用）
    fn execute_in_tx(&self, sql: &str) -> Result<u64, String> {
        self.execute_stmt_internal(sql, false)
    }

    /// 显式提交事务
    fn commit_tx(&self) {
        unsafe { (self.oci.trans_commit)(self.svchp, self.errhp, OCI_DEFAULT); }
    }

    /// 显式回滚事务
    fn rollback_tx(&self) {
        unsafe { (self.oci.trans_rollback)(self.svchp, self.errhp, OCI_DEFAULT); }
    }

    fn execute_stmt_internal(&self, sql: &str, commit: bool) -> Result<u64, String> {
        let sql_bytes = sql.as_bytes();
        let mut stmthp: OciHp = std::ptr::null_mut();

        let rc = unsafe {
            (self.oci.stmt_prep2)(self.svchp, &mut stmthp, self.errhp,
                sql_bytes.as_ptr(), sql_bytes.len() as Ub4,
                std::ptr::null(), 0, OCI_NTV_SYNTAX, OCI_DEFAULT)
        };
        self.oci.ok(rc, self.errhp, "OCIStmtPrepare2")?;

        let exec_rc = unsafe {
            (self.oci.stmt_exec)(self.svchp, stmthp, self.errhp,
                1, 0, std::ptr::null_mut(), std::ptr::null_mut(), OCI_DEFAULT)
        };

        let row_count: u64 = if exec_rc == OCI_SUCCESS || exec_rc == OCI_SUCCESS_WITH_INFO {
            let mut cnt: Ub4 = 0;
            unsafe {
                (self.oci.attr_get)(stmthp, OCI_HTYPE_STMT,
                    (&mut cnt as *mut Ub4).cast(), std::ptr::null_mut(),
                    OCI_ATTR_ROW_COUNT, self.errhp);
            }
            cnt as u64
        } else { 0 };

        unsafe { (self.oci.stmt_rel)(stmthp, self.errhp, std::ptr::null(), 0, OCI_DEFAULT); }
        self.oci.ok(exec_rc, self.errhp, "OCIStmtExecute")?;

        if commit {
            unsafe { (self.oci.trans_commit)(self.svchp, self.errhp, OCI_DEFAULT); }
        }
        Ok(row_count)
    }
}

// ── Oracle 持久事务池 ──────────────────────────────────────────────────────────

/// Oracle 持久连接事务池（连接ID → OciHandles 持有者）
pub struct OracleTxPool(std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<OciHandles>>>>);

impl OracleTxPool {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(std::collections::HashMap::new()))
    }
}

/// 开始 Oracle 事务：建立持久连接并存入池
pub async fn oracle_begin_tx(
    conn_id: String,
    config: ConnConfig,
    password: Option<String>,
    registry: &DriverRegistry,
    pool: &OracleTxPool,
) -> Result<(), String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    let handles = tokio::task::spawn_blocking(move || {
        connect_with_config(&config, &pass, &oci_path)
    }).await.map_err(|e| format!("任务失败: {e}"))??;
    let arc = std::sync::Arc::new(std::sync::Mutex::new(handles));
    pool.0.lock().map_err(|e| e.to_string())?.insert(conn_id, arc);
    Ok(())
}

/// 在 Oracle 事务连接上执行 SQL（不提交）
pub async fn oracle_exec_in_tx(
    conn_id: &str,
    sql: String,
    pool: &OracleTxPool,
    start: std::time::Instant,
) -> Result<crate::models::QueryResult, String> {
    let arc = {
        let map = pool.0.lock().map_err(|e| e.to_string())?;
        map.get(conn_id).ok_or("Oracle 事务连接不存在，请先 BEGIN")?.clone()
    };
    let is_query = is_select_sql(&sql);
    tokio::task::spawn_blocking(move || {
        let h = arc.lock().map_err(|e| e.to_string())?;
        if is_query {
            let (columns, rows) = h.query_rows(&sql)?;
            Ok(crate::models::QueryResult {
                columns, rows, rows_affected: 0,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: true,
            })
        } else {
            let n = h.execute_in_tx(&sql)?;
            Ok(crate::models::QueryResult {
                columns: vec![], rows: vec![], rows_affected: n,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: false,
            })
        }
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

/// 提交 Oracle 事务并从池中移除连接
pub async fn oracle_commit_tx(conn_id: &str, pool: &OracleTxPool) -> Result<(), String> {
    let arc = {
        let mut map = pool.0.lock().map_err(|e| e.to_string())?;
        map.remove(conn_id).ok_or("Oracle 事务连接不存在")?
    };
    tokio::task::spawn_blocking(move || {
        let h = arc.lock().map_err(|e| e.to_string())?;
        h.commit_tx();
        Ok(())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

/// 回滚 Oracle 事务并从池中移除连接
pub async fn oracle_rollback_tx(conn_id: &str, pool: &OracleTxPool) -> Result<(), String> {
    let arc = {
        let mut map = pool.0.lock().map_err(|e| e.to_string())?;
        map.remove(conn_id).ok_or("Oracle 事务连接不存在")?
    };
    tokio::task::spawn_blocking(move || {
        let h = arc.lock().map_err(|e| e.to_string())?;
        h.rollback_tx();
        Ok(())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ── 内部辅助函数 ───────────────────────────────────────────────────────────────

async fn get_oci_path(registry: &DriverRegistry) -> Result<PathBuf, String> {
    let reg = registry.lock().await;
    let path = reg.get("oracle")
        .and_then(|s| s.custom_path.clone())
        .map(PathBuf::from)
        .ok_or_else(|| "Oracle Instant Client 未配置，请在「驱动管理」下载并配置".to_string())?;
    if !path.exists() {
        return Err("Oracle Instant Client 目录不存在，请重新下载".to_string());
    }
    Ok(path)
}

fn connect_with_config(config: &ConnConfig, password: &str, oci_path: &Path) -> Result<OciHandles, String> {
    let host = config.host.as_deref().unwrap_or("127.0.0.1");
    let port = config.port.unwrap_or(1521);
    let user = config.username.as_deref().unwrap_or("system");
    let extra = OracleExtra::from_config(config);
    let conn_str = extra.connect_string(host, port);
    let auth_mode = match extra.role.as_str() {
        "sysdba"  => OCI_SYSDBA,
        "sysoper" => OCI_SYSOPER,
        _         => OCI_DEFAULT,
    };
    let oci = OciLib::load(oci_path)?;
    OciHandles::connect(oci, user, password, &conn_str, auth_mode)
}

/// Oracle 标识符双引号转义（防止注入）
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Oracle 字符串字面量（单引号转义）
fn escape_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 可选值转 Oracle SQL 字面量（NULL 或带引号字符串）
fn oracle_literal(val: &Option<String>) -> String {
    match val {
        None => "NULL".to_string(),
        Some(s) => escape_str(s),
    }
}

/// 验证 Oracle 标识符（防止 SQL 注入；用于用户/角色名输入）
fn validate_ident(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 {
        return Err(format!("标识符长度无效（1-128 个字符）"));
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#')) {
        return Err(format!("标识符只能包含字母、数字、_、$、# 字符"));
    }
    Ok(())
}

/// 验证 SID / SERIAL# 为纯整数（Oracle 内部编号，非用户自定义值）
fn validate_numeric_id(s: &str, field: &str) -> Result<(), String> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{field} 必须为纯数字"));
    }
    Ok(())
}

/// 验证权限字符串（只允许字母、数字、空格、_）
/// Oracle 系统/对象权限均由这些字符构成（CREATE SESSION、SELECT、DBA 等）
fn validate_privilege(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 100 {
        return Err("权限名无效（1-100 字符）".to_string());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_')) {
        return Err("权限名只能包含字母、数字、空格、_ 字符".to_string());
    }
    Ok(())
}

/// 验证 ON 子句的对象引用（schema.object 格式）
fn validate_object_ref(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 200 {
        return Err("对象名无效".to_string());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#' | '.' | '"')) {
        return Err("对象名包含非法字符".to_string());
    }
    Ok(())
}

fn load_conn(id: &str, storage: &State<'_, StorageState>)
    -> Result<(ConnConfig, Option<String>), String>
{
    let config = storage.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .load()?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id).ok().flatten();
    Ok((config, password))
}

fn is_select_sql(sql: &str) -> bool {
    let s = sql.trim().to_uppercase();
    s.starts_with("SELECT") || s.starts_with("WITH") || s.starts_with("(SELECT")
}

// ── OR0：连接测试 ──────────────────────────────────────────────────────────────

pub async fn test_connection(
    config: &ConnConfig,
    password: Option<&str>,
    registry: &DriverRegistry,
) -> TestResult {
    let oci_dir = {
        let reg = registry.lock().await;
        reg.get("oracle")
            .and_then(|s| s.custom_path.clone())
            .map(PathBuf::from)
    };

    let oci_dir = match oci_dir {
        Some(d) if d.exists() => d,
        _ => return TestResult {
            success: false,
            message: "Oracle Instant Client 未配置或目录不存在。\n\
                      请在「驱动管理」标签下载并配置 Oracle Instant Client。".into(),
            latency_ms: None,
        },
    };

    let host = config.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let port = config.port.unwrap_or(1521);
    let user = config.username.clone().unwrap_or_else(|| "system".into());
    let pass = password.unwrap_or("").to_string();
    let extra = OracleExtra::from_config(config);
    let conn_str = extra.connect_string(&host, port);
    let auth_mode: Ub4 = match extra.role.as_str() {
        "sysdba"  => OCI_SYSDBA,
        "sysoper" => OCI_SYSOPER,
        _         => OCI_DEFAULT,
    };

    let start = std::time::Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let oci = OciLib::load(&oci_dir)?;
        let sess = OciHandles::connect(oci, &user, &pass, &conn_str, auth_mode)?;
        sess.test_query()?;
        Ok::<String, String>("Oracle 连接成功（SELECT 1 FROM DUAL）".into())
    }).await;

    let latency_ms = Some(start.elapsed().as_millis() as u64);
    match result {
        Ok(Ok(msg)) => TestResult { success: true, message: msg, latency_ms },
        Ok(Err(e))  => TestResult { success: false, message: e, latency_ms },
        Err(e)      => TestResult { success: false, message: format!("任务执行失败: {e}"), latency_ms },
    }
}

#[tauri::command]
pub async fn oracle_test_connection(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<TestResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    Ok(test_connection(&config, password.as_deref(), &*registry).await)
}

// ── OR1：通用查询 ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oracle_execute_query(
    id: String,
    sql: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleExecResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    let is_query = is_select_sql(&sql);

    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        if is_query {
            let (columns, rows) = h.query_rows(&sql)?;
            Ok(OracleExecResult { columns, rows, affected_rows: None, is_query: true })
        } else {
            let n = h.execute_dml(&sql)?;
            Ok(OracleExecResult { columns: vec![], rows: vec![], affected_rows: Some(n), is_query: false })
        }
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

// ── OR1：Schema 浏览 ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oracle_list_schemas(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<String>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let (_, rows) = h.query_rows("SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME")?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 execute_query / run_query 路由使用，返回标准 QueryResult
pub async fn execute_query_impl(
    config: ConnConfig,
    sql: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<crate::models::QueryResult, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    let is_query = is_select_sql(&sql);
    let start = std::time::Instant::now();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        if is_query {
            let (columns, rows) = h.query_rows(&sql)?;
            Ok(crate::models::QueryResult {
                columns, rows,
                rows_affected: 0,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: true,
            })
        } else {
            let n = h.execute_dml(&sql)?;
            Ok(crate::models::QueryResult {
                columns: vec![], rows: vec![],
                rows_affected: n,
                execution_time_ms: start.elapsed().as_millis() as u64,
                truncated: false, is_select: false,
            })
        }
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 list_routines 路由使用：列出 Oracle schema 下函数/过程
pub async fn list_routines_impl(
    config: ConnConfig,
    schema: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<crate::models::RoutineInfo>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS \
             WHERE OWNER = {} AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE','PACKAGE') \
             ORDER BY OBJECT_TYPE, OBJECT_NAME",
            escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        Ok(rows.into_iter().map(|r| {
            let name         = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let routine_type = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let status       = r.get(2).and_then(|v| v.clone()).unwrap_or_else(|| "VALID".into());
            let _ = status; // Oracle 状态暂不透出到 RoutineInfo（前端未使用）
            crate::models::RoutineInfo { name, routine_type }
        }).collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 行内编辑 UPDATE（Oracle 不支持参数绑定简单方式，改为字面量 SQL）
pub async fn update_cell_impl(
    config: ConnConfig,
    schema: String,
    table: String,
    column: String,
    new_value: Option<String>,
    pk_columns: Vec<String>,
    pk_values: Vec<Option<String>>,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<(), String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let target = if schema.is_empty() { q(&table) } else { format!("{}.{}", q(&schema), q(&table)) };
        let set_part = match &new_value {
            Some(v) => format!("{} = {}", q(&column), escape_str(v)),
            None    => format!("{} = NULL", q(&column)),
        };
        let where_parts: Vec<String> = pk_columns.iter().zip(pk_values.iter())
            .map(|(c, v)| match v {
                Some(v) => format!("{} = {}", q(c), escape_str(v)),
                None    => format!("{} IS NULL", q(c)),
            }).collect();
        let sql = format!("UPDATE {target} SET {set_part} WHERE {}", where_parts.join(" AND "));
        let n = h.execute_dml(&sql)?;
        if n != 1 {
            return Err(if n == 0 {
                "未找到匹配行（或值未变化），已回滚".into()
            } else {
                format!("预期影响 1 行，实际影响 {n} 行")
            });
        }
        Ok(())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 query.rs 路由调用的内部函数
pub async fn list_schemas_impl(
    config: ConnConfig,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<String>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let (_, rows) = h.query_rows("SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME")?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_tables(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<OracleTableInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT o.OBJECT_NAME, o.OBJECT_TYPE, c.COMMENTS \
             FROM ALL_OBJECTS o \
             LEFT JOIN ALL_TAB_COMMENTS c \
               ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME \
             WHERE o.OWNER = {} AND o.OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW') \
             ORDER BY o.OBJECT_TYPE, o.OBJECT_NAME",
            escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name        = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let object_type = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let comment     = r.get(2).and_then(|v| v.clone());
            OracleTableInfo { name, object_type, comment }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 query.rs 的 table_columns 路由使用（返回 models::ColumnInfo 格式）
/// 整库「表名 → 列名」映射（SQL 编辑器智能补全批量加载用）
pub async fn schema_columns_impl(
    config: ConnConfig,
    schema: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT TABLE_NAME, COLUMN_NAME FROM ALL_TAB_COLUMNS \
             WHERE OWNER = {} ORDER BY TABLE_NAME, COLUMN_ID",
            escape_str(&schema.to_uppercase())
        );
        let (_, rows) = h.query_rows(&sql)?;
        let mut map = std::collections::HashMap::<String, Vec<String>>::new();
        for r in rows {
            let t = r.first().and_then(|v| v.clone());
            let c = r.get(1).and_then(|v| v.clone());
            if let (Some(t), Some(c)) = (t, c) { map.entry(t).or_default().push(c); }
        }
        Ok(map)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

pub async fn table_columns_impl(
    config: ConnConfig,
    schema: String,
    table: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<crate::models::ColumnInfo>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // 查询主键列名（Oracle 数据字典全大写）
        let pk_sql = format!(
            "SELECT cc.COLUMN_NAME FROM ALL_CONS_COLUMNS cc \
             JOIN ALL_CONSTRAINTS c ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER \
             WHERE c.OWNER = {} AND c.TABLE_NAME = {} AND c.CONSTRAINT_TYPE = 'P' \
             ORDER BY cc.POSITION",
            escape_str(&schema.to_uppercase()), escape_str(&table.to_uppercase())
        );
        let pk_cols: std::collections::HashSet<String> = h.query_rows(&pk_sql)
            .unwrap_or_default().1
            .into_iter()
            .filter_map(|r| r.get(0).and_then(|v| v.clone()))
            .collect();
        let col_sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE || \
                    CASE WHEN c.DATA_PRECISION IS NOT NULL \
                      THEN '(' || c.DATA_PRECISION || ',' || NVL(c.DATA_SCALE,0) || ')' \
                      ELSE '(' || c.DATA_LENGTH || ')' END as DATA_TYPE, \
                    c.NULLABLE \
             FROM ALL_TAB_COLUMNS c \
             WHERE c.OWNER = {} AND c.TABLE_NAME = {} \
             ORDER BY c.COLUMN_ID",
            escape_str(&schema.to_uppercase()), escape_str(&table.to_uppercase())
        );
        let (_, rows) = h.query_rows(&col_sql)?;
        Ok(rows.into_iter().map(|r| {
            let name      = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let data_type = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let nullable  = r.get(2).and_then(|v| v.as_deref().map(|s| s == "Y")).unwrap_or(true);
            let key       = if pk_cols.contains(&name) { "PRI".to_string() } else { String::new() };
            crate::models::ColumnInfo { name, data_type, nullable, key, default_value: None }
        }).collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 query.rs 的 get_table_ddl 路由使用（自动检测对象类型）
pub async fn get_table_ddl_impl(
    config: ConnConfig,
    schema: String,
    table: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<String, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // Oracle 系统表存的是大写名，前端传来可能是小写，统一转大写再查
        let table_up  = table.to_uppercase();
        let schema_up = schema.to_uppercase();
        // 先查对象类型，避免对视图调用 GET_DDL('TABLE') 导致 ORA-31603
        let type_sql = format!(
            "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {}",
            escape_str(&schema_up), escape_str(&table_up)
        );
        let obj_type = h.query_single_text(&type_sql)?
            .unwrap_or_else(|| "TABLE".into());
        // DBMS_METADATA 的类型名：TABLE / VIEW / MATERIALIZED_VIEW / PROCEDURE / FUNCTION
        let meta_type = match obj_type.as_str() {
            "VIEW"               => "VIEW",
            "MATERIALIZED VIEW"  => "MATERIALIZED_VIEW",
            "PROCEDURE"          => "PROCEDURE",
            "FUNCTION"           => "FUNCTION",
            "PACKAGE"            => "PACKAGE",
            "TRIGGER"            => "TRIGGER",
            "INDEX"              => "INDEX",
            _                    => "TABLE",
        };
        let sql = format!(
            "SELECT DBMS_METADATA.GET_DDL('{}', {}, {}) FROM DUAL",
            meta_type, escape_str(&table_up), escape_str(&schema_up)
        );
        h.query_single_text(&sql)?.ok_or_else(|| "无法获取 DDL".to_string())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 query.rs 路由调用的内部函数（返回 models::TableInfo 格式）
pub async fn list_tables_impl(
    config: ConnConfig,
    schema: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<DbTableInfo>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS \
             WHERE OWNER = {} AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW') \
             ORDER BY OBJECT_TYPE, OBJECT_NAME",
            escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        Ok(rows.into_iter().map(|r| {
            let name    = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let is_view = r.get(1).and_then(|v| v.as_deref().map(|t| t == "VIEW" || t == "MATERIALIZED VIEW")).unwrap_or(false);
            DbTableInfo { name, is_view }
        }).collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 list_tables_meta 路由使用：返回 Oracle 下某 schema 的表/视图元数据
pub async fn tables_meta_impl(
    config: ConnConfig,
    schema: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<super::query::TableMetaInfo>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // ALL_TABLES 只包含 TABLE，ALL_OBJECTS 包含 VIEW；用 UNION ALL 合并
        let sql = format!(
            "SELECT t.TABLE_NAME, 'TABLE' as OBJ_TYPE, c.COMMENTS, \
                    t.NUM_ROWS, t.BLOCKS * 8192, t.LAST_ANALYZED \
             FROM ALL_TABLES t \
             LEFT JOIN ALL_TAB_COMMENTS c \
               ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME \
             WHERE t.OWNER = {sch} \
             UNION ALL \
             SELECT v.OBJECT_NAME, v.OBJECT_TYPE, c.COMMENTS, \
                    NULL, NULL, v.LAST_DDL_TIME \
             FROM ALL_OBJECTS v \
             LEFT JOIN ALL_TAB_COMMENTS c \
               ON c.OWNER = v.OWNER AND c.TABLE_NAME = v.OBJECT_NAME \
             WHERE v.OWNER = {sch} AND v.OBJECT_TYPE IN ('VIEW','MATERIALIZED VIEW') \
             ORDER BY 2, 1",
            sch = escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name       = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let obj_type   = r.get(1).and_then(|v| v.clone()).unwrap_or_else(|| "TABLE".into());
            let comment    = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            let row_count  = r.get(3).and_then(|v| v.as_deref().and_then(|s| s.parse::<i64>().ok())).unwrap_or(0);
            let data_len   = r.get(4).and_then(|v| v.as_deref().and_then(|s| s.parse::<i64>().ok())).unwrap_or(0);
            let updated_at = r.get(5).and_then(|v| v.clone());
            let table_type = if obj_type == "VIEW" || obj_type == "MATERIALIZED VIEW" {
                "VIEW".into()
            } else {
                "BASE TABLE".into()
            };
            super::query::TableMetaInfo {
                name, comment, row_count, data_length: data_len,
                index_length: 0, auto_increment: None,
                engine: "Oracle".into(), charset: String::new(),
                updated_at, created_at: None, table_type,
            }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_table_columns(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<OracleColumnInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, \
                    c.DATA_LENGTH || CASE WHEN c.DATA_PRECISION IS NOT NULL \
                      THEN '(' || c.DATA_PRECISION || ',' || NVL(c.DATA_SCALE,0) || ')' \
                      ELSE '' END as TYPE_DETAIL, \
                    c.NULLABLE, c.DATA_DEFAULT, cm.COMMENTS \
             FROM ALL_TAB_COLUMNS c \
             LEFT JOIN ALL_COL_COMMENTS cm \
               ON cm.OWNER = c.OWNER AND cm.TABLE_NAME = c.TABLE_NAME AND cm.COLUMN_NAME = c.COLUMN_NAME \
             WHERE c.OWNER = {} AND c.TABLE_NAME = {} \
             ORDER BY c.COLUMN_ID",
            escape_str(&schema), escape_str(&table)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name          = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let data_type     = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let data_length   = r.get(2).and_then(|v| v.clone());
            let nullable      = r.get(3).and_then(|v| v.as_deref().map(|s| s == "Y")).unwrap_or(true);
            let default_value = r.get(4).and_then(|v| v.clone());
            let comment       = r.get(5).and_then(|v| v.clone());
            OracleColumnInfo { name, data_type, data_length, nullable, default_value, comment }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_get_table_ddl(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT DBMS_METADATA.GET_DDL('TABLE', {}, {}) FROM DUAL",
            escape_str(&table), escape_str(&schema)
        );
        h.query_single_text(&sql)?.ok_or_else(|| "无法获取 DDL".to_string())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_indexes(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<IndexInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT i.INDEX_NAME, \
                    LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) as COLS, \
                    i.UNIQUENESS, i.INDEX_TYPE \
             FROM ALL_INDEXES i \
             JOIN ALL_IND_COLUMNS ic ON ic.INDEX_NAME = i.INDEX_NAME AND ic.INDEX_OWNER = i.OWNER \
             WHERE i.TABLE_OWNER = {} AND i.TABLE_NAME = {} \
             GROUP BY i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE \
             ORDER BY i.INDEX_NAME",
            escape_str(&schema), escape_str(&table)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name       = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let columns    = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let unique     = r.get(2).and_then(|v| v.as_deref().map(|s| s == "UNIQUE")).unwrap_or(false);
            let index_type = r.get(3).and_then(|v| v.clone()).unwrap_or_default();
            IndexInfo { name, columns, unique, index_type }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_constraints(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<ConstraintInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, \
                    LISTAGG(cc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY cc.POSITION) as COLS, \
                    r.TABLE_NAME as REF_TABLE, c.STATUS \
             FROM ALL_CONSTRAINTS c \
             LEFT JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME \
             LEFT JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME \
             WHERE c.OWNER = {} AND c.TABLE_NAME = {} \
             GROUP BY c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, r.TABLE_NAME, c.STATUS \
             ORDER BY c.CONSTRAINT_TYPE, c.CONSTRAINT_NAME",
            escape_str(&schema), escape_str(&table)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name            = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let constraint_type = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let columns         = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            let ref_table       = r.get(3).and_then(|v| v.clone());
            let status          = r.get(4).and_then(|v| v.clone()).unwrap_or_default();
            ConstraintInfo { name, constraint_type, columns, ref_table, status }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_routines(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<RoutineInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT OBJECT_NAME, OBJECT_TYPE, STATUS \
             FROM ALL_OBJECTS \
             WHERE OWNER = {} AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION','PACKAGE') \
             ORDER BY OBJECT_TYPE, OBJECT_NAME",
            escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name         = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let routine_type = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let status       = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            RoutineInfo { name, routine_type, status }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_triggers(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<TriggerInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT TRIGGER_NAME, TABLE_NAME, TRIGGER_TYPE, TRIGGERING_EVENT, STATUS \
             FROM ALL_TRIGGERS \
             WHERE OWNER = {} AND TABLE_NAME = {} \
             ORDER BY TRIGGER_NAME",
            escape_str(&schema), escape_str(&table)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name         = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let table_name   = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let trigger_type = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            let event        = r.get(3).and_then(|v| v.clone()).unwrap_or_default();
            let status       = r.get(4).and_then(|v| v.clone()).unwrap_or_default();
            TriggerInfo { name, table_name, trigger_type, event, status }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_sequences(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<Vec<SequenceInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT SEQUENCE_NAME, TO_CHAR(MIN_VALUE), TO_CHAR(MAX_VALUE), \
                    TO_CHAR(INCREMENT_BY), CYCLE_FLAG \
             FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = {} ORDER BY SEQUENCE_NAME",
            escape_str(&schema)
        );
        let (_, rows) = h.query_rows(&sql)?;
        let result = rows.into_iter().map(|r| {
            let name         = r.get(0).and_then(|v| v.clone()).unwrap_or_default();
            let min_value    = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
            let max_value    = r.get(2).and_then(|v| v.clone()).unwrap_or_default();
            let increment_by = r.get(3).and_then(|v| v.clone()).unwrap_or_default();
            let cycle        = r.get(4).and_then(|v| v.as_deref().map(|s| s == "Y")).unwrap_or(false);
            SequenceInfo { name, min_value, max_value, increment_by, cycle }
        }).collect();
        Ok(result)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

// ── OR2：DML / DDL 操作 ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oracle_update_cell(
    id: String,
    schema: String,
    table: String,
    row_id: String,
    column: String,
    value: Option<String>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "UPDATE {}.{} SET {} = {} WHERE ROWID = {}",
            quote_ident(&schema), quote_ident(&table),
            quote_ident(&column),
            oracle_literal(&value),
            escape_str(&row_id),
        );
        let n = h.execute_dml(&sql)?;
        Ok(format!("已更新 {n} 行"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 db_extra::db_insert_rows 路由调用
pub async fn insert_rows_impl(
    config: ConnConfig,
    password: Option<String>,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    registry: &DriverRegistry,
) -> Result<u64, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let col_list = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(",");
        let mut total: u64 = 0;
        for row in &rows {
            let val_list = row.iter().map(oracle_literal).collect::<Vec<_>>().join(",");
            let sql = format!(
                "INSERT INTO {}.{} ({}) VALUES ({})",
                quote_ident(&schema), quote_ident(&table), col_list, val_list
            );
            total += h.execute_dml(&sql)?;
        }
        Ok(total)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// 供 db_extra::db_delete_rows 路由调用
pub async fn delete_rows_impl(
    config: ConnConfig,
    password: Option<String>,
    schema: String,
    table: String,
    pk_columns: Vec<String>,
    pk_values_list: Vec<Vec<Option<String>>>,
    registry: &DriverRegistry,
) -> Result<u64, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let mut total: u64 = 0;
        for pk_values in &pk_values_list {
            let where_clause = pk_columns.iter().zip(pk_values.iter())
                .map(|(col, val)| {
                    let lhs = quote_ident(col);
                    match val {
                        None => format!("{lhs} IS NULL"),
                        Some(v) => format!("{lhs} = {}", escape_str(v)),
                    }
                })
                .collect::<Vec<_>>().join(" AND ");
            let sql = format!(
                "DELETE FROM {}.{} WHERE {where_clause}",
                quote_ident(&schema), quote_ident(&table)
            );
            total += h.execute_dml(&sql)?;
        }
        Ok(total)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_delete_rows(
    id: String,
    schema: String,
    table: String,
    row_ids: Vec<String>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<u64, String> {
    if row_ids.is_empty() { return Ok(0); }
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let id_list = row_ids.iter().map(|r| escape_str(r)).collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM {}.{} WHERE ROWID IN ({})",
            quote_ident(&schema), quote_ident(&table), id_list
        );
        h.execute_dml(&sql)
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_insert_rows(
    id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    values: Vec<Option<String>>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    if columns.is_empty() { return Err("列名不能为空".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let col_list = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(",");
        let val_list = values.iter().map(|v| oracle_literal(v)).collect::<Vec<_>>().join(",");
        let sql = format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            quote_ident(&schema), quote_ident(&table), col_list, val_list
        );
        let n = h.execute_dml(&sql)?;
        Ok(format!("已插入 {n} 行"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_drop_table(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!("DROP TABLE {}.{} PURGE", quote_ident(&schema), quote_ident(&table));
        h.execute_ddl(&sql)?;
        Ok(format!("表 {schema}.{table} 已删除"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_truncate_table(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!("TRUNCATE TABLE {}.{}", quote_ident(&schema), quote_ident(&table));
        h.execute_ddl(&sql)?;
        Ok(format!("表 {schema}.{table} 已清空"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_rename_table(
    id: String,
    schema: String,
    table: String,
    new_name: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // Oracle RENAME 不支持 schema 前缀，需在目标 schema 下执行
        let sql = format!(
            "ALTER TABLE {}.{} RENAME TO {}",
            quote_ident(&schema), quote_ident(&table), quote_ident(&new_name)
        );
        h.execute_ddl(&sql)?;
        Ok(format!("表已重命名为 {new_name}"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_drop_routine(
    id: String,
    schema: String,
    name: String,
    routine_type: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let obj_type = match routine_type.to_uppercase().as_str() {
            "FUNCTION" => "FUNCTION",
            "PACKAGE"  => "PACKAGE",
            _          => "PROCEDURE",
        };
        let sql = format!("DROP {} {}.{}", obj_type, quote_ident(&schema), quote_ident(&name));
        h.execute_ddl(&sql)?;
        Ok(format!("{obj_type} {schema}.{name} 已删除"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_get_routine_source(
    id: String,
    schema: String,
    name: String,
    routine_type: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    drop(storage);
    routine_source_impl(config, schema, name, routine_type, password, &*registry).await
}

/// Oracle 例程源码（ALL_SOURCE）——抽出供按方言分发的 get_routine_ddl 复用
pub async fn routine_source_impl(
    config: ConnConfig,
    schema: String,
    name: String,
    routine_type: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<String, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT TEXT FROM ALL_SOURCE \
             WHERE OWNER = {} AND NAME = {} AND TYPE = {} \
             ORDER BY LINE",
            escape_str(&schema), escape_str(&name), escape_str(&routine_type.to_uppercase())
        );
        let (_, rows) = h.query_rows(&sql)?;
        let source = rows.into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect::<Vec<_>>()
            .join("");
        if source.is_empty() {
            Err(format!("未找到 {routine_type} {schema}.{name} 的源码"))
        } else {
            Ok(source)
        }
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

// ── OR3：DBA 监控面板 ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oracle_session_list(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT s.SID, s.SERIAL#, s.USERNAME, s.STATUS, s.MACHINE, \
                          s.PROGRAM, s.SQL_ID, \
                          TO_CHAR(s.LOGON_TIME,'YYYY-MM-DD HH24:MI:SS') as LOGON_TIME, \
                          TO_CHAR(s.LAST_CALL_ET) as LAST_CALL_ET, \
                          SUBSTR(q.SQL_TEXT,1,200) as SQL_TEXT \
                   FROM V$SESSION s \
                   LEFT JOIN V$SQL q ON q.SQL_ID = s.SQL_ID AND q.CHILD_NUMBER = 0 \
                   WHERE s.TYPE = 'USER' \
                   ORDER BY s.LOGON_TIME DESC";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_kill_session(
    id: String,
    sid: String,
    serial: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_numeric_id(&sid, "SID")?;
    validate_numeric_id(&serial, "SERIAL#")?;
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!("ALTER SYSTEM KILL SESSION '{},{}'  IMMEDIATE", sid, serial);
        h.execute_ddl(&sql)?;
        Ok(format!("会话 SID={sid} SERIAL#={serial} 已终止"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_top_sql(
    id: String,
    top_n: Option<u32>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    let limit = top_n.unwrap_or(50).min(500);
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT * FROM ( \
               SELECT SQL_ID, \
                      TO_CHAR(ROUND(ELAPSED_TIME/1000000,2)) as ELAPSED_SEC, \
                      TO_CHAR(EXECUTIONS) as EXECUTIONS, \
                      TO_CHAR(ROUND(ELAPSED_TIME/GREATEST(EXECUTIONS,1)/1000000,4)) as AVG_SEC, \
                      TO_CHAR(ROUND(CPU_TIME/1000000,2)) as CPU_SEC, \
                      TO_CHAR(BUFFER_GETS) as BUFFER_GETS, \
                      TO_CHAR(ROWS_PROCESSED) as ROWS_PROCESSED, \
                      SUBSTR(SQL_TEXT,1,300) as SQL_TEXT \
               FROM V$SQL WHERE EXECUTIONS > 0 \
               ORDER BY ELAPSED_TIME DESC \
             ) WHERE ROWNUM <= {}",
            limit
        );
        let (columns, rows) = h.query_rows(&sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_awr_snapshots(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT * FROM ( \
                     SELECT TO_CHAR(SNAP_ID) as SNAP_ID, \
                            TO_CHAR(BEGIN_INTERVAL_TIME,'YYYY-MM-DD HH24:MI:SS') as BEGIN_TIME, \
                            TO_CHAR(END_INTERVAL_TIME,'YYYY-MM-DD HH24:MI:SS') as END_TIME \
                     FROM DBA_HIST_SNAPSHOT ORDER BY SNAP_ID DESC \
                   ) WHERE ROWNUM <= 50";
        match h.query_rows(sql) {
            Ok((columns, rows)) => {
                let row_count = Some(rows.len() as u64);
                Ok(OracleQueryResult { columns, rows, row_count })
            }
            Err(e) if e.contains("ORA-00942") || e.contains("table or view does not exist") => {
                Ok(OracleQueryResult {
                    columns: vec!["提示".to_string()],
                    rows: vec![vec![Some("需要 Oracle Diagnostics Pack 许可证及 DBA 权限".to_string())]],
                    row_count: None,
                })
            }
            Err(e) => Err(e),
        }
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_tablespace_usage(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT df.TABLESPACE_NAME, \
                          TO_CHAR(ROUND(df.TOTAL_BYTES/1048576,2)) as TOTAL_MB, \
                          TO_CHAR(ROUND(NVL(fs.FREE_BYTES,0)/1048576,2)) as FREE_MB, \
                          TO_CHAR(ROUND((df.TOTAL_BYTES-NVL(fs.FREE_BYTES,0))/1048576,2)) as USED_MB, \
                          TO_CHAR(ROUND((df.TOTAL_BYTES-NVL(fs.FREE_BYTES,0))*100/df.TOTAL_BYTES,1)) as USED_PCT \
                   FROM (SELECT TABLESPACE_NAME, SUM(BYTES) TOTAL_BYTES FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) df \
                   LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) FREE_BYTES FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) fs \
                     ON fs.TABLESPACE_NAME = df.TABLESPACE_NAME \
                   ORDER BY (df.TOTAL_BYTES-NVL(fs.FREE_BYTES,0))*100/df.TOTAL_BYTES DESC";
        let (columns, rows) = h.query_rows(sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_lock_info(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT TO_CHAR(l.SID) as SID, TO_CHAR(s.SERIAL#) as SERIAL, \
                          s.USERNAME, l.TYPE, TO_CHAR(l.LMODE) as LOCK_MODE, \
                          TO_CHAR(l.REQUEST) as REQUEST, TO_CHAR(l.CTIME) as CTIME, \
                          o.OBJECT_NAME, o.OWNER as OBJ_OWNER \
                   FROM V$LOCK l \
                   JOIN V$SESSION s ON s.SID = l.SID \
                   LEFT JOIN DBA_OBJECTS o ON o.OBJECT_ID = l.ID1 AND l.TYPE = 'TM' \
                   WHERE s.TYPE = 'USER' \
                   ORDER BY l.CTIME DESC";
        let (columns, rows) = h.query_rows(sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_instance_metrics(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // V$SYSSTAT 的统计项列名为 NAME（STAT_NAME 是 V$SYS_TIME_MODEL/AWR 视图的列）
        let sql = "SELECT NAME AS STAT_NAME, TO_CHAR(VALUE) as VALUE \
                   FROM V$SYSSTAT \
                   WHERE NAME IN ( \
                     'user commits','user rollbacks','execute count', \
                     'physical reads','physical writes','redo writes', \
                     'session logical reads','sorts (disk)','sorts (memory)', \
                     'table scans (long tables)','parse count (total)' \
                   ) ORDER BY NAME";
        let (columns, rows) = h.query_rows(sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

// ── OR4：安全与维护 ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn oracle_list_users(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // ORACLE_MAINTAINED（12c+）标记 Oracle 自带系统账号，前端据此默认隐藏；
        // 用 NVL+子查询探测以兼容无此列的老版本（11g 回退为 'N'）。
        let sql = "SELECT USERNAME, ACCOUNT_STATUS, DEFAULT_TABLESPACE, PROFILE, \
                          TO_CHAR(CREATED,'YYYY-MM-DD') as CREATED, \
                          TO_CHAR(LOCK_DATE,'YYYY-MM-DD') as LOCK_DATE, \
                          TO_CHAR(EXPIRY_DATE,'YYYY-MM-DD') as EXPIRY_DATE, \
                          ORACLE_MAINTAINED \
                   FROM DBA_USERS ORDER BY USERNAME";
        let sql_fallback = "SELECT USERNAME, ACCOUNT_STATUS, DEFAULT_TABLESPACE, PROFILE, \
                          TO_CHAR(CREATED,'YYYY-MM-DD') as CREATED, \
                          TO_CHAR(LOCK_DATE,'YYYY-MM-DD') as LOCK_DATE, \
                          TO_CHAR(EXPIRY_DATE,'YYYY-MM-DD') as EXPIRY_DATE, \
                          'N' as ORACLE_MAINTAINED \
                   FROM DBA_USERS ORDER BY USERNAME";
        let (columns, rows) = match h.query_rows(sql) {
            Ok(v) => v,
            Err(_) => h.query_rows(sql_fallback)?,   // 老版本无 ORACLE_MAINTAINED
        };
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_create_user(
    id: String,
    username: String,
    password_new: String,
    default_tablespace: Option<String>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&username)?;
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let ts_clause = default_tablespace
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|ts| format!(" DEFAULT TABLESPACE {}", quote_ident(ts)))
            .unwrap_or_default();
        // 密码用双引号包裹以支持特殊字符
        let sql = format!(
            "CREATE USER {} IDENTIFIED BY \"{}\"{}",
            quote_ident(&username),
            password_new.replace('"', "\"\""),
            ts_clause,
        );
        h.execute_ddl(&sql)?;
        // 授予基本连接权限
        let grant_sql = format!("GRANT CREATE SESSION TO {}", quote_ident(&username));
        h.execute_ddl(&grant_sql)?;
        Ok(format!("用户 {username} 已创建"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_drop_user(
    id: String,
    username: String,
    cascade: bool,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&username)?;
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let cascade_clause = if cascade { " CASCADE" } else { "" };
        let sql = format!("DROP USER {}{}", quote_ident(&username), cascade_clause);
        h.execute_ddl(&sql)?;
        Ok(format!("用户 {username} 已删除"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_set_user_lock(
    id: String,
    username: String,
    locked: bool,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&username)?;
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let action = if locked { "LOCK" } else { "UNLOCK" };
        let sql = format!("ALTER USER {} ACCOUNT {}", quote_ident(&username), action);
        h.execute_ddl(&sql)?;
        let status = if locked { "已锁定" } else { "已解锁" };
        Ok(format!("用户 {username} {status}"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_change_password(
    id: String,
    username: String,
    new_password: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&username)?;
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "ALTER USER {} IDENTIFIED BY \"{}\"",
            quote_ident(&username),
            new_password.replace('"', "\"\""),
        );
        h.execute_ddl(&sql)?;
        Ok(format!("用户 {username} 密码已修改"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_privileges(
    id: String,
    username: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT 'SYSTEM' as PRIV_TYPE, PRIVILEGE, ADMIN_OPTION, NULL as OWNER, NULL as OBJ_NAME \
             FROM DBA_SYS_PRIVS WHERE GRANTEE = {} \
             UNION ALL \
             SELECT 'OBJECT', PRIVILEGE, GRANTABLE, OWNER, TABLE_NAME \
             FROM DBA_TAB_PRIVS WHERE GRANTEE = {} \
             UNION ALL \
             SELECT 'ROLE', GRANTED_ROLE, ADMIN_OPTION, NULL, NULL \
             FROM DBA_ROLE_PRIVS WHERE GRANTEE = {} \
             ORDER BY 1, 2",
            escape_str(&username), escape_str(&username), escape_str(&username)
        );
        let (columns, rows) = h.query_rows(&sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_grant_privilege(
    id: String,
    grantee: String,
    privilege: String,
    object: Option<String>,
    with_grant_option: bool,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&grantee)?;
    validate_privilege(&privilege)?;
    if let Some(ref obj) = object {
        if !obj.is_empty() { validate_object_ref(obj)?; }
    }
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let obj_clause = object.as_deref()
            .filter(|s| !s.is_empty())
            .map(|o| {
                let parts: Vec<&str> = o.splitn(2, '.').collect();
                if parts.len() == 2 {
                    format!(" ON {}.{}", quote_ident(parts[0]), quote_ident(parts[1]))
                } else {
                    format!(" ON {}", quote_ident(o))
                }
            })
            .unwrap_or_default();
        let wgo = if with_grant_option { " WITH GRANT OPTION" } else { "" };
        let sql = format!(
            "GRANT {}{} TO {}{}",
            privilege, obj_clause, quote_ident(&grantee), wgo
        );
        h.execute_ddl(&sql)?;
        Ok(format!("权限已授予 {grantee}"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_revoke_privilege(
    id: String,
    grantee: String,
    privilege: String,
    object: Option<String>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    validate_ident(&grantee)?;
    validate_privilege(&privilege)?;
    if let Some(ref obj) = object {
        if !obj.is_empty() { validate_object_ref(obj)?; }
    }
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let obj_clause = object.as_deref()
            .filter(|s| !s.is_empty())
            .map(|o| {
                let parts: Vec<&str> = o.splitn(2, '.').collect();
                if parts.len() == 2 {
                    format!(" ON {}.{}", quote_ident(parts[0]), quote_ident(parts[1]))
                } else {
                    format!(" ON {}", quote_ident(o))
                }
            })
            .unwrap_or_default();
        let sql = format!(
            "REVOKE {}{} FROM {}",
            privilege, obj_clause, quote_ident(&grantee)
        );
        h.execute_ddl(&sql)?;
        Ok(format!("权限已从 {grantee} 撤销"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_audit_trail(
    id: String,
    limit: Option<u32>,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    let n = limit.unwrap_or(200).min(1000);
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // 12c+ 优先用 UNIFIED_AUDIT_TRAIL，否则降级到 DBA_AUDIT_TRAIL
        let sql12 = format!(
            "SELECT * FROM ( \
               SELECT TO_CHAR(EVENT_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS') as TIMESTAMP, \
                      DBUSERNAME, ACTION_NAME, OBJECT_SCHEMA, OBJECT_NAME, \
                      TO_CHAR(RETURN_CODE) as RETURN_CODE \
               FROM UNIFIED_AUDIT_TRAIL ORDER BY EVENT_TIMESTAMP DESC \
             ) WHERE ROWNUM <= {n}"
        );
        let sql11 = format!(
            "SELECT * FROM ( \
               SELECT TO_CHAR(TIMESTAMP#,'YYYY-MM-DD HH24:MI:SS') as TIMESTAMP, \
                      DB_USER, ACTION_NAME, OBJ_NAME, \
                      TO_CHAR(RETURNCODE) as RETURN_CODE \
               FROM DBA_AUDIT_TRAIL ORDER BY TIMESTAMP# DESC \
             ) WHERE ROWNUM <= {n}"
        );
        match h.query_rows(&sql12) {
            Ok((columns, rows)) => {
                let row_count = Some(rows.len() as u64);
                Ok(OracleQueryResult { columns, rows, row_count })
            }
            Err(_) => {
                let (columns, rows) = h.query_rows(&sql11)?;
                let row_count = Some(rows.len() as u64);
                Ok(OracleQueryResult { columns, rows, row_count })
            }
        }
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_list_partitions(
    id: String,
    schema: String,
    table: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "SELECT PARTITION_NAME, TO_CHAR(PARTITION_POSITION) as POSITION, \
                    SUBSTR(HIGH_VALUE,1,200) as HIGH_VALUE, \
                    TO_CHAR(NUM_ROWS) as NUM_ROWS, TO_CHAR(BLOCKS) as BLOCKS, \
                    TO_CHAR(LAST_ANALYZED,'YYYY-MM-DD') as LAST_ANALYZED \
             FROM ALL_TAB_PARTITIONS \
             WHERE TABLE_OWNER = {} AND TABLE_NAME = {} \
             ORDER BY PARTITION_POSITION",
            escape_str(&schema), escape_str(&table)
        );
        let (columns, rows) = h.query_rows(&sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_drop_partition(
    id: String,
    schema: String,
    table: String,
    partition: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "ALTER TABLE {}.{} DROP PARTITION {}",
            quote_ident(&schema), quote_ident(&table), quote_ident(&partition)
        );
        h.execute_ddl(&sql)?;
        Ok(format!("分区 {partition} 已删除"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_truncate_partition(
    id: String,
    schema: String,
    table: String,
    partition: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = format!(
            "ALTER TABLE {}.{} TRUNCATE PARTITION {}",
            quote_ident(&schema), quote_ident(&table), quote_ident(&partition)
        );
        h.execute_ddl(&sql)?;
        Ok(format!("分区 {partition} 已清空"))
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn oracle_health_check(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT 'Instance' as CATEGORY, 'Name' as METRIC, INSTANCE_NAME as VALUE FROM V$INSTANCE \
                   UNION ALL SELECT 'Instance', 'Host', HOST_NAME FROM V$INSTANCE \
                   UNION ALL SELECT 'Instance', 'Version', VERSION FROM V$INSTANCE \
                   UNION ALL SELECT 'Instance', 'Status', STATUS FROM V$INSTANCE \
                   UNION ALL SELECT 'Instance', 'DB Status', DATABASE_STATUS FROM V$INSTANCE \
                   UNION ALL SELECT 'Instance', 'Startup', TO_CHAR(STARTUP_TIME,'YYYY-MM-DD HH24:MI:SS') FROM V$INSTANCE \
                   UNION ALL SELECT 'Memory', 'SGA Total (MB)', TO_CHAR(ROUND(SUM(VALUE)/1048576,2)) FROM V$SGA \
                   UNION ALL SELECT 'Sessions', 'Active Users', TO_CHAR(COUNT(*)) FROM V$SESSION WHERE TYPE='USER' \
                   ORDER BY 1, 2";
        let (columns, rows) = h.query_rows(sql)?;
        let row_count = Some(rows.len() as u64);
        Ok(OracleQueryResult { columns, rows, row_count })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR4.9 — 失效对象检测（DBA_OBJECTS INVALID 列表）
#[tauri::command]
pub async fn oracle_invalid_objects(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT OWNER AS 所属Schema, OBJECT_NAME AS 对象名, OBJECT_TYPE AS 对象类型, \
                          TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS 最后修改时间, \
                          STATUS AS 状态 \
                   FROM DBA_OBJECTS \
                   WHERE STATUS = 'INVALID' \
                     AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE','PACKAGE','PACKAGE BODY', \
                                        'TRIGGER','VIEW','SYNONYM','TYPE','TYPE BODY') \
                   ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME \
                   FETCH FIRST 200 ROWS ONLY";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR4.9 — 陈旧统计信息检测（DBA_TAB_STATISTICS 上次分析时间 > 7 天）
#[tauri::command]
pub async fn oracle_stale_stats(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        // 仅列出用户 Schema（过滤系统对象），上次分析 > 7 天或从未分析
        let sql = "SELECT OWNER AS 所属Schema, TABLE_NAME AS 表名, \
                          TO_CHAR(NVL(LAST_ANALYZED, DATE '2000-01-01'), 'YYYY-MM-DD') AS 最后分析时间, \
                          TO_CHAR(NUM_ROWS) AS 估计行数, \
                          STATTYPE_LOCKED AS 统计锁定, \
                          STALE_STATS AS 统计陈旧 \
                   FROM DBA_TAB_STATISTICS \
                   WHERE (LAST_ANALYZED IS NULL OR LAST_ANALYZED < SYSDATE - 7) \
                     AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','APPQOSSYS','WMSYS', \
                                       'EXFSYS','CTXSYS','MDSYS','ORDSYS','ORDPLUGINS','XDB', \
                                       'ANONYMOUS','SYSMAN','MGMT_VIEW','APEX_040000','FLOWS_FILES') \
                   ORDER BY LAST_ANALYZED NULLS FIRST, OWNER, TABLE_NAME \
                   FETCH FIRST 100 ROWS ONLY";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR2.2 — UNDO 保留 + REDO 日志组 + 归档模式综合视图
#[tauri::command]
pub async fn oracle_undo_redo_stats(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT 类型, 指标, 值 FROM (\
          SELECT 1 AS s, 'UNDO 保留' AS 类型, '调优保留时间 (s)' AS 指标, TO_CHAR(TUNED_UNDORETENTION) AS 值 \
            FROM (SELECT TUNED_UNDORETENTION FROM V$UNDOSTAT ORDER BY BEGIN_TIME DESC) WHERE ROWNUM=1 \
          UNION ALL \
          SELECT 2, 'UNDO 保留', '未过期块 (Unexpired)', TO_CHAR(UNEXPIREDBLKS) \
            FROM (SELECT UNEXPIREDBLKS FROM V$UNDOSTAT ORDER BY BEGIN_TIME DESC) WHERE ROWNUM=1 \
          UNION ALL \
          SELECT 3, 'UNDO 保留', '已过期块 (Expired)', TO_CHAR(EXPIREDBLKS) \
            FROM (SELECT EXPIREDBLKS FROM V$UNDOSTAT ORDER BY BEGIN_TIME DESC) WHERE ROWNUM=1 \
          UNION ALL \
          SELECT 4, 'UNDO 保留', 'ORA-01555 快照过旧次数', TO_CHAR(SSOLDERRCNT) \
            FROM (SELECT SSOLDERRCNT FROM V$UNDOSTAT ORDER BY BEGIN_TIME DESC) WHERE ROWNUM=1 \
          UNION ALL \
          SELECT 10 + l.GROUP#, 'REDO 日志', \
            'Group ' || TO_CHAR(l.GROUP#) || ' (' || TO_CHAR(ROUND(l.BYTES/1048576)) || ' MB x ' || TO_CHAR(l.MEMBERS) || ' 成员)', \
            l.STATUS \
            FROM V$LOG l \
          UNION ALL \
          SELECT 50, '归档模式', '日志模式 (LOG_MODE)', LOG_MODE FROM V$DATABASE \
          UNION ALL \
          SELECT 51, '归档模式', '归档进程状态', ARCHIVER FROM V$INSTANCE \
        ) ORDER BY s";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR3.3 — Top 等待事件分析（V$SYSTEM_EVENT，按 TIME_WAITED 降序 Top 25）
#[tauri::command]
pub async fn oracle_wait_events(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT EVENT AS 等待事件, WAIT_CLASS AS 等待类型, \
                          TO_CHAR(TOTAL_WAITS) AS 总等待次数, \
                          TO_CHAR(TOTAL_TIMEOUTS) AS 超时次数, \
                          TO_CHAR(ROUND(TIME_WAITED_MICRO/1000000, 2)) AS 总等待时间s, \
                          TO_CHAR(ROUND(AVERAGE_WAIT_MICRO/1000, 2)) AS 平均等待ms \
                   FROM V$SYSTEM_EVENT \
                   WHERE WAIT_CLASS != 'Idle' \
                   ORDER BY TIME_WAITED_MICRO DESC \
                   FETCH FIRST 25 ROWS ONLY";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR3.5 — Data Guard 主备状态（V$DATAGUARD_STATS + V$ARCHIVE_DEST_STATUS）
#[tauri::command]
pub async fn oracle_data_guard_status(
    id: String,
    storage: State<'_, StorageState>,
    registry: State<'_, DriverRegistry>,
) -> Result<OracleQueryResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let oci_path = get_oci_path(&*registry).await?;
    let pass = password.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let sql = "SELECT 分类, 指标, 值 FROM (\
          SELECT 1 AS s, 'DB 角色' AS 分类, '数据库角色' AS 指标, DATABASE_ROLE AS 值 FROM V$DATABASE \
          UNION ALL \
          SELECT 2, 'DB 角色', '保护模式', PROTECTION_MODE FROM V$DATABASE \
          UNION ALL \
          SELECT 3, 'DB 角色', '保护级别', PROTECTION_LEVEL FROM V$DATABASE \
          UNION ALL \
          SELECT 10 + ROWNUM, 'DG 统计', NAME, \
            NVL(VALUE,'—') || CASE WHEN UNIT IS NOT NULL THEN ' (' || UNIT || ')' ELSE '' END \
            FROM V$DATAGUARD_STATS \
          UNION ALL \
          SELECT 50 + ROWNUM, '归档目的地', \
            'Dest #' || TO_CHAR(DEST_ID) || ' | 状态: ' || NVL(STATUS,'?') || ' | 目标: ' || NVL(TARGET,'—'), \
            'DB: ' || NVL(DB_UNIQUE_NAME,'—') \
            FROM V$ARCHIVE_DEST_STATUS \
            WHERE STATUS != 'INACTIVE' \
        ) ORDER BY s";
        let (columns, rows) = h.query_rows(sql)?;
        Ok(OracleQueryResult { columns, rows, row_count: None })
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}

/// OR1.5 pub impl — Oracle EXPLAIN PLAN（供 db_explain 调用）
/// 两步：EXPLAIN PLAN FOR <sql> → SELECT FROM TABLE(DBMS_XPLAN.DISPLAY)
pub async fn oracle_explain_plan_impl(
    config: ConnConfig,
    sql_text: String,
    password: Option<String>,
    registry: &DriverRegistry,
) -> Result<Vec<String>, String> {
    let oci_path = get_oci_path(registry).await?;
    let pass = password.unwrap_or_default();
    // 生成唯一 STATEMENT_ID，防止并发时读到其他会话的计划
    let stmt_id = format!("DBT{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros());
    tokio::task::spawn_blocking(move || {
        let h = connect_with_config(&config, &pass, &oci_path)?;
        let stmt_id_esc = stmt_id.replace('\'', "''");
        h.execute_ddl(&format!(
            "EXPLAIN PLAN SET STATEMENT_ID = '{}' FOR {}",
            stmt_id_esc, sql_text.trim()
        )).map_err(|e| format!("EXPLAIN PLAN 失败: {e}"))?;
        let display_sql = format!(
            "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE','{}','BASIC ROWS COST'))",
            stmt_id_esc
        );
        let (_, rows) = h.query_rows(&display_sql)
            .map_err(|e| format!("DBMS_XPLAN.DISPLAY 失败: {e}"))?;
        // DELETE 是 DML，必须用 execute_dml 才会 commit，否则连接复用时行会积累
        let _ = h.execute_dml(&format!(
            "DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '{}'", stmt_id_esc
        ));
        Ok(rows.into_iter()
            .flat_map(|row| row.into_iter().filter_map(|v| v))
            .collect())
    }).await.map_err(|e| format!("任务执行失败: {e}"))?
}
