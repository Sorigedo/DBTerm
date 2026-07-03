import { lazy, Suspense, useState, useRef, useEffect, useCallback } from 'react'
import { Wifi, Send } from 'lucide-react'
import TabBar from './TabBar'
import PaneTabBar from './PaneTabBar'
import EmptyState from './EmptyState'
import CloseConfirmModal from './CloseConfirmModal'
import ErrorBoundary from '../ErrorBoundary'
import { useAppStore } from '../../stores/appStore'
import { useDbToolsStore } from '../../stores/dbToolsStore'
import { resolveDropTarget } from './splitDrop'
import type { WorkspaceTab, ConnConfig } from '../../types'

const Terminal = lazy(() => import('../Terminal'))
const SshSidePanel = lazy(() => import('../SshPanels'))
const SqlEditor = lazy(() => import('../SqlEditor'))
const ObjectEditor = lazy(() => import('../SqlEditor/ObjectEditor'))
const RedisBrowser = lazy(() => import('../RedisBrowser'))
const MongoBrowser = lazy(() => import('../MongoBrowser'))
const SchemaBrowser = lazy(() => import('../SchemaBrowser'))
const TableBrowser = lazy(() => import('../DbTools/TableBrowser'))
const DbToolPanels = lazy(() => import('../DbTools/DbToolPanels'))

function LazyPaneFallback({ label = '加载中...' }: { label?: string }) {
  return <div className="workspace-lazy-fallback">{label}</div>
}

function BroadcastBar({ tabs, connections }: { tabs: WorkspaceTab[], connections: ConnConfig[] }) {
  const [cmd, setCmd] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const termTabs = tabs.filter(t => t.type === 'terminal')

  useEffect(() => { inputRef.current?.focus() }, [])

  function sendToAll() {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    const bytes = Array.from(new TextEncoder().encode(trimmed + '\r'))
    import('@tauri-apps/api/core').then(({ invoke }) => {
      termTabs.forEach(t => {
        const conn = connections.find(c => c.id === t.connectionId)
        const method = conn?.type === 'local' ? 'write_to_pty' : 'write_to_ssh'
        invoke(method, { id: t.id, data: bytes }).catch(() => {})
      })
    })
    setCmd('')
    inputRef.current?.focus()
  }

  return (
    <div className="broadcast-bar">
      <Wifi size={13} className="broadcast-bar__icon" />
      <span className="broadcast-bar__label">广播 · {termTabs.length} 个终端</span>
      <div className="broadcast-bar__sep" />
      <input
        ref={inputRef}
        className="broadcast-bar__input"
        placeholder="输入命令，按 Enter 发送到所有终端…"
        value={cmd}
        onChange={e => setCmd(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); sendToAll() }
          if (e.key === 'Escape') setCmd('')
        }}
      />
      <button className="broadcast-bar__send" onClick={sendToAll} disabled={!cmd.trim()}>
        <Send size={12} />
      </button>
    </div>
  )
}

export default function Workspace() {
  const tabs           = useAppStore((s) => s.tabs)
  const activeTabId    = useAppStore((s) => s.activeTabId)
  const activeSshPanel = useAppStore((s) => s.activeSshPanel)
  const connections    = useAppStore((s) => s.connections)
  const broadcastMode  = useAppStore((s) => s.broadcastMode)
  const markTabError   = useAppStore((s) => s.markTabError)
  const clearTabError  = useAppStore((s) => s.clearTabError)
  const splitOn        = useAppStore((s) => s.splitOn)
  const splitDir       = useAppStore((s) => s.splitDir)
  const paneBTabIds    = useAppStore((s) => s.paneBTabIds)
  const activeAId      = useAppStore((s) => s.activeAId)
  const activeBId      = useAppStore((s) => s.activeBId)
  const focusedPane    = useAppStore((s) => s.focusedPane)
  const moveTabToPane  = useAppStore((s) => s.moveTabToPane)
  const openSplit      = useAppStore((s) => s.openSplit)
  const closeSplit     = useAppStore((s) => s.closeSplit)
  const splitRatio     = useAppStore((s) => s.splitRatio)
  const setSplitRatio  = useAppStore((s) => s.setSplitRatio)
  const draggingTabId  = useAppStore((s) => s.draggingTabId)
  const dbToolOpen     = useDbToolsStore((s) => !!s.open)
  const [dropZone, setDropZone] = useState<string | null>(null)  // 当前悬停的落点 key
  const [panelWidth, setPanelWidth] = useState(320)
  const panelDragRef = useRef<{ startX: number; startW: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)  // workspace-content 元素 ref，用于 pointer-drag 定位计算


  const onPanelDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    document.body.classList.add('resizing')
    panelDragRef.current = { startX: e.clientX, startW: panelWidth }
    const onMove = (ev: MouseEvent) => {
      if (!panelDragRef.current) return
      const next = Math.max(220, Math.min(640, panelDragRef.current.startW + panelDragRef.current.startX - ev.clientX))
      setPanelWidth(next)
    }
    const onUp = () => {
      document.body.classList.remove('resizing')
      panelDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [panelWidth])
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeConn = connections.find(c => c.id === activeTab?.connectionId)

  const PBAR = 34  // 分屏时每屏标签栏高度
  const paneOf = (id: string): 'a' | 'b' => paneBTabIds.includes(id) ? 'b' : 'a'
  const isTabVisible = (id: string) => {
    if (!splitOn) return id === activeTabId   // 未分屏用规范字段，兼容所有打开路径
    return paneOf(id) === 'a' ? id === activeAId : id === activeBId
  }
  const paneStyle = (id: string, keepMounted = false): React.CSSProperties => {
    const visible = isTabVisible(id)
    const hidden: React.CSSProperties = keepMounted
      ? { visibility: 'hidden', pointerEvents: 'none' }
      : { display: 'none' }
    const shown: React.CSSProperties = keepMounted
      ? { visibility: 'visible', pointerEvents: 'auto' }
      : { display: 'flex' }
    if (!visible) return { position: 'absolute', inset: 0, flexDirection: 'column', ...hidden }
    if (!splitOn) return { position: 'absolute', inset: 0, flexDirection: 'column', ...shown }
    const horiz = splitDir === 'h'
    const isA = paneOf(id) === 'a'
    const pct = splitRatio * 100
    return {
      position: 'absolute',
      top:    horiz ? PBAR : (isA ? PBAR : `calc(${pct}% + ${PBAR}px)`),
      bottom: horiz ? 0 : (isA ? `${100 - pct}%` : 0),
      left:   horiz ? (isA ? 0 : `${pct}%`) : 0,
      right:  horiz ? (isA ? `${100 - pct}%` : 0) : 0,
      flexDirection: 'column',
      ...shown,
    }
  }
  const isSSH = activeTab?.type === 'terminal'
  const isLocalTerm = isSSH && activeConn?.type === 'local'
  const hasTermTabs = tabs.some(t => t.type === 'terminal')
  // 本地终端仅支持历史面板；SSH 支持全部面板
  const panelVisible = isSSH && !!activeSshPanel && (!isLocalTerm || activeSshPanel === 'history')

  const runCommand = useCallback((cmd: string) => {
    if (!('__TAURI_INTERNALS__' in window) || !activeTab) return
    const conn = connections.find(c => c.id === activeTab.connectionId)
    const bytes = Array.from(new TextEncoder().encode(cmd + '\r'))
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke(conn?.type === 'local' ? 'write_to_pty' : 'write_to_ssh', { id: activeTab.id, data: bytes }).catch(() => {})
    })
  }, [activeTab, connections])

  // 分割线拖拽：改变两屏比例
  const onDividerDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    document.body.style.cursor = splitDir === 'h' ? 'col-resize' : 'row-resize'
    const onMove = (ev: MouseEvent) => {
      const { splitDir: sd } = useAppStore.getState()
      const ratio = sd === 'h'
        ? (ev.clientX - r.left) / r.width
        : (ev.clientY - r.top) / r.height
      setSplitRatio(ratio)
    }
    const onUp = () => {
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [splitDir, setSplitRatio])

  // PaneTabBar 标签拖移：用 Pointer Events 替代 HTML5 DnD
  // WebView2 深层 overflow:hidden flex 容器内 dragstart 无法触发，改用 pointerdown/pointermove/pointerup
  const handlePaneTabGrab = useCallback((tabId: string, pane: 'a' | 'b', startX: number, startY: number) => {
    const drag = { tabId, pane, startX, startY, started: false }

    const computeKey = (cx: number, cy: number): string => {
      const el = wrapRef.current
      if (!el) return 'split-h'
      const r = el.getBoundingClientRect()
      const fx = (cx - r.left) / r.width
      const fy = (cy - r.top) / r.height
      const { splitOn: so, splitDir: sd } = useAppStore.getState()
      if (so) return (sd === 'h' ? fx >= 0.5 : fy >= 0.5) ? 'second' : 'main'
      if (fx >= 0.5) return 'split-h'
      if (fy >= 0.5) return 'split-v'
      return 'split-h'
    }

    const onMove = (e: PointerEvent) => {
      if (!drag.started) {
        if (Math.abs(e.clientX - drag.startX) > 5 || Math.abs(e.clientY - drag.startY) > 5) {
          drag.started = true
          useAppStore.getState().setDraggingTab(drag.tabId)
        }
      }
      if (drag.started) setDropZone(computeKey(e.clientX, e.clientY))
    }

    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const st = useAppStore.getState()
      st.setDraggingTab(null)
      setDropZone(null)
      if (!drag.started) return
      const tgt = resolveDropTarget(e.clientX, e.clientY, st.splitOn, st.splitDir)
      if (tgt?.kind === 'pane' && tgt.pane !== drag.pane) {
        moveTabToPane(drag.tabId, tgt.pane)
      } else if (!st.splitOn && tgt?.kind === 'split') {
        openSplit(tgt.dir)
        moveTabToPane(drag.tabId, 'b')
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [moveTabToPane, openSplit])

  const paneATabs = tabs.filter(t => !paneBTabIds.includes(t.id))
  const paneBTabs = tabs.filter(t => paneBTabIds.includes(t.id))
  const horiz = splitDir === 'h'

  return (
    <div className="workspace">
      {tabs.length > 0 && !splitOn && <TabBar />}
      <div className={`workspace-body${panelVisible ? ' with-panel' : ''}`}>
        <div className="workspace-content" ref={wrapRef}>
          {tabs.length === 0 && <EmptyState />}

          {splitOn && (
            <>
              <PaneTabBar
                pane="a" paneTabs={paneATabs} activeId={activeAId} focused={focusedPane === 'a'}
                onGrab={handlePaneTabGrab}
                style={{ position: 'absolute', top: 0, left: 0,
                  width: horiz ? `${splitRatio * 100}%` : '100%', height: 34 }}
              />
              <PaneTabBar
                pane="b" paneTabs={paneBTabs} activeId={activeBId} focused={focusedPane === 'b'}
                onGrab={handlePaneTabGrab}
                style={{ position: 'absolute',
                  top: horiz ? 0 : `${splitRatio * 100}%`,
                  left: horiz ? `${splitRatio * 100}%` : 0,
                  width: horiz ? `${(1 - splitRatio) * 100}%` : '100%', height: 34 }}
              />
              {/* 可拖拽分割线 */}
              <div
                className="wsplit-divider"
                style={horiz
                  ? { position: 'absolute', top: 0, bottom: 0, left: `${splitRatio * 100}%`, width: 4,
                      transform: 'translateX(-2px)', cursor: 'col-resize', zIndex: 35 }
                  : { position: 'absolute', left: 0, right: 0, top: `${splitRatio * 100}%`, height: 4,
                      transform: 'translateY(-2px)', cursor: 'row-resize', zIndex: 35 }}
                onMouseDown={onDividerDrag}
              />
            </>
          )}

          {/* 终端 tab 始终保持挂载，切换其他 tab 时仅隐藏，避免 PTY 被销毁 */}
          {tabs
            .filter((t) => t.type === 'terminal')
            .map((t) => {
              const conn = connections.find((c) => c.id === t.connectionId)
              // 每个 tab 都用自己的 t.id 作为 sessionId（本地 PTY 和 SSH 都独立）
              const sessionId = t.id
              return (
                <div key={t.id} style={paneStyle(t.id, true)}>
                  <ErrorBoundary label="终端">
                    <Suspense fallback={<LazyPaneFallback label="正在加载终端..." />}>
                      <Terminal
                        sessionId={sessionId}
                        connectionId={t.connectionId}
                        connType={conn?.type}
                        active={activeTabId === t.id}
                        onError={() => markTabError(t.id)}
                        onConnected={() => clearTabError(t.id)}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )
            })}

          {/* DB query tab */}
          {tabs
            .filter((t) => t.type === 'query')
            .map((t) => {
              const conn = connections.find((c) => c.id === t.connectionId)
              return (
                <div key={t.id} style={paneStyle(t.id)}>
                  <ErrorBoundary label={
                    conn?.type === 'redis' ? 'Redis' :
                    conn?.type === 'mongodb' ? 'MongoDB' : 'SQL 编辑器'
                  }>
                    <Suspense fallback={<LazyPaneFallback label="正在加载查询工作区..." />}>
                      {conn?.type === 'redis'
                        ? <RedisBrowser connectionId={t.connectionId} active={isTabVisible(t.id)} />
                        : conn?.type === 'mongodb'
                        ? <MongoBrowser connectionId={t.connectionId} />
                        : <SqlEditor
                            tabId={t.id}
                            connectionId={t.connectionId}
                            connType={conn?.type ?? 'mysql'}
                          />
                      }
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )
            })}

          {/* 对象设计页（新建视图/函数/存储过程）*/}
          {tabs
            .filter((t) => t.type === 'object-editor')
            .map((t) => {
              const conn = connections.find((c) => c.id === t.connectionId)
              return (
                <div key={t.id} style={paneStyle(t.id)}>
                  <ErrorBoundary label="对象设计器">
                    <Suspense fallback={<LazyPaneFallback label="正在加载对象设计器..." />}>
                      <ObjectEditor
                        tabId={t.id}
                        connectionId={t.connectionId}
                        connType={conn?.type ?? 'mysql'}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )
            })}

          {/* Schema Browser 标签页 */}
          {tabs
            .filter(t => t.type === 'schema-browser')
            .map(t => {
              const conn = connections.find(c => c.id === t.connectionId)
              return (
                <div key={t.id} style={paneStyle(t.id)}>
                  <ErrorBoundary label="对象浏览器">
                    <Suspense fallback={<LazyPaneFallback label="正在加载对象浏览器..." />}>
                      <SchemaBrowser
                        connectionId={t.connectionId}
                        connType={conn?.type ?? 'mysql'}
                        schema={t.meta?.schema ?? ''}
                        category={t.meta?.category ?? 'tables'}
                        active={isTabVisible(t.id)}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )
            })}

          {/* 表数据网格标签页 */}
          {tabs
            .filter(t => t.type === 'table-data')
            .map(t => {
              const conn = connections.find(c => c.id === t.connectionId)
              return (
                <div key={t.id} style={paneStyle(t.id)}>
                  <ErrorBoundary label="表数据">
                    <Suspense fallback={<LazyPaneFallback label="正在加载表数据..." />}>
                      <TableBrowser
                        connectionId={t.connectionId}
                        connType={conn?.type ?? 'mysql'}
                        schema={t.meta?.schema ?? ''}
                        table={t.meta?.table ?? ''}
                        embedded
                        active={isTabVisible(t.id)}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )
            })}

          {/* 分屏已开但副屏为空：占位提示 + 取消分屏（纯视觉，drop 由 overlay 处理） */}
          {splitOn && paneBTabs.length === 0 && (
            <div
              className="wsplit-empty"
              style={horiz
                ? { position: 'absolute', top: 34, right: 0, bottom: 0,
                    width: `${(1 - splitRatio) * 100}%` }
                : { position: 'absolute', bottom: 0, left: 0, right: 0,
                    height: `calc(${(1 - splitRatio) * 100}% - 34px)` }}
            >
              <div className="wsplit-empty__box">
                <span className="wsplit-empty__title">拖动标签到此处</span>
                <button className="wsplit-empty__cancel" onClick={closeSplit}>取消分屏</button>
              </div>
            </div>
          )}

          {/* 全屏透明拖拽 overlay（z-50）：统一接管所有 drag 事件，彻底绕过 xterm canvas 的 z-index 竞争 */}
          {draggingTabId && (splitOn || tabs.filter(t => !t.pinned).length >= 2) && (() => {
            const draggingTab = tabs.find(t => t.id === draggingTabId)
            if (!draggingTab || draggingTab.pinned) return null

            // 根据光标在 overlay 内的相对位置决定操作目标
            const getZoneKey = (e: React.DragEvent): string | null => {
              const r = e.currentTarget.getBoundingClientRect()
              const fx = (e.clientX - r.left) / r.width
              const fy = (e.clientY - r.top) / r.height
              if (splitOn) return (horiz ? fx >= 0.5 : fy >= 0.5) ? 'second' : 'main'
              if (fx >= 0.5) return 'split-h'
              if (fy >= 0.5) return 'split-v'
              return 'split-h'  // 默认左右分屏
            }

            const zoneVisuals = splitOn
              ? (horiz
                  ? [{ key: 'main', tip: '移到左屏', style: { top:0, left:0, bottom:0, width:'50%' } as React.CSSProperties },
                     { key: 'second', tip: '移到右屏', style: { top:0, right:0, bottom:0, width:'50%' } as React.CSSProperties }]
                  : [{ key: 'main', tip: '移到上屏', style: { top:0, left:0, right:0, height:'50%' } as React.CSSProperties },
                     { key: 'second', tip: '移到下屏', style: { bottom:0, left:0, right:0, height:'50%' } as React.CSSProperties }])
              : [{ key: 'split-h', tip: '左右分屏', style: { top:0, right:0, bottom:0, width:'42%' } as React.CSSProperties },
                 { key: 'split-v', tip: '上下分屏', style: { bottom:0, left:0, width:'58%', height:'42%' } as React.CSSProperties }]

            return (
              <div
                key="drag-overlay"
                style={{ position: 'absolute', top:0, left:0, right:0, bottom:0, zIndex: 50 }}
                onDragOver={e => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const key = getZoneKey(e)
                  if (dropZone !== key) setDropZone(key)
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null)
                }}
                onDrop={e => {
                  e.preventDefault()
                  const id = draggingTabId
                  setDropZone(null)
                  if (!id) return
                  const key = getZoneKey(e)
                  if (splitOn) {
                    moveTabToPane(id, key === 'second' ? 'b' : 'a')
                  } else {
                    openSplit(key === 'split-v' ? 'v' : 'h')
                    moveTabToPane(id, 'b')
                  }
                }}
              >
                {zoneVisuals.map(z => (
                  <div
                    key={z.key}
                    className={`wsplit-zone${dropZone === z.key ? ' over' : ''}`}
                    style={{ position: 'absolute', pointerEvents: 'none', ...z.style }}
                  >
                    <span className="wsplit-zone__tip">{z.tip}</span>
                  </div>
                ))}
              </div>
            )
          })()}

        </div>

        {panelVisible && (
          <>
            <div className="resize-handle resize-handle--right" onMouseDown={onPanelDragStart} />
            <Suspense fallback={<LazyPaneFallback label="正在加载 SSH 工具..." />}>
              <SshSidePanel sessionId={activeTab!.connectionId} panelWidth={panelWidth} onRunCommand={runCommand} />
            </Suspense>
          </>
        )}
      </div>

      {broadcastMode && hasTermTabs && (
        <BroadcastBar tabs={tabs} connections={connections} />
      )}

      <CloseConfirmModal />
      {/* 全局 DB 运维工具面板 host：由 DBA工具/对象工具/高级工具 入口派发打开 */}
      {dbToolOpen && (
        <Suspense fallback={<LazyPaneFallback label="正在加载数据库工具..." />}>
          <DbToolPanels />
        </Suspense>
      )}
    </div>
  )
}
