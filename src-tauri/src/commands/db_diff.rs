// db_diff.rs — 大表数据对比：服务端归并排序，O(chunk_size) 内存
//
// 算法：merge-join + keyset 分页
//   两侧各按主键 ASC 有序拉取，每次只加载 CHUNK 行；
//   同步推进双指针，永不将完整表加载到内存。
//
// 复杂度：O(n) 时间，O(chunk_size) 空间，n 为两表行数之和。
// 支持：同连接 / 跨连接；MySQL 族 / PostgreSQL 族。
// 注意：暂不支持 SSH 隧道连接，遇到此情况返回明确错误。

use std::collections::HashMap;
use tauri::{State, Emitter};
use crate::{models::{ConnType, ConnConfig}, storage::StorageState};
use super::sqlserver::{SsPool, dispatch_ss_query};
use super::driver::DriverRegistry;

// ── 常量 ──────────────────────────────────────────────────────────────────────

const CHUNK: u64 = 2_000;       // 每批拉取行数
const SAMPLE_CAP: usize = 200;  // 每类最多返回样本数
const EMIT_EVERY: u64 = 5_000;  // 每扫描 N 行发一次进度事件

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
    MySql(sqlx::mysql::MySqlConnection),
    Pg(sqlx::postgres::PgConnection),
    // Oracle / SQLServer / ClickHouse：不走 sqlx，经各自 dispatch 取字符串行
    Generic { config: ConnConfig, password: Option<String>, id: String },
}

async fn open_conn(id: &str, storage: &State<'_, StorageState>) -> Result<DbConn, String> {
    let cfgs = storage.lock().unwrap().load()?;
    let config = cfgs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;

    // 拒绝 SSH 隧道（隧道 guard 生命周期问题）
    if let Some(extra) = &config.extra_json {
        #[derive(serde::Deserialize, Default)]
        struct Extra { #[serde(rename = "sshTunnel", default)] ssh_tunnel: bool }
        if serde_json::from_str::<Extra>(extra).unwrap_or_default().ssh_tunnel {
            return Err("数据对比暂不支持 SSH 隧道连接，请在同网络环境下使用直连配置".into());
        }
    }

    let pwd_opt = crate::keychain::get_password(id)?;
    let pwd = pwd_opt.as_deref().unwrap_or("");

    match config.conn_type {
        ConnType::Mysql | ConnType::Mariadb | ConnType::Tidb | ConnType::OceanBase => {
            use sqlx::{ConnectOptions, mysql::{MySqlConnectOptions, MySqlSslMode}};
            use crate::commands::query::MySqlPwdExt;
            let mut opts = MySqlConnectOptions::new()
                .host(config.host.as_deref().unwrap_or("127.0.0.1"))
                .port(config.port.unwrap_or(3306))
                .username(config.username.as_deref().unwrap_or("root"))
                .password_opt(pwd)
                .ssl_mode(MySqlSslMode::Disabled);
            if let Some(db) = config.database.as_deref().filter(|s| !s.is_empty()) {
                opts = opts.database(db);
            }
            let conn = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                opts.connect(),
            ).await.map_err(|_| "连接超时".to_string())?
             .map_err(|e| format!("连接失败: {e}"))?;
            Ok(DbConn::MySql(conn))
        }
        ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss => {
            use sqlx::{ConnectOptions, postgres::{PgConnectOptions, PgSslMode}};
            let opts = PgConnectOptions::new()
                .host(config.host.as_deref().unwrap_or("127.0.0.1"))
                .port(config.port.unwrap_or(5432))
                .username(config.username.as_deref().unwrap_or("postgres"))
                .password(pwd)
                .database(config.database.as_deref().unwrap_or("postgres"))
                .ssl_mode(PgSslMode::Disable);
            let conn = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                opts.connect(),
            ).await.map_err(|_| "连接超时".to_string())?
             .map_err(|e| format!("连接失败: {e}"))?;
            Ok(DbConn::Pg(conn))
        }
        ConnType::Oracle | ConnType::SqlServer | ConnType::ClickHouse => {
            Ok(DbConn::Generic { config, password: pwd_opt, id: id.to_string() })
        }
        _ => Err("暂不支持此连接类型的数据对比".into()),
    }
}

// ── 标识符引号 ────────────────────────────────────────────────────────────────

fn q(s: &str, mysql: bool) -> String {
    if mysql { format!("`{}`", s.replace('`', "``")) }
    else      { format!("\"{}\"", s.replace('"', "\"\"")) }
}

fn escape_val(v: &Option<String>, mysql: bool) -> String {
    match v {
        None    => "NULL".into(),
        // MySQL 默认模式下反斜杠是字符串转义符，尾部 \ 会逃逸闭合引号，需翻倍；
        // PG 默认 standard_conforming_strings=on，反斜杠是字面量，翻倍反而破坏值，故不动。
        Some(s) => {
            let esc = if mysql { s.replace('\\', "\\\\").replace('\'', "''") }
                      else     { s.replace('\'', "''") };
            format!("'{}'", esc)
        }
    }
}

// ── 分块游标 ──────────────────────────────────────────────────────────────────

struct Chunk {
    col_names: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    idx: usize,
    /// 下一批 keyset cursor：上一批最后一行的 PK 值
    cursor: Option<Vec<Option<String>>>,
    done: bool,
}

impl Chunk {
    fn new() -> Self {
        Self { col_names: vec![], rows: vec![], idx: 0, cursor: None, done: false }
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
    ss_pool: &SsPool,
    registry: &DriverRegistry,
) -> Result<(), String> {
    let (cols, rows) = match conn {
        DbConn::MySql(c) => {
            let tbl = format!("{}.{}", q(schema, true), q(table, true));
            let order = pk_cols.iter().map(|c| q(c, true)).collect::<Vec<_>>().join(", ");
            let sql = build_chunk_sql(&tbl, &order, pk_cols, chunk.cursor.as_deref(), true);
            fetch_rows_mysql(c, &sql).await?
        }
        DbConn::Pg(c) => {
            let tbl = format!("{}.{}", q(schema, false), q(table, false));
            let order = pk_cols.iter().map(|c| q(c, false)).collect::<Vec<_>>().join(", ");
            let sql = build_chunk_sql(&tbl, &order, pk_cols, chunk.cursor.as_deref(), false);
            fetch_rows_pg(c, &sql).await?
        }
        DbConn::Generic { config, password, id } => {
            let sql = build_chunk_sql_generic(config.conn_type.clone(), schema, table, pk_cols, chunk.cursor.as_deref());
            fetch_rows_generic(config, password.as_deref(), id.as_str(), &sql, ss_pool, registry).await?
        }
    };

    if rows.is_empty() {
        chunk.done = true;
        return Ok(());
    }

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
) -> String {
    match cursor {
        None => format!("SELECT * FROM {tbl} ORDER BY {order} LIMIT {CHUNK}"),
        Some(vals) => {
            let pk_q: Vec<String> = pk_cols.iter().map(|c| q(c, mysql)).collect();
            let pk_v: Vec<String> = vals.iter().map(|v| escape_val(v, mysql)).collect();
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
    }
}

async fn fetch_rows_mysql(
    conn: &mut sqlx::mysql::MySqlConnection,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    use sqlx::{Row, Column};
    let raw = sqlx::query(sql).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询失败: {e}"))?;
    if raw.is_empty() { return Ok((vec![], vec![])); }
    let cols: Vec<String> = raw[0].columns().iter().map(|c| c.name().to_owned()).collect();
    let rows = raw.iter().map(|r| {
        cols.iter().enumerate().map(|(i, _)| {
            // 先按字符串取；二进制列字符串解码失败 → 退回字节并 hex 编码，
            // 否则二进制列会变成 None（= NULL），导致 diff 误判「相等」而漏报差异。
            r.try_get::<Option<String>, _>(i).ok().flatten()
                .or_else(|| r.try_get::<Option<Vec<u8>>, _>(i).ok().flatten()
                    .map(|b| format!("0x{}", hex::encode(b))))
        }).collect()
    }).collect();
    Ok((cols, rows))
}

async fn fetch_rows_pg(
    conn: &mut sqlx::postgres::PgConnection,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    use sqlx::{Row, Column};
    let raw = sqlx::query(sql).fetch_all(&mut *conn).await
        .map_err(|e| format!("查询失败: {e}"))?;
    if raw.is_empty() { return Ok((vec![], vec![])); }
    let cols: Vec<String> = raw[0].columns().iter().map(|c| c.name().to_owned()).collect();
    let rows = raw.iter().map(|r| {
        cols.iter().enumerate().map(|(i, _)| {
            // 二进制列（bytea 等）字符串解码失败 → hex，避免 diff 误判相等漏报
            r.try_get::<Option<String>, _>(i).ok().flatten()
                .or_else(|| r.try_get::<Option<Vec<u8>>, _>(i).ok().flatten()
                    .map(|b| format!("0x{}", hex::encode(b))))
        }).collect()
    }).collect();
    Ok((cols, rows))
}

// ── Oracle / SQLServer / ClickHouse：方言 keyset SQL + 经 dispatch 取字符串行 ──

fn build_chunk_sql_generic(
    ct: ConnType, schema: &str, table: &str,
    pk_cols: &[String], cursor: Option<&[Option<String>]>,
) -> String {
    let qid: fn(&str) -> String = match ct {
        ConnType::Oracle    => |s| format!("\"{}\"", s.replace('"', "\"\"")),
        ConnType::SqlServer => |s| format!("[{}]", s.replace(']', "]]")),
        _                   => |s| format!("`{}`", s.replace('`', "``")), // ClickHouse
    };
    let esc = |v: &Option<String>| match v {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    };
    let tbl = match ct {
        ConnType::SqlServer => if schema.is_empty() { format!("dbo.{}", qid(table)) }
                               else { format!("{}.dbo.{}", qid(schema), qid(table)) },
        _ => if schema.is_empty() { qid(table) } else { format!("{}.{}", qid(schema), qid(table)) },
    };
    let order = pk_cols.iter().map(|c| qid(c)).collect::<Vec<_>>().join(", ");
    // keyset：展开式 (a>va) OR (a=va AND b>vb) OR …，兼容不支持元组比较的 Oracle/SQLServer
    let where_clause = match cursor {
        None => String::new(),
        Some(vals) => {
            let mut ors: Vec<String> = Vec::new();
            for i in 0..pk_cols.len() {
                let mut ands: Vec<String> = Vec::new();
                for j in 0..i { ands.push(format!("{} = {}", qid(&pk_cols[j]), esc(&vals[j]))); }
                ands.push(format!("{} > {}", qid(&pk_cols[i]), esc(&vals[i])));
                ors.push(format!("({})", ands.join(" AND ")));
            }
            format!(" WHERE {}", ors.join(" OR "))
        }
    };
    match ct {
        ConnType::Oracle    => format!("SELECT * FROM {tbl}{where_clause} ORDER BY {order} FETCH FIRST {CHUNK} ROWS ONLY"),
        ConnType::SqlServer => format!("SELECT TOP {CHUNK} * FROM {tbl}{where_clause} ORDER BY {order}"),
        _                   => format!("SELECT * FROM {tbl}{where_clause} ORDER BY {order} LIMIT {CHUNK}"),
    }
}

async fn fetch_rows_generic(
    config: &ConnConfig, password: Option<&str>, id: &str, sql: &str,
    ss_pool: &SsPool, registry: &DriverRegistry,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    let qr = match config.conn_type {
        ConnType::Oracle => super::oracle::execute_query_impl(
            config.clone(), sql.to_string(), password.map(|s| s.to_string()), registry).await?,
        ConnType::SqlServer => dispatch_ss_query(id, config, sql, ss_pool).await?,
        ConnType::ClickHouse => super::clickhouse::query(config, password, sql).await?,
        _ => return Err("不支持的连接类型".into()),
    };
    Ok((qr.columns, qr.rows))
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
    vals.iter()
        .map(|v| v.as_deref().unwrap_or("\x00"))
        .collect::<Vec<_>>()
        .join("\x01")
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

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// 大表数据对比：merge-join 分块扫描，任意大小均可
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
    ss_pool: State<'_, SsPool>,
    registry: State<'_, DriverRegistry>,
    app: tauri::AppHandle,
) -> Result<DataDiffResult, String> {
    if pk_cols.is_empty() {
        return Err("主键列不能为空".into());
    }

    // 分别建立两个独立连接（即使是同一 server 也需要两个 connection 以并发扫描）
    let mut src_conn = open_conn(&src_id, &storage).await?;
    let mut dst_conn = open_conn(&dst_id, &storage).await?;

    let mut src = Chunk::new();
    let mut dst = Chunk::new();

    let mut total_only_src = 0u64;
    let mut total_only_dst = 0u64;
    let mut total_mismatch  = 0u64;
    let mut rows_scanned   = 0u64;

    let mut samples_only_src: Vec<DiffSample> = Vec::new();
    let mut samples_only_dst: Vec<DiffSample> = Vec::new();
    let mut samples_mismatch:  Vec<DiffSample> = Vec::new();

    let event = format!("diff_progress_{window_id}");
    let mut last_emit = 0u64;

    // ── 归并主循环 ────────────────────────────────────────────────────────────
    loop {
        if src.needs_refill() {
            refill(&mut src, &mut src_conn, &src_schema, &src_table, &pk_cols, &ss_pool, &registry).await?;
        }
        if dst.needs_refill() {
            refill(&mut dst, &mut dst_conn, &dst_schema, &dst_table, &pk_cols, &ss_pool, &registry).await?;
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

                        let differs = src.col_names.iter()
                            .filter(|c| dst.col_names.contains(c) && !pk_cols.contains(c))
                            .any(|c| {
                                let sv = s_map.get(c).and_then(|v| v.as_deref()).unwrap_or("");
                                let dv = d_map.get(c).and_then(|v| v.as_deref()).unwrap_or("");
                                sv != dv
                            });

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

        // 定期发送进度
        if rows_scanned - last_emit >= EMIT_EVERY {
            last_emit = rows_scanned;
            let _ = app.emit(&event, ProgressEvt {
                scanned: rows_scanned,
                only_src: total_only_src,
                only_dst: total_only_dst,
                mismatch: total_mismatch,
            });
        }
    }

    // 最终进度
    let _ = app.emit(&event, ProgressEvt {
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
    })
}
