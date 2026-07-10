// 实例级（整连接/多库）导出：勾选多个库 → 每库一个 .sql 到指定目录
// 复用后端 db_logical_backup（按库逐个顺序执行，createDb=true 让每个文件自带建库+USE）
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, HardDrive, AlertCircle, CheckCircle2, XCircle, Database, FolderOpen, FolderInput } from 'lucide-react'
import { registerExportCancelHandler, unregisterExportCancelHandler, useExportTaskStore } from '../../stores/exportTaskStore'
import { toast } from '../../stores/toastStore'

interface Props {
  connectionId: string
  onClose: () => void
}

interface TableInfo { name: string; isView: boolean }
interface RoutineInfo { name: string; routineType: string }
interface BackupResult { tablesDone: number; totalRows: number; fileSize: number }
interface BackupProgressEvent { currentTable: string; totalTables: number; doneTables: number; currentRows: number }

interface DbResult { schema: string; ok: boolean; rows?: number; tables?: number; bytes?: number; error?: string }

type ObjType = 't' | 'v' | 'f' | 'p'
const OBJ_META: { key: ObjType; label: string }[] = [
  { key: 't', label: '表' },
  { key: 'v', label: '视图' },
  { key: 'f', label: '函数' },
  { key: 'p', label: '存储过程' },
]

// 默认不勾选的系统库（MySQL 系 + PostgreSQL）
const SYSTEM_DBS = new Set([
  'information_schema', 'mysql', 'performance_schema', 'sys',
  'pg_catalog', 'pg_toast', 'template0', 'template1',
])

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' }}>{pct}%</span>
    </div>
  )
}

export default function InstanceExportPanel({ connectionId, onClose }: Props) {
  const [schemas, setSchemas] = useState<string[]>([])
  const [loadingSchemas, setLoadingSchemas] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [content, setContent] = useState<'structure' | 'data' | 'both'>('both')
  // 每个库要导出的对象类型，默认全选（表/视图/函数/存储过程）
  const [incTypes, setIncTypes] = useState<Set<ObjType>>(new Set(['t', 'v', 'f', 'p']))
  const [outputDir, setOutputDir] = useState('')

  const [exporting, setExporting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')

  // 进度：当前库序号 / 当前库表进度
  const [dbIndex, setDbIndex] = useState(0)      // 已完成库数
  const [currentDb, setCurrentDb] = useState('')
  const [tableProg, setTableProg] = useState<BackupProgressEvent | null>(null)
  const [results, setResults] = useState<DbResult[]>([])
  const [finished, setFinished] = useState(false)

  const taskIdRef = useRef<string>('')
  const cancelledRef = useRef(false)
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { if (unlistenRef.current) unlistenRef.current() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !exporting) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, exporting])

  // 加载库列表
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: connectionId })
        if (!alive) return
        setSchemas(list)
        // 默认勾选非系统库
        setSelected(new Set(list.filter(s => !SYSTEM_DBS.has(s.toLowerCase()))))
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setLoadingSchemas(false)
      }
    })()
    return () => { alive = false }
  }, [connectionId])

  const toggle = (s: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }
  const toggleAll = () => {
    if (selected.size === schemas.length) setSelected(new Set())
    else setSelected(new Set(schemas))
  }

  const toggleIncType = (t: ObjType) => {
    setIncTypes(prev => {
      const next = new Set(prev)
      next.has(t) ? next.delete(t) : next.add(t)
      return next
    })
  }
  // 仅数据模式下，视图/函数/存储过程为定义（结构），后端不会导出
  const structDisabled = content === 'data'

  const pickDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, multiple: false, title: '选择导出目录' })
      if (typeof dir === 'string') setOutputDir(dir)
    } catch (e) { setError(String(e)) }
  }

  const cancelExport = async () => {
    cancelledRef.current = true
    setCancelling(true)
    if (!taskIdRef.current) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_cancel_export', { taskId: taskIdRef.current })
    } catch { /* ignore */ }
  }

  const startExport = async () => {
    const picked = schemas.filter(s => selected.has(s))
    if (picked.length === 0) { setError('请至少选择一个数据库'); return }
    if (incTypes.size === 0) { setError('请至少选择一种导出对象'); return }
    if (!outputDir) { setError('请选择导出目录'); return }

    const sep = outputDir.includes('\\') ? '\\' : '/'
    const taskId = useExportTaskStore.getState().addTask({
      connId: connectionId,
      label: `实例导出 · ${picked.length} 个数据库`,
      filePath: outputDir,
      cancelable: true,
      progressValue: 0,
      progressTotal: picked.length,
      message: '正在准备导出…',
    })
    taskIdRef.current = taskId
    cancelledRef.current = false

    setExporting(true)
    setCancelling(false)
    setError('')
    setResults([])
    setFinished(false)
    setDbIndex(0)
    setCurrentDb(picked[0] ?? '')
    setTableProg(null)

    const acc: DbResult[] = []
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      let currentIndex = 0
      let currentSchema = ''
      let completedRows = 0
      const unlisten = await listen<BackupProgressEvent>(`backup_progress_${taskId}`, ev => {
        const p = ev.payload
        const tableFraction = p.totalTables > 0 ? p.doneTables / p.totalTables : 0
        useExportTaskStore.getState().updateTask(taskId, {
          progressRows: completedRows + p.currentRows,
          progressValue: currentIndex + tableFraction,
          progressTotal: picked.length,
          message: `${currentSchema} · ${p.currentTable || '准备中'} · ${p.doneTables} / ${p.totalTables} 表`,
        })
      })
      registerExportCancelHandler(taskId, async () => {
        cancelledRef.current = true
        await invoke('db_cancel_export', { taskId }).catch(() => {})
      })
      onClose()

      void (async () => {
        for (let i = 0; i < picked.length; i++) {
          if (cancelledRef.current) break
          const schema = picked[i]
          currentIndex = i
          currentSchema = schema
          useExportTaskStore.getState().updateTask(taskId, {
            progressValue: i,
            message: `${schema} · 正在读取对象列表…`,
          })

          try {
            const tables = await invoke<TableInfo[]>('list_tables', { id: connectionId, schema })
            let routines: RoutineInfo[] = []
            try { routines = await invoke<RoutineInfo[]>('list_routines', { id: connectionId, schema }) } catch { /* 部分类型不支持 */ }

            const path = `${outputDir}${sep}${schema}.sql`
            const res = await invoke<BackupResult>('db_logical_backup', {
              id: connectionId,
              schema,
              tables: incTypes.has('t') ? tables.filter(t => !t.isView).map(t => t.name) : [],
              views:  incTypes.has('v') ? tables.filter(t => t.isView).map(t => t.name) : [],
              funcs:  incTypes.has('f') ? routines.filter(r => r.routineType === 'FUNCTION').map(r => r.name) : [],
              procs:  incTypes.has('p') ? routines.filter(r => r.routineType === 'PROCEDURE').map(r => r.name) : [],
              path,
              content,
              createDb: true,
              taskId,
            })
            completedRows += res.totalRows
            acc.push({ schema, ok: true, rows: res.totalRows, tables: res.tablesDone, bytes: res.fileSize })
          } catch (e) {
            const msg = String(e)
            if (msg.includes('取消')) {
              cancelledRef.current = true
              acc.push({ schema, ok: false, error: '已取消' })
              break
            }
            acc.push({ schema, ok: false, error: msg })
          }
          useExportTaskStore.getState().updateTask(taskId, {
            progressRows: completedRows,
            progressValue: i + 1,
            message: `已完成 ${i + 1} / ${picked.length} 个数据库`,
          })
        }

        const failed = acc.filter(result => !result.ok && result.error !== '已取消')
        const current = useExportTaskStore.getState().tasks.find(task => task.id === taskId)
        if (cancelledRef.current || current?.status === 'cancelled') {
          useExportTaskStore.getState().updateTask(taskId, {
            status: 'cancelled', message: `已取消 · 完成 ${acc.filter(result => result.ok).length} / ${picked.length} 个数据库`, finishedAt: Date.now(),
          })
        } else if (failed.length > 0) {
          const detail = failed.map(result => `${result.schema}: ${result.error}`).join('\n')
          useExportTaskStore.getState().updateTask(taskId, {
            status: 'error', progressRows: completedRows, message: `完成 ${acc.length - failed.length} 个，失败 ${failed.length} 个`, error: detail, finishedAt: Date.now(),
          })
          toast.error(`实例导出完成，但有 ${failed.length} 个数据库失败`)
        } else {
          useExportTaskStore.getState().updateTask(taskId, {
            status: 'done', progressRows: completedRows, progressValue: picked.length,
            message: `导出完成 · ${picked.length} 个数据库 · ${completedRows.toLocaleString()} 行`, finishedAt: Date.now(),
          })
          toast.success(`实例导出完成：${picked.length} 个数据库`)
        }
      })().catch(e => {
        const msg = String(e)
        useExportTaskStore.getState().updateTask(taskId, {
          status: 'error', message: '实例导出失败', error: msg, finishedAt: Date.now(),
        })
        toast.error(`实例导出失败：${msg}`)
      }).finally(() => {
        unregisterExportCancelHandler(taskId)
        unlisten()
      })
    } catch (e) {
      const msg = String(e)
      useExportTaskStore.getState().updateTask(taskId, {
        status: 'error', message: '无法创建导出任务', error: msg, finishedAt: Date.now(),
      })
      unregisterExportCancelHandler(taskId)
      setError(msg)
      setExporting(false)
    }
  }

  const openFolder = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const sep = outputDir.includes('\\') ? '\\' : '/'
      await invoke('reveal_in_folder', { filePath: `${outputDir}${sep}.` })
    } catch { /* ignore */ }
  }

  const pickedCount = schemas.filter(s => selected.has(s)).length
  const okCount = results.filter(r => r.ok).length
  const failCount = results.filter(r => !r.ok).length

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={!exporting ? onClose : undefined}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <HardDrive size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>导出数据库</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>整实例 · 每库一个 .sql</span>
          {!exporting && (
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 库选择 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>选择数据库（默认排除系统库）</label>
              <button onClick={toggleAll} disabled={exporting || schemas.length === 0} style={{ fontSize: 11, color: 'var(--accent)' }}>
                {selected.size === schemas.length && schemas.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>
            {loadingSchemas ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
            ) : (
              <div style={{
                maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8,
                display: 'flex', flexDirection: 'column',
              }}>
                {schemas.map(s => {
                  const on = selected.has(s)
                  const sys = SYSTEM_DBS.has(s.toLowerCase())
                  return (
                    <label key={s} style={{
                      display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px',
                      borderBottom: '1px solid var(--border-subtle)', cursor: exporting ? 'default' : 'pointer',
                      fontSize: 12.5, color: 'var(--text)',
                    }}>
                      <input type="checkbox" checked={on} disabled={exporting} onChange={() => toggle(s)} />
                      <Database size={13} color={on ? 'var(--accent)' : 'var(--text-muted)'} />
                      <span style={{ flex: 1 }}>{s}</span>
                      {sys && <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>系统库</span>}
                    </label>
                  )
                })}
              </div>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>已选 {pickedCount} 个库</span>
          </div>

          {/* 包含对象（每个库一并导出的对象类型） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>包含对象（每个库整体导出）</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {OBJ_META.map(({ key, label }) => {
                const on = incTypes.has(key)
                // 仅数据模式下，视图/函数/存储过程为定义，无法导出 → 置灰
                const disabled = exporting || (structDisabled && key !== 't')
                return (
                  <button key={key} disabled={disabled} onClick={() => toggleIncType(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8,
                      cursor: disabled ? 'default' : 'pointer', fontSize: 12.5, fontWeight: 600,
                      opacity: disabled ? 0.4 : 1,
                      border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: on ? 'var(--accent)' : 'var(--surface-2)',
                      color: on ? '#fff' : 'var(--text)',
                    }}>
                    <Database size={13} />{label}
                  </button>
                )
              })}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {structDisabled
                ? '仅数据模式：只导出表数据，视图 / 函数 / 存储过程定义不会导出'
                : '默认导出每个库下的全部对象（表结构+数据、视图、函数、存储过程）'}
            </span>
          </div>

          {/* 导出内容 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>导出内容（表）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {([['both', '结构 + 数据'], ['structure', '仅结构'], ['data', '仅数据']] as const).map(([v, label]) => (
                <button key={v} disabled={exporting} onClick={() => setContent(v)}
                  style={{
                    flex: 1, padding: '7px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                    cursor: exporting ? 'default' : 'pointer',
                    border: content === v ? '2px solid var(--accent)' : '1px solid var(--border)',
                    background: content === v ? 'var(--accent)' : 'var(--surface-2)',
                    color: content === v ? '#fff' : 'var(--text)',
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 输出目录 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>输出目录</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={outputDir}
                placeholder="点击右侧按钮选择目录"
                readOnly disabled={exporting}
                style={{ flex: 1, fontSize: 12, padding: '6px 10px', cursor: 'default' }}
              />
              <button onClick={pickDir} disabled={exporting}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 7, fontSize: 12,
                  background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', whiteSpace: 'nowrap',
                }}>
                <FolderInput size={13} /> 选择目录…
              </button>
            </div>
          </div>

          {/* 进度区 */}
          {(exporting || finished) && (
            <div style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>
                  {finished ? '导出完成' : '导出进度'}
                </span>
                {cancelling && <span style={{ fontSize: 11, color: 'var(--warning)' }}>取消中…</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>库进度</span>
                <span style={{ color: 'var(--text)' }}>{dbIndex} / {pickedCount}</span>
              </div>
              <ProgressBar value={dbIndex} max={pickedCount} />
              {exporting && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>当前库</span>
                    <span style={{ color: 'var(--text-bright)', fontWeight: 500 }}>{currentDb}</span>
                  </div>
                  {tableProg && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--text-muted)' }}>当前表 {tableProg.currentTable}</span>
                      <span style={{ color: 'var(--text)' }}>{tableProg.doneTables} / {tableProg.totalTables}</span>
                    </div>
                  )}
                </>
              )}
              {/* 每库结果列表 */}
              {results.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto', marginTop: 2 }}>
                  {results.map(r => (
                    <div key={r.schema} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                      {r.ok ? <CheckCircle2 size={13} color="var(--success)" /> : <XCircle size={13} color="var(--error)" />}
                      <span style={{ color: 'var(--text)', flex: 1 }}>{r.schema}</span>
                      {r.ok
                        ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{r.tables} 表 · {(r.rows ?? 0).toLocaleString()} 行 · {formatBytes(r.bytes ?? 0)}</span>
                        : <span style={{ color: 'var(--error)', fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>{r.error}</span>}
                    </div>
                  ))}
                </div>
              )}
              {finished && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}>
                  <span style={{ fontSize: 12, color: 'var(--success)' }}>成功 {okCount}</span>
                  {failCount > 0 && <span style={{ fontSize: 12, color: 'var(--error)' }}>失败 {failCount}</span>}
                  <button onClick={openFolder} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent)', marginLeft: 'auto' }}>
                    <FolderOpen size={13} /> 打开目录
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6, padding: '8px 12px', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
          {exporting && (
            <button onClick={cancelExport} disabled={cancelling}
              style={{
                padding: '7px 16px', borderRadius: 8, fontSize: 13,
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
                color: 'var(--error)', opacity: cancelling ? 0.5 : 1,
              }}>
              {cancelling ? '取消中…' : '取消导出'}
            </button>
          )}
          <button onClick={onClose} disabled={exporting}
            style={{
              padding: '7px 16px', borderRadius: 8, fontSize: 13,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              color: 'var(--text)', opacity: exporting ? 0.5 : 1,
            }}>
            {finished ? '关闭' : '取消'}
          </button>
          {!finished && (
            <button onClick={startExport} disabled={exporting || pickedCount === 0 || incTypes.size === 0 || !outputDir}
              style={{
                padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: 'var(--accent)', color: '#fff',
                opacity: (exporting || pickedCount === 0 || incTypes.size === 0 || !outputDir) ? 0.5 : 1,
              }}>
              {exporting ? '导出中…' : '开始导出'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
