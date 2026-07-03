// 连接配置导出/备份向导（加密 JSON）
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Shield, Download, Upload, Eye, EyeOff, X as XIcon, Copy, Check } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { toast } from '../../stores/toastStore'

interface Props { onClose: () => void }

export default function ConnExportImportDialog({ onClose }: Props) {
  const [mode, setMode] = useState<'export' | 'import'>('export')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exportData, setExportData] = useState('')
  const [importData, setImportData] = useState('')
  const [copied, setCopied] = useState(false)
  const { loadConnections } = useAppStore()

  async function doExport() {
    if (!password) { toast.error('请输入加密口令'); return }
    if (password !== password2) { toast.error('两次口令不一致'); return }
    setBusy(true)
    try {
      const data = await invoke<string>('export_connections_encrypted', { password })
      setExportData(data)
      toast.success('导出成功！请妥善保存加密数据和口令')
    } catch (e) { toast.error(String(e)) }
    finally { setBusy(false) }
  }

  async function doImport() {
    if (!importData.trim()) { toast.error('请粘贴加密数据'); return }
    if (!password) { toast.error('请输入口令'); return }
    setBusy(true)
    try {
      const count = await invoke<number>('import_connections_encrypted', { data: importData.trim(), password })
      await loadConnections()
      toast.success(`已导入 ${count} 条连接`)
      onClose()
    } catch (e) { toast.error(String(e)) }
    finally { setBusy(false) }
  }

  function copyData() {
    navigator.clipboard.writeText(exportData).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function saveFile() {
    const blob = new Blob([exportData], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'dbterm-backup.enc'; a.click()
    // Tauri WKWebView 的 click 触发下载是异步的，延迟 2s 再 revoke 避免文件为空
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  function loadFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => setImportData((reader.result as string).trim())
      reader.onerror = () => toast.error('文件读取失败，请检查文件权限')
      reader.readAsText(file)
    }
    input.click()
  }

  const INPUT: React.CSSProperties = { padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, width: '100%', boxSizing: 'border-box' }
  const BTN: React.CSSProperties = { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={16} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-bright)', flex: 1 }}>连接备份与迁移</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}><XIcon size={15} /></button>
        </div>

        {/* 模式切换 */}
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 6 }}>
          {(['export', 'import'] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setPassword(''); setPassword2(''); setShowPw(false); setExportData(''); setImportData('') }}
              style={{ ...BTN, flex: 1, justifyContent: 'center', background: mode === m ? 'var(--accent)' : 'var(--surface-2)', color: mode === m ? '#fff' : 'var(--text)', border: mode === m ? 'none' : '1px solid var(--border)' }}>
              {m === 'export' ? <><Download size={13} /> 导出备份</> : <><Upload size={13} /> 导入恢复</>}
            </button>
          ))}
        </div>

        <div style={{ padding: 18 }}>
          {mode === 'export' ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                导出所有连接配置（含保存的密码），以口令加密保护。请妥善保存加密数据和口令，两者缺一不可。
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>加密口令</div>
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="设置加密口令" style={{ ...INPUT, paddingRight: 36 }} />
                  <button onClick={() => setShowPw(v => !v)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}>
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>确认口令</div>
                <input type={showPw ? 'text' : 'password'} value={password2} onChange={e => setPassword2(e.target.value)}
                  placeholder="再次输入口令" style={INPUT} />
              </div>
              <button onClick={doExport} disabled={busy}
                style={{ ...BTN, width: '100%', justifyContent: 'center', background: 'var(--accent)', color: '#fff', border: 'none', opacity: busy ? 0.6 : 1, marginBottom: exportData ? 12 : 0 }}>
                <Download size={13} /> {busy ? '导出中…' : '导出'}
              </button>

              {exportData && (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>加密数据（可复制保存，或另存为文件）</div>
                  <textarea readOnly value={exportData}
                    style={{ ...INPUT, fontFamily: 'var(--font-mono)', fontSize: 11, minHeight: 80, resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button onClick={copyData} style={{ ...BTN, flex: 1, justifyContent: 'center' }}>
                      {copied ? <><Check size={13} /> 已复制</> : <><Copy size={13} /> 复制数据</>}
                    </button>
                    <button onClick={saveFile} style={{ ...BTN, flex: 1, justifyContent: 'center' }}>
                      <Download size={13} /> 另存为文件
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                粘贴导出的加密数据（或从文件加载），输入口令解密并导入连接配置。已存在的连接将被更新。
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>加密数据</span>
                  <button onClick={loadFile} style={{ ...BTN, padding: '3px 8px', fontSize: 11 }}>
                    <Upload size={11} /> 从文件加载
                  </button>
                </div>
                <textarea value={importData} onChange={e => setImportData(e.target.value)}
                  placeholder="粘贴加密数据…"
                  style={{ ...INPUT, fontFamily: 'var(--font-mono)', fontSize: 11, minHeight: 80, resize: 'vertical' }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>解密口令</div>
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="输入加密时设置的口令" style={{ ...INPUT, paddingRight: 36 }} />
                  <button onClick={() => setShowPw(v => !v)}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}>
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <button onClick={doImport} disabled={busy}
                style={{ ...BTN, width: '100%', justifyContent: 'center', background: 'var(--accent)', color: '#fff', border: 'none', opacity: busy ? 0.6 : 1 }}>
                <Upload size={13} /> {busy ? '导入中…' : '导入恢复'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
