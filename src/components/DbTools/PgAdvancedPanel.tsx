// PG4 — PostgreSQL 高级对象：扩展管理 / 物化视图 / 表空间 / RLS / 序列 / 大对象
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Package, Layers, HardDrive, Shield, Database, AlertTriangle, Play, Archive } from 'lucide-react'

interface Props {
  connectionId: string
  schema?: string
  onClose: () => void
  onRunSql?: (sql: string) => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'extensions' | 'matviews' | 'tablespaces' | 'rls' | 'sequences' | 'largeobj'

interface LargeObjSummary {
  totalCount: number
  totalSizeMb: number
  ownedCount: number
  orphanCount: number
}

interface ToastTable {
  schemaName: string
  tableName: string
  toastSizeMb: number
  toastRelname: string
}

interface Extension {
  name: string
  defaultVersion: string
  installedVersion: string | null
  comment: string
}

interface MatView {
  schemaName: string
  matViewName: string
  isPopulated: boolean
  lastRefresh: string | null
  rowEstimate: number
  sizeMb: number
  hasUniqueIndex: boolean
}

interface Tablespace {
  name: string
  owner: string
  location: string
  sizeMb: number
  optString: string
}

interface RlsPolicy {
  schemaName: string
  tableName: string
  rlsEnabled: boolean
  policyName: string
  roles: string
  cmd: string
  usingExpr: string
  withCheckExpr: string
}

interface PgSequence {
  schemaName: string
  sequenceName: string
  dataType: string
  startValue: string
  minValue: string
  maxValue: string
  increment: string
  cycleOption: string
  lastValue: string | null
  nearExhaust: boolean
}

export default function PgAdvancedPanel({ connectionId, schema, onClose, onRunSql, embedded }: Props) {
  const [tab, setTab] = useState<Tab>('extensions')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [extensions, setExtensions] = useState<Extension[]>([])
  const [showAllExt, setShowAllExt] = useState(false)
  const [matViews, setMatViews] = useState<MatView[]>([])
  const [tablespaces, setTablespaces] = useState<Tablespace[]>([])
  const [policies, setPolicies] = useState<RlsPolicy[]>([])
  const [sequences, setSequences] = useState<PgSequence[]>([])
  const [largeObjSummary, setLargeObjSummary] = useState<LargeObjSummary | null>(null)
  const [toastTables, setToastTables] = useState<ToastTable[]>([])

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

  const loadExtensions = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT ae.name,
          COALESCE(ae.default_version, ''),
          ie.extversion AS installed_version,
          COALESCE(ae.comment, '')
        FROM pg_available_extensions ae
        LEFT JOIN pg_extension ie ON ie.extname = ae.name
        ORDER BY (ie.extversion IS NOT NULL) DESC, ae.name`)
      setExtensions(res.rows.map(r => ({
        name:             String(r[0] ?? ''),
        defaultVersion:   String(r[1] ?? ''),
        installedVersion: r[2] ? String(r[2]) : null,
        comment:          String(r[3] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadMatViews = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT mv.schemaname, mv.matviewname,
          mv.ispopulated,
          NULL::text AS last_refresh,
          mvc.reltuples::bigint,
          pg_total_relation_size(mvc.oid) / 1024 / 1024,
          EXISTS (
            SELECT 1 FROM pg_index pi
            WHERE pi.indrelid = mvc.oid AND pi.indisunique
          )
        FROM pg_matviews mv
        JOIN pg_namespace mvn ON mvn.nspname = mv.schemaname
        JOIN pg_class mvc ON mvc.relname = mv.matviewname AND mvc.relnamespace = mvn.oid
        ORDER BY mv.schemaname, mv.matviewname`)
      setMatViews(res.rows.map(r => ({
        schemaName:    String(r[0] ?? ''),
        matViewName:   String(r[1] ?? ''),
        isPopulated:   r[2] === 't' || r[2] === 'true' || r[2] === '1',
        lastRefresh:   r[3] ? String(r[3]) : null,
        rowEstimate:   Number(r[4] ?? 0),
        sizeMb:        Number(r[5] ?? 0),
        hasUniqueIndex:r[6] === 't' || r[6] === 'true' || r[6] === '1',
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadTablespaces = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT spcname,
          pg_catalog.pg_get_userbyid(spcowner),
          COALESCE(pg_catalog.pg_tablespace_location(oid), '(默认)'),
          COALESCE(pg_tablespace_size(oid) / 1024 / 1024, 0)::bigint,
          COALESCE(spcoptions::text, '')
        FROM pg_tablespace
        ORDER BY spcname`)
      setTablespaces(res.rows.map(r => ({
        name:      String(r[0] ?? ''),
        owner:     String(r[1] ?? ''),
        location:  String(r[2] ?? ''),
        sizeMb:    Number(r[3] ?? 0),
        optString: String(r[4] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadRls = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT n.nspname, c.relname,
          c.relrowsecurity,
          COALESCE(p.polname, ''),
          COALESCE(array_to_string(p.polroles::regrole[], ', '), 'PUBLIC'),
          COALESCE(p.polcmd::text, ''),
          COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
          COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relkind = 'r' AND c.relrowsecurity = true
        ORDER BY n.nspname, c.relname, p.polname`)
      setPolicies(res.rows.map(r => ({
        schemaName:   String(r[0] ?? ''),
        tableName:    String(r[1] ?? ''),
        rlsEnabled:   r[2] === 't' || r[2] === 'true',
        policyName:   String(r[3] ?? ''),
        roles:        String(r[4] ?? ''),
        cmd:          String(r[5] ?? ''),
        usingExpr:    String(r[6] ?? ''),
        withCheckExpr:String(r[7] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadSequences = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT sequence_schema, sequence_name,
          data_type,
          start_value::text, minimum_value::text, maximum_value::text,
          increment::text, cycle_option,
          NULL::text AS last_value
        FROM information_schema.sequences
        ORDER BY sequence_schema, sequence_name`)
      setSequences(res.rows.map(r => {
        const maxVal = String(r[5] ?? '')
        const lastVal = r[8] ? String(r[8]) : null
        const pct = lastVal && maxVal ? Number(lastVal) / Number(maxVal) : 0
        return {
          schemaName:   String(r[0] ?? ''),
          sequenceName: String(r[1] ?? ''),
          dataType:     String(r[2] ?? ''),
          startValue:   String(r[3] ?? ''),
          minValue:     String(r[4] ?? ''),
          maxValue:     maxVal,
          increment:    String(r[6] ?? ''),
          cycleOption:  String(r[7] ?? ''),
          lastValue:    lastVal,
          nearExhaust:  pct > 0.9,
        }
      }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadLargeObj = async () => {
    setLoading(true); setError('')
    try {
      const summaryRes = await q(`SELECT
          count(DISTINCT loid)::bigint,
          COALESCE(sum(length(data))::bigint / 1024 / 1024, 0)::bigint,
          count(DISTINCT loid) FILTER (WHERE lomowner <> 0)::bigint,
          count(DISTINCT loid) FILTER (WHERE lomowner = 0)::bigint
        FROM pg_largeobject
        LEFT JOIN pg_largeobject_metadata ON pg_largeobject_metadata.oid = pg_largeobject.loid`)
      if (summaryRes.rows.length > 0) {
        const r = summaryRes.rows[0]
        setLargeObjSummary({
          totalCount:  Number(r[0] ?? 0),
          totalSizeMb: Number(r[1] ?? 0),
          ownedCount:  Number(r[2] ?? 0),
          orphanCount: Number(r[3] ?? 0),
        })
      }
      const toastRes = await q(`SELECT n.nspname, c.relname,
          pg_total_relation_size(t.oid) / 1024 / 1024,
          t.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class t ON t.oid = c.reltoastrelid
        WHERE c.relkind = 'r' AND c.reltoastrelid <> 0
          AND pg_total_relation_size(t.oid) > 1024 * 1024
        ORDER BY pg_total_relation_size(t.oid) DESC
        LIMIT 30`)
      setToastTables(toastRes.rows.map(r => ({
        schemaName:  String(r[0] ?? ''),
        tableName:   String(r[1] ?? ''),
        toastSizeMb: Number(r[2] ?? 0),
        toastRelname:String(r[3] ?? ''),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadTab = () => {
    if (tab === 'extensions') loadExtensions()
    else if (tab === 'matviews') loadMatViews()
    else if (tab === 'tablespaces') loadTablespaces()
    else if (tab === 'rls') loadRls()
    else if (tab === 'sequences') loadSequences()
    else loadLargeObj()
  }

  useEffect(() => { loadTab() }, [tab])

  const confirmAndRun = (sql: string, confirmMsg: string) => {
    if (!window.confirm(confirmMsg)) return
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const dropExt = (name: string) => confirmAndRun(
    `DROP EXTENSION IF EXISTS "${name}" CASCADE;`,
    `确认删除扩展 "${name}"？\n\nCASCADE 将删除所有依赖此扩展的对象，此操作不可逆。`
  )

  const installExt = (name: string) => {
    if (onRunSql) { onRunSql(`CREATE EXTENSION IF NOT EXISTS "${name}";`); onClose() }
  }

  const refreshMatView = (schemaName: string, matViewName: string, concurrent: boolean, hasUnique: boolean) => {
    if (concurrent && !hasUnique) {
      window.alert('CONCURRENTLY 刷新需要物化视图上存在唯一索引，当前视图无唯一索引，请先创建。')
      return
    }
    const sql = concurrent
      ? `REFRESH MATERIALIZED VIEW CONCURRENTLY "${schemaName}"."${matViewName}";`
      : `REFRESH MATERIALIZED VIEW "${schemaName}"."${matViewName}";`
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  const displayExt = showAllExt ? extensions : extensions.filter(e => e.installedVersion !== null || showAllExt)

  const inner = (
    <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
          {([
            ['extensions', '扩展管理', <Package size={11} />],
            ['matviews', '物化视图', <Layers size={11} />],
            ['tablespaces', '表空间', <HardDrive size={11} />],
            ['rls', '行级安全 (RLS)', <Shield size={11} />],
            ['sequences', '序列', <Database size={11} />],
            ['largeobj', '大对象 / TOAST', <Archive size={11} />],
          ] as const).map(([key, label, icon]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>
              {icon}{label}
            </button>
          ))}
          {embedded && (
            <button onClick={loadTab} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>{error}</div>}
          {loading && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}

          {/* 扩展管理 */}
          {!loading && tab === 'extensions' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  已安装: {extensions.filter(e => e.installedVersion).length} / {extensions.length}
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginLeft: 'auto', color: 'var(--text-muted)' }}>
                  <input type="checkbox" checked={showAllExt} onChange={e => setShowAllExt(e.target.checked)} />
                  显示全部可用扩展
                </label>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['扩展名', '已安装版本', '可用版本', '说明', '操作'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayExt.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: e.installedVersion ? '' : 'transparent' }}>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{e.name}</td>
                      <td style={{ padding: '7px 10px', color: e.installedVersion ? '#16a34a' : 'var(--text-muted)' }}>
                        {e.installedVersion ?? '未安装'}
                      </td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{e.defaultVersion}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.comment}>{e.comment}</td>
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                        {e.installedVersion ? (
                          <button onClick={() => dropExt(e.name)} style={{ fontSize: 10, color: 'var(--error)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(220,38,38,0.4)', background: 'rgba(220,38,38,0.06)' }}>
                            删除
                          </button>
                        ) : (
                          <button onClick={() => installExt(e.name)} style={{ fontSize: 10, color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(var(--accent-rgb),0.4)', background: 'var(--accent-bg)' }}>
                            安装
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 物化视图 */}
          {!loading && tab === 'matviews' && (
            matViews.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无物化视图</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['Schema.视图', '已填充', '估算行数', '大小', '唯一索引', '操作'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matViews.map((v, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{v.schemaName}.{v.matViewName}</td>
                      <td style={{ padding: '7px 10px', color: v.isPopulated ? '#16a34a' : '#ea580c', fontWeight: 600 }}>{v.isPopulated ? '是' : '否（空）'}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{v.rowEstimate.toLocaleString()}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{v.sizeMb >= 1024 ? `${(v.sizeMb / 1024).toFixed(1)}GB` : `${v.sizeMb.toFixed(1)}MB`}</td>
                      <td style={{ padding: '7px 10px', color: v.hasUniqueIndex ? '#16a34a' : 'var(--text-muted)' }}>{v.hasUniqueIndex ? '有' : '无'}</td>
                      <td style={{ padding: '7px 10px', display: 'flex', gap: 6 }}>
                        <button onClick={() => refreshMatView(v.schemaName, v.matViewName, false, v.hasUniqueIndex)}
                          style={{ fontSize: 10, color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                          <Play size={9} style={{ display: 'inline', marginRight: 3 }} />刷新
                        </button>
                        {v.hasUniqueIndex && (
                          <button onClick={() => refreshMatView(v.schemaName, v.matViewName, true, v.hasUniqueIndex)}
                            style={{ fontSize: 10, color: 'var(--success)', padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(22,163,74,0.4)', background: 'rgba(22,163,74,0.06)' }}>
                            CONCURRENTLY
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* 表空间 */}
          {!loading && tab === 'tablespaces' && (
            tablespaces.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无自定义表空间</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['表空间名', 'Owner', '路径', '占用大小', '选项'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tablespaces.map((ts, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{ts.name}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{ts.owner}</td>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)', fontSize: 10 }}>{ts.location}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text)' }}>
                        {ts.sizeMb >= 1024 ? `${(ts.sizeMb / 1024).toFixed(1)} GB` : `${ts.sizeMb.toFixed(1)} MB`}
                      </td>
                      <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 10 }}>{ts.optString || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* RLS 策略 */}
          {!loading && tab === 'rls' && (
            <>
              {policies.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无启用 RLS 的表</div>
              ) : (
                <>
                  <div style={{ padding: '8px 16px', background: 'rgba(var(--accent-rgb),0.06)', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-muted)' }}>
                    <AlertTriangle size={12} color="var(--accent)" style={{ display: 'inline', marginRight: 6 }} />
                    行级安全策略变更（ALTER TABLE / CREATE POLICY / DROP POLICY）属于安全敏感操作，下方仅展示只读视图。如需修改，请在 SQL 编辑器中执行并确认。
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['Schema.表', '策略名', '角色', '命令', 'USING 表达式', 'WITH CHECK'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {policies.map((p, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{p.schemaName}.{p.tableName}</td>
                          <td style={{ padding: '7px 10px', color: p.policyName ? 'var(--text)' : 'var(--text-muted)' }}>{p.policyName || '（无策略）'}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{p.roles}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--accent)', fontWeight: 600 }}>{p.cmd}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.usingExpr}>{p.usingExpr || '—'}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.withCheckExpr}>{p.withCheckExpr || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}

          {/* 序列 */}
          {!loading && tab === 'sequences' && (
            sequences.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>无序列</div>
            ) : (
              <>
                {sequences.some(s => s.nearExhaust) && (
                  <div style={{ padding: '10px 16px', background: 'rgba(220,38,38,0.08)', borderBottom: '1px solid rgba(220,38,38,0.2)', display: 'flex', gap: 8, fontSize: 12 }}>
                    <AlertTriangle size={14} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: 'var(--error)' }}>存在接近耗尽的序列！请尽快使用 ALTER SEQUENCE ... MAXVALUE / CYCLE 处理，否则 INSERT 将报错。</span>
                  </div>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['Schema.序列名', '数据类型', '当前值', '最大值', '步长', '循环', '状态'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sequences.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: s.nearExhaust ? 'rgba(220,38,38,0.04)' : '' }}>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{s.schemaName}.{s.sequenceName}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{s.dataType}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: s.nearExhaust ? '#dc2626' : 'var(--text)' }}>{s.lastValue ?? '—'}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.maxValue}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.increment}</td>
                        <td style={{ padding: '7px 10px', color: s.cycleOption === 'YES' ? '#16a34a' : 'var(--text-muted)' }}>{s.cycleOption === 'YES' ? '是' : '否'}</td>
                        <td style={{ padding: '7px 10px' }}>
                          {s.nearExhaust ? (
                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--error)', background: 'rgba(220,38,38,0.1)', padding: '2px 7px', borderRadius: 4 }}>⚠ 接近耗尽</span>
                          ) : (
                            <span style={{ color: 'var(--success)', fontSize: 10 }}>正常</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          )}

          {/* 大对象 / TOAST */}
          {!loading && tab === 'largeobj' && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {largeObjSummary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {([
                    ['大对象总数', largeObjSummary.totalCount.toLocaleString()],
                    ['总占用大小', largeObjSummary.totalSizeMb >= 1024 ? `${(largeObjSummary.totalSizeMb / 1024).toFixed(1)} GB` : `${largeObjSummary.totalSizeMb.toFixed(1)} MB`],
                    ['有 Owner', largeObjSummary.ownedCount.toLocaleString()],
                    ['孤立对象', largeObjSummary.orphanCount.toString()],
                  ] as const).map(([label, value]) => (
                    <div key={label} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: label === '孤立对象' && largeObjSummary.orphanCount > 0 ? '#ea580c' : 'var(--text-bright)' }}>{value}</div>
                    </div>
                  ))}
                </div>
              )}
              {largeObjSummary?.orphanCount && largeObjSummary.orphanCount > 0 ? (
                <div style={{ padding: '8px 14px', background: 'rgba(234,88,12,0.06)', borderRadius: 8, border: '1px solid rgba(234,88,12,0.2)', fontSize: 12, color: 'var(--warning)', display: 'flex', gap: 8 }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>存在 {largeObjSummary.orphanCount} 个孤立大对象（lomowner=0），这些对象未被任何用户引用，可能占用磁盘。可使用 <code>vacuumlo</code> 工具清理。</span>
                </div>
              ) : null}

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>TOAST 占用 Top 30（超过 1MB）</div>
                {toastTables.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>无大型 TOAST 表（所有表 TOAST 均 &lt; 1MB）</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['Schema.表名', 'TOAST 表', 'TOAST 大小'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {toastTables.map((t, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{t.schemaName}.{t.tableName}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 10 }}>{t.toastRelname}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: t.toastSizeMb >= 512 ? '#ea580c' : 'var(--text)' }}>
                            {t.toastSizeMb >= 1024 ? `${(t.toastSizeMb / 1024).toFixed(1)} GB` : `${t.toastSizeMb.toFixed(1)} MB`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
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
        style={{ width: 860, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Database size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>PG 高级对象</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {schema}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={loadTab} disabled={loading} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}>
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
