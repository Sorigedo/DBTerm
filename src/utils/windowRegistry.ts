// 跨窗口位置注册表：每个 DBTerm 窗口把自身屏幕外框写入共享 localStorage（同进程多窗口共享），
// 供「拖回合并」判断鼠标落点落在哪个窗口上。
//
// 关键：HTML5 拖拽事件在拖到「别的 OS 窗口」上时 clientX/screenX 不可信（被限制在源 webview 内），
// 因此落点改用 Tauri 原生 cursorPosition()（OS 全局真实坐标）。注册表与光标都用「物理像素」，
// 同一坐标系直接比较，无需 scaleFactor 换算。
const KEY = 'dbterm-windows'
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface WinRect { label: string; x: number; y: number; w: number; h: number; ts: number }

let myLabel = ''

function readAll(): Record<string, WinRect> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function writeAll(m: Record<string, WinRect>): void {
  try { localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* ignore */ }
}

/** 发布本窗口当前屏幕外框（物理像素），键为 Tauri 窗口 label。 */
export async function publishWindowRect(): Promise<void> {
  if (!isTauri) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    myLabel = win.label
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()])
    const m = readAll()
    m[win.label] = { label: win.label, x: pos.x, y: pos.y, w: size.width, h: size.height, ts: Date.now() }
    writeAll(m)
  } catch { /* 权限缺失/非 Tauri：静默 */ }
}

/** 窗口关闭时清除自身登记（best-effort，过期项也会被 30s 超时忽略）。 */
export function removeWindowRect(): void {
  if (!myLabel) return
  const m = readAll()
  delete m[myLabel]
  writeAll(m)
}

/** 用 OS 全局光标位置判定落在哪个「其它」窗口上，返回其 Tauri label；无则 null。 */
export async function findWindowLabelAtCursor(): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window')
    const cur = await cursorPosition()           // 物理像素，全局屏幕坐标
    const self = getCurrentWindow().label
    const m = readAll()
    const now = Date.now()
    for (const r of Object.values(m)) {
      if (r.label === self) continue
      if (now - r.ts > 30000) continue
      if (cur.x >= r.x && cur.x <= r.x + r.w && cur.y >= r.y && cur.y <= r.y + r.h) return r.label
    }
    return null
  } catch { return null }
}
