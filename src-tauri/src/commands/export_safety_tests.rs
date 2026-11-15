use super::*;
use sqlx::Connection;

#[tokio::test]
async fn sqlite_dump_refuses_contentless_fts_instead_of_exporting_empty_search_index() {
    let root=std::env::temp_dir().join(format!("dbterm-export-contentless-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let path=root.join("source.db");std::fs::File::create(&path).unwrap();let cfg=config(&path);let mut conn=admin_conn(&cfg).await.unwrap();
    sqlx::raw_sql("CREATE VIRTUAL TABLE docs USING fts5(body,content=''); INSERT INTO docs(rowid,body) VALUES(1,'searchable');").execute(&mut conn).await.unwrap();conn.close().await.unwrap();
    let out=root.join("dump.sql");let result=dump_sql_with_config(&cfg,out.to_string_lossy().into_owned(),None).await;let published=out.exists();std::fs::remove_dir_all(root).unwrap();assert!(result.is_err(),"contentless token index cannot be reconstructed from NULL visible columns");assert!(!published);
}

#[tokio::test]
async fn sqlite_export_roundtrips_fts_rowids_sequence_and_exact_storage() {
    let root = std::env::temp_dir().join(format!("dbterm-export-types-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&root).unwrap();
    let path=root.join("source.db");std::fs::File::create(&path).unwrap(); let cfg=config(&path); let mut source=admin_conn(&cfg).await.unwrap();
    sqlx::raw_sql("CREATE TABLE data(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT,b BLOB,r REAL); INSERT INTO data VALUES(5,CAST(X'610062ff' AS TEXT),X'00ff',9e999); UPDATE sqlite_sequence SET seq=99; CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs(rowid,body) VALUES(41,'hello world'); CREATE TABLE docs_legitimate(v); INSERT INTO docs_legitimate VALUES(17);").execute(&mut source).await.unwrap();source.close().await.unwrap();
    let mut results=Vec::new();
    for rescue in [false,true] {
        let out=root.join(format!("{rescue}.sql")); if rescue {rescue_with_config(&cfg,out.to_string_lossy().into_owned()).await.unwrap();}else{dump_sql_with_config(&cfg,out.to_string_lossy().into_owned(),None).await.unwrap();}
        let mut dst=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();sqlx::raw_sql(&std::fs::read_to_string(out).unwrap()).execute(&mut dst).await.unwrap();
        let typed:(String,String,String)=sqlx::query_as("SELECT hex(v),hex(b),typeof(v) FROM data").fetch_one(&mut dst).await.unwrap();
        let fts:i64=sqlx::query_scalar("SELECT rowid FROM docs WHERE docs MATCH 'hello'").fetch_one(&mut dst).await.unwrap();
        let seq:i64=sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name='data'").fetch_one(&mut dst).await.unwrap();
        let ordinary:i64=sqlx::query_scalar("SELECT v FROM docs_legitimate").fetch_one(&mut dst).await.unwrap();
        let infinite:f64=sqlx::query_scalar("SELECT r FROM data").fetch_one(&mut dst).await.unwrap();dst.close().await.unwrap();results.push((typed,fts,seq,ordinary,infinite));
    }
    std::fs::remove_dir_all(root).unwrap();for (typed,fts,seq,ordinary,infinite) in results{assert_eq!(typed,("610062FF".into(),"00FF".into(),"text".into()));assert_eq!((fts,seq,ordinary),(41,99,17));assert_eq!(infinite,f64::INFINITY);}
}

#[tokio::test]
async fn sqlite_mask_output_quotes_cannot_inject_sql_and_preserve_null() {
    for (value,rule,want) in [("ab'x@example.com","email","ab***@example.com"),("123x'4567","phone","123****4567"),("a@exa'mple.com","email","*@exa'mple.com")] {
        let mut conn=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();let sql=format!("SELECT {}",apply_mask(value,rule));
        let actual=sqlx::query_scalar::<_,String>(&sql).fetch_one(&mut conn).await;conn.close().await.unwrap();assert_eq!(actual.unwrap(),want);
    }
}

#[tokio::test]
async fn sqlite_rescue_streams_large_table_and_masked_dump_preserves_sql_structure() {
    let root=std::env::temp_dir().join(format!("dbterm-export-stream-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let path=root.join("source.db");std::fs::File::create(&path).unwrap();let cfg=config(&path);let mut conn=admin_conn(&cfg).await.unwrap();
    sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY,email TEXT); WITH RECURSIVE x(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<5001) INSERT INTO t SELECT n,'a@exa''mple.com' FROM x; INSERT INTO t VALUES(6000,NULL);").execute(&mut conn).await.unwrap();conn.close().await.unwrap();
    let out=root.join("rescue.sql");let result=rescue_with_config(&cfg,out.to_string_lossy().into_owned()).await.unwrap();
    let mut dst=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();sqlx::raw_sql(&std::fs::read_to_string(out).unwrap()).execute(&mut dst).await.unwrap();let rows:i64=sqlx::query_scalar("SELECT count(*) FROM t").fetch_one(&mut dst).await.unwrap();dst.close().await.unwrap();
    let masked=root.join("masked.sql");dump_sql_with_config(&cfg,masked.to_string_lossy().into_owned(),Some(vec![MaskingRule{table:"t".into(),column:"email".into(),rule:"email".into()}])).await.unwrap();
    let mut dst=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();sqlx::raw_sql(&std::fs::read_to_string(masked).unwrap()).execute(&mut dst).await.unwrap();let value:String=sqlx::query_scalar("SELECT email FROM t WHERE id=1").fetch_one(&mut dst).await.unwrap();let nulls:i64=sqlx::query_scalar("SELECT count(*) FROM t WHERE email IS NULL").fetch_one(&mut dst).await.unwrap();dst.close().await.unwrap();std::fs::remove_dir_all(root).unwrap();assert_eq!((result.rows_rescued,rows),(5002,5002));assert!(result.errors.is_empty());assert_eq!(value,"*@exa'mple.com");assert_eq!(nulls,1);
}

fn config(path: &std::path::Path) -> ConnConfig {
    let mut cfg: ConnConfig = serde_json::from_value(serde_json::json!({
        "id":"export-safety","name":"test","type":"sqlite",
        "useSsl":false,"createdAt":0,"updatedAt":0
    })).unwrap();
    cfg.file_path = Some(path.to_string_lossy().into_owned()); cfg
}

#[tokio::test]
async fn sqlite_export_all_tables_share_one_snapshot_during_concurrent_commit() {
    let root=std::env::temp_dir().join(format!("dbterm-export-snapshot-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();
    let path=root.join("source.db");std::fs::File::create(&path).unwrap();let cfg=config(&path);let mut source=admin_conn(&cfg).await.unwrap();
    sqlx::raw_sql("PRAGMA journal_mode=WAL; CREATE TABLE large(id INTEGER PRIMARY KEY,v TEXT); CREATE TABLE marker(v INTEGER); INSERT INTO marker VALUES(7); WITH RECURSIVE x(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<2000) INSERT INTO large SELECT n,printf('%0500d',n) FROM x;").execute(&mut source).await.unwrap();source.close().await.unwrap();
    let export_cfg=cfg.clone();let out=root.join("snapshot.sql");let export_path=out.to_string_lossy().into_owned();
    let worker=tokio::spawn(async move{dump_sql_with_config(&export_cfg,export_path,None).await});
    let mut observed=false;
    for _ in 0..1000 {
        observed=std::fs::read_dir(&root).unwrap().filter_map(Result::ok).any(|entry|entry.path().extension().is_some_and(|e|e=="part"));
        if observed{break;}tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let mut writer=admin_conn(&cfg).await.unwrap();sqlx::query("UPDATE marker SET v=11").execute(&mut writer).await.unwrap();writer.close().await.unwrap();
    worker.await.unwrap().unwrap();let mut restored=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();sqlx::raw_sql(&std::fs::read_to_string(out).unwrap()).execute(&mut restored).await.unwrap();
    let marker:i64=sqlx::query_scalar("SELECT v FROM marker").fetch_one(&mut restored).await.unwrap();let count:i64=sqlx::query_scalar("SELECT count(*) FROM large").fetch_one(&mut restored).await.unwrap();restored.close().await.unwrap();std::fs::remove_dir_all(root).unwrap();
    assert!(observed,"writer must commit after exporter acquires snapshot and begins staging");assert_eq!((marker,count),(7,2000));
}

#[tokio::test]
async fn sqlite_export_roundtrips_generated_columns_and_trigger_effects_once() {
    let root = std::env::temp_dir().join(format!("dbterm-export-fidelity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("source.db"); std::fs::File::create(&path).unwrap();
    let cfg = config(&path); let mut source = admin_conn(&cfg).await.unwrap();
    sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, g INTEGER GENERATED ALWAYS AS(a*2) STORED); CREATE TABLE audit(v INTEGER); CREATE TRIGGER log_t AFTER INSERT ON t BEGIN INSERT INTO audit VALUES(new.id); END; INSERT INTO t(id,a) VALUES(1,3);").execute(&mut source).await.unwrap();
    source.close().await.unwrap();
    let mut results = Vec::new();
    for rescue in [false, true] {
        let out = root.join(format!("{rescue}.sql"));
        if rescue { rescue_with_config(&cfg,out.to_string_lossy().into_owned()).await.unwrap(); } else { dump_sql_with_config(&cfg,out.to_string_lossy().into_owned(),None).await.unwrap(); }
        let script = std::fs::read_to_string(out).unwrap();
        let mut restored = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let replay = sqlx::raw_sql(&script).execute(&mut restored).await.map_err(|e| e.to_string());
        let generated = sqlx::query_scalar::<_,i64>("SELECT g FROM t").fetch_optional(&mut restored).await.ok().flatten();
        let audit = sqlx::query_scalar::<_,i64>("SELECT count(*) FROM audit").fetch_one(&mut restored).await.ok();
        let triggers = sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetch_one(&mut restored).await.unwrap();
        restored.close().await.unwrap(); results.push((rescue,replay,generated,audit,triggers));
    }
    std::fs::remove_dir_all(root).unwrap();
    for (rescue,replay,generated,audit,triggers) in results {
        assert!(replay.is_ok(),"rescue={rescue}: {:?}", replay.err());
        assert_eq!(generated,Some(6)); assert_eq!(audit,Some(1)); assert_eq!(triggers,1);
    }
}
