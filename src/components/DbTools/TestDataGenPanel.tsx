// L1 — 测试数据生成（按列类型规则批量生成，SQL 预览后插入）
import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Zap, Eye, Play, AlertTriangle } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface ColInfo { name: string; type: string; nullable: boolean; defaultVal?: string }

import { qid, tableRef as tableRefDialect } from '../../utils/sqlDialect'
import type { ConnType } from '../../types'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  table: string
  columns: ColInfo[]
  onClose: () => void
}

function quote(s: string) { return `'${s.replace(/'/g, "''")}'` }

// Simple deterministic fake data generators
const NAMES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fiona', 'George', 'Hannah', 'Ivan', 'Julia']
const EMAILS = (n: string) => `${n.toLowerCase()}@example.com`
const DOMAINS = ['example.com', 'test.org', 'demo.net', 'sample.io']

function genValue(col: ColInfo, idx: number): string {
  const t = col.type.toLowerCase()
  const n = col.name.toLowerCase()

  if (t.includes('int') || t === 'bigint' || t === 'smallint' || t === 'tinyint') {
    if (n.includes('age')) return String(18 + (idx % 60))
    if (n.includes('status') || n.includes('enabled') || n.includes('active')) return String(idx % 2)
    return String(idx + 1)
  }
  if (t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('numeric')) {
    return ((idx + 1) * 10.5).toFixed(2)
  }
  if (t.includes('bool')) {
    return idx % 2 === 0 ? 'true' : 'false'
  }
  if (t.includes('date') && !t.includes('time')) {
    const d = new Date(2024, 0, 1 + idx)
    return quote(d.toISOString().slice(0, 10))
  }
  if (t.includes('datetime') || t.includes('timestamp')) {
    const d = new Date(2024, 0, 1 + idx, 10, 30, 0)
    return quote(d.toISOString().slice(0, 19).replace('T', ' '))
  }
  if (t.includes('text') || t.includes('longtext')) {
    return quote(`这是第 ${idx + 1} 条测试数据`)
  }
  // varchar / char
  if (n.includes('email')) return quote(EMAILS(NAMES[idx % NAMES.length]))
  if (n.includes('name')) return quote(NAMES[idx % NAMES.length] + (idx >= NAMES.length ? `_${Math.floor(idx / NAMES.length)}` : ''))
  if (n.includes('phone') || n.includes('tel')) return quote(`1${3 + idx % 7}${String(idx).padStart(9, '0')}`)
  if (n.includes('url') || n.includes('website')) return quote(`https://${DOMAINS[idx % DOMAINS.length]}/page${idx}`)
  if (n.includes('ip')) return quote(`192.168.${Math.floor(idx / 256) % 256}.${idx % 256}`)
  if (n.includes('uuid') || n.includes('guid')) return quote(`00000000-0000-0000-0000-${String(idx).padStart(12, '0')}`)
  return quote(`value_${idx + 1}`)
}

export default function TestDataGenPanel({ connectionId, connType, schema, table, columns: propColumns, onClose }: Props) {
  const [columns, setColumns] = useState<ColInfo[]>(propColumns)
  const [rowCount, setRowCount] = useState(10)
  const [preview, setPreview] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (propColumns.length > 0) { setColumns(propColumns); return }
    invoke<{ name: string; dataType: string; nullable: boolean }[]>('table_columns', { id: connectionId, schema, table })
      .then(cols => setColumns(cols.map(c => ({ name: c.name, type: c.dataType, nullable: c.nullable }))))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Skip auto-increment / generated columns (INT PK typically)
  const insertCols = useMemo(() =>
    columns.filter(c => !(c.type.toLowerCase().includes('int') && c.name.toLowerCase() === 'id')),
    [columns]
  )

  const buildSql = (): string => {
    const t = tableRefDialect(connType, schema, table)
    const colList = insertCols.map(c => qid(connType, c.name)).join(', ')
    const rows: string[] = []
    for (let i = 0; i < rowCount; i++) {
      const vals = insertCols.map(c => genValue(c, i)).join(', ')
      rows.push(`(${vals})`)
    }
    return `INSERT INTO ${t} (${colList})\nVALUES\n  ${rows.join(',\n  ')};`
  }

  const handlePreview = () => {
    setPreview(buildSql())
    setResult('')
    setError('')
  }

  const handleExecute = async () => {
    if (!preview) return
    setRunning(true)
    setError('')
    setResult('')
    try {
      const res = await invoke<{ rowsAffected: number }>('execute_query', {
        id: connectionId, sql: preview,
      })
      setResult(`插入成功，影响 ${res.rowsAffected} 行`)
      setPreview(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 600, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Zap size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>测试数据生成 — {table}</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>生成行数：</label>
            <input type="number" min={1} max={1000} value={rowCount} onChange={e => setRowCount(Math.max(1, Math.min(1000, Number(e.target.value))))}
              style={{ width: 80, padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>（最多 1000 行）</span>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            将自动跳过 id（自增），对 email/name/phone/url 等列按语义生成，其余按类型生成默认值。
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {insertCols.map(c => (
              <span key={c.name} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                {c.name}: <span style={{ color: 'var(--accent)' }}>{c.type}</span>
              </span>
            ))}
          </div>

          <button className="btn-primary" onClick={handlePreview} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, width: 'fit-content' }}>
            <Eye size={12} />预览 SQL（{rowCount} 行）
          </button>

          {preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ padding: '8px 12px', background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.3)', borderRadius: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={11} color="var(--warning)" />以下 SQL 将插入 {rowCount} 行数据到 {table}
              </div>
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 240, overflow: 'auto' }}>
                {preview}
              </pre>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" onClick={handleExecute} disabled={running} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <Play size={12} />{running ? '插入中...' : '确认插入'}
                </button>
                <button className="btn-cancel" onClick={() => setPreview(null)} style={{ fontSize: 12 }}>取消</button>
              </div>
            </div>
          )}

          {result && <div style={{ padding: 10, background: 'rgba(22,163,74,0.1)', borderRadius: 8, fontSize: 12, color: 'var(--success)' }}>{result}</div>}
          {error && <div style={{ padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, fontSize: 12, color: 'var(--error)' }}>{error}</div>}
        </div>
      </div>
    </div>,
    document.body
  )
}
