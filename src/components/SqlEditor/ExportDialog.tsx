import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, FolderOpen, CheckCircle, XCircle, Loader, AlertTriangle } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'
import { qid } from '../../utils/sqlDialect'

interface Props {
  connectionId: string
  sqlText: string
  /** 查询页选中的 schema/库：导出时随之切库，避免「No database selected」 */
  schema?: string
  onClose: () => void
  connType?: string
}

type Format   = 'csv' | 'tsv' | 'jsonl' | 'sql' | 'json' | 'md' | 'xlsx' | 'parquet'
type Encoding = 'utf8' | 'utf8bom' | 'gbk'
type Phase    = 'config' | 'running' | 'done' | 'error' | 'cancelled'

// 前端导出（执行整段查询后在前端编码写文件）：与结果区「下载」一致，支持 JSON 数组 / Markdown / Excel
const FRONTEND_FORMATS: Format[] = ['json', 'md', 'xlsx']
// 后端流式导出仅支持这些类型；其余类型（DuckDB/ClickHouse/SQLServer 等）所有格式都走前端 execute_query 路径
const STREAMING_TYPES = ['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite']

interface ProgressEvt {
  rows: number
  elapsed_ms: number
  rows_per_sec: number
  file_bytes: number
  done: boolean
  cancelled: boolean
  error: string | null
}

const FORMAT_OPTS: { value: Format; label: string; ext: string; duckOnly?: boolean }[] = [
  { value: 'csv',     label: 'CSV（逗号分隔）',         ext: 'csv'     },
  { value: 'tsv',     label: 'TSV（制表符分隔）',        ext: 'tsv'     },
  { value: 'xlsx',    label: 'Excel（.xlsx）',          ext: 'xlsx'    },
  { value: 'json',    label: 'JSON（数组）',            ext: 'json'    },
  { value: 'jsonl',   label: 'JSON Lines（每行一条）',   ext: 'jsonl'   },
  { value: 'md',      label: 'Markdown 表格',           ext: 'md'      },
  { value: 'sql',     label: 'SQL INSERT 语句',         ext: 'sql'     },
  { value: 'parquet', label: 'Parquet（DuckDB 高速）',  ext: 'parquet', duckOnly: true },
]

const ENC_OPTS: { value: Encoding; label: string }[] = [
  { value: 'utf8',    label: 'UTF-8' },
  { value: 'utf8bom', label: 'UTF-8 BOM（Excel 兼容）' },
  { value: 'gbk',     label: 'GBK / 中文 Windows' },
]

function fmtBytes(b: number): string {
  if (b < 1024)        return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m.toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
}

// 从 SQL 中提取主表名（尽力而为）
function guessTableName(sql: string): string {
  const m = /\bfrom\s+[`"']?(\w+)[`"']?/i.exec(sql)
  return m ? m[1] : 'export'
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export default function ExportDialog({ connectionId, sqlText, schema, onClose, connType }: Props) {
  const isDuck = connType === 'duckdb'
  const taskId = useRef(`exp_${Date.now()}`).current

  const [format,      setFormat]      = useState<Format>('csv')
  const [encoding,    setEncoding]    = useState<Encoding>('utf8')
  const [filePath,    setFilePath]    = useState('')
  const [insertTable, setInsertTable] = useState(guessTableName(sqlText))

  const [phase,       setPhase]       = useState<Phase>('config')
  const [progress,    setProgress]    = useState<ProgressEvt | null>(null)
  const [finalRows,   setFinalRows]   = useState(0)
  const [errorMsg,    setErrorMsg]    = useState('')
  const [baseDir,     setBaseDir]     = useState('')   // 默认导出目录（下载目录），保证默认路径为绝对路径

  // 取系统下载目录作为默认导出目录（绝对路径，避免后端「文件路径必须是绝对路径」）
  useEffect(() => {
    (async () => {
      try {
        const { downloadDir } = await import('@tauri-apps/api/path')
        setBaseDir(await downloadDir())
      } catch { /* 无法获取则保持相对名，由用户手动选择 */ }
    })()
  }, [])

  // 自动生成建议文件名（含下载目录的绝对路径）
  useEffect(() => {
    const table = guessTableName(sqlText)
    const ext   = FORMAT_OPTS.find(f => f.value === format)?.ext ?? 'csv'
    const fname = `${table}_${todayStr()}.${ext}`
    const suggest = baseDir ? `${baseDir.replace(/\/+$/, '')}/${fname}` : fname
    // 仅在路径为空或仍是上次自动生成时才更新；用户手动改过则只换扩展名
    setFilePath(prev => {
      if (!prev || /_\d{8}\.[A-Za-z0-9]+$/.test(prev)) return suggest
      return prev.replace(/\.[^.]+$/, `.${ext}`)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, baseDir])

  // 按 Esc 关闭（仅 config / done / error / cancelled 状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [phase, onClose])

  const pickFile = async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const ext = FORMAT_OPTS.find(f => f.value === format)?.ext ?? 'csv'
      const result = await save({
        title: '选择导出文件路径',
        defaultPath: filePath || `${guessTableName(sqlText)}_${todayStr()}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      })
      if (result) setFilePath(result)
    } catch { /* 用户取消 */ }
  }

  const startExport = useCallback(async () => {
    if (!filePath.trim()) return
    setPhase('running')
    setProgress(null)

    // 前端编码导出：JSON/MD/Excel 始终走前端；非流式支持的连接类型（DuckDB/ClickHouse/SQLServer 等）
    // 所有格式都走前端（execute_query 支持全部类型），避免后端流式导出「暂不支持此连接类型」
    const useFrontend = FRONTEND_FORMATS.includes(format) || !STREAMING_TYPES.includes(connType ?? '')
    if (useFrontend) {
      const t0 = Date.now()
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<{ columns: string[]; rows: (string | null)[][] }>('execute_query', {
          id: connectionId, sql: sqlText.trim(), database: schema || undefined,
        })
        let fileBytes = 0
        if (format === 'xlsx') {
          const xlsx = await import('xlsx')
          const wsData = [res.columns, ...res.rows.map((r) => r.map((v) => v ?? ''))]
          const ws = xlsx.utils.aoa_to_sheet(wsData)
          const wb = xlsx.utils.book_new()
          xlsx.utils.book_append_sheet(wb, ws, '查询结果')
          // xlsx.write(type:'array') 返回 ArrayBuffer，须包成 Uint8Array 才能转字节数组（否则 Array.from 得空数组 → 文件空）
          const buf = new Uint8Array(xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
          await invoke('write_local_bytes', { path: filePath.trim(), bytes: Array.from(buf) })
          fileBytes = buf.length
        } else {
          let content = ''
          const toObj = (r: (string | null)[]) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))
          if (format === 'json') {
            content = JSON.stringify(res.rows.map(toObj), null, 2)
          } else if (format === 'jsonl') {
            content = res.rows.map((r) => JSON.stringify(toObj(r))).join('\n') + '\n'
          } else if (format === 'csv' || format === 'tsv') {
            const sep = format === 'tsv' ? '\t' : ','
            const cell = (v: string | null) => {
              const s = v ?? ''
              if (format === 'tsv') return s.replace(/[\t\r\n]/g, ' ')
              return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
            }
            const line = (arr: (string | null)[]) => arr.map(cell).join(sep)
            content = [line(res.columns), ...res.rows.map(line)].join('\n') + '\n'
          } else if (format === 'sql') {
            const q = (s: string) => qid(connType ?? '', s)
            const tbl = q(insertTable || guessTableName(sqlText))
            const cols = res.columns.map(q).join(', ')
            content = res.rows.map((r) =>
              `INSERT INTO ${tbl} (${cols}) VALUES (${r.map((v) => v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`).join(', ')});`
            ).join('\n') + '\n'
          } else { // md
            const header = `| ${res.columns.join(' | ')} |`
            const divider = `| ${res.columns.map((c) => '-'.repeat(Math.max(c.length, 3))).join(' | ')} |`
            const body = res.rows.map((r) => `| ${r.map((v) => (v ?? 'NULL').replace(/\|/g, '\\|')).join(' | ')} |`)
            content = [header, divider, ...body].join('\n') + '\n'
          }
          await invoke('write_local_file', { path: filePath.trim(), content })
          fileBytes = new Blob([content]).size
        }
        const elapsed = Date.now() - t0
        setFinalRows(res.rows.length)
        setProgress({
          rows: res.rows.length, elapsed_ms: elapsed,
          rows_per_sec: elapsed > 0 ? Math.round(res.rows.length / (elapsed / 1000)) : res.rows.length,
          file_bytes: fileBytes, done: true, cancelled: false, error: null,
        })
        setPhase('done')
      } catch (e) {
        setErrorMsg(String(e))
        setPhase('error')
      }
      return
    }

    // DuckDB Parquet 高速通道（COPY TO，无需流式传输）
    if (format === 'parquet') {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const rows = await invoke<number>('duckdb_copy_to', {
          id: connectionId,
          sql: sqlText.trim(),
          path: filePath.trim(),
          format: 'parquet',
        })
        setFinalRows(rows)
        setPhase('done')
      } catch (e) {
        setErrorMsg(String(e))
        setPhase('error')
      }
      return
    }

    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<ProgressEvt>(`export_progress_${taskId}`, e => {
      const evt = e.payload
      setProgress(evt)
      if (evt.done) {
        if (evt.cancelled) {
          setPhase('cancelled')
        } else if (evt.error) {
          setErrorMsg(evt.error)
          setPhase('error')
        } else {
          setFinalRows(evt.rows)
          setPhase('done')
        }
      }
    })

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_stream_export', {
        id: connectionId,
        sql: sqlText.trim(),
        filePath: filePath.trim(),
        format,
        encoding,
        insertTable,
        taskId,
        database: schema || undefined,
      })
    } catch (e) {
      const msg = String(e)
      if (!msg.includes('已取消')) {
        setErrorMsg(msg)
        setPhase('error')
      }
    } finally {
      unlisten()
    }
  }, [connectionId, sqlText, filePath, format, encoding, insertTable, taskId])

  const cancelExport = async () => {
    window.getSelection()?.removeAllRanges()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_cancel_export', { taskId })
    } catch { /* ignore */ }
  }

  const openFolder = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { filePath: filePath.trim() })
    } catch { /* ignore */ }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={phase !== 'running' ? onClose : undefined}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 520, borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Download size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>
            {phase === 'config'    ? '执行并导出'
           : phase === 'running'  ? '导出进行中…'
           : phase === 'done'     ? '导出完成'
           : phase === 'cancelled'? '已取消'
           :                        '导出失败'}
          </span>
          {phase !== 'running' && (
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}>
              <X size={15} />
            </button>
          )}
        </div>

        <div style={{ padding: '16px' }}>
          {/* ─── 配置阶段 ──────────────────────────────────── */}
          {phase === 'config' && (
            <>
              {/* SQL 预览 */}
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>SQL 预览</label>
                <div style={{
                  background: 'var(--surface-2)', borderRadius: 7, padding: '8px 10px',
                  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', maxHeight: 60, overflow: 'hidden',
                  whiteSpace: 'pre', textOverflow: 'ellipsis',
                }}>
                  {sqlText.trim().slice(0, 300)}{sqlText.trim().length > 300 ? '…' : ''}
                </div>
              </div>

              {/* 格式 + 编码（Parquet / JSON / Markdown / Excel 固定 UTF-8，不显示编码选择）*/}
              {(() => {
                const noEncoding = format === 'parquet' || FRONTEND_FORMATS.includes(format)
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: noEncoding ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div>
                      <label style={labelStyle}>导出格式</label>
                      <SearchableSelect
                        value={format}
                        onChange={v => setFormat(v as Format)}
                        items={FORMAT_OPTS.filter(o => !o.duckOnly || isDuck).map(o => ({ value: o.value, label: o.label }))}
                        mono={false}
                      />
                      {format === 'parquet' && (
                        <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 4 }}>
                          ⚡ DuckDB 原生 COPY TO，高速列存导出，不经 Rust 层中转
                        </div>
                      )}
                      {format === 'xlsx' && (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                          执行整段查询后生成 Excel 文件（适合常规结果集，超大数据建议用 CSV）
                        </div>
                      )}
                    </div>
                    {!noEncoding && (
                      <div>
                        <label style={labelStyle}>文件编码</label>
                        <SearchableSelect
                          value={encoding}
                          onChange={v => setEncoding(v as Encoding)}
                          items={ENC_OPTS.map(o => ({ value: o.value, label: o.label }))}
                          mono={false}
                        />
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* SQL INSERT 目标表名 */}
              {format === 'sql' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>INSERT 目标表名</label>
                  <input
                    value={insertTable}
                    onChange={e => setInsertTable(e.target.value)}
                    placeholder="table_name"
                    style={{ width: '100%', fontSize: 12, padding: '6px 8px', boxSizing: 'border-box' }}
                  />
                </div>
              )}

              {/* 文件路径 */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>保存路径</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={filePath}
                    onChange={e => setFilePath(e.target.value)}
                    placeholder="/Users/xxx/export.csv"
                    style={{ flex: 1, fontSize: 12, padding: '6px 8px' }}
                  />
                  <button onClick={pickFile} style={{
                    fontSize: 12, padding: '6px 12px', borderRadius: 7, whiteSpace: 'nowrap',
                    background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
                  }}>
                    选择…
                  </button>
                </div>
              </div>

              {/* 操作按钮 */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={onClose} style={btnCancel}>取消</button>
                <button
                  onClick={startExport}
                  disabled={!filePath.trim()}
                  style={{ ...btnPrimary, opacity: filePath.trim() ? 1 : 0.5 }}
                >
                  开始导出
                </button>
              </div>
            </>
          )}

          {/* ─── 进行中 ──────────────────────────────────── */}
          {phase === 'running' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <Loader size={16} className="spin" color="var(--accent)" />
                <span style={{ fontSize: 13, color: 'var(--text)' }}>
                  {progress ? `已导出 ${progress.rows.toLocaleString()} 行` : '正在执行查询…'}
                </span>
              </div>

              {/* 动态进度条（不定宽） */}
              <div style={{ height: 4, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{
                  width: '35%', height: '100%', background: 'var(--accent)',
                  borderRadius: 2,
                  animation: 'progressPulse 1.4s ease-in-out infinite',
                }} />
              </div>

              {progress && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
                  <StatCard label="导出速度" value={`${progress.rows_per_sec.toLocaleString()} 行/秒`} />
                  <StatCard label="已用时间" value={fmtTime(progress.elapsed_ms)} />
                  <StatCard label="行数" value={progress.rows.toLocaleString()} />
                </div>
              )}

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, wordBreak: 'break-all' }}>
                写入 → {filePath}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={cancelExport} style={{ ...btnCancel, color: 'var(--error)', borderColor: '#dc2626' }}>
                  取消导出
                </button>
              </div>
            </>
          )}

          {/* ─── 完成 ──────────────────────────────────── */}
          {phase === 'done' && progress && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <CheckCircle size={18} color="var(--success)" />
                <span style={{ fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>
                  导出成功，共 {finalRows.toLocaleString()} 行
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                <StatCard label="文件大小" value={fmtBytes(progress.file_bytes)} />
                <StatCard label="用时"     value={fmtTime(progress.elapsed_ms)} />
                <StatCard label="平均速度" value={`${progress.rows_per_sec.toLocaleString()} 行/秒`} />
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginBottom: 16,
                background: 'var(--surface-2)', padding: '6px 10px', borderRadius: 7,
                wordBreak: 'break-all',
              }}>
                {filePath}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={openFolder} style={{ ...btnCancel, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <FolderOpen size={13} /> 打开文件夹
                </button>
                <button onClick={onClose} style={btnPrimary}>关闭</button>
              </div>
            </>
          )}

          {/* ─── 已取消 ──────────────────────────────────── */}
          {phase === 'cancelled' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <XCircle size={18} color="var(--text-muted)" />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>导出已取消，临时文件已清除</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setPhase('config')} style={btnCancel}>重新配置</button>
                <button onClick={onClose} style={btnPrimary}>关闭</button>
              </div>
            </>
          )}

          {/* ─── 失败 ──────────────────────────────────── */}
          {phase === 'error' && (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
                <AlertTriangle size={16} color="var(--error)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: 13, color: 'var(--error)', fontWeight: 600, marginBottom: 6 }}>导出失败</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface-2)',
                    padding: '6px 10px', borderRadius: 7, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                    {errorMsg}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    已中断，未完整的文件已自动删除。
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setPhase('config')} style={btnCancel}>重新配置</button>
                <button onClick={startExport} style={btnPrimary}>重试</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px',
      border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>{value}</div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 5,
}
const btnPrimary: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', borderRadius: 8,
  padding: '6px 18px', fontSize: 13, fontWeight: 500,
}
const btnCancel: React.CSSProperties = {
  background: 'var(--surface-2)', color: 'var(--text)', borderRadius: 8,
  padding: '6px 14px', fontSize: 13, border: '1px solid var(--border)',
}
