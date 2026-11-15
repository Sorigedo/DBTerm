use sqlx::{Connection, SqliteConnection};

#[path = "sql_file_reader.rs"]
#[allow(dead_code)] // This instance uses SQLite mode only; the import reader also serves other dialects.
mod reader;

fn statements(script: &str) -> Result<Vec<String>, String> {
    let mut reader = reader::SqlFileReader::new(std::io::Cursor::new(script.as_bytes()), false);
    reader.set_sqlite(true);
    let mut result = Vec::new();
    while let Some(statement) = reader.next_statement()? { result.push(statement); }
    Ok(result)
}

async fn transaction(conn: &mut SqliteConnection, statements: &[String]) -> Result<(), String> {
    let mut tx = conn.begin().await.map_err(|e| format!("开启结构修改事务失败: {e}"))?;
    let action = async {
        for statement in statements {
            sqlx::query(statement).execute(&mut *tx).await.map_err(|e| format!("结构修改失败: {e}\nSQL: {statement}"))?;
        }
        if sqlx::query("PRAGMA foreign_key_check").fetch_optional(&mut *tx).await.map_err(|e| format!("外键检查失败: {e}"))?.is_some() {
            return Err("外键完整性检查未通过".to_string());
        }
        Ok::<(), String>(())
    }.await;
    if let Err(error) = action {
        tx.rollback().await.map_err(|rollback| format!("{error}；回滚未确认: {rollback}"))?;
        return Err(format!("{error}；全部修改已回滚"));
    }
    tx.commit().await.map_err(|e| format!("提交失败，请核实数据库状态，勿盲目重试: {e}"))
}

pub(super) async fn simple(conn: &mut SqliteConnection, script: &str) -> Result<(), String> {
    use sqlparser::{ast::Statement, dialect::SQLiteDialect, parser::Parser};
    let statements = statements(script)?;
    let mut expected_target = None;
    for statement in &statements {
        let parsed = Parser::parse_sql(&SQLiteDialect {}, statement).map_err(|e| format!("无法安全识别 ALTER 语句: {e}"))?;
        if parsed.len() != 1 || !matches!(&parsed[0], Statement::AlterTable { .. }) {
            return Err("结构修改仅允许单条 ALTER TABLE，已拒绝额外语句".into());
        }
        if let Statement::AlterTable { name, .. } = &parsed[0] {
            if expected_target.as_ref().is_some_and(|expected| expected != name) {
                return Err("结构修改包含其他目标表，已拒绝执行".into());
            }
            expected_target = Some(name.clone());
        }
    }
    transaction(conn, &statements).await
}

pub(super) async fn rebuild(conn: &mut SqliteConnection, script: &str) -> Result<(), String> {
    let mut body = Vec::new();
    for statement in statements(script)? {
        use sqlparser::{dialect::SQLiteDialect, tokenizer::{Token, Tokenizer}};
        let tokens = Tokenizer::new(&SQLiteDialect {}, &statement).tokenize().map_err(|e| e.to_string())?;
        let words = tokens.iter().filter(|t| !matches!(t, Token::Whitespace(_))).collect::<Vec<_>>();
        let word = |i: usize| words.get(i).and_then(|t| if let Token::Word(w) = t { Some(w.value.to_ascii_uppercase()) } else { None });
        match word(0).as_deref() {
            Some("BEGIN" | "COMMIT" | "END") => continue,
            Some("PRAGMA") if matches!(word(1).as_deref(), Some("FOREIGN_KEYS" | "FOREIGN_KEY_CHECK")) => continue,
            _ => body.push(statement),
        }
    }
    let original: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let result = transaction(conn, &body).await;
    let restored = sqlx::query(if original == 0 { "PRAGMA foreign_keys=OFF" } else { "PRAGMA foreign_keys=ON" }).execute(&mut *conn).await.map_err(|e| format!("恢复外键设置失败: {e}"));
    match (result, restored) {
        (Ok(()), Ok(_)) => Ok(()),
        (Err(error), Ok(_)) => Err(error),
        (result, Err(error)) => Err(format!("{}；{error}", result.err().unwrap_or_else(|| "结构修改已提交".into()))),
    }
}
