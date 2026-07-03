// 快速临时连接 — 不保存凭据，输入 user@host:port 直接连接
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Zap, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { ConnConfig } from '../../types'

interface Props { onClose: () => void }

export default function QuickConnectDialog({ onClose }: Props) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [err, setErr] = useState('')
  const { openTab } = useAppStore()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 解析 user@host:port 格式
  function parseTarget(raw: string) {
    let u = user, h = host, p = parseInt(port) || 22
    const atIdx = raw.lastIndexOf('@')
    if (atIdx > 0) { u = raw.slice(0, atIdx); raw = raw.slice(atIdx + 1) }
    const colonIdx = raw.lastIndexOf(':')
    if (colonIdx > 0 && !isNaN(Number(raw.slice(colonIdx + 1)))) {
      p = parseInt(raw.slice(colonIdx + 1)); h = raw.slice(0, colonIdx)
    } else { h = raw }
    return { u, h, p }
  }

  async function connect() {
    setErr('')
    const { u, h, p } = parseTarget(host)
    if (!h.trim()) { setErr('请输入主机地址'); return }
    if (!u.trim()) { setErr('请输入用户名'); return }

    setConnecting(true)
    try {
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      if (!isTauri) { setErr('仅在 Tauri 环境中可用'); setConnecting(false); return }

      // 创建临时连接配置（不保存到列表，用 quick- 前缀的 ID 标记）
      const tempId = `quick-${Date.now()}`
      const config: ConnConfig = {
        id: tempId,
        name: `${u}@${h}`,
        type: 'ssh',
        host: h,
        port: p,
        username: u,
        useSsl: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const { invoke } = await import('@tauri-apps/api/core')
      // 保存临时连接（带密码）
      await invoke('save_connection', { config, password: pass || null })
      // 刷新连接列表
      await useAppStore.getState().loadConnections()
      // 打开终端 tab
      const tabId = `tab-${tempId}-${Date.now()}`
      openTab({
        id: tabId,
        connectionId: tempId,
        title: `${u}@${h}`,
        type: 'terminal',
      })
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setConnecting(false)
    }
  }

  const INPUT: React.CSSProperties = {
    padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)',
    background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, width: '100%',
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 24, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <Zap size={18} color="var(--accent)" />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-bright)' }}>快速连接</h3>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>主机（支持 user@host:port 格式）</div>
            <input ref={inputRef} value={host} onChange={e => setHost(e.target.value)}
              placeholder="192.168.1.1 或 user@192.168.1.1:2222"
              style={INPUT}
              onKeyDown={e => e.key === 'Enter' && connect()} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>用户名</div>
              <input value={user} onChange={e => setUser(e.target.value)} placeholder="root"
                style={INPUT} onKeyDown={e => e.key === 'Enter' && connect()} />
            </div>
            <div style={{ width: 90 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>端口</div>
              <input value={port} onChange={e => setPort(e.target.value)} placeholder="22"
                style={INPUT} onKeyDown={e => e.key === 'Enter' && connect()} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>密码（可选，也可留空用密钥）</div>
            <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="SSH 密码"
              style={INPUT} onKeyDown={e => e.key === 'Enter' && connect()} />
          </div>

          {err && <div style={{ fontSize: 12, color: '#dc2626', padding: '6px 10px', background: 'rgba(220,38,38,0.08)', borderRadius: 6 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button onClick={connect} disabled={connecting}
              style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: connecting ? 'not-allowed' : 'pointer', opacity: connecting ? 0.7 : 1 }}>
              {connecting ? '连接中…' : '立即连接'}
            </button>
            <button onClick={onClose}
              style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
              取消
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            此连接将临时保存到连接列表，不用时可手动删除
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
