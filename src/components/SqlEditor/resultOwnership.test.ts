import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createResultOwner } from './resultOwnership.ts'

test('result owner tracks exact identity and can be cleared', () => {
  const owner = createResultOwner<object>()
  const result = { rows: [['retained']] }
  assert.equal(owner.matches(result), false)
  owner.set(result)
  assert.equal(owner.matches(result), true)
  assert.equal(owner.matches({ rows: [['retained']] }), false)
  owner.clear()
  assert.equal(owner.matches(result), false)
})

test('editor stores result ownership without keeping old row data alive', () => {
  const editor = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
  assert.match(editor, /createResultOwner<QueryResult>/)
  assert.doesNotMatch(editor, /editOwner\s*=\s*useRef<QueryResult/)
})

test('ownership releases an otherwise unreachable large result after garbage collection', { skip: typeof global.gc !== 'function' }, async () => {
  const owner = createResultOwner<object>()
  let weak!: WeakRef<object>
  ;(() => {
    const result = { rows: new Array(100_000).fill('payload') }
    weak = new WeakRef(result)
    owner.set(result)
  })()
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    global.gc()
  }
  assert.equal(weak.deref() === undefined, true, 'old result must be collectible')
})
