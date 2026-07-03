// MA6.5 — performance_schema 深度分析（语句摘要 / 表 IO / 等待事件 / 文件 IO）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, BarChart2, Database, Clock, HardDrive } from 'lucide-react'
import { friendlyDbError } from '../../utils/dbError'

interface Props {
  connectionId: string
  connType?: string
  schema?: string
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type Tab = 'digest' | 'tableio' | 'waits' | 'fileio'

interface DigestRow {
  digest: string
  schemaName: string
  queryText: string
  execCount: number
  totalLatencyMs: number
  avgLatencyMs: number
  rowsExamined: number
  rowsSent: number
  noIndexUsed: number
}

interface TableIORow {
  objectSchema: string
  objectName: string
  countRead: number
  countWrite: number
  sumTimerReadMs: number
  sumTimerWriteMs: number
}

interface WaitRow {
  eventName: string
  countStar: number
  sumTimerWaitMs: number
  avgTimerWaitMs: number
}

interface FileIORow {
  eventName: string
  countRead: number
  countWrite: number
  sumTimerReadMs: number
  sumTimerWriteMs: number
  sumNumberBytesRead: number
  sumNumberBytesWritten: number
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)}ms`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`
  return `${(b / 1024 / 1024).toFixed(2)}M`
}

export default function PerfSchemaPanel({ connectionId, connType, schema, onClose, embedded }: Props) {
  // TiDB 无 performance_schema 存储引擎；OceanBase（MySQL 模式）只实现极少量 performance_schema 兼容视图，
  // 本面板用到的 events_statements_summary_by_digest / table_io_waits_summary_by_table /
  // events_waits_summary_global_by_event_name / file_summary_by_event_name 在这两者上都不存在 → 查询直接报表不存在。
  const unsupported = connType === 'tidb' || connType === 'oceanBase'
  const unsupportedReason = connType === 'tidb'
    ? 'TiDB 不实现 performance_schema 存储引擎，相关统计表不存在。可改用 information_schema.CLUSTER_STATEMENTS_SUMMARY / SLOW_QUERY 等 TiDB 自有视图分析。'
    : 'OceanBase（MySQL 模式）仅提供极少量 performance_schema 兼容视图，本面板所需的语句摘要 / 表 IO / 等待事件 / 文件 IO 表均不存在。可改用 gv$ 系列视图。'
  const [tab, setTab] = useState<Tab>('digest')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [perfDisabled, setPerfDisabled] = useState(false)

  const [digests, setDigests] = useState<DigestRow[]>([])
  const [tableIO, setTableIO] = useState<TableIORow[]>([])
  const [waits, setWaits] = useState<WaitRow[]>([])
  const [fileIO, setFileIO] = useState<FileIORow[]>([])

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

  const loadDigest = async () => {
    setLoading(true); setError(''); setPerfDisabled(false)
    try {
      const schemaFilter = schema ? `AND SCHEMA_NAME = '${schema}'` : ''
      const res = await q(`SELECT DIGEST, SCHEMA_NAME,
          SUBSTR(DIGEST_TEXT, 1, 120) AS query_text,
          COUNT_STAR, SUM_TIMER_WAIT / 1000000 AS total_ms,
          AVG_TIMER_WAIT / 1000000 AS avg_ms,
          SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
          SUM_NO_INDEX_USED
        FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT IS NOT NULL ${schemaFilter}
        ORDER BY total_ms DESC
        LIMIT 30`)
      setDigests(res.rows.map(r => ({
        digest:        String(r[0] ?? ''),
        schemaName:    String(r[1] ?? ''),
        queryText:     String(r[2] ?? ''),
        execCount:     Number(r[3] ?? 0),
        totalLatencyMs: Number(r[4] ?? 0),
        avgLatencyMs:  Number(r[5] ?? 0),
        rowsExamined:  Number(r[6] ?? 0),
        rowsSent:      Number(r[7] ?? 0),
        noIndexUsed:   Number(r[8] ?? 0),
      })))
    } catch (e) {
      const msg = String(e)
      if (msg.includes("doesn't exist")) setPerfDisabled(true)
      else setError(friendlyDbError(e))
    } finally {
      setLoading(false)
    }
  }

  const loadTableIO = async () => {
    setLoading(true); setError('')
    try {
      const schemaFilter = schema ? `WHERE OBJECT_SCHEMA = '${schema}'` : "WHERE OBJECT_SCHEMA NOT IN ('mysql','performance_schema','information_schema')"
      const res = await q(`SELECT OBJECT_SCHEMA, OBJECT_NAME,
          COUNT_READ, COUNT_WRITE,
          SUM_TIMER_READ / 1000000 AS read_ms,
          SUM_TIMER_WRITE / 1000000 AS write_ms
        FROM performance_schema.table_io_waits_summary_by_table
        ${schemaFilter}
        ORDER BY (SUM_TIMER_READ + SUM_TIMER_WRITE) DESC
        LIMIT 30`)
      setTableIO(res.rows.map(r => ({
        objectSchema:    String(r[0] ?? ''),
        objectName:      String(r[1] ?? ''),
        countRead:       Number(r[2] ?? 0),
        countWrite:      Number(r[3] ?? 0),
        sumTimerReadMs:  Number(r[4] ?? 0),
        sumTimerWriteMs: Number(r[5] ?? 0),
      })))
    } catch (e) {
      setError(friendlyDbError(e))
    } finally {
      setLoading(false)
    }
  }

  const loadWaits = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT EVENT_NAME, COUNT_STAR,
          SUM_TIMER_WAIT / 1000000 AS total_ms,
          AVG_TIMER_WAIT / 1000000 AS avg_ms
        FROM performance_schema.events_waits_summary_global_by_event_name
        WHERE COUNT_STAR > 0
        ORDER BY total_ms DESC
        LIMIT 30`)
      setWaits(res.rows.map(r => ({
        eventName:       String(r[0] ?? ''),
        countStar:       Number(r[1] ?? 0),
        sumTimerWaitMs:  Number(r[2] ?? 0),
        avgTimerWaitMs:  Number(r[3] ?? 0),
      })))
    } catch (e) {
      setError(friendlyDbError(e))
    } finally {
      setLoading(false)
    }
  }

  const loadFileIO = async () => {
    setLoading(true); setError('')
    try {
      const res = await q(`SELECT EVENT_NAME, COUNT_READ, COUNT_WRITE,
          SUM_TIMER_READ / 1000000 AS read_ms,
          SUM_TIMER_WRITE / 1000000 AS write_ms,
          SUM_NUMBER_OF_BYTES_READ, SUM_NUMBER_OF_BYTES_WRITE
        FROM performance_schema.file_summary_by_event_name
        WHERE COUNT_READ + COUNT_WRITE > 0
        ORDER BY (SUM_TIMER_READ + SUM_TIMER_WRITE) DESC
        LIMIT 30`)
      setFileIO(res.rows.map(r => ({
        eventName:              String(r[0] ?? ''),
        countRead:              Number(r[1] ?? 0),
        countWrite:             Number(r[2] ?? 0),
        sumTimerReadMs:         Number(r[3] ?? 0),
        sumTimerWriteMs:        Number(r[4] ?? 0),
        sumNumberBytesRead:     Number(r[5] ?? 0),
        sumNumberBytesWritten:  Number(r[6] ?? 0),
      })))
    } catch (e) {
      setError(friendlyDbError(e))
    } finally {
      setLoading(false)
    }
  }

  const load = () => {
    if (tab === 'digest') loadDigest()
    else if (tab === 'tableio') loadTableIO()
    else if (tab === 'waits') loadWaits()
    else loadFileIO()
  }

  useEffect(() => { if (!unsupported) load() }, [tab, unsupported])

  const TABS: { key: Tab; label: string; Icon: typeof BarChart2 }[] = [
    { key: 'digest',  label: '语句摘要 TOP30', Icon: BarChart2 },
    { key: 'tableio', label: '表 IO 热点',     Icon: Database },
    { key: 'waits',   label: '等待事件',        Icon: Clock },
    { key: 'fileio',  label: '文件 IO',         Icon: HardDrive },
  ]

  const inner = (
    <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: embedded ? '6px 12px' : '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {TABS.map(({ key, label, Icon }) => (
            <button key={key} onClick={() => setTab(key)} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: tab === key ? 'var(--accent)' : 'var(--surface-2)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${tab === key ? 'var(--accent)' : 'var(--border)'}`,
              fontWeight: tab === key ? 600 : 400,
            }}>
              <Icon size={11} />{label}
            </button>
          ))}
          {embedded && (
            <button onClick={load} disabled={loading} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0, padding: 4, background: 'transparent', cursor: 'pointer' }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {unsupported ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <BarChart2 size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block' }} />
              当前数据库类型不支持 performance_schema 深度分析<br />
              <span style={{ fontSize: 11, display: 'block', marginTop: 8, lineHeight: 1.6 }}>{unsupportedReason}</span>
            </div>
          ) : (<>
          {error && <div style={{ padding: '8px 16px', background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12, flexShrink: 0 }}>{error}</div>}
          {perfDisabled && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              <BarChart2 size={28} style={{ margin: '0 auto 12px', opacity: 0.4, display: 'block' }} />
              performance_schema 未开启或 consumer 未启用<br />
              <span style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
                UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME LIKE 'events_statements%';
              </span>
            </div>
          )}
          {loading && !perfDisabled && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>}

          {!loading && !perfDisabled && !error && (
            <>
              {/* 语句摘要 */}
              {tab === 'digest' && (
                digests.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无语句摘要数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['库', '查询摘要', '执行次数', '总耗时', '均耗时', '扫描行', '返回行', '无索引'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {digests.map((d, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: d.noIndexUsed > 0 ? 'rgba(234,88,12,0.04)' : '' }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.schemaName || '—'}</td>
                          <td style={{ padding: '6px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={d.queryText}>{d.queryText}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{d.execCount.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: d.totalLatencyMs > 10000 ? '#dc2626' : 'var(--text)', fontWeight: d.totalLatencyMs > 10000 ? 600 : 400 }}>{fmtMs(d.totalLatencyMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtMs(d.avgLatencyMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{d.rowsExamined.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{d.rowsSent.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: d.noIndexUsed > 0 ? '#ea580c' : 'var(--text-muted)', fontWeight: d.noIndexUsed > 0 ? 600 : 400 }}>{d.noIndexUsed || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {/* 表 IO */}
              {tab === 'tableio' && (
                tableIO.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无表 IO 数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['库', '表', '读次数', '写次数', '读耗时', '写耗时'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableIO.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.objectSchema}</td>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{r.objectName}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.countRead.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.countWrite.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{fmtMs(r.sumTimerReadMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: r.sumTimerWriteMs > 5000 ? '#ea580c' : 'var(--text)' }}>{fmtMs(r.sumTimerWriteMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {/* 等待事件 */}
              {tab === 'waits' && (
                waits.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无等待事件数据（events_waits consumer 可能未开启）</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['事件名', '触发次数', '总等待', '均等待'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {waits.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)' }}>{r.eventName}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.countStar.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: r.sumTimerWaitMs > 10000 ? '#dc2626' : 'var(--text)', fontWeight: r.sumTimerWaitMs > 10000 ? 600 : 400 }}>{fmtMs(r.sumTimerWaitMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtMs(r.avgTimerWaitMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {/* 文件 IO */}
              {tab === 'fileio' && (
                fileIO.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>暂无文件 IO 数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                      <tr>
                        {['事件名', '读次数', '写次数', '读耗时', '写耗时', '读字节', '写字节'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fileIO.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.eventName}>{r.eventName}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.countRead.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.countWrite.toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{fmtMs(r.sumTimerReadMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text)' }}>{fmtMs(r.sumTimerWriteMs)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtBytes(r.sumNumberBytesRead)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtBytes(r.sumNumberBytesWritten)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </>
          )}
          </>)}
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
        style={{ width: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <BarChart2 size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>performance_schema 深度分析</span>
          {schema && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>· {schema}</span>}
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
