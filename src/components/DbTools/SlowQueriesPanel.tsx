import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Clock, RefreshCw, ChevronDown, ChevronUp, Copy, RotateCcw } from 'lucide-react'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

interface SlowQueryEntry {
  query: string
  execCount: number
  totalTimeMs: number
  avgTimeMs: number
  maxTimeMs: number
  rowsSent: number
  rowsExamined: number
  // PG5.2
  sharedBlksHit?: number | null
  sharedBlksRead?: number | null
}

type SortKey = 'totalTimeMs' | 'avgTimeMs' | 'execCount' | 'maxTimeMs'

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

function hitRateColor(pct: number) {
  if (pct >= 0.95) return '#16a34a'
  if (pct >= 0.8) return '#ea580c'
  return '#dc2626'
}

export default function SlowQueriesPanel({ connectionId, connType, onClose }: Props) {
  const [data, setData] = useState<SlowQueryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [limit, setLimit] = useState(50)
  const [sortKey, setSortKey] = useState<SortKey>('totalTimeMs')
  const [sortAsc, setSortAsc] = useState(false)
  const [expand, setExpand] = useState<number | null>(null)
  const [copied, setCopied] = useState(-1)
  const [resetting, setResetting] = useState(false)

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<SlowQueryEntry[]>('db_slow_queries', { id: connectionId, limit })
      setData(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const resetStats = async () => {
    if (!window.confirm('确认重置 pg_stat_statements 统计？\n\n所有历史查询统计将被清空，此操作不可逆。')) return
    setResetting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql: 'SELECT pg_stat_statements_reset()' })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setResetting(false)
    }
  }

  useEffect(() => { load() }, [limit])
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
    const cmp = (a[sortKey] as number) - (b[sortKey] as number)
    return sortAsc ? cmp : -cmp
  })

  const copy = (idx: number, sql: string) => {
    navigator.clipboard.writeText(sql)
    setCopied(idx)
    setTimeout(() => setCopied(-1), 1500)
  }

  function Th({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sortKey === k
    return (
      <th
        onClick={() => toggleSort(k)}
        style={{
          padding: '7px 10px', cursor: 'pointer', userSelect: 'none', textAlign: 'right',
          fontWeight: 600, color: active ? 'var(--accent)' : 'var(--text-muted)',
          borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 11,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
          {children}
          {active && (sortAsc ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
        </span>
      </th>
    )
  }

  const colSpanTotal = isPg ? 6 : 6

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 960, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Clock size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>慢查询</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>
            {isPg ? '来源: pg_stat_statements' : '来源: performance_schema'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {isPg && (
              <button
                onClick={resetStats}
                disabled={resetting}
                title="重置 pg_stat_statements（强确认）"
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--warning)', padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(234,88,12,0.4)', background: 'rgba(234,88,12,0.06)' }}
              >
                <RotateCcw size={11} />重置统计
              </button>
            )}
            <SearchableSelect
              value={String(limit)}
              onChange={v => setLimit(Number(v))}
              items={[20, 50, 100, 200].map(n => ({ value: String(n), label: `TOP ${n}` }))}
              mono={false}
              width={110}
            />
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'rgba(220,38,38,0.08)', flexShrink: 0 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          ) : data.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              无数据（performance_schema / pg_stat_statements 可能未启用）
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>SQL</th>
                  <Th k="execCount">调用次数</Th>
                  <Th k="totalTimeMs">总耗时</Th>
                  <Th k="avgTimeMs">均值</Th>
                  <Th k="maxTimeMs">最大</Th>
                  {isPg
                    ? <th style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11, whiteSpace: 'nowrap' }}>缓存命中率</th>
                    : <th style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>扫描行</th>
                  }
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const hit = row.sharedBlksHit ?? 0
                  const read = row.sharedBlksRead ?? 0
                  const total = hit + read
                  const hitPct = total > 0 ? hit / total : null
                  return (
                    <>
                      <tr
                        key={i}
                        onClick={() => setExpand(expand === i ? null : i)}
                        style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: expand === i ? 'var(--surface-2)' : undefined }}
                      >
                        <td style={{ padding: '7px 10px', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
                          <span style={{ marginRight: 6, color: 'var(--text-muted)' }}>
                            {expand === i ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                          </span>
                          {row.query}
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{row.execCount.toLocaleString()}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: row.totalTimeMs > 10000 ? '#dc2626' : 'var(--text)', fontWeight: row.totalTimeMs > 10000 ? 600 : undefined }}>{fmtMs(row.totalTimeMs)}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: row.avgTimeMs > 1000 ? '#ea580c' : 'var(--text)' }}>{fmtMs(row.avgTimeMs)}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{fmtMs(row.maxTimeMs)}</td>
                        {isPg
                          ? <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                              {hitPct !== null
                                ? <span style={{ color: hitRateColor(hitPct), fontWeight: hitPct < 0.8 ? 700 : 400 }}>{(hitPct * 100).toFixed(1)}%</span>
                                : <span style={{ color: 'var(--text-muted)' }}>—</span>
                              }
                            </td>
                          : <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{row.rowsExamined.toLocaleString()}</td>
                        }
                      </tr>
                      {expand === i && (
                        <tr key={`exp-${i}`} style={{ background: 'var(--surface-2)' }}>
                          <td colSpan={colSpanTotal} style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              {isPg && hitPct !== null && (
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  Shared Hit: <span style={{ fontFamily: 'var(--font-mono)', color: hitRateColor(hitPct) }}>{hit.toLocaleString()}</span>
                                  {' / '}
                                  Read: <span style={{ fontFamily: 'var(--font-mono)' }}>{read.toLocaleString()}</span>
                                </div>
                              )}
                              <button onClick={() => copy(i, row.query)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: copied === i ? '#16a34a' : 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', marginLeft: 'auto' }}>
                                <Copy size={11} /> {copied === i ? '已复制' : '复制'}
                              </button>
                            </div>
                            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--bg)', borderRadius: 6, padding: '8px 12px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
                              {row.query}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
