import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, X, ArrowUp, ArrowDown, Check } from 'lucide-react'
import { toast } from '../../stores/toastStore'
import SearchableSelect from './SearchableSelect'
import type { ConnType } from '../../types'
import {
  qid, tableRef, sqlStr, dialectFamily, isMysqlFamily,
  supportsUnsigned, supportsTableOptions, supportsInlineComment, supportsCommentOn,
  autoIncrementColumn,
} from '../../utils/sqlDialect'

// ── 数据模型 ─────────────────────────────────────────────────────────────────

type DefaultType = 'none' | 'null' | 'empty' | 'timestamp' | 'timestamp_update' | 'zero' | 'custom'
type IndexMethod = 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL'
type FKAction    = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL'
type TriggerTiming = 'BEFORE' | 'AFTER'
type TriggerEvent  = 'INSERT' | 'UPDATE' | 'DELETE'

interface NewCol {
  _id: string
  name: string
  baseType: string
  length: string
  unsigned: boolean
  nullable: boolean
  primaryKey: boolean
  autoIncrement: boolean
  defaultType: DefaultType
  defaultValue: string
  comment: string
}

interface NewIndex {
  _id: string
  name: string
  columns: string       // 逗号分隔字段名
  unique: boolean
  method: IndexMethod
}

interface NewFK {
  _id: string
  name: string
  localCols: string     // 逗号分隔本地字段
  refTable: string
  refCols: string       // 逗号分隔引用字段
  onDelete: FKAction
  onUpdate: FKAction
}

interface NewTrigger {
  _id: string
  name: string
  timing: TriggerTiming
  event: TriggerEvent
  body: string
}

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  editTable?: string   // 提供时进入「修改表结构」编辑模式
  onClose: () => void
  onDone: () => void
}

// ── 静态常量 ─────────────────────────────────────────────────────────────────

const BASE_TYPES = [
  'INT', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT',
  'DECIMAL', 'FLOAT', 'DOUBLE',
  'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR',
  'JSON', 'BLOB', 'LONGBLOB', 'BINARY', 'VARBINARY',
  'ENUM', 'SET', 'BIT', 'BOOLEAN',
]
const PG_TYPES = [
  'INTEGER', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL',
  'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE PRECISION',
  'VARCHAR', 'CHAR', 'TEXT',
  'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'INTERVAL',
  'BOOLEAN', 'JSON', 'JSONB', 'UUID', 'BYTEA',
  'INET', 'CIDR', 'MACADDR', 'XML', 'MONEY',
]
const SQLITE_TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN']
const DUCKDB_TYPES = [
  'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT',
  'DECIMAL', 'REAL', 'DOUBLE',
  'VARCHAR', 'TEXT', 'DATE', 'TIMESTAMP', 'TIME',
  'BOOLEAN', 'JSON', 'BLOB', 'UUID',
]
const SQLSERVER_TYPES = [
  'TINYINT', 'SMALLINT', 'INT', 'BIGINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY', 'BIT',
  'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'NTEXT',
  'BINARY', 'VARBINARY', 'IMAGE',
  'DATE', 'TIME', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET',
  'UNIQUEIDENTIFIER', 'XML',
]
const ORACLE_TYPES = [
  'NUMBER', 'INTEGER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE',
  'CHAR', 'VARCHAR2', 'NCHAR', 'NVARCHAR2', 'CLOB', 'NCLOB', 'BLOB',
  'DATE', 'TIMESTAMP', 'RAW', 'LONG', 'ROWID',
]
const CLICKHOUSE_TYPES = [
  'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Float32', 'Float64', 'Decimal', 'Bool',
  'String', 'FixedString', 'UUID',
  'Date', 'Date32', 'DateTime', 'DateTime64', 'JSON',
]

/** 按方言返回字段类型候选列表 */
function typesFor(connType: ConnType): string[] {
  if (connType === 'sqlServer')  return SQLSERVER_TYPES
  if (connType === 'oracle')     return ORACLE_TYPES
  if (connType === 'clickHouse') return CLICKHOUSE_TYPES
  const fam = dialectFamily(connType)
  if (fam === 'postgres') return PG_TYPES   // 达梦(dm)归 postgres 族，借用 PG 类型
  if (fam === 'sqlite')   return SQLITE_TYPES
  if (fam === 'duckdb')   return DUCKDB_TYPES
  return BASE_TYPES
}

// 数值类型（用于 UNSIGNED / 自增 / 默认 0 判断）——覆盖 MySQL 与 PG/DuckDB 类型名
const NUMERIC_TYPES  = new Set([
  'INT', 'INTEGER', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'HUGEINT',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'DOUBLE PRECISION', 'REAL', 'BIT', 'MONEY',
])
const DATETIME_TYPES = new Set([
  'DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ',
  'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET',   // sqlServer
])
const DEFAULT_LENGTH: Record<string, string> = {
  VARCHAR: '255', CHAR: '32', DECIMAL: '10,2', NUMERIC: '10,2', BIT: '1',
  VARCHAR2: '255', NVARCHAR: '255', NVARCHAR2: '255', NCHAR: '32', VARBINARY: '255', FixedString: '32',  // mssql/oracle/clickhouse
}
const FK_ACTIONS: FKAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL']
const ROW_FORMATS = ['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']
const supportsRowFormat = (connType: ConnType) => connType === 'mysql' || connType === 'mariadb'

// MySQL 8.0 回退字符集（服务器可用时会被替换）
const MYSQL_ENGINES_FALLBACK = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'BLACKHOLE', 'FEDERATED', 'MRG_MYISAM']
const MYSQL_CHARSETS_FALLBACK = [
  'utf8mb4', 'utf8mb3', 'gbk', 'gb18030', 'gb2312', 'big5', 'latin1', 'ascii', 'binary',
  'armscii8', 'cp1250', 'cp1251', 'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866', 'cp932',
  'dec8', 'eucjpms', 'euckr', 'geostd8', 'greek', 'hebrew', 'hp8', 'keybcs2',
  'koi8r', 'koi8u', 'latin2', 'latin5', 'latin7', 'macce', 'macroman',
  'sjis', 'swe7', 'tis620', 'ucs2', 'ujis', 'utf16', 'utf16le', 'utf32',
]
const CHARSET_PRIORITY = ['utf8mb4', 'utf8mb3', 'utf8', 'gbk', 'gb18030', 'gb2312', 'big5', 'latin1', 'ascii', 'binary']

function sortCharsets(names: string[]): string[] {
  const head = CHARSET_PRIORITY.filter(c => names.includes(c))
  const rest = names.filter(c => !CHARSET_PRIORITY.includes(c)).sort()
  return [...head, ...rest]
}

function normalizePositiveInt(raw: string): string | null {
  const v = raw.trim()
  if (!/^\d+$/.test(v)) return null
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 1) return null
  return String(n)
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function uid() { return `c-${Date.now()}-${Math.random().toString(36).slice(2)}` }

function newCol(over?: Partial<NewCol>): NewCol {
  return {
    _id: uid(), name: '', baseType: 'VARCHAR', length: '255',
    unsigned: false, nullable: true, primaryKey: false, autoIncrement: false,
    defaultType: 'none', defaultValue: '', comment: '', ...over,
  }
}

// 解析 MySQL COLUMN_TYPE（如 "varchar(255)" / "bigint(20) unsigned" / "decimal(10,2)"）
function parseColumnType(raw: string): { baseType: string; length: string; unsigned: boolean } {
  const lower = raw.toLowerCase()
  const unsigned = /\bunsigned\b/.test(lower)
  const cleaned = lower.replace(/\s+unsigned/g, '').replace(/\s+zerofill/g, '').trim()
  const m = cleaned.match(/^(\w+)(?:\(([^)]*)\))?/)
  if (!m) return { baseType: raw.toUpperCase(), length: '', unsigned }
  return { baseType: m[1].toUpperCase(), length: m[2] ?? '', unsigned }
}

// 将 information_schema.COLUMNS（全部 CAST AS CHAR）的一行映射为 NewCol
// 列序：name, type, nullable, key, default, extra, comment
function rowToCol(r: (string | null)[]): NewCol {
  const name    = String(r[0] ?? '')
  const type    = String(r[1] ?? '')
  const nullable = String(r[2] ?? '').toUpperCase() === 'YES'
  const key     = String(r[3] ?? '')
  const def     = r[4]
  const extra   = String(r[5] ?? '').toLowerCase()
  const comment = String(r[6] ?? '')
  const { baseType, length, unsigned } = parseColumnType(type)
  const onUpdate = extra.includes('on update current_timestamp')
  let defaultType: DefaultType = 'none'
  let defaultValue = ''
  if (def === null || def === undefined) {
    defaultType = onUpdate ? 'timestamp_update' : (nullable ? 'null' : 'none')
  } else if (/^current_timestamp/i.test(String(def))) {
    defaultType = onUpdate ? 'timestamp_update' : 'timestamp'
  } else if (String(def) === '') {
    defaultType = 'empty'
  } else {
    defaultType = 'custom'; defaultValue = String(def)
  }
  return newCol({
    name, baseType, length, unsigned, nullable,
    primaryKey: key === 'PRI',
    autoIncrement: extra.includes('auto_increment'),
    defaultType, defaultValue, comment,
  })
}

function newFK(): NewFK {
  return { _id: uid(), name: '', localCols: '', refTable: '', refCols: '', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }
}

function newTrigger(): NewTrigger {
  return { _id: uid(), name: '', timing: 'AFTER', event: 'INSERT', body: 'BEGIN\n  -- 在此编写触发器逻辑\nEND' }
}

// ── SQL 生成 ─────────────────────────────────────────────────────────────────

function colType(c: NewCol, ct: ConnType): string {
  let t = c.baseType
  if (c.length.trim()) t += `(${c.length.trim()})`
  if (c.unsigned && NUMERIC_TYPES.has(c.baseType) && supportsUnsigned(ct)) t += ' UNSIGNED'
  return t
}

// 列定义（不含前导缩进）。注意：PG/DuckDB 不支持内联 COMMENT，注释由 buildSql 单独生成 COMMENT ON。
// 返回值含 inlinePk 标记：SQLite 自增列必须写成 INTEGER PRIMARY KEY AUTOINCREMENT，故由列定义自带主键。
function columnDef(c: NewCol, ct: ConnType): string {
  const fam = dialectFamily(ct)
  let typeSql = colType(c, ct)
  let trailingAuto = ''
  let inlinePk = false
  if (c.autoIncrement && NUMERIC_TYPES.has(c.baseType)) {
    const ai = autoIncrementColumn(ct, c.baseType)
    typeSql = ai.typeSql            // SERIAL/BIGSERIAL/INTEGER 不带长度
    trailingAuto = ai.trailing
    inlinePk = ai.inlinePk
  }
  let def = `${qid(ct, c.name.trim())} ${typeSql}`
  if (inlinePk) {                    // sqlite: INTEGER PRIMARY KEY AUTOINCREMENT，不再叠加其它修饰
    return `${def} PRIMARY KEY AUTOINCREMENT`
  }
  if (!c.nullable || c.primaryKey) def += ' NOT NULL'
  if (trailingAuto) def += ` ${trailingAuto}`
  if (c.defaultType === 'null')                  def += ' DEFAULT NULL'
  else if (c.defaultType === 'empty')            def += " DEFAULT ''"
  else if (c.defaultType === 'timestamp')        def += ' DEFAULT CURRENT_TIMESTAMP'
  else if (c.defaultType === 'timestamp_update') def += fam === 'mysql'
    ? ' DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    : ' DEFAULT CURRENT_TIMESTAMP'   // 非 MySQL 无 ON UPDATE 子句
  else if (c.defaultType === 'zero')             def += ' DEFAULT 0'
  else if (c.defaultType === 'custom' && c.defaultValue.trim()) {
    const v   = c.defaultValue.trim()
    const raw = /^(CURRENT_TIMESTAMP|NULL|TRUE|FALSE)$/i.test(v) || /^-?\d+(\.\d+)?$/.test(v)
    def += ` DEFAULT ${raw ? v : sqlStr(v)}`
  }
  if (c.comment && supportsInlineComment(ct)) def += ` COMMENT ${sqlStr(c.comment)}`
  return def
}

/** PG/DuckDB 的列/表注释独立语句（建表后追加） */
function commentStatements(ct: ConnType, tref: string, tableComment: string, cols: NewCol[]): string[] {
  if (!supportsCommentOn(ct)) return []
  const out: string[] = []
  if (tableComment) out.push(`COMMENT ON TABLE ${tref} IS ${sqlStr(tableComment)};`)
  for (const c of cols) {
    if (c.name.trim() && c.comment) out.push(`COMMENT ON COLUMN ${tref}.${qid(ct, c.name.trim())} IS ${sqlStr(c.comment)};`)
  }
  return out
}

// 修改表结构：对比原始列快照生成 ALTER 语句（按方言）
function buildAlterSql(opts: {
  connType: ConnType
  schema: string; table: string; comment: string
  engine: string; charset: string; collation: string; rowFormat: string; autoIncStart: string
  cols: NewCol[]; origCols: NewCol[]
  origEngine: string; origCharset: string; origCollation: string; origRowFormat: string; origAutoIncStart: string; origComment: string
}): string {
  const {
    connType: ct, schema, table, comment, engine, charset, collation, rowFormat, autoIncStart,
    cols, origCols, origEngine, origCharset, origCollation, origRowFormat, origAutoIncStart, origComment,
  } = opts
  const fam = dialectFamily(ct)
  const canUseRowFormat = supportsRowFormat(ct)
  const valid = cols.filter(c => c.name.trim())
  if (valid.length === 0) return '-- 至少保留一个字段'
  const tref = tableRef(ct, schema, table)
  const origById = new Map(origCols.map(o => [o._id, o]))
  const curIds   = new Set(valid.map(c => c._id))

  if (fam === 'mysql') {
    // —— MySQL/MariaDB：单条 ALTER + 多子句 ——
    const clauses: string[] = []
    for (const o of origCols) if (!curIds.has(o._id)) clauses.push(`  DROP COLUMN ${qid(ct, o.name.trim())}`)
    for (const c of valid) {
      const orig = origById.get(c._id)
      if (!orig) clauses.push(`  ADD COLUMN ${columnDef(c, ct)}`)
      else if (columnDef(orig, ct) !== columnDef(c, ct) || orig.name.trim() !== c.name.trim()) {
        if (orig.name.trim() !== c.name.trim()) clauses.push(`  CHANGE COLUMN ${qid(ct, orig.name.trim())} ${columnDef(c, ct)}`)
        else clauses.push(`  MODIFY COLUMN ${columnDef(c, ct)}`)
      }
    }
    if (engine && engine !== origEngine) clauses.push(`  ENGINE=${engine}`)
    if (charset && charset !== origCharset) clauses.push(`  DEFAULT CHARSET=${charset}`)
    if (collation && collation !== origCollation) clauses.push(`  COLLATE=${collation}`)
    if (canUseRowFormat && rowFormat && rowFormat !== origRowFormat) clauses.push(`  ROW_FORMAT=${rowFormat}`)
    const hasAutoInc = valid.some(c => c.autoIncrement)
    if (hasAutoInc && autoIncStart.trim()) {
      const nextAutoInc = normalizePositiveInt(autoIncStart)
      if (!nextAutoInc) return '-- 自动递增值必须是大于等于 1 的整数'
      if (nextAutoInc !== origAutoIncStart) clauses.push(`  AUTO_INCREMENT=${nextAutoInc}`)
    }
    if (comment !== origComment) clauses.push(`  COMMENT=${sqlStr(comment)}`)
    if (clauses.length === 0) return '-- 结构未发生变化'
    return `ALTER TABLE ${tref}\n${clauses.join(',\n')};`
  }

  // —— PG 系 / DuckDB / SQLite：每个变更一条独立语句 ——
  const stmts: string[] = []
  for (const o of origCols) if (!curIds.has(o._id)) stmts.push(`ALTER TABLE ${tref} DROP COLUMN ${qid(ct, o.name.trim())};`)
  for (const c of valid) {
    const orig = origById.get(c._id)
    if (!orig) { stmts.push(`ALTER TABLE ${tref} ADD COLUMN ${columnDef(c, ct)};`); continue }
    if (orig.name.trim() !== c.name.trim()) {
      stmts.push(`ALTER TABLE ${tref} RENAME COLUMN ${qid(ct, orig.name.trim())} TO ${qid(ct, c.name.trim())};`)
    }
    if (colType(orig, ct) !== colType(c, ct)) {
      if (fam === 'sqlite') stmts.push(`-- SQLite 不支持修改列「${c.name.trim()}」类型，请删除后重建该列或重建表`)
      else stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${qid(ct, c.name.trim())} TYPE ${colType(c, ct)};`)
    }
    if (fam !== 'sqlite' && orig.nullable !== c.nullable && !c.primaryKey) {
      stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${qid(ct, c.name.trim())} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`)
    }
    if (supportsCommentOn(ct) && (orig.comment || '') !== (c.comment || '')) {
      stmts.push(`COMMENT ON COLUMN ${tref}.${qid(ct, c.name.trim())} IS ${c.comment ? sqlStr(c.comment) : 'NULL'};`)
    }
  }
  if (supportsCommentOn(ct) && comment !== origComment) {
    stmts.push(`COMMENT ON TABLE ${tref} IS ${comment ? sqlStr(comment) : 'NULL'};`)
  }
  if (stmts.length === 0) return '-- 结构未发生变化'
  return stmts.join('\n')
}

function buildSql(opts: {
  connType: ConnType
  schema: string; table: string; comment: string
  engine: string; charset: string; collation: string
  rowFormat: string; autoIncStart: string
  cols: NewCol[]; indexes: NewIndex[]; fkeys: NewFK[]; triggers: NewTrigger[]
}): string {
  const { connType: ct, schema, table, comment, engine, charset, collation, rowFormat, autoIncStart, cols, indexes, fkeys, triggers } = opts
  const fam = dialectFamily(ct)
  const canUseRowFormat = supportsRowFormat(ct)
  const q = (s: string) => qid(ct, s)
  const valid = cols.filter(c => c.name.trim())
  if (!table.trim() || valid.length === 0) return '-- 请填写表名和至少一个字段'

  const lines = valid.map(c => `  ${columnDef(c, ct)}`)

  // 主键：SQLite 自增列已内联 PRIMARY KEY，排除以免重复
  const pks = valid.filter(c => c.primaryKey && !(c.autoIncrement && fam === 'sqlite' && NUMERIC_TYPES.has(c.baseType)))
  if (pks.length > 0) lines.push(`  PRIMARY KEY (${pks.map(c => q(c.name.trim())).join(', ')})`)

  // 索引：MySQL 内联 KEY；其余方言改为建表后的 CREATE INDEX
  const postIdx: string[] = []
  const tref = tableRef(ct, schema, table.trim())
  for (const idx of indexes) {
    const idxCols = idx.columns.split(',').map(s => s.trim()).filter(Boolean)
    if (idxCols.length === 0) continue
    const idxName = idx.name.trim() || `idx_${idxCols.join('_')}`
    if (fam === 'mysql') {
      const baseKw  = idx.method === 'FULLTEXT' ? 'FULLTEXT INDEX'
        : idx.method === 'SPATIAL' ? 'SPATIAL INDEX'
        : idx.unique ? 'UNIQUE KEY' : 'KEY'
      const using = idx.method === 'HASH' ? ' USING HASH' : ''
      lines.push(`  ${baseKw} ${q(idxName)} (${idxCols.map(q).join(', ')})${using}`)
    } else {
      // PG/SQLite/DuckDB：独立 CREATE INDEX；FULLTEXT/SPATIAL 退化为普通索引
      const using = (fam === 'postgres' && idx.method === 'HASH') ? ' USING HASH' : ''
      postIdx.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${q(idxName)} ON ${tref}${using} (${idxCols.map(q).join(', ')});`)
    }
  }

  for (const fk of fkeys) {
    const localCols = fk.localCols.split(',').map(s => s.trim()).filter(Boolean)
    const refCols   = fk.refCols.split(',').map(s => s.trim()).filter(Boolean)
    if (!fk.refTable.trim() || localCols.length === 0 || refCols.length === 0) continue
    const fkName = fk.name.trim() || `fk_${localCols.join('_')}`
    lines.push(
      `  CONSTRAINT ${q(fkName)} FOREIGN KEY (${localCols.map(q).join(', ')})` +
      ` REFERENCES ${q(fk.refTable.trim())} (${refCols.map(q).join(', ')})` +
      ` ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
    )
  }

  let sql = `CREATE TABLE ${tref} (\n${lines.join(',\n')}\n)`
  if (supportsTableOptions(ct)) {       // ENGINE/CHARSET/ROW_FORMAT/AUTO_INCREMENT 仅 MySQL 系
    sql += ` ENGINE=${engine} DEFAULT CHARSET=${charset}`
    if (collation) sql += ` COLLATE=${collation}`
    if (canUseRowFormat && rowFormat && rowFormat !== 'DEFAULT') sql += ` ROW_FORMAT=${rowFormat}`
    const nextAutoInc = normalizePositiveInt(autoIncStart)
    if (nextAutoInc && nextAutoInc !== '1') sql += ` AUTO_INCREMENT=${nextAutoInc}`
    if (comment) sql += ` COMMENT=${sqlStr(comment)}`
  }
  sql += ';'

  // 非 MySQL 的独立索引语句
  for (const s of postIdx) sql += `\n${s}`

  // PG/DuckDB 的表/列注释独立语句
  for (const s of commentStatements(ct, tref, comment, valid)) sql += `\n${s}`

  // 触发器：MySQL 直接生成；PG/SQLite 触发器需独立函数/语法不同，此处仅 MySQL 系支持
  if (fam === 'mysql') {
    for (const tr of triggers) {
      if (!tr.name.trim() || !tr.body.trim()) continue
      sql += `\n\nCREATE TRIGGER ${q(tr.name.trim())} ${tr.timing} ${tr.event}\nON ${tref} FOR EACH ROW\n${tr.body.trim()};`
    }
  }

  return sql
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

type Tab = 'fields' | 'indexes' | 'fkeys' | 'triggers' | 'options' | 'sql'

export default function CreateTableWizard({ connectionId, connType, schema, editTable, onClose, onDone }: Props) {
  const isEdit = !!editTable
  const fam  = dialectFamily(connType)
  const isMy = isMysqlFamily(connType)         // ENGINE/CHARSET/SHOW/UNSIGNED 等 MySQL 专属 UI 的开关
  const canUseRowFormat = supportsRowFormat(connType)
  const TYPE_OPTIONS = typesFor(connType)
  const [tab, setTab]       = useState<Tab>('fields')
  const [table, setTable]   = useState(editTable ?? '')
  const [comment, setComment]           = useState('')
  const [engine, setEngine]             = useState('InnoDB')
  const [charset, setCharset]           = useState('utf8mb4')
  const [collation, setCollation]       = useState('')
  const [rowFormat, setRowFormat]       = useState('DEFAULT')
  const [autoIncStart, setAutoIncStart] = useState('1')
  const [cols, setCols]     = useState<NewCol[]>(editTable ? [] : [
    // 默认主键列：SQLite 自增必须 INTEGER；Oracle 用 NUMBER、ClickHouse 用 Int64；其余 BIGINT（PG 生成 BIGSERIAL，mssql 生成 IDENTITY）。UNSIGNED 仅 MySQL 系。
    newCol({ name: 'id',
      baseType: fam === 'sqlite' ? 'INTEGER' : connType === 'oracle' ? 'NUMBER' : connType === 'clickHouse' ? 'Int64' : 'BIGINT',
      length: '',
      unsigned: isMysqlFamily(connType), nullable: false, primaryKey: true, autoIncrement: true }),
  ])
  // 编辑模式：原始结构快照
  const [origCols, setOrigCols]       = useState<NewCol[]>([])
  const [origEngine, setOrigEngine]   = useState('')
  const [origCharset, setOrigCharset] = useState('')
  const [origCollation, setOrigCollation] = useState('')
  const [origRowFormat, setOrigRowFormat] = useState('DEFAULT')
  const [origAutoIncStart, setOrigAutoIncStart] = useState('')
  const [origComment, setOrigComment] = useState('')
  const [editLoaded, setEditLoaded]   = useState(false)
  const [currentDdl, setCurrentDdl]   = useState('')
  const [indexes, setIndexes]   = useState<NewIndex[]>([])
  const [fkeys, setFkeys]       = useState<NewFK[]>([])
  const [triggers, setTriggers] = useState<NewTrigger[]>([])
  const [executing, setExecuting]   = useState(false)
  const [execErr, setExecErr]       = useState('')
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null)
  const [pickerModal, setPickerModal]       = useState<string | null>(null)
  const [engines, setEngines]   = useState<string[]>(MYSQL_ENGINES_FALLBACK)
  const [charsets, setCharsets] = useState<string[]>(MYSQL_CHARSETS_FALLBACK)
  const [collations, setCollations] = useState<string[]>([])
  const modalRef = useRef<HTMLDivElement>(null)

  // 拉取引擎 / 字符集（仅 MySQL 系；SHOW ENGINES / SHOW CHARACTER SET 是 MySQL 专属）
  useEffect(() => {
    if (!isMy) return
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type Rows = { rows: (string | null)[][] }
        try {
          const cs = await invoke<Rows>('execute_query', { id: connectionId, sql: 'SHOW CHARACTER SET' })
          const names = cs.rows.map(r => String(r[0] ?? '')).filter(Boolean)
          if (!cancelled && names.length) setCharsets(sortCharsets(names))
        } catch { /* 用回退列表 */ }
        try {
          const eg = await invoke<Rows>('execute_query', { id: connectionId, sql: 'SHOW ENGINES' })
          const sup  = eg.rows.filter(r => r[1] === 'DEFAULT' || r[1] === 'YES')
          const def  = sup.filter(r => r[1] === 'DEFAULT').map(r => String(r[0]))
          const rest = sup.filter(r => r[1] !== 'DEFAULT').map(r => String(r[0])).sort()
          if (!cancelled && (def.length || rest.length)) setEngines([...def, ...rest])
        } catch { /* 用回退列表 */ }
      } catch { /* tauri 不可用 */ }
    })()
    return () => { cancelled = true }
  }, [connectionId, isMy])

  // 编辑模式：加载现有表结构并预填
  useEffect(() => {
    if (!editTable) return
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type Rows = { rows: (string | null)[][] }
        const esc = (s: string) => s.replace(/'/g, "''")
        if (isMy) {
          // MySQL 系：information_schema 文本列为二进制字符集，全部 CAST AS CHAR 强制为字符串；并带 EXTRA/COMMENT
          const colRes = await invoke<Rows>('execute_query', {
            id: connectionId,
            sql: `SELECT CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR), CAST(IS_NULLABLE AS CHAR), `
              + `CAST(COLUMN_KEY AS CHAR), CAST(COLUMN_DEFAULT AS CHAR), CAST(EXTRA AS CHAR), CAST(COLUMN_COMMENT AS CHAR) `
              + `FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${esc(schema)}' AND TABLE_NAME='${esc(editTable)}' ORDER BY ORDINAL_POSITION`,
          })
          if (cancelled) return
          const loaded = colRes.rows.map(rowToCol)
          setCols(loaded)
          setOrigCols(loaded.map(c => ({ ...c })))
          // 表选项（ENGINE/CHARSET/COLLATION/ROW_FORMAT/AUTO_INCREMENT/COMMENT）
          try {
            const optRes = await invoke<Rows>('execute_query', {
              id: connectionId,
              sql: `SELECT ENGINE, TABLE_COLLATION, ROW_FORMAT, AUTO_INCREMENT, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='${esc(schema)}' AND TABLE_NAME='${esc(editTable)}'`,
            })
            if (!cancelled && optRes.rows[0]) {
              const [eng, coll, rowFmt, autoInc, cmt] = optRes.rows[0]
              const engVal = String(eng ?? 'InnoDB')
              const collVal = String(coll ?? '')
              const csVal  = collVal ? collVal.split('_')[0] : 'utf8mb4'
              const rowFmtVal = String(rowFmt ?? 'DEFAULT').toUpperCase()
              const autoIncVal = autoInc == null ? '' : String(autoInc)
              const cmtVal = String(cmt ?? '')
              setEngine(engVal); setCharset(csVal); setCollation(collVal); setRowFormat(rowFmtVal); setAutoIncStart(autoIncVal); setComment(cmtVal)
              setOrigEngine(engVal); setOrigCharset(csVal); setOrigCollation(collVal); setOrigRowFormat(rowFmtVal); setOrigAutoIncStart(autoIncVal); setOrigComment(cmtVal)
            }
          } catch { /* 选项加载失败忽略 */ }
        } else {
          // 非 MySQL：走后端按方言分派的 table_columns（PG/SQLite/DuckDB 通用），无 ENGINE/CHARSET/COMMENT
          type Col = { name: string; dataType: string; nullable: boolean; key: string; defaultValue: string | null }
          const list = await invoke<Col[]>('table_columns', { id: connectionId, schema, table: editTable })
          if (cancelled) return
          const loaded = list.map(c => {
            const { baseType, length } = parseColumnType(c.dataType)
            const def = c.defaultValue
            let defaultType: DefaultType = 'none'; let defaultValue = ''
            if (def == null) defaultType = c.nullable ? 'null' : 'none'
            else if (/^current_timestamp|^now\(\)/i.test(String(def))) defaultType = 'timestamp'
            else if (String(def) === '') defaultType = 'empty'
            else { defaultType = 'custom'; defaultValue = String(def) }
            return newCol({
              name: c.name, baseType, length, unsigned: false, nullable: c.nullable,
              primaryKey: c.key === 'PRI', autoIncrement: false, defaultType, defaultValue,
            })
          })
          setCols(loaded)
          setOrigCols(loaded.map(c => ({ ...c })))
        }
        // 当前完整 DDL（无改动时预览展示）—— 后端 get_table_ddl 已按方言分派
        try {
          const ddl = await invoke<string>('get_table_ddl', { id: connectionId, schema, table: editTable })
          if (!cancelled) setCurrentDdl(ddl)
        } catch { /* 忽略 */ }
        setEditLoaded(true)
      } catch (e) { if (!cancelled) { setExecErr(String(e)); setEditLoaded(true) } }
    })()
    return () => { cancelled = true }
  }, [connectionId, schema, editTable, isMy])

  // charset 变化时拉排序规则（仅 MySQL 系；SHOW COLLATION 是 MySQL 专属）
  useEffect(() => {
    if (!isMy || !charset) return
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type Rows = { rows: (string | null)[][] }
        const res = await invoke<Rows>('execute_query', {
          id: connectionId,
          sql: `SHOW COLLATION WHERE Charset = '${charset.replace(/'/g, "''")}'`,
        })
        if (cancelled) return
        const list = res.rows.map(r => String(r[0] ?? '')).filter(Boolean).sort()
        setCollations(list)
        const def = res.rows.find(r => r[3] === 'Yes')
        setCollation(prev => prev && list.includes(prev) ? prev : (def ? String(def[0]) : (list[0] ?? '')))
      } catch { setCollations([]); setCollation('') }
    })()
    return () => { cancelled = true }
  }, [connectionId, charset, isMy])

  useEffect(() => {
    if (!pendingFocusId) return
    const el = document.querySelector<HTMLInputElement>(`[data-col-name="${pendingFocusId}"]`)
    if (el) { el.focus(); setPendingFocusId(null) }
  }, [pendingFocusId, cols])

  function toggleIndexField(idxId: string, field: string) {
    setIndexes(prev => prev.map(x => {
      if (x._id !== idxId) return x
      const cur  = x.columns.split(',').map(s => s.trim()).filter(Boolean)
      const next = cur.includes(field) ? cur.filter(f => f !== field) : [...cur, field]
      return { ...x, columns: next.join(', ') }
    }))
  }

  const trapFocus = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !modalRef.current) return
    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => el.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus() }
    }
  }, [])

  const sql = isEdit
    ? buildAlterSql({
        connType, schema, table, comment, engine, charset, collation, rowFormat, autoIncStart, cols, origCols,
        origEngine, origCharset, origCollation, origRowFormat, origAutoIncStart, origComment,
      })
    : buildSql({ connType, schema, table, comment, engine, charset, collation, rowFormat, autoIncStart, cols, indexes, fkeys, triggers })
  const ready = !sql.startsWith('--') && (!isEdit || editLoaded)
  // 预览：编辑模式无改动时展示当前表的完整 DDL（而非无意义的占位）
  const previewSql = isEdit && sql.startsWith('--')
    ? `${sql}\n\n-- 当前表结构定义：\n${currentDdl || '（加载中…）'}`
    : sql

  function update(id: string, patch: Partial<NewCol>) {
    setCols(prev => prev.map(c => c._id === id ? { ...c, ...patch } : c))
  }

  function move(id: string, dir: -1 | 1) {
    setCols(prev => {
      const i = prev.findIndex(c => c._id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]; [next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const hasAutoIncrementColumn = cols.some(c => c.autoIncrement)

  async function execute() {
    if (!ready) return
    setExecuting(true); setExecErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('execute_query', { id: connectionId, sql })
      onDone(); onClose()
      toast.success(isEdit ? `已保存表 ${table} 的结构修改` : `已创建表 ${table}`)
    } catch (e) { setExecErr(String(e)); setTab('sql') }  // 失败只在模态内提示，不再弹全局 toast（避免一错两处）
    finally { setExecuting(false) }
  }

  const TABS: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'fields',   label: '字段' },
    { key: 'indexes',  label: '索引',  count: indexes.length || undefined },
    { key: 'fkeys',    label: '外键',  count: fkeys.length || undefined },
    // 触发器/选项(ENGINE/CHARSET/ROW_FORMAT) 是 MySQL 系专属，其它方言隐藏
    ...(isMy ? [{ key: 'triggers' as Tab, label: '触发器', count: triggers.length || undefined }] : []),
    ...(isMy ? [{ key: 'options' as Tab,  label: '选项' }] : []),
    { key: 'sql',      label: 'SQL 预览' },
  ]

  // ── 字段选择弹窗（索引 tab） ──────────────────────────────────────────────
  const pickerModalEl = (() => {
    if (!pickerModal) return null
    const idx = indexes.find(x => x._id === pickerModal)
    if (!idx) return null
    const sel         = idx.columns.split(',').map(s => s.trim()).filter(Boolean)
    const availFields = cols.filter(c => c.name.trim()).map(c => c.name.trim())
    return (
      <div className="ctw-fpm-overlay" onClick={() => setPickerModal(null)}>
        <div className="ctw-fpm" onClick={e => e.stopPropagation()}>
          <div className="ctw-fpm-header">
            <span>选择索引字段</span>
            <button className="ctw-fpm-close" onClick={() => setPickerModal(null)}><X size={13} /></button>
          </div>
          {availFields.length > 0 && <div className="ctw-fpm-hint">勾选顺序即为索引列顺序</div>}
          <div className="ctw-fpm-body">
            {availFields.length === 0
              ? <div className="ctw-fpm-empty">请先在"字段"页添加字段</div>
              : availFields.map(f => {
                const checked = sel.includes(f)
                const order   = sel.indexOf(f) + 1
                return (
                  <div key={f} className={`ctw-fpm-item${checked ? ' on' : ''}`}
                    onClick={() => toggleIndexField(idx._id, f)}>
                    <button type="button" role="checkbox" aria-checked={checked}
                      className={`ctw-chk${checked ? ' on' : ''}`}
                      onClick={e => { e.stopPropagation(); toggleIndexField(idx._id, f) }}>
                      {checked && <Check size={10} strokeWidth={3} />}
                    </button>
                    <span className="ctw-fpm-fname">{f}</span>
                    {checked && <span className="ctw-fpm-order">{order}</span>}
                  </div>
                )
              })}
          </div>
          <div className="ctw-fpm-footer">
            <button className="dbtool-btn dbtool-btn--primary" style={{ height: 30, fontSize: 13 }}
              onClick={() => setPickerModal(null)}>完成</button>
          </div>
        </div>
      </div>
    )
  })()

  return createPortal(
    <div className="dbtool-overlay">
      {pickerModalEl}
      <div className="dbtool-modal ctw-modal" ref={modalRef} onKeyDown={trapFocus}>
        <div className="dbtool-modal__header">
          <span className="dbtool-modal__title">{isEdit ? `修改表结构 — ${schema}.${editTable}` : `新建表 — ${schema}`}</span>
          <button className="dbtool-modal__close" onClick={onClose}><X size={14} /></button>
        </div>

        {/* 表名 + 标签栏 */}
        <div className="ctw-head">
          <input className="ctw-name-inp" value={table} autoFocus
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            onChange={e => setTable(e.target.value)} placeholder="表名（必填）" />
          <div className="ctw-tabs">
            {TABS.map(t => (
              <button key={t.key} className={`ctw-tab${tab === t.key ? ' active' : ''}`}
                onClick={() => setTab(t.key)}>
                {t.label}
                {t.count != null && <span className="ctw-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="ctw-body">

          {/* ── 字段 ── */}
          {tab === 'fields' && (
            <div className="ctw-field-scroll">
              <div className="ctw-grid ctw-grid--head">
                <span>字段名</span><span>类型</span><span>长度</span>
                <span className="c">可空</span><span className="c">主键</span>
                <span>默认值</span><span>注释</span><span>扩展属性</span><span />
              </div>
              {cols.map((col, i) => (
                <div key={col._id} className="ctw-grid ctw-grid--row">
                  <input value={col.name} placeholder="字段名" autoComplete="off" autoCorrect="off" spellCheck={false}
                    data-col-name={col._id}
                    onChange={e => update(col._id, { name: e.target.value })} />
                  <SearchableSelect value={col.baseType}
                    onChange={bt => {
                      // 切到非时间类型时清掉时间相关默认值
                      const patch: Partial<NewCol> = { baseType: bt, length: DEFAULT_LENGTH[bt] ?? '' }
                      if (!DATETIME_TYPES.has(bt) && (col.defaultType === 'timestamp' || col.defaultType === 'timestamp_update')) {
                        patch.defaultType = 'none'
                      }
                      update(col._id, patch)
                    }}
                    options={TYPE_OPTIONS} searchPlaceholder="搜索类型…" />
                  <input value={col.length} placeholder="—"
                    onChange={e => update(col._id, { length: e.target.value })} />

                  {/* 可空 */}
                  <span className="c">
                    <button type="button" role="checkbox" aria-checked={col.nullable}
                      className={`ctw-chk${col.nullable ? ' on' : ''}${col.primaryKey ? ' disabled' : ''}`}
                      tabIndex={col.primaryKey ? -1 : 0}
                      onClick={() => { if (!col.primaryKey) update(col._id, { nullable: !col.nullable }) }}>
                      {col.nullable && !col.primaryKey && <Check size={10} strokeWidth={3} />}
                    </button>
                  </span>

                  {/* 主键 */}
                  <span className="c">
                    <button type="button" role="checkbox" aria-checked={col.primaryKey}
                      className={`ctw-chk${col.primaryKey ? ' on' : ''}`}
                      onClick={() => update(col._id, col.primaryKey
                        ? { primaryKey: false, autoIncrement: false }
                        : { primaryKey: true, nullable: false })}>
                      {col.primaryKey && <Check size={10} strokeWidth={3} />}
                    </button>
                  </span>

                  {/* 默认值 */}
                  <div className="ctw-default-cell">
                    {col.defaultType !== 'custom' ? (
                      <SearchableSelect value={col.defaultType} mono={false}
                        onChange={v => update(col._id, { defaultType: v as DefaultType, defaultValue: '' })}
                        items={[
                          { value: 'none', label: '无' },
                          { value: 'null', label: 'NULL' },
                          { value: 'empty', label: '空字符串' },
                          ...(DATETIME_TYPES.has(col.baseType) ? [{ value: 'timestamp', label: 'CURRENT_TIMESTAMP' }] : []),
                          ...(DATETIME_TYPES.has(col.baseType) ? [{ value: 'timestamp_update', label: 'CURRENT_TIMESTAMP ON UPDATE' }] : []),
                          ...(NUMERIC_TYPES.has(col.baseType) ? [{ value: 'zero', label: '0' }] : []),
                          { value: 'custom', label: '自定义…' },
                        ]} />
                    ) : (
                      <>
                        <button className="ctw-default-back"
                          onClick={() => update(col._id, { defaultType: 'none', defaultValue: '' })}
                          data-tip="返回预设">←</button>
                        <input className="ctw-default-inp"
                          value={col.defaultValue} placeholder="输入默认值"
                          autoComplete="off" autoCorrect="off" spellCheck={false}
                          onChange={e => update(col._id, { defaultValue: e.target.value })} />
                      </>
                    )}
                  </div>

                  {/* 注释 */}
                  <input value={col.comment} placeholder="—" autoComplete="off" autoCorrect="off" spellCheck={false}
                    onChange={e => update(col._id, { comment: e.target.value })}
                    onKeyDown={e => {
                      if (e.key !== 'Tab' || e.shiftKey) return
                      if (i === 0 && i === cols.length - 1) {
                        e.preventDefault()
                        const next = newCol(); setCols(prev => [...prev, next]); setPendingFocusId(next._id)
                      }
                    }} />

                  {/* 扩展属性 */}
                  <div className="ctw-ext-cell">
                    {NUMERIC_TYPES.has(col.baseType) && (
                      <>
                        {isMy && (
                          <label className="ctw-ext-chk">
                            <input type="checkbox" checked={col.unsigned}
                              onChange={e => update(col._id, { unsigned: e.target.checked })} />
                            <span>无符号</span>
                          </label>
                        )}
                        <label className="ctw-ext-chk">
                          <input type="checkbox" checked={col.autoIncrement}
                            onChange={e => {
                              if (e.target.checked) {
                                setCols(prev => prev.map(c =>
                                  c._id === col._id
                                    ? { ...c, autoIncrement: true, primaryKey: true, nullable: false }
                                    : { ...c, autoIncrement: false }
                                ))
                              } else {
                                update(col._id, { autoIncrement: false })
                              }
                            }} />
                          <span>自增</span>
                        </label>
                      </>
                    )}
                  </div>

                  {/* 操作 */}
                  <span className="ctw-row-ops">
                    <button onClick={() => move(col._id, -1)} disabled={i === 0} data-tip="上移"><ArrowUp size={11} /></button>
                    <button onClick={() => move(col._id, 1)} disabled={i === cols.length - 1} data-tip="下移"><ArrowDown size={11} /></button>
                    <button className={`del${cols.length <= 1 ? ' soft-disabled' : ''}`}
                      onClick={() => { if (cols.length > 1) setCols(prev => prev.filter(c => c._id !== col._id)) }}
                      data-tip="删除字段"
                      onKeyDown={e => {
                        if (e.key === 'Tab' && !e.shiftKey && col._id === cols[cols.length - 1]._id) {
                          e.preventDefault()
                          const next = newCol(); setCols(prev => [...prev, next]); setPendingFocusId(next._id)
                        }
                      }}><Trash2 size={11} /></button>
                  </span>
                </div>
              ))}
              <div className="ctw-add-row" onClick={() => setCols(prev => [...prev, newCol()])}>
                <Plus size={11} /><span>点击添加字段</span>
              </div>
            </div>
          )}

          {/* ── 索引 ── */}
          {tab === 'indexes' && (() => {
            const pkCols = cols.filter(c => c.primaryKey && c.name.trim())
            return (
              <>
                <div className="ctw-grid ctw-grid--idx ctw-grid--head">
                  <span>索引名</span><span>包含字段</span><span className="c">唯一</span><span className="ctw-idx-type">类型</span><span />
                </div>
                <div className="ctw-rows">
                  {pkCols.length > 0 && (
                    <div className="ctw-grid ctw-grid--idx ctw-grid--row ctw-idx-pk-row">
                      <span className="ctw-idx-pk-label"><span className="ctw-idx-pk-badge">PK</span> PRIMARY</span>
                      <div className="ctw-idx-field-cell ctw-idx-pk-field">
                        <div className="ctw-idx-field-tags">
                          {pkCols.map(c => <span key={c._id} className="ctw-idx-field-tag">{c.name.trim()}</span>)}
                        </div>
                      </div>
                      <span className="c" style={{ color: 'var(--accent)' }}><Check size={12} strokeWidth={3} /></span>
                      <span className="ctw-idx-type" style={{ fontSize: 12, color: 'var(--text-muted)' }}>BTREE</span>
                      <span />
                    </div>
                  )}
                  {indexes.map(idx => {
                    const sel = idx.columns.split(',').map(s => s.trim()).filter(Boolean)
                    return (
                      <div key={idx._id} className="ctw-grid ctw-grid--idx ctw-grid--row">
                        <input value={idx.name} placeholder="留空自动命名" autoComplete="off"
                          onChange={e => setIndexes(prev => prev.map(x => x._id === idx._id ? { ...x, name: e.target.value } : x))} />
                        <div className="ctw-idx-field-cell" tabIndex={0}
                          onClick={() => setPickerModal(idx._id)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPickerModal(idx._id) } }}>
                          <div className="ctw-idx-field-tags">
                            {sel.length === 0
                              ? <span className="ctw-idx-no-fields">点击选择字段…</span>
                              : sel.map(f => <span key={f} className="ctw-idx-field-tag">{f}</span>)}
                          </div>
                        </div>
                        <span className="c">
                          <button type="button" role="checkbox" aria-checked={idx.unique}
                            className={`ctw-chk${idx.unique ? ' on' : ''}`}
                            onClick={() => setIndexes(prev => prev.map(x => x._id === idx._id ? { ...x, unique: !x.unique } : x))}>
                            {idx.unique && <Check size={10} strokeWidth={3} />}
                          </button>
                        </span>
                        <SearchableSelect value={idx.method}
                          onChange={v => setIndexes(prev => prev.map(x => x._id === idx._id ? { ...x, method: v as IndexMethod } : x))}
                          options={['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']} />
                        <span className="ctw-row-ops">
                          <button className="del" onClick={() => setIndexes(prev => prev.filter(x => x._id !== idx._id))}>
                            <Trash2 size={11} />
                          </button>
                        </span>
                      </div>
                    )
                  })}
                  {indexes.length === 0 && pkCols.length === 0 && (
                    <div className="ctw-empty">暂无索引，主键请在"字段"页勾选</div>
                  )}
                  <div className="ctw-add-row" onClick={() => setIndexes(prev => [...prev, { _id: uid(), name: '', columns: '', unique: false, method: 'BTREE' }])}>
                    <Plus size={11} /><span>添加索引</span>
                  </div>
                </div>
              </>
            )
          })()}

          {/* ── 外键 ── */}
          {tab === 'fkeys' && (
            <>
              <div className="ctw-grid ctw-grid--fk ctw-grid--head">
                <span>外键名</span><span>本地字段</span><span>引用表</span><span>引用字段</span>
                <span>ON DELETE</span><span>ON UPDATE</span><span />
              </div>
              <div className="ctw-rows">
                {fkeys.map(fk => (
                  <div key={fk._id} className="ctw-grid ctw-grid--fk ctw-grid--row">
                    <input value={fk.name} placeholder="留空自动命名" autoComplete="off"
                      onChange={e => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, name: e.target.value } : x))} />
                    <input value={fk.localCols} placeholder="字段名（逗号分隔）" autoComplete="off"
                      onChange={e => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, localCols: e.target.value } : x))} />
                    <input value={fk.refTable} placeholder="引用表名" autoComplete="off"
                      onChange={e => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, refTable: e.target.value } : x))} />
                    <input value={fk.refCols} placeholder="字段名（逗号分隔）" autoComplete="off"
                      onChange={e => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, refCols: e.target.value } : x))} />
                    <SearchableSelect value={fk.onDelete}
                      onChange={v => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, onDelete: v as FKAction } : x))}
                      options={FK_ACTIONS} />
                    <SearchableSelect value={fk.onUpdate}
                      onChange={v => setFkeys(prev => prev.map(x => x._id === fk._id ? { ...x, onUpdate: v as FKAction } : x))}
                      options={FK_ACTIONS} />
                    <span className="ctw-row-ops">
                      <button className="del" onClick={() => setFkeys(prev => prev.filter(x => x._id !== fk._id))}>
                        <Trash2 size={11} />
                      </button>
                    </span>
                  </div>
                ))}
                {fkeys.length === 0 && <div className="ctw-empty">暂无外键</div>}
                <div className="ctw-add-row" onClick={() => setFkeys(prev => [...prev, newFK()])}>
                  <Plus size={11} /><span>添加外键</span>
                </div>
              </div>
            </>
          )}

          {/* ── 触发器 ── */}
          {tab === 'triggers' && (
            <div className="ctw-triggers">
              {triggers.length === 0 && (
                <div className="ctw-empty" style={{ margin: '20px 0' }}>暂无触发器</div>
              )}
              {triggers.map(tr => (
                <div key={tr._id} className="ctw-trigger-card">
                  <div className="ctw-trigger-row">
                    <input className="ctw-trigger-name" value={tr.name} placeholder="触发器名称" autoComplete="off"
                      onChange={e => setTriggers(prev => prev.map(x => x._id === tr._id ? { ...x, name: e.target.value } : x))} />
                    <SearchableSelect value={tr.timing} width={120}
                      onChange={v => setTriggers(prev => prev.map(x => x._id === tr._id ? { ...x, timing: v as TriggerTiming } : x))}
                      options={['BEFORE', 'AFTER']} />
                    <SearchableSelect value={tr.event} width={120}
                      onChange={v => setTriggers(prev => prev.map(x => x._id === tr._id ? { ...x, event: v as TriggerEvent } : x))}
                      options={['INSERT', 'UPDATE', 'DELETE']} />
                    <button className="dbtool-btn" style={{ color: 'var(--error)', marginLeft: 'auto' }}
                      onClick={() => setTriggers(prev => prev.filter(x => x._id !== tr._id))}>
                      <Trash2 size={12} /> 删除
                    </button>
                  </div>
                  <textarea className="ctw-trigger-body" rows={6}
                    value={tr.body} spellCheck={false}
                    onChange={e => setTriggers(prev => prev.map(x => x._id === tr._id ? { ...x, body: e.target.value } : x))} />
                </div>
              ))}
              <div className="ctw-add-row" onClick={() => setTriggers(prev => [...prev, newTrigger()])}>
                <Plus size={11} /><span>添加触发器</span>
              </div>
            </div>
          )}

          {/* ── 选项 ── */}
          {tab === 'options' && (
            <div className="ctw-options">
              <div className="ctw-opt-row">
                <span>存储引擎</span>
                <SearchableSelect value={engine} options={engines} onChange={setEngine} width={280} />
              </div>
              <div className="ctw-opt-row">
                <span>字符集</span>
                <SearchableSelect value={charset} options={charsets} onChange={setCharset} width={280} />
              </div>
              <div className="ctw-opt-row">
                <span>排序规则</span>
                <SearchableSelect value={collation} options={collations} onChange={setCollation} width={280}
                  placeholder={collations.length === 0 ? '加载中…' : '选择排序规则'} />
              </div>
              {canUseRowFormat && (
                <div className="ctw-opt-row">
                  <span>行格式</span>
                  <SearchableSelect value={rowFormat} onChange={setRowFormat} options={ROW_FORMATS} width={280} />
                </div>
              )}
              <div className="ctw-opt-row">
                <span>{isEdit ? '下个自增值' : '自动递增'}</span>
                <input type="number" min={1} value={autoIncStart} onChange={e => setAutoIncStart(e.target.value)}
                  disabled={isEdit && !hasAutoIncrementColumn}
                  placeholder={isEdit && !hasAutoIncrementColumn ? '当前表没有自增字段' : undefined}
                  style={{ flex: 1, maxWidth: 280, height: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
                <small className="ctw-opt-hint">{isEdit ? '只影响下一次插入，已有数据不变' : '建表后的初始自增值'}</small>
              </div>
              <div className="ctw-opt-row">
                <span>表注释</span>
                <input value={comment} onChange={e => setComment(e.target.value)} placeholder="可选" />
              </div>
            </div>
          )}

          {/* ── SQL 预览 ── */}
          {tab === 'sql' && (
            <pre className="ctw-sql">{previewSql}</pre>
          )}

        </div>

        <div className="dbtool-modal__footer" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: execErr ? '#dc2626' : 'var(--text-muted)' }}>
            {execErr || `${cols.filter(c => c.name.trim()).length} 个字段${isMy ? ` · ${engine} · ${charset}` : ` · ${connType}`}`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="dbtool-btn dbtool-btn--cancel" onClick={onClose}>取消</button>
            <button className="dbtool-btn dbtool-btn--primary" onClick={execute} disabled={executing || !ready}>
              {executing ? '执行中…' : (isEdit ? '保存修改' : '创建表')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
