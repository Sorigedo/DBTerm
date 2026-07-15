import { lazy, Suspense, useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Plus, RefreshCw, FolderPlus, ChevronRight, Settings, ChevronsDownUp, ChevronsUpDown, FileInput, FileOutput, Folder, Pencil, Trash2, LogIn, LogOut, FolderMinus, Search, X, FileText, ShieldCheck } from 'lucide-react'
import ConnectionItem, { NEW_CONN_SUBMENU, makeNewConnSubmenu } from './ConnectionItem'
import type { MigratePreset } from '../../utils/dbCopyPaste'
import { useAppStore } from '../../stores/appStore'
import { useGroupStore } from '../../stores/groupStore'
import { useQueryStore } from '../../stores/queryStore'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import type { ConnConfig, ActiveView, ConnType } from '../../types'
import { getActiveRegion } from '../../utils/activeRegion'
import { wid } from '../../utils/windowTag'
import { collapseAllTrees } from '../../utils/schemaRefresh'
import { useShortcuts } from '../../utils/useShortcuts'
import { displayShortcutStr } from '../../utils/shortcuts'
import { useSettingsStore } from '../../stores/settingsStore'
import { addSavedQuery, renameSavedQuery, updateSavedQuery } from '../../utils/savedQueries'

const ExportDialog = lazy(() => import('../shared/ExportDialog'))
const KnownHostsManager = lazy(() => import('./KnownHostsManager'))
const MigrationWizard = lazy(() => import('../DbTools/MigrationWizard'))
const DbSchemaTree = lazy(() => import('./DbSchemaTree'))

const DEFAULT_SQL = ''
interface SqlItem { key: string; label: string; sql: string; connId: string; savedQueryId?: string; savedQueryName?: string }
interface DisconnectQueueItem { tabId: string; tabLabel: string; sqlItems: SqlItem[] }
interface DisconnectFlow {
  connId: string
  connName: string
  allTabIds: string[]
  queue: DisconnectQueueItem[]   // only edit tabs with non-default SQL
  step: number                    // current queue index being confirmed
}

const TITLES: Record<ActiveView, string> = {
  all: '全部连接',
  ssh: 'SSH 会话',
  db:  '数据库',
}

function LazyAssetModalFallback() {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 320, padding: 24 }}>
        <div className="modal-title">加载中...</div>
      </div>
    </div>
  )
}

// 按自定义顺序数组对条目稳定排序；不在 order 里的保持原有相对位置并排到末尾
function orderBy<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (!order || order.length === 0) return items
  const idx = new Map(order.map((id, i) => [id, i]))
  return [...items].sort((a, b) => (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity))
}

// 未分组连接所属的「桶」key（按类型分区）
const sectionBucket = (c: { type: string }) =>
  c.type === 'local' ? '__local' : c.type === 'ssh' ? '__ssh' : '__db'

interface Props {
  open: boolean
  onToggle?: () => void
  width?: number
}

function GroupRenameInput({ initialName, onConfirm, onCancel }: {
  initialName: string
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(initialName)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.select() }, [])
  return (
    <input
      ref={ref}
      className="group-rename-input"
      value={val}
      autoFocus
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.stopPropagation(); if (val.trim()) onConfirm(val.trim()); else onCancel() }
        if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      }}
      onBlur={() => { if (val.trim()) onConfirm(val.trim()); else onCancel() }}
      onClick={e => e.stopPropagation()}
    />
  )
}

export default function AssetPanel({ open, width }: Props) {
  const { activeView, connections, activeTabId, tabs, openNewConn, loadConnections, openSettings, saveConnection, openTab, closeTab, setActiveTab, connectedDbConns, markDbConnected, markDbDisconnected, dbErrorConns, markDbError, pendingTreeSchema } = useAppStore()
  const { groups, connGroupMap, collapsedGroups, groupOrder, connOrder, addGroup, deleteGroup, renameGroup, toggleCollapsed, collapseAll, expandAll, moveToGroup } = useGroupStore()
  const [expandedDbConns,  setExpandedDbConns]  = useState<Set<string>>(new Set())
  // 连接"变为已连接"时自动展开其库树一次（含多窗口撕离接管 DB 标签的场景）；
  // 仅对新增的连接展开，不会和用户手动收起已连接库树相冲突。
  const seenConnectedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const newly = [...connectedDbConns].filter(id => !seenConnectedRef.current.has(id))
    if (newly.length) setExpandedDbConns(s => new Set([...s, ...newly]))
    seenConnectedRef.current = new Set(connectedDbConns)
  }, [connectedDbConns])
  useEffect(() => {
    const ids = Object.keys(pendingTreeSchema)
    if (ids.length) setExpandedDbConns(s => new Set([...s, ...ids]))
  }, [pendingTreeSchema])
  const [disconnectFlow, setDisconnectFlow] = useState<DisconnectFlow | null>(null)
  const [knownHostsOpen, setKnownHostsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  // 跨 schema/连接 粘贴 → 数据迁移向导
  const [migratePreset, setMigratePreset] = useState<MigratePreset | null>(null)
  const [connError, setConnError] = useState<{ connId: string; connName: string; msg: string } | null>(null)
  const [connecting, setConnecting] = useState<Set<string>>(new Set())
  const [dragGhost, setDragGhost] = useState<{ kind: 'conn' | 'group'; id: string; label: string; x: number; y: number } | null>(null)
  // 拖拽插入指示：在某连接/分组的上方或下方
  const [dropTarget, setDropTarget] = useState<{ kind: 'conn' | 'group'; id: string; before: boolean } | null>(null)
  const dragOverRef    = useRef<string | null>(null)   // 当前悬停的 groupId（拖入分组用）
  const dragKindRef    = useRef<'conn' | 'group' | null>(null)
  const dragIdRef      = useRef<string | null>(null)    // 当前被拖拽的 connId / groupId
  const dropTargetRef  = useRef<{ kind: 'conn' | 'group'; id: string; before: boolean } | null>(null)
  const groupEls       = useRef(new Map<string, HTMLDivElement>())  // groupId → DOM element
  const connEls        = useRef(new Map<string, HTMLDivElement>())  // connId → 行 DOM element

  // 某「桶」内当前显示顺序的 connId 列表（桶 = groupId 或 __local/__ssh/__db）
  const bucketConnIds = useCallback((bucket: string): string[] => {
    const gs = useGroupStore.getState()
    const conns = useAppStore.getState().connections
    const inGroup = (id: string) => gs.connGroupMap[id] && gs.groups.some(g => g.id === gs.connGroupMap[id])
    const arr = bucket.startsWith('__')
      ? conns.filter(c => !inGroup(c.id) && sectionBucket(c) === bucket)
      : conns.filter(c => gs.connGroupMap[c.id] === bucket)
    return orderBy(arr, gs.connOrder[bucket] ?? []).map(c => c.id)
  }, [])

  const commitConnReorder = useCallback((bucket: string, dragId: string, targetId: string, before: boolean) => {
    const ids = bucketConnIds(bucket)
    const rest = ids.filter(id => id !== dragId)
    const ti = rest.indexOf(targetId)
    if (ti < 0) { useGroupStore.getState().setConnOrder(bucket, [...rest, dragId]); return }
    rest.splice(before ? ti : ti + 1, 0, dragId)
    useGroupStore.getState().setConnOrder(bucket, rest)
  }, [bucketConnIds])

  // 鼠标拖拽追踪：当 dragGhost 存在时绑定到 document
  const isDragging = !!dragGhost
  useEffect(() => {
    if (!isDragging) return

    const onMove = (e: MouseEvent) => {
      setDragGhost(d => d ? { ...d, x: e.clientX, y: e.clientY } : null)
      const x = e.clientX, y = e.clientY

      if (dragKindRef.current === 'group') {
        // 分组重排：命中其它分组容器
        let hit: { id: string; before: boolean } | null = null
        for (const [gid, el] of groupEls.current) {
          if (gid === dragIdRef.current) continue
          const r = el.getBoundingClientRect()
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            hit = { id: gid, before: y < r.top + r.height / 2 }; break
          }
        }
        dropTargetRef.current = hit ? { kind: 'group', ...hit } : null
        setDropTarget(dropTargetRef.current)
        return
      }

      // 拖拽连接：优先命中具体连接行（重排 / 入组定位），否则命中分组容器（入组末尾）
      let connHit: { id: string; before: boolean } | null = null
      for (const [cid, el] of connEls.current) {
        if (cid === dragIdRef.current) continue
        const r = el.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          connHit = { id: cid, before: y < r.top + r.height / 2 }; break
        }
      }
      if (connHit) {
        dropTargetRef.current = { kind: 'conn', ...connHit }
        setDropTarget(dropTargetRef.current)
        dragOverRef.current = null
        setDragOverGroup(null)
        return
      }
      dropTargetRef.current = null
      setDropTarget(null)
      let gHit: string | null = null
      for (const [gid, el] of groupEls.current) {
        const r = el.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { gHit = gid; break }
      }
      dragOverRef.current = gHit
      setDragOverGroup(gHit)
    }

    const onUp = () => {
      const drag = dragIdRef.current
      const dt = dropTargetRef.current
      const gs = useGroupStore.getState()
      const conns = useAppStore.getState().connections

      if (dragKindRef.current === 'group' && drag) {
        if (dt && dt.kind === 'group' && dt.id !== drag) {
          const ids = orderBy(gs.groups, gs.groupOrder).map(g => g.id)
          const rest = ids.filter(id => id !== drag)
          const ti = rest.indexOf(dt.id)
          if (ti >= 0) { rest.splice(dt.before ? ti : ti + 1, 0, drag); gs.setGroupOrder(rest) }
        }
      } else if (dragKindRef.current === 'conn' && drag) {
        if (dt && dt.kind === 'conn' && dt.id !== drag) {
          const targetGroup = gs.connGroupMap[dt.id] || ''
          const dragConn = conns.find(c => c.id === drag)
          const targetConn = conns.find(c => c.id === dt.id)
          if (dragConn && targetConn) {
            if (targetGroup) {
              gs.moveToGroup(drag, targetGroup)
              commitConnReorder(targetGroup, drag, dt.id, dt.before)
            } else if (sectionBucket(dragConn) === sectionBucket(targetConn)) {
              if (gs.connGroupMap[drag]) gs.moveToGroup(drag, '')
              commitConnReorder(sectionBucket(targetConn), drag, dt.id, dt.before)
            } else if (gs.connGroupMap[drag]) {
              gs.moveToGroup(drag, '')   // 跨类型未分组：仅移出分组
            }
          }
        } else if (dragOverRef.current) {
          gs.moveToGroup(drag, dragOverRef.current)   // 拖到分组容器 → 入组末尾
        } else if (gs.connGroupMap[drag]) {
          gs.moveToGroup(drag, '')                     // 拖到空白 → 移出分组
        }
      }

      dragKindRef.current = null
      dragIdRef.current   = null
      dragOverRef.current = null
      dropTargetRef.current = null
      setDragGhost(null)
      setDragOverGroup(null)
      setDropTarget(null)
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor    = 'grabbing'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging])

  const onConnDragStart = useCallback((connId: string, label: string, x: number, y: number) => {
    dragKindRef.current = 'conn'
    dragIdRef.current = connId
    setDragGhost({ kind: 'conn', id: connId, label, x, y })
  }, [])

  // 分组表头拖拽起步（阈值 5px，未越过阈值则视为点击折叠）
  const groupClickSuppress = useRef(false)
  const onGroupHeaderMouseDown = useCallback((groupId: string, label: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY
    groupClickSuppress.current = false
    const onMove = (me: MouseEvent) => {
      if ((me.clientX - sx) ** 2 + (me.clientY - sy) ** 2 > 25) {
        groupClickSuppress.current = true
        dragKindRef.current = 'group'
        dragIdRef.current = groupId
        setDragGhost({ kind: 'group', id: groupId, label, x: me.clientX, y: me.clientY })
        cleanup()
      }
    }
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', cleanup)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', cleanup)
  }, [])

  // KB0.6 快速搜索：响应全局 Mod+P 事件
  useEffect(() => {
    const handler = () => { setSearchQuery('') }
    window.addEventListener('dbterm:focus-asset-search', handler)
    return () => window.removeEventListener('dbterm:focus-asset-search', handler)
  }, [])

  // 搜索快捷键（Ctrl+F / Cmd+F）：仅当"侧栏"为当前激活区域时，切换侧栏搜索，
  // 并在 capture 阶段拦截，阻止工作区标签页的同名搜索快捷键（dbTreeSearch 等）触发。
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || e.altKey || !(e.ctrlKey || e.metaKey)) return
      if (getActiveRegion() !== 'sidebar') return
      e.preventDefault()
      e.stopImmediatePropagation()   // 阻断后续所有 keydown 处理器（含 useShortcuts）
      setSearchQuery(q => q === null ? '' : null)
      setTimeout(() => {
        const el = panelRef.current?.querySelector<HTMLInputElement>('.asset-panel__search-input')
        el?.focus(); el?.select()
      }, 30)
    }
    document.addEventListener('keydown', onKey, true)   // capture：先于业务 handler
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // 全局快捷键：一键展开/收起所有库树
  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const sc = (id: string) => displayShortcutStr(userShortcuts[id] ?? '')
  useShortcuts('global', { dbCollapseAll: () => toggleAllDbTrees() })

  const [panelMenu, setPanelMenu]   = useState<{ x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu]   = useState<{ x: number; y: number; groupId: string } | null>(null)
  const [addingGroup, setAddingGroup]   = useState(false)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [notice, setNotice]         = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  const flash = (msg: string, ms = 2000) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), ms)
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await loadConnections()
    setRefreshing(false)
    flash('已刷新')
  }

  const handleExport = () => setShowExport(true)

  const handleImport = async (file: File) => {
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const conns: ConnConfig[] = Array.isArray(json) ? json : (json.connections ?? [])
      if (!Array.isArray(conns) || conns.length === 0) { flash('格式错误或无有效连接'); return }
      let count = 0
      for (const c of conns) {
        if (!c.type || !c.name) continue
        try {
          await saveConnection({ ...c, id: '', createdAt: 0, updatedAt: 0 })
          count++
        } catch { /* skip invalid */ }
      }
      await loadConnections()
      flash(`已导入 ${count} 个连接`)
    } catch {
      flash('读取失败，请确认文件格式')
    }
  }

  const isTerminal = (c: { type: string }) => c.type === 'ssh' || c.type === 'local'

  const filtered = connections.filter((c) => {
    if (activeView === 'ssh' && !isTerminal(c)) return false
    if (activeView === 'db' && isTerminal(c)) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const nameMatch = c.name.toLowerCase().includes(q) || (c.host ?? '').toLowerCase().includes(q)
      // 已连接的数据库一律保留：其库/表/视图/函数/存储过程是否命中，交由库树就地过滤
      if (!isTerminal(c) && connectedDbConns.has(c.id)) return true
      return nameMatch
    }
    return true
  })

  // 搜索框失焦且为空时关闭
  function handleSearchBlur() {
    if (!searchQuery) setSearchQuery(null)
  }

  const activeConnId = tabs.find(t => t.id === activeTabId)?.connectionId

  // 顶部工具按钮按"当前点击的会话类型"切换：选中数据库连接才显示跨库工具
  const groupedConnIds = new Set(
    Object.entries(connGroupMap)
      .filter(([, gid]) => gid && groups.some(g => g.id === gid))
      .map(([cid]) => cid)
  )

  const ungroupedRaw = filtered.filter(c => !groupedConnIds.has(c.id))
  const localConns = orderBy(ungroupedRaw.filter(c => c.type === 'local'), connOrder['__local'] ?? [])
  const sshConns   = orderBy(ungroupedRaw.filter(c => c.type === 'ssh'), connOrder['__ssh'] ?? [])
  const dbConns    = orderBy(ungroupedRaw.filter(c => !isTerminal(c)), connOrder['__db'] ?? [])
  // 非 all 视图：未分组连接按类型分桶顺序拼接（本地→SSH→数据库），各桶内套用自定义顺序
  const ungrouped  = [...localConns, ...sshConns, ...dbConns]
  // 分组按自定义顺序渲染
  const orderedGroups = orderBy(groups, groupOrder)

  const PANEL_MENU: MenuItem[] = [
    { label: '新建连接', icon: <Plus size={13} />, submenu: NEW_CONN_SUBMENU },
    { label: '新增分组', icon: <FolderPlus size={13} />, onClick: () => setAddingGroup(true) },
    { label: undefined },
    { label: '全部展开', icon: <ChevronsUpDown size={13} />, onClick: expandAll,  disabled: groups.length === 0 },
    { label: '全部折叠', icon: <ChevronsDownUp size={13} />, onClick: collapseAll, disabled: groups.length === 0 },
    { label: undefined },
    { label: '导入连接配置', icon: <FileInput  size={13} />, onClick: () => importRef.current?.click() },
    { label: '导出连接配置', icon: <FileOutput size={13} />, onClick: handleExport, disabled: connections.length === 0 },
    { label: '管理已信任主机', icon: <ShieldCheck size={13} />, onClick: () => setKnownHostsOpen(true) },
    { label: undefined },
    {
      label: refreshing ? '刷新中…' : '刷新列表',
      icon: <RefreshCw size={13} className={refreshing ? 'spin' : ''} />,
      onClick: handleRefresh,
    },
    { label: undefined },
    { label: '偏好设置', icon: <Settings size={13} />, onClick: openSettings },
  ]

  function buildGroupMenu(groupId: string): MenuItem[] {
    const group = groups.find(g => g.id === groupId)
    if (!group) return []
    const groupConns = filtered.filter(c => connGroupMap[c.id] === group.id)
    const isTerminal = (c: { type: string }) => c.type === 'ssh' || c.type === 'local'

    const openAll = () => {
      groupConns.forEach(c => {
        const tabType = isTerminal(c) ? 'terminal' : 'query'
        const tabId = wid(`${c.id}-${tabType}`)
        const existing = tabs.find(t => t.id === tabId)
        if (existing) setActiveTab(tabId)
        else openTab({ id: tabId, connectionId: c.id, title: c.name, type: tabType })
      })
    }

    const closeAll = () => {
      groupConns.forEach(c => {
        const tabType = isTerminal(c) ? 'terminal' : 'query'
        const tabId = wid(`${c.id}-${tabType}`)
        if (tabs.some(t => t.id === tabId)) closeTab(tabId)
      })
    }

    const ungroupAll = () => groupConns.forEach(c => moveToGroup(c.id, ''))

    return [
      { label: '全部打开', icon: <LogIn size={13} />, disabled: groupConns.length === 0, onClick: openAll },
      { label: '全部关闭', icon: <LogOut size={13} />, disabled: !groupConns.some(c => tabs.some(t => t.connectionId === c.id)), onClick: closeAll },
      { label: undefined },
      { label: '重命名分组', icon: <Pencil size={13} />, onClick: () => setRenamingGroup(groupId) },
      { label: '解散分组', icon: <FolderMinus size={13} />, onClick: ungroupAll },
      { label: undefined },
      { label: '新建连接到此分组', icon: <Plus size={13} />, submenu: makeNewConnSubmenu(groupId) },
      { label: undefined },
      { label: '删除分组', icon: <Trash2 size={13} />, danger: true, onClick: () => deleteGroup(groupId) },
    ]
  }

  async function toggleDbConn(connId: string) {
    if (connectedDbConns.has(connId)) {
      // 已连接：仅收缩/展开树，连接状态不变
      setExpandedDbConns(s => {
        const n = new Set(s)
        if (n.has(connId)) n.delete(connId)
        else n.add(connId)
        return n
      })
      return
    }
    // 正在连接中：防止重复点击
    if (connecting.has(connId)) return

    // 未连接：测试连通性
    const conn = connections.find(c => c.id === connId)
    setConnecting(s => new Set([...s, connId]))
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('list_schemas', { id: connId })
      markDbConnected(connId)
      setExpandedDbConns(s => new Set([...s, connId]))
    } catch (e) {
      markDbError(connId)
      setConnError({ connId, connName: conn?.name ?? connId, msg: String(e) })
    } finally {
      setConnecting(s => { const n = new Set(s); n.delete(connId); return n })
    }
  }

  // 一键展开/收起整棵连接树：分组 + 已连接数据库的库树。
  // 有任意分组展开 或 任意库树展开 → 全部收起；否则全部展开。
  const anyTreeExpanded =
    expandedDbConns.size > 0 || groups.some(g => !collapsedGroups.includes(g.id))
  function toggleAllDbTrees() {
    if (anyTreeExpanded) {
      collapseAll()          // 收起所有分组
      collapseAllTrees()     // 通知各库树收起内部 schema/类别
      setExpandedDbConns(new Set())
    } else {
      expandAll()            // 展开所有分组
      setExpandedDbConns(new Set(connectedDbConns))
    }
  }

  function doDisconnectDb(connId: string, tabIds: string[]) {
    // force=true：固定的对象标签若属于该连接（正展示它）也一并关闭
    tabIds.forEach(id => closeTab(id, true))
    markDbDisconnected(connId)
    setExpandedDbConns(s => { const n = new Set(s); n.delete(connId); return n })
  }

  function disconnectDb(connId: string) {
    const conn = connections.find(c => c.id === connId)
    const connTabs = tabs.filter(t => t.connectionId === connId)
    const allTabIds = connTabs.map(t => t.id)

    if (connTabs.length === 0) { doDisconnectDb(connId, []); return }

    // Build sequential queue: only dirty query tabs. Preview tabs close silently.
    const { sqls } = useQueryStore.getState()

    const queue: DisconnectQueueItem[] = []
    for (const tab of connTabs) {
      if (tab.type !== 'query') continue  // preview tabs: no prompt
      const sql = sqls[tab.id]
      if (tab.dirty && sql?.trim() && sql !== DEFAULT_SQL) {
        queue.push({
          tabId: tab.id,
          tabLabel: tab.title,
          sqlItems: [{
            key: tab.id,
            label: tab.title,
            sql,
            connId,
            savedQueryId: tab.meta?.savedQueryId,
            savedQueryName: tab.meta?.savedQueryName,
          }],
        })
      }
    }

    if (queue.length === 0) {
      // No edit tabs with content — close all silently
      doDisconnectDb(connId, allTabIds)
      return
    }

    setDisconnectFlow({ connId, connName: conn?.name ?? connId, allTabIds, queue, step: 0 })
  }

  function advanceDisconnectStep(save: boolean) {
    if (!disconnectFlow) return
    const { connId, allTabIds, queue, step } = disconnectFlow

    if (save) {
      const item = queue[step]
      try {
        const now = Date.now()
        item.sqlItems.forEach((s, i) => {
          const name = s.savedQueryName || s.label || `${item.tabLabel} · 查询${i + 1}`
          if (s.savedQueryId) {
            updateSavedQuery(s.savedQueryId, s.sql.trim())
            renameSavedQuery(s.savedQueryId, name)
          } else {
            addSavedQuery({ name, sql: s.sql.trim(), connId: s.connId }, now + i)
          }
        })
      } catch { /* quota */ }
    }

    const nextStep = step + 1
    if (nextStep >= queue.length) {
      // All items handled — do the actual close
      doDisconnectDb(connId, allTabIds)
      setDisconnectFlow(null)
    } else {
      setDisconnectFlow(f => f ? { ...f, step: nextStep } : null)
    }
  }

  function handleOpenTable(connId: string, connType: ConnType, schema: string, table: string) {
    const conn = connections.find(c => c.id === connId)
    if (!conn) return
    // 打开表数据：独立的数据网格标签页（每张表一个 tab）
    const tabId = wid(`${connId}-tabledata-${schema}-${table}`)
    const existing = tabs.find(t => t.id === tabId)
    if (existing) { setActiveTab(tabId); return }
    openTab({
      id: tabId, connectionId: connId,
      title: table, type: 'table-data',
      meta: { schema, table, connType },
    })
  }


  function renderConnWithTree(c: ConnConfig) {
    const isDb   = !isTerminal(c)
    const searching = isDb && !!searchQuery
    // 搜索时强制展开已连接库树，让命中的库/表/视图/函数/存储过程可见
    const isExp  = isDb && (expandedDbConns.has(c.id) || searching)
    const connDrop = dropTarget?.kind === 'conn' && dropTarget.id === c.id
    return (
      <div key={c.id}>
        <div
          ref={el => { if (el) connEls.current.set(c.id, el as HTMLDivElement); else connEls.current.delete(c.id) }}
          style={connDrop ? { boxShadow: dropTarget!.before ? 'inset 0 2px 0 0 var(--accent)' : 'inset 0 -2px 0 0 var(--accent)' } : undefined}
        >
          <ConnectionItem
            conn={c}
            isActive={isDb ? false : c.id === activeConnId}
            onDragStart={onConnDragStart}
            treeExpanded={isDb ? isExp : undefined}
            isConnected={isDb ? connectedDbConns.has(c.id) : undefined}
            isConnecting={isDb ? connecting.has(c.id) : undefined}
            hasConnError={isDb ? dbErrorConns.has(c.id) : undefined}
            onToggleTree={isDb ? () => toggleDbConn(c.id) : undefined}
            onDisconnect={isDb ? () => disconnectDb(c.id) : undefined}
          />
        </div>
        {connectedDbConns.has(c.id) && (
          <div style={isExp ? undefined : { display: 'none' }}>
            <Suspense fallback={<div className="tree-loading">加载对象树...</div>}>
              <DbSchemaTree
                connectionId={c.id}
                connType={c.type as ConnType}
                defaultSchema={c.database}
                objectFilter={searching ? (searchQuery ?? '') : ''}
                onMigrate={setMigratePreset}
                onOpenTable={(schema, table) => handleOpenTable(c.id, c.type as ConnType, schema, table)}
              />
            </Suspense>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={`asset-panel${open ? '' : ' asset-panel--collapsed'}`}
      style={open && width ? { width } : undefined}
    >
      {/* 隐藏文件 input，用于导入 */}
      <input
        ref={importRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = '' }}
      />

      <div className="asset-panel__header">
        {searchQuery !== null ? (
          <div className="asset-panel__search-bar">
            <Search size={11} className="asset-panel__search-icon" />
            <input
              className="asset-panel__search-input"
              placeholder={activeView === 'db' ? '搜索连接 / 库 / 表 / 视图 / 函数 / 存储过程…' : '搜索连接…'}
              autoFocus
              value={searchQuery ?? ''}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearchQuery(null) }}
              onBlur={handleSearchBlur}
            />
            <button className="asset-panel__search-clear"
              onMouseDown={e => e.preventDefault()}
              onClick={() => setSearchQuery(null)}>
              <X size={11} />
            </button>
          </div>
        ) : (
          <>
            <span className="asset-panel__title">{TITLES[activeView]}</span>
            <div className="asset-panel__header-btns">
              <button className="asset-panel__icon-btn" data-tip="搜索连接" data-shortcut={displayShortcutStr('Mod+F')}
                onClick={() => setSearchQuery('')}>
                <Search size={13} strokeWidth={2} />
              </button>
              <button className="asset-panel__icon-btn" data-tip="导入连接配置"
                onClick={() => importRef.current?.click()}>
                <FileInput size={13} strokeWidth={2} />
              </button>
              <button className="asset-panel__icon-btn" data-tip="导出连接配置"
                disabled={connections.length === 0} onClick={handleExport}>
                <FileOutput size={13} strokeWidth={2} />
              </button>
              <button className="asset-panel__add" data-tip="新建连接"
                onClick={() => openNewConn(activeView === 'ssh' ? 'ssh' : activeView === 'db' ? 'db' : 'all')}>
                <Plus size={15} strokeWidth={2} />
              </button>
              <button className="asset-panel__icon-btn"
                data-tip={anyTreeExpanded ? '收起所有库树' : '展开所有库树'}
                data-shortcut={sc('dbCollapseAll')}
                onClick={toggleAllDbTrees}>
                {anyTreeExpanded
                  ? <ChevronsDownUp size={14} strokeWidth={2} />
                  : <ChevronsUpDown size={14} strokeWidth={2} />}
              </button>
            </div>
          </>
        )}
      </div>

      {open && (
        <div
          className="asset-panel__list"
          onContextMenu={e => { e.preventDefault(); setPanelMenu({ x: e.clientX, y: e.clientY }) }}
        >
          {/* 操作通知 */}
          {notice && (
            <div className="panel-notice panel-notice--top">{notice}</div>
          )}

          {filtered.length === 0 && !addingGroup && !notice && (
            <div className="asset-panel__empty">
              <span>暂无连接</span>
              <button className="empty-add-btn"
                onClick={() => openNewConn(activeView === 'ssh' ? 'ssh' : activeView === 'db' ? 'db' : 'all')}>
                + 新建连接
              </button>
            </div>
          )}

          {/* 分组 sections */}
          {orderedGroups.map(group => {
            const groupConns = orderBy(filtered.filter(c => connGroupMap[c.id] === group.id), connOrder[group.id] ?? [])
            const collapsed  = collapsedGroups.includes(group.id)
            const isRenaming = renamingGroup === group.id

            // 该分组在全部连接里实际拥有的连接数（不受当前视图/搜索过滤）
            const totalConns = connections.filter(c => connGroupMap[c.id] === group.id).length
            // 隐藏规则：该分组有连接、但当前视图/搜索下一个都不匹配 → 不显示
            // （如 SSH 视图里的纯数据库分组）。空分组（totalConns===0）始终显示，
            // 否则新建的空分组会立刻消失、也无法拖入连接。
            if (groupConns.length === 0 && totalConns > 0 && !isRenaming) return null

            const groupDrop = dropTarget?.kind === 'group' && dropTarget.id === group.id
            return (
              <div
                key={group.id}
                ref={el => { if (el) groupEls.current.set(group.id, el as HTMLDivElement); else groupEls.current.delete(group.id) }}
                className={`conn-group${dragOverGroup === group.id ? ' drag-over' : ''}`}
                style={groupDrop ? { boxShadow: dropTarget!.before ? 'inset 0 2px 0 0 var(--accent)' : 'inset 0 -2px 0 0 var(--accent)' } : undefined}
              >
                <div
                  className="conn-group__header"
                  onMouseDown={e => { if (!isRenaming) onGroupHeaderMouseDown(group.id, group.name, e) }}
                  onClick={() => { if (groupClickSuppress.current) { groupClickSuppress.current = false; return } if (!isRenaming) toggleCollapsed(group.id) }}
                  onContextMenu={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    setGroupMenu({ x: e.clientX, y: e.clientY, groupId: group.id })
                  }}
                >
                  <span className="conn-group__chevron-box">
                    <ChevronRight size={12} className={`conn-group__chevron${collapsed ? '' : ' expanded'}`} />
                  </span>
                  <Folder size={15} strokeWidth={1.9} className="conn-group__icon" />
                  {isRenaming ? (
                    <GroupRenameInput
                      initialName={group.name}
                      onConfirm={name => { renameGroup(group.id, name); setRenamingGroup(null) }}
                      onCancel={() => setRenamingGroup(null)}
                    />
                  ) : (
                    <>
                      <span className="conn-group__name">{group.name}</span>
                      <span className="conn-group__count">{groupConns.length}</span>
                    </>
                  )}
                </div>
                {!collapsed && (
                  <div className="conn-group__items">
                    {groupConns.map(c => renderConnWithTree(c))}
                    {groupConns.length === 0 && (
                      <div className="conn-group__empty">暂无连接</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* 行内新增分组 input */}
          {addingGroup && (
            <div className="conn-group">
              <div className="conn-group__header">
                <ChevronRight size={12} className="conn-group__chevron expanded" />
                <Folder size={15} strokeWidth={1.9} className="conn-group__icon" />
                <GroupRenameInput
                  initialName=""
                  onConfirm={name => { addGroup(name); setAddingGroup(false) }}
                  onCancel={() => setAddingGroup(false)}
                />
              </div>
            </div>
          )}

          {/* 未分组连接（按类型分 section） */}
          {activeView === 'all' ? (
            <>
              {localConns.length > 0 && (
                <>
                  <div className="section-label">本地终端</div>
                  {localConns.map(c => renderConnWithTree(c))}
                </>
              )}
              {sshConns.length > 0 && (
                <>
                  <div className="section-label">SSH 会话</div>
                  {sshConns.map(c => renderConnWithTree(c))}
                </>
              )}
              {dbConns.length > 0 && (
                <>
                  <div className="section-label">数据库</div>
                  {dbConns.map(c => renderConnWithTree(c))}
                </>
              )}
            </>
          ) : (
            ungrouped.map(c => renderConnWithTree(c))
          )}
        </div>
      )}

      {panelMenu && (
        <ContextMenu
          x={panelMenu.x} y={panelMenu.y}
          items={PANEL_MENU}
          onClose={() => setPanelMenu(null)}
        />
      )}

      {groupMenu && (
        <ContextMenu
          x={groupMenu.x} y={groupMenu.y}
          items={buildGroupMenu(groupMenu.groupId)}
          onClose={() => setGroupMenu(null)}
        />
      )}

      {showExport && (
        <Suspense fallback={<LazyAssetModalFallback />}>
          <ExportDialog
            connections={connections}
            onClose={() => setShowExport(false)}
          />
        </Suspense>
      )}

      {knownHostsOpen && (
        <Suspense fallback={<LazyAssetModalFallback />}>
          <KnownHostsManager onClose={() => setKnownHostsOpen(false)} />
        </Suspense>
      )}

      {migratePreset && (
        <Suspense fallback={<LazyAssetModalFallback />}>
          <MigrationWizard
            connections={connections}
            defaultSrcId={migratePreset.srcId}
            defaultSrcSchema={migratePreset.srcSchema}
            defaultTable={migratePreset.srcTable}
            defaultTables={migratePreset.srcTables}
            defaultDstId={migratePreset.dstId}
            defaultDstSchema={migratePreset.dstSchema}
            onClose={() => setMigratePreset(null)}
          />
        </Suspense>
      )}

      {/* 拖拽幽灵提示（portal 到 body） */}
      {dragGhost && createPortal(
        <div
          className="conn-drag-ghost"
          style={{ left: dragGhost.x + 12, top: dragGhost.y - 14 }}
        >
          <span className="conn-drag-ghost__label">{dragGhost.label}</span>
        </div>,
        document.body
      )}

      {/* DB 连接失败弹窗 */}
      {connError && createPortal(
        <div className="modal-overlay">
          <div className="modal-box" style={{ width: 420 }}>
            <div className="modal-header">
              <span className="modal-title" style={{ color: '#dc2626' }}>连接失败</span>
              <button className="modal-close" onClick={() => setConnError(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ gap: 14 }}>
              <p style={{ fontSize: 13, color: '#dc2626', margin: 0 }}>
                无法连接到「<strong>{connError.connName}</strong>」
              </p>
              <div style={{
                fontSize: 13, color: '#dc2626',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 8, padding: '10px 12px',
                maxHeight: 140, overflowY: 'auto',
                lineHeight: 1.6, wordBreak: 'break-all',
              }}>
                {connError.msg}
              </div>
            </div>
            <div className="modal-footer">
              <span />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn-cancel" onClick={() => setConnError(null)}>关闭</button>
                <button className="btn-cancel" onClick={() => {
                  setConnError(null)
                  const conn = connections.find(c => c.id === connError.connId)
                  if (conn) useAppStore.getState().openEditConn(conn)
                }}>编辑连接</button>
                <button className="btn-primary" onClick={async () => {
                  const id = connError.connId
                  const name = connError.connName
                  setConnError(null)
                  setConnecting(s => new Set([...s, id]))
                  try {
                    const { invoke } = await import('@tauri-apps/api/core')
                    await invoke('list_schemas', { id })
                    markDbConnected(id)
                    setExpandedDbConns(s => new Set([...s, id]))
                  } catch (e) {
                    markDbError(id)
                    setConnError({ connId: id, connName: name, msg: String(e) })
                  } finally {
                    setConnecting(s => { const n = new Set(s); n.delete(id); return n })
                  }
                }}>重试</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 关闭 DB 连接 — 逐步确认弹窗 */}
      {disconnectFlow && (() => {
        const { connName, queue, step } = disconnectFlow
        const item = queue[step]
        const total = queue.length
        return createPortal(
          <div className="modal-overlay">
            <div className="modal-box" style={{ width: 460, padding: '24px 24px 20px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 标题行 */}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div className="modal-title" style={{ margin: 0 }}>保存查询</div>
                {total > 1 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{step + 1} / {total}</span>
                )}
              </div>

              {/* 说明 */}
              <p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>
                关闭「{connName}」前，<strong>{item.tabLabel}</strong>&nbsp;中包含以下未保存的 SQL：
              </p>

              {/* SQL 列表 */}
              <div style={{ overflowY: 'auto', maxHeight: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {item.sqlItems.map((s, i) => (
                  <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                      <FileText size={10} style={{ marginRight: 5, verticalAlign: 'middle' }} />
                      {s.label}
                    </div>
                    <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 90, overflow: 'hidden' }}>
                      {s.sql.split('\n').slice(0, 5).join('\n')}{s.sql.split('\n').length > 5 ? '\n…' : ''}
                    </pre>
                  </div>
                ))}
              </div>

              {/* 按钮 */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0, paddingTop: 4 }}>
                <button className="btn-cancel" onClick={() => setDisconnectFlow(null)}>取消关闭</button>
                <button className="btn-cancel" style={{ color: 'var(--text)' }} onClick={() => advanceDisconnectStep(false)}>
                  不保存，继续
                </button>
                <button className="btn-primary" onClick={() => advanceDisconnectStep(true)}>
                  保存并继续
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      })()}
    </div>
  )
}
