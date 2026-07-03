import { useState, useEffect, useRef } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { useSchemaVisibilityStore } from '../../stores/schemaVisibilityStore'

// ── Schema 可见性过滤浮窗 ─────────────────────────────────────────
// 勾选只改本地暂存状态，点「应用」才提交到 store；不监听任何外部点击，
// 唯一关闭途径：取消 / ✕ / Esc。独立模块，避免与父组件 HMR 串扰。
export default function SchemaFilterPopup({ connId, anchorEl, schemas, loading, onClose }: {
  connId: string
  anchorEl: HTMLElement
  schemas: string[]
  loading: boolean
  onClose: () => void
}) {
  const hidden    = useSchemaVisibilityStore(s => s.hidden[connId] ?? [])
  const setHidden = useSchemaVisibilityStore(s => s.setHidden)
  // 本地暂存：勾选只改本地状态，点「应用」才提交，支持多次勾选后统一确认
  const [localHidden, setLocalHidden] = useState<string[]>(hidden)
  const toggle = (schema: string) => {
    setLocalHidden(prev => prev.includes(schema) ? prev.filter(s => s !== schema) : [...prev, schema])
  }
  const dirty = localHidden.length !== hidden.length || localHidden.some(s => !hidden.includes(s))
  const apply = () => { setHidden(connId, localHidden); onClose() }

  // 仅 Esc 关闭（不监听 mousedown/click，杜绝误关）；Esc = 取消，不提交
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 位置在挂载时定格，避免重渲染时锚点瞬态脱离导致弹窗跳走/看似关闭
  const [pos] = useState(() => {
    const r = anchorEl.getBoundingClientRect()
    return { top: r.bottom + 4, right: window.innerWidth - r.right }
  })
  const hiddenSet = new Set(localHidden)

  return (
    <div
      style={{
        position: 'fixed', top: pos.top, right: pos.right, zIndex: 9998,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        minWidth: 200, maxWidth: 280, overflow: 'hidden',
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px 8px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          显示 Schema
        </span>
        {localHidden.length > 0 && (
          <button
            style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            onClick={() => setLocalHidden([])}
          >
            全部显示
          </button>
        )}
        <button
          data-tip="关闭"
          onClick={onClose}
          style={{ display: 'flex', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0 }}
        >
          <X size={13} />
        </button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', padding: '4px 0' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
            <Loader2 size={12} className="spin" />
            <span>加载中…</span>
          </div>
        ) : schemas.length === 0 ? (
          <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>无 Schema</div>
        ) : schemas.map(s => {
          const visible = !hiddenSet.has(s)
          return (
            <div
              key={s}
              onClick={e => { e.stopPropagation(); toggle(s) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px',
                cursor: 'pointer', fontSize: 12, color: visible ? 'var(--text)' : 'var(--text-muted)',
                userSelect: 'none',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              {/* 自绘复选框 */}
              <div style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                border: `1.5px solid ${visible ? 'var(--accent)' : 'var(--border)'}`,
                background: visible ? 'var(--accent)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.1s, border-color 0.1s',
              }}>
                {visible && <Check size={9} color="white" strokeWidth={3} />}
              </div>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
            </div>
          )
        })}
      </div>
      {/* 底部操作：勾选完成后主动提交 */}
      {!loading && schemas.length > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '8px 12px', borderTop: '1px solid var(--border-subtle)',
        }}>
          <button
            onClick={onClose}
            style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
              background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
            }}
          >
            取消
          </button>
          <button
            onClick={apply}
            disabled={!dirty}
            style={{
              fontSize: 12, padding: '4px 12px', borderRadius: 8,
              cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5,
              background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 600,
            }}
          >
            应用
          </button>
        </div>
      )}
    </div>
  )
}
