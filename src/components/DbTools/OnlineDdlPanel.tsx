// MA6.2 — 在线大表改表（ALGORITHM=INSTANT/INPLACE 评估 + pt-osc/gh-ost 命令模板）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Zap, AlertTriangle, Copy, Play } from 'lucide-react'

interface Props {
  connectionId: string
  schema: string
  connType: string
  onClose: () => void
  onRunSql?: (sql: string) => void
}

interface TableInfo {
  tableName: string
  engine: string
  rowCount: number
  dataMb: number
  indexMb: number
}

type AlgorithmLevel = 'INSTANT' | 'INPLACE' | 'COPY'

interface DdlOption {
  algorithm: AlgorithmLevel
  label: string
  desc: string
  safe: boolean
}

const DDL_HINTS: DdlOption[] = [
  { algorithm: 'INSTANT', label: 'INSTANT（零锁）',  desc: '瞬间完成，不重建表，MySQL 8.0+/MariaDB 10.3+ 支持新增列。', safe: true },
  { algorithm: 'INPLACE', label: 'INPLACE（短锁）', desc: '在线重建（如加索引），期间允许 DML，生产友好。', safe: true },
  { algorithm: 'COPY',    label: 'COPY（全锁）',    desc: '建临时表复制所有行，期间锁写，大表会长时锁表。', safe: false },
]

function fmtSize(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

export default function OnlineDdlPanel({ connectionId, schema, onClose, onRunSql }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [selectedTable, setSelectedTable] = useState('')
  const [ddlText, setDdlText] = useState('')
  const [algorithm, setAlgorithm] = useState<AlgorithmLevel>('INPLACE')
  const [lock, setLock] = useState<'NONE' | 'SHARED' | 'EXCLUSIVE'>('NONE')
  const [copied, setCopied] = useState(false)
  const [toolChoice, setToolChoice] = useState<'native' | 'ptosc' | 'ghoost'>('native')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadTables = async () => {
    setLoading(true); setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT TABLE_NAME, ENGINE,
               TABLE_ROWS,
               ROUND(DATA_LENGTH / 1024 / 1024, 2) AS data_mb,
               ROUND(INDEX_LENGTH / 1024 / 1024, 2) AS index_mb
              FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = '${schema}' AND TABLE_TYPE = 'BASE TABLE'
              ORDER BY DATA_LENGTH DESC
              LIMIT 50`,
      })
      setTables(res.rows.map(r => ({
        tableName: String(r[0] ?? ''),
        engine:    String(r[1] ?? ''),
        rowCount:  Number(r[2] ?? 0),
        dataMb:    Number(r[3] ?? 0),
        indexMb:   Number(r[4] ?? 0),
      })))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTables() }, [])

  const selectedInfo = tables.find(t => t.tableName === selectedTable)
  const isLargeTable = (selectedInfo?.dataMb ?? 0) > 500

  const genNativeDdl = () => {
    if (!selectedTable || !ddlText.trim()) return ''
    return `ALTER TABLE \`${schema}\`.\`${selectedTable}\`\n  ${ddlText.trim()},\n  ALGORITHM=${algorithm}, LOCK=${lock};`
  }

  const genPtOscCmd = () => {
    if (!selectedTable || !ddlText.trim()) return ''
    return `pt-online-schema-change \\
  --host=<HOST> --port=<PORT> \\
  --user=<USER> --password=<PASS> \\
  --alter="${ddlText.trim()}" \\
  --execute \\
  D=${schema},t=${selectedTable}`
  }

  const genGhOostCmd = () => {
    if (!selectedTable || !ddlText.trim()) return ''
    return `gh-ost \\
  --host=<HOST> --port=<PORT> \\
  --user=<USER> --password=<PASS> \\
  --database=${schema} --table=${selectedTable} \\
  --alter="${ddlText.trim()}" \\
  --execute`
  }

  const currentSql = toolChoice === 'native' ? genNativeDdl() : toolChoice === 'ptosc' ? genPtOscCmd() : genGhOostCmd()

  const copy = () => {
    navigator.clipboard.writeText(currentSql)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const runDirect = () => {
    const sql = genNativeDdl()
    if (!sql) return
    const confirmMsg = isLargeTable && algorithm === 'COPY'
      ? `警告：${selectedTable} 是大表（${fmtSize(selectedInfo?.dataMb ?? 0)}），COPY 模式可能长时锁写。\n\n生成 SQL：\n${sql}\n\n确认继续？`
      : `执行 ALTER TABLE？\n\n${sql}`
    if (!window.confirm(confirmMsg)) return
    if (onRunSql) { onRunSql(sql); onClose() }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 820, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Zap size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>在线大表改表</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {schema}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={loadTables} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', padding: 4, lineHeight: 0 }}><X size={13} /></button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', gap: 14 }}>
          {/* 左：表列表 */}
          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>选择目标表（按大小排序）</div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', maxHeight: 'calc(90vh - 200px)', overflowY: 'auto' }}>
                {tables.map(t => (
                  <button
                    key={t.tableName}
                    onClick={() => setSelectedTable(t.tableName)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 12px',
                      borderBottom: '1px solid var(--border-subtle)',
                      background: selectedTable === t.tableName ? 'var(--accent-bg)' : 'transparent',
                      color: selectedTable === t.tableName ? 'var(--accent)' : 'var(--text)',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{t.tableName}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {t.engine} · {fmtSize(t.dataMb)} · ~{t.rowCount.toLocaleString()}行
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右：DDL 配置 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {error && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(220,38,38,0.08)', color: 'var(--error)', fontSize: 12 }}>{error}</div>}

            {selectedTable && selectedInfo && (
              <>
                {isLargeTable && (
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', background: 'rgba(234,88,12,0.08)', borderRadius: 8, border: '1px solid rgba(234,88,12,0.3)' }}>
                    <AlertTriangle size={14} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 12, color: 'var(--warning)' }}>
                      大表警告：{selectedTable} 约 {fmtSize(selectedInfo.dataMb)}，建议使用 pt-osc/gh-ost 或 ALGORITHM=INSTANT/INPLACE 避免长时锁写。
                    </span>
                  </div>
                )}

                {/* DDL 输入 */}
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>ALTER 子句（例：ADD COLUMN age INT, DROP COLUMN old_col）</div>
                  <textarea
                    value={ddlText}
                    onChange={e => setDdlText(e.target.value)}
                    placeholder="ADD COLUMN xxx INT NOT NULL DEFAULT 0"
                    style={{ width: '100%', minHeight: 60, padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical', boxSizing: 'border-box' }}
                  />
                </div>

                {/* ALGORITHM 选择 */}
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>ALGORITHM（在线改表策略）</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {DDL_HINTS.map(opt => (
                      <button
                        key={opt.algorithm}
                        onClick={() => setAlgorithm(opt.algorithm)}
                        style={{
                          flex: 1, padding: '8px 0', borderRadius: 7, fontSize: 11, fontWeight: 600,
                          border: algorithm === opt.algorithm
                            ? `2px solid ${opt.safe ? 'var(--accent)' : '#dc2626'}`
                            : '1px solid var(--border)',
                          background: algorithm === opt.algorithm
                            ? opt.safe ? 'var(--accent-bg)' : 'rgba(220,38,38,0.08)'
                            : 'var(--surface-2)',
                          color: algorithm === opt.algorithm
                            ? opt.safe ? 'var(--accent)' : '#dc2626'
                            : 'var(--text-muted)',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    {DDL_HINTS.find(o => o.algorithm === algorithm)?.desc}
                  </div>
                </div>

                {/* LOCK 选择 */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>LOCK：</span>
                  {(['NONE', 'SHARED', 'EXCLUSIVE'] as const).map(l => (
                    <button key={l} onClick={() => setLock(l)} style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: lock === l ? 600 : 400,
                      background: lock === l ? 'var(--surface-hover)' : 'var(--surface-2)',
                      border: `1px solid ${lock === l ? 'var(--accent)' : 'var(--border)'}`,
                      color: lock === l ? 'var(--accent)' : 'var(--text-muted)',
                    }}>{l}</button>
                  ))}
                </div>

                {/* 工具选择 */}
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>执行方式</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[['native', '原生 ALTER TABLE'], ['ptosc', 'pt-online-schema-change'], ['ghoost', 'gh-ost']] .map(([key, label]) => (
                      <button key={key} onClick={() => setToolChoice(key as typeof toolChoice)} style={{
                        padding: '5px 12px', borderRadius: 6, fontSize: 11,
                        background: toolChoice === key ? 'var(--accent)' : 'var(--surface-2)',
                        color: toolChoice === key ? '#fff' : 'var(--text-muted)',
                        border: `1px solid ${toolChoice === key ? 'var(--accent)' : 'var(--border)'}`,
                        fontWeight: toolChoice === key ? 600 : 400,
                      }}>{label}</button>
                    ))}
                  </div>
                  {toolChoice !== 'native' && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      ⚠ {toolChoice === 'ptosc' ? 'pt-online-schema-change' : 'gh-ost'} 需在数据库服务器端安装并执行，请替换命令中的占位符后在终端运行。
                    </div>
                  )}
                </div>

                {/* 生成 SQL / 命令 */}
                {currentSql && (
                  <div style={{ background: 'var(--surface)', borderRadius: 7, padding: 12, border: '1px solid var(--border)', position: 'relative' }}>
                    <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>
                      {currentSql}
                    </pre>
                    <button onClick={copy} style={{ position: 'absolute', top: 8, right: 8, color: copied ? '#16a34a' : 'var(--text-muted)', padding: 4, lineHeight: 0 }}>
                      <Copy size={12} />
                    </button>
                  </div>
                )}

                {/* 操作按钮 */}
                {toolChoice === 'native' && ddlText.trim() && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={runDirect}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px', borderRadius: 8,
                        background: algorithm === 'COPY' ? '#dc2626' : 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600 }}
                    >
                      <Play size={12} />
                      {algorithm === 'COPY' ? '执行（高危）' : '执行 ALTER TABLE'}
                    </button>
                  </div>
                )}
              </>
            )}

            {!selectedTable && !loading && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                请从左侧选择目标表
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
