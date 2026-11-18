// db_tx.rs — 持久事务支持
//
// 每个连接 ID 最多持有一个活跃事务连接。
// 所有事务期间的查询都通过持久连接执行，而非新建连接。
// 专用连接关闭会由数据库终止未提交事务；关闭并不等同于收到回滚确认。
//
// 与 SSH 侧完全无关，只操作 DB 连接。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{info, instrument};
use crate::{
    models::{ConnConfig, ConnType, QueryResult},
    storage::StorageState,
    tracing_utils::Timer,
};
use super::duckdb::{DuckPool, DuckConnState, execute_retained, get_duck_lib_path_pub, get_or_open_pub};
use super::sqlserver::{SsPool, SsEntry, get_entry as get_ss_entry, query_on_entry};
use super::oracle::{OracleTxPool, oracle_begin_tx, oracle_exec_in_tx, oracle_commit_tx, oracle_rollback_tx};
use super::driver::DriverRegistry;

// ── 事务连接类型 ─────────────────────────────────────────────────────────────

pub enum TxConn {
    MySql(sqlx::mysql::MySqlConnection),
    Pg(sqlx::postgres::PgConnection),
    Sqlite(sqlx::sqlite::SqliteConnection),
    // Native transactions retain dedicated handles; Oracle retains its separate transaction-pool ID.
    Duckdb(Arc<AsyncMutex<DuckConnState>>),
    SqlServer(Arc<AsyncMutex<SsEntry>>),
    Oracle(String),
}

#[allow(dead_code)]
pub struct ActiveTx {
    pub conn: TxConn,
    pub started_at: Instant,
    /// 最近一次执行语句的时刻：僵尸回收按「空闲时长」判定，避免误杀活跃的长事务。
    pub last_used: Instant,
    /// 事务级只读：连接标记只读时，BEGIN 用 READ ONLY 起，并在 exec 处拦截写语句（双保险）。
    pub read_only: bool,
    /// Retain the exact tunnel even if its shared cache entry is invalidated.
    pub _tunnel_guard: Option<Arc<crate::db_tunnel::DbTunnel>>,
}

/// 全局事务状态：每个 DB 连接 ID 最多一个活跃事务。
/// 两级锁：外层 map 锁只在「取出/插入/移除 per-连接锁」时瞬时持有；
/// DB 查询 / COMMIT / ROLLBACK 的 await 只持有内层 per-连接锁。
/// 这样连接 A 的事务语句在 DB 层阻塞（等行锁）时，不会占住全局锁把连接 B 的
/// commit/rollback 也挡住——避免「A 等 B 的行锁、B 等 A 的应用锁」式应用级死锁。
pub type TxState = Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<ActiveTx>>>>>;

fn transaction_gate(id: &str) -> Arc<AsyncMutex<()>> {
    static GATES: std::sync::OnceLock<std::sync::Mutex<HashMap<String, std::sync::Weak<AsyncMutex<()>>>>> = std::sync::OnceLock::new();
    let mut gates = GATES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(id).and_then(|gate| gate.upgrade()) { return gate; }
    let gate = Arc::new(AsyncMutex::new(()));
    gates.insert(id.into(), Arc::downgrade(&gate));
    gate
}

async fn ensure_current_transaction(state: &TxState, id: &str, expected: &Arc<AsyncMutex<ActiveTx>>) -> Result<(), String> {
    if state.lock().await.get(id).is_some_and(|current| Arc::ptr_eq(current, expected)) { Ok(()) }
    else { Err("原事务已结束或已更换，已拒绝执行排队的旧操作".into()) }
}

// ── 辅助 ─────────────────────────────────────────────────────────────────────

async fn load_conn(
    id: &str,
    storage: &State<'_, StorageState>,
) -> Result<(ConnConfig, Option<String>), String> {
    let cfg = storage.lock().unwrap().load()?;
    let config = cfg.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

const CLIENT_TAG: &str = "/* DBTerm */";
fn tag(s: &str) -> String { format!("{CLIENT_TAG} {s}") }

/// Classify only. Execute the original text, never a reserialized AST.
fn validate_manual_tx_sql(sql: &str, kind: &ConnType) -> Result<(), String> {
    use sqlparser::{ast::Statement, dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect, MsSqlDialect, DuckDbDialect}, parser::Parser};
    let mysql = matches!(kind, ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase);
    // These comments contain executable MySQL/MariaDB statements but generic parsers skip them.
    if mysql && (sql.contains("/*!") || sql.contains("/*M!")) {
        return Err("手动事务中不支持可执行版本注释；已拒绝执行，请先明确提交或回滚".into());
    }
    let dialect: Box<dyn Dialect> = match kind {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => Box::new(MySqlDialect {}),
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => Box::new(PostgreSqlDialect {}),
        ConnType::Sqlite => Box::new(SQLiteDialect {}),
        ConnType::SqlServer => Box::new(MsSqlDialect {}),
        ConnType::Duckdb => Box::new(DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    };
    let statements = Parser::parse_sql(dialect.as_ref(), sql)
        .map_err(|e| format!("无法安全解析手动事务语句，已拒绝执行（原 SQL 未修改）: {e}"))?;
    if statements.len() != 1 {
        return Err("事务执行入口仅接受单条语句；请逐条执行，并使用事务按钮或独立 BEGIN/COMMIT/ROLLBACK 控制边界".into());
    }
    let statement = &statements[0];
    if matches!(statement, Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { savepoint: None, .. }) {
        return Err("请使用事务按钮或独立 BEGIN/COMMIT/ROLLBACK 控制边界，已拒绝在事务查询内隐式改变状态".into());
    }
    // MySQL/Oracle DDL implicitly commits. SQL Server dynamic commands may end a transaction.
    if (mysql || matches!(kind, ConnType::Oracle | ConnType::SqlServer))
        && !matches!(statement, Statement::Query(_) | Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_) | Statement::Merge { .. }) {
        return Err("当前手动事务仅支持查询与普通增删改；DDL、SET、存储程序及动态命令可能隐式提交，已拒绝执行。请先明确提交或回滚后单独执行原 SQL".into());
    }
    Ok(())
}

// Reuse canonical connectors so transaction TLS/SSH/session policy cannot drift.
use super::query::{mysql_connect as open_mysql, pg_connect as open_pg};

// ── 执行任意查询并转换为 QueryResult ─────────────────────────────────────────

async fn run_on_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
) -> Result<QueryResult, String> {
    let tagged = tag(sql);
    let t0 = Instant::now();

    if !crate::commands::query::is_query_stmt(sql) {
        let affected = if crate::commands::query::needs_text_protocol(sql) {
            use sqlx::Executor;
            conn.execute(sqlx::raw_sql(&tagged)).await
                .map(|r| r.rows_affected())
                .map_err(|e| format!("{e}"))?
        } else {
            sqlx::query(&tagged).execute(&mut *conn).await
                .map(|r| r.rows_affected())
                .map_err(|e| format!("{e}"))?
        };
        return Ok(QueryResult {
            columns: vec![], rows: vec![],
            rows_affected: affected, execution_time_ms: t0.elapsed().as_millis() as u64,
            truncated: false, is_select: false,
        });
    }

    let (mut columns, rows) = super::query::collect_query_rows(
        sqlx::query(&tagged).fetch(&mut *conn), super::query::mysql_cell,
    ).await?;
    if columns.is_empty() {
        use sqlx::{Executor, Column};
        columns = (&mut *conn).describe(&tagged).await
            .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
    }
    let row_count = rows.len() as u64;
    Ok(QueryResult { columns, rows, rows_affected: row_count, execution_time_ms: t0.elapsed().as_millis() as u64, truncated: false, is_select: true })
}

async fn mysql_exec_text(conn: &mut sqlx::mysql::MySqlConnection, sql: &str) -> Result<(), String> {
    use sqlx::Executor;
    conn.execute(sqlx::raw_sql(sql)).await
        .map(|_| ())
        .map_err(|e| format!("{e}"))
}

fn is_mysql_transaction_preamble(text: &str) -> bool {
    let normalized = text.trim().trim_end_matches(';').split_whitespace().collect::<Vec<_>>().join(" ").to_uppercase();
    let text = normalized.as_str();
    let safe_cleanup = matches!(text, "COMMIT" | "COMMIT WORK" | "ROLLBACK" | "ROLLBACK WORK");
    let safe_session_setup = text.starts_with("SET ") || text.starts_with("USE ");
    let safe_read = text.starts_with("SELECT ") || text == "SELECT";
    let temporary_table = text.starts_with("CREATE TEMPORARY TABLE ")
        || text.starts_with("DROP TEMPORARY TABLE ");
    let temporary_stage_insert = text.starts_with("INSERT INTO TMP_PAYMENT_HISTORY_EXPECTED ")
        || text.starts_with("INSERT INTO TMP_PAYMENT_HISTORY_EXPECTED(");
    safe_cleanup || safe_session_setup || safe_read || temporary_table || temporary_stage_insert
}

async fn run_on_pg(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
) -> Result<QueryResult, String> {
    let tagged = tag(sql);
    let t0 = Instant::now();

    if !crate::commands::query::is_query_stmt(sql) {
        let affected = sqlx::query(&tagged)
            .execute(&mut *conn).await
            .map(|r| r.rows_affected())
            .map_err(|e| format!("{e}"))?;
        return Ok(QueryResult {
            columns: vec![], rows: vec![],
            rows_affected: affected, execution_time_ms: t0.elapsed().as_millis() as u64,
            truncated: false, is_select: false,
        });
    }

    let (mut columns, rows) = super::query::collect_query_rows(
        sqlx::query(&tagged).fetch(&mut *conn), super::query::pg_cell,
    ).await?;
    if columns.is_empty() {
        use sqlx::{Executor, Column};
        columns = (&mut *conn).describe(&tagged).await
            .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
    }
    Ok(QueryResult { columns, rows, rows_affected: 0, execution_time_ms: t0.elapsed().as_millis() as u64, truncated: false, is_select: true })
}

async fn open_sqlite(config: &ConnConfig) -> Result<sqlx::sqlite::SqliteConnection, String> {
    use crate::commands::query::sqlite_url;
    use sqlx::{ConnectOptions, Connection, sqlite::{SqliteConnectOptions, SqliteConnection}};
    use std::str::FromStr;
    let url = sqlite_url(config)?;
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(|e| format!("SQLite URL 解析失败: {e}"))?
        .log_statements(log::LevelFilter::Off);
    SqliteConnection::connect_with(&opts).await
        .map_err(|e| format!("SQLite 连接失败: {e}"))
}

async fn run_on_sqlite(
    conn: &mut sqlx::sqlite::SqliteConnection,
    sql:  &str,
) -> Result<QueryResult, String> {
    let t0 = Instant::now();

    if !crate::commands::query::is_query_stmt(sql) {
        let affected = sqlx::query(sql)
            .execute(&mut *conn).await
            .map(|r| r.rows_affected())
            .map_err(|e| format!("{e}"))?;
        return Ok(QueryResult {
            columns: vec![], rows: vec![], rows_affected: affected,
            execution_time_ms: t0.elapsed().as_millis() as u64,
            truncated: false, is_select: false,
        });
    }

    let (mut columns, rows) = super::query::collect_query_rows(
        sqlx::query(sql).fetch(&mut *conn), super::query::sqlite_cell,
    ).await?;
    if columns.is_empty() {
        use sqlx::{Executor, Column};
        columns = (&mut *conn).describe(sql).await
            .map(|d| d.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();
    }
    Ok(QueryResult { columns, rows, rows_affected: 0, execution_time_ms: t0.elapsed().as_millis() as u64, truncated: false, is_select: true })
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 开始事务：建立持久连接并执行 BEGIN
#[tauri::command]
#[instrument(skip(storage, tx_state, oracle_tx_pool, registry), fields(conn_id = %id))]
pub async fn db_begin_tx(
    id: String,
    database: Option<String>,
    preamble: Option<Vec<String>>,
    storage: State<'_, StorageState>,
    tx_state: State<'_, TxState>,
    oracle_tx_pool: State<'_, OracleTxPool>,
    registry: State<'_, DriverRegistry>,
) -> Result<(), String> {
    let _timer = Timer::new("db_begin_tx");
    info!("Starting transaction");
    let gate = transaction_gate(&id);
    let _operation_guard = gate.lock().await;
    // 检查是否已有活跃事务
    {
        let guard = tx_state.lock().await;
        if guard.contains_key(&id) {
            return Err("此连接已有活跃事务，请先提交或回滚".to_string());
        }
    }

    let (mut config, password) = load_conn(&id, &storage).await?;
    let selected_schema = super::query::apply_selected_query_target(&mut config, database.as_deref())?;
    let pwd = password.as_deref();
    let preamble = preamble.unwrap_or_default();
    // 只读连接：事务整体以 READ ONLY 起，写操作由引擎直接拒绝（最强保证）
    let read_only = config.read_only == Some(true);

    let mut tunnel_guard = None;
    let conn = match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            if let Some(db) = database.as_deref().filter(|s| !s.is_empty()) {
                config.database = Some(db.to_string());
            }
            let (mut c, tunnel) = open_mysql(&config, pwd).await?;
            tunnel_guard = tunnel;
            if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
                mysql_exec_text(&mut c, &format!("USE `{}`", db.replace('`', "``"))).await
                    .map_err(|e| format!("切换数据库失败: {e}"))?;
            }
            for stmt in &preamble {
                let text = super::query::strip_leading_comments(stmt)
                    .trim()
                    .trim_end_matches(';')
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_uppercase();
                if !is_mysql_transaction_preamble(&text) {
                    return Err("事务前置语句不在安全白名单中；仅支持 SET / USE / SELECT / 临时表 DDL / 指定临时审计表写入 / COMMIT / ROLLBACK".to_string());
                }
                mysql_exec_text(&mut c, stmt).await
                    .map_err(|e| format!("事务前置语句失败: {e}"))?;
            }
            let begin = if read_only { "START TRANSACTION READ ONLY" } else { "BEGIN" };
            mysql_exec_text(&mut c, begin).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::MySql(c)
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            if !preamble.is_empty() { return Err("当前数据库不支持事务前置语句".to_string()); }
            let (mut c, tunnel) = open_pg(&config, pwd).await?;
            tunnel_guard = tunnel;
            if let Some(schema) = database.as_deref().filter(|s| !s.is_empty()) {
                let safe_schema = schema.replace('"', "\"\"");
                sqlx::query(&format!("SET search_path TO \"{safe_schema}\"")).execute(&mut c).await
                    .map_err(|e| format!("切换 schema 失败: {e}"))?;
            }
            let begin = if read_only { "BEGIN READ ONLY" } else { "BEGIN" };
            sqlx::query(begin).execute(&mut c).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::Pg(c)
        }
        ConnType::Sqlite => {
            if !preamble.is_empty() { return Err("当前数据库不支持事务前置语句".to_string()); }
            let mut c = open_sqlite(&config).await?;
            if read_only {
                // 只读：query_only 阻止任何写；用 DEFERRED BEGIN（不抢写锁）
                sqlx::query("PRAGMA query_only=ON").execute(&mut c).await
                    .map_err(|e| format!("设置只读失败: {e}"))?;
                sqlx::query("BEGIN").execute(&mut c).await
                    .map_err(|e| format!("BEGIN 失败: {e}"))?;
            } else {
                // BEGIN IMMEDIATE 立即获取写锁，避免 SQLITE_BUSY 在 COMMIT 时突发
                sqlx::query("BEGIN IMMEDIATE").execute(&mut c).await
                    .map_err(|e| format!("BEGIN IMMEDIATE 失败: {e}"))?;
            }
            TxConn::Sqlite(c)
        }
        ConnType::Duckdb => {
            if !preamble.is_empty() { return Err("当前数据库不支持事务前置语句".to_string()); }
            let lib_path = get_duck_lib_path_pub(&registry).await?;
            // Dedicated native connection: ordinary pooled queries must not join this transaction.
            let dedicated: DuckPool = Arc::new(AsyncMutex::new(HashMap::new()));
            let handle = get_or_open_pub(&id, &config, &dedicated, &lib_path).await?;
            if let Some(catalog) = selected_schema {
                super::duckdb::select_retained_catalog(Arc::clone(&handle), catalog).await?;
            }
            execute_retained(Arc::clone(&handle), "BEGIN".into(), None).await
                .map_err(|e| format!("BEGIN 失败: {e}"))?;
            TxConn::Duckdb(handle)
        }
        ConnType::SqlServer => {
            if !preamble.is_empty() { return Err("当前数据库不支持事务前置语句".to_string()); }
            let dedicated_pool: SsPool = Arc::new(AsyncMutex::new(HashMap::new()));
            let entry = get_ss_entry(&id, &dedicated_pool, &config, password.as_deref()).await?;
            query_on_entry(&entry, "BEGIN TRANSACTION").await
                .map_err(|e| format!("BEGIN TRANSACTION 失败: {e}"))?;
            TxConn::SqlServer(entry)
        }
        ConnType::Oracle => {
            if !preamble.is_empty() { return Err("当前数据库不支持事务前置语句".to_string()); }
            oracle_begin_tx(id.clone(), config, password, &*registry, &oracle_tx_pool, selected_schema).await?;
            TxConn::Oracle(id.clone())
        }
        _ => return Err("此连接类型不支持手动事务".to_string()),
    };

    // 二次检查：并发 begin 时避免覆盖（极小概率，但保持与池一致的语义）
    let mut guard = tx_state.lock().await;
    if guard.contains_key(&id) {
        return Err("此连接已有活跃事务，请先提交或回滚".to_string());
    }
    let now = Instant::now();
    guard.insert(id, Arc::new(AsyncMutex::new(ActiveTx { conn, started_at: now, last_used: now, read_only, _tunnel_guard: tunnel_guard })));
    Ok(())
}

/// 在当前事务连接上执行 SQL（事务期间所有语句必须走此命令）
#[tauri::command]
#[instrument(skip(tx_state, oracle_tx_pool, sql), fields(conn_id = %id, sql_len = sql.len()))]
pub async fn db_exec_in_tx(
    id: String,
    sql: String,
    cancel_token: Option<String>,
    row_limit: Option<u64>,
    tx_state: State<'_, TxState>,
    oracle_tx_pool: State<'_, OracleTxPool>,
) -> Result<QueryResult, String> {
    execute_transaction(id,sql,cancel_token,row_limit,&tx_state,&oracle_tx_pool).await
}

async fn execute_transaction(id:String,sql:String,cancel_token:Option<String>,row_limit:Option<u64>,tx_state:&TxState,oracle_tx_pool:&OracleTxPool)->Result<QueryResult,String>{
    let _timer = Timer::new("db_exec_in_tx");
    super::query::validate_cancel_token(cancel_token.as_deref())?;

    // 瞬时持外层锁取出 per-连接锁后立即释放；DB 执行只持内层锁
    let tx_arc = {
        let guard = tx_state.lock().await;
        guard.get(&id).cloned().ok_or("没有活跃事务，请先执行 BEGIN")?
    };
    let registration = cancel_token.as_ref().map(|token| super::query::abort_register_for(token, &id)).transpose()?;
    let (_abort_guard, mut abort_rx) = registration.map_or((None, None), |(guard, receiver)| (Some(guard), Some(receiver)));
    let gate = transaction_gate(&id);
    let _operation_guard = if let Some(rx)=abort_rx.as_mut(){
        tokio::select!{biased; _=rx=>return Err("查询已取消；排队语句未执行，原事务保持不变".into()),guard=gate.lock()=>guard}
    }else{gate.lock().await};
    ensure_current_transaction(&tx_state, &id, &tx_arc).await?;
    let mut tx = if let Some(rx)=abort_rx.as_mut(){
        tokio::select!{biased; _=rx=>return Err("查询已取消；排队语句未执行，原事务保持不变".into()),guard=tx_arc.lock()=>guard}
    }else{tx_arc.lock().await};

    let tx_kind = match &tx.conn {
        TxConn::MySql(_) => ConnType::Mysql,
        TxConn::Pg(_) => ConnType::Postgres,
        TxConn::Sqlite(_) => ConnType::Sqlite,
        TxConn::Duckdb(_) => ConnType::Duckdb,
        TxConn::SqlServer(_) => ConnType::SqlServer,
        TxConn::Oracle(_) => ConnType::Oracle,
    };
    validate_manual_tx_sql(&sql, &tx_kind)?;
    // 只读事务沿用普通查询的 fail-closed 规则。SQL Server/ClickHouse/DuckDB
    // 依赖应用层保护，WITH/EXPLAIN 前缀不能绕过 DML 关键字检查。
    if tx.read_only && !super::query::is_read_only_safe_stmt(&sql, &tx_kind) {
        return Err("只读连接：事务中不允许写操作".to_string());
    }
    tx.last_used = Instant::now();

    let (sql, limit_applied) = super::query::apply_query_row_limit(&sql, row_limit, &tx_kind);
    let pg_cancel=match &tx.conn{TxConn::Pg(conn)=>Some(conn.cancel_token()),_=>None};
    let run = async {
        match &mut tx.conn {
            TxConn::MySql(conn)    => run_on_mysql(conn, &sql).await,
            TxConn::Pg(conn)       => run_on_pg(conn, &sql).await,
            TxConn::Sqlite(conn)   => run_on_sqlite(conn, &sql).await,
            TxConn::Duckdb(handle) => {
                execute_retained(Arc::clone(handle), sql.clone(), None).await
            }
            TxConn::SqlServer(entry) => query_on_entry(entry, &sql).await,
            TxConn::Oracle(conn_id) => {
                let conn_id = conn_id.clone();
                oracle_exec_in_tx(&conn_id, sql, &oracle_tx_pool, Instant::now()).await
            }
        }
    };
    let mut cancelled = false;
    let result = if let Some(rx) = abort_rx {
        if let Some(token)=pg_cancel{
            let (result,was_cancelled)=super::pg_cancel::run(run,rx,token).await;
            cancelled=was_cancelled;result
        }else{
            tokio::pin!(run);
            tokio::select! {biased;
                _ = rx => { cancelled = true; Err("查询已取消；客户端事务连接已作废，但服务端语句和锁不保证立即结束，请核查数据库状态，勿重复写入".to_string()) },
                result = &mut run => result,
            }
        }
    } else {run.await};
    tx.last_used = Instant::now();
    if cancelled {
        // The per-id operation gate and exact Arc check prevent cancelling a
        // replacement transaction. Dropping this owner closes SQLx connections.
        let mut map = tx_state.lock().await;
        if map.get(&id).is_some_and(|current| Arc::ptr_eq(current, &tx_arc)) { map.remove(&id); }
        drop(map);
        if let TxConn::Oracle(native_id) = &tx.conn {
            if let Err(error) = oracle_rollback_tx(native_id, &oracle_tx_pool).await {
                return Err(format!("查询已取消；Oracle 回滚未确认: {error}；请核查数据库，勿重复写入"));
            }
        }
    }
    result.map(|mut result| { result.truncated = limit_applied; result })
}

enum PgFinishOutcome { Finished, RolledBack }

async fn finish_pg_transaction(conn:&mut sqlx::postgres::PgConnection,commit:bool)->Result<PgFinishOutcome,String>{
    if commit {
        // PostgreSQL acknowledges COMMIT on an aborted transaction with ROLLBACK.
        // SQLx QueryResult discards that command tag, so check before finalizing.
        if let Err(error)=sqlx::query("SELECT 1").execute(&mut *conn).await {
            if error.as_database_error().and_then(|e|e.code()).is_some_and(|code|code=="25P02") {
                sqlx::query("ROLLBACK").execute(&mut *conn).await.map_err(|e|format!("失败事务回滚未确认: {e}"))?;
                return Ok(PgFinishOutcome::RolledBack)
            }
            return Err(error.to_string())
        }
    }
    sqlx::query(if commit{"COMMIT"}else{"ROLLBACK"}).execute(&mut *conn).await.map_err(|e|e.to_string())?;
    Ok(PgFinishOutcome::Finished)
}

async fn finish_transaction(id: &str, state: &TxState, oracle: &OracleTxPool, commit: bool) -> Result<(), String> {
    // Capture identity before queueing: never finalize a replacement transaction.
    let expected = state.lock().await.get(id).cloned().ok_or("没有活跃事务")?;
    let gate = transaction_gate(id);
    let _operation_guard = gate.lock().await;
    ensure_current_transaction(state, id, &expected).await?;
    let mut tx = expected.lock().await;
    let sql = if commit { "COMMIT" } else { "ROLLBACK" };
    let mut confirmed_rollback=false;
    let result = match &mut tx.conn {
        TxConn::MySql(conn) => mysql_exec_text(conn, sql).await,
        TxConn::Pg(conn) => finish_pg_transaction(conn,commit).await.map(|outcome|{confirmed_rollback=matches!(outcome,PgFinishOutcome::RolledBack);}),
        TxConn::Sqlite(conn) => sqlx::query(sql).execute(conn).await.map(|_| ()).map_err(|e| e.to_string()),
        TxConn::Duckdb(handle) => execute_retained(Arc::clone(handle), sql.into(), None).await.map(|_| ()),
        TxConn::SqlServer(entry) => query_on_entry(entry, &format!("{sql} TRANSACTION")).await.map(|_| ()),
        TxConn::Oracle(conn_id) => if commit { oracle_commit_tx(conn_id, oracle).await } else { oracle_rollback_tx(conn_id, oracle).await },
    };
    // Keep the old identity registered until its operation completes. Errors must
    // not permit another queued SQL statement to run on an uncertain connection.
    let mut map = state.lock().await;
    if map.get(id).is_some_and(|current| Arc::ptr_eq(current, &expected)) { map.remove(id); }
    if confirmed_rollback{return Err("DBTERM_TX_ROLLED_BACK:事务此前发生错误，PostgreSQL 已回滚，本次未提交任何变更".into())}
    result.map_err(|e| format!("{sql} 未得到成功确认: {e}；结果不确定，请核查数据库，勿重复写入"))
}

/// 提交事务
#[tauri::command]
#[instrument(skip(tx_state, oracle_tx_pool), fields(conn_id = %id))]
pub async fn db_commit_tx(id: String, tx_state: State<'_, TxState>, oracle_tx_pool: State<'_, OracleTxPool>) -> Result<(), String> {
    finish_transaction(&id, &tx_state, &oracle_tx_pool, true).await
}

/// 回滚事务
#[tauri::command]
#[instrument(skip(tx_state, oracle_tx_pool), fields(conn_id = %id))]
pub async fn db_rollback_tx(id: String, tx_state: State<'_, TxState>, oracle_tx_pool: State<'_, OracleTxPool>) -> Result<(), String> {
    finish_transaction(&id, &tx_state, &oracle_tx_pool, false).await
}

/// 查询当前连接是否有活跃事务（前端刷新时检查）
#[tauri::command]
pub async fn db_tx_status(
    id: String,
    tx_state: State<'_, TxState>,
) -> Result<bool, String> {
    Ok(tx_state.lock().await.contains_key(&id))
}

/// 清理「空闲」超过 30 分钟的僵尸事务，返回清理数量。命令与后台定时任务共用。
/// 关键：按 last_used（最近一次执行）判定空闲，而非 started_at（BEGIN 时刻）——
/// 正在执行的连接跳过；Oracle 通过原生池回滚，其余专用连接关闭后由数据库终止事务。
/// 清理计数表示客户端状态已移除，不等于收到所有数据库回滚成功确认。
#[allow(dead_code)]
pub async fn cleanup_stale_txns(tx_state: &TxState) -> u32 {
    cleanup_stale_transactions(tx_state, None).await
}

pub async fn cleanup_stale_txns_with_oracle(tx_state: &TxState, oracle: &OracleTxPool) -> u32 {
    cleanup_stale_transactions(tx_state, Some(oracle)).await
}

async fn cleanup_stale_transactions(state: &TxState, oracle: Option<&OracleTxPool>) -> u32 {
    let candidates: Vec<_> = state.lock().await.iter().map(|(id, tx)| (id.clone(), tx.clone())).collect();
    let threshold = std::time::Duration::from_secs(30 * 60);
    let mut cleaned = 0;
    for (id, expected) in candidates {
        let gate = transaction_gate(&id);
        let Ok(_operation) = gate.try_lock() else { continue; };
        let Ok(tx) = expected.try_lock() else { continue; };
        if tx.last_used.elapsed() < threshold { continue; }
        if ensure_current_transaction(state, &id, &expected).await.is_err() { continue; }
        // Oracle owns a separate native pool. Removing only its string leaks that
        // connection; never remove Oracle without access to the actual pool.
        if let TxConn::Oracle(native_id) = &tx.conn {
            let Some(pool) = oracle else { continue; };
            if let Err(error) = oracle_rollback_tx(native_id, pool).await {
                tracing::warn!("Oracle idle rollback unconfirmed: {error}");
            }
        }
        let mut map = state.lock().await;
        if map.get(&id).is_some_and(|current| Arc::ptr_eq(current, &expected)) { map.remove(&id); cleaned += 1; }
    }
    cleaned
}

#[tauri::command]
pub async fn db_cleanup_stale_tx(tx_state: State<'_, TxState>, oracle_tx_pool: State<'_, OracleTxPool>) -> Result<u32, String> {
    Ok(cleanup_stale_txns_with_oracle(&tx_state, &oracle_tx_pool).await)
}

// ── 测试模块 ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[test]
    fn manual_tx_rejects_implicit_commit_controls_and_multiple_statements() {
        for sql in ["ALTER TABLE t ADD COLUMN c INT", "CREATE TEMPORARY TABLE x(id INT)", "SET autocommit=1", "COMMIT", "CALL p()", "EXECUTE prepared", "SELECT 1; COMMIT", "/*! COMMIT */ SELECT 1"] {
            assert!(super::validate_manual_tx_sql(sql, &crate::models::ConnType::Mysql).is_err(), "{sql}");
        }
        for sql in ["SELECT '; COMMIT' AS text", "UPDATE t SET value=1 WHERE id=2", "WITH x AS (SELECT 1) SELECT * FROM x"] {
            assert!(super::validate_manual_tx_sql(sql, &crate::models::ConnType::Mysql).is_ok(), "{sql}");
        }
        assert!(super::validate_manual_tx_sql("CREATE TABLE x(id INT)", &crate::models::ConnType::Postgres).is_ok());
        assert!(super::validate_manual_tx_sql("CREATE TABLE x(id INT)", &crate::models::ConnType::Sqlite).is_ok());
    }
    use super::*;

    #[test]
    fn mysql_payment_migration_preamble_statements_are_accepted() {
        for sql in [
            "SET @payment_from_id = NULL",
            "SELECT DATABASE() AS target_database, VERSION() AS mysql_version",
            "SELECT MIN(id) AS min_session_id, MAX(id) AS max_session_id, COUNT(*) AS historical_sessions FROM mc_order_session",
            "DROP TEMPORARY TABLE IF EXISTS tmp_payment_history_source",
            "CREATE TEMPORARY TABLE tmp_payment_history_expected LIKE mc_order_payment",
            "CREATE TEMPORARY TABLE tmp_payment_history_source ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci AS SELECT x.* FROM source x",
            "INSERT INTO tmp_payment_history_expected (id, operation_no) SELECT x.id, x.operation_no FROM tmp_payment_history_source x WHERE x.blocking_reason = ''",
        ] {
            assert!(is_mysql_transaction_preamble(sql), "should allow: {sql}");
        }
        for sql in [
            "CREATE TABLE permanent_table (id INT)",
            "INSERT INTO mc_order_payment (id) VALUES (1)",
            "INSERT INTO mc_order_payment (id) SELECT id FROM tmp_payment_history_expected",
            "UPDATE mc_order_payment SET state = 'DONE'",
            "DELETE FROM mc_order_payment",
        ] {
            assert!(!is_mysql_transaction_preamble(sql), "should reject: {sql}");
        }
    }
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn queued_sqlite_execution_cannot_run_after_commit_or_enter_new_transaction() {
        use sqlx::{Connection, Executor};
        let state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        let mut conn = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        conn.execute("CREATE TABLE data(id INT); BEGIN; INSERT INTO data VALUES(1)").await.unwrap();
        let now = Instant::now();
        let original = Arc::new(AsyncMutex::new(ActiveTx { conn: TxConn::Sqlite(conn), started_at: now, last_used: now, read_only: false, _tunnel_guard: None }));
        state.lock().await.insert("race".into(), original.clone());
        let stale = original.clone();
        super::finish_transaction("race", &state, &OracleTxPool::new(), true).await.unwrap();
        assert!(super::ensure_current_transaction(&state, "race", &stale).await.is_err());
        let mut old = original.lock().await;
        let TxConn::Sqlite(conn) = &mut old.conn else { panic!("sqlite expected") };
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM data").fetch_one(conn).await.unwrap();
        assert_eq!(rows, 1);
        let replacement = Arc::new(AsyncMutex::new(ActiveTx { conn: TxConn::Oracle("new-identity".into()), started_at: now, last_used: now, read_only: false, _tunnel_guard: None }));
        state.lock().await.insert("race".into(), replacement);
        assert!(super::ensure_current_transaction(&state, "race", &stale).await.is_err());
    }

    #[tokio::test]
    async fn same_connection_operations_share_gate_but_other_connections_proceed() {
        let first = super::transaction_gate("gate-a");
        let repeated = super::transaction_gate("gate-a");
        let other = super::transaction_gate("gate-b");
        let _guard = first.lock().await;
        assert!(repeated.try_lock().is_err());
        assert!(other.try_lock().is_ok());
    }

    #[tokio::test]
    async fn commit_keeps_identity_registered_while_waiting_for_execution() {
        use sqlx::{Connection, Executor};
        let state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        let mut conn = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        conn.execute("BEGIN").await.unwrap();
        let now = Instant::now();
        let active = Arc::new(AsyncMutex::new(ActiveTx { conn: TxConn::Sqlite(conn), started_at: now, last_used: now, read_only: false, _tunnel_guard: None }));
        state.lock().await.insert("commit-wait".into(), active.clone());
        let held = active.lock().await;
        let worker_state = state.clone();
        let task = tokio::spawn(async move { super::finish_transaction("commit-wait", &worker_state, &OracleTxPool::new(), true).await });
        tokio::task::yield_now().await;
        assert!(state.lock().await.contains_key("commit-wait"));
        drop(held);
        task.await.unwrap().unwrap();
        assert!(!state.lock().await.contains_key("commit-wait"));
    }

    #[tokio::test]
    async fn stale_oracle_is_preserved_when_native_pool_is_unavailable() {
        let state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        let old = Instant::now() - Duration::from_secs(31 * 60);
        state.lock().await.insert("oracle-stale".into(), Arc::new(AsyncMutex::new(ActiveTx { conn: TxConn::Oracle("native".into()), started_at: old, last_used: old, read_only: false, _tunnel_guard: None })));
        assert_eq!(super::cleanup_stale_txns(&state).await, 0);
        assert!(state.lock().await.contains_key("oracle-stale"));
    }

    #[tokio::test]
    async fn transaction_connectors_reuse_read_only_init_sql_guard_before_network() {
        let mut config: ConnConfig = serde_json::from_value(serde_json::json!({"id":"tx-policy-test","name":"test","type":"mysql","host":"127.0.0.1","port":1,"username":"test","useSsl":true,"readOnly":true,"extraJson":"{\"initSql\":\"SET autocommit=1\"}","createdAt":0,"updatedAt":0})).unwrap();
        let error = match open_mysql(&config, None).await { Ok(_) => panic!("unsafe initialization accepted"), Err(error) => error };
        assert!(error.contains("初始化 SQL"), "{error}");
        config.conn_type = ConnType::Postgres;
        let error = match open_pg(&config, None).await { Ok(_) => panic!("unsafe initialization accepted"), Err(error) => error };
        assert!(error.contains("初始化 SQL"), "{error}");
    }

    #[tokio::test]
    async fn empty_sqlite_transaction_result_preserves_column_names() {
        use sqlx::Connection;
        let mut conn = sqlx::SqliteConnection::connect(":memory:").await.unwrap();
        let result = run_on_sqlite(&mut conn, "SELECT 1 AS value WHERE 0").await.unwrap();
        assert_eq!(result.columns, vec!["value"]);
        assert!(result.rows.is_empty());
        assert!(result.is_select);
    }

    #[test]
    fn test_tag_sql() {
        assert_eq!(tag("SELECT 1"), "/* DBTerm */ SELECT 1");
        assert_eq!(tag("BEGIN"), "/* DBTerm */ BEGIN");
        assert_eq!(tag(""), "/* DBTerm */ ");
    }

    #[test]
    fn duckdb_transaction_variant_owns_retained_handle() {
        fn accepts_retained(handle: Arc<AsyncMutex<DuckConnState>>) -> TxConn { TxConn::Duckdb(handle) }
        let _constructor = accepts_retained;
    }

    #[test]
    fn sqlserver_transaction_variant_owns_retained_handle() {
        fn accepts_retained(handle: Arc<AsyncMutex<SsEntry>>) -> TxConn { TxConn::SqlServer(handle) }
        let _constructor = accepts_retained;
    }

    #[test]
    fn test_tx_conn_oracle_variant() {
        let conn = TxConn::Oracle("oracle-id".to_string());
        if let TxConn::Oracle(id) = conn {
            assert_eq!(id, "oracle-id");
        } else {
            panic!("Expected TxConn::Oracle");
        }
    }

    #[test]
    fn test_active_tx_structure() {
        let now = Instant::now();
        let tx = ActiveTx {
            conn: TxConn::Oracle("test-id".to_string()),
            started_at: now,
            last_used: now,
            read_only: false,
            _tunnel_guard: None,
        };

        assert!(!tx.read_only);
        assert_eq!(tx.started_at, now);
        assert_eq!(tx.last_used, now);
    }

    #[test]
    fn test_active_tx_read_only() {
        let now = Instant::now();
        let tx = ActiveTx {
            conn: TxConn::Oracle("test-id".to_string()),
            started_at: now,
            last_used: now,
            read_only: true,
            _tunnel_guard: None,
        };

        assert!(tx.read_only);
    }

    #[tokio::test]
    async fn test_tx_state_creation() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        assert_eq!(tx_state.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_tx_state_insert_and_retrieve() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        let conn_id = "test-conn-1".to_string();

        let tx = Arc::new(AsyncMutex::new(ActiveTx {
            conn: TxConn::Oracle(conn_id.clone()),
            started_at: Instant::now(),
            last_used: Instant::now(),
            read_only: false,
            _tunnel_guard: None,
        }));

        tx_state.lock().await.insert(conn_id.clone(), tx);
        assert_eq!(tx_state.lock().await.len(), 1);
        assert!(tx_state.lock().await.contains_key(&conn_id));
    }

    #[tokio::test]
    async fn test_tx_state_remove() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));
        let conn_id = "test-conn-2".to_string();

        let tx = Arc::new(AsyncMutex::new(ActiveTx {
            conn: TxConn::Oracle(conn_id.clone()),
            started_at: Instant::now(),
            last_used: Instant::now(),
            read_only: false,
            _tunnel_guard: None,
        }));

        tx_state.lock().await.insert(conn_id.clone(), tx);
        assert_eq!(tx_state.lock().await.len(), 1);

        tx_state.lock().await.remove(&conn_id);
        assert_eq!(tx_state.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_tx_state_multiple_connections() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));

        for i in 0..5 {
            let conn_id = format!("test-conn-{}", i);
            let tx = Arc::new(AsyncMutex::new(ActiveTx {
                conn: TxConn::Oracle(conn_id.clone()),
                started_at: Instant::now(),
                last_used: Instant::now(),
                read_only: i % 2 == 0, // 交替设置只读
                _tunnel_guard: None,
            }));
            tx_state.lock().await.insert(conn_id, tx);
        }

        assert_eq!(tx_state.lock().await.len(), 5);
    }

    #[tokio::test]
    async fn test_cleanup_stale_txns_no_stale() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));

        // 添加一个刚刚活跃的事务
        let conn_id = "fresh-conn".to_string();
        let tx = Arc::new(AsyncMutex::new(ActiveTx {
            conn: TxConn::Oracle(conn_id.clone()),
            started_at: Instant::now(),
            last_used: Instant::now(), // 刚刚使用
            read_only: false,
            _tunnel_guard: None,
        }));
        tx_state.lock().await.insert(conn_id, tx);

        // 清理应该不会删除任何东西
        let cleaned = cleanup_stale_txns_with_oracle(&tx_state, &OracleTxPool::new()).await;
        assert_eq!(cleaned, 0);
        assert_eq!(tx_state.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn test_cleanup_stale_txns_with_stale() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));

        // 添加一个老旧的事务（模拟超过30分钟）
        let conn_id = "stale-conn".to_string();
        let old_time = Instant::now() - Duration::from_secs(31 * 60);
        let tx = Arc::new(AsyncMutex::new(ActiveTx {
            conn: TxConn::Oracle(conn_id.clone()),
            started_at: old_time,
            last_used: old_time, // 31分钟前最后使用
            read_only: false,
            _tunnel_guard: None,
        }));
        tx_state.lock().await.insert(conn_id, tx);

        // 清理应该删除过期事务
        let cleaned = cleanup_stale_txns_with_oracle(&tx_state, &OracleTxPool::new()).await;
        assert_eq!(cleaned, 1);
        assert_eq!(tx_state.lock().await.len(), 0);
    }

    #[tokio::test]
    async fn test_cleanup_stale_txns_mixed() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));

        // 添加2个新鲜的事务
        for i in 0..2 {
            let conn_id = format!("fresh-conn-{}", i);
            let tx = Arc::new(AsyncMutex::new(ActiveTx {
                conn: TxConn::Oracle(conn_id.clone()),
                started_at: Instant::now(),
                last_used: Instant::now(),
                read_only: false,
                _tunnel_guard: None,
            }));
            tx_state.lock().await.insert(conn_id, tx);
        }

        // 添加3个过期的事务
        let old_time = Instant::now() - Duration::from_secs(31 * 60);
        for i in 0..3 {
            let conn_id = format!("stale-conn-{}", i);
            let tx = Arc::new(AsyncMutex::new(ActiveTx {
                conn: TxConn::Oracle(conn_id.clone()),
                started_at: old_time,
                last_used: old_time,
                read_only: false,
                _tunnel_guard: None,
            }));
            tx_state.lock().await.insert(conn_id, tx);
        }

        assert_eq!(tx_state.lock().await.len(), 5);

        // 清理应该只删除过期的3个
        let cleaned = cleanup_stale_txns_with_oracle(&tx_state, &OracleTxPool::new()).await;
        assert_eq!(cleaned, 3);
        assert_eq!(tx_state.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn test_cleanup_long_running_active_tx() {
        let tx_state: TxState = Arc::new(AsyncMutex::new(HashMap::new()));

        // 模拟一个长时间运行的事务：started_at很早，但last_used是最近的
        let conn_id = "long-running".to_string();
        let old_start = Instant::now() - Duration::from_secs(60 * 60); // 1小时前开始
        let recent_use = Instant::now() - Duration::from_secs(5 * 60); // 5分钟前使用

        let tx = Arc::new(AsyncMutex::new(ActiveTx {
            conn: TxConn::Oracle(conn_id.clone()),
            started_at: old_start,
            last_used: recent_use,
            read_only: false,
            _tunnel_guard: None,
        }));
        tx_state.lock().await.insert(conn_id, tx);

        // 清理不应该删除这个事务（因为last_used是最近的）
        let cleaned = cleanup_stale_txns_with_oracle(&tx_state, &OracleTxPool::new()).await;
        assert_eq!(cleaned, 0);
        assert_eq!(tx_state.lock().await.len(), 1);
    }

    #[test]
    fn test_mysql_cfg_deserialization() {
        let json = r#"{
            "connectTimeout": 45,
            "sslMode": "require",
            "sslCa": "/path/to/ca.pem",
            "sshTunnel": true,
            "sshHost": "jump.example.com",
            "sshPort": 2222,
            "sshUser": "tunneluser"
        }"#;

        #[derive(serde::Deserialize, Default)]
        struct Cfg {
            #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
            #[serde(rename = "sslMode",  default)] ssl_mode: String,
            #[serde(rename = "sslCa",   default)] ssl_ca:   String,
            #[serde(rename = "sshTunnel",   default)] ssh_tunnel:  bool,
            #[serde(rename = "sshHost",     default)] ssh_host:    String,
            #[serde(rename = "sshPort",     default)] ssh_port:    u16,
            #[serde(rename = "sshUser",     default)] ssh_user:    String,
        }

        let cfg: Cfg = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.connect_timeout, 45);
        assert_eq!(cfg.ssl_mode, "require");
        assert_eq!(cfg.ssl_ca, "/path/to/ca.pem");
        assert!(cfg.ssh_tunnel);
        assert_eq!(cfg.ssh_host, "jump.example.com");
        assert_eq!(cfg.ssh_port, 2222);
        assert_eq!(cfg.ssh_user, "tunneluser");
    }

    #[test]
    fn test_pg_cfg_deserialization() {
        let json = r#"{
            "connectTimeout": 60,
            "sslMode": "verify-full",
            "pgSearchPath": "app,public"
        }"#;

        #[derive(serde::Deserialize, Default)]
        struct Cfg {
            #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
            #[serde(rename = "sslMode",  default)] ssl_mode: String,
            #[serde(rename = "pgSearchPath", default)] pg_search_path: String,
        }

        let cfg: Cfg = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.connect_timeout, 60);
        assert_eq!(cfg.ssl_mode, "verify-full");
        assert_eq!(cfg.pg_search_path, "app,public");
    }
}

#[cfg(test)]
#[path="pg_tx_finish_tests.rs"]
mod pg_tx_finish_tests;

#[cfg(test)]
#[path="tx_cancel_tests.rs"]
mod tx_cancel_tests;
