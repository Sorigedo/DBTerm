// PG6.4 — PgBouncer 连接池深度监控
// 当连接走 PgBouncer 时自动可用，通过连接到 pgbouncer 管理库读取
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, AlertTriangle, Zap } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'pools' | 'clients' | 'servers' | 'stats' | 'config'

interface PoolRow {
  database: string
  user: string
  clActive: number
  clWaiting: number
  svActive: number
  svIdle: number
  svUsed: number
  svTested: number
  svLogin: number
  maxwait: number
  poolMode: string
}

interface ClientRow {
  type: string
  user: string
  database: string
  state: string
  addr: string
  port: string
  localAddr: string
  localPort: string
  waitTime: number
  age: number
}

interface ServerRow {
  type: string
  user: string
  database: string
  state: string
  addr: string
  port: string
  localAddr: string
  localPort: string
  linkPtr: string
  age: number
}

interface StatsRow {
  database: string
  totalRequests: number
  totalReceived: number
  totalSent: number
  totalQueryTime: number
  avgReqTime: number
}

interface ConfigRow {
  key: string
  value: string
  changeable: string
}

export default function PgBouncerPanel({ connectionId, onClose, embedded }: Props) {
  const [tab, setTab] = useState<Tab>('pools')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isBouncerConn, setIsBouncerConn] = useState<boolean | null>(null)
  const [poolMode, setPoolMode] = useState('')

  const [pools, setPools]     = useState<PoolRow[]>([])
  const [clients, setClients] = useState<ClientRow[]>([])
  const [servers, setServers] = useState<ServerRow[]>([])
  const [stats, setStats]     = useState<StatsRow[]>([])
  const [configs, setConfigs] = useState<ConfigRow[]>([])

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

  const detectBouncer = async (): Promise<boolean> => {
    try {
      await q('SHOW POOLS')
      return true
    } catch {
      return false
    }
  }

  const loadPools = async () => {
    setLoading(true); setError('')
    try {
      const res = await q('SHOW POOLS')
      setPools(res.rows.map(r => ({
        database:   String(r[0] ?? ''),
        user:       String(r[1] ?? ''),
        clActive:   Number(r[2] ?? 0),
        clWaiting:  Number(r[3] ?? 0),
        svActive:   Number(r[4] ?? 0),
        svIdle:     Number(r[5] ?? 0),
        svUsed:     Number(r[6] ?? 0),
        svTested:   Number(r[7] ?? 0),
        svLogin:    Number(r[8] ?? 0),
        maxwait:    Number(r[9] ?? 0),
        poolMode:   String(r[10] ?? ''),
      })))
      if (res.rows.length > 0) setPoolMode(String(res.rows[0]?.[10] ?? ''))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadClients = async () => {
    setLoading(true); setError('')
    try {
      const res = await q('SHOW CLIENTS')
      setClients(res.rows.map(r => ({
        type:      String(r[0] ?? ''),
        user:      String(r[1] ?? ''),
        database:  String(r[2] ?? ''),
        state:     String(r[3] ?? ''),
        addr:      String(r[4] ?? ''),
        port:      String(r[5] ?? ''),
        localAddr: String(r[6] ?? ''),
        localPort: String(r[7] ?? ''),
        waitTime:  Number(r[8] ?? 0),
        age:       Number(r[9] ?? 0),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadServers = async () => {
    setLoading(true); setError('')
    try {
      const res = await q('SHOW SERVERS')
      setServers(res.rows.map(r => ({
        type:      String(r[0] ?? ''),
        user:      String(r[1] ?? ''),
        database:  String(r[2] ?? ''),
        state:     String(r[3] ?? ''),
        addr:      String(r[4] ?? ''),
        port:      String(r[5] ?? ''),
        localAddr: String(r[6] ?? ''),
        localPort: String(r[7] ?? ''),
        linkPtr:   String(r[8] ?? ''),
        age:       Number(r[9] ?? 0),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadStats = async () => {
    setLoading(true); setError('')
    try {
      const res = await q('SHOW STATS')
      // SHOW STATS 列名/列序随 PgBouncer 版本变化（老版 total_requests/avg_req，
      // 新版 total_query_count/avg_query_count + total_xact_count 等），按列名取值更稳。
      const idx = (...names: string[]) => {
        for (const n of names) {
          const i = res.columns.findIndex(c => c.toLowerCase() === n)
          if (i >= 0) return i
        }
        return -1
      }
      const at = (r: (string | null)[], i: number) => i >= 0 ? Number(r[i] ?? 0) : 0
      const iReq  = idx('total_query_count', 'total_requests')
      const iRecv = idx('total_received')
      const iSent = idx('total_sent')
      const iQt   = idx('total_query_time')
      const iAvg  = idx('avg_query_time', 'avg_req')
      setStats(res.rows.map(r => ({
        database:       String(r[0] ?? ''),
        totalRequests:  at(r, iReq),
        totalReceived:  at(r, iRecv),
        totalSent:      at(r, iSent),
        totalQueryTime: at(r, iQt),
        avgReqTime:     at(r, iAvg),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadConfig = async () => {
    setLoading(true); setError('')
    try {
      const res = await q('SHOW CONFIG')
      setConfigs(res.rows.map(r => ({
        key:        String(r[0] ?? ''),
        value:      String(r[1] ?? ''),
        changeable: String(r[2] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadTab = (t: Tab) => {
    if (t === 'pools')   loadPools()
    else if (t === 'clients') loadClients()
    else if (t === 'servers') loadServers()
    else if (t === 'stats')   loadStats()
    else if (t === 'config')  loadConfig()
  }

  useEffect(() => {
    ;(async () => {
      const isBouncer = await detectBouncer()
      setIsBouncerConn(isBouncer)
      if (isBouncer) loadPools()
    })()
  }, [])

  useEffect(() => {
    if (isBouncerConn) loadTab(tab)
  }, [tab])

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pools',   label: '连接池（POOLS）' },
    { key: 'clients', label: '客户端（CLIENTS）' },
    { key: 'servers', label: '后端（SERVERS）' },
    { key: 'stats',   label: '统计（STATS）' },
    { key: 'config',  label: '配置（CONFIG）' },
  ]

  const stateColor = (s: string) => s === 'active' ? '#16a34a' : s === 'idle' ? 'var(--text-muted)' : '#ea580c'

  const inner = (
    <>
        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {isBouncerConn === null ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>检测 PgBouncer 中…</div>
        ) : isBouncerConn === false ? (
          <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
            <div style={{ display: 'flex', gap: 8, padding: '12px 14px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
              <AlertTriangle size={14} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: 'var(--warning)', lineHeight: 1.7 }}>
                <b>当前连接不是 PgBouncer 管理连接。</b><br />
                PgBouncer 监控需要连接到 PgBouncer 的管理数据库（通常名为 <code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 4px' }}>pgbouncer</code>），
                默认监听端口 6432，需要超级用户权限。
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              <b>连接方式：</b>新建一个连接，主机填 PgBouncer 地址，端口填 6432，数据库填 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px' }}>pgbouncer</code>，
              用户需在 PgBouncer 的 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px' }}>admin_users</code> 中配置。
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              常用 PgBouncer 管理命令：<br />
              <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '2px 6px', display: 'inline-block', marginTop: 4 }}>SHOW POOLS; SHOW CLIENTS; SHOW SERVERS; SHOW STATS; SHOW CONFIG;</code>
            </div>
          </div>
        ) : (
          <>
            {/* Tabs（嵌入模式把刷新并进本行右侧）*/}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
              {TABS.map(({ key, label }) => (
                <button key={key} onClick={() => setTab(key)} style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 12,
                  background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
                  color: tab === key ? '#fff' : 'var(--text-muted)',
                  border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
                  fontWeight: tab === key ? 600 : 400,
                }}>{label}</button>
              ))}
              {embedded && (
                <button onClick={() => loadTab(tab)} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
                  <RefreshCw size={13} className={loading ? 'spin' : ''} />
                </button>
              )}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
              ) : (
                <>
                  {/* POOLS */}
                  {tab === 'pools' && (
                    <>
                      {pools.some(p => p.clWaiting > 0) && (
                        <div style={{ marginBottom: 12, display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
                          <AlertTriangle size={13} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                          <span style={{ fontSize: 12, color: 'var(--error)' }}>有连接正在等待（cl_waiting &gt; 0），连接池可能已饱和！</span>
                        </div>
                      )}
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                          <tr>
                            {['数据库', '用户', '客户端活跃', '客户端等待', '后端活跃', '后端空闲', 'maxwait(s)', '模式'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pools.map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: p.clWaiting > 0 ? 'rgba(220,38,38,0.04)' : '' }}>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-bright)' }}>{p.database}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{p.user}</td>
                              <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{p.clActive}</td>
                              <td style={{ padding: '6px 10px', textAlign: 'right', color: p.clWaiting > 0 ? '#dc2626' : 'var(--text-muted)', fontWeight: p.clWaiting > 0 ? 700 : 400 }}>{p.clWaiting}</td>
                              <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{p.svActive}</td>
                              <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{p.svIdle}</td>
                              <td style={{ padding: '6px 10px', textAlign: 'right', color: p.maxwait > 5 ? '#ea580c' : 'var(--text-muted)', fontWeight: p.maxwait > 5 ? 600 : 400 }}>{p.maxwait}</td>
                              <td style={{ padding: '6px 10px' }}>
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--accent)', fontWeight: 600 }}>{p.poolMode}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  {/* CLIENTS */}
                  {tab === 'clients' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['用户', '数据库', '状态', '地址', '等待(s)', '年龄(s)'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {clients.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{c.user}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{c.database}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 11, color: stateColor(c.state), fontWeight: 600 }}>{c.state}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{c.addr}:{c.port}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: c.waitTime > 1 ? '#ea580c' : 'var(--text-muted)' }}>{c.waitTime}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{c.age}</td>
                          </tr>
                        ))}
                        {clients.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无客户端</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {/* SERVERS */}
                  {tab === 'servers' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['用户', '数据库', '状态', '地址', '年龄(s)'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {servers.map((s, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{s.user}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.database}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 11, color: stateColor(s.state), fontWeight: 600 }}>{s.state}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11 }}>{s.addr}:{s.port}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{s.age}</td>
                          </tr>
                        ))}
                        {servers.length === 0 && <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无后端连接</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {/* STATS */}
                  {tab === 'stats' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['数据库', '总请求', '接收字节', '发送字节', '总查询时间(μs)', '平均请求时间(μs)'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.map((s, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-bright)' }}>{s.database}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{s.totalRequests.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{(s.totalReceived / 1024).toFixed(1)} KB</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{(s.totalSent / 1024).toFixed(1)} KB</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{s.totalQueryTime.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', color: s.avgReqTime > 100000 ? '#ea580c' : 'var(--text-muted)' }}>{s.avgReqTime.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* CONFIG */}
                  {tab === 'config' && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['配置项', '当前值', '可热更改'].map(h => (
                            <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {configs.map((c, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 500 }}>{c.key}</td>
                            <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>
                              {c.key.toLowerCase().includes('password') ? '***' : c.value}
                            </td>
                            <td style={{ padding: '6px 12px' }}>
                              <span style={{ fontSize: 11, color: c.changeable === 'yes' ? '#16a34a' : 'var(--text-muted)', fontWeight: 500 }}>{c.changeable}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          </>
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
        style={{ width: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Zap size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>PgBouncer 连接池监控</span>
          {poolMode && (
            <span style={{ fontSize: 11, background: 'var(--accent-bg)', color: 'var(--accent)', borderRadius: 4, padding: '1px 6px' }}>
              {poolMode} mode
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => loadTab(tab)} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
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
