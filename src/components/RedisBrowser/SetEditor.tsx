// R2.4 Set 分页浏览 + 增删成员
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2, Search } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props { connectionId: string; keyName: string; db: number }
interface SetScanResult { members: string[]; cursor: number; hasMore: boolean; total: number }

export default function SetEditor({ connectionId, keyName, db }: Props) {
  const [members,  setMembers] = useState<string[]>([])
  const [cursor,   setCursor]  = useState(0)
  const [hasMore,  setHasMore] = useState(false)
  const [total,    setTotal]   = useState(0)
  const [loading,  setLoading] = useState(false)
  const [search,   setSearch]  = useState('')
  const [error,    setError]   = useState('')
  const [adding,   setAdding]  = useState(false)
  const [newMember,setNewMember]=useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = useCallback(async (cur: number, append: boolean) => {
    setLoading(true)
    try {
      const res = await invoke<SetScanResult>('redis_set_scan', {
        id: connectionId, key: keyName, cursor: cur, search: search || undefined, count: 100, db,
      })
      setMembers(prev => append ? [...prev, ...res.members] : res.members)
      setCursor(res.cursor)
      setHasMore(res.hasMore)
      setTotal(res.total)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, keyName, db, search])

  useEffect(() => { load(0, false) }, [load])

  const addMember = async () => {
    if (!newMember.trim()) return
    try {
      await invoke('redis_set_add', { id: connectionId, key: keyName, members: [newMember.trim()], db })
      setAdding(false); setNewMember('')
      load(0, false)
    } catch (e) { setError(String(e)) }
  }

  const delMember = async (m: string) => {
    try {
      await invoke('redis_set_remove', { id: connectionId, key: keyName, members: [m], db })
      setMembers(prev => prev.filter(x => x !== m))
      setTotal(t => t - 1)
    } catch (e) { setError(String(e)) }
    setConfirmDel(null)
  }

  return (
    <div className="redis-type-editor">
      <div className="redis-type-toolbar">
        <div className="redis-search" style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6 }}>
          <Search size={11} className="redis-search__icon" />
          <input className="redis-search__input" placeholder="搜索成员…" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(0, false) }} />
        </div>
        <span className="redis-type-count">{total} 个成员</span>
        <button className="ssh-panel__btn" title="新增成员" onClick={() => setAdding(true)}>
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {adding && (
        <div className="redis-hash-add-row">
          <input autoFocus className="redis-hash-value-input" placeholder="成员值"
            value={newMember} onChange={e => setNewMember(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addMember(); if (e.key === 'Escape') setAdding(false) }} />
          <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px' }} onClick={() => setAdding(false)}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px' }} onClick={addMember}>添加</button>
        </div>
      )}

      <div className="redis-set-list">
        {members.map(m => (
          <div key={m} className="redis-set-item">
            <span className="redis-hash-val-text" title={m}>{m}</span>
            <button className="cmd-act-btn danger" onClick={() => setConfirmDel(m)} title="删除">
              <Trash2 size={11} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>

      {loading && <div className="redis-type-loading"><Loader2 size={14} className="spin" /></div>}
      {hasMore && !loading && (
        <button className="redis-more-btn" onClick={() => load(cursor, true)}>加载更多</button>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title="删除成员"
        desc={`确认删除成员 "${confirmDel}"？`}
        danger okText="删除"
        onOk={() => confirmDel && delMember(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  )
}
