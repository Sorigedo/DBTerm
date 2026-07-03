// MA6.3 — MGR（组复制）/ 半同步复制状态
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Server, Wifi } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface MgrMember {
  memberId: string
  memberHost: string
  memberPort: number
  memberState: string
  memberRole: string
  memberVersion: string
}

interface SemiSyncStatus {
  name: string
  value: string
}

type Tab = 'mgr' | 'semisync'

export default function MgrPanel({ connectionId, connType, onClose, embedded }: Props) {
  // MGR（组复制）/ 半同步复制都是 MySQL 原生特性：
  // MariaDB 用 Galera（无 replication_group_members，半同步变量名也不同）；
  // TiDB / OceanBase 是分布式架构，根本没有 MGR / 半同步插件，相关 performance_schema 表与状态变量都不存在。
  const unsupported = connType === 'mariadb' || connType === 'tidb' || connType === 'oceanBase'
  const unsupportedReason =
    connType === 'mariadb' ? 'MariaDB 使用 Galera 集群而非 MySQL 组复制（MGR），无 performance_schema.replication_group_members；半同步变量名也不同。'
    : connType === 'tidb' ? 'TiDB 为分布式架构，使用 Raft 多副本，不支持 MySQL 的 MGR 组复制与半同步复制，相关视图不存在。'
    : 'OceanBase 为分布式架构，使用 Paxos 多副本，不支持 MySQL 的 MGR 组复制与半同步复制，相关视图不存在。'
  const [tab, setTab] = useState<Tab>('mgr')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mgrMembers, setMgrMembers] = useState<MgrMember[]>([])
  const [mgrNotEnabled, setMgrNotEnabled] = useState(false)
  const [semiSync, setSemiSync] = useState<SemiSyncStatus[]>([])

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const loadMgr = async () => {
    setLoading(true); setError(''); setMgrNotEnabled(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT MEMBER_ID, MEMBER_HOST, MEMBER_PORT, MEMBER_STATE, MEMBER_ROLE,
               COALESCE(MEMBER_VERSION, '') AS MEMBER_VERSION
              FROM performance_schema.replication_group_members
              ORDER BY MEMBER_ROLE, MEMBER_HOST`,
      })
      if (res.rows.length === 0) {
        setMgrNotEnabled(true)
        setMgrMembers([])
      } else {
        setMgrMembers(res.rows.map(r => ({
          memberId:      String(r[0] ?? ''),
          memberHost:    String(r[1] ?? ''),
          memberPort:    Number(r[2] ?? 0),
          memberState:   String(r[3] ?? ''),
          memberRole:    String(r[4] ?? ''),
          memberVersion: String(r[5] ?? ''),
        })))
      }
    } catch (e) {
      const msg = String(e)
      if (msg.includes('Table') && msg.includes("doesn't exist")) setMgrNotEnabled(true)
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const loadSemiSync = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SHOW GLOBAL STATUS WHERE Variable_name LIKE 'Rpl_semi_sync%'`,
      })
      setSemiSync(res.rows.map(r => ({ name: String(r[0] ?? ''), value: String(r[1] ?? '') })))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (unsupported) return   // 该变体无 MGR / 半同步，不发查询
    if (tab === 'mgr') loadMgr()
    else loadSemiSync()
  }, [tab, unsupported])

  const stateColor = (s: string) => s === 'ONLINE' ? '#16a34a' : s === 'RECOVERING' ? '#ea580c' : '#dc2626'
  const roleColor = (r: string) => r === 'PRIMARY' ? 'var(--accent)' : 'var(--text-muted)'

  const inner = (
    <>
        {/* Tab（嵌入模式把刷新并进本行右侧，省去单独标题栏）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {([['mgr', 'MGR 组复制成员', Server], ['semisync', '半同步复制状态', Wifi]] as const).map(([key, label, Icon]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>
              <Icon size={11} />{label}
            </button>
          ))}
          {embedded && (
            <button onClick={() => tab === 'mgr' ? loadMgr() : loadSemiSync()} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: embedded ? 12 : 16 }}>
          {unsupported ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <Server size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block' }} />
              当前数据库类型不支持 MGR / 半同步复制<br />
              <span style={{ fontSize: 11, marginTop: 8, display: 'block', lineHeight: 1.6 }}>{unsupportedReason}</span>
            </div>
          ) : (<>
          {error && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
          {loading && <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}

          {!loading && tab === 'mgr' && (
            <>
              {mgrNotEnabled ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  <Server size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block' }} />
                  未启用 MGR 组复制（或 performance_schema 未开启）<br />
                  <span style={{ fontSize: 11, marginTop: 8, display: 'block' }}>
                    启用：SET GLOBAL group_replication_bootstrap_group=ON; START GROUP_REPLICATION;
                  </span>
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['角色', '主机', '端口', '状态', '版本', '成员 ID'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mgrMembers.map((m, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: roleColor(m.memberRole), background: m.memberRole === 'PRIMARY' ? 'var(--accent-bg)' : 'var(--surface-2)', padding: '2px 7px', borderRadius: 4 }}>
                            {m.memberRole || '—'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-bright)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.memberHost}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{m.memberPort}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: stateColor(m.memberState) }}>{m.memberState}</span>
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{m.memberVersion || '—'}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{m.memberId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {!loading && tab === 'semisync' && (
            <>
              {semiSync.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  <Wifi size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block' }} />
                  未找到半同步复制变量<br />
                  <span style={{ fontSize: 11, marginTop: 8, display: 'block' }}>
                    安装插件：INSTALL PLUGIN rpl_semi_sync_master SONAME 'semisync_master.so';
                  </span>
                </div>
              ) : (
                <>
                  {/* 告警 */}
                  {(() => {
                    const m: Record<string, string> = {}
                    semiSync.forEach(s => { m[s.name] = s.value })
                    const masterOn = m['Rpl_semi_sync_master_status'] === 'ON'
                    const clients = Number(m['Rpl_semi_sync_master_clients'] ?? 0)
                    const txNoAck = Number(m['Rpl_semi_sync_master_no_tx'] ?? 0)
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                        {!masterOn && (
                          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>
                            ⚠ 半同步主节点未启用（Rpl_semi_sync_master_status = OFF）
                          </div>
                        )}
                        {clients === 0 && masterOn && (
                          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(234,88,12,0.08)', color: 'var(--warning)', fontSize: 12 }}>
                            ⚠ 无半同步从节点（Rpl_semi_sync_master_clients = 0），主库已自动退化为异步复制
                          </div>
                        )}
                        {txNoAck > 0 && (
                          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(234,88,12,0.08)', color: 'var(--warning)', fontSize: 12 }}>
                            ⚠ 有 {txNoAck} 笔事务未获从节点 ACK（Rpl_semi_sync_master_no_tx）
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', width: '55%' }}>变量名</th>
                        <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {semiSync.map((s, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{s.name}</td>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11,
                            color: s.value === 'ON' ? '#16a34a' : s.value === 'OFF' ? '#dc2626' : 'var(--text)',
                          }}>{s.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
          </>)}
        </div>
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
        style={{ width: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Server size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>MGR / 半同步复制</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => tab === 'mgr' ? loadMgr() : loadSemiSync()} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
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
