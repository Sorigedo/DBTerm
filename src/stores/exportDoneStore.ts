import { create } from 'zustand'

export interface ExportDoneInfo {
  detail?: string
  path: string
}

type Phase = 'loading' | 'done' | 'error'

interface ExportDoneState {
  phase: Phase | null  // null = 关闭
  info: ExportDoneInfo | null
  errorMsg: string | null
  showLoading: () => void
  showDone: (info: ExportDoneInfo) => void
  showError: (msg: string) => void
  close: () => void
}

export const useExportDoneStore = create<ExportDoneState>((set) => ({
  phase: null,
  info: null,
  errorMsg: null,
  showLoading: () => set({ phase: 'loading', info: null, errorMsg: null }),
  showDone:    (info) => set({ phase: 'done', info, errorMsg: null }),
  showError:   (msg)  => set({ phase: 'error', info: null, errorMsg: msg }),
  close: () => set({ phase: null, info: null, errorMsg: null }),
}))

/** 导出开始前调用，显示 loading 弹窗 */
export function notifyExportStart() {
  useExportDoneStore.getState().showLoading()
}

/** 导出成功后调用 */
export function notifyExported(path: string, detail?: string) {
  useExportDoneStore.getState().showDone({ path, detail })
}

/** 导出失败后调用 */
export function notifyExportError(msg: string) {
  useExportDoneStore.getState().showError(msg)
}
