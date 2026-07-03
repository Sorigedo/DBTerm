import { Terminal, Database, Plus, AppWindow } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { displayShortcut, DEFAULT_SHORTCUTS } from '../../utils/shortcuts'

// 行定义：configurable 项用 id（取用户配置 / 默认值），固定项用 combo 字符串（平台感知渲染）
interface Row { id?: string; combo?: string; desc: string }

// SSH 终端：清屏 / 终端内搜索可在设置里改（按 id 取）；其余为固定的终端/OS 行为（combo 直出）
const SSH_ROWS: Row[] = [
  { combo: 'Mod+C',          desc: '复制选中内容' },
  { combo: 'Mod+V',          desc: '粘贴' },
  { id: 'clearScreen',       desc: '清屏' },
  { id: 'termSearch',        desc: '终端内搜索' },
  { combo: 'Ctrl+C',         desc: '中断当前进程' },
  { combo: 'Ctrl+L',         desc: '清屏（clear）' },
  { combo: 'PageUp',   desc: '向上翻页' },
  { combo: 'PageDown', desc: '向下翻页' },
]

// SQL 编辑器：全部为可配置项，按 id 取有效快捷键
const DB_ROWS: Row[] = [
  { id: 'sqlRunAll',       desc: '执行全部 SQL' },
  { id: 'sqlRunSelected',  desc: '执行选中 SQL' },
  { id: 'sqlDupLine',      desc: '复制当前行' },
  { id: 'sqlDelLine',      desc: '删除当前行' },
  { id: 'sqlCopyLineUp',   desc: '向上复制行' },
  { id: 'sqlCopyLineDown', desc: '向下复制行' },
  { id: 'sqlComment',      desc: '切换注释' },
  { id: 'sqlFormat',       desc: '格式化 SQL' },
]

// 全局/窗口：可配置项，按 id 取有效快捷键
const GLOBAL_ROWS: Row[] = [
  { id: 'newWindow',     desc: '新建窗口' },
  { id: 'openSettings',  desc: '打开设置' },
  { id: 'quickSearch',   desc: '快速搜索连接' },
  { id: 'duplicateTab',  desc: '复制当前标签页' },
  { id: 'closeTab',      desc: '关闭当前标签页' },
  { id: 'dbCollapseAll', desc: '展开/收起库树' },
]

function ShortcutRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="sc-row">
      <span className="sc-keys">
        {keys.map((k, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {i > 0 && <span className="sc-sep">+</span>}
            <kbd className="kbd">{k}</kbd>
          </span>
        ))}
      </span>
      <span className="sc-desc">{desc}</span>
    </div>
  )
}

export default function EmptyState() {
  const openNewConn = useAppStore((s) => s.openNewConn)
  // 订阅用户自定义快捷键：改过后此面板即时同步
  const shortcuts = useSettingsStore((s) => s.shortcuts)

  // 解析一行的按键标签（平台感知：Win 显示 Ctrl，Mac 显示 Cmd）
  const keysOf = (r: Row): string[] => {
    const combo = r.id ? (shortcuts[r.id] ?? DEFAULT_SHORTCUTS[r.id] ?? '') : (r.combo ?? '')
    return displayShortcut(combo)
  }

  return (
    <div className="shortcuts-panel">
      <div className="shortcuts-header">
        <span className="shortcuts-logo">DBTerm</span>
        <span className="shortcuts-sub">快捷键参考</span>
      </div>

      <div className="shortcuts-grid">
        <div className="shortcuts-col">
          <div className="shortcuts-col-title">
            <Terminal size={13} strokeWidth={1.5} />
            SSH 终端
          </div>
          <div className="shortcuts-list">
            {SSH_ROWS.map((r, i) => <ShortcutRow key={i} keys={keysOf(r)} desc={r.desc} />)}
          </div>
        </div>

        <div className="shortcuts-col">
          <div className="shortcuts-col-title">
            <Database size={13} strokeWidth={1.5} />
            SQL 编辑器
          </div>
          <div className="shortcuts-list">
            {DB_ROWS.map((r, i) => <ShortcutRow key={i} keys={keysOf(r)} desc={r.desc} />)}
          </div>
        </div>

        <div className="shortcuts-col">
          <div className="shortcuts-col-title">
            <AppWindow size={13} strokeWidth={1.5} />
            全局
          </div>
          <div className="shortcuts-list">
            {GLOBAL_ROWS.map((r, i) => <ShortcutRow key={i} keys={keysOf(r)} desc={r.desc} />)}
          </div>
        </div>
      </div>

      <div className="shortcuts-actions">
        <button className="btn-sc-ssh" onClick={() => openNewConn('ssh')}>
          <Plus size={12} strokeWidth={2.5} /> 新建终端连接
        </button>
        <button className="btn-sc-db" onClick={() => openNewConn('db')}>
          <Plus size={12} strokeWidth={2.5} /> 新建数据库连接
        </button>
      </div>
    </div>
  )
}
