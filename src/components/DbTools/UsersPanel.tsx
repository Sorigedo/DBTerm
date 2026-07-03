import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Users, RefreshCw, Shield, UserPlus, KeyRound, Lock, Unlock, Trash2, Search,
} from 'lucide-react'
import { toast } from '../../stores/toastStore'
import { qid } from '../../utils/sqlDialect'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

interface DbUser {
  name: string
  host: string
  authPlugin: string
  passwordExpired: boolean
  accountLocked: boolean
  superPriv: boolean
  grants: string[]
}

// MySQL 系常用权限（按对象级分组展示）
const MYSQL_PRIVS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'DROP', 'ALTER', 'INDEX',
  'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EVENT',
  'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'REFERENCES',
  'LOCK TABLES', 'CREATE TEMPORARY TABLES',
]
// PG 系对象级权限（作用于表/视图）
const PG_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

export default function UsersPanel({ connectionId, connType, onClose }: Props) {
  const [users, setUsers] = useState<DbUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showSystem, setShowSystem] = useState(false)   // 是否显示内置系统账号
  const [selKey, setSelKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 权限编辑
  const [grantDb, setGrantDb] = useState('*')
  const [grantTable, setGrantTable] = useState('*')
  const [grantAll, setGrantAll] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set(['SELECT']))
  const [withGrant, setWithGrant] = useState(false)
  // 库 / 表 下拉数据
  const [databases, setDatabases] = useState<string[]>([])
  const [tables, setTables] = useState<string[]>([])

  // 子弹窗
  const [createOpen, setCreateOpen] = useState(false)
  const [cuName, setCuName] = useState('')
  const [cuHost, setCuHost] = useState('%')
  const [cuPwd, setCuPwd] = useState('')
  const [pwdOpen, setPwdOpen] = useState(false)
  const [newPwd, setNewPwd] = useState('')
  const [delConfirm, setDelConfirm] = useState(false)

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isMysqlFam = ['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)
  const PRIVS = isPg ? PG_PRIVS : MYSQL_PRIVS

  // 内置系统账号判定：PG 以 pg_ 前缀；MySQL 系按已知内部账号名
  const MYSQL_SYS_USERS = new Set(['mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint', 'healthcheck'])
  const isSystemUser = (name: string) => {
    const n = name.toLowerCase()
    return isPg ? n.startsWith('pg_') : MYSQL_SYS_USERS.has(n)
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<DbUser[]>('db_list_users', { id: connectionId })
      setUsers(list)
      // 保持选中项（若已被删除则清空），默认优先选中非系统账号
      setSelKey(k => {
        if (k && list.some(u => `${u.name}@${u.host}` === k)) return k
        const first = list.find(u => !isSystemUser(u.name)) ?? list[0]
        return first ? `${first.name}@${first.host}` : null
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  // 加载数据库列表（用于权限编辑下拉）
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const dbs = await invoke<string[]>('list_schemas', { id: connectionId })
        if (alive) setDatabases(dbs)
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [connectionId])
  // 选定库后加载其表列表（* 时不加载）
  useEffect(() => {
    if (!grantDb || grantDb === '*') { setTables([]); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string }[]>('list_tables', { id: connectionId, schema: grantDb })
        if (alive) setTables(list.map(t => t.name))
      } catch { if (alive) setTables([]) }
    })()
    return () => { alive = false }
  }, [connectionId, grantDb])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !createOpen && !pwdOpen && !delConfirm) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, createOpen, pwdOpen, delConfirm])

  const sysCount = useMemo(() => users.filter(u => isSystemUser(u.name)).length, [users, isPg])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter(u => (showSystem || !isSystemUser(u.name)) && (!q || `${u.name}@${u.host}`.toLowerCase().includes(q)))
  }, [users, search, showSystem, isPg])

  const sel = users.find(u => `${u.name}@${u.host}` === selKey) ?? null

  // 目标对象表达式（按方言）：
  // MySQL 系：*.* / `db`.* / `db`.`tbl`
  // PG 系：PG 无 *.* 概念，GRANT 作用于当前库内 schema/表 → ALL TABLES IN SCHEMA "s" / "s"."t"
  const buildTarget = (): string => {
    const db = grantDb.trim()
    const tbl = grantTable.trim()
    if (isPg) {
      const sch = !db || db === '*' ? 'public' : db
      if (!tbl || tbl === '*') return `ALL TABLES IN SCHEMA ${qid(connType, sch)}`
      return `${qid(connType, sch)}.${qid(connType, tbl)}`
    }
    if (!db || db === '*') return '*.*'
    if (!tbl || tbl === '*') return `${qid(connType, db)}.*`
    return `${qid(connType, db)}.${qid(connType, tbl)}`
  }
  const privString = (): string => grantAll ? 'ALL PRIVILEGES' : Array.from(picked).join(', ')

  const togglePriv = (p: string) => setPicked(prev => {
    const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n
  })

  // ── 操作 ──
  const runCreate = async () => {
    if (!cuName.trim()) { toast.error('请输入用户名'); return }
    if (!cuPwd) { toast.error('请输入密码'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_create_user', { id: connectionId, username: cuName.trim(), host: isPg ? '%' : cuHost.trim() || '%', password: cuPwd })
      toast.success(`已创建用户 ${cuName.trim()}`)
      setCreateOpen(false); setCuName(''); setCuPwd(''); setCuHost('%')
      await load()
    } catch (e) { toast.error(`创建失败：${e}`) } finally { setBusy(false) }
  }

  const runChangePwd = async () => {
    if (!sel || !newPwd) { toast.error('请输入新密码'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_change_password', { id: connectionId, username: sel.name, host: sel.host, newPassword: newPwd })
      toast.success('密码已修改')
      setPwdOpen(false); setNewPwd('')
    } catch (e) { toast.error(`修改失败：${e}`) } finally { setBusy(false) }
  }

  const runLock = async (locked: boolean) => {
    if (!sel) return
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_set_user_lock', { id: connectionId, username: sel.name, host: sel.host, locked })
      toast.success(locked ? '账号已锁定' : '账号已解锁')
      await load()
    } catch (e) { toast.error(`${locked ? '锁定' : '解锁'}失败：${e}`) } finally { setBusy(false) }
  }

  const runDrop = async () => {
    if (!sel) return
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_drop_user', { id: connectionId, username: sel.name, host: sel.host })
      toast.success(`已删除用户 ${sel.name}`)
      setDelConfirm(false)
      await load()
    } catch (e) { toast.error(`删除失败：${e}`) } finally { setBusy(false) }
  }

  const runGrant = async (revoke: boolean) => {
    if (!sel) return
    const priv = privString()
    if (!priv) { toast.error('请至少选择一个权限'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const cmd = revoke ? 'db_revoke_privilege' : 'db_grant_privilege'
      await invoke(cmd, {
        id: connectionId, username: sel.name, host: sel.host,
        privilege: priv, target: buildTarget(),
        ...(revoke ? {} : { grantOption: withGrant }),
      })
      toast.success(revoke ? '已撤销权限' : '已授予权限')
      await load()
    } catch (e) { toast.error(`${revoke ? '撤权' : '授权'}失败：${e}`) } finally { setBusy(false) }
  }

  const previewSql = sel
    ? `${'GRANT'} ${privString() || '<权限>'} ON ${buildTarget()} TO ${isPg ? qid(connType, sel.name) : `'${sel.name}'@'${sel.host}'`}${withGrant ? ' WITH GRANT OPTION' : ''}`
    : ''

  const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, fontSize: 12.5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' } as const

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 960, height: '82vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>

        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Users size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>用户与权限</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={iconBtn}><RefreshCw size={13} />刷新</button>
            {(isMysqlFam || isPg) && (
              <button onClick={() => setCreateOpen(true)} style={{ ...iconBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', fontWeight: 600 }}>
                <UserPlus size={13} />新建用户
              </button>
            )}
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4 }}><X size={15} /></button>
          </div>
        </div>

        {error && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--error)', flexShrink: 0 }}>{error}</div>}

        {/* 主体：左用户列表 + 右详情 */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左：用户列表 */}
          <div style={{ width: 280, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: 10, borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search size={13} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索用户或 Host…" spellCheck={false}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, height: 32, padding: '0 10px 0 30px', borderRadius: 8 }} />
              </div>
              {sysCount > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showSystem} onChange={e => setShowSystem(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                  显示系统账号（{sysCount}）
                </label>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
              {loading ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
                : filtered.length === 0 ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无用户</div>
                : filtered.map(u => {
                  const key = `${u.name}@${u.host}`
                  const on = key === selKey
                  return (
                    <div key={key} onClick={() => setSelKey(key)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                      background: on ? 'var(--accent-bg)' : 'transparent',
                      border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500, color: on ? 'var(--text-bright)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.name}{!isPg && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>@{u.host}</span>}
                          </span>
                          {u.superPriv && <Shield size={11} color="var(--warning)" style={{ flexShrink: 0 }} />}
                          {u.accountLocked && <Lock size={11} color="#dc2626" style={{ flexShrink: 0 }} />}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.authPlugin || '—'}</div>
                      </div>
                    </div>
                  )
                })}
            </div>
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>显示 {filtered.length} / 共 {users.length} 个用户</div>
          </div>

          {/* 右：详情 + 操作 */}
          {!sel ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>选择左侧用户查看详情</div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
              {/* 用户头 + 账号操作 */}
              <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>
                    {sel.name}{!isPg && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>@{sel.host}</span>}
                  </span>
                  {sel.authPlugin && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px' }}>{sel.authPlugin}</span>}
                  {sel.accountLocked && <span style={{ fontSize: 10.5, color: '#dc2626', background: 'rgba(220,38,38,0.1)', borderRadius: 4, padding: '1px 6px' }}>已锁定</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => { setNewPwd(''); setPwdOpen(true) }} style={iconBtn}><KeyRound size={13} />修改密码</button>
                  {isMysqlFam && (sel.accountLocked
                    ? <button onClick={() => runLock(false)} disabled={busy} style={iconBtn}><Unlock size={13} />解锁</button>
                    : <button onClick={() => runLock(true)} disabled={busy} style={{ ...iconBtn, color: '#ea580c', borderColor: 'rgba(234,88,12,0.4)' }}><Lock size={13} />锁定</button>)}
                  <button onClick={() => setDelConfirm(true)} disabled={busy} style={{ ...iconBtn, color: '#dc2626', borderColor: 'rgba(220,38,38,0.4)' }}><Trash2 size={13} />删除用户</button>
                </div>
              </div>

              {/* 已有授权 + 权限编辑：上下两段 */}
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* 已有授权 */}
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>当前授权（GRANTS）</div>
                  {sel.grants.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>无授权信息</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {sel.grants.map((g, i) => (
                        <pre key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)', borderRadius: 6, padding: '6px 10px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border-subtle)' }}>{g}</pre>
                      ))}
                    </div>
                  )}
                </div>

                {/* 权限编辑 */}
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>权限编辑</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>选择数据库 / 表与权限，预览 SQL 后执行。<code>*</code> 表示全部。</div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{isPg ? 'Schema / 库' : '数据库'}</label>
                      <SearchableSelect
                        value={grantDb}
                        onChange={v => { setGrantDb(v); setGrantTable('*') }}
                        items={[{ value: '*', label: '* （全部数据库）' }, ...databases.map(d => ({ value: d, label: d }))]}
                        placeholder="选择数据库" searchPlaceholder="搜索数据库…" />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>表</label>
                      <SearchableSelect
                        value={grantTable}
                        onChange={setGrantTable}
                        disabled={grantDb === '*'}
                        items={[{ value: '*', label: '* （全部表）' }, ...tables.map(t => ({ value: t, label: t }))]}
                        placeholder={grantDb === '*' ? '需先选库' : '选择表'} searchPlaceholder="搜索表…" />
                    </div>
                  </div>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer', marginBottom: 10 }}>
                    <input type="checkbox" checked={grantAll} onChange={e => setGrantAll(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                    <span style={{ fontWeight: 600 }}>ALL PRIVILEGES（全部权限）</span>
                  </label>

                  {!grantAll && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 12 }}>
                      {PRIVS.map(p => {
                        const on = picked.has(p)
                        return (
                          <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12, background: on ? 'var(--accent-bg)' : 'var(--surface-2)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--text-bright)' : 'var(--text)' }}>
                            <input type="checkbox" checked={on} onChange={() => togglePriv(p)} style={{ accentColor: 'var(--accent)', flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</span>
                          </label>
                        )
                      })}
                    </div>
                  )}

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={withGrant} onChange={e => setWithGrant(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                    允许继续授权（WITH GRANT OPTION）
                  </label>

                  {/* SQL 预览 */}
                  <pre style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border-subtle)' }}>{previewSql}</pre>
                </div>
              </div>

              {/* 底部：授权 / 撤权 */}
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
                <button onClick={() => runGrant(true)} disabled={busy} style={{ ...iconBtn, color: '#ea580c', borderColor: 'rgba(234,88,12,0.4)', padding: '7px 18px' }}>撤权</button>
                <button onClick={() => runGrant(false)} disabled={busy} style={{ ...iconBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', fontWeight: 600, padding: '7px 18px' }}>授权</button>
              </div>
            </div>
          )}
        </div>

        {/* 国产化三权分立提示 */}
        {(connType === 'kingBase' || connType === 'openGauss') && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', background: 'var(--accent-bg)', flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            {connType === 'kingBase' ? '金仓三权分立：DBA / 安全管理员 (SSO) / 审计管理员 (SAO)' : 'openGauss 三权分立：SYSADMIN / 安全管理员 / 审计管理员'}
          </div>
        )}
      </div>

      {/* 新建用户弹窗 */}
      {createOpen && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setCreateOpen(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 420, padding: 22, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><UserPlus size={16} color="var(--accent)" /><span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>新建用户</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>用户名</label>
              <input value={cuName} onChange={e => setCuName(e.target.value)} autoFocus spellCheck={false} style={{ fontSize: 13 }} />
            </div>
            {!isPg && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Host（% = 任意主机）</label>
                <input value={cuHost} onChange={e => setCuHost(e.target.value)} spellCheck={false} style={{ fontSize: 13 }} />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>密码</label>
              <input type="password" value={cuPwd} onChange={e => setCuPwd(e.target.value)} spellCheck={false} style={{ fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button onClick={() => setCreateOpen(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)' }}>取消</button>
              <button onClick={runCreate} disabled={busy} style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600 }}>创建</button>
            </div>
          </div>
        </div>, document.body
      )}

      {/* 修改密码弹窗 */}
      {pwdOpen && sel && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setPwdOpen(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 420, padding: 22, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><KeyRound size={16} color="var(--accent)" /><span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>修改密码</span></div>
            <div style={{ fontSize: 12.5, color: 'var(--text)' }}>用户 <strong>{sel.name}{!isPg && `@${sel.host}`}</strong></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>新密码</label>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} autoFocus spellCheck={false} style={{ fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button onClick={() => setPwdOpen(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)' }}>取消</button>
              <button onClick={runChangePwd} disabled={busy} style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600 }}>确认修改</button>
            </div>
          </div>
        </div>, document.body
      )}

      {/* 删除确认 */}
      {delConfirm && sel && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setDelConfirm(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 420, padding: 22, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Trash2 size={16} color="#dc2626" /><span style={{ fontWeight: 700, fontSize: 14, color: '#dc2626' }}>删除用户</span></div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>确定删除用户 <strong>{sel.name}{!isPg && `@${sel.host}`}</strong>？此操作不可撤销，该用户的所有权限将一并移除。</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button onClick={() => setDelConfirm(false)} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)' }}>取消</button>
              <button onClick={runDrop} disabled={busy} style={{ padding: '6px 16px', borderRadius: 8, background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 600 }}>确认删除</button>
            </div>
          </div>
        </div>, document.body
      )}
    </div>,
    document.body
  )
}
