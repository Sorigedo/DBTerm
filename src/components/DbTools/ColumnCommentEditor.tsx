import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Expand, X } from 'lucide-react'
import './ColumnCommentEditor.css'

export default function ColumnCommentEditor({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (draft !== null) textarea.current?.focus() }, [draft === null])
  const close = () => { setDraft(null); opener.current?.focus() }
  const open = (target: HTMLElement) => { opener.current = target; setDraft(value) }
  return <>
    <div className="ctw-comment-cell">
      <input aria-label={name + ' 注释'} title={value} value={value} placeholder="—" autoComplete="off" spellCheck={false}
        onChange={e => onChange(e.target.value)} onDoubleClick={e => open(e.currentTarget)} />
      <button type="button" className="ctw-comment-expand" title="展开编辑注释" aria-label={'编辑 ' + name + ' 的注释'} onClick={e => open(e.currentTarget)}><Expand size={13} /></button>
    </div>
    {draft !== null && createPortal(<div className="ctw-comment-overlay" onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) close() }} onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); close() }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onChange(draft); close() }
      if (e.key === 'Tab') {
        const elements = dialog.current?.querySelectorAll<HTMLElement>('button, textarea')
        if (!elements?.length) return
        const first = elements[0], last = elements[elements.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }}>
      <div className="ctw-comment-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={'编辑注释：' + name}>
        <header><strong>编辑注释：{name || '未命名字段'}</strong><button type="button" aria-label="关闭注释编辑" onClick={close}><X size={16} /></button></header>
        <textarea ref={textarea} aria-label="完整注释" value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} placeholder="输入完整注释，支持换行" />
        <p>{Array.from(draft).length} 字符</p>
        <footer><button type="button" className="dbtool-btn dbtool-btn--cancel" onClick={close}>取消</button><button type="button" className="dbtool-btn dbtool-btn--primary" onClick={() => { onChange(draft); close() }}>确认</button></footer>
      </div>
    </div>, document.body)}
  </>
}
