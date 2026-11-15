//! Local plaintext acceptance transport, excluded from production builds.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn packet(stream: &mut TcpStream, first: u8) -> Vec<u8> {
    let mut header = [first, 0, 0, 0];
    stream.read_exact(&mut header[1..]).await.unwrap();
    let len = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
    assert!(len < 1024 * 1024);
    let mut bytes = header.to_vec();
    bytes.resize(4 + len, 0);
    stream.read_exact(&mut bytes[4..]).await.unwrap();
    bytes
}

async fn disconnect_at_rename(listener: TcpListener, upstream: u16, forward: bool) {
    let (mut client, _) = listener.accept().await.unwrap();
    let mut server = TcpStream::connect(("127.0.0.1", upstream)).await.unwrap();
    let mut rename_statement = None;
    loop {
        tokio::select! {
            first = client.read_u8() => {
                let bytes = packet(&mut client, first.expect("client ended before RENAME")).await;
                let command = bytes.get(4).copied();
                let rename_sql = matches!(command, Some(3 | 22)) && String::from_utf8_lossy(&bytes[5..])
                    .trim_start_matches("/* DBTerm */").trim_start().starts_with("RENAME TABLE ");
                if command == Some(22) && rename_sql {
                    server.write_all(&bytes).await.unwrap();
                    let first = server.read_u8().await.unwrap();
                    let response = packet(&mut server, first).await;
                    assert_eq!(response.get(4), Some(&0), "RENAME prepare must succeed");
                    assert!(response.len() >= 9);
                    rename_statement = Some(u32::from_le_bytes(response[5..9].try_into().unwrap()));
                    client.write_all(&response).await.unwrap();
                    continue;
                }
                let execute = command == Some(23) && bytes.len() >= 9 &&
                    rename_statement == Some(u32::from_le_bytes(bytes[5..9].try_into().unwrap()));
                if (command == Some(3) && rename_sql) || execute {
                    if forward {
                        server.write_all(&bytes).await.unwrap();
                        let first = server.read_u8().await.unwrap();
                        let response = packet(&mut server, first).await;
                        assert_eq!(response.get(4), Some(&0), "server must confirm RENAME before reply is discarded");
                    }
                    return;
                }
                server.write_all(&bytes).await.unwrap();
            }
            first = server.read_u8() => {
                let bytes = packet(&mut server, first.expect("server ended before RENAME")).await;
                client.write_all(&bytes).await.unwrap();
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires explicitly disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn real_mysql_publish_disconnect_preserves_complete_old_or_new_and_recovery_tables() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").expect("disposable port required").parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({"id":"publish-disconnect","name":"disposable",
        "type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut observer, _) = mysql_connect(&config, None).await.unwrap();
    let db = format!("dbterm_rename_fault_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {} DEFAULT CHARSET=latin1", q_mysql(&db))).execute(&mut observer).await.unwrap();
    let source_name = "mc_pos_settlement_company";
    let source = mysql_qualified(&db, source_name);
    let fixture = include_str!("fixtures/mc_pos_settlement_company.sql").trim_end();
    sqlx::query(&mysql_apply_ddl(fixture, source_name, &source).unwrap()).execute(&mut observer).await.unwrap();
    let raw = mysql_read_ddl(&mut observer, &source).await.unwrap();
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut observer).await.unwrap();
    for exists in [false, true] {
        for forward in [false, true] {
            let name = format!("target_{}_{}", exists as u8, forward as u8);
            let target = mysql_qualified(&db, &name);
            if exists {
                sqlx::query(&mysql_apply_ddl(&raw, source_name, &target).unwrap()).execute(&mut observer).await.unwrap();
                sqlx::query(&format!("INSERT INTO {target} (plan_code,plan_name) VALUES ('OLD','原目标')")).execute(&mut observer).await.unwrap();
            }
            let original = if exists { Some(mysql_read_ddl(&mut observer, &target).await.unwrap()) } else { None };
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let mut proxied = config.clone();
            proxied.port = Some(listener.local_addr().unwrap().port());
            let proxy = tokio::spawn(disconnect_at_rename(listener, port, forward));
            let mut setup = open_stream_dst(&proxied, None, &db, &name, "replace", true, false, false, true,
                &[], &[], false, "", &ConnType::Mysql, source_name, Some(&raw), Some(&mode)).await.unwrap().unwrap();
            if let StreamDst::My(conn, _) = &mut setup.dst {
                sqlx::query(&format!("INSERT INTO {} (id,plan_code,plan_name) VALUES (1,'NEW-A','新甲'),(2,'NEW-B','新乙')", setup.dst_q)).execute(conn).await.unwrap();
            } else { panic!("MySQL fixture required"); }
            let stage = setup.dst_q.clone();
            let publish = setup.publication.as_mut().unwrap();
            let backup = publish.backup_q.clone();
            publish.expected_rows = Some(2);
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), stream_finish(&mut setup, true, false)).await.expect("fault must terminate promptly");
            proxy.await.unwrap();
            let error = outcome.expect_err("lost publication acknowledgement must never report success");
            assert!(error.contains("发布未得到成功确认") && error.contains("禁止盲目重试或删除"), "{error}");
            assert!(error.contains(&target) && error.contains(&stage), "recovery names missing: {error}");
            if forward || exists {
                let codes: Vec<String> = sqlx::query_scalar(&format!("SELECT plan_code FROM {target} ORDER BY plan_code")).fetch_all(&mut observer).await.unwrap();
                assert_eq!(codes, if forward { vec!["NEW-A", "NEW-B"] } else { vec!["OLD"] });
                let actual = mysql_read_ddl(&mut observer, &target).await.unwrap();
                if !forward { assert_eq!(Some(actual), original); }
                else { assert_eq!(mysql_apply_ddl(&actual, &name, &stage).unwrap(), setup.publication.as_ref().unwrap().expected_ddl); }
            } else { assert!(mysql_read_ddl(&mut observer, &target).await.is_err()); }
            if forward { assert!(mysql_read_ddl(&mut observer, &stage).await.is_err()); }
            else {
                let codes: Vec<String> = sqlx::query_scalar(&format!("SELECT plan_code FROM {stage} ORDER BY plan_code")).fetch_all(&mut observer).await.unwrap();
                assert_eq!(codes, vec!["NEW-A", "NEW-B"], "committed stage must survive unknown publication");
            }
            if let Some(backup) = backup {
                assert!(error.contains(&backup));
                if forward {
                    let codes: Vec<String> = sqlx::query_scalar(&format!("SELECT plan_code FROM {backup} ORDER BY plan_code")).fetch_all(&mut observer).await.unwrap();
                    assert_eq!(codes, vec!["OLD"], "original target must survive as backup");
                } else { assert!(mysql_read_ddl(&mut observer, &backup).await.is_err()); }
            }
            assert_eq!(mysql_read_ddl(&mut observer, &source).await.unwrap(), raw);
            println!("publication fault accepted: existing_target={exists}, rename_reached_server={forward}");
        }
    }
    sqlx::query(&format!("DROP DATABASE {}", q_mysql(&db))).execute(&mut observer).await.unwrap();
}
