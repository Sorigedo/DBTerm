import { useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, Copy, Check, X, FolderOpen, FileOutput, Loader2 } from 'lucide-react'
import { useExportDoneStore } from '../stores/exportDoneStore'

export default function ExportDoneModal() {
  const { phase, info, errorMsg, close } = useExportDoneStore()
  const [copied, setCopied] = useState(false)

  if (!phase) return null

  const reveal = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('reveal_in_folder', { filePath: info!.path })
    } catch (e) { console.error('打开所在位置失败:', e) }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={phase !== 'loading' ? close : undefined}>
      <div className="cdlg-box export-dlg" onMouseDown={e => e.stopPropagation()} style={{ width: 420 }}>
        <div className="cdlg-head" style={{ marginBottom: 12 }}>
          <FileOutput size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          <span className="cdlg-head__title">导出</span>
          {phase !== 'loading' && (
            <button className="export-dlg__close" onClick={close}><X size={14} /></button>
          )}
        </div>

        {phase === 'loading' && (
          <div className="export-dlg__result" style={{ padding: '28px 0 24px' }}>
            <Loader2 size={36} className="export-dlg__result-icon export-dlg__spin" style={{ color: 'var(--accent)' }} />
            <div className="export-dlg__result-title" style={{ marginTop: 12 }}>正在导出…</div>
            <div className="export-dlg__result-desc" style={{ color: 'var(--text-muted)' }}>请稍候</div>
          </div>
        )}

        {phase === 'done' && info && (
          <div className="export-dlg__result export-dlg__result--ok">
            <CheckCircle2 size={36} className="export-dlg__result-icon" />
            <div className="export-dlg__result-title">导出成功</div>
            {info.detail && <div className="export-dlg__result-desc">{info.detail}</div>}
            <div className="export-dlg__result-path-row">
              <div className="export-dlg__result-path" title={info.path}>{info.path}</div>
              <button
                className="export-dlg__copy-btn"
                data-tip="复制路径"
                onClick={() => {
                  navigator.clipboard.writeText(info.path).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="cdlg-btn cdlg-btn--ok" onClick={reveal} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FolderOpen size={13} /> 打开所在位置
              </button>
              <button className="cdlg-btn cdlg-btn--cancel" onClick={close}>关闭</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="export-dlg__result" style={{ padding: '28px 16px 24px' }}>
            <XCircle size={36} style={{ color: '#dc2626', marginBottom: 12 }} />
            <div className="export-dlg__result-title" style={{ color: '#dc2626' }}>导出失败</div>
            <div className="export-dlg__result-desc" style={{ color: 'var(--text-muted)', wordBreak: 'break-all', maxWidth: 340, textAlign: 'center' }}>
              {errorMsg}
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="cdlg-btn cdlg-btn--cancel" onClick={close}>关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
