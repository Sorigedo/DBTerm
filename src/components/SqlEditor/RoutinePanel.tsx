import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Braces, Workflow, Play, Trash2, CheckCircle, AlertTriangle, Loader2, Plus, Minus } from 'lucide-react'

interface Props {
  connectionId: string
  schema: string
  name: string
  routineType: string  // 'FUNCTION' | 'PROCEDURE'
  onClose: () => void
  onDropped?: () => void
}

interface ProcParam {
  name: string
  value: string
}

export default function RoutinePanel({ connectionId, schema, name, routineType, onClose, onDropped }: Props) {
  const [ddl, setDdl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const [success, setSuccess] = useState('')
  const [tab, setTab] = useState<'ddl' | 'exec'>('ddl')
  const [params, setParams] = useState<ProcParam[]>([{ name: 'p1', value: '' }])
  const [execResult, setExecResult] = useState<{ rows: Record<string, string>[]; message: string } | null>(null)
  const [execRunning, setExecRunning] = useState(false)
  const [execError, setExecError] = useState('')
  const [dropConfirm, setDropConfirm] = useState(false)
  const [dropInput, setDropInput] = useState('')

  const isProcedure = routineType === 'PROCEDURE'

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const raw = await invoke<string>('get_table_ddl', { id: connectionId, schema, table: name })
        setDdl(raw)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [connectionId, schema, name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const applyDdl = useCallback(async () => {
    setApplying(true)
    setError('')
    setSuccess('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('execute_query', { id: connectionId, schema, sql: ddl })
      setSuccess(`${routineType === 'FUNCTION' ? '函数' : '存储过程'}已更新`)
      setTimeout(() => setSuccess(''), 3000)
    } catch (e) {
      setError(String(e))
    } finally {
      setApplying(false)
    }
  }, [connectionId, schema, ddl, routineType])

  const execProcedure = useCallback(async () => {
    setExecRunning(true)
    setExecError('')
    setExecResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ rows: Record<string, string>[]; message: string }>('db_call_procedure', {
        id: connectionId, schema, name, params,
      })
      setExecResult(res)
    } catch (e) {
      setExecError(String(e))
    } finally {
      setExecRunning(false)
    }
  }, [connectionId, schema, name, params])

  const doDropRoutine = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_drop_routine', { id: connectionId, schema, name, routineType })
      onDropped?.()
      onClose()
    } catch (e) {
      setError(String(e))
      setDropConfirm(false)
    }
  }, [connectionId, schema, name, routineType, onDropped, onClose])

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 760, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {isProcedure
            ? <Workflow size={15} color="var(--accent)" />
            : <Braces size={15} color="var(--accent)" />
          }
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>
            {isProcedure ? '存储过程' : '函数'} — {schema ? `${schema}.` : ''}{name}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              onClick={() => setDropConfirm(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 11, color: 'var(--error)' }}
              title="删除"
            >
              <Trash2 size={12} /> 删除
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0, marginLeft: 4 }}><X size={15} /></button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {(['ddl', 'exec'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '8px 16px', fontSize: 12, fontWeight: tab === t ? 600 : undefined,
                color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'none',
              }}
            >
              {t === 'ddl' ? 'DDL 定义' : '执行'}
              {t === 'exec' && !isProcedure && ' (函数)'}
            </button>
          ))}
        </div>

        {/* Body */}
        {tab === 'ddl' ? (
          <>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {loading ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                  <Loader2 size={14} className="spin" /> 获取定义…
                </div>
              ) : (
                <textarea
                  value={ddl}
                  onChange={e => setDdl(e.target.value)}
                  spellCheck={false}
                  style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, background: 'var(--bg)', color: 'var(--text)', padding: '12px 16px' }}
                />
              )}
            </div>
            {error && (
              <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', flexShrink: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>{error}</div>
            )}
            {success && (
              <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--success)', flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
                <CheckCircle size={12} /> {success}
              </div>
            )}
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={applyDdl}
                disabled={loading || applying || !ddl.trim()}
                style={{ padding: '5px 14px', borderRadius: 7, background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, opacity: (loading || applying || !ddl.trim()) ? 0.5 : 1 }}
              >
                {applying ? '执行中…' : '应用定义'}
              </button>
            </div>
          </>
        ) : (
          /* Execution tab */
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>参数列表（按顺序填入）</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {params.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={p.name}
                      onChange={e => setParams(ps => ps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      placeholder="参数名"
                      style={{ width: 110, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)' }}
                    />
                    <input
                      value={p.value}
                      onChange={e => setParams(ps => ps.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                      placeholder="值"
                      style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}
                    />
                    <button
                      onClick={() => setParams(ps => ps.filter((_, j) => j !== i))}
                      style={{ color: 'var(--text-muted)', lineHeight: 0 }}
                    >
                      <Minus size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => setParams(ps => [...ps, { name: `p${ps.length + 1}`, value: '' }])}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}
                >
                  <Plus size={11} /> 添加参数
                </button>
                <button
                  onClick={() => setParams([])}
                  style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}
                >
                  无参数
                </button>
                <button
                  onClick={execProcedure}
                  disabled={execRunning}
                  style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, padding: '5px 14px', borderRadius: 7, background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, opacity: execRunning ? 0.7 : 1 }}
                >
                  <Play size={12} /> {execRunning ? '执行中…' : '执行'}
                </button>
              </div>
            </div>

            {execError && (
              <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', display: 'flex', gap: 6 }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>{execError}</span>
              </div>
            )}
            {execResult && (
              <div style={{ padding: '12px 16px' }}>
                <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={12} /> {execResult.message}
                </div>
                {execResult.rows.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {Object.keys(execResult.rows[0]).map(k => (
                          <th key={k} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {execResult.rows.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          {Object.values(row).map((v, j) => (
                            <td key={j} style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>{v}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* Drop confirm */}
        {dropConfirm && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setDropConfirm(false)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 400, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Trash2 size={16} color="var(--error)" />
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--error)' }}>删除{isProcedure ? '存储过程' : '函数'}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>
                将执行 <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--error)' }}>DROP {routineType} IF EXISTS {name}</code>。
                此操作不可撤销。
              </p>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>输入 <strong style={{ color: 'var(--text)' }}>{name}</strong> 确认</div>
              <input
                value={dropInput}
                onChange={e => setDropInput(e.target.value)}
                placeholder={name}
                style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => { setDropConfirm(false); setDropInput('') }} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)' }}>取消</button>
                <button
                  onClick={doDropRoutine}
                  disabled={dropInput !== name}
                  style={{ padding: '5px 14px', borderRadius: 7, background: 'var(--error)', color: '#fff', fontSize: 12, fontWeight: 600, opacity: dropInput !== name ? 0.5 : 1 }}
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>,
    document.body
  )
}
