// M2 — 数据字典导出：整库结构文档 Markdown/HTML
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, BookOpen, Download, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
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

interface DictColumn {
  name: string
  dataType: string
  nullable: boolean
  keyType: string
  defaultVal: string
  extra: string
  comment: string
}

interface DictIndex {
  name: string
  columns: string
  unique: boolean
  indexType: string
}

interface DictTable {
  name: string
  comment: string
  columns: DictColumn[]
  indexes: DictIndex[]
}

interface Props {
  connectionId: string
  schema: string
  // 可选：仅生成这些表的字典（单表/多选）；不传 → 整库
  tables?: string[]
  // 可选：连接显示名（用于文档标题页）
  connName?: string
  onClose: () => void
}

export default function DataDictPanel({ connectionId, schema, tables: tableFilter, connName, onClose }: Props) {
  const scoped = !!(tableFilter && tableFilter.length)        // 指定了表（单/多选）→ 直接全量加载这几张
  const [names, setNames] = useState<string[]>([])            // 全库表名（懒加载模式：先只列名，展开/导出才查列）
  const [dict, setDict] = useState<Record<string, DictTable>>({})  // 已加载的表字典缓存
  const [loadingList, setLoadingList] = useState(false)
  const [loadingTbl, setLoadingTbl] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const loading = loadingList || exporting

  // 开面板：指定表→直接查这几张（量小）；整库→只取表名列表，秒出
  useEffect(() => {
    const load = async () => {
      setLoadingList(true); setError('')
      try {
        if (scoped) {
          const result = await invoke<DictTable[]>('db_data_dictionary', { id: connectionId, schema, tables: tableFilter })
          const m: Record<string, DictTable> = {}; result.forEach(t => { m[t.name] = t })
          setDict(m); setNames(result.map(t => t.name))
          if (result.length <= 8) setExpanded(new Set(result.map(t => t.name)))
        } else {
          const list = await invoke<{ name: string; isView: boolean }[]>('list_tables', { id: connectionId, schema })
          setNames(list.filter(t => !t.isView).map(t => t.name))
        }
      } catch (e) {
        setError(String(e))
      } finally {
        setLoadingList(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, scoped, (tableFilter ?? []).join(',')])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 懒加载单表字典（展开时触发）
  const loadTable = async (name: string) => {
    if (dict[name] || loadingTbl.has(name)) return
    setLoadingTbl(prev => new Set(prev).add(name))
    try {
      const result = await invoke<DictTable[]>('db_data_dictionary', { id: connectionId, schema, tables: [name] })
      if (result[0]) setDict(prev => ({ ...prev, [name]: result[0] }))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingTbl(prev => { const n = new Set(prev); n.delete(name); return n })
    }
  }

  // 导出前确保目标表字典已加载（缺的批量补齐一次）
  const ensureLoaded = async (wanted: string[]): Promise<DictTable[]> => {
    const missing = wanted.filter(n => !dict[n])
    let merged = dict
    if (missing.length) {
      const result = await invoke<DictTable[]>('db_data_dictionary', { id: connectionId, schema, tables: missing })
      merged = { ...dict }; result.forEach(t => { merged[t.name] = t })
      setDict(merged)
    }
    return wanted.map(n => merged[n]).filter(Boolean)
  }

  const filteredNames = names.filter(n => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return n.toLowerCase().includes(q) || (dict[n]?.comment ?? '').toLowerCase().includes(q)
  })

  const exportMarkdown = async () => {
    setExporting(true)
    try {
    const filtered = await ensureLoaded(filteredNames)
    const lines: string[] = [`# 数据字典 — ${schema}\n`]
    for (const t of filtered) {
      lines.push(`## ${t.name}${t.comment ? ` — ${t.comment}` : ''}\n`)
      lines.push('| 列名 | 类型 | 可空 | 键 | 默认值 | 备注 |')
      lines.push('|------|------|------|-----|--------|------|')
      for (const col of t.columns) {
        lines.push(`| ${col.name} | ${col.dataType} | ${col.nullable ? '是' : '否'} | ${col.keyType} | ${col.defaultVal || ''} | ${col.comment} |`)
      }
      if (t.indexes.length > 0) {
        lines.push('\n**索引**\n')
        lines.push('| 索引名 | 列 | 唯一 | 类型 |')
        lines.push('|--------|-----|------|------|')
        for (const idx of t.indexes) {
          lines.push(`| ${idx.name} | ${idx.columns} | ${idx.unique ? '是' : '否'} | ${idx.indexType} |`)
        }
      }
      lines.push('')
    }
    const fname = tableFilter && tableFilter.length === 1
      ? `数据字典_${schema}_${tableFilter[0]}.md` : `数据字典_${schema}.md`
    await saveTextFile(lines.join('\n'), fname, 'Markdown', 'md')
    } catch (e) { toast.error(`导出失败：${String(e)}`) } finally { setExporting(false) }
  }

  const exportHtml = async () => {
    setExporting(true)
    try {
    const filtered = await ensureLoaded(filteredNames)
    const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const keyLabel = (k: string) => k === 'PRI' ? '主键' : k === 'UNI' ? '唯一' : k === 'MUL' ? '索引' : ''

    const style = `
      *{box-sizing:border-box}
      body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;margin:0;padding:0;font-size:13px;line-height:1.6}
      .page{max-width:1000px;margin:0 auto;padding:32px 40px}
      .cover{min-height:60vh;display:flex;flex-direction:column;justify-content:center;border-bottom:3px solid #2563eb;margin-bottom:28px}
      .cover h1{font-size:30px;color:#1e3a8a;margin:0 0 6px}
      .cover .sub{font-size:15px;color:#475569;margin:2px 0}
      .meta{margin-top:20px;font-size:13px;color:#64748b}
      .meta b{color:#334155}
      .toc{margin-bottom:28px}
      .toc h2{font-size:16px;color:#1e40af;border-bottom:1px solid #e2e8f0;padding-bottom:6px}
      .toc ol{padding-left:22px}.toc a{color:#2563eb;text-decoration:none}
      h2.tbl{font-size:17px;color:#1d4ed8;margin:26px 0 4px;border-bottom:2px solid #e2e8f0;padding-bottom:6px}
      .tcomment{color:#64748b;font-size:13px;margin:0 0 8px}
      table{width:100%;border-collapse:collapse;margin:8px 0 4px}
      th{background:#eff6ff;color:#1e40af;padding:7px 10px;text-align:left;font-size:12px;border:1px solid #dbeafe;white-space:nowrap}
      td{padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;vertical-align:top}
      td.mono{font-family:ui-monospace,Consolas,monospace}
      .pk{color:#dc2626;font-weight:700}.uni{color:#7c3aed}.mul{color:#2563eb}
      .no{color:#94a3b8;text-align:right;width:42px}
      .idx{margin:6px 0 0;font-size:12px;color:#475569}
      .idx b{color:#334155}
      @media print{.page{max-width:none;padding:0 12mm}h2.tbl{page-break-after:avoid}table{page-break-inside:auto}tr{page-break-inside:avoid}.cover{page-break-after:always}.toc{page-break-after:always}}
    `
    const scopeLabel = tableFilter && tableFilter.length
      ? `${tableFilter.length} 张表` : '全部表'

    let body = `<div class="page">`
    // 封面
    body += `<div class="cover">
      <h1>数据字典</h1>
      <div class="sub">数据库：${esc(schema)}</div>
      ${connName ? `<div class="sub">连接：${esc(connName)}</div>` : ''}
      <div class="meta">
        <div>范围：<b>${scopeLabel}</b>（共 ${filtered.length} 张表）</div>
        <div>生成时间：<b>${dateStr}</b></div>
        <div>版本：<b>1.0</b> · 生成工具：<b>DBTerm</b></div>
      </div>
    </div>`
    // 目录
    body += `<div class="toc"><h2>目录</h2><ol>`
    filtered.forEach((t, i) => {
      body += `<li><a href="#t${i}">${esc(t.name)}${t.comment ? `（${esc(t.comment)}）` : ''}</a></li>`
    })
    body += `</ol></div>`
    // 各表
    filtered.forEach((t, i) => {
      body += `<h2 class="tbl" id="t${i}">${i + 1}. ${esc(t.name)}</h2>`
      if (t.comment) body += `<p class="tcomment">${esc(t.comment)}</p>`
      body += `<table><thead><tr><th class="no">#</th><th>字段名</th><th>类型</th><th>允许空</th><th>键</th><th>默认值</th><th>注释</th></tr></thead><tbody>`
      t.columns.forEach((col, ci) => {
        const kc = col.keyType === 'PRI' ? 'pk' : col.keyType === 'UNI' ? 'uni' : col.keyType === 'MUL' ? 'mul' : ''
        body += `<tr>`
          + `<td class="no">${ci + 1}</td>`
          + `<td class="mono"><b>${esc(col.name)}</b></td>`
          + `<td class="mono">${esc(col.dataType)}</td>`
          + `<td>${col.nullable ? '是' : '否'}</td>`
          + `<td class="${kc}">${keyLabel(col.keyType)}</td>`
          + `<td class="mono">${esc(col.defaultVal || '')}</td>`
          + `<td>${esc(col.comment)}</td>`
          + `</tr>`
      })
      body += `</tbody></table>`
      if (t.indexes.length) {
        body += `<div class="idx"><b>索引：</b>` + t.indexes.map(idx =>
          `${esc(idx.name)}（${esc(idx.columns)}）${idx.unique ? ' UNIQUE' : ''}`
        ).join(' · ') + `</div>`
      }
    })
    body += `</div>`

    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">`
      + `<title>数据字典 — ${esc(schema)}</title><style>${style}</style></head><body>${body}</body></html>`

    const fname = tableFilter && tableFilter.length === 1
      ? `数据字典_${schema}_${tableFilter[0]}.html` : `数据字典_${schema}.html`
    await saveTextFile(html, fname, 'HTML', 'html')
    } catch (e) { toast.error(`导出失败：${String(e)}`) } finally { setExporting(false) }
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div
        className="cdlg-box"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 900, display: 'flex', flexDirection: 'column', maxHeight: '90vh', borderRadius: 14, overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <BookOpen size={14} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>数据字典</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {schema}{tableFilter && tableFilter.length ? ` · ${tableFilter.length === 1 ? tableFilter[0] : `选中 ${tableFilter.length} 表`}` : ' · 全库'}
          </span>
          {loading && <Loader2 size={12} className="spin" color="var(--accent)" />}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={exportHtml} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 8, background: 'var(--accent)', color: '#fff', opacity: loading ? 0.5 : 1 }}>
              <Download size={12} /> 导出 HTML
            </button>
            <button onClick={exportMarkdown} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', opacity: loading ? 0.5 : 1 }}>
              <Download size={12} /> Markdown
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)', lineHeight: 0, marginLeft: 2 }}><X size={15} /></button>
          </div>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="过滤表名..."
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, width: 220 }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 10 }}>
            {filteredNames.length} 张表{!scoped && <span style={{ marginLeft: 6 }}>· 展开表加载明细，导出自动补齐</span>}
          </span>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {error && <div style={{ padding: 10, background: 'rgba(220,38,38,0.1)', borderRadius: 8, color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
          {filteredNames.map(name => {
            const t = dict[name]
            const isLoading = loadingTbl.has(name)
            const isOpen = expanded.has(name)
            return (
            <div key={name} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: 'var(--surface-2)', cursor: 'pointer' }}
                onClick={() => setExpanded(prev => {
                  const n = new Set(prev)
                  if (n.has(name)) { n.delete(name) } else { n.add(name); loadTable(name) }
                  return n
                })}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--text-bright)' }}>{name}</span>
                {t?.comment && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>— {t.comment}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                  {isLoading ? '加载中…' : t ? `${t.columns.length} 列` : (isOpen ? '' : '展开查看')}
                </span>
              </div>
              {isOpen && isLoading && !t && (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>加载中…</div>
              )}
              {isOpen && t && (
                <div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'var(--surface)' }}>
                        {['列名', '类型', '可空', '键', '默认值', '备注'].map(h => (
                          <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {t.columns.map((col, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-bright)', fontWeight: col.keyType === 'PRI' ? 700 : 400 }}>{col.name}</td>
                          <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: 11 }}>{col.dataType}</td>
                          <td style={{ padding: '6px 12px', color: col.nullable ? 'var(--text-muted)' : 'var(--text)' }}>{col.nullable ? '是' : '否'}</td>
                          <td style={{ padding: '6px 12px', color: col.keyType === 'PRI' ? '#dc2626' : col.keyType === 'UNI' ? '#7c3aed' : 'var(--text-muted)' }}>{col.keyType}</td>
                          <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{col.defaultVal || ''}</td>
                          <td style={{ padding: '6px 12px', color: 'var(--text-muted)', fontSize: 11 }}>{col.comment}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {t.indexes.length > 0 && (
                    <div style={{ padding: '8px 12px', background: 'var(--surface)', borderTop: '1px solid var(--border-subtle)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>索引</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {t.indexes.map((idx, i) => (
                          <span key={i} style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 6,
                            border: `1px solid ${idx.unique ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                            background: idx.unique ? 'rgba(124,58,237,0.05)' : 'var(--surface-2)',
                            color: idx.unique ? '#7c3aed' : 'var(--text-muted)',
                          }}>
                            {idx.name} ({idx.columns}) {idx.unique ? 'UNIQUE' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
