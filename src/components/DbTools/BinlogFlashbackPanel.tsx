// MA6.1 — binlog 闪回 / 误删恢复
// 策略：检测前提条件 → 列出 binlog 文件 → SHOW BINLOG EVENTS 可视化
// ROW 格式时给出 mysqlbinlog --flashback 命令模板，并提示通过外部工具完成实际回滚
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Undo2, Copy, AlertTriangle, CheckCircle } from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  onClose: () => void
}

interface BinlogFile {
  logName: string
  fileSize: number
  encrypted: string
}

interface BinlogEvent {
  logName: string
  pos: number
  eventType: string
  serverId: number
  endLogPos: number
  info: string
}

type Step = 'check' | 'select' | 'events' | 'flashback'

export default function BinlogFlashbackPanel({ connectionId, connType, onClose }: Props) {
  const supported = connType === 'mysql' || connType === 'mariadb'
  const [step, setStep] = useState<Step>('check')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // Prerequisites
  const [prereq, setPrereq] = useState<{ binlogOn: boolean; isRow: boolean; isFullImage: boolean; host: string; binlogDir: string }>({
    binlogOn: false, isRow: false, isFullImage: false, host: '', binlogDir: '',
  })

  // Binlog list
  const [binlogs, setBinlogs] = useState<BinlogFile[]>([])
  const [selectedLog, setSelectedLog] = useState('')

  // Events
  const [events, setEvents] = useState<BinlogEvent[]>([])
  const [fromPos, setFromPos] = useState('')
  const [untilPos, setUntilPos] = useState('')
  const [filterTable, setFilterTable] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const checkPrereqs = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT Variable_name, Variable_value FROM information_schema.GLOBAL_VARIABLES
              WHERE Variable_name IN ('log_bin','binlog_format','binlog_row_image','hostname','datadir')`,
      })
      const m: Record<string, string> = {}
      for (const r of res.rows) m[String(r[0] ?? '').toLowerCase()] = String(r[1] ?? '')
      setPrereq({
        binlogOn:   m['log_bin'] === 'ON',
        isRow:      (m['binlog_format'] ?? '').toUpperCase() === 'ROW',
        isFullImage:(m['binlog_row_image'] ?? 'FULL').toUpperCase() === 'FULL',
        host:       m['hostname'] ?? '',
        binlogDir:  m['datadir'] ?? '',
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (supported) checkPrereqs() }, [])

  const loadBinlogs = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', { id: connectionId, sql: 'SHOW BINARY LOGS' })
      setBinlogs(res.rows.map(r => ({
        logName:   String(r[0] ?? ''),
        fileSize:  Number(r[1] ?? 0),
        encrypted: String(r[2] ?? 'No'),
      })))
      setStep('select')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadEvents = async () => {
    if (!selectedLog) return
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      let sql = `SHOW BINLOG EVENTS IN '${selectedLog.replace(/'/g, "''")}'`
      if (fromPos) sql += ` FROM ${fromPos}`
      sql += ` LIMIT 200`
      const res = await invoke<R>('execute_query', { id: connectionId, sql })
      const allEvents: BinlogEvent[] = res.rows.map(r => ({
        logName:    String(r[0] ?? ''),
        pos:        Number(r[1] ?? 0),
        eventType:  String(r[2] ?? ''),
        serverId:   Number(r[3] ?? 0),
        endLogPos:  Number(r[4] ?? 0),
        info:       String(r[5] ?? ''),
      }))
      const filtered = filterTable
        ? allEvents.filter(e => e.info.toLowerCase().includes(filterTable.toLowerCase()))
        : allEvents
      setEvents(filtered)
      setStep('events')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const eventTypeColor = (t: string) => {
    if (t.includes('DELETE') || t.includes('ERASE')) return '#dc2626'
    if (t.includes('UPDATE')) return '#ea580c'
    if (t.includes('INSERT') || t.includes('WRITE')) return '#16a34a'
    if (t.includes('DDL') || t.includes('QUERY')) return 'var(--accent)'
    return 'var(--text-muted)'
  }

  const genFlashbackCmd = () => {
    const from = fromPos ? ` --start-position=${fromPos}` : ''
    const until = untilPos ? ` --stop-position=${untilPos}` : ''
    const filterTbl = filterTable ? ` --table=${filterTable}` : ''
    return `mysqlbinlog --flashback${from}${until}${filterTbl} \\\n  --host=<HOST> --port=<PORT> -u <USER> -p \\\n  ${selectedLog} | mysql -h <TARGET> -u <USER> -p`
  }

  const copyCmd = () => {
    navigator.clipboard.writeText(genFlashbackCmd())
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const fmtSize = (b: number) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}M` : `${(b / 1024).toFixed(0)}K`

  // 闪回（binlog）为 MySQL / MariaDB 专属；TiDB / OceanBase 是分布式架构，不执行 MySQL binlog 查询。
  if (!supported) {
    return createPortal(
      <div className="cdlg-overlay" onMouseDown={onClose}>
        <div
          className="cdlg-box"
          onMouseDown={e => e.stopPropagation()}
          style={{ width: 460, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <Undo2 size={14} color="var(--accent)" />
            <span style={{ fontWeight: 600, fontSize: 13 }}>binlog 闪回 / 误删恢复</span>
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
          <div style={{ padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
            <AlertTriangle size={28} color="var(--warning)" />
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
              闪回功能仅支持 MySQL / MariaDB。<br />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>当前数据库类型不提供 binlog 误删恢复。</span>
            </div>
          </div>
        </div>
      </div>,
      document.body
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
          <Undo2 size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>binlog 闪回 / 误删恢复</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={checkPrereqs} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>{error}</div>}
          {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}

          {!loading && (
            <>
              {/* Step 1: 前提条件检查 */}
              <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-bright)', marginBottom: 10 }}>前提条件检查</div>
                {[
                  { label: 'binlog 已开启 (log_bin=ON)', ok: prereq.binlogOn },
                  { label: 'ROW 格式 (binlog_format=ROW)', ok: prereq.isRow },
                  { label: '完整镜像 (binlog_row_image=FULL)', ok: prereq.isFullImage },
                ].map(({ label, ok }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
                    {ok
                      ? <CheckCircle size={13} color="var(--success)" />
                      : <AlertTriangle size={13} color="var(--error)" />}
                    <span style={{ color: ok ? 'var(--text)' : '#dc2626' }}>{label}</span>
                    {!ok && <span style={{ fontSize: 10, color: 'var(--error)' }}>（闪回将无法完全还原）</span>}
                  </div>
                ))}
                {prereq.binlogDir && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                    数据目录：{prereq.binlogDir}
                  </div>
                )}
                {!prereq.isRow && (
                  <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(234,88,12,0.08)', borderRadius: 6, fontSize: 11, color: 'var(--warning)' }}>
                    ⚠ 当前 binlog_format 非 ROW，SHOW BINLOG EVENTS 只能查看 SQL 语句文本，无法生成闪回 DML。
                    需切换为 ROW 格式：SET GLOBAL binlog_format = 'ROW';
                  </div>
                )}
                <button
                  onClick={loadBinlogs}
                  disabled={!prereq.binlogOn}
                  style={{ marginTop: 10, padding: '6px 16px', borderRadius: 7, background: prereq.binlogOn ? 'var(--accent)' : 'var(--surface)', color: prereq.binlogOn ? '#fff' : 'var(--text-muted)', border: 'none', fontSize: 12, fontWeight: 600, opacity: !prereq.binlogOn ? 0.5 : 1 }}
                >
                  查看 binlog 文件列表 →
                </button>
              </div>

              {/* Step 2: 选择 binlog 文件 */}
              {(step === 'select' || step === 'events' || step === 'flashback') && (
                <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: 14, border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-bright)', marginBottom: 10 }}>
                    选择 binlog 文件（共 {binlogs.length} 个）
                  </div>
                  <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 7 }}>
                    {binlogs.map(b => (
                      <button
                        key={b.logName}
                        onClick={() => { setSelectedLog(b.logName); setStep('select') }}
                        style={{
                          width: '100%', textAlign: 'left', padding: '7px 12px',
                          borderBottom: '1px solid var(--border-subtle)',
                          background: selectedLog === b.logName ? 'var(--accent-bg)' : 'transparent',
                          color: selectedLog === b.logName ? 'var(--accent)' : 'var(--text)',
                          display: 'flex', justifyContent: 'space-between', fontSize: 12,
                        }}
                      >
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{b.logName}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{fmtSize(b.fileSize)}</span>
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input value={fromPos} onChange={e => setFromPos(e.target.value)} placeholder="起始 pos（可选）"
                      style={{ width: 140, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }} />
                    <input value={filterTable} onChange={e => setFilterTable(e.target.value)} placeholder="过滤表名（可选）"
                      style={{ width: 160, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }} />
                    <button
                      onClick={loadEvents}
                      disabled={!selectedLog}
                      style={{ padding: '6px 14px', borderRadius: 7, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, opacity: !selectedLog ? 0.5 : 1 }}
                    >
                      查看事件 →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: binlog 事件列表 */}
              {step === 'events' && events.length > 0 && (
                <div style={{ background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>binlog 事件（{events.length} 条，LIMIT 200）</span>
                    <button
                      onClick={() => setStep('flashback')}
                      style={{ padding: '4px 12px', borderRadius: 6, background: 'var(--error)', color: '#fff', border: 'none', fontSize: 11, fontWeight: 600 }}
                    >
                      生成闪回命令 →
                    </button>
                  </div>
                  <div style={{ maxHeight: 280, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ background: 'var(--surface)', position: 'sticky', top: 0 }}>
                        <tr>
                          {['Pos', '类型', 'End_log_pos', 'Info'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {events.map((e, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{e.pos}</td>
                            <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: eventTypeColor(e.eventType), fontWeight: 600 }}>{e.eventType}</td>
                            <td style={{ padding: '5px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{e.endLogPos}</td>
                            <td style={{ padding: '5px 10px', color: 'var(--text)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.info}>{e.info}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Step 4: 生成闪回命令 */}
              {step === 'flashback' && (
                <div style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 10, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <AlertTriangle size={14} color="var(--error)" />
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--error)' }}>闪回操作（高危）</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7, marginBottom: 12 }}>
                    <b>注意事项：</b><br />
                    1. binlog 闪回通过反转 ROW 格式 binlog 中的 DML 操作（INSERT↔DELETE、UPDATE 前后对调）生成回滚 SQL。<br />
                    2. 源 binlog 文件只读，执行前请在<b>测试环境</b>验证生成的 SQL 正确性。<br />
                    3. <b>强烈建议</b>先备份目标数据库，再执行闪回 SQL。
                  </div>

                  <div style={{ marginBottom: 10 }}>
                    <input value={untilPos} onChange={e => setUntilPos(e.target.value)} placeholder="截止 pos（可选，精确控制范围）"
                      style={{ width: 220, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }} />
                  </div>

                  <div style={{ background: 'var(--surface)', borderRadius: 7, padding: 12, border: '1px solid var(--border)', position: 'relative' }}>
                    <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>
                      {genFlashbackCmd()}
                    </pre>
                    <button
                      onClick={copyCmd}
                      style={{ position: 'absolute', top: 8, right: 8, color: copied ? '#16a34a' : 'var(--text-muted)', padding: 4, lineHeight: 0 }}
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    MariaDB 亦支持 <code>mysqlbinlog --flashback</code>（Alibaba 分支）；MySQL 8 推荐使用 binlog2sql 工具。
                    替换 &lt;HOST&gt;/&lt;PORT&gt;/&lt;USER&gt; 等占位符后执行。
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
