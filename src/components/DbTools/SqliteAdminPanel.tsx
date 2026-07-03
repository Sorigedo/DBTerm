// SQLite 维护诊断面板（S0.4 + S2.1–S2.6）
// 仅对 SQLite 连接显示，与 SQL 侧通用工具面板并列
import { useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle, X } from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'
import { useQueryHistoryStore } from '../../stores/queryHistoryStore'
import { useSchemaHistoryStore } from '../../stores/schemaHistoryStore'
import { useCapacityStore } from '../../stores/capacityStore'
import { useShortcuts } from '../../utils/useShortcuts'
import { toast } from '../../stores/toastStore'
import SearchableSelect from './SearchableSelect'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    await invoke('write_local_file', { path, content })
    toast.exported(path)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface Props { connectionId: string; onClose?: () => void }

interface SqliteConnInfo {
  sqliteVersion: string; journalMode: string; pageSize: number; pageCount: number
  freelistCount: number; encoding: string; fileSizeBytes: number
  userVersion: number; applicationId: number; foreignKeys: boolean
  walSizeBytes: number; shmSizeBytes: number
}
interface IntegrityResult { ok: boolean; issues: string[]; fkViolations: string[] }
interface SpaceStats {
  pageSize: number; pageCount: number; freelistCount: number
  totalBytes: number; freeBytes: number; fragmentationPct: number
  tables: { name: string; pages: number; bytes: number }[]
}
interface WalStatus { journalMode: string; walFileBytes: number; shmFileBytes: number }
interface CheckpointResult { busy: number; logFrames: number; checkpointedFrames: number }
interface PragmaEntry { name: string; value: string; writable: boolean; group: string }
interface LockProcess { pid: string; command: string; user: string; fd: string; lockType: string }
interface LockDiagnosis {
  processes: LockProcess[]
  walCheckpoint: { busy: number; logFrames: number; checkpointedFrames: number } | null
  walFileBytes: number
  summary: string
}
interface IndexSuggestion {
  table: string; columns: string[]; reason: string; createSql: string; isRedundantCandidate: boolean
}
interface RedundantIndex { name: string; table: string; coveredBy: string; dropSql: string }
interface IndexAdvisorResult { suggestions: IndexSuggestion[]; redundantIndexes: RedundantIndex[]; scanNodes: string[] }
interface BackupRecord { path: string; createdAt: number; sizeBytes: number; note: string }
interface DdlDiffEntry { kind: string; name: string; objType: string; leftSql?: string; rightSql?: string }
interface DbDiffResult { ddlDiff: DdlDiffEntry[]; dataScript: string; dataChanges: number }
interface HealthCheck { category: string; item: string; status: string; detail: string; scoreImpact: number }
interface HealthReport { score: number; checks: HealthCheck[]; markdown: string }

function fmtBytes(b: number) {
  if (b === 0) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const TABS = ['信息', '完整性', '空间', 'WAL', 'PRAGMA', '锁诊断', '索引顾问', '备份', '库对比', '健康报告', '慢查询', '变更历史', '容量趋势', '数据字典'] as const
type Tab = typeof TABS[number]

export default function SqliteAdminPanel({ connectionId, onClose }: Props) {
  const [tab,           setTab]         = useState<Tab>('信息')
  const [connInfo,      setConnInfo]    = useState<SqliteConnInfo | null>(null)
  const [integrity,     setIntegrity]   = useState<IntegrityResult | null>(null)
  const [space,         setSpace]       = useState<SpaceStats | null>(null)
  const [wal,           setWal]         = useState<WalStatus | null>(null)
  const [pragmas,       setPragmas]     = useState<PragmaEntry[]>([])
  const [loading,       setLoading]     = useState(false)
  const [error,         setError]       = useState('')
  const [vacuumPath,    setVacuumPath]  = useState('')
  const [editPragma,    setEditPragma]  = useState<{name: string; val: string} | null>(null)
  const [jounalMode,    setJournalMode] = useState('WAL')
  const [checkpointMode,setCheckpointMode] = useState('PASSIVE')

  // Confirm dialogs
  const [confirmVacuum, setConfirmVacuum] = useState(false)
  const [confirmAnalyze,setConfirmAnalyze]= useState(false)
  const [confirmOptimize,setConfirmOptimize]=useState(false)
  const [confirmJournal,setConfirmJournal]= useState(false)
  const [confirmPragma, setConfirmPragma] = useState(false)
  const [chkpointResult,setChkpointResult]= useState<CheckpointResult | null>(null)
  const [lockDiagnosis, setLockDiagnosis] = useState<LockDiagnosis | null>(null)
  const [advisorSql, setAdvisorSql] = useState('')
  const [advisorResult, setAdvisorResult] = useState<IndexAdvisorResult | null>(null)
  const [advisorLoading, setAdvisorLoading] = useState(false)
  const [advisorErr, setAdvisorErr] = useState('')
  // backup tab
  const [backupDir, setBackupDir] = useState('')
  const [backupNote, setBackupNote] = useState('')
  const [backupList, setBackupList] = useState<BackupRecord[]>([])
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupErr, setBackupErr] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<BackupRecord | null>(null)
  const [restoreMsg, setRestoreMsg] = useState('')
  const [dumpOutPath, setDumpOutPath] = useState('')
  const [dumpResult, setDumpResult] = useState<{ path: string; sizeBytes: number; tableCount: number; rowCount: number } | null>(null)
  const [maskingRules, setMaskingRules] = useState<{ table: string; column: string; rule: string }[]>([])
  const [maskingEditRow, setMaskingEditRow] = useState<{ table: string; column: string; rule: string }>({ table: '', column: '', rule: 'mask' })
  // 脱敏规则：动态表/列下拉
  const [maskTableList, setMaskTableList] = useState<string[]>([])
  const [maskColList,   setMaskColList]   = useState<string[]>([])
  useEffect(() => {
    invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema: '' })
      .then(list => setMaskTableList(list.filter(t => !t.isView).map(t => t.name)))
      .catch(() => {})
  }, [connectionId])
  useEffect(() => {
    const tbl = maskingEditRow.table
    if (!tbl) { setMaskColList([]); return }
    invoke<{ name: string; key: string }[]>('table_columns', { id: connectionId, schema: '', table: tbl })
      .then(list => setMaskColList(list.map(c => c.name)))
      .catch(() => {})
  }, [connectionId, maskingEditRow.table])
  const [rescuePath, setRescuePath] = useState('')
  const [rescueResult, setRescueResult] = useState<{ outPath: string; tablesAttempted: number; tablesRescued: number; rowsRescued: number; errors: string[] } | null>(null)
  const [confirmRescue, setConfirmRescue] = useState(false)
  // db diff tab
  const [diffRightId, setDiffRightId] = useState('')
  const [diffResult, setDiffResult] = useState<DbDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffErr, setDiffErr] = useState('')
  const [diffScriptExpanded, setDiffScriptExpanded] = useState(false)
  // health report tab
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthErr, setHealthErr] = useState('')
  // data dictionary tab
  const [dictData, setDictData] = useState<{ name: string; rowCount: number; columns: { cid: number; name: string; dataType: string; notNull: boolean; defaultValue?: string | null; pk: boolean }[]; indexes: { name: string; unique: boolean; columns: string[] }[]; foreignKeys: { fromCol: string; toTable: string; toCol: string; onUpdate: string; onDelete: string }[]; triggers: string[] }[] | null>(null)
  const [dictLoading, setDictLoading] = useState(false)
  const [dictErr, setDictErr] = useState('')
  const [dictExpanded, setDictExpanded] = useState<string | null>(null)
  // slow query tab
  const [slowThresholdMs, setSlowThresholdMs] = useState(500)
  const [slowTopN, setSlowTopN] = useState(20)

  const loadConnInfo = useCallback(async () => {
    setLoading(true); setError('')
    try { setConnInfo(await invoke<SqliteConnInfo>('sqlite_conn_info', { id: connectionId })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const loadIntegrity = useCallback(async (quick = false) => {
    setLoading(true); setError('')
    try { setIntegrity(await invoke<IntegrityResult>('sqlite_integrity_check', { id: connectionId, quick })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const loadSpace = useCallback(async () => {
    setLoading(true); setError('')
    try { setSpace(await invoke<SpaceStats>('sqlite_space_stats', { id: connectionId })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const loadWal = useCallback(async () => {
    setLoading(true); setError('')
    try { setWal(await invoke<WalStatus>('sqlite_wal_status', { id: connectionId })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const loadPragmas = useCallback(async () => {
    setLoading(true); setError('')
    try { setPragmas(await invoke<PragmaEntry[]>('sqlite_pragma_list', { id: connectionId })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const loadLockDiagnosis = useCallback(async () => {
    setLoading(true); setError('')
    try { setLockDiagnosis(await invoke<LockDiagnosis>('sqlite_lock_diagnosis', { id: connectionId })) }
    catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  const runAdvisor = useCallback(async () => {
    if (!advisorSql.trim()) return
    setAdvisorLoading(true); setAdvisorErr(''); setAdvisorResult(null)
    try { setAdvisorResult(await invoke<IndexAdvisorResult>('sqlite_index_advisor', { id: connectionId, sql: advisorSql })) }
    catch (e) { setAdvisorErr(String(e)) }
    finally { setAdvisorLoading(false) }
  }, [connectionId, advisorSql])

  const loadBackupList = useCallback(async () => {
    try { setBackupList(await invoke<BackupRecord[]>('sqlite_backup_list', { id: connectionId })) }
    catch { /* ignore */ }
  }, [connectionId])

  const doBackup = useCallback(async () => {
    setBackupBusy(true); setBackupErr('')
    try {
      await invoke<BackupRecord>('sqlite_backup', { id: connectionId, dir: backupDir || null, note: backupNote || null })
      setBackupNote('')
      await loadBackupList()
    } catch (e) { setBackupErr(String(e)) }
    finally { setBackupBusy(false) }
  }, [connectionId, backupDir, backupNote, loadBackupList])

  const doRestore = useCallback(async (record: BackupRecord) => {
    setBackupBusy(true); setRestoreMsg(''); setBackupErr('')
    try {
      const msg = await invoke<string>('sqlite_restore_backup', { id: connectionId, backupPath: record.path })
      setRestoreMsg(msg)
    } catch (e) { setBackupErr(String(e)) }
    finally { setBackupBusy(false); setConfirmRestore(null) }
  }, [connectionId])

  const doDump = useCallback(async () => {
    if (!dumpOutPath.trim()) return
    setBackupBusy(true); setBackupErr(''); setDumpResult(null)
    try {
      const r = await invoke<{ path: string; sizeBytes: number; tableCount: number; rowCount: number }>(
        'sqlite_dump_sql', { id: connectionId, outPath: dumpOutPath.trim(), maskingRules: maskingRules.length > 0 ? maskingRules : null }
      )
      setDumpResult(r)
    } catch (e) { setBackupErr(String(e)) }
    finally { setBackupBusy(false) }
  }, [connectionId, dumpOutPath, maskingRules])

  const historyEntries = useQueryHistoryStore(s => s.entries)
  const schemaHistory = useSchemaHistoryStore(s => s.entries.filter(e => e.connId === connectionId))
  const clearSchemaHistory = useSchemaHistoryStore(s => s.clear)
  const { addSnapshot, clear: clearCapacity } = useCapacityStore()
  const capacitySnapshots = useCapacityStore(s => s.snapshots.filter(x => x.connId === connectionId).sort((a, b) => a.at - b.at))

  const slowQueries = useMemo(() => {
    const threshold = slowThresholdMs
    // Fingerprint: replace literals with ?
    const fingerprint = (sql: string) => sql
      .replace(/\s+/g, ' ')
      .replace(/'[^']*'/g, '?')
      .replace(/\b\d+\b/g, '?')
      .trim()
    const byFp = new Map<string, { fp: string; sql: string; count: number; totalMs: number; maxMs: number; lastAt: number }>()
    for (const e of historyEntries) {
      if (e.connId !== connectionId) continue
      if ((e.executionTimeMs ?? 0) < threshold) continue
      const fp = fingerprint(e.sql)
      const existing = byFp.get(fp)
      if (existing) {
        existing.count++
        existing.totalMs += e.executionTimeMs ?? 0
        existing.maxMs = Math.max(existing.maxMs, e.executionTimeMs ?? 0)
        existing.lastAt = Math.max(existing.lastAt, e.at)
      } else {
        byFp.set(fp, { fp, sql: e.sql, count: 1, totalMs: e.executionTimeMs ?? 0, maxMs: e.executionTimeMs ?? 0, lastAt: e.at })
      }
    }
    return Array.from(byFp.values())
      .sort((a, b) => b.maxMs - a.maxMs)
      .slice(0, slowTopN)
  }, [historyEntries, connectionId, slowThresholdMs, slowTopN])

  const loadDict = useCallback(async () => {
    setDictLoading(true); setDictErr('')
    try { setDictData(await invoke<typeof dictData>('sqlite_data_dictionary', { id: connectionId })) }
    catch (e) { setDictErr(String(e)) }
    finally { setDictLoading(false) }
  }, [connectionId])

  const exportDictMarkdown = useCallback(async () => {
    if (!dictData) return
    let md = `# 数据字典\n\n`
    for (const t of dictData) {
      md += `## ${t.name} (${t.rowCount.toLocaleString()} 行)\n\n`
      md += `| 列名 | 类型 | NOT NULL | 默认值 | 主键 |\n|---|---|---|---|---|\n`
      for (const c of t.columns) {
        md += `| ${c.name} | ${c.dataType} | ${c.notNull ? '✓' : ''} | ${c.defaultValue ?? ''} | ${c.pk ? 'PK' : ''} |\n`
      }
      if (t.indexes.length > 0) {
        md += `\n**索引**: ${t.indexes.map(i => `${i.name}(${i.columns.join(',')})`).join(', ')}\n`
      }
      if (t.foreignKeys.length > 0) {
        md += `\n**外键**: ${t.foreignKeys.map(fk => `${fk.fromCol} → ${fk.toTable}.${fk.toCol}`).join(', ')}\n`
      }
      md += '\n'
    }
    await saveTextFile(md, 'data-dictionary.md', 'Markdown 文件', 'md')
  }, [dictData])

  const runHealthReport = useCallback(async () => {
    setHealthLoading(true); setHealthErr(''); setHealthReport(null)
    try { setHealthReport(await invoke<HealthReport>('sqlite_health_report', { id: connectionId })) }
    catch (e) { setHealthErr(String(e)) }
    finally { setHealthLoading(false) }
  }, [connectionId])

  const runDbDiff = useCallback(async () => {
    if (!diffRightId.trim()) return
    setDiffLoading(true); setDiffErr(''); setDiffResult(null)
    try {
      const r = await invoke<DbDiffResult>('sqlite_db_diff', { leftId: connectionId, rightId: diffRightId.trim(), tables: null })
      setDiffResult(r)
    } catch (e) { setDiffErr(String(e)) }
    finally { setDiffLoading(false) }
  }, [connectionId, diffRightId])

  const doRescue = useCallback(async () => {
    if (!rescuePath.trim()) return
    setBackupBusy(true); setBackupErr(''); setRescueResult(null)
    try {
      const r = await invoke<{ outPath: string; tablesAttempted: number; tablesRescued: number; rowsRescued: number; errors: string[] }>(
        'sqlite_rescue', { id: connectionId, outPath: rescuePath.trim() }
      )
      setRescueResult(r)
    } catch (e) { setBackupErr(String(e)) }
    finally { setBackupBusy(false); setConfirmRescue(false) }
  }, [connectionId, rescuePath])

  useEffect(() => {
    if (tab === '信息') loadConnInfo()
    else if (tab === '空间') loadSpace()
    else if (tab === 'WAL') loadWal()
    else if (tab === 'PRAGMA') loadPragmas()
    else if (tab === '锁诊断') loadLockDiagnosis()
    else if (tab === '备份') loadBackupList()
  }, [tab, loadConnInfo, loadSpace, loadWal, loadPragmas, loadLockDiagnosis, loadBackupList])

  // KB5 SQLite 维护面板快捷键（只读操作可直通；危险操作不绑快捷键）
  useShortcuts('sqlite-admin', {
    sqliteRefresh: () => {
      if (tab === '信息') loadConnInfo()
      else if (tab === '空间') loadSpace()
      else if (tab === 'WAL') loadWal()
      else if (tab === 'PRAGMA') loadPragmas()
    },
    sqliteIntegrity: () => loadIntegrity(false),
  })

  // S4.7: Take capacity snapshot on panel open (at most once per hour)
  useEffect(() => {
    const last = capacitySnapshots[capacitySnapshots.length - 1]
    if (last && Date.now() - last.at < 3600_000) return // skip if recent
    ;(async () => {
      try {
        const info = await invoke<{ fileSizeBytes: number }>('sqlite_conn_info', { id: connectionId })
        const spaceData = await invoke<{ tables: { name: string; bytes: number }[] }>('sqlite_space_stats', { id: connectionId })
        // Get row counts per table
        const tableRows = await Promise.all(
          (spaceData.tables ?? []).slice(0, 50).map(async (t) => {
            try {
              const res = await invoke<{ rows: unknown[][] }>('execute_query', { id: connectionId, sql: `SELECT COUNT(*) FROM "${t.name.replace(/"/g, '""')}"` })
              return { name: t.name, rows: Number(res.rows?.[0]?.[0] ?? 0) }
            } catch { return { name: t.name, rows: 0 } }
          })
        )
        addSnapshot({ connId: connectionId, at: Date.now(), fileSizeBytes: info.fileSizeBytes, tableRows })
      } catch { /* non-critical */ }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  const doVacuum = async () => {
    try {
      const msg = await invoke<string>('sqlite_vacuum', {
        id: connectionId, intoPath: vacuumPath.trim() || null,
      })
      setError(''); alert(msg)
      if (!vacuumPath.trim()) loadConnInfo()
    } catch (e) { setError(String(e)) }
    setConfirmVacuum(false)
  }

  const doAnalyze = async () => {
    try {
      await invoke('sqlite_analyze', { id: connectionId, table: null })
      setError('')
    } catch (e) { setError(String(e)) }
    setConfirmAnalyze(false)
  }

  const doOptimize = async () => {
    try {
      await invoke('sqlite_optimize', { id: connectionId })
      setError('')
    } catch (e) { setError(String(e)) }
    setConfirmOptimize(false)
  }

  const doSetJournal = async () => {
    try {
      const result = await invoke<string>('sqlite_set_journal_mode', { id: connectionId, mode: jounalMode })
      setWal(prev => prev ? { ...prev, journalMode: result } : null)
    } catch (e) { setError(String(e)) }
    setConfirmJournal(false)
  }

  const doCheckpoint = async () => {
    try {
      const r = await invoke<CheckpointResult>('sqlite_wal_checkpoint', { id: connectionId, mode: checkpointMode })
      setChkpointResult(r)
      loadWal()
    } catch (e) { setError(String(e)) }
  }

  const savePragma = async () => {
    if (!editPragma) return
    try {
      const val = await invoke<string>('sqlite_set_pragma', { id: connectionId, name: editPragma.name, value: editPragma.val })
      setPragmas(prev => prev.map(p => p.name === editPragma.name ? { ...p, value: val } : p))
      setEditPragma(null)
    } catch (e) { setError(String(e)) }
    setConfirmPragma(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <div className="redis-type-toolbar" style={{ gap: 0, padding: 0, borderBottom: '1px solid var(--border-subtle)' }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '7px 14px', border: 'none', background: 'transparent',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', fontSize: 12, fontWeight: tab === t ? 600 : 400,
            }}
          >{t}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="ssh-panel__btn" title="刷新" style={{ marginRight: 4 }} onClick={() => {
          if (tab === '信息') loadConnInfo()
          else if (tab === '完整性') loadIntegrity(false)
          else if (tab === '空间') loadSpace()
          else if (tab === 'WAL') loadWal()
          else if (tab === 'PRAGMA') loadPragmas()
          else if (tab === '锁诊断') loadLockDiagnosis()
          else if (tab === '备份') loadBackupList()
        }}><RefreshCw size={12} strokeWidth={2} className={loading ? 'spin' : ''} /></button>
        {onClose && <button className="ssh-panel__btn" title="关闭" style={{ marginRight: 8 }} onClick={onClose}><X size={12} strokeWidth={2} /></button>}
      </div>

      {error && <div className="redis-error">{error}</div>}
      {loading && <div className="redis-type-loading"><Loader2 size={16} className="spin" /></div>}

      {/* 信息 tab */}
      {tab === '信息' && connInfo && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          <table className="redis-hash-table">
            <tbody>
              <tr><td className="redis-hash-field">SQLite 版本</td><td>{connInfo.sqliteVersion}</td></tr>
              <tr><td className="redis-hash-field">日志模式</td><td>{connInfo.journalMode}</td></tr>
              <tr><td className="redis-hash-field">页大小</td><td>{connInfo.pageSize} B</td></tr>
              <tr><td className="redis-hash-field">总页数</td><td>{connInfo.pageCount.toLocaleString()}</td></tr>
              <tr><td className="redis-hash-field">空闲页数</td><td>{connInfo.freelistCount.toLocaleString()}</td></tr>
              <tr><td className="redis-hash-field">编码</td><td>{connInfo.encoding}</td></tr>
              <tr><td className="redis-hash-field">文件大小</td><td>{fmtBytes(connInfo.fileSizeBytes)}</td></tr>
              {connInfo.walSizeBytes > 0 && <tr><td className="redis-hash-field">WAL 文件</td><td>{fmtBytes(connInfo.walSizeBytes)}</td></tr>}
              <tr><td className="redis-hash-field">user_version</td><td style={{ fontFamily: 'var(--font-mono)' }}>{connInfo.userVersion}</td></tr>
              <tr><td className="redis-hash-field">application_id</td><td style={{ fontFamily: 'var(--font-mono)' }}>{connInfo.applicationId}</td></tr>
              <tr><td className="redis-hash-field">外键约束</td><td>{connInfo.foreignKeys ? '✓ 开启' : '✗ 关闭'}</td></tr>
            </tbody>
          </table>

          <div style={{ marginTop: 14, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>维护操作</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input value={vacuumPath} onChange={e => setVacuumPath(e.target.value)} placeholder="空 = 原地 VACUUM，填路径 = VACUUM INTO 备份"
                  style={{ width: 280, fontSize: 11 }} />
                <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 10px', fontSize: 11 }}
                  onClick={() => setConfirmVacuum(true)}>VACUUM</button>
              </div>
              <button className="ssh-panel__btn ssh-panel__btn--text" onClick={() => setConfirmAnalyze(true)}>ANALYZE</button>
              <button className="ssh-panel__btn ssh-panel__btn--text" onClick={() => setConfirmOptimize(true)}>PRAGMA optimize</button>
            </div>
          </div>
        </div>
      )}

      {/* 完整性 tab */}
      {tab === '完整性' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 14px' }} onClick={() => loadIntegrity(false)}>完整性检查</button>
            <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '4px 14px' }} onClick={() => loadIntegrity(true)}>快速检查</button>
          </div>
          {integrity && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                {integrity.ok
                  ? <><CheckCircle2 size={16} style={{ color: 'var(--success)' }} /><span style={{ color: 'var(--success)', fontWeight: 600 }}>数据库完整性正常</span></>
                  : <><XCircle size={16} style={{ color: 'var(--error)' }} /><span style={{ color: 'var(--error)', fontWeight: 600 }}>发现 {integrity.issues.length} 个问题</span></>
                }
              </div>
              {!integrity.ok && (
                <div style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 6, padding: 10 }}>
                  {integrity.issues.map((s, i) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--error)', marginBottom: 2, fontFamily: 'var(--font-mono)' }}>{s}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!integrity && !loading && (
            <div className="panel-empty">点击上方按钮开始检查</div>
          )}
        </div>
      )}

      {/* 空间 tab */}
      {tab === '空间' && space && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          <div className="redis-stat-grid" style={{ marginBottom: 14 }}>
            <div className="redis-stat-card">
              <div className="redis-stat-value">{fmtBytes(space.totalBytes)}</div>
              <div className="redis-stat-label">总大小</div>
            </div>
            <div className="redis-stat-card" style={{ color: space.fragmentationPct > 20 ? '#dc2626' : undefined }}>
              <div className="redis-stat-value">{space.fragmentationPct.toFixed(1)}%</div>
              <div className="redis-stat-label">碎片率</div>
              <div className="redis-stat-sub">{fmtBytes(space.freeBytes)} 可回收</div>
            </div>
            <div className="redis-stat-card">
              <div className="redis-stat-value">{space.pageCount.toLocaleString()}</div>
              <div className="redis-stat-label">总页数</div>
              <div className="redis-stat-sub">页大小 {space.pageSize}B</div>
            </div>
          </div>
          {space.fragmentationPct > 20 && (
            <div className="redis-error" style={{ marginBottom: 10 }}>
              <AlertTriangle size={12} style={{ display: 'inline', marginRight: 4 }} />
              碎片率超过 20%，建议执行 VACUUM 回收空间
            </div>
          )}
          {space.tables.length > 0 && (
            <table className="redis-hash-table">
              <thead><tr><th>表名</th><th style={{ width: 80 }}>页数</th><th style={{ width: 100 }}>估计大小</th></tr></thead>
              <tbody>
                {space.tables.map(t => (
                  <tr key={t.name}>
                    <td className="redis-hash-field">{t.name}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{t.pages.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{fmtBytes(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* WAL tab */}
      {tab === 'WAL' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          {wal && (
            <table className="redis-hash-table" style={{ marginBottom: 14 }}>
              <tbody>
                <tr><td className="redis-hash-field">日志模式</td><td>{wal.journalMode}</td></tr>
                <tr><td className="redis-hash-field">WAL 文件大小</td><td>{fmtBytes(wal.walFileBytes)}</td></tr>
                <tr><td className="redis-hash-field">SHM 文件大小</td><td>{fmtBytes(wal.shmFileBytes)}</td></tr>
              </tbody>
            </table>
          )}

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>WAL Checkpoint</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              {['PASSIVE', 'FULL', 'TRUNCATE', 'RESTART'].map(m => (
                <button key={m} className={`redis-str-tab${checkpointMode === m ? ' active' : ''}`}
                  onClick={() => setCheckpointMode(m)}>{m}</button>
              ))}
              <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '3px 12px' }} onClick={doCheckpoint}>执行</button>
            </div>
            {chkpointResult && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                结果: busy={chkpointResult.busy}, log={chkpointResult.logFrames}, checkpointed={chkpointResult.checkpointedFrames}
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>切换日志模式（需重新打开连接）</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {['WAL', 'DELETE', 'TRUNCATE', 'MEMORY', 'OFF'].map(m => (
                <button key={m} className={`redis-str-tab${jounalMode === m ? ' active' : ''}`}
                  onClick={() => setJournalMode(m)}>{m}</button>
              ))}
              <button className="cdlg-btn" style={{ padding: '3px 12px', background: 'var(--warning)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}
                onClick={() => setConfirmJournal(true)}>切换</button>
            </div>
          </div>
        </div>
      )}

      {/* PRAGMA tab */}
      {tab === 'PRAGMA' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table className="redis-hash-table">
            <thead>
              <tr><th style={{ width: 60 }}>分组</th><th>PRAGMA</th><th>当前值</th><th style={{ width: 40 }}></th></tr>
            </thead>
            <tbody>
              {pragmas.map(p => (
                <tr key={p.name}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{p.group}</td>
                  <td className="redis-hash-field">{p.name}</td>
                  <td className="redis-hash-value">
                    {editPragma?.name === p.name ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input autoFocus value={editPragma.val}
                          onChange={e => setEditPragma({ name: p.name, val: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') setConfirmPragma(true); if (e.key === 'Escape') setEditPragma(null) }}
                          style={{ width: 80, fontSize: 12 }} />
                        <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 6px', fontSize: 11 }}
                          onClick={() => setConfirmPragma(true)}>✓</button>
                      </div>
                    ) : (
                      <span>{p.value}</span>
                    )}
                  </td>
                  <td>
                    {p.writable && editPragma?.name !== p.name && (
                      <button className="cmd-act-btn" title="修改" onClick={() => setEditPragma({ name: p.name, val: p.value })}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === '锁诊断' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {loading && <div style={{ color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={12} className="spin" />诊断中…</div>}
          {!loading && lockDiagnosis && (
            <>
              <div style={{ marginBottom: 10, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12, color: 'var(--text)' }}>
                {lockDiagnosis.summary || '暂无异常'}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>持锁进程</div>
              {lockDiagnosis.processes.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>未检测到其他进程持锁</div>
                : (
                  <table className="redis-hash-table" style={{ marginBottom: 12 }}>
                    <thead><tr>
                      <th>PID</th><th>进程名</th><th>用户</th><th>文件描述符</th><th>锁类型</th>
                    </tr></thead>
                    <tbody>
                      {lockDiagnosis.processes.map((p, i) => (
                        <tr key={i}>
                          <td><code>{p.pid}</code></td>
                          <td>{p.command}</td>
                          <td>{p.user}</td>
                          <td>{p.fd}</td>
                          <td><span style={{ color: p.lockType.includes('WRITE') ? '#dc2626' : 'var(--text)' }}>{p.lockType}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              {lockDiagnosis.walCheckpoint && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>WAL Checkpoint (PASSIVE)</div>
                  <table className="redis-hash-table">
                    <tbody>
                      <tr><td className="redis-hash-field">busy readers</td><td>
                        <span style={{ color: lockDiagnosis.walCheckpoint.busy > 0 ? '#ea580c' : '#16a34a' }}>
                          {lockDiagnosis.walCheckpoint.busy}
                        </span>
                      </td></tr>
                      <tr><td className="redis-hash-field">WAL 总帧数</td><td>{lockDiagnosis.walCheckpoint.logFrames}</td></tr>
                      <tr><td className="redis-hash-field">已检查点帧数</td><td>{lockDiagnosis.walCheckpoint.checkpointedFrames}</td></tr>
                      <tr><td className="redis-hash-field">WAL 文件大小</td><td>{fmtBytes(lockDiagnosis.walFileBytes)}</td></tr>
                    </tbody>
                  </table>
                </>
              )}
              <div style={{ marginTop: 12, padding: '8px 10px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                <b style={{ color: 'var(--text)' }}>诊断说明：</b><br />
                • SQLITE_BUSY = 另一个连接正在写入（等待对方释放写锁）<br />
                • SQLITE_LOCKED = 同一连接内部冲突（嵌套事务或错误使用）<br />
                • WAL busy readers {'>'} 0 = 读事务阻止了检查点推进，-wal 文件持续增长<br />
                • 建议：让持锁进程正常退出，或在安全时执行 PRAGMA wal_checkpoint(FULL)
              </div>
            </>
          )}
        </div>
      )}

      {tab === '索引顾问' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>输入 SQL 语句，顾问将分析执行计划并给出建索引建议</div>
            <textarea
              value={advisorSql}
              onChange={e => setAdvisorSql(e.target.value)}
              placeholder="SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC"
              style={{ width: '100%', height: 80, resize: 'vertical', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text)', boxSizing: 'border-box' }}
              onKeyDown={e => { if ((e.key === 'r' || e.key === 'R') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runAdvisor() } }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 14px' }}
                onClick={runAdvisor} disabled={advisorLoading || !advisorSql.trim()}>
                {advisorLoading ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />分析中…</> : '分析索引'}
              </button>
            </div>
          </div>
          {advisorErr && <div className="redis-error" style={{ marginBottom: 8 }}>{advisorErr}</div>}
          {advisorResult && (
            <>
              {advisorResult.scanNodes.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>执行计划扫描节点</div>
                  {advisorResult.scanNodes.map((n, i) => (
                    <div key={i} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px', marginBottom: 3, color: n.includes('SCAN') ? '#ea580c' : 'var(--text)' }}>
                      {n.includes('SCAN') && <AlertTriangle size={10} style={{ display: 'inline', marginRight: 4 }} />}
                      {n}
                    </div>
                  ))}
                </div>
              )}

              {advisorResult.suggestions.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>建索引建议</div>
                  {advisorResult.suggestions.map((s, i) => (
                    <div key={i} style={{ background: 'rgba(234,88,12,0.05)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 4 }}>
                        <AlertTriangle size={11} style={{ display: 'inline', marginRight: 4 }} />
                        {s.reason}
                      </div>
                      <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '4px 8px', borderRadius: 4, overflowX: 'auto' }}>{s.createSql}</pre>
                    </div>
                  ))}
                </div>
              )}

              {advisorResult.suggestions.length === 0 && advisorResult.scanNodes.filter(n => n.includes('SCAN')).length === 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(22,163,74,0.2)', borderRadius: 6, color: 'var(--success)', fontSize: 12 }}>
                  <CheckCircle2 size={14} />
                  未检测到全表扫描，当前查询已有索引覆盖
                </div>
              )}

              {advisorResult.redundantIndexes.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>冗余索引（可删除）</div>
                  <table className="redis-hash-table">
                    <thead><tr><th>索引名</th><th>表</th><th>被哪个覆盖</th><th>DROP SQL</th></tr></thead>
                    <tbody>
                      {advisorResult.redundantIndexes.map((r, i) => (
                        <tr key={i}>
                          <td className="redis-hash-field">{r.name}</td>
                          <td>{r.table}</td>
                          <td style={{ color: 'var(--accent)' }}>{r.coveredBy}</td>
                          <td><code style={{ fontSize: 11 }}>{r.dropSql}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {!advisorResult && !advisorLoading && (
            <div className="panel-empty">输入 SQL 后点击"分析索引"</div>
          )}
        </div>
      )}

      {tab === '备份' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {restoreMsg && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 12px', background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.25)', borderRadius: 6, marginBottom: 10, fontSize: 12, color: 'var(--success)' }}>
              <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ whiteSpace: 'pre-wrap' }}>{restoreMsg}</span>
            </div>
          )}
          {backupErr && <div className="redis-error" style={{ marginBottom: 8 }}>{backupErr}</div>}

          <div style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>新建备份 (VACUUM INTO)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input value={backupDir} onChange={e => setBackupDir(e.target.value)} placeholder="备份目录（留空 = 源文件同目录的 backups/）"
                style={{ fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }} />
              <input value={backupNote} onChange={e => setBackupNote(e.target.value)} placeholder="备注（可选）"
                style={{ fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }} />
              <div>
                <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 16px' }}
                  onClick={doBackup} disabled={backupBusy}>
                  {backupBusy ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />备份中…</> : '立即备份'}
                </button>
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>备份历史</div>
            {backupList.length === 0 ? (
              <div className="panel-empty">暂无备份记录</div>
            ) : (
              <table className="redis-hash-table">
                <thead><tr><th>时间</th><th>大小</th><th>路径</th><th>备注</th><th style={{ width: 60 }}></th></tr></thead>
                <tbody>
                  {backupList.map((r, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{new Date(r.createdAt * 1000).toLocaleString('zh-CN')}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtBytes(r.sizeBytes)}</td>
                      <td style={{ fontSize: 11, fontFamily: 'var(--font-mono)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.path}>{r.path}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.note || '—'}</td>
                      <td>
                        <button className="cdlg-btn" style={{ padding: '2px 8px', fontSize: 11, background: 'var(--warning)', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer' }}
                          onClick={() => setConfirmRestore(r)} disabled={backupBusy}>
                          恢复
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>SQL Dump（兼容 sqlite3 .dump 格式）</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input value={dumpOutPath} onChange={e => setDumpOutPath(e.target.value)} placeholder="输出文件完整路径，如 /tmp/mydb.sql"
                style={{ flex: 1, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }} />
              <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 14px', whiteSpace: 'nowrap' }}
                onClick={doDump} disabled={backupBusy || !dumpOutPath.trim()}>
                {backupBusy ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />导出中…</> : '导出'}
              </button>
            </div>
            {/* S4.6 脱敏规则 */}
            <details style={{ fontSize: 11, marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', userSelect: 'none' }}>
                脱敏规则 ({maskingRules.length} 条) — 导出时对指定列应用
              </summary>
              <div style={{ marginTop: 6, padding: '8px', background: 'var(--surface-2)', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
                {maskingRules.length > 0 && (
                  <table className="redis-hash-table" style={{ marginBottom: 6 }}>
                    <thead><tr><th>表</th><th>列</th><th>规则</th><th style={{ width: 30 }}></th></tr></thead>
                    <tbody>
                      {maskingRules.map((r, i) => (
                        <tr key={i}>
                          <td>{r.table}</td><td>{r.column}</td>
                          <td style={{ fontSize: 11 }}>{r.rule}</td>
                          <td><button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171' }} onClick={() => setMaskingRules(prev => prev.filter((_, j) => j !== i))}><XCircle size={12} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <select value={maskingEditRow.table}
                    onChange={e => setMaskingEditRow(p => ({ ...p, table: e.target.value, column: '' }))}
                    style={{ width: 100, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 6px', color: 'var(--text)', cursor: 'pointer' }}>
                    <option value="">— 选择表 —</option>
                    {maskTableList.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={maskingEditRow.column}
                    onChange={e => setMaskingEditRow(p => ({ ...p, column: e.target.value }))}
                    style={{ width: 100, fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 6px', color: 'var(--text)', cursor: 'pointer' }}>
                    <option value="">— 选择列 —</option>
                    {maskColList.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <SearchableSelect value={maskingEditRow.rule} onChange={v => setMaskingEditRow(p => ({ ...p, rule: v }))}
                    options={['mask', 'null', 'hash', 'phone', 'email']} width={110} />
                  <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 10px', fontSize: 11 }}
                    onClick={() => {
                      if (!maskingEditRow.table || !maskingEditRow.column) return
                      setMaskingRules(prev => [...prev, { ...maskingEditRow }])
                      setMaskingEditRow(p => ({ ...p, table: '', column: '' }))
                    }}>+ 添加</button>
                </div>
              </div>
            </details>
            {dumpResult && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} />
                已导出 {dumpResult.tableCount} 张表、{dumpResult.rowCount.toLocaleString()} 行 → {fmtBytes(dumpResult.sizeBytes)}
              </div>
            )}
          </div>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--error)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={12} /> 损坏库抢救（只读源库，逐表导出到新 SQL 文件）
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={rescuePath} onChange={e => setRescuePath(e.target.value)} placeholder="输出 SQL 文件完整路径，如 /tmp/rescued.sql"
                style={{ flex: 1, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)' }} />
              <button className="cdlg-btn" style={{ padding: '4px 14px', whiteSpace: 'nowrap', background: 'var(--warning)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12 }}
                onClick={() => setConfirmRescue(true)} disabled={backupBusy || !rescuePath.trim()}>
                开始抢救
              </button>
            </div>
            {rescueResult && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 4 }}>
                  抢救完成: {rescueResult.tablesRescued}/{rescueResult.tablesAttempted} 张表，{rescueResult.rowsRescued.toLocaleString()} 行
                </div>
                {rescueResult.errors.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--warning)' }}>
                    {rescueResult.errors.map((e, i) => <div key={i}>{e}</div>)}
                  </div>
                )}
              </div>
            )}
            {confirmRescue && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '24px 28px', minWidth: 360, maxWidth: 480 }}>
                  <div style={{ fontWeight: 700, color: 'var(--warning)', fontSize: 15, marginBottom: 10 }}>确认启动损坏库抢救？</div>
                  <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 16, lineHeight: 1.6 }}>
                    将以只读方式逐表读取源库，尽量导出数据到 SQL 文件。<br />
                    <b>绝不写入源文件。</b>无法读取的表会跳过并记录错误。
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setConfirmRescue(false)}>取消</button>
                    <button className="cdlg-btn" style={{ background: 'var(--warning)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600 }}
                      onClick={doRescue} disabled={backupBusy}>
                      {backupBusy ? '抢救中…' : '确认'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {confirmRestore && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '24px 28px', minWidth: 380, maxWidth: 500 }}>
                <div style={{ fontWeight: 700, color: 'var(--error)', fontSize: 15, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={16} /> 危险操作：从备份恢复
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 16, lineHeight: 1.6 }}>
                  将从以下备份恢复数据库：<br />
                  <code style={{ fontSize: 11, background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 4, display: 'block', marginTop: 6, wordBreak: 'break-all' }}>{confirmRestore.path}</code>
                  <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.18)', borderRadius: 6, fontSize: 12 }}>
                    操作流程：原库改名留底（.bak）→ 清除 WAL/SHM → 复制备份就位
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setConfirmRestore(null)}>取消</button>
                  <button className="cdlg-btn" style={{ background: 'var(--error)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600 }}
                    onClick={() => doRestore(confirmRestore)} disabled={backupBusy}>
                    {backupBusy ? '执行中…' : '确认恢复'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === '容量趋势' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{capacitySnapshots.length} 个快照（每小时最多一个）</span>
            <button className="ssh-panel__btn ssh-panel__btn--text" style={{ color: 'var(--error)' }} onClick={() => clearCapacity(connectionId)}>清空</button>
          </div>
          {capacitySnapshots.length < 2 ? (
            <div className="panel-empty">
              需要至少 2 个快照才能显示趋势。打开此面板时自动记录（每小时一次）。
              {capacitySnapshots.length === 1 && <div style={{ marginTop: 8, fontSize: 11 }}>已有 1 个快照：{fmtBytes(capacitySnapshots[0].fileSizeBytes)} @ {new Date(capacitySnapshots[0].at).toLocaleString('zh-CN')}</div>}
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>文件大小趋势</div>
                <table className="redis-hash-table">
                  <thead><tr><th>时间</th><th>文件大小</th><th>变化</th></tr></thead>
                  <tbody>
                    {capacitySnapshots.map((snap, i) => {
                      const prev = capacitySnapshots[i - 1]
                      const delta = prev ? snap.fileSizeBytes - prev.fileSizeBytes : 0
                      return (
                        <tr key={i}>
                          <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(snap.at).toLocaleString('zh-CN')}</td>
                          <td>{fmtBytes(snap.fileSizeBytes)}</td>
                          <td style={{ fontSize: 11, color: delta > 0 ? '#ea580c' : delta < 0 ? '#16a34a' : 'var(--text-muted)' }}>
                            {i === 0 ? '—' : `${delta >= 0 ? '+' : ''}${fmtBytes(delta)}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {(() => {
                const lastSnap = capacitySnapshots[capacitySnapshots.length - 1]
                if (!lastSnap?.tableRows?.length) return null
                return (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>各表行数（最新快照）</div>
                    <table className="redis-hash-table">
                      <thead><tr><th>表名</th><th style={{ width: 80 }}>行数</th></tr></thead>
                      <tbody>
                        {[...lastSnap.tableRows]
                          .sort((a: { name: string; rows: number }, b: { name: string; rows: number }) => b.rows - a.rows)
                          .map((t: { name: string; rows: number }, i: number) => (
                            <tr key={i}>
                              <td className="redis-hash-field">{t.name}</td>
                              <td style={{ textAlign: 'right', paddingRight: 8 }}>{t.rows.toLocaleString()}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      )}

      {tab === '变更历史' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{schemaHistory.length} 条 DDL 记录</span>
            <button className="ssh-panel__btn ssh-panel__btn--text" onClick={async () => {
              const script = schemaHistory.map(e => `-- ${new Date(e.at).toLocaleString('zh-CN')}  user_version: ${e.userVersionAfter}\n${e.sql};`).join('\n\n')
              await saveTextFile(script, 'schema-history.sql', 'SQL 文件', 'sql')
            }}>导出迁移脚本</button>
            <button className="ssh-panel__btn ssh-panel__btn--text" style={{ color: 'var(--error)' }} onClick={() => clearSchemaHistory(connectionId)}>清空</button>
          </div>
          {schemaHistory.length === 0 ? (
            <div className="panel-empty">暂无 DDL 变更记录（执行 CREATE/ALTER/DROP 后自动记录）</div>
          ) : (
            <table className="redis-hash-table">
              <thead><tr><th style={{ width: 120 }}>时间</th><th style={{ width: 50 }}>版本后</th><th>DDL 语句</th></tr></thead>
              <tbody>
                {schemaHistory.map((e, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString('zh-CN')}</td>
                    <td style={{ textAlign: 'center', fontSize: 11 }}>{e.userVersionAfter}</td>
                    <td style={{ fontSize: 11, fontFamily: 'var(--font-mono)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.sql}>{e.sql}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === '慢查询' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              慢查询阈值
              <input type="number" min={1} max={30000} value={slowThresholdMs}
                onChange={e => setSlowThresholdMs(Number(e.target.value))}
                style={{ width: 70, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px', color: 'var(--text)' }} />
              ms
            </label>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              Top
              <input type="number" min={1} max={100} value={slowTopN}
                onChange={e => setSlowTopN(Number(e.target.value))}
                style={{ width: 50, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 6px', color: 'var(--text)' }} />
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>共 {slowQueries.length} 个聚合指纹</span>
          </div>
          {slowQueries.length === 0 ? (
            <div className="panel-empty">暂无超过 {slowThresholdMs}ms 的查询记录</div>
          ) : (
            <table className="redis-hash-table">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>最大耗时</th>
                  <th style={{ width: 55 }}>平均耗时</th>
                  <th style={{ width: 40 }}>次数</th>
                  <th>SQL 指纹</th>
                  <th style={{ width: 85 }}>最后执行</th>
                </tr>
              </thead>
              <tbody>
                {slowQueries.map((q, i) => (
                  <tr key={i}>
                    <td style={{ color: q.maxMs > 3000 ? '#dc2626' : q.maxMs > 1000 ? '#ea580c' : 'var(--text)', fontWeight: 600 }}>{q.maxMs.toLocaleString()}ms</td>
                    <td style={{ color: 'var(--text-muted)' }}>{Math.round(q.totalMs / q.count).toLocaleString()}ms</td>
                    <td>{q.count}</td>
                    <td style={{ fontSize: 11, fontFamily: 'var(--font-mono)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.sql}>{q.sql}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(q.lastAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === '数据字典' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 14px' }}
              onClick={loadDict} disabled={dictLoading}>
              {dictLoading ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />加载中…</> : '生成字典'}
            </button>
            {dictData && <button className="ssh-panel__btn ssh-panel__btn--text" onClick={exportDictMarkdown}>导出 Markdown</button>}
          </div>
          {dictErr && <div className="redis-error" style={{ marginBottom: 8 }}>{dictErr}</div>}
          {dictData && (
            <div>
              {dictData.map(t => (
                <div key={t.name} style={{ marginBottom: 8, border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                  <button
                    style={{ width: '100%', textAlign: 'left', background: 'var(--surface-2)', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                    onClick={() => setDictExpanded(e => e === t.name ? null : t.name)}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.rowCount.toLocaleString()} 行 · {t.columns.length} 列</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11 }}>{dictExpanded === t.name ? '▲' : '▼'}</span>
                  </button>
                  {dictExpanded === t.name && (
                    <div style={{ padding: '8px 12px' }}>
                      <table className="redis-hash-table" style={{ marginBottom: 8 }}>
                        <thead><tr><th>列名</th><th>类型</th><th style={{ width: 60 }}>NOT NULL</th><th>默认值</th><th style={{ width: 40 }}>PK</th></tr></thead>
                        <tbody>
                          {t.columns.map((c, i) => (
                            <tr key={i}>
                              <td className="redis-hash-field">{c.name}</td>
                              <td style={{ fontSize: 11 }}>{c.dataType}</td>
                              <td style={{ textAlign: 'center' }}>{c.notNull ? '✓' : ''}</td>
                              <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.defaultValue ?? ''}</td>
                              <td style={{ textAlign: 'center', color: c.pk ? 'var(--accent)' : undefined }}>{c.pk ? 'PK' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {t.indexes.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                          <b>索引: </b>{t.indexes.map(i => `${i.name}(${i.columns.join(',')})`).join(' | ')}
                        </div>
                      )}
                      {t.foreignKeys.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                          <b>外键: </b>{t.foreignKeys.map(fk => `${fk.fromCol}→${fk.toTable}.${fk.toCol}`).join(' | ')}
                        </div>
                      )}
                      {t.triggers.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          <b>触发器: </b>{t.triggers.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {!dictData && !dictLoading && <div className="panel-empty">点击"生成字典"加载</div>}
        </div>
      )}

      {tab === '健康报告' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 16px' }}
              onClick={runHealthReport} disabled={healthLoading}>
              {healthLoading ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />巡检中…</> : '开始健康巡检'}
            </button>
            {healthReport && (
              <button className="ssh-panel__btn ssh-panel__btn--text" onClick={async () => {
                await saveTextFile(healthReport.markdown, 'sqlite-health-report.md', 'Markdown 文件', 'md')
              }}>导出 Markdown</button>
            )}
          </div>
          {healthErr && <div className="redis-error" style={{ marginBottom: 8 }}>{healthErr}</div>}
          {healthReport && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, padding: '12px 16px', background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color:
                  healthReport.score >= 90 ? '#16a34a' : healthReport.score >= 70 ? '#ea580c' : '#dc2626' }}>
                  {healthReport.score}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>综合健康分</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>/100</div>
                </div>
              </div>
              <table className="redis-hash-table">
                <thead><tr><th style={{ width: 70 }}>类别</th><th>检查项</th><th style={{ width: 50 }}>状态</th><th>详情</th></tr></thead>
                <tbody>
                  {healthReport.checks.map((c, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.category}</td>
                      <td className="redis-hash-field">{c.item}</td>
                      <td>
                        {c.status === 'ok' ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} /> :
                         c.status === 'warn' ? <AlertTriangle size={13} style={{ color: 'var(--warning)' }} /> :
                         <XCircle size={13} style={{ color: 'var(--error)' }} />}
                      </td>
                      <td style={{ fontSize: 12, color: c.status === 'error' ? '#dc2626' : c.status === 'warn' ? '#ea580c' : 'var(--text)' }}>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!healthReport && !healthLoading && <div className="panel-empty">点击"开始健康巡检"生成报告</div>}
        </div>
      )}

      {tab === '库对比' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              当前连接为左库（基准），输入右库连接 ID 进行比较（生成 INSERT/DELETE 脚本以使左库与右库一致）
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={diffRightId} onChange={e => setDiffRightId(e.target.value)} placeholder="右库连接 ID（从连接面板复制）"
                style={{ flex: 1, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }} />
              <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '4px 14px', whiteSpace: 'nowrap' }}
                onClick={runDbDiff} disabled={diffLoading || !diffRightId.trim()}>
                {diffLoading ? <><Loader2 size={11} className="spin" style={{ display: 'inline', marginRight: 4 }} />对比中…</> : '开始对比'}
              </button>
            </div>
          </div>
          {diffErr && <div className="redis-error" style={{ marginBottom: 8 }}>{diffErr}</div>}
          {diffResult && (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>
                  DDL 差异（{diffResult.ddlDiff.length} 项）
                </div>
                {diffResult.ddlDiff.length === 0
                  ? <div style={{ fontSize: 12, color: 'var(--success)' }}>DDL 完全一致</div>
                  : (
                    <table className="redis-hash-table">
                      <thead><tr><th style={{ width: 70 }}>类型</th><th>对象名</th><th style={{ width: 60 }}>操作</th></tr></thead>
                      <tbody>
                        {diffResult.ddlDiff.map((d, i) => (
                          <tr key={i}>
                            <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.objType}</td>
                            <td className="redis-hash-field">{d.name}</td>
                            <td>
                              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background:
                                d.kind === 'added' ? 'rgba(22,163,74,0.12)' :
                                d.kind === 'removed' ? 'rgba(220,38,38,0.1)' : 'rgba(234,88,12,0.1)',
                                color: d.kind === 'added' ? '#16a34a' : d.kind === 'removed' ? '#dc2626' : '#ea580c'
                              }}>{d.kind === 'added' ? '+右库新增' : d.kind === 'removed' ? '-左库删除' : '~已变更'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                    数据同步脚本（约 {diffResult.dataChanges.toLocaleString()} 行变更）
                  </span>
                  <button className="dbtool-btn dbtool-btn--ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => setDiffScriptExpanded(e => !e)}>
                    {diffScriptExpanded ? '收起' : '展开'}
                  </button>
                </div>
                {diffScriptExpanded && (
                  <pre style={{ fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {diffResult.dataScript}
                  </pre>
                )}
              </div>
            </>
          )}
          {!diffResult && !diffLoading && (
            <div className="panel-empty">输入右库连接 ID 后开始对比</div>
          )}
        </div>
      )}

      <ConfirmDialog open={confirmVacuum} title={vacuumPath.trim() ? 'VACUUM INTO 备份' : '原地 VACUUM'}
        desc={vacuumPath.trim()
          ? `确认备份数据库到 "${vacuumPath}"？VACUUM INTO 不修改源文件，无副作用。`
          : '确认执行 VACUUM？将锁定数据库并重新整理页面，大库耗时较长。'}
        okText="执行" onOk={doVacuum} onCancel={() => setConfirmVacuum(false)} />

      <ConfirmDialog open={confirmAnalyze} title="ANALYZE"
        desc="确认执行 ANALYZE？将更新查询优化器统计信息，耗时正比于表行数。"
        okText="执行" onOk={doAnalyze} onCancel={() => setConfirmAnalyze(false)} />

      <ConfirmDialog open={confirmOptimize} title="PRAGMA optimize"
        desc="确认执行 PRAGMA optimize？这是 SQLite 官方推荐的轻量日常维护命令（等同于按需 ANALYZE）。"
        okText="执行" onOk={doOptimize} onCancel={() => setConfirmOptimize(false)} />

      <ConfirmDialog open={confirmJournal} title="切换日志模式"
        desc={`确认切换日志模式为 ${jounalMode}？此操作会立即修改数据库，请确保无其他连接在使用该文件。`}
        danger okText="切换" onOk={doSetJournal} onCancel={() => setConfirmJournal(false)} />

      <ConfirmDialog open={confirmPragma} title={`修改 PRAGMA ${editPragma?.name}`}
        desc={`确认将 PRAGMA ${editPragma?.name} 设置为 "${editPragma?.val}"？部分 PRAGMA 为连接级设置，重连后恢复默认值。`}
        okText="应用" onOk={savePragma} onCancel={() => { setConfirmPragma(false); setEditPragma(null) }} />
    </div>
  )
}
