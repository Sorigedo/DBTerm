use super::*;
#[tokio::test]
#[ignore="requires disposable DBTERM_TEST_PG_PORT"]
async fn postgres_failed_transaction_commit_is_never_reported_success(){
 use sqlx::Connection;
 let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();let url=format!("postgres://postgres@127.0.0.1:{port}/postgres");
 let mut conn=sqlx::PgConnection::connect(&url).await.unwrap();sqlx::query("CREATE TEMP TABLE t(id INT PRIMARY KEY)").execute(&mut conn).await.unwrap();sqlx::query("BEGIN").execute(&mut conn).await.unwrap();
 run_on_pg(&mut conn,"INSERT INTO t VALUES(1)").await.unwrap();assert!(run_on_pg(&mut conn,"INSERT INTO t VALUES(1)").await.is_err());
 let state:TxState=Arc::new(AsyncMutex::new(HashMap::new()));let now=Instant::now();let active=Arc::new(AsyncMutex::new(ActiveTx{conn:TxConn::Pg(conn),started_at:now,last_used:now,read_only:false,_tunnel_guard:None}));state.lock().await.insert("failed-pg".into(),active.clone());
 let result=finish_transaction("failed-pg",&state,&OracleTxPool::new(),true).await;
 assert!(!state.lock().await.contains_key("failed-pg"));let mut guard=active.lock().await;let TxConn::Pg(conn)=&mut guard.conn else{panic!("PG expected")};let count:i64=sqlx::query_scalar("SELECT count(*) FROM t").fetch_one(conn).await.unwrap();assert_eq!(count,0);
 let error=result.expect_err("COMMIT on aborted PG transaction actually rolled back; must not report success");assert!(error.contains("已回滚"),"{error}");assert!(!error.contains("结果不确定"),"confirmed rollback is not uncertain: {error}");
}
#[tokio::test]
#[ignore="requires disposable DBTERM_TEST_PG_PORT"]
async fn postgres_commit_and_recovered_savepoint_keep_successful_changes(){
 use sqlx::Connection;
 let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();let url=format!("postgres://postgres@127.0.0.1:{port}/postgres");let mut conn=sqlx::PgConnection::connect(&url).await.unwrap();
 sqlx::query("CREATE TEMP TABLE t(id INT PRIMARY KEY)").execute(&mut conn).await.unwrap();
 for recovered in [false,true]{
  sqlx::query("BEGIN").execute(&mut conn).await.unwrap();let id=if recovered{2}else{1};sqlx::query("INSERT INTO t VALUES($1)").bind(id).execute(&mut conn).await.unwrap();
  if recovered{sqlx::query("SAVEPOINT s").execute(&mut conn).await.unwrap();assert!(sqlx::query("INSERT INTO t VALUES(2)").execute(&mut conn).await.is_err());sqlx::query("ROLLBACK TO SAVEPOINT s").execute(&mut conn).await.unwrap();}
  assert!(matches!(finish_pg_transaction(&mut conn,true).await.unwrap(),PgFinishOutcome::Finished));
 }
 sqlx::query("BEGIN").execute(&mut conn).await.unwrap();sqlx::query("INSERT INTO t VALUES(3)").execute(&mut conn).await.unwrap();assert!(matches!(finish_pg_transaction(&mut conn,false).await.unwrap(),PgFinishOutcome::Finished));
 let ids:Vec<i32>=sqlx::query_scalar("SELECT id FROM t ORDER BY id").fetch_all(&mut conn).await.unwrap();assert_eq!(ids,vec![1,2]);
}
#[tokio::test]
#[ignore="requires disposable DBTERM_TEST_PG_PORT"]
async fn postgres_deferred_failure_and_disconnect_never_return_success(){
 use sqlx::Connection;
 let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();let url=format!("postgres://postgres@127.0.0.1:{port}/postgres");let mut conn=sqlx::PgConnection::connect(&url).await.unwrap();
 sqlx::query("CREATE TEMP TABLE t(id INT UNIQUE DEFERRABLE INITIALLY DEFERRED)").execute(&mut conn).await.unwrap();sqlx::query("BEGIN").execute(&mut conn).await.unwrap();sqlx::query("INSERT INTO t VALUES(1),(1)").execute(&mut conn).await.unwrap();assert!(finish_pg_transaction(&mut conn,true).await.is_err());let count:i64=sqlx::query_scalar("SELECT count(*) FROM t").fetch_one(&mut conn).await.unwrap();assert_eq!(count,0);
 sqlx::query("BEGIN").execute(&mut conn).await.unwrap();sqlx::query("INSERT INTO t VALUES(2)").execute(&mut conn).await.unwrap();let pid:i32=sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut conn).await.unwrap();let mut admin=sqlx::PgConnection::connect(&url).await.unwrap();let terminated:bool=sqlx::query_scalar("SELECT pg_terminate_backend($1)").bind(pid).fetch_one(&mut admin).await.unwrap();assert!(terminated);assert!(finish_pg_transaction(&mut conn,true).await.is_err());
}
