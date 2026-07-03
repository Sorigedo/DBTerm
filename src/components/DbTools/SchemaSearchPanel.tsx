import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, Database, Table2, Columns3, Loader2 } from 'lucide-react'
import type { ConnConfig } from '../../types'

interface Props {
  connections: ConnConfig[]
  onClose: () => void
  onOpenTable?: (connId: string, schema: string, table: string) => void
}

interface SearchResult {
  connId: string
  connName: string
  schema: string
  table: string
  column?: string
  dataType?: string
  matchType: 'table' | 'column'
}

export default function SchemaSearchPanel({ connections, onClose, onOpenTable }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [selectedConns, setSelectedConns] = useState<Set<string>>(new Set(connections.map(c => c.id)))
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const dbConns = connections.filter(c =>
    ['mysql', 'postgres', 'sqlite', 'tidb', 'mariadb', 'oceanBase', 'kingBase', 'openGauss'].includes(c.type)
  )

  const doSearch = async (q: string) => {
    if (!q.trim() || q.length < 2) { setResults([]); setSearched(false); return }
    setSearching(true)
    setSearched(false)
    const found: SearchResult[] = []
    const { invoke } = await import('@tauri-apps/api/core')

    for (const conn of dbConns) {
      if (!selectedConns.has(conn.id)) continue
      try {
        const schemas = await invoke<string[]>('list_schemas', { id: conn.id })
        for (const schema of schemas) {
          const tables = await invoke<{ name: string; isView: boolean }[]>('list_tables', { id: conn.id, schema })
          for (const tbl of tables) {
            if (tbl.name.toLowerCase().includes(q.toLowerCase())) {
              found.push({ connId: conn.id, connName: conn.name, schema, table: tbl.name, matchType: 'table' })
            }
            // Also search columns
            try {
              const cols = await invoke<{ name: string; dataType: string }[]>('table_columns', {
                id: conn.id, schema, table: tbl.name,
              })
              for (const col of cols) {
                if (col.name.toLowerCase().includes(q.toLowerCase())) {
                  found.push({ connId: conn.id, connName: conn.name, schema, table: tbl.name, column: col.name, dataType: col.dataType, matchType: 'column' })
                }
              }
            } catch { /* no columns */ }
          }
        }
      } catch { /* connection unreachable */ }
    }

    setResults(found.slice(0, 200))
    setSearched(true)
    setSearching(false)
  }

  const handleInput = (q: string) => {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(q), 600)
  }

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    const key = `${r.connId}::${r.schema}`
    ;(acc[key] = acc[key] ?? []).push(r)
    return acc
  }, {})

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}
      >
        {/* Search header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)', padding: '6px 12px' }}>
            {searching ? <Loader2 size={14} className="spin" color="var(--accent)" /> : <Search size={14} color="var(--text-muted)" />}
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleInput(e.target.value)}
              placeholder="搜索表名 / 列名（至少 2 个字符）…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13, color: 'var(--text)' }}
            />
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0 }}><X size={14} /></button>
          </div>

          {/* Connection filter chips */}
          {dbConns.length > 1 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {dbConns.map(c => (
                <button
                  key={c.id}
                  onClick={() => setSelectedConns(prev => {
                    const n = new Set(prev)
                    if (n.has(c.id)) n.delete(c.id)
                    else n.add(c.id)
                    return n
                  })}
                  style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 12,
                    border: `1px solid ${selectedConns.has(c.id) ? 'var(--accent)' : 'var(--border)'}`,
                    background: selectedConns.has(c.id) ? 'rgba(var(--accent-rgb,59,130,246),0.1)' : 'var(--surface)',
                    color: selectedConns.has(c.id) ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {!searched && !searching && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              输入关键词搜索跨连接的表名或列名
            </div>
          )}
          {searched && results.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>未找到匹配结果</div>
          )}
          {Object.entries(grouped).map(([key, items]) => {
            const first = items[0]
            return (
              <div key={key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <Database size={11} color="var(--accent)" />
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>{first.connName}</span>
                  <span style={{ fontSize: 11, color: 'var(--border)' }}>·</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{first.schema}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{items.length} 条</span>
                </div>
                {items.map((r, i) => (
                  <div
                    key={i}
                    className="hover-row"
                    onClick={() => onOpenTable?.(r.connId, r.schema, r.table)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', cursor: onOpenTable ? 'pointer' : 'default' }}
                  >
                    {r.matchType === 'table'
                      ? <Table2 size={12} color="var(--accent)" />
                      : <Columns3 size={12} color="var(--text-muted)" />
                    }
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-bright)', fontWeight: 500 }}>{r.table}</span>
                    {r.column && (
                      <>
                        <span style={{ fontSize: 11, color: 'var(--border)' }}>›</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.column.toLowerCase().includes(query.toLowerCase()) ? 'var(--accent)' : 'var(--text)' }}>{r.column}</span>
                        {r.dataType && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({r.dataType})</span>}
                      </>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px', border: '1px solid var(--border-subtle)' }}>
                      {r.matchType === 'table' ? '表名' : '列名'}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
          {searched && results.length >= 200 && (
            <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              仅显示前 200 条，请缩小搜索范围
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
