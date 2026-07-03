import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Terminal, Database, Power, RefreshCw, ChevronDown, Table2, Columns3, Plus, FileCode2, SquareSplitHorizontal, SquareSplitVertical } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { resolveDropTarget } from './splitDrop'
import SshToolsMenu from './SshToolsMenu'
import { useQueryStore } from '../../stores/queryStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcutStr, SHORTCUT_DEFS } from '../../utils/shortcuts'
import { wid } from '../../utils/windowTag'
import { useWheelScroll } from '../../utils/wheelScroll'
import { openNewAppWindowWithTab, reattachTabToWindow } from '../../utils/multiWindow'
import { findWindowLabelAtCursor } from '../../utils/windowRegistry'
import { markDetaching, clearDetaching, snapshotTerminal } from '../../utils/adopt'
import { toast } from '../../stores/toastStore'
import QuickConnectDialog from '../Terminal/QuickConnectDialog'
import type { WorkspaceTab } from '../../types'
import type { TabMouseAction } from '../../stores/settingsStore'

const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 可否撕离到新窗口：仅非固定、非对象编辑（草稿不持久化会丢失），且在 Tauri 环境 */
function canTearOffTab(tab?: WorkspaceTab): boolean {
  return isTauriEnv && !!tab && !tab.pinned && tab.type !== 'object-editor'
}

/** 撕离：新建窗口接管该标签的活会话，再从本窗口关闭它（force 跳过未保存确认） */
function tearOffTab(tab: WorkspaceTab, closeTab: (id: string, force?: boolean) => void): void {
  if (!canTearOffTab(tab)) return
  // 撕离前抓取终端当前画面快照（含滚屏），让新窗口能还原历史内容
  const snapshot = tab.type === 'terminal' ? snapshotTerminal(tab.id) : null
  // 查询页：抓取未保存的 SQL 草稿一并迁移，避免新窗口空白
  const sqlDraft = tab.type === 'query' ? (useQueryStore.getState().sqls[tab.id] ?? null) : null
  markDetaching(tab.id)
  openNewAppWindowWithTab(tab, snapshot, sqlDraft)
    .then(() => closeTab(tab.id, true))
    .catch((e) => toast.error(`移到新窗口失败：${String(e)}`))
    .finally(() => setTimeout(() => clearDetaching(tab.id), 1500))
}

/** 中间省略截断 */
function truncateMiddle(text: string, max = 20): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return text.slice(0, half) + '…' + text.slice(-half)
}

/** 右键上下文菜单 */
function TabCtxMenu({
  tabId, x, y, onClose, onRename,
}: {
  tabId: string; x: number; y: number
  onClose: () => void
  onRename: () => void
}) {
  const { tabs, requestCloseTab, closeOtherTabs, closeTabsToRight, closeTab, paneBTabIds, openSplit, moveTabToPane } = useAppStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const tabIdx = tabs.findIndex(t => t.id === tabId)
  const hasRight = tabIdx < tabs.length - 1

  const tab = tabs.find(t => t.id === tabId)
  const inB = paneBTabIds.includes(tabId)
  const canSplit = !!tab && tabs.length >= 2 && !inB
  const canTearOff = canTearOffTab(tab)

  const userShortcuts = useSettingsStore.getState().shortcuts
  const scStr = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  const items: Array<{ label: string; action: () => void; danger?: boolean; shortcut?: string } | 'divider'> = [
    { label: '关闭标签', action: () => { requestCloseTab(tabId); onClose() }, danger: true, shortcut: scStr('closeTab') },
    { label: '关闭其他标签', action: () => { closeOtherTabs(tabId); onClose() } },
    ...(hasRight ? [{ label: '关闭右侧标签', action: () => { closeTabsToRight(tabId); onClose() } } as const] : []),
    'divider',
    ...(canSplit
      ? [
          { label: '在右侧分屏显示', action: () => { openSplit('h'); moveTabToPane(tabId, 'b'); onClose() } } as const,
          { label: '在下方分屏显示', action: () => { openSplit('v'); moveTabToPane(tabId, 'b'); onClose() } } as const,
        ] : []),
    ...(inB
      ? [{ label: '移回主屏', action: () => { moveTabToPane(tabId, 'a'); onClose() } } as const] : []),
    ...(canTearOff && tab
      ? [{ label: '移到新窗口', action: () => { tearOffTab(tab, closeTab); onClose() } } as const] : []),
    { label: '重命名', action: () => { onRename(); onClose() } },
  ]

  return createPortal(
    <div ref={ref} className="tab-ctx-menu" style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item === 'divider'
          ? <div key={i} className="tab-ctx-divider" />
          : <div
              key={i}
              className={`tab-ctx-item${item.danger ? ' danger' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); item.action() }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="ctx-item__shortcut">{item.shortcut}</span>}
            </div>
      )}
    </div>,
    document.body
  )
}


export default function TabBar() {
  const {
    tabs, activeTabId, connections,
    setActiveTab, closeTab, requestCloseTab, openTab, openQueryTab, renameTab, moveTab,
    termDisconnected, termCallbacks, setTermDisconnected,
    splitOn, splitDir, openSplit, closeSplit, moveTabToPane, setDraggingTab,
  } = useAppStore()
  const [quickConnOpen, setQuickConnOpen] = useState(false)

  // 点按钮开空分屏；同方向再点 = 取消
  const toggleSplit = (dir: 'h' | 'v') => {
    if (splitOn && splitDir === dir) closeSplit()
    else openSplit(dir)
  }

  const reconnectSsh = () => {
    if (!activeTab) return
    const snap = { id: activeTab.id, connectionId: activeTab.connectionId, title: activeTab.title, type: activeTab.type } as const
    const isTauri = '__TAURI_INTERNALS__' in window
    const doReopen = () => {
      closeTab(snap.id)
      setTimeout(() => {
        openTab({ id: snap.id, connectionId: snap.connectionId, title: snap.title, type: snap.type })
        // 在重新打开之后清除断开状态，避免被旧的 ssh:disconnected 事件覆盖
        setTermDisconnected(snap.id, false)
      }, 80)
    }
    if (isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('disconnect_ssh', { id: snap.id }).catch(() => {}).finally(doReopen)
      })
    } else {
      doReopen()
    }
  }
  const settings = useSettingsStore()

  const [renamingId, setRenamingId]   = useState<string | null>(null)
  const [renameVal, setRenameVal]     = useState('')
  const [ctxMenu, setCtxMenu]         = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const hoverTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renameInputRef  = useRef<HTMLInputElement>(null)
  const scrollRef       = useRef<HTMLDivElement>(null)
  const overflowBtnRef  = useRef<HTMLButtonElement>(null)
  const dragTabRef      = useRef<string | null>(null)
  const dragOverRef     = useRef<string | null>(null)
  const reorderedRef    = useRef(false)   // 本次拖拽是否已在标签栏内完成排序（命中某个标签的 onDrop）
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // 鼠标滚轮垂直滚动 → 横向滚动 tab 栏（纯横向容器，统一规则见 utils/wheelScroll）
  useWheelScroll(scrollRef, { horizontalOnly: true })

  const activeTab  = tabs.find((t) => t.id === activeTabId)
  const activeConn = connections.find((c) => c.id === activeTab?.connectionId)
  const isSSH      = activeTab?.type === 'terminal'
  const isLocalTerm = isSSH && activeConn?.type === 'local'
  const isLocalDisconnected = isLocalTerm && !!termDisconnected[activeTab?.id ?? '']
  const isSshDisconnected   = isSSH && !isLocalTerm && !!termDisconnected[activeTab?.id ?? '']
  const isTermDisconnected  = isLocalDisconnected || isSshDisconnected
  const activeTermCbs = isLocalTerm ? termCallbacks[activeTab?.id ?? ''] : undefined

  // 格式化 tab 标题
  function tabIcon(tab: WorkspaceTab) {
    if (tab.type === 'terminal')       return <Terminal size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'table-data')     return <Table2 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'schema-browser') return <Columns3 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'object-editor')  return <FileCode2 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    return <Database size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
  }

  function getTitle(tab: WorkspaceTab): string {
    // 仅终端套用 user@host 格式；query / object-editor / schema-browser / table-data 标题本身具名
    if (tab.type !== 'terminal') return tab.title
    const conn = connections.find(c => c.id === tab.connectionId)
    if (!conn) return tab.title
    if (settings.tabTitleFormat === 'user-at-host' && conn.username && conn.host) {
      return `${conn.username}@${conn.host}`
    }
    return tab.title
  }

  // 根据截断模式处理显示文本；仅终端同连接多开时附加序号（query 标题已含序号）
  function getDisplayTitle(tab: WorkspaceTab): string {
    const title = getTitle(tab)
    let display = title
    if (tab.type === 'terminal') {
      const siblings = tabs.filter(t => t.type === 'terminal' && t.connectionId === tab.connectionId)
      if (siblings.length > 1) {
        const seqIdx = siblings.findIndex(t => t.id === tab.id)
        if (seqIdx > 0) display = `${title}:${seqIdx + 1}`
      }
    }
    return settings.tabTextTruncate === 'middle' ? truncateMiddle(display, 20) : display
  }

  // 执行鼠标动作（直接读 getState() 避免闭包问题）
  function handleTabAction(action: TabMouseAction, tab: WorkspaceTab, clientX?: number, clientY?: number) {
    const isTerminal = tab.type === 'terminal'
    switch (action) {
      case 'none': break

      case 'close':
        requestCloseTab(tab.id)
        break

      case 'rename':
        setRenamingId(tab.id)
        setRenameVal(getTitle(tab))
        setTimeout(() => renameInputRef.current?.select(), 30)
        break

      case 'menu':
        if (clientX !== undefined && clientY !== undefined) {
          setCtxMenu({ tabId: tab.id, x: clientX, y: clientY })
        }
        break

      // ── SSH 终端专用：新建终端标签页（多开）─────────────────────
      case 'new':
      case 'duplicate-ssh':
        if (isTerminal) {
          const newId = wid(`${tab.connectionId}-terminal-${Date.now()}`)
          openTab({ id: newId, connectionId: tab.connectionId, title: tab.title, type: 'terminal' })
        }
        break

      // ── 通用：复制当前标签页 ─────────────────────────────────────
      case 'duplicate':
        openTab({ ...tab, id: wid(`${tab.connectionId}-dup-${Date.now()}`) })
        break
    }
  }

  // 提交重命名
  const renameValRef = useRef(renameVal)
  renameValRef.current = renameVal

  function finishRename(tabId: string) {
    if (renameValRef.current.trim()) renameTab(tabId, renameValRef.current.trim())
    setRenamingId(null)
  }

  // hover 激活
  function handleMouseEnter(tabId: string) {
    const { tabHoverActivate } = useSettingsStore.getState()
    if (tabHoverActivate === 'never') return
    const delay = tabHoverActivate === 'immediately' ? 0
      : tabHoverActivate === '500ms' ? 500 : 1000
    hoverTimerRef.current = setTimeout(() => setActiveTab(tabId), delay)
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
  }

  return (
    <div className="tab-bar">
      <div
        ref={scrollRef}
        className="tab-bar__scroll"
      >
        {tabs.map((tab, idx) => {
          const isActive   = tab.id === activeTabId
          const showNum    = settings.tabShowNumber === 'all' || (settings.tabShowNumber === 'first9' && idx < 9)
          const isRenaming = renamingId === tab.id
          const displayTitle = getDisplayTitle(tab)

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`tab${isActive ? ' active' : ''}${dragOverId === tab.id && dragTabRef.current !== tab.id ? ' tab--drag-over' : ''}`}
              draggable={!isRenaming && !tab.pinned}
              onDragStart={(e) => {
                dragTabRef.current = tab.id
                setDraggingTab(tab.id)   // 通知内容区显示分屏落点
                e.dataTransfer.effectAllowed = 'move'
                // WKWebView 需要 setData 才会触发后续 dragover/drop（否则同窗口内拖动排序失效）
                try { e.dataTransfer.setData('text/plain', tab.id) } catch { /* ignore */ }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragTabRef.current && dragTabRef.current !== tab.id) {
                  dragOverRef.current = tab.id
                  setDragOverId(tab.id)
                }
              }}
              onDragLeave={() => {
                if (dragOverRef.current === tab.id) {
                  dragOverRef.current = null
                  setDragOverId(null)
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const fromId = dragTabRef.current
                if (fromId && fromId !== tab.id) { moveTab(fromId, tab.id); reorderedRef.current = true }
                dragOverRef.current = null
                setDragOverId(null)
              }}
              onDragEnd={(e) => {
                const id = dragTabRef.current
                const reordered = reorderedRef.current
                dragTabRef.current = null
                dragOverRef.current = null
                reorderedRef.current = false
                setDragOverId(null)
                setDraggingTab(null)   // 拖拽结束，撤掉落点层
                if (!id) return
                // 已在标签栏内完成排序（命中某个标签的 onDrop，浏览器环境）→ 绝不撕离/合并
                if (reordered) return
                const cx = e.clientX, cy = e.clientY
                // 在本窗口内释放 → 按 X 排序（WKWebView 下 drop 不触发，改在 dragend 按 clientX 计算位置）
                const insideWindow = cx > 0 && cy > 0 && cx < window.innerWidth && cy < window.innerHeight
                if (insideWindow) {
                  const bar = scrollRef.current
                  if (bar) {
                    // 落在标签栏下方（内容区）→ 按光标位置新建分屏（onDrop 在 WKWebView 不可靠，改用 dragend）
                    if (cy > bar.getBoundingClientRect().bottom) {
                      // 用实时 store 状态，避免 zone onDrop 已创建分屏后再次 openSplit
                      const curState = useAppStore.getState()
                      const tab = curState.tabs.find(t => t.id === id)
                      if (tab?.pinned) return
                      const tgt = resolveDropTarget(cx, cy, curState.splitOn, curState.splitDir)
                      if (tgt?.kind === 'split') { openSplit(tgt.dir); moveTabToPane(id, 'b') }
                      else if (tgt?.kind === 'pane') moveTabToPane(id, tgt.pane)
                      return
                    }
                    const els = Array.from(bar.querySelectorAll<HTMLElement>('[data-tab-id]'))
                    let targetId: string | null = els.length ? (els[els.length - 1].dataset.tabId ?? null) : null
                    for (const el of els) {
                      const r = el.getBoundingClientRect()
                      if (cx < r.left + r.width / 2) { targetId = el.dataset.tabId ?? null; break }
                    }
                    if (targetId && targetId !== id) moveTab(id, targetId)
                  }
                  return
                }
                // 在窗口外释放 → 合并到光标所在窗口，或撕离到桌面
                const t = tabs.find(x => x.id === id)
                if (!t || !canTearOffTab(t)) { if (t) tearOffTab(t, closeTab); return }
                // 用 OS 全局光标位置判定落点是否在别的窗口上（拖拽事件坐标跨窗口不可信）
                void (async () => {
                  const targetLabel = await findWindowLabelAtCursor()
                  if (targetLabel) {
                    // 拖到另一个 DBTerm 窗口 → 合并到该窗口（拖回）
                    const snapshot = t.type === 'terminal' ? snapshotTerminal(t.id) : null
                    const sqlDraft = t.type === 'query' ? (useQueryStore.getState().sqls[t.id] ?? null) : null
                    markDetaching(t.id)
                    reattachTabToWindow(targetLabel, t, snapshot, sqlDraft)
                      .then(() => closeTab(t.id, true))
                      .catch((err) => toast.error(`合并到目标窗口失败：${String(err)}`))
                      .finally(() => setTimeout(() => clearDetaching(t.id), 1500))
                  } else {
                    // 落在空白桌面 → 新开窗口（撕离）
                    tearOffTab(t, closeTab)
                  }
                })()
              }}
              onClick={() => !isRenaming && setActiveTab(tab.id)}
              onDoubleClick={(e) => {
                e.preventDefault()
                handleTabAction(useSettingsStore.getState().tabMouseDouble, tab, e.clientX, e.clientY)
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  handleTabAction(useSettingsStore.getState().tabMouseMiddle, tab)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                handleTabAction(useSettingsStore.getState().tabMouseRight, tab, e.clientX, e.clientY)
              }}
              onMouseEnter={() => handleMouseEnter(tab.id)}
              onMouseLeave={() => handleMouseLeave()}
            >
              {/* 编号 */}
              {showNum && <span className="tab__num">{idx + 1}</span>}

              {/* 图标：terminal=SSH图标，table-data=表格，schema-browser=列，其余=DB */}
              {tabIcon(tab)}

              {/* 标题 / 重命名输入框 */}
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="tab__rename-input"
                  value={renameVal}
                  autoFocus
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={() => finishRename(tab.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  { e.stopPropagation(); finishRename(tab.id) }
                    if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) }
                  }}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span
                  className={`tab__label${settings.tabTextTruncate === 'start' ? ' tab__label--start' : ''}`}
                >
                  {tab.dirty && <span className="tab__dirty" data-tip="有未保存的修改">*</span>}
                  {displayTitle}
                </span>
              )}

              {/* 关闭按钮（固定标签不可关闭） */}
              {!tab.pinned && (
                <button
                  className="tab__close"
                  onClick={(e) => { e.stopPropagation(); requestCloseTab(tab.id) }}
                  data-tip="关闭"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* 新建查询（仅数据库连接显示；终端/SSH 标签不显示，避免无意义的禁用按钮）*/}
      {!!activeConn && activeConn.type !== 'ssh' && activeConn.type !== 'local' && (
        <button
          className="tab-new-query"
          onClick={() => { if (activeTab) openQueryTab(activeTab.connectionId) }}
          data-tip="新建查询"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      )}

      {/* 标签溢出下拉 */}
      <div className="tab-overflow">
        <button
          ref={overflowBtnRef}
          className={`tab-overflow__btn${overflowOpen ? ' active' : ''}`}
          onClick={() => setOverflowOpen(v => !v)}
          data-tip="所有标签"
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
        {overflowOpen && createPortal(
          <>
            <div className="tab-overflow__mask" onClick={() => setOverflowOpen(false)} />
            <div
              className="tab-overflow__list"
              style={(() => {
                const r = overflowBtnRef.current?.getBoundingClientRect()
                return r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : {}
              })()}
            >
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`tab-overflow__item${tab.id === activeTabId ? ' active' : ''}`}
                  onClick={() => { setActiveTab(tab.id); setOverflowOpen(false) }}
                >
                  {tabIcon(tab)}
                  <span>{getDisplayTitle(tab)}</span>
                  <button
                    className="tab-overflow__close"
                    onClick={(e) => { e.stopPropagation(); requestCloseTab(tab.id) }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </>,
          document.body
        )}
      </div>

      {/* 分屏按钮（≥2 个标签时显示）*/}
      {tabs.length >= 2 && (
        <div className="tab-split-btns">
          <button
            className={`tab-split-btn${splitOn && splitDir === 'h' ? ' active' : ''}`}
            onClick={() => toggleSplit('h')}
            data-tip={splitOn && splitDir === 'h' ? '取消分屏' : '左右分屏'}
          >
            <SquareSplitHorizontal size={14} strokeWidth={1.8} />
          </button>
          <button
            className={`tab-split-btn${splitOn && splitDir === 'v' ? ' active' : ''}`}
            onClick={() => toggleSplit('v')}
            data-tip={splitOn && splitDir === 'v' ? '取消分屏' : '上下分屏'}
          >
            <SquareSplitVertical size={14} strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* SSH 工具栏：面板/广播/快连 合并为下拉，断开/重连保持独立可见 */}
      {isSSH && (
        <div className="ssh-actions">
          <SshToolsMenu isLocalTerm={isLocalTerm} onQuickConn={() => setQuickConnOpen(true)} />

          {/* 本地终端：断开 / 重连 */}
          {isLocalTerm && activeTermCbs && (
            <>
              <div className="ssh-actions__sep" />
              {isTermDisconnected ? (
                <button
                  className="ssh-action-btn ssh-action-btn--reconnect"
                  onClick={activeTermCbs.reconnect}
                  data-tooltip="重新连接"
                >
                  <RefreshCw size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  className="ssh-action-btn ssh-action-btn--disconnect"
                  onClick={activeTermCbs.disconnect}
                  data-tooltip="断开连接"
                >
                  <Power size={13} strokeWidth={2} />
                </button>
              )}
            </>
          )}

          {/* SSH 会话：断开 / 重连按钮 */}
          {!isLocalTerm && isSSH && activeTab && (
            <>
              <div className="ssh-actions__sep" />
              {isSshDisconnected ? (
                <button
                  className="ssh-action-btn ssh-action-btn--reconnect"
                  data-tooltip="重新连接"
                  onClick={reconnectSsh}
                >
                  <RefreshCw size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  className="ssh-action-btn ssh-action-btn--disconnect"
                  data-tooltip="断开 SSH"
                  onClick={() => {
                    const isTauri = '__TAURI_INTERNALS__' in window
                    if (!isTauri) return
                    import('@tauri-apps/api/core').then(({ invoke }) => {
                      invoke('disconnect_ssh', { id: activeTab.id }).catch(() => {})
                    })
                  }}
                >
                  <Power size={13} strokeWidth={2} />
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <TabCtxMenu
          tabId={ctxMenu.tabId}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onRename={() => {
            const tab = tabs.find(t => t.id === ctxMenu!.tabId)
            if (tab) {
              setRenamingId(tab.id)
              setRenameVal(getTitle(tab))
              setTimeout(() => renameInputRef.current?.select(), 30)
            }
          }}
        />
      )}

      {quickConnOpen && <QuickConnectDialog onClose={() => setQuickConnOpen(false)} />}
    </div>
  )
}
