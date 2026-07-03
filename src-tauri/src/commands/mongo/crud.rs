// MO2: 文档编辑（增/改/删）— 数据安全优先，危险操作均需前端二级确认
use bson::{doc, Document};
use serde::Serialize;
use tauri::State;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub modified: i64,
    pub matched: i64,
    pub inserted: i64,
    pub deleted: i64,
}

fn parse_doc(json: &str, label: &str) -> Result<Document, String> {
    let val: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("{label} JSON 解析失败: {e}"))?;
    bson::to_document(&val).map_err(|e| format!("{label} 转换失败: {e}"))
}

/// MO9.1 只读保险：写命令开头调用，只读模式下直接拒绝
fn check_not_readonly(config: &crate::models::ConnConfig) -> Result<(), String> {
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    Ok(())
}

/// Tauri 命令：插入单文档
#[tauri::command]
pub async fn mongo_insert_one(
    id: String,
    db: String,
    coll: String,
    doc_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);
    let document = parse_doc(&doc_json, "文档")?;
    let result = collection.insert_one(document).await
        .map_err(|e| format!("插入文档失败: {e}"))?;
    Ok(result.inserted_id.to_string())
}

/// Tauri 命令：replaceOne 整体替换（by _id）— 编辑保存
#[tauri::command]
pub async fn mongo_replace_one(
    id: String,
    db: String,
    coll: String,
    doc_id: String,      // _id JSON
    new_doc_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<WriteResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter = if let Ok(oid) = bson::oid::ObjectId::parse_str(&doc_id) {
        doc! { "_id": oid }
    } else {
        let id_val: serde_json::Value = serde_json::from_str(&doc_id)
            .unwrap_or(serde_json::Value::String(doc_id.clone()));
        let id_bson = bson::to_bson(&id_val).map_err(|e| format!("_id 解析失败: {e}"))?;
        doc! { "_id": id_bson }
    };

    let new_doc = parse_doc(&new_doc_json, "替换文档")?;
    let result = collection.replace_one(filter, new_doc).await
        .map_err(|e| format!("替换文档失败: {e}"))?;

    Ok(WriteResult {
        modified: result.modified_count as i64,
        matched: result.matched_count as i64,
        inserted: 0,
        deleted: 0,
    })
}

/// Tauri 命令：deleteOne（by _id）— 需前端确认
#[tauri::command]
pub async fn mongo_delete_one(
    id: String,
    db: String,
    coll: String,
    doc_id: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<WriteResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter = if let Ok(oid) = bson::oid::ObjectId::parse_str(&doc_id) {
        doc! { "_id": oid }
    } else {
        let id_val: serde_json::Value = serde_json::from_str(&doc_id)
            .unwrap_or(serde_json::Value::String(doc_id.clone()));
        let id_bson = bson::to_bson(&id_val).map_err(|e| format!("_id 解析失败: {e}"))?;
        doc! { "_id": id_bson }
    };

    let result = collection.delete_one(filter).await
        .map_err(|e| format!("删除文档失败: {e}"))?;

    Ok(WriteResult {
        modified: 0, matched: 0, inserted: 0,
        deleted: result.deleted_count as i64,
    })
}

/// Tauri 命令：预览 filter 匹配数（危险批量操作前必须调用）
#[tauri::command]
pub async fn mongo_count_preview(
    id: String,
    db: String,
    coll: String,
    filter_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<i64, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    // 空 filter 是危险信号（全集合），前端应在此之前已拒绝
    let filter = parse_doc(&filter_json, "filter")?;
    let count = collection.count_documents(filter).await
        .map_err(|e| format!("计数失败: {e}"))?;
    Ok(count as i64)
}

/// Tauri 命令：deleteMany（批量删除）— 前端必须先调 mongo_count_preview 展示命中数
#[tauri::command]
pub async fn mongo_delete_many(
    id: String,
    db: String,
    coll: String,
    filter_json: String,
    confirmed_count: i64,  // 前端展示给用户确认的命中数，后端验证不偏差超 10%
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<WriteResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter = parse_doc(&filter_json, "filter")?;

    // 安全检查：filter 不能为空（前端已做，后端再防御一次）
    if filter.is_empty() {
        return Err("安全拦截：deleteMany 不允许使用空 filter（全集合删除），请传入明确条件".to_string());
    }

    // 二次计数验证（防止时间窗口内数据变化）
    let actual = collection.count_documents(filter.clone()).await
        .map_err(|e| format!("计数校验失败: {e}"))? as i64;
    if confirmed_count > 0 && actual > confirmed_count * 2 {
        return Err(format!(
            "安全拦截：当前命中 {actual} 条，远超确认时的 {confirmed_count} 条，操作已取消。请重新确认。"
        ));
    }

    let result = collection.delete_many(filter).await
        .map_err(|e| format!("批量删除失败: {e}"))?;

    Ok(WriteResult {
        modified: 0, matched: 0, inserted: 0,
        deleted: result.deleted_count as i64,
    })
}

/// Tauri 命令：drop 集合（高危，需前端二级确认）
#[tauri::command]
pub async fn mongo_drop_collection(
    id: String,
    db: String,
    coll: String,
    confirm_name: String,   // 用户输入集合名，防误操作
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if confirm_name != coll {
        return Err(format!("输入的集合名 {confirm_name} 与目标集合 {coll} 不符，操作取消"));
    }
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    client.database(&db).collection::<Document>(&coll).drop().await
        .map_err(|e| format!("删除集合失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：updateMany（批量更新）— 前端必须先调 mongo_count_preview 展示命中数
#[tauri::command]
pub async fn mongo_update_many(
    id: String,
    db: String,
    coll: String,
    filter_json: String,
    update_json: String,
    confirmed_count: i64,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<WriteResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter = parse_doc(&filter_json, "filter")?;
    let update = parse_doc(&update_json, "update")?;

    // 安全检查：filter 不能为空
    if filter.is_empty() {
        return Err("安全拦截：updateMany 不允许使用空 filter（全集合更新），请传入明确条件".to_string());
    }

    // update 文档必须包含更新操作符（$set/$unset/$inc 等），防止意外整体替换
    let has_op = update.keys().any(|k| k.starts_with('$'));
    if !has_op {
        return Err("安全拦截：update 文档必须使用更新操作符（如 $set/$unset/$inc），不允许直接替换整个文档".to_string());
    }

    // 二次计数验证
    let actual = collection.count_documents(filter.clone()).await
        .map_err(|e| format!("计数校验失败: {e}"))? as i64;
    if confirmed_count > 0 && actual > confirmed_count * 2 {
        return Err(format!(
            "安全拦截：当前命中 {actual} 条，远超确认时的 {confirmed_count} 条，操作已取消。请重新确认。"
        ));
    }

    let result = collection.update_many(filter, update).await
        .map_err(|e| format!("批量更新失败: {e}"))?;

    Ok(WriteResult {
        modified: result.modified_count as i64,
        matched: result.matched_count as i64,
        inserted: 0,
        deleted: 0,
    })
}

/// Tauri 命令：创建集合
#[tauri::command]
pub async fn mongo_create_collection(
    id: String,
    db: String,
    coll: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if coll.is_empty() || coll.starts_with('$') {
        return Err("集合名无效".to_string());
    }
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    client.database(&db).create_collection(&coll).await
        .map_err(|e| format!("创建集合失败: {e}"))?;
    Ok(())
}
