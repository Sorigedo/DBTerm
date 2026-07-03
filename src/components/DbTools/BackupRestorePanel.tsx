// G3 — 备份恢复（整库/指定表选择性恢复）
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, FolderOpen, AlertTriangle, Play, CheckCircle, XCircle, RotateCcw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

interface BackupIntegrityItem {
  table: string
  dbCount: number
  backupCount: number
  matchOk: boolean
  error: string | null
}

interface Props {
  connectionId: string
  schema: string
  onClose: () => void
}

type Step = 'select' | 'preview' | 'executing' | 'done'

export default function BackupRestorePanel({ connectionId, schema, onClose }: Props) {
  const [step, setStep] = useState<Step>('select')
  const [filePath, setFilePath] = useState('')
  const [integrity, setIntegrity] = useState<BackupIntegrityItem[]>([])
  const [checkingIntegrity, setCheckingIntegrity] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<{ ok: boolean; msg: string }>({ ok: false, msg: '' })
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const selectFile = async () => {
    try {
      const selected = await open({ filters: [{ name: 'SQL Backup', extensions: ['sql', 'SQL'] }], multiple: false })
      if (selected && typeof selected === 'string') {
        setFilePath(selected)
        await checkIntegrity(selected)
      }
    } catch {
      // dialog cancelled
    }
  }

  const checkIntegrity = async (path: string) => {
    setCheckingIntegrity(true)
    try {
      const items = await invoke<BackupIntegrityItem[]>('db_backup_integrity', {
        id: connectionId, schema, backupPath: path,
      })
      setIntegrity(items)
      setStep('preview')
    } catch {
      // Integrity check failed — still allow restore
      setIntegrity([])
      setStep('preview')
    } finally {
      setCheckingIntegrity(false)
    }
  }

  const doRestore = async () => {
    if (!confirmed) return
    setStep('executing')
    setProgress('正在执行 SQL 文件...')
    try {
      await invoke('db_exec_sql_file', { id: connectionId, schema, filePath })
      setResult({ ok: true, msg: '备份文件执行完成，数据已恢复' })
    } catch (e) {
      setResult({ ok: false, msg: String(e) })
    } finally {
      setStep('done')
    }
  }

  const mismatchCount = integrity.filter(i => !i.matchOk).length
  const hasIntegrity = integrity.length > 0

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 680, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <RotateCcw size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>备份恢复</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>目标库: {schema}</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {/* Step 1: Select file */}
          {(step === 'select' || step === 'preview') && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>备份文件（.sql）</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={filePath}
                  readOnly
                  placeholder="点击选择备份文件..."
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }}
                />
                <button className="btn-primary" onClick={selectFile} disabled={checkingIntegrity} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}>
                  <FolderOpen size={13} />
                  {checkingIntegrity ? '检查中...' : '选择文件'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Preview + integrity */}
          {step === 'preview' && filePath && (
            <>
              {/* Warning */}
              <div style={{ display: 'flex', gap: 10, padding: '12px 14px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 10, marginBottom: 16 }}>
                <AlertTriangle size={16} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
                  <b>恢复操作将执行备份文件中所有 SQL 语句</b>，可能覆盖现有数据。
                  建议在执行前先对当前数据库做一次备份。恢复过程中请勿关闭窗口。
                </div>
              </div>

              {/* G4 Integrity check results */}
              {hasIntegrity && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                    完整性核查
                    {mismatchCount > 0
                      ? <span style={{ color: 'var(--warning)', marginLeft: 8 }}>⚠ {mismatchCount} 张表行数不一致</span>
                      : <span style={{ color: 'var(--success)', marginLeft: 8 }}>✓ 全部一致</span>
                    }
                  </div>
                  <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-2)' }}>
                          {['表名', '数据库行数', '备份行数', '状态'].map(h => (
                            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {integrity.map((item, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)' }}>{item.table}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{item.dbCount < 0 ? '—' : item.dbCount.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{item.backupCount.toLocaleString()}</td>
                            <td style={{ padding: '6px 10px' }}>
                              {item.matchOk
                                ? <CheckCircle size={12} color="var(--success)" />
                                : <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <XCircle size={12} color="var(--warning)" />
                                    <span style={{ fontSize: 10, color: 'var(--warning)' }}>{item.error || '不一致'}</span>
                                  </span>
                              }
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
                我了解此操作将修改目标数据库，已确认备份文件来源可信，并接受数据被覆盖的风险
              </label>
            </>
          )}

          {/* Step 3: Executing */}
          {step === 'executing' && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <div className="spin" style={{ width: 36, height: 36, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', margin: '0 auto 16px' }} />
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{progress}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>请勿关闭窗口...</div>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              {result.ok
                ? <CheckCircle size={36} color="var(--success)" style={{ margin: '0 auto 16px' }} />
                : <XCircle size={36} color="var(--error)" style={{ margin: '0 auto 16px' }} />
              }
              <div style={{ fontSize: 13, color: result.ok ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>{result.msg}</div>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {step === 'preview' && (
            <button className="btn-danger" onClick={doRestore} disabled={!confirmed || !filePath} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Play size={13} /> 开始恢复
            </button>
          )}
          {(step === 'done' || step === 'select') && (
            <button className="btn-cancel" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
