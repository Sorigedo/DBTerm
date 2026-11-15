"""Production SELECT join/filter semantics; synthetic SQLite catalogs, not TDS."""
import json
import re
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = (root / 'src-tauri/src/commands/sqlserver/mod.rs').read_text()
block = source.split('pub async fn dispatch_ss_columns(', 1)[1].split('pub async fn dispatch_ss_ddl(', 1)[0]
literal = re.search(r'"({db_context}SELECT c.COLUMN_NAME,.*?ORDER BY c.ORDINAL_POSITION)"', block, re.S)
assert literal, 'production column query not found'
sql = json.loads('"' + re.sub(r'\\\n\s*', '', literal[1]) + '"').replace('{db_context}', '')
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS INFORMATION_SCHEMA")
    db.executescript('''
      ATTACH DATABASE ':memory:' AS sys;
      CREATE TABLE sys.schemas(schema_id,name);
      CREATE TABLE sys.objects(name,schema_id,type);
      CREATE TABLE sys.tables(name,schema_id);
      CREATE TABLE INFORMATION_SCHEMA.COLUMNS(TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,ORDINAL_POSITION);
      CREATE TABLE INFORMATION_SCHEMA.TABLE_CONSTRAINTS(CONSTRAINT_CATALOG,CONSTRAINT_SCHEMA,CONSTRAINT_NAME,TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_TYPE);
      CREATE TABLE INFORMATION_SCHEMA.KEY_COLUMN_USAGE(CONSTRAINT_CATALOG,CONSTRAINT_SCHEMA,CONSTRAINT_NAME,TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME);
    ''')
    for schema, primary in [('dbo', 'id'), ("ops'.]中文", 'v')]:
        schema_id = 1 if schema == 'dbo' else 2
        db.execute('INSERT INTO sys.schemas VALUES(?,?)', (schema_id, schema))
        db.execute('INSERT INTO sys.objects VALUES(?,?,?)', ('same',schema_id,'U'))
        db.execute('INSERT INTO sys.tables VALUES(?,?)', ('same',schema_id))
        for ordinal, name in enumerate(['id', 'v'], 1):
            db.execute('INSERT INTO INFORMATION_SCHEMA.COLUMNS VALUES(?,?,?,?,?,?,?,?)', ('fixture',schema,'same',name,'int','NO',None,ordinal))
        db.execute('INSERT INTO INFORMATION_SCHEMA.TABLE_CONSTRAINTS VALUES(?,?,?,?,?,?,?)', ('fixture',schema,'same_pk','fixture',schema,'same','PRIMARY KEY'))
        db.execute('INSERT INTO INFORMATION_SCHEMA.KEY_COLUMN_USAGE VALUES(?,?,?,?,?,?,?)', ('fixture',schema,'same_pk','fixture',schema,'same',primary))
    for schema, keys in [('dbo', ['PRI', '']), ("ops'.]中文", ['', 'PRI'])]:
        rows = db.execute(sql, {'P1':'same','P2':schema}).fetchall()
        assert rows == [('id','int','NO',keys[0],None),('v','int','NO',keys[1],None)], (schema, rows)
    assert db.execute(sql, {'P1':"same' OR 1=1--",'P2':'dbo'}).fetchall() == []
    target = re.search(r'"({db_context}SELECT s.name FROM sys.objects.*?)(?<!\\)"', block)[1].replace('{db_context}', '')
    assert db.execute(target, {'P1':'same','P2':None}).fetchall() == [('dbo',),("ops'.]中文",)]
    assert db.execute(target, {'P1':'same','P2':"ops'.]中文"}).fetchall() == [("ops'.]中文",)]
    assert db.execute(target, {'P1':'same','P2':'missing'}).fetchall() == []
    resolver = source.split('pub(crate) async fn resolve_table_target_in_schema(', 1)[1].split('async fn finish_single_row_update', 1)[0]
    query = resolver.split('Query::new("', 1)[1].split('");', 1)[0]
    db.create_function('DB_NAME', 0, lambda: 'fixture')
    assert db.execute(query, {'P1':'same','P2':"ops'.]中文"}).fetchall() == [('fixture',"ops'.]中文")]
    assert db.execute(query, {'P1':'same','P2':None}).fetchall() == [('fixture','dbo'),('fixture',"ops'.]中文")]
    assert db.execute(query, {'P1':'same','P2':"dbo' OR 1=1--"}).fetchall() == []
    dictionary = (root / 'src-tauri/src/commands/db_extra.rs').read_text().split('pub async fn db_data_dictionary(', 1)[1]
    dictionary = dictionary.split('ConnType::SqlServer => {', 1)[1].split('ConnType::ClickHouse => {', 1)[0]
    literal = re.search(r'let col_sql = format!\(\s*"(SELECT c.COLUMN_NAME,.*?)",\s*db = db, tn = tn', dictionary, re.S)[1]
    template = json.loads('"' + re.sub(r'\\\n\s*', '', literal) + '"')
    for schema, keys in [('dbo', ['PRI', '']), ("ops'.]中文", ['', 'PRI'])]:
        selected_sql = template.replace('[{db}].INFORMATION_SCHEMA.', 'INFORMATION_SCHEMA.').replace('{tn}', 'same').replace('{actual_schema}', schema.replace("'", "''")).replace('ISNULL(', 'IFNULL(').replace("N'", "'")
        rows = db.execute(selected_sql).fetchall()
        assert rows == [('id','int','NO',keys[0],'',''),('v','int','NO',keys[1],'','')], (schema, rows)
print('PASS production SQL Server column SELECT: schema isolation and correct PK markers; SQLite synthetic catalogs only, not native SQL Server.')

metadata = source.split('pub async fn dispatch_ss_tables_meta', 1)[1].split('/// 整库', 1)[0]
assert 'schema != "master"' not in metadata, 'master must also select the requested database context'
predicate = re.search(r"WHERE (o.type IN .*?) \\", metadata)[1]
with sqlite3.connect(':memory:') as db:
    db.executescript("CREATE TABLE objects(name,schema_id,type); CREATE TABLE schemas(schema_id,name);")
    db.executemany('INSERT INTO schemas VALUES(?,?)', [(1,'dbo'),(2,"ops'.]中文")])
    db.executemany('INSERT INTO objects VALUES(?,?,?)', [('same',1,'U'),('same',2,'U')])
    sql = 'SELECT s.name FROM objects o JOIN schemas s ON s.schema_id = o.schema_id WHERE ' + predicate
    assert db.execute(sql, {'P1':"ops'.]中文"}).fetchall() == [("ops'.]中文",)], 'metadata must filter selected object schema'
    assert db.execute(sql, {'P1':None}).fetchall() == [('dbo',),("ops'.]中文",)]
    assert db.execute(sql, {'P1':"dbo\' OR 1=1--"}).fetchall() == []
assert 'query.bind(ss_schema)' in metadata
print('PASS production metadata schema predicate and explicit master context; synthetic catalog only.')
