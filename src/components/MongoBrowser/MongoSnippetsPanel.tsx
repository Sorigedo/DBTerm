// MO10.5 MongoDB 片段库 — filter/管道/shell 片段保存与参数化执行
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Bookmark, Plus, Trash2, Search, Play, Copy, Filter, Layers, Terminal } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'

export type SnippetType = 'filter' | 'pipeline' | 'shell'

export interface MongoSnippet {
  id: string
  name: string
  type: SnippetType
  content: string  // filter: JSON object; pipeline: JSON array; shell: JSON object
  connId: string   // '' = 全局
  createdAt: number
}

interface Props {
  connectionId: string
  onInsertFilter: (json: string) => void
  onInsertPipeline: (json: string) => void
  onInsertShell: (json: string) => void
  onRunFilter?: (json: string) => void
  onClose: () => void
}

const STORAGE_KEY = 'dbterm_mongo_snippets'

function loadAll(): MongoSnippet[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}
function saveAll(list: MongoSnippet[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

const TYPE_LABELS: Record<SnippetType, string> = { filter: 'Filter', pipeline: '管道', shell: 'Shell' }
const TYPE_ICONS = {
  filter: <Filter size={11} />,
  pipeline: <Layers size={11} />,
  shell: <Terminal size={11} />,
}
const TYPE_COLORS: Record<SnippetType, string> = {
  filter: 'var(--accent)',
  pipeline: '#16a34a',
  shell: '#ea580c',
}

export default function MongoSnippetsPanel({ connectionId, onInsertFilter, onInsertPipeline, onInsertShell, onRunFilter, onClose }: Props) {
  const [snippets, setSnippets] = useState<MongoSnippet[]>(loadAll)
  const [filterText, setFilterText] = useState('')
  const [scope, setScope] = useState<'all' | 'conn' | 'global'>('all')
  const [typeFilter, setTypeFilter] = useState<SnippetType | 'all'>('all')
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<SnippetType>('filter')
  const [newContent, setNewContent] = useState('')
  const [newGlobal, setNewGlobal] = useState(false)
  const [contentError, setContentError] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const validateContent = (type: SnippetType, content: string): string => {
    try {
      const parsed = JSON.parse(content)
      if (type === 'pipeline' && !Array.isArray(parsed)) return '管道片段必须是 JSON 数组（[{$match:...},...]）'
      if ((type === 'filter' || type === 'shell') && (typeof parsed !== 'object' || Array.isArray(parsed))) return '必须是 JSON 对象'
      return ''
    } catch (e) {
      return `JSON 格式错误: ${String(e)}`
    }
  }

  const save = useCallback(() => {
    const err = validateContent(newType, newContent.trim())
    if (err) { setContentError(err); return }
    const next: MongoSnippet = {
      id: `ms_${Date.now()}`,
      name: newName.trim() || '未命名片段',
      type: newType,
      content: newContent.trim(),
      connId: newGlobal ? '' : connectionId,
      createdAt: Date.now(),
    }
    const updated = [next, ...snippets]
    setSnippets(updated)
    saveAll(updated)
    setShowNew(false)
    setNewName(''); setNewContent(''); setNewGlobal(false); setContentError('')
  }, [newName, newType, newContent, newGlobal, connectionId, snippets])

  const remove = (id: string) => {
    const updated = snippets.filter(s => s.id !== id)
    setSnippets(updated)
    saveAll(updated)
  }

  const copy = (content: string) => {
    navigator.clipboard.writeText(content)
    setCopied(content)
    setTimeout(() => setCopied(''), 1500)
  }

  const insert = (s: MongoSnippet) => {
    if (s.type === 'filter') onInsertFilter(s.content)
    else if (s.type === 'pipeline') onInsertPipeline(s.content)
    else onInsertShell(s.content)
    onClose()
  }

  const q = filterText.toLowerCase()
  const shown = snippets.filter(s => {
    if (scope === 'conn' && s.connId !== connectionId) return false
    if (scope === 'global' && s.connId !== '') return false
    if (typeFilter !== 'all' && s.type !== typeFilter) return false
    if (q && !s.name.toLowerCase().includes(q) && !s.content.toLowerCase().includes(q)) return false
    return true
  })

  const PLACEHOLDERS: Record<SnippetType, string> = {
    filter: '{"status": "active", "age": {"$gte": 18}}',
    pipeline: '[{"$match": {"status": "active"}}, {"$group": {"_id": "$type", "count": {"$sum": 1}}}]',
    shell: '{"listCollections": 1, "nameOnly": true}',
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 680, maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', animation: 'slideUp 0.18s ease' }}>
        {/* 头部 */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Bookmark size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', flex: 1 }}>MongoDB 片段库</span>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 6 }}>
            <X size={15} />
          </button>
        </div>

        {/* 工具栏 */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 140 }}>
            <Search size={11} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="搜索片段…"
              style={{ width: '100%', boxSizing: 'border-box', paddingLeft: 26, paddingRight: 8, paddingTop: 5, paddingBottom: 5, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
          </div>
          {(['all', 'conn', 'global'] as const).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${scope === s ? 'var(--accent)' : 'var(--border-subtle)'}`, background: scope === s ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--surface-2)', color: scope === s ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
              {s === 'all' ? '全部' : s === 'conn' ? '当前连接' : '全局'}
            </button>
          ))}
          {(['all', 'filter', 'pipeline', 'shell'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${typeFilter === t ? 'var(--border)' : 'var(--border-subtle)'}`, background: typeFilter === t ? 'var(--surface-hover)' : 'transparent', color: typeFilter === t ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
              {t === 'all' ? '所有类型' : TYPE_LABELS[t]}
            </button>
          ))}
          <button onClick={() => setShowNew(v => !v)} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
            <Plus size={12} /> 新增
          </button>
        </div>

        {/* 新增表单 */}
        {showNew && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="片段名称"
                style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border-subtle)', borderRadius: 7, background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
              <SearchableSelect value={newType} onChange={v => { setNewType(v as SnippetType); setContentError('') }}
                mono={false} width={140}
                items={[
                  { value: 'filter', label: 'Filter' },
                  { value: 'pipeline', label: '管道 Pipeline' },
                  { value: 'shell', label: 'Shell 命令' },
                ]} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={newGlobal} onChange={e => setNewGlobal(e.target.checked)} /> 全局片段
              </label>
            </div>
            <textarea value={newContent} onChange={e => { setNewContent(e.target.value); setContentError('') }}
              rows={4} placeholder={PLACEHOLDERS[newType]}
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: `1px solid ${contentError ? '#dc2626' : 'var(--border-subtle)'}`, borderRadius: 7, background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
            {contentError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{contentError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNew(false); setContentError('') }} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={save} style={{ padding: '5px 14px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12 }}>保存</button>
            </div>
          </div>
        )}

        {/* 片段列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {shown.length === 0 && (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {snippets.length === 0 ? '暂无片段，点击「新增」保存常用 filter/管道/shell 命令' : '没有匹配的片段'}
            </div>
          )}
          {shown.map(s => (
            <div key={s.id} style={{ marginBottom: 8, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: `${TYPE_COLORS[s.type]}22`, color: TYPE_COLORS[s.type], display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
                    {TYPE_ICONS[s.type]} {TYPE_LABELS[s.type]}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 500 }}>{s.name}</span>
                  {s.connId === '' && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--surface-hover)', color: 'var(--text-muted)' }}>全局</span>}
                </div>
                <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 72, overflow: 'hidden' }}>{s.content}</pre>
              </div>
              <div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'center' }}>
                {s.type === 'filter' && onRunFilter && (
                  <button onClick={() => { onRunFilter(s.content); onClose() }} title="直接执行查询"
                    style={{ padding: '3px 8px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Play size={10} /> 执行
                  </button>
                )}
                <button onClick={() => insert(s)} title="插入到编辑区"
                  style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
                  插入
                </button>
                <button onClick={() => copy(s.content)} title="复制内容"
                  style={{ padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: copied === s.content ? '#16a34a' : 'var(--text-muted)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center' }}>
                  <Copy size={11} />
                </button>
                <button onClick={() => remove(s.id)} title="删除片段"
                  style={{ padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: 'var(--error)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center' }}>
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>共 {shown.length} 个片段{filterText || scope !== 'all' || typeFilter !== 'all' ? `（筛选中，总 ${snippets.length} 个）` : ''}</span>
          <button onClick={onClose} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>关闭</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
