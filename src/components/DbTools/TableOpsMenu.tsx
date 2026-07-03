import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Eye, Columns, Scissors, Trash2, Pencil, Copy, Download,
  ChevronRight,
} from 'lucide-react'

interface Props {
  connectionId: string
  connType: string
  schema: string
  table: string
  position: { x: number; y: number }
  onClose: () => void
  onDone: () => void
}

type Dialog =
  | 'truncate'
  | 'drop'
  | 'rename'
  | 'copy'
  | 'export'
  | null

interface FormatOption {
  value: string
  label: string
  ext: string
}

const EXPORT_FORMATS: FormatOption[] = [
  { value: 'csv',      label: 'CSV',      ext: 'csv'  },
  { value: 'txt',      label: 'TXT',      ext: 'txt'  },
  { value: 'json',     label: 'JSON',     ext: 'json' },
  { value: 'sql',      label: 'SQL',      ext: 'sql'  },
  { value: 'markdown', label: 'Markdown', ext: 'md'   },
  { value: 'html',     label: 'HTML',     ext: 'html' },
  { value: 'xml',      label: 'XML',      ext: 'xml'  },
]

export default function TableOpsMenu({
  connectionId, connType: _connType, schema, table, position, onClose, onDone,
}: Props) {
  const [dialog, setDialog]           = useState<Dialog>(null)
  const [confirmName, setConfirmName] = useState('')
  const [newName, setNewName]         = useState('')
  const [copyName, setCopyName]       = useState(`${table}_copy`)
  const [copyData, setCopyData]       = useState(true)
  const [exportFormat, setExportFormat] = useState('csv')
  const [busy, setBusy]               = useState(false)
  const [opError, setOpError]         = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // Clamp position to viewport
  const [pos, setPos] = useState(position)
  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let x = position.x
    let y = position.y
    if (x + rect.width > window.innerWidth)  x = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8
    if (x < 8) x = 8
    if (y < 8) y = 8
    setPos({ x, y })
  }, [position])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  function openDialog(d: Dialog) {
    setOpError('')
    setConfirmName('')
    setNewName(table)
    setCopyName(`${table}_copy`)
    setCopyData(true)
    setExportFormat('csv')
    setDialog(d)
  }

  async function runTruncate() {
    if (confirmName !== table || busy) return
    setBusy(true)
    setOpError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_truncate_table', { id: connectionId, schema, table })
      onDone()
      onClose()
    } catch (e) {
      setOpError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runDrop() {
    if (confirmName !== table || busy) return
    setBusy(true)
    setOpError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_drop_table', { id: connectionId, schema, table })
      onDone()
      onClose()
    } catch (e) {
      setOpError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runRename() {
    if (!newName.trim() || busy) return
    setBusy(true)
    setOpError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_rename_table', { id: connectionId, schema, oldName: table, newName: newName.trim() })
      onDone()
      onClose()
    } catch (e) {
      setOpError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runCopy() {
    if (!copyName.trim() || busy) return
    setBusy(true)
    setOpError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_copy_table', {
        id: connectionId, schema,
        srcTable: table,
        dstTable: copyName.trim(),
        copyData,
      })
      onDone()
      onClose()
    } catch (e) {
      setOpError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runExport() {
    try {
      const fmt = EXPORT_FORMATS.find((f) => f.value === exportFormat)!
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: `${table}.${fmt.ext}`,
        filters: [{ name: fmt.label, extensions: [fmt.ext] }],
      })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('db_export_table', {
        id: connectionId,
        schema,
        table,
        format: exportFormat,
        whereClause: null,
        path,
      })
      onClose()
    } catch { /* user cancelled */ }
  }

  // ── Menu items ──────────────────────────────────────────────────────────────

  const menuItems = (
    <div className="tops-menu" ref={menuRef} style={{ left: pos.x, top: pos.y }}>
      <button className="tops-item" onClick={() => { onClose() }}>
        <Eye size={13} className="tops-item__icon" />
        查看数据
      </button>
      <button className="tops-item" onClick={() => { onClose() }}>
        <Columns size={13} className="tops-item__icon" />
        查看结构
      </button>

      <div className="tops-sep" />

      <button className="tops-item tops-item--warn" onClick={() => openDialog('truncate')}>
        <Scissors size={13} className="tops-item__icon" />
        截断表 (TRUNCATE)
      </button>
      <button className="tops-item tops-item--danger" onClick={() => openDialog('drop')}>
        <Trash2 size={13} className="tops-item__icon" />
        删除表 (DROP)
      </button>
      <button className="tops-item" onClick={() => openDialog('rename')}>
        <Pencil size={13} className="tops-item__icon" />
        重命名
      </button>
      <button className="tops-item" onClick={() => openDialog('copy')}>
        <Copy size={13} className="tops-item__icon" />
        复制表
      </button>

      <div className="tops-sep" />

      <button className="tops-item" onClick={() => openDialog('export')}>
        <Download size={13} className="tops-item__icon" />
        导出表数据
        <ChevronRight size={11} className="tops-item__arrow" />
      </button>
    </div>
  )

  // ── Inline dialogs ──────────────────────────────────────────────────────────

  function InlineDialog({ children }: { children: React.ReactNode }) {
    return (
      <div className="tops-dlg-overlay" onMouseDown={onClose}>
        <div className="tops-dlg-box" onMouseDown={(e) => e.stopPropagation()}>
          {children}
        </div>
      </div>
    )
  }

  if (dialog === 'truncate') {
    return createPortal(
      <InlineDialog>
        <div className="tops-dlg-head tops-dlg-head--warn">
          <Scissors size={15} /> 截断表 — {table}
        </div>
        <p className="tops-dlg-desc">此操作将清空表内所有数据，但保留表结构。</p>
        <label className="tops-dlg-label">
          请输入表名 <strong>{table}</strong> 以确认：
        </label>
        <input
          className="tops-dlg-input"
          autoFocus
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runTruncate() }}
          placeholder={table}
        />
        {opError && <div className="tops-dlg-error">{opError}</div>}
        <div className="tops-dlg-foot">
          <button className="tops-dlg-btn tops-dlg-btn--cancel" onClick={onClose}>取消</button>
          <button
            className="tops-dlg-btn tops-dlg-btn--warn"
            disabled={confirmName !== table || busy}
            onClick={runTruncate}
          >
            {busy ? '执行中…' : '确认截断'}
          </button>
        </div>
      </InlineDialog>,
      document.body
    )
  }

  if (dialog === 'drop') {
    return createPortal(
      <InlineDialog>
        <div className="tops-dlg-head tops-dlg-head--danger">
          <Trash2 size={15} /> 删除表 — {table}
        </div>
        <p className="tops-dlg-desc">此操作不可恢复，表及其所有数据将被永久删除。</p>
        <label className="tops-dlg-label">
          请输入表名 <strong>{table}</strong> 以确认：
        </label>
        <input
          className="tops-dlg-input"
          autoFocus
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runDrop() }}
          placeholder={table}
        />
        {opError && <div className="tops-dlg-error">{opError}</div>}
        <div className="tops-dlg-foot">
          <button className="tops-dlg-btn tops-dlg-btn--cancel" onClick={onClose}>取消</button>
          <button
            className="tops-dlg-btn tops-dlg-btn--danger"
            disabled={confirmName !== table || busy}
            onClick={runDrop}
          >
            {busy ? '执行中…' : '确认删除'}
          </button>
        </div>
      </InlineDialog>,
      document.body
    )
  }

  if (dialog === 'rename') {
    return createPortal(
      <InlineDialog>
        <div className="tops-dlg-head">
          <Pencil size={15} /> 重命名表
        </div>
        <label className="tops-dlg-label">新表名</label>
        <input
          className="tops-dlg-input"
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runRename() }}
        />
        {opError && <div className="tops-dlg-error">{opError}</div>}
        <div className="tops-dlg-foot">
          <button className="tops-dlg-btn tops-dlg-btn--cancel" onClick={onClose}>取消</button>
          <button
            className="tops-dlg-btn tops-dlg-btn--primary"
            disabled={!newName.trim() || busy}
            onClick={runRename}
          >
            {busy ? '执行中…' : '确认重命名'}
          </button>
        </div>
      </InlineDialog>,
      document.body
    )
  }

  if (dialog === 'copy') {
    return createPortal(
      <InlineDialog>
        <div className="tops-dlg-head">
          <Copy size={15} /> 复制表
        </div>
        <label className="tops-dlg-label">新表名</label>
        <input
          className="tops-dlg-input"
          autoFocus
          value={copyName}
          onChange={(e) => setCopyName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runCopy() }}
        />
        <label className="tops-dlg-checkbox">
          <input
            type="checkbox"
            checked={copyData}
            onChange={(e) => setCopyData(e.target.checked)}
          />
          包含数据
        </label>
        {opError && <div className="tops-dlg-error">{opError}</div>}
        <div className="tops-dlg-foot">
          <button className="tops-dlg-btn tops-dlg-btn--cancel" onClick={onClose}>取消</button>
          <button
            className="tops-dlg-btn tops-dlg-btn--primary"
            disabled={!copyName.trim() || busy}
            onClick={runCopy}
          >
            {busy ? '复制中…' : '确认复制'}
          </button>
        </div>
      </InlineDialog>,
      document.body
    )
  }

  if (dialog === 'export') {
    return createPortal(
      <InlineDialog>
        <div className="tops-dlg-head">
          <Download size={15} /> 导出表数据
        </div>
        <label className="tops-dlg-label">导出格式</label>
        <div className="tops-dlg-format-row">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.value}
              className={`tops-dlg-fmt-btn ${exportFormat === f.value ? 'tops-dlg-fmt-btn--active' : ''}`}
              onClick={() => setExportFormat(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="tops-dlg-foot">
          <button className="tops-dlg-btn tops-dlg-btn--cancel" onClick={onClose}>取消</button>
          <button className="tops-dlg-btn tops-dlg-btn--primary" onClick={runExport}>
            选择路径并导出
          </button>
        </div>
      </InlineDialog>,
      document.body
    )
  }

  // Default: render the context menu
  return createPortal(
    <>
      {/* Click-outside trap */}
      <div className="tops-backdrop" onMouseDown={onClose} />
      {menuItems}
      <style>{`
        .tops-backdrop {
          position: fixed; inset: 0; z-index: 900;
        }
        .tops-menu {
          position: fixed; z-index: 901;
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 4px;
          min-width: 180px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          animation: ctx-in 0.12s ease;
        }
        .tops-item {
          display: flex; align-items: center; gap: 8px;
          width: 100%; padding: 7px 10px; border-radius: 7px;
          font-size: 12px; color: var(--text);
          text-align: left;
        }
        .tops-item:hover { background: var(--surface-hover); }
        .tops-item__icon { color: var(--text-muted); flex-shrink: 0; }
        .tops-item__arrow { margin-left: auto; color: var(--text-muted); }
        .tops-item--warn  { color: #ea580c; }
        .tops-item--warn .tops-item__icon { color: #ea580c; }
        .tops-item--danger { color: #dc2626; }
        .tops-item--danger .tops-item__icon { color: #dc2626; }
        .tops-sep {
          height: 1px; background: var(--border-subtle);
          margin: 3px 4px;
        }
        /* Inline dialog styles */
        .tops-dlg-overlay {
          position: fixed; inset: 0; z-index: 1100;
          background: rgba(0,0,0,0.55); backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
        }
        .tops-dlg-box {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 20px; width: 380px;
          display: flex; flex-direction: column; gap: 10px;
          animation: slideUp 0.18s cubic-bezier(0.34,1.2,0.64,1);
        }
        .tops-dlg-head {
          display: flex; align-items: center; gap: 8px;
          font-size: 14px; font-weight: 600; color: var(--text-bright);
        }
        .tops-dlg-head--danger { color: #dc2626; }
        .tops-dlg-head--warn   { color: #ea580c; }
        .tops-dlg-desc {
          font-size: 12px; color: var(--text-muted); line-height: 1.5;
        }
        .tops-dlg-label {
          font-size: 12px; color: var(--text);
        }
        .tops-dlg-input {
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 8px; color: var(--text); font-size: 13px;
          padding: 7px 10px; width: 100%;
        }
        .tops-dlg-input:focus { border-color: var(--accent); }
        .tops-dlg-checkbox {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; color: var(--text); cursor: pointer;
        }
        .tops-dlg-error {
          font-size: 12px; color: var(--error); padding: 6px 8px;
          border-radius: 6px; background: var(--error-bg);
        }
        .tops-dlg-foot {
          display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
        }
        .tops-dlg-btn {
          padding: 6px 14px; border-radius: 8px;
          font-size: 12px; font-weight: 500;
        }
        .tops-dlg-btn--cancel {
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text);
        }
        .tops-dlg-btn--cancel:hover { background: var(--surface-hover); }
        .tops-dlg-btn--primary { background: var(--accent); color: #fff; }
        .tops-dlg-btn--primary:hover:not(:disabled) { opacity: 0.88; }
        .tops-dlg-btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
        .tops-dlg-btn--danger { background: #dc2626; color: #fff; }
        .tops-dlg-btn--danger:hover:not(:disabled) { opacity: 0.88; }
        .tops-dlg-btn--danger:disabled { opacity: 0.45; cursor: not-allowed; }
        .tops-dlg-btn--warn { background: #ea580c; color: #fff; }
        .tops-dlg-btn--warn:hover:not(:disabled) { opacity: 0.88; }
        .tops-dlg-btn--warn:disabled { opacity: 0.45; cursor: not-allowed; }
        .tops-dlg-format-row {
          display: flex; gap: 6px; flex-wrap: wrap;
        }
        .tops-dlg-fmt-btn {
          padding: 5px 12px; border-radius: 7px;
          font-size: 12px;
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text);
        }
        .tops-dlg-fmt-btn:hover { background: var(--surface-hover); }
        .tops-dlg-fmt-btn--active {
          background: var(--accent-bg); border-color: var(--accent);
          color: var(--accent);
        }
      `}</style>
    </>,
    document.body
  )
}

// ── Helper: trigger props for right-click ──────────────────────────────────────

interface MenuTriggerState {
  open: boolean
  position: { x: number; y: number }
}

export function useTableOpsMenuTrigger() {
  const [state, setState] = useState<MenuTriggerState>({ open: false, position: { x: 0, y: 0 } })

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setState({ open: true, position: { x: e.clientX, y: e.clientY } })
  }

  function close() { setState((s) => ({ ...s, open: false })) }

  return { menuOpen: state.open, menuPosition: state.position, onContextMenu, closeMenu: close }
}
