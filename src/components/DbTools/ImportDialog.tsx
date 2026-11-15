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
  const [targetLoading, setTargetLoading] = useState(false)
  const targetRequest = useRef(0)
  async function changeTarget(t: string) {
    if (operationRef.current) return
    const request = ++targetRequest.current
    setTargetLoading(true)
    setTargetTable(t)
    setTargetCols([])
    setCsvResult(null); setCsvError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const c = await invoke<{ name: string }[]>('table_columns', { id: connectionId, schema, table: t })
      if (request === targetRequest.current) setTargetCols(c.map(x => x.name))
    } catch (e) {
      if (request === targetRequest.current) setCsvError('读取目标字段失败：' + String(e))
    } finally {
      if (request === targetRequest.current) setTargetLoading(false)
    }
  }

  // CSV/TSV/JSON state
  const [csvFormat, setCsvFormat]       = useState<'csv' | 'txt' | 'tsv' | 'json' | 'excel' | 'xml'>('csv')
  const [csvPath, setCsvPath]           = useState('')
  const [hasHeader, setHasHeader]       = useState(true)
  const [nullValue, setNullValue]       = useState('NULL')
  const [onError, setOnError]           = useState<OnError>('stop')
  const [csvPreviewCols, setCsvPreviewCols] = useState<string[]>([])
  const [colMapping, setColMapping]     = useState<string[]>([])
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvResult, setCsvResult]       = useState<ImportResult | null>(null)
  const [csvError, setCsvError]         = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const previewRequest = useRef(0)

  // SQL file state
  const [sqlPath, setSqlPath]           = useState('')
  const [sqlRunning, setSqlRunning]     = useState(false)
  const [sqlProgress, setSqlProgress]  = useState<SqlFileProgress | null>(null)
  const [sqlErrors, setSqlErrors]       = useState<string[]>([])
  const [sqlDone, setSqlDone]           = useState(false)
  const [sqlError, setSqlError]         = useState('')

  const unlistenRef = useRef<(() => void) | null>(null)
  const operationRef = useRef(false)
  const [csvNeedsReview, setCsvNeedsReview] = useState(false)
  const [sqlNeedsReview, setSqlNeedsReview] = useState(false)
  const busy = csvImporting || sqlRunning
  function requestClose() { if (!operationRef.current) onClose() }


  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !operationRef.current) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Cleanup event listener on unmount
  useEffect(() => {
    return () => {
      ++targetRequest.current
      ++previewRequest.current
      unlistenRef.current?.()
    }
  }, [])

  // Keep mappings by source position: duplicate labels must remain independent.
  useEffect(() => {
    setColMapping(csvPreviewCols.map((name, index) => hasHeader
      ? (targetCols.includes(name) ? name : '')
      : (targetCols[index] ?? '')))
  }, [csvPreviewCols, targetCols, hasHeader])

  const delimited = csvFormat === 'csv' || csvFormat === 'txt' || csvFormat === 'tsv'
  const mappedCols = delimited ? colMapping : targetCols
  const mappingValid = mappedCols.length > 0
    && mappedCols.every(name => name !== '' && targetCols.includes(name))
    && new Set(mappedCols).size === mappedCols.length
    && (!delimited || (previewReady && mappedCols.length === csvPreviewCols.length))
  const csvReady = !!csvPath && !!targetTable && !targetLoading && !previewLoading && mappingValid

  async function pickCsvFile() {
    if (operationRef.current) return
    const request = ++previewRequest.current
    const format = csvFormat
    setPreviewLoading(true)
    setPreviewReady(false)
    setCsvPreviewCols([])
    setCsvPath('')
    setCsvResult(null)
    setCsvError('')
    try {
      const exts = format === 'tsv' ? ['tsv', 'txt']
        : format === 'txt' ? ['txt', 'tsv']
        : format === 'json' ? ['json']
        : format === 'xml' ? ['xml']
        : format === 'excel' ? ['xlsx', 'xls']
        : ['csv', 'txt']
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({ filters: [{ name: format.toUpperCase(), extensions: exts }] })
      if (request !== previewRequest.current || !result || typeof result !== 'string') return
      setCsvPath(result)
      if (format === 'json' || format === 'excel' || format === 'xml') return
      const { invoke } = await import('@tauri-apps/api/core')
      const parts = await invoke<string[]>('read_delimited_file_header', { path: result, format })
      if (request !== previewRequest.current) return
      if (!parts.length) throw new Error('文件没有可映射的数据列')
      setCsvPreviewCols(parts)
      setPreviewReady(true)
    } catch (e) {
      if (request === previewRequest.current) setCsvError('读取文件预览失败：' + String(e))
    } finally {
      if (request === previewRequest.current) setPreviewLoading(false)
    }
  }

  async function startCsvImport() {
    if (!csvReady || operationRef.current || csvNeedsReview) return
    operationRef.current = true
    setCsvImporting(true)
    setCsvResult(null)
    setCsvError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      setCsvNeedsReview(true)
      const result = await invoke<ImportResult>('db_import_csv', {
        id: connectionId,
        schema,
        table: targetTable,
        path: csvPath,
        columns: mappedCols,
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
        toast.error('部分记录未导入；请核对目标数据，不要直接重跑整个文件')
      }
    } catch (e) {
      setCsvError(String(e)) // 失败只在面板内提示，避免一错两处
    } finally {
      operationRef.current = false
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
    if (!sqlPath || operationRef.current || sqlNeedsReview) return
    operationRef.current = true
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
      setSqlNeedsReview(true)
      const res = await invoke<{ executed: number; failed: number; errors: string[] }>(
        'db_exec_sql_file', { id: connectionId, path: sqlPath, schema })
      setSqlErrors(res.errors)
      setSqlProgress(prev => ({ current: res.executed + res.failed, total: res.executed + res.failed, sql: prev?.sql ?? '', error: null }))
      setSqlDone(true)
      // 不论成败都刷新（部分语句可能已生效，如 CREATE TABLE）
      notifySchemaChanged(connectionId, schema)
      onDone()
      if (res.failed === 0) {
        toast.success(`SQL 执行完成，共 ${res.executed} 条语句`)
        onClose()   // 全部成功：友好提示并关闭
      } else {
        // 前面的语句可能已提交，禁止鼓励直接重跑整个文件。
        toast.error(`执行已停止，成功执行 ${res.executed} 条；此前语句可能已提交，请先核查数据库状态`)
      }
    } catch (e) {
      setSqlError(String(e)) // 失败只在面板内提示，避免一错两处
    } finally {
      operationRef.current = false
      setSqlRunning(false)
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }

  const progressPct = sqlProgress
    ? Math.round((sqlProgress.current / Math.max(sqlProgress.total, 1)) * 100)
    : 0

  return createPortal(
    <div className="imp-overlay" onMouseDown={requestClose}>
      <div className="imp-card" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="imp-header">
          <span className="imp-header__title">导入数据 — {schema ? `${schema}.` : ''}{targetTable}</span>
          <button className="imp-header__close" disabled={busy} onClick={requestClose}><X size={15} /></button>
        </div>

        {/* Tabs */}
        <div className="imp-tabs">
          <button
            className={`imp-tab ${activeTab === 'sql' ? 'imp-tab--active' : ''}`}
            disabled={busy} onClick={() => setActiveTab('sql')}
          >
            <Database size={13} /> SQL 文件
          </button>
          <button
            className={`imp-tab ${activeTab === 'csv' ? 'imp-tab--active' : ''}`}
            disabled={busy} onClick={() => setActiveTab('csv')}
          >
            <FileText size={13} /> 数据文件
          </button>
        </div>

        {/* CSV/TSV/JSON Tab */}
        {activeTab === 'csv' && (
          <fieldset className="imp-body" disabled={busy}>
            {/* 目标表选择（提供了表列表时可切换） */}
            {tables && tables.length > 1 && (
              <div className="imp-row imp-row--gap">
                <span className="imp-label">目标表</span>
                <SearchableSelect disabled={busy} value={targetTable} onChange={changeTarget} options={tables} width={240} />
              </div>
            )}
            {/* 格式选择 */}
            <div className="imp-row imp-row--gap">
              <span className="imp-label">格式</span>
              {(['csv', 'txt', 'tsv', 'json', 'excel', 'xml'] as const).map((f) => (
                <button key={f}
                  className={`imp-fmt-btn ${csvFormat === f ? 'imp-fmt-btn--active' : ''}`}
                  onClick={() => { ++previewRequest.current; setPreviewLoading(false); setPreviewReady(false); setCsvFormat(f); setCsvPath(''); setCsvPreviewCols([]); setCsvResult(null); setCsvError('') }}>
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
              <div className="imp-hint">JSON 需为字段名唯一的对象数组，按字段名匹配；缺失字段和 JSON null 写入 NULL，字符串 "NULL" 保留为文本。</div>
            )}
            {csvFormat === 'xml' && (
              <div className="imp-hint">XML 按 row 行和字段节点名匹配；自闭合字段为 NULL，空标签为字符串空值，文本 NULL 保留；文件必须完整。</div>
            )}
            {csvFormat === 'txt' && (
              <div className="imp-hint">按制表符（Tab）分隔解析，与 TSV 相同。</div>
            )}
            {csvFormat === 'excel' && (
              <div className="imp-hint">读取第一个工作表；有表头时按唯一名称匹配，缺少目标字段会报错；无表头须列数一致。错误单元格拒绝导入。</div>
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
                    {csvPreviewCols.map((csvCol, index) => (
                      <tr key={index}>
                        <td className="imp-map-table__src">{hasHeader ? csvCol : '第 ' + (index + 1) + ' 列'}</td>
                        <td>
                          <SearchableSelect
                            disabled={busy}
                            value={colMapping[index] ?? ''}
                            onChange={(v) => setColMapping(previous => previous.map((name, i) => i === index ? v : name))}
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

            {(targetLoading || previewLoading) && <div className="imp-hint">正在读取字段或文件预览…</div>}
            {delimited && previewReady && !mappingValid && <div className="imp-warning">请为每个来源列选择不同的目标字段；未匹配字段不会自动赋值。</div>}
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

            {csvNeedsReview && !busy && (
              <label className="imp-checkbox-row">
                <input type="checkbox" checked={false} onChange={() => setCsvNeedsReview(false)} />
                <span>我已核对目标数据和执行结果，确认下一次导入不会重复写入</span>
              </label>
            )}
            {!targetTable && (
              <div className="imp-hint">当前库还没有表。请到「SQL 文件」标签导入包含建表语句的 .sql 脚本，或先建表后再用此处导入数据文件。</div>
            )}
            <div className="imp-footer">
              <button className="imp-btn imp-btn--cancel" disabled={busy} onClick={requestClose}>关闭</button>
              <button
                className="imp-btn imp-btn--primary"
                disabled={!csvReady || busy || csvNeedsReview}
                onClick={startCsvImport}
              >
                {csvImporting ? <><Loader2 size={13} className="spin" /> 导入中…</> : '开始导入'}
              </button>
            </div>
          </fieldset>
        )}

        {/* SQL Tab */}
        {activeTab === 'sql' && (
          <fieldset className="imp-body" disabled={busy}>
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
                {sqlErrors.length > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} className="imp-result__icon" />}
                {sqlErrors.length > 0 ? '执行已停止，请核查此前语句的提交状态' : '执行完成'}
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
            {sqlNeedsReview && !busy && (
              <label className="imp-checkbox-row">
                <input type="checkbox" checked={false} onChange={() => setSqlNeedsReview(false)} />
                <span>我已核对数据库状态，确认下一次执行不会重复写入</span>
              </label>
            )}

            <div className="imp-footer">
              <button className="imp-btn imp-btn--cancel" disabled={busy} onClick={requestClose}>关闭</button>
              <button
                className="imp-btn imp-btn--primary"
                disabled={!sqlPath || busy || sqlNeedsReview}
                onClick={startSqlExec}
              >
                {sqlRunning ? <><Loader2 size={13} className="spin" /> 执行中…</> : '开始执行'}
              </button>
            </div>
          </fieldset>
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
          border: 0; margin: 0; min-width: 0;
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
