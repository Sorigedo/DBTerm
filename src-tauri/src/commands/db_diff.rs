// db_diff.rs — 大表数据对比：服务端归并排序，O(chunk_size) 内存
//
// 算法：merge-join + keyset 分页
//   两侧各按主键 ASC 有序拉取，每次只加载 CHUNK 行；
//   同步推进双指针，永不将完整表加载到内存。
//
// 复杂度：O(n) 时间，O(chunk_size) 空间，n 为两表行数之和。
// 支持：MySQL 族 InnoDB 完整非空整数主键；不支持的类型明确拒绝。
// 连接复用查询侧 TLS/SSH 配置，连接枚举持有隧道守卫直到对比结束。

use std::collections::HashMap;
use tauri::{State, Emitter};
use crate::{models::ConnType, storage::StorageState};

// ── 常量 ──────────────────────────────────────────────────────────────────────

const CHUNK: u64 = 2_000;       // 每批拉取行数
const SAMPLE_CAP: usize = 200;  // 每类最多返回样本数
const EMIT_EVERY: u64 = 5_000;  // 每扫描 N 行发一次进度事件
const MAX_COMPARISON_DURATION: std::time::Duration = std::time::Duration::from_secs(5 * 60);

async fn with_comparison_deadline<T>(duration: std::time::Duration, scan: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(duration, scan).await.map_err(|_| "数据对比超时，已停止客户端扫描并释放专用连接；未返回完整结果，不能据此确认一致。服务端释放查询及快照仍取决于连接断开处理。".to_string())?
}

// ── 返回类型 ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct DiffSample {
    pub pk: String,
    pub src: HashMap<String, Option<String>>,
    pub dst: HashMap<String, Option<String>>,
}

#[derive(serde::Serialize)]
pub struct DataDiffResult {
    pub total_only_src: u64,
    pub total_only_dst: u64,
    pub total_mismatch: u64,
    pub rows_scanned: u64,
    pub samples_only_src: Vec<DiffSample>,
    pub samples_only_dst: Vec<DiffSample>,
    pub samples_mismatch: Vec<DiffSample>,
    pub sample_capped: bool,
    pub column_types: HashMap<String, String>,
    pub column_encodings: HashMap<String, String>,
}

#[derive(serde::Serialize, Clone)]
struct ProgressEvt {
    scanned: u64,
    only_src: u64,
    only_dst: u64,
    mismatch: u64,
}

// ── 连接抽象 ──────────────────────────────────────────────────────────────────

enum DbConn {
    MySql(sqlx::mysql::MySqlConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>),
}

async fn open_conn(id: &str, storage: &State<'_, StorageState>) -> Result<DbConn, String> {
    let cfgs = storage.lock().unwrap().load()?;
    let config = cfgs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;

    let pwd_opt = crate::keychain::get_password(id)?;

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            // 复用查询侧连接配置，保留 TLS 校验及隧道守卫，不能静默降级为明文。
            let (conn, guard) = super::query::mysql_connect(&config, pwd_opt.as_deref()).await?;
            Ok(DbConn::MySql(conn, guard))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss | ConnType::Oracle | ConnType::SqlServer | ConnType::ClickHouse => Err("当前引擎尚未提供无损类型解码与一致性快照，已拒绝生成可靠性不足的数据对比结果".into()),
        _ => Err("暂不支持此连接类型的数据对比".into()),
    }
}

// ── 标识符引号 ────────────────────────────────────────────────────────────────

fn q(s: &str, mysql: bool) -> String {
    if mysql { format!("`{}`", s.replace('`', "``")) }
    else      { format!("\"{}\"", s.replace('"', "\"\"")) }
}

// ── 分块游标 ──────────────────────────────────────────────────────────────────

struct Chunk {
    col_names: Vec<String>,
    projection: Option<String>,
    rows: Vec<Vec<Option<String>>>,
    idx: usize,
    /// 下一批 keyset cursor：上一批最后一行的 PK 值
    cursor: Option<Vec<Option<String>>>,
    done: bool,
}

impl Chunk {
    fn new() -> Self {
        Self { col_names: vec![], projection: None, rows: vec![], idx: 0, cursor: None, done: false }
    }

    /// 当前批次已消费完且未结束时需要补充
    fn needs_refill(&self) -> bool {
        self.idx >= self.rows.len() && !self.done
    }

    /// 取当前行（克隆，避免借用冲突）
    fn peek_cloned(&self) -> Option<Vec<Option<String>>> {
        self.rows.get(self.idx).cloned()
    }

    fn advance(&mut self) {
        self.idx += 1;
    }
}

// ── 拉取下一批 ────────────────────────────────────────────────────────────────

async fn refill(
    chunk: &mut Chunk,
    conn: &mut DbConn,
    schema: &str,
    table: &str,
    pk_cols: &[String],
) -> Result<(), String> {
    let (cols, rows) = match conn {
        DbConn::MySql(c, _guard) => {
            let tbl = format!("{}.{}", q(schema, true), q(table, true));
            let order = pk_cols.iter().map(|c| q(c, true)).collect::<Vec<_>>().join(", ");
            if chunk.projection.is_none() {
                use sqlx::Row;
                let metadata = sqlx::query("SELECT CAST(COLUMN_NAME AS CHAR) AS name, CAST(DATA_TYPE AS CHAR) AS kind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION")
                    .bind(schema).bind(table).fetch_all(&mut *c).await.map_err(|e| e.to_string())?;
                let projection = metadata.iter().map(|row| {
                    let name: String = row.try_get("name").map_err(|e| e.to_string())?;
                    let kind: String = row.try_get("kind").map_err(|e| e.to_string())?;
                    let name = q(&name, true);
                    // FLOAT text protocol rounds distinct stored f32 values to the
                    // same display string. Widen on the server before text encoding;
                    // every finite f32 is exactly representable as f64.
                    Ok(match kind.as_str() {
                        "float" => format!("CAST({name} AS DOUBLE) AS {name}"),
                        // Empty SET and a selected empty member have the same
                        // display text; ENUM error index zero also displays empty.
                        "set" | "enum" => format!("CAST({name} AS UNSIGNED) AS {name}"),
                        _ => name,
                    })
                }).collect::<Result<Vec<_>,String>>()?.join(", ");
                if projection.is_empty() { return Err("无法读取完整字段投影，已停止对比".into()); }
                chunk.projection = Some(projection);
            }
            let sql = build_chunk_sql(&tbl, &order, pk_cols, chunk.cursor.as_deref(), true)?;
            let sql = sql.replacen("SELECT *", &format!("SELECT {}", chunk.projection.as_deref().unwrap()), 1);
            fetch_rows_mysql(c, &sql).await?
        }
    };

    if rows.is_empty() {
        chunk.done = true;
        return Ok(());
    }
    validate_chunk_keys(&cols, &rows, pk_cols, chunk.cursor.as_deref())?;

    // 更新 cursor → 本批最后一行的 PK
    let last = rows.last().unwrap();
    chunk.cursor = Some(pk_cols.iter().map(|pk| {
        cols.iter().position(|c| c == pk)
            .and_then(|i| last.get(i))
            .cloned()
            .flatten()
    }).collect());

    if chunk.col_names.is_empty() {
        chunk.col_names = cols;
    }
    chunk.rows = rows;
    chunk.idx  = 0;
    Ok(())
}

fn build_chunk_sql(
    tbl: &str,
    order: &str,
    pk_cols: &[String],
    cursor: Option<&[Option<String>]>,
    mysql: bool,
) -> Result<String,String> {
    Ok(match cursor {
        None => format!("SELECT * FROM {tbl} ORDER BY {order} LIMIT {CHUNK}"),
        Some(vals) => {
            let pk_q: Vec<String> = pk_cols.iter().map(|c| q(c, mysql)).collect();
            if vals.len()!=pk_cols.len() { return Err("主键游标字段数量不一致".into()); }
            let pk_v: Vec<String> = vals.iter().map(|value| {
                value.as_deref().ok_or("主键游标不能为 NULL").and_then(|v| v.parse::<i128>().map_err(|_| "主键游标不是有效整数"))
                    .map(|n|n.to_string()).map_err(str::to_string)
            }).collect::<Result<_,_>>()?;
            if pk_cols.len() == 1 {
                format!(
                    "SELECT * FROM {tbl} WHERE {} > {} ORDER BY {order} LIMIT {CHUNK}",
                    pk_q[0], pk_v[0]
                )
            } else {
                format!(
                    "SELECT * FROM {tbl} WHERE ({}) > ({}) ORDER BY {order} LIMIT {CHUNK}",
                    pk_q.join(", "),
                    pk_v.join(", ")
                )
            }
        }
    })
}

async fn fetch_rows_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    use sqlx::{Row, Column, ValueRef, TypeInfo};
    use futures::TryStreamExt;
    // Text protocol preserves server scalar output; binary protocol fallback
    // used to turn integers/dates into NULL (or raw binary hex).
    let mut stream = sqlx::Executor::fetch(&mut *conn, sql);
    let mut cols = Vec::new();
    let mut rows = Vec::new();
    let mut budget = super::query_result_budget::ResultBudget::default();
    while let Some(row) = stream.try_next().await.map_err(|e| format!("查询失败: {e}"))? {
        if cols.is_empty() { cols = row.columns().iter().map(|c| c.name().to_owned()).collect(); }
        budget.start_row()?;
        let mut values = Vec::new();
        for i in 0..cols.len() {
            let kind = row.column(i).type_info().name().to_ascii_uppercase();
            if matches!(kind.as_str(), "BINARY"|"VARBINARY"|"BLOB"|"TINYBLOB"|"MEDIUMBLOB"|"LONGBLOB"|"BIT"|"GEOMETRY") {
                let value = if row.try_get_raw(i).map_err(|e| e.to_string())?.is_null() { None } else {
                    Some(format!("0x{}", hex::encode(row.try_get_unchecked::<Vec<u8>,_>(i).map_err(|e| e.to_string())?)))
                };
                budget.cell(value.as_deref())?; values.push(value); continue;
            }
            let text = row.try_get_unchecked::<String, _>(i);
            let value = match text {
                Ok(value) => Some(value),
                Err(_) if row.try_get_raw(i).map_err(|e| e.to_string())?.is_null() => None,
                Err(error) => return Err(format!("字段 {} 不是可无损解码的文本，已停止对比: {error}", cols[i])),
            };
            budget.cell(value.as_deref())?;
            values.push(value);
        }
        rows.push(values);
    }
    Ok((cols, rows))
}

// ── PK 辅助 ───────────────────────────────────────────────────────────────────

fn row_pk(col_names: &[String], row: &[Option<String>], pk_cols: &[String]) -> Vec<Option<String>> {
    pk_cols.iter().map(|pk| {
        col_names.iter().position(|c| c == pk)
            .and_then(|i| row.get(i))
            .cloned()
            .flatten()
    }).collect()
}

fn pk_key(vals: &[Option<String>]) -> String {
    serde_json::to_string(vals).expect("string key tuple serializes")
}

/// 类型感知的主键比较：整数按数值序，其余按字典序
fn cmp_pk(a: &[Option<String>], b: &[Option<String>]) -> std::cmp::Ordering {
    for (av, bv) in a.iter().zip(b.iter()) {
        let ord = match (av, bv) {
            (None, None)    => std::cmp::Ordering::Equal,
            (None, _)       => std::cmp::Ordering::Less,
            (_, None)       => std::cmp::Ordering::Greater,
            (Some(a), Some(b)) => match (a.parse::<i128>(), b.parse::<i128>()) {
                (Ok(an), Ok(bn)) => an.cmp(&bn),
                _                => a.cmp(b),
            },
        };
        if ord != std::cmp::Ordering::Equal { return ord; }
    }
    std::cmp::Ordering::Equal
}

fn row_to_map(col_names: &[String], row: &[Option<String>]) -> HashMap<String, Option<String>> {
    col_names.iter().zip(row.iter()).map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn shared_values_differ(
    source: &HashMap<String, Option<String>>, target: &HashMap<String, Option<String>>, primary: &[String],
) -> bool {
    source.len() != target.len() || source.iter().any(|(column, value)| !primary.contains(column)
        && target.get(column) != Some(value))
}

fn validate_sample_memory(groups: &[&[DiffSample]]) -> Result<(), String> {
    let bytes = groups.iter().flat_map(|group| group.iter()).try_fold(0usize, |total, sample| {
        sample.src.iter().chain(sample.dst.iter()).try_fold(total.saturating_add(sample.pk.len()), |total,(key,value)| {
            total.checked_add(key.len()).and_then(|n| n.checked_add(value.as_ref().map_or(0,String::len))).ok_or("差异样本超出内存预算")
        })
    })?;
    if bytes > 8 * 1024 * 1024 { return Err("差异样本超过 8 MiB 安全预算，已停止；未生成完整对比结论".into()); }
    Ok(())
}

fn validate_key_kind(kind: &str, nullable: bool, primary: bool) -> Result<(), String> {
    if nullable || !primary || !matches!(kind, "tinyint"|"smallint"|"mediumint"|"int"|"bigint") {
        return Err("精确对比当前要求完整、非空的整数主键；不支持猜测字符串排序、浮点或小数主键".into());
    }
    Ok(())
}

fn validate_chunk_keys(columns: &[String], rows: &[Vec<Option<String>>], keys: &[String], previous: Option<&[Option<String>]>) -> Result<(), String> {
    if keys.iter().any(|key| !columns.contains(key)) || columns.iter().collect::<std::collections::HashSet<_>>().len() != columns.len() {
        return Err("对比结果缺少主键或包含重复列名，已停止".into());
    }
    let mut prior = previous.map(<[_]>::to_vec);
    for row in rows {
        if row.len() != columns.len() { return Err("对比结果行字段数量不一致".into()); }
        let key = row_pk(columns, row, keys);
        if key.iter().any(|value| value.as_deref().and_then(|v| v.parse::<i128>().ok()).is_none()) { return Err("主键无法无损解码为整数，已停止对比".into()); }
        if prior.as_ref().is_some_and(|p| cmp_pk(p, &key) != std::cmp::Ordering::Less) { return Err("主键重复或结果排序不一致，已停止对比".into()); }
        prior = Some(key);
    }
    Ok(())
}

async fn prepare_comparison(conn: &mut DbConn, schema: &str, table: &str, keys: &[String]) -> Result<Vec<(String,String,String,String)>,String> {
    use sqlx::Row;
    let DbConn::MySql(c, _) = conn;
    // Comparison transports Unicode independently of the user's query encoding.
    // A legacy results charset can replace distinct stored characters with '?',
    // which would turn a real difference into a false equality. This changes
    // only this dedicated read-only connection, never table/database defaults.
    sqlx::Executor::execute(&mut *c, "SET NAMES utf8mb4").await.map_err(|e| format!("设置无损对比字符集失败: {e}"))?;
    sqlx::Executor::execute(&mut *c, "SET SESSION lock_wait_timeout=30, SESSION innodb_lock_wait_timeout=30").await.map_err(|e| format!("设置对比锁等待上限失败: {e}"))?;
    sqlx::Executor::execute(&mut *c, "SET SESSION time_zone = '+00:00'").await.map_err(|e| e.to_string())?;
    sqlx::Executor::execute(&mut *c, "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await.map_err(|e| e.to_string())?;
    sqlx::Executor::execute(&mut *c, "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY").await.map_err(|e| e.to_string())?;
    // Acquire metadata lock before reading information_schema; concurrent ALTER
    // must not change the selected column set during this snapshot scan.
    let target = format!("{}.{}", q(schema,true), q(table,true));
    sqlx::Executor::execute(&mut *c, format!("SELECT * FROM {target} LIMIT 0").as_str()).await.map_err(|e| e.to_string())?;
    let rows = sqlx::query("SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME,CAST(DATA_TYPE AS CHAR) AS DATA_TYPE,CAST(COLUMN_TYPE AS CHAR) AS COLUMN_TYPE,CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE,CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY,CAST(EXTRA AS CHAR) AS EXTRA,CAST(COALESCE(COLLATION_NAME,'') AS CHAR) AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION")
        .bind(schema).bind(table).fetch_all(&mut *c).await.map_err(|e| e.to_string())?;
    if rows.is_empty() { return Err("对比表不存在或无权读取元数据".into()); }
    let mut actual_keys = Vec::new();
    let mut signature = Vec::new();
    for row in rows {
        let name: String = row.try_get("COLUMN_NAME").map_err(|e| e.to_string())?;
        let kind: String = row.try_get("DATA_TYPE").map_err(|e| e.to_string())?;
        let full: String = row.try_get("COLUMN_TYPE").map_err(|e| e.to_string())?;
        let extra: String = row.try_get("EXTRA").map_err(|e| e.to_string())?;
        if extra.to_ascii_uppercase().contains("INVISIBLE") { return Err("存在不可见列，SELECT * 不完整，已拒绝对比".into()); }
        let primary = row.try_get::<String,_>("COLUMN_KEY").map_err(|e| e.to_string())? == "PRI";
        if primary { actual_keys.push(name.clone()); }
        if keys.contains(&name) { validate_key_kind(&kind, row.try_get::<String,_>("IS_NULLABLE").map_err(|e| e.to_string())? != "NO", primary)?; }
        let nullable: String = row.try_get("IS_NULLABLE").map_err(|e| e.to_string())?;
        signature.push((name,kind,format!("{full}|{nullable}|{extra}"),row.try_get("collation_name").map_err(|e| e.to_string())?));
    }
    let mut expected=keys.to_vec(); expected.sort(); actual_keys.sort();
    if expected != actual_keys || expected.iter().collect::<std::collections::HashSet<_>>().len()!=expected.len() { return Err("必须选择完整主键，不能使用重复或非唯一列".into()); }
    let engine: Option<String> = sqlx::query_scalar("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND TABLE_TYPE='BASE TABLE'").bind(schema).bind(table).fetch_optional(&mut *c).await.map_err(|e| e.to_string())?.flatten();
    if engine.as_deref()!=Some("InnoDB") { return Err("精确对比要求 InnoDB 基础表的一致性快照".into()); }
    Ok(signature)
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 大表数据对比：验证结构与主键后按独立只读快照分块扫描
///
/// - src_id / dst_id：可以是同一个连接，也可以是两个不同连接
/// - window_id：用于区分多个并发对比任务的进度事件频道
/// - 进度事件名: `diff_progress_{window_id}`
#[tauri::command]
pub async fn db_diff_data(
    src_id: String,
    src_schema: String,
    src_table: String,
    dst_id: String,
    dst_schema: String,
    dst_table: String,
    pk_cols: Vec<String>,
    window_id: String,
    storage: State<'_, StorageState>,
    app: tauri::AppHandle,
) -> Result<DataDiffResult, String> {
    with_comparison_deadline(MAX_COMPARISON_DURATION, async move {
    if pk_cols.is_empty() {
        return Err("主键列不能为空".into());
    }

    // 分别建立两个独立连接（即使是同一 server 也需要两个 connection 以并发扫描）
    let mut src_conn = open_conn(&src_id, &storage).await?;
    let mut dst_conn = open_conn(&dst_id, &storage).await?;
    let event = format!("diff_progress_{window_id}");
    scan_comparison(&mut src_conn, &src_schema, &src_table, &mut dst_conn, &dst_schema, &dst_table, &pk_cols,
        |progress| { let _ = app.emit(&event, progress); }).await
    }).await
}

/// The same streaming core serves IPC and live engine regression tests.
async fn scan_comparison(
    src_conn: &mut DbConn, src_schema: &str, src_table: &str,
    dst_conn: &mut DbConn, dst_schema: &str, dst_table: &str,
    pk_cols: &[String], mut emit: impl FnMut(ProgressEvt),
) -> Result<DataDiffResult, String> {
    let src_columns = prepare_comparison(src_conn, src_schema, src_table, pk_cols).await?;
    let dst_columns = prepare_comparison(dst_conn, dst_schema, dst_table, pk_cols).await?;
    if src_columns != dst_columns { return Err("两表列名、顺序、类型或排序规则不一致，无法声明数据一致；请先核对结构".into()); }

    let column_types = src_columns.iter().map(|(name, kind, _, _)| (name.clone(), kind.clone())).collect();
    let column_encodings = src_columns.iter().filter_map(|(name,kind,_,_)| match kind.as_str() {
        "set" => Some((name.clone(), "set-bitmask".to_string())),
        "enum" => Some((name.clone(), "enum-index".to_string())),
        _ => None,
    }).collect();
    let mut src = Chunk::new();
    let mut dst = Chunk::new();

    let mut total_only_src = 0u64;
    let mut total_only_dst = 0u64;
    let mut total_mismatch  = 0u64;
    let mut rows_scanned   = 0u64;

    let mut samples_only_src: Vec<DiffSample> = Vec::new();
    let mut samples_only_dst: Vec<DiffSample> = Vec::new();
    let mut samples_mismatch:  Vec<DiffSample> = Vec::new();
    let mut checked_sample_count = 0usize;

    let mut last_emit = 0u64;

    // ── 归并主循环 ────────────────────────────────────────────────────────────
    loop {
        if src.needs_refill() {
            refill(&mut src, src_conn, &src_schema, &src_table, &pk_cols).await?;
        }
        if dst.needs_refill() {
            refill(&mut dst, dst_conn, &dst_schema, &dst_table, &pk_cols).await?;
        }

        let s = src.peek_cloned();
        let d = dst.peek_cloned();

        match (s, d) {
            // 两侧均已遍历完
            (None, None) => break,

            // 源有，目标已遍历完 → only-src
            (Some(s_row), None) => {
                let s_pk = row_pk(&src.col_names, &s_row, &pk_cols);
                total_only_src += 1;
                if samples_only_src.len() < SAMPLE_CAP {
                    samples_only_src.push(DiffSample {
                        pk: pk_key(&s_pk),
                        src: row_to_map(&src.col_names, &s_row),
                        dst: HashMap::new(),
                    });
                }
                src.advance();
                rows_scanned += 1;
            }

            // 目标有，源已遍历完 → only-dst
            (None, Some(d_row)) => {
                let d_pk = row_pk(&dst.col_names, &d_row, &pk_cols);
                total_only_dst += 1;
                if samples_only_dst.len() < SAMPLE_CAP {
                    samples_only_dst.push(DiffSample {
                        pk: pk_key(&d_pk),
                        src: HashMap::new(),
                        dst: row_to_map(&dst.col_names, &d_row),
                    });
                }
                dst.advance();
                rows_scanned += 1;
            }

            // 两侧均有行
            (Some(s_row), Some(d_row)) => {
                let s_pk = row_pk(&src.col_names, &s_row, &pk_cols);
                let d_pk = row_pk(&dst.col_names, &d_row, &pk_cols);

                match cmp_pk(&s_pk, &d_pk) {
                    // 源 PK < 目标 PK → 目标缺少此行
                    std::cmp::Ordering::Less => {
                        total_only_src += 1;
                        if samples_only_src.len() < SAMPLE_CAP {
                            samples_only_src.push(DiffSample {
                                pk: pk_key(&s_pk),
                                src: row_to_map(&src.col_names, &s_row),
                                dst: HashMap::new(),
                            });
                        }
                        src.advance();
                        rows_scanned += 1;
                    }

                    // 源 PK > 目标 PK → 源缺少此行
                    std::cmp::Ordering::Greater => {
                        total_only_dst += 1;
                        if samples_only_dst.len() < SAMPLE_CAP {
                            samples_only_dst.push(DiffSample {
                                pk: pk_key(&d_pk),
                                src: HashMap::new(),
                                dst: row_to_map(&dst.col_names, &d_row),
                            });
                        }
                        dst.advance();
                        rows_scanned += 1;
                    }

                    // PK 相同 → 比较非 PK 列（取共有列）
                    std::cmp::Ordering::Equal => {
                        let s_map = row_to_map(&src.col_names, &s_row);
                        let d_map = row_to_map(&dst.col_names, &d_row);

                        let differs = shared_values_differ(&s_map, &d_map, &pk_cols);

                        if differs {
                            total_mismatch += 1;
                            if samples_mismatch.len() < SAMPLE_CAP {
                                samples_mismatch.push(DiffSample {
                                    pk: pk_key(&s_pk),
                                    src: s_map,
                                    dst: d_map,
                                });
                            }
                        }

                        src.advance();
                        dst.advance();
                        rows_scanned += 2;
                    }
                }
            }
        }

        let sample_count = samples_only_src.len() + samples_only_dst.len() + samples_mismatch.len();
        if sample_count != checked_sample_count {
            validate_sample_memory(&[&samples_only_src,&samples_only_dst,&samples_mismatch])?;
            checked_sample_count = sample_count;
        }
        // 定期发送进度
        if rows_scanned - last_emit >= EMIT_EVERY {
            last_emit = rows_scanned;
            emit(ProgressEvt {
                scanned: rows_scanned,
                only_src: total_only_src,
                only_dst: total_only_dst,
                mismatch: total_mismatch,
            });
        }
    }

    // 最终进度
    emit(ProgressEvt {
        scanned: rows_scanned,
        only_src: total_only_src,
        only_dst: total_only_dst,
        mismatch: total_mismatch,
    });

    let sample_capped =
        total_only_src > samples_only_src.len() as u64 ||
        total_only_dst > samples_only_dst.len() as u64 ||
        total_mismatch  > samples_mismatch.len()  as u64;

    Ok(DataDiffResult {
        total_only_src,
        total_only_dst,
        total_mismatch,
        rows_scanned,
        samples_only_src,
        samples_only_dst,
        samples_mismatch,
        sample_capped,
        column_types,
        column_encodings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_comparison_preserves_unicode_despite_connection_encoding() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_TEST_MYSQL_URL").unwrap();
        let mut admin = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database = format!("dbterm_encoding_{}", uuid::Uuid::new_v4().simple());
        let dbq = q(&database, true);
        sqlx::Executor::execute(&mut admin, format!("CREATE DATABASE {dbq} CHARACTER SET utf8mb4").as_str()).await.unwrap();
        let outcome: Result<(), String> = async {
            for (table, value) in [("a", "中😀"), ("b", "文😁")] {
                sqlx::Executor::execute(&mut admin, format!("CREATE TABLE {dbq}.{table}(id INT PRIMARY KEY,v VARCHAR(20)) ENGINE=InnoDB").as_str()).await.map_err(|e| e.to_string())?;
                sqlx::query(&format!("INSERT INTO {dbq}.{table} VALUES(1,?)")).bind(value).execute(&mut admin).await.map_err(|e| e.to_string())?;
            }
            for encoding in ["latin1", "gbk"] {
                let mut source = sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e| e.to_string())?;
                let mut target = sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e| e.to_string())?;
                for conn in [&mut source, &mut target] {
                    sqlx::Executor::execute(conn, format!("SET NAMES {encoding}").as_str()).await.map_err(|e| e.to_string())?;
                }
                let mut source = DbConn::MySql(source, None);
                let mut target = DbConn::MySql(target, None);
                let result = scan_comparison(&mut source, &database, "a", &mut target, &database, "b", &["id".into()], |_| {}).await?;
                if result.total_mismatch != 1 { return Err(format!("{encoding} collapsed distinct Unicode values: mismatches={}", result.total_mismatch)); }
                if result.samples_mismatch[0].src["v"].as_deref() != Some("中😀") || result.samples_mismatch[0].dst["v"].as_deref() != Some("文😁") {
                    return Err(format!("{encoding} did not preserve Unicode sample values"));
                }
            }
            Ok(())
        }.await;
        sqlx::Executor::execute(&mut admin, format!("DROP DATABASE {dbq}").as_str()).await.unwrap();
        outcome.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_comparison_distinguishes_empty_set_and_enum_members() {
        use sqlx::Connection;
        let url=std::env::var("DBTERM_TEST_MYSQL_URL").unwrap();
        let mut admin=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database=format!("dbterm_members_{}",uuid::Uuid::new_v4().simple());
        let target=format!("{}.t",q(&database,true));
        sqlx::Executor::execute(&mut admin,format!("CREATE DATABASE {}",q(&database,true)).as_str()).await.unwrap();
        sqlx::Executor::execute(&mut admin,format!("CREATE TABLE {target}(id INT PRIMARY KEY,s SET('','a'),e ENUM('','x')) ENGINE=InnoDB").as_str()).await.unwrap();
        sqlx::Executor::execute(&mut admin,"SET SESSION sql_mode=''").await.unwrap();
        sqlx::Executor::execute(&mut admin,format!("INSERT INTO {target} VALUES(1,0,0),(2,1,1),(3,NULL,NULL)").as_str()).await.unwrap();
        let mut snapshot=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.unwrap(),None);
        let keys=vec!["id".into()];
        prepare_comparison(&mut snapshot,&database,"t",&keys).await.unwrap();
        let mut chunk=Chunk::new();
        refill(&mut chunk,&mut snapshot,&database,"t",&keys).await.unwrap();
        drop(snapshot);
        sqlx::Executor::execute(&mut admin,format!("DROP DATABASE {}",q(&database,true)).as_str()).await.unwrap();
        assert_ne!(chunk.rows[0][1],chunk.rows[1][1],"empty SET differs from selected empty member");
        assert_ne!(chunk.rows[0][2],chunk.rows[1][2],"ENUM error zero differs from empty member index one");
        assert_eq!(chunk.rows[2][1],None);
        assert_eq!(chunk.rows[2][2],None);
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_full_merge_counts_composite_keys_and_capped_samples() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_TEST_MYSQL_URL").expect("disposable URL required");
        let mut admin = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database = format!("dbterm_merge_{}",uuid::Uuid::new_v4().simple());
        let dbq = q(&database,true);
        sqlx::Executor::execute(&mut admin,format!("CREATE DATABASE {dbq}").as_str()).await.unwrap();
        let outcome: Result<(),String> = async {
            for table in ["a","b"] {
                sqlx::Executor::execute(&mut admin,format!("CREATE TABLE {dbq}.{table}(k BIGINT UNSIGNED, n INT, f FLOAT, v VARCHAR(20), bytes VARBINARY(4), PRIMARY KEY(n,k)) ENGINE=InnoDB").as_str()).await.map_err(|e|e.to_string())?;
                for start in (0..2005).step_by(400) {
                    let rows = (start..(start+400).min(2005)).map(|i|format!("({i},0,1.0000001,'',X'00ff')")).collect::<Vec<_>>().join(",");
                    sqlx::Executor::execute(&mut admin,format!("INSERT INTO {dbq}.{table} VALUES {rows}").as_str()).await.map_err(|e|e.to_string())?;
                }
                sqlx::Executor::execute(&mut admin,format!("INSERT INTO {dbq}.{table} VALUES(18446744073709551615,1,1.0000001,'max',X'ff')").as_str()).await.map_err(|e|e.to_string())?;
            }
            sqlx::Executor::execute(&mut admin,format!("DELETE FROM {dbq}.b WHERE k=2004 AND n=0").as_str()).await.map_err(|e|e.to_string())?;
            sqlx::Executor::execute(&mut admin,format!("INSERT INTO {dbq}.b VALUES(2006,0,1,'extra',NULL)").as_str()).await.map_err(|e|e.to_string())?;
            sqlx::Executor::execute(&mut admin,format!("UPDATE {dbq}.b SET f=1.0000002 WHERE k=2 AND n=0").as_str()).await.map_err(|e|e.to_string())?;
            sqlx::Executor::execute(&mut admin,format!("UPDATE {dbq}.b SET v=NULL WHERE k=3 AND n=0").as_str()).await.map_err(|e|e.to_string())?;
            sqlx::Executor::execute(&mut admin,format!("UPDATE {dbq}.b SET bytes=X'00fe' WHERE k>=4 AND k<254 AND n=0").as_str()).await.map_err(|e|e.to_string())?;
            let mut source=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e|e.to_string())?,None);
            let mut target=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e|e.to_string())?,None);
            // User key order intentionally differs from the declared PK order.
            let result=scan_comparison(&mut source,&database,"a",&mut target,&database,"b",&["k".into(),"n".into()], |_|{}).await?;
            assert_eq!((result.total_only_src,result.total_only_dst,result.total_mismatch,result.rows_scanned),(1,1,252,4012));
            assert!(result.sample_capped);
            assert_eq!(result.samples_mismatch.len(),200);
            assert_eq!(result.column_types.get("bytes").map(String::as_str),Some("varbinary"));
            assert_eq!(result.samples_only_src[0].src.get("k").unwrap().as_deref(),Some("2004"));
            assert_eq!(result.samples_only_dst[0].dst.get("k").unwrap().as_deref(),Some("2006"));
            drop((source,target));
            sqlx::Executor::execute(&mut admin,format!("DELETE FROM {dbq}.b").as_str()).await.map_err(|e|e.to_string())?;
            sqlx::Executor::execute(&mut admin,format!("INSERT INTO {dbq}.b SELECT * FROM {dbq}.a").as_str()).await.map_err(|e|e.to_string())?;
            let mut source=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e|e.to_string())?,None);
            let mut target=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.map_err(|e|e.to_string())?,None);
            let equal=scan_comparison(&mut source,&database,"a",&mut target,&database,"b",&["k".into(),"n".into()], |_|{}).await?;
            assert_eq!((equal.total_only_src,equal.total_only_dst,equal.total_mismatch,equal.rows_scanned),(0,0,0,4012));
            assert!(!equal.sample_capped);
            Ok(())
        }.await;
        sqlx::Executor::execute(&mut admin,format!("DROP DATABASE {dbq}").as_str()).await.unwrap();
        outcome.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_comparison_distinguishes_adjacent_floats() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_TEST_MYSQL_URL").expect("disposable URL required");
        let mut conn = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database = format!("dbterm_float_{}", uuid::Uuid::new_v4().simple());
        let target = format!("{}.t", q(&database, true));
        sqlx::Executor::execute(&mut conn, format!("CREATE DATABASE {}", q(&database,true)).as_str()).await.unwrap();
        sqlx::Executor::execute(&mut conn, format!("CREATE TABLE {target}(id INT PRIMARY KEY, f FLOAT) ENGINE=InnoDB").as_str()).await.unwrap();
        sqlx::Executor::execute(&mut conn, format!("INSERT INTO {target} VALUES(1,1.0000001),(2,1.0000002)").as_str()).await.unwrap();
        let outcome = async {
            let mut snapshot = DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.unwrap(),None);
            let keys = vec!["id".into()];
            prepare_comparison(&mut snapshot,&database,"t",&keys).await.unwrap();
            let mut chunk = Chunk::new();
            refill(&mut chunk,&mut snapshot,&database,"t",&keys).await.unwrap();
            chunk.rows[0][1] != chunk.rows[1][1]
        }.await;
        sqlx::Executor::execute(&mut conn, format!("DROP DATABASE {}",q(&database,true)).as_str()).await.unwrap();
        assert!(outcome, "distinct stored FLOAT values must never compare equal");
    }

    #[tokio::test]
    async fn comparison_deadline_drops_pending_scan_resources_without_success_result() {
        struct Sentinel(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Sentinel { fn drop(&mut self) { self.0.store(true, std::sync::atomic::Ordering::SeqCst); } }
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sentinel = Sentinel(dropped.clone());
        let result: Result<(), String> = super::with_comparison_deadline(std::time::Duration::from_millis(1), async move {
            let _resource = sentinel;
            std::future::pending::<Result<(), String>>().await
        }).await;
        assert!(result.unwrap_err().contains("超时"));
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[test]
    fn integer_cursor_sql_uses_exact_unquoted_numeric_literals() {
        let sql=build_chunk_sql("t","`a`,`b`", &["a".into(),"b".into()], Some(&[Some("+0002".into()),Some("18446744073709551614".into())]),true).unwrap();
        assert!(sql.contains("(2, 18446744073709551614)"));
        assert!(!sql.contains("'"));
        for cursor in [vec![None],vec![Some("1 OR 1=1".into())],vec![Some("1.5".into())],vec![]] {
            assert!(build_chunk_sql("t","id", &["id".into()],Some(&cursor),true).is_err());
        }
    }
    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_keyset_keeps_adjacent_i64_u64_limits_across_pages() {
        use sqlx::Connection;
        let url=std::env::var("DBTERM_TEST_MYSQL_URL").unwrap();
        let mut conn=sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database=format!("dbterm_cursor_{}",uuid::Uuid::new_v4().simple());
        sqlx::Executor::execute(&mut conn,format!("CREATE DATABASE `{database}`").as_str()).await.unwrap();
        let result: Result<(),String>=async {
            for (name,kind,maximum) in [("signed","BIGINT",i64::MAX as i128),("unsigned","BIGINT UNSIGNED",u64::MAX as i128)] {
                let target=format!("`{database}`.`{name}`");
                sqlx::Executor::execute(&mut conn,format!("CREATE TABLE {target}(id {kind} PRIMARY KEY) ENGINE=InnoDB").as_str()).await.map_err(|e|e.to_string())?;
                let values=(0..CHUNK+3).map(|n|format!("({})",maximum-n as i128)).collect::<Vec<_>>().join(",");
                sqlx::Executor::execute(&mut conn,format!("INSERT INTO {target} VALUES {values}").as_str()).await.map_err(|e|e.to_string())?;
                let keys=vec!["id".into()];
                let cursor=vec![Some((maximum-1).to_string())];
                let sql=build_chunk_sql(&target,"`id`",&keys,Some(&cursor),true)?;
                let cast_kind=if name=="unsigned" { "UNSIGNED" } else { "SIGNED" };
                let expression=build_chunk_sql(&format!("(SELECT CAST({maximum} AS {cast_kind}) AS id) AS exact_cursor"),"`id`",&keys,Some(&cursor),true)?;
                let (_,exact)=fetch_rows_mysql(&mut conn,&expression).await?;
                if exact.len()!=1 { return Err(format!("{name} CAST boundary coerced cursor to floating point")); }
                let (_,last)=fetch_rows_mysql(&mut conn,&sql).await?;
                if last.len()!=1 || last[0][0].as_deref()!=Some(maximum.to_string().as_str()) { return Err(format!("{name} adjacent maximum lost by keyset")); }
                let first=build_chunk_sql(&target,"`id`",&keys,None,true)?;
                let (columns,first)=fetch_rows_mysql(&mut conn,&first).await?;
                let cursor=row_pk(&columns,first.last().ok_or("missing first page")?,&keys);
                let second=build_chunk_sql(&target,"`id`",&keys,Some(&cursor),true)?;
                let (_,second)=fetch_rows_mysql(&mut conn,&second).await?;
                if first.len()!=CHUNK as usize || second.len()!=3 || second.last().unwrap()[0].as_deref()!=Some(maximum.to_string().as_str()) { return Err(format!("{name} cross-page maximum lost")); }
            }
            Ok(())
        }.await;
        sqlx::Executor::execute(&mut conn,format!("DROP DATABASE `{database}`").as_str()).await.unwrap();
        result.unwrap();
    }
    #[test]
    fn comparison_retained_samples_have_aggregate_byte_budget() {
        let samples=vec![DiffSample { pk: "1".into(), src:HashMap::from([("large".into(),Some("x".repeat(8*1024*1024)))]),dst:HashMap::new() }];
        assert!(validate_sample_memory(&[&samples]).is_err());
    }
    #[test]
    fn nonbinary_decode_errors_cannot_become_literal_hex_text() {
        let source=include_str!("db_diff.rs");
        let decoding=source.split("async fn fetch_rows_mysql(").nth(1).unwrap().split("// ── PK 辅助").next().unwrap();
        assert!(decoding.contains("Err(error) => return Err"));
        assert!(!decoding.contains("Err(_) => Some(format!"));
    }
    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_TEST_MYSQL_URL"]
    async fn real_mysql_comparison_snapshots_pagination_and_exact_values() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_TEST_MYSQL_URL").expect("disposable URL required");
        let mut admin = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let database = format!("dbterm_diff_{}", uuid::Uuid::new_v4().simple());
        sqlx::Executor::execute(&mut admin, format!("CREATE DATABASE `{database}`").as_str()).await.unwrap();
        let target = format!("`{database}`.t");
        sqlx::Executor::execute(&mut admin, format!("CREATE TABLE {target}(id BIGINT UNSIGNED PRIMARY KEY, d DECIMAL(30,8), dt DATETIME(6), b VARBINARY(8), n VARCHAR(8), e VARCHAR(8)) ENGINE=InnoDB").as_str()).await.unwrap();
        for id in [2u64,10,u64::MAX] {
            sqlx::query(&format!("INSERT INTO {target} VALUES(?,123456789012345.12345678,'2026-11-14 12:34:56.123456',X'0041ff',NULL,'')")).bind(id).execute(&mut admin).await.unwrap();
        }
        let connection = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let mut retained = DbConn::MySql(connection,None);
        let keys = vec!["id".into()];
        let signature = prepare_comparison(&mut retained,&database,"t",&keys).await.unwrap();
        assert_eq!(signature.len(),6);
        sqlx::Executor::execute(&mut admin, format!("INSERT INTO {target}(id) VALUES(99)").as_str()).await.unwrap();
        let mut chunk = Chunk::new();
        refill(&mut chunk,&mut retained,&database,"t",&keys).await.unwrap();
        assert_eq!(chunk.rows.iter().map(|r| r[0].as_deref().unwrap()).collect::<Vec<_>>(),["2","10","18446744073709551615"]);
        assert_eq!(chunk.rows[0][1].as_deref(),Some("123456789012345.12345678"));
        assert_eq!(chunk.rows[0][2].as_deref(),Some("2026-11-14 12:34:56.123456"));
        assert_eq!(chunk.rows[0][3].as_deref(),Some("0x0041ff"));
        assert_eq!(chunk.rows[0][4],None);
        assert_eq!(chunk.rows[0][5].as_deref(),Some(""));
        chunk.idx=chunk.rows.len();
        refill(&mut chunk,&mut retained,&database,"t",&keys).await.unwrap();
        assert!(chunk.done);
        drop(retained);
        for (name, ddl, expected) in [
            ("hidden","id INT PRIMARY KEY, secret INT INVISIBLE","不可见"),
            ("decimal_key","id DECIMAL(20,2) PRIMARY KEY","整数主键"),
        ] {
            sqlx::Executor::execute(&mut admin,format!("CREATE TABLE `{database}`.`{name}`({ddl}) ENGINE=InnoDB").as_str()).await.unwrap();
            let mut candidate=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.unwrap(),None);
            assert!(prepare_comparison(&mut candidate,&database,name,&keys).await.unwrap_err().contains(expected));
        }
        sqlx::Executor::execute(&mut admin,format!("CREATE TABLE `{database}`.generated_value(id INT PRIMARY KEY, v INT, g INT GENERATED ALWAYS AS(v*2) STORED) ENGINE=InnoDB").as_str()).await.unwrap();
        sqlx::Executor::execute(&mut admin,format!("INSERT INTO `{database}`.generated_value(id,v) VALUES(1,3)").as_str()).await.unwrap();
        let mut generated=DbConn::MySql(sqlx::mysql::MySqlConnection::connect(&url).await.unwrap(),None);
        prepare_comparison(&mut generated,&database,"generated_value",&keys).await.unwrap();
        let mut chunk=Chunk::new();
        refill(&mut chunk,&mut generated,&database,"generated_value",&keys).await.unwrap();
        assert_eq!(chunk.rows[0][2].as_deref(),Some("6"));
        drop(generated);
        sqlx::Executor::execute(&mut admin, format!("DROP DATABASE `{database}`").as_str()).await.unwrap();
    }
    #[test]
    fn comparison_rejects_unsafe_keys_and_missing_columns() {
        assert!(validate_key_kind("decimal", false, true).is_err());
        assert!(validate_key_kind("varchar", false, true).is_err());
        assert!(validate_key_kind("bigint", true, true).is_err());
        assert!(validate_key_kind("bigint", false, false).is_err());
        assert!(validate_key_kind("bigint", false, true).is_ok());
        assert!(shared_values_differ(&HashMap::from([("extra".into(), Some("v".into()))]), &HashMap::new(), &[]));
        assert_ne!(pk_key(&[None]), pk_key(&[Some("\u{0}".into())]));
        assert_ne!(pk_key(&[Some("a\u{1}b".into()), Some("c".into())]), pk_key(&[Some("a".into()), Some("b\u{1}c".into())]));
    }
    #[test]
    fn validated_integer_keys_follow_real_integer_order_without_guessing() {
        for (a,b) in [("2","10"),("9223372036854775807","18446744073709551615"),("-9223372036854775808","-1")] {
            assert_eq!(cmp_pk(&[Some(a.into())], &[Some(b.into())]), std::cmp::Ordering::Less);
        }
        assert!(validate_chunk_keys(&["id".into()], &[vec![Some("1".into())],vec![Some("1".into())]], &["id".into()], None).is_err());
        assert!(validate_chunk_keys(&["other".into()], &[vec![Some("1".into())]], &["id".into()], None).is_err());
    }

    #[test]
    fn null_and_empty_text_are_distinct_in_data_comparison() {
        let source = HashMap::from([("value".into(), None)]);
        let target = HashMap::from([("value".into(), Some(String::new()))]);
        assert!(shared_values_differ(&source, &target, &[]));
        assert!(!shared_values_differ(&source, &source, &[]));
    }

    #[tokio::test]
    #[ignore = "requires explicitly selected disposable DBTERM_EXPORT_TEST_URL"]
    async fn mysql_comparison_decodes_numbers_dates_and_nulls_without_loss() {
        use sqlx::Connection;
        let url = std::env::var("DBTERM_EXPORT_TEST_URL").expect("disposable MySQL URL required");
        let mut conn = sqlx::mysql::MySqlConnection::connect(&url).await.unwrap();
        let (_, rows) = fetch_rows_mysql(&mut conn,
            "SELECT CAST(18446744073709551615 AS UNSIGNED) AS id, CAST('2026-01-02' AS DATE) AS dt, NULL AS n, '' AS e, X'ff00' AS b").await.unwrap();
        assert_eq!(rows, vec![vec![Some("18446744073709551615".into()), Some("2026-01-02".into()), None, Some(String::new()), Some("0xff00".into())]]);
    }

    #[test]
    fn test_q_mysql() {
        assert_eq!(q("table", true), "`table`");
        assert_eq!(q("col`name", true), "`col``name`");
    }

    #[test]
    fn test_q_pg() {
        assert_eq!(q("table", false), "\"table\"");
        assert_eq!(q("col\"name", false), "\"col\"\"name\"");
    }

    #[test]
    fn test_chunk_needs_refill() {
        let mut chunk = Chunk::new();
        assert!(chunk.needs_refill());
        chunk.rows.push(vec![Some("1".to_string())]);
        chunk.idx = 0;
        assert!(!chunk.needs_refill());
        chunk.idx = 1;
        assert!(chunk.needs_refill());
        chunk.done = true;
        assert!(!chunk.needs_refill());
    }

    #[test]
    fn test_chunk_peek_advance() {
        let mut chunk = Chunk::new();
        chunk.rows.push(vec![Some("1".to_string())]);
        chunk.rows.push(vec![Some("2".to_string())]);
        chunk.idx = 0;
        assert_eq!(chunk.peek_cloned(), Some(vec![Some("1".to_string())]));
        chunk.advance();
        assert_eq!(chunk.peek_cloned(), Some(vec![Some("2".to_string())]));
        chunk.advance();
        assert_eq!(chunk.peek_cloned(), None);
    }
}
