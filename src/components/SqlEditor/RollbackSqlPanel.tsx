import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RotateCcw, Copy, Download, Trash2 } from 'lucide-react'
import { loadRollback, clearRollback, type RollbackEntry } from '../../stores/rollbackStore'
import { toast } from '../../stores/toastStore'
import SearchableSelect from '../DbTools/SearchableSelect'
import { queueLocalTextExport } from '../../utils/exportTasks'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    queueLocalTextExport(path, content, label)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface Props {
  connectionId?: string
  onInsertSql?: (sql: string) => void
  onClose: () => void
}

export default function RollbackSqlPanel({ connectionId, onInsertSql, onClose }: Props) {
  const [entries, setEntries] = useState<RollbackEntry[]>([])
  const [copied, setCopied] = useState('')
  const [clearConfirm, setClearConfirm] = useState(false)
  const [filterConn, setFilterConn] = useState(connectionId ?? '')

  useEffect(() => {
    setEntries(loadRollback())
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = filterConn
    ? entries.filter(e => e.connId === filterConn)
    : entries

  const copy = (id: string, sql: string) => {
    navigator.clipboard.writeText(sql)
    setCopied(id)
    setTimeout(() => setCopied(''), 1500)
  }

  const exportAll = async () => {
    const text = filtered.map(e =>
      `-- ${new Date(e.ts).toLocaleString()} · ${e.description}\n${e.sql}`
    ).join('\n\n')
    await saveTextFile(text, `rollback_sql_${Date.now()}.sql`, 'SQL 文件', 'sql')
  }

  const doClear = () => {
    clearRollback()
    setEntries([])
    setClearConfirm(false)
  }

  const allConns = [...new Set(entries.map(e => e.connId))]

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <RotateCcw size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>回滚 SQL 存档</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>误操作救援</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={exportAll} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Download size={11} /> 导出
            </button>
            <button onClick={() => setClearConfirm(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--error)', padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Trash2 size={11} /> 清除
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>

        {/* Filter */}
        {allConns.length > 1 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <SearchableSelect
              value={filterConn}
              onChange={setFilterConn}
              items={[{ value: '', label: '全部连接' }, ...allConns.map(c => ({ value: c, label: c }))]}
              width={220}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 10 }}>{filtered.length} 条记录</span>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              暂无记录（通过网格提交 UPDATE/DELETE 后会自动生成反向 SQL 存档）
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {filtered.map(e => (
                <div key={e.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {new Date(e.ts).toLocaleString()}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                      {e.schema ? `${e.schema}.` : ''}{e.table}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>{e.description}</span>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button
                        onClick={() => copy(e.id, e.sql)}
                        style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: copied === e.id ? '#16a34a' : 'var(--text-muted)', padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}
                      >
                        <Copy size={10} /> {copied === e.id ? '已复制' : '复制'}
                      </button>
                      {onInsertSql && (
                        <button
                          onClick={() => { onInsertSql(e.sql); onClose() }}
                          style={{ fontSize: 11, color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)' }}
                        >
                          插入编辑器
                        </button>
                      )}
                    </div>
                  </div>
                  <pre style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)',
                    background: 'var(--bg)', borderRadius: 6, padding: '8px 12px',
                    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    maxHeight: 150, overflow: 'auto', border: '1px solid var(--border-subtle)',
                  }}>
                    {e.sql}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        {clearConfirm && createPortal(
          <div className="cdlg-overlay" onMouseDown={() => setClearConfirm(false)}>
            <div className="cdlg-box" onMouseDown={e => e.stopPropagation()} style={{ width: 360, padding: 24, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--error)' }}>清除回滚存档</span>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>将清除全部 {entries.length} 条回滚 SQL，此操作不可撤销。</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setClearConfirm(false)} style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12, color: 'var(--text)' }}>取消</button>
                <button onClick={doClear} style={{ padding: '5px 14px', borderRadius: 7, background: 'var(--error)', color: '#fff', fontSize: 12, fontWeight: 600 }}>确认清除</button>
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
