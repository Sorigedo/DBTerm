// PG5.5 — 用户/角色管理：pg_roles / pg_auth_members 角色继承树 / GRANT/REVOKE
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Users, ChevronRight, Shield, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  onRunSql?: (sql: string) => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface PgRole {
  name: string
  superuser: boolean
  canLogin: boolean
  createRole: boolean
  createDb: boolean
  replication: boolean
  bypassRls: boolean
  connLimit: number
  validUntil: string | null
  memberOf: string[]
  members: string[]
}

export default function PgRolesPanel({ connectionId, onClose, onRunSql, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [roles, setRoles] = useState<PgRole[]>([])
  const [selected, setSelected] = useState<PgRole | null>(null)
  // expanded kept for future tree view use

  // SQL generation dialog
  const [showSqlDlg, setShowSqlDlg] = useState(false)
  const [sqlMode, setSqlMode] = useState<'grant' | 'revoke' | 'create' | 'drop' | 'password'>('grant')
  const [grantRole, setGrantRole] = useState('')
  const [grantTarget, setGrantTarget] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [dropTarget] = useState('')

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

  const load = async () => {
    setLoading(true); setError('')
    try {
      // Get roles with attributes
      const rolesRes = await q(`SELECT r.rolname, r.rolsuper, r.rolcanlogin, r.rolcreaterole,
          r.rolcreatedb, r.rolreplication, r.rolbypassrls,
          r.rolconnlimit, r.rolvaliduntil::text,
          COALESCE(array_to_string(ARRAY(
            SELECT m.rolname FROM pg_auth_members am
            JOIN pg_roles m ON m.oid = am.roleid
            WHERE am.member = r.oid
          ), ', '), ''),
          COALESCE(array_to_string(ARRAY(
            SELECT m.rolname FROM pg_auth_members am
            JOIN pg_roles m ON m.oid = am.member
            WHERE am.roleid = r.oid
          ), ', '), '')
        FROM pg_roles r
        ORDER BY r.rolcanlogin DESC, r.rolname`)

      const list: PgRole[] = rolesRes.rows.map(r => ({
        name:        String(r[0] ?? ''),
        superuser:   r[1] === 't' || r[1] === 'true',
        canLogin:    r[2] === 't' || r[2] === 'true',
        createRole:  r[3] === 't' || r[3] === 'true',
        createDb:    r[4] === 't' || r[4] === 'true',
        replication: r[5] === 't' || r[5] === 'true',
        bypassRls:   r[6] === 't' || r[6] === 'true',
        connLimit:   Number(r[7] ?? -1),
        validUntil:  r[8] ? String(r[8]) : null,
        memberOf:    r[9] ? String(r[9]).split(', ').filter(Boolean) : [],
        members:     r[10] ? String(r[10]).split(', ').filter(Boolean) : [],
      }))
      setRoles(list)
      if (list.length > 0 && !selected) setSelected(list[0])
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const generateSql = (): string => {
    if (sqlMode === 'grant') {
      return `GRANT "${grantRole}" TO "${grantTarget}";`
    }
    if (sqlMode === 'revoke') {
      return `REVOKE "${grantRole}" FROM "${grantTarget}";`
    }
    if (sqlMode === 'create') {
      const passClause = newPassword ? ` PASSWORD '***'` : ' NOLOGIN'
      return `CREATE ROLE "${newRoleName}"${newPassword ? ' LOGIN' : passClause};`
    }
    if (sqlMode === 'drop') {
      return `DROP ROLE IF EXISTS "${dropTarget}";`
    }
    if (sqlMode === 'password') {
      return `ALTER ROLE "${grantTarget}" PASSWORD '***';`
    }
    return ''
  }

  const confirmAndRun = (sql: string, confirm: string) => {
    if (!window.confirm(confirm)) return
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const attr = (label: string, val: boolean, warnIfTrue = false) => (
    <span style={{
      fontSize: 10, padding: '2px 6px', borderRadius: 3, fontWeight: val ? 600 : 400,
      background: val ? (warnIfTrue ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.1)') : 'var(--surface-2)',
      color: val ? (warnIfTrue ? '#dc2626' : '#16a34a') : 'var(--text-muted)',
      border: `1px solid ${val ? (warnIfTrue ? 'rgba(220,38,38,0.3)' : 'rgba(22,163,74,0.3)') : 'var(--border)'}`,
      marginRight: 4,
    }}>{label}</span>
  )

  const inner = (
    <>
        {embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>只读视图 · 变更需强确认</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button onClick={() => { setSqlMode('create'); setNewRoleName(''); setNewPassword(''); setShowSqlDlg(true) }}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent)' }}>
                + 新建角色
              </button>
              <button onClick={load} disabled={loading} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* 左侧角色列表 */}
          <div style={{ width: 200, borderRight: '1px solid var(--border)', overflow: 'auto', flexShrink: 0 }}>
            <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)' }}>
              角色 ({roles.length})
            </div>
            {loading && <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}
            {roles.map(r => (
              <div key={r.name}
                onClick={() => setSelected(r)}
                style={{
                  padding: '7px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
                  background: selected?.name === r.name ? 'var(--surface-hover)' : '',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Users size={11} color={r.canLogin ? 'var(--accent)' : 'var(--text-muted)'} />
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-bright)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingLeft: 16 }}>
                  {r.canLogin ? '可登录' : '角色组'}{r.superuser ? ' · 超级用户' : ''}
                </div>
              </div>
            ))}
          </div>

          {/* 右侧角色详情 */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {selected ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, color: 'var(--text-bright)' }}>{selected.name}</span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {attr('SUPERUSER', selected.superuser, true)}
                    {attr('LOGIN', selected.canLogin)}
                    {attr('CREATEROLE', selected.createRole, true)}
                    {attr('CREATEDB', selected.createDb)}
                    {attr('REPLICATION', selected.replication, true)}
                    {attr('BYPASSRLS', selected.bypassRls, true)}
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button onClick={() => { setSqlMode('password'); setGrantTarget(selected.name); setShowSqlDlg(true) }}
                      style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                      改密码
                    </button>
                    {!selected.superuser && (
                      <button onClick={() => confirmAndRun(
                        `DROP ROLE IF EXISTS "${selected.name}";`,
                        `确认删除角色 "${selected.name}"？\n\n此操作不可逆。角色必须先放弃所有权限和对象所有权。`
                      )} style={{ fontSize: 11, padding: '3px 9px', borderRadius: 5, border: '1px solid rgba(220,38,38,0.4)', background: 'rgba(220,38,38,0.06)', color: 'var(--error)' }}>
                        删除角色
                      </button>
                    )}
                  </div>
                </div>

                {selected.connLimit >= 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    连接数限制: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{selected.connLimit === -1 ? '无限制' : selected.connLimit}</span>
                    {selected.validUntil && <span style={{ marginLeft: 12 }}>有效期至: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--warning)' }}>{selected.validUntil}</span></span>}
                  </div>
                )}

                {selected.superuser && (
                  <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.06)', borderRadius: 8, border: '1px solid rgba(220,38,38,0.2)', display: 'flex', gap: 8, fontSize: 12 }}>
                    <AlertTriangle size={13} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: 'var(--error)' }}>超级用户拥有所有权限，无视任何 RLS 和对象权限控制。谨慎使用。</span>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {/* 所属角色 (memberOf) */}
                  <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>所属角色组 (MEMBER OF)</span>
                      <button onClick={() => { setSqlMode('grant'); setGrantTarget(selected.name); setGrantRole(''); setShowSqlDlg(true) }}
                        style={{ fontSize: 10, color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                        + GRANT
                      </button>
                    </div>
                    {selected.memberOf.length === 0
                      ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>不属于任何角色组</span>
                      : selected.memberOf.map(m => (
                        <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <Shield size={10} color="var(--accent)" />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, flex: 1 }}>{m}</span>
                          <button onClick={() => confirmAndRun(
                            `REVOKE "${m}" FROM "${selected.name}";`,
                            `确认从 "${selected.name}" 撤销角色 "${m}"？`
                          )} style={{ fontSize: 10, color: 'var(--error)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)' }}>
                            REVOKE
                          </button>
                        </div>
                      ))
                    }
                  </div>

                  {/* 包含的成员 (members) */}
                  <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>角色成员 (HAS MEMBERS)</span>
                      <button onClick={() => { setSqlMode('grant'); setGrantRole(selected.name); setGrantTarget(''); setShowSqlDlg(true) }}
                        style={{ fontSize: 10, color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                        + 添加成员
                      </button>
                    </div>
                    {selected.members.length === 0
                      ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>无角色成员</span>
                      : selected.members.map(m => (
                        <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <ChevronRight size={10} color="var(--text-muted)" />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, flex: 1 }}>{m}</span>
                          <button onClick={() => confirmAndRun(
                            `REVOKE "${selected.name}" FROM "${m}";`,
                            `确认从 "${m}" 撤销角色 "${selected.name}" 成员权限？`
                          )} style={{ fontSize: 10, color: 'var(--error)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)' }}>
                            REVOKE
                          </button>
                        </div>
                      ))
                    }
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>
                从左侧选择角色
              </div>
            )}
          </div>
        </div>

      {/* SQL 生成对话框 */}
      {showSqlDlg && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setShowSqlDlg(false)}>
          <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 440, padding: 20, borderRadius: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 14 }}>
              {sqlMode === 'grant' ? 'GRANT 角色' : sqlMode === 'revoke' ? 'REVOKE 角色' : sqlMode === 'create' ? '新建角色' : sqlMode === 'drop' ? '删除角色' : '修改密码'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
              {(sqlMode === 'grant' || sqlMode === 'revoke') && (
                <>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>角色名（将被授予的角色）</label>
                    <input value={grantRole} onChange={e => setGrantRole(e.target.value)} placeholder="editor_role"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>目标角色/用户</label>
                    <input value={grantTarget} onChange={e => setGrantTarget(e.target.value)} placeholder="alice"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                  </div>
                </>
              )}
              {sqlMode === 'create' && (
                <>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>新角色名</label>
                    <input value={newRoleName} onChange={e => setNewRoleName(e.target.value)} placeholder="new_role"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>密码（留空 = 不可登录角色组）</label>
                    <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="（可选）"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                  </div>
                </>
              )}
              {sqlMode === 'password' && (
                <>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>角色</label>
                    <input value={grantTarget} onChange={e => setGrantTarget(e.target.value)} readOnly
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>新密码</label>
                    <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="新密码"
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)' }} />
                  </div>
                </>
              )}
            </div>
            <div style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, fontSize: 11, fontFamily: 'var(--font-mono)', marginBottom: 14, wordBreak: 'break-all' }}>
              {generateSql() || '（填写上方表单）'}
            </div>
            <div style={{ padding: '6px 10px', background: 'rgba(234,88,12,0.06)', borderRadius: 6, fontSize: 11, color: 'var(--warning)', marginBottom: 14, display: 'flex', gap: 6 }}>
              <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>权限变更属于安全敏感操作，执行后立即生效。密码明文仅在 SQL 语句中短暂可见，不会被记录到历史。</span>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSqlDlg(false)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>取消</button>
              <button
                onClick={() => {
                  const sql = generateSql()
                  if (!sql) return
                  let confirmMsg = `确认执行以下操作？\n\n${sql.replace(/PASSWORD '[^']*'/, "PASSWORD '***'")}`
                  if (sqlMode === 'create') confirmMsg += '\n\n创建角色后，请立即通过 GRANT 分配必要权限。'
                  if (!window.confirm(confirmMsg)) return
                  // Replace *** with actual password for execution
                  const realSql = sqlMode === 'password'
                    ? `ALTER ROLE "${grantTarget}" PASSWORD '${newPassword.replace(/'/g, "''")}'`
                    : sqlMode === 'create' && newPassword
                      ? `CREATE ROLE "${newRoleName}" LOGIN PASSWORD '${newPassword.replace(/'/g, "''")}'`
                      : sql
                  if (onRunSql) { onRunSql(realSql); onClose() }
                }}
                style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, background: 'var(--error)', color: '#fff', fontWeight: 600 }}
              >
                生成 SQL 并执行
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
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
        style={{ width: 880, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Users size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>PG 角色管理</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>只读视图 · 变更需强确认</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => { setSqlMode('create'); setNewRoleName(''); setNewPassword(''); setShowSqlDlg(true) }}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent)' }}>
              + 新建角色
            </button>
            <button onClick={load} disabled={loading} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}>
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
