// PG3 — PostgreSQL 物理复制 / 复制槽 / 逻辑复制 / WAL 监控 / 同步复制
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, GitBranch, AlertTriangle, Trash2, CheckCircle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'physical' | 'slots' | 'logical' | 'wal' | 'sync'

interface SyncInfo {
  syncStandbyNames: string
  syncCommit: string
  configuredNames: string[]
  connectedApps: string[]
  syncReplicas: string[]
}

interface PhysicalReplica {
  pid: number
  appName: string
  clientAddr: string
  state: string
  sentLsn: string
  writeLsn: string
  flushLsn: string
  replayLsn: string
  writeLagMs: number
  flushLagMs: number
  replayLagMs: number
  syncState: string
}

interface ReplicationSlot {
  slotName: string
  plugin: string
  slotType: string
  database: string | null
  active: boolean
  restartLsn: string
  confirmedFlushLsn: string
  walStatus: string
  safeWalSizeMb: number | null
}

interface LogicalSub {
  subname: string
  connectionInfo: string
  slotName: string
  publications: string
  enabled: boolean
  workerCount: number
  receivedLsn: string
  latestEndLsn: string
  latestEndTime: string
}

interface WalInfo {
  name: string
  value: string
}

export default function PgReplicationPanel({ connectionId, onClose, embedded }: Props) {
  const [tab, setTab] = useState<Tab>('physical')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null)

  const [replicas, setReplicas] = useState<PhysicalReplica[]>([])
  const [slots, setSlots] = useState<ReplicationSlot[]>([])
  const [subs, setSubs] = useState<LogicalSub[]>([])
  const [walInfo, setWalInfo] = useState<WalInfo[]>([])
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null)

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const q = async (sql: string) => {
    const { invoke } = await import('@tauri-apps/api/core')
    type R = { columns: string[]; rows: (string | null)[][] }
    return invoke<R>('execute_query', { id: connectionId, sql })
  }

  const checkRole = async () => {
    try {
      const res = await q('SELECT pg_is_in_recovery()')
      setIsPrimary(res.rows[0]?.[0] === 'false' || res.rows[0]?.[0] === '0')
    } catch { setIsPrimary(null) }
  }

  const loadPhysical = async () => {
    setLoading(true); setError('')
    try {
      await checkRole()
      const res = await q(`SELECT pid, application_name,
          client_addr::text,
          state, sent_lsn::text, write_lsn::text, flush_lsn::text, replay_lsn::text,
          COALESCE(EXTRACT(milliseconds FROM write_lag), 0)::bigint,
          COALESCE(EXTRACT(milliseconds FROM flush_lag), 0)::bigint,
          COALESCE(EXTRACT(milliseconds FROM replay_lag), 0)::bigint,
          sync_state
        FROM pg_stat_replication
        ORDER BY application_name`)
      setReplicas(res.rows.map(r => ({
        pid:          Number(r[0] ?? 0),
        appName:      String(r[1] ?? ''),
        clientAddr:   String(r[2] ?? ''),
        state:        String(r[3] ?? ''),
        sentLsn:      String(r[4] ?? ''),
        writeLsn:     String(r[5] ?? ''),
        flushLsn:     String(r[6] ?? ''),
        replayLsn:    String(r[7] ?? ''),
        writeLagMs:   Number(r[8] ?? 0),
        flushLagMs:   Number(r[9] ?? 0),
        replayLagMs:  Number(r[10] ?? 0),
        syncState:    String(r[11] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadSlots = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT slot_name, plugin, slot_type,
          database, active, restart_lsn::text,
          COALESCE(confirmed_flush_lsn::text, ''),
          COALESCE(wal_status, 'unknown'),
          COALESCE(safe_wal_size::bigint / 1024 / 1024, NULL)::bigint
        FROM pg_replication_slots
        ORDER BY active DESC, slot_name`)
      setSlots(res.rows.map(r => ({
        slotName:          String(r[0] ?? ''),
        plugin:            String(r[1] ?? ''),
        slotType:          String(r[2] ?? ''),
        database:          r[3] ? String(r[3]) : null,
        active:            r[4] === 'true' || r[4] === '1' || r[4] === 't',
        restartLsn:        String(r[5] ?? ''),
        confirmedFlushLsn: String(r[6] ?? ''),
        walStatus:         String(r[7] ?? 'unknown'),
        safeWalSizeMb:     r[8] !== null ? Number(r[8]) : null,
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadLogical = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT s.subname,
          s.subconninfo,
          COALESCE(s.subslotname, ''),
          array_to_string(s.subpublications, ', '),
          s.subenabled,
          COALESCE(ss.worker_count, 0)::bigint,
          COALESCE(ss.received_lsn::text, ''),
          COALESCE(ss.latest_end_lsn::text, ''),
          COALESCE(ss.latest_end_time::text, '')
        FROM pg_subscription s
        LEFT JOIN (
          SELECT subid,
            count(*) AS worker_count,
            max(received_lsn) AS received_lsn,
            max(latest_end_lsn) AS latest_end_lsn,
            max(latest_end_time) AS latest_end_time
          FROM pg_stat_subscription
          GROUP BY subid
        ) ss ON ss.subid = s.oid
        ORDER BY s.subname`)
      setSubs(res.rows.map(r => ({
        subname:       String(r[0] ?? ''),
        connectionInfo: String(r[1] ?? ''),
        slotName:      String(r[2] ?? ''),
        publications:  String(r[3] ?? ''),
        enabled:       r[4] === 'true' || r[4] === '1' || r[4] === 't',
        workerCount:   Number(r[5] ?? 0),
        receivedLsn:   String(r[6] ?? ''),
        latestEndLsn:  String(r[7] ?? ''),
        latestEndTime: String(r[8] ?? ''),
      })))
    } catch (e) {
      const msg = String(e)
      if (msg.includes("doesn't exist") || msg.includes('does not exist')) {
        setSubs([])
      } else {
        setError(msg)
      }
    } finally { setLoading(false) }
  }

  const loadWal = async () => {
    setLoading(true); setError('')
    try {
      const currentLsn = isPrimary ? 'pg_current_wal_lsn()' : 'pg_last_wal_receive_lsn()'
      const res = await q(`SELECT 'current_wal_lsn', ${currentLsn}::text
        UNION ALL SELECT 'wal_segment_size', (pg_walfile_name_offset(${currentLsn})).offset::text
        UNION ALL SELECT 'archiver_archived_count', archived_count::text
        FROM pg_stat_archiver
        UNION ALL SELECT 'archiver_failed_count', failed_count::text
        FROM pg_stat_archiver
        UNION ALL SELECT 'last_archived_wal', last_archived_wal::text
        FROM pg_stat_archiver
        UNION ALL SELECT 'last_failed_wal', COALESCE(last_failed_wal, '—')::text
        FROM pg_stat_archiver
        UNION ALL SELECT 'checkpoint_write_time', ROUND(checkpoint_write_time / 1000.0, 1)::text || 's'
        FROM pg_stat_bgwriter
        UNION ALL SELECT 'buffers_checkpoint', buffers_checkpoint::text
        FROM pg_stat_bgwriter`)
      setWalInfo(res.rows.map(r => ({ name: String(r[0] ?? ''), value: String(r[1] ?? '') })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const dropSlot = async (name: string) => {
    if (!window.confirm(`确认删除复制槽 "${name}"？\n\n⚠ 此操作不可逆。如有订阅依赖此槽，删除后订阅将无法恢复。`)) return
    try {
      await q(`SELECT pg_drop_replication_slot('${name}')`)
      await loadSlots()
    } catch (e) { setError(String(e)) }
  }

  const loadSync = async () => {
    setLoading(true); setError('')
    try {
      const settingsRes = await q(`SELECT name, setting FROM pg_settings
        WHERE name IN ('synchronous_standby_names', 'synchronous_commit')
        ORDER BY name`)
      const settingsMap: Record<string, string> = {}
      settingsRes.rows.forEach(r => { settingsMap[String(r[0] ?? '')] = String(r[1] ?? '') })
      const syncStandbyNames = settingsMap['synchronous_standby_names'] ?? ''
      const syncCommit = settingsMap['synchronous_commit'] ?? ''

      const repRes = await q(`SELECT application_name, sync_state FROM pg_stat_replication ORDER BY application_name`)
      const connectedApps = repRes.rows.map(r => String(r[0] ?? ''))
      const syncReplicas = repRes.rows.filter(r => r[1] === 'sync').map(r => String(r[0] ?? ''))

      // Parse configured names: strip FIRST N / ANY N / QUORUM N prefixes and parens
      const rawList = syncStandbyNames.replace(/^(FIRST|ANY|QUORUM)\s+\d+\s*\(/, '').replace(/\)$/, '').trim()
      const configuredNames = rawList ? rawList.split(',').map(s => s.trim()).filter(Boolean) : []

      setSyncInfo({ syncStandbyNames, syncCommit, configuredNames, connectedApps, syncReplicas })
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadTab = () => {
    if (tab === 'physical') loadPhysical()
    else if (tab === 'slots') loadSlots()
    else if (tab === 'logical') loadLogical()
    else if (tab === 'wal') loadWal()
    else loadSync()
  }

  useEffect(() => { loadTab() }, [tab])

  const lagColor = (ms: number) => ms > 5000 ? '#dc2626' : ms > 1000 ? '#ea580c' : '#16a34a'

  const inner = (
    <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
          {([['physical', '物理复制'], ['slots', '复制槽'], ['logical', '逻辑复制'], ['wal', 'WAL 监控'], ['sync', '同步复制']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>{label}</button>
          ))}
          {embedded && isPrimary !== null && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: isPrimary ? 'var(--accent-bg)' : 'rgba(22,163,74,0.1)', color: isPrimary ? 'var(--accent)' : '#16a34a' }}>
              {isPrimary ? 'PRIMARY' : 'STANDBY'}
            </span>
          )}
          {embedded && (
            <button onClick={loadTab} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>{error}</div>}
          {loading && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}

          {!loading && tab === 'physical' && (
            replicas.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {isPrimary === false ? '此节点为备库，无复制到下游节点' : '当前无物理复制从节点'}
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['应用名', '客户端', '状态', '同步模式', '写延迟', 'Flush 延迟', '回放延迟'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {replicas.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.appName}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 10 }}>{r.clientAddr}</td>
                      <td style={{ padding: '8px 10px', color: r.state === 'streaming' ? '#16a34a' : '#ea580c', fontWeight: 600 }}>{r.state}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{r.syncState}</td>
                      <td style={{ padding: '8px 10px', color: lagColor(r.writeLagMs), fontWeight: r.writeLagMs > 1000 ? 600 : 400 }}>{r.writeLagMs > 0 ? `${r.writeLagMs}ms` : '—'}</td>
                      <td style={{ padding: '8px 10px', color: lagColor(r.flushLagMs) }}>{r.flushLagMs > 0 ? `${r.flushLagMs}ms` : '—'}</td>
                      <td style={{ padding: '8px 10px', color: lagColor(r.replayLagMs) }}>{r.replayLagMs > 0 ? `${r.replayLagMs}ms` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {!loading && tab === 'slots' && (
            <>
              {slots.some(s => !s.active) && (
                <div style={{ padding: '10px 16px', background: 'rgba(220,38,38,0.08)', borderBottom: '1px solid rgba(220,38,38,0.2)', display: 'flex', gap: 8 }}>
                  <AlertTriangle size={14} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, color: 'var(--error)' }}>存在非活跃复制槽！非活跃槽会持续堆积 WAL 文件，可能撑爆磁盘。确认不再需要后可删除（高危操作）。</span>
                </div>
              )}
              {slots.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无复制槽</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['槽名', '类型', '插件', '数据库', '状态', 'WAL 状态', 'Restart LSN', '操作'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {slots.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: !s.active ? 'rgba(220,38,38,0.04)' : '' }}>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{s.slotName}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{s.slotType}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{s.plugin || '—'}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.database || '—'}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: s.active ? '#16a34a' : '#dc2626', background: s.active ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', padding: '2px 7px', borderRadius: 4 }}>
                            {s.active ? '活跃' : '非活跃'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', color: s.walStatus === 'lost' ? '#dc2626' : s.walStatus !== 'reserved' ? '#ea580c' : 'var(--text-muted)', fontWeight: s.walStatus === 'lost' ? 600 : 400 }}>{s.walStatus}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{s.restartLsn}</td>
                        <td style={{ padding: '8px 10px' }}>
                          {!s.active && (
                            <button onClick={() => dropSlot(s.slotName)} style={{ color: 'var(--error)', padding: 4, lineHeight: 0 }} title="删除槽（高危）">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {!loading && tab === 'logical' && (
            subs.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>无逻辑订阅（或此节点不支持 pg_subscription 视图）</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['订阅名', '发布列表', '启用', 'Worker 数', '已接收 LSN', '槽名'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{s.subname}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text)', maxWidth: 200 }}>{s.publications}</td>
                      <td style={{ padding: '8px 10px', color: s.enabled ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{s.enabled ? '是' : '否'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{s.workerCount}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{s.receivedLsn || '—'}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{s.slotName || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {!loading && tab === 'wal' && (
            walInfo.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无 WAL 数据</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '40%' }}>指标</th>
                    <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>值</th>
                  </tr>
                </thead>
                <tbody>
                  {walInfo.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.name}</td>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: r.name.includes('failed') && r.value !== '0' ? '#dc2626' : 'var(--text)' }}>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* PG3.5 同步复制 */}
          {!loading && tab === 'sync' && syncInfo && (() => {
            const configuredNotConnected = syncInfo.configuredNames.filter(n => !syncInfo.connectedApps.includes(n))
            const hasRisk = syncInfo.syncStandbyNames.trim() !== '' && syncInfo.configuredNames.length > 0 && configuredNotConnected.length > 0
            return (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {hasRisk && (
                  <div style={{ padding: '10px 14px', background: 'rgba(220,38,38,0.08)', borderRadius: 8, border: '1px solid rgba(220,38,38,0.2)', display: 'flex', gap: 8 }}>
                    <AlertTriangle size={15} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--error)', fontWeight: 600 }}>同步备库缺失！</span>
                      <span style={{ color: 'var(--text)', marginLeft: 6 }}>
                        配置的同步备库 <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>{configuredNotConnected.join(', ')}</code> 未连接。
                        当 synchronous_commit=on/remote_write/remote_apply 时，写操作将<strong>无限期阻塞</strong>，直到备库连接。
                      </span>
                    </div>
                  </div>
                )}
                {syncInfo.syncStandbyNames.trim() === '' && (
                  <div style={{ padding: '8px 14px', background: 'rgba(var(--accent-rgb),0.06)', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                    synchronous_standby_names 为空，当前使用异步复制模式。
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>synchronous_standby_names</div>
                    <code style={{ fontSize: 12, color: 'var(--text-bright)', wordBreak: 'break-all', display: 'block' }}>
                      {syncInfo.syncStandbyNames || '（未配置）'}
                    </code>
                  </div>
                  <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>synchronous_commit</div>
                    <code style={{ fontSize: 12, color: syncInfo.syncCommit === 'off' ? '#ea580c' : 'var(--text-bright)' }}>
                      {syncInfo.syncCommit}
                    </code>
                    {syncInfo.syncCommit === 'off' && (
                      <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4 }}>⚠ off 模式牺牲了持久性保证，重启可能丢失最近提交</div>
                    )}
                  </div>
                </div>

                {syncInfo.configuredNames.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>配置的同步备库列表</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {syncInfo.configuredNames.map(name => {
                        const isConnected = syncInfo.connectedApps.includes(name)
                        const isSyncing = syncInfo.syncReplicas.includes(name)
                        return (
                          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 6, background: isConnected ? 'rgba(22,163,74,0.04)' : 'rgba(220,38,38,0.04)', border: `1px solid ${isConnected ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)'}` }}>
                            {isConnected
                              ? <CheckCircle size={13} color="var(--success)" />
                              : <AlertTriangle size={13} color="var(--error)" />
                            }
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-bright)', flex: 1 }}>{name}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: isConnected ? (isSyncing ? '#16a34a' : '#ea580c') : '#dc2626' }}>
                              {!isConnected ? '未连接' : isSyncing ? 'sync' : '已连接(non-sync)'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {syncInfo.connectedApps.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>当前连接备库（pg_stat_replication）</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {syncInfo.connectedApps.map(app => {
                        const isSyncing = syncInfo.syncReplicas.includes(app)
                        return (
                          <span key={app} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 12, fontFamily: 'var(--font-mono)', background: isSyncing ? 'rgba(22,163,74,0.1)' : 'var(--surface-2)', color: isSyncing ? '#16a34a' : 'var(--text-muted)', border: '1px solid var(--border)', fontWeight: isSyncing ? 600 : 400 }}>
                            {app} {isSyncing ? '(sync)' : ''}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
          {!loading && tab === 'sync' && !syncInfo && !error && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（角色徽标与刷新已并入子tab行）
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 820, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitBranch size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>PG 复制状态</span>
          {isPrimary !== null && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: isPrimary ? 'var(--accent-bg)' : 'rgba(22,163,74,0.1)', color: isPrimary ? 'var(--accent)' : '#16a34a' }}>
              {isPrimary ? 'PRIMARY' : 'STANDBY'}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={loadTab} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
