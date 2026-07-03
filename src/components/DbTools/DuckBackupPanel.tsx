// DD7 DuckDB 备份与恢复面板
import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Loader2, AlertCircle, CheckCircle2, HardDrive, Upload, Download } from 'lucide-react'
import { createPortal } from 'react-dom'

interface Props { connectionId: string }

export default function DuckBackupPanel({ connectionId }: Props) {
  // DD7.1 EXPORT
  const [exportDir, setExportDir] = useState('')
  const [exportFormat, setExportFormat] = useState<'parquet' | 'csv'>('parquet')
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [confirmExport, setConfirmExport] = useState(false)

  // DD7.1 IMPORT
  const [importDir, setImportDir] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmImport, setConfirmImport] = useState(false)

  // DD7.2 文件备份
  const [backupDest, setBackupDest] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [backupResult, setBackupResult] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)

  const pickExportDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false })
    if (dir && typeof dir === 'string') setExportDir(dir)
  }, [])

  const pickImportDir = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false })
    if (dir && typeof dir === 'string') setImportDir(dir)
  }, [])

  const pickBackupDest = useCallback(async () => {
    const path = await save({ filters: [{ name: 'DuckDB', extensions: ['duckdb', 'db'] }] })
    if (path) setBackupDest(path)
  }, [])

  const doExport = useCallback(async () => {
    setExporting(true); setExportResult(null); setExportError(null)
    try {
      const r = await invoke<string>('duckdb_export_database', {
        id: connectionId, outputDir: exportDir, format: exportFormat,
      })
      setExportResult(r); setConfirmExport(false)
    } catch (e) { setExportError(String(e)) }
    finally { setExporting(false) }
  }, [connectionId, exportDir, exportFormat])

  const doImport = useCallback(async () => {
    setImporting(true); setImportResult(null); setImportError(null)
    try {
      const r = await invoke<string>('duckdb_import_database', {
        id: connectionId, inputDir: importDir,
      })
      setImportResult(r); setConfirmImport(false)
    } catch (e) { setImportError(String(e)) }
    finally { setImporting(false) }
  }, [connectionId, importDir])

  const doBackup = useCallback(async () => {
    setBackingUp(true); setBackupResult(null); setBackupError(null)
    try {
      const r = await invoke<string>('duckdb_file_backup', { id: connectionId, destPath: backupDest })
      setBackupResult(r)
    } catch (e) { setBackupError(String(e)) }
    finally { setBackingUp(false) }
  }, [connectionId, backupDest])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* DD7.1 EXPORT DATABASE */}
      <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Download size={13} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>EXPORT DATABASE（DD7.1）</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          将整库的 Schema + 数据导出为目录（Parquet/CSV 格式），可用于跨库迁移或标准备份。
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={exportDir} onChange={e => setExportDir(e.target.value)}
            placeholder="选择输出目录"
            style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
          <button onClick={pickExportDir}
            style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>浏览</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>格式</span>
          {(['parquet', 'csv'] as const).map(f => (
            <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', color: exportFormat === f ? 'var(--accent)' : 'var(--text-muted)' }}>
              <input type="radio" value={f} checked={exportFormat === f} onChange={() => setExportFormat(f)} style={{ accentColor: 'var(--accent)' }} />
              {f.toUpperCase()}
            </label>
          ))}
          <button onClick={() => { setConfirmExport(true); setExportError(null) }}
            disabled={!exportDir.trim()}
            style={{ marginLeft: 'auto', padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, cursor: !exportDir.trim() ? 'not-allowed' : 'pointer', opacity: !exportDir.trim() ? 0.5 : 1 }}>
            导出
          </button>
        </div>
        {exportResult && <div style={{ fontSize: 11, color: 'var(--success)', display: 'flex', gap: 5 }}><CheckCircle2 size={12} />{exportResult}</div>}
        {exportError && <div style={{ fontSize: 11, color: 'var(--error)', display: 'flex', gap: 5 }}><AlertCircle size={12} />{exportError}</div>}
      </div>

      {/* DD7.1 IMPORT DATABASE */}
      <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Upload size={13} style={{ color: 'var(--warning)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>IMPORT DATABASE（DD7.1）</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          从 EXPORT DATABASE 导出的目录中恢复数据。<strong style={{ color: 'var(--warning)' }}>会覆盖当前库的同名表！</strong>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={importDir} onChange={e => setImportDir(e.target.value)}
            placeholder="选择 EXPORT 目录"
            style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
          <button onClick={pickImportDir}
            style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>浏览</button>
          <button onClick={() => { setConfirmImport(true); setImportError(null) }}
            disabled={!importDir.trim()}
            style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: 'var(--warning)', color: '#fff', fontSize: 11, cursor: !importDir.trim() ? 'not-allowed' : 'pointer', opacity: !importDir.trim() ? 0.5 : 1 }}>
            恢复
          </button>
        </div>
        {importResult && <div style={{ fontSize: 11, color: 'var(--success)', display: 'flex', gap: 5 }}><CheckCircle2 size={12} />{importResult}</div>}
        {importError && <div style={{ fontSize: 11, color: 'var(--error)', display: 'flex', gap: 5 }}><AlertCircle size={12} />{importError}</div>}
      </div>

      {/* DD7.2 文件备份 */}
      <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <HardDrive size={13} style={{ color: 'var(--success)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)' }}>文件快照备份（DD7.2）</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          先执行 CHECKPOINT 刷新 WAL，再将 .duckdb 文件复制到指定路径（当前版本仅支持文件库，不含 :memory:）。
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={backupDest} onChange={e => setBackupDest(e.target.value)}
            placeholder="备份目标路径（.duckdb）"
            style={{ flex: 1, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
          <button onClick={pickBackupDest}
            style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>浏览</button>
          <button onClick={doBackup} disabled={backingUp || !backupDest.trim()}
            style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontSize: 11, cursor: (backingUp || !backupDest.trim()) ? 'not-allowed' : 'pointer', opacity: !backupDest.trim() ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 5 }}>
            {backingUp ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            备份
          </button>
        </div>
        {backupResult && <div style={{ fontSize: 11, color: 'var(--success)', display: 'flex', gap: 5 }}><CheckCircle2 size={12} />{backupResult}</div>}
        {backupError && <div style={{ fontSize: 11, color: 'var(--error)', display: 'flex', gap: 5 }}><AlertCircle size={12} />{backupError}</div>}
      </div>

      {/* EXPORT 确认弹窗 */}
      {confirmExport && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 440, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>确认 EXPORT DATABASE</div>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              将执行：<code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>
                EXPORT DATABASE '{exportDir}' (FORMAT {exportFormat.toUpperCase()})
              </code><br />
              输出目录 <strong>{exportDir}</strong> 中的文件将被覆盖。
            </div>
            {exportError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{exportError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmExport(false)}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doExport} disabled={exporting}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: exporting ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {exporting ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认导出
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* IMPORT 确认弹窗 */}
      {confirmImport && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 440, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>确认 IMPORT DATABASE</div>
            <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>
              将执行：<code style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3 }}>
                IMPORT DATABASE '{importDir}'
              </code>
            </div>
            <div style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #dc262640', background: '#dc262608', fontSize: 12, color: 'var(--error)' }}>
              ⚠ IMPORT 会覆盖当前库中与导出目录同名的表，操作不可撤销！请确认已备份当前数据。
            </div>
            {importError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{importError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmImport(false)}
                style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>取消</button>
              <button onClick={doImport} disabled={importing}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: 'var(--error)', color: '#fff', cursor: importing ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {importing ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                确认恢复（覆盖）
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
