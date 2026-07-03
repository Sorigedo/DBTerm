// 软件多开 = 同进程内开多个原生窗口（WebviewWindow）。各窗口独立 JS 上下文/Zustand store，
// 但共享同一份后端（StorageState Mutex、SSH/PTY 会话、事件总线），既隔离又零数据竞争。
import { WIN_TAG } from './windowTag'
import type { WorkspaceTab } from '../types'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let winSeq = 0

async function createWindow(url: string): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  // label 全局唯一：用本窗口 tag + 自增序号，避免并发同名；必须匹配 capabilities 里的 win-* 通配
  const label = `win-${WIN_TAG}-${winSeq++}`
  const w = new WebviewWindow(label, {
    url,
    title: 'DBTerm',
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    resizable: true,
    transparent: true,
    // 与主窗口一致：隐藏原生标题栏、红绿灯叠加在内容上，避免副窗口出现原生标题栏 + 拖拽区双份留白
    titleBarStyle: 'overlay',
    hiddenTitle: true,
  })
  // created 事件可能早于监听注册而错过 → 加超时兜底，避免永久挂起；error 才视为失败
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const ok = () => { if (!settled) { settled = true; resolve() } }
    const fail = (e: unknown) => { if (!settled) { settled = true; reject(new Error(String((e as { payload?: unknown })?.payload ?? e))) } }
    w.once('tauri://created', ok).catch(() => {})
    w.once('tauri://error', fail).catch(() => {})
    setTimeout(ok, 800)
  })
}

/** 新建一个空白 DBTerm 窗口（加载同一份前端）。 */
export async function openNewAppWindow(): Promise<void> {
  if (!isTauri) return
  await createWindow('index.html')
}

// ── 标签撕离：把一个标签连同其活会话迁移到新窗口 ─────────────────────
// 载荷（tab + 终端画面快照）经共享 localStorage 传递（同进程多窗口共享），用一次性 token 取走。
// 快照可能较大，不走 URL。
let adoptSeq = 0
// snapshot：终端画面快照；sqlDraft：查询页未保存的 SQL 草稿（撕离时随载荷迁移，避免新窗口空白）
export interface AdoptPayload { tab: WorkspaceTab; snapshot?: string | null; sqlDraft?: string | null }

/** 新建窗口并让它接管 tab（终端带画面快照，查询页带 SQL 草稿）。 */
export async function openNewAppWindowWithTab(tab: WorkspaceTab, snapshot?: string | null, sqlDraft?: string | null): Promise<void> {
  if (!isTauri) return
  const token = `${WIN_TAG}-${adoptSeq++}-${Date.now()}`
  const key = `dbterm-adopt-${token}`
  try { localStorage.setItem(key, JSON.stringify({ tab, snapshot, sqlDraft } as AdoptPayload)) } catch { /* ignore */ }
  try {
    await createWindow(`index.html?adopt=${encodeURIComponent(token)}`)
  } catch (e) {
    localStorage.removeItem(key)
    throw e
  }
}

/** 新窗口启动时调用：若本窗口是被撕离接管而开的，取出待接管的载荷（取走即删）。 */
export function takeAdoptedTab(): AdoptPayload | null {
  if (!isTauri) return null
  const token = new URLSearchParams(window.location.search).get('adopt')
  if (!token) return null
  return takeAdoptPayload(token)
}

/** 按 token 取走 adopt 载荷（撕离/拖回共用，取走即删）。 */
export function takeAdoptPayload(token: string): AdoptPayload | null {
  const key = `dbterm-adopt-${token}`
  const raw = localStorage.getItem(key)
  localStorage.removeItem(key)
  if (!raw) return null
  try { return JSON.parse(raw) as AdoptPayload } catch { return null }
}

// ── 标签拖回：把一个标签从当前窗口迁移到「已存在的」目标窗口（拖到其窗体上时触发）──
const REATTACH = 'dbterm://reattach'

/** 写入 adopt 载荷并广播，让 targetLabel 对应的窗口就地接管该标签。 */
export async function reattachTabToWindow(targetLabel: string, tab: WorkspaceTab, snapshot?: string | null, sqlDraft?: string | null): Promise<void> {
  if (!isTauri) return
  const token = `${WIN_TAG}-${adoptSeq++}-${Date.now()}`
  const key = `dbterm-adopt-${token}`
  try { localStorage.setItem(key, JSON.stringify({ tab, snapshot, sqlDraft } as AdoptPayload)) } catch { /* ignore */ }
  const { emit } = await import('@tauri-apps/api/event')
  await emit(REATTACH, { targetLabel, token })
}

/** 订阅「拖回到本窗口」事件：仅当 targetLabel 等于本窗口 label 时回调 token。返回取消函数。 */
export function onReattach(cb: (token: string) => void): () => void {
  if (!isTauri) return () => {}
  let un: (() => void) | null = null
  let disposed = false
  ;(async () => {
    const [{ listen }, { getCurrentWindow }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/window'),
    ])
    const self = getCurrentWindow().label
    const fn = await listen<{ targetLabel?: string; token?: string }>(REATTACH, (ev) => {
      if (ev.payload?.targetLabel !== self || !ev.payload?.token) return
      cb(ev.payload.token)
    })
    if (disposed) fn(); else un = fn
  })()
  return () => { disposed = true; un?.() }
}

// ── 跨窗口连接列表同步 ───────────────────────────────────────────────
// 连接列表在每个窗口是内存态；某窗口增删改后，广播让其它窗口重新从磁盘加载。
const CONN_CHANGED = 'dbterm://connections-changed'

export async function broadcastConnectionsChanged(): Promise<void> {
  if (!isTauri) return
  const { emit } = await import('@tauri-apps/api/event')
  await emit(CONN_CHANGED, { from: WIN_TAG })
}

/** 订阅其它窗口的连接变更（自己发出的会被忽略，避免覆盖本窗口的乐观更新）。返回取消函数。 */
export function onConnectionsChanged(cb: () => void): () => void {
  if (!isTauri) return () => {}
  let un: (() => void) | null = null
  let disposed = false
  import('@tauri-apps/api/event').then(({ listen }) =>
    listen<{ from?: string }>(CONN_CHANGED, (ev) => {
      if (ev.payload?.from === WIN_TAG) return
      cb()
    }),
  ).then((fn) => {
    if (disposed) fn()
    else un = fn
  })
  return () => { disposed = true; un?.() }
}
