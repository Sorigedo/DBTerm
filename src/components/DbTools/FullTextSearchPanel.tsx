// J4 — 数据全文检索：指定库按值搜索定位数据
import { useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { Search, X, Table2 } from 'lucide-react'

interface SearchHit {
  tableName: string
  columnName: string
  rowPreview: string[]
}

interface Props {
  connId: string
  schema: string
  connName: string
  onClose: () => void
}

export default function FullTextSearchPanel({ connId, schema, connName, onClose }: Props) {
  const [keyword, setKeyword] = useState('')
  const [limitPerTable, setLimitPerTable] = useState(20)
  const [loading, setLoading] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const doSearch = async () => {
    if (!keyword.trim()) return
    setLoading(true); setError(''); setSearched(false)
    try {
      const result = await invoke<SearchHit[]>('db_fulltext_search', {
        id: connId,
        schema,
        tables: [],
        search: keyword.trim(),
        limitPerTable,
      })
      setHits(result)
      setSearched(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const byTable = hits.reduce<Record<string, SearchHit[]>>((acc, h) => {
    ;(acc[h.tableName] ||= []).push(h)
    return acc
  }, {})

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, display: 'flex', flexDirection: 'column', maxHeight: '88vh', borderRadius: 14, overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Search size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>数据全文检索 — {connName} / {schema}</span>
          <button className="dbt-header-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={12} /></button>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
            placeholder="输入关键词，回车搜索…"
            autoFocus
            style={{
              flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, outline: 'none',
            }}
          />
          <label style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            每表最多
            <input type="number" min={1} max={100} value={limitPerTable}
              onChange={e => setLimitPerTable(Number(e.target.value))}
              style={{ width: 48, margin: '0 4px', padding: '4px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 11 }} />
            行
          </label>
          <button
            onClick={doSearch}
            disabled={loading || !keyword.trim()}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent)',
              color: '#fff', fontSize: 12, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
            }}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 8 }}>{error}</div>}

          {!searched && !loading && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              在 <strong>{schema}</strong> 的所有文本列中搜索，最多扫描前 20 张表，每表返回 {limitPerTable} 条匹配行。
              <br />仅扫描 varchar/text/char 等文本类型列，使用参数化 LIKE 查询，不存在 SQL 注入风险。
            </div>
          )}

          {searched && hits.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>未找到包含 "{keyword}" 的数据</div>
          )}

          {searched && hits.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                找到 {hits.length} 条匹配记录，分布在 {Object.keys(byTable).length} 张表中
              </div>
              {Object.entries(byTable).map(([tname, tHits]) => (
                <div key={tname} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ background: 'var(--surface-2)', padding: '8px 12px', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Table2 size={12} color="var(--accent)" />
                    {tname}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>({tHits.length} 条)</span>
                  </div>
                  <div style={{ overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface)' }}>
                          <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>匹配列</th>
                          <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border)' }}>行预览（前 5 列）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tHits.map((h, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <td style={{ padding: '6px 10px', color: 'var(--accent)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{h.columnName}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                              {h.rowPreview.map((v, vi) => (
                                <span key={vi} style={{ marginRight: 8 }}>
                                  {v.toLowerCase().includes(keyword.toLowerCase())
                                    ? <mark style={{ background: 'rgba(99,102,241,0.25)', color: 'inherit', borderRadius: 2, padding: '0 2px' }}>{v}</mark>
                                    : <span style={{ color: 'var(--text-muted)' }}>{v}</span>
                                  }
                                  {vi < h.rowPreview.length - 1 && <span style={{ color: 'var(--border)' }}> | </span>}
                                </span>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
