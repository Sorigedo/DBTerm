import type { ConnType } from '../../types'
import { dialectFamily, qid, tableRef } from '../../utils/sqlDialect.ts'

export interface IndexSpec { _id?: string; name: string; columns: string; unique: boolean; method: 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL' | 'DEFAULT' }

function originalMysqlIndexSuffix(ddl: string, name: string): string | null {
  for (const rawLine of ddl.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '')
    const prefix = /^(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?(?:KEY|INDEX)\s+/i.exec(line)
    if (!prefix) continue
    let i = prefix[0].length
    let found = ''
    if (line[i] === '`') {
      const start = ++i
      while (i < line.length) {
        if (line[i] === '`' && line[i + 1] === '`') { i += 2; continue }
        if (line[i] === '`') break
        i++
      }
      if (i >= line.length) continue
      found = line.slice(start, i).replace(/``/g, '`')
      i++
    } else {
      const start = i
      while (i < line.length && !/\s|\(/.test(line[i])) i++
      found = line.slice(start, i)
    }
    if (found.toLowerCase() !== name.toLowerCase()) continue
    while (/\s/.test(line[i] ?? '')) i++
    if (line[i] !== '(') return null
    const columnsStart = i
    let depth = 0, quote = ''
    for (; i < line.length; i++) {
      const ch = line[i]
      if (quote) {
        if (ch === quote && line[i + 1] === quote) i++
        else if (ch === quote) quote = ''
        else if (ch === '\\' && quote !== '`') i++
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return line.slice(i + 1).replace(/\s+USING\s+(?:BTREE|HASH)\b/i, '').trim()
    }
    return line.slice(columnsStart).includes('(') ? null : null
  }
  return null
}

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
  const currentById = new Map(indexes.filter(i => i._id).map(i => [i._id!, i]))
  const currentByName = new Map(indexes.map(i => [i.name.toLowerCase(), i]))
  for (const original of originals) {
    if (original.columns.trim()) continue
    const current = (original._id ? currentById.get(original._id) : undefined)
      ?? currentByName.get(original.name.toLowerCase())
    if (current && (current.name !== original.name || current.columns !== original.columns
      || current.unique !== original.unique || current.method !== original.method)) {
      return '复杂索引定义不能从摘要安全修改；可删除，修改请在 SQL 编辑器中操作'
    }
  }
  return null
}

export function buildIndexAlterStatements(ct: ConnType, schema: string, table: string, indexes: IndexSpec[], origIndexes: IndexSpec[], ssSchema?: string, originalDdl = ''): string[] {
  const out: string[] = []
  const oldIndexes = origIndexes.filter(i => i.name.trim())
  indexes = indexes.map(i => !i.name.trim() && i.columns.trim() ? { ...i, name: 'idx_' + i.columns.split(',').map(s => s.trim()).filter(Boolean).join('_') } : i)
  const fam = dialectFamily(ct)
  const changed = (a: IndexSpec, b: IndexSpec) => a.unique !== b.unique || !sameColumns(a.columns, b.columns) || a.method !== b.method
  const matched = new Map<IndexSpec, IndexSpec>()
  for (const oldIdx of oldIndexes) {
    const next = (oldIdx._id && indexes.find(i => i._id === oldIdx._id))
      ?? indexes.find(i => i.name.trim().toLowerCase() === oldIdx.name.trim().toLowerCase())
    if (next) matched.set(oldIdx, next)
  }
  for (const oldIdx of oldIndexes) {
    const next = matched.get(oldIdx)
    if (!next) {
      out.push(fam === 'mysql'
        ? `  DROP INDEX ${qid(ct, oldIdx.name.trim())}`
        : `DROP INDEX ${qid(ct, oldIdx.name.trim())};`)
      continue
    }
    // FUNCTIONAL INDEX 的 COLUMN_NAME 为 NULL；保留时不重建，明确删除时仍可按名称删除。
    if (!oldIdx.columns.trim() && next.name === oldIdx.name && next.columns === oldIdx.columns
      && next.unique === oldIdx.unique && next.method === oldIdx.method) continue
    if (next.name !== oldIdx.name || changed(next, oldIdx)) out.push(fam === 'mysql'
      ? `  DROP INDEX ${qid(ct, oldIdx.name.trim())}`
      : `DROP INDEX ${qid(ct, oldIdx.name.trim())};`)
  }
  for (const idx of indexes.filter(i => i.name.trim())) {
    if (!idx.columns.trim()) continue
    const oldIdx = [...matched.entries()].find(([, current]) => current === idx)?.[0]
    if (!oldIdx || idx.name !== oldIdx.name || changed(idx, oldIdx)) {
      const colsSql = idx.columns.split(',').map(s => s.trim()).filter(Boolean).map(s => qid(ct, s)).join(', ')
      if (fam === 'mysql') {
        const using = idx.method === 'HASH' ? ' USING HASH' : ''
        const suffix = oldIdx ? originalMysqlIndexSuffix(originalDdl, oldIdx.name) : ''
        if (oldIdx && suffix === null) throw new Error(`无法从原始 DDL 读取索引 ${oldIdx.name}，已停止生成 ALTER`)
        out.push(`  ADD ${idx.method === 'FULLTEXT' ? 'FULLTEXT INDEX' : idx.method === 'SPATIAL' ? 'SPATIAL INDEX' : idx.unique ? 'UNIQUE INDEX' : 'INDEX'} ${qid(ct, idx.name.trim())} (${colsSql})${using}${suffix ? ' ' + suffix : ''}`)
      } else {
        out.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${qid(ct, idx.name.trim())} ON ${tableRef(ct, schema, table, ssSchema)} (${colsSql});`)
      }
    }
  }
  return out
}
