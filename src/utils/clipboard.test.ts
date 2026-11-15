import assert from 'node:assert/strict'
import test from 'node:test'
import { copyText } from './clipboard.ts'

test('failed legacy copy removes its temporary textarea before async fallback', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const children: unknown[] = []
  const textarea = { value: '', style: {}, setAttribute() {}, select() {}, setSelectionRange() {} }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => textarea,
    body: { appendChild(node: unknown) { children.push(node) }, removeChild(node: unknown) { children.splice(children.indexOf(node), 1) } },
    execCommand() { throw new Error('copy unavailable') },
  } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(text: string) {
    assert.equal(text, 'private cell value')
    assert.equal(children.length, 0, 'sensitive temporary value must be removed even when execCommand throws')
  } } } })
  try {
    assert.equal(await copyText('private cell value'), true)
    assert.equal(children.length, 0)
    assert.equal(textarea.value, '')
  }
  finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
