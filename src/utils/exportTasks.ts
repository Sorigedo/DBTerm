import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { toast } from '../stores/toastStore'
import { registerExportCancelHandler, unregisterExportCancelHandler, useExportTaskStore, type ExportTask } from '../stores/exportTaskStore'

export interface ExportProgressEvent {
  rows: number
  elapsed_ms: number
  rows_per_sec: number
  file_bytes: number
  done: boolean
  cancelled: boolean
  error: string | null
}

interface MongoExportProgressEvent {
  rows: number
  current: string
  done: number
  total: number
}

export async function listenMongoExportProgress(taskId: string): Promise<UnlistenFn> {
  return listen<MongoExportProgressEvent>(`mongo_export_progress_${taskId}`, event => {
    const p = event.payload
    useExportTaskStore.getState().updateTask(taskId, {
      progressRows: p.rows,
      progressValue: p.done,
      progressTotal: p.total > 1 ? p.total : undefined,
      message: `${p.current || '集合'} · ${p.rows.toLocaleString()} 个文档${p.total > 1 ? ` · ${p.done} / ${p.total} 个集合` : ''}`,
    })
  })
}

interface TableExportOptions {
  connectionId: string
  schema: string
  table: string
  format: string
  formatLabel: string
  path: string
  structure?: 'only' | 'with'
  whereClause?: string | null
}

interface BackgroundExportOptions<T> {
  connectionId: string
  label: string
  filePath?: string
  message?: string
  totalRows?: number
  run: (taskId: string) => Promise<T>
  complete: (result: T) => Partial<ExportTask>
  prepare?: (taskId: string) => Promise<UnlistenFn | void>
  cancel?: (taskId: string) => void | Promise<void>
  successMessage?: string | ((result: T) => string)
  errorPrefix?: string
}

export function queueBackgroundExport<T>(options: BackgroundExportOptions<T>): string {
  const store = useExportTaskStore.getState()
  const taskId = store.addTask({
    connId: options.connectionId,
    label: options.label,
    filePath: options.filePath,
    totalRows: options.totalRows,
    cancelable: Boolean(options.cancel),
    message: options.message ?? '正在导出…',
  })
  if (options.cancel) {
    registerExportCancelHandler(taskId, () => options.cancel?.(taskId))
  }

  void (async () => {
    let cleanup: UnlistenFn | void = undefined
    try {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
      cleanup = await options.prepare?.(taskId)
      const result = await options.run(taskId)
      const current = useExportTaskStore.getState().tasks.find(task => task.id === taskId)
      if (current?.status !== 'running') return
      useExportTaskStore.getState().updateTask(taskId, {
        ...options.complete(result),
        status: 'done',
        finishedAt: Date.now(),
      })
      const message = typeof options.successMessage === 'function'
        ? options.successMessage(result)
        : options.successMessage
      if (message) toast.success(message)
    } catch (error) {
      const message = String(error)
      const current = useExportTaskStore.getState().tasks.find(task => task.id === taskId)
      const cancelled = current?.status === 'cancelled' || message.includes('取消')
      useExportTaskStore.getState().updateTask(taskId, {
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? '已取消' : '导出失败',
        error: cancelled ? undefined : message,
        finishedAt: Date.now(),
      })
      if (!cancelled) toast.error(`${options.errorPrefix ?? '导出失败'}：${message}`)
    } finally {
      unregisterExportCancelHandler(taskId)
      cleanup?.()
    }
  })()

  return taskId
}

export function queueLocalTextExport(
  path: string,
  content: string,
  label: string,
  connectionId = 'local-export',
): string {
  return queueBackgroundExport({
    connectionId,
    label,
    filePath: path,
    run: () => invoke('write_local_file', { path, content }),
    complete: () => ({ fileBytes: new Blob([content]).size, message: '导出完成' }),
    successMessage: `${label}完成`,
  })
}

export function updateExportTaskFromProgress(taskId: string, progress: ExportProgressEvent) {
  const store = useExportTaskStore.getState()
  store.updateTask(taskId, {
    progressRows: progress.rows,
    speed: progress.rows_per_sec,
    fileBytes: progress.file_bytes || undefined,
    message: progress.done ? undefined : `已导出 ${progress.rows.toLocaleString()} 行`,
  })
}

export async function listenExportTaskProgress(taskId: string): Promise<UnlistenFn> {
  return listen<ExportProgressEvent>(`export_progress_${taskId}`, event => {
    updateExportTaskFromProgress(taskId, event.payload)
  })
}

export async function queueTableExport(options: TableExportOptions): Promise<string> {
  const { connectionId, schema, table, format, formatLabel, path, structure, whereClause = null } = options
  const store = useExportTaskStore.getState()
  const taskId = store.addTask({
    connId: connectionId,
    label: `${table} · ${structure === 'only' ? '表结构' : structure === 'with' ? '结构与数据' : formatLabel}`,
    filePath: path,
    cancelable: false,
    message: '正在准备导出…',
  })
  let unlisten: UnlistenFn
  try {
    unlisten = await listenExportTaskProgress(taskId)
  } catch (error) {
    useExportTaskStore.getState().updateTask(taskId, {
      status: 'error', message: '无法监听导出进度', error: String(error), finishedAt: Date.now(),
    })
    throw error
  }

  void invoke<number>('db_export_table', {
    id: connectionId,
    schema,
    table,
    format: structure ? 'sql' : format,
    whereClause,
    path,
    structure: structure ?? null,
    taskId,
  }).then(rows => {
    const current = useExportTaskStore.getState().tasks.find(task => task.id === taskId)
    if (current?.status === 'cancelled') return
    useExportTaskStore.getState().updateTask(taskId, {
      status: 'done',
      progressRows: rows,
      message: structure === 'only' ? '表结构导出完成' : `已导出 ${rows.toLocaleString()} 行`,
      finishedAt: Date.now(),
      filePath: path,
    })
    toast.success(structure === 'only' ? '表结构导出完成' : `导出完成：${rows.toLocaleString()} 行`)
  }).catch(error => {
    const message = String(error)
    useExportTaskStore.getState().updateTask(taskId, {
      status: message.includes('已取消') ? 'cancelled' : 'error',
      error: message,
      message: message.includes('已取消') ? '已取消' : '导出失败',
      finishedAt: Date.now(),
    })
    if (!message.includes('已取消')) toast.error(`导出失败：${message}`)
  }).finally(() => {
    unlisten()
  })

  return taskId
}

export function registerStreamExportCancellation(
  taskId: string,
  connectionId: string,
  queryToken: () => string | null,
  onCancel?: () => void,
) {
  registerExportCancelHandler(taskId, async () => {
    onCancel?.()
    await invoke('db_cancel_export', { taskId }).catch(() => {})
    const token = queryToken()
    if (token) await invoke('db_cancel_query', { id: connectionId, token }).catch(() => {})
  })
}
