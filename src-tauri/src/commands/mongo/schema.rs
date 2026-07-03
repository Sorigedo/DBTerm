// MO10.3: MongoDB schema 分析（文档采样推断字段结构）
use bson::{doc, Bson, Document};
use serde::Serialize;
use tauri::State;
use futures::TryStreamExt;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FieldTypeDistrib {
    pub bson_type: String,   // "string" | "int" | "double" | "bool" | "date" | "objectId" | "null" | "array" | "object" | "other"
    pub count: i64,
    pub pct: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub path: String,              // 字段路径（含嵌套，如 "address.city"）
    pub presence_pct: f64,         // 出现率（0~100）
    pub types: Vec<FieldTypeDistrib>, // 类型分布
    pub has_type_conflict: bool,   // 同字段多类型（应用 bug 信号）
    pub sample_values: Vec<String>, // 最多 3 个示例值
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaReport {
    pub coll: String,
    pub sample_count: i64,
    pub total_count: i64,
    pub fields: Vec<FieldInfo>,
}

fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::String(_)    => "string",
        Bson::Int32(_) | Bson::Int64(_) => "int",
        Bson::Double(_)    => "double",
        Bson::Boolean(_)   => "bool",
        Bson::DateTime(_)  => "date",
        Bson::ObjectId(_)  => "objectId",
        Bson::Null         => "null",
        Bson::Array(_)     => "array",
        Bson::Document(_)  => "object",
        _                  => "other",
    }
}

fn bson_to_sample(b: &Bson) -> String {
    match b {
        Bson::String(s) => if s.chars().count() > 40 {
            format!("\"{}…\"", s.chars().take(40).collect::<String>())
        } else { format!("\"{}\"", s) },
        Bson::Int32(n)  => n.to_string(),
        Bson::Int64(n)  => n.to_string(),
        Bson::Double(f) => format!("{f:.2}"),
        Bson::Boolean(b) => b.to_string(),
        Bson::Null      => "null".to_string(),
        Bson::ObjectId(oid) => oid.to_string(),
        Bson::Array(arr) => format!("[…{}]", arr.len()),
        Bson::Document(_) => "{…}".to_string(),
        Bson::DateTime(dt) => dt.to_string(),
        _ => "(other)".to_string(),
    }
}

// 将文档拍平，提取所有字段路径及其值，最多递归 depth_limit 层
fn flatten_doc(doc: &Document, prefix: &str, depth: u8, out: &mut Vec<(String, Bson)>) {
    for (k, v) in doc.iter() {
        let path = if prefix.is_empty() { k.clone() } else { format!("{}.{}", prefix, k) };
        match v {
            Bson::Document(sub) if depth < 1 && sub.len() <= 10 => {
                out.push((path.clone(), v.clone()));
                flatten_doc(sub, &path, depth + 1, out);
            }
            _ => { out.push((path, v.clone())); }
        }
    }
}

/// MO10.3: 采样集合文档，推断字段结构（字段出现率 / 类型分布 / 类型冲突）
#[tauri::command]
pub async fn mongo_schema_analyze(
    id: String,
    db: String,
    coll: String,
    sample_size: Option<i64>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<SchemaReport, String> {
    let n = sample_size.unwrap_or(200).clamp(10, 1000);
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    // 总文档数（估算）
    let total_count = collection.estimated_document_count().await.unwrap_or(0) as i64;

    // 采样
    let pipeline = vec![doc! { "$sample": { "size": n } }];
    let mut cursor = collection.aggregate(pipeline).await
        .map_err(|e| format!("采样失败: {e}"))?;

    // 字段统计：path → { types: {typeName: count}, samples: Vec<String> }
    use std::collections::HashMap;
    let mut field_types: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut field_samples: HashMap<String, Vec<String>> = HashMap::new();
    let mut sample_count: i64 = 0;

    while let Some(doc) = cursor.try_next().await.map_err(|e| format!("读取采样失败: {e}"))? {
        sample_count += 1;
        let mut pairs: Vec<(String, Bson)> = Vec::new();
        flatten_doc(&doc, "", 0, &mut pairs);
        for (path, val) in pairs {
            let type_name = bson_type_name(&val);
            *field_types.entry(path.clone()).or_default().entry(type_name.to_string()).or_insert(0) += 1;
            let samples = field_samples.entry(path).or_default();
            if samples.len() < 3 && val != Bson::Null {
                let s = bson_to_sample(&val);
                if !samples.contains(&s) { samples.push(s); }
            }
        }
    }

    if sample_count == 0 {
        return Ok(SchemaReport { coll, sample_count: 0, total_count, fields: vec![] });
    }

    let mut fields: Vec<FieldInfo> = field_types.into_iter().map(|(path, type_map)| {
        let total_occurrences: i64 = type_map.values().sum();
        let presence_pct = total_occurrences as f64 / sample_count as f64 * 100.0;
        let types: Vec<FieldTypeDistrib> = {
            let mut v: Vec<FieldTypeDistrib> = type_map.iter().map(|(t, &c)| FieldTypeDistrib {
                bson_type: t.clone(),
                count: c,
                pct: c as f64 / total_occurrences as f64 * 100.0,
            }).collect();
            v.sort_by(|a, b| b.count.cmp(&a.count));
            v
        };
        // 类型冲突：同字段出现 2+ 种非 null 类型
        let non_null_types: Vec<&FieldTypeDistrib> = types.iter().filter(|t| t.bson_type != "null").collect();
        let has_type_conflict = non_null_types.len() > 1;
        let sample_values = field_samples.get(&path).cloned().unwrap_or_default();

        FieldInfo { path, presence_pct, types, has_type_conflict, sample_values }
    }).collect();

    // 排序：先冲突，再按出现率降序
    fields.sort_by(|a, b| {
        b.has_type_conflict.cmp(&a.has_type_conflict)
            .then(b.presence_pct.partial_cmp(&a.presence_pct).unwrap_or(std::cmp::Ordering::Equal))
    });

    Ok(SchemaReport { coll, sample_count, total_count, fields })
}
