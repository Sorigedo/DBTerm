import { useState, useCallback, useMemo } from 'react'
import { Search, Trash2, Copy, X, Plus, Terminal, Download, Pin, PinOff } from 'lucide-react'
import { useCommandHistoryStore } from '../../stores/commandHistoryStore'
import { useAppStore } from '../../stores/appStore'
import ConfirmDialog from '../shared/ConfirmDialog'

interface Props {
  sessionId: string
  onClose: () => void
  onRunCommand?: (cmd: string) => void
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const date = sameYear
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function CommandHistoryPanel({ sessionId, onClose, onRunCommand }: Props) {
  const allCommands = useCommandHistoryStore((s) => s.commands)
  const { removeCommand, clearConn, addCommand, togglePin } = useCommandHistoryStore()
  const connections = useAppStore((s) => s.connections)
  const [search, setSearch] = useState('')
  const [newCmd, setNewCmd] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [exported, setExported] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  // 严格按连接隔离：只显示当前连接的历史
  const commands = useMemo(
    () => allCommands.filter((c) => c.connId === sessionId),
    [allCommands, sessionId]
  )

  // 置顶在前；同组内按执行时间倒序，避免新命令被旧记录压到下面看不到。
  const filtered = useMemo(() => {
    const match = (c: typeof commands[number]) =>
      !search || c.command.toLowerCase().includes(search.toLowerCase())
        || c.label.toLowerCase().includes(search.toLowerCase())
    const hit = commands.filter(match)
    const byTimeDesc = (a: typeof commands[number], b: typeof commands[number]) => b.addedAt - a.addedAt
    return [
      ...hit.filter((c) => c.pinned).sort(byTimeDesc),
      ...hit.filter((c) => !c.pinned).sort(byTimeDesc),
    ]
  }, [commands, search])

  const copyCmd = useCallback(async (cmd: string, id: string) => {
    await navigator.clipboard.writeText(cmd)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }, [])

  const exportHistory = useCallback(async () => {
    if (commands.length === 0) return
    const conn = connections.find((c) => c.id === sessionId)
    const connName = conn?.name ?? sessionId
    const lines = commands
      .slice()
      .reverse()
      .map((c) => {
        const d = new Date(c.addedAt)
        const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
        return `[${ts}] ${c.command}`
      })
    const content = `# ${connName} 命令历史（共 ${commands.length} 条）\n\n${lines.join('\n')}\n`
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: `${connName}-命令历史.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      })
      if (!path) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('write_local_file', { path, content })
      setExported(true)
      setTimeout(() => setExported(false), 1500)
    } catch { /* 用户取消或非 Tauri 环境 */ }
  }, [commands, connections, sessionId])

  const addManual = () => {
    if (!newCmd.trim()) return
    // 手动添加的视为常用命令，自动置顶
    addCommand(newCmd.trim(), sessionId, undefined, true)
    setNewCmd('')
  }

  return (
    <div className="ssh-panel">
      <div className="ssh-panel__header">
        <span className="ssh-panel__title">
          <Terminal size={13} strokeWidth={1.8} />
          命令历史
          {commands.length > 0 && <span className="ssh-panel__count">{commands.length}</span>}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {commands.length > 0 && (
            <>
              <button
                className={`ssh-panel__btn${exported ? ' ok' : ''}`}
                onClick={exportHistory}
                title={exported ? '已导出' : '导出到本地文件'}
              >
                <Download size={13} strokeWidth={2} />
              </button>
              <button
                className="ssh-panel__btn"
                onClick={() => setConfirmClear(true)}
                title="清空当前连接历史"
              >
                <Trash2 size={13} strokeWidth={2} />
              </button>
            </>
          )}
          <button className="ssh-panel__btn" onClick={onClose} data-tip="关闭">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="cmd-add-row">
        <input
          className="cmd-add-input"
          placeholder="添加常用命令…"
          value={newCmd}
          onChange={(e) => setNewCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addManual() }}
        />
        <button className="cmd-add-btn" onClick={addManual} data-tip="添加">
          <Plus size={13} strokeWidth={2.5} />
        </button>
      </div>

      <div className="cmd-search-row">
        <Search size={12} strokeWidth={2} className="cmd-search-icon" />
        <input
          className="cmd-search-input"
          placeholder="搜索命令…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="ssh-panel__body">
        {filtered.length === 0 && (
          <div className="panel-empty">
            {commands.length === 0
              ? '执行命令后将记录，也可手动添加常用命令'
              : '没有匹配的命令'
            }
          </div>
        )}

        {filtered.map((c) => (
          <div key={c.id} className={`cmd-row${c.pinned ? ' cmd-row--pinned' : ''}`}>
            <div className="cmd-row__main">
              <div className="cmd-row__text">
                <span className="cmd-row__label" title={c.command}>
                  {c.pinned && <Pin size={10} className="cmd-row__pin-icon" />}
                  {c.label}
                </span>
              </div>
              <div className="cmd-row__meta">
                <span className="cmd-row__time">{fmtTime(c.addedAt)}</span>
                <div className="cmd-row__actions">
                  <button
                    className={`cmd-act-btn${c.pinned ? ' pinned' : ''}`}
                    onClick={() => togglePin(c.id)}
                    title={c.pinned ? '取消置顶' : '置顶为常用命令'}
                  >
                    {c.pinned ? <PinOff size={11} strokeWidth={2} /> : <Pin size={11} strokeWidth={2} />}
                  </button>
                  {onRunCommand && (
                    <button
                      className="cmd-act-btn"
                      onClick={() => onRunCommand(c.command)}
                      title="发送到终端"
                    >
                      <Terminal size={11} strokeWidth={2} />
                    </button>
                  )}
                <button
                  className={`cmd-act-btn${copied === c.id ? ' copied' : ''}`}
                  onClick={() => copyCmd(c.command, c.id)}
                  title={copied === c.id ? '已复制' : '复制'}
                >
                  <Copy size={11} strokeWidth={2} />
                </button>
                  <button
                    className="cmd-act-btn danger"
                    onClick={() => removeCommand(c.id)}
                    title="删除"
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="清空命令历史"
        desc={`确认清空当前连接的全部 ${commands.length} 条命令历史？该操作无法撤销。`}
        danger
        okText="清空"
        onOk={() => { clearConn(sessionId); setConfirmClear(false) }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
