// R4 Redis 监控面板（R4.1 INFO仪表盘 + R4.2 CLIENT LIST + R4.3 慢日志 + R4.5 CONFIG）
import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props { connectionId: string; db: number }

interface RedisInfoStats {
  version: string
  uptimeSecs: number
  connectedClients: number
  usedMemoryBytes: number
  maxMemoryBytes: number
  memFragRatio: number
  keyspaceHits: number
  keyspaceMisses: number
  totalCommandsProcessed: number
  instantaneousOpsPerSec: number
  evictedKeys: number
  expiredKeys: number
  rdbLastBgsaveStatus: string
  aofEnabled: boolean
  aofLastWriteStatus: string
  role: string
  connectedSlaves: number
  masterReplOffset: number
  // These come from the Rust struct field names (camelCase)
  maxMemoryHuman?: string
  maxMemoryPolicy?: string
  blockedClients?: number
}

interface ClientInfo {
  id: string
  addr: string
  name: string
  age: number
  idle: number
  flags: string
  db: number
  cmd: string
  omem: number
}

interface SlowlogEntry {
  id: number
  timestamp: number
  durationUs: number
  command: string
}

type ConfigEntry = [string, string]

function fmtBytes(b: number) {
  if (b === 0) return '0'
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分${s % 60}秒`
}

function StatCard({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="redis-stat-card" style={{ color: warn ? '#dc2626' : undefined }}>
      <div className="redis-stat-value">{value}</div>
      <div className="redis-stat-label">{label}</div>
      {sub && <div className="redis-stat-sub">{sub}</div>}
    </div>
  )
}

const TABS = ['概览', '客户端', '慢日志', '配置', '延迟', '内存', '热冷key', '复制'] as const
type Tab = typeof TABS[number]

interface LatencyEvent { event: string; latestTs: number; latestMs: number; maxMs: number }
interface MemoryPrefix { prefix: string; count: number; totalBytes: number; avgBytes: number; noTtlCount: number }
interface MemoryAnalysis {
  byPrefix: MemoryPrefix[]
  memoryStats: [string, string][]
  ttlDistribution: [string, number][]
  noTtlTotal: number
  scanned: number
}
interface KeyTempInfo { key: string; kind: string; freqOrIdle: number }
interface ReplicaInfo { ip: string; port: number; state: string; offset: number; lag: number; lagReadable: string }
interface ReplicationInfo {
  role: string; connectedSlaves: number; masterReplOffset: number; replBacklogSize: number
  masterHost: string; masterPort: number; masterLinkStatus: string; masterLastIoSeconds: number
  replicas: ReplicaInfo[]
}

export default function InfoDashboard({ connectionId, db }: Props) {
  const [tab,        setTab]        = useState<Tab>('概览')
  const [stats,      setStats]      = useState<RedisInfoStats | null>(null)
  const [clients,    setClients]    = useState<ClientInfo[]>([])
  const [slowlog,    setSlowlog]    = useState<SlowlogEntry[]>([])
  // R4.3 慢日志本地持久化：live=实时 SLOWLOG，history=本地累计快照
  const [slowView,   setSlowView]   = useState<'live' | 'history'>('live')
  const [slowHistory,setSlowHistory]= useState<SlowlogEntry[]>([])
  const [slowMsg,    setSlowMsg]    = useState('')
  const [configs,    setConfigs]    = useState<ConfigEntry[]>([])
  const [latency,    setLatency]    = useState<LatencyEvent[]>([])
  const [latencyDoc, setLatencyDoc] = useState('')
  const [memAnalysis,setMemAnalysis]= useState<MemoryAnalysis | null>(null)
  const [hotKeys,    setHotKeys]    = useState<KeyTempInfo[]>([])
  const [coldKeys,   setColdKeys]   = useState<KeyTempInfo[]>([])
  const [replInfo,   setReplInfo]   = useState<ReplicationInfo | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [autoRefresh,setAutoRefresh]= useState(false)
  const [confirmKill,setConfirmKill]= useState<string | null>(null)
  const [confirmSlowReset, setConfirmSlowReset] = useState(false)
  const [confirmBgsave,    setConfirmBgsave]    = useState(false)
  const [confirmBgrewrite, setConfirmBgrewrite] = useState(false)
  // 配置行内编辑
  const [editCfgKey, setEditCfgKey] = useState<string | null>(null)
  const [editCfgVal, setEditCfgVal] = useState('')
  const [confirmCfg, setConfirmCfg] = useState<{ key: string; value: string } | null>(null)
  const [cfgBusy,    setCfgBusy]    = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const saveCfg = async () => {
    if (!confirmCfg) return
    setCfgBusy(true)
    try {
      await invoke('redis_config_set', { id: connectionId, key: confirmCfg.key, value: confirmCfg.value, db })
      setConfirmCfg(null); setEditCfgKey(null)
      loadConfigs()
    } catch (e) { setError(String(e)) }
    finally { setCfgBusy(false) }
  }

  const loadStats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const s = await invoke<RedisInfoStats>('redis_info_stats', { id: connectionId, db })
      setStats(s)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadClients = useCallback(async () => {
    setLoading(true)
    try {
      const c = await invoke<ClientInfo[]>('redis_client_list', { id: connectionId, db })
      setClients(c)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadSlowlog = useCallback(async () => {
    setLoading(true)
    try {
      const s = await invoke<SlowlogEntry[]>('redis_slowlog_get', { id: connectionId, count: 128 })
      setSlowlog(s)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  // R4.3 读取本地持久化历史
  const loadSlowHistory = useCallback(async () => {
    setLoading(true)
    try {
      const h = await invoke<SlowlogEntry[]>('redis_slowlog_history', { id: connectionId })
      setSlowHistory(h)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId])

  // R4.3 把当前 SLOWLOG 快照并入本地历史（按 id 去重累积）
  const snapshotSlowlog = useCallback(async () => {
    setLoading(true); setSlowMsg('')
    try {
      const r = await invoke<{ fetched: number; added: number; total: number }>(
        'redis_slowlog_snapshot', { id: connectionId, count: 128 })
      setSlowMsg(`快照完成：读取 ${r.fetched} 条，新增 ${r.added} 条，本地累计 ${r.total} 条`)
      if (slowView === 'history') await loadSlowHistory()
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, slowView, loadSlowHistory])

  const clearSlowHistory = useCallback(async () => {
    try {
      await invoke('redis_slowlog_history_clear', { id: connectionId })
      setSlowHistory([]); setSlowMsg('本地历史已清空')
    } catch (e) { setError(String(e)) }
  }, [connectionId])

  const loadConfigs = useCallback(async () => {
    setLoading(true)
    try {
      const c = await invoke<ConfigEntry[]>('redis_config_get', { id: connectionId, pattern: '*', db })
      setConfigs(c)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadLatency = useCallback(async () => {
    setLoading(true)
    try {
      const [ev, doc] = await Promise.all([
        invoke<LatencyEvent[]>('redis_latency_latest', { id: connectionId, db }),
        invoke<string>('redis_latency_doctor', { id: connectionId, db }).catch(() => '（LATENCY DOCTOR 不可用）'),
      ])
      setLatency(ev)
      setLatencyDoc(doc)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadMemory = useCallback(async () => {
    setLoading(true)
    try {
      const m = await invoke<MemoryAnalysis>('redis_memory_analysis', { id: connectionId, db, maxKeys: 5000 })
      setMemAnalysis(m)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadHotCold = useCallback(async () => {
    setLoading(true)
    try {
      const [hot, cold] = await Promise.all([
        invoke<KeyTempInfo[]>('redis_hotkey_scan', { id: connectionId, db, topN: 20 }).catch(() => []),
        invoke<KeyTempInfo[]>('redis_coldkey_scan', { id: connectionId, db, topN: 20, minIdleSecs: 3600 }).catch(() => []),
      ])
      setHotKeys(hot)
      setColdKeys(cold)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  const loadRepl = useCallback(async () => {
    setLoading(true)
    try {
      const r = await invoke<ReplicationInfo>('redis_replication_info', { id: connectionId, db })
      setReplInfo(r)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, db])

  useEffect(() => {
    if (tab === '概览') loadStats()
    else if (tab === '客户端') loadClients()
    else if (tab === '慢日志') loadSlowlog()
    else if (tab === '配置') loadConfigs()
    else if (tab === '延迟') loadLatency()
    else if (tab === '内存') loadMemory()
    else if (tab === '热冷key') loadHotCold()
    else if (tab === '复制') loadRepl()
  }, [tab, loadStats, loadClients, loadSlowlog, loadConfigs, loadLatency, loadMemory, loadHotCold, loadRepl])

  useEffect(() => {
    if (autoRefresh && tab === '概览') {
      timerRef.current = setInterval(loadStats, 3000)
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [autoRefresh, tab, loadStats])

  const killClient = async (clientId: string) => {
    try {
      await invoke('redis_client_kill', { id: connectionId, clientId, db })
      setClients(prev => prev.filter(c => c.id !== clientId))
    } catch (e) { setError(String(e)) }
    setConfirmKill(null)
  }

  const resetSlowlog = async () => {
    try {
      await invoke('redis_slowlog_reset', { id: connectionId })
      setSlowlog([])
    } catch (e) { setError(String(e)) }
    setConfirmSlowReset(false)
  }

  const doBgsave = async () => {
    try {
      await invoke('redis_bgsave', { id: connectionId })
    } catch (e) { setError(String(e)) }
    setConfirmBgsave(false)
    setTimeout(loadStats, 1000)
  }

  const doBgrewrite = async () => {
    try {
      await invoke('redis_bgrewriteaof', { id: connectionId })
    } catch (e) { setError(String(e)) }
    setConfirmBgrewrite(false)
  }

  const hitRate = stats
    ? stats.keyspaceHits + stats.keyspaceMisses === 0
      ? '—'
      : `${((stats.keyspaceHits / (stats.keyspaceHits + stats.keyspaceMisses)) * 100).toFixed(1)}%`
    : '—'

  const memPct = stats && stats.maxMemoryBytes > 0
    ? (stats.usedMemoryBytes / stats.maxMemoryBytes) * 100
    : null

  const memWarn = memPct !== null && memPct > 85

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tabs */}
      <div className="redis-type-toolbar" style={{ gap: 0, padding: 0 }}>
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
        {tab === '概览' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', paddingRight: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            自动刷新
          </label>
        )}
        <button
          className="ssh-panel__btn"
          title="刷新"
          onClick={() => {
            if (tab === '概览') loadStats()
            else if (tab === '客户端') loadClients()
            else if (tab === '慢日志') loadSlowlog()
            else if (tab === '配置') loadConfigs()
            else if (tab === '延迟') loadLatency()
            else if (tab === '内存') loadMemory()
            else if (tab === '热冷key') loadHotCold()
            else if (tab === '复制') loadRepl()
          }}
          style={{ marginRight: 8 }}
        >
          <RefreshCw size={12} strokeWidth={2} className={loading ? 'spin' : ''} />
        </button>
      </div>

      {error && <div className="redis-error">{error}</div>}
      {loading && !stats && tab === '概览' && (
        <div className="redis-type-loading"><Loader2 size={16} className="spin" /></div>
      )}

      {/* 概览 */}
      {tab === '概览' && stats && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {/* 内存使用 */}
          {memPct !== null && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                <span>内存使用 ({fmtBytes(stats.usedMemoryBytes)} / {fmtBytes(stats.maxMemoryBytes)})</span>
                <span style={{ color: memWarn ? '#dc2626' : 'var(--text)' }}>{memPct.toFixed(1)}%</span>
              </div>
              <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4,
                  width: `${Math.min(100, memPct)}%`,
                  background: memWarn ? '#dc2626' : 'var(--accent)',
                  transition: 'width 0.3s',
                }} />
              </div>
              {memWarn && <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 3 }}>⚠ 内存使用率超过 85%，请关注淘汰策略</div>}
            </div>
          )}

          <div className="redis-stat-grid">
            <StatCard label="版本" value={stats.version} sub={`运行 ${fmtUptime(stats.uptimeSecs)}`} />
            <StatCard label="连接客户端" value={String(stats.connectedClients)} />
            <StatCard label="命中率" value={hitRate} sub={`${stats.keyspaceHits} / ${stats.keyspaceMisses}`} />
            <StatCard label="Ops/sec" value={String(stats.instantaneousOpsPerSec)} />
            <StatCard label="内存碎片率" value={stats.memFragRatio.toFixed(2)} warn={stats.memFragRatio > 1.5} />
            <StatCard label="淘汰 keys" value={String(stats.evictedKeys)} warn={stats.evictedKeys > 0} />
            <StatCard label="过期 keys" value={String(stats.expiredKeys)} />
            <StatCard label="角色" value={stats.role} sub={stats.role === 'master' && stats.connectedSlaves > 0 ? `${stats.connectedSlaves} 从节点` : undefined} />
          </div>

          {/* 持久化状态 */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>持久化</div>
            <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
              <span>RDB: <span style={{ color: stats.rdbLastBgsaveStatus === 'ok' ? '#16a34a' : '#dc2626' }}>{stats.rdbLastBgsaveStatus}</span></span>
              <span>AOF: <span style={{ color: stats.aofLastWriteStatus === 'ok' ? '#16a34a' : stats.aofLastWriteStatus === 'off' ? 'var(--text-muted)' : '#dc2626' }}>{stats.aofLastWriteStatus}</span></span>
              <span style={{ flex: 1 }} />
              <button className="ssh-panel__btn ssh-panel__btn--text" title="手动 BGSAVE" onClick={() => setConfirmBgsave(true)}>BGSAVE</button>
              <button className="ssh-panel__btn ssh-panel__btn--text" title="手动 BGREWRITEAOF" onClick={() => setConfirmBgrewrite(true)}>BGREWRITEAOF</button>
            </div>
          </div>
        </div>
      )}

      {/* 客户端列表 */}
      {tab === '客户端' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table className="redis-hash-table">
            <thead>
              <tr>
                <th>地址</th>
                <th style={{ width: 40 }}>DB</th>
                <th style={{ width: 60 }}>空闲(s)</th>
                <th style={{ width: 70 }}>出缓冲</th>
                <th>当前命令</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {clients.map(c => (
                <tr key={c.addr}>
                  <td className="redis-hash-field" title={`${c.name ? c.name + ' ' : ''}${c.flags}`}>{c.addr}</td>
                  <td style={{ textAlign: 'center' }}>{c.db}</td>
                  <td style={{ textAlign: 'right', paddingRight: 8 }}>{c.idle}</td>
                  <td style={{ textAlign: 'right', paddingRight: 8, color: c.omem > 0 ? '#ea580c' : undefined }}>
                    {c.omem > 0 ? fmtBytes(c.omem) : '0'}
                  </td>
                  <td className="redis-hash-value"><span className="redis-hash-val-text">{c.cmd || '—'}</span></td>
                  <td>
                    <button className="cmd-act-btn danger" title="KILL 此客户端" onClick={() => setConfirmKill(c.id)}>
                      <Trash2 size={11} strokeWidth={2} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clients.length === 0 && !loading && (
            <div className="panel-empty">无连接信息</div>
          )}
        </div>
      )}

      {/* 慢日志 */}
      {tab === '慢日志' && (() => {
        const rows = slowView === 'history' ? slowHistory : slowlog
        return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="ssh-panel__btn ssh-panel__btn--text"
                style={{ color: slowView === 'live' ? 'var(--accent)' : 'var(--text-muted)', fontWeight: slowView === 'live' ? 600 : 400 }}
                onClick={() => { setSlowView('live'); setSlowMsg('') }}>实时</button>
              <button className="ssh-panel__btn ssh-panel__btn--text"
                style={{ color: slowView === 'history' ? 'var(--accent)' : 'var(--text-muted)', fontWeight: slowView === 'history' ? 600 : 400 }}
                onClick={() => { setSlowView('history'); setSlowMsg(''); void loadSlowHistory() }}>本地历史</button>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>{rows.length} 条{slowView === 'history' ? '（本地累计）' : '慢日志'}</span>
            <button className="ssh-panel__btn ssh-panel__btn--text" onClick={snapshotSlowlog} title="把当前 SLOWLOG 并入本地历史，按 id 去重累积，重启不丢失">快照到本地</button>
            {slowView === 'history'
              ? <button className="ssh-panel__btn ssh-panel__btn--text" onClick={clearSlowHistory}>清空本地历史</button>
              : <button className="ssh-panel__btn ssh-panel__btn--text" onClick={() => setConfirmSlowReset(true)}>清空慢日志</button>}
          </div>
          {slowMsg && <div style={{ fontSize: 11, color: 'var(--success)', padding: '4px 10px' }}>{slowMsg}</div>}
          <div style={{ flex: 1, overflow: 'auto' }}>
            <table className="redis-hash-table">
              <thead>
                <tr>
                  <th style={{ width: 50 }}>ID</th>
                  <th style={{ width: 100 }}>耗时(μs)</th>
                  <th>命令</th>
                  <th style={{ width: 140 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id}>
                    <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{s.id}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8, color: s.durationUs > 10000 ? '#dc2626' : s.durationUs > 1000 ? '#ea580c' : 'var(--text)' }}>
                      {s.durationUs.toLocaleString()}
                    </td>
                    <td className="redis-hash-value"><span className="redis-hash-val-text" style={{ fontFamily: 'var(--font-mono)' }}>{s.command}</span></td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(s.timestamp * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && !loading && (
              <div className="panel-empty">{slowView === 'history' ? '本地暂无历史，点击「快照到本地」开始累积' : '暂无慢日志'}</div>
            )}
          </div>
        </div>
        )
      })()}

      {/* 配置（可编辑，CONFIG SET 立即生效、不持久化到 redis.conf） */}
      {tab === '配置' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px 0' }}>
            点击「当前值」可修改（CONFIG SET 立即生效，重启后失效）
          </div>
          <table className="redis-hash-table">
            <thead><tr><th>配置项</th><th>当前值</th></tr></thead>
            <tbody>
              {configs.map(([k, v]) => (
                <tr key={k}>
                  <td className="redis-hash-field" title={k}>{k}</td>
                  <td className="redis-hash-value">
                    {editCfgKey === k ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          autoFocus
                          value={editCfgVal}
                          onChange={e => setEditCfgVal(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') setConfirmCfg({ key: k, value: editCfgVal })
                            if (e.key === 'Escape') setEditCfgKey(null)
                          }}
                          style={{ flex: 1, fontSize: 12 }}
                        />
                        <button className="cdlg-btn cdlg-btn--ok" style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => setConfirmCfg({ key: k, value: editCfgVal })}>✓</button>
                        <button className="cdlg-btn cdlg-btn--cancel" style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => setEditCfgKey(null)}>✕</button>
                      </div>
                    ) : (
                      <span className="redis-hash-val-text" title="点击修改" style={{ cursor: 'pointer' }}
                        onClick={() => { setEditCfgKey(k); setEditCfgVal(v) }}>{v || '（空）'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {configs.length === 0 && !loading && <div className="panel-empty">无配置信息</div>}
        </div>
      )}

      {/* 延迟诊断 R4.3 */}
      {tab === '延迟' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {latency.length === 0 && !loading && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              未检测到延迟事件。如需启用，执行：<code style={{ color: 'var(--accent)' }}>CONFIG SET latency-monitor-threshold 10</code>
            </div>
          )}
          {latency.length > 0 && (
            <table className="redis-hash-table" style={{ marginBottom: 16, maxWidth: 720 }}>
              <thead><tr><th>事件</th><th style={{ width: 100 }}>最近延迟(ms)</th><th style={{ width: 100 }}>最大延迟(ms)</th><th style={{ width: 140 }}>最近发生</th></tr></thead>
              <tbody>
                {latency.map(ev => (
                  <tr key={ev.event}>
                    <td className="redis-hash-field">{ev.event}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8, color: ev.latestMs > 100 ? '#dc2626' : ev.latestMs > 10 ? '#ea580c' : 'var(--text)' }}>{ev.latestMs}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8, color: ev.maxMs > 100 ? '#dc2626' : 'var(--text)' }}>{ev.maxMs}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(ev.latestTs * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* DOCTOR 是 Redis 的原始英文诊断；未启用监控时它返回 “I'm sorry, Dave” 彩蛋，
              此时顶部已有中文提示，故仅在确有延迟事件时才展示这段诊断，避免被当成报错 */}
          {latency.length > 0 && latencyDoc && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', fontSize: 11, color: 'var(--text)', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>
              {latencyDoc}
            </div>
          )}
        </div>
      )}

      {/* 内存分析 R4.4 */}
      {tab === '内存' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {memAnalysis ? (<>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              已扫描 {memAnalysis.scanned.toLocaleString()} 个 key，无 TTL {memAnalysis.noTtlTotal.toLocaleString()} 个
            </div>
            {/* TTL 分布 */}
            {memAnalysis.ttlDistribution.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>TTL 分布</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {memAnalysis.ttlDistribution.map(([label, n]) => (
                    <div key={label} style={{ background: 'var(--surface-2)', borderRadius: 6, padding: '6px 12px', textAlign: 'center', fontSize: 11 }}>
                      <div style={{ fontWeight: 600 }}>{n.toLocaleString()}</div>
                      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 按前缀聚合 */}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>按前缀内存占用 Top 50</div>
            <table className="redis-hash-table" style={{ maxWidth: 820 }}>
              <thead><tr><th>前缀</th><th style={{ width: 80 }}>数量</th><th style={{ width: 100 }}>总占用</th><th style={{ width: 90 }}>均值</th><th style={{ width: 80 }}>无TTL</th></tr></thead>
              <tbody>
                {memAnalysis.byPrefix.map(p => (
                  <tr key={p.prefix}>
                    <td className="redis-hash-field">{p.prefix}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{p.count.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{fmtBytes(p.totalBytes)}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8 }}>{fmtBytes(p.avgBytes)}</td>
                    <td style={{ textAlign: 'right', paddingRight: 8, color: p.noTtlCount > 0 ? '#ea580c' : undefined }}>{p.noTtlCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>) : !loading && <div className="panel-empty">点击刷新按钮开始分析（将扫描至多 5000 个 key）</div>}
        </div>
      )}

      {/* 热/冷 key R4.6 */}
      {tab === '热冷key' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>热 key（OBJECT FREQ，需 LFU 策略）</div>
              {hotKeys.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无数据（可能不是 LFU 策略）</div> : (
                <table className="redis-hash-table">
                  <thead><tr><th>Key</th><th style={{ width: 50 }}>类型</th><th style={{ width: 60 }}>FREQ</th></tr></thead>
                  <tbody>
                    {hotKeys.map(k => (
                      <tr key={k.key}>
                        <td className="redis-hash-field" title={k.key}>{k.key}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{k.kind}</td>
                        <td style={{ textAlign: 'right', paddingRight: 8, color: k.freqOrIdle > 100 ? '#dc2626' : undefined }}>{k.freqOrIdle}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>冷 key（空闲 ≥1h，OBJECT IDLETIME）</div>
              {coldKeys.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无数据</div> : (
                <table className="redis-hash-table">
                  <thead><tr><th>Key</th><th style={{ width: 50 }}>类型</th><th style={{ width: 80 }}>空闲(s)</th></tr></thead>
                  <tbody>
                    {coldKeys.map(k => (
                      <tr key={k.key}>
                        <td className="redis-hash-field" title={k.key}>{k.key}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{k.kind}</td>
                        <td style={{ textAlign: 'right', paddingRight: 8 }}>{k.freqOrIdle.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 主从复制 R4.7 */}
      {tab === '复制' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {replInfo ? (<>
            <div className="redis-stat-grid" style={{ marginBottom: 16 }}>
              <StatCard label="角色" value={replInfo.role} />
              <StatCard label="从节点数" value={String(replInfo.connectedSlaves)} />
              <StatCard label="主库偏移" value={replInfo.masterReplOffset.toLocaleString()} />
              <StatCard label="Backlog 大小" value={fmtBytes(replInfo.replBacklogSize)} />
            </div>
            {replInfo.role === 'slave' && (
              <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>主库：</span> {replInfo.masterHost}:{replInfo.masterPort}
                {'  '}
                <span style={{ color: replInfo.masterLinkStatus === 'up' ? '#16a34a' : '#dc2626' }}>
                  {replInfo.masterLinkStatus === 'up' ? '已连接' : '断连'}
                </span>
                {'  '}
                <span style={{ color: 'var(--text-muted)' }}>最后通信 {replInfo.masterLastIoSeconds}s 前</span>
              </div>
            )}
            {replInfo.replicas.length > 0 && (
              <table className="redis-hash-table">
                <thead><tr><th>从节点</th><th style={{ width: 80 }}>状态</th><th style={{ width: 120 }}>偏移</th><th style={{ width: 100 }}>落后</th></tr></thead>
                <tbody>
                  {replInfo.replicas.map(r => (
                    <tr key={`${r.ip}:${r.port}`}>
                      <td className="redis-hash-field">{r.ip}:{r.port}</td>
                      <td style={{ color: r.state === 'online' ? '#16a34a' : '#dc2626' }}>{r.state}</td>
                      <td style={{ textAlign: 'right', paddingRight: 8 }}>{r.offset.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', paddingRight: 8, color: r.lag > 1024 * 1024 ? '#dc2626' : r.lag > 0 ? '#ea580c' : undefined }}>
                        {r.lagReadable}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {replInfo.replicas.length === 0 && replInfo.role === 'master' && (
              <div className="panel-empty">当前为独立节点，无从节点</div>
            )}
          </>) : !loading && <div className="panel-empty">点击刷新按钮加载复制状态</div>}
        </div>
      )}

      <ConfirmDialog open={confirmKill !== null} title="断开客户端"
        desc={`确认 CLIENT KILL "${confirmKill}"？该连接将被强制断开。`}
        danger okText="断开"
        onOk={() => confirmKill && killClient(confirmKill)}
        onCancel={() => setConfirmKill(null)} />

      <ConfirmDialog open={confirmSlowReset} title="清空慢日志"
        desc="确认执行 SLOWLOG RESET？现有慢日志将全部清除。"
        danger okText="清空"
        onOk={resetSlowlog}
        onCancel={() => setConfirmSlowReset(false)} />

      <ConfirmDialog open={confirmCfg !== null} title="修改 Redis 配置"
        desc={confirmCfg ? `确认执行 CONFIG SET ${confirmCfg.key} "${confirmCfg.value}"？\n配置立即生效但不写入 redis.conf（重启后失效）；错误的值可能影响实例稳定。` : ''}
        danger okText={cfgBusy ? '应用中…' : '应用'}
        onOk={saveCfg}
        onCancel={() => setConfirmCfg(null)} />

      <ConfirmDialog open={confirmBgsave} title="手动 BGSAVE"
        desc="将触发后台 RDB 快照（fork 操作，内存较大时有短暂延迟）。确认执行？"
        okText="执行"
        onOk={doBgsave}
        onCancel={() => setConfirmBgsave(false)} />

      <ConfirmDialog open={confirmBgrewrite} title="手动 BGREWRITEAOF"
        desc="将触发后台 AOF 重写（可能增加磁盘 I/O）。确认执行？"
        okText="执行"
        onOk={doBgrewrite}
        onCancel={() => setConfirmBgrewrite(false)} />
    </div>
  )
}
