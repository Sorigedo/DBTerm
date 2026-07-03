// OG4.2 — openGauss 高安全特性（统一审计 / 动态脱敏 / 全密态识别）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Shield, Eye, EyeOff, Lock, AlertTriangle } from 'lucide-react'

interface Props {
  connectionId: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

interface AuditPolicy {
  policyName: string
  policyType: string
  enabled: string
  comments: string
}

interface MaskPolicy {
  policyName: string
  enabled: string
  filterClause: string
  comments: string
}

interface MaskAction {
  policyName: string
  schemaName: string
  tableName: string
  columnName: string
  maskFunction: string
}

export default function OgSecurityPanel({ connectionId, onClose, embedded }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'audit' | 'masking' | 'encrypt'>('audit')
  const [auditEnabled, setAuditEnabled] = useState(false)
  const [auditPolicies, setAuditPolicies] = useState<AuditPolicy[]>([])
  const [maskPolicies, setMaskPolicies] = useState<MaskPolicy[]>([])
  const [maskActions, setMaskActions] = useState<MaskAction[]>([])
  const [encryptTables, setEncryptTables] = useState<string[]>([])

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

  const loadAudit = async () => {
    // 检测统一审计开关
    try {
      const res = await q(`SELECT setting FROM pg_settings WHERE name = 'enable_security_policy'`)
      setAuditEnabled((res.rows[0]?.[0] ?? 'off') === 'on')
    } catch { setAuditEnabled(false) }

    // 审计策略列表（gs_auditing_policy）
    try {
      const res = await q(`SELECT
          polname AS policy_name,
          CASE poltype WHEN 'a' THEN 'ACCESS' WHEN 'p' THEN 'PRIVILEGE' ELSE poltype::text END AS policy_type,
          CASE polenabled WHEN true THEN '启用' ELSE '禁用' END AS enabled,
          COALESCE(polcomments, '') AS comments
        FROM gs_auditing_policy
        ORDER BY polname`)
      setAuditPolicies(res.rows.map(r => ({
        policyName: String(r[0] ?? ''),
        policyType: String(r[1] ?? ''),
        enabled:    String(r[2] ?? ''),
        comments:   String(r[3] ?? ''),
      })))
    } catch {
      setAuditPolicies([])
    }
  }

  const loadMasking = async () => {
    // 脱敏策略（gs_masking_policy）
    try {
      const res = await q(`SELECT
          polname AS policy_name,
          CASE polenabled WHEN true THEN '启用' ELSE '禁用' END AS enabled,
          COALESCE(polfilter::text, '') AS filter_clause,
          COALESCE(polcomments, '') AS comments
        FROM gs_masking_policy
        ORDER BY polname`)
      setMaskPolicies(res.rows.map(r => ({
        policyName:   String(r[0] ?? ''),
        enabled:      String(r[1] ?? ''),
        filterClause: String(r[2] ?? ''),
        comments:     String(r[3] ?? ''),
      })))
    } catch {
      setMaskPolicies([])
    }

    // 脱敏动作（关联列）
    try {
      const res = await q(`SELECT
          p.polname AS policy_name,
          n.nspname AS schema_name,
          c.relname AS table_name,
          a.attname AS column_name,
          ma.actfunc AS mask_function
        FROM gs_masking_policy_actions ma
        JOIN gs_masking_policy p ON p.oid = ma.policyoid
        JOIN pg_attribute a ON a.attnum = ma.actcolumn
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        ORDER BY p.polname, n.nspname, c.relname, a.attname`)
      setMaskActions(res.rows.map(r => ({
        policyName:   String(r[0] ?? ''),
        schemaName:   String(r[1] ?? ''),
        tableName:    String(r[2] ?? ''),
        columnName:   String(r[3] ?? ''),
        maskFunction: String(r[4] ?? ''),
      })))
    } catch {
      setMaskActions([])
    }
  }

  const loadEncrypt = async () => {
    // 全密态列加密：识别 encrypted_columns 或 CLIENT_MASTER_KEY 定义
    try {
      const res = await q(`SELECT
          n.nspname || '.' || c.relname AS table_fqn
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attkvtype IS NOT NULL AND a.attkvtype != 0
          AND n.nspname NOT IN ('pg_catalog','information_schema','sys')
        GROUP BY n.nspname, c.relname
        ORDER BY n.nspname, c.relname`)
      setEncryptTables(res.rows.map(r => String(r[0] ?? '')))
    } catch {
      // attkvtype 不存在于非 openGauss
      setEncryptTables([])
    }
  }

  const load = async () => {
    setLoading(true); setError('')
    try {
      if (tab === 'audit')   await loadAudit()
      if (tab === 'masking') await loadMasking()
      if (tab === 'encrypt') await loadEncrypt()
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [tab])

  const TABS = [
    { key: 'audit'   as const, label: '统一审计策略', icon: <Shield size={12} /> },
    { key: 'masking' as const, label: '动态脱敏策略', icon: <EyeOff size={12} /> },
    { key: 'encrypt' as const, label: '全密态识别', icon: <Lock size={12} /> },
  ]

  const inner = (
    <>
        {/* Tabs（嵌入模式在本行右侧并入刷新 + 安全策略状态徽标）*/}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: embedded ? '0 12px' : '0 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--surface-2)' }}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '8px 14px', fontSize: 12, fontWeight: tab === t.key ? 600 : 400,
                color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--accent)' : 'transparent'}`,
                marginBottom: -1,
              }}
            >{t.icon}{t.label}</button>
          ))}
          {embedded && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
                color: auditEnabled ? '#16a34a' : '#ea580c',
                background: auditEnabled ? 'rgba(22,163,74,0.1)' : 'rgba(234,88,12,0.1)',
              }}>安全策略 {auditEnabled ? '已启用' : '未启用'}</span>
              <button onClick={load} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
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

            {/* Audit Tab */}
            {tab === 'audit' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {!auditEnabled && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.06)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8 }}>
                    <AlertTriangle size={13} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                      <b>enable_security_policy 未开启</b>，统一审计策略不生效。
                      需在 postgresql.conf 中设置 <code style={{ background: 'var(--surface-2)', borderRadius: 3, padding: '0 4px' }}>enable_security_policy = on</code> 并重启。
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>
                    审计策略（gs_auditing_policy）— {auditPolicies.length} 条
                  </div>
                  {auditPolicies.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
                      无统一审计策略。使用 <code>CREATE AUDIT POLICY</code> 创建。
                    </div>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['策略名', '类型', '状态', '说明'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {auditPolicies.map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '7px 10px', fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{p.policyName}</td>
                              <td style={{ padding: '7px 10px' }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 4, padding: '1px 5px' }}>{p.policyType}</span>
                              </td>
                              <td style={{ padding: '7px 10px', fontSize: 11, fontWeight: 600, color: p.enabled === '启用' ? '#16a34a' : '#dc2626' }}>{p.enabled}</td>
                              <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{p.comments || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <b>注意：</b>统一审计策略的创建/修改/删除均为高权限操作。变更需超级用户或安全管理员角色，建议通过 SQL 编辑器操作并留存审计记录。
                </div>
              </div>
            )}

            {/* Masking Tab */}
            {tab === 'masking' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>
                    脱敏策略（gs_masking_policy）— {maskPolicies.length} 条
                  </div>
                  {maskPolicies.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
                      无动态脱敏策略。使用 <code>CREATE MASKING POLICY</code> 创建。
                    </div>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['策略名', '状态', '过滤条件', '说明'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {maskPolicies.map((p, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '7px 10px', fontWeight: 600, color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{p.policyName}</td>
                              <td style={{ padding: '7px 10px', fontSize: 11, fontWeight: 600, color: p.enabled === '启用' ? '#16a34a' : '#dc2626' }}>{p.enabled}</td>
                              <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{p.filterClause || '（全量）'}</td>
                              <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{p.comments || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {maskActions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>脱敏列明细（{maskActions.length} 列）</div>
                    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'var(--surface-2)' }}>
                          <tr>
                            {['策略', 'Schema', '表', '列', '脱敏函数'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {maskActions.map((a, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>{a.policyName}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{a.schemaName}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-bright)' }}>{a.tableName}</td>
                              <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <EyeOff size={11} color="var(--warning)" />{a.columnName}
                                </div>
                              </td>
                              <td style={{ padding: '6px 10px' }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--warning)', background: 'rgba(234,88,12,0.1)', borderRadius: 4, padding: '1px 5px' }}>{a.maskFunction}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Encrypt Tab */}
            {tab === 'encrypt' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8 }}>
                  <Eye size={13} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                    <b>全密态（Fully Homomorphic Encryption）</b> 是 openGauss 的数据加密特性：数据在存储、传输、计算时均为密文。
                    此处识别包含加密列（CLIENT MASTER KEY 定义的列级加密）的表。
                  </div>
                </div>

                {encryptTables.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
                    未检测到全密态加密列。
                    如需使用，请配置 <code>GS_KTOOL</code> 密钥服务并通过 <code>CREATE CLIENT MASTER KEY</code> 创建密钥。
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>
                      含加密列的表（{encryptTables.length}）
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {encryptTables.map(t => (
                        <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                          <Lock size={11} color="var(--accent)" />{t}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
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
        style={{ width: 820, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Shield size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>openGauss 高安全特性</span>
          <span style={{
            fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '1px 6px',
            color: auditEnabled ? '#16a34a' : '#ea580c',
            background: auditEnabled ? 'rgba(22,163,74,0.1)' : 'rgba(234,88,12,0.1)',
          }}>安全策略 {auditEnabled ? '已启用' : '未启用'}</span>
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
