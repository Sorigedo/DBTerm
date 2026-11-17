import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndexAlterStatements, moveIndex, validateMysqlExistingIndexEdits } from './createTableSql.ts'

const uniqueIndex = { name: 'g_barcode', columns: 'g_barcode', unique: true, method: 'BTREE' as const }

test('moving an index changes its position without changing other indexes', () => {
  const indexes = [
    { ...uniqueIndex, _id: 'a' },
    { ...uniqueIndex, name: 'idx_b', _id: 'b' },
    { ...uniqueIndex, name: 'idx_c', _id: 'c' },
  ]
  assert.deepEqual(moveIndex(indexes, 'b', 1).map(index => index._id), ['a', 'c', 'b'])
  assert.deepEqual(moveIndex(indexes, 'a', -1), indexes)
})

test('existing MySQL index cannot be rebuilt from its incomplete metadata summary', () => {
  assert.match(validateMysqlExistingIndexEdits([{ ...uniqueIndex, unique: false }], [uniqueIndex]) ?? '', /原始 DDL/)
  assert.match(validateMysqlExistingIndexEdits([], [uniqueIndex]) ?? '', /原始 DDL/)
  assert.equal(validateMysqlExistingIndexEdits([uniqueIndex, { ...uniqueIndex, name: 'new_idx' }], [uniqueIndex]), null)
})

test('moving existing indexes is allowed and does not generate index DDL', () => {
  const a = { ...uniqueIndex, _id: 'a' }
  const b = { ...uniqueIndex, name: 'idx_b', _id: 'b' }
  const moved = moveIndex([a, b], 'b', -1)
  assert.equal(validateMysqlExistingIndexEdits(moved, [a, b]), null)
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', moved, [a, b]), [])
})

test('changing a mysql index from unique to non-unique produces executable alter clauses', () => {
  const clauses = buildIndexAlterStatements('mysql', 'historical_prod', 'xmg_goods_store_list', [
    { ...uniqueIndex, unique: false },
  ], [uniqueIndex])

  assert.deepEqual(clauses, [
    '  DROP INDEX `g_barcode`',
    '  ADD INDEX `g_barcode` (`g_barcode`)',
  ])
})

test('unchanged indexes do not make table ddl dirty', () => {
  assert.deepEqual(
    buildIndexAlterStatements('mysql', 'historical_prod', 'xmg_goods_store_list', [uniqueIndex], [uniqueIndex]),
    [],
  )
})

test('clearing an explicit BTREE method creates an ALTER that omits USING', () => {
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [{ ...uniqueIndex, method: 'DEFAULT' }], [uniqueIndex]), [
    '  DROP INDEX `g_barcode`',
    '  ADD UNIQUE INDEX `g_barcode` (`g_barcode`)',
  ])
})

test('unrepresented functional index is not dropped by an unrelated table edit', () => {
  const functionalIndex = {
    name: 'uk_pos_settlement_plan_code', columns: '', unique: true, method: 'BTREE' as const,
  }
  assert.deepEqual(
    buildIndexAlterStatements('mysql', 'b', 'mc_pos_settlement_company',
      [functionalIndex, { ...uniqueIndex, name: 'idx_new', unique: false }],
      [functionalIndex]),
    ['  ADD INDEX `idx_new` (`g_barcode`)'],
  )
})

test('unrepresented functional index cannot be replaced by a regular index through metadata guesswork', () => {
  const functionalIndex = { name: 'uk_pos_settlement_plan_code', columns: '', unique: true, method: 'BTREE' as const }
  assert.deepEqual(
    buildIndexAlterStatements('mysql', 'b', 'mc_pos_settlement_company',
      [{ ...functionalIndex, columns: 'plan_code' }], [functionalIndex]),
    [],
  )
})

test('all mysql-family engines emit ALTER clauses for removing a regular index', () => {
  for (const connType of ['tidb', 'oceanBase'] as const) {
    assert.deepEqual(
      buildIndexAlterStatements(connType, 'b', 't', [], [uniqueIndex]),
      ['  DROP INDEX `g_barcode`'],
    )
  }
})


test('MySQL fulltext and spatial indexes retain their method when edited', () => {
 for (const method of ['FULLTEXT', 'SPATIAL'] as const) {
  const clauses=buildIndexAlterStatements('mysql','db','t',[{name:'search',columns:'body',unique:false,method}],[])
  assert.ok(clauses[0].includes('ADD '+method+' INDEX'))
 }
})
test('an unnamed new index receives its default name on ALTER too', () => {
 const tick=String.fromCharCode(96)
 assert.deepEqual(buildIndexAlterStatements('mysql','db','t',[{name:'',columns:'body',unique:false,method:'BTREE'}],[]),['  ADD INDEX '+tick+'idx_body'+tick+' ('+tick+'body'+tick+')'])
})
