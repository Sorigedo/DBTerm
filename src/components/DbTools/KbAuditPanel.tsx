// KB4.2 — 金仓内置审计配置与日志查看（只读 + 变更强确认）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Shield, AlertTriangle, Eye, Settings } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface AuditConfig {
  key: string
  value: string
  desc: string
}

interface AuditLog {
  logTime: string
  userName: string
  dbName: string
  commandTag: string
  objectType: string
  objectName: string
  statement: string
  auditType: string
}

const AUDIT_KEYS = [
  { key: 'pgaudit.log', desc: '记录的语句类型（read/write/function/role/ddl/misc/all）' },
  { key: 'pgaudit.log_catalog', desc: '是否记录系统表访问' },
  { key: 'pgaudit.log_client', desc: '是否同时输出到客户端' },
  { key: 'pgaudit.log_level', desc: '日志级别（log/warning/notice）' },
  { key: 'pgaudit.log_parameter', desc: '是否记录绑定参数' },
  { key: 'pgaudit.log_relation', desc: '是否为 SELECT/DML 每个对象单独输出' },
  { key: 'pgaudit.log_rows', desc: '是否记录影响行数' },
  { key: 'pgaudit.log_statement_once', desc: '子语句是否只输出一次主语句' },
  { key: 'pgaudit.role', desc: '用于对象级审计的主角色' },
]

export default function KbAuditPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'config' | 'logs' | 'guide'>('config')
  const [auditConfig, setAuditConfig] = useState<AuditConfig[]>([])
  const [auditEnabled, setAuditEnabled] = useState(false)
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [logFilter, setLogFilter] = useState('')

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

  const loadConfig = async () => {
    setLoading(true); setError('')
    try {
      // 检测 pgaudit 扩展（金仓内置）
      const extRes = await q(`SELECT installed_version FROM pg_available_extensions WHERE name = 'pgaudit'`)
      const installed = (extRes.rows[0]?.[0] ?? null) !== null

      // 检测是否在 shared_preload_libraries 中
      let inPreload = false
      try {
        const preRes = await q(`SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'`)
        inPreload = (preRes.rows[0]?.[0] ?? '').includes('pgaudit')
      } catch { /* ignore */ }

      setAuditEnabled(installed && inPreload)

      // 读取 pgaudit 相关 GUC
      const configs: AuditConfig[] = []
      for (const item of AUDIT_KEYS) {
        try {
          const res2 = await q(`SELECT setting FROM pg_settings WHERE name = '${item.key}'`)
          const val = String(res2.rows[0]?.[0] ?? '（未配置）')
          configs.push({ key: item.key, value: val, desc: item.desc })
        } catch {
          configs.push({ key: item.key, value: '（读取失败）', desc: item.desc })
        }
      }
      setAuditConfig(configs)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadLogs = async () => {
    setLoading(true); setError('')
    try {
      // 尝试通过 pg_read_file 读取最近审计日志（需要超级用户权限）
      // 金仓通常将 pgaudit 日志写入 PostgreSQL 日志，通过 log_destination 配置
      // 尝试查询 pgaudit 日志视图（如有）
      try {
        const res = await q(`SELECT
            log_time::text,
            user_name,
            database_name,
            command_tag,
            object_type,
            object_name,
            LEFT(statement, 120) AS statement,
            audit_type
          FROM pgaudit.log_view
          ORDER BY log_time DESC
          LIMIT 100`)
        setAuditLogs(res.rows.map(r => ({
          logTime:    String(r[0] ?? ''),
          userName:   String(r[1] ?? ''),
          dbName:     String(r[2] ?? ''),
          commandTag: String(r[3] ?? ''),
          objectType: String(r[4] ?? ''),
          objectName: String(r[5] ?? ''),
          statement:  String(r[6] ?? ''),
          auditType:  String(r[7] ?? ''),
        })))
      } catch {
        // 无审计视图，给出提示
        setAuditLogs([])
        setError('该实例未提供 pgaudit.log_view 视图。审计日志通常写入 PostgreSQL 日志文件，请联系 DBA 查看服务器日志。')
      }
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { loadConfig() }, [])
  useEffect(() => { if (tab === 'logs') loadLogs() }, [tab])

  const TABS = [
    { key: 'config' as const, label: '审计配置' },
    { key: 'logs'   as const, label: '审计日志' },
    { key: 'guide'  as const, label: '配置指南' },
  ]

  const filteredLogs = logFilter
    ? auditLogs.filter(l =>
        l.userName.includes(logFilter) ||
        l.commandTag.toLowerCase().includes(logFilter.toLowerCase()) ||
        l.statement.includes(logFilter)
      )
    : auditLogs

  const inner = (
    <>
        {/* Tabs（嵌入模式把状态徽标与刷新并进本行右侧）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >{t.label}</button>
          ))}
          {embedded && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
                color: auditEnabled ? '#16a34a' : '#dc2626',
                background: auditEnabled ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
              }}>{auditEnabled ? '已启用' : '未启用'}</span>
              <button onClick={tab === 'logs' ? loadLogs : loadConfig} style={{ color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
                <RefreshCw size={13} className={loading ? 'spin' : ''} />
              </button>
            </div>
          )}
        </div>

        {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {loading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
        ) : (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>

            {/* Config Tab */}
            {tab === 'config' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {!auditEnabled && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
                    <AlertTriangle size={13} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                      <b>pgaudit 扩展未启用。</b>金仓内置审计依赖 pgaudit。
                      需要在 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>postgresql.conf</code> 中设置{' '}
                      <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>shared_preload_libraries = 'pgaudit'</code>
                      {' '}并重启实例后执行 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>CREATE EXTENSION pgaudit;</code>。
                      详见"配置指南"标签。
                    </div>
                  </div>
                )}

                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Settings size={12} color="var(--text-muted)" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>pgaudit GUC 参数（只读）</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface-2)' }}>
                      <tr>
                        {['参数', '当前值', '说明'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {auditConfig.map((c, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontSize: 11 }}>{c.key}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{c.value}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{c.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <b>注意：</b>修改 pgaudit 配置需要超级用户权限（ALTER SYSTEM 或直接编辑 postgresql.conf），属于高风险操作。
                  请通过 SQL 编辑器执行变更并<b>强制确认</b>，变更后需要 reload（<code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>SELECT pg_reload_conf();</code>）或重启。
                </div>
              </div>
            )}

            {/* Logs Tab */}
            {tab === 'logs' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Eye size={13} color="var(--text-muted)" />
                  <input
                    value={logFilter}
                    onChange={e => setLogFilter(e.target.value)}
                    placeholder="过滤用户名 / 操作类型 / SQL"
                    style={{ flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', outline: 'none' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{filteredLogs.length} 条</span>
                </div>

                {filteredLogs.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>
                    {auditLogs.length === 0 ? '无审计日志记录（可能权限不足或未启用）' : '无匹配记录'}
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['时间', '用户', '操作', '对象类型', '对象', 'SQL（截断）'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLogs.map((l, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{l.logTime.slice(0, 19)}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text-bright)' }}>{l.userName}</td>
                            <td style={{ padding: '6px 10px' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 5px' }}>{l.commandTag}</span>
                            </td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>{l.objectType || '—'}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>{l.objectName || '—'}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={l.statement}>{l.statement}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Guide Tab */}
            {tab === 'guide' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, color: 'var(--text)', lineHeight: 1.8 }}>
                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8 }}>
                  <b>金仓 KingBase 内置审计基于 pgaudit 扩展实现</b>（国产数据库等保 2.0 三级要求）。
                  以下为最小化启用步骤：
                </div>

                {[
                  {
                    title: '第一步：修改 postgresql.conf',
                    code: `# postgresql.conf（需要超级用户或直接编辑文件）
shared_preload_libraries = 'pgaudit'   # 加入已有列表，不要覆盖
pgaudit.log = 'write, ddl'             # 建议先从 ddl/write 开始，all 日志量极大
pgaudit.log_relation = on              # 记录每个对象
pgaudit.log_parameter = off            # 正式环境谨慎，可能包含敏感参数`,
                  },
                  {
                    title: '第二步：重启数据库并安装扩展',
                    code: `-- 重启实例后：
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- 验证
SELECT * FROM pg_available_extensions WHERE name = 'pgaudit';
SHOW pgaudit.log;`,
                  },
                  {
                    title: '第三步：配置三权分立角色（金仓推荐）',
                    code: `-- 创建安全管理员和审计管理员
CREATE ROLE security_admin LOGIN PASSWORD '***' CREATEROLE;
CREATE ROLE audit_admin    LOGIN PASSWORD '***';

-- 将 pgaudit 角色分配给审计管理员（对象级审计）
ALTER SYSTEM SET pgaudit.role = 'audit_admin';
SELECT pg_reload_conf();

-- 审计管理员查询日志：通过日志文件或 pgaudit.log_view（如有）`,
                  },
                  {
                    title: '查看审计日志',
                    code: `-- 审计日志通常在 PostgreSQL 日志文件中（log_directory 配置路径）
-- 使用 pg_read_file 查看（需超级用户）：
SELECT pg_read_file('log/postgresql.log', 0, 1000000);

-- 或配置 log_destination = 'csvlog' 后从 CSV 格式读取`,
                  },
                ].map(s => (
                  <div key={s.title} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ padding: '8px 14px', background: 'var(--surface-2)', fontWeight: 600, fontSize: 12, color: 'var(--text-bright)' }}>{s.title}</div>
                    <pre style={{ margin: 0, padding: '12px 14px', background: 'var(--bg)', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{s.code}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（状态徽标与刷新已并入 Tabs 行）
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
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Shield size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>金仓内置审计</span>
          <span style={{
            fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
            color: auditEnabled ? '#16a34a' : '#dc2626',
            background: auditEnabled ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
          }}>{auditEnabled ? '已启用' : '未启用'}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={tab === 'logs' ? loadLogs : loadConfig} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
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
