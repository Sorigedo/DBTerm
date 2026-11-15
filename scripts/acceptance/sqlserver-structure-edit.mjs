// Actual structure editor generator, no desktop or database access.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const server=await createServer({root,server:{middlewareMode:true}});
try {
 const {buildAlterSql}=await server.ssrLoadModule('/src/components/DbTools/CreateTableWizard.tsx');
 const original={_id:'v',name:'old',baseType:'NVARCHAR',length:'128',unsigned:false,nullable:true,primaryKey:false,autoIncrement:false,defaultType:'custom',defaultValue:"(N'原值')",comment:''};
 const options={connType:'sqlServer',schema:'selected_db',ssSchema:"ops'.]中文",table:'same',comment:'',engine:'',charset:'',collation:'',rowFormat:'',autoIncStart:'',cols:[{...original,name:'renamed'}],origCols:[original],indexes:[],origIndexes:[],origEngine:'',origCharset:'',origCollation:'',origRowFormat:'',origAutoIncStart:'',origComment:'',tableOptionsLoaded:false};
 assert.equal(buildAlterSql(options),"EXEC [selected_db].sys.sp_rename N'[ops''.]]中文].[same].[old]', N'renamed', N'COLUMN';",'rename must preserve selected schema and original attributes');
 assert.ok(buildAlterSql({...options,cols:[{...original}]}).startsWith('--'));
 const added={...original,_id:'new',name:'extra',defaultType:'empty',defaultValue:''};
 assert.equal(buildAlterSql({...options,cols:[original,added]}),"ALTER TABLE [selected_db].[ops'.]]中文].[same] ADD [extra] NVARCHAR(128) DEFAULT '';",'adding a field must use SQL Server ADD syntax');
 for(const patch of [{baseType:'VARCHAR'},{nullable:false},{defaultValue:'changed'},{primaryKey:true},{autoIncrement:true}]){
  const sql=buildAlterSql({...options,cols:[{...original,...patch}]});
  assert.ok(sql.startsWith('--')&&sql.includes('完整定义'),'incomplete summary must not silently change or omit existing attribute edits: '+JSON.stringify(patch)+' => '+sql);
 }
 assert.equal(buildAlterSql({...options,cols:[original],indexes:[{_id:'idx',name:'ix_old',columns:'old',unique:false,method:'BTREE'}]}),"CREATE INDEX [ix_old] ON [selected_db].[ops'.]]中文].[same] ([old]);",'new index must target selected schema');
 console.log('PASS actual SQL Server structure editor rename: selected database/schema, quoted identifiers and no unrelated attribute rewrite; no service execution.');
}finally{await server.close();}
