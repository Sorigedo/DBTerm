import { useState, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Users, RefreshCw, UserPlus, KeyRound, Lock, Unlock, Trash2, Search,
} from 'lucide-react'
import { toast } from '../../stores/toastStore'

interface Props {
  connectionId: string
  onClose: () => void
}

interface OraUser {
  name: string
  status: string        // ACCOUNT_STATUS：OPEN / LOCKED / EXPIRED & LOCKED …
  tablespace: string
  profile: string
  system: boolean       // ORACLE_MAINTAINED='Y'：Oracle 自带系统账号
}

interface OraPriv {
  type: string          // SYSTEM / OBJECT / ROLE
  privilege: string
  admin: string         // ADMIN_OPTION / GRANTABLE
  object: string | null // OBJECT 类型时为 OWNER.OBJ_NAME
}

interface OraQueryResult {
  columns: string[]
  rows: Array<Array<string | null>>
}

// 常用系统权限
const SYS_PRIVS = [
  'CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE',
  'CREATE SEQUENCE', 'CREATE TRIGGER', 'CREATE SYNONYM', 'UNLIMITED TABLESPACE',
  'SELECT ANY TABLE', 'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE',
  'CREATE USER', 'ALTER USER', 'DROP USER',
]
// 常用角色
const ROLES = ['CONNECT', 'RESOURCE', 'DBA']
// 对象权限（需指定对象）
const OBJ_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'ALTER', 'REFERENCES', 'INDEX']

const col = (cols: string[], name: string) => cols.findIndex(c => c.toUpperCase() === name)

export default function OracleUsersPanel({ connectionId, onClose }: Props) {
  const [users, setUsers] = useState<OraUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showSystem, setShowSystem] = useState(false)   // 是否显示 Oracle 自带系统账号
  const [selName, setSelName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 当前用户权限
  const [privs, setPrivs] = useState<OraPriv[]>([])
  const [privLoading, setPrivLoading] = useState(false)

  // 权限编辑
  const [grantObj, setGrantObj] = useState('')       // 对象（schema.对象），填则授对象权限
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [withGrant, setWithGrant] = useState(false)

  // 子弹窗
  const [createOpen, setCreateOpen] = useState(false)
  const [cuName, setCuName] = useState('')
  const [cuPwd, setCuPwd] = useState('')
  const [cuTs, setCuTs] = useState('')
  const [pwdOpen, setPwdOpen] = useState(false)
  const [newPwd, setNewPwd] = useState('')
  const [delConfirm, setDelConfirm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const r = await invoke<OraQueryResult>('oracle_list_users', { id: connectionId })
      const iName = col(r.columns, 'USERNAME'), iStat = col(r.columns, 'ACCOUNT_STATUS')
      const iTs = col(r.columns, 'DEFAULT_TABLESPACE'), iProf = col(r.columns, 'PROFILE')
      const iMaint = col(r.columns, 'ORACLE_MAINTAINED')
      const list: OraUser[] = r.rows.map(row => ({
        name: row[iName] ?? '',
        status: row[iStat] ?? '',
        tablespace: (iTs >= 0 ? row[iTs] : '') ?? '',
        profile: (iProf >= 0 ? row[iProf] : '') ?? '',
        system: iMaint >= 0 && (row[iMaint] ?? '').toUpperCase() === 'Y',
      }))
      setUsers(list)
      setSelName(k => (k && list.some(u => u.name === k) ? k : (list.find(u => !u.system)?.name ?? list[0]?.name ?? null)))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  const loadPrivs = useCallback(async (username: string) => {
    setPrivLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const r = await invoke<OraQueryResult>('oracle_list_privileges', { id: connectionId, username })
      const iType = col(r.columns, 'PRIV_TYPE'), iPriv = col(r.columns, 'PRIVILEGE')
      const iAdmin = col(r.columns, 'ADMIN_OPTION'), iOwner = col(r.columns, 'OWNER'), iObj = col(r.columns, 'OBJ_NAME')
      setPrivs(r.rows.map(row => {
        const type = row[iType] ?? ''
        const owner = iOwner >= 0 ? row[iOwner] : null
        const obj = iObj >= 0 ? row[iObj] : null
        return {
          type,
          privilege: row[iPriv] ?? '',
          admin: (iAdmin >= 0 ? row[iAdmin] : '') ?? '',
          object: type === 'OBJECT' && owner && obj ? `${owner}.${obj}` : null,
        }
      }))
    } catch { setPrivs([]) } finally { setPrivLoading(false) }
  }, [connectionId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (selName) { setPicked(new Set()); loadPrivs(selName) } else setPrivs([]) }, [selName, loadPrivs])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !createOpen && !pwdOpen && !delConfirm) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, createOpen, pwdOpen, delConfirm])

  const sysCount = useMemo(() => users.filter(u => u.system).length, [users])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter(u => (showSystem || !u.system) && (!q || u.name.toLowerCase().includes(q)))
  }, [users, search, showSystem])

  const sel = users.find(u => u.name === selName) ?? null
  const isLocked = !!sel && sel.status.includes('LOCKED')
  const objMode = grantObj.trim().length > 0
  const PRIV_OPTS = objMode ? OBJ_PRIVS : [...SYS_PRIVS, ...ROLES]

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
      await invoke('oracle_create_user', { id: connectionId, username: cuName.trim(), passwordNew: cuPwd, defaultTablespace: cuTs.trim() || null })
      toast.success(`已创建用户 ${cuName.trim()}`)
      setCreateOpen(false); setCuName(''); setCuPwd(''); setCuTs('')
      await load()
    } catch (e) { toast.error(`创建失败：${e}`) } finally { setBusy(false) }
  }

  const runChangePwd = async () => {
    if (!sel || !newPwd) { toast.error('请输入新密码'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('oracle_change_password', { id: connectionId, username: sel.name, newPassword: newPwd })
      toast.success('密码已修改')
      setPwdOpen(false); setNewPwd('')
    } catch (e) { toast.error(`修改失败：${e}`) } finally { setBusy(false) }
  }

  const runLock = async (locked: boolean) => {
    if (!sel) return
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('oracle_set_user_lock', { id: connectionId, username: sel.name, locked })
      toast.success(locked ? '账号已锁定' : '账号已解锁')
      await load()
    } catch (e) { toast.error(`${locked ? '锁定' : '解锁'}失败：${e}`) } finally { setBusy(false) }
  }

  const runDrop = async () => {
    if (!sel) return
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('oracle_drop_user', { id: connectionId, username: sel.name, cascade: true })
      toast.success(`已删除用户 ${sel.name}`)
      setDelConfirm(false)
      await load()
    } catch (e) { toast.error(`删除失败：${e}`) } finally { setBusy(false) }
  }

  const runGrant = async () => {
    if (!sel) return
    const list = Array.from(picked)
    if (!list.length) { toast.error('请至少选择一个权限/角色'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      for (const p of list) {
        await invoke('oracle_grant_privilege', { id: connectionId, grantee: sel.name, privilege: p, object: grantObj.trim() || null, withGrantOption: withGrant })
      }
      toast.success('已授予权限')
      setPicked(new Set())
      await loadPrivs(sel.name)
    } catch (e) { toast.error(`授权失败：${e}`) } finally { setBusy(false) }
  }

  const runRevoke = async (privilege: string, object: string | null) => {
    if (!sel) return
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('oracle_revoke_privilege', { id: connectionId, grantee: sel.name, privilege, object: object || null })
      toast.success('已撤销权限')
      await loadPrivs(sel.name)
    } catch (e) { toast.error(`撤销失败：${e}`) } finally { setBusy(false) }
  }

  const previewSql = sel && picked.size > 0
    ? `GRANT ${Array.from(picked).join(', ')}${grantObj.trim() ? ` ON ${grantObj.trim()}` : ''} TO ${sel.name}${withGrant ? (objMode ? ' WITH GRANT OPTION' : ' WITH ADMIN OPTION') : ''}`
    : ''

  const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, fontSize: 12.5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' } as const

  const typeBadge = (t: string) => {
    const m: Record<string, { bg: string; fg: string; label: string }> = {
      SYSTEM: { bg: 'var(--accent-bg)', fg: 'var(--accent)', label: '系统' },
      OBJECT: { bg: 'rgba(22,163,74,0.12)', fg: '#16a34a', label: '对象' },
      ROLE: { bg: 'rgba(234,88,12,0.12)', fg: '#ea580c', label: '角色' },
    }
    const s = m[t] ?? { bg: 'var(--surface-2)', fg: 'var(--text-muted)', label: t }
    return <span style={{ fontSize: 10.5, color: s.fg, background: s.bg, borderRadius: 4, padding: '1px 6px' }}>{s.label}</span>
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 960, height: '82vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>

        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Users size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>用户与权限</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Oracle</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} style={iconBtn}><RefreshCw size={13} />刷新</button>
            <button onClick={() => setCreateOpen(true)} style={{ ...iconBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', fontWeight: 600 }}>
              <UserPlus size={13} />新建用户
            </button>
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
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索用户…" spellCheck={false}
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
                  const on = u.name === selName
                  const locked = u.status.includes('LOCKED')
                  return (
                    <div key={u.name} onClick={() => setSelName(u.name)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                      background: on ? 'var(--accent-bg)' : 'transparent',
                      border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500, color: on ? 'var(--text-bright)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                          {locked && <Lock size={11} color="#dc2626" style={{ flexShrink: 0 }} />}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.tablespace || '—'}</div>
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
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-bright)' }}>{sel.name}</span>
                  <span style={{ fontSize: 10.5, color: isLocked ? '#dc2626' : '#16a34a', background: isLocked ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.12)', borderRadius: 4, padding: '1px 6px' }}>{sel.status || 'OPEN'}</span>
                  {sel.tablespace && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px' }}>{sel.tablespace}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => { setNewPwd(''); setPwdOpen(true) }} style={iconBtn}><KeyRound size={13} />修改密码</button>
                  {isLocked
                    ? <button onClick={() => runLock(false)} disabled={busy} style={iconBtn}><Unlock size={13} />解锁</button>
                    : <button onClick={() => runLock(true)} disabled={busy} style={{ ...iconBtn, color: '#ea580c', borderColor: 'rgba(234,88,12,0.4)' }}><Lock size={13} />锁定</button>}
                  <button onClick={() => setDelConfirm(true)} disabled={busy} style={{ ...iconBtn, color: '#dc2626', borderColor: 'rgba(220,38,38,0.4)' }}><Trash2 size={13} />删除用户</button>
                </div>
              </div>

              {/* 当前权限 + 权限编辑 */}
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* 当前权限（可逐条撤销） */}
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>当前权限</div>
                  {privLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>加载中…</div>
                  ) : privs.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>该用户暂无权限</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {privs.map((p, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                          {typeBadge(p.type)}
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)' }}>{p.privilege}</span>
                          {p.object && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>ON {p.object}</span>}
                          {(p.admin === 'YES' || p.admin === 'true' || p.admin === '1') && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>（可转授）</span>}
                          <button onClick={() => runRevoke(p.privilege, p.object)} disabled={busy}
                            style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer', background: 'rgba(220,38,38,0.1)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.3)' }}>撤销</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 权限编辑 */}
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>授予权限</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>填写对象则授<b>对象权限</b>，留空则授<b>系统权限 / 角色</b>。</div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                    <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>对象（schema.对象，可选）</label>
                    <input value={grantObj} onChange={e => { setGrantObj(e.target.value); setPicked(new Set()) }} placeholder="如 HR.EMPLOYEES，留空=系统权限" spellCheck={false} style={{ fontSize: 13 }} />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 12 }}>
                    {PRIV_OPTS.map(p => {
                      const on = picked.has(p)
                      const isRole = !objMode && ROLES.includes(p)
                      return (
                        <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12, background: on ? 'var(--accent-bg)' : 'var(--surface-2)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--text-bright)' : 'var(--text)' }}>
                          <input type="checkbox" checked={on} onChange={() => togglePriv(p)} style={{ accentColor: 'var(--accent)', flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}{isRole && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> 角色</span>}</span>
                        </label>
                      )
                    })}
                  </div>

                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={withGrant} onChange={e => setWithGrant(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                    允许继续授权（WITH {objMode ? 'GRANT' : 'ADMIN'} OPTION）
                  </label>

                  {previewSql && (
                    <pre style={{ marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', border: '1px solid var(--border-subtle)' }}>{previewSql}</pre>
                  )}
                </div>
              </div>

              {/* 底部：授权 */}
              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
                <button onClick={runGrant} disabled={busy || picked.size === 0} style={{ ...iconBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)', fontWeight: 600, padding: '7px 18px', opacity: picked.size === 0 ? 0.5 : 1 }}>授权</button>
              </div>
            </div>
          )}
        </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>密码</label>
              <input type="password" value={cuPwd} onChange={e => setCuPwd(e.target.value)} spellCheck={false} style={{ fontSize: 13 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>默认表空间（可选）</label>
              <input value={cuTs} onChange={e => setCuTs(e.target.value)} spellCheck={false} style={{ fontSize: 13 }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>创建后将自动授予 CREATE SESSION 以便登录。</div>
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
            <div style={{ fontSize: 12.5, color: 'var(--text)' }}>用户 <strong>{sel.name}</strong></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>新密码</label>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} autoFocus spellCheck={false} onKeyDown={e => { if (e.key === 'Enter') runChangePwd() }} style={{ fontSize: 13 }} />
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
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>确定删除用户 <strong>{sel.name}</strong>？将以 <code>CASCADE</code> 连同其所属对象一并删除，此操作不可撤销。</div>
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
