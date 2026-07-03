// K6 — 单行详情视图：竖排字段卡，JSON 自动格式化高亮
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Copy } from 'lucide-react'

interface Props {
  columns: string[]
  row: (string | null)[]
  rowIndex: number
  onClose: () => void
}

function tryFormatJson(val: string): { formatted: string; isJson: boolean } {
  if (!val.trimStart().startsWith('{') && !val.trimStart().startsWith('[')) {
    return { formatted: val, isJson: false }
  }
  try {
    return { formatted: JSON.stringify(JSON.parse(val), null, 2), isJson: true }
  } catch {
    return { formatted: val, isJson: false }
  }
}

export default function RowDetailPanel({ columns, row, rowIndex, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>行详情</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>第 {rowIndex + 1} 行</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {columns.map((col, i) => {
            const val = row[i]
            const isNull = val === null
            const { formatted, isJson } = val ? tryFormatJson(val) : { formatted: '', isJson: false }
            const isLong = !isNull && val!.length > 100

            return (
              <div key={col} style={{
                marginBottom: 8, border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'var(--surface-2)', borderBottom: isNull ? 'none' : '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{col}</span>
                  {isJson && <span style={{ fontSize: 10, color: 'var(--accent)', background: 'rgba(59,130,246,0.1)', padding: '1px 5px', borderRadius: 3 }}>JSON</span>}
                  {isNull && <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface)', padding: '1px 5px', borderRadius: 3 }}>NULL</span>}
                  {!isNull && (
                    <button
                      className="dbt-header-btn"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => navigator.clipboard.writeText(val!)}
                      title="复制值"
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </div>
                {!isNull && (
                  <div style={{
                    padding: '8px 10px',
                    fontFamily: isJson || isLong ? 'var(--font-mono)' : 'inherit',
                    fontSize: isJson || isLong ? 11 : 13,
                    color: 'var(--text)',
                    whiteSpace: isJson || isLong ? 'pre-wrap' : 'normal',
                    wordBreak: 'break-word',
                    maxHeight: isLong || isJson ? 300 : 'auto',
                    overflow: 'auto',
                  }}>
                    {formatted}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
