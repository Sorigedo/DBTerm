import { useEffect, useState, useCallback } from 'react'
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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
          {!ddlLoading && !ddlError && (
            ddl
              ? <SqlCodeView code={ddl} connType={connType} className="table-peek__ddl-cm" />
              : <pre className="table-peek__ddl">（无 DDL）</pre>
          )}

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
              <div className="table-peek__data">
                <table className="table-peek__table">
                  <thead>
                    <tr>{dataResult.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {dataResult.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>
                            {cell === null
                              ? <span className="table-peek__null">NULL</span>
                              : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
