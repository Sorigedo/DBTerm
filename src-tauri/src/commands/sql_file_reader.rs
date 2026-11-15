use std::io::BufRead;

const MAX_STATEMENT: usize = 16 * 1024 * 1024;
#[derive(PartialEq)]
enum State { Normal, Quote(u8, bool), LineComment, Block(usize), Dollar(Vec<u8>) }

pub(super) struct SqlFileReader<R> {
    reader: R, line: Vec<u8>, pos: usize, delimiter: Vec<u8>,
    mysql: bool, sqlite: bool, no_backslash: bool, ansi_quotes: bool, pg_backslash: bool, first_line: bool,
}
impl<R: BufRead> SqlFileReader<R> {
    pub(super) fn new(reader: R, mysql: bool) -> Self {
        Self { reader, line: Vec::new(), pos: 0, delimiter: b";".to_vec(), mysql, sqlite: false, no_backslash: false, ansi_quotes: false, pg_backslash: false, first_line: true }
    }
    pub(super) fn set_lexical_mode(&mut self, no_backslash: bool, ansi_quotes: bool) {
        self.no_backslash = no_backslash; self.ansi_quotes = ansi_quotes;
    }
    pub(super) fn set_sqlite(&mut self, sqlite: bool) { self.sqlite=sqlite; }
    pub(super) fn set_postgres_strings(&mut self, standard: bool) { self.pg_backslash = !standard; }
    fn load_line(&mut self) -> Result<bool,String> {
        self.line.clear(); self.pos=0;
        loop {
            let bytes = self.reader.fill_buf().map_err(|e| format!("读取 SQL 文件失败: {e}"))?;
            if bytes.is_empty() { return Ok(!self.line.is_empty()); }
            let n = bytes.iter().position(|b| *b == b'\n').map_or(bytes.len(), |i| i+1);
            if self.line.len().saturating_add(n) > MAX_STATEMENT { return Err("SQL 单行超过 16 MiB 安全预算，已停止，未执行后续内容".into()); }
            self.line.extend_from_slice(&bytes[..n]); self.reader.consume(n);
            if self.first_line && self.line.starts_with(&[0xef,0xbb,0xbf]) { self.line.drain(..3); }
            self.first_line=false;
            if self.line.last() == Some(&b'\n') { return Ok(true); }
        }
    }
    pub(super) fn next_statement(&mut self) -> Result<Option<String>,String> {
        let mut out=Vec::new(); let mut state=State::Normal; let mut has_sql=false;
        loop {
            if self.pos >= self.line.len() && !self.load_line()? {
                if state != State::Normal && state != State::LineComment { return Err("SQL 文件存在未闭合的字符串、标识符、注释或函数体，已停止".into()); }
                return if has_sql { String::from_utf8(out).map(|s| Some(s.trim().to_string())).map_err(|_| "SQL 文件不是有效 UTF-8".into()) } else { Ok(None) };
            }
            if self.pos==0 && state==State::Normal && self.mysql {
                let line=std::str::from_utf8(&self.line).map_err(|_| "SQL 文件不是有效 UTF-8")?.trim().trim_start_matches('\u{feff}');
                let mut words=line.split_whitespace();
                if words.next().is_some_and(|w| w.eq_ignore_ascii_case("DELIMITER")) {
                    if has_sql { return Err("DELIMITER 出现在尚未结束的 SQL 中，已停止".into()); }
                    let delimiter=words.next().ok_or("DELIMITER 缺少分隔符")?;
                    if words.next().is_some() || delimiter.len()>32 || delimiter.is_empty() { return Err("DELIMITER 指令格式无效".into()); }
                    self.delimiter=delimiter.as_bytes().to_vec(); self.pos=self.line.len(); continue;
                }
            }
            if out.len()>=MAX_STATEMENT { return Err("单条 SQL 超过 16 MiB 安全预算，已停止，未执行后续内容".into()); }
            let c=self.line[self.pos]; let next=self.line.get(self.pos+1).copied();
            if c == 0 { return Err("SQL 文件包含 NUL 字节，已停止，未执行后续内容".into()); }
            match &mut state {
                State::Normal => {
                    if self.line[self.pos..].starts_with(&self.delimiter) {
                        if self.sqlite {
                            let original_len=out.len();out.extend_from_slice(&self.delimiter);out.push(0);
                            // SQLite's grammar handles trigger BEGIN/END and CASE/END correctly.
                            // The buffer is NUL-terminated; embedded NUL bytes are rejected above.
                            let complete=unsafe { libsqlite3_sys::sqlite3_complete(out.as_ptr().cast()) } != 0;
                            out.truncate(original_len + if complete { 0 } else { self.delimiter.len() });
                            if !complete { self.pos+=self.delimiter.len();continue; }
                        }
                        self.pos+=self.delimiter.len();
                        if has_sql { return String::from_utf8(out).map(|s| Some(s.trim().to_string())).map_err(|_| "SQL 文件不是有效 UTF-8".into()); }
                        out.clear(); continue;
                    }
                    if c==b'-' && next==Some(b'-') && (!self.mysql || self.line.get(self.pos+2).map_or(true, |b| b.is_ascii_whitespace())) { state=State::LineComment; }
                    else if self.mysql && c==b'#' { state=State::LineComment; }
                    else if c==b'/' && next==Some(b'*') {
                        if self.line.get(self.pos+2)==Some(&b'!') || self.line[self.pos..].starts_with(b"/*M!") { has_sql=true; }
                        out.extend_from_slice(b"/*"); self.pos+=2; state=State::Block(1); continue;
                    } else if self.sqlite && c==b'[' {
                        has_sql=true;state=State::Quote(b']',false);
                    } else if matches!(c,b'\''|b'"'|b'`') {
                        has_sql=true;
                        let pg_escape = !self.mysql && c==b'\'' && out.last().is_some_and(|b| matches!(b,b'e'|b'E')) && (out.len()<2 || !out[out.len()-2].is_ascii_alphanumeric());
                        let escape = pg_escape || self.pg_backslash && c==b'\'' || self.mysql && !self.no_backslash && (c==b'\'' || c==b'"' && !self.ansi_quotes);
                        state=State::Quote(c,escape);
                    }
                    else if !self.mysql && c==b'$' {
                        let end=self.line[self.pos+1..].iter().position(|b| *b==b'$').map(|i| self.pos+i+1);
                        if let Some(end)=end {
                            if self.line[self.pos+1..end].iter().all(|b| b.is_ascii_alphanumeric()||*b==b'_') {
                                let tag=self.line[self.pos..=end].to_vec();out.extend_from_slice(&tag);self.pos=end+1;state=State::Dollar(tag);has_sql=true;continue;
                            }
                        }
                        has_sql=true;
                    } else if !c.is_ascii_whitespace() { has_sql=true; }
                }
                State::Quote(q, escape) => {
                    let backslash = c==b'\\' && *escape;
                    if backslash { out.push(c);self.pos+=1;if self.pos<self.line.len(){out.push(self.line[self.pos]);self.pos+=1;}continue; }
                    if c==*q {
                        if next==Some(*q) {out.push(c);out.push(c);self.pos+=2;continue;}
                        state=State::Normal;
                    }
                }
                State::LineComment => if c==b'\n' { state=State::Normal; },
                State::Block(depth) => {
                    if !self.mysql && c==b'/' && next==Some(b'*') {*depth+=1;out.extend_from_slice(b"/*");self.pos+=2;continue;}
                    if c==b'*' && next==Some(b'/') {*depth-=1;out.extend_from_slice(b"*/");self.pos+=2;if *depth==0{state=State::Normal;}continue;}
                }
                State::Dollar(tag) => if self.line[self.pos..].starts_with(tag) {let n=tag.len();out.extend_from_slice(tag);self.pos+=n;state=State::Normal;continue;},
            }
            out.push(c);self.pos+=1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(sql: &str, mysql: bool) -> Result<Vec<String>, String> {
        let mut reader = SqlFileReader::new(std::io::Cursor::new(sql.as_bytes()), mysql);
        let mut out = Vec::new();
        while let Some(stmt) = reader.next_statement()? { out.push(stmt); }
        Ok(out)
    }
    #[test]
    fn literals_and_executable_comments_are_preserved() {
        let sql = "INSERT INTO t VALUES('/*keep*/;--literal', 'x'); SELECT 2;\n/*!40101 SET NAMES utf8mb4 */;";
        assert_eq!(parse(sql, true).unwrap(), ["INSERT INTO t VALUES('/*keep*/;--literal', 'x')", "SELECT 2", "/*!40101 SET NAMES utf8mb4 */"]);
        assert_eq!(parse("/*M!100100 SET @keep=1 */;",true).unwrap(),["/*M!100100 SET @keep=1 */"]);
    }
    #[test]
    fn delimiter_and_dollar_body_preserve_statement_text() {
        assert_eq!(parse("DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT ';'; SELECT 2; END;;\nDELIMITER ;\nSELECT 3;", true).unwrap(), ["CREATE PROCEDURE p() BEGIN SELECT ';'; SELECT 2; END", "SELECT 3"]);
        assert_eq!(parse("CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM ';'; END $body$ LANGUAGE plpgsql;SELECT 2;", false).unwrap().len(), 2);
    }
    #[test]
    fn sql_mode_changes_apply_before_parsing_following_statement() {
        let mut r = SqlFileReader::new(std::io::Cursor::new(b"SET sql_mode='NO_BACKSLASH_ESCAPES';SELECT 'x\\';SELECT 2;"), true);
        assert_eq!(r.next_statement().unwrap().unwrap(), "SET sql_mode='NO_BACKSLASH_ESCAPES'");
        r.set_lexical_mode(true, false);
        assert_eq!(r.next_statement().unwrap().unwrap(), "SELECT 'x\\'");
        assert_eq!(r.next_statement().unwrap().unwrap(), "SELECT 2");
    }
    #[test]
    fn incomplete_tokens_and_midstatement_directives_reject() {
        assert!(parse("SELECT 'unterminated", true).is_err());
        assert!(parse("SELECT 1\nDELIMITER $$\n", true).is_err());
        assert!(parse("SELECT /* unclosed", true).is_err());
    }
    #[tokio::test]
    #[ignore = "requires disposable local MySQL DBTERM_TEST_MYSQL_PORT"]
    async fn mysql_execution_preserves_version_comments_delimiters_modes_and_stops_on_error() {
        use sqlx::Connection;
        let port=std::env::var("DBTERM_TEST_MYSQL_PORT").unwrap();
        let mut conn=sqlx::MySqlConnection::connect(&format!("mysql://root@127.0.0.1:{port}/mysql")).await.unwrap();
        let db=format!("dbterm_import_{}",uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {db}")).execute(&mut conn).await.unwrap();
        sqlx::Executor::execute(&mut conn,sqlx::raw_sql(&format!("USE {db}"))).await.unwrap();
        let script=r#"/*!40101 SET @dbterm_import_marker=17 */;
CREATE TABLE t(id INT PRIMARY KEY,v VARCHAR(100));INSERT INTO t VALUES(1,'/*keep*/;--literal');
DELIMITER ;;
CREATE PROCEDURE p() BEGIN INSERT INTO t VALUES(2,'routine;value'); END;;
DELIMITER ;
CALL p();SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';INSERT INTO t VALUES(3,'tail\');
INSERT INTO t VALUES(1,'duplicate');INSERT INTO t VALUES(4,'must-not-run');"#;
        let mut reader=SqlFileReader::new(std::io::Cursor::new(script),true);
        let mut executed=0;let mut failed=0;
        loop {
            let mode:String=sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut conn).await.unwrap();
            reader.set_lexical_mode(mode.split(',').any(|m|m=="NO_BACKSLASH_ESCAPES"),mode.split(',').any(|m|m=="ANSI_QUOTES"));
            let Some(statement)=reader.next_statement().unwrap() else {break};
            match sqlx::Executor::execute(&mut conn,sqlx::raw_sql(&statement)).await {Ok(_)=>executed+=1,Err(_)=>{failed+=1;break;}}
        }
        let rows:Vec<(i32,String)>=sqlx::query_as("SELECT id,v FROM t ORDER BY id").fetch_all(&mut conn).await.unwrap();
        let marker:i64=sqlx::query_scalar("SELECT @dbterm_import_marker").fetch_one(&mut conn).await.unwrap();
        sqlx::query(&format!("DROP DATABASE {db}")).execute(&mut conn).await.unwrap();
        assert_eq!((executed,failed),(7,1));assert_eq!(marker,17);
        assert_eq!(rows,vec![(1,"/*keep*/;--literal".into()),(2,"routine;value".into()),(3,"tail\\".into())]);
    }
    #[test]
    fn postgres_session_escape_mode_and_sqlite_quoted_identifier_are_respected() {
        let mut pg=SqlFileReader::new(std::io::Cursor::new("SELECT 'escaped\\';semi';SELECT 2;"),false);
        pg.set_postgres_strings(false);
        assert_eq!(pg.next_statement().unwrap().unwrap(),"SELECT 'escaped\\';semi'");
        assert_eq!(pg.next_statement().unwrap().unwrap(),"SELECT 2");
        let mut sqlite=SqlFileReader::new(std::io::Cursor::new("CREATE TABLE [a;b](x);SELECT 2;"),false);sqlite.set_sqlite(true);
        assert_eq!(sqlite.next_statement().unwrap().unwrap(),"CREATE TABLE [a;b](x)");
        assert_eq!(sqlite.next_statement().unwrap().unwrap(),"SELECT 2");
        assert!(parse("SELECT 'bad\0value';",false).is_err());
    }
    #[tokio::test]
    async fn sqlite_trigger_body_is_one_statement_and_literals_survive_execution() {
        use sqlx::Connection;
        let mut conn=sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let sql="CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);CREATE TRIGGER protect BEFORE DELETE ON t BEGIN SELECT CASE WHEN OLD.id=2 THEN RAISE(ABORT,'keep') END; END;INSERT INTO t VALUES(1,'/*keep*/;--text');";
        let mut reader=SqlFileReader::new(std::io::Cursor::new(sql),false);reader.set_sqlite(true);
        let mut executed=0;
        while let Some(statement)=reader.next_statement().unwrap(){sqlx::Executor::execute(&mut conn,statement.as_str()).await.unwrap();executed+=1;}
        assert_eq!(executed,3);
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT v FROM t").fetch_one(&mut conn).await.unwrap(),"/*keep*/;--text");
    }
}
