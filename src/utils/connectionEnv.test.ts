import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLegacyDbEnv, normalizeDbExtraForSave, normalizeEnvLabelForSave } from './connectionEnv.ts'
import type { ConnConfig } from '../types/index.ts'

function conn(overrides: Partial<ConnConfig>): ConnConfig {
  return {
    id: 'c1',
    name: '测试连接',
    type: 'mysql',
    host: '127.0.0.1',
    useSsl: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

test('envLabel null keeps 无 instead of re-migrating legacy isProduction', () => {
  const migrated = applyLegacyDbEnv(conn({
    envLabel: null,
    extraJson: JSON.stringify({ isProduction: true }),
  }))

  assert.equal(migrated.envLabel, null)
})

test('missing envLabel still migrates legacy isProduction to prod', () => {
  const migrated = applyLegacyDbEnv(conn({
    extraJson: JSON.stringify({ isProduction: true }),
  }))

  assert.equal(migrated.envLabel, 'prod')
})

test('saving DB config clears legacy production flags and stores null for 无', () => {
  assert.equal(normalizeEnvLabelForSave(undefined), null)
  assert.equal(normalizeEnvLabelForSave(null), null)
  assert.deepEqual(
    normalizeDbExtraForSave({ sslMode: 'disabled', readOnly: true, isProduction: true }),
    { sslMode: 'disabled', readOnly: false, isProduction: false },
  )
})
