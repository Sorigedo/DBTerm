from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/commands/sqlserver/mod.rs').read_text()
assert 'ddl_constraints::read_constraints' in source, 'table scripting omits foreign keys and check constraints'
module=(root/'src-tauri/src/commands/sqlserver/ddl_constraints.rs').read_text()
for item in ['sys.foreign_keys','sys.foreign_key_columns','constraint_column_id','delete_referential_action','update_referential_action','is_not_for_replication','is_disabled','is_not_trusted','sys.check_constraints','definition']:
    assert item in module,item
print('PASS constraint query contract includes ordered FK mappings/actions, names, trust, disabled and replication attributes.')
import re,sqlite3
fk_sql=re.search(r'const FK_SQL:\s*&str\s*=\s*"(.*?)";',module,re.S)[1]
check_sql=re.search(r'const CHECK_SQL:\s*&str\s*=\s*"(.*?)";',module,re.S)[1]
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('''CREATE TABLE sys.foreign_keys(object_id,name,referenced_object_id,parent_object_id,delete_referential_action,update_referential_action,is_not_for_replication,is_disabled,is_not_trusted);
    CREATE TABLE sys.foreign_key_columns(constraint_object_id,constraint_column_id,parent_object_id,parent_column_id,referenced_object_id,referenced_column_id);
    CREATE TABLE sys.tables(object_id,schema_id,name);
    CREATE TABLE sys.schemas(schema_id,name);
    CREATE TABLE sys.columns(object_id,column_id,name);
    CREATE TABLE sys.check_constraints(object_id,parent_object_id,name,definition,is_not_for_replication,is_disabled,is_not_trusted);
    INSERT INTO sys.schemas VALUES(1,'ops'); INSERT INTO sys.tables VALUES(202,1,'parent');
    INSERT INTO sys.columns VALUES(101,1,'a'),(101,2,'b'),(202,1,'x'),(202,2,'y');
    INSERT INTO sys.foreign_keys VALUES(9,'fk',202,101,1,2,1,0,1);
    INSERT INTO sys.foreign_key_columns VALUES(9,2,101,2,202,2),(9,1,101,1,202,1);
    INSERT INTO sys.check_constraints VALUES(10,101,'ck','([a]>(0))',0,1,1),(11,303,'wrong','(1=1)',0,0,0);''')
    db.create_function('OBJECT_ID',1,lambda _:101)
    rows=db.execute(fk_sql,{'P1':'[ops].[t]'}).fetchall()
    assert len(rows)==2 and rows[0][9:12]==(1,'a','x') and rows[1][9:12]==(2,'b','y'),rows
    assert rows[0][1:9]==('fk','ops','parent',1,2,1,0,1),rows
    assert db.execute(check_sql,{'P1':'[ops].[t]'}).fetchall()==[('ck','([a]>(0))',0,1,1)]
print('PASS actual FK/check SELECT target filtering, ordered composite mapping, actions and state; synthetic SQLite catalogs only.')
