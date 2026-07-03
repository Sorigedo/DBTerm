// SQL Server 专属工具（嵌入 DBA 面板的「专属工具▾」）：索引碎片整理 / SQL Agent 作业 / 等待统计 / 备份历史·AlwaysOn
// 统一走 execute_query 跑 DMV / msdb 系统视图，无需新增后端命令。
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCw, Play } from 'lucide-react'
import { friendlyDbError } from '../../utils/dbError'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean
  onRunSql?: (sql: string) => void
}

interface QResult { columns: string[]; rows: (string | null)[][] }
const runQ = (id: string, sql: string) => invoke<QResult>('execute_query', { id, sql })

// ── 共享外壳：工具栏(标题 + 刷新) + 错误条 + 内容滚动区 ──
function Shell({ title, loading, error, onRefresh, children, footer }: {
  title: string; loading: boolean; error: string; onRefresh: () => void
  children: React.ReactNode; footer?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{title}</span>
        <button onClick={onRefresh} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {error && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div> : children}
      </div>
      {footer}
    </div>
  )
}

// ── 通用表格（带可选操作列）──
function Table({ cols, rows, action }: { cols: string[]; rows: (string | null)[][]; action?: (row: (string | null)[]) => React.ReactNode }) {
  if (rows.length === 0) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无数据</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
        <tr>
          {cols.map((c, i) => <th key={i} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{c}</th>)}
          {action && <th style={{ padding: '6px 10px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>操作</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {row.map((cell, ci) => <td key={ci} style={{ padding: '5px 10px', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-tip={cell ?? ''}>{cell ?? <span style={{ color: 'var(--text-muted)' }}>NULL</span>}</td>)}
            {action && <td style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}>{action(row)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function useQuery(connectionId: string, sql: string) {
  const [res, setRes] = useState<QResult>({ columns: [], rows: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    try { setRes(await runQ(connectionId, sql)) }
    catch (e) { setError(friendlyDbError(e)); setRes({ columns: [], rows: [] }) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [connectionId])
  return { res, loading, error, reload: load }
}

const idx = (cols: string[], name: string) => cols.indexOf(name)

// ── 1. 索引碎片整理 ──
const FRAG_SQL = `SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name,
  CAST(ips.avg_fragmentation_in_percent AS DECIMAL(5,1)) AS frag_pct, ips.page_count
FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
JOIN sys.tables t ON t.object_id = ips.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
WHERE ips.avg_fragmentation_in_percent > 5 AND ips.page_count > 100 AND i.name IS NOT NULL
ORDER BY ips.avg_fragmentation_in_percent DESC`

export function MssqlIndexFragPanel({ connectionId, onRunSql }: Props) {
  const { res, loading, error, reload } = useQuery(connectionId, FRAG_SQL)
  const si = idx(res.columns, 'schema_name'), ti = idx(res.columns, 'table_name'), ii = idx(res.columns, 'index_name'), fi = idx(res.columns, 'frag_pct')
  return (
    <Shell title="碎片率 > 5% 且页数 > 100 的索引（建议 ≥30% REBUILD，否则 REORGANIZE）" loading={loading} error={error} onRefresh={reload}
      footer={<div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>共 {res.rows.length} 个 · 点「整理」把语句发到编辑器执行</div>}>
      <Table cols={res.columns} rows={res.rows} action={(row) => {
        const frag = Number(row[fi] ?? 0)
        const op = frag >= 30 ? 'REBUILD' : 'REORGANIZE'
        const sql = `ALTER INDEX [${row[ii]}] ON [${row[si]}].[${row[ti]}] ${op};`
        return <button onClick={() => onRunSql?.(sql)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer', background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid var(--border)' }}>
          <Play size={11} /> {op === 'REBUILD' ? '重建' : '整理'}
        </button>
      }} />
    </Shell>
  )
}

// ── 2. SQL Agent 作业 ──
const JOBS_SQL = `SELECT j.name AS job_name,
  CASE WHEN j.enabled = 1 THEN '启用' ELSE '禁用' END AS status,
  c.name AS category,
  (SELECT TOP 1 CASE h.run_status WHEN 1 THEN '成功' WHEN 0 THEN '失败' WHEN 3 THEN '取消' ELSE '其他' END
     FROM msdb.dbo.sysjobhistory h WHERE h.job_id = j.job_id AND h.step_id = 0 ORDER BY h.run_date DESC, h.run_time DESC) AS last_result,
  (SELECT TOP 1 CONVERT(VARCHAR, msdb.dbo.agent_datetime(h.run_date, h.run_time), 120)
     FROM msdb.dbo.sysjobhistory h WHERE h.job_id = j.job_id AND h.step_id = 0 ORDER BY h.run_date DESC, h.run_time DESC) AS last_run
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
ORDER BY j.name`

export function MssqlAgentJobsPanel({ connectionId }: Props) {
  const { res, loading, error, reload } = useQuery(connectionId, JOBS_SQL)
  return (
    <Shell title="SQL Server Agent 作业（msdb.sysjobs）" loading={loading} error={error} onRefresh={reload}
      footer={<div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>共 {res.rows.length} 个作业</div>}>
      <Table cols={res.columns} rows={res.rows} />
    </Shell>
  )
}

// ── 3. 等待统计 ──
const WAITS_SQL = `SELECT TOP 30 wait_type,
  waiting_tasks_count,
  wait_time_ms,
  signal_wait_time_ms,
  (wait_time_ms - signal_wait_time_ms) AS resource_wait_ms,
  CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER (), 0) AS DECIMAL(5,1)) AS pct
FROM sys.dm_os_wait_stats
WHERE wait_time_ms > 0 AND wait_type NOT IN (
  'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK','SLEEP_SYSTEMTASK',
  'SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE','CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH',
  'XE_TIMER_EVENT','BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
  'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN',
  'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_QUEUE','BROKER_EVENTHANDLER','SLEEP_BPOOL_FLUSH',
  'DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION','SP_SERVER_DIAGNOSTICS_SLEEP'
)
ORDER BY wait_time_ms DESC`

export function MssqlWaitStatsPanel({ connectionId }: Props) {
  const { res, loading, error, reload } = useQuery(connectionId, WAITS_SQL)
  return (
    <Shell title="Top 30 等待事件（sys.dm_os_wait_stats，已过滤无害等待）" loading={loading} error={error} onRefresh={reload}
      footer={<div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>wait_time_ms = 资源等待 + 信号等待；signal 高说明 CPU 压力</div>}>
      <Table cols={res.columns} rows={res.rows} />
    </Shell>
  )
}

// ── 4. 备份历史 / AlwaysOn ──
const BACKUP_SQL = `SELECT TOP 50 bs.database_name,
  CASE bs.type WHEN 'D' THEN '完整' WHEN 'I' THEN '差异' WHEN 'L' THEN '日志' WHEN 'F' THEN '文件' ELSE bs.type END AS type,
  CONVERT(VARCHAR, bs.backup_start_date, 120) AS start_time,
  CONVERT(VARCHAR, bs.backup_finish_date, 120) AS finish_time,
  CAST(bs.backup_size / 1048576.0 AS DECIMAL(12,1)) AS size_mb,
  bmf.physical_device_name
FROM msdb.dbo.backupset bs
LEFT JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
ORDER BY bs.backup_start_date DESC`

const AG_SQL = `SELECT ag.name AS ag_name, ar.replica_server_name,
  rs.role_desc, rs.operational_state_desc, rs.synchronization_health_desc, rs.connected_state_desc
FROM sys.availability_groups ag
JOIN sys.availability_replicas ar ON ar.group_id = ag.group_id
JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = ar.replica_id
ORDER BY ag.name, ar.replica_server_name`

export function MssqlBackupPanel({ connectionId }: Props) {
  const [tab, setTab] = useState<'backup' | 'ag'>('backup')
  const backup = useQuery(connectionId, BACKUP_SQL)
  const [agRes, setAgRes] = useState<QResult>({ columns: [], rows: [] })
  const [agLoading, setAgLoading] = useState(false)
  const [agError, setAgError] = useState('')
  const loadAg = async () => {
    setAgLoading(true); setAgError('')
    try { setAgRes(await runQ(connectionId, AG_SQL)) }
    catch (e) { setAgError(friendlyDbError(e)); setAgRes({ columns: [], rows: [] }) }
    finally { setAgLoading(false) }
  }
  useEffect(() => { if (tab === 'ag' && agRes.columns.length === 0 && !agError) loadAg() }, [tab])

  const cur = tab === 'backup' ? backup : { res: agRes, loading: agLoading, error: agError, reload: loadAg }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {(['backup', 'ag'] as const).map(k => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: tab === k ? 600 : 400, cursor: 'pointer',
              background: tab === k ? 'var(--accent)' : 'var(--surface-2)', color: tab === k ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)' }}>
            {k === 'backup' ? '备份历史' : 'AlwaysOn 可用性组'}
          </button>
        ))}
        <button onClick={cur.reload} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
          <RefreshCw size={13} className={cur.loading ? 'spin' : ''} />
        </button>
      </div>
      {cur.error && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{cur.error}</div>}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {cur.loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          : tab === 'ag' && cur.res.rows.length === 0 && !cur.error
            ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>未配置 AlwaysOn 可用性组</div>
            : <Table cols={cur.res.columns} rows={cur.res.rows} />}
      </div>
    </div>
  )
}
