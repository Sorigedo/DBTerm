// MO9.5 字段脱敏导出
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, ShieldCheck, Loader2, Plus, Trash2 } from 'lucide-react'
import { listenMongoExportProgress, queueBackgroundExport } from '../../utils/exportTasks'

interface Props {
  connectionId: string
  db: string
  coll: string
  onClose: () => void
}

type MaskRuleKind = 'phone' | 'email' | 'mask' | 'hash' | 'null'
interface Rule { field: string; rule: MaskRuleKind }

const RULE_LABELS: Record<MaskRuleKind, string> = {
  phone: '手机号（保留前3后4）',
  email: '邮箱（保留首2字符+域名）',
  mask: '全遮蔽（***）',
  hash: '哈希（FNV-1a）',
  null: '置空（null）',
}

export default function MongoMaskExportPanel({ connectionId, db, coll, onClose }: Props) {
  const [format, setFormat] = useState<'json' | 'csv'>('json')
  const [filterJson, setFilterJson] = useState('')
  const [rules, setRules] = useState<Rule[]>([{ field: '', rule: 'mask' }])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const setRule = (i: number, patch: Partial<Rule>) =>
    setRules(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  const addRule = () => setRules(prev => [...prev, { field: '', rule: 'mask' }])
  const delRule = (i: number) => setRules(prev => prev.filter((_, idx) => idx !== i))

  const run = async () => {
    const effective = rules.filter(r => r.field.trim())
    if (effective.length === 0) { setError('请至少配置一条脱敏字段规则'); return }
    if (filterJson.trim()) {
      try { JSON.parse(filterJson) } catch { setError('filter JSON 格式错误'); return }
    }
    setRunning(true); setError(''); setResult(null)
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        filters: [{ name: format === 'json' ? 'JSON' : 'CSV', extensions: [format] }],
        defaultPath: `${coll}_masked.${format}`,
      })
      if (!path) { setRunning(false); return }
      const { invoke } = await import('@tauri-apps/api/core')
      queueBackgroundExport({
        connectionId,
        label: `${db}.${coll} · 脱敏导出`,
        filePath: path,
        prepare: listenMongoExportProgress,
        run: taskId => invoke<number>('mongo_export_collection_masked', {
          id: connectionId, db, coll,
          filterJson: filterJson.trim(), projectionJson: '', format,
          outputPath: path,
          maskingRules: effective.map(r => ({ field: r.field.trim(), rule: r.rule })),
          taskId,
        }),
        complete: count => ({ progressRows: count, message: `导出完成 · ${count.toLocaleString()} 个文档` }),
        successMessage: count => `MongoDB 脱敏导出完成：${count.toLocaleString()} 个文档`,
        errorPrefix: 'MongoDB 脱敏导出失败',
      })
      onClose()
    } catch (e) { setError(String(e)) } finally { setRunning(false) }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 580, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <ShieldCheck size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>字段脱敏导出</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            集合：<span style={{ color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{db}.{coll}</span>
            <span style={{ marginLeft: 10 }}>（导出上限 50000 行，导出前对指定字段套用脱敏规则）</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 56 }}>格式</span>
            {(['json', 'csv'] as const).map(f => (
              <button key={f} onClick={() => setFormat(f)}
                style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid var(--border)', background: format === f ? 'var(--accent)' : 'var(--surface-2)', color: format === f ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 56, paddingTop: 6 }}>filter</span>
            <input value={filterJson} onChange={e => setFilterJson(e.target.value)}
              placeholder='留空导出全部，如 {"status":"active"}'
              style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>脱敏规则（顶层字段）</span>
              <button onClick={addRule} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                <Plus size={12} /> 添加字段
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rules.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input value={r.field} onChange={e => setRule(i, { field: e.target.value })}
                    placeholder="字段名，如 phone"
                    style={{ flex: 1, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                  <select value={r.rule} onChange={e => setRule(i, { rule: e.target.value as MaskRuleKind })}
                    style={{ width: 220, padding: '5px 8px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}>
                    {(Object.keys(RULE_LABELS) as MaskRuleKind[]).map(k => (
                      <option key={k} value={k}>{RULE_LABELS[k]}</option>
                    ))}
                  </select>
                  <button onClick={() => delRule(i)} disabled={rules.length === 1}
                    style={{ color: rules.length === 1 ? 'var(--text-muted)' : 'var(--error)', background: 'transparent', border: 'none', cursor: rules.length === 1 ? 'not-allowed' : 'pointer', lineHeight: 0, opacity: rules.length === 1 ? 0.4 : 1 }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {error && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>}
          {result !== null && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--success)', background: 'rgba(22,163,74,0.08)', borderRadius: 6 }}>✓ 已脱敏导出 {result} 行</div>}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={run} disabled={running}
            style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {running ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} 选择文件并导出
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
