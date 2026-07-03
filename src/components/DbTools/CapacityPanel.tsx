import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, BarChart2, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react'

interface Props {
  connectionId: string
  schema: string
  onClose: () => void
}

interface TableSizeEntry {
  tableName: string
  tableRows: number
  dataBytes: number
  indexBytes: number
  totalBytes: number
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type SortKey = 'tableName' | 'tableRows' | 'dataBytes' | 'indexBytes' | 'totalBytes'

export default function CapacityPanel({ connectionId, schema, onClose }: Props) {
  const [data, setData] = useState<TableSizeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('totalBytes')
  const [sortAsc, setSortAsc] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<TableSizeEntry[]>('db_table_sizes', { id: connectionId, schema })
      setData(list)
      setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(v => !v)
    else { setSortKey(key); setSortAsc(false) }
  }

  const sorted = [...data].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey]
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return sortAsc ? cmp : -cmp
  })

  const maxTotal = data.reduce((m, e) => Math.max(m, e.totalBytes), 0)
  const totalSize = data.reduce((s, e) => s + e.totalBytes, 0)
  const totalRows = data.reduce((s, e) => s + e.tableRows, 0)

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return null
    return sortAsc ? <ChevronUp size={11} /> : <ChevronDown size={11} />
  }

  function Th({ k, children }: { k: SortKey; children: React.ReactNode }) {
    return (
      <th
        onClick={() => toggleSort(k)}
        style={{
          padding: '8px 10px', textAlign: 'left', cursor: 'pointer', userSelect: 'none',
          fontWeight: 600, color: sortKey === k ? 'var(--accent)' : 'var(--text-muted)',
          borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 12,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {children} <SortIcon k={k} />
        </span>
      </th>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BarChart2 size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>容量统计</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{schema}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* 汇总卡片 */}
        {!loading && data.length > 0 && (
          <div style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {[
              { label: '表总数', value: data.length.toString() },
              { label: '总行数（估算）', value: totalRows.toLocaleString() },
              { label: '总占用', value: fmtBytes(totalSize) },
            ].map(c => (
              <div key={c.label} style={{
                flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 14px',
              }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-bright)' }}>{c.value}</div>
              </div>
            ))}
          </div>
        )}

        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : data.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>此 Schema 下无表</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <Th k="tableName">表名</Th>
                  <Th k="tableRows">行数（估算）</Th>
                  <Th k="dataBytes">数据大小</Th>
                  <Th k="indexBytes">索引大小</Th>
                  <Th k="totalBytes">总大小</Th>
                  <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(row => (
                  <tr key={row.tableName} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '7px 10px', color: 'var(--text-bright)', fontWeight: 500 }}>{row.tableName}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{row.tableRows.toLocaleString()}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{fmtBytes(row.dataBytes)}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{fmtBytes(row.indexBytes)}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text)', fontWeight: 500 }}>{fmtBytes(row.totalBytes)}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{
                          width: `${maxTotal > 0 ? Math.round(row.totalBytes / maxTotal * 100) : 0}%`,
                          height: '100%', background: 'var(--accent)', borderRadius: 3,
                        }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
