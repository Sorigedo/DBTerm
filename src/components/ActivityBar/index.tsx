import { lazy, Suspense } from 'react'
import { LayoutGrid, Terminal, Database, Settings, PanelLeftClose, PanelLeftOpen, AppWindow } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { openNewAppWindow } from '../../utils/multiWindow'
import { toast } from '../../stores/toastStore'
import { displayShortcutStr, DEFAULT_SHORTCUTS } from '../../utils/shortcuts'
import type { ActiveView } from '../../types'

const SettingsModal = lazy(() => import('../Settings'))

const NAV: { view: ActiveView; Icon: React.ElementType; label: string }[] = [
  { view: 'all', Icon: LayoutGrid, label: '全部连接' },
  { view: 'ssh', Icon: Terminal,   label: 'SSH 会话' },
  { view: 'db',  Icon: Database,   label: '数据库' },
]

interface Props {
  panelOpen: boolean
  onTogglePanel: () => void
}

export default function ActivityBar({ panelOpen, onTogglePanel }: Props) {
  const { activeView, setActiveView, settingsOpen, openSettings, closeSettings } = useAppStore()
  const shortcuts = useSettingsStore(s => s.shortcuts)
  const scOf = (id: string) => displayShortcutStr(shortcuts[id] ?? DEFAULT_SHORTCUTS[id] ?? '')

  return (
    <>
      <div className="activity-bar">
        <div className="activity-bar__nav">
          <button
            className="activity-btn activity-btn--panel-toggle"
            onClick={onTogglePanel}
            title={panelOpen ? '收起侧栏' : '展开侧栏'}
          >
            {panelOpen
              ? <PanelLeftClose size={18} strokeWidth={1.5} />
              : <PanelLeftOpen  size={18} strokeWidth={1.5} />
            }
          </button>

          <div className="activity-bar__divider" />

          {NAV.map(({ view, Icon, label }) => (
            <button
              key={view}
              className={`activity-btn${activeView === view ? ' active' : ''}`}
              onClick={() => setActiveView(view)}
            >
              <Icon size={18} strokeWidth={1.5} />
              <span className="tooltip">{label}</span>
            </button>
          ))}
        </div>
        <div className="activity-bar__bottom">
          <button
            className="activity-btn"
            onClick={() => { openNewAppWindow().catch((e) => toast.error(`新建窗口失败：${String(e)}`)) }}
          >
            <AppWindow size={18} strokeWidth={1.5} />
            <span className="tooltip">新建窗口 <span className="tooltip-sc">{scOf('newWindow')}</span></span>
          </button>
          <button className="activity-btn" onClick={openSettings}>
            <Settings size={18} strokeWidth={1.5} />
            <span className="tooltip">设置 <span className="tooltip-sc">{scOf('openSettings')}</span></span>
          </button>
        </div>
      </div>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal onClose={closeSettings} />
        </Suspense>
      )}
    </>
  )
}
