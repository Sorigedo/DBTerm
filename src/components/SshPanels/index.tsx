import PerfPanel from './PerfPanel'
import FileManagerPanel from './FileManagerPanel'
import CommandHistoryPanel from './CommandHistoryPanel'
import SnippetsPanel from './SnippetsPanel'
import TunnelPanel from './TunnelPanel'
import RecordingPanel from './RecordingPanel'
import { useAppStore } from '../../stores/appStore'

interface Props {
  sessionId: string
  panelWidth?: number
  onRunCommand?: (cmd: string) => void
}

export default function SshSidePanel({ sessionId, panelWidth, onRunCommand }: Props) {
  const { activeSshPanel, closeSshPanel } = useAppStore()

  if (!activeSshPanel) return null

  const props = { sessionId, onClose: closeSshPanel }

  return (
    <div className="ssh-side-panel" style={panelWidth ? { width: panelWidth } : undefined}>
      {activeSshPanel === 'perf'      && <PerfPanel {...props} />}
      {activeSshPanel === 'files'     && <FileManagerPanel {...props} />}
      {activeSshPanel === 'history'   && <CommandHistoryPanel {...props} onRunCommand={onRunCommand} />}
      {activeSshPanel === 'snippets'  && <SnippetsPanel {...props} onRunCommand={onRunCommand} />}
      {activeSshPanel === 'tunnel'    && <TunnelPanel {...props} />}
      {activeSshPanel === 'recording' && <RecordingPanel {...props} />}
    </div>
  )
}
