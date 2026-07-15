import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ConnType } from '../types'
import { qid, tableRef } from './sqlDialect'

export interface ArchiveObjectLists {
  tables: string[]
  views?: string[]
  funcs?: string[]
  procs?: string[]
}

export interface SchemaArchiveResult {
  tablesDone: number
  totalRows: number
  fileSize: number
}

interface ArchiveEntry {
  name: string
  header: string
  sourcePath?: string
  binary?: boolean
}

const pathJoin = (dir: string, name: string) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_')

function schemaContext(connType: ConnType | string, schema: string): string {
  if (!schema || connType === 'sqlite') return ''
  if (['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)) return `USE ${qid(connType, schema)};\n`
  if (connType === 'sqlServer') return `USE ${qid(connType, schema)};\nGO\n`
  if (['postgres', 'kingBase', 'openGauss'].includes(connType)) return `SET search_path TO ${qid(connType, schema)};\n`
  if (connType === 'oracle') return `ALTER SESSION SET CURRENT_SCHEMA = ${qid(connType, schema)};\n`
  if (connType === 'duckdb') return `SET schema = ${qid(connType, schema)};\n`
  if (connType === 'clickHouse') return `USE ${qid(connType, schema)};\n`
  return ''
}

export async function exportSchemaArchive(options: {
  connectionId: string
  connType: ConnType | string
  schema: string
  objects: ArchiveObjectLists
  content: 'structure' | 'data' | 'both'
  path: string
  taskId: string
  keepWorkspace?: boolean
  workspace?: string
  onProgress?: (table: string, done: number, total: number, rows: number) => void
}): Promise<SchemaArchiveResult & { workspace: string }> {
  const { connectionId, connType, schema, objects, content, path, taskId, onProgress } = options
  // SQL Server 的通用表导出会缓冲整张结果集；大表必须走专用 Tiberius 流式 ZIP 后端。
  if (connType === 'sqlServer') {
    const result = await invoke<SchemaArchiveResult>('db_logical_backup', {
      id: connectionId,
      schema,
      tables: objects.tables,
      views: objects.views ?? [],
      funcs: objects.funcs ?? [],
      procs: objects.procs ?? [],
      path,
      content,
      taskId,
    })
    return { ...result, workspace: options.workspace ?? '' }
  }
  const ownsWorkspace = !options.workspace
  const workspace = options.workspace ?? await invoke<string>('db_create_export_workspace', { taskId })
  const entries: ArchiveEntry[] = []
  let totalRows = 0
  const context = schemaContext(connType, schema)
  try {
    for (let i = 0; i < objects.tables.length; i++) {
      const table = objects.tables[i]
      let ddl = ''
      if (content !== 'data') {
        ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table })
      }
      let sourcePath: string | undefined
      let rows = 0
      if (content !== 'structure') {
        sourcePath = pathJoin(workspace, `table_${i}.sql`)
        const unlisten = await listen<{ rows: number }>(`export_progress_${taskId}`, event => {
          onProgress?.(table, i, objects.tables.length, event.payload.rows)
        })
        try {
          rows = await invoke<number>('db_stream_export', {
            id: connectionId,
            sql: `SELECT * FROM ${tableRef(connType, schema, table)}`,
            filePath: sourcePath,
            format: 'sql',
            encoding: 'utf8',
            insertTable: table,
            taskId,
            database: null,
          })
        } finally {
          unlisten()
        }
        totalRows += rows
      }
      const ddlSeparator = connType === 'sqlServer' ? '\nGO' : ''
      const header = `${context}-- DBTerm Schema 导出\n-- Schema: ${schema || '(默认)'}\n-- Table: ${table}\n${ddl ? `${ddl.trimEnd()}${ddlSeparator}\n` : ''}`
      entries.push({ name: `tables/${safeName(table)}.sql`, header, sourcePath })
      onProgress?.(table, i + 1, objects.tables.length, rows)
    }

    if (content !== 'data') {
      for (const [dir, names, kind] of [
        ['views', objects.views ?? [], 'view'],
        ['functions', objects.funcs ?? [], 'function'],
        ['procedures', objects.procs ?? [], 'procedure'],
      ] as const) {
        for (const name of names) {
          const ddl = kind === 'view'
            ? await invoke<string>('get_table_ddl', { id: connectionId, schema, table: name })
            : await invoke<string>('get_routine_ddl', { id: connectionId, schema, name, kind })
          entries.push({ name: `${dir}/${safeName(name)}.sql`, header: `${context}${ddl.trimEnd()}\n` })
        }
      }
    }

    const fileSize = await invoke<number>('db_pack_export_archive', {
      path, workspace, entries, cleanup: !options.keepWorkspace,
    })
    return { tablesDone: objects.tables.length, totalRows, fileSize, workspace }
  } catch (error) {
    if (ownsWorkspace) await invoke('db_cleanup_export_workspace', { workspace }).catch(() => {})
    throw error
  }
}

export async function packInstanceArchive(options: {
  path: string
  workspace: string
  schemaArchives: { schema: string; path: string }[]
}): Promise<number> {
  return invoke<number>('db_pack_export_archive', {
    path: options.path,
    workspace: options.workspace,
    entries: options.schemaArchives.map(item => ({
      name: `${safeName(item.schema)}.zip`, header: '', sourcePath: item.path, binary: true,
    })),
    cleanup: true,
  })
}
