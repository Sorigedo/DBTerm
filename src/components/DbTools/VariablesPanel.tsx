import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Settings, RefreshCw, Search, Copy } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface VarEntry {
  name: string
  value: string
}

type Kind = 'variables' | 'status' | 'global_variables' | 'global_status'

const KINDS: { key: Kind; label: string }[] = [
  { key: 'variables',        label: '会话变量' },
  { key: 'status',           label: '会话状态' },
  { key: 'global_variables', label: '全局变量' },
  { key: 'global_status',    label: '全局状态' },
]

export default function VariablesPanel({ connectionId, connType, onClose, embedded }: Props) {
  const [kind, setKind] = useState<Kind>('global_variables')
  const [data, setData] = useState<VarEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState('')

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const kinds = isPg ? [{ key: 'global_variables' as Kind, label: 'PG 配置' }] : KINDS

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<VarEntry[]>('db_show_variables', { id: connectionId, kind })
      setData(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [kind])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const q = filter.toLowerCase()
  const shown = data.filter(v => !q || v.name.toLowerCase().includes(q) || v.value.toLowerCase().includes(q))

  const copyVal = (v: string) => {
    navigator.clipboard.writeText(v)
    setCopied(v)
    setTimeout(() => setCopied(''), 1500)
  }

  const inner = (
    <>
      {/* Tab 切换（嵌入模式把刷新并进本行右侧，省去单独一行）*/}
        <div style={{ display: 'flex', alignItems: 'center', padding: embedded ? '6px 12px' : '8px 16px', gap: 4, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {kinds.map(k => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: kind === k.key ? 600 : 400,
                background: kind === k.key ? 'var(--accent)' : 'var(--surface-2)',
                color: kind === k.key ? '#fff' : 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
            >{k.label}</button>
          ))}
          {embedded && (
            <button onClick={load} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        {/* 搜索 */}
        <div style={{ padding: embedded ? '8px 12px' : '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ position: 'relative', marginBottom: connType === 'mariadb' ? 8 : 0 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={`搜索变量名或值… (共 ${data.length} 项)`}
              style={{ width: '100%', padding: '6px 10px 6px 28px', fontSize: 12 }}
            />
          </div>
          {connType === 'mariadb' && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['wsrep_', 'aria_', 'thread_pool_', 'optimizer_', 'innodb_', 'server_audit_'].map(prefix => (
                <button
                  key={prefix}
                  onClick={() => setFilter(f => f === prefix ? '' : prefix)}
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                    background: filter === prefix ? 'var(--accent)' : 'var(--surface-2)',
                    color: filter === prefix ? '#fff' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >{prefix}</button>
              ))}
            </div>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无匹配结果</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '45%' }}>变量名</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>值</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(v => (
                  <tr key={v.name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '5px 10px', color: 'var(--text-bright)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{v.name}</td>
                    <td style={{ padding: '5px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', flex: 1, wordBreak: 'break-all' }}>{v.value || '—'}</span>
                        <button
                          onClick={() => copyVal(v.value)}
                          style={{ color: copied === v.value ? '#16a34a' : 'var(--text-muted)', lineHeight: 0, padding: 2, flexShrink: 0 }}
                        >
                          <Copy size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        style={{ width: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Settings size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>变量 / 状态</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
