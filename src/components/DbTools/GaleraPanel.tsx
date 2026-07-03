// MA3.3 + MA3.4 — Galera 集群看板（MariaDB 专属）
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, CheckCircle, AlertTriangle, XCircle, Activity, Network } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface GaleraStatus {
  clusterSize:       number
  clusterStatus:     string
  localState:        string
  flowControlPaused: number
  localRecvQueue:    number
  wsrepReady:        boolean
  connected:         boolean
  localBfAborts:     number
  certFailures:      number
  lastCommitted:     number
  isGalera:          boolean
}

interface Props {
  connectionId: string
  onClose:      () => void
  embedded?:    boolean   // 嵌入 DBA 面板作为 tab 时去掉模态外壳
}

function StatusBadge({ label, ok, warn }: { label: string; ok?: boolean; warn?: boolean }) {
  const color = ok ? '#16a34a' : warn ? '#ea580c' : '#dc2626'
  const bg = ok ? 'rgba(22,163,74,0.1)' : warn ? 'rgba(234,88,12,0.1)' : 'rgba(220,38,38,0.1)'
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color, background: bg, borderRadius: 4, padding: '2px 7px' }}>
      {label}
    </span>
  )
}

export default function GaleraPanel({ connectionId, onClose, embedded }: Props) {
  const [status, setStatus] = useState<GaleraStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const s = await invoke<GaleraStatus>('mariadb_galera_status', { id: connectionId })
      setStatus(s)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [connectionId])
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => { if (!document.hidden) load() }, 5000)  // 后台不可见时暂停，避免空转连库
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [autoRefresh, connectionId])
  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  // MA3.4 — 风险告警计算
  const alerts: { level: 'error' | 'warn'; msg: string }[] = []
  if (status?.isGalera) {
    if (status.clusterStatus !== 'Primary') {
      alerts.push({ level: 'error', msg: `脑裂风险：集群状态 ${status.clusterStatus}（非 Primary），节点已从集群中脱离！` })
    }
    if (!status.wsrepReady) {
      alerts.push({ level: 'error', msg: 'wsrep_ready = OFF：节点无法处理写操作，请检查集群连通性。' })
    }
    if (!status.connected) {
      alerts.push({ level: 'error', msg: '节点未连接到集群（wsrep_connected = OFF）。' })
    }
    if (status.flowControlPaused > 0.1) {
      alerts.push({ level: 'warn', msg: `流控频繁：wsrep_flow_control_paused = ${(status.flowControlPaused * 100).toFixed(1)}%（超过 10%，写入性能受限）` })
    }
    if (status.localRecvQueue > 10) {
      alerts.push({ level: 'warn', msg: `接收队列积压：local_recv_queue = ${status.localRecvQueue}，节点跟不上集群写入速度` })
    }
  }

  const localStateOk = status?.localState === 'Synced'
  const localStateWarn = status?.localState === 'Donor'

  const inner = (
    <>
        {/* 嵌入模式：标题栏被去掉，把 5s 刷新 / 手动刷新 收进一行紧凑工具栏 */}
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              5s 刷新
            </label>
            <button onClick={load} disabled={loading} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && (
            <div style={{ padding: 12, background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {loading && !status && (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
          )}

          {status && !status.isGalera && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              <Network size={32} style={{ marginBottom: 8, opacity: 0.3 }} />
              <div>当前实例未启用 Galera 集群</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>仅 Galera 节点显示此面板</div>
            </div>
          )}

          {status?.isGalera && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* MA3.4 风险告警 */}
              {alerts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {alerts.map((a, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 8,
                      background: a.level === 'error' ? 'rgba(220,38,38,0.08)' : 'rgba(234,88,12,0.08)',
                      border: `1px solid ${a.level === 'error' ? 'rgba(220,38,38,0.3)' : 'rgba(234,88,12,0.3)'}`,
                    }}>
                      <AlertTriangle size={14} color={a.level === 'error' ? '#dc2626' : '#ea580c'} style={{ marginTop: 1, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: a.level === 'error' ? '#dc2626' : '#ea580c', lineHeight: 1.5 }}>{a.msg}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 集群总状态 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 10,
                background: status.clusterStatus === 'Primary' ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)',
                border: `1px solid ${status.clusterStatus === 'Primary' ? 'rgba(22,163,74,0.25)' : 'rgba(220,38,38,0.25)'}`,
              }}>
                {status.clusterStatus === 'Primary'
                  ? <CheckCircle size={20} color="var(--success)" />
                  : <XCircle size={20} color="var(--error)" />
                }
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: status.clusterStatus === 'Primary' ? '#16a34a' : '#dc2626' }}>
                    {status.clusterStatus}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    集群规模: {status.clusterSize} 个节点
                  </div>
                </div>
                <div style={{ marginLeft: 'auto' }}>
                  <StatusBadge
                    label={status.localState}
                    ok={localStateOk}
                    warn={localStateWarn}
                  />
                </div>
              </div>

              {/* 指标网格 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {[
                  {
                    label: '流控暂停比例',
                    value: `${(status.flowControlPaused * 100).toFixed(2)}%`,
                    warn: status.flowControlPaused > 0.05,
                    bad: status.flowControlPaused > 0.1,
                    note: '> 10% 表示写入严重受限',
                  },
                  {
                    label: '本地接收队列',
                    value: String(status.localRecvQueue),
                    warn: status.localRecvQueue > 5,
                    bad: status.localRecvQueue > 20,
                    note: '高队列说明节点跟不上写入',
                  },
                  {
                    label: '冲突回滚 (BF Aborts)',
                    value: String(status.localBfAborts),
                    warn: status.localBfAborts > 0,
                    bad: false,
                    note: '事务冲突导致的强制回滚次数',
                  },
                  {
                    label: '认证失败',
                    value: String(status.certFailures),
                    warn: status.certFailures > 0,
                    bad: false,
                    note: '冲突检测阶段失败次数',
                  },
                  {
                    label: '最后提交事务号',
                    value: String(status.lastCommitted),
                    warn: false, bad: false,
                    note: 'wsrep_last_committed',
                  },
                  {
                    label: 'wsrep_ready',
                    value: status.wsrepReady ? 'ON' : 'OFF',
                    warn: false, bad: !status.wsrepReady,
                    note: 'OFF 时节点不能处理写操作',
                  },
                ].map(m => (
                  <div key={m.label} style={{
                    padding: '10px 12px', borderRadius: 8,
                    background: 'var(--surface-2)',
                    border: `1px solid ${m.bad ? 'rgba(220,38,38,0.3)' : m.warn ? 'rgba(234,88,12,0.25)' : 'var(--border)'}`,
                  }}>
                    <div style={{ fontSize: 10, color: m.bad ? '#dc2626' : m.warn ? '#ea580c' : 'var(--text-muted)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: m.bad ? '#dc2626' : m.warn ? '#ea580c' : 'var(--text-bright)' }}>
                      {m.value}
                    </div>
                    {m.note && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{m.note}</div>}
                  </div>
                ))}
              </div>

              {/* 连接状态行 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                <Activity size={12} />
                <span>wsrep_connected: </span>
                <span style={{ fontWeight: 600, color: status.connected ? '#16a34a' : '#dc2626' }}>
                  {status.connected ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳
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
        style={{ width: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Network size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>Galera 集群状态</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
              5s 刷新
            </label>
            <button className="dbt-header-btn" onClick={load} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'spin' : ''} />
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
