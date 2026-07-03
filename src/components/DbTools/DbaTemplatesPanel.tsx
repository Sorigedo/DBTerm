import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, BookOpen, Search, Play, Copy } from 'lucide-react'

interface Props {
  connType: string
  onRun: (sql: string) => void
  onClose: () => void
}

interface Template {
  id: string
  category: string
  name: string
  desc: string
  sql: string
  db: 'mysql' | 'pg' | 'both' | 'mariadb' | 'kingbase' | 'opengauss' | 'tidb' | 'oceanbase' | 'clickhouse' | 'oracle' | 'sqlserver' | 'duckdb' | 'sqlite'
}

const TEMPLATES: Template[] = [
  // 预编译语句 / 参数化写法
  {
    id: 'mysql-prepared-stmt', category: '预编译语句', name: '用户级 PREPARE / EXECUTE', db: 'mysql',
    desc: 'MySQL / MariaDB / TiDB / OceanBase 的服务端预编译语句写法；整段需在同一会话中执行',
    sql: `PREPARE stmt FROM 'SELECT 1 LIMIT 1';
EXECUTE stmt;
DEALLOCATE PREPARE stmt;`,
  },
  {
    id: 'pg-prepared-stmt', category: '预编译语句', name: 'PREPARE / EXECUTE', db: 'pg',
    desc: 'PostgreSQL 系服务端预编译语句，参数用 $1、$2 并声明类型',
    sql: `PREPARE stmt(integer) AS
SELECT $1 AS value;

EXECUTE stmt(1);
DEALLOCATE stmt;`,
  },
  {
    id: 'ss-prepared-stmt', category: '预编译语句', name: 'sp_executesql 参数化执行', db: 'sqlserver',
    desc: 'SQL Server 常用参数化动态 SQL 写法；T-SQL 不使用 MySQL 的 PREPARE 语法',
    sql: `DECLARE @sql nvarchar(max) = N'SELECT @value AS value';

EXEC sp_executesql
  @sql,
  N'@value int',
  @value = 1;`,
  },
  {
    id: 'ora-prepared-stmt', category: '预编译语句', name: '动态 SQL 占位绑定', db: 'oracle',
    desc: 'Oracle 在 PL/SQL 中用 EXECUTE IMMEDIATE 和绑定变量表达动态参数化执行',
    sql: `DECLARE
  v_value NUMBER;
BEGIN
  EXECUTE IMMEDIATE 'SELECT :value FROM dual'
    INTO v_value
    USING 1;
END;`,
  },
  {
    id: 'sqlite-prepared-stmt', category: '预编译语句', name: 'SQLite 参数占位说明', db: 'sqlite',
    desc: 'SQLite 预编译由客户端 API 完成；SQL 编辑器里直接执行普通 SQL',
    sql: `-- SQLite 的 prepared statement 是驱动/API 层能力，不是 SQL 脚本命令。
-- 在 SQL 编辑器中直接执行：
SELECT 1 AS value;`,
  },
  {
    id: 'duck-prepared-stmt', category: '预编译语句', name: 'DuckDB 参数占位说明', db: 'duckdb',
    desc: 'DuckDB 常见预编译由客户端 API 完成；SQL 编辑器里直接执行普通 SQL',
    sql: `-- DuckDB 的参数化执行通常由驱动/API 绑定参数完成。
-- 在 SQL 编辑器中直接执行：
SELECT 1 AS value;`,
  },
  {
    id: 'ch-prepared-stmt', category: '预编译语句', name: 'ClickHouse 参数化说明', db: 'clickhouse',
    desc: 'ClickHouse 常用 HTTP/native 参数绑定或客户端格式化；SQL 脚本不使用 MySQL PREPARE',
    sql: `-- ClickHouse 不使用 MySQL 风格 PREPARE / EXECUTE 脚本。
-- 在 SQL 编辑器中直接执行：
SELECT 1 AS value;`,
  },
  // 锁与等待
  {
    id: 'lock-waiting', category: '锁 / 阻塞', name: '查看锁等待', db: 'mysql',
    desc: '显示当前锁等待链：阻塞进程和被阻塞进程',
    sql: `SELECT
  r.trx_id AS waiting_trx_id,
  r.trx_mysql_thread_id AS waiting_thread,
  r.trx_query AS waiting_query,
  b.trx_id AS blocking_trx_id,
  b.trx_mysql_thread_id AS blocking_thread,
  b.trx_query AS blocking_query
FROM information_schema.INNODB_LOCK_WAITS w
JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id
JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id;`,
  },
  {
    id: 'pg-lock-waiting', category: '锁 / 阻塞', name: '查看锁等待 (PG)', db: 'pg',
    desc: '显示 PostgreSQL 当前阻塞链',
    sql: `SELECT
  blocked.pid AS blocked_pid,
  blocked_activity.query AS blocked_query,
  blocking.pid AS blocking_pid,
  blocking_activity.query AS blocking_query,
  now() - blocked_activity.query_start AS blocked_duration
FROM pg_catalog.pg_locks blocked
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked.pid
JOIN pg_catalog.pg_locks blocking ON blocking.locktype = blocked.locktype
  AND blocking.relation IS NOT DISTINCT FROM blocked.relation
  AND blocking.page IS NOT DISTINCT FROM blocked.page
  AND blocking.tuple IS NOT DISTINCT FROM blocked.tuple
  AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid
  AND blocking.classid IS NOT DISTINCT FROM blocked.classid
  AND blocking.objid IS NOT DISTINCT FROM blocked.objid
  AND blocking.objsubid IS NOT DISTINCT FROM blocked.objsubid
  AND blocking.pid != blocked.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
WHERE NOT blocked.granted;`,
  },
  // 未提交事务
  {
    id: 'long-tx', category: '锁 / 阻塞', name: '长事务（>60s）', db: 'mysql',
    desc: '找出持续超过 60 秒的未提交事务',
    sql: `SELECT trx_id, trx_started, trx_query, trx_mysql_thread_id,
  TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_secs
FROM information_schema.INNODB_TRX
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 60
ORDER BY duration_secs DESC;`,
  },
  {
    id: 'pg-long-tx', category: '锁 / 阻塞', name: '长事务（>60s）(PG)', db: 'pg',
    desc: '找出 PG 中超过 60 秒的活跃事务',
    sql: `SELECT pid, usename, application_name, state, query,
  now() - xact_start AS duration
FROM pg_stat_activity
WHERE state != 'idle'
  AND xact_start IS NOT NULL
  AND now() - xact_start > interval '60 seconds'
ORDER BY duration DESC;`,
  },
  // 容量
  {
    id: 'table-size', category: '容量', name: '表大小排行 TOP20', db: 'mysql',
    desc: '按总大小降序列出 TOP20 表',
    sql: `SELECT TABLE_SCHEMA, TABLE_NAME,
  TABLE_ROWS AS row_count_estimate,
  ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_mb,
  ROUND(INDEX_LENGTH / 1024 / 1024, 2) AS index_mb,
  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS total_mb
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
LIMIT 20;`,
  },
  {
    id: 'db-size', category: '容量', name: '各库大小', db: 'mysql',
    desc: '列出所有数据库的总占用空间',
    sql: `SELECT TABLE_SCHEMA AS db_name,
  COUNT(*) AS table_count,
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS total_mb
FROM information_schema.TABLES
GROUP BY TABLE_SCHEMA
ORDER BY total_mb DESC;`,
  },
  // 连接数
  {
    id: 'conn-stats', category: '连接', name: '连接数统计', db: 'mysql',
    desc: '按用户/主机统计活跃连接数',
    sql: `SELECT USER, HOST, COUNT(*) AS conn_count, SUM(COMMAND='Sleep') AS idle
FROM information_schema.PROCESSLIST
GROUP BY USER, HOST
ORDER BY conn_count DESC;`,
  },
  {
    id: 'max-conn', category: '连接', name: '连接数 vs 上限', db: 'mysql',
    desc: '查看当前连接数和 max_connections 上限',
    sql: `SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW GLOBAL VARIABLES LIKE 'max_connections';`,
  },
  // 索引
  {
    id: 'no-pk', category: '索引 / 结构', name: '无主键的表', db: 'mysql',
    desc: '找出没有主键的业务表（隐患较大）',
    sql: `SELECT t.TABLE_SCHEMA, t.TABLE_NAME
FROM information_schema.TABLES t
LEFT JOIN information_schema.TABLE_CONSTRAINTS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
  AND c.TABLE_NAME = t.TABLE_NAME
  AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
WHERE t.TABLE_TYPE = 'BASE TABLE'
  AND c.CONSTRAINT_NAME IS NULL
ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;`,
  },
  {
    id: 'dup-index', category: '索引 / 结构', name: '重复 / 冗余索引', db: 'mysql',
    desc: '找出可能重复的索引（前缀相同）',
    sql: `SELECT s1.TABLE_SCHEMA, s1.TABLE_NAME,
  s1.INDEX_NAME AS index1, s2.INDEX_NAME AS index2,
  s1.COLUMN_NAME AS col1, s2.COLUMN_NAME AS col2
FROM information_schema.STATISTICS s1
JOIN information_schema.STATISTICS s2
  ON s1.TABLE_SCHEMA = s2.TABLE_SCHEMA
  AND s1.TABLE_NAME   = s2.TABLE_NAME
  AND s1.SEQ_IN_INDEX = s2.SEQ_IN_INDEX
  AND s1.COLUMN_NAME  = s2.COLUMN_NAME
  AND s1.INDEX_NAME  <> s2.INDEX_NAME
WHERE s1.SEQ_IN_INDEX = 1
ORDER BY s1.TABLE_SCHEMA, s1.TABLE_NAME;`,
  },
  // 表碎片
  {
    id: 'fragmentation', category: '维护', name: '表碎片率 TOP20', db: 'mysql',
    desc: 'DATA_FREE > 0 且碎片率高的表，可以 OPTIMIZE',
    sql: `SELECT TABLE_SCHEMA, TABLE_NAME,
  ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_mb,
  ROUND(DATA_FREE  / 1024 / 1024, 2) AS free_mb,
  ROUND(DATA_FREE / (DATA_LENGTH + DATA_FREE + 1) * 100, 1) AS frag_pct
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE' AND DATA_FREE > 0
ORDER BY DATA_FREE DESC
LIMIT 20;`,
  },
  // 主从
  {
    id: 'slave-status', category: '主从', name: '主从延迟', db: 'mysql',
    desc: 'SHOW SLAVE STATUS，检查 Seconds_Behind_Master',
    sql: `SHOW SLAVE STATUS\\G`,
  },
  // PG 统计
  {
    id: 'pg-slow', category: '性能', name: 'PG 慢查询 TOP10', db: 'pg',
    desc: '需要开启 pg_stat_statements 扩展',
    sql: `SELECT query, calls, total_exec_time::int8 AS total_ms,
  (total_exec_time / calls)::int8 AS avg_ms,
  rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;`,
  },
  {
    id: 'pg-bloat', category: '维护', name: 'PG 膨胀估算 TOP10', db: 'pg',
    desc: '估算表的死行比例，高膨胀需要 VACUUM',
    sql: `SELECT relname AS table_name,
  n_live_tup, n_dead_tup,
  CASE WHEN n_live_tup + n_dead_tup > 0
    THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1) ELSE 0 END AS dead_pct,
  last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY dead_pct DESC
LIMIT 10;`,
  },
  {
    id: 'pg-repl-slots', category: 'PG 复制', name: '复制槽 WAL 堆积风险', db: 'pg',
    desc: '非活跃复制槽会持续堆积 WAL 文件，极易撑爆磁盘，需立即处理',
    sql: `SELECT slot_name, slot_type, database, active,
  restart_lsn,
  pg_size_pretty(pg_current_wal_lsn() - restart_lsn) AS wal_lag,
  CASE WHEN NOT active THEN '⚠️ 非活跃！' ELSE '✓ 正常' END AS health
FROM pg_replication_slots
ORDER BY active, restart_lsn;`,
  },
  {
    id: 'pg-xid-age', category: 'PG 事务', name: 'XID 回卷风险监控', db: 'pg',
    desc: '事务年龄超过 15 亿时需立即 VACUUM FREEZE，否则数据库将停摆',
    sql: `SELECT datname,
  age(datfrozenxid) AS xid_age,
  ROUND(age(datfrozenxid) * 100.0 / 2000000000, 1) AS pct_of_max,
  CASE WHEN age(datfrozenxid) > 1500000000 THEN '🔴 紧急 VACUUM FREEZE!'
       WHEN age(datfrozenxid) > 1000000000 THEN '🟠 警告'
       ELSE '🟢 正常' END AS status
FROM pg_database
WHERE datallowconn
ORDER BY age(datfrozenxid) DESC;`,
  },
  {
    id: 'pg-idle-in-tx', category: 'PG 事务', name: 'idle in transaction 会话', db: 'pg',
    desc: 'idle in transaction 会话持有锁并阻碍 VACUUM，需及时清理',
    sql: `SELECT pid, usename, application_name, client_addr,
  state, wait_event_type, wait_event,
  now() - xact_start AS tx_duration,
  LEFT(query, 100) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND pid <> pg_backend_pid()
ORDER BY xact_start;`,
  },
  {
    id: 'pg-unused-idx', category: 'PG 索引', name: '未使用索引（idx_scan=0）', db: 'pg',
    desc: '自上次统计重置以来从未被用到的索引，写开销白白浪费，可评估删除',
    sql: `SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = indexrelid
      AND (i.indisprimary OR i.indisunique)
  )
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;`,
  },
  {
    id: 'pg-cache-hit', category: 'PG 性能', name: '缓冲区缓存命中率', db: 'pg',
    desc: '命中率低于 99% 需增加 shared_buffers（建议 25% 物理内存）',
    sql: `SELECT datname,
  blks_hit, blks_read,
  ROUND(blks_hit * 100.0 / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
  deadlocks, conflicts, temp_files,
  pg_size_pretty(temp_bytes) AS temp_size
FROM pg_stat_database
WHERE datname = current_database();`,
  },
  {
    id: 'pg-checkpoint', category: 'PG 性能', name: 'Checkpoint 频率与缓冲区写', db: 'pg',
    desc: 'checkpoints_req 多意味着 checkpoint_segments/max_wal_size 太小，需调大',
    sql: `SELECT checkpoints_timed, checkpoints_req,
  checkpoint_write_time::int8 AS write_ms,
  checkpoint_sync_time::int8 AS sync_ms,
  buffers_checkpoint, buffers_clean, buffers_backend,
  buffers_alloc,
  ROUND(buffers_backend * 100.0 / NULLIF(buffers_checkpoint + buffers_clean + buffers_backend, 0), 1) AS backend_write_pct
FROM pg_stat_bgwriter;`,
  },
  {
    id: 'pg-temp-files', category: 'PG 性能', name: '临时文件 Top（work_mem 外溢）', db: 'pg',
    desc: '频繁产生大量临时文件说明 work_mem 不足，排序/Hash Join 溢写到磁盘',
    sql: `SELECT datname,
  temp_files,
  pg_size_pretty(temp_bytes) AS temp_size,
  deadlocks
FROM pg_stat_database
ORDER BY temp_bytes DESC
LIMIT 10;`,
  },
  {
    id: 'pg-autovacuum-lag', category: 'PG 维护', name: 'Autovacuum 滞后表排行', db: 'pg',
    desc: '死行比例高但长时间未 autovacuum 的表，膨胀风险极高',
    sql: `SELECT relname,
  n_live_tup, n_dead_tup,
  ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
  last_autovacuum,
  last_autoanalyze,
  EXTRACT(EPOCH FROM (now() - last_autovacuum))::int8 / 3600 AS hours_since_vacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC
LIMIT 20;`,
  },
  {
    id: 'pg-conn-status', category: 'PG 连接', name: '连接数现状 vs 上限', db: 'pg',
    desc: '按状态分组显示连接数，并与 max_connections 上限对比',
    sql: `SELECT state, COUNT(*) AS cnt
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
GROUP BY state
UNION ALL
SELECT 'max_connections' AS state,
  current_setting('max_connections')::int AS cnt
ORDER BY cnt DESC;`,
  },
  {
    id: 'pg-index-bloat', category: 'PG 索引', name: '索引膨胀估算 TOP10', db: 'pg',
    desc: '通过页填充估算索引膨胀比，高膨胀建议 REINDEX CONCURRENTLY',
    sql: `SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan,
  ROUND(100 * (1 - idx_tup_read::float8 / NULLIF(idx_tup_fetch, 0)), 1) AS est_bloat_hint
FROM pg_stat_user_indexes
WHERE pg_relation_size(indexrelid) > 1024 * 1024
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 10;`,
  },

  // MariaDB 专属模板
  {
    id: 'maria-galera-health', category: 'MariaDB Galera', name: 'Galera 集群健康', db: 'mariadb',
    desc: '一览 Galera 集群大小、状态、本地状态及流控情况',
    sql: `SHOW GLOBAL STATUS WHERE Variable_name IN (
  'wsrep_cluster_size',
  'wsrep_cluster_status',
  'wsrep_local_state_comment',
  'wsrep_ready',
  'wsrep_connected',
  'wsrep_flow_control_paused',
  'wsrep_local_recv_queue',
  'wsrep_local_send_queue',
  'wsrep_local_bf_aborts',
  'wsrep_cert_failures',
  'wsrep_last_committed'
);`,
  },
  {
    id: 'maria-flow-control', category: 'MariaDB Galera', name: 'wsrep 流控详情', db: 'mariadb',
    desc: '流控暂停比例 > 10% 说明有慢节点，需立即排查',
    sql: `SELECT Variable_name, Variable_value
FROM information_schema.GLOBAL_STATUS
WHERE Variable_name IN (
  'wsrep_flow_control_paused',
  'wsrep_flow_control_sent',
  'wsrep_flow_control_recv',
  'wsrep_local_recv_queue_avg',
  'wsrep_local_send_queue_avg',
  'wsrep_apply_ooorder_frac'
)
ORDER BY Variable_name;`,
  },
  {
    id: 'maria-threadpool', category: 'MariaDB 线程池', name: '线程池饱和度', db: 'mariadb',
    desc: '查看线程池大小、活跃线程、排队请求；排队 > 0 说明吃紧',
    sql: `SHOW GLOBAL STATUS WHERE Variable_name IN (
  'Threadpool_threads',
  'Threadpool_active_threads',
  'Threadpool_idle_threads',
  'Threadpool_queued'
);
SHOW GLOBAL VARIABLES LIKE 'thread_pool_size';`,
  },
  {
    id: 'maria-sysver-bloat', category: 'MariaDB 时态表', name: '系统版本化表历史膨胀', db: 'mariadb',
    desc: '找出含历史版本记录的系统版本化表，评估膨胀情况',
    sql: `SELECT
  TABLE_SCHEMA,
  TABLE_NAME,
  TABLE_ROWS AS estimated_rows,
  ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_mb,
  ROUND(DATA_FREE  / 1024 / 1024, 2) AS free_mb,
  CREATE_OPTIONS
FROM information_schema.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
  AND CREATE_OPTIONS LIKE '%with_system_versioning%'
ORDER BY DATA_LENGTH DESC;`,
  },
  {
    id: 'maria-multisource-lag', category: 'MariaDB 复制', name: '多源复制各通道延迟', db: 'mariadb',
    desc: 'SHOW ALL SLAVES STATUS 查看各 CONNECTION_NAME 通道的延迟与错误',
    sql: `SHOW ALL SLAVES STATUS;`,
  },
  {
    id: 'maria-gtid', category: 'MariaDB 复制', name: 'MariaDB GTID 位点', db: 'mariadb',
    desc: '查看 MariaDB 三个 GTID 变量（与 MySQL GTID 格式不同）',
    sql: `SELECT Variable_name, Variable_value
FROM information_schema.GLOBAL_VARIABLES
WHERE Variable_name IN (
  'gtid_slave_pos',
  'gtid_binlog_pos',
  'gtid_current_pos'
);`,
  },
  {
    id: 'maria-sequences', category: 'MariaDB 专属', name: '序列列表', db: 'mariadb',
    desc: '列出当前库的所有 MariaDB 原生序列（10.3+）',
    sql: `SELECT SEQUENCE_SCHEMA, SEQUENCE_NAME,
  START_VALUE, MINIMUM_VALUE, MAXIMUM_VALUE,
  INCREMENT, CYCLE_OPTION
FROM information_schema.SEQUENCES
ORDER BY SEQUENCE_SCHEMA, SEQUENCE_NAME;`,
  },
  {
    id: 'maria-meta-locks', category: 'MariaDB 专属', name: '元数据锁（MDL）', db: 'mariadb',
    desc: '需先安装 metadata_lock_info 插件，查看当前 MDL 持有情况',
    sql: `SELECT THREAD_ID, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME,
  LOCK_TYPE, LOCK_DURATION
FROM information_schema.METADATA_LOCK_INFO
ORDER BY LOCK_TYPE DESC;`,
  },
  {
    id: 'maria-optimizer', category: 'MariaDB 专属', name: 'optimizer_switch 当前值', db: 'mariadb',
    desc: '查看所有优化器开关的当前状态（会话级）',
    sql: `SELECT @@optimizer_switch;`,
  },
  {
    id: 'maria-server-audit', category: 'MariaDB 专属', name: 'server_audit 插件状态', db: 'mariadb',
    desc: '查看服务端审计插件的启用状态与日志路径',
    sql: `SHOW GLOBAL VARIABLES LIKE 'server_audit%';`,
  },
  // -------- 金仓 KingBase 专属 --------
  {
    id: 'kb-version', category: '金仓 KingBase', name: 'KES 版本与兼容模式', db: 'kingbase',
    desc: '查看 KingbaseES 版本字符串及 Oracle 兼容模式状态',
    sql: `SELECT version();
SHOW enable_oracle_compatible_syntax;`,
  },
  {
    id: 'kb-sys-stat-activity', category: '金仓 KingBase', name: 'sys_stat_activity 当前会话', db: 'kingbase',
    desc: '查询金仓自有会话视图（降级至 pg_stat_activity）',
    sql: `SELECT pid, usename, application_name, state,
  wait_event_type, wait_event,
  now() - query_start AS duration,
  left(query, 100) AS query_preview
FROM sys_stat_activity
WHERE state IS NOT NULL
ORDER BY query_start DESC NULLS LAST
LIMIT 50;`,
  },
  {
    id: 'kb-sys-stat-database', category: '金仓 KingBase', name: 'sys_stat_database 库统计', db: 'kingbase',
    desc: '查询金仓数据库级别统计（事务、缓存命中、死锁等）',
    sql: `SELECT datname,
  numbackends,
  xact_commit,
  xact_rollback,
  round(blks_hit::numeric * 100 / NULLIF(blks_read + blks_hit, 0), 2) AS cache_hit_pct,
  deadlocks,
  temp_files,
  temp_bytes
FROM sys_stat_database
WHERE datname NOT IN ('template0','template1')
ORDER BY xact_commit DESC;`,
  },
  {
    id: 'kb-audit-status', category: '金仓 KingBase', name: '审计（pgaudit）配置状态', db: 'kingbase',
    desc: '检查 pgaudit 是否已加载、记录范围及关键 GUC 参数',
    sql: `SELECT name, setting, short_desc
FROM pg_settings
WHERE name LIKE 'pgaudit%'
   OR name = 'shared_preload_libraries'
ORDER BY name;`,
  },
  {
    id: 'kb-three-tier-roles', category: '金仓 KingBase', name: '三权分立角色检查', db: 'kingbase',
    desc: '检查数据库管理员/安全管理员/审计管理员（三权分立）角色是否已配置',
    sql: `SELECT rolname,
  rolsuper       AS is_superuser,
  rolcreaterole  AS can_create_role,
  rolcreatedb    AS can_create_db,
  rolcanlogin    AS can_login
FROM pg_roles
WHERE rolname IN ('dba','sso','sao','security_admin','audit_admin','db_admin')
   OR rolsuper = true
ORDER BY rolname;`,
  },
  {
    id: 'kb-compat-objects', category: '金仓 KingBase', name: 'Oracle 兼容对象（包/同义词）', db: 'kingbase',
    desc: '查询 Oracle 兼容模式下的包（package）和同义词（synonym）数量',
    sql: `-- 包（Oracle 兼容模式特有）
SELECT 'package' AS object_type, COUNT(*) AS cnt
FROM information_schema.routines
WHERE routine_type = 'PACKAGE'
UNION ALL
-- 同义词
SELECT 'synonym', COUNT(*) FROM pg_catalog.pg_class
WHERE relkind = 'S'  -- 金仓同义词 relkind
UNION ALL
-- 标准过程/函数
SELECT routine_type, COUNT(*) FROM information_schema.routines
WHERE routine_schema NOT IN ('pg_catalog','information_schema','sys')
GROUP BY routine_type;`,
  },
  {
    id: 'kb-sys-size', category: '金仓 KingBase', name: '数据库/表空间大小（sys 函数）', db: 'kingbase',
    desc: '使用金仓 sys_database_size / sys_tablespace_size 查询大小',
    sql: `-- 当前数据库大小（sys 函数，降级至 pg 函数）
SELECT sys_size_pretty(sys_database_size(current_database())) AS db_size;

-- 各表空间大小
SELECT spcname AS tablespace,
  sys_size_pretty(sys_tablespace_size(spcname)) AS size
FROM pg_tablespace
ORDER BY sys_tablespace_size(spcname) DESC;`,
  },
  // -------- openGauss 专属 --------
  {
    id: 'og-topsql', category: 'openGauss 专属', name: 'dbe_perf TopSQL（耗时最长）', db: 'opengauss',
    desc: '从 dbe_perf.statement 查询累计耗时最长的 SQL（需 enable_stmt_track = on）',
    sql: `SELECT
    unique_sql_id::text AS sql_id,
    n_calls AS calls,
    n_tuples_returned AS rows,
    round(total_elapse_time / 1000) || 'ms' AS total_elapsed,
    CASE WHEN n_calls > 0
      THEN round(total_elapse_time / n_calls / 1000) || 'ms'
      ELSE '0ms' END AS avg_elapsed,
    left(query, 200) AS sql_text,
    user_name
  FROM dbe_perf.statement
  ORDER BY total_elapse_time DESC
  LIMIT 20;`,
  },
  {
    id: 'og-wait-events', category: 'openGauss 专属', name: 'dbe_perf 等待事件分布', db: 'opengauss',
    desc: '查询当前所有线程的等待事件分布（用于诊断等待瓶颈）',
    sql: `SELECT
    wait_status,
    count(*) AS wait_count,
    node_name
  FROM dbe_perf.wait_events
  GROUP BY wait_status, node_name
  ORDER BY wait_count DESC;`,
  },
  {
    id: 'og-memory', category: 'openGauss 专属', name: 'dbe_perf 内存上下文', db: 'opengauss',
    desc: '查询各内存上下文的使用情况（top 20）',
    sql: `SELECT
    context_name,
    pg_size_pretty(total_size) AS total_size,
    pg_size_pretty(free_size)  AS free_size,
    round((total_size - free_size)::numeric * 100 / NULLIF(total_size, 0), 1)::text || '%' AS used_pct
  FROM dbe_perf.memory_node_detail
  ORDER BY total_size DESC
  LIMIT 20;`,
  },
  {
    id: 'og-security-policy', category: 'openGauss 专属', name: '统一审计策略列表', db: 'opengauss',
    desc: '查看已配置的统一审计策略（gs_auditing_policy）',
    sql: `SELECT
    polname AS policy_name,
    CASE poltype WHEN 'a' THEN 'ACCESS' WHEN 'p' THEN 'PRIVILEGE' ELSE poltype::text END AS type,
    polenabled AS enabled,
    polcomments AS comments
  FROM gs_auditing_policy
  ORDER BY polname;`,
  },
  {
    id: 'og-masking-policy', category: 'openGauss 专属', name: '动态脱敏策略列表', db: 'opengauss',
    desc: '查看已配置的动态数据脱敏策略及脱敏列（gs_masking_policy）',
    sql: `-- 脱敏策略
SELECT polname, polenabled AS enabled, polcomments
FROM gs_masking_policy ORDER BY polname;

-- 脱敏列明细
SELECT
    p.polname AS policy,
    n.nspname || '.' || c.relname AS table_fqn,
    a.attname AS column_name,
    ma.actfunc AS mask_function
  FROM gs_masking_policy_actions ma
  JOIN gs_masking_policy p ON p.oid = ma.policyoid
  JOIN pg_attribute a ON a.attnum = ma.actcolumn
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  ORDER BY p.polname, table_fqn;`,
  },
  {
    id: 'og-column-store', category: 'openGauss 专属', name: '列存表识别与压缩统计', db: 'opengauss',
    desc: '查询数据库中所有列存表（ORIENTATION=column）及其大小',
    sql: `SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
    c.reltuples::bigint AS estimated_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
    AND EXISTS (
      SELECT 1 FROM pg_options_to_table(c.reloptions)
      WHERE option_name = 'orientation' AND option_value = 'column'
    )
  ORDER BY pg_total_relation_size(c.oid) DESC;`,
  },
  {
    id: 'og-three-tier', category: 'openGauss 专属', name: '三权分立角色检查', db: 'opengauss',
    desc: '检查 openGauss 三权分立（sysadmin/安全管理员/审计管理员）角色是否已配置',
    sql: `SELECT rolname,
    rolsuper      AS is_sysadmin,
    rolcreaterole AS can_create_role,
    rolcanlogin   AS can_login,
    rolreplication AS can_replicate
  FROM pg_roles
  WHERE rolname IN ('sysadmin','security_admin','audit_admin','opengauss')
     OR rolsuper = true
  ORDER BY rolname;`,
  },
  // -------- TiDB 专属 --------
  {
    id: 'tidb-cluster-info', category: 'TiDB 专属', name: '集群拓扑（CLUSTER_INFO）', db: 'tidb',
    desc: '查看所有 TiDB/TiKV/PD/TiFlash 节点的版本、状态与启动时间',
    sql: `SELECT TYPE, INSTANCE, STATUS_ADDRESS, VERSION, START_TIME, UPTIME
FROM INFORMATION_SCHEMA.CLUSTER_INFO
ORDER BY TYPE, INSTANCE;`,
  },
  {
    id: 'tidb-hotspot', category: 'TiDB 专属', name: '热点 Region 分析', db: 'tidb',
    desc: '查找读写热点 Region（单调递增主键是 TiDB 写热点头号原因）',
    sql: `SELECT TYPE, DB_NAME, TABLE_NAME, INDEX_NAME,
    REGION_ID, MAX_HOT_DEGREE, REGION_COUNT, FLOW_BYTES
FROM INFORMATION_SCHEMA.TIDB_HOT_REGIONS
ORDER BY MAX_HOT_DEGREE DESC
LIMIT 20;

-- 诊断建议：热点表如使用 AUTO_INCREMENT 主键，建议改为：
-- ALTER TABLE t MODIFY id BIGINT AUTO_RANDOM;
-- 或：CREATE TABLE t (...) SHARD_ROW_ID_BITS = 4;`,
  },
  {
    id: 'tidb-tikv-status', category: 'TiDB 专属', name: 'TiKV 存储均衡度', db: 'tidb',
    desc: '查看各 TiKV 节点的 Leader/Region 数量、容量与可用空间',
    sql: `SELECT STORE_ID, ADDRESS, STORE_STATE_NAME AS state,
    LEADER_COUNT, REGION_COUNT,
    CAPACITY, AVAILABLE
FROM INFORMATION_SCHEMA.TIKV_STORE_STATUS
ORDER BY LEADER_COUNT DESC;`,
  },
  {
    id: 'tidb-slow-query', category: 'TiDB 专属', name: '慢查询（SLOW_QUERY）', db: 'tidb',
    desc: '从 INFORMATION_SCHEMA.SLOW_QUERY 查询慢 SQL（TiDB 专有，不同于 mysql.slow_log）',
    sql: `SELECT Time, Query_time, Process_time, Wait_time,
    Mem_max, DB, User, left(Query, 120) AS sql_preview
FROM INFORMATION_SCHEMA.SLOW_QUERY
WHERE Query_time > 1
ORDER BY Query_time DESC
LIMIT 30;`,
  },
  {
    id: 'tidb-ddl-jobs', category: 'TiDB 专属', name: 'DDL Job 进度追踪', db: 'tidb',
    desc: '查看异步 DDL Job（大表加索引在后台执行）的状态与进度',
    sql: `ADMIN SHOW DDL JOBS 20;

-- 查看当前在途的 DDL Job:
-- ADMIN SHOW DDL;
-- 取消 DDL Job（谨慎操作）:
-- ADMIN CANCEL DDL JOBS <jobId>;`,
  },
  {
    id: 'tidb-gc-config', category: 'TiDB 专属', name: 'GC / MVCC 配置', db: 'tidb',
    desc: '查看 TiDB GC safe point 与 MVCC 版本保留时长，诊断 GC too late 问题',
    sql: `-- GC 配置变量
SHOW VARIABLES LIKE 'tidb_gc%';

-- GC Safe Point（MVCC 版本已回收到此时间）
SELECT variable_name, variable_value
FROM mysql.tidb
WHERE variable_name LIKE '%gc%';

-- 大事务 / 锁等待
SELECT * FROM INFORMATION_SCHEMA.DATA_LOCK_WAITS LIMIT 20;`,
  },
  {
    id: 'tidb-tiflash', category: 'TiDB 专属', name: 'TiFlash 列存副本状态', db: 'tidb',
    desc: '查看 TiFlash 同步进度；若表未加 TiFlash 副本则无数据',
    sql: `SELECT TABLE_SCHEMA, TABLE_NAME, REPLICA_COUNT, AVAILABLE, PROGRESS
FROM INFORMATION_SCHEMA.TIFLASH_REPLICA
ORDER BY AVAILABLE, PROGRESS;

-- 添加 TiFlash 副本（HTAP 列存，大表扫描走 TiFlash）：
-- ALTER TABLE t SET TIFLASH REPLICA 1;
-- 移除：ALTER TABLE t SET TIFLASH REPLICA 0;`,
  },
  {
    id: 'tidb-flashback', category: 'TiDB 专属', name: 'Flashback 误删恢复', db: 'tidb',
    desc: 'TiDB FLASHBACK 恢复误删的表或数据库（在 GC safepoint 之后执行）',
    sql: `-- 确认 GC safe point
SELECT variable_value AS gc_safe_point
FROM mysql.tidb
WHERE variable_name = 'tikv_gc_safe_point';

-- 恢复被 DROP 的表（GC 周期内可用）
FLASHBACK TABLE t1 TO t1_recovered;

-- 数据库级时间旅行（TiDB 6.4+，需 SUPER 权限）
-- FLASHBACK DATABASE db1 TO TIMESTAMP '2024-01-15 14:30:00';`,
  },
  // -------- OceanBase 专属 --------
  {
    id: 'ob-servers', category: 'OceanBase 专属', name: 'Zone/OBServer 拓扑', db: 'oceanbase',
    desc: '查看所有 OBServer 节点的 Zone/状态/资源配额（需 SYS 租户权限）',
    sql: `SELECT svr_ip, svr_port, zone, status,
    start_service_time, cpu_capacity_max, mem_capacity
FROM oceanbase.DBA_OB_SERVERS
ORDER BY zone, svr_ip;`,
  },
  {
    id: 'ob-tenants', category: 'OceanBase 专属', name: '租户与资源配额', db: 'oceanbase',
    desc: '查看所有租户的模式（MySQL/Oracle）、状态及资源单元配额',
    sql: `SELECT t.tenant_id, t.tenant_name, t.tenant_type, t.primary_zone, t.status,
    u.max_cpu, u.memory_size
FROM oceanbase.DBA_OB_TENANTS t
LEFT JOIN (
    SELECT tenant_id, SUM(max_cpu) AS max_cpu, SUM(memory_size) AS memory_size
    FROM oceanbase.DBA_OB_UNITS GROUP BY tenant_id
) u ON u.tenant_id = t.tenant_id
ORDER BY t.tenant_id;`,
  },
  {
    id: 'ob-compaction', category: 'OceanBase 专属', name: 'Major Compaction 合并状态', db: 'oceanbase',
    desc: '查看当前 Major Compaction（合并）状态，检查是否卡住或报错',
    sql: `SELECT frozen_scn, last_scn, is_error, is_suspended,
    start_time, finish_time, status
FROM oceanbase.DBA_OB_MAJOR_COMPACTION;

-- 手动触发合并（高危，需 SYS 租户超级用户权限）
-- ALTER SYSTEM MAJOR FREEZE;`,
  },
  {
    id: 'ob-sql-audit', category: 'OceanBase 专属', name: 'GV$OB_SQL_AUDIT TopSQL', db: 'oceanbase',
    desc: '从 GV$OB_SQL_AUDIT 分析近 30 分钟 TopSQL（OceanBase 强项：全量 SQL 执行明细）',
    sql: `SELECT SQL_ID,
    round(sum(ELAPSED_TIME)/1000) || 'ms' AS total_elapsed,
    COUNT(*) AS executions,
    round(avg(ELAPSED_TIME)/1000) || 'ms' AS avg_elapsed,
    USER_NAME, DB_NAME,
    left(QUERY_SQL, 120) AS sql_text
FROM oceanbase.GV$OB_SQL_AUDIT
WHERE REQUEST_TIME > UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 30 MINUTE)) * 1000000
GROUP BY SQL_ID, USER_NAME, DB_NAME, QUERY_SQL
ORDER BY sum(ELAPSED_TIME) DESC
LIMIT 20;`,
  },
  {
    id: 'ob-memstore', category: 'OceanBase 专属', name: 'MemStore 水位监控', db: 'oceanbase',
    desc: '查看各租户 MemStore 使用率（接近 100% 触发转储/阻写，是 OB 写入停止的经典原因）',
    sql: `SELECT svr_ip, svr_port, tenant_id,
    active_span, memstore_used, freeze_trigger, memstore_limit,
    round(memstore_used * 100.0 / NULLIF(memstore_limit, 0), 1) AS used_pct
FROM oceanbase.GV$OB_MEMSTORE
ORDER BY used_pct DESC;`,
  },
  {
    id: 'ob-flashback', category: 'OceanBase 专属', name: '闪回/回收站恢复', db: 'oceanbase',
    desc: '使用 OceanBase 闪回查询或回收站恢复误删对象',
    sql: `-- 查看回收站中的对象
SELECT object_name, original_name, type, createtime, droptime
FROM DBA_RECYCLEBIN
ORDER BY droptime DESC;

-- 从回收站恢复表（FLASHBACK TABLE）
-- FLASHBACK TABLE original_table_name TO BEFORE DROP;
-- FLASHBACK TABLE original_table_name TO BEFORE DROP RENAME TO new_name;

-- 闪回查询（查询历史时间点的数据）
-- SELECT * FROM t1 AS OF SNAPSHOT <scn_value>;
-- 获取时间点对应的 SCN：
-- SELECT TIMESTAMP_TO_SCN('2024-01-15 14:30:00');`,
  },

  // -------- Oracle 专属 --------
  {
    id: 'ora-lock-wait', category: 'Oracle 专属', name: '锁等待链', db: 'oracle',
    desc: '查看当前 Oracle 阻塞会话与被阻塞会话',
    sql: `SELECT
  s.sid AS blocked_sid, s.serial# AS blocked_serial,
  s.username AS blocked_user, s.sql_id AS blocked_sql,
  s.blocking_session AS blocking_sid,
  bs.username AS blocking_user, bs.sql_id AS blocking_sql,
  s.seconds_in_wait AS wait_secs
FROM v$session s
JOIN v$session bs ON bs.sid = s.blocking_session
WHERE s.blocking_session IS NOT NULL
ORDER BY s.seconds_in_wait DESC;`,
  },
  {
    id: 'ora-long-tx', category: 'Oracle 专属', name: '长事务（>60s）', db: 'oracle',
    desc: '查找运行超过 60 秒的未提交事务',
    sql: `SELECT s.sid, s.serial#, s.username, s.status,
  t.start_time, t.used_ublk AS undo_blocks,
  ROUND((SYSDATE - TO_DATE(t.start_time,'MM/DD/YY HH24:MI:SS')) * 86400) AS secs
FROM v$transaction t
JOIN v$session s ON s.taddr = t.addr
WHERE ROUND((SYSDATE - TO_DATE(t.start_time,'MM/DD/YY HH24:MI:SS')) * 86400) > 60
ORDER BY secs DESC;`,
  },
  {
    id: 'ora-tablespace', category: 'Oracle 专属', name: '表空间使用率', db: 'oracle',
    desc: '查看各表空间总量、已用量与使用率',
    sql: `SELECT
  df.tablespace_name,
  ROUND(df.totalspace / 1024 / 1024, 1) AS total_mb,
  ROUND((df.totalspace - fs.freespace) / 1024 / 1024, 1) AS used_mb,
  ROUND(fs.freespace / 1024 / 1024, 1) AS free_mb,
  ROUND((1 - fs.freespace / df.totalspace) * 100, 1) AS used_pct
FROM (SELECT tablespace_name, SUM(bytes) totalspace FROM dba_data_files GROUP BY tablespace_name) df
JOIN (SELECT tablespace_name, SUM(bytes) freespace FROM dba_free_space GROUP BY tablespace_name) fs
  ON df.tablespace_name = fs.tablespace_name
ORDER BY used_pct DESC;`,
  },
  {
    id: 'ora-top-sql', category: 'Oracle 专属', name: 'Top SQL（最耗时）', db: 'oracle',
    desc: '从 V$SQL 找出累计耗时最高的 SQL（需 SELECT_CATALOG_ROLE）',
    sql: `SELECT * FROM (
  SELECT sql_id, executions,
    ROUND(elapsed_time / 1e6, 2) AS elapsed_sec,
    ROUND(cpu_time / 1e6, 2) AS cpu_sec,
    disk_reads, buffer_gets,
    SUBSTR(sql_text, 1, 100) AS sql_text
  FROM v$sql
  WHERE executions > 0
  ORDER BY elapsed_time DESC
) WHERE ROWNUM <= 20;`,
  },
  {
    id: 'ora-active-session', category: 'Oracle 专属', name: '活跃会话', db: 'oracle',
    desc: '查看当前活跃用户会话（排除后台进程）',
    sql: `SELECT sid, serial#, username, status, machine,
  program, wait_class, event, seconds_in_wait,
  SUBSTR(sql_id, 1, 13) AS sql_id
FROM v$session
WHERE type = 'USER' AND status = 'ACTIVE'
ORDER BY seconds_in_wait DESC;`,
  },
  {
    id: 'ora-invalid-obj', category: 'Oracle 专属', name: '失效对象检查', db: 'oracle',
    desc: '列出所有状态为 INVALID 的存储过程/函数/视图',
    sql: `SELECT owner, object_type, object_name, status, last_ddl_time
FROM all_objects
WHERE status = 'INVALID'
  AND owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP')
ORDER BY owner, object_type, object_name;`,
  },
  {
    id: 'ora-redo-log', category: 'Oracle 专属', name: 'Redo Log 状态', db: 'oracle',
    desc: '查看 Redo Log 组状态与切换频率',
    sql: `SELECT l.group#, l.members, l.bytes / 1024 / 1024 AS mb,
  l.status, l.archived, lf.member AS logfile
FROM v$log l
JOIN v$logfile lf ON lf.group# = l.group#
ORDER BY l.group#;`,
  },

  // -------- SQL Server 专属 --------
  {
    id: 'ss-lock-wait', category: 'sqlServer 专属', name: '锁等待链', db: 'sqlserver',
    desc: '查看当前阻塞链：阻塞者与被阻塞者',
    sql: `SELECT
  r.session_id AS blocked_spid,
  r.blocking_session_id AS blocking_spid,
  r.wait_type, r.wait_time / 1000.0 AS wait_sec,
  SUBSTRING(st.text, (r.statement_start_offset/2)+1,
    ((CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE r.statement_end_offset END - r.statement_start_offset)/2)+1
  ) AS blocked_sql,
  bs.text AS blocking_sql
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
OUTER APPLY sys.dm_exec_sql_text(
  (SELECT sql_handle FROM sys.dm_exec_requests WHERE session_id = r.blocking_session_id)
) bs
WHERE r.blocking_session_id > 0
ORDER BY r.wait_time DESC;`,
  },
  {
    id: 'ss-top-sql', category: 'sqlServer 专属', name: 'Top SQL（最耗CPU）', db: 'sqlserver',
    desc: '从 dm_exec_query_stats 找出累计 CPU 最高的查询',
    sql: `SELECT TOP 20
  qs.total_worker_time / qs.execution_count AS avg_cpu_us,
  qs.total_elapsed_time / qs.execution_count AS avg_elapsed_us,
  qs.execution_count,
  qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
  SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 100) AS sql_text,
  qp.query_plan
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
CROSS APPLY sys.dm_exec_query_plan(qs.plan_handle) qp
ORDER BY qs.total_worker_time DESC;`,
  },
  {
    id: 'ss-missing-index', category: 'sqlServer 专属', name: '缺失索引建议', db: 'sqlserver',
    desc: '列出优化器推荐的缺失索引（按 impact 排序）',
    sql: `SELECT TOP 20
  migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks + migs.user_scans) AS impact,
  mid.statement AS table_name,
  mid.equality_columns, mid.inequality_columns, mid.included_columns,
  migs.user_seeks, migs.user_scans, migs.last_user_seek
FROM sys.dm_db_missing_index_group_stats migs
JOIN sys.dm_db_missing_index_groups mig ON mig.index_group_handle = migs.group_handle
JOIN sys.dm_db_missing_index_details mid ON mid.index_handle = mig.index_handle
ORDER BY impact DESC;`,
  },
  {
    id: 'ss-active-conn', category: 'sqlServer 专属', name: '活跃连接', db: 'sqlserver',
    desc: '查看当前用户会话与正在执行的 SQL',
    sql: `SELECT s.session_id, s.login_name, s.host_name,
  s.program_name, s.status, s.cpu_time, s.memory_usage * 8 AS mem_kb,
  r.wait_type, r.wait_time / 1000.0 AS wait_sec,
  SUBSTRING(st.text, 1, 100) AS current_sql
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE s.is_user_process = 1
ORDER BY s.cpu_time DESC;`,
  },
  {
    id: 'ss-table-size', category: 'sqlServer 专属', name: '表大小排行', db: 'sqlserver',
    desc: '列出当前库所有表的行数与占用空间',
    sql: `SELECT
  OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
  OBJECT_NAME(i.object_id) AS table_name,
  SUM(p.rows) AS row_count,
  ROUND(SUM(a.total_pages) * 8 / 1024.0, 2) AS total_mb,
  ROUND(SUM(a.used_pages) * 8 / 1024.0, 2) AS used_mb
FROM sys.indexes i
JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
JOIN sys.allocation_units a ON p.partition_id = a.container_id
WHERE i.type <= 1
GROUP BY i.object_id
ORDER BY SUM(a.total_pages) DESC;`,
  },
  {
    id: 'ss-tempdb', category: 'sqlServer 专属', name: 'TempDB 使用热点', db: 'sqlserver',
    desc: '查看 TempDB 使用最多的会话（排序/哈希/溢出）',
    sql: `SELECT TOP 20
  session_id,
  SUM(internal_objects_alloc_page_count) AS internal_pages,
  SUM(user_objects_alloc_page_count) AS user_pages,
  SUM(internal_objects_alloc_page_count + user_objects_alloc_page_count) * 8 / 1024 AS total_mb
FROM sys.dm_db_task_space_usage
WHERE session_id > 50
GROUP BY session_id
ORDER BY total_mb DESC;`,
  },

  // -------- DuckDB 专属 --------
  {
    id: 'duck-tables', category: 'DuckDB 专属', name: '库表概览', db: 'duckdb',
    desc: '列出 DuckDB 所有表及列数',
    sql: `SELECT database_name, schema_name, table_name, column_count, estimated_size
FROM duckdb_tables()
ORDER BY database_name, schema_name, table_name;`,
  },
  {
    id: 'duck-indexes', category: 'DuckDB 专属', name: '索引列表', db: 'duckdb',
    desc: '查看所有表的索引定义',
    sql: `SELECT schema_name, table_name, index_name, is_unique, sql
FROM duckdb_indexes()
ORDER BY schema_name, table_name;`,
  },
  {
    id: 'duck-memory', category: 'DuckDB 专属', name: '内存使用情况', db: 'duckdb',
    desc: '查看 DuckDB 的当前内存限制配置',
    sql: `-- 当前内存限制
SELECT current_setting('memory_limit') AS memory_limit;

-- 数据库文件大小
SELECT file_name, file_size / 1024 / 1024 AS size_mb
FROM duckdb_databases()
WHERE NOT is_temporary;`,
  },
  {
    id: 'duck-types', category: 'DuckDB 专属', name: '支持的数据类型', db: 'duckdb',
    desc: '列出 DuckDB 所有内置数据类型',
    sql: `SELECT type_catalog, type_schema, type_name, data_type
FROM information_schema.type_privileges
GROUP BY type_catalog, type_schema, type_name, data_type
ORDER BY type_name;`,
  },

  // -------- SQLite 专属 --------
  {
    id: 'sqlite-tables', category: 'SQLite 专属', name: '所有表 / 视图', db: 'sqlite',
    desc: '列出当前 SQLite 数据库中所有对象',
    sql: `SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY type, name;`,
  },
  {
    id: 'sqlite-pragma', category: 'SQLite 专属', name: '数据库信息', db: 'sqlite',
    desc: '查看页面大小、缓存、WAL 模式等基本配置',
    sql: `PRAGMA page_count;
PRAGMA page_size;
PRAGMA journal_mode;
PRAGMA wal_autocheckpoint;
PRAGMA cache_size;
PRAGMA integrity_check;`,
  },
  {
    id: 'sqlite-size', category: 'SQLite 专属', name: '表行数估算', db: 'sqlite',
    desc: '从 sqlite_stat1 快速查看各表行数（需运行过 ANALYZE）',
    sql: `SELECT tbl AS table_name,
  CAST(SUBSTR(stat, 1, INSTR(stat||' ', ' ')-1) AS INTEGER) AS approx_rows
FROM sqlite_stat1
ORDER BY approx_rows DESC;`,
  },
  {
    id: 'sqlite-index', category: 'SQLite 专属', name: '索引列表', db: 'sqlite',
    desc: '列出所有索引及其关联表',
    sql: `SELECT name AS index_name, tbl_name AS table_name,
  sql
FROM sqlite_master
WHERE type = 'index'
ORDER BY tbl_name, name;`,
  },

  // -------- ClickHouse 专属 --------
  {
    id: 'ch-parts-too-many', category: 'ClickHouse 专属', name: 'Too Many Parts 风险诊断', db: 'clickhouse',
    desc: '找出单分区 Parts 过多的表（>300 危险阈值）',
    sql: `SELECT
  database, table, partition,
  countIf(active) AS active_parts,
  formatReadableQuantity(sumIf(rows, active)) AS rows_total,
  formatReadableSize(sumIf(bytes_on_disk, active)) AS disk_size
FROM system.parts
WHERE database NOT IN ('system')
GROUP BY database, table, partition
HAVING active_parts > 100
ORDER BY active_parts DESC;`,
  },
  {
    id: 'ch-merges', category: 'ClickHouse 专属', name: '进行中合并任务', db: 'clickhouse',
    desc: '查看当前后台合并任务进度',
    sql: `SELECT
  database, table, partition_id,
  toString(round(elapsed, 2)) AS elapsed_sec,
  toString(round(progress * 100, 1)) AS progress_pct,
  formatReadableQuantity(rows_read) AS rows_read,
  formatReadableQuantity(rows_written) AS rows_written,
  result_part_count,
  source_part_count
FROM system.merges
ORDER BY elapsed DESC;`,
  },
  {
    id: 'ch-mutations', category: 'ClickHouse 专属', name: 'Mutation 状态监控', db: 'clickhouse',
    desc: '查看 ALTER UPDATE/DELETE 等异步 Mutation 进度与失败原因',
    sql: `SELECT
  database, table, mutation_id,
  command,
  is_done,
  parts_to_do,
  parts_done,
  latest_fail_reason,
  toString(create_time) AS create_time
FROM system.mutations
WHERE is_done = 0
ORDER BY create_time DESC;`,
  },
  {
    id: 'ch-slow-queries', category: 'ClickHouse 专属', name: '慢查询 Top 分析', db: 'clickhouse',
    desc: '最近 1 小时耗时最长的查询（system.query_log）',
    sql: `SELECT
  user,
  toString(round(query_duration_ms / 1000, 2)) AS elapsed_sec,
  formatReadableQuantity(read_rows) AS read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  formatReadableSize(memory_usage) AS memory_usage,
  query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_duration_ms > 1000
  AND event_time >= now() - INTERVAL 1 HOUR
ORDER BY query_duration_ms DESC
LIMIT 20;`,
  },
  {
    id: 'ch-replicas', category: 'ClickHouse 专属', name: '副本状态检查', db: 'clickhouse',
    desc: '检查 ReplicatedMergeTree 副本延迟与只读状态',
    sql: `SELECT
  database, table, engine,
  is_leader, is_readonly,
  absolute_delay,
  queue_size, inserts_in_queue, merges_in_queue,
  total_replicas, active_replicas
FROM system.replicas
ORDER BY is_readonly DESC, absolute_delay DESC;`,
  },
  {
    id: 'ch-distributed-queue', category: 'ClickHouse 专属', name: 'Distributed 分发队列', db: 'clickhouse',
    desc: '检查 Distributed 表异步写入队列堆积情况',
    sql: `SELECT
  database, table,
  data_path,
  is_blocked,
  error_count,
  max_retry_count
FROM system.distribution_queue
ORDER BY error_count DESC
LIMIT 50;`,
  },
  {
    id: 'ch-disk-usage', category: 'ClickHouse 专属', name: '磁盘与库表占用排行', db: 'clickhouse',
    desc: '各磁盘可用量 + 库级存储占用排行',
    sql: `-- 磁盘空间
SELECT name, path,
  formatReadableSize(free_space) AS free,
  formatReadableSize(total_space) AS total,
  toString(round((1 - free_space / total_space) * 100, 1)) || '%' AS used_pct
FROM system.disks;

-- 库级存储占用（active parts）
SELECT database,
  formatReadableSize(sum(bytes_on_disk)) AS disk_used,
  formatReadableQuantity(sum(rows)) AS rows_total,
  count() AS table_count
FROM system.parts
WHERE active AND database NOT IN ('system')
GROUP BY database
ORDER BY sum(bytes_on_disk) DESC;`,
  },
  {
    id: 'ch-ttl-check', category: 'ClickHouse 专属', name: 'TTL 配置查看', db: 'clickhouse',
    desc: '查看已配置 TTL 的表（数据自动过期/分层）',
    sql: `SELECT
  database, name AS table, engine,
  data_ttl, metadata_modification_time
FROM system.tables
WHERE data_ttl != ''
  AND database NOT IN ('system')
ORDER BY database, name;`,
  },
]

export default function DbaTemplatesPanel({ connType, onRun, onClose }: Props) {
  const [filter, setFilter] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [copied, setCopied] = useState('')

  const isPg        = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isKingBase  = connType === 'kingBase'
  const isOpenGauss = connType === 'openGauss'
  const isMaria     = connType === 'mariadb'
  const isTiDB      = connType === 'tidb'
  const isOceanBase  = connType === 'oceanBase'
  const isClickHouse = connType === 'clickHouse'
  const isOracle     = connType === 'oracle'
  const isSqlServer  = connType === 'sqlServer'
  const isDuckDB     = connType === 'duckdb'
  const isSQLite     = connType === 'sqlite'
  const dbFilter     = (t: Template) => t.db === 'both' ||
    (isOracle     ? t.db === 'oracle' :
     isSqlServer  ? t.db === 'sqlserver' :
     isDuckDB     ? t.db === 'duckdb' :
     isSQLite     ? t.db === 'sqlite' :
     isClickHouse ? t.db === 'clickhouse' :
     isPg         ? (t.db === 'pg' || (isKingBase && t.db === 'kingbase') || (isOpenGauss && t.db === 'opengauss')) :
     isTiDB       ? (t.db === 'mysql' || t.db === 'tidb') :
     isOceanBase  ? (t.db === 'mysql' || t.db === 'oceanbase') :
     isMaria      ? (t.db === 'mysql' || t.db === 'mariadb') :
     t.db === 'mysql')
  // 只展示当前库有效的分类 tab
  const visibleCategories = [...new Set(TEMPLATES.filter(dbFilter).map(t => t.category))]

  const q = filter.toLowerCase()
  const shown = TEMPLATES.filter(t =>
    dbFilter(t) &&
    (!cat || t.category === cat) &&
    (!q || t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q))
  )

  const copy = (sql: string) => {
    navigator.clipboard.writeText(sql)
    setCopied(sql)
    setTimeout(() => setCopied(''), 1500)
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BookOpen size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>DBA 诊断模板库</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{shown.length} 个模板</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        {/* 搜索 + 分类 */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索模板…" style={{ width: '100%', padding: '6px 10px 6px 28px', fontSize: 12 }} />
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button
              onClick={() => setCat(null)}
              style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: !cat ? 600 : 400, background: !cat ? 'var(--accent)' : 'var(--surface-2)', color: !cat ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)' }}
            >全部</button>
            {visibleCategories.map(c => (
              <button
                key={c}
                onClick={() => setCat(cat === c ? null : c)}
                style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: cat === c ? 600 : 400, background: cat === c ? 'var(--accent)' : 'var(--surface-2)', color: cat === c ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)' }}
              >{c}</button>
            ))}
          </div>
        </div>

        {/* 模板列表 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无匹配模板</div>
          ) : shown.map(t => (
            <div
              key={t.id}
              style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 6px' }}>{t.category}</span>
                <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13, flex: 1 }}>{t.name}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => copy(t.sql)}
                    style={{ color: copied === t.sql ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 4 }}
                  ><Copy size={13} /></button>
                  <button
                    onClick={() => { onRun(t.sql); onClose() }}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#fff', padding: '3px 10px', borderRadius: 5, background: 'var(--accent)', fontWeight: 500 }}
                  >
                    <Play size={10} /> 执行
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.desc}</div>
              <pre style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)',
                borderRadius: 6, padding: '6px 10px', maxHeight: 80, overflow: 'auto',
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>{t.sql}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
