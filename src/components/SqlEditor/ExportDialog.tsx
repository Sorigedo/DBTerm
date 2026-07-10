import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, FolderOpen, CheckCircle, XCircle, Loader, AlertTriangle } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'
import { formatDuration } from '../../utils/formatDuration'
import { unregisterExportCancelHandler, useExportTaskStore } from '../../stores/exportTaskStore'
import { registerStreamExportCancellation, updateExportTaskFromProgress } from '../../utils/exportTasks'

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

const CANCELABLE_TYPES = new Set(['mysql', 'mariadb', 'tidb', 'oceanBase', 'postgres', 'kingBase', 'openGauss', 'sqlite', 'duckdb'])

interface ProgressEvt {
  rows: number
  elapsed_ms: number
  rows_per_sec: number
  file_bytes: number
  done: boolean
  cancelled: boolean
  error: string | null
}

interface DuckCopyResult {
  rows: number
  fileBytes: number
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

  const [format,      setFormat]      = useState<Format>('csv')
  const [encoding,    setEncoding]    = useState<Encoding>('utf8')
  const [filePath,    setFilePath]    = useState('')
  const [insertTable, setInsertTable] = useState(guessTableName(sqlText))

  const [phase,       setPhase]       = useState<Phase>('config')
  const [progress,    setProgress]    = useState<ProgressEvt | null>(null)
  const [finalRows,   setFinalRows]   = useState(0)
  const [errorMsg,    setErrorMsg]    = useState('')
  const [baseDir,     setBaseDir]     = useState('')   // 默认导出目录（下载目录），保证默认路径为绝对路径
  const [elapsedMs,   setElapsedMs]   = useState(0)
  const [cancelling,  setCancelling]  = useState(false)
  const exportStartRef = useRef(0)
  const exportTokenRef = useRef<string | null>(null)
  const activeTaskIdRef = useRef<string | null>(null)
  const cancelRequestedRef = useRef(false)

  // 运行期间本地刷新耗时；后端流式进度没回来前也能看到已运行时间
  useEffect(() => {
    if (phase !== 'running') { setElapsedMs(0); return }
    exportStartRef.current = Date.now()
    setElapsedMs(0)
    const timer = window.setInterval(() => setElapsedMs(Date.now() - exportStartRef.current), 100)
    return () => window.clearInterval(timer)
  }, [phase])

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
    setErrorMsg('')
    setCancelling(false)
    cancelRequestedRef.current = false
    const token = CANCELABLE_TYPES.has(connType ?? '') ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : null
    exportTokenRef.current = token
    const markedSql = token ? `/* dbterm-cancel:${token} */ ${sqlText.trim()}` : sqlText.trim()
    const taskId = useExportTaskStore.getState().addTask({
      connId: connectionId,
      label: `${guessTableName(sqlText)} · ${FORMAT_OPTS.find(item => item.value === format)?.label ?? format}`,
      filePath: filePath.trim(),
      cancelable: true,
      message: '正在执行查询…',
    })
    activeTaskIdRef.current = taskId
    registerStreamExportCancellation(taskId, connectionId, () => exportTokenRef.current, () => {
      cancelRequestedRef.current = true
    })
    onClose()

    // DuckDB 高速通道（COPY TO，无需把结果拉回前端）。CSV 仅 UTF-8 时走原生 COPY，避免忽略用户选择的 GBK/BOM。
    if (isDuck && (format === 'parquet' || (format === 'csv' && encoding === 'utf8'))) {
      const t0 = Date.now()
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<DuckCopyResult>('duckdb_copy_to', {
          id: connectionId,
          sql: markedSql,
          path: filePath.trim(),
          format,
        })
        if (cancelRequestedRef.current) {
          setPhase('cancelled')
          return
        }
        const elapsed = Date.now() - t0
        setFinalRows(res.rows)
        setProgress({
          rows: res.rows, elapsed_ms: elapsed,
          rows_per_sec: elapsed > 0 ? Math.round(res.rows / (elapsed / 1000)) : res.rows,
          file_bytes: res.fileBytes, done: true, cancelled: false, error: null,
        })
        useExportTaskStore.getState().updateTask(taskId, {
          status: 'done', progressRows: res.rows, speed: elapsed > 0 ? Math.round(res.rows / (elapsed / 1000)) : res.rows,
          fileBytes: res.fileBytes, message: `已导出 ${res.rows.toLocaleString()} 行`, filePath: filePath.trim(), finishedAt: Date.now(),
        })
        setPhase('done')
      } catch (e) {
        if (cancelRequestedRef.current) {
          useExportTaskStore.getState().updateTask(taskId, { status: 'cancelled', message: '已取消', finishedAt: Date.now() })
          setPhase('cancelled')
        } else {
          useExportTaskStore.getState().updateTask(taskId, { status: 'error', error: String(e), message: '导出失败', finishedAt: Date.now() })
          setErrorMsg(String(e))
          setPhase('error')
        }
      } finally {
        unregisterExportCancelHandler(taskId)
        exportTokenRef.current = null
        cancelRequestedRef.current = false
        setCancelling(false)
      }
      return
    }

    let unlisten: (() => void) | null = null
    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<ProgressEvt>(`export_progress_${taskId}`, e => {
        const evt = e.payload
        setProgress(evt)
        updateExportTaskFromProgress(taskId, evt)
        if (evt.done) {
          if (evt.cancelled) {
            useExportTaskStore.getState().updateTask(taskId, { status: 'cancelled', message: '已取消', finishedAt: Date.now() })
            setPhase('cancelled')
          } else if (evt.error) {
            useExportTaskStore.getState().updateTask(taskId, { status: 'error', error: evt.error, message: '导出失败', finishedAt: Date.now() })
            setErrorMsg(evt.error)
            setPhase('error')
          } else {
            useExportTaskStore.getState().updateTask(taskId, {
              status: 'done', progressRows: evt.rows, speed: evt.rows_per_sec, fileBytes: evt.file_bytes,
              message: `已导出 ${evt.rows.toLocaleString()} 行`, filePath: filePath.trim(), finishedAt: Date.now(),
            })
            setFinalRows(evt.rows)
            setPhase('done')
          }
        }
      })
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_stream_export', {
        id: connectionId,
        sql: markedSql,
        filePath: filePath.trim(),
        format,
        encoding,
        insertTable,
        taskId,
        database: schema || undefined,
      })
    } catch (e) {
      const msg = String(e)
      if (cancelRequestedRef.current || msg.includes('已取消') || msg.includes('查询已取消')) {
        useExportTaskStore.getState().updateTask(taskId, { status: 'cancelled', message: '已取消', finishedAt: Date.now() })
        setPhase('cancelled')
      } else {
        useExportTaskStore.getState().updateTask(taskId, { status: 'error', error: msg, message: '导出失败', finishedAt: Date.now() })
        setErrorMsg(msg)
        setPhase('error')
      }
    } finally {
      unregisterExportCancelHandler(taskId)
      exportTokenRef.current = null
      cancelRequestedRef.current = false
      setCancelling(false)
      unlisten?.()
    }
  }, [connectionId, sqlText, filePath, format, encoding, insertTable, connType, schema, isDuck, onClose])

  const cancelExport = async () => {
    window.getSelection()?.removeAllRanges()
    if (cancelling) return
    cancelRequestedRef.current = true
    setCancelling(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const taskId = activeTaskIdRef.current
      if (taskId) await invoke('db_cancel_export', { taskId })
      const token = exportTokenRef.current
      if (token) {
        try { await invoke('db_cancel_query', { id: connectionId, token }) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  const openFolder = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { filePath: filePath.trim() })
    } catch { /* ignore */ }
  }

  const runningElapsedMs = Math.max(elapsedMs, progress?.elapsed_ms ?? 0)

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
                const noEncoding = format === 'parquet' || format === 'json' || format === 'md' || format === 'xlsx'
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
                          后端流式写入 Excel；Excel 单个工作表最多支持 1,048,576 行，超大数据建议用 CSV / TSV / JSON Lines
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <Loader size={16} className="spin" color="var(--accent)" />
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>
                    {progress ? `已导出 ${progress.rows.toLocaleString()} 行` : '正在执行查询…'}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  耗时 <b style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{(runningElapsedMs / 1000).toFixed(1)}s</b>
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
                  <StatCard label="已用时间" value={formatDuration(progress.elapsed_ms)} />
                  <StatCard label="行数" value={progress.rows.toLocaleString()} />
                </div>
              )}

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, wordBreak: 'break-all' }}>
                写入 → {filePath}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={cancelExport} disabled={cancelling} style={{ ...btnCancel, color: 'var(--error)', borderColor: '#dc2626', opacity: cancelling ? 0.65 : 1 }}>
                  {cancelling ? '取消中…' : '取消导出'}
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
                <StatCard label="用时"     value={formatDuration(progress.elapsed_ms)} />
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
