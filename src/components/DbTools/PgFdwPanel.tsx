// PG6.2 — FDW 外部表管理 (postgres_fdw / file_fdw / etc.)
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Globe, RefreshCw, AlertTriangle, ChevronRight } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface FdwServer {
  name: string
  fdwName: string
  options: string
  owner: string
  userMappings: UserMapping[]
  foreignTables: ForeignTable[]
}

interface UserMapping {
  mappedUser: string
  options: string
}

interface ForeignTable {
  schemaName: string
  tableName: string
  serverName: string
  options: string
}

export default function PgFdwPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [servers, setServers] = useState<FdwServer[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [fdwList, setFdwList] = useState<string[]>([])

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
      // 已安装的 FDW
      const fdwRes = await q(`SELECT fdwname FROM pg_foreign_data_wrapper ORDER BY fdwname`)
      setFdwList(fdwRes.rows.map(r => String(r[0] ?? '')))

      // Foreign servers
      const svrRes = await q(`SELECT s.srvname, f.fdwname,
          COALESCE(array_to_string(s.srvoptions, ', '), '') AS options,
          r.rolname AS owner
        FROM pg_foreign_server s
        JOIN pg_foreign_data_wrapper f ON f.oid = s.srvfdw
        JOIN pg_roles r ON r.oid = s.srvowner
        ORDER BY s.srvname`)

      const svrList: FdwServer[] = svrRes.rows.map(r => ({
        name:    String(r[0] ?? ''),
        fdwName: String(r[1] ?? ''),
        options: String(r[2] ?? ''),
        owner:   String(r[3] ?? ''),
        userMappings: [],
        foreignTables: [],
      }))

      // User mappings per server
      const umRes = await q(`SELECT s.srvname,
          CASE WHEN r.rolname IS NULL THEN 'PUBLIC' ELSE r.rolname END AS mapped_user,
          COALESCE(array_to_string(u.umoptions, ', '), '') AS options
        FROM pg_user_mapping u
        JOIN pg_foreign_server s ON s.oid = u.umserver
        LEFT JOIN pg_roles r ON r.oid = u.umuser`)
      for (const row of umRes.rows) {
        const svr = svrList.find(s => s.name === row[0])
        if (svr) svr.userMappings.push({ mappedUser: String(row[1] ?? ''), options: String(row[2] ?? '') })
      }

      // Foreign tables
      const ftRes = await q(`SELECT n.nspname, c.relname, fs.srvname,
          COALESCE(array_to_string(ft.ftoptions, ', '), '') AS options
        FROM pg_foreign_table ft
        JOIN pg_class c ON c.oid = ft.ftrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_foreign_server fs ON fs.oid = ft.ftserver
        ORDER BY n.nspname, c.relname`)
      for (const row of ftRes.rows) {
        const svr = svrList.find(s => s.name === row[2])
        if (svr) svr.foreignTables.push({ schemaName: String(row[0] ?? ''), tableName: String(row[1] ?? ''), serverName: String(row[2] ?? ''), options: String(row[3] ?? '') })
      }

      setServers(svrList)
      if (svrList.length > 0 && !selected) setSelected(svrList[0].name)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const cur = servers.find(s => s.name === selected) ?? null

  const maskOptions = (opts: string) =>
    opts.replace(/password\s*=\s*'[^']*'/gi, "password='***'")

  const inner = (
    <>
        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : servers.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text-muted)', fontSize: 12 }}>
            <Globe size={32} color="var(--border)" />
            <div>当前数据库未配置外部数据源（Foreign Server）</div>
            {fdwList.length === 0 && (
              <div style={{ fontSize: 11, textAlign: 'center', lineHeight: 1.7 }}>
                未安装任何 FDW 扩展。常用扩展：<br />
                <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px' }}>CREATE EXTENSION postgres_fdw;</code>（连接其他 PostgreSQL）<br />
                <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px' }}>CREATE EXTENSION file_fdw;</code>（读取服务器本地文件）
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
            {/* 左侧 server 列表 */}
            <div style={{ width: 200, borderRight: '1px solid var(--border)', overflow: 'auto', flexShrink: 0, padding: '8px 0' }}>
              {servers.map(s => (
                <div
                  key={s.name}
                  onClick={() => setSelected(s.name)}
                  style={{
                    padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                    background: selected === s.name ? 'var(--accent-bg)' : 'transparent',
                    borderLeft: selected === s.name ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                >
                  <Globe size={12} color={selected === s.name ? 'var(--accent)' : 'var(--text-muted)'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: selected === s.name ? 'var(--accent)' : 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.fdwName} · {s.foreignTables.length} 表</div>
                  </div>
                  {selected === s.name && <ChevronRight size={11} color="var(--accent)" />}
                </div>
              ))}
            </div>

            {/* 右侧详情 */}
            {cur && (
              <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Server 基本信息 */}
                <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>Foreign Server: {cur.name}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px 12px', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>FDW</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{cur.fdwName}</span>
                    <span style={{ color: 'var(--text-muted)' }}>Owner</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{cur.owner}</span>
                    <span style={{ color: 'var(--text-muted)' }}>Options</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{maskOptions(cur.options) || '—'}</span>
                  </div>
                </div>

                {/* User Mappings */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>User Mappings（{cur.userMappings.length}）</div>
                  {cur.userMappings.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>无 User Mapping</div>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['数据库用户', '选项（密码已脱敏）'].map(h => (
                              <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {cur.userMappings.map((um, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{um.mappedUser}</td>
                              <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{maskOptions(um.options) || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Foreign Tables */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>外部表（{cur.foreignTables.length}）</div>
                  {cur.foreignTables.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>此 Server 下无外部表</div>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['Schema', '表名', 'FDW 选项'].map(h => (
                              <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {cur.foreignTables.map((ft, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '6px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{ft.schemaName}</td>
                              <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{ft.tableName}</td>
                              <td style={{ padding: '6px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>{ft.options || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* 安全提示 */}
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.06)', border: '1px solid rgba(234,88,12,0.18)', borderRadius: 8, alignItems: 'flex-start' }}>
                  <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.65 }}>
                    User Mapping 中的 <b>password</b> 选项以明文存储在系统表中，仅超级用户可见（此处已脱敏显示）。
                    建议使用 <code>.pgpass</code> 文件或 pgBouncer 统一管理凭证，避免敏感信息散落在外部数据源配置中。
                  </div>
                </div>
              </div>
            )}
          </div>
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
        style={{ width: 820, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Globe size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>FDW 外部数据源管理</span>
          {fdwList.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>
              {fdwList.join(' · ')}
            </span>
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
