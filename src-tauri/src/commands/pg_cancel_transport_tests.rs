use sqlx::{Connection, PgConnection, postgres::{PgConnectOptions, PgSslMode}};
use std::{path::PathBuf, time::Duration};

static FIXTURE_LOCK:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop{fn drop(&mut self){self.0.abort();}}

fn fixture_options(mode:PgSslMode)->PgConnectOptions{
    let port:u16=std::env::var("DBTERM_TEST_PG_PORT").expect("explicit disposable PG port required").parse().unwrap();
    let cert=PathBuf::from(std::env::var("DBTERM_TEST_PG_TLS_ROOT").expect("explicit disposable TLS certificate required"));
    assert!(cert.is_absolute() && cert.is_file());
    PgConnectOptions::new().host("127.0.0.1").port(port).username("postgres").database("postgres").ssl_mode(mode).ssl_root_cert(cert)
}
async fn connect(mode:PgSslMode)->PgConnection{
    let mut connection=PgConnection::connect_with(&fixture_options(mode)).await.unwrap();
    let expected=PathBuf::from(std::env::var("DBTERM_TEST_PG_DATA_DIR").expect("explicit disposable data directory required")).canonicalize().unwrap();
    assert!(expected.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("dbterm-isolated-databases-"));
    let actual:String=sqlx::query_scalar("SHOW data_directory").fetch_one(&mut connection).await.unwrap();
    assert_eq!(PathBuf::from(actual).canonicalize().unwrap(),expected,"refuse SSL mutation outside isolated fixture");
    connection
}
fn certificate(name:&str)->PathBuf{PathBuf::from(std::env::var("DBTERM_TEST_PG_TLS_ROOT").unwrap()).parent().unwrap().join(name)}
async fn tls_enabled(conn:&mut PgConnection)->bool{sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()").fetch_one(conn).await.unwrap()}
async fn set_fixture_ssl(admin:&mut PgConnection,enabled:bool)->Result<(),sqlx::Error>{
    sqlx::query(if enabled{"ALTER SYSTEM SET ssl='on'"}else{"ALTER SYSTEM SET ssl='off'"}).execute(&mut *admin).await?;
    let _:bool=sqlx::query_scalar("SELECT pg_reload_conf()").fetch_one(&mut *admin).await?;
    for _ in 0..100{let state:String=sqlx::query_scalar("SHOW ssl").fetch_one(&mut *admin).await?;if state==if enabled{"on"}else{"off"}{return Ok(())}tokio::time::sleep(Duration::from_millis(10)).await;}
    Err(sqlx::Error::Protocol("fixture SSL reload timed out".into()))
}
async fn wait_sleep(admin:&mut PgConnection,pid:i32){
    for _ in 0..100{let running:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep%')").bind(pid).fetch_one(&mut *admin).await.unwrap();if running{return}tokio::time::sleep(Duration::from_millis(2)).await;}panic!("fixture sleep did not start");
}

#[tokio::test]
#[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
async fn postgres_cancel_prefer_must_not_downgrade_negotiated_tls(){
    let _guard=FIXTURE_LOCK.lock().await;
    let mut admin=connect(PgSslMode::Disable).await;
    let mut original=connect(PgSslMode::Prefer).await;assert!(tls_enabled(&mut original).await);let token=original.cancel_token();
    let disabled=set_fixture_ssl(&mut admin,false).await;
    let outcome=if disabled.is_ok(){Some(tokio::time::timeout(Duration::from_secs(2),token.cancel_query()).await)}else{None};
    // Restore before evaluating any expected result, including fixture failures.
    let restored=set_fixture_ssl(&mut admin,true).await;restored.unwrap();disabled.unwrap();
    assert!(matches!(outcome,Some(Ok(Err(_)))),"negotiated TLS cancellation must refuse plaintext fallback: {outcome:?}");
    assert!(tls_enabled(&mut original).await,"original encrypted connection remains open");
}

#[tokio::test]
#[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
async fn postgres_encrypted_cancel_reports_server_query_cancelled(){
    let _guard=FIXTURE_LOCK.lock().await;
    let mut admin=connect(PgSslMode::Disable).await;let mut original=connect(PgSslMode::Require).await;assert!(tls_enabled(&mut original).await);let pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut original).await.unwrap();let token=original.cancel_token();
    let query=tokio::spawn(async move{let result=sqlx::query("SELECT pg_sleep(30)").execute(&mut original).await;(result,original)});
    let _abort=AbortOnDrop(query.abort_handle());
    wait_sleep(&mut admin,pid).await;token.cancel_query().await.unwrap();
    let (result,mut original)=tokio::time::timeout(Duration::from_secs(2),query).await.unwrap().unwrap();let error=result.unwrap_err();assert_eq!(error.as_database_error().and_then(|e|e.code()).as_deref(),Some("57014"));
    let alive:i32=sqlx::query_scalar("SELECT 1").fetch_one(&mut original).await.unwrap();assert_eq!(alive,1);
}

#[tokio::test]
#[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
async fn postgres_cancel_capability_cannot_cancel_other_session(){
    let _guard=FIXTURE_LOCK.lock().await;
    let mut admin=connect(PgSslMode::Disable).await;let original_a=connect(PgSslMode::Require).await;let token_a=original_a.cancel_token();let mut original_b=connect(PgSslMode::Require).await;let pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut original_b).await.unwrap();
    let query_b=tokio::spawn(async move{sqlx::query("SELECT pg_sleep(0.2)").execute(&mut original_b).await});
    let _abort=AbortOnDrop(query_b.abort_handle());
    wait_sleep(&mut admin,pid).await;token_a.cancel_query().await.unwrap();assert!(tokio::time::timeout(Duration::from_secs(2),query_b).await.unwrap().unwrap().is_ok());drop(original_a);
}

#[tokio::test]
#[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
async fn postgres_verify_full_cancel_uses_trusted_certificate(){
    let _guard=FIXTURE_LOCK.lock().await;
    let mut original=connect(PgSslMode::VerifyFull).await;assert!(tls_enabled(&mut original).await);
    original.cancel_token().cancel_query().await.unwrap();
    let value:i32=sqlx::query_scalar("SELECT 1").fetch_one(&mut original).await.unwrap();assert_eq!(value,1);
    let wrong=fixture_options(PgSslMode::VerifyFull).ssl_root_cert(certificate("unrelated.crt"));
    assert!(PgConnection::connect_with(&wrong).await.is_err(),"unrelated CA must not establish a trusted session");
    let cert_path=certificate(&format!("token-ca-{}.crt",uuid::Uuid::new_v4().simple()));
    std::fs::copy(certificate("ca.crt"),&cert_path).unwrap();
    let options=fixture_options(PgSslMode::VerifyFull).ssl_root_cert(&cert_path);
    let mut changing=PgConnection::connect_with(&options).await.unwrap();let token=changing.cancel_token();
    std::fs::copy(certificate("unrelated.crt"),&cert_path).unwrap();
    let refused=token.cancel_query().await;std::fs::remove_file(&cert_path).unwrap();
    assert!(refused.is_err(),"cancellation must independently enforce trusted CA");
    let value:i32=sqlx::query_scalar("SELECT 1").fetch_one(&mut changing).await.unwrap();assert_eq!(value,1);
}

#[tokio::test]
#[ignore="requires dedicated PostgreSQL17 TLS fixture DBTERM_TEST_PG_TLS_ROOT"]
async fn postgres_expired_cancel_capability_cannot_cancel_replacement_session(){
    let _guard=FIXTURE_LOCK.lock().await;
    let mut admin=connect(PgSslMode::Disable).await;let original=connect(PgSslMode::Require).await;let expired=original.cancel_token();original.close().await.unwrap();
    let mut replacement=connect(PgSslMode::Require).await;let pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut replacement).await.unwrap();
    let query=tokio::spawn(async move{sqlx::query("SELECT pg_sleep(0.2)").execute(&mut replacement).await});
    let _abort=AbortOnDrop(query.abort_handle());
    wait_sleep(&mut admin,pid).await;expired.cancel_query().await.unwrap();assert!(tokio::time::timeout(Duration::from_secs(2),query).await.unwrap().unwrap().is_ok());
}
