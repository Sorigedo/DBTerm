// J1 — SQL 多库广播：多连接批量执行，逐库结果汇总
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Radio, Play, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { ConnConfig } from '../../types'

interface Props {
  connections: ConnConfig[]
  initialSql?: string
  onClose: () => void
}

interface ConnResult {
  connId: string
  connName: string
  status: 'pending' | 'running' | 'ok' | 'error'
  rowsAffected: number
  executionMs: number
  error: string
  columns: string[]
  rows: (string | null)[][]
  collapsed: boolean
}

export default function BroadcastPanel({ connections, initialSql = '', onClose }: Props) {
  const [sql, setSql] = useState(initialSql)
  const [selectedConns, setSelectedConns] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<ConnResult[]>([])
  const [running, setRunning] = useState(false)

  const dbConns = connections.filter(c =>
    ['mysql', 'postgres', 'sqlite', 'tidb', 'mariadb', 'oceanBase', 'kingBase', 'openGauss'].includes(c.type)
  )

  useEffect(() => {
    // Default: select all connections
    setSelectedConns(new Set(dbConns.map(c => c.id)))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleConn = (id: string) => {
    setSelectedConns(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const run = async () => {
    if (!sql.trim() || selectedConns.size === 0) return

    const targets = dbConns.filter(c => selectedConns.has(c.id))
    const initial: ConnResult[] = targets.map(c => ({
      connId: c.id, connName: c.name,
      status: 'pending', rowsAffected: 0, executionMs: 0,
      error: '', columns: [], rows: [], collapsed: false,
    }))
    setResults(initial)
    setRunning(true)

    // Execute sequentially to avoid overwhelming DB connections
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i]
      setResults(prev => prev.map(r => r.connId === c.id ? { ...r, status: 'running' } : r))
      const t0 = Date.now()
      try {
        const res = await invoke<{ columns: string[]; rows: (string | null)[][]; rowsAffected: number }>('execute_query', {
          id: c.id, sql: sql.trim(),
        })
        const ms = Date.now() - t0
        setResults(prev => prev.map(r => r.connId === c.id ? {
          ...r, status: 'ok', rowsAffected: res.rowsAffected, executionMs: ms,
          columns: res.columns, rows: res.rows.slice(0, 100),
          collapsed: res.rows.length > 0,
        } : r))
      } catch (e) {
        const ms = Date.now() - t0
        setResults(prev => prev.map(r => r.connId === c.id ? {
          ...r, status: 'error', executionMs: ms, error: String(e),
        } : r))
      }
    }
    setRunning(false)
  }

  const okCount = results.filter(r => r.status === 'ok').length
  const errCount = results.filter(r => r.status === 'error').length

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 860, display: 'flex', flexDirection: 'column', maxHeight: '90vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Radio size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>SQL 多库广播</span>
          {results.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
              {okCount > 0 && <span style={{ color: 'var(--success)' }}>{okCount} 成功 </span>}
              {errCount > 0 && <span style={{ color: 'var(--error)' }}>{errCount} 失败</span>}
            </span>
          )}
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ display: 'flex', height: 0, flex: 1, overflow: 'hidden' }}>
          {/* Left: SQL + connection selector */}
          <div style={{ width: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)' }}>
              目标连接 ({selectedConns.size}/{dbConns.length})
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
              {dbConns.map(c => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={selectedConns.has(c.id)} onChange={() => toggleConn(c.id)} />
                  <span style={{ color: 'var(--text)', flex: 1 }}>{c.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{c.type}</span>
                </label>
              ))}
              {dbConns.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8 }}>无数据库连接</div>}
            </div>
            <div style={{ padding: 10, borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 6 }}>
              <button className="btn-cancel" style={{ flex: 1, fontSize: 11 }} onClick={() => setSelectedConns(new Set(dbConns.map(c => c.id)))}>全选</button>
              <button className="btn-cancel" style={{ flex: 1, fontSize: 11 }} onClick={() => setSelectedConns(new Set())}>清空</button>
            </div>
          </div>

          {/* Right: SQL editor + results */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <textarea
                value={sql}
                onChange={e => setSql(e.target.value)}
                placeholder="输入要广播执行的 SQL..."
                style={{
                  width: '100%', height: 90, padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)',
                  fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'none', outline: 'none',
                }}
                onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run() }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="btn-primary" onClick={run} disabled={running || !sql.trim() || selectedConns.size === 0}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                  广播执行 ({selectedConns.size} 个连接)
                </button>
              </div>
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {results.length === 0 && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                  选择目标连接，输入 SQL，点击广播执行
                </div>
              )}
              {results.map(r => (
                <div key={r.connId} style={{
                  marginBottom: 8, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
                  borderLeft: `3px solid ${r.status === 'ok' ? '#16a34a' : r.status === 'error' ? '#dc2626' : r.status === 'running' ? 'var(--accent)' : 'var(--border)'}`,
                }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--surface-2)', cursor: r.rows.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => r.rows.length > 0 && setResults(prev => prev.map(x => x.connId === r.connId ? { ...x, collapsed: !x.collapsed } : x))}
                  >
                    {r.status === 'running' && <Loader2 size={12} className="spin" color="var(--accent)" />}
                    {r.status === 'ok' && <CheckCircle size={12} color="var(--success)" />}
                    {r.status === 'error' && <XCircle size={12} color="var(--error)" />}
                    {r.status === 'pending' && <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--border)', display: 'inline-block' }} />}
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{r.connName}</span>
                    {r.status === 'ok' && (
                      <>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.executionMs}ms</span>
                        {r.rows.length > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.rows.length} 行</span>}
                        {r.rowsAffected > 0 && r.rows.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>影响 {r.rowsAffected} 行</span>}
                      </>
                    )}
                    {r.status === 'error' && <span style={{ fontSize: 11, color: 'var(--error)', flex: 1 }}>{r.error.slice(0, 100)}</span>}
                  </div>
                  {r.status === 'ok' && r.rows.length > 0 && !r.collapsed && (
                    <div style={{ overflow: 'auto', maxHeight: 200 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead>
                          <tr style={{ background: 'var(--surface)' }}>
                            {r.columns.map(col => <th key={col} style={{ padding: '4px 10px', textAlign: 'left', borderBottom: '1px solid var(--border)', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{col}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {r.rows.map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              {row.map((cell, j) => <td key={j} style={{ padding: '4px 10px', fontFamily: 'var(--font-mono)', color: cell === null ? 'var(--text-muted)' : 'var(--text)' }}>{cell ?? 'NULL'}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
