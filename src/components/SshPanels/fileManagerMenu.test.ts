import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldCloseFileMenuFromTarget } from './fileManagerMenu.ts'

function el(className: string, childClassName?: string): Element {
  const root = {
    className,
    closest(selector: string) {
      return selector.split(',').some(s => s.trim() === `.${className}`) ? root : null
    },
  } as unknown as Element
  if (!childClassName) return root
  return {
    className: childClassName,
    closest(selector: string) {
      return selector.split(',').some(s => s.trim() === `.${childClassName}` || s.trim() === `.${className}`)
        ? root
        : null
    },
  } as unknown as Element
}

test('file manager menu clicks do not close menu before item click', () => {
  assert.equal(shouldCloseFileMenuFromTarget(el('fm-ctx-menu', 'fm-ctx-menu__item')), false)
  assert.equal(shouldCloseFileMenuFromTarget(el('cdlg-overlay')), false)
  assert.equal(shouldCloseFileMenuFromTarget(el('fm-picker')), false)
  assert.equal(shouldCloseFileMenuFromTarget(el('file-row')), true)
  assert.equal(shouldCloseFileMenuFromTarget(null), true)
})
