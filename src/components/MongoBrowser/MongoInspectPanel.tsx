// MO10.1+MO10.2: MongoDB 一键巡检报告面板
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { X, Activity, CheckCircle2, AlertCircle, XCircle, Download, Loader2, RefreshCw } from 'lucide-react'

interface InspectItem {
  category: string
  key: string
  label: string
  value: string
  status: 'ok' | 'warn' | 'error' | 'info'
  advice: string
}

interface SlowOpEntry {
  opType: string
  ns: string
  millisAvg: number
  count: number
  plan: string
}

interface UnusedIndex {
  ns: string
  indexName: string
  key: string
}

interface InspectReport {
  items: InspectItem[]
  slowOps: SlowOpEntry[]
  unusedIndexes: UnusedIndex[]
  score: number
  summary: string
}

interface Props {
  connectionId: string
  currentDb: string
  onClose: () => void
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'ok') return <CheckCircle2 size={14} color="var(--success)" />
  if (status === 'warn') return <AlertCircle size={14} color="var(--warning)" />
  if (status === 'error') return <XCircle size={14} color="var(--error)" />
  return <Activity size={14} color="var(--accent)" />
}

function StatusColor(status: string): string {
  if (status === 'ok') return '#16a34a'
  if (status === 'warn') return '#ea580c'
  if (status === 'error') return '#dc2626'
  return 'var(--accent)'
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 90 ? '#16a34a' : score >= 70 ? '#ea580c' : '#dc2626'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1 }}>{score}</div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>健康得分</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>/100</div>
      </div>
      <div style={{ width: 80, height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', marginLeft: 4 }}>
        <div style={{ height: '100%', width: `${score}%`, background: color, borderRadius: 4, transition: 'width 0.6s' }} />
      </div>
    </div>
  )
}

export default function MongoInspectPanel({ connectionId, currentDb, onClose }: Props) {
  const [report, setReport] = useState<InspectReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string>('all')

  async function runInspect() {
    setRunning(true)
    setError(null)
    try {
      const result = await invoke<InspectReport>('mongo_inspect', { id: connectionId, db: currentDb })
      setReport(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  function exportMarkdown() {
    if (!report) return
    const lines: string[] = [
      `# MongoDB 巡检报告`,
      ``,
      `**连接**: ${connectionId}  **数据库**: ${currentDb}`,
      `**时间**: ${new Date().toLocaleString('zh-CN')}`,
      `**健康得分**: ${report.score}/100`,
      ``,
      `## 概要`,
      ``,
      report.summary,
      ``,
      `## 巡检项目`,
      ``,
      `| 分类 | 指标 | 当前值 | 状态 | 建议 |`,
      `|---|---|---|---|---|`,
    ]
    for (const item of report.items) {
      const statusLabel = item.status === 'ok' ? '✅ 正常' : item.status === 'warn' ? '⚠️ 警告' : item.status === 'error' ? '❌ 错误' : 'ℹ️ 信息'
      lines.push(`| ${item.category} | ${item.label} | ${item.value} | ${statusLabel} | ${item.advice || '-'} |`)
    }
    if (report.unusedIndexes.length > 0) {
      lines.push(``, `## 未使用索引（${report.unusedIndexes.length} 个）`, ``, `| 集合 | 索引名 | 键 |`, `|---|---|---|`)
      for (const idx of report.unusedIndexes) {
        lines.push(`| ${idx.ns} | ${idx.indexName} | \`${idx.key}\` |`)
      }
    }
    if (report.slowOps.length > 0) {
      lines.push(``, `## 慢查询 Top ${report.slowOps.length}`, ``, `| 操作 | 命名空间 | 耗时(ms) | 计划 |`, `|---|---|---|---|`)
      for (const op of report.slowOps) {
        lines.push(`| ${op.opType} | ${op.ns} | ${op.millisAvg} | ${op.plan || '-'} |`)
      }
    }
    const content = lines.join('\n')
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `mongo_inspect_${connectionId}_${Date.now()}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  const categories = report ? ['all', ...Array.from(new Set(report.items.map(i => i.category)))] : ['all']
  const filteredItems = report ? (activeCategory === 'all' ? report.items : report.items.filter(i => i.category === activeCategory)) : []

  const panel = (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 780, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        {/* 头部 */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Activity size={16} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>一键巡检报告</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {currentDb}</span>
          <div style={{ flex: 1 }} />
          {report && (
            <button onClick={exportMarkdown}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Download size={11} /> 导出 MD
            </button>
          )}
          <button onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {!report && !running && !error && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 40 }}>
              <Activity size={40} color="var(--accent)" style={{ opacity: 0.6 }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 6 }}>实例健康巡检</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  检查连接数、缓存命中率、副本集状态、oplog 窗口、<br />
                  未使用索引、慢查询、配置安全风险等 10+ 维度
                </div>
              </div>
              <button onClick={runInspect}
                style={{ padding: '10px 28px', borderRadius: 9, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Activity size={16} /> 开始巡检
              </button>
            </div>
          )}

          {running && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 60 }}>
              <Loader2 size={32} color="var(--accent)" style={{ animation: 'spin 1s linear infinite' }} />
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>正在采集 MongoDB 实例数据…</div>
            </div>
          )}

          {error && (
            <div style={{ padding: 20 }}>
              <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', fontSize: 13, color: 'var(--error)', marginBottom: 16 }}>
                巡检失败：{error}
              </div>
              <button onClick={runInspect}
                style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshCw size={12} /> 重试
              </button>
            </div>
          )}

          {report && (
            <>
              {/* 得分 + 概要 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '16px 20px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', marginBottom: 20 }}>
                <ScoreBadge score={report.score} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-bright)', fontWeight: 600, marginBottom: 4 }}>{report.summary}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {report.items.filter(i => i.status === 'error').length} 个严重问题 ·&nbsp;
                    {report.items.filter(i => i.status === 'warn').length} 个警告 ·&nbsp;
                    {report.unusedIndexes.length} 个未使用索引 ·&nbsp;
                    {report.slowOps.length} 条慢查询
                  </div>
                </div>
                <button onClick={runInspect} disabled={running}
                  style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <RefreshCw size={11} /> 重新巡检
                </button>
              </div>

              {/* 分类过滤 */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                {categories.map(cat => (
                  <button key={cat} onClick={() => setActiveCategory(cat)}
                    style={{ padding: '4px 12px', borderRadius: 20, border: `1px solid ${activeCategory === cat ? 'var(--accent)' : 'var(--border-subtle)'}`, background: activeCategory === cat ? 'var(--accent)' : 'transparent', color: activeCategory === cat ? '#fff' : 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>
                    {cat === 'all' ? '全部' : cat}
                  </button>
                ))}
              </div>

              {/* 巡检项目表格 */}
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      {['', '分类', '指标', '当前值', '建议'].map((h, i) => (
                        <th key={i} style={{ textAlign: 'left', padding: '9px 14px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, i) => (
                      <tr key={i} style={{ borderBottom: i < filteredItems.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                        <td style={{ padding: '9px 14px', width: 24 }}><StatusIcon status={item.status} /></td>
                        <td style={{ padding: '9px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{item.category}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--text-bright)', fontWeight: 500 }}>{item.label}</td>
                        <td style={{ padding: '9px 14px', fontFamily: 'var(--font-mono)', color: StatusColor(item.status) }}>{item.value}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--text-muted)', maxWidth: 220 }}>
                          {item.advice && <span style={{ color: item.status === 'error' ? '#dc2626' : item.status === 'warn' ? '#ea580c' : 'var(--text-muted)' }}>{item.advice}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 未使用索引 */}
              {report.unusedIndexes.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 10 }}>
                    未使用索引（{report.unusedIndexes.length} 个）
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-2)' }}>
                          {['集合', '索引名', '键'].map(h => (
                            <th key={h} style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.unusedIndexes.map((idx, i) => (
                          <tr key={i} style={{ borderBottom: i < report.unusedIndexes.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                            <td style={{ padding: '8px 14px', color: 'var(--text-muted)' }}>{idx.ns}</td>
                            <td style={{ padding: '8px 14px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{idx.indexName}</td>
                            <td style={{ padding: '8px 14px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{idx.key}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 慢查询 */}
              {report.slowOps.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 10 }}>
                    慢查询 Top {report.slowOps.length}（来自 system.profile）
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface-2)' }}>
                          {['操作', '命名空间', '耗时(ms)', '执行计划'].map(h => (
                            <th key={h} style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.slowOps.map((op, i) => (
                          <tr key={i} style={{ borderBottom: i < report.slowOps.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                            <td style={{ padding: '8px 14px', color: 'var(--accent)' }}>{op.opType}</td>
                            <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{op.ns}</td>
                            <td style={{ padding: '8px 14px', color: op.millisAvg > 1000 ? '#dc2626' : op.millisAvg > 100 ? '#ea580c' : 'var(--text)' }}>{op.millisAvg}</td>
                            <td style={{ padding: '8px 14px', color: 'var(--text-muted)' }}>{op.plan || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(panel, document.body)
}
