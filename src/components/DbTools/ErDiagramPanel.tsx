// ER 关系图（React Flow）：自定义表节点 + 列级锚点 + 鱼尾纹关系 + 推断关系 + minimap + 适应窗口 + 悬停高亮
import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, BackgroundVariant,
  type Node, type Edge, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Network, X, Maximize2, Minimize2, Image as ImageIcon, KeyRound, Link2, RotateCcw } from 'lucide-react'
import { toast } from '../../stores/toastStore'

interface ErColumn { name: string; dataType: string; isPk: boolean; isNullable: boolean }
interface ErTable  { name: string; columns: ErColumn[] }
interface ErFk     { fromTable: string; fromCol: string; toTable: string; toCol: string; inferred?: boolean }
interface ErData   { tables: ErTable[]; fks: ErFk[] }

const NODE_W = 200
const ROW_H  = 24
const HEADER = 32

function tableHeight(t: ErTable) { return HEADER + t.columns.length * ROW_H }

// 无外键时按命名约定推断关系：列名 `xxx_id` → 名字匹配 xxx 的表（精确/后缀/复数）。
function inferFks(tables: ErTable[]): ErFk[] {
  const names = tables.map(t => t.name)
  const out: ErFk[] = []
  for (const t of tables) {
    for (const c of t.columns) {
      const m = /^(.+)_id$/.exec(c.name.toLowerCase())
      if (!m || !m[1]) continue
      const base = m[1]
      const cands = names.filter(n => {
        const nl = n.toLowerCase()
        return nl !== t.name.toLowerCase() && (nl === base || nl === base + 's' || nl.endsWith('_' + base) || nl.endsWith('_' + base + 's'))
      })
      if (!cands.length) continue
      const target = cands.sort((a, b) => a.length - b.length)[0]
      const tt = tables.find(x => x.name === target)!
      const pk = tt.columns.find(x => x.isPk)?.name ?? 'id'
      out.push({ fromTable: t.name, fromCol: c.name, toTable: target, toCol: pk, inferred: true })
    }
  }
  return out
}

// 按连通性排序 + 列打包布局：关联的表尽量相邻，按各表实际高度纵向堆叠不重叠。
function buildLayout(tables: ErTable[], fks: ErFk[]): Record<string, { x: number; y: number }> {
  const adj = new Map<string, Set<string>>()
  tables.forEach(t => adj.set(t.name, new Set()))
  fks.forEach(f => { adj.get(f.fromTable)?.add(f.toTable); adj.get(f.toTable)?.add(f.fromTable) })
  const deg = (n: string) => adj.get(n)?.size ?? 0
  // BFS 排序：从度最高的表起，邻居优先，关联表聚拢
  const order: string[] = []
  const seen = new Set<string>()
  const roots = [...tables].sort((a, b) => deg(b.name) - deg(a.name))
  for (const r of roots) {
    if (seen.has(r.name)) continue
    const q = [r.name]; seen.add(r.name)
    while (q.length) {
      const cur = q.shift()!
      order.push(cur)
      const nbrs = [...(adj.get(cur) ?? [])].sort((a, b) => deg(b) - deg(a))
      for (const nb of nbrs) if (!seen.has(nb)) { seen.add(nb); q.push(nb) }
    }
  }
  const byName = new Map(tables.map(t => [t.name, t]))
  const cols = Math.max(1, Math.round(Math.sqrt(tables.length)))
  const gapX = 80, gapY = 40
  const colY = new Array(cols).fill(0)
  const pos: Record<string, { x: number; y: number }> = {}
  order.forEach((name, i) => {
    const col = i % cols
    pos[name] = { x: col * (NODE_W + gapX), y: colY[col] }
    colY[col] += tableHeight(byName.get(name)!) + gapY
  })
  return pos
}

// ── 自定义表节点 ──
interface TableNodeData extends Record<string, unknown> {
  table: ErTable
  handleCols: Set<string>   // 仅参与关系的列才渲染锚点，控制 handle 数量
  fkCols: Set<string>
  dim?: boolean
  focus?: boolean
  hlCols?: Set<string>      // 聚焦/悬停时参与关系的列（整行染色）
}

const EMPTY_SET: Set<string> = new Set()

const hStyle = { width: 1, height: 1, minWidth: 1, minHeight: 1, background: 'transparent', border: 'none' } as const

const TableNode = memo(({ data }: NodeProps<Node<TableNodeData>>) => {
  const { table, handleCols, fkCols, dim, focus, hlCols } = data
  const hl = hlCols ?? EMPTY_SET
  return (
    <div style={{
      width: NODE_W, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
      overflow: 'hidden', fontFamily: 'var(--font-mono)', opacity: dim ? 0.28 : 1,
      boxShadow: focus ? '0 0 0 2px var(--accent), 0 8px 24px rgba(0,0,0,0.22)' : '0 2px 10px rgba(0,0,0,0.14)',
      transition: 'opacity .12s, box-shadow .12s',
    }}>
      <div style={{ height: HEADER, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '0 8px' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.name}</span>
      </div>
      {table.columns.map(c => {
        const needH = handleCols.has(c.name)
        const isHl = hl.has(c.name)
        return (
          <div key={c.name} style={{
            position: 'relative', height: ROW_H, display: 'flex', alignItems: 'center', gap: 5, padding: '0 9px',
            fontSize: 11, borderTop: '1px solid var(--border-subtle)', color: 'var(--text)',
            background: isHl ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : undefined,
            boxShadow: isHl ? 'inset 2px 0 0 var(--accent)' : undefined,
          }}>
            {needH && <>
              <Handle type="source" position={Position.Left}  id={`${c.name}__sl`} style={hStyle} isConnectable={false} />
              <Handle type="target" position={Position.Left}  id={`${c.name}__tl`} style={hStyle} isConnectable={false} />
              <Handle type="source" position={Position.Right} id={`${c.name}__sr`} style={hStyle} isConnectable={false} />
              <Handle type="target" position={Position.Right} id={`${c.name}__tr`} style={hStyle} isConnectable={false} />
            </>}
            <span style={{ width: 13, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
              {c.isPk ? <KeyRound size={11} color="#ea580c" /> : fkCols.has(c.name) ? <Link2 size={11} color="var(--accent)" /> : null}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontWeight: c.isPk ? 700 : 400, color: c.isPk ? 'var(--text-bright)' : 'var(--text)' }}>{c.name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>{c.dataType}</span>
          </div>
        )
      })}
    </div>
  )
})

const nodeTypes = { table: TableNode }

interface Props { connId: string; schema: string; connName: string; onClose: () => void }

export default function ErDiagramPanel({ connId, schema, connName, onClose }: Props) {
  const [erData, setErData] = useState<ErData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [rfi, setRfi] = useState<ReactFlowInstance<Node<TableNodeData>, Edge> | null>(null)
  const selectedRef = useRef<string | null>(null)   // 持久选中的表（点击聚焦），鼠标移走不丢
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const realCount = erData ? erData.fks.filter(f => !f.inferred).length : 0
  const inferCount = erData ? erData.fks.filter(f => f.inferred).length : 0

  useEffect(() => {
    setLoading(true)
    invoke<ErData>('db_er_data', { id: connId, schema })
      .then(d => {
        const realKeys = new Set(d.fks.map(f => `${f.fromTable}.${f.fromCol}`))
        const inferred = inferFks(d.tables).filter(f => !realKeys.has(`${f.fromTable}.${f.fromCol}`))
        setErData({ tables: d.tables, fks: [...d.fks, ...inferred] })
        setError('')
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [connId, schema])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (fullscreen) setFullscreen(false); else onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, fullscreen])

  // 构建 nodes / edges
  const built = useMemo(() => {
    if (!erData) return { nodes: [] as Node<TableNodeData>[], edges: [] as Edge[] }
    const pos = buildLayout(erData.tables, erData.fks)
    // 每表需要锚点的列 = 作为 FK 源列 或 被指向的目标列
    const handleCols = new Map<string, Set<string>>()
    const fkCols = new Map<string, Set<string>>()
    erData.tables.forEach(t => { handleCols.set(t.name, new Set()); fkCols.set(t.name, new Set()) })
    erData.fks.forEach(f => {
      handleCols.get(f.fromTable)?.add(f.fromCol); handleCols.get(f.toTable)?.add(f.toCol)
      fkCols.get(f.fromTable)?.add(f.fromCol)
    })
    const ns: Node<TableNodeData>[] = erData.tables.map(t => ({
      id: t.name, type: 'table', position: pos[t.name] ?? { x: 0, y: 0 },
      data: { table: t, handleCols: handleCols.get(t.name)!, fkCols: fkCols.get(t.name)! },
    }))
    const es: Edge[] = erData.fks.map((f, i) => {
      const cRight = (pos[f.fromTable]?.x ?? 0) <= (pos[f.toTable]?.x ?? 0)   // 子表在左→从右侧出
      const stroke = f.inferred ? '#8b5cf6' : 'var(--accent)'   // 推断关系用紫色，与真外键蓝色区分
      return {
        id: `e${i}`, source: f.fromTable, target: f.toTable,
        sourceHandle: `${f.fromCol}__s${cRight ? 'r' : 'l'}`,
        targetHandle: `${f.toCol}__t${cRight ? 'l' : 'r'}`,
        type: 'smoothstep',
        markerStart: f.inferred ? undefined : 'url(#er-many)',
        markerEnd: f.inferred ? 'url(#er-i-arrow)' : 'url(#er-one)',
        style: { stroke, strokeWidth: 1.5, strokeDasharray: f.inferred ? '6 4' : undefined, opacity: f.inferred ? 0.85 : 0.85 },
        data: { baseStroke: stroke, inferred: !!f.inferred, fromCol: f.fromCol, toCol: f.toCol },
      }
    })
    return { nodes: ns, edges: es }
  }, [erData])

  useEffect(() => { setNodes(built.nodes); setEdges(built.edges) }, [built, setNodes, setEdges])
  useEffect(() => { if (rfi && built.nodes.length) setTimeout(() => rfi.fitView({ padding: 0.15 }), 50) }, [rfi, built.nodes.length])

  // 统一高亮：name=聚焦表（null 清除）；gather=true 时把直接关联表环绕「就近放」并 fit。
  // 同时把参与关系的列（fromCol/toCol）整行染色，一眼看清哪列连哪列。
  const highlight = useCallback((name: string | null, gather: boolean) => {
    if (!name) {
      setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, dim: false, focus: false, hlCols: undefined } })))
      setEdges(es => es.map(e => ({ ...e, animated: false, style: { ...e.style, opacity: e.data?.inferred ? 0.8 : 0.85, strokeWidth: 1.5 } })))
      return
    }
    const neighbors: string[] = []
    const hl = new Map<string, Set<string>>()
    const addHl = (t: string, c?: string) => { if (!c) return; const s = hl.get(t) ?? new Set<string>(); s.add(c); hl.set(t, s) }
    built.edges.forEach(e => {
      if (e.source !== name && e.target !== name) return
      addHl(e.source, e.data?.fromCol as string | undefined)
      addHl(e.target, e.data?.toCol as string | undefined)
      if (e.source === name && e.target !== name && !neighbors.includes(e.target)) neighbors.push(e.target)
      if (e.target === name && e.source !== name && !neighbors.includes(e.source)) neighbors.push(e.source)
    })
    const nbSet = new Set(neighbors)
    setNodes(ns => {
      const ring = new Map<string, { x: number; y: number }>()
      if (gather) {
        const center = ns.find(n => n.id === name)?.position ?? { x: 0, y: 0 }
        const R = Math.max(330, 120 + neighbors.length * 24)
        neighbors.forEach((nm, i) => {
          const a = -Math.PI / 2 + (i / Math.max(1, neighbors.length)) * Math.PI * 2
          ring.set(nm, { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R })
        })
      }
      return ns.map(n => ({
        ...n,
        position: ring.get(n.id) ?? n.position,
        data: { ...n.data, dim: n.id !== name && !nbSet.has(n.id), focus: n.id === name, hlCols: hl.get(n.id) },
      }))
    })
    setEdges(es => es.map(e => {
      const on = e.source === name || e.target === name
      const base = (e.data?.baseStroke as string) ?? 'var(--accent)'
      return { ...e, animated: on, style: { ...e.style, opacity: on ? 1 : 0.05, strokeWidth: on ? 2 : 1.5, stroke: base } }
    }))
    if (gather) setTimeout(() => rfi?.fitView({ nodes: [name, ...neighbors].map(id => ({ id })), padding: 0.3, duration: 450 }), 60)
  }, [built.edges, rfi, setNodes, setEdges])

  // 悬停=临时预览高亮；点击=聚焦就近并持久选中（移走不丢）
  const onNodeEnter = useCallback((_: unknown, node: Node) => highlight(node.id, false), [highlight])
  const onNodeLeave = useCallback(() => highlight(selectedRef.current, false), [highlight])
  const focusTable = useCallback((name: string) => { selectedRef.current = name; highlight(name, true) }, [highlight])
  const clearFocus = useCallback(() => { selectedRef.current = null; highlight(null, false) }, [highlight])

  // 还原初始布局 + 清除高亮/选中
  const resetLayout = useCallback(() => {
    selectedRef.current = null
    setNodes(built.nodes); setEdges(built.edges)
    setTimeout(() => rfi?.fitView({ padding: 0.15, duration: 400 }), 30)
  }, [built.nodes, built.edges, rfi, setNodes, setEdges])

  const exportPng = async () => {
    const el = document.querySelector('.er-flow .react-flow__viewport') as HTMLElement | null
    if (!el) return
    try {
      const { toPng } = await import('html-to-image')
      const url = await toPng(el, { backgroundColor: getComputedStyle(document.body).getPropertyValue('--bg') || '#fff', pixelRatio: 2, cacheBust: true })
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ defaultPath: `er-${schema}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
      if (!path) return
      const bin = atob(url.split(',')[1])
      const bytes = Array.from(bin, ch => ch.charCodeAt(0))
      await invoke('write_local_bytes', { path, bytes })
      toast.exported(path)
    } catch (e) { toast.error(`导出失败：${String(e)}`) }
  }

  const btn: React.CSSProperties = { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', cursor: 'pointer', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }
  const boxStyle: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
    : { width: '92vw', maxWidth: 1280, height: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={boxStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Network size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>ER 关系图 — {connName} / {schema}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => rfi?.fitView({ padding: 0.15 })} style={btn} data-tip="适应窗口"><Maximize2 size={12} />适应</button>
            <button onClick={resetLayout} style={btn} data-tip="还原初始布局"><RotateCcw size={12} />重置布局</button>
            <button onClick={exportPng} style={btn} data-tip="导出 PNG"><ImageIcon size={12} />导出 PNG</button>
            <button onClick={() => setFullscreen(f => !f)} style={btn} data-tip={fullscreen ? '退出全屏' : '全屏'}>
              {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative', background: 'var(--bg)' }}>
          {/* 聚焦时节点平滑移动；拖拽中关闭过渡避免拖影 */}
          <style>{`.er-flow .react-flow__node{transition:transform .38s cubic-bezier(.4,0,.2,1)}.er-flow .react-flow__node.dragging{transition:none}`}</style>
          {/* 关系标记定义：真外键鱼尾纹（蓝）；推断关系箭头（紫）*/}
          <svg style={{ position: 'absolute', width: 0, height: 0 }}>
            <defs>
              <marker id="er-many" markerWidth="22" markerHeight="22" refX="20" refY="11" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M20,11 L6,4 M20,11 L6,11 M20,11 L6,18" stroke="var(--accent)" fill="none" strokeWidth="1.4" />
              </marker>
              <marker id="er-one" markerWidth="22" markerHeight="22" refX="8" refY="11" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M12,4 L12,18" stroke="var(--accent)" fill="none" strokeWidth="1.6" />
              </marker>
              <marker id="er-i-arrow" markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M2,2 L9,6 L2,10" stroke="#8b5cf6" fill="none" strokeWidth="1.6" />
              </marker>
            </defs>
          </svg>

          {loading && <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}
          {error && <div style={{ padding: 24, color: 'var(--error)', fontSize: 12 }}>{error}</div>}
          {erData && erData.tables.length === 0 && !loading && (
            <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12 }}>该 schema 下没有表</div>
          )}
          {erData && erData.tables.length > 0 && (
            <ReactFlow<Node<TableNodeData>, Edge>
              className="er-flow"
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              onInit={setRfi}
              onNodeClick={(_, node) => focusTable(node.id)}
              onPaneClick={clearFocus}
              onNodeMouseEnter={onNodeEnter}
              onNodeMouseLeave={onNodeLeave}
              minZoom={0.1} maxZoom={2.5}
              proOptions={{ hideAttribution: true }}
              nodesConnectable={false}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor="var(--accent)" maskColor="rgba(0,0,0,0.12)"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
            </ReactFlow>
          )}
        </div>

        {erData && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16 }}>
            <span>{erData.tables.length} 张表</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width={24} height={8}><line x1={0} y1={4} x2={24} y2={4} stroke="var(--accent)" strokeWidth={1.6} /></svg>
              {realCount} 条外键
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width={28} height={8}><line x1={0} y1={4} x2={22} y2={4} stroke="#8b5cf6" strokeWidth={1.6} strokeDasharray="6 4" /><path d="M22,1 L27,4 L22,7" stroke="#8b5cf6" fill="none" strokeWidth={1.4} /></svg>
              {inferCount} 条推断关系
            </span>
            <span style={{ marginLeft: 'auto' }}>悬停高亮 · 点击表聚焦就近 · 滚轮缩放 · 拖空白平移</span>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
