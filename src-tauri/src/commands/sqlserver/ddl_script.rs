//! DDL phases are carried structurally; expressions are never split as SQL text.
#[derive(Default)]
pub(crate) struct TableScript {
    pub definition: String,
    pub post_data: Vec<String>,
    pub constraints: Vec<String>,
    pub triggers: Vec<String>,
    pub module_session: Option<(bool, bool)>,
}
impl TableScript {
    pub fn archive_complete(self) -> String {
        let header = self.module_session.map(|(ansi, quoted)| format!(
            "SET ANSI_NULLS {};\nGO\nSET QUOTED_IDENTIFIER {};\nGO\n",
            if ansi { "ON" } else { "OFF" }, if quoted { "ON" } else { "OFF" },
        )).unwrap_or_default();
        header + &self.complete()
    }
    pub fn complete(self) -> String {
        let mut ddl=self.definition;
        for statement in self.post_data.into_iter().chain(self.constraints) {ddl.push('\n');ddl.push_str(&statement);}
        if !self.triggers.is_empty() { ddl.push_str("\nGO\n"); }
        for trigger in self.triggers { ddl.push_str(&trigger); ddl.push_str("\nGO\n"); }
        ddl
    }
    pub fn deferred_batch(context:&str,statements:&[String])->String{
        if statements.is_empty(){return String::new();}
        let mut result=context.to_string();
        for statement in statements {result.push_str(statement);result.push_str("\nGO\n");}
        result
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn phased_script_preserves_sql_body_with_fake_statement_tokens(){
        let script=TableScript{definition:"CREATE TABLE [t] ([v] AS (N'ALTER TABLE; GO')));".into(),post_data:vec!["CREATE INDEX [ix] ON [t] ([v]);".into(),"ALTER TABLE [t] ADD CONSTRAINT [fk] FOREIGN KEY ([v]) REFERENCES [p]([v]);".into()],constraints:Vec::new(),triggers:Vec::new(),module_session:None};
        assert!(script.definition.contains("N'ALTER TABLE; GO'"));
        let batch=TableScript::deferred_batch("USE [B];\nGO\n",&script.post_data);
        assert!(batch.starts_with("USE [B];\nGO\nCREATE INDEX"));assert_eq!(batch.matches("\nGO\n").count(),3);
        let whole=script.complete();assert!(whole.find("CREATE TABLE").unwrap()<whole.find("CREATE INDEX").unwrap());assert!(whole.contains("N'ALTER TABLE; GO'"));
        assert!(TableScript::deferred_batch("USE [B];",&[]).is_empty());
    }
    #[test]fn cyclic_foreign_keys_can_follow_both_table_definitions_and_data(){
        let a=TableScript{definition:"CREATE TABLE [a] ([id] int PRIMARY KEY,[b] int);".into(),post_data:Vec::new(),triggers:Vec::new(),module_session:None,constraints:vec!["ALTER TABLE [a] ADD FOREIGN KEY ([b]) REFERENCES [b]([id]);".into()]};
        let b=TableScript{definition:"CREATE TABLE [b] ([id] int PRIMARY KEY,[a] int);".into(),post_data:Vec::new(),triggers:Vec::new(),module_session:None,constraints:vec!["ALTER TABLE [b] ADD FOREIGN KEY ([a]) REFERENCES [a]([id]);".into()]};
        let script=format!("{}\nINSERT INTO [a] VALUES(1,1);\n{}\nINSERT INTO [b] VALUES(1,1);\n{}",a.definition,b.definition,TableScript::deferred_batch("",&[a.constraints,b.constraints].concat()));
        assert!(script.find("FOREIGN KEY").unwrap()>script.find("INSERT INTO [b]").unwrap());
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use std::io::{Cursor,Write,Read};
    #[test]
    fn zip_orders_tables_then_indexes_then_cyclic_foreign_keys_without_sql_splitting() {
        let mut writer=zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options=zip::write::SimpleFileOptions::default();
        for name in ["a","b"] {
            writer.start_file(format!("tables/{name}.sql"),options).unwrap();
            write!(writer,"CREATE TABLE [{name}] ([id] int);\nINSERT INTO [{name}] VALUES(1);\n").unwrap();
        }
        let indexes=vec!["CREATE UNIQUE INDEX [ux_b] ON [b]([id]);".to_string()];
        let constraints=vec!["ALTER TABLE [a] ADD FOREIGN KEY ([id]) REFERENCES [b]([id]);".to_string(),"ALTER TABLE [b] ADD FOREIGN KEY ([id]) REFERENCES [a]([id]);".to_string()];
        writer.start_file("post-data.sql",options).unwrap();
        for phase in [&indexes,&constraints] {writer.write_all(TableScript::deferred_batch("USE [B];\nGO\n",phase).as_bytes()).unwrap();}
        let mut archive=zip::ZipArchive::new(writer.finish().unwrap()).unwrap();
        let names=(0..archive.len()).map(|i|archive.by_index(i).unwrap().name().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names,vec!["tables/a.sql","tables/b.sql","post-data.sql"]);
        let mut sql=String::new();archive.by_name("post-data.sql").unwrap().read_to_string(&mut sql).unwrap();
        assert!(sql.find("CREATE UNIQUE INDEX").unwrap()<sql.find("FOREIGN KEY").unwrap());
        assert_eq!(sql.matches("FOREIGN KEY").count(),2);
    }
}

#[cfg(test)]
mod module_tests {
    use super::*;
    #[test]
    fn module_archive_keeps_all_flag_combinations_and_definition_bytes() {
        let definition="CREATE PROCEDURE [ops].[p] AS\r\nSELECT N'GO; SET ANSI_NULLS ON', \"literal\";\r\n";
        for ansi in [false,true] { for quoted in [false,true] {
            let script=TableScript { definition:definition.into(), module_session:Some((ansi,quoted)), ..Default::default() };
            assert_eq!(script.complete(),definition);
            let script=TableScript { definition:definition.into(), module_session:Some((ansi,quoted)), ..Default::default() };
            let archive=script.archive_complete();
            let expected=format!("SET ANSI_NULLS {};\nGO\nSET QUOTED_IDENTIFIER {};\nGO\n",if ansi{"ON"}else{"OFF"},if quoted{"ON"}else{"OFF"});
            assert_eq!(archive,expected+definition);
        }}
    }
    #[test]
    fn table_archive_without_module_flags_gets_no_invented_session_settings() {
        assert_eq!(TableScript{definition:"CREATE TABLE [t]([id] int);".into(),..Default::default()}.archive_complete(),"CREATE TABLE [t]([id] int);");
    }
}

#[cfg(test)]mod trigger_phase_tests {
    use super::*;
    #[test]fn trigger_creation_is_in_its_own_batch_after_constraints() {
        let script=TableScript{definition:"CREATE TABLE [t]([id] int);".into(),post_data:vec!["CREATE INDEX [ix] ON [t]([id]);".into()],constraints:vec!["ALTER TABLE [t] ADD CHECK ([id]>0);".into()],triggers:vec!["SET ANSI_NULLS ON;\nGO\nCREATE TRIGGER [tr] ON [t] AFTER INSERT AS SELECT 1;".into()],module_session:None};
        let sql=script.complete();
        assert!(sql.contains("ADD CHECK ([id]>0);\nGO\nSET ANSI_NULLS"));
        assert!(sql.find("CREATE TRIGGER").unwrap()>sql.find("ADD CHECK").unwrap());
    }
}
