import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConnUrl, parseConnUrl } from './connectionUrl.ts'
import type { ConnConfig } from '../types/index.ts'

function conn(overrides: Partial<ConnConfig>): ConnConfig {
  return {
    id: 'c1',
    name: '测试连接',
    type: 'mysql',
    host: 'db.example.com',
    port: 3306,
    username: 'root',
    database: 'app',
    useSsl: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

test('buildConnUrl masks password while password input is hidden', () => {
  assert.equal(
    buildConnUrl(conn({}), 'mysql', 's3cret!', 'charset=utf8mb4', false),
    'mysql://root:***@db.example.com:3306/app?charset=utf8mb4',
  )
})

test('buildConnUrl masks saved password before it is loaded in edit mode', () => {
  assert.equal(
    buildConnUrl(conn({}), 'mysql', '', 'charset=utf8mb4', false, true),
    'mysql://root:***@db.example.com:3306/app?charset=utf8mb4',
  )
})

test('buildConnUrl reveals password when password input is visible', () => {
  assert.equal(
    buildConnUrl(conn({}), 'mysql', 's3cret!', 'charset=utf8mb4', true),
    'mysql://root:s3cret!@db.example.com:3306/app?charset=utf8mb4',
  )
})

test('buildConnUrl encodes revealed password for url safety', () => {
  assert.equal(
    buildConnUrl(conn({}), 'mysql', 'p@ss word/#', '', true),
    'mysql://root:p%40ss%20word%2F%23@db.example.com:3306/app',
  )
})

test('buildConnUrl reveals redis password without username', () => {
  assert.equal(
    buildConnUrl(conn({ type: 'redis', username: '', database: '0', port: 6379 }), 'redis', 'redis-pass', '', true),
    'redis://:redis-pass@db.example.com:6379/0',
  )
})

test('parseConnUrl ignores masked password and keeps existing saved password untouched', () => {
  assert.deepEqual(
    parseConnUrl('mysql://root:***@db.example.com:3306/app?charset=utf8mb4'),
    {
      host: 'db.example.com',
      port: 3306,
      username: 'root',
      database: 'app',
      urlParams: 'charset=utf8mb4',
    },
  )
})
