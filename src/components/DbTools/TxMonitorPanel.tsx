import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, GitBranch, RefreshCw, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface TxEntry {
  pid: string
  user: string
  db: string
  startTime: string
  elapsed: number
  state: string
  info: string
  lockWait: boolean
}

function fmtSecs(n: number): string {
  if (n < 60) return `${n}s`
  if (n < 3600) return `${Math.floor(n / 60)}m${n % 60}s`
  return `${Math.floor(n / 3600)}h${Math.floor((n % 3600) / 60)}m`
}

export default function TxMonitorPanel({ connectionId, connType, onClose, embedded }: Props) {
  const [txs, setTxs] = useState<TxEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [killing, setKilling] = useState<string | null>(null)
  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const sql = isPg
        ? `SELECT \
             pid::text, usename, datname, \
             to_char(xact_start, 'YYYY-MM-DD HH24:MI:SS') AS xact_start, \
             EXTRACT(EPOCH FROM (NOW() - xact_start))::int AS elapsed, \
             state, left(query, 200) AS query, \
             wait_event IS NOT NULL AS lock_wait \
           FROM pg_stat_activity \
           WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() \
           ORDER BY elapsed DESC NULLS LAST LIMIT 50`
        : `SELECT \
             trx_mysql_thread_id, \
             (SELECT user FROM information_schema.PROCESSLIST WHERE ID = trx_mysql_thread_id LIMIT 1) AS user, \
             (SELECT db   FROM information_schema.PROCESSLIST WHERE ID = trx_mysql_thread_id LIMIT 1) AS db, \
             DATE_FORMAT(trx_started, '%Y-%m-%d %H:%i:%s') AS trx_started, \
             TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS elapsed, \
             trx_state, \
             LEFT(trx_query, 200) AS trx_query, \
             trx_wait_started IS NOT NULL AS lock_wait \
           FROM information_schema.INNODB_TRX \
           ORDER BY elapsed DESC LIMIT 50`
      const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
        id: connectionId, sql,
      })
      const list: TxEntry[] = res.rows.map(r => ({
        pid:       String(r[0] ?? ''),
        user:      String(r[1] ?? ''),
        db:        String(r[2] ?? ''),
        startTime: String(r[3] ?? ''),
        elapsed:   Number(r[4]) || 0,
        state:     String(r[5] ?? ''),
        info:      String(r[6] ?? ''),
        lockWait:  r[7] === 'true' || r[7] === '1',
      }))
      setTxs(list)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { if (!document.hidden) load() }, 5000)  // 后台不可见暂停
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [autoRefresh])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const killTx = async (pid: string) => {
    if (!window.confirm(`确认 KILL 事务 / 进程 ${pid}？`)) return
    setKilling(pid)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_kill_process', { id: connectionId, processId: Number(pid) })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setKilling(null)
    }
  }

  const inner = (
    <>
        {/* 嵌入模式：顶部紧凑工具行（自动刷新 + 刷新），非嵌入时控件在标题栏 */}
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>长事务标红（超60s）</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              自动刷新 5s
            </label>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          </div>
        )}

        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading && txs.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : txs.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--success)', fontSize: 13 }}>✓ 当前无进行中的事务</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={th}>PID</th>
                  <th style={th}>用户</th>
                  <th style={th}>库</th>
                  <th style={th}>开始时间</th>
                  <th style={{ ...th, textAlign: 'right' }}>耗时</th>
                  <th style={th}>状态</th>
                  <th style={th}>SQL</th>
                  <th style={{ ...th, textAlign: 'center' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {txs.map(t => {
                  const isLong = t.elapsed > 60
                  const isVeryLong = t.elapsed > 300
                  return (
                    <tr key={t.pid} style={{ borderBottom: '1px solid var(--border-subtle)', background: isVeryLong ? 'rgba(220,38,38,0.05)' : isLong ? 'rgba(234,88,12,0.04)' : undefined }}>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{t.pid}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text)' }}>{t.user}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--accent)', fontSize: 11 }}>{t.db}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{t.startTime}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: isVeryLong ? '#dc2626' : isLong ? '#ea580c' : 'var(--text)' }}>
                        {isLong && <AlertTriangle size={10} style={{ marginRight: 3, display: 'inline' }} />}
                        {fmtSecs(t.elapsed)}
                      </td>
                      <td style={{ padding: '7px 10px', fontSize: 11, color: t.lockWait ? '#ea580c' : 'var(--text-muted)' }}>
                        {t.lockWait ? '🔒 锁等待' : t.state}
                      </td>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.info}>
                        {t.info || '—'}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                        <button
                          onClick={() => killTx(t.pid)}
                          disabled={killing === t.pid}
                          style={{ fontSize: 11, color: 'var(--error)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)', fontWeight: 600 }}
                        >
                          {killing === t.pid ? '…' : 'KILL'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（控件已并入顶部工具行）
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
        style={{ width: 860, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitBranch size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>事务监控</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>长事务标红（超60s）</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              自动刷新 5s
            </label>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}

const th: React.CSSProperties = {
  padding: '7px 10px',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
  fontSize: 11,
  whiteSpace: 'nowrap',
}
