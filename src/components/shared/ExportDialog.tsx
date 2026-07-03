import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { FileOutput, X, Check, Terminal, Database, CheckCircle2, AlertCircle, Copy } from 'lucide-react'
import type { ConnConfig } from '../../types'

interface Props {
  connections: ConnConfig[]
  onClose: () => void
}

const TYPE_LABEL: Record<string, string> = {
  local: '本地终端', ssh: 'SSH', mysql: 'MySQL', postgres: 'PostgreSQL',
  sqlite: 'SQLite', redis: 'Redis', tidb: 'TiDB', oceanBase: 'OceanBase',
  mariadb: 'MariaDB', kingBase: '金仓', openGauss: 'openGauss',
  clickHouse: 'ClickHouse',
}

export default function ExportDialog({ connections, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(connections.map(c => c.id)))
  const [filename, setFilename] = useState(`dbterm-connections-${new Date().toISOString().slice(0, 10)}`)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone]       = useState<{ count: number; path: string } | null>(null)
  const [copied, setCopied]   = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const allChecked = selected.size === connections.length
  const toggleAll  = () => setSelected(allChecked ? new Set() : new Set(connections.map(c => c.id)))
  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const isTerminal = (c: ConnConfig) => c.type === 'ssh' || c.type === 'local'

  const doExport = async () => {
    if (selected.size === 0) { setError('请至少选择一个连接'); return }
    const name = filename.trim() || 'dbterm-connections'
    const toExport = connections.filter(c => selected.has(c.id))
    const data = JSON.stringify({ version: 1, connections: toExport }, null, 2)
    setExporting(true)
    setError('')
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: `${name}.json`,
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      })
      if (!path) { setExporting(false); return }
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content: data })
      setDone({ count: toExport.length, path })
    } catch (e) {
      setError(`导出失败：${e}`)
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box export-dlg"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 420 }}
      >
        {/* 标题 */}
        <div className="cdlg-head" style={{ marginBottom: 12 }}>
          <FileOutput size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          <span className="cdlg-head__title">导出连接配置</span>
          <button className="export-dlg__close" onClick={onClose}><X size={14} /></button>
        </div>

        {done ? (
          /* ── 导出成功态 ── */
          <div className="export-dlg__result export-dlg__result--ok">
            <CheckCircle2 size={36} className="export-dlg__result-icon" />
            <div className="export-dlg__result-title">导出成功</div>
            <div className="export-dlg__result-desc">
              已导出 <strong>{done.count}</strong> 个连接配置
            </div>
            <div className="export-dlg__result-path-row">
              <div className="export-dlg__result-path" title={done.path}>{done.path}</div>
              <button
                className="export-dlg__copy-btn"
                data-tip="复制路径"
                onClick={() => {
                  navigator.clipboard.writeText(done.path).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
              </button>
            </div>
            <button className="cdlg-btn cdlg-btn--ok" style={{ marginTop: 16 }} onClick={onClose}>
              关闭
            </button>
          </div>
        ) : (
          <>
            {/* 文件名 */}
            <div className="export-dlg__row">
              <label className="export-dlg__label">文件名</label>
              <div className="export-dlg__filename-wrap">
                <input
                  className="export-dlg__input"
                  value={filename}
                  onChange={e => setFilename(e.target.value)}
                  placeholder="dbterm-connections"
                  spellCheck={false}
                />
                <span className="export-dlg__ext">.json</span>
              </div>
            </div>

            {/* 连接选择 */}
            <div className="export-dlg__row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                <label className="export-dlg__label" style={{ marginBottom: 0 }}>选择连接</label>
                <button className="export-dlg__toggle-all" onClick={toggleAll}>
                  {allChecked ? '取消全选' : '全部选择'}
                </button>
              </div>
              <div className="export-dlg__list">
                {connections.map(c => (
                  <label key={c.id} className="export-dlg__item">
                    <div className={`export-dlg__checkbox${selected.has(c.id) ? ' checked' : ''}`} onClick={() => toggle(c.id)}>
                      {selected.has(c.id) && <Check size={10} strokeWidth={3} />}
                    </div>
                    <span className="export-dlg__item-icon">
                      {isTerminal(c) ? <Terminal size={12} /> : <Database size={12} />}
                    </span>
                    <div className="export-dlg__item-info">
                      <span className="export-dlg__item-name">{c.name}</span>
                      <span className="export-dlg__item-type">{TYPE_LABEL[c.type] ?? c.type}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <div className="export-dlg__result export-dlg__result--err">
                <AlertCircle size={18} className="export-dlg__result-icon" />
                <span>{error}</span>
              </div>
            )}

            <div className="cdlg-foot" style={{ marginTop: 12 }}>
              <span className="export-dlg__count">已选 {selected.size} / {connections.length} 个</span>
              <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>取消</button>
              <button
                className="cdlg-btn cdlg-btn--ok"
                onClick={doExport}
                disabled={exporting || selected.size === 0}
              >
                {exporting ? '导出中…' : '选择路径并导出'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
