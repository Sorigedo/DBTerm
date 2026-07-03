import { create } from 'zustand'

// 全局「数据库错误」持久条：所有数据库操作出错都进这里，底部常驻显示、可复制，
// 只有手动关闭才消失（不像 toast 一闪而过，便于排查）。
export interface DbErrorEntry {
  id: number
  message: string
  source?: string   // 操作来源，如「更新行」「执行 SQL」「复制表」
  at: number        // 发生时间戳（外部传入，避免在 store 里用 Date.now）
}

interface DbErrorState {
  error: DbErrorEntry | null
  report: (message: string, source: string | undefined, at: number) => void
  clear: () => void
}

let _seq = 1

export const useDbErrorStore = create<DbErrorState>((set) => ({
  error: null,
  report: (message, source, at) => set({ error: { id: _seq++, message: message.trim(), source, at } }),
  clear: () => set({ error: null }),
}))

/** 统一上报数据库错误（任意 catch 里调用）。e 可为 Error / string / unknown。 */
export function reportDbError(e: unknown, source?: string): void {
  const message = e instanceof Error ? e.message : String(e)
  useDbErrorStore.getState().report(message, source, Date.now())
}
