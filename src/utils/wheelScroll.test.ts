import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWheelAction } from './wheelScrollCore.ts'

const base = {
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  deltaX: 0,
  deltaY: 120,
}

test('ctrl mode only lets Ctrl+wheel drive horizontal scroll', () => {
  assert.equal(resolveWheelAction({ ...base, ctrlKey: true }, 'ctrl', false, true), 'horizontal')
  assert.equal(resolveWheelAction({ ...base, shiftKey: true }, 'ctrl', false, true), 'block')
  assert.equal(resolveWheelAction({ ...base, altKey: true }, 'ctrl', false, true), 'block')
})

test('ctrl mode blocks WebView native Shift horizontal wheel events', () => {
  assert.equal(
    resolveWheelAction({ ...base, shiftKey: true, deltaX: 120, deltaY: 0 }, 'ctrl', false, true),
    'block',
  )
})

test('unmodified touchpad horizontal gesture stays native', () => {
  assert.equal(resolveWheelAction({ ...base, deltaX: 120, deltaY: 0 }, 'ctrl', false, true), 'native')
})

test('horizontal-first makes unmodified vertical wheel horizontal', () => {
  assert.equal(resolveWheelAction(base, 'horizontal-first', false, true), 'horizontal')
})
