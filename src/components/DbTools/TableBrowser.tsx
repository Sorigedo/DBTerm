import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  X, RefreshCw, Download, Loader2, Filter, ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, Save, Trash2, Copy, Search,
  Wrench, Settings2, Code2, Eraser, Wand2, Gauge, ShieldCheck, FileCode2,
  AlignLeft, Table2, Check, PanelBottomOpen,
} from 'lucide-react'
import { toast } from '../../stores/toastStore'
import { copyText } from '../../utils/clipboard'
import { useAppStore } from '../../stores/appStore'
import EnvWatermark from '../common/EnvWatermark'
import { requireProdConfirm } from '../../stores/confirmStore'
import type { ConnType } from '../../types'
import CreateTableWizard from './CreateTableWizard'
import SearchableSelect from './SearchableSelect'
import SqlCodeView from '../common/SqlCodeView'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcutStr, SHORTCUT_DEFS } from '../../utils/shortcuts'
import { useShortcuts } from '../../utils/useShortcuts'
import { useWheelScroll } from '../../utils/wheelScroll'
import { isMysqlFamily, supportsMyMaintenance, supportsOptimizeTable, checkTableSql, isSqlite, qid, tableRef as dialectTableRef, buildIndexSql } from '../../utils/sqlDialect'
import { queueTableExport } from '../../utils/exportTasks'

interface Props {
  connectionId: string
  connType: string
  schema: string
  table: string
  onClose?: () => void
  embedded?: boolean   // true 时作为标签页内嵌渲染（无遮罩/portal）
  active?: boolean     // 是否为当前激活标签：非激活时关闭区域快捷键，避免隐藏标签"吃掉"快捷键
}

type SortDir = 'asc' | 'desc'

interface ColFilter {
  value: string
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
}

const PAGE_SIZES = [50, 100, 200, 500] as const
type PageSize = typeof PAGE_SIZES[number]

// 标识符引号 / 表引用一律走共享方言层 sqlDialect（qid / tableRef），
// 禁止在组件内再写一份 backtick 实现（历史上漏 sqlServer/sqlite/duckdb 导致拼 SQL 崩）。
function isOracle(connType: string) { return connType.toLowerCase() === 'oracle' }

export default function TableBrowser({ connectionId, connType, schema, table, onClose, embedded, active = true }: Props) {
  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const sc = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  const [columns, setColumns]         = useState<string[]>([])
  const [rows, setRows]               = useState<(string | null)[][]>([])
  const [totalCount, setTotalCount]   = useState<number | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [pageSize, setPageSize]       = useState<PageSize>(100)
  const [page, setPage]               = useState(0)
  const [sortCol, setSortCol]         = useState<string | null>(null)
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [filters, setFilters]         = useState<Record<string, ColFilter>>({})
  const [filterOpen, setFilterOpen]   = useState<string | null>(null)
  const [execMs, setExecMs]           = useState<number>(0)
  const [colMeta, setColMeta]         = useState<Record<string, {
    type: string; key: string; comment: string; nullable: string; def: string | null; extra: string
  }>>({})
  const filterInputRef                = useRef<HTMLInputElement>(null)
  // 新增行（Navicat 式手动添加数据）
  const [draftRows, setDraftRows]     = useState<Record<string, string>[]>([])
  const [committing, setCommitting]   = useState(false)
  const [commitErr, setCommitErr]     = useState('')
  const [exportOpen, setExportOpen]   = useState(false)
  const [copyOpen, setCopyOpen]       = useState(false)
  // 表级操作菜单 / DDL 查看 / 修改结构 / 清空表
  const [tblMenuOpen, setTblMenuOpen] = useState(false)
  const [editStructOpen, setEditStructOpen] = useState(false)
  const [truncOpen, setTruncOpen]     = useState(false)
  const [truncInput, setTruncInput]   = useState('')
  const [truncBusy, setTruncBusy]     = useState(false)
  const [metaTick, setMetaTick]       = useState(0)
  // 底部属性面板（与对象列表页一致：属性/索引/DDL，与数据同时展示）
  const [detailOpen, setDetailOpen]   = useState(false)
  const [detailTab, setDetailTab]     = useState<'cols' | 'idx' | 'ddl'>('cols')
  const [detailDdl, setDetailDdl]     = useState('')
  const [detailColNames, setDetailColNames] = useState<string[]>([])
  const [detailColRows, setDetailColRows]   = useState<(string | null)[][]>([])
  const [detailIdxNames, setDetailIdxNames] = useState<string[]>([])
  const [detailIdxRows, setDetailIdxRows]   = useState<(string | null)[][]>([])
  const [detailLoading, setDetailLoading]   = useState(false)
  const [detailError, setDetailError]       = useState('')
  const [detailHeight, setDetailHeight]     = useState(220)
  const detailDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const { openQueryTab: openQueryTabAction, setPendingFill, setPendingSchema, connections } = useAppStore(s => ({
    openQueryTab: s.openQueryTab,
    setPendingFill: s.setPendingFill, setPendingSchema: s.setPendingSchema, connections: s.connections,
  }))
  const envConn = connections.find(c => c.id === connectionId)
  // 表内搜索（不过滤：高亮匹配 + 上下跳转定位，类浏览器 Ctrl+F）
  const [searchOpen, setSearchOpen]   = useState(false)
  const [searchText, setSearchText]   = useState('')
  const [matchIdx, setMatchIdx]       = useState(0)
  const tableWrapRef                  = useRef<HTMLDivElement>(null)
  // 行内编辑（双击单元格）
  const [editCell, setEditCell]       = useState<{ ri: number; ci: number } | null>(null)
  const [editVal, setEditVal]         = useState('')
  const [savingCell, setSavingCell]   = useState(false)
  const cellBusyRef = useRef(false)   // 防 Enter + onBlur 双提交
  // 删除行确认（支持批量）
  const [delRows, setDelRows]         = useState<number[] | null>(null)
  const [deleting, setDeleting]       = useState(false)
  // WHERE 自定义过滤 + 行选择（Ctrl/Cmd 多选）
  const [whereInput, setWhereInput]   = useState('')
  const [appliedWhere, setAppliedWhere] = useState('')
  const [whereBarOpen, setWhereBarOpen] = useState(false)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  // 当前聚焦单元格（单击选中）：用于单元格级快捷键（复制单元格 / 置 NULL 等）
  const [activeCell, setActiveCell] = useState<{ ri: number; ci: number } | null>(null)
  // 单元格矩形区域选择（锚点 a + 焦点 f）：鼠标在单元格上划过即框选，整行用最左窄边 gutter 选
  const [cellSel, setCellSel] = useState<{ a: { ri: number; ci: number }; f: { ri: number; ci: number } } | null>(null)
  const cellDragRef = useRef(false)
  const cellInSel = (ri: number, ci: number) => {
    if (!cellSel) return false
    const r0 = Math.min(cellSel.a.ri, cellSel.f.ri), r1 = Math.max(cellSel.a.ri, cellSel.f.ri)
    const c0 = Math.min(cellSel.a.ci, cellSel.f.ci), c1 = Math.max(cellSel.a.ci, cellSel.f.ci)
    return ri >= r0 && ri <= r1 && ci >= c0 && ci <= c1
  }
  // 行右键菜单 / 行详情
  const [rowCtx, setRowCtx]           = useState<{ x: number; y: number; ri: number; ci: number } | null>(null)
  const [detailRow, setDetailRow]     = useState<number | null>(null)
  const [detailView, setDetailView]   = useState<'table' | 'text'>('table')
  const rowCtxRef = useRef<HTMLDivElement>(null)

  const tableRef = dialectTableRef(connType, schema, table)
  const q = (n: string) => qid(connType, n)
  // ClickHouse 为 OLAP，不支持常规行级 UPDATE/DELETE/INSERT（后端 db_insert_rows/db_delete_rows 对 CH 报错）
  // → 隐藏新增行/删除行/编辑单元格保存等写操作入口，仅保留只读浏览。
  const readOnly = connType === 'clickHouse'

  function buildWhereClause(): string {
    const parts: string[] = []
    for (const [col, f] of Object.entries(filters)) {
      if (f.value.trim()) {
        // MySQL 用 \% \_；Oracle/PG/SQLite 无内置默认转义字符，改用 ! 作 ESCAPE 字符
        const esc = isMysqlFamily(connType)
          ? `'%${f.value.replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')}%'`
          : `'%${f.value.replace(/'/g, "''").replace(/%/g, '!%').replace(/_/g, '!_')}%' ESCAPE '!'`
        parts.push(`${q(col)} LIKE ${esc}`)
      }
    }
    if (appliedWhere.trim()) parts.push(`(${appliedWhere.trim()})`)
    return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  }

  function buildOrderClause(): string {
    if (!sortCol) return ''
    return `ORDER BY ${q(sortCol)} ${sortDir.toUpperCase()}`
  }

  const fetchCount = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const where = buildWhereClause()
      // Oracle 不支持 AS 别名省略括号（实际支持，但 COUNT(*) 列名不同）
      const countSql = `SELECT COUNT(*) FROM ${tableRef} ${where}`
      const result = await invoke<QueryResult>('execute_query', { id: connectionId, sql: countSql })
      const cnt = result.rows[0]?.[0]
      const n = cnt !== null && cnt !== undefined ? parseInt(String(cnt), 10) : NaN
      setTotalCount(Number.isFinite(n) ? n : null)
    } catch {
      setTotalCount(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tableRef, JSON.stringify(filters), appliedWhere])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const where = buildWhereClause()
      const order = buildOrderClause()
      const offset = page * pageSize
      // 分页语法按方言区分：Oracle/sqlServer 用 OFFSET…FETCH，其余用 LIMIT…OFFSET
      const sql = isOracle(connType)
        ? `SELECT * FROM ${tableRef} ${where} ${order} OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`
        : connType === 'sqlServer'
          ? `SELECT * FROM ${tableRef} ${where} ${order || 'ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`
          : `SELECT * FROM ${tableRef} ${where} ${order} LIMIT ${pageSize} OFFSET ${offset}`
      const result = await invoke<QueryResult>('execute_query', { id: connectionId, sql })
      let cols = result.columns
      // 空表时后端无法从行推断列名 → 回退用 table_columns 获取列，保证表头始终可见
      if (cols.length === 0) {
        try {
          const meta = await invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table })
          if (meta.length) cols = meta.map(c => c.name)
        } catch { /* 忽略，保持空 */ }
      }
      setColumns(cols)
      setRows(result.rows)
      setExecMs(result.executionTimeMs)
      // 数据已刷新，旧的行索引全部失效：清空选中/编辑/右键/详情状态，防止误操作错行
      setSelectedRows(new Set())
      setCellSel(null)
      setEditCell(null); setRowCtx(null); setDetailRow(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, tableRef, page, pageSize, sortCol, sortDir, JSON.stringify(filters), appliedWhere])

  useEffect(() => {
    fetchCount()
    fetchData()
  }, [fetchCount, fetchData])

  // 列类型 / 主键信息（用于 Navicat 式双行表头：列名 + 类型）
  // 拉取列元数据（类型 / 主键 / 注释），各方言走不同数据字典
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const esc = (s: string) => s.replace(/'/g, "''")
        type Rows = { rows: (string | null)[][] }
        const isMy = ['mysql','mariadb','tidb','oceanBase'].includes(connType)
        if (isMy) {
          // MySQL 系：information_schema（CAST 避免二进制字符集乱码）
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(COLUMN_KEY AS CHAR), CAST(COLUMN_COMMENT AS CHAR), `
              + `CAST(IS_NULLABLE AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR) `
              + `FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${esc(schema)}' AND TABLE_NAME='${esc(table)}' ORDER BY ORDINAL_POSITION`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: String(r[3] ?? ''),
              nullable: String(r[4] ?? ''), def: r[5], extra: String(r[6] ?? ''),
            }
          })
          setColMeta(map)
        } else if (isOracle(connType)) {
          // Oracle：ALL_TAB_COLUMNS + ALL_CONSTRAINTS 检测主键
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT c.COLUMN_NAME, c.DATA_TYPE, `
              + `CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END, `
              + `tc.COMMENTS, c.NULLABLE, c.DATA_DEFAULT `
              + `FROM ALL_TAB_COLUMNS c `
              + `LEFT JOIN ALL_COL_COMMENTS tc ON tc.OWNER=c.OWNER AND tc.TABLE_NAME=c.TABLE_NAME AND tc.COLUMN_NAME=c.COLUMN_NAME `
              + `LEFT JOIN (`
              +   `SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS con `
              +   `JOIN ALL_CONS_COLUMNS cc ON cc.CONSTRAINT_NAME=con.CONSTRAINT_NAME AND cc.OWNER=con.OWNER `
              +   `WHERE con.CONSTRAINT_TYPE='P' AND con.OWNER='${esc(schema)}' AND con.TABLE_NAME='${esc(table)}'`
              + `) pk ON pk.COLUMN_NAME=c.COLUMN_NAME `
              + `WHERE c.OWNER='${esc(schema)}' AND c.TABLE_NAME='${esc(table)}' ORDER BY c.COLUMN_ID`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: String(r[3] ?? ''),
              nullable: String(r[4] ?? ''), def: r[5] ?? null, extra: '',
            }
          })
          setColMeta(map)
        } else if (['postgres', 'kingBase', 'openGauss'].includes(connType)) {
          // PostgreSQL 系：information_schema + pg_description 注释
          const schemaName = schema || 'public'
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT c.column_name, c.data_type, `
              + `CASE WHEN kcu.column_name IS NOT NULL THEN 'PRI' ELSE '' END, `
              + `pgd.description, c.is_nullable, c.column_default `
              + `FROM information_schema.columns c `
              + `LEFT JOIN information_schema.table_constraints tc `
              +   `ON tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND tc.constraint_type='PRIMARY KEY' `
              + `LEFT JOIN information_schema.key_column_usage kcu `
              +   `ON kcu.constraint_name=tc.constraint_name AND kcu.column_name=c.column_name AND kcu.table_schema=c.table_schema `
              + `LEFT JOIN pg_catalog.pg_statio_all_tables st `
              +   `ON st.schemaname=c.table_schema AND st.relname=c.table_name `
              + `LEFT JOIN pg_catalog.pg_description pgd `
              +   `ON pgd.objoid=st.relid AND pgd.objsubid=c.ordinal_position `
              + `WHERE c.table_schema='${esc(schemaName)}' AND c.table_name='${esc(table)}' ORDER BY c.ordinal_position`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: String(r[3] ?? ''),
              nullable: String(r[4] ?? ''), def: r[5] ?? null, extra: '',
            }
          })
          setColMeta(map)
        } else if (connType === 'duckdb') {
          // DuckDB：information_schema（无 pg_description）
          const schemaName = schema || 'main'
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT c.column_name, c.data_type, `
              + `CASE WHEN kcu.column_name IS NOT NULL THEN 'PRI' ELSE '' END, `
              + `'', c.is_nullable, c.column_default `
              + `FROM information_schema.columns c `
              + `LEFT JOIN information_schema.table_constraints tc `
              +   `ON tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND tc.constraint_type='PRIMARY KEY' `
              + `LEFT JOIN information_schema.key_column_usage kcu `
              +   `ON kcu.constraint_name=tc.constraint_name AND kcu.column_name=c.column_name AND kcu.table_schema=c.table_schema `
              + `WHERE c.table_schema='${esc(schemaName)}' AND c.table_name='${esc(table)}' ORDER BY c.ordinal_position`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: '',
              nullable: String(r[4] ?? ''), def: r[5] ?? null, extra: '',
            }
          })
          setColMeta(map)
        } else if (connType === 'clickHouse') {
          // ClickHouse：system.columns（is_in_primary_key 标识主键）
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT name, type, if(is_in_primary_key, 'PRI', ''), '', if(startsWith(type,'Nullable'),'YES','NO'), default_expression `
              + `FROM system.columns WHERE database='${esc(schema)}' AND table='${esc(table)}' ORDER BY position`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: '',
              nullable: String(r[4] ?? ''), def: r[5] ?? null, extra: '',
            }
          })
          setColMeta(map)
        } else if (connType === 'sqlServer') {
          // SQL Server：INFORMATION_SCHEMA.COLUMNS + key_column_usage
          const schemaName = schema || 'dbo'
          const res = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT c.COLUMN_NAME, c.DATA_TYPE, `
              + `CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END, `
              + `CAST(ep.value AS NVARCHAR(MAX)), c.IS_NULLABLE, c.COLUMN_DEFAULT `
              + `FROM INFORMATION_SCHEMA.COLUMNS c `
              + `LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc `
              +   `ON tc.TABLE_SCHEMA=c.TABLE_SCHEMA AND tc.TABLE_NAME=c.TABLE_NAME AND tc.CONSTRAINT_TYPE='PRIMARY KEY' `
              + `LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu `
              +   `ON kcu.CONSTRAINT_NAME=tc.CONSTRAINT_NAME AND kcu.COLUMN_NAME=c.COLUMN_NAME `
              + `LEFT JOIN sys.extended_properties ep `
              +   `ON ep.major_id=OBJECT_ID('${esc(schemaName)}.${esc(table)}') AND ep.minor_id=c.ORDINAL_POSITION AND ep.name='MS_Description' `
              + `WHERE c.TABLE_SCHEMA='${esc(schemaName)}' AND c.TABLE_NAME='${esc(table)}' ORDER BY c.ORDINAL_POSITION`,
          })
          if (!alive) return
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            map[String(r[0] ?? '')] = {
              type: String(r[1] ?? ''), key: String(r[2] ?? ''), comment: String(r[3] ?? ''),
              nullable: String(r[4] ?? ''), def: r[5] ?? null, extra: '',
            }
          })
          setColMeta(map)
        } else if (connType === 'sqlite') {
          // SQLite：PRAGMA table_info 返回 cid,name,type,notnull,dflt_value,pk
          // 用列名定位避免版本差异导致索引偏移
          type QR2 = { columns: string[]; rows: (string | null)[][] }
          const res = await invoke<QR2>('execute_query', {
            id: connectionId,
            sql: `PRAGMA table_info("${table.replace(/"/g, '""')}")`,
          })
          if (!alive) return
          const ci = (col: string) => res.columns.indexOf(col)
          const nameI = ci('name'), typeI = ci('type'), nnI = ci('notnull'), defI = ci('dflt_value'), pkI = ci('pk')
          const map: typeof colMeta = {}
          res.rows.forEach(r => {
            const pkVal = pkI >= 0 ? r[pkI] : null
            const isPk = pkVal !== null && pkVal !== '0'
            map[String(nameI >= 0 ? r[nameI] : '') ?? ''] = {
              type:     String(typeI >= 0 ? r[typeI] : ''),
              key:      isPk ? 'PRI' : '',
              comment:  '',
              nullable: nnI >= 0 && r[nnI] === '1' ? 'NO' : 'YES',
              def:      defI >= 0 ? r[defI] : null,
              extra:    '',
            }
          })
          setColMeta(map)
        }
      } catch { /* 忽略 */ }
    })()
    return () => { alive = false }
  }, [connectionId, schema, table, connType, metaTick])

  // Reset to page 0 when filters/sort/pageSize change (but not on page change itself)
  const prevFiltersRef = useRef(filters)
  const prevSortRef    = useRef({ sortCol, sortDir })
  const prevSizeRef    = useRef(pageSize)
  useEffect(() => {
    const filtersChanged = JSON.stringify(filters) !== JSON.stringify(prevFiltersRef.current)
    const sortChanged    = sortCol !== prevSortRef.current.sortCol || sortDir !== prevSortRef.current.sortDir
    const sizeChanged    = pageSize !== prevSizeRef.current
    if (filtersChanged || sortChanged || sizeChanged) {
      setPage(0)
    }
    prevFiltersRef.current = filters
    prevSortRef.current    = { sortCol, sortDir }
    prevSizeRef.current    = pageSize
  }, [filters, sortCol, sortDir, pageSize])

  // 工具栏下拉（导出 / 复制 / 表操作）：点击其外部任意处关闭（含其它会 stopPropagation 的按钮）
  useEffect(() => {
    if (!exportOpen && !copyOpen && !tblMenuOpen) return
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('.tb-export-wrap')) {
        setExportOpen(false); setCopyOpen(false); setTblMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', h, true)
    return () => document.removeEventListener('mousedown', h, true)
  }, [exportOpen, copyOpen, tblMenuOpen])

  // 结果表快捷键（仅当前可见标签响应）
  const visible = () => !!tableWrapRef.current?.offsetParent
  useShortcuts('result-table', {
    tableRefresh:  () => { if (visible()) { setPage(0); fetchCount(); fetchData() } },
    tableFilter:   () => { if (visible()) setSearchOpen(true) },
    tableAddRow:   () => { if (visible() && columns.length) addDraftRow() },
    tableDelRow:   () => { if (visible() && selectedRows.size) askDeleteRows([...selectedRows]) },
    tableExport:   () => { if (visible()) { setExportOpen(true); setCopyOpen(false); setTblMenuOpen(false) } },
    tableCommit:   () => { if (visible() && draftRows.length) commitDrafts() },
    tableNextPage: () => { if (visible() && (page + 1) * pageSize < (totalCount ?? Infinity)) setPage(p => p + 1) },
    tablePrevPage: () => { if (visible() && page > 0) setPage(p => p - 1) },
    tableRowDetail: () => { if (visible() && selectedRows.size) setDetailRow([...selectedRows][0]) },
    tableCopyCell:  () => {
      if (!visible()) return
      const tsv = cellSelToTsv()    // 选区(单个或区域)优先
      if (tsv !== null) { copyText(tsv); toast.success('已复制选中单元格'); return }
      if (activeCell) { copyText(rows[activeCell.ri]?.[activeCell.ci] ?? 'NULL'); toast.success('已复制单元格值') }
    },
    tableCopyRow:   () => {
      if (!visible()) return
      if (selectedRows.size) { copyRowsAsTab([...selectedRows]); return }
      const tsv = cellSelToTsv()    // 选中单元格区域优先复制为 TSV
      if (tsv !== null) { copyText(tsv); toast.success('已复制选中单元格'); return }
      if (activeCell) copyRowsAsTab([activeCell.ri])
    },
    tableCopyInsert: () => {
      if (!visible()) return
      const ris = selectedRows.size ? [...selectedRows] : activeCell ? [activeCell.ri] : []
      if (ris.length) copyRowsAsInsert(ris)
    },
    tableSetNull:   () => { if (visible() && activeCell && pkCols.length) setCellNull(activeCell.ri, activeCell.ci) },
    // 跨页面共用功能：保持与库树/查询页一致的快捷键
    dbNewQuery:     () => { if (visible()) openQueryTab() },
    dbObjStructure: () => { if (visible()) setEditStructOpen(true) },
    dbObjDdl:       () => { if (visible()) toggleDdl() },
  }, active)

  // 行右键菜单：点击其他区域关闭
  useEffect(() => {
    if (!rowCtx) return
    const h = (e: MouseEvent) => {
      if (rowCtxRef.current && !rowCtxRef.current.contains(e.target as Node)) setRowCtx(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [rowCtx])

  function handleHeaderClick(col: string) {
    // 三态循环：无序 → 升序 → 降序 → 无序（无序即不带 ORDER BY，按主键自然序）
    if (sortCol !== col) {
      setSortCol(col); setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortCol(null); setSortDir('asc')
    }
  }

  function setFilterValue(col: string, value: string) {
    setFilters((prev) => ({ ...prev, [col]: { value } }))
  }

  function clearFilter(col: string) {
    setFilters((prev) => {
      const next = { ...prev }
      delete next[col]
      return next
    })
  }

  async function handleExport(format: 'csv' | 'txt' | 'json' | 'sql' | 'markdown' | 'excel' | 'html' | 'xml', structure?: 'only' | 'with') {
    setExportOpen(false)
    const ext = structure ? 'sql' : format === 'markdown' ? 'md' : format === 'excel' ? 'xls' : format
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: `${table}.${ext}`,
        filters: [{ name: structure ? 'SQL' : format.toUpperCase(), extensions: [ext] }],
      })
      if (!path) return
      await queueTableExport({
        connectionId,
        schema,
        table,
        format,
        formatLabel: format.toUpperCase(),
        path,
        structure,
      })
      toast.info('导出已转入后台，可在右下角查看进度')
    } catch (e) {
      if (String(e)) toast.error(`创建导出任务失败：${String(e)}`)
    }
  }

  // 新增行：追加一条空白草稿
  function addDraftRow() {
    if (readOnly) return
    const empty: Record<string, string> = {}
    columns.forEach(c => { empty[c] = '' })
    setDraftRows(prev => [...prev, empty])
    setCommitErr('')
  }
  function setDraftCell(idx: number, col: string, val: string) {
    setDraftRows(prev => prev.map((r, i) => i === idx ? { ...r, [col]: val } : r))
  }
  function removeDraft(idx: number) {
    setDraftRows(prev => prev.filter((_, i) => i !== idx))
  }
  // 将单元格文本量化为 SQL 字面量：空 → 省略（用默认值）；NULL → NULL；数字 → 原样；其余 → 引号转义
  function sqlLiteral(v: string): string {
    if (v === 'NULL') return 'NULL'
    // SQLite 无 BOOLEAN 类型，驱动会把 0/1 展示为 false/true；仅 SQLite 须还原为整数。
    // 其它方言（尤其 PG 的 boolean 列）应保留 true/false 关键字，否则 1/0 触发类型错误。
    if (isSqlite(connType)) {
      if (v === 'true')  return '1'
      if (v === 'false') return '0'
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) return v
    return `'${v.replace(/'/g, "''")}'`
  }
  async function commitDrafts() {
    if (readOnly) return
    if (draftRows.length === 0) return
    if (!(await requireProdConfirm(envConn, `向 ${schema}.${table} 新增 ${draftRows.length} 行数据`))) return
    setCommitting(true); setCommitErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      for (const draft of draftRows) {
        const entries = Object.entries(draft).filter(([, v]) => v !== '')
        if (entries.length === 0) {
          setCommitErr('请至少填写一个字段后再提交'); setCommitting(false); return
        }
        const sql = `INSERT INTO ${tableRef} (${entries.map(([c]) => q(c)).join(', ')}) VALUES (${entries.map(([, v]) => sqlLiteral(v)).join(', ')})`
        await invoke('execute_query', { id: connectionId, sql })
      }
      const n = draftRows.length
      setDraftRows([])
      setPage(0); fetchCount(); fetchData()
      toast.success(`已新增 ${n} 行数据`)
    } catch (e) { setCommitErr(String(e)) } // 失败只在面板内提示，避免一错两处
    finally { setCommitting(false) }
  }

  // 主键列（行内编辑/删除定位行用）
  // 定位策略：① 显式主键 ② 列名含 id/ID 的单列 ③ 全行所有列作复合 WHERE
  const explicitPk = columns.filter(c => colMeta[c]?.key === 'PRI')
  const idFallback  = columns.filter(c => /^(id|_id|row_id|snowflake_id|uuid)$/i.test(c))
  const pkCols = explicitPk.length > 0 ? explicitPk
    : idFallback.length > 0           ? idFallback
    : columns  // 全行定位

  function startEdit(ri: number, ci: number) {
    if (readOnly) return
    if (columns.length === 0) { toast.warning('无法读取表结构，无法行内编辑'); return }
    setEditCell({ ri, ci })
    setEditVal(rows[ri][ci] ?? '')
  }
  async function saveCell() {
    // Enter 提交后会 setEditCell(null) 卸载 input 触发 onBlur 二次进入 → ref 去重，避免双提交/双 toast
    if (!editCell || cellBusyRef.current) return
    const { ri, ci } = editCell
    const col = columns[ci]
    const orig = rows[ri][ci]
    const next = editVal === '' && orig === null ? null : editVal
    // 值未变化直接退出
    if ((orig ?? '') === editVal) { setEditCell(null); return }
    cellBusyRef.current = true
    setSavingCell(true)
    try {
      // 生产环境写操作二次确认
      const detail = `UPDATE ${q(table)} SET ${q(col)} = ${next === null ? 'NULL' : sqlLiteral(next)} WHERE ${pkCols.map(pc => `${q(pc)} = …`).join(' AND ')}`
      if (!(await requireProdConfirm(envConn, `修改 ${schema}.${table} 的单元格`, detail))) {
        setEditCell(null); return
      }
      const { invoke } = await import('@tauri-apps/api/core')
      const pkValues = pkCols.map(pc => rows[ri][columns.indexOf(pc)])
      await invoke('update_cell', {
        id: connectionId, schema, table, column: col,
        newValue: next, pkColumns: pkCols, pkValues,
      })
      setRows(prev => prev.map((r, i) => i === ri ? r.map((v, j) => j === ci ? next : v) : r))
      setEditCell(null)
      toast.success('已更新单元格')
    } catch (e) { toast.error(`更新失败：${String(e)}`) }
    finally { cellBusyRef.current = false; setSavingCell(false) }
  }

  // 行主键 WHERE 条件
  function pkWhere(ri: number): string {
    return pkCols.map(pc => {
      const v = rows[ri][columns.indexOf(pc)]
      return v === null ? `${q(pc)} IS NULL` : `${q(pc)} = ${sqlLiteral(v)}`
    }).join(' AND ')
  }
  function askDeleteRows(ris: number[]) {
    if (readOnly) return
    if (columns.length === 0) return
    if (ris.length === 0) return
    setDelRows(ris)
  }
  async function confirmDeleteRows() {
    if (!delRows || delRows.length === 0) return
    setDeleting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      for (const ri of delRows) {
        // Oracle 不支持 DELETE ... LIMIT（rownum 子查询写法过于复杂，主键 WHERE 已唯一定位一行）
        // 只有 MySQL 系支持 DELETE ... LIMIT 1；Oracle/PG/SQLite 等直接用主键 WHERE 定位（已唯一）
        const delSql = isMysqlFamily(connType)
          ? `DELETE FROM ${tableRef} WHERE ${pkWhere(ri)} LIMIT 1`
          : `DELETE FROM ${tableRef} WHERE ${pkWhere(ri)}`
        await invoke('execute_query', { id: connectionId, sql: delSql })
      }
      const n = delRows.length
      setDelRows(null); setSelectedRows(new Set())
      fetchCount(); fetchData()
      toast.success(`已删除 ${n} 行`)
    } catch (e) { toast.error(`删除失败：${String(e)}`) }
    finally { setDeleting(false) }
  }

  // 复制行为 INSERT 语句（支持多行）
  function copyRowsAsInsert(ris: number[]) {
    if (ris.length === 0) return
    const cols = columns.map(q).join(', ')
    const sql = ris.map(ri => {
      const vals = rows[ri].map(v => v === null ? 'NULL' : sqlLiteral(v)).join(', ')
      return `INSERT INTO ${tableRef} (${cols}) VALUES (${vals});`
    }).join('\n')
    copyText(sql)
    toast.success(`已复制 ${ris.length} 条 INSERT 语句`)
  }
  // 复制行（制表符分隔，可直接粘贴到 Excel；可选含表头）
  function copyRowsAsTab(ris: number[], withHeader = false) {
    if (ris.length === 0) return
    const lines = ris.map(ri => rows[ri].map(v => v ?? '').join('\t'))
    if (withHeader) lines.unshift(columns.join('\t'))
    copyText(lines.join('\n'))
    toast.success(`已复制 ${ris.length} 行${withHeader ? '（含表头）' : ''}`)
  }
  // 复制行（CSV；可选含表头）
  function copyRowsAsCsv(ris: number[], withHeader = true) {
    if (ris.length === 0) return
    const esc = (v: string | null) => {
      const s = v ?? ''
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = ris.map(ri => rows[ri].map(esc).join(','))
    if (withHeader) lines.unshift(columns.join(','))
    copyText(lines.join('\n'))
    toast.success(`已复制 ${ris.length} 行（CSV${withHeader ? '，含表头' : ''}）`)
  }
  // 复制行（JSON 数组）
  function copyRowsAsJson(ris: number[]) {
    if (ris.length === 0) return
    const arr = ris.map(ri => {
      const obj: Record<string, string | null> = {}
      columns.forEach((c, ci) => { obj[c] = rows[ri][ci] })
      return obj
    })
    copyText(JSON.stringify(arr.length === 1 ? arr[0] : arr, null, 2))
    toast.success(`已复制 ${ris.length} 行（JSON）`)
  }
  // 单元格置 NULL（按主键定位）
  async function setCellNull(ri: number, ci: number) {
    if (readOnly) return
    if (columns.length === 0) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const pkValues = pkCols.map(pc => rows[ri][columns.indexOf(pc)])
      await invoke('update_cell', {
        id: connectionId, schema, table, column: columns[ci],
        newValue: null, pkColumns: pkCols, pkValues,
      })
      setRows(prev => prev.map((r, i) => i === ri ? r.map((v, j) => j === ci ? null : v) : r))
      toast.success(`已将 ${columns[ci]} 置为 NULL`)
    } catch (e) { toast.error(`置 NULL 失败：${String(e)}`) }
  }
  function applyWhere() {
    setSelectedRows(new Set())
    setPage(0)
    setAppliedWhere(whereInput)
  }
  function resetWhere() {
    setWhereInput(''); setAppliedWhere(''); setPage(0)
  }

  // ── 表级操作：DDL / 维护 / 清空 ──
  // 底部属性面板：与数据网格同时展示（属性=字段 / 索引 / DDL）
  async function loadDetail(tab: 'cols' | 'idx' | 'ddl') {
    setTblMenuOpen(false)
    setDetailOpen(true); setDetailTab(tab)
    setDetailLoading(true); setDetailError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const esc = (s: string) => s.replace(/'/g, "''")
      const isMy = isMysqlFamily(connType)
      const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
      const schemaOrDef = schema || (connType === 'duckdb' ? 'main' : connType === 'sqlServer' ? 'dbo' : 'public')
      const tableUp = table.toUpperCase(), schemaUp = schema.toUpperCase()

      if (tab === 'ddl') {
        const ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
        setDetailDdl(ddl)
      } else if (tab === 'cols') {
        let sql: string
        if (isMy) {
          sql = `SHOW FULL COLUMNS FROM ${tableRef}`
        } else if (isPg) {
          sql = `SELECT c.column_name, c.data_type, c.character_maximum_length, c.is_nullable, c.column_default, pgd.description `
            + `FROM information_schema.columns c `
            + `LEFT JOIN pg_catalog.pg_statio_all_tables st ON st.schemaname=c.table_schema AND st.relname=c.table_name `
            + `LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid=st.relid AND pgd.objsubid=c.ordinal_position `
            + `WHERE c.table_schema='${esc(schemaOrDef)}' AND c.table_name='${esc(table)}' ORDER BY c.ordinal_position`
        } else if (isOracle(connType)) {
          sql = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE, DATA_DEFAULT, COLUMN_ID `
            + `FROM ALL_TAB_COLUMNS `
            + `WHERE OWNER='${esc(schemaUp)}' AND TABLE_NAME='${esc(tableUp)}' ORDER BY COLUMN_ID`
        } else if (connType === 'sqlite') {
          sql = `PRAGMA table_info("${table.replace(/"/g, '""')}")`
        } else if (connType === 'duckdb') {
          sql = `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, ordinal_position `
            + `FROM information_schema.columns `
            + `WHERE table_schema='${esc(schemaOrDef)}' AND table_name='${esc(table)}' ORDER BY ordinal_position`
        } else if (connType === 'clickHouse') {
          sql = `SELECT name, type, position, if(is_in_primary_key,'YES','NO') AS pk, default_kind, default_expression, comment `
            + `FROM system.columns WHERE database='${esc(schema)}' AND table='${esc(table)}' ORDER BY position`
        } else if (connType === 'sqlServer') {
          sql = `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE, c.COLUMN_DEFAULT `
            + `FROM INFORMATION_SCHEMA.COLUMNS c `
            + `WHERE c.TABLE_SCHEMA='${esc(schemaOrDef)}' AND c.TABLE_NAME='${esc(table)}' ORDER BY c.ORDINAL_POSITION`
        } else {
          setDetailError('该数据库类型暂不支持查看字段属性'); return
        }
        const res = await invoke<QueryResult>('execute_query', { id: connectionId, sql })
        const cols = res.columns ?? [], rows = res.rows ?? []
        const skip = new Set(cols.map((c, i) => /privileges/i.test(c) ? i : -1).filter(i => i >= 0))
        setDetailColNames(cols.filter((_, i) => !skip.has(i)))
        setDetailColRows(rows.map(r => r.filter((_, i) => !skip.has(i))))
      } else {
        // 索引 SQL 统一走共享方言层 buildIndexSql（与 SchemaBrowser 一致，避免各写一份）
        const sql = buildIndexSql(connType, schema, table)
        if (!sql) { setDetailError('该数据库类型暂不支持查看索引'); return }
        const res = await invoke<QueryResult>('execute_query', { id: connectionId, sql })
        setDetailIdxNames(res.columns ?? []); setDetailIdxRows(res.rows ?? [])
      }
    } catch (e) { setDetailError(String(e)) } finally { setDetailLoading(false) }
  }
  function switchDetailTab(tab: 'cols' | 'idx' | 'ddl') { setDetailTab(tab); loadDetail(tab) }
  // 查看 DDL：切换底部面板的 DDL 视图，已展开 DDL 时再次点击则关闭
  function toggleDdl() {
    if (detailOpen && detailTab === 'ddl') setDetailOpen(false)
    else switchDetailTab('ddl')
  }
  function onDetailDragStart(e: React.MouseEvent) {
    e.preventDefault()
    detailDragRef.current = { startY: e.clientY, startH: detailHeight }
    const onMove = (me: MouseEvent) => {
      if (!detailDragRef.current) return
      setDetailHeight(Math.max(100, Math.min(560, detailDragRef.current.startH + (detailDragRef.current.startY - me.clientY))))
    }
    const onUp = () => { detailDragRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const detailZh: Record<string, string> = {
    Field: '字段', Type: '类型', Collation: '排序规则', Null: '可空', Key: '键', Default: '默认值', Extra: '附加', Comment: '注释',
    Table: '表', Non_unique: '非唯一', Key_name: '索引名', Seq_in_index: '序号', Column_name: '列名',
    Cardinality: '基数', Sub_part: '前缀长度', Packed: '压缩', Index_type: '索引类型', Index_comment: '索引注释', Visible: '可见', Expression: '表达式',
  }
  const zhCol = (n: string) => detailZh[n] ?? n
  async function runMaint(kind: 'OPTIMIZE' | 'ANALYZE' | 'CHECK') {
    setTblMenuOpen(false)
    if (!supportsMyMaintenance(connType)) {
      toast.error('该数据库类型不支持此维护操作')
      return
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // TiDB 检查表须用 ADMIN CHECK TABLE
      const sql = kind === 'CHECK' ? `${checkTableSql(connType, tableRef)};` : `${kind} TABLE ${tableRef};`
      const res = await invoke<QueryResult>('execute_query', { id: connectionId, sql })
      const msg = res.rows.map(r => r[3]).filter(Boolean).join('；')
      toast.success(`${kind} TABLE 完成${msg ? `：${msg}` : ''}`)
    } catch (e) { toast.error(`${kind} TABLE 失败：${String(e)}`) }
  }
  async function confirmTruncate() {
    if (truncInput !== table) return
    setTruncBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // SQLite 无 TRUNCATE，用 DELETE 清空；其余库用 TRUNCATE
      const clearSql = isSqlite(connType) ? `DELETE FROM ${tableRef};` : `TRUNCATE TABLE ${tableRef};`
      await invoke('execute_query', { id: connectionId, sql: clearSql })
      setTruncOpen(false); setTruncInput('')
      setPage(0); fetchCount(); fetchData()
      toast.success(`已清空表 ${table}`)
    } catch (e) { toast.error(`清空表失败：${String(e)}`) }
    finally { setTruncBusy(false) }
  }

  // 表信息：属性 + 字段一览
  // 把当前表 DDL 填入查询页（可修改后执行）
  async function editDdlInQuery() {
    setTblMenuOpen(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
      const tabId = openQueryTabAction(connectionId)
      setPendingFill(tabId, ddl)
      toast.info('DDL 已填入查询页，修改后手动执行')
    } catch (e) { toast.error(`获取 DDL 失败：${String(e)}`) }
  }

  function openQueryTab() {
    const tabId = openQueryTabAction(connectionId)
    if (schema) setPendingSchema(tabId, schema)
    const selectSql = isOracle(connType)
      ? `SELECT * FROM ${tableRef} FETCH FIRST 100 ROWS ONLY;`
      : connType === 'sqlServer'
        ? `SELECT TOP 100 * FROM ${tableRef};`
        : `SELECT * FROM ${tableRef} LIMIT 100;`
    setPendingFill(tabId, selectSql)
  }

  // ── 行选择：单选 / Ctrl 多选 / Shift 范围 / 拖动框选 ──
  const lastClickRef  = useRef<number | null>(null)
  const dragAnchorRef = useRef<number | null>(null)
  const draggedRef    = useRef(false)

  function rangeSet(aRi: number, bRi: number): Set<number> {
    const order = visibleRows.map(v => v.ri)
    const ai = order.indexOf(aRi), bi = order.indexOf(bRi)
    if (ai < 0 || bi < 0) return new Set([bRi])
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
    return new Set(order.slice(lo, hi + 1))
  }
  function handleRowClick(e: React.MouseEvent, ri: number) {
    setCellSel(null)   // 选整行清单元格选区（互斥）
    if (draggedRef.current) { draggedRef.current = false; return }  // 拖选结束后的 click 不重置
    if (e.shiftKey && lastClickRef.current !== null) {
      setSelectedRows(rangeSet(lastClickRef.current, ri))
      return
    }
    lastClickRef.current = ri
    setSelectedRows(prev => {
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(prev)
        if (next.has(ri)) next.delete(ri); else next.add(ri)
        return next
      }
      return new Set([ri])
    })
  }
  function onRowMouseDown(e: React.MouseEvent, ri: number) {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, button')) return
    e.preventDefault()   // 阻止浏览器原生文字选区（拖动时大片蓝色高亮）
    setCellSel(null)     // 拖整行清单元格选区
    dragAnchorRef.current = ri
    draggedRef.current = false
  }
  function onRowMouseEnter(ri: number) {
    const a = dragAnchorRef.current
    if (a === null) return
    if (a !== ri) {
      draggedRef.current = true
      lastClickRef.current = a
      setSelectedRows(rangeSet(a, ri))
    }
  }
  useEffect(() => {
    const up = () => { dragAnchorRef.current = null; cellDragRef.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // ── 单元格区域选择：在单元格上按下开始框选，拖动扩展焦点 ──────────────────
  function onCellMouseDown(e: React.MouseEvent, ri: number, ci: number) {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('input, button')) return        // 编辑中/按钮不拦
    if (e.shiftKey && cellSel) { setCellSel({ a: cellSel.a, f: { ri, ci } }); setActiveCell({ ri, ci }); return }
    e.preventDefault()                              // 阻止浏览器原生文字选区
    cellDragRef.current = true
    setCellSel({ a: { ri, ci }, f: { ri, ci } })
    setActiveCell({ ri, ci })
    if (selectedRows.size) setSelectedRows(new Set())  // 选单元格清整行选择（互斥）
  }
  function onCellMouseEnter(ri: number, ci: number) {
    if (!cellDragRef.current) return
    setCellSel(s => s ? { a: s.a, f: { ri, ci } } : { a: { ri, ci }, f: { ri, ci } })
    setActiveCell({ ri, ci })
  }
  // Mod+A：全选当前页所有单元格（激活区域的表数据）
  const selectAllCells = useCallback(() => {
    if (rows.length === 0 || columns.length === 0) return
    setSelectedRows(new Set())
    setCellSel({ a: { ri: 0, ci: 0 }, f: { ri: rows.length - 1, ci: columns.length - 1 } })
    setActiveCell({ ri: 0, ci: 0 })
  }, [rows.length, columns.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a' || e.shiftKey || e.altKey) return
      if (!tableWrapRef.current?.offsetParent) return     // 仅当前可见的表格响应
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.classList.contains('cm-content'))) return
      e.preventDefault()
      selectAllCells()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectAllCells])
  // 选中区域 → TSV（可粘进 Excel）
  const cellSelToTsv = useCallback((): string | null => {
    if (!cellSel) return null
    const r0 = Math.min(cellSel.a.ri, cellSel.f.ri), r1 = Math.max(cellSel.a.ri, cellSel.f.ri)
    const c0 = Math.min(cellSel.a.ci, cellSel.f.ci), c1 = Math.max(cellSel.a.ci, cellSel.f.ci)
    const lines: string[] = []
    for (let r = r0; r <= r1; r++) {
      const row = rows[r]
      if (!row) continue
      lines.push(row.slice(c0, c1 + 1).map(v => v ?? '').join('\t'))
    }
    return lines.join('\n')
  }, [cellSel, rows])

  const totalPages = totalCount !== null ? Math.max(1, Math.ceil(totalCount / pageSize)) : null
  const activeFilters = Object.keys(filters).filter((k) => filters[k].value.trim())

  // 表内搜索：全部行保持可见，仅高亮匹配并支持跳转
  const kw = searchText.trim().toLowerCase()
  const visibleRows = rows.map((row, ri) => ({ row, ri }))
  const matches = kw
    ? visibleRows.filter(({ row }) => row.some(c => (c ?? '').toLowerCase().includes(kw))).map(v => v.ri)
    : []
  const currentMatch = matches.length > 0 ? matches[Math.min(matchIdx, matches.length - 1)] : null
  // 关键字高亮
  function hl(text: string) {
    if (!kw) return text
    const idx = text.toLowerCase().indexOf(kw)
    if (idx < 0) return text
    return <>{text.slice(0, idx)}<mark className="tb-hl">{text.slice(idx, idx + kw.length)}</mark>{text.slice(idx + kw.length)}</>
  }
  // 跳转到上/下一个匹配行
  function gotoMatch(dir: 1 | -1) {
    if (matches.length === 0) return
    setMatchIdx(prev => {
      const cur = Math.min(prev, matches.length - 1)
      return (cur + dir + matches.length) % matches.length
    })
  }
  // 搜索跳转：当前匹配行滚动到可视区域中部
  useEffect(() => {
    if (currentMatch === null) return
    tableWrapRef.current
      ?.querySelector(`tr[data-ri="${currentMatch}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch, matchIdx])

  // 滚轮驱动横向滚动条：统一规则（见 utils/wheelScroll）
  useWheelScroll(tableWrapRef)

  const card = (
      <div
        className={`tb-card${embedded ? ' tb-card--embedded' : ''}`}
        style={{ position: 'relative' }}
        onMouseDown={embedded ? undefined : (e) => e.stopPropagation()}
        onClick={() => { if (filterOpen) setFilterOpen(null); if (exportOpen) setExportOpen(false); if (copyOpen) setCopyOpen(false); if (tblMenuOpen) setTblMenuOpen(false) }}
      >
        <EnvWatermark envLabel={envConn?.envLabel} readonly={envConn?.readonly ?? envConn?.readOnly} />
        {/* Header（紧凑：表名 + 图标操作） */}
        <div className="tb-header">
          <span className="tb-header__title">
            {schema ? `${schema}.` : ''}{table}
            {totalCount !== null && (
              <span className="tb-header__count">约 {totalCount.toLocaleString()} 行</span>
            )}
          </span>
          <div className="tb-header__actions">
            <button className="tb-icon-btn" onClick={(e) => { e.stopPropagation(); openQueryTab() }}
              data-tip="新建查询（SELECT * 本表）" data-shortcut={sc('dbNewQuery')}>
              <FileCode2 size={15} />
            </button>
            <button className={`tb-icon-btn${detailOpen && detailTab === 'ddl' ? ' tb-icon-btn--on' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggleDdl() }}
              data-tip="查看 DDL" data-shortcut={sc('dbObjDdl')}>
              <PanelBottomOpen size={15} strokeWidth={1.8} />
            </button>
            {activeFilters.length > 0 && (
              <span className="tb-filter-badge">{activeFilters.length} 个筛选</span>
            )}
            {/* 新增行 / 提交 / 取消（ClickHouse 只读：隐藏写操作，仅保留复制） */}
            {!readOnly && draftRows.length > 0 ? (
              <>
                <span className="tb-draft-hint">{draftRows.length} 行待提交</span>
                <button className="tb-icon-btn tb-icon-btn--primary" disabled={committing}
                  data-tip="提交新增" data-shortcut={sc('tableCommit')}
                  onClick={(e) => { e.stopPropagation(); commitDrafts() }}>
                  {committing ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                </button>
                <button className="tb-icon-btn" disabled={committing} data-tip="取消"
                  onClick={(e) => { e.stopPropagation(); setDraftRows([]); setCommitErr('') }}>
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                {!readOnly && (
                  <button className="tb-icon-btn" disabled={columns.length === 0}
                    onClick={(e) => { e.stopPropagation(); addDraftRow() }} data-tip="新增行" data-shortcut={sc('tableAddRow')}>
                    <Plus size={15} />
                  </button>
                )}
                {/* 选中行复制（多格式下拉，Ctrl/Cmd+点击可多选行） */}
                <div className="tb-export-wrap" onClick={(e) => e.stopPropagation()}>
                  <button className="tb-icon-btn" disabled={selectedRows.size === 0}
                    onClick={() => { setCopyOpen(v => !v); setExportOpen(false); setTblMenuOpen(false) }}
                    data-tip={`复制选中行${selectedRows.size > 1 ? `（${selectedRows.size} 行）` : ''}`} data-shortcut={sc('tableCopyRow')}>
                    <Copy size={14} />
                  </button>
                  {copyOpen && (
                    <div className="tb-export-menu">
                      <button onClick={() => { copyRowsAsTab([...selectedRows]); setCopyOpen(false) }}>复制行（制表符）</button>
                      <button onClick={() => { copyRowsAsTab([...selectedRows], true); setCopyOpen(false) }}>复制行（制表符 · 含表头）</button>
                      <button onClick={() => { copyRowsAsCsv([...selectedRows], false); setCopyOpen(false) }}>复制为 CSV</button>
                      <button onClick={() => { copyRowsAsCsv([...selectedRows], true); setCopyOpen(false) }}>复制为 CSV（含表头）</button>
                      <button onClick={() => { copyRowsAsJson([...selectedRows]); setCopyOpen(false) }}>复制为 JSON</button>
                      <button onClick={() => { copyRowsAsInsert([...selectedRows]); setCopyOpen(false) }}>复制为 INSERT</button>
                    </div>
                  )}
                </div>
                {!readOnly && (
                  <button className="tb-icon-btn tb-icon-btn--danger" disabled={selectedRows.size === 0}
                    onClick={(e) => { e.stopPropagation(); askDeleteRows([...selectedRows]) }}
                    data-tip={`删除选中行${selectedRows.size > 1 ? `（${selectedRows.size} 行）` : ''}`} data-shortcut={sc('tableDelRow')}>
                    <Trash2 size={14} />
                  </button>
                )}
              </>
            )}
            {/* 表内搜索切换 */}
            <button className={`tb-icon-btn${searchOpen || kw ? ' tb-icon-btn--on' : ''}`}
              onClick={(e) => { e.stopPropagation(); setSearchOpen(v => { if (v) setSearchText(''); return !v }) }}
              data-tip="表内搜索（当前页）" data-shortcut={sc('tableFilter')}>
              <Search size={14} />
            </button>
            {/* WHERE 过滤切换 */}
            <button className={`tb-icon-btn${whereBarOpen || appliedWhere ? ' tb-icon-btn--on' : ''}`}
              onClick={(e) => { e.stopPropagation(); setWhereBarOpen(v => !v) }}
              data-tip="条件过滤 (WHERE)">
              <Filter size={14} />
            </button>
            {/* 表操作菜单 */}
            <div className="tb-export-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="tb-icon-btn" data-tip="表操作"
                onClick={() => { setTblMenuOpen(v => !v); setCopyOpen(false); setExportOpen(false) }}>
                <Wrench size={14} />
              </button>
              {tblMenuOpen && (
                <div className="tb-export-menu">
                  <button onClick={() => loadDetail('cols')}>
                    <span className="btn-label"><Search size={12} />表属性（属性 / 索引 / DDL）</span>
                  </button>
                  <button onClick={() => { setTblMenuOpen(false); setEditStructOpen(true) }}>
                    <span className="btn-label"><Settings2 size={12} />修改表结构…</span>
                    {sc('dbObjStructure') && <span className="ctx-item__shortcut">{sc('dbObjStructure')}</span>}
                  </button>
                  <button onClick={editDdlInQuery}>
                    <span className="btn-label"><Code2 size={12} />在查询页编辑 DDL</span>
                    {sc('dbObjDdl') && <span className="ctx-item__shortcut">{sc('dbObjDdl')}</span>}
                  </button>
                  <button onClick={() => { copyText(table); toast.success('已复制表名'); setTblMenuOpen(false) }}>
                    <span className="btn-label"><Copy size={12} />复制表名</span>
                  </button>
                  {isMysqlFamily(connType) && (
                    <>
                      <div className="tb-row-ctx__sep" />
                      {supportsOptimizeTable(connType) && <button onClick={() => runMaint('OPTIMIZE')}><span className="btn-label"><Wand2 size={12} />优化表</span></button>}
                      <button onClick={() => runMaint('ANALYZE')}><span className="btn-label"><Gauge size={12} />分析表</span></button>
                      <button onClick={() => runMaint('CHECK')}><span className="btn-label"><ShieldCheck size={12} />检查表</span></button>
                    </>
                  )}
                  <div className="tb-row-ctx__sep" />
                  <button className="danger" onClick={() => { setTblMenuOpen(false); setTruncOpen(true); setTruncInput('') }}>
                    <span className="btn-label"><Eraser size={12} />清空表…</span>
                  </button>
                </div>
              )}
            </div>
            {/* 导出格式菜单 */}
            <div className="tb-export-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="tb-icon-btn" data-tip="导出数据" data-shortcut={sc('tableExport')}
                onClick={() => { setExportOpen(v => !v); setCopyOpen(false); setTblMenuOpen(false) }}>
                <Download size={14} />
              </button>
              {exportOpen && (
                <div className="tb-export-menu">
                  <div className="tb-export-grid__label">导出为</div>
                  <div className="tb-export-grid">
                    {([['csv', 'CSV'], ['txt', 'TXT'], ['excel', 'Excel'], ['json', 'JSON'],
                       ['sql', 'SQL'], ['markdown', 'MD'], ['html', 'HTML'], ['xml', 'XML']] as const).map(([f, l]) => (
                      <button key={f} className="tb-export-chip" onClick={() => handleExport(f)}>{l}</button>
                    ))}
                  </div>
                  <div className="tb-row-ctx__sep" />
                  <button onClick={() => handleExport('sql', 'only')}>导出表结构</button>
                  <button onClick={() => handleExport('sql', 'with')}>导出表结构与数据</button>
                </div>
              )}
            </div>
            <button className="tb-icon-btn"
              onClick={(e) => { e.stopPropagation(); setPage(0); fetchCount(); fetchData() }}
              data-tip="刷新" data-shortcut={sc('tableRefresh')} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
            {onClose && (
              <button className="tb-icon-btn" onClick={onClose} data-tip="关闭">
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* WHERE 过滤栏（点击工具栏漏斗后显示） */}
        {whereBarOpen && (
          <div className="tb-wherebar" onClick={(e) => e.stopPropagation()}>
            <span className="tb-wherebar__label">WHERE</span>
            <input
              className="tb-wherebar__input" autoFocus
              placeholder="如：age > 18 AND name LIKE 'w%'（直接写 SQL 条件，回车应用）"
              value={whereInput} spellCheck={false} autoComplete="off"
              onChange={(e) => setWhereInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyWhere(); if (e.key === 'Escape') setWhereBarOpen(false) }}
            />
            <button className="tb-wherebar__btn" onClick={applyWhere} disabled={loading}>
              <Search size={12} /> 应用
            </button>
            {appliedWhere && (
              <button className="tb-wherebar__btn tb-wherebar__btn--ghost" onClick={resetWhere}>重置</button>
            )}
          </div>
        )}

        {/* 表内搜索栏（高亮 + 跳转，不过滤数据） */}
        {searchOpen && (
          <div className="tb-wherebar" onClick={(e) => e.stopPropagation()}>
            <span className="tb-wherebar__label">搜索</span>
            <input
              className="tb-wherebar__input" autoFocus
              placeholder="在当前页所有列中搜索并高亮，Enter 跳转下一个匹配…"
              value={searchText} spellCheck={false} autoComplete="off"
              onChange={(e) => { setSearchText(e.target.value); setMatchIdx(0) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') gotoMatch(e.shiftKey ? -1 : 1)
                if (e.key === 'Escape') { setSearchText(''); setSearchOpen(false) }
              }}
            />
            {kw && (
              <>
                <span className="tb-wherebar__hint">
                  {matches.length > 0 ? `${Math.min(matchIdx, matches.length - 1) + 1} / ${matches.length} 个匹配` : '无匹配'}
                </span>
                <button className="tb-icon-btn" data-tip="上一个 (Shift+Enter)" disabled={matches.length === 0}
                  onClick={() => gotoMatch(-1)}><ChevronUp size={13} /></button>
                <button className="tb-icon-btn" data-tip="下一个 (Enter)" disabled={matches.length === 0}
                  onClick={() => gotoMatch(1)}><ChevronDown size={13} /></button>
              </>
            )}
          </div>
        )}

        {/* Table area */}
        <div className="tb-table-wrap" ref={tableWrapRef}>
          {loading && (
            <div className="tb-loading-overlay">
              <Loader2 size={20} className="spin" />
            </div>
          )}
          {error && (
            <div className="tb-error">{error}</div>
          )}
          {!error && (
            <table className="tb-table">
              <thead>
                <tr>
                  <th className="tb-th tb-th--rownum" />
                  {draftRows.length > 0 && <th className="tb-th tb-th--ops" />}
                  {columns.map((col) => {
                    const hasFilter = !!filters[col]?.value.trim()
                    const isSorted  = sortCol === col
                    return (
                      <th key={col} className="tb-th"
                        data-tip={(() => {
                          const m = colMeta[col]
                          if (!m) return col
                          const lines = [`${col} · ${m.type}${m.key === 'PRI' ? ' · 主键' : m.key === 'UNI' ? ' · 唯一' : m.key === 'MUL' ? ' · 索引' : ''}`]
                          lines.push(`可空：${m.nullable === 'YES' ? '是' : '否'}`)
                          lines.push(`默认：${m.def === null ? (m.nullable === 'YES' ? 'NULL' : '无') : m.def}`)
                          if (m.extra) lines.push(`扩展：${m.extra}`)
                          if (m.comment) lines.push(`注释：${m.comment}`)
                          return lines.join('\n')
                        })()}>
                        <div className="tb-th-inner">
                          <button
                            className="tb-th-label"
                            onClick={(e) => { e.stopPropagation(); handleHeaderClick(col) }}
                          >
                            {colMeta[col]?.key === 'PRI' && <span className="tb-th-pk" data-tip="主键">🔑</span>}
                            <span className="tb-th-name-text">{col}</span>
                            {isSorted ? (
                              sortDir === 'asc'
                                ? <ChevronUp size={11} className="tb-sort-icon" />
                                : <ChevronDown size={11} className="tb-sort-icon" />
                            ) : (
                              <ChevronsUpDown size={11} className="tb-sort-icon tb-sort-icon--idle" />
                            )}
                          </button>
                          <div className="tb-filter-wrap" onClick={(e) => e.stopPropagation()}>
                            <button
                              className={`tb-filter-btn ${hasFilter ? 'tb-filter-btn--active' : ''} ${filterOpen === col ? 'tb-filter-btn--open' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setFilterOpen(filterOpen === col ? null : col)
                                if (filterOpen !== col) {
                                  setTimeout(() => filterInputRef.current?.focus(), 30)
                                }
                              }}
                            >
                              <Filter size={10} />
                            </button>
                            {filterOpen === col && (
                              <div className="tb-filter-popup" onClick={(e) => e.stopPropagation()}>
                                <input
                                  ref={filterInputRef}
                                  className="tb-filter-input"
                                  placeholder={`筛选 ${col}…`}
                                  value={filters[col]?.value ?? ''}
                                  onChange={(e) => setFilterValue(col, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === 'Escape') setFilterOpen(null)
                                  }}
                                />
                                {filters[col]?.value && (
                                  <button
                                    className="tb-filter-clear"
                                    onClick={() => { clearFilter(col); setFilterOpen(null) }}
                                  >
                                    清除
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {/* 草稿（新增）行 */}
                {draftRows.map((draft, di) => (
                  <tr key={`draft-${di}`} className="tb-tr tb-tr--draft">
                    <td className="tb-td tb-td--ops">
                      <button className="tb-draft-del" data-tip="移除此行" onClick={() => removeDraft(di)}>
                        <Trash2 size={11} />
                      </button>
                    </td>
                    {columns.map((col, ci) => (
                      <td key={ci} className="tb-td tb-td--edit">
                        <input
                          className="tb-cell-input"
                          value={draft[col] ?? ''}
                          placeholder="NULL / 默认"
                          autoComplete="off" spellCheck={false}
                          onChange={(e) => setDraftCell(di, col, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                {visibleRows.map(({ row, ri }) => (
                  <tr key={ri} data-ri={ri}
                    className={`tb-tr${selectedRows.has(ri) ? ' tb-tr--selected' : ''}${currentMatch === ri ? ' tb-tr--match' : ''}`}>
                    <td className="tb-td tb-td--rownum tb-td--gutter"
                      data-tip="点击/拖拽选择行"
                      onClick={(e) => handleRowClick(e, ri)}
                      onMouseDown={(e) => onRowMouseDown(e, ri)}
                      onMouseEnter={() => onRowMouseEnter(ri)} />
                    {draftRows.length > 0 && <td className="tb-td tb-td--ops" />}
                    {row.map((cell, ci) => {
                      const isEditing = editCell?.ri === ri && editCell?.ci === ci
                      return (
                        <td
                          key={ci}
                          className={`tb-td ${cell === null ? 'tb-td--null' : ''}${isEditing ? ' tb-td--editing' : ''}${activeCell?.ri === ri && activeCell?.ci === ci ? ' tb-td--active' : ''}${cellInSel(ri, ci) ? ' tb-td--cellsel' : ''}`}
                          onMouseDown={(e) => onCellMouseDown(e, ri, ci)}
                          onMouseEnter={() => onCellMouseEnter(ri, ci)}
                          onDoubleClick={() => startEdit(ri, ci)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setActiveCell({ ri, ci })
                            setSelectedRows(prev => prev.has(ri) ? prev : new Set([ri]))
                            setRowCtx({ x: e.clientX, y: e.clientY, ri, ci })
                          }}
                        >
                          {isEditing ? (
                            <div className="tb-cell-edit">
                              <input
                                className="tb-cell-input" autoFocus disabled={savingCell}
                                value={editVal} spellCheck={false}
                                onChange={(e) => setEditVal(e.target.value)}
                                onBlur={saveCell}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); saveCell() }
                                  if (e.key === 'Escape') { e.preventDefault(); setEditCell(null) }
                                }}
                              />
                              <button className="tb-cell-edit__btn tb-cell-edit__btn--ok" disabled={savingCell}
                                data-tip="提交" data-shortcut="Enter"
                                onMouseDown={(e) => e.preventDefault()} onClick={saveCell}>
                                {savingCell ? <Loader2 size={13} className="spin" /> : <Check size={14} />}
                              </button>
                              <button className="tb-cell-edit__btn tb-cell-edit__btn--cancel" disabled={savingCell}
                                data-tip="取消" data-shortcut="Esc"
                                onMouseDown={(e) => e.preventDefault()} onClick={() => setEditCell(null)}>
                                <X size={14} />
                              </button>
                            </div>
                          ) : (cell === null ? 'NULL' : hl(cell))}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {rows.length === 0 && draftRows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={columns.length + 1} className="tb-empty">{readOnly ? '暂无数据' : '暂无数据，点击右上角「新增行」添加'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* 底部属性面板（与数据同时展示：属性/索引/DDL，可拖拽调高度） */}
        {detailOpen && (
          <div className="sb-detail" style={{ height: detailHeight }}>
            <div className="sb-detail__resize-handle" onMouseDown={onDetailDragStart} />
            <div className="sb-detail__header">
              <span className="sb-detail__tname" data-tip={table}>{table}</span>
              <div className="sb-detail__tabs">
                {(['cols', 'idx', 'ddl'] as const).map(t => (
                  <button key={t} className={`sb-detail__tab${detailTab === t ? ' active' : ''}`} onClick={() => switchDetailTab(t)}>
                    {t === 'cols' ? '属性' : t === 'idx' ? '索引' : 'DDL'}
                  </button>
                ))}
              </div>
              <button className="sb-detail__close" data-tip="关闭" onClick={() => setDetailOpen(false)}><X size={12} /></button>
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
                    <thead><tr>{detailColNames.map(h => <th key={h}>{zhCol(h)}</th>)}</tr></thead>
                    <tbody>
                      {detailColRows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c ?? 'NULL'}</td>)}</tr>)}
                      {detailColRows.length === 0 && <tr><td colSpan={detailColNames.length || 1} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>无数据</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
              {!detailLoading && !detailError && detailTab === 'idx' && (
                <div className="sb-detail__table-wrap">
                  <table className="sb-detail__tbl">
                    <thead><tr>{detailIdxNames.map(h => <th key={h}>{zhCol(h)}</th>)}</tr></thead>
                    <tbody>
                      {detailIdxRows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c ?? 'NULL'}</td>)}</tr>)}
                      {detailIdxRows.length === 0 && <tr><td colSpan={detailIdxNames.length || 1} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>无索引</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer / Pagination */}
        <div className="tb-footer">
          <div className="tb-footer__left">
            <SearchableSelect
              value={String(pageSize)}
              onChange={(v) => setPageSize(Number(v) as PageSize)}
              items={PAGE_SIZES.map((s) => ({ value: String(s), label: `${s} 行/页` }))}
              mono={false}
              width={110}
            />
            <span className="tb-footer__info">
              {commitErr ? <span style={{ color: 'var(--error)' }}>{commitErr}</span> : <>
              {execMs > 0 && `${execMs} ms`}
              {totalCount !== null && ` · 共 ${totalCount.toLocaleString()} 行`}
              {selectedRows.size > 1 && ` · 已选 ${selectedRows.size} 行`}</>}
            </span>
            {/* 当前查询 SQL（悬停看完整语句） */}
            {(() => {
              const w = buildWhereClause(), o = buildOrderClause(), off = page * pageSize
              const fullOrder = o || (connType === 'sqlServer' ? 'ORDER BY (SELECT NULL)' : '')
              const full = isOracle(connType)
                ? `SELECT * FROM ${tableRef} ${w} ${o} OFFSET ${off} ROWS FETCH NEXT ${pageSize} ROWS ONLY`
                : connType === 'sqlServer'
                  ? `SELECT * FROM ${tableRef} ${w} ${fullOrder} OFFSET ${off} ROWS FETCH NEXT ${pageSize} ROWS ONLY`
                  : `SELECT * FROM ${tableRef} ${w} ${o} LIMIT ${pageSize} OFFSET ${off}`
              const preview = isOracle(connType)
                ? `SELECT * FROM ${tableRef} ${w} ${o} FETCH FIRST ${pageSize} ROWS ONLY`
                : connType === 'sqlServer'
                  ? `SELECT TOP ${pageSize} * FROM ${tableRef} ${w} ${o}`
                  : `SELECT * FROM ${tableRef} ${w} ${o} LIMIT ${pageSize}`
              return (
                <span className="tb-footer__sql" data-tip={full.replace(/\s+/g, ' ')}>
                  {preview.replace(/\s+/g, ' ')}
                </span>
              )
            })()}
          </div>
          <div className="tb-pager">
            <button
              className="tb-pager__btn"
              disabled={page === 0}
              onClick={(e) => { e.stopPropagation(); setPage(0) }}
            >
              <ChevronsLeft size={12} />
            </button>
            <button
              className="tb-pager__btn"
              disabled={page === 0}
              onClick={(e) => { e.stopPropagation(); setPage((p) => p - 1) }}
            >
              <ChevronLeft size={12} />
            </button>
            <span className="tb-pager__label">
              第 <input className="tb-pager__jump" value={page + 1}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  if (Number.isFinite(n) && n >= 1 && (!totalPages || n <= totalPages)) setPage(n - 1)
                }} /> 页{totalPages ? ` / ${totalPages}` : ''}
            </span>
            <button
              className="tb-pager__btn"
              disabled={rows.length < pageSize && totalCount !== null && (page + 1) * pageSize >= totalCount}
              onClick={(e) => { e.stopPropagation(); setPage((p) => p + 1) }}
            >
              <ChevronRight size={12} />
            </button>
            {totalPages !== null && (
              <button
                className="tb-pager__btn"
                disabled={page >= totalPages - 1}
                onClick={(e) => { e.stopPropagation(); setPage(totalPages! - 1) }}
              >
                <ChevronsRight size={12} />
              </button>
            )}
          </div>
        </div>

        {/* 删除行确认（支持批量） */}
        {delRows && (
          <div className="tb-confirm-overlay">
            <div className="tb-confirm" onClick={(e) => e.stopPropagation()}>
              <div className="tb-confirm__title">删除 {delRows.length} 行？</div>
              <div className="tb-confirm__msg">
                将按主键删除以下行，无法恢复：<br />
                <code>
                  {delRows.slice(0, 5).map(ri =>
                    pkCols.map(pc => `${pc}=${rows[ri]?.[columns.indexOf(pc)] ?? 'NULL'}`).join(', ')
                  ).join('；')}
                  {delRows.length > 5 && ` …等 ${delRows.length} 行`}
                </code>
              </div>
              <div className="tb-confirm__actions">
                <button className="tb-text-btn" disabled={deleting} onClick={() => setDelRows(null)}>取消</button>
                <button className="tb-text-btn tb-text-btn--danger" disabled={deleting} onClick={confirmDeleteRows}>
                  {deleting ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 行详情 */}
        {detailRow !== null && rows[detailRow] && (
          <div className="tb-confirm-overlay">
            <div className="tb-confirm tb-detail" onClick={(e) => e.stopPropagation()}>
              <div className="tb-detail__head">
                <span className="tb-confirm__title" style={{ margin: 0 }}>行详情</span>
                <div className="tb-detail__head-actions">
                  <button className="tb-icon-btn"
                    data-tip={detailView === 'table' ? '切换为文本' : '切换为表格'}
                    onClick={() => setDetailView(v => v === 'table' ? 'text' : 'table')}>
                    {detailView === 'table' ? <AlignLeft size={14} /> : <Table2 size={14} />}
                  </button>
                  <button className="tb-icon-btn" data-tip="复制整行"
                    onClick={() => {
                      const text = columns.map((c, i) => `${c}: ${rows[detailRow][i] ?? 'NULL'}`).join('\n')
                      copyText(text)
                      toast.success('已复制整行')
                    }}>
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              {detailView === 'table' ? (
                <div className="tb-detail__body">
                  {columns.map((col, ci) => (
                    <div key={col} className="tb-detail__row"
                      data-tip="点击复制该值"
                      onClick={() => {
                        const v = rows[detailRow][ci]
                        copyText(v ?? 'NULL')
                        toast.success(`已复制 ${col} 的值`)
                      }}>
                      <span className="tb-detail__col">
                        {colMeta[col]?.key === 'PRI' && '🔑 '}{col}
                        <em>{colMeta[col]?.type}</em>
                      </span>
                      <span className={`tb-detail__val${rows[detailRow][ci] === null ? ' null' : ''}`}>
                        {rows[detailRow][ci] ?? 'NULL'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <textarea className="tb-detail__text" readOnly spellCheck={false}
                  value={columns.map((c, i) => `${c}: ${rows[detailRow][i] ?? 'NULL'}`).join('\n')}
                  onFocus={(e) => e.currentTarget.select()} />
              )}
              <div className="tb-confirm__actions">
                <button className="tb-text-btn" onClick={() => setDetailRow(null)}>关闭</button>
              </div>
            </div>
          </div>
        )}

        {/* 清空表强确认（需输入表名） */}
        {truncOpen && (
          <div className="tb-confirm-overlay">
            <div className="tb-confirm" onClick={(e) => e.stopPropagation()}>
              <div className="tb-confirm__title" style={{ color: 'var(--warning)' }}>
                {connType === 'sqlite' ? 'DELETE 清空表（SQLite）' : 'TRUNCATE 清空表'}
              </div>
              <div className="tb-confirm__msg">
                此操作将清空表 <strong style={{ color: 'var(--warning)' }}>{table}</strong> 的全部数据（保留结构），无法恢复。<br />
                请输入表名 <strong>{table}</strong> 确认：
              </div>
              <input className="tb-cell-input" style={{ height: 30 }} autoFocus
                value={truncInput} placeholder={table} spellCheck={false} autoComplete="off"
                onChange={(e) => setTruncInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmTruncate() }} />
              <div className="tb-confirm__actions">
                <button className="tb-text-btn" disabled={truncBusy} onClick={() => setTruncOpen(false)}>取消</button>
                <button className="tb-text-btn tb-text-btn--danger"
                  disabled={truncInput !== table || truncBusy} onClick={confirmTruncate}>
                  {truncBusy ? '执行中…' : '确认清空'}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
  )

  // 表级弹窗（修改结构，组件内部自带 portal）
  const tableModals = (
    <>
      {editStructOpen && (
        <CreateTableWizard connectionId={connectionId} connType={connType as ConnType} schema={schema} editTable={table}
          onClose={() => setEditStructOpen(false)}
          onDone={() => { setMetaTick(t => t + 1); setPage(0); fetchCount(); fetchData() }} />
      )}
    </>
  )

  // 行右键菜单（portal，避免被滚动容器裁剪）
  const rowCtxMenu = rowCtx && createPortal(
    <div ref={rowCtxRef} className="tb-row-ctx"
      style={{ position: 'fixed', top: Math.min(rowCtx.y, window.innerHeight - 248), left: Math.min(rowCtx.x, window.innerWidth - 200), zIndex: 9999 }}>
      <button onClick={() => { copyText(rows[rowCtx.ri][rowCtx.ci] ?? 'NULL'); toast.success('已复制单元格值'); setRowCtx(null) }}>
        <span className="btn-label"><Copy size={12} />复制单元格值</span>
        {sc('tableCopyCell') && <span className="ctx-item__shortcut">{sc('tableCopyCell')}</span>}
      </button>
      <button onClick={() => { copyRowsAsTab(selectedRows.size > 1 ? [...selectedRows] : [rowCtx.ri]); setRowCtx(null) }}>
        <span className="btn-label"><Copy size={12} />复制行（制表符）</span>
        {sc('tableCopyRow') && <span className="ctx-item__shortcut">{sc('tableCopyRow')}</span>}
      </button>
      <button onClick={() => { copyRowsAsJson(selectedRows.size > 1 ? [...selectedRows] : [rowCtx.ri]); setRowCtx(null) }}>
        <span className="btn-label"><Copy size={12} />复制为 JSON</span>
      </button>
      <button onClick={() => { copyRowsAsInsert(selectedRows.size > 1 ? [...selectedRows] : [rowCtx.ri]); setRowCtx(null) }}>
        <span className="btn-label"><Copy size={12} />复制为 INSERT</span>
        {sc('tableCopyInsert') && <span className="ctx-item__shortcut">{sc('tableCopyInsert')}</span>}
      </button>
      <div className="tb-row-ctx__sep" />
      {/* 写操作：ClickHouse 只读时隐藏（编辑单元格 / 置 NULL / 删除行） */}
      {!readOnly && (
        <button onClick={() => { startEdit(rowCtx.ri, rowCtx.ci); setRowCtx(null) }}>
          <span className="btn-label"><Save size={12} />编辑单元格</span>
        </button>
      )}
      {!readOnly && (
        <button disabled={columns.length === 0}
          onClick={() => { setCellNull(rowCtx.ri, rowCtx.ci); setRowCtx(null) }}>
          <span className="btn-label"><X size={12} />置为 NULL</span>
          {sc('tableSetNull') && <span className="ctx-item__shortcut">{sc('tableSetNull')}</span>}
        </button>
      )}
      <button onClick={() => { setDetailRow(rowCtx.ri); setRowCtx(null) }}>
        <span className="btn-label"><Search size={12} />查看行详情</span>
        {sc('tableRowDetail') && <span className="ctx-item__shortcut">{sc('tableRowDetail')}</span>}
      </button>
      {!readOnly && (
        <>
          <div className="tb-row-ctx__sep" />
          <button className="danger" disabled={columns.length === 0}
            onClick={() => { askDeleteRows(selectedRows.size > 1 ? [...selectedRows] : [rowCtx.ri]); setRowCtx(null) }}>
            <span className="btn-label"><Trash2 size={12} />删除{selectedRows.size > 1 ? ` ${selectedRows.size} 行` : '行'}</span>
            {sc('tableDelRow') && <span className="ctx-item__shortcut">{sc('tableDelRow')}</span>}
          </button>
        </>
      )}
    </div>,
    document.body
  )

  const styleTag = (
      <style>{`
        .tb-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,0.55);
          backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
        }
        .tb-embedded-wrap { position: absolute; inset: 0; display: flex; }
        .tb-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          width: min(1100px, calc(100vw - 48px));
          height: min(720px, calc(100vh - 48px));
          display: flex; flex-direction: column;
          animation: slideUp 0.18s cubic-bezier(0.34,1.2,0.64,1);
          overflow: hidden;
          position: relative;
        }
        .tb-card--embedded {
          width: 100%; height: 100%;
          border: none; border-radius: 0; animation: none;
        }
        .tb-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 5px 12px;
          border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0; min-height: 36px;
        }
        .tb-export-wrap { position: relative; }
        .tb-export-menu {
          position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 4px; min-width: 200px; max-width: 360px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.28);
          white-space: nowrap;
        }
        .tb-export-menu button {
          display: flex; align-items: center; gap: 12px;
          width: 100%; text-align: left; padding: 7px 10px; border-radius: 6px;
          font-size: 12.5px; color: var(--text); background: none;
          white-space: nowrap;
        }
        .tb-export-menu button .btn-label { flex: 1; display: flex; align-items: center; gap: 7px; }
        .tb-export-grid__label { font-size: 11px; color: var(--text-muted); padding: 4px 8px 3px; }
        .tb-export-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; padding: 0 6px 4px; }
        .tb-export-grid .tb-export-chip {
          width: auto; padding: 6px 2px; border-radius: 6px; font-size: 11.5px; text-align: center;
          justify-content: center; background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
        }
        .tb-export-grid .tb-export-chip:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
        .tb-export-menu button .btn-label > svg { flex-shrink: 0; }
        .tb-export-menu .ctx-item__shortcut { margin-left: auto; }
        .tb-export-menu button:hover { background: var(--surface-hover); }
        .tb-export-menu button.danger { color: #dc2626; }
        .tb-export-menu button.danger:hover { background: rgba(220,38,38,0.1); }
        .tb-icon-btn--primary { background: var(--accent); color: #fff; }
        .tb-icon-btn--primary:hover:not(:disabled) { background: var(--accent-hover); color: #fff; }
        .tb-footer__left { display: flex; align-items: center; gap: 10px; }
        .tb-header__title {
          font-size: 13px; font-weight: 600; color: var(--text-bright);
          display: flex; align-items: center; gap: 8px;
        }
        .tb-header__count {
          font-size: 11px; font-weight: 400; color: var(--text-muted);
        }
        .tb-header__actions {
          display: flex; align-items: center; gap: 4px;
        }
        .tb-filter-badge {
          font-size: 11px; padding: 2px 7px; border-radius: 10px;
          background: var(--accent-bg); color: var(--accent);
          border: 1px solid rgba(92,110,248,0.3);
        }
        .tb-icon-btn {
          padding: 5px; border-radius: 6px;
          color: var(--text-muted);
          display: flex; align-items: center; justify-content: center;
        }
        .tb-icon-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
        .tb-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .tb-table-wrap {
          flex: 1; overflow: auto; position: relative;
        }
        /* 结果表格滚动条加粗显眼（覆盖全局 4px 细条），纵横双向都可见 */
        .tb-table-wrap::-webkit-scrollbar { width: 12px; height: 12px; }
        .tb-table-wrap::-webkit-scrollbar-track { background: var(--surface-2); }
        .tb-table-wrap::-webkit-scrollbar-thumb {
          background: var(--border); border-radius: 6px;
          border: 3px solid var(--surface-2); background-clip: padding-box;
        }
        .tb-table-wrap::-webkit-scrollbar-thumb:hover { background: var(--text-muted); background-clip: padding-box; }
        .tb-table-wrap::-webkit-scrollbar-corner { background: var(--surface-2); }
        .tb-loading-overlay {
          position: absolute; inset: 0; z-index: 10;
          background: rgba(0,0,0,0.3);
          display: flex; align-items: center; justify-content: center;
        }
        .tb-error {
          padding: 16px; color: var(--error); font-size: 12px;
        }
        .tb-table {
          width: 100%; border-collapse: collapse;
          font-size: 12px;
        }
        .tb-th {
          position: sticky; top: 0; z-index: 5;
          background: var(--surface-2);
          border-bottom: 1px solid var(--border);
          padding: 0; white-space: nowrap;
          font-weight: 500; color: var(--text-muted);
          text-align: left;
        }
        .tb-th { border-right: 1px solid var(--border-subtle); }
        /* 行首窄边：用于整行选择（点击/拖拽），不显示行号 */
        .tb-th--rownum, .tb-td--rownum { width: 12px; min-width: 12px; max-width: 12px; padding: 0; }
        .tb-td--gutter { cursor: pointer; background: var(--surface-2); }
        .tb-td--gutter:hover { background: var(--surface-hover); }
        .tb-tr--selected .tb-td--gutter { background: var(--accent); }
        .tb-th-inner {
          display: flex; align-items: center;
          padding: 6px 8px; gap: 2px;
        }
        .tb-th-label {
          display: flex; align-items: center; gap: 4px; cursor: pointer;
          color: var(--text); font-size: 12.5px; font-weight: var(--fw-semibold);
          flex: 1; min-width: 0;
        }
        .tb-th-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tb-th-pk { font-size: 9px; flex-shrink: 0; }
        .tb-th-label:hover { color: var(--accent); }
        .tb-sort-icon { flex-shrink: 0; color: var(--accent); }
        /* 未排序时的中性箭头：仅在表头 hover 时淡显，提示该列可排序 */
        .tb-sort-icon--idle { color: var(--text-muted); opacity: 0; transition: opacity 0.12s; }
        .tb-th:hover .tb-sort-icon--idle { opacity: 0.55; }
        .tb-filter-wrap { position: relative; }
        .tb-filter-btn {
          padding: 2px; border-radius: 4px;
          color: var(--text-muted); opacity: 0.5;
          display: flex; align-items: center;
        }
        .tb-filter-btn:hover, .tb-filter-btn--open { opacity: 1; color: var(--text); }
        .tb-filter-btn--active { opacity: 1; color: var(--accent); }
        .tb-filter-popup {
          position: absolute; top: calc(100% + 4px); right: 0; z-index: 20;
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 8px; padding: 6px;
          display: flex; flex-direction: column; gap: 4px;
          min-width: 160px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        }
        .tb-filter-input {
          background: var(--bg); border: 1px solid var(--border);
          border-radius: 6px; color: var(--text); font-size: 12px;
          padding: 4px 8px;
        }
        .tb-filter-clear {
          font-size: 11px; color: var(--error);
          text-align: right; padding: 0 2px;
        }
        .tb-filter-clear:hover { text-decoration: underline; }
        .tb-tr { transition: background 0.12s ease; user-select: none; cursor: default; }
        .tb-tr:hover { background: var(--surface-hover); }
        .tb-tr--selected .tb-td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
        .tb-tr--match { background: var(--accent-bg) !important; }
        .tb-tr--match .tb-td { border-bottom-color: var(--accent-glow); }
        .tb-tr--match .tb-hl { background: var(--accent); color: #fff; }
        .tb-hl { background: var(--accent-bg); color: var(--accent); border-radius: 2px; padding: 0 1px; }
        .tb-wherebar__hint { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
        .tb-icon-btn--on { color: var(--accent); background: var(--accent-bg); }
        .tb-td {
          padding: 5px 8px; border-bottom: 1px solid var(--border-subtle);
          border-right: 1px solid var(--border-subtle);
          color: var(--text); font-size: 12px;
          max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .tb-th--ops, .tb-td--ops { width: 34px; min-width: 34px; text-align: center; }
        .tb-td--ops { padding: 2px; }
        .tb-td--null { color: var(--text-muted); font-style: italic; }
        .tb-td--active { box-shadow: inset 0 0 0 2px var(--accent); border-radius: 2px; }
        /* 单元格区域选择高亮（鼠标划过框选） */
        .tb-td--cellsel { background: var(--accent-bg); }
        .tb-td--editing { padding: 1px 3px; }
        .tb-cell-edit { display: flex; align-items: center; gap: 3px; }
        .tb-cell-edit .tb-cell-input { flex: 1; min-width: 60px; height: 24px; }
        .tb-cell-edit__btn {
          flex-shrink: 0; width: 24px; height: 24px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
          border: 1px solid var(--border); cursor: pointer; background: var(--surface);
        }
        .tb-cell-edit__btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .tb-cell-edit__btn--ok { background: var(--accent); color: #fff; border-color: var(--accent); }
        .tb-cell-edit__btn--ok:hover:not(:disabled) { background: var(--accent-hover); }
        .tb-cell-edit__btn--cancel { color: var(--text-muted); }
        .tb-cell-edit__btn--cancel:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
        .tb-empty {
          padding: 32px; text-align: center; color: var(--text-muted); font-size: 12px;
        }
        .tb-footer {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 14px;
          border-top: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }
        .tb-footer__info { font-size: 11px; color: var(--text-muted); }
        .tb-pager { display: flex; align-items: center; gap: 2px; }
        .tb-pager__btn {
          padding: 4px; border-radius: 5px; color: var(--text-muted);
          display: flex; align-items: center;
        }
        .tb-pager__btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
        .tb-pager__btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .tb-pager__label { font-size: 11px; color: var(--text-muted); padding: 0 6px; }
        .tb-text-btn {
          display: flex; align-items: center; gap: 4px;
          font-size: 12px; padding: 4px 9px; border-radius: 6px;
          color: var(--text); background: var(--surface-2); border: 1px solid var(--border);
          cursor: pointer;
        }
        .tb-text-btn:hover:not(:disabled) { background: var(--surface-hover); }
        .tb-text-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .tb-text-btn--primary { background: var(--accent); color: #fff; border-color: var(--accent); }
        .tb-text-btn--primary:hover:not(:disabled) { background: var(--accent-hover); }
        .tb-draft-hint { font-size: 11px; color: var(--accent); }
        .tb-tr--draft { background: var(--accent-bg); }
        .tb-td--edit { padding: 2px 4px; }
        .tb-cell-input {
          width: 100%; min-width: 80px; height: 24px; padding: 0 6px;
          border: 1px solid var(--border); border-radius: 4px;
          background: var(--bg); color: var(--text); font-size: 12px; outline: none;
        }
        .tb-cell-input:focus { border-color: var(--accent); }
        .tb-cell-input::placeholder { color: var(--text-muted); opacity: 0.6; }
        .tb-draft-del {
          display: flex; align-items: center; justify-content: center;
          color: #dc2626; padding: 2px; border-radius: 4px;
        }
        .tb-draft-del:hover { background: rgba(220,38,38,0.12); }
        .tb-icon-btn--danger:hover:not(:disabled) { background: rgba(220,38,38,0.12); color: #dc2626; }
        .tb-text-btn--danger { color: #dc2626; }
        .tb-text-btn--danger:hover:not(:disabled) { background: rgba(220,38,38,0.1); }
        /* WHERE 过滤栏 */
        .tb-wherebar {
          display: flex; align-items: center; gap: 8px;
          padding: 5px 12px; border-bottom: 1px solid var(--border-subtle);
          background: var(--surface-2); flex-shrink: 0;
        }
        .tb-wherebar__label { font-size: 11px; font-weight: 700; color: var(--text-muted); letter-spacing: 0.04em; }
        .tb-wherebar__input {
          flex: 1; height: 26px; padding: 0 10px; border: 1px solid var(--border);
          border-radius: 6px; background: var(--bg); color: var(--text); font-size: 12px;
          font-family: var(--font-mono); outline: none;
        }
        .tb-wherebar__input:focus { border-color: var(--accent); }
        .tb-wherebar__btn {
          display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px;
          border: 1px solid var(--border); border-radius: 6px; background: var(--accent);
          color: #fff; font-size: 12px; cursor: pointer;
        }
        .tb-wherebar__btn:hover:not(:disabled) { background: var(--accent-hover); }
        .tb-wherebar__btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .tb-wherebar__btn--ghost { background: var(--surface); color: var(--text); }
        .tb-wherebar__btn--ghost:hover { background: var(--surface-hover); }
        .tb-tr--selected { background: var(--accent-bg) !important; }
        .tb-tr--selected .tb-td { border-color: var(--accent-glow); }
        /* 删除行确认弹窗 */
        .tb-confirm-overlay {
          position: absolute; inset: 0; z-index: 50;
          background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center;
        }
        .tb-confirm {
          width: 320px; padding: 20px; background: var(--surface);
          border: 1px solid var(--border); border-radius: 14px;
          box-shadow: 0 16px 50px rgba(0,0,0,0.4); display: flex; flex-direction: column; gap: 10px;
        }
        .tb-confirm__title { font-size: 15px; font-weight: 600; color: var(--text-bright); }
        .tb-confirm__msg { font-size: 12.5px; color: var(--text-muted); line-height: 1.6; }
        .tb-confirm__msg code { color: var(--text); font-size: 11.5px; word-break: break-all; }
        .tb-confirm__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
        /* 底部 SQL 预览 */
        .tb-footer__sql {
          font-size: 11px; color: var(--text-muted);
          font-family: var(--font-mono);
          max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          opacity: 0.75;
        }
        .tb-pager__jump {
          width: 38px; height: 20px; text-align: center;
          border: 1px solid var(--border); border-radius: 4px;
          background: var(--bg); color: var(--text); font-size: 11px; outline: none;
        }
        .tb-pager__jump:focus { border-color: var(--accent); }
        /* 行右键菜单 */
        .tb-row-ctx {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 4px; min-width: 200px; max-width: 340px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.3);
          white-space: nowrap;
        }
        .tb-row-ctx button {
          display: flex; align-items: center; gap: 16px; justify-content: space-between;
          width: 100%; padding: 6px 10px; border-radius: 5px;
          font-size: 12px; color: var(--text); background: none; text-align: left;
          white-space: nowrap;
        }
        .tb-row-ctx button > span.btn-label { display: flex; align-items: center; gap: 7px; }
        .tb-row-ctx button > span.btn-label > svg { flex-shrink: 0; }
        .tb-row-ctx .ctx-item__shortcut { flex-shrink: 0; }
        .tb-row-ctx button:hover:not(:disabled) { background: var(--surface-hover); }
        .tb-row-ctx button:disabled { opacity: 0.4; cursor: not-allowed; }
        .tb-row-ctx button.danger { color: #dc2626; }
        .tb-row-ctx button.danger:hover:not(:disabled) { background: rgba(220,38,38,0.1); }
        .tb-row-ctx__sep { height: 1px; background: var(--border-subtle); margin: 3px 6px; }
        /* 行详情 */
        .tb-detail { width: 460px; max-height: 70%; }
        .tb-detail__head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 10px;
        }
        .tb-detail__head-actions { display: flex; gap: 4px; }
        .tb-detail__text {
          width: 100%; min-height: 200px; max-height: 50vh; resize: vertical;
          box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
          border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
          font-family: var(--font-mono); font-size: 12px; line-height: 1.7;
          outline: none;
        }
        .tb-detail__text:focus { border-color: var(--accent); }
        .tb-detail__body { overflow-y: auto; display: flex; flex-direction: column; }
        .tb-detail__row {
          display: flex; gap: 12px; padding: 7px 4px;
          border-bottom: 1px solid var(--border-subtle); cursor: pointer; border-radius: 4px;
        }
        .tb-detail__row:hover { background: var(--surface-hover); }
        .tb-detail__col {
          width: 150px; flex-shrink: 0; font-size: 12px; color: var(--text);
          display: flex; flex-direction: column;
        }
        .tb-detail__col em {
          font-style: normal; font-size: 10.5px; color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .tb-detail__val {
          flex: 1; font-size: 12px; color: var(--text); word-break: break-all;
          font-family: var(--font-mono);
        }
        .tb-detail__val.null { color: var(--text-muted); font-style: italic; }
        /* 表信息 */
        .tb-info { width: 640px; max-height: 76%; }
        .tb-info__body { overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
        .tb-info__props { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px 16px; }
        .tb-info__prop { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
        .tb-info__prop span { color: var(--text-muted); font-size: 11px; }
        .tb-info__prop strong { color: var(--text); font-weight: 500; word-break: break-all; }
        .tb-info__sub { font-size: 12px; font-weight: 600; color: var(--text-bright); border-top: 1px solid var(--border-subtle); padding-top: 10px; }
        .tb-info__cols { width: 100%; border-collapse: collapse; font-size: 12px; }
        .tb-info__cols th, .tb-info__cols td {
          padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--border-subtle);
          color: var(--text); white-space: nowrap;
        }
        .tb-info__cols th { color: var(--text-muted); font-weight: 600; font-size: 11px; }
        .tb-info__cols .mono { font-family: var(--font-mono); font-size: 11.5px; }
      `}</style>
  )

  if (embedded) {
    return <div className="tb-embedded-wrap">{card}{rowCtxMenu}{tableModals}{styleTag}</div>
  }
  return createPortal(
    <div className="tb-overlay" onMouseDown={onClose}>{card}{rowCtxMenu}{tableModals}{styleTag}</div>,
    document.body
  )
}
