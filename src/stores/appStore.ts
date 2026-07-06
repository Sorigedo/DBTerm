import { create } from 'zustand'
import type { ActiveView, ConnConfig, ConnStatus, ConnType, WorkspaceTab } from '../types'
import { useQueryStore } from './queryStore'
import { useSettingsStore } from './settingsStore'
import { wid } from '../utils/windowTag'
import { broadcastConnectionsChanged } from '../utils/multiWindow'
import { applyLegacyDbEnv } from '../utils/connectionEnv'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('非 Tauri 环境')
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export type SshPanelType = 'files' | 'history' | 'perf' | 'snippets' | 'tunnel' | 'recording'

// 顶层查询标签的全局自增序号（保证 id 唯一，支持同一连接多开）
let querySeq = 0

interface TermCallbacks {
  disconnect: () => void
  reconnect: () => void
}

interface DragPreview {
  tabId: string
  title: string
  x: number
  y: number
}

interface AppState {
  activeView: ActiveView
  connections: ConnConfig[]
  tabs: WorkspaceTab[]
  activeTabId: string | null
  connectedDbConns: Set<string>   // 已"连接"的数据库（左侧绿点 + 树展示），全局以便面包屑切换也能同步
  loading: boolean
  newConnType: 'ssh' | 'db' | 'local' | 'all' | null
  newConnPreset: ConnType | null   // 指定具体类型时跳过选择页直达表单
  newConnGroup: string | null      // 新建后归入的目标分组 ID（来自「新建连接到此分组」）
  editingConn: ConnConfig | null
  activeSshPanel: SshPanelType | null
  broadcastMode: boolean
  termCwd: Record<string, string>
  termDisconnected: Record<string, boolean>
  termCallbacks: Record<string, TermCallbacks>
  settingsOpen: boolean
  pendingRun: Record<string, string>

  setActiveView: (view: ActiveView) => void
  openSettings: () => void
  closeSettings: () => void
  setTermCwd: (id: string, cwd: string) => void
  setTermDisconnected: (id: string, val: boolean) => void
  registerTermCallbacks: (id: string, cbs: TermCallbacks) => void
  unregisterTermCallbacks: (id: string) => void
  loadConnections: () => Promise<void>
  saveConnection: (config: ConnConfig, password?: string) => Promise<ConnConfig>
  deleteConnection: (id: string) => Promise<void>
  updateStatus: (id: string, status: ConnStatus) => void
  openTab: (tab: WorkspaceTab) => void
  /** 打开一个顶层查询标签：SQL 连接每次新建（多开），redis/mongo 复用单例。返回 tabId */
  openQueryTab: (connectionId: string) => string
  /** 打开/复用「对象浏览」固定标签：每连接唯一，随激活 schema/类别切换内容 */
  openObjectTab: (connectionId: string, title: string, meta: Record<string, string>) => void
  dbErrorConns: Set<string>   // 连接失败的数据库（左侧红点）
  markDbConnected: (id: string) => void
  markDbError: (id: string) => void
  markDbDisconnected: (id: string) => void
  closeTab: (tabId: string, force?: boolean) => void
  // 关闭前确认：查询页有 SQL / 对象编辑页有未保存修改时，先弹确认
  closeConfirm: string | null
  /** 返回有未保存内容的标签（含 SQL 文本的查询页、有改动的视图/函数/存储过程编辑页），用于退出确认 */
  unsavedTabs: () => WorkspaceTab[]
  requestCloseTab: (tabId: string) => void
  cancelCloseConfirm: () => void
  closeOtherTabs: (keepId: string) => void
  closeTabsToRight: (fromId: string) => void
  moveTab: (fromId: string, toId: string, position?: 'before' | 'after') => void
  renameTab: (tabId: string, title: string) => void
  setTabMeta: (tabId: string, meta: Record<string, string | undefined>) => void
  setTabDirty: (tabId: string, dirty: boolean) => void
  markTabError: (tabId: string) => void
  clearTabError: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  openNewConn:  (type: 'ssh' | 'db' | 'local' | 'all', preset?: ConnType, groupId?: string) => void
  closeNewConn: () => void
  openEditConn:  (conn: ConnConfig) => void
  closeEditConn: () => void
  duplicateConnection: (id: string) => Promise<void>
  toggleSshPanel: (panel: SshPanelType) => void
  closeSshPanel: () => void
  setBroadcastMode: (on: boolean) => void
  splitOn: boolean              // 分屏是否开启
  splitDir: 'h' | 'v'           // 分屏方向：h=左右，v=上下
  splitRatio: number            // 分屏比例 0.2~0.8，默认 0.5
  paneBTabIds: string[]         // 副屏(B)标签 id；主屏(A)=其余
  activeAId: string | null      // 主屏活动标签
  activeBId: string | null      // 副屏活动标签
  focusedPane: 'a' | 'b'        // 当前聚焦屏
  openSplit: (dir: 'h' | 'v') => void
  closeSplit: () => void
  setSplitRatio: (ratio: number) => void
  moveTabToPane: (tabId: string, pane: 'a' | 'b') => void
  setPaneActive: (pane: 'a' | 'b', tabId: string) => void
  draggingTabId: string | null  // 正在拖拽的标签 id（跨组件共享：标签栏 → 内容区落点）
  setDraggingTab: (id: string | null) => void
  dragPreview: DragPreview | null
  setDragPreview: (preview: DragPreview | null) => void
  setPendingRun: (connId: string, sql: string) => void
  clearPendingRun: (connId: string) => void
  // 只填充编辑器、不自动执行（用于 CREATE TABLE 等模板）
  pendingFill: Record<string, string>
  pendingFillMeta: Record<string, { savedQueryId?: string; savedQueryName?: string }>
  setPendingFill: (connId: string, sql: string, meta?: { savedQueryId?: string; savedQueryName?: string }) => void
  clearPendingFill: (connId: string) => void
  // 以 CodeMirror 代码片段(snippet)方式填充（${...} 为可跳转/输入即替换的占位，类 IDE 入参提示）
  pendingSnippet: Record<string, string>
  setPendingSnippet: (connId: string, tpl: string) => void
  clearPendingSnippet: (connId: string) => void
  // 切换查询页当前 schema（从打开入口带过来，不执行 USE）
  pendingSchema: Record<string, string>
  setPendingSchema: (connId: string, schema: string) => void
  clearPendingSchema: (connId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  activeView: 'all',
  connections: [],
  tabs: [],
  connectedDbConns: new Set<string>(),
  dbErrorConns: new Set<string>(),
  activeTabId: null,
  loading: false,
  newConnType: null,
  newConnPreset: null,
  newConnGroup: null,
  editingConn: null,
  activeSshPanel: null,
  broadcastMode: false,
  termCwd: {},
  termDisconnected: {},
  termCallbacks: {},
  settingsOpen: false,
  splitOn: false,
  splitDir: 'h',
  splitRatio: 0.5,
  paneBTabIds: [],
  activeAId: null,
  activeBId: null,
  focusedPane: 'a',
  draggingTabId: null,
  dragPreview: null,
  pendingRun: {},

  openSplit: (dir) => set((s) => ({
    splitOn: true, splitDir: dir, splitRatio: 0.5, focusedPane: 'b',
    activeAId: s.activeTabId,   // 进入分屏：主屏保持当前活动标签
  })),
  closeSplit: () => set({ splitOn: false, paneBTabIds: [], activeBId: null, focusedPane: 'a' }),
  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
  moveTabToPane: (tabId, pane) => set((s) => {
    if (s.tabs.find(t => t.id === tabId)?.pinned) return {}
    if (pane === 'b') {
      const paneBTabIds = s.paneBTabIds.includes(tabId) ? s.paneBTabIds : [...s.paneBTabIds, tabId]
      const aTabs = s.tabs.filter(t => !paneBTabIds.includes(t.id))
      const activeAId = s.activeAId === tabId ? (aTabs[aTabs.length - 1]?.id ?? null) : s.activeAId
      return { splitOn: true, paneBTabIds, activeBId: tabId, activeAId, focusedPane: 'b', activeTabId: tabId }
    }
    const paneBTabIds = s.paneBTabIds.filter(id => id !== tabId)
    const bTabs = s.tabs.filter(t => paneBTabIds.includes(t.id))
    const activeBId = s.activeBId === tabId ? (bTabs[bTabs.length - 1]?.id ?? null) : s.activeBId
    return { splitOn: paneBTabIds.length > 0, paneBTabIds, activeAId: tabId, activeBId, focusedPane: 'a', activeTabId: tabId }
  }),
  setPaneActive: (pane, tabId) => set(() =>
    pane === 'b'
      ? { activeBId: tabId, focusedPane: 'b', activeTabId: tabId }
      : { activeAId: tabId, focusedPane: 'a', activeTabId: tabId }
  ),
  setDraggingTab: (id) => set({ draggingTabId: id }),
  setDragPreview: (preview) => set({ dragPreview: preview }),
  setActiveView: (view) => set({ activeView: view }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setTermDisconnected: (id, val) =>
    set((s) => ({ termDisconnected: { ...s.termDisconnected, [id]: val } })),
  registerTermCallbacks: (id, cbs) =>
    set((s) => ({ termCallbacks: { ...s.termCallbacks, [id]: cbs } })),
  unregisterTermCallbacks: (id) =>
    set((s) => {
      const next = { ...s.termCallbacks }
      delete next[id]
      return { termCallbacks: next }
    }),

  loadConnections: async () => {
    set({ loading: true })
    try {
      const conns = await invoke<ConnConfig[]>('list_connections')
      // 兼容旧格式：extraJson.isProduction → envLabel='prod'（旧数据未重新保存时顶层字段为空）
      const migrated = conns.map(applyLegacyDbEnv)
      set({ connections: migrated })
    } catch {
      set({ connections: [] })
    } finally {
      set({ loading: false })
    }
  },

  saveConnection: async (config, password) => {
    const saved = await invoke<ConnConfig>('save_connection', { config, password })
    set((s) => {
      const idx = s.connections.findIndex((c) => c.id === saved.id)
      const next = idx >= 0
        ? s.connections.map((c) => (c.id === saved.id ? saved : c))
        : [...s.connections, saved]
      return { connections: next }
    })
    void broadcastConnectionsChanged()
    return saved
  },

  deleteConnection: async (id) => {
    await invoke('delete_connection', { id })
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      tabs: s.tabs.filter((t) => t.connectionId !== id),
    }))
    void broadcastConnectionsChanged()
  },

  updateStatus: (id, status) =>
    set((s) => ({
      connections: s.connections.map((c) => c.id === id ? { ...c, status } : c),
    })),

  openTab: (tab) =>
    set((s) => {
      const toB = s.splitOn && s.focusedPane === 'b'
      const act = toB
        ? { activeBId: tab.id, activeTabId: tab.id }
        : { activeAId: tab.id, activeTabId: tab.id }
      if (s.tabs.find((t) => t.id === tab.id)) return act
      const paneB = toB ? { paneBTabIds: [...s.paneBTabIds, tab.id] } : {}
      const { tabNewPosition } = useSettingsStore.getState()
      if (tabNewPosition === 'after-current' && s.activeTabId) {
        const idx = s.tabs.findIndex((t) => t.id === s.activeTabId)
        const next = [...s.tabs.slice(0, idx + 1), tab, ...s.tabs.slice(idx + 1)]
        return { tabs: next, ...paneB, ...act }
      }
      return { tabs: [...s.tabs, tab], ...paneB, ...act }
    }),

  openQueryTab: (connectionId) => {
    const st = get()
    const conn = st.connections.find((c) => c.id === connectionId)
    const type = conn?.type
    // redis / mongo 的查询面板按连接单例渲染（不支持多实例），复用既有 id
    if (type === 'redis' || type === 'mongodb') {
      const id = wid(`${connectionId}-query`)
      st.openTab({ id, connectionId, title: conn?.name ?? '查询', type: 'query' })
      return id
    }
    // SQL 连接：每次新建一个顶层查询标签，标题「连接名 - 查询N」
    const n = st.tabs.filter((t) => t.type === 'query' && t.connectionId === connectionId).length + 1
    querySeq += 1
    const id = wid(`${connectionId}-query-${querySeq}`)
    const title = `${conn?.name ?? '查询'} - 查询${n}`
    st.openTab({ id, connectionId, title, type: 'query' })
    return id
  },

  openObjectTab: (connectionId, title, meta) =>
    set((s) => {
      // 全局唯一的「对象浏览」固定标签：无论开多少连接，只有这一个，钉在最左第一位，
      // 内容随当前激活的 连接 + schema + 类别 切换。
      const id = wid('__db_objects__')
      // 对象浏览标签属于主屏(A)，聚焦主屏并设为其活动标签
      const act = { activeTabId: id, activeAId: id, focusedPane: 'a' as const }
      if (s.tabs.find(t => t.id === id)) {
        return { tabs: s.tabs.map(t => t.id === id ? { ...t, connectionId, title, meta } : t), ...act }
      }
      const tab: WorkspaceTab = { id, connectionId, title, type: 'schema-browser', pinned: true, meta }
      return { tabs: [tab, ...s.tabs], ...act }
    }),

  markDbConnected: (id) => set((s) => {
    const connected = new Set(s.connectedDbConns); connected.add(id)
    const err = new Set(s.dbErrorConns); err.delete(id)   // 连接成功 → 绿点、清红
    return { connectedDbConns: connected, dbErrorConns: err }
  }),
  markDbError: (id) => set((s) => {
    const err = new Set(s.dbErrorConns); err.add(id)
    const connected = new Set(s.connectedDbConns); connected.delete(id)  // 连接失败 → 红点、清绿
    return { connectedDbConns: connected, dbErrorConns: err }
  }),
  markDbDisconnected: (id) => set((s) => {
    const connected = new Set(s.connectedDbConns); connected.delete(id)
    const err = new Set(s.dbErrorConns); err.delete(id)
    return { connectedDbConns: connected, dbErrorConns: err }
  }),

  closeConfirm: null,

  unsavedTabs: () => {
    return get().tabs.filter(t =>
      (t.type === 'object-editor' && !!t.dirty) ||
      (t.type === 'query' && !!t.dirty)
    )
  },

  // 用户主动关闭单个标签的统一入口：需要确认则弹窗，否则直接关闭
  requestCloseTab: (tabId) => {
    const tab = get().tabs.find(t => t.id === tabId)
    if (!tab || tab.pinned) return
    const needConfirm =
      (tab.type === 'object-editor' && !!tab.dirty) ||
      (tab.type === 'query' && !!tab.dirty)
    if (needConfirm) set({ closeConfirm: tabId })
    else get().closeTab(tabId)
  },
  cancelCloseConfirm: () => set({ closeConfirm: null }),

  closeTab: (tabId, force) => {
    // 固定标签（对象浏览）默认不可关闭；force=true 时强制关闭（断开连接时使用）
    if (!force && get().tabs.find(t => t.id === tabId)?.pinned) return
    useQueryStore.getState().removeSql(tabId)
    set((s) => {
      const { tabCloseActivate } = useSettingsStore.getState()
      const next = s.tabs.filter((t) => t.id !== tabId)
      const termCwd = { ...s.termCwd }
      delete termCwd[tabId]
      const inB = s.paneBTabIds.includes(tabId)
      const paneBTabIds = s.paneBTabIds.filter((id) => id !== tabId)
      // 在所属屏内挑相邻标签接替活动
      const srcIds = inB ? s.paneBTabIds : s.tabs.filter(t => !s.paneBTabIds.includes(t.id)).map(t => t.id)
      const dstIds = inB ? paneBTabIds : next.filter(t => !paneBTabIds.includes(t.id)).map(t => t.id)
      const pick = (cur: string | null) => {
        if (cur !== tabId) return cur
        const pos = srcIds.indexOf(tabId)
        if (tabCloseActivate === 'left') return dstIds[pos - 1] ?? dstIds[pos] ?? dstIds[0] ?? null
        return dstIds[pos] ?? dstIds[pos - 1] ?? dstIds[dstIds.length - 1] ?? null
      }
      let activeAId = inB ? s.activeAId : pick(s.activeAId)
      let activeBId = inB ? pick(s.activeBId) : s.activeBId
      const splitOn = paneBTabIds.length > 0 && s.splitOn
      let focusedPane = s.focusedPane
      if (!splitOn) { focusedPane = 'a'; activeBId = null }
      if (activeAId == null) activeAId = next.find(t => !paneBTabIds.includes(t.id))?.id ?? null
      return {
        tabs: next,
        paneBTabIds,
        activeAId, activeBId, focusedPane,
        activeTabId: focusedPane === 'b' ? activeBId : activeAId,
        splitOn,
        termCwd,
        closeConfirm: s.closeConfirm === tabId ? null : s.closeConfirm,
      }
    })
  },

  closeOtherTabs: (keepId) => {
    set((s) => {
      // 固定标签（对象浏览）保留
      const closedIds = s.tabs.filter(t => t.id !== keepId && !t.pinned).map(t => t.id)
      closedIds.forEach(id => useQueryStore.getState().removeSql(id))
      return { tabs: s.tabs.filter(t => t.id === keepId || t.pinned), activeTabId: keepId }
    })
  },

  closeTabsToRight: (fromId) => {
    set((s) => {
      const idx = s.tabs.findIndex(t => t.id === fromId)
      const toClose = s.tabs.slice(idx + 1).filter(t => !t.pinned)
      toClose.forEach(t => useQueryStore.getState().removeSql(t.id))
      const keep = new Set(toClose.map(t => t.id))
      const next = s.tabs.filter(t => !keep.has(t.id))
      const newActive = next.find(t => t.id === s.activeTabId) ? s.activeTabId : next[next.length - 1]?.id ?? null
      return { tabs: next, activeTabId: newActive }
    })
  },

  moveTab: (fromId, toId, position = 'before') => {
    if (fromId === toId) return
    set((s) => {
      const tabs = [...s.tabs]
      const fi = tabs.findIndex(t => t.id === fromId)
      const ti = tabs.findIndex(t => t.id === toId)
      if (fi < 0 || ti < 0) return s
      const [moved] = tabs.splice(fi, 1)
      const targetIdx = tabs.findIndex(t => t.id === toId)
      if (targetIdx < 0) return s
      tabs.splice(position === 'after' ? targetIdx + 1 : targetIdx, 0, moved)
      return { tabs }
    })
  },

  renameTab: (tabId, title) =>
    set((s) => ({ tabs: s.tabs.map(t => t.id === tabId ? { ...t, title } : t) })),

  setTabMeta: (tabId, meta) =>
    set((s) => ({
      tabs: s.tabs.map(t => {
        if (t.id !== tabId) return t
        const nextMeta: Record<string, string> = { ...(t.meta ?? {}) }
        for (const [key, value] of Object.entries(meta)) {
          if (value === undefined) delete nextMeta[key]
          else nextMeta[key] = value
        }
        return { ...t, meta: nextMeta }
      }),
    })),

  setTabDirty: (tabId, dirty) =>
    set((s) => s.tabs.some(t => t.id === tabId && !!t.dirty !== dirty)
      ? { tabs: s.tabs.map(t => t.id === tabId ? { ...t, dirty } : t) }
      : {}),

  markTabError: (tabId) =>
    set((s) => ({ tabs: s.tabs.map(t => t.id === tabId ? { ...t, error: true } : t) })),

  clearTabError: (tabId) =>
    set((s) => ({ tabs: s.tabs.map(t => t.id === tabId ? { ...t, error: false } : t) })),

  setActiveTab: (tabId) => set((s) =>
    s.splitOn && s.paneBTabIds.includes(tabId)
      ? { activeBId: tabId, focusedPane: 'b', activeTabId: tabId }
      : { activeAId: tabId, focusedPane: 'a', activeTabId: tabId }
  ),
  openNewConn:  (type, preset, groupId) => set({ newConnType: type, newConnPreset: preset ?? null, newConnGroup: groupId ?? null }),
  closeNewConn: ()      => set({ newConnType: null, newConnPreset: null, newConnGroup: null }),
  openEditConn:  (conn) => set({ editingConn: conn }),
  closeEditConn: ()     => set({ editingConn: null }),

  duplicateConnection: async (id) => {
    const { connections, saveConnection } = get()
    const orig = connections.find((c) => c.id === id)
    if (!orig) return
    await saveConnection({ ...orig, id: '', name: `${orig.name} 副本`, createdAt: 0, updatedAt: 0 })
  },

  toggleSshPanel: (panel) =>
    set((s) => ({ activeSshPanel: s.activeSshPanel === panel ? null : panel })),
  closeSshPanel: () => set({ activeSshPanel: null }),
  setBroadcastMode: (broadcastMode) => set({ broadcastMode }),
  setTermCwd: (id, cwd) =>
    set((s) => ({ termCwd: { ...s.termCwd, [id]: cwd } })),
  setPendingRun: (connId, sql) =>
    set((s) => ({ pendingRun: { ...s.pendingRun, [connId]: sql } })),
  clearPendingRun: (connId) =>
    set((s) => {
      const next = { ...s.pendingRun }
      delete next[connId]
      return { pendingRun: next }
    }),
  pendingFill: {},
  pendingFillMeta: {},
  setPendingFill: (connId, sql, meta) =>
    set((s) => {
      const nextMeta = { ...s.pendingFillMeta }
      if (meta) nextMeta[connId] = meta
      else delete nextMeta[connId]
      return {
        pendingFill: { ...s.pendingFill, [connId]: sql },
        pendingFillMeta: nextMeta,
      }
    }),
  clearPendingFill: (connId) =>
    set((s) => {
      const next = { ...s.pendingFill }
      const nextMeta = { ...s.pendingFillMeta }
      delete next[connId]
      delete nextMeta[connId]
      return { pendingFill: next, pendingFillMeta: nextMeta }
    }),
  pendingSnippet: {},
  setPendingSnippet: (connId, tpl) =>
    set((s) => ({ pendingSnippet: { ...s.pendingSnippet, [connId]: tpl } })),
  clearPendingSnippet: (connId) =>
    set((s) => {
      const next = { ...s.pendingSnippet }
      delete next[connId]
      return { pendingSnippet: next }
    }),
  pendingSchema: {},
  setPendingSchema: (connId, schema) =>
    set((s) => ({ pendingSchema: { ...s.pendingSchema, [connId]: schema } })),
  clearPendingSchema: (connId) =>
    set((s) => {
      const next = { ...s.pendingSchema }
      delete next[connId]
      return { pendingSchema: next }
    }),
}))
