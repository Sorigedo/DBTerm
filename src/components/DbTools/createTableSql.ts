import type { ConnType } from '../../types'
import { dialectFamily, qid, tableRef } from '../../utils/sqlDialect.ts'

export interface IndexSpec { name: string; columns: string; unique: boolean; method: 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL' }

export interface MysqlTableOptionState {
  loaded: boolean
  engine: string
  charset: string
  collation: string
  originalEngine: string
  originalCharset: string
  originalCollation: string
}

/**
 * Build MySQL table options only from a successfully loaded original snapshot.
 * An empty snapshot means metadata loading failed, not that the table has no
 * engine/charset. Emitting the UI defaults in that state changes unrelated
 * table metadata when the user only adds a column.
 */
export function buildMysqlTableOptionClauses(state: MysqlTableOptionState): string[] {
  if (!state.loaded) return []
  const out: string[] = []
  if (state.engine && state.engine !== state.originalEngine) out.push(`  ENGINE=${state.engine}`)
  // A successful metadata query does not guarantee TABLE_COLLATION was present.
  // In that case the form still shows its utf8mb4 default; writing it back would
  // silently alter the table when the user only adds a column.
  if (state.charset && state.originalCharset && state.charset !== state.originalCharset) {
    out.push(`  DEFAULT CHARSET=${state.charset}`)
  }
  if (state.collation && state.originalCollation && state.collation !== state.originalCollation) {
    out.push(`  COLLATE=${state.collation}`)
  }
  return out
}

/** In edit mode, wait for the actual table charset before requesting its collations. */
export function shouldFetchMysqlCollations(isMysql: boolean, isEdit: boolean, tableOptionsLoaded: boolean, charset: string): boolean {
  return isMysql && !!charset && (!isEdit || tableOptionsLoaded)
}

function sameColumns(a: string, b: string): boolean {
  const norm = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean).join('\u0001').toLowerCase()
  return norm(a) === norm(b)
}

/** Existing indexes may carry prefix lengths, expressions and options absent from the summary. */
export function validateMysqlExistingIndexEdits(indexes: IndexSpec[], originals: IndexSpec[]): string | null {
  const currentByName = new Map(indexes.map(index => [index.name.toLowerCase(), index]))
  for (const original of originals) {
    const current = currentByName.get(original.name.toLowerCase())
    if (!current || current.name !== original.name || current.columns !== original.columns
      || current.unique !== original.unique || current.method !== original.method) {
      return '现有索引的完整定义无法从摘要还原，请在 SQL 编辑器中修改原始 DDL'
    }
  }
  return null
}

export function buildIndexAlterStatements(ct: ConnType, schema: string, table: string, indexes: IndexSpec[], origIndexes: IndexSpec[], ssSchema?: string): string[] {
  const out: string[] = []
  const oldByName = new Map(origIndexes.filter(i => i.name.trim()).map(i => [i.name.trim().toLowerCase(), i]))
  const curByName = new Map(indexes.filter(i => i.name.trim() && i.columns.trim()).map(i => [i.name.trim().toLowerCase(), i]))
  const fam = dialectFamily(ct)
  const changed = (a: IndexSpec, b: IndexSpec) => a.unique !== b.unique || !sameColumns(a.columns, b.columns) || a.method !== b.method
  for (const [name, oldIdx] of oldByName) {
    // FUNCTIONAL INDEX 的 COLUMN_NAME 为 NULL，数据字典无法表示其表达式；
    // 不能把空列当作用户删除索引，否则无关的字段修改会删除唯一约束。
    if (!oldIdx.columns.trim()) continue
    const next = curByName.get(name)
    if (!next || changed(next, oldIdx)) out.push(fam === 'mysql'
      ? `  DROP INDEX ${qid(ct, oldIdx.name.trim())}`
      : `DROP INDEX ${qid(ct, oldIdx.name.trim())};`)
  }
  for (const [name, idx] of curByName) {
    const oldIdx = oldByName.get(name)
    if (oldIdx && !oldIdx.columns.trim()) continue
    if (!oldIdx || changed(idx, oldIdx)) {
      const colsSql = idx.columns.split(',').map(s => s.trim()).filter(Boolean).map(s => qid(ct, s)).join(', ')
      if (fam === 'mysql') {
        const using = idx.method === 'HASH' ? ' USING HASH' : ''
        out.push(`  ADD ${idx.unique ? 'UNIQUE INDEX' : 'INDEX'} ${qid(ct, idx.name.trim())} (${colsSql})${using}`)
      } else {
        out.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${qid(ct, idx.name.trim())} ON ${tableRef(ct, schema, table, ssSchema)} (${colsSql});`)
      }
    }
  }
  return out
}
