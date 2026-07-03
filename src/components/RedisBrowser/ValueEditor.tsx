// R2 全类型值编辑器
// 根据 key 类型路由到对应子编辑器
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Clock3, Pencil, Trash2, Copy, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import ConfirmDialog from '../shared/ConfirmDialog'
import HashEditor from './HashEditor'
import ListEditor from './ListEditor'
import SetEditor from './SetEditor'
import ZSetEditor from './ZSetEditor'
import StreamViewer from './StreamViewer'

interface Props {
  connectionId: string
  keyName: string
  db: number
  caps: number
  onDeleted: () => void
  onRenamed: (newKey: string) => void
  externalTrigger?: 'rename' | 'ttl' | null
  onTriggerHandled?: () => void
}

interface KeyDetail {
  key: string
  kind: string
  encoding: string
  ttl: number
  memoryBytes: number
  length: number
}

interface RedisValue {
  kind: string
  value: unknown
  truncated: boolean
  total: number
  binary?: boolean
}

const KIND_COLOR: Record<string, string> = {
  string: 'var(--accent)',
  list:   '#22c55e',
  hash:   '#f59e0b',
  set:    '#8b5cf6',
  zset:   '#ec4899',
  stream: '#06b6d4',
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function fmtTtl(ttl: number): string {
  if (ttl === -1) return '永久'
  if (ttl < 0) return '已过期'
  const d = Math.floor(ttl / 86400)
  const h = Math.floor((ttl % 86400) / 3600)
  const m = Math.floor((ttl % 3600) / 60)
  const s = ttl % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export default function ValueEditor({ connectionId, keyName, db, caps, onDeleted, onRenamed, externalTrigger, onTriggerHandled }: Props) {
  const [detail,    setDetail]   = useState<KeyDetail | null>(null)
  const [value,     setValue]    = useState<RedisValue | null>(null)
  const [loading,   setLoading]  = useState(false)
  const [error,     setError]    = useState('')
  // TTL 编辑
  const [ttlEdit,   setTtlEdit]  = useState<string | null>(null)
  // 重命名
  const [renaming,  setRenaming] = useState(false)
  const [newName,   setNewName]  = useState('')
  // 删除确认
  const [confirmDel, setConfirmDel] = useState(false)
  // String 值编辑
  const [strView,   setStrView]  = useState<'text' | 'json' | 'hex'>('text')
  const [editing,   setEditing]  = useState(false)
  const [editVal,   setEditVal]  = useState('')
  const [saving,    setSaving]   = useState(false)

  // KB4.2 外部触发（键盘快捷键 F2 重命名 / Mod+Shift+T TTL 编辑）
  useEffect(() => {
    if (!externalTrigger) return
    if (externalTrigger === 'rename') { setRenaming(true); setNewName(keyName) }
    else if (externalTrigger === 'ttl') { setTtlEdit(detail && detail.ttl > 0 ? String(detail.ttl) : '') }
    onTriggerHandled?.()
  }, [externalTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setEditing(false)
    try {
      const d = await invoke<KeyDetail>('redis_key_detail', {
        id: connectionId, key: keyName, db, caps,
      })
      setDetail(d)
      // String 类型同时加载值
      if (d.kind === 'string') {
        const v = await invoke<RedisValue>('redis_get', { id: connectionId, key: keyName, db })
        setValue(v)
      } else {
        setValue(null)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [connectionId, keyName, db, caps])

  useEffect(() => { load() }, [load])

  const saveTtl = async () => {
    if (ttlEdit === null) return
    const secs = ttlEdit.trim() === '' ? 0 : Number(ttlEdit)
    if (isNaN(secs) || secs < 0) { setError('TTL 必须是非负整数'); return }
    try {
      await invoke('redis_expire', { id: connectionId, key: keyName, ttlSecs: Math.floor(secs), db })
      setTtlEdit(null)
      load()
    } catch (e) { setError(String(e)) }
  }

  const doRename = async () => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === keyName) { setRenaming(false); return }
    try {
      const ok = await invoke<boolean>('redis_rename_key', {
        id: connectionId, oldKey: keyName, newKey: trimmed, nx: true, db,
      })
      if (!ok) { setError(`目标 key "${trimmed}" 已存在，请换一个名称`); return }
      setRenaming(false)
      onRenamed(trimmed)
    } catch (e) { setError(String(e)) }
  }

  const doDelete = async () => {
    try {
      await invoke('redis_del', { id: connectionId, key: keyName, db, caps })
      onDeleted()
    } catch (e) { setError(String(e)) }
    setConfirmDel(false)
  }

  const saveString = async () => {
    setSaving(true)
    try {
      await invoke('redis_set', {
        id: connectionId, key: keyName, value: editVal,
        ttlSecs: detail && detail.ttl > 0 ? detail.ttl : null, db,
      })
      setEditing(false)
      load()
    } catch (e) { setError(String(e)) }
    setSaving(false)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  if (loading && !detail) {
    return (
      <div className="result-placeholder">
        <Loader2 size={16} className="spin" />
      </div>
    )
  }

  return (
    <div className="redis-value">
      {/* 头部：key 名、类型、TTL、操作 */}
      <div className="redis-value__header">
        {detail && (
          <span className="redis-value__kind" style={{ color: KIND_COLOR[detail.kind] ?? 'var(--accent)' }}>
            {detail.kind}
          </span>
        )}
        <span className="redis-value__key" title={keyName}>{keyName}</span>
        {detail && (
          <span className="redis-value__meta">
            {detail.encoding && <span data-tip="编码方式">{detail.encoding}</span>}
            {detail.memoryBytes > 0 && <span data-tip="内存占用">{fmtBytes(detail.memoryBytes)}</span>}
            {detail.ttl >= -1 && (
              <span
                className={detail.ttl >= 0 && detail.ttl < 60 ? 'redis-ttl-warn' : ''}
                title={`TTL: ${detail.ttl}s`}
              >
                {fmtTtl(detail.ttl)}
              </span>
            )}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          <button className="ssh-panel__btn" data-tip="刷新" onClick={load}>
            <RefreshCw size={12} strokeWidth={2} className={loading ? 'spin' : ''} />
          </button>
          <button className="ssh-panel__btn" data-tip="设置过期时间" onClick={() => {
            setTtlEdit(detail && detail.ttl > 0 ? String(detail.ttl) : '')
          }}>
            <Clock3 size={12} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" data-tip="重命名" onClick={() => {
            setNewName(keyName)
            setRenaming(true)
          }}>
            <Pencil size={12} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" data-tip="复制 key 名" onClick={() => copyToClipboard(keyName)}>
            <Copy size={12} strokeWidth={2} />
          </button>
          <button className="cmd-act-btn danger" data-tip="删除" onClick={() => setConfirmDel(true)}>
            <Trash2 size={12} strokeWidth={2} />
          </button>
        </span>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {/* 值编辑区域，根据类型路由 */}
      <div className="redis-value__body">
        {detail?.kind === 'string' && (
          <div className="redis-string-editor">
            {/* 视图切换：二进制值已是十六进制预览，隐藏 text/json/hex 切换与编辑 */}
            <div className="redis-str-tabs">
              {value?.binary ? (
                <span className="redis-binary-badge" data-tip="非 UTF-8 二进制值，以十六进制预览">二进制</span>
              ) : (['text', 'json', 'hex'] as const).map(v => (
                <button
                  key={v}
                  className={`redis-str-tab${strView === v ? ' active' : ''}`}
                  onClick={() => setStrView(v)}
                >
                  {v.toUpperCase()}
                </button>
              ))}
              {!editing && !value?.binary && (
                <button
                  className="ssh-panel__btn"
                  style={{ marginLeft: 'auto' }}
                  data-tip="编辑值"
                  onClick={() => {
                    const raw = typeof value?.value === 'string' ? value.value : ''
                    setEditVal(raw)
                    setEditing(true)
                  }}
                >
                  <Pencil size={11} strokeWidth={2} />
                </button>
              )}
            </div>
            {value?.truncated && (
              <div className="redis-value__truncated">⚠ 值较大，仅显示部分</div>
            )}
            {value?.binary ? (
              <pre className="redis-value__pre" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                {typeof value?.value === 'string' ? value.value : ''}
              </pre>
            ) : editing ? (
              <>
                <textarea
                  className="redis-edit__textarea"
                  value={editVal}
                  autoFocus
                  spellCheck={false}
                  onChange={e => setEditVal(e.target.value)}
                />
                <div className="redis-edit__foot">
                  <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setEditing(false)}>取消</button>
                  <button className="cdlg-btn cdlg-btn--ok" disabled={saving} onClick={saveString}>
                    {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              </>
            ) : (
              <pre className="redis-value__pre">
                {renderStringValue(value?.value, strView)}
              </pre>
            )}
          </div>
        )}

        {detail?.kind === 'hash' && (
          <HashEditor connectionId={connectionId} keyName={keyName} db={db} />
        )}

        {detail?.kind === 'list' && (
          <ListEditor connectionId={connectionId} keyName={keyName} db={db} total={detail.length} />
        )}

        {detail?.kind === 'set' && (
          <SetEditor connectionId={connectionId} keyName={keyName} db={db} />
        )}

        {detail?.kind === 'zset' && (
          <ZSetEditor connectionId={connectionId} keyName={keyName} db={db} total={detail.length} />
        )}

        {detail?.kind === 'stream' && (
          <StreamViewer connectionId={connectionId} keyName={keyName} db={db} total={detail.length} />
        )}

        {detail && !['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(detail.kind) && (
          <div className="panel-empty">暂不支持查看 {detail.kind} 类型</div>
        )}
      </div>

      {/* TTL 编辑弹窗 */}
      {ttlEdit !== null && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setTtlEdit(null)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}>
            <div className="cdlg-head">
              <Clock3 size={15} className="cdlg-head__icon cdlg-head__icon--info" />
              <span className="cdlg-head__title">设置过期时间</span>
            </div>
            <p className="cdlg-desc" style={{ marginBottom: 10 }}>{keyName}</p>
            <div className="mfa-field">
              <label>过期秒数（0 或空 = 永久）</label>
              <input
                autoFocus type="number" min={0} placeholder="如 3600"
                value={ttlEdit}
                onChange={e => setTtlEdit(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveTtl(); if (e.key === 'Escape') setTtlEdit(null) }}
              />
            </div>
            <div className="cdlg-foot">
              <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setTtlEdit(null)}>取消</button>
              <button className="cdlg-btn cdlg-btn--ok" onClick={saveTtl}>应用</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 重命名弹窗 */}
      {renaming && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setRenaming(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}>
            <div className="cdlg-head">
              <Pencil size={15} className="cdlg-head__icon cdlg-head__icon--info" />
              <span className="cdlg-head__title">重命名 Key</span>
            </div>
            <div className="mfa-field">
              <label>新 Key 名称</label>
              <input
                autoFocus value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(false) }}
              />
            </div>
            <div className="cdlg-foot">
              <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setRenaming(false)}>取消</button>
              <button className="cdlg-btn cdlg-btn--ok" onClick={doRename}>重命名</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={confirmDel}
        title="删除 Key"
        desc={`确认删除 "${keyName}"？该操作无法撤销。`}
        danger okText="删除"
        onOk={doDelete}
        onCancel={() => setConfirmDel(false)}
      />
    </div>
  )
}

function renderStringValue(val: unknown, view: 'text' | 'json' | 'hex'): string {
  const s = typeof val === 'string' ? val : String(val ?? '')
  if (view === 'json') {
    try { return JSON.stringify(JSON.parse(s), null, 2) }
    catch { return s }
  }
  if (view === 'hex') {
    const bytes = new TextEncoder().encode(s)
    const lines: string[] = []
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.slice(i, i + 16)
      const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ')
      const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('')
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`)
    }
    return lines.join('\n')
  }
  return s
}
