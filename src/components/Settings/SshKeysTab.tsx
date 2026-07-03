// SSH 密钥管理 tab — 列出/生成/导入/删除密钥，查看/复制公钥
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Key, Plus, Trash2, Copy, Eye, RefreshCw, Upload, Check, AlertTriangle } from 'lucide-react'
import { toast } from '../../stores/toastStore'

interface SshKeyInfo {
  name: string
  path: string
  algo: string
  comment: string
  hasPubkey: boolean
  pubPath?: string
}

const CELL: React.CSSProperties = { padding: '9px 12px', fontSize: 12, color: 'var(--text)', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }
const INPUT: React.CSSProperties = { padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, width: '100%' }
const BTN: React.CSSProperties = { padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }

export default function SshKeysTab() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [genAlgo, setGenAlgo] = useState<'ed25519' | 'rsa'>('ed25519')
  const [genComment, setGenComment] = useState('')
  const [genFilename, setGenFilename] = useState('id_ed25519')
  const [genBusy, setGenBusy] = useState(false)
  const [pubKeyModal, setPubKeyModal] = useState<{ name: string; content: string } | null>(null)
  const [delConfirm, setDelConfirm] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function load() {
    setLoading(true)
    try { setKeys(await invoke<SshKeyInfo[]>('list_ssh_keys')) }
    catch (e) { toast.error(String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function generate() {
    if (!genFilename.trim()) { toast.error('请输入文件名'); return }
    setGenBusy(true)
    try {
      await invoke('generate_ssh_key', { algo: genAlgo, comment: genComment, filename: genFilename.trim() })
      toast.success(`密钥 ${genFilename} 已生成`)
      setGenOpen(false)
      setGenComment('')
      await load()
    } catch (e) { toast.error(String(e)) }
    finally { setGenBusy(false) }
  }

  async function showPubKey(key: SshKeyInfo) {
    try {
      const content = await invoke<string>('get_public_key', { keyPath: key.path })
      setPubKeyModal({ name: key.name, content: content.trim() })
    } catch (e) { toast.error(String(e)) }
  }

  async function importKey() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const path = await open({ title: '选择私钥文件', multiple: false, filters: [] })
      if (!path) return
      const srcPath = typeof path === 'string' ? path : path[0]
      const name = srcPath.split('/').pop()?.split('\\').pop() ?? ''
      await invoke('import_ssh_key', { srcPath, newName: name })
      toast.success(`密钥 ${name} 已导入`)
      await load()
    } catch (e) { toast.error(String(e)) }
  }

  async function deleteKey(keyPath: string) {
    try {
      await invoke('delete_ssh_key', { keyPath })
      toast.success('密钥已删除')
      setDelConfirm(null)
      await load()
    } catch (e) { toast.error(String(e)) }
  }

  function copyPubKey(content: string) {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-bright)', flex: 1 }}>SSH 密钥管理</h3>
        <button onClick={load} style={BTN} data-tip="刷新"><RefreshCw size={13} /></button>
        <button onClick={importKey} style={BTN}><Upload size={13} /> 导入密钥</button>
        <button onClick={() => setGenOpen(!genOpen)}
          style={{ ...BTN, background: 'var(--accent)', color: '#fff', border: 'none' }}>
          <Plus size={13} /> 生成密钥对
        </button>
      </div>

      {/* 生成密钥表单 */}
      {genOpen && (
        <div style={{ marginBottom: 16, padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>算法</div>
              <select value={genAlgo} onChange={e => {
                setGenAlgo(e.target.value as 'ed25519' | 'rsa')
                setGenFilename(e.target.value === 'rsa' ? 'id_rsa' : 'id_ed25519')
              }} style={{ ...INPUT }}>
                <option value="ed25519">Ed25519（推荐）</option>
                <option value="rsa">RSA-4096</option>
              </select>
            </div>
            <div style={{ flex: 2, minWidth: 160 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>文件名（保存至 ~/.ssh/）</div>
              <input value={genFilename} onChange={e => setGenFilename(e.target.value)} style={INPUT} />
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>注释（如 your_email@example.com，可选）</div>
            <input value={genComment} onChange={e => setGenComment(e.target.value)} placeholder="user@hostname" style={INPUT} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={generate} disabled={genBusy}
              style={{ ...BTN, background: 'var(--accent)', color: '#fff', border: 'none', opacity: genBusy ? 0.6 : 1 }}>
              {genBusy ? '生成中…' : '生成'}
            </button>
            <button onClick={() => setGenOpen(false)} style={BTN}>取消</button>
          </div>
        </div>
      )}

      {/* 密钥列表 */}
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
      ) : keys.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          <Key size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
          <div>~/.ssh/ 中没有找到私钥</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>点击「生成密钥对」创建新密钥，或「导入密钥」导入现有私钥</div>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)' }}>
              {['文件名', '算法', '注释', '公钥', '操作'].map(h => (
                <th key={h} style={{ ...CELL, fontWeight: 600, color: 'var(--text-muted)', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.path}>
                <td style={CELL}>
                  <code style={{ color: 'var(--accent)' }}>{k.name}</code>
                </td>
                <td style={CELL}>
                  <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>{k.algo}</span>
                </td>
                <td style={{ ...CELL, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.comment || '—'}</td>
                <td style={CELL}>
                  {k.hasPubkey
                    ? <button onClick={() => showPubKey(k)} style={{ ...BTN, padding: '3px 8px', fontSize: 11 }}><Eye size={11} /> 查看</button>
                    : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>无</span>
                  }
                </td>
                <td style={CELL}>
                  {delConfirm === k.path ? (
                    <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#dc2626' }}>确认删除？</span>
                      <button onClick={() => deleteKey(k.path)} style={{ ...BTN, padding: '2px 8px', fontSize: 11, background: '#dc2626', color: '#fff', border: 'none' }}>删除</button>
                      <button onClick={() => setDelConfirm(null)} style={{ ...BTN, padding: '2px 8px', fontSize: 11 }}>取消</button>
                    </span>
                  ) : (
                    <button onClick={() => setDelConfirm(k.path)} style={{ ...BTN, padding: '3px 8px', fontSize: 11, color: '#dc2626' }}>
                      <Trash2 size={11} /> 删除
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 公钥弹窗 */}
      {pubKeyModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => e.target === e.currentTarget && setPubKeyModal(null)}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, width: 560, maxWidth: '90vw' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Key size={15} color="var(--accent)" />
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-bright)' }}>{pubKeyModal.name} 公钥</span>
              <button onClick={() => setPubKeyModal(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            <textarea readOnly value={pubKeyModal.content}
              style={{ width: '100%', minHeight: 100, padding: 10, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical', boxSizing: 'border-box' }} />
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button onClick={() => copyPubKey(pubKeyModal.content)}
                style={{ ...BTN, flex: 1, justifyContent: 'center', background: 'var(--accent)', color: '#fff', border: 'none' }}>
                {copied ? <><Check size={13} /> 已复制</> : <><Copy size={13} /> 复制公钥</>}
              </button>
              <button onClick={() => setPubKeyModal(null)} style={{ ...BTN, padding: '6px 16px' }}>关闭</button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              将以上内容追加到服务器的 <code>~/.ssh/authorized_keys</code> 即可免密登录
            </div>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={14} color="#ea580c" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>私钥文件保存于 <code>~/.ssh/</code>。请妥善保管私钥，不要分享给他人。在连接配置中选择「密钥认证」可选择已管理的密钥文件。</div>
        </div>
      )}
    </div>
  )
}
