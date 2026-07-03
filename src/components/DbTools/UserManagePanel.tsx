// I4 — 用户权限管理（图形化建用户/授权/回收/改密）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, UserPlus, Trash2, Key, Shield, AlertTriangle, Plus, Minus } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import SearchableSelect from './SearchableSelect'

interface DbUser {
  name: string
  host: string
  authPlugin: string
  passwordExpired: string
  accountLocked: string
  superPriv: string
  grants: string[]
}

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

type Tab = 'list' | 'create' | 'grant' | 'roles'

const MYSQL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'EXECUTE', 'ALL PRIVILEGES']
const PG_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL PRIVILEGES']

export default function UserManagePanel({ connectionId, connType, onClose }: Props) {
  const [users, setUsers] = useState<DbUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('list')
  const [msg, setMsg] = useState('')
  const [acting, setActing] = useState(false)

  // Create user form
  const [newUsername, setNewUsername] = useState('')
  const [newHost, setNewHost] = useState('%')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')

  // Grant form
  const [grantUser, setGrantUser] = useState('')
  const [grantHost, setGrantHost] = useState('%')
  const [grantPriv, setGrantPriv] = useState('SELECT')
  const [grantTarget, setGrantTarget] = useState('*.*')
  const [grantPreview, setGrantPreview] = useState('')
  const [grantMode, setGrantMode] = useState<'grant' | 'revoke'>('grant')

  // Change password
  const [changePwdUser, setChangePwdUser] = useState<{ name: string; host: string } | null>(null)
  const [newPwd, setNewPwd] = useState('')

  // Drop confirm
  const [dropConfirm, setDropConfirm] = useState<{ name: string; host: string } | null>(null)
  const [dropInput, setDropInput] = useState('')

  const isPg     = ['postgres', 'kingBase', 'openGauss'].includes(connType)
  const isMaria  = connType === 'mariadb'

  // MA5.1 — MariaDB 角色状态
  const [roles, setRoles]           = useState<string[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [newRoleName, setNewRoleName]   = useState('')
  const [grantRoleUser, setGrantRoleUser] = useState('')
  const [grantRoleName, setGrantRoleName] = useState('')
  const [defaultRoleUser, setDefaultRoleUser] = useState('')
  const [defaultRoleName, setDefaultRoleName] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const list = await invoke<DbUser[]>('db_list_users', { id: connectionId })
      setUsers(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadRoles = async () => {
    if (!isMaria) return
    setRolesLoading(true)
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: "SELECT User FROM mysql.user WHERE is_role = 'Y' ORDER BY User",
      })
      setRoles(res.rows.map(r => String(r[0] ?? '')))
    } catch { /* 旧版 MariaDB 无 is_role 列，忽略 */ }
    finally { setRolesLoading(false) }
  }

  const createRole = async () => {
    if (!newRoleName.trim()) { setMsg('角色名不能为空'); return }
    if (!window.confirm(`确认创建角色 "${newRoleName}"？`)) return
    setActing(true); setMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql: `CREATE ROLE \`${newRoleName.trim()}\`` })
      setMsg(`角色 ${newRoleName} 创建成功`)
      setNewRoleName('')
      loadRoles()
    } catch (e) { setMsg(String(e)) }
    finally { setActing(false) }
  }

  const dropRole = async (name: string) => {
    const input = window.prompt(`确认删除角色 "${name}"？请输入角色名确认：`)
    if (input !== name) { setMsg('角色名不匹配，已取消'); return }
    setActing(true); setMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql: `DROP ROLE \`${name}\`` })
      setMsg(`角色 ${name} 已删除`)
      loadRoles()
    } catch (e) { setMsg(String(e)) }
    finally { setActing(false) }
  }

  const grantRole = async () => {
    if (!grantRoleUser || !grantRoleName) { setMsg('请填写用户和角色名'); return }
    const sql = `GRANT \`${grantRoleName}\` TO '${grantRoleUser}'`
    if (!window.confirm(`确认执行：${sql}？`)) return
    setActing(true); setMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql })
      setMsg(`已将角色 ${grantRoleName} 授予 ${grantRoleUser}`)
    } catch (e) { setMsg(String(e)) }
    finally { setActing(false) }
  }

  const setDefaultRole = async () => {
    if (!defaultRoleUser || !defaultRoleName) { setMsg('请填写用户和默认角色'); return }
    const sql = `SET DEFAULT ROLE \`${defaultRoleName}\` FOR '${defaultRoleUser}'`
    if (!window.confirm(`确认执行：${sql}？`)) return
    setActing(true); setMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql })
      setMsg(`用户 ${defaultRoleUser} 的默认角色已设置为 ${defaultRoleName}`)
    } catch (e) { setMsg(String(e)) }
    finally { setActing(false) }
  }

  useEffect(() => { load() }, [connectionId])
  useEffect(() => { if (tab === 'roles') loadRoles() }, [tab])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const createUser = async () => {
    if (!newUsername.trim()) { setMsg('用户名不能为空'); return }
    if (!newPassword) { setMsg('密码不能为空'); return }
    if (newPassword !== newPassword2) { setMsg('两次密码不一致'); return }
    setActing(true)
    setMsg('')
    try {
      await invoke('db_create_user', { id: connectionId, username: newUsername, host: newHost, password: newPassword })
      setMsg(`用户 ${newUsername}@${newHost} 创建成功`)
      setNewUsername(''); setNewHost('%'); setNewPassword(''); setNewPassword2('')
      load()
      setTab('list')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setActing(false)
    }
  }

  const dropUser = async () => {
    if (!dropConfirm || dropInput !== dropConfirm.name) return
    setActing(true)
    setMsg('')
    try {
      await invoke('db_drop_user', { id: connectionId, username: dropConfirm.name, host: dropConfirm.host })
      setMsg(`用户 ${dropConfirm.name} 已删除`)
      setDropConfirm(null)
      setDropInput('')
      load()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setActing(false)
    }
  }

  const doGrant = async () => {
    if (!grantUser) { setMsg('请选择用户'); return }
    setActing(true)
    setMsg('')
    try {
      const cmd = grantMode === 'grant' ? 'db_grant_privilege' : 'db_revoke_privilege'
      const preview = await invoke<string>(cmd, {
        id: connectionId, username: grantUser, host: grantHost,
        privilege: grantPriv, target: grantTarget,
      })
      setGrantPreview(preview)
      setMsg(`${grantMode === 'grant' ? '授权' : '回收'}成功：${preview}`)
      load()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setActing(false)
    }
  }

  const changePwd = async () => {
    if (!changePwdUser || !newPwd) { setMsg('密码不能为空'); return }
    setActing(true)
    setMsg('')
    try {
      await invoke('db_change_password', { id: connectionId, username: changePwdUser.name, host: changePwdUser.host, newPassword: newPwd })
      setMsg(`${changePwdUser.name} 密码已修改`)
      setChangePwdUser(null)
      setNewPwd('')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setActing(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 760, display: 'flex', flexDirection: 'column', maxHeight: '88vh', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Shield size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>用户权限管理</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="dbt-header-btn" onClick={load} disabled={loading}><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 16px' }}>
          {([
            ['list','用户列表'],
            ['create','新建用户'],
            ['grant','授权/回收'],
            ...(isMaria ? [['roles','角色管理']] : []),
          ] as [Tab,string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '8px 14px', fontSize: 12, background: 'transparent', border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer',
            }}>{label}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && <div style={{ padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
          {msg && <div style={{ padding: 8, background: msg.includes('成功') || msg.includes('已') ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', borderRadius: 6, fontSize: 11, marginBottom: 10, color: msg.includes('成功') || msg.includes('已') ? '#16a34a' : '#dc2626' }}>{msg}</div>}

          {/* User List */}
          {tab === 'list' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                  {['用户名', '主机', '认证方式', '超级权限', '状态', '操作'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={i} className="hover-row" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 500 }}>{u.name}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{u.host || '—'}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>{u.authPlugin || '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                      {u.superPriv === 'Y' && <Shield size={12} color="var(--error)" aria-label="超级权限" />}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {u.accountLocked === 'Y' && <span style={{ fontSize: 10, color: 'var(--warning)', background: 'rgba(234,88,12,0.1)', padding: '1px 6px', borderRadius: 4 }}>已锁定</span>}
                      {u.passwordExpired === 'Y' && <span style={{ fontSize: 10, color: 'var(--error)', background: 'rgba(220,38,38,0.1)', padding: '1px 6px', borderRadius: 4 }}>密码过期</span>}
                      {u.accountLocked !== 'Y' && u.passwordExpired !== 'Y' && <span style={{ fontSize: 10, color: 'var(--success)' }}>正常</span>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="dbt-header-btn" onClick={() => { setChangePwdUser({ name: u.name, host: u.host }); setNewPwd('') }} aria-label="改密">
                          <Key size={11} />
                        </button>
                        <button
                          className="dbt-header-btn" title="删除用户" style={{ color: 'var(--error)' }}
                          onClick={() => { setDropConfirm({ name: u.name, host: u.host }); setDropInput('') }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loading && (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>暂无用户</td></tr>
                )}
              </tbody>
            </table>
          )}

          {/* Create User */}
          {tab === 'create' && (
            <div style={{ maxWidth: 460 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>用户名 *</label>
                  <input value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder="appuser" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }} />
                </div>
                {!isPg && (
                  <div>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>主机 (% = 任意主机)</label>
                    <input value={newHost} onChange={e => setNewHost(e.target.value)} placeholder="%" style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }} />
                  </div>
                )}
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>密码 *</label>
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>确认密码 *</label>
                  <input type="password" value={newPassword2} onChange={e => setNewPassword2(e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13 }} />
                </div>
                <button className="btn-primary" onClick={createUser} disabled={acting} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <UserPlus size={13} /> 创建用户
                </button>
              </div>
            </div>
          )}

          {/* Grant / Revoke */}
          {tab === 'grant' && (
            <div style={{ maxWidth: 500 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {(['grant', 'revoke'] as const).map(m => (
                  <button key={m} onClick={() => setGrantMode(m)} style={{
                    padding: '6px 16px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${grantMode === m ? 'var(--accent)' : 'var(--border)'}`,
                    background: grantMode === m ? 'rgba(59,130,246,0.1)' : 'var(--surface)',
                    color: grantMode === m ? 'var(--accent)' : 'var(--text-muted)',
                  }}>
                    {m === 'grant' ? <><Plus size={11} style={{ display: 'inline' }} /> 授权</> : <><Minus size={11} style={{ display: 'inline' }} /> 回收</>}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>目标用户</label>
                  <SearchableSelect value={grantUser} mono={false}
                    placeholder="— 选择用户 —" searchPlaceholder="搜索用户…"
                    onChange={v => {
                      const u = users.find(x => x.name === v)
                      setGrantUser(v)
                      setGrantHost(u?.host ?? '%')
                    }}
                    items={users.map(u => ({ value: u.name, label: `${u.name}@${u.host}` }))} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>权限</label>
                  <SearchableSelect value={grantPriv} mono={false}
                    onChange={setGrantPriv} options={isPg ? PG_PRIVS : MYSQL_PRIVS} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    目标范围 {!isPg && '（*.* 全局 / db.* 库 / db.table 单表）'}
                  </label>
                  <input value={grantTarget} onChange={e => setGrantTarget(e.target.value)} placeholder={isPg ? 'ALL TABLES IN SCHEMA public' : '*.*'} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-mono)' }} />
                </div>
                {grantPreview && (
                  <div style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
                    预览: {grantPreview}
                  </div>
                )}
                <button className={grantMode === 'grant' ? 'btn-primary' : 'btn-danger'} onClick={doGrant} disabled={acting || !grantUser} style={{ alignSelf: 'flex-start' }}>
                  {grantMode === 'grant' ? '执行授权' : '执行回收'}
                </button>
              </div>
            </div>
          )}

          {/* MA5.1 — MariaDB 角色管理 */}
          {tab === 'roles' && isMaria && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* 创建角色 */}
              <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>创建角色</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={newRoleName}
                    onChange={e => setNewRoleName(e.target.value)}
                    placeholder="角色名称"
                    style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
                  />
                  <button onClick={createRole} disabled={acting} style={{ padding: '7px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600 }}>
                    CREATE ROLE
                  </button>
                </div>
              </div>

              {/* 角色列表 */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>现有角色</span>
                  <button onClick={loadRoles} disabled={rolesLoading} style={{ padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 11, color: 'var(--text-muted)' }}>
                    {rolesLoading ? '…' : '刷新'}
                  </button>
                </div>
                {roles.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 0' }}>暂无角色（需 MariaDB 10.0.5+）</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {roles.map(r => (
                      <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12 }}>
                        <Shield size={11} color="var(--accent)" />
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r}</span>
                        <button onClick={() => dropRole(r)} style={{ color: 'var(--error)', lineHeight: 0, padding: '0 2px' }} title="DROP ROLE">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 授予角色给用户 */}
              <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>GRANT 角色给用户</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <SearchableSelect value={grantRoleUser} mono={false}
                    placeholder="— 选择用户 —" searchPlaceholder="搜索用户…"
                    onChange={setGrantRoleUser}
                    items={users.map(u => ({ value: `'${u.name}'@'${u.host}'`, label: `${u.name}@${u.host}` }))} />
                  <SearchableSelect value={grantRoleName} mono={false}
                    placeholder="— 选择角色 —" searchPlaceholder="搜索角色…"
                    onChange={setGrantRoleName} options={roles} />
                  <button onClick={grantRole} disabled={acting} style={{ padding: '7px 14px', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600 }}>
                    GRANT
                  </button>
                </div>
              </div>

              {/* 设置默认角色 */}
              <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>SET DEFAULT ROLE</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <SearchableSelect value={defaultRoleUser} mono={false}
                    placeholder="— 选择用户 —" searchPlaceholder="搜索用户…"
                    onChange={setDefaultRoleUser}
                    items={users.map(u => ({ value: `'${u.name}'@'${u.host}'`, label: `${u.name}@${u.host}` }))} />
                  <SearchableSelect value={defaultRoleName} mono={false}
                    placeholder="— 选择角色 —" searchPlaceholder="搜索角色…"
                    onChange={setDefaultRoleName}
                    items={[...roles.map(r => ({ value: r, label: r })), { value: 'NONE', label: 'NONE（取消默认角色）' }]} />
                  <button onClick={setDefaultRole} disabled={acting} style={{ padding: '7px 14px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 12 }}>
                    SET DEFAULT
                  </button>
                </div>
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                MariaDB 10.4+ 角色存储在 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface)', padding: '0 3px' }}>mysql.global_priv</code>；旧版本（10.0–10.3）存储在 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface)', padding: '0 3px' }}>mysql.user</code> 的 is_role 列
              </div>
            </div>
          )}
        </div>

        {/* Drop confirm dialog */}
        {dropConfirm && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setDropConfirm(null)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 400, borderRadius: 14, padding: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <AlertTriangle size={18} color="var(--error)" />
                <span style={{ fontWeight: 600, fontSize: 14 }}>删除用户</span>
              </div>
              <p style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 12, color: 'var(--text)' }}>
                将永久删除用户 <b>{dropConfirm.name}@{dropConfirm.host}</b> 及其所有权限，此操作不可撤销。
                <br />输入用户名以确认：
              </p>
              <input value={dropInput} onChange={e => setDropInput(e.target.value)} placeholder={dropConfirm.name}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, marginBottom: 12 }} autoFocus />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn-cancel" onClick={() => { setDropConfirm(null); setDropInput('') }}>取消</button>
                <button className="btn-danger" disabled={dropInput !== dropConfirm.name || acting} onClick={dropUser}>删除用户</button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* Change password dialog */}
        {changePwdUser && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setChangePwdUser(null)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 380, borderRadius: 14, padding: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <Key size={16} color="var(--accent)" />
                <span style={{ fontWeight: 600, fontSize: 14 }}>修改密码</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>{changePwdUser.name}</span>
              </div>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="新密码"
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, marginBottom: 12 }} autoFocus />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn-cancel" onClick={() => setChangePwdUser(null)}>取消</button>
                <button className="btn-primary" disabled={!newPwd || acting} onClick={changePwd}>修改密码</button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>,
    document.body
  )
}
