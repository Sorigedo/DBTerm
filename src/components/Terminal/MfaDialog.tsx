import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck } from 'lucide-react'

export interface MfaRequest {
  requestId: string
  name: string
  instruction: string
  prompts: { prompt: string; echo: boolean }[]
}

interface Props {
  req: MfaRequest
  host?: string
  onSubmit: (answers: string[]) => void
  onCancel: () => void
}

/** SSH keyboard-interactive 多因素认证弹窗：服务器下发什么提示就展示什么 */
export default function MfaDialog({ req, host, onSubmit, onCancel }: Props) {
  const [answers, setAnswers] = useState<string[]>(() => req.prompts.map(() => ''))
  const firstRef = useRef<HTMLInputElement>(null)

  // 新一轮提示到达（requestId 变化）时重置输入
  useEffect(() => {
    setAnswers(req.prompts.map(() => ''))
    setTimeout(() => firstRef.current?.focus(), 30)
  }, [req.requestId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = () => onSubmit(answers)

  return createPortal(
    <div className="cdlg-overlay">
      <div className="cdlg-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cdlg-head">
          <ShieldCheck size={15} className="cdlg-head__icon cdlg-head__icon--info" />
          <span className="cdlg-head__title">{req.name || '多因素认证'}</span>
        </div>

        {host && <span className="mfa-host">{host}</span>}
        <p className="cdlg-desc">
          {req.instruction || '服务器要求额外验证，请按提示输入。'}
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); submit() }}
        >
          {req.prompts.map((p, i) => (
            <div className="mfa-field" key={`${req.requestId}-${i}`}>
              <label>{p.prompt}</label>
              <input
                ref={i === 0 ? firstRef : undefined}
                type={p.echo ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={answers[i] ?? ''}
                onChange={(e) => {
                  const next = [...answers]
                  next[i] = e.target.value
                  setAnswers(next)
                }}
              />
            </div>
          ))}

          <div className="cdlg-foot">
            <button type="button" className="cdlg-btn cdlg-btn--cancel" onClick={onCancel}>取消</button>
            <button type="submit" className="cdlg-btn cdlg-btn--ok">验证</button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
