//! Keep backup metadata, structure and streamed rows on one resolved object.
use super::{ConnConfig, SsPool};

const MODULE_SQL: &str = "SELECT DB_NAME(), s.name FROM sys.objects t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.name=@P1 AND t.type IN ('V','P','FN','IF','TF') AND (@P2 IS NULL OR s.name=@P2)";

const TARGET_SQL: &str = "SELECT DB_NAME(), s.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.name=@P1 AND (@P2 IS NULL OR s.name=@P2)";

pub(crate) struct BackupTableTarget {
    pub database: String,
    pub schema: String,
    pub table: String,
}

fn quote(s: &str) -> String { format!("[{}]",s.replace(']', "]]")) }

impl BackupTableTarget {
    fn from_candidates(table: &str, candidates: &[(String,String)]) -> Result<Self,String> {
        match candidates {
            [(database,schema)] if !database.is_empty() && !schema.is_empty() => Ok(Self {
                database:database.clone(), schema:schema.clone(), table:table.to_string(),
            }),
            [] => Err(format!("备份表 {table} 不存在或无权读取，已停止导出")),
            _ => Err(format!("备份表 {table} 无法唯一定位，请明确指定对象schema，已停止导出")),
        }
    }
    pub fn reference(&self) -> String {
        format!("{}.{}.{}",quote(&self.database),quote(&self.schema),quote(&self.table))
    }
    pub fn restore_context(&self) -> String {
        format!("USE {};\nGO\n",quote(&self.database))
    }
}

pub(crate) async fn resolve_backup_table(
    id: &str, config: &ConnConfig, database: &str, table: &str,
    object_schema: Option<&str>, pool: &SsPool,
) -> Result<BackupTableTarget,String> {
    resolve_backup_object(id, config, database, table, object_schema, pool, TARGET_SQL).await
}

pub(crate) async fn resolve_backup_module(
    id: &str, config: &ConnConfig, database: &str, name: &str,
    object_schema: Option<&str>, pool: &SsPool,
) -> Result<BackupTableTarget,String> {
    resolve_backup_object(id, config, database, name, object_schema, pool, MODULE_SQL).await
}

async fn resolve_backup_object(
    id: &str, config: &ConnConfig, database: &str, table: &str,
    object_schema: Option<&str>, pool: &SsPool, sql: &str,
) -> Result<BackupTableTarget,String> {
    let entry=super::get_entry(id,pool,config,crate::keychain::get_password(id)?.as_deref()).await?;
    let mut entry=entry.lock().await;
    if !database.is_empty() {
        entry.client.simple_query(format!("USE {};",quote(database))).await
            .map_err(|e|format!("备份数据库定位失败: {e}"))?.into_results().await
            .map_err(|e|format!("备份数据库定位失败: {e}"))?;
    }
    let mut query=tiberius::Query::new(sql);
    query.bind(table); query.bind(object_schema);
    let rows=query.query(&mut entry.client).await.map_err(|e|format!("备份表定位失败: {e}"))?
        .into_first_result().await.map_err(|e|format!("备份表定位失败: {e}"))?;
    let candidates=rows.iter().map(|r| {
        let db=r.get::<&str,_>(0).ok_or("备份数据库名称不可读")?;
        let schema=r.get::<&str,_>(1).ok_or("备份对象schema不可读")?;
        Ok((db.to_string(),schema.to_string()))
    }).collect::<Result<Vec<_>,String>>()?;
    BackupTableTarget::from_candidates(table,&candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_unique_nondbo_target_preserves_every_identifier_part() {
        let target=BackupTableTarget::from_candidates("t].中",&[("B]库".into(),"ops'.]中文".into())]).unwrap();
        assert_eq!(target.reference(),"[B]]库].[ops'.]]中文].[t]].中]");
        assert_eq!(target.restore_context(),"USE [B]]库];\nGO\n");
    }
    #[test]
    fn backup_refuses_missing_ambiguous_or_unreadable_target() {
        assert!(BackupTableTarget::from_candidates("same",&[]).is_err());
        assert!(BackupTableTarget::from_candidates("same",&[("B".into(),"dbo".into()),("B".into(),"ops".into())]).is_err());
        assert!(BackupTableTarget::from_candidates("same",&[("".into(),"dbo".into())]).is_err());
    }
}
