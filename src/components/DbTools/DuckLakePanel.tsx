import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Layers, Loader2, Play } from 'lucide-react'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  onClose: () => void
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
  rowsAffected: number
  executionTimeMs: number
}

// 数据湖格式 → DuckDB 扩展名 + scan 函数
const FORMATS = [
  { value: 'iceberg', label: 'Apache Iceberg', ext: 'iceberg', scan: 'iceberg_scan' },
  { value: 'delta',   label: 'Delta Lake',     ext: 'delta',   scan: 'delta_scan' },
]

export default function DuckLakePanel({ connectionId, onClose }: Props) {
  const [format, setFormat] = useState('iceberg')
  const [path, setPath] = useState('')
  const [topN, setTopN] = useState(100)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [usedSql, setUsedSql] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    const fmt = FORMATS.find(f => f.value === format)!
    const p = path.trim()
    if (!p) { setError('请输入数据湖路径（本地路径或 s3:// 等 URI）'); return }
    setLoading(true); setError(''); setResult(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // 1. 安装 + 加载扩展（已安装则快速返回）
      setStage(`安装 ${fmt.ext} 扩展…`)
      try { await invoke('duckdb_install_ext', { id: connectionId, extName: fmt.ext }) } catch (e) {
        throw new Error(`安装扩展失败：${e}`)
      }
      setStage(`加载 ${fmt.ext} 扩展…`)
      await invoke('duckdb_load_ext', { id: connectionId, extName: fmt.ext })
      // 2. 执行 scan 查询（path 单引号转义防注入）
      setStage('读取数据…')
      const esc = p.replace(/'/g, "''")
      const k = Math.max(1, Math.min(10000, topN || 100))
      const sql = `SELECT * FROM ${fmt.scan}('${esc}') LIMIT ${k}`
      setUsedSql(sql)
      const res = await invoke<QueryResult>('duckdb_query', { id: connectionId, sql, limit: k })
      setResult(res)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setLoading(false); setStage('')
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 880, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Layers size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>数据湖查询（Iceberg / Delta Lake）</span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* 配置区 */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 48 }}>格式</span>
            <SearchableSelect width={180} mono={false}
              value={format} onChange={v => { setFormat(v); setResult(null) }}
              items={FORMATS.map(f => ({ value: f.value, label: f.label }))} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>Limit</span>
            <input type="number" min={1} max={10000} value={topN} onChange={e => setTopN(Number(e.target.value) || 100)}
              style={{ width: 80, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 48 }}>路径</span>
            <input value={path} onChange={e => setPath(e.target.value)}
              placeholder="本地表目录 或 s3://bucket/path/to/table"
              style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <button onClick={run} disabled={loading}
              style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {loading ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 加载并预览
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            S3/远程路径需先在 DuckDB 配置凭证（DbTools → DuckDB Secrets）。首次加载扩展会联网下载。
          </div>
        </div>

        {/* 结果区 */}
        <div style={{ flex: 1, overflow: 'auto', padding: error ? 16 : 0 }}>
          {error ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{stage || '处理中…'}</div>
          ) : result ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  {result.columns.map((c, i) => (
                    <th key={i} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, ri) => (
                  <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={cell ?? 'NULL'}>
                        {cell === null ? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>NULL</span> : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>填入数据湖表路径后点击「加载并预览」</div>
          )}
        </div>

        {result && usedSql && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={usedSql}>
            {result.rows.length} 行 · {result.executionTimeMs}ms · {usedSql}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
