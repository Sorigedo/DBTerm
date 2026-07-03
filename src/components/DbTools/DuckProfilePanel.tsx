// DD4.1 DuckDB 查询 Profiling 火焰树面板
import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, AlertCircle, Activity, ChevronRight, ChevronDown } from 'lucide-react'

interface Props { connectionId: string }

interface ProfileNode {
  name: string
  timing: number       // 秒
  result?: number      // 行数
  children?: ProfileNode[]
  // 运行时计算
  pct?: number
  depth?: number
}

// 颜色梯度：0%~30% 绿，30%~60% 黄，60%~100% 红
function timingColor(pct: number): string {
  if (pct >= 60) return '#dc2626'
  if (pct >= 30) return '#ea580c'
  if (pct >= 10) return '#ca8a04'
  return '#16a34a'
}

function parseProfileJson(json: unknown): { total: number; nodes: ProfileNode[] } {
  if (!json || typeof json !== 'object') return { total: 0, nodes: [] }
  const root = json as Record<string, unknown>
  const total = (root['timing'] as number) ?? (root['result'] as number) ?? 0

  function flatten(node: Record<string, unknown>, depth: number): ProfileNode[] {
    const name = String(node['name'] ?? '?')
    const timing = (node['timing'] as number) ?? 0
    const rows = node['cardinality'] as number | undefined
    const pct = total > 0 ? (timing / total) * 100 : 0
    const cur: ProfileNode = { name, timing, result: rows, pct, depth }
    const children = (node['children'] as Record<string, unknown>[] | undefined) ?? []
    return [cur, ...children.flatMap(c => flatten(c, depth + 1))]
  }

  const children = (root['children'] as Record<string, unknown>[] | undefined) ?? []
  const nodes = children.flatMap(c => flatten(c, 0))
  return { total, nodes }
}

function ProfileRow({ node, totalMs, expanded, onToggle, hasChildren }: {
  node: ProfileNode
  totalMs: number
  expanded: boolean
  onToggle: () => void
  hasChildren: boolean
}) {
  const pct = totalMs > 0 ? (node.timing * 1000 / totalMs) * 100 : 0
  const ms = (node.timing * 1000).toFixed(3)
  const indent = (node.depth ?? 0) * 16

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)', minWidth: 0 }}>
      <div style={{ width: indent + 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        {hasChildren
          ? <button onClick={onToggle} style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          : null
        }
      </div>
      <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
      {node.result != null && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{node.result.toLocaleString()} 行</span>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)', flexShrink: 0, minWidth: 72, textAlign: 'right' }}>{ms} ms</span>
      {/* 时间比例条 */}
      <div style={{ width: 80, height: 10, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: timingColor(pct), transition: 'width 0.2s' }} />
      </div>
      <span style={{ fontSize: 10, color: timingColor(pct), fontFamily: 'var(--font-mono)', minWidth: 38, textAlign: 'right', flexShrink: 0 }}>{pct.toFixed(1)}%</span>
    </div>
  )
}

export default function DuckProfilePanel({ connectionId }: Props) {
  const [sql, setSql] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ total: number; nodes: ProfileNode[] } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const runProfile = useCallback(async () => {
    if (!sql.trim()) return
    setLoading(true); setError(null); setResult(null); setCollapsed(new Set())
    try {
      const json = await invoke<unknown>('duckdb_profile_query', { id: connectionId, sql: sql.trim() })
      setResult(parseProfileJson(json))
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, sql])

  // 构建树结构用于折叠
  const nodeKeys = result?.nodes.map(n => `${n.depth}-${n.name}`) ?? []
  // 检测哪些节点有子节点（下一个节点 depth 更深）
  const hasChildrenMap = new Map<number, boolean>()
  if (result) {
    result.nodes.forEach((n, i) => {
      const next = result.nodes[i + 1]
      hasChildrenMap.set(i, !!next && (next.depth ?? 0) > (n.depth ?? 0))
    })
  }

  // 可见节点：如果某祖先被折叠则隐藏
  function isVisible(idx: number): boolean {
    if (!result) return false
    const node = result.nodes[idx]
    const depth = node.depth ?? 0
    if (depth === 0) return true
    // 向前找第一个 depth 更浅的节点，如果它被折叠则不可见
    for (let i = idx - 1; i >= 0; i--) {
      const ancestor = result.nodes[i]
      const adepth = ancestor.depth ?? 0
      if (adepth < depth) {
        const key = nodeKeys[i]
        if (collapsed.has(key)) return false
        if (adepth === 0) break
        depth === adepth + 1 && (void 0) // continue checking
      }
    }
    return true
  }

  const totalMs = (result?.total ?? 0) * 1000

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      {/* SQL 输入区 */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={e => { if ((e.key === 'r' || e.key === 'R') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runProfile() } }}
          placeholder="输入要分析的 SQL"
          rows={3}
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical', minHeight: 60 }}
        />
        <button onClick={runProfile} disabled={loading || !sql.trim()}
          style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: (loading || !sql.trim()) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, opacity: !sql.trim() ? 0.5 : 1, flexShrink: 0 }}>
          {loading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Activity size={13} />}
          分析
        </button>
      </div>

      {/* 结果区 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {error && (
          <div style={{ margin: 14, padding: '8px 12px', background: '#7f1d1d22', border: '1px solid #dc262640', borderRadius: 8, fontSize: 12, color: 'var(--error)', display: 'flex', gap: 8 }}>
            <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            {error}
          </div>
        )}

        {result && (
          <>
            {/* 汇总 */}
            <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>总耗时</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>
                {totalMs >= 1000 ? `${(totalMs / 1000).toFixed(3)} s` : `${totalMs.toFixed(3)} ms`}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{result.nodes.length} 个算子</span>
            </div>

            {/* 列头 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, zIndex: 1 }}>
              <div style={{ width: 16, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>算子</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 40, textAlign: 'right' }}>行数</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 72, textAlign: 'right' }}>耗时</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 80 }}></span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 38, textAlign: 'right' }}>占比</span>
            </div>

            {/* 算子行 */}
            {result.nodes.map((node, i) => {
              if (!isVisible(i)) return null
              const key = nodeKeys[i]
              const hasChildren = hasChildrenMap.get(i) ?? false
              return (
                <ProfileRow
                  key={i}
                  node={node}
                  totalMs={totalMs}
                  expanded={!collapsed.has(key)}
                  onToggle={() => setCollapsed(prev => {
                    const next = new Set(prev)
                    next.has(key) ? next.delete(key) : next.add(key)
                    return next
                  })}
                  hasChildren={hasChildren}
                />
              )
            })}

            {result.nodes.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                未获得分析数据（DuckDB 版本过旧？请尝试 v0.9+）
              </div>
            )}
          </>
        )}

        {!result && !loading && !error && (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            <Activity size={24} style={{ opacity: 0.3, marginBottom: 8, display: 'block', margin: '0 auto 8px' }} />
            输入 SQL 后点击"分析"，获取算子级耗时火焰树<br />
            <span style={{ fontSize: 11 }}>需 DuckDB v0.9+ 且 JSON profiling 可用</span>
          </div>
        )}
      </div>
    </div>
  )
}
