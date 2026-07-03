// MO9.3: MongoDB 用户与角色管理
use bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{MongoPool, load_conn, get_client};
use crate::storage::StorageState;

fn check_not_readonly(config: &crate::models::ConnConfig) -> Result<(), String> {
    if config.read_only == Some(true) {
        return Err("当前连接为只读模式，写操作已被禁止".to_string());
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MongoRoleRef {
    pub role: String,
    pub db: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoUserInfo {
    pub username: String,
    pub db: String,
    pub roles: Vec<MongoRoleRef>,
    pub custom_data: Option<String>,
    pub mechanisms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRoleInfo {
    pub role: String,
    pub db: String,
    pub is_builtin: bool,
    pub privileges_count: i64,
    pub inherited_roles: Vec<MongoRoleRef>,
}

fn doc_to_json(d: &Document) -> String {
    serde_json::to_string(d).unwrap_or_else(|_| "{}".to_string())
}

fn get_str(d: &Document, k: &str) -> String {
    d.get_str(k).unwrap_or("").to_string()
}

fn parse_roles(arr: &[Bson]) -> Vec<MongoRoleRef> {
    arr.iter().filter_map(|b| {
        let d = b.as_document()?;
        Some(MongoRoleRef {
            role: get_str(d, "role"),
            db: get_str(d, "db"),
        })
    }).collect()
}

/// Tauri 命令：列出指定库的用户（usersInfo）
#[tauri::command]
pub async fn mongo_users_info(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<MongoUserInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let result = client.database(&db)
        .run_command(doc! { "usersInfo": 1 }).await
        .map_err(|e| format!("usersInfo 失败: {e}"))?;

    let users_bson = result.get_array("users").map(|a| a.as_slice()).unwrap_or_default();
    let mut users = Vec::new();
    for b in users_bson {
        let d = match b.as_document() { Some(d) => d, None => continue };
        let roles = d.get_array("roles").map(|a| parse_roles(a.as_slice())).unwrap_or_default();
        let mechs = d.get_array("mechanisms")
            .map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let custom = d.get_document("customData").ok().map(doc_to_json);
        users.push(MongoUserInfo {
            username: get_str(d, "user"),
            db: get_str(d, "db"),
            roles,
            custom_data: custom,
            mechanisms: mechs,
        });
    }
    Ok(users)
}

/// Tauri 命令：列出指定库的角色（rolesInfo）
#[tauri::command]
pub async fn mongo_roles_info(
    id: String,
    db: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<Vec<MongoRoleInfo>, String> {
    let (config, password) = load_conn(&id, &storage)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let result = client.database(&db)
        .run_command(doc! { "rolesInfo": 1, "showBuiltinRoles": true }).await
        .map_err(|e| format!("rolesInfo 失败: {e}"))?;

    let roles_bson = result.get_array("roles").map(|a| a.as_slice()).unwrap_or_default();
    let mut roles = Vec::new();
    for b in roles_bson {
        let d = match b.as_document() { Some(d) => d, None => continue };
        let inherited = d.get_array("inheritedRoles")
            .map(|a| parse_roles(a.as_slice()))
            .unwrap_or_default();
        let privileges_count = d.get_array("privileges")
            .map(|a| a.len() as i64)
            .unwrap_or(0);
        let is_builtin = d.get_bool("isBuiltin").unwrap_or(false);
        roles.push(MongoRoleInfo {
            role: get_str(d, "role"),
            db: get_str(d, "db"),
            is_builtin,
            privileges_count,
            inherited_roles: inherited,
        });
    }
    Ok(roles)
}

/// Tauri 命令：创建用户（MO9.3，写操作，强确认由前端保证）
#[tauri::command]
pub async fn mongo_create_user(
    id: String,
    db: String,
    username: String,
    password: String,
    roles: Vec<MongoRoleRef>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if username.trim().is_empty() { return Err("用户名不能为空".to_string()); }
    if password.trim().is_empty() { return Err("密码不能为空".to_string()); }
    let (config, conn_password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, conn_password.as_deref()).await?;

    let roles_bson: Vec<bson::Bson> = roles.iter().map(|r| {
        bson::to_bson(&bson::doc! { "role": &r.role, "db": &r.db }).unwrap_or(Bson::Null)
    }).collect();

    client.database(&db)
        .run_command(doc! {
            "createUser": &username,
            "pwd": &password,
            "roles": roles_bson
        }).await
        .map_err(|e| format!("创建用户失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：更新用户密码（updateUser pwd，写操作）
#[tauri::command]
pub async fn mongo_update_user_password(
    id: String,
    db: String,
    username: String,
    new_password: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if new_password.trim().is_empty() { return Err("新密码不能为空".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    client.database(&db)
        .run_command(doc! { "updateUser": &username, "pwd": &new_password }).await
        .map_err(|e| format!("更新密码失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：删除用户（dropUser，高危，写操作）
#[tauri::command]
pub async fn mongo_drop_user(
    id: String,
    db: String,
    username: String,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    client.database(&db)
        .run_command(doc! { "dropUser": &username }).await
        .map_err(|e| format!("删除用户失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：授予用户角色（grantRolesToUser，写操作）
#[tauri::command]
pub async fn mongo_grant_roles_to_user(
    id: String,
    db: String,
    username: String,
    roles: Vec<MongoRoleRef>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if roles.is_empty() { return Err("角色列表不能为空".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let roles_bson: Vec<bson::Bson> = roles.iter().map(|r| {
        bson::to_bson(&bson::doc! { "role": &r.role, "db": &r.db }).unwrap_or(Bson::Null)
    }).collect();

    client.database(&db)
        .run_command(doc! { "grantRolesToUser": &username, "roles": roles_bson }).await
        .map_err(|e| format!("授予角色失败: {e}"))?;
    Ok(())
}

/// Tauri 命令：撤销用户角色（revokeRolesFromUser，写操作）
#[tauri::command]
pub async fn mongo_revoke_roles_from_user(
    id: String,
    db: String,
    username: String,
    roles: Vec<MongoRoleRef>,
    storage: State<'_, StorageState>,
    pool: State<'_, MongoPool>,
) -> Result<(), String> {
    if roles.is_empty() { return Err("角色列表不能为空".to_string()); }
    let (config, password) = load_conn(&id, &storage)?;
    check_not_readonly(&config)?;
    let client = get_client(&id, &pool, &config, password.as_deref()).await?;

    let roles_bson: Vec<bson::Bson> = roles.iter().map(|r| {
        bson::to_bson(&bson::doc! { "role": &r.role, "db": &r.db }).unwrap_or(Bson::Null)
    }).collect();

    client.database(&db)
        .run_command(doc! { "revokeRolesFromUser": &username, "roles": roles_bson }).await
        .map_err(|e| format!("撤销角色失败: {e}"))?;
    Ok(())
}
