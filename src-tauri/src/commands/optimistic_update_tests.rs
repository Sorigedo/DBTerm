use super::*;
#[tokio::test]
#[ignore = "requires disposable loopback MySQL DBTERM_TEST_MYSQL_PORT; no desktop application"]
async fn mysql_grid_update_with_saved_latin1_database_preserves_batch() {
    let port: u16 = std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap().parse().unwrap();
    let mut cfg: ConnConfig = serde_json::from_value(serde_json::json!({"id":"local-grid-update","name":"isolated",
        "type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
    let (mut observer, _) = mysql_connect(&cfg, None).await.unwrap();
    let db = format!("dbterm_grid_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db} DEFAULT CHARSET=latin1 COLLATE=latin1_bin")).execute(&mut observer).await.unwrap();
    sqlx::raw_sql(&format!("CREATE TABLE {db}.t(id int PRIMARY KEY,a varchar(50),b varchar(50)) ENGINE=InnoDB; INSERT INTO {db}.t VALUES(1,'alpha','one'),(2,'beta','two')")).execute(&mut observer).await.unwrap();
    cfg.database = Some(db.clone());
    if let Ok(path) = std::env::var("DBTERM_GRID_COMPONENT_PAYLOAD") {
        let payload: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        sqlx::query(&format!("CREATE TABLE {db}.component(id INT PRIMARY KEY,a VARCHAR(128),b VARCHAR(128)) ENGINE=InnoDB")).execute(&mut observer).await.unwrap();
        for row in payload["initial"].as_array().unwrap() {
            sqlx::query(&format!("INSERT INTO {db}.component VALUES(?,?,?)")).bind(row[0].as_str().unwrap()).bind(row[1].as_str().unwrap()).bind(row[2].as_str().unwrap()).execute(&mut observer).await.unwrap();
        }
        for save in payload["saves"].as_array().unwrap() {
            let changes: Vec<CellRowUpdate> = serde_json::from_value(save.clone()).unwrap();
            mysql_update_cells(&cfg,None,&db,"component",&changes).await.unwrap();
        }
        let actual: Vec<(i32,String,String)> = sqlx::query_as(&format!("SELECT id,CAST(a AS CHAR CHARACTER SET utf8mb4),CAST(b AS CHAR CHARACTER SET utf8mb4) FROM {db}.component ORDER BY id")).fetch_all(&mut observer).await.unwrap();
        let actual: Vec<Vec<String>> = actual.into_iter().map(|(id,a,b)|vec![id.to_string(),a,b]).collect();
        assert_eq!(serde_json::to_value(actual).unwrap(),payload["expected"]);
        let stale: Vec<CellRowUpdate> = serde_json::from_value(payload["saves"][0].clone()).unwrap();
        assert!(mysql_update_cells(&cfg,None,&db,"component",&stale).await.unwrap_err().contains("其他会话"));
        eprintln!("PASS captured TableBrowser payloads: single, columns, rectangle, final values and stale replay rejection");
    }
    let change = CellRowUpdate { columns: vec!["a".into()], values: vec![Some("alpha".into())],
        pk_columns: vec!["id".into()], pk_values: vec![Some("2".into())], expected_values: Some(vec![Some("beta".into())]) };
    let result = mysql_update_cells(&cfg, None, &db, "t", &[change]).await;
    let actual: Vec<(i32,String,String)> = sqlx::query_as(&format!("SELECT id,CAST(a AS CHAR CHARACTER SET utf8mb4),CAST(b AS CHAR CHARACTER SET utf8mb4) FROM {db}.t ORDER BY id")).fetch_all(&mut observer).await.unwrap();
    assert!(result.is_ok(), "ordinary grid save failed: {result:?}");
    assert_eq!(actual, vec![(1,"alpha".into(),"one".into()),(2,"alpha".into(),"two".into())]);
    for binary_type in ["BINARY(5)", "VARBINARY(20)", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB"] {
        sqlx::raw_sql(&format!("CREATE TABLE {db}.binary_guard(id int PRIMARY KEY,v {binary_type}) ENGINE=InnoDB; INSERT INTO {db}.binary_guard VALUES(1,'alpha'),(2,'beta')")).execute(&mut observer).await.unwrap();
        let guarded = CellRowUpdate { columns: vec!["v".into()], values: vec![Some("changed".into())],
            pk_columns: vec!["id".into()], pk_values: vec![Some("1".into())], expected_values: Some(vec![Some("alpha".into())]) };
        let error = mysql_update_cells(&cfg, None, &db, "binary_guard", &[guarded]).await.unwrap_err();
        assert!(error.contains("不能恢复"), "{binary_type}: {error}");
        let hex: String = sqlx::query_scalar(&format!("SELECT HEX(v) FROM {db}.binary_guard WHERE id=1")).fetch_one(&mut observer).await.unwrap();
        assert_eq!(hex, "616C706861");
        sqlx::query(&format!("DROP TABLE {db}.binary_guard")).execute(&mut observer).await.unwrap();
    }
    let changes = [
        CellRowUpdate { columns: vec!["a".into()], values: vec![Some("must-rollback".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("1".into())], expected_values: Some(vec![Some("alpha".into())]) },
        CellRowUpdate { columns: vec!["a".into()], values: vec![Some("no-overwrite".into())], pk_columns: vec!["id".into()], pk_values: vec![Some("2".into())], expected_values: Some(vec![Some("stale".into())]) },
    ];
    assert!(mysql_update_cells(&cfg,None,&db,"t",&changes).await.unwrap_err().contains("已回滚"));
    let unchanged: String = sqlx::query_scalar(&format!("SELECT CAST(a AS CHAR CHARACTER SET utf8mb4) FROM {db}.t WHERE id=1")).fetch_one(&mut observer).await.unwrap();
    assert_eq!(unchanged,"alpha");
    sqlx::query(&format!("DROP DATABASE {db}")).execute(&mut observer).await.unwrap();
}
#[tokio::test]
#[ignore="requires disposable PostgreSQL DBTERM_TEST_PG_PORT"]
async fn postgres_optimistic_typed_updates_preserve_encoding_and_atomic_baselines(){
 let port:u16=std::env::var("DBTERM_TEST_PG_PORT").unwrap().parse().unwrap();
 let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"pg-optimistic","name":"test","type":"postgres","host":"127.0.0.1","port":port,"username":"postgres","database":"postgres","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
 let(mut conn,_)=pg_connect(&cfg,None).await.unwrap();let schema=format!("dbterm_opt_{}",uuid::Uuid::new_v4().simple());
 sqlx::query(&format!("CREATE SCHEMA {}",q_dq(&schema))).execute(&mut conn).await.unwrap();
 let outcome:Result<(),String>=async{
  sqlx::query(&format!("CREATE TABLE {}.t(id INT PRIMARY KEY,n INT,b BOOLEAN,v TEXT UNIQUE,d DATE,num NUMERIC(20,4),u UUID,j JSONB)",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;
  sqlx::query(&format!("INSERT INTO {}.t VALUES(1,10,true,'old','2026-11-14',1.2300,'12345678-1234-1234-1234-123456789abc','{{}}'),(2,20,false,'other','2026-11-14',2.3400,'12345678-1234-1234-1234-123456789abd','{{}}')",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;
  let change=|id:&str,col:&str,old:Option<&str>,new:Option<&str>|CellRowUpdate{columns:vec![col.into()],values:vec![new.map(str::to_string)],pk_columns:vec!["id".into()],pk_values:vec![Some(id.into())],expected_values:Some(vec![old.map(str::to_string)])};
  pg_update_cells(&cfg,None,&schema,"t",&[change("1","n",Some("10"),Some("42")),change("1","b",Some("true"),Some("false")),change("1","d",Some("2026-11-14"),Some("2026-11-15"))]).await?;
  let values:(i32,bool,String)=sqlx::query_as(&format!("SELECT n,b,d::text FROM {}.t WHERE id=1",q_dq(&schema))).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(values,(42,false,"2026-11-15".into()));
  for (col,old,new) in [("num","1.2300","5.6789"),("u","12345678-1234-1234-1234-123456789abc","22345678-1234-1234-1234-123456789abc"),("j","{}","{\"a\":1}")]{let err=pg_update_cells(&cfg,None,&schema,"t",&[change("1",col,Some(old),Some(new))]).await.unwrap_err();assert!(err.contains("精确编辑基线"),"{err}");}
  let err=pg_update_cells(&cfg,None,&schema,"t",&[change("2","v",Some("other"),Some("first")),change("1","v",Some("stale"),Some("lost"))]).await.unwrap_err();assert!(err.contains("已回滚"),"{err}");
  let value:String=sqlx::query_scalar(&format!("SELECT v FROM {}.t WHERE id=2",q_dq(&schema))).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(value,"other");
  for actual in [Some("OLD"),Some("old "),None]{sqlx::query(&format!("UPDATE {}.t SET v=$1 WHERE id=1",q_dq(&schema))).bind(actual).execute(&mut conn).await.map_err(|e|e.to_string())?;let error=pg_update_cells(&cfg,None,&schema,"t",&[change("1","v",Some("old"),Some("overwrite"))]).await.unwrap_err();assert!(error.contains("其他会话"),"{error}");}
  pg_update_cells(&cfg,None,&schema,"t",&[change("1","v",None,Some("recovered"))]).await?;
  let unchanged:(String,String,String)=sqlx::query_as(&format!("SELECT num::text,u::text,j::text FROM {}.t WHERE id=1",q_dq(&schema))).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(unchanged,("1.2300".into(),"12345678-1234-1234-1234-123456789abc".into(),"{}".into()));
  let constraint=pg_update_cells(&cfg,None,&schema,"t",&[change("1","n",Some("42"),Some("43")),change("2","v",Some("other"),Some("recovered"))]).await.unwrap_err();assert!(constraint.contains("已回滚"),"{constraint}");
  let n:i32=sqlx::query_scalar(&format!("SELECT n FROM {}.t WHERE id=1",q_dq(&schema))).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(n,42);
  sqlx::query(&format!("CREATE TABLE {}.ambiguous(k TEXT,v TEXT)",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;sqlx::query(&format!("INSERT INTO {}.ambiguous VALUES('same','a'),('same','a')",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;
  let ambiguous=CellRowUpdate{columns:vec!["v".into()],values:vec![Some("lost".into())],pk_columns:vec!["k".into()],pk_values:vec![Some("same".into())],expected_values:Some(vec![Some("a".into())])};assert!(pg_update_cells(&cfg,None,&schema,"ambiguous",&[ambiguous]).await.is_err());
  let untouched:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM {}.ambiguous WHERE v='a'",q_dq(&schema))).fetch_one(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(untouched,2);
  sqlx::query(&format!("CREATE TABLE {}.composite(a INT,b TEXT,v TEXT CHECK(v <> 'forbidden'),PRIMARY KEY(a,b))",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;
  sqlx::query(&format!("INSERT INTO {}.composite VALUES(1,'left','alpha'),(1,'right','beta'),(2,'left','gamma')",q_dq(&schema))).execute(&mut conn).await.map_err(|e|e.to_string())?;
  let composite=|a:&str,b:&str,old:&str,new:&str|CellRowUpdate{columns:vec!["v".into()],values:vec![Some(new.into())],pk_columns:vec!["b".into(),"a".into()],pk_values:vec![Some(b.into()),Some(a.into())],expected_values:Some(vec![Some(old.into())])};
  pg_update_cells(&cfg,None,&schema,"composite",&[composite("1","left","alpha","changed")]).await?;
  let composite_values:Vec<String>=sqlx::query_scalar(&format!("SELECT v FROM {}.composite ORDER BY a,b",q_dq(&schema))).fetch_all(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(composite_values,vec!["changed","beta","gamma"]);
  let composite_constraint=pg_update_cells(&cfg,None,&schema,"composite",&[composite("1","left","changed","temporary"),composite("2","left","gamma","forbidden")]).await.unwrap_err();assert!(composite_constraint.contains("已回滚"),"{composite_constraint}");
  let composite_after:Vec<String>=sqlx::query_scalar(&format!("SELECT v FROM {}.composite ORDER BY a,b",q_dq(&schema))).fetch_all(&mut conn).await.map_err(|e|e.to_string())?;assert_eq!(composite_after,vec!["changed","beta","gamma"]);Ok(())
 }.await;
 sqlx::query(&format!("DROP SCHEMA {} CASCADE",q_dq(&schema))).execute(&mut conn).await.unwrap();outcome.unwrap();
}
#[tokio::test]
#[ignore="requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
async fn mysql_optimistic_update_rejects_stale_case_space_null_and_rolls_back_batch(){
 let port:u16=std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap().parse().unwrap();let cfg:ConnConfig=serde_json::from_value(serde_json::json!({"id":"optimistic","name":"optimistic","type":"mysql","host":"127.0.0.1","port":port,"username":"root","useSsl":false,"createdAt":0,"updatedAt":0})).unwrap();
 let(mut c,_)=mysql_connect(&cfg,None).await.unwrap();let db=format!("dbterm_opt_{}",uuid::Uuid::new_v4().simple());sqlx::query(&format!("CREATE DATABASE {db}")).execute(&mut c).await.unwrap();sqlx::query(&format!("CREATE TABLE {db}.t(id INT PRIMARY KEY,v VARCHAR(30) COLLATE utf8mb4_0900_ai_ci) ENGINE=InnoDB")).execute(&mut c).await.unwrap();
 sqlx::query(&format!("INSERT INTO {db}.t VALUES(1,'A'),(2,'other')")).execute(&mut c).await.unwrap();
 let change=|id:&str,old:Option<&str>,new:&str|CellRowUpdate{columns:vec!["v".into()],values:vec![Some(new.into())],pk_columns:vec!["id".into()],pk_values:vec![Some(id.into())],expected_values:Some(vec![old.map(String::from)])};
 for actual in [Some("a"),Some("A "),None]{
  sqlx::query(&format!("UPDATE {db}.t SET v=? WHERE id=1")).bind(actual).execute(&mut c).await.unwrap();
  let err=mysql_update_cells(&cfg,None,&db,"t",&[change("1",Some("A"),"lost")]).await.unwrap_err();assert!(err.contains("其他会话"),"{err}");
 }
 sqlx::query(&format!("UPDATE {db}.t SET v='newer' WHERE id=1")).execute(&mut c).await.unwrap();
 let err=mysql_update_cells(&cfg,None,&db,"t",&[change("2",Some("other"),"first"),change("1",Some("old"),"lost")]).await.unwrap_err();assert!(err.contains("已回滚"));
 assert_eq!(sqlx::query_scalar::<_,String>(&format!("SELECT v FROM {db}.t WHERE id=2")).fetch_one(&mut c).await.unwrap(),"other");
 mysql_update_cells(&cfg,None,&db,"t",&[change("1",Some("newer"),"saved")]).await.unwrap();
 sqlx::query(&format!("DROP DATABASE {db}")).execute(&mut c).await.unwrap();
}
#[tokio::test]
async fn sqlite_optimistic_update_rejects_newer_value_and_keeps_batch_atomic(){
 use sqlx::Connection;
 let path=std::env::temp_dir().join(format!("dbterm-opt-{}.sqlite",uuid::Uuid::new_v4()));std::fs::File::create(&path).unwrap();let url=format!("sqlite://{}",path.display());let mut c=sqlx::SqliteConnection::connect(&url).await.unwrap();sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'newer'),(2,'other')").execute(&mut c).await.unwrap();
 let changes=vec![CellRowUpdate{columns:vec!["v".into()],values:vec![Some("first".into())],pk_columns:vec!["id".into()],pk_values:vec![Some("2".into())],expected_values:Some(vec![Some("other".into())])},CellRowUpdate{columns:vec!["v".into()],values:vec![Some("lost".into())],pk_columns:vec!["id".into()],pk_values:vec![Some("1".into())],expected_values:Some(vec![Some("old".into())])}];assert!(sqlite_update_cells(&url,"t",&changes).await.unwrap_err().contains("已回滚"));assert_eq!(sqlx::query_scalar::<_,String>("SELECT v FROM t WHERE id=2").fetch_one(&mut c).await.unwrap(),"other");drop(c);std::fs::remove_file(path).unwrap();
}
