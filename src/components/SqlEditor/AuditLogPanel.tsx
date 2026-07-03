import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ClipboardList, Search, Download, Trash2 } from 'lucide-react'
import { toast } from '../../stores/toastStore'
import SearchableSelect from '../DbTools/SearchableSelect'
import { clearAuditLog, loadAuditLog, MAX_ENTRIES, type AuditEntry } from '../../utils/auditLog'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_local_file', { path, content })
    toast.exported(path)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface Props {
  onClose: () => void
  connectionId?: string
}

export default function AuditLogPanel({ onClose, connectionId }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [search, setSearch] = useState('')
  const [filterConn, setFilterConn] = useState(connectionId ?? '')
  const [filterStatus, setFilterStatus] = useState<'' | 'ok' | 'fail'>('')
  const [clearConfirm, setClearConfirm] = useState(false)

  useEffect(() => {
    setEntries(loadAuditLog())
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const allConns = [...new Set(entries.map(e => e.connId))]

  const filtered = entries.filter(e => {
    if (filterConn && e.connId !== filterConn) return false
    if (filterStatus === 'ok' && !e.success) return false
    if (filterStatus === 'fail' && e.success) return false
    if (search && !e.sql.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const exportLog = useCallback(async () => {
    const lines = ['timestamp,connId,connName,sql,rowsAffected,success,error']
    for (const e of filtered) {
      const row = [
        new Date(e.ts).toISOString(),
        JSON.stringify(e.connId),
        JSON.stringify(e.connName),
        JSON.stringify(e.sql),
        String(e.rowsAffected),
        String(e.success),
        JSON.stringify(e.error ?? ''),
      ]
      lines.push(row.join(','))
    }
    await saveTextFile(lines.join('\n'), `audit_log_${Date.now()}.csv`, 'CSV 文件', 'csv')
  }, [filtered])

  const clearLog = () => {
    clearAuditLog()
    setEntries([])
    setClearConfirm(false)
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <ClipboardList size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>操作审计日志</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>本地存储 · 最近 {MAX_ENTRIES} 条</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={exportLog} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Download size={11} /> 导出 CSV
            </button>
            <button onClick={() => setClearConfirm(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--error)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Trash2 size={11} /> 清除
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, background: 'var(--surface-2)', borderRadius: 7, border: '1px solid var(--border)', padding: '4px 10px' }}>
            <Search size={12} color="var(--text-muted)" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索 SQL…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 12, color: 'var(--text)' }}
            />
          </div>
          <SearchableSelect
            value={filterConn}
            onChange={setFilterConn}
            items={[{ value: '', label: '全部连接' }, ...allConns.map(c => ({ value: c, label: c }))]}
            width={160}
          />
          <SearchableSelect
            value={filterStatus}
            onChange={v => setFilterStatus(v as '' | 'ok' | 'fail')}
            items={[{ value: '', label: '全部状态' }, { value: 'ok', label: '成功' }, { value: 'fail', label: '失败' }]}
            mono={false}
            width={120}
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{filtered.length} 条</span>
        </div>

        {/* Log table */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              无记录（只有通过 SQL 编辑器执行的写操作才会被记录）
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11, whiteSpace: 'nowrap' }}>时间</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>连接</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>SQL</th>
                  <th style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11, whiteSpace: 'nowrap' }}>影响行</th>
                  <th style={{ padding: '7px 10px', textAlign: 'center', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => (
                  <tr key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)', background: e.success ? undefined : 'rgba(220,38,38,0.04)' }}>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-muted)', fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.connName}>
                      {e.connName || e.connId}
                    </td>
                    <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.sql}>
                      {e.success ? null : <span style={{ color: 'var(--error)', marginRight: 4 }}>✕</span>}
                      {e.sql}
                      {e.error && <span style={{ color: 'var(--error)', marginLeft: 4, fontSize: 10 }}>({e.error.slice(0, 40)}…)</span>}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                      {e.success ? e.rowsAffected : '—'}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                      <span style={{ fontSize: 11, color: e.success ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                        {e.success ? '成功' : '失败'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Clear confirm */}
        {clearConfirm && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setClearConfirm(false)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 360, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--error)' }}>清除审计日志</span>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>将清除本地全部 {entries.length} 条审计记录，此操作不可撤销。</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setClearConfirm(false)} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)' }}>取消</button>
                <button onClick={clearLog} style={{ padding: '5px 14px', borderRadius: 7, background: 'var(--error)', color: '#fff', fontSize: 12, fontWeight: 600 }}>确认清除</button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>,
    document.body
  )
}
