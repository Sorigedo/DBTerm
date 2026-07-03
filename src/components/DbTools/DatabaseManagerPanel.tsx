import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Database, Plus, Trash2, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  currentSchema: string
  onClose: () => void
  onRefresh?: () => void
}

// 系统库：禁止删除（删了会毁掉实例）
const SYSTEM_SCHEMAS = new Set([
  'mysql', 'information_schema', 'performance_schema', 'sys',          // MySQL 系
  'pg_catalog', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1',           // PG 系
])
function isSystemSchema(s: string): boolean {
  const n = s.toLowerCase()
  return SYSTEM_SCHEMAS.has(n) || n.startsWith('pg_')
}

export default function DatabaseManagerPanel({ connectionId, currentSchema, onClose, onRefresh }: Props) {
  const [schemas, setSchemas] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // 创建库
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [charset, setCharset] = useState('utf8mb4')
  const [collate, setCollate] = useState('utf8mb4_unicode_ci')
  const [creating, setCreating] = useState(false)

  // 删除确认
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dropConfirm, setDropConfirm] = useState('')
  const [dropping, setDropping] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<string[]>('list_schemas', { id: connectionId })
      setSchemas(list)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dropTarget) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, dropTarget])

  const createDb = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setError('')
    setSuccess('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_create_database', {
        id: connectionId,
        dbName: newName.trim(),
        charset,
        collate,
      })
      setSuccess(`数据库 ${newName.trim()} 创建成功`)
      setNewName('')
      setShowCreate(false)
      await load()
      onRefresh?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setCreating(false)
    }
  }

  const dropDb = async () => {
    if (!dropTarget || dropConfirm !== dropTarget) return
    setDropping(true)
    setError('')
    setSuccess('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_drop_database', { id: connectionId, dbName: dropTarget })
      setSuccess(`数据库 ${dropTarget} 已删除`)
      setDropTarget(null)
      setDropConfirm('')
      await load()
      onRefresh?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setDropping(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={!dropTarget ? onClose : undefined}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>库管理</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setShowCreate(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
                padding: '5px 10px', borderRadius: 7, background: 'var(--accent)', color: '#fff',
              }}
            >
              <Plus size={13} /> 新建库
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* 新建表单 */}
        {showCreate && (
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>新建数据库</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>库名</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="my_database"
                style={{ fontSize: 12, padding: '6px 10px' }}
                onKeyDown={e => { if (e.key === 'Enter') createDb() }}
                autoFocus
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>字符集</label>
                <input value={charset} onChange={e => setCharset(e.target.value)} style={{ fontSize: 12, padding: '6px 10px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>排序规则</label>
                <input value={collate} onChange={e => setCollate(e.target.value)} style={{ fontSize: 12, padding: '6px 10px' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowCreate(false)}
                style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >取消</button>
              <button
                onClick={createDb}
                disabled={!newName.trim() || creating}
                style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, background: 'var(--accent)', color: '#fff', opacity: (!newName.trim() || creating) ? 0.5 : 1 }}
              >{creating ? '创建中…' : '创建'}</button>
            </div>
          </div>
        )}

        {success && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--success)', background: 'rgba(22,163,74,0.08)', flexShrink: 0 }}>{success}</div>}
        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>}

        {/* 库列表 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : (
            <div>
              {schemas.map(s => (
                <div
                  key={s}
                  style={{
                    display: 'flex', alignItems: 'center', padding: '10px 16px',
                    borderBottom: '1px solid var(--border-subtle)',
                    background: s === currentSchema ? 'rgba(var(--accent-rgb, 99,102,241),0.06)' : undefined,
                  }}
                >
                  <Database size={13} color={s === currentSchema ? 'var(--accent)' : 'var(--text-muted)'} />
                  <span style={{
                    flex: 1, marginLeft: 10, fontSize: 13,
                    color: s === currentSchema ? 'var(--accent)' : 'var(--text)',
                    fontWeight: s === currentSchema ? 600 : undefined,
                  }}>{s}</span>
                  {s === currentSchema && (
                    <span style={{ fontSize: 10, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 6px', marginRight: 8 }}>当前</span>
                  )}
                  {isSystemSchema(s) && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px', marginRight: 8 }}>系统库</span>
                  )}
                  {/* 系统库 / 当前库：不渲染删除按钮，避免误删毁库 */}
                  {!isSystemSchema(s) && s !== currentSchema && (
                    <button
                      onClick={() => { setDropTarget(s); setDropConfirm('') }}
                      style={{ color: 'var(--error)', lineHeight: 0, padding: 4 }}
                      data-tip={`删除 ${s}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 删除确认弹窗 */}
      {dropTarget && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
        }} onMouseDown={() => { setDropTarget(null); setDropConfirm('') }}>
          <div
            onMouseDown={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 14, padding: 24, width: 420,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <AlertTriangle size={18} color="var(--error)" />
              <span style={{ fontWeight: 700, color: 'var(--error)', fontSize: 15 }}>高危操作：删除数据库</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 16, lineHeight: 1.6 }}>
              即将删除数据库 <strong>{dropTarget}</strong>。此操作将永久删除库中所有表和数据，不可恢复！
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                请输入数据库名 <code style={{ color: 'var(--error)' }}>{dropTarget}</code> 确认删除：
              </label>
              <input
                value={dropConfirm}
                onChange={e => setDropConfirm(e.target.value)}
                placeholder={dropTarget}
                style={{ width: '100%', fontSize: 13, padding: '7px 10px' }}
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && dropConfirm === dropTarget) dropDb() }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setDropTarget(null); setDropConfirm('') }}
                style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >取消</button>
              <button
                onClick={dropDb}
                disabled={dropConfirm !== dropTarget || dropping}
                style={{
                  padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: 'var(--error)', color: '#fff',
                  opacity: (dropConfirm !== dropTarget || dropping) ? 0.4 : 1,
                }}
              >{dropping ? '删除中…' : '确认删除'}</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
