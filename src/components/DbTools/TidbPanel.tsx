// TI2–TI3 — TiDB 分布式运维面板（集群拓扑/热点/TiKV/事务GC/TiFlash/DDL Job）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Server, Activity, Database, Zap, AlertTriangle, Info, GitBranch, Radio } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface ClusterNode {
  type: string
  instance: string
  statusAddress: string
  version: string
  startTime: string
  uptime: string
  serverID: string
}

interface HotRegion {
  tableId: number
  indexId: number
  dbName: string
  tableName: string
  indexName: string
  regionId: number
  maxHotDegree: number
  regionCount: number
  flowBytes: string
  hotRegionType: string
}

interface TikvStore {
  storeId: number
  address: string
  state: string
  leaderCount: number
  regionCount: number
  capacity: string
  available: string
  usedPct: string
}

interface TxnInfo {
  safePoint: string
  gcLifeTime: string
  txnMode: string
  largeClientTx: string
}

interface DdlJob {
  jobId: number
  dbName: string
  tableName: string
  jobType: string
  state: string
  startTime: string
  elapsed: string
  progress: string
}

export default function TidbPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'cluster' | 'hotspot' | 'tikv' | 'txngc' | 'ddljob' | 'ticdc'>('cluster')
  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([])
  const [hotRegions, setHotRegions] = useState<HotRegion[]>([])
  const [tikvStores, setTikvStores] = useState<TikvStore[]>([])
  const [txnInfo, setTxnInfo] = useState<TxnInfo | null>(null)
  const [ddlJobs, setDdlJobs] = useState<DdlJob[]>([])
  const [tidbVersion, setTidbVersion] = useState('')
  // TI3 TiCDC（独立 HTTP API，需单独填地址，不随 tab 自动加载）
  const [ticdcAddr, setTicdcAddr] = useState('127.0.0.1:8300')
  const [ticdcApiVer, setTicdcApiVer] = useState('')
  const [ticdcFeeds, setTicdcFeeds] = useState<{ id: string; state: string; extra: string }[]>([])
  const [ticdcRaw, setTicdcRaw] = useState('')
  const [ticdcLoading, setTicdcLoading] = useState(false)
  const [ticdcError, setTicdcError] = useState('')

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

  const loadCluster = async () => {
    try {
      const verRes = await q(`SELECT tidb_version()`)
      const raw = String(verRes.rows[0]?.[0] ?? '')
      const m = raw.match(/Release Version: ([\d\.\-a-zA-Z]+)/)
      setTidbVersion(m?.[1] ?? raw.slice(0, 40))
    } catch { setTidbVersion('TiDB') }

    const res = await q(`SELECT TYPE, INSTANCE, STATUS_ADDRESS, VERSION,
        START_TIME, UPTIME, SERVER_ID
      FROM INFORMATION_SCHEMA.CLUSTER_INFO
      ORDER BY TYPE, INSTANCE`)
    setClusterNodes(res.rows.map(r => ({
      type:          String(r[0] ?? ''),
      instance:      String(r[1] ?? ''),
      statusAddress: String(r[2] ?? ''),
      version:       String(r[3] ?? '').slice(0, 20),
      startTime:     String(r[4] ?? '').slice(0, 19),
      uptime:        String(r[5] ?? ''),
      serverID:      String(r[6] ?? ''),
    })))
  }

  const loadHotspot = async () => {
    const res = await q(`SELECT
        TABLE_ID, INDEX_ID,
        DB_NAME, TABLE_NAME, INDEX_NAME,
        REGION_ID, MAX_HOT_DEGREE, REGION_COUNT,
        FLOW_BYTES, TYPE
      FROM INFORMATION_SCHEMA.TIDB_HOT_REGIONS
      ORDER BY MAX_HOT_DEGREE DESC
      LIMIT 30`)
    setHotRegions(res.rows.map(r => ({
      tableId:      parseInt(String(r[0] ?? '0'), 10),
      indexId:      parseInt(String(r[1] ?? '0'), 10),
      dbName:       String(r[2] ?? ''),
      tableName:    String(r[3] ?? ''),
      indexName:    String(r[4] ?? ''),
      regionId:     parseInt(String(r[5] ?? '0'), 10),
      maxHotDegree: parseInt(String(r[6] ?? '0'), 10),
      regionCount:  parseInt(String(r[7] ?? '0'), 10),
      flowBytes:    String(r[8] ?? ''),
      hotRegionType: String(r[9] ?? ''),
    })))
  }

  const loadTiKV = async () => {
    // TIKV_STORE_STATUS 的存储列只有 CAPACITY/AVAILABLE（人类可读字符串，如 "100GiB"），
    // 无 AVAILABLE_SIZE/CAPACITY_SIZE/USED 数值列，故使用率在客户端按 (容量-可用)/容量 估算。
    const res = await q(`SELECT
        STORE_ID, ADDRESS, STORE_STATE_NAME,
        LEADER_COUNT, REGION_COUNT, CAPACITY, AVAILABLE
      FROM INFORMATION_SCHEMA.TIKV_STORE_STATUS
      ORDER BY STORE_ID`)
    // CAPACITY/AVAILABLE 均为 "数值+单位" 字符串，统一解析为字节后算使用率
    const toBytes = (s: string): number => {
      const m = String(s).trim().match(/^([\d.]+)\s*([KMGTP]?i?B)?$/i)
      if (!m) return NaN
      const n = parseFloat(m[1])
      const unit = (m[2] || 'B').toUpperCase()
      const f: Record<string, number> = {
        B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15,
        KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, PIB: 1024 ** 5,
      }
      return n * (f[unit] ?? 1)
    }
    setTikvStores(res.rows.map(r => {
      const capB = toBytes(String(r[5] ?? ''))
      const availB = toBytes(String(r[6] ?? ''))
      const pct = capB > 0 && !isNaN(availB) ? ((capB - availB) * 100 / capB).toFixed(1) : '—'
      return {
        storeId:     parseInt(String(r[0] ?? '0'), 10),
        address:     String(r[1] ?? ''),
        state:       String(r[2] ?? ''),
        leaderCount: parseInt(String(r[3] ?? '0'), 10),
        regionCount: parseInt(String(r[4] ?? '0'), 10),
        capacity:    String(r[5] ?? ''),
        available:   String(r[6] ?? ''),
        usedPct:     pct + '%',
      }
    }))
  }

  const loadTxnGC = async () => {
    const vars: Record<string, string> = {}
    const varRes = await q(`SHOW VARIABLES LIKE 'tidb_%gc%'`)
    for (const row of varRes.rows) vars[String(row[0] ?? '')] = String(row[1] ?? '')

    let txnMode = '—'
    try {
      const txnRes = await q(`SELECT @@tidb_txn_mode`)
      txnMode = String(txnRes.rows[0]?.[0] ?? '—')
    } catch { /* ignore */ }

    let safePoint = '—'
    try {
      const spRes = await q(`SELECT variable_value FROM mysql.tidb WHERE variable_name = 'tikv_gc_safe_point'`)
      safePoint = String(spRes.rows[0]?.[0] ?? '—')
    } catch { /* ignore */ }

    setTxnInfo({
      safePoint,
      gcLifeTime: vars['tidb_gc_life_time'] ?? vars['tikv_gc_life_time'] ?? '—',
      txnMode,
      largeClientTx: vars['tidb_allow_remove_auto_inc'] ?? '—',
    })
  }

  const loadDdlJobs = async () => {
    const res = await q(`ADMIN SHOW DDL JOBS 20`)
    setDdlJobs(res.rows.map(r => ({
      jobId:     parseInt(String(r[0] ?? '0'), 10),
      dbName:    String(r[1] ?? ''),
      tableName: String(r[2] ?? ''),
      jobType:   String(r[3] ?? ''),
      state:     String(r[4] ?? ''),
      startTime: String(r[7] ?? '').slice(0, 19),
      elapsed:   String(r[8] ?? ''),
      progress:  String(r[10] ?? ''),
    })))
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      if (tab === 'cluster')  await loadCluster()
      if (tab === 'hotspot')  await loadHotspot()
      if (tab === 'tikv')     await loadTiKV()
      if (tab === 'txngc')    await loadTxnGC()
      if (tab === 'ddljob')   await loadDdlJobs()
      // 'ticdc' 不在此自动加载：它走独立 HTTP API、需用户先填地址再手动查询
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  // TI3：查询 TiCDC changefeed（独立 HTTP，手动触发）
  const loadTicdc = async () => {
    setTicdcLoading(true); setTicdcError(''); setTicdcFeeds([])
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ apiVersion: string; raw: unknown }>('tidb_ticdc_changefeeds', { addr: ticdcAddr })
      setTicdcApiVer(res.apiVersion)
      setTicdcRaw(JSON.stringify(res.raw, null, 2))
      // 兼容 v2 {items:[...]} 与 v1 数组 / 对象
      const raw = res.raw as Record<string, unknown>
      const items: unknown[] = Array.isArray(raw) ? raw
        : Array.isArray(raw?.items) ? raw.items as unknown[]
        : []
      setTicdcFeeds(items.map(it => {
        const o = (it ?? {}) as Record<string, unknown>
        const id = String(o.id ?? o.changefeed_id ?? o.cf_id ?? '—')
        const state = String(o.state ?? o.status ?? '—')
        const cp = o.checkpoint_time ?? o.checkpoint_tso ?? o.checkpoint ?? ''
        return { id, state, extra: cp ? `checkpoint: ${cp}` : '' }
      }))
    } catch (e) { setTicdcError(String(e)) } finally { setTicdcLoading(false) }
  }

  useEffect(() => { load() }, [tab])

  const TABS = [
    { key: 'cluster' as const, label: '集群拓扑', icon: <Server size={12} /> },
    { key: 'hotspot' as const, label: '热点分析', icon: <Zap size={12} /> },
    { key: 'tikv'    as const, label: 'TiKV 存储', icon: <Database size={12} /> },
    { key: 'txngc'   as const, label: '事务 / GC', icon: <Activity size={12} /> },
    { key: 'ddljob'  as const, label: 'DDL Job', icon: <GitBranch size={12} /> },
    { key: 'ticdc'   as const, label: 'TiCDC', icon: <Radio size={12} /> },
  ]

  const nodeColor = (type: string) => {
    if (type === 'tidb') return 'var(--accent)'
    if (type === 'tikv') return '#16a34a'
    if (type === 'pd')   return '#ea580c'
    if (type === 'tiflash') return '#9333ea'
    return 'var(--text-muted)'
  }

  const stateColor = (s: string) => s === 'Up' || s === 'Online' ? '#16a34a' : s === 'Tombstone' ? '#dc2626' : '#ea580c'

  const inner = (
    <>
        {/* Tabs（嵌入模式把版本徽标 + 刷新并进本行右侧，省去独立标题栏）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
            }}>{t.icon}{t.label}</button>
          ))}
          {embedded && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {tidbVersion && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface)', borderRadius: 4, padding: '1px 6px' }}>{tidbVersion}</span>
              )}
              <button onClick={load} disabled={loading} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            </div>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>

            {/* Cluster Topology */}
            {tab === 'cluster' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：INFORMATION_SCHEMA.CLUSTER_INFO · {clusterNodes.length} 个节点</div>
                {['tidb','pd','tikv','tiflash'].map(nodeType => {
                  const nodes = clusterNodes.filter(n => n.type === nodeType)
                  if (!nodes.length) return null
                  return (
                    <div key={nodeType}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: nodeColor(nodeType) }} />
                        <span style={{ fontSize: 12, fontWeight: 700, color: nodeColor(nodeType), textTransform: 'uppercase' }}>{nodeType}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({nodes.length} 个节点)</span>
                      </div>
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead style={{ background: 'var(--surface-2)' }}>
                            <tr>
                              {['实例地址', '版本', '启动时间', '运行时长'].map(h => (
                                <th key={h} style={{ padding: '5px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {nodes.map((n, i) => (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: nodeColor(nodeType), fontSize: 11 }}>{n.instance}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{n.version}</td>
                                <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{n.startTime}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>{n.uptime}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                })}
                {clusterNodes.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                    无法读取集群信息（需要 PROCESS 权限访问 INFORMATION_SCHEMA.CLUSTER_INFO）
                  </div>
                )}
              </div>
            )}

            {/* Hotspot Analysis */}
            {tab === 'hotspot' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {hotRegions.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.06)', border: '1px solid rgba(234,88,12,0.18)', borderRadius: 8 }}>
                    <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                      <b>检测到热点 Region！</b>单调递增主键（AUTO_INCREMENT）是 TiDB 写热点的头号原因。
                      建议评估使用 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>AUTO_RANDOM</code> 或
                      <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>SHARD_ROW_ID_BITS</code> 分散写压力。
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：TIDB_HOT_REGIONS · 按热度降序 · 前 30</div>
                {hotRegions.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无热点 Region（或权限不足）</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['类型', '库/表', '索引', 'Region ID', '热度', 'Region 数', '流量'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {hotRegions.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: r.hotRegionType === 'write' ? '#dc2626' : '#ea580c', background: r.hotRegionType === 'write' ? 'rgba(220,38,38,0.1)' : 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '1px 5px' }}>{r.hotRegionType.toUpperCase()}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{r.dbName}.{r.tableName}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{r.indexName || '—'}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.regionId}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: r.maxHotDegree > 5 ? '#dc2626' : '#ea580c' }}>{r.maxHotDegree}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.regionCount}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.flowBytes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TiKV Storage */}
            {tab === 'tikv' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：TIKV_STORE_STATUS · {tikvStores.length} 个 TiKV 节点</div>
                {tikvStores.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无数据（需要 PROCESS 权限）</div>
                ) : (
                  <>
                    {tikvStores.some(s => parseFloat(s.usedPct) > 80) && (
                      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
                        <AlertTriangle size={12} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                        <div style={{ fontSize: 12, color: 'var(--error)' }}>存在 TiKV 节点存储使用率 &gt;80%，需及时扩容！</div>
                      </div>
                    )}
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['Store ID', '地址', '状态', 'Leader 数', 'Region 数', '容量', '可用', '使用率'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tikvStores.map((r, i) => {
                            const pct = parseFloat(r.usedPct)
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.storeId}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{r.address}</td>
                                <td style={{ padding: '6px 10px' }}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: stateColor(r.state), background: `${stateColor(r.state)}18`, borderRadius: 4, padding: '1px 5px' }}>{r.state}</span>
                                </td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.leaderCount}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{r.regionCount}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.capacity}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{r.available}</td>
                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: pct > 80 ? '#dc2626' : pct > 60 ? '#ea580c' : '#16a34a' }}>{r.usedPct}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Transaction / GC */}
            {tab === 'txngc' && txnInfo && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8 }}>
                  <Info size={13} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                    <b>GC Life Time</b>：决定 MVCC 历史版本保留时间。过长会导致 TiKV 空间膨胀；过短可能导致长查询报 "GC too late"（历史版本已被回收）。<b>推荐 10m ~ 24h</b>。
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                  {[
                    { label: 'GC Safe Point', value: txnInfo.safePoint, note: '已回收到此时间点前的 MVCC 版本' },
                    { label: 'GC Life Time', value: txnInfo.gcLifeTime, note: 'MVCC 历史版本保留时长（tidb_gc_life_time）' },
                    { label: '事务模式', value: txnInfo.txnMode, note: 'optimistic（乐观）或 pessimistic（悲观）' },
                    { label: 'Flashback 窗口', value: txnInfo.safePoint ? `GC safepoint 之后` : '—', note: 'FLASHBACK TABLE 可用时间范围' },
                  ].map(c => (
                    <div key={c.label} style={{ background: 'var(--surface-2)', borderRadius: 9, padding: 14, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>{c.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', marginBottom: 4 }}>{c.value}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.note}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text)', background: 'var(--surface-2)', borderRadius: 8, padding: 14, lineHeight: 1.8 }}>
                  <b style={{ color: 'var(--text-bright)' }}>Flashback 恢复（误删 DROP/TRUNCATE）</b>
                  <pre style={{ margin: 0, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', background: 'var(--bg)', borderRadius: 7, padding: '10px 12px', border: '1px solid var(--border)', whiteSpace: 'pre-wrap' }}>{
`-- 恢复被 DROP 的表（在 GC safepoint 之后执行）
FLASHBACK TABLE t1 TO t1_recovered;

-- 时间点恢复整个数据库（TiDB 6.4+）
-- 需先确认 safepoint 覆盖目标时间
FLASHBACK DATABASE db1 TO TIMESTAMP '2024-01-15 14:30:00';`
                  }</pre>
                </div>
              </div>
            )}

            {/* DDL Jobs */}
            {tab === 'ddljob' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源：ADMIN SHOW DDL JOBS · TiDB 异步 DDL（大表加索引在后台执行，不阻塞查询）</div>
                {ddlJobs.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无 DDL Job 记录</div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['Job ID', '库', '表', '操作类型', '状态', '开始时间', '耗时', '进度'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ddlJobs.map((j, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{j.jobId}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{j.dbName}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{j.tableName}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text)' }}>{j.jobType}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{
                                fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px',
                                color: j.state === 'done' ? '#16a34a' : j.state === 'running' ? 'var(--accent)' : j.state === 'rollback done' ? '#dc2626' : '#ea580c',
                                background: j.state === 'done' ? 'rgba(22,163,74,0.1)' : j.state === 'running' ? 'var(--accent-bg)' : j.state === 'rollback done' ? 'rgba(220,38,38,0.1)' : 'rgba(234,88,12,0.1)',
                              }}>{j.state}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{j.startTime}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{j.elapsed}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: j.progress ? 'var(--accent)' : 'var(--text-muted)' }}>{j.progress || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TiCDC 同步任务（独立 HTTP API） */}
            {tab === 'ticdc' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8 }}>
                  <Info size={13} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                    TiCDC 是独立同步组件，自带 REST API（默认 <code>8300</code>），与数据库连接无关。填写 TiCDC 服务地址后查询 changefeed 同步任务状态（只读）。
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>TiCDC 地址</span>
                  <input value={ticdcAddr} onChange={e => setTicdcAddr(e.target.value)} placeholder="127.0.0.1:8300"
                    style={{ width: 240, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                  <button onClick={loadTicdc} disabled={ticdcLoading}
                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, cursor: ticdcLoading ? 'not-allowed' : 'pointer', opacity: ticdcLoading ? 0.5 : 1 }}>
                    {ticdcLoading ? '查询中…' : '查询'}
                  </button>
                  {ticdcApiVer && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>API {ticdcApiVer}</span>}
                </div>
                {ticdcError && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'rgba(220,38,38,0.08)', borderRadius: 6 }}>{ticdcError}</div>}
                {ticdcFeeds.length > 0 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>{['Changefeed ID', '状态', '详情'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {ticdcFeeds.map((f, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{f.id}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px', color: f.state === 'normal' ? '#16a34a' : f.state === 'stopped' || f.state === 'failed' ? '#dc2626' : '#ea580c', background: f.state === 'normal' ? 'rgba(22,163,74,0.1)' : f.state === 'stopped' || f.state === 'failed' ? 'rgba(220,38,38,0.1)' : 'rgba(234,88,12,0.1)' }}>{f.state}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{f.extra || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {ticdcRaw && (
                  <details>
                    <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>原始 JSON</summary>
                    <pre style={{ margin: '6px 0 0', padding: 10, fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{ticdcRaw}</pre>
                  </details>
                )}
                {!ticdcLoading && !ticdcError && ticdcFeeds.length === 0 && ticdcRaw && (
                  <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>无 changefeed 同步任务</div>
                )}
              </div>
            )}
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（版本/刷新已并入子tab行）
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
          <Server size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>TiDB 分布式运维</span>
          {tidbVersion && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>{tidbVersion}</span>
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
