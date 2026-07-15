import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, ClipboardCopy, Download, FolderOpen, Loader2, Trash2, X, XCircle } from 'lucide-react'
import { useExportTaskStore, type ExportTask } from '../stores/exportTaskStore'
import { copyText } from '../utils/clipboard'

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

function TaskRow({ task, now, onShowError }: { task: ExportTask; now: number; onShowError: (task: ExportTask) => void }) {
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

  const restoreDialog = () => {
    window.dispatchEvent(new CustomEvent('dbterm:restore-export-dialog', { detail: { taskId: task.id } }))
  }

  return (
    <div className="export-dock__task">
      <div className="export-dock__task-main" onClick={restoreDialog}
        style={{ cursor: 'pointer' }} title="点击恢复导出进度弹窗">
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
          <button className="export-dock__icon-btn" onClick={e => { e.stopPropagation(); cancelTask(task.id) }} data-tip="取消导出">
            <XCircle size={13} />
          </button>
        )}
        {!running && task.filePath && (
          <button className="export-dock__icon-btn" onClick={e => { e.stopPropagation(); void reveal() }} data-tip="在文件管理器中显示">
            <FolderOpen size={13} />
          </button>
        )}
        {!running && (
          <button className="export-dock__icon-btn" onClick={e => { e.stopPropagation(); removeTask(task.id) }} data-tip="移除记录">
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {running && (
        <div className={`export-dock__progress${pct === null ? ' is-indeterminate' : ''}`}>
          <div className="export-dock__progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}
      {task.status === 'error' && task.error && (
        <button className="export-dock__error" onClick={() => onShowError(task)} title="查看完整错误"
          style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>{task.error}</button>
      )}
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
  const [errorTask, setErrorTask] = useState<ExportTask | null>(null)
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

  return createPortal(<>
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
            {tasks.map(task => <TaskRow key={task.id} task={task} now={now} onShowError={setErrorTask} />)}
          </div>
          {tasks.some(t => t.status !== 'running') && (
            <button className="export-dock__clear" onClick={clearDone}>清除已结束任务</button>
          )}
        </div>
      )}
    </div>
    {errorTask?.error && (
      <div className="cdlg-overlay" onMouseDown={() => setErrorTask(null)}>
        <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
          style={{ width: 620, maxWidth: 'calc(100vw - 32px)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <AlertCircle size={15} color="#dc2626" />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>导出错误详情</span>
            <button onClick={() => setErrorTask(null)} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{errorTask.label}</div>
            <pre style={{ margin: 0, padding: 12, maxHeight: '45vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.6, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8 }}>{errorTask.error}</pre>
          </div>
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setErrorTask(null)} style={{ padding: '7px 16px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>关闭</button>
            <button onClick={() => void copyText(errorTask.error ?? '')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'var(--accent)', color: '#fff' }}><ClipboardCopy size={13} />复制错误</button>
          </div>
        </div>
      </div>
    )}
  </>,
    document.body,
  )
}
