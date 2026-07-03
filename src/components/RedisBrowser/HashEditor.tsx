// R2.2 Hash 字段级增删改
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Loader2, Search } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props {
  connectionId: string
  keyName: string
  db: number
}

interface HashField { field: string; value: string; binary?: boolean }
interface HashScanResult { fields: HashField[]; cursor: number; hasMore: boolean; total: number }

export default function HashEditor({ connectionId, keyName, db }: Props) {
  const [fields,   setFields]   = useState<HashField[]>([])
  const [cursor,   setCursor]   = useState(0)
  const [hasMore,  setHasMore]  = useState(false)
  const [total,    setTotal]    = useState(0)
  const [loading,  setLoading]  = useState(false)
  const [search,   setSearch]   = useState('')
  const [error,    setError]    = useState('')
  // 行内编辑
  const [editing,  setEditing]  = useState<{ field: string; value: string } | null>(null)
  const [editVal,  setEditVal]  = useState('')
  // 新增字段
  const [adding,   setAdding]   = useState(false)
  const [newField, setNewField] = useState('')
  const [newVal,   setNewVal]   = useState('')
  // 删除确认
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = useCallback(async (cur: number, append: boolean) => {
    setLoading(true)
    try {
      const res = await invoke<HashScanResult>('redis_hash_scan', {
        id: connectionId, key: keyName, cursor: cur, search: search || undefined, count: 100, db,
      })
      setFields(prev => append ? [...prev, ...res.fields] : res.fields)
      setCursor(res.cursor)
      setHasMore(res.hasMore)
      setTotal(res.total)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, keyName, db, search])

  useEffect(() => { load(0, false) }, [load])

  const saveEdit = async () => {
    if (!editing) return
    try {
      await invoke('redis_hash_set', { id: connectionId, key: keyName, field: editing.field, value: editVal, db })
      setFields(prev => prev.map(f => f.field === editing.field ? { ...f, value: editVal } : f))
      setEditing(null)
    } catch (e) { setError(String(e)) }
  }

  const addField = async () => {
    if (!newField.trim()) return
    try {
      await invoke('redis_hash_set', { id: connectionId, key: keyName, field: newField.trim(), value: newVal, db })
      setAdding(false)
      setNewField(''); setNewVal('')
      load(0, false)
    } catch (e) { setError(String(e)) }
  }

  const delField = async (field: string) => {
    try {
      await invoke('redis_hash_del', { id: connectionId, key: keyName, fields: [field], db })
      setFields(prev => prev.filter(f => f.field !== field))
      setTotal(t => t - 1)
    } catch (e) { setError(String(e)) }
    setConfirmDel(null)
  }

  return (
    <div className="redis-type-editor">
      <div className="redis-type-toolbar">
        <div className="redis-search" style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6 }}>
          <Search size={11} className="redis-search__icon" />
          <input
            className="redis-search__input"
            placeholder="搜索字段…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') load(0, false) }}
          />
        </div>
        <span className="redis-type-count">{total} 个字段</span>
        <button className="ssh-panel__btn" title="新增字段" onClick={() => setAdding(true)}>
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {/* 新增行 */}
      {adding && (
        <div className="redis-hash-add-row">
          <input
            className="redis-hash-field-input"
            autoFocus
            placeholder="字段名"
            value={newField}
            onChange={e => setNewField(e.target.value)}
          />
          <input
            className="redis-hash-value-input"
            placeholder="值"
            value={newVal}
            onChange={e => setNewVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addField(); if (e.key === 'Escape') setAdding(false) }}
          />
          <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px' }} onClick={() => setAdding(false)}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px' }} onClick={addField}>添加</button>
        </div>
      )}

      <table className="redis-hash-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>值</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {fields.map(f => (
            <tr key={f.field}>
              <td className="redis-hash-field" title={f.field}>{f.field}</td>
              <td
                className="redis-hash-value"
                onClick={() => { if (!f.binary) { setEditing(f); setEditVal(f.value) } }}
                title={f.binary ? '二进制值，不支持文本编辑' : '点击编辑'}
                style={f.binary ? { cursor: 'default' } : undefined}
              >
                {f.binary ? (
                  <span className="redis-hash-val-text" title={f.value} style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    <span className="redis-binary-badge">二进制</span>{f.value}
                  </span>
                ) : editing?.field === f.field ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input
                      autoFocus
                      value={editVal}
                      onChange={e => setEditVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null) }}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 8px', fontSize: 11 }} onClick={saveEdit}>✓</button>
                  </div>
                ) : (
                  <span className="redis-hash-val-text" title={f.value}>{f.value}</span>
                )}
              </td>
              <td>
                <button
                  className="cmd-act-btn danger"
                  onClick={() => setConfirmDel(f.field)}
                  title="删除字段"
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {loading && <div className="redis-type-loading"><Loader2 size={14} className="spin" /></div>}
      {hasMore && !loading && (
        <button className="redis-more-btn" onClick={() => load(cursor, true)}>加载更多</button>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title="删除字段"
        desc={`确认删除字段 "${confirmDel}"？`}
        danger okText="删除"
        onOk={() => confirmDel && delField(confirmDel)}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  )
}
