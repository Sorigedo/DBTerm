import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Activity, RefreshCw, StopCircle, Search, Zap, AlertTriangle } from 'lucide-react'
import type { ConnType } from '../../types'

interface Props {
  connectionId: string
  connType?: ConnType
  onClose: () => void
}

interface ProcessEntry {
  processId: number
  user: string
  host: string
  database: string
  command: string
  timeSecs: number
  state: string
  info: string | null
}

function formatTime(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

export default function ProcessListPanel({ connectionId, connType, onClose }: Props) {
  const isMaria = connType === 'mariadb'
  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType ?? '')
  const [processes, setProcesses] = useState<ProcessEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [killing, setKilling] = useState<number | null>(null)
  const [killResult, setKillResult] = useState<{ id: number; ok: boolean; msg: string } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // MariaDB: SHOW EXPLAIN FOR <thread_id>
  const [showExplain, setShowExplain] = useState<{ pid: number; text: string } | null>(null)
  const [explainLoading, setExplainLoading] = useState<number | null>(null)

  const load = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<ProcessEntry[]>('db_process_list', { id: connectionId })
      setProcesses(list)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (autoRefresh) timerRef.current = setInterval(() => { if (!document.hidden) load() }, 3000)  // 后台不可见暂停
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [autoRefresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const kill = async (pid: number) => {
    setKilling(pid)
    setKillResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_kill_process', { id: connectionId, processId: pid })
      setKillResult({ id: pid, ok: true, msg: `已取消进程 ${pid} 的查询（pg_cancel_backend）` })
      setTimeout(load, 500)
    } catch (e) {
      setKillResult({ id: pid, ok: false, msg: String(e) })
    } finally {
      setKilling(null)
    }
  }

  const terminate = async (pid: number) => {
    if (!window.confirm(
      `确认强制终止进程 ${pid}？\n\n` +
      `pg_terminate_backend 会立即断开该连接，所有未提交事务将被回滚。\n` +
      `请先尝试 pg_cancel_backend（取消）——它更安全。`
    )) return
    setKilling(pid)
    setKillResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_terminate_process', { id: connectionId, processId: pid })
      setKillResult({ id: pid, ok: true, msg: `进程 ${pid} 已强制终止（pg_terminate_backend）` })
      setTimeout(load, 500)
    } catch (e) {
      setKillResult({ id: pid, ok: false, msg: String(e) })
    } finally {
      setKilling(null)
    }
  }

  const doShowExplain = async (pid: number) => {
    setExplainLoading(pid)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SHOW EXPLAIN FOR ${pid}`,
      })
      const text = res.rows.map(r => r.join('\t')).join('\n')
      const header = res.columns.join('\t')
      setShowExplain({ pid, text: header + '\n' + text })
    } catch (e) {
      setShowExplain({ pid, text: `错误：${String(e)}` })
    } finally {
      setExplainLoading(null)
    }
  }

  const q = filter.toLowerCase()
  const shown = processes.filter(p =>
    !q || p.user.toLowerCase().includes(q) || p.database.toLowerCase().includes(q) ||
    (p.info ?? '').toLowerCase().includes(q) || p.command.toLowerCase().includes(q)
  )

  const idleInTx = isPg ? processes.filter(p => p.state === 'idle in transaction') : []

  const rowBg = (p: ProcessEntry) => {
    if (isPg && p.state === 'idle in transaction') return 'rgba(220,38,38,0.06)'
    if (p.timeSecs > 30) return 'rgba(234,88,12,0.04)'
    return undefined
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 980, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Activity size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>会话管理</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{processes.length} 个进程</span>
          {isPg && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--accent-bg)', color: 'var(--accent)' }}>pg_stat_activity</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              自动刷新 (3s)
            </label>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }} title="刷新">
              <RefreshCw size={14} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* PG5.1: idle in transaction 告警 */}
        {isPg && idleInTx.length > 0 && (
          <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', borderBottom: '1px solid rgba(220,38,38,0.2)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <AlertTriangle size={13} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--error)' }}>
              存在 <strong>{idleInTx.length}</strong> 个 <code style={{ background: 'rgba(220,38,38,0.12)', padding: '1px 4px', borderRadius: 3 }}>idle in transaction</code> 会话！
              这类会话持有事务锁，会阻塞 VACUUM 和其他写操作。建议检查后 Cancel 或 Terminate。
            </span>
          </div>
        )}

        {/* 搜索栏 */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="搜索用户、数据库、SQL…"
              style={{ width: '100%', padding: '6px 10px 6px 28px', fontSize: 12 }}
            />
          </div>
        </div>

        {/* 结果提示 */}
        {killResult && (
          <div style={{
            padding: '8px 16px', fontSize: 12, flexShrink: 0,
            background: killResult.ok ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
            color: killResult.ok ? '#16a34a' : '#dc2626',
          }}>
            {killResult.msg}
          </div>
        )}

        {/* 错误 */}
        {error && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'rgba(220,38,38,0.08)', flexShrink: 0 }}>
            {error}
          </div>
        )}

        {/* 表格 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {processes.length === 0 ? '无活跃进程' : '无匹配结果'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  {['ID', '用户', '主机', '数据库', '状态', '耗时', ...(isPg ? ['等待事件'] : ['命令']), 'SQL', '操作'].map(h => (
                    <th key={h} style={{
                      padding: '8px 10px', textAlign: 'left', fontWeight: 600,
                      color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map(p => (
                  <tr
                    key={p.processId}
                    style={{ borderBottom: '1px solid var(--border-subtle)', background: rowBg(p) }}
                  >
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{p.processId}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-bright)' }}>{p.user}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{p.host}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--accent)', fontSize: 11 }}>{p.database}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: p.state === 'idle in transaction' ? 700 : 400,
                        color: p.state === 'idle in transaction' ? '#dc2626' : p.state === 'active' ? '#16a34a' : 'var(--text-muted)',
                      }}>{p.state}</span>
                    </td>
                    <td style={{
                      padding: '7px 10px', fontFamily: 'var(--font-mono)',
                      color: p.timeSecs > 30 ? '#ea580c' : p.timeSecs > 5 ? 'var(--text)' : 'var(--text-muted)',
                      fontWeight: p.timeSecs > 30 ? 600 : undefined,
                    }}>
                      {formatTime(p.timeSecs)}
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {isPg ? (p.command || '—') : p.command}
                    </td>
                    <td style={{
                      padding: '7px 10px', maxWidth: 240, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)',
                    }} title={p.info ?? ''}>
                      {p.info ?? '—'}
                    </td>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {isMaria && p.command === 'Query' && (
                          <button
                            onClick={() => doShowExplain(p.processId)}
                            disabled={explainLoading === p.processId}
                            title="SHOW EXPLAIN FOR（MariaDB 专属）"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 3, fontSize: 11,
                              color: 'var(--accent)', padding: '3px 8px', borderRadius: 5,
                              border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.06)',
                              opacity: explainLoading === p.processId ? 0.5 : 1,
                            }}
                          >
                            <Zap size={10} />
                            {explainLoading === p.processId ? '…' : 'EXPLAIN'}
                          </button>
                        )}
                        {isPg ? (
                          <>
                            <button
                              onClick={() => kill(p.processId)}
                              disabled={killing === p.processId}
                              title="pg_cancel_backend（温和取消当前查询，连接保留）"
                              style={{
                                display: 'flex', alignItems: 'center', gap: 3, fontSize: 11,
                                color: 'var(--warning)', padding: '3px 7px', borderRadius: 5,
                                border: '1px solid rgba(234,88,12,0.3)', background: 'rgba(234,88,12,0.06)',
                                opacity: killing === p.processId ? 0.5 : 1,
                              }}
                            >
                              <StopCircle size={10} />Cancel
                            </button>
                            <button
                              onClick={() => terminate(p.processId)}
                              disabled={killing === p.processId}
                              title="pg_terminate_backend（强制断开连接，需确认）"
                              style={{
                                display: 'flex', alignItems: 'center', gap: 3, fontSize: 11,
                                color: 'var(--error)', padding: '3px 7px', borderRadius: 5,
                                border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)',
                                opacity: killing === p.processId ? 0.5 : 1,
                              }}
                            >
                              <StopCircle size={10} />Terminate
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => kill(p.processId)}
                            disabled={killing === p.processId}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                              color: 'var(--error)', padding: '3px 8px', borderRadius: 5,
                              border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)',
                              opacity: killing === p.processId ? 0.5 : 1,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <StopCircle size={11} />
                            {killing === p.processId ? '…' : 'KILL'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        {/* MariaDB SHOW EXPLAIN 结果（下方折叠区） */}
        {showExplain && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', flexShrink: 0, maxHeight: 200, overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Zap size={12} color="var(--accent)" />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                SHOW EXPLAIN FOR {showExplain.pid}
              </span>
              <button onClick={() => setShowExplain(null)} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}>
                <X size={13} />
              </button>
            </div>
            <pre style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', margin: 0, whiteSpace: 'pre-wrap' }}>
              {showExplain.text}
            </pre>
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body
  )
}
