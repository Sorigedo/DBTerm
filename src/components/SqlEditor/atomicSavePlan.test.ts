import test from 'node:test'
import assert from 'node:assert/strict'
import { planAtomicSave } from './atomicSavePlan.ts'

test('mixed changes fail before writes and homogeneous changes choose one batch', () => {
  assert.throws(() => planAtomicSave([{ type: 'insert' }, { type: 'update' }]), /尚不支持原子保存/)
  assert.equal(planAtomicSave([{ type: 'update' }, { type: 'update' }]), 'update')
  assert.equal(planAtomicSave([{ type: 'delete' }]), 'delete')
})
