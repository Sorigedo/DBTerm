// MA4.6 — MariaDB 优化器治理（optimizer_switch 开关 + 直方图统计）
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Settings, BarChart2, AlertTriangle, Check } from 'lucide-react'

interface Props {
  connectionId: string
  schema: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type TabKey = 'switch' | 'histogram'

interface SwitchItem {
  key: string
  enabled: boolean
  changed: boolean
}

interface HistRow {
  table:   string
  column:  string
  nulls:   string
  avgLen:  string
  pages:   string
  updated: string
}

export default function OptimizerPanel({ connectionId, schema, onClose, embedded }: Props) {
  const [tab, setTab] = useState<TabKey>('switch')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  // optimizer_switch
  const [switches, setSwitches] = useState<SwitchItem[]>([])
  const [switchFilter, setSwitchFilter] = useState('')

  // 直方图
  const [histRows, setHistRows] = useState<HistRow[]>([])
  const [histTable, setHistTable] = useState('')
  const [analyzeRunning, setAnalyzeRunning] = useState(false)
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

  const loadSwitches = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: "SELECT @@optimizer_switch",
      })
      const raw = res.rows[0]?.[0] ?? ''
      const items: SwitchItem[] = raw.split(',').map(s => {
        const [key, val] = s.trim().split('=')
        return { key: key?.trim() ?? s, enabled: val?.trim() === 'on', changed: false }
      })
      setSwitches(items)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadHistogram = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT db_name, table_name, column_name, \
                     nulls_ratio, avg_length, \
                     avg_frequency, hist_type \
              FROM mysql.column_stats \
              WHERE db_name = '${schema}' \
              ORDER BY table_name, column_name \
              LIMIT 200`,
      })
      setHistRows(res.rows.map(r => ({
        table:   String(r[1] ?? ''),
        column:  String(r[2] ?? ''),
        nulls:   String(r[3] ?? ''),
        avgLen:  String(r[4] ?? ''),
        pages:   String(r[5] ?? ''),
        updated: String(r[6] ?? ''),
      })))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (tab === 'switch') loadSwitches()
    else loadHistogram()
  }, [tab])

  const toggleSwitch = (key: string) => {
    setSwitches(prev => prev.map(s => s.key === key ? { ...s, enabled: !s.enabled, changed: !s.changed !== (s.enabled !== (s.enabled)) } : s))
  }

  const applySwitch = async (persist: boolean) => {
    const changed = switches.filter(s => s.changed)
    if (changed.length === 0) return
    const newVal = switches.map(s => `${s.key}=${s.enabled ? 'on' : 'off'}`).join(',')
    const sql = persist
      ? `SET GLOBAL optimizer_switch='${newVal}'`
      : `SET SESSION optimizer_switch='${newVal}'`
    const confirmMsg = persist
      ? `确认持久化（GLOBAL）修改优化器开关？\n\n将修改: ${changed.map(s => `${s.key}=${s.enabled ? 'on' : 'off'}`).join(', ')}\n\n此操作影响所有新连接！`
      : `确认修改当前会话优化器开关？\n\n将修改: ${changed.map(s => `${s.key}=${s.enabled ? 'on' : 'off'}`).join(', ')}`
    if (!window.confirm(confirmMsg)) return
    setMsg('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql })
      setSwitches(prev => prev.map(s => ({ ...s, changed: false })))
      setMsg(`✓ optimizer_switch 已更新（${persist ? 'GLOBAL' : 'SESSION'}）`)
    } catch (e) {
      setMsg(`错误: ${String(e)}`)
    }
  }

  const doAnalyze = async () => {
    if (!histTable.trim()) { setMsg('请先输入表名'); return }
    if (!window.confirm(`确认执行 ANALYZE TABLE \`${schema}\`.\`${histTable}\` PERSISTENT FOR ALL？\n\n此操作将扫描全表并更新直方图统计信息，可能对大表有一定性能影响。`)) return
    setAnalyzeRunning(true); setMsg('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', {
        id: connectionId,
        sql: `ANALYZE TABLE \`${schema}\`.\`${histTable.trim()}\` PERSISTENT FOR ALL`,
      })
      setMsg(`✓ ${histTable} 直方图统计更新完成`)
      loadHistogram()
    } catch (e) {
      setMsg(`错误: ${String(e)}`)
    } finally {
      setAnalyzeRunning(false)
    }
  }

  const filtered = switches.filter(s => !switchFilter || s.key.toLowerCase().includes(switchFilter.toLowerCase()))

  const inner = (
    <>
        {/* Tab */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {([['switch', 'optimizer_switch 开关', Settings], ['histogram', '直方图统计 (column_stats)', BarChart2]] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, fontSize: 12,
                background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
                color: tab === key ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
                fontWeight: tab === key ? 600 : 400,
              }}
            >
              <Icon size={11} />{label}
            </button>
          ))}
          {embedded && (
            <button onClick={() => tab === 'switch' ? loadSwitches() : loadHistogram()} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {msg && (
            <div style={{ padding: '7px 12px', borderRadius: 6, fontSize: 12,
              background: msg.startsWith('✓') ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
              color: msg.startsWith('✓') ? '#16a34a' : '#dc2626',
            }}>
              {msg}
            </div>
          )}
          {error && (
            <div style={{ padding: '7px 12px', borderRadius: 6, fontSize: 12, background: 'rgba(220,38,38,0.08)', color: 'var(--error)' }}>{error}</div>
          )}

          {/* optimizer_switch Tab */}
          {tab === 'switch' && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={switchFilter}
                  onChange={e => setSwitchFilter(e.target.value)}
                  placeholder="搜索开关名…"
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
                />
                {switches.some(s => s.changed) && (
                  <>
                    <button
                      onClick={() => applySwitch(false)}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text)' }}
                    >
                      应用会话
                    </button>
                    <button
                      onClick={() => applySwitch(true)}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'var(--warning)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600 }}
                    >
                      <AlertTriangle size={11} style={{ display: 'inline', marginRight: 4 }} />
                      持久化 GLOBAL
                    </button>
                  </>
                )}
              </div>

              {loading ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                  {filtered.map(s => (
                    <label key={s.key} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                      background: s.changed ? 'rgba(234,88,12,0.06)' : 'var(--surface-2)',
                      border: `1px solid ${s.changed ? 'rgba(234,88,12,0.3)' : 'var(--border)'}`,
                    }}>
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={() => toggleSwitch(s.key)}
                        style={{ accentColor: 'var(--accent)', width: 13, height: 13 }}
                      />
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: s.changed ? '#ea580c' : 'var(--text)', flex: 1 }}>
                        {s.key}
                      </span>
                      {s.changed && <Check size={10} color="var(--warning)" />}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 直方图 Tab */}
          {tab === 'histogram' && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={histTable}
                  onChange={e => setHistTable(e.target.value)}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}
                >
                  <option value="">— 选择表 —</option>
                  {tableList.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <button
                  onClick={doAnalyze}
                  disabled={analyzeRunning || !histTable.trim()}
                  style={{ padding: '5px 12px', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, opacity: !histTable.trim() ? 0.5 : 1 }}
                >
                  {analyzeRunning ? '分析中…' : '更新直方图'}
                </button>
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                以下为 <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface)', padding: '0 3px' }}>mysql.column_stats</code> 中已记录的直方图统计（{schema}）
              </div>

              {loading ? (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
              ) : histRows.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                  暂无统计信息 — 先对指定表执行"更新直方图"后刷新
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                    <tr>
                      {['表名', '列名', 'NULL 率', '平均长度', '平均频次', '直方图类型'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {histRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.table}</td>
                        <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{r.column}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{r.nulls}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{r.avgLen}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{r.pages}</td>
                        <td style={{ padding: '5px 10px', color: 'var(--text-muted)', fontSize: 10 }}>{r.updated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
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
        style={{ width: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Settings size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>优化器治理</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>MariaDB 专属</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="dbt-header-btn" onClick={() => tab === 'switch' ? loadSwitches() : loadHistogram()} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'spin' : ''} />
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
