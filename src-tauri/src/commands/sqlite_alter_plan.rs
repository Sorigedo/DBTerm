use super::AlterColDef;
use sqlx::Row;
use sqlparser::{ast::{ColumnOption, ColumnOptionDef, Statement}, dialect::SQLiteDialect, parser::Parser};

fn parse_table(raw: &str) -> Result<Statement, String> {
    let mut parsed = Parser::parse_sql(&SQLiteDialect {}, raw).map_err(|e| format!("原始 CREATE TABLE 无法安全解析: {e}"))?;
    if parsed.len() != 1 || !matches!(parsed.first(), Some(Statement::CreateTable(_))) {
        return Err("原始表结构不是单条标准 CREATE TABLE，已拒绝重建".into());
    }
    Ok(parsed.remove(0))
}

fn parse_column_type(input: &str) -> Result<sqlparser::ast::DataType, String> {
    let raw = format!("CREATE TABLE __dbterm_type_probe (x {input})");
    let parsed = parse_table(&raw)?;
    let Statement::CreateTable(table) = parsed else { unreachable!() };
    if table.columns.len() != 1 || !table.constraints.is_empty() || table.columns[0].collation.is_some() || !table.columns[0].options.is_empty() {
        return Err("字段类型不能附加列约束或其他 SQL，已拒绝重建".into());
    }
    Ok(table.columns[0].data_type.clone())
}

fn parse_default(input: &str) -> Result<sqlparser::ast::Expr, String> {
    let raw = format!("CREATE TABLE __dbterm_default_probe (x TEXT DEFAULT {input})");
    let parsed = parse_table(&raw)?;
    let Statement::CreateTable(table) = parsed else { unreachable!() };
    if table.columns.len() != 1 || table.columns[0].options.len() != 1 {
        return Err("默认值必须为单个 SQLite 表达式".into());
    }
    match &table.columns[0].options[0].option {
        ColumnOption::Default(expr) => Ok(expr.clone()),
        _ => Err("默认值解析失败，已拒绝重建".into()),
    }
}

fn validate_new_column(col: &AlterColDef) -> Result<(), String> {
    let proposed = super::col_def_sql(col);
    let parsed = parse_table(&format!("CREATE TABLE __dbterm_add_probe ({proposed})"))?;
    let Statement::CreateTable(table) = parsed else { unreachable!() };
    if table.columns.len() != 1 || !table.constraints.is_empty() || table.columns[0].name.value != col.new_name {
        return Err("新增字段不是单个合法列定义，已拒绝执行".into());
    }
    Ok(())
}

fn patch_existing_columns(raw: &str, cols: &[AlterColDef]) -> Result<String, String> {
    let mut parsed = parse_table(raw)?;
    let Statement::CreateTable(table) = &mut parsed else { unreachable!() };
    for input in cols {
        let Some(original) = &input.original_name else { continue };
        if input.is_deleted { continue; }
        let column = table.columns.iter_mut().find(|c| c.name.value == *original)
            .ok_or_else(|| format!("原始 DDL 中找不到字段 {original}"))?;
        if !input.generated_expr.is_empty() || input.generated_stored {
            return Err("当前向导不支持改写生成列定义".into());
        }
        if column.data_type.to_string().eq_ignore_ascii_case(&input.data_type) == false {
            column.data_type = parse_column_type(&input.data_type)?;
        }
        let old_not_null = column.options.iter().any(|o| matches!(o.option, ColumnOption::NotNull));
        if old_not_null != !input.nullable {
            if input.nullable { column.options.retain(|o| !matches!(o.option, ColumnOption::NotNull)); }
            else { column.options.push(ColumnOptionDef { name: None, option: ColumnOption::NotNull }); }
        }
        let old_default = column.options.iter().find_map(|o| match &o.option { ColumnOption::Default(expr) => Some(expr.to_string()), _ => None }).unwrap_or_default();
        if old_default != input.default_value {
            let value = if input.default_value.is_empty() { None } else { Some(parse_default(&input.default_value)?) };
            column.options.retain(|o| !matches!(o.option, ColumnOption::Default(_)));
            if let Some(value) = value { column.options.push(ColumnOptionDef { name: None, option: ColumnOption::Default(value) }); }
        }
    }
    Ok(parsed.to_string())
}

pub(super) async fn verify_change_set(
    conn: &mut sqlx::sqlite::SqliteConnection, table: &str, cols: &[AlterColDef],
) -> Result<&'static str, String> {
    let actual: Vec<_> = sqlx::query(&format!("PRAGMA main.table_xinfo({})", super::q_dq_s(table)))
        .fetch_all(&mut *conn).await.map_err(|e| format!("读取原表字段失败: {e}"))?;
    if actual.is_empty() { return Err("原表不存在或字段元数据为空，已拒绝修改".into()); }
    let mut original_names = std::collections::HashSet::new();
    let mut target_names = std::collections::HashSet::new();
    let mut rebuild = false;
    for col in cols {
        if col.new_name.is_empty() { return Err("字段名不能为空".into()); }
        if !col.is_deleted && !target_names.insert(col.new_name.to_ascii_lowercase()) {
            return Err("目标字段名重复，已拒绝修改".into());
        }
        if let Some(original) = &col.original_name {
            if !original_names.insert(original.to_ascii_lowercase()) {
                return Err("原字段重复，已拒绝修改".into());
            }
            let row = actual.iter().find(|r| r.try_get::<String,_>("name").ok().as_deref() == Some(original.as_str()))
                .ok_or_else(|| format!("原字段 {original} 已不存在，已拒绝修改"))?;
            let data_type: String = row.try_get("type").map_err(|e| e.to_string())?;
            let not_null: i64 = row.try_get("notnull").map_err(|e| e.to_string())?;
            let default: Option<String> = row.try_get("dflt_value").map_err(|e| e.to_string())?;
            let primary: i64 = row.try_get("pk").map_err(|e| e.to_string())?;
            let hidden: i64 = row.try_get("hidden").map_err(|e| e.to_string())?;
            if hidden == 1 { return Err(format!("字段 {original} 为虚拟表隐藏列，当前向导不支持无损修改")); }
            if !col.is_deleted {
                let expected_nullable = not_null == 0;
                if col.is_primary_key != (primary > 0) || !col.generated_expr.is_empty() || col.generated_stored {
                    return Err(format!("字段 {original} 的主键或生成列属性不能安全改写，已拒绝执行"));
                }
                if col.data_type != data_type || col.nullable != expected_nullable
                    || col.default_value != default.unwrap_or_default() {
                    if hidden != 0 { return Err(format!("生成字段 {original} 的属性不能安全重建，已拒绝执行")); }
                    rebuild = true;
                }
            }
        } else if !col.is_deleted {
            if col.is_primary_key || col.generated_stored {
                return Err(format!("新字段 {} 的主键或 STORED 生成列属性无法直接 ADD；当前向导已拒绝执行", col.new_name));
            }
            validate_new_column(col)?;
        }
    }
    if actual.iter().any(|r| r.try_get::<String,_>("name").ok().is_some_and(|name| !original_names.contains(&name.to_ascii_lowercase()))) {
        return Err("字段清单不包含原表全部字段，已拒绝执行不完整修改".into());
    }
    if rebuild {
        if cols.iter().any(|c| c.is_deleted || c.original_name.is_none() || c.original_name.as_deref() != Some(c.new_name.as_str())) {
            return Err("字段属性修改不能与新增、删除或重命名同时重建，请分别执行".into());
        }
        let raw: String = sqlx::query_scalar("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?")
            .bind(table).fetch_one(&mut *conn).await.map_err(|e| format!("读取原始表结构失败: {e}"))?;
        patch_existing_columns(&raw, cols)?;
        Ok("rebuild")
    } else { Ok("simple") }
}

pub(super) async fn build_rebuild_script(conn: &mut sqlx::sqlite::SqliteConnection, table: &str, cols: &[AlterColDef]) -> Result<String, String> {
    if verify_change_set(conn, table, cols).await? != "rebuild" { return Err("未检测到需要重建的属性修改".into()); }
    let raw: String = sqlx::query_scalar("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?")
        .bind(table).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    let mut target = parse_table(&patch_existing_columns(&raw, cols)?)?;
    let Statement::CreateTable(create) = &mut target else { unreachable!() };
    let stage = format!("__dbterm_alter_{}", uuid::Uuid::new_v4().simple());
    create.name = sqlparser::ast::ObjectName(vec![sqlparser::ast::Ident::with_quote('"', stage.clone())]);
    let has_rowid = !create.without_rowid;
    let stage_ddl = target.to_string();
    let (indexes, triggers, views) = super::get_table_indexes_triggers(conn, table).await?;
    if !views.is_empty() { return Err(format!("存在引用视图（{}），已拒绝重建", views.join(", "))); }
    let stage_q = super::q_dq_s(&stage);
    let original_q = super::q_dq_s(table);
    let metadata = sqlx::query(&format!("PRAGMA main.table_xinfo({original_q})")).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    let names = metadata.iter().filter_map(|r| {
        let hidden: i64 = r.try_get("hidden").ok()?;
        let name: String = r.try_get("name").ok()?;
        (hidden == 0).then(|| super::q_dq_s(&name))
    }).collect::<Vec<_>>();
    if names.is_empty() { return Err("没有可复制的普通字段，已拒绝重建".into()); }
    let rowid_alias = ["rowid", "_rowid_", "oid"].into_iter().find(|alias| {
        !metadata.iter().any(|r| r.try_get::<String,_>("name").ok().is_some_and(|name| name.eq_ignore_ascii_case(alias)))
    });
    if has_rowid && rowid_alias.is_none() { return Err("原表三个 rowid 别名均被字段覆盖，无法无损复制行标识，已拒绝重建".into()); }
    let rowid = rowid_alias.filter(|_| has_rowid).map(|alias| format!("{alias}, ")).unwrap_or_default();
    let mut script = format!("PRAGMA foreign_keys = OFF;\nBEGIN;\n{stage_ddl};\nINSERT INTO {stage_q} ({rowid}{}) SELECT {rowid}{} FROM {original_q};\n", names.join(", "), names.join(", "));
    let identity = if has_rowid { rowid_alias.unwrap().to_string() } else {
        let mut pk = metadata.iter().filter_map(|r| { let order: i64 = r.try_get("pk").ok()?; let name: String = r.try_get("name").ok()?; (order > 0).then_some((order,super::q_dq_s(&name))) }).collect::<Vec<_>>();
        if pk.is_empty() { return Err("WITHOUT ROWID 表缺少主键，无法验证重建数据".into()); }
        pk.sort_by_key(|(order,_)| *order);
        pk.into_iter().map(|(_,name)| name).collect::<Vec<_>>().join(", ")
    };
    let projection = format!("{identity}, {}", metadata.iter().filter_map(|r| {
        let name: String = r.try_get("name").ok()?;
        let hidden: i64 = r.try_get("hidden").ok()?;
        (hidden != 1).then(|| format!("typeof({0}), {0} COLLATE BINARY, hex({0})",super::q_dq_s(&name)))
    }).collect::<Vec<_>>().join(", "));
    script.push_str(&format!("CREATE TEMP TABLE __dbterm_copy_check(ok INTEGER CHECK(ok=1));\nINSERT INTO __dbterm_copy_check SELECT CASE WHEN NOT EXISTS(SELECT {projection} FROM {original_q} EXCEPT SELECT {projection} FROM {stage_q}) AND NOT EXISTS(SELECT {projection} FROM {stage_q} EXCEPT SELECT {projection} FROM {original_q}) AND (SELECT COUNT(*) FROM {original_q})=(SELECT COUNT(*) FROM {stage_q}) THEN 1 ELSE 0 END;\nDROP TABLE __dbterm_copy_check;\n"));
    if raw.to_ascii_uppercase().contains("AUTOINCREMENT") {
        let old_seq: Option<i64> = sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name=?").bind(table).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?;
        if let Some(old_seq) = old_seq {
            script.push_str(&format!("UPDATE sqlite_sequence SET seq=MAX(seq,{old_seq}) WHERE name={};\n", super::q_dq_s(&stage)));
        }
    }
    script.push_str(&format!("DROP TABLE {original_q};\nALTER TABLE {stage_q} RENAME TO {original_q};\n"));
    for statement in indexes.into_iter().chain(triggers) { script.push_str(&statement); script.push_str(";\n"); }
    script.push_str("PRAGMA foreign_key_check;\nCOMMIT;\nPRAGMA foreign_keys = ON;\n");
    Ok(script)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    fn col(original: &str, data_type: &str, nullable: bool, default_value: &str, primary_key: bool) -> AlterColDef {
        AlterColDef { original_name: Some(original.into()), new_name: original.into(), data_type: data_type.into(), nullable, default_value: default_value.into(), is_deleted: false, is_primary_key: primary_key, generated_expr: String::new(), generated_stored: false }
    }

    #[tokio::test]
    async fn existing_advanced_constraints_are_safe_when_metadata_is_unchanged() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT COLLATE NOCASE NOT NULL DEFAULT 'x' CHECK(length(v)>0), u INTEGER UNIQUE, parent_id INTEGER REFERENCES parent(id), g TEXT GENERATED ALWAYS AS (v||'!') VIRTUAL)").execute(&mut conn).await.unwrap();
        let cols = vec![col("id","INTEGER",true,"",true), col("v","TEXT",false,"'x'",false), col("u","INTEGER",true,"",false), col("parent_id","INTEGER",true,"",false), col("g","TEXT",true,"",false)];
        assert_eq!(verify_change_set(&mut conn,"t",&cols).await.unwrap(),"simple");
    }

    #[tokio::test]
    async fn changed_existing_attributes_require_rebuild_instead_of_silent_success() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE t(v TEXT NOT NULL DEFAULT 'x' CHECK(length(v)>0))").execute(&mut conn).await.unwrap();
        for changed in [col("v","BLOB",false,"'x'",false), col("v","TEXT",true,"'x'",false), col("v","TEXT",false,"'y'",false)] {
            assert_eq!(verify_change_set(&mut conn,"t",&[changed]).await.unwrap(),"rebuild");
        }
    }

    #[tokio::test]
    async fn incomplete_original_column_payload_and_new_primary_key_reject() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)").execute(&mut conn).await.unwrap();
        assert!(verify_change_set(&mut conn,"t",&[col("id","INTEGER",true,"",true)]).await.is_err());
        let mut new = col("new_id","INTEGER",true,"",true); new.original_name = None;
        assert!(verify_change_set(&mut conn,"t",&[col("id","INTEGER",true,"",true),col("v","TEXT",true,"",false),new]).await.is_err());
    }

    #[tokio::test]
    async fn rebuild_default_retains_check_unique_fk_collation_and_autoincrement() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(5); CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT COLLATE NOCASE NOT NULL DEFAULT 'x' CHECK(length(v)>0), u INTEGER UNIQUE, parent_id INTEGER REFERENCES parent(id)); INSERT INTO t(v,u,parent_id) VALUES('abc',1,5)").execute(&mut conn).await.unwrap();
        let cols = vec![col("id","INTEGER",true,"",true),col("v","TEXT",false,"'y'",false),col("u","INTEGER",true,"",false),col("parent_id","INTEGER",true,"",false)];
        let script = build_rebuild_script(&mut conn,"t",&cols).await.unwrap();
        super::super::alter_execute::rebuild(&mut conn,&script).await.unwrap();
        let ddl: String = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE name='t'").fetch_one(&mut conn).await.unwrap();
        for required in ["AUTOINCREMENT","COLLATE NOCASE","CHECK","UNIQUE","REFERENCES parent","DEFAULT 'y'"] { assert!(ddl.to_ascii_uppercase().contains(&required.to_ascii_uppercase()), "missing {required}: {ddl}"); }
        let value: String = sqlx::query_scalar("SELECT v FROM t WHERE id=1").fetch_one(&mut conn).await.unwrap();
        assert_eq!(value,"abc");
    }

    #[tokio::test]
    async fn type_change_preserves_storage_or_rolls_back_before_drop() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES(1,'001')").execute(&mut conn).await.unwrap();
        let cols = vec![col("id","INTEGER",true,"",true),col("v","INTEGER",true,"",false)];
        let script = build_rebuild_script(&mut conn,"t",&cols).await.unwrap();
        assert!(super::super::alter_execute::rebuild(&mut conn,&script).await.is_err());
        let value: String = sqlx::query_scalar("SELECT v FROM t WHERE id=1").fetch_one(&mut conn).await.unwrap();
        assert_eq!(value,"001");
        let dtype: String = sqlx::query_scalar("SELECT type FROM pragma_table_info('t') WHERE name='v'").fetch_one(&mut conn).await.unwrap();
        assert_eq!(dtype,"TEXT");
    }

    #[tokio::test]
    async fn rebuild_retains_autoincrement_high_watermark() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT DEFAULT 'x'); INSERT INTO t(id) VALUES(50); DELETE FROM t WHERE id=50;").execute(&mut conn).await.unwrap();
        let cols = vec![col("id","INTEGER",true,"",true),col("v","TEXT",true,"'y'",false)];
        let script = build_rebuild_script(&mut conn,"t",&cols).await.unwrap();
        super::super::alter_execute::rebuild(&mut conn,&script).await.unwrap();
        sqlx::query("INSERT INTO t(v) VALUES('z')").execute(&mut conn).await.unwrap();
        let id: i64 = sqlx::query_scalar("SELECT id FROM t").fetch_one(&mut conn).await.unwrap();
        assert_eq!(id,51);
    }
}
