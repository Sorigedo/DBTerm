import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, FunctionSquare, Plus, ArrowUp, ArrowDown, HelpCircle } from 'lucide-react'
import type { ConnType } from '../../types'
import { qid, dialectFamily } from '../../utils/sqlDialect'
import { useAppStore } from '../../stores/appStore'
import { useObjectDraftStore } from '../../stores/objectDraftStore'
import { wid } from '../../utils/windowTag'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  connType: ConnType
  schema: string
  kind: 'function' | 'procedure'
  onClose: () => void
}

interface Param { name: string; type: string; length: string; mode: 'IN' | 'OUT' | 'INOUT' }

// 各方言常用数据类型（参考 Navicat 的类型下拉顺序：数值 → 字符 → 二进制 → 日期 → 其它）
const MYSQL_TYPES = [
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BIT', 'BOOLEAN',
  'CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'ENUM', 'SET',
  'BINARY', 'VARBINARY', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'JSON', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON',
]
const PG_TYPES = [
  'SMALLINT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'MONEY', 'BOOLEAN',
  'CHAR', 'VARCHAR', 'TEXT', 'BYTEA',
  'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
  'UUID', 'JSON', 'JSONB', 'XML', 'INET', 'CIDR', 'ARRAY',
]
const SQLSERVER_TYPES = [
  'TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'BIT',
  'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'NTEXT',
  'BINARY', 'VARBINARY', 'IMAGE',
  'DATE', 'TIME', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET',
  'UNIQUEIDENTIFIER', 'XML',
]
const ORACLE_TYPES = [
  'NUMBER', 'INTEGER', 'PLS_INTEGER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'BOOLEAN',
  'CHAR', 'VARCHAR2', 'NCHAR', 'NVARCHAR2', 'CLOB', 'NCLOB', 'BLOB', 'RAW',
  'DATE', 'TIMESTAMP', 'ROWID',
]
const CLICKHOUSE_TYPES = [
  'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Float32', 'Float64', 'Decimal', 'Bool',
  'String', 'FixedString', 'UUID',
  'Date', 'DateTime', 'DateTime64',
]
function typesFor(connType: ConnType): string[] {
  if (['postgres', 'kingBase', 'openGauss'].includes(connType)) return PG_TYPES
  if (connType === 'sqlServer')  return SQLSERVER_TYPES
  if (connType === 'oracle')     return ORACLE_TYPES
  if (connType === 'clickHouse') return CLICKHOUSE_TYPES
  return MYSQL_TYPES
}
const DATA_ACCESS = ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA']

// 只有这些类型才需要「长度/精度」（如 VARCHAR(255)、DECIMAL(15,2)）；INT/TEXT/DATE/JSON 等无需
const TYPES_WITH_LEN = new Set([
  'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'VARCHAR2', 'NVARCHAR2', 'FIXEDSTRING',
  'BINARY', 'VARBINARY', 'RAW',
  'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'BIT', 'NUMBER',
])
function typeNeedsLen(type: string): boolean {
  const base = (type || '').trim().toUpperCase().replace(/\(.*$/, '').trim()
  return TYPES_WITH_LEN.has(base) || base === 'DOUBLE PRECISION'
}

let objSeq = 0

export default function RoutineWizard({ connectionId, connType, schema, kind, onClose }: Props) {
  const isFunc = kind === 'function'
  const TYPES = typesFor(connType)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [params, setParams] = useState<Param[]>([])
  // 函数返回类型属性
  const [retType, setRetType] = useState('INT')
  const [retLen, setRetLen] = useState('')
  const [deterministic, setDeterministic] = useState(false)
  const [dataAccess, setDataAccess] = useState('')
  const [sqlSecurity, setSqlSecurity] = useState<'' | 'DEFINER' | 'INVOKER'>('')

  const openTab = useAppStore((s) => s.openTab)
  const setDraft = useObjectDraftStore((s) => s.setDraft)

  const lastStep = isFunc ? 2 : 1

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function addParam() {
    setParams((p) => [...p, { name: '', type: 'INT', length: '', mode: 'IN' }])
  }
  function delParam(i: number) { setParams((p) => p.filter((_, idx) => idx !== i)) }
  function moveParam(i: number, dir: -1 | 1) {
    setParams((p) => {
      const j = i + dir
      if (j < 0 || j >= p.length) return p
      const next = [...p]; const t = next[i]; next[i] = next[j]; next[j] = t; return next
    })
  }
  function updateParam(i: number, patch: Partial<Param>) {
    setParams((p) => p.map((row, idx) => idx === i ? { ...row, ...patch } : row))
  }

  function typeWithLen(type: string, len: string): string {
    const t = (type || 'INT').trim()
    if (!typeNeedsLen(t)) return t   // INT/TEXT 等不带长度，忽略残留的旧值
    // 容错：把 “15/2”“15 / 2” 之类规范成 “15,2”，避免手输分隔符不对
    const l = len.trim().replace(/[/、]/g, ',').replace(/\s+/g, '')
    return l ? `${t}(${l})` : t
  }

  function buildDdl(): string {
    const n = name.trim() || (isFunc ? 'new_function' : 'new_procedure')
    // 不带库限定：目标库由设计页的 schema 下拉决定
    const ref = qid(connType, n)
    const paramList = params
      .filter((p) => p.name.trim())
      .map((p) => {
        const decl = `${qid(connType, p.name.trim())} ${typeWithLen(p.type, p.length)}`
        return isFunc ? decl : `${p.mode} ${decl}`
      })
      .join(', ')

    const fam = dialectFamily(connType)

    if (isFunc) {
      // PG 系（含达梦：dialectFamily 归入 postgres）：CREATE FUNCTION ... RETURNS type AS $$ ... $$ LANGUAGE plpgsql
      if (fam === 'postgres') {
        return [
          `CREATE OR REPLACE FUNCTION ${ref}(${paramList})`,
          `RETURNS ${typeWithLen(retType, retLen)} AS $$`,
          `BEGIN`,
          `  -- 在此编写函数体`,
          `  RETURN 0;`,
          `END;`,
          `$$ LANGUAGE plpgsql;`,
        ].join('\n')
      }
      // 其它非 MySQL 方言（SQLServer/SQLite/DuckDB 等）暂无完善模板：仅给基础壳，不输出 MySQL 专属子句
      if (fam !== 'mysql') {
        return [
          `CREATE FUNCTION ${ref}(${paramList})`,
          `RETURNS ${typeWithLen(retType, retLen)}`,
          `BEGIN`,
          `  -- 在此编写函数体`,
          `  RETURN 0;`,
          `END`,
        ].join('\n')
      }
      // MySQL 系：保持原逻辑（DETERMINISTIC / READS SQL DATA / SQL SECURITY）
      const attrs: string[] = []
      attrs.push(deterministic ? 'DETERMINISTIC' : 'NOT DETERMINISTIC')
      // binlog 开启时函数必须声明 DETERMINISTIC/NO SQL/READS SQL DATA 之一，否则报 1418；
      // 未显式选数据访问且非确定性 → 默认 READS SQL DATA（安全、最常见，可保存即用）
      const access = dataAccess || (deterministic ? '' : 'READS SQL DATA')
      if (access) attrs.push(access)
      if (sqlSecurity) attrs.push(`SQL SECURITY ${sqlSecurity}`)
      return [
        `CREATE FUNCTION ${ref}(${paramList})`,
        `RETURNS ${typeWithLen(retType, retLen)}`,
        ...attrs,
        `BEGIN`,
        `  -- 在此编写函数体`,
        `  RETURN 0;`,
        `END`,
      ].join('\n')
    }

    // 存储过程：PG 系用 CREATE PROCEDURE ... AS $$ ... $$ LANGUAGE plpgsql
    if (fam === 'postgres') {
      return [
        `CREATE OR REPLACE PROCEDURE ${ref}(${paramList})`,
        `AS $$`,
        `BEGIN`,
        `  -- 在此编写过程体`,
        `END;`,
        `$$ LANGUAGE plpgsql;`,
      ].join('\n')
    }
    return [
      `CREATE PROCEDURE ${ref}(${paramList})`,
      `BEGIN`,
      `  -- 在此编写过程体`,
      `END`,
    ].join('\n')
  }

  function finish() {
    const n = name.trim() || (isFunc ? 'new_function' : 'new_procedure')
    const ddl = buildDdl()
    objSeq += 1
    const tabId = wid(`${connectionId}-objedit-${objSeq}`)
    setDraft(tabId, { schema, objType: kind, name: n, ddl, mode: 'create' })
    openTab({ id: tabId, connectionId, title: `新建${isFunc ? '函数' : '存储过程'} - ${n}`, type: 'object-editor' })
    onClose()
  }

  const stepTitle = step === 0 ? '请输入名称'
    : step === 1 ? '请输入参数'
    : '返回类型属性'

  return createPortal(
    <div className="dbtool-overlay" onMouseDown={onClose}>
      <div className="dbtool-modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 600 }}>
        <div className="dbtool-modal__header">
          <FunctionSquare size={15} color="var(--accent)" />
          <span className="dbtool-modal__title">{isFunc ? '函数' : '存储过程'}向导 — {stepTitle}</span>
          <button className="dbtool-modal__close" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="dbtool-modal__body" style={{ minHeight: 220 }}>
          {/* Step 0：名称 */}
          {step === 0 && (
            <div className="dbtool-field">
              <label className="dbtool-label">名称</label>
              <input
                autoFocus value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setStep(1) }}
                placeholder={isFunc ? '例如：fn_calc_total' : '例如：sp_sync_orders'}
                className="dbtool-input"
              />
            </div>
          )}

          {/* Step 1：参数列表 */}
          {step === 1 && (
            <>
              <div className="rw-params">
                <div className="rw-params__head">
                  {!isFunc && <span className="rw-col-mode">模式</span>}
                  <span className="rw-col-name">名称</span>
                  <span className="rw-col-type">类型</span>
                  <span className="rw-col-len">长度/精度</span>
                  <span className="rw-col-act" />
                </div>
                {params.length === 0 && (
                  <div className="rw-params__empty">暂无参数，点击「添加参数」</div>
                )}
                {params.map((p, i) => (
                  <div className="rw-params__row" key={i}>
                    {!isFunc && (
                      <div className="rw-col-mode">
                        <SearchableSelect value={p.mode} mono={false}
                          options={['IN', 'OUT', 'INOUT']}
                          onChange={(v) => updateParam(i, { mode: v as Param['mode'] })} />
                      </div>
                    )}
                    <input className="dbtool-input rw-col-name" value={p.name}
                      onChange={(e) => updateParam(i, { name: e.target.value })} placeholder="参数名" />
                    <div className="rw-col-type">
                      <SearchableSelect value={p.type} options={TYPES} placeholder="选择类型"
                        searchPlaceholder="搜索类型…" onChange={(v) => updateParam(i, { type: v })} />
                    </div>
                    {typeNeedsLen(p.type)
                      ? <input className="dbtool-input rw-col-len" value={p.length}
                          onChange={(e) => updateParam(i, { length: e.target.value })} placeholder="如 255 或 15,2" />
                      : <span className="rw-col-len rw-col-len--na">—</span>}
                    <div className="rw-col-act">
                      <button className="dbtool-modal__close" onClick={() => moveParam(i, -1)} disabled={i === 0} data-tip="上移"><ArrowUp size={13} /></button>
                      <button className="dbtool-modal__close" onClick={() => moveParam(i, 1)} disabled={i === params.length - 1} data-tip="下移"><ArrowDown size={13} /></button>
                      <button className="dbtool-modal__close" onClick={() => delParam(i)} data-tip="删除"><X size={13} /></button>
                    </div>
                  </div>
                ))}
                <button className="rw-add-row" onClick={addParam}>
                  <Plus size={14} strokeWidth={2.2} />添加参数
                </button>
              </div>
            </>
          )}

          {/* Step 2：函数返回类型属性 */}
          {step === 2 && isFunc && (
            <>
              <div className="rw-note">这些是 MySQL 函数的可选特性，新手保持默认直接「完成」即可；不懂的项把鼠标移到 <HelpCircle size={12} style={{ verticalAlign: -2 }} /> 上看说明。</div>

              <div className="dbtool-field dbtool-field--row">
                <label className="dbtool-label" style={{ width: 96 }}>返回类型</label>
                <SearchableSelect value={retType} options={TYPES} placeholder="选择类型"
                  searchPlaceholder="搜索类型…" onChange={setRetType} />
                {typeNeedsLen(retType) && (
                  <input className="dbtool-input rw-len-input" value={retLen} onChange={(e) => setRetLen(e.target.value)} placeholder="如 255 或 15,2" style={{ width: 130 }} />
                )}
              </div>

              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
                <input type="checkbox" checked={deterministic} onChange={(e) => setDeterministic(e.target.checked)} />
                具有确定性（DETERMINISTIC）
                <HelpCircle className="rw-help" size={14}
                  data-tip={'相同输入是否总返回相同结果。\n纯计算才勾；用了 NOW()/RAND()/查表 等不要勾。拿不准保持不勾最安全。'} />
              </label>

              <div className="dbtool-field dbtool-field--row">
                <label className="dbtool-label rw-label" style={{ width: 96 }}>
                  数据访问
                  <HelpCircle className="rw-help" size={14}
                    data-tip={'声明函数如何访问数据：\nREADS SQL DATA = 只读\nMODIFIES SQL DATA = 会写\nCONTAINS SQL = 纯计算\nNO SQL = 无 SQL\n不确定可保持「不指定」。'} />
                </label>
                <SearchableSelect value={dataAccess} mono={false} placeholder="（不指定）"
                  items={[{ value: '', label: '（不指定）' }, ...DATA_ACCESS.map((d) => ({ value: d, label: d }))]}
                  onChange={setDataAccess} />
              </div>

              <div className="dbtool-field dbtool-field--row">
                <label className="dbtool-label rw-label" style={{ width: 96 }}>
                  SQL 安全性
                  <HelpCircle className="rw-help" size={14}
                    data-tip={'函数运行时用谁的权限访问表：\nDEFINER = 定义者权限（默认，方便但权限放大）\nINVOKER = 调用者权限（更安全）。'} />
                </label>
                <SearchableSelect value={sqlSecurity} mono={false} placeholder="（不指定）"
                  items={[{ value: '', label: '（不指定）' }, { value: 'DEFINER', label: 'DEFINER' }, { value: 'INVOKER', label: 'INVOKER' }]}
                  onChange={(v) => setSqlSecurity(v as any)} />
              </div>
            </>
          )}
        </div>

        <div className="dbtool-modal__footer" style={{ justifyContent: 'space-between' }}>
          <button className="dbtool-btn dbtool-btn--cancel" onClick={onClose}>取消</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && <button className="dbtool-btn dbtool-btn--cancel" onClick={() => setStep(step - 1)}>上一步</button>}
            {step < lastStep && <button className="dbtool-btn dbtool-btn--primary" onClick={() => setStep(step + 1)}>下一步</button>}
            {step === lastStep && <button className="dbtool-btn dbtool-btn--primary" onClick={finish}>完成</button>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
