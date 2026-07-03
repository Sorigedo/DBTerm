// OB2–OB3 — OceanBase 分布式运维面板（Zone拓扑/租户/合并/SQL审计/副本健康）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Server, Database, Activity, AlertTriangle, Layers, Zap } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface ObServer {
  svrIp: string
  svrPort: number
  zone: string
  status: string
  startServiceTime: string
  cpuCapacity: string
  memCapacity: string
}

interface ObTenant {
  tenantId: number
  tenantName: string
  tenantType: string
  primaryZone: string
  status: string
  cpuUsed: string
  memUsed: string
}

interface CompactionStatus {
  frozen_scn: string
  last_scn: string
  is_error: string
  is_suspended: string
  start_time: string
  finish_time: string
  status: string
}

interface TopSql {
  sqlId: string
  elapsed: string
  executions: string
  avgElapsed: string
  scanRows: string
  userName: string
  dbName: string
  sqlText: string
}

export default function OceanBasePanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'zone' | 'tenant' | 'compact' | 'topsql'>('zone')
  const [servers, setServers] = useState<ObServer[]>([])
  const [tenants, setTenants] = useState<ObTenant[]>([])
  const [compaction, setCompaction] = useState<CompactionStatus | null>(null)
  const [topSqls, setTopSqls] = useState<TopSql[]>([])
  const [obVersion, setObVersion] = useState('')

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

  const loadZone = async () => {
    try {
      const verRes = await q(`SELECT ob_version()`)
      setObVersion(String(verRes.rows[0]?.[0] ?? ''))
    } catch {
      try { const v2 = await q(`SELECT version()`); setObVersion(String(v2.rows[0]?.[0] ?? '').slice(0, 30)) } catch { /* ignore */ }
    }

    // 容量列（cpu_capacity_max / mem_capacity）在 GV$OB_SERVERS，DBA_OB_SERVERS 无此列，需 JOIN
    const res = await q(`SELECT s.svr_ip, s.svr_port, s.zone, s.status,
        DATE_FORMAT(s.start_service_time, '%Y-%m-%d %H:%i') AS start_svc,
        g.cpu_capacity_max AS cpu_cap,
        g.mem_capacity AS mem_cap
      FROM oceanbase.DBA_OB_SERVERS s
      LEFT JOIN oceanbase.GV$OB_SERVERS g
        ON g.svr_ip = s.svr_ip AND g.svr_port = s.svr_port
      ORDER BY s.zone, s.svr_ip`)
    setServers(res.rows.map(r => ({
      svrIp:         String(r[0] ?? ''),
      svrPort:       parseInt(String(r[1] ?? '0'), 10),
      zone:          String(r[2] ?? ''),
      status:        String(r[3] ?? ''),
      startServiceTime: String(r[4] ?? ''),
      cpuCapacity:   String(r[5] ?? ''),
      memCapacity:   String(r[6] ?? ''),
    })))
  }

  const loadTenant = async () => {
    const res = await q(`SELECT t.tenant_id, t.tenant_name, t.tenant_type, t.primary_zone, t.status,
        u.max_cpu AS cpu_used,
        u.memory_size AS mem_used
      FROM oceanbase.DBA_OB_TENANTS t
      LEFT JOIN (
        SELECT tenant_id, SUM(max_cpu) AS max_cpu, SUM(memory_size) AS memory_size
        FROM oceanbase.DBA_OB_UNITS GROUP BY tenant_id
      ) u ON u.tenant_id = t.tenant_id
      ORDER BY t.tenant_id`)
    setTenants(res.rows.map(r => ({
      tenantId:   parseInt(String(r[0] ?? '0'), 10),
      tenantName: String(r[1] ?? ''),
      tenantType: String(r[2] ?? ''),
      primaryZone: String(r[3] ?? ''),
      status:     String(r[4] ?? ''),
      cpuUsed:    String(r[5] ?? '—'),
      memUsed:    String(r[6] ?? '—'),
    })))
  }

  const loadCompaction = async () => {
    const res = await q(`SELECT
        frozen_scn, last_scn,
        is_error, is_suspended,
        DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s') AS start_time,
        DATE_FORMAT(last_finish_time, '%Y-%m-%d %H:%i:%s') AS finish_time,
        status
      FROM oceanbase.DBA_OB_MAJOR_COMPACTION
      LIMIT 1`)
    if (res.rows.length > 0) {
      const r = res.rows[0]
      setCompaction({
        frozen_scn:   String(r[0] ?? ''),
        last_scn:     String(r[1] ?? ''),
        is_error:     String(r[2] ?? 'NO'),
        is_suspended: String(r[3] ?? 'NO'),
        start_time:   String(r[4] ?? ''),
        finish_time:  String(r[5] ?? '—'),
        status:       String(r[6] ?? ''),
      })
    }
  }

  const loadTopSql = async () => {
    const res = await q(`SELECT
        SQL_ID,
        round(sum(ELAPSED_TIME)/1000) || 'ms' AS total_elapsed,
        COUNT(*) AS executions,
        round(avg(ELAPSED_TIME)/1000) || 'ms' AS avg_elapsed,
        sum(ROW_CACHE_HIT) AS scan_rows,
        USER_NAME, DB_NAME,
        left(QUERY_SQL, 100) AS sql_text
      FROM oceanbase.GV$OB_SQL_AUDIT
      WHERE REQUEST_TIME > UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 30 MINUTE)) * 1000000
      GROUP BY SQL_ID, USER_NAME, DB_NAME, QUERY_SQL
      ORDER BY sum(ELAPSED_TIME) DESC
      LIMIT 20`)
    setTopSqls(res.rows.map(r => ({
      sqlId:      String(r[0] ?? ''),
      elapsed:    String(r[1] ?? ''),
      executions: String(r[2] ?? ''),
      avgElapsed: String(r[3] ?? ''),
      scanRows:   String(r[4] ?? ''),
      userName:   String(r[5] ?? ''),
      dbName:     String(r[6] ?? ''),
      sqlText:    String(r[7] ?? ''),
    })))
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      if (tab === 'zone')    await loadZone()
      if (tab === 'tenant')  await loadTenant()
      if (tab === 'compact') await loadCompaction()
      if (tab === 'topsql')  await loadTopSql()
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [tab])

  const TABS = [
    { key: 'zone'    as const, label: 'Zone/节点', icon: <Server size={12} /> },
    { key: 'tenant'  as const, label: '租户资源', icon: <Layers size={12} /> },
    { key: 'compact' as const, label: '合并状态', icon: <Activity size={12} /> },
    { key: 'topsql'  as const, label: 'TopSQL', icon: <Zap size={12} /> },
  ]

  const stateColor = (s: string) => s === 'ACTIVE' || s === 'ONLINE' ? '#16a34a' : s === 'INACTIVE' || s === 'OFFLINE' ? '#dc2626' : '#ea580c'

  const inner = (
    <>
        {/* Tabs（嵌入模式把刷新并进本行右侧，省去模态头部）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: embedded ? '0 12px' : '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
            }}>{t.icon}{t.label}</button>
          ))}
          {embedded && obVersion && (
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface)', borderRadius: 4, padding: '1px 6px' }}>{obVersion}</span>
          )}
          {embedded && (
            <button onClick={load} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>

            {/* Zone/Server */}
            {tab === 'zone' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：oceanbase.DBA_OB_SERVERS · {servers.length} 个节点</div>
                {servers.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                    无数据（需要 SYS 租户或 DBA_OB_SERVERS 访问权限）
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['OBServer', 'Zone', '状态', '启动时间', 'CPU', '内存'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {servers.map((s, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{s.svrIp}:{s.svrPort}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text)' }}>{s.zone}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: stateColor(s.status), background: `${stateColor(s.status)}18`, borderRadius: 4, padding: '1px 5px' }}>{s.status}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{s.startServiceTime}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.cpuCapacity}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.memCapacity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Tenant */}
            {tab === 'tenant' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：DBA_OB_TENANTS + DBA_OB_UNITS · {tenants.length} 个租户</div>
                {tenants.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无数据（需要 SYS 租户权限）</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['租户 ID', '租户名', '类型', 'Primary Zone', '状态', 'CPU 配额', '内存配额'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tenants.map((t, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{t.tenantId}</td>
                            <td style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--text-bright)' }}>{t.tenantName}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: t.tenantType === 'MYSQL' ? '#16a34a' : '#ea580c', background: t.tenantType === 'MYSQL' ? 'rgba(22,163,74,0.1)' : 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '1px 5px' }}>{t.tenantType}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{t.primaryZone}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: stateColor(t.status), background: `${stateColor(t.status)}18`, borderRadius: 4, padding: '1px 5px' }}>{t.status}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.cpuUsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.memUsed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Compaction */}
            {tab === 'compact' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {compaction ? (
                  <>
                    {(compaction.is_error === 'YES' || compaction.is_suspended === 'YES') && (
                      <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
                        <AlertTriangle size={13} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                        <div style={{ fontSize: 12, color: 'var(--error)' }}>
                          <b>合并异常！</b>
                          {compaction.is_error === 'YES' && ' 合并报错（is_error=YES）。'}
                          {compaction.is_suspended === 'YES' && ' 合并被暂停（is_suspended=YES）。'}
                          请检查 OBServer 日志定位原因。
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                      {[
                        { label: '合并状态', value: compaction.status },
                        { label: '是否报错', value: compaction.is_error },
                        { label: '是否暂停', value: compaction.is_suspended },
                        { label: '开始时间', value: compaction.start_time },
                        { label: '完成时间', value: compaction.finish_time },
                        { label: 'Frozen SCN', value: compaction.frozen_scn },
                      ].map(c => (
                        <div key={c.label} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 14px', border: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 5 }}>{c.label}</div>
                          <div style={{
                            fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)',
                            color: (c.label.includes('报错') || c.label.includes('暂停')) && c.value === 'YES' ? '#dc2626' : 'var(--text-bright)',
                          }}>{c.value || '—'}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                      <b>合并说明：</b>OceanBase 每日进行 Major Compaction（合并），将 MemTable（增量数据）写入 SSTable（基线数据）。
                      合并期间 CPU/IO 消耗增加，<b>MemStore 写满触发转储（Minor Compaction）</b> 是写入停止的经典原因。
                      手动触发合并（高危）：<code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>ALTER SYSTEM MAJOR FREEZE;</code>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                    无合并状态数据（需要 SYS 租户或 oceanbase.DBA_OB_MAJOR_COMPACTION 访问权限）
                  </div>
                )}
              </div>
            )}

            {/* TopSQL */}
            {tab === 'topsql' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：GV$OB_SQL_AUDIT · 近 30 分钟 TopSQL（按总耗时降序）</div>
                {topSqls.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                    无数据（需要 GV$OB_SQL_AUDIT 访问权限，或近 30 分钟无查询）
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['用户', '库', '总耗时', '均耗时', '执行次数', 'SQL（截断）'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {topSqls.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', color: 'var(--text-bright)' }}>{r.userName}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{r.dbName}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{r.elapsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.avgElapsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.executions}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={r.sqlText}>{r.sqlText}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入子tab行）
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
        style={{ width: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>OceanBase 分布式运维</span>
          {obVersion && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>{obVersion}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={load} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
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
