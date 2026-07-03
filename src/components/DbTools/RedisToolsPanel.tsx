// N1-N4 — Redis 增强工具面板
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Zap, Trash2, Clock, BarChart2, AlertTriangle, Search, RefreshCw, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface Props {
  connectionId: string
  onClose: () => void
}

type Tab = 'bigkey' | 'slowlog' | 'batch-del' | 'ttl'

interface BigKeyInfo { key: string; kind: string; memoryBytes: number }
interface SlowlogEntry { id: number; timestamp: number; durationUs: number; command: string }
interface RedisKeyInfo { key: string; kind: string; ttl: number }

export default function RedisToolsPanel({ connectionId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('bigkey')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [bigkeys, setBigkeys] = useState<BigKeyInfo[]>([])
  const [slowlog, setSlowlog] = useState<SlowlogEntry[]>([])
  const [delPattern, setDelPattern] = useState('')
  const [scanResults, setScanResults] = useState<string[]>([])
  const [delConfirm, setDelConfirm] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [ttlPattern, setTtlPattern] = useState('')
  const [ttlResults, setTtlResults] = useState<RedisKeyInfo[]>([])
  const [ttlValue, setTtlValue] = useState('')
  const [ttlScanning, setTtlScanning] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const scanBigkeys = async () => {
    setLoading(true); setError(''); setBigkeys([])
    try {
      setBigkeys(await invoke<BigKeyInfo[]>('redis_bigkey_scan', { id: connectionId }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const loadSlowlog = async () => {
    setLoading(true); setError('')
    try {
      setSlowlog(await invoke<SlowlogEntry[]>('redis_slowlog_get', { id: connectionId, count: 50 }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const scanForDelete = async () => {
    if (!delPattern.trim()) return
    setScanning(true); setError(''); setScanResults([]); setDelConfirm(false)
    try {
      setScanResults(await invoke<string[]>('redis_scan_pattern', { id: connectionId, pattern: delPattern, limit: 500 }))
    } catch (e) { setError(String(e)) } finally { setScanning(false) }
  }

  const batchDelete = async () => {
    setLoading(true); setMsg('')
    try {
      const deleted = await invoke<number>('redis_batch_del', { id: connectionId, pattern: delPattern })
      setMsg(`已删除 ${deleted} 个 key`); setScanResults([]); setDelConfirm(false)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const scanForTtl = async () => {
    if (!ttlPattern.trim()) return
    setTtlScanning(true); setError('')
    try {
      setTtlResults(await invoke<RedisKeyInfo[]>('redis_scan_with_ttl', { id: connectionId, pattern: ttlPattern }))
    } catch (e) { setError(String(e)) } finally { setTtlScanning(false) }
  }

  const batchSetTtl = async () => {
    const ttl = parseInt(ttlValue, 10)
    if (isNaN(ttl)) { setMsg('TTL 必须是整数（秒），-1 表示永不过期'); return }
    setLoading(true); setMsg('')
    try {
      const updated = await invoke<number>('redis_batch_expire', { id: connectionId, pattern: ttlPattern, ttlSecs: ttl })
      setMsg(`已为 ${updated} 个 key 设置 TTL=${ttl < 0 ? '永不过期' : ttl + 's'}`)
      scanForTtl()
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }

  const fmtBytes = (b: number) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(2)}MB`

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'bigkey', label: 'Big Key 分析', icon: <BarChart2 size={12} /> },
    { key: 'slowlog', label: '慢日志', icon: <Clock size={12} /> },
    { key: 'batch-del', label: '批量删除', icon: <Trash2 size={12} /> },
    { key: 'ttl', label: 'TTL 管理', icon: <Zap size={12} /> },
  ]

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, display: 'flex', flexDirection: 'column', maxHeight: '88vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Zap size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>Redis 工具</span>
          <button className="dbt-header-btn" onClick={onClose} style={{ marginLeft: 'auto' }}><X size={12} /></button>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 16px' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => { setTab(t.key); setError(''); setMsg('') }} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: 12,
              background: 'transparent', border: 'none', cursor: 'pointer',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
            }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && <div style={{ padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
          {msg && <div style={{ padding: 8, background: 'rgba(22,163,74,0.1)', borderRadius: 6, fontSize: 11, marginBottom: 10, color: 'var(--success)' }}>{msg}</div>}

          {tab === 'bigkey' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                <button className="btn-primary" onClick={scanBigkeys} disabled={loading}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {loading ? <Loader2 size={12} className="spin" /> : <Search size={12} />}扫描 Big Key（前 200）
                </button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>非阻塞 SCAN + MEMORY USAGE，不影响生产</span>
              </div>
              {bigkeys.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: 'var(--surface-2)' }}>
                    {['Key', '类型', '内存占用'].map(h => (
                      <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{bigkeys.map((k, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.key}</td>
                      <td style={{ padding: '6px 12px', color: 'var(--accent)' }}>{k.kind}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: k.memoryBytes > 1048576 ? '#dc2626' : k.memoryBytes > 102400 ? '#ea580c' : 'var(--text)' }}>{fmtBytes(k.memoryBytes)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'slowlog' && (
            <div>
              <div style={{ marginBottom: 12 }}>
                <button className="btn-primary" onClick={loadSlowlog} disabled={loading}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}加载慢日志（最近 50 条）
                </button>
              </div>
              {slowlog.length === 0 && !loading && (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无慢日志，或慢日志功能未开启（slowlog-log-slower-than）</div>
              )}
              {slowlog.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: 'var(--surface-2)' }}>
                    {['ID', '耗时(μs)', '命令'].map(h => (
                      <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{slowlog.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>{e.id}</td>
                      <td style={{ padding: '6px 12px', color: e.durationUs > 100000 ? '#dc2626' : e.durationUs > 10000 ? '#ea580c' : 'var(--text)' }}>{e.durationUs.toLocaleString()}</td>
                      <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.command}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'batch-del' && (
            <div>
              <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8, fontSize: 11, marginBottom: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={11} color="var(--error)" />先预扫描确认范围，再执行删除。删除后不可恢复。
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input value={delPattern} onChange={e => setDelPattern(e.target.value)}
                  placeholder="键名模式，如: user:* session:temp:*"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                  onKeyDown={e => { if (e.key === 'Enter') scanForDelete() }} />
                <button className="btn-primary" onClick={scanForDelete} disabled={scanning}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {scanning ? <Loader2 size={12} className="spin" /> : <Search size={12} />}预扫描
                </button>
              </div>
              {scanResults.length > 0 && (
                <>
                  <div style={{ padding: '8px 12px', background: 'rgba(234,88,12,0.08)', border: '1px solid rgba(234,88,12,0.3)', borderRadius: 8, fontSize: 12, marginBottom: 10 }}>
                    找到 <b>{scanResults.length}</b> 个匹配的 key{scanResults.length >= 500 ? '（最多显示 500，实际可能更多）' : ''}
                  </div>
                  <div style={{ maxHeight: 180, overflow: 'auto', background: 'var(--surface-2)', borderRadius: 8, padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 12, whiteSpace: 'pre' }}>
                    {scanResults.slice(0, 50).join('\n')}{scanResults.length > 50 ? `\n...（仅显示前 50 个）` : ''}
                  </div>
                  {!delConfirm ? (
                    <button className="btn-danger" onClick={() => setDelConfirm(true)} style={{ fontSize: 12 }}>
                      删除这 {scanResults.length} 个 key
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--error)', fontWeight: 600 }}>确认批量删除？此操作不可恢复</span>
                      <button className="btn-danger" onClick={batchDelete} disabled={loading} style={{ fontSize: 12 }}>
                        {loading ? '删除中...' : '确认删除'}
                      </button>
                      <button className="btn-cancel" onClick={() => setDelConfirm(false)} style={{ fontSize: 12 }}>取消</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'ttl' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input value={ttlPattern} onChange={e => setTtlPattern(e.target.value)}
                  placeholder="键名模式，如: cache:* session:*"
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                  onKeyDown={e => { if (e.key === 'Enter') scanForTtl() }} />
                <button className="btn-primary" onClick={scanForTtl} disabled={ttlScanning}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {ttlScanning ? <Loader2 size={12} className="spin" /> : <Search size={12} />}查找 Key
                </button>
              </div>
              {ttlResults.length > 0 && (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>批量设置 TTL（秒，-1=永不过期）：</span>
                    <input type="number" value={ttlValue} onChange={e => setTtlValue(e.target.value)} placeholder="3600"
                      style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12 }} />
                    <button className="btn-primary" onClick={batchSetTtl} disabled={loading || !ttlValue} style={{ fontSize: 12 }}>批量设置</button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({ttlResults.length} 个 key)</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead><tr style={{ background: 'var(--surface-2)' }}>
                      {['Key', '类型', '当前 TTL'].map(h => (
                        <th key={h} style={{ padding: '6px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{ttlResults.map((k, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.key}</td>
                        <td style={{ padding: '6px 12px', color: 'var(--accent)' }}>{k.kind}</td>
                        <td style={{ padding: '6px 12px', color: k.ttl === -1 ? '#16a34a' : k.ttl >= 0 && k.ttl < 60 ? '#dc2626' : 'var(--text)' }}>
                          {k.ttl === -1 ? '永不过期' : k.ttl < 0 ? '无 TTL' : `${k.ttl}s`}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
