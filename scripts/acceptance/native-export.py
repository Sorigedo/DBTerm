#!/usr/bin/env python3
"""Real Tauri IPC + production commands + disposable MySQL; no user connections."""
import functools
import http.server
import threading
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time

PROJECT = pathlib.Path(__file__).resolve().parents[2]
MYSQL = pathlib.Path(os.environ.get('DBTERM_MYSQL_BIN', '/opt/homebrew/opt/mysql@8.4/bin'))
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='dbterm-native-export-'))
DATA = ROOT / 'data'
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    PORT = sock.getsockname()[1]
assets = None
server = None
app = None
log = open(ROOT / 'server.log', 'wb')
app_log = open(ROOT / 'app.log', 'wb')
DB = 'dbterm_native_export'
GRID = os.environ.get('DBTERM_ACCEPTANCE_GRID') == '1'
MIGRATION = os.environ.get('DBTERM_ACCEPTANCE_MIGRATION') == '1'
grid_server = None
clipboard_saved = False

def mysql(sql, database=None):
    cmd = [str(MYSQL / 'mysql'), '--no-defaults', f'--socket={ROOT}/mysql.sock',
           '-u', 'root', '--batch', '--raw', '--skip-column-names', '--binary-mode', '--default-character-set=utf8mb4']
    if database:
        cmd.append(database)
    result = subprocess.run(cmd, input=sql.encode() if isinstance(sql, str) else sql,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout

try:
    subprocess.run([str(MYSQL / 'mysqld'), '--no-defaults', '--initialize-insecure', f'--datadir={DATA}'],
                   stdout=log, stderr=subprocess.STDOUT, check=True, timeout=45)
    server = subprocess.Popen([str(MYSQL / 'mysqld'), '--no-defaults', f'--datadir={DATA}',
        '--bind-address=127.0.0.1', f'--port={PORT}', f'--socket={ROOT}/mysql.sock', '--mysqlx=0'], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            mysql('SELECT 1'); break
        except RuntimeError:
            time.sleep(.1)
    else:
        raise RuntimeError('disposable server startup timed out')
    fixture = (PROJECT / 'src-tauri/src/commands/fixtures/mc_pos_settlement_company.sql').read_text().strip()
    mysql(f'CREATE DATABASE {DB} DEFAULT CHARSET=latin1 COLLATE=latin1_bin;')
    database_ddl = mysql(f'SHOW CREATE DATABASE {DB}')
    print('MySQL version: '+mysql('SELECT VERSION()').decode().strip(), flush=True)
    mysql(fixture + "; INSERT INTO mc_pos_settlement_company (plan_code,plan_name,remark) VALUES ('A','方案甲','单引号与反斜线'),('B','方案乙','');", DB)
    mysql("""CREATE TABLE typed (id bigint unsigned PRIMARY KEY, txt longtext, payload blob, amount decimal(38,18),
        flags bit(64), choices set('','a','c'), kind enum('','a','b'), hidden_value varchar(20) INVISIBLE,
        derived bigint unsigned GENERATED ALWAYS AS (id % 17) STORED) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
        INSERT INTO typed (id,txt,payload,amount,flags,choices,kind,hidden_value) VALUES
        (0,CONVERT(X'e4b8ad00e69687275c0a' USING utf8mb4),X'00ff',12345678901234567890.123456789012345678,b'1111111111111111111111111111111111111111111111111111111111111111',3,1,'隐形'),
        (18446744073709551615,'0x00',X'',-1.000000000000000001,0,0,2,''),(7,NULL,NULL,NULL,NULL,NULL,NULL,NULL);""", DB)
    tables = ['mc_pos_settlement_company', 'typed']
    ddl = {t: mysql(f'SHOW CREATE TABLE {t}', DB).decode().split('\t', 1)[1].rstrip('\n') for t in tables}
    signatures = {
        'mc_pos_settlement_company': 'SELECT id,HEX(plan_code),HEX(plan_name),HEX(remark),HEX(create_time),HEX(update_time) FROM mc_pos_settlement_company ORDER BY id',
        'typed': 'SELECT id,HEX(txt),HEX(payload),amount,HEX(flags),HEX(choices),choices+0,HEX(kind),kind+0,HEX(hidden_value),derived FROM typed ORDER BY id',
    }
    before = {t: mysql(q, DB) for t, q in signatures.items()}
    # Compare identical ALTERs executed through independent mysql and production IPC.
    # Normalize only the table declaration, never fields/indexes/options.
    original_name = '`mc_pos_settlement_company`'
    for name in ['ddl_subject', 'ddl_control']:
        mysql(ddl[tables[0]].replace('CREATE TABLE '+original_name, 'CREATE TABLE `'+name+'`', 1), DB)
        mysql(f"INSERT INTO {name} (plan_code,plan_name) VALUES ('DDL','编辑验证')", DB)
    alterations = [
        "ADD COLUMN `audit_note` varchar(37) NOT NULL DEFAULT '' COMMENT '验收新增字段'",
        "RENAME COLUMN `plan_name` TO `plan_title`",
        "ALTER COLUMN `remark` SET DEFAULT '新的默认值'",
        "MODIFY COLUMN `plan_title` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' COMMENT '明确修改的定义'",
        "DROP COLUMN `audit_note`",
    ]
    ddl_steps = []
    for clause in alterations:
        mysql('ALTER TABLE ddl_control '+clause, DB)
        expected = mysql('SHOW CREATE TABLE ddl_control', DB).decode().split('\t',1)[1].rstrip('\n')
        expected = expected.replace('CREATE TABLE `ddl_control`', 'CREATE TABLE `ddl_subject`', 1)
        ddl_steps.append({'sql':'ALTER TABLE `ddl_subject` '+clause, 'expected':expected})
    mysql("SET GLOBAL log_output='TABLE'; SET GLOBAL general_log=ON;")
    (ROOT / 'fixture.json').write_text(json.dumps({'id':'native-export-disposable','name':'验收临时库','type':'mysql',
        'host':'127.0.0.1','port':PORT,'username':'root','database':DB,'useSsl':False,'createdAt':0,'updatedAt':0}))
    (ROOT / 'protected.sql').write_text('KEEP EXISTING EXPORT')
    options = json.dumps({'root':str(ROOT),'db':DB,'ddl':ddl,'ddlSteps':ddl_steps}, ensure_ascii=False)
    script = r'''(async()=>{
      const cfg=CONFIG; const invoke=window.__TAURI_INTERNALS__.invoke;
      const id='native-export-disposable'; const checks=[];
      try {
        for(const [table,expected] of Object.entries(cfg.ddl)){
          const actual=await invoke('get_table_ddl',{id,schema:cfg.db,table});
          if(actual.trim()!==expected.trim())throw Error('DDL IPC mismatch: '+table);
        }
        checks.push('真实IPC读取完整DDL与独立MySQL客户端一致');
        for(const content of ['structure','both']){
          const result=await invoke('db_logical_backup',{id,schema:cfg.db,tables:Object.keys(cfg.ddl),views:[],funcs:[],procs:[],seqs:[],
            path:cfg.root+'/'+content+'.sql',content,createDb:true,taskId:'native-backup-'+content});
          if(result.tablesDone!==2||result.totalRows!==(content==='both'?5:0))throw Error('backup receipt mismatch '+JSON.stringify(result));
        }
        checks.push('真实IPC完整结构导出及结构加数据备份');
        const base={id,sql:'SELECT id,txt,payload,amount,flags,CAST(choices AS UNSIGNED) AS choices,CAST(kind AS UNSIGNED) AS kind,hidden_value FROM typed ORDER BY id',
          filePath:cfg.root+'/data.sql',format:'sql',encoding:'utf8',insertTable:'typed_copy',taskId:'native-stream',database:cfg.db};
        if(await invoke('db_stream_export',base)!==3)throw Error('stream row count mismatch');
        checks.push('真实IPC流式SQL导出');
        let rejected=false;
        try{await invoke('db_stream_export',{...base,sql:'SELECT dbterm_nonexistent_function()',filePath:cfg.root+'/protected.sql',taskId:'retry-after-failure'})}catch(e){rejected=true}
        if(!rejected)throw Error('invalid query must fail');
        if(await invoke('db_stream_export',{...base,filePath:cfg.root+'/retry.sql',taskId:'retry-after-failure'})!==3)throw Error('task cleanup failed');
        checks.push('执行失败后任务释放且同任务ID可重新导出');
        for(const step of cfg.ddlSteps){
          await invoke('execute_query',{id,sql:step.sql,database:cfg.db,rowLimit:10});
          const actual=await invoke('get_table_ddl',{id,schema:cfg.db,table:'ddl_subject'});
          if(actual.trim()!==step.expected.trim())throw Error('ALTER definition differs from independent server execution: '+step.sql);
        }
        const before=await invoke('get_table_ddl',{id,schema:cfg.db,table:'ddl_subject'});
        let alterRejected=false;
        try{await invoke('execute_query',{id,database:cfg.db,sql:'ALTER TABLE ddl_subject ADD COLUMN must_not_exist int, DROP COLUMN nonexistent_column'})}catch(e){alterRejected=true}
        if(!alterRejected)throw Error('invalid multi-action ALTER accepted');
        if(await invoke('get_table_ddl',{id,schema:cfg.db,table:'ddl_subject'})!==before)throw Error('failed ALTER left partial schema change');
        checks.push('真实IPC五次DDL编辑与独立执行一致，失败多动作ALTER无部分变更');
        await invoke('acceptance_result',{result:{ok:true,checks}});
      }catch(error){await invoke('acceptance_result',{result:{ok:false,checks,error:String(error)}})}
    })()'''.replace('CONFIG', options)
    if MIGRATION:
        mysql(f'CREATE DATABASE {DB}_target DEFAULT CHARSET=latin1 COLLATE=latin1_bin')
        mysql("CREATE USER 'migration_operator'@'127.0.0.1' IDENTIFIED BY ''; GRANT SELECT ON "+DB+".* TO 'migration_operator'@'127.0.0.1'; GRANT SELECT,INSERT,DELETE,CREATE,DROP,ALTER,INDEX,LOCK TABLES ON "+DB+"_target.* TO 'migration_operator'@'127.0.0.1'")
        connection=json.loads((ROOT/'fixture.json').read_text()); connection['username']='migration_operator'
        (ROOT/'fixture.json').write_text(json.dumps(connection))
        script = r'''(async()=>{
          const cfg=CONFIG, invoke=window.__TAURI_INTERNALS__.invoke, id='native-export-disposable', checks=[];
          try {
            for (const strategy of ['replace','skip']) {
              const target=strategy==='replace'?'migration_copy':'migration_structure';
              const result=await invoke('db_migrate_table',{srcId:id,srcSchema:cfg.db,srcTable:'mc_pos_settlement_company',
                dstId:id,dstSchema:cfg.db+'_target',dstTable:target,strategy,batchSize:1,
                options:{content:strategy==='replace'?'both':'structure',useTransaction:true,errorMode:'stop',conflictMode:'error'}});
              if(result.failedRows!==0||result.errors.length||result.migratedRows!==(strategy==='replace'?2:0))throw Error(JSON.stringify(result));
              const ddl=await invoke('get_table_ddl',{id,schema:cfg.db+'_target',table:target});
              if(ddl!==cfg.ddl.mc_pos_settlement_company.replace('CREATE TABLE \u0060mc_pos_settlement_company\u0060','CREATE TABLE \u0060'+target+'\u0060'))throw Error('copied DDL differs');
              checks.push(strategy+': real migration IPC succeeded, complete DDL identical');
            }
            for (const [strategy,content] of [['replace','both'],['truncate','data']]) {
              const result=await invoke('db_migrate_table',{srcId:id,srcSchema:cfg.db,srcTable:'mc_pos_settlement_company',
                dstId:id,dstSchema:cfg.db+'_target',dstTable:'migration_copy',strategy,batchSize:1,
                options:{content,useTransaction:true,errorMode:'stop',conflictMode:'error'}});
              if(result.failedRows!==0||result.errors.some(e=>!e.startsWith('旧目标完整保留为备份'))||result.migratedRows!==2)throw Error(JSON.stringify(result));
              if(strategy==='replace'&&!result.errors.some(e=>e.startsWith('旧目标完整保留为备份')))throw Error('old target backup missing');
              checks.push(strategy+'/'+content+': existing target migration succeeded');
            }
            await invoke('db_copy_table',{id,schema:cfg.db+'_target',srcTable:'migration_copy',dstTable:'shortcut_copy',copyData:true});
            const copied=await invoke('get_table_ddl',{id,schema:cfg.db+'_target',table:'shortcut_copy'});
            if(copied!==cfg.ddl.mc_pos_settlement_company.replace('CREATE TABLE \u0060mc_pos_settlement_company\u0060','CREATE TABLE \u0060shortcut_copy\u0060'))throw Error('same-schema copied DDL differs');
            checks.push('same-schema copy: real IPC succeeded without TRIGGER grant');
            let rejected=false;
            try { await invoke('db_migrate_table',{srcId:id,srcSchema:cfg.db,srcTable:'typed',dstId:id,dstSchema:cfg.db+'_target',
              dstTable:'migration_copy',strategy:'replace',batchSize:1,options:{content:'both',useTransaction:true}}); }
            catch(e){rejected=true;checks.push('unsupported types rejected: '+String(e))}
            if(!rejected)throw Error('unsupported types accepted');
            await invoke('acceptance_result',{result:{ok:true,checks}});
          }catch(error){await invoke('acceptance_result',{result:{ok:false,checks,error:String(error)}})}
        })()'''.replace('CONFIG',options)
    if GRID:
        mysql("CREATE TABLE grid_acceptance (id int PRIMARY KEY,a varchar(50),b varchar(50)) ENGINE=InnoDB; INSERT INTO grid_acceptance VALUES (1,'alpha','one'),(2,'beta','two'),(3,'gamma','three');", DB)
        script=(PROJECT/'scripts/acceptance/native-grid-probe.js').read_text().replace('CONFIG',options)
        subprocess.run(['swift',str(PROJECT/'scripts/acceptance/native-pasteboard.swift'),'save',str(ROOT/'clipboard.json')],check=True,timeout=30)
        clipboard_saved = True
        grid_server = subprocess.Popen(['node','scripts/acceptance/native-grid-server.mjs'],cwd=PROJECT,stdout=subprocess.PIPE,stderr=app_log,text=True)
        line = grid_server.stdout.readline().strip()
        assert line.startswith('GRID_URL='), line
        asset_url = line.split('=',1)[1]
    else:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(PROJECT/'dist'))
        assets = http.server.ThreadingHTTPServer(('127.0.0.1',0), handler)
        threading.Thread(target=assets.serve_forever,daemon=True).start()
        asset_url = 'http://127.0.0.1:'+str(assets.server_address[1])
    (ROOT / 'probe.js').write_text(script)
    env = os.environ.copy(); env['DBTERM_ACCEPTANCE_ROOT'] = str(ROOT)
    env['DBTERM_ACCEPTANCE_URL'] = asset_url
    app = subprocess.Popen([str(PROJECT / 'src-tauri/target/debug/examples/export_acceptance')],
        cwd=PROJECT, env=env, stdout=app_log, stderr=subprocess.STDOUT)
    app.wait(timeout=45)
    receipt = json.loads((ROOT / 'receipt.json').read_text())
    print(json.dumps(receipt,ensure_ascii=False),flush=True)
    assert app.returncode==0 and receipt['ok'], (app.returncode, receipt)
    if MIGRATION:
        assert mysql(signatures['mc_pos_settlement_company'].replace('mc_pos_settlement_company','migration_copy'),DB+'_target')==before['mc_pos_settlement_company'], 'migrated values changed or rejection damaged target'
        assert mysql('SELECT COUNT(*) FROM migration_structure',DB+'_target').strip()==b'0'
        assert mysql(signatures['mc_pos_settlement_company'].replace('mc_pos_settlement_company','shortcut_copy'),DB+'_target')==before['mc_pos_settlement_company'], 'same-schema copy changed data'
        assert mysql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '__dbterm_copy_%'",DB+'_target').strip()==b'0'
        assert mysql(signatures['mc_pos_settlement_company'],DB)==before['mc_pos_settlement_company'], 'source changed'
        assert mysql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '__dbterm_stage_%'",DB+'_target').strip()==b'0'
        print('PASS native migration: structure+data, structure-only, complete DDL, all 13 columns/data, functional index, unsupported-type target protection, no staged tables',flush=True)
        raise SystemExit(0)
    if GRID:
        actual = mysql('SELECT id,a,b FROM grid_acceptance ORDER BY id',DB)
        assert actual == b'1\tA1\tB1\n2\tA2\tB2\n3\tgrid-fill-acceptance\tgrid-fill-acceptance\n'.decode('unicode_escape').encode(), actual
        assert receipt['saveCalls']==3
        print('PASS native grid: actual component, clipboard plugin ACL/IPC, staged edits and three real MySQL batch saves; independent final rows verified',flush=True)
        raise SystemExit(0)
    mysql('SET GLOBAL general_log=OFF')
    query_log = mysql("SELECT argument FROM mysql.general_log WHERE command_type IN ('Query','Prepare','Execute') ORDER BY event_time").decode()
    (ROOT/'ddl-server-queries.log').write_text(query_log)
    (ROOT/'ddl-expected.json').write_text(json.dumps(ddl_steps,ensure_ascii=False,indent=2))
    for step in ddl_steps:
        assert '/* DBTerm */ '+step['sql'] in query_log, 'submitted DDL changed before server execution'
    assert mysql('SELECT HEX(plan_title) FROM ddl_subject WHERE plan_code=\'DDL\'',DB).strip()=='编辑验证'.encode().hex().upper().encode()
    print('PASS native DDL: five edits match independent execution, SQL preserved in server log, failed ALTER unchanged, existing values retained',flush=True)
    assert (ROOT/'protected.sql').read_text()=='KEEP EXISTING EXPORT', 'failed export overwrote existing file'
    assert not list(ROOT.glob('*.part')), 'staged export leaked'
    for t in tables:
        assert mysql(f'SHOW CREATE TABLE {t}',DB).decode().split('\t',1)[1].rstrip('\n')==ddl[t], 'export changed source DDL'
        assert mysql(signatures[t],DB)==before[t], 'export changed source rows'
    for content in ['structure','both']:
        output=(ROOT/(content+'.sql')).read_bytes()
        assert output.index(b'CREATE DATABASE') < output.index(b'CREATE TABLE'), 'database definition must precede tables'
        assert b'latin1' in output.split(b'CREATE TABLE',1)[0], 'source database default missing'
        for definition in ddl.values(): assert definition.encode()+b';' in output, 'raw table DDL changed'
        mysql(f'DROP DATABASE {DB}')
        session_check = mysql(b"SET SESSION SQL_MODE='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'; SET TIME_ZONE='+05:30';\n" +
            output + b"\nSELECT @@SESSION.sql_mode,@@SESSION.time_zone;")
        assert session_check.strip() == b'ANSI_QUOTES,NO_BACKSLASH_ESCAPES\t+05:30', 'backup replay changed caller session'
        assert mysql(f'SHOW CREATE DATABASE {DB}') == database_ddl, 'replayed database defaults differ'
        for t in tables:
            assert mysql(f'SHOW CREATE TABLE {t}',DB).decode().split('\t',1)[1].rstrip('\n')==ddl[t], 'replayed DDL differs'
            if content=='both': assert mysql(signatures[t],DB)==before[t], 'replayed values differ'
            else: assert mysql(f'SELECT COUNT(*) FROM {t}',DB).strip()==b'0'
        print('PASS native backup replay: '+content,flush=True)
    mysql('CREATE TABLE typed_copy LIKE typed',DB)
    session_check = mysql(b"SET SESSION SQL_MODE='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'; SET TIME_ZONE='+05:30';\n" +
        (ROOT/'data.sql').read_bytes() + b"\nSELECT @@SESSION.sql_mode,@@SESSION.time_zone;",DB)
    assert session_check.strip() == b'ANSI_QUOTES,NO_BACKSLASH_ESCAPES\t+05:30', 'stream replay changed caller session'
    assert mysql(signatures['typed'].replace('FROM typed ','FROM typed_copy '),DB)==before['typed']
    print('PASS native stream export replay; exact text/binary/NULL/decimal/uint64/BIT/ENUM/SET/invisible/generated values',flush=True)
    print('PASS failed export preserved existing file; no part files; source unchanged',flush=True)
    (ROOT/'evidence.json').write_text(json.dumps({'receipt':receipt,'output_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in ROOT.glob('*.sql')}},ensure_ascii=False,indent=2))
finally:
    if app and app.poll() is None:
        app.terminate(); app.wait(timeout=10)
    if server and server.poll() is None:
        subprocess.run([str(MYSQL/'mysqladmin'),'--no-defaults',f'--socket={ROOT}/mysql.sock','-u','root','shutdown'],stdout=log,stderr=subprocess.STDOUT,timeout=15)
        server.wait(timeout=15)
    if assets: assets.shutdown(); assets.server_close()
    if grid_server and grid_server.poll() is None:
        grid_server.terminate(); grid_server.wait(timeout=10)
    if clipboard_saved:
        subprocess.run(['swift',str(PROJECT/'scripts/acceptance/native-pasteboard.swift'),'restore',str(ROOT/'clipboard.json'),
            'alpha','alpha\tone\nalpha\ttwo\ngamma\tthree'.encode().decode('unicode_escape'),'grid-fill-acceptance','A1\tB1\nA2\tB2'.encode().decode('unicode_escape')],check=True,timeout=30)
    log.close(); app_log.close()
    print('Disposable fixture stopped; evidence at '+str(ROOT),flush=True)
