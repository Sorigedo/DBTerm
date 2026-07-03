// DuckDB 管理面板（DD0.4/DD3.1/DD4.2/DD4.3/DD8.1/DD8.2/DD8.4/DD8.6）
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import {
  X, Loader2, RefreshCw, Database, Puzzle,
  CheckCircle2, XCircle, AlertCircle, Settings, BarChart2, Globe, Clock, GitBranch, TrendingUp,
} from 'lucide-react'
import DuckProfilePanel from './DuckProfilePanel'
import DuckBackupPanel from './DuckBackupPanel'
import SearchableSelect from './SearchableSelect'
import { useQueryHistoryStore } from '../../stores/queryHistoryStore'
import { useSchemaHistoryStore } from '../../stores/schemaHistoryStore'
import { useCapacityStore } from '../../stores/capacityStore'

interface Props { connectionId: string; onClose?: () => void }

interface ConnInfo {
  version: string
  filePath: string
  fileSizeBytes: number
  extensions: { name: string; loaded: string; installed: string }[]
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
}

type Tab = 'info' | 'ext' | 'config' | 'summarize' | 'remote' | 'profile' | 'maint' | 'backup' | 'attach' | 'slow' | 'schema' | 'capacity'

interface AttachedDb { name: string; path: string; dbType: string }

interface HealthCheckItem { key: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string }

interface HealthReport {
  canConnect: boolean; version: string; filePath: string; fileSizeBytes: number
  extensionCount: number; loadedCount: number; accessMode: string; walSize: string
  issues: string[]; score: number; checkItems: HealthCheckItem[]
}

interface SecretInfo { name: string; type: string; scope: string }

function fmtSize(bytes: number) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return bytes > 0 ? `${bytes} B` : '—'
}

const KNOWN_EXTS = [
  'parquet', 'json', 'httpfs', 'spatial', 'fts',
  'postgres_scanner', 'mysql_scanner', 'sqlite_scanner',
  'excel', 'iceberg', 'delta', 'icu', 'aws', 'azure',
]

export default function DuckDbAdminPanel({ connectionId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('info')
  const [info, setInfo] = useState<ConnInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extFilter, setExtFilter] = useState<'all' | 'loaded' | 'installed'>('all')
  const [extAction, setExtAction] = useState<{ name: string; type: 'install' | 'load' } | null>(null)
  const [extActLoading, setExtActLoading] = useState(false)
  const [extActError, setExtActError] = useState<string | null>(null)
  // DD3.2 仓库配置
  const [repoUrl, setRepoUrl] = useState('')
  const [repoSetting, setRepoSetting] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoSuccess, setRepoSuccess] = useState(false)
  const [pragmas, setPragmas] = useState<Record<string, string> | null>(null)
  const [pragmaLoading, setPragmaLoading] = useState(false)
  // DD4.4 PRAGMA 编辑状态
  const [editPragma, setEditPragma] = useState<{ key: string; value: string } | null>(null)
  const [editPragmaValue, setEditPragmaValue] = useState('')
  const [settingPragma, setSettingPragma] = useState(false)
  const [setPragmaError, setSetPragmaError] = useState<string | null>(null)
  const [summarizeTable, setSummarizeTable] = useState('')
  const [summarizeResult, setSummarizeResult] = useState<QueryResult | null>(null)
  const [summarizeLoading, setSummarizeLoading] = useState(false)
  const [summarizeError, setSummarizeError] = useState<string | null>(null)
  const [tables, setTables] = useState<string[]>([])
  // DD2.4 remote/S3 状态
  const [secrets, setSecrets] = useState<SecretInfo[]>([])
  const [secretsLoading, setSecretsLoading] = useState(false)
  const [s3Name, setS3Name] = useState('my_s3')
  const [s3KeyId, setS3KeyId] = useState('')
  const [s3Secret, setS3Secret] = useState('')
  const [s3Region, setS3Region] = useState('us-east-1')
  const [s3Endpoint, setS3Endpoint] = useState('')
  const [creatingSecret, setCreatingSecret] = useState(false)
  const [createSecretError, setCreateSecretError] = useState<string | null>(null)
  const [confirmCreateSecret, setConfirmCreateSecret] = useState(false)
  // DD6 维护状态
  const [checkpointForce, setCheckpointForce] = useState(false)
  const [checkpointRunning, setCheckpointRunning] = useState(false)
  const [checkpointResult, setCheckpointResult] = useState<string | null>(null)
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [confirmCheckpoint, setConfirmCheckpoint] = useState(false)
  const [vacuumTable, setVacuumTable] = useState('')
  const [vacuumRunning, setVacuumRunning] = useState(false)
  const [vacuumResult, setVacuumResult] = useState<string | null>(null)
  const [vacuumError, setVacuumError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState<string | null>(null)
  // DD5.1 ATTACH 状态
  const [attachedDbs, setAttachedDbs] = useState<AttachedDb[]>([])
  const [attachLoading, setAttachLoading] = useState(false)
  const [attachAlias, setAttachAlias] = useState('')
  const [attachType, setAttachType] = useState<'duckdb' | 'sqlite' | 'postgres' | 'mysql'>('sqlite')
  const [attachConnStr, setAttachConnStr] = useState('')
  const [attachReadOnly, setAttachReadOnly] = useState(true)
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [attachSuccess, setAttachSuccess] = useState(false)

  // DD8.2 慢查询
  const [slowThresholdMs, setSlowThresholdMs] = useState(1000)
  const allHistory = useQueryHistoryStore(s => s.entries)
  const slowQueries = useMemo(() => {
    return allHistory
      .filter(e => e.connId === connectionId && (e.executionTimeMs ?? 0) >= slowThresholdMs)
      .sort((a, b) => (b.executionTimeMs ?? 0) - (a.executionTimeMs ?? 0))
      .slice(0, 100)
  }, [allHistory, connectionId, slowThresholdMs])

  // DD8.4 schema变更历史
  const schemaHistory = useSchemaHistoryStore(s => s.entries.filter(e => e.connId === connectionId))
  const clearSchemaHistory = useSchemaHistoryStore(s => s.clear)

  // DD8.6 容量趋势
  const { addSnapshot } = useCapacityStore()
  const capacitySnapshots = useCapacityStore(s => s.snapshots.filter(x => x.connId === connectionId).sort((a, b) => a.at - b.at))

  const loadInfo = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await invoke<ConnInfo>('duckdb_conn_info', { id: connectionId })
      setInfo(r)
      // DD8.6 取容量快照
      if (r.filePath !== ':memory:') {
        try {
          const tableRows: { name: string; rows: number }[] = []
          addSnapshot({ connId: connectionId, at: Date.now(), fileSizeBytes: r.fileSizeBytes, tableRows })
        } catch { /* non-critical */ }
      }
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, addSnapshot])

  const loadPragmas = useCallback(async () => {
    setPragmaLoading(true)
    try {
      const r = await invoke<Record<string, string>>('duckdb_pragmas', { id: connectionId })
      setPragmas(r)
    } catch { /* ignore, show stale */ }
    finally { setPragmaLoading(false) }
  }, [connectionId])

  const loadTables = useCallback(async () => {
    try {
      const r = await invoke<string[]>('duckdb_list_schemas', { id: connectionId })
      const schema = r[0] || 'memory'
      const rows = await invoke<{ name: string; isView: boolean }[]>('duckdb_list_tables', { id: connectionId, schema })
      setTables(rows.filter(t => !t.isView).map(t => t.name))
    } catch { /* ignore */ }
  }, [connectionId])

  const doSummarize = useCallback(async () => {
    if (!summarizeTable.trim()) return
    setSummarizeLoading(true); setSummarizeError(null); setSummarizeResult(null)
    try {
      const r = await invoke<QueryResult>('duckdb_summarize', { id: connectionId, tableName: summarizeTable.trim() })
      setSummarizeResult(r)
    } catch (e) { setSummarizeError(String(e)) }
    finally { setSummarizeLoading(false) }
  }, [connectionId, summarizeTable])

  const loadAttachedDbs = useCallback(async () => {
    setAttachLoading(true)
    try {
      const r = await invoke<AttachedDb[]>('duckdb_list_databases', { id: connectionId })
      setAttachedDbs(r)
    } catch { setAttachedDbs([]) }
    finally { setAttachLoading(false) }
  }, [connectionId])

  const doAttach = useCallback(async () => {
    setAttaching(true); setAttachError(null); setAttachSuccess(false)
    try {
      await invoke('duckdb_attach', {
        id: connectionId, alias: attachAlias, dbType: attachType,
        connStr: attachConnStr, readOnly: attachReadOnly,
      })
      setAttachSuccess(true); setAttachAlias(''); setAttachConnStr('')
      await loadAttachedDbs()
    } catch (e) { setAttachError(String(e)) }
    finally { setAttaching(false) }
  }, [connectionId, attachAlias, attachType, attachConnStr, attachReadOnly, loadAttachedDbs])

  const doDetach = useCallback(async (alias: string) => {
    try {
      await invoke('duckdb_detach', { id: connectionId, alias })
      await loadAttachedDbs()
    } catch { /* ignore */ }
  }, [connectionId, loadAttachedDbs])

  const doCheckpoint = useCallback(async () => {
    setCheckpointRunning(true); setCheckpointResult(null); setCheckpointError(null)
    try {
      const r = await invoke<string>('duckdb_checkpoint', { id: connectionId, force: checkpointForce })
      setCheckpointResult(r); setConfirmCheckpoint(false)
    } catch (e) { setCheckpointError(String(e)) }
    finally { setCheckpointRunning(false) }
  }, [connectionId, checkpointForce])

  const doVacuum = useCallback(async () => {
    setVacuumRunning(true); setVacuumResult(null); setVacuumError(null)
    try {
      const r = await invoke<string>('duckdb_vacuum', { id: connectionId, tableName: vacuumTable })
      setVacuumResult(r)
    } catch (e) { setVacuumError(String(e)) }
    finally { setVacuumRunning(false) }
  }, [connectionId, vacuumTable])

  const doHealthCheck = useCallback(async () => {
    setHealthLoading(true); setHealthError(null); setHealth(null)
    try {
      const r = await invoke<HealthReport>('duckdb_health_check', { id: connectionId })
      setHealth(r)
    } catch (e) { setHealthError(String(e)) }
    finally { setHealthLoading(false) }
  }, [connectionId])

  const doSetExtRepo = useCallback(async (url: string) => {
    setRepoSetting(true); setRepoError(null); setRepoSuccess(false)
    try {
      await invoke('duckdb_set_ext_repo', { id: connectionId, url })
      setRepoSuccess(true)
      setTimeout(() => setRepoSuccess(false), 2000)
    } catch (e) { setRepoError(String(e)) }
    finally { setRepoSetting(false) }
  }, [connectionId])

  const doSetPragma = useCallback(async () => {
    if (!editPragma) return
    setSettingPragma(true); setSetPragmaError(null)
    try {
      await invoke('duckdb_set_pragma', { id: connectionId, key: editPragma.key, value: editPragmaValue })
      setEditPragma(null)
      await loadPragmas()
    } catch (e) { setSetPragmaError(String(e)) }
    finally { setSettingPragma(false) }
  }, [connectionId, editPragma, editPragmaValue, loadPragmas])

  const loadSecrets = useCallback(async () => {
    setSecretsLoading(true)
    try {
      const r = await invoke<SecretInfo[]>('duckdb_list_secrets', { id: connectionId })
      setSecrets(r)
    } catch { setSecrets([]) }
    finally { setSecretsLoading(false) }
  }, [connectionId])

  const doCreateSecret = useCallback(async () => {
    setCreatingSecret(true); setCreateSecretError(null)
    try {
      await invoke('duckdb_create_s3_secret', {
        id: connectionId, name: s3Name, keyId: s3KeyId,
        secret: s3Secret, region: s3Region, endpoint: s3Endpoint,
      })
      setConfirmCreateSecret(false)
      await loadSecrets()
    } catch (e) { setCreateSecretError(String(e)) }
    finally { setCreatingSecret(false) }
  }, [connectionId, s3Name, s3KeyId, s3Secret, s3Region, s3Endpoint, loadSecrets])

  const doDropSecret = useCallback(async (name: string) => {
    try {
      await invoke('duckdb_drop_secret', { id: connectionId, name })
      await loadSecrets()
    } catch { /* ignore */ }
  }, [connectionId, loadSecrets])

  useEffect(() => { loadInfo() }, [loadInfo])
  useEffect(() => { if (tab === 'config') loadPragmas() }, [tab, loadPragmas])
  useEffect(() => { if (tab === 'summarize') loadTables() }, [tab, loadTables])
  useEffect(() => { if (tab === 'remote') { loadInfo(); loadSecrets() } }, [tab, loadInfo, loadSecrets])
  useEffect(() => { if (tab === 'maint') doHealthCheck() }, [tab, doHealthCheck])
  useEffect(() => { if (tab === 'attach') loadAttachedDbs() }, [tab, loadAttachedDbs])

  const filteredExt = info?.extensions.filter(e => {
    if (extFilter === 'loaded') return e.loaded === 'true'
    if (extFilter === 'installed') return e.installed === 'true'
    return true
  }) ?? []

  async function doExtAction() {
    if (!extAction) return
    setExtActLoading(true); setExtActError(null)
    try {
      if (extAction.type === 'install') {
        await invoke('duckdb_install_ext', { id: connectionId, extName: extAction.name })
      } else {
        await invoke('duckdb_load_ext', { id: connectionId, extName: extAction.name })
      }
      setExtAction(null)
      await loadInfo()
    } catch (e) { setExtActError(String(e)) }
    finally { setExtActLoading(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
      {/* 头部 */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Database size={14} style={{ color: '#FFD700', flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', flex: 1 }}>DuckDB 管理</span>
        <button onClick={tab === 'info' ? loadInfo : tab === 'config' ? loadPragmas : loadInfo}
          disabled={loading || pragmaLoading} title="刷新"
          style={{ padding: 4, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
          {(loading || pragmaLoading) ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
        </button>
        {onClose && (
          <button onClick={onClose} style={{ padding: 4, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* Tab 栏 */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 8px', background: 'var(--surface)', flexShrink: 0 }}>
        {([['info', '连接信息'], ['ext', '扩展管理'], ['config', '运行配置'], ['summarize', '列统计'], ['remote', '远程文件'], ['profile', '查询分析'], ['maint', '维护'], ['backup', '备份'], ['attach', '外部库'], ['slow', '慢查询'], ['schema', 'DDL历史'], ['capacity', '容量趋势']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 12px', border: 'none', fontSize: 12,
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'transparent', color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
            cursor: 'pointer', marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && (
          <div style={{ padding: '8px 12px', background: '#7f1d1d22', border: '1px solid #dc262640', borderRadius: 8, fontSize: 12, color: 'var(--error)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            {error}
          </div>
        )}

        {/* 连接信息 Tab */}
        {tab === 'info' && info && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[['版本', info.version || '—'], ['文件大小', fmtSize(info.fileSizeBytes)]].map(([label, value]) => (
                <div key={label} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>文件路径</div>
              <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                {info.filePath || '—'}
                {info.filePath === ':memory:' && <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>内存</span>}
              </div>
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>扩展摘要</div>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                已加载 {info.extensions.filter(e => e.loaded === 'true').length} / 已安装 {info.extensions.filter(e => e.installed === 'true').length} / 全部 {info.extensions.length}
              </div>
            </div>
          </>
        )}

        {/* 扩展管理 Tab */}
        {tab === 'ext' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Puzzle size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>扩展 ({info?.extensions.length ?? 0})</span>
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {(['all', 'loaded', 'installed'] as const).map(f => (
                  <button key={f} onClick={() => setExtFilter(f)}
                    style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 11, cursor: 'pointer', background: extFilter === f ? 'var(--accent)' : 'var(--surface-2)', color: extFilter === f ? '#fff' : 'var(--text-muted)' }}
                  >{f === 'all' ? '全部' : f === 'loaded' ? '已加载' : '已安装'}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filteredExt.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>暂无</div>
              )}
              {filteredExt.map((ext, i) => {
                const isLoaded = ext.loaded === 'true'
                const isInstalled = ext.installed === 'true'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', flex: 1 }}>{ext.name}</span>
                    <span title="已安装">{isInstalled ? <CheckCircle2 size={12} style={{ color: 'var(--success)' }} /> : <XCircle size={12} style={{ color: 'var(--border)' }} />}</span>
                    <span title="已加载">{isLoaded ? <CheckCircle2 size={12} style={{ color: 'var(--accent)' }} /> : <XCircle size={12} style={{ color: 'var(--border)' }} />}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {!isInstalled && (
                        <button onClick={() => { setExtAction({ name: ext.name, type: 'install' }); setExtActError(null) }}
                          style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer' }}>INSTALL</button>
                      )}
                      {isInstalled && !isLoaded && (
                        <button onClick={() => { setExtAction({ name: ext.name, type: 'load' }); setExtActError(null) }}
                          style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid var(--accent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)', color: 'var(--accent)', fontSize: 10, cursor: 'pointer' }}>LOAD</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 常用扩展快捷安装 */}
            {info && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>常用扩展（点击快速操作）</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {KNOWN_EXTS.filter(n => !info.extensions.some(e => e.name === n && e.installed === 'true')).map(name => (
                    <button key={name} onClick={() => { setExtAction({ name, type: 'install' }); setExtActError(null) }}
                      style={{ padding: '3px 10px', borderRadius: 4, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}
                    >{name}</button>
                  ))}
                  {KNOWN_EXTS.every(n => info.extensions.some(e => e.name === n && e.installed === 'true')) && (
                    <span style={{ fontSize: 11, color: 'var(--success)' }}>常用扩展均已安装 ✓</span>
                  )}
                </div>
              </div>
            )}

            {/* DD3.2 仓库配置 */}
            <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-bright)' }}>扩展仓库配置（DD3.2）</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                默认使用官方仓库。可指定 community 或自定义仓库 URL（<code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>SET custom_extension_repository</code>）。
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  placeholder="https://extensions.duckdb.org/v1.0/..."
                  style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                />
                <button onClick={() => doSetExtRepo(repoUrl)} disabled={repoSetting || !repoUrl.trim()}
                  style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, cursor: (repoSetting || !repoUrl.trim()) ? 'not-allowed' : 'pointer', opacity: !repoUrl.trim() ? 0.5 : 1 }}>
                  {repoSetting ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : '设置'}
                </button>
                <button onClick={() => doSetExtRepo('default')} disabled={repoSetting}
                  style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 11, cursor: repoSetting ? 'not-allowed' : 'pointer' }}>
                  重置
                </button>
              </div>
              {repoError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{repoError}</div>}
              {repoSuccess && <div style={{ fontSize: 11, color: 'var(--success)' }}>仓库已更新 ✓</div>}
              <div style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 11, color: 'var(--warning)' }}>
                ⚠ 非官方仓库的扩展未经签名校验，可执行任意代码，请仅使用可信来源。
              </div>
            </div>
          </>
        )}

        {/* 运行配置 + PRAGMA 浏览器 Tab（DD4.2 / DD4.4）*/}
        {tab === 'config' && (() => {
          const PRAGMA_GROUPS: { label: string; keys: { key: string; desc: string; writable?: boolean }[] }[] = [
            {
              label: '性能',
              keys: [
                { key: 'threads', desc: '并行线程数（0 = 自动）', writable: true },
                { key: 'memory_limit', desc: '最大内存用量，如 "4GB"', writable: true },
                { key: 'temp_directory', desc: '溢写临时目录路径', writable: true },
                { key: 'checkpoint_threshold', desc: 'WAL 达到此大小时自动 CHECKPOINT', writable: true },
                { key: 'preserve_insertion_order', desc: '保留插入行顺序（关闭可提速）', writable: true },
              ],
            },
            {
              label: '访问控制',
              keys: [
                { key: 'access_mode', desc: '访问模式（read_only / read_write）' },
              ],
            },
            {
              label: '调试 / UI',
              keys: [
                { key: 'enable_progress_bar', desc: '是否显示查询进度条', writable: true },
                { key: 'max_expression_depth', desc: '表达式最大嵌套深度', writable: true },
              ],
            },
            {
              label: '存储诊断',
              keys: [
                { key: 'database_size', desc: '库总大小（含 WAL）' },
              ],
            },
          ]
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Settings size={13} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>PRAGMA / 运行配置</span>
                {pragmaLoading && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />}
              </div>
              {pragmas && PRAGMA_GROUPS.map(group => (
                <div key={group.label}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{group.label}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {group.keys.map(({ key, desc, writable }) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{key}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)', maxWidth: 140, textAlign: 'right', wordBreak: 'break-all' }}>
                          {pragmas[key] ?? '—'}
                        </span>
                        {writable && (
                          <button onClick={() => { setEditPragma({ key, value: pragmas[key] ?? '' }); setEditPragmaValue(pragmas[key] ?? ''); setSetPragmaError(null) }}
                            style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>
                            编辑
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-muted)' }}>
                点击"编辑"可在当前会话调整可写项（仅当前连接有效，断开后恢复默认）。access_mode 为只读时不可调整。
              </div>
            </>
          )
        })()}

        {/* 列统计 Tab（DD4.3）*/}
        {tab === 'summarize' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <BarChart2 size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>SUMMARIZE 列统计</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={summarizeTable}
                onChange={e => setSummarizeTable(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSummarize()}
                placeholder="输入表名，Enter 执行"
                list="duck-tables-list"
                style={{ flex: 1, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              />
              <datalist id="duck-tables-list">
                {tables.map(t => <option key={t} value={t} />)}
              </datalist>
              <button onClick={doSummarize} disabled={summarizeLoading || !summarizeTable.trim()}
                style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, cursor: summarizeLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                {summarizeLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                分析
              </button>
            </div>
            {summarizeError && (
              <div style={{ padding: '8px 12px', background: '#7f1d1d22', border: '1px solid #dc262640', borderRadius: 8, fontSize: 12, color: 'var(--error)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                {summarizeError}
              </div>
            )}
            {summarizeResult && (
              <div style={{ overflow: 'auto', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      {summarizeResult.columns.map(col => (
                        <th key={col} style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summarizeResult.rows.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'transparent' : 'var(--surface-2)' }}>
                        {row.map((cell, j) => (
                          <td key={j} style={{ padding: '4px 8px', color: cell == null ? 'var(--text-muted)' : 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                            {cell ?? <span style={{ opacity: 0.4 }}>NULL</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!summarizeResult && !summarizeLoading && !summarizeError && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
                输入表名后点击"分析"，DuckDB 会统计每列的 min/max/avg/null/distinct 等指标
              </div>
            )}
          </>
        )}

        {/* 维护 Tab（DD6）*/}
        {tab === 'maint' && (
          <>
            {/* DD6.3 健康检查 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>健康检查（DD6.3）</span>
              <button onClick={doHealthCheck} disabled={healthLoading}
                style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: healthLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {healthLoading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />}
                刷新
              </button>
            </div>
            {healthError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{healthError}</div>}
            {health && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* DD8.1 评分 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, border: `1px solid ${health.score >= 80 ? '#16a34a40' : health.score >= 60 ? '#ea580c40' : '#dc262640'}`, background: health.score >= 80 ? '#16a34a08' : health.score >= 60 ? '#ea580c08' : '#dc262608' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)', color: health.score >= 80 ? '#16a34a' : health.score >= 60 ? '#ea580c' : '#dc2626' }}>{health.score}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: health.score >= 80 ? '#16a34a' : health.score >= 60 ? '#ea580c' : '#dc2626' }}>{health.score >= 80 ? '状态良好' : health.score >= 60 ? '存在警告' : '需要关注'}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>满分 100 · {health.checkItems?.filter(c => c.status === 'ok').length ?? 0}/{health.checkItems?.length ?? 0} 项通过</div>
                  </div>
                  <button
                    onClick={() => {
                      const now = new Date().toLocaleString('zh-CN')
                      const lines = [
                        `# DuckDB 健康巡检报告`,
                        ``,
                        `**巡检时间**：${now}`,
                        `**评分**：${health.score}/100`,
                        `**文件**：${health.filePath}`,
                        `**版本**：${health.version}`,
                        ``,
                        `## 检查项`,
                        ``,
                        ...(health.checkItems ?? []).map(c => `- ${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'} **${c.label}**：${c.detail}`),
                        ``,
                        `## 问题汇总`,
                        ``,
                        health.issues.length > 0 ? health.issues.map(i => `- ⚠ ${i}`).join('\n') : '无问题',
                      ]
                      const md = lines.join('\n')
                      const blob = new Blob([md], { type: 'text/markdown' })
                      const a = document.createElement('a')
                      a.href = URL.createObjectURL(blob)
                      a.download = `duckdb-health-${Date.now()}.md`
                      a.click()
                      URL.revokeObjectURL(a.href)
                    }}
                    style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}
                  >导出 Markdown</button>
                </div>
                {/* 检查项列表 */}
                {(health.checkItems ?? []).map(item => (
                  <div key={item.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>
                      {item.status === 'ok' ? <CheckCircle2 size={13} style={{ color: 'var(--success)' }} /> : item.status === 'warn' ? <AlertCircle size={13} style={{ color: 'var(--warning)' }} /> : <XCircle size={13} style={{ color: 'var(--error)' }} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{item.detail}</div>
                    </div>
                  </div>
                ))}
                {health.issues.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--success)', padding: '2px 0' }}>✓ 所有检测项通过</div>
                )}
              </div>
            )}

            <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />

            {/* DD6.1 CHECKPOINT */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>CHECKPOINT（DD6.1）</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
                <input type="checkbox" checked={checkpointForce} onChange={e => setCheckpointForce(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                FORCE
              </label>
              <button onClick={() => { setConfirmCheckpoint(true); setCheckpointResult(null); setCheckpointError(null) }}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--warning)', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
                执行
              </button>
            </div>
            {checkpointResult && <div style={{ fontSize: 11, color: 'var(--success)' }}>{checkpointResult}</div>}
            {checkpointError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{checkpointError}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              CHECKPOINT 将 WAL 日志写入主数据库文件并回收空间。FORCE 强制立即执行（可能暂时阻塞写操作）。
            </div>

            <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />

            {/* DD6.2 VACUUM */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>VACUUM ANALYZE（DD6.2）</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={vacuumTable} onChange={e => setVacuumTable(e.target.value)}
                placeholder="表名（留空=全库）"
                list="duck-tables-list"
                style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
              <button onClick={doVacuum} disabled={vacuumRunning}
                style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, cursor: vacuumRunning ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                {vacuumRunning ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                执行
              </button>
            </div>
            {vacuumResult && <div style={{ fontSize: 11, color: 'var(--success)' }}>{vacuumResult}</div>}
            {vacuumError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{vacuumError}</div>}
          </>
        )}

        {/* 外部库 ATTACH Tab（DD5.1）*/}
        {tab === 'attach' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Database size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>ATTACH 外部库（DD5.1）</span>
              <button onClick={loadAttachedDbs} disabled={attachLoading}
                style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: attachLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {attachLoading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />}
              </button>
            </div>

            {/* 已挂载的库 */}
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>已挂载</div>
              {attachedDbs.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>暂无外部库（main 库不显示）</div>
              )}
              {attachedDbs.filter(d => d.name !== 'memory' && d.name !== 'main').map((db, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', flex: 1 }}>{db.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 9%, transparent)', padding: '1px 5px', borderRadius: 3 }}>{db.dbType || 'duckdb'}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={db.path}>{db.path}</span>
                  <button onClick={() => doDetach(db.name)}
                    style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid #dc262640', background: '#dc262608', color: 'var(--error)', fontSize: 10, cursor: 'pointer' }}>断开</button>
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />

            {/* ATTACH 表单 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>挂载新数据库</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 40 }}>类型</span>
                <SearchableSelect mono={false}
                  value={attachType} onChange={v => setAttachType(v as typeof attachType)}
                  items={[
                    { value: 'duckdb', label: 'DuckDB' },
                    { value: 'sqlite', label: 'SQLite' },
                    { value: 'postgres', label: 'PostgreSQL（需 postgres_scanner）' },
                    { value: 'mysql', label: 'MySQL（需 mysql_scanner）' },
                  ]} />
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 40 }}>别名</span>
                <input value={attachAlias} onChange={e => setAttachAlias(e.target.value)}
                  placeholder="my_db"
                  style={{ width: 120, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 40 }}>{attachType === 'duckdb' || attachType === 'sqlite' ? '路径' : '连接串'}</span>
                <input value={attachConnStr} onChange={e => setAttachConnStr(e.target.value)}
                  placeholder={attachType === 'postgres' ? 'host=localhost dbname=mydb user=postgres password=xxx' : attachType === 'mysql' ? 'host=localhost dbname=mydb user=root password=xxx' : '/path/to/file.db'}
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={attachReadOnly} onChange={e => setAttachReadOnly(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                  只读（推荐）
                </label>
                <button onClick={doAttach} disabled={attaching || !attachAlias.trim() || !attachConnStr.trim()}
                  style={{ marginLeft: 'auto', padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, cursor: (attaching || !attachAlias.trim() || !attachConnStr.trim()) ? 'not-allowed' : 'pointer', opacity: (!attachAlias.trim() || !attachConnStr.trim()) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 5 }}>
                  {attaching ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                  ATTACH
                </button>
              </div>
              {attachError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{attachError}</div>}
              {attachSuccess && <div style={{ fontSize: 11, color: 'var(--success)' }}>ATTACH 成功 ✓ 可在 SQL 编辑器访问 alias.schema.table</div>}
            </div>
            <div style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              ATTACH 后可跨库查询：<code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>SELECT * FROM alias.main.table_name</code><br />
              异构 ATTACH 需先安装对应 scanner 扩展（postgres_scanner / mysql_scanner / sqlite_scanner）。
            </div>
          </>
        )}

        {/* 备份 Tab（DD7）*/}
        {tab === 'backup' && (
          <div style={{ margin: -14, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <DuckBackupPanel connectionId={connectionId} />
          </div>
        )}

        {/* 查询分析 Tab（DD4.1）*/}
        {tab === 'profile' && (
          <div style={{ margin: -14, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <DuckProfilePanel connectionId={connectionId} />
          </div>
        )}

        {/* 远程文件 Tab（DD2.4）*/}
        {tab === 'remote' && (() => {
          const httpfsExt = info?.extensions.find(e => e.name === 'httpfs')
          const httpfsLoaded = httpfsExt?.loaded === 'true'
          const httpfsInstalled = httpfsExt?.installed === 'true'
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Globe size={13} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>远程文件 / S3 凭证</span>
              </div>

              {/* httpfs 状态 */}
              <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>httpfs 扩展</span>
                {httpfsLoaded
                  ? <span style={{ fontSize: 11, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} /> 已加载</span>
                  : httpfsInstalled
                    ? <button onClick={() => { setExtAction({ name: 'httpfs', type: 'load' }); setExtActError(null) }}
                        style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--accent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}>LOAD</button>
                    : <button onClick={() => { setExtAction({ name: 'httpfs', type: 'install' }); setExtActError(null) }}
                        style={{ padding: '2px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>INSTALL</button>
                }
              </div>

              {/* HTTP 直查说明 */}
              <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                httpfs 加载后可直接查询 HTTP/HTTPS/S3 文件：<br />
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>SELECT * FROM read_parquet('https://example.com/data.parquet')</code><br />
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>SELECT * FROM read_csv_auto('s3://bucket/path/data.csv')</code>
              </div>

              {/* S3 凭证管理 */}
              <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 2 }}>S3 凭证（CREATE SECRET）</div>
                {[
                  ['名称', s3Name, setS3Name, 'my_s3', false],
                  ['Key ID', s3KeyId, setS3KeyId, 'AKIA...', false],
                  ['Secret', s3Secret, setS3Secret, '••••••', true],
                  ['区域', s3Region, setS3Region, 'us-east-1', false],
                  ['Endpoint（可选）', s3Endpoint, setS3Endpoint, 's3.amazonaws.com', false],
                ].map(([label, val, setter, ph, isPwd]) => (
                  <div key={label as string} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 110 }}>{label as string}</span>
                    <input
                      type={(isPwd as boolean) ? 'password' : 'text'}
                      value={val as string}
                      onChange={e => (setter as React.Dispatch<React.SetStateAction<string>>)(e.target.value)}
                      placeholder={ph as string}
                      style={{ flex: 1, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontFamily: (isPwd as boolean) ? 'inherit' : 'var(--font-mono)' }}
                    />
                  </div>
                ))}
                {createSecretError && (
                  <div style={{ fontSize: 11, color: 'var(--error)' }}>{createSecretError}</div>
                )}
                <button onClick={() => setConfirmCreateSecret(true)}
                  disabled={!s3Name.trim() || !s3KeyId.trim() || !s3Secret.trim()}
                  style={{ alignSelf: 'flex-end', padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, cursor: (!s3Name.trim() || !s3KeyId.trim() || !s3Secret.trim()) ? 'not-allowed' : 'pointer', opacity: (!s3Name.trim() || !s3KeyId.trim() || !s3Secret.trim()) ? 0.5 : 1 }}>
                  创建 / 替换
                </button>
              </div>

              {/* 现有 secrets */}
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  当前会话 Secrets
                  {secretsLoading && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
                </div>
                {secrets.length === 0 && !secretsLoading && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>暂无（httpfs 凭证仅在当前连接会话内有效）</div>
                )}
                {secrets.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', marginBottom: 4 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', flex: 1 }}>{s.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 9%, transparent)', padding: '1px 5px', borderRadius: 3 }}>{s.type}</span>
                    {s.scope && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.scope}</span>}
                    <button onClick={() => doDropSecret(s.name)}
                      style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid #dc262640', background: '#dc262608', color: 'var(--error)', fontSize: 10, cursor: 'pointer' }}>删除</button>
                  </div>
                ))}
              </div>
            </>
          )
        })()}
      </div>

      {/* 扩展操作确认弹窗（DD3.1 安全确认）*/}
      {confirmCheckpoint && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 400, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>{checkpointForce ? 'FORCE CHECKPOINT' : 'CHECKPOINT'}</div>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              将执行 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{checkpointForce ? 'FORCE CHECKPOINT' : 'CHECKPOINT'}</code>，把 WAL 写入主库文件。
            </div>
            {checkpointForce && (
              <div style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 11, color: 'var(--warning)' }}>
                ⚠ FORCE CHECKPOINT 会等待所有活跃查询结束，可能造成短暂阻塞。
              </div>
            )}
            {checkpointError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{checkpointError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmCheckpoint(false)}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doCheckpoint} disabled={checkpointRunning}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--warning)', color: '#fff', cursor: checkpointRunning ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {checkpointRunning ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认执行
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editPragma && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 380, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>编辑 {editPragma.key}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>当前值：<code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{editPragma.value || '—'}</code></div>
            <input
              autoFocus
              value={editPragmaValue}
              onChange={e => setEditPragmaValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') doSetPragma() }}
              placeholder="新值（如 4GB / 8 / true）"
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
            />
            <div style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 11, color: 'var(--warning)' }}>
              ⚠ 仅当前会话有效。threads/memory_limit 修改会影响所有正在运行的查询。
            </div>
            {setPragmaError && <div style={{ fontSize: 11, color: 'var(--error)' }}>{setPragmaError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setEditPragma(null); setSetPragmaError(null) }}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doSetPragma} disabled={settingPragma || !editPragmaValue.trim()}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: (settingPragma || !editPragmaValue.trim()) ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: (!editPragmaValue.trim()) ? 0.5 : 1 }}>
                {settingPragma ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认设置
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {confirmCreateSecret && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 400, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>确认创建 S3 Secret</div>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              将为 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{s3Name}</code> 创建 S3 凭证。
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 12, color: 'var(--warning)' }}>
              ⚠ Secret 仅在当前连接会话内有效，不会持久化到磁盘。请勿在共享环境中使用高权限凭证。
            </div>
            {createSecretError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{createSecretError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setConfirmCreateSecret(false); setCreateSecretError(null) }}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doCreateSecret} disabled={creatingSecret}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: creatingSecret ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {creatingSecret ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认创建
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {extAction && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 420, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>
              {extAction.type === 'install' ? 'INSTALL' : 'LOAD'} 扩展
            </div>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              即将执行：<code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{extAction.type.toUpperCase()} {extAction.name}</code>
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ea580c40', background: '#ea580c08', fontSize: 12, color: 'var(--warning)' }}>
              ⚠ 扩展可执行任意代码，请仅安装来自 DuckDB 官方仓库的受信扩展。
            </div>
            {extActError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{extActError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setExtAction(null); setExtActError(null) }}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doExtAction} disabled={extActLoading}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--warning)', color: '#fff', cursor: extActLoading ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {extActLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认执行
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* DD8.2 慢查询 Tab */}
      {tab === 'slow' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>慢查询记录（DD8.2）</span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>阈值</span>
              <SearchableSelect width={110} mono={false}
                value={String(slowThresholdMs)} onChange={v => setSlowThresholdMs(Number(v))}
                items={[
                  { value: '500', label: '500ms' },
                  { value: '1000', label: '1s' },
                  { value: '3000', label: '3s' },
                  { value: '5000', label: '5s' },
                  { value: '10000', label: '10s' },
                ]} />
            </div>
          </div>
          {slowQueries.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              暂无超过 {slowThresholdMs >= 1000 ? `${slowThresholdMs / 1000}s` : `${slowThresholdMs}ms`} 的慢查询记录
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {slowQueries.map(q => (
                <div key={q.id} style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: (q.executionTimeMs ?? 0) > 5000 ? '#dc2626' : (q.executionTimeMs ?? 0) > 2000 ? '#ea580c' : '#f59e0b', fontFamily: 'var(--font-mono)' }}>
                      {(q.executionTimeMs ?? 0) >= 1000 ? `${((q.executionTimeMs ?? 0) / 1000).toFixed(2)}s` : `${q.executionTimeMs}ms`}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(q.at).toLocaleString('zh-CN')}</span>
                    {q.rowsAffected !== undefined && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{q.rowsAffected} 行</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', lineHeight: 1.5, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
                    {q.sql}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* DD8.4 DDL 变更历史 Tab */}
      {tab === 'schema' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GitBranch size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>DDL 变更历史（DD8.4）</span>
            {schemaHistory.length > 0 && (
              <button onClick={() => clearSchemaHistory(connectionId)}
                style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, border: '1px solid #dc262640', background: '#dc262608', color: 'var(--error)', fontSize: 11, cursor: 'pointer' }}>
                清除
              </button>
            )}
          </div>
          {schemaHistory.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              暂无 DDL 变更记录。执行 CREATE / ALTER / DROP 语句后自动记录。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[...schemaHistory].reverse().map(e => (
                <div key={e.id} style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{new Date(e.at).toLocaleString('zh-CN')}</div>
                  <pre style={{ margin: 0, fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 80, overflow: 'hidden' }}>
                    {e.sql}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* DD8.6 容量趋势 Tab */}
      {tab === 'capacity' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>容量趋势（DD8.6）</span>
            {capacitySnapshots.length > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                {capacitySnapshots.length} 个快照（每次打开面板记录一次）
              </span>
            )}
          </div>
          {capacitySnapshots.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              暂无容量快照。每次打开连接面板时自动记录文件大小。
            </div>
          ) : (
            <>
              <div style={{ overflow: 'auto', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      {['时间', '文件大小', '变化'].map(col => (
                        <th key={col} style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...capacitySnapshots].reverse().map((snap, i, arr) => {
                      const prev = arr[i + 1]
                      const delta = prev ? snap.fileSizeBytes - prev.fileSizeBytes : null
                      return (
                        <tr key={snap.at} style={{ borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'transparent' : 'var(--surface-2)' }}>
                          <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{new Date(snap.at).toLocaleString('zh-CN')}</td>
                          <td style={{ padding: '4px 8px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{fmtSize(snap.fileSizeBytes)}</td>
                          <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)', color: delta === null ? 'var(--text-muted)' : delta > 0 ? '#ea580c' : delta < 0 ? '#16a34a' : 'var(--text-muted)' }}>
                            {delta === null ? '—' : delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${fmtSize(Math.abs(delta))}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                快照在每次打开 DuckDB 管理面板时自动采集，保留最近 60 条。容量增长提示可能需要 CHECKPOINT + 碎片清理。
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
