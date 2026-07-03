import { lazy, Suspense, useState, useRef, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  SquareTerminal, Server, Database, Pencil, Copy, Trash2, RefreshCw,
  LogIn, LogOut, ClipboardCopy, Plus, FileInput, FileOutput,
  DatabaseZap, Link2, Link2Off, Star, StarOff, Info,
  Settings2, FolderInput, Folder, Check, X, ChevronRight, Palette,
  MoreHorizontal,
} from 'lucide-react'
import {
  SiMysql, SiPostgresql, SiSqlite, SiRedis, SiClickhouse, SiMariadb, SiMongodb,
} from 'react-icons/si'
import {
  IcoTiDB, IcoOceanBase, IcoKingBase, IcoOpenGauss, IcoOracle, IcoSqlServer, IcoDuckDB,
} from '../shared/DbIcons'
import SchemaFilterPopup from './SchemaFilterPopup'
import { toast } from '../../stores/toastStore'

const CONN_COLORS = [
  { label: '默认',   value: '' },
  { label: '红',     value: '#dc2626' },
  { label: '橙',     value: '#ea580c' },
  { label: '黄',     value: '#ca8a04' },
  { label: '绿',     value: '#16a34a' },
  { label: '青',     value: '#0891b2' },
  { label: '蓝',     value: '#2563eb' },
  { label: '紫',     value: '#7c3aed' },
  { label: '粉',     value: '#db2777' },
]
import type { ConnConfig, ConnType } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { useGroupStore } from '../../stores/groupStore'
import ContextMenu from '../ContextMenu'
import type { MenuItem } from '../ContextMenu'
import { notifySchemaChanged } from '../../utils/schemaRefresh'
import { wid } from '../../utils/windowTag'

const CreateDatabaseDialog = lazy(() => import('../DbTools/CreateDatabaseDialog'))
const InstanceExportPanel = lazy(() => import('../DbTools/InstanceExportPanel'))
const InstanceImportPanel = lazy(() => import('../DbTools/InstanceImportPanel'))

// 按「类别」设定初始默认色（未设自定义色时图标用它）：数据库=青绿、终端/Shell=紫罗兰。
// 走 CSS 变量随主题适配；用户为单个连接设的 conn.color 始终优先。
const KIND_DEFAULT_COLOR = {
  db:       'var(--conn-db)',
  terminal: 'var(--conn-terminal)',
}

function LazyDbPanelFallback() {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 320, padding: 24 }}>
        <div className="modal-title">加载中...</div>
      </div>
    </div>
  )
}

// 数据库按类型显示品牌图标（一眼区分是哪种库；国产/企业库用 house-style 自绘图标，缺省回退通用 Database）
function dbBrandIcon(type: string, size = 16): ReactNode {
  switch (type) {
    case 'mysql':      return <SiMysql size={size} />
    case 'mariadb':    return <SiMariadb size={size} />
    case 'postgres':   return <SiPostgresql size={size} />
    case 'sqlite':     return <SiSqlite size={size} />
    case 'redis':      return <SiRedis size={size} />
    case 'clickHouse': return <SiClickhouse size={size} />
    case 'mongodb':    return <SiMongodb size={size} />
    case 'tidb':       return <IcoTiDB size={size} />
    case 'oceanBase':  return <IcoOceanBase size={size} />
    case 'kingBase':   return <IcoKingBase size={size} />
    case 'openGauss':  return <IcoOpenGauss size={size} />
    case 'oracle':     return <IcoOracle size={size} />
    case 'sqlServer':  return <IcoSqlServer size={size} />
    case 'duckdb':     return <IcoDuckDB size={size} />
    default:           return <Database size={size} strokeWidth={1.8} />
  }
}

// ── 新建连接子菜单 ───────────────────────────────────────────
function ic(node: ReactNode, color: string) {
  return <span style={{ color, display: 'flex', alignItems: 'center' }}>{node}</span>
}

// groupId 传入时，新建的连接保存后归入该分组（「新建连接到此分组」）
export function makeNewConnSubmenu(groupId?: string): MenuItem[] {
  const open = (type: 'ssh' | 'db' | 'local', preset: ConnType) =>
    () => useAppStore.getState().openNewConn(type, preset, groupId)
  return [
    // 终端
    { label: '本地终端',   icon: ic(<SquareTerminal size={13}/>, '#22c55e'), onClick: open('local', 'local') },
    { label: 'SSH',        icon: ic(<Server size={13}/>, '#a78bfa'),       onClick: open('ssh', 'ssh') },
    { label: undefined },
    // 高频关系型
    { label: 'MySQL',      icon: ic(<SiMysql size={13}/>, '#4479A1'),      onClick: open('db', 'mysql') },
    { label: 'PostgreSQL', icon: ic(<SiPostgresql size={13}/>, '#336791'), onClick: open('db', 'postgres') },
    { label: 'SQLite',     icon: ic(<SiSqlite size={13}/>, '#0f80cc'),     onClick: open('db', 'sqlite') },
    { label: undefined },
    // MySQL 兼容
    { label: 'MariaDB',    icon: ic(<SiMariadb size={13}/>, '#c0765a'),    onClick: open('db', 'mariadb') },
    { label: 'TiDB',       icon: ic(<IcoTiDB size={13}/>, '#e4392b'),      onClick: open('db', 'tidb') },
    { label: 'OceanBase',  icon: ic(<IcoOceanBase size={13}/>, '#2dd4bf'), onClick: open('db', 'oceanBase') },
    { label: undefined },
    // 分析型 & 嵌入式
    { label: 'ClickHouse', icon: ic(<SiClickhouse size={13}/>, '#FACC15'), onClick: open('db', 'clickHouse') },
    { label: 'DuckDB',     icon: ic(<IcoDuckDB size={13}/>, '#FBBF24'),    onClick: open('db', 'duckdb') },
    { label: undefined },
    // 企业级
    { label: 'Oracle',     icon: ic(<IcoOracle size={13}/>, '#C74634'),    onClick: open('db', 'oracle') },
    { label: 'SQL Server', icon: ic(<IcoSqlServer size={13}/>, '#CC2927'), onClick: open('db', 'sqlServer') },
    { label: undefined },
    // 国产
    { label: '人大金仓',   icon: ic(<IcoKingBase size={13}/>, '#818cf8'),  onClick: open('db', 'kingBase') },
    { label: 'openGauss',  icon: ic(<IcoOpenGauss size={13}/>, '#38bdf8'), onClick: open('db', 'openGauss') },
    { label: undefined },
    // NoSQL / 文档型
    { label: 'Redis',      icon: ic(<SiRedis size={13}/>, '#DC382D'),      onClick: open('db', 'redis') },
    { label: 'MongoDB',    icon: ic(<SiMongodb size={13}/>, '#47A248'),    onClick: open('db', 'mongodb') },
  ]
}

export const NEW_CONN_SUBMENU: MenuItem[] = makeNewConnSubmenu()

export default function ConnectionItem({ conn, isActive, onDragStart: onDragStartProp, treeExpanded, isConnected, isConnecting, hasConnError, onToggleTree, onDisconnect, onSelect }: {
  conn: ConnConfig
  isActive: boolean
  onDragStart?: (connId: string, label: string, x: number, y: number) => void
  treeExpanded?: boolean
  isConnected?: boolean
  isConnecting?: boolean
  hasConnError?: boolean
  onToggleTree?: () => void
  onDisconnect?: () => void
  onSelect?: () => void
}) {
  const { openTab, setActiveTab, openQueryTab, openEditConn, duplicateConnection, deleteConnection, loadConnections, saveConnection, tabs, closeTab } = useAppStore()
  const { groups, connGroupMap, moveToGroup, addGroup } = useGroupStore()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [starred, setStarred] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null)
  const [filterSchemas, setFilterSchemas] = useState<string[]>([])
  const [filterLoading, setFilterLoading] = useState(false)
  // 连接级数据库操作面板：新建库 / 整实例导出 / 整实例导入
  const [dbPanel, setDbPanel] = useState<null | 'create' | 'export' | 'import'>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)

  const currentGroupId = connGroupMap[conn.id] ?? ''
  const isDragRef = useRef(false)  // 本次 mousedown 是否演变成了拖拽

  function closeFilterPopup() {
    setFilterOpen(false)
    setFilterAnchorEl(null)
  }

  async function openFilterPopup() {
    if (filterOpen) { closeFilterPopup(); return }
    const el = filterBtnRef.current
    if (!el) return
    setFilterAnchorEl(el)
    setFilterOpen(true)
    if (filterSchemas.length > 0) return  // already loaded
    setFilterLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<string[]>('list_schemas', { id: conn.id })
      setFilterSchemas(list)
    } catch { /* ignore */ }
    finally { setFilterLoading(false) }
  }

  const isSSH     = conn.type === 'ssh' || conn.type === 'local'

  // 图标用类别默认色（数据库=蓝 / 终端=珊瑚红）；用户为单个连接设的 conn.color 始终优先。
  const iconColor = conn.color || (isSSH ? KIND_DEFAULT_COLOR.terminal : KIND_DEFAULT_COLOR.db)
  const iconStyle: CSSProperties = { color: iconColor }
  // SSH：tab 存在 = 已连接；数据库：由父组件的 connectedDbConns 决定
  const isOpen    = isSSH
    ? tabs.some((t) => t.connectionId === conn.id)
    : (isConnected ?? false)
  // SSH 错误：tab 上有 error 标记；DB 错误：由父组件通过 hasConnError 传入
  const hasError  = isSSH
    ? tabs.some((t) => t.connectionId === conn.id && t.error)
    : (hasConnError ?? false)

  // ── SSH 专用：切换到已有终端标签，或新建 ─────────────────────────
  function handleOpen() {
    if (isSSH) {
      const existing = tabs.find(t => t.connectionId === conn.id && t.type === 'terminal')
      if (existing) setActiveTab(existing.id)
      else openTab({ id: wid(`${conn.id}-terminal`), connectionId: conn.id, title: conn.name, type: 'terminal' })
    } else {
      // DB：聚焦该连接已有的查询标签，没有才新建（查询标签可顶层多开）
      const existing = tabs.find(t => t.type === 'query' && t.connectionId === conn.id)
      if (existing) setActiveTab(existing.id)
      else openQueryTab(conn.id)
    }
  }

  function buildMenu(): MenuItem[] {
    // ── 复制 子菜单 ──────────────────────────────────────────
    const copySubmenu: MenuItem[] = [
      {
        label: '复制连接名',
        icon: <ClipboardCopy size={13} />,
        onClick: () => navigator.clipboard.writeText(conn.name).catch(() => {}),
      },
      {
        label: '复制主机地址',
        icon: <Link2 size={13} />,
        onClick: () => navigator.clipboard.writeText(conn.host ?? '').catch(() => {}),
        disabled: !conn.host,
      },
      {
        label: '复制连接字符串',
        icon: <Link2 size={13} />,
        onClick: () => {
          const str = isSSH
            ? `ssh://${conn.username ?? ''}@${conn.host ?? ''}:${conn.port ?? 22}`
            : `${conn.type}://${conn.username ?? ''}@${conn.host ?? ''}:${conn.port ?? ''}/${conn.database ?? ''}`
          navigator.clipboard.writeText(str).catch(() => {})
        },
        disabled: !conn.host,
      },
    ]

    // ── 移动到分组 子菜单 ────────────────────────────────────
    const groupSubmenu: MenuItem[] = [
      {
        label: '无分组',
        icon: !currentGroupId ? <Check size={13} /> : <X size={13} style={{ opacity: 0.3 }} />,
        onClick: () => moveToGroup(conn.id, ''),
      },
      { label: undefined },
      ...groups.map(g => ({
        label: g.name,
        icon: currentGroupId === g.id
          ? <Check size={13} />
          : <Folder size={13} style={{ opacity: 0.5 }} />,
        onClick: () => moveToGroup(conn.id, g.id),
      })),
      ...(groups.length > 0 ? [{ label: undefined } as MenuItem] : []),
      {
        label: '新建分组…',
        icon: <Plus size={13} />,
        onClick: () => {
          const name = prompt('新建分组名称：')
          if (name?.trim()) {
            const id = addGroup(name.trim())
            moveToGroup(conn.id, id)
          }
        },
      },
    ]

    const items: MenuItem[] = [
      // ── 连接控制 ──────────────────────────────
      {
        label: isOpen ? '关闭连接' : '打开连接',
        icon: isOpen ? <LogOut size={13} /> : <LogIn size={13} />,
        onClick: isSSH
          ? isOpen ? () => { setMenu(null); setCloseConfirm(true) } : handleOpen
          : isOpen ? () => onDisconnect?.() : () => onToggleTree?.(),
      },
      ...(isSSH ? [{
        label: '断开连接',
        icon: <Link2Off size={13} />,
        disabled: !isOpen,
        onClick: () => {
          const isTauri = '__TAURI_INTERNALS__' in window
          if (!isTauri) return
          import('@tauri-apps/api/core').then(({ invoke }) => {
            tabs.filter(t => t.connectionId === conn.id && t.type === 'terminal')
              .forEach(t => invoke('disconnect_ssh', { id: t.id }).catch(() => {}))
          })
        },
      } as MenuItem] : []),
      { label: '刷新', icon: <RefreshCw size={13} />, onClick: () => loadConnections() },
      { label: undefined },

      // ── 管理 ──────────────────────────────────
      // 编辑连接：连接处于打开状态时不允许编辑，需先关闭
      {
        label: '编辑连接',
        icon: <Settings2 size={13} />,
        onClick: () => {
          if (isOpen) { toast.warning('请先关闭连接再编辑'); return }
          openEditConn(conn)
        },
      },
      { label: '重命名',   icon: <Pencil size={13} />,    onClick: () => openEditConn(conn) },
      { label: '克隆',     icon: <Copy size={13} />,      onClick: () => duplicateConnection(conn.id) },
      {
        label: starred ? '取消收藏' : '收藏',
        icon: starred ? <StarOff size={13} /> : <Star size={13} />,
        onClick: () => setStarred(v => !v),
      },
      {
        label: '标记颜色',
        icon: <Palette size={13} />,
        submenu: CONN_COLORS.map(c => ({
          label: c.label,
          icon: c.value
            ? <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: c.value }} />
            : (conn.color ? <X size={10} /> : <Check size={10} style={{ opacity: 0.4 }} />),
          onClick: () => saveConnection({ ...conn, color: c.value || undefined }),
        })),
      },
      { label: undefined },

      // ── 信息 / 组织 ───────────────────────────
      { label: '复制',       icon: <ClipboardCopy size={13} />, submenu: copySubmenu },
      { label: '移动到分组', icon: <FolderInput size={13} />,   submenu: groupSubmenu },
      { label: undefined },

      // ── 数据库专有操作（DB only）──────────────
      ...(!isSSH ? [
        // 「数据库」子菜单按 connType 门控；逐项过滤后若整组为空则不显示该入口
        ...((): MenuItem[] => {
          const dbSub: MenuItem[] = []
          // 新建数据库：后端 db_create_database 仅支持 MySQL 族 / PG 族 → 仅这两族显示
          if (['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(conn.type)) {
            dbSub.push({ label: '新建数据库', icon: <DatabaseZap size={13} />, onClick: () => setDbPanel('create') })
          }
          // 导入数据库：后端 db_import_csv / db_exec_sql_file 仅 MySQL 族 / PG 族 / SQLite / DuckDB
          const canImport = ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'].includes(conn.type)
          // 导出数据库（逻辑备份）：后端 db_logical_backup 仅 MySQL 族 / PG 族
          const canExport = ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(conn.type)
          if (canImport || canExport) {
            if (dbSub.length > 0) dbSub.push({ label: undefined })
            if (canImport) dbSub.push({ label: '导入数据库', icon: <FileInput  size={13} />, onClick: () => setDbPanel('import') })
            if (canExport) dbSub.push({ label: '导出数据库', icon: <FileOutput size={13} />, onClick: () => setDbPanel('export') })
          }
          return dbSub.length > 0
            ? [{ label: '数据库', icon: <DatabaseZap size={13} />, submenu: dbSub }]
            : []
        })(),
        {
          label: '配置',
          icon: <Info size={13} />,
          submenu: [
            { label: '导入连接配置', icon: <FileInput  size={13} />, disabled: true },
            { label: '导出连接配置', icon: <FileOutput size={13} />, disabled: true },
          ],
        } as MenuItem,
        { label: undefined } as MenuItem,
      ] : []),

      // ── 新建 / 删除 ───────────────────────────
      { label: '新建连接', icon: <Plus size={13} />, submenu: NEW_CONN_SUBMENU },
      { label: undefined },
      {
        label: '删除连接',
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => deleteConnection(conn.id),
      },
    ]

    return items
  }

  // ── SSH 专用：确认关闭并批量断开 ────────────────────────────
  function doCloseAllSshTabs() {
    const connTabs = tabs.filter(t => t.connectionId === conn.id)
    const isTauri = '__TAURI_INTERNALS__' in window
    if (isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        connTabs.filter(t => t.type === 'terminal')
          .forEach(t => invoke('disconnect_ssh', { id: t.id }).catch(() => {}))
      })
    }
    connTabs.forEach(t => closeTab(t.id))
    setCloseConfirm(false)
  }

  return (
    <>
      <div
        className={`conn-item${isActive ? ' active' : ''}`}
        data-kind={isSSH ? 'terminal' : 'db'}
        onMouseDown={e => {
          if (e.button !== 0 || !onDragStartProp) return
          e.preventDefault()  // 阻止文字选中
          const sx = e.clientX, sy = e.clientY
          isDragRef.current = false

          const onMove = (me: MouseEvent) => {
            if (isDragRef.current) return
            if ((me.clientX - sx) ** 2 + (me.clientY - sy) ** 2 > 25) {
              isDragRef.current = true
              onDragStartProp(conn.id, conn.name, me.clientX, me.clientY)
              cleanup()
            }
          }
          const onUp = () => cleanup()
          const cleanup = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
          }
          document.addEventListener('mousemove', onMove)
          document.addEventListener('mouseup', onUp)
        }}
        onClick={() => {
          if (isDragRef.current) { isDragRef.current = false; return }
          if (filterOpen) return  // schema filter 开着时忽略，防止事件穿透关闭 popup
          onSelect?.()            // 记录当前点击的会话（供顶部按钮按类型切换）
          // ── DB 专用：已连接时单击名称 = 收缩/展开树 ──────────────
          if (!isSSH && isOpen) onToggleTree?.()
          // SSH：单击名称不触发任何操作（逻辑已完成，不改动）
        }}
        onDoubleClick={() => {
          // ── SSH/本地终端专用逻辑（与数据库完全隔离）─────────────
          if (isSSH) {
            // 每次双击都新建一个独立终端标签页（支持多开）
            const newTabId = wid(`${conn.id}-terminal-${Date.now()}`)
            openTab({ id: newTabId, connectionId: conn.id, title: conn.name, type: 'terminal' })
            return
          }
          // ── DB 专用逻辑 ──────────────────────────────────────────
          // 未连接时双击 = 打开连接（等同点击箭头）
          if (!isOpen) onToggleTree?.()
          // 已连接时：两次 onClick 已触发两次 toggle（互消），此处无需操作
        }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {!isSSH ? (
          <button
            className="conn-item__expand"
            onClick={e => { e.stopPropagation(); onToggleTree?.() }}
            onDoubleClick={e => e.stopPropagation()}
          >
            <ChevronRight size={12} strokeWidth={2.5} style={{ transform: treeExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }} />
          </button>
        ) : (
          /* 终端不可展开，但占位与展开箭头同宽，保证图标/名称与数据库行对齐 */
          <span className="conn-item__expand-spacer" aria-hidden />
        )}
        <div className="conn-item__icon" style={iconStyle}>
          {isSSH
            ? <SquareTerminal size={16} strokeWidth={1.8} />
            : dbBrandIcon(conn.type, 16)}
        </div>
        <div className="conn-item__body">
          <div className="conn-item__name">
            {starred && <Star size={10} style={{ display: 'inline', marginRight: 4, color: '#facc15' }} />}
            {conn.name}
          </div>
        </div>
        {!isSSH && isOpen && (
          <button
            ref={filterBtnRef}
            className="conn-item__filter-btn"
            style={{ pointerEvents: filterOpen ? 'none' : undefined }}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); openFilterPopup() }}
            onDoubleClick={e => e.stopPropagation()}
          >
            <MoreHorizontal size={12} />
          </button>
        )}
        <div className={`conn-item__status ${isConnecting ? 'status--connecting' : hasError ? 'status--error' : isOpen ? 'status--online' : 'status--idle'}`} />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          items={buildMenu()}
          onClose={() => setMenu(null)}
        />
      )}

      {closeConfirm && createPortal(
        <div className="modal-overlay">
          <div className="modal-box" style={{ width: 360, padding: '28px 28px 24px' }}>
            <div className="modal-title" style={{ marginBottom: 12 }}>关闭连接</div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 20 }}>
              将关闭「{conn.name}」的全部 {tabs.filter(t => t.connectionId === conn.id).length} 个标签页，确认继续？
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-cancel" onClick={() => setCloseConfirm(false)}>取消</button>
              <button className="btn-danger" onClick={doCloseAllSshTabs}>关闭全部</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {filterOpen && filterAnchorEl && createPortal(
        <SchemaFilterPopup
          connId={conn.id}
          anchorEl={filterAnchorEl}
          schemas={filterSchemas}
          loading={filterLoading}
          onClose={closeFilterPopup}
        />,
        document.body
      )}

      {/* 连接级数据库操作面板 */}
      {dbPanel && (
        <Suspense fallback={<LazyDbPanelFallback />}>
          {dbPanel === 'create' && (
            <CreateDatabaseDialog
              connectionId={conn.id}
              connType={conn.type as any}
              onClose={() => setDbPanel(null)}
              onCreated={() => notifySchemaChanged(conn.id)}
            />
          )}
          {dbPanel === 'export' && (
            <InstanceExportPanel connectionId={conn.id} onClose={() => setDbPanel(null)} />
          )}
          {dbPanel === 'import' && (
            <InstanceImportPanel connectionId={conn.id} onClose={() => setDbPanel(null)} />
          )}
        </Suspense>
      )}
    </>
  )
}
