// H2 — 主从复制状态可视化
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, CheckCircle, AlertTriangle, XCircle, Activity } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface ReplicationStatus {
  isReplica: boolean
  replicaRunning: boolean
  sourceHost: string
  sourcePort: number
  replicaIoState: string
  lagSeconds: number | null
  binlogFile: string
  binlogPos: number
  errorMsg: string
  sentLsn: string
  replayLsn: string
}

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface MariaGtid {
  slavePos:   string
  binlogPos:  string
  currentPos: string
}

interface MariaSlaveChannel {
  connectionName: string
  masterHost:     string
  masterPort:     string
  ioRunning:      string
  sqlRunning:     string
  lagSecs:        number | null
  masterLogFile:  string
  readMasterLogPos: string
  lastError:      string
}

export default function ReplicationPanel({ connectionId, connType, onClose, embedded }: Props) {
  const [status, setStatus] = useState<ReplicationStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [mariaGtid, setMariaGtid] = useState<MariaGtid | null>(null)
  const [mariaChannels, setMariaChannels] = useState<MariaSlaveChannel[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMaria = connType === 'mariadb'

  const loadMariaGtid = async () => {
    if (!isMaria) return
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await inv<R>('execute_query', {
        id: connectionId,
        sql: "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('gtid_slave_pos','gtid_binlog_pos','gtid_current_pos')",
      })
      const m: Record<string, string> = {}
      for (const row of res.rows) m[String(row[0] ?? '')] = String(row[1] ?? '')
      setMariaGtid({
        slavePos:   m['gtid_slave_pos']   ?? '',
        binlogPos:  m['gtid_binlog_pos']  ?? '',
        currentPos: m['gtid_current_pos'] ?? '',
      })
    } catch { /* 非复制节点可能无此变量 */ }
  }

  const loadMariaChannels = async () => {
    if (!isMaria) return
    try {
      const { invoke: inv } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await inv<R>('execute_query', {
        id: connectionId,
        sql: 'SHOW ALL SLAVES STATUS',
      })
      // 列名索引映射
      const cols = res.columns.map(c => c.toUpperCase())
      const idx = (name: string) => cols.indexOf(name)
      const channels: MariaSlaveChannel[] = res.rows.map(r => {
        const lag = r[idx('SECONDS_BEHIND_MASTER')]
        return {
          connectionName:   String(r[idx('CONNECTION_NAME')] ?? ''),
          masterHost:       String(r[idx('MASTER_HOST')] ?? ''),
          masterPort:       String(r[idx('MASTER_PORT')] ?? ''),
          ioRunning:        String(r[idx('SLAVE_IO_RUNNING')] ?? ''),
          sqlRunning:       String(r[idx('SLAVE_SQL_RUNNING')] ?? ''),
          lagSecs:          lag !== null && lag !== undefined ? Number(lag) : null,
          masterLogFile:    String(r[idx('MASTER_LOG_FILE')] ?? ''),
          readMasterLogPos: String(r[idx('READ_MASTER_LOG_POS')] ?? ''),
          lastError:        String(r[idx('LAST_ERROR')] ?? ''),
        }
      })
      setMariaChannels(channels)
    } catch { /* 单源复制或非复制节点，忽略 */ }
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const s = await invoke<ReplicationStatus>('db_replication_status', { id: connectionId })
      setStatus(s)
      await Promise.all([loadMariaGtid(), loadMariaChannels()])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [connectionId])

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => { if (!document.hidden) load() }, 5000)  // 后台不可见暂停
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

  const lagColor = (lag: number | null) => {
    if (lag === null) return 'var(--text-muted)'
    if (lag > 30) return '#dc2626'
    if (lag > 5) return '#ea580c'
    return '#16a34a'
  }

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)

  const inner = (
    <>
      {/* 嵌入模式无模态标题栏，这里补一行紧凑工具行承载自动刷新 / 刷新 */}
      {embedded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            5s 自动刷新
          </label>
          <button onClick={load} disabled={loading} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }} data-tip="刷新">
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
          {status && !status.isReplica && (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
              <Activity size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
              <div>当前实例不是从库 / 备库</div>
              <div style={{ fontSize: 11, marginTop: 4 }}>仅复制拓扑中的从节点会显示状态信息</div>
            </div>
          )}
          {status && status.isReplica && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Overall status */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
                background: status.replicaRunning ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
                border: `1px solid ${status.replicaRunning ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
                borderRadius: 10,
              }}>
                {status.replicaRunning
                  ? <CheckCircle size={18} color="var(--success)" />
                  : <XCircle size={18} color="var(--error)" />
                }
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: status.replicaRunning ? '#16a34a' : '#dc2626' }}>
                    {status.replicaRunning ? '复制正常运行' : '复制已停止或异常'}
                  </div>
                  {status.replicaIoState && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{status.replicaIoState}</div>
                  )}
                </div>
              </div>

              {/* Lag */}
              {status.lagSeconds !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>复制延迟</span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: lagColor(status.lagSeconds) }}>
                    {status.lagSeconds.toFixed(1)}s
                  </span>
                  {status.lagSeconds > 30 && <AlertTriangle size={14} color="var(--error)" />}
                  {status.lagSeconds > 5 && status.lagSeconds <= 30 && <AlertTriangle size={14} color="var(--warning)" />}
                </div>
              )}

              {/* Details grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ...(isPg ? [
                    { label: '发送 LSN', value: status.sentLsn || '—' },
                    { label: '重放 LSN', value: status.replayLsn || '—' },
                  ] : [
                    { label: '主库地址', value: status.sourceHost ? `${status.sourceHost}:${status.sourcePort}` : '—' },
                    { label: 'Binlog 文件', value: status.binlogFile || '—' },
                    { label: 'Binlog 位置', value: status.binlogPos ? String(status.binlogPos) : '—' },
                  ]),
                ].map(item => (
                  <div key={item.label} style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{item.label}</div>
                    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', wordBreak: 'break-all' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Error message */}
              {status.errorMsg && (
                <div style={{ padding: '10px 14px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--error)', fontWeight: 600, marginBottom: 4 }}>错误信息</div>
                  <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{status.errorMsg}</div>
                </div>
              )}

              {/* MariaDB 多源复制通道（SHOW ALL SLAVES STATUS） */}
              {isMaria && mariaChannels.length > 1 && (
                <div style={{ padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
                    多源复制通道（{mariaChannels.length} 个）
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {mariaChannels.map((ch, i) => {
                      const ok = ch.ioRunning === 'Yes' && ch.sqlRunning === 'Yes'
                      const lagBad = ch.lagSecs !== null && ch.lagSecs > 30
                      return (
                        <div key={i} style={{ padding: '8px 10px', borderRadius: 6, border: `1px solid ${ok ? 'rgba(22,163,74,0.25)' : 'rgba(220,38,38,0.25)'}`, background: ok ? 'rgba(22,163,74,0.04)' : 'rgba(220,38,38,0.04)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            {ok ? <CheckCircle size={12} color="var(--success)" /> : <XCircle size={12} color="var(--error)" />}
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>
                              {ch.connectionName || '(默认)'}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                              {ch.masterHost}:{ch.masterPort}
                            </span>
                            {ch.lagSecs !== null && (
                              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)', color: lagBad ? '#dc2626' : '#16a34a' }}>
                                {lagBad && <AlertTriangle size={10} style={{ display: 'inline', marginRight: 2 }} />}
                                {ch.lagSecs}s 延迟
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            IO: {ch.ioRunning} · SQL: {ch.sqlRunning} · {ch.masterLogFile} @ {ch.readMasterLogPos}
                          </div>
                          {ch.lastError && (
                            <div style={{ fontSize: 10, color: 'var(--error)', marginTop: 2, wordBreak: 'break-all' }}>{ch.lastError}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* MariaDB GTID */}
              {isMaria && mariaGtid && (
                <div style={{ padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>MariaDB GTID</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[
                      { label: 'gtid_current_pos（当前位置）', value: mariaGtid.currentPos },
                      { label: 'gtid_slave_pos（复制接收位置）', value: mariaGtid.slavePos },
                      { label: 'gtid_binlog_pos（写入 binlog 位置）', value: mariaGtid.binlogPos },
                    ].map(g => (
                      <div key={g.label}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{g.label}</div>
                        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: g.value ? 'var(--text-bright)' : 'var(--text-muted)', wordBreak: 'break-all' }}>
                          {g.value || '（空）'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
        style={{ width: 580, display: 'flex', flexDirection: 'column', maxHeight: '80vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Activity size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>主从复制状态</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              5s 自动刷新
            </label>
            <button className="dbt-header-btn" onClick={load} disabled={loading} title="刷新">
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
