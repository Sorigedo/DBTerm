/**
 * KB0.2 — 作用域快捷键分发 hook
 *
 * 使用方式：
 *   useShortcuts('sql-editor', {
 *     sqlRunAll:  () => runQuery(),
 *     sqlFormat:  () => formatSql(),
 *   })
 *
 * 规则：
 * - 终端聚焦（xterm canvas/textarea）时，仅 global 作用域生效
 * - input/textarea/contentEditable 聚焦时，无修饰符的单键（Space/F2/Delete）不触发
 * - 同一 combo 在不同 scope 不冲突
 *
 * 性能：handlers 通过 ref 持有，仅 scope/shortcuts 变化时重新注册监听器。
 */
import { useEffect, useRef } from 'react'
import { matchShortcut, ShortcutScope, SHORTCUT_DEFS } from './shortcuts'
import { useSettingsStore } from '../stores/settingsStore'

/** 判断当前聚焦的元素是否为终端 xterm */
function isTerminalFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  // xterm 用 canvas 渲染，但事件在 textarea 上
  if (el.tagName === 'CANVAS') return true
  if (el.tagName === 'TEXTAREA') {
    // xterm 的 textarea 通常带有 xterm-helper-textarea 类
    return (el as HTMLElement).classList.contains('xterm-helper-textarea')
  }
  return false
}

/** 判断当前聚焦是否为输入类元素（input / textarea / contenteditable） */
function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  if ((el as HTMLElement).isContentEditable) return true
  // CodeMirror contenteditable div
  if ((el as HTMLElement).classList.contains('cm-content')) return true
  return false
}

/** 快捷键 combo 是否只有修饰键之外的单键（无 Mod/Ctrl/Alt/Shift） */
function isPureKey(combo: string): boolean {
  const parts = combo.split('+')
  return parts.length === 1 // 只有一个 key，没有修饰符
}

/** 功能键 F1–F12：不产生文本输入，输入框聚焦时也应允许触发（如 F5 刷新、F2 重命名） */
function isFunctionKey(combo: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(combo)
}

/** 原生剪贴板/全选组合键：输入框/编辑器（含 CodeMirror DDL 预览）聚焦时应交给原生处理 */
function isClipboardCombo(combo: string): boolean {
  return /^Mod\+[CXVA]$/i.test(combo)
}

/** 复制/剪切组合键：存在真实文本选区时应交给原生复制（如只读 DDL 预览框内拖选文本） */
function isCopyCombo(combo: string): boolean {
  return /^Mod\+[CX]$/i.test(combo)
}

/** 当前是否存在非空文本选区（只读 DDL 预览等区域允许选中文本，结果表行 user-select:none 不会产生选区） */
function hasTextSelection(): boolean {
  const s = window.getSelection()
  return !!(s && !s.isCollapsed && (s.toString().trim().length > 0))
}

export function useShortcuts(
  scope: ShortcutScope,
  handlers: Partial<Record<string, () => void>>,
  // enabled=false 时不响应：标签页常驻挂载，非激活标签的区域快捷键必须关掉，避免"冒泡"到隐藏标签
  enabled: boolean = true,
) {
  const shortcuts = useSettingsStore(s => s.shortcuts)
  // 持有最新 handlers 引用，不放进 effect 依赖——避免每次渲染都重新注册监听器
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown') return
      if (!enabledRef.current) return
      // 已被处理（如 CodeMirror 编辑器内的同组合键）→ 不再重复触发，避免双重执行
      if (e.defaultPrevented) return
      const h = handlersRef.current

      // 终端聚焦时只允许 global 作用域
      if (isTerminalFocused() && scope !== 'global') return

      // input/textarea/contenteditable 聚焦时过滤无修饰符的单键（Space/F2/Delete 等）
      if (isInputFocused() && scope !== 'global' && scope !== 'sql-editor') {
        // 对 sql-editor scope，CodeMirror 自己管理，我们的全局 keydown 不干预
        // 对其他 scope（result-table / db-panel），跳过纯键
        const matchedId = Object.keys(h).find(id => {
          const c = shortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
          return matchShortcut(e, c)
        })
        const matchedCombo = matchedId ? (shortcuts[matchedId] ?? SHORTCUT_DEFS.find(d => d.id === matchedId)?.defaultCombo ?? '') : ''
        // 纯单键在输入框内不触发，但功能键（F5/F2 等）例外
        if (matchedId && isPureKey(matchedCombo) && !isFunctionKey(matchedCombo)) return
        // Mod+C/X/V/A 交给输入框/编辑器原生处理（如 DDL 预览框内复制选中文本），不被结果表抢走
        if (matchedId && isClipboardCombo(matchedCombo)) return
      }

      for (const [id, handler] of Object.entries(h)) {
        if (!handler) continue
        const combo = shortcuts[id] ?? SHORTCUT_DEFS.find(d => d.id === id)?.defaultCombo ?? ''
        if (!combo) continue
        if (matchShortcut(e, combo)) {
          // 存在真实文本选区时，Mod+C/X 交给原生复制（用户已显式选中文本，如只读 DDL 预览框），
          // 不被结果表单元格复制抢走（结果表行 user-select:none，正常框选单元格不会产生文本选区）
          if (isCopyCombo(combo) && hasTextSelection()) return
          e.preventDefault()
          handler()
          return
        }
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // handlers 故意不在依赖中——通过 handlersRef 保持最新引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, shortcuts])
}
