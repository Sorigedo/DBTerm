import { useMemo, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { History, Pin, PinOff, Trash2, X, Search, CheckCircle2, XCircle, Clock, Rows, Copy, Save, CornerDownLeft } from 'lucide-react'
import { useQueryHistoryStore } from '../../stores/queryHistoryStore'
import { copyText } from '../../utils/clipboard'
import { addSavedQuery } from '../../utils/savedQueries'
import { toast } from '../../stores/toastStore'

interface Props {
  connectionId: string
  /** 面板宽度（由外层拖拽控制），覆盖 CSS 默认宽度 */
  width?: number
  onPick: (sql: string) => void
  /** 打开统一的「保存查询」对话框（保存到左侧连接树下的「保存的查询」） */
  onSaveAsQuery?: (sql: string) => void
  onClose: () => void
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

type Filter = 'all' | 'ok' | 'fail' | 'pinned'

export default function QueryHistoryPanel({ connectionId, width, onPick, onSaveAsQuery, onClose }: Props) {
  const allEntries = useQueryHistoryStore((s) => s.entries)
  const togglePin  = useQueryHistoryStore((s) => s.togglePin)
  const remove     = useQueryHistoryStore((s) => s.remove)
  const clear      = useQueryHistoryStore((s) => s.clear)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const entries = useMemo(() => {
    let mine = allEntries.filter(e => e.connId === connectionId)
    if (filter === 'ok') mine = mine.filter(e => e.success)
    else if (filter === 'fail') mine = mine.filter(e => !e.success)
    else if (filter === 'pinned') mine = mine.filter(e => e.pinned)
    if (q.trim()) mine = mine.filter(e => e.sql.toLowerCase().includes(q.trim().toLowerCase()))
    return [...mine].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at)
  }, [allEntries, connectionId, q, filter])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; sql: string; pinned: boolean } | null>(null)

  const doCopy = (sql: string) => { copyText(sql); toast.success('已复制 SQL') }
  const doSave = (sql: string) => {
    // 走统一的「保存查询」对话框（保存到左侧连接树下「保存的查询」）；
    // 兜底（未传 onSaveAsQuery）才用直接保存。
    if (onSaveAsQuery) { onSaveAsQuery(sql); onClose(); return }
    addSavedQuery({ name: sql.replace(/\s+/g, ' ').trim().slice(0, 40), sql, connId: connectionId }, Date.now())
    toast.success('已保存到「保存的查询」')
  }

  // 右键菜单：点击空白/再次右键即关闭
  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    const t = setTimeout(() => {
      document.addEventListener('click', close)
      document.addEventListener('contextmenu', close)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
    }
  }, [ctx])

  return (
    <div className="qh-panel" style={width ? { width } : undefined}>
      <div className="qh-head">
        <span className="qh-head__title"><History size={13} strokeWidth={1.8} /> 查询历史</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="ssh-panel__btn" onClick={() => clear(connectionId)} data-tip="清空历史（保留收藏）">
            <Trash2 size={12} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" onClick={onClose} data-tip="关闭">
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="qh-search">
        <Search size={12} className="qh-search__icon" />
        <input
          placeholder="搜索 SQL..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      {/* K4 筛选条 */}
      <div style={{ display: 'flex', gap: 4, padding: '4px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        {(['all', 'ok', 'fail', 'pinned'] as Filter[]).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border)',
            background: filter === f ? 'var(--accent)' : 'transparent',
            color: filter === f ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
          }}>
            {f === 'all' ? '全部' : f === 'ok' ? '成功' : f === 'fail' ? '失败' : '收藏'}
          </button>
        ))}
      </div>

      <div className="qh-list">
        {entries.length === 0 && (
          <div className="qh-empty">{q ? '没有匹配的记录' : '暂无查询历史'}</div>
        )}
        {entries.map(e => (
          <div key={e.id} className={`qh-item${e.pinned ? ' qh-item--pinned' : ''}${selectedId === e.id ? ' qh-item--selected' : ''}`}>
            <div
              className="qh-item__body"
              tabIndex={0}
              role="button"
              data-tip="双击回填 · 右键更多"
              onClick={() => setSelectedId(e.id)}
              onDoubleClick={() => onPick(e.sql)}
              onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); setSelectedId(e.id); setCtx({ x: ev.clientX, y: ev.clientY, id: e.id, sql: e.sql, pinned: e.pinned }) }}
              onKeyDown={ev => {
                if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'c' || ev.key === 'C')) { ev.preventDefault(); doCopy(e.sql) }
                else if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); doSave(e.sql) }
                else if (ev.key === 'Enter') { ev.preventDefault(); onPick(e.sql) }
              }}
            >
              <span className="qh-item__sql">{e.sql}</span>
              <span className="qh-item__meta">
                {e.success
                  ? <CheckCircle2 size={10} className="qh-item__ok" />
                  : <XCircle size={10} className="qh-item__fail" />
                }
                <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{fmtTime(e.at)}</span>
                {e.executionTimeMs !== undefined && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, color: e.executionTimeMs > 3000 ? '#dc2626' : e.executionTimeMs > 1000 ? '#ea580c' : 'var(--text-muted)', fontSize: 10 }}>
                    <Clock size={9} />{fmtMs(e.executionTimeMs)}
                  </span>
                )}
                {e.rowsAffected !== undefined && e.rowsAffected > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2, color: 'var(--text-muted)', fontSize: 10 }}>
                    <Rows size={9} />{e.rowsAffected}行
                  </span>
                )}
                {!e.success && e.error && (
                  <span style={{ fontSize: 10, color: 'var(--error)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.error}>{e.error}</span>
                )}
              </span>
            </div>
            <div className="qh-item__acts">
              <button className="file-act-btn" onClick={() => copyText(e.sql)} data-tip="复制 SQL">
                <Copy size={11} />
              </button>
              <button className="file-act-btn" onClick={() => togglePin(e.id)} data-tip={e.pinned ? '取消收藏' : '收藏（置顶且不过期）'}>
                {e.pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              <button className="file-act-btn danger" onClick={() => remove(e.id)} data-tip="删除">
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {ctx && createPortal(
        <div className="db-ctx-menu" style={{ position: 'fixed', top: ctx.y, left: ctx.x, zIndex: 9999 }}
          onContextMenu={ev => ev.preventDefault()}>
          <button onClick={() => { onPick(ctx.sql); setCtx(null) }}>
            <CornerDownLeft size={12} strokeWidth={1.8} />回填到编辑器
          </button>
          <button onClick={() => { doCopy(ctx.sql); setCtx(null) }}>
            <Copy size={12} strokeWidth={1.8} />复制 SQL
          </button>
          <button onClick={() => { doSave(ctx.sql); setCtx(null) }}>
            <Save size={12} strokeWidth={1.8} />保存为查询
          </button>
          <button onClick={() => { togglePin(ctx.id); setCtx(null) }}>
            {ctx.pinned ? <PinOff size={12} strokeWidth={1.8} /> : <Pin size={12} strokeWidth={1.8} />}
            {ctx.pinned ? '取消收藏' : '收藏'}
          </button>
          <div className="db-ctx-menu__sep" />
          <button className="danger" onClick={() => { remove(ctx.id); if (selectedId === ctx.id) setSelectedId(null); setCtx(null) }}>
            <Trash2 size={12} strokeWidth={1.8} />删除
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
