// 隧道独立管理面板 — 读取当前连接的端口转发配置并显示活跃状态
import { GitBranch, X as XIcon, RefreshCw, ArrowRight, ArrowLeft, Globe } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

interface TunnelDef {
  name: string
  type: 'local' | 'remote' | 'dynamic'
  bindIP: string
  bindPort: number
  targetIP: string
  targetPort: number
  disabled: boolean
}

interface Props {
  sessionId: string
  onClose: () => void
}

const TYPE_LABEL: Record<string, string> = { local: '本地', remote: '远程', dynamic: 'SOCKS5' }
const TYPE_COLOR: Record<string, string> = { local: '#3b82f6', remote: '#8b5cf6', dynamic: '#f59e0b' }

function TunnelRow({ t }: { t: TunnelDef }) {
  const color = TYPE_COLOR[t.type] ?? 'var(--accent)'
  return (
    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.disabled ? 'var(--text-muted)' : '#16a34a', marginTop: 5, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        {t.name && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 3 }}>{t.name}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text)' }}>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: color + '22', color }}>{TYPE_LABEL[t.type] ?? t.type}</span>
          {t.type === 'local' && <>
            <code style={{ color: 'var(--accent)' }}>localhost:{t.bindPort}</code>
            <ArrowRight size={10} />
            <code>{t.targetIP}:{t.targetPort}</code>
          </>}
          {t.type === 'remote' && <>
            <code>{t.targetIP}:{t.targetPort}</code>
            <ArrowLeft size={10} />
            <code style={{ color: 'var(--accent)' }}>服务器:{t.bindPort}</code>
          </>}
          {t.type === 'dynamic' && <>
            <Globe size={10} />
            <code style={{ color: 'var(--accent)' }}>SOCKS5 :{t.bindPort}</code>
          </>}
        </div>
        {t.disabled && <div style={{ fontSize: 10, color: '#ea580c', marginTop: 2 }}>已禁用</div>}
      </div>
    </div>
  )
}

export default function TunnelPanel({ sessionId, onClose }: Props) {
  const connections = useAppStore(s => s.connections)
  const tabs = useAppStore(s => s.tabs)
  const allTabTunnels: { label: string; tunnels: TunnelDef[]; isActive: boolean }[] = []
  for (const t of tabs.filter(x => x.type === 'terminal')) {
    const c = connections.find(cx => cx.id === t.connectionId)
    if (!c?.extraJson) continue
    try {
      const ts: TunnelDef[] = JSON.parse(c.extraJson).tunnels ?? []
      if (ts.length) allTabTunnels.push({ label: c.name, tunnels: ts, isActive: t.id === sessionId })
    } catch { /* ignore */ }
  }

  const hasTunnels = allTabTunnels.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <GitBranch size={14} color="var(--accent)" />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-bright)', flex: 1 }}>端口转发</span>
        <button onClick={() => { /* zustand 订阅自动更新 */ }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px', color: 'var(--text-muted)', display: 'flex' }}>
          <RefreshCw size={13} />
        </button>
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px 5px', color: 'var(--text-muted)', display: 'flex' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {!hasTunnels && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            <GitBranch size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
            <div>当前连接无配置的端口转发</div>
            <div style={{ marginTop: 6, fontSize: 11 }}>在连接配置的「高级」选项卡中添加隧道规则</div>
          </div>
        )}

        {allTabTunnels.map((group, gi) => (
          <div key={gi}>
            <div style={{ padding: '6px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: group.isActive ? '#16a34a' : 'var(--border)', display: 'inline-block' }} />
              {group.label}
            </div>
            {group.tunnels.map((t, i) => <TunnelRow key={i} t={t} />)}
          </div>
        ))}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
        隧道在连接配置「高级」→「端口转发」中管理，建立连接后自动生效。
      </div>
    </div>
  )
}
