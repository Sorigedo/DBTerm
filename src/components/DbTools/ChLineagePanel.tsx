import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, GitBranch, RefreshCw, Loader2 } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface LineageNode { id: string; database: string; name: string; engine: string; isMv: boolean }
interface LineageEdge { from: string; to: string }
interface Lineage { nodes: LineageNode[]; edges: LineageEdge[] }

const NODE_W = 170
const NODE_H = 46
const COL_GAP = 70
const ROW_GAP = 18

// 按最长路径分层（DAG 拓扑层级，带环保护）
function computeLayers(nodes: LineageNode[], edges: LineageEdge[]): Map<string, number> {
  const upstream = new Map<string, string[]>()
  nodes.forEach(n => upstream.set(n.id, []))
  edges.forEach(e => { if (upstream.has(e.to)) upstream.get(e.to)!.push(e.from) })
  const layer = new Map<string, number>()
  const depth = (id: string, visiting: Set<string>): number => {
    const cached = layer.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const ups = upstream.get(id) ?? []
    const d = ups.length === 0 ? 0 : Math.max(...ups.map(u => depth(u, visiting))) + 1
    visiting.delete(id)
    layer.set(id, d)
    return d
  }
  nodes.forEach(n => depth(n.id, new Set()))
  return layer
}

export default function ChLineagePanel({ connectionId, onClose, embedded }: Props) {
  const [data, setData] = useState<Lineage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<Lineage>('ch_mv_lineage', { id: connectionId })
      setData(res); setError('')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  // 布局：分层 → 每层垂直堆叠
  const layout = useMemo(() => {
    if (!data || data.nodes.length === 0) return null
    const layerOf = computeLayers(data.nodes, data.edges)
    const byLayer = new Map<number, LineageNode[]>()
    for (const n of data.nodes) {
      const l = layerOf.get(n.id) ?? 0
      if (!byLayer.has(l)) byLayer.set(l, [])
      byLayer.get(l)!.push(n)
    }
    const pos = new Map<string, { x: number; y: number }>()
    let maxRows = 0
    const layers = [...byLayer.keys()].sort((a, b) => a - b)
    for (const l of layers) {
      const ns = byLayer.get(l)!.sort((a, b) => a.id.localeCompare(b.id))
      ns.forEach((n, i) => pos.set(n.id, {
        x: 30 + l * (NODE_W + COL_GAP),
        y: 30 + i * (NODE_H + ROW_GAP),
      }))
      maxRows = Math.max(maxRows, ns.length)
    }
    const width = 60 + layers.length * (NODE_W + COL_GAP)
    const height = 60 + maxRows * (NODE_H + ROW_GAP)
    return { pos, width, height }
  }, [data])

  const inner = (
    <>
      {embedded && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <button onClick={load} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
        </div>
      )}

        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}><Loader2 size={16} className="spin" /> 加载血缘…</div>
          ) : error ? (
            <div style={{ margin: 16, padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : !data || data.nodes.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>未检测到物化视图血缘关系</div>
          ) : layout ? (
            <svg width={layout.width} height={layout.height} style={{ display: 'block' }}>
              <defs>
                <marker id="ch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
                </marker>
              </defs>
              {/* 边 */}
              {data.edges.map((e, i) => {
                const a = layout.pos.get(e.from); const b = layout.pos.get(e.to)
                if (!a || !b) return null
                const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2
                const x2 = b.x, y2 = b.y + NODE_H / 2
                const mx = (x1 + x2) / 2
                return (
                  <path key={i} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                    fill="none" stroke="var(--text-muted)" strokeWidth={1.4} markerEnd="url(#ch-arrow)" opacity={0.6} />
                )
              })}
              {/* 节点 */}
              {data.nodes.map(n => {
                const p = layout.pos.get(n.id)
                if (!p) return null
                return (
                  <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                    <rect width={NODE_W} height={NODE_H} rx={8}
                      fill="var(--surface)"
                      stroke={n.isMv ? 'var(--accent)' : 'var(--border)'}
                      strokeWidth={n.isMv ? 2 : 1} />
                    <text x={10} y={19} fontSize={12} fontWeight={600} fill="var(--text-bright)"
                      style={{ fontFamily: 'var(--font-mono)' }}>
                      {n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name}
                    </text>
                    <text x={10} y={35} fontSize={10} fill={n.isMv ? 'var(--accent)' : 'var(--text-muted)'}>
                      {n.isMv ? 'MaterializedView' : (n.engine || n.database)}
                    </text>
                  </g>
                )
              })}
            </svg>
          ) : null}
        </div>

        {data && data.nodes.length > 0 && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
            {data.nodes.length} 个对象 · {data.edges.length} 条依赖（蓝框=物化视图；箭头方向=数据流向：上游 → 下游）
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入顶部行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: '88vw', maxWidth: 1200, height: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitBranch size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>物化视图血缘图</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><RefreshCw size={14} /></button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
