// 共享 SQL 方言层 —— 所有前端「自己拼 SQL」的地方，标识符引号 / 表引用 / 方言分支判断
// 一律从这里取，禁止再在组件内各写一份 backtick / 双引号函数（历史上散落 10+ 处，导致 PG/SQLite 崩）。
//
// 引号约定（与既有 objectEditor.qid / RoutineWizard.qid 完全一致）：
//   反引号 `…`  → mysql / mariadb / tidb / oceanBase / clickHouse
//   方括号 […]  → sqlServer
//   双引号 "…"  → postgres / kingBase / openGauss / sqlite / duckdb / dm（标准 SQL）
import type { ConnType } from '../types'

export type DialectFamily =
  | 'mysql' | 'postgres' | 'sqlite' | 'duckdb' | 'mssql' | 'clickhouse' | 'mongo' | 'other'

const MYSQL_LIKE: ConnType[] = ['mysql', 'mariadb', 'tidb', 'oceanBase']
const PG_LIKE:    ConnType[] = ['postgres', 'kingBase', 'openGauss']
const BACKTICK:   ConnType[] = ['mysql', 'mariadb', 'tidb', 'oceanBase', 'clickHouse']

/** 归一化方言族；用于决定 SQL 语法走向 */
export function dialectFamily(connType: ConnType | string): DialectFamily {
  const t = connType as ConnType
  if (MYSQL_LIKE.includes(t)) return 'mysql'
  if (PG_LIKE.includes(t))    return 'postgres'
  if (t === 'sqlite')    return 'sqlite'
  if (t === 'duckdb')    return 'duckdb'
  if (t === 'sqlServer') return 'mssql'
  if (t === 'clickHouse')return 'clickhouse'
  if (t === 'mongodb')   return 'mongo'
  return 'other'
}

/**
 * 支持「数据迁移向导」的连接类型单一真源（前端入口过滤 + 向导连接列表共用）。
 * MySQL 族 / PG 族 / SQLite / DuckDB 可互迁；Oracle / SQL Server / ClickHouse 仅同引擎迁移。
 * 须与后端 db_extra.rs db_migrate_table 的支持范围保持一致。
 */
export const MIGRATABLE_DB_TYPES: ConnType[] = [
  'mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss',
  'sqlite', 'duckdb', 'oracle', 'sqlServer', 'clickHouse',
]
/** 仅支持「同引擎」迁移（源与目标须为相同类型）的连接类型，须与后端 matches! 分支一致 */
export const SAME_ENGINE_ONLY_MIGRATE: ConnType[] = ['oracle', 'sqlServer', 'clickHouse']

export const isMysqlFamily = (c: ConnType | string) => dialectFamily(c) === 'mysql'
export const isPgFamily    = (c: ConnType | string) => dialectFamily(c) === 'postgres'
export const isSqlite      = (c: ConnType | string) => c === 'sqlite'
export const isDuckdb      = (c: ConnType | string) => c === 'duckdb'

/** 标识符引号（含转义）。c 可为 ConnType 或宽松字符串。 */
export function qid(connType: ConnType | string, ident: string): string {
  if (connType === 'sqlServer') return '[' + ident.replace(/]/g, ']]') + ']'
  if (BACKTICK.includes(connType as ConnType)) return '`' + ident.replace(/`/g, '``') + '`'
  return '"' + ident.replace(/"/g, '""') + '"'
}

/** schema 限定的表/对象引用：有 schema 时 "schema"."name"，否则 "name"。 */
export function tableRef(connType: ConnType | string, schema: string | undefined | null, name: string, ssSchema?: string): string {
  if (!schema) return qid(connType, name)
  if (connType === 'sqlServer') {
    // 三段式：[database].[ss_schema].[table]；有 ssSchema 时精确指定，否则用 .. 默认 dbo
    if (ssSchema) return `${qid(connType, schema)}.${qid(connType, ssSchema)}.${qid(connType, name)}`
    return `${qid(connType, schema)}..${qid(connType, name)}`
  }
  return `${qid(connType, schema)}.${qid(connType, name)}`
}

/** 字符串字面量转义（单引号翻倍）；通用于所有方言。 */
export function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

/**
 * 按方言生成「查看某表索引」的 SQL。返回 null 表示该方言不支持。
 * 各方言系统表不同：MySQL=SHOW INDEX / PG=pg_indexes / Oracle=ALL_INDEXES /
 * SQLite=PRAGMA / DuckDB=duckdb_indexes() / ClickHouse=system.data_skipping_indices / MSSQL=sys.indexes。
 */
export function buildIndexSql(connType: ConnType | string, schema: string, table: string): string | null {
  const esc = (s: string) => s.replace(/'/g, "''")
  const sd = schema || (connType === 'duckdb' ? 'main' : connType === 'sqlServer' ? 'dbo' : 'public')
  if (isMysqlFamily(connType)) return `SHOW INDEX FROM ${tableRef(connType, schema, table)}`
  if (isPgFamily(connType)) {
    return `SELECT indexname, indexdef, tablespace FROM pg_indexes `
      + `WHERE schemaname='${esc(sd)}' AND tablename='${esc(table)}' ORDER BY indexname`
  }
  if (connType === 'oracle') {
    const su = esc((schema || '').toUpperCase()), tu = esc(table.toUpperCase())
    return `SELECT i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE, ic.COLUMN_NAME, ic.COLUMN_POSITION `
      + `FROM ALL_INDEXES i `
      + `JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME=ic.INDEX_NAME AND i.OWNER=ic.INDEX_OWNER `
      + `WHERE i.TABLE_OWNER='${su}' AND i.TABLE_NAME='${tu}' `
      + `ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`
  }
  if (connType === 'sqlite') return `PRAGMA index_list("${table.replace(/"/g, '""')}")`
  if (connType === 'duckdb') {
    return `SELECT index_name, is_unique, sql FROM duckdb_indexes() `
      + `WHERE schema_name='${esc(sd)}' AND table_name='${esc(table)}'`
  }
  if (connType === 'clickHouse') {
    return `SELECT name, type, expr, granularity FROM system.data_skipping_indices `
      + `WHERE database='${esc(schema)}' AND table='${esc(table)}'`
  }
  if (connType === 'sqlServer') {
    // schema=数据库名：用三段式 [库].sys.* 引用该库的目录视图，按表名过滤（默认 dbo）
    const db = schema ? `${qid(connType, schema)}.` : ''
    return `SELECT i.name, i.type_desc, CASE WHEN i.is_unique=1 THEN 'YES' ELSE 'NO' END is_unique, `
      + `CASE WHEN i.is_primary_key=1 THEN 'YES' ELSE 'NO' END is_pk, c.name column_name `
      + `FROM ${db}sys.indexes i JOIN ${db}sys.tables t ON i.object_id=t.object_id `
      + `LEFT JOIN ${db}sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id `
      + `LEFT JOIN ${db}sys.columns c ON ic.object_id=c.object_id AND ic.column_id=c.column_id `
      + `WHERE t.name='${esc(table)}' ORDER BY i.name, ic.key_ordinal`
  }
  return null
}

// ── 能力判断（决定 DDL 是否生成某段 MySQL 专属语法） ─────────────────────────
/** ENGINE= / DEFAULT CHARSET= / ROW_FORMAT= / AUTO_INCREMENT= 等表选项：仅 MySQL 系 */
export const supportsTableOptions = (c: ConnType | string) => isMysqlFamily(c)
/** UNSIGNED 数值修饰符：仅 MySQL 系 */
export const supportsUnsigned = (c: ConnType | string) => isMysqlFamily(c)
/** 列内联 COMMENT '…'：MySQL 系支持；PG/SQLite/DuckDB 需用独立 COMMENT ON 语句（PG）或不支持（SQLite/DuckDB） */
export const supportsInlineComment = (c: ConnType | string) => isMysqlFamily(c);
/** 独立 COMMENT ON …：PG 系 / DuckDB 支持 */
export const supportsCommentOn = (c: ConnType | string) => isPgFamily(c) || isDuckdb(c)
/** ON UPDATE CURRENT_TIMESTAMP：仅 MySQL 系 */
export const supportsOnUpdateTimestamp = (c: ConnType | string) => isMysqlFamily(c)
/** 有独立 schema 命名空间（PG/MSSQL/DM）；MySQL 的 schema==database，SQLite/DuckDB 无 */
export const hasSchemaNamespace = (c: ConnType | string) =>
  isPgFamily(c) || dialectFamily(c) === 'mssql'
/** SHOW … 系列语句（SHOW CREATE / SHOW INDEX / SHOW FULL COLUMNS / SHOW ENGINES …）：仅 MySQL 系 */
export const supportsShowStatements = (c: ConnType | string) => isMysqlFamily(c)
/** OPTIMIZE / ANALYZE / CHECK TABLE 维护语句：MySQL 系；其它库语法不同或不支持 */
export const supportsMyMaintenance = (c: ConnType | string) => isMysqlFamily(c)
/** 跨方言「预览前 N 行」SELECT（不含末尾分号）：SQLServer TOP / Oracle FETCH FIRST / 其余 LIMIT */
export function previewSelect(connType: ConnType | string, ref: string, limit = 100): string {
  if (connType === 'sqlServer') return `SELECT TOP ${limit} * FROM ${ref}`
  if (connType === 'oracle')    return `SELECT * FROM ${ref} FETCH FIRST ${limit} ROWS ONLY`
  return `SELECT * FROM ${ref} LIMIT ${limit}`
}
/** OPTIMIZE TABLE：MySQL/MariaDB/OceanBase 支持；TiDB 不支持（语法报错） */
export const supportsOptimizeTable = (c: ConnType | string) => isMysqlFamily(c) && c !== 'tidb'
/** 检查表 SQL：TiDB 用 ADMIN CHECK TABLE，其余 MySQL 系用 CHECK TABLE */
export const checkTableSql = (c: ConnType | string, ref: string) =>
  c === 'tidb' ? `ADMIN CHECK TABLE ${ref}` : `CHECK TABLE ${ref}`

/**
 * 自增主键列定义片段（不含列名）。返回完整 "类型 + 自增" 片段：
 *   mysql:    BIGINT NOT NULL AUTO_INCREMENT
 *   postgres: BIGSERIAL（或 BIGINT GENERATED ALWAYS AS IDENTITY）
 *   sqlite:   INTEGER PRIMARY KEY AUTOINCREMENT（sqlite 自增必须 INTEGER PRIMARY KEY）
 *   duckdb:   BIGINT（配合 sequence；这里退化为普通 BIGINT，DuckDB 无内建自增列）
 * baseType 为用户选的整型（BIGINT/INT…）；isOnlyPk 表示该列是否是唯一主键（影响 sqlite 写法）。
 */
export function autoIncrementColumn(connType: ConnType | string, baseType: string): {
  /** 类型片段（替换原本的 colType），如 'BIGSERIAL' / 'BIGINT' */
  typeSql: string
  /** 自增关键字（接在 NOT NULL 之后），如 'AUTO_INCREMENT'；无则空串 */
  trailing: string
  /** 是否由该片段自带 PRIMARY KEY（sqlite 自增列必须内联主键） */
  inlinePk: boolean
} {
  const fam = dialectFamily(connType)
  const bt = baseType.toUpperCase()
  if (fam === 'mysql') return { typeSql: bt, trailing: 'AUTO_INCREMENT', inlinePk: false }
  if (fam === 'postgres') {
    const serial = bt === 'BIGINT' ? 'BIGSERIAL' : bt === 'SMALLINT' ? 'SMALLSERIAL' : 'SERIAL'
    return { typeSql: serial, trailing: '', inlinePk: false }
  }
  if (fam === 'sqlite') return { typeSql: 'INTEGER', trailing: '', inlinePk: true }
  if (fam === 'mssql') return { typeSql: bt, trailing: 'IDENTITY(1,1)', inlinePk: false }
  // duckdb / 其它：无内建自增，退化为普通整型（建表向导会另行用 sequence/identity 提示）
  return { typeSql: bt, trailing: '', inlinePk: false }
}
