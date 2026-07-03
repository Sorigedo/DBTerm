// H1 — 实例仪表盘：QPS/连接数/缓冲池命中率 + 折线图（纯 SVG）
import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Activity, RefreshCw, X } from 'lucide-react'
import { createPortal } from 'react-dom'

interface InstanceMetrics {
  queries: number
  connections: number
  threadsRunning: number
  uptimeS: number
  bufPoolHit: number
  dbType: string
}

interface ThreadPoolStats {
  threadPoolSize: number
  threadsActive: number
  threadsIdle:   number
  queued:        number
}

interface Props {
  connId: string
  connName: string
  connType?: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

const MAX_POINTS = 60
const INTERVAL_MS = 3000

function Sparkline({ data, color, height = 48 }: { data: number[], color: string, height?: number }) {
  if (data.length < 2) return <div style={{ height }} />
  const w = 240
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={w} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <polyline
        points={`0,${height} ${pts} ${w},${height}`}
        fill={color} fillOpacity={0.12} stroke="none"
      />
    </svg>
  )
}

function MetricCard({ label, value, unit, series, color, note }:
  { label: string, value: string, unit: string, series: number[], color: string, note?: string }) {
  return (
    <div style={{
      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '12px 14px', flex: 1, minWidth: 200,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-bright)', letterSpacing: -0.5 }}>
        {value}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 4, color: 'var(--text-muted)' }}>{unit}</span>
      </div>
      {note && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{note}</div>}
      <div style={{ marginTop: 8 }}><Sparkline data={series} color={color} /></div>
    </div>
  )
}

export default function DashboardPanel({ connId, connName, connType, onClose, embedded }: Props) {
  const isMaria = connType === 'mariadb'
  const [metrics, setMetrics] = useState<InstanceMetrics | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(true)
  const [threadPool, setThreadPool] = useState<ThreadPoolStats | null>(null)

  // rolling series: queries delta, connections, threadsRunning, bufHit%
  const queriesSeries   = useRef<number[]>([])
  const connSeries      = useRef<number[]>([])
  const activeSeries    = useRef<number[]>([])
  const bufHitSeries    = useRef<number[]>([])
  const prevQueries     = useRef<number | null>(null)
  const [, setTick] = useState(0)

  const sample = useCallback(async () => {
    try {
      const m = await invoke<InstanceMetrics>('db_instance_metrics', { id: connId })
      setMetrics(m)
      setError('')

      // queries delta (QPS proxy)
      const qDelta = prevQueries.current !== null ? Math.max(0, m.queries - prevQueries.current) : 0
      prevQueries.current = m.queries
      const push = (arr: React.MutableRefObject<number[]>, v: number) => {
        arr.current = [...arr.current.slice(-(MAX_POINTS - 1)), v]
      }
      push(queriesSeries, qDelta)
      push(connSeries,    m.connections)
      push(activeSeries,  m.threadsRunning)
      push(bufHitSeries,  m.bufPoolHit >= 0 ? m.bufPoolHit * 100 : 0)
      setTick(t => t + 1)

      // MariaDB 线程池监控（SHOW STATUS LIKE 'Threadpool%'）
      if (isMaria) {
        try {
          type R = { columns: string[]; rows: (string | null)[][] }
          const tpRes = await invoke<R>('execute_query', {
            id: connId, sql: "SHOW GLOBAL STATUS LIKE 'Threadpool%'",
          })
          const stats: Record<string, number> = {}
          for (const row of tpRes.rows) {
            const key = String(row[0] ?? '').toLowerCase().replace(/ /g, '_')
            stats[key] = Number(row[1] ?? 0)
          }
          if (Object.keys(stats).length > 0) {
            setThreadPool({
              threadPoolSize:  stats['threadpool_threads']      ?? 0,
              threadsActive:   stats['threadpool_active_threads'] ?? stats['threadpool_threads_running'] ?? 0,
              threadsIdle:     stats['threadpool_idle_threads']   ?? 0,
              queued:          stats['threadpool_queued']         ?? 0,
            })
          }
        } catch { /* 没有线程池插件则忽略 */ }
      }
    } catch (e) {
      setError(String(e))
    }
  }, [connId, isMaria])

  // 初次挂载立即采样一次
  useEffect(() => { sample() }, [sample])

  // running 控制定期采样 interval
  useEffect(() => {
    if (!running) return
    // 窗口不可见(最小化/切到别的应用)时暂停采样，避免后台空转持续连数据库 → 连接数暴增
    const id = setInterval(() => { if (!document.hidden) sample() }, INTERVAL_MS)
    return () => clearInterval(id)
  }, [sample, running])

  const fmtUptime = (s: number) => {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const inner = (
    <>
        {/* 嵌入模式：顶部内联紧凑工具行（采样开关 + 刷新），右对齐 */}
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>实例仪表盘 — {connName}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => setRunning(r => !r)} data-tip={running ? '暂停' : '恢复'}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: running ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
                <RefreshCw size={11} className={running ? 'spin' : ''} />{running ? '采样中' : '已暂停'}
              </button>
              <button onClick={sample} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
                <RefreshCw size={13} />
              </button>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: embedded ? 12 : 16 }}>
          {error && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

          {metrics && (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                类型: {metrics.dbType.toUpperCase()} · 运行时间: {fmtUptime(metrics.uptimeS)} · 每 {INTERVAL_MS/1000}s 刷新
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <MetricCard
                  label="查询增量 (Δ/采样)"
                  value={String(queriesSeries.current[queriesSeries.current.length - 1] ?? 0)}
                  unit="queries"
                  series={queriesSeries.current}
                  color="var(--accent)"
                />
                <MetricCard
                  label="当前连接数"
                  value={String(metrics.connections)}
                  unit="conns"
                  series={connSeries.current}
                  color="var(--accent)"
                />
                <MetricCard
                  label="活跃线程"
                  value={String(metrics.threadsRunning)}
                  unit="threads"
                  series={activeSeries.current}
                  color="var(--warning)"
                />
                {metrics.bufPoolHit >= 0 && (
                  <MetricCard
                    label="InnoDB 缓冲池命中率"
                    value={(metrics.bufPoolHit * 100).toFixed(2)}
                    unit="%"
                    series={bufHitSeries.current}
                    color="var(--success)"
                    note="< 95% 时可考虑增大 innodb_buffer_pool_size"
                  />
                )}
              </div>
              {/* MariaDB 线程池监控（仅当 thread pool 插件已启用） */}
              {isMaria && threadPool && threadPool.threadPoolSize > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
                    线程池（Thread Pool Plugin）
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {[
                      { label: '线程池大小', value: threadPool.threadPoolSize, unit: '' },
                      { label: '活跃线程', value: threadPool.threadsActive, unit: '', warn: threadPool.threadsActive >= threadPool.threadPoolSize * 0.9 },
                      { label: '空闲线程', value: threadPool.threadsIdle, unit: '' },
                      { label: '排队请求', value: threadPool.queued, unit: '', warn: threadPool.queued > 0 },
                    ].map(s => (
                      <div key={s.label} style={{
                        background: 'var(--surface-2)', border: `1px solid ${s.warn ? 'rgba(234,88,12,0.4)' : 'var(--border)'}`,
                        borderRadius: 10, padding: '10px 14px', minWidth: 140,
                      }}>
                        <div style={{ fontSize: 11, color: s.warn ? '#ea580c' : 'var(--text-muted)', marginBottom: 4 }}>{s.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: s.warn ? '#ea580c' : 'var(--text-bright)' }}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {!metrics && !error && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>采样中…</div>
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（采样/刷新已并入顶部工具行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 760, display: 'flex', flexDirection: 'column', maxHeight: '90vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Activity size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>实例仪表盘 — {connName}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => setRunning(r => !r)} title={running ? '暂停' : '恢复'}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: running ? 'var(--accent)' : 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
              <RefreshCw size={11} className={running ? 'spin' : ''} />{running ? '采样中' : '已暂停'}
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        {inner}
      </div>
    </div>,
    document.body
  )
}
