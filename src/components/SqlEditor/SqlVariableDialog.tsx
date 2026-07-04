import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, X } from 'lucide-react'

export interface SqlVariable {
  name: string
  from: number
  to: number
}

interface Props {
  sql: string
  variables: SqlVariable[]
  onCancel: () => void
  onRun: (values: Record<string, string>) => void
}

export default function SqlVariableDialog({ sql, variables, onCancel, onRun }: Props) {
  const names = useMemo(() => Array.from(new Set(variables.map(v => v.name))), [variables])
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map(n => [n, ''])))

  const submit = () => onRun(values)

  return createPortal(
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-box sql-var-dialog" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Braces size={16} color="var(--accent)" />填写 SQL 变量
          </span>
          <button className="modal-close" onClick={onCancel}><X size={15} /></button>
        </div>
        <div className="modal-body sql-var-dialog__body">
          <div className="sql-var-dialog__hint">在 SQL 中使用 <code>:name</code> 作为变量占位；执行前填写变量值。普通输入会按 SQL 字符串处理，输入 <code>null</code> 或 <code>NULL</code> 会作为 SQL NULL。</div>
          <div className="sql-var-dialog__list">
            {names.map((name, i) => (
              <label className="sql-var-dialog__row" key={name}>
                <span>:{name}</span>
                <input
                  className="dbtool-input"
                  autoFocus={i === 0}
                  value={values[name] ?? ''}
                  onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
                    if (e.key === 'Escape') onCancel()
                  }}
                />
              </label>
            ))}
          </div>
          <pre className="sql-var-dialog__preview">{sql.slice(0, 1000)}{sql.length > 1000 ? '\n...' : ''}</pre>
        </div>
        <div className="modal-footer cf-footer">
          <div className="cf-footer-actions">
            <div />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-cancel" onClick={onCancel}>取消</button>
              <button className="btn-primary" onClick={submit}>执行</button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
