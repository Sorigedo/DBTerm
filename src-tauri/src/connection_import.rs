use crate::{keychain, models::ConnConfig, storage::Storage};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_JOURNAL_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u8,
    config_snapshot: Option<Vec<u8>>,
    password_snapshot: Option<Vec<u8>>,
}

fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("connection-import-recovery.json")
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(journal).map_err(|e| format!("序列化连接导入恢复日志失败: {e}"))?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("连接导入恢复日志超过大小限制".into());
    }
    let tmp = path.with_file_name(format!(".connection-import-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("创建连接导入恢复日志失败: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("写入连接导入恢复日志失败: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("刷盘连接导入恢复日志失败: {e}"))?;
        drop(file);
        keychain::restrict_permissions(&tmp);
        keychain::atomic_replace_file(&tmp, &path.to_path_buf())
            .map_err(|e| format!("发布连接导入恢复日志失败: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

fn rollback(storage: &Storage, journal: &Journal) -> Result<(), String> {
    storage.restore_import_snapshot(journal.config_snapshot.as_deref())?;
    keychain::restore_password_snapshot_unlocked(journal.password_snapshot.as_deref())?;
    Ok(())
}

pub(crate) fn recover(data_dir: &Path, storage: &Storage) -> Result<(), String> {
    recover_with(data_dir, storage, |snapshot| {
        keychain::restore_password_snapshot_unlocked(snapshot)
    })
}

fn recover_with(
    data_dir: &Path,
    storage: &Storage,
    restore_passwords: impl FnOnce(Option<&[u8]>) -> Result<(), String>,
) -> Result<(), String> {
    let path = journal_path(data_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取连接导入恢复日志失败: {error}")),
    };
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("连接导入恢复日志超过大小限制，拒绝启动以免覆盖数据".into());
    }
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("连接导入恢复日志损坏，拒绝启动以免覆盖数据: {e}"))?;
    if journal.version != 1 {
        return Err("连接导入恢复日志版本不支持，拒绝启动以免覆盖数据".into());
    }
    storage.restore_import_snapshot(journal.config_snapshot.as_deref())?;
    restore_passwords(journal.password_snapshot.as_deref())?;
    fs::remove_file(path).map_err(|e| format!("恢复已回滚，但删除连接导入恢复日志失败: {e}"))
}

pub(crate) fn apply(
    data_dir: &Path,
    storage: &Storage,
    configs: Vec<ConnConfig>,
    password_updates: Vec<(String, String)>,
) -> Result<(), String> {
    let journal = journal_path(data_dir);
    if journal.exists() {
        return Err("存在未恢复的连接导入日志，请重启软件完成恢复后重试".into());
    }
    keychain::with_password_batch(&password_updates, |password_snapshot, next_passwords| {
        let config_snapshot = storage.snapshot_raw()?;
        let snapshot = Journal {
            version: 1,
            config_snapshot,
            password_snapshot,
        };
        write_journal(&journal, &snapshot)?;
        let operation =
            storage
                .upsert_many(configs)
                .and_then(|_| match next_passwords.as_deref() {
                    Some(bytes) => keychain::publish_password_snapshot(Some(bytes)),
                    None => keychain::publish_password_snapshot(None),
                });
        match operation {
            Ok(()) => {
                fs::remove_file(&journal).map_err(|e| {
                    format!("连接及密码已导入，但清除恢复日志失败；重启后将恢复导入前状态: {e}")
                })?;
                Ok(())
            }
            Err(error) => {
                rollback(storage, &snapshot).map_err(|rollback_error| format!("连接导入失败: {error}；自动恢复失败: {rollback_error}；恢复日志保留，重启后将继续恢复"))?;
                fs::remove_file(&journal)
                    .map_err(|e| format!("连接导入失败且数据已恢复，但清除恢复日志失败: {e}"))?;
                Err(format!("连接导入失败，已恢复导入前状态: {error}"))
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnType;

    fn config(id: &str) -> ConnConfig {
        ConnConfig {
            id: id.into(),
            name: id.into(),
            conn_type: ConnType::Mysql,
            host: Some("127.0.0.1".into()),
            port: Some(3306),
            username: Some("u".into()),
            database: None,
            file_path: None,
            ssh_key_path: None,
            use_ssl: false,
            created_at: 1,
            updated_at: 1,
            color: None,
            extra_json: None,
            read_only: None,
            env_label: None,
        }
    }

    #[test]
    fn startup_recovery_restores_both_snapshots_and_keeps_log_if_restore_fails() {
        let dir =
            std::env::temp_dir().join(format!("dbterm-import-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let storage = Storage::new(dir.clone()).unwrap();
        storage.upsert(config("new")).unwrap();
        let password_path = dir.join("passwords.json");
        fs::write(&password_path, b"new-password-state").unwrap();
        let path = journal_path(&dir);
        write_journal(
            &path,
            &Journal {
                version: 1,
                config_snapshot: None,
                password_snapshot: Some(b"old-password-state".to_vec()),
            },
        )
        .unwrap();
        recover_with(&dir, &storage, |snapshot| {
            match snapshot {
                Some(bytes) => fs::write(&password_path, bytes).map_err(|e| e.to_string()),
                None => {
                    let _ = fs::remove_file(&password_path);
                    Ok(())
                }
            }
        })
        .unwrap();
        assert!(storage.load().unwrap().is_empty());
        assert_eq!(fs::read(&password_path).unwrap(), b"old-password-state");
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_recovery_log_fails_closed_and_is_not_deleted() {
        let dir =
            std::env::temp_dir().join(format!("dbterm-import-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let storage = Storage::new(dir.clone()).unwrap();
        let path = journal_path(&dir);
        fs::write(&path, b"not-json").unwrap();
        assert!(recover(&dir, &storage).unwrap_err().contains("拒绝启动"));
        assert!(path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_second_publish_restores_config_and_password_snapshots() {
        use serial_test::serial;
        #[serial]
        fn run() {
            let dir = std::env::temp_dir().join(format!(
                "dbterm-import-transaction-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&dir).unwrap();
            let storage = Storage::new(dir.clone()).unwrap();
            storage.upsert(config("old")).unwrap();
            let password_path = dir.join("passwords.json");
            fs::write(&password_path, br#"{"old":"before"}"#).unwrap();
            let config_before = storage.snapshot_raw().unwrap();
            let password_before = fs::read(&password_path).ok();
            let result = keychain::with_password_batch_at(
                &password_path,
                &[("new".into(), "after".into())],
                |old_passwords, new_passwords| {
                    let snapshot = Journal {
                        version: 1,
                        config_snapshot: config_before.clone(),
                        password_snapshot: old_passwords.clone(),
                    };
                    write_journal(&journal_path(&dir), &snapshot)?;
                    storage.upsert_many(vec![config("new")])?;
                    // Simulate a failure before password publication.
                    storage.restore_import_snapshot(snapshot.config_snapshot.as_deref())?;
                    match snapshot.password_snapshot.as_deref() {
                        Some(bytes) => fs::write(&password_path, bytes).map_err(|e| e.to_string())?,
                        None => { let _ = fs::remove_file(&password_path); }
                    }
                    let _ = new_passwords;
                    fs::remove_file(journal_path(&dir)).unwrap();
                    Err::<(), _>("injected second publish failure".into())
                },
            );
            assert!(result.is_err());
            assert_eq!(storage.snapshot_raw().unwrap(), config_before);
            assert_eq!(fs::read(&password_path).ok(), password_before);
            fs::remove_dir_all(dir).unwrap();
        }
        run();
    }
}
