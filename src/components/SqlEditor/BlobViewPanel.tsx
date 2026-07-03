// R7 — BLOB/二进制查看：hex 视图、图片预览、文件下载
import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Eye, Hash } from 'lucide-react'

interface Props {
  value: string | null    // raw cell value (may be base64 for binary, or plain text)
  column: string
  onClose: () => void
}

type View = 'auto' | 'hex' | 'text'

function hexDump(str: string): string {
  const lineLen = 16
  const lines: string[] = []
  const len = Math.min(str.length, 4096)
  for (let i = 0; i < len; i += lineLen) {
    const chunk = str.slice(i, i + lineLen)
    const hex = Array.from(chunk).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk).map(c => {
      const code = c.charCodeAt(0)
      return code >= 32 && code < 127 ? c : '.'
    }).join('')
    const addr = i.toString(16).padStart(8, '0')
    lines.push(`${addr}  ${hex.padEnd(lineLen * 3 - 1)}  |${ascii}|`)
  }
  if (str.length > 4096) lines.push('... (truncated)')
  return lines.join('\n')
}

function guessIsImage(val: string): boolean {
  // Check for common image magic bytes (via charCodes)
  if (val.length < 4) return false
  const b0 = val.charCodeAt(0), b1 = val.charCodeAt(1), b2 = val.charCodeAt(2), b3 = val.charCodeAt(3)
  // JPEG: FF D8 FF
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return true
  // PNG: 89 50 4E 47
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return true
  // GIF: 47 49 46
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return true
  // WebP: RIFF
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return true
  return false
}

function guessIsText(val: string): boolean {
  const sample = val.slice(0, 512)
  const nonPrintable = Array.from(sample).filter(c => {
    const code = c.charCodeAt(0)
    return code < 32 && code !== 9 && code !== 10 && code !== 13
  }).length
  return nonPrintable / sample.length < 0.1
}

export default function BlobViewPanel({ value, column, onClose }: Props) {
  const [view, setView] = useState<View>('auto')

  const isImage = useMemo(() => value ? guessIsImage(value) : false, [value])
  const isText = useMemo(() => value ? guessIsText(value) : false, [value])

  const imgDataUrl = useMemo(() => {
    if (!value || !isImage) return null
    try {
      // Convert raw string to base64
      const bytes = Array.from(value).map(c => c.charCodeAt(0))
      const b64 = btoa(String.fromCharCode(...bytes))
      // Guess MIME
      const b0 = value.charCodeAt(0), b1 = value.charCodeAt(1)
      const mime = b0 === 0xFF && b1 === 0xD8 ? 'image/jpeg'
        : b0 === 0x89 ? 'image/png'
        : b0 === 0x47 ? 'image/gif'
        : 'image/webp'
      return `data:${mime};base64,${b64}`
    } catch { return null }
  }, [value, isImage])

  const handleDownload = () => {
    if (!value) return
    const bytes = new Uint8Array(Array.from(value).map(c => c.charCodeAt(0)))
    const blob = new Blob([bytes])
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${column}.bin`
    a.click()
    URL.revokeObjectURL(url)
  }

  const displayView = view === 'auto'
    ? (isImage ? 'image' : isText ? 'text' : 'hex')
    : view

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 680, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Eye size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>BLOB 查看器 — {column}</span>
          {value && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{value.length.toLocaleString()} 字节</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={handleDownload} data-tip="下载为文件" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11, cursor: 'pointer' }}>
              <Download size={11} />下载
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <button onClick={() => setView('auto')} style={{
            padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)',
            background: view === 'auto' ? 'var(--accent)' : 'transparent',
            color: view === 'auto' ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
          }}><Eye size={10} style={{ display: 'inline', marginRight: 4 }} />自动</button>
          <button onClick={() => setView('hex')} style={{
            padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)',
            background: view === 'hex' ? 'var(--accent)' : 'transparent',
            color: view === 'hex' ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
          }}><Hash size={10} style={{ display: 'inline', marginRight: 4 }} />HEX</button>
          <button onClick={() => setView('text')} style={{
            padding: '3px 10px', fontSize: 11, borderRadius: 5, border: '1px solid var(--border)',
            background: view === 'text' ? 'var(--accent)' : 'transparent',
            color: view === 'text' ? '#fff' : 'var(--text-muted)', cursor: 'pointer',
          }}>文本</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {!value && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>NULL / 空值</div>}
          {value && displayView === 'image' && imgDataUrl && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img src={imgDataUrl} alt={column} style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 8 }} />
            </div>
          )}
          {value && displayView === 'image' && !imgDataUrl && (
            <div style={{ color: 'var(--error)', fontSize: 12 }}>无法渲染图片数据</div>
          )}
          {value && (displayView === 'hex' || (displayView === 'image' && !imgDataUrl)) && (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'pre', overflow: 'auto', margin: 0, lineHeight: 1.6 }}>
              {hexDump(value)}
            </pre>
          )}
          {value && displayView === 'text' && (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
              {value.slice(0, 100000)}{value.length > 100000 ? '\n... (截断)' : ''}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
