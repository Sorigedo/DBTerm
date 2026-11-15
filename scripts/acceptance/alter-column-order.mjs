// Exercise the actual private UI builder without launching the desktop application.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const target='/src/components/DbTools/AlterTableWizard.tsx';
const server=await createServer({root,server:{middlewareMode:true},plugins:[{
 name:'expose-alter-builder-for-regression',enforce:'pre',
 transform(code,id){if(id.endsWith(target))return code+'\nexport { buildAlterSql };';},
}]});
try {
 const {buildAlterSql}=await server.ssrLoadModule(target);
 const original={name:'old_name',dataType:'text',nullable:true,defaultValue:'old',comment:''};
 const column=changes=>({...original,_original:original,_isNew:false,_deleted:false,_id:'fixture',key:'',...changes});
 const prefix='ALTER TABLE "fixture"."sample"';
 const combined=buildAlterSql('fixture','sample',[column({name:'new_name',dataType:'varchar(128)',nullable:false,defaultValue:'next'})],'postgres');
 assert.equal(combined,[
  `${prefix} ALTER COLUMN "old_name" TYPE varchar(128);`,
  `${prefix} ALTER COLUMN "old_name" SET NOT NULL;`,
  `${prefix} ALTER COLUMN "old_name" SET DEFAULT 'next';`,
  `${prefix} RENAME COLUMN "old_name" TO "new_name";`,
 ].join('\n'));
 const drop=buildAlterSql('fixture','sample',[column({name:'new_name',defaultValue:''})],'postgres');
 assert.equal(drop,`${prefix} ALTER COLUMN "old_name" DROP DEFAULT;\n${prefix} RENAME COLUMN "old_name" TO "new_name";`);
 assert.equal(buildAlterSql('fixture','sample',[column({})],'postgres'),'-- 无变更');
 const quoted=buildAlterSql('fixture','sample',[column({name:'new"name',defaultValue:"O'Reilly",comment:"reader's column"})],'postgres');
 assert.equal(quoted,[
  `${prefix} ALTER COLUMN "old_name" SET DEFAULT 'O''Reilly';`,
  `${prefix} RENAME COLUMN "old_name" TO "new""name";`,
  `COMMENT ON COLUMN "fixture"."sample"."new""name" IS 'reader''s column';`,
 ].join('\n'));
 const ssOriginal={...original,name:"old.'name]"};
 const ssRename=buildAlterSql("db']name","table.'name]",[{...column({name:"new'; SELECT 1;--中文"}),_original:ssOriginal}],'sqlServer');
 assert.equal(ssRename,"EXEC [db']]name].sys.sp_rename N'[table.''name]]].[old.''name]]]', N'new''; SELECT 1;--中文', N'COLUMN';");
 const ssCurrent=buildAlterSql('','sample',[column({name:'renamed'})],'sqlServer');
 assert.equal(ssCurrent,"EXEC sys.sp_rename N'[sample].[old_name]', N'renamed', N'COLUMN';");
 if(process.env.DBTERM_ALTER_SQL_OUTPUT)await writeFile(process.env.DBTERM_ALTER_SQL_OUTPUT,JSON.stringify({combined,drop,quoted})+'\n');
 console.log('PASS actual ALTER builders: PostgreSQL combined rename/type/null/default, default removal, unchanged definition and quoted identifiers/comments; SQL Server rename database qualification and Unicode literal escaping. No SQL Server service execution in this script.');
}finally{await server.close();}
