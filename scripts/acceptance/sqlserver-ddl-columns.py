"""Check production catalog selection used by DDL column renderer; no server."""
import re
import sqlite3
from pathlib import Path
source = (Path(__file__).resolve().parents[2] / 'src-tauri/src/commands/sqlserver/mod.rs').read_text()
block = source.split('let cols_sql = format!(', 1)[1].split('let mut cq', 1)[0]
required = ['c.collation_name', 'c.is_computed', 'cc.definition', 'cc.is_persisted', 'dc.name',
            'tp.is_user_defined', 'SCHEMA_NAME(tp.schema_id)', 'ic.is_not_for_replication']
missing = [part for part in required if part not in block]
assert not missing, f'column DDL loses source metadata: {missing}'
assert 'LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id' in block
assert 'LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id' in block
print('PASS production DDL SELECT retrieves computed expression, persistence, collation, named defaults, qualified type and identity replication attributes; source contract only.')

# Execute actual SELECT; adapt only built-ins and their return representation.
import json
literal = re.search(r'"({db_context}SELECT.*?)"', block, re.S)[1]
sql = json.loads('"' + re.sub(r'\\\n\s*', '', literal) + '"').replace('{db_context}', '').replace('VARCHAR(40)', 'TEXT')
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript("""
        CREATE TABLE sys.columns(object_id,column_id,name,user_type_id,max_length,precision,scale,is_nullable,is_identity,default_object_id,collation_name,is_computed,is_rowguidcol,is_sparse,is_filestream);
        CREATE TABLE sys.types(user_type_id,name,is_user_defined,schema_id);
        CREATE TABLE sys.identity_columns(object_id,column_id,seed_value,increment_value,is_not_for_replication);
        CREATE TABLE sys.computed_columns(object_id,column_id,definition,is_persisted);
        CREATE TABLE sys.default_constraints(object_id,name);
        INSERT INTO sys.types VALUES(1,'nvarchar',0,1),(2,'int',0,1);
        INSERT INTO sys.columns VALUES(101,1,'plain',1,128,0,0,0,0,501,'Latin1_General_100_BIN2',0,0,0,0);
        INSERT INTO sys.columns VALUES(101,2,'computed',2,4,10,0,1,0,0,NULL,1,0,0,0);
        INSERT INTO sys.columns VALUES(202,1,'other_schema_column',2,4,10,0,0,0,0,NULL,0,0,0,0);
        INSERT INTO sys.default_constraints VALUES(501,'DF_plain');
    """)
    db.execute('INSERT INTO sys.computed_columns VALUES(?,?,?,?)',(101,2,"(nullif([plain],N''))",1))
    db.create_function('OBJECT_ID',1,lambda ref:101 if ref=='[ops].[same]' else 202)
    db.create_function('OBJECT_DEFINITION',1,lambda ident:"(N'a''中')" if ident==501 else None)
    db.create_function('SCHEMA_NAME',1,lambda ident:'dbo')
    rows = db.execute(sql, {'P1':'[ops].[same]'}).fetchall()
    assert len(rows)==2, rows
    assert rows[0][0]=='plain' and rows[0][7]=="(N'a''中')" and rows[0][10]=='Latin1_General_100_BIN2' and rows[0][14]=='DF_plain', rows[0]
    assert rows[1][0]=='computed' and rows[1][11:14]==(1,"(nullif([plain],N''))",1), rows[1]
print('PASS production column SELECT joins, target isolation and expression/default/collation values; SQLite synthetic catalog only.')
