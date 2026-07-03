// 对象（视图/函数/存储过程）编辑与 DDL 清洗：供库树右键、对象列表、详情面板共用
import { useAppStore } from '../stores/appStore'
import { wid } from './windowTag'
import { useObjectDraftStore, type ObjType } from '../stores/objectDraftStore'
import { toast } from '../stores/toastStore'
import { isMysqlFamily } from './sqlDialect'
import type { ConnType } from '../types'

const OBJ_LABEL: Record<ObjType, string> = { view: '视图', function: '函数', procedure: '存储过程' }

export function qid(connType: ConnType, ident: string): string {
  if (connType === 'sqlServer') return '[' + ident.replace(/]/g, ']]') + ']'
  if (['postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb', 'oracle'].includes(connType)) {
    return '"' + ident.replace(/"/g, '""') + '"'
  }
  return '`' + ident.replace(/`/g, '``') + '`'
}

function dialectOf(connType: ConnType): string {
  if (['postgres', 'kingBase', 'openGauss', 'duckdb'].includes(connType)) return 'postgresql'
  if (connType === 'sqlite') return 'sqlite'
  if (connType === 'sqlServer') return 'tsql'
  if (connType === 'oracle') return 'plsql'
  return 'mysql'
}

async function fmt(sql: string, connType: ConnType): Promise<string> {
  try {
    const { format } = await import('sql-formatter')
    return format(sql, { language: dialectOf(connType) as any, tabWidth: 2, keywordCase: 'upper' })
  } catch { return sql }
}

/** 新建视图骨架：与「编辑视图」走同一套格式化，保证新建与保存后再打开的样式完全一致 */
export async function buildNewViewDdl(connType: ConnType, name: string): Promise<string> {
  const formatted = await fmt('SELECT *\nFROM table_name', connType)
  return `CREATE OR REPLACE VIEW ${qid(connType, name)} AS\n${formatted}`
}

/** SHOW CREATE VIEW 的原始 DDL → 可编辑/可读的 CREATE OR REPLACE VIEW 形式（去 ALGORITHM/DEFINER/SQL SECURITY 噪声、去当前库限定、格式化 SELECT） */
export async function prettyViewDdl(raw: string, connType: ConnType, schema: string, name: string): Promise<string> {
  if (!raw) return ''
  // 仅当 raw 是完整的 CREATE … VIEW … AS … 时（MySQL SHOW CREATE VIEW 形态），剥掉 AS 之前的头部；
  // PG/Oracle 的视图定义往往只有 SELECT 主体，此时整体当主体，避免误把 SELECT 内的列别名 ` AS ` 当分隔符
  const m = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\S+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\S+\s+)?VIEW\b[\s\S]*?\sAS\s/i.exec(raw)
  const body = m ? raw.slice(m.index + m[0].length) : raw
  let select = body.trim().replace(/;\s*$/, '')
  // 去掉「当前库.」限定（已在该库下，参考 Navicat 省略）：`tttt`.`test` → `test`
  if (schema) {
    const q = qid(connType, schema).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    select = select.replace(new RegExp(q + '\\.', 'g'), '')
  }
  const formatted = await fmt(select, connType)
  return `CREATE OR REPLACE VIEW ${qid(connType, name)} AS\n${formatted}`
}

/** 去掉 DEFINER 噪声并把头部子句分行（函数体由服务器原样保留，不用 sql-formatter 以免压成一行/改写类型） */
export async function prettyRoutineDdl(raw: string, _connType: ConnType): Promise<string> {
  if (!raw) return ''
  const s = raw
    .replace(/\sDEFINER\s*=\s*`[^`]*`@`[^`]*`/i, '')
    .replace(/\sDEFINER\s*=\s*\S+@\S+/i, '')
    .trim()
  // 仅对 BEGIN 之前的「头部」分行；函数体（BEGIN…END）MySQL 会原样存储，保持其换行
  const bi = s.search(/\bBEGIN\b/i)
  const head = (bi >= 0 ? s.slice(0, bi) : s)
    .replace(/\)\s*RETURNS\s+/i, ')\nRETURNS ')
    .replace(/\s+(NOT\s+DETERMINISTIC|DETERMINISTIC)\b/gi, '\n$1')
    .replace(/\s+(CONTAINS SQL|NO SQL|READS SQL DATA|MODIFIES SQL DATA)\b/gi, '\n$1')
    .replace(/\s+(SQL SECURITY (?:DEFINER|INVOKER))\b/gi, '\n$1')
    .replace(/\s+(LANGUAGE SQL)\b/gi, '\n$1')
    .replace(/\s+(COMMENT\s)/gi, '\n$1')
    .trim()
  return bi >= 0 ? `${head}\n${s.slice(bi)}` : head
}

/** 打开「编辑」对象设计页：拉取现有定义 → 清洗 → 以 edit 模式填入编辑器 */
export async function openEditObject(p: {
  connectionId: string; connType: ConnType; schema: string; objType: ObjType; name: string
}): Promise<void> {
  const { connectionId, connType, schema, objType, name } = p
  // SQLite 只有视图（无函数/存过）
  if (connType === 'sqlite' && objType !== 'view') {
    toast.info('SQLite 不支持函数和存储过程'); return
  }
  // DuckDB 无存储过程/函数（仅视图）
  if (connType === 'duckdb' && objType !== 'view') {
    toast.info('DuckDB 不支持函数和存储过程'); return
  }
  // TiDB 不支持存储过程/函数（CREATE PROCEDURE/FUNCTION 语法报错）
  if (connType === 'tidb' && objType !== 'view') {
    toast.info('TiDB 不支持函数和存储过程'); return
  }
  // ClickHouse 暂不支持对象编辑
  if (connType === 'clickHouse') {
    toast.info('ClickHouse 暂不支持编辑此对象'); return
  }

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  type QR = { columns: string[]; rows: (string | null)[][] }
  let ddl = ''
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const esc = (s: string) => s.replace(/'/g, "''")

    if (connType === 'oracle') {
      // Oracle：DBMS_METADATA.GET_DDL（后端自动检测对象类型）
      ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table: name })

    } else if (isMysqlFamily(connType)) {
      // MySQL 系：SHOW CREATE VIEW / FUNCTION / PROCEDURE
      const ref = `${qid(connType, schema)}.${qid(connType, name)}`
      if (objType === 'view') {
        const res = await invoke<QR>('execute_query', { id: connectionId, sql: `SHOW CREATE VIEW ${ref}` })
        const ci = (res.columns ?? []).findIndex(c => /create view/i.test(c))
        ddl = await prettyViewDdl((ci >= 0 ? res.rows[0]?.[ci] : res.rows[0]?.[1]) ?? '', connType, schema, name)
      } else {
        const kind = objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
        const res = await invoke<QR>('execute_query', { id: connectionId, sql: `SHOW CREATE ${kind} ${ref}` })
        const ci = (res.columns ?? []).findIndex(c => /^create /i.test(c))
        void kind
        ddl = await prettyRoutineDdl((ci >= 0 ? res.rows[0]?.[ci] : res.rows[0]?.[2]) ?? '', connType)
      }

    } else if (isPg) {
      // PostgreSQL 系：pg_get_viewdef / pg_get_functiondef
      if (objType === 'view') {
        const res = await invoke<QR>('execute_query', {
          id: connectionId,
          sql: `SELECT definition FROM pg_views WHERE schemaname='${esc(schema)}' AND viewname='${esc(name)}'`,
        })
        const body = res.rows[0]?.[0] ?? ''
        ddl = body ? `CREATE OR REPLACE VIEW ${qid(connType, schema)}.${qid(connType, name)} AS\n${body.trim().replace(/;\s*$/, '')}` : ''
      } else {
        // FUNCTION / PROCEDURE
        const res = await invoke<QR>('execute_query', {
          id: connectionId,
          sql: `SELECT pg_get_functiondef(p.oid) `
            + `FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace `
            + `WHERE n.nspname='${esc(schema)}' AND p.proname='${esc(name)}' LIMIT 1`,
        })
        ddl = res.rows[0]?.[0] ?? ''
      }

    } else if (connType === 'sqlite') {
      // SQLite：sqlite_master 存储视图 DDL
      const res = await invoke<QR>('execute_query', {
        id: connectionId,
        sql: `SELECT sql FROM sqlite_master WHERE type='view' AND name='${esc(name)}'`,
      })
      ddl = res.rows[0]?.[0] ?? ''

    } else if (connType === 'sqlServer') {
      // SQL Server：schema 实为数据库名，走后端命令（内部 USE [库] 后取 OBJECT_DEFINITION），
      // 避免 OBJECT_ID('库.对象') 把库当 schema 而取不到定义。
      ddl = objType === 'view'
        ? await invoke<string>('get_table_ddl', { id: connectionId, schema, table: name })
        : await invoke<string>('get_routine_ddl', { id: connectionId, schema, name, kind: objType })

    } else {
      toast.info(`该数据库类型暂不支持编辑此对象（${OBJ_LABEL[objType]}）`); return
    }

    if (!ddl) ddl = `-- 未能读取到 ${OBJ_LABEL[objType]} "${name}" 的定义\n`
  } catch (e) {
    ddl = `-- 读取定义失败：${String(e)}\n`
  }
  const tabId = wid(`${connectionId}-objedit-edit-${objType}-${schema}-${name}`)
  useObjectDraftStore.getState().setDraft(tabId, { schema, objType, name, ddl, mode: 'edit' })
  useAppStore.getState().openTab({ id: tabId, connectionId, title: `编辑${OBJ_LABEL[objType]} - ${name}`, type: 'object-editor' })
}
