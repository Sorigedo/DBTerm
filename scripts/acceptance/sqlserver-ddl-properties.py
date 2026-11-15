"""Production table/column extended-property SELECT plus source integration contract."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/commands/sqlserver/mod.rs').read_text()
assert 'ddl_properties::read_properties' in source,'table/column descriptions and custom extended properties disappear from table DDL'
module=(root/'src-tauri/src/commands/sqlserver/ddl_properties.rs').read_text()
for part in ['sys.extended_properties','ep.class = 1','ep.major_id = OBJECT_ID(@P1)','ep.minor_id','SQL_VARIANT_PROPERTY','BaseType','Precision','Scale','MaxLength','Collation']:
    assert part in module,part
print('PASS table DDL reads table/column extended-property identity, value and SQL_VARIANT type metadata.')
import re,sqlite3
sql=re.search(r'const PROPERTY_SQL: &str = "(.*?)";',module,re.S)[1]
# SQLite adapts only T-SQL conversion functions/types; production joins/filter/order unchanged.
sql=re.sub(r'CAST\((SQL_VARIANT_PROPERTY\(ep.value,\'[^\']+\'\)) AS (?:nvarchar\(128\)|int)\)',r'\1',sql)
sql=sql.replace('CONVERT(nvarchar(max),ep.value)','PROP_TEXT(ep.value)').replace('CONVERT(varchar(max),CONVERT(varbinary(max),ep.value),1)','PROP_HEX(ep.value)')
with sqlite3.connect(':memory:') as db:
    db.execute("ATTACH DATABASE ':memory:' AS sys")
    db.executescript('CREATE TABLE sys.extended_properties(class,major_id,minor_id,name,value); CREATE TABLE sys.columns(object_id,column_id,name);')
    db.executemany('INSERT INTO sys.extended_properties VALUES(?,?,?,?,?)',[(1,101,0,'MS_Description','table_value'),(1,101,2,'custom','column_value'),(1,202,0,'wrong','other')])
    db.executemany('INSERT INTO sys.columns VALUES(?,?,?)',[(101,2,'v'),(202,2,'wrong')])
    db.create_function('OBJECT_ID',1,lambda _:101)
    db.create_function('SQL_VARIANT_PROPERTY',2,lambda value,key:{'BaseType':'nvarchar','Precision':0,'Scale':0,'MaxLength':40,'Collation':'Latin1_General_100_BIN2'}[key])
    db.create_function('PROP_TEXT',1,lambda value:value)
    db.create_function('PROP_HEX',1,lambda value:None)
    rows=db.execute(sql,{'P1':'[ops].[t]'}).fetchall()
    assert len(rows)==2 and rows[0][0:4]==('MS_Description',0,None,'nvarchar'),rows
    assert rows[1][0:4]==('custom',2,'v','nvarchar') and rows[1][8]=='column_value',rows
print('PASS production extended-property joins, selected object identity, table/column distinction and typed metadata; synthetic SQLite catalog only.')
