//! Trigger bodies remain untouched; settings, state and order are separate batches.
use super::SsEntry;
const TRIGGER_SQL: &str = "SELECT s.name,tr.name,sm.definition,sm.uses_ansi_nulls,sm.uses_quoted_identifier,tr.is_disabled,tr.type,OBJECTPROPERTY(tr.object_id,'ExecIsFirstInsertTrigger'),OBJECTPROPERTY(tr.object_id,'ExecIsLastInsertTrigger'),OBJECTPROPERTY(tr.object_id,'ExecIsFirstUpdateTrigger'),OBJECTPROPERTY(tr.object_id,'ExecIsLastUpdateTrigger'),OBJECTPROPERTY(tr.object_id,'ExecIsFirstDeleteTrigger'),OBJECTPROPERTY(tr.object_id,'ExecIsLastDeleteTrigger') FROM sys.triggers tr JOIN sys.objects o ON o.object_id=tr.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules sm ON sm.object_id=tr.object_id WHERE tr.parent_id=OBJECT_ID(@P1) AND tr.parent_class=1 AND tr.is_ms_shipped=0 ORDER BY tr.object_id";
fn quote(s:&str)->String{format!("[{}]",s.replace(']',"]]"))}
fn literal(s:&str)->String{format!("N'{}'",s.replace('\'',"''"))}
struct Trigger {schema:String,name:String,definition:String,ansi:bool,quoted:bool,disabled:bool,order:[i32;6]}
impl Trigger{
    fn render(&self,table:&str)->Result<String,String>{
        if self.definition.trim().is_empty(){return Err(format!("触发器 {} 定义不可读或已加密",self.name));}
        let mut sql=format!("SET ANSI_NULLS {};\nGO\nSET QUOTED_IDENTIFIER {};\nGO\n{}\nGO\n{} TRIGGER {}.{} ON {table};",if self.ansi{"ON"}else{"OFF"},if self.quoted{"ON"}else{"OFF"},self.definition,if self.disabled{"DISABLE"}else{"ENABLE"},quote(&self.schema),quote(&self.name));
        for(n,event)in ["INSERT","UPDATE","DELETE"].iter().enumerate(){
            let(first,last)=(self.order[n*2],self.order[n*2+1]);
            if ![0,1].contains(&first)||![0,1].contains(&last)||(first==1&&last==1){return Err(format!("触发器 {} 的事件顺序标记无效",self.name));}
            if first==1||last==1{
                sql.push_str(&format!("\nEXEC sys.sp_settriggerorder @triggername={}, @order=N'{}', @stmttype=N'{event}';",literal(&format!("{}.{}",quote(&self.schema),quote(&self.name))),if first==1{"First"}else{"Last"}));
            }
        }
        Ok(sql)
    }
}
pub(super)async fn read_triggers(entry:&mut SsEntry,context:&str,object:&str,table:&str)->Result<Vec<String>,String>{
    let mut query=tiberius::Query::new(format!("{context}{TRIGGER_SQL}"));query.bind(object);
    let rows=query.query(&mut entry.client).await.map_err(|e|format!("读取触发器失败: {e}"))?.into_first_result().await.map_err(|e|format!("读取触发器失败: {e}"))?;
    let mut result=Vec::new();
    for r in rows{
        if r.get::<&str,_>(6).ok_or("触发器类型不可读")?.trim()!="TR"{return Err("CLR触发器尚未完整脚本化，已停止生成DDL".into());}
        let text=|i|r.get::<&str,_>(i).map(str::to_string).ok_or("触发器名称或定义不可读".to_string());
        let mut order=[0;6];for(n,value)in order.iter_mut().enumerate(){*value=r.get::<i32,_>(n+7).ok_or("触发器事件顺序不可读")?;}
        result.push(Trigger{schema:text(0)?,name:text(1)?,definition:text(2)?,ansi:r.get::<bool,_>(3).ok_or("触发器ANSI_NULLS不可读")?,quoted:r.get::<bool,_>(4).ok_or("触发器QUOTED_IDENTIFIER不可读")?,disabled:r.get::<bool,_>(5).ok_or("触发器启停状态不可读")?,order}.render(table)?);
    }
    Ok(result)
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn trigger_preserves_body_flags_disabled_and_event_orders(){let definition="CREATE TRIGGER [ops].[t] ON [ops].[a] AFTER INSERT AS\r\nSELECT N'GO; ALTER TABLE';";let t=Trigger{schema:"ops'.]中".into(),name:"tr']中".into(),definition:definition.into(),ansi:false,quoted:true,disabled:true,order:[1,0,0,1,0,0]};let sql=t.render("[B].[ops].[a]").unwrap();assert!(sql.starts_with("SET ANSI_NULLS OFF;\nGO\nSET QUOTED_IDENTIFIER ON;\nGO\n"));assert!(sql.contains(definition));assert!(sql.contains("DISABLE TRIGGER [ops'.]]中].[tr']]中] ON [B].[ops].[a];"));assert!(sql.contains("@order=N'First', @stmttype=N'INSERT'"));assert!(sql.contains("@order=N'Last', @stmttype=N'UPDATE'"));assert!(sql.contains("@triggername=N'[ops''.]]中].[tr'']]中]'"));}
    #[test]fn missing_body_or_invalid_order_is_not_silently_omitted(){let mut t=Trigger{schema:"ops".into(),name:"tr".into(),definition:"".into(),ansi:true,quoted:true,disabled:false,order:[0;6]};assert!(t.render("[t]").is_err());t.definition="CREATE TRIGGER ...".into();t.order[0]=2;assert!(t.render("[t]").is_err());t.order=[0;6];let sql=t.render("[t]").unwrap();assert!(sql.contains("ENABLE TRIGGER"));assert!(!sql.contains("sp_settriggerorder"));}
}
