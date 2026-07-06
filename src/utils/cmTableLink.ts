// CodeMirror 扩展：鼠标悬停到「已知表名」加下划线，Mod/Ctrl+左键点击触发预览（DDL + 近期数据）。
import { StateField, StateEffect, type Extension } from '@codemirror/state'
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import type { RefObject } from 'react'

const setTableHover = StateEffect.define<{ from: number; to: number } | null>()
const tableHoverMark = Decoration.mark({ class: 'cm-table-link' })
const tableHoverField = StateField.define<DecorationSet>({
  create() { return Decoration.none },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    if (tr.docChanged || tr.selection) deco = Decoration.none
    for (const e of tr.effects) {
      if (e.is(setTableHover)) {
        deco = e.value ? Decoration.set([tableHoverMark.range(e.value.from, e.value.to)]) : Decoration.none
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

function currentHoverRange(deco: DecorationSet | undefined): { from: number; to: number } | null {
  if (!deco) return null
  let r: { from: number; to: number } | null = null
  deco.between(0, Number.MAX_SAFE_INTEGER, (from, to) => { r = { from, to }; return false })
  return r
}

/** 生成表名悬停下划线 + Mod+点击预览的扩展集合 */
export function makeTableLinkExtensions(opts: {
  tableSetRef: RefObject<Set<string>>            // 已知表名（小写）集合
  onPeek: (table: string) => void               // Mod+点击触发
}): Extension[] {
  const modClickExt = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.metaKey || e.ctrlKey)) return false
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      if (pos == null) return false
      const range = view.state.wordAt(pos)
      if (!range) return false
      const word = view.state.sliceDoc(range.from, range.to)
      if (word && opts.tableSetRef.current?.has(word.toLowerCase())) {
        e.preventDefault()
        opts.onPeek(word)
        return true
      }
      return false
    },
  })
  const clearHover = (view: EditorView) => {
    if (currentHoverRange(view.state.field(tableHoverField, false))) {
      view.dispatch({ effects: setTableHover.of(null) })
    }
  }
  const tableHoverExt = EditorView.domEventHandlers({
    mousemove(e, view) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
      let next: { from: number; to: number } | null = null
      if (pos != null) {
        const range = view.state.wordAt(pos)
        if (range) {
          const word = view.state.sliceDoc(range.from, range.to)
          if (word && opts.tableSetRef.current?.has(word.toLowerCase())) next = { from: range.from, to: range.to }
        }
      }
      const cur = currentHoverRange(view.state.field(tableHoverField, false))
      const same = (!next && !cur) || (!!next && !!cur && next.from === cur.from && next.to === cur.to)
      if (!same) view.dispatch({ effects: setTableHover.of(next) })
      return false
    },
    // 鼠标移出 / 点击 / 滚动 / 失焦 都立刻清除悬停提示，避免浮窗残留（点击预览、滚动后尤其明显）
    mouseleave(_e, view) { clearHover(view); return false },
    mouseout(_e, view) { clearHover(view); return false },
    mousedown(_e, view) { clearHover(view); return false },
    keydown(_e, view) { clearHover(view); return false },
    wheel(_e, view) { clearHover(view); return false },
    blur(_e, view) { clearHover(view); return false },
    scroll(_e, view) { clearHover(view); return false },
  })
  return [modClickExt, tableHoverField, tableHoverExt]
}
