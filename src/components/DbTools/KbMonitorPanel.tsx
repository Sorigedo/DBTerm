// KB3.3 — 金仓 KingBase 专属监控（sys_* 视图 + KES 版本/授权/兼容模式概览）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Info, AlertTriangle, Database, Activity, Shield } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface KesInfo {
  versionStr: string
  compatMode: string
  encoding: string
  maxConns: number
  currentConns: number
  dbSize: string
  uptime: string
  licenseInfo: string
}

interface DbStat {
  datname: string
  numBackends: number
  xactCommit: number
  xactRollback: number
  blksRead: number
  blksHit: number
  hitRate: string
  deadlocks: number
  tempFiles: number
}

interface ActiveConn {
  pid: number
  usename: string
  application: string
  state: string
  waitEvent: string
  duration: string
  query: string
}

export default function KbMonitorPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [kesInfo, setKesInfo] = useState<KesInfo | null>(null)
  const [dbStats, setDbStats] = useState<DbStat[]>([])
  const [activeConns, setActiveConns] = useState<ActiveConn[]>([])
  const [tab, setTab] = useState<'overview' | 'stats' | 'sessions'>('overview')

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

  const tryQ = async (primary: string, fallback: string) => {
    try { return await q(primary) } catch { return await q(fallback) }
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      // 版本/兼容模式
      const verRes = await q(`SELECT version()`)
      const versionStr = String(verRes.rows[0]?.[0] ?? '')

      // 兼容模式检测（金仓特有配置项）
      let compatMode = 'PostgreSQL 原生模式'
      try {
        const cmRes = await q(`SHOW enable_oracle_compatible_syntax`)
        const cmVal = String(cmRes.rows[0]?.[0] ?? '')
        if (cmVal === 'on' || cmVal === 'true') compatMode = 'Oracle 兼容模式'
      } catch {
        // 不支持此 GUC 则保留默认值
      }

      // 编码
      const encRes = await q(`SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()`)
      const encoding = String(encRes.rows[0]?.[0] ?? '—')

      // 连接数
      const connRes = await q(`SELECT setting::int FROM pg_settings WHERE name = 'max_connections'`)
      const maxConns = parseInt(String(connRes.rows[0]?.[0] ?? '0'), 10)
      const curConnRes = await q(`SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL`)
      const currentConns = parseInt(String(curConnRes.rows[0]?.[0] ?? '0'), 10)

      // 数据库大小（优先用 sys_database_size，降级 pg_database_size）
      const sizeRes = await tryQ(
        `SELECT sys_size_pretty(sys_database_size(current_database()))`,
        `SELECT pg_size_pretty(pg_database_size(current_database()))`,
      )
      const dbSize = String(sizeRes.rows[0]?.[0] ?? '—')

      // 启动时间
      let uptime = '—'
      try {
        const uptRes = await q(`SELECT now() - pg_postmaster_start_time()`)
        const raw = String(uptRes.rows[0]?.[0] ?? '')
        uptime = raw.split('.')[0] ?? raw
      } catch { /* ignore */ }

      // 授权信息（金仓可能有 sys_license 视图，降级处理）
      let licenseInfo = '—'
      try {
        const licRes = await q(`SELECT * FROM sys_license LIMIT 1`)
        licenseInfo = licRes.rows[0]?.join(' | ') ?? '已授权'
      } catch {
        licenseInfo = '（该实例未暴露授权视图）'
      }

      setKesInfo({ versionStr, compatMode, encoding, maxConns, currentConns, dbSize, uptime, licenseInfo })

      // 数据库统计（优先 sys_stat_database，降级 pg_stat_database）
      const statRes = await tryQ(
        `SELECT datname,
          numbackends,
          xact_commit,
          xact_rollback,
          blks_read,
          blks_hit,
          CASE WHEN (blks_read + blks_hit) > 0
            THEN round(blks_hit::numeric * 100 / (blks_read + blks_hit), 2)::text || '%'
            ELSE '—' END AS hit_rate,
          deadlocks,
          temp_files
         FROM sys_stat_database
         WHERE datname NOT IN ('template0','template1')
         ORDER BY xact_commit DESC
         LIMIT 20`,
        `SELECT datname,
          numbackends,
          xact_commit,
          xact_rollback,
          blks_read,
          blks_hit,
          CASE WHEN (blks_read + blks_hit) > 0
            THEN round(blks_hit::numeric * 100 / (blks_read + blks_hit), 2)::text || '%'
            ELSE '—' END AS hit_rate,
          deadlocks,
          temp_files
         FROM pg_stat_database
         WHERE datname NOT IN ('template0','template1')
         ORDER BY xact_commit DESC
         LIMIT 20`,
      )
      setDbStats(statRes.rows.map(r => ({
        datname:      String(r[0] ?? ''),
        numBackends:  parseInt(String(r[1] ?? '0'), 10),
        xactCommit:   parseInt(String(r[2] ?? '0'), 10),
        xactRollback: parseInt(String(r[3] ?? '0'), 10),
        blksRead:     parseInt(String(r[4] ?? '0'), 10),
        blksHit:      parseInt(String(r[5] ?? '0'), 10),
        hitRate:      String(r[6] ?? '—'),
        deadlocks:    parseInt(String(r[7] ?? '0'), 10),
        tempFiles:    parseInt(String(r[8] ?? '0'), 10),
      })))

      // 当前活跃连接（优先 sys_stat_activity，降级 pg_stat_activity）
      const sessRes = await tryQ(
        `SELECT pid, usename,
          COALESCE(application_name, '') AS application,
          COALESCE(state, '?') AS state,
          COALESCE(wait_event_type || ':' || wait_event, '') AS wait_event,
          COALESCE(extract(epoch from (now() - query_start))::int::text || 's', '') AS duration,
          LEFT(COALESCE(query,''), 80) AS query
         FROM sys_stat_activity
         WHERE state IS NOT NULL
         ORDER BY query_start DESC NULLS LAST
         LIMIT 50`,
        `SELECT pid, usename,
          COALESCE(application_name, '') AS application,
          COALESCE(state, '?') AS state,
          COALESCE(wait_event_type || ':' || wait_event, '') AS wait_event,
          COALESCE(extract(epoch from (now() - query_start))::int::text || 's', '') AS duration,
          LEFT(COALESCE(query,''), 80) AS query
         FROM pg_stat_activity
         WHERE state IS NOT NULL
         ORDER BY query_start DESC NULLS LAST
         LIMIT 50`,
      )
      setActiveConns(sessRes.rows.map(r => ({
        pid:         parseInt(String(r[0] ?? '0'), 10),
        usename:     String(r[1] ?? ''),
        application: String(r[2] ?? ''),
        state:       String(r[3] ?? ''),
        waitEvent:   String(r[4] ?? ''),
        duration:    String(r[5] ?? ''),
        query:       String(r[6] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const TABS = [
    { key: 'overview' as const, label: '实例概览' },
    { key: 'stats'    as const, label: '数据库统计' },
    { key: 'sessions' as const, label: '当前会话' },
  ]

  const stateColor = (s: string) => {
    if (s === 'active') return '#16a34a'
    if (s === 'idle in transaction') return '#ea580c'
    if (s === 'idle in transaction (aborted)') return '#dc2626'
    return 'var(--text-muted)'
  }

  const inner = (
    <>
        {/* Tabs（嵌入模式把刷新并进本行右侧）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: embedded ? '0 12px' : '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >{t.label}</button>
          ))}
          {embedded && (
            <button onClick={load} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>

            {/* Overview Tab */}
            {tab === 'overview' && kesInfo && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Version / Mode Banner */}
                <div style={{ display: 'flex', gap: 8, padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: 8, alignItems: 'flex-start' }}>
                  <Info size={13} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                    <b>版本：</b>{kesInfo.versionStr}<br />
                    <b>兼容模式：</b>
                    <span style={{
                      marginLeft: 4, fontSize: 11, fontWeight: 700,
                      color: kesInfo.compatMode.includes('Oracle') ? '#ea580c' : 'var(--accent)',
                      background: kesInfo.compatMode.includes('Oracle') ? 'rgba(234,88,12,0.1)' : 'rgba(59,130,246,0.1)',
                      borderRadius: 4, padding: '1px 6px',
                    }}>{kesInfo.compatMode}</span>
                    {kesInfo.compatMode.includes('Oracle') && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--warning)' }}>
                        — Oracle 语法（ROWNUM / DUAL / NVL / 包 / 同义词）可用
                      </span>
                    )}
                  </div>
                </div>

                {/* Stats Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {[
                    { icon: <Activity size={14} color="var(--accent)" />, label: '当前连接数', value: `${kesInfo.currentConns} / ${kesInfo.maxConns}`, note: `${Math.round(kesInfo.currentConns / (kesInfo.maxConns || 1) * 100)}% 使用率` },
                    { icon: <Database size={14} color="var(--accent)" />, label: '数据库大小', value: kesInfo.dbSize, note: '当前连接的数据库' },
                    { icon: <Shield size={14} color="var(--accent)" />, label: '字符编码', value: kesInfo.encoding, note: '数据库编码' },
                  ].map(c => (
                    <div key={c.label} style={{ background: 'var(--surface-2)', borderRadius: 9, padding: 14, border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        {c.icon}
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{c.label}</span>
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{c.value}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{c.note}</div>
                    </div>
                  ))}
                </div>

                {/* Additional Info */}
                <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 14px', fontSize: 12, background: 'var(--surface-2)', borderRadius: 8, padding: 14, border: '1px solid var(--border)' }}>
                  {[
                    ['启动时长', kesInfo.uptime],
                    ['授权信息', kesInfo.licenseInfo],
                  ].map(([k, v]) => (
                    <>
                      <span key={k + '_k'} style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{k}</span>
                      <span key={k + '_v'} style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{v}</span>
                    </>
                  ))}
                </div>

                {/* Oracle Compat Hint */}
                {kesInfo.compatMode.includes('Oracle') && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.06)', border: '1px solid rgba(234,88,12,0.18)', borderRadius: 8 }}>
                    <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                      <b>Oracle 兼容模式已开启。</b>此实例支持部分 Oracle 语法（ROWNUM、DUAL 伪表、NVL 函数、包/同义词等），但并非完整 Oracle 兼容。
                      迁移时请注意：金仓仍基于 PG 内核，不支持 Oracle 专有存储机制（表空间块大小、REDO/UNDO 架构、RAC 等）。
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Stats Tab */}
            {tab === 'stats' && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                  来源：sys_stat_database（降级至 pg_stat_database）· 累计数据自实例启动以来
                </div>
                {dbStats.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>暂无数据</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['数据库', '连接数', '提交', '回滚', '缓存命中率', '死锁', '临时文件'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dbStats.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '7px 10px', fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{row.datname}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{row.numBackends}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{row.xactCommit.toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', color: row.xactRollback > 0 ? '#ea580c' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{row.xactRollback.toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', color: parseFloat(row.hitRate) < 90 ? '#dc2626' : '#16a34a', fontFamily: 'var(--font-mono)' }}>{row.hitRate}</td>
                            <td style={{ padding: '7px 10px', color: row.deadlocks > 0 ? '#dc2626' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{row.deadlocks}</td>
                            <td style={{ padding: '7px 10px', color: row.tempFiles > 0 ? '#ea580c' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{row.tempFiles}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Sessions Tab */}
            {tab === 'sessions' && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                  来源：sys_stat_activity（降级至 pg_stat_activity）· 共 {activeConns.length} 条
                </div>
                {activeConns.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>暂无活跃会话</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['PID', '用户', '应用', '状态', '等待', '时长', '查询（截断）'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeConns.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{row.pid}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text-bright)' }}>{row.usename}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{row.application || '—'}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 600, color: stateColor(row.state), background: `${stateColor(row.state)}18`, borderRadius: 4, padding: '1px 5px' }}>{row.state}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{row.waitEvent || '—'}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{row.duration || '—'}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={row.query}>{row.query || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
        style={{ width: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>金仓 KingBase 监控</span>
          {kesInfo && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>
              {kesInfo.compatMode}
            </span>
          )}
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
