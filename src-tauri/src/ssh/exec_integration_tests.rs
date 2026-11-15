//! Ephemeral loopback SSH and disposable local-file command tests only; no saved credentials.
use super::*;
use russh::{server::{Auth, Session}, Channel, ChannelId};

#[tokio::test]
async fn upload_source_hash_uses_bounded_reads() {
    use std::{pin::Pin, task::{Context, Poll}};
    use sha2::{Digest, Sha256};
    struct ObservedReader { remaining: usize, max_request: usize }
    impl tokio::io::AsyncRead for ObservedReader {
        fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buffer: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
            self.max_request = self.max_request.max(buffer.remaining());
            let count = self.remaining.min(buffer.remaining());
            buffer.initialize_unfilled_to(count).fill(0x5a);
            buffer.advance(count); self.remaining -= count;
            Poll::Ready(Ok(()))
        }
    }
    let mut reader = ObservedReader { remaining: 2 * 1024 * 1024 + 1, max_request: 0 };
    let (length, digest) = upload_source_digest(&mut reader).await.unwrap();
    assert_eq!(length, 2 * 1024 * 1024 + 1);
    assert_eq!(digest, format!("{:x}", Sha256::digest(vec![0x5a; length as usize])));
    assert!(reader.max_request <= 48 * 1024, "whole-file read grew to {} bytes", reader.max_request);
}

#[cfg(unix)]
#[test]
fn local_fallback_upload_failure_preserves_original_file() {
    use std::{io::Write, process::{Command, Stdio}};
    let root = std::env::temp_dir().join(format!("dbterm-upload-stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let target = root.join("original.txt");
    std::fs::write(&target, b"original complete bytes").unwrap();
    let command = fallback_upload_command(target.to_str().unwrap(), &[0; 100]).unwrap();
    let mut child = Command::new("sh").args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    // Valid base64 prefix, interrupted before expected file length.
    child.stdin.take().unwrap().write_all(b"cGFydGlhbA==").unwrap();
    let result = child.wait_with_output().unwrap();
    let actual = std::fs::read(&target).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(actual, b"original complete bytes", "interrupted upload changed original; stderr={}", String::from_utf8_lossy(&result.stderr));
    assert!(!result.status.success());
}

#[cfg(unix)]
#[test]
fn local_fallback_upload_validates_integrity_and_preserves_metadata() {
    use std::{io::Write, process::{Command, Stdio}, os::unix::fs::{PermissionsExt, symlink}};
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = std::env::temp_dir().join(format!("dbterm-upload-integrity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let target = root.join("file with 'quote'.bin");
    let run = |path: &std::path::Path, expected: &[u8], encoded: &[u8], no_python: bool| {
        let command = fallback_upload_command(path.to_str().unwrap(), expected).unwrap();
        let mut process = Command::new("/bin/sh");
        process.args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        if no_python { process.env("PATH", "/dbterm-missing-test-only"); }
        let mut child = process.spawn().unwrap();
        let _ = child.stdin.take().unwrap().write_all(encoded);
        child.wait_with_output().unwrap()
    };
    std::fs::write(&target, b"original").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let payload = (0..100_001).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    let encoded = STANDARD.encode(&payload);
    let result = run(&target, &payload, encoded.as_bytes(), false);
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(std::fs::read(&target).unwrap(), payload);
    assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777, 0o640);
    for (input, missing_runtime) in [(STANDARD.encode(vec![1; payload.len()]), false), ("!!!!".into(), false), (encoded, true)] {
        let result = run(&target, &payload, input.as_bytes(), missing_runtime);
        assert!(!result.status.success());
        assert_eq!(std::fs::read(&target).unwrap(), payload);
    }
    let link = root.join("link"); symlink(&target, &link).unwrap();
    assert!(!run(&link, b"new", b"bmV3", false).status.success());
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(&target).unwrap(), payload);
    let fresh = root.join("fresh");
    assert!(!run(&fresh, b"expected", b"", false).status.success());
    assert!(!fresh.exists());
    assert!(run(&fresh, b"", b"", false).status.success());
    assert_eq!(std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 3, "staging file leaked");
    std::fs::remove_dir_all(root).unwrap();
}

struct ExecServer;

// Executes only exact allowlisted production commands targeting a UUID test
// directory. Never accepts a user host, saved connection or arbitrary command.
struct FileUploadServer {
    commands: Arc<Vec<String>>,
    child: Option<tokio::process::Child>,
}

impl russh::server::Handler for FileUploadServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        assert_eq!((user, password), ("audit", "local-test-only")); Ok(Auth::Accept)
    }
    async fn channel_open_session(&mut self, _: Channel<russh::server::Msg>, reply: russh::server::ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> { reply.accept().await; Ok(()) }
    async fn exec_request(&mut self, id: ChannelId, command: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let command = std::str::from_utf8(command).unwrap();
        assert!(self.commands.iter().any(|allowed| allowed == command), "unapproved test command");
        self.child = Some(tokio::process::Command::new("/bin/sh").args(["-c", command])
            .env_clear().env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap());
        session.channel_success(id); Ok(())
    }
    async fn data(&mut self, _: ChannelId, data: &[u8], _: &mut Session) -> Result<(), Self::Error> {
        use tokio::io::AsyncWriteExt;
        self.child.as_mut().unwrap().stdin.as_mut().unwrap().write_all(data).await.unwrap();
        Ok(())
    }
    async fn channel_eof(&mut self, id: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        let mut child = self.child.take().unwrap();
        drop(child.stdin.take());
        let result = child.wait_with_output().await.unwrap();
        if !result.stderr.is_empty() { session.extended_data(id, 1, result.stderr); }
        session.exit_status_request(id, result.status.code().unwrap_or(255) as u32);
        session.eof(id); session.close(id); Ok(())
    }
}

#[tokio::test]
async fn loopback_upload_real_staging_preserves_target_on_changed_source() {
    let root = std::env::temp_dir().join(format!("dbterm-upload-wire-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&root).await.unwrap();
    let source = root.join("source.bin");
    let target = root.join("target.bin");
    let payload = (0..1_000_001).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    tokio::fs::write(&source, &payload).await.unwrap();
    tokio::fs::write(&target, b"original").await.unwrap();
    let command = fallback_upload_command(target.to_str().unwrap(), &payload).unwrap();
    let allowed = Arc::new(vec![command.clone()]);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],
        auth_rejection_time: std::time::Duration::ZERO, ..Default::default()
    });
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone(); let commands = allowed.clone();
            tokio::spawn(async move {
                if let Ok(session) = russh::server::run_stream(config, socket, FileUploadServer { commands, child: None }).await { let _ = session.await; }
            });
        }
    });
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":format!("local-wire-{port}"),"name":"isolated","type":"ssh","host":"127.0.0.1",
        "port":port,"username":"audit","useSsl":false,"createdAt":0,"updatedAt":0,
        "extraJson":serde_json::json!({"hostKeyPolicy":"skip","authType":"password","heartbeatInterval":0,
            "proxyPassword":"unused-test-only","jumpPassword":"unused-test-only"}).to_string()
    })).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let started = std::time::Instant::now();
        upload_path(&config, Some("local-test-only"), target.to_str().unwrap(), &source).await.unwrap();
        eprintln!("local SSH upload normal elapsed={:?}", started.elapsed());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        // Same length, different contents between digest preparation and sending.
        let changed = vec![0x7f; payload.len()]; let mut reader = changed.as_slice();
        let error = upload_reader(&config, Some("local-test-only"), &mut reader, command.clone(), std::time::Duration::from_secs(2)).await.unwrap_err();
        eprintln!("local SSH upload changed elapsed={:?}, result={error}", started.elapsed());
        assert!(error.contains("退出码"), "{error}");
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        // Early EOF after a valid prefix must also leave the complete target.
        let mut truncated = &payload[..100];
        assert!(upload_reader(&config, Some("local-test-only"), &mut truncated, command, std::time::Duration::from_secs(2)).await.is_err());
        assert_eq!(tokio::fs::read(&target).await.unwrap(), payload);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    }).await;
    server.abort(); tokio::fs::remove_dir_all(&root).await.unwrap(); outcome.unwrap();
}
impl russh::server::Handler for ExecServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth,Self::Error> {
        assert_eq!((user,password),("audit","local-test-only")); Ok(Auth::Accept)
    }
    async fn channel_open_session(&mut self, _: Channel<russh::server::Msg>, reply: russh::server::ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> { reply.accept().await; Ok(()) }
    async fn exec_request(&mut self,id:ChannelId,command:&[u8],session:&mut Session)->Result<(),Self::Error>{
        session.channel_success(id);
        if command == b"no-response" { return Ok(()); }
        if command == b"large-output" {
            let handle = session.handle();
            tokio::spawn(async move {
                for _ in 0..1056 {
                    if handle.data(id, vec![b'x'; 32 * 1024]).await.is_err() { return; }
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                let _ = handle.exit_status_request(id,0).await;
                let _ = handle.eof(id).await;
                let _ = handle.close(id).await;
            });
            return Ok(());
        }
        session.data(id,b"operation output".to_vec());
        // EOF ends stdout; SSH permits the exit-status request to arrive afterward.
        session.eof(id);
        match command {
            b"success" => { session.exit_status_request(id,0)?; },
            b"failure" => { session.exit_status_request(id,7)?; },
            b"missing-status" => {},
            _ => panic!("unexpected simulated command"),
        }
        session.close(id); Ok(())
    }
}

struct SetupStallServer {
    auth_stall: bool,
    commands: Arc<std::sync::atomic::AtomicUsize>,
}

impl russh::server::Handler for SetupStallServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        assert_eq!((user, password), ("audit", "local-test-only"));
        if self.auth_stall { std::future::pending::<()>().await; }
        Ok(Auth::Accept)
    }
    async fn channel_open_session(&mut self, _: Channel<russh::server::Msg>, _: russh::server::ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> { std::future::pending::<()>().await; Ok(()) }
    async fn exec_request(&mut self, _: ChannelId, _: &[u8], _: &mut Session) -> Result<(), Self::Error> {
        self.commands.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

async fn assert_setup_stall_is_bounded(auth_stall: bool, upload: bool) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let commands = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = commands.clone();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let config = Arc::new(russh::server::Config {
            keys: vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],
            auth_rejection_time: std::time::Duration::ZERO,
            ..Default::default()
        });
        if let Ok(session) = russh::server::run_stream(config, socket, SetupStallServer { auth_stall, commands }).await {
            let _ = session.await;
        }
    });
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id": format!("local-setup-{port}"), "name": "isolated", "type": "ssh",
        "host": "127.0.0.1", "port": port, "username": "audit", "useSsl": false,
        "createdAt": 0, "updatedAt": 0,
        "extraJson": serde_json::json!({"hostKeyPolicy":"skip", "authType":"password",
            "connectTimeout":5, "heartbeatInterval":0,
            "proxyPassword":"unused-test-only", "jumpPassword":"unused-test-only"}).to_string()
    })).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(7), async {
        if upload {
            upload_bytes(&config, Some("local-test-only"), "/must-not-be-sent", b"isolated upload").await.map(|_| String::new())
        } else {
            exec_command(&config, Some("local-test-only"), "must-not-be-sent").await
        }
    }).await;
    server.abort();
    let error = outcome.expect("SSH setup must return within configured timeout instead of hanging")
        .expect_err("unconfirmed setup cannot report success");
    assert!(error.contains("超时"), "{error}");
    assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn loopback_exec_authentication_stall_is_bounded() { assert_setup_stall_is_bounded(true, false).await; }

#[tokio::test]
async fn loopback_exec_channel_open_stall_is_bounded() { assert_setup_stall_is_bounded(false, false).await; }

#[tokio::test]
async fn loopback_upload_authentication_stall_is_bounded() { assert_setup_stall_is_bounded(true, true).await; }

#[tokio::test]
async fn loopback_upload_channel_open_stall_is_bounded() { assert_setup_stall_is_bounded(false, true).await; }

#[derive(Default)]
struct UploadServer { command: Vec<u8>, input: Vec<u8> }

impl russh::server::Handler for UploadServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        assert_eq!((user, password), ("audit", "local-test-only")); Ok(Auth::Accept)
    }
    async fn channel_open_session(&mut self, _: Channel<russh::server::Msg>, reply: russh::server::ChannelOpenHandle, _: &mut Session) -> Result<(), Self::Error> { reply.accept().await; Ok(()) }
    async fn exec_request(&mut self, id: ChannelId, command: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        self.command = command.to_vec(); session.channel_success(id); Ok(())
    }
    async fn data(&mut self, _: ChannelId, data: &[u8], _: &mut Session) -> Result<(), Self::Error> {
        self.input.extend_from_slice(data); Ok(())
    }
    async fn channel_eof(&mut self, id: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(&self.command);
        if command.contains("/chunked") {
            use base64::{engine::general_purpose::STANDARD, Engine};
            assert_eq!(STANDARD.decode(&self.input).unwrap(), (0..100_001).map(|i| (i % 251) as u8).collect::<Vec<_>>());
        } else if command.contains("/empty") {
            assert!(self.input.is_empty());
        } else { assert_eq!(self.input, b"aXNvbGF0ZWQgdXBsb2Fk"); }
        if command.contains("/no-response") { return Ok(()); }
        session.eof(id);
        if command.contains("/success") || command.contains("/chunked") || command.contains("/empty") { session.exit_status_request(id, 0); }
        else if command.contains("/failure") { session.exit_status_request(id, 7); }
        else { assert!(command.contains("/missing-status")); }
        session.close(id); Ok(())
    }
}

#[tokio::test]
async fn loopback_upload_requires_confirmed_zero_status_after_stdout_eof() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],
        auth_rejection_time: std::time::Duration::ZERO, ..Default::default()
    });
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let cfg = server_config.clone();
            tokio::spawn(async move {
                if let Ok(session) = russh::server::run_stream(cfg, socket, UploadServer::default()).await { let _ = session.await; }
            });
        }
    });
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":format!("local-upload-{port}"),"name":"isolated","type":"ssh","host":"127.0.0.1",
        "port":port,"username":"audit","useSsl":false,"createdAt":0,"updatedAt":0,
        "extraJson":serde_json::json!({"hostKeyPolicy":"skip","authType":"password","heartbeatInterval":0,
            "proxyPassword":"unused-test-only","jumpPassword":"unused-test-only"}).to_string()
    })).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        upload_bytes(&config, Some("local-test-only"), "/success", b"isolated upload").await.unwrap();
        upload_bytes(&config, Some("local-test-only"), "/chunked", &(0..100_001).map(|i| (i % 251) as u8).collect::<Vec<_>>()).await.unwrap();
        let payload = (0..100_001).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let file = std::env::temp_dir().join(format!("dbterm-source-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&file, &payload).await.unwrap();
        let result = upload_path(&config, Some("local-test-only"), "/chunked", &file).await;
        tokio::fs::remove_file(&file).await.unwrap();
        result.unwrap();
        let command = fallback_upload_command("/chunked", &payload).unwrap();
        let (mut writer, mut reader) = tokio::io::duplex(17);
        let sending = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            writer.write_all(&payload).await.unwrap();
        });
        upload_reader(&config, Some("local-test-only"), &mut reader, command, std::time::Duration::from_secs(2)).await.unwrap();
        sending.await.unwrap();
        upload_bytes(&config, Some("local-test-only"), "/empty", b"").await.unwrap();
        let failed = upload_bytes(&config, Some("local-test-only"), "/failure", b"isolated upload").await;
        let missing = upload_bytes(&config, Some("local-test-only"), "/missing-status", b"isolated upload").await;
        assert!(failed.is_err() && missing.is_err(), "failure={failed:?}, missing={missing:?}");
        assert!(failed.unwrap_err().contains('7'));
        assert!(missing.unwrap_err().contains("未知"));
    }).await;
    server.abort(); outcome.unwrap();
}

#[tokio::test]
async fn loopback_upload_no_response_is_bounded() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],
        auth_rejection_time: std::time::Duration::ZERO, ..Default::default()
    });
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        if let Ok(session) = russh::server::run_stream(server_config, socket, UploadServer::default()).await { let _ = session.await; }
    });
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":format!("local-upload-idle-{port}"),"name":"isolated","type":"ssh","host":"127.0.0.1",
        "port":port,"username":"audit","useSsl":false,"createdAt":0,"updatedAt":0,
        "extraJson":serde_json::json!({"hostKeyPolicy":"skip","authType":"password","heartbeatInterval":0,
            "proxyPassword":"unused-test-only","jumpPassword":"unused-test-only"}).to_string()
    })).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        upload_bytes_with_idle_limit(&config, Some("local-test-only"), "/no-response", b"isolated upload", std::time::Duration::from_millis(50)).await
    }).await;
    server.abort();
    let error = outcome.expect("upload must not wait forever").unwrap_err();
    assert!(error.contains("未知") && error.contains("无响应"), "{error}");
}

#[tokio::test]
async fn loopback_exec_requires_confirmed_zero_status_after_stdout_eof(){
    let listener=tokio::net::TcpListener::bind(("127.0.0.1",0)).await.unwrap();
    let port=listener.local_addr().unwrap().port();
    let server_config=Arc::new(russh::server::Config{keys:vec![russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap()],auth_rejection_time:std::time::Duration::ZERO,..Default::default()});
    let server=tokio::spawn(async move{while let Ok((socket,_))=listener.accept().await{let cfg=server_config.clone();tokio::spawn(async move{if let Ok(session)=russh::server::run_stream(cfg,socket,ExecServer).await{let _=session.await;}});}});
    let config:ConnConfig=serde_json::from_value(serde_json::json!({"id":format!("local-exec-{port}"),"name":"isolated","type":"ssh","host":"127.0.0.1","port":port,"username":"audit","useSsl":false,"createdAt":0,"updatedAt":0,
        "extraJson":serde_json::json!({"hostKeyPolicy":"skip","authType":"password","heartbeatInterval":0,"proxyPassword":"unused-test-only","jumpPassword":"unused-test-only"}).to_string()})).unwrap();
    let outcome=tokio::time::timeout(std::time::Duration::from_secs(10),async{
        assert_eq!(exec_command(&config,Some("local-test-only"),"success").await.unwrap(),"operation output");
        let error=exec_command(&config,Some("local-test-only"),"failure").await.expect_err("nonzero SSH command must not report success");
        assert!(error.contains('7')&&error.contains("operation output"),"{error}");
        let error=exec_command(&config,Some("local-test-only"),"missing-status").await.expect_err("missing status must not report success");
        assert!(error.contains("未确认"),"{error}");
        let result=exec_command(&config,Some("local-test-only"),"large-output").await;
        assert!(result.is_err(),"output exceeding 32MiB must fail explicitly instead of retaining unlimited data");
        assert!(result.unwrap_err().contains("输出"));
        let error=exec_command_with_idle_limit(&config,Some("local-test-only"),"no-response",std::time::Duration::from_millis(50)).await.unwrap_err();
        assert!(error.contains("无响应") && error.contains("结果未知"),"{error}");
    }).await;
    server.abort();outcome.unwrap();
}
