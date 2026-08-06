import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldCommitCanceledAsciiComposition, shouldSuppressImeAsciiCommit, shouldSuppressReturnAfterCanceledAsciiCommit } from './ime.ts'

test('ime ascii commit suppression ignores mac input source switching keys', () => {
  assert.equal(shouldSuppressImeAsciiCommit('Shift', 'code'), false)
  assert.equal(shouldSuppressImeAsciiCommit('CapsLock', 'code'), false)
  assert.equal(shouldSuppressImeAsciiCommit('Enter', 'code'), false)
  assert.equal(shouldSuppressImeAsciiCommit('a', 'code'), true)
  assert.equal(shouldSuppressImeAsciiCommit('', '中文'), false)
})

test('ime canceled by mac input source switch commits ascii preedit text', () => {
  assert.equal(shouldCommitCanceledAsciiComposition('Enter', 'code'), true)
  assert.equal(shouldCommitCanceledAsciiComposition('Shift', 'code'), true)
  assert.equal(shouldCommitCanceledAsciiComposition('CapsLock', 'code'), true)
  assert.equal(shouldCommitCanceledAsciiComposition('a', 'code'), false)
  assert.equal(shouldCommitCanceledAsciiComposition('Shift', '中文'), false)
})

test('ime only suppresses the terminal return key after enter-canceled ascii commit', () => {
  assert.equal(shouldSuppressReturnAfterCanceledAsciiCommit('Enter', 'code'), true)
  assert.equal(shouldSuppressReturnAfterCanceledAsciiCommit('Shift', 'code'), false)
  assert.equal(shouldSuppressReturnAfterCanceledAsciiCommit('Enter', '中文'), false)
})
