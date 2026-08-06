import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Copy, Download, Folder, FolderDown, FolderInput,
  FolderOpen, Home, Info, Loader2, Monitor, RefreshCw, Server, Upload, X, File,
  Trash2, Edit3, Shield, FolderPlus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { formatBytes } from '../../utils/format'
import { shouldCloseFileMenuFromTarget } from './fileManagerMenu'

type Side = 'local' | 'remote'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: string
  permissions: string
}

interface Transfer {
  id: string
  type: 'upload' | 'download'
  filename: string
  status: 'progress' | 'done' | 'error'
  message?: string
  transferred?: number
  total?: number
  source?: string
  target?: string
  startedAt?: number
  finishedAt?: number
  finalElapsed?: number
  finalSpeed?: number
}

interface Props {
  connId: string
  initialRemotePath?: string
}

interface MenuItem {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  separator?: boolean
  onClick?: () => void
}

interface CtxMenu {
  x: number
  y: number
  items: MenuItem[]
}

interface ConfirmState {
  title: string
  desc: string
  okText: string
  danger?: boolean
  onOk: () => void | Promise<void>
}

interface InputState {
  title: string
  desc?: string
  value: string
  placeholder?: string
  okText?: string
  validate?: (value: string) => string | null
  onOk: (value: string) => void | Promise<void>
}

interface FileDrag {
  side: Side
  entry: FileEntry
  startX: number
  startY: number
  started: boolean
}

const formatSize = formatBytes

function joinRemote(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base.replace(/\/$/, '')}/${name}`
}

function localParent(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^[A-Za-z]:/)
  const root = drive ? `${drive[0]}/` : '/'
  const parts = normalized.split('/').filter(Boolean)
  if (drive) parts.shift()
  if (parts.length <= 1) return root
  return `${root}${parts.slice(0, -1).join('/')}`
}

function remoteParent(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/'
}

function localRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^[A-Za-z]:/)
  return drive ? `${drive[0]}/` : '/'
}

function localHome(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^[A-Za-z]:/)
  if (drive) {
    const parts = normalized.split('/').filter(Boolean)
    return parts.length >= 3 && parts[1].toLowerCase() === 'users'
      ? `${drive[0]}/Users/${parts[2]}`
      : null
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2 && parts[0] === 'Users') return `/Users/${parts[1]}`
  if (parts.length >= 2 && parts[0] === 'home') return `/home/${parts[1]}`
  return null
}

function localPathsFromDataTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return []
  const paths: string[] = []
  for (const file of Array.from(dt.files)) {
    const p = (file as File & { path?: string }).path
    if (p) paths.push(p)
  }
  return paths
}

function transferPayload(dt: DataTransfer): { side: Side; entry: FileEntry } | null {
  const raw = dt.getData('application/x-dbterm-file')
  if (!raw) return null
  try { return JSON.parse(raw) as { side: Side; entry: FileEntry } } catch { return null }
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function siblingPath(path: string, name: string): string {
  const slash = path.lastIndexOf('/')
  const backslash = path.lastIndexOf('\\')
  const idx = Math.max(slash, backslash)
  return idx >= 0 ? `${path.slice(0, idx + 1)}${name}` : name
}

function joinLocal(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`
}

function entryKind(entry: FileEntry): string {
  return entry.isDir ? '文件夹' : '文件'
}

function formatTransferElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const seconds = Math.floor(total / 1000)
  const msPart = total % 1000
  return `${seconds}s ${msPart}ms`
}

function ContextMenu({ menu, onClose }: { menu: CtxMenu; onClose: () => void }) {
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

  const w = 240
  const h = menu.items.length * 32 + 10
  const x = menu.x + w > window.innerWidth ? menu.x - w : menu.x
  const y = menu.y + h > window.innerHeight ? menu.y - h : menu.y

  return createPortal(
    <div
      ref={ref}
      className="fm-ctx-menu"
      style={{ left: x, top: y }}
      onPointerDownCapture={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item, i) => item.separator ? (
        <div key={i} className="fm-ctx-menu__sep" />
      ) : (
        <button
          key={i}
          className={`fm-ctx-menu__item${item.danger ? ' fm-ctx-menu__item--danger' : ''}`}
          onClick={() => { item.onClick?.(); onClose() }}
        >
          {item.icon && <span className="fm-ctx-menu__icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

export default function FileManagerWindow({ connId, initialRemotePath }: Props) {
  const [localPath, setLocalPath] = useState('')
  const [remotePath, setRemotePath] = useState(initialRemotePath || '/')
  const [remoteStartPath, setRemoteStartPath] = useState(initialRemotePath || '/')
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([])
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState<Side | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [, setTick] = useState(0)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [dragPreview, setDragPreview] = useState<{ side: Side; name: string; x: number; y: number } | null>(null)
  const [picker, setPicker] = useState<{ side: Side; left: number; top: number; width: number } | null>(null)
  const [selectedLocal, setSelectedLocal] = useState<FileEntry | null>(null)
  const [selectedRemote, setSelectedRemote] = useState<FileEntry | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [inputDialog, setInputDialog] = useState<InputState | null>(null)
  const [infoEntry, setInfoEntry] = useState<{ side: Side; entry: FileEntry | null } | null>(null)
  const dragRef = useRef<FileDrag | null>(null)

  const addTransfer = (t: Transfer) => setTransfers(prev => [...prev, { ...t, startedAt: t.startedAt ?? Date.now() }])
  const removeTransfer = (id: string) => setTransfers(prev => prev.filter(t => t.id !== id))
  const finishTransfer = useCallback((id: string, status: 'done' | 'error', message?: string) => {
    const finishedAt = Date.now()
    setTransfers(prev => prev.map(t => {
      if (t.id !== id) return t
      const startedAt = t.startedAt ?? finishedAt
      const finalElapsed = Math.max(0, finishedAt - startedAt)
      const transferred = t.transferred ?? 0
      const finalSpeed = finalElapsed > 0 ? transferred / (finalElapsed / 1000) : 0
      return { ...t, status, message, finishedAt, finalElapsed, finalSpeed }
    }))
  }, [])

  useEffect(() => {
    if (!transfers.some(t => t.status === 'progress')) return
    const iv = window.setInterval(() => setTick(v => v + 1), 250)
    return () => window.clearInterval(iv)
  }, [transfers])

  const loadLocal = useCallback(async (p: string) => {
    setLocalLoading(true)
    setError('')
    try {
      const list = await invoke<FileEntry[]>('list_local_files', { path: p })
      setLocalPath(p)
      setLocalEntries(list)
      setSelectedLocal(null)
    } catch (e) {
      setError(String(e))
      setLocalEntries([])
    } finally {
      setLocalLoading(false)
    }
  }, [])

  const loadRemote = useCallback(async (p: string) => {
    setRemoteLoading(true)
    setError('')
    try {
      const list = await invoke<FileEntry[]>('list_files', { id: connId, path: p })
      setRemotePath(p)
      setRemoteEntries(list)
      setSelectedRemote(null)
    } catch (e) {
      setError(String(e))
      setRemoteEntries([])
    } finally {
      setRemoteLoading(false)
    }
  }, [connId])

  useEffect(() => {
    invoke<string>('get_local_start_path')
      .then(loadLocal)
      .catch(e => setError(String(e)))
    if (initialRemotePath) {
      setRemoteStartPath(initialRemotePath)
      loadRemote(initialRemotePath)
    } else {
      invoke<{ path: string; warning: string | null }>('get_file_start_path', { id: connId })
        .then(r => {
          const startPath = r.path || '/'
          setRemoteStartPath(startPath)
          loadRemote(startPath)
          if (r.warning) setError(r.warning)
        })
        .catch(() => loadRemote('/'))
    }
  }, [connId, initialRemotePath, loadLocal, loadRemote])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let stale = false
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ id: string; transferId: string; transferred: number; total: number; done: boolean; error: string | null }>(
        'sftp:progress',
        (ev) => {
          if (ev.payload.id !== connId) return
          setTransfers(prev => prev.map(t => {
            if (t.id !== ev.payload.transferId) return t
            if (ev.payload.done && ev.payload.error) return { ...t, status: 'error', message: ev.payload.error }
            return { ...t, transferred: ev.payload.transferred, total: ev.payload.total || t.total }
          }))
        },
      ).then(fn => { if (stale) fn(); else unlisten = fn }),
    )
    return () => { stale = true; unlisten?.() }
  }, [connId])

  const uploadPath = async (path: string) => {
    const filename = fileBaseName(path)
    const target = joinRemote(remotePath, filename)
    const tid = `ul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    addTransfer({ id: tid, type: 'upload', filename, status: 'progress', transferred: 0, source: path, target })
    try {
      await invoke('upload_file_path', { id: connId, remotePath: target, localPath: path, transferId: tid })
      finishTransfer(tid, 'done', `已上传至：${remotePath}`)
      loadRemote(remotePath)
    } catch (e) {
      const msg = String(e)
      if (msg.includes('只支持上传单个文件') || msg.includes('Is a directory') || msg.includes('目录')) {
        try {
          await invoke('upload_dir', { id: connId, remoteBase: remotePath, localPath: path, transferId: tid })
          finishTransfer(tid, 'done', `已上传至：${target}`)
          loadRemote(remotePath)
          return
        } catch (dirErr) {
          finishTransfer(tid, 'error', String(dirErr))
          return
        }
      }
      finishTransfer(tid, 'error', msg)
    }
  }

  const downloadEntry = async (entry: FileEntry) => {
    if (!localPath) return
    const tid = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const target = `${localPath.replace(/\/$/, '')}/${entry.name}`
    addTransfer({
      id: tid,
      type: 'download',
      filename: entry.isDir ? `${entry.name}/` : entry.name,
      status: 'progress',
      transferred: 0,
      total: entry.size,
      source: entry.path,
      target,
    })
    try {
      const cmd = entry.isDir ? 'download_dir_to' : 'download_file_to'
      const local = await invoke<string>(cmd, { id: connId, remotePath: entry.path, localDir: localPath, transferId: tid })
      finishTransfer(tid, 'done', `已保存到：${local}`)
      loadLocal(localPath)
    } catch (e) {
      finishTransfer(tid, 'error', String(e))
    }
  }

  const pickUpload = async (directory: boolean) => {
    const picked = await open({ multiple: !directory, directory, title: directory ? '选择要上传的文件夹' : '选择要上传的文件' })
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    for (const p of paths) uploadPath(p)
  }

  const pickLocalDir = async () => {
    const picked = await open({ multiple: false, directory: true, title: '选择本地目录' })
    if (typeof picked === 'string') loadLocal(picked)
  }

  const handleDrop = (side: Side, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const payload = transferPayload(e.dataTransfer)
    if (side === 'remote') {
      if (payload?.side === 'local') { uploadPath(payload.entry.path); return }
      const paths = localPathsFromDataTransfer(e.dataTransfer)
      if (paths.length) paths.forEach(uploadPath)
      return
    }
    if (payload?.side === 'remote') downloadEntry(payload.entry)
  }

  const cancelTransfer = (tid: string) => {
    invoke('cancel_sftp_transfer', { transferId: tid }).catch(() => {})
  }

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path).catch(() => {})
  }

  const refreshSide = (side: Side) => {
    if (side === 'local') loadLocal(localPath)
    else loadRemote(remotePath)
  }

  const deleteEntry = (side: Side, entry: FileEntry) => {
    setConfirm({
      title: `删除${entryKind(entry)}`,
      desc: `确认删除"${entry.name}"？${entry.isDir ? '文件夹及其所有内容' : '该文件'}将被永久删除，无法恢复。`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        setConfirm(null)
        try {
          if (side === 'local') await invoke('delete_local_file', { path: entry.path })
          else await invoke('delete_file', { id: connId, path: entry.path })
          refreshSide(side)
        } catch (e) {
          setError(String(e))
        }
      },
    })
  }

  const renameEntry = (side: Side, entry: FileEntry) => {
    setInputDialog({
      title: `重命名${entryKind(entry)}`,
      desc: entry.path,
      value: entry.name,
      placeholder: '新名称',
      okText: '重命名',
      validate: (value) => {
        if (!value.trim()) return '名称不能为空'
        if (value.includes('/') || value.includes('\\')) return '名称不能包含路径分隔符'
        return null
      },
      onOk: async (value) => {
        const name = value.trim()
        const nextPath = siblingPath(entry.path, name)
        setInputDialog(null)
        try {
          if (side === 'local') await invoke('rename_local_file', { from: entry.path, to: nextPath })
          else await invoke('rename_file', { id: connId, from: entry.path, to: nextPath })
          refreshSide(side)
        } catch (e) {
          setError(String(e))
        }
      },
    })
  }

  const createDir = (side: Side) => {
    setInputDialog({
      title: `新建${side === 'local' ? '本地' : '远程'}文件夹`,
      desc: side === 'local' ? localPath : remotePath,
      value: '',
      placeholder: '文件夹名称',
      okText: '创建',
      validate: (value) => {
        if (!value.trim()) return '名称不能为空'
        if (value.includes('/') || value.includes('\\')) return '名称不能包含路径分隔符'
        return null
      },
      onOk: async (value) => {
        const base = side === 'local' ? localPath : remotePath
        const target = side === 'local' ? joinLocal(base, value.trim()) : joinRemote(base, value.trim())
        setInputDialog(null)
        try {
          if (side === 'local') await invoke('create_local_dir', { path: target })
          else await invoke('create_dir', { id: connId, path: target })
          refreshSide(side)
        } catch (e) {
          setError(String(e))
        }
      },
    })
  }

  const chmodEntry = (entry: FileEntry) => {
    setInputDialog({
      title: '修改远程权限',
      desc: `${entry.name} · 当前 ${entry.permissions || '-'}`,
      value: '',
      placeholder: '如 644 / 755',
      okText: '应用',
      validate: (value) => /^[0-7]{3,4}$/.test(value.trim()) ? null : '权限必须是 3-4 位八进制数字',
      onOk: async (value) => {
        setInputDialog(null)
        try {
          await invoke('chmod_file', { id: connId, path: entry.path, mode: value.trim() })
          loadRemote(remotePath)
        } catch (e) {
          setError(String(e))
        }
      },
    })
  }

  const buildMenuItems = (side: Side, entry: FileEntry | null): MenuItem[] => {
    if (!entry) {
      return side === 'local'
        ? [
            { label: '新建文件夹', icon: <FolderPlus size={12} />, onClick: () => createDir('local') },
            { label: '选择本地目录', icon: <FolderOpen size={12} />, onClick: pickLocalDir },
            { separator: true },
            { label: '刷新', icon: <RefreshCw size={12} />, onClick: () => loadLocal(localPath) },
            { label: '复制当前路径', icon: <Copy size={12} />, onClick: () => copyPath(localPath) },
          ]
        : [
            { label: '上传文件', icon: <Upload size={12} />, onClick: () => pickUpload(false) },
            { label: '上传文件夹', icon: <FolderDown size={12} />, onClick: () => pickUpload(true) },
            { label: '新建文件夹', icon: <FolderPlus size={12} />, onClick: () => createDir('remote') },
            { separator: true },
            { label: '刷新', icon: <RefreshCw size={12} />, onClick: () => loadRemote(remotePath) },
            { label: '复制当前路径', icon: <Copy size={12} />, onClick: () => copyPath(remotePath) },
          ]
    }
    if (side === 'local') {
      return [
        { label: entry.isDir ? '打开文件夹' : '上传到远程', icon: entry.isDir ? <FolderInput size={12} /> : <Upload size={12} />, onClick: () => entry.isDir ? loadLocal(entry.path) : uploadPath(entry.path) },
        ...(entry.isDir ? [{ label: '上传到远程', icon: <Upload size={12} />, onClick: () => uploadPath(entry.path) }] : []),
        { label: '查看信息/大小', icon: <Info size={12} />, onClick: () => setInfoEntry({ side, entry }) },
        { separator: true },
        { label: '重命名', icon: <Edit3 size={12} />, onClick: () => renameEntry(side, entry) },
        { label: '复制名称', icon: <Copy size={12} />, onClick: () => copyPath(entry.name) },
        { label: '复制路径', icon: <Copy size={12} />, onClick: () => copyPath(entry.path) },
        { separator: true },
        { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => deleteEntry(side, entry) },
      ]
    }
    return [
      { label: entry.isDir ? '打开文件夹' : '下载到本地', icon: entry.isDir ? <FolderInput size={12} /> : <Download size={12} />, onClick: () => entry.isDir ? loadRemote(entry.path) : downloadEntry(entry) },
      ...(entry.isDir ? [{ label: '下载到本地', icon: <Download size={12} />, onClick: () => downloadEntry(entry) }] : []),
      { label: '查看信息/大小', icon: <Info size={12} />, onClick: () => setInfoEntry({ side, entry }) },
      { separator: true },
      { label: '重命名', icon: <Edit3 size={12} />, onClick: () => renameEntry(side, entry) },
      { label: '修改权限', icon: <Shield size={12} />, onClick: () => chmodEntry(entry) },
      { label: '复制名称', icon: <Copy size={12} />, onClick: () => copyPath(entry.name) },
      { label: '复制路径', icon: <Copy size={12} />, onClick: () => copyPath(entry.path) },
      { separator: true },
      { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => deleteEntry(side, entry) },
    ]
  }

  const openCtxMenu = (e: React.MouseEvent, side: Side, entry: FileEntry | null) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, items: buildMenuItems(side, entry) })
  }

  const clearFileDrag = useCallback(() => {
    dragRef.current = null
    setDragPreview(null)
    setDragOver(null)
    document.body.classList.remove('file-dragging')
  }, [])

  const handleFilePointerDown = useCallback((side: Side, entry: FileEntry, e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, textarea')) return
    e.preventDefault()
    e.stopPropagation()
    const drag: FileDrag = { side, entry, startX: e.clientX, startY: e.clientY, started: false }
    dragRef.current = drag
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (!cur.started) {
        if (Math.abs(ev.clientX - cur.startX) < 5 && Math.abs(ev.clientY - cur.startY) < 5) return
        cur.started = true
        document.body.classList.add('file-dragging')
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const pane = el?.closest<HTMLElement>('[data-fm-side]')?.dataset.fmSide as Side | undefined
      setDragOver(pane ?? null)
      setDragPreview({ side: cur.side, name: cur.entry.name, x: ev.clientX, y: ev.clientY })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      const cur = dragRef.current
      if (!cur) return
      const started = cur.started
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const pane = el?.closest<HTMLElement>('[data-fm-side]')?.dataset.fmSide as Side | undefined
      clearFileDrag()
      if (!started || !pane || pane === cur.side) return
      if (cur.side === 'local' && pane === 'remote') uploadPath(cur.entry.path)
      if (cur.side === 'remote' && pane === 'local') downloadEntry(cur.entry)
    }
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      clearFileDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }, [clearFileDrag, downloadEntry, uploadPath])

  const title = useMemo(() => '文件管理', [])
  const now = Date.now()

  return (
    <div
      className="fm-window"
      onPointerDownCapture={(e) => {
        if (shouldCloseFileMenuFromTarget(e.target as Element | null)) setCtxMenu(null)
      }}
    >
      <div className="fm-window__titlebar" data-tauri-drag-region>
        <div className="fm-window__title"><FolderOpen size={15} />{title}</div>
        <button className="ssh-panel__btn" onClick={() => getCurrentWindow().close()} data-tip="关闭">
          <X size={14} />
        </button>
      </div>

      {error && <div className="panel-error" style={{ margin: 8 }}>{error}</div>}

      <div className="fm-dual">
        <FilePane
          side="local"
          title="本地"
          Icon={Monitor}
          path={localPath}
          entries={localEntries}
          loading={localLoading}
          dragOver={dragOver === 'local'}
          onDrop={handleDrop}
          onRefresh={() => loadLocal(localPath)}
          onUp={() => loadLocal(localParent(localPath))}
          onPath={loadLocal}
          onPickDir={pickLocalDir}
          onOpen={(entry) => entry.isDir && loadLocal(entry.path)}
          onContextMenu={openCtxMenu}
          onDragState={setDragOver}
          onFilePointerDown={handleFilePointerDown}
          onOpenPicker={(anchor) => setPicker({ side: 'local', ...anchor })}
          selectedPath={selectedLocal?.path ?? null}
          onSelect={setSelectedLocal}
        />
        <div className="fm-transfer-column">
          <button
            className="fm-transfer-btn"
            disabled={!selectedLocal}
            onClick={() => selectedLocal && uploadPath(selectedLocal.path)}
            data-tip="传到远程"
          >
            <ArrowRight size={16} />
          </button>
          <button
            className="fm-transfer-btn"
            disabled={!selectedRemote}
            onClick={() => selectedRemote && downloadEntry(selectedRemote)}
            data-tip="传到本地"
          >
            <ArrowLeft size={16} />
          </button>
        </div>
        <FilePane
          side="remote"
          title="远程"
          Icon={Server}
          path={remotePath}
          entries={remoteEntries}
          loading={remoteLoading}
          dragOver={dragOver === 'remote'}
          onDrop={handleDrop}
          onRefresh={() => loadRemote(remotePath)}
          onUp={() => loadRemote(remoteParent(remotePath))}
          onPath={loadRemote}
          onOpen={(entry) => entry.isDir ? loadRemote(entry.path) : undefined}
          onContextMenu={openCtxMenu}
          onDragState={setDragOver}
          onFilePointerDown={handleFilePointerDown}
          onOpenPicker={(anchor) => setPicker({ side: 'remote', ...anchor })}
          selectedPath={selectedRemote?.path ?? null}
          onSelect={setSelectedRemote}
        />
      </div>

      {transfers.length > 0 && (
        <div className="transfer-table fm-transfer-table">
          <div className="transfer-table__head">
            <span>类型</span>
            <span>文件</span>
            <span>进度</span>
            <span>速度</span>
            <span>耗时</span>
            <span>源 / 目标</span>
            <span />
          </div>
          {transfers.map(t => {
            const startedAt = t.startedAt ?? Date.now()
            const endedAt = t.finishedAt ?? now
            const elapsed = Math.max(0, endedAt - startedAt)
            const pct = t.status === 'progress' && t.total && t.total > 0
              ? Math.min(100, Math.floor((t.transferred ?? 0) / t.total * 100))
              : null
            const transferred = t.transferred ?? 0
            const speed = t.status === 'progress'
              ? (elapsed > 0 ? transferred / (elapsed / 1000) : 0)
              : (t.finalSpeed ?? (elapsed > 0 ? transferred / (elapsed / 1000) : 0))
            const speedText = speed > 0 ? `${formatBytes(Math.round(speed))}/s` : '—'
            const timeText = formatTransferElapsed(t.finalElapsed ?? elapsed)
            return (
              <div key={t.id} className={`transfer-table__row transfer-table__row--${t.status}`}>
                <span className={`transfer-table__chip transfer-table__chip--${t.type}`}>{t.type === 'upload' ? '上传' : '下载'}</span>
                <span className="transfer-table__name" title={t.filename}>{t.filename}</span>
                <span className="transfer-table__progress">
                  <span className="transfer-table__msg">
                    {t.status === 'progress'
                      ? `${pct !== null ? `${pct}% · ` : ''}${formatBytes(transferred)} / ${formatBytes(t.total ?? 0)}`
                      : t.message}
                  </span>
                  {t.status === 'progress' && (
                    <div className="transfer-bar">
                      <div
                        className={`transfer-bar__fill${pct === null ? ' transfer-bar__fill--indeterminate' : ''}`}
                        style={pct !== null ? { width: `${pct}%` } : undefined}
                      />
                    </div>
                  )}
                </span>
                <span className="transfer-table__speed">{speedText}</span>
                <span className="transfer-table__time">{timeText}</span>
                <div className="transfer-table__paths">
                  <button className="transfer-table__pathBtn" onClick={() => t.source && copyPath(t.source)} title={t.source ?? '—'}>
                    <span className="transfer-table__pathLabel">源</span>
                    <span className="transfer-table__pathText">{t.source ?? '—'}</span>
                    <Copy size={11} />
                  </button>
                  <button className="transfer-table__pathBtn" onClick={() => t.target && copyPath(t.target)} title={t.target ?? '—'}>
                    <span className="transfer-table__pathLabel">目标</span>
                    <span className="transfer-table__pathText">{t.target ?? '—'}</span>
                    <Copy size={11} />
                  </button>
                </div>
                <button className="transfer-item__close" onClick={() => t.status === 'progress' ? cancelTransfer(t.id) : removeTransfer(t.id)}>
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
      {dragPreview && (
        <div
          className="fm-drag-preview"
          style={{ transform: `translate3d(${dragPreview.x + 12}px, ${dragPreview.y + 12}px, 0)` }}
        >
          {dragPreview.side === 'local' ? <Upload size={12} /> : <Download size={12} />}
          <span>{dragPreview.name}</span>
        </div>
      )}
      {picker && (
        <LocationPickerDropdown
          side={picker.side}
          currentPath={picker.side === 'local' ? localPath : remotePath}
          remoteStartPath={remoteStartPath}
          connId={connId}
          anchor={picker}
          onClose={() => setPicker(null)}
          onConfirm={async (path) => {
            setPicker(null)
            if (picker.side === 'local') await loadLocal(path)
            else await loadRemote(path)
          }}
        />
      )}
      {confirm && (
        <ConfirmActionDialog
          state={confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {inputDialog && (
        <InputActionDialog
          state={inputDialog}
          onClose={() => setInputDialog(null)}
        />
      )}
      {infoEntry && (
        <FileInfoDialog
          side={infoEntry.side}
          entry={infoEntry.entry}
          onClose={() => setInfoEntry(null)}
        />
      )}
    </div>
  )
}

function ConfirmActionDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cdlg-head">
          {state.danger ? <Trash2 size={15} className="cdlg-head__icon cdlg-head__icon--danger" /> : <Info size={15} className="cdlg-head__icon cdlg-head__icon--info" />}
          <span className="cdlg-head__title">{state.title}</span>
        </div>
        <p className="cdlg-desc">{state.desc}</p>
        <div className="cdlg-foot">
          <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>取消</button>
          <button className={`cdlg-btn ${state.danger ? 'cdlg-btn--danger' : 'cdlg-btn--ok'}`} onClick={() => state.onOk()}>
            {state.okText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function InputActionDialog({ state, onClose }: { state: InputState; onClose: () => void }) {
  const [value, setValue] = useState(state.value)
  const [error, setError] = useState('')
  const submit = () => {
    const msg = state.validate?.(value) ?? null
    if (msg) { setError(msg); return }
    state.onOk(value)
  }
  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cdlg-head">
          <Edit3 size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          <span className="cdlg-head__title">{state.title}</span>
        </div>
        {state.desc && <p className="cdlg-desc">{state.desc}</p>}
        <input
          autoFocus
          className="fm-dialog-input"
          value={value}
          placeholder={state.placeholder}
          onChange={(e) => { setValue(e.target.value); if (error) setError('') }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        {error && <div className="fm-dialog-error">{error}</div>}
        <div className="cdlg-foot" style={{ marginTop: 16 }}>
          <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>取消</button>
          <button className="cdlg-btn cdlg-btn--ok" onClick={submit}>{state.okText ?? '确定'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FileInfoDialog({ side, entry, onClose }: { side: Side; entry: FileEntry | null; onClose: () => void }) {
  if (!entry) return null
  const rows = [
    ['位置', side === 'local' ? '本地' : '远程'],
    ['类型', entryKind(entry)],
    ['名称', entry.name],
    ['路径', entry.path],
    ['大小', entry.isDir ? '-' : formatSize(entry.size)],
    ['修改时间', entry.modified || '-'],
    ['权限', entry.permissions || '-'],
  ]
  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box fm-info-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cdlg-head">
          <Info size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          <span className="cdlg-head__title">文件信息</span>
        </div>
        <div className="fm-info-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="fm-info-row">
              <span>{label}</span>
              <strong title={value}>{value}</strong>
            </div>
          ))}
        </div>
        <div className="cdlg-foot" style={{ marginTop: 16 }}>
          <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>关闭</button>
          <button className="cdlg-btn cdlg-btn--ok" onClick={() => navigator.clipboard.writeText(entry.path).catch(() => {})}>复制路径</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FilePane({ side, title, Icon, path, entries, loading, dragOver, onDrop, onRefresh, onUp, onPath, onPickDir, onOpen, onDragState, onContextMenu, onFilePointerDown, onOpenPicker, selectedPath, onSelect }: {
  side: Side
  title: string
  Icon: LucideIcon
  path: string
  entries: FileEntry[]
  loading: boolean
  dragOver: boolean
  onDrop: (side: Side, e: React.DragEvent) => void
  onRefresh: () => void
  onUp: () => void
  onPath: (path: string) => void
  onPickDir?: () => void
  onOpen: (entry: FileEntry) => void
  onDragState: (side: Side | null) => void
  onContextMenu: (e: React.MouseEvent, side: Side, entry: FileEntry | null) => void
  onFilePointerDown: (side: Side, entry: FileEntry, e: React.PointerEvent) => void
  onOpenPicker: (anchor: { left: number; top: number; width: number }) => void
  selectedPath: string | null
  onSelect: (entry: FileEntry) => void
}) {
  const [pathDraft, setPathDraft] = useState(path)
  useEffect(() => setPathDraft(path), [path])

  return (
    <section
      className={`fm-pane${dragOver ? ' fm-pane--drag' : ''}`}
      data-fm-side={side}
      onDragEnter={(e) => { e.preventDefault(); onDragState(side) }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; onDragState(side) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragState(null) }}
      onDrop={(e) => onDrop(side, e)}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.file-row')) return
        onContextMenu(e, side, null)
      }}
    >
      <div className="fm-pane__header">
        <div className="fm-pane__title"><Icon size={14} />{title}</div>
        <div className="fm-pane__actions">
          {onPickDir && <button className="ssh-panel__btn" onClick={onPickDir} data-tip="选择本地目录"><FolderOpen size={13} /></button>}
          <button className="ssh-panel__btn" onClick={onRefresh} data-tip="刷新"><RefreshCw size={13} /></button>
        </div>
      </div>
      <div className="fm-pathbar">
        <button className="file-nav-btn" onClick={onUp} data-tip="上级目录"><ArrowLeft size={12} /></button>
        <input
          className="file-path-input"
          value={pathDraft}
          onChange={e => setPathDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onPath(pathDraft.trim() || (side === 'remote' ? '/' : path))
            if (e.key === 'Escape') setPathDraft(path)
          }}
          onBlur={() => setPathDraft(path)}
        />
        <button className="file-nav-btn fm-path-menu-btn" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onOpenPicker({ left: r.left, top: r.bottom + 8, width: r.width })
        }} data-tip="选择目录">
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="ssh-panel__body fm-pane__body">
        {dragOver && <div className="file-drop-overlay"><Upload size={20} /><span>{side === 'remote' ? '松开上传到远程目录' : '松开下载到本地目录'}</span><small>{path}</small></div>}
        {loading ? (
          <div className="panel-loading"><Loader2 size={20} className="spin" /></div>
        ) : (
          <div className="file-list">
            <div className="file-list-header">
              <span className="file-list-header__icon" />
              <span className="file-list-header__name">名称</span>
              <span className="file-list-header__size">大小</span>
              <span className="file-list-header__date">修改时间</span>
            </div>
            {entries.length === 0 && <div className="fm-empty">目录为空</div>}
            {entries.map(entry => (
              <div
                key={entry.path}
                className={`file-row${selectedPath === entry.path ? ' file-row--selected' : ''}`}
                onPointerDown={(e) => {
                  onSelect(entry)
                  onFilePointerDown(side, entry, e)
                }}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => onContextMenu(e, side, entry)}
              >
                <span className="file-row__icon">
                  {entry.isDir ? <Folder size={14} /> : <File size={14} />}
                </span>
                <span className="file-row__name" title={entry.name}>{entry.name}</span>
                <span className="file-row__size">{entry.isDir ? '-' : formatSize(entry.size)}</span>
                <span className="file-row__date">{entry.modified?.slice(5) || '-'}</span>
                {entry.isDir && <ChevronRight size={11} className="fm-row-chev" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function LocationPickerDropdown({ side, currentPath, remoteStartPath, connId, anchor, onClose, onConfirm }: {
  side: Side
  currentPath: string
  remoteStartPath: string
  connId: string
  anchor: { left: number; top: number; width: number }
  onClose: () => void
  onConfirm: (path: string) => void | Promise<void>
}) {
  const [path, setPath] = useState(currentPath || (side === 'remote' ? '/' : '/'))
  const [input, setInput] = useState(path)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [nodes, setNodes] = useState<Record<string, { loading: boolean; entries: FileEntry[] }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const loadChildren = useCallback(async (nextPath: string) => {
    if (nodes[nextPath]?.loading) return
    if (nodes[nextPath]?.entries) return
    setNodes(prev => ({ ...prev, [nextPath]: { loading: true, entries: prev[nextPath]?.entries ?? [] } }))
    try {
      const list = side === 'local'
        ? await invoke<FileEntry[]>('list_local_files', { path: nextPath })
        : await invoke<FileEntry[]>('list_files', { id: connId, path: nextPath })
      setNodes(prev => ({ ...prev, [nextPath]: { loading: false, entries: list.filter(e => e.isDir) } }))
    } catch (e) {
      setNodes(prev => ({ ...prev, [nextPath]: { loading: false, entries: [] } }))
      setError(String(e))
    }
  }, [connId, nodes, side])

  const load = useCallback(async (nextPath: string) => {
    setLoading(true)
    setError('')
    try {
      const list = side === 'local'
        ? await invoke<FileEntry[]>('list_local_files', { path: nextPath })
        : await invoke<FileEntry[]>('list_files', { id: connId, path: nextPath })
      setPath(nextPath)
      setInput(nextPath)
      setExpanded({ [nextPath]: true })
      setNodes({ [nextPath]: { loading: false, entries: list.filter(e => e.isDir) } })
    } catch (e) {
      setError(String(e))
      setNodes({})
    } finally {
      setLoading(false)
    }
  }, [connId, side])

  useEffect(() => {
    load(path)
    setTimeout(() => inputRef.current?.focus(), 40)
  }, [])

  const goUp = () => load(side === 'local' ? localParent(path) : remoteParent(path))
  const goRoot = () => load(side === 'local' ? localRoot(path) : '/')
  const goDefault = () => {
    if (side === 'local') {
      const home = localHome(path)
      if (home) load(home)
    } else {
      load(remoteStartPath || '/')
    }
  }

  const renderNode = (nodePath: string, depth: number): React.ReactNode => {
    const node = nodes[nodePath]
    const childEntries = node?.entries ?? []
    return (
      <div key={nodePath}>
        <button
          className={`fm-tree__row${input === nodePath ? ' fm-tree__row--active' : ''}`}
          style={{ paddingLeft: 10 + depth * 16 }}
          onClick={() => setInput(nodePath)}
          onDoubleClick={() => load(nodePath)}
        >
          <span className="fm-tree__chev" onClick={(e) => {
            e.stopPropagation()
            setExpanded(prev => {
              const next = !prev[nodePath]
              if (next) loadChildren(nodePath)
              return { ...prev, [nodePath]: next }
            })
          }}>
            {node?.loading ? <Loader2 size={12} className="spin" /> : (expanded[nodePath] ? <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} /> : <ChevronRight size={12} />)}
          </span>
          <Folder size={14} />
          <span className="fm-tree__name">{nodePath === path ? '当前目录' : nodePath.split('/').filter(Boolean).pop() || nodePath}</span>
          <span className="fm-tree__path">{nodePath}</span>
        </button>
        {expanded[nodePath] && childEntries.map(child => renderNode(child.path, depth + 1))}
      </div>
    )
  }

  return createPortal(
    <div
      className="fm-picker-popover"
      style={{ left: Math.max(12, Math.min(anchor.left, window.innerWidth - 560)), top: anchor.top, width: 560 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="fm-picker__header">
        <div className="fm-picker__title">
          {side === 'local' ? <Monitor size={15} /> : <Server size={15} />}
          选择{side === 'local' ? '本地' : '远程'}目录
        </div>
        <button className="ssh-panel__btn" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="fm-picker__path">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load(input.trim() || (side === 'remote' ? '/' : path))
            if (e.key === 'Escape') onClose()
          }}
        />
        <button className="fm-picker__btn" onClick={() => load(input.trim() || path)}>定位</button>
      </div>
      <div className="fm-picker__toolbar">
        <button onClick={goUp}><ArrowLeft size={13} />上级</button>
        <button onClick={goDefault}><Home size={13} />{side === 'local' ? '用户目录' : '默认目录'}</button>
        <button onClick={goRoot}><FolderOpen size={13} />根目录</button>
        <button onClick={() => load(path)}><RefreshCw size={13} />刷新</button>
      </div>
      <div className="fm-picker__body">
        {error && <div className="panel-error" style={{ margin: 8 }}>{error}</div>}
        {loading ? (
          <div className="panel-loading"><Loader2 size={18} className="spin" /></div>
        ) : (
          <div className="fm-tree">
            {renderNode(path, 0)}
          </div>
        )}
      </div>
      <div className="fm-picker__footer">
        <div className="fm-picker__selected">{input}</div>
        <button className="cdlg-btn cdlg-btn--cancel" onClick={onClose}>取消</button>
        <button className="cdlg-btn cdlg-btn--ok" onClick={() => onConfirm(input.trim() || path)}>确定</button>
      </div>
    </div>,
    document.body,
  )
}
