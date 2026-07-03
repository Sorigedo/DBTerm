// OR2.2/OR3.3/OR3.5 + OR3/OR4 — Oracle DBA 专属面板（会话/Top SQL/表空间/锁/实例/AWR/UNDO-REDO/等待事件/Data Guard/用户/审计/健康检查/分区）
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Activity, Database, Users, Shield, AlertTriangle,
         BarChart2, Clock, Cpu, HardDrive, CheckCircle, GitBranch, Timer, BookOpen } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import OraclePitrGuidePanel from './OraclePitrGuidePanel'

interface Props {
  connectionId: string
  onClose: () => void
  initialTab?: Tab
}

type Tab = 'sessions' | 'topsql' | 'tablespace' | 'locks' | 'metrics' | 'awr'
         | 'users' | 'audit' | 'health' | 'partitions'
         | 'undoRedo' | 'waitEvents' | 'dataGuard' | 'pitrGuide'
         | 'invalidObjs' | 'staleStats'

interface QueryResult {
  columns: string[]
  rows: Array<Array<string | null>>
  rowCount?: number
}

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'sessions',    label: '会话',     icon: <Activity size={12} /> },
  { key: 'topsql',     label: 'Top SQL',  icon: <BarChart2 size={12} /> },
  { key: 'tablespace', label: '表空间',    icon: <HardDrive size={12} /> },
  { key: 'locks',      label: '锁信息',    icon: <AlertTriangle size={12} /> },
  { key: 'metrics',    label: '实例指标',  icon: <Cpu size={12} /> },
  { key: 'awr',        label: 'AWR 快照', icon: <Clock size={12} /> },
  { key: 'users',      label: '用户管理',  icon: <Users size={12} /> },
  { key: 'audit',      label: '审计追踪',  icon: <Shield size={12} /> },
  { key: 'health',     label: '健康检查',  icon: <CheckCircle size={12} /> },
  { key: 'partitions', label: '分区管理',  icon: <Database size={12} /> },
  { key: 'undoRedo',   label: 'UNDO/REDO', icon: <Timer size={12} /> },
  { key: 'waitEvents', label: '等待事件',  icon: <Clock size={12} /> },
  { key: 'dataGuard',  label: 'Data Guard', icon: <GitBranch size={12} /> },
  { key: 'pitrGuide',  label: '误删恢复指南', icon: <BookOpen size={12} /> },
  { key: 'invalidObjs', label: '失效对象',   icon: <AlertTriangle size={12} /> },
  { key: 'staleStats',  label: '统计陈旧',   icon: <BarChart2 size={12} /> },
]

export default function OraclePanel({ connectionId, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'sessions')
  const [data, setData] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // Kill session
  const [killSid, setKillSid] = useState('')
  const [killSerial, setKillSerial] = useState('')

  // Create user
  const [newUser, setNewUser] = useState('')
  const [newPass, setNewPass] = useState('')
  const [newTs, setNewTs] = useState('')

  // Partition tab
  const [partSchema, setPartSchema] = useState('')
  const [partTable, setPartTable] = useState('')
  const [partSchemas, setPartSchemas] = useState<string[]>([])
  const [partTables, setPartTables] = useState<string[]>([])
  // refs：让 fetchData 读最新值但不把 partSchema/partTable 纳入依赖（防自动触发查询）
  const partSchemaRef = useRef(partSchema)
  const partTableRef  = useRef(partTable)
  useEffect(() => { partSchemaRef.current = partSchema }, [partSchema])
  useEffect(() => { partTableRef.current  = partTable  }, [partTable])
  useEffect(() => {
    invoke<string[]>('list_schemas', { id: connectionId })
      .then(list => { setPartSchemas(list); if (list.length > 0 && !partSchema) setPartSchema(list[0]) })
      .catch(() => {})
  }, [connectionId])
  useEffect(() => {
    if (!partSchema) { setPartTables([]); return }
    invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema: partSchema })
      .then(list => { const t = list.filter(x => !x.isView).map(x => x.name); setPartTables(t); if (t.length > 0) setPartTable(t[0]) })
      .catch(() => {})
  }, [connectionId, partSchema])

  // 权限管理子弹窗
  const [privUser, setPrivUser] = useState<string | null>(null)
  const [privData, setPrivData] = useState<QueryResult | null>(null)
  const [privLoading, setPrivLoading] = useState(false)
  const [privErr, setPrivErr] = useState<string | null>(null)
  const [privMsg, setPrivMsg] = useState<string | null>(null)
  const [grantPriv, setGrantPriv] = useState('')
  const [grantObj, setGrantObj] = useState('')
  const [grantWgo, setGrantWgo] = useState(false)

  // 改密子弹窗
  const [pwUser, setPwUser] = useState<string | null>(null)
  const [pwNew, setPwNew] = useState('')

  // P0: generation 计数器，丢弃切 Tab 后返回的过期请求响应
  const genRef = useRef(0)

  const fetchData = useCallback(async (t: Tab) => {
    const gen = ++genRef.current  // 先递增，确保所有旧飞行请求被标记为过期（含切到 pitrGuide 的情况）
    if (t === 'pitrGuide') { setLoading(false); setError(null); setMsg(null); setData(null); return }
    setLoading(true); setError(null); setMsg(null); setData(null)
    try {
      let result: QueryResult
      switch (t) {
        case 'sessions':
          result = await invoke<QueryResult>('oracle_session_list', { id: connectionId })
          break
        case 'topsql':
          result = await invoke<QueryResult>('oracle_top_sql', { id: connectionId, topN: 50 })
          break
        case 'tablespace':
          result = await invoke<QueryResult>('oracle_tablespace_usage', { id: connectionId })
          break
        case 'locks':
          result = await invoke<QueryResult>('oracle_lock_info', { id: connectionId })
          break
        case 'metrics':
          result = await invoke<QueryResult>('oracle_instance_metrics', { id: connectionId })
          break
        case 'awr':
          result = await invoke<QueryResult>('oracle_awr_snapshots', { id: connectionId })
          break
        case 'users':
          result = await invoke<QueryResult>('oracle_list_users', { id: connectionId })
          break
        case 'audit':
          result = await invoke<QueryResult>('oracle_audit_trail', { id: connectionId, limit: 200 })
          break
        case 'health':
          result = await invoke<QueryResult>('oracle_health_check', { id: connectionId })
          break
        case 'partitions':
          // P1: 从 ref 读取，不纳入 useCallback 依赖，防止 Schema 变动时自动触发查询
          if (!partSchemaRef.current || !partTableRef.current) { setLoading(false); return }
          result = await invoke<QueryResult>('oracle_list_partitions', {
            id: connectionId, schema: partSchemaRef.current, table: partTableRef.current,
          })
          break
        case 'undoRedo':
          result = await invoke<QueryResult>('oracle_undo_redo_stats', { id: connectionId })
          break
        case 'waitEvents':
          result = await invoke<QueryResult>('oracle_wait_events', { id: connectionId })
          break
        case 'dataGuard':
          result = await invoke<QueryResult>('oracle_data_guard_status', { id: connectionId })
          break
        case 'invalidObjs':
          result = await invoke<QueryResult>('oracle_invalid_objects', { id: connectionId })
          break
        case 'staleStats':
          result = await invoke<QueryResult>('oracle_stale_stats', { id: connectionId })
          break
      }
      if (gen !== genRef.current) return   // 丢弃过期响应
      setData(result)
    } catch (e) {
      if (gen !== genRef.current) return
      setError(String(e))
    } finally {
      if (gen !== genRef.current) return
      setLoading(false)
    }
  }, [connectionId])  // partSchema/partTable 通过 ref 读取，不在依赖数组中

  useEffect(() => { fetchData(tab) }, [tab, fetchData])

  const killSession = async () => {
    if (!killSid || !killSerial) return
    try {
      const r = await invoke<string>('oracle_kill_session', {
        id: connectionId, sid: killSid, serial: killSerial,
      })
      setMsg(r)
      fetchData('sessions')
    } catch (e) { setError(String(e)) }
  }

  const createUser = async () => {
    if (!newUser || !newPass) return
    try {
      const r = await invoke<string>('oracle_create_user', {
        id: connectionId, username: newUser, passwordNew: newPass,
        defaultTablespace: newTs || null,
      })
      setMsg(r)
      setNewUser(''); setNewPass(''); setNewTs('')
      fetchData('users')
    } catch (e) { setError(String(e)) }
  }

  const dropUser = async (username: string) => {
    if (!window.confirm(`确认删除用户 ${username}？此操作不可撤销。`)) return
    try {
      const r = await invoke<string>('oracle_drop_user', {
        id: connectionId, username, cascade: true,
      })
      setMsg(r)
      fetchData('users')
    } catch (e) { setError(String(e)) }
  }

  const toggleLock = async (username: string, locked: boolean) => {
    try {
      const r = await invoke<string>('oracle_set_user_lock', {
        id: connectionId, username, locked,
      })
      setMsg(r)
      fetchData('users')
    } catch (e) { setError(String(e)) }
  }

  const dropPartition = async (schema: string, table: string, partition: string) => {
    if (!window.confirm(`确认删除分区 ${partition}？`)) return
    try {
      const r = await invoke<string>('oracle_drop_partition', {
        id: connectionId, schema, table, partition,
      })
      setMsg(r)
      fetchData('partitions')
    } catch (e) { setError(String(e)) }
  }

  // ── 权限管理 ──
  const fetchPrivileges = useCallback(async (username: string) => {
    setPrivLoading(true); setPrivErr(null)
    try {
      const r = await invoke<QueryResult>('oracle_list_privileges', {
        id: connectionId, username,
      })
      setPrivData(r)
    } catch (e) { setPrivErr(String(e)) }
    finally { setPrivLoading(false) }
  }, [connectionId])

  const openPrivileges = (username: string) => {
    setPrivUser(username); setPrivData(null); setPrivErr(null); setPrivMsg(null)
    setGrantPriv(''); setGrantObj(''); setGrantWgo(false)
    fetchPrivileges(username)
  }

  const grantPrivilege = async () => {
    if (!privUser || !grantPriv.trim()) return
    try {
      const r = await invoke<string>('oracle_grant_privilege', {
        id: connectionId, grantee: privUser, privilege: grantPriv.trim().toUpperCase(),
        object: grantObj.trim() || null, withGrantOption: grantWgo,
      })
      setPrivMsg(r); setPrivErr(null)
      setGrantPriv(''); setGrantObj(''); setGrantWgo(false)
      fetchPrivileges(privUser)
    } catch (e) { setPrivErr(String(e)) }
  }

  const revokePrivilege = async (privilege: string, object: string | null) => {
    if (!privUser) return
    const label = object ? `${privilege} ON ${object}` : privilege
    if (!window.confirm(`确认从用户 ${privUser} 撤销权限 ${label}？`)) return
    try {
      const r = await invoke<string>('oracle_revoke_privilege', {
        id: connectionId, grantee: privUser, privilege, object: object || null,
      })
      setPrivMsg(r); setPrivErr(null)
      fetchPrivileges(privUser)
    } catch (e) { setPrivErr(String(e)) }
  }

  // ── 改密 ──
  const changePassword = async () => {
    if (!pwUser || !pwNew) return
    try {
      const r = await invoke<string>('oracle_change_password', {
        id: connectionId, username: pwUser, newPassword: pwNew,
      })
      setMsg(r); setError(null)
      setPwUser(null); setPwNew('')
    } catch (e) { setError(String(e)) }
  }

  const panel = (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '92vw', maxWidth: 1100, height: '84vh',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'slideUp .18s ease',
      }}>
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <Database size={15} style={{ color: '#C74634' }} />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>
            Oracle DBA 面板
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
            {connectionId}
          </span>
          <button
            onClick={() => fetchData(tab)}
            style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6,
                     border: '1px solid var(--border)', background: 'var(--surface-2)',
                     color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <RefreshCw size={12} className={loading ? 'spin' : ''} /> 刷新
          </button>
          <button onClick={onClose} style={{ padding: 4, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tab 栏 */}
        <div style={{
          display: 'flex', gap: 2, padding: '8px 12px 0',
          borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto',
        }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 12, cursor: 'pointer',
                border: '1px solid ' + (tab === t.key ? 'var(--border)' : 'transparent'),
                borderBottom: tab === t.key ? '1px solid var(--surface)' : '1px solid transparent',
                background: tab === t.key ? 'var(--surface)' : 'transparent',
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
                whiteSpace: 'nowrap', marginBottom: -1,
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px 14px' }}>
          {msg && (
            <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, flexShrink: 0,
                          background: '#16a34a20', border: '1px solid #16a34a40', color: '#16a34a', fontSize: 12 }}>
              {msg}
            </div>
          )}
          {error && (
            <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, flexShrink: 0,
                          background: '#dc262620', border: '1px solid #dc262640', color: '#dc2626', fontSize: 12 }}>
              {error}
            </div>
          )}

          {/* 会话页工具栏 */}
          {tab === 'sessions' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
              <input placeholder="SID" value={killSid} onChange={e => setKillSid(e.target.value)}
                style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                         background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              <input placeholder="SERIAL#" value={killSerial} onChange={e => setKillSerial(e.target.value)}
                style={{ width: 90, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                         background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              <button onClick={killSession}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: '#dc2626',
                         color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                终止会话
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                从会话列表复制 SID 和 SERIAL# 后输入
              </span>
            </div>
          )}

          {/* 用户管理页创建用户表单 */}
          {tab === 'users' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
              <input placeholder="用户名" value={newUser} onChange={e => setNewUser(e.target.value)}
                style={{ width: 120, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                         background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              <input type="password" placeholder="密码" value={newPass} onChange={e => setNewPass(e.target.value)}
                style={{ width: 120, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                         background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              <input placeholder="默认表空间（可选）" value={newTs} onChange={e => setNewTs(e.target.value)}
                style={{ width: 160, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                         background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
              <button onClick={createUser}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)',
                         color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                创建用户
              </button>
            </div>
          )}

          {/* 分区管理页查询表单 */}
          {tab === 'partitions' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexShrink: 0 }}>
              <select value={partSchema} onChange={e => { setPartSchema(e.target.value); setPartTable('') }}
                style={{ width: 150, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
                {partSchemas.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={partTable} onChange={e => setPartTable(e.target.value)}
                style={{ width: 180, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer' }}>
                {partTables.length === 0 && <option value="">— 先选 Schema —</option>}
                {partTables.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button onClick={() => fetchData('partitions')}
                style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)',
                         color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                查询分区
              </button>
            </div>
          )}

          {/* OR4.7 误删恢复指南（纯静态，无需加载） */}
          {tab === 'pitrGuide' && (
            <OraclePitrGuidePanel embedded onClose={onClose} />
          )}

          {/* 通用结果表格 */}
          {tab !== 'pitrGuide' && loading && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>
              加载中...
            </div>
          )}

          {tab !== 'pitrGuide' && !loading && data && data.columns.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    {data.columns.map((col, i) => (
                      <th key={i} style={{
                        padding: '6px 10px', textAlign: 'left', fontWeight: 600,
                        color: 'var(--text-muted)', border: '1px solid var(--border-subtle)',
                        whiteSpace: 'nowrap',
                      }}>
                        {col}
                      </th>
                    ))}
                    {(tab === 'users' || tab === 'partitions') && (
                      <th style={{ padding: '6px 10px', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
                        操作
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{
                          padding: '5px 10px', color: 'var(--text)',
                          border: '1px solid var(--border-subtle)',
                          maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} data-tip={cell ?? ''}>
                          {cell ?? <span style={{ color: 'var(--text-muted)' }}>NULL</span>}
                        </td>
                      ))}
                      {/* 用户管理操作列 */}
                      {tab === 'users' && (() => {
                        const username = row[0] ?? ''
                        const status   = row[1] ?? ''
                        const isLocked = status.includes('LOCKED')
                        return (
                          <td style={{ padding: '4px 10px', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                            <button onClick={() => openPrivileges(username)}
                              style={{ marginRight: 6, padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                       background: 'var(--accent)', color: '#fff', border: 'none' }}>
                              权限
                            </button>
                            <button onClick={() => { setPwUser(username); setPwNew('') }}
                              style={{ marginRight: 6, padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                       background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                              改密
                            </button>
                            <button onClick={() => toggleLock(username, !isLocked)}
                              style={{ marginRight: 6, padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                       background: isLocked ? '#16a34a20' : '#ea580c20',
                                       color: isLocked ? '#16a34a' : '#ea580c',
                                       border: `1px solid ${isLocked ? '#16a34a40' : '#ea580c40'}` }}>
                              {isLocked ? '解锁' : '锁定'}
                            </button>
                            <button onClick={() => dropUser(username)}
                              style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                       background: '#dc262620', color: '#dc2626', border: '1px solid #dc262640' }}>
                              删除
                            </button>
                          </td>
                        )
                      })()}
                      {/* 分区管理操作列 */}
                      {tab === 'partitions' && (() => {
                        const partition = row[0] ?? ''
                        return (
                          <td style={{ padding: '4px 10px', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                            <button onClick={() => dropPartition(partSchema, partTable, partition)}
                              style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                       background: '#dc262620', color: '#dc2626', border: '1px solid #dc262640' }}>
                              删除分区
                            </button>
                          </td>
                        )
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>
                共 {data.rowCount ?? data.rows.length} 条记录
              </div>
            </div>
          )}

          {tab !== 'pitrGuide' && !loading && data && data.rows.length === 0 && !error && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 13 }}>
              暂无数据
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // 常用权限/角色（datalist 提示）
  const COMMON_PRIVS = [
    'CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE',
    'CREATE SEQUENCE', 'CREATE TRIGGER', 'CREATE SYNONYM', 'UNLIMITED TABLESPACE',
    'SELECT ANY TABLE', 'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE',
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'ALTER', 'REFERENCES', 'INDEX',
    'CONNECT', 'RESOURCE', 'DBA',
  ]

  const privModal = privUser && (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={() => setPrivUser(null)}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '80vw', maxWidth: 820, maxHeight: '80vh',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'slideUp .18s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
                      borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Shield size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>
            权限管理 — {privUser}
          </span>
          <button onClick={() => fetchPrivileges(privUser)}
            style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6,
                     border: '1px solid var(--border)', background: 'var(--surface-2)',
                     color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={12} className={privLoading ? 'spin' : ''} /> 刷新
          </button>
          <button onClick={() => setPrivUser(null)} style={{ padding: 4, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '12px 14px' }}>
          {privMsg && (
            <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, flexShrink: 0,
                          background: '#16a34a20', border: '1px solid #16a34a40', color: '#16a34a', fontSize: 12 }}>
              {privMsg}
            </div>
          )}
          {privErr && (
            <div style={{ padding: '8px 12px', marginBottom: 10, borderRadius: 8, flexShrink: 0,
                          background: '#dc262620', border: '1px solid #dc262640', color: '#dc2626', fontSize: 12 }}>
              {privErr}
            </div>
          )}

          {/* 授予权限表单 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
            <input list="ora-priv-list" placeholder="权限 / 角色" value={grantPriv}
              onChange={e => setGrantPriv(e.target.value)}
              style={{ width: 180, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                       background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
            <datalist id="ora-priv-list">
              {COMMON_PRIVS.map(p => <option key={p} value={p} />)}
            </datalist>
            <input placeholder="对象 schema.对象（对象权限填，可选）" value={grantObj}
              onChange={e => setGrantObj(e.target.value)}
              style={{ width: 240, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                       background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={grantWgo} onChange={e => setGrantWgo(e.target.checked)} />
              WITH GRANT OPTION
            </label>
            <button onClick={grantPrivilege}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)',
                       color: '#fff', cursor: 'pointer', fontSize: 12 }}>
              授予
            </button>
          </div>

          {privLoading && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30, fontSize: 13 }}>加载中...</div>
          )}

          {!privLoading && privData && privData.rows.length > 0 && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  {privData.columns.map((col, i) => (
                    <th key={i} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600,
                                         color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                      {col}
                    </th>
                  ))}
                  <th style={{ padding: '6px 10px', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {privData.rows.map((row, ri) => {
                  // 列顺序：PRIV_TYPE, PRIVILEGE, ADMIN_OPTION, OWNER, OBJ_NAME
                  const privType = row[0] ?? ''
                  const privilege = row[1] ?? ''
                  const owner = row[3]
                  const objName = row[4]
                  const object = (privType === 'OBJECT' && owner && objName) ? `${owner}.${objName}` : null
                  return (
                    <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{ padding: '5px 10px', color: 'var(--text)',
                                              border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                          {cell ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                      ))}
                      <td style={{ padding: '4px 10px', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
                        <button onClick={() => revokePrivilege(privilege, object)}
                          style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                                   background: '#dc262620', color: '#dc2626', border: '1px solid #dc262640' }}>
                          撤销
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}

          {!privLoading && privData && privData.rows.length === 0 && !privErr && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30, fontSize: 13 }}>该用户暂无权限</div>
          )}
        </div>
      </div>
    </div>
  )

  const pwModal = pwUser && (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={() => setPwUser(null)}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 360, background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 18, animation: 'slideUp .18s ease',
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)', marginBottom: 14 }}>
          修改密码 — {pwUser}
        </div>
        <input type="password" placeholder="新密码" value={pwNew}
          onChange={e => setPwNew(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') changePassword() }}
          autoFocus
          style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
                   background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={() => setPwUser(null)}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)',
                     background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>
            取消
          </button>
          <button onClick={changePassword} disabled={!pwNew}
            style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)',
                     color: '#fff', cursor: pwNew ? 'pointer' : 'not-allowed', opacity: pwNew ? 1 : 0.5, fontSize: 13 }}>
            确认修改
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(<>{panel}{privModal}{pwModal}</>, document.body)
}
