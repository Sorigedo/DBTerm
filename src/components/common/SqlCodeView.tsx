import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { sql, StandardSQL, MySQL, MariaSQL, PostgreSQL, SQLite, MSSQL } from '@codemirror/lang-sql'
import type { ConnType } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'
import { sqlHighlight } from '../../utils/sqlHighlight'
import { useWheelScroll, cmScroller } from '../../utils/wheelScroll'
import { copyText } from '../../utils/clipboard'

/**
 * 只读 SQL 代码查看器：与 SQL 编辑页 / 对象编辑页共用同一套关键词高亮（lang-sql + CSS 变量主题）。
 * 用于 DDL 预览等只读场景，保证高亮风格与编辑器完全一致。
 */

const _darkTheme = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':
    { background: 'rgba(100,145,255,0.28) !important' },
  '.cm-activeLine': { background: 'rgba(255,255,255,0.03)' },
  '.cm-gutters': {
    background: 'var(--surface)', color: 'var(--text-muted)',
    border: 'none', borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-gutter .cm-gutterElement': { padding: '0 6px' },
}, { dark: true })

const _lightTheme = EditorView.theme({
  '&': { background: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { background: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':
    { background: 'rgba(80,130,240,0.22) !important' },
  '.cm-activeLine': { background: 'rgba(0,0,0,0.03)' },
  '.cm-gutters': {
    background: 'var(--surface)', color: 'var(--text-muted)',
    border: 'none', borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-gutter .cm-gutterElement': { padding: '0 6px' },
}, { dark: false })

export default function SqlCodeView({
  code, connType, lineNumbers = false, className, style, wrap = false,
}: {
  code: string
  connType?: ConnType | string
  lineNumbers?: boolean
  className?: string
  style?: React.CSSProperties
  /** 是否自动换行；默认 false：长行不换行，底部横向滚动（DDL 预览的期望行为） */
  wrap?: boolean
}) {
  const appColorScheme = useSettingsStore((s) => s.appColorScheme)
  const isDark = appColorScheme === 'dark'
    || (appColorScheme === 'system' && typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-color-scheme: dark)').matches)

  // 不换行时滚轮驱动横向滚动条：统一规则（见 utils/wheelScroll）；换行时无横向溢出，规则自动不生效
  const wrapRef = useRef<HTMLDivElement>(null)
  useWheelScroll(wrapRef, { getScroller: cmScroller })

  const sqlExt = useMemo(() => {
    const dialect =
      connType === 'mysql' || connType === 'tidb' || connType === 'oceanBase' || connType === 'clickHouse' ? MySQL
      : connType === 'mariadb' ? MariaSQL
      : connType === 'postgres' || connType === 'kingBase' || connType === 'openGauss' || connType === 'duckdb' ? PostgreSQL
      : connType === 'sqlite' ? SQLite
      : connType === 'sqlServer' ? MSSQL
      : StandardSQL
    return sql({ dialect, upperCaseKeywords: true })
  }, [connType])

  const interactionExt = useMemo(() => [
    EditorView.contentAttributes.of({
      tabindex: '0',
      role: 'textbox',
      'aria-readonly': 'true',
    }),
    EditorView.domEventHandlers({
      mousedown(_event, view) {
        // editable=false 的 CodeMirror 默认不一定进入键盘焦点链，点击后主动聚焦。
        window.setTimeout(() => view.focus(), 0)
        return false
      },
      keydown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
        const key = event.key.toLowerCase()
        if (key === 'a') {
          event.preventDefault()
          event.stopPropagation()
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
          return true
        }
        if (key === 'c') {
          const text = view.state.selection.ranges
            .filter(range => !range.empty)
            .map(range => view.state.sliceDoc(range.from, range.to))
            .join('\n')
          if (!text) return false
          event.preventDefault()
          event.stopPropagation()
          void copyText(text).finally(() => view.focus())
          return true
        }
        return false
      },
    }),
  ], [])

  return (
    <div ref={wrapRef} style={{ display: 'contents' }}>
      <CodeMirror
        value={code}
        editable={false}
        readOnly
        className={className}
        style={style}
        extensions={wrap
          ? [sqlExt, sqlHighlight, interactionExt, EditorView.lineWrapping]
          : [sqlExt, sqlHighlight, interactionExt]}
        theme={isDark ? _darkTheme : _lightTheme}
        basicSetup={{
          lineNumbers,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  )
}
