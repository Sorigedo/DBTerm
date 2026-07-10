import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { X, ShieldAlert, Loader2, Download } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { queueBackgroundExport } from '../../utils/exportTasks'

interface Props {
  connectionId: string
  onClose: () => void
}

interface ColumnInfo { name: string; dataType: string }

const RULES = [
  { value: 'none',  label: '不脱敏' },
  { value: 'mask',  label: '掩码 ***' },
  { value: 'hash',  label: '哈希 md5' },
  { value: 'phone', label: '手机（首3尾4）' },
  { value: 'email', label: '邮箱（保留域名）' },
  { value: 'null',  label: '置空 NULL' },
]

export default function DuckMaskExportPanel({ connectionId, onClose }: Props) {
  const [schema, setSchema] = useState('main')
  const [table, setTable] = useState('')
  const [cols, setCols] = useState<ColumnInfo[]>([])
  const [rules, setRules] = useState<Record<string, string>>({})
  const [format, setFormat] = useState('csv')
  const [loadingCols, setLoadingCols] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  // 动态下拉
  const [schemaList, setSchemaList] = useState<string[]>(['main'])
  const [tableList,  setTableList]  = useState<string[]>([])
  useEffect(() => {
    invoke<string[]>('list_schemas', { id: connectionId })
      .then(list => { setSchemaList(list.length ? list : ['main']) })
      .catch(() => {})
  }, [connectionId])
  useEffect(() => {
    if (!schema) return
    invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema })
      .then(list => { setTableList(list.map(t => t.name)); setTable(''); setCols([]) })
      .catch(() => {})
  }, [connectionId, schema])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadCols = async () => {
    if (!table.trim()) { setError('请输入表名'); return }
    setLoadingCols(true); setError(''); setDone(''); setCols([])
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<ColumnInfo[]>('duckdb_list_columns', { id: connectionId, schema: schema.trim() || 'main', table: table.trim() })
      setCols(res)
      setRules({})
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingCols(false)
    }
  }

  const doExport = async () => {
    if (cols.length === 0) { setError('请先加载列'); return }
    setExporting(true); setError(''); setDone('')
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const ext = format === 'parquet' ? 'parquet' : 'csv'
      const dest = await save({
        title: '脱敏导出',
        defaultPath: `${table}_masked.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      })
      if (!dest) { setExporting(false); return }
      const { invoke } = await import('@tauri-apps/api/core')
      const ruleList = cols
        .map(c => ({ column: c.name, rule: rules[c.name] ?? 'none' }))
        .filter(r => r.rule !== 'none')
      const fullTable = (schema.trim() && schema.trim() !== 'main') ? `${schema.trim()}.${table.trim()}` : table.trim()
      queueBackgroundExport({
        connectionId,
        label: `${table.trim()} · DuckDB 脱敏导出`,
        filePath: dest,
        run: () => invoke<number>('duckdb_export_masked', {
          id: connectionId, table: fullTable, destPath: dest, format, rules: ruleList,
        }),
        complete: rows => ({ progressRows: rows, message: `导出完成 · ${rows.toLocaleString()} 行` }),
        successMessage: rows => `DuckDB 脱敏导出完成：${rows.toLocaleString()} 行`,
        errorPrefix: 'DuckDB 脱敏导出失败',
      })
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setExporting(false)
    }
  }

  const maskedCount = cols.filter(c => rules[c.name] && rules[c.name] !== 'none').length

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 640, maxHeight: '86vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <ShieldAlert size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>脱敏导出（DuckDB）</span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* 表选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>schema</span>
          <select value={schema} onChange={e => setSchema(e.target.value)}
            style={{ width: 100, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
            {schemaList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>表</span>
          <select value={table} onChange={e => { setTable(e.target.value); setCols([]); setRules({}) }}
            style={{ flex: 1, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
            <option value="">— 选择表 —</option>
            {tableList.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={loadCols} disabled={loadingCols || !table}
            style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, cursor: !table ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, opacity: !table ? 0.5 : 1 }}>
            {loadingCols ? <Loader2 size={13} className="spin" /> : null} 加载列
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: cols.length ? 0 : 16 }}>
          {error ? (
            <div style={{ margin: cols.length ? 16 : 0, padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : null}
          {done ? (
            <div style={{ margin: cols.length ? 16 : 0, padding: '8px 12px', fontSize: 12, color: 'var(--success)', background: 'rgba(22,163,74,0.08)', borderRadius: 6 }}>{done}</div>
          ) : null}
          {cols.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>列</th>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 120 }}>类型</th>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', width: 180 }}>脱敏规则</th>
                </tr>
              </thead>
              <tbody>
                {cols.map(c => (
                  <tr key={c.name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '5px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{c.name}</td>
                    <td style={{ padding: '5px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{c.dataType}</td>
                    <td style={{ padding: '5px 12px' }}>
                      <SearchableSelect mono={false}
                        value={rules[c.name] ?? 'none'}
                        onChange={v => setRules(r => ({ ...r, [c.name]: v }))}
                        items={RULES.map(r => ({ value: r.value, label: r.label }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !error && !loadingCols ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 24 }}>输入表名并加载列，为需要脱敏的列选择规则</div>
          ) : null}
        </div>

        {cols.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>格式</span>
            <SearchableSelect width={130} mono={false}
              value={format} onChange={setFormat}
              items={[{ value: 'csv', label: 'CSV' }, { value: 'parquet', label: 'Parquet' }]} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{maskedCount} 列将脱敏</span>
            <button onClick={doExport} disabled={exporting}
              style={{ marginLeft: 'auto', padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: exporting ? 'not-allowed' : 'pointer', opacity: exporting ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {exporting ? <Loader2 size={13} className="spin" /> : <Download size={13} />} 脱敏导出
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
