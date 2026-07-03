import { useState } from 'react'
import { AlertCircle, Copy, Check, X } from 'lucide-react'
import { useDbErrorStore } from '../stores/dbErrorStore'
import { copyText } from '../utils/clipboard'

// 全局数据库错误条：常驻底部，可复制，仅手动关闭。
export default function DbErrorBar() {
  const error = useDbErrorStore(s => s.error)
  const clear = useDbErrorStore(s => s.clear)
  const [copied, setCopied] = useState(false)
  if (!error) return null

  const full = `${error.source ? error.source + '：' : ''}${error.message}`
  return (
    <div className="db-error-bar" role="alert">
      <AlertCircle size={15} strokeWidth={2} className="db-error-bar__icon" />
      <div className="db-error-bar__body">
        {error.source && <span className="db-error-bar__source">{error.source}</span>}
        <span className="db-error-bar__msg" title={error.message}>{error.message}</span>
      </div>
      <button
        className="db-error-bar__btn"
        data-tip={copied ? '已复制' : '复制错误信息'}
        onClick={async () => { await copyText(full); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      >
        {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
      </button>
      <button className="db-error-bar__btn db-error-bar__btn--close" data-tip="关闭" onClick={clear}>
        <X size={14} strokeWidth={2.2} />
      </button>
    </div>
  )
}
