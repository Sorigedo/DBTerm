// SQL 语法高亮：关键词/字符串/数字/函数/类型 + 注释置灰斜体（覆盖主题默认高亮）
// 由 SQL 编辑页、对象编辑页、只读 DDL 查看器共用，保证关键词高亮风格完全一致。
import { Prec } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const sqlHighlight = Prec.high(syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: 'var(--sql-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--sql-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--sql-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--sql-func)' },
  { tag: t.typeName, color: 'var(--sql-type)' },
  { tag: [t.operator, t.punctuation], color: 'var(--text-muted)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.lineComment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.blockComment, color: 'var(--text-muted)', fontStyle: 'italic' },
])))
