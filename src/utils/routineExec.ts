// 视图/函数/存储过程「执行」：从 DDL 解析对象名与参数，并生成可执行 SQL
import type { ConnType } from '../types'
import { qid, tableRef, dialectFamily } from './sqlDialect'
import type { ObjType } from '../stores/objectDraftStore'

export interface RoutineParam {
  mode: 'IN' | 'OUT' | 'INOUT' | ''
  name: string
  type: string
}

/** 从 DDL 解析对象名（去引号） */
export function parseObjectName(ddl: string, objType: ObjType): string {
  const kw = objType === 'view' ? 'VIEW' : objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\S+\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?(?:SQL\\s+SECURITY\\s+\\S+\\s+)?${kw}\\s+(\`[^\`]+\`|"[^"]+"|\\w+)`,
    'i',
  )
  const m = re.exec(ddl)
  return m ? m[1].replace(/[`"]/g, '') : ''
}

/** 解析函数/存储过程的参数列表（视图返回空） */
export function parseRoutineParams(ddl: string, objType: ObjType): RoutineParam[] {
  if (objType === 'view') return []
  const kw = objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
  const re = new RegExp(
    `CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?${kw}\\s+(?:\`[^\`]+\`|"[^"]+"|\\w+)\\s*\\(`,
    'i',
  )
  const m = re.exec(ddl)
  if (!m) return []
  // 截取与起始 '(' 匹配的括号内文本
  let i = m.index + m[0].length
  const start = i
  let depth = 1
  for (; i < ddl.length && depth > 0; i++) {
    const ch = ddl[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
  }
  const inner = ddl.slice(start, i - 1)
  if (!inner.trim()) return []
  // 按顶层逗号拆分（避开 DECIMAL(15,2) 这类嵌套括号）
  const parts: string[] = []
  let d = 0, cur = ''
  for (const ch of inner) {
    if (ch === '(') { d++; cur += ch }
    else if (ch === ')') { d--; cur += ch }
    else if (ch === ',' && d === 0) { parts.push(cur); cur = '' }
    else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => {
    let s = p.trim()
    let mode: RoutineParam['mode'] = ''
    if (objType === 'procedure') {
      const mm = /^(IN|OUT|INOUT)\s+/i.exec(s)
      if (mm) { mode = mm[1].toUpperCase() as RoutineParam['mode']; s = s.slice(mm[0].length) }
    }
    const nm = /^(`[^`]+`|"[^"]+"|\w+)\s+([\s\S]+)$/.exec(s)
    const name = (nm ? nm[1] : s).replace(/[`"]/g, '').trim()
    const type = nm ? nm[2].trim() : ''
    return { mode, name, type }
  }).filter((p) => p.name)
}

const NUMERIC = /^(TINY|SMALL|MEDIUM|BIG)?INT|^DECIMAL|^NUMERIC|^FLOAT|^DOUBLE|^REAL|^BIT|^BOOL/i
const NUMERIC_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** 把用户输入按类型转成 SQL 字面量：空 → NULL；数值校验后原样；其它 → 加引号转义 */
function toLiteral(value: string, type: string): string {
  const v = value.trim()
  if (v === '') return 'NULL'
  if (v.toUpperCase() === 'NULL') return 'NULL'
  if (NUMERIC.test(type.trim())) {
    // 严格校验数值格式，非法输入退化为带转义的字符串字面量，防止 SQL 注入
    if (NUMERIC_LITERAL.test(v)) return v
    return `'${v.replace(/'/g, "''")}'`
  }
  return `'${v.replace(/'/g, "''")}'`
}

function sanitizeVar(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

/** 生成执行 SQL；values 为「参数名 → 用户输入值」。schema 用于跨方言限定对象，避免「未选库」类报错 */
export function buildExecSql(p: {
  connType: ConnType
  objType: ObjType
  name: string
  schema?: string
  params: RoutineParam[]
  values: Record<string, string>
  limit?: number
}): string {
  // 带 schema 限定（OceanBase/MySQL 未选默认库、PG search_path、SQLServer 跨库都需要）
  const ref = p.schema ? tableRef(p.connType, p.schema, p.name) : qid(p.connType, p.name)
  const fam = dialectFamily(p.connType)
  const isOracle = p.connType === 'oracle'
  const lim = p.limit ?? 200

  if (p.objType === 'view') {
    if (fam === 'mssql')  return `SELECT TOP ${lim} * FROM ${ref}`
    if (isOracle)         return `SELECT * FROM ${ref} FETCH FIRST ${lim} ROWS ONLY`
    return `SELECT * FROM ${ref} LIMIT ${lim}`
  }
  if (p.objType === 'function') {
    const args = p.params.map((pr) => toLiteral(p.values[pr.name] ?? '', pr.type)).join(', ')
    // Oracle 标量函数 SELECT 必须带 FROM DUAL，否则 ORA-00923
    if (isOracle) return `SELECT ${ref}(${args}) AS ${qid(p.connType, '返回值')} FROM DUAL`
    return `SELECT ${ref}(${args}) AS ${qid(p.connType, '返回值')}`
  }

  // procedure（存储过程）
  // SQLite / DuckDB / ClickHouse 无存储过程概念，避免拼错 SQL，返回注释说明
  if (fam === 'sqlite' || fam === 'duckdb' || fam === 'clickhouse') {
    const lbl = fam === 'sqlite' ? 'SQLite' : fam === 'duckdb' ? 'DuckDB' : 'ClickHouse'
    return `-- ${lbl} 不支持存储过程，无法生成调用 SQL`
  }

  // Oracle：用 PL/SQL 匿名块 BEGIN proc(...); END;（无 CALL，无 @var）
  if (isOracle) {
    const callArgs = p.params.map((pr) =>
      pr.mode === 'OUT' || pr.mode === 'INOUT'
        ? `:${sanitizeVar(pr.name)}`
        : toLiteral(p.values[pr.name] ?? '', pr.type))
    const hasOut = p.params.some((pr) => pr.mode === 'OUT' || pr.mode === 'INOUT')
    const call = `BEGIN\n  ${ref}(${callArgs.join(', ')});\nEND;`
    return hasOut ? `${call}\n-- 注意：存在 OUT/INOUT 参数，需用绑定变量接收，请按需调整` : call
  }

  // SQL Server：用 EXEC；OUT 参数需 DECLARE @x ...; EXEC ... @x OUTPUT; SELECT @x;
  if (fam === 'mssql') {
    const pre: string[] = []; const post: string[] = []; const execArgs: string[] = []
    for (const pr of p.params) {
      if (pr.mode === 'OUT' || pr.mode === 'INOUT') {
        const v = `@${sanitizeVar(pr.name)}`
        const ty = pr.type || 'NVARCHAR(MAX)'
        pre.push(pr.mode === 'INOUT'
          ? `DECLARE ${v} ${ty} = ${toLiteral(p.values[pr.name] ?? '', pr.type)}`
          : `DECLARE ${v} ${ty}`)
        execArgs.push(`${v} OUTPUT`)
        post.push(`${v} AS ${qid(p.connType, pr.name)}`)
      } else {
        execArgs.push(toLiteral(p.values[pr.name] ?? '', pr.type))
      }
    }
    const stmts = [...pre, `EXEC ${ref} ${execArgs.join(', ')}`.trim()]
    if (post.length) stmts.push(`SELECT ${post.join(', ')}`)
    return stmts.join(';\n')
  }

  // PG 系：用 CALL（PG11+）；OUT 参数 PG 需以占位/INOUT 处理，复杂，附注释提示
  if (fam === 'postgres') {
    const callArgs: string[] = []
    let hasOut = false
    for (const pr of p.params) {
      if (pr.mode === 'OUT' || pr.mode === 'INOUT') hasOut = true
      // PG 的 CALL 对 OUT 参数也需传占位实参（常用 NULL）
      if (pr.mode === 'OUT') callArgs.push('NULL')
      else callArgs.push(toLiteral(p.values[pr.name] ?? '', pr.type))
    }
    const call = `CALL ${ref}(${callArgs.join(', ')})`
    return hasOut
      ? `${call};\n-- 注意：存在 OUT/INOUT 参数，PG 通过 CALL 返回结果集，OUT 占位以 NULL 传入，必要时请手动调整`
      : call
  }

  // MySQL 系：保持原逻辑（用户变量 @_out / @_io）
  const pre: string[] = []
  const callArgs: string[] = []
  const post: string[] = []
  for (const pr of p.params) {
    if (pr.mode === 'OUT') {
      const v = `@_out_${sanitizeVar(pr.name)}`
      callArgs.push(v)
      post.push(`${v} AS ${qid(p.connType, pr.name)}`)
    } else if (pr.mode === 'INOUT') {
      const v = `@_io_${sanitizeVar(pr.name)}`
      pre.push(`SET ${v} = ${toLiteral(p.values[pr.name] ?? '', pr.type)}`)
      callArgs.push(v)
      post.push(`${v} AS ${qid(p.connType, pr.name)}`)
    } else {
      callArgs.push(toLiteral(p.values[pr.name] ?? '', pr.type))
    }
  }
  const stmts = [...pre, `CALL ${ref}(${callArgs.join(', ')})`]
  if (post.length) stmts.push(`SELECT ${post.join(', ')}`)
  return stmts.join(';\n')
}
