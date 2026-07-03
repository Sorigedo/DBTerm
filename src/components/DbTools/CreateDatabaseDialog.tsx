// 轻量「新建数据库」弹窗：库名 / 字符集 / 排序规则（随字符集自动拉取）
// 底层走 db_create_database（已做 validate_ident + 正确引用），不拼 SQL
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { toast } from '../../stores/toastStore'
import SearchableSelect from './SearchableSelect'
import { isMysqlFamily } from '../../utils/sqlDialect'
import type { ConnType } from '../../types'

interface Props {
  connectionId: string
  connType: ConnType
  onClose: () => void
  onCreated?: () => void
}

const CHARSETS = [
  'utf8mb4', 'utf8mb3', 'gbk', 'gb18030', 'gb2312', 'big5', 'latin1', 'ascii', 'binary',
  'utf16', 'utf16le', 'utf32', 'ucs2', 'cp932', 'eucjpms', 'euckr', 'cp1250', 'cp1251',
  'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866', 'koi8r', 'koi8u', 'macroman', 'macce',
]

export default function CreateDatabaseDialog({ connectionId, connType, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [charset, setCharset] = useState('utf8mb4')
  const [collation, setCollation] = useState('')
  const [collations, setCollations] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isMy = isMysqlFamily(connType)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // SHOW COLLATION 为 MySQL 系专属，非 MySQL 跳过
  useEffect(() => {
    if (!isMy) return
    let cancelled = false
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        type Rows = { rows: (string | null)[][] }
        const res = await invoke<Rows>('execute_query', {
          id: connectionId,
          sql: `SHOW COLLATION WHERE Charset = '${charset.replace(/'/g, "''")}'`,
        })
        if (cancelled) return
        const list = res.rows.map(r => String(r[0] ?? '')).filter(Boolean).sort()
        setCollations(list)
        const def = res.rows.find(r => r[3] === 'Yes')
        setCollation(def ? String(def[0]) : (list[0] ?? ''))
      } catch { if (!cancelled) { setCollations([]); setCollation('') } }
    })()
    return () => { cancelled = true }
  }, [connectionId, charset, isMy])

  const create = async () => {
    const dbName = name.trim()
    if (!dbName || busy) return
    setBusy(true); setErr('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_create_database', { id: connectionId, dbName, charset: isMy ? charset : '', collate: isMy ? collation : '' })
      toast.success(`已创建数据库 ${dbName}`)
      onCreated?.()
      onClose()
    } catch (e) {
      // 失败只在弹窗内提示，避免一错两处
      setErr(String(e))
    } finally { setBusy(false) }
  }

  return createPortal(
    <div className="modal-overlay" onMouseDown={!busy ? onClose : undefined}>
      <div className="modal-box modal-box--sm" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">新建数据库</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
            数据库名
            <input value={name} autoFocus
              autoComplete="off" autoCorrect="off" spellCheck={false}
              placeholder="database_name"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) create() }} />
          </div>
          {isMy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              字符集
              <SearchableSelect value={charset} onChange={setCharset} options={CHARSETS} />
            </div>
          )}
          {isMy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              排序规则
              <SearchableSelect value={collation} onChange={setCollation}
                options={collations} disabled={collations.length === 0}
                placeholder={collations.length === 0 ? '加载中…' : '选择排序规则'} />
            </div>
          )}
          {err && <span style={{ color: 'var(--error)', fontSize: 13 }}>{err}</span>}
        </div>
        <div className="modal-footer cf-footer">
          <div className="cf-footer-actions">
            <div />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-cancel" onClick={onClose} disabled={busy}>取消</button>
              <button
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, opacity: name.trim() && !busy ? 1 : 0.4 }}
                disabled={!name.trim() || busy}
                onClick={create}>
                {busy ? '执行中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
