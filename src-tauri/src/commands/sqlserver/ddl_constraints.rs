//! Preserve foreign/check constraint definitions and enforcement flags.
use super::SsEntry;
use std::collections::BTreeMap;
const FK_SQL:&str="SELECT fk.object_id,fk.name,s.name,t.name,fk.delete_referential_action,fk.update_referential_action,fk.is_not_for_replication,fk.is_disabled,fk.is_not_trusted,fkc.constraint_column_id,pc.name,rc.name FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.tables t ON t.object_id=fk.referenced_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id WHERE fk.parent_object_id=OBJECT_ID(@P1) ORDER BY fk.object_id,fkc.constraint_column_id";
const CHECK_SQL:&str="SELECT name,definition,is_not_for_replication,is_disabled,is_not_trusted FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(@P1) ORDER BY object_id";
fn q(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}
fn state(table: &str, name: &str, disabled: bool, trusted: bool) -> String {
    format!(
        "ALTER TABLE {table} {}CONSTRAINT {};",
        if disabled {
            "NOCHECK "
        } else if trusted {
            "WITH CHECK CHECK "
        } else {
            "CHECK "
        },
        q(name)
    )
}
fn action(v: u8) -> Result<&'static str, String> {
    match v {
        0 => Ok("NO ACTION"),
        1 => Ok("CASCADE"),
        2 => Ok("SET NULL"),
        3 => Ok("SET DEFAULT"),
        _ => Err("外键引用动作不可识别".into()),
    }
}
struct ForeignKey {
    name: String,
    schema: String,
    table: String,
    delete: u8,
    update: u8,
    replication: bool,
    disabled: bool,
    untrusted: bool,
    columns: Vec<(i32, String, String)>,
}
impl ForeignKey {
    fn render(&self, table: &str) -> Result<String, String> {
        if self.columns.is_empty() {
            return Err(format!("外键 {} 缺少列映射", self.name));
        }
        let mut columns = self.columns.iter().collect::<Vec<_>>();
        columns.sort_by_key(|c| c.0);
        for (n, c) in columns.iter().enumerate() {
            if c.0 != n as i32 + 1 {
                return Err(format!("外键 {} 列映射不完整", self.name));
            }
        }
        let from = columns
            .iter()
            .map(|c| q(&c.1))
            .collect::<Vec<_>>()
            .join(", ");
        let to = columns
            .iter()
            .map(|c| q(&c.2))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("ALTER TABLE {table} WITH {} ADD CONSTRAINT {} FOREIGN KEY ({from}) REFERENCES {}.{} ({to}) ON DELETE {} ON UPDATE {}{};\n{}",if self.untrusted||self.disabled{"NOCHECK"}else{"CHECK"},q(&self.name),q(&self.schema),q(&self.table),action(self.delete)?,action(self.update)?,if self.replication{" NOT FOR REPLICATION"}else{""},state(table,&self.name,self.disabled,!self.untrusted)))
    }
}
fn check(
    table: &str,
    name: &str,
    definition: &str,
    replication: bool,
    disabled: bool,
    untrusted: bool,
) -> Result<String, String> {
    if definition.trim().is_empty() {
        return Err(format!("检查约束 {name} 定义不可读"));
    }
    Ok(format!(
        "ALTER TABLE {table} WITH {} ADD CONSTRAINT {} CHECK{} {definition};\n{}",
        if untrusted || disabled {
            "NOCHECK"
        } else {
            "CHECK"
        },
        q(name),
        if replication {
            " NOT FOR REPLICATION"
        } else {
            ""
        },
        state(table, name, disabled, !untrusted)
    ))
}
pub(super) async fn read_constraints(
    entry: &mut SsEntry,
    context: &str,
    object: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut query = tiberius::Query::new(format!("{context}{FK_SQL}"));
    query.bind(object);
    let rows = query
        .query(&mut entry.client)
        .await
        .map_err(|e| format!("读取外键失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("读取外键失败: {e}"))?;
    let mut keys = BTreeMap::<i32, ForeignKey>::new();
    for r in rows {
        let text = |i| {
            r.get::<&str, _>(i)
                .map(str::to_string)
                .ok_or("外键定义不可读".to_string())
        };
        let bit = |i| r.get::<bool, _>(i).ok_or("外键状态不可读".to_string());
        let id = r.get::<i32, _>(0).ok_or("外键ID不可读")?;
        if !keys.contains_key(&id) {
            keys.insert(
                id,
                ForeignKey {
                    name: text(1)?,
                    schema: text(2)?,
                    table: text(3)?,
                    delete: r.get::<u8, _>(4).ok_or("外键删除动作不可读")?,
                    update: r.get::<u8, _>(5).ok_or("外键更新动作不可读")?,
                    replication: bit(6)?,
                    disabled: bit(7)?,
                    untrusted: bit(8)?,
                    columns: Vec::new(),
                },
            );
        }
        keys.get_mut(&id).ok_or("外键映射不可读")?.columns.push((
            r.get::<i32, _>(9).ok_or("外键列顺序不可读")?,
            text(10)?,
            text(11)?,
        ));
    }
    let mut result = keys
        .values()
        .map(|key| key.render(table))
        .collect::<Result<Vec<_>, _>>()?;
    let mut query = tiberius::Query::new(format!("{context}{CHECK_SQL}"));
    query.bind(object);
    let rows = query
        .query(&mut entry.client)
        .await
        .map_err(|e| format!("读取检查约束失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("读取检查约束失败: {e}"))?;
    for r in rows {
        result.push(check(
            table,
            r.get::<&str, _>(0).ok_or("检查约束名不可读")?,
            r.get::<&str, _>(1).ok_or("检查约束表达式不可读")?,
            r.get::<bool, _>(2).ok_or("检查约束复制属性不可读")?,
            r.get::<bool, _>(3).ok_or("检查约束状态不可读")?,
            r.get::<bool, _>(4).ok_or("检查约束信任属性不可读")?,
        )?);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composite_foreign_key_keeps_mapping_actions_and_state() {
        let key = ForeignKey {
            name: "fk]中".into(),
            schema: "ops]中".into(),
            table: "parent".into(),
            delete: 1,
            update: 2,
            replication: true,
            disabled: false,
            untrusted: true,
            columns: vec![(2, "b".into(), "y".into()), (1, "a".into(), "x".into())],
        };
        assert_eq!(key.render("[db].[ops].[t]").unwrap(),"ALTER TABLE [db].[ops].[t] WITH NOCHECK ADD CONSTRAINT [fk]]中] FOREIGN KEY ([a], [b]) REFERENCES [ops]]中].[parent] ([x], [y]) ON DELETE CASCADE ON UPDATE SET NULL NOT FOR REPLICATION;\nALTER TABLE [db].[ops].[t] CHECK CONSTRAINT [fk]]中];");
    }
    #[test]
    fn check_expression_unicode_and_disabled_trust_are_preserved() {
        assert_eq!(check("[t]","ck]中","([v]<>N'a''中')",true,true,true).unwrap(),"ALTER TABLE [t] WITH NOCHECK ADD CONSTRAINT [ck]]中] CHECK NOT FOR REPLICATION ([v]<>N'a''中');\nALTER TABLE [t] NOCHECK CONSTRAINT [ck]]中];");
        assert!(check("[t]", "ck", "", false, false, false).is_err());
        assert_eq!(
            state("[t]", "ck", false, true),
            "ALTER TABLE [t] WITH CHECK CHECK CONSTRAINT [ck];"
        );
    }
    #[test]
    fn unknown_reference_action_is_not_converted_to_no_action() {
        assert!(action(255).is_err());
    }
}
