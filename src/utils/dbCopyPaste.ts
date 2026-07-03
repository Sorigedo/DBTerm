// 库对象复制/粘贴（Navicat 风格）统一逻辑：
// - 复制：写入内部剪贴板（供库内粘贴/迁移）+ 系统剪贴板（对象名，供粘贴到外部软件）+ toast。
// - 粘贴：同库同 schema → 复制表结构+数据并自动改名 _copy/_copyN；跨 schema/连接 → 打开数据迁移向导。
import { copyText } from './clipboard'
import { toast } from '../stores/toastStore'
import { notifySchemaChanged } from './schemaRefresh'
import { useDbClipboard, type DbObjRef, type DbObjType } from '../stores/dbClipboardStore'
import { qid, isMysqlFamily } from './sqlDialect'
import type { ConnType } from '../types'

export const OBJ_LABEL: Record<DbObjType, string> = {
  table: '表', view: '视图', function: '函数', procedure: '存储过程',
}

/**
 * 同一次按键可能同时命中多个监听器（对象预览的 React onKeyDown + 库树的 document keydown），
 * 导致一次操作被触发两次。用「事件标记」去重：标记原生事件对象本身，
 * 同一事件的第二个监听被跳过；不同按键 = 不同事件对象，互不影响（绝不会卡住、不会限制连续粘贴）。
 * 在键盘处理处调用：dedupeKeyEvent(e.nativeEvent ?? e)。
 */
export function dedupeKeyEvent(ev: { __dbObjHandled?: boolean } | null | undefined): boolean {
  if (!ev) return true
  if (ev.__dbObjHandled) return false
  ev.__dbObjHandled = true
  return true
}

export interface MigratePreset {
  srcId: string
  srcSchema: string
  srcTable: string
  dstId: string
  dstSchema: string
  /** 多表迁移时的全部源表（含 srcTable）；单表时省略 */
  srcTables?: string[]
}

/** 复制一个库对象：内部剪贴板 + 系统剪贴板(对象名) + 成功 toast */
export async function copyDbObject(o: DbObjRef): Promise<void> {
  useDbClipboard.getState().copy(o)
  await copyText(o.name)
  toast.success(`已复制${OBJ_LABEL[o.objType]} "${o.name}"`)
}

/**
 * 多选复制（仅表）：内部剪贴板存全部表名 + 系统剪贴板存换行分隔的表名 + toast。
 * 单个对象请用 copyDbObject。names 为空或 1 个时自动退化为单选语义。
 */
export async function copyDbObjects(primary: DbObjRef, names: string[]): Promise<void> {
  if (names.length <= 1) { await copyDbObject(primary); return }
  useDbClipboard.getState().copyMany(primary, names)
  await copyText(names.join('\n'))
  toast.success(`已复制 ${names.length} 个${OBJ_LABEL[primary.objType]}`)
}

/** 同库同 schema 复制表：自动选用 名_copy / 名_copy1 / 名_copy2… 不冲突的名字 */
async function duplicateTableInPlace(
  target: { connectionId: string; schema: string },
  srcName: string,
  existing: Set<string> | undefined,
  onDone?: () => void,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const has = existing ?? new Set<string>()
  const cand = (i: number) => (i === 0 ? `${srcName}_copy` : `${srcName}_copy${i}`)
  let lastErr = ''
  for (let i = 0; i < 200; i++) {
    const dst = cand(i)
    if (has.has(dst)) continue
    try {
      await invoke('db_copy_table', {
        id: target.connectionId, schema: target.schema,
        srcTable: srcName, dstTable: dst, copyData: true,
      })
      toast.success(`已粘贴为 "${dst}"`)
      notifySchemaChanged(target.connectionId, target.schema)
      onDone?.()
      return
    } catch (e) {
      lastErr = String(e)
      // 名字撞了（表已存在）→ 试下一个候选；其它错误直接报出
      if (/exist|already|1050/i.test(lastErr)) continue
      toast.error(lastErr)
      return
    }
  }
  toast.error(lastErr || '复制表失败')
}

// 选一个目标 schema 内不冲突的名字：forceCopy(同库) 必加 _copy；跨库无冲突则保持原名
function uniqueName(base: string, existing: Set<string>, forceCopy: boolean): string {
  if (!forceCopy && !existing.has(base)) return base
  for (let i = 0; i < 500; i++) {
    const n = i === 0 ? `${base}_copy` : `${base}_copy${i}`
    if (!existing.has(n)) return n
  }
  return `${base}_copy`
}

// 读取目标 schema 内某类对象的现有名字（用于选不冲突的目标名）
async function fetchObjectNames(connId: string, schema: string, objType: DbObjType): Promise<Set<string>> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    if (objType === 'view') {
      const list = await invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connId, schema })
      return new Set(list.filter(t => t.isView).map(t => t.name))
    }
    const list = await invoke<{ name: string; routineType: string }[]>('list_routines', { id: connId, schema })
    const rt = objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
    return new Set(list.filter(r => r.routineType === rt).map(r => r.name))
  } catch { return new Set() }
}

/**
 * 跨 schema / 跨连接 迁移视图/函数/存储过程：取源 SHOW CREATE 定义 → 去 DEFINER、
 * 重定向到目标 schema.name → 在目标连接重建（execute_query 对例程会走文本协议）。
 * 注意：视图/例程体内对源库表的引用不会改写，跨连接时被引用对象需自行保证存在。
 * 仅支持 MySQL 系源/目标：SHOW CREATE 与 backtick 重写均为 MySQL 专属，非 MySQL 直接早返回报错。
 */
export async function recreateObject(
  src: { connectionId: string; connType: ConnType; schema: string; objType: DbObjType; name: string },
  dst: { connectionId: string; connType: ConnType; schema: string; name: string },
): Promise<void> {
  if (!isMysqlFamily(src.connType) || !isMysqlFamily(dst.connType)) {
    throw new Error('仅支持从 MySQL 系数据库迁移此类对象')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  const kind = src.objType === 'view' ? 'VIEW' : src.objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
  const srcRef = `${qid(src.connType, src.schema)}.${qid(src.connType, src.name)}`
  const dstRef = `${qid(dst.connType, dst.schema)}.${qid(dst.connType, dst.name)}`

  const res = await invoke<{ rows: (string | null)[][] }>('execute_query', {
    id: src.connectionId, sql: `SHOW CREATE ${kind} ${srcRef};`,
  })
  const row = res.rows?.[0]
  // SHOW CREATE VIEW: 列1=Create View；SHOW CREATE FUNCTION/PROCEDURE: 列2=Create ...
  const ddl = (kind === 'VIEW' ? row?.[1] : row?.[2]) ?? ''
  if (!ddl) throw new Error(`无法获取${OBJ_LABEL[src.objType]}定义`)

  let body = ddl
    .replace(/\sDEFINER\s*=\s*`[^`]*`@`[^`]*`/i, '')
    .replace(/\sDEFINER\s*=\s*\S+@\S+/i, '')
  if (kind === 'VIEW') {
    body = body.replace(/\bVIEW\s+(`[^`]+`\.)?`[^`]+`/i, `VIEW ${dstRef}`)
  } else {
    body = body.replace(new RegExp(`\\b${kind}\\s+(\`[^\`]+\`\\.)?\`[^\`]+\``, 'i'), `${kind} ${dstRef}`)
  }

  // 目标名已确保唯一，DROP IF EXISTS 不会误删已有对象，仅作幂等保护
  await invoke('execute_query', { id: dst.connectionId, sql: `DROP ${kind} IF EXISTS ${dstRef};` })
  await invoke('execute_query', { id: dst.connectionId, sql: body })
}

/**
 * 把内部剪贴板里的对象粘贴到目标 schema：
 * - 表：同库 → 复制结构+数据(改名 _copy)；跨库/跨连接 → 打开数据迁移向导。
 * - 视图/函数/存储过程：重建定义（同库改名 _copy；跨库/跨连接保持原名，冲突再 _copy）。
 */
export async function pasteDbObject(
  target: { connectionId: string; connType: ConnType; schema: string },
  opts: { existingNames?: Set<string>; openMigrate: (p: MigratePreset) => void; onDone?: () => void },
): Promise<void> {
  const { clipboard: clip, clipboardTables } = useDbClipboard.getState()
  if (!clip) { toast.info('剪贴板为空，请先复制一个对象'); return }

  const sameSchema = clip.connectionId === target.connectionId && clip.schema === target.schema
  // 多选复制的全部表名（兜底为主对象名），与单选共用同一条粘贴路径
  const tableNames = clipboardTables.length ? clipboardTables : [clip.name]

  // ── 表 ──
  if (clip.objType === 'table') {
    if (sameSchema) {
      // 同库同 schema：逐个复制结构+数据并自动改名（_copy/_copyN）
      for (const name of tableNames) {
        await duplicateTableInPlace(target, name, opts.existingNames, opts.onDone)
      }
    } else {
      // 跨库/跨连接：打开数据迁移向导，预选全部源表（多表则默认全部勾选）
      opts.openMigrate({
        srcId: clip.connectionId, srcSchema: clip.schema, srcTable: clip.name,
        dstId: target.connectionId, dstSchema: target.schema,
        srcTables: tableNames,
      })
    }
    return
  }

  // ── 视图 / 函数 / 存储过程：重建定义实现迁移 ──
  try {
    const existing = await fetchObjectNames(target.connectionId, target.schema, clip.objType)
    const dstName = uniqueName(clip.name, existing, sameSchema)
    await recreateObject(
      { connectionId: clip.connectionId, connType: clip.connType, schema: clip.schema, objType: clip.objType, name: clip.name },
      { connectionId: target.connectionId, connType: target.connType, schema: target.schema, name: dstName },
    )
    toast.success(sameSchema
      ? `已粘贴${OBJ_LABEL[clip.objType]} "${dstName}"`
      : `已迁移${OBJ_LABEL[clip.objType]} "${dstName}" 到 ${target.schema}`)
    notifySchemaChanged(target.connectionId, target.schema)
    opts.onDone?.()
  } catch (e) {
    toast.error(`粘贴${OBJ_LABEL[clip.objType]}失败：${e}`)
  }
}
