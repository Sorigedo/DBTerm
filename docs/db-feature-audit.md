# DB 功能按钮与方言适配静态审计

> 自动生成：`npm run audit:db-features`。这是静态审计，不替代真实数据库实连测试。

## 汇总

| 项目               | 数量  |
| ---------------- | --- |
| 扫描前端文件           | 152 |
| 前端 DB invoke 命令  | 248 |
| 后端已注册 DB 命令      | 329 |
| 前端调用但后端未注册       | 0   |
| 工具目录项            | 40  |
| 目录有但未渲染工具        | 0   |
| 内嵌集合有但 switch 缺失 | 0   |
| 动态 invoke 调用点    | 5   |
| 前端 SQL 方言风险候选    | 119 |

## 前端调用但后端未注册

未发现。

## 工具目录渲染一致性

工具目录项均可在 `DbToolPanels` 或 `advancedEmbed` 中找到渲染分支。

## 工具入口方言可见矩阵

来自 `src/components/DbTools/dbToolsCatalog.tsx`。`✓` 表示该工具会在对应连接类型下显示。

| 工具                            | 分类       | mysql | mariadb | tidb | oceanBase | postgres | kingBase | openGauss | sqlite | duckdb | sqlServer | oracle | clickHouse | redis | mongodb |
| ----------------------------- | -------- | ----- | ------- | ---- | --------- | -------- | -------- | --------- | ------ | ------ | --------- | ------ | ---------- | ----- | ------- |
| 库管理 (dbManager)               | object   | ✓     | ✓       | ✓    | ✓         |          |          |           |        |        |           |        |            |       |         |
| 数据字典 (dataDict)               | object   | ✓     | ✓       | ✓    | ✓         | ✓        | ✓        | ✓         | ✓      | ✓      | ✓         | ✓      | ✓          | ✓     | ✓       |
| ER 关系图 (erDiagram)            | object   | ✓     | ✓       | ✓    | ✓         | ✓        | ✓        | ✓         | ✓      | ✓      | ✓         | ✓      | ✓          | ✓     | ✓       |
| 数据全文检索 (fullText)             | object   | ✓     | ✓       | ✓    | ✓         | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| 备份恢复 (backupRestore)          | object   | ✓     | ✓       | ✓    | ✓         | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| 导出任务中心 (exportCenter)         | object   | ✓     | ✓       | ✓    | ✓         | ✓        | ✓        | ✓         | ✓      | ✓      | ✓         | ✓      | ✓          | ✓     | ✓       |
| 定时任务 (scheduler)              | object   | ✓     | ✓       | ✓    | ✓         |          |          |           |        |        |           |        |            |       |         |
| Binlog 闪回 (binlogFb)          | object   | ✓     | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| 在线大表改表 (onlineDdl)            | object   | ✓     | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| Galera 集群 (galera)            | advanced |       | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| 时间旅行查询 (timeravel)            | advanced |       | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| 优化器治理 (optimizer)             | advanced |       | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| MaxScale 探测 (maxScale)        | advanced |       | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| 物理工具引导 (mariaPhysical)        | advanced |       | ✓       |      |           |          |          |           |        |        |           |        |            |       |         |
| PG 维护工具 (pgMaintenance)       | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 复制状态 (pgReplication)       | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 高级对象 (pgAdvanced)          | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 声明式分区 (pgPartition)        | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 角色管理 (pgRoles)             | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG FDW 外部表 (pgFdw)            | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 自动分区维护 (pgPartman)         | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PgBouncer 连接池 (pgBouncer)     | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 误删恢复指南 (pgPitr)            | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| PG 配置对比 (configCompare)       | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| pgvector 查询 (pgVector)        | advanced |       |         |      |           | ✓        | ✓        | ✓         |        |        |           |        |            |       |         |
| 金仓 KES 监控 (kbMonitor)         | advanced |       |         |      |           |          | ✓        |           |        |        |           |        |            |       |         |
| 金仓内置审计 (kbAudit)              | advanced |       |         |      |           |          | ✓        |           |        |        |           |        |            |       |         |
| dbe_perf 性能看板 (ogDbePerf)     | advanced |       |         |      |           |          |          | ✓         |        |        |           |        |            |       |         |
| openGauss 高安全特性 (ogSecurity)  | advanced |       |         |      |           |          |          | ✓         |        |        |           |        |            |       |         |
| 智能索引推荐 (ogIndexAdvise)        | advanced |       |         |      |           |          |          | ✓         |        |        |           |        |            |       |         |
| TiDB 分布式运维 (tidb)             | advanced |       |         | ✓    |           |          |          |           |        |        |           |        |            |       |         |
| OceanBase 分布式运维 (oceanBase)   | advanced |       |         |      | ✓         |          |          |           |        |        |           |        |            |       |         |
| CH 运维面板 (clickHouse)          | advanced |       |         |      |           |          |          |           |        |        |           |        | ✓          |       |         |
| 物化视图血缘 (chLineage)            | advanced |       |         |      |           |          |          |           |        |        |           |        | ✓          |       |         |
| Redis 工具 (redisTools)         | advanced |       |         |      |           |          |          |           |        |        |           |        |            | ✓     |         |
| 索引碎片整理 (mssqlIndexFrag)       | advanced |       |         |      |           |          |          |           |        |        | ✓         |        |            |       |         |
| SQL Agent 作业 (mssqlAgentJobs) | advanced |       |         |      |           |          |          |           |        |        | ✓         |        |            |       |         |
| 等待统计 (mssqlWaitStats)         | advanced |       |         |      |           |          |          |           |        |        | ✓         |        |            |       |         |
| 备份 / AlwaysOn (mssqlBackup)   | advanced |       |         |      |           |          |          |           |        |        | ✓         |        |            |       |         |
| 误删恢复指南 (mssqlPitr)            | advanced |       |         |      |           |          |          |           |        |        | ✓         |        |            |       |         |

## DBA 内嵌工具一致性

`ADV_EMBEDDED` 与 `renderAdvancedEmbedded` 分支一致。

## 动态 invoke 调用点

这些调用需要人工或更深 AST 分析确认实际命令名。

| 表达式         | 位置                                             |
| ----------- | ---------------------------------------------- |
| cmd         | src/components/DbTools/PartitionPanel.tsx:62   |
| cmd         | src/components/DbTools/UserManagePanel.tsx:210 |
| cmd         | src/components/DbTools/UsersPanel.tsx:212      |
| executeInTx | src/components/SqlEditor/index.tsx:1198        |
| executeInTx | src/components/SqlEditor/index.tsx:1285        |

## 前端自拼 SQL 方言风险候选

这些是静态扫描候选，不直接判定为 bug。若同一行或附近上下文检测到 `qid` / `tableRef` / `connType` / capability guard，通常表示已有方言分支或共享方言层保护。

### 按风险类型汇总

| 类型                   | 数量 |
| -------------------- | -- |
| DDL/DCL 生成           | 56 |
| MySQL SHOW 语句        | 26 |
| 分页语法                 | 17 |
| DML 生成               | 15 |
| 硬编码双引号标识符            | 7  |
| SQLite/DuckDB PRAGMA | 5  |
| 维护语句                 | 5  |
| 硬编码反引号标识符            | 1  |

### 按守卫/共享方言层汇总

| 检测到的守卫                                                                    | 数量 |
| ------------------------------------------------------------------------- | -- |
| 未检测到明显方言守卫                                                                | 68 |
| connType, qid                                                             | 7  |
| connType                                                                  | 3  |
| connType, sqlite guard                                                    | 3  |
| mssql guard                                                               | 3  |
| mysql guard                                                               | 3  |
| qid, sqlite guard                                                         | 3  |
| capability guard, connType                                                | 2  |
| capability guard, connType, shared dialect helper                         | 2  |
| capability guard, qid, sqlite guard                                       | 2  |
| connType, duckdb guard, sqlite guard                                      | 2  |
| connType, qid, shared dialect helper                                      | 2  |
| connType, shared dialect helper                                           | 2  |
| oracle guard                                                              | 2  |
| capability guard                                                          | 1  |
| connType, dialectFamily, mssql guard, oracle guard, shared dialect helper | 1  |
| connType, duckdb guard, mssql guard, oracle guard, sqlite guard           | 1  |
| connType, duckdb guard, mysql guard, pg guard, qid, sqlite guard          | 1  |
| connType, duckdb guard, mysql guard, sqlite guard                         | 1  |
| connType, mysql guard                                                     | 1  |
| connType, mysql guard, oracle guard, pg guard                             | 1  |
| connType, mysql guard, pg guard, qid, sqlite guard                        | 1  |
| connType, mysql guard, sqlite guard                                       | 1  |
| duckdb guard                                                              | 1  |
| duckdb guard, oracle guard, sqlite guard                                  | 1  |
| pg guard                                                                  | 1  |
| qid                                                                       | 1  |
| qid, shared dialect helper                                                | 1  |
| sqlite guard                                                              | 1  |

### 候选明细

| 位置                                                  | 类型                              | 守卫                                                                        | 片段                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/components/AssetPanel/DbSchemaTree.tsx:330      | MySQL SHOW 语句                   | connType, mysql guard                                                     | `sql: \`SHOW COLLATION WHERE Charset = '${createDbCharset.replace(/'/g, "''")}'\`,`                                                                                                       |
| src/components/AssetPanel/DbSchemaTree.tsx:1564     | 维护语句                            | capability guard, connType, shared dialect helper                         | `openAction('优化表', \`对表 ${ctxMenu.table} 执行 OPTIMIZE TABLE（重建表与索引，回收碎片空间）\`,`                                                                                                             |
| src/components/AssetPanel/DbSchemaTree.tsx:1572     | 维护语句                            | connType, shared dialect helper                                           | `openAction('分析表', \`对表 ${ctxMenu.table} 执行 ANALYZE TABLE（重新统计索引分布，优化查询计划）\`,`                                                                                                            |
| src/components/AssetPanel/DbSchemaTree.tsx:1580     | 维护语句                            | connType, shared dialect helper                                           | `openAction('检查表', \`对表 ${ctxMenu.table} 执行${connType === 'tidb' ? ' ADMIN CHECK TABLE' : ' CHECK TABLE'}（检查表与索引完整性）\`,`                                                                  |
| src/components/AssetPanel/DbSchemaTree.tsx:1600     | DDL/DCL 生成, MySQL SHOW 语句       | capability guard, connType, shared dialect helper                         | `<button onClick={() => { openSchemaFill(\`SHOW CREATE ${routineCtx.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${tableRef(connType, routineCtx.schema, routineCtx.name)};\`); setR`  |
| src/components/AssetPanel/DbSchemaTree.tsx:1976     | DDL/DCL 生成                      | connType, qid                                                             | `await invoke('execute_query', { id: connectionId, sql: \`DROP DATABASE ${qid(connType, dropDbTarget)}\` })`                                                                              |
| src/components/DbTools/AlterTableWizard.tsx:53      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ADD COLUMN ${q(col.name)} ${col.dataType || 'VARCHAR'}${nullStr}${defStr};\`)`                                                                          |
| src/components/DbTools/AlterTableWizard.tsx:55      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};\`)`                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:64      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};\`)`                                                                                                    |
| src/components/DbTools/AlterTableWizard.tsx:67      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} TYPE ${col.dataType};\`)`                                                                                                   |
| src/components/DbTools/AlterTableWizard.tsx:76      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} SET DEFAULT '${col.defaultValue.replace(/'/g, "''")}';\`)`                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:78      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} DROP DEFAULT;\`)`                                                                                                           |
| src/components/DbTools/AlterTableWizard.tsx:99      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};\`)`                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:104     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(orig.name)} ${type}${col.nullable ? ' NULL' : ' NOT NULL'};\`)`                                                                        |
| src/components/DbTools/AlterTableWizard.tsx:106     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ADD DEFAULT ${lit(col.defaultValue)} FOR ${q(orig.name)};\`)`                                                                                           |
| src/components/DbTools/AlterTableWizard.tsx:125     | DDL/DCL 生成                      | connType, qid                                                             | `stmts.push(\`ALTER TABLE ${tref} ADD (${inner});\`)`                                                                                                                                     |
| src/components/DbTools/AlterTableWizard.tsx:127     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};\`)`                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:134     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `if (mod.length) stmts.push(\`ALTER TABLE ${tref} MODIFY (${q(orig.name)} ${mod.join(' ')});\`)`                                                                                          |
| src/components/DbTools/AlterTableWizard.tsx:138     | DDL/DCL 生成                      | connType, qid                                                             | `stmts.push(\`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};\`)`                                                                                                    |
| src/components/DbTools/AlterTableWizard.tsx:161     | DDL/DCL 生成                      | pg guard                                                                  | `stmts.push(\`ALTER TABLE ${tref} ADD COLUMN ${def};\`)`                                                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:163     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};\`)`                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:168     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(orig.name)} TYPE ${col.dataType};\`)`                                                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:170     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} ${col.nullable ? 'DROP' : 'SET'} NOT NULL;\`)`                                                                              |
| src/components/DbTools/AlterTableWizard.tsx:173     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} SET DEFAULT '${col.defaultValue.replace(/'/g, "''")}';\`)`                                                                  |
| src/components/DbTools/AlterTableWizard.tsx:175     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} DROP DEFAULT;\`)`                                                                                                           |
| src/components/DbTools/AlterTableWizard.tsx:178     | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `stmts.push(\`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};\`)`                                                                                                    |
| src/components/DbTools/AlterTableWizard.tsx:218     | DDL/DCL 生成                      | connType, duckdb guard, mysql guard, sqlite guard                         | `return \`ALTER TABLE ${tref}\n${parts.join(',\n')};\``                                                                                                                                   |
| src/components/DbTools/AlterTableWizard.tsx:283     | DDL/DCL 生成, MySQL SHOW 语句       | connType                                                                  | `const res = await invoke<R>('execute_query', { id: connectionId, sql: \`SHOW CREATE TABLE ${tref}\` })`                                                                                  |
| src/components/DbTools/BinlogFlashbackPanel.tsx:92  | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `const res = await invoke<R>('execute_query', { id: connectionId, sql: 'SHOW BINARY LOGS' })`                                                                                             |
| src/components/DbTools/BinlogFlashbackPanel.tsx:112 | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `let sql = \`SHOW BINLOG EVENTS IN '${selectedLog.replace(/'/g, "''")}'\``                                                                                                                |
| src/components/DbTools/CreateDatabaseDialog.tsx:48  | MySQL SHOW 语句                   | mysql guard                                                               | `sql: \`SHOW COLLATION WHERE Charset = '${charset.replace(/'/g, "''")}'\`,`                                                                                                               |
| src/components/DbTools/CreateTableWizard.tsx:308    | DDL/DCL 生成                      | qid, shared dialect helper                                                | `for (const o of origCols) if (!curIds.has(o._id)) clauses.push(\` DROP COLUMN ${qid(ct, o.name.trim())}\`)`                                                                              |
| src/components/DbTools/CreateTableWizard.tsx:329    | DDL/DCL 生成                      | qid                                                                       | `return \`ALTER TABLE ${tref}\n${clauses.join(',\n')};\``                                                                                                                                 |
| src/components/DbTools/CreateTableWizard.tsx:334    | DDL/DCL 生成                      | qid, sqlite guard                                                         | `for (const o of origCols) if (!curIds.has(o._id)) stmts.push(\`ALTER TABLE ${tref} DROP COLUMN ${qid(ct, o.name.trim())};\`)`                                                            |
| src/components/DbTools/CreateTableWizard.tsx:337    | DDL/DCL 生成                      | qid, sqlite guard                                                         | `if (!orig) { stmts.push(\`ALTER TABLE ${tref} ADD COLUMN ${columnDef(c, ct)};\`); continue }`                                                                                            |
| src/components/DbTools/CreateTableWizard.tsx:339    | DDL/DCL 生成                      | qid, sqlite guard                                                         | `stmts.push(\`ALTER TABLE ${tref} RENAME COLUMN ${qid(ct, orig.name.trim())} TO ${qid(ct, c.name.trim())};\`)`                                                                            |
| src/components/DbTools/CreateTableWizard.tsx:343    | DDL/DCL 生成                      | capability guard, qid, sqlite guard                                       | `else stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${qid(ct, c.name.trim())} TYPE ${colType(c, ct)};\`)`                                                                                 |
| src/components/DbTools/CreateTableWizard.tsx:346    | DDL/DCL 生成                      | capability guard, qid, sqlite guard                                       | `stmts.push(\`ALTER TABLE ${tref} ALTER COLUMN ${qid(ct, c.name.trim())} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};\`)`                                                            |
| src/components/DbTools/CreateTableWizard.tsx:395    | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `postIdx.push(\`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idxName)} ON ${tref}${using} (${idxCols.map(q).join(', ')});\`)`                                                           |
| src/components/DbTools/CreateTableWizard.tsx:411    | DDL/DCL 生成                      | capability guard                                                          | `let sql = \`CREATE TABLE ${tref} (\n${lines.join(',\n')}\n)\``                                                                                                                           |
| src/components/DbTools/CreateTableWizard.tsx:495    | MySQL SHOW 语句                   | mysql guard                                                               | `const cs = await invoke<Rows>('execute_query', { id: connectionId, sql: 'SHOW CHARACTER SET' })`                                                                                         |
| src/components/DbTools/CreateTableWizard.tsx:500    | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `const eg = await invoke<Rows>('execute_query', { id: connectionId, sql: 'SHOW ENGINES' })`                                                                                               |
| src/components/DbTools/CreateTableWizard.tsx:592    | MySQL SHOW 语句                   | mysql guard                                                               | `sql: \`SHOW COLLATION WHERE Charset = '${charset.replace(/'/g, "''")}'\`,`                                                                                                               |
| src/components/DbTools/DashboardPanel.tsx:111       | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `id: connId, sql: "SHOW GLOBAL STATUS LIKE 'Threadpool%'",`                                                                                                                               |
| src/components/DbTools/DataCleanPanel.tsx:61        | 硬编码反引号标识符                       | connType, duckdb guard, mysql guard, pg guard, qid, sqlite guard          | `return \`-- MySQL 去重（将 \\`id\\` 替换为实际主键列名）\nDELETE FROM ${t}\nWHERE ${qid(connType, 'id')} NOT IN (\n SELECT * FROM (\n SELECT MIN(${qid(connType, 'id')}) FROM ${t} GROUP BY ${col}\n ` |
| src/components/DbTools/DataCleanPanel.tsx:65        | DML 生成                          | connType, mysql guard, pg guard, qid, sqlite guard                        | `return \`UPDATE ${t}\nSET ${col} = ${quote(replaceVal)}\nWHERE ${col} = ${quote(findVal)};\``                                                                                            |
| src/components/DbTools/DataCleanPanel.tsx:70        | DML 生成                          | connType, mysql guard, sqlite guard                                       | `return \`UPDATE ${t}\nSET ${col} = ${quote(fillVal)}\nWHERE ${col} IS NULL${emptyCheck};\``                                                                                              |
| src/components/DbTools/DataDiffPanel.tsx:75         | DML 生成                          | connType, qid, shared dialect helper                                      | `lines.push(\`INSERT INTO ${tbl} (${cols}) VALUES (${vals});\`)`                                                                                                                          |
| src/components/DbTools/DataDiffPanel.tsx:81         | DML 生成                          | 未检测到明显方言守卫                                                                | `lines.push(\`DELETE FROM ${tbl} WHERE ${where};\`)`                                                                                                                                      |
| src/components/DbTools/DataDiffPanel.tsx:92         | DML 生成                          | 未检测到明显方言守卫                                                                | `lines.push(\`UPDATE ${tbl} SET ${set} WHERE ${where};\`)`                                                                                                                                |
| src/components/DbTools/DbaTemplatesPanel.tsx:25     | 分页语法                            | duckdb guard, oracle guard, sqlite guard                                  | `sql: \`PREPARE stmt FROM 'SELECT 1 LIMIT 1';`                                                                                                                                            |
| src/components/DbTools/DbaTemplatesPanel.tsx:175    | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW GLOBAL STATUS LIKE 'Threads_connected';`                                                                                                                                     |
| src/components/DbTools/DbaTemplatesPanel.tsx:383    | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW GLOBAL STATUS WHERE Variable_name IN (`                                                                                                                                      |
| src/components/DbTools/DbaTemplatesPanel.tsx:415    | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW GLOBAL STATUS WHERE Variable_name IN (`                                                                                                                                      |
| src/components/DbTools/DbaTemplatesPanel.tsx:441    | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW ALL SLAVES STATUS;\`,`                                                                                                                                                       |
| src/components/DbTools/DbaTemplatesPanel.tsx:479    | MySQL SHOW 语句                   | oracle guard                                                              | `sql: \`SHOW GLOBAL VARIABLES LIKE 'server_audit%';\`,`                                                                                                                                   |
| src/components/DbTools/DbaTemplatesPanel.tsx:938    | 分页语法                            | mssql guard                                                               | `sql: \`SELECT TOP 20`                                                                                                                                                                    |
| src/components/DbTools/DbaTemplatesPanel.tsx:953    | 分页语法                            | mssql guard                                                               | `sql: \`SELECT TOP 20`                                                                                                                                                                    |
| src/components/DbTools/DbaTemplatesPanel.tsx:995    | 分页语法                            | mssql guard                                                               | `sql: \`SELECT TOP 20`                                                                                                                                                                    |
| src/components/DbTools/DbaTemplatesPanel.tsx:1053   | SQLite/DuckDB PRAGMA            | sqlite guard                                                              | `sql: \`PRAGMA page_count;`                                                                                                                                                               |
| src/components/DbTools/DuckFileQueryDialog.tsx:91   | 分页语法                            | 未检测到明显方言守卫                                                                | `sql: \`SELECT * FROM ${readExpr} LIMIT 5\`,`                                                                                                                                             |
| src/components/DbTools/DuckLakePanel.tsx:58         | 分页语法                            | duckdb guard                                                              | `const sql = \`SELECT * FROM ${fmt.scan}('${esc}') LIMIT ${k}\``                                                                                                                          |
| src/components/DbTools/HealthCheckPanel.tsx:141     | 分页语法                            | 未检测到明显方言守卫                                                                | `const res = await q(\`SELECT datname, age(datfrozenxid) FROM pg_database WHERE datallowconn ORDER BY age(datfrozenxid) DESC LIMIT 1\`)`                                                  |
| src/components/DbTools/HealthCheckPanel.tsx:184     | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_flow_control_paused','wsrep_cluster_status','wsrep_ready')",`                                                                    |
| src/components/DbTools/HealthCheckPanel.tsx:203     | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threadpool_threads','Threadpool_active_threads','Threadpool_queued')",`                                                                |
| src/components/DbTools/HealthCheckPanel.tsx:272     | 分页语法                            | oracle guard                                                              | `await q(\`SELECT 1 FROM sys_stat_database LIMIT 1\`)`                                                                                                                                    |
| src/components/DbTools/HealthCheckPanel.tsx:323     | 分页语法                            | 未检测到明显方言守卫                                                                | `await q(\`SELECT 1 FROM dbe_perf.statement LIMIT 0\`)`                                                                                                                                   |
| src/components/DbTools/HealthCheckPanel.tsx:450     | 分页语法                            | 未检测到明显方言守卫                                                                | `const res = await q(\`SELECT is_error, is_suspended, status FROM oceanbase.DBA_OB_MAJOR_COMPACTION LIMIT 1\`)`                                                                           |
| src/components/DbTools/KbMonitorPanel.tsx:115       | 分页语法                            | 未检测到明显方言守卫                                                                | `const licRes = await q(\`SELECT * FROM sys_license LIMIT 1\`)`                                                                                                                           |
| src/components/DbTools/LockAnalysisPanel.tsx:50     | 分页语法                            | connType                                                                  | `sql: \`SELECT THREAD_ID, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME, LOCK_TYPE, LOCK_DURATION FROM information_schema.METADATA_LOCK_INFO LIMIT 50\`,`                                       |
| src/components/DbTools/LockHistoryPanel.tsx:130     | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: 'SHOW ENGINE INNODB STATUS',`                                                                                                                                                       |
| src/components/DbTools/MgrPanel.tsx:93              | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW GLOBAL STATUS WHERE Variable_name LIKE 'Rpl_semi_sync%'\`,`                                                                                                                  |
| src/components/DbTools/MssqlToolsPanels.tsx:98      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `const sql = \`ALTER INDEX [${row[ii]}] ON [${row[si]}].[${row[ti]}] ${op};\``                                                                                                            |
| src/components/DbTools/MssqlToolsPanels.tsx:131     | 分页语法                            | 未检测到明显方言守卫                                                                | `const WAITS_SQL = \`SELECT TOP 30 wait_type,`                                                                                                                                            |
| src/components/DbTools/MssqlToolsPanels.tsx:159     | 分页语法                            | 未检测到明显方言守卫                                                                | `const BACKUP_SQL = \`SELECT TOP 50 bs.database_name,`                                                                                                                                    |
| src/components/DbTools/OgDbePerfPanel.tsx:135       | 分页语法                            | 未检测到明显方言守卫                                                                | `await q(\`SELECT 1 FROM dbe_perf.statement LIMIT 0\`)`                                                                                                                                   |
| src/components/DbTools/OnlineDdlPanel.tsx:97        | DDL/DCL 生成                      | connType, qid                                                             | `return \`ALTER TABLE ${qid(connType, schema)}.${qid(connType, selectedTable)}\n ${ddlText.trim()},\n ALGORITHM=${algorithm}, LOCK=${lock};\``                                            |
| src/components/DbTools/OptimizerPanel.tsx:156       | 维护语句                            | 未检测到明显方言守卫                                                                | `sql: \`ANALYZE TABLE ${target} PERSISTENT FOR ALL\`,`                                                                                                                                    |
| src/components/DbTools/PgAdvancedPanel.tsx:291      | DDL/DCL 生成, 硬编码双引号标识符           | 未检测到明显方言守卫                                                                | `if (onRunSql) { onRunSql(\`CREATE EXTENSION IF NOT EXISTS "${name}";\`); onClose() }`                                                                                                    |
| src/components/DbTools/PgMaintenancePanel.tsx:243   | 维护语句                            | 未检测到明显方言守卫                                                                | `else if (!tgt && vacMode === 'VACUUM FULL') sql = 'VACUUM FULL'`                                                                                                                         |
| src/components/DbTools/PgPartitionPanel.tsx:126     | DDL/DCL 生成, 硬编码双引号标识符           | 未检测到明显方言守卫                                                                | `const sql = \`ALTER TABLE "${selected.schemaName}"."${selected.tableName}" DETACH PARTITION "${childSchema}"."${childTable}";\``                                                         |
| src/components/DbTools/PgPartitionPanel.tsx:132     | DDL/DCL 生成, 硬编码双引号标识符           | 未检测到明显方言守卫                                                                | `const sql = \`ALTER TABLE "${selected.schemaName}"."${selected.tableName}" ATTACH PARTITION ${attachTable.trim()} ${attachBound.trim()};\``                                              |
| src/components/DbTools/PgPartitionPanel.tsx:139     | DDL/DCL 生成, 硬编码双引号标识符           | 未检测到明显方言守卫                                                                | `const sql = \`CREATE TABLE "${selected.schemaName}"."${createName.trim()}" PARTITION OF "${selected.schemaName}"."${selected.tableName}" ${createBound.trim()};\``                       |
| src/components/DbTools/PgRolesPanel.tsx:98          | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `return \`GRANT "${grantRole}" TO "${grantTarget}";\``                                                                                                                                    |
| src/components/DbTools/PgRolesPanel.tsx:101         | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `return \`REVOKE "${grantRole}" FROM "${grantTarget}";\``                                                                                                                                 |
| src/components/DbTools/PgRolesPanel.tsx:105         | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `return \`CREATE ROLE "${newRoleName}"${newPassword ? ' LOGIN' : passClause};\``                                                                                                          |
| src/components/DbTools/PgRolesPanel.tsx:108         | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `return \`DROP ROLE IF EXISTS "${dropTarget}";\``                                                                                                                                         |
| src/components/DbTools/PgRolesPanel.tsx:111         | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `return \`ALTER ROLE "${grantTarget}" PASSWORD '***';\``                                                                                                                                  |
| src/components/DbTools/PgVectorPanel.tsx:86         | 分页语法, 硬编码双引号标识符                 | 未检测到明显方言守卫                                                                | `const sql = \`SELECT *, ${q} AS _distance FROM "${col.schemaName}"."${col.tableName}" ORDER BY ${q} LIMIT ${k}\``                                                                        |
| src/components/DbTools/ProcessListPanel.tsx:113     | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: \`SHOW EXPLAIN FOR ${pid}\`,`                                                                                                                                                       |
| src/components/DbTools/ReplicationPanel.tsx:63      | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('gtid_slave_pos','gtid_binlog_pos','gtid_current_pos')",`                                                                            |
| src/components/DbTools/ReplicationPanel.tsx:82      | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `sql: 'SHOW ALL SLAVES STATUS',`                                                                                                                                                          |
| src/components/DbTools/SequencePanel.tsx:137        | DDL/DCL 生成, DML 生成              | 未检测到明显方言守卫                                                                | `const sql = \`CREATE OR REPLACE SEQUENCE ${seqRef(name.trim())} START WITH ${start.trim()} INCREMENT BY ${increment.trim()} MINVALUE ${minVal.trim()} MAXVALUE ${maxVal.trim()}${cycl`   |
| src/components/DbTools/SequencePanel.tsx:163        | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `sql: \`DROP SEQUENCE ${seqRef(seqName)}\`,`                                                                                                                                              |
| src/components/DbTools/TableBrowser.tsx:379         | SQLite/DuckDB PRAGMA, 硬编码双引号标识符 | connType, sqlite guard                                                    | `sql: \`PRAGMA table_info("${table.replace(/"/g, '""')}")\`,`                                                                                                                             |
| src/components/DbTools/TableBrowser.tsx:562         | DML 生成                          | 未检测到明显方言守卫                                                                | `const sql = \`INSERT INTO ${tableRef} (${entries.map(([c]) => q(c)).join(', ')}) VALUES (${entries.map(([, v]) => sqlLiteral(v)).join(', ')})\``                                         |
| src/components/DbTools/TableBrowser.tsx:657         | DML 生成                          | 未检测到明显方言守卫                                                                | `return \`INSERT INTO ${tableRef} (${cols}) VALUES (${vals});\``                                                                                                                          |
| src/components/DbTools/TableBrowser.tsx:737         | MySQL SHOW 语句                   | connType, mysql guard, oracle guard, pg guard                             | `sql = \`SHOW FULL COLUMNS FROM ${tableRef}\``                                                                                                                                            |
| src/components/DbTools/TableBrowser.tsx:749         | SQLite/DuckDB PRAGMA, 硬编码双引号标识符 | connType, duckdb guard, mssql guard, oracle guard, sqlite guard           | `sql = \`PRAGMA table_info("${table.replace(/"/g, '""')}")\``                                                                                                                             |
| src/components/DbTools/TableBrowser.tsx:822         | DDL/DCL 生成, DML 生成              | connType, sqlite guard                                                    | `const clearSql = isSqlite(connType) ? \`DELETE FROM ${tableRef};\` : \`TRUNCATE TABLE ${tableRef};\``                                                                                    |
| src/components/DbTools/TestDataGenPanel.tsx:94      | DML 生成                          | connType, qid                                                             | `return \`INSERT INTO ${t} (${colList})\nVALUES\n ${rows.join(',\n ')};\``                                                                                                                |
| src/components/DbTools/TidbPanel.tsx:180            | MySQL SHOW 语句                   | 未检测到明显方言守卫                                                                | `const varRes = await q(\`SHOW VARIABLES LIKE 'tidb_%gc%'\`)`                                                                                                                             |
| src/components/DbTools/TimeravelPanel.tsx:121       | DML 生成                          | 未检测到明显方言守卫                                                                | `const deleteSql = \`DELETE HISTORY FROM ${tableRef} BEFORE SYSTEM_TIME TIMESTAMP '${deleteBeforeTs}'\``                                                                                  |
| src/components/DbTools/UserManagePanel.tsx:27       | DDL/DCL 生成, DML 生成              | connType                                                                  | `const MYSQL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'EXECUTE', 'ALL PRIVILEGES']`                                             |
| src/components/DbTools/UserManagePanel.tsx:107      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `await invoke<R>('execute_query', { id: connectionId, sql: \`CREATE ROLE ${q(newRoleName.trim())}\` })`                                                                                   |
| src/components/DbTools/UserManagePanel.tsx:121      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `await invoke<R>('execute_query', { id: connectionId, sql: \`DROP ROLE ${q(name)}\` })`                                                                                                   |
| src/components/DbTools/UserManagePanel.tsx:132      | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `const sql = \`GRANT ${q(grantRoleName)} TO ${mysqlAccount(u.name, u.host)}\``                                                                                                            |
| src/components/SchemaBrowser/index.tsx:491          | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `await invoke('execute_query', { id: connectionId, sql: \`DROP VIEW ${tref(name)};\` })`                                                                                                  |
| src/components/SchemaBrowser/index.tsx:493          | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `await invoke('execute_query', { id: connectionId, sql: \`DROP FUNCTION ${tref(name)};\` })`                                                                                              |
| src/components/SchemaBrowser/index.tsx:495          | DDL/DCL 生成                      | 未检测到明显方言守卫                                                                | `await invoke('execute_query', { id: connectionId, sql: \`DROP PROCEDURE ${tref(name)};\` })`                                                                                             |
| src/components/SchemaBrowser/index.tsx:706          | MySQL SHOW 语句                   | capability guard, connType                                                | `id: connectionId, sql: \`SHOW FULL COLUMNS FROM ${tref(tableName)}\`,`                                                                                                                   |
| src/components/SchemaBrowser/index.tsx:1259         | DDL/DCL 生成, MySQL SHOW 语句       | capability guard, connType                                                | `<button onClick={() => { fillQuery(\`SHOW CREATE ${rkind} ${tref(name)};\`); closeMenu() }}>`                                                                                            |
| src/components/SqlEditor/index.tsx:1136             | SQLite/DuckDB PRAGMA            | connType, duckdb guard, sqlite guard                                      | `const uvBefore = await inv<QueryResult>('execute_query', { id: connectionId, sql: 'PRAGMA user_version' })`                                                                              |
| src/components/SqlEditor/index.tsx:1216             | SQLite/DuckDB PRAGMA            | connType, duckdb guard, sqlite guard                                      | `const uvRow = await inv2<QueryResult>('execute_query', { id: connectionId, sql: 'PRAGMA user_version' })`                                                                                |
| src/components/SqlEditor/ObjectEditor.tsx:227       | DDL/DCL 生成                      | connType, sqlite guard                                                    | `await invoke('execute_query', { id: connectionId, sql: \`DROP VIEW IF EXISTS "${viewName.replace(/"/g, '""')}"\` })`                                                                     |
| src/components/SqlEditor/ObjectEditor.tsx:316       | 分页语法                            | connType, dialectFamily, mssql guard, oracle guard, shared dialect helper | `const sql = fam === 'mssql' ? \`SELECT TOP 100 * FROM ${ref};\``                                                                                                                         |
| src/components/SqlEditor/ResultTable.tsx:173        | DML 生成                          | connType, qid, shared dialect helper                                      | `return \`INSERT INTO ${tref} (${cols}) VALUES (${vals});\``                                                                                                                              |
| src/components/SqlEditor/ResultTable.tsx:179        | DML 生成                          | connType, qid                                                             | `return \`DELETE FROM ${tref} WHERE ${where};\``                                                                                                                                          |
| src/components/SqlEditor/ResultTable.tsx:185        | DML 生成                          | connType, qid                                                             | `return \`UPDATE ${tref} SET ${qid(connType, columns[change.col])}=${sqlLiteral(change.newVal)} WHERE ${where};\``                                                                        |

## 前端 DB 命令清单

- `db_backup_integrity`
- `db_begin_tx`
- `db_cancel_export`
- `db_cancel_query`
- `db_change_password`
- `db_commit_tx`
- `db_copy_table`
- `db_create_database`
- `db_create_user`
- `db_data_dictionary`
- `db_dba_health`
- `db_dba_kill_session`
- `db_dba_query`
- `db_delete_rows`
- `db_diff_data`
- `db_diff_structure`
- `db_drop_database`
- `db_drop_routine`
- `db_drop_table`
- `db_drop_user`
- `db_er_data`
- `db_exec_sql_file`
- `db_explain`
- `db_export_table`
- `db_fulltext_search`
- `db_health_check`
- `db_import_csv`
- `db_insert_rows`
- `db_instance_info`
- `db_instance_metrics`
- `db_kill_process`
- `db_list_partitions`
- `db_list_sequences`
- `db_list_users`
- `db_logical_backup`
- `db_migrate_table`
- `db_process_list`
- `db_rename_table`
- `db_replication_status`
- `db_rollback_tx`
- `db_set_auto_increment`
- `db_set_user_lock`
- `db_show_variables`
- `db_slow_queries`
- `db_stream_export`
- `db_table_sizes`
- `db_terminate_process`
- `db_truncate_table`
- `db_tx_status`
- `db_verify_migration`
- `duckdb_attach`
- `duckdb_checkpoint`
- `duckdb_conn_info`
- `duckdb_copy_to`
- `duckdb_create_s3_secret`
- `duckdb_db_diff`
- `duckdb_detach`
- `duckdb_drop_secret`
- `duckdb_export_database`
- `duckdb_export_masked`
- `duckdb_file_backup`
- `duckdb_health_check`
- `duckdb_import_database`
- `duckdb_install_ext`
- `duckdb_list_columns`
- `duckdb_list_databases`
- `duckdb_list_schemas`
- `duckdb_list_secrets`
- `duckdb_list_tables`
- `duckdb_load_ext`
- `duckdb_profile_query`
- `duckdb_query`
- `duckdb_set_ext_repo`
- `duckdb_set_pragma`
- `duckdb_summarize`
- `duckdb_vacuum`
- `execute_query`
- `get_routine_ddl`
- `get_table_ddl`
- `list_routines`
- `list_schemas`
- `list_ss_db_schemas`
- `list_ss_schema_tables`
- `list_tables`
- `list_tables_meta`
- `mariadb_galera_status`
- `mariadb_list_sequences`
- `mariadb_maxscale_detect`
- `mariadb_table_extra_info`
- `mongo_aggregate`
- `mongo_aggregate_explain`
- `mongo_balancer_window_get`
- `mongo_balancer_window_set`
- `mongo_build_info`
- `mongo_coll_stats`
- `mongo_config_risks`
- `mongo_copy_collection`
- `mongo_count_preview`
- `mongo_create_collection`
- `mongo_create_index`
- `mongo_create_user`
- `mongo_current_op`
- `mongo_db_storage`
- `mongo_delete_many`
- `mongo_delete_one`
- `mongo_drop_collection`
- `mongo_drop_index`
- `mongo_drop_user`
- `mongo_export_collection`
- `mongo_export_collection_masked`
- `mongo_find_docs`
- `mongo_get_profile_status`
- `mongo_gridfs_delete`
- `mongo_gridfs_download`
- `mongo_gridfs_list`
- `mongo_gridfs_upload`
- `mongo_import_collection`
- `mongo_index_advisor`
- `mongo_inspect`
- `mongo_kill_op`
- `mongo_list_collections`
- `mongo_list_databases`
- `mongo_list_indexes`
- `mongo_logical_backup`
- `mongo_oplog_info`
- `mongo_recovery_guide`
- `mongo_repl_set_status`
- `mongo_replace_one`
- `mongo_roles_info`
- `mongo_run_command`
- `mongo_sample_fields`
- `mongo_schema_analyze`
- `mongo_server_status`
- `mongo_set_profile_level`
- `mongo_shard_key_info`
- `mongo_shard_status`
- `mongo_slow_queries`
- `mongo_tx_abort`
- `mongo_tx_begin`
- `mongo_tx_commit`
- `mongo_tx_exec`
- `mongo_update_many`
- `mongo_update_user_password`
- `mongo_users_info`
- `mongo_watch_start`
- `mongo_watch_stop`
- `pg_settings_diff`
- `pg_vector_info`
- `redis_acl_cat`
- `redis_acl_deluser`
- `redis_acl_list`
- `redis_acl_setuser`
- `redis_acl_whoami`
- `redis_batch_del`
- `redis_batch_expire`
- `redis_batch_preview`
- `redis_bgrewriteaof`
- `redis_bgsave`
- `redis_bigkey_scan`
- `redis_cli_exec`
- `redis_client_kill`
- `redis_client_list`
- `redis_coldkey_scan`
- `redis_config_compare`
- `redis_config_get`
- `redis_config_risks`
- `redis_config_set`
- `redis_create_key`
- `redis_cross_copy`
- `redis_db_info`
- `redis_del`
- `redis_delete_large`
- `redis_expire`
- `redis_export_keys`
- `redis_get`
- `redis_hash_del`
- `redis_hash_scan`
- `redis_hash_set`
- `redis_hotkey_scan`
- `redis_import_keys`
- `redis_info_stats`
- `redis_inspect_report`
- `redis_key_detail`
- `redis_latency_doctor`
- `redis_latency_latest`
- `redis_list_push`
- `redis_list_range`
- `redis_list_remove`
- `redis_list_set`
- `redis_memory_analysis`
- `redis_publish`
- `redis_pubsub_channels`
- `redis_rename_key`
- `redis_replication_info`
- `redis_scan`
- `redis_scan_pattern`
- `redis_scan_with_ttl`
- `redis_server_caps`
- `redis_set`
- `redis_set_add`
- `redis_set_readonly`
- `redis_set_remove`
- `redis_set_scan`
- `redis_slowlog_get`
- `redis_slowlog_history`
- `redis_slowlog_history_clear`
- `redis_slowlog_reset`
- `redis_slowlog_snapshot`
- `redis_stream_add`
- `redis_stream_groups`
- `redis_stream_range`
- `redis_subscribe`
- `redis_zset_add`
- `redis_zset_range`
- `redis_zset_remove`
- `sqlite_alter_table_execute`
- `sqlite_alter_table_preview`
- `sqlite_analyze`
- `sqlite_attach`
- `sqlite_backup`
- `sqlite_backup_list`
- `sqlite_conn_info`
- `sqlite_data_dictionary`
- `sqlite_db_diff`
- `sqlite_detach`
- `sqlite_dump_sql`
- `sqlite_health_report`
- `sqlite_index_advisor`
- `sqlite_integrity_check`
- `sqlite_list_attached`
- `sqlite_list_objects`
- `sqlite_lock_diagnosis`
- `sqlite_optimize`
- `sqlite_pragma_list`
- `sqlite_rescue`
- `sqlite_restore_backup`
- `sqlite_set_journal_mode`
- `sqlite_set_pragma`
- `sqlite_space_stats`
- `sqlite_table_flags`
- `sqlite_vacuum`
- `sqlite_wal_checkpoint`
- `sqlite_wal_status`
- `table_columns`
- `tidb_ticdc_changefeeds`
- `update_cell`
- `write_local_bytes`
- `write_local_file`

## 后端已注册但本次前端扫描未发现直接调用

可能由动态调用、非扫描目录、后台流程或未来入口使用；不直接判定为问题。

- `db_call_procedure`
- `db_cleanup_stale_tx`
- `db_drop_partition`
- `db_exec_in_tx`
- `db_export_schema`
- `db_grant_privilege`
- `db_incremental_migrate`
- `db_revoke_privilege`
- `db_truncate_partition`
- `duckdb_disconnect`
- `duckdb_fts_list`
- `duckdb_pragmas`
- `mariadb_binlog_events`
- `mariadb_binlog_files`
- `mariadb_rocksdb_stats`
- `mongo_count_docs`
- `mongo_disconnect`
- `mongo_get_doc`
- `mongo_grant_roles_to_user`
- `mongo_insert_one`
- `mongo_revoke_roles_from_user`
- `mongo_test`
- `mongo_tx_cleanup`
- `mongo_tx_list`
- `pg_explain_json`
- `pg_index_advisor`
- `pg_pgbouncer_detect`
- `redis_check_busy`
- `redis_copy_key`
- `redis_disconnect`
- `redis_function_kill`
- `redis_is_readonly`
- `redis_keyspace_notify_get`
- `redis_keyspace_notify_set`
- `redis_memory_purge`
- `redis_module_list`
- `redis_pubsub_numsub`
- `redis_script_kill`
- `schema_columns`
- `sqlite_explain_bytecode`
- `sqlite_file_health`
- `sqlite_sequence_list`
- `sqlite_sequence_reset`
- `sqlite_watch_start`
- `sqlite_watch_stop`
- `ss_ag_status`
- `ss_agent_jobs`
- `ss_azure_metrics`
- `ss_backup_history`
- `ss_broker_queues`
- `ss_cdc_status`
- `ss_configurations`
- `ss_db_sizes`
- `ss_disconnect`
- `ss_explain`
- `ss_external_data_sources`
- `ss_force_plan`
- `ss_health_check`
- `ss_index_frag`
- `ss_instance_metrics`
- `ss_kill_spid`
- `ss_linked_servers`
- `ss_list_db_users`
- `ss_list_logins`
- `ss_lock_info`
- `ss_missing_index_scripts`
- `ss_missing_indexes`
- `ss_partition_info`
- `ss_query_store_plans`
- `ss_resource_pools`
- `ss_security_features`
- `ss_server_info`
- `ss_session_list`
- `ss_stale_stats`
- `ss_tempdb_info`
- `ss_test`
- `ss_top_sql`
- `ss_unforce_plan`
- `ss_unused_indexes`
- `ss_wait_stats`
- `ss_xe_sessions`

