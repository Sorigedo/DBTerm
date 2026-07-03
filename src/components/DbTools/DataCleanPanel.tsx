// L2 — 数据清洗：去重 / 批量替换 / 空值填充，SQL 预览后执行
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Sparkles, Eye, Play, AlertTriangle } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import SearchableSelect from './SearchableSelect'
import { qid, tableRef as tableRefDialect, isMysqlFamily, isPgFamily, isSqlite as isSqliteType } from '../../utils/sqlDialect'
import type { ConnType } from '../../types'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  table: string
  columns: string[]   // may be empty if not yet loaded
  onClose: () => void
}

type Op = 'dedup' | 'replace' | 'fill-null'

interface SqlPreview {
  sql: string
  confirmed: boolean
}

function quote(s: string) { return `'${s.replace(/'/g, "''")}'` }

export default function DataCleanPanel({ connectionId, connType, schema, table, columns: propColumns, onClose }: Props) {
  const [columns, setColumns] = useState<string[]>(propColumns)
  const [op, setOp] = useState<Op>('dedup')

  useEffect(() => {
    if (propColumns.length > 0) { setColumns(propColumns); return }
    invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table })
      .then(cols => setColumns(cols.map(c => c.name)))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [selectedCol, setSelectedCol] = useState(columns[0] ?? '')
  const [findVal, setFindVal] = useState('')
  const [replaceVal, setReplaceVal] = useState('')
  const [fillVal, setFillVal] = useState('')
  const [preview, setPreview] = useState<SqlPreview | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const t = tableRefDialect(connType, schema, table)

  const buildSql = (): string => {
    const col = qid(connType, selectedCol)
    if (op === 'dedup') {
      if (isSqliteType(connType) || connType === 'duckdb') {
        return `-- 删除重复行（保留每组最小 rowid）\nDELETE FROM ${t}\nWHERE rowid NOT IN (\n  SELECT MIN(rowid) FROM ${t} GROUP BY ${col}\n);`
      }
      if (isPgFamily(connType)) {
        return `-- 删除重复行（保留每组 ctid 最小的行）\nDELETE FROM ${t} a\nUSING ${t} b\nWHERE a.${col} = b.${col}\n  AND a.ctid > b.ctid;`
      }
      // MySQL 系：需要知道主键列名，生成模板供用户修改
      return `-- MySQL 去重（将 \`id\` 替换为实际主键列名）\nDELETE FROM ${t}\nWHERE ${qid(connType, 'id')} NOT IN (\n  SELECT * FROM (\n    SELECT MIN(${qid(connType, 'id')}) FROM ${t} GROUP BY ${col}\n  ) AS _keep\n);`
    }
    if (op === 'replace') {
      if (!findVal) return '-- 请输入要查找的值'
      return `UPDATE ${t}\nSET ${col} = ${quote(replaceVal)}\nWHERE ${col} = ${quote(findVal)};`
    }
    if (op === 'fill-null') {
      // PG 区分 NULL 与空字符串；MySQL/SQLite 用 OR col='' 兼容两者
      const emptyCheck = isMysqlFamily(connType) || isSqliteType(connType) ? ` OR ${col} = ''` : ''
      return `UPDATE ${t}\nSET ${col} = ${quote(fillVal)}\nWHERE ${col} IS NULL${emptyCheck};`
    }
    return ''
  }

  const handlePreview = () => {
    const sql = buildSql()
    setPreview({ sql, confirmed: false })
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
        id: connectionId, sql: preview.sql,
      })
      setResult(`操作成功，影响 ${res.rowsAffected} 行`)
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
        style={{ width: 560, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Sparkles size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>数据清洗 — {table}</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 操作类型 */}
          <div style={{ display: 'flex', gap: 8 }}>
            {([['dedup', '去重'], ['replace', '批量替换'], ['fill-null', '空值填充']] as [Op, string][]).map(([o, label]) => (
              <button key={o} onClick={() => { setOp(o); setPreview(null); setResult('') }} style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)',
                background: op === o ? 'var(--accent)' : 'var(--surface-2)',
                color: op === o ? '#fff' : 'var(--text)', cursor: 'pointer',
              }}>{label}</button>
            ))}
          </div>

          {/* 列选择（所有操作都需要） */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', width: 60 }}>目标列</label>
            <SearchableSelect value={selectedCol} onChange={setSelectedCol} options={columns} />
          </div>

          {op === 'replace' && (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', width: 60 }}>查找值</label>
                <input value={findVal} onChange={e => setFindVal(e.target.value)}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', width: 60 }}>替换为</label>
                <input value={replaceVal} onChange={e => setReplaceVal(e.target.value)}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              </div>
            </>
          )}

          {op === 'fill-null' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', width: 60 }}>填充值</label>
              <input value={fillVal} onChange={e => setFillVal(e.target.value)}
                placeholder="NULL/空字符串将被替换为此值"
                style={{ flex: 1, padding: '6px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={handlePreview} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <Eye size={12} />预览 SQL
            </button>
          </div>

          {preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ padding: '8px 12px', background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.3)', borderRadius: 8, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={11} color="var(--warning)" />此操作将修改数据，执行后不可撤销（建议先备份）
              </div>
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>
                {preview.sql}
              </pre>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-danger" onClick={handleExecute} disabled={running} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <Play size={12} />{running ? '执行中...' : '确认执行'}
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
