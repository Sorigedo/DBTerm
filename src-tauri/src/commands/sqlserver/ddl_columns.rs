//! Render only catalog attributes actually read from the selected object.
//! This is one part of table scripting, not a complete table DDL implementation.
pub(super) struct ColumnDefinition {
    pub name: String,
    pub type_name: String,
    pub type_schema: Option<String>,
    pub user_defined: bool,
    pub max_length: i16,
    pub precision: u8,
    pub scale: u8,
    pub nullable: bool,
    pub identity: bool,
    pub seed: Option<String>,
    pub increment: Option<String>,
    pub not_for_replication: bool,
    pub default_definition: Option<String>,
    pub default_name: Option<String>,
    pub collation: Option<String>,
    pub computed: bool,
    pub expression: Option<String>,
    pub persisted: bool,
    pub rowguid: bool,
    pub sparse: bool,
    pub filestream: bool,
}

fn quote(name: &str) -> String { format!("[{}]", name.replace(']', "]]")) }

impl ColumnDefinition {
    pub fn render(&self) -> Result<String, String> {
        let mut sql = format!("  {}", quote(&self.name));
        if self.computed {
            let expression = self.expression.as_deref().filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("无法读取计算列 {} 的完整表达式，已停止生成DDL", self.name))?;
            sql.push_str(&format!(" AS {expression}"));
            if self.persisted { sql.push_str(" PERSISTED"); }
            // T-SQL computed column NOT NULL requires PERSISTED.
            if !self.nullable && self.persisted {
                sql.push_str(" NOT NULL");
            }
            return Ok(sql);
        }
        let type_sql = if self.user_defined {
            let schema = self.type_schema.as_deref().filter(|s| !s.is_empty())
                .ok_or_else(|| format!("无法读取字段 {} 的自定义类型schema", self.name))?;
            format!("{}.{}", quote(schema), quote(&self.type_name))
        } else {
            if self.type_name.is_empty() { return Err(format!("字段 {} 缺少类型定义", self.name)); }
            super::ss_format_coltype(&self.type_name, self.max_length, self.precision, self.scale)
        };
        sql.push_str(&format!(" {type_sql}"));
        if self.filestream { sql.push_str(" FILESTREAM"); }
        if let Some(collation) = self.collation.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(&format!(" COLLATE {}", quote(collation)));
        }
        if self.sparse { sql.push_str(" SPARSE"); }
        if self.identity {
            let seed = self.seed.as_deref().ok_or_else(|| format!("字段 {} 缺少IDENTITY种子", self.name))?;
            let increment = self.increment.as_deref().ok_or_else(|| format!("字段 {} 缺少IDENTITY步长", self.name))?;
            sql.push_str(&format!(" IDENTITY({seed},{increment})"));
            if self.not_for_replication { sql.push_str(" NOT FOR REPLICATION"); }
        }
        if self.rowguid { sql.push_str(" ROWGUIDCOL"); }
        sql.push_str(if self.nullable { " NULL" } else { " NOT NULL" });
        if let Some(definition) = self.default_definition.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Some(name) = self.default_name.as_deref() {
                sql.push_str(&format!(" CONSTRAINT {}", quote(name)));
            }
            sql.push_str(&format!(" DEFAULT {definition}"));
        } else if self.default_name.is_some() {
            return Err(format!("无法读取字段 {} 的默认约束定义", self.name));
        }
        Ok(sql)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn column() -> ColumnDefinition {
        ColumnDefinition {
            name: "v]中文".into(), type_name: "nvarchar".into(), type_schema: None,
            user_defined: false, max_length: 128, precision: 0, scale: 0,
            nullable: false, identity: false, seed: None, increment: None,
            not_for_replication: false, default_definition: None, default_name: None,
            collation: None, computed: false, expression: None, persisted: false,
            rowguid: false, sparse: false, filestream: false,
        }
    }
    #[test]
    fn computed_expression_is_preserved_instead_of_materialized_as_ordinary_column() {
        let mut c = column(); c.computed = true; c.expression = Some("(nullif([code],N''))".into());
        c.persisted = true;
        assert_eq!(c.render().unwrap(), "  [v]]中文] AS (nullif([code],N'')) PERSISTED NOT NULL");
        c.nullable = true; c.persisted = false;
        assert_eq!(c.render().unwrap(), "  [v]]中文] AS (nullif([code],N''))");
        c.expression = None; assert!(c.render().is_err());
    }
    #[test]
    fn nonpersisted_computed_inferred_nullability_does_not_add_invalid_not_null() {
        let mut c = column(); c.computed = true; c.expression = Some("(CONVERT([int],(1)))".into());
        assert_eq!(c.render().unwrap(), "  [v]]中文] AS (CONVERT([int],(1)))");
    }
    #[test]
    fn collation_named_default_and_unicode_text_are_preserved() {
        let mut c = column(); c.collation = Some("Latin1_General_100_BIN2".into());
        c.default_name = Some("DF_v]中文".into()); c.default_definition = Some("(N'a''中')".into());
        assert_eq!(c.render().unwrap(), "  [v]]中文] nvarchar(64) COLLATE [Latin1_General_100_BIN2] NOT NULL CONSTRAINT [DF_v]]中文] DEFAULT (N'a''中')");
        c.default_definition = None; assert!(c.render().is_err());
    }
    #[test]
    fn user_type_keeps_schema_and_case_and_does_not_append_underlying_length() {
        let mut c = column(); c.user_defined = true; c.type_name = "Money]Code".into(); c.type_schema = Some("ops]中".into());
        assert_eq!(c.render().unwrap(), "  [v]]中文] [ops]]中].[Money]]Code] NOT NULL");
        c.type_schema = None; assert!(c.render().is_err());
    }
    #[test]
    fn identity_replication_and_sparse_rowguid_attributes_are_not_invented_or_lost() {
        let mut c = column(); c.type_name = "bigint".into(); c.identity = true;
        assert!(c.render().is_err());
        c.seed = Some("-12".into()); c.increment = Some("7".into()); c.not_for_replication = true;
        assert_eq!(c.render().unwrap(), "  [v]]中文] bigint IDENTITY(-12,7) NOT FOR REPLICATION NOT NULL");
        let mut c = column(); c.type_name = "uniqueidentifier".into(); c.rowguid = true; c.nullable = true;
        assert_eq!(c.render().unwrap(), "  [v]]中文] uniqueidentifier ROWGUIDCOL NULL");
        c.rowguid = false; c.sparse = true; c.type_name = "nvarchar".into();
        assert_eq!(c.render().unwrap(), "  [v]]中文] nvarchar(64) SPARSE NULL");
    }
}
