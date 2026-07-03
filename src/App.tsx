import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import ActivityBar from './components/ActivityBar'
import AssetPanel from './components/AssetPanel'
import Workspace from './components/Workspace'
import Toaster from './components/Toaster'
import ExportDoneModal from './components/ExportDoneModal'
import DbErrorBar from './components/DbErrorBar'
import GlobalTooltip from './components/GlobalTooltip'
import ConfirmDialog from './components/ConfirmDialog'
import QuitGuard from './components/QuitGuard'
import { useAppStore } from './stores/appStore'
import { useSettingsStore } from './stores/settingsStore'
import { matchShortcut } from './utils/shortcuts'
import { wid } from './utils/windowTag'
import { onConnectionsChanged, openNewAppWindow, takeAdoptedTab, takeAdoptPayload, onReattach, type AdoptPayload } from './utils/multiWindow'
import { publishWindowRect, removeWindowRect } from './utils/windowRegistry'
import { markAdopt, setAdoptSnapshot } from './utils/adopt'
import { useQueryStore } from './stores/queryStore'
import { attachGlobalWheelScroll } from './utils/wheelScroll'

const ConnectionForm = lazy(() => import('./components/ConnectionForm'))

function ModalLoading() {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 320, padding: 24 }}>
        <div className="modal-title">加载中...</div>
      </div>
    </div>
  )
}

export default function App() {
  const loadConnections = useAppStore((s) => s.loadConnections)
  const newConnType     = useAppStore((s) => s.newConnType)
  const newConnPreset   = useAppStore((s) => s.newConnPreset)
  const closeNewConn    = useAppStore((s) => s.closeNewConn)
  const editingConn     = useAppStore((s) => s.editingConn)
  const closeEditConn   = useAppStore((s) => s.closeEditConn)
  const [panelOpen, setPanelOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(localStorage.getItem('asset-panel-width'))
    return v >= 160 && v <= 480 ? v : 256
  })
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null)
  useEffect(() => { localStorage.setItem('asset-panel-width', String(sidebarWidth)) }, [sidebarWidth])

  const onSidebarDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    document.body.classList.add('resizing')
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return
      const next = Math.max(160, Math.min(480, sidebarDragRef.current.startW + ev.clientX - sidebarDragRef.current.startX))
      setSidebarWidth(next)
    }
    const onUp = () => {
      document.body.classList.remove('resizing')
      sidebarDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 接管一个被撕离（新窗口启动）或拖回（运行中）的标签
  const applyAdopt = useCallback((payload: AdoptPayload) => {
    const { tab, snapshot, sqlDraft } = payload
    const st = useAppStore.getState()
    if (tab.type === 'terminal') {
      // 终端：接管活会话 + 还原画面快照
      markAdopt(tab.id)
      if (snapshot) setAdoptSnapshot(tab.id, snapshot)
    } else {
      // DB 标签：把连接标成已连接，让目标窗口左侧亮绿点并展开库树
      st.markDbConnected(tab.connectionId)
      // 查询页：还原迁移前的 SQL 草稿，避免空白
      if (tab.type === 'query' && sqlDraft != null) {
        useQueryStore.getState().setSql(tab.id, sqlDraft)
      }
    }
    st.openTab(tab)
    st.setActiveTab(tab.id)
  }, [])

  useEffect(() => {
    // 先加载连接（撕离接管的终端要靠 connections 判断本地/SSH），再接管被撕离的标签
    loadConnections().then(() => {
      const adopted = takeAdoptedTab()
      if (adopted) applyAdopt(adopted)
    })
  }, [loadConnections, applyAdopt])

  // 拖回合并：登记本窗口屏幕位置 + 监听其它窗口拖回过来的标签
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    publishWindowRect()
    const iv = setInterval(publishWindowRect, 1500)
    const onWin = () => publishWindowRect()
    window.addEventListener('resize', onWin)
    window.addEventListener('focus', onWin)
    const onUnload = () => removeWindowRect()
    window.addEventListener('beforeunload', onUnload)
    const off = onReattach((token) => {
      const payload = takeAdoptPayload(token)
      if (!payload) return
      applyAdopt(payload)
      const adoptedId = payload.tab.id
      // 提到前台 + 按光标 X 把合并进来的标签插到对应位置（否则只会落到末尾）
      import('@tauri-apps/api/window').then(async ({ getCurrentWindow, cursorPosition }) => {
        const w = getCurrentWindow()
        w.setFocus().catch(() => {})
        try {
          const [cur, ipos, scale] = await Promise.all([cursorPosition(), w.innerPosition(), w.scaleFactor()])
          const localX = (cur.x - ipos.x) / scale
          const els = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]'))
          let targetId: string | null = null
          for (const el of els) {
            const tid = el.dataset.tabId
            if (!tid || tid === adoptedId) continue
            const r = el.getBoundingClientRect()
            if (localX < r.left + r.width / 2) { targetId = tid; break }
          }
          if (targetId) useAppStore.getState().moveTab(adoptedId, targetId)
        } catch { /* 定位失败则保持在末尾 */ }
      }).catch(() => {})
    })
    return () => {
      clearInterval(iv)
      window.removeEventListener('resize', onWin)
      window.removeEventListener('focus', onWin)
      window.removeEventListener('beforeunload', onUnload)
      off()
      removeWindowRect()
    }
  }, [applyAdopt])

  // 副窗口标签被清空（撕离/拖回走最后一个标签）后自动关闭；主窗口保留空白态
  const tabCount = useAppStore((s) => s.tabs.length)
  const everHadTabsRef = useRef(false)
  useEffect(() => {
    if (tabCount > 0) { everHadTabsRef.current = true; return }
    if (!everHadTabsRef.current) return
    if (!('__TAURI_INTERNALS__' in window)) return
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const w = getCurrentWindow()
      if (w.label !== 'main') w.close().catch(() => {})
    }).catch(() => {})
  }, [tabCount])

  // 多开：其它窗口增删改连接后，本窗口重新加载连接列表
  useEffect(() => onConnectionsChanged(() => { void loadConnections() }), [loadConnections])
  useEffect(() => attachGlobalWheelScroll(), [])

  // 全局代理设置同步到后端（启动时 + 变更时）；连接级未配置代理时生效
  const proxyType        = useSettingsStore((s) => s.proxyType)
  const proxyHost        = useSettingsStore((s) => s.proxyHost)
  const proxyPort        = useSettingsStore((s) => s.proxyPort)
  const proxyAuthEnabled = useSettingsStore((s) => s.proxyAuthEnabled)
  const proxyUsername    = useSettingsStore((s) => s.proxyUsername)
  const proxyPassword    = useSettingsStore((s) => s.proxyPassword)
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('set_global_proxy', {
        proxyType,
        host: proxyHost,
        port: proxyPort,
        username: proxyAuthEnabled ? proxyUsername : '',
        password: proxyAuthEnabled ? proxyPassword : '',
      }).catch(() => {})
    })
  }, [proxyType, proxyHost, proxyPort, proxyAuthEnabled, proxyUsername, proxyPassword])

  // 全局键盘快捷键
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const { tabs, activeTabId, setActiveTab, requestCloseTab, openTab } = useAppStore.getState()
      const shortcuts = useSettingsStore.getState().shortcuts

      // 复制当前标签页（默认 ⌘T）
      if (matchShortcut(e, shortcuts.duplicateTab)) {
        e.preventDefault()
        const active = tabs.find(t => t.id === activeTabId)
        if (active) {
          openTab({ ...active, id: wid(`${active.connectionId}-${Date.now()}`) })
        }
        return
      }

      // 关闭当前标签页（默认 ⌘W）
      if (matchShortcut(e, shortcuts.closeTab)) {
        if (activeTabId) { e.preventDefault(); requestCloseTab(activeTabId) }
        return
      }

      // 切换到上一个标签页（默认 ⌘⇧[）
      if (matchShortcut(e, shortcuts.prevTab)) {
        e.preventDefault()
        const idx = tabs.findIndex(t => t.id === activeTabId)
        const prev = idx > 0 ? tabs[idx - 1] : tabs[tabs.length - 1]
        if (prev) setActiveTab(prev.id)
        return
      }

      // 切换到下一个标签页（默认 ⌘⇧]）
      if (matchShortcut(e, shortcuts.nextTab)) {
        e.preventDefault()
        const idx = tabs.findIndex(t => t.id === activeTabId)
        const next = idx < tabs.length - 1 ? tabs[idx + 1] : tabs[0]
        if (next) setActiveTab(next.id)
        return
      }

      // Ctrl+Tab：下一个标签页
      if (matchShortcut(e, shortcuts.cycleTabNext)) {
        e.preventDefault()
        const idx  = tabs.findIndex(t => t.id === activeTabId)
        const next = tabs[(idx + 1) % tabs.length]
        if (next) setActiveTab(next.id)
        return
      }

      // Ctrl+Shift+Tab：上一个标签页
      if (matchShortcut(e, shortcuts.cycleTabPrev)) {
        e.preventDefault()
        const idx  = tabs.findIndex(t => t.id === activeTabId)
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length]
        if (prev) setActiveTab(prev.id)
        return
      }

      // Cmd/Ctrl+1~9：切换到第 n 个 tab（不可配置）
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key >= '1' && e.key <= '9' && !e.shiftKey && !e.altKey) {
        const idx = parseInt(e.key) - 1
        if (tabs[idx]) { e.preventDefault(); setActiveTab(tabs[idx].id) }
      }

      // 打开设置（默认 Mod+,）
      const sc = useSettingsStore.getState().shortcuts
      if (matchShortcut(e, sc.openSettings ?? 'Mod+,')) {
        e.preventDefault()
        useAppStore.getState().openSettings()
        return
      }

      // 新建窗口（默认 Mod+Alt+N）
      if (matchShortcut(e, sc.newWindow ?? 'Mod+Alt+N')) {
        e.preventDefault()
        openNewAppWindow().catch(() => {})
        return
      }

      // 快速搜索连接（默认 Mod+P）
      if (matchShortcut(e, sc.quickSearch ?? 'Mod+P')) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('dbterm:focus-asset-search'))
        return
      }

      // Cmd+` / Ctrl+`：在多开窗口间循环切换（macOS 标准行为，无原生 Window 菜单时手动实现）
      const isMac2 = navigator.platform.toUpperCase().includes('MAC')
      const isBacktick = e.key === '`' && !e.shiftKey && !e.altKey && (isMac2 ? e.metaKey : e.ctrlKey)
      if (isBacktick) {
        e.preventDefault()
        import('@tauri-apps/api/webviewWindow').then(async ({ getAllWebviewWindows, getCurrentWebviewWindow }) => {
          const wins = await getAllWebviewWindows()
          if (wins.length <= 1) return
          const cur     = getCurrentWebviewWindow()
          const curIdx  = wins.findIndex(w => w.label === cur.label)
          const next    = wins[(curIdx + 1) % wins.length]
          await next.setFocus()
        }).catch(() => {})
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // macOS overlay 标题栏：用主题色 28px 拖动条替代原生灰色标题栏
  const isMac = /Mac/i.test(navigator.platform)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {isMac && (
        <div
          data-tauri-drag-region
          style={{ height: 28, flexShrink: 0, background: 'var(--bg)' }}
        />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <ActivityBar panelOpen={panelOpen} onTogglePanel={() => setPanelOpen(v => !v)} />
      <AssetPanel open={panelOpen} onToggle={() => setPanelOpen(v => !v)} width={sidebarWidth} />
      {panelOpen && <div className="resize-handle resize-handle--left" onMouseDown={onSidebarDragStart} />}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', position: 'relative' }}>
        <Workspace />
        {/* 数据库错误条：限定在主内容区底部，不跨到左侧会话栏 */}
        <DbErrorBar />
      </div>
      </div>{/* end flex row */}
      {(newConnType || editingConn) && (
        <Suspense fallback={<ModalLoading />}>
          {newConnType && (
            <ConnectionForm
              category={newConnType === 'db' ? 'db' : newConnType === 'ssh' ? 'terminal' : newConnType === 'local' ? 'terminal' : undefined}
              initialType={newConnPreset ?? undefined}
              onClose={closeNewConn}
            />
          )}
          {editingConn && (
            <ConnectionForm
              initial={editingConn}
              onClose={closeEditConn}
            />
          )}
        </Suspense>
      )}
      <Toaster />
      <ExportDoneModal />
      <ConfirmDialog />
      <QuitGuard />
      <GlobalTooltip />
    </div>
  )
}
