import { create } from 'zustand'
import { useDbErrorStore } from './dbErrorStore'
import { notifyExported } from './exportDoneStore'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

/** toast 上的操作按钮（如导出成功后的「打开所在位置」） */
export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
}

export interface Toast {
  id: number
  type: ToastType
  message: string
  action?: ToastAction
  /** 可选标题，仅用于需要更强提示的场景 */
  title?: string
  /** 自定义停留时长（ms）；带操作按钮时默认更久 */
  duration?: number
  /** true = 不自动消失，只能点击手动关闭 */
  persistent?: boolean
}

type ToastOptions = {
  action?: ToastAction
  title?: string
  duration?: number
  persistent?: boolean
}

interface ToastState {
  toasts: Toast[]
  show: (type: ToastType, message: string, opts?: ToastOptions) => void
  dismiss: (id: number) => void
}

let seq = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (type, message, opts) => {
    const id = seq++
    set((s) => ({
      toasts: [...s.toasts, {
        id,
        type,
        message,
        action: opts?.action,
        title: opts?.title,
        duration: opts?.duration,
        persistent: opts?.persistent,
      }],
    }))
    // 自动消失由 Toaster 统一管理（含滑出动画），此处不再定时移除
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

// 便捷入口（非组件中调用）
export const toast = {
  success: (m: string, opts?: ToastOptions) => useToastStore.getState().show('success', m, opts),
  /**
   * 统一的「导出成功」提示：弹出居中成功弹窗（绿勾 + 明细 + 路径 + 打开所在位置）。
   * 所有写文件型导出都用此入口，行为一致。message 作为明细行（如「已导出 1234 行到 CSV 文件」）。
   */
  exported: (filePath: string, message?: string) => notifyExported(filePath, message),
  // 错误：默认只进底部错误条（常驻、可复制、手动关闭），不再额外弹右上角 toast，避免重复。
  // 轻量的前端校验提示可传 { transient: true } 只弹一次性 toast、不进错误条。
  error:   (m: string, opts?: { transient?: boolean }) => {
    if (opts?.transient) { useToastStore.getState().show('error', m); return }
    useDbErrorStore.getState().report(m, undefined, Date.now())
  },
  info:    (m: string, opts?: ToastOptions) => useToastStore.getState().show('info', m, opts),
  warning: (m: string, opts?: ToastOptions) => useToastStore.getState().show('warning', m, opts),
}
