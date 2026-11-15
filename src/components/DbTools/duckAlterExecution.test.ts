import assert from 'node:assert/strict'
import test from 'node:test'
import { executeDuckAlter, DuckAlterOutcomeUnknown } from './duckAlterExecution.ts'

const statements = ['ALTER TABLE "main"."t" RENAME COLUMN "v" TO "name";', 'ALTER TABLE "main"."t" ALTER COLUMN "name" SET NOT NULL;']

test('DuckDB wizard sends original SQL as one isolated atomic batch', async () => {
  const calls: unknown[] = []
  await executeDuckAlter(async (command, args) => { calls.push([command, args]); }, 'fixture', statements)
  assert.deepEqual(calls, [['duckdb_alter_table_atomic', { id: 'fixture', statements }]])
})

test('DuckDB failed or unknown atomic request blocks resubmission without replay', async () => {
  const calls: string[] = []
  await assert.rejects(executeDuckAlter(async command => { calls.push(command); throw new Error('lost commit receipt'); }, 'fixture', statements), DuckAlterOutcomeUnknown)
  assert.deepEqual(calls, ['duckdb_alter_table_atomic'])
})

test('DuckDB empty ALTER batch never invokes backend', async () => {
  await executeDuckAlter(async () => { assert.fail('unexpected IPC') }, 'fixture', [])
})
