// MO8.1 导出集合（JSON/CSV）
// MO8.2 导入集合（JSON/CSV）
use bson::{doc, Bson, Document};
use futures::TryStreamExt;
use serde::Deserialize;
use std::io::Write;
use tauri::{Emitter, State};

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

fn doc_to_ejson(d: &Document) -> String {
    // Extended JSON: 直接用 serde_json 序列化 bson::Document
    serde_json::to_string(d).unwrap_or_else(|_| "{}".to_string())
}

fn get_doc_str(d: &Document, key: &str) -> String {
    // 覆盖全部 BSON 类型：ObjectId/日期/二进制/Decimal128 等此前会被丢成空串
    match d.get(key) {
        None | Some(Bson::Null) => String::new(),
        Some(Bson::String(s)) => s.clone(),
        Some(Bson::Int32(n)) => n.to_string(),
        Some(Bson::Int64(n)) => n.to_string(),
        Some(Bson::Double(n)) => n.to_string(),
        Some(Bson::Boolean(b)) => b.to_string(),
        Some(Bson::ObjectId(o)) => o.to_hex(),
        Some(Bson::DateTime(dt)) => dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string()),
        Some(Bson::Decimal128(d)) => d.to_string(),
        Some(Bson::Binary(b)) => format!("0x{}", hex::encode(&b.bytes)),
        Some(other) => other.to_string(), // 数组/内嵌文档/时间戳等 → BSON 文本表示
    }
}

/// MO8.1 导出集合为 JSON 或 CSV
/// filter_json: 过滤条件（空=全量）
/// projection_json: 字段投影（空=全字段）
/// format: "json" | "csv"
/// output_path: 目标文件路径
/// 返回导出行数
#[tauri::command]
pub async fn mongo_export_collection(
    id: String,
    db: String,
    coll: String,
    filter_json: String,
    projection_json: String,
    format: String,
    output_path: String,
    task_id: Option<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<i64, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter: Document = if filter_json.trim().is_empty() || filter_json == "{}" {
        doc! {}
    } else {
        let v: serde_json::Value = serde_json::from_str(&filter_json)
            .map_err(|e| format!("filter JSON 格式错误: {e}"))?;
        bson::to_document(&v).map_err(|e| format!("filter 转换失败: {e}"))?
    };

    let projection: Option<Document> = if !projection_json.trim().is_empty() && projection_json != "{}" {
        let v: serde_json::Value = serde_json::from_str(&projection_json)
            .map_err(|e| format!("projection JSON 格式错误: {e}"))?;
        Some(bson::to_document(&v).map_err(|e| format!("projection 转换失败: {e}"))?)
    } else { None };

    let mut find = collection.find(filter);
    if let Some(proj) = projection {
        find = find.projection(proj);
    }

    let mut cursor = find.await.map_err(|e| format!("查询失败: {e}"))?;

    // 先收集前 5000 条（非后台任务版，大集合提示用 other.md 中的后台版）
    const MAX_ROWS: i64 = 50_000;
    let mut rows: Vec<Document> = Vec::new();
    while let Some(doc) = cursor.try_next().await.map_err(|e| format!("读取文档失败: {e}"))? {
        rows.push(doc);
        if rows.len() == 1 || rows.len() % 500 == 0 {
            if let Some(ref task_id) = task_id {
                let event = format!("mongo_export_progress_{task_id}");
                let _ = app.emit(&event, serde_json::json!({
                    "rows": rows.len(), "current": &coll, "done": 0, "total": 1
                }));
            }
        }
        if rows.len() as i64 >= MAX_ROWS { break; }
    }

    let count = rows.len() as i64;

    // 写文件
    let mut file = std::fs::File::create(&output_path)
        .map_err(|e| format!("创建文件失败: {e}"))?;

    let wf = |r: std::io::Result<()>| r.map_err(|e| format!("写文件失败: {e}"));
    // 表格类格式（csv/tsv/excel）列头：按首文档字段顺序，并补充后续文档新增字段，避免丢列
    let tab_headers = |rows: &[Document]| -> Vec<String> {
        let mut hs: Vec<String> = Vec::new();
        for d in rows {
            for k in d.keys() {
                if !hs.iter().any(|h| h == k) { hs.push(k.to_string()); }
            }
        }
        hs
    };

    match format.as_str() {
        "csv" | "tsv" => {
            let tab = format == "tsv";
            let sep = if tab { "\t" } else { "," };
            let esc = |s: &str| if tab { tsv_escape(s) } else { csv_escape(s) };
            let headers = tab_headers(&rows);
            wf(writeln!(file, "{}", headers.iter().map(|h| esc(h)).collect::<Vec<_>>().join(sep)))?;
            for doc in &rows {
                let line = headers.iter().map(|h| esc(&get_doc_str(doc, h))).collect::<Vec<_>>().join(sep);
                wf(writeln!(file, "{}", line))?;
            }
        }
        "jsonl" | "ndjson" => {
            // 每行一条 Extended JSON（mongoexport 默认形态，便于流式再导入）
            for doc in &rows { wf(writeln!(file, "{}", doc_to_ejson(doc)))?; }
        }
        "text" | "txt" => {
            // 人类可读：每条文档缩进 JSON，空行分隔
            for (i, doc) in rows.iter().enumerate() {
                let pretty = serde_json::to_string_pretty(doc).unwrap_or_else(|_| doc_to_ejson(doc));
                wf(write!(file, "// #{}\n{}\n\n", i + 1, pretty))?;
            }
        }
        "excel" | "xlsx" | "xls" => {
            // SpreadsheetML（Excel 可直接打开的 XML，无需二进制 xlsx 库）
            let headers = tab_headers(&rows);
            wf(write!(file, "<?xml version=\"1.0\"?>\n<?mso-application progid=\"Excel.Sheet\"?>\n\
                <Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" \
                xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">\n\
                <Worksheet ss:Name=\"{}\">\n<Table>\n", xml_escape(&coll)))?;
            wf(write!(file, "<Row>"))?;
            for h in &headers { wf(write!(file, "<Cell><Data ss:Type=\"String\">{}</Data></Cell>", xml_escape(h)))?; }
            wf(write!(file, "</Row>\n"))?;
            for doc in &rows {
                wf(write!(file, "<Row>"))?;
                for h in &headers {
                    wf(write!(file, "<Cell><Data ss:Type=\"String\">{}</Data></Cell>", xml_escape(&get_doc_str(doc, h))))?;
                }
                wf(write!(file, "</Row>\n"))?;
            }
            wf(write!(file, "</Table>\n</Worksheet>\n</Workbook>\n"))?;
        }
        _ => {
            // JSON 数组（默认，保留 Extended JSON 类型信息）
            wf(write!(file, "["))?;
            for (i, doc) in rows.iter().enumerate() {
                if i > 0 { wf(write!(file, ","))?; }
                wf(write!(file, "\n  {}", doc_to_ejson(doc)))?;
            }
            wf(write!(file, "\n]\n"))?;
        }
    }

    if let Some(ref task_id) = task_id {
        let event = format!("mongo_export_progress_{task_id}");
        let _ = app.emit(&event, serde_json::json!({
            "rows": count, "current": &coll, "done": 1, "total": 1
        }));
    }
    Ok(count)
}

fn tsv_escape(s: &str) -> String {
    s.replace('\t', " ").replace('\n', " ").replace('\r', " ")
}
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ImportOptions {
    /// "skip" | "overwrite"（按 _id 覆盖）
    pub on_conflict: String,
    /// 跳过错误继续
    pub skip_errors: bool,
}

/// MO8.2 导入 JSON/CSV 到集合
/// input_path: 源文件路径
/// format: "json" | "csv"
/// 返回 (inserted, skipped, errors)
#[tauri::command]
pub async fn mongo_import_collection(
    id: String,
    db: String,
    coll: String,
    input_path: String,
    format: String,
    on_conflict: String,
    skip_errors: bool,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<serde_json::Value, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let docs: Vec<Document> = match format.as_str() {
        // Excel 为二进制，单独按路径读取
        "excel" | "xlsx" | "xls" => parse_xlsx_to_docs(&input_path)?,
        other => {
            let content = std::fs::read_to_string(&input_path)
                .map_err(|e| format!("读取文件失败: {e}"))?;
            match other {
                "csv" => parse_csv_to_docs(&content)?,
                "tsv" => parse_tsv_to_docs(&content)?,
                // json / jsonl / ndjson / text 统一走 JSON 解析（兼容数组与 NDJSON）
                _ => parse_json_to_docs(&content)?,
            }
        }
    };

    let mut inserted = 0i64;
    let mut skipped = 0i64;
    let mut errors = 0i64;

    for doc in docs {
        let has_id = doc.contains_key("_id");
        let result = if has_id && on_conflict == "overwrite" {
            let id_val = doc.get("_id").unwrap().clone();
            let filter = doc! { "_id": id_val };
            collection.replace_one(filter, doc.clone()).upsert(true).await
                .map(|_| ()).map_err(|e| e.to_string())
        } else if has_id && on_conflict == "skip" {
            match collection.insert_one(doc.clone()).await {
                Ok(_) => { inserted += 1; continue; }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate") || msg.contains("E11000") {
                        skipped += 1; continue;
                    }
                    Err(msg)
                }
            }
        } else {
            collection.insert_one(doc.clone()).await.map(|_| ()).map_err(|e| e.to_string())
        };

        match result {
            Ok(_) => inserted += 1,
            Err(e) => {
                errors += 1;
                if !skip_errors {
                    return Err(format!("导入失败（已导入 {} 行）: {}", inserted, e));
                }
            }
        }
    }

    Ok(serde_json::json!({ "inserted": inserted, "skipped": skipped, "errors": errors }))
}

fn parse_json_to_docs(content: &str) -> Result<Vec<Document>, String> {
    let trimmed = content.trim();
    // 支持 JSON 数组 或 NDJSON（每行一个对象）
    if trimmed.starts_with('[') {
        let arr: Vec<serde_json::Value> = serde_json::from_str(trimmed)
            .map_err(|e| format!("JSON 格式错误: {e}"))?;
        arr.into_iter().map(|v| bson::to_document(&v).map_err(|e| e.to_string())).collect()
    } else {
        trimmed.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                let v: serde_json::Value = serde_json::from_str(line)
                    .map_err(|e| format!("NDJSON 行格式错误: {e}"))?;
                bson::to_document(&v).map_err(|e| e.to_string())
            })
            .collect()
    }
}

fn parse_csv_to_docs(content: &str) -> Result<Vec<Document>, String> {
    let mut lines = content.lines();
    let header_line = lines.next().ok_or("CSV 文件为空")?;
    let headers: Vec<&str> = header_line.split(',').map(|h| h.trim_matches('"')).collect();

    let mut docs = Vec::new();
    for line in lines {
        if line.trim().is_empty() { continue; }
        let values = split_csv_line(line);
        let mut doc = Document::new();
        for (i, h) in headers.iter().enumerate() {
            if let Some(v) = values.get(i) {
                doc.insert(*h, v.as_str());
            }
        }
        docs.push(doc);
    }
    Ok(docs)
}

fn split_csv_line(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                result.push(current.trim().to_string());
                current = String::new();
            }
            _ => current.push(c),
        }
    }
    result.push(current.trim().to_string());
    result
}

fn parse_tsv_to_docs(content: &str) -> Result<Vec<Document>, String> {
    let mut lines = content.lines();
    let header_line = lines.next().ok_or("TSV 文件为空")?;
    let headers: Vec<&str> = header_line.split('\t').map(|h| h.trim()).collect();
    let mut docs = Vec::new();
    for line in lines {
        if line.trim().is_empty() { continue; }
        let values: Vec<&str> = line.split('\t').collect();
        let mut doc = Document::new();
        for (i, h) in headers.iter().enumerate() {
            if h.is_empty() { continue; }
            if let Some(v) = values.get(i) { doc.insert(*h, *v); }
        }
        docs.push(doc);
    }
    Ok(docs)
}

fn parse_xlsx_to_docs(path: &str) -> Result<Vec<Document>, String> {
    use calamine::{Reader, open_workbook_auto, Data};
    let mut wb = open_workbook_auto(path).map_err(|e| format!("打开 Excel 失败: {e}"))?;
    let range = wb.worksheet_range_at(0)
        .ok_or("Excel 无工作表")?
        .map_err(|e| format!("读取工作表失败: {e}"))?;
    let all: Vec<&[Data]> = range.rows().collect();
    if all.is_empty() { return Ok(vec![]); }
    // 首行为表头
    let headers: Vec<String> = all[0].iter().map(|c| c.to_string()).collect();
    let mut docs = Vec::new();
    for r in &all[1..] {
        let mut doc = Document::new();
        for (i, h) in headers.iter().enumerate() {
            if h.is_empty() { continue; }
            if let Some(c) = r.get(i) {
                let s = match c { Data::Empty => String::new(), other => other.to_string() };
                doc.insert(h.clone(), s);
            }
        }
        if !doc.is_empty() { docs.push(doc); }
    }
    Ok(docs)
}

// ── MO8.4 逻辑备份（BSON，类 mongodump）────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoBackupResult {
    pub collections: usize,
    pub total_docs: i64,
    pub output_dir: String,
    pub files: Vec<String>,
}

/// MO8.4: 将库内集合导出为 BSON 文件（每集合一个 .bson，拼接 BSON 文档，类 mongodump）。
/// colls 为空则备份全部集合。
#[tauri::command]
pub async fn mongo_logical_backup(
    id: String,
    db: String,
    colls: Vec<String>,
    output_dir: String,
    task_id: Option<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<MongoBackupResult, String> {
    if output_dir.trim().is_empty() { return Err("输出目录不能为空".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let database = client.database(&db);

    let coll_names: Vec<String> = if colls.is_empty() {
        database.list_collection_names().await.map_err(|e| format!("列出集合失败: {e}"))?
    } else { colls };

    std::fs::create_dir_all(&output_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let dir = output_dir.trim_end_matches(['/', '\\']);
    let mut total = 0i64;
    let mut files = Vec::new();
    for (index, cn) in coll_names.iter().enumerate() {
        let collection = database.collection::<Document>(cn);
        let mut cursor = collection.find(doc! {}).await.map_err(|e| format!("查询 {cn} 失败: {e}"))?;
        // 集合名可含 / 或 \（MongoDB 允许），直接拼路径会穿越目录；替换分隔符生成安全文件名
        let safe = cn.replace(['/', '\\'], "_");
        if safe.trim().is_empty() { return Err(format!("集合名 {cn} 无法安全导出为文件")); }
        let path = format!("{dir}/{safe}.bson");
        let mut file = std::fs::File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
        let mut n = 0i64;
        while let Some(d) = cursor.try_next().await.map_err(|e| format!("读取 {cn} 失败: {e}"))? {
            d.to_writer(&mut file).map_err(|e| format!("写入 BSON 失败: {e}"))?;
            n += 1;
            if n == 1 || n % 500 == 0 {
                if let Some(ref task_id) = task_id {
                    let event = format!("mongo_export_progress_{task_id}");
                    let _ = app.emit(&event, serde_json::json!({
                        "rows": total + n, "current": cn, "done": index, "total": coll_names.len()
                    }));
                }
            }
        }
        total += n;
        files.push(format!("{cn}.bson（{n} 文档）"));
        if let Some(ref task_id) = task_id {
            let event = format!("mongo_export_progress_{task_id}");
            let _ = app.emit(&event, serde_json::json!({
                "rows": total, "current": cn, "done": index + 1, "total": coll_names.len()
            }));
        }
    }

    Ok(MongoBackupResult { collections: coll_names.len(), total_docs: total, output_dir: dir.to_string(), files })
}

// ── MO9.5 字段脱敏导出 ────────────────────────────────────────────────────────
// 全新增逻辑，不复用/不改动 MO8.1 mongo_export_collection。
// 规则对齐 SQLite/DuckDB 脱敏方案：phone/email/mask/hash/null。

#[derive(Deserialize)]
pub struct MongoMaskRule {
    /// 顶层字段名（点号嵌套暂不支持，仅匹配顶层 key）
    pub field: String,
    /// "phone" | "email" | "mask" | "hash" | "null"
    pub rule: String,
}

/// 将 BSON 值转为可脱敏的字符串表示（与导出取值口径一致）。
fn bson_to_plain(v: &bson::Bson) -> String {
    match v {
        bson::Bson::Null => String::new(),
        bson::Bson::String(s) => s.clone(),
        bson::Bson::Int32(n) => n.to_string(),
        bson::Bson::Int64(n) => n.to_string(),
        bson::Bson::Double(n) => n.to_string(),
        bson::Bson::Boolean(b) => b.to_string(),
        bson::Bson::ObjectId(o) => o.to_hex(),
        bson::Bson::DateTime(dt) => dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string()),
        bson::Bson::Decimal128(d) => d.to_string(),
        bson::Bson::Binary(b) => format!("0x{}", hex::encode(&b.bytes)),
        other => other.to_string(),
    }
}

/// 纯文本脱敏（返回明文，不加 SQL 引号；与 sqlite_admin::apply_mask 规则一致）。
fn mask_plain(val: &str, rule: &str) -> String {
    match rule {
        "mask" => "***".to_string(),
        "hash" => {
            // FNV-1a，无加密依赖，与 SQLite 侧口径一致
            let mut h: u64 = 14695981039346656037;
            for b in val.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(1099511628211);
            }
            format!("{h:016x}")
        }
        "phone" => {
            if val.chars().count() >= 7 {
                let chars: Vec<char> = val.chars().collect();
                let prefix: String = chars[..3].iter().collect();
                let suffix: String = chars[chars.len() - 4..].iter().collect();
                format!("{prefix}****{suffix}")
            } else {
                "***".to_string()
            }
        }
        "email" => {
            if let Some(at) = val.find('@') {
                let user = &val[..at];
                let domain = &val[at..];
                let masked_user = if user.chars().count() <= 2 {
                    "*".repeat(user.chars().count())
                } else {
                    let head: String = user.chars().take(2).collect();
                    format!("{head}***")
                };
                format!("{masked_user}{domain}")
            } else {
                "***".to_string()
            }
        }
        _ => val.to_string(),
    }
}

/// 对单个文档按规则脱敏（就地修改）。"null" 规则置为 Bson::Null，其余转为脱敏字符串。
fn apply_mask_doc(doc: &mut Document, rules: &[MongoMaskRule]) {
    for r in rules {
        if !doc.contains_key(&r.field) {
            continue;
        }
        if r.rule == "null" {
            doc.insert(r.field.clone(), bson::Bson::Null);
            continue;
        }
        let plain = doc.get(&r.field).map(bson_to_plain).unwrap_or_default();
        doc.insert(r.field.clone(), bson::Bson::String(mask_plain(&plain, &r.rule)));
    }
}

/// MO9.5: 字段脱敏导出（JSON/CSV）。在写出前对指定字段套用脱敏规则。
/// 与 mongo_export_collection 行为一致（同样的 filter/projection/行上限），仅多一步脱敏。
#[tauri::command]
pub async fn mongo_export_collection_masked(
    id: String,
    db: String,
    coll: String,
    filter_json: String,
    projection_json: String,
    format: String,
    output_path: String,
    masking_rules: Vec<MongoMaskRule>,
    task_id: Option<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<i64, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    let filter: Document = if filter_json.trim().is_empty() || filter_json == "{}" {
        doc! {}
    } else {
        let v: serde_json::Value = serde_json::from_str(&filter_json)
            .map_err(|e| format!("filter JSON 格式错误: {e}"))?;
        bson::to_document(&v).map_err(|e| format!("filter 转换失败: {e}"))?
    };

    let projection: Option<Document> = if !projection_json.trim().is_empty() && projection_json != "{}" {
        let v: serde_json::Value = serde_json::from_str(&projection_json)
            .map_err(|e| format!("projection JSON 格式错误: {e}"))?;
        Some(bson::to_document(&v).map_err(|e| format!("projection 转换失败: {e}"))?)
    } else { None };

    let mut find = collection.find(filter);
    if let Some(proj) = projection {
        find = find.projection(proj);
    }
    let mut cursor = find.await.map_err(|e| format!("查询失败: {e}"))?;

    const MAX_ROWS: i64 = 50_000;
    let mut rows: Vec<Document> = Vec::new();
    while let Some(mut doc) = cursor.try_next().await.map_err(|e| format!("读取文档失败: {e}"))? {
        apply_mask_doc(&mut doc, &masking_rules);
        rows.push(doc);
        if rows.len() == 1 || rows.len() % 500 == 0 {
            if let Some(ref task_id) = task_id {
                let event = format!("mongo_export_progress_{task_id}");
                let _ = app.emit(&event, serde_json::json!({
                    "rows": rows.len(), "current": &coll, "done": 0, "total": 1
                }));
            }
        }
        if rows.len() as i64 >= MAX_ROWS { break; }
    }
    let count = rows.len() as i64;

    let mut file = std::fs::File::create(&output_path)
        .map_err(|e| format!("创建文件失败: {e}"))?;
    if format == "csv" {
        if let Some(first) = rows.first() {
            let headers: Vec<String> = first.keys().map(|k| k.to_string()).collect();
            let header_line = headers.iter().map(|h| csv_escape(h)).collect::<Vec<_>>().join(",");
            writeln!(file, "{}", header_line).map_err(|e| format!("写文件失败: {e}"))?;
            for doc in &rows {
                let line = headers.iter()
                    .map(|h| csv_escape(&get_doc_str(doc, h)))
                    .collect::<Vec<_>>().join(",");
                writeln!(file, "{}", line).map_err(|e| format!("写文件失败: {e}"))?;
            }
        }
    } else {
        write!(file, "[").map_err(|e| format!("写文件失败: {e}"))?;
        for (i, doc) in rows.iter().enumerate() {
            if i > 0 { write!(file, ",").map_err(|e| format!("写文件失败: {e}"))?; }
            write!(file, "\n  {}", doc_to_ejson(doc)).map_err(|e| format!("写文件失败: {e}"))?;
        }
        write!(file, "\n]\n").map_err(|e| format!("写文件失败: {e}"))?;
    }

    if let Some(ref task_id) = task_id {
        let event = format!("mongo_export_progress_{task_id}");
        let _ = app.emit(&event, serde_json::json!({
            "rows": count, "current": &coll, "done": 1, "total": 1
        }));
    }
    Ok(count)
}

// ── MO8.3 跨实例集合复制 ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCopyResult {
    pub copied: i64,
    pub dropped_target: bool,
}

/// MO8.3: 从源实例集合复制文档到目标实例集合（分批 insert_many）。
/// drop_target=true 先清空目标集合（强确认由前端保证）。
#[tauri::command]
pub async fn mongo_copy_collection(
    src_id: String,
    src_db: String,
    src_coll: String,
    dst_id: String,
    dst_db: String,
    dst_coll: String,
    drop_target: bool,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<MongoCopyResult, String> {
    let (src_cfg, src_pwd) = load_conn(&src_id, &storage)?;
    let src_client = get_client(&src_id, &pool, &src_cfg, src_pwd.as_deref()).await?;
    let (dst_cfg, dst_pwd) = load_conn(&dst_id, &storage)?;
    // 复制写入目标连接：目标只读则拒绝（含 drop_target 清空）
    if dst_cfg.read_only == Some(true) {
        return Err("目标连接为只读模式，已拒绝写入/清空操作".to_string());
    }
    let dst_client = get_client(&dst_id, &pool, &dst_cfg, dst_pwd.as_deref()).await?;

    let src = src_client.database(&src_db).collection::<Document>(&src_coll);
    let dst = dst_client.database(&dst_db).collection::<Document>(&dst_coll);

    if drop_target {
        dst.drop().await.map_err(|e| format!("清空目标集合失败: {e}"))?;
    }

    let mut cursor = src.find(doc! {}).await.map_err(|e| format!("读取源集合失败: {e}"))?;
    let mut batch: Vec<Document> = Vec::with_capacity(1000);
    let mut copied = 0i64;
    while let Some(d) = cursor.try_next().await.map_err(|e| format!("读取失败: {e}"))? {
        batch.push(d);
        if batch.len() >= 1000 {
            dst.insert_many(&batch).await.map_err(|e| format!("写入目标失败: {e}"))?;
            copied += batch.len() as i64;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        dst.insert_many(&batch).await.map_err(|e| format!("写入目标失败: {e}"))?;
        copied += batch.len() as i64;
    }

    Ok(MongoCopyResult { copied, dropped_target: drop_target })
}
