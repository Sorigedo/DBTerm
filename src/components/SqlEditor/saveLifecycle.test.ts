import test from 'node:test'
import assert from 'node:assert/strict'
import { createSaveLifecycle } from './saveLifecycle.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('save reserves its gate before confirmation and sends only one write', async () => {
  const lifecycle = createSaveLifecycle()
  const confirm = deferred<boolean>()
  let writes = 0
  const callbacks = { confirm: () => confirm.promise, current: () => true, write: async () => { writes++ }, committed: () => {}, followUp: async () => {} }
  const first = lifecycle.run(callbacks)
  assert.equal(lifecycle.busy, true)
  assert.deepEqual(await lifecycle.run(callbacks), { status: 'busy' })
  confirm.resolve(true)
  assert.deepEqual(await first, { status: 'committed' })
  assert.equal(writes, 1)
  assert.equal(lifecycle.busy, false)
})

test('changing result during confirmation cancels dispatch', async () => {
  const lifecycle = createSaveLifecycle()
  const confirm = deferred<boolean>()
  let current = true
  let writes = 0
  const pending = lifecycle.run({ confirm: () => confirm.promise, current: () => current, write: async () => { writes++ }, committed: () => {}, followUp: async () => {} })
  current = false
  confirm.resolve(true)
  assert.deepEqual(await pending, { status: 'stale' })
  assert.equal(writes, 0)
})

test('confirmed write clears staged changes before failed ancillary refresh', async () => {
  const lifecycle = createSaveLifecycle()
  const events: string[] = []
  const failure = new Error('refresh rejected')
  const outcome = await lifecycle.run({ confirm: async () => true, current: () => true, write: async () => { events.push('write') }, committed: () => { events.push('clear') }, followUp: async () => { events.push('refresh'); throw failure } })
  assert.deepEqual(outcome, { status: 'committed', warning: failure })
  assert.deepEqual(events, ['write', 'clear', 'refresh'])
})

test('late confirmed write never clears or refreshes a replacement result', async () => {
  const lifecycle = createSaveLifecycle()
  const write = deferred<void>()
  let current = true
  let cleared = 0
  let refreshed = 0
  const pending = lifecycle.run({ confirm: async () => true, current: () => current, write: () => write.promise, committed: () => { cleared++ }, followUp: async () => { refreshed++ } })
  await Promise.resolve()
  current = false
  write.resolve()
  assert.deepEqual(await pending, { status: 'committed' })
  assert.equal(cleared, 0)
  assert.equal(refreshed, 0)
})

test('failed write preserves staged changes and releases gate', async () => {
  const lifecycle = createSaveLifecycle()
  const failure = new Error('COMMIT outcome unknown')
  let cleared = false
  const outcome = await lifecycle.run({ confirm: async () => true, current: () => true, write: async () => { throw failure }, committed: () => { cleared = true }, followUp: async () => {} })
  assert.deepEqual(outcome, { status: 'failed', error: failure })
  assert.equal(cleared, false)
  assert.equal(lifecycle.busy, false)
})
