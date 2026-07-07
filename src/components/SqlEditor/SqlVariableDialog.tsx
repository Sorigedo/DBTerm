import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, X } from 'lucide-react'
import { applySqlVariables, type SqlVariableMode } from './sqlVariables'

export interface SqlVariable {
  name: string
  from: number
  to: number
}

interface Props {
  sql: string
  variables: SqlVariable[]
  onCancel: () => void
  onRun: (values: Record<string, string>, modes?: Record<string, SqlVariableMode>) => void
}

export default function SqlVariableDialog({ sql, variables, onCancel, onRun }: Props) {
  const names = useMemo(() => Array.from(new Set(variables.map(v => v.name))), [variables])
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map(n => [n, ''])))
  const [modes, setModes] = useState<Record<string, SqlVariableMode>>({})
  const previewSql = useMemo(
    () => applySqlVariables(sql, variables, values, modes),
    [sql, variables, values, modes],
  )

  const submit = () => onRun(values, modes)

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
          <div className="sql-var-dialog__hint">这是 DBTerm 执行前替换，SQL 类数据库都可用，最终语法由当前数据库解释。在 SQL 中使用 <code>:name</code> 作为变量占位；默认按文本安全替换，输入 <code>null</code> 或 <code>NULL</code> 会作为 SQL NULL。需要数字、函数或完整 SQL 表达式时，打开「表达式」。</div>
          <div className="sql-var-dialog__list">
            {names.map((name, i) => (
              <div className="sql-var-dialog__row" key={name}>
                <label htmlFor={`sql-var-${name}`}>:{name}</label>
                <input
                  id={`sql-var-${name}`}
                  className="dbtool-input"
                  autoFocus={i === 0}
                  value={values[name] ?? ''}
                  onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
                    if (e.key === 'Escape') onCancel()
                  }}
                />
                <label className="sql-var-dialog__mode" title="开启后该值不加引号，按 SQL 表达式原样替换">
                  <input
                    type="checkbox"
                    checked={(modes[name] ?? 'literal') === 'raw'}
                    onChange={e => setModes(v => ({ ...v, [name]: e.target.checked ? 'raw' : 'literal' }))}
                  />
                  表达式
                </label>
              </div>
            ))}
          </div>
          <div className="sql-var-dialog__preview-head">将执行的 SQL</div>
          <pre className="sql-var-dialog__preview">{previewSql.slice(0, 4000)}{previewSql.length > 4000 ? '\n...' : ''}</pre>
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
