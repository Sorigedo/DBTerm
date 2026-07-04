/** 快捷键工具：格式 "Mod+T"、"Ctrl+Tab"、"Mod+Shift+[" 等 */

// navigator.platform 已废弃，新版 WebKit/macOS 可能返回空字符串；多策略探测
const isMac = (): boolean => {
  try {
    const uad = (navigator as any).userAgentData
    if (uad?.platform) return uad.platform === 'macOS'
  } catch {}
  if (navigator.platform) return /Mac|iPhone|iPod|iPad/i.test(navigator.platform)
  return /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

/** 鼠标/键盘事件是否按下了平台 Mod 修饰键（mac → Cmd，win/linux → Ctrl） */
export function isModEvent(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey
}

/** 平台 Mod 键的显示文字（mac → Cmd，win/linux → Ctrl），用于手势提示如「Cmd-双击」 */
export function modLabel(): string {
  return isMac() ? 'Cmd' : 'Ctrl'
}

/** 从键盘事件生成存储字符串，返回空字符串表示不完整（仅修饰键） */
export function comboFromEvent(e: KeyboardEvent): string {
  const mac = isMac()
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  // Ctrl on Mac is explicit (e.g. Ctrl+Tab); on Win Ctrl IS Mod, don't double-add
  if (e.ctrlKey && (mac || !parts.includes('Mod'))) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey)   parts.push('Alt')
  const ignore = ['Control', 'Meta', 'Shift', 'Alt', 'Command', 'OS']
  if (ignore.includes(e.key)) return ''
  parts.push(e.key)
  return parts.join('+')
}

/** 键名友好显示（不使用符号，统一文字） */
const KEY_LABELS: Record<string, string> = {
  ' ':          'Space',
  'ArrowLeft':  'Left',
  'ArrowRight': 'Right',
  'ArrowUp':    'Up',
  'ArrowDown':  'Down',
  'Escape':     'Esc',
  'Backspace':  'Backspace',
  'Enter':      'Enter',
  'Tab':        'Tab',
  'PageUp':     'PageUp',
  'PageDown':   'PageDown',
}

function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  return key.length === 1 ? key.toUpperCase() : key
}

/** 将存储字符串转成显示标签数组（每个元素对应一个 <kbd>）；不使用符号，统一用文字 */
export function displayShortcut(combo: string): string[] {
  if (!combo) return []
  const mac = isMac()
  const parts = combo.split('+')
  const key   = parts[parts.length - 1]!
  const mods  = parts.slice(0, -1)
  const out: string[] = []
  // Mod：macOS 显示 Cmd，Windows/Linux 显示 Ctrl（同一套快捷键，两端通用）
  if (mods.includes('Mod'))   out.push(mac ? 'Cmd' : 'Ctrl')
  if (mods.includes('Ctrl'))  out.push('Ctrl')
  if (mods.includes('Shift')) out.push('Shift')
  if (mods.includes('Alt'))   out.push('Alt')
  out.push(keyLabel(key))
  return out
}

/** 将 displayShortcut 数组拼成单行字符串（连字符分隔，如 "Cmd-Shift-D"），用于提示 */
export function displayShortcutStr(combo: string): string {
  return displayShortcut(combo).join('-')
}

/** 判断键盘事件是否匹配存储字符串 */
export function matchShortcut(e: KeyboardEvent, combo: string): boolean {
  if (!combo || e.type !== 'keydown') return false
  const mac  = isMac()
  const parts = combo.split('+')
  const key   = parts[parts.length - 1]!
  const has   = (m: string) => parts.includes(m)
  // Mod：mac → Cmd(metaKey)；win/linux → Ctrl(ctrlKey)
  // 显式 Ctrl：两端都映射到 ctrlKey（如 Ctrl+Tab）
  // 关键修复：Windows 上 Mod 即 ctrlKey，期望的 ctrlKey 必须把 Mod 也算进来，
  // 否则 has('Ctrl')=false 会与按下的 ctrlKey=true 冲突，导致所有 Mod 快捷键失配。
  const wantCtrl = has('Ctrl') || (!mac && has('Mod'))
  const wantMeta = mac && has('Mod')
  if (wantCtrl !== e.ctrlKey) return false
  if (wantMeta !== e.metaKey) return false
  if (has('Shift') !== e.shiftKey) return false
  if (has('Alt')   !== e.altKey)   return false
  // 末位键匹配：通常比 e.key 即可；但 macOS 上按住 Option(Alt) 会把 e.key 变成
  // 合成字符（Option+N→死键、Option+C→ç…），导致 Mod+Alt+字母 类快捷键失配。
  // 故对单个字母/数字额外用与布局无关的物理键码 e.code（KeyN / Digit1）兜底。
  const k = key.toLowerCase()
  if (e.key.toLowerCase() === k) return true
  if (/^[a-z]$/.test(k)) return e.code === `Key${k.toUpperCase()}`
  if (/^[0-9]$/.test(k)) return e.code === `Digit${k}`
  return false
}

// ── 作用域 ─────────────────────────────────────────────────────────────────────

export type ShortcutScope =
  | 'global'       // 任何地方生效
  | 'db-panel'     // 库树 / SchemaBrowser 聚焦时
  | 'sql-editor'   // SQL 编辑器 CodeMirror 聚焦时
  | 'result-table' // 结果表 / TableBrowser 聚焦时
  | 'redis'        // RedisBrowser 聚焦时
  | 'sqlite-admin' // SQLite 维护面板聚焦时

export type ShortcutGroup =
  | '全局'
  | 'SQL 编辑器'
  | '结果表'
  | '库树'
  | 'Redis'
  | 'SQLite 维护'

export interface ShortcutDef {
  id:           string
  label:        string
  defaultCombo: string
  group:        ShortcutGroup
  scope:        ShortcutScope
}

/** 所有可配置快捷键的定义 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // ── 全局（标签页管理）
  { id: 'quickSearch',     label: '快速搜索连接',       defaultCombo: 'Mod+P',           group: '全局',      scope: 'global' },
  { id: 'duplicateTab',    label: '复制当前标签页',     defaultCombo: 'Mod+T',           group: '全局',      scope: 'global' },
  { id: 'closeTab',        label: '关闭当前标签页',     defaultCombo: 'Mod+W',           group: '全局',      scope: 'global' },
  { id: 'prevTab',         label: '切换到左侧标签',     defaultCombo: 'Ctrl+PageUp',      group: '全局',      scope: 'global' },
  { id: 'nextTab',         label: '切换到右侧标签',     defaultCombo: 'Ctrl+PageDown',    group: '全局',      scope: 'global' },
  { id: 'cycleTabNext',    label: '下一个标签页',       defaultCombo: 'Ctrl+Tab',        group: '全局',      scope: 'global' },
  { id: 'cycleTabPrev',    label: '上一个标签页',       defaultCombo: 'Ctrl+Shift+Tab',  group: '全局',      scope: 'global' },
  { id: 'clearScreen',     label: '清屏',               defaultCombo: 'Mod+K',           group: '全局',      scope: 'global' },
  { id: 'termSearch',      label: '终端内搜索',         defaultCombo: 'Mod+F',           group: '全局',      scope: 'global' },
  { id: 'openSettings',    label: '打开设置',           defaultCombo: 'Mod+,',           group: '全局',      scope: 'global' },
  { id: 'newWindow',       label: '新建窗口',           defaultCombo: 'Mod+Alt+N',       group: '全局',      scope: 'global' },
  { id: 'dbCollapseAll',   label: '展开/收起所有库树',  defaultCombo: 'Mod+M',           group: '全局',      scope: 'global' },
  // ── SQL 编辑器
  { id: 'sqlRunAll',       label: '执行（选中或全部）', defaultCombo: 'Mod+R',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlRunSelected',  label: '执行选中 SQL',       defaultCombo: 'Mod+Shift+R',     group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlToggleResult', label: '收起/展开结果区',    defaultCombo: 'Mod+J',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlStop',         label: '停止执行',           defaultCombo: 'Mod+B',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlExplain',      label: 'EXPLAIN 执行计划',   defaultCombo: 'Mod+Shift+X',     group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlFormat',       label: '格式化 SQL',         defaultCombo: 'Mod+Shift+F',     group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlFoldSelection', label: '收起选中 SQL',       defaultCombo: 'Mod+-',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlUnfoldSelection', label: '展开 SQL',         defaultCombo: 'Mod+=',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlComment',      label: '行注释',             defaultCombo: 'Mod+/',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlSave',         label: '保存查询',           defaultCombo: 'Mod+S',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlHistory',      label: '查询历史',           defaultCombo: 'Mod+H',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlDupLine',      label: '复制行',             defaultCombo: 'Mod+D',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlDelLine',      label: '删除行',             defaultCombo: 'Mod+E',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlCopyLineUp',   label: '向上复制行',         defaultCombo: 'Alt+Shift+ArrowUp',   group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlCopyLineDown', label: '向下复制行',         defaultCombo: 'Alt+Shift+ArrowDown', group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlFocusEditor',  label: '聚焦编辑器',         defaultCombo: 'Mod+L',           group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlTxCommit',     label: '提交事务（强确认）', defaultCombo: 'Mod+Alt+C',       group: 'SQL 编辑器', scope: 'sql-editor' },
  { id: 'sqlTxRollback',   label: '回滚事务（强确认）', defaultCombo: 'Mod+Alt+R',       group: 'SQL 编辑器', scope: 'sql-editor' },
  // ── 结果表
  { id: 'tableRefresh',    label: '刷新结果',           defaultCombo: 'F5',              group: '结果表',    scope: 'result-table' },
  { id: 'tableFilter',     label: '聚焦过滤框',         defaultCombo: 'Mod+F',           group: '结果表',    scope: 'result-table' },
  { id: 'tableNextPage',   label: '下一页',             defaultCombo: 'Alt+ArrowRight',  group: '结果表',    scope: 'result-table' },
  { id: 'tablePrevPage',   label: '上一页',             defaultCombo: 'Alt+ArrowLeft',   group: '结果表',    scope: 'result-table' },
  { id: 'tableRowDetail',  label: '行详情',             defaultCombo: 'Space',           group: '结果表',    scope: 'result-table' },
  { id: 'tableSetNull',    label: '置 NULL',            defaultCombo: 'Mod+Shift+0',     group: '结果表',    scope: 'result-table' },
  { id: 'tableAddRow',     label: '新增行',             defaultCombo: 'Mod+Shift+N',     group: '结果表',    scope: 'result-table' },
  { id: 'tableDelRow',     label: '删除选中行（强确认）', defaultCombo: 'Mod+Backspace',  group: '结果表',    scope: 'result-table' },
  { id: 'tableCommit',     label: '提交暂存变更',       defaultCombo: 'Mod+S',           group: '结果表',    scope: 'result-table' },
  { id: 'tableExport',     label: '打开导出对话框',     defaultCombo: 'Mod+Shift+E',     group: '结果表',    scope: 'result-table' },
  { id: 'tableCopyCell',  label: '复制单元格',         defaultCombo: 'Mod+C',           group: '结果表',    scope: 'result-table' },
  { id: 'tableCopyRow',   label: '复制整行（Tab 分隔）', defaultCombo: 'Mod+Shift+C',   group: '结果表',    scope: 'result-table' },
  { id: 'tableCopyInsert',label: '复制为 INSERT 语句', defaultCombo: 'Mod+Alt+I',       group: '结果表',    scope: 'result-table' },
  { id: 'tableViewMode',  label: '切换展示形态（表格/JSON）', defaultCombo: 'Mod+Shift+V', group: '结果表',    scope: 'result-table' },
  // ── 库树
  { id: 'dbTreeRefresh',   label: '刷新对象树',         defaultCombo: 'F5',              group: '库树',      scope: 'db-panel' },
  { id: 'dbTreeSearch',    label: '聚焦搜索',           defaultCombo: 'Mod+F',           group: '库树',      scope: 'db-panel' },
  { id: 'dbObjStructure',  label: '修改表结构',         defaultCombo: 'Mod+I',           group: '库树',      scope: 'db-panel' },
  { id: 'dbObjDdl',        label: '查看 DDL',           defaultCombo: 'Mod+D',           group: '库树',      scope: 'db-panel' },
  { id: 'dbObjRename',     label: '重命名对象',         defaultCombo: 'F2',              group: '库树',      scope: 'db-panel' },
  { id: 'dbObjNewTable',   label: '新建表',             defaultCombo: 'Mod+Shift+T',     group: '库树',      scope: 'db-panel' },
  { id: 'dbNewQuery',     label: '新建查询标签',       defaultCombo: 'Mod+N',           group: '库树',      scope: 'db-panel' },
  // ── Redis
  { id: 'redisSearch',     label: '聚焦 key 搜索',      defaultCombo: 'Mod+F',           group: 'Redis',     scope: 'redis' },
  { id: 'redisRefresh',    label: '刷新/重扫 key 列表', defaultCombo: 'F5',              group: 'Redis',     scope: 'redis' },
  { id: 'redisNewKey',     label: '新建 key',           defaultCombo: 'Mod+N',           group: 'Redis',     scope: 'redis' },
  { id: 'redisRename',     label: '重命名 key',         defaultCombo: 'F2',              group: 'Redis',     scope: 'redis' },
  { id: 'redisTtlEdit',    label: '编辑 TTL',           defaultCombo: 'Mod+E',           group: 'Redis',     scope: 'redis' },
  { id: 'redisDeleteKey',  label: '删除当前 key',       defaultCombo: 'Mod+Backspace',   group: 'Redis',     scope: 'redis' },
  { id: 'redisCopyKey',    label: '复制 key 名',        defaultCombo: 'Mod+C',           group: 'Redis',     scope: 'redis' },
  { id: 'redisFocusCli',  label: '切换到 CLI 面板',    defaultCombo: 'Mod+`',           group: 'Redis',     scope: 'redis' },
  // ── SQLite 维护
  { id: 'sqliteRefresh',   label: '刷新统计',           defaultCombo: 'F5',              group: 'SQLite 维护', scope: 'sqlite-admin' },
  { id: 'sqliteIntegrity', label: '运行完整性检查',     defaultCombo: 'Mod+I',           group: 'SQLite 维护', scope: 'sqlite-admin' },
  { id: 'sqliteFilter',    label: '聚焦 PRAGMA 搜索',   defaultCombo: 'Mod+F',           group: 'SQLite 维护', scope: 'sqlite-admin' },
]

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(
  SHORTCUT_DEFS.map(d => [d.id, d.defaultCombo])
)
