import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowRight, ArrowLeft, Table2, Eye, Check, AlertCircle, ChevronDown, Search, Braces, Workflow } from 'lucide-react'
import type { ConnConfig } from '../../types'
import SearchableSelect from './SearchableSelect'
import { notifySchemaChanged } from '../../utils/schemaRefresh'
import { recreateObject } from '../../utils/dbCopyPaste'
import { MIGRATABLE_DB_TYPES, isMysqlFamily } from '../../utils/sqlDialect'
import { supportedMigrationStrategies, type MigrationStrategy } from '../../utils/migrationChoices'
import { migrationResultFailure, migrationResultNotices, markMigrationUnexecuted, migrationVerificationLabel, MIGRATION_BATCH_BOUNDARY } from './migrationRunSafety'
import type { MigrationVerificationResult } from './migrationRunSafety'

interface Props {
  connections: ConnConfig[]
  defaultSrcId?: string
  defaultSrcSchema?: string
  defaultDstId?: string
  defaultDstSchema?: string
  /** 预选的源表（从「复制表 → 粘贴到其他 schema」进入时自动勾选） */
  defaultTable?: string
  /** 多表预选（多选复制 → 跨库粘贴进入时默认全部勾选）；优先于 defaultTable */
  defaultTables?: string[]
  onClose: () => void
}

type Strategy = MigrationStrategy
type ContentMode = 'both' | 'structure' | 'data'

interface TableInfo {
  name: string
  isView: boolean
}

interface MigrateResult {
  totalRows: number
  migratedRows: number
  skippedRows: number
  failedRows: number
  elapsedMs: number
  errors: string[]
}

interface ProgressEvent {
  stage: string
  totalRows: number
  migratedRows: number
}

interface TableProgress {
  table: string
  objType?: 'table' | 'view' | 'function' | 'procedure'
  stage: string
  totalRows: number
  migratedRows: number
  done: boolean
  unexecuted?: boolean
  error?: string
  notice?: string
}

const STRATEGY_LABELS: Record<Strategy, string> = {
  replace: '覆盖（重建）',
  truncate: '清空重写',
  append: '追加',
  skip: '跳过',
}

const STRATEGY_DESCS: Record<Strategy, string> = {
  replace: '按源表原始 DDL 创建暂存表并迁入数据，校验后切换为目标表；已有目标表在切换时改名为备份并保留，不自动删除。遇到外键依赖或可见触发器会中止',
  truncate: '仅数据模式：先验证目标表结构与源表一致，再清空数据并写入；目标表须已存在且支持事务',
  append: '仅数据模式：先验证目标表结构与源表一致，再追加数据；目标表须已存在且支持事务',
  skip: '目标表已存在则跳过；不存在则自动建表后迁移',
}

const CONTENT_LABELS: Record<ContentMode, string> = {
  both: '结构+数据',
  structure: '仅结构',
  data: '仅数据',
}

const STEPS = ['选择源', '选择目标', '配置选项', '确认预览', '执行', '结果']

// 迁移类型白名单从 sqlDialect 单一真源引入（与 SchemaBrowser 迁移入口共用，避免清单分叉）
const DB_TYPES = MIGRATABLE_DB_TYPES as string[]

function isDbConn(c: ConnConfig) {
  return DB_TYPES.includes(c.type)
}

// 系统库不应作为默认 schema（迁移误写系统库风险高）
const SYSTEM_SCHEMAS = new Set([
  'information_schema', 'performance_schema', 'mysql', 'sys',
  'pg_catalog', 'pg_toast',
])
function pickDefaultSchema(schemas: string[]): string {
  return schemas.find(s => !SYSTEM_SCHEMAS.has(s.toLowerCase())) ?? schemas[0] ?? ''
}

function SelectField({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</label>
      <SearchableSelect value={value} onChange={onChange} items={options} mono={false} searchPlaceholder="搜索…" />
    </div>
  )
}

function ProgressBar({ value, max, color = 'var(--accent)' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div style={{ width: '100%', height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
      <div className={max > 0 ? undefined : 'migration-progress-indeterminate'} style={{ width: max > 0 ? `${pct}%` : '35%', height: '100%', background: color, borderRadius: 3, transition: 'width 0.2s' }} />
    </div>
  )
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {STEPS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={i} style={{ flex: i < total - 1 ? 1 : '0 0 auto', display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 50 }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', fontSize: 12, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: done || active ? 'var(--accent)' : 'var(--surface-2)',
                color: done || active ? '#fff' : 'var(--text-muted)',
                border: done || active ? 'none' : '1px solid var(--border)',
                boxShadow: active ? '0 0 0 4px var(--accent-bg)' : 'none',
                transition: 'background 0.2s, box-shadow 0.2s',
              }}>
                {done ? <Check size={13} strokeWidth={3} /> : i + 1}
              </div>
              <span style={{
                fontSize: 11, whiteSpace: 'nowrap',
                fontWeight: active ? 600 : 400,
                color: active ? 'var(--text-bright)' : done ? 'var(--text)' : 'var(--text-muted)',
              }}>{label}</span>
            </div>
            {i < total - 1 && (
              <div style={{ flex: 1, height: 2, borderRadius: 2, marginTop: 12, background: done ? 'var(--accent)' : 'var(--border)', transition: 'background 0.2s' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function MigrationWizard({ connections, defaultSrcId, defaultSrcSchema, defaultDstId, defaultDstSchema, defaultTable, defaultTables, onClose }: Props) {
  const [step, setStep] = useState(0)

  // Step 0: source
  const dbConns = connections.filter(isDbConn)
  const [srcId, setSrcId] = useState(dbConns.find(c => c.id === defaultSrcId)?.id ?? dbConns[0]?.id ?? '')
  const [srcSchema, setSrcSchema] = useState('')
  const [srcSchemas, setSrcSchemas] = useState<string[]>([])
  // 迁移对象类型：表(搬结构+数据) / 视图·函数·存储过程(重建定义)，支持多类型同时迁移
  type ObjType = 'table' | 'view' | 'function' | 'procedure'
  interface SrcObj { name: string; type: ObjType; isView: boolean }
  const OBJ_LABELS: Record<ObjType, string> = { table: '表', view: '视图', function: '函数', procedure: '存储过程' }
  const OBJ_ORDER: ObjType[] = ['table', 'view', 'function', 'procedure'] // 执行顺序：表先建，再视图/函数/存储过程（依赖兜底）
  const objKey = (o: { type: ObjType; name: string }) => `${o.type}::${o.name}`

  const [srcObjects, setSrcObjects] = useState<SrcObj[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set()) // 复合键 `${type}::${name}`
  const [tableSearch, setTableSearch] = useState('')
  const [objTypes, setObjTypes] = useState<Set<ObjType>>(new Set(['table']))
  const objLabel = objTypes.size === 1 ? OBJ_LABELS[[...objTypes][0]] : '对象'

  // Step 1: destination
  const [dstId, setDstId] = useState(dbConns.find(c => c.id === defaultDstId)?.id ?? dbConns[0]?.id ?? '')
  const [dstSchema, setDstSchema] = useState('')
  const [dstSchemas, setDstSchemas] = useState<string[]>([])

  // Step 2: options
  const [strategy, setStrategy] = useState<Strategy>('replace')
  const [batchSize, setBatchSize] = useState(1000)
  const [content, setContent] = useState<ContentMode>('both')
  const [whereClause, setWhereClause] = useState('')
  const [rowLimit, setRowLimit] = useState(0)
  const [advOpen, setAdvOpen] = useState(false)

  // 仅完整定义复制后端支持的 MySQL 系连接可迁移
  const srcConnType = connections.find(c => c.id === srcId)?.type ?? ''
  const dstConnType = connections.find(c => c.id === dstId)?.type ?? ''

  // 选中对象（含类型）及派生量
  const selectedObjs = srcObjects.filter(o => selected.has(objKey(o)))
  const selectedSorted = [...selectedObjs].sort((a, b) => OBJ_ORDER.indexOf(a.type) - OBJ_ORDER.indexOf(b.type))
  const selectedTableNames = selectedObjs.filter(o => o.type === 'table').map(o => o.name)
  const hasTables = selectedObjs.some(o => o.type === 'table')
  const hasNonTable = selectedObjs.some(o => o.type !== 'table')

  // Step 4: execution
  const [tableProgress, setTableProgress] = useState<TableProgress[]>([])
  const [currentTableIdx, setCurrentTableIdx] = useState(0)
  const [migrating, setMigrating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  // Step 5: result
  const [resultOk, setResultOk] = useState(false)
  const [resultErrors, setResultErrors] = useState<string[]>([])
  const [totalMigrated, setTotalMigrated] = useState(0)

  // Q6: post-migration verify
  const [verifying, setVerifying] = useState(false)
  const [verifyResults, setVerifyResults] = useState<MigrationVerificationResult[] | null>(null)

  const [error, setError] = useState('')
  const [loading] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load src schemas when srcId changes
  useEffect(() => {
    if (!srcId) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const schemas = await invoke<string[]>('list_schemas', { id: srcId })
        if (alive) {
          setSrcSchemas(schemas)
          // 从某个 schema 进入向导时，优先选中该 schema（仅对来源连接生效）
          const preferred = (srcId === defaultSrcId && defaultSrcSchema && schemas.includes(defaultSrcSchema))
            ? defaultSrcSchema
            : pickDefaultSchema(schemas)
          setSrcSchema(preferred)
        }
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [srcId])

  // Load src objects when schema / 对象类型集合 changes
  useEffect(() => {
    if (!srcId || !srcSchema || objTypes.size === 0) { setSrcObjects([]); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const acc: SrcObj[] = []
        // 表/视图共用 list_tables 一次查询
        if (objTypes.has('table') || objTypes.has('view')) {
          const list = await invoke<TableInfo[]>('list_tables', { id: srcId, schema: srcSchema })
          if (objTypes.has('table')) acc.push(...list.filter(t => !t.isView).map(t => ({ name: t.name, type: 'table' as ObjType, isView: false })))
          if (objTypes.has('view')) acc.push(...list.filter(t => t.isView).map(t => ({ name: t.name, type: 'view' as ObjType, isView: true })))
        }
        // 函数/存储过程共用 list_routines 一次查询
        if (objTypes.has('function') || objTypes.has('procedure')) {
          const list = await invoke<{ name: string; routineType: string }[]>('list_routines', { id: srcId, schema: srcSchema })
          if (objTypes.has('function')) acc.push(...list.filter(r => r.routineType === 'FUNCTION').map(r => ({ name: r.name, type: 'function' as ObjType, isView: false })))
          if (objTypes.has('procedure')) acc.push(...list.filter(r => r.routineType === 'PROCEDURE').map(r => ({ name: r.name, type: 'procedure' as ObjType, isView: false })))
        }
        if (!alive) return
        setSrcObjects(acc)
        // 保留已选（剔除已不存在的类型/对象）；初次为空时自动勾选预选源表（多选复制默认全勾，仅 table）
        setSelected(prev => {
          const pruned = new Set([...prev].filter(k => acc.some(o => objKey(o) === k)))
          if (pruned.size === 0 && objTypes.has('table') && srcId === defaultSrcId && srcSchema === defaultSrcSchema) {
            const presetNames = (defaultTables && defaultTables.length ? defaultTables
              : defaultTable ? [defaultTable] : [])
            presetNames.filter(n => acc.some(o => o.type === 'table' && o.name === n)).forEach(n => pruned.add(`table::${n}`))
          }
          return pruned
        })
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [srcId, srcSchema, objTypes])

  // Load dst schemas when dstId changes
  useEffect(() => {
    if (!dstId) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const schemas = await invoke<string[]>('list_schemas', { id: dstId })
        if (alive) {
          setDstSchemas(schemas)
          // 与会话保持一致：从某连接进入时，目标默认沿用会话的 schema（用户再改到实际目标）
          const preferred = (dstId === defaultDstId && defaultDstSchema && schemas.includes(defaultDstSchema))
            ? defaultDstSchema
            : pickDefaultSchema(schemas)
          setDstSchema(preferred)
        }
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [dstId, defaultDstId, defaultDstSchema])

  // 对象类型多选切换（至少保留一个）
  const toggleType = (t: ObjType) => {
    setObjTypes(prev => {
      const n = new Set(prev)
      n.has(t) ? n.delete(t) : n.add(t)
      if (n.size === 0) n.add(t)
      return n
    })
  }

  const toggleObj = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const toggleAll = () => {
    const vis = srcObjects.filter(o => !tableSearch || o.name.toLowerCase().includes(tableSearch.toLowerCase()))
    const allOn = vis.length > 0 && vis.every(o => selected.has(objKey(o)))
    setSelected(prev => {
      const n = new Set(prev)
      vis.forEach(o => { if (allOn) n.delete(objKey(o)); else n.add(objKey(o)) })
      return n
    })
  }

  const validate = useCallback((): boolean => {
    setError('')
    if (step === 0) {
      if (!srcId) { setError('请选择源连接'); return false }
      if (!srcSchema) { setError('请选择源 Schema'); return false }
      if (selected.size === 0) { setError(`请至少选择一个${objLabel}`); return false }
    }
    if (step === 1) {
      if (!dstId) { setError('请选择目标连接'); return false }
      if (!dstSchema) { setError('请选择目标 Schema'); return false }
      // 同连接同 Schema 即「迁移到自身」，无意义且会覆盖源对象
      if (dstId === srcId && dstSchema === srcSchema) {
        setError(`目标与源为同一连接和 Schema，将覆盖同名${objLabel}自身。请选择不同的目标 Schema 或连接（同库复制请用「复制粘贴」）`)
        return false
      }
      if (!isMysqlFamily(srcConnType) || !isMysqlFamily(dstConnType)) {
        setError('完整定义迁移目前仅支持 MySQL 系数据库，请重新选择连接')
        return false
      }
    }
    return true
  }, [step, srcId, srcSchema, selected, dstId, dstSchema, srcConnType, dstConnType])

  const next = () => {
    if (!validate()) return
    setStep(s => s + 1)
  }

  const back = () => {
    setError('')
    setStep(s => s - 1)
  }

  const runMigration = async () => {
    if (!isMysqlFamily(srcConnType) || !isMysqlFamily(dstConnType)
      || (hasTables && !supportedMigrationStrategies(content).includes(strategy))) {
      setError('当前迁移组合不能保证源表定义一致，已取消执行')
      return
    }
    const objs = selectedSorted // 按 表→视图→函数→存储过程 顺序执行
    setStep(4)
    setMigrating(true)
    setCurrentTableIdx(0)
    setTotalMigrated(0)
    const t0 = Date.now()
    setVerifyResults(null)
    const errors: string[] = []
    let totalRows = 0
    let nextObject = 0

    const progress: TableProgress[] = objs.map(o => ({
      table: o.name, objType: o.type, stage: '等待中', totalRows: 0, migratedRows: 0, done: false,
    }))
    setTableProgress([...progress])

    timerRef.current = setInterval(() => setElapsed(Date.now() - t0), 500)

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')

      for (let i = 0; i < objs.length; i++) {
        nextObject = i
        setCurrentTableIdx(i)
        const obj = objs[i]
        const tbl = obj.name

        progress[i] = { ...progress[i], stage: '准备中', done: false }
        setTableProgress([...progress])

        // 视图/函数/存储过程：在目标重建定义（无数据搬运）
        if (obj.type !== 'table') {
          try {
            await recreateObject(
              { connectionId: srcId, connType: (connections.find(c => c.id === srcId)?.type ?? 'mysql') as any, schema: srcSchema, objType: obj.type, name: tbl },
              { connectionId: dstId, connType: (connections.find(c => c.id === dstId)?.type ?? 'mysql') as any, schema: dstSchema, name: tbl },
            )
            progress[i] = { ...progress[i], done: true, stage: '完成' }
          } catch (e) {
            errors.push(`${OBJ_LABELS[obj.type]} ${tbl}: ${e}`)
            progress[i] = { ...progress[i], done: true, stage: '失败', error: String(e) }
          }
          setTableProgress([...progress])
          nextObject = i + 1
          if (errors.length > 0) {
            setTableProgress(markMigrationUnexecuted(progress, nextObject))
            break
          }
          continue
        }

        const unlisten = await listen<ProgressEvent>('migrate_progress', ev => {
          progress[i] = {
            ...progress[i],
            stage: ev.payload.stage,
            totalRows: ev.payload.totalRows,
            migratedRows: ev.payload.migratedRows,
          }
          setTableProgress([...progress])
        })
        unlistenRef.current = unlisten

        try {
          const result = await invoke<MigrateResult>('db_migrate_table', {
            srcId,
            srcSchema,
            srcTable: tbl,
            dstId,
            dstSchema,
            dstTable: tbl,
            strategy,
            batchSize,
            options: {
              conflictMode: 'error',
              content,
              whereClause: whereClause.trim() || null,
              rowLimit: rowLimit > 0 ? rowLimit : null,
              disableFk: false,
              useTransaction: true,
              errorMode: 'stop',
              columnMap: null,
            },
          })
          // failedRows=插入报错的行；skippedRows=未处理的行（stop中止剩余）
          // tableSkipped=表级跳过（skip策略命中已存在表：migratedRows/totalRows均0且有说明）
          const tableSkipped = strategy === 'skip' && result.migratedRows === 0 && result.totalRows === 0 && result.failedRows === 0 && result.errors.some(message => message === '目标表已存在，按「跳过」策略未迁移')
          const failure = migrationResultFailure(result, strategy)
          if (failure) errors.push(`${tbl}: ${failure}`)
          if (!failure) {
            totalRows += result.migratedRows
            setTotalMigrated(totalRows)
          }
          const tag = failure ? '失败（状态需核查）' : (tableSkipped || result.skippedRows > 0 ? '已跳过' : '完成')
          const tableErr = failure || (tableSkipped ? result.errors[0] : undefined)
          progress[i] = { ...progress[i], done: true, stage: tag, error: tableErr, notice: migrationResultNotices(result).join('；') || undefined, migratedRows: result.migratedRows, totalRows: result.totalRows }
        } catch (e) {
          const msg = `${tbl}: ${e}`
          errors.push(msg)
          progress[i] = { ...progress[i], done: true, stage: '失败', error: String(e) }
        } finally {
          unlisten()
          unlistenRef.current = null
        }

        setTableProgress([...progress])
        nextObject = i + 1
        if (errors.length > 0) {
          setTableProgress(markMigrationUnexecuted(progress, nextObject))
          break
        }
      }
    } catch (e) {
      errors.push(`迁移流程已停止：${String(e)}`)
      setTableProgress(markMigrationUnexecuted(progress, nextObject))
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setElapsed(Date.now() - t0)
      setMigrating(false)
      setResultOk(errors.length === 0)
      setResultErrors(errors)
      setStep(5)
      // 迁移完成：刷新目标库的左侧树与对象预览（新表/数据已写入）
      notifySchemaChanged(dstId, dstSchema)
    }
  }

  const runVerify = useCallback(async () => {
    setVerifying(true)
    setVerifyResults(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const results = await invoke<MigrationVerificationResult[]>(
        'db_verify_migration',
        { srcId, srcSchema, dstId, dstSchema, tables: selectedTableNames },
      )
      setVerifyResults(results)
    } catch (e) {
      setVerifyResults([{ table: '校验失败', srcCount: 0, dstCount: 0, countMatch: false, error: String(e) }])
    } finally {
      setVerifying(false)
    }
  }, [srcId, srcSchema, dstId, dstSchema, selectedTableNames])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (unlistenRef.current) unlistenRef.current()
    }
  }, [])

  const srcConn = dbConns.find(c => c.id === srcId)
  const dstConn = dbConns.find(c => c.id === dstId)


  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <SelectField label="源连接" value={srcId} onChange={setSrcId}
                options={dbConns.map(c => ({ value: c.id, label: c.name }))} />
              <SelectField label="源 Schema" value={srcSchema} onChange={setSrcSchema}
                options={srcSchemas.map(s => ({ value: s, label: s }))} />
            </div>
            {/* 迁移对象类型（可多选，混合迁移：表搬数据、视图/函数/存储过程重建定义） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>对象类型（可多选）</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['table', 'view', 'function', 'procedure'] as ObjType[]).map(t => {
                  const on = objTypes.has(t)
                  return (
                    <button key={t} onClick={() => toggleType(t)} style={{
                      flex: 1, fontSize: 12, height: 30, borderRadius: 7,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      background: on ? 'var(--accent-bg)' : 'var(--surface-2)',
                      color: on ? 'var(--accent)' : 'var(--text)', fontWeight: on ? 600 : 400,
                    }}>
                      {on && <Check size={12} strokeWidth={3} />}{OBJ_LABELS[t]}
                    </button>
                  )
                })}
              </div>
            </div>
            {/* 对象多选 */}
            {(() => {
              const q = tableSearch.trim().toLowerCase()
              const visible = q ? srcObjects.filter(o => o.name.toLowerCase().includes(q)) : srcObjects
              const visAllOn = visible.length > 0 && visible.every(o => selected.has(objKey(o)))
              const multiType = objTypes.size > 1 // 多类型时显示类型标签
              const iconOf = (o: SrcObj) => o.type === 'function' ? Braces : o.type === 'procedure' ? Workflow : (o.type === 'view' || o.isView) ? Eye : Table2
              return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>选择{objLabel}</label>
                <button onClick={toggleAll} style={{ fontSize: 11, color: 'var(--accent)' }}>
                  {visAllOn ? '取消全选' : '全选'}
                </button>
              </div>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search size={14} style={{ position: 'absolute', left: 11, color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input value={tableSearch} onChange={e => setTableSearch(e.target.value)}
                  placeholder={`搜索${objLabel}名…`} spellCheck={false}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, height: 34, padding: '0 30px 0 34px', borderRadius: 8 }} />
                {tableSearch && (
                  <button onClick={() => setTableSearch('')} title="清除"
                    style={{ position: 'absolute', right: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', color: 'var(--text-muted)', background: 'var(--surface-2)', lineHeight: 0 }}>
                    <X size={11} strokeWidth={2.5} />
                  </button>
                )}
              </div>
              <div style={{
                border: '1px solid var(--border)', borderRadius: 8, overflowY: 'auto',
                maxHeight: 260, background: 'var(--surface)', padding: visible.length ? 6 : 0,
              }}>
                {visible.length === 0
                  ? <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{srcObjects.length === 0 ? `暂无${objLabel}` : `无匹配的${objLabel}`}</div>
                  : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                      {visible.map(o => {
                        const key = objKey(o)
                        const on = selected.has(key)
                        const Icon = iconOf(o)
                        return (
                          <label key={key} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, cursor: 'pointer',
                            background: on ? 'var(--accent-bg)' : 'var(--surface-2)',
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                            transition: 'background 0.1s, border-color 0.1s',
                          }}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleObj(key)}
                              style={{ accentColor: 'var(--accent)', width: 13, height: 13, flexShrink: 0 }}
                            />
                            <Icon size={13} color={on ? 'var(--accent)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                            <span style={{ fontSize: 12, color: on ? 'var(--text-bright)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{o.name}</span>
                            {multiType && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>{OBJ_LABELS[o.type]}</span>
                            )}
                          </label>
                        )
                      })}
                    </div>
                  )
                }
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                已选 {selected.size} / {srcObjects.length} 个{objLabel}{q ? ` · 匹配 ${visible.length}` : ''}
              </span>
            </div>
            )})()}
          </div>
        )

      case 1:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SelectField
              label="目标连接"
              value={dstId}
              onChange={setDstId}
              options={dbConns.map(c => ({ value: c.id, label: c.name }))}
            />
            <SelectField
              label="目标 Schema"
              value={dstSchema}
              onChange={setDstSchema}
              options={dstSchemas.map(s => ({ value: s, label: s }))}
            />
          </div>
        )

      case 2: {
        const seg = (on: boolean) => ({
          flex: 1, textAlign: 'center' as const, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
          fontSize: 12.5, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap' as const,
          color: on ? 'var(--accent)' : 'var(--text-muted)',
          background: on ? 'var(--surface)' : 'transparent',
          boxShadow: on ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
          transition: 'color 0.12s, background 0.12s',
        })
        const track = {
          display: 'flex', gap: 4, padding: 4,
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 9,
        } as const
        const labelStyle = { fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500 } as const
        // 非表对象重建说明（混合迁移时与表选项并存）
        const nonTableNote = hasNonTable && (
          <div style={{ padding: '14px 14px', display: 'flex', gap: 10, alignItems: 'flex-start',
            background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
            <AlertCircle size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.7 }}>
              所选<strong>视图 / 函数 / 存储过程</strong>按源端 SHOW CREATE 定义创建，仅修改声明中的目标名，保留 DEFINER 等原始属性。目标对象已存在时创建失败，不会删除原对象。
              <br />注意：定义体内对源库表的引用<strong>不会改写</strong>，跨连接迁移时被引用对象需在目标已存在。
            </div>
          </div>
        )
        if (!hasTables) {
          return <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{nonTableNote}</div>
        }
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {nonTableNote}
            {/* 迁移策略：下拉框 + 选中项动态说明 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={labelStyle}>迁移策略</div>
              <SearchableSelect value={strategy} onChange={v => setStrategy(v as Strategy)} mono={false}
                items={supportedMigrationStrategies(content).map(s => ({ value: s, label: STRATEGY_LABELS[s] }))} />
              {(() => {
                // 破坏性策略（删除/清空/替换数据）用危险色提示，追加/跳过用普通信息提示
                const danger = strategy !== 'append' && strategy !== 'skip'
                return (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '9px 12px', borderRadius: 8,
                    background: danger ? 'var(--error-bg)' : 'var(--accent-bg)',
                    border: `1px solid ${danger ? 'rgba(220,38,38,0.25)' : 'var(--border-subtle)'}`,
                  }}>
                    <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: danger ? '#dc2626' : 'var(--accent)' }} />
                    <span style={{ fontSize: 12, lineHeight: 1.55, color: danger ? '#dc2626' : 'var(--text)' }}>
                      {STRATEGY_DESCS[strategy]}
                    </span>
                  </div>
                )
              })()}
            </div>

            {/* 迁移内容：仅支持后端校验过的保真模式 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 20 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={labelStyle}>迁移内容</div>
                <div style={track}>
                  {(['both', 'structure', 'data'] as ContentMode[]).map(c => (
                    <div key={c} onClick={() => { setContent(c); setStrategy('replace') }} style={seg(content === c)}>{CONTENT_LABELS[c]}</div>
                  ))}
                </div>
              </div>
            </div>

            {/* 高级选项：默认折叠 */}
            {content !== 'structure' && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <button onClick={() => setAdvOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--text-bright)' }}>
                  <ChevronDown size={14} style={{ transform: advOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--text-muted)' }} />
                  高级选项
                  {!advOpen && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>WHERE 过滤 · 批大小 · 行数限制</span>}
                </button>

                {advOpen && (
                  <>
                    {/* WHERE + 行数限制 + 批大小：一行（hover 提示由 GlobalTooltip 渲染） */}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                      <div data-tip="只迁移满足条件的行；不要写 WHERE 关键字。会经 SQL 解析白名单校验（禁子查询/危险函数），可防注入。例：status = 1 AND created_at >= '2026-01-01'"
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={labelStyle}>WHERE 过滤（可选，不含 WHERE 关键字）</label>
                        <input value={whereClause} spellCheck={false} autoComplete="off"
                          placeholder="如：status = 1 AND created_at >= '2026-01-01'"
                          onChange={e => setWhereClause(e.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
                      </div>
                      <div data-tip="最多迁移多少行（给源查询加 LIMIT）；0 = 不限制，迁移全部。常用于抽样试跑，只迁前 N 行验证流程"
                        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={labelStyle}>行数限制</label>
                        <input type="number" value={rowLimit} min={0}
                          onChange={e => setRowLimit(Math.max(0, Number(e.target.value)))} style={{ width: 100 }} />
                      </div>
                      <div data-tip="每批写入的行数（按列数自动封顶，避免超 SQL 占位符上限），不限制总量。大表用游标流式读取、内存恒定，千万行也无忧。默认 1000，追求吞吐可调 2000~5000"
                        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={labelStyle}>批大小</label>
                        <input type="number" value={batchSize} min={100} max={10000}
                          onChange={e => setBatchSize(Math.max(100, Math.min(10000, Number(e.target.value))))} style={{ width: 100 }} />
                      </div>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      为保持源表定义和数据一致，迁移固定启用事务回滚、外键检查、冲突时报错中止；不提供列映射或忽略错误。
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      }

      case 3:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center' }}>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>源</div>
                <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>{srcConn?.name}</div>
                <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--text-muted)' }}>{srcSchema}</div>
              </div>
              <ArrowRight size={16} color="var(--accent)" />
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>目标</div>
                <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>{dstConn?.name}</div>
                <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--text-muted)' }}>{dstSchema}</div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, lineHeight: 1.6 }}>
              {MIGRATION_BATCH_BOUNDARY}
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                迁移对象（{selectedObjs.length} 个{hasNonTable ? `：${selectedTableNames.length} 表 · ${selectedObjs.length - selectedTableNames.length} 视图/函数/存储过程` : ''}）
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selectedSorted.map(o => (
                  <span key={objKey(o)} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--accent-bg)', color: 'var(--accent)', borderRadius: 4 }}>
                    {o.name}{hasNonTable ? <span style={{ opacity: 0.6 }}> · {OBJ_LABELS[o.type]}</span> : ''}
                  </span>
                ))}
              </div>
            </div>

            {hasTables && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              {[
                ['策略', STRATEGY_LABELS[strategy]],
                ['内容', CONTENT_LABELS[content]],
                ...(content !== 'structure' ? [['冲突处理', '报错中止']] : []),
                ['批大小', `${batchSize.toLocaleString()} 行`],
                ...(content !== 'structure' && whereClause.trim() ? [['WHERE', whereClause.trim()]] : []),
                ...(content !== 'structure' && rowLimit > 0 ? [['行数限制', `${rowLimit.toLocaleString()} 行`]] : []),
                ...(content !== 'structure' ? [['选项', '事务回滚 · 外键检查']] : []),
              ].map(([k, v]) => (
                <div key={k} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 12px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{k}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, wordBreak: 'break-all' }}>{v}</div>
                </div>
              ))}
            </div>
            )}
          </div>
        )

      case 4:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                已处理 {tableProgress.filter(t => t.done).length} / {selectedObjs.length} 个对象
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                耗时 {(elapsed / 1000).toFixed(1)}s
              </span>
            </div>
            <ProgressBar value={tableProgress.filter(t => t.done).length} max={selectedObjs.length} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto' }}>
              {tableProgress.map((tp, i) => {
                const PIcon = tp.objType === 'function' ? Braces : tp.objType === 'procedure' ? Workflow : tp.objType === 'view' ? Eye : Table2
                return (
                <div key={`${tp.objType ?? 'table'}::${tp.table}`} style={{
                  background: 'var(--surface-2)', borderRadius: 8,
                  border: `1px solid ${tp.error ? 'rgba(220,38,38,0.3)' : tp.done ? 'rgba(22,163,74,0.2)' : i === currentTableIdx ? 'var(--accent)' : 'var(--border)'}`,
                  padding: '10px 12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: tp.error ? 4 : tp.totalRows > 0 ? 6 : 0 }}>
                    <PIcon size={12} color="var(--text-muted)" />
                    <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{tp.table}</span>
                    <span style={{
                      fontSize: 11, padding: '1px 6px', borderRadius: 4,
                      background: tp.error ? 'rgba(220,38,38,0.1)' : tp.done ? 'rgba(22,163,74,0.1)' : i === currentTableIdx ? 'var(--accent-bg)' : 'var(--surface)',
                      color: tp.error ? '#dc2626' : tp.done ? '#16a34a' : i === currentTableIdx ? 'var(--accent)' : 'var(--text-muted)',
                    }}>
                      {tp.stage}
                    </span>
                    {tp.totalRows > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {tp.migratedRows.toLocaleString()} / {tp.totalRows.toLocaleString()} 行
                      </span>
                    )}
                  </div>
                  {tp.totalRows > 0 && !tp.error && (
                    <ProgressBar value={tp.migratedRows} max={tp.totalRows} color={tp.done ? '#16a34a' : 'var(--accent)'} />
                  )}
                  {tp.error && (
                    <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>{tp.error}</div>
                  )}
                  {tp.notice && (
                    <div style={{ fontSize: 12, color: 'var(--text-bright)', marginTop: 8, border: '1px solid var(--accent)', borderRadius: 8, padding: 10, lineHeight: 1.5 }}>{tp.notice}</div>
                  )}
                </div>
                )
              })}
            </div>

            {migrating && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>迁移进行中，请勿关闭窗口…</div>
            )}
          </div>
        )

      case 5:
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '16px 0' }}>
            <div style={{
              width: 56, height: 56, borderRadius: '50%',
              background: resultOk ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {resultOk
                ? <Check size={28} color="var(--success)" strokeWidth={2.5} />
                : <AlertCircle size={28} color="var(--error)" />
              }
            </div>
            <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--text-bright)' }}>
              {resultOk ? '对象处理结束，请核查迁移结果' : '迁移已因错误停止'}
            </div>
            <div style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, lineHeight: 1.6, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
              {MIGRATION_BATCH_BOUNDARY}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, width: '100%' }}>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', textAlign: 'center', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-bright)' }}>{tableProgress.filter(t => t.done).length} / {selectedObjs.length}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>已处理 / 所选对象</div>
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', textAlign: 'center', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-bright)' }}>{totalMigrated.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>未报错对象返回的迁移行数</div>
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', textAlign: 'center', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-bright)' }}>{(elapsed / 1000).toFixed(1)}s</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>耗时</div>
              </div>
            </div>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tableProgress.map(tp => (
                <div key={`${tp.objType ?? 'table'}::${tp.table}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: tp.error ? 'var(--error)' : 'var(--text)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{tp.table}</span>
                  <span>{tp.stage}</span>
                </div>
              ))}
            </div>
            {resultErrors.length > 0 && (
              <div style={{ width: '100%', background: 'var(--error-bg)', borderRadius: 8, padding: 12, border: '1px solid rgba(220,38,38,0.2)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)', marginBottom: 6 }}>失败详情</div>
                {resultErrors.map((e, i) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--error)', marginBottom: 2 }}>{e}</div>
                ))}
              </div>
            )}
            {tableProgress.some(tp => tp.notice) && (
              <div style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', border: '1px solid var(--accent)', borderRadius: 8, padding: 12 }}>
                <div style={{ color: 'var(--text-bright)', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>旧目标备份已保留，请核查后手动清理</div>
                {tableProgress.filter(tp => tp.notice).map(tp => <div key={tp.table} style={{ color: 'var(--text)', fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all' }}>{tp.table}：{tp.notice}</div>)}
              </div>
            )}

            {/* Q6 迁移校验结果 */}
            {verifyResults && (
              <div style={{ width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <div style={{ padding: '8px 12px', background: 'var(--surface-2)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                  校验结果（MySQL 兼容库：结构及全量内容指纹；其他类型：仅行数）
                </div>
                <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  MySQL 兼容库逐表读取双方各自的只读一致性快照，比对原始表定义及所有字段的内容指纹（包含生成列和不可见列）；不共享跨库或迁移时点快照，也不代表整库同一时点。其他类型仅比行数。使用筛选、行数限制、追加或跳过策略时，校验当前整表不等同于验证本次迁移子集。
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>表</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>源行数</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>目标行数</th>
                      <th style={{ padding: '6px 10px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verifyResults.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.table}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r.srcCount.toLocaleString()}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r.dstCount.toLocaleString()}</td>
                        <td title={r.error || r.snapshotBoundary} style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, fontSize: 11, color: migrationVerificationLabel(r) === '校验失败' || !r.countMatch || r.contentMatch === false || r.structureMatch === false ? 'var(--error)' : 'var(--text-muted)' }}>
                          {migrationVerificationLabel(r)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{
          width: 720,
          height: '80vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 14,
          overflow: 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <ArrowRight size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>数据迁移向导</span>
          {step < 4 && (
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          )}
        </div>

        {/* 步骤指示器 */}
        <div style={{ padding: '16px 16px 0', flexShrink: 0 }}>
          <StepIndicator current={step} total={STEPS.length} />
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {renderStep()}
        </div>

        {/* 错误提示 */}
        {error && step < 4 && (
          <div style={{ padding: '0 24px 8px', flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6, padding: '6px 10px' }}>
              {error}
            </div>
          </div>
        )}

        {/* 底部按钮 */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            {step > 0 && step < 4 && (
              <button
                onClick={back}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '7px 16px', borderRadius: 8, fontSize: 13,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
              >
                <ArrowLeft size={13} />
                上一步
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {step < 3 && (
              <>
                <button
                  onClick={onClose}
                  style={{
                    padding: '7px 16px', borderRadius: 8, fontSize: 13,
                    background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
                  }}
                >
                  取消
                </button>
                <button
                  onClick={next}
                  disabled={loading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '7px 16px', borderRadius: 8, fontSize: 13,
                    background: 'var(--accent)', color: '#fff',
                  }}
                >
                  下一步
                  <ArrowRight size={13} />
                </button>
              </>
            )}
            {step === 3 && (
              <button
                onClick={runMigration}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '7px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: 'var(--accent)', color: '#fff',
                }}
              >
                开始迁移
              </button>
            )}
            {step === 5 && (
              <>
                {hasTables && (
                  <button
                    onClick={runVerify}
                    disabled={verifying}
                    style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }}
                  >
                    {verifying ? '核对中…' : '核对当前行数'}
                  </button>
                )}
                <button
                  onClick={onClose}
                  style={{ padding: '7px 20px', borderRadius: 8, fontSize: 13, background: 'var(--accent)', color: '#fff' }}
                >
                  关闭
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
