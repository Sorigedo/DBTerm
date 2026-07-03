// MO9.4: MongoDB 操作审计日志面板（本地 localStorage 存储）
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, Shield, Trash2, Download, RefreshCw } from 'lucide-react'
import SearchableSelect from '../DbTools/SearchableSelect'

export interface MongoAuditEntry {
  ts: number           // Unix ms
  connId: string
  db: string
  coll?: string
  op: string           // insert | replace | deleteOne | deleteMany | updateMany | dropCollection | createCollection | createIndex | dropIndex | importCollection
  detail: string       // 人类可读摘要
  ok: boolean
  error?: string
}

const AUDIT_KEY_PREFIX = 'dbterm_mongo_audit_'
const MAX_ENTRIES = 1000

export function appendAuditEntry(entry: MongoAuditEntry) {
  try {
    const key = AUDIT_KEY_PREFIX + entry.connId
    const raw = localStorage.getItem(key)
    const arr: MongoAuditEntry[] = raw ? JSON.parse(raw) : []
    arr.unshift(entry)
    if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES
    localStorage.setItem(key, JSON.stringify(arr))
  } catch { /* ignore */ }
}

export function loadAuditEntries(connId: string): MongoAuditEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_KEY_PREFIX + connId)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function clearAuditEntries(connId: string) {
  localStorage.removeItem(AUDIT_KEY_PREFIX + connId)
}

const OP_LABELS: Record<string, string> = {
  insert: '插入文档',
  replace: '替换文档',
  deleteOne: '删除单条',
  deleteMany: '批量删除',
  updateMany: '批量更新',
  dropCollection: '删除集合',
  createCollection: '创建集合',
  createIndex: '创建索引',
  dropIndex: '删除索引',
  importCollection: '导入数据',
}

const OP_COLORS: Record<string, string> = {
  insert: '#16a34a',
  replace: '#ea580c',
  deleteOne: '#dc2626',
  deleteMany: '#dc2626',
  updateMany: '#ea580c',
  dropCollection: '#dc2626',
  createCollection: '#16a34a',
  createIndex: '#16a34a',
  dropIndex: '#dc2626',
  importCollection: '#16a34a',
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN')}`
}

interface Props {
  connectionId: string
  onClose: () => void
}

export default function MongoAuditPanel({ connectionId, onClose }: Props) {
  const [entries, setEntries] = useState<MongoAuditEntry[]>([])
  const [opFilter, setOpFilter] = useState<string>('all')
  const [showErrorsOnly, setShowErrorsOnly] = useState(false)

  const load = useCallback(() => {
    setEntries(loadAuditEntries(connectionId))
  }, [connectionId])

  useEffect(() => { load() }, [load])

  function handleClear() {
    if (!window.confirm('确定清空当前连接的所有审计日志？')) return
    clearAuditEntries(connectionId)
    setEntries([])
  }

  function handleExport() {
    const filtered = filteredEntries()
    const lines = filtered.map(e => [
      fmtTime(e.ts), e.op, e.db + (e.coll ? `.${e.coll}` : ''), e.ok ? '成功' : '失败', e.detail, e.error ?? ''
    ].join('\t'))
    const header = ['时间', '操作', '目标', '结果', '详情', '错误'].join('\t')
    const content = [header, ...lines].join('\n')
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `mongo_audit_${connectionId}.tsv`; a.click()
    URL.revokeObjectURL(url)
  }

  function filteredEntries(): MongoAuditEntry[] {
    return entries.filter(e => {
      if (opFilter !== 'all' && e.op !== opFilter) return false
      if (showErrorsOnly && e.ok) return false
      return true
    })
  }

  const filtered = filteredEntries()
  const ops = Array.from(new Set(entries.map(e => e.op)))

  const panel = (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
        {/* 头部 */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Shield size={16} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>操作审计日志</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>共 {entries.length} 条</span>
          <div style={{ flex: 1 }} />
          <button onClick={load}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <RefreshCw size={11} /> 刷新
          </button>
          <button onClick={handleExport} disabled={entries.length === 0}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <Download size={11} /> 导出
          </button>
          <button onClick={handleClear} disabled={entries.length === 0}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(220,38,38,0.3)', background: 'transparent', color: 'var(--error)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <Trash2 size={11} /> 清空
          </button>
          <button onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <X size={16} />
          </button>
        </div>

        {/* 过滤栏 */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 10, alignItems: 'center', background: 'var(--surface)' }}>
          <SearchableSelect value={opFilter} onChange={setOpFilter} mono={false} width={160}
            items={[{ value: 'all', label: '全部操作' }, ...ops.map(op => ({ value: op, label: OP_LABELS[op] ?? op }))]} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showErrorsOnly} onChange={e => setShowErrorsOnly(e.target.checked)} />
            仅显示失败
          </label>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已过滤 {filtered.length} 条</span>
        </div>

        {/* 日志列表 */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              {entries.length === 0 ? '暂无审计记录（写操作执行后自动记录）' : '当前过滤条件下无记录'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0 }}>
                  {['时间', '操作', '目标', '详情', '结果'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.02)' }}>
                    <td style={{ padding: '7px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtTime(e.ts)}</td>
                    <td style={{ padding: '7px 14px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: OP_COLORS[e.op] ?? 'var(--text)', fontWeight: 600 }}>
                        {OP_LABELS[e.op] ?? e.op}
                      </span>
                    </td>
                    <td style={{ padding: '7px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                      {e.db}{e.coll ? `.${e.coll}` : ''}
                    </td>
                    <td style={{ padding: '7px 14px', color: 'var(--text)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.detail}
                      {e.error && <span style={{ color: 'var(--error)', marginLeft: 6 }}>⚠ {e.error}</span>}
                    </td>
                    <td style={{ padding: '7px 14px' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 5, fontSize: 11,
                        background: e.ok ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)',
                        color: e.ok ? '#16a34a' : '#dc2626',
                        border: `1px solid ${e.ok ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
                      }}>
                        {e.ok ? '成功' : '失败'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)' }}>
          日志存储于本地，最多保留 {MAX_ENTRIES} 条记录。清空不影响 MongoDB 服务器端日志。
        </div>
      </div>
    </div>
  )

  return createPortal(panel, document.body)
}
