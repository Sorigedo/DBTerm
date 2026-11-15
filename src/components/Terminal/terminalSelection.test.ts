import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getEventListeners } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import { createTerminalDragRecovery, installTerminalDragRecovery } from './terminalDragRecovery.ts'

function mouseEvent(type: string, properties: Record<string, number>): Event {
  return Object.assign(new Event(type), properties)
}

test('installed drag recovery receives events and removes every listener on disposal', () => {
  const terminal = new EventTarget()
  const document = new EventTarget()
  const window = new EventTarget()
  let releases = 0
  const dispose = installTerminalDragRecovery(terminal, document, window, () => {
    releases++
    document.dispatchEvent(mouseEvent('mouseup', { button: 0, buttons: 0 }))
  })
  assert.equal(getEventListeners(terminal, 'mousedown').length, 1)
  assert.equal(getEventListeners(document, 'mousemove').length, 1)
  assert.equal(getEventListeners(document, 'mouseup').length, 1)
  assert.equal(getEventListeners(window, 'blur').length, 1)
  terminal.dispatchEvent(mouseEvent('mousedown', { button: 0 }))
  document.dispatchEvent(mouseEvent('mousemove', { buttons: 1 }))
  assert.equal(releases, 0)
  document.dispatchEvent(mouseEvent('mousemove', { buttons: 0 }))
  assert.equal(releases, 1)
  terminal.dispatchEvent(mouseEvent('mousedown', { button: 0 }))
  document.dispatchEvent(mouseEvent('mouseup', { button: 0 }))
  window.dispatchEvent(new Event('blur'))
  assert.equal(releases, 1, 'real mouseup must clear tracking')
  terminal.dispatchEvent(mouseEvent('mousedown', { button: 0 }))
  dispose()
  assert.equal(getEventListeners(terminal, 'mousedown').length, 0)
  assert.equal(getEventListeners(document, 'mousemove').length, 0)
  assert.equal(getEventListeners(document, 'mouseup').length, 0)
  assert.equal(getEventListeners(window, 'blur').length, 0)
  assert.equal(releases, 2, 'unmount releases an active drag')
  terminal.dispatchEvent(mouseEvent('mousedown', { button: 0 }))
  document.dispatchEvent(mouseEvent('mousemove', { buttons: 0 }))
  window.dispatchEvent(new Event('blur'))
  assert.equal(releases, 2, 'disposed terminal must not react to document or window events')
})

test('lost mouseup ends xterm selection before unpressed pointer movement', () => {
  let releases = 0
  const guard = createTerminalDragRecovery(() => { releases++ })
  guard.down({ button: 0 })
  guard.move({ buttons: 1 })
  assert.equal(releases, 0, 'normal / three-finger drag must continue')
  guard.move({ buttons: 0 })
  guard.move({ buttons: 0 })
  assert.equal(releases, 1, 'lost release is recovered exactly once')
})

test('missing buttons state does not end a tracked drag', () => {
  let releases = 0
  const guard = createTerminalDragRecovery(() => { releases++ })
  guard.down({ button: 0 })
  guard.move({ buttons: undefined as unknown as number })
  assert.equal(releases, 0, 'xterm can omit buttons while a macOS drag is active')
  guard.move({ buttons: 0 })
  assert.equal(releases, 1, 'an explicit unpressed state still recovers a lost mouseup')
})

test('normal clicks, secondary clicks and focus loss do not leave drag tracking active', () => {
  let releases = 0
  const guard = createTerminalDragRecovery(() => { releases++ })
  guard.down({ button: 0 })
  guard.up({ button: 0 })
  guard.move({ buttons: 0 })
  guard.down({ button: 2 })
  guard.blur()
  assert.equal(releases, 0)
  guard.down({ button: 0 })
  guard.blur()
  guard.move({ buttons: 0 })
  assert.equal(releases, 1)
})

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `missing ${selector} rule`)
  const end = css.indexOf('}', start)
  assert.notEqual(end, -1, `unterminated ${selector} rule`)
  return css.slice(start, end)
}

test('terminal host disables browser text selection while preserving xterm selection', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
  const outer = cssBlock(css, '.term-outer')
  assert.match(outer, /user-select:\s*none/)
  assert.match(outer, /-webkit-user-select:\s*none/)

  const accessibility = cssBlock(css, '.term-outer .xterm .xterm-accessibility-tree')
  assert.match(accessibility, /user-select:\s*none/)
  assert.match(accessibility, /-webkit-user-select:\s*none/)
})
