// MO1 + MO2: 库/集合浏览 + 文档查看
use bson::{doc, Document, Bson};
use mongodb::{options::{FindOptions, ListCollectionsOptions}, results::CollectionType};
use serde::{Deserialize, Serialize};
use tauri::State;
use futures::TryStreamExt;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDbInfo {
    pub name: String,
    pub size_on_disk: u64,
    pub empty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollInfo {
    pub name: String,
    pub coll_type: String,     // "collection" | "view" | "timeseries"
    pub estimated_count: i64,
    pub size_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDocResult {
    pub docs: Vec<String>,       // JSON 字符串列表
    pub total: i64,              // countDocuments（估算）
    pub has_more: bool,
    pub last_id: Option<String>, // 用于游标翻页
}

/// Tauri 命令：列出所有数据库
#[tauri::command]
pub async fn mongo_list_databases(
    id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<MongoDbInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let result = client.list_databases().await
        .map_err(|e| format!("列出数据库失败: {e}"))?;
    Ok(result.into_iter().map(|d| MongoDbInfo {
        name: d.name,
        size_on_disk: d.size_on_disk,
        empty: d.empty,
    }).collect())
}

/// Tauri 命令：列出库中所有集合
#[tauri::command]
pub async fn mongo_list_collections(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<MongoCollInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let database = client.database(&db);

    let opts = ListCollectionsOptions::builder().build();
    let mut cursor = database.list_collections().with_options(opts).await
        .map_err(|e| format!("列出集合失败: {e}"))?;

    let mut colls = Vec::new();
    while let Some(spec) = cursor.try_next().await.map_err(|e| format!("读取集合信息失败: {e}"))? {
        let coll_type = match spec.collection_type {
            CollectionType::Collection => "collection",
            CollectionType::View => "view",
            CollectionType::Timeseries => "timeseries",
            _ => "collection",
        }.to_string();
        let name = spec.name.clone();
        // 获取估算文档数
        let estimated_count = database.collection::<Document>(&name)
            .estimated_document_count().await.unwrap_or(0) as i64;
        // 获取数据大小（通过 collStats）
        let size_bytes = database.run_command(doc! { "collStats": &name }).await
            .ok()
            .and_then(|r| r.get("size").and_then(|v| match v {
                Bson::Int32(n) => Some(*n as i64),
                Bson::Int64(n) => Some(*n),
                Bson::Double(n) => Some(*n as i64),
                _ => None,
            }))
            .unwrap_or(0);
        colls.push(MongoCollInfo { name, coll_type, estimated_count, size_bytes });
    }
    Ok(colls)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindDocsArgs {
    pub filter_json: Option<String>,
    pub projection_json: Option<String>,
    pub sort_json: Option<String>,
    pub limit: Option<i64>,
    pub last_id: Option<String>,  // _id 游标翻页（仅在无自定义排序时有效）
    pub skip: Option<i64>,        // offset 翻页（自定义排序时使用）
}

fn bson_to_json_string(doc: &Document) -> String {
    // 使用 relaxed extended JSON 保真 BSON 类型
    serde_json::to_string(doc).unwrap_or_else(|_| "{}".to_string())
}

/// Tauri 命令：查询文档（游标翻页）
#[tauri::command]
pub async fn mongo_find_docs(
    id: String,
    db: String,
    coll: String,
    args: FindDocsArgs,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<MongoDocResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let limit = args.limit.unwrap_or(50).min(500);

    // 解析过滤器
    let mut filter: Document = if let Some(f) = &args.filter_json {
        if f.trim().is_empty() || f.trim() == "{}" {
            doc! {}
        } else {
            serde_json::from_str::<serde_json::Value>(f)
                .map_err(|e| format!("filter JSON 解析失败: {e}"))?;
            // 转为 bson::Document（简化：使用 serde_json → serde_json::Value → bson::Document）
            bson::to_document(&serde_json::from_str::<serde_json::Value>(f).unwrap())
                .map_err(|e| format!("filter 转换失败: {e}"))?
        }
    } else {
        doc! {}
    };

    // 排序（先解析，决定翻页模式）
    let sort: Option<Document> = if let Some(s) = &args.sort_json {
        if s.trim().is_empty() || s.trim() == "{}" { None }
        else {
            Some(bson::to_document(
                &serde_json::from_str::<serde_json::Value>(s)
                    .map_err(|e| format!("sort JSON 解析失败: {e}"))?)
                .map_err(|e| format!("sort 转换失败: {e}"))?)
        }
    } else {
        None
    };

    let has_custom_sort = sort.is_some();

    // _id 游标翻页：仅在无自定义排序时有效；有自定义排序时 _id 顺序与结果顺序不一致，注入 _id>X 会跳行/重复
    if !has_custom_sort {
        if let Some(last_id_str) = &args.last_id {
            if !last_id_str.is_empty() {
                if let Ok(oid) = bson::oid::ObjectId::parse_str(last_id_str) {
                    filter.insert("_id", doc! { "$gt": oid });
                }
            }
        }
    }

    // 投影
    let projection: Option<Document> = if let Some(p) = &args.projection_json {
        if p.trim().is_empty() || p.trim() == "{}" { None }
        else {
            Some(bson::to_document(
                &serde_json::from_str::<serde_json::Value>(p)
                    .map_err(|e| format!("projection JSON 解析失败: {e}"))?)
                .map_err(|e| format!("projection 转换失败: {e}"))?)
        }
    } else {
        None
    };

    let fetch_limit = limit + 1;  // 多取一个判断 has_more
    let mut opts = FindOptions::builder()
        .limit(fetch_limit)
        .build();
    if let Some(s) = sort { opts.sort = Some(s); }
    if let Some(p) = projection { opts.projection = Some(p); }
    // 自定义排序时用 skip 实现偏移翻页
    if has_custom_sort {
        if let Some(skip) = args.skip {
            opts.skip = Some(skip.max(0) as u64);
        }
    }

    let mut cursor = collection.find(filter).with_options(opts).await
        .map_err(|e| format!("查询文档失败: {e}"))?;

    let mut docs = Vec::new();
    while let Some(doc) = cursor.try_next().await.map_err(|e| format!("读取文档失败: {e}"))? {
        docs.push(bson_to_json_string(&doc));
        if docs.len() >= fetch_limit as usize { break; }
    }

    let has_more = docs.len() > limit as usize;
    if has_more { docs.truncate(limit as usize); }

    // 提取最后一个文档的 _id（ObjectId）用于下一页游标
    let last_id = docs.last()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("_id")
            .and_then(|id| id.get("$oid")
                .and_then(|o| o.as_str())
                .map(String::from)
                .or_else(|| id.as_str().map(String::from))));

    // 快速估算总数（避免 countDocuments 大表全扫描）
    let total = collection.estimated_document_count().await.unwrap_or(0) as i64;

    Ok(MongoDocResult { docs, total, has_more, last_id })
}

/// Tauri 命令：精确计数（用于小集合或带 filter）
#[tauri::command]
pub async fn mongo_count_docs(
    id: String,
    db: String,
    coll: String,
    filter_json: Option<String>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<i64, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter: Document = if let Some(f) = filter_json.as_deref().filter(|s| !s.is_empty() && *s != "{}") {
        bson::to_document(&serde_json::from_str::<serde_json::Value>(f)
            .map_err(|e| format!("filter JSON 解析失败: {e}"))?)
            .map_err(|e| format!("filter 转换失败: {e}"))?
    } else {
        doc! {}
    };

    let count = collection.count_documents(filter).await
        .map_err(|e| format!("计数失败: {e}"))?;
    Ok(count as i64)
}

/// Tauri 命令：集合统计
#[tauri::command]
pub async fn mongo_coll_stats(
    id: String,
    db: String,
    coll: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let database = client.database(&db);
    let result = database.run_command(doc! { "collStats": &coll }).await
        .map_err(|e| format!("collStats 失败: {e}"))?;
    Ok(bson_to_json_string(&result))
}

/// Tauri 命令：获取单个文档（by _id，用于编辑）
#[tauri::command]
pub async fn mongo_get_doc(
    id: String,
    db: String,
    coll: String,
    doc_id: String,  // JSON string of _id value
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Option<String>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    // 尝试解析 _id（先试 ObjectId，否则用字符串）
    let filter = if let Ok(oid) = bson::oid::ObjectId::parse_str(&doc_id) {
        doc! { "_id": oid }
    } else {
        // 尝试解析为任意 BSON
        let id_val: serde_json::Value = serde_json::from_str(&doc_id)
            .unwrap_or(serde_json::Value::String(doc_id.clone()));
        let id_bson = bson::to_bson(&id_val).map_err(|e| format!("_id 解析失败: {e}"))?;
        doc! { "_id": id_bson }
    };

    let result = collection.find_one(filter).await
        .map_err(|e| format!("查找文档失败: {e}"))?;
    Ok(result.map(|d| bson_to_json_string(&d)))
}
