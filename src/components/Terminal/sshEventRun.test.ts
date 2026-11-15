import assert from 'node:assert/strict'
import test from 'node:test'
import { isCurrentSshEvent } from './sshEventRun.ts'

test('SSH events require the selected run even before connect IPC resolves', () => {
  const session = 'tab-1'
  const current = 'new-run'
  assert.equal(isCurrentSshEvent({ id: session, runId: 'old-run' }, session, current, true), false)
  assert.equal(isCurrentSshEvent({ id: session, runId: current }, session, current, true), true)
  assert.equal(isCurrentSshEvent({ id: session, runId: current }, session, '', true), false)
  assert.equal(isCurrentSshEvent({ id: session }, session, current, true), false)
  assert.equal(isCurrentSshEvent({ id: 'other-tab', runId: current }, session, current, true), false)
  assert.equal(isCurrentSshEvent({ id: session, runId: current }, session, current, false), false)
})
