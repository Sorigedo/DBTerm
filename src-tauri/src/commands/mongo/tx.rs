// MO10.7: MongoDB 多文档事务（4.0+ 副本集）
use std::{collections::HashMap, sync::Arc};
use bson::{doc, Document};
use mongodb::ClientSession;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

// ── 事务状态存储 ──────────────────────────────────────────────────────────────

pub struct MongoTxEntry {
    pub client: mongodb::Client,
    // Option：exec 期间 take() 出去执行 IO，完成后 put() 回来，确保 Mutex 不跨 await
    pub session: Option<ClientSession>,
    pub db: String,
    pub conn_id: String,
    pub cmd_count: usize,
}

pub type MongoTxMap = Arc<Mutex<HashMap<String, MongoTxEntry>>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxStatus {
    pub tx_id: String,
    pub conn_id: String,
    pub db: String,
    pub cmd_count: usize,
    pub active: bool,
}

fn next_tx_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("tx-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

// ── Tauri 命令 ────────────────────────────────────────────────────────────────

/// MO10.7: 开启事务（返回 tx_id）
#[tauri::command]
pub async fn mongo_tx_begin(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
    tx_map: State<'_, MongoTxMap>,
) -> Result<String, String> {
    let (config, password) = load_conn(&id, &storage)?;
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，已拒绝开启事务（事务用于写入）".to_string());
    }
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let mut session = client.start_session().await
        .map_err(|e| format!("创建 session 失败: {e}"))?;
    session.start_transaction().await
        .map_err(|e| format!("开启事务失败（可能不是副本集）: {e}"))?;

    let tx_id = next_tx_id();
    tx_map.lock().await.insert(tx_id.clone(), MongoTxEntry {
        client,
        session: Some(session),
        db,
        conn_id: id,
        cmd_count: 0,
    });
    Ok(tx_id)
}

/// MO10.7: 在事务内执行命令
/// BUG-2 fix: take session out → drop guard → IO outside lock → reacquire → put session back
#[tauri::command]
pub async fn mongo_tx_exec(
    tx_id: String,
    db: Option<String>,
    cmd_json: String,
    tx_map: State<'_, MongoTxMap>,
) -> Result<String, String> {
    let cmd: Document = serde_json::from_str(&cmd_json)
        .map_err(|e| format!("命令 JSON 无效: {e}"))?;

    // 1. 短暂持锁：取出 session、client、db 信息
    let (mut session, client, target_db) = {
        let mut guard = tx_map.lock().await;
        let entry = guard.get_mut(&tx_id)
            .ok_or_else(|| format!("事务 {tx_id} 不存在或已结束"))?;
        let session = entry.session.take()
            .ok_or_else(|| format!("事务 {tx_id} 命令正在执行中，请勿并发调用"))?;
        let client = entry.client.clone();
        let target_db = db.as_deref().unwrap_or(&entry.db).to_string();
        (session, client, target_db)
        // guard 在这里离开作用域，锁被释放
    };

    // 2. 在锁外执行 IO
    let result = client.database(&target_db).run_command(cmd).session(&mut session).await;

    // 3. 重新取锁，归还 session 并更新计数
    let mut guard = tx_map.lock().await;
    match guard.get_mut(&tx_id) {
        Some(entry) => {
            entry.session = Some(session);
            match result {
                Ok(r) => {
                    entry.cmd_count += 1;
                    Ok(serde_json::to_string(&r).unwrap_or_else(|_| "{}".to_string()))
                }
                Err(e) => Err(format!("事务内执行失败: {e}")),
            }
        }
        None => {
            // 执行 IO 期间事务被清理（连接断开等），session 随 entry 一同丢弃
            Err(format!("事务 {tx_id} 在执行期间被中止"))
        }
    }
}

/// MO10.7: 提交事务
/// BUG-1 fix: remove entry (take ownership) → drop guard → commit outside lock
#[tauri::command]
pub async fn mongo_tx_commit(
    tx_id: String,
    tx_map: State<'_, MongoTxMap>,
) -> Result<(), String> {
    // 先取出 entry（所有权转移），释放锁
    let entry = {
        let mut guard = tx_map.lock().await;
        guard.remove(&tx_id)
            .ok_or_else(|| format!("事务 {tx_id} 不存在或已结束"))?
        // guard 在这里释放
    };

    let mut session = entry.session
        .ok_or_else(|| format!("事务 {tx_id} session 正在占用中，无法提交"))?;

    // 在锁外提交：提交失败 session 随之丢弃（MongoDB driver 会 abort），不会卡住其他事务
    session.commit_transaction().await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

/// MO10.7: 回滚事务
/// fix: remove entry → drop guard → abort outside lock
#[tauri::command]
pub async fn mongo_tx_abort(
    tx_id: String,
    tx_map: State<'_, MongoTxMap>,
) -> Result<(), String> {
    let entry = {
        let mut guard = tx_map.lock().await;
        guard.remove(&tx_id)
        // guard released
    };
    if let Some(entry) = entry {
        if let Some(mut session) = entry.session {
            session.abort_transaction().await
                .map_err(|e| format!("回滚事务失败: {e}"))?;
        }
    }
    Ok(())
}

/// MO10.7: 查询当前活跃事务列表
#[tauri::command]
pub async fn mongo_tx_list(
    tx_map: State<'_, MongoTxMap>,
) -> Result<Vec<TxStatus>, String> {
    let guard = tx_map.lock().await;
    Ok(guard.iter().map(|(id, e)| TxStatus {
        tx_id: id.clone(),
        conn_id: e.conn_id.clone(),
        db: e.db.clone(),
        cmd_count: e.cmd_count,
        active: e.session.is_some(),
    }).collect())
}

/// 清理所有已断开连接的事务（连接断开时调用）
#[tauri::command]
pub async fn mongo_tx_cleanup(
    conn_id: String,
    tx_map: State<'_, MongoTxMap>,
) -> Result<usize, String> {
    let mut guard = tx_map.lock().await;
    let before = guard.len();
    guard.retain(|_, e| e.conn_id != conn_id);
    Ok(before - guard.len())
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

pub fn init_tx_map() -> MongoTxMap {
    Arc::new(Mutex::new(HashMap::new()))
}
