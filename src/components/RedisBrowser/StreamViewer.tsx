// R2.6 Stream XRANGE 分页浏览 + 追加条目 + 消费组列表
import { useState, useEffect, useCallback } from 'react'
import { Plus, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface Props { connectionId: string; keyName: string; db: number; total: number }

interface StreamEntry { id: string; fields: [string, string][] }
interface StreamRangeResult { entries: StreamEntry[]; total: number }
interface StreamGroup { name: string; consumers: number; pending: number; lastId: string }

const PAGE_SIZE = 50

export default function StreamViewer({ connectionId, keyName, db, total: initTotal }: Props) {
  const [entries,   setEntries]  = useState<StreamEntry[]>([])
  const [total,     setTotal]    = useState(initTotal)
  const [startId,   setStartId]  = useState('-')
  const [endId,     setEndId]    = useState('+')
  const [loading,   setLoading]  = useState(false)
  const [error,     setError]    = useState('')
  const [groups,    setGroups]   = useState<StreamGroup[]>([])
  const [groupsOpen,setGroupsOpen]= useState(false)
  const [expanded,  setExpanded] = useState<Set<string>>(new Set())
  // 追加
  const [adding,    setAdding]   = useState(false)
  const [newFields, setNewFields]= useState<[string, string][]>([['', '']])
  const [newId,     setNewId]    = useState('*')
  // 分页 cursor (last entry id)
  const [cursor,    setCursor]   = useState<string | null>(null)
  const [hasMore,   setHasMore]  = useState(false)

  const load = useCallback(async (start: string, append: boolean) => {
    setLoading(true)
    try {
      const res = await invoke<StreamRangeResult>('redis_stream_range', {
        id: connectionId, key: keyName, startId: start, endId, count: PAGE_SIZE, reverse: false, db,
      })
      setEntries(prev => append ? [...prev, ...res.entries] : res.entries)
      setTotal(res.total)
      if (res.entries.length === PAGE_SIZE) {
        const lastId = res.entries[res.entries.length - 1].id
        const parts = lastId.split('-')
        const nextMs = parts[0]
        const nextSeq = String(Number(parts[1] ?? 0) + 1)
        setCursor(`${nextMs}-${nextSeq}`)
        setHasMore(true)
      } else {
        setCursor(null)
        setHasMore(false)
      }
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, keyName, db, endId])

  const loadGroups = useCallback(async () => {
    try {
      const res = await invoke<StreamGroup[]>('redis_stream_groups', {
        id: connectionId, key: keyName, db,
      })
      setGroups(res)
    } catch (e) { /* stream 可能无消费组 */ }
  }, [connectionId, keyName, db])

  useEffect(() => { load('-', false); loadGroups() }, [load, loadGroups])

  const addEntry = async () => {
    const validFields = newFields.filter(([k]) => k.trim())
    if (validFields.length === 0) { setError('至少需要一个字段'); return }
    try {
      await invoke<string>('redis_stream_add', {
        id: connectionId, key: keyName, entryId: newId || '*',
        fields: Object.fromEntries(validFields), db,
      })
      setAdding(false)
      setNewFields([['', '']])
      setNewId('*')
      load('-', false)
      loadGroups()
    } catch (e) { setError(String(e)) }
  }

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="redis-type-editor">
      <div className="redis-type-toolbar">
        <span className="redis-type-count">{total} 个条目</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>范围</label>
          <input
            value={startId}
            onChange={e => setStartId(e.target.value)}
            style={{ width: 70, fontSize: 11 }}
            placeholder="-"
          />
          <span style={{ color: 'var(--text-muted)' }}>~</span>
          <input
            value={endId}
            onChange={e => setEndId(e.target.value)}
            style={{ width: 70, fontSize: 11 }}
            placeholder="+"
            onKeyDown={e => { if (e.key === 'Enter') load(startId, false) }}
          />
        </div>
        <button className="ssh-panel__btn ssh-panel__btn--text" onClick={() => load(startId, false)} title="应用范围">刷新</button>
        <button className="ssh-panel__btn" onClick={() => setAdding(a => !a)} title="追加条目">
          <Plus size={12} strokeWidth={2} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}

      {/* 追加条目 */}
      {adding && (
        <div className="redis-hash-add-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', width: 40 }}>ID</label>
            <input
              className="redis-hash-field-input"
              style={{ width: 120 }}
              value={newId}
              onChange={e => setNewId(e.target.value)}
              placeholder="* 自动生成"
            />
          </div>
          {newFields.map(([k, v], i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <input
                className="redis-hash-field-input"
                placeholder="字段"
                value={k}
                onChange={e => {
                  const next = [...newFields]; next[i] = [e.target.value, v]
                  setNewFields(next)
                }}
              />
              <input
                className="redis-hash-value-input"
                style={{ flex: 1 }}
                placeholder="值"
                value={v}
                onChange={e => {
                  const next = [...newFields]; next[i] = [k, e.target.value]
                  setNewFields(next)
                }}
              />
              {newFields.length > 1 && (
                <button
                  style={{ fontSize: 12, padding: '2px 6px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--error)' }}
                  onClick={() => setNewFields(f => f.filter((_, j) => j !== i))}
                >✕</button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="cdlg-btn cdlg-btn--cancel"
              style={{ padding: '3px 10px', fontSize: 11 }}
              onClick={() => setNewFields(f => [...f, ['', '']])}
            >+ 字段</button>
            <span style={{ flex: 1 }} />
            <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px' }} onClick={() => setAdding(false)}>取消</button>
            <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px' }} onClick={addEntry}>追加</button>
          </div>
        </div>
      )}

      {/* 条目列表 */}
      <div className="redis-stream-list">
        {entries.map(entry => (
          <div key={entry.id} className="redis-stream-entry">
            <div
              className="redis-stream-entry__header"
              onClick={() => toggleExpand(entry.id)}
              style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center', padding: '4px 6px', borderBottom: '1px solid var(--border-subtle)' }}
            >
              {expanded.has(entry.id)
                ? <ChevronDown size={11} strokeWidth={2} />
                : <ChevronRight size={11} strokeWidth={2} />
              }
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>{entry.id}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{entry.fields.length} 个字段</span>
            </div>
            {expanded.has(entry.id) && (
              <table className="redis-hash-table" style={{ marginTop: 0 }}>
                <tbody>
                  {entry.fields.map(([k, v]) => (
                    <tr key={k}>
                      <td className="redis-hash-field" style={{ width: 120 }}>{k}</td>
                      <td className="redis-hash-value">
                        <span className="redis-hash-val-text" title={v}>{v}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      {loading && <div className="redis-type-loading"><Loader2 size={14} className="spin" /></div>}

      {hasMore && !loading && (
        <button className="redis-more-btn" onClick={() => cursor && load(cursor, true)}>加载更多</button>
      )}

      {/* 消费组 */}
      {groups.length > 0 && (
        <div className="redis-stream-groups" style={{ marginTop: 12, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '2px 6px' }}
            onClick={() => setGroupsOpen(o => !o)}
          >
            {groupsOpen ? <ChevronDown size={11} strokeWidth={2} /> : <ChevronRight size={11} strokeWidth={2} />}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>消费组 ({groups.length})</span>
          </div>
          {groupsOpen && (
            <table className="redis-hash-table">
              <thead>
                <tr><th>名称</th><th>消费者</th><th>待确认</th><th>最后ID</th></tr>
              </thead>
              <tbody>
                {groups.map(g => (
                  <tr key={g.name}>
                    <td className="redis-hash-field">{g.name}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{g.consumers}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{g.pending}</td>
                    <td className="redis-hash-value"><span className="redis-hash-val-text">{g.lastId}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
