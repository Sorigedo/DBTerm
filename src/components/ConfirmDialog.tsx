import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, AlertCircle } from 'lucide-react'
import { useConfirmStore } from '../stores/confirmStore'

// 全局命令式确认弹窗：由 confirmStore.ask / requireProdConfirm 触发。
const TONE = {
  prod:   { color: '#ea580c', Icon: ShieldAlert },
  danger: { color: '#dc2626', Icon: ShieldAlert },
  info:   { color: 'var(--accent)', Icon: AlertCircle },
} as const

export default function ConfirmDialog() {
  const pending = useConfirmStore(s => s.pending)
  const answer = useConfirmStore(s => s.answer)

  useEffect(() => {
    if (!pending) return
    // 仅 Esc 取消；不绑定 Enter=确认——否则触发确认的那次按键（如单元格编辑按 Enter 提交）
    // 会被刚挂载的对话框当成确认，瞬间自动通过。生产/危险操作必须显式点击「确认」。
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); answer(false) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, answer])

  if (!pending) return null
  const { color, Icon } = TONE[pending.tone]

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={() => answer(false)} style={{ zIndex: 100002 }}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 460, padding: 22, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={17} color={color} />
          <span style={{ fontWeight: 700, fontSize: 14.5, color }}>{pending.title}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.65 }}>{pending.message}</div>
        {pending.detail && (
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)',
            borderRadius: 7, padding: '8px 10px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflow: 'auto' }}>
            {pending.detail}
          </pre>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <button onClick={() => answer(false)}
            style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>取消</button>
          <button onClick={() => answer(true)}
            style={{ padding: '6px 16px', borderRadius: 8, background: color, color: '#fff', fontSize: 13, fontWeight: 600 }}>{pending.confirmText ?? '确认'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
