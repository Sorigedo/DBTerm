// L3 — 序列/自增管理
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Edit3, Check, XCircle, Hash, Plus, Trash2, Zap } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface SequenceInfo {
  tableName: string
  columnName: string
  currentValue: number
  seqName: string | null
}

interface MariaSeqInfo {
  sequenceName:   string
  sequenceSchema: string
  startValue:     number
  minimumValue:   number
  maximumValue:   number
  increment:      number
  cycleOption:    boolean
}

interface Props {
  connectionId: string
  connType: string
  schema: string
  onClose: () => void
}

interface CreateSeqForm {
  name:      string
  start:     string
  increment: string
  minVal:    string
  maxVal:    string
  cycle:     boolean
}

export default function SequencePanel({ connectionId, connType, schema, onClose }: Props) {
  const isMaria = connType === 'mariadb'
  const [activeTab, setActiveTab] = useState<'autoInc' | 'native'>(isMaria ? 'native' : 'autoInc')

  // AUTO_INCREMENT 状态
  const [seqs, setSeqs] = useState<SequenceInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ name: string; val: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // MariaDB 原生序列状态
  const [mariaSeqs, setMariaSeqs] = useState<MariaSeqInfo[]>([])
  const [mariaLoading, setMariaLoading] = useState(false)
  const [mariaError, setMariaError] = useState('')
  const [mariaMsg, setMariaMsg] = useState('')
  const [setvalTarget, setSetvalTarget] = useState<{ name: string; val: string } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<CreateSeqForm>({ name: '', start: '1', increment: '1', minVal: '1', maxVal: '9223372036854775807', cycle: false })
  const [createSaving, setCreateSaving] = useState(false)
  const [, setDropConfirm] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const list = await invoke<SequenceInfo[]>('db_list_sequences', { id: connectionId, schema })
      setSeqs(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadMariaSeqs = async () => {
    if (!isMaria) return
    setMariaLoading(true)
    setMariaError('')
    try {
      const list = await invoke<MariaSeqInfo[]>('mariadb_list_sequences', { id: connectionId, schema })
      setMariaSeqs(list)
    } catch (e) {
      setMariaError(String(e))
    } finally {
      setMariaLoading(false)
    }
  }

  const doNextval = async (seqName: string) => {
    if (!window.confirm(`NEXTVAL 会推进序列 "${seqName}" 的计数器（不可撤销），确认执行？`)) return
    setMariaMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      const res = await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT NEXTVAL(\`${schema}\`.\`${seqName}\`)`,
      })
      const val = res.rows[0]?.[0]
      setMariaMsg(`NEXTVAL(${seqName}) = ${val}`)
      loadMariaSeqs()
    } catch (e) {
      setMariaMsg(`错误: ${e}`)
    }
  }

  const doSetval = async () => {
    if (!setvalTarget) return
    const v = parseInt(setvalTarget.val, 10)
    if (isNaN(v)) { setMariaMsg('请输入有效整数'); return }
    if (!window.confirm(`确认将序列 "${setvalTarget.name}" 的值设置为 ${v}？`)) return
    setMariaMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', {
        id: connectionId,
        sql: `SELECT SETVAL(\`${schema}\`.\`${setvalTarget.name}\`, ${v})`,
      })
      setMariaMsg(`已将序列 ${setvalTarget.name} 设置为 ${v}`)
      setSetvalTarget(null)
      loadMariaSeqs()
    } catch (e) {
      setMariaMsg(`错误: ${e}`)
    }
  }

  const doCreate = async () => {
    const { name, start, increment, minVal, maxVal, cycle } = createForm
    if (!name.trim()) { setMariaMsg('序列名不能为空'); return }
    const sql = `CREATE OR REPLACE SEQUENCE \`${schema}\`.\`${name.trim()}\` START WITH ${start} INCREMENT BY ${increment} MINVALUE ${minVal} MAXVALUE ${maxVal}${cycle ? ' CYCLE' : ' NOCYCLE'}`
    if (!window.confirm(`确认创建序列？\n\n${sql}`)) return
    setCreateSaving(true)
    setMariaMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', { id: connectionId, sql })
      setMariaMsg(`序列 ${name} 创建成功`)
      setShowCreate(false)
      setCreateForm({ name: '', start: '1', increment: '1', minVal: '1', maxVal: '9223372036854775807', cycle: false })
      loadMariaSeqs()
    } catch (e) {
      setMariaMsg(`错误: ${e}`)
    } finally {
      setCreateSaving(false)
    }
  }

  const doDrop = async (seqName: string) => {
    const input = window.prompt(`高危操作！删除序列 "${seqName}" 不可恢复。\n请输入序列名称确认：`)
    if (input !== seqName) { setMariaMsg('序列名称不匹配，已取消'); setDropConfirm(null); return }
    setMariaMsg('')
    try {
      type R = { columns: string[]; rows: (string | null)[][] }
      await invoke<R>('execute_query', {
        id: connectionId,
        sql: `DROP SEQUENCE \`${schema}\`.\`${seqName}\``,
      })
      setMariaMsg(`序列 ${seqName} 已删除`)
      setDropConfirm(null)
      loadMariaSeqs()
    } catch (e) {
      setMariaMsg(`错误: ${e}`)
    }
  }

  useEffect(() => { load(); if (isMaria) loadMariaSeqs() }, [connectionId, schema])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPg = ['postgres', 'kingBase', 'openGauss'].includes(connType)

  const save = async () => {
    if (!editing) return
    const v = parseInt(editing.val, 10)
    if (isNaN(v) || v < 1) { setSaveMsg('值必须为正整数'); return }
    setSaving(true)
    setSaveMsg('')
    try {
      // For MySQL: pass table name; for PG: pass sequence name
      const target = isPg ? (seqs.find(s => s.tableName === editing.name || s.seqName === editing.name)?.seqName ?? editing.name) : editing.name
      await invoke('db_set_auto_increment', {
        id: connectionId, schema, table: target, value: v,
      })
      setSaveMsg(`已更新为 ${v}`)
      setEditing(null)
      load()
    } catch (e) {
      setSaveMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 700, display: 'flex', flexDirection: 'column', maxHeight: '85vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Hash size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>序列/自增管理</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{schema}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="dbt-header-btn" onClick={() => { load(); if (isMaria) loadMariaSeqs() }} disabled={loading || mariaLoading}>
              <RefreshCw size={12} className={(loading || mariaLoading) ? 'spin' : ''} />
            </button>
            <button className="dbt-header-btn" onClick={onClose}><X size={12} /></button>
          </div>
        </div>

        {/* Tab 切换（仅 MariaDB 显示两个 tab） */}
        {isMaria && (
          <div style={{ display: 'flex', gap: 4, padding: '8px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {([['native', 'MariaDB 原生序列'], ['autoInc', 'AUTO_INCREMENT']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: activeTab === key ? 600 : 400,
                  background: activeTab === key ? 'var(--accent)' : 'var(--surface-2)',
                  color: activeTab === key ? '#fff' : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}
              >{label}</button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* MariaDB 原生序列 Tab */}
          {isMaria && activeTab === 'native' && (
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {mariaMsg && (
                <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12,
                  background: mariaMsg.startsWith('错误') ? 'rgba(220,38,38,0.08)' : 'rgba(22,163,74,0.08)',
                  color: mariaMsg.startsWith('错误') ? '#dc2626' : '#16a34a',
                }}>
                  {mariaMsg}
                </div>
              )}
              {mariaError && (
                <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: 'rgba(220,38,38,0.08)', color: 'var(--error)' }}>{mariaError}</div>
              )}

              {/* 操作栏 */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setShowCreate(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'rgba(99,102,241,0.08)', color: 'var(--accent)', fontWeight: 600 }}
                >
                  <Plus size={12} /> 创建序列
                </button>
              </div>

              {/* CREATE 表单 */}
              {showCreate && (
                <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 2 }}>创建 MariaDB 序列</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {[
                      { label: '序列名 *', key: 'name' as const, placeholder: 'my_sequence' },
                      { label: '起始值', key: 'start' as const, placeholder: '1' },
                      { label: '步长', key: 'increment' as const, placeholder: '1' },
                      { label: '最小值', key: 'minVal' as const, placeholder: '1' },
                      { label: '最大值', key: 'maxVal' as const, placeholder: '9223372036854775807' },
                    ].map(f => (
                      <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.label}</span>
                        <input
                          value={createForm[f.key]}
                          onChange={e => setCreateForm(v => ({ ...v, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          style={{ padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
                        />
                      </label>
                    ))}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={createForm.cycle} onChange={e => setCreateForm(v => ({ ...v, cycle: e.target.checked }))} style={{ accentColor: 'var(--accent)' }} />
                      CYCLE（循环）
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => setShowCreate(false)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12 }}>取消</button>
                    <button onClick={doCreate} disabled={createSaving} style={{ padding: '5px 12px', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600 }}>
                      {createSaving ? '创建中…' : '创建'}
                    </button>
                  </div>
                </div>
              )}

              {/* SETVAL 内联编辑 */}
              {setvalTarget && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>设置 {setvalTarget.name} 的值为：</span>
                  <input
                    type="number"
                    value={setvalTarget.val}
                    onChange={e => setSetvalTarget(v => v ? { ...v, val: e.target.value } : null)}
                    style={{ width: 120, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--accent)', background: 'var(--surface)', fontSize: 12 }}
                    autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') doSetval(); if (e.key === 'Escape') setSetvalTarget(null) }}
                  />
                  <button onClick={doSetval} style={{ padding: '4px 10px', borderRadius: 5, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 12 }}>确认</button>
                  <button onClick={() => setSetvalTarget(null)} style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: 12 }}>取消</button>
                </div>
              )}

              {/* 序列列表 */}
              {mariaLoading ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
              ) : mariaSeqs.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>该库下无原生序列（MariaDB 10.3+ 支持 CREATE SEQUENCE）</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                      {['序列名', '起始', '步长', '最小值', '最大值', '循环', '操作'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mariaSeqs.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: 600 }}>{s.sequenceName}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.startValue}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{s.increment}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{s.minimumValue}</td>
                        <td style={{ padding: '7px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(s.maximumValue)}>{s.maximumValue}</td>
                        <td style={{ padding: '7px 10px', color: s.cycleOption ? '#16a34a' : 'var(--text-muted)' }}>{s.cycleOption ? '是' : '否'}</td>
                        <td style={{ padding: '7px 10px' }}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              onClick={() => doNextval(s.sequenceName)}
                              title="NEXTVAL（推进计数器）"
                              style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.06)', color: 'var(--accent)' }}
                            >
                              <Zap size={10} /> NEXTVAL
                            </button>
                            <button
                              onClick={() => setSetvalTarget({ name: s.sequenceName, val: String(s.startValue) })}
                              title="SETVAL（设置值）"
                              style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.06)', color: 'var(--accent)' }}
                            >
                              <Edit3 size={10} /> SETVAL
                            </button>
                            <button
                              onClick={() => { setDropConfirm(s.sequenceName); doDrop(s.sequenceName) }}
                              title="DROP SEQUENCE"
                              style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)', color: 'var(--error)' }}
                            >
                              <Trash2 size={10} /> DROP
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* AUTO_INCREMENT Tab（非 MariaDB 只显示这个，MariaDB 切 Tab 显示） */}
          {(!isMaria || activeTab === 'autoInc') && (
            <>
          {error && (
            <div style={{ margin: 12, padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, color: 'var(--error)', fontSize: 12 }}>{error}</div>
          )}
          {saveMsg && (
            <div style={{ margin: '8px 12px', padding: 8, background: saveMsg.startsWith('已') ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)', borderRadius: 6, fontSize: 11, color: saveMsg.startsWith('已') ? '#16a34a' : '#dc2626' }}>{saveMsg}</div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>{isPg ? '序列名' : '表名'}</th>
                {!isPg && <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>列名</th>}
                <th style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)' }}>当前值</th>
                <th style={{ padding: '8px 14px', textAlign: 'center', fontWeight: 600, color: 'var(--text-muted)' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {seqs.map((s, i) => {
                const name = isPg ? (s.seqName ?? s.tableName) : s.tableName
                const isEditing = editing?.name === name
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }} className="hover-row">
                    <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>{name}</td>
                    {!isPg && <td style={{ padding: '8px 14px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.columnName}</td>}
                    <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                      {isEditing ? (
                        <input
                          type="number"
                          value={editing.val}
                          onChange={e => setEditing({ name, val: e.target.value })}
                          style={{ width: 100, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, textAlign: 'right' }}
                          autoFocus
                          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(null) }}
                        />
                      ) : s.currentValue.toLocaleString()}
                    </td>
                    <td style={{ padding: '8px 14px', textAlign: 'center' }}>
                      {isEditing ? (
                        <span style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                          <button className="btn-primary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={save} disabled={saving}>
                            <Check size={11} />
                          </button>
                          <button className="btn-cancel" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEditing(null)}>
                            <XCircle size={11} />
                          </button>
                        </span>
                      ) : (
                        <button
                          className="dbt-header-btn"
                          title="修改自增值"
                          onClick={() => setEditing({ name, val: String(s.currentValue) })}
                        >
                          <Edit3 size={11} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {seqs.length === 0 && !loading && (
                <tr><td colSpan={isPg ? 3 : 4} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>该库无自增列或序列</td></tr>
              )}
            </tbody>
          </table>
            </>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
          {isMaria && activeTab === 'native'
            ? 'NEXTVAL 会推进计数器（不可撤销）；SETVAL 与 DROP 需二次确认'
            : isPg ? '修改序列值会影响下一个生成的 ID，请谨慎操作' : '修改 AUTO_INCREMENT 值会影响下一个插入行的 ID，已有数据不受影响'}
        </div>
      </div>
    </div>,
    document.body
  )
}
