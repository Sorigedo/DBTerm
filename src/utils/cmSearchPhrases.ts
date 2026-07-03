// CodeMirror 搜索/替换面板汉化：通过 EditorState.phrases 覆盖默认英文文案。
// 供 SQL 查询页与对象设计器（视图/函数/存储过程）共用，保证全数据库类型一致。
import { EditorState } from '@codemirror/state'

export const cmSearchPhrases = EditorState.phrases.of({
  'Find': '查找',
  'Replace': '替换',
  'next': '下一个',
  'previous': '上一个',
  'all': '全部',
  'match case': '区分大小写',
  'by word': '全词匹配',
  'regexp': '正则',
  'replace': '替换',
  'replace all': '全部替换',
  'close': '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行匹配',
  'on line': '位于行',
  'Go to line': '跳转到行',
  'go': '跳转',
})
