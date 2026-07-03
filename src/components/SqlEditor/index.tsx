import { lazy, Suspense, useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal, flushSync } from 'react-dom'
import CodeMirror from '@uiw/react-codemirror'
import { sql, schemaCompletionSource, StandardSQL, MySQL, MariaSQL, PostgreSQL, SQLite, MSSQL } from '@codemirror/lang-sql'
import { keymap, EditorView, Decoration, tooltips, type DecorationSet } from '@codemirror/view'

// 跟随 CSS 变量的编辑器主题（背景/前景/光标均从 app 主题继承，不固定为 oneDark 的 #282c34）
const _editorDark = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':
    { background: 'rgba(100,145,255,0.28) !important' },
  '.cm-activeLine': { background: 'rgba(255,255,255,0.04)' },
  '.cm-activeLineGutter': { background: 'rgba(255,255,255,0.04)' },
  '.cm-matchingBracket': { background: 'rgba(100,145,255,0.22)', borderRadius: '2px' },
  '.cm-gutters': {
    background: 'var(--surface)', color: 'var(--text-muted)',
    border: 'none', borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-gutter .cm-gutterElement': { padding: '0 8px' },
  '.cm-tooltip': { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--surface-hover)' },
}, { dark: true })

const _editorLight = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':
    { background: 'rgba(80,130,240,0.22) !important' },
  '.cm-activeLine': { background: 'rgba(0,0,0,0.035)' },
  '.cm-activeLineGutter': { background: 'rgba(0,0,0,0.035)' },
  '.cm-matchingBracket': { background: 'rgba(80,130,240,0.18)', borderRadius: '2px' },
  '.cm-gutters': {
    background: 'var(--surface)', color: 'var(--text-muted)',
    border: 'none', borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-gutter .cm-gutterElement': { padding: '0 8px' },
  '.cm-tooltip': { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--surface-hover)' },
}, { dark: false })
import { Prec, StateField, StateEffect } from '@codemirror/state'
import { deleteLine, copyLineUp, copyLineDown, toggleLineComment } from '@codemirror/commands'
import { snippet, nextSnippetField, prevSnippetField, clearSnippet, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { sqlHighlight } from '../../utils/sqlHighlight'
import { cmSearchPhrases } from '../../utils/cmSearchPhrases'
import EnvWatermark from '../common/EnvWatermark'

// 补全/提示浮窗挂到 body 并用 fixed 定位，彻底避开编辑器/结果面板等 overflow:hidden 祖先裁剪
const _editorTooltips = tooltips({ position: 'fixed', parent: document.body })

// snippet 占位字段导航：有激活字段时 Tab/Shift-Tab 跳转、Esc 清除；无字段时返回 false 不拦截
const snippetNavKeymap = keymap.of([
  { key: 'Tab', run: nextSnippetField, shift: prevSnippetField },
  { key: 'Escape', run: clearSnippet },
])
import { Play, RotateCcw, History, GitBranch, Download, AlignLeft, Bookmark, Zap, BookOpen, ShieldAlert, ClipboardList, Undo2, Database, FolderOpen, Layers, ChevronRight, ChevronDown, ChevronUp, MoreHorizontal, Hash, X, Loader2, StopCircle, FilePlus2, Copy, PanelLeft } from 'lucide-react'
import DbBrowser from './DbBrowser'
import ResultTable from './ResultTable'
import SavedQueriesPanel from './SavedQueriesPanel'
import SearchableSelect from '../DbTools/SearchableSelect'
import type { ConnType } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'
import { useQueryStore } from '../../stores/queryStore'
import { useQueryHistoryStore } from '../../stores/queryHistoryStore'
import { useSchemaHistoryStore, isDdlStatement } from '../../stores/schemaHistoryStore'
import { useAppStore } from '../../stores/appStore'
import { useShortcuts } from '../../utils/useShortcuts'
import { displayShortcutStr } from '../../utils/shortcuts'
import { toast } from '../../stores/toastStore'
import { isPgFamily } from '../../utils/sqlDialect'
import { formatDuration } from '../../utils/formatDuration'
import { appendAuditLog } from '../../utils/auditLog'
import { markBatchCancelledFrom } from './queryBatchCancel'
import { hasMysqlDelimiterDirective, hasMysqlUserPreparedStmt, splitSqlStatements, stripSqlComments } from './sqlSplit'

const QueryHistoryPanel = lazy(() => import('./QueryHistoryPanel'))
const ExportDialog = lazy(() => import('./ExportDialog'))
const DbaTemplatesPanel = lazy(() => import('../DbTools/DbaTemplatesPanel'))
const SqliteAdminPanel = lazy(() => import('../DbTools/SqliteAdminPanel'))
const DuckDbAdminPanel = lazy(() => import('../DbTools/DuckDbAdminPanel'))
const DuckFileQueryDialog = lazy(() => import('../DbTools/DuckFileQueryDialog'))
const DuckLakePanel = lazy(() => import('../DbTools/DuckLakePanel'))
const DuckDbDiffPanel = lazy(() => import('../DbTools/DuckDbDiffPanel'))
const DuckMaskExportPanel = lazy(() => import('../DbTools/DuckMaskExportPanel'))
const AuditLogPanel = lazy(() => import('./AuditLogPanel'))
const TablePeekModal = lazy(() => import('./TablePeekModal'))
const DdlModal = lazy(() => import('./DdlModal'))
const RollbackSqlPanel = lazy(() => import('./RollbackSqlPanel'))

function LazySqlPanelFallback() {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 320, padding: 24 }}>
        <div className="modal-title">加载中...</div>
      </div>
    </div>
  )
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
  truncated?: boolean
  isSelect?: boolean
}

interface MultiResult {
  sql: string
  result: QueryResult | null
  error: string
  cancelled?: boolean
}

// 切库下拉的默认值：跳过系统库，选第一个业务库
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'pg_catalog', 'pg_toast'])
function pickDefaultSchema(schemas: string[]): string {
  return schemas.find(s => !SYSTEM_SCHEMAS.has(s.toLowerCase())) ?? schemas[0] ?? ''
}

interface Props {
  tabId: string
  connectionId: string
  connType: ConnType
}

const DEFAULT_SQL = ''

// 表名悬停下划线：StateField 持有当前悬停表名的装饰，由 mousemove 派发 effect 更新
const setTableHover = StateEffect.define<{ from: number; to: number } | null>()
const tableHoverMark = Decoration.mark({ class: 'cm-table-link' })
const tableHoverField = StateField.define<DecorationSet>({
  create() { return Decoration.none },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setTableHover)) {
        deco = e.value ? Decoration.set([tableHoverMark.range(e.value.from, e.value.to)]) : Decoration.none
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})
// 取当前装饰的范围（用于判断是否变化，避免每次 mousemove 都派发事务）
function currentHoverRange(deco: DecorationSet | undefined): { from: number; to: number } | null {
  if (!deco) return null
  let r: { from: number; to: number } | null = null
  deco.between(0, Number.MAX_SAFE_INTEGER, (from, to) => { r = { from, to }; return false })
  return r
}
function clearTableHover(view: EditorView) {
  if (currentHoverRange(view.state.field(tableHoverField, false))) {
    view.dispatch({ effects: setTableHover.of(null) })
  }
}

export interface EditCtx {
  schema: string
  table: string
  pkCols: string[]
}

/**
 * 识别"单表简单 SELECT"：只有这种结果才允许行内编辑。
 * 含 JOIN / GROUP BY / UNION / 子查询 / 多表的一律不可编辑。
 */
// ── 子查询感知的「别名.列」补全 ───────────────────────────────────────────────
// CodeMirror lang-sql 内置补全的别名解析对子查询里的 `from 表 别名` 解析不全，
// 导致 `(select x.col from t x ...)` 中 `x.` 无任何列提示。这里改用「全文扫描所有
// from/join（含子查询）」自建 别名→表 映射，方言无关，所有库通用。
function stripQuoteIdent(s: string): string {
  return s.replace(/^[`"[]/, '').replace(/[`"\]]$/, '')
}
const ALIAS_STOP_WORDS = new Set([
  'where', 'on', 'using', 'inner', 'left', 'right', 'outer', 'full', 'cross',
  'join', 'group', 'order', 'having', 'union', 'limit', 'set', 'as', 'and', 'or', 'select', 'values',
])
/** 扫描整条 SQL 的 from/join，建立 别名(小写)→表名 与 表名(小写)→表名 映射（含子查询） */
function buildAliasMap(doc: string): Record<string, string> {
  const map: Record<string, string> = {}
  const re = /\b(?:from|join)\s+([`"[]?[\w.]+[`"\]]?)\s*(?:\bas\s+)?([`"[]?[A-Za-z_]\w*[`"\]]?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(doc))) {
    let table = stripQuoteIdent(m[1])
    if (table.includes('.')) table = table.split('.').pop() ?? table
    if (!table) continue
    map[table.toLowerCase()] = table
    if (m[2]) {
      const alias = stripQuoteIdent(m[2])
      if (alias && !ALIAS_STOP_WORDS.has(alias.toLowerCase())) map[alias.toLowerCase()] = table
    }
  }
  return map
}
/** 大小写不敏感地取某表的列名 */
function columnsOfTable(dbSchema: Record<string, string[]>, table: string): string[] {
  if (dbSchema[table]?.length) return dbSchema[table]
  const lc = table.toLowerCase()
  for (const k of Object.keys(dbSchema)) if (k.toLowerCase() === lc) return dbSchema[k]
  return []
}
/** `别名.` / `表名.` 成员补全：返回该表列名；非成员上下文返回 null（交回内置补全） */
function memberCompletion(ctx: CompletionContext, dbSchema: Record<string, string[]>): CompletionResult | null {
  const before = ctx.matchBefore(/[`"[\]\w$]+\.[\w$]*$/)
  if (!before || before.from === before.to) return null
  const dot = before.text.lastIndexOf('.')
  const alias = stripQuoteIdent(before.text.slice(0, dot))
  if (!alias) return null
  const table = buildAliasMap(ctx.state.doc.toString())[alias.toLowerCase()]
  if (!table) return null
  const cols = columnsOfTable(dbSchema, table)
  if (!cols.length) return null
  return {
    from: before.from + dot + 1,
    options: cols.map(c => ({ label: c, type: 'property' })),
    validFor: /^[\w$]*$/,
  }
}

function parseSingleTable(sqlText: string): { schema: string; table: string } | null {
  // 先剥离注释（前导/行内 -- # 与块注释），否则带注释的 SELECT 无法识别为单表，导致不可编辑
  const s = sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '')
  if (/\b(join|group\s+by|union|having|distinct)\b/i.test(s)) return null
  // 允许表后可选别名（mc_xx t / mc_xx AS t）；别名不能是 where/order/limit 等保留字（靠负向预查+回溯排除）
  const m = /^select\s+[\s\S]+?\sfrom\s+([A-Za-z0-9_`".]+)(?:\s+(?:as\s+)?(?!where\b|order\b|limit\b|group\b|having\b|union\b|join\b)[A-Za-z0-9_]+)?\s*(?:where\b[\s\S]*|order\s+by\b[\s\S]*|limit\b[\s\S]*)?$/i.exec(s)
  if (!m) return null
  const raw = m[1].replace(/[`"]/g, '')
  const parts = raw.split('.').filter(Boolean)
  if (parts.length === 1) return { schema: '', table: parts[0] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return null
}

// 支持主动 kill 正在运行查询的连接类型（MySQL 系走 KILL QUERY，PG 系走 pg_cancel_backend）
const CANCELABLE_TYPES = new Set(['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'])

export default function SqlEditor({ tabId, connectionId, connType }: Props) {
  // SQL 草稿按顶层 tabId 存储（已扁平化，每个查询标签即一个独立编辑器，无内层子标签）
  const savedSql = useQueryStore((s) => s.sqls[tabId])
  const { setSql } = useQueryStore()
  const [sqlText, setSqlText] = useState(savedSql ?? DEFAULT_SQL)
  const [result, setResult]   = useState<QueryResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState('')
  // 可取消查询：执行时给 SQL 注入唯一标记注释，结果区显示实时计时 + 停止按钮
  const [runToken, setRunToken] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const runStartRef = useRef(0)
  const lastElapsedRef = useRef(0)   // 上一次执行的实际耗时（出错/取消时用，避免显示 0ms）
  const runTokenRef = useRef<string | null>(null)
  const cancelRequestedRef = useRef(false)
  // 运行期间每 100ms 刷新一次耗时显示
  useEffect(() => {
    if (!running) { setElapsedMs(0); return }
    runStartRef.current = Date.now()
    setElapsedMs(0)
    const t = setInterval(() => setElapsedMs(Date.now() - runStartRef.current), 100)
    return () => clearInterval(t)
  }, [running])
  const dbQueryLimit = useSettingsStore((s) => s.dbQueryLimit)
  // 每个 Tab 独立的行数上限，初始值来自偏好设置；执行完毕后恢复当前全局默认值
  const [queryLimit, setQueryLimit] = useState<number | null>(() => dbQueryLimit)
  const prevDbQueryLimitRef = useRef(dbQueryLimit)
  useEffect(() => {
    const prevDefault = prevDbQueryLimitRef.current
    setQueryLimit(prev => prev === prevDefault ? dbQueryLimit : prev)
    prevDbQueryLimitRef.current = dbQueryLimit
  }, [dbQueryLimit])
  const appColorScheme = useSettingsStore((s) => s.appColorScheme)
  const shortcuts      = useSettingsStore((s) => s.shortcuts)
  const editorViewRef = useRef<EditorView | null>(null)
  // DB 分屏面板
  const [dbPanelOpen, setDbPanelOpen] = useState(() => {
    try { return localStorage.getItem(`db-panel-open-${connType}`) === '1' } catch { return false }
  })
  const [dbPanelWidth, setDbPanelWidth] = useState(() => {
    try { return Number(localStorage.getItem(`db-panel-width-${connType}`)) || 220 } catch { return 220 }
  })
  const dbPanelDragRef  = useRef(false)
  const dbPanelStartX   = useRef(0)
  const dbPanelStartW   = useRef(0)
  const dbPanelCurrentW = useRef(dbPanelWidth)  // 实时跟踪拖拽中的最新宽度
  function toggleDbPanel() {
    setDbPanelOpen(v => {
      const next = !v
      try { localStorage.setItem(`db-panel-open-${connType}`, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }
  function startDbPanelDrag(e: React.MouseEvent) {
    dbPanelDragRef.current  = true
    dbPanelStartX.current   = e.clientX
    dbPanelStartW.current   = dbPanelWidth
    dbPanelCurrentW.current = dbPanelWidth
    const onMove = (ev: MouseEvent) => {
      if (!dbPanelDragRef.current) return
      const w = Math.max(160, Math.min(480, dbPanelStartW.current + ev.clientX - dbPanelStartX.current))
      dbPanelCurrentW.current = w
      setDbPanelWidth(w)
    }
    const onUp = () => {
      dbPanelDragRef.current = false
      // 用 ref 读取最新宽度，不依赖 closure 中 stale 的 dbPanelWidth
      try { localStorage.setItem(`db-panel-width-${connType}`, String(dbPanelCurrentW.current)) } catch { /* ignore */ }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const [historyOpen, setHistoryOpen]     = useState(false)
  const [exportOpen,  setExportOpen]      = useState(false)
  const [savedOpen,   setSavedOpen]       = useState(false)
  // 从「查询历史 → 保存为查询」进入时，指定要保存的 SQL（否则取编辑器选中/整页）
  const [saveSqlOverride, setSaveSqlOverride] = useState<string | null>(null)
  const [linkedSavedQuery, setLinkedSavedQuery] = useState<{ id: string; name: string } | null>(null)
  const savedBaselineRef = useRef(DEFAULT_SQL)
  const [dbaOpen,     setDbaOpen]         = useState(false)
  const [auditOpen,   setAuditOpen]       = useState(false)
  const [rollbackOpen, setRollbackOpen]   = useState(false)
  const [moreOpen,    setMoreOpen]        = useState(false)
  const [txMenuOpen,  setTxMenuOpen]      = useState(false)
  const [sumCtx, setSumCtx] = useState<{ x: number; y: number; sql: string; msg: string } | null>(null)
  useEffect(() => {
    if (!sumCtx) return
    const close = () => setSumCtx(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [!!sumCtx])

  // 编辑器右键菜单 + 导出目标 SQL（区分是否选中）
  const [editorCtx,   setEditorCtx]       = useState<{ x: number; y: number; hasSel: boolean } | null>(null)
  const [exportSql,   setExportSql]       = useState('')
  // 结果工具栏传送插槽（页签行右侧）
  const [headSlot,    setHeadSlot]        = useState<HTMLDivElement | null>(null)
  const [sqliteAdminOpen, setSqliteAdminOpen] = useState(false)
  const [duckAdminOpen, setDuckAdminOpen] = useState(false)
  const [duckLakeOpen, setDuckLakeOpen] = useState(false)
  const [duckDiffOpen, setDuckDiffOpen] = useState(false)
  const [duckMaskOpen, setDuckMaskOpen] = useState(false)
  const [duckFileQueryPath, setDuckFileQueryPath] = useState<string | null>(null)
  const addHistory = useQueryHistoryStore((s) => s.addQuery)
  const addSchemaHistory = useSchemaHistoryStore((s) => s.addEntry)
  const tab = useAppStore((s) => s.tabs.find(t => t.id === tabId))
  const setTabDirty = useAppStore((s) => s.setTabDirty)
  const setTabMeta = useAppStore((s) => s.setTabMeta)
  const renameTab = useAppStore((s) => s.renameTab)
  const pendingSql = useAppStore((s) => s.pendingRun[tabId])
  const clearPendingRun = useAppStore((s) => s.clearPendingRun)
  const pendingFillSql = useAppStore((s) => s.pendingFill[tabId])
  const pendingFillMeta = useAppStore((s) => s.pendingFillMeta[tabId])
  const clearPendingFill = useAppStore((s) => s.clearPendingFill)
  const pendingSchema = useAppStore((s) => s.pendingSchema[tabId])
  const clearPendingSchema = useAppStore((s) => s.clearPendingSchema)
  const connections = useAppStore((s) => s.connections)
  const activeConn = connections.find((c) => c.id === connectionId)
  const isSqlite = activeConn?.type === 'sqlite'

  const setSqlDraft = useCallback((value: string) => {
    setSqlText(value)
    setSql(tabId, value)
  }, [setSql, tabId])

  const insertSqlAtCursor = useCallback((picked: string) => {
    const view = editorViewRef.current
    if (!view) {
      const next = sqlText.trim() ? `${sqlText.trimEnd()}\n\n${picked}` : picked
      setSqlDraft(next)
      return
    }
    const { from, to } = view.state.selection.main
    const doc = view.state.doc.toString()
    const before = doc.slice(0, from)
    const after = doc.slice(to)
    const prefix = before && !before.endsWith('\n') ? '\n' : ''
    const suffix = after && !after.startsWith('\n') ? '\n' : ''
    const insert = `${prefix}${picked}${suffix}`
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    })
    view.focus()
    setSqlDraft(view.state.doc.toString())
    preFormatRef.current = null
  }, [setSqlDraft, sqlText])

  const markSqlSaved = useCallback((saved?: { id: string; name: string }, savedSqlText = sqlText) => {
    savedBaselineRef.current = savedSqlText
    setTabDirty(tabId, false)
    const meta: Record<string, string | undefined> = { savedSqlBaseline: savedSqlText }
    if (saved) {
      meta.savedQueryId = saved.id
      meta.savedQueryName = saved.name
      setLinkedSavedQuery(saved)
      if (saved.name.trim()) renameTab(tabId, saved.name.trim())
    }
    setTabMeta(tabId, meta)
  }, [renameTab, setTabDirty, setTabMeta, sqlText, tabId])

  useEffect(() => {
    const baseline = tab?.meta?.savedSqlBaseline
    if (baseline !== undefined) savedBaselineRef.current = baseline
    setLinkedSavedQuery(tab?.meta?.savedQueryId ? {
      id: tab.meta.savedQueryId,
      name: tab.meta.savedQueryName ?? '',
    } : null)
  }, [tab?.id, tab?.meta?.savedQueryId, tab?.meta?.savedQueryName, tab?.meta?.savedSqlBaseline])

  useEffect(() => {
    const dirty = sqlText.trim().length > 0 && sqlText !== savedBaselineRef.current
    setTabDirty(tabId, dirty)
  }, [sqlText, setTabDirty, tabId])

  // 当前查询页使用的 schema/库（Navicat 风格切库；执行时作为 database 传给后端）
  const [schemas, setSchemas] = useState<string[]>([])
  const [currentSchema, setCurrentSchema] = useState<string>(activeConn?.database ?? '')
  const currentSchemaRef = useRef(currentSchema)
  currentSchemaRef.current = currentSchema
  useEffect(() => {
    if (isSqlite || !connectionId) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: connectionId })
        if (!alive) return
        setSchemas(list)
        setCurrentSchema(prev =>
          prev && list.includes(prev) ? prev
            : (activeConn?.database && list.includes(activeConn.database) ? activeConn.database : pickDefaultSchema(list)))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  // Mod+左键点击表名 → 弹出该表的 DDL / 近期数据预览弹窗
  const openQueryTab = useAppStore(s => s.openQueryTab)
  const [tableSet, setTableSet] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!connectionId) { setTableSet(new Set()); return }
    // SQLite 用 'main'，ClickHouse/DuckDB 等无 schema 传空字符串，其余用当前选中 schema
    const sch = isSqlite ? 'main' : (currentSchema || '')
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string }[]>('list_tables', { id: connectionId, schema: sch })
        if (alive) setTableSet(new Set(list.map(t => t.name.toLowerCase())))
      } catch { if (alive) setTableSet(new Set()) }
    })()
    return () => { alive = false }
  }, [connectionId, currentSchema, isSqlite])
  const tableSetRef = useRef(tableSet); tableSetRef.current = tableSet
  // 函数/存过名集合（MySQL 系支持查看定义；其它库仅加下划线，点击时再判断是否支持）
  const [routineSet, setRoutineSet] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!connectionId || !currentSchema || isSqlite) { setRoutineSet(new Map()); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string; routineType: string }[]>('list_routines', { id: connectionId, schema: currentSchema })
        if (alive) setRoutineSet(new Map(list.map(r => [r.name.toLowerCase(), r.routineType])))
      } catch { if (alive) setRoutineSet(new Map()) }
    })()
    return () => { alive = false }
  }, [connectionId, currentSchema, isSqlite])
  const routineSetRef = useRef(routineSet); routineSetRef.current = routineSet
  // 表预览弹窗（DDL + 近期数据）
  const [peek, setPeek] = useState<{ schema: string; table: string } | null>(null)
  const openPeekRef = useRef<(t: string) => void>(() => {})
  openPeekRef.current = (table: string) => setPeek({ schema: currentSchemaRef.current, table })
  // 函数/存过 DDL 弹窗（Mod 点击查看定义）
  const [routinePeek, setRoutinePeek] = useState<{ name: string; ddl: string; loading: boolean; error: string } | null>(null)
  const openRoutinePeekRef = useRef<(name: string) => void>(() => {})
  openRoutinePeekRef.current = async (name: string) => {
    // SHOW CREATE FUNCTION/PROCEDURE 为 MySQL 系专属；其它库（PG/SQLite…）暂不支持查看例程定义，避免发出会报错的语句
    const kindRaw = routineSetRef.current.get(name.toLowerCase()) ?? 'FUNCTION'
    const kind = kindRaw.toUpperCase().includes('PROC') ? 'procedure' : 'function'
    setRoutinePeek({ name, ddl: '', loading: true, error: '' })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const sch = currentSchemaRef.current
      // 统一走后端按方言分发的 get_routine_ddl（MySQL=SHOW CREATE / PG=pg_get_functiondef / mssql=OBJECT_DEFINITION / Oracle=ALL_SOURCE）
      const raw = await invoke<string>('get_routine_ddl', { id: connectionId, schema: sch, name, kind })
      const { prettyRoutineDdl } = await import('../../utils/objectEditor')
      setRoutinePeek({ name, ddl: await prettyRoutineDdl(raw, connType), loading: false, error: '' })
    } catch (e) {
      setRoutinePeek(p => p ? { ...p, loading: false, error: String(e) } : p)
    }
  }
  // Mod+左键点击表名/例程名 → DDL / 数据预览
  const modClickExt = useMemo(() => EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return false
      const range = view.state.wordAt(pos)
      if (!range) return false
      const word = view.state.sliceDoc(range.from, range.to)
      const lw = word.toLowerCase()
      if (word && tableSetRef.current.has(lw)) {
        e.preventDefault(); openPeekRef.current(word); return true
      }
      if (word && routineSetRef.current.has(lw)) {
        e.preventDefault(); openRoutinePeekRef.current(word); return true
      }
      return false
    },
  }), [])
  // 表名/例程名 悬停下划线
  const tableHoverExt = useMemo(() => EditorView.domEventHandlers({
    mousemove(e, view) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      let next: { from: number; to: number } | null = null
      if (pos != null) {
        const range = view.state.wordAt(pos)
        if (range) {
          const word = view.state.sliceDoc(range.from, range.to)
          const lw = word.toLowerCase()
          if (word && (tableSetRef.current.has(lw) || routineSetRef.current.has(lw))) next = { from: range.from, to: range.to }
        }
      }
      const cur = currentHoverRange(view.state.field(tableHoverField, false))
      const same = (!next && !cur) || (!!next && !!cur && next.from === cur.from && next.to === cur.to)
      if (!same) view.dispatch({ effects: setTableHover.of(next) })
      return false
    },
    // 移出/点击/滚动/失焦都立刻清除，避免悬停提示浮窗残留
    mouseleave(_e, view) { clearTableHover(view); return false },
    mousedown(_e, view) { clearTableHover(view); return false },
    wheel(_e, view) { clearTableHover(view); return false },
    blur(_e, view) { clearTableHover(view); return false },
  }), [])

  // 事务模式状态
  const [txMode, setTxMode] = useState(false)
  const [txActive, setTxActive] = useState(false)
  const [txShortcutConfirm, setTxShortcutConfirm] = useState<'commit' | 'rollback' | null>(null)
  const [dangerPending, setDangerPending] = useState<{ sql: string; warnings: string[] } | null>(null)
  // 生产环境写操作二次确认（envLabel='prod' 时写语句执行前弹窗）
  const [prodPending, setProdPending] = useState<{ sql: string; count: number } | null>(null)
  // K5 多结果 tab
  const [multiResults, setMultiResults] = useState<MultiResult[]>([])
  // 结果区当前页签：'msg' 消息 | 'sum' 摘要 | number 第 N 个数据结果
  const [resultTab, setResultTab] = useState<'msg' | 'sum' | number>('msg')
  const [lastRunSql, setLastRunSql] = useState('')

  // 结果区高度（可拖拽）+ 收起/展开
  const [resultH, setResultH] = useState(300)
  const [resultCollapsed, setResultCollapsed] = useState(false)
  const [resultClosed, setResultClosed] = useState(false)   // 关闭结果区（执行后自动重新打开）
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)
  const startResize = useCallback((e: React.MouseEvent) => {
    resizeRef.current = { startY: e.clientY, startH: resultH }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dy = resizeRef.current.startY - ev.clientY // 上拖变大
      const h = Math.max(120, Math.min(window.innerHeight - 220, resizeRef.current.startH + dy))
      setResultH(h)
    }
    const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [resultH])

  // 查询历史侧栏：可左右拖拽改宽，宽度持久化
  const [historyWidth, setHistoryWidth] = useState(() => {
    const v = Number(localStorage.getItem('qh-panel-width'))
    return v >= 220 && v <= 900 ? v : 280
  })
  const histResizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const startHistoryResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    histResizeRef.current = { startX: e.clientX, startW: historyWidth }
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) => {
      if (!histResizeRef.current) return
      // 面板在右侧：向左拖（clientX 变小）→ 变宽
      const dx = histResizeRef.current.startX - ev.clientX
      const w = Math.max(220, Math.min(900, histResizeRef.current.startW + dx))
      setHistoryWidth(w)
    }
    const onUp = () => {
      histResizeRef.current = null
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [historyWidth])
  // 宽度持久化
  useEffect(() => { localStorage.setItem('qh-panel-width', String(historyWidth)) }, [historyWidth])

  // 执行完成后自动选页签：有数据结果 → 结果1，有摘要 → 摘要，否则 → 消息
  useEffect(() => {
    if (running) return
    const hasData = multiResults.length > 0
      ? multiResults.some(m => m.result && m.result.columns.length > 0)
      : !!(result && result.columns.length > 0)
    const hasSummary = multiResults.length > 0 || result !== null || !!error
    if (hasData) setResultTab(0)
    else if (hasSummary) setResultTab('sum')
    else setResultTab('msg')
  }, [result, multiResults, running, error])

  // 挂载时从后端同步事务状态（防止前端刷新后状态丢失）
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const active = await invoke<boolean>('db_tx_status', { id: connectionId })
        if (alive && active) { setTxMode(true); setTxActive(true) }
      } catch { /* 静默降级 */ }
    })()
    return () => { alive = false }
  }, [connectionId])
  // 行内编辑上下文：单表查询 + 存在主键且主键列都在结果中才可编辑
  const [editCtx, setEditCtx] = useState<EditCtx | null>(null)
  // MariaDB 非事务引擎提示（Aria/MyISAM 不支持事务回滚）
  const [mariaEngineWarn, setMariaEngineWarn] = useState('')

  // 当前所有「数据结果集」（含列）；srcIndex: -1=单条结果(result)，>=0=multiResults[i]
  const dataResults = useMemo(() => {
    if (multiResults.length > 0) {
      const out: { sql: string; result: QueryResult; srcIndex: number }[] = []
      // isSelect=true 即使 0 行也显示结果 tab（列头由 describe 填充）
      multiResults.forEach((m, i) => {
        if (m.result && (m.result.columns.length > 0 || m.result.isSelect))
          out.push({ sql: m.sql, result: m.result, srcIndex: i })
      })
      return out
    }
    if (result && (result.columns.length > 0 || result.isSelect)) return [{ sql: lastRunSql, result, srcIndex: -1 }]
    return []
  }, [result, multiResults, lastRunSql])
  const dataIdx = typeof resultTab === 'number' ? Math.min(resultTab, Math.max(0, dataResults.length - 1)) : 0
  const activeData = dataResults[dataIdx]

  // 判定「当前结果集」是否可行内编辑（单表 + 主键齐全），多结果集亦可
  useEffect(() => {
    const ad = activeData
    if (!ad || running) { setEditCtx(null); return }
    const target = parseSingleTable(ad.sql)
    if (!target) { setEditCtx(null); setMariaEngineWarn(''); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const schema = target.schema
          || (isSqlite ? 'main'
            : ['postgres', 'kingBase', 'openGauss'].includes(connType) ? (currentSchemaRef.current || 'public')
            : (currentSchemaRef.current || pickDefaultSchema(schemas)))
        const cols = await invoke<{ name: string; key: string }[]>('table_columns', { id: connectionId, schema, table: target.table })
        if (!alive) return
        const pkCols = cols.filter(c => c.key === 'PRI').map(c => c.name)
        if (pkCols.length > 0 && pkCols.every(pk => ad.result.columns.includes(pk))) {
          setEditCtx({ schema, table: target.table, pkCols })
          setMariaEngineWarn('')
          if (connType === 'mariadb') {
            invoke<{ engine: string }>('mariadb_table_extra_info', { id: connectionId, schema, table: target.table }).then(extra => {
              const eng = extra.engine?.toUpperCase() ?? ''
              if (['ARIA', 'MYISAM', 'MEMORY', 'MERGE', 'CSV', 'ARCHIVE', 'BLACKHOLE'].includes(eng)) setMariaEngineWarn(`当前表引擎 ${extra.engine} 不支持事务回滚，行编辑操作无法撤销`)
            }).catch(() => {})
          }
        } else { setEditCtx(null) }
      } catch { if (alive) setEditCtx(null) }
    })()
    return () => { alive = false }
  // 仅在 SQL / 列签名变化时重算（编辑行数据不触发重新取主键）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeData?.sql, activeData?.result.columns.join('|'), activeData?.srcIndex, running, connectionId, connType, isSqlite])
  // 表名/列名补全数据：表名启动时拉取，列名点击表时按需补充
  const [dbSchema, setDbSchema] = useState<Record<string, string[]>>({})

  // E4 智能补全：只加载「当前 schema」的表/列名（避免把其它库的表也提示出来）
  useEffect(() => {
    const sch = currentSchema || (isSqlite ? 'main' : '')
    if (!connectionId || !sch) { setDbSchema({}); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        // 最优路径：一条查询拉回整库「表名→列名」（MySQL/PG/SQLite），省去逐表 N 次往返
        try {
          const full = await invoke<Record<string, string[]>>('schema_columns', { id: connectionId, schema: sch })
          if (!alive) return
          if (full && Object.keys(full).length) { setDbSchema(full); return }
        } catch { /* 该方言不支持批量 → 走下方逐表回退 */ }

        // 回退：先放表名（空列）立即可用，列名后台逐张补，结束整体刷新一次
        const tables = await invoke<{ name: string }[]>('list_tables', { id: connectionId, schema: sch })
        if (!alive) return
        const map: Record<string, string[]> = {}
        for (const t of tables) map[t.name] = []
        setDbSchema({ ...map })
        for (const t of tables.slice(0, 200)) {
          try {
            const cols = await invoke<{ name: string }[]>('table_columns', { id: connectionId, schema: sch, table: t.name })
            map[t.name] = cols.slice(0, 100).map(c => c.name)
          } catch {
            map[t.name] = []
          }
          if (!alive) return
        }
        if (alive) setDbSchema({ ...map })
      } catch { /* 无补全数据时静默降级 */ }
    })()
    return () => { alive = false }
  }, [connectionId, currentSchema, isSqlite])

  // Determine dark/light for editor theme
  const prefersDark = typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = appColorScheme === 'dark'
    || (appColorScheme === 'system' && prefersDark)

  /** 判断是否为写操作 SQL */
  const isWriteSql = (trimmed: string) => {
    // 剥离前导行/块注释后取首关键字，覆盖 DML + DDL + 权限等一切写操作（只读模式据此拦截）
    const upper = stripSqlComments(trimmed).trim().toUpperCase()
    return /^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|RENAME|MERGE|UPSERT|GRANT|REVOKE|LOAD\s+DATA|CALL)\b/.test(upper)
  }

  /** I1 危险 SQL 检测：返回警告列表，为空表示安全 */
  const detectDangerSql = (trimmed: string): string[] => {
    const warnings: string[] = []
    const upper = trimmed.toUpperCase()
    const noWhere = !/\bWHERE\b/.test(upper)
    if (/^UPDATE\b/.test(upper) && noWhere) {
      warnings.push('UPDATE 语句没有 WHERE 条件，将修改表中所有行')
    }
    if (/^DELETE\b/.test(upper) && noWhere) {
      warnings.push('DELETE 语句没有 WHERE 条件，将删除表中所有行')
    }
    if (/^(DROP\s+TABLE|DROP\s+DATABASE|DROP\s+VIEW|DROP\s+INDEX)\b/i.test(trimmed)) {
      warnings.push('DROP 操作不可撤销，相关数据或对象将永久删除')
    }
    if (/^TRUNCATE\b/.test(upper)) {
      warnings.push('TRUNCATE 将清空整张表的所有数据，此操作不可撤销')
    }
    // MS4.4 — SQL Server T-SQL 高危拦截
    if (connType === 'sqlServer') {
      if (/\bxp_cmdshell\b/i.test(trimmed)) {
        warnings.push('xp_cmdshell 可执行操作系统命令，存在严重安全风险；确认前请检查此操作的必要性')
      }
      if (/\bSHUTDOWN\b/.test(upper)) {
        warnings.push('SHUTDOWN 将立即关闭 SQL Server 实例，影响所有用户和服务')
      }
      if (/\bsp_configure\b/i.test(trimmed)) {
        warnings.push('sp_configure 修改服务器级配置，某些选项（如 xp_cmdshell、CLR enabled）存在安全风险，需谨慎确认')
      }
    }
    // OR4.4 — Oracle 高危拦截
    if (connType === 'oracle') {
      if (/\bALTER\s+SYSTEM\b/i.test(trimmed)) {
        warnings.push('ALTER SYSTEM 修改实例级参数，影响所有连接，请确认必要性')
      }
      if (/\bSHUTDOWN\b/.test(upper)) {
        warnings.push('SHUTDOWN 将关闭 Oracle 实例，影响所有用户和服务')
      }
      if (/\bPURGE\b/i.test(upper)) {
        warnings.push('PURGE 将从回收站永久删除对象，不可恢复')
      }
    }
    return warnings
  }

  // 仅 MySQL/PG 系支持主动 kill 正在运行的查询；事务连接不注入（kill 会破坏事务连接）
  const canCancel = !txActive && CANCELABLE_TYPES.has(connType)
  const newCancelToken = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  // 给 SQL 注入取消标记注释；单次执行/批量里的每条语句都使用独立 token，停止时按当前 token 取消。
  const markSql = (s: string, token?: string | null): string => {
    if (!canCancel || !token) return s
    return `/* dbterm-cancel:${token} */ ${s}`
  }
  const stopQuery = useCallback(async () => {
    if (cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    const token = runTokenRef.current || runToken
    if (!token) {
      toast.info('已取消后续查询')
      return
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const ok = await invoke<boolean>('db_cancel_query', { id: connectionId, token })
      toast[ok ? 'success' : 'info'](ok ? '取消请求已发送' : '查询可能已结束', {
        title: ok ? '正在取消查询' : undefined,
        duration: 4200,
      })
    } catch (e) { toast.error(String(e)) }
  }, [runToken, connectionId])

  const runQuery = useCallback(async (sqlToRun: string, limitOverride?: number | null, forceProd = false) => {
    let trimmed = sqlToRun.trim()
    if (!trimmed) return
    setLastRunSql(trimmed)
    setResultClosed(false)   // 执行即重新打开结果区

    // 过滤掉“仅注释/空白”的语句，避免把纯注释当命令发给数据库（MySQL 1295）
    const isMysqlFamilyConn = ['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)
    const keepMysqlPreparedScript = isMysqlFamilyConn
      && hasMysqlUserPreparedStmt(trimmed)
      && !hasMysqlDelimiterDirective(trimmed)
    const stmts = keepMysqlPreparedScript
      ? [trimmed]
      : splitSqlStatements(trimmed, connType).filter(s => stripSqlComments(s) !== '')
    if (stmts.length === 0) return // 仅注释/空白：静默不执行
    // 单条执行：用拆分后的语句（剥离尾部分号/多余注释），避免把分号后内容一起发送
    if (stmts.length === 1) trimmed = stmts[0]

    // 写操作守卫（覆盖单/多语句）—— 逐条做 SQL 级校验
    const writeStmts = stmts.filter(isWriteSql)
    // 只读模式：拦截一切写操作（DML/DDL/权限），不可绕过
    if ((activeConn?.readonly ?? activeConn?.readOnly) && writeStmts.length > 0) {
      setMultiResults([]); setResult(null)
      setError('此连接为只读模式，已拦截写操作（INSERT / UPDATE / DELETE / DDL 等）')
      return
    }
    // 生产环境：可读可写，但写操作执行前需二次确认
    if (activeConn?.envLabel === 'prod' && writeStmts.length > 0 && !forceProd) {
      setProdPending({ sql: sqlToRun, count: writeStmts.length })
      return
    }

    const effectiveLimit = limitOverride !== undefined ? limitOverride : queryLimit

    // K5 — 多语句检测：有多条语句时走 multi-result 流程
    if (stmts.length > 1) {
      setMultiResults(stmts.map(s => ({ sql: s, result: null, error: '' })))
      setResult(null); setError('')
      setResultTab('sum')   // 多语句：停在「摘要」页，实时看每条进度（执行中/等待/成功/错误）
      const { invoke: inv } = await import('@tauri-apps/api/core')
      cancelRequestedRef.current = false
      setRunning(true)
      for (let si = 0; si < stmts.length; si++) {
        const s = stmts[si]
        if (cancelRequestedRef.current) {
          flushSync(() => {
            setMultiResults(prev => markBatchCancelledFrom(prev, si))
          })
          break
        }
        const token = canCancel ? newCancelToken() : null
        runTokenRef.current = token
        setRunToken(token)
        try {
          const res = await inv<QueryResult>('execute_query', {
            id: connectionId,
            sql: markSql(s, token),
            database: currentSchemaRef.current || undefined,
            rowLimit: effectiveLimit ?? undefined,
          })
          if (cancelRequestedRef.current) {
            flushSync(() => {
              setMultiResults(prev => markBatchCancelledFrom(prev, si))
            })
            addHistory(connectionId, s, false, { error: '查询已取消' })
            break
          }
          // flushSync 确保每条查询结果立即渲染，不被 React 18 自动批处理合并
          flushSync(() => {
            setMultiResults(prev => prev.map((r, i) => i === si ? { ...r, result: res } : r))
          })
          addHistory(connectionId, s, true, { executionTimeMs: res.executionTimeMs, rowsAffected: res.rowsAffected })
          if (isSqlite && isDdlStatement(s)) {
            try {
              const uvBefore = await inv<QueryResult>('execute_query', { id: connectionId, sql: 'PRAGMA user_version' })
              addSchemaHistory({ connId: connectionId, sql: s, at: Date.now(), userVersionBefore: 0, userVersionAfter: Number(uvBefore.rows?.[0]?.[0] ?? 0) })
            } catch { /* non-critical */ }
          } else if (connType === 'duckdb' && isDdlStatement(s)) {
            addSchemaHistory({ connId: connectionId, sql: s, at: Date.now(), userVersionBefore: 0, userVersionAfter: 0 })
          }
        } catch (e) {
          const errStr = String(e)
          const cancelled = cancelRequestedRef.current || errStr.includes('查询已取消')
          flushSync(() => {
            setMultiResults(prev => cancelled
              ? markBatchCancelledFrom(prev, si)
              : prev.map((r, i) => i === si ? { ...r, error: errStr } : r))
          })
          addHistory(connectionId, s, false, { error: (cancelled ? '查询已取消' : errStr).slice(0, 200) })
          if (cancelled) break
        } finally {
          runTokenRef.current = null
          setRunToken(null)
        }
      }
      lastElapsedRef.current = Date.now() - runStartRef.current
      setRunning(false)
      runTokenRef.current = null
      setRunToken(null)
      cancelRequestedRef.current = false
      setQueryLimit(dbQueryLimit)
      return
    }

    // I1 危险 SQL 拦截：弹确认框
    const warnings = detectDangerSql(trimmed)
    if (warnings.length > 0) {
      setDangerPending({ sql: trimmed, warnings })
      return
    }

    setMultiResults([])
    cancelRequestedRef.current = false
    const token = canCancel ? newCancelToken() : null
    runTokenRef.current = token
    setRunToken(token)
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<QueryResult>(txActive ? 'db_exec_in_tx' : 'execute_query', {
        id: connectionId,
        sql: markSql(trimmed, token),
        database: currentSchemaRef.current || undefined,
        ...(txActive ? {} : { rowLimit: effectiveLimit ?? undefined }),
      })
      setResult(res)
      addHistory(connectionId, trimmed, true, {
        executionTimeMs: res.executionTimeMs,
        rowsAffected: res.rowsAffected,
      })

      // S4.5 / DD8.4 schema change history
      if (isSqlite && isDdlStatement(trimmed)) {
        try {
          const { invoke: inv2 } = await import('@tauri-apps/api/core')
          const uvRow = await inv2<QueryResult>('execute_query', { id: connectionId, sql: 'PRAGMA user_version' })
          addSchemaHistory({ connId: connectionId, sql: trimmed, at: Date.now(), userVersionBefore: 0, userVersionAfter: Number(uvRow.rows?.[0]?.[0] ?? 0) })
        } catch { /* non-critical */ }
      } else if (connType === 'duckdb' && isDdlStatement(trimmed)) {
        addSchemaHistory({ connId: connectionId, sql: trimmed, at: Date.now(), userVersionBefore: 0, userVersionAfter: 0 })
      }

      // I3 审计日志：记录写操作
      if (isWriteSql(trimmed)) {
        appendAuditLog({
          ts: Date.now(), connId: connectionId,
          connName: activeConn?.name ?? connectionId,
          sql: trimmed, rowsAffected: res.rowsAffected, success: true,
        })
      }

      // 手动事务模式：非 SELECT 语句标记事务进行中
      if (txMode && !trimmed.toUpperCase().startsWith('SELECT')) {
        setTxActive(true)
      }

      // 可编辑性由「当前结果集」effect 统一判定（支持多结果集）
    } catch (e) {
      const errStr = String(e)
      setError(errStr)
      addHistory(connectionId, trimmed, false, { error: errStr.slice(0, 200) })
      if (isWriteSql(trimmed)) {
        appendAuditLog({
          ts: Date.now(), connId: connectionId,
          connName: activeConn?.name ?? connectionId,
          sql: trimmed, rowsAffected: 0, success: false,
          error: errStr.slice(0, 200),
        })
      }
    } finally {
      lastElapsedRef.current = Date.now() - runStartRef.current
      setRunning(false)
      runTokenRef.current = null
      setRunToken(null)
      cancelRequestedRef.current = false
      setQueryLimit(dbQueryLimit)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, connType, addHistory, activeConn, txMode, txActive, queryLimit, dbQueryLimit])

  /** 危险 SQL 确认后直接执行（跳过 danger check） */
  const runQueryForced = useCallback(async (sqlToRun: string) => {
    const trimmed = sqlToRun.trim()
    if (!trimmed) return
    setLastRunSql(trimmed)
    setResultClosed(false)
    setDangerPending(null)
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      cancelRequestedRef.current = false
      const token = canCancel ? newCancelToken() : null
      runTokenRef.current = token
      setRunToken(token)
      const res = await invoke<QueryResult>(txActive ? 'db_exec_in_tx' : 'execute_query', {
        id: connectionId, sql: markSql(trimmed, token), database: currentSchemaRef.current || undefined,
      })
      setResult(res)
      addHistory(connectionId, trimmed, true)
      if (txMode && !trimmed.toUpperCase().startsWith('SELECT')) setTxActive(true)
      setEditCtx(null)
    } catch (e) {
      setError(String(e))
      addHistory(connectionId, trimmed, false)
    } finally {
      lastElapsedRef.current = Date.now() - runStartRef.current
      setRunning(false)
      runTokenRef.current = null
      setRunToken(null)
      cancelRequestedRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, addHistory, txMode, txActive])

  // 运行选中 SQL
  const runSelected = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    const sel = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ).trim()
    runQuery(sel || sqlText)
  }, [sqlText, runQuery])
  const runSelectedRef = useRef(runSelected)
  runSelectedRef.current = runSelected
  const runQueryRef = useRef(runQuery)
  runQueryRef.current = runQuery

  // 取当前选中的 SQL（去空白），无选中返回 ''
  const getSelectedSql = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return ''
    return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).trim()
  }, [])

  // 导出：有选中导出选中，否则导出整页；多条语句给出提示并取第一条
  const handleExport = useCallback(() => {
    const sel = getSelectedSql()
    const target = (sel || sqlText).trim()
    if (!target) { toast.warning('没有可导出的 SQL'); return }
    const stmts = splitSqlStatements(target, connType)
    if (stmts.length > 1) {
      toast.warning(sel
        ? `选中含 ${stmts.length} 条语句，将导出第 1 条；如需指定请只选中单条`
        : `当前共 ${stmts.length} 条语句，将导出第 1 条；选中某条可单独导出`)
      setExportSql(stmts[0])
    } else {
      setExportSql(target)
    }
    setExportOpen(true)
  }, [getSelectedSql, sqlText])

  // 执行计划：把当前/选中 SQL 包成对应方言的 EXPLAIN 执行，结果走结果区
  const runExplain = useCallback(() => {
    const sel = getSelectedSql()
    const target = (sel || sqlText).trim()
    const stmts = splitSqlStatements(target, connType).filter(s => stripSqlComments(s) !== '')
    if (stmts.length === 0) return
    const base = stmts[0].replace(/;\s*$/, '')
    // 各数据库执行计划语法：
    // - MySQL/MariaDB/TiDB/OceanBase: EXPLAIN {sql}
    // - PG/KingBase/openGauss: EXPLAIN (FORMAT TEXT) {sql}
    // - SQLite: EXPLAIN QUERY PLAN {sql}
    // - DuckDB: EXPLAIN {sql}
    // - ClickHouse: EXPLAIN PLAN {sql}
    // - Oracle: EXPLAIN PLAN FOR {sql}; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)（两步）
    // - SQL Server: SET STATISTICS PROFILE ON; {sql}; SET STATISTICS PROFILE OFF
    let explainSql: string
    if (connType === 'sqlite') {
      explainSql = `EXPLAIN QUERY PLAN ${base}`
    } else if (isPgFamily(connType)) {
      explainSql = `EXPLAIN (FORMAT TEXT) ${base}`
    } else if (connType === 'oracle') {
      explainSql = `EXPLAIN PLAN FOR ${base};\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)`
    } else if (connType === 'sqlServer') {
      explainSql = `SET STATISTICS PROFILE ON\n${base}\nSET STATISTICS PROFILE OFF`
    } else if (connType === 'clickHouse') {
      explainSql = `EXPLAIN PLAN ${base}`
    } else {
      // MySQL/DuckDB/其他
      explainSql = `EXPLAIN ${base}`
    }
    runQuery(explainSql)
  }, [getSelectedSql, sqlText, connType, runQuery])

  // 编辑器剪贴板操作（供右键菜单）
  const editorClipboard = useCallback(async (op: 'copy' | 'cut' | 'paste') => {
    const view = editorViewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    try {
      if (op === 'copy' || op === 'cut') {
        const text = view.state.sliceDoc(from, to)
        if (text) await navigator.clipboard.writeText(text)
        if (op === 'cut' && from !== to) view.dispatch({ changes: { from, to, insert: '' } })
      } else {
        const text = await navigator.clipboard.readText()
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      }
      view.focus()
    } catch { /* 剪贴板不可用时忽略 */ }
  }, [])

  // 点击别处关闭编辑器右键菜单
  useEffect(() => {
    if (!editorCtx) return
    const close = () => setEditorCtx(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [editorCtx])

  // AssetPanel 树点击表 → 自动填入并执行
  useEffect(() => {
    if (!pendingSql) return
    setSqlDraft(pendingSql)
    runQueryRef.current(pendingSql)
    clearPendingRun(tabId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSql])

  // 从打开入口带过来的 schema：只切换当前库，不执行 USE
  useEffect(() => {
    if (!pendingSchema) return
    setCurrentSchema(pendingSchema)
    clearPendingSchema(tabId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSchema])

  // 模板填充（CREATE TABLE 等）→ 只填入编辑器，不执行
  useEffect(() => {
    if (!pendingFillSql) return
    setSqlDraft(pendingFillSql)
    if (pendingFillMeta?.savedQueryId) {
      markSqlSaved({ id: pendingFillMeta.savedQueryId, name: pendingFillMeta.savedQueryName ?? '' }, pendingFillSql)
    } else {
      setLinkedSavedQuery(null)
      setTabMeta(tabId, { savedQueryId: undefined, savedQueryName: undefined, savedSqlBaseline: undefined })
    }
    clearPendingFill(tabId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFillSql])

  // snippet 模板填充（带 ${占位} 的调用语句）→ 以代码片段方式插入：占位被选中，输入即替换、Tab 跳下一个
  const pendingSnippetTpl = useAppStore((s) => s.pendingSnippet[tabId])
  const clearPendingSnippet = useAppStore((s) => s.clearPendingSnippet)
  useEffect(() => {
    if (!pendingSnippetTpl) return
    let tries = 0
    const insert = () => {
      const view = editorViewRef.current
      if (!view) { if (tries++ < 40) requestAnimationFrame(insert); return }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
      snippet(pendingSnippetTpl)(view, null as never, 0, 0)
      setSqlDraft(view.state.doc.toString())
      view.focus()
      clearPendingSnippet(tabId)
    }
    insert()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSnippetTpl])

  // Mod+R 执行（外层 div 保底：编辑器未聚焦时仍可触发）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault()
      runSelectedRef.current()
    }
  }

  // SQL 方言：关键词补全按当前连接类型，避免提示无关方言关键词
  const sqlDialect = useMemo(() => {
    switch (connType) {
      case 'mysql': case 'tidb': case 'oceanBase':   return MySQL
      case 'mariadb':                                return MariaSQL
      case 'postgres': case 'kingBase': case 'openGauss': case 'duckdb': return PostgreSQL
      case 'sqlite':                                 return SQLite
      case 'sqlServer':                              return MSSQL
      default:                                       return StandardSQL
    }
  }, [connType])
  // SQL 扩展：当前方言关键字补全 + 自定义 schema 补全。
  // 不把 schema 交给 sql()（其内置别名解析对子查询失效），改用自建补全源：
  //   成员访问 `别名.` → 全文扫描(含子查询)解析表后给列名；其余交回 schemaCompletionSource。
  const sqlExt = useMemo(() => {
    const langSupport = sql({ dialect: sqlDialect, upperCaseKeywords: true })  // 仅关键字补全
    const schemaSrc = schemaCompletionSource({ dialect: sqlDialect, schema: dbSchema })
    const combined: CompletionSource = (ctx) => memberCompletion(ctx, dbSchema) ?? schemaSrc(ctx)
    return [langSupport, langSupport.language.data.of({ autocomplete: combined })]
  }, [dbSchema, sqlDialect])

  // KB0.3 — CodeMirror 快捷键从 settingsStore 动态生成（改键即时生效）
  // settingsStore combo "Mod+R" → CodeMirror key "Mod-r"
  // 注意：CodeMirror 中单字母键必须小写，大写会被当成需要 Shift，导致快捷键失效
  const cmKey = (id: string, fallback: string) =>
    (shortcuts[id] ?? fallback).replace(/\+/g, '-').replace(/-([A-Za-z])$/, (_, c: string) => '-' + c.toLowerCase())

  // 工具栏 tooltip 用：取快捷键显示串
  const sc = (id: string) => displayShortcutStr(shortcuts[id] ?? '')

  // Prec.highest：覆盖 CodeMirror 默认键位（如 Mod+D 选下一处），确保我们的绑定生效
  const sqlKeymap = useMemo(() => Prec.highest(keymap.of([
    // 执行：Mod+R（选中或全部）；Mod+Shift+R 执行选中
    { key: cmKey('sqlRunAll',     'Mod+R'),       preventDefault: true, run: () => { runSelectedRef.current(); return true } },
    { key: cmKey('sqlRunSelected','Mod+Shift+R'), preventDefault: true, run: () => { runSelectedRef.current(); return true } },
    { key: cmKey('sqlDupLine',    'Mod+D'),       preventDefault: true, run: copyLineDown },
    { key: cmKey('sqlDelLine',    'Mod+E'),       preventDefault: true, run: deleteLine },
    // 显式占用 Mod+Shift+E（执行计划），否则 CodeMirror 的 shift 回退会让它落到 Mod+E=删除行
    { key: cmKey('sqlExplain',    'Mod+Shift+X'), preventDefault: true, run: () => { if (sqlText.trim()) runExplain(); return true } },
    { key: cmKey('sqlCopyLineUp',   'Alt+Shift+ArrowUp'),   run: copyLineUp },
    { key: cmKey('sqlCopyLineDown', 'Alt+Shift+ArrowDown'), run: copyLineDown },
    { key: cmKey('sqlComment',    'Mod+/'),       preventDefault: true, run: toggleLineComment },
  ])), [shortcuts, sqlText, runExplain])


  // KB1 SQL 编辑器快捷键（非 CodeMirror 部分：格式化、说明、历史、保存）
  // 仅当本查询标签为激活标签时才响应区域快捷键，避免按键"冒泡"到隐藏的其它标签
  const isActiveTab = useAppStore(s => s.activeAId === tabId || s.activeBId === tabId)
  useShortcuts('sql-editor', {
    sqlFormat:     () => { if (sqlText.trim()) formatSqlRef.current?.() },
    sqlExplain:    () => { if (sqlText.trim()) runExplain() },
    sqlHistory:    () => setHistoryOpen(v => !v),
    sqlSave:       () => setSavedOpen(v => !v),
    sqlStop:       () => { if (running) stopQuery() },
    sqlFocusEditor:() => { editorViewRef.current?.focus() },
    sqlTxCommit:   () => { if (txActive) setTxShortcutConfirm('commit') },
    sqlTxRollback: () => { if (txActive) setTxShortcutConfirm('rollback') },
    sqlToggleResult: () => setResultCollapsed(v => !v),
    dbNewQuery:    () => openQueryTab(connectionId),
  }, isActiveTab)

  const formatSqlRef = useRef<() => void>()

  // 格式化前的原文：用于「再点一次还原」
  const preFormatRef = useRef<string | null>(null)
  const formatSql = useCallback(async () => {
    // 已格式化过 → 再点还原
    if (preFormatRef.current !== null) {
      const orig = preFormatRef.current
      preFormatRef.current = null
      setSqlDraft(orig)
      return
    }
    try {
      const { format } = await import('sql-formatter')
      const dialect =
        ['postgres', 'kingBase', 'openGauss'].includes(connType) ? 'postgresql'
        : connType === 'duckdb' ? 'sql'
        : connType === 'sqlite' ? 'sqlite'
        : connType === 'oracle' ? 'plsql'
        : connType === 'sqlServer' ? 'transactsql'
        : connType === 'clickHouse' ? 'sql'
        : connType === 'mariadb' ? 'mariadb'
        : 'mysql'
      const formatted = format(sqlText, { language: dialect as any, tabWidth: 2, keywordCase: 'upper' })
      if (formatted !== sqlText) preFormatRef.current = sqlText  // 记住原文以便还原
      setSqlDraft(formatted)
    } catch { /* fallback: leave as-is */ }
  }, [sqlText, connType, tabId])
  // keep ref in sync so the shortcut handler can call it without stale closure
  formatSqlRef.current = formatSql

  const runTx = useCallback(async (stmt: 'BEGIN' | 'COMMIT' | 'ROLLBACK') => {
    setRunning(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (stmt === 'BEGIN') {
        await invoke('db_begin_tx', { id: connectionId })
        setTxActive(true)
      } else if (stmt === 'COMMIT') {
        await invoke('db_commit_tx', { id: connectionId })
        setTxActive(false)
        setResult(null)
      } else {
        await invoke('db_rollback_tx', { id: connectionId })
        setTxActive(false)
        setResult(null)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }, [connectionId])

  return (
    <div className="sql-editor-layout">
      <EnvWatermark envLabel={activeConn?.envLabel} readonly={activeConn?.readonly ?? activeConn?.readOnly} />

      {/* DB 对象浏览器分屏面板 */}
      {dbPanelOpen && (
        <>
          <div style={{ width: dbPanelWidth, flexShrink: 0 }}>
            <DbBrowser
              connectionId={connectionId}
              connType={connType}
              currentSchema={currentSchema}
              onInsertText={(text) => {
                const view = editorViewRef.current
                if (!view) return
                const { from, to } = view.state.selection.main
                view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
                view.focus()
              }}
              onPreviewTable={(schema, table) => {
                // 按方言包裹标识符引号
                const qi = (n: string) =>
                  connType === 'sqlServer' ? `[${n}]`
                  : ['mysql', 'mariadb', 'tidb', 'oceanBase', 'clickHouse'].includes(connType) ? `\`${n}\``
                  : `"${n}"`
                const tbl = schema ? `${qi(schema)}.${qi(table)}` : qi(table)
                const previewSql =
                  connType === 'sqlServer'
                    ? `SELECT TOP 50 * FROM ${tbl}`
                    : connType === 'oracle'
                    ? `SELECT * FROM ${tbl} FETCH FIRST 50 ROWS ONLY`
                    : `SELECT * FROM ${tbl} LIMIT 50`
                // 同步更新编辑器文本，再执行（保持结果区与编辑器一致）
                setSqlDraft(previewSql)
                runQuery(previewSql)
              }}
            />
          </div>
          {/* 拖拽分隔线 */}
          <div
            onMouseDown={startDbPanelDrag}
            style={{ width: 4, cursor: 'col-resize', background: 'var(--border)', flexShrink: 0, position: 'relative', zIndex: 1 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--border)')}
          />
        </>
      )}

      {/* editor + results */}
      <div className="sql-editor-main">
        {/* Toolbar：会话 + 库 与功能键同一行 */}
        <div className="sql-toolbar">
          {!isSqlite && (
            <>
              <Database size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginRight: 2 }} />
              <SearchableSelect value={connectionId} mono={false} searchPlaceholder="搜索连接…" width={150}
                items={connections.filter(c => c.type !== 'ssh' && c.type !== 'local').map(c => ({ value: c.id, label: c.name }))}
                onChange={(cid) => {
                  if (cid === connectionId) return
                  openQueryTab(cid)
                }} />
              <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <SearchableSelect value={currentSchema} onChange={setCurrentSchema}
                options={schemas} mono={false} placeholder="选择库" searchPlaceholder="搜索库…" width={180} />
              <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 8px', flexShrink: 0 }} />
            </>
          )}
          {/* 主操作 */}
          <button
            className={`sql-run-btn${running ? ' sql-run-btn--stop' : ''}`}
            onClick={() => { if (running) stopQuery(); else runSelectedRef.current() }}
            data-tip={running
              ? (runToken ? '停止当前查询并取消后续查询' : '取消后续查询')
              : '执行（有选中则只执行选中部分）'}
            data-shortcut={running ? sc('sqlStop') : sc('sqlRunAll')}
          >
            {running ? <StopCircle size={13} strokeWidth={2.5} /> : <Play size={13} strokeWidth={2.5} />}
            {running ? '停止' : '执行'}
          </button>

          <button className="sql-tool-btn" onClick={() => openQueryTab(connectionId)} data-tip="新建查询标签" data-shortcut={sc('dbNewQuery')}>
            <FilePlus2 size={14} strokeWidth={2} />
          </button>

          {/* 编辑操作组 */}
          <button className="sql-tool-btn" onClick={() => { setResult(null); setError(''); setMultiResults([]) }} data-tip="清除结果">
            <RotateCcw size={14} strokeWidth={2} />
          </button>
          <button className="sql-tool-btn" onClick={formatSql} data-tip="格式化 SQL" data-shortcut={sc('sqlFormat')} disabled={!sqlText.trim()}>
            <AlignLeft size={14} strokeWidth={2} />
          </button>
          <button className="sql-tool-btn" onClick={() => setSavedOpen(true)} data-tip="保存查询（有选中则存选中片段）" data-shortcut={sc('sqlSave')} disabled={!sqlText.trim()}>
            <Bookmark size={14} strokeWidth={2} />
          </button>
          <button className="sql-tool-btn" onClick={handleExport} data-tip="导出（有选中则导出选中 SQL，否则整页；流式支持大结果集）" disabled={!sqlText.trim()}>
            <Download size={14} strokeWidth={2} />
          </button>
          {/* db_explain 仅支持 MySQL 族 / PG 族 / sqlite / duckdb，其余类型隐藏执行计划按钮 */}
          {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'].includes(connType) && (
            <button className="sql-tool-btn" onClick={runExplain} data-tip="EXPLAIN 执行计划" data-shortcut={sc('sqlExplain')} disabled={!sqlText.trim()}>
              <Zap size={14} strokeWidth={2} />
            </button>
          )}

          {/* 更多工具（合并面板组到一个下拉） */}
          <div className="sql-toolbar__sep" />
          <div className="sql-more" style={{ position: 'relative' }}>
            <button className={`sql-tool-btn${moreOpen ? ' active' : ''}`} onClick={() => setMoreOpen(v => !v)} data-tip="更多工具">
              <MoreHorizontal size={14} strokeWidth={2} />
            </button>
            {moreOpen && (
              <div className="sql-more-menu" onMouseLeave={() => setMoreOpen(false)}>
                <button onClick={() => { setDbaOpen(true); setMoreOpen(false) }}><BookOpen size={14} />DBA 诊断模板库</button>
                <button onClick={() => { setHistoryOpen(true); setMoreOpen(false) }}><History size={14} />查询历史<span className="sql-more-menu__sc">{sc('sqlHistory')}</span></button>
                <button onClick={() => { setAuditOpen(true); setMoreOpen(false) }}><ClipboardList size={14} />操作审计日志</button>
                <button onClick={() => { setRollbackOpen(true); setMoreOpen(false) }}><Undo2 size={14} />回滚 SQL 存档</button>
                {connType === 'sqlite' && (
                  <button onClick={() => { setSqliteAdminOpen(true); setMoreOpen(false) }}><Database size={14} />SQLite 维护诊断</button>
                )}
                {connType === 'duckdb' && (
                  <>
                    <button onClick={() => { setDuckAdminOpen(true); setMoreOpen(false) }}><Database size={14} />DuckDB 连接信息</button>
                    <button onClick={() => { setDuckLakeOpen(true); setMoreOpen(false) }}><Layers size={14} />数据湖查询</button>
                    <button onClick={() => { setDuckDiffOpen(true); setMoreOpen(false) }}><GitBranch size={14} />双库 schema 对比</button>
                    <button onClick={() => { setDuckMaskOpen(true); setMoreOpen(false) }}><ShieldAlert size={14} />脱敏导出</button>
                    <button onClick={async () => {
                      setMoreOpen(false)
                      try {
                        const { open } = await import('@tauri-apps/plugin-dialog')
                        const picked = await open({
                          title: '选择外部数据文件',
                          multiple: false,
                          filters: [
                            { name: '数据文件', extensions: ['parquet', 'csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls'] },
                            { name: '所有文件', extensions: ['*'] },
                          ],
                        })
                        if (!picked || Array.isArray(picked)) return
                        setDuckFileQueryPath(typeof picked === 'string' ? picked : null)
                      } catch { /* 用户取消 */ }
                    }}><FolderOpen size={14} />查询外部文件</button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 右侧事务区（收进下拉） */}
          <div className="sql-toolbar__sep" style={{ marginLeft: 'auto' }} />
          {txActive && <span className="sql-tx-badge">事务进行中</span>}
          {/* DB 对象浏览器切换 */}
          <button
            className={`sql-tool-btn${dbPanelOpen ? ' active' : ''}`}
            onClick={toggleDbPanel}
            data-tip={dbPanelOpen ? '关闭对象浏览器' : '打开对象浏览器（分屏）'}
          >
            <PanelLeft size={14} strokeWidth={2} />
          </button>
          <div className="sql-more" style={{ position: 'relative' }}>
            <button
              className={`sql-tool-btn${(txMode || txMenuOpen) ? ' active' : ''}`}
              onClick={() => setTxMenuOpen(v => !v)}
              data-tip="事务控制"
            >
              <GitBranch size={14} strokeWidth={2} />
            </button>
            {txMenuOpen && (
              <div className="sql-more-menu sql-more-menu--right sql-tx-menu" onMouseLeave={() => setTxMenuOpen(false)}>
                <div className="sql-tx-menu__head">事务控制</div>
                {/* 模式开关：直接显示当前状态 */}
                <button className="sql-tx-menu__mode" onClick={() => { setTxMode(v => !v); setTxActive(false) }}>
                  <span>手动提交模式</span>
                  <span className={`sql-tx-switch${txMode ? ' on' : ''}`}><span className="sql-tx-switch__dot" /></span>
                </button>
                {connType === 'clickHouse' ? (
                  <div className="sql-tx-menu__hint">ClickHouse 不支持传统事务（MergeTree 引擎按块原子写入）。</div>
                ) : (
                  <>
                    {!txMode && (
                      <div className="sql-tx-menu__hint">
                        {connType === 'oracle'
                          ? 'Oracle 事务：BEGIN 建立持久连接，DML 不自动提交，确认后 COMMIT，出错可 ROLLBACK 全部撤销。'
                          : '开启后：BEGIN 暂存改动，确认无误 COMMIT 提交，出错可 ROLLBACK 全部撤销。'}
                      </div>
                    )}
                    {txMode && (
                      <>
                        <div className="sql-more-menu__div" />
                        <button disabled={txActive || running} onClick={() => runTx('BEGIN')}>
                          <Play size={14} />开始事务（BEGIN）
                        </button>
                        <button disabled={!txActive || running} onClick={() => { runTx('COMMIT'); setTxMenuOpen(false) }}>
                          <Database size={14} />提交（COMMIT）
                        </button>
                        <button disabled={!txActive || running} onClick={() => { runTx('ROLLBACK'); setTxMenuOpen(false) }}>
                          <Undo2 size={14} />回滚（ROLLBACK）
                        </button>
                        <div className="sql-tx-menu__status" style={{ color: txActive ? 'var(--warning)' : 'var(--text-muted)' }}>
                          {txActive ? '● 事务进行中，记得提交或回滚' : '未开始 · 点「开始事务」'}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Editor */}
        <div className="sql-editor-wrap" onKeyDown={handleKeyDown}
          onContextMenu={(e) => {
            e.preventDefault()
            setEditorCtx({ x: e.clientX, y: e.clientY, hasSel: !!getSelectedSql() })
          }}>
          <CodeMirror
            value={sqlText}
            height="100%"
            extensions={[sqlExt, sqlKeymap, snippetNavKeymap, modClickExt, tableHoverField, tableHoverExt, sqlHighlight, _editorTooltips, cmSearchPhrases]}
            theme={isDark ? _editorDark : _editorLight}
            onCreateEditor={(view) => { editorViewRef.current = view }}
            onChange={(val) => { setSqlDraft(val); preFormatRef.current = null }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: false,
              dropCursor: false,
              allowMultipleSelections: false,
              indentOnInput: true,
              syntaxHighlighting: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: false,
              crosshairCursor: false,
              highlightSelectionMatches: false,
            }}
            style={{ height: '100%', fontSize: 13 }}
          />
        </div>

        {/* Results：Navicat 风格 —— 消息 / 摘要 / 结果N 页签 */}
        {!resultClosed && (running || result !== null || !!error || multiResults.length > 0) && (() => {
          // 执行消息日志（dataResults/dataIdx/activeData 用组件级 hoisted 版本）
          // 当前正在执行的语句下标（首个既无结果也无错误者）
          const curIdx = multiResults.findIndex(m => !m.result && !m.error && !m.cancelled)
          type MsgStatus = 'ok' | 'err' | 'cancelled' | 'running' | 'pending'
          const msgs: Array<{ sql: string; status: MsgStatus; ok: boolean; error: string; hasCols: boolean; rows: number; affected: number; ms: number }> = multiResults.length > 0
            ? multiResults.map((m, i) => {
                const status: MsgStatus = m.cancelled ? 'cancelled' : m.error ? 'err' : m.result ? 'ok' : (running && i === curIdx ? 'running' : 'pending')
                return { sql: m.sql, status, ok: status === 'ok', error: m.error, hasCols: !!(m.result && (m.result.columns.length > 0 || m.result.isSelect)), rows: m.result?.rows.length ?? 0, affected: m.result?.rowsAffected ?? 0, ms: m.result?.executionTimeMs ?? 0 }
              })
            : error ? [{ sql: lastRunSql, status: 'err', ok: false, error, hasCols: false, rows: 0, affected: 0, ms: lastElapsedRef.current }]
            : result ? [{ sql: lastRunSql, status: 'ok', ok: true, error: '', hasCols: result.columns.length > 0 || !!result.isSelect, rows: result.rows.length, affected: result.rowsAffected, ms: result.executionTimeMs }]
            : []
          const hasMulti = multiResults.length > 1
          const okCount = msgs.filter(m => m.status === 'ok').length
          const errCount = msgs.filter(m => m.status === 'err').length
          const cancelledCount = msgs.filter(m => m.status === 'cancelled').length
          const doneCount = okCount + errCount + cancelledCount
          const totalMs = msgs.reduce((s, m) => s + m.ms, 0)
          // DataGrip 风格消息日志：[起始时间] schema> SQL ；[结束时间] 结果 + 耗时(总/执行/拉取)
          const startTs = runStartRef.current || Date.now()
          const runTotal = lastElapsedRef.current || totalMs   // 整次执行墙钟耗时
          const endTs = startTs + runTotal
          const fmtTs = (t: number) => {
            const d = new Date(t)
            const p = (n: number) => String(n).padStart(2, '0')
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
          }
          const schemaPrompt = currentSchema || activeConn?.database || ''
          // 单条查询能算出总/执行/拉取拆分；多条按各自执行时长展示
          const resultText = (m: typeof msgs[number]) => {
            if (m.status === 'cancelled') return '查询已取消'
            if (!m.ok) return m.error
            if (m.hasCols) {
              if (!hasMulti) {
                const exec = m.ms
                const fetch = Math.max(0, runTotal - exec)
                return `返回 ${m.rows} 行，起始第 1 行，耗时 ${formatDuration(runTotal)}（执行 ${formatDuration(exec)}，拉取 ${formatDuration(fetch)}）`
              }
              return `返回 ${m.rows} 行，耗时 ${formatDuration(m.ms)}`
            }
            return `执行成功，影响 ${m.affected} 行，耗时 ${formatDuration(hasMulti ? m.ms : runTotal)}`
          }
          return (
        <div className={`sql-result-pane${resultCollapsed ? ' collapsed' : ''}`} style={resultCollapsed ? undefined : { height: resultH }}>
          {/* 独立的上下拖拽手柄：拖它改结果区高度（与头部栏解耦） */}
          {!resultCollapsed && (
            <div className="sql-vresizer" onMouseDown={startResize} data-tip="拖拽调整结果区高度" />
          )}
          {/* 头条：页签 + 收起/展开 */}
          <div className="sql-result-head">
            <div className="sql-rtabs" onMouseDown={e => e.stopPropagation()}>
              <button className={`sql-rtab${resultTab === 'msg' ? ' active' : ''}`} onClick={() => setResultTab('msg')}>
                消息{errCount > 0 && <span className="sql-rtab__dot" />}
              </button>
              {msgs.length > 0 && (
                <button className={`sql-rtab${resultTab === 'sum' ? ' active' : ''}`} onClick={() => setResultTab('sum')}>摘要</button>
              )}
              {dataResults.map((_d, i) => (
                <button key={i} className={`sql-rtab${resultTab === i ? ' active' : ''}`} onClick={() => setResultTab(i)}>
                  结果{i + 1}
                </button>
              ))}
            </div>
            <div className="sql-result-head__tools" ref={setHeadSlot} onMouseDown={e => e.stopPropagation()} />
            <button className="sql-result-head__toggle" onMouseDown={e => e.stopPropagation()}
              onClick={() => setResultCollapsed(v => !v)}
              data-tip={resultCollapsed ? '展开结果区' : '收起结果区'} data-shortcut={sc('sqlToggleResult')}>
              {resultCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            <button className="sql-result-head__toggle" onMouseDown={e => e.stopPropagation()}
              onClick={() => setResultClosed(true)} data-tip="关闭结果区（再次执行自动打开）">
              <X size={15} />
            </button>
          </div>
          {!resultCollapsed && (
          <div className="sql-result-body">
            {running && !hasMulti ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, height: '100%', color: 'var(--text-muted)' }}>
                <Loader2 size={22} className="spin" style={{ color: 'var(--accent)' }} />
                <div style={{ fontSize: 13 }}>执行中… <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{(elapsedMs / 1000).toFixed(1)}s</span></div>
                {runToken ? (
                  <button className="sql-stop-btn" onClick={stopQuery}>
                    <StopCircle size={14} /> 停止查询
                  </button>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>此连接类型不支持中途取消</span>
                )}
              </div>
            ) : resultTab === 'msg' ? (
              <div className="sql-msglog">
                {(() => { const done = msgs.filter(m => m.status === 'ok' || m.status === 'err' || m.status === 'cancelled'); return done.length === 0 ? <div className="sql-msglog__empty">{running ? '执行中…' : '暂无消息'}</div> : done.map((m, i) => (
                  <div key={i} className="sql-msglog__item">
                    <div className="sql-msglog__sql">
                      <span className="sql-msglog__ts">[{fmtTs(startTs)}]</span>{' '}
                      {schemaPrompt && <span className="sql-msglog__prompt">{schemaPrompt}&gt; </span>}{m.sql}
                    </div>
                    <div className={m.ok ? 'sql-msglog__ok' : 'sql-msglog__err'}>
                      <span className="sql-msglog__ts">[{fmtTs(endTs)}]</span> {resultText(m)}
                    </div>
                  </div>
                )) })()}
              </div>
            ) : resultTab === 'sum' ? (
              <div className="sql-summary">
                <div className="sql-summary__stats">
                  {running ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent)' }}>
                      <Loader2 size={13} className="spin" /> 执行中 <b>{doneCount}</b> / {msgs.length}
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginLeft: 4 }}>{(elapsedMs / 1000).toFixed(1)}s</span>
                    </span>
                  ) : (
                    <span>已处理 <b>{msgs.length}</b></span>
                  )}
                  <span className="sql-summary__stat-ok">成功 <b>{okCount}</b></span>
                  {errCount > 0 && <span className="sql-summary__stat-err">错误 <b>{errCount}</b></span>}
                  {cancelledCount > 0 && <span style={{ color: 'var(--text-muted)' }}>取消 <b>{cancelledCount}</b></span>}
                  {running ? (
                    <button className="sql-stop-btn sql-stop-btn--compact" onClick={stopQuery}>
                      <StopCircle size={12} /> 停止
                    </button>
                  ) : (
                    <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>总耗时 <b style={{ color: 'var(--text)' }}>{formatDuration(totalMs)}</b></span>
                  )}
                </div>
                <div className="sql-summary__tablewrap">
                  <table className="sql-summary__table">
                    <colgroup>
                      <col style={{ width: 28 }} />
                      <col style={{ width: 36 }} />
                      <col style={{ width: 60 }} />
                      <col style={{ width: '30%' }} />
                      <col />
                      <col style={{ width: 72 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th />
                        <th style={{ textAlign: 'center' }}>#</th>
                        <th>状态</th>
                        <th>SQL</th>
                        <th>消息</th>
                        <th style={{ textAlign: 'right' }}>耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {msgs.map((m, i) => {
                        const msgText = m.status === 'ok' ? (m.hasCols ? `查询 ${m.rows} 行` : `影响 ${m.affected} 行`)
                          : m.status === 'err' ? (m.error ?? '')
                          : m.status === 'cancelled' ? '查询已取消'
                          : m.status === 'running' ? '执行中…' : '等待中'
                        const openCtx = (e: React.MouseEvent) => {
                          e.stopPropagation()
                          setSumCtx({ x: e.clientX, y: e.clientY, sql: m.sql, msg: msgText })
                        }
                        return (
                          <tr key={i} className={`sql-summary__row ${m.status === 'err' ? 'sql-summary__row--err' : ''}`}>
                            <td className="sql-summary__row-copy-cell">
                              <button
                                className="sql-summary__row-copy-btn"
                                data-tip="复制整行（SQL + 消息）"
                                onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(`SQL: ${m.sql}\n消息: ${msgText}`).then(() => toast.success('已复制')).catch(() => {}) }}
                              ><Copy size={11} /></button>
                            </td>
                            <td className="sql-summary__num">{i + 1}</td>
                            <td>
                              {m.status === 'ok' ? (
                                <span className="sql-summary__badge sql-summary__badge--ok">成功</span>
                              ) : m.status === 'err' ? (
                                <span className="sql-summary__badge sql-summary__badge--err">错误</span>
                              ) : m.status === 'cancelled' ? (
                                <span className="sql-summary__badge" style={{ color: 'var(--text-muted)', background: 'transparent' }}>取消</span>
                              ) : m.status === 'running' ? (
                                <span className="sql-summary__badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', background: 'transparent' }}>
                                  <Loader2 size={11} className="spin" /> 执行中
                                </span>
                              ) : (
                                <span className="sql-summary__badge" style={{ color: 'var(--text-muted)', background: 'transparent' }}>等待</span>
                              )}
                            </td>
                            <td className="sql-summary__sql sql-summary__cell--copy" data-tip="点击选择复制内容" onClick={openCtx}>{m.sql}</td>
                            <td className={`sql-summary__msg sql-summary__cell--copy ${m.status === 'err' ? 'sql-summary__msg--err' : ''}`} data-tip="点击选择复制内容" onClick={openCtx}>{msgText}</td>
                            <td className="sql-summary__time">{m.status === 'ok' || m.status === 'err' ? formatDuration(m.ms) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {sumCtx && createPortal(
                  <div className="sum-ctx-menu" style={{ top: sumCtx.y, left: sumCtx.x }} onMouseDown={e => e.stopPropagation()}>
                    <button className="sum-ctx-menu__item" onClick={() => { navigator.clipboard.writeText(sumCtx.sql).then(() => toast.success('已复制 SQL')).catch(() => {}); setSumCtx(null) }}>
                      <Copy size={12} />复制 SQL
                    </button>
                    <button className="sum-ctx-menu__item" onClick={() => { navigator.clipboard.writeText(sumCtx.msg).then(() => toast.success('已复制消息')).catch(() => {}); setSumCtx(null) }}>
                      <Copy size={12} />复制消息
                    </button>
                    <div className="sum-ctx-menu__divider" />
                    <button className="sum-ctx-menu__item" onClick={() => { navigator.clipboard.writeText(`SQL: ${sumCtx.sql}\n消息: ${sumCtx.msg}`).then(() => toast.success('已复制')).catch(() => {}); setSumCtx(null) }}>
                      <Copy size={12} />复制整行
                    </button>
                  </div>,
                  document.body
                )}
              </div>
            ) : activeData ? (
              <>
                {mariaEngineWarn && editCtx && (
                  <div style={{ padding: '4px 12px', background: 'rgba(234,88,12,0.08)', borderBottom: '1px solid rgba(234,88,12,0.25)', fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    ⚠ {mariaEngineWarn}
                  </div>
                )}
                <ResultTable
                  result={activeData.result}
                  running={false}
                  error=""
                  active={isActiveTab}
                  connectionId={connectionId}
                  connType={connType}
                  toolbarSlot={headSlot}
                  editCtx={editCtx}
                  queryLimit={queryLimit}
                  onQueryLimitChange={(newLimit) => {
                    setQueryLimit(newLimit)
                    runQuery(activeData.sql, newLimit)
                  }}
                  onRefresh={() => runQuery(activeData.sql)}
                  onCellUpdate={(rowIdx, colIdx, val) => {
                    const upd = (res: QueryResult): QueryResult => ({ ...res, rows: res.rows.map((r, i) => i === rowIdx ? r.map((c, j) => j === colIdx ? val : c) : r) })
                    if (activeData.srcIndex < 0) setResult(prev => prev ? upd(prev) : prev)
                    else setMultiResults(prev => prev.map((m, i) => i === activeData.srcIndex && m.result ? { ...m, result: upd(m.result) } : m))
                  }}
                />
              </>
            ) : (
              <div className="result-placeholder"><span>无结果集，请查看「消息」</span></div>
            )}
          </div>
          )}
        </div>
          )
        })()}
      </div>

      {/* 查询历史侧栏（可左右拖拽改宽） */}
      {historyOpen && (
        <>
          <div className="qh-resizer" onMouseDown={startHistoryResize} data-tip="拖拽调整查询历史宽度" />
          <Suspense fallback={null}>
            <QueryHistoryPanel
              connectionId={connectionId}
              width={historyWidth}
              onPick={insertSqlAtCursor}
              onSaveAsQuery={(sql) => { setSaveSqlOverride(sql); setHistoryOpen(false); setSavedOpen(true) }}
              onClose={() => setHistoryOpen(false)}
            />
          </Suspense>
        </>
      )}

      {/* 表预览弹窗：DDL + 近期数据（mod+点击表名触发） */}
      {peek && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <TablePeekModal
            connectionId={connectionId}
            connType={connType}
            schema={peek.schema}
            table={peek.table}
            onClose={() => setPeek(null)}
          />
        </Suspense>
      )}

      {/* 函数/存过定义弹窗（mod+点击例程名触发） */}
      {routinePeek && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DdlModal
            schema={currentSchema}
            table={routinePeek.name}
            ddl={routinePeek.ddl}
            loading={routinePeek.loading}
            error={routinePeek.error}
            connType={connType}
            onClose={() => setRoutinePeek(null)}
          />
        </Suspense>
      )}

      {/* 流式导出对话框 */}
      {exportOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <ExportDialog
            connectionId={connectionId}
            sqlText={exportSql || sqlText}
            schema={currentSchema}
            connType={connType}
            onClose={() => setExportOpen(false)}
          />
        </Suspense>
      )}

      {/* 编辑器右键菜单 */}
      {editorCtx && createPortal(
        <div className="sql-ctx-menu" style={{ position: 'fixed', left: editorCtx.x, top: editorCtx.y }}
          onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => { setEditorCtx(null); runSelectedRef.current() }}>
            <Play size={13} />执行<span className="sql-ctx-menu__sc">{sc('sqlRunAll')}</span>
          </button>
          <button disabled={!editorCtx.hasSel} onClick={() => { setEditorCtx(null); runSelectedRef.current() }}>
            <Play size={13} />执行选中<span className="sql-ctx-menu__sc">{sc('sqlRunSelected')}</span>
          </button>
          {/* db_explain 仅支持 MySQL 族 / PG 族 / sqlite / duckdb */}
          {['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'].includes(connType) && (
            <button disabled={!sqlText.trim()} onClick={() => { setEditorCtx(null); runExplain() }}>
              <Zap size={13} />执行计划<span className="sql-ctx-menu__sc">{sc('sqlExplain')}</span>
            </button>
          )}
          <div className="sql-ctx-menu__div" />
          <button disabled={!sqlText.trim()} onClick={() => { setEditorCtx(null); formatSql() }}>
            <AlignLeft size={13} />格式化<span className="sql-ctx-menu__sc">{sc('sqlFormat')}</span>
          </button>
          <button disabled={!sqlText.trim()} onClick={() => {
            setEditorCtx(null)
            const view = editorViewRef.current
            if (view) { toggleLineComment(view); view.focus() }
          }}>
            <Hash size={13} />注释/取消注释<span className="sql-ctx-menu__sc">{sc('sqlComment')}</span>
          </button>
          <button disabled={!sqlText.trim()} onClick={() => {
            setEditorCtx(null)
            const view = editorViewRef.current
            if (view) { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus() }
          }}>
            <span style={{ width: 13 }} />全选<span className="sql-ctx-menu__sc">{displayShortcutStr('Mod+A')}</span>
          </button>
          <button disabled={!sqlText.trim()} onClick={() => { setEditorCtx(null); handleExport() }}>
            <Download size={13} />导出{editorCtx.hasSel ? '选中' : ''}
          </button>
          <div className="sql-ctx-menu__div" />
          <button disabled={!editorCtx.hasSel} onClick={() => { setEditorCtx(null); editorClipboard('copy') }}>
            复制<span className="sql-ctx-menu__sc">{displayShortcutStr('Mod+C')}</span>
          </button>
          <button disabled={!editorCtx.hasSel} onClick={() => { setEditorCtx(null); editorClipboard('cut') }}>
            剪切<span className="sql-ctx-menu__sc">{displayShortcutStr('Mod+X')}</span>
          </button>
          <button onClick={() => { setEditorCtx(null); editorClipboard('paste') }}>
            粘贴<span className="sql-ctx-menu__sc">{displayShortcutStr('Mod+V')}</span>
          </button>
        </div>,
        document.body
      )}

      {/* 保存的查询 */}
      {savedOpen && (() => {
        // 来自「查询历史 → 保存为查询」：直接用指定 SQL；否则自动取选中片段/整个查询标签
        const view = editorViewRef.current
        const selText = !saveSqlOverride && view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to).trim() : ''
        const isSel = !saveSqlOverride && selText.length > 0
        const sql = saveSqlOverride ?? (isSel ? selText : sqlText)
        const firstLine = sql.split('\n').map(l => l.trim()).find(Boolean) ?? ''
        const linkedQuery = !saveSqlOverride && !isSel ? linkedSavedQuery : null
        return (
          <SavedQueriesPanel
            connectionId={connectionId}
            schema={currentSchema}
            sql={sql}
            isSelection={isSel}
            defaultName={isSel ? '' : (linkedQuery?.name || firstLine.slice(0, 40))}
            savedQueryId={linkedQuery?.id}
            onSaved={saved => { if (!isSel && !saveSqlOverride) markSqlSaved(saved, sql) }}
            onClose={() => { setSavedOpen(false); setSaveSqlOverride(null) }}
          />
        )
      })()}

      {/* DBA 诊断模板库 */}
      {dbaOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DbaTemplatesPanel
            connType={connType}
            onRun={sql => { setSqlDraft(sql); runQuery(sql); setDbaOpen(false) }}
            onClose={() => setDbaOpen(false)}
          />
        </Suspense>
      )}

      {/* I3 审计日志面板 */}
      {auditOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <AuditLogPanel connectionId={connectionId} onClose={() => setAuditOpen(false)} />
        </Suspense>
      )}

      {/* R6 回滚 SQL 存档 */}
      {rollbackOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <RollbackSqlPanel
            connectionId={connectionId}
            onInsertSql={sql => { setSqlDraft(sql) }}
            onClose={() => setRollbackOpen(false)}
          />
        </Suspense>
      )}

      {/* S0 SQLite 维护诊断面板 */}
      {sqliteAdminOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <SqliteAdminPanel
            connectionId={connectionId}
            onClose={() => setSqliteAdminOpen(false)}
          />
        </Suspense>
      )}

      {/* DD0.4 DuckDB 连接信息面板 */}
      {duckAdminOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DuckDbAdminPanel
            connectionId={connectionId}
            onClose={() => setDuckAdminOpen(false)}
          />
        </Suspense>
      )}
      {duckLakeOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DuckLakePanel
            connectionId={connectionId}
            onClose={() => setDuckLakeOpen(false)}
          />
        </Suspense>
      )}
      {duckDiffOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DuckDbDiffPanel
            connectionId={connectionId}
            onClose={() => setDuckDiffOpen(false)}
          />
        </Suspense>
      )}
      {duckMaskOpen && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DuckMaskExportPanel
            connectionId={connectionId}
            onClose={() => setDuckMaskOpen(false)}
          />
        </Suspense>
      )}

      {/* DD2.2 DuckDB 外部文件预览对话框 */}
      {duckFileQueryPath && (
        <Suspense fallback={<LazySqlPanelFallback />}>
          <DuckFileQueryDialog
            connectionId={connectionId}
            filePath={duckFileQueryPath}
            onInsertSql={(s) => { setSqlDraft(s) }}
            onClose={() => setDuckFileQueryPath(null)}
          />
        </Suspense>
      )}

      {/* KB1.4 事务快捷键确认弹窗 */}
      {txShortcutConfirm && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setTxShortcutConfirm(null)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 400, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldAlert size={18} color={txShortcutConfirm === 'commit' ? 'var(--accent)' : '#ea580c'} />
              <span style={{ fontWeight: 700, fontSize: 15 }}>
                {txShortcutConfirm === 'commit' ? '确认提交事务' : '确认回滚事务'}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              {txShortcutConfirm === 'commit'
                ? '将提交当前事务中所有已执行的变更，此操作不可撤销。'
                : '将回滚当前事务，所有未提交的变更将丢失。'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setTxShortcutConfirm(null)} style={{ padding: '6px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>取消</button>
              <button
                onClick={() => { const op = txShortcutConfirm; setTxShortcutConfirm(null); runTx(op === 'commit' ? 'COMMIT' : 'ROLLBACK') }}
                style={{ padding: '6px 16px', borderRadius: 7, background: txShortcutConfirm === 'commit' ? 'var(--accent)' : '#ea580c', color: '#fff', fontSize: 13, fontWeight: 600 }}
              >
                {txShortcutConfirm === 'commit' ? '提交' : '回滚'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* I1 危险 SQL 确认弹窗 */}
      {dangerPending && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setDangerPending(null)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 480, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldAlert size={18} color="var(--error)" />
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--error)' }}>危险操作确认</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {dangerPending.warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: 'var(--text)' }}>
                  <span style={{ color: 'var(--warning)', marginTop: 2 }}>⚠</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-2)', borderRadius: 7, padding: '8px 12px', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto', margin: 0 }}>
              {dangerPending.sql.slice(0, 500)}{dangerPending.sql.length > 500 ? '…' : ''}
            </pre>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>确认后将立即执行，此操作可能无法撤销。</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setDangerPending(null)} style={{ padding: '6px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>取消</button>
              <button onClick={() => runQueryForced(dangerPending.sql)} style={{ padding: '6px 16px', borderRadius: 7, background: 'var(--error)', color: '#fff', fontSize: 13, fontWeight: 600 }}>确认执行</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 生产环境写操作二次确认 */}
      {prodPending && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setProdPending(null)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 480, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldAlert size={18} color="#ea580c" />
              <span style={{ fontWeight: 700, fontSize: 15, color: '#ea580c' }}>生产环境写操作确认</span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
              当前连接标记为<strong>生产环境</strong>，即将执行 <strong>{prodPending.count}</strong> 条写操作，请确认无误后继续。
            </p>
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-2)', borderRadius: 7, padding: '8px 12px', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto', margin: 0 }}>
              {prodPending.sql.slice(0, 500)}{prodPending.sql.length > 500 ? '…' : ''}
            </pre>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setProdPending(null)} style={{ padding: '6px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>取消</button>
              <button onClick={() => { const sql = prodPending.sql; setProdPending(null); runQuery(sql, undefined, true) }} style={{ padding: '6px 16px', borderRadius: 7, background: '#ea580c', color: '#fff', fontSize: 13, fontWeight: 600 }}>确认执行</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
