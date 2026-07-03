// 实例级（整连接）导入：选 .sql 在实例级直接执行
// 不强制目标库，由文件内的 CREATE DATABASE / USE 语句驱动还原（可还原多库 dump）
// 底层复用 db_exec_sql_file（省略 schema 参数）
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, FolderOpen, AlertTriangle, Play, CheckCircle, XCircle } from 'lucide-react'
import { notifySchemaChanged } from '../../utils/schemaRefresh'

interface Props {
  connectionId: string
  onClose: () => void
}

interface SqlExecResult { executed: number; failed: number; errors: string[] }
interface SqlFileProgress { current: number; total: number; sql: string; error: string | null }

type Step = 'select' | 'confirm' | 'executing' | 'done'

export default function InstanceImportPanel({ connectionId, onClose }: Props) {
  const [step, setStep] = useState<Step>('select')
  const [filePath, setFilePath] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [progress, setProgress] = useState<SqlFileProgress | null>(null)
  const [result, setResult] = useState<SqlExecResult | null>(null)
  const [error, setError] = useState('')

  const unlistenRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { if (unlistenRef.current) unlistenRef.current() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'executing') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, step])

  const selectFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ filters: [{ name: 'SQL 文件', extensions: ['sql', 'SQL'] }], multiple: false, title: '选择 SQL 文件' })
      if (typeof selected === 'string') {
        setFilePath(selected)
        setStep('confirm')
        setConfirmed(false)
      }
    } catch { /* dialog cancelled */ }
  }

  const doImport = async () => {
    if (!confirmed || !filePath) return
    setStep('executing')
    setError('')
    setProgress(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')
      const unlisten = await listen<SqlFileProgress>('sql_file_progress', ev => setProgress(ev.payload))
      unlistenRef.current = unlisten

      // 不传 schema → 实例级执行，由文件内 USE/CREATE DATABASE 决定落库
      const res = await invoke<SqlExecResult>('db_exec_sql_file', { id: connectionId, path: filePath })
      setResult(res)
      notifySchemaChanged(connectionId)
    } catch (e) {
      setError(String(e))
    } finally {
      if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null }
      setStep('done')
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={step !== 'executing' ? onClose : undefined}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 600, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Play size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>导入数据库</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>整实例 · 直接执行 .sql</span>
          {step !== 'executing' && (
            <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 选择文件 */}
          {(step === 'select' || step === 'confirm') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>SQL 文件（.sql）</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={filePath} readOnly placeholder="点击选择 SQL 文件…"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                <button onClick={selectFile}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 14px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                  <FolderOpen size={13} /> 选择文件
                </button>
              </div>
            </div>
          )}

          {/* 高危确认 */}
          {step === 'confirm' && filePath && (
            <>
              <div style={{ display: 'flex', gap: 10, padding: '12px 14px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 10 }}>
                <AlertTriangle size={16} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
                  <b>实例级导入将按文件内的语句直接执行</b>，包含 <code>CREATE DATABASE</code> / <code>USE</code> / <code>DROP</code> 等，<b>可能新建或覆盖多个数据库的数据</b>。
                  请确认文件来源可信，建议执行前先对实例做一次备份。执行过程中请勿关闭窗口。
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
                我已确认文件来源可信，了解此操作会按文件内容修改实例（可能新建/覆盖多个库），并接受相应风险
              </label>
            </>
          )}

          {/* 执行中 */}
          {step === 'executing' && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <div className="spin" style={{ width: 36, height: 36, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', margin: '0 auto 16px' }} />
              <div style={{ fontSize: 13, color: 'var(--text)' }}>正在执行 SQL 文件…</div>
              {progress && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>语句 {progress.current} / {progress.total}（{pct}%）</div>
                  <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden', margin: '10px auto 0', maxWidth: 360 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
                  </div>
                </>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>请勿关闭窗口…</div>
            </div>
          )}

          {/* 完成 */}
          {step === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {error ? (
                <div style={{ textAlign: 'center', padding: 16 }}>
                  <XCircle size={36} color="var(--error)" style={{ margin: '0 auto 12px' }} />
                  <div style={{ fontSize: 13, color: 'var(--error)', fontWeight: 600 }}>执行失败</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, wordBreak: 'break-all' }}>{error}</div>
                </div>
              ) : result ? (
                <>
                  <div style={{ textAlign: 'center', padding: '8px 0' }}>
                    {result.failed === 0
                      ? <CheckCircle size={36} color="var(--success)" style={{ margin: '0 auto 12px' }} />
                      : <AlertTriangle size={36} color="var(--warning)" style={{ margin: '0 auto 12px' }} />}
                    <div style={{ fontSize: 13, fontWeight: 600, color: result.failed === 0 ? '#16a34a' : '#ea580c' }}>
                      {result.failed === 0 ? '导入完成' : '导入完成（部分语句失败）'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                      成功 {result.executed} 条{result.failed > 0 ? ` · 失败 ${result.failed} 条` : ''}
                    </div>
                  </div>
                  {result.errors.length > 0 && (
                    <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {result.errors.map((err, i) => (
                        <div key={i} style={{ fontSize: 11, color: 'var(--error)', wordBreak: 'break-all' }}>{err}</div>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
          {step === 'confirm' && (
            <button onClick={doImport} disabled={!confirmed || !filePath}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: 'var(--error)', color: '#fff', opacity: (!confirmed || !filePath) ? 0.4 : 1,
              }}>
              <Play size={13} /> 开始导入
            </button>
          )}
          {step !== 'executing' && (
            <button onClick={onClose}
              style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>
              {step === 'done' ? '关闭' : '取消'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
