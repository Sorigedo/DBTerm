// MO4.2: 创建索引  MO4.4: 索引顾问
use bson::doc;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIndexResult {
    pub name: String,
}

/// Tauri 命令：创建索引（MO4.2）
/// key_json: {"field": 1} 或 {"field": "text"} 等
/// options_json: {"unique":true,"sparse":false,"name":"my_idx","expireAfterSeconds":3600,"partialFilterExpression":{}}
#[tauri::command]
pub async fn mongo_create_index(
    id: String,
    db: String,
    coll: String,
    key_json: String,
    options_json: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<CreateIndexResult, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let key_val: serde_json::Value = serde_json::from_str(&key_json)
        .map_err(|e| format!("key JSON 格式错误: {e}"))?;
    let key_doc = bson::to_document(&key_val)
        .map_err(|e| format!("key 转换失败: {e}"))?;

    let opts_val: serde_json::Value = serde_json::from_str(&options_json)
        .unwrap_or(serde_json::Value::Object(Default::default()));

    // 构建 index spec document
    let mut index_spec = key_doc.clone();

    // 将 options 合并进 spec（createIndexes 命令格式）
    if let Some(name) = opts_val.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        index_spec.insert("name", name);
    }
    if let Some(u) = opts_val.get("unique").and_then(|v| v.as_bool()) {
        index_spec.insert("unique", u);
    }
    if let Some(s) = opts_val.get("sparse").and_then(|v| v.as_bool()) {
        index_spec.insert("sparse", s);
    }
    if let Some(ttl) = opts_val.get("expireAfterSeconds").and_then(|v| v.as_i64()) {
        if ttl >= 0 {
            index_spec.insert("expireAfterSeconds", ttl);
        }
    }
    if let Some(pf) = opts_val.get("partialFilterExpression") {
        if pf.is_object() {
            let pf_doc = bson::to_document(pf)
                .map_err(|e| format!("partialFilterExpression 转换失败: {e}"))?;
            index_spec.insert("partialFilterExpression", pf_doc);
        }
    }

    // 使用 createIndexes runCommand
    let index_key_doc = doc! { "key": key_doc };
    let mut full_index_doc = index_key_doc;
    for (k, v) in index_spec {
        if k != "_id" {
            full_index_doc.insert(k, v);
        }
    }

    let result = client.database(&db).run_command(doc! {
        "createIndexes": coll.as_str(),
        "indexes": [full_index_doc]
    }).await.map_err(|e| format!("创建索引失败: {e}"))?;

    // 从结果提取索引名（若有）
    let name = result.get_str("note")
        .map(|_| "")
        .unwrap_or_default()
        .to_string();

    // 重新查询索引列表获取实际名称
    let created_name = opts_val.get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // 没有指定名称时，MongoDB 自动生成名称（字段1_方向1_...）
            key_val.as_object()
                .map(|m| m.iter().map(|(k, v)| format!("{}_{}", k, v)).collect::<Vec<_>>().join("_"))
                .unwrap_or_else(|| "new_index".to_string())
        });

    drop(name); // 避免未使用警告
    Ok(CreateIndexResult { name: created_name })
}

/// 索引顾问请求
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorRequest {
    pub filter_json: String,
    pub sort_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSuggestion {
    pub key_json: String,
    pub reason: String,
    pub is_collscan: bool,
}

/// Tauri 命令：索引顾问（MO4.4）
/// 对 filter+sort 做 explain，若为 COLLSCAN 则给出建索引建议
#[tauri::command]
pub async fn mongo_index_advisor(
    id: String,
    db: String,
    coll: String,
    req: AdvisorRequest,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<IndexSuggestion>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let filter_val: serde_json::Value = serde_json::from_str(&req.filter_json)
        .unwrap_or(serde_json::json!({}));
    let filter_doc = bson::to_document(&filter_val).unwrap_or_default();

    let mut find_cmd = doc! {
        "find": coll.as_str(),
        "filter": filter_doc.clone(),
        "limit": 1_i32,
    };
    if let Some(sort_str) = &req.sort_json {
        if let Ok(sv) = serde_json::from_str::<serde_json::Value>(sort_str) {
            if let Ok(sd) = bson::to_document(&sv) {
                find_cmd.insert("sort", sd);
            }
        }
    }
    let explain_cmd = doc! {
        "explain": find_cmd,
        "verbosity": "queryPlanner"
    };
    let explain_result = client.database(&db).run_command(explain_cmd).await
        .map_err(|e| format!("explain 失败: {e}"))?;

    let explain_str = serde_json::to_string(&explain_result).unwrap_or_default();
    let is_collscan = explain_str.contains("COLLSCAN");

    let mut suggestions = Vec::new();
    if is_collscan {
        let filter_keys: Vec<String> = filter_doc.keys()
            .filter(|k| !k.starts_with('$'))
            .map(|k| k.to_string())
            .collect();

        let mut key_obj = serde_json::Map::new();
        for k in &filter_keys {
            key_obj.insert(k.clone(), serde_json::json!(1));
        }
        if let Some(sort_str) = &req.sort_json {
            if let Ok(sv) = serde_json::from_str::<serde_json::Value>(sort_str) {
                if let Some(obj) = sv.as_object() {
                    for k in obj.keys() {
                        if !key_obj.contains_key(k) {
                            key_obj.insert(k.clone(), serde_json::json!(1));
                        }
                    }
                }
            }
        }

        if !key_obj.is_empty() {
            suggestions.push(IndexSuggestion {
                key_json: serde_json::to_string(&serde_json::Value::Object(key_obj)).unwrap_or_default(),
                reason: format!(
                    "当前查询为全集合扫描（COLLSCAN），建议为字段 [{}] 建立复合索引",
                    filter_keys.join(", ")
                ),
                is_collscan: true,
            });
        } else {
            suggestions.push(IndexSuggestion {
                key_json: "{}".to_string(),
                reason: "查询为 COLLSCAN，但 filter 为空，无法给出具体字段建议".to_string(),
                is_collscan: true,
            });
        }
    }

    Ok(suggestions)
}
