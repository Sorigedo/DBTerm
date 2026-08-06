import { useAppStore } from '../../stores/appStore'
import type { ToolId, WorkspaceTab } from '../../types'
import { wid } from '../../utils/windowTag'

export function openToolTab(toolId: ToolId, title: string) {
  const st = useAppStore.getState()
  const existing = st.tabs.find(t => t.type === 'tool' && t.toolId === toolId)
  if (existing) {
    st.setActiveTab(existing.id)
    return
  }
  const tab: WorkspaceTab = {
    id: wid(`tool-${toolId}`),
    connectionId: '__tools__',
    title,
    type: 'tool',
    toolId,
  }
  st.openTab(tab)
}
