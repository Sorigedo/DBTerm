use super::*;
pub(super) async fn mysql_delete_rows(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values_list: &[Vec<Option<String>>],
    baseline: &DeleteBaseline,
) -> Result<u64, String> {
    use sqlx::{Connection, Row};
    if pk_columns.is_empty()
        || pk_columns.len() > 65_535
        || pk_values_list
            .iter()
            .any(|values| values.len() != pk_columns.len())
    {
        return Err("删除定位列为空或定位值列数不一致，未执行删除".into());
    }
    if pk_values_list.is_empty() {
        return Ok(0);
    }
    let (mut conn, _tunnel) = mysql_connect(config, password).await?;
    let target = if schema.is_empty() {
        q_mysql(table)
    } else {
        format!("{}.{}", q_mysql(schema), q_mysql(table))
    };
    let where_template: Vec<String> = pk_columns
        .iter()
        .map(|c| format!("{} <=> ?", q_mysql(c)))
        .collect();
    let where_clause = where_template.join(" AND ");
    let sql = tag_sql(&format!("DELETE FROM {target} WHERE {where_clause}"));
    let mut tx = conn
        .begin()
        .await
        .map_err(|e| format!("开启删除事务失败: {e}"))?;
    super::super::query::mysql_require_atomic_table(&mut *tx, schema, table).await?;
    let mut total: u64 = 0;
    for (row_index, pk_values) in pk_values_list.iter().enumerate() {
        let lookup = format!(
            "SELECT {} FROM {target} WHERE {where_clause} LIMIT 2 FOR UPDATE",
            baseline
                .columns
                .iter()
                .map(|n| q_mysql(n))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut query = sqlx::query(&lookup);
        for value in pk_values {
            query = query.bind(value.as_deref());
        }
        let found = query
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| format!("删除并发校验失败，未提交: {e}"))?;
        if found.len() != 1 {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err("目标行已消失或定位不唯一，整批删除已回滚".into());
        }
        for (i, expected) in baseline.rows[row_index].iter().enumerate() {
            use sqlx::{Column, Row, TypeInfo};
            let raw = found[0].try_get_raw(i).map_err(|e| e.to_string())?;
            let typ = found[0].columns()[i]
                .type_info()
                .name()
                .to_ascii_uppercase();
            if typ.contains("BLOB")
                || typ.contains("BINARY")
                || typ == "BIT"
                || typ.contains("FLOAT")
                || typ.contains("DOUBLE")
                || typ == "NUMERIC"
            {
                return Err("该类型无法精确恢复删除基线，事务未提交；请使用显式 SQL".into());
            }
            if expected.is_none() {
                use sqlx::Decode;
                if !matches!(<&[u8] as Decode<sqlx::MySql>>::decode(raw),Err(e) if e.is::<sqlx::error::UnexpectedNullError>())
                {
                    return Err("原值NULL与实际值不符，删除未提交".into());
                }
            }
            if super::super::query::mysql_cell(&found[0], i) != *expected {
                tx.rollback().await.map_err(|e| e.to_string())?;
                return Err("记录已被其他会话修改，整批删除已回滚，请刷新后确认".into());
            }
        }
        for column in &baseline.columns {
            let schema_name = if schema.is_empty() {
                sqlx::query_scalar::<_, String>("SELECT DATABASE()")
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                schema.to_string()
            };
            let typ:String=sqlx::query_scalar("SELECT CAST(DATA_TYPE AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?").bind(&schema_name).bind(table).bind(column).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
            if matches!(typ.as_str(), "enum" | "set") {
                return Err("ENUM/SET 显示不能恢复准确序号基线，删除未提交".into());
            }
        }
        let mut q = sqlx::query(&sql);
        for val in pk_values {
            q = q.bind(val.as_deref());
        }
        match q.execute(&mut *tx).await {
            Ok(res) => {
                if res.rows_affected() != 1 {
                    tx.rollback()
                        .await
                        .map_err(|e| format!("删除定位匹配多行，回滚未确认: {e}"))?;
                    return Err("删除定位匹配多行，整批已回滚，请使用唯一键定位".into());
                }
                total += res.rows_affected();
            }
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("删除失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("删除失败，整批已回滚: {e}"));
            }
        }
        let warning_row = sqlx::Executor::fetch_one(&mut *tx, "SHOW COUNT(*) WARNINGS")
            .await
            .map_err(|e| format!("核验删除警告失败，事务未提交: {e}"))?;
        let warnings: u64 = warning_row
            .try_get(0)
            .map_err(|e| format!("解析删除警告失败，事务未提交: {e}"))?;
        if warnings > 0 {
            tx.rollback()
                .await
                .map_err(|e| format!("删除条件出现转换警告，回滚未确认: {e}"))?;
            return Err("删除条件出现数据库警告，整批已回滚以防隐式转换误删".into());
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("删除提交未获确认，结果未知，请核对目标，禁止自动重试: {e}"))?;
    Ok(total)
}
pub(super) async fn pg_delete_rows(
    config: &ConnConfig,
    password: Option<&str>,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values_list: &[Vec<Option<String>>],
    baseline: &DeleteBaseline,
) -> Result<u64, String> {
    use sqlx::Connection;
    if pk_columns.is_empty()
        || pk_columns.len() > 65_535
        || pk_values_list
            .iter()
            .any(|values| values.len() != pk_columns.len())
    {
        return Err("删除定位列为空或定位值列数不一致，未执行删除".into());
    }
    if pk_values_list.is_empty() {
        return Ok(0);
    }
    let (mut conn, _tunnel) = pg_connect(config, password).await?;
    let schema_name = if schema.is_empty() { "public" } else { schema };
    let target = format!("{}.{}", q_dq(schema_name), q_dq(table));
    let where_template: Vec<String> = pk_columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{}::text IS NOT DISTINCT FROM ${}", q_dq(c), i + 1))
        .collect();
    let where_clause = where_template.join(" AND ");
    let sql = tag_sql(&format!("DELETE FROM {target} WHERE {where_clause}"));
    let mut tx = conn
        .begin()
        .await
        .map_err(|e| format!("开启删除事务失败: {e}"))?;
    let mut total: u64 = 0;
    for (row_index, pk_values) in pk_values_list.iter().enumerate() {
        let lookup = format!(
            "SELECT {} FROM {target} WHERE {where_clause} LIMIT 2 FOR UPDATE",
            baseline
                .columns
                .iter()
                .map(|n| q_dq(n))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut query = sqlx::query(&lookup);
        for value in pk_values {
            query = query.bind(value.as_deref());
        }
        let found = query
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| format!("删除并发校验失败，未提交: {e}"))?;
        if found.len() != 1 {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err("目标行已消失或定位不唯一，整批删除已回滚".into());
        }
        for (i, expected) in baseline.rows[row_index].iter().enumerate() {
            use sqlx::{Column, Row, TypeInfo, ValueRef};
            let raw = found[0].try_get_raw(i).map_err(|e| e.to_string())?;
            let typ = found[0].columns()[i]
                .type_info()
                .name()
                .to_ascii_uppercase();
            if !matches!(
                typ.as_str(),
                "BOOL"
                    | "INT2"
                    | "INT4"
                    | "INT8"
                    | "FLOAT4"
                    | "FLOAT8"
                    | "TEXT"
                    | "VARCHAR"
                    | "BPCHAR"
                    | "DATE"
                    | "TIME"
                    | "TIMESTAMP"
                    | "TIMESTAMPTZ"
            ) {
                return Err("此类型不能恢复准确删除基线，事务未提交".into());
            }
            if expected.is_none() != raw.is_null() {
                return Err("原值NULL与实际值不符，删除未提交".into());
            }
            if super::super::query::pg_cell(&found[0], i) != *expected {
                tx.rollback().await.map_err(|e| e.to_string())?;
                return Err("记录已被其他会话修改，整批删除已回滚，请刷新后确认".into());
            }
        }
        let mut q = sqlx::query(&sql);
        for val in pk_values {
            q = q.bind(val.as_deref());
        }
        match q.execute(&mut *tx).await {
            Ok(res) => {
                if res.rows_affected() != 1 {
                    tx.rollback()
                        .await
                        .map_err(|e| format!("删除定位匹配多行，回滚未确认: {e}"))?;
                    return Err("删除定位匹配多行，整批已回滚，请使用唯一键定位".into());
                }
                total += res.rows_affected();
            }
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("删除失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("删除失败，整批已回滚: {e}"));
            }
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("删除提交未获确认，结果未知，请核对目标，禁止自动重试: {e}"))?;
    Ok(total)
}
pub(super) async fn sqlite_delete_rows_impl(
    config: &ConnConfig,
    schema: &str,
    table: &str,
    pk_columns: &[String],
    pk_values_list: &[Vec<Option<String>>],
    baseline: &DeleteBaseline,
) -> Result<u64, String> {
    if pk_columns.is_empty()
        || pk_values_list
            .iter()
            .any(|values| values.len() != pk_columns.len())
    {
        return Err("删除定位列为空或定位值列数不一致，未执行删除".into());
    }
    if pk_values_list.is_empty() {
        return Ok(0);
    }
    let url = super::super::query::sqlite_url(config)?;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .map_err(|e| format!("SQLite 连接失败: {e}"))?;
    let target = if schema.is_empty() || schema == "main" {
        q_dq(table)
    } else {
        format!("{}.{}", q_dq(schema), q_dq(table))
    };
    let where_clause = pk_columns
        .iter()
        .map(|c| format!("{} IS ?", q_dq(c)))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!("DELETE FROM {target} WHERE {where_clause}");
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启删除事务失败: {e}"))?;
    let mut total: u64 = 0;
    for (row_index, pk_values) in pk_values_list.iter().enumerate() {
        let lookup = format!(
            "SELECT {} FROM {target} WHERE {where_clause} LIMIT 2",
            baseline
                .columns
                .iter()
                .map(|n| q_dq(n))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut query = sqlx::query(&lookup);
        for value in pk_values {
            query = query.bind(value.as_deref());
        }
        let found = query
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| format!("删除并发校验失败，未提交: {e}"))?;
        if found.len() != 1 {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err("目标行已消失或定位不唯一，整批删除已回滚".into());
        }
        for (i, expected) in baseline.rows[row_index].iter().enumerate() {
            use sqlx::{Column, Row, TypeInfo, ValueRef};
            let raw = found[0].try_get_raw(i).map_err(|e| e.to_string())?;
            let typ = found[0].columns()[i]
                .type_info()
                .name()
                .to_ascii_uppercase();
            if !matches!(typ.as_str(), "NULL" | "INTEGER" | "REAL" | "TEXT") {
                return Err("此类型不能恢复准确删除基线，事务未提交".into());
            }
            if expected.is_none() != raw.is_null() {
                return Err("原值NULL与实际值不符，删除未提交".into());
            }
            if super::super::query::sqlite_cell(&found[0], i) != *expected {
                tx.rollback().await.map_err(|e| e.to_string())?;
                return Err("记录已被其他会话修改，整批删除已回滚，请刷新后确认".into());
            }
        }
        let mut q = sqlx::query(&sql);
        for val in pk_values {
            q = q.bind(val.as_deref());
        }
        match q.execute(&mut *tx).await {
            Ok(res) => {
                if res.rows_affected() != 1 {
                    tx.rollback()
                        .await
                        .map_err(|e| format!("删除定位匹配多行，回滚未确认: {e}"))?;
                    return Err("删除定位匹配多行，整批已回滚，请使用唯一键定位".into());
                }
                total += res.rows_affected();
            }
            Err(e) => {
                tx.rollback()
                    .await
                    .map_err(|r| format!("删除失败: {e}；回滚未确认: {r}"))?;
                return Err(format!("删除失败，整批已回滚: {e}"));
            }
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("删除提交未获确认，结果未知，请核对目标，禁止自动重试: {e}"))?;
    pool.close().await;
    Ok(total)
}
fn conflict() -> String {
    "选中行已变化或定位不唯一，整批删除已回滚；请刷新确认".into()
}
fn same_rows(
    result: &crate::models::QueryResult,
    expected: &[Option<String>],
) -> Result<(), String> {
    if result.rows.len() != 1 || result.rows[0] != expected {
        return Err(conflict());
    }
    Ok(())
}
fn native_predicate(
    columns: &[String],
    values: &[Option<String>],
    quote: fn(&str) -> String,
    literal_prefix: &str,
) -> String {
    columns
        .iter()
        .zip(values)
        .map(|(c, v)| match v {
            None => format!("{} IS NULL", quote(c)),
            Some(v) => format!(
                "{} = {}'{}'",
                quote(c),
                literal_prefix,
                v.replace('\'', "''")
            ),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}
pub(super) async fn duck_delete_rows(
    id: &str,
    config: &ConnConfig,
    table: &str,
    schema: &str,
    keys: &[String],
    values: &[Vec<Option<String>>],
    baseline: &DeleteBaseline,
    registry: &DriverRegistry,
) -> Result<u64, String> {
    use super::super::duckdb::{get_duck_lib_path_pub, get_or_open_pub, run_query_sync_pub};
    let pool: DuckPool =
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let lib = get_duck_lib_path_pub(registry).await?;
    let handle = get_or_open_pub(id, config, &pool, &lib).await?;
    let table = q_dq(table);
    let catalog = schema.to_string();
    let keys = keys.to_vec();
    let values = values.to_vec();
    let base = baseline.clone();
    tokio::task::spawn_blocking(move || {
        let conn = handle.blocking_lock();
        let target = table;
        if !catalog.is_empty() {
            super::super::duckdb::select_catalog_on_connection(&conn, &catalog)?;
        }
        run_query_sync_pub(&conn, "BEGIN", 0)?;
        let action = (|| -> Result<u64, String> {
            let metadata =
                run_query_sync_pub(&conn, &format!("DESCRIBE SELECT * FROM {target}"), 0)?;
            for name in &base.columns {
                let typ = metadata
                    .rows
                    .iter()
                    .find(|r| r.first().and_then(|v| v.as_deref()) == Some(name))
                    .and_then(|r| r.get(1))
                    .and_then(|v| v.as_deref())
                    .ok_or("删除基线字段元数据缺失")?
                    .to_ascii_uppercase();
                if !(typ.contains("INT")
                    || typ.starts_with("DECIMAL")
                    || matches!(
                        typ.as_str(),
                        "VARCHAR" | "BOOLEAN" | "DATE" | "TIME" | "TIMESTAMP"
                    ))
                {
                    return Err("此字段类型不能恢复精确删除基线，请使用显式 SQL".into());
                }
            }
            let cols = base
                .columns
                .iter()
                .map(|n| q_dq(n))
                .collect::<Vec<_>>()
                .join(",");
            let mut total = 0;
            for (i, key) in values.iter().enumerate() {
                let pred = native_predicate(&keys, key, q_dq, "");
                let exact = base
                    .columns
                    .iter()
                    .zip(&base.rows[i])
                    .map(|(n, v)| match v {
                        None => format!("{} IS NULL", q_dq(n)),
                        Some(v) => format!(
                            "encode(CAST({} AS VARCHAR)) = from_hex('{}')",
                            q_dq(n),
                            hex::encode(v.as_bytes())
                        ),
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let pred = format!("({pred}) AND ({exact})");
                let found = run_query_sync_pub(
                    &conn,
                    &format!("SELECT {cols} FROM {target} WHERE {pred} LIMIT 2"),
                    2,
                )?;
                same_rows(&found, &base.rows[i])?;
                let count =
                    run_query_sync_pub(&conn, &format!("DELETE FROM {target} WHERE {pred}"), 0)?
                        .rows_affected;
                if count != 1 {
                    return Err(conflict());
                }
                total += count;
            }
            Ok(total)
        })();
        match action {
            Ok(n) => {
                run_query_sync_pub(&conn, "COMMIT", 0)
                    .map_err(|e| format!("删除提交结果未确认，勿重试: {e}"))?;
                Ok(n)
            }
            Err(e) => {
                run_query_sync_pub(&conn, "ROLLBACK", 0)
                    .map_err(|r| format!("{e};回滚未确认:{r}"))?;
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(super) async fn ss_delete_rows(
    id: &str,
    config: &ConnConfig,
    schema: &str,
    table: &str,
    keys: &[String],
    values: &[Vec<Option<String>>],
    baseline: &DeleteBaseline,
    ss_schema: Option<&str>,
) -> Result<u64, String> {
    use super::super::sqlserver::{
        get_entry, query_on_locked_entry, resolve_table_target_in_schema, table_write_config,
    };
    let pool: SsPool =
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let cfg = table_write_config(config, schema);
    let pass = crate::keychain::get_password(id)?;
    let handle = get_entry(id, &pool, &cfg, pass.as_deref()).await?;
    let mut conn = handle.lock().await;
    let target = resolve_table_target_in_schema(&mut conn, table, ss_schema).await?;
    query_on_locked_entry(&mut conn, "SET XACT_ABORT ON; BEGIN TRANSACTION").await?;
    let action=async{
  query_on_locked_entry(&mut conn,&format!("SELECT TOP 1 1 FROM {target} WITH (TABLOCKX,HOLDLOCK)")).await?;
  for name in &baseline.columns{let meta=query_on_locked_entry(&mut conn,&format!("SELECT TYPE_NAME(system_type_id) FROM sys.columns WHERE object_id=OBJECT_ID(N'{}') AND name=N'{}'",target.replace('\'',"''"),name.replace('\'',"''"))).await?;let typ=meta.rows.first().and_then(|r|r.first()).and_then(|v|v.as_deref()).ok_or("删除字段元数据缺失")?;if !matches!(typ,"char"|"nchar"|"varchar"|"nvarchar"|"tinyint"|"smallint"|"int"|"bigint"|"decimal"|"numeric"|"bit"){return Err("此字段类型不能恢复精确删除基线，请使用显式 SQL".into());}}
  let quote=|n:&str|format!("[{}]",n.replace(']',"]]"));let cols=baseline.columns.iter().map(|n|quote(n)).collect::<Vec<_>>().join(",");let mut total=0;
  for(i,key)in values.iter().enumerate(){let pred=native_predicate(keys,key,|n|format!("[{}]",n.replace(']',"]]")),"N");let nulls=baseline.columns.iter().zip(&baseline.rows[i]).map(|(n,v)|format!("{} IS {}NULL",quote(n),if v.is_some(){"NOT "}else{""})).collect::<Vec<_>>().join(" AND ");let pred=format!("({pred}) AND ({nulls})");let found=query_on_locked_entry(&mut conn,&format!("SELECT TOP 2 {cols} FROM {target} WITH (UPDLOCK,HOLDLOCK) WHERE {pred}")).await?;same_rows(&found,&baseline.rows[i])?;let count=query_on_locked_entry(&mut conn,&format!("DELETE FROM {target} WHERE {pred}")).await?.rows_affected;if count!=1{return Err(conflict());}total+=count;}Ok(total)
 }.await;
    match action {
        Ok(n) => {
            query_on_locked_entry(&mut conn, "COMMIT TRANSACTION")
                .await
                .map_err(|e| format!("删除提交结果未确认，勿重试:{e}"))?;
            Ok(n)
        }
        Err(e) => {
            query_on_locked_entry(&mut conn, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION")
                .await
                .map_err(|r| format!("{e};回滚未确认:{r}"))?;
            Err(e)
        }
    }
}
