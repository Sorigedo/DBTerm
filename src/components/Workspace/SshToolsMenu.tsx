import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderOpen, BookOpen, BarChart2, Scissors, GitBranch,
  Video, Radio, Zap, MoreHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { SshPanelType } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SHORTCUTS, displayShortcutStr } from '../../utils/shortcuts'
import { useShortcuts } from '../../utils/useShortcuts'

const PANELS: { panel: SshPanelType; label: string; Icon: LucideIcon; shortcutId?: string }[] = [
  { panel: 'files',     label: '文件管理', Icon: FolderOpen, shortcutId: 'sshFiles'   },
  { panel: 'history',   label: '命令历史', Icon: BookOpen,   shortcutId: 'sshHistory' },
  { panel: 'perf',      label: '性能面板', Icon: BarChart2,  shortcutId: 'sshPerf'    },
  { panel: 'snippets',  label: '命令片段', Icon: Scissors },
  { panel: 'tunnel',    label: '端口转发', Icon: GitBranch },
  { panel: 'recording', label: '会话录制', Icon: Video },
]

interface Props {
  isLocalTerm: boolean
  onQuickConn?: () => void
  shortcutsEnabled?: boolean
}

export default function SshToolsMenu({ isLocalTerm, onQuickConn, shortcutsEnabled = true }: Props) {
  const activeSshPanel   = useAppStore(s => s.activeSshPanel)
  const toggleSshPanel   = useAppStore(s => s.toggleSshPanel)
  const broadcastMode    = useAppStore(s => s.broadcastMode)
  const setBroadcastMode = useAppStore(s => s.setBroadcastMode)
  const shortcuts        = useSettingsStore(s => s.shortcuts)
  const [open, setOpen]  = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const panels = isLocalTerm ? PANELS.filter(p => p.panel === 'history') : PANELS
  const quickPanels = isLocalTerm
    ? panels
    : PANELS.filter(p => p.panel === 'files' || p.panel === 'history' || p.panel === 'perf')
  const quickPanelIds = new Set(quickPanels.map(p => p.panel))
  const menuPanels = panels.filter(p => !quickPanelIds.has(p.panel))
  const hasMenu = menuPanels.length > 0 || !isLocalTerm
  const shortcutText = (id?: string) => id ? displayShortcutStr(shortcuts[id] ?? DEFAULT_SHORTCUTS[id] ?? '') : ''
  const tooltip = (label: string, id?: string) => {
    const key = shortcutText(id)
    return key ? `${label} ${key}` : label
  }

  useShortcuts('global', {
    sshFiles: () => { if (!isLocalTerm) toggleSshPanel('files') },
    sshHistory: () => toggleSshPanel('history'),
    sshPerf: () => { if (!isLocalTerm) toggleSshPanel('perf') },
  }, shortcutsEnabled)

  const pos = () => {
    const r = btnRef.current?.getBoundingClientRect()
    return r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : {}
  }

  return (
    <>
      <div className="ssh-actions__quick">
        {quickPanels.map(({ panel, label, Icon, shortcutId }) => (
          <button
            key={panel}
            className={`ssh-action-btn${activeSshPanel === panel ? ' active' : ''}`}
            onClick={() => toggleSshPanel(panel)}
            data-tooltip={tooltip(label, shortcutId)}
            data-shortcut={shortcutText(shortcutId)}
          >
            <Icon size={13} strokeWidth={1.8} />
          </button>
        ))}
      </div>
      {hasMenu && (
        <button
          ref={btnRef}
          className={`ssh-action-btn${open ? ' active' : ''}`}
          onClick={() => setOpen(v => !v)}
          data-tooltip="SSH 工具"
          style={{ border: 'none', cursor: 'pointer' }}
        >
          <MoreHorizontal size={14} strokeWidth={1.8} />
        </button>
      )}

      {hasMenu && open && createPortal(
        <>
          <div className="ssh-menu__mask" onClick={() => setOpen(false)} />
          <div className="ssh-menu" style={{ position: 'fixed', zIndex: 1000, ...pos() }}>
            {menuPanels.map(({ panel, label, Icon, shortcutId }) => (
              <button
                key={panel}
                className={`ssh-menu__item${activeSshPanel === panel ? ' active' : ''}`}
                onClick={() => { toggleSshPanel(panel); setOpen(false) }}
                data-shortcut={shortcutText(shortcutId)}
              >
                <Icon size={13} strokeWidth={1.8} />
                <span>{label}</span>
                {shortcutText(shortcutId) && <kbd>{shortcutText(shortcutId)}</kbd>}
              </button>
            ))}
            {!isLocalTerm && (
              <>
                <div className="ssh-menu__sep" />
                <button
                  className={`ssh-menu__item${broadcastMode ? ' active' : ''}`}
                  onClick={() => setBroadcastMode(!broadcastMode)}
                >
                  <Radio size={13} strokeWidth={1.8} />
                  <span>{broadcastMode ? '广播模式（已开）' : '多端广播'}</span>
                </button>
                {onQuickConn && (
                  <button
                    className="ssh-menu__item"
                    onClick={() => { onQuickConn(); setOpen(false) }}
                  >
                    <Zap size={13} strokeWidth={1.8} />
                    <span>快速连接</span>
                  </button>
                )}
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
