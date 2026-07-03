// 统一复制工具。Tauri WebView 中 execCommand / navigator.clipboard 都可能静默失败
// （瞬时用户激活被 await 消耗、WKWebView 限制），故优先走 Tauri 原生剪贴板插件，
// 它不依赖用户手势/WebView，所有场景、所有数据库类型通用、最可靠。
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export async function copyText(text: string): Promise<boolean> {
  if (isTauri) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeText(text)
      return true
    } catch { /* 插件不可用 → 浏览器兜底 */ }
  }
  // 浏览器环境兜底：同步 textarea + execCommand，再退 navigator.clipboard
  if (legacyCopy(text)) return true
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
