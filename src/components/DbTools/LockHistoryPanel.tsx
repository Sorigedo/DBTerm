// MA6.4 — 锁等待 / 死锁历史归档（performance_schema + SHOW ENGINE INNODB STATUS 采样）
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Archive, AlertTriangle, Clock } from 'lucide-react'

interface Props {
  connectionId: string
  connType?: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface LockWaitRow {
  waitingThread: number
  waitingQuery: string
  waitingSecs: number
  blockingThread: number
  blockingQuery: string
  objectSchema: string
  objectName: string
  lockType: string
}

interface DeadlockSnapshot {
  ts: number   // epoch ms, sampling time
  text: string // raw SHOW ENGINE INNODB STATUS snippet
}

const STORAGE_KEY_PREFIX = 'dbterm-deadlock-'

function extractDeadlockSection(statusText: string): string | null {
  const start = statusText.indexOf('LATEST DETECTED DEADLOCK')
  if (start === -1) return null
  const end = statusText.indexOf('\n---\n', start)
  return statusText.slice(start, end === -1 ? start + 4000 : end)
}

export default function LockHistoryPanel({ connectionId, connType, onClose, embedded }: Props) {
  // 锁等待用 performance_schema.data_lock_waits / metadata_locks（MySQL 8.0 引入）；
  //   MariaDB 无此表（仍用 information_schema.INNODB_LOCK_WAITS）。
  // 死锁归档基于 SHOW ENGINE INNODB STATUS 采样：
  //   TiDB / OceanBase 无 InnoDB 引擎，不支持该语句，且 perf_schema.data_lock_waits 也不存在。
  const lockWaitsUnsupported = connType === 'mariadb' || connType === 'tidb' || connType === 'oceanBase'
  const lockWaitsReason = connType === 'mariadb'
    ? 'MariaDB 没有 performance_schema.data_lock_waits 表（该表为 MySQL 8.0 引入）。可改用 information_schema.INNODB_LOCK_WAITS 查看锁等待。'
    : connType === 'tidb'
      ? 'TiDB 无 performance_schema，请改用 information_schema.DATA_LOCK_WAITS / CLUSTER_TIDB_TRX 查看锁等待与事务。'
      : 'OceanBase（MySQL 模式）无 performance_schema.data_lock_waits 表。可改用 gv$ 系列视图查看锁等待。'
  // 死锁采样依赖 SHOW ENGINE INNODB STATUS：MariaDB 支持（仍是 InnoDB），TiDB/OceanBase 不支持。
  const deadlockUnsupported = connType === 'tidb' || connType === 'oceanBase'
  const deadlockReason = connType === 'tidb'
    ? 'TiDB 不支持 SHOW ENGINE INNODB STATUS。可查询 information_schema.DEADLOCKS / CLUSTER_DEADLOCKS 获取死锁信息。'
    : 'OceanBase 不支持 SHOW ENGINE INNODB STATUS（无 InnoDB 引擎）。'
  const [tab, setTab] = useState<'waits' | 'deadlocks'>('waits')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lockWaits, setLockWaits] = useState<LockWaitRow[]>([])
  const [perfNotEnabled, setPerfNotEnabled] = useState(false)
  const [deadlocks, setDeadlocks] = useState<DeadlockSnapshot[]>([])
  const [selectedDl, setSelectedDl] = useState<DeadlockSnapshot | null>(null)
  const [sampling, setSampling] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const storageKey = `${STORAGE_KEY_PREFIX}${connectionId}`

  useEffect(() => {
    // 从 localStorage 加载历史死锁快照
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) setDeadlocks(JSON.parse(raw) as DeadlockSnapshot[])
    } catch { /* ignore */ }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const loadLockWaits = async () => {
    setLoading(true); setError(''); setPerfNotEnabled(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT
          r.THREAD_ID  AS waiting_thread,
          r.SQL_TEXT   AS waiting_query,
          COALESCE(TIMESTAMPDIFF(SECOND, r.TIMER_START / 1000000000000, SYSDATE(6)), 0) AS waiting_secs,
          b.THREAD_ID  AS blocking_thread,
          b.SQL_TEXT   AS blocking_query,
          w.OBJECT_SCHEMA,
          w.OBJECT_NAME,
          w.LOCK_TYPE
        FROM performance_schema.data_lock_waits w
        JOIN performance_schema.events_statements_current r
          ON r.THREAD_ID = w.REQUESTING_ENGINE_LOCK_ID
        JOIN performance_schema.events_statements_current b
          ON b.THREAD_ID = w.BLOCKING_ENGINE_LOCK_ID
        LIMIT 50`,
      })
      setLockWaits(res.rows.map(r => ({
        waitingThread:  Number(r[0] ?? 0),
        waitingQuery:   String(r[1] ?? ''),
        waitingSecs:    Number(r[2] ?? 0),
        blockingThread: Number(r[3] ?? 0),
        blockingQuery:  String(r[4] ?? ''),
        objectSchema:   String(r[5] ?? ''),
        objectName:     String(r[6] ?? ''),
        lockType:       String(r[7] ?? ''),
      })))
    } catch (e) {
      const msg = String(e)
      if (msg.includes("doesn't exist") || msg.includes('performance_schema')) setPerfNotEnabled(true)
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const sampleDeadlock = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: 'SHOW ENGINE INNODB STATUS',
      })
      const text = String(res.rows[0]?.[2] ?? res.rows[0]?.[1] ?? '')
      const section = extractDeadlockSection(text)
      if (!section) return
      setDeadlocks(prev => {
        // 去重：若快照文本与最近一条相同则不保存
        if (prev.length > 0 && prev[0].text === section) return prev
        const updated = [{ ts: Date.now(), text: section }, ...prev].slice(0, 20)
        try { localStorage.setItem(storageKey, JSON.stringify(updated)) } catch { /* ignore */ }
        return updated
      })
    } catch { /* 非 InnoDB 或权限不足，静默忽略 */ }
  }

  const toggleSampling = () => {
    if (sampling) {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      setSampling(false)
    } else {
      sampleDeadlock()
      timerRef.current = setInterval(sampleDeadlock, 30_000)
      setSampling(true)
    }
  }

  const clearHistory = () => {
    if (!window.confirm('确认清空所有死锁历史快照？')) return
    setDeadlocks([])
    setSelectedDl(null)
    localStorage.removeItem(storageKey)
  }

  useEffect(() => {
    if (tab === 'waits' && !lockWaitsUnsupported) loadLockWaits()
  }, [tab, lockWaitsUnsupported])

  const inner = (
    <>
        {/* Tab（嵌入模式把刷新并进本行右侧，省去单独标题栏）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {([['waits', '当前锁等待'], ['deadlocks', '死锁历史归档']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>{label}</button>
          ))}
          {embedded && tab === 'waits' && (
            <button onClick={loadLockWaits} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
          {error && (
            <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>
          )}

          {tab === 'waits' && (
            lockWaitsUnsupported ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <AlertTriangle size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block', color: 'var(--warning)' }} />
                当前数据库类型不支持此锁等待视图<br />
                <span style={{ fontSize: 11, marginTop: 8, display: 'block', lineHeight: 1.6 }}>{lockWaitsReason}</span>
              </div>
            ) : loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
            ) : perfNotEnabled ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <AlertTriangle size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block', color: 'var(--warning)' }} />
                performance_schema 未开启或权限不足<br />
                <span style={{ fontSize: 11, marginTop: 8, display: 'block' }}>检查 performance_schema=ON；需要 PROCESS 权限</span>
              </div>
            ) : lockWaits.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>当前无锁等待</div>
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['等待线程', '等待查询', '等待时长', '阻塞线程', '阻塞查询', '对象', '锁类型'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lockWaits.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.waitingThread}</td>
                        <td style={{ padding: '6px 10px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={r.waitingQuery}>{r.waitingQuery || '—'}</td>
                        <td style={{ padding: '6px 10px', color: r.waitingSecs > 10 ? '#dc2626' : 'var(--text)', fontWeight: r.waitingSecs > 10 ? 600 : 400 }}>{r.waitingSecs}s</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--warning)' }}>{r.blockingThread}</td>
                        <td style={{ padding: '6px 10px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={r.blockingQuery}>{r.blockingQuery || '—'}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.objectSchema}.{r.objectName}</td>
                        <td style={{ padding: '6px 10px', fontSize: 10, color: r.lockType === 'EXCLUSIVE' ? '#dc2626' : 'var(--text-muted)' }}>{r.lockType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === 'deadlocks' && deadlockUnsupported && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <AlertTriangle size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block', color: 'var(--warning)' }} />
              当前数据库类型不支持死锁采样<br />
              <span style={{ fontSize: 11, marginTop: 8, display: 'block', lineHeight: 1.6 }}>{deadlockReason}</span>
            </div>
          )}
          {tab === 'deadlocks' && !deadlockUnsupported && (
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* 左侧：快照列表 */}
              <div style={{ width: 220, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={toggleSampling}
                    style={{ flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 600,
                      background: sampling ? '#dc2626' : 'var(--accent)', color: '#fff', border: 'none' }}
                  >
                    <Clock size={10} style={{ display: 'inline', marginRight: 4 }} />
                    {sampling ? '停止采样' : '开始采样(30s)'}
                  </button>
                  {deadlocks.length > 0 && (
                    <button onClick={clearHistory} style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>清空</button>
                  )}
                </div>
                <div style={{ flex: 1, overflow: 'auto' }}>
                  {deadlocks.length === 0 ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                      点击"开始采样"检测并记录死锁快照
                    </div>
                  ) : deadlocks.map((dl, i) => (
                    <button
                      key={dl.ts}
                      onClick={() => setSelectedDl(dl)}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 12px',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: selectedDl?.ts === dl.ts ? 'var(--surface-hover)' : 'transparent',
                        color: 'var(--text)',
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--error)', marginBottom: 2 }}>死锁 #{deadlocks.length - i}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(dl.ts).toLocaleString()}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 右侧：死锁内容 */}
              <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
                {selectedDl ? (
                  <pre style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, lineHeight: 1.6,
                  }}>{selectedDl.text}</pre>
                ) : (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                    选择左侧快照查看死锁详情
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
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
        style={{ width: 860, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Archive size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>锁等待 / 死锁历史</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {tab === 'waits' && (
              <button onClick={loadLockWaits} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            )}
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
