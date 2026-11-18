//! Real, ephemeral loopback SSH/SFTP; never loads or writes saved connections.
use super::*;
use russh::{server::{Auth, Msg, Session}, Channel, ChannelId};
use russh_sftp::protocol::{Attrs, Data, File, Handle, Name, OpenFlags, Status, StatusCode};
use std::time::Duration;

#[derive(Default)]
struct TestSsh {
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl russh::server::Handler for TestSsh {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        assert_eq!((user, password), ("audit", "local-test-only"));
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, reply: russh::server::ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel); reply.accept().await; Ok(())
    }

    async fn subsystem_request(&mut self, id: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        let channel = self.channels.remove(&id).unwrap();
        session.channel_success(id).unwrap();
        tokio::spawn(russh_sftp::server::run(channel.into_stream(), TestSftp::default()));
        Ok(())
    }
}

struct TestSftp {
    read: bool,
    files: HashMap<String, Vec<u8>>,
    attributes: HashMap<String, FileAttributes>,
    reject_setstat_once: bool,
}

impl Default for TestSftp {
    fn default() -> Self {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(0o755);
        attrs.uid = Some(1000);
        attrs.gid = Some(1001);
        Self { read: false, files: HashMap::from([("/existing".into(), b"original".to_vec())]),
            attributes: HashMap::from([("/existing".into(), attrs)]), reject_setstat_once: true }
    }
}

fn success(id: u32) -> Status {
    Status { id, status_code: StatusCode::Ok, error_message: String::new(), language_tag: String::new() }
}

impl russh_sftp::server::Handler for TestSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error { StatusCode::OpUnsupported }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        if !self.files.contains_key(&path) { return Err(StatusCode::NoSuchFile); }
        Ok(Attrs { id, attrs: self.attributes.get(&path).unwrap().clone() })
    }

    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        if !self.files.contains_key(&path) { return Err(StatusCode::NoSuchFile); }
        if self.reject_setstat_once { self.reject_setstat_once = false; return Err(StatusCode::PermissionDenied); }
        self.attributes.insert(path, attrs);
        Ok(success(id))
    }

    async fn open(&mut self, id: u32, filename: String, flags: OpenFlags, mut attrs: FileAttributes) -> Result<Handle, Self::Error> {
        if flags.contains(OpenFlags::CREATE) {
            if flags.contains(OpenFlags::EXCLUDE) && self.files.contains_key(&filename) {
                return Err(StatusCode::Failure);
            }
            attrs.permissions.get_or_insert(0o644);
            self.files.insert(filename.clone(), Vec::new());
            self.attributes.insert(filename.clone(), attrs);
        } else if !self.files.contains_key(&filename) { return Err(StatusCode::NoSuchFile); }
        Ok(Handle { id, handle: filename })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, bytes: Vec<u8>) -> Result<Status, Self::Error> {
        let file = self.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        file.resize(file.len().max(offset + bytes.len()), 0);
        file[offset..offset + bytes.len()].copy_from_slice(&bytes);
        Ok(success(id))
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        if offset >= file.len() { return Err(StatusCode::Eof); }
        Ok(Data { id, data: file[offset..file.len().min(offset + len as usize)].to_vec() })
    }

    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, Self::Error> {
        if new == "/permission-denied" && old.contains(".dbterm-upload-") {
            return Err(StatusCode::PermissionDenied);
        }
        if new.contains(".dbterm-backup-") && old == "/fail-backup" {
            return Err(StatusCode::PermissionDenied);
        }
        if new == "/lost-install" && old.contains(".dbterm-upload-") && !self.files.contains_key(&new) {
            return Err(StatusCode::ConnectionLost);
        }
        if self.files.contains_key(&new) { return Err(StatusCode::Failure); }
        if new == "/fail-install" && old.contains(".dbterm-upload-") {
            return Err(StatusCode::Failure);
        }
        if new == "/fail-restore" && old.contains(".dbterm-backup-") {
            return Err(StatusCode::PermissionDenied);
        }
        if new == "/fail-restore" && old.contains(".dbterm-upload-") {
            return Err(StatusCode::Failure);
        }
        self.move_file(id, old, new)
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        if self.files.remove(&filename).is_none() {
            return Err(StatusCode::NoSuchFile);
        }
        self.attributes.remove(&filename);
        Ok(success(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        self.read = false;
        Ok(Handle { id, handle: path })
    }

    async fn readdir(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        if self.read { return Err(StatusCode::Eof); }
        self.read = true;
        Ok(Name { id, files: self.files.keys().map(|path| {
            let name = path.rsplit('/').next().unwrap_or(path);
            File::new(name, self.attributes.get(path).cloned().unwrap_or_default())
        }).collect() })
    }

    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(success(id))
    }
}

impl TestSftp {
    fn move_file(&mut self, id: u32, old: String, new: String) -> Result<Status, StatusCode> {
        let file = self.files.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        let attrs = self.attributes.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        self.files.insert(new.clone(), file);
        self.attributes.insert(new, attrs);
        Ok(success(id))
    }
}

#[tokio::test]
async fn loopback_sftp_recovers_closed_channel_and_changed_configuration() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = server_config.clone();
            tokio::spawn(async move {
                if let Ok(session) = russh::server::run_stream(config, socket, TestSsh::default()).await {
                    let _ = session.await;
                }
            });
        }
    });
    let mut config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id": format!("loopback-sftp-audit-{port}"), "name": "本地隔离测试", "type": "ssh",
        "host": "127.0.0.1", "port": port, "username": "audit",
        "database": null, "filePath": null, "useSsl": false, "createdAt": 1, "updatedAt": 1,
        "extraJson": serde_json::json!({
            "hostKeyPolicy": "skip", "authType": "password", "heartbeatInterval": 0,
            // Avoid even reading optional credentials from the user's keychain.
            "proxyPassword": "unused-test-only", "jumpPassword": "unused-test-only"
        }).to_string()
    })).unwrap();
    let password = Some("local-test-only");
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let entries = list_dir(&config, password, "/").await.unwrap();
        assert_eq!(entries.len(), 1);
        let (old, cached) = acquire(&config, password).await.unwrap();
        assert!(cached);
        // Closing is asynchronous in russh-sftp; a request queued during close
        // can wait for its request timeout. Keep the failure injection bounded.
        old.sftp.set_timeout(1);
        old.sftp.close().await.unwrap();
        // The SSH transport remains alive; recovering requires recognizing a
        // closed SFTP channel rather than checking the SSH handle alone.
        assert_eq!(list_dir(&config, password, "/").await.unwrap().len(), 1);
        let (replacement, _) = acquire(&config, password).await.unwrap();
        assert!(!Arc::ptr_eq(&old, &replacement));

        config.updated_at = 2;
        assert_eq!(list_dir(&config, password, "/").await.unwrap().len(), 1);
        let (changed, _) = acquire(&config, password).await.unwrap();
        assert!(!Arc::ptr_eq(&replacement, &changed));
        assert_eq!(changed.updated_at, 2);
        let (temporary, mut staged) = create_upload_temp(&changed.sftp, "/new-upload").await.unwrap();
        staged.write_all(b"replacement").await.unwrap();
        staged.shutdown().await.unwrap();
        assert!(commit_upload(&changed.sftp, &temporary, "/existing").await.is_err());
        let mut original = changed.sftp.open("/existing").await.unwrap();
        let mut bytes = Vec::new();
        original.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"original", "failed attribute preservation must leave the original untouched");
        commit_upload(&changed.sftp, &temporary, "/existing").await.unwrap();
        let attrs = changed.sftp.symlink_metadata("/existing").await.unwrap();
        assert_eq!(attrs.permissions, Some(0o755));
        assert_eq!((attrs.uid, attrs.gid), (Some(1000), Some(1001)));
        let mut uploaded = changed.sftp.open("/existing").await.unwrap();
        bytes.clear();
        uploaded.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"replacement");
        let names = list_dir(&config, password, "/").await.unwrap();
        assert!(!names.iter().any(|entry| entry.name.starts_with(".dbterm-backup-")),
            "successful replacement must clean up the previous-file backup");

        let mut directory_target = changed.sftp.create("/directory-target").await.unwrap();
        directory_target.shutdown().await.unwrap();
        let mut directory_attrs = FileAttributes::empty();
        directory_attrs.permissions = Some(0o040755);
        changed.sftp.set_metadata("/directory-target", directory_attrs).await.unwrap();
        let (directory_temp, mut directory_file) = create_upload_temp(&changed.sftp, "/directory-target").await.unwrap();
        directory_file.write_all(b"must not replace directory").await.unwrap();
        directory_file.shutdown().await.unwrap();
        let directory_result = commit_upload(&changed.sftp, &directory_temp, "/directory-target").await;
        assert!(directory_result.is_err(), "upload must reject a directory destination");
        assert!(changed.sftp.symlink_metadata("/directory-target").await.unwrap().is_dir());
        cleanup_upload_temp(&changed.sftp, &directory_temp).await;
        let mut link_target = changed.sftp.create("/link-target").await.unwrap();
        link_target.shutdown().await.unwrap();
        let mut link_attrs = FileAttributes::empty();
        link_attrs.permissions = Some(0o120777);
        changed.sftp.set_metadata("/link-target", link_attrs).await.unwrap();
        let (link_temp, mut link_file) = create_upload_temp(&changed.sftp, "/link-target").await.unwrap();
        link_file.shutdown().await.unwrap();
        assert!(commit_upload(&changed.sftp, &link_temp, "/link-target").await.unwrap_err().contains("符号链接"));
        assert!(changed.sftp.symlink_metadata("/link-target").await.unwrap().is_symlink());
        cleanup_upload_temp(&changed.sftp, &link_temp).await;

        let mut backup_target = changed.sftp.create("/fail-backup").await.unwrap();
        backup_target.write_all(b"original cannot move").await.unwrap();
        backup_target.shutdown().await.unwrap();
        let (backup_temp, mut backup_file) = create_upload_temp(&changed.sftp, "/fail-backup").await.unwrap();
        backup_file.write_all(b"new content").await.unwrap();
        backup_file.shutdown().await.unwrap();
        let backup_error = commit_upload(&changed.sftp, &backup_temp, "/fail-backup").await.unwrap_err();
        assert!(backup_error.contains("原文件备份可能位于 /.dbterm-backup-"), "backup failure must report potential recovery path: {backup_error}");
        let mut unmoved = changed.sftp.open("/fail-backup").await.unwrap();
        bytes.clear();
        unmoved.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"original cannot move");
        cleanup_upload_temp(&changed.sftp, &backup_temp).await;

        let mut fail_target = changed.sftp.create("/fail-install").await.unwrap();
        fail_target.write_all(b"keep this file").await.unwrap();
        fail_target.shutdown().await.unwrap();
        let (restore_temp, mut restore_file) = create_upload_temp(&changed.sftp, "/fail-install").await.unwrap();
        restore_file.write_all(b"new content").await.unwrap();
        restore_file.shutdown().await.unwrap();
        let restore_error = commit_upload(&changed.sftp, &restore_temp, "/fail-install").await.unwrap_err();
        assert!(restore_error.contains("原文件已恢复"), "injected install failure must exercise restoration: {restore_error}");
        cleanup_upload_temp(&changed.sftp, &restore_temp).await;
        let mut restored = changed.sftp.open("/fail-install").await.unwrap();
        bytes.clear();
        restored.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"keep this file", "failed staged install must restore the previous target");

        let mut denied_target = changed.sftp.create("/permission-denied").await.unwrap();
        denied_target.write_all(b"preserve despite permission error").await.unwrap();
        denied_target.shutdown().await.unwrap();
        let (denied_temp, mut denied_file) = create_upload_temp(&changed.sftp, "/permission-denied").await.unwrap();
        denied_file.write_all(b"must not install").await.unwrap();
        denied_file.shutdown().await.unwrap();
        assert!(commit_upload(&changed.sftp, &denied_temp, "/permission-denied").await.is_err());
        cleanup_upload_temp(&changed.sftp, &denied_temp).await;
        let names = list_dir(&config, password, "/").await.unwrap();
        assert!(!names.iter().any(|entry| entry.name.starts_with(".dbterm-backup-")),
            "an explicit permission error must not invoke overwrite fallback");
        let mut denied_original = changed.sftp.open("/permission-denied").await.unwrap();
        bytes.clear();
        denied_original.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"preserve despite permission error");

        let mut unrestorable_target = changed.sftp.create("/fail-restore").await.unwrap();
        unrestorable_target.write_all(b"recoverable original").await.unwrap();
        unrestorable_target.shutdown().await.unwrap();
        let (unrestorable_temp, mut unrestorable_file) = create_upload_temp(&changed.sftp, "/fail-restore").await.unwrap();
        unrestorable_file.write_all(b"new content").await.unwrap();
        unrestorable_file.shutdown().await.unwrap();
        let error = commit_upload(&changed.sftp, &unrestorable_temp, "/fail-restore").await.unwrap_err();
        assert!(error.contains("原文件恢复失败"), "expected restore failure: {error}");
        let backup_path = error.split("原文件备份位于 ").nth(1).unwrap().split(['，', '。']).next().unwrap();
        let mut preserved_backup = changed.sftp.open(backup_path).await.unwrap();
        bytes.clear();
        preserved_backup.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"recoverable original", "restore failure must leave the original accessible at the reported backup path");
        let mut lost_target = changed.sftp.create("/lost-install").await.unwrap();
        lost_target.write_all(b"original before transport failure").await.unwrap();
        lost_target.shutdown().await.unwrap();
        let (lost_temp, mut lost_file) = create_upload_temp(&changed.sftp, "/lost-install").await.unwrap();
        lost_file.write_all(b"pending content").await.unwrap();
        lost_file.shutdown().await.unwrap();
        let lost_error = commit_upload(&changed.sftp, &lost_temp, "/lost-install").await.unwrap_err();
        assert!(lost_error.contains("结果不确定"), "connection loss must retain backup rather than replay mutations: {lost_error}");
        assert!(changed.sftp.symlink_metadata("/lost-install").await.is_err());
        let lost_backup = lost_error.split("原文件备份位于 ").nth(1).unwrap().split('，').next().unwrap();
        let mut original_backup = changed.sftp.open(lost_backup).await.unwrap();
        bytes.clear();
        original_backup.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"original before transport failure");
        let mut pending_upload = changed.sftp.open(&lost_temp).await.unwrap();
        bytes.clear();
        pending_upload.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"pending content");

        let (cancel_temp, mut cancel_file) = create_upload_temp(&changed.sftp, "/cancel-target").await.unwrap();
        cancel_file.write_all(b"new data").await.unwrap();
        cancel_file.shutdown().await.unwrap();
        let cancelled = AtomicBool::new(true);
        assert_eq!(commit_upload_unless_cancelled(&changed.sftp, &cancel_temp, "/existing", &cancelled).await.unwrap_err(), "传输已取消");
        cleanup_upload_temp(&changed.sftp, &cancel_temp).await;
        assert!(changed.sftp.open(&cancel_temp).await.is_err(), "cancelled upload staging file must be removed");
        let mut original = changed.sftp.open("/existing").await.unwrap();
        bytes.clear();
        original.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"replacement", "cancellation before commit must not replace the target");
        write_file(&config, password, "/existing", b"saved by editor".to_vec()).await.unwrap();
        let mut saved = changed.sftp.open("/existing").await.unwrap();
        bytes.clear();
        saved.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"saved by editor", "online editor must replace an existing file through the real entry point");
        assert_eq!(changed.sftp.symlink_metadata("/existing").await.unwrap().permissions, Some(0o755));

        let (new_temp, mut new_file) = create_upload_temp(&changed.sftp, "/brand-new").await.unwrap();
        new_file.write_all(b"new file").await.unwrap();
        new_file.shutdown().await.unwrap();
        commit_upload(&changed.sftp, &new_temp, "/brand-new").await.unwrap();
        assert_eq!(changed.sftp.symlink_metadata("/brand-new").await.unwrap().permissions, Some(0o600));

        { let _failed_transfer = TransferSessionGuard::new(&config.id, &changed); }
        assert!(cached_session(pool(), &config.id).is_none(), "failed transfer must evict its session");
        safe_lock(pool()).insert(config.id.clone(), changed.clone());
        {
            let mut successful_transfer = TransferSessionGuard::new(&config.id, &changed);
            successful_transfer.succeed();
        }
        assert!(cached_session(pool(), &config.id).is_some(), "successful transfer must preserve reuse");
        invalidate(&config.id);
        let _ = changed.sftp.close().await;
        let _ = replacement.sftp.close().await;
    }).await;
    server.abort();
    invalidate(&config.id);
    result.expect("SFTP reconnect/config-change must finish without deadlocking");
}
