import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { FileCode2, X, Copy, Loader2, TableProperties } from 'lucide-react'
import type { ConnType } from '../../types'
import { tableRef } from '../../utils/sqlDialect'
import SqlCodeView from '../common/SqlCodeView'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  table: string
  onClose: () => void
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
}

const RECENT_LIMIT = 50
const DEFAULT_COL_WIDTH = 180
type PeekActiveRegion = 'ddl' | 'data' | null

// 标识符引用：按方言选择引用符
function quoteIdent(connType: ConnType, ident: string): string {
  if (connType === 'sqlServer') return '[' + ident.replace(/]/g, ']]') + ']'
  if (['postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb', 'oracle'].includes(connType)) {
    return '"' + ident.replace(/"/g, '""') + '"'
  }
  return '`' + ident.replace(/`/g, '``') + '`'
}

export default function TablePeekModal({ connectionId, connType, schema, table, onClose }: Props) {
  const [ddl, setDdl] = useState('')
  const [ddlLoading, setDdlLoading] = useState(true)
  const [ddlError, setDdlError] = useState('')

  const [dataResult, setDataResult] = useState<QueryResult | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)
  const [colOrder, setColOrder] = useState<number[]>([])
  const [colWidths, setColWidths] = useState<Map<number, number>>(new Map())
  const [draggingCol, setDraggingCol] = useState<number | null>(null)
  const [dragOverCol, setDragOverCol] = useState<number | null>(null)
  const [colDragPreview, setColDragPreview] = useState<{ title: string; x: number; y: number } | null>(null)
  const [activeRegion, setActiveRegion] = useState<PeekActiveRegion>(null)
  const colElemRefs = useRef<Map<number, HTMLTableColElement>>(new Map())
  const ddlWrapRef = useRef<HTMLDivElement>(null)
  const dataWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setColOrder(dataResult ? dataResult.columns.map((_, i) => i) : [])
    setColWidths(new Map())
    setDraggingCol(null)
    setDragOverCol(null)
    setColDragPreview(null)
  }, [dataResult?.columns])

  const selectElementContents = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [])

  const buildRecentDataTsv = useCallback(() => {
    if (!dataResult || dataResult.columns.length === 0) return ''
    const cols = colOrder.map(ci => dataResult.columns[ci] ?? '')
    const rows = dataResult.rows.map(row => colOrder.map(ci => row[ci] ?? '').join('\t'))
    return [cols.join('\t'), ...rows].join('\n')
  }, [dataResult, colOrder])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== 'a' && key !== 'c') return
      if (activeRegion === 'ddl' && ddl) {
        e.preventDefault()
        if (key === 'a') selectElementContents(ddlWrapRef.current)
        else navigator.clipboard.writeText(ddl).catch(() => {})
        return
      }
      if (activeRegion === 'data' && dataResult) {
        e.preventDefault()
        if (key === 'a') selectElementContents(dataWrapRef.current)
        else navigator.clipboard.writeText(buildRecentDataTsv()).catch(() => {})
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('column-dragging')
    }
  }, [activeRegion, buildRecentDataTsv, dataResult, ddl, onClose, selectElementContents])

  // 挂载即加载 DDL
  useEffect(() => {
    let alive = true
    ;(async () => {
      setDdlLoading(true); setDdlError('')
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const text = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
        if (alive) setDdl(text)
      } catch (e) {
        if (alive) setDdlError(String(e))
      } finally {
        if (alive) setDdlLoading(false)
      }
    })()
    return () => { alive = false }
  }, [connectionId, schema, table])

  // 加载近期数据：主键倒序取最近 RECENT_LIMIT 行（无主键则不排序直接 LIMIT）
  const loadRecent = useCallback(async () => {
    setDataLoading(true); setDataError(''); setDataLoaded(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const cols = await invoke<{ name: string; key: string }[]>('table_columns', { id: connectionId, schema, table })
      const pk = cols.filter(c => c.key === 'PRI').map(c => c.name)
      // 用共享 tableRef：SQL Server 走三段式 [库]..[对象]，避免两段式被当成「当前库的 schema」
      const tref = tableRef(connType, schema, table)
      const orderBy = pk.length
        ? ` ORDER BY ${pk.map(c => `${quoteIdent(connType, c)} DESC`).join(', ')}`
        : ''
      const sql = connType === 'sqlServer'
        ? `SELECT TOP ${RECENT_LIMIT} * FROM ${tref}${orderBy}`
        : connType === 'oracle'
          ? `SELECT * FROM ${tref}${orderBy} FETCH FIRST ${RECENT_LIMIT} ROWS ONLY`
          : `SELECT * FROM ${tref}${orderBy} LIMIT ${RECENT_LIMIT}`
      const res = await invoke<QueryResult>('execute_query', { id: connectionId, sql, database: schema || undefined })
      setDataResult(res)
    } catch (e) {
      setDataError(String(e))
    } finally {
      setDataLoading(false)
    }
  }, [connectionId, connType, schema, table])

  const moveCol = useCallback((from: number, to: number) => {
    setColOrder(order => {
      const fromPos = order.indexOf(from)
      const toPos = order.indexOf(to)
      if (fromPos < 0 || toPos < 0 || fromPos === toPos) return order
      const next = [...order]
      const [moved] = next.splice(fromPos, 1)
      next.splice(toPos, 0, moved)
      return next
    })
  }, [])

  const startColResize = useCallback((e: React.MouseEvent, ci: number, orderIdx: number) => {
    e.stopPropagation()
    e.preventDefault()
    const colEl = colElemRefs.current.get(orderIdx)
    const th = (e.currentTarget as HTMLElement).closest('th') as HTMLElement | null
    if (!th) return
    const startX = e.clientX
    const startW = th.getBoundingClientRect().width || colWidths.get(ci) || DEFAULT_COL_WIDTH
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(72, Math.min(520, startW + ev.clientX - startX))
      if (colEl) {
        colEl.style.width = `${w}px`
        colEl.style.minWidth = `${w}px`
      }
    }
    const onUp = (ev: MouseEvent) => {
      const w = Math.max(72, Math.min(520, startW + ev.clientX - startX))
      if (colEl) {
        colEl.style.width = ''
        colEl.style.minWidth = ''
      }
      setColWidths(prev => new Map(prev).set(ci, w))
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [colWidths])

  const startColDrag = useCallback((e: React.MouseEvent, ci: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    const startX = e.clientX
    let active = false
    let over: number | null = null
    let bodyMarked = false
    const onMove = (ev: MouseEvent) => {
      if (!active && Math.abs(ev.clientX - startX) < 5) return
      if (!active) {
        active = true
        bodyMarked = true
        document.body.classList.add('column-dragging')
        setDraggingCol(ci)
      }
      setColDragPreview({ title: dataResult?.columns[ci] ?? '', x: ev.clientX, y: ev.clientY })
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const th = el?.closest('[data-peek-colidx]') as HTMLElement | null
      const idx = th ? parseInt(th.dataset.peekColidx ?? '', 10) : NaN
      const next = Number.isNaN(idx) ? null : idx
      if (next !== over) {
        over = next
        setDragOverCol(next)
      }
    }
    const onUp = () => {
      if (active && over != null && over !== ci) moveCol(ci, over)
      setDraggingCol(null)
      setDragOverCol(null)
      setColDragPreview(null)
      if (bodyMarked) document.body.classList.remove('column-dragging')
      window.getSelection()?.removeAllRanges()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [dataResult, moveCol])

  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-box table-peek" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            <FileCode2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            {schema ? `${schema}.` : ''}{table} — 表预览
          </span>
          <button className="modal-close" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="table-peek__body">
          {/* DDL 区 */}
          <div className="table-peek__section-head">
            <span>DDL</span>
            {!ddlLoading && !ddlError && ddl && (
              <button
                className="table-peek__copy"
                onClick={() => navigator.clipboard.writeText(ddl).catch(() => {})}
              >
                <Copy size={12} />复制
              </button>
            )}
          </div>
          {ddlLoading && (
            <div className="result-placeholder" style={{ padding: 24 }}>
              <Loader2 size={16} className="spin" /><span>获取 DDL…</span>
            </div>
          )}
          {ddlError && <div className="result-error" style={{ margin: '4px 0' }}>{ddlError}</div>}
          <div ref={ddlWrapRef} onMouseDown={() => setActiveRegion('ddl')}>
            {!ddlLoading && !ddlError && (
              ddl
                ? <SqlCodeView code={ddl} connType={connType} className="table-peek__ddl-cm" wrap />
                : <pre className="table-peek__ddl">（无 DDL）</pre>
            )}
          </div>

          {/* 近期数据区 */}
          <div className="table-peek__section-head" style={{ marginTop: 14 }}>
            <span>近期数据</span>
            <button className="table-peek__load" onClick={loadRecent} disabled={dataLoading}>
              {dataLoading ? <Loader2 size={12} className="spin" /> : <TableProperties size={12} />}
              {dataLoaded ? '重新加载' : '展示近期数据'}
            </button>
          </div>

          {dataError && <div className="result-error" style={{ margin: '4px 0' }}>{dataError}</div>}
          {!dataError && dataLoaded && !dataLoading && dataResult && (
            dataResult.columns.length === 0 || dataResult.rows.length === 0 ? (
              <div className="result-placeholder" style={{ padding: 20 }}><span>暂无数据</span></div>
            ) : (
              <div className="table-peek__data" ref={dataWrapRef} onMouseDown={() => setActiveRegion('data')}>
                <table className="table-peek__table">
                  <colgroup>
                    {colOrder.map((ci, orderIdx) => {
                      const w = colWidths.get(ci) ?? DEFAULT_COL_WIDTH
                      return (
                        <col
                          key={`${dataResult.columns[ci]}-${ci}`}
                          ref={el => { if (el) colElemRefs.current.set(orderIdx, el); else colElemRefs.current.delete(orderIdx) }}
                          style={{ width: w, minWidth: w }}
                        />
                      )
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      {colOrder.map((ci, orderIdx) => {
                        const col = dataResult.columns[ci]
                        const w = colWidths.get(ci) ?? DEFAULT_COL_WIDTH
                        return (
                          <th
                            key={ci}
                            title={col}
                            data-peek-colidx={ci}
                            className={`${draggingCol === ci ? ' col-dragging' : ''}${dragOverCol === ci && draggingCol !== ci ? ' col-drag-over' : ''}`}
                            style={{ width: w, minWidth: w }}
                            onMouseDown={(e) => startColDrag(e, ci)}
                          >
                            <span>{col}</span>
                            <div className="table-peek__th-resizer" onMouseDown={(e) => startColResize(e, ci, orderIdx)} />
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {dataResult.rows.map((row, ri) => (
                      <tr key={ri}>
                        {colOrder.map((ci) => {
                          const cell = row[ci] ?? null
                          const w = colWidths.get(ci) ?? DEFAULT_COL_WIDTH
                          return (
                          <td key={ci} title={cell ?? 'NULL'} style={{ width: w, maxWidth: w }}>
                            {cell === null
                              ? <span className="table-peek__null">NULL</span>
                              : cell}
                          </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
        {colDragPreview && (
          <div
            className="column-drag-preview"
            style={{ transform: `translate3d(${colDragPreview.x + 12}px, ${colDragPreview.y + 12}px, 0)` }}
          >
            <span className="column-drag-preview__icon">›_</span>
            <span className="column-drag-preview__label">{colDragPreview.title}</span>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
