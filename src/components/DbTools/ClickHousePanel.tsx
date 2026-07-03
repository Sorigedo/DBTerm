// CH2–CH5 — ClickHouse 专属运维面板（Parts/Merges/Mutations/Cluster/慢查询/当前查询）
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Server, Activity, Database, AlertTriangle, BarChart2, Clock, Zap } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'parts' | 'mutations' | 'cluster' | 'slowqueries' | 'processes'

interface PartStat {
  db: string
  table: string
  partition: string
  partsCount: number
  rowsTotal: string
  compressedBytes: string
  uncompressedBytes: string
  compressionRatio: string
  isActive: boolean
}

interface MergeStat {
  db: string
  table: string
  elapsed: string
  progress: string
  rowsRead: string
  rowsWritten: string
  numParts: number
}

interface MutationStat {
  db: string
  table: string
  mutationId: string
  command: string
  isDone: boolean
  partsToMutate: number
  partsDone: number
  failReason: string
  createTime: string
}

interface ClusterNode {
  clusterName: string
  shard: number
  shardWeight: number
  replica: number
  hostName: string
  hostAddress: string
  port: number
  isLocal: boolean
  user: string
}

interface ReplicaStatus {
  db: string
  table: string
  engine: string
  isLeader: boolean
  isReadonly: boolean
  absoluteDelay: number
  queueSize: number
  insertsInQueue: number
  mergesInQueue: number
}

interface SlowQuery {
  queryId: string
  user: string
  elapsed: string
  readRows: string
  readBytes: string
  memoryUsage: string
  queryNormalized: string
}

interface CurrentProcess {
  queryId: string
  user: string
  elapsed: string
  readRows: string
  memoryUsage: string
  query: string
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(6px)', zIndex: 8000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const PANEL_STYLE: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, width: 900, maxWidth: '94vw', maxHeight: '88vh',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
  animation: 'slideUp .18s ease',
}
const TAB_BAR: React.CSSProperties = {
  display: 'flex', gap: 2, padding: '0 16px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)', flexShrink: 0,
}
const CELL: React.CSSProperties = {
  padding: '6px 10px', fontSize: 12, color: 'var(--text)',
  borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
}
const TH: React.CSSProperties = {
  padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)',
  background: 'var(--surface-2)', fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap',
}


export default function ClickHousePanel({ connectionId, onClose, embedded }: Props) {
  const [tab, setTab] = useState<Tab>('parts')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [parts, setParts] = useState<PartStat[]>([])
  const [merges, setMerges] = useState<MergeStat[]>([])
  const [mutations, setMutations] = useState<MutationStat[]>([])
  const [cluster, setCluster] = useState<ClusterNode[]>([])
  const [replicas, setReplicas] = useState<ReplicaStatus[]>([])
  const [slowQueries, setSlowQueries] = useState<SlowQuery[]>([])
  const [processes, setProcesses] = useState<CurrentProcess[]>([])
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [killConfirm, setKillConfirm] = useState(false)

  async function q(sql: string): Promise<string[][]> {
    const { invoke } = await import('@tauri-apps/api/core')
    const r = await invoke<{ rows: (string | null)[][] }>('execute_query', { id: connectionId, sql })
    return r.rows.map(row => row.map(c => c ?? ''))
  }

  const loadParts = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await q(`
        SELECT database, table, partition,
          countIf(active) AS parts_count,
          formatReadableQuantity(sumIf(rows, active)) AS rows_total,
          formatReadableSize(sumIf(bytes_on_disk, active)) AS compressed,
          formatReadableSize(sumIf(data_uncompressed_bytes, active)) AS uncompressed,
          if(sumIf(data_uncompressed_bytes, active) > 0,
            toString(round(sumIf(bytes_on_disk, active) / sumIf(data_uncompressed_bytes, active), 3)),
            '0') AS ratio,
          1 AS is_active
        FROM system.parts
        WHERE database NOT IN ('system')
        GROUP BY database, table, partition
        ORDER BY sumIf(bytes_on_disk, active) DESC
        LIMIT 200`)
      setParts(rows.map(r => ({
        db: r[0], table: r[1], partition: r[2],
        partsCount: Number(r[3]), rowsTotal: r[4],
        compressedBytes: r[5], uncompressedBytes: r[6],
        compressionRatio: r[7], isActive: true,
      })))

      // system.merges 无 result_part_count 列；num_parts 为参与合并的源 part 数（每次合并产出 1 个结果 part）
      const mrows = await q(`
        SELECT database, table, elapsed, progress,
          formatReadableQuantity(rows_read) AS rows_read,
          formatReadableQuantity(rows_written) AS rows_written,
          num_parts
        FROM system.merges
        ORDER BY elapsed DESC
        LIMIT 50`)
      setMerges(mrows.map(r => ({
        db: r[0], table: r[1], elapsed: r[2], progress: r[3],
        rowsRead: r[4], rowsWritten: r[5], numParts: Number(r[6]),
      })))
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [connectionId])

  const loadMutations = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await q(`
        SELECT database, table, mutation_id, command,
          is_done, parts_to_do, parts_done,
          latest_fail_reason, toString(create_time) AS create_time
        FROM system.mutations
        ORDER BY create_time DESC
        LIMIT 100`)
      setMutations(rows.map(r => ({
        db: r[0], table: r[1], mutationId: r[2], command: r[3],
        isDone: r[4] === '1', partsToMutate: Number(r[5]),
        partsDone: Number(r[6]), failReason: r[7], createTime: r[8],
      })))
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [connectionId])

  const loadCluster = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await q(`
        SELECT cluster, shard_num, shard_weight, replica_num,
          host_name, host_address, port, is_local, user
        FROM system.clusters
        ORDER BY cluster, shard_num, replica_num`)
      setCluster(rows.map(r => ({
        clusterName: r[0], shard: Number(r[1]), shardWeight: Number(r[2]),
        replica: Number(r[3]), hostName: r[4], hostAddress: r[5],
        port: Number(r[6]), isLocal: r[7] === '1', user: r[8],
      })))

      const rrows = await q(`
        SELECT database, table, engine, is_leader, is_readonly,
          absolute_delay, queue_size, inserts_in_queue, merges_in_queue
        FROM system.replicas
        ORDER BY absolute_delay DESC
        LIMIT 100`).catch(() => [] as string[][])
      setReplicas(rrows.map(r => ({
        db: r[0], table: r[1], engine: r[2],
        isLeader: r[3] === '1', isReadonly: r[4] === '1',
        absoluteDelay: Number(r[5]), queueSize: Number(r[6]),
        insertsInQueue: Number(r[7]), mergesInQueue: Number(r[8]),
      })))
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [connectionId])

  const loadSlowQueries = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await q(`
        SELECT query_id, user,
          toString(round(query_duration_ms / 1000, 2)) AS elapsed_sec,
          formatReadableQuantity(read_rows) AS read_rows,
          formatReadableSize(read_bytes) AS read_bytes,
          formatReadableSize(memory_usage) AS memory_usage,
          query
        FROM system.query_log
        WHERE type = 'QueryFinish'
          AND query_duration_ms > 1000
          AND event_time >= now() - 3600
        ORDER BY query_duration_ms DESC
        LIMIT 50`).catch(() => [] as string[][])
      setSlowQueries(rows.map(r => ({
        queryId: r[0], user: r[1], elapsed: r[2] + 's',
        readRows: r[3], readBytes: r[4], memoryUsage: r[5],
        queryNormalized: r[6],
      })))
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [connectionId])

  const loadProcesses = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await q(`
        SELECT query_id, user,
          toString(round(elapsed, 2)) AS elapsed_sec,
          formatReadableQuantity(read_rows) AS read_rows,
          formatReadableSize(memory_usage) AS memory_usage,
          query
        FROM system.processes
        ORDER BY elapsed DESC`)
      setProcesses(rows.map(r => ({
        queryId: r[0], user: r[1], elapsed: r[2] + 's',
        readRows: r[3], memoryUsage: r[4], query: r[5],
      })))
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }, [connectionId])

  useEffect(() => {
    if (tab === 'parts') loadParts()
    else if (tab === 'mutations') loadMutations()
    else if (tab === 'cluster') loadCluster()
    else if (tab === 'slowqueries') loadSlowQueries()
    else if (tab === 'processes') loadProcesses()
  }, [tab, loadParts, loadMutations, loadCluster, loadSlowQueries, loadProcesses])

  async function killQuery(queryId: string) {
    try {
      await q(`KILL QUERY WHERE query_id = '${queryId.replace(/'/g, "''")}'`)
      setKillConfirm(false); setKillTarget(null)
      loadProcesses()
    } catch (e) { setError(String(e)) }
  }

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'parts',       label: 'Parts/合并', icon: <Database size={12} /> },
    { id: 'mutations',   label: 'Mutation',   icon: <Zap size={12} /> },
    { id: 'cluster',     label: '集群/副本',  icon: <Server size={12} /> },
    { id: 'slowqueries', label: '慢查询',     icon: <Clock size={12} /> },
    { id: 'processes',   label: '当前查询',   icon: <Activity size={12} /> },
  ]

  const tabBtn = (t: typeof TABS[number]) => (
    <button key={t.id} onClick={() => setTab(t.id)} style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px',
      fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
      color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
      background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
      cursor: 'pointer', whiteSpace: 'nowrap',
    }}>{t.icon}{t.label}</button>
  )

  function renderParts() {
    const tooManyRisk = parts.filter(p => p.partsCount > 300)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {tooManyRisk.length > 0 && (
          <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid #dc2626', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <AlertTriangle size={14} color="var(--error)" />
            <span style={{ fontSize: 12, color: 'var(--error)' }}>
              Too Many Parts 风险：{tooManyRisk.map(p => `${p.db}.${p.table}(${p.partsCount})`).join(', ')}
              — 建议降低写入频率或合并分区
            </span>
          </div>
        )}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>分区 Parts 统计（TOP 200，按磁盘占用排序）</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead><tr>
                {['库.表', '分区', 'Parts数', '行数', '压缩后', '压缩前', '压缩率'].map(h =>
                  <th key={h} style={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={i} style={{ background: p.partsCount > 300 ? 'rgba(220,38,38,0.05)' : undefined }}>
                    <td style={CELL}>{p.db}.{p.table}</td>
                    <td style={CELL}>{p.partition || '(default)'}</td>
                    <td style={{ ...CELL, color: p.partsCount > 300 ? '#dc2626' : p.partsCount > 100 ? '#ea580c' : 'var(--text)' }}>{p.partsCount}</td>
                    <td style={CELL}>{p.rowsTotal}</td>
                    <td style={CELL}>{p.compressedBytes}</td>
                    <td style={CELL}>{p.uncompressedBytes}</td>
                    <td style={CELL}>{p.compressionRatio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Activity size={12} style={{ color: 'var(--accent)' }} />进行中合并
          </div>
          {merges.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0' }}>暂无进行中的合并任务</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead><tr>
                {['库.表', '已用时(s)', '进度', '已读行', '已写行', '源Parts'].map(h =>
                  <th key={h} style={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {merges.map((m, i) => (
                  <tr key={i}>
                    <td style={CELL}>{m.db}.{m.table}</td>
                    <td style={CELL}>{m.elapsed}</td>
                    <td style={{ ...CELL }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, minWidth: 60 }}>
                          <div style={{ height: '100%', borderRadius: 2, background: 'var(--accent)', width: `${Math.round(Number(m.progress) * 100)}%` }} />
                        </div>
                        <span>{Math.round(Number(m.progress) * 100)}%</span>
                      </div>
                    </td>
                    <td style={CELL}>{m.rowsRead}</td>
                    <td style={CELL}>{m.rowsWritten}</td>
                    <td style={CELL}>{m.numParts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  function renderMutations() {
    const failed = mutations.filter(m => !m.isDone && m.failReason)
    const pending = mutations.filter(m => !m.isDone && !m.failReason)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {failed.length > 0 && (
          <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid #dc2626', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 6 }}>失败 Mutation（{failed.length} 个）</div>
            {failed.map((m, i) => (
              <div key={i} style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>
                {m.db}.{m.table} [{m.mutationId}]: {m.failReason}
              </div>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div style={{ background: 'rgba(234,88,12,0.08)', border: '1px solid #ea580c', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--warning)' }}>
              {pending.length} 个 Mutation 进行中 — Mutation 堆积会阻塞合并，注意资源消耗
            </div>
          </div>
        )}
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead><tr>
            {['库.表', 'Mutation ID', '指令', '状态', '进度(完成/总计)', '创建时间'].map(h =>
              <th key={h} style={TH}>{h}</th>)}
          </tr></thead>
          <tbody>
            {mutations.map((m, i) => (
              <tr key={i}>
                <td style={CELL}>{m.db}.{m.table}</td>
                <td style={CELL}>{m.mutationId}</td>
                <td style={{ ...CELL, maxWidth: 240 }}><span title={m.command}>{m.command.slice(0, 60)}{m.command.length > 60 ? '…' : ''}</span></td>
                <td style={{ ...CELL, color: m.isDone ? '#16a34a' : m.failReason ? '#dc2626' : '#ea580c' }}>
                  {m.isDone ? '完成' : m.failReason ? '失败' : '进行中'}
                </td>
                <td style={CELL}>{m.partsDone}/{m.partsDone + m.partsToMutate}</td>
                <td style={CELL}>{m.createTime.slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {mutations.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0' }}>暂无 Mutation 记录</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px' }}>
          <strong>KILL MUTATION 操作</strong>：取消进行中的 Mutation 请在 SQL 编辑器执行：<br />
          <code style={{ color: 'var(--accent)', fontSize: 11 }}>KILL MUTATION WHERE database='db' AND table='tbl' AND mutation_id='0000000xxx'</code>
          <br /><span style={{ color: 'var(--warning)' }}>高危操作，会中断正在重写的 Parts，建议在业务低峰期操作。</span>
        </div>
      </div>
    )
  }

  function renderCluster() {
    const readonlyReplicas = replicas.filter(r => r.isReadonly)
    const delayedReplicas = replicas.filter(r => !r.isReadonly && r.absoluteDelay > 60)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {readonlyReplicas.length > 0 && (
          <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid #dc2626', borderRadius: 8, padding: '10px 14px' }}>
            <AlertTriangle size={14} color="var(--error)" style={{ marginBottom: 4 }} />
            <span style={{ fontSize: 12, color: 'var(--error)', marginLeft: 8 }}>
              只读副本（Keeper/ZooKeeper 失联）：{readonlyReplicas.map(r => `${r.db}.${r.table}`).join(', ')}
            </span>
          </div>
        )}
        {delayedReplicas.length > 0 && (
          <div style={{ background: 'rgba(234,88,12,0.08)', border: '1px solid #ea580c', borderRadius: 8, padding: '10px 14px' }}>
            <span style={{ fontSize: 12, color: 'var(--warning)' }}>
              复制延迟 &gt;60s：{delayedReplicas.map(r => `${r.db}.${r.table}(${r.absoluteDelay}s)`).join(', ')}
            </span>
          </div>
        )}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>集群节点（system.clusters）</div>
          {cluster.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无集群配置（单节点模式）</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead><tr>
                {['集群名', 'Shard', 'Replica', '主机', '地址', '端口', '是否本地', '用户'].map(h =>
                  <th key={h} style={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {cluster.map((n, i) => (
                  <tr key={i}>
                    <td style={CELL}>{n.clusterName}</td>
                    <td style={CELL}>{n.shard}</td>
                    <td style={CELL}>{n.replica}</td>
                    <td style={CELL}>{n.hostName}</td>
                    <td style={CELL}>{n.hostAddress}</td>
                    <td style={CELL}>{n.port}</td>
                    <td style={{ ...CELL, color: n.isLocal ? 'var(--accent)' : 'var(--text)' }}>{n.isLocal ? '是' : '否'}</td>
                    <td style={CELL}>{n.user}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {replicas.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>副本状态（system.replicas）</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
              <thead><tr>
                {['库.表', '引擎', 'Leader', '只读', '延迟(s)', '队列', 'INSERT队列', 'Merge队列'].map(h =>
                  <th key={h} style={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {replicas.map((r, i) => (
                  <tr key={i}>
                    <td style={CELL}>{r.db}.{r.table}</td>
                    <td style={CELL}>{r.engine}</td>
                    <td style={{ ...CELL, color: r.isLeader ? 'var(--accent)' : 'var(--text)' }}>{r.isLeader ? '是' : '否'}</td>
                    <td style={{ ...CELL, color: r.isReadonly ? '#dc2626' : '#16a34a' }}>{r.isReadonly ? '只读' : '正常'}</td>
                    <td style={{ ...CELL, color: r.absoluteDelay > 60 ? '#dc2626' : r.absoluteDelay > 10 ? '#ea580c' : 'var(--text)' }}>{r.absoluteDelay}</td>
                    <td style={CELL}>{r.queueSize}</td>
                    <td style={CELL}>{r.insertsInQueue}</td>
                    <td style={CELL}>{r.mergesInQueue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  function renderSlowQueries() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>最近 1 小时执行耗时 &gt;1s 的查询（TOP 50）</div>
        {slowQueries.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无慢查询记录（system.query_log）</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>
              {['用户', '耗时', '读行', '读量', '内存', 'SQL（节选）'].map(h =>
                <th key={h} style={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {slowQueries.map((q, i) => (
                <tr key={i}>
                  <td style={CELL}>{q.user}</td>
                  <td style={{ ...CELL, color: Number(q.elapsed) > 30 ? '#dc2626' : '#ea580c' }}>{q.elapsed}</td>
                  <td style={CELL}>{q.readRows}</td>
                  <td style={CELL}>{q.readBytes}</td>
                  <td style={CELL}>{q.memoryUsage}</td>
                  <td style={{ ...CELL, maxWidth: 300 }}>
                    <span title={q.queryNormalized}>{q.queryNormalized.slice(0, 80)}{q.queryNormalized.length > 80 ? '…' : ''}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  function renderProcesses() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>当前运行中的查询（system.processes）</div>
        {processes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无运行中的查询</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>
              {['用户', '耗时', '读行', '内存', 'Query ID', 'SQL（节选）', '操作'].map(h =>
                <th key={h} style={TH}>{h}</th>)}
            </tr></thead>
            <tbody>
              {processes.map((p, i) => (
                <tr key={i}>
                  <td style={CELL}>{p.user}</td>
                  <td style={{ ...CELL, color: Number(p.elapsed) > 30 ? '#dc2626' : Number(p.elapsed) > 5 ? '#ea580c' : 'var(--text)' }}>{p.elapsed}</td>
                  <td style={CELL}>{p.readRows}</td>
                  <td style={CELL}>{p.memoryUsage}</td>
                  <td style={CELL}>{p.queryId.slice(0, 16)}</td>
                  <td style={{ ...CELL, maxWidth: 220 }}>
                    <span title={p.query}>{p.query.slice(0, 60)}{p.query.length > 60 ? '…' : ''}</span>
                  </td>
                  <td style={CELL}>
                    <button
                      onClick={() => { setKillTarget(p.queryId); setKillConfirm(true) }}
                      style={{ padding: '2px 8px', borderRadius: 4, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}
                    >终止</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  function renderContent() {
    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}><span className="spin" style={{ marginRight: 8 }}>⏳</span>加载中…</div>
    if (error) return <div style={{ color: 'var(--error)', fontSize: 13, padding: 16 }}>{error}</div>
    if (tab === 'parts')       return renderParts()
    if (tab === 'mutations')   return renderMutations()
    if (tab === 'cluster')     return renderCluster()
    if (tab === 'slowqueries') return renderSlowQueries()
    if (tab === 'processes')   return renderProcesses()
    return null
  }

  const inner = (
    <>
      {/* Tab bar（嵌入模式把刷新并进本行右侧，省去顶部标题栏）*/}
      <div style={{ ...TAB_BAR, alignItems: 'center', padding: embedded ? '0 12px' : '0 16px' }}>
        {TABS.map(tabBtn)}
        {embedded && (
          <button onClick={() => {
            if (tab === 'parts') loadParts()
            else if (tab === 'mutations') loadMutations()
            else if (tab === 'cluster') loadCluster()
            else if (tab === 'slowqueries') loadSlowQueries()
            else if (tab === 'processes') loadProcesses()
          }} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: embedded ? 12 : 16 }}>
        {renderContent()}
      </div>

      {/* Kill confirm */}
      {killConfirm && killTarget && createPortal(
        <div style={{ ...OVERLAY_STYLE, zIndex: 9000 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, maxWidth: 420, width: '90vw' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--error)', marginBottom: 12 }}>⚠ 确认终止查询</div>
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 16 }}>
              将执行 <code style={{ color: 'var(--error)' }}>KILL QUERY WHERE query_id = '{killTarget}'</code>。
              <br />该操作会立即中断正在执行的查询，无法撤销。
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setKillConfirm(false); setKillTarget(null) }}
                style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12 }}>
                取消
              </button>
              <button onClick={() => killQuery(killTarget)}
                style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }}>
                确认终止
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入 tab 行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div style={OVERLAY_STYLE} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={PANEL_STYLE}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <BarChart2 size={16} style={{ color: 'var(--accent)', marginRight: 8 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', flex: 1 }}>ClickHouse 运维面板</span>
          <button onClick={() => {
            if (tab === 'parts') loadParts()
            else if (tab === 'mutations') loadMutations()
            else if (tab === 'cluster') loadCluster()
            else if (tab === 'slowqueries') loadSlowQueries()
            else if (tab === 'processes') loadProcesses()
          }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, marginRight: 6 }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
