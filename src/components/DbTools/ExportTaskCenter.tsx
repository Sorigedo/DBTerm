// P4 — 导出任务中心：任务进度/速度/取消/定位文件，关窗不中断
import { createPortal } from 'react-dom'
import { X, Download, CheckCircle, AlertCircle, Loader2, XCircle, FolderOpen, Trash2 } from 'lucide-react'
import { useExportTaskStore, ExportTask } from '../../stores/exportTaskStore'

interface Props {
  onClose: () => void
}

function fmtSpeed(rps?: number) {
  if (!rps || rps <= 0) return ''
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k 行/s`
  return `${Math.round(rps)} 行/s`
}

function fmtDuration(task: ExportTask) {
  const end = task.finishedAt ?? Date.now()
  const secs = Math.floor((end - task.startedAt) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function ProgressBar({ value, total }: { value: number; total?: number }) {
  const pct = total ? Math.min(100, (value / total) * 100) : null
  return (
    <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden', margin: '6px 0' }}>
      {pct !== null ? (
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s' }} />
      ) : (
        <div style={{ height: '100%', width: '30%', background: 'var(--accent)', borderRadius: 2, animation: 'indeterminate 1.4s linear infinite' }} />
      )}
    </div>
  )
}

function TaskCard({ task }: { task: ExportTask }) {
  const { cancelTask, removeTask } = useExportTaskStore()

  const openFile = () => {
    if (task.filePath) {
      // Show path in alert; actual OS open requires shell plugin
      alert(`文件路径:\n${task.filePath}`)
    }
  }

  const statusIcon = {
    running: <Loader2 size={13} color="var(--accent)" style={{ animation: 'spin 1s linear infinite' }} />,
    done: <CheckCircle size={13} color="var(--success)" />,
    error: <AlertCircle size={13} color="var(--error)" />,
    cancelled: <XCircle size={13} color="var(--warning)" />,
  }[task.status]

  const pct = task.totalRows ? Math.min(100, (task.progressRows / task.totalRows) * 100) : null

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {statusIcon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {task.label}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            {task.progressRows.toLocaleString()} 行
            {task.totalRows ? ` / ${task.totalRows.toLocaleString()} 行` : ''}
            {pct !== null ? ` (${pct.toFixed(0)}%)` : ''}
            {task.speed ? ` · ${fmtSpeed(task.speed)}` : ''}
            {' · '}{fmtDuration(task)}
          </div>
        </div>
        {task.status === 'running' && (
          <button onClick={() => cancelTask(task.id)} title="取消"
            style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--warning)', cursor: 'pointer' }}>
            <XCircle size={11} />
          </button>
        )}
        {task.status === 'done' && task.filePath && (
          <button onClick={openFile} title="定位文件"
            style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--accent)', cursor: 'pointer' }}>
            <FolderOpen size={11} />
          </button>
        )}
        {task.status !== 'running' && (
          <button onClick={() => removeTask(task.id)} title="移除"
            style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {task.status === 'running' && (
        <ProgressBar value={task.progressRows} total={task.totalRows} />
      )}

      {task.status === 'error' && task.error && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>
          {task.error.slice(0, 200)}
        </div>
      )}

      {task.status === 'done' && task.filePath && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.filePath}
        </div>
      )}
    </div>
  )
}

export default function ExportTaskCenter({ onClose }: Props) {
  const tasks = useExportTaskStore(s => s.tasks)
  const clearDone = useExportTaskStore(s => s.clearDone)
  const running = tasks.filter(t => t.status === 'running').length
  const done = tasks.filter(t => t.status !== 'running').length

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 560, display: 'flex', flexDirection: 'column', maxHeight: '80vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Download size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>导出任务中心</span>
          {running > 0 && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'var(--accent)', color: '#fff' }}>
              {running} 进行中
            </span>
          )}
          {done > 0 && (
            <button onClick={clearDone}
              style={{ marginLeft: 4, fontSize: 11, padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}>
              清除已完成
            </button>
          )}
          <button className="dbt-header-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={12} /></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {tasks.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              暂无导出任务
            </div>
          )}
          {tasks.map(t => <TaskCard key={t.id} task={t} />)}
        </div>
      </div>
    </div>,
    document.body
  )
}
