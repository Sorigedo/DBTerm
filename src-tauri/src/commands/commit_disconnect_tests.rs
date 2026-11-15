use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn packet_after_first(stream: &mut TcpStream, first: u8) -> Vec<u8> {
    let mut header = [first, 0, 0, 0];
    stream.read_exact(&mut header[1..]).await.unwrap();
    let length = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
    assert!(length < 1024 * 1024, "acceptance fixture packet exceeded budget");
    let mut packet = header.to_vec();
    packet.resize(4 + length, 0);
    stream.read_exact(&mut packet[4..]).await.unwrap();
    packet
}

// Local plaintext test transport only. No production connector changes.
async fn drop_at_commit(listener: TcpListener, upstream_port: u16, forward_commit: bool) {
    let (mut client, _) = listener.accept().await.unwrap();
    let mut server = TcpStream::connect(("127.0.0.1", upstream_port)).await.unwrap();
    loop {
        tokio::select! {
            first = client.read_u8() => {
                let packet = packet_after_first(&mut client, first.expect("client ended before COMMIT")).await;
                let commit = packet.get(4) == Some(&3)
                    && String::from_utf8_lossy(&packet[5..]).trim().eq_ignore_ascii_case("COMMIT");
                if commit {
                    if forward_commit {
                        server.write_all(&packet).await.unwrap();
                        let first = server.read_u8().await.unwrap();
                        let response = packet_after_first(&mut server, first).await;
                        assert_eq!(response.get(4), Some(&0), "server must actually confirm successful COMMIT before reply is discarded");
                    }
                    // Drop both sockets: before server receives COMMIT, or after it
                    // confirms COMMIT but before application receives its OK.
                    return;
                }
                server.write_all(&packet).await.unwrap();
            }
            first = server.read_u8() => {
                let packet = packet_after_first(&mut server, first.expect("server ended before COMMIT")).await;
                client.write_all(&packet).await.unwrap();
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires explicitly selected disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn real_mysql_commit_disconnect_reports_unknown_and_observer_checks_both_outcomes() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").expect("disposable port required").parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"commit-disconnect","name":"disposable","type":"mysql","host":"127.0.0.1",
        "port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0
    })).unwrap();
    let (mut observer, _) = mysql_connect(&config, None).await.unwrap();
    let db = format!("dbterm_commit_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE `{db}`")).execute(&mut observer).await.unwrap();
    sqlx::query(&format!("CREATE TABLE `{db}`.t(id int PRIMARY KEY,v varchar(24)) ENGINE=InnoDB")).execute(&mut observer).await.unwrap();
    sqlx::query(&format!("INSERT INTO `{db}`.t VALUES (1,'old-a'),(2,'old-b')")).execute(&mut observer).await.unwrap();
    for forward_commit in [false, true] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let proxy = tokio::spawn(drop_at_commit(listener, port, forward_commit));
        let mut proxied = config.clone();
        proxied.port = Some(proxy_port);
        let changes = [("1","old-a","new-a"),("2","old-b","new-b")].map(|(id,old,new)| CellRowUpdate {
            columns: vec!["v".into()], values: vec![Some(new.into())], pk_columns: vec!["id".into()],
            pk_values: vec![Some(id.into())], expected_values: Some(vec![Some(old.into())]),
        });
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(15),
            mysql_update_cells(&proxied, None, &db, "t", &changes)).await.expect("fault must not hang application");
        proxy.await.unwrap();
        let error = outcome.expect_err("lost COMMIT acknowledgement must never report success");
        assert!(error.contains("提交未得到成功确认") && error.contains("勿重复写入"), "{error}");
        assert!(!error.contains("已回滚"), "must not invent rollback confirmation: {error}");
        let expected = if forward_commit { vec!["new-a","new-b"] } else { vec!["old-a","old-b"] };
        let mut actual = Vec::<String>::new();
        for _ in 0..50 {
            actual = sqlx::query_scalar(&format!("SELECT v FROM `{db}`.t ORDER BY id")).fetch_all(&mut observer).await.unwrap();
            if actual == expected { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(actual, expected, "batch must be wholly old or wholly committed for selected fault point");
    }
    sqlx::query(&format!("DROP DATABASE `{db}`")).execute(&mut observer).await.unwrap();
}

pub(crate) async fn assert_mysql_batch_commit_faults<F, Fut>(insert: bool, operation: F)
where F: Fn(ConnConfig, String) -> Fut, Fut: std::future::Future<Output = Result<u64, String>> {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").expect("disposable port required").parse().unwrap();
    let config: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"batch-commit-disconnect","name":"disposable","type":"mysql","host":"127.0.0.1",
        "port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0
    })).unwrap();
    let (mut observer, _) = mysql_connect(&config, None).await.unwrap();
    let db = format!("dbterm_batch_commit_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE `{db}`")).execute(&mut observer).await.unwrap();
    sqlx::query(&format!("CREATE TABLE `{db}`.t(id int PRIMARY KEY,v varchar(24)) ENGINE=InnoDB")).execute(&mut observer).await.unwrap();
    for forward_commit in [false, true] {
        sqlx::query(&format!("DELETE FROM `{db}`.t")).execute(&mut observer).await.unwrap();
        if !insert { sqlx::query(&format!("INSERT INTO `{db}`.t VALUES(1,'a'),(2,'b')")).execute(&mut observer).await.unwrap(); }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let mut proxied = config.clone();
        proxied.port = Some(listener.local_addr().unwrap().port());
        let proxy = tokio::spawn(drop_at_commit(listener, port, forward_commit));
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), operation(proxied, db.clone())).await.expect("fault must terminate promptly");
        proxy.await.unwrap();
        let error = outcome.expect_err("lost commit acknowledgement must not report success");
        assert!(error.contains("提交未获确认") && error.contains("禁止自动重试"), "{error}");
        assert!(!error.contains("已回滚"), "unconfirmed commit must not claim rollback: {error}");
        let expected: Vec<(i32,String)> = if insert == forward_commit { vec![(1,"a".into()),(2,"b".into())] } else { vec![] };
        let actual: Vec<(i32,String)> = sqlx::query_as(&format!("SELECT id,v FROM `{db}`.t ORDER BY id")).fetch_all(&mut observer).await.unwrap();
        assert_eq!(actual, expected, "independent observer must see complete batch outcome, no partial write");
    }
    sqlx::query(&format!("DROP DATABASE `{db}`")).execute(&mut observer).await.unwrap();
}
