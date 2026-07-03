import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Lock, RefreshCw, AlertTriangle, Zap, Info } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

interface LockRow {
  waitingPid:    number
  waitingSql:    string
  waitingSecs:   number
  blockingPid:   number
  blockingSql:   string
  blockingSecs:  number
  lockType:      string
  lockTable:     string
}

interface MetaLockRow {
  threadId:     string
  objectType:   string
  objectSchema: string
  objectName:   string
  lockType:     string
  lockDuration: string
}

export default function LockAnalysisPanel({ connectionId, connType, onClose }: Props) {
  const [locks, setLocks] = useState<LockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [killing, setKilling] = useState<number | null>(null)
  const [killMsg, setKillMsg] = useState('')
  // MariaDB 元数据锁
  const [metaLocks, setMetaLocks] = useState<MetaLockRow[]>([])
  const [metaLockErr, setMetaLockErr] = useState<'plugin_missing' | 'error' | null>(null)

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isMaria = connType === 'mariadb'

  const loadMetaLocks = async () => {
    if (!isMaria) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
        id: connectionId,
        sql: `SELECT THREAD_ID, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME, LOCK_TYPE, LOCK_DURATION FROM information_schema.METADATA_LOCK_INFO LIMIT 50`,
      })
      setMetaLocks(res.rows.map(r => ({
        threadId:     String(r[0] ?? ''),
        objectType:   String(r[1] ?? ''),
        objectSchema: String(r[2] ?? ''),
        objectName:   String(r[3] ?? ''),
        lockType:     String(r[4] ?? ''),
        lockDuration: String(r[5] ?? ''),
      })))
      setMetaLockErr(null)
    } catch (e) {
      const msg = String(e)
      setMetaLockErr(msg.toLowerCase().includes('table') && msg.toLowerCase().includes('exist') ? 'plugin_missing' : 'error')
    }
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // PG5.3: 使用 pg_blocking_pids()（PG9.6+），比 pg_locks join 更准确
      const sql = isPg
        ? `SELECT \
             a.pid AS waiting_pid, \
             a.query AS waiting_sql, \
             COALESCE(EXTRACT(EPOCH FROM (NOW() - a.query_start))::int, 0) AS waiting_secs, \
             unnest(pg_blocking_pids(a.pid)) AS blocking_pid, \
             b.query AS blocking_sql, \
             COALESCE(EXTRACT(EPOCH FROM (NOW() - b.query_start))::int, 0) AS blocking_secs, \
             COALESCE(l.locktype, 'unknown') AS lock_type, \
             COALESCE(l.relation::regclass::text, '—') AS lock_table \
           FROM pg_stat_activity a \
           LEFT JOIN pg_stat_activity b ON b.pid = ANY(pg_blocking_pids(a.pid)) \
           LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted \
           WHERE cardinality(pg_blocking_pids(a.pid)) > 0 \
             AND a.pid <> pg_backend_pid() \
           LIMIT 50`
        : `SELECT \
             r.trx_mysql_thread_id AS waiting_pid, \
             r.trx_query AS waiting_sql, \
             TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS waiting_secs, \
             b.trx_mysql_thread_id AS blocking_pid, \
             b.trx_query AS blocking_sql, \
             TIMESTAMPDIFF(SECOND, b.trx_started, NOW()) AS blocking_secs, \
             lw.lock_type AS lock_type, \
             lw.lock_table AS lock_table \
           FROM information_schema.INNODB_TRX r \
           JOIN information_schema.INNODB_LOCK_WAITS lw ON lw.requesting_trx_id = r.trx_id \
           JOIN information_schema.INNODB_LOCKS lw2 ON lw2.lock_id = lw.blocking_lock_id \
           JOIN information_schema.INNODB_TRX b ON b.trx_id = lw.blocking_trx_id \
           LIMIT 50`
      const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
        id: connectionId, sql,
      })
      const rows: LockRow[] = res.rows.map(r => ({
        waitingPid:   Number(r[0]) || 0,
        waitingSql:   r[1] || '',
        waitingSecs:  Number(r[2]) || 0,
        blockingPid:  Number(r[3]) || 0,
        blockingSql:  r[4] || '',
        blockingSecs: Number(r[5]) || 0,
        lockType:     r[6] || '',
        lockTable:    r[7] || '',
      }))
      setLocks(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(); loadMetaLocks() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const killProcess = async (pid: number) => {
    if (!window.confirm(`确认 KILL 进程 ${pid}（阻塞方）？`)) return
    setKilling(pid)
    setKillMsg('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_kill_process', { id: connectionId, processId: pid })
      setKillMsg(`进程 ${pid} 已终止`)
      await load()
    } catch (e) {
      setKillMsg(`KILL 失败: ${e}`)
    } finally {
      setKilling(null)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Lock size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>锁与阻塞分析</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>
            {isPg ? '来源: pg_locks + pg_stat_activity' : isMaria ? '来源: INNODB_TRX + METADATA_LOCK_INFO' : '来源: INNODB_TRX / INNODB_LOCK_WAITS'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => { load(); loadMetaLocks() }} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {killMsg && (
          <div style={{ padding: '7px 16px', fontSize: 12, color: killMsg.includes('失败') ? '#dc2626' : '#16a34a', background: killMsg.includes('失败') ? 'rgba(220,38,38,0.07)' : 'rgba(22,163,74,0.07)', flexShrink: 0 }}>
            {killMsg}
          </div>
        )}
        {error && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', flexShrink: 0 }}>{error}</div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>分析中…</div>
          ) : locks.length === 0 && !error ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ color: 'var(--success)', fontSize: 13, marginBottom: 6 }}>✓ 当前无锁等待</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>数据库运行正常，无阻塞事务</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {locks.map((lk, i) => (
                <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '12px 16px', background: i % 2 === 0 ? undefined : 'rgba(0,0,0,0.02)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', background: 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '2px 7px' }}>
                      <AlertTriangle size={10} style={{ display: 'inline', marginRight: 3 }} />
                      锁等待
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>锁类型: {lk.lockType || '—'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>锁表: {lk.lockTable || '—'}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'start' }}>
                    {/* Waiting side */}
                    <div style={{ background: 'rgba(234,88,12,0.05)', borderRadius: 8, padding: '10px 12px', border: '1px solid rgba(234,88,12,0.2)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', marginBottom: 6 }}>
                        等待方 PID {lk.waitingPid} · {lk.waitingSecs}s
                      </div>
                      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 80, overflow: 'hidden' }}>
                        {lk.waitingSql || '(无 SQL 信息)'}
                      </pre>
                    </div>

                    {/* Arrow */}
                    <div style={{ display: 'flex', alignItems: 'center', paddingTop: 20 }}>
                      <Zap size={16} color="var(--text-muted)" />
                    </div>

                    {/* Blocking side */}
                    <div style={{ background: 'rgba(220,38,38,0.05)', borderRadius: 8, padding: '10px 12px', border: '1px solid rgba(220,38,38,0.2)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--error)' }}>
                          阻塞方 PID {lk.blockingPid} · {lk.blockingSecs}s
                        </span>
                        <button
                          onClick={() => killProcess(lk.blockingPid)}
                          disabled={killing === lk.blockingPid}
                          style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--error)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)', fontWeight: 600 }}
                        >
                          {killing === lk.blockingPid ? '…' : 'KILL'}
                        </button>
                      </div>
                      <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 80, overflow: 'hidden' }}>
                        {lk.blockingSql || '(无 SQL 信息)'}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        {/* MariaDB 元数据锁（metadata_lock_info 插件） */}
        {isMaria && (
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--surface-2)' }}>
              <Info size={12} color="var(--accent)" />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>元数据锁（MDL）</span>
              {metaLockErr === 'plugin_missing' && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                  {'插件未启用 — 执行 INSTALL SONAME \'metadata_lock_info\' 后刷新'}
                </span>
              )}
              {metaLockErr === 'error' && (
                <span style={{ fontSize: 11, color: 'var(--error)', marginLeft: 4 }}>查询失败</span>
              )}
              {!metaLockErr && metaLocks.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 4 }}>✓ 无元数据锁</span>
              )}
              {!metaLockErr && metaLocks.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--warning)', marginLeft: 4 }}>{metaLocks.length} 个元数据锁</span>
              )}
            </div>
            {!metaLockErr && metaLocks.length > 0 && (
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['线程ID', '对象类型', 'Schema', '对象名', '锁类型', '持续时长'].map(h => (
                        <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metaLocks.map((ml, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{ml.threadId}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text)' }}>{ml.objectType}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--accent)' }}>{ml.objectSchema}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{ml.objectName}</td>
                        <td style={{ padding: '5px 10px' }}>
                          <span style={{
                            background: ml.lockType.includes('EXCLUSIVE') ? 'rgba(220,38,38,0.1)' : 'rgba(99,102,241,0.1)',
                            color: ml.lockType.includes('EXCLUSIVE') ? '#dc2626' : 'var(--accent)',
                            borderRadius: 3, padding: '1px 6px', fontWeight: 600, fontSize: 10,
                          }}>{ml.lockType}</span>
                        </td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{ml.lockDuration}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body
  )
}
