// MongoBrowser — MongoDB 浏览器主面板
// MO1: 库/集合树 + MO2: 文档查看/编辑/批量操作
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight, ChevronDown, RefreshCw, Loader2,
  Database, Table2, Search, Trash2, Pencil,
  AlertCircle, X, Check, Zap,
  Layers, Play, Eye, EyeOff, Download,
  List, KeyRound, Plus, Info,
  Terminal, Activity, Bookmark, Shield, FileSearch, Bell, GitMerge,
  FileBox, Radio, Copy, ShieldCheck, Scale, LifeBuoy, Sparkles,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import SearchableSelect from '../DbTools/SearchableSelect'
import EnvWatermark from '../common/EnvWatermark'
import MongoSnippetsPanel from './MongoSnippetsPanel'
import MongoUsersPanel from './MongoUsersPanel'
import MongoAuditPanel, { appendAuditEntry } from './MongoAuditPanel'
import MongoInspectPanel from './MongoInspectPanel'
import MongoSchemaPanel from './MongoSchemaPanel'
import MongoAlertPanel, { useMongoAlerts, loadAlertThresholds, MongoAlertThresholds, MongoAlertState } from './MongoAlertPanel'
import MongoTxPanel from './MongoTxPanel'
import MongoGridFsPanel from './MongoGridFsPanel'
import MongoStreamPanel from './MongoStreamPanel'
import MongoCopyPanel from './MongoCopyPanel'
import MongoBackupPanel from './MongoBackupPanel'
import MongoRiskPanel from './MongoRiskPanel'
import MongoMaskExportPanel from './MongoMaskExportPanel'
import MongoBalancerPanel from './MongoBalancerPanel'
import MongoRecoveryPanel from './MongoRecoveryPanel'
import MongoSmartShellPanel from './MongoSmartShellPanel'
import { listenMongoExportProgress, queueBackgroundExport } from '../../utils/exportTasks'

interface Props { connectionId: string }

interface MongoDbInfo { name: string; sizeOnDisk: number; empty: boolean }
interface MongoCollInfo { name: string; collType: string; estimatedCount: number; sizeBytes: number }
interface MongoDocResult {
  docs: string[]
  total: number
  hasMore: boolean
  lastId?: string
}
interface FindDocsArgs {
  filterJson?: string
  projectionJson?: string
  sortJson?: string
  limit?: number
  lastId?: string
}
interface AggStage {
  id: number
  operator: string
  json: string
  enabled: boolean
}

const STAGE_TEMPLATES: Record<string, string> = {
  '$match': '{\n  "field": "value"\n}',
  '$group': '{\n  "_id": "$field",\n  "count": {"$sum": 1}\n}',
  '$project': '{\n  "_id": 0,\n  "field": 1\n}',
  '$sort': '{\n  "field": -1\n}',
  '$limit': '100',
  '$skip': '0',
  '$lookup': '{\n  "from": "other_coll",\n  "localField": "_id",\n  "foreignField": "_id",\n  "as": "joined"\n}',
  '$unwind': '"$array_field"',
  '$addFields': '{\n  "newField": "$existingField"\n}',
  '$replaceRoot': '{\n  "newRoot": "$embedded"\n}',
  '$count': '"total"',
  '$out': '"output_collection"',
  '$merge': '{\n  "into": "output_collection",\n  "whenMatched": "replace",\n  "whenNotMatched": "insert"\n}',
}
const STAGE_OPERATORS = Object.keys(STAGE_TEMPLATES)
const WRITE_STAGES = new Set(['$out', '$merge'])

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// MO8.1/8.2 导入导出支持的格式（excel 走 SpreadsheetML，扩展名用 .xls）
const MONGO_EXPORT_FORMATS = [
  { v: 'json',  label: 'JSON',  ext: 'json' },
  { v: 'jsonl', label: 'JSONL', ext: 'jsonl' },
  { v: 'csv',   label: 'CSV',   ext: 'csv' },
  { v: 'tsv',   label: 'TSV',   ext: 'tsv' },
  { v: 'excel', label: 'Excel', ext: 'xls' },
  { v: 'text',  label: 'Text',  ext: 'txt' },
] as const
const MONGO_IMPORT_FORMATS = [
  { v: 'json',  label: 'JSON',  ext: ['json'] },
  { v: 'jsonl', label: 'JSONL', ext: ['jsonl', 'ndjson'] },
  { v: 'csv',   label: 'CSV',   ext: ['csv'] },
  { v: 'tsv',   label: 'TSV',   ext: ['tsv'] },
  { v: 'excel', label: 'Excel', ext: ['xlsx', 'xls'] },
] as const

// JSON 高亮渲染
function JsonHighlight({ json }: { json: string }) {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return <pre style={{ margin: 0, color: 'var(--text)' }}>{json}</pre> }
  const formatted = JSON.stringify(parsed, null, 2)
  // 简单 token 着色
  const html = formatted
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"(\$oid|_id|\$date|\$numberDecimal|\$binary)":/g, (_, k) => `<span style="color:var(--accent)">"${k}"</span>:`)
    .replace(/"([^"]+)":/g, (_, k) => `<span style="color:#7dd3fc">"${k}"</span>:`)
    .replace(/: "(.*?)"/g, (_, v) => `: <span style="color:#86efac">"${v}"</span>`)
    .replace(/: (-?\d+\.?\d*)/g, (_, n) => `: <span style="color:#fb923c">${n}</span>`)
    .replace(/: (true|false|null)/g, (_, b) => `: <span style="color:#c084fc">${b}</span>`)
  return (
    <pre
      style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// 确认弹窗（简化版）
function ConfirmModal({ msg, onOk, onCancel, danger = true }: {
  msg: string; onOk: () => void; onCancel: () => void; danger?: boolean
}) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '24px 28px', maxWidth: 420, width: '90%' }}>
        <p style={{ color: 'var(--text)', marginBottom: 20 }}>{msg}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>取消</button>
          <button onClick={onOk} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: danger ? '#dc2626' : 'var(--accent)', color: '#fff', cursor: 'pointer' }}>确认</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function MongoBrowser({ connectionId }: Props) {
  const [dbs, setDbs] = useState<MongoDbInfo[]>([])
  const [collsMap, setCollsMap] = useState<Record<string, MongoCollInfo[]>>({})
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [loadingDbs, setLoadingDbs] = useState(false)
  const [loadingColls, setLoadingColls] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // 当前查看的集合
  const [activeDb, setActiveDb] = useState<string | null>(null)
  const [activeColl, setActiveColl] = useState<string | null>(null)

  // 文档查询状态
  const [filterJson, setFilterJson] = useState('')
  const [sortJson, setSortJson] = useState('')
  const [docs, setDocs] = useState<string[]>([])
  const [totalDocs, setTotalDocs] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [lastId, setLastId] = useState<string | undefined>()
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [docsError, setDocsError] = useState<string | null>(null)

  // 文档编辑
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [editingDoc, setEditingDoc] = useState<string | null>(null)
  const [editJson, setEditJson] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 删除确认
  const [confirmDelete, setConfirmDelete] = useState<{ docId: string; msg: string } | null>(null)

  // 批量操作（MO2.4）
  type BatchMode = 'delete' | 'update'
  const [batchMode, setBatchMode] = useState<BatchMode | null>(null)
  const [batchFilter, setBatchFilter] = useState('')
  const [batchUpdate, setBatchUpdate] = useState('')
  const [batchCollName, setBatchCollName] = useState('') // 空 filter 时输入集合名
  const [batchPreviewCount, setBatchPreviewCount] = useState<number | null>(null)
  const [batchPreviewing, setBatchPreviewing] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchDone, setBatchDone] = useState<string | null>(null)

  // 搜索
  const [dbSearch, setDbSearch] = useState('')
  // MO0.4 拓扑探测
  const [mongoTopology, setMongoTopology] = useState<'standalone' | 'replset' | 'mongos' | null>(null)
  const [mongoVersion, setMongoVersion] = useState<string | null>(null)
  // MO0.5 只读/生产标识（从 localStorage 读连接配置）
  const [connEnvLabel, setConnEnvLabel] = useState<'prod' | 'staging' | 'test' | null>(null)
  const [connReadOnly, setConnReadOnly] = useState(false)

  // 聚合管道状态 (MO3.1-MO3.4)
  const aggIdRef = useRef(1)
  const [showAggregate, setShowAggregate] = useState(false)
  const [aggStages, setAggStages] = useState<AggStage[]>([
    { id: 0, operator: '$match', json: '{}', enabled: true }
  ])
  const [aggAllowDiskUse, setAggAllowDiskUse] = useState(false)
  const [aggLimit, setAggLimit] = useState(200)
  const [aggResult, setAggResult] = useState<{ docs: string[]; count: number } | null>(null)
  const [aggRunning, setAggRunning] = useState(false)
  const [aggError, setAggError] = useState<string | null>(null)
  const [aggExplain, setAggExplain] = useState<string | null>(null)
  const [aggExplaining, setAggExplaining] = useState(false)
  const [aggResultTab, setAggResultTab] = useState<'result' | 'explain'>('result')
  const [aggConfirmWrite, setAggConfirmWrite] = useState(false)
  const [aggWriteTarget, setAggWriteTarget] = useState('')

  // MO10.5 片段库
  const [showSnippets, setShowSnippets] = useState(false)
  // MO9.3 用户管理
  const [showUsers, setShowUsers] = useState(false)
  // MO9.4 审计日志
  const [showAudit, setShowAudit] = useState(false)
  // MO10.1 巡检报告
  const [showInspect, setShowInspect] = useState(false)
  // MO10.3 schema 分析
  const [showSchema, setShowSchema] = useState(false)
  // MO10.4 告警阈值
  const [showAlert, setShowAlert] = useState(false)
  // MO10.7 多文档事务
  const [showTx, setShowTx] = useState(false)
  // MO2 GridFS / MO11.2 变更流 / MO8.3 复制 / MO8.4 备份
  const [showGridfs, setShowGridfs] = useState(false)
  const [showStream, setShowStream] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  const [showMaskExport, setShowMaskExport] = useState(false)
  const [showBalancer, setShowBalancer] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)
  const [showSmartShell, setShowSmartShell] = useState(false)
  const [showRisk, setShowRisk] = useState(false)
  const [alertThresholds, setAlertThresholds] = useState<MongoAlertThresholds>(() => loadAlertThresholds(connectionId))
  const [alertState, setAlertState] = useState<MongoAlertState>({ hasAlert: false, lastCheck: 0, alerts: [] })
  useMongoAlerts(connectionId, alertThresholds, setAlertState)

  const isMounted = useRef(true)
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false } }, [])

  // 加载数据库列表
  const loadDbs = useCallback(async () => {
    setLoadingDbs(true)
    setError(null)
    try {
      const result = await invoke<MongoDbInfo[]>('mongo_list_databases', { id: connectionId })
      if (isMounted.current) setDbs(result)
    } catch (e) {
      if (isMounted.current) setError(String(e))
    } finally {
      if (isMounted.current) setLoadingDbs(false)
    }
  }, [connectionId])

  useEffect(() => { loadDbs() }, [loadDbs])

  // MO0.4/0.5 加载拓扑信息 + 连接配置（只在 connectionId 变化时执行一次）
  useEffect(() => {
    // 读取连接配置（localStorage）
    try {
      const raw = localStorage.getItem(`local-conn-${connectionId}`)
      if (raw) {
        const cfg = JSON.parse(raw) as Record<string, unknown>
        setConnEnvLabel((cfg.envLabel as 'prod' | 'staging' | 'test' | null) ?? null)
        setConnReadOnly((cfg.readOnly as boolean | undefined) ?? false)
      }
    } catch { /* ignore */ }
    // 获取版本 + 拓扑
    invoke<string>('mongo_build_info', { id: connectionId })
      .then(r => {
        const data = JSON.parse(r) as Record<string, unknown>
        const build = (data.buildInfo as Record<string, unknown> | null) ?? {}
        const hello = (data.hello as Record<string, unknown> | null) ?? {}
        setMongoVersion(String(build.version ?? ''))
        if (hello.msg === 'isdbgrid') setMongoTopology('mongos')
        else if (hello.hosts || hello.setName) setMongoTopology('replset')
        else setMongoTopology('standalone')
      })
      .catch(() => { /* 不影响主流程 */ })
  }, [connectionId])

  // 加载集合列表
  const loadColls = useCallback(async (dbName: string) => {
    setLoadingColls(prev => new Set(prev).add(dbName))
    try {
      const result = await invoke<MongoCollInfo[]>('mongo_list_collections', { id: connectionId, db: dbName })
      if (isMounted.current) {
        setCollsMap(prev => ({ ...prev, [dbName]: result }))
      }
    } catch (e) {
      if (isMounted.current) setError(String(e))
    } finally {
      if (isMounted.current) setLoadingColls(prev => { const s = new Set(prev); s.delete(dbName); return s })
    }
  }, [connectionId])

  function toggleDb(dbName: string) {
    setExpandedDbs(prev => {
      const next = new Set(prev)
      if (next.has(dbName)) {
        next.delete(dbName)
      } else {
        next.add(dbName)
        if (!collsMap[dbName]) loadColls(dbName)
      }
      return next
    })
  }

  // 打开集合
  async function openColl(dbName: string, collName: string) {
    setActiveDb(dbName)
    setActiveColl(collName)
    setDocs([])
    setLastId(undefined)
    setHasMore(false)
    setSelectedDoc(null)
    setEditingDoc(null)
    setFilterJson('')
    setSortJson('')
    await fetchDocs(dbName, collName, {})
  }

  // 查询文档
  async function fetchDocs(dbName: string, collName: string, args: FindDocsArgs, append = false) {
    setLoadingDocs(true)
    setDocsError(null)
    try {
      const result = await invoke<MongoDocResult>('mongo_find_docs', {
        id: connectionId, db: dbName, coll: collName,
        args: {
          filterJson: args.filterJson ?? null,
          projectionJson: null,
          sortJson: args.sortJson ?? null,
          limit: 50,
          lastId: args.lastId ?? null,
        }
      })
      if (!isMounted.current) return
      if (append) {
        setDocs(prev => [...prev, ...result.docs])
      } else {
        setDocs(result.docs)
      }
      setTotalDocs(result.total)
      setHasMore(result.hasMore)
      setLastId(result.lastId)
    } catch (e) {
      if (isMounted.current) setDocsError(String(e))
    } finally {
      if (isMounted.current) setLoadingDocs(false)
    }
  }

  function runQuery() {
    if (!activeDb || !activeColl) return
    setDocs([])
    setLastId(undefined)
    fetchDocs(activeDb, activeColl, { filterJson: filterJson || undefined, sortJson: sortJson || undefined })
  }

  function loadMore() {
    if (!activeDb || !activeColl || !hasMore || loadingDocs) return
    fetchDocs(activeDb, activeColl, {
      filterJson: filterJson || undefined,
      sortJson: sortJson || undefined,
      lastId,
    }, true)
  }

  // 获取文档的 _id 字符串
  function getDocId(docJson: string): string | null {
    try {
      const doc = JSON.parse(docJson)
      const id = doc._id
      if (!id) return null
      if (typeof id === 'string') return id
      if (id.$oid) return id.$oid
      return JSON.stringify(id)
    } catch { return null }
  }

  // 开始编辑
  function startEdit(docJson: string) {
    try {
      const parsed = JSON.parse(docJson)
      setEditJson(JSON.stringify(parsed, null, 2))
      setEditingDoc(docJson)
      setEditError(null)
    } catch { setEditError('JSON 解析失败') }
  }

  // 保存编辑
  async function saveEdit() {
    if (!activeDb || !activeColl || !editingDoc) return
    const docId = getDocId(editingDoc)
    if (!docId) { setEditError('无法获取文档 _id'); return }
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(editJson) } catch { setEditError('JSON 格式错误'); return }

    // MO2.5 类型安全：检测 _id 字段是否被意外修改成纯字符串
    const newId = parsed._id
    if (typeof newId === 'string' && /^[a-f0-9]{24}$/i.test(newId)) {
      setEditError('安全提示：_id 看起来是 ObjectId 但被写成了纯字符串，请改为 {"$oid":"..."} 格式，否则保存后将无法用 ObjectId 查找。如确认这是字符串类型，请继续。')
      // 不阻止保存，给用户提示即可
    }

    setSaving(true)
    setEditError(null)
    try {
      await invoke('mongo_replace_one', {
        id: connectionId, db: activeDb, coll: activeColl,
        docId, newDocJson: JSON.stringify(parsed),
      })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'replace', detail: `_id: ${docId}`, ok: true })
      setEditingDoc(null)
      await fetchDocs(activeDb, activeColl, { filterJson: filterJson || undefined, sortJson: sortJson || undefined })
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: 'replace', detail: `_id: ${docId}`, ok: false, error: String(e) })
      setEditError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // 删除文档
  async function deleteDoc(docId: string) {
    if (!activeDb || !activeColl) return
    try {
      await invoke('mongo_delete_one', { id: connectionId, db: activeDb, coll: activeColl, docId })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'deleteOne', detail: `_id: ${docId}`, ok: true })
      setConfirmDelete(null)
      setSelectedDoc(null)
      await fetchDocs(activeDb, activeColl, { filterJson: filterJson || undefined, sortJson: sortJson || undefined })
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: 'deleteOne', detail: `_id: ${docId}`, ok: false, error: String(e) })
      setDocsError(String(e))
    }
  }

  // 批量操作：预览命中数
  async function batchPreview() {
    if (!activeDb || !activeColl) return
    const filter = batchFilter.trim() || '{}'
    // 空 filter（全集合）需要额外确认
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(filter) } catch { setBatchError('filter JSON 格式错误'); return }
    if (Object.keys(parsed).length === 0) {
      setBatchError('空 filter 将影响全集合，请输入明确的条件。如确实要操作全集合，请在下方输入集合名确认。')
      setBatchPreviewCount(null)
      return
    }
    setBatchPreviewing(true)
    setBatchError(null)
    try {
      const count = await invoke<number>('mongo_count_preview', {
        id: connectionId, db: activeDb, coll: activeColl, filterJson: filter
      })
      setBatchPreviewCount(count)
    } catch (e) {
      setBatchError(String(e))
    } finally {
      setBatchPreviewing(false)
    }
  }

  // 批量操作：执行
  async function batchExecute() {
    if (!activeDb || !activeColl) return
    const filter = batchFilter.trim() || '{}'
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(filter) } catch { setBatchError('filter JSON 格式错误'); return }
    const isEmpty = Object.keys(parsed).length === 0
    if (isEmpty && batchCollName !== activeColl) {
      setBatchError(`请在"集合名确认"输入框中输入 "${activeColl}" 以确认操作全集合`)
      return
    }
    setBatchRunning(true)
    setBatchError(null)
    try {
      if (batchMode === 'delete') {
        const result = await invoke<{ deleted: number }>('mongo_delete_many', {
          id: connectionId, db: activeDb, coll: activeColl,
          filterJson: filter,
          confirmedCount: batchPreviewCount ?? 0,
        })
        appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'deleteMany', detail: `filter: ${filter}，删除 ${result.deleted} 条`, ok: true })
        setBatchDone(`已删除 ${result.deleted} 条文档`)
      } else {
        const updateStr = batchUpdate.trim()
        if (!updateStr) { setBatchError('请输入 update 文档（如 {"$set":{"key":"value"}}）'); setBatchRunning(false); return }
        const result = await invoke<{ modified: number; matched: number }>('mongo_update_many', {
          id: connectionId, db: activeDb, coll: activeColl,
          filterJson: filter, updateJson: updateStr,
          confirmedCount: batchPreviewCount ?? 0,
        })
        appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'updateMany', detail: `filter: ${filter}，更新 ${result.modified} 条`, ok: true })
        setBatchDone(`已更新 ${result.modified} 条（匹配 ${result.matched} 条）`)
      }
      // 刷新文档列表
      await fetchDocs(activeDb, activeColl, { filterJson: filterJson || undefined, sortJson: sortJson || undefined })
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: batchMode === 'delete' ? 'deleteMany' : 'updateMany', detail: `filter: ${batchFilter}`, ok: false, error: String(e) })
      setBatchError(String(e))
    } finally {
      setBatchRunning(false)
    }
  }

  function openBatch(mode: BatchMode) {
    setBatchMode(mode)
    setBatchFilter(filterJson) // 预填当前查询的 filter
    setBatchUpdate('')
    setBatchCollName('')
    setBatchPreviewCount(null)
    setBatchError(null)
    setBatchDone(null)
  }

  // ── 聚合管道操作 (MO3.1-MO3.4) ──────────────────────────────────────────

  function buildAggPipeline(): { pipelineJson: string | null; hasWrite: boolean; writeTarget: string } {
    const enabled = aggStages.filter(s => s.enabled)
    if (enabled.length === 0) {
      setAggError('至少需要一个启用的管道阶段')
      return { pipelineJson: null, hasWrite: false, writeTarget: '' }
    }
    let hasWrite = false, writeTarget = ''
    const stages: unknown[] = []
    for (const s of enabled) {
      let val: unknown
      try { val = JSON.parse(s.json) } catch {
        setAggError(`阶段 ${s.operator} 的 JSON 值格式有误`)
        return { pipelineJson: null, hasWrite: false, writeTarget: '' }
      }
      if (WRITE_STAGES.has(s.operator)) {
        hasWrite = true
        writeTarget = typeof val === 'string' ? val
          : (val as Record<string, unknown>)?.into as string ?? '目标集合'
      }
      stages.push({ [s.operator]: val })
    }
    return { pipelineJson: JSON.stringify(stages), hasWrite, writeTarget }
  }

  async function runAggregate(confirmedWrite = false) {
    if (!activeDb || !activeColl) return
    const { pipelineJson, hasWrite, writeTarget } = buildAggPipeline()
    if (!pipelineJson) return
    if (hasWrite && !confirmedWrite) {
      setAggWriteTarget(writeTarget)
      setAggConfirmWrite(true)
      return
    }
    setAggRunning(true); setAggError(null); setAggResult(null)
    try {
      const result = await invoke<{ docs: string[]; count: number }>('mongo_aggregate', {
        id: connectionId, db: activeDb, coll: activeColl,
        pipelineJson, allowDiskUse: aggAllowDiskUse,
        confirmedWrite, limit: aggLimit,
      })
      setAggResult(result)
      setAggResultTab('result')
      setAggConfirmWrite(false)
    } catch (e) { setAggError(String(e)) }
    finally { setAggRunning(false) }
  }

  async function runAggExplain() {
    if (!activeDb || !activeColl) return
    const { pipelineJson, hasWrite } = buildAggPipeline()
    if (!pipelineJson) return
    if (hasWrite) { setAggError('含 $out/$merge 的管道不支持 Explain'); return }
    setAggExplaining(true); setAggError(null); setAggExplain(null)
    try {
      const result = await invoke<string>('mongo_aggregate_explain', {
        id: connectionId, db: activeDb, coll: activeColl, pipelineJson
      })
      setAggExplain(result)
      setAggResultTab('explain')
    } catch (e) { setAggError(String(e)) }
    finally { setAggExplaining(false) }
  }

  function exportAggJson() {
    if (!aggResult) return
    const arr = aggResult.docs.map(d => { try { return JSON.parse(d) } catch { return d } })
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${activeColl}_aggregate.json`; a.click()
    URL.revokeObjectURL(url)
  }

  function exportAggCsv() {
    if (!aggResult) return
    const parsed = aggResult.docs.map(d => {
      try { return JSON.parse(d) as Record<string, unknown> } catch { return {} }
    })
    const keys = [...new Set(parsed.flatMap(r => Object.keys(r)))]
    const escape = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }
    const rows = [keys.join(','), ...parsed.map(r => keys.map(k => escape(r[k])).join(','))]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${activeColl}_aggregate.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  function addAggStage(operator: string) {
    const tmpl = STAGE_TEMPLATES[operator] ?? '{}'
    setAggStages(prev => [...prev, { id: aggIdRef.current++, operator, json: tmpl, enabled: true }])
  }

  function removeAggStage(id: number) {
    setAggStages(prev => prev.filter(s => s.id !== id))
  }

  function toggleAggStage(id: number) {
    setAggStages(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s))
  }

  function updateAggStage(id: number, field: 'operator' | 'json', value: string) {
    setAggStages(prev => prev.map(s => {
      if (s.id !== id) return s
      const updated = { ...s, [field]: value }
      if (field === 'operator') updated.json = STAGE_TEMPLATES[value] ?? '{}'
      return updated
    }))
  }

  function openAggregate() {
    setShowAggregate(true)
    setAggResult(null)
    setAggError(null)
    setAggExplain(null)
    setAggConfirmWrite(false)
    setAggResultTab('result')
  }

  // ── 索引管理状态 (MO4.1-MO4.4) ──────────────────────────────────────────
  interface IndexInfo {
    name: string; key: string; unique: boolean; sparse: boolean
    ttlSeconds: number | null; partialFilter: string | null
    isText: boolean; accessOps: number | null; indexType: string
  }
  interface IndexSuggestion { keyJson: string; reason: string; isCollscan: boolean }

  const [showIndexPanel, setShowIndexPanel] = useState(false)
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [indexLoading, setIndexLoading] = useState(false)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [dropConfirm, setDropConfirm] = useState<IndexInfo | null>(null)
  // 创建索引表单
  const [idxKeyJson, setIdxKeyJson] = useState('{"field": 1}')
  const [idxName, setIdxName] = useState('')
  const [idxUnique, setIdxUnique] = useState(false)
  const [idxSparse, setIdxSparse] = useState(false)
  const [idxTtl, setIdxTtl] = useState('')
  const [idxPartial, setIdxPartial] = useState('')
  const [idxCreating, setIdxCreating] = useState(false)
  const [idxCreateError, setIdxCreateError] = useState<string | null>(null)
  // 索引顾问
  const [idxAdvisorFilter, setIdxAdvisorFilter] = useState('')
  const [idxAdvisorSort, setIdxAdvisorSort] = useState('')
  const [idxAdvisorResult, setIdxAdvisorResult] = useState<IndexSuggestion[]>([])
  const [idxAdvisorLoading, setIdxAdvisorLoading] = useState(false)
  const [idxAdvisorError, setIdxAdvisorError] = useState<string | null>(null)
  const [idxPanelTab, setIdxPanelTab] = useState<'list' | 'create' | 'advisor'>('list')

  async function loadIndexes() {
    if (!activeDb || !activeColl) return
    setIndexLoading(true); setIndexError(null)
    try {
      const result = await invoke<IndexInfo[]>('mongo_list_indexes', {
        id: connectionId, db: activeDb, coll: activeColl
      })
      setIndexes(result)
    } catch (e) { setIndexError(String(e)) }
    finally { setIndexLoading(false) }
  }

  async function doDropIndex(name: string) {
    if (!activeDb || !activeColl) return
    try {
      await invoke('mongo_drop_index', { id: connectionId, db: activeDb, coll: activeColl, indexName: name })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'dropIndex', detail: `索引: ${name}`, ok: true })
      setDropConfirm(null)
      await loadIndexes()
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: 'dropIndex', detail: `索引: ${name}`, ok: false, error: String(e) })
      setIndexError(String(e))
    }
  }

  async function doCreateIndex() {
    if (!activeDb || !activeColl) return
    setIdxCreating(true); setIdxCreateError(null)
    try {
      const opts: Record<string, unknown> = {}
      if (idxName.trim()) opts.name = idxName.trim()
      if (idxUnique) opts.unique = true
      if (idxSparse) opts.sparse = true
      const ttlNum = parseInt(idxTtl)
      if (!isNaN(ttlNum) && ttlNum >= 0) opts.expireAfterSeconds = ttlNum
      if (idxPartial.trim()) {
        try { JSON.parse(idxPartial); opts.partialFilterExpression = JSON.parse(idxPartial) }
        catch { setIdxCreateError('partialFilterExpression JSON 格式错误'); setIdxCreating(false); return }
      }
      // Validate key JSON
      try { JSON.parse(idxKeyJson) } catch { setIdxCreateError('索引 key JSON 格式错误'); setIdxCreating(false); return }
      await invoke('mongo_create_index', {
        id: connectionId, db: activeDb, coll: activeColl,
        keyJson: idxKeyJson, optionsJson: JSON.stringify(opts)
      })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'createIndex', detail: `key: ${idxKeyJson}`, ok: true })
      setIdxKeyJson('{"field": 1}'); setIdxName(''); setIdxUnique(false)
      setIdxSparse(false); setIdxTtl(''); setIdxPartial('')
      setIdxPanelTab('list')
      await loadIndexes()
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: 'createIndex', detail: `key: ${idxKeyJson}`, ok: false, error: String(e) })
      setIdxCreateError(String(e))
    }
    finally { setIdxCreating(false) }
  }

  async function runIndexAdvisor() {
    if (!activeDb || !activeColl) return
    setIdxAdvisorLoading(true); setIdxAdvisorError(null); setIdxAdvisorResult([])
    try {
      const req = {
        filterJson: idxAdvisorFilter.trim() || '{}',
        sortJson: idxAdvisorSort.trim() || null
      }
      const result = await invoke<IndexSuggestion[]>('mongo_index_advisor', {
        id: connectionId, db: activeDb, coll: activeColl, req
      })
      setIdxAdvisorResult(result)
    } catch (e) { setIdxAdvisorError(String(e)) }
    finally { setIdxAdvisorLoading(false) }
  }

  function openIndexPanel() {
    setShowIndexPanel(true)
    setIdxPanelTab('list')
    setIndexError(null)
    setDropConfirm(null)
    setIdxAdvisorResult([])
    loadIndexes()
  }

  // ── Shell 面板状态 (MO5.1-MO5.2) ─────────────────────────────────────────
  interface ShellEntry { input: string; output: string; isError: boolean; ts: string }
  const DANGEROUS_CMDS = new Set(['drop', 'dropDatabase', 'shutdown', 'fsyncLock', 'compact'])

  const [showShell, setShowShell] = useState(false)
  const [shellDb, setShellDb] = useState('admin')
  const [shellInput, setShellInput] = useState('')
  const [shellHistory, setShellHistory] = useState<ShellEntry[]>([])
  const [shellRunning, setShellRunning] = useState(false)
  const [shellConfirm, setShellConfirm] = useState<{ cmd: string; warning: string } | null>(null)
  const shellHistIdx = useRef(-1)
  const shellInputHistory = useRef<string[]>([])

  async function execShellCmd(cmdJson: string) {
    setShellRunning(true)
    const ts = new Date().toLocaleTimeString()
    try {
      const result = await invoke<string>('mongo_run_command', {
        id: connectionId, dbName: shellDb, cmdJson
      })
      const parsed = JSON.parse(result)
      const formatted = JSON.stringify(parsed, null, 2)
      setShellHistory(prev => [...prev, { input: cmdJson, output: formatted, isError: false, ts }])
    } catch (e) {
      setShellHistory(prev => [...prev, { input: cmdJson, output: String(e), isError: true, ts }])
    } finally {
      setShellRunning(false)
    }
  }

  function runShellInput() {
    const cmd = shellInput.trim()
    if (!cmd) return
    shellInputHistory.current = [cmd, ...shellInputHistory.current.slice(0, 49)]
    shellHistIdx.current = -1
    setShellInput('')

    // 检测危险命令
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(cmd) } catch {
      setShellHistory(prev => [...prev, { input: cmd, output: '命令必须是有效的 JSON 文档，如 {"ping": 1}', isError: true, ts: new Date().toLocaleTimeString() }])
      return
    }
    const firstKey = Object.keys(parsed)[0] ?? ''
    if (DANGEROUS_CMDS.has(firstKey)) {
      setShellConfirm({ cmd, warning: `危险命令：${firstKey}。执行后数据可能无法恢复，确认执行？` })
      return
    }
    execShellCmd(cmd)
  }

  // ── 监控面板状态 (MO6.1-MO6.5) ──────────────────────────────────────────
  const [showMonitor, setShowMonitor] = useState(false)
  const [monitorTab, setMonitorTab] = useState<'status' | 'ops' | 'slowlog' | 'locks' | 'storage' | 'replset' | 'oplog' | 'shards' | 'shardkeys'>('status')
  const [serverStatus, setServerStatus] = useState<string | null>(null)
  const [currentOps, setCurrentOps] = useState<string | null>(null)
  const [monitorLoading, setMonitorLoading] = useState(false)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [killOpConfirm, setKillOpConfirm] = useState<number | null>(null)
  // MO6.3 慢查询 profiler
  const [profileStatus, setProfileStatus] = useState<{ was: number; slowms: number } | null>(null)
  const [slowQueries, setSlowQueries] = useState<Record<string, unknown>[] | null>(null)
  const [profileSetting, setProfileSetting] = useState(false)
  // MO6.5 存储容量
  type CollSize = { ns: string; docCount: number; avgObjSize: number; storageSize: number; indexSizes: number; totalSize: number; capped: boolean }
  const [dbStorage, setDbStorage] = useState<CollSize[] | null>(null)
  // MO7.1 副本集状态
  const [replSetStatus, setReplSetStatus] = useState<string | null>(null)
  // MO7.2 oplog 监控
  type OplogInfo = { configuredSizeMb: number; usedMb: number; usedPct: number; firstTsSec: number; lastTsSec: number; windowSeconds: number; windowHours: number; writeRateOps: number }
  const [oplogInfo, setOplogInfo] = useState<OplogInfo | null>(null)
  // MO7.3 分片状态
  type ShardInfo = { id: string; host: string; state: number }
  type ChunkDistrib = { shard: string; chunkCount: number; skewed: boolean }
  type ShardStatus = { shards: ShardInfo[]; balancerEnabled: boolean; balancerRunning: boolean; chunkDistrib: ChunkDistrib[]; jumboCount: number }
  const [shardStatus, setShardStatus] = useState<ShardStatus | null>(null)
  // MO7.4 分片键分析
  type ShardKeyInfo = { ns: string; shardKey: string; isMonotonic: boolean; chunkCount: number; sharded: boolean; unique: boolean }
  const [shardKeys, setShardKeys] = useState<ShardKeyInfo[] | null>(null)

  // MO1.2 集合统计弹窗
  const [showCollStats, setShowCollStats] = useState(false)
  const [collStatsTarget, setCollStatsTarget] = useState<{ db: string; coll: string } | null>(null)
  const [collStatsData, setCollStatsData] = useState<string | null>(null)
  // MO8.1 集合导出
  const [showExport, setShowExport] = useState(false)
  const [exportFormat, setExportFormat] = useState<'json' | 'jsonl' | 'csv' | 'tsv' | 'excel' | 'text'>('json')
  const [exportLoading, setExportLoading] = useState(false)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  // MO8.2 集合导入
  const [showImport, setShowImport] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importFormat, setImportFormat] = useState<'json' | 'jsonl' | 'csv' | 'tsv' | 'excel'>('json')
  const [importOnConflict, setImportOnConflict] = useState<'skip' | 'overwrite'>('skip')
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importConfirm, setImportConfirm] = useState(false)

  // MO1.3 创建/删除集合
  const [showCreateColl, setShowCreateColl] = useState(false)
  const [createCollDb, setCreateCollDb] = useState('')
  const [createCollName, setCreateCollName] = useState('')
  const [createCollLoading, setCreateCollLoading] = useState(false)
  const [createCollError, setCreateCollError] = useState<string | null>(null)
  const [dropCollTarget, setDropCollTarget] = useState<{ db: string; coll: string } | null>(null)
  const [dropCollInput, setDropCollInput] = useState('')
  const [dropCollLoading, setDropCollLoading] = useState(false)
  const [dropCollError, setDropCollError] = useState<string | null>(null)
  // 集合树悬停状态（用于显示 hover 按钮）
  const [hoveredCollKey, setHoveredCollKey] = useState<string | null>(null)
  const [hoveredDbKey, setHoveredDbKey] = useState<string | null>(null)

  async function loadServerStatus() {
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<string>('mongo_server_status', { id: connectionId })
      setServerStatus(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function loadCurrentOps() {
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<string>('mongo_current_op', { id: connectionId })
      setCurrentOps(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function doKillOp(opId: number) {
    try {
      await invoke('mongo_kill_op', { id: connectionId, opId })
      setKillOpConfirm(null)
      await loadCurrentOps()
    } catch (e) { setMonitorError(String(e)) }
  }

  async function loadSlowQueries() {
    if (!activeDb) return
    setMonitorLoading(true); setMonitorError(null)
    try {
      const status = await invoke<string>('mongo_get_profile_status', { id: connectionId, db: activeDb })
      const parsed = JSON.parse(status)
      setProfileStatus({ was: parsed.was ?? 0, slowms: parsed.slowms ?? 100 })
      if ((parsed.was ?? 0) > 0) {
        const qs = await invoke<string[]>('mongo_slow_queries', { id: connectionId, db: activeDb, limit: 50 })
        setSlowQueries(qs.map(s => JSON.parse(s)))
      } else { setSlowQueries([]) }
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function doSetProfileLevel(level: number) {
    if (!activeDb) return
    setProfileSetting(true)
    try {
      await invoke('mongo_set_profile_level', { id: connectionId, db: activeDb, level, slowMs: profileStatus?.slowms ?? 100 })
      await loadSlowQueries()
    } catch (e) { setMonitorError(String(e)) }
    finally { setProfileSetting(false) }
  }

  async function loadDbStorage() {
    if (!activeDb) return
    setMonitorLoading(true); setMonitorError(null)
    try {
      const list = await invoke<CollSize[]>('mongo_db_storage', { id: connectionId, db: activeDb })
      setDbStorage(list)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function loadReplSetStatus() {
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<string>('mongo_repl_set_status', { id: connectionId })
      setReplSetStatus(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function loadOplogInfo() {
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<OplogInfo>('mongo_oplog_info', { id: connectionId })
      setOplogInfo(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function loadShardStatus() {
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<ShardStatus>('mongo_shard_status', { id: connectionId })
      setShardStatus(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  async function loadShardKeys() {
    if (!activeDb) return
    setMonitorLoading(true); setMonitorError(null)
    try {
      const r = await invoke<ShardKeyInfo[]>('mongo_shard_key_info', { id: connectionId, db: activeDb })
      setShardKeys(r)
    } catch (e) { setMonitorError(String(e)) }
    finally { setMonitorLoading(false) }
  }

  // MO1.2 集合统计
  async function openCollStats(db: string, coll: string) {
    setCollStatsTarget({ db, coll })
    setCollStatsData(null)
    setShowCollStats(true)
    try {
      const r = await invoke<string>('mongo_coll_stats', { id: connectionId, db, coll })
      setCollStatsData(r)
    } catch (e) { setCollStatsData(JSON.stringify({ error: String(e) })) }
  }

  // MO8.1 导出集合
  async function doExport(outputPath: string) {
    if (!activeDb || !activeColl) return
    setExportLoading(true); setExportResult(null); setExportError(null)
    const db = activeDb
    const coll = activeColl
    queueBackgroundExport({
      connectionId,
      label: `${db}.${coll} · 集合导出`,
      filePath: outputPath,
      prepare: listenMongoExportProgress,
      run: taskId => invoke<number>('mongo_export_collection', {
        id: connectionId, db, coll,
        filterJson: filterJson ?? '', projectionJson: '', format: exportFormat,
        outputPath, taskId,
      }),
      complete: count => ({ progressRows: count, message: `导出完成 · ${count.toLocaleString()} 个文档` }),
      successMessage: count => `MongoDB 集合导出完成：${count.toLocaleString()} 个文档`,
      errorPrefix: 'MongoDB 集合导出失败',
    })
    setShowExport(false)
    setExportLoading(false)
  }

  // MO8.2 导入集合
  async function doImport() {
    if (!activeDb || !activeColl || !importPath.trim()) return
    setImportLoading(true); setImportResult(null); setImportError(null)
    try {
      const r = await invoke<{ inserted: number; skipped: number; errors: number }>('mongo_import_collection', {
        id: connectionId, db: activeDb, coll: activeColl,
        inputPath: importPath, format: importFormat,
        onConflict: importOnConflict, skipErrors: true,
      })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb!, coll: activeColl!, op: 'importCollection', detail: `插入 ${r.inserted}，跳过 ${r.skipped}，错误 ${r.errors}`, ok: true })
      setImportResult(`导入完成：插入 ${r.inserted}，跳过 ${r.skipped}，错误 ${r.errors}`)
      setImportConfirm(false)
      await fetchDocs(activeDb, activeColl, {})
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: activeDb ?? '', coll: activeColl ?? '', op: 'importCollection', detail: importPath, ok: false, error: String(e) })
      setImportError(String(e))
    }
    finally { setImportLoading(false) }
  }

  // MO1.3 创建集合
  async function doCreateCollection() {
    setCreateCollLoading(true); setCreateCollError(null)
    try {
      await invoke('mongo_create_collection', { id: connectionId, db: createCollDb, coll: createCollName.trim() })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: createCollDb, coll: createCollName.trim(), op: 'createCollection', detail: `${createCollDb}.${createCollName.trim()}`, ok: true })
      setShowCreateColl(false)
      setCreateCollName('')
      await loadColls(createCollDb)
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: createCollDb, coll: createCollName.trim(), op: 'createCollection', detail: `${createCollDb}.${createCollName.trim()}`, ok: false, error: String(e) })
      setCreateCollError(String(e))
    }
    finally { setCreateCollLoading(false) }
  }

  // MO1.3 删除集合（需用户输入名称确认）
  async function doDropCollection() {
    if (!dropCollTarget) return
    setDropCollLoading(true); setDropCollError(null)
    try {
      await invoke('mongo_drop_collection', { id: connectionId, db: dropCollTarget.db, coll: dropCollTarget.coll, confirmName: dropCollInput })
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: dropCollTarget.db, coll: dropCollTarget.coll, op: 'dropCollection', detail: `${dropCollTarget.db}.${dropCollTarget.coll}`, ok: true })
      if (activeDb === dropCollTarget.db && activeColl === dropCollTarget.coll) {
        setActiveColl(null); setDocs([]); setLastId(undefined); setHasMore(false)
      }
      setDropCollTarget(null); setDropCollInput('')
      await loadColls(dropCollTarget.db)
    } catch (e) {
      appendAuditEntry({ ts: Date.now(), connId: connectionId, db: dropCollTarget.db, coll: dropCollTarget.coll, op: 'dropCollection', detail: `${dropCollTarget.db}.${dropCollTarget.coll}`, ok: false, error: String(e) })
      setDropCollError(String(e))
    }
    finally { setDropCollLoading(false) }
  }

  function openMonitor(tab: 'status' | 'ops' | 'slowlog' | 'locks' | 'storage' | 'replset' | 'oplog' | 'shards' | 'shardkeys' = 'status') {
    setShowMonitor(true)
    setMonitorTab(tab)
    setMonitorError(null)
    if (tab === 'status') loadServerStatus()
    else if (tab === 'ops' || tab === 'locks') loadCurrentOps()
    else if (tab === 'slowlog') loadSlowQueries()
    else if (tab === 'storage') loadDbStorage()
    else if (tab === 'replset') loadReplSetStatus()
    else if (tab === 'oplog') loadOplogInfo()
    else if (tab === 'shards') loadShardStatus()
    else if (tab === 'shardkeys') loadShardKeys()
  }

  // 解析 serverStatus 为摘要指标
  function parseServerStatusSummary(raw: string | null) {
    if (!raw) return null
    try {
      const s = JSON.parse(raw)
      return {
        version: s.version ?? '?',
        uptime: s.uptimeEstimate ?? s.uptime ?? 0,
        connections: s.connections ?? {},
        opcounters: s.opcounters ?? {},
        mem: s.mem ?? {},
        wiredTiger: s.wiredTiger?.cache ?? null,
        network: s.network ?? {},
      }
    } catch { return null }
  }

  // 解析 currentOp 结果
  function parseCurrentOps(raw: string | null): Record<string, unknown>[] {
    if (!raw) return []
    try {
      const r = JSON.parse(raw)
      return (r.inprog as Record<string, unknown>[]) ?? []
    } catch { return [] }
  }

  const filteredDbs = dbs.filter(d => !dbSearch || d.name.toLowerCase().includes(dbSearch.toLowerCase()))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      <EnvWatermark envLabel={connEnvLabel} readonly={connReadOnly} />
      {/* 主布局 */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: 'var(--bg)' }}>
      {/* 左侧：库/集合树 */}
      <div style={{ width: 240, minWidth: 180, maxWidth: 320, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
        {/* 工具栏 */}
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <Search size={11} style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              value={dbSearch}
              onChange={e => setDbSearch(e.target.value)}
              placeholder="搜索数据库…"
              style={{ width: '100%', paddingLeft: 24, paddingRight: 8, paddingTop: 4, paddingBottom: 4, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
            />
          </div>
          <button
            onClick={loadDbs}
            data-tip="刷新"
            disabled={loadingDbs}
            style={{ padding: 4, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            {loadingDbs ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
          </button>
        </div>
        {/* MO0.4 拓扑标签 + 版本 */}
        {mongoTopology && (
          <div style={{ padding: '4px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)' }}>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: mongoTopology === 'replset' ? 'color-mix(in srgb, var(--accent) 13%, transparent)' : mongoTopology === 'mongos' ? '#ea580c22' : 'var(--surface-hover)', color: mongoTopology === 'replset' ? 'var(--accent)' : mongoTopology === 'mongos' ? '#ea580c' : 'var(--text-muted)', fontWeight: 600 }}>
              {mongoTopology === 'replset' ? '副本集' : mongoTopology === 'mongos' ? 'mongos' : '单机'}
            </span>
            {mongoVersion && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>v{mongoVersion}</span>}
            {connReadOnly && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#ea580c22', color: 'var(--warning)', fontWeight: 600, marginLeft: 'auto' }}>只读</span>}
          </div>
        )}

        {/* 数据库/集合列表 */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {error && (
            <div style={{ padding: '12px', color: 'var(--error)', fontSize: 12 }}>
              <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
              {error}
            </div>
          )}
          {filteredDbs.map(db => {
            const expanded = expandedDbs.has(db.name)
            const colls = collsMap[db.name] ?? []
            const isLoadingColls = loadingColls.has(db.name)
            return (
              <div key={db.name}>
                {/* 数据库节点 */}
                <div
                  onClick={() => toggleDb(db.name)}
                  onMouseEnter={() => setHoveredDbKey(db.name)}
                  onMouseLeave={() => setHoveredDbKey(null)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '5px 10px', cursor: 'pointer', userSelect: 'none',
                    background: activeDb === db.name && !activeColl ? 'var(--surface-hover)' : 'transparent',
                  }}
                >
                  {expanded ? <ChevronDown size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                  <Database size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{db.name}</span>
                  {hoveredDbKey === db.name
                    ? <button
                        onClick={e => { e.stopPropagation(); setCreateCollDb(db.name); setCreateCollName(''); setCreateCollError(null); setShowCreateColl(true) }}
                        title="新建集合"
                        style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display: 'flex', padding: '1px 2px', flexShrink: 0 }}
                      ><Plus size={12} /></button>
                    : <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtSize(db.sizeOnDisk)}</span>
                  }
                </div>

                {/* 集合列表 */}
                {expanded && (
                  <div style={{ paddingLeft: 16 }}>
                    {isLoadingColls
                      ? <div style={{ padding: '4px 10px', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> 加载中…
                        </div>
                      : colls.length === 0
                      ? <div style={{ padding: '4px 10px', color: 'var(--text-muted)', fontSize: 12 }}>（空）</div>
                      : colls.map(coll => {
                          const collKey = `${db.name}::${coll.name}`
                          const isActive = activeDb === db.name && activeColl === coll.name
                          const isHovered = hoveredCollKey === collKey
                          return (
                            <div
                              key={coll.name}
                              onClick={() => openColl(db.name, coll.name)}
                              onMouseEnter={() => setHoveredCollKey(collKey)}
                              onMouseLeave={() => setHoveredCollKey(null)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                padding: '4px 6px', cursor: 'pointer',
                                borderRadius: 5, margin: '1px 4px',
                                background: isActive ? 'var(--accent)' : isHovered ? 'var(--surface-hover)' : 'transparent',
                              }}
                            >
                              <Table2 size={11} style={{ color: isActive ? '#fff' : 'var(--text-muted)', flexShrink: 0 }} />
                              <span style={{ fontSize: 12, color: isActive ? '#fff' : 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{coll.name}</span>
                              {isHovered && !isActive
                                ? <>
                                    <button onClick={e => { e.stopPropagation(); openCollStats(db.name, coll.name) }} title="集合统计"
                                      style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display: 'flex', padding: '1px 2px', flexShrink: 0 }}>
                                      <Info size={11} />
                                    </button>
                                    <button onClick={e => { e.stopPropagation(); if (!connReadOnly) { setDropCollTarget({ db: db.name, coll: coll.name }); setDropCollInput(''); setDropCollError(null) } }} title={connReadOnly ? '只读模式' : '删除集合'}
                                      disabled={connReadOnly}
                                      style={{ border: 'none', background: 'transparent', color: connReadOnly ? 'var(--text-muted)' : '#dc2626', cursor: connReadOnly ? 'not-allowed' : 'pointer', display: 'flex', padding: '1px 2px', flexShrink: 0, opacity: connReadOnly ? 0.4 : 1 }}>
                                      <Trash2 size={11} />
                                    </button>
                                  </>
                                : <span style={{ fontSize: 10, color: isActive ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)', flexShrink: 0 }}>
                                    {coll.collType !== 'collection' ? `[${coll.collType}]` : fmtCount(coll.estimatedCount)}
                                  </span>
                              }
                            </div>
                          )
                        })
                    }
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 右侧：文档面板 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeColl
          ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              从左侧选择一个集合开始浏览
            </div>
          )
          : (
            <>
              {/* 查询栏 */}
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 600, flexShrink: 0 }}>
                  {activeDb} / <span style={{ color: 'var(--accent)' }}>{activeColl}</span>
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                  ≈ {fmtCount(totalDocs)} 文档
                </span>
                <input
                  value={filterJson}
                  onChange={e => setFilterJson(e.target.value)}
                  placeholder='Filter {"key":"value"}'
                  onKeyDown={e => e.key === 'Enter' && runQuery()}
                  style={{ flex: 2, minWidth: 140, padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                />
                <input
                  value={sortJson}
                  onChange={e => setSortJson(e.target.value)}
                  placeholder='Sort {"_id":-1}'
                  onKeyDown={e => e.key === 'Enter' && runQuery()}
                  style={{ flex: 1, minWidth: 100, padding: '4px 8px', border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                />
                <button
                  onClick={runQuery}
                  disabled={loadingDocs}
                  style={{ padding: '4px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}
                >
                  {loadingDocs ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={12} />}
                  查询
                </button>
                <button
                  onClick={() => { setFilterJson(''); setSortJson(''); fetchDocs(activeDb!, activeColl!, {}) }}
                  title="清除 filter"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
                >
                  <X size={12} />
                </button>
                <button
                  onClick={() => openBatch('update')}
                  title={connReadOnly ? '只读模式' : '批量更新（updateMany）'}
                  disabled={connReadOnly}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: connReadOnly ? 'var(--text-muted)' : 'var(--text-muted)', cursor: connReadOnly ? 'not-allowed' : 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, opacity: connReadOnly ? 0.4 : 1 }}
                >
                  <Zap size={12} /> 批量更新
                </button>
                <button
                  onClick={() => openBatch('delete')}
                  title={connReadOnly ? '只读模式' : '批量删除（deleteMany）'}
                  disabled={connReadOnly}
                  style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${connReadOnly ? 'var(--border-subtle)' : '#dc2626'}`, background: 'transparent', color: connReadOnly ? 'var(--text-muted)' : '#dc2626', cursor: connReadOnly ? 'not-allowed' : 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, opacity: connReadOnly ? 0.4 : 1 }}
                >
                  <Trash2 size={12} /> 批量删除
                </button>
                <button
                  onClick={openAggregate}
                  data-tip="聚合管道（Aggregate）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Layers size={12} /> 聚合
                </button>
                <button
                  onClick={openIndexPanel}
                  data-tip="索引管理"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <List size={12} /> 索引
                </button>
                <button
                  onClick={() => { setShowExport(true); setExportResult(null); setExportError(null) }}
                  title="导出集合（JSON/CSV）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Download size={12} /> 导出
                </button>
                <button
                  onClick={() => { setShowImport(true); setImportResult(null); setImportError(null) }}
                  title={connReadOnly ? '只读模式' : '导入 JSON/CSV 到集合'}
                  disabled={connReadOnly}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: connReadOnly ? 'not-allowed' : 'pointer', fontSize: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, opacity: connReadOnly ? 0.4 : 1 }}
                >
                  <Plus size={12} /> 导入
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  onClick={() => setShowSnippets(true)}
                  title="片段库（MO10.5）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Bookmark size={12} /> 片段库
                </button>
                <button
                  onClick={() => setShowUsers(true)}
                  title="用户与角色管理（MO9.3）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <KeyRound size={12} /> 用户
                </button>
                <button
                  onClick={() => setShowAudit(true)}
                  title="操作审计日志（MO9.4）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Shield size={12} /> 审计
                </button>
                <button
                  onClick={() => setShowInspect(true)}
                  title="一键巡检（MO10.1）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Activity size={12} /> 巡检
                </button>
                <button
                  onClick={() => setShowSchema(true)}
                  disabled={!activeColl}
                  title="Schema 分析（MO10.3）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: activeColl ? 'var(--text-muted)' : 'var(--text-muted)', cursor: activeColl ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeColl ? 1 : 0.4 }}
                >
                  <FileSearch size={12} /> Schema
                </button>
                <button
                  onClick={() => setShowTx(true)}
                  title="多文档事务（MO10.7，副本集专属）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <GitMerge size={12} /> 事务
                </button>
                <button
                  onClick={() => setShowAlert(true)}
                  title="告警阈值配置（MO10.4）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${alertState.hasAlert ? '#ea580c' : 'var(--border-subtle)'}`, background: alertState.hasAlert ? '#ea580c18' : 'var(--surface-2)', color: alertState.hasAlert ? '#ea580c' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}
                >
                  <Bell size={12} />
                  告警
                  {alertState.hasAlert && (
                    <span style={{
                      position: 'absolute', top: -3, right: -3,
                      width: 8, height: 8, background: 'var(--warning)',
                      borderRadius: '50%', border: '1px solid var(--surface)',
                    }} />
                  )}
                </button>
                <button
                  onClick={() => setShowShell(true)}
                  title="Shell（runCommand）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Terminal size={12} /> Shell
                </button>
                <button
                  onClick={() => setShowSmartShell(true)}
                  title="智能 Shell：命令/操作符/集合/字段自动补全（MO5.3）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Sparkles size={12} /> 智能Shell
                </button>
                <button
                  onClick={() => openMonitor('status')}
                  title="实例监控"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Activity size={12} /> 监控
                </button>
                <button
                  onClick={() => setShowGridfs(true)} disabled={!activeDb}
                  title="GridFS 文件管理（MO2）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: activeDb ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeDb ? 1 : 0.4 }}
                >
                  <FileBox size={12} /> GridFS
                </button>
                <button
                  onClick={() => setShowStream(true)} disabled={!activeColl}
                  title="变更流调试器（MO11.2，需副本集）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: activeColl ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeColl ? 1 : 0.4 }}
                >
                  <Radio size={12} /> 变更流
                </button>
                <button
                  onClick={() => setShowCopy(true)} disabled={!activeColl}
                  title="跨实例集合复制（MO8.3）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: activeColl ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeColl ? 1 : 0.4 }}
                >
                  <Copy size={12} /> 复制
                </button>
                <button
                  onClick={() => setShowBackup(true)} disabled={!activeDb}
                  title="逻辑备份 BSON（MO8.4）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: activeDb ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeDb ? 1 : 0.4 }}
                >
                  <Download size={12} /> 备份
                </button>
                <button
                  onClick={() => setShowMaskExport(true)} disabled={!activeColl}
                  title="字段脱敏导出（MO9.5）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: activeColl ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, opacity: activeColl ? 1 : 0.4 }}
                >
                  <ShieldCheck size={12} /> 脱敏导出
                </button>
                <button
                  onClick={() => setShowBalancer(true)}
                  title="分片 Balancer 活动窗口（MO11.1，需分片集群）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Scale size={12} /> Balancer
                </button>
                <button
                  onClick={() => setShowRecovery(true)}
                  title="误删恢复引导（MO11.3，只读诊断）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <LifeBuoy size={12} /> 恢复引导
                </button>
                <button
                  onClick={() => setShowRisk(true)}
                  title="配置风险扫描（MO10.2）"
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Shield size={12} /> 风险
                </button>
              </div>

              {docsError && (
                <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 16%, var(--surface))', color: 'var(--error)', fontSize: 12, borderBottom: '1px solid color-mix(in srgb, var(--error) 40%, transparent)' }}>
                  <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />{docsError}
                </div>
              )}

              {/* 文档列表 */}
              <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
                {docs.map((docJson, idx) => {
                  const docId = getDocId(docJson)
                  const isSelected = selectedDoc === docJson
                  return (
                    <div
                      key={idx}
                      onClick={() => setSelectedDoc(isSelected ? null : docJson)}
                      style={{
                        marginBottom: 4, borderRadius: 8, border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                        background: isSelected ? 'rgba(var(--accent-rgb, 99,102,241), 0.08)' : 'var(--surface)',
                        cursor: 'pointer', overflow: 'hidden',
                      }}
                    >
                      {/* 行头 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: isSelected ? '1px solid var(--border-subtle)' : 'none' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {docId ? `_id: ${docId}` : `[${idx + 1}]`}
                        </span>
                        {isSelected && docId && (
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <button
                              onClick={e => { e.stopPropagation(); if (!connReadOnly) startEdit(docJson) }}
                              title={connReadOnly ? '只读模式' : '编辑'}
                              disabled={connReadOnly}
                              style={{ padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: connReadOnly ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, opacity: connReadOnly ? 0.4 : 1 }}
                            >
                              <Pencil size={10} /> 编辑
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); if (!connReadOnly) setConfirmDelete({ docId, msg: `确定删除文档 _id: ${docId}？此操作不可撤销。` }) }}
                              title={connReadOnly ? '只读模式' : '删除'}
                              disabled={connReadOnly}
                              style={{ padding: '2px 6px', borderRadius: 5, border: `1px solid ${connReadOnly ? 'var(--border-subtle)' : '#dc2626'}`, background: 'transparent', color: connReadOnly ? 'var(--text-muted)' : '#dc2626', cursor: connReadOnly ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, opacity: connReadOnly ? 0.4 : 1 }}
                            >
                              <Trash2 size={10} /> 删除
                            </button>
                          </div>
                        )}
                      </div>
                      {/* JSON 内容（展开时显示） */}
                      {isSelected && (
                        <div style={{ padding: '8px 12px', maxHeight: 400, overflowY: 'auto' }}>
                          <JsonHighlight json={docJson} />
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* 加载更多 */}
                {hasMore && (
                  <div style={{ textAlign: 'center', padding: '8px 0' }}>
                    <button
                      onClick={loadMore}
                      disabled={loadingDocs}
                      style={{ padding: '5px 18px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}
                    >
                      {loadingDocs ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', display: 'inline' }} /> : '加载更多'}
                    </button>
                  </div>
                )}

                {!loadingDocs && docs.length === 0 && !docsError && (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                    集合为空或 filter 无匹配文档
                  </div>
                )}
              </div>
            </>
          )
        }
      </div>

      {/* 文档编辑弹窗 */}
      {editingDoc && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '90%', maxWidth: 700, display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pencil size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1 }}>编辑文档</span>
              <button onClick={() => setEditingDoc(null)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.5 }}>
                支持 Extended JSON 格式：ObjectId 写 <code style={{ fontSize: 10 }}>{"{"}"$oid":"..."{"}"}</code>，
                日期写 <code style={{ fontSize: 10 }}>{"{"}"$date":"2024-01-01T00:00:00Z"{"}"}</code>，
                数字写 <code style={{ fontSize: 10 }}>{"{"}"$numberDecimal":"1.5"{"}"}</code>。
                避免将 ObjectId 直接写为纯字符串（会导致查不到原文档）。
              </div>
              <textarea
                value={editJson}
                onChange={e => setEditJson(e.target.value)}
                style={{
                  width: '100%', height: 360, boxSizing: 'border-box',
                  padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 8,
                  background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12,
                  fontFamily: 'var(--font-mono)', lineHeight: 1.5, resize: 'vertical',
                }}
              />
              {editError && <div style={{ color: 'var(--error)', fontSize: 12, marginTop: 6 }}>{editError}</div>}
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setEditingDoc(null)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>取消</button>
              <button onClick={saveEdit} disabled={saving} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                保存
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <ConfirmModal
          msg={confirmDelete.msg}
          onOk={() => deleteDoc(confirmDelete.docId)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* 聚合管道弹窗（MO3.1-MO3.4）*/}
      {showAggregate && activeDb && activeColl && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 1040, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            {/* 头部 */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Layers size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>
                聚合管道 — {activeDb} / <span style={{ color: 'var(--accent)' }}>{activeColl}</span>
              </span>
              <button onClick={() => setShowAggregate(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>

            {/* 主体：左=阶段列表 右=结果 */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* 左：管道阶段列表 */}
              <div style={{ width: 360, minWidth: 240, borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, flex: 1 }}>
                    阶段 ({aggStages.filter(s => s.enabled).length}/{aggStages.length} 启用)
                  </span>
                  <SearchableSelect
                    value=""
                    onChange={v => { if (v) addAggStage(v) }}
                    placeholder="＋ 添加阶段"
                    width={150}
                    items={STAGE_OPERATORS.map(op => ({ value: op, label: `${WRITE_STAGES.has(op) ? '⚠ ' : ''}${op}` }))}
                  />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {aggStages.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 24 }}>
                      从上方下拉菜单添加阶段
                    </div>
                  )}
                  {aggStages.map((s, idx) => (
                    <div key={s.id} style={{ border: `1px solid ${WRITE_STAGES.has(s.operator) ? '#ea580c55' : 'var(--border-subtle)'}`, borderRadius: 8, background: s.enabled ? 'var(--surface-2)' : 'transparent', opacity: s.enabled ? 1 : 0.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px', borderBottom: '1px solid var(--border-subtle)' }}>
                        <button
                          onClick={() => toggleAggStage(s.id)}
                          title={s.enabled ? '点击禁用' : '点击启用'}
                          style={{ border: 'none', background: 'transparent', color: s.enabled ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}
                        >
                          {s.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, width: 14, textAlign: 'right' }}>{idx + 1}</span>
                        <SearchableSelect
                          value={s.operator}
                          onChange={v => updateAggStage(s.id, 'operator', v)}
                          options={STAGE_OPERATORS}
                        />
                        {WRITE_STAGES.has(s.operator) && (
                          <span style={{ fontSize: 10, color: 'var(--warning)', flexShrink: 0 }}>写回</span>
                        )}
                        <button
                          onClick={() => removeAggStage(s.id)}
                          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 }}
                        ><X size={11} /></button>
                      </div>
                      <textarea
                        value={s.json}
                        onChange={e => updateAggStage(s.id, 'json', e.target.value)}
                        rows={3}
                        spellCheck={false}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)', resize: 'vertical', outline: 'none', lineHeight: 1.45 }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* 右：选项 + 结果 */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                {/* 选项栏 */}
                <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={aggAllowDiskUse} onChange={e => setAggAllowDiskUse(e.target.checked)} />
                    allowDiskUse
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>
                    返回上限
                    <input
                      type="number" value={aggLimit} min={1} max={10000}
                      onChange={e => setAggLimit(Math.max(1, Number(e.target.value) || 200))}
                      style={{ width: 68, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, textAlign: 'right' }}
                    />
                  </label>
                  <div style={{ flex: 1 }} />
                  {aggResult && !aggRunning && (
                    <>
                      <button
                        onClick={exportAggJson}
                        data-tip="导出 JSON"
                        style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                      ><Download size={11} /> JSON</button>
                      <button
                        onClick={exportAggCsv}
                        data-tip="导出 CSV"
                        style={{ padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                      ><Download size={11} /> CSV</button>
                    </>
                  )}
                </div>

                {/* 结果/Explain 标签页 */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 12px', background: 'var(--surface)' }}>
                  {(['result', 'explain'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setAggResultTab(tab)}
                      style={{ padding: '6px 14px', border: 'none', borderBottom: aggResultTab === tab ? '2px solid var(--accent)' : '2px solid transparent', background: 'transparent', color: aggResultTab === tab ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12, marginBottom: -1 }}
                    >
                      {tab === 'result'
                        ? `结果${aggResult ? ` (${aggResult.count})` : ''}`
                        : 'Explain'}
                    </button>
                  ))}
                </div>

                {/* 内容区 */}
                <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
                  {aggError && (
                    <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--error)', marginBottom: 8 }}>
                      <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />{aggError}
                    </div>
                  )}
                  {(aggRunning || aggExplaining) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      {aggRunning ? '执行聚合中…' : '获取 Explain 中…'}
                    </div>
                  )}
                  {aggResultTab === 'result' && aggResult && !aggRunning && (
                    aggResult.docs.length === 0
                      ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>无结果</div>
                      : aggResult.docs.map((doc, i) => (
                        <div key={i} style={{ marginBottom: 4, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface)', padding: '6px 10px' }}>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, fontFamily: 'var(--font-mono)' }}>#{i + 1}</div>
                          <JsonHighlight json={doc} />
                        </div>
                      ))
                  )}
                  {aggResultTab === 'explain' && aggExplain && !aggExplaining && (
                    <pre style={{ margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}>
                      {aggExplain}
                    </pre>
                  )}
                  {!aggRunning && !aggExplaining && !aggResult && !aggExplain && !aggError && (
                    <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
                      配置阶段后点击「执行」
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 底部操作栏 */}
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={runAggExplain}
                disabled={aggExplaining || aggRunning}
                data-tip="Explain 分析索引命中"
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
              >
                {aggExplaining ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Eye size={12} />}
                Explain
              </button>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setShowAggregate(false)}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}
              >关闭</button>
              <button
                onClick={() => runAggregate(false)}
                disabled={aggRunning}
                style={{ padding: '6px 20px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {aggRunning ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                执行
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* $out/$merge 写回确认弹窗 */}
      {aggConfirmWrite && (
        <ConfirmModal
          msg={`管道包含 $out/$merge，将向集合「${aggWriteTarget}」写入/覆盖数据，此操作不可逆。确认执行？`}
          onOk={() => runAggregate(true)}
          onCancel={() => setAggConfirmWrite(false)}
          danger
        />
      )}

      {/* 索引管理弹窗（MO4.1-MO4.4）*/}
      {showIndexPanel && activeDb && activeColl && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 820, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            {/* 头部 */}
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <List size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>
                索引管理 — {activeDb} / <span style={{ color: 'var(--accent)' }}>{activeColl}</span>
              </span>
              <button onClick={() => setShowIndexPanel(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>

            {/* 标签页 */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 16px', background: 'var(--surface)' }}>
              {(['list', 'create', 'advisor'] as const).map(tab => (
                <button key={tab} onClick={() => setIdxPanelTab(tab)} style={{
                  padding: '7px 16px', border: 'none',
                  borderBottom: idxPanelTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent', color: idxPanelTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer', fontSize: 12, marginBottom: -1
                }}>
                  {tab === 'list' ? `索引列表 (${indexes.length})` : tab === 'create' ? '建索引' : '索引顾问'}
                </button>
              ))}
              {idxPanelTab === 'list' && (
                <button onClick={loadIndexes} data-tip="刷新" disabled={indexLoading} style={{ marginLeft: 'auto', padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                  {indexLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
                </button>
              )}
            </div>

            {/* 主体 */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {indexError && (
                <div style={{ padding: '8px 16px', color: 'var(--error)', fontSize: 12, background: 'color-mix(in srgb, var(--error) 12%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--error) 35%, transparent)' }}>
                  <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />{indexError}
                </div>
              )}

              {/* 索引列表 Tab */}
              {idxPanelTab === 'list' && (
                <div>
                  {indexLoading && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite', display: 'inline' }} /> 加载中…</div>}
                  {!indexLoading && indexes.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>无索引</div>}
                  {indexes.map(idx => (
                    <div key={idx.name} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <KeyRound size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{idx.name}</span>
                          {idx.unique && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent)', color: '#fff' }}>唯一</span>}
                          {idx.sparse && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>稀疏</span>}
                          {idx.ttlSeconds != null && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#ea580c22', border: '1px solid #ea580c40', color: 'var(--warning)' }}>TTL {idx.ttlSeconds}s</span>}
                          {idx.indexType !== 'regular' && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>{idx.indexType}</span>}
                          {idx.accessOps !== null && idx.accessOps === 0 && (
                            <span data-tip="该索引从未被查询命中，考虑删除" style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#ea580c22', border: '1px solid #ea580c40', color: 'var(--warning)' }}>⚠ 未使用</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {idx.key}
                          {idx.accessOps !== null && <span style={{ marginLeft: 12, color: idx.accessOps === 0 ? '#ea580c' : '#16a34a' }}>命中 {idx.accessOps} 次</span>}
                        </div>
                        {idx.partialFilter && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>partial: {idx.partialFilter}</div>}
                      </div>
                      {idx.name !== '_id_' && (
                        <button
                          onClick={() => { if (!connReadOnly) setDropConfirm(idx) }}
                          title={connReadOnly ? '只读模式' : '删除索引'}
                          disabled={connReadOnly}
                          style={{ padding: '3px 8px', borderRadius: 6, border: `1px solid ${connReadOnly ? 'var(--border-subtle)' : '#dc2626'}`, background: 'transparent', color: connReadOnly ? 'var(--text-muted)' : '#dc2626', cursor: connReadOnly ? 'not-allowed' : 'pointer', fontSize: 11, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, opacity: connReadOnly ? 0.4 : 1 }}
                        ><Trash2 size={11} /> 删除</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 建索引 Tab */}
              {idxPanelTab === 'create' && (
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ padding: '8px 12px', background: '#16a34a15', border: '1px solid #16a34a30', borderRadius: 8, fontSize: 12, color: 'var(--success)' }}>
                    提示：MongoDB 4.2+ 在线建索引（默认），大集合可能耗时较长，不会锁集合。
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>索引 Key（必填）</label>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
                      {[['{"field": 1}', '单升序'], ['{"field": -1}', '单降序'], ['{"f1": 1, "f2": 1}', '复合'], ['{"field": "text"}', '文本']].map(([v, l]) => (
                        <button key={l} onClick={() => setIdxKeyJson(v)} style={{ padding: '2px 7px', borderRadius: 5, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>{l}</button>
                      ))}
                    </div>
                    <textarea
                      value={idxKeyJson}
                      onChange={e => setIdxKeyJson(e.target.value)}
                      rows={2}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>索引名称（可选，留空自动生成）</label>
                      <input value={idxName} onChange={e => setIdxName(e.target.value)} placeholder="my_custom_index" style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>TTL 过期秒数（留空 = 非 TTL）</label>
                      <input value={idxTtl} onChange={e => setIdxTtl(e.target.value)} placeholder="3600" type="number" min={0} style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={idxUnique} onChange={e => setIdxUnique(e.target.checked)} /> 唯一索引
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={idxSparse} onChange={e => setIdxSparse(e.target.checked)} /> 稀疏索引
                    </label>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>partialFilterExpression（可选，JSON）</label>
                    <textarea value={idxPartial} onChange={e => setIdxPartial(e.target.value)} rows={2} placeholder='{"status": "active"}' style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
                  </div>
                  {idxCreateError && <div style={{ color: 'var(--error)', fontSize: 12 }}><AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />{idxCreateError}</div>}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button onClick={() => setIdxPanelTab('list')} style={{ padding: '7px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>取消</button>
                    <button onClick={doCreateIndex} disabled={idxCreating || connReadOnly} style={{ padding: '7px 22px', borderRadius: 8, border: 'none', background: idxCreating || connReadOnly ? 'var(--surface-2)' : 'var(--accent)', color: idxCreating || connReadOnly ? 'var(--text-muted)' : '#fff', cursor: idxCreating || connReadOnly ? 'not-allowed' : 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {idxCreating ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={13} />}
                      创建索引
                    </button>
                  </div>
                </div>
              )}

              {/* 索引顾问 Tab */}
              {idxPanelTab === 'advisor' && (
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    输入当前查询的 filter 与 sort，顾问将 explain 并分析是否 COLLSCAN，给出建索引建议。
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Filter JSON</label>
                    <textarea value={idxAdvisorFilter} onChange={e => setIdxAdvisorFilter(e.target.value)} rows={2} placeholder='{"status": "active", "userId": "xxx"}' style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Sort JSON（可选）</label>
                    <input value={idxAdvisorSort} onChange={e => setIdxAdvisorSort(e.target.value)} placeholder='{"createdAt": -1}' style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
                  </div>
                  <div>
                    <button onClick={runIndexAdvisor} disabled={idxAdvisorLoading} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {idxAdvisorLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Eye size={13} />}
                      分析查询
                    </button>
                  </div>
                  {idxAdvisorError && <div style={{ color: 'var(--error)', fontSize: 12 }}>{idxAdvisorError}</div>}
                  {idxAdvisorResult.length === 0 && !idxAdvisorLoading && !idxAdvisorError && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 16 }}>
                      点击「分析查询」获取建议
                    </div>
                  )}
                  {idxAdvisorResult.map((s, i) => (
                    <div key={i} style={{ padding: '12px 14px', borderRadius: 10, border: s.isCollscan ? '1px solid #ea580c40' : '1px solid #16a34a40', background: s.isCollscan ? '#ea580c10' : '#16a34a10' }}>
                      <div style={{ fontSize: 13, color: s.isCollscan ? '#ea580c' : '#16a34a', marginBottom: 8 }}>{s.reason}</div>
                      {s.keyJson !== '{}' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <code style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text)', background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 5, flex: 1 }}>{s.keyJson}</code>
                          <button
                            onClick={() => { setIdxKeyJson(s.keyJson); setIdxPanelTab('create') }}
                            style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}
                          >用此建索引</button>
                        </div>
                      )}
                    </div>
                  ))}
                  {idxAdvisorResult.length > 0 && !idxAdvisorResult.some(s => s.isCollscan) && (
                    <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #16a34a40', background: '#16a34a10', fontSize: 13, color: 'var(--success)' }}>
                      ✓ 查询已命中索引，无需额外建索引。
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 底部 */}
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              {idxPanelTab === 'list' && (
                <button onClick={() => setIdxPanelTab('create')} style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, marginRight: 'auto' }}>
                  <Plus size={13} /> 建索引
                </button>
              )}
              <button onClick={() => setShowIndexPanel(false)} style={{ padding: '6px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除索引确认 */}
      {dropConfirm && (
        <ConfirmModal
          msg={`确定删除索引「${dropConfirm.name}」？${dropConfirm.accessOps === 0 ? '（该索引未被查询命中，删除安全）' : '删除后查询可能走全集合扫描（COLLSCAN），请确认影响。'}`}
          onOk={() => doDropIndex(dropConfirm.name)}
          onCancel={() => setDropConfirm(null)}
          danger
        />
      )}

      {/* Shell 面板（MO5.1-MO5.2）*/}
      {showShell && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 780, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Terminal size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>MongoDB Shell（runCommand）</span>
              <button onClick={() => setShowShell(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>目标数据库：</label>
              <input value={shellDb} onChange={e => setShellDb(e.target.value)} style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, width: 160 }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>输入 JSON 命令如 {'{"ping": 1}'} 或 {'{"serverStatus": 1}'}</span>
            </div>
            {/* 输出历史 */}
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shellHistory.length === 0 && (
                <div style={{ color: '#6b7280', padding: 16, textAlign: 'center' }}>输入 JSON 命令后按 Enter 执行</div>
              )}
              {shellHistory.map((entry, i) => (
                <div key={i}>
                  <div style={{ color: '#7dd3fc', marginBottom: 2 }}>
                    <span style={{ color: '#6b7280', marginRight: 8 }}>{entry.ts}</span>
                    <span style={{ color: '#94a3b8' }}>{'> '}</span>
                    {entry.input}
                  </div>
                  <pre style={{ margin: 0, color: entry.isError ? '#f87171' : '#86efac', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}>
                    {entry.output}
                  </pre>
                </div>
              ))}
              {shellRunning && <div style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> 执行中…</div>}
            </div>
            {/* 输入栏 */}
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: 8, background: 'var(--surface)' }}>
              <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: '30px', flexShrink: 0 }}>{'>'}</span>
              <input
                value={shellInput}
                onChange={e => setShellInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { runShellInput() }
                  else if (e.key === 'ArrowUp') {
                    const idx = Math.min(shellHistIdx.current + 1, shellInputHistory.current.length - 1)
                    shellHistIdx.current = idx
                    if (idx >= 0) setShellInput(shellInputHistory.current[idx] ?? '')
                  } else if (e.key === 'ArrowDown') {
                    const idx = Math.max(shellHistIdx.current - 1, -1)
                    shellHistIdx.current = idx
                    setShellInput(idx >= 0 ? (shellInputHistory.current[idx] ?? '') : '')
                  }
                }}
                placeholder='{"ping": 1}'
                autoFocus
                style={{ flex: 1, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-mono)' }}
              />
              <button onClick={runShellInput} disabled={shellRunning} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                {shellRunning ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
                执行
              </button>
              <button onClick={() => setShellHistory([])} title="清除历史" style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
                <X size={12} />
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Shell 危险命令确认 */}
      {shellConfirm && (
        <ConfirmModal
          msg={shellConfirm.warning}
          onOk={() => { const cmd = shellConfirm.cmd; setShellConfirm(null); execShellCmd(cmd) }}
          onCancel={() => setShellConfirm(null)}
          danger
        />
      )}

      {/* 监控面板（MO6.1-MO6.2）*/}
      {showMonitor && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Activity size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>MongoDB 监控</span>
              <button onClick={() => setShowMonitor(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            {/* 标签页 */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 16px', background: 'var(--surface)', flexWrap: 'wrap' }}>
              {([
                ['status', '实例状态'], ['ops', '当前操作'], ['locks', '锁等待'],
                ['slowlog', '慢查询'], ['storage', '存储容量'], ['replset', '副本集'], ['oplog', 'oplog'],
                ['shards', '分片状态'], ['shardkeys', '分片键'],
              ] as const).map(([tab, label]) => (
                <button key={tab} onClick={() => openMonitor(tab)} style={{
                  padding: '7px 14px', border: 'none',
                  borderBottom: monitorTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                  background: 'transparent', color: monitorTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer', fontSize: 12, marginBottom: -1
                }}>{label}</button>
              ))}
              <button onClick={() => openMonitor(monitorTab)} disabled={monitorLoading} style={{ marginLeft: 'auto', padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                {monitorLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {monitorError && <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{monitorError}</div>}

              {/* 实例状态 Tab */}
              {monitorTab === 'status' && (() => {
                const summary = parseServerStatusSummary(serverStatus)
                if (!summary && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载</div>
                if (!summary) return null
                const conn = summary.connections as Record<string, number>
                const ops = summary.opcounters as Record<string, number>
                const mem = summary.mem as Record<string, number>
                const wt = summary.wiredTiger as Record<string, number> | null
                const fmtN = (n: number | undefined) => n == null ? '-' : n.toLocaleString()
                const pct = (a: number | undefined, b: number | undefined) => a == null || b == null || b === 0 ? '-' : `${((a / b) * 100).toFixed(1)}%`
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                    {[
                      { label: '版本', value: summary.version },
                      { label: '运行时长', value: `${Math.floor((summary.uptime as number) / 3600)}h ${Math.floor(((summary.uptime as number) % 3600) / 60)}m` },
                      { label: '当前连接数', value: fmtN(conn.current) },
                      { label: '可用连接数', value: fmtN(conn.available) },
                      { label: 'Query 次数', value: fmtN(ops.query) },
                      { label: 'Insert 次数', value: fmtN(ops.insert) },
                      { label: 'Update 次数', value: fmtN(ops.update) },
                      { label: 'Delete 次数', value: fmtN(ops.delete) },
                      { label: '常驻内存', value: `${fmtN(mem.resident)} MB` },
                      { label: '虚拟内存', value: `${fmtN(mem.virtual)} MB` },
                      ...(wt ? [
                        { label: 'WT 缓存命中率', value: pct(wt['pages read into cache'], wt['pages requested from the cache']) },
                        { label: 'WT 脏页占比', value: pct(wt['tracked dirty bytes in the cache'], wt['bytes currently in the cache']) },
                      ] : []),
                    ].map(({ label, value }) => (
                      <div key={label} style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* 当前操作 Tab */}
              {monitorTab === 'ops' && (() => {
                const ops = parseCurrentOps(currentOps)
                if (ops.length === 0 && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>{currentOps ? '无进行中的操作' : '点击刷新加载'}</div>
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ops.map((op, i) => {
                      const secs = (op.secs_running as number) ?? 0
                      const ns = String(op.ns ?? '')
                      const opId = op.opid as number
                      return (
                        <div key={i} style={{ padding: '10px 14px', borderRadius: 10, border: `1px solid ${secs > 5 ? 'color-mix(in srgb, var(--error) 35%, transparent)' : 'var(--border-subtle)'}`, background: 'var(--surface-2)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>#{opId}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{String(op.op ?? 'unknown')}</span>
                              {ns && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{ns}</span>}
                              {secs > 0 && <span style={{ fontSize: 11, color: secs > 5 ? '#dc2626' : '#ea580c', fontWeight: 600 }}>{secs}s</span>}
                              {String(op.planSummary ?? '').includes('COLLSCAN') && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#ea580c22', border: '1px solid #ea580c40', color: 'var(--warning)' }}>COLLSCAN</span>}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {JSON.stringify(op.command ?? op.query ?? {}).substring(0, 120)}
                            </div>
                          </div>
                          {opId && (
                            <button
                              onClick={() => setKillOpConfirm(opId)}
                              title="终止此操作"
                              style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #dc2626', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 11, flexShrink: 0 }}
                            >Kill</button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* 锁等待 Tab */}
              {monitorTab === 'locks' && (() => {
                const ops = parseCurrentOps(currentOps).filter((op) => op.waitingForLock)
                if (!currentOps && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载</div>
                if (ops.length === 0) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>无锁等待操作</div>
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ops.map((op, i) => {
                      const secs = (op.secs_running as number) ?? 0
                      const ns = String(op.ns ?? '')
                      const opId = op.opid as number
                      return (
                        <div key={i} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #ea580c40', background: '#ea580c08', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>#{opId}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>{String(op.op ?? 'unknown')}</span>
                              {ns && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{ns}</span>}
                              {secs > 0 && <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>{secs}s</span>}
                              <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#ea580c22', border: '1px solid #ea580c40', color: 'var(--warning)' }}>等待锁</span>
                              {String(op.lockType ?? '') && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{String(op.lockType ?? '')}</span>}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {JSON.stringify(op.command ?? op.query ?? {}).substring(0, 120)}
                            </div>
                          </div>
                          {opId && (
                            <button onClick={() => setKillOpConfirm(opId)} title="终止此操作"
                              style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #dc2626', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 11, flexShrink: 0 }}
                            >Kill</button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* 慢查询 Tab */}
              {monitorTab === 'slowlog' && (() => {
                const level = profileStatus?.was ?? -1
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Profiling 级别：</span>
                      {([0, 1, 2] as const).map((l) => (
                        <button key={l} onClick={() => doSetProfileLevel(l)} disabled={profileSetting}
                          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: profileSetting ? 'not-allowed' : 'pointer', border: '1px solid var(--border)', fontWeight: level === l ? 700 : 400, background: level === l ? 'var(--accent)' : 'var(--surface)', color: level === l ? '#fff' : 'var(--text)' }}
                        >{l === 0 ? '0 关' : l === 1 ? `1 慢查询 (≥${profileStatus?.slowms ?? 100}ms)` : '2 全量'}</button>
                      ))}
                      {profileSetting && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>设置中…</span>}
                    </div>
                    {!slowQueries && !monitorLoading && <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载</div>}
                    {slowQueries && slowQueries.length === 0 && <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>system.profile 暂无记录{level === 0 ? '（当前 profiling 已关闭）' : ''}</div>}
                    {slowQueries && slowQueries.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {slowQueries.map((q, i) => {
                          const ms = Number((q as Record<string, unknown>).millis ?? 0)
                          const ns = String((q as Record<string, unknown>).ns ?? '')
                          const op = String((q as Record<string, unknown>).op ?? 'query')
                          const plan = String((q as Record<string, unknown>).planSummary ?? '')
                          const ts = (q as Record<string, unknown>).ts
                          return (
                            <div key={i} style={{ padding: '10px 14px', borderRadius: 10, border: `1px solid ${ms > 1000 ? 'color-mix(in srgb, var(--error) 35%, transparent)' : 'var(--border-subtle)'}`, background: 'var(--surface-2)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>{op}</span>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{ns}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: ms > 1000 ? '#dc2626' : ms > 200 ? '#ea580c' : 'var(--text)', marginLeft: 'auto' }}>{ms}ms</span>
                              </div>
                              {plan && <div style={{ fontSize: 11, color: plan.includes('COLLSCAN') ? '#ea580c' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: 2 }}>{plan}</div>}
                              {ts != null && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{String(ts)}</div>}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* 存储容量 Tab */}
              {monitorTab === 'storage' && (() => {
                const fmtSize = (bytes: number) => {
                  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
                  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`
                  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
                  return `${bytes} B`
                }
                if (!dbStorage && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载</div>
                if (dbStorage && dbStorage.length === 0) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>暂无集合数据</div>
                if (!dbStorage) return null
                return (
                  <div style={{ overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                          {['集合', '文档数', '平均文档大小', '数据大小', '索引大小', '总大小'].map((h) => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: h === '集合' ? 'left' : 'right', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dbStorage.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                              {row.ns.split('.').slice(1).join('.')}
                              {row.capped && <span style={{ fontSize: 10, marginLeft: 6, padding: '1px 4px', borderRadius: 3, background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>CAPPED</span>}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{row.docCount.toLocaleString()}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fmtSize(row.avgObjSize)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{fmtSize(row.storageSize)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{fmtSize(row.indexSizes)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{fmtSize(row.totalSize)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}

              {/* 副本集 Tab (MO7.1) */}
              {monitorTab === 'replset' && (() => {
                if (!replSetStatus && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载（单机模式不支持此命令）</div>
                if (!replSetStatus) return null
                let data: Record<string, unknown>
                try { data = JSON.parse(replSetStatus) } catch { return <div style={{ color: 'var(--error)', padding: 16, fontSize: 12 }}>解析副本集状态失败</div> }
                const members = (data.members ?? []) as Record<string, unknown>[]
                const primary = members.find(m => String(m.stateStr ?? '') === 'PRIMARY')
                const primaryMs = primary?.optimeDate
                  ? new Date(String(primary.optimeDate)).getTime()
                  : null
                const stateColor = (s: string) => s === 'PRIMARY' ? '#16a34a' : s === 'SECONDARY' ? 'var(--accent)' : s === 'ARBITER' ? '#ea580c' : '#dc2626'
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-muted)' }}>集群名 </span>
                        <span style={{ color: 'var(--text-bright)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{String(data.set ?? '-')}</span>
                      </div>
                      <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-muted)' }}>主节点 </span>
                        <span style={{ color: 'var(--success)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{String(primary?.name ?? '未知')}</span>
                      </div>
                      <div style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 12 }}>
                        <span style={{ color: 'var(--text-muted)' }}>成员数 </span>
                        <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>{members.length}</span>
                      </div>
                    </div>
                    <div style={{ overflow: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                            {['成员地址', '角色', '健康', '复制延迟', 'Ping', '选举 ID'].map((h) => (
                              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m, i) => {
                            const stateStr = String(m.stateStr ?? 'UNKNOWN')
                            const health = Number(m.health ?? 0)
                            const optMs = m.optimeDate ? new Date(String(m.optimeDate)).getTime() : null
                            const lagSec = (primaryMs && optMs && stateStr !== 'PRIMARY') ? Math.round((primaryMs - optMs) / 1000) : null
                            const isLagDanger = lagSec != null && lagSec > 30
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{String(m.name ?? '')}</td>
                                <td style={{ padding: '8px 12px' }}>
                                  <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: `${stateColor(stateStr)}22`, color: stateColor(stateStr), fontWeight: 600 }}>{stateStr}</span>
                                </td>
                                <td style={{ padding: '8px 12px', color: health === 1 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{health === 1 ? '正常' : '异常'}</td>
                                <td style={{ padding: '8px 12px', color: isLagDanger ? '#dc2626' : 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: isLagDanger ? 700 : 400 }}>
                                  {lagSec != null ? `${lagSec}s${isLagDanger ? ' ⚠' : ''}` : '-'}
                                </td>
                                <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{String(m.pingMs ?? '0')}ms</td>
                                <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{String((m.electionId as Record<string, unknown> | undefined)?.$oid ?? '-')}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {members.some(m => {
                      const optMs = m.optimeDate ? new Date(String(m.optimeDate)).getTime() : null
                      return primaryMs && optMs && String(m.stateStr ?? '') !== 'PRIMARY' && (primaryMs - optMs) / 1000 > 30
                    }) && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', background: '#dc262608', fontSize: 12, color: 'var(--error)' }}>
                        ⚠ 存在复制延迟超过 30 秒的从节点，请关注数据同步状态。
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* 分片状态 Tab (MO7.3) */}
              {monitorTab === 'shards' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {!shardStatus && !monitorLoading && (
                    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                      点击刷新加载（需 mongos 分片集群）
                    </div>
                  )}
                  {shardStatus && (
                    <>
                      {shardStatus.jumboCount > 0 && (
                        <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', background: '#dc262608', fontSize: 12, color: 'var(--error)' }}>
                          ⚠ 发现 {shardStatus.jumboCount} 个 jumbo chunk，无法被 balancer 迁移，需手动处理。
                        </div>
                      )}
                      {shardStatus.chunkDistrib.some(c => c.skewed) && (
                        <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 12, color: 'var(--warning)' }}>
                          ⚠ 检测到 chunk 数据倾斜：某分片的 chunk 数量超过平均值 2 倍，可能影响性能。
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                        {[
                          ['分片数', String(shardStatus.shards.length)],
                          ['Balancer', shardStatus.balancerEnabled ? (shardStatus.balancerRunning ? '运行中' : '已启用') : '已停用'],
                          ['Jumbo Chunk', String(shardStatus.jumboCount)],
                          ['倾斜检测', shardStatus.chunkDistrib.some(c => c.skewed) ? '⚠ 有倾斜' : '✓ 均衡'],
                        ].map(([k, v]) => (
                          <div key={k} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{k}</div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>分片节点</div>
                        {shardStatus.shards.map(s => (
                          <div key={s.id} style={{ display: 'flex', gap: 10, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', marginBottom: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', minWidth: 80 }}>{s.id}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, fontFamily: 'var(--font-mono)' }}>{s.host}</span>
                            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: s.state === 1 ? '#16a34a20' : '#dc262620', color: s.state === 1 ? '#16a34a' : '#dc2626' }}>
                              {s.state === 1 ? '正常' : `state=${s.state}`}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Chunk 分布</div>
                        {shardStatus.chunkDistrib.map(c => (
                          <div key={c.shard} style={{ display: 'flex', gap: 10, padding: '6px 10px', borderRadius: 6, border: `1px solid ${c.skewed ? '#ea580c40' : 'var(--border-subtle)'}`, background: c.skewed ? '#ea580c08' : 'var(--surface-2)', marginBottom: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: c.skewed ? '#ea580c' : 'var(--text)', minWidth: 80 }}>{c.shard}</span>
                            <span style={{ fontSize: 11, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{c.chunkCount} chunks</span>
                            {c.skewed && <span style={{ fontSize: 10, color: 'var(--warning)', marginLeft: 'auto' }}>⚠ 倾斜</span>}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* 分片键分析 Tab (MO7.4) */}
              {monitorTab === 'shardkeys' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {!activeDb && (
                    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                      请先在左侧选择一个数据库
                    </div>
                  )}
                  {activeDb && !shardKeys && !monitorLoading && (
                    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                      点击刷新加载 {activeDb} 库的分片键信息（需 mongos）
                    </div>
                  )}
                  {shardKeys && shardKeys.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                      {activeDb} 库中无分片集合
                    </div>
                  )}
                  {shardKeys && shardKeys.map(sk => (
                    <div key={sk.ns} style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${sk.isMonotonic ? '#ea580c40' : 'var(--border-subtle)'}`, background: sk.isMonotonic ? '#ea580c08' : 'var(--surface-2)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{sk.ns}</span>
                        {sk.unique && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}>唯一</span>}
                        {sk.isMonotonic && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#ea580c20', color: 'var(--warning)', marginLeft: 'auto' }}>⚠ 单调递增键（热点风险）</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>分片键</div>
                      <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{sk.shardKey}</code>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{sk.chunkCount} chunks</div>
                      {sk.isMonotonic && (
                        <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6, lineHeight: 1.5 }}>
                          单调递增的分片键（如 _id/时间戳）会导致所有写入集中在最后一个分片（热点），影响写吞吐量。建议使用哈希分片键或随机字段。
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* oplog Tab (MO7.2) */}
              {monitorTab === 'oplog' && (() => {
                if (!oplogInfo && !monitorLoading) return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>点击刷新加载（需副本集环境）</div>
                if (!oplogInfo) return null
                const isWindowSmall = oplogInfo.windowHours < 24
                const rows: [string, string, string?][] = [
                  ['配置容量', `${oplogInfo.configuredSizeMb.toLocaleString()} MB`],
                  ['已用容量', `${oplogInfo.usedMb.toLocaleString()} MB (${oplogInfo.usedPct.toFixed(1)}%)`],
                  ['oplog 窗口', `${oplogInfo.windowHours.toFixed(1)} 小时 (${(oplogInfo.windowSeconds / 60).toFixed(0)} 分钟)`, isWindowSmall ? 'warn' : undefined],
                  ['写入速率', `${oplogInfo.writeRateOps.toFixed(2)} ops/s`],
                  ['最早记录', oplogInfo.firstTsSec > 0 ? new Date(oplogInfo.firstTsSec * 1000).toLocaleString() : '-'],
                  ['最新记录', oplogInfo.lastTsSec > 0 ? new Date(oplogInfo.lastTsSec * 1000).toLocaleString() : '-'],
                ]
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {isWindowSmall && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', background: '#dc262608', fontSize: 12, color: 'var(--error)' }}>
                        ⚠ oplog 窗口仅 {oplogInfo.windowHours.toFixed(1)} 小时，过短可能导致从节点脱节。建议 oplog 窗口至少 24 小时。
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                      {rows.map(([label, value, flag]) => (
                        <div key={label} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${flag === 'warn' ? '#ea580c40' : 'var(--border-subtle)'}`, background: flag === 'warn' ? '#ea580c08' : 'var(--surface-2)' }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: flag === 'warn' ? '#ea580c' : 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowMonitor(false)} style={{ padding: '6px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* killOp 确认 */}
      {killOpConfirm !== null && (
        <ConfirmModal
          msg={`确定终止操作 #${killOpConfirm}？长时间操作终止后 MongoDB 会执行回滚，可能较慢。`}
          onOk={() => doKillOp(killOpConfirm)}
          onCancel={() => setKillOpConfirm(null)}
          danger
        />
      )}

      {/* MO1.2 集合统计弹窗 */}
      {showCollStats && collStatsTarget && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 600, display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Info size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>集合统计 — {collStatsTarget.db}/{collStatsTarget.coll}</span>
              <button onClick={() => setShowCollStats(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {!collStatsData
                ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
                : (() => {
                    let data: Record<string, unknown>
                    try { data = JSON.parse(collStatsData) } catch { return <pre style={{ fontSize: 11, color: 'var(--error)' }}>{collStatsData}</pre> }
                    if (data.error) return <div style={{ color: 'var(--error)', fontSize: 12 }}>{String(data.error)}</div>
                    const fmtSize = (n: unknown) => {
                      const b = Number(n ?? 0)
                      if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`
                      if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`
                      if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
                      return `${b} B`
                    }
                    const rows: [string, string][] = [
                      ['文档数', Number(data.count ?? 0).toLocaleString()],
                      ['平均文档大小', fmtSize(data.avgObjSize)],
                      ['数据大小', fmtSize(data.size)],
                      ['存储大小', fmtSize(data.storageSize)],
                      ['索引数', String(data.nindexes ?? '-')],
                      ['总索引大小', fmtSize(data.totalIndexSize)],
                      ['是否分片', data.sharded ? '是' : '否'],
                      ['是否 capped', data.capped ? `是（max ${Number(data.max ?? 0).toLocaleString()} 条）` : '否'],
                    ]
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {rows.map(([label, value]) => (
                          <div key={label} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    )
                  })()
              }
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCollStats(false)} style={{ padding: '6px 18px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* MO1.3 新建集合弹窗 */}
      {showCreateColl && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Plus size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>新建集合 — {createCollDb}</span>
              <button onClick={() => setShowCreateColl(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>集合名</div>
                <input
                  autoFocus
                  value={createCollName}
                  onChange={e => setCreateCollName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && createCollName.trim()) doCreateCollection() }}
                  placeholder="输入集合名称"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
              {createCollError && <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--error)' }}>{createCollError}</div>}
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowCreateColl(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button
                onClick={doCreateCollection}
                disabled={!createCollName.trim() || createCollLoading || connReadOnly}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: createCollName.trim() && !createCollLoading && !connReadOnly ? 'var(--accent)' : 'var(--surface-2)', color: createCollName.trim() && !createCollLoading && !connReadOnly ? '#fff' : 'var(--text-muted)', cursor: createCollName.trim() && !createCollLoading && !connReadOnly ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {createCollLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                创建
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* MO1.3 删除集合确认弹窗 */}
      {dropCollTarget && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 14, width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Trash2 size={14} style={{ color: 'var(--error)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1, fontSize: 14 }}>删除集合</span>
              <button onClick={() => { setDropCollTarget(null); setDropCollInput(''); setDropCollError(null) }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', fontSize: 12, color: 'var(--error)', lineHeight: 1.6 }}>
                ⚠ 此操作将永久删除集合 <strong style={{ fontFamily: 'var(--font-mono)' }}>{dropCollTarget.db}/{dropCollTarget.coll}</strong> 及其所有文档和索引，无法恢复！
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>请输入集合名 <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{dropCollTarget.coll}</span> 以确认删除</div>
                <input
                  autoFocus
                  value={dropCollInput}
                  onChange={e => setDropCollInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && dropCollInput === dropCollTarget.coll && !dropCollLoading) doDropCollection() }}
                  placeholder={`输入：${dropCollTarget.coll}`}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${dropCollInput === dropCollTarget.coll ? '#dc2626' : 'var(--border)'}`, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
              {dropCollError && <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--error)' }}>{dropCollError}</div>}
            </div>
            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setDropCollTarget(null); setDropCollInput(''); setDropCollError(null) }} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button
                onClick={doDropCollection}
                disabled={dropCollInput !== dropCollTarget.coll || dropCollLoading}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: dropCollInput === dropCollTarget.coll && !dropCollLoading ? '#dc2626' : 'var(--surface-2)', color: dropCollInput === dropCollTarget.coll && !dropCollLoading ? '#fff' : 'var(--text-muted)', cursor: dropCollInput === dropCollTarget.coll && !dropCollLoading ? 'pointer' : 'not-allowed', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {dropCollLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 批量操作弹窗（MO2.4）*/}
      {batchMode && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '90%', maxWidth: 580, display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
              {batchMode === 'delete'
                ? <Trash2 size={14} style={{ color: 'var(--error)' }} />
                : <Zap size={14} style={{ color: 'var(--warning)' }} />}
              <span style={{ color: 'var(--text-bright)', fontWeight: 600, flex: 1 }}>
                {batchMode === 'delete' ? '批量删除文档' : '批量更新文档'} — {activeDb}/{activeColl}
              </span>
              <button onClick={() => setBatchMode(null)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={16} /></button>
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* 警告 */}
              <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', borderRadius: 8, fontSize: 12, color: 'var(--error)' }}>
                {batchMode === 'delete'
                  ? '⚠ 危险操作：批量删除不可撤销。执行前请务必确认 filter 命中范围。'
                  : '⚠ 高危操作：批量更新将修改所有命中文档。执行前请确认 filter 与 update 正确。'}
              </div>

              {/* Filter */}
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                  Filter（JSON，留空 = 全集合，<span style={{ color: 'var(--error)' }}>需输入集合名确认</span>）
                </label>
                <textarea
                  value={batchFilter}
                  onChange={e => { setBatchFilter(e.target.value); setBatchPreviewCount(null) }}
                  rows={3}
                  style={{ width: '100%', boxSizing: 'border-box', padding: 8, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                  placeholder='{"status": "inactive"}'
                />
              </div>

              {/* Update（仅 updateMany 显示）*/}
              {batchMode === 'update' && (
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    Update（必须使用操作符，如 {'{'}$set: {'{'}key: "val"{'}'}{'}'} ）
                  </label>
                  <textarea
                    value={batchUpdate}
                    onChange={e => setBatchUpdate(e.target.value)}
                    rows={3}
                    style={{ width: '100%', boxSizing: 'border-box', padding: 8, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                    placeholder='{"$set": {"status": "archived"}}'
                  />
                </div>
              )}

              {/* 预览命中数 */}
              {batchPreviewCount !== null && (
                <div style={{ padding: '8px 12px', background: '#ea580c15', border: '1px solid #ea580c40', borderRadius: 8, fontSize: 13, color: 'var(--warning)', fontWeight: 600 }}>
                  命中文档数：{batchPreviewCount} 条
                  {batchPreviewCount === 0 && ' — filter 无匹配，无需操作'}
                </div>
              )}

              {/* 空 filter 时额外要求输入集合名 */}
              {(() => {
                let parsed: Record<string, unknown> = {}
                try { parsed = JSON.parse(batchFilter.trim() || '{}') } catch { /* */ }
                if (Object.keys(parsed).length === 0) {
                  return (
                    <div>
                      <label style={{ fontSize: 12, color: 'var(--error)', display: 'block', marginBottom: 4 }}>
                        空 filter 将操作全集合！请输入集合名 "{activeColl}" 确认：
                      </label>
                      <input
                        value={batchCollName}
                        onChange={e => setBatchCollName(e.target.value)}
                        placeholder={activeColl ?? ''}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '2px solid #dc2626', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--error)', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                  )
                }
                return null
              })()}

              {/* 错误 / 成功 */}
              {batchError && <div style={{ color: 'var(--error)', fontSize: 12 }}>{batchError}</div>}
              {batchDone && <div style={{ color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>{batchDone}</div>}
            </div>

            <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <button
                onClick={batchPreview}
                disabled={batchPreviewing}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
              >
                {batchPreviewing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={12} />}
                预览命中数
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setBatchMode(null)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>取消</button>
                <button
                  onClick={batchExecute}
                  disabled={batchRunning || batchPreviewCount === 0}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: batchMode === 'delete' ? '#dc2626' : '#ea580c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {batchRunning ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                  {batchMode === 'delete' ? '确认批量删除' : '确认批量更新'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
      </div>{/* end 主布局 */}

      {/* MO8.1 导出对话框 */}
      {showExport && activeColl && activeDb && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 480, display: 'flex', flexDirection: 'column', gap: 14, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Download size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>导出集合 — {activeDb}/{activeColl}</span>
              <button onClick={() => setShowExport(false)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 60 }}>格式</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {MONGO_EXPORT_FORMATS.map(f => (
                  <button key={f.v} onClick={() => setExportFormat(f.v)}
                    style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid var(--border)', background: exportFormat === f.v ? 'var(--accent)' : 'var(--surface-2)', color: exportFormat === f.v ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              将使用当前查询过滤条件导出（最多 50,000 条）。JSON / JSONL 保留 BSON 类型信息（Extended JSON）；CSV / TSV / Excel 为扁平文本（嵌套字段转为字符串）；Text 为缩进 JSON。
            </div>
            {exportResult && <div style={{ fontSize: 12, color: 'var(--success)', padding: '8px 12px', borderRadius: 8, border: '1px solid #16a34a40', background: '#16a34a08' }}>{exportResult}</div>}
            {exportError && <div style={{ fontSize: 12, color: 'var(--error)', padding: '8px 12px', borderRadius: 8, border: '1px solid #ef444440', background: '#ef444408' }}>{exportError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setShowExport(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>关闭</button>
              <button
                onClick={async () => {
                  try {
                    const { save } = await import('@tauri-apps/plugin-dialog')
                    const fmt = MONGO_EXPORT_FORMATS.find(f => f.v === exportFormat)!
                    const path = await save({ filters: [{ name: fmt.label, extensions: [fmt.ext] }], defaultPath: `${activeColl}.${fmt.ext}` })
                    if (path) await doExport(path)
                  } catch (e) { setExportError(String(e)) }
                }}
                disabled={exportLoading}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: exportLoading ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {exportLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={13} />}
                选择保存位置
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* MO8.2 导入对话框 */}
      {showImport && activeColl && activeDb && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 520, display: 'flex', flexDirection: 'column', gap: 14, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Plus size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-bright)' }}>导入到 {activeDb}/{activeColl}</span>
              <button onClick={() => { setShowImport(false); setImportConfirm(false) }} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 60 }}>格式</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {MONGO_IMPORT_FORMATS.map(f => (
                  <button key={f.v} onClick={() => setImportFormat(f.v)}
                    style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid var(--border)', background: importFormat === f.v ? 'var(--accent)' : 'var(--surface-2)', color: importFormat === f.v ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 60 }}>冲突策略</span>
              {(['skip', 'overwrite'] as const).map(c => (
                <button key={c} onClick={() => setImportOnConflict(c)}
                  style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid var(--border)', background: importOnConflict === c ? 'var(--accent)' : 'var(--surface-2)', color: importOnConflict === c ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                  {c === 'skip' ? '跳过（_id 重复时忽略）' : '覆盖（replaceOne by _id）'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={importPath} onChange={e => setImportPath(e.target.value)} placeholder="/path/to/file.json"
                style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
              <button onClick={async () => {
                try {
                  const { open } = await import('@tauri-apps/plugin-dialog')
                  const fmt = MONGO_IMPORT_FORMATS.find(f => f.v === importFormat)!
                  const p = await open({ filters: [{ name: fmt.label, extensions: [...fmt.ext] }] })
                  if (p && typeof p === 'string') setImportPath(p)
                } catch { /* ignore */ }
              }} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>选择</button>
            </div>
            {importResult && <div style={{ fontSize: 12, color: 'var(--success)', padding: '8px 12px', borderRadius: 8, border: '1px solid #16a34a40', background: '#16a34a08' }}>{importResult}</div>}
            {importError && <div style={{ fontSize: 12, color: 'var(--error)', padding: '8px 12px', borderRadius: 8, border: '1px solid #ef444440', background: '#ef444408' }}>{importError}</div>}
            {importConfirm ? (
              <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)', background: '#dc262608', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--error)', fontWeight: 600 }}>⚠ 确认导入</div>
                <div style={{ fontSize: 11, color: 'var(--error)' }}>
                  将从 {importPath} 导入数据到 <strong>{activeDb}/{activeColl}</strong>。
                  {importOnConflict === 'overwrite' ? '覆盖模式会替换已有 _id 的文档。' : '跳过模式不影响已有文档。'}
                  此操作不可撤销，请确认继续。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setImportConfirm(false)} style={{ flex: 1, padding: '6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
                  <button onClick={doImport} disabled={importLoading}
                    style={{ flex: 1, padding: '6px', borderRadius: 6, border: 'none', background: 'var(--error)', color: '#fff', cursor: importLoading ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    {importLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                    确认导入
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setShowImport(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
                <button onClick={() => setImportConfirm(true)} disabled={!importPath.trim()}
                  style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: importOnConflict === 'overwrite' ? '#dc2626' : 'var(--accent)', color: '#fff', cursor: !importPath.trim() ? 'not-allowed' : 'pointer', fontSize: 12, opacity: !importPath.trim() ? 0.5 : 1 }}>
                  下一步 →
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
      {/* MO10.1 巡检报告 */}
      {showInspect && (
        <MongoInspectPanel
          connectionId={connectionId}
          currentDb={activeDb ?? 'admin'}
          onClose={() => setShowInspect(false)}
        />
      )}
      {showGridfs && activeDb && (
        <MongoGridFsPanel connectionId={connectionId} db={activeDb} onClose={() => setShowGridfs(false)} />
      )}
      {showStream && activeDb && activeColl && (
        <MongoStreamPanel connectionId={connectionId} db={activeDb} coll={activeColl} onClose={() => setShowStream(false)} />
      )}
      {showCopy && activeDb && activeColl && (
        <MongoCopyPanel connectionId={connectionId} db={activeDb} coll={activeColl} onClose={() => setShowCopy(false)} />
      )}
      {showBackup && activeDb && (
        <MongoBackupPanel connectionId={connectionId} db={activeDb} onClose={() => setShowBackup(false)} />
      )}
      {showMaskExport && activeDb && activeColl && (
        <MongoMaskExportPanel connectionId={connectionId} db={activeDb} coll={activeColl} onClose={() => setShowMaskExport(false)} />
      )}
      {showBalancer && (
        <MongoBalancerPanel connectionId={connectionId} onClose={() => setShowBalancer(false)} />
      )}
      {showRecovery && (
        <MongoRecoveryPanel connectionId={connectionId} onClose={() => setShowRecovery(false)} />
      )}
      {showSmartShell && (
        <MongoSmartShellPanel connectionId={connectionId} db={activeDb ?? 'admin'} coll={activeColl ?? undefined} onClose={() => setShowSmartShell(false)} />
      )}
      {showRisk && (
        <MongoRiskPanel connectionId={connectionId} onClose={() => setShowRisk(false)} />
      )}
      {/* MO10.3 schema 分析 */}
      {showSchema && activeDb && activeColl && (
        <MongoSchemaPanel
          connId={connectionId}
          db={activeDb}
          coll={activeColl}
          onClose={() => setShowSchema(false)}
        />
      )}
      {/* MO10.7 多文档事务 */}
      {showTx && (
        <MongoTxPanel
          connId={connectionId}
          currentDb={activeDb ?? 'test'}
          onClose={() => setShowTx(false)}
        />
      )}
      {/* MO10.4 告警阈值 */}
      {showAlert && (
        <MongoAlertPanel
          connId={connectionId}
          alertState={alertState}
          onClose={() => setShowAlert(false)}
          onSave={setAlertThresholds}
        />
      )}
      {/* MO9.4 操作审计日志 */}
      {showAudit && (
        <MongoAuditPanel
          connectionId={connectionId}
          onClose={() => setShowAudit(false)}
        />
      )}
      {/* MO9.3 用户与角色管理 */}
      {showUsers && activeDb && (
        <MongoUsersPanel
          connectionId={connectionId}
          currentDb={activeDb}
          readOnly={connReadOnly}
          onClose={() => setShowUsers(false)}
        />
      )}
      {/* MO10.5 片段库 */}
      {showSnippets && (
        <MongoSnippetsPanel
          connectionId={connectionId}
          onInsertFilter={json => setFilterJson(json)}
          onInsertPipeline={json => {
            try {
              const arr = JSON.parse(json) as Record<string, unknown>[]
              if (!Array.isArray(arr)) return
              let nextId = aggIdRef.current
              const stages = arr.map(stage => {
                const op = Object.keys(stage).find(k => k.startsWith('$')) ?? '$match'
                const val = stage[op]
                return { id: nextId++, operator: op, json: JSON.stringify(val, null, 2), enabled: true }
              })
              aggIdRef.current = nextId
              setAggStages(stages)
              setShowAggregate(true)
            } catch { /* ignore */ }
          }}
          onInsertShell={json => { setShellInput(json); setShowShell(true) }}
          onRunFilter={json => {
            if (!activeDb || !activeColl) return
            setFilterJson(json)
            fetchDocs(activeDb, activeColl, { filterJson: json })
          }}
          onClose={() => setShowSnippets(false)}
        />
      )}
    </div>
  )
}
