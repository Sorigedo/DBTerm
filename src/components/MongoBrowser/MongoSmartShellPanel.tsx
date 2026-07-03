// MO5.3 Mongo Shell 命令补全（独立面板，CodeMirror autocompletion）
//
// 设计：与现有「简易 Shell（runCommand）」完全独立、互不影响。
// 本面板提供带自动补全的命令编辑器：补全集合名（动态缓存）、字段名（采样缓存）、
// runCommand 命令键与查询/聚合操作符。执行复用既有后端 mongo_run_command。
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import CodeMirror from '@uiw/react-codemirror'
import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { X, Sparkles, Loader2, Play } from 'lucide-react'

interface Props {
  connectionId: string
  db: string
  coll?: string
  onClose: () => void
}

// runCommand 常用命令键
const COMMANDS = [
  'find', 'aggregate', 'count', 'distinct', 'insert', 'update', 'delete',
  'findAndModify', 'createIndexes', 'listIndexes', 'dropIndexes', 'collStats',
  'dbStats', 'serverStatus', 'ping', 'listCollections', 'create', 'drop',
  'renameCollection', 'getMore', 'explain', 'validate', 'compact',
]
// 查询 / 更新 / 聚合操作符
const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$expr',
  '$mod', '$all', '$elemMatch', '$size', '$text', '$where',
  '$set', '$unset', '$inc', '$mul', '$rename', '$min', '$max', '$currentDate',
  '$push', '$pull', '$pullAll', '$addToSet', '$pop', '$each', '$position',
  '$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind',
  '$lookup', '$count', '$facet', '$bucket', '$addFields', '$replaceRoot',
  '$sum', '$avg', '$first', '$last', '$min', '$max', '$push',
]

const DANGER_KEYS = ['delete', 'drop', 'dropDatabase', 'dropIndexes', 'renameCollection', 'compact']

export default function MongoSmartShellPanel({ connectionId, db, coll, onClose }: Props) {
  const [dbName, setDbName] = useState(db || 'admin')
  const [code, setCode] = useState(coll ? `{ "find": "${coll}", "filter": {}, "limit": 20 }` : '{ "ping": 1 }')
  const [output, setOutput] = useState('')
  const [isError, setIsError] = useState(false)
  const [running, setRunning] = useState(false)
  const [colls, setColls] = useState<string[]>([])
  const [fields, setFields] = useState<string[]>([])
  const [confirm, setConfirm] = useState<string | null>(null)

  // 动态缓存：集合名（按当前 dbName）
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string }[]>('mongo_list_collections', { id: connectionId, db: dbName })
        if (alive) setColls(list.map(c => c.name))
      } catch { /* 补全可降级，忽略 */ }
    })()
    return () => { alive = false }
  }, [connectionId, dbName])

  // 动态缓存：字段名（采样当前集合）
  useEffect(() => {
    if (!coll) return
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const fs = await invoke<string[]>('mongo_sample_fields', { id: connectionId, db: dbName, coll, sampleSize: 50 })
        if (alive) setFields(fs)
      } catch { /* 忽略 */ }
    })()
    return () => { alive = false }
  }, [connectionId, dbName, coll])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirm) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, confirm])

  // 自定义补全源
  const completionExt = useMemo(() => {
    const source = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/[\w$]+/)
      if (!word || (word.from === word.to && !ctx.explicit)) return null
      const options: Completion[] = [
        ...COMMANDS.map(c => ({ label: c, type: 'keyword', detail: '命令' })),
        ...OPERATORS.map(o => ({ label: o, type: 'function', detail: '操作符' })),
        ...colls.map(c => ({ label: c, type: 'class', detail: '集合' })),
        ...fields.map(f => ({ label: f, type: 'property', detail: '字段' })),
      ]
      // 去重（操作符列表里有重复 $min/$max/$push）
      const seen = new Set<string>()
      const uniq = options.filter(o => (seen.has(o.label) ? false : (seen.add(o.label), true)))
      return { from: word.from, options: uniq }
    }
    return autocompletion({ override: [source], activateOnTyping: true })
  }, [colls, fields])

  const doRun = useCallback(async (cmdJson: string) => {
    setRunning(true); setIsError(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<string>('mongo_run_command', { id: connectionId, dbName, cmdJson })
      try { setOutput(JSON.stringify(JSON.parse(result), null, 2)) }
      catch { setOutput(result) }
      setIsError(false)
    } catch (e) { setOutput(String(e)); setIsError(true) }
    finally { setRunning(false) }
  }, [connectionId, dbName])

  const run = () => {
    const cmd = code.trim()
    if (!cmd) return
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(cmd) } catch {
      setOutput('命令必须是有效的 JSON 文档，如 {"ping": 1}'); setIsError(true); return
    }
    const firstKey = Object.keys(parsed)[0] ?? ''
    if (DANGER_KEYS.includes(firstKey)) { setConfirm(cmd); return }
    void doRun(cmd)
  }

  return createPortal(
    <div className="cdlg-overlay" onMouseDown={onClose}>
      <div className="cdlg-box" onMouseDown={e => e.stopPropagation()}
        style={{ width: 720, maxHeight: '84vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Sparkles size={15} color="var(--accent)" />
          <span style={{ fontWeight: 600, color: 'var(--text-bright)', fontSize: 14 }}>智能 Shell（runCommand · 自动补全）</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', color: 'var(--text-muted)', lineHeight: 0 }}><X size={15} /></button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>数据库</span>
            <input value={dbName} onChange={e => setDbName(e.target.value)}
              style={{ width: 180, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              补全：命令 / 操作符 / {colls.length} 集合{fields.length ? ` / ${fields.length} 字段` : ''}（Ctrl+Space 触发）
            </span>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <CodeMirror
              value={code}
              height="160px"
              theme={oneDark}
              extensions={[completionExt, EditorView.lineWrapping]}
              onChange={setCode}
              basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={run} disabled={running}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
              {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 执行
            </button>
          </div>

          {output && (
            <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: isError ? 'var(--error)' : 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflow: 'auto' }}>
              {output}
            </pre>
          )}
        </div>

        {confirm && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseDown={() => setConfirm(null)}>
            <div onMouseDown={e => e.stopPropagation()}
              style={{ width: 380, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)', marginBottom: 8 }}>危险命令确认</div>
              <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 14, lineHeight: 1.6 }}>
                该命令为破坏性操作，执行后数据可能无法恢复，确认执行？
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setConfirm(null)}
                  style={{ padding: '5px 14px', fontSize: 12, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer' }}>取消</button>
                <button onClick={() => { const c = confirm; setConfirm(null); void doRun(c) }}
                  style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>确认执行</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
