// MO9.3: MongoDB 用户与角色管理面板
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { X, Plus, Trash2, KeyRound, Shield, RefreshCw, Loader2, UserPlus, ChevronDown, ChevronRight } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'

interface MongoRoleRef { role: string; db: string }

interface MongoUserInfo {
  username: string
  db: string
  roles: MongoRoleRef[]
  customData?: string
  mechanisms: string[]
}

interface MongoRoleInfo {
  role: string
  db: string
  isBuiltin: boolean
  privilegesCount: number
  inheritedRoles: MongoRoleRef[]
}

interface Props {
  connectionId: string
  currentDb: string
  readOnly: boolean
  onClose: () => void
}

// 内置 MongoDB 角色（admin 库）
const BUILTIN_ADMIN_ROLES = [
  'root', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'readAnyDatabase', 'readWriteAnyDatabase',
  'clusterAdmin', 'clusterManager', 'clusterMonitor', 'hostManager', 'backup', 'restore',
]
const BUILTIN_DB_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin']

function RoleBadge({ role, db, onRemove }: { role: string; db: string; onRemove?: () => void }) {
  const isAdmin = BUILTIN_ADMIN_ROLES.includes(role)
  const isDangerous = role === 'root' || role === 'dbOwner' || role === 'userAdminAnyDatabase'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '2px 7px', borderRadius: 5, fontSize: 11,
      background: isDangerous ? 'rgba(220,38,38,0.12)' : isAdmin ? 'rgba(var(--accent-rgb,99,102,241),0.12)' : 'var(--surface-2)',
      color: isDangerous ? '#dc2626' : isAdmin ? 'var(--accent)' : 'var(--text)',
      border: `1px solid ${isDangerous ? 'rgba(220,38,38,0.3)' : 'var(--border-subtle)'}`,
    }}>
      <Shield size={10} />
      {role}@{db}
      {onRemove && (
        <button onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px', color: 'inherit', display: 'flex', alignItems: 'center' }}>
          <X size={9} />
        </button>
      )}
    </span>
  )
}

export default function MongoUsersPanel({ connectionId, currentDb, readOnly, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users')
  const [users, setUsers] = useState<MongoUserInfo[]>([])
  const [roles, setRoles] = useState<MongoRoleInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 创建用户
  const [showCreate, setShowCreate] = useState(false)
  const [newUser, setNewUser] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [newPwdConfirm, setNewPwdConfirm] = useState('')
  const [newRoles, setNewRoles] = useState<MongoRoleRef[]>([{ role: 'readWrite', db: currentDb }])
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // 修改密码
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editPwd, setEditPwd] = useState('')
  const [editPwdConfirm, setEditPwdConfirm] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 删除用户确认
  const [dropConfirm, setDropConfirm] = useState<string | null>(null)  // username
  const [dropInput, setDropInput] = useState('')
  const [dropping, setDropping] = useState(false)

  // 展开角色详情
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (activeTab === 'users') {
        const result = await invoke<MongoUserInfo[]>('mongo_users_info', { id: connectionId, db: currentDb })
        setUsers(result)
      } else {
        const result = await invoke<MongoRoleInfo[]>('mongo_roles_info', { id: connectionId, db: currentDb })
        setRoles(result)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [connectionId, currentDb, activeTab])

  useEffect(() => { load() }, [load])

  async function createUser() {
    if (!newUser.trim()) { setCreateError('用户名不能为空'); return }
    if (newPwd.length < 6) { setCreateError('密码至少 6 位'); return }
    if (newPwd !== newPwdConfirm) { setCreateError('两次密码不一致'); return }
    setCreating(true)
    setCreateError(null)
    try {
      await invoke('mongo_create_user', {
        id: connectionId, db: currentDb,
        username: newUser.trim(), password: newPwd,
        roles: newRoles,
      })
      setShowCreate(false)
      setNewUser(''); setNewPwd(''); setNewPwdConfirm('')
      setNewRoles([{ role: 'readWrite', db: currentDb }])
      await load()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      setCreating(false)
    }
  }

  async function updatePassword() {
    if (!editingUser) return
    if (editPwd.length < 6) { setEditError('密码至少 6 位'); return }
    if (editPwd !== editPwdConfirm) { setEditError('两次密码不一致'); return }
    setSaving(true)
    setEditError(null)
    try {
      await invoke('mongo_update_user_password', {
        id: connectionId, db: currentDb,
        username: editingUser, newPassword: editPwd,
      })
      setEditingUser(null)
      setEditPwd(''); setEditPwdConfirm('')
    } catch (e) {
      setEditError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function dropUser() {
    if (!dropConfirm) return
    if (dropInput !== dropConfirm) return
    setDropping(true)
    try {
      await invoke('mongo_drop_user', {
        id: connectionId, db: currentDb,
        username: dropConfirm,
      })
      setDropConfirm(null); setDropInput('')
      await load()
    } catch (e) {
      alert(`删除用户失败: ${e}`)
    } finally {
      setDropping(false)
    }
  }

  function toggleRoleExpand(key: string) {
    setExpandedRoles(prev => {
      const s = new Set(prev)
      if (s.has(key)) s.delete(key)
      else s.add(key)
      return s
    })
  }

  const panel = (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 700, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        {/* 头部 */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Shield size={16} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>用户与角色管理</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>· {currentDb}</span>
          <div style={{ flex: 1 }} />
          <button onClick={load} disabled={loading}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            {loading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={11} />}
            刷新
          </button>
          <button onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <X size={16} />
          </button>
        </div>

        {/* 标签栏 */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', padding: '0 20px', background: 'var(--surface)' }}>
          {(['users', 'roles'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12,
                color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent' }}>
              {tab === 'users' ? '用户列表' : '角色列表'}
            </button>
          ))}
        </div>

        {/* 正文 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {readOnly && (
            <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.25)', fontSize: 12, color: 'var(--warning)' }}>
              当前连接为只读模式，用户管理操作已禁用。
            </div>
          )}
          {error && (
            <div style={{ padding: '8px 12px', marginBottom: 12, borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', fontSize: 12, color: 'var(--error)' }}>
              {error}
            </div>
          )}

          {activeTab === 'users' && (
            <>
              {!readOnly && (
                <div style={{ marginBottom: 16 }}>
                  <button onClick={() => setShowCreate(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                    <UserPlus size={13} /> 创建用户
                  </button>
                </div>
              )}

              {/* 创建用户表单 */}
              {showCreate && (
                <div style={{ marginBottom: 16, padding: 16, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 12 }}>新建用户</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>用户名</div>
                      <input value={newUser} onChange={e => setNewUser(e.target.value)}
                        placeholder="输入用户名"
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>数据库</div>
                      <input value={currentDb} readOnly
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>密码</div>
                      <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)}
                        placeholder="至少 6 位"
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>确认密码</div>
                      <input type="password" value={newPwdConfirm} onChange={e => setNewPwdConfirm(e.target.value)}
                        placeholder="再次输入密码"
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${newPwdConfirm && newPwd !== newPwdConfirm ? '#dc2626' : 'var(--border-subtle)'}`, background: 'var(--surface)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }} />
                    </div>
                  </div>

                  {/* 角色选择 */}
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>角色（至少一个）</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {newRoles.map((r, i) => (
                        <RoleBadge key={i} role={r.role} db={r.db}
                          onRemove={() => setNewRoles(prev => prev.filter((_, j) => j !== i))} />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <SearchableSelect value="" placeholder="+ 添加角色" searchPlaceholder="搜索角色…"
                        onChange={val => {
                          if (!val) return
                          const [role, db] = val.split('@')
                          if (!newRoles.some(r => r.role === role && r.db === db)) {
                            setNewRoles(prev => [...prev, { role, db }])
                          }
                        }}
                        items={[
                          ...BUILTIN_DB_ROLES.map(r => ({ value: `${r}@${currentDb}`, label: `${r}@${currentDb}` })),
                          ...BUILTIN_ADMIN_ROLES.map(r => ({ value: `${r}@admin`, label: `${r}@admin` })),
                        ]} />
                    </div>
                  </div>

                  {createError && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--error)' }}>{createError}</div>}

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                    <button onClick={() => { setShowCreate(false); setCreateError(null) }}
                      style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                      取消
                    </button>
                    <button onClick={createUser} disabled={creating}
                      style={{ padding: '6px 14px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {creating ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={12} />}
                      创建
                    </button>
                  </div>
                </div>
              )}

              {/* 用户列表 */}
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> 加载中…
                </div>
              ) : users.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                  当前库暂无用户
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {users.map(u => (
                    <div key={`${u.db}.${u.username}`} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--surface)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                          {u.username[0]?.toUpperCase() ?? '?'}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 13 }}>{u.username}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>认证库：{u.db} · 机制：{u.mechanisms.join(', ') || '默认'}</div>
                        </div>
                        {!readOnly && (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => { setEditingUser(u.username); setEditPwd(''); setEditPwdConfirm(''); setEditError(null) }}
                              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <KeyRound size={11} /> 改密码
                            </button>
                            <button onClick={() => { setDropConfirm(u.username); setDropInput('') }}
                              style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(220,38,38,0.1)', color: 'var(--error)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Trash2 size={11} /> 删除
                            </button>
                          </div>
                        )}
                      </div>

                      {/* 修改密码内联表单 */}
                      {editingUser === u.username && (
                        <div style={{ marginBottom: 10, padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <div style={{ flex: 1 }}>
                              <input type="password" value={editPwd} onChange={e => setEditPwd(e.target.value)}
                                placeholder="新密码（至少 6 位）"
                                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box', marginBottom: 6 }} />
                              <input type="password" value={editPwdConfirm} onChange={e => setEditPwdConfirm(e.target.value)}
                                placeholder="确认新密码"
                                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${editPwdConfirm && editPwd !== editPwdConfirm ? '#dc2626' : 'var(--border-subtle)'}`, background: 'var(--surface)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }} />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <button onClick={updatePassword} disabled={saving}
                                style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                                {saving ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                                保存
                              </button>
                              <button onClick={() => setEditingUser(null)}
                                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                                取消
                              </button>
                            </div>
                          </div>
                          {editError && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--error)' }}>{editError}</div>}
                        </div>
                      )}

                      {/* 角色列表 */}
                      {u.roles.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {u.roles.map((r, i) => <RoleBadge key={i} role={r.role} db={r.db} />)}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>无角色</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === 'roles' && (
            <>
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> 加载中…
                </div>
              ) : roles.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>暂无角色信息</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {roles.map(r => {
                    const key = `${r.db}.${r.role}`
                    const expanded = expandedRoles.has(key)
                    return (
                      <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
                        <div onClick={() => toggleRoleExpand(key)}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', background: 'var(--surface)', userSelect: 'none' }}>
                          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <Shield size={13} color={r.isBuiltin ? 'var(--text-muted)' : 'var(--accent)'} />
                          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>{r.role}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{r.db}</span>
                          {r.isBuiltin && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>内置</span>}
                          <div style={{ flex: 1 }} />
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.privilegesCount} 权限</span>
                        </div>
                        {expanded && r.inheritedRoles.length > 0 && (
                          <div style={{ padding: '8px 14px 12px', background: 'var(--surface-2)', borderTop: '1px solid var(--border-subtle)' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>继承自：</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                              {r.inheritedRoles.map((ir, i) => <RoleBadge key={i} role={ir.role} db={ir.db} />)}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 删除用户确认弹窗 */}
      {dropConfirm && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '24px 28px', maxWidth: 420, width: '90%' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--error)', marginBottom: 12 }}>删除用户</div>
            <p style={{ color: 'var(--text)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              即将从 <strong>{currentDb}</strong> 删除用户 <strong>{dropConfirm}</strong>。<br />
              此操作不可撤销。请在下方输入用户名确认：
            </p>
            <input value={dropInput} onChange={e => setDropInput(e.target.value)}
              placeholder={dropConfirm}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 7, border: `1px solid ${dropInput && dropInput !== dropConfirm ? '#dc2626' : 'var(--border)'}`, background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setDropConfirm(null); setDropInput('') }}
                style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                取消
              </button>
              <button onClick={dropUser} disabled={dropping || dropInput !== dropConfirm}
                style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--error)', color: '#fff', cursor: dropInput !== dropConfirm ? 'not-allowed' : 'pointer', opacity: dropInput !== dropConfirm ? 0.5 : 1, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {dropping ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={12} />}
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )

  return createPortal(panel, document.body)
}
