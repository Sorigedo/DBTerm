// R2.3 List 分页浏览 + 头尾插入 + 行内编辑 + 删除
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props {
  connectionId: string
  keyName: string
  db: number
  total: number
}

interface ListPage { items: string[]; total: number; offset: number }

const PAGE_SIZE = 100

export default function ListEditor({ connectionId, keyName, db, total: initTotal }: Props) {
  const [items,   setItems]   = useState<string[]>([])
  const [offset,  setOffset]  = useState(0)
  const [total,   setTotal]   = useState(initTotal)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [editing, setEditing] = useState<{ index: number; val: string } | null>(null)
  const [adding,  setAdding]  = useState(false)
  const [newVal,  setNewVal]  = useState('')
  const [addHead, setAddHead] = useState(false)
  const [confirmDel, setConfirmDel] = useState<number | null>(null)

  const load = useCallback(async (off: number) => {
    setLoading(true)
    try {
      const res = await invoke<ListPage>('redis_list_range', {
        id: connectionId, key: keyName, offset: off, count: PAGE_SIZE, db,
      })
      setItems(res.items)
      setTotal(res.total)
      setOffset(off)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, keyName, db])

  useEffect(() => { load(0) }, [load])

  const saveEdit = async () => {
    if (!editing) return
    try {
      await invoke('redis_list_set', { id: connectionId, key: keyName, index: offset + editing.index, value: editing.val, db })
      setItems(prev => prev.map((v, i) => i === editing.index ? editing.val : v))
      setEditing(null)
    } catch (e) { setError(String(e)) }
  }

  const addItem = async () => {
    if (!newVal.trim() && newVal !== '') return
    try {
      const newLen = await invoke<number>('redis_list_push', { id: connectionId, key: keyName, value: newVal, head: addHead, db })
      setAdding(false)
      setNewVal('')
      setTotal(newLen)
      load(addHead ? 0 : Math.max(0, newLen - PAGE_SIZE))
    } catch (e) { setError(String(e)) }
  }

  const delItem = async (index: number) => {
    const val = items[index]
    try {
      await invoke('redis_list_remove', { id: connectionId, key: keyName, value: val, count: 1, db })
      load(offset)
    } catch (e) { setError(String(e)) }
    setConfirmDel(null)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE)

  return (
    <div className="redis-type-editor">
      <div className="redis-type-toolbar">
        <span className="redis-type-count">{total} 个元素</span>
        <span style={{ flex: 1 }} />
        <button
          className="ssh-panel__btn ssh-panel__btn--text"
          title={addHead ? '从头部插入' : '从尾部插入'}
          onClick={() => setAddHead(h => !h)}
        >
          {addHead ? 'LPUSH' : 'RPUSH'}
        </button>
        <button className="ssh-panel__btn" title="插入元素" onClick={() => setAdding(true)}>
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {adding && (
        <div className="redis-hash-add-row">
          <input
            autoFocus className="redis-hash-value-input"
            placeholder={`值（${addHead ? '插入头部' : '插入尾部'}）`}
            value={newVal}
            onChange={e => setNewVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addItem(); if (e.key === 'Escape') setAdding(false) }}
          />
          <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px' }} onClick={() => setAdding(false)}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px' }} onClick={addItem}>添加</button>
        </div>
      )}

      <table className="redis-hash-table">
        <thead><tr><th style={{ width: 50 }}>#</th><th>值</th><th style={{ width: 40 }}></th></tr></thead>
        <tbody>
          {items.map((val, i) => (
            <tr key={offset + i}>
              <td className="redis-hash-field" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{offset + i}</td>
              <td className="redis-hash-value" onClick={() => setEditing({ index: i, val })}>
                {editing?.index === i ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      autoFocus value={editing.val}
                      onChange={e => setEditing({ index: i, val: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 8px', fontSize: 11 }} onClick={saveEdit}>✓</button>
                  </div>
                ) : (
                  <span className="redis-hash-val-text" title={val}>{val}</span>
                )}
              </td>
              <td>
                <button className="cmd-act-btn danger" onClick={() => setConfirmDel(i)} title="删除">
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
        title="删除元素"
        desc={`确认删除索引 ${confirmDel !== null ? offset + confirmDel : ''} 处的元素？`}
        danger okText="删除"
        onOk={() => confirmDel !== null && delItem(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  )
}
