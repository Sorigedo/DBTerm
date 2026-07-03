// R2.5 ZSet 分页浏览 + 增改 score + 删除
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props { connectionId: string; keyName: string; db: number; total: number }

interface ZSetPage {
  members: { member: string; score: number }[]
  total: number; offset: number
}

const PAGE_SIZE = 100

export default function ZSetEditor({ connectionId, keyName, db, total: initTotal }: Props) {
  const [members,  setMembers]  = useState<{ member: string; score: number }[]>([])
  const [offset,   setOffset]   = useState(0)
  const [total,    setTotal]    = useState(initTotal)
  const [reverse,  setReverse]  = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [editing,  setEditing]  = useState<{ member: string; score: string } | null>(null)
  const [adding,   setAdding]   = useState(false)
  const [newMember,setNewMember]= useState('')
  const [newScore, setNewScore] = useState('0')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = useCallback(async (off: number) => {
    setLoading(true)
    try {
      const res = await invoke<ZSetPage>('redis_zset_range', {
        id: connectionId, key: keyName, offset: off, count: PAGE_SIZE, reverse, db,
      })
      setMembers(res.members)
      setTotal(res.total)
      setOffset(off)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, keyName, db, reverse])

  useEffect(() => { load(0) }, [load])

  const saveScore = async () => {
    if (!editing) return
    const s = parseFloat(editing.score)
    if (isNaN(s)) { setError('score 必须是数字'); return }
    try {
      await invoke('redis_zset_add', { id: connectionId, key: keyName, member: editing.member, score: s, db })
      setMembers(prev => prev.map(m => m.member === editing.member ? { ...m, score: s } : m))
      setEditing(null)
    } catch (e) { setError(String(e)) }
  }

  const addMember = async () => {
    if (!newMember.trim()) return
    const s = parseFloat(newScore)
    if (isNaN(s)) { setError('score 必须是数字'); return }
    try {
      await invoke('redis_zset_add', { id: connectionId, key: keyName, member: newMember.trim(), score: s, db })
      setAdding(false); setNewMember(''); setNewScore('0')
      load(offset)
    } catch (e) { setError(String(e)) }
  }

  const delMember = async (m: string) => {
    try {
      await invoke('redis_zset_remove', { id: connectionId, key: keyName, members: [m], db })
      setMembers(prev => prev.filter(x => x.member !== m))
      setTotal(t => t - 1)
    } catch (e) { setError(String(e)) }
    setConfirmDel(null)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE)

  return (
    <div className="redis-type-editor">
      <div className="redis-type-toolbar">
        <span className="redis-type-count">{total} 个成员</span>
        <button className="ssh-panel__btn ssh-panel__btn--text" title="切换排序方向" onClick={() => setReverse(r => !r)}>
          {reverse ? 'score ↑' : 'score ↓'}
        </button>
        <button className="ssh-panel__btn" title="新增成员" onClick={() => setAdding(true)}>
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {adding && (
        <div className="redis-hash-add-row">
          <input autoFocus className="redis-hash-field-input" placeholder="成员"
            value={newMember} onChange={e => setNewMember(e.target.value)} />
          <input className="redis-hash-field-input" placeholder="score" type="number"
            value={newScore} onChange={e => setNewScore(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addMember(); if (e.key === 'Escape') setAdding(false) }}
            style={{ width: 80 }} />
          <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px' }} onClick={() => setAdding(false)}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px' }} onClick={addMember}>添加</button>
        </div>
      )}

      <table className="redis-hash-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>成员</th>
            <th style={{ width: 100 }}>score</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr key={m.member}>
              <td style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                {reverse ? total - offset - i : offset + i + 1}
              </td>
              <td className="redis-hash-value">
                <span className="redis-hash-val-text" title={m.member}>{m.member}</span>
              </td>
              <td
                className="redis-hash-field"
                style={{ cursor: 'pointer', textAlign: 'right', paddingRight: 8 }}
                onClick={() => setEditing({ member: m.member, score: String(m.score) })}
                title="点击编辑 score"
              >
                {editing?.member === m.member ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      autoFocus type="number" value={editing.score}
                      onChange={e => setEditing({ member: m.member, score: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') saveScore(); if (e.key === 'Escape') setEditing(null) }}
                      style={{ width: 60, fontSize: 12 }}
                    />
                    <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 6px', fontSize: 11 }} onClick={saveScore}>✓</button>
                  </div>
                ) : m.score}
              </td>
              <td>
                <button className="cmd-act-btn danger" onClick={() => setConfirmDel(m.member)} title="删除">
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {loading && <div className="redis-type-loading"><Loader2 size={14} className="spin" /></div>}

      {totalPages > 1 && (
        <div className="redis-pagination">
          <button disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE_SIZE))}>‹ 上页</button>
          <span>第 {currentPage + 1} / {totalPages} 页</span>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => load(offset + PAGE_SIZE)}>下页 ›</button>
        </div>
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
