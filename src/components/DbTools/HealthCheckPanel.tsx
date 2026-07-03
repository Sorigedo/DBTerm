import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Stethoscope, CheckCircle, AlertTriangle, XCircle, RefreshCw, Download } from 'lucide-react'
import { toast } from '../../stores/toastStore'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_local_file', { path, content })
    toast.exported(path)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface Props {
  connectionId: string
  schema: string
  connType?: string
  onClose: () => void
}

interface HealthItem {
  category: string
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
  suggestion: string
}

const STATUS_ICON = {
  ok:    <CheckCircle size={14} color="var(--success)" />,
  warn:  <AlertTriangle size={14} color="var(--warning)" />,
  error: <XCircle size={14} color="var(--error)" />,
}

const STATUS_COLOR = {
  ok:    '#16a34a',
  warn:  '#ea580c',
  error: '#dc2626',
}

const STATUS_BG = {
  ok:    'rgba(22,163,74,0.06)',
  warn:  'rgba(234,88,12,0.07)',
  error: 'rgba(220,38,38,0.07)',
}

const STATUS_LABEL = { ok: '正常', warn: '警告', error: '异常' }

export default function HealthCheckPanel({ connectionId, schema, connType, onClose }: Props) {
  const [items, setItems] = useState<HealthItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const isMaria     = connType === 'mariadb'
  const isPg        = ['postgres', 'kingBase', 'openGauss'].includes(connType ?? '')
  const isKingBase  = connType === 'kingBase'
  const isOpenGauss = connType === 'openGauss'
  const isTiDB      = connType === 'tidb'
  const isOceanBase   = connType === 'oceanBase'
  const isClickHouse  = connType === 'clickHouse'

  const runPgChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. 缓存命中率
    try {
      const res = await q(`SELECT blks_hit, blks_read FROM pg_stat_database WHERE datname = current_database()`)
      const hit = Number(res.rows[0]?.[0] ?? 0), read = Number(res.rows[0]?.[1] ?? 0)
      const total = hit + read
      const pct = total > 0 ? hit / total : 1
      extra.push({
        category: 'PG 性能', name: '缓存命中率（Buffer Cache）',
        status: pct >= 0.99 ? 'ok' : pct >= 0.95 ? 'warn' : 'error',
        detail: `命中: ${hit.toLocaleString()} / 磁盘读: ${read.toLocaleString()} = ${(pct * 100).toFixed(2)}%`,
        suggestion: pct < 0.99 ? '命中率过低，考虑增加 shared_buffers（建议 25% 内存）' : '',
      })
    } catch { /* 忽略 */ }

    // 2. 未使用索引（idx_scan=0，运行 > 1 万行的表）
    try {
      const schemaFilter = schema ? `AND schemaname = '${schema.replace(/'/g, "''")}'` : `AND schemaname = 'public'`
      const res = await q(`SELECT indexrelname, relname FROM pg_stat_user_indexes
        WHERE idx_scan = 0 AND reltuples > 10000 ${schemaFilter}
        ORDER BY relname LIMIT 10`)
      const names = res.rows.map(r => `${String(r[1] ?? '')}.${String(r[0] ?? '')}`)
      extra.push({
        category: 'PG 索引', name: '未使用索引（idx_scan=0）',
        status: names.length === 0 ? 'ok' : 'warn',
        detail: names.length === 0 ? '无长期未使用索引' : `发现 ${names.length} 个未使用索引（仅统计 >1万行表）: ${names.slice(0,5).join(', ')}${names.length > 5 ? '…' : ''}`,
        suggestion: '未使用索引徒耗写开销和磁盘，可评估 DROP INDEX CONCURRENTLY',
      })
    } catch { /* 忽略 */ }

    // 3. idle in transaction
    try {
      const res = await q(`SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND pid <> pg_backend_pid()`)
      const cnt = Number(res.rows[0]?.[0] ?? 0)
      extra.push({
        category: 'PG 事务', name: 'idle in transaction 会话',
        status: cnt === 0 ? 'ok' : cnt > 5 ? 'error' : 'warn',
        detail: cnt === 0 ? '无 idle in transaction 会话' : `发现 ${cnt} 个 idle in transaction 会话（持有锁，阻碍 VACUUM）`,
        suggestion: cnt > 0 ? '检查应用是否遗漏提交事务，必要时 pg_terminate_backend 终止' : '',
      })
    } catch { /* 忽略 */ }

    // 4. 临时文件（内存外溢信号）
    try {
      const res = await q(`SELECT temp_files, temp_bytes FROM pg_stat_database WHERE datname = current_database()`)
      const files = Number(res.rows[0]?.[0] ?? 0), bytes = Number(res.rows[0]?.[1] ?? 0)
      const mb = Math.round(bytes / 1024 / 1024)
      extra.push({
        category: 'PG 性能', name: '临时文件（work_mem 外溢）',
        status: files === 0 ? 'ok' : mb > 1024 ? 'error' : 'warn',
        detail: files === 0 ? '无临时文件' : `已生成 ${files} 个临时文件，合计 ${mb} MB`,
        suggestion: files > 0 ? '频繁 temp_files 表明 work_mem 不足，考虑增加或优化排序/Hash Join' : '',
      })
    } catch { /* 忽略 */ }

    // 5. 非活跃复制槽（WAL 堆积风险）
    try {
      const res = await q(`SELECT slot_name FROM pg_replication_slots WHERE NOT active`)
      const slots = res.rows.map(r => String(r[0] ?? ''))
      extra.push({
        category: 'PG 复制', name: '非活跃复制槽',
        status: slots.length === 0 ? 'ok' : 'error',
        detail: slots.length === 0 ? '所有复制槽均活跃' : `发现 ${slots.length} 个非活跃复制槽: ${slots.join(', ')} — 会导致 WAL 文件持续积累！`,
        suggestion: '非活跃复制槽是 WAL 撑爆磁盘的常见原因，确认不再需要后 pg_drop_replication_slot',
      })
    } catch { /* 忽略（无复制权限时跳过）*/ }

    // 6. XID 年龄预警
    try {
      const res = await q(`SELECT datname, age(datfrozenxid) FROM pg_database WHERE datallowconn ORDER BY age(datfrozenxid) DESC LIMIT 1`)
      const dbName = String(res.rows[0]?.[0] ?? '')
      const age = Number(res.rows[0]?.[1] ?? 0)
      const pct = age / 2_000_000_000
      extra.push({
        category: 'PG 事务', name: 'XID 回卷风险（事务年龄）',
        status: pct < 0.5 ? 'ok' : pct < 0.8 ? 'warn' : 'error',
        detail: `库 "${dbName}" 最大 XID 年龄: ${age.toLocaleString()}（${(pct * 100).toFixed(1)}% of 2B）`,
        suggestion: pct >= 0.5 ? '执行 VACUUM (FREEZE) 降低事务年龄，防止 XID 回卷导致数据库停摆' : '',
      })
    } catch { /* 忽略 */ }

    return extra
  }

  const runMariaChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }

    // 1. 非事务引擎表占比
    try {
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT COUNT(*) total, SUM(IF(ENGINE NOT IN ('InnoDB','XtraDB','Aria'), 1, 0)) non_tx FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}' AND TABLE_TYPE = 'BASE TABLE'`,
      })
      const total = Number(res.rows[0]?.[0] ?? 0)
      const nonTx = Number(res.rows[0]?.[1] ?? 0)
      if (total > 0) {
        const pct = (nonTx / total) * 100
        extra.push({
          category: 'MariaDB 存储引擎', name: '非事务引擎表占比',
          status: pct > 30 ? 'warn' : 'ok',
          detail: `${nonTx}/${total} 张表使用非事务引擎（${pct.toFixed(1)}%）`,
          suggestion: pct > 0 ? '非事务引擎（MyISAM 等）不支持回滚，建议评估迁移至 InnoDB/Aria' : '',
        })
      }
    } catch { /* 忽略 */ }

    // 2. Galera 流控检查
    try {
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_flow_control_paused','wsrep_cluster_status','wsrep_ready')",
      })
      const m: Record<string, string> = {}
      for (const row of res.rows) m[String(row[0] ?? '')] = String(row[1] ?? '')
      if (m['wsrep_cluster_status']) {
        const paused = parseFloat(m['wsrep_flow_control_paused'] ?? '0')
        extra.push({
          category: 'MariaDB Galera', name: '流控暂停比例',
          status: paused > 0.1 ? 'error' : paused > 0.05 ? 'warn' : 'ok',
          detail: `wsrep_flow_control_paused=${(paused * 100).toFixed(2)}% · 集群状态: ${m['wsrep_cluster_status']}`,
          suggestion: paused > 0.1 ? '流控严重（>10%），检查慢节点或增加写入缓冲' : '',
        })
      }
    } catch { /* 非 Galera 节点，忽略 */ }

    // 3. 线程池饱和
    try {
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threadpool_threads','Threadpool_active_threads','Threadpool_queued')",
      })
      const m: Record<string, number> = {}
      for (const row of res.rows) m[String(row[0] ?? '').toLowerCase()] = Number(row[1] ?? 0)
      if (m['threadpool_threads'] > 0) {
        const saturation = m['threadpool_threads'] > 0 ? m['threadpool_active_threads'] / m['threadpool_threads'] : 0
        const queued = m['threadpool_queued'] ?? 0
        extra.push({
          category: 'MariaDB 线程池', name: '线程池饱和度',
          status: saturation > 0.9 || queued > 5 ? 'warn' : 'ok',
          detail: `活跃/${m['threadpool_threads']} 线程: ${m['threadpool_active_threads']}，排队: ${queued}`,
          suggestion: queued > 0 ? '有请求排队，考虑增加 thread_pool_size' : '',
        })
      }
    } catch { /* 无线程池插件，忽略 */ }

    // 4. 系统版本化表数量
    try {
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}' AND CREATE_OPTIONS LIKE '%with_system_versioning%'`,
      })
      const cnt = Number(res.rows[0]?.[0] ?? 0)
      if (cnt > 0) {
        extra.push({
          category: 'MariaDB 时态表', name: '系统版本化表数量',
          status: 'ok',
          detail: `${schema} 下有 ${cnt} 张系统版本化表（历史数据持续积累）`,
          suggestion: '定期执行 DELETE HISTORY 清理过旧历史记录，避免存储膨胀',
        })
      }
    } catch { /* 忽略 */ }

    return extra
  }

  const runKbChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. 审计是否已开启
    try {
      const res = await q(`SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'`)
      const libs = String(res.rows[0]?.[0] ?? '')
      const hasAudit = libs.includes('pgaudit')
      extra.push({
        category: '金仓安全', name: 'pgaudit 审计是否加载',
        status: hasAudit ? 'ok' : 'warn',
        detail: hasAudit ? 'shared_preload_libraries 包含 pgaudit' : `当前: ${libs || '（空）'}`,
        suggestion: hasAudit ? '' : '等保 2.0 三级要求开启审计，在 postgresql.conf 中加入 pgaudit 并重启',
      })
    } catch { /* 忽略 */ }

    // 2. Oracle 兼容模式状态
    try {
      const res = await q(`SHOW enable_oracle_compatible_syntax`)
      const val = String(res.rows[0]?.[0] ?? 'off')
      extra.push({
        category: '金仓兼容模式', name: 'Oracle 兼容模式',
        status: 'ok',
        detail: `enable_oracle_compatible_syntax = ${val}`,
        suggestion: val === 'on' ? '已开启 Oracle 兼容：ROWNUM/DUAL/NVL 等可用，注意迁移代码差异' : '',
      })
    } catch { /* 该 GUC 不存在，说明为纯 PG 模式 */ }

    // 3. sys_* 监控视图可用性
    try {
      await q(`SELECT 1 FROM sys_stat_database LIMIT 1`)
      extra.push({
        category: '金仓视图', name: 'sys_stat_database 可用',
        status: 'ok',
        detail: 'sys_* 系列监控视图可正常查询',
        suggestion: '',
      })
    } catch {
      extra.push({
        category: '金仓视图', name: 'sys_stat_database 可用性',
        status: 'warn',
        detail: 'sys_stat_database 不可用，将降级使用 pg_stat_database',
        suggestion: '部分金仓专属功能受限，请确认版本是否支持 sys_* 视图',
      })
    }

    // 4. 三权分立角色是否配置（audit_admin / security_admin）
    try {
      const res = await q(`SELECT rolname FROM pg_roles WHERE rolname IN ('audit_admin','security_admin','sso','sao') ORDER BY rolname`)
      const found = res.rows.map(r => String(r[0] ?? ''))
      extra.push({
        category: '金仓三权分立', name: '安全/审计角色配置',
        status: found.length >= 2 ? 'ok' : 'warn',
        detail: found.length > 0 ? `已发现角色: ${found.join(', ')}` : '未发现三权分立相关角色',
        suggestion: found.length < 2 ? '建议创建 security_admin（安全管理员）和 audit_admin（审计管理员）实现三权分立' : '',
      })
    } catch { /* 忽略 */ }

    return extra
  }

  const runOgChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. 安全策略是否启用
    try {
      const res = await q(`SELECT setting FROM pg_settings WHERE name = 'enable_security_policy'`)
      const val = String(res.rows[0]?.[0] ?? 'off')
      extra.push({
        category: 'openGauss 安全', name: '统一审计安全策略',
        status: val === 'on' ? 'ok' : 'warn',
        detail: `enable_security_policy = ${val}`,
        suggestion: val !== 'on' ? '等保合规要求开启安全策略，设置 enable_security_policy = on 并重启' : '',
      })
    } catch { /* 忽略 */ }

    // 2. dbe_perf 可用性
    try {
      await q(`SELECT 1 FROM dbe_perf.statement LIMIT 0`)
      extra.push({
        category: 'openGauss 监控', name: 'dbe_perf 性能视图可用',
        status: 'ok',
        detail: 'dbe_perf schema 可正常访问（TopSQL / 等待事件 / 内存上下文）',
        suggestion: '',
      })
    } catch {
      extra.push({
        category: 'openGauss 监控', name: 'dbe_perf 性能视图',
        status: 'warn',
        detail: 'dbe_perf 不可访问（需要 monitor admin 角色或 enable_stmt_track = on）',
        suggestion: '授予 GRANT USAGE ON SCHEMA dbe_perf TO <role>，或开启 enable_stmt_track',
      })
    }

    // 3. 列存表检查（是否有列存表 ORIENTATION=column）
    try {
      const res = await q(`SELECT COUNT(*) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE a.attname = 'relcmprs' AND n.nspname NOT IN ('pg_catalog','information_schema')
        LIMIT 1`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      if (cnt > 0) {
        extra.push({
          category: 'openGauss 列存', name: '列存表存在',
          status: 'ok',
          detail: `检测到列存表（ORIENTATION=column），适合 OLAP 大批量查询`,
          suggestion: '列存表不适合频繁行级 UPDATE/DELETE，确认使用场景',
        })
      }
    } catch { /* 不支持此检测 */ }

    // 4. 三权分立角色
    try {
      const res = await q(`SELECT rolname FROM pg_roles WHERE rolname IN ('sysadmin','security_admin','audit_admin') ORDER BY rolname`)
      const found = res.rows.map(r => String(r[0] ?? ''))
      extra.push({
        category: 'openGauss 三权', name: '三权分立角色配置',
        status: found.length >= 2 ? 'ok' : 'warn',
        detail: found.length > 0 ? `已发现: ${found.join(', ')}` : '未发现三权分立角色',
        suggestion: found.length < 2 ? '建议配置 security_admin（安全管理员）和 audit_admin（审计管理员）' : '',
      })
    } catch { /* 忽略 */ }

    return extra
  }

  const run = async () => {
    setLoading(true)
    setError('')
    setItems([])
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<HealthItem[]>('db_health_check', { id: connectionId, schema })
  const runTiDBChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. 热点 Region 检查
    try {
      const res = await q(`SELECT COUNT(*) FROM INFORMATION_SCHEMA.TIDB_HOT_REGIONS WHERE MAX_HOT_DEGREE > 5`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'TiDB 分布式', name: '写热点 Region',
        status: cnt > 0 ? 'warn' : 'ok',
        detail: cnt > 0 ? `检测到 ${cnt} 个高热度 Region（MAX_HOT_DEGREE > 5）` : '无高热度 Region',
        suggestion: cnt > 0 ? '检查是否使用 AUTO_INCREMENT 主键，建议改用 AUTO_RANDOM 或 SHARD_ROW_ID_BITS 分散写压力' : '',
      })
    } catch { /* 权限不足，跳过 */ }

    // 2. TiKV 存储均衡
    try {
      const res = await q(`SELECT MAX(LEADER_COUNT), MIN(LEADER_COUNT) FROM INFORMATION_SCHEMA.TIKV_STORE_STATUS WHERE STORE_STATE_NAME = 'Up'`)
      const maxL = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      const minL = parseInt(String(res.rows[0]?.[1] ?? '0'), 10)
      if (maxL > 0 && minL > 0) {
        const ratio = maxL / minL
        extra.push({
          category: 'TiDB 分布式', name: 'TiKV Leader 均衡度',
          status: ratio > 2 ? 'warn' : 'ok',
          detail: `Leader 数 Max/Min = ${maxL}/${minL}（比率 ${ratio.toFixed(1)}x）`,
          suggestion: ratio > 2 ? 'Leader 分布不均衡，PD 可能正在调度或需检查 PD 调度策略' : '',
        })
      }
    } catch { /* 忽略 */ }

    // 3. GC Life Time 过短检查
    try {
      const res = await q(`SELECT @@tidb_gc_life_time`)
      const gcLife = String(res.rows[0]?.[0] ?? '10m')
      extra.push({
        category: 'TiDB GC', name: 'GC Life Time 配置',
        status: 'ok',
        detail: `tidb_gc_life_time = ${gcLife}`,
        suggestion: gcLife === '10m' ? '默认 10m 可能对长查询过短（>10m 查询报 GC too late），可调整至 1h' : '',
      })
    } catch { /* 忽略 */ }

    // 4. 在途异步 DDL Job
    try {
      const res = await q(`ADMIN SHOW DDL JOBS 5`)
      const running = res.rows.filter(r => String(r[4] ?? '') === 'running')
      if (running.length > 0) {
        extra.push({
          category: 'TiDB DDL', name: '在途异步 DDL Job',
          status: 'warn',
          detail: `${running.length} 个 DDL Job 正在执行（大表加索引可能耗时较长）`,
          suggestion: '通过 ADMIN SHOW DDL JOBS 查看进度，确认不影响业务',
        })
      }
    } catch { /* 忽略 */ }

    return extra
  }

  const runOceanBaseChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. 合并状态
    try {
      const res = await q(`SELECT is_error, is_suspended, status FROM oceanbase.DBA_OB_MAJOR_COMPACTION LIMIT 1`)
      const isErr  = String(res.rows[0]?.[0] ?? 'NO') === 'YES'
      const isSusp = String(res.rows[0]?.[1] ?? 'NO') === 'YES'
      const status = String(res.rows[0]?.[2] ?? '—')
      extra.push({
        category: 'OceanBase 合并', name: 'Major Compaction 状态',
        status: isErr ? 'error' : isSusp ? 'warn' : 'ok',
        detail: `status=${status} · is_error=${isErr ? 'YES' : 'NO'} · is_suspended=${isSusp ? 'YES' : 'NO'}`,
        suggestion: isErr ? '合并报错，立即检查 OBServer 日志' : isSusp ? '合并被暂停，需手动恢复' : '',
      })
    } catch { /* 权限不足 */ }

    // 2. 离线 OBServer
    try {
      const res = await q(`SELECT COUNT(*) FROM oceanbase.DBA_OB_SERVERS WHERE status != 'ACTIVE'`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'OceanBase 节点', name: '离线 OBServer 数量',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0 ? `${cnt} 个 OBServer 状态非 ACTIVE` : '所有 OBServer 正常',
        suggestion: cnt > 0 ? '立即检查离线节点状态，Paxos 副本不足将影响可用性' : '',
      })
    } catch { /* 忽略 */ }

    // 3. 租户资源水位
    try {
      const res = await q(`SELECT COUNT(*) FROM oceanbase.DBA_OB_TENANTS WHERE status != 'NORMAL'`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'OceanBase 租户', name: '异常租户',
        status: cnt > 0 ? 'warn' : 'ok',
        detail: cnt > 0 ? `${cnt} 个租户状态异常` : '所有租户正常',
        suggestion: cnt > 0 ? '检查 DBA_OB_TENANTS.status，确认是否有租户锁定/停止' : '',
      })
    } catch { /* 忽略 */ }

    return extra
  }

  const runClickHouseChecks = async (): Promise<HealthItem[]> => {
    const extra: HealthItem[] = []
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    const q = (sql: string) => invoke<R>('execute_query', { id: connectionId, sql })

    // 1. Too Many Parts 风险
    try {
      const res = await q(`
        SELECT database, table, partition, countIf(active) AS parts_cnt
        FROM system.parts
        WHERE database NOT IN ('system')
        GROUP BY database, table, partition
        HAVING parts_cnt > 300
        ORDER BY parts_cnt DESC LIMIT 10`)
      const cnt = res.rows.length
      extra.push({
        category: 'ClickHouse 存储', name: 'Too Many Parts 风险',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0
          ? `${cnt} 个分区 Parts 数 >300：${res.rows.map(r => `${r[0]}.${r[1]}[${r[2]}]=${r[3]}`).join(', ')}`
          : '所有分区 Parts 数正常',
        suggestion: cnt > 0 ? '降低写入频率或增大合并阈值；避免频繁小批次写入' : '',
      })
    } catch { /* 权限不足 */ }

    // 2. 进行中 Mutation 数量
    try {
      const res = await q(`SELECT COUNT(*) FROM system.mutations WHERE is_done = 0`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'ClickHouse Mutation', name: '进行中 Mutation',
        status: cnt > 10 ? 'warn' : 'ok',
        detail: cnt > 0 ? `${cnt} 个 Mutation 执行中（ALTER UPDATE/DELETE 异步重写 Parts）` : '无进行中 Mutation',
        suggestion: cnt > 10 ? 'Mutation 堆积会阻塞合并，在业务低峰期执行；避免对大表频繁 mutation' : '',
      })
    } catch { /* 忽略 */ }

    // 3. 只读副本（Keeper 失联）
    try {
      const res = await q(`SELECT COUNT(*) FROM system.replicas WHERE is_readonly = 1`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'ClickHouse 副本', name: '只读副本（Keeper 失联）',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0 ? `${cnt} 个副本处于只读模式（ZooKeeper/Keeper 连接断开）` : '副本状态正常',
        suggestion: cnt > 0 ? '检查 ZooKeeper/Keeper 连接；可用 SYSTEM RESTORE REPLICA 恢复（高危，强确认）' : '',
      })
    } catch { /* 忽略，无副本时 system.replicas 为空 */ }

    // 4. 失败 Mutation
    try {
      const res = await q(`SELECT COUNT(*) FROM system.mutations WHERE is_done = 0 AND latest_fail_reason != ''`)
      const cnt = parseInt(String(res.rows[0]?.[0] ?? '0'), 10)
      extra.push({
        category: 'ClickHouse Mutation', name: '失败 Mutation',
        status: cnt > 0 ? 'error' : 'ok',
        detail: cnt > 0 ? `${cnt} 个 Mutation 执行失败，请查看 system.mutations.latest_fail_reason` : '无失败 Mutation',
        suggestion: cnt > 0 ? '检查 system.mutations 中 is_done=0 AND latest_fail_reason != "" 的记录，确认错误原因' : '',
      })
    } catch { /* 忽略 */ }

    return extra
  }

      const pgExtra = isPg ? await runPgChecks() : []
      const kbExtra = isKingBase ? await runKbChecks() : []
      const ogExtra = isOpenGauss ? await runOgChecks() : []
      const tiExtra = isTiDB ? await runTiDBChecks() : []
      const obExtra = isOceanBase ? await runOceanBaseChecks() : []
      const maExtra = isMaria ? await runMariaChecks() : []
      const chExtra = isClickHouse ? await runClickHouseChecks() : []
      const extra   = [...pgExtra, ...kbExtra, ...ogExtra, ...tiExtra, ...obExtra, ...maExtra, ...chExtra]
      setItems([...list, ...extra])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { run() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const score = items.length === 0 ? 100
    : Math.round((items.filter(i => i.status === 'ok').length / items.length) * 100)

  const scoreColor = score >= 90 ? '#16a34a' : score >= 70 ? '#ea580c' : '#dc2626'

  const categories = [...new Set(items.map(i => i.category))]

  const exportReport = async () => {
    const lines = ['# 健康巡检报告', `时间: ${new Date().toLocaleString()}`, `综合评分: ${score}分`, '']
    for (const cat of categories) {
      lines.push(`## ${cat}`)
      for (const item of items.filter(i => i.category === cat)) {
        lines.push(`### [${STATUS_LABEL[item.status]}] ${item.name}`)
        lines.push(`详情: ${item.detail}`)
        if (item.status !== 'ok') lines.push(`建议: ${item.suggestion}`)
        lines.push('')
      }
    }
    await saveTextFile(lines.join('\n'), `health_check_${Date.now()}.md`, 'Markdown 文件', 'md')
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Stethoscope size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>健康巡检</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>· {schema}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {!loading && items.length > 0 && (
              <button onClick={exportReport} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                <Download size={11} /> 导出
              </button>
            )}
            <button onClick={run} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', flexShrink: 0 }}>{error}</div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>巡检中，请稍候…</div>
          ) : items.length === 0 && !error ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无巡检结果</div>
          ) : (
            <>
              {/* Score card */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 80 }}>
                  <span style={{ fontSize: 36, fontWeight: 700, color: scoreColor, lineHeight: 1 }}>{score}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>综合评分</span>
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {(['ok', 'warn', 'error'] as const).map(s => (
                    <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {STATUS_ICON[s]}
                      <span style={{ fontSize: 13, fontWeight: 600, color: STATUS_COLOR[s] }}>
                        {items.filter(i => i.status === s).length}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{STATUS_LABEL[s]}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Items by category */}
              {categories.map(cat => (
                <div key={cat}>
                  <div style={{ padding: '8px 16px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {cat}
                  </div>
                  {items.filter(i => i.category === cat).map((item, idx) => (
                    <div
                      key={idx}
                      style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', background: STATUS_BG[item.status] }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        {STATUS_ICON[item.status]}
                        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>{item.name}</span>
                        <span style={{ fontSize: 11, color: STATUS_COLOR[item.status], background: `${STATUS_BG[item.status]}`, borderRadius: 4, padding: '1px 6px', border: `1px solid ${STATUS_COLOR[item.status]}33` }}>
                          {STATUS_LABEL[item.status]}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: item.status !== 'ok' ? 4 : 0 }}>
                        {item.detail}
                      </div>
                      {item.status !== 'ok' && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 4 }}>
                          <span style={{ color: 'var(--accent)' }}>建议：</span>
                          {item.suggestion}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
