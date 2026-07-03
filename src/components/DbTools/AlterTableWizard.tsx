import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, X, AlertTriangle, Loader2, Eye } from 'lucide-react'
import type { ConnType } from '../../types'
import { qid, tableRef as tableRefDialect, isMysqlFamily, isPgFamily } from '../../utils/sqlDialect'

interface ColumnDef {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string
  comment: string
  key: string
  _id: string
  _deleted: boolean
  _isNew: boolean
  _original?: { name: string; dataType: string; nullable: boolean; defaultValue: string; comment: string }
  // MariaDB 专属（只读：_isPersistent/_isVirtual；可编辑：_invisible）
  _invisible?: boolean
  _invisibleOrig?: boolean
  _isPersistent?: boolean
  _isVirtual?: boolean
}

interface MariaTableExtraInfo {
  engine: string
  hasSystemVersioning: boolean
  rowFormat: string
  columns: { columnName: string; isInvisible: boolean; isVirtual: boolean; isPersistent: boolean; generationExpr: string }[]
}

interface Props {
  connectionId: string
  schema: string
  table: string
  connType?: ConnType
  onClose: () => void
  onDone: () => void
}

function uid() { return `col-${Date.now()}-${Math.random().toString(36).slice(2)}` }

// DuckDB 使用双引号标识符，且每个变更需要单独的 ALTER TABLE 语句
function buildDuckAlterStatements(schema: string, table: string, cols: ColumnDef[]): string[] {
  const q = (s: string) => '"' + s.replace(/"/g, '""') + '"'
  const tref = schema ? `${q(schema)}.${q(table)}` : q(table)
  const stmts: string[] = []

  for (const col of cols) {
    if (col._isNew && !col._deleted) {
      const nullStr = col.nullable ? '' : ' NOT NULL'
      const defStr = col.defaultValue ? ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'` : ''
      stmts.push(`ALTER TABLE ${tref} ADD COLUMN ${q(col.name)} ${col.dataType || 'VARCHAR'}${nullStr}${defStr};`)
    } else if (col._deleted && !col._isNew) {
      stmts.push(`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};`)
    } else if (!col._isNew && !col._deleted && col._original) {
      const orig = col._original
      const nameChanged = col.name !== orig.name
      const typeChanged = col.dataType !== orig.dataType
      const nullChanged = col.nullable !== orig.nullable
      const defChanged  = col.defaultValue !== orig.defaultValue

      if (nameChanged) {
        stmts.push(`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};`)
      }
      if (typeChanged) {
        stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} TYPE ${col.dataType};`)
      }
      if (nullChanged) {
        stmts.push(col.nullable
          ? `ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} DROP NOT NULL;`
          : `ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} SET NOT NULL;`)
      }
      if (defChanged) {
        if (col.defaultValue) {
          stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} SET DEFAULT '${col.defaultValue.replace(/'/g, "''")}';`)
        } else {
          stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} DROP DEFAULT;`)
        }
      }
    }
  }
  return stmts
}

// SQL Server：每个变更独立语句；ALTER COLUMN 需带类型；改名走 sp_rename；默认值为命名约束
function buildSqlServerAlter(schema: string, table: string, cols: ColumnDef[], connType: ConnType): string {
  const tref = tableRefDialect(connType, schema, table)
  const q = (s: string) => qid(connType, s)
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
  const stmts: string[] = []
  for (const col of cols) {
    if (col._isNew && !col._deleted) {
      let s = `ALTER TABLE ${tref} ADD ${q(col.name)} ${col.dataType || 'NVARCHAR(255)'}`
      if (col.defaultValue) s += ` DEFAULT ${lit(col.defaultValue)}`
      s += col.nullable ? '' : ' NOT NULL'
      stmts.push(s + ';')
    } else if (col._deleted && !col._isNew) {
      stmts.push(`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};`)
    } else if (!col._isNew && !col._deleted && col._original) {
      const orig = col._original
      const type = col.dataType || orig.dataType
      if (col.dataType !== orig.dataType || col.nullable !== orig.nullable)
        stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(orig.name)} ${type}${col.nullable ? ' NULL' : ' NOT NULL'};`)
      if (col.defaultValue !== orig.defaultValue && col.defaultValue)
        stmts.push(`ALTER TABLE ${tref} ADD DEFAULT ${lit(col.defaultValue)} FOR ${q(orig.name)};`)
      if (col.name !== orig.name)
        stmts.push(`EXEC sp_rename '${schema ? `${schema}.` : ''}${table}.${orig.name}', '${col.name}', 'COLUMN';`)
    }
  }
  return stmts.length === 0 ? '-- 无变更' : stmts.join('\n')
}

// Oracle / 达梦 Oracle 模式：ADD/MODIFY 用括号包列；改名 RENAME COLUMN；注释 COMMENT ON
function buildOracleAlter(schema: string, table: string, cols: ColumnDef[], connType: ConnType): string {
  const tref = tableRefDialect(connType, schema, table)
  const q = (s: string) => qid(connType, s)
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
  const stmts: string[] = []
  for (const col of cols) {
    if (col._isNew && !col._deleted) {
      let inner = `${q(col.name)} ${col.dataType || 'VARCHAR2(255)'}`
      if (col.defaultValue) inner += ` DEFAULT ${lit(col.defaultValue)}`
      if (!col.nullable) inner += ' NOT NULL'
      stmts.push(`ALTER TABLE ${tref} ADD (${inner});`)
    } else if (col._deleted && !col._isNew) {
      stmts.push(`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};`)
    } else if (!col._isNew && !col._deleted && col._original) {
      const orig = col._original
      const mod: string[] = []
      if (col.dataType !== orig.dataType) mod.push(col.dataType)
      if (col.nullable !== orig.nullable) mod.push(col.nullable ? 'NULL' : 'NOT NULL')
      if (col.defaultValue !== orig.defaultValue) mod.push(col.defaultValue ? `DEFAULT ${lit(col.defaultValue)}` : 'DEFAULT NULL')
      if (mod.length) stmts.push(`ALTER TABLE ${tref} MODIFY (${q(orig.name)} ${mod.join(' ')});`)
      if (col.comment !== orig.comment && col.comment)
        stmts.push(`COMMENT ON COLUMN ${tref}.${q(orig.name)} IS ${lit(col.comment)};`)
      if (col.name !== orig.name)
        stmts.push(`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};`)
    }
  }
  return stmts.length === 0 ? '-- 无变更' : stmts.join('\n')
}

function buildAlterSql(schema: string, table: string, cols: ColumnDef[], connType: ConnType | undefined, isMaria = false): string {
  const tref = tableRefDialect(connType ?? 'mysql', schema, table)
  const q = (s: string) => qid(connType ?? 'mysql', s)
  const isMy = isMysqlFamily(connType ?? 'mysql')
  const isPg = isPgFamily(connType ?? 'mysql')

  if (connType === 'sqlServer') return buildSqlServerAlter(schema, table, cols, connType)
  if (connType === 'oracle')    return buildOracleAlter(schema, table, cols, connType)

  if (isPg) {
    // PG：各类型修改需独立 ALTER TABLE 语句
    const stmts: string[] = []
    for (const col of cols) {
      if (col._isNew && !col._deleted) {
        const def = `${q(col.name)} ${col.dataType || 'VARCHAR(255)'}` +
          (col.nullable ? '' : ' NOT NULL') +
          (col.defaultValue ? ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'` : '')
        stmts.push(`ALTER TABLE ${tref} ADD COLUMN ${def};`)
      } else if (col._deleted && !col._isNew) {
        stmts.push(`ALTER TABLE ${tref} DROP COLUMN ${q(col._original?.name ?? col.name)};`)
      } else if (!col._isNew && !col._deleted) {
        const orig = col._original
        if (!orig) continue
        if (col.dataType !== orig.dataType)
          stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(orig.name)} TYPE ${col.dataType};`)
        if (col.nullable !== orig.nullable)
          stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} ${col.nullable ? 'DROP' : 'SET'} NOT NULL;`)
        if (col.defaultValue !== orig.defaultValue) {
          if (col.defaultValue)
            stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} SET DEFAULT '${col.defaultValue.replace(/'/g, "''")}';`)
          else
            stmts.push(`ALTER TABLE ${tref} ALTER COLUMN ${q(col.name)} DROP DEFAULT;`)
        }
        if (col.name !== orig.name)
          stmts.push(`ALTER TABLE ${tref} RENAME COLUMN ${q(orig.name)} TO ${q(col.name)};`)
        if (col.comment !== orig.comment && col.comment)
          stmts.push(`COMMENT ON COLUMN ${tref}.${q(col.name)} IS '${col.comment.replace(/'/g, "''")}';`)
      }
    }
    return stmts.length === 0 ? '-- 无变更' : stmts.join('\n')
  }

  // MySQL / MariaDB / 其它
  const parts: string[] = []
  for (const col of cols) {
    const invSuffix = isMaria && col._invisible ? ' INVISIBLE' : ''
    if (col._isNew && !col._deleted) {
      const colDef = `${q(col.name)} ${col.dataType || 'VARCHAR(255)'}` +
        (col.nullable ? '' : ' NOT NULL') +
        (col.defaultValue ? ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'` : '') +
        (isMy && col.comment ? ` COMMENT '${col.comment.replace(/'/g, "''")}'` : '') +
        invSuffix
      parts.push(`  ADD COLUMN ${colDef}`)
    } else if (col._deleted && !col._isNew) {
      parts.push(`  DROP COLUMN ${q(col._original?.name ?? col.name)}`)
    } else if (!col._isNew && !col._deleted) {
      const orig = col._original
      if (!orig) continue
      const invisibleChanged = isMaria && col._invisible !== col._invisibleOrig
      const changed = col.name !== orig.name || col.dataType !== orig.dataType ||
        col.nullable !== orig.nullable || col.defaultValue !== orig.defaultValue ||
        col.comment !== orig.comment || invisibleChanged
      if (changed) {
        const colDef = `${q(col.name)} ${col.dataType || orig.dataType}` +
          (col.nullable ? '' : ' NOT NULL') +
          (col.defaultValue ? ` DEFAULT '${col.defaultValue.replace(/'/g, "''")}'` : '') +
          (isMy && col.comment ? ` COMMENT '${col.comment.replace(/'/g, "''")}'` : '') +
          (isMaria ? (col._invisible ? ' INVISIBLE' : '') : '')
        parts.push(`  MODIFY COLUMN ${colDef}`)
      }
    }
  }

  if (parts.length === 0) return '-- 无变更'
  return `ALTER TABLE ${tref}\n${parts.join(',\n')};`
}

export default function AlterTableWizard({ connectionId, schema, table, connType, onClose, onDone }: Props) {
  const isSqlite = connType === 'sqlite'
  const isMaria  = connType === 'mariadb'
  const isDuck   = connType === 'duckdb'
  const [cols, setCols] = useState<ColumnDef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [executing, setExecuting] = useState(false)
  const [execErr, setExecErr] = useState('')
  const [execOk, setExecOk] = useState(false)
  // SQLite preview
  const [sqlitePreview, setSqlitePreview] = useState<{ kind: string; sqlScript: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  // MariaDB extra info
  const [mariaExtra, setMariaExtra] = useState<MariaTableExtraInfo | null>(null)
  // MA4.3 — MariaDB 应用期 (PERIOD FOR)
  const [mariaPeriods, setMariaPeriods] = useState<{ name: string; start: string; end: string }[]>([])

  const sql = buildAlterSql(schema, table, cols, connType, isMaria)
  const duckSqls = isDuck ? buildDuckAlterStatements(schema, table, cols) : []

  useEffect(() => {
    ;(async () => {
      setLoading(true); setError('')
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const data = await invoke<{ name: string; dataType: string; nullable: boolean; key: string; defaultValue: string | null }[]>(
          'table_columns', { id: connectionId, schema, table }
        )
        setCols(data.map(c => ({
          _id: uid(), _deleted: false, _isNew: false,
          _original: { name: c.name, dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue ?? '', comment: '' },
          name: c.name, dataType: c.dataType, nullable: c.nullable,
          defaultValue: c.defaultValue ?? '', comment: '', key: c.key,
        })))
      } catch (e) { setError(String(e)) }
      finally { setLoading(false) }
    })()
  }, [connectionId, schema, table])

  // MariaDB 专属：加载引擎/系统版本化/INVISIBLE 列信息（只用于展示，不影响已有改表逻辑）
  useEffect(() => {
    if (!isMaria) return
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const extra = await invoke<MariaTableExtraInfo>('mariadb_table_extra_info', { id: connectionId, schema, table })
        setMariaExtra(extra)
        // 把 INVISIBLE/PERSISTENT/VIRTUAL 标志合并到列上
        setCols(prev => prev.map(col => {
          const ex = extra.columns.find(c => c.columnName === col.name)
          if (!ex) return col
          return { ...col, _invisible: ex.isInvisible, _invisibleOrig: ex.isInvisible, _isPersistent: ex.isPersistent, _isVirtual: ex.isVirtual }
        }))
      } catch { /* 失败则不展示额外信息，不影响基础改表功能 */ }
      // MA4.3 — 解析 PERIOD FOR（应用期表）
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type R = { columns: string[]; rows: (string | null)[][] }
        const tref = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``
        const res = await invoke<R>('execute_query', { id: connectionId, sql: `SHOW CREATE TABLE ${tref}` })
        const ddl = res.rows[0]?.[1] ?? ''
        // PERIOD FOR apptime (start_col, end_col)
        const periodRe = /PERIOD\s+FOR\s+`?(\w+)`?\s*\(`?(\w+)`?,\s*`?(\w+)`?\)/gi
        const found: { name: string; start: string; end: string }[] = []
        let m: RegExpExecArray | null
        while ((m = periodRe.exec(ddl)) !== null) {
          found.push({ name: m[1], start: m[2], end: m[3] })
        }
        setMariaPeriods(found)
      } catch { /* PERIOD FOR 解析失败不阻断流程 */ }
    })()
  }, [isMaria, connectionId, schema, table])

  // 新增列默认类型按方言取（sqlServer→NVARCHAR、Oracle→VARCHAR2、其余→VARCHAR）
  const defaultNewColType =
    connType === 'sqlServer' ? 'NVARCHAR(255)'
    : connType === 'oracle' ? 'VARCHAR2(255)'
    : 'VARCHAR(255)'

  function addCol() {
    setCols(prev => [...prev, {
      _id: uid(), _deleted: false, _isNew: true,
      name: '', dataType: defaultNewColType, nullable: true,
      defaultValue: '', comment: '', key: '',
    }])
  }

  function update(id: string, field: keyof ColumnDef, value: unknown) {
    setCols(prev => prev.map(c => c._id === id ? { ...c, [field]: value } : c))
  }

  async function loadSqlitePreview() {
    setPreviewLoading(true); setPreviewErr(''); setSqlitePreview(null); setConfirmed(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const alterCols = cols.map(c => ({
        originalName: c._isNew ? null : (c._original?.name ?? c.name),
        newName: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
        isDeleted: c._deleted,
        isPrimaryKey: c.key === 'PRI',
        generatedExpr: '',
        generatedStored: false,
      }))
      const preview = await invoke<{ kind: string; sqlScript: string }>('sqlite_alter_table_preview', {
        id: connectionId, table, cols: alterCols,
      })
      setSqlitePreview(preview)
    } catch (e) { setPreviewErr(String(e)) }
    finally { setPreviewLoading(false) }
  }

  async function execute() {
    if (isSqlite) {
      if (!confirmed) { setExecErr('请先预览并确认变更'); return }
      setExecuting(true); setExecErr('')
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const alterCols = cols.map(c => ({
          originalName: c._isNew ? null : (c._original?.name ?? c.name),
          newName: c.name,
          dataType: c.dataType,
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          isDeleted: c._deleted,
          isPrimaryKey: c.key === 'PRI',
          generatedExpr: '',
          generatedStored: false,
        }))
        await invoke('sqlite_alter_table_execute', { id: connectionId, table, cols: alterCols })
        setExecOk(true)
        onDone()
      } catch (e) { setExecErr(String(e)) }
      finally { setExecuting(false) }
      return
    }
    if (isDuck) {
      if (duckSqls.length === 0) return
      setExecuting(true); setExecErr('')
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        for (const stmt of duckSqls) {
          await invoke('execute_query', { id: connectionId, sql: stmt })
        }
        setExecOk(true)
        onDone()
      } catch (e) { setExecErr(String(e)) }
      finally { setExecuting(false) }
      return
    }
    if (sql === '-- 无变更') return
    setExecuting(true); setExecErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('execute_query', { id: connectionId, sql })
      setExecOk(true)
      onDone()
    } catch (e) { setExecErr(String(e)) }
    finally { setExecuting(false) }
  }

  return createPortal(
    <div className="dbtool-overlay">
      <div className="dbtool-modal alter-wizard">
        <div className="dbtool-modal__header">
          <span className="dbtool-modal__title">改表向导 — {schema ? `${schema}.` : ''}{table}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {mariaExtra && (
              <>
                {mariaExtra.engine && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
                    {mariaExtra.engine}
                  </span>
                )}
                {mariaExtra.hasSystemVersioning && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.25)' }}
                    title="此表启用了系统版本化（WITH SYSTEM VERSIONING），改表时会自动保留">
                    时态表
                  </span>
                )}
                {mariaPeriods.map(p => (
                  <span key={p.name} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(20,184,166,0.1)', color: '#14b8a6', border: '1px solid rgba(20,184,166,0.25)' }}
                    title={`PERIOD FOR ${p.name} (${p.start}, ${p.end})：应用期（双时态）列定义`}>
                    期: {p.name}
                  </span>
                ))}
                {/* MA4.4 — 特殊存储引擎提示徽章 */}
                {mariaExtra.engine === 'ColumnStore' && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(234,88,12,0.1)', color: 'var(--warning)', border: '1px solid rgba(234,88,12,0.25)' }}
                    title="ColumnStore 列式引擎：不支持行编辑，仅适用于批量分析查询">
                    列存 · 不支持行编辑
                  </span>
                )}
                {mariaExtra.engine === 'Spider' && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(99,102,241,0.1)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.25)' }}
                    title="Spider 分片引擎：数据分布在多个后端服务器，查询会路由到各分片节点">
                    分片 (Spider)
                  </span>
                )}
                {mariaExtra.engine === 'CONNECT' && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(99,102,241,0.1)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.25)' }}
                    title="CONNECT 引擎：外部数据源表（CSV/XML/JSON/ODBC 等），写操作支持有限">
                    外部数据源 (CONNECT)
                  </span>
                )}
                {mariaExtra.engine === 'Aria' && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                    title="Aria 引擎（MariaDB 专属 MyISAM 替代品）：支持崩溃安全，但无事务支持。表损坏时可用 aria_chk 修复">
                    Aria · 无事务
                  </span>
                )}
              </>
            )}
            <button className="dbtool-modal__close" onClick={onClose}><X size={14} /></button>
          </div>
        </div>

        {loading ? (
          <div className="dbtool-modal__body"><span style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载列信息…</span></div>
        ) : error ? (
          <div className="dbtool-modal__body"><span className="dbtool-badge dbtool-badge--err">{error}</span></div>
        ) : (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>
            {/* 左侧列列表 */}
            <div className="alter-col-list" style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>列</span>
                <button className="dbtool-btn dbtool-btn--ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={addCol}>
                  <Plus size={11} /> 添加列
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 50px 1fr 28px', gap: 3, marginBottom: 4, padding: '0 4px' }}>
                {[isMaria ? '列名 (INVIS=隐 P/V=生成)' : '列名', '类型', 'NULL', '默认值', ''].map((h, i) => (
                  <span key={i} style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>{h}</span>
                ))}
              </div>
              {cols.map(col => (
                <div key={col._id} className={`alter-col-row${col._deleted ? ' alter-col-row--deleted' : ''}${col._isNew ? ' alter-col-row--new' : ''}`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <input className="alter-col-inp" value={col.name} disabled={col._deleted}
                      onChange={e => update(col._id, 'name', e.target.value)} placeholder="列名"
                      style={{ flex: 1, minWidth: 0 }} />
                    {isMaria && !col._isVirtual && !col._isPersistent && (
                      <button
                        onClick={() => update(col._id, '_invisible', !col._invisible)}
                        title={col._invisible ? '当前 INVISIBLE，点击改为 VISIBLE' : '点击设为 INVISIBLE（不出现在 SELECT * 中）'}
                        style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, flexShrink: 0, border: '1px solid', cursor: 'pointer',
                          background: col._invisible ? 'rgba(99,102,241,0.12)' : 'transparent',
                          color: col._invisible ? '#818cf8' : 'var(--border)',
                          borderColor: col._invisible ? 'rgba(99,102,241,0.3)' : 'var(--border)',
                        }}
                      >隐</button>
                    )}
                    {col._isPersistent && (
                      <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(20,184,166,0.12)', color: '#2dd4bf', flexShrink: 0 }} title="PERSISTENT 生成列">P</span>
                    )}
                    {col._isVirtual && (
                      <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(234,179,8,0.12)', color: '#fbbf24', flexShrink: 0 }} title="VIRTUAL 生成列">V</span>
                    )}
                  </div>
                  <input className="alter-col-inp" value={col.dataType} disabled={col._deleted || col._isVirtual || col._isPersistent}
                    onChange={e => update(col._id, 'dataType', e.target.value)} placeholder="类型"
                    title={col._isVirtual || col._isPersistent ? '生成列类型不可直接编辑' : undefined} />
                  <input type="checkbox" checked={col.nullable} disabled={col._deleted}
                    onChange={e => update(col._id, 'nullable', e.target.checked)}
                    style={{ accentColor: 'var(--accent)', margin: 'auto' }} />
                  <input className="alter-col-inp" value={col.defaultValue} disabled={col._deleted}
                    onChange={e => update(col._id, 'defaultValue', e.target.value)} placeholder="默认值" />
                  {col._deleted ? (
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fb923c', fontSize: 10 }}
                      onClick={() => update(col._id, '_deleted', false)} title="恢复">↩</button>
                  ) : (
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171' }}
                      onClick={() => update(col._id, '_deleted', true)} title="删除列">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* 右侧 SQL 预览 */}
            <div className="alter-sql-preview" style={{ flex: 1 }}>
              {isSqlite ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>SQLite 变更预览</span>
                    <button className="dbtool-btn dbtool-btn--ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={loadSqlitePreview} disabled={previewLoading}>
                      {previewLoading ? <Loader2 size={11} className="spin" /> : <Eye size={11} />}
                      生成预览
                    </button>
                  </div>
                  {previewErr && <div className="dbtool-badge dbtool-badge--err" style={{ marginBottom: 8, fontSize: 12 }}>{previewErr}</div>}
                  {sqlitePreview && (
                    <>
                      {sqlitePreview.kind === 'rebuild' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.25)', borderRadius: 6, marginBottom: 8, fontSize: 12, color: 'var(--warning)' }}>
                          <AlertTriangle size={13} />
                          此变更需要重建表（12步骤），含事务+外键检查。强烈建议先备份。
                        </div>
                      )}
                      <pre className="alter-sql-block" style={{ maxHeight: 280, overflowY: 'auto', fontSize: 11 }}>{sqlitePreview.sqlScript}</pre>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                        我已审阅上述 SQL，确认执行
                      </label>
                    </>
                  )}
                </>
              ) : isDuck ? (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
                    DuckDB ALTER 语句（{duckSqls.length} 条，逐条执行）
                  </div>
                  <pre className="alter-sql-block" style={{ fontSize: 11 }}>
                    {duckSqls.length > 0 ? duckSqls.join('\n') : '-- 无变更'}
                  </pre>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>生成的 ALTER SQL</div>
                  <pre className="alter-sql-block">{sql}</pre>
                </>
              )}
              {execErr && <div className="dbtool-badge dbtool-badge--err" style={{ marginTop: 8, fontSize: 12 }}>{execErr}</div>}
              {execOk && <div className="dbtool-badge dbtool-badge--ok" style={{ marginTop: 8 }}>✓ 执行成功</div>}
            </div>
          </div>
        )}

        <div className="dbtool-modal__footer">
          <button className="dbtool-btn dbtool-btn--cancel" onClick={onClose}>关闭</button>
          {isSqlite ? (
            <button className="dbtool-btn dbtool-btn--primary" onClick={execute}
              disabled={executing || loading || !sqlitePreview || !confirmed}>
              {executing ? <><Loader2 size={12} className="spin" />执行中…</> : '确认执行'}
            </button>
          ) : isDuck ? (
            <button className="dbtool-btn dbtool-btn--primary" onClick={execute}
              disabled={executing || loading || duckSqls.length === 0}>
              {executing ? '执行中…' : `执行 ALTER（${duckSqls.length} 条）`}
            </button>
          ) : (
            <button className="dbtool-btn dbtool-btn--primary" onClick={execute}
              disabled={executing || loading || sql === '-- 无变更'}>
              {executing ? '执行中…' : '执行 ALTER'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
