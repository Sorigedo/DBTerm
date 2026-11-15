use super::*;

fn config(kind: &str, read_only: bool) -> ConnConfig {
    serde_json::from_value(serde_json::json!({
        "id": "isolated-native-authorization", "name": "authorization-test", "type": kind,
        "host": "127.0.0.1", "port": 1, "username": "none", "database": "master",
        "readOnly": read_only, "useSsl": false, "createdAt": 0, "updatedAt": 0
    })).unwrap()
}

#[tokio::test]
async fn native_update_refuses_read_only_before_credentials_or_connection() {
    let pool: SsPool = Arc::new(Mutex::new(HashMap::new()));
    let result = ss_update_cell("isolated-native-authorization", &config("sqlServer", true), "master", "t", "v", Some("new".into()), &["id".into()], &[Some("1".into())], &Some("old".into()), &pool, None).await;
    assert!(result.unwrap_err().contains("只读"), "native write must authorize before credentials or TCP");
}

#[test]
fn native_connection_loader_refuses_another_engine_before_credentials() {
    let dir = std::env::temp_dir().join(format!("dbterm-ss-auth-{}", uuid::Uuid::new_v4()));
    let storage = crate::storage::Storage::new(dir.clone()).unwrap();
    storage.upsert(config("mysql", false)).unwrap();
    let storage = std::sync::Mutex::new(storage);
    let error = load_conn("isolated-native-authorization", &storage).unwrap_err();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(error.contains("SQL Server"), "typed native IPC must reject another engine before credentials");
}

#[test]
fn native_admin_loader_refuses_read_only_before_credentials() {
    let dir = std::env::temp_dir().join(format!("dbterm-ss-auth-{}", uuid::Uuid::new_v4()));
    let storage = crate::storage::Storage::new(dir.clone()).unwrap();
    storage.upsert(config("sqlServer", true)).unwrap();
    let error = load_write_conn("isolated-native-authorization", &std::sync::Mutex::new(storage)).unwrap_err();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(error.contains("只读"));
}

#[tokio::test]
async fn native_query_dispatch_refuses_read_only_mutation_before_credentials() {
    let pool: SsPool = Arc::new(Mutex::new(HashMap::new()));
    let error = dispatch_ss_query("isolated-native-authorization", &config("sqlServer", true), "DELETE FROM dbo.t", &pool).await.unwrap_err();
    assert!(error.contains("只读"));
}

#[test]
fn native_explain_sql_authorization_preserves_reads_and_denies_mutating_batches() {
    let readonly = config("sqlServer", true);
    assert!(require_sql(&readonly, "SELECT id FROM dbo.t").is_ok());
    for sql in ["DELETE FROM dbo.t", "SELECT 1; DELETE FROM dbo.t", "WITH a AS (SELECT 1 AS id) DELETE FROM dbo.t", "EXEC sp_query_store_force_plan 1,1"] {
        assert!(require_sql(&readonly, sql).unwrap_err().contains("只读"), "{sql}");
    }
    assert!(require_sql(&config("sqlServer", false), "DELETE FROM dbo.t").is_ok());
    assert!(require_sql(&config("mysql", false), "SELECT 1").is_err());
}
