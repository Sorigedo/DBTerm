import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, FileText, Database, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from '../../stores/toastStore'
import { notifySchemaChanged } from '../../utils/schemaRefresh'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  schema: string
  table: string
  columns: string[]
  tables?: string[]   // 可选目标表列表：提供时弹窗内可切换目标表
  onClose: () => void
  onDone: () => void
}

type Tab = 'csv' | 'sql'
type OnError = 'stop' | 'skip'

interface SqlFileProgress {
  current: number
  total: number
  sql: string
  error: string | null
}

interface ImportResult {
  inserted: number
  skipped: number
  errors: string[]
}

export default function ImportDialog({ connectionId, schema, table, columns, tables, onClose, onDone }: Props) {
  // 默认进入 SQL 文件标签（更常用：可直接执行建表+数据脚本）
  const [activeTab, setActiveTab] = useState<Tab>('sql')

  // 目标表（可在弹窗内切换）；切换时重新拉取该表的列
  const [targetTable, setTargetTable] = useState(table)
  const [targetCols, setTargetCols]   = useState<string[]>(columns)
  async function changeTarget(t: string) {
    setTargetTable(t)
    setCsvResult(null); setCsvError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const c = await invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table: t })
      setTargetCols(c.map(x => x.name))
    } catch { setTargetCols([]) }
  }

  // CSV/TSV/JSON state
  const [csvFormat, setCsvFormat]       = useState<'csv' | 'txt' | 'tsv' | 'json' | 'excel' | 'xml'>('csv')
  const [csvPath, setCsvPath]           = useState('')
  const [hasHeader, setHasHeader]       = useState(true)
  const [nullValue, setNullValue]       = useState('NULL')
  const [onError, setOnError]           = useState<OnError>('stop')
  const [csvPreviewCols, setCsvPreviewCols] = useState<string[]>([])
  const [colMapping, setColMapping]     = useState<Record<string, string>>({})
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvResult, setCsvResult]       = useState<ImportResult | null>(null)
  const [csvError, setCsvError]         = useState('')

  // SQL file state
  const [sqlPath, setSqlPath]           = useState('')
  const [sqlRunning, setSqlRunning]     = useState(false)
  const [sqlProgress, setSqlProgress]  = useState<SqlFileProgress | null>(null)
  const [sqlErrors, setSqlErrors]       = useState<string[]>([])
  const [sqlDone, setSqlDone]           = useState(false)
  const [sqlError, setSqlError]         = useState('')

  const unlistenRef = useRef<(() => void) | null>(null)

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Cleanup event listener on unmount
  useEffect(() => {
    return () => { unlistenRef.current?.() }
  }, [])

  // Re-build default mapping when preview cols or table columns change
  useEffect(() => {
    const mapping: Record<string, string> = {}
    csvPreviewCols.forEach((c) => {
      mapping[c] = targetCols.includes(c) ? c : (targetCols[0] ?? '')
    })
    setColMapping(mapping)
  }, [csvPreviewCols, targetCols])

  async function pickCsvFile() {
    try {
      const exts = csvFormat === 'tsv' ? ['tsv', 'txt']
        : csvFormat === 'txt' ? ['txt', 'tsv']
        : csvFormat === 'json' ? ['json']
        : csvFormat === 'xml' ? ['xml']
        : csvFormat === 'excel' ? ['xlsx', 'xls']
        : ['csv', 'txt']
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({ filters: [{ name: csvFormat.toUpperCase(), extensions: exts }] })
      if (!result || typeof result !== 'string') return
      setCsvPath(result)
      setCsvResult(null)
      setCsvError('')
      // JSON/XML 按字段名匹配 / Excel 为二进制：无需文本列映射预览
      if (csvFormat === 'json' || csvFormat === 'excel' || csvFormat === 'xml') { setCsvPreviewCols([]); return }
      // 读取首行预览列（按分隔符切分）
      const { invoke } = await import('@tauri-apps/api/core')
      try {
        const firstLine = await invoke<string>('read_file_first_line', { path: result })
        if (firstLine) {
          const sep = csvFormat === 'tsv' || csvFormat === 'txt' ? '\t' : ','
          const parts = firstLine.split(sep).map((p) => p.trim().replace(/^"|"$/g, ''))
          setCsvPreviewCols(parts)
        }
      } catch {
        setCsvPreviewCols([])
      }
    } catch { /* user cancelled */ }
  }

  async function startCsvImport() {
    if (!csvPath || csvImporting) return
    setCsvImporting(true)
    setCsvResult(null)
    setCsvError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const mappedCols = csvPreviewCols.length > 0
        ? csvPreviewCols.map((c) => colMapping[c] ?? targetCols[0] ?? c)
        : targetCols
      const result = await invoke<ImportResult>('db_import_csv', {
        id: connectionId,
        schema,
        table: targetTable,
        path: csvPath,
        columns: (csvFormat === 'json' || csvFormat === 'xml') ? targetCols : mappedCols,
        hasHeader: (csvFormat === 'json' || csvFormat === 'xml') ? false : hasHeader,
        nullValue,
        onError,
        format: csvFormat,
      })
      setCsvResult(result)
      if (result.inserted > 0 || result.skipped > 0) {
        notifySchemaChanged(connectionId, schema)
        onDone()
      }
      if (result.errors.length === 0 && result.inserted >= 0) {
        toast.success(`已导入 ${result.inserted} 行${result.skipped ? `（跳过 ${result.skipped} 行）` : ''}`)
      } else if (result.errors.length > 0) {
        toast.error(`导入完成，但有 ${result.errors.length} 处错误，请查看后重试`)
      }
    } catch (e) {
      setCsvError(String(e)) // 失败只在面板内提示，避免一错两处
    } finally {
      setCsvImporting(false)
    }
  }

  async function pickSqlFile() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({ filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!result || typeof result !== 'string') return
      setSqlPath(result)
      setSqlProgress(null)
      setSqlErrors([])
      setSqlDone(false)
      setSqlError('')
    } catch { /* user cancelled */ }
  }

  async function startSqlExec() {
    if (!sqlPath || sqlRunning) return
    setSqlRunning(true)
    setSqlProgress(null)
    setSqlErrors([])
    setSqlDone(false)
    setSqlError('')

    // cleanup previous listener
    unlistenRef.current?.()

    try {
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen<SqlFileProgress>('sql_file_progress', (event) => {
        setSqlProgress(event.payload)
        if (event.payload.error) {
          setSqlErrors((prev) => [...prev, `语句 ${event.payload.current}: ${event.payload.error}`])
        }
      })
      unlistenRef.current = unlisten

      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ executed: number; failed: number; errors: string[] }>(
        'db_exec_sql_file', { id: connectionId, path: sqlPath, schema })
      setSqlDone(true)
      // 不论成败都刷新（部分语句可能已生效，如 CREATE TABLE）
      notifySchemaChanged(connectionId, schema)
      onDone()
      if (res.failed === 0) {
        toast.success(`SQL 执行完成，共 ${res.executed} 条语句`)
        onClose()   // 全部成功：友好提示并关闭
      } else {
        // 有失败：保留弹窗与错误列表，便于分析重试
        toast.error(`执行完成，但有 ${res.failed} 条语句失败，请查看下方错误后重试`)
      }
    } catch (e) {
      setSqlError(String(e)) // 失败只在面板内提示，避免一错两处
    } finally {
      setSqlRunning(false)
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }

  const progressPct = sqlProgress
    ? Math.round((sqlProgress.current / Math.max(sqlProgress.total, 1)) * 100)
    : 0

  return createPortal(
    <div className="imp-overlay" onMouseDown={onClose}>
      <div className="imp-card" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="imp-header">
          <span className="imp-header__title">导入数据 — {schema ? `${schema}.` : ''}{targetTable}</span>
          <button className="imp-header__close" onClick={onClose}><X size={15} /></button>
        </div>

        {/* Tabs */}
        <div className="imp-tabs">
          <button
            className={`imp-tab ${activeTab === 'sql' ? 'imp-tab--active' : ''}`}
            onClick={() => setActiveTab('sql')}
          >
            <Database size={13} /> SQL 文件
          </button>
          <button
            className={`imp-tab ${activeTab === 'csv' ? 'imp-tab--active' : ''}`}
            onClick={() => setActiveTab('csv')}
          >
            <FileText size={13} /> 数据文件
          </button>
        </div>

        {/* CSV/TSV/JSON Tab */}
        {activeTab === 'csv' && (
          <div className="imp-body">
            {/* 目标表选择（提供了表列表时可切换） */}
            {tables && tables.length > 1 && (
              <div className="imp-row imp-row--gap">
                <span className="imp-label">目标表</span>
                <SearchableSelect value={targetTable} onChange={changeTarget} options={tables} width={240} />
              </div>
            )}
            {/* 格式选择 */}
            <div className="imp-row imp-row--gap">
              <span className="imp-label">格式</span>
              {(['csv', 'txt', 'tsv', 'json', 'excel', 'xml'] as const).map((f) => (
                <button key={f}
                  className={`imp-fmt-btn ${csvFormat === f ? 'imp-fmt-btn--active' : ''}`}
                  onClick={() => { setCsvFormat(f); setCsvPath(''); setCsvPreviewCols([]); setCsvResult(null); setCsvError('') }}>
                  {f === 'excel' ? 'Excel' : f.toUpperCase()}
                </button>
              ))}
            </div>

            <div className="imp-row">
              <button className="imp-pick-btn" onClick={pickCsvFile}>选择 {csvFormat.toUpperCase()} 文件</button>
              {csvPath && <span className="imp-filepath">{csvPath}</span>}
            </div>

            {csvFormat !== 'json' && csvFormat !== 'xml' && (
              <label className="imp-checkbox-row">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                />
                <span>包含表头行</span>
              </label>
            )}
            {csvFormat === 'json' && (
              <div className="imp-hint">JSON 需为对象数组，按字段名自动匹配目标表列（缺失字段写入 NULL）。</div>
            )}
            {csvFormat === 'xml' && (
              <div className="imp-hint">XML 需为 &lt;row&gt; 行、列作为子节点（如本工具导出的格式），按节点名匹配目标表列。</div>
            )}
            {csvFormat === 'txt' && (
              <div className="imp-hint">按制表符（Tab）分隔解析，与 TSV 相同。</div>
            )}
            {csvFormat === 'excel' && (
              <div className="imp-hint">读取第一个工作表；勾选「包含表头行」则按表头名匹配目标列，否则按列顺序映射。</div>
            )}

            {csvPreviewCols.length > 0 && (
              <div className="imp-section">
                <div className="imp-section-label">列映射</div>
                <table className="imp-map-table">
                  <thead>
                    <tr>
                      <th>{csvFormat.toUpperCase()} 列</th>
                      <th>目标列</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreviewCols.map((csvCol) => (
                      <tr key={csvCol}>
                        <td className="imp-map-table__src">{csvCol}</td>
                        <td>
                          <SearchableSelect
                            value={colMapping[csvCol] ?? ''}
                            onChange={(v) => setColMapping({ ...colMapping, [csvCol]: v })}
                            options={targetCols}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="imp-row imp-row--gap">
              <label className="imp-label">
                NULL 值标记
                <input
                  className="imp-input imp-input--sm"
                  value={nullValue}
                  onChange={(e) => setNullValue(e.target.value)}
                />
              </label>
            </div>

            <div className="imp-row imp-row--gap">
              <span className="imp-label">出错时</span>
              <label className="imp-radio">
                <input
                  type="radio"
                  name="onError"
                  value="stop"
                  checked={onError === 'stop'}
                  onChange={() => setOnError('stop')}
                />
                停止
              </label>
              <label className="imp-radio">
                <input
                  type="radio"
                  name="onError"
                  value="skip"
                  checked={onError === 'skip'}
                  onChange={() => setOnError('skip')}
                />
                跳过
              </label>
            </div>

            {csvError && <div className="imp-error"><AlertTriangle size={13} /> {csvError}</div>}

            {csvResult && (
              <div className="imp-result">
                <CheckCircle2 size={13} className="imp-result__icon" />
                已导入 {csvResult.inserted} 行
                {csvResult.skipped > 0 && <span> / 已跳过 {csvResult.skipped} 行</span>}
                {csvResult.errors.length > 0 && (
                  <div className="imp-err-list">
                    {csvResult.errors.map((e, i) => <div key={i} className="imp-err-item">{e}</div>)}
                  </div>
                )}
              </div>
            )}

            {!targetTable && (
              <div className="imp-hint">当前库还没有表。请到「SQL 文件」标签导入包含建表语句的 .sql 脚本，或先建表后再用此处导入数据文件。</div>
            )}
            <div className="imp-footer">
              <button className="imp-btn imp-btn--cancel" onClick={onClose}>关闭</button>
              <button
                className="imp-btn imp-btn--primary"
                disabled={!csvPath || !targetTable || csvImporting}
                onClick={startCsvImport}
              >
                {csvImporting ? <><Loader2 size={13} className="spin" /> 导入中…</> : '开始导入'}
              </button>
            </div>
          </div>
        )}

        {/* SQL Tab */}
        {activeTab === 'sql' && (
          <div className="imp-body">
            <div className="imp-row">
              <button className="imp-pick-btn" onClick={pickSqlFile}>选择 SQL 文件</button>
              {sqlPath && <span className="imp-filepath">{sqlPath}</span>}
            </div>

            {!sqlRunning && !sqlDone && (
              <div className="imp-warning">
                <AlertTriangle size={13} />
                SQL 文件将按分号逐条执行，请确认文件内容安全
              </div>
            )}

            {sqlRunning && sqlProgress && (
              <div className="imp-section">
                <div className="imp-progress-bar">
                  <div className="imp-progress-bar__fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="imp-progress-info">
                  {sqlProgress.current} / {sqlProgress.total} 条语句
                </div>
                <div className="imp-progress-sql">{sqlProgress.sql}</div>
              </div>
            )}

            {sqlDone && !sqlRunning && (
              <div className="imp-result">
                <CheckCircle2 size={13} className="imp-result__icon" />
                执行完成
                {sqlProgress && <span> · 共 {sqlProgress.total} 条语句</span>}
              </div>
            )}

            {sqlErrors.length > 0 && (
              <div className="imp-err-list">
                <div className="imp-section-label">错误信息 ({sqlErrors.length})</div>
                {sqlErrors.map((e, i) => (
                  <div key={i} className="imp-err-item">{e}</div>
                ))}
              </div>
            )}

            {sqlError && <div className="imp-error"><AlertTriangle size={13} /> {sqlError}</div>}

            <div className="imp-footer">
              <button className="imp-btn imp-btn--cancel" onClick={onClose}>关闭</button>
              <button
                className="imp-btn imp-btn--primary"
                disabled={!sqlPath || sqlRunning}
                onClick={startSqlExec}
              >
                {sqlRunning ? <><Loader2 size={13} className="spin" /> 执行中…</> : '开始执行'}
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .imp-overlay {
          position: fixed; inset: 0; z-index: 1100;
          background: rgba(0,0,0,0.55);
          backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
        }
        .imp-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          width: 560px;
          max-height: 80vh;
          display: flex; flex-direction: column;
          animation: slideUp 0.18s cubic-bezier(0.34,1.2,0.64,1);
          overflow: hidden;
        }
        .imp-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 16px 10px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .imp-header__title { font-size: 13px; font-weight: 600; color: var(--text-bright); }
        .imp-header__close {
          color: var(--text-muted); padding: 3px; border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
        }
        .imp-header__close:hover { background: var(--surface-hover); color: var(--text); }
        .imp-tabs {
          display: flex; gap: 2px; padding: 8px 12px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .imp-tab {
          display: flex; align-items: center; gap: 5px;
          padding: 6px 12px; border-radius: 6px 6px 0 0;
          font-size: 12px; color: var(--text-muted);
          border-bottom: 2px solid transparent;
        }
        .imp-tab:hover { color: var(--text); background: var(--surface-hover); }
        .imp-tab--active { color: var(--accent); border-bottom-color: var(--accent); }
        .imp-body {
          flex: 1; overflow-y: auto;
          padding: 14px 16px;
          display: flex; flex-direction: column; gap: 10px;
        }
        .imp-row {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .imp-row--gap { gap: 12px; }
        .imp-pick-btn {
          padding: 6px 12px; border-radius: 8px;
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text); font-size: 12px; white-space: nowrap;
        }
        .imp-pick-btn:hover { background: var(--surface-hover); }
        .imp-filepath {
          font-size: 11px; color: var(--text-muted);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          max-width: 320px;
        }
        .imp-checkbox-row {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; color: var(--text); cursor: pointer;
        }
        .imp-fmt-btn {
          padding: 4px 12px; border-radius: 7px; font-size: 12px; font-weight: 600;
          background: var(--surface-2); border: 1px solid var(--border); color: var(--text); cursor: pointer;
        }
        .imp-fmt-btn:hover { background: var(--surface-hover); }
        .imp-fmt-btn--active { background: var(--accent); border-color: var(--accent); color: #fff; }
        .imp-hint {
          font-size: 11.5px; color: var(--text-muted); line-height: 1.6;
          background: var(--surface-2); border: 1px solid var(--border-subtle);
          border-radius: 8px; padding: 8px 10px;
        }
        .imp-section { display: flex; flex-direction: column; gap: 6px; }
        .imp-section-label { font-size: 11px; color: var(--text-muted); font-weight: 500; }
        .imp-map-table {
          width: 100%; border-collapse: collapse; font-size: 12px;
        }
        .imp-map-table th {
          text-align: left; padding: 5px 8px;
          background: var(--surface-2); color: var(--text-muted);
          font-weight: 500; font-size: 11px;
        }
        .imp-map-table th:first-child { border-radius: 6px 0 0 0; }
        .imp-map-table th:last-child  { border-radius: 0 6px 0 0; }
        .imp-map-table td {
          padding: 4px 8px; border-bottom: 1px solid var(--border-subtle);
        }
        .imp-map-table__src { color: var(--text-muted); }
        .imp-label {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; color: var(--text);
        }
        .imp-input {
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 6px; color: var(--text); font-size: 12px; padding: 4px 8px;
        }
        .imp-input--sm { width: 90px; }
        .imp-radio {
          display: flex; align-items: center; gap: 5px;
          font-size: 12px; color: var(--text); cursor: pointer;
        }
        .imp-warning {
          display: flex; align-items: flex-start; gap: 6px;
          padding: 8px 10px; border-radius: 8px;
          background: rgba(234,88,12,0.1); border: 1px solid rgba(234,88,12,0.3);
          color: #ea580c; font-size: 12px; line-height: 1.5;
        }
        .imp-progress-bar {
          height: 4px; border-radius: 2px;
          background: var(--surface-2); overflow: hidden;
        }
        .imp-progress-bar__fill {
          height: 100%; background: var(--accent);
          transition: width 0.2s;
        }
        .imp-progress-info { font-size: 11px; color: var(--text-muted); }
        .imp-progress-sql {
          font-size: 11px; color: var(--text-muted);
          font-family: var(--font-mono);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .imp-result {
          display: flex; align-items: center; gap: 6px;
          padding: 8px 10px; border-radius: 8px;
          background: rgba(22,163,74,0.1); border: 1px solid rgba(22,163,74,0.3);
          color: #16a34a; font-size: 12px;
          flex-wrap: wrap;
        }
        .imp-result__icon { flex-shrink: 0; }
        .imp-error {
          display: flex; align-items: flex-start; gap: 6px;
          padding: 8px 10px; border-radius: 8px;
          background: var(--error-bg); border: 1px solid rgba(240,96,96,0.3);
          color: var(--error); font-size: 12px;
        }
        .imp-err-list {
          display: flex; flex-direction: column; gap: 2px;
          max-height: 120px; overflow-y: auto;
        }
        .imp-err-item {
          font-size: 11px; color: var(--error); padding: 2px 0;
          font-family: var(--font-mono);
        }
        .imp-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          padding-top: 8px; margin-top: 4px;
          border-top: 1px solid var(--border-subtle);
        }
        .imp-btn {
          padding: 6px 14px; border-radius: 8px;
          font-size: 12px; font-weight: 500;
          display: flex; align-items: center; gap: 5px;
        }
        .imp-btn--cancel {
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text);
        }
        .imp-btn--cancel:hover { background: var(--surface-hover); }
        .imp-btn--primary {
          background: var(--accent); color: #fff; border: none;
        }
        .imp-btn--primary:hover:not(:disabled) { opacity: 0.88; }
        .imp-btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
      `}</style>
    </div>,
    document.body
  )
}
