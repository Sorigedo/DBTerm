import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, HardDrive, AlertCircle, CheckCircle2, Database, FolderOpen } from 'lucide-react'
import { registerExportCancelHandler, unregisterExportCancelHandler, useExportTaskStore } from '../../stores/exportTaskStore'
import { toast } from '../../stores/toastStore'
import { exportSchemaArchive } from '../../utils/schemaArchiveExport'

interface Props {
  connectionId: string
  schema: string
  connType?: string
  onClose: () => void
}

interface TableInfo {
  name: string
  isView: boolean
}
interface RoutineInfo {
  name: string
  routineType: string  // FUNCTION | PROCEDURE
}
type ObjType = 't' | 'v' | 'f' | 'p' | 's'
interface ObjItem { type: ObjType; name: string }
const TYPE_META: Record<ObjType, string> = { t: '表', v: '视图', f: '函数', p: '存储过程', s: '序列' }

interface BackupResult {
  tablesDone: number
  totalRows: number
  fileSize: number
}

interface BackupProgressEvent {
  currentTable: string
  totalTables: number
  doneTables: number
  currentRows: number
}

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

export default function BackupPanel({ connectionId, schema, connType, onClose }: Props) {
  const isMaria = connType === 'mariadb'
  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType ?? '')
  const [objects, setObjects] = useState<ObjItem[]>([])
  const [loadingTables, setLoadingTables] = useState(true)
  // 整库备份：按对象「类型」勾选，勾选的类型全量导出
  const [selTypes, setSelTypes] = useState<Set<ObjType>>(new Set())

  const [content, setContent] = useState<'structure' | 'data' | 'both'>('both')
  const [outputPath, setOutputPath] = useState('')
  const [backing, setBacking] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')

  const [progress, setProgress] = useState<BackupProgressEvent | null>(null)
  const [result, setResult] = useState<BackupResult | null>(null)

  const taskIdRef = useRef<string>('')
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { if (unlistenRef.current) unlistenRef.current() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !backing) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, backing])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableInfo[]>('list_tables', { id: connectionId, schema })
        let routines: RoutineInfo[] = []
        try { routines = await invoke<RoutineInfo[]>('list_routines', { id: connectionId, schema }) } catch { /* 部分类型不支持 */ }
        let seqNames: string[] = []
        if (isMaria) {
          try {
            type SeqInfo = { sequenceName: string; sequenceSchema: string }
            const seqs = await invoke<SeqInfo[]>('mariadb_list_sequences', { id: connectionId, schema })
            seqNames = seqs.map(s => s.sequenceName)
          } catch { /* 无序列或版本不支持 */ }
        }
        if (!alive) return
        const objs: ObjItem[] = [
          ...list.filter(t => !t.isView).map(t => ({ type: 't' as ObjType, name: t.name })),
          ...list.filter(t => t.isView).map(t => ({ type: 'v' as ObjType, name: t.name })),
          ...routines.filter(r => r.routineType === 'FUNCTION').map(r => ({ type: 'f' as ObjType, name: r.name })),
          ...routines.filter(r => r.routineType === 'PROCEDURE').map(r => ({ type: 'p' as ObjType, name: r.name })),
          ...seqNames.map(name => ({ type: 's' as ObjType, name })),
        ]
        setObjects(objs)
        // 默认勾选所有存在的对象类型
        const allTypes: ObjType[] = isMaria ? ['t', 'v', 'f', 'p', 's'] : ['t', 'v', 'f', 'p']
        setSelTypes(new Set(allTypes.filter(t => objs.some(o => o.type === t))))
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setLoadingTables(false)
      }
    })()
    return () => { alive = false }
  }, [connectionId, schema])

  const allTypes: ObjType[] = isMaria ? ['t', 'v', 'f', 'p', 's'] : ['t', 'v', 'f', 'p']
  const presentTypes = allTypes.filter(t => objects.some(o => o.type === t))
  const toggleType = (t: ObjType) => {
    setSelTypes(prev => {
      const next = new Set(prev)
      next.has(t) ? next.delete(t) : next.add(t)
      return next
    })
  }
  const toggleAll = () => {
    if (selTypes.size === presentTypes.length) setSelTypes(new Set())
    else setSelTypes(new Set(presentTypes))
  }

  const pickPath = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const path = await save({
        defaultPath: `${schema}_backup_${date}.zip`,
        filters: [{ name: 'ZIP 分表备份', extensions: ['zip'] }],
      })
      if (path) setOutputPath(path)
    } catch (e) {
      setError(String(e))
    }
  }

  const cancelBackup = async () => {
    if (!taskIdRef.current) return
    setCancelling(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_cancel_export', { taskId: taskIdRef.current })
    } catch { /* ignore */ }
  }

  const startBackup = async () => {
    if (selTypes.size === 0) { setError('请至少选择一种对象类型'); return }
    if (!outputPath) { setError('请选择输出文件路径'); return }
    // 勾选的类型 → 该类型全量名单
    const pick = (t: ObjType) => selTypes.has(t) ? objects.filter(o => o.type === t).map(o => o.name) : []

    const taskId = useExportTaskStore.getState().addTask({
      connId: connectionId,
      label: `${schema} · 整库导出`,
      filePath: outputPath,
      cancelable: true,
      message: '正在准备导出…',
    })
    taskIdRef.current = taskId

    setBacking(true)
    setCancelling(false)
    setError('')
    setProgress(null)
    setResult(null)

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')

      const unlisten = await listen<BackupProgressEvent>(`backup_progress_${taskId}`, ev => {
        const p = ev.payload
        useExportTaskStore.getState().updateTask(taskId, {
          progressRows: p.currentRows,
          progressValue: p.doneTables,
          progressTotal: p.totalTables,
          message: p.currentTable
            ? `${p.currentTable} · ${p.doneTables} / ${p.totalTables} 表 · 当前表 ${p.currentRows.toLocaleString()} 行`
            : `已完成 ${p.doneTables} / ${p.totalTables} 表`,
        })
      })
      registerExportCancelHandler(taskId, async () => {
        await invoke('db_cancel_export', { taskId }).catch(() => {})
      })
      onClose()

      void exportSchemaArchive({
        connectionId,
        connType: connType ?? 'mysql',
        schema,
        objects: { tables: pick('t'), views: pick('v'), funcs: pick('f'), procs: pick('p') },
        path: outputPath,
        content,
        taskId,
        onProgress: (table, done, total, rows) => {
          useExportTaskStore.getState().updateTask(taskId, {
            progressRows: rows, progressValue: done, progressTotal: total,
            message: `${table} · ${done} / ${total} 表`,
          })
        },
      }).then(res => {
        const current = useExportTaskStore.getState().tasks.find(task => task.id === taskId)
        if (current?.status !== 'running') return
        useExportTaskStore.getState().updateTask(taskId, {
          status: 'done',
          progressRows: res.totalRows,
          progressValue: res.tablesDone,
          progressTotal: res.tablesDone,
          fileBytes: res.fileSize,
          message: `导出完成 · ${res.tablesDone} 表 · ${res.totalRows.toLocaleString()} 行`,
          finishedAt: Date.now(),
        })
        toast.success(`整库导出完成：${res.tablesDone} 个表，${res.totalRows.toLocaleString()} 行`)
      }).catch(e => {
        const msg = String(e)
        const cancelled = msg.includes('取消') || useExportTaskStore.getState().tasks.find(task => task.id === taskId)?.status === 'cancelled'
        useExportTaskStore.getState().updateTask(taskId, {
          status: cancelled ? 'cancelled' : 'error',
          message: cancelled ? '已取消，临时文件已清理' : '导出失败',
          error: cancelled ? undefined : msg,
          finishedAt: Date.now(),
        })
        if (!cancelled) toast.error(`导出失败：${msg}`)
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
      setBacking(false)
    }
  }

  const openFolder = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { filePath: outputPath })
    } catch { /* ignore */ }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={!backing ? onClose : undefined}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{
          width: 540,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          overflow: 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <HardDrive size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>导出数据</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>{schema}</span>
          {!backing && (
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 对象类型选择（勾选的类型整库全量导出） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>导出对象类型（勾选即整库全量）</label>
              <button onClick={toggleAll} disabled={backing} style={{ fontSize: 11, color: 'var(--accent)' }}>
                {selTypes.size === presentTypes.length && presentTypes.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>
            {loadingTables ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(['t', 'v', 'f', 'p'] as ObjType[]).map(type => {
                  const count = objects.filter(o => o.type === type).length
                  const on = selTypes.has(type)
                  const empty = count === 0
                  return (
                    <button key={type} disabled={backing || empty} onClick={() => toggleType(type)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 8,
                        cursor: backing || empty ? 'default' : 'pointer', fontSize: 12.5, fontWeight: 600,
                        opacity: empty ? 0.45 : 1,
                        border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
                        background: on ? 'var(--accent)' : 'var(--surface-2)',
                        color: on ? '#fff' : 'var(--text)',
                      }}>
                      <Database size={13} />{TYPE_META[type]}
                      <span style={{ opacity: 0.85, fontWeight: 500 }}>{count}</span>
                    </button>
                  )
                })}
              </div>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              将导出 {presentTypes.filter(t => selTypes.has(t)).map(t => `${TYPE_META[t]} ${objects.filter(o => o.type === t).length}`).join(' · ') || '（未选）'}
            </span>
          </div>

          {/* 导出内容 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>导出内容</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {([['both', '结构 + 数据'], ['structure', '仅结构'], ['data', '仅数据']] as const).map(([v, label]) => (
                <button key={v} disabled={backing} onClick={() => setContent(v)}
                  style={{
                    flex: 1, padding: '7px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                    cursor: backing ? 'default' : 'pointer',
                    border: content === v ? '2px solid var(--accent)' : '1px solid var(--border)',
                    background: content === v ? 'var(--accent)' : 'var(--surface-2)',
                    color: content === v ? '#fff' : 'var(--text)',
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* PG 物理备份说明 */}
          {isPg && (
            <div style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>PostgreSQL 备份说明</div>
              <div style={{ fontSize: 11.5, color: 'var(--text)', lineHeight: 1.65 }}>
                <strong>逻辑备份（当前）：</strong>生成兼容 psql 的纯文本 SQL，支持跨版本恢复与对象筛选。恢复：<code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>psql -d dbname -f backup.sql</code>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text)', lineHeight: 1.65 }}>
                <strong>物理备份（PITR）：</strong>需在服务器端执行 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>pg_basebackup</code>，结合 WAL 归档可实现时间点恢复（Point-in-Time Recovery）。请通过 SSH 终端或专业 DBA 工具操作，本工具不直接执行物理备份。
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                推荐工具：pgBackRest / Barman / pg_basebackup —— 均支持增量备份、WAL 流式传输与自动保留策略。
              </div>
            </div>
          )}
          <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 11.5, color: 'var(--text)', lineHeight: 1.65 }}>
            将导出为 ZIP 压缩包，每张表对应一个可独立执行的 SQL 文件，便于大库分批恢复。
          </div>

          {/* 输出路径 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>输出文件</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={outputPath}
                onChange={e => setOutputPath(e.target.value)}
                placeholder="点击右侧按钮选择保存路径"
                readOnly
                disabled={backing}
                style={{ flex: 1, fontSize: 12, padding: '6px 10px', cursor: 'default' }}
              />
              <button
                onClick={pickPath}
                disabled={backing}
                style={{
                  padding: '6px 14px', borderRadius: 7, fontSize: 12,
                  background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
                  whiteSpace: 'nowrap',
                }}
              >
                选择路径…
              </button>
            </div>
          </div>

          {/* 进度区 */}
          {(backing || progress) && (
            <div style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>备份进度</span>
                {cancelling && <span style={{ fontSize: 11, color: 'var(--warning)' }}>取消中…</span>}
              </div>

              {progress ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>当前表</span>
                    <span style={{ color: 'var(--text-bright)', fontWeight: 500 }}>{progress.currentTable}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>表进度</span>
                    <span style={{ color: 'var(--text)' }}>{progress.doneTables} / {progress.totalTables}</span>
                  </div>
                  <ProgressBar value={progress.doneTables} max={progress.totalTables} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>当前表已写行数</span>
                    <span style={{ color: 'var(--text)' }}>{progress.currentRows.toLocaleString()}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>初始化中…</div>
              )}
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div style={{ fontSize: 12, color: error.includes('取消') ? 'var(--warning)' : 'var(--error)', background: error.includes('取消') ? 'rgba(232,160,32,0.08)' : 'var(--error-bg)', borderRadius: 6, padding: '8px 12px', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}

          {/* 成功结果 */}
          {result && (
            <div style={{
              background: 'rgba(62,207,142,0.08)', border: '1px solid rgba(62,207,142,0.2)',
              borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={18} color="var(--success)" />
                <span style={{ fontWeight: 600, color: 'var(--success)', fontSize: 13 }}>备份成功</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>文件大小</div>
                  <div style={{ fontWeight: 600 }}>{formatBytes(result.fileSize)}</div>
                </div>
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>总行数</div>
                  <div style={{ fontWeight: 600 }}>{result.totalRows.toLocaleString()}</div>
                </div>
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>表数量</div>
                  <div style={{ fontWeight: 600 }}>{result.tablesDone}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>{outputPath}</div>
              <button
                onClick={openFolder}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                  color: 'var(--accent)', padding: '5px 0', background: 'none',
                  alignSelf: 'flex-start',
                }}
              >
                <FolderOpen size={13} />
                在文件夹中显示
              </button>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
          {backing && (
            <button
              onClick={cancelBackup}
              disabled={cancelling}
              style={{
                padding: '7px 16px', borderRadius: 8, fontSize: 13,
                background: 'var(--error-bg)', border: '1px solid rgba(240,96,96,0.3)',
                color: 'var(--error)', opacity: cancelling ? 0.5 : 1,
              }}
            >
              {cancelling ? '取消中…' : '取消备份'}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={backing}
            style={{
              padding: '7px 16px', borderRadius: 8, fontSize: 13,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              color: 'var(--text)', opacity: backing ? 0.5 : 1,
            }}
          >
            {result ? '关闭' : '取消'}
          </button>
          {!result && (
            <button
              onClick={startBackup}
              disabled={backing || selTypes.size === 0 || !outputPath}
              style={{
                padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: 'var(--accent)', color: '#fff',
                opacity: (backing || selTypes.size === 0 || !outputPath) ? 0.5 : 1,
              }}
            >
              {backing ? '导出中…' : '开始导出'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
