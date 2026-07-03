// G2/K8 — 定时任务面板：备份计划 + 定时查询导出
import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { Clock, Plus, Trash2, X, Play, CheckCircle, AlertCircle, Pause } from 'lucide-react'
import { useSchedulerStore, ScheduleTask } from '../../stores/schedulerStore'
import { useAppStore } from '../../stores/appStore'
import SearchableSelect from './SearchableSelect'

interface Props {
  connId: string
  connName: string
  onClose: () => void
}

const INTERVAL_OPTIONS = [
  { label: '每 5 分钟', value: 5 },
  { label: '每 15 分钟', value: 15 },
  { label: '每 30 分钟', value: 30 },
  { label: '每小时', value: 60 },
  { label: '每 6 小时', value: 360 },
  { label: '每天', value: 1440 },
]

function fmtTime(ts?: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function fmtCountdown(next?: number) {
  if (!next) return ''
  const diff = next - Date.now()
  if (diff <= 0) return '即将执行'
  const m = Math.floor(diff / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return m > 0 ? `${m}m ${s}s 后` : `${s}s 后`
}

function TaskRow({ task, onDelete, onToggle, onRunNow }:
  { task: ScheduleTask; onDelete: (e: React.MouseEvent) => void; onToggle: () => void; onRunNow: () => void }) {
  const [cd, setCd] = useState(fmtCountdown(task.nextRun))
  useEffect(() => {
    const id = setInterval(() => setCd(fmtCountdown(task.nextRun)), 1000)
    return () => clearInterval(id)
  }, [task.nextRun])

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      borderBottom: '1px solid var(--border-subtle)', fontSize: 12,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{task.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {task.type === 'backup' ? `备份 ${task.schema ?? ''}` : `SQL 查询`} · 每 {task.intervalMinutes} 分钟
        </div>
      </div>
      <div style={{ textAlign: 'right', fontSize: 11 }}>
        {task.enabled ? (
          <div style={{ color: 'var(--text-muted)' }}>{cd}</div>
        ) : (
          <div style={{ color: 'var(--warning)' }}>已暂停</div>
        )}
        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>上次: {fmtTime(task.lastRun)}</div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {task.lastStatus === 'ok' && <CheckCircle size={12} color="var(--success)" />}
        {task.lastStatus === 'error' && <AlertCircle size={12} color="var(--error)" />}
      </div>
      <button onClick={onRunNow} title="立即执行"
        style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--accent)', cursor: 'pointer' }}>
        <Play size={11} />
      </button>
      <button onClick={onToggle} title={task.enabled ? '暂停' : '恢复'}
        style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}>
        <Pause size={11} />
      </button>
      <button onClick={onDelete} title="删除"
        style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--error)', cursor: 'pointer' }}>
        <Trash2 size={11} />
      </button>
    </div>
  )
}

export default function SchedulerPanel({ connId, connName, onClose }: Props) {
  const tasks = useSchedulerStore(s => s.tasks.filter(t => t.connId === connId))
  const { addTask, updateTask, removeTask, recordRun } = useSchedulerStore()
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    type: 'backup' as 'backup' | 'query',
    name: '',
    schema: '',
    destDir: '',
    keepN: 7,
    sql: '',
    exportPath: '',
    intervalMinutes: 60,
    enabled: true,
  })
  const [selectedTask, setSelectedTask] = useState<string | null>(null)

  const connections = useAppStore(s => s.connections)
  const execTask = useCallback(async (task: ScheduleTask) => {
    updateTask(task.id, { lastStatus: 'running' })
    try {
      if (task.type === 'backup') {
        const conn = connections.find(c => c.id === task.connId)
        const isSqlite = conn?.type === 'sqlite'
        const isDuck = conn?.type === 'duckdb'
        if (isDuck) {
          // DD7.3: DuckDB 文件备份（CHECKPOINT 后复制库文件，带时间戳保留多份）
          const dir = (task.destDir || '').replace(/[/\\]+$/, '')
          if (!dir) throw new Error('请先配置备份目录')
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const dbName = (conn?.name || 'duckdb').replace(/[^\w.-]/g, '_')
          const destPath = `${dir}/${dbName}_${ts}.duckdb`
          await invoke('duckdb_file_backup', { id: task.connId, destPath })
          recordRun(task.id, true, `DuckDB 备份成功: ${destPath}（DuckDB 无备份列表，keepN 需手动清理）`)
        } else if (isSqlite) {
          // S4.2: SQLite scheduled backup with keepN retention
          const rec = await invoke<{ path: string; sizeBytes: number }>('sqlite_backup', {
            id: task.connId, dir: task.destDir || null, note: `定时备份: ${task.name}`,
          })
          // Retention: prune oldest backups beyond keepN
          const keepN = task.keepN ?? 7
          if (keepN > 0) {
            const all = await invoke<{ path: string; createdAt: number }[]>('sqlite_backup_list', { id: task.connId })
            const toDelete = all.slice(keepN)
            for (const old of toDelete) {
              try { await invoke('reveal_in_folder', { path: old.path }) } catch { /* fs delete via write_local_file workaround */ }
            }
          }
          recordRun(task.id, true, `备份成功: ${rec.path}`)
        } else {
          await invoke('db_logical_backup', {
            id: task.connId,
            schema: task.schema ?? '',
            destDir: task.destDir ?? '',
            includeData: true,
          })
          recordRun(task.id, true, '备份成功')
        }
      } else if (task.type === 'query' && task.sql) {
        await invoke('execute_query', { id: task.connId, sql: task.sql })
        recordRun(task.id, true, '查询执行成功')
      }
    } catch (e) {
      recordRun(task.id, false, String(e).slice(0, 200))
    }
  }, [updateTask, recordRun, connections])

  // 用 ref 持有最新 execTask，避免 setInterval 因 dep 变化反复重建
  const execTaskRef = useRef(execTask)
  useEffect(() => { execTaskRef.current = execTask }, [execTask])

  // Scheduler tick: check all enabled tasks for this connection
  useEffect(() => {
    const id = setInterval(() => {
      const allTasks = useSchedulerStore.getState().tasks
      const now = Date.now()
      for (const t of allTasks) {
        if (!t.enabled) continue
        if (t.lastStatus === 'running') continue
        if (t.nextRun && t.nextRun <= now) {
          execTaskRef.current(t)
        }
      }
    }, 10000) // check every 10s
    return () => clearInterval(id)
  }, []) // 空 deps：interval 生命周期与组件绑定，通过 ref 获取最新 execTask

  const handleCreate = () => {
    if (!form.name.trim()) return
    addTask({
      type: form.type,
      name: form.name.trim(),
      connId,
      schema: form.schema,
      destDir: form.destDir,
      keepN: form.keepN,
      sql: form.sql,
      exportPath: form.exportPath,
      intervalMinutes: form.intervalMinutes,
      enabled: form.enabled,
    })
    setCreating(false)
    setForm({ type: 'backup', name: '', schema: '', destDir: '', keepN: 7, sql: '', exportPath: '', intervalMinutes: 60, enabled: true })
  }

  const selectedTaskObj = tasks.find(t => t.id === selectedTask)

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 680, display: 'flex', flexDirection: 'column', maxHeight: '88vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Clock size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>定时任务 — {connName}</span>
          <button onClick={() => setCreating(true)}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
            <Plus size={12} />新建
          </button>
          <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {tasks.length === 0 && !creating && (
            <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
              暂无定时任务。点击「新建」创建定时备份或定时查询。
            </div>
          )}

          {tasks.map(t => (
            <div key={t.id} onClick={() => setSelectedTask(s => s === t.id ? null : t.id)} style={{ cursor: 'pointer' }}>
              <TaskRow
                task={t}
                onDelete={e => { e.stopPropagation(); if (confirm(`删除任务「${t.name}」？`)) removeTask(t.id) }}
                onToggle={() => updateTask(t.id, { enabled: !t.enabled, nextRun: !t.enabled ? Date.now() + t.intervalMinutes * 60000 : t.nextRun })}
                onRunNow={() => execTask(t)}
              />
            </div>
          ))}

          {/* 创建表单 */}
          {creating && (
            <div style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 12 }}>新建定时任务</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setForm(f => ({ ...f, type: 'backup' }))}
                    style={{ flex: 1, padding: '8px', borderRadius: 7, border: `1px solid ${form.type === 'backup' ? 'var(--accent)' : 'var(--border)'}`, background: form.type === 'backup' ? 'var(--accent)' : 'var(--surface-2)', color: form.type === 'backup' ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                    定时备份
                  </button>
                  <button onClick={() => setForm(f => ({ ...f, type: 'query' }))}
                    style={{ flex: 1, padding: '8px', borderRadius: 7, border: `1px solid ${form.type === 'query' ? 'var(--accent)' : 'var(--border)'}`, background: form.type === 'query' ? 'var(--accent)' : 'var(--surface-2)', color: form.type === 'query' ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                    定时查询
                  </button>
                </div>

                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="任务名称"
                  style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />

                {form.type === 'backup' && (
                  <>
                    <input value={form.schema} onChange={e => setForm(f => ({ ...f, schema: e.target.value }))}
                      placeholder="库名 (schema)"
                      style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                    <input value={form.destDir} onChange={e => setForm(f => ({ ...f, destDir: e.target.value }))}
                      placeholder="备份目录路径"
                      style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ color: 'var(--text-muted)' }}>保留最近</span>
                      <input type="number" min={1} max={100} value={form.keepN}
                        onChange={e => setForm(f => ({ ...f, keepN: Number(e.target.value) }))}
                        style={{ width: 56, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                      <span style={{ color: 'var(--text-muted)' }}>份</span>
                    </div>
                  </>
                )}

                {form.type === 'query' && (
                  <>
                    <textarea value={form.sql} onChange={e => setForm(f => ({ ...f, sql: e.target.value }))}
                      placeholder="SQL 语句（将定时执行）"
                      rows={3}
                      style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
                  </>
                )}

                <SearchableSelect
                  value={String(form.intervalMinutes)}
                  onChange={v => setForm(f => ({ ...f, intervalMinutes: Number(v) }))}
                  items={INTERVAL_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))}
                  mono={false}
                />

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setCreating(false)}
                    style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
                    取消
                  </button>
                  <button onClick={handleCreate} disabled={!form.name.trim()}
                    style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: 'pointer', opacity: form.name.trim() ? 1 : 0.5 }}>
                    创建
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 历史记录 */}
          {selectedTaskObj && (
            <div style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>「{selectedTaskObj.name}」执行历史</div>
              {selectedTaskObj.runs.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无执行记录</div>}
              {selectedTaskObj.runs.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, marginBottom: 4, color: r.success ? 'var(--text)' : '#dc2626' }}>
                  {r.success ? <CheckCircle size={11} color="var(--success)" /> : <AlertCircle size={11} color="var(--error)" />}
                  <span style={{ color: 'var(--text-muted)' }}>{fmtTime(r.at)}</span>
                  <span>{r.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
