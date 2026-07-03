// MO3: 聚合管道 — 安全优先：$out/$merge 写回强确认，allowDiskUse 可控
use bson::{doc, Document};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

fn parse_pipeline(json: &str) -> Result<Vec<Document>, String> {
    let val: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("管道 JSON 解析失败: {e}"))?;
    let arr = val.as_array().ok_or("管道必须是 JSON 数组")?;
    arr.iter().enumerate().map(|(i, stage)| {
        bson::to_document(stage).map_err(|e| format!("第 {i} 阶段转换失败: {e}"))
    }).collect()
}

/// 检查管道是否包含写回阶段（$out/$merge）
fn has_write_stage(pipeline: &[Document]) -> bool {
    pipeline.iter().any(|stage| {
        stage.contains_key("$out") || stage.contains_key("$merge")
    })
}

/// 检查管道是否包含 JavaScript 执行操作符（$where / $function / $accumulator）。
/// 这些操作符允许在服务器端执行任意 JS 代码，存在服务端注入风险。
fn has_js_operator(pipeline: &[Document]) -> bool {
    pipeline.iter().any(|stage| {
        stage.contains_key("$where")
            || stage.contains_key("$function")
            || stage.contains_key("$accumulator")
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggResult {
    pub docs: Vec<String>,
    pub count: usize,
}

/// Tauri 命令：执行聚合管道
/// - pipeline_json: JSON 数组，每个元素是一个阶段文档
/// - allow_disk_use: 是否允许磁盘溢写（大数据集聚合）
/// - confirmed_write: 若管道含 $out/$merge，前端必须设为 true（已展示确认弹窗）
/// - limit: 结果条数限制（避免返回过多，0 = 默认 1000）
#[tauri::command]
pub async fn mongo_aggregate(
    id: String,
    db: String,
    coll: String,
    pipeline_json: String,
    allow_disk_use: bool,
    confirmed_write: bool,
    limit: Option<u32>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<AggResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let mut pipeline = parse_pipeline(&pipeline_json)?;
    if pipeline.is_empty() {
        return Err("聚合管道不能为空".to_string());
    }

    // 拒绝服务端 JS 执行操作符（$where / $function / $accumulator）
    if has_js_operator(&pipeline) {
        return Err("安全拦截：管道包含服务端 JavaScript 执行操作符（$where/$function/$accumulator），已拒绝执行。".to_string());
    }

    // 写回操作安全拦截
    if has_write_stage(&pipeline) {
        // 只读连接：$out/$merge 会写入集合，直接拒绝（前端确认 confirmed_write 不能越过只读）
        if config.read_only == Some(true) {
            return Err("当前连接为只读模式，已拒绝含 $out/$merge 的聚合（会写入集合）".to_string());
        }
        if !confirmed_write {
            return Err(
                "安全拦截：管道包含 $out 或 $merge（写回集合），必须在前端确认后才能执行。".to_string()
            );
        }
    }

    // 非写回管道：自动追加 $limit 防止超大结果
    let result_limit = limit.unwrap_or(1000).max(1) as i64;
    if !has_write_stage(&pipeline) {
        pipeline.push(doc! { "$limit": result_limit });
    }

    let collection = client.database(&db).collection::<Document>(&coll);
    use mongodb::options::AggregateOptions;
    let opts = AggregateOptions::builder()
        .allow_disk_use(Some(allow_disk_use))
        .build();

    use futures::TryStreamExt;
    let cursor = collection.aggregate(pipeline).with_options(opts).await
        .map_err(|e| format!("聚合执行失败: {e}"))?;
    let results: Vec<Document> = cursor.try_collect().await
        .map_err(|e| format!("读取聚合结果失败: {e}"))?;

    let docs: Vec<String> = results.iter()
        .map(|d| serde_json::to_string(d).unwrap_or_else(|_| "{}".to_string()))
        .collect();
    let count = docs.len();
    Ok(AggResult { docs, count })
}

/// Tauri 命令：聚合 explain（分析是否走索引、内存使用等）
#[tauri::command]
pub async fn mongo_aggregate_explain(
    id: String,
    db: String,
    coll: String,
    pipeline_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let pipeline = parse_pipeline(&pipeline_json)?;
    if pipeline.is_empty() {
        return Err("聚合管道不能为空".to_string());
    }

    // 写回阶段不允许 explain
    if has_write_stage(&pipeline) {
        return Err("含 $out/$merge 的管道不支持 explain（会实际写入数据）".to_string());
    }

    let pipeline_bson: Vec<bson::Bson> = pipeline.into_iter().map(bson::Bson::Document).collect();
    let cmd = doc! {
        "explain": {
            "aggregate": coll.as_str(),
            "pipeline": pipeline_bson,
            "cursor": {}
        },
        "verbosity": "executionStats"
    };

    let result = client.database(&db).run_command(cmd).await
        .map_err(|e| format!("explain 失败: {e}"))?;
    serde_json::to_string_pretty(&result).map_err(|e| format!("序列化失败: {e}"))
}

/// Tauri 命令：获取集合中字段采样（用于聚合阶段补全提示）
#[tauri::command]
pub async fn mongo_sample_fields(
    id: String,
    db: String,
    coll: String,
    sample_size: Option<u32>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<String>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let n = sample_size.unwrap_or(20).min(100) as i64;
    let pipeline = vec![
        doc! { "$sample": { "size": n } },
    ];
    use futures::TryStreamExt;
    let cursor = collection.aggregate(pipeline).await
        .map_err(|e| format!("采样失败: {e}"))?;
    let docs: Vec<Document> = cursor.try_collect().await
        .map_err(|e| format!("读取采样失败: {e}"))?;

    let mut fields = std::collections::BTreeSet::new();
    fn collect_keys(doc: &Document, prefix: &str, out: &mut std::collections::BTreeSet<String>, depth: u8) {
        if depth > 3 { return }
        for (k, v) in doc.iter() {
            let full = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
            out.insert(full.clone());
            if let bson::Bson::Document(inner) = v {
                collect_keys(inner, &full, out, depth + 1);
            }
        }
    }
    for doc in &docs { collect_keys(doc, "", &mut fields, 0); }
    Ok(fields.into_iter().collect())
}
