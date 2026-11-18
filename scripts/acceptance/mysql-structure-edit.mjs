import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const server=await createServer({root,configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true}});
try {
 const {buildAlterSql}=await server.ssrLoadModule('/src/components/DbTools/CreateTableWizard.tsx');
 const col={_id:'title',name:'title',baseType:'VARCHAR',length:'64',unsigned:false,nullable:false,primaryKey:false,autoIncrement:false,defaultType:'empty',defaultValue:'',comment:'old',collation:'utf8mb4_bin'};
 const id={...col,_id:'id',name:'id',baseType:'BIGINT',length:'',unsigned:true,primaryKey:true,autoIncrement:true,defaultType:'none',comment:'',collation:''};
 const stamp={...col,_id:'updated',name:'updated',baseType:'DATETIME',length:'6',defaultType:'timestamp_update',comment:'time',collation:''};
 const ddl=["CREATE TABLE §sample§ (","  §id§ bigint unsigned NOT NULL AUTO_INCREMENT,","  §title§ varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT 'old' INVISIBLE,","  §updated§ datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'time',","  PRIMARY KEY (§id§)",") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"].join(String.fromCharCode(10)).replaceAll("§",String.fromCharCode(96));
 const opts={connType:'mysql',schema:'fixture',table:'sample',comment:'',engine:'InnoDB',charset:'utf8mb4',collation:'',rowFormat:'DEFAULT',autoIncStart:'',cols:[id,col,stamp],origCols:[id,col,stamp],indexes:[],origIndexes:[],origEngine:'InnoDB',origCharset:'utf8mb4',origCollation:'',origRowFormat:'DEFAULT',origAutoIncStart:'',origComment:'',tableOptionsLoaded:true,currentDdl:ddl};
 const generate=(cols,extra={})=>buildAlterSql({...opts,cols,...extra});
 assert.equal(generate(opts.cols),'-- 结构未发生变化');
 for (const patch of [{comment:'设备注释'},{comment:''},{length:'128'},{baseType:'TEXT',length:''},{nullable:true},{defaultType:'custom',defaultValue:'next'},{defaultType:'none'},{name:'device_title'}]) {
  const sql=generate([id,{...col,...patch},stamp]);
  assert.ok(sql.startsWith('ALTER TABLE'),JSON.stringify(patch)+' must be savable: '+sql);
  if(patch.name===undefined) assert.match(sql,/INVISIBLE/,'unrepresented attributes survive');
 }
 assert.match(generate([id,{...col,comment:'设备注释'},stamp]),/COMMENT '设备注释' INVISIBLE/);
 assert.ok(generate([id,col,{...stamp,comment:'最新时间'}]).includes('DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'));
 assert.match(generate([id,{...col,name:'new_title',length:'128',nullable:true,comment:'新注释',collation:''},stamp]),/CHANGE COLUMN .*new_title.*varchar.*128.*NULL.*COMMENT '新注释' INVISIBLE/i);
 assert.match(generate([stamp,id,col]),/MODIFY COLUMN .*updated.* FIRST/);
 assert.match(generate([id,stamp,col]),/MODIFY COLUMN .*updated.* AFTER .*id/);
 assert.match(generate([id,{...col,name:'new_title'},stamp]),/RENAME COLUMN .*title.* TO .*new_title/);
 const pk=generate([{...id,primaryKey:false,autoIncrement:false},{...col,primaryKey:true},stamp]);
 assert.match(pk,/DROP PRIMARY KEY/); assert.match(pk,/ADD PRIMARY KEY .*title/);
 const added={...col,_id:'added',name:'extra',comment:'',collation:''};
 assert.match(generate([added,id,col,stamp]),/ADD COLUMN .*extra.* FIRST/);
 assert.ok(generate([id,{...col,comment:'changed'},stamp],{currentDdl:''}).startsWith('--'));
 assert.ok(generate([id,{...col,name:''},stamp]).startsWith('--'),'blank name cannot delete a column');
 assert.ok(generate([id,{...col,name:'id'},stamp]).startsWith('--'),'duplicate names rejected');
 const indexed={name:'search_title',columns:'title',unique:false,method:'FULLTEXT'};
 assert.ok(generate(opts.cols,{indexes:[{_id:'search_title',...indexed,method:'BTREE'}],origIndexes:[{_id:'search_title',...indexed}]}).startsWith('--'),'existing indexes stay protected until complete index DDL can be preserved');
 if(process.env.DBTERM_MYSQL_SOCKET){
  const mysql=sql=>execFileSync('/opt/homebrew/bin/mysql',['--no-defaults','--socket='+process.env.DBTERM_MYSQL_SOCKET,'-uroot','--default-character-set=utf8mb4','--batch','--raw'],{input:sql,encoding:'utf8'});
  mysql('CREATE DATABASE IF NOT EXISTS fixture;');
  const reset=()=>mysql('DROP TABLE IF EXISTS fixture.sample; USE fixture; '+ddl+';');
  for(const patch of [{comment:'设备注释'},{comment:''},{length:'128'},{nullable:true},{defaultType:'custom',defaultValue:'next'},{defaultType:'none'},{name:'device_title'}]){
   reset();mysql(generate([id,{...col,...patch},stamp]));
   const actual=mysql('SHOW CREATE TABLE fixture.sample;');
   assert.ok(actual.includes('INVISIBLE'));
   if(patch.comment)assert.ok(actual.includes(patch.comment));
  }
  reset();mysql(generate([stamp,id,col]));
  assert.ok(mysql("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fixture' AND TABLE_NAME='sample' ORDER BY ORDINAL_POSITION;").indexOf('updated')<mysql("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='fixture' AND TABLE_NAME='sample' ORDER BY ORDINAL_POSITION;").indexOf('id'));
  reset();mysql(generate([id,{...col,name:'new_title',length:'128',nullable:true,comment:'第一行\n第二行🙂',collation:''},stamp]));
  const actual=mysql('SHOW CREATE TABLE fixture.sample;');
  assert.ok(actual.includes('new_title')&&actual.includes('varchar(128)')&&actual.includes('第二行'));
  reset();mysql(pk);
  assert.ok(mysql('SHOW CREATE TABLE fixture.sample;').includes('PRIMARY KEY ('+String.fromCharCode(96)+'title'));
  mysql('DROP DATABASE fixture;');
  console.log('PASS real isolated MySQL: each edit executed and read back, combined changes, multiline Unicode, order and primary key.');
 }
 console.log('PASS MySQL comments, attributes, combined edits, order, primary keys and DDL preservation.');
}finally{await server.close();}
