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
import { openNewAppWindowWithTab } from '../../utils/multiWindow'
import { markDetaching, clearDetaching, snapshotTerminal } from '../../utils/adopt'
import { toast } from '../../stores/toastStore'
import QuickConnectDialog from '../Terminal/QuickConnectDialog'
import type { WorkspaceTab } from '../../types'
import type { TabMouseAction } from '../../stores/settingsStore'

const isTauriEnv = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 鍙惁鎾曠鍒版柊绐楀彛锛氫粎闈炲浐瀹氥€侀潪瀵硅薄缂栬緫锛堣崏绋夸笉鎸佷箙鍖栦細涓㈠け锛夛紝涓斿湪 Tauri 鐜 */
function canTearOffTab(tab?: WorkspaceTab): boolean {
  return isTauriEnv && !!tab && !tab.pinned && tab.type !== 'object-editor'
}

/** 鎾曠锛氭柊寤虹獥鍙ｆ帴绠¤鏍囩鐨勬椿浼氳瘽锛屽啀浠庢湰绐楀彛鍏抽棴瀹冿紙force 璺宠繃鏈繚瀛樼‘璁わ級 */
function tearOffTab(tab: WorkspaceTab, closeTab: (id: string, force?: boolean) => void): void {
  if (!canTearOffTab(tab)) return
  // 鎾曠鍓嶆姄鍙栫粓绔綋鍓嶇敾闈㈠揩鐓э紙鍚粴灞忥級锛岃鏂扮獥鍙ｈ兘杩樺師鍘嗗彶鍐呭
  const snapshot = tab.type === 'terminal' ? snapshotTerminal(tab.id) : null
  // 鏌ヨ椤碉細鎶撳彇鏈繚瀛樼殑 SQL 鑽夌涓€骞惰縼绉伙紝閬垮厤鏂扮獥鍙ｇ┖鐧?
  const sqlDraft = tab.type === 'query' ? (useQueryStore.getState().sqls[tab.id] ?? null) : null
  markDetaching(tab.id)
  openNewAppWindowWithTab(tab, snapshot, sqlDraft)
    .then(() => closeTab(tab.id, true))
    .catch((e) => toast.error(`绉诲埌鏂扮獥鍙ｅけ璐ワ細${String(e)}`))
    .finally(() => setTimeout(() => clearDetaching(tab.id), 1500))
}

/** 涓棿鐪佺暐鎴柇 */
function truncateMiddle(text: string, max = 20): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return text.slice(0, half) + '...' + text.slice(-half)
}

/** 鍙抽敭涓婁笅鏂囪彍鍗?*/
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
    { label: '鍏抽棴鏍囩', action: () => { requestCloseTab(tabId); onClose() }, danger: true, shortcut: scStr('closeTab') },
    { label: '鍏抽棴鍏朵粬鏍囩', action: () => { closeOtherTabs(tabId); onClose() } },
    ...(hasRight ? [{ label: '鍏抽棴鍙充晶鏍囩', action: () => { closeTabsToRight(tabId); onClose() } } as const] : []),
    'divider',
    ...(canSplit
      ? [
          { label: '在右侧分屏显示', action: () => { openSplit('h'); moveTabToPane(tabId, 'b'); onClose() } } as const,
          { label: '在下方分屏显示', action: () => { openSplit('v'); moveTabToPane(tabId, 'b'); onClose() } } as const,
        ] : []),
    ...(inB
      ? [{ label: '绉诲洖涓诲睆', action: () => { moveTabToPane(tabId, 'a'); onClose() } } as const] : []),
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
    splitOn, splitDir, openSplit, closeSplit, moveTabToPane, setDraggingTab, setDragPreview,
  } = useAppStore()
  const [quickConnOpen, setQuickConnOpen] = useState(false)

  // 鐐规寜閽紑绌哄垎灞忥紱鍚屾柟鍚戝啀鐐?= 鍙栨秷
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
        // 鍦ㄩ噸鏂版墦寮€涔嬪悗娓呴櫎鏂紑鐘舵€侊紝閬垮厤琚棫鐨?ssh:disconnected 浜嬩欢瑕嗙洊
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
  const pointerDragRef  = useRef<{ tabId: string; startX: number; startY: number; started: boolean } | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragInsertSide, setDragInsertSide] = useState<'before' | 'after'>('before')
  const [dragInsertX, setDragInsertX] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 榧犳爣婊氳疆鍨傜洿婊氬姩 鈫?妯悜婊氬姩 tab 鏍忥紙绾í鍚戝鍣紝缁熶竴瑙勫垯瑙?utils/wheelScroll锛?
  useWheelScroll(scrollRef, { horizontalOnly: true })

  const activeTab  = tabs.find((t) => t.id === activeTabId)
  const activeConn = connections.find((c) => c.id === activeTab?.connectionId)
  const isSSH      = activeTab?.type === 'terminal'
  const isLocalTerm = isSSH && activeConn?.type === 'local'
  const isLocalDisconnected = isLocalTerm && !!termDisconnected[activeTab?.id ?? '']
  const isSshDisconnected   = isSSH && !isLocalTerm && !!termDisconnected[activeTab?.id ?? '']
  const isTermDisconnected  = isLocalDisconnected || isSshDisconnected
  const activeTermCbs = isLocalTerm ? termCallbacks[activeTab?.id ?? ''] : undefined

  // 鏍煎紡鍖?tab 鏍囬
  function tabIcon(tab: WorkspaceTab) {
    if (tab.type === 'terminal')       return <Terminal size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'table-data')     return <Table2 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'schema-browser') return <Columns3 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    if (tab.type === 'object-editor')  return <FileCode2 size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
    return <Database size={12} strokeWidth={1.5} style={{ flexShrink: 0 }} />
  }

  function getTitle(tab: WorkspaceTab): string {
    // 浠呯粓绔鐢?user@host 鏍煎紡锛泀uery / object-editor / schema-browser / table-data 鏍囬鏈韩鍏峰悕
    if (tab.type !== 'terminal') return tab.title
    const conn = connections.find(c => c.id === tab.connectionId)
    if (!conn) return tab.title
    if (settings.tabTitleFormat === 'user-at-host' && conn.username && conn.host) {
      return `${conn.username}@${conn.host}`
    }
    return tab.title
  }

  // 鏍规嵁鎴柇妯″紡澶勭悊鏄剧ず鏂囨湰锛涗粎缁堢鍚岃繛鎺ュ寮€鏃堕檮鍔犲簭鍙凤紙query 鏍囬宸插惈搴忓彿锛?
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

  // 鎵ц榧犳爣鍔ㄤ綔锛堢洿鎺ヨ getState() 閬垮厤闂寘闂锛?
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

      // 鈹€鈹€ SSH 缁堢涓撶敤锛氭柊寤虹粓绔爣绛鹃〉锛堝寮€锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
      case 'new':
      case 'duplicate-ssh':
        if (isTerminal) {
          const newId = wid(`${tab.connectionId}-terminal-${Date.now()}`)
          openTab({ id: newId, connectionId: tab.connectionId, title: tab.title, type: 'terminal' })
        }
        break

      // 鈹€鈹€ 閫氱敤锛氬鍒跺綋鍓嶆爣绛鹃〉 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
      case 'duplicate':
        openTab({ ...tab, id: wid(`${tab.connectionId}-dup-${Date.now()}`) })
        break
    }
  }

  // 鎻愪氦閲嶅懡鍚?
  const renameValRef = useRef(renameVal)
  renameValRef.current = renameVal

  function finishRename(tabId: string) {
    if (renameValRef.current.trim()) renameTab(tabId, renameValRef.current.trim())
    setRenamingId(null)
  }

  // hover 婵€娲?
  function handleMouseEnter(tabId: string) {
    if (draggingId || useAppStore.getState().draggingTabId) return
    const { tabHoverActivate } = useSettingsStore.getState()
    if (tabHoverActivate === 'never') return
    const delay = tabHoverActivate === 'immediately' ? 0
      : tabHoverActivate === '500ms' ? 500 : 1000
    hoverTimerRef.current = setTimeout(() => setActiveTab(tabId), delay)
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
  }

  function clearTabInsertHint() {
    dragOverRef.current = null
    setDragOverId(null)
    setDragInsertX(null)
  }

  function clearDragVisuals() {
    setDraggingId(null)
    setDragPreview(null)
    clearTabInsertHint()
  }

  function resolveTabInsert(clientX: number): { targetId: string; side: 'before' | 'after'; markerX: number } | null {
    const bar = scrollRef.current
    const fromId = dragTabRef.current
    if (!bar || !fromId) return null

    const els = Array.from(bar.querySelectorAll<HTMLElement>('[data-tab-id]'))
      .filter(el => el.dataset.tabId && el.dataset.tabId !== fromId)
    if (els.length === 0) return null

    const barLeft = bar.getBoundingClientRect().left
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (clientX < r.left + r.width / 2) {
        return { targetId: el.dataset.tabId!, side: 'before', markerX: r.left - barLeft + bar.scrollLeft }
      }
    }

    const last = els[els.length - 1]
    const r = last.getBoundingClientRect()
    return { targetId: last.dataset.tabId!, side: 'after', markerX: r.right - barLeft + bar.scrollLeft }
  }

  function updateTabInsertHint(clientX: number): ReturnType<typeof resolveTabInsert> {
    const target = resolveTabInsert(clientX)
    if (!target) {
      clearTabInsertHint()
      return null
    }
    dragOverRef.current = target.targetId
    setDragOverId(target.targetId)
    setDragInsertSide(target.side)
    setDragInsertX(target.markerX)
    return target
  }

  function beginPointerDrag(e: React.PointerEvent, tab: WorkspaceTab, isRenaming: boolean) {
    if (e.button !== 0 || isRenaming || tab.pinned) return
    if ((e.target as HTMLElement).closest('button,input')) return
    e.preventDefault()
    e.stopPropagation()
    window.getSelection()?.removeAllRanges()

    pointerDragRef.current = { tabId: tab.id, startX: e.clientX, startY: e.clientY, started: false }

    const onMove = (ev: PointerEvent) => {
      const drag = pointerDragRef.current
      if (!drag) return
      const moved = Math.abs(ev.clientX - drag.startX) > 5 || Math.abs(ev.clientY - drag.startY) > 5
      if (!drag.started && moved) {
        drag.started = true
        dragTabRef.current = drag.tabId
        setDraggingTab(drag.tabId)
        setDraggingId(drag.tabId)
        const tabNow = useAppStore.getState().tabs.find(t => t.id === drag.tabId)
        setDragPreview({ tabId: drag.tabId, title: tabNow ? getDisplayTitle(tabNow) : '', x: ev.clientX, y: ev.clientY })
        document.body.classList.add('tab-dragging')
      }
      if (!drag.started) return
      const preview = useAppStore.getState().dragPreview
      if (preview) setDragPreview({ ...preview, x: ev.clientX, y: ev.clientY })

      const bar = scrollRef.current
      const br = bar?.getBoundingClientRect()
      if (br && ev.clientX >= br.left && ev.clientX <= br.right && ev.clientY >= br.top && ev.clientY <= br.bottom) {
        updateTabInsertHint(ev.clientX)
      } else {
        clearTabInsertHint()
      }
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)

      const drag = pointerDragRef.current
      pointerDragRef.current = null
      dragTabRef.current = null
      document.body.classList.remove('tab-dragging')
      setDraggingTab(null)
      setDragPreview(null)
      clearDragVisuals()
      if (!drag || !drag.started) return

      const st = useAppStore.getState()
      const tabNow = st.tabs.find(t => t.id === drag.tabId)
      if (tabNow?.pinned) return

      const tgt = resolveDropTarget(ev.clientX, ev.clientY, st.splitOn, st.splitDir)
      if (tgt?.kind === 'split') {
        openSplit(tgt.dir)
        moveTabToPane(drag.tabId, 'b')
        return
      }
      if (tgt?.kind === 'pane') {
        moveTabToPane(drag.tabId, tgt.pane)
        return
      }

      const bar = scrollRef.current
      const br = bar?.getBoundingClientRect()
      const inTabBar = !!br && ev.clientX >= br.left && ev.clientX <= br.right && ev.clientY >= br.top && ev.clientY <= br.bottom
      if (inTabBar) {
        dragTabRef.current = drag.tabId
        const insert = updateTabInsertHint(ev.clientX)
        dragTabRef.current = null
        if (insert && insert.targetId !== drag.tabId) moveTab(drag.tabId, insert.targetId, insert.side)
        clearTabInsertHint()
      }
    }

    const onCancel = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      pointerDragRef.current = null
      dragTabRef.current = null
      document.body.classList.remove('tab-dragging')
      setDraggingTab(null)
      setDragPreview(null)
      clearDragVisuals()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
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
              className={`tab${isActive ? ' active' : ''}${draggingId === tab.id ? ' dragging' : ''}`}
              data-insert-side={dragOverId === tab.id && dragTabRef.current !== tab.id ? dragInsertSide : undefined}
              draggable={false}
              onPointerDown={(e) => beginPointerDrag(e, tab, isRenaming)}
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
              {/* 缂栧彿 */}
              {showNum && <span className="tab__num">{idx + 1}</span>}

              {/* 鍥炬爣锛歵erminal=SSH鍥炬爣锛宼able-data=琛ㄦ牸锛宻chema-browser=鍒楋紝鍏朵綑=DB */}
              {tabIcon(tab)}

              {/* 鏍囬 / 閲嶅懡鍚嶈緭鍏ユ */}
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

              {/* 鍏抽棴鎸夐挳锛堝浐瀹氭爣绛句笉鍙叧闂級 */}
              {!tab.pinned && (
                <button
                  className="tab__close"
                  onClick={(e) => { e.stopPropagation(); requestCloseTab(tab.id) }}
                  data-tip="鍏抽棴"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          )
        })}
        {dragInsertX != null && (
          <div
            className="tab-insert-marker"
            style={{ left: dragInsertX }}
          />
        )}
      </div>

      {/* 新建查询 */}
      {!!activeConn && activeConn.type !== 'ssh' && activeConn.type !== 'local' && (
        <button
          className="tab-new-query"
          onClick={() => { if (activeTab) openQueryTab(activeTab.connectionId) }}
          data-tip="鏂板缓鏌ヨ"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      )}

      {/* 鏍囩婧㈠嚭涓嬫媺 */}
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

      {/* 分屏按钮 */}
      {tabs.length >= 2 && (
        <div className="tab-split-btns">
          <button
            className={`tab-split-btn${splitOn && splitDir === 'h' ? ' active' : ''}`}
            onClick={() => toggleSplit('h')}
            data-tip={splitOn && splitDir === 'h' ? '鍙栨秷鍒嗗睆' : '宸﹀彸鍒嗗睆'}
          >
            <SquareSplitHorizontal size={14} strokeWidth={1.8} />
          </button>
          <button
            className={`tab-split-btn${splitOn && splitDir === 'v' ? ' active' : ''}`}
            onClick={() => toggleSplit('v')}
            data-tip={splitOn && splitDir === 'v' ? '鍙栨秷鍒嗗睆' : '涓婁笅鍒嗗睆'}
          >
            <SquareSplitVertical size={14} strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* SSH 宸ュ叿鏍忥細闈㈡澘/骞挎挱/蹇繛 鍚堝苟涓轰笅鎷夛紝鏂紑/閲嶈繛淇濇寔鐙珛鍙 */}
      {isSSH && (
        <div className="ssh-actions">
          <SshToolsMenu isLocalTerm={isLocalTerm} onQuickConn={() => setQuickConnOpen(true)} />

          {/* 鏈湴缁堢锛氭柇寮€ / 閲嶈繛 */}
          {isLocalTerm && activeTermCbs && (
            <>
              <div className="ssh-actions__sep" />
              {isTermDisconnected ? (
                <button
                  className="ssh-action-btn ssh-action-btn--reconnect"
                  onClick={activeTermCbs.reconnect}
                  data-tooltip="閲嶆柊杩炴帴"
                >
                  <RefreshCw size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  className="ssh-action-btn ssh-action-btn--disconnect"
                  onClick={activeTermCbs.disconnect}
                  data-tooltip="鏂紑杩炴帴"
                >
                  <Power size={13} strokeWidth={2} />
                </button>
              )}
            </>
          )}

          {/* SSH 浼氳瘽锛氭柇寮€ / 閲嶈繛鎸夐挳 */}
          {!isLocalTerm && isSSH && activeTab && (
            <>
              <div className="ssh-actions__sep" />
              {isSshDisconnected ? (
                <button
                  className="ssh-action-btn ssh-action-btn--reconnect"
                  data-tooltip="閲嶆柊杩炴帴"
                  onClick={reconnectSsh}
                >
                  <RefreshCw size={13} strokeWidth={2} />
                </button>
              ) : (
                <button
                  className="ssh-action-btn ssh-action-btn--disconnect"
                  data-tooltip="鏂紑 SSH"
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

      {/* 鍙抽敭涓婁笅鏂囪彍鍗?*/}
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
