// J2 — 批量巡检：多连接跑 H4 健康巡检，汇总对比表
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Activity, Play, CheckCircle, AlertTriangle, XCircle, Loader2, Download } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import type { ConnConfig } from '../../types'
import { toast } from '../../stores/toastStore'
import { queueLocalTextExport } from '../../utils/exportTasks'

// Tauri WebView2 不支持浏览器 blob 下载，统一走保存对话框 + 后端写文件
async function saveTextFile(content: string, defaultName: string, label: string, ext: string) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] })
    if (!path) return
    queueLocalTextExport(path, content, label)
  } catch (e) {
    toast.error(`导出失败：${String(e)}`)
  }
}

interface HealthItem {
  category: string
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

interface ConnHealth {
  connId: string
  connName: string
  status: 'pending' | 'running' | 'done' | 'error'
  score: number
  items: HealthItem[]
  error: string
  schema: string
}

interface Props {
  connections: ConnConfig[]
  onClose: () => void
}

export default function BatchHealthPanel({ connections, onClose }: Props) {
  const [results, setResults] = useState<ConnHealth[]>([])
  const [running, setRunning] = useState(false)
  const [schemas, setSchemas] = useState<Record<string, string>>({})

  const dbConns = connections.filter(c =>
    ['mysql', 'postgres', 'tidb', 'mariadb', 'oceanBase', 'kingBase', 'openGauss'].includes(c.type)
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = async () => {
    const initial: ConnHealth[] = dbConns.map(c => ({
      connId: c.id, connName: c.name,
      status: 'pending', score: 0, items: [], error: '',
      schema: schemas[c.id] ?? '',
    }))
    setResults(initial)
    setRunning(true)

    for (const c of dbConns) {
      setResults(prev => prev.map(r => r.connId === c.id ? { ...r, status: 'running' } : r))
      try {
        const items = await invoke<HealthItem[]>('db_health_check', { id: c.id, schema: schemas[c.id] ?? '' })
        const okCount = items.filter(i => i.status === 'ok').length
        const score = items.length ? Math.round((okCount / items.length) * 100) : 100
        setResults(prev => prev.map(r => r.connId === c.id ? { ...r, status: 'done', score, items } : r))
      } catch (e) {
        setResults(prev => prev.map(r => r.connId === c.id ? { ...r, status: 'error', error: String(e) } : r))
      }
    }
    setRunning(false)
  }

  const exportMarkdown = async () => {
    const lines: string[] = ['# 批量巡检报告\n']
    for (const r of results) {
      if (r.status !== 'done') continue
      lines.push(`## ${r.connName} (得分: ${r.score})`)
      for (const item of r.items) {
        const icon = item.status === 'ok' ? '✅' : item.status === 'warn' ? '⚠️' : '❌'
        lines.push(`- ${icon} **${item.name}**: ${item.detail}`)
      }
      lines.push('')
    }
    await saveTextFile(lines.join('\n'), 'batch_health.md', 'Markdown 文件', 'md')
  }

  const scoreColor = (s: number) => s >= 80 ? '#16a34a' : s >= 60 ? '#ea580c' : '#dc2626'

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, display: 'flex', flexDirection: 'column', maxHeight: '90vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Activity size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>批量巡检</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{dbConns.length} 个连接</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {results.some(r => r.status === 'done') && (
              <button className="dbt-header-btn" onClick={exportMarkdown} title="导出 Markdown"><Download size={12} /></button>
            )}
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        {/* Schema inputs */}
        {dbConns.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {dbConns.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.name}:</span>
                <input
                  value={schemas[c.id] ?? ''}
                  onChange={e => setSchemas(p => ({ ...p, [c.id]: e.target.value }))}
                  placeholder="库名（可选）"
                  style={{ width: 100, padding: '3px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11 }}
                />
              </div>
            ))}
            <button className="btn-primary" onClick={run} disabled={running} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 12px' }}>
              {running ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
              开始巡检
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {results.length === 0 && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)', fontSize: 12 }}>
              <Activity size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div>点击"开始巡检"对所有连接执行健康检查</div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 10 }}>
            {results.map(r => (
              <div key={r.connId} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--surface-2)' }}>
                  {r.status === 'running' && <Loader2 size={13} className="spin" color="var(--accent)" />}
                  {r.status === 'done' && <Activity size={13} color={scoreColor(r.score)} />}
                  {r.status === 'error' && <XCircle size={13} color="var(--error)" />}
                  {r.status === 'pending' && <span style={{ width: 13, height: 13, borderRadius: '50%', background: 'var(--border)', display: 'inline-block' }} />}
                  <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{r.connName}</span>
                  {r.status === 'done' && (
                    <span style={{ fontSize: 18, fontWeight: 700, color: scoreColor(r.score) }}>{r.score}</span>
                  )}
                  {r.status === 'error' && <span style={{ fontSize: 11, color: 'var(--error)' }}>巡检失败</span>}
                </div>
                {r.status === 'done' && (
                  <div style={{ padding: '6px 0' }}>
                    {r.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 14px' }}>
                        {item.status === 'ok' ? <CheckCircle size={11} color="var(--success)" style={{ flexShrink: 0, marginTop: 1 }} />
                          : item.status === 'warn' ? <AlertTriangle size={11} color="var(--warning)" style={{ flexShrink: 0, marginTop: 1 }} />
                          : <XCircle size={11} color="var(--error)" style={{ flexShrink: 0, marginTop: 1 }} />}
                        <div>
                          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>{item.name}</span>
                          {item.detail && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{item.detail}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {r.status === 'error' && (
                  <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--error)' }}>{r.error.slice(0, 100)}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
