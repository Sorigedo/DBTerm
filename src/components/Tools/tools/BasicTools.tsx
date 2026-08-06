import { CheckCircle2, ChevronRight, Copy, FileInput, Languages, Minimize2, Save, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from '../../../stores/toastStore'

function copyText(text: string) {
  if (!text) return
  navigator.clipboard?.writeText(text)
    .then(() => toast.success('已复制到剪贴板'))
    .catch(() => toast.error('复制失败', { transient: true }))
}

function saveText(text: string, filename: string, type = 'text/plain;charset=utf-8') {
  if (!text) return
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  toast.success(`已保存：${filename}`)
}

function ToolShell({ children }: { children: React.ReactNode }) {
  return <div className="tool-shell">{children}</div>
}

function TextArea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <textarea className="tool-textarea" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} spellCheck={false} />
}

function Result({ value }: { value: string }) {
  return (
    <div className="tool-result">
      <div className="tool-result__bar">
        <span>结果</span>
      </div>
      <pre>{value}</pre>
    </div>
  )
}

function ToolFooter({ value, onClear, filename }: { value: string; onClear: () => void; filename: string }) {
  return (
    <div className="tool-actions tool-actions--right">
      <button className="tool-actions__copy" onClick={() => copyText(value)} disabled={!value}><Copy size={13} />复制</button>
      <button onClick={() => saveText(value, filename)} disabled={!value}><Save size={13} />保存本地</button>
      <button className="tool-btn-danger" onClick={() => { onClear(); toast.success('已清空') }} disabled={!value}><Trash2 size={14} /> 清空</button>
    </div>
  )
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function parseMaybeJson(input: string): JsonValue | null {
  if (!input.trim()) return null
  try { return JSON.parse(input) as JsonValue }
  catch { return null }
}

function jsonPrimitiveText(value: JsonValue) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return String(value)
}

function collectJsonBranchPaths(value: JsonValue, path = '$'): string[] {
  if (!value || typeof value !== 'object') return []
  return [path, ...Object.entries(value as Record<string, JsonValue>).flatMap(([key, child]) => collectJsonBranchPaths(child, `${path}.${key}`))]
}

type JsonTreeRow =
  | { kind: 'branch'; key: string; path: string; name?: string; value: JsonValue; depth: number; collapsed: boolean; count: number }
  | { kind: 'primitive'; key: string; name?: string; value: JsonValue; depth: number }
  | { kind: 'close'; key: string; value: JsonValue; depth: number }

function flattenJsonRows(value: JsonValue, collapsed: Set<string>, path = '$', depth = 0, name?: string): JsonTreeRow[] {
  const isObject = !!value && typeof value === 'object'
  if (!isObject) return [{ kind: 'primitive', key: path, name, value, depth }]

  const children = Object.entries(value as Record<string, JsonValue>)
  const isCollapsed = collapsed.has(path)
  const rows: JsonTreeRow[] = [{ kind: 'branch', key: path, path, name, value, depth, collapsed: isCollapsed, count: children.length }]
  if (!isCollapsed) {
    for (const [key, child] of children) {
      rows.push(...flattenJsonRows(child, collapsed, `${path}.${key}`, depth + 1, key))
    }
    rows.push({ kind: 'close', key: `${path}.__close`, value, depth })
  }
  return rows
}

function JsonTreeRowView({ row, line, onToggle }: {
  row: JsonTreeRow
  line: number
  name?: string
  onToggle: (path: string) => void
}) {
  if (row.kind === 'primitive') {
    return (
      <div className="json-tree__line-row">
        <span className="json-tree__line-no">{line}</span>
        <div className="json-tree__row" style={{ paddingLeft: row.depth * 18 }}>
          <span className="json-tree__spacer" />
          {row.name !== undefined && <span className="json-tree__key">"{row.name}": </span>}
          <span className={`json-tree__value json-tree__value--${row.value === null ? 'null' : typeof row.value}`}>{jsonPrimitiveText(row.value)}</span>
        </div>
      </div>
    )
  }

  if (row.kind === 'close') {
    const closeToken = Array.isArray(row.value) ? ']' : '}'
    return (
      <div className="json-tree__line-row">
        <span className="json-tree__line-no">{line}</span>
        <div className="json-tree__row" style={{ paddingLeft: row.depth * 18 }}>
          <span className="json-tree__spacer" />
          <span className="json-tree__token">{closeToken}</span>
        </div>
      </div>
    )
  }

  const openToken = Array.isArray(row.value) ? '[' : '{'
  const closeToken = Array.isArray(row.value) ? ']' : '}'
  return (
    <div className="json-tree__line-row">
      <span className="json-tree__line-no">{line}</span>
      <button className="json-tree__row json-tree__row--branch" style={{ paddingLeft: row.depth * 18 }} onClick={() => onToggle(row.path)}>
        <ChevronRight size={13} className={row.collapsed ? '' : 'open'} />
        {row.name !== undefined && <span className="json-tree__key">"{row.name}": </span>}
        <span className="json-tree__token">{openToken}</span>
        {row.collapsed && <span className="json-tree__meta">{row.count} 项</span>}
        {row.collapsed && <span className="json-tree__token">{closeToken}</span>}
      </button>
    </div>
  )
}

export function JsonTool() {
  const [source, setSource] = useState(() => localStorage.getItem('tool-json-draft') ?? '')
  const [result, setResult] = useState('')
  const [err, setErr] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const sourceLines = useMemo(() => Math.max(1, source.split('\n').length), [source])
  const resultJson = useMemo(() => parseMaybeJson(result), [result])
  const resultRows = useMemo(() => resultJson ? flattenJsonRows(resultJson, collapsed) : [], [resultJson, collapsed])

  useEffect(() => {
    localStorage.setItem('tool-json-draft', source)
  }, [source])

  const setOk = (value: string, message = '') => {
    setResult(value)
    setErr(message)
    setCollapsed(new Set())
    if (message) toast.success(message)
  }

  const parseJson = () => JSON.parse(source)

  const format = () => {
    try {
      setOk(JSON.stringify(parseJson(), null, 2), '校验通过')
    } catch (e) {
      setErr(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      toast.error('JSON 解析失败', { transient: true })
    }
  }

  const minify = () => {
    try { setOk(JSON.stringify(parseJson()), '已压缩') }
    catch (e) {
      setErr(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      toast.error('JSON 解析失败', { transient: true })
    }
  }

  const escapeJson = () => {
    try { setOk(JSON.stringify(source), '已转义') }
    catch (e) {
      setErr(`转义失败：${e instanceof Error ? e.message : String(e)}`)
      toast.error('转义失败', { transient: true })
    }
  }

  const unescapeJson = () => {
    try {
      const value = JSON.parse(source)
      setOk(typeof value === 'string' ? value : JSON.stringify(value, null, 2), '已去转义')
    } catch (e) {
      setErr(`去转义失败：${e instanceof Error ? e.message : String(e)}`)
      toast.error('去转义失败', { transient: true })
    }
  }

  const toUnicode = () => {
    setOk(source.replace(/[\u0080-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`), '已转换为 Unicode')
  }

  const fromUnicode = () => {
    setOk(source.replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), '已转换为中文')
  }

  const clear = () => {
    setSource('')
    setResult('')
    setErr('')
    setCollapsed(new Set())
    localStorage.removeItem('tool-json-draft')
    toast.success('已清空')
  }

  const saveLocal = () => {
    saveText(result || source, `dbterm-json-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, 'application/json;charset=utf-8')
  }

  const applyResult = () => {
    if (!result) return
    setSource(result)
    toast.success('已将结果应用到输入区')
  }

  const toggleNode = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="json-tool">
      <div className="json-editors">
        <div className="json-editor-wrap">
          <div className="json-editor__title">原文输入</div>
          <div className="json-editor">
            <div className="json-editor__lines" aria-hidden="true">
              {Array.from({ length: sourceLines }, (_, i) => <span key={i}>{i + 1}</span>)}
            </div>
            <textarea
              className="json-editor__textarea"
              value={source}
              placeholder="粘贴 JSON..."
              spellCheck={false}
              onChange={e => setSource(e.target.value)}
            />
            {!source && <div className="json-editor__hint">粘贴 JSON、转义后的 JSON 字符串或含 Unicode 的文本</div>}
          </div>
        </div>

        <div className="json-editor-wrap">
          <div className="json-editor__title">
            <span>处理结果</span>
            {resultJson && (
              <span className="json-editor__tools">
                <button onClick={() => setCollapsed(new Set(collectJsonBranchPaths(resultJson)))}>全部折叠</button>
                <button onClick={() => setCollapsed(new Set())}>全部展开</button>
              </span>
            )}
          </div>
          <div className="json-result-view">
            {resultJson ? (
              <div className="json-tree">
                {resultRows.map((row, i) => <JsonTreeRowView key={row.key} row={row} line={i + 1} onToggle={toggleNode} />)}
              </div>
            ) : result ? (
              <pre>{result}</pre>
            ) : (
              <div className="json-result-view__empty">操作结果会显示在这里，原文不会被覆盖</div>
            )}
          </div>
        </div>
      </div>

      <div className="json-tool__status">
        {err ? <span className="json-tool__status--error">{err}</span> : <span>{source ? '原文已保留，操作结果会写入右侧结果区' : '等待输入'}</span>}
      </div>

      <div className="json-actions">
        <button className="json-actions__primary" onClick={format}><CheckCircle2 size={14} />校验 / 格式化</button>
        <button onClick={minify}><Minimize2 size={14} />压缩</button>
        <button onClick={escapeJson}><Undo2 size={14} />转义</button>
        <button onClick={unescapeJson}><Undo2 size={14} />去转义</button>
        <button onClick={fromUnicode}><Languages size={14} />Unicode 转中文</button>
        <button onClick={toUnicode}><Languages size={14} />中文转 Unicode</button>
        <button onClick={applyResult} disabled={!result}><FileInput size={14} />应用到输入</button>
        <button className="json-actions__copy" onClick={() => copyText(result || source)} disabled={!result && !source}><Copy size={14} />复制结果</button>
        <button onClick={saveLocal} disabled={!source && !result}><Save size={14} />保存本地</button>
        <button className="json-actions__danger" onClick={clear} disabled={!source && !result}><Trash2 size={14} /> 清空</button>
      </div>
    </div>
  )
}

export function Base64Tool() {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const encode = () => setOutput(btoa(unescape(encodeURIComponent(input))))
  const decode = () => {
    try { setOutput(decodeURIComponent(escape(atob(input.trim())))) }
    catch { setOutput('Base64 解码失败') }
  }
  const encodeUrl = () => setOutput(btoa(unescape(encodeURIComponent(input))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''))
  const decodeUrl = () => {
    try {
      const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
      setOutput(decodeURIComponent(escape(atob(padded))))
    } catch { setOutput('Base64 URL 解码失败') }
  }
  return (
    <ToolShell>
      <TextArea value={input} onChange={setInput} placeholder="输入文本或 Base64..." />
      <div className="tool-actions">
        <button onClick={encode}>编码</button>
        <button onClick={decode}>解码</button>
        <button onClick={encodeUrl}>URL Safe 编码</button>
        <button onClick={decodeUrl}>URL Safe 解码</button>
      </div>
      <Result value={output} />
      <ToolFooter value={output || input} onClear={() => { setInput(''); setOutput('') }} filename="base64.txt" />
    </ToolShell>
  )
}

export function UrlTool() {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const params = useMemo(() => {
    try {
      const u = input.includes('://') ? new URL(input) : new URL(`http://x.local/?${input.replace(/^\?/, '')}`)
      return Array.from(u.searchParams.entries()).map(([k, v]) => `${k} = ${v}`).join('\n')
    } catch { return '' }
  }, [input])
  return (
    <ToolShell>
      <TextArea value={input} onChange={setInput} placeholder="输入 URL、查询字符串或普通文本..." />
      <div className="tool-actions">
        <button onClick={() => setOutput(encodeURIComponent(input))}>组件编码</button>
        <button onClick={() => {
          try { setOutput(decodeURIComponent(input)) }
          catch { setOutput('URL 解码失败') }
        }}>组件解码</button>
        <button onClick={() => setOutput(encodeURI(input))}>整段 URL 编码</button>
        <button onClick={() => {
          try { setOutput(decodeURI(input)) }
          catch { setOutput('URL 解码失败') }
        }}>整段 URL 解码</button>
        <button onClick={() => setOutput(params || '未发现查询参数')}>解析参数</button>
      </div>
      <Result value={output || params} />
      <ToolFooter value={output || params || input} onClear={() => { setInput(''); setOutput('') }} filename="url-result.txt" />
    </ToolShell>
  )
}

export function TimestampTool() {
  const [ts, setTs] = useState(String(Date.now()))
  const [dateText, setDateText] = useState('')
  const n = Number(ts.trim())
  const ms = Number.isFinite(n) ? (ts.trim().length <= 10 ? n * 1000 : n) : NaN
  const date = Number.isFinite(ms) ? new Date(ms) : null
  const fromDateText = () => {
    const d = new Date(dateText)
    if (!Number.isNaN(d.getTime())) setTs(String(d.getTime()))
  }
  const result = date
    ? `本地时间：${date.toLocaleString()}\nISO：${date.toISOString()}\nUTC：${date.toUTCString()}\n秒：${Math.floor(ms / 1000)}\n毫秒：${ms}`
    : '时间戳无效'
  return (
    <div className="time-tool">
      <div className="time-tool__grid">
        <section className="time-tool__panel">
          <div className="time-tool__label">时间戳转时间</div>
          <input className="tool-input" value={ts} onChange={e => setTs(e.target.value)} placeholder="支持秒或毫秒" />
          <div className="tool-actions">
            <button onClick={() => setTs(String(Date.now()))}>当前毫秒</button>
            <button onClick={() => setTs(String(Math.floor(Date.now() / 1000)))}>当前秒</button>
          </div>
        </section>

        <section className="time-tool__panel">
          <div className="time-tool__label">时间转时间戳</div>
          <div className="tool-row">
            <input className="tool-input" value={dateText} onChange={e => setDateText(e.target.value)} placeholder="2026-07-22 12:30:00" />
            <button className="tool-inline-btn" onClick={fromDateText}>转换</button>
          </div>
        </section>
      </div>

      <div className="time-tool__result">
        <div className="time-tool__result-head">
          <span>转换结果</span>
        </div>
        <div className="time-tool__result-grid">
          {date ? (
            <>
              <div><span>本地时间</span><strong>{date.toLocaleString()}</strong></div>
              <div><span>ISO</span><strong>{date.toISOString()}</strong></div>
              <div><span>UTC</span><strong>{date.toUTCString()}</strong></div>
              <div><span>秒</span><strong>{Math.floor(ms / 1000)}</strong></div>
              <div><span>毫秒</span><strong>{ms}</strong></div>
            </>
          ) : (
            <div><span>状态</span><strong>时间戳无效</strong></div>
          )}
        </div>
      </div>
      <ToolFooter value={result} onClear={() => { setTs(''); setDateText('') }} filename="timestamp.txt" />
    </div>
  )
}

export function UuidTool() {
  const [count, setCount] = useState(5)
  const [output, setOutput] = useState('')
  const make = () => crypto.randomUUID()
  const generate = (mode: 'normal' | 'upper' | 'compact' = 'normal') => setOutput(Array.from({ length: Math.max(1, Math.min(100, count)) }, () => {
    const v = make()
    if (mode === 'upper') return v.toUpperCase()
    if (mode === 'compact') return v.replace(/-/g, '')
    return v
  }).join('\n'))
  return (
    <ToolShell>
      <input className="tool-input" type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} />
      <div className="tool-actions">
        <button onClick={() => generate('normal')}>生成 UUID</button>
        <button onClick={() => generate('upper')}>大写</button>
        <button onClick={() => generate('compact')}>无横线</button>
      </div>
      <Result value={output} />
      <ToolFooter value={output} onClear={() => setOutput('')} filename="uuid.txt" />
    </ToolShell>
  )
}

export function HashTool() {
  const [input, setInput] = useState('')
  const [algo, setAlgo] = useState('SHA-256')
  const [output, setOutput] = useState('')
  useEffect(() => {
    if (!input) { setOutput(''); return }
    crypto.subtle.digest(algo, new TextEncoder().encode(input))
      .then(buf => setOutput(Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')))
      .catch(() => setOutput('当前环境不支持该算法'))
  }, [input, algo])
  return (
    <ToolShell>
      <select className="tool-input" value={algo} onChange={e => setAlgo(e.target.value)}>
        {['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].map(a => <option key={a}>{a}</option>)}
      </select>
      <TextArea value={input} onChange={setInput} placeholder="输入文本..." />
      <Result value={output} />
      <ToolFooter value={output} onClear={() => { setInput(''); setOutput('') }} filename={`${algo.toLowerCase()}-hash.txt`} />
    </ToolShell>
  )
}

function decodeJwtPart(part: string) {
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.stringify(JSON.parse(decodeURIComponent(escape(atob(padded)))), null, 2)
}

export function JwtTool() {
  const [input, setInput] = useState('')
  const output = useMemo(() => {
    try {
      const [h, p] = input.trim().split('.')
      if (!h || !p) return ''
      const payload = JSON.parse(decodeJwtPart(p))
      const exp = typeof payload.exp === 'number' ? `\n过期时间：${new Date(payload.exp * 1000).toLocaleString()}` : ''
      const iat = typeof payload.iat === 'number' ? `\n签发时间：${new Date(payload.iat * 1000).toLocaleString()}` : ''
      return `Header\n${decodeJwtPart(h)}\n\nPayload\n${JSON.stringify(payload, null, 2)}${iat}${exp}\n\nSignature\n${input.trim().split('.')[2] ?? ''}`
    } catch { return 'JWT 解析失败' }
  }, [input])
  return (
    <ToolShell>
      <TextArea value={input} onChange={setInput} placeholder="粘贴 JWT..." />
      <Result value={output} />
      <ToolFooter value={output} onClear={() => setInput('')} filename="jwt-parse.txt" />
    </ToolShell>
  )
}

export function RegexTool() {
  const [pattern, setPattern] = useState('')
  const [flags, setFlags] = useState('g')
  const [text, setText] = useState('')
  const [replace, setReplace] = useState('')
  const output = useMemo(() => {
    try {
      const matchFlags = flags.includes('g') ? flags : `${flags}g`
      const re = new RegExp(pattern, matchFlags)
      const matches = Array.from(text.matchAll(re)).map((m, i) => `${i + 1}. ${m[0]}${m.length > 1 ? ` | 分组：${m.slice(1).join(', ')}` : ''}`)
      const replaced = replace ? `\n\n替换预览\n${text.replace(re, replace)}` : ''
      return (matches.join('\n') || '无匹配') + replaced
    } catch (e) { return `正则错误：${e instanceof Error ? e.message : String(e)}` }
  }, [pattern, flags, text, replace])
  return (
    <ToolShell>
      <div className="tool-row">
        <input className="tool-input" value={pattern} onChange={e => setPattern(e.target.value)} placeholder="正则表达式" />
        <input className="tool-input tool-input--short" value={flags} onChange={e => setFlags(e.target.value)} placeholder="flags" />
      </div>
      <input className="tool-input" value={replace} onChange={e => setReplace(e.target.value)} placeholder="替换内容，可选" />
      <TextArea value={text} onChange={setText} placeholder="测试文本..." />
      <Result value={output} />
      <ToolFooter value={output} onClear={() => { setPattern(''); setText(''); setReplace('') }} filename="regex-result.txt" />
    </ToolShell>
  )
}

function parseColor(input: string): [number, number, number] | null {
  const raw = input.trim()
  const rgbMatch = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (rgbMatch) return [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map(v => Math.max(0, Math.min(255, Number(v)))) as [number, number, number]
  const h = raw.replace(/^#/, '')
  if (!/^[\da-f]{3}$|^[\da-f]{6}$/i.test(h)) return null
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

export function ColorTool() {
  const [input, setInput] = useState('#86b9ff')
  const rgb = parseColor(input)
  const output = useMemo(() => {
    if (!rgb) return 'HEX 颜色无效'
    const [r, g, b] = rgb
    const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
    const rn = r / 255, gn = g / 255, bn = b / 255
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
    const l = (max + min) / 2
    const d = max - min
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    let h = 0
    if (d !== 0) h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
    h = Math.round(h * 60); if (h < 0) h += 360
    return `HEX：${hex}\nRGB：rgb(${r}, ${g}, ${b})\nRGBA：rgba(${r}, ${g}, ${b}, 1)\nHSL：hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)\nCSS 变量：--color: ${hex};`
  }, [rgb])
  return (
    <ToolShell>
      <div className="tool-row">
        <input className="tool-input" value={input} onChange={e => setInput(e.target.value)} placeholder="#86b9ff 或 rgb(134,185,255)" />
        <span className="tool-color-swatch" style={{ background: rgb ? `rgb(${rgb.join(',')})` : 'var(--surface-2)' }} />
      </div>
      <Result value={output} />
      <ToolFooter value={output} onClear={() => setInput('')} filename="color.txt" />
    </ToolShell>
  )
}

export function TextStatsTool() {
  const [text, setText] = useState('')
  const [output, setOutput] = useState('')
  const stats = useMemo(() => {
    const chars = text.length
    const charsNoSpace = text.replace(/\s/g, '').length
    const words = (text.trim().match(/\S+/g) ?? []).length
    const lines = text ? text.split(/\r\n|\r|\n/).length : 0
    const bytes = new TextEncoder().encode(text).length
    return `字符数：${chars}\n非空白字符：${charsNoSpace}\n单词数：${words}\n行数：${lines}\nUTF-8 字节：${bytes}`
  }, [text])
  const lines = () => text.split(/\r\n|\r|\n/)
  return (
    <ToolShell>
      <TextArea value={text} onChange={setText} placeholder="输入文本..." />
      <div className="tool-actions">
        <button onClick={() => setOutput(lines().map(s => s.trim()).join('\n'))}>去首尾空格</button>
        <button onClick={() => setOutput(lines().filter(Boolean).join('\n'))}>删除空行</button>
        <button onClick={() => setOutput(Array.from(new Set(lines())).join('\n'))}>行去重</button>
        <button onClick={() => setOutput([...lines()].sort((a, b) => a.localeCompare(b)).join('\n'))}>行排序</button>
      </div>
      <Result value={output || stats} />
      <ToolFooter value={output || stats} onClear={() => { setText(''); setOutput('') }} filename="text-result.txt" />
    </ToolShell>
  )
}

function randomChars(chars: string, len: number) {
  const bytes = new Uint32Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, n => chars[n % chars.length]).join('')
}

function shuffleText(text: string) {
  const arr = text.split('')
  const bytes = new Uint32Array(arr.length)
  crypto.getRandomValues(bytes)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function PasswordTool() {
  const [length, setLength] = useState(24)
  const [count, setCount] = useState(5)
  const [lower, setLower] = useState(true)
  const [upper, setUpper] = useState(true)
  const [digit, setDigit] = useState(true)
  const [symbol, setSymbol] = useState(true)
  const [avoidQuotes, setAvoidQuotes] = useState(false)
  const [avoidBrackets, setAvoidBrackets] = useState(false)
  const [excludeSimilar, setExcludeSimilar] = useState(true)
  const [requireEach, setRequireEach] = useState(true)
  const [customSymbols, setCustomSymbols] = useState('!@#$%^&*()-_=+[]{};:,.<>?')
  const [separator, setSeparator] = useState<'line' | 'comma' | 'space'>('line')
  const [output, setOutput] = useState('')
  const poolSize = useMemo(() => {
    const symbols = customSymbols
      .replace(avoidQuotes ? /['"`\\]/g : /$^/, '')
      .replace(avoidBrackets ? /[()[\]{}<>]/g : /$^/, '')
    const base = `${lower ? 'abcdefghijkmnopqrstuvwxyz' : ''}${upper ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : ''}${digit ? '23456789' : ''}${symbol ? symbols : ''}`
    return new Set(base.split('')).size
  }, [lower, upper, digit, symbol, customSymbols, avoidQuotes, avoidBrackets])
  const entropy = Math.round(Math.log2(Math.max(1, poolSize)) * Math.max(4, length))
  const strength = entropy >= 100 ? '强' : entropy >= 70 ? '中' : '弱'
  const generate = (mode: 'password' | 'token' | 'pin', opts?: { length?: number; count?: number; separator?: 'line' | 'comma' | 'space' }) => {
    const pools = {
      lower: excludeSimilar ? 'abcdefghijkmnopqrstuvwxyz' : 'abcdefghijklmnopqrstuvwxyz',
      upper: excludeSimilar ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      digit: excludeSimilar ? '23456789' : '0123456789',
      symbol: (customSymbols || '!@#$%^&*()-_=+[]{};:,.<>?')
        .replace(avoidQuotes ? /['"`\\]/g : /$^/, '')
        .replace(avoidBrackets ? /[()[\]{}<>]/g : /$^/, ''),
    }
    const selectedPools = [
      lower ? pools.lower : '',
      upper ? pools.upper : '',
      digit ? pools.digit : '',
      symbol ? pools.symbol : '',
    ].filter(Boolean)
    const chars = mode === 'token'
      ? `${pools.lower}${pools.upper}${pools.digit}`
      : mode === 'pin'
      ? pools.digit
      : selectedPools.join('')
    const safeChars = chars || pools.digit
    const safeLen = Math.max(4, Math.min(256, opts?.length ?? length))
    const safeCount = Math.max(1, Math.min(100, opts?.count ?? count))
    const outSep = opts?.separator ?? separator
    const list = Array.from({ length: safeCount }, () => {
      if (mode !== 'password' || !requireEach || selectedPools.length === 0) return randomChars(safeChars, safeLen)
      const required = selectedPools.map(pool => randomChars(pool, 1)).join('')
      return shuffleText((required + randomChars(safeChars, Math.max(0, safeLen - required.length))).slice(0, safeLen))
    })
    setOutput(list.join(outSep === 'comma' ? ', ' : outSep === 'space' ? ' ' : '\n'))
    toast.success(mode === 'pin' ? '已生成 PIN' : mode === 'token' ? '已生成 Token' : '已生成密码')
  }
  return (
    <ToolShell>
      <div className="password-panel">
        <div className="tool-grid-2 password-panel__checks">
        <label className="tool-check"><input type="checkbox" checked={lower} onChange={e => setLower(e.target.checked)} /> 小写</label>
        <label className="tool-check"><input type="checkbox" checked={upper} onChange={e => setUpper(e.target.checked)} /> 大写</label>
        <label className="tool-check"><input type="checkbox" checked={digit} onChange={e => setDigit(e.target.checked)} /> 数字</label>
        <label className="tool-check"><input type="checkbox" checked={symbol} onChange={e => setSymbol(e.target.checked)} /> 包含特殊符号</label>
        <label className="tool-check"><input type="checkbox" checked={!symbol} onChange={e => setSymbol(!e.target.checked)} /> 排除特殊符号</label>
        <label className="tool-check"><input type="checkbox" checked={avoidQuotes} onChange={e => setAvoidQuotes(e.target.checked)} disabled={!symbol} /> 排除引号反斜杠</label>
        <label className="tool-check"><input type="checkbox" checked={avoidBrackets} onChange={e => setAvoidBrackets(e.target.checked)} disabled={!symbol} /> 排除括号尖括号</label>
        <label className="tool-check"><input type="checkbox" checked={excludeSimilar} onChange={e => setExcludeSimilar(e.target.checked)} /> 排除易混淆</label>
        <label className="tool-check"><input type="checkbox" checked={requireEach} onChange={e => setRequireEach(e.target.checked)} /> 每类至少一个</label>
        <label className="tool-check tool-check--metric">强度：{strength} · {entropy} bits</label>
        <select className="tool-input" value={separator} onChange={e => setSeparator(e.target.value as 'line' | 'comma' | 'space')}>
          <option value="line">按行输出</option>
          <option value="comma">逗号分隔</option>
          <option value="space">空格分隔</option>
        </select>
        </div>
        <div className="tool-row">
          <label className="tool-field"><span>长度</span><input className="tool-input" type="number" min={4} max={256} value={length} onChange={e => setLength(Number(e.target.value))} /></label>
          <label className="tool-field"><span>数量</span><input className="tool-input" type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
        </div>
        <label className="tool-field"><span>特殊字符集合</span><input className="tool-input" value={customSymbols} onChange={e => setCustomSymbols(e.target.value)} disabled={!symbol} /></label>
        <div className="tool-actions">
        <button onClick={() => { setLength(16); setCount(5); setLower(true); setUpper(true); setDigit(true); setSymbol(true); generate('password', { length: 16, count: 5 }) }}>常用强密码</button>
        <button onClick={() => { setLength(32); setCount(5); setLower(true); setUpper(true); setDigit(true); setSymbol(false); generate('token', { length: 32, count: 5 }) }}>API Token</button>
        <button onClick={() => generate('password')}>生成密码</button>
        <button onClick={() => generate('token')}>生成 Token</button>
        <button onClick={() => { setLength(6); generate('pin') }}>生成 PIN</button>
        </div>
      </div>
      <Result value={output} />
      <ToolFooter value={output} onClear={() => setOutput('')} filename="passwords.txt" />
    </ToolShell>
  )
}

function wordsOf(input: string) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s
}

export function CaseTool() {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const convert = (mode: string) => {
    const ws = wordsOf(input)
    if (mode === 'upper') setOutput(input.toUpperCase())
    else if (mode === 'lower') setOutput(input.toLowerCase())
    else if (mode === 'camel') setOutput(ws.map((w, i) => i === 0 ? w.toLowerCase() : cap(w)).join(''))
    else if (mode === 'pascal') setOutput(ws.map(cap).join(''))
    else if (mode === 'snake') setOutput(ws.map(w => w.toLowerCase()).join('_'))
    else if (mode === 'kebab') setOutput(ws.map(w => w.toLowerCase()).join('-'))
    else if (mode === 'title') setOutput(ws.map(cap).join(' '))
    else setOutput(input)
  }
  return (
    <ToolShell>
      <TextArea value={input} onChange={setInput} placeholder="输入变量名、标题或任意文本..." />
      <div className="tool-actions">
        <button onClick={() => convert('upper')}>大写</button>
        <button onClick={() => convert('lower')}>小写</button>
        <button onClick={() => convert('camel')}>camelCase</button>
        <button onClick={() => convert('pascal')}>PascalCase</button>
        <button onClick={() => convert('snake')}>snake_case</button>
        <button onClick={() => convert('kebab')}>kebab-case</button>
        <button onClick={() => convert('title')}>Title Case</button>
      </div>
      <Result value={output} />
      <ToolFooter value={output || input} onClear={() => { setInput(''); setOutput('') }} filename="case-result.txt" />
    </ToolShell>
  )
}

export function DiffTool() {
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const diff = useMemo(() => {
    const a = left.split(/\r\n|\r|\n/)
    const b = right.split(/\r\n|\r|\n/)
    const max = Math.max(a.length, b.length)
    const rows: string[] = []
    for (let i = 0; i < max; i++) {
      if ((a[i] ?? '') === (b[i] ?? '')) rows.push(`  ${i + 1}  ${a[i] ?? ''}`)
      else {
        if (a[i] !== undefined) rows.push(`- ${i + 1}  ${a[i]}`)
        if (b[i] !== undefined) rows.push(`+ ${i + 1}  ${b[i]}`)
      }
    }
    return rows.join('\n')
  }, [left, right])
  return (
    <ToolShell>
      <div className="tool-split">
        <TextArea value={left} onChange={setLeft} placeholder="左侧文本..." />
        <TextArea value={right} onChange={setRight} placeholder="右侧文本..." />
      </div>
      <Result value={diff} />
      <ToolFooter value={diff} onClear={() => { setLeft(''); setRight('') }} filename="diff.txt" />
    </ToolShell>
  )
}

export function NumberTool() {
  const [input, setInput] = useState('255')
  const [base, setBase] = useState(10)

  const parseInteger = (raw: string, radix: number): bigint | null => {
    let s = raw.trim().replace(/_/g, '')
    if (!s) return null
    let sign = 1n
    if (s.startsWith('+') || s.startsWith('-')) {
      if (s[0] === '-') sign = -1n
      s = s.slice(1).trim()
    }
    if (!s) return null

    const prefixed = s.replace(/^(0x|0b|0o)/i, '')
    try {
      if (radix === 10) return sign * BigInt(s)
      if (radix === 2) {
        if (!/^[01]+$/i.test(prefixed)) return null
        return sign * BigInt(`0b${prefixed}`)
      }
      if (radix === 8) {
        if (!/^[0-7]+$/i.test(prefixed)) return null
        return sign * BigInt(`0o${prefixed}`)
      }
      if (radix === 16) {
        if (!/^[0-9a-f]+$/i.test(prefixed)) return null
        return sign * BigInt(`0x${prefixed}`)
      }
    } catch {
      return null
    }
    return null
  }

  const value = useMemo(() => {
    const n = parseInteger(input, base)
    if (n === null) return '数字无效'
    const hex = n.toString(16).toUpperCase()
    return `二进制：${n.toString(2)}\n八进制：${n.toString(8)}\n十进制：${n.toString(10)}\n十六进制：${hex}`
  }, [input, base])
  return (
    <ToolShell>
      <div className="tool-row">
        <input className="tool-input" value={input} onChange={e => setInput(e.target.value)} placeholder="输入数字" />
        <select className="tool-input tool-input--short" value={base} onChange={e => setBase(Number(e.target.value))}>
          <option value={2}>二进制</option>
          <option value={8}>八进制</option>
          <option value={10}>十进制</option>
          <option value={16}>十六进制</option>
        </select>
      </div>
      <Result value={value} />
      <ToolFooter value={value} onClear={() => setInput('')} filename="number-convert.txt" />
    </ToolShell>
  )
}
