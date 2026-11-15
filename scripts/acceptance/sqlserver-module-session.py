from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/commands/sqlserver/mod.rs').read_text()
assert 'sm.uses_ansi_nulls' in source and 'sm.uses_quoted_identifier' in source, 'module export omits creation session flags'
assert 'LEFT JOIN sys.sql_modules sm ON sm.object_id = o.object_id' in source
archive=(root/'src-tauri/src/commands/db_extra.rs').read_text().split('pub async fn db_logical_backup(',1)[1].split('// 打开输出文件（流式写）',1)[0]
assert '.archive_complete()' in archive,'archive must emit flags in separate GO batches before unchanged CREATE module text'
print('PASS module archive captures original ANSI_NULLS/QUOTED_IDENTIFIER flags; raw DDL remains separate.')
import re,json,sqlite3
block=source.split('let meta_sql = format!(',1)[1].split('let mut mq',1)[0]
literal=re.search(r'"({db_context}SELECT.*?)"',block,re.S)[1]
sql=json.loads('"'+re.sub(r'\\\n\s*','',literal)+'"').replace('{db_context}','')
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('CREATE TABLE sys.objects(object_id,type); CREATE TABLE sys.sql_modules(object_id,uses_ansi_nulls,uses_quoted_identifier);')
    db.executemany('INSERT INTO sys.objects VALUES(?,?)',[(10,'P'),(11,'V'),(12,'U')])
    db.executemany('INSERT INTO sys.sql_modules VALUES(?,?,?)',[(10,0,1),(11,1,0)])
    db.create_function('OBJECT_ID',1,lambda name:{'p':10,'v':11,'t':12}[name])
    db.create_function('OBJECT_DEFINITION',1,lambda ident:'CREATE MODULE '+str(ident) if ident!=12 else None)
    assert db.execute(sql,{'P1':'p'}).fetchall()==[('P','CREATE MODULE 10',0,1)]
    assert db.execute(sql,{'P1':'v'}).fetchall()==[('V','CREATE MODULE 11',1,0)]
    assert db.execute(sql,{'P1':'t'}).fetchall()==[('U',None,None,None)]
print('PASS actual production module SELECT identity/left-join/session flags; SQLite synthetic catalog only.')
