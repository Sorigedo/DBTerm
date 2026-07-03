import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info, X, Copy, Check, Loader2 } from 'lucide-react'
import type { ConnType } from '../../types'
import { formatBytes } from '../../utils/format'
import { toast } from '../../stores/toastStore'

/** 表/视图元信息（与后端 list_tables_meta 字段一致的子集） */
export interface TableMetaLite {
  name: string
  comment: string
  rowCount: number
  dataLength: number
  indexLength: number
  autoIncrement: number | null
  engine: string
  charset: string
  updatedAt: string | null
  createdAt: string | null
  tableType: string
}

interface Props {
  connectionId: string
  connType: ConnType | string
  schema: string
  name: string
  isView?: boolean
  /** 预加载的元信息（对象列表页已有，直接传入免去再查询） */
  meta?: TableMetaLite
  onClose: () => void
}

/**
 * 表信息小弹窗：展示行数 / 数据·索引·总占用大小 / 引擎 / 编码 / 注释等，可一键复制。
 * 取代原「快捷 SQL ▸ 统计行数」，更直观且不跳查询页。
 */
export default function TableInfoModal({ connectionId, connType, schema, name, isView, meta, onClose }: Props) {
  const [data, setData] = useState<TableMetaLite | null>(meta ?? null)
  const [loading, setLoading] = useState(!meta)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (meta) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<TableMetaLite[]>('list_tables_meta', { id: connectionId, schema })
        const found = list.find(t => t.name === name)
        if (!alive) return
        if (found) setData(found)
        else setError('未找到该对象的元信息')
      } catch (e) {
        if (alive) setError(String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [connectionId, schema, name, meta])

  const total = data ? data.dataLength + data.indexLength : 0
  // 这些方言的 list_tables_meta 会返回真实(或近真实)的存储大小（Oracle 索引大小暂为 0）
  const supportsSize = connType === 'mysql' || connType === 'mariadb' || connType === 'tidb'
    || connType === 'oceanBase' || connType === 'postgres' || connType === 'kingBase'
    || connType === 'openGauss' || connType === 'sqlite'
    || connType === 'sqlServer' || connType === 'duckdb' || connType === 'oracle'

  // 按对象类型组织展示行（视图无存储概念，不展示大小/引擎）
  const rows: { label: string; value: string }[] = []
  if (data) {
    rows.push({ label: '类型', value: isView ? '视图' : '表' })
    if (!isView) {
      if (data.engine)  rows.push({ label: '引擎', value: data.engine })
      if (data.charset) rows.push({ label: '编码', value: data.charset })
      rows.push({ label: '估算行数', value: data.rowCount.toLocaleString() })
      if (supportsSize) {
        rows.push({ label: '数据大小', value: formatBytes(data.dataLength) })
        rows.push({ label: '索引大小', value: formatBytes(data.indexLength) })
        rows.push({ label: '总占用', value: formatBytes(total) })
      }
      if (data.autoIncrement != null) rows.push({ label: '自增值', value: data.autoIncrement.toLocaleString() })
    }
    if (data.comment)   rows.push({ label: '注释', value: data.comment })
    if (data.createdAt) rows.push({ label: '创建时间', value: data.createdAt })
    if (data.updatedAt) rows.push({ label: '更新时间', value: data.updatedAt })
  }

  function doCopy() {
    const text = [`${schema ? schema + '.' : ''}${name}`, ...rows.map(r => `${r.label}：${r.value}`)].join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      toast.success('表信息已复制')
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => toast.error('复制失败'))
  }

  return createPortal(
    <div className="dbtool-overlay" onMouseDown={onClose}>
      <div className="dbtool-modal" onMouseDown={(e) => e.stopPropagation()} style={{ width: 380 }}>
        <div className="dbtool-modal__header">
          <Info size={15} color="var(--accent)" />
          <span className="dbtool-modal__title">表信息 · {name}</span>
          <button className="dbtool-modal__close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="dbtool-modal__body">
          {loading && <div className="sb-msg"><Loader2 size={14} className="spin" />读取中…</div>}
          {error && !loading && <div className="result-error">{error}</div>}
          {!loading && !error && data && (
            <div className="tbl-info__grid">
              {rows.map(r => (
                <div key={r.label} className="tbl-info__row">
                  <span className="tbl-info__key">{r.label}</span>
                  <span className="tbl-info__val">{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dbtool-modal__footer">
          <button className="dbtool-btn dbtool-btn--cancel" onClick={onClose}>关闭</button>
          <button className="dbtool-btn dbtool-btn--primary" onClick={doCopy} disabled={!data}>
            {copied ? <Check size={13} /> : <Copy size={13} />}复制
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
