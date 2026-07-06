import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import ConfirmDialog from '../shared/ConfirmDialog'
import {
  Folder, File, RefreshCw, FolderPlus, ChevronRight,
  Loader2, X, Trash2, Edit3, Download, Upload, ArrowLeft, FolderOpen,
  Copy, FolderInput, CheckCircle2, AlertCircle, Shield, FolderDown, FileEdit, Save,
} from 'lucide-react'

interface Transfer {
  id: string
  type: 'upload' | 'download'
  filename: string
  status: 'progress' | 'done' | 'error'
  message?: string
  transferred?: number
  total?: number
}

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: string
  permissions: string
}

interface CtxMenu {
  x: number
  y: number
  entry: FileEntry | null
}

interface Props {
  sessionId: string
  initialPath?: string
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// "2026-04-24 09:20" → "04-24 09:20"
function formatDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(5)
  return s
}

// ── 右键菜单 ────────────────────────────────────────────────

interface MenuItem {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  onClick?: () => void
}

function ContextMenu({ menu, items, onClose }: {
  menu: CtxMenu
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 防止超出视口
  const vw = window.innerWidth
  const vh = window.innerHeight
  const estimatedH = items.length * 28 + 8
  const estimatedW = 180
  const x = menu.x + estimatedW > vw ? menu.x - estimatedW : menu.x
  const y = menu.y + estimatedH > vh ? menu.y - estimatedH : menu.y

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator
          ? <div key={i} className="ctx-divider" />
          : (
            <button
              key={i}
              className={`ctx-item${item.danger ? ' ctx-item--danger' : ''}${item.disabled ? ' ctx-item--disabled' : ''}`}
              onClick={() => { if (!item.disabled) { item.onClick?.(); onClose() } }}
            >
              {item.icon && <span className="ctx-item__icon">{item.icon}</span>}
              {item.label}
            </button>
          )
      )}
    </div>,
    document.body
  )
}

// ── 主组件 ──────────────────────────────────────────────────

export default function FileManagerPanel({ sessionId, initialPath, onClose }: Props) {
  const [path, setPath]           = useState('/')
  const [entries, setEntries]     = useState<FileEntry[]>([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [selected, setSelected]   = useState<string | null>(null)
  const [renaming, setRenaming]   = useState<string | null>(null)
  const [newName, setNewName]     = useState('')
  const [history, setHistory]     = useState<string[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [creatingDir, setCreatingDir] = useState(false)
  const [newDirName, setNewDirName]   = useState('')
  const [pathEditing, setPathEditing] = useState(false)
  const [pathInput, setPathInput]     = useState('')
  const [ctxMenu, setCtxMenu]         = useState<CtxMenu | null>(null)
  const [dragOver, setDragOver]       = useState(false)
  const [dialog, setDialog]           = useState<null | { title: string; desc: string; onOk: () => void }>(null)
  const [chmodTarget, setChmodTarget] = useState<FileEntry | null>(null)
  const [chmodValue, setChmodValue]   = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  // 在线编辑器（非受控 textarea 避免 1MB 字符串每键 diff）
  const [editor, setEditor] = useState<{ path: string; original: string; saving: boolean } | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [editorErr, setEditorErr] = useState('')
  const editorRef     = useRef<HTMLTextAreaElement>(null)
  const isSavingRef   = useRef(false)  // 同步守门，防止 Ctrl+S 快速双击并发保存
  const editorPathRef = useRef<string | null>(null)  // 当前打开的文件路径，用于跨异步边界的路径一致性检查

  async function openEditor(filePath: string) {
    setEditorErr('')
    setEditorDirty(false)
    isSavingRef.current = false
    editorPathRef.current = filePath  // 同步登记"最新目标文件"
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content = await invoke<string>('read_remote_file', { id: sessionId, path: filePath })
      // 若用户在读取期间又打开了另一个文件，丢弃本次结果，避免老文件覆盖新文件状态
      if (editorPathRef.current !== filePath) return
      setEditor({ path: filePath, original: content, saving: false })
      editorOpenContent.current = content
    } catch (e) {
      if (editorPathRef.current === filePath) setEditorErr(String(e))
    }
  }
  const editorOpenContent = useRef<string | null>(null)
  // commit 后写入 textarea，比 setTimeout(0) 更可靠（React 18 concurrent 安全）
  useEffect(() => {
    if (editor && editorRef.current && editorOpenContent.current !== null) {
      editorRef.current.value = editorOpenContent.current
      editorOpenContent.current = null
    }
  }, [editor?.path])

  async function saveEditor() {
    if (!editor || !editorRef.current || isSavingRef.current) return
    isSavingRef.current = true
    const content = editorRef.current.value
    const savedPath = editor.path  // 捕获当前路径，跨 await 边界保持一致
    // 在 invoke 之前二次确认 editorPathRef 与 savedPath 一致：
    // openEditor 会在 await 期间重置 isSavingRef 并更新 editorPathRef，
    // 若此刻路径已被新文件覆盖（React commit 与 useEffect 之间的窗口期），
    // 继续保存会将当前 textarea 内容（可能是旧文件）写到新文件路径，造成数据损坏。
    if (editorPathRef.current !== savedPath) { isSavingRef.current = false; return }
    setEditor(e => e && { ...e, saving: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_remote_file', { id: sessionId, path: savedPath, content })
      // 用户在保存期间切换了文件时，不覆盖新文件的 original/saving 状态
      setEditor(e => e && e.path === savedPath ? { ...e, original: content, saving: false } : e)
      if (editorRef.current.value === content && editorPathRef.current === savedPath) {
        setEditorDirty(false)
      }
    } catch (e) {
      setEditorErr(String(e))
      setEditor(e => e && e.path === savedPath ? { ...e, saving: false } : e)
    } finally {
      isSavingRef.current = false
    }
  }

  const loadDir = useCallback(async (p: string) => {
    setLoading(true)
    setError('')
    setSelected(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const list = await invoke<FileEntry[]>('list_files', { id: sessionId, path: p })
      setEntries(list)
      setPath(p)
    } catch (e) {
      setError(String(e))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  const joinRemotePath = (base: string, name: string): string =>
    base === '/' ? `/${name}` : `${base.replace(/\/$/, '')}/${name}`

  const normalizeInitialPath = (p?: string): string | null => {
    if (!p) return null
    const s = p.trim()
    if (!s || s === '~') return null
    if (s.startsWith('/')) return s
    return null
  }

  // 起始路径：当前 shell 目录 → 连接配置的 SFTP 默认路径 → 远程 $HOME → 根目录；
  // 默认路径不可访问时展示警告而不是静默回退
  useEffect(() => {
    let stale = false
    const shellPath = normalizeInitialPath(initialPath)
    if (shellPath) {
      loadDir(shellPath).catch(() => {})
      return () => { stale = true }
    }
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<{ path: string; warning: string | null }>('get_file_start_path', { id: sessionId })
        .then((r) => {
          if (stale) return
          // loadDir 内部会先清空 error，警告须在加载完成后再写入
          loadDir(r.path || '/').then(() => {
            if (!stale && r.warning) setError(r.warning)
          })
        })
        .catch((e) => { if (!stale) { setError(String(e)); loadDir('/') } })
    ).catch(() => loadDir('/'))
    return () => { stale = true }
  }, [initialPath, loadDir, sessionId])

  useEffect(() => {
    if (!editor) panelRef.current?.focus()
  }, [editor])

  // SFTP 传输进度事件
  useEffect(() => {
    let unlisten: (() => void) | null = null
    let stale = false
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ id: string; transferId: string; transferred: number; total: number; done: boolean; error: string | null }>(
        'sftp:progress',
        (ev) => {
          if (ev.payload.id !== sessionId) return
          setTransfers(prev => prev.map(t => {
            if (t.id !== ev.payload.transferId) return t
            if (ev.payload.done && ev.payload.error) {
              return { ...t, status: 'error', message: ev.payload.error, transferred: ev.payload.transferred }
            }
            // done 且无错误：最终状态由 invoke 返回值落定（含本地保存路径），这里只刷新进度
            return { ...t, transferred: ev.payload.transferred, total: ev.payload.total || t.total }
          }))
        }
      ).then((fn) => {
        if (stale) { fn(); return }
        unlisten = fn
      })
    )
    return () => { stale = true; unlisten?.() }
  }, [sessionId])

  const navigateTo = (p: string) => {
    setHistory((h) => [...h, path])
    loadDir(p)
  }

  const goBack = () => {
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory((h) => h.slice(0, -1))
    loadDir(prev)
  }

  const goUp = () => {
    const parts = path.split('/').filter(Boolean)
    const parent = parts.length > 0 ? '/' + parts.slice(0, -1).join('/') : '/'
    navigateTo(parent || '/')
  }

  const deleteEntry = (entry: FileEntry) => {
    setDialog({
      title: `删除${entry.isDir ? '文件夹' : '文件'}`,
      desc: `确认删除"${entry.name}"？${entry.isDir ? '文件夹及其所有内容' : '该文件'}将被永久删除，无法恢复。`,
      onOk: async () => {
        setDialog(null)
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('delete_file', { id: sessionId, path: entry.path })
          loadDir(path)
        } catch (e) {
          setError(String(e))
        }
      },
    })
  }

  const startRename = (entry: FileEntry) => {
    setRenaming(entry.path)
    setNewName(entry.name)
  }

  // "drwxr-xr-x" → "755"；"rwsr-xr-x" → "4755"（保留 suid/sgid/sticky）
  const permsToOctal = (perms: string): string => {
    const bits = perms.slice(1, 10)
    if (bits.length !== 9) return ''
    let special = 0
    if (bits[2] === 's' || bits[2] === 'S') special += 4
    if (bits[5] === 's' || bits[5] === 'S') special += 2
    if (bits[8] === 't' || bits[8] === 'T') special += 1
    let out = ''
    for (let i = 0; i < 9; i += 3) {
      let n = 0
      if (bits[i]     !== '-') n += 4
      if (bits[i + 1] !== '-') n += 2
      const x = bits[i + 2]
      if (x === 'x' || x === 's' || x === 't') n += 1
      out += n
    }
    return special > 0 ? `${special}${out}` : out
  }

  const startChmod = (entry: FileEntry) => {
    setChmodTarget(entry)
    setChmodValue(permsToOctal(entry.permissions))
  }

  const confirmChmod = async () => {
    if (!chmodTarget) return
    const mode = chmodValue.trim()
    if (!/^[0-7]{3,4}$/.test(mode)) { setError('权限必须是 3-4 位八进制数字'); return }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('chmod_file', { id: sessionId, path: chmodTarget.path, mode })
      setChmodTarget(null)
      loadDir(path)
    } catch (e) {
      setError(String(e))
      setChmodTarget(null)
    }
  }

  const confirmRename = async () => {
    if (!renaming || !newName.trim()) return
    const parts = renaming.split('/')
    parts[parts.length - 1] = newName.trim()
    const newPath = parts.join('/')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('rename_file', { id: sessionId, from: renaming, to: newPath })
      setRenaming(null)
      loadDir(path)
    } catch (e) {
      setError(String(e))
    }
  }

  const addTransfer = (t: Transfer) => setTransfers(prev => [...prev, t])
  const updateTransfer = (id: string, patch: Partial<Transfer>) =>
    setTransfers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
  const removeTransfer = (id: string) => setTransfers(prev => prev.filter(t => t.id !== id))

  const downloadFile = async (entry: FileEntry) => {
    const tid = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addTransfer({ id: tid, type: 'download', filename: entry.name, status: 'progress', transferred: 0, total: entry.size })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const localPath: string = await invoke('download_file', {
        id: sessionId, remotePath: entry.path, transferId: tid,
      })
      updateTransfer(tid, { status: 'done', message: `已保存到：${localPath}` })
    } catch (e) {
      updateTransfer(tid, { status: 'error', message: String(e) })
    }
  }

  const downloadDir = async (entry: FileEntry) => {
    const tid = `dld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addTransfer({ id: tid, type: 'download', filename: `${entry.name}/`, status: 'progress', transferred: 0, total: 0 })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const localPath: string = await invoke('download_dir', {
        id: sessionId, remotePath: entry.path, transferId: tid,
      })
      updateTransfer(tid, { status: 'done', message: `已保存到：${localPath}` })
    } catch (e) {
      updateTransfer(tid, { status: 'error', message: String(e) })
    }
  }

  const pickAndUploadDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: false, directory: true, title: '选择要上传的文件夹' })
      if (!picked) return
      const localPath = typeof picked === 'string' ? picked : (picked as string[])[0]
      const dirname = localPath.split('/').filter(Boolean).pop() ?? localPath
      const tid = `uld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      addTransfer({ id: tid, type: 'upload', filename: `${dirname}/`, status: 'progress', transferred: 0 })
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('upload_dir', { id: sessionId, remoteBase: path, localPath, transferId: tid })
        updateTransfer(tid, { status: 'done', message: `已上传至：${joinRemotePath(path, dirname)}` })
        loadDir(path)
      } catch (e) {
        updateTransfer(tid, { status: 'error', message: String(e) })
      }
    } catch (e) {
      setError(String(e))
    }
  }

  /// 原生文件选择对话框 → 后端按本地路径流式上传（不经前端内存）
  const pickAndUpload = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: true, directory: false, title: '选择要上传的文件' })
      if (!picked) return
      const files = Array.isArray(picked) ? picked : [picked]
      for (const localPath of files) {
        uploadByPath(localPath)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  const uploadDirByPath = async (localPath: string) => {
    const dirname = localPath.split('/').filter(Boolean).pop() ?? localPath
    const tid = `uld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addTransfer({ id: tid, type: 'upload', filename: `${dirname}/`, status: 'progress', transferred: 0 })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('upload_dir', { id: sessionId, remoteBase: path, localPath, transferId: tid })
      updateTransfer(tid, { status: 'done', message: `已上传至：${joinRemotePath(path, dirname)}` })
      loadDir(path)
    } catch (e) {
      updateTransfer(tid, { status: 'error', message: String(e) })
    }
  }

  const uploadByPath = async (localPath: string) => {
    const filename = localPath.split('/').pop() ?? localPath
    const tid = `ul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addTransfer({ id: tid, type: 'upload', filename, status: 'progress', transferred: 0 })
    try {
      const remotePath = joinRemotePath(path, filename)
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('upload_file_path', { id: sessionId, remotePath, localPath, transferId: tid })
      updateTransfer(tid, { status: 'done', message: `已上传至：${remotePath}` })
      loadDir(path)
    } catch (e) {
      const msg = String(e)
      if (msg.includes('只支持上传单个文件') || msg.includes('Is a directory') || msg.includes('目录')) {
        removeTransfer(tid)
        uploadDirByPath(localPath)
        return
      }
      updateTransfer(tid, { status: 'error', message: msg })
    }
  }

  const localPathsFromDataTransfer = (dt: DataTransfer | null): string[] => {
    if (!dt) return []
    const paths: string[] = []
    for (const file of Array.from(dt.files)) {
      const p = (file as File & { path?: string }).path
      if (p) paths.push(p)
    }
    return paths
  }

  const uploadLocalPaths = (paths: string[]) => {
    const uniq = Array.from(new Set(paths.filter(Boolean)))
    for (const p of uniq) uploadByPath(p)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = localPathsFromDataTransfer(e.dataTransfer)
    if (!paths.length) {
      setError('未能读取拖入文件路径，请使用上传按钮选择文件')
      return
    }
    uploadLocalPaths(paths)
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [contenteditable="true"]')) return
    const paths = localPathsFromDataTransfer(e.clipboardData)
    if (!paths.length) return
    e.preventDefault()
    uploadLocalPaths(paths)
  }

  const cancelTransfer = (tid: string) => {
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('cancel_sftp_transfer', { transferId: tid }).catch(() => {})
    )
  }

  const createDir = () => {
    setNewDirName('')
    setCreatingDir(true)
  }

  const confirmCreateDir = async () => {
    const name = newDirName.trim()
    setCreatingDir(false)
    if (!name) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('create_dir', { id: sessionId, path: joinRemotePath(path, name) })
      loadDir(path)
    } catch (e) {
      setError(String(e))
    }
  }

  const copyPath = (p: string) => {
    navigator.clipboard.writeText(p).catch(() => {})
  }

  const openPathEdit = () => {
    setPathInput(path)
    setPathEditing(true)
    setTimeout(() => { pathInputRef.current?.select() }, 30)
  }

  const commitPathEdit = () => {
    const p = pathInput.trim() || '/'
    setPathEditing(false)
    if (p !== path) navigateTo(p)
  }

  const openCtxMenu = (e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault()
    e.stopPropagation()
    if (entry) setSelected(entry.path)
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const buildMenuItems = (entry: FileEntry | null): MenuItem[] => {
    if (!entry) {
      // 空白区右键
      return [
        { label: '上传文件', icon: <Upload size={12} />, onClick: pickAndUpload },
        { label: '上传文件夹', icon: <FolderDown size={12} />, onClick: pickAndUploadDir },
        { label: '新建文件夹', icon: <FolderPlus size={12} />, onClick: createDir },
        { separator: true },
        { label: '刷新', icon: <RefreshCw size={12} />, onClick: () => loadDir(path) },
        { label: '复制当前路径', icon: <Copy size={12} />, onClick: () => copyPath(path) },
      ]
    }
    if (entry.isDir) {
      // 文件夹右键
      return [
        { label: '打开', icon: <FolderInput size={12} />, onClick: () => navigateTo(entry.path) },
        { label: '下载文件夹', icon: <Download size={12} />, onClick: () => downloadDir(entry) },
        { separator: true },
        { label: '重命名', icon: <Edit3 size={12} />, onClick: () => startRename(entry) },
        { label: '修改权限', icon: <Shield size={12} />, onClick: () => startChmod(entry) },
        { label: '复制路径', icon: <Copy size={12} />, onClick: () => copyPath(entry.path) },
        { separator: true },
        { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => deleteEntry(entry) },
      ]
    }
    // 文件右键
    return [
      { label: '下载', icon: <Download size={12} />, onClick: () => downloadFile(entry) },
      { separator: true },
      { label: '重命名', icon: <Edit3 size={12} />, onClick: () => startRename(entry) },
      { label: '修改权限', icon: <Shield size={12} />, onClick: () => startChmod(entry) },
      { label: '复制路径', icon: <Copy size={12} />, onClick: () => copyPath(entry.path) },
      { separator: true },
      { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => deleteEntry(entry) },
    ]
  }

  const breadcrumbs = path === '/' ? ['/'] : ['/', ...path.split('/').filter(Boolean)]

  // 在线编辑器视图
  if (editor) {
    return (
      <div className="ssh-panel" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="ssh-panel__header">
          <span className="ssh-panel__title">
            <FileEdit size={13} strokeWidth={1.8} />
            {editor.path.split('/').pop()}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="ssh-panel__btn" onClick={saveEditor} disabled={!editorDirty || editor.saving}
              style={{ color: editorDirty ? 'var(--accent)' : undefined, opacity: !editorDirty || editor.saving ? 0.5 : 1 }}
              data-tip="保存 (Ctrl+S)">
              {editor.saving ? <Loader2 size={13} className="spin" /> : <Save size={13} strokeWidth={2} />}
            </button>
            <button className="ssh-panel__btn" onClick={() => { setEditor(null); setEditorErr('') }} data-tip="关闭">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
        {editorErr && <div style={{ padding: '6px 10px', fontSize: 11, color: '#dc2626', background: 'rgba(220,38,38,0.08)', borderBottom: '1px solid var(--border-subtle)' }}>{editorErr}</div>}
        <div style={{ flex: 1, padding: 6, display: 'flex', flexDirection: 'column' }}>
          <textarea
            ref={editorRef}
            defaultValue=""
            spellCheck={false}
            onChange={() => setEditorDirty(true)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveEditor() } }}
            style={{ flex: 1, resize: 'none', padding: 10, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55, width: '100%', boxSizing: 'border-box', outline: 'none' }}
          />
        </div>
        <div style={{ padding: '5px 10px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
          {editor.path}{editorDirty ? ' · 已修改' : ''}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`ssh-panel file-panel${dragOver ? ' file-panel--drag' : ''}`}
      ref={panelRef}
      tabIndex={0}
      onPaste={handlePaste}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <div className="ssh-panel__header">
        <span className="ssh-panel__title">
          <Folder size={13} strokeWidth={1.8} />
          文件管理
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="ssh-panel__btn"
            onClick={pickAndUpload}
            data-tip="上传文件"
          >
            <Upload size={13} strokeWidth={2} />
          </button>
          <button
            className="ssh-panel__btn"
            onClick={pickAndUploadDir}
            data-tip="上传文件夹"
          >
            <FolderDown size={13} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" onClick={createDir} data-tip="新建文件夹">
            <FolderPlus size={13} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" onClick={() => loadDir(path)} data-tip="刷新">
            <RefreshCw size={13} strokeWidth={2} />
          </button>
          <button className="ssh-panel__btn" onClick={onClose} data-tip="关闭">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {dragOver && (
        <div className="file-drop-overlay">
          <Upload size={20} strokeWidth={2} />
          <span>松开上传到当前目录</span>
          <small>{path}</small>
        </div>
      )}

      {/* 路径栏 */}
      <div className="file-breadcrumb">
        <button
          className="file-nav-btn"
          onClick={history.length > 0 ? goBack : undefined}
          style={{ opacity: history.length > 0 ? 1 : 0.3 }}
          data-tip="返回"
        >
          <ArrowLeft size={12} strokeWidth={2} />
        </button>
        <button className="file-nav-btn" onClick={goUp} data-tip="上级目录">
          <ChevronRight size={12} strokeWidth={2} style={{ transform: 'rotate(180deg)' }} />
        </button>

        {pathEditing ? (
          <input
            ref={pathInputRef}
            className="file-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPathEdit()
              if (e.key === 'Escape') setPathEditing(false)
            }}
            onBlur={commitPathEdit}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <div
            className="file-bc-path"
            data-tip="点击输入路径"
            onClick={openPathEdit}
            style={{ cursor: 'text', flex: 1 }}
          >
            {breadcrumbs.map((seg, i) => {
              const segPath = i === 0 ? '/' : '/' + breadcrumbs.slice(1, i + 1).join('/')
              return (
                <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
                  {i > 0 && <ChevronRight size={10} className="bc-sep" />}
                  <button
                    className="bc-seg"
                    onClick={(e) => { e.stopPropagation(); navigateTo(segPath) }}
                  >
                    {seg}
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <button className="file-nav-btn" onClick={openPathEdit} data-tip="手动输入路径">
          <FolderOpen size={12} strokeWidth={2} />
        </button>
      </div>

      <div
        className="ssh-panel__body"
        onContextMenu={(e) => {
          // 点在空白处触发空白菜单
          if ((e.target as HTMLElement).closest('.file-row')) return
          openCtxMenu(e, null)
        }}
      >
        {error && <div className="panel-error">{error}</div>}

        {loading && (
          <div className="panel-loading">
            <Loader2 size={20} className="spin" />
          </div>
        )}

        {!loading && (
          <div className="file-list">
            {entries.length > 0 && (
              <div className="file-list-header">
                <span className="file-list-header__icon" />
                <span className="file-list-header__name">名称</span>
                <span className="file-list-header__size">大小</span>
                <span className="file-list-header__date">修改时间</span>
              </div>
            )}
            {/* 内联新建文件夹 input */}
            {creatingDir && (
              <div className="file-row file-newdir-row">
                <span className="file-row__icon">
                  <Folder size={14} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
                </span>
                <input
                  className="file-rename-input"
                  autoFocus
                  value={newDirName}
                  placeholder="新建文件夹名称"
                  onChange={e => setNewDirName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') confirmCreateDir()
                    if (e.key === 'Escape') setCreatingDir(false)
                  }}
                  onBlur={confirmCreateDir}
                />
              </div>
            )}

            {entries.length === 0 && !creatingDir && !error && (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                目录为空
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`file-row${selected === entry.path ? ' selected' : ''}`}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => { if (entry.isDir) navigateTo(entry.path); else openEditor(entry.path) }}
                onContextMenu={(e) => openCtxMenu(e, entry)}
              >
                <span className="file-row__icon">
                  {entry.isDir
                    ? <Folder size={14} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
                    : <File size={14} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                  }
                </span>

                {renaming === entry.path ? (
                  <input
                    className="file-rename-input"
                    value={newName}
                    autoFocus
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={confirmRename}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="file-row__name" data-tip={entry.name}>{entry.name}</span>
                )}

                <span className="file-row__size">
                  {entry.isDir ? '—' : formatSize(entry.size)}
                </span>
                <span className="file-row__date">{formatDate(entry.modified)}</span>

                {selected === entry.path && renaming !== entry.path && (
                  <div className="file-row__actions">
                    {!entry.isDir && (
                      <button
                        className="file-act-btn"
                        onClick={(e) => { e.stopPropagation(); downloadFile(entry) }}
                        data-tip="下载"
                      >
                        <Download size={11} strokeWidth={2} />
                      </button>
                    )}
                    <button
                      className="file-act-btn"
                      onClick={(e) => { e.stopPropagation(); startRename(entry) }}
                      data-tip="重命名"
                    >
                      <Edit3 size={11} strokeWidth={2} />
                    </button>
                    <button
                      className="file-act-btn danger"
                      onClick={(e) => { e.stopPropagation(); deleteEntry(entry) }}
                      data-tip="删除"
                    >
                      <Trash2 size={11} strokeWidth={2} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 上传/下载进度列表 */}
      {transfers.length > 0 && (
        <div className="transfer-list">
          {transfers.map(t => {
            const pct = t.status === 'progress' && t.total && t.total > 0
              ? Math.min(100, Math.floor((t.transferred ?? 0) / t.total * 100))
              : null
            return (
              <div key={t.id} className={`transfer-item transfer-item--${t.status}`}>
                <span className="transfer-item__icon">
                  {t.status === 'progress'
                    ? <Loader2 size={12} strokeWidth={2} className="spin" />
                    : t.status === 'done'
                    ? <CheckCircle2 size={12} strokeWidth={2} />
                    : <AlertCircle size={12} strokeWidth={2} />
                  }
                </span>
                <div className="transfer-item__info">
                  <span className="transfer-item__name">{t.filename}</span>
                  {t.status === 'progress' ? (
                    <>
                      <span className="transfer-item__msg">
                        {t.type === 'upload' ? '上传中' : '下载中'}
                        {pct !== null
                          ? ` ${pct}% · ${formatSize(t.transferred ?? 0)} / ${formatSize(t.total ?? 0)}`
                          : (t.transferred ? ` · ${formatSize(t.transferred)}` : '…')
                        }
                      </span>
                      <div className="transfer-bar">
                        <div
                          className={`transfer-bar__fill${pct === null ? ' transfer-bar__fill--indeterminate' : ''}`}
                          style={pct !== null ? { width: `${pct}%` } : undefined}
                        />
                      </div>
                    </>
                  ) : (
                    <span className="transfer-item__msg">{t.message}</span>
                  )}
                </div>
                {t.status === 'progress' ? (
                  <button className="transfer-item__close" data-tip="取消传输" onClick={() => cancelTransfer(t.id)}>
                    <X size={11} strokeWidth={2} />
                  </button>
                ) : (
                  <button className="transfer-item__close" onClick={() => removeTransfer(t.id)}>
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="file-status-bar">
        {path} &nbsp;·&nbsp; {entries.length} 项
      </div>

      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          items={buildMenuItems(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      <ConfirmDialog
        open={!!dialog}
        title={dialog?.title ?? ''}
        desc={dialog?.desc ?? ''}
        danger
        okText="确认删除"
        onOk={() => dialog?.onOk()}
        onCancel={() => setDialog(null)}
      />

      {/* 修改权限弹窗 */}
      {chmodTarget && createPortal(
        <div className="cdlg-overlay" onMouseDown={() => setChmodTarget(null)}>
          <div className="cdlg-box" onMouseDown={(e) => e.stopPropagation()}>
            <div className="cdlg-head">
              <Shield size={15} className="cdlg-head__icon cdlg-head__icon--info" />
              <span className="cdlg-head__title">修改权限</span>
            </div>
            <p className="cdlg-desc" style={{ marginBottom: 10 }}>
              {chmodTarget.name} · 当前 {chmodTarget.permissions}
            </p>
            <input
              autoFocus
              className="chmod-input"
              placeholder="如 644 / 755"
              value={chmodValue}
              maxLength={4}
              onChange={(e) => setChmodValue(e.target.value.replace(/[^0-7]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmChmod()
                if (e.key === 'Escape') setChmodTarget(null)
              }}
            />
            <div className="cdlg-foot" style={{ marginTop: 16 }}>
              <button className="cdlg-btn cdlg-btn--cancel" onClick={() => setChmodTarget(null)}>取消</button>
              <button className="cdlg-btn cdlg-btn--ok" onClick={confirmChmod}>应用</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
