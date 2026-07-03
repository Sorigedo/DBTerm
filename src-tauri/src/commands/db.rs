use tauri::State;
use uuid::Uuid;

use crate::{
    keychain,
    models::{ConnConfig, ConnType, TestResult},
    storage::StorageState,
    tester,
    commands::driver::DriverRegistry,
};

#[tauri::command]
pub fn list_connections(storage: State<'_, StorageState>) -> Result<Vec<ConnConfig>, String> {
    storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).load()
}

#[tauri::command]
pub fn save_connection(
    mut config: ConnConfig,
    password: Option<String>,
    storage: State<'_, StorageState>,
) -> Result<ConnConfig, String> {
    if config.id.is_empty() {
        config.id = Uuid::new_v4().to_string();
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    if config.created_at == 0 {
        config.created_at = now;
    }
    config.updated_at = now;

    match password {
        Some(pwd) if !pwd.is_empty() => keychain::set_password(&config.id, &pwd)?,
        Some(_) => keychain::delete_password(&config.id)?, // 空字符串=明确清除密码
        None => {}                                          // None=不修改
    }

    // SSH：把代理/跳板密码迁出 extra_json 明文 → keychain（仅非空才迁，空=保留既有，避免编辑重存丢密码）
    if config.conn_type == crate::models::ConnType::Ssh {
        crate::ssh::stash_secrets(&mut config)?;
    } else {
        // DB 连接：把 SSH 隧道密码同样迁出 extra_json 明文 → keychain
        crate::ssh::stash_db_tunnel_secret(&mut config)?;
    }

    // 配置变更后失效各引擎连接池，使新主机/密码/只读等配置生效
    crate::commands::query::invalidate_mysql_pool(&config.id);
    crate::commands::query::invalidate_pg_pool(&config.id);
    crate::commands::query::invalidate_sqlite_pool(&config.id);
    crate::commands::clickhouse_tcp::invalidate(&config.id);

    storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).upsert(config)
}

#[tauri::command]
pub fn delete_connection(id: String, storage: State<'_, StorageState>) -> Result<(), String> {
    keychain::delete_password(&id)?;
    crate::ssh::purge_secrets(&id);   // 一并清理代理/跳板密码 keychain 条目
    crate::commands::query::invalidate_mysql_pool(&id);
    crate::commands::query::invalidate_pg_pool(&id);
    crate::commands::query::invalidate_sqlite_pool(&id);
    crate::commands::clickhouse_tcp::invalidate(&id);
    storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).delete(&id)
}

#[tauri::command]
pub fn get_connection_password(id: String) -> Result<Option<String>, String> {
    if id.trim().is_empty() {
        return Err("连接 ID 不能为空".into());
    }
    keychain::get_password(&id)
}

/// 清空本机全部数据：连接配置 + 密码 + 已信任主机。不可恢复，供「卸载前清理」用。
#[tauri::command]
pub fn wipe_local_data(storage: State<'_, StorageState>) -> Result<(), String> {
    storage.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear()?;
    keychain::clear_all()?;
    crate::ssh::clear_known_hosts()?;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    config: ConnConfig,
    password: Option<String>,
    registry: State<'_, DriverRegistry>,
) -> Result<TestResult, String> {
    let effective = match password {
        Some(p) if !p.is_empty() => Some(p),
        _ if !config.id.is_empty() => keychain::get_password(&config.id).ok().flatten(),
        _ => None,
    };
    if config.conn_type == ConnType::Duckdb {
        return Ok(crate::commands::duckdb::test_connection(&config, &registry).await);
    }
    if config.conn_type == ConnType::Oracle {
        return Ok(crate::commands::oracle::test_connection(&config, effective.as_deref(), &registry).await);
    }
    Ok(tester::test(&config, effective.as_deref()).await)
}
