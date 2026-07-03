// SSH Config 文件导入向导
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileInput, Check, X as XIcon, Download } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { toast } from '../../stores/toastStore'
import type { ConnConfig } from '../../types'

interface SshConfigHost {
  alias: string
  hostname: string
  user: string
  port: number
  identityFile: string
  proxyJump: string
}

interface Props { onClose: () => void }

export default function SshConfigImportDialog({ onClose }: Props) {
  const [hosts, setHosts] = useState<SshConfigHost[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const { saveConnection, loadConnections, connections } = useAppStore()

  useEffect(() => {
    invoke<SshConfigHost[]>('parse_ssh_config')
      .then(list => {
        setHosts(list)
        setSelected(new Set(list.map(h => h.alias)))
        setLoading(false)
      })
      .catch(e => { toast.error(String(e)); setLoading(false) })
  }, [])

  function toggle(alias: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(alias) ? next.delete(alias) : next.add(alias)
      return next
    })
  }

  async function doImport() {
    const toImport = hosts.filter(h => selected.has(h.alias))
    if (!toImport.length) { toast.error('请至少选择一条记录'); return }
    setImporting(true)
    let count = 0, skipped = 0
    // 构建去重 key 集合（含同批次内已处理的），避免 '' === undefined 误判
    const seenKeys = new Set(connections.map(c => `${c.host}|${c.port}|${c.username ?? ''}`))
    for (const h of toImport) {
      const key = `${h.hostname}|${h.port}|${h.user ?? ''}`
      if (seenKeys.has(key)) { skipped++; continue }
      seenKeys.add(key)
      const config: ConnConfig = {
        id: `ssh-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: h.alias,
        type: 'ssh',
        host: h.hostname,
        port: h.port,
        username: h.user || undefined,
        sshKeyPath: h.identityFile || undefined,
        useSsl: false,
        // proxyJump 写入 extraJson，保留跳板机配置；"none" 是 SSH config 中明确无跳板的值，不写入
        extraJson: (h.proxyJump && h.proxyJump.toLowerCase() !== 'none')
          ? JSON.stringify({ proxyJump: h.proxyJump }) : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      try {
        await saveConnection(config)
        count++
      } catch { skipped++ }
    }
    await loadConnections()
    toast.success(`已导入 ${count} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`)
    setImporting(false)
    onClose()
  }

  const CELL: React.CSSProperties = { padding: '8px 10px', fontSize: 12, border: '1px solid var(--border-subtle)', color: 'var(--text)' }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 600, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileInput size={16} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-bright)', flex: 1 }}>从 SSH Config 导入连接</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}><XIcon size={15} /></button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>解析 ~/.ssh/config 中…</div>
          ) : hosts.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 32 }}>
              <FileInput size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>未找到可导入的主机记录</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>请确认 ~/.ssh/config 文件存在且包含 Host 块</div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>共 {hosts.length} 条，已选 {selected.size} 条</span>
                <button onClick={() => setSelected(new Set(hosts.map(h => h.alias)))}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>全选</button>
                <button onClick={() => setSelected(new Set())}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>取消全选</button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    {['', '别名', '主机', '用户', '端口', '密钥'].map((h, i) => (
                      <th key={i} style={{ ...CELL, fontWeight: 600, color: 'var(--text-muted)', textAlign: 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hosts.map(h => (
                    <tr key={h.alias} onClick={() => toggle(h.alias)} style={{ cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ ...CELL, width: 28 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border)', background: selected.has(h.alias) ? 'var(--accent)' : 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {selected.has(h.alias) && <Check size={10} color="#fff" />}
                        </div>
                      </td>
                      <td style={CELL}><strong>{h.alias}</strong></td>
                      <td style={CELL}><code>{h.hostname}</code></td>
                      <td style={CELL}>{h.user || '—'}</td>
                      <td style={CELL}>{h.port}</td>
                      <td style={{ ...CELL, color: 'var(--text-muted)', fontSize: 11 }}>{h.identityFile ? h.identityFile.split('/').pop() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {hosts.length > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <button onClick={doImport} disabled={importing || !selected.size}
              style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: importing || !selected.size ? 'not-allowed' : 'pointer', opacity: importing || !selected.size ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Download size={13} /> {importing ? '导入中…' : `导入选中 (${selected.size})`}
            </button>
            <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
