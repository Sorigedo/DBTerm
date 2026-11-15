//! PostgreSQL 专属管理命令（pg_* 前缀，不污染 MySQL/SQLite 共享函数）
//! 可选增强：pgvector 列探测 / EXPLAIN JSON / 索引类型顾问 / PgBouncer 检测

#[cfg(test)]
mod tls_tests {
    use super::*;
    use std::time::Duration;
    #[tokio::test]
    async fn pg_admin_malformed_extra_rejects_before_direct_connection(){
        for raw in ["{\"sshTunnel\":true,\"sshPort\":\"invalid\"}","{\"sshTunnel\":true,\"sshPassword\":42}","{","[]","null"]{
            let mut cfg=config(1,false,serde_json::json!({}));cfg.extra_json=Some(raw.into());
            let error=match pg_connect(&cfg,None).await{Err(error)=>error,Ok(_)=>panic!("malformed configuration connected")};
            assert_eq!(error,"数据库管理连接配置格式错误，已拒绝连接；请检查连接设置","malformed configuration must never fall back to direct connection");
        }
    }
    #[test]
    fn pg_admin_valid_minimal_extra_preserves_defaults_and_tunnel(){
        for raw in [None,Some(""),Some("  "),Some("{}")]{let mut c=config(1,false,serde_json::json!({}));c.extra_json=raw.map(str::to_string);let parsed=PgConnCfg::from_config(&c).unwrap();assert!(!parsed.ssh_tunnel);assert!(parsed.ssl_mode.is_empty());}
        let c=config(1,false,serde_json::json!({"sshTunnel":true,"sshPort":22,"sshPassword":"fixture"}));let parsed=PgConnCfg::from_config(&c).unwrap();assert!(parsed.ssh_tunnel);assert_eq!(parsed.ssh_port,22);assert!(parsed.ssh_password=="fixture");
    }
    #[test]
    fn pg_admin_tunnel_restores_persisted_credential_at_construction(){
        let cfg=PgConnCfg{ssh_host:"fixture-jump".into(),ssh_port:2222,ssh_user:"fixture-user".into(),ssh_auth_type:"password".into(),..Default::default()};
        let tunnel=cfg.tunnel_config_with("fixture-db",|key|{assert_eq!(key,"fixture-db::ssh-tunnel");Ok(Some("saved-fixture-secret".into()))}).unwrap();
        assert!(tunnel.password=="saved-fixture-secret","saved tunnel credential missing");
        assert_eq!(tunnel.host,"fixture-jump");assert_eq!(tunnel.port,2222);assert_eq!(tunnel.user,"fixture-user");assert_eq!(tunnel.auth_type,"password");
    }
    #[test]
    fn pg_admin_tunnel_legacy_credential_wins_without_lookup(){
        let cfg=PgConnCfg{ssh_password:"legacy-fixture-secret".into(),..Default::default()};
        let tunnel=cfg.tunnel_config_with("fixture-db",|_|panic!("explicit legacy password must bypass lookup")).unwrap();assert!(tunnel.password=="legacy-fixture-secret");
    }
    #[test]
    fn pg_admin_tunnel_missing_saved_credential_allows_key_auth(){
        let cfg=PgConnCfg{ssh_auth_type:"key".into(),ssh_key_path:"fixture-key".into(),..Default::default()};
        let tunnel=cfg.tunnel_config_with("fixture-db",|_|Ok(None)).unwrap();assert!(tunnel.password.is_empty());assert_eq!(tunnel.key_path,"fixture-key");
    }
    #[test]
    fn pg_admin_tunnel_credential_lookup_failure_is_not_empty_password(){
        let cfg=PgConnCfg{ssh_auth_type:"password".into(),..Default::default()};
        let result=cfg.tunnel_config_with("fixture-db",|_|Err("fixture credential store unavailable".into()));assert!(result.is_err(),"credential lookup failure must not attempt empty authentication");
    }
    #[test]
    fn pg_admin_tunnel_agent_and_none_never_read_unused_credentials(){
        for auth in ["agent","none"]{let cfg=PgConnCfg{ssh_auth_type:auth.into(),..Default::default()};let tunnel=cfg.tunnel_config_with("fixture-db",|_|panic!("unused credential lookup must be bypassed")).unwrap();assert!(tunnel.password.is_empty());}
    }
    fn config(port:u16,use_ssl:bool,extra:serde_json::Value)->ConnConfig {
        serde_json::from_value(serde_json::json!({"id":"pg-admin-tls-test","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":use_ssl,"extraJson":extra.to_string(),"createdAt":0,"updatedAt":0})).unwrap()
    }
    #[tokio::test]
    async fn pg_admin_unknown_tls_rejects_before_tunnel_or_network(){
        let cfg=config(1,false,serde_json::json!({"sslMode":"unrecognized","sshTunnel":true,"sshHost":"127.0.0.1","sshPort":1,"sshUser":"unused","sshAuthType":"password"}));
        let error=match pg_connect(&cfg,None).await{Err(error)=>error,Ok(_)=>panic!("unknown TLS policy connected")};
        assert!(error.contains("未知 TLS 模式"),"policy must reject before attempting tunnel: {error}");
    }
    async fn set_ssl(admin:&mut sqlx::PgConnection,enabled:bool)->Result<(),sqlx::Error>{
        sqlx::query(if enabled{"ALTER SYSTEM SET ssl='on'"}else{"ALTER SYSTEM SET ssl='off'"}).execute(&mut *admin).await?;
        let _:bool=sqlx::query_scalar("SELECT pg_reload_conf()").fetch_one(&mut *admin).await?;
        for _ in 0..100{let state:String=sqlx::query_scalar("SHOW ssl").fetch_one(&mut *admin).await?;if state==if enabled{"on"}else{"off"}{return Ok(())}tokio::time::sleep(Duration::from_millis(10)).await;}
        Err(sqlx::Error::Protocol("fixture SSL reload timeout".into()))
    }
    #[tokio::test]
    #[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
    async fn pg_admin_tls_policy_matches_query_connector(){
        use sqlx::Connection;
        static LOCK:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());let _guard=LOCK.lock().await;
        let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();let cert=std::env::var("DBTERM_TEST_PG_TLS_ROOT").unwrap();
        let options=sqlx::postgres::PgConnectOptions::new().host("127.0.0.1").port(port).username("postgres").database("postgres").ssl_mode(sqlx::postgres::PgSslMode::Disable);let mut admin=sqlx::PgConnection::connect_with(&options).await.unwrap();
        let expected=std::path::PathBuf::from(std::env::var("DBTERM_TEST_PG_DATA_DIR").expect("explicit disposable directory required")).canonicalize().unwrap();
        assert!(expected.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("dbterm-isolated-databases-"));
        let actual:String=sqlx::query_scalar("SHOW data_directory").fetch_one(&mut admin).await.unwrap();
        assert_eq!(std::path::PathBuf::from(actual).canonicalize().unwrap(),expected,"refuse SSL mutation outside isolated fixture");
        let unrelated=std::path::Path::new(&cert).parent().unwrap().join("unrelated.crt");
        let disabled=set_ssl(&mut admin,false).await;let required=if disabled.is_ok(){Some(pg_connect(&config(port,true,serde_json::json!({})),None).await)}else{None};let restored=set_ssl(&mut admin,true).await;restored.unwrap();disabled.unwrap();
        assert!(matches!(required,Some(Err(_))),"useSsl=true empty mode must refuse plaintext server");
        let (mut plain,_)=pg_connect(&config(port,true,serde_json::json!({"sslMode":"disabled"})),None).await.unwrap();let encrypted:bool=sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetch_one(&mut plain).await.unwrap();assert!(!encrypted,"explicit disabled must remain plaintext");
        let (mut verified,_)=pg_connect(&config(port,true,serde_json::json!({"sslMode":"verify-full","sslCa":cert})),None).await.unwrap();let encrypted:bool=sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetch_one(&mut verified).await.unwrap();assert!(encrypted);
        let wrong=pg_connect(&config(port,true,serde_json::json!({"sslMode":"verify-full","sslCa":unrelated})),None).await;assert!(wrong.is_err(),"unrelated CA must be rejected");
    }
}

use serde::{Deserialize, Serialize};
use sqlx::{ConnectOptions, Row};
use tauri::State;
use crate::{
    models::{ConnConfig, ConnType},
    storage::StorageState,
};

// ── 私有连接工具 ──────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct PgConnCfg {
    #[serde(rename = "connectTimeout", default)] connect_timeout: u64,
    #[serde(rename = "sslMode",  default)] ssl_mode:  String,
    #[serde(rename = "sslCa",   default)] ssl_ca:    String,
    #[serde(rename = "sslCert", default)] ssl_cert:  String,
    #[serde(rename = "sslKey",  default)] ssl_key:   String,
    #[serde(rename = "sshTunnel",   default)] ssh_tunnel:   bool,
    #[serde(rename = "sshHost",     default)] ssh_host:     String,
    #[serde(rename = "sshPort",     default)] ssh_port:     u16,
    #[serde(rename = "sshUser",     default)] ssh_user:     String,
    #[serde(rename = "sshAuthType", default)] ssh_auth_type: String,
    #[serde(rename = "sshPassword", default)] ssh_password: String,
    #[serde(rename = "sshKeyPath",  default)] ssh_key_path: String,
}
impl PgConnCfg {
    fn tunnel_config_with(&self,conn_id:&str,lookup:impl FnOnce(&str)->Result<Option<String>,String>)->Result<crate::db_tunnel::DbTunnelCfg,String>{
        // save_connection removes legacy plaintext after persisting this exact key.
        let password=if matches!(self.ssh_auth_type.as_str(),"agent"|"none"){String::new()}else if !self.ssh_password.is_empty(){self.ssh_password.clone()}else{
            lookup(&format!("{conn_id}::ssh-tunnel")).map_err(|_|"读取数据库 SSH 隧道凭据失败，已拒绝连接；请检查凭据存储后重试".to_string())?.unwrap_or_default()
        };
        Ok(crate::db_tunnel::DbTunnelCfg{host:self.ssh_host.clone(),port:self.ssh_port,user:self.ssh_user.clone(),auth_type:self.ssh_auth_type.clone(),password,key_path:self.ssh_key_path.clone()})
    }
    fn from_config(c: &ConnConfig) -> Result<Self,String> {
        let Some(raw)=c.extra_json.as_deref().filter(|s|!s.trim().is_empty())else{return Ok(Self::default())};
        let error=||"数据库管理连接配置格式错误，已拒绝连接；请检查连接设置".to_string();
        let value:serde_json::Value=serde_json::from_str(raw).map_err(|_|error())?;
        if !value.is_object(){return Err(error())}
        serde_json::from_value(value).map_err(|_|error())
    }
    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            if self.connect_timeout == 0 { 15 } else { self.connect_timeout.clamp(3, 60) }
        )
    }
}

fn load_conn(id: &str, storage: &State<'_, StorageState>) -> Result<(ConnConfig, Option<String>), String> {
    let configs = storage.lock().map_err(|_| "存储锁失败".to_string())?.load()?;
    let config  = configs.into_iter().find(|c| c.id == id)
        .ok_or_else(|| format!("连接不存在: {id}"))?;
    let password = crate::keychain::get_password(id)?;
    Ok((config, password))
}

fn is_pg_like(t: &ConnType) -> bool {
    matches!(t, ConnType::Postgres | ConnType::KingBase | ConnType::OpenGauss)
}

async fn pg_connect(
    config: &ConnConfig,
    password: Option<&str>,
) -> Result<(sqlx::PgConnection, Option<std::sync::Arc<crate::db_tunnel::DbTunnel>>), String> {
    use sqlx::postgres::PgConnectOptions;
    use crate::{db_tunnel::DbTunnel, tester::expand_home};

    let cfg  = PgConnCfg::from_config(config)?;
    let tls_mode = super::query::pg_tls_mode(config, &cfg.ssl_mode)?;
    let user = config.username.as_deref().unwrap_or("postgres");
    let db   = config.database.as_deref().unwrap_or("postgres");
    let pwd  = password.unwrap_or("");

    let tunnel: Option<std::sync::Arc<DbTunnel>>;
    let (h, p) = if cfg.ssh_tunnel {
        let tcfg = cfg.tunnel_config_with(&config.id,crate::keychain::get_password)?;
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

    let mut opts = PgConnectOptions::new()
        .host(&h).port(p).username(user).password(pwd).database(db);
    opts = opts.ssl_mode(tls_mode);
    if !cfg.ssl_ca.is_empty()   { opts = opts.ssl_root_cert(expand_home(&cfg.ssl_ca)); }
    if !cfg.ssl_cert.is_empty() { opts = opts.ssl_client_cert(expand_home(&cfg.ssl_cert)); }
    if !cfg.ssl_key.is_empty()  { opts = opts.ssl_client_key(expand_home(&cfg.ssl_key)); }

    let conn = tokio::time::timeout(cfg.timeout(), opts.connect())
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {e}"))?;

    Ok((conn, tunnel))
}

// ── 可选增强 PG4.3: pgvector 向量列探测 ────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgVectorColumn {
    pub schema_name: String,
    pub table_name: String,
    pub column_name: String,
    pub dimensions: Option<i32>,
    pub index_type: Option<String>,
}

/// PG4.3+: 发现当前数据库中所有 pgvector `vector` 类型列，可用于相似度查询助手
/// 若 pgvector 扩展未安装则返回空列表（graceful）
#[tauri::command]
pub async fn pg_vector_info(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<PgVectorColumn>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !is_pg_like(&config.conn_type) {
        return Err("此命令仅适用于 PostgreSQL / KingBase / openGauss 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = pg_connect(&config, password.as_deref()).await?;

    // pgvector 类型在 pg_type 中注册为 'vector'
    let sql = "\
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attname AS column_name,
       -- 从 format_type 文本（如 vector(384)）中用正则提取维度，避免对 '384)' 直接 ::integer 报错
       NULLIF(substring(format_type(a.atttypid, a.atttypmod) from '\\((\\d+)\\)'), '')::integer AS dimensions,
       (SELECT am.amname
        FROM pg_index ix
        JOIN pg_class ic ON ix.indexrelid = ic.oid
        JOIN pg_am am ON ic.relam = am.oid
        JOIN pg_attribute ia ON ia.attrelid = c.oid AND ia.attnum = ANY(ix.indkey) AND ia.attname = a.attname
        WHERE ix.indrelid = c.oid LIMIT 1) AS index_type
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_type t ON a.atttypid = t.oid
WHERE t.typname = 'vector'
  AND a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
ORDER BY n.nspname, c.relname, a.attname";

    let rows = match sqlx::query(sql).fetch_all(&mut conn).await {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("vector") || msg.contains("does not exist") {
                return Ok(vec![]); // pgvector 未安装
            }
            return Err(format!("查询向量列失败: {e}"));
        }
    };

    Ok(rows.iter().map(|r| PgVectorColumn {
        schema_name: r.try_get::<String, _>(0).unwrap_or_default(),
        table_name:  r.try_get::<String, _>(1).unwrap_or_default(),
        column_name: r.try_get::<String, _>(2).unwrap_or_default(),
        dimensions:  r.try_get::<i32, _>(3).ok(),
        index_type:  r.try_get::<String, _>(4).ok(),
    }).collect())
}

// ── 可选增强 PG2: BRIN/GIN/GiST 索引类型顾问 ───────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgIndexSuggestion {
    pub schema_name: String,
    pub table_name: String,
    pub column_name: String,
    pub current_index: Option<String>,
    pub suggested_type: String,
    pub reason: String,
}

/// PG2+: 根据列类型分析建议最优索引类型（BRIN/GIN/GiST/btree）
/// 只读查询 pg_catalog，不修改任何数据
#[tauri::command]
pub async fn pg_index_advisor(
    id: String,
    schema: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<PgIndexSuggestion>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !is_pg_like(&config.conn_type) {
        return Err("此命令仅适用于 PostgreSQL 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = pg_connect(&config, password.as_deref()).await?;

    let schema_filter = if schema.is_empty() { "public".to_string() } else { schema };

    let sql = "\
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attname AS column_name,
       t.typname AS type_name,
       t.typcategory AS type_cat,
       -- 已有索引信息（取第一个）
       (SELECT am.amname
        FROM pg_index ix
        JOIN pg_class ic ON ix.indexrelid = ic.oid
        JOIN pg_am am ON ic.relam = am.oid
        WHERE ix.indrelid = c.oid
          AND a.attnum = ANY(ix.indkey)
        LIMIT 1) AS current_index_type,
       -- 表大小估计（用于判断 BRIN 适用性）
       c.reltuples::bigint AS est_rows
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
JOIN pg_type t ON a.atttypid = t.oid
WHERE n.nspname = $1
  AND a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind = 'r'
  -- reltuples<0 表示从未 ANALYZE（PG14+），一并纳入避免漏掉未分析的大表
  AND (c.reltuples > 1000 OR c.reltuples < 0)
ORDER BY c.reltuples DESC, n.nspname, c.relname, a.attnum
LIMIT 200";

    let rows = sqlx::query(sql)
        .bind(&schema_filter)
        .fetch_all(&mut conn).await
        .map_err(|e| format!("查询列信息失败: {e}"))?;

    let mut suggestions = Vec::new();
    for row in &rows {
        let schema_name:    String = row.try_get(0).unwrap_or_default();
        let table_name:     String = row.try_get(1).unwrap_or_default();
        let column_name:    String = row.try_get(2).unwrap_or_default();
        let type_name:      String = row.try_get(3).unwrap_or_default();
        let type_cat:       String = row.try_get(4).unwrap_or_default();
        let current_index:  Option<String> = row.try_get(5).ok();
        let est_rows:       i64   = row.try_get(6).unwrap_or(0);

        let (suggested_type, reason) = suggest_index_type(
            &type_name, &type_cat, current_index.as_deref(), est_rows
        );

        // 只输出有实质建议的列
        if let Some(stype) = suggested_type {
            suggestions.push(PgIndexSuggestion {
                schema_name, table_name, column_name,
                current_index,
                suggested_type: stype,
                reason,
            });
        }
    }
    Ok(suggestions)
}

fn suggest_index_type(
    type_name: &str,
    type_cat: &str,
    current: Option<&str>,
    est_rows: i64,
) -> (Option<String>, String) {
    // 已有最优索引则不建议
    match (type_name, current) {
        // JSON/JSONB → GIN
        ("jsonb", None) | ("json", None) =>
            return (Some("GIN".into()), "jsonb/json 列支持 GIN 索引，可加速 @>、? 等 JSON 操作".into()),
        ("jsonb", Some(t)) | ("json", Some(t)) if t != "gin" =>
            return (Some("GIN".into()), format!("当前索引类型 {t}，json 列改用 GIN 效果更好")),
        // tsvector → GIN
        ("tsvector", None) =>
            return (Some("GIN".into()), "tsvector 列应使用 GIN 索引加速全文检索".into()),
        // 数组 → GIN
        (_, None) if type_cat == "A" =>
            return (Some("GIN".into()), "数组列使用 GIN 索引支持 && / @> 运算符".into()),
        // 时间/数字大表 → BRIN（顺序写入场景）
        ("timestamp" | "timestamptz" | "date" | "int4" | "int8", None) if est_rows > 1_000_000 =>
            return (Some("BRIN".into()), format!("大表 (~{est_rows} 行) 时序/数值列可考虑 BRIN，写入顺序时极低存储开销")),
        // 几何/PostGIS → GiST
        ("point" | "box" | "circle" | "polygon" | "line" | "lseg" | "path", None) =>
            return (Some("GiST".into()), "几何列应使用 GiST 索引支持空间查询".into()),
        // vector → IVFFlat/HNSW (pgvector)
        ("vector", None) =>
            return (Some("IVFFlat/HNSW".into()), "pgvector 向量列应创建 IVFFlat 或 HNSW 索引加速近似最近邻搜索".into()),
        // 已有合适索引，不建议
        _ => {}
    }
    (None, String::new())
}

// ── 可选增强 PG1.6: EXPLAIN ANALYZE JSON 导出 ────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgExplainResult {
    pub plan_json: String,
    pub plan_text: String,
    pub planning_time_ms: f64,
    pub execution_time_ms: f64,
}

/// PG1.6+: EXPLAIN (ANALYZE, FORMAT JSON) 返回结构化计划（用于可视化/对比）
/// ANALYZE 会实际执行一次查询；强制只读事务不能隔离用户函数的外部副作用。
#[tauri::command]
pub async fn pg_explain_json(
    id: String,
    sql: String,
    analyze: bool,
    storage: State<'_, StorageState>,
) -> Result<PgExplainResult, String> {
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    let (config, password) = load_conn(&id, &storage)?;
    if !is_pg_like(&config.conn_type) {
        return Err("此命令仅适用于 PostgreSQL 连接".to_string());
    }
    drop(storage);

    // 安全校验（后端是安全边界，不依赖前端）：
    let trimmed = sql.trim().trim_end_matches(';').trim();
    // 1) 防多语句注入：去掉尾分号后正文不应再含分号
    if trimmed.contains(';') {
        return Err("不支持一次分析多条语句（SQL 中包含分号）".to_string());
    }
    // 2) ANALYZE 会真实执行语句，仅允许只读查询（SELECT / WITH 开头）
    if analyze {
        let head = trimmed.to_ascii_uppercase();
        if !(head.starts_with("SELECT") || head.starts_with("WITH")) {
            return Err("ANALYZE 模式仅允许分析 SELECT / WITH 查询，以免执行写操作".to_string());
        }
    }

    let (mut conn, _tunnel) = pg_connect(&config, password.as_deref()).await?;

    super::pg_explain::run(&mut conn, trimmed, analyze).await
}

// ── 可选增强 PG0: PgBouncer / 连接池感知 ────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPoolInfo {
    pub is_pgbouncer: bool,
    pub pgbouncer_version: Option<String>,
    pub pool_mode: Option<String>,
    pub max_client_conn: Option<i32>,
    pub current_pools: i32,
}

/// PG0+: 检测是否通过 PgBouncer 连接，并获取连接池模式
/// 通过 SHOW DATABASES / SHOW POOLS 命令检测 PgBouncer 特征
#[tauri::command]
pub async fn pg_pgbouncer_detect(
    id: String,
    storage: State<'_, StorageState>,
) -> Result<PgPoolInfo, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if !is_pg_like(&config.conn_type) {
        return Err("此命令仅适用于 PostgreSQL 连接".to_string());
    }
    drop(storage);
    let (mut conn, _tunnel) = pg_connect(&config, password.as_deref()).await?;

    // SHOW VERSION：PgBouncer admin 控制台返回 "PgBouncer X.Y.Z"；
    // 普通 PostgreSQL 无此命令会报错（被 unwrap_or(None) 吞为 None → 判定非 PgBouncer）
    let version_row = sqlx::query("SHOW VERSION")
        .fetch_optional(&mut conn).await
        .unwrap_or(None);

    let server_version: String = version_row
        .and_then(|r| r.try_get::<String, _>(0).ok())
        .unwrap_or_default();

    let is_pgbouncer = server_version.to_lowercase().contains("pgbouncer");

    if !is_pgbouncer {
        return Ok(PgPoolInfo {
            is_pgbouncer: false,
            pgbouncer_version: None,
            pool_mode: None,
            max_client_conn: None,
            current_pools: 0,
        });
    }

    // 进一步查询 PgBouncer 专属信息
    let pools_row = sqlx::query("SHOW POOLS")
        .fetch_all(&mut conn).await
        .unwrap_or_default();
    let current_pools = pools_row.len() as i32;

    let config_row = sqlx::query("SHOW CONFIG")
        .fetch_all(&mut conn).await
        .unwrap_or_default();
    let mut pool_mode = None;
    let mut max_client_conn = None;
    for r in &config_row {
        let key: String = r.try_get(0).unwrap_or_default();
        let val: String = r.try_get(1).unwrap_or_default();
        match key.as_str() {
            "pool_mode"       => pool_mode = Some(val),
            "max_client_conn" => max_client_conn = val.parse().ok(),
            _ => {}
        }
    }

    Ok(PgPoolInfo {
        is_pgbouncer: true,
        pgbouncer_version: Some(server_version),
        pool_mode,
        max_client_conn,
        current_pools,
    })
}

// ── 可选增强 PG5: 两实例 pg_settings 配置对比 ──────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSettingDiff {
    pub name: String,
    pub category: String,
    pub value_a: Option<String>,  // None 表示该实例缺此配置项
    pub value_b: Option<String>,
}

/// PG5+: 对比两个 PostgreSQL 实例的 pg_settings，只返回有差异的项（含一方缺失）
#[tauri::command]
pub async fn pg_settings_diff(
    id_a: String,
    id_b: String,
    storage: State<'_, StorageState>,
) -> Result<Vec<PgSettingDiff>, String> {
    let (ca, pa) = load_conn(&id_a, &storage)?;
    let (cb, pb) = load_conn(&id_b, &storage)?;
    if !is_pg_like(&ca.conn_type) || !is_pg_like(&cb.conn_type) {
        return Err("两个连接都必须是 PostgreSQL / KingBase / openGauss".to_string());
    }
    drop(storage);

    // 拼 setting+unit 作为可读值；category 用于前端分组
    let sql = "SELECT name, setting, COALESCE(unit, '') AS unit, category FROM pg_settings";
    let fetch = |rows: Vec<sqlx::postgres::PgRow>| -> std::collections::BTreeMap<String, (String, String)> {
        let mut m = std::collections::BTreeMap::new();
        for r in &rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let setting: String = r.try_get(1).unwrap_or_default();
            let unit: String = r.try_get(2).unwrap_or_default();
            let category: String = r.try_get(3).unwrap_or_default();
            let val = if unit.is_empty() { setting } else { format!("{setting} {unit}") };
            m.insert(name, (val, category));
        }
        m
    };

    let (mut conn_a, _ta) = pg_connect(&ca, pa.as_deref()).await?;
    let rows_a = sqlx::query(sql).fetch_all(&mut conn_a).await
        .map_err(|e| format!("查询实例 A 配置失败: {e}"))?;
    drop(conn_a);
    let map_a = fetch(rows_a);

    let (mut conn_b, _tb) = pg_connect(&cb, pb.as_deref()).await?;
    let rows_b = sqlx::query(sql).fetch_all(&mut conn_b).await
        .map_err(|e| format!("查询实例 B 配置失败: {e}"))?;
    drop(conn_b);
    let map_b = fetch(rows_b);

    let mut out = Vec::new();
    // A 中的项：值不同或 B 缺失
    for (name, (va, cat)) in &map_a {
        match map_b.get(name) {
            Some((vb, _)) if vb != va => out.push(PgSettingDiff {
                name: name.clone(), category: cat.clone(),
                value_a: Some(va.clone()), value_b: Some(vb.clone()),
            }),
            None => out.push(PgSettingDiff {
                name: name.clone(), category: cat.clone(),
                value_a: Some(va.clone()), value_b: None,
            }),
            _ => {}  // 值相同，跳过
        }
    }
    // B 独有的项
    for (name, (vb, cat)) in &map_b {
        if !map_a.contains_key(name) {
            out.push(PgSettingDiff {
                name: name.clone(), category: cat.clone(),
                value_a: None, value_b: Some(vb.clone()),
            });
        }
    }
    out.sort_by(|x, y| x.name.cmp(&y.name));
    Ok(out)
}
