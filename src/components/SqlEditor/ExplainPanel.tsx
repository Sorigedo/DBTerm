import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Zap, AlertTriangle, ChevronRight } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  sqlText: string
  onClose: () => void
}

interface ExplainRow {
  id: string | null
  selectType: string | null
  table: string | null
  partitions: string | null
  accessType: string | null
  possibleKeys: string | null
  key: string | null
  keyLen: string | null
  ref: string | null
  rows: string | null
  filtered: string | null
  extra: string | null
  isDanger: boolean
}

// ── PG JSON 执行计划树 ─────────────────────────────────────────────────────────

interface PgPlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Schema'?: string
  'Alias'?: string
  'Join Type'?: string
  'Parallel Aware'?: boolean
  'Startup Cost': number
  'Total Cost': number
  'Plan Rows': number
  'Plan Width': number
  'Actual Startup Time'?: number
  'Actual Total Time'?: number
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Shared Hit Blocks'?: number
  'Shared Read Blocks'?: number
  'Shared Dirtied Blocks'?: number
  'Shared Written Blocks'?: number
  'Temp Read Blocks'?: number
  'Temp Written Blocks'?: number
  'I/O Read Time'?: number
  'I/O Write Time'?: number
  'Filter'?: string
  'Join Filter'?: string
  'Hash Cond'?: string
  'Merge Cond'?: string
  'Recheck Cond'?: string
  'Plans'?: PgPlanNode[]
}

interface PgJsonPlan {
  Plan: PgPlanNode
  'Planning Time'?: number
  'Execution Time'?: number
}

function fmtMs(ms: number) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(2)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function nodeTypeColor(type: string): string {
  if (type.includes('Seq Scan'))       return '#ea580c'
  if (type.includes('Index Only'))     return '#16a34a'
  if (type.includes('Index Scan'))     return '#22c55e'
  if (type.includes('Bitmap Heap'))    return '#84cc16'
  if (type.includes('Nested Loop'))    return 'var(--accent)'
  if (type.includes('Hash Join'))      return '#38bdf8'
  if (type.includes('Merge Join'))     return '#818cf8'
  if (type.includes('Hash'))           return '#94a3b8'
  if (type.includes('Sort'))           return '#f59e0b'
  if (type.includes('Aggregate'))      return '#c084fc'
  if (type.includes('Gather'))         return '#fb7185'
  return 'var(--text)'
}

function PgPlanNodeRow({ node, depth, isAnalyze }: { node: PgPlanNode; depth: number; isAnalyze: boolean }) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = (node.Plans?.length ?? 0) > 0

  const estimatedRows = node['Plan Rows']
  const actualRows    = node['Actual Rows'] ?? null
  const rowMismatch   = actualRows !== null && estimatedRows > 0 && (actualRows / estimatedRows > 10 || estimatedRows / (actualRows || 1) > 10)
  const sharedHit     = node['Shared Hit Blocks'] ?? 0
  const sharedRead    = node['Shared Read Blocks'] ?? 0
  const cacheRatio    = (sharedHit + sharedRead) > 0 ? sharedHit / (sharedHit + sharedRead) : null

  const label = [
    node['Node Type'],
    node['Relation Name'] ? `on ${node.Schema ? node.Schema + '.' : ''}${node['Relation Name']}${node.Alias && node.Alias !== node['Relation Name'] ? ` ${node.Alias}` : ''}` : null,
    node['Index Name'] ? `using ${node['Index Name']}` : null,
    node['Join Type'] ? `(${node['Join Type']})` : null,
  ].filter(Boolean).join(' ')

  const cond = node['Hash Cond'] ?? node['Merge Cond'] ?? node['Join Filter'] ?? node['Filter'] ?? node['Recheck Cond'] ?? null

  return (
    <div style={{ paddingLeft: depth * 20 }}>
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 0', cursor: hasChildren ? 'pointer' : 'default' }}
        onClick={() => hasChildren && setExpanded(e => !e)}
      >
        {hasChildren ? (
          <ChevronRight size={10} style={{ flexShrink: 0, transform: expanded ? 'rotate(90deg)' : '', transition: 'transform 0.1s', color: 'var(--text-muted)', marginTop: 1 }} />
        ) : <span style={{ width: 10, flexShrink: 0 }} />}

        <span style={{ fontWeight: 700, color: nodeTypeColor(node['Node Type']), fontSize: 12 }}>{label}</span>

        {rowMismatch && <span title={`行数估算偏差：估算 ${estimatedRows} vs 实际 ${actualRows}`}><AlertTriangle size={11} color="var(--error)" /></span>}

        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
          cost={node['Startup Cost'].toFixed(2)}..{node['Total Cost'].toFixed(2)}
          {' '}rows={estimatedRows}
          {isAnalyze && node['Actual Total Time'] != null && ` actual=${fmtMs(node['Actual Total Time']! * (node['Actual Loops'] ?? 1))} rows=${node['Actual Rows']}`}
        </span>

        {isAnalyze && cacheRatio !== null && (
          <span style={{ fontSize: 10, color: cacheRatio < 0.5 ? '#dc2626' : cacheRatio < 0.9 ? '#ea580c' : '#16a34a', fontWeight: 600, marginLeft: 4 }}>
            cache={Math.round(cacheRatio * 100)}%
          </span>
        )}
      </div>

      {cond && (
        <div style={{ paddingLeft: (depth * 20) + 16, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', paddingBottom: 2 }}>
          {cond}
        </div>
      )}

      {expanded && node.Plans?.map((child, i) => (
        <PgPlanNodeRow key={i} node={child} depth={depth + 1} isAnalyze={isAnalyze} />
      ))}
    </div>
  )
}

export default function ExplainPanel({ connectionId, connType, sqlText, onClose }: Props) {
  const [rows, setRows] = useState<ExplainRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [analyzeJson, setAnalyzeJson] = useState<string>('')
  const [analyzeMode, setAnalyzeMode] = useState(false)
  const [pgJsonPlan, setPgJsonPlan] = useState<PgJsonPlan | null>(null)
  const [pgAnalyzeMode, setPgAnalyzeMode] = useState(false)
  const [baseline, setBaseline] = useState<PgJsonPlan | null>(null)  // EXPLAIN 对比基准
  const isPg     = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isSqlite = connType === 'sqlite'
  const isMaria  = connType === 'mariadb'

  const run = useCallback(async () => {
    if (!sqlText.trim()) return
    setLoading(true)
    setError('')
    setAnalyzeJson('')
    setPgJsonPlan(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (isPg && pgAnalyzeMode) {
        type QResult = { columns: string[]; rows: (string | null)[][] }
        const res = await invoke<QResult>('execute_query', {
          id: connectionId,
          sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sqlText.trim()}`,
        })
        const raw = res.rows?.[0]?.[0] ?? '[]'
        try {
          const arr = JSON.parse(raw)
          setPgJsonPlan(Array.isArray(arr) ? arr[0] : arr)
        } catch { setError('执行计划 JSON 解析失败') }
        setRows([])
      } else if (isMaria && analyzeMode) {
        // MariaDB ANALYZE FORMAT=JSON：执行实际查询并返回真实行数 vs 估算行数
        type QResult = { columns: string[]; rows: (string | null)[][] }
        const res = await invoke<QResult>('execute_query', {
          id: connectionId,
          sql: `ANALYZE FORMAT=JSON ${sqlText.trim()}`,
        })
        // 结果是单列单行，内容是 JSON 文本
        const jsonText = res.rows?.[0]?.[0] ?? ''
        setAnalyzeJson(jsonText)
        setRows([])
      } else {
        const result = await invoke<ExplainRow[]>('db_explain', { id: connectionId, sqlText })
        setRows(result)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [connectionId, sqlText, isMaria, analyzeMode, isPg, pgAnalyzeMode])

  useEffect(() => { run() }, [run])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const dangerCount = rows.filter(r => r.isDanger).length

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: (isPg && baseline && pgJsonPlan) ? 1100 : (isPg || isSqlite) ? 720 : 1000, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Zap size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>EXPLAIN 执行计划</span>
          {dangerCount > 0 && !analyzeMode && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--warning)', background: 'rgba(234,88,12,0.1)', borderRadius: 5, padding: '2px 8px' }}>
              <AlertTriangle size={11} /> {dangerCount} 处需优化
            </span>
          )}
          {isMaria && (
            <button
              onClick={() => setAnalyzeMode(m => !m)}
              style={{
                marginLeft: 8, padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)',
                background: analyzeMode ? 'var(--accent)' : 'var(--surface-2)',
                color: analyzeMode ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
              title="MariaDB 专属：执行真实查询并返回实际行数 vs 估算行数对比（ANALYZE FORMAT=JSON）"
            >
              ANALYZE JSON
            </button>
          )}
          {isPg && (
            <button
              onClick={() => setPgAnalyzeMode(m => !m)}
              style={{
                marginLeft: 8, padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)',
                background: pgAnalyzeMode ? 'var(--accent)' : 'var(--surface-2)',
                color: pgAnalyzeMode ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
              title="EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)：执行实际查询，返回真实耗时与缓存命中率树形图"
            >
              ANALYZE + BUFFERS
            </button>
          )}
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        {/* SQL preview */}
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)',
          maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre',
        }}>
          {sqlText.slice(0, 300)}{sqlText.length > 300 ? '…' : ''}
        </div>

        {error && (
          <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', flexShrink: 0 }}>{error}</div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {isMaria && analyzeMode ? '执行 ANALYZE FORMAT=JSON 中（会实际运行查询）…' : '执行 EXPLAIN 中…'}
            </div>
          ) : isMaria && analyzeMode ? (
            /* MariaDB ANALYZE FORMAT=JSON 结果 */
            analyzeJson ? (
              <pre style={{ padding: 16, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7, color: 'var(--text)', overflowX: 'auto', margin: 0 }}>
                {(() => { try { return JSON.stringify(JSON.parse(analyzeJson), null, 2) } catch { return analyzeJson } })()}
              </pre>
            ) : <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无结果</div>
          ) : rows.length === 0 && !error ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无结果</div>
          ) : isSqlite ? (
            /* SQLite EXPLAIN QUERY PLAN: tree-like text output */
            <div style={{ padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8 }}>
              {rows.map((r, i) => {
                const depth = r.selectType ? parseInt(r.selectType, 10) : 0
                const detail = r.extra ?? ''
                const isScan   = detail.includes('SCAN') && !detail.includes('USING')
                const isAuto   = detail.includes('AUTO INDEX')
                const isSearch = detail.includes('SEARCH') && detail.includes('USING')
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingLeft: Math.max(0, (depth > 0 ? 20 : 0)) }}>
                    {isScan || isAuto ? (
                      <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 3, color: 'var(--warning)' }} />
                    ) : <span style={{ width: 11, flexShrink: 0 }} />}
                    <span style={{
                      color: isScan ? '#dc2626' : isAuto ? '#ea580c' : isSearch ? '#16a34a' : 'var(--text)',
                      fontWeight: (isScan || isAuto) ? 600 : undefined,
                      whiteSpace: 'pre-wrap',
                    }}>
                      {depth > 0 && <span style={{ color: 'var(--text-muted)' }}>{'  '.repeat(1)}</span>}
                      {r.id && <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{r.id}</span>}
                      {detail}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : isPg && pgJsonPlan ? (
            /* PG JSON ANALYZE tree（支持存为基准 + 两次计划对比） */
            <div style={{ padding: '12px 16px' }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12, color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
                {pgJsonPlan['Planning Time'] != null && (
                  <span>规划耗时: <strong style={{ color: 'var(--text)' }}>{fmtMs(pgJsonPlan['Planning Time'])}</strong></span>
                )}
                {pgJsonPlan['Execution Time'] != null && (
                  <span>执行耗时: <strong style={{ color: pgJsonPlan['Execution Time'] > 1000 ? '#dc2626' : 'var(--text)' }}>{fmtMs(pgJsonPlan['Execution Time'])}</strong></span>
                )}
                {baseline?.['Execution Time'] != null && pgJsonPlan['Execution Time'] != null && (() => {
                  const delta = (pgJsonPlan['Execution Time'] as number) - (baseline['Execution Time'] as number)
                  const base = baseline['Execution Time'] as number
                  const pct = base > 0 ? (delta / base * 100) : 0
                  const worse = delta > 0.0001
                  const better = delta < -0.0001
                  return (
                    <span style={{ color: worse ? '#dc2626' : better ? '#16a34a' : 'var(--text-muted)', fontWeight: 600 }}>
                      vs 基准: {worse ? '+' : ''}{fmtMs(delta)}（{worse ? '+' : ''}{pct.toFixed(1)}%）
                    </span>
                  )
                })()}
                <button onClick={() => setBaseline(pgJsonPlan)}
                  style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}
                  title="把当前计划存为对比基准，修改 SQL/索引后重新执行即可看到差异">
                  存为基准
                </button>
                {baseline && (
                  <button onClick={() => setBaseline(null)}
                    style={{ padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    清除基准
                  </button>
                )}
              </div>
              {baseline ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>
                      基准{baseline['Execution Time'] != null ? `（${fmtMs(baseline['Execution Time'] as number)}）` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)' }}>
                      <PgPlanNodeRow node={baseline.Plan} depth={0} isAnalyze={true} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 6, fontWeight: 600 }}>
                      当前{pgJsonPlan['Execution Time'] != null ? `（${fmtMs(pgJsonPlan['Execution Time'] as number)}）` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)' }}>
                      <PgPlanNodeRow node={pgJsonPlan.Plan} depth={0} isAnalyze={true} />
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ fontFamily: 'var(--font-mono)' }}>
                  <PgPlanNodeRow node={pgJsonPlan.Plan} depth={0} isAnalyze={true} />
                </div>
              )}
            </div>
          ) : isPg ? (
            /* PG: text lines */
            <div style={{ padding: 16, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7 }}>
              {rows.map((r, i) => (
                <div
                  key={i}
                  style={{
                    color: r.isDanger ? '#ea580c' : 'var(--text)',
                    fontWeight: r.isDanger ? 600 : undefined,
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                  }}
                >
                  {r.isDanger && <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 3, color: 'var(--warning)' }} />}
                  <span style={{ whiteSpace: 'pre-wrap' }}>{r.extra}</span>
                </div>
              ))}
            </div>
          ) : (
            /* MySQL: structured table */
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  {['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra'].map(h => (
                    <th key={h} style={{ padding: '7px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 11 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      background: r.isDanger ? 'rgba(234,88,12,0.05)' : undefined,
                    }}
                  >
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.id ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--accent)', fontSize: 11 }}>{r.selectType ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-bright)', fontWeight: 500 }}>{r.table ?? '—'}</td>
                    <td style={{
                      padding: '6px 8px', fontWeight: 600, fontSize: 11,
                      color: (r.accessType === 'ALL') ? '#dc2626' : (r.accessType === 'index') ? '#ea580c' : '#16a34a',
                    }}>
                      {r.isDanger && r.accessType && <AlertTriangle size={10} style={{ marginRight: 3, display: 'inline' }} />}
                      {r.accessType ?? '—'}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.possibleKeys ?? ''}>{r.possibleKeys ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: r.key ? '#16a34a' : 'var(--text-muted)', fontWeight: r.key ? 600 : undefined, fontSize: 11 }}>{r.key ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.keyLen ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: 11 }}>{r.ref ?? '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{r.rows ?? '—'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.filtered ?? '—'}</td>
                    <td style={{
                      padding: '6px 8px', fontSize: 11, maxWidth: 200,
                      color: r.extra?.includes('filesort') || r.extra?.includes('temporary') ? '#ea580c' : 'var(--text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={r.extra ?? ''}>
                      {r.extra ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 优化说明 */}
        {dangerCount > 0 && (
          <div style={{
            padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0,
            fontSize: 11, color: 'var(--text-muted)', background: 'rgba(234,88,12,0.04)',
          }}>
            <span style={{ color: 'var(--warning)', fontWeight: 600 }}>优化建议：</span>
            {isSqlite
              ? ' SCAN 表示全表扫描，需添加合适索引；AUTO INDEX 是 SQLite 自动建临时索引，考虑手动建永久索引'
              : ' type=ALL（全表扫描）需添加索引；type=index（全索引扫描）考虑复合索引；Extra含"filesort"/"temporary"考虑增加合适索引或调整 ORDER BY/GROUP BY'
            }
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
