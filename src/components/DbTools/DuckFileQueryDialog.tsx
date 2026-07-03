// DD2.2/DD2.3 DuckDB 外部文件预览与 schema 推断对话框 + 一键导入到表/视图
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { X, Loader2, FileText, Table2, Play, Import } from 'lucide-react'
import SearchableSelect from './SearchableSelect'

interface Props {
  connectionId: string
  filePath: string
  onInsertSql: (sql: string) => void
  onClose: () => void
}

interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
}

const EXT_FUNC_MAP: Record<string, string> = {
  parquet: 'read_parquet',
  csv:  'read_csv_auto',
  tsv:  'read_csv_auto',
  json: 'read_json_auto',
  jsonl:'read_json_auto',
  xlsx: 'read_excel',
  xls:  'read_excel',
}

function getExt(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function buildReadSql(path: string, opts: { delim: string; header: boolean; skip: number; hive?: boolean }) {
  const p = path.replace(/\\/g, '/').replace(/'/g, "''")
  const ext = getExt(path.replace(/[*?[\]]/g, '')) // 去掉 glob 字符再取扩展名
  const fn  = EXT_FUNC_MAP[ext] ?? 'read_parquet'

  if (fn === 'read_csv_auto') {
    const args = [`'${p}'`]
    if (opts.delim !== 'auto') args.push(`delim='${opts.delim}'`)
    if (!opts.header)           args.push(`header=false`)
    if (opts.skip > 0)          args.push(`skip=${opts.skip}`)
    if (opts.hive)              args.push(`hive_partitioning=true`)
    return `${fn}(${args.join(', ')})`
  }
  const args = [`'${p}'`]
  if (opts.hive) args.push(`hive_partitioning=true`)
  return args.length > 1 ? `${fn}(${args.join(', ')})` : `${fn}('${p}')`
}

export default function DuckFileQueryDialog({ connectionId, filePath, onInsertSql, onClose }: Props) {
  const [pathOrGlob, setPathOrGlob] = useState(filePath.replace(/\\/g, '/'))
  const ext = getExt(pathOrGlob.replace(/[*?[\]]/g, ''))
  const fn  = EXT_FUNC_MAP[ext] ?? 'read_parquet'
  const isCsv = fn === 'read_csv_auto'
  const hasGlob = /[*?[\]]/.test(pathOrGlob)

  const [delim,  setDelim]  = useState<'auto' | ',' | '\t' | '|' | ';'>('auto')
  const [header, setHeader] = useState(true)
  const [skip,   setSkip]   = useState(0)
  const [hive,   setHive]   = useState(false)
  const [schema, setSchema] = useState<QueryResult | null>(null)
  const [preview, setPreview] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'schema' | 'preview' | 'import'>('schema')
  // DD2.3 导入状态
  const [importName, setImportName]   = useState(() => {
    const base = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'imported'
    return base.replace(/[^a-z0-9_]/gi, '_')
  })
  const [importMode, setImportMode]   = useState<'table' | 'view'>('table')
  const [importing,  setImporting]    = useState(false)
  const [importDone, setImportDone]   = useState(false)
  const [importErr,  setImportErr]    = useState<string | null>(null)

  const readExpr = buildReadSql(pathOrGlob, { delim, header, skip, hive })

  const loadPreview = useCallback(async () => {
    setLoading(true); setError(null); setSchema(null); setPreview(null)
    try {
      const [sc, pv] = await Promise.all([
        invoke<QueryResult>('execute_query', {
          id: connectionId,
          sql: `DESCRIBE SELECT * FROM ${readExpr}`,
          limit: 200,
        }),
        invoke<QueryResult>('execute_query', {
          id: connectionId,
          sql: `SELECT * FROM ${readExpr} LIMIT 5`,
          limit: 10,
        }),
      ])
      setSchema(sc)
      setPreview(pv)
    } catch (e) { setError(String(e)) }
    finally { setLoading(false) }
  }, [connectionId, readExpr])

  useEffect(() => { loadPreview() }, [loadPreview])

  const insertQuery = (limit = 100) => {
    const sql = `SELECT *\nFROM ${readExpr}\nLIMIT ${limit}`
    onInsertSql(sql)
  }

  const doImport = useCallback(async () => {
    if (!importName.trim()) return
    setImporting(true); setImportErr(null); setImportDone(false)
    try {
      const stmt = importMode === 'table'
        ? `CREATE TABLE "${importName.trim().replace(/"/g, '""')}" AS SELECT * FROM ${readExpr}`
        : `CREATE VIEW "${importName.trim().replace(/"/g, '""')}" AS SELECT * FROM ${readExpr}`
      await invoke('execute_query', { id: connectionId, sql: stmt })
      setImportDone(true)
    } catch (e) { setImportErr(String(e)) }
    finally { setImporting(false) }
  }, [connectionId, readExpr, importName, importMode])

  const fileName = pathOrGlob.split(/[/\\]/).pop() ?? pathOrGlob

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 9999 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 700, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)', animation: 'slideUp 0.18s cubic-bezier(0.34,1.2,0.64,1)' }}>
        {/* 头部 */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileText size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {hasGlob ? `Glob: ${fileName}` : fileName}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>函数: <code style={{ fontFamily: 'var(--font-mono)' }}>{fn}</code>  扩展名: .{ext}</div>
          </div>
          {/* 路径/Glob 可编辑输入（DD2.5） */}
          <input
            value={pathOrGlob}
            onChange={e => setPathOrGlob(e.target.value)}
            title="支持 glob 通配符：data/*.parquet、**/*.json 等"
            style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', width: 160 }}
          />
          <button onClick={onClose} style={{ padding: 4, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}>
            <X size={14} />
          </button>
        </div>

        {/* CSV 选项 / Glob 选项 */}
        {(isCsv || hasGlob) && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            {isCsv && <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>分隔符</span>
                <SearchableSelect width={130} mono={false}
                  value={delim} onChange={v => setDelim(v as typeof delim)}
                  items={[
                    { value: 'auto', label: '自动' },
                    { value: ',', label: '逗号 (,)' },
                    { value: '\t', label: '制表符 (\\t)' },
                    { value: '|', label: '竖线 (|)' },
                    { value: ';', label: '分号 (;)' },
                  ]} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={header} onChange={e => setHeader(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                首行为列头
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>跳过行数</span>
                <input type="number" min={0} max={100} value={skip} onChange={e => setSkip(Number(e.target.value))}
                  style={{ width: 48, fontSize: 11, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', textAlign: 'center' }} />
              </div>
            </>}
            {hasGlob && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={hive} onChange={e => setHive(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                Hive 分区
              </label>
            )}
            <button onClick={loadPreview} disabled={loading}
              style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11, cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              {loading ? <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> : null}刷新预览
            </button>
          </div>
        )}

        {/* Tab 栏 */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', padding: '0 8px', flexShrink: 0 }}>
          {([['schema', 'Schema（列类型）'], ['preview', '数据预览（前5行）'], ['import', '导入到库']] as const).map(([t, label]) => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              padding: '6px 14px', border: 'none', fontSize: 12,
              borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent', color: activeTab === t ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {loading && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
              正在推断 schema 并加载预览…
            </div>
          )}
          {error && (
            <div className="dlg-alert-error">
              {error}
            </div>
          )}
          {!loading && !error && activeTab === 'schema' && schema && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  {schema.columns.map(c => (
                    <th key={c} style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schema.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'transparent' : 'var(--surface-2)' }}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ padding: '4px 8px', color: 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{cell ?? '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && !error && activeTab === 'preview' && preview && (
            <div style={{ overflow: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    {preview.columns.map(c => (
                      <th key={c} style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      {row.map((cell, j) => (
                        <td key={j} style={{ padding: '4px 8px', color: cell == null ? 'var(--text-muted)' : 'var(--text)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {cell ?? <span style={{ opacity: 0.4 }}>NULL</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {schema && activeTab !== 'import' && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              共 {schema.rows.length} 列 · 类型由 DuckDB 自动推断
            </div>
          )}

          {/* 导入到库 Tab (DD2.3) */}
          {activeTab === 'import' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--accent) 13%, transparent)', background: 'color-mix(in srgb, var(--accent) 3%, transparent)', fontSize: 12, color: 'var(--text)' }}>
                将外部文件数据落库，<strong>表</strong>会完整复制数据；<strong>视图</strong>零拷贝直接指向文件（每次查询都会重新读取文件）。
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 60 }}>对象名称</span>
                <input value={importName} onChange={e => setImportName(e.target.value)}
                  style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                  placeholder="table_name" />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 60 }}>导入模式</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input type="radio" value="table" checked={importMode === 'table'} onChange={() => setImportMode('table')} style={{ accentColor: 'var(--accent)' }} />
                  CREATE TABLE（完整复制，查询更快）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input type="radio" value="view" checked={importMode === 'view'} onChange={() => setImportMode('view')} style={{ accentColor: 'var(--accent)' }} />
                  CREATE VIEW（零拷贝）
                </label>
              </div>
              <div style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                {importMode === 'table'
                  ? `CREATE TABLE "${importName}" AS SELECT * FROM ${readExpr}`
                  : `CREATE VIEW "${importName}" AS SELECT * FROM ${readExpr}`
                }
              </div>
              {importDone && <div className="dlg-alert-success">✓ 创建成功！可在对象树中查看 {importName}</div>}
              {importErr  && <div className="dlg-alert-error">{importErr}</div>}
              <button onClick={doImport} disabled={importing || !importName.trim()}
                className="cdlg-btn cdlg-btn--ok"
                style={{ display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', opacity: !importName.trim() ? 0.5 : 1, cursor: importing || !importName.trim() ? 'not-allowed' : 'pointer' }}>
                {importing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Import size={12} />}
                {importing ? '正在导入…' : `确认创建 ${importMode === 'table' ? '表' : '视图'}`}
              </button>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
          <button onClick={() => { insertQuery(1000); onClose() }}
            style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Table2 size={12} />插入查询（LIMIT 1000）
          </button>
          <button onClick={() => { insertQuery(100); onClose() }} disabled={!!error}
            style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: error ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, opacity: error ? 0.5 : 1 }}>
            <Play size={12} />插入查询（LIMIT 100）
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
