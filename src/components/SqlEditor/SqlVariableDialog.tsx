import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, X } from 'lucide-react'
import type { ConnType } from '../../types'
import { applySqlVariables, inferSqlVariableMode, type SqlVariableMode } from './sqlVariables'

export interface SqlVariable {
  name: string
  from: number
  to: number
}

interface Props {
  sql: string
  variables: SqlVariable[]
  connType: ConnType
  onCancel: () => void
  onRun: (values: Record<string, string>, modes?: Record<string, SqlVariableMode>) => void
}

export default function SqlVariableDialog({ sql, variables, connType, onCancel, onRun }: Props) {
  const names = useMemo(() => Array.from(new Set(variables.map(v => v.name))), [variables])
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(names.map(n => [n, ''])))
  const [modes, setModes] = useState<Record<string, SqlVariableMode>>(
    () => Object.fromEntries(names.map(n => [n, inferSqlVariableMode(n)])),
  )
  const previewSql = useMemo(
    () => applySqlVariables(sql, variables, values, modes, connType),
    [sql, variables, values, modes, connType],
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
          <div className="sql-var-dialog__hint">
            执行前替换变量，支持 <code>:name</code>、<code>#&#123;name&#125;</code>、<code>$&#123;name&#125;</code>、<code>@&#123;name&#125;</code>、<code>&#123;&#123;name&#125;&#125;</code>、<code>?&#123;name&#125;</code>。默认按文本加引号；日期选「日期」；数字、函数或完整 SQL 选「表达式」。
          </div>
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
                <select
                  className="sql-var-dialog__mode-select"
                  value={modes[name] ?? 'literal'}
                  title="选择变量替换方式"
                  onChange={e => setModes(v => ({ ...v, [name]: e.target.value as SqlVariableMode }))}
                >
                  <option value="literal">文本</option>
                  <option value="date">日期</option>
                  <option value="raw">表达式</option>
                </select>
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
