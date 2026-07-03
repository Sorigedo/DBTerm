// DB 分屏左侧面板：schema 树 + 表列表，点击插入表名，双击预览数据
import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRight, RefreshCw, Table2, Eye, Search, X, Columns } from 'lucide-react'
import type { ConnType } from '../../types'

interface TableItem { name: string; isView: boolean }
interface ColItem { name: string; key: string }

interface Props {
  connectionId: string
  connType: ConnType
  currentSchema: string
  onInsertText: (text: string) => void
  onPreviewTable: (schema: string, table: string) => void
}

export default function DbBrowser({ connectionId, connType, currentSchema, onInsertText, onPreviewTable }: Props) {
  const [schemas, setSchemas] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tableMap, setTableMap] = useState<Map<string, TableItem[]>>(new Map())
  const [colMap, setColMap] = useState<Map<string, ColItem[]>>(new Map())
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadingSchema, setLoadingSchema] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Ref 缓存用于在 stale closure 中读取最新 Map，避免 refresh 后命中旧缓存
  const tableMapRef = useRef(tableMap)
  const colMapRef   = useRef(colMap)
  tableMapRef.current = tableMap
  colMapRef.current   = colMap

  // currentSchema 只需首次初始展开用，不放进 loadSchemas deps，避免切库触发全量重载
  const currentSchemaRef = useRef(currentSchema)
  currentSchemaRef.current = currentSchema

  const loadTables = useCallback(async (schema: string) => {
    if (tableMapRef.current.has(schema)) return
    setLoadingSchema(schema)
    try {
      const list = await invoke<TableItem[]>('list_tables', { id: connectionId, schema })
      setTableMap(prev => new Map(prev).set(schema, list))
    } catch { /* ignore */ }
    finally { setLoadingSchema(null) }
  }, [connectionId])

  const loadCols = useCallback(async (schema: string, table: string) => {
    const key = `${schema}\0${table}`
    if (colMapRef.current.has(key)) return
    try {
      const cols = await invoke<ColItem[]>('table_columns', { id: connectionId, schema, table })
      setColMap(prev => new Map(prev).set(key, cols))
    } catch { /* ignore */ }
  }, [connectionId])

  const loadSchemas = useCallback(async () => {
    setLoading(true)
    try {
      const list = await invoke<string[]>('list_schemas', { id: connectionId })
      setSchemas(list)
      const target = currentSchemaRef.current
      const first  = (target && list.includes(target)) ? target : list[0]
      if (first) {
        setExpanded(new Set([first]))
        loadTables(first)
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [connectionId, loadTables])

  useEffect(() => { loadSchemas() }, [loadSchemas])

  function refresh() {
    // 先清缓存再重载；因为 loadSchemas 里的 loadTables 读 tableMapRef.current，
    // 所以必须先把 ref 里的 Map 替换掉，否则 loadTables 仍命中旧缓存
    const emptyT = new Map<string, TableItem[]>()
    const emptyC = new Map<string, ColItem[]>()
    tableMapRef.current = emptyT
    colMapRef.current   = emptyC
    setTableMap(emptyT)
    setColMap(emptyC)
    setExpandedTables(new Set())
    loadSchemas()
  }

  // 副作用从 setState updater 里移出，避免 Strict Mode 双调用
  function toggleSchema(schema: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(schema)) { next.delete(schema) } else { next.add(schema) }
      return next
    })
    // 展开时加载表（幂等：内部有缓存判断）
    if (!expanded.has(schema)) loadTables(schema)
  }

  function toggleTable(schema: string, table: string) {
    const key = `${schema}\0${table}`
    setExpandedTables(prev => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
    if (!expandedTables.has(key)) loadCols(schema, table)
  }

  const quoteIdent = (name: string) => {
    if (['mysql', 'mariadb', 'tidb', 'oceanBase', 'clickHouse'].includes(connType)) return `\`${name}\``
    if (['postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb', 'oracle'].includes(connType)) return `"${name}"`
    if (connType === 'sqlServer') return `[${name}]`
    return name
  }

  const q = search.trim().toLowerCase()

  function filterTables(tables: TableItem[]) {
    if (!q) return tables
    return tables.filter(t => t.name.toLowerCase().includes(q))
  }

  return (
    <div className="db-browser">
      <div className="db-browser__header">
        <Table2 size={12} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>对象浏览器</span>
        <button className="dbt-header-btn" onClick={refresh} disabled={loading} data-tip="刷新">
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
        </button>
      </div>

      <div style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <Search size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="过滤表名…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', fontSize: 12, color: 'var(--text)', minWidth: 0 }} />
          {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-muted)', display: 'flex' }}><X size={11} /></button>}
        </div>
      </div>

      <div className="db-browser__tree">
        {schemas.length === 0 && !loading && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>无 schema 数据</div>
        )}
        {schemas.map(schema => {
          const isExpanded = expanded.has(schema)
          const tables = filterTables(tableMap.get(schema) ?? [])
          const isLoading = loadingSchema === schema
          const matchSchema = !q || schema.toLowerCase().includes(q) || (tableMap.get(schema) ?? []).some(t => t.name.toLowerCase().includes(q))
          if (q && !matchSchema) return null

          return (
            <div key={schema} className="dbt-schema-node">
              <button className={`dbt-schema-row${isExpanded ? ' active' : ''}`} onClick={() => toggleSchema(schema)}>
                <span className="dbt-schema-arrow-hit">
                  <ChevronRight size={12} className="dbt-schema-arrow" style={{ transform: isExpanded ? 'rotate(90deg)' : undefined }} />
                </span>
                <span className="dbt-icon--db">◈</span>
                <span className="dbt-schema-name" data-tip={schema}>{schema}</span>
                {schema === currentSchema && <span className="dbt-schema-default">当前</span>}
              </button>

              {isExpanded && (
                <div className="dbt-schema-children">
                  {isLoading && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)' }}>加载中…</div>}
                  {tables.map(t => {
                    const tableKey = `${schema}\0${t.name}`
                    const colsExpanded = expandedTables.has(tableKey)
                    const cols = colMap.get(tableKey)

                    return (
                      <div key={t.name}>
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 10px', borderRadius: 4, cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => onInsertText(quoteIdent(t.name))}
                          onDoubleClick={() => onPreviewTable(schema, t.name)}
                          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); toggleTable(schema, t.name) }}
                          data-tip="单击插入表名 · 双击预览数据 · 右键展开列"
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          {t.isView
                            ? <Eye size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                            : <Table2 size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                          }
                          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                          <button
                            onClick={e => { e.stopPropagation(); toggleTable(schema, t.name) }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px', color: 'var(--text-muted)', display: 'flex', flexShrink: 0, opacity: 0.7 }}
                            data-tip="展开列">
                            <Columns size={10} />
                          </button>
                        </div>

                        {colsExpanded && (
                          <div style={{ paddingLeft: 22 }}>
                            {cols === undefined
                              ? <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 4px' }}>加载中…</div>
                              : cols.length === 0
                              ? <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 4px' }}>无列</div>
                              : cols.map(col => (
                                <div key={col.name}
                                  onClick={() => onInsertText(quoteIdent(col.name))}
                                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px', fontSize: 11, cursor: 'pointer', borderRadius: 3 }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                  data-tip="单击插入列名">
                                  <span style={{ color: col.key === 'PRI' ? '#ea580c' : 'var(--text-muted)', fontSize: 10, width: 8, flexShrink: 0 }}>
                                    {col.key === 'PRI' ? '🔑' : '·'}
                                  </span>
                                  <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.name}</span>
                                </div>
                              ))
                            }
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {!isLoading && tables.length === 0 && !q && (
                    <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)' }}>无表</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ padding: '5px 8px', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', flexShrink: 0, lineHeight: 1.5 }}>
        单击插入 · 双击预览 · 右键展开列
      </div>
    </div>
  )
}
