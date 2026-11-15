//! Rowstore index definitions; no fallback from unsupported index types.
use super::SsEntry;
use std::collections::BTreeMap;

const INDEX_SQL: &str = "SELECT i.index_id,i.name,i.type,i.is_unique,i.is_primary_key,i.is_unique_constraint,i.fill_factor,i.is_padded,i.ignore_dup_key,i.allow_row_locks,i.allow_page_locks,i.is_disabled,i.has_filter,i.filter_definition,ds.name,ds.type,kc.name FROM sys.indexes i LEFT JOIN sys.data_spaces ds ON ds.data_space_id=i.data_space_id LEFT JOIN sys.key_constraints kc ON kc.parent_object_id=i.object_id AND kc.unique_index_id=i.index_id WHERE i.object_id=OBJECT_ID(@P1) AND i.index_id>0 AND i.is_hypothetical=0 ORDER BY i.index_id";
const COLUMN_SQL: &str = "SELECT ic.index_id,c.name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column,ic.index_column_id FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=OBJECT_ID(@P1) ORDER BY ic.index_id,ic.index_column_id";

fn quote(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}
fn toggle(v: bool) -> &'static str {
    if v {
        "ON"
    } else {
        "OFF"
    }
}

struct IndexColumn {
    name: String,
    ordinal: i32,
    descending: bool,
    included: bool,
}
struct IndexDefinition {
    name: String,
    kind: u8,
    unique: bool,
    primary: bool,
    constraint: bool,
    constraint_name: Option<String>,
    fill: u8,
    padded: bool,
    ignore_duplicates: bool,
    row_locks: bool,
    page_locks: bool,
    disabled: bool,
    has_filter: bool,
    filter: Option<String>,
    data_space: Option<String>,
    data_space_type: Option<String>,
    columns: Vec<IndexColumn>,
}
impl IndexDefinition {
    fn fragments(&self, table: &str) -> Result<(Option<String>, Vec<String>), String> {
        let kind = match self.kind {
            1 => "CLUSTERED",
            2 => "NONCLUSTERED",
            _ => {
                return Err(format!(
                    "索引 {} 的类型 {} 尚未完整脚本化，已停止生成DDL",
                    self.name, self.kind
                ))
            }
        };
        let mut keys = self
            .columns
            .iter()
            .filter(|c| c.ordinal > 0 && !c.included)
            .collect::<Vec<_>>();
        keys.sort_by_key(|c| c.ordinal);
        if keys.is_empty() {
            return Err(format!("索引 {} 缺少键列定义", self.name));
        }
        for (n, c) in keys.iter().enumerate() {
            if c.ordinal != n as i32 + 1 {
                return Err(format!("索引 {} 键列顺序不完整", self.name));
            }
        }
        let keys = keys
            .iter()
            .map(|c| {
                format!(
                    "{} {}",
                    quote(&c.name),
                    if c.descending { "DESC" } else { "ASC" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let includes = self
            .columns
            .iter()
            .filter(|c| c.included)
            .map(|c| quote(&c.name))
            .collect::<Vec<_>>();
        let options=format!("PAD_INDEX = {}, FILLFACTOR = {}, IGNORE_DUP_KEY = {}, ALLOW_ROW_LOCKS = {}, ALLOW_PAGE_LOCKS = {}",toggle(self.padded),self.fill,toggle(self.ignore_duplicates),toggle(self.row_locks),toggle(self.page_locks));
        let placement = match (self.data_space.as_deref(), self.data_space_type.as_deref()) {
            (Some(name), Some("FG")) => format!(" ON {}", quote(name)),
            (None, None) => String::new(),
            _ => return Err(format!("索引 {} 的分区/存储位置尚未完整脚本化", self.name)),
        };
        let mut after = Vec::new();
        let inline = if self.primary || self.constraint {
            let name = self
                .constraint_name
                .as_deref()
                .ok_or_else(|| format!("索引 {} 的约束名不可见", self.name))?;
            if self.has_filter || !includes.is_empty() {
                return Err(format!("键约束 {} 的目录属性不一致", name));
            }
            if name != self.name {
                return Err(format!(
                    "键约束 {} 与索引 {} 名称不同，尚未完整脚本化",
                    name, self.name
                ));
            }
            Some(format!(
                "  CONSTRAINT {} {} {kind} ({keys}) WITH ({options}){placement}",
                quote(name),
                if self.primary {
                    "PRIMARY KEY"
                } else {
                    "UNIQUE"
                }
            ))
        } else {
            let mut sql = format!(
                "CREATE {}{kind} INDEX {} ON {table} ({keys})",
                if self.unique { "UNIQUE " } else { "" },
                quote(&self.name)
            );
            if !includes.is_empty() {
                sql.push_str(&format!(" INCLUDE ({})", includes.join(", ")));
            }
            if self.has_filter {
                let filter = self
                    .filter
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| format!("索引 {} 的筛选表达式不可见", self.name))?;
                sql.push_str(&format!(" WHERE {filter}"));
            }
            sql.push_str(&format!(" WITH ({options}){placement};"));
            after.push(sql);
            None
        };
        if self.disabled {
            after.push(format!(
                "ALTER INDEX {} ON {table} DISABLE;",
                quote(&self.name)
            ));
        }
        Ok((inline, after))
    }
}

pub(super) async fn read_indexes(
    entry: &mut SsEntry,
    db_context: &str,
    object_ref: &str,
    table_ref: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut query = tiberius::Query::new(format!("{db_context}{INDEX_SQL}"));
    query.bind(object_ref);
    let rows = query
        .query(&mut entry.client)
        .await
        .map_err(|e| format!("读取索引定义失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("读取索引定义失败: {e}"))?;
    let mut indexes = BTreeMap::new();
    for r in rows {
        let text = |n| r.get::<&str, _>(n).map(str::to_string);
        let bit = |n| {
            r.get::<bool, _>(n)
                .ok_or_else(|| format!("索引属性 {n} 不可读"))
        };
        let id = r.get::<i32, _>(0).ok_or("索引ID不可读")?;
        indexes.insert(
            id,
            IndexDefinition {
                name: text(1).ok_or("索引名称不可读")?,
                kind: r.get::<u8, _>(2).ok_or("索引类型不可读")?,
                unique: bit(3)?,
                primary: bit(4)?,
                constraint: bit(5)?,
                fill: r.get::<u8, _>(6).ok_or("索引填充因子不可读")?,
                padded: bit(7)?,
                ignore_duplicates: bit(8)?,
                row_locks: bit(9)?,
                page_locks: bit(10)?,
                disabled: bit(11)?,
                has_filter: bit(12)?,
                filter: text(13),
                data_space: text(14),
                data_space_type: text(15),
                constraint_name: text(16),
                columns: Vec::new(),
            },
        );
    }
    let mut query = tiberius::Query::new(format!("{db_context}{COLUMN_SQL}"));
    query.bind(object_ref);
    let rows = query
        .query(&mut entry.client)
        .await
        .map_err(|e| format!("读取索引列失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("读取索引列失败: {e}"))?;
    for r in rows {
        let id = r.get::<i32, _>(0).ok_or("索引列ID不可读")?;
        if let Some(index) = indexes.get_mut(&id) {
            index.columns.push(IndexColumn {
                name: r.get::<&str, _>(1).ok_or("索引列名不可读")?.to_string(),
                ordinal: r.get::<u8, _>(2).ok_or("索引列顺序不可读")? as i32,
                descending: r.get::<bool, _>(3).ok_or("索引方向不可读")?,
                included: r.get::<bool, _>(4).ok_or("索引INCLUDE属性不可读")?,
            });
        }
    }
    let (mut inline, mut after) = (Vec::new(), Vec::new());
    for index in indexes.values() {
        let (line, statements) = index.fragments(table_ref)?;
        if let Some(line) = line {
            inline.push(line);
        }
        after.extend(statements);
    }
    Ok((inline, after))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn index() -> IndexDefinition {
        IndexDefinition {
            name: "ix]中文".into(),
            kind: 2,
            unique: true,
            primary: false,
            constraint: false,
            constraint_name: None,
            fill: 80,
            padded: true,
            ignore_duplicates: false,
            row_locks: true,
            page_locks: false,
            disabled: false,
            has_filter: true,
            filter: Some("([v] IS NOT NULL)".into()),
            data_space: Some("fg]中".into()),
            data_space_type: Some("FG".into()),
            columns: vec![
                IndexColumn {
                    name: "b".into(),
                    ordinal: 2,
                    descending: false,
                    included: false,
                },
                IndexColumn {
                    name: "a]中".into(),
                    ordinal: 1,
                    descending: true,
                    included: false,
                },
                IndexColumn {
                    name: "payload".into(),
                    ordinal: 0,
                    descending: false,
                    included: true,
                },
            ],
        }
    }
    #[test]
    fn unique_filtered_covering_index_preserves_order_direction_and_options() {
        let i = index();
        let (inline, sql) = i.fragments("[B].[ops].[t]").unwrap();
        assert!(inline.is_none());
        assert_eq!(sql,vec!["CREATE UNIQUE NONCLUSTERED INDEX [ix]]中文] ON [B].[ops].[t] ([a]]中] DESC, [b] ASC) INCLUDE ([payload]) WHERE ([v] IS NOT NULL) WITH (PAD_INDEX = ON, FILLFACTOR = 80, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = OFF) ON [fg]]中];"]);
    }
    #[test]
    fn named_primary_key_keeps_nonclustered_descending_and_disabled_state() {
        let mut i = index();
        i.primary = true;
        i.constraint_name = Some(i.name.clone());
        i.has_filter = false;
        i.columns.retain(|c| !c.included);
        i.disabled = true;
        let (line, after) = i.fragments("[ops].[t]").unwrap();
        assert!(line.unwrap().starts_with(
            "  CONSTRAINT [ix]]中文] PRIMARY KEY NONCLUSTERED ([a]]中] DESC, [b] ASC)"
        ));
        assert_eq!(after, vec!["ALTER INDEX [ix]]中文] ON [ops].[t] DISABLE;"]);
    }
    #[test]
    fn unique_constraint_is_not_converted_to_plain_unique_index() {
        let mut i = index();
        i.constraint = true;
        i.constraint_name = Some(i.name.clone());
        i.has_filter = false;
        i.columns.retain(|c| !c.included);
        assert!(i
            .fragments("[t]")
            .unwrap()
            .0
            .unwrap()
            .contains(" UNIQUE NONCLUSTERED "));
    }
    #[test]
    fn unreadable_filter_or_key_or_partition_is_not_silently_omitted() {
        let mut i = index();
        i.filter = None;
        assert!(i.fragments("[t]").is_err());
        i.has_filter = false;
        i.columns.clear();
        assert!(i.fragments("[t]").is_err());
        let mut i = index();
        i.data_space_type = Some("PS".into());
        assert!(i.fragments("[t]").is_err());
        i.kind = 5;
        assert!(i.fragments("[t]").is_err());
    }
}
