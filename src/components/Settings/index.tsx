import { useState, useEffect, useRef } from 'react'
import {
  X, Monitor, TerminalSquare, Info,
  Moon, Sun, Laptop, Layers, Plug, Globe, Keyboard,
  RotateCcw, Database, HardDrive, FileOutput, Trash2,
} from 'lucide-react'
import DriverManager from '../ConnectionForm/DriverManager'
import SshKeysTab from './SshKeysTab'
import SshConfigImportDialog from './SshConfigImportDialog'
import ConnExportImportDialog from './ConnExportImportDialog'
import type { LucideIcon } from 'lucide-react'
import { useSettingsStore, FONT_LIST } from '../../stores/settingsStore'
import { useAppStore } from '../../stores/appStore'
import { toast } from '../../stores/toastStore'
import ConfirmDialog from '../shared/ConfirmDialog'
import ExportDialog from '../shared/ExportDialog'
import SearchableSelect from '../DbTools/SearchableSelect'
import { THEME_LIST, ANSI_PALETTES } from '../../themes'
import type { ThemeKey } from '../../themes'
import { SHORTCUT_DEFS, displayShortcut, comboFromEvent, type ShortcutGroup } from '../../utils/shortcuts'
import type {
  AppColorScheme, TabNewPosition, TabCloseActivate, TabHoverActivate,
  TabTitleFormat, TabShowNumber, TabTextTruncate, TabMouseAction,
  ProxyType, BellMode, LineEnding, WheelHMode, DbResultDefaultView, Encoding,
} from '../../stores/settingsStore'

type Section = 'appearance' | 'terminal' | 'tabs' | 'connection' | 'proxy' | 'database' | 'shortcuts' | 'data' | 'about' | 'sshkeys'
type ThemeFilter = 'all' | 'dark' | 'light'

interface Props { onClose: () => void }

// 侧边导航按「通用 / SSH 终端 / 数据库」分组，两块功能的设置互不混淆
const NAV_GROUPS: { group: string | null; items: { id: Section; label: string; Icon: LucideIcon }[] }[] = [
  { group: '通用', items: [
    { id: 'appearance', label: '外观',  Icon: Monitor },
    { id: 'tabs',       label: '标签页', Icon: Layers },
    { id: 'shortcuts',  label: '快捷键', Icon: Keyboard },
  ]},
  { group: 'SSH 终端', items: [
    { id: 'terminal',   label: '终端',  Icon: TerminalSquare },
    { id: 'connection', label: '连接',  Icon: Plug },
    { id: 'proxy',      label: '代理',  Icon: Globe },
    { id: 'sshkeys',    label: 'SSH 密钥', Icon: FileOutput },
  ]},
  { group: '数据库', items: [
    { id: 'database',   label: '数据库',  Icon: Database },
  ]},
  { group: null, items: [
    { id: 'data',       label: '数据',  Icon: HardDrive },
    { id: 'about',      label: '关于',  Icon: Info },
  ]},
]
const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items)

const COLOR_SCHEME_OPTIONS: { value: AppColorScheme; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: '跟随系统', Icon: Laptop },
  { value: 'light',  label: '浅色',    Icon: Sun },
  { value: 'dark',   label: '深色',    Icon: Moon },
]

const CURSOR_LABELS = { block: '块状', underline: '下划线', bar: '竖线' } as const

const MOUSE_ACTION_OPTS: { value: TabMouseAction; label: string }[] = [
  { value: 'none',          label: '无作用' },
  { value: 'close',         label: '关闭标签' },
  { value: 'rename',        label: '重命名标签页' },
  { value: 'new',           label: '新建标签页' },
  { value: 'duplicate',     label: '重复标签' },
  { value: 'duplicate-ssh', label: '复制 SSH 通道' },
  { value: 'menu',          label: '显示上下文菜单' },
]

/* ── small reusable pieces ─────────────────────────── */

function SegCtrl<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg-ctrl">
      {options.map(o => (
        <button
          key={o.value}
          className={`seg-btn${value === o.value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RowItem({
  label, desc, children,
}: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row-item">
      <div className="settings-row-info">
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={`toggle${on ? ' on' : ''}`} onClick={onClick}>
      <span className="toggle__knob" />
    </button>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sf-row">
      <span className="sf-label">{label}</span>
      <div className="sf-control">{children}</div>
    </div>
  )
}

function Sel<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <SearchableSelect
      value={value}
      onChange={v => onChange(v as T)}
      items={options}
      mono={false}
    />
  )
}

/* ── main component ────────────────────────────────── */

export default function Settings({ onClose }: Props) {
  const [section, setSection] = useState<Section>('appearance')
  const s = useSettingsStore()
  // 「数据」区：导出全部连接 / 清空本机数据
  const connections = useAppStore(st => st.connections)
  const loadConnections = useAppStore(st => st.loadConnections)
  const [exportOpen, setExportOpen] = useState(false)
  const [sshConfigImportOpen, setSshConfigImportOpen] = useState(false)
  const [connBackupOpen, setConnBackupOpen] = useState(false)
  const [wipeConfirm, setWipeConfirm] = useState(false)
  const [wiping, setWiping] = useState(false)
  const handleWipe = async () => {
    setWiping(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('wipe_local_data')
      await loadConnections()
      toast.success('已清空本机数据：连接、密码、已信任主机')
      setWipeConfirm(false)
    } catch (e) {
      toast.error(`清空失败：${String(e)}`)
    } finally { setWiping(false) }
  }
  // 打开时根据当前配色方案初始化过滤器
  const [themeFilter, setThemeFilter] = useState<ThemeFilter>(() =>
    s.appColorScheme === 'dark' ? 'dark' : s.appColorScheme === 'light' ? 'light' : 'all'
  )

  const filteredThemes = THEME_LIST
    .filter(t => themeFilter === 'all' || t.mode === themeFilter)
    .sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'light' ? -1 : 1
      return 0
    })
  const selectedTheme = s.appColorScheme === 'system' ? s.resolvedTheme : s.theme
  const selectedThemeMode = THEME_LIST.find(t => t.key === selectedTheme)?.mode ?? 'light'

  return (
    <div className="modal-overlay">
      <div className="settings-panel">

        {/* ── Sidebar ─────────────────────────────── */}
        <div className="settings-sidebar">
          <div className="settings-sidebar-header">
            <div className="settings-sidebar-logo">DBTerm</div>
            <div className="settings-sidebar-sub">偏好设置</div>
          </div>
          <nav className="settings-nav">
            {NAV_GROUPS.map((g, gi) => (
              <div key={g.group ?? `g${gi}`} className="settings-nav-group">
                {g.group && <div className="settings-nav-group-label">{g.group}</div>}
                {g.items.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={`settings-nav-item${section === id ? ' active' : ''}`}
                    onClick={() => setSection(id)}
                  >
                    <Icon size={14} strokeWidth={1.8} />
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-sidebar-footer">
            <span className="settings-version">v0.1.0</span>
          </div>
        </div>

        {/* ── Content ─────────────────────────────── */}
        <div className="settings-content">
          <div className="settings-content-header">
            <span className="settings-content-title">
              {NAV_ITEMS.find(n => n.id === section)!.label}
            </span>
            <button className="settings-content-close" onClick={onClose}>
              <X size={15} />
            </button>
          </div>

          <div className="settings-content-body">

            {/* ══ 外观 ══════════════════════════════ */}
            {section === 'appearance' && (<>
              <div className="settings-group">
                <div className="settings-group-title">应用颜色方案</div>
                <div className="color-scheme-opts">
                  {COLOR_SCHEME_OPTIONS.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      className={`color-scheme-opt${s.appColorScheme === value ? ' active' : ''}`}
                      onClick={() => {
                        s.setAppColorScheme(value)
                        setThemeFilter(value === 'system' ? 'all' : value)
                      }}
                    >
                      <Icon size={15} strokeWidth={1.8} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  界面主题
                  {s.appColorScheme === 'system' && (
                    <span className="settings-hint">当前跟随：{selectedThemeMode === 'dark' ? '深色' : '浅色'}</span>
                  )}
                  <span className="theme-filter-bar">
                    {(['all', 'light', 'dark'] as ThemeFilter[]).map(f => (
                      <button
                        key={f}
                        className={`theme-filter-btn${themeFilter === f ? ' active' : ''}`}
                        onClick={() => setThemeFilter(f)}
                      >
                        {{ all: '全部', dark: '深色', light: '浅色' }[f]}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="theme-grid">
                  {filteredThemes.map(t => (
                    <button
                      key={t.key}
                      className={`theme-card${selectedTheme === t.key ? ' selected' : ''}`}
                      onClick={() => s.setTheme(t.key as ThemeKey)}
                      data-tip={t.name}
                    >
                      <div className="theme-preview" style={{ background: t.preview.bg }}>
                        <div className="theme-preview__line">
                          <span style={{ color: t.preview.swatches[1] }}>~/</span>
                          <span style={{ color: t.preview.fg }}> ls</span>
                        </div>
                        <div className="theme-preview__swatches">
                          {t.preview.swatches.map((c, i) => (
                            <span key={i} style={{ background: c }} />
                          ))}
                        </div>
                      </div>
                      <span className="theme-card__name">{t.name}</span>
                      {selectedTheme === t.key && <span className="theme-card__check">✓</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">终端字体配色方案</div>
                <div className="palette-grid">
                  <button
                    className={`palette-card${s.termColorPalette === 'auto' ? ' selected' : ''}`}
                    onClick={() => s.setTermColorPalette('auto')}
                  >
                    <div className="palette-card__swatches palette-card__auto" />
                    <div className="palette-card__footer">
                      <span className="palette-card__name">自动</span>
                      <span className="palette-card__hint">跟随主题</span>
                    </div>
                  </button>
                  {ANSI_PALETTES.map(p => (
                    <button
                      key={p.key}
                      className={`palette-card${s.termColorPalette === p.key ? ' selected' : ''}`}
                      onClick={() => s.setTermColorPalette(p.key)}
                    >
                      <div className="palette-card__swatches">
                        {([p.colors.red, p.colors.green, p.colors.yellow, p.colors.blue, p.colors.magenta, p.colors.cyan] as string[]).map((c, i) => (
                          <span key={i} style={{ background: c }} />
                        ))}
                      </div>
                      <div className="palette-card__footer">
                        <span className="palette-card__name">{p.name}</span>
                        <span className="palette-card__hint">{p.hint}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">终端字体</div>
                <div className="font-grid">
                  {FONT_LIST.map(f => (
                    <button
                      key={f.value}
                      className={`font-card${s.fontFamily === f.value ? ' selected' : ''}`}
                      onClick={() => s.setFontFamily(f.value)}
                    >
                      {f.builtin && <span className="font-card__builtin">内置</span>}
                      <span className="font-card__sample" style={{ fontFamily: `${f.value}, monospace` }}>Aa</span>
                      <span className="font-card__name">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  字体大小
                  <span className="settings-val">{s.fontSize} px</span>
                </div>
                <input
                  type="range" className="range-input"
                  min={10} max={24} step={1} value={s.fontSize}
                  onChange={e => s.setFontSize(Number(e.target.value))}
                />
                <div className="range-labels"><span>10</span><span>24</span></div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  行高
                  <span className="settings-val">{(s.lineHeight ?? 1.3).toFixed(1)}</span>
                </div>
                <input
                  type="range" className="range-input"
                  min={1.0} max={2.0} step={0.1} value={s.lineHeight ?? 1.3}
                  onChange={e => s.setLineHeight(Number(e.target.value))}
                />
                <div className="range-labels"><span>1.0</span><span>2.0</span></div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  字间距
                  <span className="settings-val">{s.letterSpacing ?? 0} px</span>
                </div>
                <input
                  type="range" className="range-input"
                  min={0} max={4} step={0.5} value={s.letterSpacing ?? 0}
                  onChange={e => s.setLetterSpacing(Number(e.target.value))}
                />
                <div className="range-labels"><span>0</span><span>4</span></div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">鼠标滚轮</div>
                <div className="sf-block">
                  <FormRow label="横向滚动触发方式">
                    <Sel<WheelHMode>
                      value={s.wheelHScrollModifier}
                      onChange={s.setWheelHScrollModifier}
                      options={[
                        { value: 'shift',            label: 'Shift + 滚轮（默认）' },
                        { value: 'alt',              label: 'Alt + 滚轮' },
                        { value: 'ctrl',             label: 'Ctrl + 滚轮' },
                        { value: 'horizontal-first', label: '横向优先（无需修饰键）' },
                      ]}
                    />
                  </FormRow>
                </div>
                <div className="settings-row-desc">
                  只对带横向滚动条的区域生效：默认裸滚轮仍纵向滚动，按住上面的修饰键 + 滚轮转横向。
                  选「横向优先」时，只要当前区域能横向滚动，裸滚轮就直接横向。输入框、下拉框不拦截。
                </div>
              </div>

            </>)}

            {/* ══ 终端 ══════════════════════════════ */}
            {section === 'terminal' && (<>
              <div className="settings-group">
                <div className="settings-group-title">光标</div>
                <div className="cursor-options">
                  {(['block', 'underline', 'bar'] as const).map(c => (
                    <button
                      key={c}
                      className={`cursor-opt${s.cursorStyle === c ? ' selected' : ''}`}
                      onClick={() => s.setCursorStyle(c)}
                    >
                      <span className={`cursor-demo cursor-demo--${c}`} />
                      <span>{CURSOR_LABELS[c]}</span>
                    </button>
                  ))}
                </div>
                <RowItem label="光标闪烁" desc="光标是否周期性闪烁">
                  <Toggle on={s.cursorBlink} onClick={() => s.setCursorBlink(!s.cursorBlink)} />
                </RowItem>
                <RowItem label="选中即复制" desc="在终端选中文本时自动复制到剪贴板">
                  <Toggle on={s.copyOnSelect} onClick={() => s.setCopyOnSelect(!s.copyOnSelect)} />
                </RowItem>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  滚动缓冲行数
                  <span className="settings-val">{s.scrollback.toLocaleString()}</span>
                </div>
                <input
                  type="range" className="range-input"
                  min={1000} max={20000} step={1000} value={s.scrollback}
                  onChange={e => s.setScrollback(Number(e.target.value))}
                />
                <div className="range-labels"><span>1,000</span><span>20,000</span></div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">输入 / 输出</div>
                <div className="sf-block">
                  <FormRow label="行结束符">
                    <Sel<LineEnding>
                      value={s.lineEnding}
                      onChange={s.setLineEnding}
                      options={[
                        { value: 'LF',   label: 'LF  (Unix / macOS)' },
                        { value: 'CRLF', label: 'CRLF  (Windows)' },
                      ]}
                    />
                  </FormRow>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">响铃模式</div>
                <SegCtrl<BellMode>
                  options={[
                    { value: 'visual', label: '视觉闪烁' },
                    { value: 'sound',  label: '声音' },
                    { value: 'none',   label: '关闭' },
                  ]}
                  value={s.bellMode}
                  onChange={s.setBellMode}
                />
              </div>
            </>)}

            {/* ══ 标签页 ════════════════════════════ */}
            {section === 'tabs' && (<>
              <div className="settings-group">
                <div className="settings-group-title">标签功能</div>
                <div className="sf-block">
                  <FormRow label="关闭后激活标签页">
                    <Sel<TabCloseActivate>
                      value={s.tabCloseActivate}
                      onChange={s.setTabCloseActivate}
                      options={[
                        { value: 'right',    label: '激活右侧标签页' },
                        { value: 'left',     label: '激活左侧标签页' },
                      ]}
                    />
                  </FormRow>
                  <FormRow label="悬停后激活标签页">
                    <Sel<TabHoverActivate>
                      value={s.tabHoverActivate}
                      onChange={s.setTabHoverActivate}
                      options={[
                        { value: 'never',       label: '绝不' },
                        { value: 'immediately', label: '立即' },
                        { value: '500ms',       label: '500 ms 后' },
                        { value: '1000ms',      label: '1000 ms 后' },
                      ]}
                    />
                  </FormRow>
                  <FormRow label="在标签页上显示编号">
                    <Sel<TabShowNumber>
                      value={s.tabShowNumber}
                      onChange={s.setTabShowNumber}
                      options={[
                        { value: 'none',   label: '不显示' },
                        { value: 'first9', label: '前九个标签' },
                        { value: 'all',    label: '所有标签' },
                      ]}
                    />
                  </FormRow>
                  <FormRow label="标签文本隐藏模式">
                    <Sel<TabTextTruncate>
                      value={s.tabTextTruncate}
                      onChange={s.setTabTextTruncate}
                      options={[
                        { value: 'end',    label: '省略末尾' },
                        { value: 'middle', label: '省略中间' },
                        { value: 'start',  label: '省略开头' },
                      ]}
                    />
                  </FormRow>
                  <FormRow label="新建标签位置">
                    <Sel<TabNewPosition>
                      value={s.tabNewPosition}
                      onChange={s.setTabNewPosition}
                      options={[
                        { value: 'end',           label: '末尾' },
                        { value: 'after-current', label: '当前标签之后' },
                      ]}
                    />
                  </FormRow>
                  <FormRow label="标签标题格式">
                    <Sel<TabTitleFormat>
                      value={s.tabTitleFormat}
                      onChange={s.setTabTitleFormat}
                      options={[
                        { value: 'hostname',     label: '主机名' },
                        { value: 'user-at-host', label: '用户名@主机名' },
                      ]}
                    />
                  </FormRow>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">鼠标操作</div>
                <div className="sf-block">
                  <FormRow label="双击 (D)">
                    <Sel<TabMouseAction>
                      value={s.tabMouseDouble}
                      onChange={s.setTabMouseDouble}
                      options={MOUSE_ACTION_OPTS.filter(o => o.value !== 'menu')}
                    />
                  </FormRow>
                  <FormRow label="中键单击 (M)">
                    <Sel<TabMouseAction>
                      value={s.tabMouseMiddle}
                      onChange={s.setTabMouseMiddle}
                      options={MOUSE_ACTION_OPTS.filter(o => o.value !== 'menu')}
                    />
                  </FormRow>
                  <FormRow label="右键单击 (R)">
                    <Sel<TabMouseAction>
                      value={s.tabMouseRight}
                      onChange={s.setTabMouseRight}
                      options={MOUSE_ACTION_OPTS}
                    />
                  </FormRow>
                </div>
              </div>
            </>)}

            {/* ══ 连接 ══════════════════════════════ */}
            {section === 'connection' && (<>
              <div className="settings-group">
                <div className="settings-group-title">保持连接</div>
                <RowItem label="启用 Keepalive" desc="定期发送心跳包防止断开（作为新建连接的默认值，连接可单独修改）">
                  <Toggle on={s.keepaliveEnabled} onClick={() => s.setKeepaliveEnabled(!s.keepaliveEnabled)} />
                </RowItem>
                {s.keepaliveEnabled && (<>
                  <div className="settings-subtitle">
                    发送间隔<span className="settings-val">{s.keepaliveInterval} 秒</span>
                  </div>
                  <input type="range" className="range-input" min={15} max={300} step={15}
                    value={s.keepaliveInterval}
                    onChange={e => s.setKeepaliveInterval(Number(e.target.value))} />
                  <div className="range-labels"><span>15 s</span><span>300 s</span></div>
                </>)}
              </div>

              <div className="settings-group">
                <div className="settings-group-title">断线重连</div>
                <RowItem label="自动重连" desc="连接意外断开后自动尝试重新连接">
                  <Toggle on={s.autoReconnect} onClick={() => s.setAutoReconnect(!s.autoReconnect)} />
                </RowItem>
                {s.autoReconnect && (<>
                  <div className="settings-subtitle">
                    最大重试次数<span className="settings-val">{s.reconnectMaxRetries} 次</span>
                  </div>
                  <input type="range" className="range-input" min={1} max={10} step={1}
                    value={s.reconnectMaxRetries}
                    onChange={e => s.setReconnectMaxRetries(Number(e.target.value))} />
                  <div className="range-labels"><span>1</span><span>10</span></div>
                </>)}
              </div>

              <div className="settings-group">
                <div className="settings-group-title">
                  连接超时（新建连接默认值）<span className="settings-val">{s.connectTimeout} 秒</span>
                </div>
                <input type="range" className="range-input" min={5} max={60} step={5}
                  value={s.connectTimeout}
                  onChange={e => s.setConnectTimeout(Number(e.target.value))} />
                <div className="range-labels"><span>5 s</span><span>60 s</span></div>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">字符编码（新建连接默认值）</div>
                <div className="sf-block">
                  <FormRow label="默认编码">
                    <Sel<Encoding>
                      value={s.encoding}
                      onChange={s.setEncoding}
                      options={[
                        { value: 'UTF-8',  label: 'UTF-8' },
                        { value: 'GBK',    label: 'GBK' },
                        { value: 'GB2312', label: 'GB2312' },
                        { value: 'Latin-1', label: 'Latin-1' },
                      ]}
                    />
                  </FormRow>
                </div>
              </div>

            </>)}

            {/* ══ 代理 ══════════════════════════════ */}
            {section === 'proxy' && (<>
              <div className="settings-group">
                <div className="settings-group-title">代理类型</div>
                <SegCtrl<ProxyType>
                  options={[
                    { value: 'none',   label: '不使用代理' },
                    { value: 'http',   label: 'HTTP' },
                    { value: 'socks5', label: 'SOCKS5' },
                  ]}
                  value={s.proxyType}
                  onChange={s.setProxyType}
                />
              </div>
              {s.proxyType !== 'none' && (<>
                <div className="settings-group">
                  <div className="settings-group-title">代理服务器</div>
                  <div className="proxy-host-row">
                    <input type="text" placeholder="主机地址"
                      value={s.proxyHost} onChange={e => s.setProxyHost(e.target.value)} />
                    <input type="number" placeholder="端口" className="port-input"
                      min={1} max={65535} value={s.proxyPort || ''}
                      onChange={e => s.setProxyPort(Number(e.target.value))} />
                  </div>
                </div>
                <div className="settings-group">
                  <div className="settings-group-title">身份验证</div>
                  <RowItem label="需要认证" desc="代理服务器需要用户名和密码">
                    <Toggle on={s.proxyAuthEnabled} onClick={() => s.setProxyAuthEnabled(!s.proxyAuthEnabled)} />
                  </RowItem>
                  {s.proxyAuthEnabled && (
                    <div className="proxy-auth-form">
                      <input type="text" placeholder="用户名"
                        value={s.proxyUsername} onChange={e => s.setProxyUsername(e.target.value)} />
                      <input type="password" placeholder="密码"
                        value={s.proxyPassword} onChange={e => s.setProxyPassword(e.target.value)} />
                    </div>
                  )}
                </div>
              </>)}
            </>)}

            {/* ══ 数据库 ════════════════════════════ */}
            {section === 'database' && (<>
              <div className="settings-group settings-group--compact">
                <div className="settings-group-title">查询默认值</div>
                <div className="settings-db-card">
                  <div className="settings-db-card__main">
                    <div className="settings-row-label">SQL 查询默认行数上限</div>
                    <div className="settings-row-desc">新建 SQL 查询页执行查询时默认追加的结果行数保护，避免误查大表拖慢界面。</div>
                  </div>
                  <div className="settings-db-card__control">
                    <Sel<string>
                      value={s.dbQueryLimit == null ? '0' : String(s.dbQueryLimit)}
                      onChange={v => s.setDbQueryLimit(v === '0' ? null : Number(v))}
                      options={[
                        { value: '200',  label: '前 200 行' },
                        { value: '500',  label: '前 500 行' },
                        { value: '1000', label: '前 1000 行' },
                        { value: '0',    label: '全部（不限制）' },
                      ]}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-group settings-group--compact">
                <div className="settings-group-title">结果展示</div>
                <div className="settings-db-card settings-db-card--stack">
                  <RowItem
                    label="默认展示方式"
                    desc="新查询结果打开时默认使用的视图，不影响结果区内临时切换。"
                  >
                    <SegCtrl<DbResultDefaultView>
                      value={s.dbResultDefaultView}
                      onChange={s.setDbResultDefaultView}
                      options={[
                        { value: 'grid', label: '表格' },
                        { value: 'json', label: 'JSON' },
                        { value: 'text', label: '文本' },
                      ]}
                    />
                  </RowItem>
                  <RowItem
                    label="默认显示过滤栏"
                    desc="新查询结果打开时直接显示本地过滤栏，适合经常在结果集中二次筛选。"
                  >
                    <Toggle
                      on={s.dbResultFilterDefaultOpen}
                      onClick={() => s.setDbResultFilterDefaultOpen(!s.dbResultFilterDefaultOpen)}
                    />
                  </RowItem>
                </div>
              </div>

              <div className="settings-group settings-group--driver">
                <div className="settings-group-title">外部驱动</div>
                <DriverManager embedded />
              </div>
            </>)}

            {/* ══ 快捷键 ════════════════════════════ */}
            {section === 'shortcuts' && (
              <ShortcutsEditor />
            )}

            {/* ══ SSH 密钥 ══════════════════════════ */}
            {section === 'sshkeys' && (
              <div className="settings-group">
                <SshKeysTab />
              </div>
            )}

            {/* ══ 数据 ══════════════════════════════ */}
            {section === 'data' && (<>
              <div className="settings-group">
                <div className="settings-group-title">备份</div>
                <RowItem
                  label="加密备份/恢复连接"
                  desc="将所有连接配置（含密码）导出为加密文件，可跨设备迁移恢复。"
                >
                  <button className="data-btn" onClick={() => setConnBackupOpen(true)}>
                    <FileOutput size={14} /> 备份/恢复
                  </button>
                </RowItem>
                <RowItem
                  label="导出全部连接（JSON）"
                  desc="把所有连接配置导出为明文 JSON 备份（不含密码），适合手动编辑迁移。"
                >
                  <button
                    className="data-btn"
                    disabled={connections.length === 0}
                    onClick={() => setExportOpen(true)}
                  >
                    <FileOutput size={14} /> 导出（{connections.length}）
                  </button>
                </RowItem>
                <RowItem
                  label="从 SSH Config 导入"
                  desc="读取 ~/.ssh/config，批量导入 Host 块为 DBTerm SSH 连接。"
                >
                  <button className="data-btn" onClick={() => setSshConfigImportOpen(true)}>
                    <FileOutput size={14} /> 导入
                  </button>
                </RowItem>
              </div>

              <div className="settings-group">
                <div className="settings-group-title">清理本机数据</div>
                <RowItem
                  label="清空本机数据"
                  desc="删除本机保存的全部连接、密码与已信任主机（known_hosts），不可恢复。卸载软件前若想不留痕迹，可在此清理。"
                >
                  <button
                    className="data-btn data-btn--danger"
                    onClick={() => setWipeConfirm(true)}
                  >
                    <Trash2 size={14} /> 清空
                  </button>
                </RowItem>
                <div className="settings-note">
                  提示：macOS 把应用拖入废纸篓不会自动清除这些数据；Windows 卸载时会单独询问是否一并删除。
                </div>
              </div>
            </>)}

            {/* ══ 关于 ══════════════════════════════ */}
            {section === 'about' && (
              <div className="about-section">
                <div className="about-logo">DBTerm</div>
                <div className="about-version">v0.1.0</div>
                <div className="about-desc">
                  SSH 终端管理 + 数据库客户端，基于 Tauri + Rust 构建。<br />
                  稳定、可靠、安全，适用于生产环境。
                </div>
                <div className="about-stack">
                  {['Tauri v2', 'Rust', 'React 18', 'TypeScript'].map(t => (
                    <span key={t} className="about-tag">{t}</span>
                  ))}
                </div>
                <div className="about-copy">© 2025 DBTerm. All rights reserved.</div>
              </div>
            )}

          </div>
        </div>
      </div>

      {exportOpen && (
        <ExportDialog connections={connections} onClose={() => setExportOpen(false)} />
      )}
      {sshConfigImportOpen && <SshConfigImportDialog onClose={() => setSshConfigImportOpen(false)} />}
      {connBackupOpen && <ConnExportImportDialog onClose={() => setConnBackupOpen(false)} />}
      <ConfirmDialog
        open={wipeConfirm}
        danger
        title="清空本机数据？"
        desc="将永久删除本机保存的全部连接、密码与已信任主机（known_hosts），此操作不可恢复。建议先「导出全部连接」做好备份。"
        okText={wiping ? '清理中…' : '确认清空'}
        onOk={handleWipe}
        onCancel={() => setWipeConfirm(false)}
      />
    </div>
  )
}

// ── 可编辑快捷键组件 ─────────────────────────────────────
function ShortcutsEditor() {
  const shortcuts    = useSettingsStore(s => s.shortcuts)
  const setShortcut  = useSettingsStore(s => s.setShortcut)
  const resetShortcut = useSettingsStore(s => s.resetShortcut)
  const [recording, setRecording] = useState<string | null>(null)
  const [search, setSearch]       = useState('')
  const [collapsed, setCollapsed] = useState<Set<ShortcutGroup>>(new Set())
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!recording) return
    function onKey(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      const combo = comboFromEvent(e)
      if (!combo) return
      setShortcut(recording!, combo)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, setShortcut])

  // 同 scope 冲突检测
  function conflictWith(id: string, combo: string): string | null {
    const def = SHORTCUT_DEFS.find(d => d.id === id)
    if (!def || !combo) return null
    for (const d of SHORTCUT_DEFS) {
      if (d.id === id) continue
      if (d.scope !== def.scope && d.scope !== 'global' && def.scope !== 'global') continue
      const c = shortcuts[d.id] ?? d.defaultCombo
      if (c === combo) return d.label
    }
    return null
  }

  // 系统/终端常用键警告（Mod+C/V/X/A/Z/Q 等）
  const SYSTEM_COMBOS = new Set(['Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+Z', 'Mod+Q'])
  function isSystemConflict(combo: string): boolean {
    return SYSTEM_COMBOS.has(combo)
  }

  const query = search.trim().toLowerCase()
  const filtered = query
    ? SHORTCUT_DEFS.filter(d => d.label.includes(query) || d.id.toLowerCase().includes(query) || d.defaultCombo.toLowerCase().includes(query))
    : SHORTCUT_DEFS

  // Group by group
  const groups = Array.from(new Set(filtered.map(d => d.group)))

  function toggleGroup(g: ShortcutGroup) {
    setCollapsed(s => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n })
  }

  const hasCustom = SHORTCUT_DEFS.some(d => (shortcuts[d.id] ?? d.defaultCombo) !== d.defaultCombo)

  return (
    <div className="settings-group">
      <div className="settings-toolbar">
        <div className="settings-group-title">快捷键（点击修改）</div>
        {hasCustom && (
          <button
            className="settings-mini-btn"
            onClick={() => SHORTCUT_DEFS.forEach(d => resetShortcut(d.id))}
            data-tip="全部恢复默认"
          >
            <RotateCcw size={10} />全部重置
          </button>
        )}
      </div>
      <input
        className="settings-search-input"
        placeholder="搜索快捷键…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      {groups.map(group => {
        const items = filtered.filter(d => d.group === group)
        const isCollapsed = collapsed.has(group)
        return (
          <div key={group} className="sc-group">
            <button
              onClick={() => toggleGroup(group)}
              className={`sc-group-toggle${isCollapsed ? ' collapsed' : ''}`}
            >
              <span className="sc-group-chevron">▶</span>
              {group}
              <span className="sc-group-count">({items.length})</span>
            </button>
            {!isCollapsed && (
              <div className="sc-table">
                {items.map(def => {
                  const combo   = shortcuts[def.id] ?? def.defaultCombo
                  const keys    = displayShortcut(combo)
                  const isRec   = recording === def.id
                  const conflict = isRec ? null : conflictWith(def.id, combo)
                  const sysCon  = !isRec && !conflict && isSystemConflict(combo)
                  const isChanged = combo !== def.defaultCombo
                  return (
                    <div key={def.id} className={`sc-table-row sc-table-row--edit${isRec ? ' recording' : ''}${conflict ? ' sc-conflict' : ''}${sysCon ? ' sc-sys-conflict' : ''}`}>
                      <span className="sc-table-action" data-tip={`ID: ${def.id}`}>{def.label}</span>
                      <span className="sc-table-keys">
                        {isRec ? (
                          <span className="sc-recording-hint">按下新快捷键... Esc 取消</span>
                        ) : (
                          <span
                            className={`sc-keys-badge${conflict ? ' sc-keys-badge--conflict' : ''}${sysCon ? ' sc-keys-badge--sys-warn' : ''}`}
                            data-tip={conflict ? `冲突：与「${conflict}」相同` : sysCon ? '警告：可能与系统快捷键冲突' : '点击修改'}
                            onClick={() => setRecording(def.id)}
                          >
                            {keys.map((k, i) => (
                              <span key={i} className="sc-key-part">
                                {i > 0 && <span className="sc-sep">+</span>}
                                <kbd className="kbd">{k}</kbd>
                              </span>
                            ))}
                          </span>
                        )}
                        {isChanged && !isRec && (
                          <button
                            className="sc-reset-btn"
                            data-tip="恢复默认"
                            onClick={() => resetShortcut(def.id)}
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {recording && (
        <div
          ref={overlayRef}
          className="sc-recording-overlay"
          onClick={() => setRecording(null)}
        />
      )}
    </div>
  )
}
