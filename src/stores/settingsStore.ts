import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { THEMES, buildThemeVars, type ThemeKey } from '../themes'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'

// system 模式下随 OS 切换时使用的默认深/浅主题
export const DEFAULT_DARK_THEME:  ThemeKey = 'tokyoNight'
export const DEFAULT_LIGHT_THEME: ThemeKey = 'githubLight'

export type AppColorScheme  = 'dark' | 'light' | 'system'
export type TabNewPosition  = 'end' | 'after-current'
export type TabCloseActivate= 'left' | 'right'
export type TabTitleFormat  = 'hostname' | 'user-at-host'
export type TabHoverActivate= 'never' | 'immediately' | '500ms' | '1000ms'
export type TabShowNumber   = 'none' | 'first9' | 'all'
export type TabTextTruncate = 'end' | 'middle' | 'start'
export type TabMouseAction  = 'none' | 'close' | 'rename' | 'new' | 'duplicate' | 'duplicate-ssh' | 'menu'
export type Encoding        = 'UTF-8' | 'GBK' | 'GB2312' | 'Latin-1'
export type ProxyType       = 'none' | 'http' | 'socks5'
export type BellMode        = 'visual' | 'sound' | 'none'
export type LineEnding      = 'LF' | 'CRLF'
export type DbResultDefaultView = 'grid' | 'json' | 'text'
// 鼠标滚轮横向滚动的触发方式（全软件统一，见 src/utils/wheelScroll.ts）：
// shift/alt/ctrl = 按住对应修饰键 + 滚轮转横向；horizontal-first = 横向优先，无需修饰键
export type WheelHMode      = 'shift' | 'alt' | 'ctrl' | 'horizontal-first'

export const FONT_LIST: { value: string; label: string; builtin?: true }[] = [
  { value: "'JetBrains Mono'", label: 'JetBrains Mono', builtin: true },
  { value: "'Fira Code'",      label: 'Fira Code',      builtin: true },
  { value: "'IBM Plex Mono'",  label: 'IBM Plex Mono',  builtin: true },
  { value: "'Geist Mono'",     label: 'Geist Mono',     builtin: true },
  // macOS/Windows 内置系统字体
  { value: "'SF Mono'",  label: 'SF Mono' },
  { value: "Menlo",      label: 'Menlo' },
  { value: "Monaco",     label: 'Monaco' },
  { value: "Consolas",   label: 'Consolas' },
]

let _mqListener: (() => void) | null = null
const loadedFontCss = new Set<string>()

function loadFontCss(fontFamily: string) {
  if (typeof window === 'undefined') return
  const normalized = fontFamily.replace(/['"]/g, '').trim()
  const loaders: Record<string, () => Promise<unknown>> = {
    'JetBrains Mono': () => import('@fontsource/jetbrains-mono/index.css'),
    'Fira Code': () => import('@fontsource/fira-code/index.css'),
    'IBM Plex Mono': () => import('@fontsource/ibm-plex-mono/index.css'),
    'Geist Mono': () => import('@fontsource/geist-mono/index.css'),
  }
  const loader = loaders[normalized]
  if (!loader || loadedFontCss.has(normalized)) return
  loadedFontCss.add(normalized)
  loader().catch(() => { loadedFontCss.delete(normalized) })
}

function getSystemThemeKey(): ThemeKey {
  if (typeof window === 'undefined') return DEFAULT_LIGHT_THEME
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
}

function setNativeWindowTheme(mode: 'dark' | 'light' | null) {
  if (typeof window === 'undefined') return
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    getCurrentWindow().setTheme(mode).catch(() => {})
  }).catch(() => {})
}

/** 套用某个主题的整套 UI 配色（全软件换肤）：写入所有颜色 CSS 变量 + 同步深/浅模式。 */
export function applyTheme(key: ThemeKey, syncNativeWindow = true) {
  if (typeof document === 'undefined') return
  const t = THEMES[key] ?? THEMES[DEFAULT_DARK_THEME]
  const root = document.documentElement
  const vars = buildThemeVars(t)
  for (const k in vars) root.style.setProperty(k, vars[k])
  root.dataset.colorScheme = t.mode
  if (syncNativeWindow) setNativeWindowTheme(t.mode === 'dark' ? 'dark' : 'light')
}

/**
 * 应用外观：
 * - system：跟随系统在默认深/浅主题间自动切换，并监听 OS 变化；
 * - dark/light：直接套用传入主题（其 mode 即为深/浅）。
 */
export function applyAppearance(scheme: AppColorScheme, theme: ThemeKey, onResolved?: (theme: ThemeKey) => void) {
  if (typeof document === 'undefined') return
  if (_mqListener) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _mqListener)
    _mqListener = null
  }
  if (scheme === 'system') {
    setNativeWindowTheme(null)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = mq.matches ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
      applyTheme(resolved, false)
      onResolved?.(resolved)
    }
    apply()
    requestAnimationFrame(apply)
    mq.addEventListener('change', apply)
    _mqListener = apply
  } else {
    applyTheme(theme)
    onResolved?.(theme)
  }
}

/** 应用设置的字体与字号到全局 CSS 变量。
 *  代码/等宽场景 → --font-mono；整个界面 → --font-sans（均跟随设置，附带各自兜底栈）。 */
export function applyFont(fontFamily: string, fontSize: number) {
  if (typeof document === 'undefined') return
  loadFontCss(fontFamily)
  const root = document.documentElement.style
  const monoFallback = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, ui-monospace, monospace"
  // 界面字体兜底：CJK + 系统无衬线，保证中文与缺字优雅回退
  const uiFallback = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'MiSans', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Hiragino Sans GB', 'Noto Sans SC', sans-serif"
  // fontFamily 形如 "'JetBrains Mono'" 或 "Consolas"，追加兜底栈
  root.setProperty('--font-mono', fontFamily ? `${fontFamily}, ${monoFallback}` : monoFallback)
  root.setProperty('--font-sans', fontFamily ? `${fontFamily}, ${uiFallback}` : uiFallback)
  root.setProperty('--font-size', `${fontSize}px`)
}

interface SettingsState {
  // ── 外观 ──────────────────────────────────────────
  appColorScheme: AppColorScheme
  theme: ThemeKey
  resolvedTheme: ThemeKey
  termColorPalette: string   // 'auto' | ANSI_PALETTES[*].key
  fontFamily: string
  fontSize: number

  // ── 终端 ──────────────────────────────────────────
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  copyOnSelect: boolean   // 选中即复制（iTerm/MobaXterm 习惯）
  lineHeight: number      // 行高倍数，1.0-2.0
  letterSpacing: number   // 字间距 px，0-4
  scrollback: number
  bellMode: BellMode
  lineEnding: LineEnding

  // ── 标签页 ─────────────────────────────────────────
  tabNewPosition:   TabNewPosition
  tabCloseActivate: TabCloseActivate
  tabHoverActivate: TabHoverActivate
  tabTitleFormat:   TabTitleFormat
  tabShowNumber:    TabShowNumber
  tabTextTruncate:  TabTextTruncate
  tabMouseDouble:   TabMouseAction
  tabMouseMiddle:   TabMouseAction
  tabMouseRight:    TabMouseAction

  // ── 连接 ──────────────────────────────────────────
  keepaliveEnabled:    boolean
  keepaliveInterval:   number
  autoReconnect:       boolean
  reconnectMaxRetries: number
  connectTimeout:      number
  encoding:            Encoding

  // ── 代理 ──────────────────────────────────────────
  proxyType:        ProxyType
  proxyHost:        string
  proxyPort:        number
  proxyAuthEnabled: boolean
  proxyUsername:    string
  proxyPassword:    string

  // ── setters ───────────────────────────────────────
  setAppColorScheme:    (s: AppColorScheme) => void
  setTheme:             (t: ThemeKey) => void
  setTermColorPalette:  (k: string) => void
  setFontFamily:        (f: string) => void
  setFontSize:       (n: number) => void

  setCursorStyle:   (s: 'block' | 'underline' | 'bar') => void
  setCursorBlink:   (b: boolean) => void
  setCopyOnSelect:  (b: boolean) => void
  setLineHeight:    (n: number) => void
  setLetterSpacing: (n: number) => void
  setScrollback:    (n: number) => void
  setBellMode:      (m: BellMode) => void
  setLineEnding:    (e: LineEnding) => void

  setTabNewPosition:   (v: TabNewPosition) => void
  setTabCloseActivate: (v: TabCloseActivate) => void
  setTabHoverActivate: (v: TabHoverActivate) => void
  setTabTitleFormat:   (v: TabTitleFormat) => void
  setTabShowNumber:    (v: TabShowNumber) => void
  setTabTextTruncate:  (v: TabTextTruncate) => void
  setTabMouseDouble:   (v: TabMouseAction) => void
  setTabMouseMiddle:   (v: TabMouseAction) => void
  setTabMouseRight:    (v: TabMouseAction) => void

  setKeepaliveEnabled:    (b: boolean) => void
  setKeepaliveInterval:   (n: number) => void
  setAutoReconnect:       (b: boolean) => void
  setReconnectMaxRetries: (n: number) => void
  setConnectTimeout:      (n: number) => void
  setEncoding:            (e: Encoding) => void

  setProxyType:        (t: ProxyType) => void
  setProxyHost:        (s: string) => void
  setProxyPort:        (n: number) => void
  setProxyAuthEnabled: (b: boolean) => void
  setProxyUsername:    (s: string) => void
  setProxyPassword:    (s: string) => void

  // ── 数据库 ─────────────────────────────────────────
  dbQueryLimit: number | null       // 查询行数上限（null = 全量不限制）
  dbResultDefaultView: DbResultDefaultView
  dbResultFilterDefaultOpen: boolean
  setDbQueryLimit: (n: number | null) => void
  setDbResultDefaultView: (v: DbResultDefaultView) => void
  setDbResultFilterDefaultOpen: (b: boolean) => void

  // ── 交互 ───────────────────────────────────────────
  wheelHScrollModifier: WheelHMode
  setWheelHScrollModifier: (m: WheelHMode) => void

  // ── 快捷键 ─────────────────────────────────────────
  shortcuts: Record<string, string>
  setShortcut: (id: string, combo: string) => void
  resetShortcut: (id: string) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      appColorScheme: 'system',
      theme: DEFAULT_LIGHT_THEME,
      resolvedTheme: getSystemThemeKey(),
      termColorPalette: 'auto',
      fontFamily: "'JetBrains Mono'",
      fontSize: 14,

      cursorStyle: 'block',
      cursorBlink: true,
      copyOnSelect: false,
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 5000,
      bellMode: 'visual',
      lineEnding: 'LF',

      tabNewPosition:   'end',
      tabCloseActivate: 'right',
      tabHoverActivate: 'never',
      tabTitleFormat:   'hostname',
      tabShowNumber:    'none',
      tabTextTruncate:  'middle',
      tabMouseDouble:   'rename',
      tabMouseMiddle:   'close',
      tabMouseRight:    'menu',

      keepaliveEnabled:    true,
      keepaliveInterval:   60,
      autoReconnect:       true,
      reconnectMaxRetries: 3,
      connectTimeout:      15,
      encoding:            'UTF-8',

      proxyType:        'none',
      proxyHost:        '',
      proxyPort:        8080,
      proxyAuthEnabled: false,
      proxyUsername:    '',
      proxyPassword:    '',

      setAppColorScheme: (appColorScheme) => {
        if (appColorScheme === 'system') {
          set({ appColorScheme })
          applyAppearance('system', get().theme, (resolvedTheme) => {
            set({ resolvedTheme })
          })
        } else {
          // 深/浅切换：当前主题 mode 不匹配则切到对应默认主题，保持一致
          const cur = get().theme
          const next = THEMES[cur].mode === appColorScheme
            ? cur
            : (appColorScheme === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME)
          applyTheme(next)
          set({ appColorScheme, theme: next, resolvedTheme: next })
        }
      },
      // 选定主题即决定整套界面配色与深/浅；显式选择会退出「跟随系统」
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme, resolvedTheme: theme, appColorScheme: THEMES[theme].mode })
      },
      setTermColorPalette: (termColorPalette) => set({ termColorPalette }),
      setFontFamily:  (fontFamily) => { applyFont(fontFamily, get().fontSize); set({ fontFamily }) },
      setFontSize:    (fontSize)   => { applyFont(get().fontFamily, fontSize); set({ fontSize }) },

      setCursorStyle:   (cursorStyle: 'block' | 'underline' | 'bar') => set({ cursorStyle }),
      setCursorBlink:   (cursorBlink: boolean) => set({ cursorBlink }),
      setCopyOnSelect:  (copyOnSelect: boolean) => set({ copyOnSelect }),
      setLineHeight:    (lineHeight: number) => set({ lineHeight }),
      setLetterSpacing: (letterSpacing: number) => set({ letterSpacing }),
      setScrollback:    (scrollback)    => set({ scrollback }),
      setBellMode:      (bellMode)      => set({ bellMode }),
      setLineEnding:    (lineEnding)    => set({ lineEnding }),

      setTabNewPosition:   (tabNewPosition)   => set({ tabNewPosition }),
      setTabCloseActivate: (tabCloseActivate) => set({ tabCloseActivate }),
      setTabHoverActivate: (tabHoverActivate) => set({ tabHoverActivate }),
      setTabTitleFormat:   (tabTitleFormat)   => set({ tabTitleFormat }),
      setTabShowNumber:    (tabShowNumber)    => set({ tabShowNumber }),
      setTabTextTruncate:  (tabTextTruncate)  => set({ tabTextTruncate }),
      setTabMouseDouble:   (tabMouseDouble)   => set({ tabMouseDouble }),
      setTabMouseMiddle:   (tabMouseMiddle)   => set({ tabMouseMiddle }),
      setTabMouseRight:    (tabMouseRight)    => set({ tabMouseRight }),

      setKeepaliveEnabled:    (keepaliveEnabled)    => set({ keepaliveEnabled }),
      setKeepaliveInterval:   (keepaliveInterval)   => set({ keepaliveInterval }),
      setAutoReconnect:       (autoReconnect)       => set({ autoReconnect }),
      setReconnectMaxRetries: (reconnectMaxRetries) => set({ reconnectMaxRetries }),
      setConnectTimeout:      (connectTimeout)      => set({ connectTimeout }),
      setEncoding:            (encoding)            => set({ encoding }),

      setProxyType:        (proxyType)        => set({ proxyType }),
      setProxyHost:        (proxyHost)        => set({ proxyHost }),
      setProxyPort:        (proxyPort)        => set({ proxyPort }),
      setProxyAuthEnabled: (proxyAuthEnabled) => set({ proxyAuthEnabled }),
      setProxyUsername:    (proxyUsername)    => set({ proxyUsername }),
      setProxyPassword:    (proxyPassword)    => set({ proxyPassword }),

      dbQueryLimit: 200,
      dbResultDefaultView: 'grid',
      dbResultFilterDefaultOpen: false,
      setDbQueryLimit: (dbQueryLimit) => set({ dbQueryLimit }),
      setDbResultDefaultView: (dbResultDefaultView) => set({ dbResultDefaultView }),
      setDbResultFilterDefaultOpen: (dbResultFilterDefaultOpen) => set({ dbResultFilterDefaultOpen }),

      wheelHScrollModifier: 'shift',
      setWheelHScrollModifier: (wheelHScrollModifier) => set({ wheelHScrollModifier }),

      shortcuts: { ...DEFAULT_SHORTCUTS },
      setShortcut:   (id, combo) => set(s => ({ shortcuts: { ...s.shortcuts, [id]: combo } })),
      resetShortcut: (id)        => set(s => ({ shortcuts: { ...s.shortcuts, [id]: DEFAULT_SHORTCUTS[id] } })),
    }),
    {
      name: 'dbterm-settings',
      // 安全：代理密码敏感，不持久化到 localStorage（应用重启后需重新输入）
      partialize: (state) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { proxyPassword, resolvedTheme, ...rest } = state as unknown as Record<string, unknown>
        return rest as unknown as typeof state
      },
      // 快捷键重排：尽量 Mod+单键、同功能统一。每次键位调整都 bump 版本，
      // 将旧持久化的快捷键全量重置为最新默认键位（否则旧 localStorage 不会更新）。
      version: 10,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<SettingsState>
        if (version < 4) {
          // v4：键位大改，全量重置为新默认
          return { ...s, shortcuts: { ...DEFAULT_SHORTCUTS } }
        }
        if (version < 5) {
          // v5：仅补齐新增快捷键，保留用户已有自定义
          return { ...s, shortcuts: { ...DEFAULT_SHORTCUTS, ...(s.shortcuts ?? {}) } }
        }
        if (version < 6) {
          // v6：软件默认外观改为跟随系统。仅迁移旧默认值，保留用户主动选择的其他主题。
          const wasOldDefault = (s.appColorScheme ?? 'dark') === 'dark' && (s.theme ?? DEFAULT_DARK_THEME) === DEFAULT_DARK_THEME
          return wasOldDefault ? { ...s, appColorScheme: 'system', theme: DEFAULT_LIGHT_THEME } : s
        }
        if (version < 7) {
          // v7：继续清理已经落到浅色默认主题的旧持久化值，确保默认入口显示「跟随系统」。
          const wasLightDefault = s.appColorScheme === 'light' && (s.theme ?? DEFAULT_LIGHT_THEME) === DEFAULT_LIGHT_THEME
          return wasLightDefault ? { ...s, appColorScheme: 'system', theme: DEFAULT_LIGHT_THEME } : s
        }
        if (version < 8) {
          // v8：移除未落地的“之前选择的标签页”关闭策略，迁到已实现的右侧优先。
          const oldCloseActivate = (s as { tabCloseActivate?: string }).tabCloseActivate
          return oldCloseActivate === 'previous' ? { ...s, tabCloseActivate: 'right' as TabCloseActivate } : s
        }
        if (version < 9) {
          const { termOpacity: _termOpacity, ...rest } = s as Partial<SettingsState> & { termOpacity?: unknown }
          return rest
        }
        if (version < 10) {
          return { ...s, shortcuts: { ...DEFAULT_SHORTCUTS, ...(s.shortcuts ?? {}) } }
        }
        return s
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyAppearance(state.appColorScheme, state.theme ?? DEFAULT_DARK_THEME, (resolvedTheme) => {
            state.resolvedTheme = resolvedTheme
            queueMicrotask(() => useSettingsStore.setState({ resolvedTheme }))
          })
          applyFont(state.fontFamily ?? "'JetBrains Mono'", state.fontSize ?? 14)
        }
      },
    }
  )
)
