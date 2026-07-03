// R2.7 新建任意类型 key 的弹窗
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'

interface Props {
  connectionId: string
  db: number
  onCreated: (key?: string) => void
  onClose: () => void
}

const TYPES = ['string', 'list', 'hash', 'set', 'zset', 'stream'] as const
type KeyType = typeof TYPES[number]

export default function NewKeyDialog({ connectionId, db, onCreated, onClose }: Props) {
  const [keyName, setKeyName] = useState('')
  const [kind,    setKind]    = useState<KeyType>('string')
  const [ttl,     setTtl]     = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  // string
  const [strVal, setStrVal] = useState('')
  // list
  const [listItems, setListItems] = useState([''])
  // hash
  const [hashFields, setHashFields] = useState<[string, string][]>([['', '']])
  // set
  const [setMembers, setSetMembers] = useState([''])
  // zset
  const [zsetMembers, setZsetMembers] = useState<[string, string][]>([['', '0']])
  // stream
  const [streamFields, setStreamFields] = useState<[string, string][]>([['', '']])
  const [streamId, setStreamId] = useState('*')

  const submit = async () => {
    if (!keyName.trim()) { setError('Key 名称不能为空'); return }
    setSaving(true)
    setError('')
    try {
      const payload: Record<string, unknown> = {
        key: keyName.trim(),
        kind,
        ttlSecs: ttl ? parseInt(ttl) : null,
      }

      if (kind === 'string') payload.stringValue = strVal
      else if (kind === 'list') payload.listItems = listItems.filter(x => x !== '')
      else if (kind === 'hash') payload.hashFields = hashFields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])
      else if (kind === 'set') payload.setMembers = setMembers.filter(x => x !== '')
      else if (kind === 'zset') {
        const valid = zsetMembers.filter(([m]) => m.trim())
        payload.zsetMembers = valid.map(([m, s]) => [m.trim(), parseFloat(s) || 0])
      } else if (kind === 'stream') {
        payload.streamFields = streamFields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])
      }

      await invoke('redis_create_key', { id: connectionId, db, nx: false, payload })
      onCreated(keyName.trim())
    } catch (e) { setError(String(e)) }
    finally { setSaving(false) }
  }

  const updateList = (setter: (prev: string[]) => string[]) => setListItems(setter)
  const updateSetMem = (setter: (prev: string[]) => string[]) => setSetMembers(setter)

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        style={{ width: 480, maxHeight: '80vh', overflowY: 'auto' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="cdlg-head">
          <span className="cdlg-head__title">新建 Key</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="mfa-field">
            <label>Key 名称</label>
            <input
              autoFocus value={keyName}
              onChange={e => setKeyName(e.target.value)}
              placeholder="输入 key 名称"
            />
          </div>

          <div className="mfa-field">
            <label>类型</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => setKind(t)}
                  style={{
                    padding: '3px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                    background: kind === t ? 'var(--accent)' : 'var(--surface-2)',
                    color: kind === t ? '#fff' : 'var(--text)',
                    border: `1px solid ${kind === t ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >{t}</button>
              ))}
            </div>
          </div>

          <div className="mfa-field">
            <label>过期时间 (秒，可选)</label>
            <input
              type="number" min={0} value={ttl}
              onChange={e => setTtl(e.target.value)}
              placeholder="不填 = 永久"
            />
          </div>

          {/* 各类型初始值 */}
          {kind === 'string' && (
            <div className="mfa-field">
              <label>字符串值</label>
              <textarea
                value={strVal}
                onChange={e => setStrVal(e.target.value)}
                style={{ minHeight: 80, fontSize: 12, fontFamily: 'var(--font-mono)' }}
                placeholder="初始值"
              />
            </div>
          )}

          {kind === 'list' && (
            <div className="mfa-field">
              <label>初始元素（每行一个）</label>
              {listItems.map((v, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input value={v} onChange={e => updateList(prev => prev.map((x, j) => j === i ? e.target.value : x))} placeholder={`元素 ${i + 1}`} style={{ flex: 1 }} />
                  {listItems.length > 1 && <button onClick={() => updateList(prev => prev.filter((_, j) => j !== i))} className="btn-icon-danger">✕</button>}
                </div>
              ))}
              <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => updateList(prev => [...prev, ''])}>+ 元素</button>
            </div>
          )}

          {kind === 'hash' && (
            <div className="mfa-field">
              <label>初始字段</label>
              {hashFields.map(([k, v], i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input value={k} onChange={e => setHashFields(prev => prev.map((f, j) => j === i ? [e.target.value, f[1]] : f))} placeholder="字段名" style={{ width: 120 }} />
                  <input value={v} onChange={e => setHashFields(prev => prev.map((f, j) => j === i ? [f[0], e.target.value] : f))} placeholder="值" style={{ flex: 1 }} />
                  {hashFields.length > 1 && <button onClick={() => setHashFields(prev => prev.filter((_, j) => j !== i))} className="btn-icon-danger">✕</button>}
                </div>
              ))}
              <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setHashFields(prev => [...prev, ['', '']])}>+ 字段</button>
            </div>
          )}

          {kind === 'set' && (
            <div className="mfa-field">
              <label>初始成员</label>
              {setMembers.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input value={m} onChange={e => updateSetMem(prev => prev.map((x, j) => j === i ? e.target.value : x))} placeholder={`成员 ${i + 1}`} style={{ flex: 1 }} />
                  {setMembers.length > 1 && <button onClick={() => updateSetMem(prev => prev.filter((_, j) => j !== i))} className="btn-icon-danger">✕</button>}
                </div>
              ))}
              <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => updateSetMem(prev => [...prev, ''])}>+ 成员</button>
            </div>
          )}

          {kind === 'zset' && (
            <div className="mfa-field">
              <label>初始成员</label>
              {zsetMembers.map(([m, s], i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input value={m} onChange={e => setZsetMembers(prev => prev.map((f, j) => j === i ? [e.target.value, f[1]] : f))} placeholder="成员" style={{ flex: 1 }} />
                  <input value={s} onChange={e => setZsetMembers(prev => prev.map((f, j) => j === i ? [f[0], e.target.value] : f))} placeholder="score" type="number" style={{ width: 70 }} />
                  {zsetMembers.length > 1 && <button onClick={() => setZsetMembers(prev => prev.filter((_, j) => j !== i))} className="btn-icon-danger">✕</button>}
                </div>
              ))}
              <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setZsetMembers(prev => [...prev, ['', '0']])}>+ 成员</button>
            </div>
          )}

          {kind === 'stream' && (
            <div className="mfa-field">
              <label>Stream ID（* 自动生成）</label>
              <input value={streamId} onChange={e => setStreamId(e.target.value)} placeholder="*" style={{ marginBottom: 8 }} />
              <label>初始字段</label>
              {streamFields.map(([k, v], i) => (
                <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <input value={k} onChange={e => setStreamFields(prev => prev.map((f, j) => j === i ? [e.target.value, f[1]] : f))} placeholder="字段" style={{ width: 120 }} />
                  <input value={v} onChange={e => setStreamFields(prev => prev.map((f, j) => j === i ? [f[0], e.target.value] : f))} placeholder="值" style={{ flex: 1 }} />
                  {streamFields.length > 1 && <button onClick={() => setStreamFields(prev => prev.filter((_, j) => j !== i))} className="btn-icon-danger">✕</button>}
                </div>
              ))}
              <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setStreamFields(prev => [...prev, ['', '']])}>+ 字段</button>
            </div>
          )}

          {error && <div className="redis-error">{error}</div>}
        </div>

        <div className="cdlg-foot">
          <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" disabled={saving} onClick={submit}>
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
