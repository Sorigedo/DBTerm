// MA4.2 — MariaDB 系统版本化表（时态表）时间旅行查询助手
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { X, Clock, Copy, AlertTriangle, Play } from 'lucide-react'

interface Props {
  connectionId: string
  defaultSchema?: string
  defaultTable?:  string
  onRunSql: (sql: string) => void
  onClose:  () => void
  embedded?: boolean   // 嵌入 DBA 面板作为 tab 时为 true：去掉模态外壳，只渲染内容
}

type TravelMode = 'AS_OF' | 'BETWEEN' | 'FROM_TO' | 'ALL'

const MODE_LABELS: Record<TravelMode, string> = {
  AS_OF:    'AS OF（某时刻快照）',
  BETWEEN:  'BETWEEN（时间段内）',
  FROM_TO:  'FROM ... TO（时间段内）',
  ALL:      'ALL（全部历史）',
}

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function dayAgoStr() {
  const d = new Date(Date.now() - 86400000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

const SEL = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--text)', cursor: 'pointer', width: '100%' } as const

export default function TimeravelPanel({ connectionId, defaultSchema, defaultTable, onRunSql, onClose, embedded }: Props) {
  const [schema, setSchema] = useState(defaultSchema ?? '')
  const [table, setTable]   = useState(defaultTable ?? '')
  const [mode, setMode]     = useState<TravelMode>('AS_OF')
  const [asOf, setAsOf]     = useState(nowStr())
  const [fromTs, setFromTs] = useState(dayAgoStr())
  const [toTs, setToTs]     = useState(nowStr())
  const [cols, setCols]     = useState('*')
  const [whereClause, setWhereClause] = useState('')
  const [copied, setCopied] = useState(false)

  // 动态加载 schema/table 下拉
  const [schemas, setSchemas] = useState<string[]>([])
  const [tables,  setTables]  = useState<string[]>([])
  useEffect(() => {
    invoke<string[]>('list_schemas', { id: connectionId }).then(list => {
      setSchemas(list)
      if (!schema && list.length > 0) setSchema(list[0])
    }).catch(() => {})
  }, [connectionId])
  useEffect(() => {
    if (!schema) { setTables([]); return }
    invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema }).then(list => {
      const names = list.filter(t => !t.isView).map(t => t.name)
      setTables(names)
      if (!table && names.length > 0) setTable(names[0])
    }).catch(() => {})
  }, [connectionId, schema])

  // DELETE HISTORY
  const [showDeleteHistory, setShowDeleteHistory] = useState(false)
  const [deleteBeforeTs, setDeleteBeforeTs]       = useState(dayAgoStr())
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteRunning, setDeleteRunning]         = useState(false)
  const [deleteMsg, setDeleteMsg]                 = useState('')

  useEffect(() => {
    if (embedded) return   // 嵌入时由 DBA 面板统一处理 Esc
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const tableRef = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``

  const buildSql = () => {
    if (!table.trim()) return '-- 请先填写表名'
    const wherePart = whereClause.trim() ? ` WHERE ${whereClause.trim()}` : ''
    switch (mode) {
      case 'AS_OF':
        return `SELECT ${cols}\nFROM ${tableRef} FOR SYSTEM_TIME AS OF TIMESTAMP '${asOf}'${wherePart};`
      case 'BETWEEN':
        return `SELECT ${cols}\nFROM ${tableRef} FOR SYSTEM_TIME BETWEEN TIMESTAMP '${fromTs}' AND TIMESTAMP '${toTs}'${wherePart};`
      case 'FROM_TO':
        return `SELECT ${cols}\nFROM ${tableRef} FOR SYSTEM_TIME FROM TIMESTAMP '${fromTs}' TO TIMESTAMP '${toTs}'${wherePart};`
      case 'ALL':
        return `SELECT ${cols}\nFROM ${tableRef} FOR SYSTEM_TIME ALL${wherePart};`
    }
  }

  const sql = buildSql()

  const copySql = () => {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const runSql = () => {
    if (!table.trim()) return
    onRunSql(sql)
    onClose()
  }

  const doDeleteHistory = async () => {
    if (deleteConfirmText !== table.trim()) {
      setDeleteMsg('表名不匹配，已取消')
      return
    }
    setDeleteRunning(true)
    setDeleteMsg('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      type R = { columns: string[]; rows: (string | null)[][] }
      const deleteSql = `DELETE HISTORY FROM ${tableRef} BEFORE SYSTEM_TIME TIMESTAMP '${deleteBeforeTs}'`
      await invoke<R>('execute_query', { id: connectionId, sql: deleteSql })
      setDeleteMsg(`✓ 历史数据清除成功（${deleteBeforeTs} 之前的历史记录已删除）`)
      setDeleteConfirmText('')
      setShowDeleteHistory(false)
    } catch (e) {
      setDeleteMsg(`错误: ${String(e)}`)
    } finally {
      setDeleteRunning(false)
    }
  }

  const inner = (
    <>
        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {deleteMsg && (
            <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12,
              background: deleteMsg.startsWith('✓') ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
              color: deleteMsg.startsWith('✓') ? '#16a34a' : '#dc2626',
            }}>
              {deleteMsg}
            </div>
          )}

          {/* 目标表 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>数据库（Schema）</span>
              <select value={schema} onChange={e => { setSchema(e.target.value); setTable('') }} style={SEL}>
                {schemas.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>表名（WITH SYSTEM VERSIONING）</span>
              <select value={table} onChange={e => setTable(e.target.value)} style={SEL}>
                {tables.length === 0 && <option value="">— 先选数据库 —</option>}
                {tables.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>

          {/* 查询列 / WHERE */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>查询列（SELECT）</span>
              <input
                value={cols}
                onChange={e => setCols(e.target.value)}
                placeholder="*"
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>附加条件（WHERE，可选）</span>
              <input
                value={whereClause}
                onChange={e => setWhereClause(e.target.value)}
                placeholder="id = 1"
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontFamily: 'var(--font-mono)' }}
              />
            </label>
          </div>

          {/* 模式选择 */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>时间范围模式</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(Object.keys(MODE_LABELS) as TravelMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: '5px 12px', borderRadius: 6, fontSize: 12,
                    background: mode === m ? 'var(--accent)' : 'var(--surface-2)',
                    color: mode === m ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
                    fontWeight: mode === m ? 600 : 400,
                  }}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          {/* 时间输入 */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(mode === 'AS_OF') && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>时刻（AS OF）</span>
                <input type="datetime-local" value={asOf.replace(' ', 'T')} onChange={e => setAsOf(e.target.value.replace('T', ' '))}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }} />
              </label>
            )}
            {(mode === 'BETWEEN' || mode === 'FROM_TO') && (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mode === 'BETWEEN' ? '开始（含）' : 'FROM（不含）'}</span>
                  <input type="datetime-local" value={fromTs.replace(' ', 'T')} onChange={e => setFromTs(e.target.value.replace('T', ' '))}
                    style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mode === 'BETWEEN' ? '结束（含）' : 'TO（不含）'}</span>
                  <input type="datetime-local" value={toTs.replace(' ', 'T')} onChange={e => setToTs(e.target.value.replace('T', ' '))}
                    style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }} />
                </label>
              </>
            )}
          </div>

          {/* SQL 预览 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>生成 SQL</span>
              <button onClick={copySql} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: copied ? '#16a34a' : 'var(--text-muted)', marginLeft: 'auto' }}>
                <Copy size={10} />{copied ? '已复制' : '复制'}
              </button>
              <button
                onClick={runSql}
                disabled={!table.trim()}
                style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', opacity: !table.trim() ? 0.5 : 1 }}
              >
                <Play size={10} /> 在 SQL 编辑器运行
              </button>
            </div>
            <pre style={{
              padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--surface-2)', fontSize: 12, fontFamily: 'var(--font-mono)',
              color: 'var(--text)', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {sql}
            </pre>
          </div>

          {/* DELETE HISTORY 区域 */}
          <div style={{ border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, overflow: 'hidden' }}>
            <button
              onClick={() => setShowDeleteHistory(v => !v)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                background: 'rgba(220,38,38,0.05)', border: 'none', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <AlertTriangle size={13} color="var(--error)" />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--error)' }}>清除历史数据（DELETE HISTORY）</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>高危 · 不可撤销</span>
            </button>

            {showDeleteHistory && (
              <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--error)', background: 'rgba(220,38,38,0.06)', borderRadius: 6, padding: '8px 10px' }}>
                  ⚠ 此操作将永久删除 <strong>{table || '[表名]'}</strong> 表中指定时刻之前的所有历史版本记录，无法恢复！请确认生产环境中有备份后再执行。
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>删除此时刻之前的历史记录（BEFORE SYSTEM_TIME）</span>
                  <input
                    type="datetime-local"
                    value={deleteBeforeTs.replace(' ', 'T')}
                    onChange={e => setDeleteBeforeTs(e.target.value.replace('T', ' '))}
                    style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(220,38,38,0.4)', background: 'var(--surface)', fontSize: 12, maxWidth: 300 }}
                  />
                </label>

                <div style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.03)', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                  {`DELETE HISTORY FROM ${tableRef} BEFORE SYSTEM_TIME TIMESTAMP '${deleteBeforeTs}'`}
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--error)', fontWeight: 600 }}>
                    请输入表名 "<code style={{ fontFamily: 'var(--font-mono)' }}>{table || '[表名]'}</code>" 以确认：
                  </span>
                  <input
                    value={deleteConfirmText}
                    onChange={e => setDeleteConfirmText(e.target.value)}
                    placeholder={table || '表名'}
                    style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(220,38,38,0.4)', background: 'var(--surface)', fontSize: 12, maxWidth: 300 }}
                  />
                </label>

                <button
                  onClick={doDeleteHistory}
                  disabled={deleteRunning || deleteConfirmText !== table.trim() || !table.trim()}
                  style={{
                    padding: '7px 16px', borderRadius: 6, background: 'var(--error)', color: '#fff', border: 'none',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start',
                    opacity: (deleteRunning || deleteConfirmText !== table.trim() || !table.trim()) ? 0.4 : 1,
                  }}
                >
                  {deleteRunning ? '执行中…' : '执行 DELETE HISTORY'}
                </button>
              </div>
            )}
          </div>
        </div>
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
        style={{ width: 700, maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* 标题栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <Clock size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>时间旅行查询</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>MariaDB 系统版本化表</span>
          <button className="dbt-header-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={12} /></button>
        </div>
        {inner}
      </div>
    </div>,
    document.body
  )
}
