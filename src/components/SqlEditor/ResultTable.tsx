import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, Filter, X, ArrowUpDown, BarChart2, AlertCircle, Copy, PanelRight, ChevronRight as ChevronRightIcon, Plus, Minus, Check } from 'lucide-react'
import type { EditCtx } from './index'
import type { ConnType } from '../../types'
import { qid, tableRef as dialectTableRef, sqlStr } from '../../utils/sqlDialect'
import { appendRollback } from '../../stores/rollbackStore'
import BlobViewPanel from './BlobViewPanel'
import ChartPanel from './ChartPanel'
import SearchableSelect from '../DbTools/SearchableSelect'
import { useShortcuts } from '../../utils/useShortcuts'
import { useSettingsStore } from '../../stores/settingsStore'
import type { DbResultDefaultView } from '../../stores/settingsStore'
import { useWheelScroll } from '../../utils/wheelScroll'
import { displayShortcutStr, SHORTCUT_DEFS } from '../../utils/shortcuts'
import { toast } from '../../stores/toastStore'
import { notifyExportStart, notifyExported, notifyExportError } from '../../stores/exportDoneStore'
import { useAppStore } from '../../stores/appStore'
import { requireProdConfirm } from '../../stores/confirmStore'
import { formatDuration } from '../../utils/formatDuration'

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
  truncated?: boolean
}

type StagedChange =
  | { type: 'insert'; row: (string | null)[]; tempId: string }
  | { type: 'delete'; absRow: number; pkValues: (string | null)[] }
  | { type: 'update'; absRow: number; col: number; oldVal: string | null; newVal: string | null; pkValues: (string | null)[] }

const LIMIT_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: '前 200 行', value: 200 },
  { label: '前 500 行', value: 500 },
  { label: '前 1000 行', value: 1000 },
  { label: '全部', value: null },
]

const GRID_ROW_HEIGHT = 28
const GRID_OVERSCAN = 12
const GRID_DEFAULT_COL_WIDTH = 180
const TEXT_PREVIEW_ROW_LIMIT = 2000

function RowLimitSelector({ limit, onChange }: { limit: number | null; onChange: (v: number | null) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = LIMIT_OPTIONS.find(o => o.value === limit) ?? LIMIT_OPTIONS[0]

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="row-limit-btn"
        onClick={() => setOpen(v => !v)}
        title="修改查询行数上限（下次执行生效）"
      >
        {current.label}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ marginLeft: 3 }}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <div className="row-limit-menu">
          {LIMIT_OPTIONS.map(opt => (
            <button
              key={String(opt.value)}
              className={`row-limit-menu__item${opt.value === limit ? ' row-limit-menu__item--active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  result: QueryResult | null
  running: boolean
  error: string
  connectionId?: string
  /** 连接类型，用于按方言生成行编辑/复制 SQL 的标识符引号 */
  connType: ConnType
  /** 非空表示结果可行内编辑（单表查询且主键齐全） */
  editCtx?: EditCtx | null
  onCellUpdate?: (rowIdx: number, colIdx: number, value: string | null) => void
  onRefresh?: () => void
  /** 工具栏传送目标：传入则把操作栏渲染到该节点（如结果区页签行右侧） */
  toolbarSlot?: HTMLElement | null
  /** 是否处于激活标签：false 时不响应结果表快捷键，避免隐藏标签"冒泡"触发 */
  active?: boolean
  /** 当前 Tab 的查询行数上限（独立于全局设置，每个 Tab 各自维护） */
  queryLimit?: number | null
  onQueryLimitChange?: (v: number | null) => void
}

interface CtxMenu {
  x: number
  y: number
  absRow: number
  col: number
  isStaged: boolean
  tempId?: string
}

const VIEW_LABELS: Record<'grid' | 'json' | 'text' | 'form', string> = { grid: '表格', json: 'JSON', text: '文本', form: '表单' }

function csvEscape(v: string | null): string {
  if (v === null) return ''
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function sqlLiteral(v: string | null): string {
  if (v === null) return 'NULL'
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  return sqlStr(v)
}

// 当前焦点是否在编辑器 / 输入框（用于无文本选区时避免误复制结果单元格）
function isInEditorOrInput(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.classList.contains('cm-content')))
}
// 复制聚焦输入框/文本域内选中文本；输入框聚焦时一律拦截（避免落到结果单元格）
function copyInputSelection(): boolean {
  const ae = document.activeElement
  if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
    const t = ae.value.substring(ae.selectionStart ?? 0, ae.selectionEnd ?? 0)
    if (t) navigator.clipboard.writeText(t).then(() => toast.success('已复制')).catch(() => {})
    return true
  }
  return false
}
// 复制页面文本选区（contentEditable / pre / 单元格文本等）
function copyWindowSelection(): boolean {
  const t = window.getSelection()?.toString() ?? ''
  if (t) { navigator.clipboard.writeText(t).then(() => toast.success('已复制')).catch(() => {}); return true }
  return false
}
// 当前是否存在「表格区域外」的真实文本选区（如 DDL/属性面板）。
// 用于让 Cmd+C 把这类选区交还浏览器原生复制，而不是被残留的单元格选区抢走。
function textSelectionOutsideGrid(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.toString()) return false
  let node: Node | null = sel.anchorNode
  while (node) {
    if (node instanceof HTMLElement && node.classList.contains('result-table-scroll')) return false
    node = node.parentNode
  }
  return true
}

function generateSql(
  change: StagedChange,
  columns: string[],
  editCtx: EditCtx,
  connType: ConnType
): string {
  const tref = dialectTableRef(connType, editCtx.schema, editCtx.table)
  if (change.type === 'insert') {
    const cols = columns.map((c) => qid(connType, c)).join(', ')
    const vals = change.row.map(sqlLiteral).join(', ')
    return `INSERT INTO ${tref} (${cols}) VALUES (${vals});`
  }
  if (change.type === 'delete') {
    const where = editCtx.pkCols
      .map((pk, i) => `${qid(connType, pk)}=${sqlLiteral(change.pkValues[i])}`)
      .join(' AND ')
    return `DELETE FROM ${tref} WHERE ${where};`
  }
  // update
  const where = editCtx.pkCols
    .map((pk, i) => `${qid(connType, pk)}=${sqlLiteral(change.pkValues[i])}`)
    .join(' AND ')
  return `UPDATE ${tref} SET ${qid(connType, columns[change.col])}=${sqlLiteral(change.newVal)} WHERE ${where};`
}

export default function ResultTable({
  result,
  running,
  error,
  connectionId,
  connType,
  editCtx,
  onCellUpdate,
  onRefresh,
  toolbarSlot,
  active = true,
  queryLimit = 200,
  onQueryLimitChange,
}: Props) {
  const [, setPage] = useState(0)
  const [exportOnlySelected] = useState(false)

  const userShortcuts = useSettingsStore(s => s.shortcuts)
  const dbResultDefaultView = useSettingsStore(s => s.dbResultDefaultView)
  const dbResultFilterDefaultOpen = useSettingsStore(s => s.dbResultFilterDefaultOpen)
  const sc = (id: string) => {
    const combo = userShortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
    return displayShortcutStr(combo)
  }

  // K6 — 行详情（内联「表单」形态，非弹窗）
  const [formIdx, setFormIdx] = useState(0)
  const showForm = useCallback((absRow: number) => { setFormIdx(absRow); setViewMode('form') }, [])
  // R7 — BLOB 查看器
  const [blobView, setBlobView] = useState<{ value: string | null; column: string } | null>(null)
  // M3 — 图表
  const [chartOpen, setChartOpen] = useState(false)

  // K7 — 客户端过滤 & 列排序
  const [filterText, setFilterText] = useState('')
  const [filterCol, setFilterCol] = useState<number>(-1) // -1 = 全列
  const [sortCol, setSortCol] = useState<number>(-1)
  const [sortAsc, setSortAsc] = useState(true)
  const [showFilter, setShowFilter] = useState(dbResultFilterDefaultOpen) // 过滤栏默认值来自偏好设置，Mod+F 可临时切换
  const [viewMode, setViewMode] = useState<DbResultDefaultView | 'form'>(dbResultDefaultView) // 结果展示形态
  const [viewMenuOpen, setViewMenuOpen] = useState(false) // 展示方式上弹菜单
  useEffect(() => {
    if (!viewMenuOpen) return
    const close = () => setViewMenuOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [viewMenuOpen])
  // 列拖拽换位：colOrder 是显示顺序(存真实列索引)，渲染按它排列但 ci 始终是真实索引，
  // 故排序/编辑/过滤等按列索引的逻辑不受影响
  const [colOrder, setColOrder] = useState<number[]>([])
  useEffect(() => { setColOrder(result ? result.columns.map((_, i) => i) : []); setCellSel(null) }, [result])
  // 列宽拖拽：colWidths 存 ci → px 宽度（undefined 表示自动）
  const [colWidths, setColWidths] = useState<Map<number, number>>(new Map())
  useEffect(() => { setColWidths(new Map()) }, [result])
  const colElemRefs = useRef<Map<number, HTMLTableColElement>>(new Map())
  // 滚轮驱动横向滚动条：统一规则（见 utils/wheelScroll）
  const tableScrollRef = useRef<HTMLDivElement>(null)
  useWheelScroll(tableScrollRef)
  const [gridScrollTop, setGridScrollTop] = useState(0)
  const [gridViewportH, setGridViewportH] = useState(360)
  const gridScrollRaf = useRef(0)
  const syncGridViewport = useCallback(() => {
    const el = tableScrollRef.current
    if (!el) return
    setGridViewportH(el.clientHeight || 360)
    setGridScrollTop(el.scrollTop)
  }, [])
  useEffect(() => {
    const el = tableScrollRef.current
    if (!el || viewMode !== 'grid') return
    syncGridViewport()
    const ro = new ResizeObserver(syncGridViewport)
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewMode, syncGridViewport])
  useEffect(() => () => cancelAnimationFrame(gridScrollRaf.current), [])
  const onGridScroll = useCallback(() => {
    cancelAnimationFrame(gridScrollRaf.current)
    gridScrollRaf.current = requestAnimationFrame(syncGridViewport)
  }, [syncGridViewport])
  const startColResize = (e: React.MouseEvent, ci: number, orderIdx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const colEl = colElemRefs.current.get(orderIdx)
    const th = (e.currentTarget as HTMLElement).closest('th') as HTMLElement
    const startX = e.clientX
    const startW = th.getBoundingClientRect().width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (me: MouseEvent) => {
      const newW = Math.max(56, startW + me.clientX - startX)
      if (colEl) { colEl.style.width = `${newW}px`; colEl.style.minWidth = `${newW}px` }
    }
    const onUp = (me: MouseEvent) => {
      const newW = Math.max(56, startW + me.clientX - startX)
      if (colEl) { colEl.style.width = ''; colEl.style.minWidth = '' }
      setColWidths(prev => new Map(prev).set(ci, newW))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const [draggingCol, setDraggingCol] = useState<number | null>(null)
  const [dragOverCol, setDragOverCol]  = useState<number | null>(null)
  const [colDragPreview, setColDragPreview] = useState<{ title: string; x: number; y: number } | null>(null)
  const moveCol = (from: number, to: number) => setColOrder(o => {
    const fp = o.indexOf(from), tp = o.indexOf(to)
    if (fp < 0 || tp < 0 || fp === tp) return o
    const n = [...o]; const [m] = n.splice(fp, 1); n.splice(tp, 0, m); return n
  })
  // WKWebView 不可靠支持 HTML5 DnD API in table-th；改用 mouse 事件 + elementFromPoint
  const startColDrag = (e: React.MouseEvent, ci: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    const startX = e.clientX
    let active = false
    let over: number | null = null
    let bodyMarked = false
    const onMove = (me: MouseEvent) => {
      if (!active && Math.abs(me.clientX - startX) < 5) return
      if (!active) {
        active = true
        bodyMarked = true
        document.body.classList.add('column-dragging')
        setDraggingCol(ci)
      }
      setColDragPreview({ title: result?.columns[ci] ?? '', x: me.clientX, y: me.clientY })
      const el = document.elementFromPoint(me.clientX, me.clientY)
      const th = el?.closest('[data-colidx]') as HTMLElement | null
      const idx = th ? parseInt(th.dataset.colidx ?? '') : NaN
      const next = !isNaN(idx) ? idx : null
      if (next !== over) { over = next; setDragOverCol(next) }
    }
    const onUp = () => {
      if (active && over != null && over !== ci) moveCol(ci, over)
      setDraggingCol(null); setDragOverCol(null)
      setColDragPreview(null)
      if (bodyMarked) document.body.classList.remove('column-dragging')
      window.getSelection()?.removeAllRanges()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 多选
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const lastClickedRow = useRef<string | null>(null)

  // 行号栏：点击/拖拽选行 + 右键行菜单（Navicat 风格）
  const rowDragRef = useRef<{ anchor: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null)
  const [rowMenuSub, setRowMenuSub] = useState<{ x: number; y: number } | null>(null) // 「复制为」子菜单（fixed 定位，避开父菜单 overflow:hidden 裁剪）
  const [textMenu, setTextMenu] = useState<{ x: number; y: number } | null>(null) // JSON/文本/表单 右键复制菜单
  useEffect(() => {
    if (!textMenu) return
    const close = () => setTextMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [textMenu])
  useEffect(() => {
    const up = () => { rowDragRef.current = null; cellDragRef.current = false }
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('column-dragging')
      setColDragPreview(null)
    }
  }, [])
  useEffect(() => {
    if (!rowMenu) return
    const close = () => { setRowMenu(null); setRowMenuSub(null) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [rowMenu])
  const selectRowRange = useCallback((a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const next = new Set<string>()
    for (let i = lo; i <= hi; i++) next.add(String(i))
    setSelectedRows(next)
  }, [])
  const blurEditorOrInput = () => {
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.classList.contains('cm-content') || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur()
  }
  // ── 单元格区域选择（按可视行 r / 可视列 v）──────────────────────────────
  function onCellMouseDown(e: React.MouseEvent, r: number, v: number) {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, button')) return
    if (e.shiftKey && cellSel) { setCellSel({ a: cellSel.a, f: { r, v } }); return }
    e.preventDefault()
    // preventDefault 会保留 SQL 编辑器焦点，导致 Mod+C 被输入框保护逻辑跳过。
    blurEditorOrInput()
    window.getSelection()?.removeAllRanges()
    cellDragRef.current = true
    setCellSel({ a: { r, v }, f: { r, v } })
    setFocusedCell({ absRow: r, col: colOrderRef.current[v] ?? v })
    if (selectedRows.size) setSelectedRows(new Set())   // 选单元格清整行选择（互斥）
  }
  function onCellMouseEnter(r: number, v: number) {
    if (!cellDragRef.current) return
    setCellSel(s => s ? { a: s.a, f: { r, v } } : { a: { r, v }, f: { r, v } })
  }
  const onRownumMouseDown = useCallback((absRow: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    // preventDefault 会保留原焦点（常为编辑器）→ 让结果区快捷键(复制/Space 等)失效；主动失焦
    blurEditorOrInput()
    window.getSelection()?.removeAllRanges()
    setFocusedCell(null)   // 选行与选单元格互斥
    setCellSel(null)
    if (e.shiftKey && lastClickedRow.current !== null) {
      const a = parseInt(lastClickedRow.current, 10)
      if (!isNaN(a)) selectRowRange(a, absRow)
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const n = new Set(prev)
        n.has(String(absRow)) ? n.delete(String(absRow)) : n.add(String(absRow))
        return n
      })
      lastClickedRow.current = String(absRow)
    } else {
      setSelectedRows(new Set([String(absRow)]))
      lastClickedRow.current = String(absRow)
      rowDragRef.current = { anchor: absRow }
    }
  }, [selectRowRange])
  const onRownumEnter = useCallback((absRow: number) => {
    if (rowDragRef.current) selectRowRange(rowDragRef.current.anchor, absRow)
  }, [selectRowRange])

  // 行内编辑（双击 → 暂存 update）
  const [editing, setEditing] = useState<{ absRow: number; col: number; val: string } | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // 暂存变更
  const [stagedChanges, setStagedChanges] = useState<StagedChange[]>([])
  const [committing, setCommitting] = useState(false)

  // 预览 SQL 模态
  const [previewOpen, setPreviewOpen] = useState(false)

  // 右键菜单
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)

  // 键盘操作：当前聚焦的单元格（点击记录）
  const [focusedCell, setFocusedCell] = useState<{ absRow: number; col: number } | null>(null)
  // 单元格矩形区域选择（按可视行/列位置 r/v）：鼠标划过即框选；整行用左侧窄边 gutter
  const [cellSel, setCellSel] = useState<{ a: { r: number; v: number }; f: { r: number; v: number } } | null>(null)
  const cellDragRef = useRef(false)
  // 供原生 copy 事件读取当前可视行/列（避免在其 deps 里引用尚未声明的 pageRows）
  const pageRowsRef = useRef<(string | null)[][]>([])
  const colOrderRef = useRef<number[]>([])
  // 选区 → TSV（按可视行列矩形）
  const cellSelToTsv = (sel: { a: { r: number; v: number }; f: { r: number; v: number } }): string => {
    const r0 = Math.min(sel.a.r, sel.f.r), r1 = Math.max(sel.a.r, sel.f.r)
    const v0 = Math.min(sel.a.v, sel.f.v), v1 = Math.max(sel.a.v, sel.f.v)
    const lines: string[] = []
    for (let r = r0; r <= r1; r++) {
      const row = pageRowsRef.current[r]; if (!row) continue
      const out: string[] = []
      for (let v = v0; v <= v1; v++) out.push(row[colOrderRef.current[v]] ?? '')
      lines.push(out.join('\t'))
    }
    return lines.join('\n')
  }
  const cellInSel = (r: number, v: number) => {
    if (!cellSel) return false
    const r0 = Math.min(cellSel.a.r, cellSel.f.r), r1 = Math.max(cellSel.a.r, cellSel.f.r)
    const v0 = Math.min(cellSel.a.v, cellSel.f.v), v1 = Math.max(cellSel.a.v, cellSel.f.v)
    return r >= r0 && r <= r1 && v >= v0 && v <= v1
  }

  // 新增行 — 暂存 insert 的行内编辑
  const [insertEditing, setInsertEditing] = useState<{ tempId: string; col: number; val: string } | null>(null)
  const insertInputRef = useRef<HTMLInputElement>(null)

  // 新查询结果重置
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPage(0)
    setEditing(null)
    setStagedChanges([])
    setSelectedRows(new Set())
    setFilterText('')
    setFilterCol(-1)
    setSortCol(-1)
    setShowFilter(dbResultFilterDefaultOpen)
    setViewMode(dbResultDefaultView)
    setGridScrollTop(0)
    tableScrollRef.current?.scrollTo({ top: 0 })
    lastClickedRow.current = null
  }, [result?.columns, dbResultDefaultView, dbResultFilterDefaultOpen])

  // 关闭右键菜单（点击别处）
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  // ──────────────────────────────────────────────
  // 辅助：获取某行的 PK 值
  // ──────────────────────────────────────────────
  const getPkValues = useCallback(
    (absRow: number): (string | null)[] => {
      if (!result || !editCtx) return []
      const row = result.rows[absRow]
      if (!row) return []
      return editCtx.pkCols.map((pk) => row[result.columns.indexOf(pk)] ?? null)
    },
    [result, editCtx]
  )

  // ──────────────────────────────────────────────
  // 暂存操作
  // ──────────────────────────────────────────────
  const addInsertRow = useCallback(() => {
    if (!result) return
    const tempId = `insert-${Date.now()}-${Math.random()}`
    const emptyRow: (string | null)[] = result.columns.map(() => null)
    setStagedChanges((prev) => [...prev, { type: 'insert', row: emptyRow, tempId }])
  }, [result])

  const deleteSelectedRows = useCallback(() => {
    if (!editCtx || !result) return
    setStagedChanges((prev) => {
      const next = [...prev]
      for (const key of selectedRows) {
        if (key.startsWith('insert-')) {
          // 删除暂存的 insert
          const idx = next.findIndex((c) => c.type === 'insert' && c.tempId === key)
          if (idx !== -1) next.splice(idx, 1)
        } else {
          const absRow = parseInt(key, 10)
          if (isNaN(absRow)) continue
          // 避免重复
          if (next.some((c) => c.type === 'delete' && c.absRow === absRow)) continue
          next.push({ type: 'delete', absRow, pkValues: getPkValues(absRow) })
        }
      }
      return next
    })
    setSelectedRows(new Set())
  }, [editCtx, result, selectedRows, getPkValues])

  // 双击单元格 → 暂存 update（而非立即提交）
  const startCellEdit = useCallback(
    (absRow: number, col: number, currentVal: string | null) => {
      if (!editCtx) return
      setEditing({ absRow, col, val: currentVal ?? '' })
      setTimeout(() => editInputRef.current?.select(), 30)
    },
    [editCtx]
  )

  const commitCellEdit = useCallback(() => {
    if (!editing || !result || !editCtx) return
    const { absRow, col, val } = editing
    const row = result.rows[absRow]
    if (!row) { setEditing(null); return }
    const oldVal = row[col]
    // 值未变
    if ((oldVal ?? '') === val) { setEditing(null); return }
    if (oldVal === null && val === '') { setEditing(null); return }

    const newVal = val === '' ? null : val
    setStagedChanges((prev) => {
      // 合并同行同列的 update
      const existIdx = prev.findIndex(
        (c) => c.type === 'update' && c.absRow === absRow && c.col === col
      )
      if (existIdx !== -1) {
        const existing = prev[existIdx] as Extract<StagedChange, { type: 'update' }>
        const updated = { ...existing, newVal }
        const next = [...prev]
        next[existIdx] = updated
        return next
      }
      return [
        ...prev,
        {
          type: 'update',
          absRow,
          col,
          oldVal,
          newVal,
          pkValues: getPkValues(absRow),
        },
      ]
    })
    // 乐观更新本地视图
    onCellUpdate?.(absRow, col, newVal)
    setEditing(null)
  }, [editing, result, editCtx, getPkValues, onCellUpdate])

  // Insert 行单元格编辑
  const commitInsertEdit = useCallback(() => {
    if (!insertEditing) return
    const { tempId, col, val } = insertEditing
    setStagedChanges((prev) =>
      prev.map((c) => {
        if (c.type === 'insert' && c.tempId === tempId) {
          const newRow = [...c.row]
          newRow[col] = val === '' ? null : val
          return { ...c, row: newRow }
        }
        return c
      })
    )
    setInsertEditing(null)
  }, [insertEditing])

  // ──────────────────────────────────────────────
  // 提交 / 放弃
  // ──────────────────────────────────────────────
  const commitAll = useCallback(async () => {
    if (!editCtx || !connectionId || stagedChanges.length === 0 || committing) return
    // 生产环境写操作二次确认
    const conn = useAppStore.getState().connections.find(c => c.id === connectionId)
    if (!(await requireProdConfirm(conn, `提交 ${stagedChanges.length} 项数据变更到 ${editCtx.schema}.${editCtx.table}`))) return
    setCommitting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const columns = result?.columns ?? []

      const inserts = stagedChanges.filter((c) => c.type === 'insert') as Extract<StagedChange, { type: 'insert' }>[]
      const deletes = stagedChanges.filter((c) => c.type === 'delete') as Extract<StagedChange, { type: 'delete' }>[]
      const updates = stagedChanges.filter((c) => c.type === 'update') as Extract<StagedChange, { type: 'update' }>[]

      for (const ins of inserts) {
        await invoke('db_insert_rows', {
          id: connectionId,
          schema: editCtx.schema,
          table: editCtx.table,
          columns,
          rows: [ins.row],
        })
      }

      for (const del of deletes) {
        await invoke('db_delete_rows', {
          id: connectionId,
          schema: editCtx.schema,
          table: editCtx.table,
          pkColumns: editCtx.pkCols,
          pkValuesList: [del.pkValues],
        })
      }

      for (const upd of updates) {
        await invoke('update_cell', {
          id: connectionId,
          schema: editCtx.schema,
          table: editCtx.table,
          column: columns[upd.col],
          newValue: upd.newVal,
          pkColumns: editCtx.pkCols,
          pkValues: upd.pkValues,
        })
      }

      // R6 回滚 SQL 存档
      if (connectionId && editCtx && result) {
        const tgt = dialectTableRef(connType, editCtx.schema, editCtx.table)
        const reverseLines: string[] = []

        for (const upd of updates) {
          const colName = columns[upd.col]
          const setCl = `${qid(connType, colName)} = ${sqlLiteral(upd.oldVal)}`
          const where = editCtx.pkCols.map((pk, i) => `${qid(connType, pk)} = ${sqlLiteral(upd.pkValues[i])}`).join(' AND ')
          reverseLines.push(`UPDATE ${tgt} SET ${setCl} WHERE ${where};`)
        }

        for (const del of deletes) {
          const rowData = result.rows[del.absRow]
          const colList = columns.map(c => qid(connType, c)).join(', ')
          const valList = rowData.map(v => sqlLiteral(v)).join(', ')
          reverseLines.push(`INSERT INTO ${tgt} (${colList}) VALUES (${valList});`)
        }

        if (reverseLines.length > 0) {
          appendRollback({
            ts: Date.now(),
            connId: connectionId,
            schema: editCtx.schema,
            table: editCtx.table,
            sql: reverseLines.join('\n'),
            description: `${updates.length > 0 ? `UPDATE×${updates.length}` : ''}${deletes.length > 0 ? ` DELETE×${deletes.length}` : ''}`.trim(),
          })
        }
      }

      setStagedChanges([])
      setSelectedRows(new Set())
      onRefresh?.()
      toast.success('已提交变更')
    } catch (e) {
      toast.error('提交失败：' + String(e))
    } finally {
      setCommitting(false)
    }
  }, [editCtx, connectionId, connType, stagedChanges, committing, result, onRefresh])

  const rollbackAll = useCallback(() => {
    setStagedChanges([])
    setSelectedRows(new Set())
  }, [])

  // ──────────────────────────────────────────────
  // 分页 & 行列表
  // ──────────────────────────────────────────────
  // K7 — filtered + sorted rows (client-side, no DB query)
  const filteredRows = useMemo(() => {
    let rows = result?.rows ?? []
    if (filterText.trim()) {
      const q = filterText.toLowerCase()
      rows = rows.filter(row => {
        if (filterCol >= 0) return (row[filterCol] ?? '').toLowerCase().includes(q)
        return row.some(cell => (cell ?? '').toLowerCase().includes(q))
      })
    }
    if (sortCol >= 0) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortCol] ?? ''
        const bv = b[sortCol] ?? ''
        const n1 = parseFloat(av), n2 = parseFloat(bv)
        const cmp = !isNaN(n1) && !isNaN(n2) ? n1 - n2 : av.localeCompare(bv)
        return sortAsc ? cmp : -cmp
      })
    }
    return rows
  }, [result, filterText, filterCol, sortCol, sortAsc])

  // 选中行的数据（按行号升序）
  const selectedRowData = useCallback(() => {
    const idxs = [...selectedRows].map(k => parseInt(k, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b)
    return idxs.map(i => filteredRows[i]).filter(Boolean)
  }, [selectedRows, filteredRows])

  // 生成选中行文本（多格式），不写剪贴板
  const buildRowsText = useCallback((fmt: 'tsv' | 'csv' | 'json' | 'sql' | 'md'): string => {
    const rows = selectedRowData()
    if (!rows.length || !result) return ''
    const cols = result.columns
    if (fmt === 'tsv') return rows.map(r => r.map(v => v ?? '').join('\t')).join('\n')
    if (fmt === 'csv') return [cols.map(csvEscape).join(','), ...rows.map(r => r.map(csvEscape).join(','))].join('\n')
    if (fmt === 'json') return JSON.stringify(rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), null, 2)
    if (fmt === 'sql') {
      const tbl = editCtx ? dialectTableRef(connType, editCtx.schema, editCtx.table) : 'your_table'
      return rows.map(r => `INSERT INTO ${tbl} (${cols.map(c => qid(connType, c)).join(', ')}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n')
    }
    const h = `| ${cols.join(' | ')} |`
    const d = `| ${cols.map(() => '---').join(' | ')} |`
    return [h, d, ...rows.map(r => `| ${r.map(v => (v ?? 'NULL').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n')
  }, [selectedRowData, result, editCtx, connType])

  // 复制选中行（写剪贴板 + 提示）——供右键菜单/导出菜单显式调用
  const copyRows = useCallback((fmt: 'tsv' | 'csv' | 'json' | 'sql' | 'md') => {
    const text = buildRowsText(fmt)
    if (!text) return
    navigator.clipboard.writeText(text).then(() => toast.success(`已复制 ${selectedRows.size} 行`)).catch(() => {})
  }, [buildRowsText, selectedRows])

  // 原生复制事件：Ctrl+C / 右键复制。有文本选区或在编辑器/输入框 → 交给浏览器原生复制（静默）；
  // 仅当"选了行 / 聚焦单元格但无文本选区"时由我们接管，避免"选中即复制 + 到处弹提示"。
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isInEditorOrInput()) return
      // 显式选中行优先于浏览器自带文本选区（拖拽选行常残留文本选区，否则会退化成单行原生复制）
      if (selectedRows.size > 0) {
        const t = buildRowsText(viewMode === 'json' ? 'json' : 'tsv')
        if (t) { e.preventDefault(); e.clipboardData?.setData('text/plain', t); toast.success(`已复制 ${selectedRows.size} 行`) }
        return
      }
      if (cellSel) {   // 选中单元格区域 → 复制为 TSV
        e.preventDefault(); e.clipboardData?.setData('text/plain', cellSelToTsv(cellSel)); toast.success('已复制选中单元格')
        return
      }
      // 表格外（DDL / 属性面板等）有真实文本选区 → 交还浏览器原生复制
      if (textSelectionOutsideGrid()) return
      if (window.getSelection()?.toString()) return
      if (focusedCell && result) {
        e.preventDefault()
        e.clipboardData?.setData('text/plain', result.rows[focusedCell.absRow]?.[focusedCell.col] ?? '')
        toast.success('已复制单元格')
      }
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [selectedRows, focusedCell, cellSel, result, viewMode, buildRowsText])

  // 行号栏右键 → 行菜单
  const onRowCtxMenu = useCallback((e: React.MouseEvent, absRow: number) => {
    e.preventDefault(); e.stopPropagation()
    if (!selectedRows.has(String(absRow))) {
      setSelectedRows(new Set([String(absRow)]))
      lastClickedRow.current = String(absRow)
    }
    setRowMenu({ x: e.clientX, y: e.clientY }); setRowMenuSub(null)
  }, [selectedRows])

  // KB2 结果表快捷键
  useShortcuts('result-table', {
    tableRefresh:  () => onRefresh?.(),
    tableFilter:   () => { setShowFilter(true); setTimeout(() => filterInputRef.current?.focus(), 0) },
    tableAddRow:   () => { if (editCtx) addInsertRow() },
    tableDelRow:   () => { if (editCtx && selectedRows.size > 0) deleteSelectedRows() },
    tableCommit:   () => { if (stagedChanges.length > 0) commitAll() },
    tableRowDetail: () => {
      if (!filteredRows.length) return
      showForm(focusedCell?.absRow ?? 0)
    },
    tableSetNull: () => {
      if (!focusedCell || !editCtx || !result) return
      const { absRow, col } = focusedCell
      const pkValues = getPkValues(absRow)
      setStagedChanges(prev => {
        const filtered = prev.filter(c => !(c.type === 'update' && c.absRow === absRow && c.col === col))
        return [...filtered, { type: 'update', absRow, col, oldVal: result.rows[absRow]?.[col] ?? null, newVal: null, pkValues }]
      })
      onCellUpdate?.(absRow, col, null)
    },
    // 注意：Ctrl+C 不再走全局 keydown 拦截，改由原生 copy 事件处理（见上方 useEffect），
    // 以免选中文本时也被接管。Mod+Shift+C 仍保留为"显式复制选中行/单元格"。
    tableCopyRow: () => {
      if (copyInputSelection()) return
      if (isInEditorOrInput()) return
      if (selectedRows.size > 0) { copyRows(viewMode === 'json' ? 'json' : 'tsv'); return }
      if (cellSel) { navigator.clipboard.writeText(cellSelToTsv(cellSel)).then(() => toast.success('已复制选中单元格')).catch(() => {}); return }
      if (focusedCell && result) {
        const row = result.rows[focusedCell.absRow] ?? []
        navigator.clipboard.writeText(row.map(v => v ?? '').join('\t')).then(() => toast.success('已复制整行')).catch(() => {})
        return
      }
      if (copyWindowSelection()) return
    },
    tableCopyInsert: () => {
      if (selectedRows.size > 0) { copyRows('sql'); return }
      if (isInEditorOrInput()) return
      if (!focusedCell || !result) return
      const row = result.rows[focusedCell.absRow] ?? []
      const cols = result.columns.map(c => qid(connType, c)).join(', ')
      const vals = row.map(v => sqlLiteral(v)).join(', ')
      const tbl = editCtx ? dialectTableRef(connType, editCtx.schema, editCtx.table) : qid(connType, '?')
      navigator.clipboard.writeText(`INSERT INTO ${tbl} (${cols}) VALUES (${vals});`).then(() => toast.success('已复制 INSERT 语句')).catch(() => {})
    },
    tableExport: () => { if (result) exportResult('csv') },
    tableViewMode: () => setViewMode(m => m === 'grid' ? 'json' : m === 'json' ? 'text' : m === 'text' ? 'form' : 'grid'),
  }, active)

  const pageRows = filteredRows
  pageRowsRef.current = filteredRows
  colOrderRef.current = colOrder
  const virtualGrid = useMemo(() => {
    const rowCount = filteredRows.length
    if (rowCount === 0) {
      return { rows: [] as Array<{ row: (string | null)[]; absRow: number }>, start: 0, topPad: 0, bottomPad: 0 }
    }
    const visibleCount = Math.ceil(gridViewportH / GRID_ROW_HEIGHT) + GRID_OVERSCAN * 2
    const start = Math.max(0, Math.floor(gridScrollTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN)
    const end = Math.min(rowCount, start + visibleCount)
    return {
      rows: filteredRows.slice(start, end).map((row, i) => ({ row, absRow: start + i })),
      start,
      topPad: start * GRID_ROW_HEIGHT,
      bottomPad: Math.max(0, (rowCount - end) * GRID_ROW_HEIGHT),
    }
  }, [filteredRows, gridScrollTop, gridViewportH])

  // Mod+A：全选当前结果区所有单元格（仅激活标签响应；编辑器/输入框内不拦）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a' || e.shiftKey || e.altKey) return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.classList.contains('cm-content'))) return
      if (pageRows.length === 0 || colOrder.length === 0) return
      e.preventDefault()
      setSelectedRows(new Set())
      setFocusedCell(null)
      setCellSel({ a: { r: 0, v: 0 }, f: { r: pageRows.length - 1, v: colOrder.length - 1 } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, pageRows.length, colOrder.length])

  // Mod+C：复制选中单元格/行。
  // WebKit（Tauri WebView）下纯 React 选区不会触发原生 copy 事件，Ctrl/Cmd+C 无任何反应，
  // 这里在 keydown 主动接管；preventDefault 会抑制后续原生 copy 事件，故不会重复复制。
  // 仍优先尊重真实文本选区：无显式选区且存在文本选区时交还浏览器原生复制。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c' || e.shiftKey || e.altKey) return
      if (isInEditorOrInput()) return
      if (selectedRows.size > 0) {
        const t = buildRowsText(viewMode === 'json' ? 'json' : 'tsv')
        if (t) { e.preventDefault(); navigator.clipboard.writeText(t).then(() => toast.success(`已复制 ${selectedRows.size} 行`)).catch(() => {}) }
        return
      }
      if (cellSel) {
        e.preventDefault(); navigator.clipboard.writeText(cellSelToTsv(cellSel)).then(() => toast.success('已复制选中单元格')).catch(() => {})
        return
      }
      // 表格外（DDL / 属性面板等）有真实文本选区 → 交还浏览器原生复制
      if (textSelectionOutsideGrid()) return
      if (window.getSelection()?.toString()) return
      if (focusedCell && result) {
        e.preventDefault()
        navigator.clipboard.writeText(result.rows[focusedCell.absRow]?.[focusedCell.col] ?? '').then(() => toast.success('已复制单元格')).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, selectedRows, focusedCell, cellSel, result, viewMode, buildRowsText])

  const insertRows = useMemo(
    () => stagedChanges.filter((c) => c.type === 'insert') as Extract<StagedChange, { type: 'insert' }>[],
    [stagedChanges]
  )

  const deletedAbsRows = useMemo(
    () => new Set(stagedChanges.filter((c) => c.type === 'delete').map((c) => (c as Extract<StagedChange, { type: 'delete' }>).absRow)),
    [stagedChanges]
  )

  // absRow → staged update 的 map
  const updateMap = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const c of stagedChanges) {
      if (c.type === 'update') m.set(`${c.absRow}-${c.col}`, c.newVal)
    }
    return m
  }, [stagedChanges])

  // ──────────────────────────────────────────────
  // 导出
  // ──────────────────────────────────────────────
  const getExportRows = useCallback(() => {
    if (!result) return []
    return exportOnlySelected && selectedRows.size > 0
      ? result.rows.filter((_, i) => selectedRows.has(String(i)))
      : result.rows
  }, [result, exportOnlySelected, selectedRows])

  const exportResult = useCallback(async (format: 'csv' | 'json' | 'sql' | 'md' | 'xlsx') => {
    if (!result || result.rows.length === 0) return
    const rows = getExportRows()

    if (format === 'xlsx') {
      let path: string | null = null
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        path = await save({ defaultPath: '查询结果.xlsx', filters: [{ name: 'XLSX', extensions: ['xlsx'] }] })
        if (!path) return
        notifyExportStart()
        const xlsx = await import('xlsx')
        const wsData = [result.columns, ...rows.map((r) => r.map((v) => v ?? ''))]
        const ws = xlsx.utils.aoa_to_sheet(wsData)
        const wb = xlsx.utils.book_new()
        xlsx.utils.book_append_sheet(wb, ws, '查询结果')
        // xlsx.write(type:'array') 返回 ArrayBuffer，须包成 Uint8Array（否则 Array.from 得空数组 → 文件空）
        const buf = new Uint8Array(xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('write_local_bytes', { path, bytes: Array.from(buf) })
        notifyExported(path, `已导出 ${rows.length} 行`)
      } catch (e) {
        notifyExportError('导出失败：' + String(e))
      }
      return
    }

    let content = ''
    if (format === 'csv') {
      const head = result.columns.map((c) => csvEscape(c)).join(',')
      const body = rows.map((r) => r.map(csvEscape).join(',')).join('\n')
      content = `${head}\n${body}\n`
    } else if (format === 'json') {
      const objs = rows.map((r) =>
        Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))
      )
      content = JSON.stringify(objs, null, 2)
    } else if (format === 'sql') {
      const cols = result.columns.join(', ')
      const lines = rows.map(
        (r) => `INSERT INTO your_table (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`
      )
      content = `-- 共 ${rows.length} 行，请将 your_table 替换为实际表名\n${lines.join('\n')}\n`
    } else if (format === 'md') {
      const header = `| ${result.columns.join(' | ')} |`
      const divider = `| ${result.columns.map((c) => '-'.repeat(Math.max(c.length, 3))).join(' | ')} |`
      const body = rows.map(
        (r) => `| ${r.map((v) => (v ?? 'NULL').replace(/\|/g, '\\|')).join(' | ')} |`
      )
      content = [header, divider, ...body].join('\n') + '\n'
    }

    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const ext = format
      const path = await save({
        defaultPath: `查询结果.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      })
      if (!path) return
      notifyExportStart()
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content })
      notifyExported(path, `已导出 ${rows.length} 行`)
    } catch (e) {
      notifyExportError('导出失败：' + String(e))
    }
  }, [result, getExportRows])

  // ──────────────────────────────────────────────
  // 右键菜单处理
  // ──────────────────────────────────────────────
  const handleCellCtxMenu = useCallback(
    (e: React.MouseEvent, absRow: number, col: number, isStaged = false, tempId?: string) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY, absRow, col, isStaged, tempId })
    },
    []
  )

  const handleCtxSetNull = useCallback(() => {
    if (!ctxMenu || !editCtx || !result) return
    const { absRow, col, isStaged, tempId } = ctxMenu
    if (isStaged && tempId) {
      setStagedChanges((prev) =>
        prev.map((c) => {
          if (c.type === 'insert' && c.tempId === tempId) {
            const newRow = [...c.row]
            newRow[col] = null
            return { ...c, row: newRow }
          }
          return c
        })
      )
    } else {
      const row = result.rows[absRow]
      if (!row) return
      const oldVal = row[col]
      setStagedChanges((prev) => {
        const existIdx = prev.findIndex(
          (c) => c.type === 'update' && c.absRow === absRow && c.col === col
        )
        if (existIdx !== -1) {
          const next = [...prev]
          next[existIdx] = { ...(next[existIdx] as Extract<StagedChange, { type: 'update' }>), newVal: null }
          return next
        }
        return [...prev, { type: 'update', absRow, col, oldVal, newVal: null, pkValues: getPkValues(absRow) }]
      })
      onCellUpdate?.(absRow, col, null)
    }
    setCtxMenu(null)
  }, [ctxMenu, editCtx, result, getPkValues, onCellUpdate])

  const handleCtxCopyCell = useCallback(() => {
    if (!ctxMenu || !result) return
    const { absRow, col, isStaged, tempId } = ctxMenu
    let val: string | null = null
    if (isStaged && tempId) {
      const ins = stagedChanges.find((c) => c.type === 'insert' && c.tempId === tempId)
      if (ins && ins.type === 'insert') val = ins.row[col]
    } else {
      val = result.rows[absRow]?.[col] ?? null
    }
    navigator.clipboard.writeText(val ?? '').then(() => toast.success('已复制单元格')).catch(() => {})
    setCtxMenu(null)
  }, [ctxMenu, result, stagedChanges])

  const handleCtxCopyRow = useCallback(() => {
    if (!ctxMenu || !result) return
    const { absRow, isStaged, tempId } = ctxMenu
    let row: (string | null)[] = []
    if (isStaged && tempId) {
      const ins = stagedChanges.find((c) => c.type === 'insert' && c.tempId === tempId)
      if (ins && ins.type === 'insert') row = ins.row
    } else {
      row = result.rows[absRow] ?? []
    }
    navigator.clipboard.writeText(row.map((v) => v ?? '').join('\t')).then(() => toast.success('已复制整行')).catch(() => {})
    setCtxMenu(null)
  }, [ctxMenu, result, stagedChanges])

  const handleCtxDeleteRow = useCallback(() => {
    if (!ctxMenu || !editCtx) return
    const { absRow, isStaged, tempId } = ctxMenu
    if (isStaged && tempId) {
      setStagedChanges((prev) => prev.filter((c) => !(c.type === 'insert' && c.tempId === tempId)))
    } else {
      setStagedChanges((prev) => {
        if (prev.some((c) => c.type === 'delete' && c.absRow === absRow)) return prev
        return [...prev, { type: 'delete', absRow, pkValues: getPkValues(absRow) }]
      })
    }
    setCtxMenu(null)
  }, [ctxMenu, editCtx, getPkValues])

  // ──────────────────────────────────────────────
  // Early returns
  // ──────────────────────────────────────────────
  if (running) {
    return (
      <div className="result-placeholder">
        <Loader2 size={18} className="spin" />
        <span>执行中…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="result-error">
        <AlertCircle size={15} className="result-error__icon" />
        <div className="result-error__msg">{error}</div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="result-placeholder">
        <span>按 {sc('sqlRunAll')} 执行查询</span>
      </div>
    )
  }

  // Non-SELECT result (INSERT/UPDATE/DELETE etc.)：头部已显示「影响 N 行」，此处仅给中性提示
  if (result.columns.length === 0) {
    return (
      <div className="result-placeholder">
        <span>执行完成，无结果集</span>
      </div>
    )
  }

  const hasEditable = !!editCtx
  const selectedCount = selectedRows.size

  const previewRows = viewMode === 'json' || viewMode === 'text'
    ? pageRows.slice(0, TEXT_PREVIEW_ROW_LIMIT)
    : []
  const previewTruncated = (viewMode === 'json' || viewMode === 'text') && pageRows.length > previewRows.length
  // JSON / 文本视图只在激活时生成预览，避免表格模式下为大结果集构造巨型字符串。
  const jsonText = viewMode === 'json'
    ? JSON.stringify(
        previewRows.map(r => Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))),
        null,
        2,
      )
    : ''
  const textView = viewMode === 'text' ? (() => {
    const cols = result.columns
    const cell = (v: string | null) => (v === null ? 'NULL' : v)
    const widths = cols.map((c, ci) =>
      Math.max(c.length, 3, ...previewRows.map(r => cell(r[ci]).length)))
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
    const head = cols.map((c, ci) => pad(c, widths[ci])).join('  ')
    const sep = widths.map(w => '-'.repeat(w)).join('  ')
    const body = previewRows.map(r => cols.map((_, ci) => pad(cell(r[ci]), widths[ci])).join('  ')).join('\n')
    return `${head}\n${sep}\n${body}`
  })() : ''

  // 行内详情目标行：优先聚焦单元格所在行，否则首个选中行
  const detailRow = focusedCell?.absRow ?? (() => {
    for (const k of selectedRows) { const n = parseInt(k, 10); if (!isNaN(n)) return n }
    return null
  })()

  return (
    <div className="result-wrap">
      {/* 结果操作栏（表格/JSON · 图表 · 导出）—— 传送到结果区页签行右侧 */}
      {result && (() => {
        const bar = (
          <div className="result-toolbar">
            <button className={`result-tbtn result-tbtn--icon${viewMode === 'form' ? ' active' : ''}`}
              disabled={detailRow === null && viewMode !== 'form'}
              onClick={() => { if (viewMode === 'form') setViewMode('grid'); else if (detailRow !== null) showForm(detailRow) }}
              data-tip={viewMode === 'form' ? '返回表格' : (detailRow === null ? '行详情（先选中一行）' : '行详情（表单视图）')}>
              <PanelRight size={14} />
            </button>
            {result.columns.length >= 2 && (
              <button className="result-tbtn result-tbtn--icon" onClick={() => setChartOpen(true)} data-tip="可视化图表">
                <BarChart2 size={14} />
              </button>
            )}
            {/* 结果区下载按钮已移除：与工具栏「导出」重复，统一用工具栏导出（无 LIMIT 全量、流式） */}
          </div>
        )
        return toolbarSlot ? createPortal(bar, toolbarSlot) : bar
      })()}

      {/* K7 — 结果集过滤 & 排序（默认隐藏，Mod+F 触发；有过滤/排序时也显示） */}
      {(showFilter || filterText) && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface)' }}>
        <Filter size={11} color="var(--text-muted)" />
        <input
          ref={filterInputRef}
          value={filterText}
          onChange={e => { setFilterText(e.target.value); setPage(0) }}
          placeholder="过滤结果（不回库）..."
          style={{ flex: 1, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11 }}
        />
        <SearchableSelect
          value={String(filterCol)}
          onChange={v => setFilterCol(Number(v))}
          items={[{ value: '-1', label: '全列' }, ...result.columns.map((col, i) => ({ value: String(i), label: col }))]}
          width={130}
        />
        {filterText && (
          <button onClick={() => { setFilterText(''); setPage(0) }} style={{ color: 'var(--text-muted)', lineHeight: 0 }}>
            <X size={11} />
          </button>
        )}
        {filterText && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{filteredRows.length} 条</span>
        )}
        {sortCol >= 0 && (
          <button onClick={() => setSortCol(-1)} style={{ fontSize: 10, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 2 }}>
            <ArrowUpDown size={10} /> 清除排序
          </button>
        )}
        <button onClick={() => { setShowFilter(false); setFilterText(''); setPage(0) }} data-tip="隐藏过滤（Mod+F 重新打开）"
          style={{ color: 'var(--text-muted)', lineHeight: 0, marginLeft: 'auto' }}>
          <X size={12} />
        </button>
      </div>
      )}

      {viewMode === 'json' || viewMode === 'text' ? (
      <div className="result-json-view" onContextMenu={(e) => { e.preventDefault(); setTextMenu({ x: e.clientX, y: e.clientY }) }}>
        <button className="result-json-copy"
          onClick={() => navigator.clipboard.writeText(viewMode === 'json' ? jsonText : textView).then(() => toast.success('已复制')).catch(() => {})}
          data-tip="复制">
          <Copy size={12} />复制
        </button>
        {previewTruncated && (
          <div className="result-preview-limit">
            当前预览前 {TEXT_PREVIEW_ROW_LIMIT} 行，共 {pageRows.length} 行；右键可复制全部。
          </div>
        )}
        <pre>{viewMode === 'json' ? jsonText : textView}</pre>
      </div>
      ) : viewMode === 'form' ? (
      <div className="result-form-view" onContextMenu={(e) => { e.preventDefault(); setTextMenu({ x: e.clientX, y: e.clientY }) }}>
        <div className="result-form-nav">
          <button className="result-pager__btn" disabled={formIdx <= 0} onClick={() => setFormIdx(0)} data-tip="首行"><ChevronsLeft size={14} /></button>
          <button className="result-pager__btn" disabled={formIdx <= 0} onClick={() => setFormIdx(i => Math.max(0, i - 1))} data-tip="上一行"><ChevronLeft size={14} /></button>
          <span className="result-form-pos">第 {Math.min(formIdx + 1, filteredRows.length)} / {filteredRows.length} 行</span>
          <button className="result-pager__btn" disabled={formIdx >= filteredRows.length - 1} onClick={() => setFormIdx(i => Math.min(filteredRows.length - 1, i + 1))} data-tip="下一行"><ChevronRight size={14} /></button>
          <button className="result-pager__btn" disabled={formIdx >= filteredRows.length - 1} onClick={() => setFormIdx(filteredRows.length - 1)} data-tip="末行"><ChevronsRight size={14} /></button>
          <button className="result-tbtn" style={{ marginLeft: 'auto' }} onClick={() => {
            const r = filteredRows[formIdx]
            if (r && result) navigator.clipboard.writeText(result.columns.map((c, i) => `${c}: ${r[i] ?? 'NULL'}`).join('\n')).then(() => toast.success('已复制该行')).catch(() => {})
          }}><Copy size={12} />复制此行</button>
        </div>
        <div className="result-form-body">
          {result.columns.map((c, i) => {
            const raw = filteredRows[formIdx]?.[i] ?? null
            const v = updateMap.has(`${formIdx}-${i}`) ? updateMap.get(`${formIdx}-${i}`)! : raw
            const isEditing = editing?.absRow === formIdx && editing.col === i
            return (
              <div className="result-form-row" key={i}>
                <div className="result-form-key" title={c}>{c}</div>
                <div className={`result-form-val${v === null ? ' result-form-val--null' : ''}${hasEditable ? ' result-form-val--editable' : ''}`}
                  onDoubleClick={() => { if (hasEditable) startCellEdit(formIdx, i, v ?? null) }}>
                  {isEditing ? (
                    <input ref={editInputRef} className="result-cell-input"
                      value={editing.val}
                      onChange={e => setEditing({ ...editing, val: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') commitCellEdit(); if (e.key === 'Escape') setEditing(null) }}
                      onBlur={commitCellEdit} />
                  ) : (v === null ? 'NULL' : v)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      ) : (
      <div className="result-table-scroll" ref={tableScrollRef} onScroll={onGridScroll}>
        <table className="result-table">
          <colgroup>
            <col style={{ width: 6, minWidth: 6 }} />
            {colOrder.map((ci, orderIdx) => {
              const w = colWidths.get(ci) ?? GRID_DEFAULT_COL_WIDTH
              return (
                <col
                  key={ci}
                  ref={el => { if (el) colElemRefs.current.set(orderIdx, el); else colElemRefs.current.delete(orderIdx) }}
                  style={{ width: w, minWidth: w }}
                />
              )
            })}
          </colgroup>
          <thead>
            <tr>
              <th className="result-th result-th--rownum" />
              {colOrder.map((ci, orderIdx) => {
                const col = result.columns[ci]
                const w = colWidths.get(ci) ?? GRID_DEFAULT_COL_WIDTH
                return (
                <th
                  key={ci}
                  className={`result-th${draggingCol === ci ? ' col-dragging' : ''}${dragOverCol === ci && draggingCol !== ci ? ' col-drag-over' : ''}`}
                  data-colidx={ci}
                  data-tip="点击排序 · 拖拽换列位 · 边缘拉宽"
                  onMouseDown={(e) => startColDrag(e, ci)}
                  style={{ cursor: draggingCol != null ? 'grabbing' : 'pointer', userSelect: 'none', position: 'relative', width: w, minWidth: w }}
                  onClick={() => {
                    if (sortCol === ci) {
                      if (sortAsc) setSortAsc(false)
                      else setSortCol(-1)
                    } else { setSortCol(ci); setSortAsc(true) }
                    setPage(0)
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    {col}
                    {sortCol === ci ? (
                      <span style={{ fontSize: 9, color: 'var(--accent)' }}>{sortAsc ? '▲' : '▼'}</span>
                    ) : (
                      <ArrowUpDown size={9} color="var(--border)" style={{ opacity: 0.5 }} />
                    )}
                  </span>
                  <div className="result-th-resizer" onMouseDown={e => startColResize(e, ci, orderIdx)} />
                </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {virtualGrid.topPad > 0 && (
              <tr className="result-virtual-spacer" aria-hidden="true">
                <td colSpan={colOrder.length + 1} style={{ height: virtualGrid.topPad }} />
              </tr>
            )}
            {virtualGrid.rows.map(({ row, absRow }) => {
              const rowKey = String(absRow)
              const isDeleted = deletedAbsRows.has(absRow)
              const isSelected = selectedRows.has(rowKey)

              return (
                <tr
                  key={absRow}
                  className={`result-tr${isDeleted ? ' result-tr--deleted' : ''}${isSelected ? ' result-tr--selected' : ''}`}
                >
                  <td
                    className="result-td result-td--rownum result-td--gutter"
                    data-tip="点击/拖拽选择行 · 双击查看详情 · 右键更多"
                    onMouseDown={(e) => onRownumMouseDown(absRow, e)}
                    onMouseEnter={() => onRownumEnter(absRow)}
                    onDoubleClick={() => showForm(absRow)}
                    onContextMenu={(e) => onRowCtxMenu(e, absRow)}
                  />
                  {/* 行号栏只留窄间隔，不显示序号 */}
                  {colOrder.map((ci, vi) => {
                    const cell = row[ci]
                    const isEditing = editing?.absRow === absRow && editing.col === ci
                    const stagedVal = updateMap.get(`${absRow}-${ci}`)
                    const displayVal = updateMap.has(`${absRow}-${ci}`) ? stagedVal : cell
                    const hasUpdate = updateMap.has(`${absRow}-${ci}`)
                    const w = colWidths.get(ci) ?? GRID_DEFAULT_COL_WIDTH
                    return (
                      <td
                        key={ci}
                        className={[
                          'result-td',
                          displayVal === null ? 'result-td--null' : '',
                          hasEditable && !isDeleted ? 'result-td--editable' : '',
                          hasUpdate ? 'result-td--updated' : '',
                          cellInSel(absRow, vi) ? 'result-td--cellsel' : '',
                        ].filter(Boolean).join(' ')}
                        style={{ width: w, maxWidth: w }}
                        onMouseDown={(e) => onCellMouseDown(e, absRow, vi)}
                        onMouseEnter={() => onCellMouseEnter(absRow, vi)}
                        onDoubleClick={() => {
                          if (!hasEditable || isDeleted) return
                          startCellEdit(absRow, ci, displayVal ?? null)
                        }}
                        onContextMenu={(e) => handleCellCtxMenu(e, absRow, ci, false)}
                      >
                        {isEditing ? (
                          <input
                            ref={editInputRef}
                            className="result-cell-input"
                            value={editing.val}
                            onChange={(e) => setEditing({ ...editing, val: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitCellEdit()
                              if (e.key === 'Escape') setEditing(null)
                            }}
                            onBlur={commitCellEdit}
                          />
                        ) : (
                          displayVal == null ? 'NULL' : displayVal
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {virtualGrid.bottomPad > 0 && (
              <tr className="result-virtual-spacer" aria-hidden="true">
                <td colSpan={colOrder.length + 1} style={{ height: virtualGrid.bottomPad }} />
              </tr>
            )}

            {/* 暂存的 insert 行 */}
            {insertRows.map((ins) => {
              const isSelected = selectedRows.has(ins.tempId)
              return (
                <tr
                  key={ins.tempId}
                  className={`result-tr result-tr--insert${isSelected ? ' result-tr--selected' : ''}`}
                >
                  <td className="result-td result-td--rownum result-td--new" data-tip="未提交的新增行">+</td>
                  {colOrder.map((ci) => {
                    const cell = ins.row[ci]
                    const w = colWidths.get(ci) ?? GRID_DEFAULT_COL_WIDTH
                    const isEditingInsert =
                      insertEditing?.tempId === ins.tempId && insertEditing.col === ci
                    return (
                      <td
                        key={ci}
                        className={`result-td result-td--editable${cell === null ? ' result-td--null' : ''}`}
                        style={{ width: w, maxWidth: w }}
                        onDoubleClick={() => {
                          setInsertEditing({ tempId: ins.tempId, col: ci, val: cell ?? '' })
                          setTimeout(() => insertInputRef.current?.select(), 30)
                        }}
                        onContextMenu={(e) => handleCellCtxMenu(e, -1, ci, true, ins.tempId)}
                      >
                        {isEditingInsert ? (
                          <input
                            ref={insertInputRef}
                            className="result-cell-input"
                            value={insertEditing.val}
                            onChange={(e) =>
                              setInsertEditing({ ...insertEditing, val: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitInsertEdit()
                              if (e.key === 'Escape') setInsertEditing(null)
                            }}
                            onBlur={commitInsertEdit}
                          />
                        ) : (
                          cell === null ? 'NULL' : cell
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* 状态栏 */}
      <div className="result-statusbar">
        {/* 左侧：编辑栏（无边框图标按钮 + hover 放大 + 提示） */}
        {hasEditable && (
          <span className="result-editbar">
            <button className="result-tbtn result-tbtn--icon" data-tip="新增行" onClick={addInsertRow}><Plus size={15} /></button>
            <button className="result-tbtn result-tbtn--icon" data-tip="删除选中行" disabled={selectedCount === 0} onClick={deleteSelectedRows}><Minus size={15} /></button>
            <button className="result-tbtn result-tbtn--icon result-tbtn--ok" data-tip="提交变更" disabled={stagedChanges.length === 0 || committing} onClick={commitAll}><Check size={15} /></button>
            <button className="result-tbtn result-tbtn--icon" data-tip="放弃变更" disabled={stagedChanges.length === 0} onClick={rollbackAll}><X size={15} /></button>
            {stagedChanges.length > 0 && <span className="result-editbar__count">{stagedChanges.length} 项待提交</span>}
            {selectedCount > 0 && stagedChanges.length === 0 && <span className="result-editbar__count">已选 {selectedCount}</span>}
          </span>
        )}
        {/* 展示方式：点击向上弹出选择 */}
        <span className="result-viewmenu" onMouseDown={(e) => e.stopPropagation()}>
          <button className="result-viewmenu__btn" data-tip="切换展示方式" onClick={() => setViewMenuOpen(v => !v)}>
            {VIEW_LABELS[viewMode]}<ChevronUp size={12} />
          </button>
          {viewMenuOpen && (
            <div className="result-viewmenu__pop">
              {(['grid', 'json', 'text', 'form'] as const).map(v => (
                <button key={v} className={viewMode === v ? 'active' : ''} onClick={() => { setViewMode(v); setViewMenuOpen(false) }}>{VIEW_LABELS[v]}</button>
              ))}
            </div>
          )}
        </span>
        <RowLimitSelector limit={queryLimit} onChange={onQueryLimitChange ?? (() => {})} />
        {/* 右侧：行数 / 查询时间 */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="result-statusbar__info">
            {selectedCount === 1
              ? `第 ${parseInt([...selectedRows][0], 10) + 1} 行 共 ${result.rows.length} 行`
              : selectedCount > 1
              ? `选中 ${selectedCount} 行 共 ${result.rows.length} 行`
              : `共 ${result.rows.length} 行`}
            {' · '}查询时间: {formatDuration(result.executionTimeMs)}
          </span>
        </span>
      </div>


      {/* 预览 SQL 模态 */}
      {previewOpen && result && editCtx && createPortal(
        <div
          className="modal-overlay"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false) }}
        >
          <div className="modal-box result-preview-modal">
            <div className="modal-header">
              <span className="modal-title">预览 SQL（{stagedChanges.length} 项变更）</span>
              <button className="modal-close" onClick={() => setPreviewOpen(false)}>✕</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
              <pre className="result-preview-sql">
                {stagedChanges
                  .map((c) => generateSql(c, result.columns, editCtx, connType))
                  .join('\n')}
              </pre>
            </div>
            <div className="modal-footer">
              <button
                className="btn-primary"
                onClick={() => { setPreviewOpen(false); commitAll() }}
                disabled={committing}
              >
                提交
              </button>
              <button className="btn-cancel" onClick={() => setPreviewOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 右键菜单 */}
      {ctxMenu && createPortal(
        <div
          className="cell-ctx-menu"
          style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 220), zIndex: 9999 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {hasEditable && (
            <button className="cell-ctx-menu__item" onClick={handleCtxSetNull}>
              <span>置为 NULL</span>
              {sc('tableSetNull') && <span className="ctx-item__shortcut">{sc('tableSetNull')}</span>}
            </button>
          )}
          <button className="cell-ctx-menu__item" onClick={handleCtxCopyCell}>
            <span>复制单元格</span>
            {sc('tableCopyCell') && <span className="ctx-item__shortcut">{sc('tableCopyCell')}</span>}
          </button>
          <button className="cell-ctx-menu__item" onClick={handleCtxCopyRow}>
            <span>复制行</span>
            {sc('tableCopyRow') && <span className="ctx-item__shortcut">{sc('tableCopyRow')}</span>}
          </button>
          <button className="cell-ctx-menu__item" onClick={() => {
            if (!ctxMenu || !result) return
            const { absRow, col, isStaged, tempId } = ctxMenu
            let cellVal: string | null = null
            if (isStaged && tempId) {
              const staged = stagedChanges.find(c => c.type === 'insert' && c.tempId === tempId)
              if (staged && staged.type === 'insert') cellVal = staged.row[col] ?? null
            } else {
              cellVal = filteredRows[absRow]?.[col] ?? null
            }
            setBlobView({ value: cellVal, column: result.columns[col] ?? '' })
            setCtxMenu(null)
          }}>
            查看 BLOB / 大字段
          </button>
          {hasEditable && (
            <button className="cell-ctx-menu__item cell-ctx-menu__item--danger" onClick={handleCtxDeleteRow}>
              删除此行
            </button>
          )}
        </div>,
        document.body
      )}

      {/* 行号栏右键菜单（行级操作） */}
      {rowMenu && createPortal(
        <div className="cell-ctx-menu" style={{ position: 'fixed', left: Math.min(rowMenu.x, window.innerWidth - 220), top: Math.min(rowMenu.y, window.innerHeight - 240), zIndex: 9999 }}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="cell-ctx-menu__hint">已选 {selectedRows.size} 行</div>
          <button className="cell-ctx-menu__item" onClick={() => {
            const first = selectedRowData().length ? [...selectedRows].map(k => parseInt(k, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b)[0] : null
            if (first != null) showForm(first)
            setRowMenu(null)
          }}>查看行详情</button>
          <button className="cell-ctx-menu__item" onClick={() => { copyRows(viewMode === 'json' ? 'json' : 'tsv'); setRowMenu(null) }}>
            <span>复制{viewMode === 'json' ? '（JSON）' : '（制表符）'}</span><span className="ctx-item__shortcut">{sc('tableCopyRow')}</span>
          </button>
          <button className="cell-ctx-menu__item cell-ctx-menu__sub-trigger"
            onMouseDown={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setRowMenuSub(prev => prev ? null : { x: r.right - 2, y: r.top - 4 })
            }}>
            <span>复制为</span><ChevronRightIcon size={12} />
          </button>
          {hasEditable && (
            <button className="cell-ctx-menu__item cell-ctx-menu__item--danger"
              onClick={() => { deleteSelectedRows(); setRowMenu(null) }}>
              删除选中行<span className="ctx-item__shortcut">{sc('tableDelRow')}</span>
            </button>
          )}
        </div>,
        document.body
      )}

      {/* 「复制为」子菜单：独立 portal + fixed 定位，避开父菜单 overflow:hidden 裁剪 */}
      {rowMenu && rowMenuSub && createPortal(
        <div className="cell-ctx-menu" style={{ position: 'fixed', left: Math.min(rowMenuSub.x, window.innerWidth - 120), top: Math.min(rowMenuSub.y, window.innerHeight - 160), zIndex: 10000 }}
          onMouseDown={(e) => e.stopPropagation()}>
          {(['csv', 'json', 'sql', 'md'] as const).map(f => (
            <button key={f} className="cell-ctx-menu__item" onClick={() => { copyRows(f); setRowMenu(null); setRowMenuSub(null) }}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* R7 — BLOB 查看器 */}
      {blobView && (
        <BlobViewPanel
          value={blobView.value}
          column={blobView.column}
          onClose={() => setBlobView(null)}
        />
      )}

      {/* M3 — 图表 */}
      {chartOpen && result && (
        <ChartPanel
          columns={result.columns}
          rows={filteredRows}
          onClose={() => setChartOpen(false)}
        />
      )}

      {/* JSON / 文本 / 表单 视图右键复制菜单 */}
      {textMenu && createPortal(
        <div className="cell-ctx-menu"
          style={{ position: 'fixed', left: Math.min(textMenu.x, window.innerWidth - 180), top: Math.min(textMenu.y, window.innerHeight - 120), zIndex: 9999 }}
          onMouseDown={(e) => e.stopPropagation()}>
          <button className="cell-ctx-menu__item" onClick={() => { copyWindowSelection() || toast.info('未选中文本'); setTextMenu(null) }}>
            复制选中<span className="ctx-item__shortcut">{sc('tableCopyCell')}</span>
          </button>
          <button className="cell-ctx-menu__item" onClick={() => {
            const all = viewMode === 'json'
              ? JSON.stringify(pageRows.map(r => Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))), null, 2)
              : viewMode === 'text'
                ? (() => {
                    const cell = (v: string | null) => (v === null ? 'NULL' : v)
                    const widths = result.columns.map((c, ci) =>
                      Math.max(c.length, 3, ...pageRows.map(r => cell(r[ci]).length)))
                    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
                    const head = result.columns.map((c, ci) => pad(c, widths[ci])).join('  ')
                    const sep = widths.map(w => '-'.repeat(w)).join('  ')
                    const body = pageRows.map(r => result.columns.map((_, ci) => pad(cell(r[ci]), widths[ci])).join('  ')).join('\n')
                    return `${head}\n${sep}\n${body}`
                  })()
                : result.columns.map((c, i) => `${c}: ${filteredRows[formIdx]?.[i] ?? 'NULL'}`).join('\n')
            navigator.clipboard.writeText(all).then(() => toast.success('已复制全部')).catch(() => {})
            setTextMenu(null)
          }}>复制全部</button>
        </div>,
        document.body
      )}
      {colDragPreview && createPortal(
        <div
          className="column-drag-preview"
          style={{ transform: `translate3d(${colDragPreview.x + 12}px, ${colDragPreview.y + 12}px, 0)` }}
        >
          <span className="column-drag-preview__icon">›_</span>
          <span className="column-drag-preview__label">{colDragPreview.title}</span>
        </div>,
        document.body
      )}
    </div>
  )
}
