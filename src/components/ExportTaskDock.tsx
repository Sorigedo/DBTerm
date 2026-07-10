import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, ChevronDown, ChevronUp, Download, FolderOpen, Loader2, Trash2, XCircle } from 'lucide-react'
import { useExportTaskStore, type ExportTask } from '../stores/exportTaskStore'

const DONE_VISIBLE_MS = 8_000
const CANCELLED_VISIBLE_MS = 5_000

function fmtBytes(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtDuration(task: ExportTask, now: number) {
  const seconds = Math.max(0, Math.floor(((task.finishedAt ?? now) - task.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function TaskRow({ task, now }: { task: ExportTask; now: number }) {
  const cancelTask = useExportTaskStore(s => s.cancelTask)
  const removeTask = useExportTaskStore(s => s.removeTask)
  const running = task.status === 'running'
  const pct = task.progressTotal && task.progressTotal > 0
    ? Math.min(100, (task.progressValue ?? 0) / task.progressTotal * 100)
    : task.totalRows && task.totalRows > 0
    ? Math.min(100, task.progressRows / task.totalRows * 100)
    : null

  const reveal = async () => {
    if (!task.filePath) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { filePath: task.filePath })
    } catch { /* ignore */ }
  }

  return (
    <div className="export-dock__task">
      <div className="export-dock__task-main">
        {running ? <Loader2 size={14} className="spin export-dock__status-running" />
          : task.status === 'done' ? <CheckCircle2 size={14} className="export-dock__status-done" />
          : task.status === 'cancelled' ? <XCircle size={14} className="export-dock__status-cancelled" />
          : <XCircle size={14} className="export-dock__status-error" />}
        <div className="export-dock__task-text">
          <div className="export-dock__task-label" title={task.label}>{task.label}</div>
          <div className="export-dock__task-meta">
            {task.message || `${task.progressRows.toLocaleString()} 行${task.totalRows ? ` / ${task.totalRows.toLocaleString()} 行` : ''}`}
            {task.speed ? ` · ${task.speed.toLocaleString()} 行/秒` : ''}
            {task.fileBytes ? ` · ${fmtBytes(task.fileBytes)}` : ''}
            {` · ${fmtDuration(task, now)}`}
          </div>
        </div>
        {running && task.cancelable && (
          <button className="export-dock__icon-btn" onClick={() => cancelTask(task.id)} data-tip="取消导出">
            <XCircle size={13} />
          </button>
        )}
        {!running && task.filePath && (
          <button className="export-dock__icon-btn" onClick={reveal} data-tip="在文件管理器中显示">
            <FolderOpen size={13} />
          </button>
        )}
        {!running && (
          <button className="export-dock__icon-btn" onClick={() => removeTask(task.id)} data-tip="移除记录">
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {running && (
        <div className={`export-dock__progress${pct === null ? ' is-indeterminate' : ''}`}>
          <div className="export-dock__progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}
      {task.status === 'error' && task.error && <div className="export-dock__error">{task.error}</div>}
    </div>
  )
}

export default function ExportTaskDock() {
  const tasks = useExportTaskStore(s => s.tasks)
  const expanded = useExportTaskStore(s => s.expanded)
  const setExpanded = useExportTaskStore(s => s.setExpanded)
  const clearDone = useExportTaskStore(s => s.clearDone)
  const removeTask = useExportTaskStore(s => s.removeTask)
  const [now, setNow] = useState(Date.now())
  const running = tasks.filter(t => t.status === 'running').length
  const hasAutoExpiringTask = tasks.some(t => t.status === 'done' || t.status === 'cancelled')

  useEffect(() => {
    if (running === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  useEffect(() => {
    if (!hasAutoExpiringTask) return
    const removeExpired = () => {
      const current = Date.now()
      useExportTaskStore.getState().tasks.forEach(task => {
        if (!task.finishedAt) return
        const visibleMs = task.status === 'done'
          ? DONE_VISIBLE_MS
          : task.status === 'cancelled'
          ? CANCELLED_VISIBLE_MS
          : null
        if (visibleMs !== null && current - task.finishedAt >= visibleMs) removeTask(task.id)
      })
    }
    removeExpired()
    const timer = window.setInterval(removeExpired, 1_000)
    return () => window.clearInterval(timer)
  }, [hasAutoExpiringTask, removeTask])

  if (tasks.length === 0) return null

  return createPortal(
    <div className={`export-dock${expanded ? ' is-expanded' : ''}`}>
      <button className="export-dock__head" onClick={() => setExpanded(!expanded)}>
        <Download size={15} />
        <span>导出任务</span>
        {running > 0 && <span className="export-dock__running">{running}</span>}
        <span className="export-dock__head-spacer" />
        {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {expanded && (
        <div className="export-dock__body">
          <div className="export-dock__list">
            {tasks.map(task => <TaskRow key={task.id} task={task} now={now} />)}
          </div>
          {tasks.some(t => t.status !== 'running') && (
            <button className="export-dock__clear" onClick={clearDone}>清除已结束任务</button>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}
