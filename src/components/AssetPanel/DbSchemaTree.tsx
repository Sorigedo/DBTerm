import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Database, Table2, Eye, ChevronRight, Loader2,
  Braces, Workflow, Code2, Copy, MoreHorizontal, Settings2,
  RefreshCw, Terminal, ClipboardCopy, LayoutGrid, FilePlus, Trash2,
  ArrowRightLeft, GitCompare, Plus, Pencil, Eraser,
  Wand2, Gauge, ShieldCheck, Hash, ListPlus, Zap, Link, Unlink, FolderOpen, Layers,
  Download, Upload, BookOpen, Info, ClipboardPaste, Bookmark, FileCode2, Users,
  Star,
} from 'lucide-react'
import UsersPanel from '../DbTools/UsersPanel'
import OracleUsersPanel from '../DbTools/OracleUsersPanel'
import DbToolsEntry from '../DbTools/DbToolsEntry'
import { useDbToolsStore } from '../../stores/dbToolsStore'
import DdlModal from '../SqlEditor/DdlModal'
import TableInfoModal from '../DbTools/TableInfoModal'
import CreateTableWizard from '../DbTools/CreateTableWizard'
import ViewWizard from '../DbTools/ViewWizard'
import RoutineWizard from '../DbTools/RoutineWizard'
import { openEditObject } from '../../utils/objectEditor'
import AlterTableWizard from '../DbTools/AlterTableWizard'
import DataDictPanel from '../DbTools/DataDictPanel'
import SearchableSelect from '../DbTools/SearchableSelect'
import type { ConnType } from '../../types'
import {
  qid, tableRef, dialectFamily, isMysqlFamily,
  supportsShowStatements, supportsMyMaintenance, supportsOptimizeTable, checkTableSql,
} from '../../utils/sqlDialect'
import { useAppStore } from '../../stores/appStore'
import { copyText } from '../../utils/clipboard'
import { toast } from '../../stores/toastStore'
import { onSchemaChanged, openDbTool, onCollapseAllTrees } from '../../utils/schemaRefresh'
import { savedQueriesForConn, deleteSavedQuery, renameSavedQuery, onSavedQueriesChanged, type SavedQuery } from '../../utils/savedQueries'
import { useDbClipboard, sameObj, type DbObjRef } from '../../stores/dbClipboardStore'
import { copyDbObject, pasteDbObject, dedupeKeyEvent, type MigratePreset } from '../../utils/dbCopyPaste'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcutStr, SHORTCUT_DEFS, isModEvent, modLabel } from '../../utils/shortcuts'
import { useSchemaVisibilityStore } from '../../stores/schemaVisibilityStore'
import { useDbCapsStore } from '../../stores/dbCapsStore'
import { useRedisStore } from '../../stores/redisStore'

interface TableInfo   { name: string; isView: boolean }
interface RoutineInfo { name: string; routineType: string }
interface SqliteExtraObject { name: string; tblName: string }
interface MariaSequenceItem { sequenceName: string; increment: number; cycleOption: boolean }
interface SchemaData {
  tables: TableInfo[]
  routines: RoutineInfo[]
  tablesLoaded: boolean
  routinesLoaded: boolean
  // SQLite-only
  indexes?: SqliteExtraObject[]
  triggers?: SqliteExtraObject[]
  extraLoaded?: boolean
  // MariaDB 10.3+ 原生序列
  sequences?: MariaSequenceItem[]
  sequencesLoaded?: boolean
}

interface Props {
  connectionId: string
  connType: ConnType
  defaultSchema?: string
  /** 顶部搜索词：非空时就地过滤库/表/视图/函数/存储过程并自动展开命中项 */
  objectFilter?: string
  /** 跨 schema/连接 粘贴时打开数据迁移向导（由上层渲染向导） */
  onMigrate?: (p: MigratePreset) => void
  onOpenTable: (schema: string, table: string) => void
}

type Cat = 'tables' | 'views' | 'functions' | 'procedures'
const CAT_LABEL: Record<Cat, string> = {
  tables: '表', views: '视图', functions: '函数', procedures: '存储过程',
}

export default function DbSchemaTree({ connectionId, connType, defaultSchema, objectFilter, onMigrate, onOpenTable }: Props) {
  // 搜索词（小写归一）：非空即进入「就地过滤 + 自动展开命中」模式
  const objQuery = (objectFilter ?? '').trim().toLowerCase()
  const searching = objQuery.length > 0
  const nameHit = (n: string) => n.toLowerCase().includes(objQuery)

  // 选中 / 剪贴板（全局唯一）
  const selected  = useDbClipboard(s => s.selected)
  const clipboard = useDbClipboard(s => s.clipboard)
  const selectObj = useDbClipboard(s => s.select)
  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const sc = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  const { connections, openEditConn, openObjectTab, openQueryTab, setPendingRun, setPendingFill, setPendingSchema } = useAppStore(s => ({
    connections: s.connections, openEditConn: s.openEditConn,
    openObjectTab: s.openObjectTab, openQueryTab: s.openQueryTab,
    setPendingRun: s.setPendingRun, setPendingFill: s.setPendingFill, setPendingSchema: s.setPendingSchema,
  }))
  const [schemas, setSchemas]           = useState<string[]>([])
  const [manualSchemas, setManualSchemas] = useState<string[]>([])
  const [manualInput, setManualInput]   = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')
  const [schemaData, setSchemaData]     = useState<Record<string, SchemaData>>({})
  // 每个 schema 的表加载序号：用于丢弃过期（乱序返回）的刷新结果
  const tblSeqRef = useRef<Record<string, number>>({})

  // 保存的查询（挂在本连接下，与 schema 同级）
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [savedOpen, setSavedOpen]       = useState(false)
  const [savedCtx, setSavedCtx]         = useState<{ x: number; y: number; q: SavedQuery } | null>(null)
  const [savedRootCtx, setSavedRootCtx] = useState<{ x: number; y: number } | null>(null)
  const [renameQuery, setRenameQuery]   = useState<SavedQuery | null>(null)
  const [renameQueryInput, setRenameQueryInput] = useState('')
  useEffect(() => {
    const refresh = () => setSavedQueries(savedQueriesForConn(connectionId))
    refresh()
    return onSavedQueriesChanged(refresh)
  }, [connectionId])
  useEffect(() => {
    if (!savedCtx) return
    const close = () => setSavedCtx(null)
    const t = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('click', close) }
  }, [savedCtx])
  useEffect(() => {
    if (!savedRootCtx) return
    const close = () => setSavedRootCtx(null)
    const t = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('click', close) }
  }, [savedRootCtx])

  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const [expandedCats, setExpandedCats]       = useState<Set<string>>(new Set())

  const [loadingSchema,   setLoadingSchema]   = useState<string | null>(null)
  const [loadingRoutines, setLoadingRoutines] = useState<string | null>(null)
  const [loadingExtra,    setLoadingExtra]    = useState<string | null>(null)
  // SQLite extra cats expand state
  const [expandedExtra, setExpandedExtra] = useState<Set<string>>(new Set())

  const [schemaCtx, setSchemaCtx] = useState<{ x: number; y: number; schema: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; schema: string; table: string; isView: boolean; ssSchema?: string
  } | null>(null)
  const [ctxPos, setCtxPos] = useState<{ top: number; left: number } | null>(null)
  const [schemaCtxPos, setSchemaCtxPos] = useState<{ top: number; left: number } | null>(null)
  // 数据字典面板：tables 为空 → 整库；否则仅这些表
  const [dictTarget, setDictTarget] = useState<{ schema: string; tables?: string[] } | null>(null)
  const [catCtxPos, setCatCtxPos] = useState<{ top: number; left: number } | null>(null)
  // 表菜单的级联子菜单（复制 / 维护）
  const [subOpen, setSubOpen] = useState<{ key: 'maint'; top: number; left: number } | null>(null)
  const subTimer = useRef<number | null>(null)
  const [catCtx, setCatCtx] = useState<{ x: number; y: number; schema: string; cat: Cat } | null>(null)
  // 函数/存储过程行右键菜单
  const [routineCtx, setRoutineCtx] = useState<{ x: number; y: number; schema: string; name: string; kind: 'function' | 'procedure' } | null>(null)
  const routineCtxRef = useRef<HTMLDivElement>(null)
  // 新建表设计器
  const [createTableSchema, setCreateTableSchema] = useState<string | null>(null)
  const [viewWizard, setViewWizard] = useState<string | null>(null)
  const [routineWizard, setRoutineWizard] = useState<{ schema: string; kind: 'function' | 'procedure' } | null>(null)
  // 修改表结构（复用建表设计器的编辑模式）
  const [editTable, setEditTable] = useState<{ schema: string; table: string } | null>(null)
  // 删除数据库强确认（需输入库名）
  const [dropDbTarget, setDropDbTarget] = useState<string | null>(null)
  const [dropDbInput, setDropDbInput]   = useState('')
  const [dropDbBusy, setDropDbBusy]     = useState(false)
  const [dropDbError, setDropDbError]   = useState('')
  // 新建数据库
  const [createDbOpen, setCreateDbOpen]           = useState(false)
  const [createDbName, setCreateDbName]           = useState('')
  const [createDbCharset, setCreateDbCharset]     = useState('utf8mb4')
  const [createDbCollation, setCreateDbCollation] = useState('')
  const [createDbCollations, setCreateDbCollations] = useState<string[]>([])
  const [createDbBusy, setCreateDbBusy]           = useState(false)
  const [createDbErr, setCreateDbErr]             = useState('')
  // 表信息弹窗
  const [infoTarget, setInfoTarget] = useState<{ schema: string; table: string; isView: boolean } | null>(null)
  // 重命名表 / 视图
  const [renameTarget, setRenameTarget] = useState<{ schema: string; table: string; isView: boolean } | null>(null)
  const [renameInput, setRenameInput]   = useState('')
  const [renameBusy, setRenameBusy]     = useState(false)
  const [renameErr, setRenameErr]       = useState('')
  // 清空 / 删除 表（视图）强确认（需输入表名）
  const [tblDanger, setTblDanger] = useState<{
    kind: 'truncate' | 'drop'; schema: string; table: string; isView: boolean
  } | null>(null)
  const [tblDangerInput, setTblDangerInput] = useState('')
  const [tblDangerBusy, setTblDangerBusy]   = useState(false)
  const [tblDangerErr, setTblDangerErr]     = useState('')
  const [ddlState, setDdlState]     = useState<{
    schema: string; table: string; ddl: string; loading: boolean; error: string
  } | null>(null)
  // 命令型操作（优化/分析/检查/统计行数）确认执行弹窗
  const [actionDlg, setActionDlg] = useState<{
    title: string; desc: string; sql: string; danger?: boolean
  } | null>(null)
  const [actionBusy, setActionBusy]     = useState(false)
  const [actionErr, setActionErr]       = useState('')

  // SQLite ATTACH 状态
  const [attachOpen, setAttachOpen]     = useState(false)
  const [attachAlias, setAttachAlias]   = useState('')
  const [attachPath, setAttachPath]     = useState('')
  const [attachBusy, setAttachBusy]     = useState(false)
  const [attachErr, setAttachErr]       = useState('')
  const [attachedSet, setAttachedSet]   = useState<Set<string>>(new Set())

  // SQL Server 三级树：database → SS-schema → tables/views
  const [ssSubSchemas, setSsSubSchemas]           = useState<Record<string, string[]>>({})
  const [ssSubSchemasLoading, setSsSubSchemasLoading] = useState<Set<string>>(new Set())
  const [expandedSsSchemas, setExpandedSsSchemas] = useState<Set<string>>(new Set()) // "db\x1fssSchema"
  const [ssTblData, setSsTblData]                 = useState<Record<string, TableInfo[]>>({}) // "db\x1fssSchema" → tables
  const [ssTblLoading, setSsTblLoading]           = useState<string | null>(null)

  const ctxRef       = useRef<HTMLDivElement>(null)
  const subRef       = useRef<HTMLDivElement>(null)
  const schemaCtxRef = useRef<HTMLDivElement>(null)
  const catCtxRef    = useRef<HTMLDivElement>(null)
  const manualRef    = useRef<HTMLInputElement>(null)
  const isSingle    = connType === 'sqlite' || connType === 'duckdb'
  const isDuck      = connType === 'duckdb'
  const isMaria     = connType === 'mariadb'
  const isSqlServer = connType === 'sqlServer'
  // 无「函数 / 存储过程」概念的库：ClickHouse（UDF 全局不按库列）、TiDB（不支持存过/函数）→ 隐藏这两个节点
  const hideRoutines = connType === 'clickHouse' || connType === 'tidb'
  // Redis / MongoDB：库节点不是 SQL 形态，不展开「表/视图/函数」，点击直接打开专属浏览器
  const isKv      = connType === 'redis' || connType === 'mongodb'
  // 用户与权限：MySQL 系 / PG 系走 UsersPanel；Oracle 走 OraclePanel 的用户管理页
  // （SQLite/DuckDB/Redis/Mongo 无此概念）
  const isOracle = connType === 'oracle'
  const supportsUsers = isOracle || ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(connType)
  const [showUsers, setShowUsers] = useState(false)
  const manualKey = `dbt-manual-${connectionId}`

  const dbCaps = useDbCapsStore(s => s.getCaps(connectionId))
  const showSequences = isMaria && dbCaps.hasSequences
  const [loadingSeqs, setLoadingSeqs] = useState<string | null>(null)

  useEffect(() => {
    setSchemas([])
    setSchemaData({})
    setExpandedSchemas(new Set())
    setExpandedCats(new Set())
    setError('')
    setManualInput('')
    setAttachedSet(new Set())
    setSsSubSchemas({})
    setSsSubSchemasLoading(new Set())
    setExpandedSsSchemas(new Set())
    setSsTblData({})
    setSsTblLoading(null)
    // 加载该连接持久化的手动 schema
    try {
      const saved = localStorage.getItem(manualKey)
      setManualSchemas(saved ? (JSON.parse(saved) as string[]) : [])
    } catch {
      setManualSchemas([])
    }
    doLoadSchemas()
    // 加载已附加的 SQLite 库
    if (connType === 'sqlite') {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke<{ alias: string; path: string }[]>('sqlite_list_attached', { id: connectionId })
          .then(list => setAttachedSet(new Set(list.map(a => a.alias))))
          .catch(() => {})
      )
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  useEffect(() => {
    if (!ctxMenu) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      const inMenu = ctxRef.current?.contains(t) || subRef.current?.contains(t)
      if (!inMenu) { setCtxMenu(null); setSubOpen(null) }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ctxMenu])

  // 右键菜单开后按视口钳制位置：避免底部/右侧溢出被截断
  useLayoutEffect(() => {
    if (!ctxMenu) { setCtxPos(null); return }
    const el = ctxRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    let left = ctxMenu.x
    let top  = ctxMenu.y
    if (left + width  > window.innerWidth  - pad) left = Math.max(pad, ctxMenu.x - width)
    if (top  + height > window.innerHeight - pad) top  = Math.max(pad, window.innerHeight - height - pad)
    setCtxPos({ top, left })
  }, [ctxMenu])

  useEffect(() => {
    if (!schemaCtx) return
    const h = (e: MouseEvent) => {
      if (schemaCtxRef.current && !schemaCtxRef.current.contains(e.target as Node)) setSchemaCtx(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [schemaCtx])

  // 库右键菜单按视口钳制位置：避免底部/右侧溢出被截断
  useLayoutEffect(() => {
    if (!schemaCtx) { setSchemaCtxPos(null); return }
    const el = schemaCtxRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    let left = schemaCtx.x
    let top  = schemaCtx.y
    if (left + width  > window.innerWidth  - pad) left = Math.max(pad, schemaCtx.x - width)
    if (top  + height > window.innerHeight - pad) top  = Math.max(pad, window.innerHeight - height - pad)
    setSchemaCtxPos({ top, left })
  }, [schemaCtx])

  // 新建数据库弹窗：charset 变化时拉取排序规则列表（SHOW COLLATION 仅 MySQL 系；其它库留空）
  useEffect(() => {
    if (!createDbOpen) return
    if (!isMysqlFamily(connType)) { setCreateDbCollations([]); setCreateDbCollation(''); return }
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type Rows = { rows: (string | null)[][] }
        const res = await invoke<Rows>('execute_query', {
          id: connectionId,
          sql: `SHOW COLLATION WHERE Charset = '${createDbCharset.replace(/'/g, "''")}'`,
        })
        if (cancelled) return
        const list = res.rows.map(r => String(r[0] ?? '')).filter(Boolean).sort()
        setCreateDbCollations(list)
        const def = res.rows.find(r => r[3] === 'Yes')
        setCreateDbCollation(def ? String(def[0]) : (list[0] ?? ''))
      } catch { setCreateDbCollations([]); setCreateDbCollation('') }
    })()
    return () => { cancelled = true }
  }, [connectionId, createDbOpen, createDbCharset])

  useEffect(() => {
    if (!catCtx) return
    const h = (e: MouseEvent) => {
      if (catCtxRef.current && !catCtxRef.current.contains(e.target as Node)) setCatCtx(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [catCtx])

  useEffect(() => {
    if (!routineCtx) return
    const h = (e: MouseEvent) => {
      if (routineCtxRef.current && !routineCtxRef.current.contains(e.target as Node)) setRoutineCtx(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [routineCtx])

  // 类别右键菜单按视口钳制位置
  useLayoutEffect(() => {
    if (!catCtx) { setCatCtxPos(null); return }
    const el = catCtxRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    let left = catCtx.x
    let top  = catCtx.y
    if (left + width  > window.innerWidth  - pad) left = Math.max(pad, catCtx.x - width)
    if (top  + height > window.innerHeight - pad) top  = Math.max(pad, window.innerHeight - height - pad)
    setCatCtxPos({ top, left })
  }, [catCtx])

  function openSchemaQuery(sql?: string, schemaName?: string) {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return
    // 每次都新建一个查询标签（SQL 连接支持多开；redis/mongo 内部仍按连接单例）
    const tabId = openQueryTab(connectionId)
    // 带过去当前 schema（仅切库展示，不执行 USE）
    if (schemaName) setPendingSchema(tabId, schemaName)
    if (sql) setPendingRun(tabId, sql)
  }

  // 导入数据：打开对象列表并弹出完整的导入弹窗（SQL 文件 / 数据文件）
  function importSchemaSql(schema: string) {
    setSchemaCtx(null)
    openCatBrowser(schema, 'tables')
    openDbTool(connectionId, schema, 'import')
  }

  // 打开查询页并填入 SQL 模板（不执行，由用户确认后运行）——新建标签，避免覆盖已有查询
  function openSchemaFill(sql: string) {
    const tabId = openQueryTab(connectionId)
    setPendingFill(tabId, sql)
  }

  // 打开一条保存的查询：新建查询页，回填 SQL 与所在 schema（不自动执行）
  function openSavedQuery(q: SavedQuery) {
    const tabId = openQueryTab(connectionId)
    if (q.schema) setPendingSchema(tabId, q.schema)
    setPendingFill(tabId, q.sql, { savedQueryId: q.id, savedQueryName: q.name })
  }

  // 导出保存的查询为 .sql 文件（带 DBTerm 头注释，便于回溯）
  async function exportSavedQuery(q: SavedQuery) {
    const ts = new Date(q.createdAt).toISOString().replace('T', ' ').slice(0, 19)
    const conn = connections.find(c => c.id === q.connId)
    const header = [
      `-- DBTerm 保存的查询`,
      `-- 名称: ${q.name}`,
      `-- 连接: ${q.connId === '' ? '（全局）' : (conn?.name ?? q.connId)}${q.schema ? ` · ${q.schema}` : ''}`,
      `-- 保存于: ${ts}`,
      '', '',
    ].join('\n')
    const safeName = q.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'query'
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ defaultPath: `${safeName}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content: header + q.sql + '\n' })
      toast.exported(path)
    } catch (e) {
      toast.error(`导出失败：${String(e)}`)
    }
  }

  // 导出本连接下全部保存的查询为单个 .sql 文件（每条带名称/schema/时间注释，--- 分隔）
  async function exportAllSavedQueries() {
    if (savedQueries.length === 0) { toast.error('暂无保存的查询可导出'); return }
    const conn = connections.find(c => c.id === connectionId)
    const fileHeader = [
      `-- DBTerm 保存的查询（批量导出）`,
      `-- 连接: ${conn?.name ?? connectionId}`,
      `-- 共 ${savedQueries.length} 条`,
      '', '',
    ].join('\n')
    const blocks = savedQueries.map(q => {
      const ts = new Date(q.createdAt).toISOString().replace('T', ' ').slice(0, 19)
      return [
        `-- ─────────────────────────────────────────────`,
        `-- 名称: ${q.name}${q.connId === '' ? '（全局）' : ''}`,
        `-- 位置: ${q.connId === '' ? '全局' : (conn?.name ?? q.connId)}${q.schema ? ` · ${q.schema}` : ''}`,
        `-- 保存于: ${ts}`,
        '',
        q.sql.trim(),
        '',
      ].join('\n')
    })
    const safeName = (conn?.name ?? 'saved-queries').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ defaultPath: `${safeName}-保存的查询.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content: fileHeader + blocks.join('\n') + '\n' })
      toast.exported(path, `已导出 ${savedQueries.length} 条：${path}`)
    } catch (e) {
      toast.error(`导出失败：${String(e)}`)
    }
  }

  // 级联子菜单 hover 控制
  function openSub(key: 'maint', e: React.MouseEvent, itemCount: number) {
    if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const estH = itemCount * 32 + 8
    const top  = Math.min(r.top, window.innerHeight - estH - 8)
    setSubOpen({ key, top: Math.max(8, top), left: r.right - 4 })
  }
  function keepSub()  { if (subTimer.current) { clearTimeout(subTimer.current); subTimer.current = null } }
  function closeSub() { subTimer.current = window.setTimeout(() => setSubOpen(null), 160) }
  function closeMenu() { setCtxMenu(null); setSubOpen(null) }

  // 打开「确认执行」弹窗（命令型操作：优化/分析/检查/统计行数）
  function openAction(title: string, desc: string, sql: string, danger = false) {
    setCtxMenu(null); setSubOpen(null)
    setActionDlg({ title, desc, sql, danger })
    setActionErr(''); setActionBusy(false)
  }
  async function runActionSql() {
    if (!actionDlg) return
    setActionBusy(true); setActionErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ columns: string[]; rows: (string | null)[][]; rowsAffected: number }>(
        'execute_query', { id: connectionId, sql: actionDlg.sql })
      // Success: close dialog and show toast
      const title = actionDlg.title
      setActionDlg(null)
      if (res.columns.length > 0) {
        // ANALYZE/CHECK TABLE 返回带 Msg_text 的结果表；统计行数等返回单值结果
        const msgIdx = res.columns.findIndex(c => /msg_?text/i.test(c))
        if (msgIdx >= 0) {
          toast.success(`${title}：${res.rows[0]?.[msgIdx] ?? 'OK'}`)
        } else if (res.columns.length === 1 && res.rows.length === 1) {
          // 单列单行（如 COUNT(*)）：直接展示该值
          toast.success(`${title}：${res.rows[0]?.[0] ?? ''}`)
        } else {
          toast.success(`${title} 执行成功`)
        }
      } else {
        toast.success(`${title} 执行成功，影响 ${res.rowsAffected} 行`)
      }
    } catch (e) { setActionErr(String(e)) }
    finally { setActionBusy(false) }
  }

  const doLoadSchemas = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<string[]>('list_schemas', { id: connectionId })
      setSchemas(list)
    } catch (e) {
      setError(String(e))
      const _n = connections.find(c => c.id === connectionId)?.name ?? connectionId
      toast.error(`连接「${_n}」失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  async function doLoadTables(schema: string) {
    // 序号守卫：同一 schema 并发/快速多次刷新时只让最新结果落地，
    // 避免较早（更旧）的请求后返回覆盖较新结果，导致树与实际库表「对不上」。
    const seq = (tblSeqRef.current[schema] ?? 0) + 1
    tblSeqRef.current[schema] = seq
    setLoadingSchema(schema)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<TableInfo[]>('list_tables', { id: connectionId, schema })
      if (tblSeqRef.current[schema] !== seq) return  // 已有更新的刷新在跑，丢弃本次
      setSchemaData(d => ({
        ...d,
        [schema]: {
          tables: list,
          routines: d[schema]?.routines ?? [],
          tablesLoaded: true,
          routinesLoaded: d[schema]?.routinesLoaded ?? false,
        },
      }))
      // 例程计数与表一起刷新（强制），避免「函数/存储过程」计数因缓存而长期显示 0
      doLoadRoutines(schema, true)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingSchema(prev => prev === schema ? null : prev)
    }
  }

  async function doLoadRoutines(schema: string, force?: boolean) {
    if (!force && schemaData[schema]?.routinesLoaded) return
    setLoadingRoutines(schema)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<RoutineInfo[]>('list_routines', { id: connectionId, schema })
      setSchemaData(d => ({
        ...d,
        [schema]: {
          ...d[schema],
          tables: d[schema]?.tables ?? [],
          routines: list,
          routinesLoaded: true,
          tablesLoaded: d[schema]?.tablesLoaded ?? false,
        },
      }))
    } catch {
      // not all DB types support routines — fail silently
    } finally {
      setLoadingRoutines(prev => prev === schema ? null : prev)
    }
  }

  // 全部折叠：收起本库树内已展开的 schema / 类别节点
  useEffect(() => onCollapseAllTrees(() => {
    setExpandedSchemas(new Set())
    setExpandedCats(new Set())
    setExpandedExtra(new Set())
  }), [])

  // DDL / 导入后主动刷新：重载库列表，并刷新受影响库已展开的表/例程
  useEffect(() => onSchemaChanged(d => {
    if (d.connectionId !== connectionId) return
    doLoadSchemas()
    const target = d.schema
    const refresh = (s: string, force?: boolean) => {
      if (schemaData[s]?.tablesLoaded || expandedSchemas.has(s)) doLoadTables(s)
      // 目标库：强制重载例程，使新建/删除函数·存过后计数与列表立即更新（即使之前未展开过）
      if (force || schemaData[s]?.routinesLoaded) doLoadRoutines(s, true)
    }
    if (target) refresh(target, true)
    else Object.keys(schemaData).forEach(s => refresh(s))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [connectionId, schemaData, expandedSchemas])

  async function doLoadSequences(schema: string) {
    if (schemaData[schema]?.sequencesLoaded) return
    setLoadingSeqs(schema)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<MariaSequenceItem[]>('mariadb_list_sequences', { id: connectionId, schema })
      setSchemaData(d => ({
        ...d,
        [schema]: { ...d[schema], sequences: list, sequencesLoaded: true },
      }))
    } catch {
      setSchemaData(d => ({
        ...d,
        [schema]: { ...d[schema], sequences: [], sequencesLoaded: true },
      }))
    } finally {
      setLoadingSeqs(prev => prev === schema ? null : prev)
    }
  }

  async function doLoadSqliteObjects(schema: string) {
    if (schemaData[schema]?.extraLoaded) return
    setLoadingExtra(schema)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ indexes: SqliteExtraObject[]; triggers: SqliteExtraObject[] }>('sqlite_list_objects', { id: connectionId })
      setSchemaData(d => ({
        ...d,
        [schema]: {
          ...d[schema],
          tables: d[schema]?.tables ?? [],
          routines: d[schema]?.routines ?? [],
          tablesLoaded: d[schema]?.tablesLoaded ?? false,
          routinesLoaded: d[schema]?.routinesLoaded ?? false,
          indexes: res.indexes,
          triggers: res.triggers,
          extraLoaded: true,
        },
      }))
    } catch {
      // fail silently
    } finally {
      setLoadingExtra(prev => prev === schema ? null : prev)
    }
  }

  async function doLoadSsSubSchemas(database: string) {
    setSsSubSchemasLoading(s => { const n = new Set(s); n.add(database); return n })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<string[]>('list_ss_db_schemas', { id: connectionId, database })
      setSsSubSchemas(d => ({ ...d, [database]: list }))
    } catch (e) {
      toast.error(`加载 Schema 列表失败：${String(e)}`)
    } finally {
      setSsSubSchemasLoading(s => { const n = new Set(s); n.delete(database); return n })
    }
  }

  async function doLoadSsTablesBySchema(database: string, ssSchema: string) {
    const key = `${database}\x1f${ssSchema}`
    setSsTblLoading(key)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<TableInfo[]>('list_ss_schema_tables', { id: connectionId, database, ssSchema })
      setSsTblData(d => ({ ...d, [key]: list }))
    } catch (e) {
      toast.error(`加载表失败：${String(e)}`)
    } finally {
      setSsTblLoading(prev => prev === key ? null : prev)
    }
  }

  function toggleSsSchema(database: string, ssSchema: string) {
    const key = `${database}\x1f${ssSchema}`
    if (expandedSsSchemas.has(key)) {
      setExpandedSsSchemas(s => { const n = new Set(s); n.delete(key); return n })
    } else {
      setExpandedSsSchemas(s => new Set([...s, key]))
      if (!ssTblData[key]) doLoadSsTablesBySchema(database, ssSchema)
    }
  }

  function toggleSchema(schema: string) {
    if (expandedSchemas.has(schema)) {
      setExpandedSchemas(s => { const n = new Set(s); n.delete(schema); return n })
    } else {
      setExpandedSchemas(s => new Set([...s, schema]))
      if (isSqlServer) {
        // SQL Server：展开数据库节点时加载其下的 SS-level Schema（dbo、HumanResources 等）
        if (!ssSubSchemas[schema]) doLoadSsSubSchemas(schema)
      } else {
        if (!schemaData[schema]?.tablesLoaded) doLoadTables(schema)
        // 同时加载例程，使「函数/存储过程」计数准确（否则未展开分类时一直显示 0）
        if (!schemaData[schema]?.routinesLoaded) doLoadRoutines(schema)
      }
    }
  }

  function toggleCat(schema: string, cat: Cat) {
    const key = `${schema}::${cat}`
    if (expandedCats.has(key)) {
      setExpandedCats(s => { const n = new Set(s); n.delete(key); return n })
    } else {
      setExpandedCats(s => new Set([...s, key]))
      if ((cat === 'functions' || cat === 'procedures') && !schemaData[schema]?.routinesLoaded) {
        doLoadRoutines(schema)
      }
    }
  }

  function handleAddManual() {
    const name = manualInput.trim()
    if (!name) return
    const updated = manualSchemas.includes(name) ? manualSchemas : [...manualSchemas, name]
    setManualSchemas(updated)
    setManualInput('')
    localStorage.setItem(manualKey, JSON.stringify(updated))
    setExpandedSchemas(s => new Set([...s, name]))
    if (!schemaData[name]?.tablesLoaded) doLoadTables(name)
  }

  function removeManualSchema(name: string) {
    const updated = manualSchemas.filter(s => s !== name)
    setManualSchemas(updated)
    localStorage.setItem(manualKey, JSON.stringify(updated))
  }

  async function doAttach() {
    const alias = attachAlias.trim()
    const path  = attachPath.trim()
    if (!alias || !path) { setAttachErr('请填写别名和文件路径'); return }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) { setAttachErr('别名只能包含字母、数字、下划线，且不能以数字开头'); return }
    setAttachBusy(true); setAttachErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (isDuck) {
        await invoke('duckdb_attach', { id: connectionId, alias, dbType: 'duckdb', connStr: path, readOnly: false })
      } else {
        await invoke('sqlite_attach', { id: connectionId, alias, path })
      }
      setAttachedSet(s => new Set([...s, alias]))
      setAttachOpen(false); setAttachAlias(''); setAttachPath('')
      doLoadSchemas()
      toast.success(`已附加数据库 "${alias}"`)
    } catch (e) {
      setAttachErr(String(e))
    } finally {
      setAttachBusy(false)
    }
  }

  async function doDetach(alias: string) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (isDuck) {
        await invoke('duckdb_query', { id: connectionId, sql: `DETACH "${alias.replace(/"/g, '""')}"`, limit: 1 })
      } else {
        await invoke('sqlite_detach', { id: connectionId, alias })
      }
      setAttachedSet(s => { const n = new Set(s); n.delete(alias); return n })
      doLoadSchemas()
      toast.success(`已断开附加数据库 "${alias}"`)
    } catch (e) {
      toast.error(String(e))
    }
  }

  async function pickAttachFile() {
    const isTauri = '__TAURI_INTERNALS__' in window
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        title: isDuck ? '选择要附加的 DuckDB 数据库文件' : '选择要附加的 SQLite 数据库文件',
        filters: isDuck
          ? [{ name: 'DuckDB 数据库', extensions: ['duckdb', 'db'] }, { name: '所有文件', extensions: ['*'] }]
          : [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 's3db', 'sl3'] }, { name: '所有文件', extensions: ['*'] }],
      })
      if (typeof selected === 'string') setAttachPath(selected)
    } catch { /* 取消 */ }
  }

  async function openDdl(schema: string, table: string) {
    setDdlState({ schema, table, ddl: '', loading: true, error: '' })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
      setDdlState(d => d ? { ...d, ddl, loading: false } : null)
    } catch (e) {
      setDdlState(d => d ? { ...d, error: String(e), loading: false } : null)
    }
  }

  function onCtxMenu(e: React.MouseEvent, schema: string, table: string, isView: boolean, ssSchema?: string) {
    e.preventDefault()
    e.stopPropagation()
    setSubOpen(null)
    setCtxMenu({ x: e.clientX, y: e.clientY, schema, table, isView, ssSchema })
  }

  // ── 复制/粘贴（Navicat 风格）────────────────────────────────────────
  const schemaDataRef = useRef(schemaData)
  schemaDataRef.current = schemaData

  function doCopy(o: DbObjRef) { copyDbObject(o) }
  function doPaste(targetSchema: string) {
    pasteDbObject(
      { connectionId, connType, schema: targetSchema },
      {
        existingNames: new Set((schemaDataRef.current[targetSchema]?.tables ?? []).map(t => t.name)),
        openMigrate: (p) => onMigrate?.(p),
      },
    )
  }

  // Mod+C 复制选中对象 / Mod+V 粘贴到选中对象所在 schema（仅「拥有选中项」的库树实例响应）
  const copyRef  = useRef<(o: DbObjRef) => void>(() => {})
  const pasteRef = useRef<(s: string) => void>(() => {})
  copyRef.current = doCopy
  pasteRef.current = doPaste
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModEvent(e)) return
      const k = e.key.toLowerCase()
      if (k !== 'c' && k !== 'v') return
      const sel = useDbClipboard.getState().selected
      if (!sel || sel.connectionId !== connectionId) return
      // 事件来源或焦点在输入框/编辑器/对象预览列表，或有文本选区 → 让位（防止与预览页 moveFocus 重复触发）
      const probe = (el: Element | null) => !!el && (
        (el as HTMLElement).tagName === 'INPUT' || (el as HTMLElement).tagName === 'TEXTAREA'
        || (el as HTMLElement).isContentEditable
        || !!el.closest('.cm-editor, .sb-table-wrap, .sb-grid'))
      if (probe(e.target as Element | null) || probe(document.activeElement)) return
      // 同一次按键去重（预览页可能已处理同一原生事件）
      if (!dedupeKeyEvent(e as unknown as { __dbObjHandled?: boolean })) return
      if (k === 'c') {
        if (window.getSelection()?.toString()) return
        e.preventDefault(); copyRef.current(sel)
      } else {
        if (!useDbClipboard.getState().clipboard) return
        e.preventDefault(); pasteRef.current(sel.schema)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [connectionId])

  function renderTableRow(schema: string, tbl: TableInfo, ssSchema?: string) {
    const ref: DbObjRef = { connectionId, connType, schema, objType: tbl.isView ? 'view' : 'table', name: tbl.name }
    return (
      <div
        key={tbl.name}
        className={`dbt-table-row${sameObj(selected, ref) ? ' selected' : ''}`}
        // 单击选中（高亮 + Mod+C 复制目标）
        onClick={e => { e.stopPropagation(); selectObj(ref) }}
        // 视图：双击编辑定义，Mod+双击打开数据；表：双击打开数据
        onDoubleClick={e => {
          if (tbl.isView && !isModEvent(e)) {
            openEditObject({ connectionId, connType, schema, objType: 'view', name: tbl.name })
          } else {
            onOpenTable(schema, tbl.name)
          }
        }}
        onContextMenu={e => onCtxMenu(e, schema, tbl.name, tbl.isView, ssSchema)}
      >
        {tbl.isView
          ? <Eye    size={12} strokeWidth={1.7} className="dbt-icon--view" />
          : <Table2 size={12} strokeWidth={1.7} className="dbt-icon--table" />
        }
        <span className="dbt-item-name">{tbl.name}</span>
        <button
          className="dbt-more-btn"
          onClick={e => { e.stopPropagation(); onCtxMenu(e, schema, tbl.name, tbl.isView, ssSchema) }}
        >
          <MoreHorizontal size={11} strokeWidth={2} />
        </button>
      </div>
    )
  }

  function openCatBrowser(schema: string, cat: Cat) {
    const conn = connections.find(c => c.id === connectionId)
    if (!conn) return
    // 每个连接只有一个固定的「对象浏览」标签：随激活的 schema/类别切换内容
    openObjectTab(connectionId, `${conn.name} · ${schema} · ${CAT_LABEL[cat]}`, { schema, category: cat })
  }

  // SQL Server 三级树：数据库展开后渲染 SS-level Schema 节点（dbo / HumanResources 等）
  function renderSsSchemaLevel(database: string) {
    const schemaList = ssSubSchemas[database]
    const isLoading  = ssSubSchemasLoading.has(database)
    if (isLoading) return (
      <div className="dbt-empty" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Loader2 size={10} className="spin" />加载中…
      </div>
    )
    if (!schemaList) return null
    if (schemaList.length === 0) return <div className="dbt-empty">无 Schema</div>
    return (
      <>
        {schemaList.map(ssSchema => {
          const key     = `${database}\x1f${ssSchema}`
          const isEx    = expandedSsSchemas.has(key)
          const tables  = ssTblData[key]
          const isLoad  = ssTblLoading === key
          const tbls    = (tables ?? []).filter(t => !t.isView)
          const views   = (tables ?? []).filter(t =>  t.isView)
          return (
            <div key={ssSchema} className="dbt-cat-node">
              <div className="dbt-cat-row">
                <button className="dbt-cat-expand-btn" onClick={() => toggleSsSchema(database, ssSchema)}>
                  <ChevronRight size={10} strokeWidth={2.5} className={`dbt-cat-arrow${isEx ? ' rot90' : ''}`} />
                </button>
                <button className="dbt-cat-label-btn" onClick={() => toggleSsSchema(database, ssSchema)}>
                  <Layers size={10} strokeWidth={1.8} style={{ color: 'var(--text-muted)', flexShrink: 0, marginRight: 3 }} />
                  <span className="dbt-cat-label">{ssSchema}</span>
                  {tables && <span className="dbt-cat-count">{tables.length}</span>}
                  {isLoad && <Loader2 size={9} className="spin" style={{ marginLeft: 4 }} />}
                </button>
              </div>
              {isEx && (
                <div className="dbt-cat-items">
                  {tbls.map(t => renderTableRow(database, t, ssSchema))}
                  {views.map(t => renderTableRow(database, t, ssSchema))}
                  {!isLoad && tables && tables.length === 0 && <div className="dbt-empty">暂无对象</div>}
                </div>
              )}
            </div>
          )
        })}
      </>
    )
  }

  // Redis/Mongo：点击库节点打开专属浏览器（Redis 还会切到对应 DB 索引）
  function openKvBrowser(schema: string) {
    if (connType === 'redis') {
      const n = parseInt(schema.replace(/^db/, ''), 10)
      if (Number.isInteger(n)) useRedisStore.getState().setActiveDb(connectionId, n)
    }
    openQueryTab(connectionId)
  }

  function renderCat(schema: string, cat: Cat, items: (TableInfo | RoutineInfo)[]) {
    const catKey = `${schema}::${cat}`
    const isLoad = (cat === 'functions' || cat === 'procedures') && loadingRoutines === schema
    // 搜索模式：无命中项的分类整组隐藏；有命中则强制展开
    if (searching && items.length === 0) return null
    const isEx   = searching ? true : expandedCats.has(catKey)

    return (
      <div key={cat} className="dbt-cat-node">
        <div className="dbt-cat-row"
          onDoubleClick={() => toggleCat(schema, cat)}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
            setCatCtx({ x: e.clientX, y: e.clientY, schema, cat })
          }}>
          {/* 箭头：展开/收起分类树 */}
          <button className="dbt-cat-expand-btn" onClick={() => toggleCat(schema, cat)}>
            <ChevronRight size={10} strokeWidth={2.5} className={`dbt-cat-arrow${isEx ? ' rot90' : ''}`} />
          </button>
          {/* 标签名：点击打开 SchemaBrowser 标签页 */}
          <button className="dbt-cat-label-btn" onClick={() => openCatBrowser(schema, cat)}>
            <span className="dbt-cat-label">{CAT_LABEL[cat]}</span>
            <span className="dbt-cat-count">{items.length}</span>
            {isLoad && <Loader2 size={9} className="spin" style={{ marginLeft: 4 }} />}
          </button>
        </div>

        {isEx && (
          <div className="dbt-cat-items">
            {(cat === 'tables' || cat === 'views')
              ? (items as TableInfo[]).map(t => renderTableRow(schema, t))
              : (items as RoutineInfo[]).map(r => {
                const kind = cat === 'functions' ? 'function' as const : 'procedure' as const
                const rref: DbObjRef = { connectionId, connType, schema, objType: kind, name: r.name }
                const openCtx = (e: React.MouseEvent) => {
                  e.preventDefault(); e.stopPropagation()
                  setRoutineCtx({ x: e.clientX, y: e.clientY, schema, name: r.name, kind })
                }
                return (
                <div key={r.name} className={`dbt-table-row${sameObj(selected, rref) ? ' selected' : ''}`}
                  onClick={e => { e.stopPropagation(); selectObj(rref) }}
                  onDoubleClick={() => openEditObject({ connectionId, connType, schema, objType: kind, name: r.name })}
                  onContextMenu={openCtx}>
                  {cat === 'functions'
                    ? <Braces   size={11} strokeWidth={1.8} className="dbt-icon--fn" />
                    : <Workflow size={11} strokeWidth={1.8} className="dbt-icon--proc" />
                  }
                  <span className="dbt-item-name">{r.name}</span>
                  <button className="dbt-more-btn" onClick={openCtx}>
                    <MoreHorizontal size={11} strokeWidth={2} />
                  </button>
                </div>
                )
              })
            }
            {items.length === 0 && !isLoad && !searching && (
              <div className="dbt-empty">暂无</div>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderSqliteExtraCat(schema: string, kind: 'indexes' | 'triggers', items: SqliteExtraObject[]) {
    const key   = `${schema}::sqlite-${kind}`
    const isLoad = loadingExtra === schema
    const label = kind === 'indexes' ? '索引' : '触发器'
    const Icon  = kind === 'indexes' ? Hash : Zap
    if (searching && items.length === 0) return null
    const isEx  = searching ? true : expandedExtra.has(key)

    return (
      <div key={kind} className="dbt-cat-node">
        <div className="dbt-cat-row">
          <button className="dbt-cat-expand-btn" onClick={() => {
            if (isEx) {
              setExpandedExtra(s => { const n = new Set(s); n.delete(key); return n })
            } else {
              setExpandedExtra(s => new Set([...s, key]))
              doLoadSqliteObjects(schema)
            }
          }}>
            <ChevronRight size={10} strokeWidth={2.5} className={`dbt-cat-arrow${isEx ? ' rot90' : ''}`} />
          </button>
          <button className="dbt-cat-label-btn" style={{ cursor: 'default' }}>
            <span className="dbt-cat-label">{label}</span>
            <span className="dbt-cat-count">{items.length}</span>
            {isLoad && <Loader2 size={9} className="spin" style={{ marginLeft: 4 }} />}
          </button>
        </div>
        {isEx && (
          <div className="dbt-cat-items">
            {items.map(obj => (
              <div key={obj.name} className="dbt-routine-row">
                <Icon size={11} strokeWidth={1.8} className="dbt-icon--fn" />
                <span className="dbt-item-name">{obj.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4, opacity: 0.7 }}>{obj.tblName}</span>
              </div>
            ))}
            {items.length === 0 && !isLoad && !searching && <div className="dbt-empty">暂无</div>}
          </div>
        )}
      </div>
    )
  }

  function renderMariaSequencesCat(schema: string, items: MariaSequenceItem[]) {
    const key  = `${schema}::maria-sequences`
    const isLoad = loadingSeqs === schema
    if (searching && items.length === 0) return null
    const isEx = searching ? true : expandedExtra.has(key)
    return (
      <div className="dbt-cat-node">
        <div className="dbt-cat-row">
          <button className="dbt-cat-expand-btn" onClick={() => {
            if (isEx) {
              setExpandedExtra(s => { const n = new Set(s); n.delete(key); return n })
            } else {
              setExpandedExtra(s => new Set([...s, key]))
              doLoadSequences(schema)
            }
          }}>
            <ChevronRight size={10} strokeWidth={2.5} className={`dbt-cat-arrow${isEx ? ' rot90' : ''}`} />
          </button>
          <button className="dbt-cat-label-btn" style={{ cursor: 'default' }}>
            <span className="dbt-cat-label">序列</span>
            <span className="dbt-cat-count">{items.length}</span>
            {isLoad && <Loader2 size={9} className="spin" style={{ marginLeft: 4 }} />}
          </button>
        </div>
        {isEx && (
          <div className="dbt-cat-items">
            {items.map(seq => (
              <div key={seq.sequenceName} className="dbt-routine-row">
                <ListPlus size={11} strokeWidth={1.8} className="dbt-icon--fn" />
                <span className="dbt-item-name">{seq.sequenceName}</span>
                {seq.cycleOption && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 4 }}>CYCLE</span>
                )}
              </div>
            ))}
            {items.length === 0 && !isLoad && !searching && <div className="dbt-empty">暂无序列</div>}
          </div>
        )}
      </div>
    )
  }

  // 已枚举的 + 手动添加的（去重合并）
  const allSchemas = [...schemas, ...manualSchemas.filter(s => !schemas.includes(s))]
  const showManualInput = !loading && !error && allSchemas.length === 0

  // Schema 可见性过滤
  const hiddenSchemas = useSchemaVisibilityStore(s => s.hidden[connectionId] ?? [])
  const visibleSchemas = allSchemas.filter(s => !hiddenSchemas.includes(s))

  return (
    <div className="dbt-conn-tree" onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}>
      {loading && (
        <div className="dbt-conn-tree__loading">
          <Loader2 size={12} className="spin" />
          <span>连接中…</span>
        </div>
      )}

      {error && !loading && (
        <div className="dbt-conn-tree__error">
          <div className="dbt-conn-tree__error-actions">
            <button
              className="dbt-conn-tree__edit-btn"
              onClick={() => {
                const conn = connections.find(c => c.id === connectionId)
                if (conn) openEditConn(conn)
              }}
            >
              <Settings2 size={11} strokeWidth={2} />
              编辑连接
            </button>
            <button className="dbt-conn-tree__retry" onClick={doLoadSchemas}>重试</button>
          </div>
        </div>
      )}

      {showManualInput && (
        <div className="dbt-manual-add">
          <span className="dbt-manual-hint">手动输入数据库名</span>
          <div className="dbt-manual-row">
            <input
              ref={manualRef}
              className="dbt-manual-input"
              placeholder="database name…"
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddManual() }}
            />
            <button className="dbt-manual-btn" onClick={handleAddManual} data-tip="添加">↵</button>
          </div>
        </div>
      )}

      {isSingle && !loading && (
        <div style={{ padding: '4px 8px 2px' }}>
          <button
            className="dbt-manual-btn"
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11, padding: '3px 0', borderRadius: 5 }}
            data-tip="附加另一个 SQLite 文件，跨文件联表查询（ATTACH）"
            onClick={() => { setAttachOpen(true); setAttachAlias(''); setAttachPath(''); setAttachErr('') }}
          >
            <Link size={11} strokeWidth={2} />附加数据库
          </button>
        </div>
      )}

      {/* ── 保存的查询（与 schema 同级，挂在本连接下）── */}
      {!searching && (
        <div className="dbt-schema-node">
          <button className={`dbt-schema-row${savedOpen ? ' active' : ''}`} onClick={() => setSavedOpen(o => !o)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSavedCtx(null); setSavedRootCtx({ x: e.clientX, y: e.clientY }) }}>
            <span className="dbt-schema-arrow-hit" onClick={e => { e.stopPropagation(); setSavedOpen(o => !o) }}>
              <ChevronRight size={11} strokeWidth={2.5} className={`dbt-schema-arrow${savedOpen ? ' rot90' : ''}`} />
            </span>
            <Bookmark size={12} strokeWidth={1.7} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span className="dbt-schema-name">保存的查询</span>
            <span className="dbt-cat-count" style={{ marginLeft: 'auto' }}>{savedQueries.length}</span>
          </button>
          {savedOpen && (
            <div className="dbt-schema-children" style={{ paddingLeft: 22 }}>
              {savedQueries.length === 0
                ? <div className="dbt-empty">暂无保存的查询（在查询页保存后显示）</div>
                : savedQueries.map(q => (
                  <div key={q.id} className="dbt-table-row" title={`${q.name}\n\n${q.sql}`}
                    onDoubleClick={() => openSavedQuery(q)}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSavedRootCtx(null); setSavedCtx({ x: e.clientX, y: e.clientY, q }) }}>
                    <FileCode2 size={11} strokeWidth={1.7} style={{ color: q.connId === '' ? 'var(--text-muted)' : 'var(--accent)', flexShrink: 0 }} />
                    <span className="dbt-item-name">{q.name}{q.connId === '' && <span style={{ color: 'var(--text-muted)', fontSize: 10, marginLeft: 4 }}>全局</span>}</span>
                    <button className="dbt-more-btn" onClick={e => { e.stopPropagation(); setSavedRootCtx(null); setSavedCtx({ x: e.clientX, y: e.clientY, q }) }}>
                      <MoreHorizontal size={11} strokeWidth={2} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {visibleSchemas.map(schema => {
        const data      = schemaData[schema]
        const isManual  = !schemas.includes(schema)
        // 搜索：库名命中则展示其全部子项；否则仅展示名字命中的子项
        const schemaHit = searching && nameHit(schema)
        const filterChild = searching && !schemaHit
        const allTbls  = (data?.tables ?? []).filter(t => !t.isView)
        const allViews = (data?.tables ?? []).filter(t =>  t.isView)
        const allFns   = (data?.routines ?? []).filter(r => r.routineType === 'FUNCTION')
        const allProcs = (data?.routines ?? []).filter(r => r.routineType === 'PROCEDURE')
        const tbls   = filterChild ? allTbls.filter(t => nameHit(t.name))  : allTbls
        const views  = filterChild ? allViews.filter(t => nameHit(t.name)) : allViews
        const fns    = filterChild ? allFns.filter(r => nameHit(r.name))   : allFns
        const procs  = filterChild ? allProcs.filter(r => nameHit(r.name)) : allProcs
        const idxs   = filterChild ? (data?.indexes ?? []).filter(o => nameHit(o.name))   : (data?.indexes ?? [])
        const trigs  = filterChild ? (data?.triggers ?? []).filter(o => nameHit(o.name))  : (data?.triggers ?? [])
        const seqs   = filterChild ? (data?.sequences ?? []).filter(s => nameHit(s.sequenceName)) : (data?.sequences ?? [])
        // 搜索模式下：库名命中或任意子项命中才显示该库，否则整库隐藏
        if (searching && !schemaHit && !(tbls.length || views.length || fns.length || procs.length || idxs.length || trigs.length || seqs.length)) {
          return null
        }
        const isEx = searching ? true : expandedSchemas.has(schema)

        return (
          <div key={schema} className="dbt-schema-node">
            <button
              className={`dbt-schema-row${isEx ? ' active' : ''}`}
              onClick={() => {
                // Redis/Mongo：点击库 → 打开专属浏览器并定位到该库（不展开 SQL 子树）
                if (isKv) { openKvBrowser(schema); return }
                // 点击库行：未展开 → 打开对象浏览标签并展开树；已展开 → 收起树
                if (!expandedSchemas.has(schema)) openCatBrowser(schema, 'tables')
                toggleSchema(schema)
              }}
              onContextMenu={e => {
                e.preventDefault()
                e.stopPropagation()
                // Redis/Mongo 没有 SQL 对象，不弹「新建表/查看 DDL」等无意义菜单
                if (!isKv) setSchemaCtx({ x: e.clientX, y: e.clientY, schema })
              }}
            >
              {!isKv ? (
                <span
                  className="dbt-schema-arrow-hit"
                  onClick={e => { e.stopPropagation(); toggleSchema(schema) }}
                >
                  <ChevronRight
                    size={11} strokeWidth={2.5}
                    className={`dbt-schema-arrow${isEx ? ' rot90' : ''}`}
                  />
                </span>
              ) : (
                // Redis/Mongo 库节点不展开，但保留等宽占位箭头，使其与「保存的查询」等同级行左对齐
                <span className="dbt-schema-arrow-hit" style={{ visibility: 'hidden' }}>
                  <ChevronRight size={11} strokeWidth={2.5} className="dbt-schema-arrow" />
                </span>
              )}
              {isSingle && attachedSet.has(schema)
                ? <Link size={12} strokeWidth={1.5} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                : <Database size={12} strokeWidth={1.5} className="dbt-icon--db" />}
              <span className="dbt-schema-name">
                {isSingle ? (schema === 'main' ? '(main)' : schema) : schema}
              </span>
              {defaultSchema && schema === defaultSchema && (
                <span className="dbt-schema-default">默认</span>
              )}
              {loadingSchema === schema && <Loader2 size={10} className="spin" style={{ marginLeft: 4 }} />}
              {isManual && (
                <button
                  className="dbt-schema-remove"
                  onClick={e => { e.stopPropagation(); removeManualSchema(schema) }}
                >×</button>
              )}
            </button>

            {!isKv && isEx && (
              <div className="dbt-schema-children">
                {isSqlServer
                  ? renderSsSchemaLevel(schema)
                  : (
                    <>
                      {renderCat(schema, 'tables', tbls)}
                      {renderCat(schema, 'views', views)}
                      {isSingle && !isDuck
                        ? renderSqliteExtraCat(schema, 'indexes', idxs)
                        : (!isSingle && !hideRoutines ? renderCat(schema, 'functions', fns) : null)
                      }
                      {isSingle && !isDuck
                        ? renderSqliteExtraCat(schema, 'triggers', trigs)
                        : (!isSingle && !hideRoutines ? renderCat(schema, 'procedures', procs) : null)
                      }
                      {showSequences && renderMariaSequencesCat(schema, seqs)}
                    </>
                  )
                }
              </div>
            )}
          </div>
        )
      })}

      {/* ── 用户与权限（放在所有 schema 之后、树末尾；点击打开管理面板）── */}
      {!searching && supportsUsers && (
        <div className="dbt-schema-node">
          <button className="dbt-schema-row" onClick={() => setShowUsers(true)}>
            <span className="dbt-schema-arrow-hit" style={{ visibility: 'hidden' }}>
              <ChevronRight size={11} strokeWidth={2.5} className="dbt-schema-arrow" />
            </span>
            <Users size={12} strokeWidth={1.7} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span className="dbt-schema-name">用户与权限</span>
          </button>
        </div>
      )}

      {/* ── DBA 面板（总览六 tab + 变量/状态、事务监控、主从复制、MGR、死锁历史、Perf Schema、实例仪表盘 等监控诊断 tab）── */}
      {!searching && !isKv && (
        <div className="dbt-schema-node">
          <button className="dbt-schema-row"
            onClick={() => useDbToolsStore.getState().openTool('dbaPanel', { connectionId, connType, schema: schemas[0] ?? '' })}>
            <span className="dbt-schema-arrow-hit" style={{ visibility: 'hidden' }}>
              <ChevronRight size={11} strokeWidth={2.5} className="dbt-schema-arrow" />
            </span>
            <Gauge size={12} strokeWidth={1.7} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span className="dbt-schema-name">DBA 面板</span>
          </button>
        </div>
      )}
      {/* ── 高级工具：各类型专属运维工具已整合进「DBA 面板」的「专属工具▾」下拉；
            此处仅为 Redis（无 DBA 面板）保留入口 ── */}
      {!searching && isKv && (
        <DbToolsEntry connectionId={connectionId} connType={connType} schema={schemas[0] ?? ''}
          cat="advanced" label="高级工具" icon={<Star size={12} strokeWidth={1.7} />} />
      )}

      {schemaCtx && createPortal(
        <div
          ref={schemaCtxRef}
          className="db-ctx-menu"
          style={{ position: 'fixed', top: schemaCtxPos?.top ?? schemaCtx.y, left: schemaCtxPos?.left ?? schemaCtx.x, visibility: schemaCtxPos ? 'visible' : 'hidden' }}
        >
          <button onClick={() => {
            openSchemaQuery(undefined, schemaCtx.schema)
            setSchemaCtx(null)
          }}>
            <Terminal size={12} strokeWidth={1.8} />新建查询
          </button>
          <button onClick={() => {
            openCatBrowser(schemaCtx.schema, 'tables')
            setSchemaCtx(null)
          }}>
            <LayoutGrid size={12} strokeWidth={1.8} />打开对象列表
          </button>
          <button onClick={() => {
            doLoadTables(schemaCtx.schema)
            setSchemaCtx(null)
          }}>
            <RefreshCw size={12} strokeWidth={1.8} />刷新
          </button>
          {clipboard && (
            <button onClick={() => { doPaste(schemaCtx.schema); setSchemaCtx(null) }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ClipboardPaste size={12} strokeWidth={1.8} />粘贴 “{clipboard.name}”</span>
              <span className="ctx-item__shortcut">{modLabel()}-V</span>
            </button>
          )}
          <div className="db-ctx-menu__sep" />
          <button onClick={() => {
            setCreateTableSchema(schemaCtx.schema)
            setSchemaCtx(null)
          }}>
            <FilePlus size={12} strokeWidth={1.8} />新建表
          </button>
          {/* Oracle 无 CREATE DATABASE 概念，隐藏此项 */}
          {connType !== 'oracle' && (
          <button onClick={() => {
            setCreateDbOpen(true); setCreateDbName(''); setCreateDbErr(''); setCreateDbCollation(''); setCreateDbCollations([])
            setSchemaCtx(null)
          }}>
            <Plus size={12} strokeWidth={1.8} />新建数据库
          </button>
          )}
          <div className="db-ctx-menu__sep" />
          {/* 导出数据走 db_logical_backup，仅支持 MySQL 族 / PG 族 */}
          {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss'].includes(connType) && (
          <button onClick={() => {
            openCatBrowser(schemaCtx.schema, 'tables')
            openDbTool(connectionId, schemaCtx.schema, 'backup')
            setSchemaCtx(null)
          }}>
            <Download size={12} strokeWidth={1.8} />导出数据
          </button>
          )}
          {/* 导入数据走 db_import_csv / db_exec_sql_file，仅支持 MySQL 族 / PG 族 / sqlite / duckdb */}
          {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'].includes(connType) && (
          <button onClick={() => importSchemaSql(schemaCtx.schema)}>
            <Upload size={12} strokeWidth={1.8} />导入数据
          </button>
          )}
          <button onClick={() => {
            openCatBrowser(schemaCtx.schema, 'tables')
            openDbTool(connectionId, schemaCtx.schema, 'migrate')
            setSchemaCtx(null)
          }}>
            <ArrowRightLeft size={12} strokeWidth={1.8} />迁移向导
          </button>
          <button onClick={() => {
            openCatBrowser(schemaCtx.schema, 'tables')
            openDbTool(connectionId, schemaCtx.schema, 'structDiff')
            setSchemaCtx(null)
          }}>
            <GitCompare size={12} strokeWidth={1.8} />结构对比
          </button>
          <button onClick={() => { setDictTarget({ schema: schemaCtx.schema }); setSchemaCtx(null) }}>
            <BookOpen size={12} strokeWidth={1.8} />生成数据字典
          </button>
          <div className="db-ctx-menu__sep" />
          <button onClick={() => {
            copyText(schemaCtx.schema)
            setSchemaCtx(null)
          }}>
            <ClipboardCopy size={12} strokeWidth={1.8} />复制数据库名
          </button>
          {isSingle && attachedSet.has(schemaCtx.schema) && (<>
            <div className="db-ctx-menu__sep" />
            <button className="db-ctx-menu__item--danger" onClick={() => {
              doDetach(schemaCtx.schema)
              setSchemaCtx(null)
            }}>
              <Unlink size={12} strokeWidth={1.8} />断开附加库
            </button>
          </>)}
          {/* Oracle 无 DROP DATABASE；isSingle(SQLite/DuckDB) 也不支持 */}
          {!isSingle && connType !== 'oracle' && (<>
          <div className="db-ctx-menu__sep" />
          <button className="db-ctx-menu__item--danger" onClick={() => {
            setDropDbTarget(schemaCtx.schema); setDropDbInput(''); setDropDbError('')
            setSchemaCtx(null)
          }}>
            <Trash2 size={12} strokeWidth={1.8} />删除数据库
          </button>
          </>)}
        </div>,
        document.body
      )}

      {dictTarget && (
        <DataDictPanel
          connectionId={connectionId}
          schema={dictTarget.schema}
          tables={dictTarget.tables}
          connName={connections.find(c => c.id === connectionId)?.name}
          onClose={() => setDictTarget(null)}
        />
      )}

      {ctxMenu && createPortal(
        <div
          ref={ctxRef}
          className="db-ctx-menu"
          style={{ position: 'fixed', top: ctxPos?.top ?? ctxMenu.y, left: ctxPos?.left ?? ctxMenu.x, visibility: ctxPos ? 'visible' : 'hidden' }}
        >
          {/* 数据 / 查询 区 */}
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => { onOpenTable(ctxMenu.schema, ctxMenu.table); closeMenu() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Table2 size={12} strokeWidth={1.8} />打开{ctxMenu.isView ? '视图' : '表'}数据</span>
            <span className="ctx-item__shortcut">{ctxMenu.isView ? `${modLabel()}-双击` : '双击'}</span>
          </button>
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => {
            openSchemaFill(connType === 'oracle'
              ? `SELECT * FROM ${tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)} FETCH FIRST 100 ROWS ONLY;`
              : connType === 'sqlServer'
                ? `SELECT TOP 100 * FROM ${tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)};`
                : `SELECT * FROM ${tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)} LIMIT 100;`)
            closeMenu()
          }}>
            <Terminal size={12} strokeWidth={1.8} />查询此{ctxMenu.isView ? '视图' : '表'}
          </button>
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => {
            setInfoTarget({ schema: ctxMenu.schema, table: ctxMenu.table, isView: ctxMenu.isView }); closeMenu()
          }}>
            <Info size={12} strokeWidth={1.8} />表信息
          </button>
          <div className="db-ctx-menu__sep" />
          {/* 查看 / 复制 区 */}
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => { openDdl(ctxMenu.schema, ctxMenu.table); closeMenu() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Code2 size={12} strokeWidth={1.8} />查看 DDL</span>
            {sc('dbObjDdl') && <span className="ctx-item__shortcut">{sc('dbObjDdl')}</span>}
          </button>
          {ctxMenu.isView && (
            <button onMouseEnter={() => setSubOpen(null)} onClick={() => { openEditObject({ connectionId, connType, schema: ctxMenu.schema, objType: 'view', name: ctxMenu.table }); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />编辑视图</span>
              <span className="ctx-item__shortcut">双击</span>
            </button>
          )}
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => {
            doCopy({ connectionId, connType, schema: ctxMenu.schema, objType: ctxMenu.isView ? 'view' : 'table', name: ctxMenu.table }); closeMenu()
          }} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Copy size={12} strokeWidth={1.8} />复制</span>
            <span className="ctx-item__shortcut">{modLabel()}-C</span>
          </button>
          {!ctxMenu.isView && (
            <button onMouseEnter={() => setSubOpen(null)} onClick={() => { setDictTarget({ schema: ctxMenu.schema, tables: [ctxMenu.table] }); closeMenu() }}>
              <BookOpen size={12} strokeWidth={1.8} />数据字典
            </button>
          )}
          <div className="db-ctx-menu__sep" />
          {/* 结构 区 */}
          {!ctxMenu.isView && (
            <button onMouseEnter={() => setSubOpen(null)} onClick={() => {
              setEditTable({ schema: ctxMenu.schema, table: ctxMenu.table })
              closeMenu()
            }} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Settings2 size={12} strokeWidth={1.8} />修改表结构…</span>
              {sc('dbObjStructure') && <span className="ctx-item__shortcut">{sc('dbObjStructure')}</span>}
            </button>
          )}
          {clipboard && (
            <button onMouseEnter={() => setSubOpen(null)} onClick={() => { doPaste(ctxMenu.schema); closeMenu() }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ClipboardPaste size={12} strokeWidth={1.8} />粘贴 “{clipboard.name}”</span>
              <span className="ctx-item__shortcut">{modLabel()}-V</span>
            </button>
          )}
          <button onMouseEnter={() => setSubOpen(null)} onClick={() => {
            setRenameTarget({ schema: ctxMenu.schema, table: ctxMenu.table, isView: ctxMenu.isView })
            setRenameInput(ctxMenu.table); setRenameErr('')
            closeMenu()
          }} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />重命名…</span>
            {sc('dbObjRename') && <span className="ctx-item__shortcut">{sc('dbObjRename')}</span>}
          </button>
          {!ctxMenu.isView && supportsMyMaintenance(connType) && (
            <>
              <div className="db-ctx-menu__sep" />
              {/* 维护 ▸ 子菜单（OPTIMIZE/ANALYZE/CHECK TABLE 仅 MySQL 系） */}
              <button className={`db-ctx-menu__sub-trigger${subOpen?.key === 'maint' ? ' on' : ''}`}
                onMouseEnter={e => openSub('maint', e, 3)} onMouseLeave={closeSub}>
                <Wand2 size={12} strokeWidth={1.8} />维护
                <ChevronRight size={13} className="db-ctx-menu__chev" />
              </button>
            </>
          )}
          <div className="db-ctx-menu__sep" />
          {!ctxMenu.isView && (
            <button className="db-ctx-menu__item--danger" onMouseEnter={() => setSubOpen(null)} onClick={() => {
              setTblDanger({ kind: 'truncate', schema: ctxMenu.schema, table: ctxMenu.table, isView: false })
              setTblDangerInput(''); setTblDangerErr('')
              closeMenu()
            }}>
              <Eraser size={12} strokeWidth={1.8} />清空表
            </button>
          )}
          <button className="db-ctx-menu__item--danger" onMouseEnter={() => setSubOpen(null)} onClick={() => {
            setTblDanger({ kind: 'drop', schema: ctxMenu.schema, table: ctxMenu.table, isView: ctxMenu.isView })
            setTblDangerInput(''); setTblDangerErr('')
            closeMenu()
          }}>
            <Trash2 size={12} strokeWidth={1.8} />删除{ctxMenu.isView ? '视图' : '表'}
          </button>
        </div>,
        document.body
      )}

      {/* 表菜单的级联子菜单 */}
      {ctxMenu && subOpen && createPortal(
        <div ref={subRef} className="db-ctx-menu db-ctx-submenu"
          style={{ position: 'fixed', top: subOpen.top, left: subOpen.left }}
          onMouseEnter={keepSub} onMouseLeave={closeSub}>
          {subOpen.key === 'maint' && <>
            {supportsOptimizeTable(connType) && (
              <button onClick={() => {
                openAction('优化表', `对表 ${ctxMenu.table} 执行 OPTIMIZE TABLE（重建表与索引，回收碎片空间）`,
                  `OPTIMIZE TABLE ${tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)};`)
                closeMenu()
              }}>
                <Wand2 size={12} strokeWidth={1.8} />优化表
              </button>
            )}
            <button onClick={() => {
              openAction('分析表', `对表 ${ctxMenu.table} 执行 ANALYZE TABLE（重新统计索引分布，优化查询计划）`,
                `ANALYZE TABLE ${tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)};`)
              closeMenu()
            }}>
              <Gauge size={12} strokeWidth={1.8} />分析表
            </button>
            <button onClick={() => {
              const ref = tableRef(connType, ctxMenu.schema, ctxMenu.table, ctxMenu.ssSchema)
              openAction('检查表', `对表 ${ctxMenu.table} 执行${connType === 'tidb' ? ' ADMIN CHECK TABLE' : ' CHECK TABLE'}（检查表与索引完整性）`,
                `${checkTableSql(connType, ref)};`)
              closeMenu()
            }}>
              <ShieldCheck size={12} strokeWidth={1.8} />检查表
            </button>
          </>}
        </div>,
        document.body
      )}

      {routineCtx && createPortal(
        <div ref={routineCtxRef} className="db-ctx-menu"
          style={{ position: 'fixed', top: Math.min(routineCtx.y, window.innerHeight - 150), left: Math.min(routineCtx.x, window.innerWidth - 200) }}>
          <button onClick={() => { openEditObject({ connectionId, connType, schema: routineCtx.schema, objType: routineCtx.kind, name: routineCtx.name }); setRoutineCtx(null) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={12} strokeWidth={1.8} />编辑{routineCtx.kind === 'function' ? '函数' : '存储过程'}</span>
            <span className="ctx-item__shortcut">双击</span>
          </button>
          {supportsShowStatements(connType) && (
            <button onClick={() => { openSchemaFill(`SHOW CREATE ${routineCtx.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${tableRef(connType, routineCtx.schema, routineCtx.name)};`); setRoutineCtx(null) }}>
              <Terminal size={12} strokeWidth={1.8} />在查询页查看定义
            </button>
          )}
          <div className="db-ctx-menu__sep" />
          <button onClick={() => {
            doCopy({ connectionId, connType, schema: routineCtx.schema, objType: routineCtx.kind, name: routineCtx.name }); setRoutineCtx(null)
          }} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Copy size={12} strokeWidth={1.8} />复制</span>
            <span className="ctx-item__shortcut">{modLabel()}-C</span>
          </button>
        </div>,
        document.body
      )}

      {catCtx && createPortal(
        <div
          ref={catCtxRef}
          className="db-ctx-menu"
          style={{ position: 'fixed', top: catCtxPos?.top ?? catCtx.y, left: catCtxPos?.left ?? catCtx.x, visibility: catCtxPos ? 'visible' : 'hidden' }}
        >
          {catCtx.cat === 'tables' && (
            <button onClick={() => { setCreateTableSchema(catCtx.schema); setCatCtx(null) }}>
              <FilePlus size={12} strokeWidth={1.8} />新建表
            </button>
          )}
          {catCtx.cat === 'views' && (
            <button onClick={() => { setViewWizard(catCtx.schema); setCatCtx(null) }}>
              <FilePlus size={12} strokeWidth={1.8} />新建视图
            </button>
          )}
          {catCtx.cat === 'functions' && (
            <button onClick={() => { setRoutineWizard({ schema: catCtx.schema, kind: 'function' }); setCatCtx(null) }}>
              <FilePlus size={12} strokeWidth={1.8} />新建函数
            </button>
          )}
          {catCtx.cat === 'procedures' && (
            <button onClick={() => { setRoutineWizard({ schema: catCtx.schema, kind: 'procedure' }); setCatCtx(null) }}>
              <FilePlus size={12} strokeWidth={1.8} />新建存储过程
            </button>
          )}
          <button onClick={() => {
            // MySQL 系用 USE 切库；PG 系用 SET search_path；SQLite/DuckDB 等无切库概念 → 仅带过 schema 上下文
            const fam = dialectFamily(connType)
            const useSql = fam === 'mysql'
              ? `USE ${qid(connType, catCtx.schema)};`
              : fam === 'postgres'
                ? `SET search_path TO ${qid(connType, catCtx.schema)};`
                : undefined
            openSchemaQuery(useSql, catCtx.schema)
            setCatCtx(null)
          }}>
            <Terminal size={12} strokeWidth={1.8} />新建查询
          </button>
          <button onClick={() => {
            openCatBrowser(catCtx.schema, catCtx.cat)
            setCatCtx(null)
          }}>
            <LayoutGrid size={12} strokeWidth={1.8} />打开对象列表
          </button>
          <div className="db-ctx-menu__sep" />
          <button onClick={() => {
            if (catCtx.cat === 'tables' || catCtx.cat === 'views') doLoadTables(catCtx.schema)
            else doLoadRoutines(catCtx.schema, true)
            setCatCtx(null)
          }}>
            <RefreshCw size={12} strokeWidth={1.8} />刷新
          </button>
          {clipboard && (
            <>
              <div className="db-ctx-menu__sep" />
              <button onClick={() => { doPaste(catCtx.schema); setCatCtx(null) }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ClipboardPaste size={12} strokeWidth={1.8} />粘贴 “{clipboard.name}”</span>
                <span className="ctx-item__shortcut">{modLabel()}-V</span>
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* ── 保存的查询 右键菜单 ── */}
      {savedCtx && createPortal(
        <div className="db-ctx-menu"
          style={{ position: 'fixed', top: Math.min(savedCtx.y, window.innerHeight - 140), left: Math.min(savedCtx.x, window.innerWidth - 200) }}>
          <button onClick={() => { openSavedQuery(savedCtx.q); setSavedCtx(null) }}>
            <Terminal size={12} strokeWidth={1.8} />在查询页打开
          </button>
          <button onClick={() => { copyText(savedCtx.q.sql); setSavedCtx(null) }}>
            <Copy size={12} strokeWidth={1.8} />复制 SQL
          </button>
          <button onClick={() => { const q = savedCtx.q; setSavedCtx(null); exportSavedQuery(q) }}>
            <Download size={12} strokeWidth={1.8} />导出 SQL 文件
          </button>
          <button onClick={() => { setRenameQuery(savedCtx.q); setRenameQueryInput(savedCtx.q.name); setSavedCtx(null) }}>
            <Pencil size={12} strokeWidth={1.8} />重命名
          </button>
          <div className="db-ctx-menu__sep" />
          <button className="db-ctx-menu__item--danger" onClick={() => { deleteSavedQuery(savedCtx.q.id); setSavedCtx(null) }}>
            <Trash2 size={12} strokeWidth={1.8} />删除
          </button>
        </div>,
        document.body
      )}

      {/* ── 保存的查询「根节点」右键菜单：批量导出 ── */}
      {savedRootCtx && createPortal(
        <div className="db-ctx-menu"
          style={{ position: 'fixed', top: Math.min(savedRootCtx.y, window.innerHeight - 80), left: Math.min(savedRootCtx.x, window.innerWidth - 220) }}>
          <button disabled={savedQueries.length === 0}
            onClick={() => { setSavedRootCtx(null); exportAllSavedQueries() }}>
            <Download size={12} strokeWidth={1.8} />导出全部 SQL（{savedQueries.length} 条）
          </button>
        </div>,
        document.body
      )}

      {/* ── 重命名保存的查询 ── */}
      {renameQuery && createPortal(
        <div className="modal-overlay" onMouseDown={() => setRenameQuery(null)}>
          <div className="modal-box modal-box--sm" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">重命名查询</span>
              <button className="modal-close" onClick={() => setRenameQuery(null)}>✕</button>
            </div>
            <div className="modal-body">
              <input className="dbtool-input" style={{ width: '100%' }} value={renameQueryInput} autoFocus
                onChange={e => setRenameQueryInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && renameQueryInput.trim()) { renameSavedQuery(renameQuery.id, renameQueryInput); setRenameQuery(null) } }} />
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setRenameQuery(null)}>取消</button>
                  <button style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: renameQueryInput.trim() ? 1 : 0.4 }}
                    disabled={!renameQueryInput.trim()}
                    onClick={() => { renameSavedQuery(renameQuery.id, renameQueryInput); setRenameQuery(null) }}>确定</button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 新建数据库弹窗 ── */}
      {createDbOpen && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title">新建数据库</span>
              <button className="modal-close" onClick={() => setCreateDbOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
                数据库名
                <input value={createDbName} autoFocus
                  autoComplete="off" autoCorrect="off" spellCheck={false}
                  placeholder="database_name"
                  onChange={e => setCreateDbName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && createDbName.trim()) (document.getElementById('dbt-createdb-ok') as HTMLButtonElement)?.click() }} />
              </div>
              {/* 字符集 / 排序规则：仅 MySQL 系建库时可设置 */}
              {isMysqlFamily(connType) && (<>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
                字符集
                <SearchableSelect value={createDbCharset} onChange={setCreateDbCharset}
                  options={['utf8mb4', 'utf8mb3', 'gbk', 'gb18030', 'gb2312', 'big5', 'latin1', 'ascii', 'binary',
                    'utf16', 'utf16le', 'utf32', 'ucs2', 'cp932', 'eucjpms', 'euckr', 'cp1250', 'cp1251',
                    'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866', 'koi8r', 'koi8u', 'macroman', 'macce',
                  ]} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
                排序规则
                <SearchableSelect value={createDbCollation} onChange={setCreateDbCollation}
                  disabled={createDbCollations.length === 0}
                  placeholder={createDbCollations.length === 0 ? '加载中…' : '选择…'}
                  options={createDbCollations} />
              </div>
              </>)}
              {createDbErr && <span style={{ color: 'var(--error)', fontSize: 13 }}>{createDbErr}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setCreateDbOpen(false)} disabled={createDbBusy}>取消</button>
                  <button id="dbt-createdb-ok"
                    style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: createDbName.trim() ? 1 : 0.4 }}
                    disabled={!createDbName.trim() || createDbBusy}
                    onClick={async () => {
                      setCreateDbBusy(true); setCreateDbErr('')
                      const dbName = createDbName.trim()
                      try {
                        const { invoke } = await import('@tauri-apps/api/core')
                        // MySQL 系：CREATE DATABASE … DEFAULT CHARACTER SET … COLLATE …
                        // 其它（PG 等）：CREATE DATABASE "name"（不带 charset/collate 子句）
                        const createSql = isMysqlFamily(connType)
                          ? `CREATE DATABASE ${qid(connType, dbName)} DEFAULT CHARACTER SET ${createDbCharset}${createDbCollation ? ` COLLATE ${createDbCollation}` : ''}`
                          : `CREATE DATABASE ${qid(connType, dbName)}`
                        await invoke('execute_query', { id: connectionId, sql: createSql })
                        setCreateDbOpen(false)
                        doLoadSchemas()
                        toast.success(`已创建数据库 ${dbName}`)
                      } catch (e) { setCreateDbErr(String(e)); toast.error(`创建数据库失败：${String(e)}`) }
                      finally { setCreateDbBusy(false) }
                    }}>
                    {createDbBusy ? '执行中…' : '创建'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 重命名表/视图弹窗 ── */}
      {renameTarget && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title">重命名{renameTarget.isView ? '视图' : '表'}</span>
              <button className="modal-close" onClick={() => setRenameTarget(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                {renameTarget.schema} / <strong style={{ color: 'var(--text)' }}>{renameTarget.table}</strong>
              </p>
              <input value={renameInput} autoFocus
                autoComplete="off" autoCorrect="off" spellCheck={false}
                placeholder="新名称"
                onChange={e => setRenameInput(e.target.value)} />
              {renameErr && <span style={{ color: 'var(--error)', fontSize: 13 }}>{renameErr}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setRenameTarget(null)} disabled={renameBusy}>取消</button>
                  <button
                    style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: renameInput.trim() && renameInput.trim() !== renameTarget.table ? 1 : 0.4 }}
                    disabled={!renameInput.trim() || renameInput.trim() === renameTarget.table || renameBusy}
                    onClick={async () => {
                      setRenameBusy(true); setRenameErr('')
                      const oldName = renameTarget.table, newName = renameInput.trim()
                      try {
                        const { invoke } = await import('@tauri-apps/api/core')
                        const fromRef = tableRef(connType, renameTarget.schema, renameTarget.table)
                        const renameSql = isMysqlFamily(connType)
                          ? `RENAME TABLE ${fromRef} TO ${tableRef(connType, renameTarget.schema, newName)}`
                          : connType === 'oracle'
                            ? `RENAME ${qid(connType, oldName)} TO ${qid(connType, newName)}`
                            : connType === 'sqlServer'
                              ? `EXEC sp_rename '${renameTarget.schema}.${oldName.replace(/'/g, "''")}', '${newName.replace(/'/g, "''")}', 'OBJECT'`
                              : `ALTER TABLE ${fromRef} RENAME TO ${qid(connType, newName)}`
                        await invoke('execute_query', { id: connectionId, sql: renameSql })
                        const s = renameTarget.schema
                        setRenameTarget(null)
                        doLoadTables(s)
                        toast.success(`已重命名为 ${newName}`)
                      } catch (e) { setRenameErr(String(e)); toast.error(`重命名 ${oldName} 失败：${String(e)}`) }
                      finally { setRenameBusy(false) }
                    }}>
                    {renameBusy ? '执行中…' : '重命名'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 清空/删除 表（视图）强确认弹窗 ── */}
      {tblDanger && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title" style={{ color: tblDanger.kind === 'drop' ? 'var(--error)' : 'var(--warning)' }}>
                {tblDanger.kind === 'truncate' ? 'TRUNCATE 清空表' : `DROP 删除${tblDanger.isView ? '视图' : '表'}`}
              </span>
              <button className="modal-close" onClick={() => setTblDanger(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
                {tblDanger.kind === 'truncate'
                  ? <>此操作将清空表 <strong style={{ color: 'var(--warning)' }}>{tblDanger.table}</strong> 的全部数据（保留结构），无法恢复。</>
                  : <>此操作将永久删除{tblDanger.isView ? '视图' : '表'} <strong style={{ color: 'var(--error)' }}>{tblDanger.table}</strong>{tblDanger.isView ? '' : ' 及其全部数据'}，无法恢复。</>}
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                请输入名称 <strong>{tblDanger.table}</strong> 确认：
              </p>
              <input value={tblDangerInput} onChange={e => setTblDangerInput(e.target.value)}
                placeholder={tblDanger.table} autoFocus
                autoComplete="off" autoCorrect="off" spellCheck={false} />
              {tblDangerErr && <span style={{ color: 'var(--error)', fontSize: 13 }}>{tblDangerErr}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setTblDanger(null)} disabled={tblDangerBusy}>取消</button>
                  <button
                    style={{ background: tblDanger.kind === 'drop' ? 'var(--error)' : 'var(--warning)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: tblDangerInput === tblDanger.table ? 1 : 0.4 }}
                    disabled={tblDangerInput !== tblDanger.table || tblDangerBusy}
                    onClick={async () => {
                      setTblDangerBusy(true); setTblDangerErr('')
                      const isTrunc = tblDanger.kind === 'truncate'
                      const tname = tblDanger.table
                      try {
                        const { invoke } = await import('@tauri-apps/api/core')
                        const ref = tableRef(connType, tblDanger.schema, tblDanger.table)
                        // SQLite 无 TRUNCATE TABLE → 退化为 DELETE FROM（清空数据，保留结构）
                        const truncSql = dialectFamily(connType) === 'sqlite'
                          ? `DELETE FROM ${ref}`
                          : `TRUNCATE TABLE ${ref}`
                        const sql = isTrunc
                          ? truncSql
                          : tblDanger.isView ? `DROP VIEW ${ref}` : `DROP TABLE ${ref}`
                        await invoke('execute_query', { id: connectionId, sql })
                        const s = tblDanger.schema
                        setTblDanger(null); setTblDangerInput('')
                        doLoadTables(s)
                        toast.success(isTrunc ? `已清空表 ${tname}` : `已删除${tblDanger.isView ? '视图' : '表'} ${tname}`)
                      } catch (e) {
                        setTblDangerErr(String(e))
                        toast.error(`${isTrunc ? '清空' : '删除'} ${tname} 失败：${String(e)}`)
                      }
                      finally { setTblDangerBusy(false) }
                    }}>
                    {tblDangerBusy ? '执行中…' : tblDanger.kind === 'truncate' ? '确认清空' : '永久删除'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 删除数据库强确认弹窗 ── */}
      {dropDbTarget && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--sm">
            <div className="modal-header">
              <span className="modal-title" style={{ color: 'var(--error)' }}>DROP 删除数据库</span>
              <button className="modal-close" onClick={() => setDropDbTarget(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
                此操作将永久删除数据库 <strong style={{ color: 'var(--error)' }}>{dropDbTarget}</strong> 及其全部表和数据，无法恢复。
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                请输入数据库名 <strong>{dropDbTarget}</strong> 确认删除：
              </p>
              <input value={dropDbInput} onChange={e => setDropDbInput(e.target.value)}
                placeholder={dropDbTarget} autoFocus />
              {dropDbError && <span style={{ color: 'var(--error)', fontSize: 13 }}>{dropDbError}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setDropDbTarget(null)} disabled={dropDbBusy}>取消</button>
                  <button
                    style={{ background: 'var(--error)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: dropDbInput === dropDbTarget ? 1 : 0.4 }}
                    disabled={dropDbInput !== dropDbTarget || dropDbBusy}
                    onClick={async () => {
                      if (!dropDbTarget) return
                      setDropDbBusy(true); setDropDbError('')
                      const dbName = dropDbTarget
                      try {
                        const { invoke } = await import('@tauri-apps/api/core')
                        await invoke('execute_query', { id: connectionId, sql: `DROP DATABASE ${qid(connType, dropDbTarget)}` })
                        removeManualSchema(dropDbTarget)
                        setSchemas(s => s.filter(x => x !== dropDbTarget))
                        setDropDbTarget(null); setDropDbInput('')
                        toast.success(`已删除数据库 ${dbName}`)
                      } catch (e) {
                        setDropDbError(String(e)); toast.error(`删除数据库 ${dbName} 失败：${String(e)}`)
                      } finally { setDropDbBusy(false) }
                    }}>
                    {dropDbBusy ? '执行中…' : '永久删除'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── 新建表设计器 ── */}
      {createTableSchema && (
        <CreateTableWizard
          connectionId={connectionId}
          connType={connType}
          schema={createTableSchema}
          onClose={() => setCreateTableSchema(null)}
          onDone={() => doLoadTables(createTableSchema)}
        />
      )}

      {/* ── 新建视图向导 ── */}
      {viewWizard !== null && (
        <ViewWizard
          connectionId={connectionId}
          connType={connType}
          schema={viewWizard}
          onClose={() => setViewWizard(null)}
        />
      )}

      {/* ── 新建函数/存储过程向导 ── */}
      {routineWizard && (
        <RoutineWizard
          connectionId={connectionId}
          connType={connType}
          schema={routineWizard.schema}
          kind={routineWizard.kind}
          onClose={() => setRoutineWizard(null)}
        />
      )}

      {/* ── 修改表结构（建表设计器编辑模式 / SQLite 专属向导） ── */}
      {editTable && (
        isSingle
          ? <AlterTableWizard
              connectionId={connectionId}
              schema={editTable.schema}
              table={editTable.table}
              connType={connType}
              onClose={() => setEditTable(null)}
              onDone={() => doLoadTables(editTable.schema)}
            />
          : <CreateTableWizard
              connectionId={connectionId}
              connType={connType}
              schema={editTable.schema}
              editTable={editTable.table}
              onClose={() => setEditTable(null)}
              onDone={() => doLoadTables(editTable.schema)}
            />
      )}

      {ddlState && (
        <DdlModal
          schema={ddlState.schema}
          table={ddlState.table}
          ddl={ddlState.ddl}
          loading={ddlState.loading}
          error={ddlState.error}
          connType={connType}
          connectionId={connectionId}
          onClose={() => setDdlState(null)}
        />
      )}

      {infoTarget && (
        <TableInfoModal connectionId={connectionId} connType={connType}
          schema={infoTarget.schema} name={infoTarget.table} isView={infoTarget.isView}
          onClose={() => setInfoTarget(null)} />
      )}

      {/* 命令型操作确认执行弹窗 */}
      {actionDlg && createPortal(
        <div className="modal-overlay">
          <div className="modal-box modal-box--md">
            <div className="modal-header">
              <span className="modal-title">{actionDlg.title}</span>
              <button className="modal-close" onClick={() => { if (!actionBusy) setActionDlg(null) }}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{actionDlg.desc}</div>
              <pre className="dbt-action-sql">{actionDlg.sql}</pre>
              {actionErr && <div style={{ color: 'var(--error)', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{actionErr}</div>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setActionDlg(null)} disabled={actionBusy}>取消</button>
                  <button
                    style={{ background: actionDlg.danger ? 'var(--error)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: actionBusy ? 0.6 : 1 }}
                    disabled={actionBusy}
                    onClick={runActionSql}>
                    {actionBusy ? '执行中…' : '执行'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* SQLite ATTACH 弹窗 */}
      {attachOpen && createPortal(
        <div className="modal-overlay" onMouseDown={() => setAttachOpen(false)}>
          <div className="modal-box modal-box--sm" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">附加 {isDuck ? 'DuckDB' : 'SQLite'} 数据库</span>
              <button className="modal-close" onClick={() => setAttachOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                把另一个 {isDuck ? 'DuckDB' : 'SQLite'} 文件「挂载」到当前连接（{isDuck ? 'ATTACH' : 'ATTACH DATABASE'}），之后可在 SQL 里用
                <code style={{ color: 'var(--accent)', margin: '0 3px' }}>别名.表名</code>
                跨文件联表查询。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 'var(--fw-medium)' }}>别名（SQL 中引用）</label>
                <input className="dbtool-input" placeholder="例如 other_db" value={attachAlias} autoFocus
                  onChange={e => setAttachAlias(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && doAttach()} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 'var(--fw-medium)' }}>{isDuck ? 'DuckDB' : 'SQLite'} 文件路径</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="dbtool-input" style={{ flex: 1 }} placeholder={isDuck ? '/path/to/other.duckdb' : '/path/to/other.sqlite'} value={attachPath}
                    onChange={e => setAttachPath(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && doAttach()} />
                  <button className="dbtool-input" data-tip="浏览文件" onClick={pickAttachFile}
                    style={{ width: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)' }}>
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>
              {attachErr && <span style={{ fontSize: 12.5, color: 'var(--error)' }}>{attachErr}</span>}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <div />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-cancel" onClick={() => setAttachOpen(false)}>取消</button>
                  <button onClick={doAttach} disabled={attachBusy}
                    style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, opacity: attachBusy ? 0.6 : 1 }}>
                    {attachBusy ? <Loader2 size={12} className="spin" /> : <Link size={12} />}附加
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 用户与权限管理面板：Oracle 用专属面板（左用户右权限），其余用通用 UsersPanel */}
      {showUsers && (
        isOracle
          ? <OracleUsersPanel connectionId={connectionId} onClose={() => setShowUsers(false)} />
          : <UsersPanel connectionId={connectionId} connType={connType} onClose={() => setShowUsers(false)} />
      )}

    </div>
  )
}
