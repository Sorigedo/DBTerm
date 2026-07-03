// MO6/MO11.2: Change Streams 调试器（实时订阅集合变更流）
use std::collections::HashMap;
use std::sync::Arc;
use bson::Document;
use futures::TryStreamExt;
use tauri::{State, Emitter, AppHandle};
use tokio::sync::Mutex;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

/// watch_id → 监听任务句柄（drop/abort 即停止）
pub type MongoWatchMap = Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>;

pub fn init_watch_map() -> MongoWatchMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// MO11.2: 启动集合变更流监听，每个变更通过 `mongo-change-{watch_id}` 事件推送 JSON。
/// 需 MongoDB 副本集环境（单机 mongod 不支持 change stream）。
#[tauri::command]
pub async fn mongo_watch_start(
    id: String,
    db: String,
    coll: String,
    watch_id: String,
    app: AppHandle,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
    watchers: State<'_, MongoWatchMap>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;
    let collection = client.database(&db).collection::<Document>(&coll);

    // 先建立变更流（失败立即返回，便于前端提示"需副本集"）
    let mut stream = collection.watch().await
        .map_err(|e| format!("启动变更流失败（Change Stream 需 MongoDB 副本集）: {e}"))?;

    let event_name = format!("mongo-change-{watch_id}");
    let app2 = app.clone();
    let handle = tokio::spawn(async move {
        loop {
            match stream.try_next().await {
                Ok(Some(ev)) => {
                    let json = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".to_string());
                    let _ = app2.emit(&event_name, json);
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = app2.emit(&format!("{event_name}-error"), e.to_string());
                    break;
                }
            }
        }
    });

    // 替换旧监听（若存在）
    if let Some(old) = watchers.lock().await.insert(watch_id, handle) {
        old.abort();
    }
    Ok(())
}

/// 停止变更流监听
#[tauri::command]
pub async fn mongo_watch_stop(
    watch_id: String,
    watchers: State<'_, MongoWatchMap>,
) -> Result<(), String> {
    if let Some(h) = watchers.lock().await.remove(&watch_id) {
        h.abort();
    }
    Ok(())
}
