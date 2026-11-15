import test from 'node:test'
import assert from 'node:assert/strict'
import { rollbackOwnedTransaction, shouldRollbackAfterControlFailure } from './transactionRollback.ts'

test('failed COMMIT acknowledgement cannot be corrected by a new rollback attempt', () => {
  assert.equal(shouldRollbackAfterControlFailure('commit'), false)
  assert.equal(shouldRollbackAfterControlFailure('rollback'), true)
  assert.equal(shouldRollbackAfterControlFailure(null), true)
})

test('owned rollback is confirmed only after backend acknowledgement', async () => {
  assert.deepEqual(await rollbackOwnedTransaction(true, true, async () => {}), { attempted: true, confirmed: true, error: '' })
  const failed = await rollbackOwnedTransaction(true, true, async () => { throw new Error('connection lost') })
  assert.equal(failed.confirmed, false)
  assert.equal(failed.attempted, true)
  assert.match(failed.error, /回滚未确认/)
  assert.doesNotMatch(failed.error, /已回滚/)
})

test('batch does not roll back a manually owned transaction', async () => {
  let calls = 0
  const result = await rollbackOwnedTransaction(false, true, async () => { calls++ })
  assert.equal(calls, 0)
  assert.equal(result.attempted, false)
  assert.equal(result.confirmed, false)
})
