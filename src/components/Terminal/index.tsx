import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Terminal as XTerm, type IBufferLine } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { TrzszFilter } from 'trzsz'
import '@xterm/xterm/css/xterm.css'
import MfaDialog, { type MfaRequest } from './MfaDialog'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAppStore } from '../../stores/appStore'
import { useCommandHistoryStore } from '../../stores/commandHistoryStore'
import { THEMES, ANSI_PALETTES } from '../../themes'
import { consumeAdopt, isDetaching, registerSerializer, unregisterSerializer, consumeAdoptSnapshot } from '../../utils/adopt'
import { commandsFromInputData, isRecordableShellCommand, stripShellPrompt } from '../../utils/terminalCommand'
import { addFrame, isRecording } from '../SshPanels/RecordingPanel'

// trzsz 文件传输触发串；仅当服务器输出含此串（或正在传输）时才走 trzsz 过滤器，普通输出直写终端
const TRZSZ_MARK = 'TRZSZ:TRANSFER:'
// latin1 解码：字节→字符一一对应，零损用于 ASCII 标记检测（不可用 utf-8，多字节会错位）
const LATIN1 = new TextDecoder('latin1')

// 日志级别着色：当输出中无 ANSI 转义码时，自动为常见日志格式注入颜色（loguru / logging / syslog 等）
const _E = '\x1b['
// 256 色固定灰：#767676（color 243），深/浅背景对比度均 ≥ 4.3:1，比 90m（brightBlack）更可靠
const _DIM = '\x1b[38;5;243m'
const LOG_COLOR_PATTERNS: [RegExp, string][] = [
  // 时间戳 → 固定中灰（不受主题 brightBlack 影响，深/浅主题均清晰可见）
  [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+/g, _DIM],
  // 模块路径（pkg.sub.mod:func:line）→ 同灰
  [/\b(?:[a-z_]\w*\.)+[a-z_]\w*:[a-z_]\w+:\d+\b/g, _DIM],
  // [key=value] 元数据括号（request_id / user_id 等 UUID）→ 同灰
  [/\[\w[\w_]*=[\w-]+(?:\s[\w_]+=[\w-]+)*\]/g, _DIM],
  // 请求/响应方向箭头
  [/→ \[请求\]/g,                _E + '36m'],
  [/← \[响应\]/g,                _E + '32m'],
  // HTTP 方法（GET/POST/PUT/DELETE 颜色各异，便于快速识别）
  [/\bmethod=GET\b/g,             _E + '36m'],
  [/\bmethod=POST\b/g,            _E + '1;32m'],
  [/\bmethod=(?:PUT|PATCH)\b/g,   _E + '33m'],
  [/\bmethod=DELETE\b/g,          _E + '1;31m'],
  // HTTP 状态码（2xx绿 3xx青 4xx黄 5xx红）
  [/\bstatus=2\d\d\b/g,           _E + '32m'],
  [/\bstatus=3\d\d\b/g,           _E + '36m'],
  [/\bstatus=4\d\d\b/g,           _E + '1;33m'],
  [/\bstatus=5\d\d\b/g,           _E + '1;31m'],
  // API 路径 → 蓝
  [/\bpath=\/\S*/g,               _E + '34m'],
  // 管道格式（loguru: timestamp | LEVEL    | logger | message）
  [/\|\s*CRITICAL\s*\|/g, _E + '1;35m'],
  [/\|\s*ERROR\s*\|/g,    _E + '1;31m'],
  [/\|\s*WARNING\s*\|/g,  _E + '1;33m'],
  [/\|\s*SUCCESS\s*\|/g,  _E + '1;32m'],
  [/\|\s*INFO\s*\|/g,     _E + '32m'],
  [/\|\s*DEBUG\s*\|/g,    _E + '36m'],
  [/\|\s*TRACE\s*\|/g,    _DIM],
  // 冒号格式（Python logging / structlog）
  [/\bCRITICAL:\s/g,      _E + '1;35m'],
  [/\bERROR:\s/g,         _E + '1;31m'],
  [/\bWARNING:\s/g,       _E + '1;33m'],
  [/\bINFO:\s/g,          _E + '32m'],
  [/\bDEBUG:\s/g,         _E + '36m'],
]
// ── 宽字符工具 ──
// 返回字符串在终端里占用的列数（汉字/全角占 2 列，ASCII 占 1 列）
function termDisplayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    w += (
      (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals / Kangxi
      (cp >= 0x3041 && cp <= 0x33FF) ||   // Hiragana / Katakana / CJK symbols
      (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs (最常见汉字区)
      (cp >= 0xA000 && cp <= 0xA4FF) ||   // Yi
      (cp >= 0xAC00 && cp <= 0xD7FF) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility
      (cp >= 0xFE10 && cp <= 0xFE6F) ||   // CJK Compatibility Forms
      (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth signs
      cp >= 0x1B000                        // Kana Supplement, Emoji, etc.
    ) ? 2 : 1
  }
  return w
}

// 将 translateToString 得到的字符串索引转换为实际列号
// (宽字符在 buffer 里占 2 列，translateToString 只输出 1 个字符，所以索引会偏移)
function strIdxToCol(line: IBufferLine, strIdx: number): number {
  // 快路径：行上没有任何宽字符时索引与列号相等
  let col = 0, chars = 0
  while (col < 2000) {
    const cell = line.getCell(col)
    if (!cell) break
    const w = cell.getWidth()
    if (w === 0) { col++; continue }   // 宽字符的"后半格"，跳过
    if (chars === strIdx) return col
    chars++
    col += w
  }
  return strIdx  // 安全兜底
}

function colorizeLog(bytes: Uint8Array): string | null {
  // 含 ESC 字节时说明已有 ANSI 码，直接跳过
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0x1b) return null }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  let changed = false
  for (const [re, color] of LOG_COLOR_PATTERNS) {
    const next = text.replace(re, m => `${color}${m}\x1b[0m`)
    if (next !== text) { text = next; changed = true }
  }
  return changed ? text : null
}

/** 序列化 xterm 当前画面（含滚屏）为纯文本，仅用稳定公开 API；用于标签撕离时把历史内容带到新窗口。 */
function serializeXtermBuffer(xterm: XTerm): string {
  try {
    const buf = xterm.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.length ? lines.join('\r\n') + '\r\n' : ''
  } catch { return '' }
}

function readCurrentShellCommand(xterm: XTerm): string {
  try {
    const buf = xterm.buffer.active
    let row = buf.baseY + buf.cursorY
    const parts: string[] = []
    while (row >= 0) {
      const line = buf.getLine(row)
      if (!line) break
      parts.unshift(line.translateToString(true))
      if (!line.isWrapped) break
      row--
    }
    return stripShellPrompt(parts.join(''))
  } catch {
    return ''
  }
}

function parsePromptCwd(line: string): string | null {
  const clean = line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
  if (!/[#$%]\s*$/.test(clean)) return null
  const beforePrompt = clean.replace(/[#$%]\s*$/, '').trimEnd()
  if (!beforePrompt) return null
  const candidates = [
    /(?:^|[:\s])(\/[^\s#$%]+)\s*$/u,
    /(?:^|[:\s])(~(?:\/[^\s#$%]*)?)\s*$/u,
  ]
  for (const re of candidates) {
    const m = re.exec(beforePrompt)
    if (!m) continue
    return m[1]
  }
  return null
}

function readPromptCwd(xterm: XTerm): string | null {
  try {
    const buf = xterm.buffer.active
    for (let row = buf.baseY + buf.cursorY; row >= Math.max(0, buf.baseY + buf.cursorY - 3); row--) {
      const line = buf.getLine(row)
      if (!line) continue
      const cwd = parsePromptCwd(line.translateToString(true))
      if (cwd) return cwd
    }
  } catch { /* ignore */ }
  return null
}

/** xterm 光标字符坐标 → 容器内像素坐标 */
function getCursorPx(xterm: XTerm, container: HTMLElement) {
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen) return null
  const cx    = xterm.buffer.active.cursorX
  const cy    = xterm.buffer.active.cursorY
  const charW = screen.offsetWidth  / Math.max(xterm.cols, 1)
  const charH = screen.offsetHeight / Math.max(xterm.rows, 1)
  const sr    = screen.getBoundingClientRect()
  const cr    = container.getBoundingClientRect()
  return { x: sr.left - cr.left + cx * charW, y: sr.top - cr.top + cy * charH, charW, charH }
}


interface Props {
  sessionId: string
  connectionId: string
  connType?: string
  active?: boolean
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (msg: string) => void
}

// SSH 自动重连尝试计数：跨组件重挂载保留（重连会重建 Terminal 组件）
const reconnectAttempts = new Map<string, number>()

// 终端铃声：visual=闪烁边框，sound=短促提示音
let bellAudioCtx: AudioContext | null = null
function playBell(mode: 'visual' | 'sound' | 'none', el: HTMLElement | null) {
  if (mode === 'none') return
  if (mode === 'visual') {
    if (!el) return
    el.classList.remove('term-bell-flash')
    void el.offsetWidth // 强制 reflow 重启动画
    el.classList.add('term-bell-flash')
    return
  }
  try {
    bellAudioCtx ??= new AudioContext()
    const osc = bellAudioCtx.createOscillator()
    const gain = bellAudioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.06, bellAudioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, bellAudioCtx.currentTime + 0.15)
    osc.connect(gain).connect(bellAudioCtx.destination)
    osc.start()
    osc.stop(bellAudioCtx.currentTime + 0.16)
  } catch { /* 音频不可用时静默 */ }
}

export default function Terminal({ sessionId, connectionId, connType, active = false, onConnected, onDisconnected, onError }: Props) {
  const containerRef    = useRef<HTMLDivElement>(null)
  const xtermRef        = useRef<XTerm | null>(null)
  const fitRef          = useRef<FitAddon | null>(null)
  const trzszFilterRef  = useRef<TrzszFilter | null>(null)
  const inputBufRef     = useRef('')
  const mountedRef      = useRef(true)
  const hasNavigatedRef = useRef(false)
  const lastCwdRef      = useRef('')

  const [disconnected, setDisconnected] = useState(false)
  const disconnectedRef                 = useRef(false)
  disconnectedRef.current = disconnected

  type SshErrorType = 'auth' | 'network' | 'proto' | 'dropped' | 'generic' | 'tofu'
  const [sshError, setSshError]   = useState<{ type: SshErrorType; detail: string } | null>(null)
  const sshErrorRef               = useRef<SshErrorType | null>(null)
  const [clearingKey, setClearingKey] = useState(false)
  // 记录是否已经成功连接过一次，防止旧会话断开事件误触发新终端的断开状态
  const hasConnectedRef = useRef(false)
  // 当前会话 run_id：过滤旧会话的迟到事件
  const runIdRef = useRef('')
  // MFA 交互式认证请求（keyboard-interactive 提示）
  const [mfaReq, setMfaReq] = useState<MfaRequest | null>(null)

  function parseSshError(msg: string): SshErrorType {
    if (msg.includes('密钥已变更')) return 'tofu'
    // 用户主动取消 MFA：按普通断开处理，给轻量提示而非错误大卡片
    if (msg.includes('已取消多因素认证')) return 'dropped'
    if (msg.includes('认证被拒绝') || msg.includes('密钥认证失败') || msg.includes('Authentication')) return 'auth'
    if (msg.includes('TCP 连接失败') || msg.includes('连接失败') || msg.includes('Connection refused') || msg.includes('timed out')) return 'network'
    if (msg.includes('SSH 握手失败') || msg.includes('握手')) return 'proto'
    return 'generic'
  }
  const [searchOpen, setSearchOpen]     = useState(false)
  const activeRef                       = useRef(active)
  activeRef.current = active
  const [searchVal, setSearchVal]       = useState('')
  const [searchMatchCnt, setSearchMatchCnt] = useState(0)
  const searchMatchesRef = useRef<Array<{row: number, col: number}>>([])
  const searchIdxRef     = useRef(0)
  const hlMatchesRef   = useRef<Array<{row: number, col: number}>>([])  // 高亮匹配结果
  const hlColWidthRef  = useRef(0)                                       // term 列宽（宽字符）
  const hlOverlayRef   = useRef<HTMLDivElement | null>(null)             // 叠加层 div
  const hlTermRef      = useRef('')                                      // 当前高亮词
  // stable ref 供 xterm 事件回调内调用最新版函数（避免 stale closure）
  const termSearchRef    = useRef<((term: string, backward: boolean, silent: boolean) => void) | null>(null)
  const termHlRef        = useRef<((matches: Array<{row: number, col: number}>, term: string) => void) | null>(null)
  const termClearHlRef   = useRef<(() => void) | null>(null)
  const searchInputRef                  = useRef<HTMLInputElement>(null)
  const [inputBuf, setInputBuf]         = useState('')
  const [dropPos, setDropPos]           = useState<{ x: number; y: number } | null>(null)
  const [activeIdx, setActiveIdx]       = useState(0)
  const [pathCmds, setPathCmds]         = useState<string[]>([])
  const outerRef                        = useRef<HTMLDivElement>(null)

  const settings       = useSettingsStore()
  // 细粒度订阅：避免 appStore 任意变化都触发终端重渲染
  const registerTermCallbacks   = useAppStore((s) => s.registerTermCallbacks)
  const unregisterTermCallbacks = useAppStore((s) => s.unregisterTermCallbacks)
  const setTermCwd              = useAppStore((s) => s.setTermCwd)
  const openEditConn            = useAppStore((s) => s.openEditConn)
  const connections             = useAppStore((s) => s.connections)
  const allHistory     = useCommandHistoryStore((s) => s.commands)
  const addCommandRaw  = useCommandHistoryStore((s) => s.addCommand)
  // 历史命令严格按连接隔离
  const commandHistory = useMemo(
    () => allHistory.filter((c) => c.connId === connectionId),
    [allHistory, connectionId]
  )
  const addCommand = useCallback(
    (cmd: string) => {
      const trimmed = cmd.trim()
      if (isRecordableShellCommand(trimmed)) addCommandRaw(trimmed, connectionId)
    },
    [addCommandRaw, connectionId]
  )

  const updatePromptCwd = useCallback((term: XTerm) => {
    const cwd = readPromptCwd(term)
    if (!cwd || cwd === lastCwdRef.current) return
    lastCwdRef.current = cwd
    setTermCwd(sessionId, cwd)
  }, [sessionId, setTermCwd])

  const isLocal = connType === 'local'
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  // ── 高亮所有匹配（DOM overlay，完全绕过 xterm registerDecoration 的时序问题）──
  const clearHighlights = useCallback(() => {
    hlMatchesRef.current  = []
    hlColWidthRef.current = 0
    hlTermRef.current     = ''
    if (hlOverlayRef.current) hlOverlayRef.current.innerHTML = ''
  }, [])

  // 根据当前 viewport 位置把 matches 渲染成 overlay 子 div
  const renderOverlay = useCallback(() => {
    const xterm   = xtermRef.current
    const overlay = hlOverlayRef.current
    if (!xterm || !overlay || !overlay.parentElement) return
    const matches  = hlMatchesRef.current
    const colWidth = hlColWidthRef.current
    overlay.innerHTML = ''
    if (!matches.length || !colWidth) return
    const screen = overlay.parentElement as HTMLElement
    const charW  = screen.offsetWidth  / Math.max(xterm.cols, 1)
    const charH  = screen.offsetHeight / Math.max(xterm.rows, 1)
    const vpY    = xterm.buffer.active.viewportY
    const rows   = xterm.rows
    const frag   = document.createDocumentFragment()
    for (const m of matches) {
      const rowInView = m.row - vpY
      if (rowInView < 0 || rowInView >= rows) continue
      const div = document.createElement('div')
      div.style.cssText = (
        `position:absolute;pointer-events:none;` +
        `top:${Math.round(rowInView * charH)}px;` +
        `left:${Math.round(m.col * charW)}px;` +
        `width:${Math.round(colWidth * charW)}px;` +
        `height:${Math.round(charH)}px;` +
        `background-color:rgba(255,165,0,0.45);border-radius:2px;`
      )
      frag.appendChild(div)
    }
    overlay.appendChild(frag)
  }, [])

  const applyHighlights = useCallback((matches: Array<{row: number, col: number}>, term: string) => {
    clearHighlights()
    if (!matches.length || !term) return
    hlMatchesRef.current  = matches
    hlColWidthRef.current = termDisplayWidth(term)
    hlTermRef.current     = term
    renderOverlay()
  }, [clearHighlights, renderOverlay])

  // ── 自定义搜索（直接读 xterm buffer，不依赖 SearchAddon）──
  // silent=true：双击导航时不更新 searchMatchCnt（避免无搜索栏状态下计数跳动）
  const customSearch = useCallback((term: string, backward = false, silent = false) => {
    const xterm = xtermRef.current
    if (!xterm || !term.trim()) {
      xterm?.clearSelection()
      searchMatchesRef.current = []
      if (!silent) setSearchMatchCnt(0)
      return
    }
    const buf      = xterm.buffer.active
    const termLow  = term.toLowerCase()
    const colWidth = termDisplayWidth(term)   // 宽字符：列宽 ≠ 字符数
    const matches: Array<{row: number, col: number}> = []
    const total    = buf.baseY + xterm.rows
    for (let row = 0; row < total; row++) {
      const line = buf.getLine(row)
      if (!line) continue
      const text = line.translateToString(true)
      let off = 0
      while (off < text.length) {
        const idx = text.toLowerCase().indexOf(termLow, off)
        if (idx < 0) break
        matches.push({ row, col: strIdxToCol(line, idx) })   // 字符索引 → 列号
        off = idx + 1
      }
    }
    if (!silent) {
      searchMatchesRef.current = matches
      setSearchMatchCnt(matches.length)
    }
    if (matches.length === 0) { xterm.clearSelection(); return }
    // 从当前选区位置决定下一个匹配
    const sel = xterm.getSelectionPosition()
    let newIdx = 0
    if (sel) {
      const pRow = sel.start.y, pCol = sel.start.x
      if (backward) {
        let found = -1
        for (let i = matches.length - 1; i >= 0; i--) {
          const m = matches[i]
          if (m.row < pRow || (m.row === pRow && m.col < pCol)) { found = i; break }
        }
        newIdx = found >= 0 ? found : matches.length - 1
      } else {
        let found = -1
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i]
          if (m.row > pRow || (m.row === pRow && m.col > pCol)) { found = i; break }
        }
        newIdx = found >= 0 ? found : 0
      }
    } else {
      // 无选区时：找离当前视口中心最近的匹配
      const mid = buf.viewportY + Math.floor(xterm.rows / 2)
      let best = 0, bestD = Infinity
      for (let i = 0; i < matches.length; i++) {
        const d = Math.abs(matches[i].row - mid)
        if (d < bestD) { bestD = d; best = i }
      }
      newIdx = best
    }
    if (!silent) searchIdxRef.current = newIdx
    const m = matches[newIdx]
    xterm.select(m.col, m.row, colWidth)   // 传列宽，非字符数
    // 如果匹配不在当前视口，滚到中心位置
    const vpY = buf.viewportY
    if (m.row < vpY || m.row >= vpY + xterm.rows) {
      xterm.scrollLines(m.row - vpY - Math.floor(xterm.rows / 2))
    }
    // 高亮所有匹配（不在 silent 路径里，silent=双击导航由外层自己调用 applyHighlights）
    if (!silent) applyHighlights(matches, term)
  }, [applyHighlights])

  // 保持 ref 指向最新版函数（供 xterm 事件回调内使用，避免 stale closure）
  useEffect(() => {
    termSearchRef.current  = customSearch
    termHlRef.current      = applyHighlights
    termClearHlRef.current = clearHighlights
  }, [customSearch, applyHighlights, clearHighlights])

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string[]>('list_path_commands').then((cmds) => {
        if (mountedRef.current) setPathCmds(cmds)
      }).catch(() => {})
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getTheme = useCallback(() => {
    const themeDef = THEMES[settings.resolvedTheme] ?? THEMES.tokyoNight
    const base = themeDef.xterm
    // 合并 ANSI 调色板覆盖（'auto' = 跟随界面主题，其余覆盖 16 个 ANSI 颜色）
    const palette = settings.termColorPalette && settings.termColorPalette !== 'auto'
      ? ANSI_PALETTES.find(p => p.key === settings.termColorPalette)
      : null
    const merged = palette ? { ...base, ...palette.colors } : base
    // 活跃选区：半透明蓝让文字可读
    const selectionBackground = themeDef.mode === 'light'
      ? 'rgba(80, 130, 240, 0.22)'
      : 'rgba(100, 145, 255, 0.32)'
    // 非活跃选区（搜索框有 focus 时）：高不透明度橙黄，确保搜索匹配非常明显
    const selectionInactiveBackground = themeDef.mode === 'light'
      ? 'rgba(255,140,0,0.65)' : 'rgba(255,200,0,0.80)'
    return { ...merged, selectionBackground, selectionInactiveBackground }
  }, [settings.resolvedTheme, settings.termColorPalette])

  const suggestions = useMemo(() => {
    const q = inputBuf.trim()
    if (q.length < 1 || q.includes(' ')) return []
    const histSet     = new Set<string>()
    const histMatches = commandHistory
      .filter((e) => { const w = e.command.split(' ')[0]; return w.startsWith(q) && w !== q })
      .map((e) => { const w = e.command.split(' ')[0]; histSet.add(w); return { cmd: w, fromHistory: true } })
      .filter((item, idx, arr) => arr.findIndex(a => a.cmd === item.cmd) === idx)
    const pathMatches = pathCmds
      .filter((c) => c.startsWith(q) && c !== q && !histSet.has(c))
      .slice(0, 8 - histMatches.length)
      .map((c) => ({ cmd: c, fromHistory: false }))
    return [...histMatches, ...pathMatches].slice(0, 10)
  }, [inputBuf, commandHistory, pathCmds])

  const suggestionsRef = useRef(suggestions)
  const activeIdxRef   = useRef(activeIdx)
  suggestionsRef.current = suggestions
  activeIdxRef.current   = activeIdx
  useEffect(() => { setActiveIdx(0); hasNavigatedRef.current = false }, [suggestions.length])

  // 补全浮窗坐标（使用 fixed 屏幕坐标，避免被 overflow:hidden 裁剪）
  useEffect(() => {
    const xterm     = xtermRef.current
    const container = containerRef.current
    if (!xterm || !container || inputBuf.length === 0) { setDropPos(null); return }
    const pos = getCursorPx(xterm, container)
    if (!pos) return
    const cr       = container.getBoundingClientRect()
    const screenX  = cr.left + pos.x
    const screenY  = cr.top  + pos.y
    const estH     = Math.min(suggestions.length, 8) * 30 + 40  // 预估高度
    const below    = screenY + pos.charH
    const y        = below + estH > window.innerHeight - 16 ? Math.max(8, screenY - estH) : below
    setDropPos({ x: Math.min(screenX, window.innerWidth - 264), y })
  }, [inputBuf, suggestions.length])


  const sendToTerm = useCallback((text: string) => {
    if (!isTauri || !text) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      const bytes = Array.from(new TextEncoder().encode(text))
      invoke(isLocal ? 'write_to_pty' : 'write_to_ssh', { id: sessionId, data: bytes }).catch(() => {})
    })
  }, [sessionId, isLocal, isTauri])
  const sendRef = useRef(sendToTerm)
  sendRef.current = sendToTerm

  const acceptCompletion = useCallback((fullCmd: string, execute = false) => {
    const rest = fullCmd.slice(inputBufRef.current.length)
    inputBufRef.current = execute ? '' : fullCmd
    setInputBuf(execute ? '' : fullCmd)
    setDropPos(null)
    hasNavigatedRef.current = false
    sendRef.current(rest + (execute ? '\r' : ''))
    if (execute) addCommand(fullCmd)
  }, [addCommand])
  const acceptRef = useRef(acceptCompletion)
  acceptRef.current = acceptCompletion

  const disconnect = useCallback(() => {
    if (!isTauri || !isLocal) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('close_pty', { id: sessionId }).catch(() => {})
    })
  }, [sessionId, isLocal, isTauri])
  const disconnectRef = useRef(disconnect)
  disconnectRef.current = disconnect

  const reconnect = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm || !isLocal) return
    setDisconnected(false)
    inputBufRef.current = ''
    setInputBuf('')
    setDropPos(null)
    hasNavigatedRef.current = false
    xterm.writeln('\r\n\x1b[90m[重新连接中...]\x1b[0m')
    const { cols, rows } = xterm
    const conn = useAppStore.getState().connections.find((c) => c.id === connectionId)
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('spawn_local_shell', {
        id: sessionId, shell: conn?.host ?? '', cols, rows, cwd: conn?.database ?? null, initCmd: null,
      }).catch((e: unknown) => {
        if (!mountedRef.current) return
        xterm.writeln(`\r\n\x1b[31m[重连失败] ${e}\x1b[0m`)
        setDisconnected(true)
      })
    })
  }, [sessionId, isLocal])
  const reconnectRef = useRef(reconnect)
  reconnectRef.current = reconnect

  // 应答 MFA 提示：answers 为 null 表示取消认证
  const respondMfa = useCallback((answers: string[] | null) => {
    setMfaReq((prev) => {
      if (prev && isTauri) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('respond_ssh_mfa', { requestId: prev.requestId, answers }).catch(() => {})
        })
      }
      return null
    })
  }, [isTauri])

  const doReconnectSsh = useCallback(() => {
    const conn = connections.find(c => c.id === connectionId)
    if (!isTauri || !conn) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('disconnect_ssh', { id: sessionId }).catch(() => {}).finally(() => {
        const store = useAppStore.getState()
        const tab = store.tabs.find(t => t.id === sessionId)
        if (!tab) return
        store.closeTab(tab.id)
        setTimeout(() => {
          store.openTab({ id: tab.id, connectionId, title: conn.name, type: 'terminal' })
          store.setTermDisconnected(sessionId, false)
        }, 80)
      })
    })
  }, [sessionId, connectionId, connections, isTauri])
  const doReconnectSshRef = useRef(doReconnectSsh)
  doReconnectSshRef.current = doReconnectSsh

  // 向 appStore 注册断开/重连回调，供 TabBar 调用
  useEffect(() => {
    if (!isLocal) return
    registerTermCallbacks(sessionId, {
      disconnect: () => disconnectRef.current?.(),
      reconnect:  () => reconnectRef.current(),
    })
    return () => unregisterTermCallbacks(sessionId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isLocal])

  // 连接配置被更新时（用户编辑保存后），若当前处于错误断开状态则自动重连
  const connUpdatedAt = connections.find(c => c.id === connectionId)?.updatedAt
  const prevUpdatedAtRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const prev = prevUpdatedAtRef.current
    prevUpdatedAtRef.current = connUpdatedAt
    if (prev === undefined || connUpdatedAt === prev) return
    // 配置有更新 + 当前有可重试的错误 → 自动重连
    if (sshError && sshError.type !== 'dropped') {
      setSshError(null)
      sshErrorRef.current = null
      doReconnectSsh()
    }
  }, [connUpdatedAt])

  const clearInput = useCallback(() => {
    inputBufRef.current = ''
    setInputBuf('')
    setDropPos(null)
    hasNavigatedRef.current = false
  }, [])
  const clearInputRef = useRef(clearInput)
  clearInputRef.current = clearInput

  useEffect(() => {
    mountedRef.current = true
    if (!containerRef.current) return

    const xterm = new XTerm({
      theme:         getTheme(),
      fontFamily:    `${settings.fontFamily}, monospace`,
      fontSize:      settings.fontSize,
      lineHeight:    settings.lineHeight ?? 1.3,
      letterSpacing: settings.letterSpacing ?? 0,
      cursorStyle:   settings.cursorStyle,
      cursorBlink:   settings.cursorBlink,
      scrollback:    settings.scrollback,
      convertEol:    false,
    })
    const fit    = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new WebLinksAddon())
    // Unicode11：宽字符宽度修正；个别环境插件不兼容时静默跳过，不阻断终端
    try {
      const unicode11 = new Unicode11Addon()
      xterm.loadAddon(unicode11)
      xterm.unicode.activeVersion = '11'
    } catch { /* 退回默认 unicode 处理 */ }
    xterm.open(containerRef.current)
    // 注：不启用 WebglAddon——其字形纹理图集在 WKWebView 下不能正确使用自定义/Web 字体，
    // 会回退成通用 monospace，无视用户设置的字体。改用 xterm 默认 DOM 渲染器以正确套用字体。
    fit.fit()
    xtermRef.current = xterm
    fitRef.current   = fit

    // ── 高亮叠加层：直接在 .xterm-screen 上插入绝对定位 div，绕过 registerDecoration 的时序问题 ──
    const screen = containerRef.current.querySelector('.xterm-screen') as HTMLElement | null
    if (screen) {
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:hidden;'
      screen.appendChild(overlay)
      hlOverlayRef.current = overlay
    }
    // 每次视口重渲染（滚动/新数据/resize）后刷新叠加层位置
    xterm.onRender(() => { renderOverlay() })
    // 字体异步加载：@fontsource 的 @font-face 可能在 open() 后才就绪，等字体加载完强制刷新
    document.fonts.ready.then(() => {
      if (!mountedRef.current) return
      const t = xtermRef.current
      if (!t) return
      t.options.fontFamily = `${settings.fontFamily}, monospace`
      fitRef.current?.fit()
      t.refresh(0, (t.rows ?? 0) - 1)
    })

    // trzsz/sz/rz 内联传输过滤器：拦截 PTY 流中的文件传输协议
    // writeToTerminal：把非协议内容写到 xterm；sendToServer：把用户键盘/协议数据发回后端
    // 初始化失败时降级为「无内联传输的普通终端」，绝不让终端无法打开
    try {
      const trzszFilter = new TrzszFilter({
        writeToTerminal: (data) => {
          if (data instanceof Uint8Array) xterm.write(data)
          else if (data instanceof ArrayBuffer) xterm.write(new Uint8Array(data))
          else if (typeof data === 'string') xterm.write(data)
          // Blob 等其它类型直接忽略（trzsz 浏览器模式下不会用到）
        },
        sendToServer: (data: string | Uint8Array) => {
          if (typeof data === 'string') data = new TextEncoder().encode(data)
          if (!isTauri) return
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke(localConn ? 'write_to_pty' : 'write_to_ssh', {
              id: sessionId, data: Array.from(data as Uint8Array)
            }).catch(() => {})
          })
        },
        terminalColumns: xterm.cols,
        isWindowsShell: false,
      })
      trzszFilterRef.current = trzszFilter
      // 终端宽度变化时同步通知过滤器（影响进度条排版）
      xterm.onResize(({ cols }) => trzszFilter.setTerminalColumns(cols))
    } catch (e) {
      trzszFilterRef.current = null
      console.warn('[Terminal] trzsz 初始化失败，已降级为普通终端', e)
    }

    // 服务器输出分发：仅当「正在传输文件」或本段出现 trzsz 触发串时才交给 trzsz，否则直接写终端。
    // 原先每段输出都过 trzsz.processServerOutput——它对每段排 setTimeout 扫描、且一旦误判进入传输态便
    // 吞掉所有键盘输入、把输出改投传输通道，造成 vim 等全屏应用「进来键盘鼠标失效、画面冻住」。
    // 触发串可能跨分片，故保留上段尾部 (markLen-1 字节) 与本段拼接检测。
    let trzszTail = ''
    let cwdRaf = 0
    const scheduleCwdUpdate = () => {
      cancelAnimationFrame(cwdRaf)
      cwdRaf = requestAnimationFrame(() => {
        const t = xtermRef.current
        if (t) updatePromptCwd(t)
      })
    }
    const feedServerOutput = (bytes: Uint8Array) => {
      if (isRecording(sessionId)) {
        addFrame(sessionId, LATIN1.decode(bytes))
      }
      const f = trzszFilterRef.current
      if (!f) {
        const c = colorizeLog(bytes)
        xterm.write(c ?? bytes)
        scheduleCwdUpdate()
        return
      }
      if (f.isTransferringFiles()) { f.processServerOutput(bytes); return }
      const text = LATIN1.decode(bytes)
      if ((trzszTail + text).includes(TRZSZ_MARK)) {
        trzszTail = ''
        f.processServerOutput(bytes)
      } else {
        const c = colorizeLog(bytes); xterm.write(c ?? bytes)
        trzszTail = text.length >= TRZSZ_MARK.length ? text.slice(-(TRZSZ_MARK.length - 1)) : (trzszTail + text).slice(-(TRZSZ_MARK.length - 1))
      }
      scheduleCwdUpdate()
    }

    // 撕离支持：登记「序列化当前画面」闭包（仅用稳定公开 buffer API，纯文本含滚屏），供新窗口还原
    registerSerializer(sessionId, () => serializeXtermBuffer(xterm))
    // 选中即复制（按设置实时读取）
    let hlTimer = 0
    let hlBusy  = false
    xterm.onSelectionChange(() => {
      // 选中即复制
      if (useSettingsStore.getState().copyOnSelect) {
        const s = xterm.getSelection()
        if (s) navigator.clipboard.writeText(s).catch(() => {})
      }
      // IDE 风格：双击选词后高亮 buffer 中所有同词（不跳转，搜索栏才跳转）
      if (searchOpenRef.current || hlBusy) return
      clearTimeout(hlTimer)
      hlTimer = window.setTimeout(() => {
        const sel = xterm.getSelection().trim()
        // 清空选区或选了多词：清除高亮
        if (!sel || /[\s\r\n]/.test(sel) || sel.length < 2 || sel.length > 80) {
          termClearHlRef.current?.(); return
        }
        hlBusy = true
        // 扫描整个 buffer，找所有匹配，生成 decoration 高亮（不移动选区）
        const buf     = xterm.buffer.active
        const selLow  = sel.toLowerCase()
        const total   = buf.baseY + xterm.rows
        const matches: Array<{row: number, col: number}> = []
        for (let row = 0; row < total; row++) {
          const line = buf.getLine(row); if (!line) continue
          const text = line.translateToString(true)
          let off = 0
          while (off < text.length) {
            const idx = text.toLowerCase().indexOf(selLow, off)
            if (idx < 0) break
            matches.push({ row, col: strIdxToCol(line, idx) }); off = idx + 1
          }
        }
        termHlRef.current?.(matches, sel)
        requestAnimationFrame(() => { hlBusy = false })
      }, 120) as unknown as number
    })

    // 响铃：按设置中心的模式处理（实时读取，无需重建终端）
    xterm.onBell(() => {
      playBell(useSettingsStore.getState().bellMode, containerRef.current)
    })

    const isMac = navigator.platform.toUpperCase().includes('MAC')
    xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true
      const mod = isMac ? e.metaKey : e.ctrlKey

      // ⌘K / Ctrl+K：清屏
      if (mod && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
        xterm.clear()
        return false
      }
      // ⌘F / Ctrl+F：切换搜索栏
      if (mod && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
        setSearchOpen(open => {
          if (open) {
            setSearchVal(''); setSearchMatchCnt(0)
            clearHighlights(); xterm.clearSelection(); xterm.focus()
            return false
          }
          setTimeout(() => searchInputRef.current?.focus(), 50)
          return true
        })
        return false
      }
      // ⌘C / Ctrl+C：有选中内容时复制到剪贴板，否则放行（发 ^C 中断进程）
      if (mod && (e.key === 'c' || e.key === 'C') && !e.shiftKey && !e.altKey) {
        const sel = xterm.getSelection()
        if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); return false }
        return true
      }
      // PageUp / PageDown：翻阅终端历史（向上/向下翻页）。
      // 全屏应用（vim/less/tmux，alternate buffer）放行给应用本身处理，普通 shell 下滚动视口。
      if ((e.key === 'PageUp' || e.key === 'PageDown') && !mod && !e.altKey && !e.shiftKey) {
        if (xterm.buffer.active.type === 'alternate') return true
        xterm.scrollPages(e.key === 'PageUp' ? -1 : 1)
        return false
      }
      // ⌘V / Ctrl+V：放行给 xterm 原生 paste 事件处理，避免双重粘贴
      return true
    })

    // 底部呼吸空间：仅当 shell 模式 + 已滚到底 + 光标在屏幕底部几行时，整体上移留出空间；
    // 翻阅历史 / vim 等全屏应用时还原全屏。不改终端行数、不触发 PTY resize。
    const BOTTOM_PAD = 56
    let shiftRaf = 0
    const updateShift = () => {
      cancelAnimationFrame(shiftRaf)
      shiftRaf = requestAnimationFrame(() => {
        const el = containerRef.current
        const x  = xtermRef.current
        if (!el || !x) return
        const buf = x.buffer.active
        const pinned = buf.type === 'normal'
          && buf.viewportY >= buf.baseY
          && buf.cursorY >= x.rows - 4
        el.style.transform = pinned ? `translateY(-${BOTTOM_PAD}px)` : 'translateY(0)'
      })
    }
    xterm.onScroll(updateShift)
    xterm.onWriteParsed(updateShift)
    xterm.onResize(updateShift)
    xterm.buffer.onBufferChange(updateShift)

    updateShift()

    const localConn = connType === 'local'

    xterm.onData((data) => {
      // 断联状态下按回车触发重连
      if (disconnectedRef.current && localConn && data === '\r') {
        reconnectRef.current()
        return
      }
      // 全屏应用（vim / less / tmux 等 alternate buffer）：禁用 shell 命令补全跟踪，直接转发输入。
      // 否则在 vim 里逐键打字会被当成 shell 命令：每键 setInputBuf 触发重渲染 + 补全浮窗 getBoundingClientRect
      // 强制同步重排，叠加后造成「进入编辑卡死」。
      const xa = xtermRef.current
      if (xa && xa.buffer.active.type === 'alternate') {
        if (inputBufRef.current) { inputBufRef.current = ''; setInputBuf('') }
        const out = data === '\r' && useSettingsStore.getState().lineEnding === 'CRLF' ? '\r\n' : data
        // 全屏应用（vim/less/tmux）里绝不会触发 trzsz 文件传输（那是 shell 提示符下的操作）。
        // 而 trzsz.processTerminalInput 会逐键拦截/缓冲，曾导致 vim 输入失灵（dev 下 trzsz 初始化
        // 失败降级而正常，打包下 trzsz 生效就吞键）。除非正在传输文件，否则一律直发、绕过 trzsz。
        const transferring = trzszFilterRef.current?.isTransferringFiles() ?? false
        if (transferring && trzszFilterRef.current) trzszFilterRef.current.processTerminalInput(out)
        else if (isTauri) {
          const bytes = Array.from(new TextEncoder().encode(out))
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke(localConn ? 'write_to_pty' : 'write_to_ssh', { id: sessionId, data: bytes })
              .catch(() => {
                if (!mountedRef.current || disconnectedRef.current) return
                setDisconnected(true)
                useAppStore.getState().setTermDisconnected(sessionId, true)
              })
          })
        }
        return
      }
      const suggs      = suggestionsRef.current
      const hasDropdown = suggs.length > 0

      // ↑↓ 补全浮窗导航
      if (data === '\x1b[A') {
        if (hasDropdown) { hasNavigatedRef.current = true; setActiveIdx(i => Math.max(0, i - 1)); return }
        clearInputRef.current()
      }
      if (data === '\x1b[B') {
        if (hasDropdown) { hasNavigatedRef.current = true; setActiveIdx(i => Math.min(suggs.length - 1, i + 1)); return }
        clearInputRef.current()
      }
      // 光标移动键清空追踪
      if (data === '\x1b[C' || data === '\x1b[D' || data === '\x1b[H' || data === '\x1b[F' ||
          data === '\x01' || data === '\x05') {
        clearInputRef.current()
      }
      if (data === '\x03' || data === '\x15' || data === '\x0b') {
        clearInputRef.current()
      }

      // Tab：接受补全（填入不执行）
      if (data === '\t' && hasDropdown) {
        acceptRef.current(suggs[activeIdxRef.current]?.cmd ?? suggs[0].cmd, false)
        return
      }
      // 回车：只有主动导航后才执行补全项，否则执行原始输入
      if (data === '\r') {
        updatePromptCwd(xterm)
        if (hasDropdown && hasNavigatedRef.current) {
          acceptRef.current(suggs[activeIdxRef.current]?.cmd ?? suggs[0].cmd, true)
          return
        }
        const cmd = readCurrentShellCommand(xterm)
        if (cmd.length > 1) addCommand(cmd)
        clearInputRef.current()
      } else {
        for (const cmd of commandsFromInputData(data)) addCommand(cmd)
      }
      if (data === '\x1b') clearInputRef.current()

      // 发给 PTY/SSH（经 trzsz 过滤器拦截文件传输协议）
      // 行结束符设置为 CRLF 时，回车发送 \r\n
      const outData = data === '\r' && useSettingsStore.getState().lineEnding === 'CRLF' ? '\r\n' : data
      const transferring = trzszFilterRef.current?.isTransferringFiles() ?? false
      if (transferring && trzszFilterRef.current) {
        trzszFilterRef.current.processTerminalInput(outData)
      } else if (isTauri) {
        const bytes = Array.from(new TextEncoder().encode(outData))
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke(localConn ? 'write_to_pty' : 'write_to_ssh', { id: sessionId, data: bytes })
            .catch(() => {
              if (!mountedRef.current || disconnectedRef.current) return
              setDisconnected(true)
              useAppStore.getState().setTermDisconnected(sessionId, true)
            })
        })
      }

      // 追踪输入缓冲仅用于补全；命令历史在回车时从 xterm 当前行读取，避免记录半截 word。
      if (data === '\x7f') {
        inputBufRef.current = inputBufRef.current.slice(0, -1)
        setInputBuf(inputBufRef.current)
      } else if (data.charCodeAt(0) >= 32 && !data.includes('\r') && !data.includes('\n') && !data.includes('\x1b')) {
        hasNavigatedRef.current = false
        inputBufRef.current += data
        setInputBuf(inputBufRef.current)
      }
    })

    let unlisten: (() => void)[] = []

    // 标签撕离接管：本窗口因撕离而开，且该 sessionId 的后端会话仍存活时，
    // 直接挂监听 + resize 重绘，而非重新 connect/spawn（重连会顶掉原会话）。
    const adopt = consumeAdopt(sessionId)

    if (!isTauri) {
      xterm.writeln('\x1b[33m[开发模式] 启动完整 Tauri 应用后终端将可用\x1b[0m')
      xterm.writeln('\x1b[90m运行: cargo tauri dev\x1b[0m')
    } else if (localConn) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        Promise.all([
          listen<{ id: string; data: number[] }>('pty:data', (ev) => {
            if (ev.payload.id !== sessionId || !mountedRef.current) return
            feedServerOutput(new Uint8Array(ev.payload.data))
          }),
          listen<{ id: string }>('pty:connected', (ev) => {
            if (ev.payload.id !== sessionId || !mountedRef.current) return
            setDisconnected(false)
            useAppStore.getState().setTermDisconnected(sessionId, false)
            onConnected?.()
          }),
          listen<{ id: string }>('pty:disconnected', (ev) => {
            if (ev.payload.id !== sessionId || !mountedRef.current) return
            xterm.writeln('\r\n\x1b[33m[终端已退出]\x1b[0m')
            setDisconnected(true)
            useAppStore.getState().setTermDisconnected(sessionId, true)
            onDisconnected?.()
          }),
          listen<{ id: string; message: string }>('pty:error', (ev) => {
            if (ev.payload.id !== sessionId || !mountedRef.current) return
            xterm.writeln(`\r\n\x1b[31m[错误] ${ev.payload.message}\x1b[0m`)
            onError?.(ev.payload.message)
          }),
        ]).then((fns) => {
          if (!mountedRef.current) { fns.forEach(f => f()); return }
          unlisten = fns
        })
      })

      const conn    = useAppStore.getState().connections.find((c) => c.id === connectionId)
      const initCmd: string | undefined = (() => {
        try { return conn?.extraJson ? (JSON.parse(conn.extraJson) as { initCommand?: string }).initCommand || undefined : undefined }
        catch { return undefined }
      })()
      const { cols, rows } = xterm

      import('@tauri-apps/api/core').then(({ invoke }) => {
        const spawn = () => {
          invoke('spawn_local_shell', { id: sessionId, shell: conn?.host ?? '', cols, rows, cwd: conn?.database || null, initCmd: null })
            .then(() => {
              if (initCmd) setTimeout(() => {
                const b = Array.from(new TextEncoder().encode(initCmd + '\r'))
                invoke('write_to_pty', { id: sessionId, data: b }).catch(() => {})
              }, 300)
            })
            .catch((e: unknown) => {
              if (!mountedRef.current) return
              xterm.writeln(`\r\n\x1b[31m[启动失败] ${e}\x1b[0m`)
            })
        }
        if (adopt) {
          // 接管：存活则不新建，resize 触发 SIGWINCH 让 shell 重绘；已不在则回退新建
          invoke<boolean>('pty_alive', { id: sessionId }).then((alive) => {
            if (!mountedRef.current) return
            if (alive) {
              const snap = consumeAdoptSnapshot(sessionId)
              if (snap) xterm.write(snap)
              setDisconnected(false)
              useAppStore.getState().setTermDisconnected(sessionId, false)
              onConnected?.()
              invoke('resize_local_pty', { id: sessionId, cols, rows }).catch(() => {})
            } else {
              spawn()
            }
          }).catch(() => { if (mountedRef.current) spawn() })
        } else {
          spawn()
        }
      })
    } else {
      const sshConn    = useAppStore.getState().connections.find((c) => c.id === connectionId)
      const sshInitCmd: string | undefined = (() => {
        try { return sshConn?.extraJson ? (JSON.parse(sshConn.extraJson) as { initCommand?: string }).initCommand || undefined : undefined }
        catch { return undefined }
      })()

      // 过滤旧会话迟到事件：runId 不匹配则丢弃
      const staleEvent = (p: { id: string; runId?: string }) =>
        p.id !== sessionId || !mountedRef.current ||
        (!!p.runId && !!runIdRef.current && p.runId !== runIdRef.current)

      import('@tauri-apps/api/event').then(({ listen }) => {
        Promise.all([
          listen<{ id: string; runId?: string; data: number[] }>('ssh:data', (ev) => {
            if (staleEvent(ev.payload)) return
            feedServerOutput(new Uint8Array(ev.payload.data))
          }),
          listen<{
            id: string; runId?: string; requestId: string
            name: string; instruction: string
            prompts: { prompt: string; echo: boolean }[]
          }>('ssh:mfa-prompt', (ev) => {
            if (staleEvent(ev.payload)) return
            setMfaReq({
              requestId:   ev.payload.requestId,
              name:        ev.payload.name,
              instruction: ev.payload.instruction,
              prompts:     ev.payload.prompts,
            })
          }),
          listen<{ id: string; runId?: string }>('ssh:connected', (ev) => {
            if (staleEvent(ev.payload)) return
            hasConnectedRef.current = true
            reconnectAttempts.delete(connectionId)
            sshErrorRef.current = null
            setSshError(null)
            setMfaReq(null)
            setDisconnected(false)
            useAppStore.getState().setTermDisconnected(sessionId, false)
            onConnected?.()
            // 连接成功后按 xterm 实际尺寸同步 PTY：后端 request_pty 固定 80x24，而初次 ResizeObserver
            // 可能在通道连上前就触发（resize 落空且被 lastCols/lastRows 缓存不再重发），导致 vim 等全屏应用
            // 只用 24 行、下方留白。这里显式补一次 resize，保证 PTY 行列与终端一致。
            {
              const c = xtermRef.current
              if (c && c.cols > 0 && c.rows > 0) {
                import('@tauri-apps/api/core').then(({ invoke }) => {
                  invoke('resize_pty', { id: sessionId, cols: c.cols, rows: c.rows }).catch(() => {})
                })
              }
            }
            if (sshInitCmd && isTauri) {
              setTimeout(() => {
                if (!mountedRef.current) return
                import('@tauri-apps/api/core').then(({ invoke }) => {
                  const b = Array.from(new TextEncoder().encode(sshInitCmd + '\r'))
                  invoke('write_to_ssh', { id: sessionId, data: b }).catch(() => {})
                })
              }, 400)
            }
          }),
          listen<{ id: string; runId?: string }>('ssh:disconnected', (ev) => {
            if (staleEvent(ev.payload)) return
            setMfaReq(null)
            // 连接前收到的断开事件是旧会话清理产生的，直接忽略
            if (!hasConnectedRef.current && !sshErrorRef.current) return
            if (!sshErrorRef.current) {
              xterm.writeln('\r\n\x1b[33m[会话已断开]\x1b[0m')
              setSshError({ type: 'dropped', detail: '' })
              sshErrorRef.current = 'dropped'
            }
            setDisconnected(true)
            useAppStore.getState().setTermDisconnected(sessionId, true)
            onDisconnected?.()

            // 意外断开自动重连：dropped 触发首次；重试期间网络错误继续消耗剩余次数；
            // 认证/协议/密钥类错误不重试（重试也不会成功）
            const s = useSettingsStore.getState()
            const n = reconnectAttempts.get(connectionId) ?? 0
            const retriable = sshErrorRef.current === 'dropped'
              ? (hasConnectedRef.current || n > 0)
              : (sshErrorRef.current === 'network' && n > 0)
            if (s.autoReconnect && retriable && n < Math.max(1, s.reconnectMaxRetries)) {
              reconnectAttempts.set(connectionId, n + 1)
              const delay = Math.min(10000, 1500 * (n + 1))
              xterm.writeln(`\x1b[90m[${(delay / 1000).toFixed(1)} 秒后自动重连 (${n + 1}/${s.reconnectMaxRetries})...]\x1b[0m`)
              setTimeout(() => {
                if (mountedRef.current && sshErrorRef.current) doReconnectSshRef.current()
              }, delay)
            }
          }),
          listen<{ id: string; runId?: string; message: string }>('ssh:error', (ev) => {
            if (staleEvent(ev.payload)) return
            setMfaReq(null)
            const errType = parseSshError(ev.payload.message)
            sshErrorRef.current = errType
            setSshError({ type: errType, detail: ev.payload.message })
            xterm.writeln('\r\n\x1b[2m● 连接失败\x1b[0m')
            onError?.(ev.payload.message)
          }),
        ]).then((fns) => {
          // 组件已卸载：立即注销监听器，避免泄漏
          if (!mountedRef.current) { fns.forEach(f => f()); return }
          unlisten = fns
          import('@tauri-apps/api/core').then(({ invoke }) => {
            const doConnect = () => {
              invoke<string>('connect_ssh', { sessionId, connId: connectionId })
                .then((rid) => { runIdRef.current = rid })
                .catch((e: unknown) => {
                  if (!mountedRef.current) return
                  const msg = String(e)
                  const errType = parseSshError(msg)
                  if (!sshErrorRef.current) {
                    sshErrorRef.current = errType
                    setSshError({ type: errType, detail: msg })
                  }
                  xterm.writeln('\r\n\x1b[2m● 连接失败\x1b[0m')
                  setDisconnected(true)
                })
            }
            if (adopt) {
              // 接管：会话存活则取其 runId 续上事件过滤并标记已连接，不再 connect（重连会顶掉原会话）
              invoke<boolean>('ssh_session_alive', { id: sessionId }).then((alive) => {
                if (!mountedRef.current) return
                if (alive) {
                  const snap = consumeAdoptSnapshot(sessionId)
                  if (snap) xterm.write(snap)
                  invoke<string | null>('ssh_session_runid', { id: sessionId })
                    .then((rid) => { if (rid && mountedRef.current) runIdRef.current = rid })
                    .catch(() => {})
                  hasConnectedRef.current = true
                  sshErrorRef.current = null
                  setSshError(null)
                  setDisconnected(false)
                  useAppStore.getState().setTermDisconnected(sessionId, false)
                  onConnected?.()
                  const { cols, rows } = xterm
                  invoke('resize_pty', { id: sessionId, cols, rows }).catch(() => {})
                } else {
                  doConnect()
                }
              }).catch(() => { if (mountedRef.current) doConnect() })
            } else {
              doConnect()
            }
          })
        })
      })
    }

    // RAF 节流：连续 resize 事件只在每帧执行一次 fit + 后端同步
    let resizeRaf = 0
    let lastCols = 0, lastRows = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        fit.fit()
        if (!isTauri) return
        const { cols, rows } = xterm
        if (cols <= 0 || rows <= 0 || (cols === lastCols && rows === lastRows)) return
        lastCols = cols; lastRows = rows
        clearInputRef.current()
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke(localConn ? 'resize_local_pty' : 'resize_pty', { id: sessionId, cols, rows }).catch(() => {})
        })
      })
    })
    ro.observe(containerRef.current!)

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(shiftRaf)
      cancelAnimationFrame(resizeRaf)
      cancelAnimationFrame(cwdRaf)
      ro.disconnect()
      unlisten.forEach((fn) => fn())
      searchMatchesRef.current = []
      unregisterSerializer(sessionId)
      trzszFilterRef.current?.stopTransferringFiles()
      trzszFilterRef.current = null
      // 撕离迁移：跳过 close_pty，把后端 PTY 留给新窗口接管（普通关闭照常清理）
      if (isTauri && localConn && !isDetaching(sessionId)) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('close_pty', { id: sessionId }).catch(() => {})
        })
      }
      xterm.dispose()
      xtermRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const focusTerminal = useCallback(() => {
    const xterm = xtermRef.current
    if (!xterm || searchOpenRef.current || mfaReq) return
    fitRef.current?.fit()
    xterm.refresh(0, Math.max(0, xterm.rows - 1))
    xterm.focus()
  }, [mfaReq])

  useEffect(() => {
    if (!active) return
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!activeRef.current) return
        focusTerminal()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [active, sessionId, focusTerminal])

  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    xterm.options.theme         = getTheme()
    xterm.options.fontFamily    = `${settings.fontFamily}, monospace`
    xterm.options.fontSize      = settings.fontSize
    xterm.options.lineHeight    = settings.lineHeight ?? 1.3
    xterm.options.letterSpacing = settings.letterSpacing ?? 0
    xterm.options.cursorStyle   = settings.cursorStyle
    xterm.options.cursorBlink   = settings.cursorBlink
    xterm.options.scrollback     = settings.scrollback
    fitRef.current?.fit()
    const raf = requestAnimationFrame(() => { xtermRef.current?.refresh(0, (xtermRef.current?.rows ?? 0) - 1) })
    return () => cancelAnimationFrame(raf)
  }, [settings.resolvedTheme, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing, settings.cursorStyle, settings.cursorBlink, settings.scrollback, getTheme])

  // 搜索栏出现/消失时重新 fit，防止终端出现半屏空白
  useEffect(() => {
    const raf = requestAnimationFrame(() => { fitRef.current?.fit() })
    return () => cancelAnimationFrame(raf)
  }, [searchOpen])

  // searchOpen 给 onSelectionChange（init effect 内）通过 ref 读取，避免 stale closure
  const searchOpenRef = useRef(false)
  useEffect(() => { searchOpenRef.current = searchOpen }, [searchOpen])

  // ────── 补全浮窗渲染用变量 ──────
  const themeObj  = THEMES[settings.resolvedTheme]?.xterm ?? THEMES.tokyoNight.xterm
  const colorCmd  = themeObj.green  ?? '#9ece6a'
  const colorFlag = themeObj.yellow ?? '#e0af68'
  const colorSub  = themeObj.cyan   ?? '#7dcfff'

  function colorizeCompletion(full: string) {
    const prefix = full.slice(0, inputBuf.length)
    const rest   = full.slice(inputBuf.length)
    const parts  = rest.split(/(\s+)/)
    const hasSpace = inputBuf.includes(' ')
    let wi = hasSpace ? 1 : 0
    return (
      <>
        <span className="term-completion-prefix">{prefix}</span>
        {parts.map((p, i) => {
          if (/^\s+$/.test(p)) return <span key={i}>{p}</span>
          let color = colorCmd
          if (p.startsWith('--') || (p.startsWith('-') && p.length > 1)) color = colorFlag
          else if (wi > 0) color = colorSub
          wi++
          return <span key={i} style={{ color }}>{p}</span>
        })}
      </>
    )
  }

  return (
    <div ref={outerRef} className="term-outer">
      {/* 左右 12px、顶部 8px 呼吸空间；钉底输入时由 updateShift 整体上移留出底部空间 */}
      <div
        ref={containerRef}
        style={{
          width:  'calc(100% - 24px)',
          height: 'calc(100% - 8px)',
          margin: '8px 12px 0',
          transition: 'transform 0.18s ease',
        }}
      />

      {/* 命令补全下拉浮窗 — portal 渲染到 body 避免被 overflow:hidden 裁剪 */}
      {suggestions.length > 0 && !disconnected && dropPos && createPortal(
        <div
          className="term-completion-drop"
          style={{
            position:   'fixed',
            left:       dropPos.x,
            top:        dropPos.y,
            fontFamily: `${settings.fontFamily}, monospace`,
            fontSize:   settings.fontSize - 1,
          }}
        >
          {suggestions.map((item, i) => (
            <div
              key={item.cmd}
              className={`term-completion-item${i === activeIdx ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); acceptCompletion(item.cmd, false) }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className="term-completion-item__cmd">{colorizeCompletion(item.cmd)}</span>
              {item.fromHistory && <span className="term-completion-item__tag">历史</span>}
              {i === activeIdx && <kbd className="term-completion-item__key">Tab/↵</kbd>}
            </div>
          ))}
          <div className="term-completion-footer">
            ↑↓ 导航 · Tab 填入 · ↵ 执行 · Esc 关闭
          </div>
        </div>,
        document.body
      )}

      {/* ⌘F 搜索栏 */}
      {searchOpen && (
        <div className="term-search-bar">
          <input
            ref={searchInputRef}
            className="term-search-input"
            placeholder="搜索..."
            value={searchVal}
            onChange={(e) => {
              const v = e.target.value
              setSearchVal(v)
              if (!v) { clearHighlights(); xtermRef.current?.clearSelection(); setSearchMatchCnt(0) }
              else customSearch(v, false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false); setSearchVal(''); setSearchMatchCnt(0)
                clearHighlights()
                xtermRef.current?.clearSelection(); xtermRef.current?.focus()
              }
              if (e.key === 'Enter') customSearch(searchVal, e.shiftKey)
            }}
          />
          {searchMatchCnt > 0 && <span className="term-search-count">{searchMatchCnt} 个匹配</span>}
          <button className="term-search-nav" data-tip="上一个 (⇧Enter)" onClick={() => customSearch(searchVal, true)}>↑</button>
          <button className="term-search-nav" data-tip="下一个 (Enter)"  onClick={() => customSearch(searchVal, false)}>↓</button>
          <button className="term-search-close" onClick={() => {
            setSearchOpen(false); setSearchVal(''); setSearchMatchCnt(0)
            clearHighlights()
            xtermRef.current?.clearSelection(); xtermRef.current?.focus()
          }}>×</button>
        </div>
      )}

      {/* 断联通知 / 错误覆层 */}
      {disconnected && (() => {
        const conn = connections.find(c => c.id === connectionId)
        const dismiss = () => { setDisconnected(false); setSshError(null); sshErrorRef.current = null }

        // 本地终端退出
        if (isLocal) return (
          <div className="term-reconnect-bar">
            <span className="term-reconnect-bar__icon">⚠</span>
            <span className="term-reconnect-bar__msg">终端已退出，按回车键重新连接</span>
            <button className="term-reconnect-bar__btn" onClick={reconnect}>重新连接</button>
            <button className="term-reconnect-bar__close" onClick={() => setDisconnected(false)}>×</button>
          </div>
        )

        // 轻量状态：会话自然断开 / 网络错误
        if (!sshError || sshError.type === 'dropped' || sshError.type === 'network') {
          const isNet = sshError?.type === 'network'
          return (
            <div className={`term-reconnect-bar${isNet ? ' term-reconnect-bar--warn' : ''}`}>
              <span className="term-reconnect-bar__icon">⚠</span>
              <span className="term-reconnect-bar__msg">
                {isNet ? '无法连接到主机' : '会话已断开'}
                {isNet && <span className="term-reconnect-bar__hint"> · 请检查网络和主机地址/端口</span>}
              </span>
              <button className="term-reconnect-bar__btn term-reconnect-bar__btn--secondary" onClick={doReconnectSsh}>重新连接</button>
              {conn && isNet && (
                <button className="term-reconnect-bar__btn" onClick={() => openEditConn(conn)}>编辑连接</button>
              )}
              <button className="term-reconnect-bar__close" onClick={dismiss}>×</button>
            </div>
          )
        }

        // 严重错误：居中覆层卡片（Termius 风格）
        const errInfo = (() => {
          if (sshError.type === 'tofu') return {
            iconCls: 'term-error-icon-wrap--warn',
            icon: '⚠',
            title: '主机密钥已变更',
            desc: '该主机的 SSH 密钥与安全记录不符，可能是服务器重装、密钥更换，或存在中间人攻击风险。如确认安全，可清除旧记录后重新连接。',
          }
          if (sshError.type === 'auth') return {
            iconCls: 'term-error-icon-wrap--error',
            icon: '⊘',
            title: '认证失败',
            desc: '用户名、密码或密钥不正确，请检查认证配置后重试。',
          }
          if (sshError.type === 'proto') return {
            iconCls: 'term-error-icon-wrap--error',
            icon: '⊘',
            title: 'SSH 协议错误',
            desc: 'SSH 握手协商失败，请检查主机 SSH 服务是否正常运行及算法兼容性。',
          }
          return {
            iconCls: 'term-error-icon-wrap--error',
            icon: '⊘',
            title: '连接失败',
            desc: '无法建立 SSH 连接，请检查主机地址、端口及网络状态。',
          }
        })()

        const doClearAndReconnect = () => {
          if (!conn) return
          setClearingKey(true)
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('clear_host_key', { host: conn.host ?? '', port: conn.port ?? 22 })
              .catch(() => {})
              .finally(() => {
                setClearingKey(false)
                setSshError(null)
                sshErrorRef.current = null
                doReconnectSsh()
              })
          })
        }

        return (
          <div className="term-error-overlay">
            <div className="term-error-card">
              <div className={`term-error-icon-wrap ${errInfo.iconCls}`}>{errInfo.icon}</div>
              <h3 className="term-error-title">{errInfo.title}</h3>
              {conn && <span className="term-error-host">{conn.host}:{conn.port ?? 22}</span>}
              <p className="term-error-desc">{errInfo.desc}</p>
              <div className="term-error-actions">
                {sshError.type === 'tofu' && (
                  <button
                    className="term-error-btn term-error-btn--orange"
                    disabled={clearingKey}
                    onClick={doClearAndReconnect}
                  >
                    {clearingKey ? '处理中…' : '清除记录并重连'}
                  </button>
                )}
                {sshError.type === 'auth' && conn && (
                  <button className="term-error-btn term-error-btn--primary" onClick={() => openEditConn(conn)}>
                    修改认证配置
                  </button>
                )}
                {(sshError.type === 'proto' || sshError.type === 'generic') && (
                  <>
                    <button className="term-error-btn term-error-btn--ghost" onClick={doReconnectSsh}>重新连接</button>
                    {conn && (
                      <button className="term-error-btn term-error-btn--primary" onClick={() => openEditConn(conn)}>编辑连接</button>
                    )}
                  </>
                )}
                <button className="term-error-btn term-error-btn--ghost" onClick={dismiss}>取消</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* MFA 多因素认证弹窗 */}
      {mfaReq && (() => {
        const conn = connections.find(c => c.id === connectionId)
        return (
          <MfaDialog
            req={mfaReq}
            host={conn ? `${conn.host}:${conn.port ?? 22}` : undefined}
            onSubmit={(answers) => respondMfa(answers)}
            onCancel={() => respondMfa(null)}
          />
        )
      })()}

    </div>
  )
}
