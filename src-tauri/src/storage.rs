//! # Storage Module
//!
//! Persistent storage for database connection configurations.
//!
//! Connections are stored in JSON format at `~/.config/dbterm/connections.json`
//! (or platform-equivalent app data directory). Passwords are stored separately
//! in the OS keychain for security.
//!
//! ## Security
//!
//! - Connection files are restricted to 0600 permissions (owner read/write only)
//! - Atomic write-rename prevents corruption from crashes mid-write
//! - Sensitive fields (passwords, SSH keys) are stored in system keychain
//!
//! ## Thread Safety
//!
//! [`StorageState`] wraps [`Storage`] in a `Mutex` for safe concurrent access
//! from multiple Tauri commands.

use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
};
use crate::models::ConnConfig;

/// Connection configuration storage
///
/// Manages persistent storage of database connection configurations in JSON format.
/// Thread-safe via [`StorageState`] wrapper.
pub struct Storage {
    path: PathBuf,
}

impl Storage {
    /// Creates a new storage instance
    ///
    /// # Arguments
    /// * `app_data_dir` - Application data directory (e.g., `~/.config/dbterm`)
    ///
    /// # Returns
    /// Storage instance with path at `<app_data_dir>/connections.json`
    ///
    /// # Errors
    /// Returns error if directory creation fails
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("无法创建配置目录: {e}"))?;
        Ok(Self {
            path: app_data_dir.join("connections.json"),
        })
    }

    /// Loads all connection configurations from disk
    ///
    /// # Returns
    /// Vector of connection configs, or empty vector if file doesn't exist
    ///
    /// # Errors
    /// Returns error if file read or JSON parsing fails
    pub fn load(&self) -> Result<Vec<ConnConfig>, String> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&self.path)
            .map_err(|e| format!("读取配置文件失败: {e}"))?;
        if content.trim().is_empty() {
            return Ok(vec![]);
        }
        serde_json::from_str(&content)
            .map_err(|e| format!("解析配置文件失败: {e}"))
    }

    /// Atomically writes all connections to disk
    ///
    /// Uses write-then-rename pattern to prevent corruption:
    /// 1. Write to temporary file `connections.json.tmp`
    /// 2. Set file permissions to 0600 (owner read/write only)
    /// 3. Atomically rename to `connections.json`
    ///
    /// # Arguments
    /// * `conns` - All connection configurations to save
    ///
    /// # Errors
    /// Returns error if serialization, write, or rename fails
    fn write_all(&self, conns: &[ConnConfig]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(conns)
            .map_err(|e| format!("序列化失败: {e}"))?;
        // 先写临时文件再原子重命名，防止写入中途崩溃损坏配置
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &json)
            .map_err(|e| format!("写入临时配置文件失败: {e}"))?;
        // 连接表含主机/用户名/密钥路径及（SSH 代理/跳板机）密码，收紧到 0600 防同机其他用户读取
        crate::keychain::restrict_permissions(&tmp);
        fs::rename(&tmp, &self.path)
            .map_err(|e| format!("配置文件重命名失败: {e}"))?;
        crate::keychain::restrict_permissions(&self.path);
        Ok(())
    }

    /// Inserts or updates a connection configuration
    ///
    /// If a connection with the same ID exists, it's updated. Otherwise, inserted.
    ///
    /// # Arguments
    /// * `config` - Connection configuration to save
    ///
    /// # Returns
    /// The saved configuration (same as input)
    ///
    /// # Errors
    /// Returns error if load or write fails
    pub fn upsert(&self, config: ConnConfig) -> Result<ConnConfig, String> {
        let mut all = self.load()?;
        let pos = all.iter().position(|c| c.id == config.id);
        let saved = config.clone();
        match pos {
            Some(i) => all[i] = config,
            None => all.push(config),
        }
        self.write_all(&all)?;
        Ok(saved)
    }

    /// Deletes a connection configuration by ID
    ///
    /// # Arguments
    /// * `id` - Connection ID to delete
    ///
    /// # Returns
    /// Ok if successful (even if ID didn't exist)
    ///
    /// # Errors
    /// Returns error if load or write fails
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut all = self.load()?;
        all.retain(|c| c.id != id);
        self.write_all(&all)
    }

    /// Deletes the entire connections file (irreversible data wipe)
    ///
    /// Used for clearing all local data. Cannot be undone.
    ///
    /// # Errors
    /// Returns error if file deletion fails (OK if file doesn't exist)
    pub fn clear(&self) -> Result<(), String> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .map_err(|e| format!("删除连接配置失败: {e}"))?;
        }
        Ok(())
    }
}

/// Thread-safe storage state for Tauri commands
///
/// Wraps [`Storage`] in a `Mutex` to allow safe concurrent access
/// from multiple Tauri command handlers.
///
/// # Usage
///
/// ```rust,ignore
/// use tauri::State;
/// use crate::storage::StorageState;
///
/// #[tauri::command]
/// fn load_connections(storage: State<StorageState>) -> Result<Vec<ConnConfig>, String> {
///     storage.lock().unwrap().load()
/// }
/// ```
pub type StorageState = Mutex<Storage>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnType;

    fn create_test_config(id: &str, name: &str) -> ConnConfig {
        ConnConfig {
            id: id.to_string(),
            name: name.to_string(),
            conn_type: ConnType::Mysql,
            host: Some("localhost".to_string()),
            port: Some(3306),
            username: Some("root".to_string()),
            database: Some("test".to_string()),
            file_path: None,
            ssh_key_path: None,
            use_ssl: false,
            extra_json: None,
            env_label: None,
            read_only: None,
            color: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn test_storage_new() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let result = Storage::new(temp_dir.clone());
        assert!(result.is_ok());
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_load_empty() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        let conns = storage.load().unwrap();
        assert_eq!(conns.len(), 0);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_upsert_new_connection() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        let config = create_test_config("conn-1", "Test Connection");
        let saved = storage.upsert(config.clone()).unwrap();

        assert_eq!(saved.id, "conn-1");
        assert_eq!(saved.name, "Test Connection");

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "conn-1");

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_upsert_update_existing() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        let config1 = create_test_config("conn-1", "Original Name");
        storage.upsert(config1).unwrap();

        let mut config2 = create_test_config("conn-1", "Updated Name");
        config2.port = Some(3307);
        storage.upsert(config2).unwrap();

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Updated Name");
        assert_eq!(loaded[0].port, Some(3307));

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_upsert_multiple_connections() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();
        storage.upsert(create_test_config("conn-2", "Connection 2")).unwrap();
        storage.upsert(create_test_config("conn-3", "Connection 3")).unwrap();

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 3);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_delete_connection() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();
        storage.upsert(create_test_config("conn-2", "Connection 2")).unwrap();

        storage.delete("conn-1").unwrap();

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "conn-2");

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_delete_nonexistent() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();

        let result = storage.delete("nonexistent");
        assert!(result.is_ok());

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 1);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_clear() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();
        storage.upsert(create_test_config("conn-2", "Connection 2")).unwrap();

        storage.clear().unwrap();

        let loaded = storage.load().unwrap();
        assert_eq!(loaded.len(), 0);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_atomic_write() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        // 写入数据
        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();

        // 验证临时文件已被删除
        let tmp_path = storage.path.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "临时文件应该被删除");

        // 验证最终文件存在
        assert!(storage.path.exists(), "配置文件应该存在");

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(temp_dir.clone()).unwrap();

        storage.upsert(create_test_config("conn-1", "Connection 1")).unwrap();

        let metadata = std::fs::metadata(&storage.path).unwrap();
        let permissions = metadata.permissions();

        // 验证文件权限是 0600
        assert_eq!(permissions.mode() & 0o777, 0o600, "配置文件权限应该是 0600");

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_persistence() {
        let temp_dir = std::env::temp_dir().join(format!("dbterm-storage-test-{}", uuid::Uuid::new_v4()));

        {
            let storage = Storage::new(temp_dir.clone()).unwrap();
            storage.upsert(create_test_config("conn-1", "Persistent Connection")).unwrap();
        }

        // 重新加载
        {
            let storage = Storage::new(temp_dir.clone()).unwrap();
            let loaded = storage.load().unwrap();
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].id, "conn-1");
            assert_eq!(loaded[0].name, "Persistent Connection");
        }

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
