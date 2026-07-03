import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, GitCompare, RefreshCw, Loader2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import SearchableSelect from './SearchableSelect'
import type { ConnType } from '../../types'

interface Props {
  connectionId: string
  connType: ConnType
  onClose: () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

// 统一后的差异行（PG: name+category；Redis: key 当 name，无 category）
interface DiffRow {
  name: string
  category?: string
  valueA: string | null
  valueB: string | null
}

const PG_TYPES: ConnType[] = ['postgres', 'kingBase', 'openGauss']

export default function ConfigComparePanel({ connectionId, connType, onClose, embedded }: Props) {
  const connections = useAppStore(s => s.connections)
  const isPg = PG_TYPES.includes(connType)

  // 候选对比连接：PG 系互通，其余仅同类型；排除自身
  const candidates = useMemo(
    () => connections.filter(c =>
      c.id !== connectionId &&
      (isPg ? PG_TYPES.includes(c.type) : c.type === connType)),
    [connections, connectionId, connType, isPg],
  )
  const selfName = connections.find(c => c.id === connectionId)?.name ?? connectionId

  const [otherId, setOtherId] = useState('')
  const [diffs, setDiffs] = useState<DiffRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ran, setRan] = useState(false)

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const run = async () => {
    if (!otherId) { setError('请选择对比目标连接'); return }
    setLoading(true); setError(''); setRan(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      let rows: DiffRow[]
      if (isPg) {
        const res = await invoke<{ name: string; category: string; valueA: string | null; valueB: string | null }[]>(
          'pg_settings_diff', { idA: connectionId, idB: otherId })
        rows = res.map(r => ({ name: r.name, category: r.category, valueA: r.valueA, valueB: r.valueB }))
      } else {
        // Redis：CONFIG 为实例级，db 无关，传 null
        const res = await invoke<{ key: string; valueA: string | null; valueB: string | null }[]>(
          'redis_config_compare', { idA: connectionId, dbA: null, idB: otherId, dbB: null })
        rows = res.map(r => ({ name: r.key, valueA: r.valueA, valueB: r.valueB }))
      }
      setDiffs(rows); setRan(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const otherName = candidates.find(c => c.id === otherId)?.name ?? '实例 B'

  const inner = (
    <>
        {/* 选择对比目标 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: embedded ? '8px 12px' : '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>实例 A</span>
          <span style={{ fontSize: 12, color: 'var(--text-bright)', fontWeight: 600 }}>{selfName}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 4px' }}>对比</span>
          <SearchableSelect
            value={otherId}
            onChange={setOtherId}
            items={candidates.map(c => ({ value: c.id, label: c.name }))}
            placeholder="选择实例 B…"
            mono={false}
            width={260}
          />
          <button
            onClick={run}
            disabled={loading || !otherId}
            style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: loading || !otherId ? 'not-allowed' : 'pointer', opacity: loading || !otherId ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            对比
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: candidates.length === 0 ? 16 : 0 }}>
          {candidates.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              没有可对比的同类型连接（需要至少两个{isPg ? ' PostgreSQL 系 ' : ' 同类型 '}连接）
            </div>
          ) : error ? (
            <div style={{ margin: 16, padding: '8px 12px', fontSize: 12, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 6 }}>{error}</div>
          ) : loading ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>对比中…</div>
          ) : ran && diffs.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--success)', fontSize: 12 }}>两实例配置完全一致 ✓</div>
          ) : ran ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>配置项</th>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-bright)', width: '32%' }}>{selfName}</th>
                  <th style={{ padding: '7px 12px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-bright)', width: '32%' }}>{otherName}</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d, i) => (
                  <tr key={d.name + i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text)', verticalAlign: 'top' }}>
                      {d.name}
                      {d.category && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d.category}</div>}
                    </td>
                    <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', verticalAlign: 'top', color: d.valueA == null ? 'var(--text-muted)' : '#dc2626', background: d.valueA == null ? 'transparent' : 'rgba(220,38,38,0.06)' }}>
                      {d.valueA ?? <span style={{ fontStyle: 'italic' }}>（缺失）</span>}
                    </td>
                    <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', verticalAlign: 'top', color: d.valueB == null ? 'var(--text-muted)' : '#16a34a', background: d.valueB == null ? 'transparent' : 'rgba(22,163,74,0.06)' }}>
                      {d.valueB ?? <span style={{ fontStyle: 'italic' }}>（缺失）</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>选择实例 B 后点击「对比」查看差异</div>
          )}
        </div>

        {ran && diffs.length > 0 && (
          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
            共 {diffs.length} 项差异（红=实例 A 值 / 绿=实例 B 值；「缺失」表示该实例无此项）
          </div>
        )}
    </>
  )

  // 嵌入 DBA 面板：只渲染内容，无模态外壳
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {inner}
      </div>
    )
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 820, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitCompare size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>
            配置对比{isPg ? '（pg_settings）' : '（CONFIG）'}
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
          </div>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
