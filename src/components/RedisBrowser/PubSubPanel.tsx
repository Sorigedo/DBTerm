// R5 Pub/Sub 面板（SUBSCRIBE / PSUBSCRIBE 实时消息 + PUBLISH + 活跃频道列表）
import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Radio, Send, RefreshCw, X, Loader2 } from 'lucide-react'

interface Props { connectionId: string; db: number }

interface PubSubMsg {
  kind: string
  channel: string
  pattern?: string
  data: string
  ts: number
}

export default function PubSubPanel({ connectionId, db }: Props) {
  const [channels,  setChannels]  = useState('')        // 订阅频道（逗号分隔）
  const [patterns,  setPatterns]  = useState('')        // 订阅模式
  const [messages,  setMessages]  = useState<PubSubMsg[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [subLoading,setSubLoading]= useState(false)
  const [error,     setError]     = useState('')

  // PUBLISH
  const [pubChannel,setPubChannel] = useState('')
  const [pubMessage,setPubMessage] = useState('')
  const [pubResult, setPubResult]  = useState<string | null>(null)

  // 活跃频道
  const [activeChans, setActiveChans] = useState<string[]>([])

  const bottomRef = useRef<HTMLDivElement>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 清理订阅事件监听
  useEffect(() => {
    return () => { unlistenRef.current?.() }
  }, [])

  const subscribe = async () => {
    const chList = channels.split(',').map(s => s.trim()).filter(Boolean)
    const patList = patterns.split(',').map(s => s.trim()).filter(Boolean)
    if (!chList.length && !patList.length) { setError('请输入至少一个频道或模式'); return }

    setSubLoading(true)
    setError('')
    try {
      // 取消之前的监听
      unlistenRef.current?.()
      const sid = await invoke<string>('redis_subscribe', {
        id: connectionId,
        channels: chList,
        patterns: patList,
      })
      setSessionId(sid)
      setMessages([])
      const unlisten = await listen<PubSubMsg>(`redis_pubsub_msg_${sid}`, ev => {
        setMessages(prev => [...prev.slice(-499), ev.payload])
      })
      unlistenRef.current = unlisten
    } catch (e) { setError(String(e)) }
    finally { setSubLoading(false) }
  }

  const unsubscribe = () => {
    unlistenRef.current?.()
    unlistenRef.current = null
    setSessionId(null)
  }

  const publish = async () => {
    if (!pubChannel.trim()) { setError('频道名不能为空'); return }
    try {
      const n = await invoke<number>('redis_publish', {
        id: connectionId, channel: pubChannel.trim(), message: pubMessage, db,
      })
      setPubResult(`已发布，${n} 个订阅者收到`)
    } catch (e) { setError(String(e)) }
  }

  const loadActiveChannels = async () => {
    try {
      const chs = await invoke<string[]>('redis_pubsub_channels', { id: connectionId, pattern: '*', db })
      setActiveChans(chs)
    } catch (e) { setError(String(e)) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="redis-type-toolbar" style={{ gap: 6, flexShrink: 0 }}>
        <Radio size={13} strokeWidth={2} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pub/Sub</span>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '10px 12px', overflow: 'hidden' }}>

        {/* 左：订阅 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>订阅（SUBSCRIBE / PSUBSCRIBE）</div>

          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="频道名（逗号分隔），如 news, order:*"
            value={channels}
            onChange={e => setChannels(e.target.value)}
          />
          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="模式（PSUBSCRIBE），如 user:*"
            value={patterns}
            onChange={e => setPatterns(e.target.value)}
          />

          <div style={{ display: 'flex', gap: 6 }}>
            {sessionId ? (
              <button className="cdlg-btn cdlg-btn--cancel" style={{ flex: 1 }} onClick={unsubscribe}>
                <X size={12} /> 取消订阅
              </button>
            ) : (
              <button className="cdlg-btn" style={{ flex: 1, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
                onClick={subscribe} disabled={subLoading}>
                {subLoading ? <Loader2 size={12} className="spin" /> : <Radio size={12} />}
                订阅
              </button>
            )}
          </div>

          {sessionId && (
            <div style={{ fontSize: 11, color: 'var(--success)' }}>
              ● 已订阅（会话 {sessionId.slice(-8)}）
            </div>
          )}

          {/* 消息流 */}
          <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border-subtle)', padding: '6px 8px', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {messages.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>等待消息…</div>
            ) : messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(m.ts * 1000).toLocaleTimeString()} </span>
                <span style={{ color: 'var(--accent)' }}>[{m.channel}] </span>
                <span style={{ color: 'var(--text)' }}>{m.data}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* 右：发布 + 活跃频道 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>发布（PUBLISH）</div>
          <input
            className="redis-search__input"
            style={{ flex: '0 0 auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, background: 'var(--surface-2)' }}
            placeholder="目标频道"
            value={pubChannel}
            onChange={e => setPubChannel(e.target.value)}
          />
          <textarea
            style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', resize: 'vertical', minHeight: 60 }}
            placeholder="消息内容"
            value={pubMessage}
            onChange={e => setPubMessage(e.target.value)}
          />
          <button className="cdlg-btn" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }} onClick={publish}>
            <Send size={12} /> 发布
          </button>
          {pubResult && <div style={{ fontSize: 11, color: 'var(--success)' }}>{pubResult}</div>}

          {/* 活跃频道 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>活跃频道</span>
            <button className="ssh-panel__btn" onClick={loadActiveChannels} title="刷新频道列表">
              <RefreshCw size={11} />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', background: 'var(--surface-2)', borderRadius: 8, padding: '4px 8px' }}>
            {activeChans.length === 0
              ? <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-muted)' }}>无活跃频道</div>
              : activeChans.map(ch => (
                <div key={ch} style={{ fontSize: 11, padding: '2px 0', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{ch}</div>
              ))
            }
          </div>
        </div>
      </div>

      {error && <div className="redis-error" style={{ margin: '0 12px 8px' }}>{error}</div>}
    </div>
  )
}
