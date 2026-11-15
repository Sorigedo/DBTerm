"""Backup target identity source contract plus actual resolver SELECT semantics."""
from pathlib import Path
import re, sqlite3
root=Path(__file__).resolve().parents[2]
backup=(root/'src-tauri/src/commands/db_extra.rs').read_text().split('pub async fn db_logical_backup(',1)[1].split('// 打开输出文件（流式写）',1)[0]
assert 'let schema_name = "dbo"' not in backup, 'SQL Server backup must resolve actual schema instead of defaulting to dbo'
assert 'resolve_backup_table' in backup, 'all backup modes must validate selected table identity'
assert 'Some(schema_name.as_str())' in backup, 'DDL must use the same resolved schema as row stream'
assert 'write_all(restore_context.as_bytes())' in backup, 'archive SQL must select its source database before DDL or INSERT'
src=(root/'src-tauri/src/commands/sqlserver/backup_target.rs').read_text()
sql=re.search(r'const TARGET_SQL: &str = "(.*?)";',src,re.S)[1]
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('CREATE TABLE sys.schemas(schema_id,name); CREATE TABLE sys.tables(schema_id,name);')
    db.executemany('INSERT INTO sys.schemas VALUES(?,?)',[(1,'dbo'),(2,"ops'.]中文")])
    db.executemany('INSERT INTO sys.tables VALUES(?,?)',[(1,'same'),(2,'same'),(2,'unique')])
    db.create_function('DB_NAME',0,lambda:'B]库')
    assert db.execute(sql,{'P1':'unique','P2':None}).fetchall()==[('B]库',"ops'.]中文")]
    assert len(db.execute(sql,{'P1':'same','P2':None}).fetchall())==2
    assert db.execute(sql,{'P1':'same','P2':"ops'.]中文"}).fetchall()==[('B]库',"ops'.]中文")]
    assert db.execute(sql,{'P1':'same','P2':"dbo' OR 1=1--"}).fetchall()==[]
print('PASS backup resolves exact database/schema; DDL and row stream share target; restore context emitted. Synthetic catalogs/source contract only.')
module_block=backup.split('for (dir, names)',1)[1]
assert 'resolve_backup_module' in module_block, 'view/function/procedure backups must resolve the same explicit object schema'
assert 'target.restore_context()' in module_block, 'module archive entries need resolved database restore context'
assert 'Some(target.schema.as_str())' in module_block, 'module DDL must retain resolved object schema'
print('PASS module archive target and restore context contract.')
module_sql=re.search(r'const MODULE_SQL: &str = "(.*?)";',src,re.S)[1]
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('CREATE TABLE sys.schemas(schema_id,name); CREATE TABLE sys.objects(schema_id,name,type);')
    db.executemany('INSERT INTO sys.schemas VALUES(?,?)',[(1,'dbo'),(2,"ops'.]中文")])
    db.executemany('INSERT INTO sys.objects VALUES(?,?,?)',[(1,'same','V'),(2,'same','P'),(2,'ordinary_table','U')])
    db.create_function('DB_NAME',0,lambda:'B]库')
    assert len(db.execute(module_sql,{'P1':'same','P2':None}).fetchall())==2
    assert db.execute(module_sql,{'P1':'same','P2':"ops'.]中文"}).fetchall()==[('B]库',"ops'.]中文")]
    assert db.execute(module_sql,{'P1':'ordinary_table','P2':None}).fetchall()==[]
print('PASS actual module target SELECT schema filtering and rejection of table objects; synthetic catalogs only.')
