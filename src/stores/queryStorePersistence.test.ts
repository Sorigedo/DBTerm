import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDebouncedStorage } from './queryStorePersistence.ts'

describe('query store persistence', () => {
  it('coalesces writes and flushes the latest value immediately', () => {
    const writes: Array<[string, string]> = []
    const storage = createDebouncedStorage({
      getItem: () => null,
      setItem: (name, value) => writes.push([name, value]),
      removeItem: () => {},
    }, 60_000)

    storage.setItem('dbterm-query-sqls', 'first')
    storage.setItem('dbterm-query-sqls', 'latest')
    assert.deepEqual(writes, [])

    storage.flush()
    assert.deepEqual(writes, [['dbterm-query-sqls', 'latest']])
  })

  it('writes once after the input quiet period', async () => {
    const writes: Array<[string, string]> = []
    const storage = createDebouncedStorage({
      getItem: () => null,
      setItem: (name, value) => writes.push([name, value]),
      removeItem: () => {},
    }, 20)

    storage.setItem('dbterm-query-sqls', 'first')
    await new Promise(resolve => setTimeout(resolve, 8))
    storage.setItem('dbterm-query-sqls', 'latest')
    await new Promise(resolve => setTimeout(resolve, 8))
    assert.deepEqual(writes, [])

    await new Promise(resolve => setTimeout(resolve, 24))
    assert.deepEqual(writes, [['dbterm-query-sqls', 'latest']])
  })
})
