// MO4/MO6: 集合索引 + 实例监控
use bson::{doc, Document};
use serde::Serialize;
use tauri::State;
use futures::TryStreamExt;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

fn doc_to_json(d: &Document) -> String {
    serde_json::to_string(d).unwrap_or_else(|_| "{}".to_string())
}

/// Tauri 命令：serverStatus（实例仪表盘）
#[tauri::command]
pub async fn mongo_server_status(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let result = client.database("admin")
        .run_command(doc! { "serverStatus": 1 }).await
        .map_err(|e| format!("serverStatus 失败: {e}"))?;
    Ok(doc_to_json(&result))
}

/// Tauri 命令：currentOp（当前操作）
#[tauri::command]
pub async fn mongo_current_op(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let result = client.database("admin")
        .run_command(doc! { "currentOp": 1 }).await
        .map_err(|e| format!("currentOp 失败: {e}"))?;
    Ok(doc_to_json(&result))
}

/// Tauri 命令：实例信息（buildInfo + hello）
#[tauri::command]
pub async fn mongo_build_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let build_info = client.database("admin")
        .run_command(doc! { "buildInfo": 1 }).await
        .map_err(|e| format!("buildInfo 失败: {e}"))?;
    let hello = client.database("admin")
        .run_command(doc! { "hello": 1 }).await
        .unwrap_or_default();
    let combined = serde_json::json!({
        "buildInfo": serde_json::from_str::<serde_json::Value>(&doc_to_json(&build_info)).ok(),
        "hello": serde_json::from_str::<serde_json::Value>(&doc_to_json(&hello)).ok(),
    });
    Ok(combined.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub key: String,       // JSON
    pub unique: bool,
    pub sparse: bool,
    pub ttl_seconds: Option<i64>,
    pub partial_filter: Option<String>,
    pub is_text: bool,
    pub access_ops: Option<i64>,   // $indexStats.accesses.ops（使用次数）
    pub index_type: String,        // "regular" | "text" | "2dsphere" | "hashed"
}

fn infer_index_type(key_json: &str) -> String {
    if key_json.contains("\"text\"")    { return "text".to_string() }
    if key_json.contains("\"2dsphere\"") { return "2dsphere".to_string() }
    if key_json.contains("\"hashed\"")  { return "hashed".to_string() }
    "regular".to_string()
}

/// Tauri 命令：列出集合索引（MO4.1，含 $indexStats 访问次数）
#[tauri::command]
pub async fn mongo_list_indexes(
    id: String,
    db: String,
    coll: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<IndexInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    // 先采集 $indexStats（访问次数），失败不影响主流程
    let mut access_map: std::collections::HashMap<String, i64> = Default::default();
    let stats_pipeline = vec![doc! { "$indexStats": {} }];
    if let Ok(cursor) = collection.aggregate(stats_pipeline).await {
        if let Ok(docs) = cursor.try_collect::<Vec<Document>>().await {
            for doc in docs {
                let name = doc.get_str("name").unwrap_or("").to_string();
                let ops = doc.get_document("accesses").ok()
                    .and_then(|a| a.get_i64("ops").ok())
                    .unwrap_or(0);
                access_map.insert(name, ops);
            }
        }
    }

    let mut cursor = collection.list_indexes().await
        .map_err(|e| format!("列出索引失败: {e}"))?;

    let mut indexes = Vec::new();
    while let Some(idx) = cursor.try_next().await.map_err(|e| format!("读取索引失败: {e}"))? {
        let options = idx.options.as_ref();
        let name = options.and_then(|o| o.name.as_deref()).unwrap_or("_id_").to_string();
        let key = doc_to_json(&idx.keys);
        let unique = options.and_then(|o| o.unique).unwrap_or(false);
        let sparse = options.and_then(|o| o.sparse).unwrap_or(false);
        let ttl_seconds = options.and_then(|o| o.expire_after)
            .map(|d| d.as_secs() as i64);
        let partial_filter = options.and_then(|o| o.partial_filter_expression.as_ref())
            .map(|d| doc_to_json(d));
        let is_text = key.contains("\"text\"");
        let index_type = infer_index_type(&key);
        let access_ops = access_map.get(&name).copied();

        indexes.push(IndexInfo { name, key, unique, sparse, ttl_seconds, partial_filter, is_text, access_ops, index_type });
    }
    Ok(indexes)
}

/// Tauri 命令：删除索引（MO4.3）— 需前端确认
#[tauri::command]
pub async fn mongo_drop_index(
    id: String,
    db: String,
    coll: String,
    index_name: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if index_name == "_id_" {
        return Err("_id 索引不可删除".to_string());
    }
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let database = client.database(&db);
    database.run_command(doc! { "dropIndexes": &coll, "index": &index_name }).await
        .map_err(|e| format!("删除索引失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：killOp（MO6.2）— 终止当前操作，需前端二级确认
#[tauri::command]
pub async fn mongo_kill_op(
    id: String,
    op_id: i64,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    client.database("admin")
        .run_command(doc! { "killOp": 1, "op": op_id }).await
        .map_err(|e| format!("killOp 失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：Shell 执行 runCommand（MO5.1）
/// db_name: 目标数据库名（"admin" 或普通库）
/// cmd_json: 命令文档 JSON，如 {"ping":1} / {"serverStatus":1}
/// 危险命令（drop/shutdown/dropDatabase/deleteMany({}) 等）由前端拦截后传 confirmed=true 允许执行
#[tauri::command]
pub async fn mongo_run_command(
    id: String,
    db_name: String,
    cmd_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let val: serde_json::Value = serde_json::from_str(&cmd_json)
        .map_err(|e| format!("命令 JSON 格式错误: {e}"))?;
    let cmd_doc = bson::to_document(&val)
        .map_err(|e| format!("命令转换失败: {e}"))?;

    // 只读护栏：runCommand 可执行写/管理命令（drop/createUser/shutdown…），只读连接下必须拦截。
    // 命令名 = 文档第一个键；命中写/管理命令集合即拒绝（read 命令如 ping/serverStatus 放行）。
    if config.read_only == Some(true) {
        const MONGO_WRITE_CMDS: &[&str] = &[
            "insert", "update", "delete", "findandmodify", "create", "createindexes",
            "drop", "dropdatabase", "dropindexes", "renamecollection", "collmod",
            "converttocapped", "clonecollectionascapped", "compact", "fsync",
            "mapreduce", "applyops", "bulkwrite",  // 也能写数据，旧版漏列
            "createuser", "dropuser", "updateuser", "grantrolestouser", "revokerolesfromuser",
            "createrole", "droprole", "updaterole", "dropallrolesfromdatabase", "dropallusersfromdatabase",
            "shutdown", "killop", "setparameter", "setfeaturecompatibilityversion", "flushrouterconfig",
            "enablesharding", "shardcollection", "reshardcollection", "movechunk", "mergechunks",
            "splitchunk", "setbalancerstate", "balancerstart", "balancerstop", "cleanuporphaned",
        ];
        let cmd_name = cmd_doc.keys().next().map(|k| k.to_lowercase()).unwrap_or_default();
        if MONGO_WRITE_CMDS.contains(&cmd_name.as_str()) {
            return Err(format!("当前连接为只读模式，已拒绝写/管理命令: {cmd_name}"));
        }
        // aggregate 本身是读，但含 $out / $merge 阶段会写入集合 → 只读下必须拦截
        if cmd_name == "aggregate" {
            if let Ok(pipeline) = cmd_doc.get_array("pipeline") {
                let has_write_stage = pipeline.iter().any(|stage| {
                    stage.as_document().map_or(false, |d| d.contains_key("$out") || d.contains_key("$merge"))
                });
                if has_write_stage {
                    return Err("当前连接为只读模式，已拒绝含 $out/$merge 的聚合（会写入集合）".to_string());
                }
            }
        }
    }

    let result = client.database(db_name.as_str()).run_command(cmd_doc).await
        .map_err(|e| format!("命令执行失败: {e}"))?;
    Ok(doc_to_json(&result))
}

// ── MO10.2 配置风险扫描 ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRiskItem {
    pub level: String,   // high | medium | low | info
    pub item: String,
    pub detail: String,
    pub suggestion: String,
}

/// MO10.2: 扫描 MongoDB 实例的常见配置风险（认证/绑定地址/TLS/版本）。
/// 需 clusterMonitor 级权限读取 getCmdLineOpts，权限不足时降级提示。
#[tauri::command]
pub async fn mongo_config_risks(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<MongoRiskItem>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let admin = client.database("admin");
    let mut risks: Vec<MongoRiskItem> = Vec::new();

    match admin.run_command(doc! {"getCmdLineOpts": 1}).await {
        Ok(opts) => {
            let parsed = opts.get_document("parsed").ok();
            // 访问控制
            let auth = parsed.and_then(|p| p.get_document("security").ok())
                .and_then(|s| s.get_str("authorization").ok().map(|x| x.to_string()));
            if auth.as_deref() != Some("enabled") {
                risks.push(MongoRiskItem {
                    level: "high".into(), item: "未启用访问控制".into(),
                    detail: "security.authorization 未设为 enabled，可能允许无认证访问".into(),
                    suggestion: "配置 security.authorization=enabled 并创建管理用户".into(),
                });
            }
            if let Some(net) = parsed.and_then(|p| p.get_document("net").ok()) {
                if let Ok(bind) = net.get_str("bindIp") {
                    if bind.contains("0.0.0.0") {
                        risks.push(MongoRiskItem {
                            level: "medium".into(), item: "监听所有网卡".into(),
                            detail: format!("net.bindIp = {bind}，暴露在所有网络接口"),
                            suggestion: "限制 bindIp 为内网/回环地址，或用防火墙限制访问".into(),
                        });
                    }
                }
                if net.get_document("tls").is_err() && net.get_document("ssl").is_err() {
                    risks.push(MongoRiskItem {
                        level: "medium".into(), item: "未启用 TLS".into(),
                        detail: "net.tls/ssl 未配置，客户端连接明文传输".into(),
                        suggestion: "生产环境启用 TLS 加密客户端连接".into(),
                    });
                }
            }
        }
        Err(e) => {
            risks.push(MongoRiskItem {
                level: "info".into(), item: "无法读取启动配置".into(),
                detail: format!("getCmdLineOpts 失败（通常需 clusterMonitor/clusterAdmin 权限）: {e}"),
                suggestion: "用具备 clusterMonitor 角色的账号连接以完整扫描".into(),
            });
        }
    }

    // 版本检查
    if let Ok(bi) = admin.run_command(doc! {"buildInfo": 1}).await {
        if let Ok(ver) = bi.get_str("version") {
            let major: u32 = ver.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            if major > 0 && major < 5 {
                risks.push(MongoRiskItem {
                    level: "low".into(), item: "MongoDB 版本较旧".into(),
                    detail: format!("当前版本 {ver}，5.0 以下多已停止维护"),
                    suggestion: "评估升级到受支持版本（5.0+）".into(),
                });
            }
        }
    }

    if risks.is_empty() {
        risks.push(MongoRiskItem {
            level: "info".into(), item: "未发现明显配置风险".into(),
            detail: "已检查访问控制 / 绑定地址 / TLS / 版本".into(),
            suggestion: String::new(),
        });
    }
    Ok(risks)
}

// ── MO6.3 慢查询 Profiler ────────────────────────────────────────────────────

/// 获取 profiling 状态（level + slowMs）
#[tauri::command]
pub async fn mongo_get_profile_status(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let result = client.database(&db)
        .run_command(doc! { "profile": -1 }).await
        .map_err(|e| format!("获取 profiling 状态失败: {e}"))?;
    Ok(doc_to_json(&result))
}

/// 设置 profiling 级别（0=关 / 1=慢查询 / 2=全量）
#[tauri::command]
pub async fn mongo_set_profile_level(
    id: String,
    db: String,
    level: i32,
    slow_ms: Option<i32>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if !(-1..=2).contains(&level) { return Err("profiling level 必须是 0/1/2".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) { return Err("当前连接为只读模式，已拒绝修改 profiling 配置".to_string()); }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let mut cmd = doc! { "profile": level };
    if let Some(ms) = slow_ms { cmd.insert("slowms", ms); }
    client.database(&db).run_command(cmd).await
        .map_err(|e| format!("设置 profiling 失败: {e}"))?;
    Ok(())
}

/// 查询 system.profile（最近 N 条慢查询）
#[tauri::command]
pub async fn mongo_slow_queries(
    id: String,
    db: String,
    limit: i64,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<String>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let lim = limit.clamp(1, 200);
    use mongodb::options::FindOptions;
    use mongodb::bson::doc as bdoc;
    let coll = client.database(&db).collection::<Document>("system.profile");
    let opts = FindOptions::builder()
        .sort(bdoc! { "ts": -1 })
        .limit(lim)
        .build();
    let mut cursor = coll.find(bdoc! { "op": { "$ne": "getmore" } })
        .with_options(opts)
        .await
        .map_err(|e| format!("查询 system.profile 失败: {e}"))?;
    let mut out = Vec::new();
    while let Some(d) = cursor.try_next().await.map_err(|e| format!("读取慢查询失败: {e}"))? {
        out.push(doc_to_json(&d));
    }
    Ok(out)
}

// ── MO6.5 存储与容量 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollSizeInfo {
    pub ns: String,
    pub doc_count: i64,
    pub avg_obj_size: i64,    // bytes
    pub storage_size: i64,    // bytes
    pub index_sizes: i64,     // bytes
    pub total_size: i64,      // bytes
    pub capped: bool,
}

/// 获取库内各集合容量信息（MO6.5，用 $collStats 聚合）
#[tauri::command]
pub async fn mongo_db_storage(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<CollSizeInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    // 先获取集合名列表
    let db_handle = client.database(&db);
    let names: Vec<String> = db_handle.list_collection_names().await
        .map_err(|e| format!("列出集合失败: {e}"))?;

    let mut result = Vec::new();
    for name in names.iter().take(50) {  // 最多 50 个集合，避免超时
        let coll = db_handle.collection::<Document>(name);
        let pipeline = vec![
            doc! { "$collStats": { "storageStats": { "scale": 1 }, "count": {} } }
        ];
        if let Ok(mut cursor) = coll.aggregate(pipeline).await {
            if let Ok(Some(stats)) = cursor.try_next().await {
                let ss = stats.get_document("storageStats").ok().cloned().unwrap_or_default();
                let count_doc = stats.get_document("count").ok().cloned().unwrap_or_default();
                let get_i64 = |d: &Document, k: &str| -> i64 {
                    d.get_i64(k).ok()
                        .or_else(|| d.get_i32(k).ok().map(|v| v as i64))
                        .or_else(|| d.get_f64(k).ok().map(|v| v as i64))
                        .unwrap_or(0)
                };
                let doc_count   = get_i64(&count_doc, "count");
                let avg_obj     = get_i64(&ss, "avgObjSize");
                let store_size  = get_i64(&ss, "storageSize");
                let index_sizes = get_i64(&ss, "totalIndexSize");
                let total_size  = get_i64(&ss, "totalSize");
                let capped      = ss.get_bool("capped").unwrap_or(false);
                result.push(CollSizeInfo {
                    ns: format!("{}.{}", db, name),
                    doc_count, avg_obj_size: avg_obj,
                    storage_size: store_size, index_sizes,
                    total_size, capped,
                });
            }
        }
    }
    result.sort_by(|a, b| b.total_size.cmp(&a.total_size));
    Ok(result)
}

/// Tauri 命令：副本集状态（MO7.1）
#[tauri::command]
pub async fn mongo_repl_set_status(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let result = client.database("admin")
        .run_command(doc! { "replSetGetStatus": 1 }).await
        .map_err(|e| format!("replSetGetStatus 失败（可能是单节点模式）: {e}"))?;
    Ok(doc_to_json(&result))
}

// ── MO7.2 oplog 监控 ─────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OplogInfo {
    pub configured_size_mb: i64,   // oplog 配置大小（MB）
    pub used_mb: i64,              // 已用大小（MB）
    pub used_pct: f64,             // 使用率（%）
    pub first_ts_sec: i64,         // 最早一条 oplog 的时间戳（Unix 秒）
    pub last_ts_sec: i64,          // 最新一条 oplog 的时间戳（Unix 秒）
    pub window_seconds: i64,       // oplog 窗口（秒）= last - first
    pub window_hours: f64,         // 换算成小时
    pub write_rate_ops: f64,       // 估算写入速率（ops/s，基于窗口总 ops / 窗口秒数）
}

/// Tauri 命令：oplog 统计（MO7.2）
/// 仅副本集有效，单机返回错误。
#[tauri::command]
pub async fn mongo_oplog_info(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<OplogInfo, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    // 获取 oplog 集合 stats（大小信息）
    let local_db = client.database("local");
    let stats = local_db.run_command(doc! { "collStats": "oplog.rs" }).await
        .map_err(|e| format!("collStats oplog.rs 失败（可能不是副本集）: {e}"))?;

    let get_i64 = |d: &Document, k: &str| -> i64 {
        d.get_i64(k).ok()
            .or_else(|| d.get_i32(k).ok().map(|v| v as i64))
            .or_else(|| d.get_f64(k).ok().map(|v| v as i64))
            .unwrap_or(0)
    };

    let max_size = get_i64(&stats, "maxSize");
    let storage_size = get_i64(&stats, "storageSize");
    let configured_mb = max_size / 1024 / 1024;
    let used_mb = storage_size / 1024 / 1024;
    let used_pct = if max_size > 0 { storage_size as f64 / max_size as f64 * 100.0 } else { 0.0 };

    // 获取首尾 oplog 时间戳（估算窗口）
    use mongodb::options::FindOptions;
    use futures::TryStreamExt;
    let coll = local_db.collection::<Document>("oplog.rs");

    let first_opts = FindOptions::builder().sort(doc! { "$natural": 1 }).limit(1).build();
    let last_opts  = FindOptions::builder().sort(doc! { "$natural": -1 }).limit(1).build();

    let ts_from_cursor = |mut cursor: mongodb::Cursor<Document>| async move {
        cursor.try_next().await.ok().flatten()
            .and_then(|doc| doc.get_timestamp("ts").ok())
            .map(|ts| ts.time as i64)
            .unwrap_or(0)
    };

    let first_ts = match coll.find(doc! {}).with_options(first_opts).await {
        Ok(c) => ts_from_cursor(c).await,
        Err(_) => 0,
    };
    let last_ts = match coll.find(doc! {}).with_options(last_opts).await {
        Ok(c) => ts_from_cursor(c).await,
        Err(_) => 0,
    };
    let window   = (last_ts - first_ts).max(0);

    let total_ops = get_i64(&stats, "count");
    let write_rate = if window > 0 { total_ops as f64 / window as f64 } else { 0.0 };

    Ok(OplogInfo {
        configured_size_mb: configured_mb,
        used_mb,
        used_pct,
        first_ts_sec: first_ts,
        last_ts_sec: last_ts,
        window_seconds: window,
        window_hours: window as f64 / 3600.0,
        write_rate_ops: write_rate,
    })
}

// ── MO7.3 分片状态 ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardInfo {
    pub id: String,
    pub host: String,
    pub state: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkDistrib {
    pub shard: String,
    pub chunk_count: i64,
    pub skewed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardStatus {
    pub shards: Vec<ShardInfo>,
    pub balancer_enabled: bool,
    pub balancer_running: bool,
    pub chunk_distrib: Vec<ChunkDistrib>,
    pub jumbo_count: i64,
}

/// Tauri 命令：分片集群状态（MO7.3，仅 mongos 有效）
#[tauri::command]
pub async fn mongo_shard_status(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<ShardStatus, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let cfg_db = client.database("config");

    // 分片列表
    let mut shards: Vec<ShardInfo> = vec![];
    {
        let coll = cfg_db.collection::<Document>("shards");
        let mut cursor = coll.find(doc! {}).await
            .map_err(|e| format!("读取 config.shards 失败: {e}"))?;
        while let Some(d) = cursor.try_next().await.ok().flatten() {
            shards.push(ShardInfo {
                id: d.get_str("_id").unwrap_or("").to_string(),
                host: d.get_str("host").unwrap_or("").to_string(),
                state: d.get_i32("state").unwrap_or(1),
            });
        }
    }
    if shards.is_empty() {
        return Err("非分片集群（config.shards 为空）".to_string());
    }

    // balancer 状态
    let balancer_doc = cfg_db.collection::<Document>("settings")
        .find_one(doc! { "_id": "balancer" }).await
        .map_err(|e| format!("读取 balancer 设置失败: {e}"))?
        .unwrap_or_default();
    let balancer_enabled = !balancer_doc.get_bool("stopped").unwrap_or(false);

    let balancer_state = client.database("admin")
        .run_command(doc! { "balancerStatus": 1 }).await
        .unwrap_or_default();
    let balancer_running = balancer_state.get_bool("inBalancerRound").unwrap_or(false);

    // chunk 分布（按分片聚合）+ jumbo 数量
    let mut chunk_distrib: Vec<ChunkDistrib> = vec![];
    let chunks_coll = cfg_db.collection::<Document>("chunks");
    // 按 shard 聚合 chunk 数量
    let pipeline = vec![
        doc! { "$group": { "_id": "$shard", "count": { "$sum": 1 } } }
    ];
    if let Ok(mut cursor) = chunks_coll.aggregate(pipeline).await {
        while let Some(d) = cursor.try_next().await.ok().flatten() {
            chunk_distrib.push(ChunkDistrib {
                shard: d.get_str("_id").unwrap_or("").to_string(),
                chunk_count: d.get_i64("count").unwrap_or(0),
                skewed: false,
            });
        }
    }
    let jumbo_count = chunks_coll.count_documents(doc! { "jumbo": true }).await
        .unwrap_or(0) as i64;

    // 倾斜检测：最大 chunk 数 > 平均值的 2 倍 = 倾斜
    if chunk_distrib.len() > 1 {
        let total: i64 = chunk_distrib.iter().map(|c| c.chunk_count).sum();
        let avg = total / chunk_distrib.len() as i64;
        let max = chunk_distrib.iter().map(|c| c.chunk_count).max().unwrap_or(0);
        if max > avg * 2 {
            for c in chunk_distrib.iter_mut() {
                if c.chunk_count == max { c.skewed = true; }
            }
        }
    }

    Ok(ShardStatus { shards, balancer_enabled, balancer_running, chunk_distrib, jumbo_count })
}

// ── MO7.4 分片键分析 ──────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShardKeyInfo {
    pub ns: String,
    pub shard_key: String,             // JSON
    pub is_monotonic: bool,            // 单调递增键（热点风险）
    pub chunk_count: i64,
    pub sharded: bool,
    pub unique: bool,
}

/// Tauri 命令：集合分片键查看 + 热点风险分析（MO7.4）
/// 返回指定库内所有分片集合的分片键信息
#[tauri::command]
pub async fn mongo_shard_key_info(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<ShardKeyInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let cfg_db = client.database("config");

    let ns_prefix = format!("{}.", db);
    let mut cursor = cfg_db.collection::<Document>("collections")
        .find(doc! { "_id": { "$regex": format!("^{}", regex_escape(&ns_prefix)), "$options": "i" } }).await
        .map_err(|e| format!("读取 config.collections 失败: {e}"))?;

    let mut results = Vec::new();
    while let Some(d) = cursor.try_next().await.ok().flatten() {
        let ns = d.get_str("_id").unwrap_or("").to_string();
        let shard_key_doc = d.get_document("key").ok().cloned().unwrap_or_default();
        let shard_key = doc_to_json(&shard_key_doc);
        let unique = d.get_bool("unique").unwrap_or(false);

        // 热点键检测：_id / timestamp / date / created_at 等单调递增键
        let mono_keywords = ["_id", "ts", "timestamp", "created", "date", "time", "seq", "id"];
        let is_monotonic = shard_key_doc.keys().any(|k| {
            let kl = k.to_lowercase();
            mono_keywords.iter().any(|m| kl == *m || kl.ends_with(&format!("_{m}")) || kl.starts_with(&format!("{m}_")))
        });

        // chunk 数量
        let chunk_count = cfg_db.collection::<Document>("chunks")
            .count_documents(doc! { "ns": &ns }).await.unwrap_or(0) as i64;

        results.push(ShardKeyInfo {
            ns, shard_key, is_monotonic, chunk_count, sharded: true, unique,
        });
    }
    Ok(results)
}

fn regex_escape(s: &str) -> String {
    s.chars().flat_map(|c| {
        if ".^$*+?()[]{}|\\".contains(c) { vec!['\\', c] } else { vec![c] }
    }).collect()
}

// ── MO11.1 分片 Balancer 活动窗口 ─────────────────────────────────────────────
// 读写 config.settings 中 _id:"balancer" 的 activeWindow（HH:MM 时间窗）。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancerWindow {
    pub enabled: bool,           // balancer 是否启用（!stopped）
    pub has_window: bool,        // 是否配置了活动窗口
    pub start: String,           // "HH:MM"，未配置为空
    pub stop: String,            // "HH:MM"，未配置为空
}

/// MO11.1: 读取 Balancer 活动窗口配置（仅 mongos / 分片集群有效）。
#[tauri::command]
pub async fn mongo_balancer_window_get(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<BalancerWindow, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let settings = client.database("config").collection::<Document>("settings");
    let doc = settings.find_one(doc! { "_id": "balancer" }).await
        .map_err(|e| format!("读取 balancer 设置失败（是否分片集群？）: {e}"))?
        .unwrap_or_default();

    let enabled = !doc.get_bool("stopped").unwrap_or(false);
    let (mut start, mut stop) = (String::new(), String::new());
    if let Ok(win) = doc.get_document("activeWindow") {
        start = win.get_str("start").unwrap_or("").to_string();
        stop = win.get_str("stop").unwrap_or("").to_string();
    }
    let has_window = !start.is_empty() && !stop.is_empty();
    Ok(BalancerWindow { enabled, has_window, start, stop })
}

fn valid_hhmm(s: &str) -> bool {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 { return false; }
    matches!((parts[0].parse::<u32>(), parts[1].parse::<u32>()),
        (Ok(h), Ok(m)) if h < 24 && m < 60)
}

/// MO11.1: 设置或清除 Balancer 活动窗口。
/// start/stop 均为 "HH:MM"；两者皆空表示清除窗口（恢复 7x24 平衡）。
#[tauri::command]
pub async fn mongo_balancer_window_set(
    id: String,
    start: String,
    stop: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<BalancerWindow, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let settings = client.database("config").collection::<Document>("settings");

    let (start, stop) = (start.trim().to_string(), stop.trim().to_string());
    let clear = start.is_empty() && stop.is_empty();
    if !clear {
        if !valid_hhmm(&start) || !valid_hhmm(&stop) {
            return Err("时间格式须为 HH:MM（00:00–23:59）".to_string());
        }
    }

    let update = if clear {
        doc! { "$unset": { "activeWindow": "" } }
    } else {
        doc! { "$set": { "activeWindow": { "start": &start, "stop": &stop } } }
    };
    settings.update_one(doc! { "_id": "balancer" }, update).upsert(true).await
        .map_err(|e| format!("更新 Balancer 窗口失败: {e}"))?;

    let has_window = !clear;
    Ok(BalancerWindow { enabled: true, has_window, start, stop })
}

// ── MO11.3 误删恢复引导（只读诊断，不执行任何恢复）────────────────────────────
// 根据副本集 / oplog 可用性给出恢复路径建议，绝不自动执行恢复动作。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryGuide {
    pub is_replica_set: bool,
    pub set_name: String,
    pub oplog_available: bool,
    pub oplog_first_ts: String,   // oplog 最早时间（秒级 unix，字符串）
    pub oplog_last_ts: String,
    pub oplog_window_hint: String,
    pub steps: Vec<String>,       // 推荐恢复步骤（中文）
    pub warnings: Vec<String>,
}

/// MO11.3: 误删恢复引导。只读检测环境，输出可执行的恢复步骤说明。
#[tauri::command]
pub async fn mongo_recovery_guide(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<RecoveryGuide, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let admin = client.database("admin");

    // hello 判断副本集
    let hello = admin.run_command(doc! { "hello": 1 }).await.unwrap_or_default();
    let set_name = hello.get_str("setName").unwrap_or("").to_string();
    let is_replica_set = !set_name.is_empty();

    // oplog 窗口（local.oplog.rs），复用 MO7.2 已验证的 FindOptions 取首尾 ts
    let mut oplog_available = false;
    let (mut first_ts, mut last_ts) = (String::new(), String::new());
    let mut window_hint = String::new();
    if is_replica_set {
        use mongodb::options::FindOptions;
        let coll = client.database("local").collection::<Document>("oplog.rs");
        let first_opts = FindOptions::builder().sort(doc! { "$natural": 1 }).limit(1).build();
        let last_opts = FindOptions::builder().sort(doc! { "$natural": -1 }).limit(1).build();
        let ts_of = |mut cursor: mongodb::Cursor<Document>| async move {
            cursor.try_next().await.ok().flatten()
                .and_then(|d| d.get_timestamp("ts").ok())
                .map(|t| t.time as i64)
        };
        let f = match coll.find(doc! {}).with_options(first_opts).await {
            Ok(c) => ts_of(c).await, Err(_) => None,
        };
        let l = match coll.find(doc! {}).with_options(last_opts).await {
            Ok(c) => ts_of(c).await, Err(_) => None,
        };
        if let (Some(fts), Some(lts)) = (f, l) {
            oplog_available = true;
            first_ts = fts.to_string();
            last_ts = lts.to_string();
            let span_h = (lts - fts).max(0) as f64 / 3600.0;
            window_hint = format!("oplog 可回溯窗口约 {span_h:.1} 小时");
        }
    }

    let mut steps: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    warnings.push("发现误删后请立即停止对该集合的写入，避免 oplog 被新数据覆盖或备份被破坏。".to_string());

    if oplog_available {
        steps.push("方案一（首选·基于备份+oplog 的时间点恢复 PITR）：定位误删操作发生的时间戳，在该时间点之前。".to_string());
        steps.push("1. 准备一个临时实例，恢复最近一次全量备份（mongorestore）。".to_string());
        steps.push("2. 导出 oplog：mongodump --db local --collection oplog.rs，过滤 ts 小于误删时刻。".to_string());
        steps.push("3. mongorestore --oplogReplay --oplogLimit <误删时刻ts> 重放到误删前。".to_string());
        steps.push("4. 从临时实例导出被删数据，再导入生产库（避免直接覆盖生产）。".to_string());
        steps.push(format!("当前 {window_hint}；若误删时间早于 oplog 最早记录，则无法用 oplog 重放，须依赖全量备份。"));
    } else if is_replica_set {
        warnings.push("未能读取 oplog（可能权限不足或非主节点），PITR 可行性需进一步确认。".to_string());
        steps.push("请确认是否有定期全量备份；优先从最近备份恢复到临时实例后导出数据。".to_string());
    } else {
        warnings.push("当前为单机部署，无 oplog，无法做时间点恢复（PITR）。".to_string());
        steps.push("唯一可靠途径：从最近一次全量备份（mongodump/文件系统快照）恢复到临时实例，导出被删数据后再导入。".to_string());
        steps.push("强烈建议：将单机升级为副本集（至少 1 主），以获得 oplog 与 PITR 能力。".to_string());
    }
    steps.push("恢复完成后务必校验数据条数与关键字段，再切回业务。".to_string());

    Ok(RecoveryGuide {
        is_replica_set, set_name, oplog_available,
        oplog_first_ts: first_ts, oplog_last_ts: last_ts,
        oplog_window_hint: window_hint, steps, warnings,
    })
}
