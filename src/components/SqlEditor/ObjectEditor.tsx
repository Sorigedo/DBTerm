import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql, StandardSQL, MySQL, MariaSQL, PostgreSQL, SQLite, MSSQL } from '@codemirror/lang-sql'
import { EditorView } from '@codemirror/view'
import { createPortal } from 'react-dom'

const _editorDark = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(100,145,255,0.28) !important' },
  '.cm-activeLine': { background: 'rgba(255,255,255,0.04)' },
  '.cm-activeLineGutter': { background: 'rgba(255,255,255,0.04)' },
  '.cm-gutters': { background: 'var(--surface)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-gutter .cm-gutterElement': { padding: '0 8px' },
}, { dark: true })

const _editorLight = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(80,130,240,0.22) !important' },
  '.cm-activeLine': { background: 'rgba(0,0,0,0.035)' },
  '.cm-activeLineGutter': { background: 'rgba(0,0,0,0.035)' },
  '.cm-gutters': { background: 'var(--surface)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-gutter .cm-gutterElement': { padding: '0 8px' },
}, { dark: false })
import { Save, AlignLeft, Loader2, Database, ChevronRight, Play, X, ChevronUp, ChevronDown, FileCode2 } from 'lucide-react'
import type { ConnType } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAppStore } from '../../stores/appStore'
import { useObjectDraftStore, type ObjType } from '../../stores/objectDraftStore'
import { requireProdConfirm } from '../../stores/confirmStore'
import EnvWatermark from '../common/EnvWatermark'
import { notifySchemaChanged } from '../../utils/schemaRefresh'
import { qid } from '../../utils/objectEditor'
import { tableRef, dialectFamily } from '../../utils/sqlDialect'
import { sqlHighlight } from '../../utils/sqlHighlight'
import { isModEvent, modLabel, matchShortcut, displayShortcutStr, SHORTCUT_DEFS } from '../../utils/shortcuts'
import { registerObjectSave, unregisterObjectSave } from '../../utils/objectSaveRegistry'
import { toast } from '../../stores/toastStore'
import SearchableSelect from '../DbTools/SearchableSelect'
import ResultTable from './ResultTable'
import TablePeekModal from './TablePeekModal'
import { useWheelScroll, cmScroller } from '../../utils/wheelScroll'
import { makeTableLinkExtensions } from '../../utils/cmTableLink'
import { cmSearchPhrases } from '../../utils/cmSearchPhrases'

interface Props {
  tabId: string
  connectionId: string
  connType: ConnType
}

/** 把常见的 MySQL 函数/存储程序报错翻译成可操作的中文提示 */
function friendlyDbError(raw: string): string {
  if (/\b1418\b/.test(raw)) {
    return '函数缺少特性声明：本服务器开启了二进制日志(binlog)，函数必须在 RETURNS 行后声明 '
      + 'DETERMINISTIC、NO SQL 或 READS SQL DATA 之一。\n'
      + '· 函数会读取表数据 → 追加 READS SQL DATA\n'
      + '· 纯计算、不读写数据 → 用 DETERMINISTIC\n'
      + '例如把 “NOT DETERMINISTIC” 改为 “DETERMINISTIC”，或在其后另起一行写 “READS SQL DATA”。'
  }
  if (/\b1419\b/.test(raw)) {
    return '没有 SUPER 权限且 binlog 已开启，无法创建函数。请用更高权限账号，或为函数声明 '
      + 'DETERMINISTIC / NO SQL / READS SQL DATA 特性。'
  }
  if (/\b1304\b/.test(raw)) return '同名函数/存储过程已存在。编辑时请先 DROP 再创建，或改用其它名称。'
  return raw
}

const OBJ_LABEL: Record<ObjType, string> = { view: '视图', function: '函数', procedure: '存储过程' }

export default function ObjectEditor({ tabId, connectionId, connType }: Props) {
  const draft = useObjectDraftStore((s) => s.drafts[tabId])
  const appColorScheme = useSettingsStore((s) => s.appColorScheme)
  const connections = useAppStore((s) => s.connections)
  const envConn = connections.find((c) => c.id === connectionId)
  const connName = envConn?.name ?? connectionId
  const isDark = appColorScheme === 'dark'
    || (appColorScheme === 'system' && typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  const setTabDirty = useAppStore((s) => s.setTabDirty)
  const [ddl, setDdl] = useState(draft?.ddl ?? '')
  const [saving, setSaving] = useState(false)
  const [schemas, setSchemas] = useState<string[]>([])
  const [currentSchema, setCurrentSchema] = useState(draft?.schema ?? '')
  const preFormatRef = useRef<string | null>(null)
  // 代码区滚轮驱动横向滚动条：统一规则（见 utils/wheelScroll）；getScroller 取 CodeMirror 的 .cm-scroller
  const cmWrapRef = useRef<HTMLDivElement>(null)
  useWheelScroll(cmWrapRef, { getScroller: cmScroller })
  // 已保存基线：与当前 ddl 不一致即为"未保存"，标签显示 *
  const savedDdlRef = useRef(draft?.ddl ?? '')
  // 对象是否已落库：编辑模式打开时本就存在；新建模式需先保存一次才能执行
  const everSavedRef = useRef(draft?.mode === 'edit')

  // ── 执行（视图预览 / 函数求值 / 存过调用）：结果区复用查询页样式 + ResultTable ──
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<{ columns: string[]; rows: (string | null)[][]; rowsAffected: number; executionTimeMs: number } | null>(null)
  const [runError, setRunError] = useState('')
  const [runMs, setRunMs] = useState(0)
  const [lastSql, setLastSql] = useState('')
  const [resultOpen, setResultOpen] = useState(false)
  const [resultCollapsed, setResultCollapsed] = useState(false)
  const [resultTab, setResultTab] = useState<'msg' | number>('msg')
  const [resultH, setResultH] = useState(300)
  const [headSlot, setHeadSlot] = useState<HTMLDivElement | null>(null)
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)
  const [paramDlg, setParamDlg] = useState<{ params: import('../../utils/routineExec').RoutineParam[]; values: Record<string, string> } | null>(null)

  const startResultResize = useCallback((e: React.MouseEvent) => {
    resizeRef.current = { startY: e.clientY, startH: resultH }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dy = resizeRef.current.startY - ev.clientY
      setResultH(Math.max(120, Math.min(window.innerHeight - 220, resizeRef.current.startH + dy)))
    }
    const onUp = () => { resizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [resultH])

  // ddl 变化时同步标签的未保存标志（含「新建且从未保存但已有内容」→ 关闭时也提示保存）；关闭/卸载时清除
  useEffect(() => {
    const hasContent = ddl.trim() !== ''
    const dirty = hasContent && (ddl !== savedDdlRef.current || !everSavedRef.current)
    setTabDirty(tabId, dirty)
  }, [ddl, tabId, setTabDirty])
  useEffect(() => () => setTabDirty(tabId, false), [tabId, setTabDirty])

  // 加载可选库（与查询页一致）
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<string[]>('list_schemas', { id: connectionId })
        if (alive) setSchemas(list)
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [connectionId])

  // 表名集合（用于编辑器内悬停下划线 + Mod 点击预览，与查询页一致）
  const [tableSet, setTableSet] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (connType === 'sqlite' || !currentSchema) { setTableSet(new Set()); return }
    let alive = true
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const list = await invoke<{ name: string }[]>('list_tables', { id: connectionId, schema: currentSchema })
        if (alive) setTableSet(new Set(list.map((t) => t.name.toLowerCase())))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [connectionId, currentSchema, connType])
  const tableSetRef = useRef(tableSet); tableSetRef.current = tableSet
  const currentSchemaRef = useRef(currentSchema); currentSchemaRef.current = currentSchema
  const [peek, setPeek] = useState<{ schema: string; table: string } | null>(null)
  const tableLinkExt = useMemo(
    () => makeTableLinkExtensions({ tableSetRef, onPeek: (t) => setPeek({ schema: currentSchemaRef.current, table: t }) }),
    [],
  )

  const sqlDialect = useMemo(() => {
    switch (connType) {
      case 'mysql': case 'tidb': case 'oceanBase': return MySQL
      case 'mariadb': return MariaSQL
      case 'postgres': case 'kingBase': case 'openGauss': case 'duckdb': return PostgreSQL
      case 'sqlite': return SQLite
      case 'sqlServer': return MSSQL
      default: return StandardSQL
    }
  }, [connType])
  const sqlExt = useMemo(() => sql({ dialect: sqlDialect, upperCaseKeywords: true }), [sqlDialect])

  const formatSql = useCallback(async () => {
    if (preFormatRef.current !== null) {
      setDdl(preFormatRef.current); preFormatRef.current = null; return
    }
    try {
      const { format } = await import('sql-formatter')
      const dialect = ['postgres', 'kingBase', 'openGauss', 'duckdb'].includes(connType) ? 'postgresql'
        : connType === 'sqlite' ? 'sqlite'
        : connType === 'oracle' ? 'plsql'
        : connType === 'sqlServer' ? 'tsql'
        : connType === 'clickHouse' ? 'sql'
        : 'mysql'
      const formatted = format(ddl, { language: dialect as any, tabWidth: 2, keywordCase: 'upper' })
      if (formatted !== ddl) preFormatRef.current = ddl
      setDdl(formatted)
    } catch { /* 保持原样 */ }
  }, [ddl, connType])

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!ddl.trim() || saving) return false
    setSaving(true); setRunError('')
    // 函数/存储过程：MySQL 系没有 CREATE OR REPLACE，需要先 DROP IF EXISTS 再 CREATE。
    // Oracle/PG 支持 CREATE OR REPLACE，不需要预置 DROP（Oracle OCI 也不支持多语句合并执行）。
    let execSql = ddl
    const needsDrop = draft
      && (draft.objType === 'function' || draft.objType === 'procedure')
      && !/^\s*DROP\s+(FUNCTION|PROCEDURE)/i.test(ddl)
      && connType !== 'oracle'
      && !['postgres', 'kingBase', 'openGauss'].includes(connType)
    if (needsDrop) {
      const kind = draft!.objType === 'function' ? 'FUNCTION' : 'PROCEDURE'
      const m = ddl.match(/CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:FUNCTION|PROCEDURE)\s+(`[^`]+`|"[^"]+"|\w+)/i)
      const name = m ? m[1] : qid(connType, draft!.name)
      execSql = `DROP ${kind} IF EXISTS ${name};\n${ddl}`
    }
    // 生产环境写操作二次确认
    if (!(await requireProdConfirm(envConn, `保存${draft ? OBJ_LABEL[draft.objType] : '对象'} ${draft?.name ?? ''}`, execSql))) {
      setSaving(false); return false
    }
    const t0 = performance.now()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // SQLite 不支持 CREATE OR REPLACE VIEW，需要分两步：DROP VIEW IF EXISTS + CREATE VIEW
      if (connType === 'sqlite' && draft?.objType === 'view') {
        const m = execSql.match(/CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]*)"|`([^`]*)`|(\w+))/i)
        const viewName = m ? (m[1] ?? m[2] ?? m[3] ?? draft.name) : draft.name
        await invoke('execute_query', { id: connectionId, sql: `DROP VIEW IF EXISTS "${viewName.replace(/"/g, '""')}"` })
      }
      await invoke('execute_query', {
        id: connectionId,
        sql: execSql,
        database: currentSchema || undefined,
      })
      savedDdlRef.current = ddl       // 更新基线 → 清除未保存标志
      everSavedRef.current = true
      setTabDirty(tabId, false)
      setRunError('')                 // 清掉底部可能残留的旧错误
      notifySchemaChanged(connectionId, currentSchema)
      toast.success(`${draft ? OBJ_LABEL[draft.objType] : '对象'}保存成功`)  // 成功 → toast
      return true
    } catch (e) {
      // 失败 → 不弹 toast，统一显示在底部「消息」区（与查询页同款日志格式）
      setRunResult(null); setLastSql(execSql); setRunMs(Math.round(performance.now() - t0))
      setRunError(friendlyDbError(String(e)))
      setResultOpen(true); setResultCollapsed(false); setResultTab('msg')
      return false
    } finally {
      setSaving(false)
    }
  }, [ddl, saving, connectionId, currentSchema, draft, tabId, setTabDirty, envConn, connType])

  // 注册保存句柄：关闭确认弹窗的「保存并关闭」会调用它
  useEffect(() => {
    registerObjectSave(tabId, handleSave)
    return () => unregisterObjectSave(tabId)
  }, [tabId, handleSave])

  // 真正执行：拼好 SQL 后发到数据库，结果进底部面板
  const execSql = useCallback(async (sqlToRun: string) => {
    setRunning(true); setRunError(''); setRunResult(null); setLastSql(sqlToRun)
    setResultOpen(true); setResultCollapsed(false)
    const t0 = performance.now()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const res = await invoke<{ columns: string[]; rows: (string | null)[][]; rowsAffected: number; executionTimeMs: number }>(
        'execute_query', { id: connectionId, sql: sqlToRun, database: currentSchema || undefined })
      setRunResult(res)
      setRunMs(res.executionTimeMs)
      setResultTab(res.columns.length > 0 ? 0 : 'msg')   // 有数据 → 结果1，否则 → 消息
    } catch (e) {
      setRunError(friendlyDbError(String(e)))
      setRunMs(Math.round(performance.now() - t0))
      setResultTab('msg')
    } finally {
      setRunning(false)
    }
  }, [connectionId, currentSchema])

  // 点「执行」：先保存（有改动则自动保存），再按对象类型决定是否需要参数
  const handleRun = useCallback(async () => {
    if (!draft || running || saving) return
    // 有未保存改动、或新建对象尚未落库 → 先保存；保存失败则不执行（错误已提示）
    if (ddl !== savedDdlRef.current || !everSavedRef.current) {
      const ok = await handleSave()
      if (!ok) return
    }
    const { parseObjectName, parseRoutineParams, buildExecSql } = await import('../../utils/routineExec')
    const name = parseObjectName(ddl, draft.objType) || draft.name
    if (draft.objType === 'view') {
      execSql(buildExecSql({ connType, objType: 'view', name, schema: currentSchema, params: [], values: {} }))
      return
    }
    const params = parseRoutineParams(ddl, draft.objType)
    // 需要用户输入的参数：函数全部入参；存过的 IN/INOUT
    const needInput = params.filter((p) => draft.objType === 'function' || p.mode === 'IN' || p.mode === 'INOUT')
    if (needInput.length > 0) {
      setParamDlg({ params, values: Object.fromEntries(params.map((p) => [p.name, ''])) })
    } else {
      execSql(buildExecSql({ connType, objType: draft.objType, name, schema: currentSchema, params, values: {} }))
    }
  }, [draft, running, saving, ddl, handleSave, connType, currentSchema, execSql])

  // 在查询页打开：把「查询视图 / 调用函数·存过」的 SQL 带到一个新查询标签（与"查询此表"一致）
  const openInQuery = useCallback(async () => {
    if (!draft) return
    const { parseObjectName, parseRoutineParams } = await import('../../utils/routineExec')
    const name = parseObjectName(ddl, draft.objType) || draft.name
    const st = useAppStore.getState()
    const newTabId = st.openQueryTab(connectionId)
    if (currentSchema) st.setPendingSchema(newTabId, currentSchema)
    // schema 限定 + 方言化（mssql TOP / oracle FETCH FIRST·FROM DUAL·BEGIN-END / mssql EXEC）
    const ref = tableRef(connType, currentSchema, name)
    const fam = dialectFamily(connType)
    const isOracle = connType === 'oracle'
    if (draft.objType === 'view') {
      const sql = fam === 'mssql' ? `SELECT TOP 100 * FROM ${ref};`
        : isOracle ? `SELECT * FROM ${ref} FETCH FIRST 100 ROWS ONLY;`
        : `SELECT * FROM ${ref} LIMIT 100;`
      st.setPendingFill(newTabId, sql)
      return
    }
    // 函数/存过：用 snippet 模板，${/* 参数 类型 */} 为可输入即替换的占位（类 IDE 入参提示），Tab 跳下一个
    const params = parseRoutineParams(ddl, draft.objType)
    const args = params.map((p) => p.mode === 'OUT'
      ? `@_out_${p.name}`
      : `\${/* ${p.name} ${p.type} */}`).join(', ')
    let tpl: string
    if (draft.objType === 'function') {
      tpl = isOracle
        ? `SELECT ${ref}(${args}) AS 返回值 FROM DUAL;`
        : `SELECT ${ref}(${args}) AS 返回值;`
    } else if (isOracle) {
      tpl = `BEGIN\n  ${ref}(${args});\nEND;`
    } else if (fam === 'mssql') {
      tpl = `EXEC ${ref} ${args};`
    } else {
      tpl = `CALL ${ref}(${args});`
    }
    st.setPendingSnippet(newTabId, tpl)
  }, [draft, ddl, connType, connectionId, currentSchema])

  // 参数弹窗「执行」
  const runWithParams = useCallback(async () => {
    if (!paramDlg || !draft) return
    const { parseObjectName, buildExecSql } = await import('../../utils/routineExec')
    const name = parseObjectName(ddl, draft.objType) || draft.name
    const sql = buildExecSql({ connType, objType: draft.objType, name, schema: currentSchema, params: paramDlg.params, values: paramDlg.values })
    setParamDlg(null)
    execSql(sql)
  }, [paramDlg, draft, ddl, connType, currentSchema, execSql])

  // 快捷键：与查询页一致（保存 Mod+S；执行 sqlRunAll；格式化 sqlFormat；收起结果 sqlToggleResult）。
  // 所有标签常驻挂载，故仅当本标签激活时才响应，避免误触其他编辑页。
  const isActiveTab = useAppStore((s) => s.activeTabId === tabId)
  const shortcuts = useSettingsStore((s) => s.shortcuts)
  const sc = (id: string) => displayShortcutStr(shortcuts[id] ?? SHORTCUT_DEFS.find((d) => d.id === id)?.defaultCombo ?? '')
  useEffect(() => {
    const combo = (id: string) => shortcuts[id] ?? SHORTCUT_DEFS.find((d) => d.id === id)?.defaultCombo ?? ''
    const onKey = (e: KeyboardEvent) => {
      if (useAppStore.getState().activeTabId !== tabId) return
      if (isModEvent(e) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); handleSave(); return }
      if (matchShortcut(e, combo('sqlRunAll')))   { e.preventDefault(); handleRun(); return }
      if (matchShortcut(e, combo('sqlFormat')))   { e.preventDefault(); formatSql(); return }
      if (matchShortcut(e, combo('dbNewQuery')))  { e.preventDefault(); openInQuery(); return }
      if (matchShortcut(e, combo('sqlToggleResult'))) { e.preventDefault(); if (resultOpen) setResultCollapsed((v) => !v); return }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shortcuts, tabId, handleSave, handleRun, formatSql, openInQuery, resultOpen])

  if (!draft) {
    return <div className="result-placeholder" style={{ padding: 40 }}><span>设计草稿已失效，请重新从对象树新建</span></div>
  }

  return (
    <div className="object-editor" style={{ position: 'relative' }}>
      <EnvWatermark envLabel={envConn?.envLabel} readonly={envConn?.readonly ?? envConn?.readOnly} />
      {/* 工具栏：沿用查询页的「会话 + 库 + 图标按钮」布局 */}
      <div className="sql-toolbar">
        <Database size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginRight: 2 }} />
        <SearchableSelect
          value={connectionId} disabled mono={false} width={150}
          items={[{ value: connectionId, label: connName }]} onChange={() => {}}
        />
        <ChevronRight size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <SearchableSelect
          value={currentSchema} onChange={setCurrentSchema}
          options={schemas} mono={false} placeholder="选择库" searchPlaceholder="搜索库…" width={180}
        />
        <div style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 8px', flexShrink: 0 }} />

        <button className="sql-run-btn" onClick={handleSave} disabled={saving || !ddl.trim()}
          data-tip={`保存（在 ${currentSchema || '当前库'} 创建${OBJ_LABEL[draft.objType]}）`} data-shortcut={`${modLabel()}-S`}>
          {saving ? <Loader2 size={13} className="spin" strokeWidth={2.5} /> : <Save size={13} strokeWidth={2.5} />}
          保存
        </button>
        <button className="sql-run-btn" onClick={handleRun} disabled={running || saving || !ddl.trim()}
          data-tip={draft.objType === 'view' ? '执行：预览视图数据' : draft.objType === 'function' ? '执行：调用函数求值' : '执行：调用存储过程'}
          data-shortcut={sc('sqlRunAll')}>
          {running ? <Loader2 size={13} className="spin" strokeWidth={2.5} /> : <Play size={13} strokeWidth={2.5} />}
          执行
        </button>
        <button className="sql-tool-btn" onClick={openInQuery} disabled={!ddl.trim()}
          data-shortcut={sc('dbNewQuery')}
          data-tip={draft.objType === 'view' ? '在查询页打开（带出查询视图 SQL）' : draft.objType === 'function' ? '在查询页打开（带出调用函数 SQL）' : '在查询页打开（带出调用存储过程 SQL）'}>
          <FileCode2 size={14} strokeWidth={2} />
        </button>
        <button className="sql-tool-btn" onClick={formatSql} disabled={!ddl.trim()} data-tip="格式化 SQL" data-shortcut={sc('sqlFormat')}>
          <AlignLeft size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="object-editor__cm" ref={cmWrapRef}>
        <CodeMirror
          value={ddl}
          height="100%"
          extensions={[sqlExt, sqlHighlight, ...tableLinkExt, cmSearchPhrases]}
          theme={isDark ? _editorDark : _editorLight}
          onChange={(val) => { setDdl(val); preFormatRef.current = null }}
          basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false, autocompletion: true }}
        />
      </div>

      {/* 执行结果区：完全复用查询页结果区（消息/结果页签 + ResultTable + 可拖高/收起）；保存/执行的错误都进「消息」 */}
      {resultOpen && (
        <div className={`sql-result-pane${resultCollapsed ? ' collapsed' : ''}`} style={resultCollapsed ? undefined : { height: resultH }}>
          {!resultCollapsed && <div className="oe-result__resize" onMouseDown={startResultResize} />}
          <div className="sql-result-head" onMouseDown={startResultResize}>
            <div className="sql-rtabs" onMouseDown={(e) => e.stopPropagation()}>
              <button className={`sql-rtab${resultTab === 'msg' ? ' active' : ''}`} onClick={() => setResultTab('msg')}>
                消息{runError && <span className="sql-rtab__dot" />}
              </button>
              {runResult && runResult.columns.length > 0 && (
                <button className={`sql-rtab${resultTab === 0 ? ' active' : ''}`} onClick={() => setResultTab(0)}>结果</button>
              )}
            </div>
            <div className="sql-result-head__tools" ref={setHeadSlot} onMouseDown={(e) => e.stopPropagation()} />
            <button className="sql-result-head__toggle" onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setResultCollapsed((v) => !v)}
              data-tip={resultCollapsed ? '展开结果区' : '收起结果区'} data-shortcut={sc('sqlToggleResult')}>
              {resultCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            <button className="sql-result-head__toggle" onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setResultOpen(false)} data-tip="关闭结果区"><X size={14} /></button>
          </div>
          {!resultCollapsed && (
            <div className="sql-result-body">
              {running ? (
                <div className="result-placeholder"><span>执行中…</span></div>
              ) : resultTab === 'msg' ? (
                <div className="sql-msglog">
                  {(!lastSql && !runError) ? (
                    <div className="sql-msglog__empty">暂无消息</div>
                  ) : (
                    <div className="sql-msglog__item">
                      {lastSql && <div className="sql-msglog__sql">{lastSql}</div>}
                      {runError
                        ? <div className="sql-msglog__err">&gt; 错误：{runError}</div>
                        : <div className="sql-msglog__ok">&gt; OK{runResult && runResult.columns.length > 0 ? ` · ${runResult.rows.length} 行` : runResult ? ` · 影响 ${runResult.rowsAffected} 行` : ''}</div>}
                      <div className="sql-msglog__time">&gt; 耗时：{runMs} ms</div>
                    </div>
                  )}
                </div>
              ) : runResult && runResult.columns.length > 0 ? (
                <ResultTable result={runResult} running={false} error="" active={isActiveTab} connectionId={connectionId} connType={connType} toolbarSlot={headSlot} />
              ) : (
                <div className="result-placeholder"><span>无结果集，请查看「消息」</span></div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 参数输入弹窗（函数/存过有参数时） */}
      {paramDlg && createPortal(
        <div className="modal-overlay" onMouseDown={() => setParamDlg(null)}>
          <div className="modal-box modal-box--sm" onMouseDown={(e) => e.stopPropagation()} style={{ width: 460 }}>
            <div className="modal-header">
              <span className="modal-title">执行参数</span>
              <button className="modal-close" onClick={() => setParamDlg(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {paramDlg.params.map((p) => {
                const isOut = p.mode === 'OUT'
                return (
                  <div key={p.name} className="oe-param-row">
                    <span className="oe-param-row__name">
                      {p.mode && <span className="oe-param-row__mode">{p.mode}</span>}
                      {p.name}
                      <span className="oe-param-row__type">{p.type}</span>
                    </span>
                    {isOut
                      ? <span className="oe-param-row__out">（输出，自动接收）</span>
                      : <input className="dbtool-input" autoFocus value={paramDlg.values[p.name] ?? ''}
                          placeholder="留空=NULL；文本无需手动加引号"
                          onChange={(e) => setParamDlg(d => d && ({ ...d, values: { ...d.values, [p.name]: e.target.value } }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') runWithParams() }} />}
                  </div>
                )
              })}
            </div>
            <div className="modal-footer cf-footer">
              <div className="cf-footer-actions">
                <button className="btn-cancel" onClick={() => setParamDlg(null)}>取消</button>
                <button className="btn-save" onClick={runWithParams}>执行</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 表预览（Mod+点击编辑器中的表名）：DDL + 近期数据 */}
      {peek && (
        <TablePeekModal
          connectionId={connectionId}
          connType={connType}
          schema={peek.schema}
          table={peek.table}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  )
}
