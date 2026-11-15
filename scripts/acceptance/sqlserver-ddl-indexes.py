"""Rowstore index catalog contract and production SELECT semantic fixture."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/commands/sqlserver/mod.rs').read_text()
assert 'ddl_indexes::read_indexes' in source, 'table DDL only reads primary key names; unique/secondary/include/filter/index options are lost'
module=(root/'src-tauri/src/commands/sqlserver/ddl_indexes.rs').read_text()
for attribute in ['i.name','i.type','i.is_unique','i.is_primary_key','i.is_unique_constraint','i.fill_factor','i.is_padded','i.ignore_dup_key','i.allow_row_locks','i.allow_page_locks','i.is_disabled','i.has_filter','i.filter_definition','ds.name','ds.type','ic.key_ordinal','ic.is_descending_key','ic.is_included_column']:
    assert attribute in module, attribute
print('PASS production table DDL reads index identity, type, column roles/order/direction, filters, placement and persisted rowstore options; source contract only.')
import re,sqlite3
index_sql=re.search(r'const INDEX_SQL: &str = "(.*?)";',module,re.S)[1]
column_sql=re.search(r'const COLUMN_SQL: &str = "(.*?)";',module,re.S)[1]
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('''CREATE TABLE sys.indexes(object_id,index_id,name,type,is_unique,is_primary_key,is_unique_constraint,fill_factor,is_padded,ignore_dup_key,allow_row_locks,allow_page_locks,is_disabled,has_filter,filter_definition,data_space_id,is_hypothetical);
    CREATE TABLE sys.data_spaces(data_space_id,name,type);
    CREATE TABLE sys.key_constraints(parent_object_id,unique_index_id,name);
    CREATE TABLE sys.index_columns(object_id,index_id,column_id,key_ordinal,is_descending_key,is_included_column,index_column_id);
    CREATE TABLE sys.columns(object_id,column_id,name);
    INSERT INTO sys.data_spaces VALUES(1,'fg','FG');
    INSERT INTO sys.indexes VALUES(101,2,'ix',2,1,0,0,80,1,0,1,0,0,1,'([v] IS NOT NULL)',1,0);
    INSERT INTO sys.indexes VALUES(202,2,'wrong',2,1,0,0,80,1,0,1,0,0,0,NULL,1,0);
    INSERT INTO sys.columns VALUES(101,1,'a'),(101,2,'b'),(202,1,'wrong');
    INSERT INTO sys.index_columns VALUES(101,2,1,1,1,0,1),(101,2,2,0,0,1,2),(202,2,1,1,0,0,1);''')
    db.create_function('OBJECT_ID',1,lambda _:101)
    rows=db.execute(index_sql,{'P1':'[ops].[t]'}).fetchall()
    assert len(rows)==1 and rows[0][1]=='ix' and rows[0][13]=='([v] IS NOT NULL)',rows
    assert db.execute(column_sql,{'P1':'[ops].[t]'}).fetchall()==[(2,'a',1,1,0,1),(2,'b',0,0,1,2)]
print('PASS actual production index catalog joins, object isolation, filter and key/include roles; synthetic SQLite catalogs only.')
