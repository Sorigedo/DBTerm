// OG3.3 — openGauss dbe_perf 监控看板（TopSQL / 等待事件 / 内存 / WDR 要点）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Activity, AlertTriangle, Zap, Database, BarChart2 } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface TopSql {
  sqlId: string
  calls: number
  totalElapsed: string
  avgElapsed: string
  rows: number
  sqlText: string
  userName: string
}

interface WaitEvent {
  waitStatus: string
  waitCount: number
  nodeName: string
  threadName: string
}

interface MemContext {
  ctxName: string
  totalSize: string
  freeSize: string
  usedPct: string
}

export default function OgDbePerfPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'topsql' | 'waits' | 'memory' | 'instance'>('topsql')
  const [dbePerfAvail, setDbePerfAvail] = useState(true)
  const [topSqls, setTopSqls] = useState<TopSql[]>([])
  const [waitEvents, setWaitEvents] = useState<WaitEvent[]>([])
  const [memContexts, setMemContexts] = useState<MemContext[]>([])
  const [instanceStats, setInstanceStats] = useState<Record<string, string>>({})

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const q = async (sql: string) => {
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    return invoke<R>('execute_query', { id: connectionId, sql })
  }

  const loadTopSql = async () => {
    // dbe_perf.statement 是 openGauss 的 TopSQL 视图（类似 pg_stat_statements 但更详细）
    const res = await q(`SELECT
        unique_sql_id::text AS sql_id,
        n_calls AS calls,
        n_tuples_returned AS rows,
        round(total_elapse_time / 1000) || 'ms' AS total_elapsed,
        CASE WHEN n_calls > 0 THEN round(total_elapse_time / n_calls / 1000) || 'ms' ELSE '0ms' END AS avg_elapsed,
        left(query, 100) AS sql_text,
        user_name
      FROM dbe_perf.statement
      ORDER BY total_elapse_time DESC
      LIMIT 30`)
    setTopSqls(res.rows.map(r => ({
      sqlId:       String(r[0] ?? ''),
      calls:       parseInt(String(r[1] ?? '0'), 10),
      rows:        parseInt(String(r[2] ?? '0'), 10),
      totalElapsed: String(r[3] ?? ''),
      avgElapsed:  String(r[4] ?? ''),
      sqlText:     String(r[5] ?? ''),
      userName:    String(r[6] ?? ''),
    })))
  }

  const loadWaitEvents = async () => {
    const res = await q(`SELECT
        wait_status,
        count(*) AS wait_count,
        node_name,
        thread_name
      FROM dbe_perf.wait_events
      GROUP BY wait_status, node_name, thread_name
      ORDER BY wait_count DESC
      LIMIT 30`)
    setWaitEvents(res.rows.map(r => ({
      waitStatus: String(r[0] ?? ''),
      waitCount:  parseInt(String(r[1] ?? '0'), 10),
      nodeName:   String(r[2] ?? ''),
      threadName: String(r[3] ?? ''),
    })))
  }

  const loadMemory = async () => {
    const res = await q(`SELECT
        context_name,
        pg_size_pretty(total_size) AS total_size,
        pg_size_pretty(free_size)  AS free_size,
        CASE WHEN total_size > 0
          THEN round((total_size - free_size)::numeric * 100 / total_size, 1)::text || '%'
          ELSE '—' END AS used_pct
      FROM dbe_perf.memory_node_detail
      ORDER BY total_size DESC
      LIMIT 20`)
    setMemContexts(res.rows.map(r => ({
      ctxName:   String(r[0] ?? ''),
      totalSize: String(r[1] ?? ''),
      freeSize:  String(r[2] ?? ''),
      usedPct:   String(r[3] ?? ''),
    })))
  }

  const loadInstance = async () => {
    const res = await q(`SELECT
        stat_name, value
      FROM dbe_perf.instance_time
      ORDER BY stat_name`)
    const stats: Record<string, string> = {}
    for (const row of res.rows) stats[String(row[0] ?? '')] = String(row[1] ?? '')
    setInstanceStats(stats)
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      // 检测 dbe_perf schema 可用性
      try {
        await q(`SELECT 1 FROM dbe_perf.statement LIMIT 0`)
        setDbePerfAvail(true)
      } catch {
        setDbePerfAvail(false)
        return
      }

      if (tab === 'topsql')  await loadTopSql()
      if (tab === 'waits')   await loadWaitEvents()
      if (tab === 'memory')  await loadMemory()
      if (tab === 'instance') await loadInstance()
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [tab])

  const TABS = [
    { key: 'topsql'   as const, label: 'TopSQL', icon: <Zap size={12} /> },
    { key: 'waits'    as const, label: '等待事件', icon: <Activity size={12} /> },
    { key: 'memory'   as const, label: '内存上下文', icon: <Database size={12} /> },
    { key: 'instance' as const, label: '实例时间', icon: <BarChart2 size={12} /> },
  ]

  const inner = (
    <>
        {/* Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >{t.icon}{t.label}</button>
          ))}
          {embedded && (
            <>
              <span style={{
                marginLeft: 'auto',
                fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
                color: dbePerfAvail ? '#16a34a' : '#dc2626',
                background: dbePerfAvail ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
              }}>{dbePerfAvail ? 'dbe_perf 可用' : 'dbe_perf 不可用'}</span>
              <button onClick={load} style={{ marginLeft: 8, color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            </>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {!dbePerfAvail ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, padding: 20, alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={28} color="var(--warning)" />
            <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.8 }}>
              <b style={{ color: 'var(--text-bright)' }}>dbe_perf schema 不可访问</b><br />
              该 schema 为 openGauss 专属性能视图，需要满足以下条件：<br />
              1. 当前实例为 openGauss（非原生 PostgreSQL）<br />
              2. 当前用户具有访问 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>dbe_perf</code> schema 的权限（通常需 monitor admin 角色）<br />
              3. 参数 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>enable_stmt_track</code> 已开启
            </div>
          </div>
        ) : loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>

            {/* TopSQL */}
            {tab === 'topsql' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：dbe_perf.statement · 按总耗时降序 · 前 30 条</div>
                {topSqls.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>暂无数据（可能需要开启 enable_stmt_track）</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['用户', '调用次数', '总耗时', '均耗时', '返回行数', 'SQL（截断）'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {topSqls.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', color: 'var(--text-bright)' }}>{r.userName}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.calls.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{r.totalElapsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.avgElapsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.rows.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={r.sqlText}>{r.sqlText}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Wait Events */}
            {tab === 'waits' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：dbe_perf.wait_events · 当前等待事件分布</div>
                {waitEvents.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>暂无等待事件（实例较空闲）</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['等待状态', '等待计数', '节点', '线程'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {waitEvents.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 5px' }}>{r.waitStatus}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: r.waitCount > 10 ? '#ea580c' : 'var(--text)' }}>{r.waitCount}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{r.nodeName || '—'}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{r.threadName || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Memory */}
            {tab === 'memory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：dbe_perf.memory_node_detail · 按总大小降序 · 前 20 条</div>
                {memContexts.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>暂无数据</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['内存上下文', '总大小', '空闲大小', '使用率'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {memContexts.map((r, i) => {
                          const pct = parseFloat(r.usedPct)
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{r.ctxName}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.totalSize}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.freeSize}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: pct > 90 ? '#dc2626' : pct > 70 ? '#ea580c' : '#16a34a' }}>{r.usedPct}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Instance Time */}
            {tab === 'instance' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：dbe_perf.instance_time · 实例累计时间统计（微秒）</div>
                {Object.keys(instanceStats).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>暂无数据</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                    {Object.entries(instanceStats).map(([k, v]) => (
                      <div key={k} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{k}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{parseInt(v, 10).toLocaleString()} µs</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入子tab行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BarChart2 size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>openGauss dbe_perf 性能看板</span>
          <span style={{
            fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
            color: dbePerfAvail ? '#16a34a' : '#dc2626',
            background: dbePerfAvail ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
          }}>{dbePerfAvail ? 'dbe_perf 可用' : 'dbe_perf 不可用'}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
