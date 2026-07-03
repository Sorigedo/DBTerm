import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Table2, X, KeyRound } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { ConnType } from '../../types'

interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  key: string
  defaultValue: string | null
}

interface SqliteTableFlags {
  isStrict: boolean
  isWithoutRowid: boolean
}

interface Props {
  connectionId: string
  schema: string
  table: string
  connType?: ConnType
  onClose: () => void
}

export default function TableStructure({ connectionId, schema, table, connType, onClose }: Props) {
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [flags, setFlags]     = useState<SqliteTableFlags | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const isSqlite = connType === 'sqlite'

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setFlags(null)

    const colsPromise = invoke<ColumnInfo[]>('table_columns', { id: connectionId, schema, table })
    const flagsPromise = isSqlite
      ? invoke<SqliteTableFlags>('sqlite_table_flags', { id: connectionId, table }).catch(() => null)
      : Promise.resolve(null)

    Promise.all([colsPromise, flagsPromise])
      .then(([cols, f]) => {
        if (!alive) return
        setColumns(cols)
        if (f) setFlags(f)
      })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { if (alive) setLoading(false) })

    return () => { alive = false }
  }, [connectionId, schema, table, isSqlite])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal-overlay">
      <div className="modal-box tbl-struct-box">
        <div className="modal-header">
          <span className="modal-title">
            <Table2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            {schema !== 'main' ? `${schema}.` : ''}{table} 表结构
            {flags && (flags.isStrict || flags.isWithoutRowid) && (
              <span style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
                {flags.isStrict && (
                  <span className="tbl-struct-flag tbl-struct-flag--strict">STRICT</span>
                )}
                {flags.isWithoutRowid && (
                  <span className="tbl-struct-flag tbl-struct-flag--norowid">WITHOUT ROWID</span>
                )}
              </span>
            )}
          </span>
          <button className="modal-close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          {loading && (
            <div className="result-placeholder" style={{ padding: 40 }}>
              <Loader2 size={16} className="spin" /> <span>加载中…</span>
            </div>
          )}
          {error && <div className="result-error" style={{ margin: 16 }}>{error}</div>}
          {!loading && !error && (
            <table className="result-table tbl-struct-table">
              <thead>
                <tr>
                  <th className="result-th">列名</th>
                  <th className="result-th">类型</th>
                  <th className="result-th">可空</th>
                  <th className="result-th">键</th>
                  <th className="result-th">默认值</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.name} className="result-tr">
                    <td className="result-td tbl-struct-name">
                      {c.key === 'PRI' && <KeyRound size={11} className="tbl-struct-pk" />}
                      {c.name}
                    </td>
                    <td className="result-td">{c.dataType}</td>
                    <td className="result-td">{c.nullable ? '是' : '否'}</td>
                    <td className="result-td">
                      {c.key === 'PRI' ? 'PRI'
                        : c.key === 'VIRT' ? <span style={{ color: 'var(--accent)', fontSize: 10 }}>虚拟</span>
                        : c.key === 'GEN'  ? <span style={{ color: 'var(--success)', fontSize: 10 }}>存储</span>
                        : c.key || '—'
                      }
                    </td>
                    <td className={`result-td${c.defaultValue === null ? ' result-td--null' : ''}`}>
                      {c.defaultValue ?? 'NULL'}
                    </td>
                  </tr>
                ))}
                {columns.length === 0 && (
                  <tr><td className="result-td" colSpan={5}>无列信息</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
