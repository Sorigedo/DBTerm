// R5 Pub/Sub 面板 + R5.2 PUBSUB CHANNELS
// 隔离规则：独立文件，不引用 SQL 侧代码

use serde::Serialize;
use tauri::State;

use crate::storage::StorageState;
use super::{RedisPool, get_conn, load_config_password, default_db};

// ── R5.2 PUBSUB CHANNELS ──────────────────────────────────────────────────────

/// R5.2: 列出活跃频道（有订阅者的频道）
#[tauri::command]
pub async fn redis_pubsub_channels(
    id: String,
    pattern: Option<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<String>, String> {
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let pat = pattern.as_deref().unwrap_or("*");
    let channels: Vec<String> = redis::cmd("PUBSUB").arg("CHANNELS").arg(pat)
        .query_async(&mut conn).await
        .map_err(|e| format!("PUBSUB CHANNELS 失败: {e}"))?;
    Ok(channels)
}

/// R5.2: 频道订阅者数量统计
#[tauri::command]
pub async fn redis_pubsub_numsub(
    id: String,
    channels: Vec<String>,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
) -> Result<Vec<(String, u64)>, String> {
    if channels.is_empty() { return Ok(vec![]); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let mut cmd = redis::cmd("PUBSUB");
    cmd.arg("NUMSUB");
    for ch in &channels { cmd.arg(ch); }
    let flat: Vec<String> = cmd.query_async(&mut conn).await
        .map_err(|e| format!("PUBSUB NUMSUB 失败: {e}"))?;
    let result = flat.chunks(2).filter_map(|c| {
        if let [ch, n] = c { Some((ch.clone(), n.parse::<u64>().unwrap_or(0))) } else { None }
    }).collect();
    Ok(result)
}

// ── R5.1 PUBLISH ──────────────────────────────────────────────────────────────

/// R5.1: 向频道发布消息
#[tauri::command]
pub async fn redis_publish(
    id: String,
    channel: String,
    message: String,
    db: Option<u8>,
    pool: State<'_, RedisPool>,
    storage: State<'_, StorageState>,
    readonly_state: State<'_, super::server::RedisReadonly>,
) -> Result<i64, String> {
    super::server::require_writable(&id, &readonly_state).await?;
    if channel.is_empty() { return Err("频道名称不能为空".to_string()); }
    if channel.len() > 512 { return Err(format!("频道名称过长（最多 512 字节，当前 {} 字节）", channel.len())); }
    let mut conn = get_conn(&id, db, &pool, &storage).await?;
    let n: i64 = redis::cmd("PUBLISH").arg(&channel).arg(&message)
        .query_async(&mut conn).await
        .map_err(|e| format!("PUBLISH 失败: {e}"))?;
    Ok(n)
}

// ── R5.1 SUBSCRIBE（独立连接 + tauri event 推送）─────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PubSubMessage {
    pub kind: String,    // "message" | "pmessage" | "subscribe" | "psubscribe"
    pub channel: String,
    pub pattern: Option<String>,
    pub data: String,
    pub ts: u64,
}

/// R5.1: 启动订阅（专用连接，通过 tauri 事件推送消息）
/// 前端通过 listen(`redis_pubsub_msg_{sessionId}`) 接收消息
/// 返回 sessionId，前端用于标识此订阅会话
#[tauri::command]
pub async fn redis_subscribe(
    id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
    app: tauri::AppHandle,
    storage: State<'_, StorageState>,
) -> Result<String, String> {
    use tauri::Emitter;
    use futures::StreamExt;

    if channels.is_empty() && patterns.is_empty() {
        return Err("至少需要订阅一个频道或模式".to_string());
    }

    let (config, password) = load_config_password(&id, &storage)?;
    let db = default_db(&config);

    // 构建专用连接（不走连接池，pub/sub 需要独占连接）
    use crate::db_tunnel::{DbTunnel, DbTunnelCfg};
    use super::RedisConnCfg;
    let extra = RedisConnCfg::from_config(&config);
    let (host, port, _tunnel) = if extra.ssh_tunnel {
        let tcfg = DbTunnelCfg {
            host:      extra.ssh_host.clone(),
            port:      extra.ssh_port,
            user:      extra.ssh_user.clone(),
            auth_type: if extra.ssh_auth_type.is_empty() { "password".into() } else { extra.ssh_auth_type.clone() },
            password:  extra.ssh_password.clone(),
            key_path:  extra.ssh_key_path.clone(),
        };
        let db_host = config.host.as_deref().unwrap_or("127.0.0.1");
        let db_port = config.port.unwrap_or(6379);
        let t = DbTunnel::open_shared(&config.id, &tcfg, db_host, db_port).await
            .map_err(|e| format!("SSH 隧道失败: {e}"))?;
        let lp = t.local_port;
        ("127.0.0.1".to_string(), lp, Some(t))
    } else {
        let h = config.host.as_deref().unwrap_or("127.0.0.1").to_string();
        let p = config.port.unwrap_or(6379);
        (h, p, None)
    };

    use super::build_redis_url;
    let url = build_redis_url(&host, port, config.username.as_deref(), password.as_deref(), db, false);
    let client = redis::Client::open(url.as_str()).map_err(|e| format!("Redis URL 无效: {e}"))?;
    let mut pubsub = client.get_async_pubsub().await
        .map_err(|e| format!("连接失败: {e}"))?;

    for ch in &channels {
        pubsub.subscribe(ch.as_str()).await
            .map_err(|e| format!("SUBSCRIBE {ch} 失败: {e}"))?;
    }
    for pat in &patterns {
        pubsub.psubscribe(pat.as_str()).await
            .map_err(|e| format!("PSUBSCRIBE {pat} 失败: {e}"))?;
    }

    let session_id = format!("ps-{id}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    let sid_clone = session_id.clone();

    tokio::spawn(async move {
        let mut stream = pubsub.into_on_message();
        while let Some(msg) = stream.next().await {
            let channel = msg.get_channel_name().to_string();
            let data: String = msg.get_payload().unwrap_or_default();
            let pattern = msg.get_pattern::<Option<String>>().unwrap_or(None);
            let kind = if pattern.is_some() { "pmessage" } else { "message" };
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            let payload = PubSubMessage { kind: kind.to_string(), channel, pattern, data, ts };
            let _ = app.emit(&format!("redis_pubsub_msg_{sid_clone}"), payload);
        }
    });

    Ok(session_id)
}
