import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConfirmStore } from '../stores/confirmStore'

// 退出/关闭守卫：拦截「程序坞退出 / Cmd+Q / 菜单退出」（后端 applicationShouldTerminate + ExitRequested
// 发 app:quit-requested 事件）与「窗口关闭按钮」（onCloseRequested）。检测是否有未保存的查询页
// (有 SQL 文本) / 视图 / 函数 / 存储过程(有改动)，有则二次确认，确认后调 confirm_app_exit 真正退出；
// 没有则直接退出。仅主窗口（label=main）驱动，避免多开窗口重复响应。
export default function QuitGuard() {
  useEffect(() => {
    let disposers: Array<() => void> = []
    let busy = false

    // 有未保存内容 → 弹确认返回是否继续退出；无未保存 → 直接 true
    async function shouldQuit(): Promise<boolean> {
      const unsaved = useAppStore.getState().unsavedTabs()
      if (unsaved.length === 0) return true
      return useConfirmStore.getState().ask({
        tone: 'danger',
        title: '退出确认',
        message: `有 ${unsaved.length} 项未保存的内容（查询 / 视图 / 函数 / 存储过程），退出将丢失这些更改。确定退出吗？`,
        detail: unsaved.map(t => `• ${t.title}`).join('\n'),
        confirmText: '仍要退出',
      })
    }
    async function tryQuit() {
      if (busy) return
      busy = true
      try {
        const ok = await shouldQuit()
        if (ok) {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('confirm_app_exit')
        }
      } finally {
        busy = false
      }
    }

    ;(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      if (getCurrentWindow().label !== 'main') return
      const { listen } = await import('@tauri-apps/api/event')
      // 程序坞 / Cmd+Q / 菜单退出
      const un1 = await listen('app:quit-requested', () => { void tryQuit() })
      disposers.push(un1)
      // 窗口关闭按钮
      const un2 = await getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault()
        void tryQuit()
      })
      disposers.push(un2)
    })()

    return () => { disposers.forEach(d => d()) }
  }, [])
  return null
}
