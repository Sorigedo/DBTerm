import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'
import { useToastStore, type ToastType } from '../stores/toastStore'

const ICONS: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error:   XCircle,
  info:    Info,
  warning: AlertTriangle,
}
const COLORS: Record<ToastType, string> = {
  success: '#16a34a',
  error:   '#dc2626',
  info:    'var(--accent)',
  warning: '#ea580c',
}
const TITLES: Record<ToastType, string> = {
  success: '已完成',
  error:   '操作失败',
  info:    '提示',
  warning: '请注意',
}

// 显示时长：错误/警告停留更久
const DURATION: Record<ToastType, number> = {
  success: 2200,
  info:    2600,
  warning: 4000,
  error:   4800,
}
const OUT_MS = 260 // 滑出动画时长

export default function Toaster() {
  const { toasts, dismiss } = useToastStore()
  const [exiting, setExiting] = useState<Set<number>>(new Set())
  const scheduled = useRef<Set<number>>(new Set())

  // 每条通知：到时先加滑出态，动画结束后真正移除；persistent 不自动消失
  useEffect(() => {
    for (const t of toasts) {
      if (scheduled.current.has(t.id)) continue
      scheduled.current.add(t.id)
      if (t.persistent) continue  // 手动点击才关闭
      setTimeout(() => {
        setExiting(s => { const n = new Set(s); n.add(t.id); return n })
        setTimeout(() => {
          dismiss(t.id)
          setExiting(s => { const n = new Set(s); n.delete(t.id); return n })
          scheduled.current.delete(t.id)
        }, OUT_MS)
      }, t.duration ?? DURATION[t.type])
    }
  }, [toasts, dismiss])

  const closeNow = (id: number) => {
    setExiting(s => { const n = new Set(s); n.add(id); return n })
    setTimeout(() => dismiss(id), OUT_MS)
  }

  if (toasts.length === 0) return null

  return createPortal(
    <div className="toast-stack">
      {toasts.map(t => {
        const Icon = ICONS[t.type]
        return (
          <div
            key={t.id}
            className={`toast-item toast-item--${t.type}${exiting.has(t.id) ? ' toast-item--out' : ''}`}
            style={{ ['--toast-accent' as string]: COLORS[t.type] }}
            role={t.type === 'error' || t.type === 'warning' ? 'alert' : 'status'}
            onClick={() => closeNow(t.id)}
          >
            <span className="toast-item__iconWrap">
              <Icon size={18} strokeWidth={2.5} color={COLORS[t.type]} className="toast-item__icon" />
            </span>
            <span className="toast-item__body">
              <span className="toast-item__title">{t.title || TITLES[t.type]}</span>
              <span className="toast-item__msg">{t.message}</span>
            </span>
            {t.action && (
              <button
                className="toast-item__action"
                onClick={(e) => { e.stopPropagation(); Promise.resolve(t.action!.onClick()).finally(() => closeNow(t.id)) }}
                style={{
                  marginLeft: 8, padding: '3px 10px', borderRadius: 6, flexShrink: 0,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  color: 'var(--text-bright)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        )
      })}
    </div>,
    document.body
  )
}
