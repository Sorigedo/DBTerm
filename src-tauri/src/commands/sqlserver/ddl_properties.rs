//! Table/column extended properties retain names, SQL_VARIANT base types and values.
use super::SsEntry;
const PROPERTY_SQL: &str = "SELECT ep.name,ep.minor_id,c.name,CAST(SQL_VARIANT_PROPERTY(ep.value,'BaseType') AS nvarchar(128)),CAST(SQL_VARIANT_PROPERTY(ep.value,'Precision') AS int),CAST(SQL_VARIANT_PROPERTY(ep.value,'Scale') AS int),CAST(SQL_VARIANT_PROPERTY(ep.value,'MaxLength') AS int),CAST(SQL_VARIANT_PROPERTY(ep.value,'Collation') AS nvarchar(128)),CONVERT(nvarchar(max),ep.value),CASE WHEN SQL_VARIANT_PROPERTY(ep.value,'BaseType') IN ('binary','varbinary') THEN CONVERT(varchar(max),CONVERT(varbinary(max),ep.value),1) ELSE NULL END FROM sys.extended_properties ep LEFT JOIN sys.columns c ON c.object_id=ep.major_id AND c.column_id=ep.minor_id WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(@P1) ORDER BY ep.minor_id,ep.name";
fn literal(s:&str)->String{format!("N'{}'",s.replace('\'',"''"))}
fn quote(s:&str)->String{format!("[{}]",s.replace(']',"]]"))}
struct Property{name:String,column:Option<String>,kind:Option<String>,precision:Option<i32>,scale:Option<i32>,length:Option<i32>,collation:Option<String>,value:Option<String>,binary:Option<String>}
impl Property{
    fn value_expression(&self)->Result<String,String>{
        let Some(kind)=self.kind.as_deref() else {return if self.value.is_none(){Ok("NULL".into())}else{Err("扩展属性类型不可读".into())};};
        let value=self.value.as_deref().ok_or("扩展属性值不可读")?;
        let(kind,base)=(kind.to_ascii_lowercase(),literal(value));
        let expression=match kind.as_str(){
            "nvarchar"|"nchar"|"varchar"|"char"=>{
                let bytes=self.length.filter(|n|*n>0&&*n<=8000).ok_or("扩展属性文本长度不可读")?;
                let unicode=kind.starts_with('n');
                if unicode&&bytes%2!=0{return Err("扩展属性Unicode长度无效".into());}
                let length=if unicode{bytes/2}else{bytes};
                let collation=self.collation.as_deref().filter(|s|!s.is_empty()).ok_or("扩展属性文本排序规则不可读")?;
                format!("CONVERT({kind}({length}), {base} COLLATE {}) COLLATE {}",quote(collation),quote(collation))
            }
            "tinyint"|"smallint"|"int"|"bigint"|"bit"=>format!("CONVERT({kind}, {base})"),
            "decimal"|"numeric"=>{
                let precision=self.precision.filter(|n|*n>=1&&*n<=38).ok_or("扩展属性精度不可读")?;
                let scale=self.scale.filter(|n|*n>=0&&*n<=precision).ok_or("扩展属性小数位不可读")?;
                format!("CONVERT({kind}({precision},{scale}), {base})")
            }
            "binary"|"varbinary"=>{
                let length=self.length.filter(|n|*n>0&&*n<=8000).ok_or("扩展属性二进制长度不可读")?;
                let hex=self.binary.as_deref().filter(|s|s.starts_with("0x")&&s[2..].len()%2==0&&s[2..].bytes().all(|c|c.is_ascii_hexdigit())).ok_or("扩展属性二进制值不可读")?;
                format!("CONVERT({kind}({length}), {hex})")
            }
            _=>return Err(format!("扩展属性 {} 的类型 {kind} 尚未完整脚本化",self.name)),
        };
        Ok(expression)
    }
    fn render(&self,schema:&str,table:&str)->Result<String,String>{
        let expression=self.value_expression()?;
        let mut sql=format!("DECLARE @dbterm_property_value sql_variant;\nSET @dbterm_property_value = {expression};\nEXEC sys.sp_addextendedproperty @name={}, @value=@dbterm_property_value, @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={}",literal(&self.name),literal(schema),literal(table));
        if let Some(column)=&self.column{sql.push_str(&format!(", @level2type=N'COLUMN', @level2name={}",literal(column)));}
        sql.push(';');Ok(sql)
    }
}
pub(super)async fn read_properties(entry:&mut SsEntry,context:&str,object:&str,schema:&str,table:&str)->Result<Vec<String>,String>{
    let mut query=tiberius::Query::new(format!("{context}{PROPERTY_SQL}"));query.bind(object);
    let rows=query.query(&mut entry.client).await.map_err(|e|format!("读取扩展属性失败: {e}"))?.into_first_result().await.map_err(|e|format!("读取扩展属性失败: {e}"))?;
    let mut result=Vec::new();
    for r in rows{
        let text=|n|r.get::<&str,_>(n).map(str::to_string);
        let minor=r.get::<i32,_>(1).ok_or("扩展属性对象ID不可读")?;
        let column=if minor==0{None}else{Some(text(2).ok_or("扩展属性字段不可读")?)};
        result.push(Property{name:text(0).ok_or("扩展属性名称不可读")?,column,kind:text(3),precision:r.get::<i32,_>(4),scale:r.get::<i32,_>(5),length:r.get::<i32,_>(6),collation:text(7),value:text(8),binary:text(9)}.render(schema,table)?);
    }
    Ok(result)
}
#[cfg(test)]mod tests{
    use super::*;
    fn property()->Property{Property{name:"MS_Description".into(),column:Some("v'中".into()),kind:Some("nvarchar".into()),precision:None,scale:None,length:Some(40),collation:Some("Latin1_General_100_BIN2".into()),value:Some("a'中\r\nGO".into()),binary:None}}
    #[test]fn descriptions_keep_unicode_newlines_quotes_collation_and_exact_target(){let p=property();let sql=p.render("ops'中","t]中").unwrap();assert!(sql.contains("CONVERT(nvarchar(20), N'a''中\r\nGO' COLLATE [Latin1_General_100_BIN2])"));assert!(sql.contains("@level0name=N'ops''中'"));assert!(sql.contains("@level1name=N't]中'"));assert!(sql.contains("@level2name=N'v''中'"));}
    #[test]fn numeric_binary_and_null_properties_do_not_turn_into_text(){let mut p=property();p.kind=Some("decimal".into());p.precision=Some(28);p.scale=Some(8);p.value=Some("123456789012345.12345678".into());assert_eq!(p.value_expression().unwrap(),"CONVERT(decimal(28,8), N'123456789012345.12345678')");p.kind=Some("varbinary".into());p.length=Some(3);p.binary=Some("0x00FF41".into());assert_eq!(p.value_expression().unwrap(),"CONVERT(varbinary(3), 0x00FF41)");p.kind=None;p.value=None;assert_eq!(p.value_expression().unwrap(),"NULL");}
    #[test]fn unreadable_or_unsupported_metadata_fails_instead_of_changing_type(){let mut p=property();p.kind=Some("datetime".into());assert!(p.value_expression().is_err());p.kind=Some("varchar".into());p.collation=None;assert!(p.value_expression().is_err());p.kind=Some("varbinary".into());p.binary=Some("0x0g".into());assert!(p.value_expression().is_err());}
}
