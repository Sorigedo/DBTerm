import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Table2, Eye, RefreshCw, List, LayoutGrid, Search, Database,
  Terminal, Plus, ChevronUp, ChevronDown, ChevronRight, Braces, Workflow, Download,
  Upload, HardDrive, ArrowRightLeft, GitCompare, Wrench,
  Code2, Copy, Files, Settings2, Info,
  Wand2, Gauge, ShieldCheck, Pencil, Eraser, Trash2, X, PanelBottomOpen, FileCode2, BookOpen, Scale,
  ClipboardPaste,
} from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'
import SqlCodeView from '../common/SqlCodeView'
import TableInfoModal from '../DbTools/TableInfoModal'
import type { ConnType } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { copyText } from '../../utils/clipboard'
import { wid } from '../../utils/windowTag'
import { useDbClipboard, type DbObjType } from '../../stores/dbClipboardStore'
import { copyDbObject, copyDbObjects, pasteDbObject, dedupeKeyEvent, type MigratePreset } from '../../utils/dbCopyPaste'
import { useShortcuts } from '../../utils/useShortcuts'
import { useWheelScroll } from '../../utils/wheelScroll'
import EnvWatermark from '../common/EnvWatermark'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcutStr, SHORTCUT_DEFS, isModEvent, modLabel } from '../../utils/shortcuts'
import ImportDialog from '../DbTools/ImportDialog'
import BackupPanel from '../DbTools/BackupPanel'
import MigrationWizard from '../DbTools/MigrationWizard'
import DataDictPanel from '../DbTools/DataDictPanel'
import DataDiffPanel from '../DbTools/DataDiffPanel'
import StructureDiffPanel from '../DbTools/StructureDiffPanel'
import { toast } from '../../stores/toastStore'
import { onSchemaChanged, notifySchemaChanged, onOpenDbTool } from '../../utils/schemaRefresh'
import CreateTableWizard from '../DbTools/CreateTableWizard'
import ViewWizard from '../DbTools/ViewWizard'
import RoutineWizard from '../DbTools/RoutineWizard'
import { openEditObject, prettyViewDdl, prettyRoutineDdl } from '../../utils/objectEditor'
import { tableRef, supportsShowStatements, supportsMyMaintenance, supportsOptimizeTable, checkTableSql, previewSelect, buildIndexSql, MIGRATABLE_DB_TYPES } from '../../utils/sqlDialect'
import { toolsFor } from '../DbTools/dbToolsCatalog'
import { useDbToolsStore } from '../../stores/dbToolsStore'
import { clampIntoViewport } from '../../utils/menuClamp'

interface TableMeta {
  name: string
  comment: string
  rowCount: number
  dataLength: number
  indexLength: number
  autoIncrement: number | null
  engine: string
  charset: string
  updatedAt: string | null
  createdAt: string | null
  tableType: string
}

interface RoutineItem { name: string; routineType: string }

type SortKey = keyof TableMeta
type SortDir = 'asc' | 'desc'

interface ColDef { key: SortKey; label: string; width: number; right?: boolean }

const TABLE_COLS: ColDef[] = [
  { key: 'name',          label: '名称',   width: 200 },
  { key: 'comment',       label: '注释',   width: 160 },
  { key: 'rowCount',      label: '估算行', width: 80, right: true },
  { key: 'dataLength',    label: '数据长度', width: 90, right: true },
  { key: 'indexLength',   label: '索引长度', width: 90, right: true },
  { key: 'autoIncrement', label: '自增',   width: 80, right: true },
  { key: 'engine',        label: '引擎',   width: 76 },
  { key: 'charset',       label: '编码',   width: 80 },
  { key: 'updatedAt',     label: '更新时间', width: 140 },
  { key: 'createdAt',     label: '创建时间', width: 140 },
]

const ROUTINE_COLS: ColDef[] = [
  { key: 'name',      label: '名称', width: 300 },
  { key: 'tableType', label: '类型', width: 120 },
]

const CAT_LABEL: Record<string, string> = {
  tables: '表', views: '视图', functions: '函数', procedures: '存储过程',
}

// 表维护操作：执行前确认（OPTIMIZE 会重建表/可能锁表，须强确认）
type MaintKind = 'OPTIMIZE' | 'ANALYZE' | 'CHECK'
const MAINT_LABEL: Record<MaintKind, string> = { OPTIMIZE: '优化表', ANALYZE: '分析表', CHECK: '检查表' }
const MAINT_DESC: Record<MaintKind, string> = {
  OPTIMIZE: '执行 OPTIMIZE TABLE：重建表与索引、回收碎片空间。大表可能耗时较长并锁表。',
  ANALYZE:  '执行 ANALYZE TABLE：重新统计索引分布，优化查询计划。',
  CHECK:    '执行 CHECK TABLE：检查表与索引的完整性（只读）。',
}

// 详情面板列头中文映射（SHOW FULL COLUMNS / SHOW INDEX 原生列名）
const DETAIL_COL_ZH: Record<string, string> = {
  // SHOW FULL COLUMNS
  Field: '字段', Type: '类型', Collation: '排序规则', Null: '可空',
  Key: '键', Default: '默认值', Extra: '附加', Comment: '注释',
  // SHOW INDEX
  Table: '表', Non_unique: '非唯一', Key_name: '索引名', Seq_in_index: '序号',
  Column_name: '列名', Cardinality: '基数', Sub_part: '前缀长度', Packed: '压缩',
  Index_type: '索引类型', Index_comment: '索引注释', Visible: '可见', Expression: '表达式',
}
const zhCol = (name: string) => DETAIL_COL_ZH[name] ?? name

// 导出格式（后端 db_export_table 支持 csv/txt/json/sql/markdown/excel/html/xml）
export type ExportFmt = 'csv' | 'txt' | 'excel' | 'json' | 'sql' | 'markdown' | 'html' | 'xml'
export const EXPORT_FORMATS: ExportFmt[] = ['csv', 'txt', 'excel', 'json', 'sql', 'markdown', 'html', 'xml']
export const EXPORT_LABEL: Record<ExportFmt, string> = {
  csv: 'CSV', txt: 'TXT（制表符）', excel: 'Excel', json: 'JSON', sql: 'SQL', markdown: 'Markdown', html: 'HTML', xml: 'XML',
}
// 紧凑网格用的短标签
export const EXPORT_SHORT: Record<ExportFmt, string> = {
  csv: 'CSV', txt: 'TXT', excel: 'Excel', json: 'JSON', sql: 'SQL', markdown: 'MD', html: 'HTML', xml: 'XML',
}
export const EXPORT_EXT: Record<ExportFmt, string> = {
  csv: 'csv', txt: 'txt', excel: 'xls', json: 'json', sql: 'sql', markdown: 'md', html: 'html', xml: 'xml',
}

function fmtBytes(n: number) {
  if (!n) return '0'
  if (n < 1024) return n + 'B'
  if (n < 1048576) return Math.round(n / 1024) + 'KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB'
  return (n / 1073741824).toFixed(2) + 'GB'
}

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  category: string
  active?: boolean   // 是否为当前激活标签：非激活时关闭区域快捷键，避免隐藏标签"吃掉"快捷键
}

export default function SchemaBrowser({ connectionId, connType, schema, category, active = true }: Props) {
  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const sc = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  const { openTab, openObjectTab, openQueryTab: openQueryTabAction, markDbConnected, setActiveTab, tabs, setPendingRun, setPendingFill, setPendingSchema, connections } = useAppStore(s => ({
    openTab: s.openTab, openObjectTab: s.openObjectTab, openQueryTab: s.openQueryTab, markDbConnected: s.markDbConnected,
    setActiveTab: s.setActiveTab, tabs: s.tabs,
    setPendingRun: s.setPendingRun, setPendingFill: s.setPendingFill, setPendingSchema: s.setPendingSchema, connections: s.connections,
  }))

  // 面包屑可切换：当前连接的 schema 列表
  const [bcSchemas, setBcSchemas] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: connectionId })
        if (alive) setBcSchemas(list)
      } catch { if (alive) setBcSchemas([]) }
    })()
    return () => { alive = false }
  }, [connectionId])
  // 切换面包屑 → 更新全局对象标签内容
  const switchObject = (connId: string, sch: string, cat: string) => {
    const cn = connections.find(c => c.id === connId)?.name ?? connId
    markDbConnected(connId)   // 面包屑切换连接 → 左侧亮起绿点（已连接）
    openObjectTab(connId, `${cn} · ${sch} · ${CAT_LABEL[cat] ?? cat}`, { schema: sch, category: cat })
  }

  const [items, setItems]           = useState<TableMeta[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [viewMode, setViewMode]     = useState<'list' | 'grid'>('grid')
  const [filter, setFilter]         = useState('')
  const [sortKey, setSortKey]       = useState<SortKey>('name')
  const [sortDir, setSortDir]       = useState<SortDir>('asc')
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  // 数据字典面板：tables 列表（单表/多选）；null=关闭
  const [dictTables, setDictTables] = useState<string[] | null>(null)
  const [lastSelected, setLastSelected] = useState<string | null>(null)

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tableName: string } | null>(null)
  const [ctxPos, setCtxPos]   = useState<{ top: number; left: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  // Dialog states
  const [truncateTarget, setTruncateTarget] = useState<string | null>(null)
  const [truncateInput, setTruncateInput]   = useState('')
  const [dropList, setDropList]             = useState<string[] | null>(null)
  const [dropInput, setDropInput]           = useState('')
  const [renameTarget, setRenameTarget]     = useState<string | null>(null)
  const [renameInput, setRenameInput]       = useState('')
  const [copyTarget, setCopyTarget]         = useState<string | null>(null)
  const [copyInput, setCopyInput]           = useState('')
  const [copyWithData, setCopyWithData]     = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)

  // 工具面板开关
  const [importOpen, setImportOpen]       = useState(false)
  const [importTarget, setImportTarget]   = useState<string>('')
  const [importCols, setImportCols]       = useState<string[]>([])
  const [backupOpen, setBackupOpen]       = useState(false)
  const [migrationOpen, setMigrationOpen] = useState(false)
  // 粘贴：内部剪贴板 + 跨库迁移向导预设
  const clipboard = useDbClipboard(s => s.clipboard)
  const [pastePreset, setPastePreset] = useState<MigratePreset | null>(null)
  const [dataDiffOpen, setDataDiffOpen]   = useState(false)
  const [structDiffOpen, setStructDiffOpen] = useState(false)
  // 修改表结构（建表设计器编辑模式）/ DDL 弹窗 / 级联子菜单
  const [editTable, setEditTable] = useState<string | null>(null)
  const [infoTarget, setInfoTarget] = useState<string | null>(null)
  const [showSizes, setShowSizes]   = useState(false)
  const [maintDlg, setMaintDlg] = useState<{ kind: 'OPTIMIZE' | 'ANALYZE' | 'CHECK'; table: string } | null>(null)
  const [maintBusy, setMaintBusy] = useState(false)
  const [maintErr, setMaintErr]   = useState('')
  const [sbSub, setSbSub] = useState<{ key: 'maint' | 'export'; top: number; left: number } | null>(null)
  const sbSubRef   = useRef<HTMLDivElement>(null)
  const sbSubTimer = useRef<number | null>(null)
  const [createOpen, setCreateOpen]       = useState(false)
  const [viewWizardOpen, setViewWizardOpen] = useState(false)
  const [routineWizardKind, setRoutineWizardKind] = useState<'function' | 'procedure' | null>(null)
  const [toolsDropOpen, setToolsDropOpen] = useState(false)
  const [toolsDropPos, setToolsDropPos]   = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [searchOpen, setSearchOpen]       = useState(false)

  const [dialogLoading, setDialogLoading]   = useState(false)
  const [dialogError, setDialogError]       = useState('')

  // 底部详情面板
  const [detailTable, setDetailTable]   = useState<string | null>(null)
  const [detailTab, setDetailTab]       = useState<'ddl' | 'cols' | 'idx'>('cols')
  const [detailDdl, setDetailDdl]       = useState('')
  const [detailColRows, setDetailColRows] = useState<(string | null)[][]>([])
  const [detailColNames, setDetailColNames] = useState<string[]>([])
  const [detailIdxRows, setDetailIdxRows] = useState<(string | null)[][]>([])
  const [detailIdxNames, setDetailIdxNames] = useState<string[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError]   = useState('')
  const [detailHeight, setDetailHeight] = useState(220)
  const detailDragRef = useRef<{ startY: number; startH: number } | null>(null)

  const isRoutine = category === 'functions' || category === 'procedures'
  const columns   = isRoutine ? ROUTINE_COLS : TABLE_COLS
  const envConn   = connections.find(c => c.id === connectionId)
  const rootRef   = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  // 网格视图为列优先布局（纯横向滚动）：滚轮驱动横向滚动条，统一规则（见 utils/wheelScroll）
  const gridRef   = useRef<HTMLDivElement>(null)
  useWheelScroll(gridRef, { horizontalOnly: true }, [viewMode, loading, error])

  useEffect(() => { load() }, [connectionId, schema, category])

  // 任意 DDL / 导入 / 粘贴 操作后主动刷新本对象列表（拿到最新库表）。
  // 用 ref 始终调用最新的 load/loadDetail，避免闭包过期导致「粘贴后预览不刷新」。
  const loadSeqRef = useRef(0)
  const loadRef = useRef<() => void>(() => {})
  const loadDetailRef = useRef<(t: string, tab?: 'ddl' | 'cols' | 'idx') => void>(() => {})
  const detailRef = useRef<{ table: string | null; tab: 'ddl' | 'cols' | 'idx' }>({ table: null, tab: 'cols' })
  loadRef.current = load
  loadDetailRef.current = loadDetail
  detailRef.current = { table: detailTable, tab: detailTab }
  useEffect(() => onSchemaChanged(d => {
    if (d.connectionId !== connectionId) return
    if (d.schema && d.schema !== schema) return
    loadRef.current()
    if (detailRef.current.table) loadDetailRef.current(detailRef.current.table, detailRef.current.tab)
  }), [connectionId, schema])

  // 库树右键「导出/备份 / 导入 / 迁移 / 结构对比」→ 在当前可见的对象列表打开对应面板
  // 仅可见（offsetParent 非空）的标签响应，避免同库多个标签页重复打开导致需多次关闭
  useEffect(() => onOpenDbTool(d => {
    if (d.connectionId !== connectionId || d.schema !== schema) return
    if (!rootRef.current?.offsetParent) return
    if (d.tool === 'backup')          setBackupOpen(true)
    else if (d.tool === 'migrate')    setMigrationOpen(true)
    else if (d.tool === 'structDiff') setStructDiffOpen(true)
    else if (d.tool === 'dataDiff')   setDataDiffOpen(true)
    else if (d.tool === 'import') {
      const name = [...selected][0] ?? sorted[0]?.name ?? ''
      setImportTarget(name); setImportCols([]); setImportOpen(true)
      if (name) {
        import('@tauri-apps/api/core').then(({ invoke }) =>
          invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table: name })
            .then(c => setImportCols(c.map(x => x.name))).catch(() => {}))
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [connectionId, schema])

  // KB3 库树快捷键
  useShortcuts('db-panel', {
    dbTreeSearch:   () => { if (!rootRef.current?.offsetParent) return; setSearchOpen(true); setTimeout(() => { filterRef.current?.focus(); filterRef.current?.select() }, 50) },
    dbTreeRefresh:  () => { if (!rootRef.current?.offsetParent) return; load() },
    dbObjDdl:       () => { if (!rootRef.current?.offsetParent) return; toggleDetail() },
    dbObjRename:    () => { if (!rootRef.current?.offsetParent || isRoutine) return; const name = [...selected][0]; if (name) { setRenameTarget(name); setRenameInput(name); setDialogError('') } },
    dbObjStructure: () => { if (!rootRef.current?.offsetParent) return; const name = [...selected][0]; if (name && !isRoutine) setEditTable(name) },
    dbObjNewTable:  () => { if (!rootRef.current?.offsetParent) return; newObjectForCat() },
    dbNewQuery:     () => { if (!rootRef.current?.offsetParent) return; openQueryTab() },
  }, active)

  // 导出下拉菜单：点击外部关闭
  useEffect(() => {
    if (!exportMenuOpen) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.export-menu__wrap')) setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [exportMenuOpen])

  // 工具下拉菜单：点击外部（含其它工具栏按钮）关闭
  useEffect(() => {
    if (!toolsDropOpen) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('.sb-ctx-menu') && !t.closest('[data-tools-trigger]')) setToolsDropOpen(false)
    }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [toolsDropOpen])

  // 右键菜单：点击菜单外关闭（含子菜单）
  useEffect(() => {
    if (!ctxMenu) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ctxRef.current?.contains(t) && !sbSubRef.current?.contains(t)) { setCtxMenu(null); setSbSub(null) }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ctxMenu])

  // 右键菜单按视口钳制位置，避免溢出截断
  useLayoutEffect(() => {
    if (!ctxMenu) { setCtxPos(null); return }
    const el = ctxRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    let left = ctxMenu.x, top = ctxMenu.y
    if (left + width  > window.innerWidth  - pad) left = Math.max(pad, ctxMenu.x - width)
    if (top  + height > window.innerHeight - pad) top  = Math.max(pad, window.innerHeight - height - pad)
    setCtxPos({ top, left })
  }, [ctxMenu])

  async function load() {
    // 序号守卫：并发/快速多次刷新时，只让「最新一次」load 的结果落地，
    // 避免较早（数据更旧）的请求后返回覆盖较新结果，导致「粘贴后列表对不上、永远差一个」。
    const seq = ++loadSeqRef.current
    setLoading(true); setError(''); setSelected(new Set())
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (isRoutine) {
        const data = await invoke<RoutineItem[]>('list_routines', { id: connectionId, schema })
        if (seq !== loadSeqRef.current) return
        const rt = category === 'functions' ? 'FUNCTION' : 'PROCEDURE'
        setItems(data.filter(r => r.routineType === rt).map(r => ({
          name: r.name, comment: '', rowCount: 0, dataLength: 0, indexLength: 0,
          autoIncrement: null, engine: '', charset: '',
          updatedAt: null, createdAt: null, tableType: r.routineType,
        })))
      } else {
        const data = await invoke<TableMeta[]>('list_tables_meta', { id: connectionId, schema })
        if (seq !== loadSeqRef.current) return
        // 「表」同时纳入 BASE TABLE 与 SYSTEM VIEW（information_schema 等系统库的表是 SYSTEM VIEW），
        // 与左侧树的计数口径一致；「视图」取 VIEW
        setItems(category === 'tables'
          ? data.filter(t => t.tableType === 'BASE TABLE' || t.tableType === 'SYSTEM VIEW')
          : data.filter(t => t.tableType === 'VIEW'))
      }
    } catch (e) {
      if (seq === loadSeqRef.current) setError(String(e))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }

  function openQueryTab(sql?: string) {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return
    // 每次都新建一个查询标签（SQL 连接支持多开；redis/mongo 内部仍按连接单例）
    const tabId = openQueryTabAction(connectionId)
    // 把当前 schema 带过去（仅切库展示，不执行 USE）
    if (schema) setPendingSchema(tabId, schema)
    if (sql) setPendingRun(tabId, sql)
  }

  // 打开查询页并填入 SQL（不自动执行，由用户确认后运行）——新建标签，避免覆盖已有查询
  function fillQuery(sql: string) {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return
    const tabId = openQueryTabAction(connectionId)
    setPendingFill(tabId, sql)
  }
  // 标识符引号 / 表引用：走共享方言层（按 connType 选 backtick/双引号/方括号），禁止本地写死反引号
  const tref = (name: string) => tableRef(connType, schema, name)

  function openTableData(name: string) {
    // 打开表数据：独立的数据网格标签页（每张表一个 tab）
    const tabId = wid(`${connectionId}-tabledata-${schema}-${name}`)
    const existing = tabs.find(t => t.id === tabId)
    if (existing) { setActiveTab(tabId); return }
    openTab({ id: tabId, connectionId, title: name, type: 'table-data', meta: { schema, table: name, connType } })
  }


  function handleContextMenu(e: React.MouseEvent, tableName: string) {
    e.preventDefault()
    e.stopPropagation()
    setSbSub(null)
    setCtxMenu({ x: e.clientX, y: e.clientY, tableName })
  }

  // 双击打开：表 → 数据；视图/函数/存过 → 编辑定义（视图 Mod+双击 → 数据；函数/存过无数据，恒为编辑）
  function openObject(name: string, e?: { metaKey: boolean; ctrlKey: boolean }) {
    if (isRoutine) {
      openEditObject({ connectionId, connType, schema, objType: category === 'functions' ? 'function' : 'procedure', name })
      return
    }
    if (category === 'views' && !(e && isModEvent(e))) {
      openEditObject({ connectionId, connType, schema, objType: 'view', name })
      return
    }
    openTableData(name)
  }

  function openDdl(tableName: string) {
    closeMenu()
    setSelected(new Set([tableName]))
    setLastSelected(tableName)
    loadDetail(tableName, 'ddl')
  }
  // 维护操作：直接执行并提示结果
  async function confirmMaint() {
    if (!maintDlg) return
    const { kind, table } = maintDlg
    setMaintBusy(true); setMaintErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const ref = tref(table)
      // TiDB 检查表须用 ADMIN CHECK TABLE
      const sql = kind === 'CHECK' ? `${checkTableSql(connType, ref)};` : `${kind} TABLE ${ref};`
      const res = await invoke<{ rows: (string | null)[][] }>('execute_query', {
        id: connectionId, sql,
      })
      const msg = res.rows.map(r => r[3]).filter(Boolean).join('；')
      setMaintDlg(null)
      toast.success(`${MAINT_LABEL[kind]}完成${msg ? `：${msg}` : ''}`)
    } catch (e) { setMaintErr(String(e)) }
    finally { setMaintBusy(false) }
  }
  // 级联子菜单 hover 控制（与左侧树一致）
  function openSub(key: 'maint' | 'export', e: React.MouseEvent, itemCount: number) {
    if (sbSubTimer.current) { clearTimeout(sbSubTimer.current); sbSubTimer.current = null }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const estH = itemCount * 32 + 8
    setSbSub({ key, top: Math.max(8, Math.min(r.top, window.innerHeight - estH - 8)), left: r.right - 4 })
  }
  function keepSub()  { if (sbSubTimer.current) { clearTimeout(sbSubTimer.current); sbSubTimer.current = null } }
  function closeSub() { sbSubTimer.current = window.setTimeout(() => setSbSub(null), 160) }
  function closeMenu() { setCtxMenu(null); setSbSub(null) }

  async function handleTruncateConfirm() {
    if (!truncateTarget || truncateInput !== truncateTarget) return
    setDialogLoading(true); setDialogError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_truncate_table', { id: connectionId, schema, table: truncateTarget })
      load()
      setTruncateTarget(null); setTruncateInput('')
    } catch (e) {
      setDialogError(String(e))
    } finally { setDialogLoading(false) }
  }

  // 删除目标：若右键项属于多选集合则批量删除全部选中，否则只删该项
  const dropTargetsFor = (name: string) => (selected.has(name) && selected.size > 1 ? [...selected] : [name])
  const dropMulti = (dropList?.length ?? 0) > 1
  const dropConfirmOk = !!dropList && (dropMulti ? dropInput.trim() === String(dropList.length) : dropInput === dropList[0])

  async function handleDropConfirm() {
    if (!dropList || !dropConfirmOk) return
    setDialogLoading(true); setDialogError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const fails: string[] = []
      for (const name of dropList) {
        try {
          if (category === 'views') {
            await invoke('execute_query', { id: connectionId, sql: `DROP VIEW ${tref(name)};` })
          } else if (category === 'functions') {
            await invoke('execute_query', { id: connectionId, sql: `DROP FUNCTION ${tref(name)};` })
          } else if (category === 'procedures') {
            await invoke('execute_query', { id: connectionId, sql: `DROP PROCEDURE ${tref(name)};` })
          } else {
            await invoke('db_drop_table', { id: connectionId, schema, table: name })
          }
        } catch (e) { fails.push(`${name}：${e}`) }
      }
      load()
      notifySchemaChanged(connectionId, schema)   // 同步刷新左侧库树计数/列表
      if (fails.length) {
        setDialogError(`以下${catLabel}删除失败：\n${fails.join('\n')}`)
      } else {
        toast.success(dropList.length > 1 ? `已删除 ${dropList.length} 个${catLabel}` : `已删除${catLabel} “${dropList[0]}”`)
        setDropList(null); setDropInput(''); setSelected(new Set())
      }
    } catch (e) {
      setDialogError(String(e))
    } finally { setDialogLoading(false) }
  }

  async function handleRenameConfirm() {
    if (!renameTarget || !renameInput.trim()) return
    setDialogLoading(true); setDialogError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_rename_table', { id: connectionId, schema, oldName: renameTarget, newName: renameInput.trim() })
      load()
      notifySchemaChanged(connectionId, schema)
      setRenameTarget(null); setRenameInput('')
    } catch (e) {
      setDialogError(String(e))
    } finally { setDialogLoading(false) }
  }

  async function handleCopyConfirm() {
    if (!copyTarget || !copyInput.trim()) return
    setDialogLoading(true); setDialogError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_copy_table', { id: connectionId, schema, table: copyTarget, newName: copyInput.trim(), withData: copyWithData })
      load()
      notifySchemaChanged(connectionId, schema)
      setCopyTarget(null); setCopyInput(''); setCopyWithData(false)
    } catch (e) {
      setDialogError(String(e))
    } finally { setDialogLoading(false) }
  }

  async function handleExport(fmt: ExportFmt, tableName?: string, structure?: 'only' | 'with') {
    const tbl = tableName ?? [...selected][0]
    if (!tbl) return
    setExportMenuOpen(false)
    const realFmt = structure ? 'sql' : fmt
    const ext = structure ? 'sql' : EXPORT_EXT[fmt]
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ defaultPath: `${tbl}.${ext}`, filters: [{ name: structure ? 'SQL' : EXPORT_LABEL[fmt], extensions: [ext] }] })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      const n = await invoke<number>('db_export_table', { id: connectionId, schema, table: tbl, format: realFmt, whereClause: null, path, structure: structure ?? null })
      if (structure === 'only')      toast.exported(path, '已导出表结构')
      else if (structure === 'with') toast.exported(path, `已导出表结构与 ${n} 行数据`)
      else                           toast.exported(path, `已导出 ${n} 行到 ${EXPORT_LABEL[fmt]} 文件`)
    } catch (e) {
      if (String(e)) toast.error(`导出失败：${String(e)}`)
    }
  }

  // 列表内多选导出：把选中的多个对象按当前类别打包导出为一个 SQL dump
  async function handleExportSelected(content: 'structure' | 'data' | 'both') {
    const names = [...selected]
    if (names.length === 0) return
    setExportMenuOpen(false)
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ defaultPath: `${schema || 'export'}_${names.length}项.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      const payload: Record<string, unknown> = {
        id: connectionId, schema, tables: [], views: [], funcs: [], procs: [],
        path, content, taskId: null,
      }
      if (category === 'tables')          payload.tables = names
      else if (category === 'views')      payload.views = names
      else if (category === 'functions')  payload.funcs = names
      else if (category === 'procedures') payload.procs = names
      await invoke('db_logical_backup', payload)
      toast.exported(path, `已导出选中 ${names.length} 项${content === 'structure' ? '（仅结构）' : content === 'data' ? '（仅数据）' : ''}`)
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('已取消')) toast.error(`导出失败：${msg}`)
    }
  }

  // 函数/存过：取格式化后的 CREATE 定义
  async function fetchRoutineCreate(name: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core')
    const kind = category === 'functions' ? 'function' : 'procedure'
    // 统一走后端按方言分发的 get_routine_ddl，不再限 MySQL
    const raw = await invoke<string>('get_routine_ddl', { id: connectionId, schema, name, kind })
    return prettyRoutineDdl(raw, connType)
  }
  async function copyRoutineDef(name: string) {
    try { copyText(await fetchRoutineCreate(name)); toast.success('已复制定义') }
    catch (e) { toast.error(`复制失败：${String(e)}`) }
  }

  const filtered = items.filter(t =>
    !filter ||
    t.name.toLowerCase().includes(filter.toLowerCase()) ||
    t.comment.toLowerCase().includes(filter.toLowerCase())
  )

  const sorted = [...filtered].sort((a, b) => {
    const va = a[sortKey] ?? '', vb = b[sortKey] ?? ''
    let cmp = 0
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
    else cmp = String(va).localeCompare(String(vb), 'zh', { numeric: true })
    return sortDir === 'asc' ? cmp : -cmp
  })

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function handleRowClick(e: React.MouseEvent, name: string) {
    if (e.shiftKey && lastSelected) {
      // Shift+左键：范围选择
      const names = sorted.map(t => t.name)
      const a = names.indexOf(lastSelected), b = names.indexOf(name)
      setSelected(s => {
        const n = new Set(s)
        names.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => n.add(x))
        return n
      })
    } else if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+左键：多选（用于批量导出等）
      setSelected(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
      setLastSelected(name)
    } else {
      // 普通单击：单选；详情面板打开时跟随显示当前行（开关面板请用工具栏「详情面板」按钮或 ⌘⇧P）
      setSelected(new Set([name]))
      setLastSelected(name)
      if (detailTable) loadDetail(name, isRoutine ? 'ddl' : detailTab)
    }
  }

  function toggleDetail() {
    const name = [...selected][0]
    if (!name) return
    if (detailTable === name) {
      setDetailTable(null)
    } else {
      loadDetail(name, 'ddl')
    }
  }

  function onDetailDragStart(e: React.MouseEvent) {
    e.preventDefault()
    detailDragRef.current = { startY: e.clientY, startH: detailHeight }
    const onMove = (me: MouseEvent) => {
      if (!detailDragRef.current) return
      const delta = detailDragRef.current.startY - me.clientY
      setDetailHeight(Math.max(100, Math.min(600, detailDragRef.current.startH + delta)))
    }
    const onUp = () => {
      detailDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function cellVal(t: TableMeta, key: SortKey): string {
    switch (key) {
      case 'dataLength':    return fmtBytes(t.dataLength)
      case 'indexLength':   return fmtBytes(t.indexLength)
      case 'autoIncrement': return t.autoIncrement != null ? String(t.autoIncrement) : ''
      case 'rowCount':      return t.rowCount ? String(t.rowCount) : ''
      case 'charset':       return t.charset ? t.charset.split('_')[0] : ''
      case 'tableType':
        return t.tableType === 'FUNCTION' ? '函数'
             : t.tableType === 'PROCEDURE' ? '存储过程' : t.tableType
      default: return String((t as unknown as Record<string, unknown>)[key] ?? '')
    }
  }

  // 底部详情面板：加载指定表/视图的数据
  async function loadDetail(tableName: string, tab?: 'ddl' | 'cols' | 'idx') {
    const activeTab = tab ?? detailTab
    setDetailTable(tableName)
    setDetailTab(activeTab)
    setDetailLoading(true); setDetailError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (activeTab === 'ddl') {
        if (isRoutine) {
          // 函数/存过定义统一走后端按方言分发的 get_routine_ddl（去 MySQL 门控）
          const kind = category === 'functions' ? 'function' : 'procedure'
          const raw = await invoke<string>('get_routine_ddl', { id: connectionId, schema, name: tableName, kind })
          setDetailDdl(raw ? await prettyRoutineDdl(raw, connType) : '（无定义）')
        } else {
          const ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table: tableName })
          // 视图：清洗为 CREATE OR REPLACE VIEW ... AS + 格式化 SELECT（与编辑页一致）
          setDetailDdl(category === 'views' ? await prettyViewDdl(ddl, connType, schema, tableName) : ddl)
        }
      } else if (activeTab === 'cols') {
        if (supportsShowStatements(connType)) {
          // MySQL 系：SHOW FULL COLUMNS（含排序规则/注释等丰富列），行为与改前一致
          const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
            id: connectionId, sql: `SHOW FULL COLUMNS FROM ${tref(tableName)}`,
          })
          const cols = res.columns ?? []
          const rows = res.rows ?? []
          const skipIdx = new Set(cols.map((c, i) => /privileges/i.test(c) ? i : -1).filter(i => i >= 0))
          const filteredCols = cols.filter((_, i) => !skipIdx.has(i))
          const filteredRows = rows.map(r => r.filter((_, i) => !skipIdx.has(i)))
          setDetailColNames(filteredCols)
          setDetailColRows(filteredRows)
        } else {
          // 非 MySQL 系（PG/SQLite/DuckDB/MSSQL/ClickHouse…）：走后端按方言分派的 table_columns
          const cols = await invoke<{ name: string; dataType: string; nullable: boolean; key: string; defaultValue: string | null }[]>(
            'table_columns', { id: connectionId, schema, table: tableName },
          )
          setDetailColNames(['字段', '类型', '可空', '键', '默认值'])
          setDetailColRows(cols.map(c => [c.name, c.dataType, c.nullable ? 'YES' : 'NO', c.key, c.defaultValue]))
        }
      } else {
        // 索引：按方言生成 SQL（MySQL=SHOW INDEX / PG/Oracle/SQLite/DuckDB/CH/MSSQL 各走系统表）
        const idxSql = buildIndexSql(connType, schema, tableName)
        if (idxSql) {
          const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
            id: connectionId, sql: idxSql,
          })
          setDetailIdxNames(res.columns ?? [])
          setDetailIdxRows(res.rows ?? [])
        } else {
          setDetailIdxNames([])
          setDetailIdxRows([])
        }
      }
    } catch (e) {
      setDetailError(String(e))
    } finally {
      setDetailLoading(false)
    }
  }

  // 切换 tab 时重新加载
  function switchDetailTab(tab: 'ddl' | 'cols' | 'idx') {
    setDetailTab(tab)
    if (detailTable) loadDetail(detailTable, tab)
  }

  function rowIcon(t: TableMeta) {
    if (t.tableType === 'VIEW')      return <Eye      size={12} strokeWidth={1.7} />
    if (t.tableType === 'FUNCTION')  return <Braces   size={12} strokeWidth={1.7} />
    if (t.tableType === 'PROCEDURE') return <Workflow size={12} strokeWidth={1.7} />
    return <Table2 size={12} strokeWidth={1.7} />
  }

  // 当前分类对应的对象类型
  const catObjType: DbObjType = category === 'views' ? 'view'
    : category === 'functions' ? 'function'
    : category === 'procedures' ? 'procedure' : 'table'
  function doCopyHere(name: string) {
    copyDbObject({ connectionId, connType, schema, objType: catObjType, name })
  }
  // 多选复制：写内部剪贴板（携带全部表名）+ 系统剪贴板，跨库粘贴时迁移向导默认全勾
  function doCopyManyHere(names: string[]) {
    if (names.length <= 1) { if (names[0]) doCopyHere(names[0]); return }
    copyDbObjects({ connectionId, connType, schema, objType: catObjType, name: names[0] }, names)
  }
  // 粘贴到当前预览的 schema：同库 → 复制表(改名 _copy)；跨库 → 迁移向导
  function doPasteHere() {
    pasteDbObject(
      { connectionId, connType, schema },
      { existingNames: new Set(items.map(i => i.name)), openMigrate: setPastePreset, onDone: load },
    )
  }

  // Mod+C 复制 / Mod+V 粘贴：用 document 捕获监听，不依赖网格焦点。
  // 之前用网格 onKeyDown，同库粘贴后列表刷新会令网格失焦 → 第二次 Mod+V 收不到（「只能粘一次」）。
  // 捕获阶段先于库树的 document 冒泡监听运行，命中即标记事件，库树看到标记便让位。
  const kbdRef = useRef({ selected, sorted, doCopyHere, doCopyManyHere, doPasteHere })
  kbdRef.current = { selected, sorted, doCopyHere, doCopyManyHere, doPasteHere }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'c' && k !== 'v') return
      if (!rootRef.current?.offsetParent) return  // 本预览页不可见 → 不处理
      const ae = document.activeElement as HTMLElement | null
      // 焦点在输入/编辑器 → 让位；焦点在左侧库树 → 交给库树
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable
        || ae.closest('.cm-editor') || ae.closest('.asset-panel'))) return
      const cur = kbdRef.current
      if (k === 'c') {
        if (cur.selected.size === 0) return
        if (window.getSelection()?.toString()) return
        if (!dedupeKeyEvent(e as unknown as { __dbObjHandled?: boolean })) return
        e.preventDefault()
        if (cur.selected.size === 1) cur.doCopyHere([...cur.selected][0])
        else cur.doCopyManyHere(cur.sorted.filter(t => cur.selected.has(t.name)).map(t => t.name))
      } else {
        if (!useDbClipboard.getState().clipboard) return
        if (!dedupeKeyEvent(e as unknown as { __dbObjHandled?: boolean })) return
        e.preventDefault()
        cur.doPasteHere()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  // 方向键在表列表中前后切换，并刷新底部属性/DDL 详情
  const moveFocus = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    // Mod+A 全选 / Esc 清空选择（Mod+C/Mod+V 改由 document 捕获监听处理，见下）
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault(); e.stopPropagation()
      setSelected(new Set(sorted.map(t => t.name)))
      return
    }
    if (e.key === 'Escape' && selected.size > 0) { e.preventDefault(); setSelected(new Set()); return }
    if (!sorted.length || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    const cur = sorted.findIndex(t => selected.has(t.name))
    let idx = cur < 0 ? 0 : cur
    idx = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? Math.min(sorted.length - 1, idx + 1) : Math.max(0, idx - 1)
    const name = sorted[idx].name
    setSelected(new Set([name]))
    if (!isRoutine) loadDetail(name, detailTab)
    requestAnimationFrame(() => el?.querySelector('.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  }

  const catLabel = CAT_LABEL[category] ?? category
  // 「新建」按钮按当前分类动态切换：表 / 视图 / 函数 / 存储过程
  const newObjLabel = category === 'views' ? '新建视图'
    : category === 'functions' ? '新建函数'
    : category === 'procedures' ? '新建存储过程' : '新建表'
  function newObjectForCat() {
    if (category === 'views') setViewWizardOpen(true)
    else if (category === 'functions') setRoutineWizardKind('function')
    else if (category === 'procedures') setRoutineWizardKind('procedure')
    else setCreateOpen(true)
  }

  return (
    <>
    <div className="sb-root" ref={rootRef}>
      <EnvWatermark envLabel={envConn?.envLabel} readonly={envConn?.readonly ?? envConn?.readOnly} />
      {/* 工具栏：左=路径下拉(连接 › 库 › 类别，可切换)，右=功能按钮，同一行 */}
      <div className="sb-toolbar">
        <div className="sb-toolbar__left">
          {/* 路径面包屑（下拉可切换展示内容） */}
          <Database size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginRight: 2 }} />
          <SearchableSelect value={connectionId} mono={false} searchPlaceholder="搜索连接…" width={150}
            items={connections.filter(c => c.type !== 'ssh' && c.type !== 'local').map(c => ({ value: c.id, label: c.name }))}
            onChange={async (cid) => {
              if (cid === connectionId) return
              let sch = schema
              try {
                const { invoke } = await import('@tauri-apps/api/core')
                const list = await invoke<string[]>('list_schemas', { id: cid })
                sch = list.includes(schema) ? schema : (list[0] ?? schema)
              } catch { /* ignore */ }
              switchObject(cid, sch, category)
            }} />
          <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <SearchableSelect value={schema} onChange={(s) => switchObject(connectionId, s, category)}
            options={bcSchemas} placeholder="选择库" searchPlaceholder="搜索库…" width={150} />
          <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <SearchableSelect value={category} mono={false} width={110}
            items={(['tables', 'views', 'functions', 'procedures']).map(c => ({ value: c, label: CAT_LABEL[c] ?? c }))}
            onChange={(c) => switchObject(connectionId, schema, c)} />
          <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 8px', flexShrink: 0 }} />
          <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="新建查询" data-shortcut={sc('dbNewQuery')} onClick={() => openQueryTab()}>
            <FileCode2 size={14} strokeWidth={1.8} />
          </button>
          <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip={newObjLabel} data-shortcut={sc('dbObjNewTable')} onClick={newObjectForCat}>
            <Plus size={14} strokeWidth={1.8} />
          </button>
          {clipboard && (
            <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip={`粘贴 “${clipboard.name}”`} data-shortcut={`${modLabel()}-V`} onClick={doPasteHere}>
              <ClipboardPaste size={14} strokeWidth={1.8} />
            </button>
          )}
          <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="刷新" data-shortcut={sc('dbTreeRefresh')} onClick={load} disabled={loading}>
            <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'spin' : ''} />
          </button>
          {!isRoutine && (
            <button
              className={`sb-toolbar__btn sb-toolbar__btn--icon${detailTable ? ' active' : ''}`}
              onClick={toggleDetail}
              disabled={selected.size === 0}
              data-tip="查看 DDL" data-shortcut={sc('dbObjDdl')}
            >
              <PanelBottomOpen size={14} strokeWidth={1.8} />
            </button>
          )}
          {isRoutine && (
            <button className={`sb-toolbar__btn sb-toolbar__btn--icon${detailTable ? ' active' : ''}`}
              disabled={selected.size === 0}
              onClick={toggleDetail} data-tip="查看 DDL" data-shortcut={sc('dbObjDdl')}>
              <PanelBottomOpen size={14} strokeWidth={1.8} />
            </button>
          )}
          {category === 'tables' && (
            <button
              className={`sb-toolbar__btn sb-toolbar__btn--icon${showSizes ? ' active' : ''}`}
              onClick={() => setShowSizes(v => !v)}
              data-tip={showSizes ? '隐藏表占用大小' : '显示各表占用大小'}
            >
              <Scale size={14} strokeWidth={1.8} />
            </button>
          )}
          <div className="export-menu__wrap" onClick={e => e.stopPropagation()}>
            <button className={`sb-toolbar__btn sb-toolbar__btn--icon${exportMenuOpen ? ' active' : ''}`} data-tip="导出选中对象（先在列表勾选）" disabled={selected.size === 0}
              onClick={() => setExportMenuOpen(v => !v)}>
              <Download size={14} strokeWidth={1.8} />
            </button>
            {exportMenuOpen && selected.size > 0 && (
              <div className="export-menu export-menu--left">
                {selected.size > 1 ? (
                  // 多选：打包导出选中的若干对象为单个 SQL dump
                  <>
                    {/* 只有「表」有数据；视图/函数/存过只能导出结构（定义） */}
                    {category === 'tables' && (
                      <button onClick={() => handleExportSelected('both')}>
                        <HardDrive size={12} strokeWidth={1.8} />导出选中 {selected.size} 项（结构+数据）
                      </button>
                    )}
                    <button onClick={() => handleExportSelected('structure')}>
                      <Code2 size={12} strokeWidth={1.8} />导出选中 {selected.size} 项（{category === 'tables' ? '仅结构' : '结构/定义'}）
                    </button>
                    {category === 'tables' && (
                      <button onClick={() => handleExportSelected('data')}>
                        <Download size={12} strokeWidth={1.8} />导出选中 {selected.size} 项（仅数据）
                      </button>
                    )}
                    {category === 'tables' && (<>
                      <div className="db-ctx-menu__sep" />
                      <button onClick={() => { setDictTables([...selected]); setExportMenuOpen(false) }}>
                        <BookOpen size={12} strokeWidth={1.8} />数据字典（选中 {selected.size} 表）
                      </button>
                    </>)}
                  </>
                ) : isRoutine ? (
                  // 单个函数/存储过程：导出其定义
                  <button onClick={() => handleExportSelected('structure')}>
                    <Code2 size={12} strokeWidth={1.8} />导出{category === 'functions' ? '函数' : '存储过程'}定义
                  </button>
                ) : (
                  // 单个表/视图：多格式（紧凑网格）+ 结构 + 数据字典
                  <>
                    <div className="exp-chip-grid__label">导出为</div>
                    <div className="exp-chip-grid">
                      {EXPORT_FORMATS.map(fmt => (
                        <button key={fmt} className="exp-chip" title={EXPORT_LABEL[fmt]} onClick={() => handleExport(fmt)}>
                          {EXPORT_SHORT[fmt]}
                        </button>
                      ))}
                    </div>
                    {category === 'tables' && <>
                      <div className="db-ctx-menu__sep" />
                      <button onClick={() => handleExport('sql', undefined, 'only')}>
                        <Code2 size={12} strokeWidth={1.8} />导出表结构
                      </button>
                      <button onClick={() => handleExport('sql', undefined, 'with')}>
                        <HardDrive size={12} strokeWidth={1.8} />导出表结构与数据
                      </button>
                      <button onClick={() => { setDictTables([[...selected][0]]); setExportMenuOpen(false) }}>
                        <BookOpen size={12} strokeWidth={1.8} />数据字典
                      </button>
                    </>}
                  </>
                )}
              </div>
            )}
          </div>
          {/* db_import_csv / db_exec_sql_file 仅支持 MySQL 族 / PG 族 / sqlite / duckdb */}
          {category === 'tables' && ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'].includes(connType) && (
            <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="导入数据"
              onClick={async () => {
                // 始终打开导入弹窗：CSV/数据需选目标表，SQL 文件可直接建表+导入（无需现有表）
                const name = [...selected][0] ?? sorted[0]?.name ?? ''
                setImportTarget(name); setImportCols([]); setImportOpen(true)
                if (name) {
                  try {
                    const { invoke } = await import('@tauri-apps/api/core')
                    const c = await invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table: name })
                    setImportCols(c.map(x => x.name))
                  } catch { /* ignore */ }
                }
              }}>
              <Upload size={14} strokeWidth={1.8} />
            </button>
          )}
          {/* db_logical_backup 仅支持 MySQL 族 / PG 族 */}
          {category === 'tables' && ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(connType) && (
            <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="整库导出 / 备份（按类型全量）" onClick={() => setBackupOpen(true)}>
              <HardDrive size={14} strokeWidth={1.8} />
            </button>
          )}
          {/* 更多工具下拉（对比/迁移以表为主） */}
          {category === 'tables' && (
            <div style={{ position: 'relative' }}>
              <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="工具" data-tools-trigger onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                setToolsDropPos({ top: r.bottom + 4, left: r.left })
                setToolsDropOpen(v => !v)
              }}>
                <Wrench size={14} strokeWidth={1.8} />
              </button>
              {toolsDropOpen && createPortal(
                <div className="sb-ctx-menu" ref={(el) => clampIntoViewport(el)}
                  style={{ position: 'fixed', top: toolsDropPos.top, left: toolsDropPos.left, zIndex: 8500, maxHeight: '70vh', overflowY: 'auto' }}
                  onMouseLeave={() => setToolsDropOpen(false)}>
                  {/* 迁移：MySQL/PG 族 + SQLite/DuckDB 互迁；Oracle/SQLServer/ClickHouse 同引擎迁移（单一真源见 sqlDialect.MIGRATABLE_DB_TYPES）*/}
                  {(MIGRATABLE_DB_TYPES as string[]).includes(connType) && (
                    <button className="sb-ctx-item" onClick={() => { setToolsDropOpen(false); setMigrationOpen(true) }}>
                      <ArrowRightLeft size={12} /> 数据迁移向导
                    </button>
                  )}
                  {/* 数据对比 D1：MySQL/PG 族 + Oracle / SQL Server / ClickHouse（后端 db_diff_data 支持范围）*/}
                  {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'oracle', 'sqlServer', 'clickHouse'].includes(connType) && (
                    <button className="sb-ctx-item" onClick={() => { setToolsDropOpen(false); setDataDiffOpen(true) }}>
                      <GitCompare size={12} /> 数据对比 (D1)
                    </button>
                  )}
                  {/* 结构对比 D2：MySQL/PG 族 + Oracle / SQL Server / ClickHouse（同族对比）*/}
                  {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'oracle', 'sqlServer', 'clickHouse'].includes(connType) && (
                    <button className="sb-ctx-item" onClick={() => { setToolsDropOpen(false); setStructDiffOpen(true) }}>
                      <GitCompare size={12} /> 结构对比 (D2)
                    </button>
                  )}
                  {/* 对象 / 数据工具（库管理、数据字典、ER图、备份恢复、导出中心等，按连接类型过滤）*/}
                  {toolsFor('object', connType).map((it) => (
                    <button key={it.tool} className="sb-ctx-item"
                      onClick={() => { setToolsDropOpen(false); useDbToolsStore.getState().openTool(it.tool, { connectionId, connType, schema }) }}>
                      {it.icon} {it.label}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}
        </div>
        <div className="sb-toolbar__right">
          {searchOpen ? (
            <div className="sb-filter">
              <Search size={11} className="sb-filter__icon" />
              <input ref={filterRef} className="sb-filter__input" placeholder="筛选名称/注释…"
                value={filter} autoFocus
                onChange={e => setFilter(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setFilter(''); setSearchOpen(false) } }}
                onBlur={() => { if (!filter) setSearchOpen(false) }}
              />
            </div>
          ) : (
            <button className="sb-toolbar__btn sb-toolbar__btn--icon" data-tip="搜索" data-shortcut={sc('dbTreeSearch')}
              onClick={() => { setSearchOpen(true); setTimeout(() => { filterRef.current?.focus() }, 50) }}>
              <Search size={14} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      {/* 状态 */}
      {loading && <div className="sb-msg"><RefreshCw size={14} className="spin" />加载中…</div>}
      {error && !loading && <div className="sb-msg sb-msg--err">{error}</div>}

      {/* 列表视图 */}
      {!loading && !error && viewMode === 'list' && (
        <div className="sb-table-wrap" tabIndex={0} onKeyDown={moveFocus}>
          <div className="sb-table">
            <div className="sb-thead">
              {columns.map(col => (
                <div key={col.key}
                  className={`sb-th${sortKey === col.key ? ' sort-on' : ''}`}
                  style={{ width: col.width, minWidth: col.width, justifyContent: col.right ? 'flex-end' : undefined }}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (sortDir === 'asc'
                    ? <ChevronUp size={10} style={{ flexShrink: 0 }} />
                    : <ChevronDown size={10} style={{ flexShrink: 0 }} />)}
                </div>
              ))}
            </div>
            <div className="sb-tbody">
              {sorted.map(t => (
                <div key={t.name}
                  className={`sb-tr${selected.has(t.name) ? ' sel' : ''}`}
                  onClick={e => handleRowClick(e, t.name)}
                  onDoubleClick={e => openObject(t.name, e)}
                  onContextMenu={e => handleContextMenu(e, t.name)}
                >
                  {columns.map(col => (
                    <div key={col.key} className="sb-td"
                      style={{ width: col.width, minWidth: col.width }}>
                      {col.key === 'name' && <span className="sb-td__ico">{rowIcon(t)}</span>}
                      {col.key === 'comment'
                        ? <span className="sb-td__muted" data-tip={cellVal(t, col.key) || undefined}>{cellVal(t, col.key)}</span>
                        : <span className={col.key === 'name' ? 'sb-td__name' : undefined}
                            data-tip={col.key === 'name' ? t.name : undefined}
                            style={col.right ? { marginLeft: 'auto' } : undefined}>
                            {cellVal(t, col.key)}
                          </span>
                      }
                    </div>
                  ))}
                </div>
              ))}
              {sorted.length === 0 && <div className="sb-msg">暂无{catLabel}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 网格视图（Navicat 风格缩略图） */}
      {!loading && !error && viewMode === 'grid' && (
        <div className="sb-grid" ref={gridRef} tabIndex={0} onKeyDown={moveFocus}>
          {sorted.map(t => (
            <button key={t.name}
              className={`sb-card${selected.has(t.name) ? ' sel' : ''}`}
              data-tip={t.name}
              onClick={e => handleRowClick(e, t.name)}
              onDoubleClick={e => openObject(t.name, e)}
              onContextMenu={e => handleContextMenu(e, t.name)}
            >
              <span className="sb-card__ico-lg">{rowIcon(t)}</span>
              <span className="sb-card__name">{t.name}</span>
              {showSizes && category === 'tables' && (
                <span className="sb-card__size">{fmtBytes(t.dataLength + t.indexLength)}</span>
              )}
            </button>
          ))}
          {sorted.length === 0 && <div className="sb-msg">暂无{catLabel}</div>}
        </div>
      )}

      {/* ── 底部详情面板 ── */}
      {detailTable && (
        <div className="sb-detail" style={{ height: detailHeight }}>
          {/* 拖拽调整高度的把手 */}
          <div className="sb-detail__resize-handle" onMouseDown={onDetailDragStart} />
          <div className="sb-detail__header">
            <span className="sb-detail__tname" data-tip={detailTable ?? ''}>
              <Table2 size={12} strokeWidth={1.8} />
              {detailTable}
            </span>
            <div className="sb-detail__tabs">
              {(isRoutine ? (['ddl'] as const) : (['cols', 'idx', 'ddl'] as const)).map(t => (
                <button key={t}
                  className={`sb-detail__tab${detailTab === t ? ' active' : ''}`}
                  onClick={() => switchDetailTab(t)}>
                  {t === 'cols' ? '属性' : t === 'idx' ? '索引' : 'DDL'}
                </button>
              ))}
            </div>
            {!isRoutine && category === 'tables' && (() => {
              const m = items.find(i => i.name === detailTable)
              if (!m) return null
              return (
                <span className="sb-detail__size" data-tip="数据 + 索引占用">
                  <HardDrive size={11} strokeWidth={1.8} />
                  {fmtBytes(m.dataLength + m.indexLength)}
                  <span className="sb-detail__size-sub">· {m.rowCount.toLocaleString()} 行</span>
                </span>
              )
            })()}
            <button className="sb-detail__close" onClick={() => setDetailTable(null)} data-tip="关闭"><X size={12} /></button>
          </div>
          <div className="sb-detail__body">
            {detailLoading && <div className="sb-msg"><RefreshCw size={12} className="spin" />加载中…</div>}
            {detailError && !detailLoading && <div className="sb-msg sb-msg--err">{detailError}</div>}
            {!detailLoading && !detailError && detailTab === 'ddl' && (
              detailDdl
                ? <SqlCodeView code={detailDdl} connType={connType} className="sb-detail__ddl-cm" />
                : <pre className="sb-detail__ddl">（无 DDL）</pre>
            )}
            {!detailLoading && !detailError && detailTab === 'cols' && (
              <div className="sb-detail__table-wrap">
                <table className="sb-detail__tbl">
                  <thead>
                    <tr>{detailColNames.map(h => <th key={h}>{zhCol(h)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {detailColRows.map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? 'NULL'}</td>)}</tr>
                    ))}
                    {detailColRows.length === 0 && <tr><td colSpan={detailColNames.length || 1} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>无数据</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            {!detailLoading && !detailError && detailTab === 'idx' && (
              <div className="sb-detail__table-wrap">
                <table className="sb-detail__tbl">
                  <thead>
                    <tr>{detailIdxNames.map(h => <th key={h}>{zhCol(h)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {detailIdxRows.map((row, i) => (
                      <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? 'NULL'}</td>)}</tr>
                    ))}
                    {detailIdxRows.length === 0 && <tr><td colSpan={detailIdxNames.length || 1} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>无索引</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 底部状态栏 ── */}
      <div className="sb-statusbar">
        <span className="sb-statusbar__count">
          {selected.size > 0
            ? <><strong>{selected.size}</strong> / <strong>{filtered.length}</strong> {catLabel}</>
            : <><strong>{filtered.length}</strong> {catLabel}{filter ? ' (已筛选)' : ''}</>}
        </span>
        <div className="sb-statusbar__right">
          <button className={`sb-view-btn${viewMode === 'list' ? ' active' : ''}`}
            onClick={() => setViewMode('list')} data-tip="列表视图">
            <List size={13} />
          </button>
          <button className={`sb-view-btn${viewMode === 'grid' ? ' active' : ''}`}
            onClick={() => setViewMode('grid')} data-tip="网格视图">
            <LayoutGrid size={13} />
          </button>
        </div>
      </div>
    </div>

      {/* ── Context menu ── */}
      {ctxMenu && (() => {
        const name   = ctxMenu.tableName
        const isView = category === 'views'
        const rkind  = category === 'functions' ? 'FUNCTION' : 'PROCEDURE'
        const rlabel = category === 'functions' ? '函数' : '存储过程'
        if (isRoutine) return createPortal(
          <div ref={ctxRef} className="db-ctx-menu"
            style={{ position: 'fixed', left: ctxPos?.left ?? ctxMenu.x, top: ctxPos?.top ?? ctxMenu.y, visibility: ctxPos ? 'visible' : 'hidden' }}>
            {/* 查看定义 = 底部 DDL 面板（与表/视图一致，只读）；编辑 = 打开可编辑设计页 */}
            <button onClick={() => { setSelected(new Set([name])); loadDetail(name, 'ddl'); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Code2 size={12} strokeWidth={1.8} />查看定义</span>
              {sc('dbObjDdl') && <span className="ctx-item__shortcut">{sc('dbObjDdl')}</span>}
            </button>
            <button onClick={() => { openEditObject({ connectionId, connType, schema, objType: category === 'functions' ? 'function' : 'procedure', name }); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />编辑{rlabel}</span>
              <span className="ctx-item__shortcut">双击</span>
            </button>
            <button onClick={() => { fillQuery(category === 'functions' ? `SELECT ${tref(name)}();` : `CALL ${tref(name)}();`); closeMenu() }}>
              <Terminal size={12} strokeWidth={1.8} />在查询页{category === 'functions' ? '调用函数' : '调用'}
            </button>
            {supportsShowStatements(connType) && (
              <button onClick={() => { fillQuery(`SHOW CREATE ${rkind} ${tref(name)};`); closeMenu() }}>
                <Terminal size={12} strokeWidth={1.8} />在查询页查看定义
              </button>
            )}
            <div className="db-ctx-menu__sep" />
            <button onClick={() => { copyText(name); closeMenu() }}>
              <Copy size={12} strokeWidth={1.8} />复制{rlabel}名
            </button>
            <button onClick={() => { copyRoutineDef(name); closeMenu() }}>
              <Code2 size={12} strokeWidth={1.8} />复制定义
            </button>
            <button onClick={() => { setSelected(new Set([name])); handleExportSelected('structure') }}>
              <Download size={12} strokeWidth={1.8} />导出定义
            </button>
            <div className="db-ctx-menu__sep" />
            <button className="db-ctx-menu__item--danger" onClick={() => {
              setDropList(dropTargetsFor(name)); setDropInput(''); setDialogError(''); closeMenu()
            }}>
              <Trash2 size={12} strokeWidth={1.8} />删除{selected.has(name) && selected.size > 1 ? `选中 ${selected.size} 个` : rlabel}
            </button>
          </div>,
          document.body
        )
        return createPortal(
        <div ref={ctxRef} className="db-ctx-menu"
          style={{ position: 'fixed', left: ctxPos?.left ?? ctxMenu.x, top: ctxPos?.top ?? ctxMenu.y, visibility: ctxPos ? 'visible' : 'hidden' }}>
          {/* 数据 / 查询 区 */}
          <button onMouseEnter={() => setSbSub(null)} onClick={() => { openTableData(name); closeMenu() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Table2 size={12} strokeWidth={1.8} />打开{isView ? '视图' : '表'}数据</span>
            <span className="ctx-item__shortcut">{isView ? `${modLabel()}-双击` : '双击'}</span>
          </button>
          <button onMouseEnter={() => setSbSub(null)} onClick={() => { fillQuery(`${previewSelect(connType, tref(name), 100)};`); closeMenu() }}>
            <Terminal size={12} strokeWidth={1.8} />查询此{isView ? '视图' : '表'}
          </button>
          <button onMouseEnter={() => setSbSub(null)} onClick={() => { setInfoTarget(name); closeMenu() }}>
            <Info size={12} strokeWidth={1.8} />表信息
          </button>
          <div className="db-ctx-menu__sep" />
          {/* 查看 / 复制 区 */}
          <button onMouseEnter={() => setSbSub(null)} onClick={() => openDdl(name)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Code2 size={12} strokeWidth={1.8} />查看 DDL</span>
            {sc('dbObjDdl') && <span className="ctx-item__shortcut">{sc('dbObjDdl')}</span>}
          </button>
          {isView && (
            <button onMouseEnter={() => setSbSub(null)} onClick={() => { openEditObject({ connectionId, connType, schema, objType: 'view', name }); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />编辑视图</span>
              <span className="ctx-item__shortcut">双击</span>
            </button>
          )}
          <button onMouseEnter={() => setSbSub(null)} onClick={() => { copyText(name); closeMenu() }}>
            <Copy size={12} strokeWidth={1.8} />复制{isView ? '视图' : '表'}名
          </button>
          <button className={`db-ctx-menu__sub-trigger${sbSub?.key === 'export' ? ' on' : ''}`}
            onMouseEnter={e => openSub('export', e, EXPORT_FORMATS.length)} onMouseLeave={closeSub}>
            <Download size={12} strokeWidth={1.8} />下载{isView ? '视图' : '表'}
            <ChevronRight size={13} className="db-ctx-menu__chev" />
          </button>
          <div className="db-ctx-menu__sep" />
          {/* 结构 区 */}
          {!isView && (
            <button onMouseEnter={() => setSbSub(null)} onClick={() => { setEditTable(name); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Settings2 size={12} strokeWidth={1.8} />修改表结构…</span>
              {sc('dbObjStructure') && <span className="ctx-item__shortcut">{sc('dbObjStructure')}</span>}
            </button>
          )}
          {/* 复制表：后端 db_copy_table 仅支持 MySQL 族 / PG 族 → 仅这两族显示 */}
          {!isView && ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(connType) && (
            <button onMouseEnter={() => setSbSub(null)} onClick={() => {
              setCopyTarget(name); setCopyInput(name + '_copy'); setCopyWithData(false); setDialogError(''); closeMenu()
            }}>
              <Files size={12} strokeWidth={1.8} />复制表…
            </button>
          )}
          <button onMouseEnter={() => setSbSub(null)} onClick={() => {
            setRenameTarget(name); setRenameInput(name); setDialogError(''); closeMenu()
          }} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />重命名…</span>
            {sc('dbObjRename') && <span className="ctx-item__shortcut">{sc('dbObjRename')}</span>}
          </button>
          {!isView && supportsMyMaintenance(connType) && (
            <>
              <div className="db-ctx-menu__sep" />
              <button className={`db-ctx-menu__sub-trigger${sbSub?.key === 'maint' ? ' on' : ''}`}
                onMouseEnter={e => openSub('maint', e, 3)} onMouseLeave={closeSub}>
                <Wand2 size={12} strokeWidth={1.8} />维护
                <ChevronRight size={13} className="db-ctx-menu__chev" />
              </button>
            </>
          )}
          <div className="db-ctx-menu__sep" />
          {!isView && (
            <button className="db-ctx-menu__item--danger" onMouseEnter={() => setSbSub(null)} onClick={() => {
              setTruncateTarget(name); setTruncateInput(''); setDialogError(''); closeMenu()
            }}>
              <Eraser size={12} strokeWidth={1.8} />清空表
            </button>
          )}
          <button className="db-ctx-menu__item--danger" onMouseEnter={() => setSbSub(null)} onClick={() => {
            setDropList(dropTargetsFor(name)); setDropInput(''); setDialogError(''); closeMenu()
          }}>
            <Trash2 size={12} strokeWidth={1.8} />删除{selected.has(name) && selected.size > 1 ? `选中 ${selected.size} 个` : (isView ? '视图' : '表')}
          </button>
        </div>,
        document.body
        )
      })()}

      {/* 右键菜单的级联子菜单 */}
      {ctxMenu && sbSub && (() => {
        const name   = ctxMenu.tableName
        const isView = category === 'views'
        return createPortal(
        <div ref={sbSubRef} className="db-ctx-menu db-ctx-submenu"
          style={{ position: 'fixed', top: sbSub.top, left: sbSub.left }}
          onMouseEnter={keepSub} onMouseLeave={closeSub}>
          {sbSub.key === 'maint' && <>
            {supportsOptimizeTable(connType) && <button onClick={() => { setMaintDlg({ kind: 'OPTIMIZE', table: name }); setMaintErr(''); closeMenu() }}><Wand2 size={12} strokeWidth={1.8} />优化表</button>}
            <button onClick={() => { setMaintDlg({ kind: 'ANALYZE', table: name }); setMaintErr(''); closeMenu() }}><Gauge size={12} strokeWidth={1.8} />分析表</button>
            <button onClick={() => { setMaintDlg({ kind: 'CHECK', table: name }); setMaintErr(''); closeMenu() }}><ShieldCheck size={12} strokeWidth={1.8} />检查表</button>
          </>}
          {sbSub.key === 'export' && <>
            <div className="exp-chip-grid__label">导出为</div>
            <div className="exp-chip-grid">
              {EXPORT_FORMATS.map(fmt => (
                <button key={fmt} className="exp-chip" title={EXPORT_LABEL[fmt]}
                  onClick={() => { handleExport(fmt, name); closeMenu() }}>
                  {EXPORT_SHORT[fmt]}
                </button>
              ))}
            </div>
            {!isView && <>
              <div className="db-ctx-menu__sep" />
              <button onClick={() => { handleExport('sql', name, 'only'); closeMenu() }}>
                <Code2 size={12} strokeWidth={1.8} />导出表结构
              </button>
              <button onClick={() => { handleExport('sql', name, 'with'); closeMenu() }}>
                <HardDrive size={12} strokeWidth={1.8} />导出表结构与数据
              </button>
            </>}
          </>}
        </div>,
        document.body
        )
      })()}

      {/* ── TRUNCATE 确认弹窗 ── */}
      {truncateTarget && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title">TRUNCATE 截断表</span>
              <button className="modal-close" onClick={() => setTruncateTarget(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
                此操作将清空 <strong>{truncateTarget}</strong> 的所有数据，无法恢复。
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                请输入表名 <strong>{truncateTarget}</strong> 确认操作：
              </p>
              <input value={truncateInput} onChange={e => setTruncateInput(e.target.value)}
                placeholder={truncateTarget} autoFocus />
              {dialogError && <span style={{ color: 'var(--error)', fontSize: 13 }}>{dialogError}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setTruncateTarget(null)}>取消</button>
                  <button style={{ background: 'var(--warning)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: truncateInput === truncateTarget ? 1 : 0.4 }}
                    disabled={truncateInput !== truncateTarget || dialogLoading}
                    onClick={handleTruncateConfirm}>
                    {dialogLoading ? '执行中…' : '确认截断'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── DROP 确认弹窗（支持批量）── */}
      {dropList && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title" style={{ color: 'var(--error)' }}>DROP 删除{catLabel}</span>
              <button className="modal-close" onClick={() => setDropList(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {dropMulti ? (
                <>
                  <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
                    此操作将永久删除选中的 <strong style={{ color: 'var(--error)' }}>{dropList.length}</strong> 个{catLabel}{category === 'tables' ? ' 及其所有数据' : ''}，无法恢复。
                  </p>
                  <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface-2)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)' }}>
                    {dropList.map(n => <div key={n} style={{ padding: '1px 0' }}>{n}</div>)}
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                    请输入数字 <strong>{dropList.length}</strong> 确认批量删除：
                  </p>
                  <input value={dropInput} onChange={e => setDropInput(e.target.value)}
                    placeholder={String(dropList.length)} autoFocus />
                </>
              ) : (
                <>
                  <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
                    此操作将永久删除{catLabel} <strong style={{ color: 'var(--error)' }}>{dropList[0]}</strong>{category === 'tables' ? ' 及其所有数据' : ''}，无法恢复。
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                    请输入{catLabel}名 <strong>{dropList[0]}</strong> 确认删除：
                  </p>
                  <input value={dropInput} onChange={e => setDropInput(e.target.value)}
                    placeholder={dropList[0]} autoFocus />
                </>
              )}
              {dialogError && <span style={{ color: 'var(--error)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{dialogError}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setDropList(null)}>取消</button>
                  <button style={{ background: 'var(--error)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: dropConfirmOk ? 1 : 0.4 }}
                    disabled={!dropConfirmOk || dialogLoading}
                    onClick={handleDropConfirm}>
                    {dialogLoading ? '执行中…' : dropMulti ? `永久删除 ${dropList.length} 项` : '永久删除'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 重命名弹窗 ── */}
      {maintDlg && createPortal(
        <div className="modal-overlay" onMouseDown={() => !maintBusy && setMaintDlg(null)}>
          <div className="modal-box modal-box--sm" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{MAINT_LABEL[maintDlg.kind]}</span>
              <button className="modal-close" onClick={() => setMaintDlg(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>
                对 <strong>{maintDlg.table}</strong> {MAINT_DESC[maintDlg.kind]}
              </div>
              {maintErr && <div className="result-error">{maintErr}</div>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setMaintDlg(null)} disabled={maintBusy}>取消</button>
                  <button className="btn-save" onClick={confirmMaint} disabled={maintBusy}>
                    {maintBusy ? '执行中…' : '执行'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {renameTarget && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title">重命名{category === 'views' ? '视图' : '表'}</span>
              <button className="modal-close" onClick={() => setRenameTarget(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                将 <strong>{renameTarget}</strong> 重命名为：
              </p>
              <input value={renameInput} onChange={e => setRenameInput(e.target.value)}
                autoFocus onKeyDown={e => e.key === 'Enter' && handleRenameConfirm()} />
              {dialogError && <span style={{ color: 'var(--error)', fontSize: 13 }}>{dialogError}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setRenameTarget(null)}>取消</button>
                  <button className="btn-save" disabled={!renameInput.trim() || dialogLoading} onClick={handleRenameConfirm}>
                    {dialogLoading ? '执行中…' : '重命名'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 复制表弹窗 ── */}
      {copyTarget && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title">复制表</span>
              <button className="modal-close" onClick={() => setCopyTarget(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                将 <strong>{copyTarget}</strong> 复制为新表：
              </p>
              <input value={copyInput} onChange={e => setCopyInput(e.target.value)}
                autoFocus onKeyDown={e => e.key === 'Enter' && handleCopyConfirm()} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={copyWithData} onChange={e => setCopyWithData(e.target.checked)} />
                包含数据
              </label>
              {dialogError && <span style={{ color: 'var(--error)', fontSize: 13 }}>{dialogError}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setCopyTarget(null)}>取消</button>
                  <button className="btn-save" disabled={!copyInput.trim() || dialogLoading} onClick={handleCopyConfirm}>
                    {dialogLoading ? '执行中…' : '复制'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── DbTools 面板 ── */}
      {importOpen && (
        <ImportDialog
          connectionId={connectionId} schema={schema} table={importTarget}
          columns={importCols} tables={sorted.map(t => t.name)}
          onClose={() => setImportOpen(false)}
          onDone={() => { load() }}
        />
      )}
      {backupOpen && (
        <BackupPanel connectionId={connectionId} schema={schema} onClose={() => setBackupOpen(false)} />
      )}
      {migrationOpen && (
        <MigrationWizard connections={connections} defaultSrcId={connectionId} defaultSrcSchema={schema} defaultDstId={connectionId} defaultDstSchema={schema} onClose={() => setMigrationOpen(false)} />
      )}
      {pastePreset && (
        <MigrationWizard connections={connections}
          defaultSrcId={pastePreset.srcId} defaultSrcSchema={pastePreset.srcSchema}
          defaultTable={pastePreset.srcTable} defaultTables={pastePreset.srcTables}
          defaultDstId={pastePreset.dstId} defaultDstSchema={pastePreset.dstSchema}
          onClose={() => setPastePreset(null)} />
      )}
      {dataDiffOpen && (
        <DataDiffPanel connectionId={connectionId} connType={connType} schema={schema} onClose={() => setDataDiffOpen(false)} />
      )}
      {structDiffOpen && (
        <StructureDiffPanel connectionId={connectionId} schema={schema} table={[...selected][0] ?? ''} onClose={() => setStructDiffOpen(false)} />
      )}
      {dictTables && (
        <DataDictPanel
          connectionId={connectionId}
          schema={schema}
          tables={dictTables}
          connName={connections.find(c => c.id === connectionId)?.name}
          onClose={() => setDictTables(null)}
        />
      )}
      {editTable && (
        <CreateTableWizard connectionId={connectionId} connType={connType} schema={schema} editTable={editTable}
          onClose={() => setEditTable(null)} onDone={() => { notifySchemaChanged(connectionId, schema); setEditTable(null) }} />
      )}
      {infoTarget && (
        <TableInfoModal connectionId={connectionId} connType={connType} schema={schema}
          name={infoTarget} isView={category === 'views'}
          meta={items.find(i => i.name === infoTarget)}
          onClose={() => setInfoTarget(null)} />
      )}
      {createOpen && (
        <CreateTableWizard connectionId={connectionId} connType={connType} schema={schema}
          onClose={() => setCreateOpen(false)} onDone={() => notifySchemaChanged(connectionId, schema)} />
      )}
      {viewWizardOpen && (
        <ViewWizard connectionId={connectionId} connType={connType} schema={schema}
          onClose={() => setViewWizardOpen(false)} />
      )}
      {routineWizardKind && (
        <RoutineWizard connectionId={connectionId} connType={connType} schema={schema}
          kind={routineWizardKind} onClose={() => setRoutineWizardKind(null)} />
      )}
    </>
  )
}
