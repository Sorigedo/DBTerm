import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDateQuickValue, resolveDateQuickFillKind } from './dateQuickFill.ts'

test('date quick fill is enabled from SQL column types, not column names', () => {
  assert.equal(resolveDateQuickFillKind('timestamp'), 'datetime')
  assert.equal(resolveDateQuickFillKind('datetime(3)'), 'datetime')
  assert.equal(resolveDateQuickFillKind('timestamp with time zone'), 'datetime')
  assert.equal(resolveDateQuickFillKind('date'), 'date')
  assert.equal(resolveDateQuickFillKind('time without time zone'), 'time')

  assert.equal(resolveDateQuickFillKind('varchar(255)'), null)
  assert.equal(resolveDateQuickFillKind('int'), null)
  assert.equal(resolveDateQuickFillKind(undefined), null)
})

test('date quick fill formats local date and date-time values for SQL editing', () => {
  const sample = new Date(2026, 8, 6, 7, 8, 9)

  assert.equal(formatDateQuickValue(sample, 'datetime'), '2026-09-06 07:08:09')
  assert.equal(formatDateQuickValue(sample, 'date'), '2026-09-06')
  assert.equal(formatDateQuickValue(sample, 'time'), '07:08:09')
})
