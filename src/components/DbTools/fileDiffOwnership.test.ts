import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDiffRequestOwner } from './dataDiffState.ts'

for (const panel of ['DuckDbDiffPanel.tsx', 'SqliteAdminPanel.tsx']) {
  test(panel + ' binds responses and displayed results to requested databases', () => {
    const source = readFileSync(new URL('./' + panel, import.meta.url), 'utf8')
    for (const guard of ['createDiffRequestOwner', 'diffOwner.current(epoch)', 'diffSelectionRef.current === diffSelectionKey', 'diffResultKey === diffSelectionKey', 'diffOwner.invalidate()', 'diffOwner.finish(epoch)']) assert.ok(source.includes(guard), guard)
  })
}

test('target change rejects pending response even after selecting original target again', async () => {
  const owner = createDiffRequestOwner()
  let selected = 'A:B'
  let published: string | null = null
  let resolve!: () => void
  const pending = new Promise<void>(r => { resolve = r })
  const epoch = owner.begin()!
  const original = selected
  const run = pending.then(() => {
    if (owner.current(epoch) && selected === original) published = original
    owner.finish(epoch)
  })
  selected = 'A:C'; owner.invalidate()
  selected = 'A:B'; owner.invalidate()
  resolve(); await run
  assert.equal(published, null)
  assert.equal(owner.busy, false)
})
