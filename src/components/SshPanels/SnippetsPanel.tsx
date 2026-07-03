// 命令片段库 — 用 localStorage 持久化自定义命令模板
import { useState, useEffect } from 'react'
import { Plus, Trash2, Play, FolderOpen, Search, Edit2, Check, X as XIcon } from 'lucide-react'

interface Snippet {
  id: string
  name: string
  command: string
  group: string
  desc?: string
}

interface Props {
  sessionId: string
  onClose: () => void
  onRunCommand?: (cmd: string) => void
}

const STORAGE_KEY = 'dbterm-ssh-snippets'

function loadSnippets(): Snippet[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') }
  catch { return [] }
}
function saveSnippets(list: Snippet[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) }
  catch (e) { console.warn('片段保存失败（存储空间已满）', e) }
}

const BTN: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px',
  borderRadius: 4, color: 'var(--text-muted)', display: 'flex', alignItems: 'center',
}
const INPUT: React.CSSProperties = {
  padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, width: '100%',
}
const TEXTAREA: React.CSSProperties = {
  ...INPUT, fontFamily: 'var(--font-mono)', resize: 'vertical', minHeight: 60,
}

export default function SnippetsPanel({ onClose, onRunCommand }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [search, setSearch] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<Snippet>>({ group: '通用' })
  const [groups, setGroups] = useState<string[]>(['通用'])
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const list = loadSnippets()
    setSnippets(list)
    const gs = [...new Set(list.map(s => s.group).filter(Boolean))]
    if (gs.length) setGroups(['通用', ...gs.filter(g => g !== '通用')])
  }, [])

  function save(list: Snippet[]) {
    setSnippets(list)
    saveSnippets(list)
    const gs = [...new Set(list.map(s => s.group).filter(Boolean))]
    setGroups(['通用', ...gs.filter(g => g !== '通用')])
  }

  function submitSnippet() {
    if (!form.name?.trim() || !form.command?.trim()) return
    const item: Snippet = {
      id: editId ?? String(Date.now()),
      name: form.name.trim(),
      command: form.command.trim(),
      group: form.group ?? '通用',
      desc: form.desc?.trim(),
    }
    if (editId) {
      save(snippets.map(s => s.id === editId ? item : s))
      setEditId(null)
    } else {
      save([...snippets, item])
    }
    setForm({ group: form.group ?? '通用' })
    setAdding(false)
  }

  function startEdit(s: Snippet) {
    setEditId(s.id)
    setForm({ name: s.name, command: s.command, group: s.group, desc: s.desc })
    setAdding(true)
  }

  function deleteSnippet(id: string) {
    save(snippets.filter(s => s.id !== id))
  }

  function run(cmd: string) {
    onRunCommand?.(cmd)
  }

  const filtered = snippets
    .filter(s => !activeGroup || s.group === activeGroup)
    .filter(s => !search || s.name.includes(search) || s.command.includes(search))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <FolderOpen size={14} color="var(--accent)" />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)', flex: 1 }}>命令片段库</span>
        <button style={BTN} onClick={() => { setAdding(true); setEditId(null); setForm({ group: activeGroup ?? '通用' }) }}>
          <Plus size={14} />
        </button>
        <button style={BTN} onClick={onClose}><XIcon size={14} /></button>
      </div>

      {/* 搜索 + 分组 */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索片段…"
            style={{ ...INPUT, paddingLeft: 26 }} />
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            onClick={() => setActiveGroup(null)}
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer',
              background: !activeGroup ? 'var(--accent)' : 'var(--surface-2)', color: !activeGroup ? '#fff' : 'var(--text)' }}>
            全部
          </button>
          {groups.map(g => (
            <button key={g} onClick={() => setActiveGroup(activeGroup === g ? null : g)}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer',
                background: activeGroup === g ? 'var(--accent)' : 'var(--surface-2)', color: activeGroup === g ? '#fff' : 'var(--text)' }}>
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* 添加/编辑表单 */}
      {adding && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="片段名称 *" style={{ ...INPUT, flex: 1 }} />
            <input value={form.group ?? ''} onChange={e => setForm(f => ({ ...f, group: e.target.value }))}
              placeholder="分组" style={{ ...INPUT, width: 80 }} />
          </div>
          <textarea value={form.command ?? ''} onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
            placeholder="命令内容（支持 ${变量} 占位符）*" style={{ ...TEXTAREA, marginBottom: 6 }} />
          <input value={form.desc ?? ''} onChange={e => setForm(f => ({ ...f, desc: e.target.value }))}
            placeholder="说明（可选）" style={{ ...INPUT, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={submitSnippet}
              style={{ flex: 1, padding: '5px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <Check size={12} /> {editId ? '保存修改' : '添加'}
            </button>
            <button onClick={() => { setAdding(false); setEditId(null); setForm({ group: '通用' }) }}
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {snippets.length === 0 ? '尚无片段，点击 + 添加' : '无匹配结果'}
          </div>
        )}
        {filtered.map(s => (
          <div key={s.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'flex-start', gap: 8 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{s.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 8 }}>{s.group}</span>
              </div>
              <code style={{ fontSize: 11, color: 'var(--accent)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.command}</code>
              {s.desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s.desc}</div>}
            </div>
            <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
              <button style={BTN} data-tip="执行" onClick={() => run(s.command)}><Play size={13} color="#16a34a" /></button>
              <button style={BTN} data-tip="编辑" onClick={() => startEdit(s)}><Edit2 size={12} /></button>
              <button style={BTN} data-tip="删除" onClick={() => deleteSnippet(s.id)}><Trash2 size={12} color="#dc2626" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
