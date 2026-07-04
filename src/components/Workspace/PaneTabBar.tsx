import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Minimize2, Terminal, Database, Table2, Columns3, FileCode2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import SshToolsMenu from './SshToolsMenu'
import { wid } from '../../utils/windowTag'
import type { WorkspaceTab } from '../../types'
import type { TabMouseAction } from '../../stores/settingsStore'

function truncateMiddle(text: string, max = 20): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return text.slice(0, half) + '…' + text.slice(-half)
}

function tabIcon(tab: WorkspaceTab) {
  const p = { size: 12, strokeWidth: 1.5, style: { flexShrink: 0 } }
  if (tab.type === 'terminal')       return <Terminal {...p} />
  if (tab.type === 'table-data')     return <Table2 {...p} />
  if (tab.type === 'schema-browser') return <Columns3 {...p} />
  if (tab.type === 'object-editor')  return <FileCode2 {...p} />
  return <Database {...p} />
}

interface Props {
  pane: 'a' | 'b'
  paneTabs: WorkspaceTab[]
  activeId: string | null
  focused: boolean
  style: React.CSSProperties
  onGrab: (tabId: string, pane: 'a' | 'b', x: number, y: number) => void
}

// 分屏时每个屏自己的标签栏：切换/关闭/新建/拖入拖出/取消分屏
export default function PaneTabBar({ pane, paneTabs, activeId, focused, style, onGrab }: Props) {
  const setPaneActive   = useAppStore(s => s.setPaneActive)
  const requestCloseTab = useAppStore(s => s.requestCloseTab)
  const closeOtherTabs  = useAppStore(s => s.closeOtherTabs)
  const closeTabsToRight= useAppStore(s => s.closeTabsToRight)
  const moveTabToPane   = useAppStore(s => s.moveTabToPane)
  const openTab         = useAppStore(s => s.openTab)
  const openQueryTab    = useAppStore(s => s.openQueryTab)
  const closeSplit      = useAppStore(s => s.closeSplit)
  const renameTab       = useAppStore(s => s.renameTab)
  const connections     = useAppStore(s => s.connections)
  const tabs            = useAppStore(s => s.tabs)
  const draggingTabId   = useAppStore(s => s.draggingTabId)
  const settings        = useSettingsStore()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeTab  = paneTabs.find(t => t.id === activeId)
  const activeConn = connections.find(c => c.id === activeTab?.connectionId)
  const canNewQuery = !!activeConn && activeConn.type !== 'ssh' && activeConn.type !== 'local'
  const isSSH       = activeTab?.type === 'terminal'
  const isLocalTerm = isSSH && activeConn?.type === 'local'

  useEffect(() => {
    if (renamingId) setTimeout(() => renameInputRef.current?.select(), 30)
  }, [renamingId])

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent) => {
      if (!ctxMenuRef.current?.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ctxMenu])

  function getTitle(tab: WorkspaceTab): string {
    if (tab.type !== 'terminal') return tab.title
    const conn = connections.find(c => c.id === tab.connectionId)
    if (!conn) return tab.title
    if (settings.tabTitleFormat === 'user-at-host' && conn.username && conn.host) {
      return `${conn.username}@${conn.host}`
    }
    return tab.title
  }

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

  function activate(tabId: string) {
    setPaneActive(pane, tabId)
  }

  function handleTabAction(action: TabMouseAction, tab: WorkspaceTab) {
    switch (action) {
      case 'none':
      case 'menu':
        break
      case 'close':
        requestCloseTab(tab.id)
        break
      case 'rename': {
        setRenamingId(tab.id)
        setRenameVal(getTitle(tab))
        break
      }
      case 'new':
      case 'duplicate-ssh':
        if (tab.type === 'terminal') {
          openTab({ ...tab, id: wid(`${tab.connectionId}-terminal-${Date.now()}`) })
        }
        break
      case 'duplicate':
        openTab({ ...tab, id: wid(`${tab.connectionId}-dup-${Date.now()}`) })
        break
    }
  }

  function handleMouseEnter(tabId: string) {
    if (useAppStore.getState().draggingTabId) return
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    const { tabHoverActivate } = useSettingsStore.getState()
    if (tabHoverActivate === 'never') return
    const delay = tabHoverActivate === 'immediately' ? 0
      : tabHoverActivate === '500ms' ? 500 : 1000
    hoverTimerRef.current = setTimeout(() => {
      const latest = useSettingsStore.getState().tabHoverActivate
      if (latest !== 'never') activate(tabId)
    }, delay)
  }

  function handleMouseLeave() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  function finishRename(tabId: string) {
    if (renameVal.trim()) renameTab(tabId, renameVal.trim())
    setRenamingId(null)
  }

  return (
    <div
      className={`pane-tabbar${focused ? ' focused' : ''}`}
      style={style}
      onMouseDown={() => { if (activeId) setPaneActive(pane, activeId) }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation()
        const id = e.dataTransfer.getData('text/plain') || useAppStore.getState().draggingTabId
        if (id) moveTabToPane(id, pane)
      }}
    >
      <div className="pane-tabbar__scroll">
        {paneTabs.map(tab => {
          const globalIdx = tabs.findIndex(t => t.id === tab.id)
          const showNum = settings.tabShowNumber === 'all' || (settings.tabShowNumber === 'first9' && globalIdx >= 0 && globalIdx < 9)
          const isRenaming = renamingId === tab.id
          return (
          <div
            key={tab.id}
            className={`pane-tab${tab.id === activeId ? ' active' : ''}${draggingTabId === tab.id ? ' dragging' : ''}`}
            onPointerDown={e => {
              if (e.button !== 0) return
              e.stopPropagation()
              if (isRenaming) return
              activate(tab.id)
              if (!tab.pinned) {
                e.preventDefault()  // 阻止文本选中；同时阻止后续 mousedown（避免 onMouseDown 重复触发）
                onGrab(tab.id, pane, e.clientX, e.clientY)
              }
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              handleTabAction(useSettingsStore.getState().tabMouseDouble, tab)
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                handleTabAction(useSettingsStore.getState().tabMouseMiddle, tab)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              const action = useSettingsStore.getState().tabMouseRight
              if (action === 'menu') {
                setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
                return
              }
              handleTabAction(action, tab)
            }}
            onMouseEnter={() => handleMouseEnter(tab.id)}
            onMouseLeave={handleMouseLeave}
          >
            {showNum && <span className="pane-tab__num">{globalIdx + 1}</span>}
            {tabIcon(tab)}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                className="pane-tab__rename-input"
                value={renameVal}
                autoFocus
                onChange={e => setRenameVal(e.target.value)}
                onBlur={() => finishRename(tab.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.stopPropagation(); finishRename(tab.id) }
                  if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) }
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className={`pane-tab__label${settings.tabTextTruncate === 'start' ? ' pane-tab__label--start' : ''}`}>
                {tab.dirty && <span className="tab__dirty" data-tip="有未保存的修改">*</span>}
                {getDisplayTitle(tab)}
              </span>
            )}
            {!tab.pinned && (
              <button
                className="pane-tab__close"
                onClick={e => { e.stopPropagation(); requestCloseTab(tab.id) }}
                data-tip="关闭"
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        )})}
      </div>

      {/* DB 连接：新建查询 */}
      {canNewQuery && activeConn && (
        <button
          className="pane-tabbar__btn"
          onClick={() => openQueryTab(activeConn.id)}
          data-tip="新建查询"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      )}

      {/* SSH 终端：显示 SSH 工具下拉（同主标签栏） */}
      {isSSH && (
        <div style={{ display: 'flex', alignItems: 'center', borderLeft: '1px solid var(--border-subtle)' }}>
          <SshToolsMenu isLocalTerm={isLocalTerm} />
        </div>
      )}

      <button className="pane-tabbar__btn" onClick={closeSplit} data-tip="取消分屏">
        <Minimize2 size={13} strokeWidth={2} />
      </button>

      {ctxMenu && createPortal((() => {
        const tab = tabs.find(t => t.id === ctxMenu.tabId)
        if (!tab) return null
        const inThisPane = paneTabs.some(t => t.id === tab.id)
        const menuItems = [
          { label: '关闭标签', action: () => requestCloseTab(tab.id), danger: true },
          { label: '关闭其他标签', action: () => closeOtherTabs(tab.id) },
          { label: '关闭右侧标签', action: () => closeTabsToRight(tab.id) },
          { label: inThisPane && pane === 'a' ? '移到右屏' : '移到左屏', action: () => moveTabToPane(tab.id, pane === 'a' ? 'b' : 'a') },
          { label: '重命名', action: () => handleTabAction('rename', tab) },
        ]
        return (
          <div ref={ctxMenuRef} className="tab-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {menuItems.map((item) => (
              <div
                key={item.label}
                className={`tab-ctx-item${item.danger ? ' danger' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  item.action()
                  setCtxMenu(null)
                }}
              >
                {item.label}
              </div>
            ))}
          </div>
        )
      })(), document.body)}
    </div>
  )
}
