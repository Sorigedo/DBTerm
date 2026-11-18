import { qid } from '../../utils/sqlDialect.ts'
import { setMysqlColumnCollation } from './mysqlColumnDefinitionDetails.ts'

export interface EditableMysqlColumn {
  name: string; baseType: string; length: string; unsigned: boolean; nullable: boolean
  primaryKey: boolean; autoIncrement: boolean; defaultType: string; defaultValue: string
  comment: string; collation: string
}

// Quoted strings/identifiers and balanced expressions are opaque tokens: keywords
// inside a comment, ENUM value or generated expression must never be rewritten.
export function mysqlDefinitionTokens(sql: string): { text: string; start: number; end: number }[] {
  const tokens: { text: string; start: number; end: number }[] = []
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) { i++; continue }
    const start = i
    let depth = 0, quote = ''
    do {
      const ch = sql[i++]
      if (quote) {
        if (ch === String.fromCharCode(92) && quote !== String.fromCharCode(96)) i++
        else if (ch === quote) {
          if (sql[i] === quote) i++
          else quote = ''
        }
      } else if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth < 0) throw new Error('字段定义括号不完整')
    } while (i < sql.length && (quote || depth || !/\s/.test(sql[i])))
    if (quote || depth) throw new Error('字段定义引号或括号不完整')
    tokens.push({ text: sql.slice(start, i), start, end: i })
  }
  return tokens
}

export function mysqlString(value: string): string {
  return "'" + value.split(String.fromCharCode(92)).join(String.fromCharCode(92).repeat(2)).split("'").join("''") + "'"
}

export function mysqlColumnPositionClause(position: number, previousColumn: string): string {
  return position === 0 ? ' FIRST' : ' AFTER ' + qid('mysql', previousColumn)
}

export function editMysqlColumnDefinition(definition: string, original: EditableMysqlColumn, current: EditableMysqlColumn): string {
  if (!current.nullable && current.defaultType === 'null') current = { ...current, defaultType: 'none' }
  const tokens = mysqlDefinitionTokens(definition)
  if (tokens.length < 2 || tokens[0].text !== qid('mysql', original.name)) throw new Error('无法读取字段 ' + original.name + ' 的完整定义')
  const changes: { start: number; end: number; value: string }[] = []
  const append: string[] = []
  const upper = tokens.map(t => t.text.toUpperCase())
  const replace = (start: number, count: number, value: string) => {
    if (start < 0) {
      if (!value) return
      const boundary = value.startsWith('DEFAULT ')
        ? upper.findIndex((word, i) => i > 1 && (word === 'COMMENT' || word === 'INVISIBLE' || word === 'VISIBLE' || (word === 'ON' && upper[i + 1] === 'UPDATE')))
        : value.startsWith('AUTO_INCREMENT') || value.startsWith('COMMENT ')
          ? upper.findIndex((word, i) => i > 1 && (word === 'COMMENT' || word === 'INVISIBLE' || word === 'VISIBLE'))
          : -1
      if (boundary >= 0) changes.push({ start: tokens[boundary].start, end: tokens[boundary].start, value: value + ' ' })
      else append.push(value)
      return
    }
    changes.push({ start: tokens[start].start, end: tokens[start + count - 1].end, value })
  }
  const find = (word: string) => upper.findIndex((t, i) => i > 1 && t === word)
  if (current.name !== original.name) replace(0, 1, qid('mysql', current.name.trim()))
  if (current.baseType !== original.baseType || current.length !== original.length) {
    const type = current.baseType + (current.length.trim() ? '(' + current.length.trim() + ')' : '')
    // Validate balanced input; semicolons outside literals never belong in a type.
    const parts = mysqlDefinitionTokens(type)
    if (parts.length !== 1 || !/^[a-z][a-z0-9_]*/i.test(type) || type.includes(';')) throw new Error('字段类型或长度格式无效：' + current.name)
    replace(1, 1, type)
  }
  if (current.unsigned !== original.unsigned) {
    const index = find('UNSIGNED')
    if (index >= 0) replace(index, 1, current.unsigned ? 'UNSIGNED' : '')
    else if (current.unsigned) changes.push({ start: tokens[1].end, end: tokens[1].end, value: ' UNSIGNED' })
  }
  if (current.nullable !== original.nullable || (current.primaryKey && !original.primaryKey)) {
    const index = upper.findIndex((word, i) => i > 1 && word === 'NULL' && upper[i - 1] !== 'DEFAULT'), not = index > 0 && upper[index - 1] === 'NOT'
    replace(not ? index - 1 : index, not ? 2 : 1, current.nullable && !current.primaryKey ? 'NULL' : 'NOT NULL')
  }
  if (current.autoIncrement !== original.autoIncrement) replace(find('AUTO_INCREMENT'), 1, current.autoIncrement ? 'AUTO_INCREMENT' : '')
  if (current.defaultType !== original.defaultType || current.defaultValue !== original.defaultValue || (current.length !== original.length && ['timestamp', 'timestamp_update'].includes(current.defaultType))) {
    let value = ''
    switch (current.defaultType) {
      case 'null': value = 'NULL'; break
      case 'empty': value = "''"; break
      case 'zero': value = '0'; break
      case 'timestamp': case 'timestamp_update': value = 'CURRENT_TIMESTAMP' + (current.length && /^(TIMESTAMP|DATETIME)$/i.test(current.baseType) ? '(' + current.length + ')' : ''); break
      case 'custom': {
        const input = current.defaultValue
        value = /^(?:-?\d+(?:\.\d+)?|NULL|TRUE|FALSE|CURRENT_TIMESTAMP(?:\(\d?\))?)$/i.test(input.trim()) ? input.trim() : mysqlString(input)
      }
    }
    const index = find('DEFAULT')
    if (index >= 0 && !tokens[index + 1]) throw new Error('原始 DEFAULT 定义不完整')
    replace(index, 2, value ? 'DEFAULT ' + value : '')
    const on = upper.findIndex((word, i) => i > 1 && word === 'ON' && upper[i + 1] === 'UPDATE')
    replace(on, 3, current.defaultType === 'timestamp_update' ? 'ON UPDATE ' + value : '')
  }
  if (current.comment !== original.comment) replace(find('COMMENT'), 2, 'COMMENT ' + mysqlString(current.comment))
  let out = definition
  for (const change of changes.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, change.start) + change.value + out.slice(change.end)
  if (append.length) out += ' ' + append.join(' ')
  const lostCharacterType = current.baseType !== original.baseType && !/^(CHAR|VARCHAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|ENUM|SET)$/i.test(current.baseType)
  if (current.collation !== original.collation || lostCharacterType) {
    const changed = setMysqlColumnCollation(out, lostCharacterType ? '' : current.collation)
    if (changed === null) throw new Error('字段排序规则名称无效')
    out = changed
  }
  return out.trim()
}

export function sameMysqlColumnType(expected: Pick<EditableMysqlColumn, 'baseType' | 'length'>, actual: Pick<EditableMysqlColumn, 'baseType' | 'length'>): boolean {
  const normalize = (c: typeof expected) => {
    let type = c.baseType.toUpperCase(), length = c.length.trim()
    if (type === 'BOOLEAN' || type === 'BOOL') { type = 'TINYINT'; length = '1' }
    if (type === 'INTEGER') type = 'INT'
    if (type === 'NUMERIC' || type === 'DEC') type = 'DECIMAL'
    if (/^(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)$/.test(type)) length = ''
    if (['TIMESTAMP', 'DATETIME', 'TIME'].includes(type) && length === '0') length = ''
    if (type === 'DECIMAL') length = length ? (length.includes(',') ? length.replace(/\s/g, '') : length + ',0') : '10,0'
    return type + '(' + length + ')'
  }
  return normalize(expected) === normalize(actual)
}
