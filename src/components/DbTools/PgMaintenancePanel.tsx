// PG2 — PostgreSQL VACUUM / autovacuum / 膨胀分析 / REINDEX / XID 回卷 / 在线消膨胀
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Cpu, AlertTriangle, Play, Search, Copy, CheckCircle } from 'lucide-react'

interface Props {
  connectionId: string
  schema?: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'vacuum' | 'autovac' | 'bloat' | 'reindex' | 'xid' | 'repack'

interface AutovacRow {
  schemaName: string
  tableName: string
  nLiveTup: number
  nDeadTup: number
  deadPct: number
  lastAutovacuum: string
  lastAutoanalyze: string
  vacuumCount: number
}

interface BloatRow {
  schemaName: string
  tableName: string
  realSizeMb: number
  extraSizeMb: number
  extraPct: number
  isIndex: boolean
  bloatDesc: string
}

interface XidRow {
  datname: string
  age: number
  maxFreezeAge: number
  pct: number
  risky: boolean
}

function fmtTime(s: string) {
  if (!s || s === 'null' || s === '') return '—'
  try { return new Date(s).toLocaleString() } catch { return s }
}

export default function PgMaintenancePanel({ connectionId, schema, onClose, embedded }: Props) {
  const [tab, setTab] = useState<Tab>('vacuum')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  // Vacuum tab
  const [vacTable, setVacTable] = useState('')
  const [vacMode, setVacMode] = useState<'VACUUM' | 'VACUUM FULL' | 'ANALYZE'>('VACUUM')
  const [vacVerbose, setVacVerbose] = useState(false)

  // Autovacuum tab
  const [autovacRows, setAutovacRows] = useState<AutovacRow[]>([])

  // Bloat tab
  const [bloatRows, setBloatRows] = useState<BloatRow[]>([])

  // Reindex tab
  const [reindexTarget, setReindexTarget] = useState<'INDEX' | 'TABLE' | 'DATABASE'>('TABLE')
  const [reindexName, setReindexName] = useState('')
  const [reindexConcurrently, setReindexConcurrently] = useState(true)

  // XID tab
  const [xidRows, setXidRows] = useState<XidRow[]>([])

  // Repack tab
  interface RepackExtInfo { hasPgRepack: boolean; hasPgSqueeze: boolean }
  interface RepackTarget { schema: string; table: string; totalMb: number; deadPct: number }
  const [repackExt, setRepackExt] = useState<RepackExtInfo | null>(null)
  const [repackTargets, setRepackTargets] = useState<RepackTarget[]>([])
  const [repackTool, setRepackTool] = useState<'pg_repack' | 'pg_squeeze'>('pg_repack')
  const [repackTable, setRepackTable] = useState('')
  const [repackDbUser, setRepackDbUser] = useState('')
  const [repackDbHost, setRepackDbHost] = useState('localhost')
  const [repackDbPort, setRepackDbPort] = useState('5432')
  const [repackDbName, setRepackDbName] = useState('')
  const [repackCopied, setRepackCopied] = useState(false)

  // 动态表列表（用于 vacuum/reindex TABLE 选择）
  const [tableList, setTableList] = useState<string[]>([])
  useEffect(() => {
    if (!schema) return
    invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema })
      .then(list => setTableList(list.filter(t => !t.isView).map(t => t.name)))
      .catch(() => {})
  }, [connectionId, schema])

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

  const loadAutovac = async () => {
    setLoading(true); setError('')
    try {
      const schemaFilter = schema ? `AND schemaname = '${schema}'` : "AND schemaname NOT IN ('pg_catalog','information_schema','pg_toast')"
      const res = await q(`SELECT schemaname, relname,
          n_live_tup, n_dead_tup,
          CASE WHEN n_live_tup + n_dead_tup > 0
            THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1) ELSE 0 END AS dead_pct,
          COALESCE(last_autovacuum::text, '') AS last_autovacuum,
          COALESCE(last_autoanalyze::text, '') AS last_autoanalyze,
          autovacuum_count + vacuum_count AS vacuum_count
        FROM pg_stat_user_tables
        WHERE 1=1 ${schemaFilter}
        ORDER BY n_dead_tup DESC
        LIMIT 50`)
      setAutovacRows(res.rows.map(r => ({
        schemaName:     String(r[0] ?? ''),
        tableName:      String(r[1] ?? ''),
        nLiveTup:       Number(r[2] ?? 0),
        nDeadTup:       Number(r[3] ?? 0),
        deadPct:        Number(r[4] ?? 0),
        lastAutovacuum: String(r[5] ?? ''),
        lastAutoanalyze: String(r[6] ?? ''),
        vacuumCount:    Number(r[7] ?? 0),
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadBloat = async () => {
    setLoading(true); setError('')
    try {
      const schemaFilter = schema ? `AND schemaname = '${schema}'` : "AND schemaname NOT IN ('pg_catalog','information_schema','pg_toast')"
      // Simple bloat estimate using pg_class
      const res = await q(`SELECT schemaname, tablename,
          ROUND(pg_total_relation_size(schemaname||'.'||tablename) / 1024.0 / 1024.0, 2) AS real_mb,
          ROUND((pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) / 1024.0 / 1024.0, 2) AS extra_mb,
          CASE WHEN pg_total_relation_size(schemaname||'.'||tablename) > 0
            THEN ROUND(100.0 * (pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) / pg_total_relation_size(schemaname||'.'||tablename), 1)
            ELSE 0 END AS extra_pct
        FROM pg_tables
        WHERE 1=1 ${schemaFilter}
        ORDER BY extra_mb DESC
        LIMIT 30`)
      setBloatRows(res.rows.map(r => ({
        schemaName:  String(r[0] ?? ''),
        tableName:   String(r[1] ?? ''),
        realSizeMb:  Number(r[2] ?? 0),
        extraSizeMb: Number(r[3] ?? 0),
        extraPct:    Number(r[4] ?? 0),
        isIndex:     false,
        bloatDesc:   '',
      })))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadXid = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT datname,
          age(datfrozenxid) AS age,
          CAST(current_setting('autovacuum_freeze_max_age') AS bigint) AS max_freeze_age
        FROM pg_database
        WHERE datname NOT IN ('template0', 'template1')
        ORDER BY age DESC`)
      setXidRows(res.rows.map(r => {
        const age = Number(r[1] ?? 0)
        const maxAge = Number(r[2] ?? 200000000)
        return {
          datname: String(r[0] ?? ''),
          age,
          maxFreezeAge: maxAge,
          pct: Math.round((age / maxAge) * 100),
          risky: age > maxAge * 0.8,
        }
      }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadRepack = async () => {
    setLoading(true); setError('')
    try {
      const extRes = await q(`SELECT name FROM pg_available_extensions WHERE name IN ('pg_repack','pg_squeeze')`)
      const installed = extRes.rows.map(r => String(r[0] ?? ''))
      const extInstalled = await q(`SELECT extname FROM pg_extension WHERE extname IN ('pg_repack','pg_squeeze')`)
      const activeExts = extInstalled.rows.map(r => String(r[0] ?? ''))
      setRepackExt({
        hasPgRepack: activeExts.includes('pg_repack'),
        hasPgSqueeze: activeExts.includes('pg_squeeze'),
      })
      const schemaFilter = schema ? `AND schemaname = '${schema.replace(/'/g, "''")}'` : `AND schemaname = 'public'`
      const targets = await q(`SELECT schemaname, relname,
          ROUND(pg_total_relation_size(schemaname||'.'||relname) / 1024.0 / 1024.0, 1) AS total_mb,
          CASE WHEN n_live_tup + n_dead_tup > 0
            THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1) ELSE 0 END AS dead_pct
        FROM pg_stat_user_tables
        WHERE 1=1 ${schemaFilter}
          AND (n_live_tup + n_dead_tup) > 10000
        ORDER BY n_dead_tup DESC
        LIMIT 20`)
      setRepackTargets(targets.rows.map(r => ({
        schema:   String(r[0] ?? ''),
        table:    String(r[1] ?? ''),
        totalMb:  Number(r[2] ?? 0),
        deadPct:  Number(r[3] ?? 0),
      })))
      // 从连接读库名
      const dbRes = await q(`SELECT current_database(), current_user`)
      setRepackDbName(String(dbRes.rows[0]?.[0] ?? ''))
      setRepackDbUser(String(dbRes.rows[0]?.[1] ?? ''))
      if (installed.length > 0 && !activeExts.includes('pg_repack')) {
        setRepackTool(activeExts.includes('pg_squeeze') ? 'pg_squeeze' : 'pg_repack')
      }
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  useEffect(() => {
    if (tab === 'autovac') loadAutovac()
    else if (tab === 'bloat') loadBloat()
    else if (tab === 'xid') loadXid()
    else if (tab === 'repack') loadRepack()
    setMsg('')
    setError('')
  }, [tab])

  const doVacuum = async () => {
    const tgt = vacTable.trim()
      ? (schema ? `"${schema}"."${vacTable.trim()}"` : `"${vacTable.trim()}"`)
      : (schema ? `"${schema}"` : null)

    let sql = vacMode
    if (vacVerbose && vacMode !== 'ANALYZE') sql += ' (VERBOSE)'
    if (tgt) sql += ` ${tgt}`
    else if (!tgt && vacMode === 'VACUUM FULL') sql = 'VACUUM FULL'

    const warningMsg = vacMode === 'VACUUM FULL'
      ? `⚠ VACUUM FULL 会持有 ACCESS EXCLUSIVE 锁，期间无法读写，并需要约 2× 磁盘空间！\n\n执行：${sql}\n\n确认继续？`
      : `确认执行：${sql}`
    if (!window.confirm(warningMsg)) return

    setRunning(true); setMsg(''); setError('')
    try {
      await q(sql)
      setMsg(`✓ ${sql} 执行完成`)
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  const doReindex = async () => {
    if (!reindexName.trim()) { setMsg('请输入目标名称'); return }
    const concurrent = reindexConcurrently ? ' CONCURRENTLY' : ''
    const sql = `REINDEX${concurrent} ${reindexTarget} ${
      schema && reindexTarget !== 'DATABASE' ? `"${schema}"."${reindexName.trim()}"` : `"${reindexName.trim()}"`
    }`
    if (!window.confirm(`确认执行：${sql}${!reindexConcurrently ? '\n\n⚠ 非 CONCURRENTLY 模式会锁写，建议使用 CONCURRENTLY（需 PG 12+）' : ''}`)) return

    setRunning(true); setMsg(''); setError('')
    try {
      await q(sql)
      setMsg(`✓ ${sql} 完成`)
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'vacuum',   label: 'VACUUM / ANALYZE' },
    { key: 'autovac',  label: 'autovacuum 监控' },
    { key: 'bloat',    label: '膨胀分析' },
    { key: 'reindex',  label: 'REINDEX' },
    { key: 'xid',      label: 'XID 回卷预警' },
    { key: 'repack',   label: '在线消膨胀' },
  ]

  const inner = (
    <>
        {/* Tabs（嵌入模式把刷新并进本行右侧，省去标题栏） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
          {TABS.map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>{label}</button>
          ))}
          {embedded && (
            <button onClick={() => { if (tab === 'autovac') loadAutovac(); else if (tab === 'bloat') loadBloat(); else if (tab === 'xid') loadXid(); else if (tab === 'repack') loadRepack() }}
              style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0, background: 'transparent', cursor: 'pointer' }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: embedded ? 12 : 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {msg && <div style={{ padding: '8px 12px', borderRadius: 6, background: msg.startsWith('✓') ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)', color: msg.startsWith('✓') ? '#16a34a' : '#dc2626', fontSize: 12 }}>{msg}</div>}
          {error && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>{error}</div>}

          {/* VACUUM */}
          {tab === 'vacuum' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '12px 14px', background: 'rgba(234,88,12,0.06)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                <b>VACUUM</b>：回收死元组空间，不缩小文件（允许读写）<br />
                <b>VACUUM FULL</b>：重写整表，回收磁盘空间（锁写，需 ×2 磁盘，生产谨慎）<br />
                <b>ANALYZE</b>：更新统计信息，改善查询计划
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['VACUUM', 'VACUUM FULL', 'ANALYZE'] as const).map(m => (
                  <button key={m} onClick={() => setVacMode(m)} style={{
                    padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    background: vacMode === m ? (m === 'VACUUM FULL' ? '#dc2626' : 'var(--accent)') : 'var(--surface-2)',
                    color: vacMode === m ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${vacMode === m ? (m === 'VACUUM FULL' ? '#dc2626' : 'var(--accent)') : 'var(--border)'}`,
                  }}>{m}</button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={vacTable} onChange={e => setVacTable(e.target.value)}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                  <option value="">— 整个 {schema ?? 'schema'} —</option>
                  {tableList.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                  <input type="checkbox" checked={vacVerbose} onChange={e => setVacVerbose(e.target.checked)} />
                  VERBOSE
                </label>
              </div>

              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '8px 12px', borderRadius: 6 }}>
                {vacMode}{vacVerbose && vacMode !== 'ANALYZE' ? ' (VERBOSE)' : ''} {
                  vacTable.trim()
                    ? (schema ? `"${schema}"."${vacTable.trim()}"` : `"${vacTable.trim()}"`)
                    : (schema ? `"${schema}"` : '<当前 search_path>')
                }
              </div>

              <button onClick={doVacuum} disabled={running}
                style={{ padding: '8px 20px', borderRadius: 8, background: vacMode === 'VACUUM FULL' ? '#dc2626' : 'var(--accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, width: 'fit-content', opacity: running ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Play size={13} /> {running ? '执行中…' : '执行'}
              </button>
            </div>
          )}

          {/* Autovacuum */}
          {tab === 'autovac' && (
            loading ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div> :
            autovacRows.length === 0 ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无数据</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  <tr>
                    {['Schema', '表名', '活行', '死行', '死行%', '上次 autovacuum', '上次 autoanalyze', 'VACUUM 次数'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {autovacRows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: r.deadPct > 20 ? 'rgba(234,88,12,0.04)' : '' }}>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.schemaName}</td>
                      <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.tableName}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.nLiveTup.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: r.nDeadTup > 10000 ? '#dc2626' : 'var(--text-muted)' }}>{r.nDeadTup.toLocaleString()}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: r.deadPct > 20 ? '#ea580c' : 'var(--text-muted)', fontWeight: r.deadPct > 20 ? 600 : 400 }}>{r.deadPct}%</td>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 10 }}>{fmtTime(r.lastAutovacuum)}</td>
                      <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontSize: 10 }}>{fmtTime(r.lastAutoanalyze)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.vacuumCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* Bloat */}
          {tab === 'bloat' && (
            loading ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div> :
            bloatRows.length === 0 ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无数据</div> : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>额外空间 = 总大小 − 表数据大小（含索引/TOAST），高膨胀建议 VACUUM 或 VACUUM FULL（生产谨慎）</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['Schema', '表名', '总大小', '额外空间', '膨胀率'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bloatRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.schemaName}</td>
                        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.tableName}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.realSizeMb.toFixed(1)} MB</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: r.extraSizeMb > 100 ? '#ea580c' : 'var(--text-muted)' }}>{r.extraSizeMb.toFixed(1)} MB</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: r.extraPct > 50 ? '#dc2626' : r.extraPct > 30 ? '#ea580c' : 'var(--text-muted)', fontWeight: r.extraPct > 30 ? 600 : 400 }}>{r.extraPct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          )}

          {/* Reindex */}
          {tab === 'reindex' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ padding: '10px 14px', background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(22,163,74,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text)' }}>
                <b>REINDEX CONCURRENTLY</b>（12+）：在线重建索引，期间允许 DML，推荐生产使用。<br />
                <b>REINDEX</b>（普通）：持有 SHARE 锁，阻塞写，适合维护窗口。
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {(['INDEX', 'TABLE', 'DATABASE'] as const).map(t => (
                  <button key={t} onClick={() => setReindexTarget(t)} style={{
                    padding: '5px 12px', borderRadius: 6, fontSize: 12,
                    background: reindexTarget === t ? 'var(--accent)' : 'var(--surface-2)',
                    color: reindexTarget === t ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${reindexTarget === t ? 'var(--accent)' : 'var(--border)'}`,
                  }}>{t}</button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {reindexTarget === 'TABLE' ? (
                  <select value={reindexName} onChange={e => setReindexName(e.target.value)}
                    style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                    <option value="">— 选择表 —</option>
                    {tableList.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                ) : (
                  <input value={reindexName} onChange={e => setReindexName(e.target.value)}
                    placeholder={reindexTarget === 'INDEX' ? '索引名' : '数据库名'}
                    style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', fontSize: 12 }} />
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', cursor: 'pointer' }}>
                  <input type="checkbox" checked={reindexConcurrently} onChange={e => setReindexConcurrently(e.target.checked)} />
                  CONCURRENTLY（PG 12+）
                </label>
              </div>

              <button onClick={doReindex} disabled={running || !reindexName.trim()}
                style={{ padding: '8px 20px', borderRadius: 8, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, width: 'fit-content', opacity: (running || !reindexName.trim()) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Search size={13} /> {running ? '执行中…' : '执行 REINDEX'}
              </button>
            </div>
          )}

          {/* Online Defrag */}
          {tab === 'repack' && (
            loading ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* 扩展状态 */}
                {repackExt && (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {([['pg_repack', repackExt.hasPgRepack], ['pg_squeeze', repackExt.hasPgSqueeze]] as const).map(([name, installed]) => (
                      <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 7, background: installed ? 'rgba(22,163,74,0.08)' : 'rgba(234,88,12,0.07)', border: `1px solid ${installed ? 'rgba(22,163,74,0.25)' : 'rgba(234,88,12,0.25)'}` }}>
                        {installed ? <CheckCircle size={12} color="var(--success)" /> : <AlertTriangle size={12} color="var(--warning)" />}
                        <span style={{ fontSize: 12, color: installed ? '#16a34a' : '#ea580c', fontWeight: 600 }}>{name}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{installed ? '已安装' : '未安装'}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 说明 */}
                <div style={{ padding: '10px 14px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: 8, fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
                  <b>pg_repack</b> / <b>pg_squeeze</b> 可在线重组表与索引，全程不持有 ACCESS EXCLUSIVE 锁（仅在最后切换时极短时间锁表），是替代 <code>VACUUM FULL</code> 的生产首选方案。<br />
                  <b>注意：</b>这是客户端命令行工具，需要在数据库服务器可访问的机器上执行，本工具负责生成命令。
                </div>

                {(!repackExt?.hasPgRepack && !repackExt?.hasPgSqueeze) && (
                  <div style={{ padding: '10px 14px', background: 'rgba(234,88,12,0.07)', border: '1px solid rgba(234,88,12,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--warning)' }}>
                    两个扩展均未安装。安装方法：<code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 5px' }}>apt install postgresql-14-repack</code> 或 <code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 5px' }}>yum install pg_repack14</code>，然后 <code style={{ background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 5px' }}>CREATE EXTENSION pg_repack;</code>
                  </div>
                )}

                {/* 工具选择 */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['pg_repack', 'pg_squeeze'] as const).map(tool => (
                    <button key={tool} onClick={() => setRepackTool(tool)} style={{
                      padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                      background: repackTool === tool ? 'var(--accent)' : 'var(--surface-2)',
                      color: repackTool === tool ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${repackTool === tool ? 'var(--accent)' : 'var(--border)'}`,
                    }}>{tool}</button>
                  ))}
                </div>

                {/* 连接参数（用于生成命令） */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 1fr', gap: 8 }}>
                  {[
                    ['主机', repackDbHost, setRepackDbHost, 'localhost'],
                    ['端口', repackDbPort, setRepackDbPort, '5432'],
                    ['用户', repackDbUser, setRepackDbUser, ''],
                    ['数据库', repackDbName, setRepackDbName, ''],
                  ].map(([label, val, setter, placeholder]) => (
                    <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label as string}</label>
                      <input value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)} placeholder={placeholder as string}
                        style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }} />
                    </div>
                  ))}
                </div>

                {/* 表选择 */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>目标表（留空=整库）</label>
                    <input value={repackTable} onChange={e => setRepackTable(e.target.value)}
                      placeholder="schema.table_name（不填则重组整个数据库所有表）"
                      style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }} />
                  </div>
                </div>

                {/* 命令预览 */}
                {(() => {
                  const tFlag = repackTable.trim() ? `-t ${repackTable.trim()}` : ''
                  const cmd = repackTool === 'pg_repack'
                    ? `pg_repack -h ${repackDbHost} -p ${repackDbPort} -U ${repackDbUser || '<user>'} -d ${repackDbName || '<dbname>'} ${tFlag} --no-order`
                    : `# pg_squeeze 通过 SQL 调用扩展函数\n-- 选择要压缩的表：\nSELECT squeeze.squeeze_table('${(repackTable.trim() || 'public.your_table').replace('.', "', '")}');`
                  return (
                    <div style={{ background: 'var(--surface-2)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>生成命令（在服务器端执行）</span>
                        <button onClick={() => { navigator.clipboard.writeText(cmd); setRepackCopied(true); setTimeout(() => setRepackCopied(false), 1500) }}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: repackCopied ? '#16a34a' : 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                          {repackCopied ? <CheckCircle size={11} /> : <Copy size={11} />}
                          {repackCopied ? '已复制' : '复制'}
                        </button>
                      </div>
                      <pre style={{ margin: 0, padding: '10px 12px', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{cmd}</pre>
                    </div>
                  )
                })()}

                {/* 膨胀靶表推荐 */}
                {repackTargets.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>推荐处理的膨胀表（死行&gt;0，&gt;1万行）</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ background: 'var(--surface-2)' }}>
                        <tr>
                          {['Schema', '表名', '总大小', '死行率', '操作'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {repackTargets.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '5px 10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{r.schema}</td>
                            <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.table}</td>
                            <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.totalMb} MB</td>
                            <td style={{ padding: '5px 10px', textAlign: 'right', color: r.deadPct > 20 ? '#dc2626' : r.deadPct > 10 ? '#ea580c' : 'var(--text-muted)', fontWeight: r.deadPct > 10 ? 600 : 400 }}>{r.deadPct}%</td>
                            <td style={{ padding: '5px 10px' }}>
                              <button onClick={() => setRepackTable(`${r.schema}.${r.table}`)}
                                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                选择
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )
          )}

          {/* XID Wraparound */}
          {tab === 'xid' && (
            loading ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div> :
            xidRows.length === 0 ? <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 12 }}>无数据</div> : (
              <>
                {xidRows.some(r => r.risky) && (
                  <div style={{ padding: '10px 12px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, display: 'flex', gap: 8 }}>
                    <AlertTriangle size={14} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: 'var(--error)', lineHeight: 1.7 }}>
                      <b>XID 回卷风险！</b> 有数据库 XID 年龄超过 autovacuum_freeze_max_age 的 80%。<br />
                      若年龄达到 2^31 ≈ 21 亿将导致数据库停摆。立即对受影响数据库执行 <code>VACUUM (FREEZE, VERBOSE)</code>。
                    </div>
                  </div>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['数据库', 'datfrozenxid 年龄', 'autovacuum_freeze_max_age', '使用率', '状态'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {xidRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: r.risky ? 'rgba(220,38,38,0.06)' : '' }}>
                        <td style={{ padding: '8px 10px', fontWeight: 600, color: r.risky ? '#dc2626' : 'var(--text-bright)' }}>{r.datname}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{r.age.toLocaleString()}</td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.maxFreezeAge.toLocaleString()}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(r.pct, 100)}%`, height: '100%', borderRadius: 3, background: r.pct > 80 ? '#dc2626' : r.pct > 60 ? '#ea580c' : '#16a34a', transition: 'width 0.3s' }} />
                            </div>
                            <span style={{ fontSize: 11, color: r.risky ? '#dc2626' : 'var(--text-muted)', fontWeight: r.risky ? 600 : 400, minWidth: 36 }}>{r.pct}%</span>
                          </div>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: r.risky ? '#dc2626' : '#16a34a', background: r.risky ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.1)', padding: '2px 7px', borderRadius: 4 }}>
                            {r.risky ? '⚠ 危险' : '正常'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          )}
        </div>
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳（刷新已并入 Tabs 行）
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
        style={{ width: 800, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Cpu size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>PG 维护中心</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>· {schema}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => { if (tab === 'autovac') loadAutovac(); else if (tab === 'bloat') loadBloat(); else if (tab === 'xid') loadXid(); else if (tab === 'repack') loadRepack() }}
              style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
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
