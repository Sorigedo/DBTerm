// M3 — 结果集两列一键图表（纯 SVG，无依赖）
import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, BarChart2, TrendingUp, PieChart } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'

interface Props {
  columns: string[]
  rows: (string | null)[][]
  onClose: () => void
}

type ChartType = 'bar' | 'line' | 'pie'

const W = 560
const H = 340
const PAD = 48

function toNum(v: string | null): number {
  if (v === null) return 0
  const n = parseFloat(v.replace(/,/g, ''))
  return isNaN(n) ? 0 : n
}

const COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#f87171', '#34d399', '#a78bfa', '#fb923c', '#38bdf8']

export default function ChartPanel({ columns, rows, onClose }: Props) {
  const [xCol, setXCol] = useState(0)
  const [yCol, setYCol] = useState(1)
  const [chartType, setChartType] = useState<ChartType>('bar')

  const data = useMemo(() => {
    return rows.slice(0, 100).map(r => ({
      label: String(r[xCol] ?? ''),
      value: toNum(r[yCol]),
    }))
  }, [rows, xCol, yCol])

  const maxVal = useMemo(() => Math.max(...data.map(d => d.value), 1), [data])
  const innerW = W - PAD * 2
  const innerH = H - PAD * 2

  const renderBar = () => {
    const bw = Math.max(4, Math.min(40, Math.floor(innerW / data.length) - 4))
    return (
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Y axis */}
        <line x1={PAD} y1={PAD} x2={PAD} y2={PAD + innerH} stroke="var(--border)" />
        {/* X axis */}
        <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} stroke="var(--border)" />
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD + innerH * (1 - f)
          return <g key={f}>
            <line x1={PAD} y1={y} x2={PAD + innerW} y2={y} stroke="var(--border-subtle)" strokeDasharray="4,4" />
            <text x={PAD - 4} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">{(maxVal * f).toFixed(1)}</text>
          </g>
        })}
        {/* Bars */}
        {data.map((d, i) => {
          const x = PAD + (i / data.length) * innerW + (innerW / data.length - bw) / 2
          const h = (d.value / maxVal) * innerH
          const y = PAD + innerH - h
          return <g key={i}>
            <rect x={x} y={y} width={bw} height={h} fill={COLORS[i % COLORS.length]} rx={2} />
            {data.length <= 20 && (
              <text x={x + bw / 2} y={PAD + innerH + 12} textAnchor="middle" fontSize={9} fill="var(--text-muted)"
                style={{ overflow: 'hidden' }}>
                {d.label.slice(0, 8)}
              </text>
            )}
          </g>
        })}
        {/* Y label */}
        <text x={PAD - 28} y={PAD + innerH / 2} textAnchor="middle" fontSize={10} fill="var(--text-muted)" transform={`rotate(-90,${PAD - 28},${PAD + innerH / 2})`}>{columns[yCol]}</text>
        <text x={PAD + innerW / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{columns[xCol]}</text>
      </svg>
    )
  }

  const renderLine = () => {
    if (data.length < 2) return <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--text-muted)" fontSize={12}>数据不足</text>
    const pts = data.map((d, i) => {
      const x = PAD + (i / (data.length - 1)) * innerW
      const y = PAD + innerH - (d.value / maxVal) * innerH
      return `${x},${y}`
    })
    return (
      <svg width={W} height={H} style={{ display: 'block' }}>
        <line x1={PAD} y1={PAD} x2={PAD} y2={PAD + innerH} stroke="var(--border)" />
        <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} stroke="var(--border)" />
        {[0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD + innerH * (1 - f)
          return <g key={f}>
            <line x1={PAD} y1={y} x2={PAD + innerW} y2={y} stroke="var(--border-subtle)" strokeDasharray="4,4" />
            <text x={PAD - 4} y={y + 4} textAnchor="end" fontSize={9} fill="var(--text-muted)">{(maxVal * f).toFixed(1)}</text>
          </g>
        })}
        <polyline points={pts.join(' ')} fill="none" stroke={COLORS[0]} strokeWidth={2} />
        {data.map((d, i) => {
          const x = PAD + (i / (data.length - 1)) * innerW
          const y = PAD + innerH - (d.value / maxVal) * innerH
          return <circle key={i} cx={x} cy={y} r={3} fill={COLORS[0]} />
        })}
        <text x={PAD + innerW / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--text-muted)">{columns[xCol]}</text>
      </svg>
    )
  }

  const renderPie = () => {
    const total = data.reduce((s, d) => s + Math.abs(d.value), 0)
    if (total === 0) return <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--text-muted)" fontSize={12}>数据全为 0</text>
    const cx = W / 2 - 40, cy = H / 2, r = Math.min(innerW, innerH) / 2 - 10
    let angle = -Math.PI / 2
    const slices = data.slice(0, 12).map((d, i) => {
      const frac = Math.abs(d.value) / total
      const start = angle
      angle += frac * Math.PI * 2
      const end = angle
      const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start)
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end)
      const large = frac > 0.5 ? 1 : 0
      return { d: `M${cx},${cy} L${x1},${y1} A${r},${r},0,${large},1,${x2},${y2} Z`, label: d.label, frac, color: COLORS[i % COLORS.length] }
    })
    return (
      <svg width={W} height={H} style={{ display: 'block' }}>
        {slices.map((s, i) => <path key={i} d={s.d} fill={s.color} stroke="var(--surface)" strokeWidth={1} />)}
        {/* Legend */}
        {slices.map((s, i) => (
          <g key={i} transform={`translate(${W - 140}, ${20 + i * 18})`}>
            <rect width={10} height={10} rx={2} fill={s.color} />
            <text x={14} y={9} fontSize={10} fill="var(--text-muted)">{s.label.slice(0, 12)} ({(s.frac * 100).toFixed(1)}%)</text>
          </g>
        ))}
      </svg>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: W + 32, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <BarChart2 size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>结果集图表</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ padding: '10px 16px', display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {([['bar', <BarChart2 size={12} />, '柱状'], ['line', <TrendingUp size={12} />, '折线'], ['pie', <PieChart size={12} />, '饼图']] as [ChartType, React.ReactNode, string][]).map(([t, icon, label]) => (
              <button key={t} onClick={() => setChartType(t)} style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 11, borderRadius: 5,
                border: '1px solid var(--border)', background: chartType === t ? 'var(--accent)' : 'transparent',
                color: chartType === t ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
              }}>{icon}{label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>X轴</span>
            <SearchableSelect
              value={String(xCol)}
              onChange={v => setXCol(Number(v))}
              items={columns.map((c, i) => ({ value: String(i), label: c }))}
              mono={false}
              width={150}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Y轴</span>
            <SearchableSelect
              value={String(yCol)}
              onChange={v => setYCol(Number(v))}
              items={columns.map((c, i) => ({ value: String(i), label: c }))}
              mono={false}
              width={150}
            />
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{data.length} 行（最多 100）</span>
        </div>

        <div style={{ padding: 16, overflow: 'auto' }}>
          {chartType === 'bar' && renderBar()}
          {chartType === 'line' && renderLine()}
          {chartType === 'pie' && renderPie()}
        </div>
      </div>
    </div>,
    document.body
  )
}
