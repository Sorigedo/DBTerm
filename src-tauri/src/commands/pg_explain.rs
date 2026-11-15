use sqlx::{Connection, Row};
use super::pg_admin::PgExplainResult;

/// Execute the original statement at most once. READ ONLY prevents persistent
/// table/sequence writes, but is not a sandbox for externally effectful routines.
pub(super) async fn run(conn:&mut sqlx::PgConnection,sql:&str,analyze:bool)->Result<PgExplainResult,String>{
    run_with_timeout(conn,sql,analyze,30_000).await
}

async fn run_with_timeout(conn:&mut sqlx::PgConnection,sql:&str,analyze:bool,timeout_ms:u64)->Result<PgExplainResult,String>{
    let timeout_ms=i64::try_from(timeout_ms).ok().filter(|v|*v>0&&*v<=300_000)
        .ok_or_else(||"分析超时必须在 1 至 300000 毫秒之间".to_string())?;
    let prefix=if analyze { "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" } else { "EXPLAIN (FORMAT JSON)" };
    let mut tx=conn.begin().await.map_err(|e|format!("开启分析事务失败: {e}"))?;
    let result=async {
        sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await
            .map_err(|e|format!("设置只读分析事务失败: {e}"))?;
        // pg_settings exposes statement_timeout in milliseconds. A local setting
        // expires on rollback and may only shorten an existing nonzero limit.
        sqlx::query("SELECT set_config('statement_timeout', LEAST(COALESCE(NULLIF(setting::bigint,0),$1),$1)::text, true) FROM pg_settings WHERE name='statement_timeout'")
            .bind(timeout_ms).execute(&mut *tx).await
            .map_err(|e|format!("设置分析超时失败: {e}"))?;
        let row=sqlx::query(&format!("{prefix} {sql}")).fetch_one(&mut *tx).await
            .map_err(|e|if e.as_database_error().and_then(|error|error.code()).as_deref()==Some("57014"){
                format!("执行计划分析超时或被服务端取消，已停止本次分析: {e}")
            }else{format!("EXPLAIN 执行失败: {e}")})?;
        let plan:serde_json::Value=row.try_get(0).map_err(|e|format!("读取执行计划失败: {e}"))?;
        if plan.as_array().and_then(|items|items.first()).and_then(|item|item.get("Plan")).is_none(){
            return Err("服务端未返回有效执行计划".into());
        }
        let planning_time_ms=plan[0]["Planning Time"].as_f64().unwrap_or(0.0);
        let execution_time_ms=plan[0]["Execution Time"].as_f64().unwrap_or(0.0);
        let plan_json=serde_json::to_string(&plan).map_err(|e|format!("编码执行计划失败: {e}"))?;
        // Present the same measured plan; never execute ANALYZE a second time
        // merely to request PostgreSQL's alternative text serialization.
        let plan_text=serde_json::to_string_pretty(&plan).map_err(|e|format!("格式化执行计划失败: {e}"))?;
        Ok(PgExplainResult{plan_json,plan_text,planning_time_ms,execution_time_ms})
    }.await;
    // Report rollback failures rather than claim that transaction cleanup worked.
    tx.rollback().await.map_err(|e|format!("分析事务回滚未确认: {e}；请核查数据库状态"))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn verified_fixture() -> sqlx::PgConnection {
        let port: u16 = std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
        let expected = std::env::var("DBTERM_TEST_PG_DATA_DIR").expect("explicit disposable data directory required");
        let expected = std::path::Path::new(&expected).canonicalize().unwrap();
        assert!(expected.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("dbterm-isolated-databases-"));
        let mut connection = sqlx::PgConnection::connect(&format!("postgres://postgres@127.0.0.1:{port}/postgres")).await.unwrap();
        let actual: String = sqlx::query_scalar("SHOW data_directory").fetch_one(&mut connection).await.unwrap();
        assert_eq!(std::path::Path::new(&actual).canonicalize().unwrap(), expected, "refuse a server not created by the isolated runner");
        connection
    }

    #[tokio::test]
    #[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
    async fn postgres_explain_timeout_stops_backend_and_restores_session_settings() {
        let mut conn=verified_fixture().await;
        sqlx::query("SET statement_timeout=0").execute(&mut conn).await.unwrap();
        let started=std::time::Instant::now();
        let result=run_with_timeout(&mut conn,"SELECT pg_sleep(0.4)",true,40).await;
        assert!(result.is_err(),"analysis must enforce its server-side time budget");
        assert!(started.elapsed()<std::time::Duration::from_millis(300));
        let timeout:String=sqlx::query_scalar("SHOW statement_timeout").fetch_one(&mut conn).await.unwrap();
        assert_eq!(timeout,"0","local analysis settings must not leak into later queries");
        sqlx::query("SET statement_timeout='20ms'").execute(&mut conn).await.unwrap();
        assert!(run_with_timeout(&mut conn,"SELECT pg_sleep(0.1)",true,1000).await.is_err(),"analysis must preserve a stricter existing session budget");
        let timeout:String=sqlx::query_scalar("SHOW statement_timeout").fetch_one(&mut conn).await.unwrap();
        assert_eq!(timeout,"20ms");
    }

    #[tokio::test]
    #[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
    async fn postgres_explain_timeout_also_bounds_lock_waits() {
        let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
        let url=format!("postgres://postgres@127.0.0.1:{port}/postgres");
        let mut conn=verified_fixture().await;
        let mut locker=sqlx::PgConnection::connect(&url).await.unwrap();
        let name=format!("explain_lock_{}",uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE TABLE {name}(id INT)")).execute(&mut conn).await.unwrap();
        sqlx::query("BEGIN").execute(&mut locker).await.unwrap();
        sqlx::query(&format!("LOCK TABLE {name} IN ACCESS EXCLUSIVE MODE")).execute(&mut locker).await.unwrap();
        let result=run_with_timeout(&mut conn,&format!("SELECT * FROM {name}"),false,40).await;
        sqlx::query("ROLLBACK").execute(&mut locker).await.unwrap();
        sqlx::query(&format!("DROP TABLE {name}")).execute(&mut conn).await.unwrap();
        assert!(result.unwrap_err().contains("超时或被服务端取消"));
        assert!(run(&mut conn,"SELECT 1",false).await.is_ok());
    }

    #[tokio::test]
    #[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
    async fn postgres_explain_analyze_refuses_persistent_sequence_side_effects() {
        let mut conn=verified_fixture().await;
        let name=format!("explain_{}",uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SEQUENCE {name}")).execute(&mut conn).await.unwrap();
        let result=run(&mut conn,&format!("SELECT nextval('{name}')"),true).await;
        let called:bool=sqlx::query_scalar(&format!("SELECT is_called FROM {name}")).fetch_one(&mut conn).await.unwrap();
        sqlx::query(&format!("DROP SEQUENCE {name}")).execute(&mut conn).await.unwrap();
        assert!(result.is_err(),"ANALYZE must refuse persistent sequence writes");
        assert!(!called,"ROLLBACK must not be mistaken for undoing nextval");
    }

    #[tokio::test]
    #[ignore = "requires disposable DBTERM_TEST_PG_PORT"]
    async fn postgres_explain_analyze_executes_query_once_and_recovers_from_failure() {
        let mut conn=verified_fixture().await;
        // A private temporary sequence is writable in a read-only transaction;
        // its counter detects duplicate execution without persistent side effects.
        sqlx::query("CREATE TEMP SEQUENCE explain_counter").execute(&mut conn).await.unwrap();
        let plan=run(&mut conn,"SELECT nextval('pg_temp.explain_counter')",true).await.unwrap();
        let value:i64=sqlx::query_scalar("SELECT last_value FROM pg_temp.explain_counter").fetch_one(&mut conn).await.unwrap();
        assert_eq!(value,1,"rendering text must not execute the query a second time");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&plan.plan_json).unwrap(),serde_json::from_str::<serde_json::Value>(&plan.plan_text).unwrap());
        sqlx::query("CREATE TEMP TABLE explain_target(id INT)").execute(&mut conn).await.unwrap();
        assert!(run(&mut conn,"WITH changed AS (INSERT INTO explain_target VALUES(1) RETURNING id) SELECT * FROM changed",true).await.is_ok());
        // Persistent table writes through a CTE must fail in the read-only transaction.
        let name=format!("explain_{}",uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE TABLE {name}(id INT)")).execute(&mut conn).await.unwrap();
        let result=run(&mut conn,&format!("WITH changed AS (INSERT INTO {name} VALUES(1) RETURNING id) SELECT * FROM changed"),true).await;
        let count:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM {name}")).fetch_one(&mut conn).await.unwrap();
        sqlx::query(&format!("DROP TABLE {name}")).execute(&mut conn).await.unwrap();
        assert!(result.is_err());assert_eq!(count,0);
        assert!(run(&mut conn,"SELECT 1/0",true).await.is_err());
        assert!(run(&mut conn,"SELECT 42",false).await.is_ok(),"failed analysis must leave its connection outside the failed transaction");
    }
}
