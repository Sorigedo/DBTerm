"""Actual trigger catalog SELECT semantics and production integration contract."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/commands/sqlserver/mod.rs').read_text()
assert 'ddl_triggers::read_triggers' in source, 'table DDL silently omits trigger definitions and enabled/order state'
module=(root/'src-tauri/src/commands/sqlserver/ddl_triggers.rs').read_text()
for item in ['sys.triggers','sys.sql_modules','is_disabled','uses_ansi_nulls','uses_quoted_identifier','ExecIsFirstInsertTrigger','ExecIsLastInsertTrigger','ExecIsFirstUpdateTrigger','ExecIsLastUpdateTrigger','ExecIsFirstDeleteTrigger','ExecIsLastDeleteTrigger']:
    assert item in module,item
print('PASS table DDL trigger catalog contract includes definition, creation flags, disabled and event ordering.')
import re,sqlite3
sql=re.search(r'const TRIGGER_SQL: &str = "(.*?)";',module,re.S)[1]
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('''CREATE TABLE sys.triggers(object_id,parent_id,parent_class,is_ms_shipped,name,is_disabled,type);
    CREATE TABLE sys.objects(object_id,schema_id); CREATE TABLE sys.schemas(schema_id,name);
    CREATE TABLE sys.sql_modules(object_id,definition,uses_ansi_nulls,uses_quoted_identifier);
    INSERT INTO sys.schemas VALUES(1,'ops');
    INSERT INTO sys.objects VALUES(7,1),(8,1);
    INSERT INTO sys.triggers VALUES(7,101,1,0,'tr',1,'TR'),(8,202,1,0,'wrong',0,'TR');
    INSERT INTO sys.sql_modules VALUES(7,'CREATE TRIGGER original',0,1),(8,'wrong',1,1);''')
    db.create_function('OBJECT_ID',1,lambda _:101)
    db.create_function('OBJECTPROPERTY',2,lambda ident,prop:1 if prop=='ExecIsFirstInsertTrigger' else 0)
    rows=db.execute(sql,{'P1':'[ops].[t]'}).fetchall()
    assert rows==[('ops','tr','CREATE TRIGGER original',0,1,1,'TR',1,0,0,0,0,0)],rows
print('PASS actual production trigger SELECT target joins, definition, flags, disabled and event order; synthetic SQLite catalog only.')
