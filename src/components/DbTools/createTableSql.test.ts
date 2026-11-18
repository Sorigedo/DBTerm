import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndexAlterStatements, validateMysqlExistingIndexEdits } from './createTableSql.ts'

const uniqueIndex = { name: 'g_barcode', columns: 'g_barcode', unique: true, method: 'BTREE' as const }

test('existing MySQL index changes are no longer blocked when source DDL is available', () => {
  assert.equal(validateMysqlExistingIndexEdits([{ ...uniqueIndex, unique: false }], [uniqueIndex]), null)
  assert.equal(validateMysqlExistingIndexEdits([], [uniqueIndex]), null)
  assert.equal(validateMysqlExistingIndexEdits([uniqueIndex, { ...uniqueIndex, name: 'new_idx' }], [uniqueIndex]), null)
})

test('deleting an existing index emits only DROP INDEX and allows save', () => {
  assert.equal(validateMysqlExistingIndexEdits([], [uniqueIndex]), null)
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [], [uniqueIndex]), [
    '  DROP INDEX `g_barcode`',
  ])
})

test('deleting an existing index with unrepresented expression columns is safe', () => {
  const functional = { ...uniqueIndex, name: 'uk_expression', columns: '' }
  assert.equal(validateMysqlExistingIndexEdits([], [functional]), null)
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [], [functional]), [
    '  DROP INDEX `uk_expression`',
  ])
})

test('unrepresented expression index is preserved when another index is added', () => {
  const functional = { ...uniqueIndex, name: 'uk_expression', columns: '' }
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [functional, { ...uniqueIndex, name: 'idx_new' }], [functional]), [
    '  ADD UNIQUE INDEX `idx_new` (`g_barcode`)',
  ])
})

test('changing a mysql index from unique to non-unique produces executable alter clauses', () => {
  const clauses = buildIndexAlterStatements('mysql', 'historical_prod', 'xmg_goods_store_list', [
    { ...uniqueIndex, unique: false },
  ], [uniqueIndex], undefined, "CREATE TABLE `xmg_goods_store_list` (\n  UNIQUE KEY `g_barcode` (`g_barcode`)\n) ENGINE=InnoDB")

  assert.deepEqual(clauses, [
    '  DROP INDEX `g_barcode`',
    '  ADD INDEX `g_barcode` (`g_barcode`)',
  ])
})

test('editing a MySQL index preserves original suffix options while changing its columns', () => {
  const current = { ...uniqueIndex, columns: 'tenant_id, g_barcode', unique: false }
  const ddl = "CREATE TABLE `t` (\n  `g_barcode` varchar(24),\n  `tenant_id` bigint,\n  UNIQUE KEY `g_barcode` (`g_barcode`) USING BTREE COMMENT 'kept' INVISIBLE\n) ENGINE=InnoDB"
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [current], [uniqueIndex], undefined, ddl), [
    '  DROP INDEX `g_barcode`',
    "  ADD INDEX `g_barcode` (`tenant_id`, `g_barcode`) COMMENT 'kept' INVISIBLE",
  ])
})

test('unchanged indexes do not make table ddl dirty', () => {
  assert.deepEqual(
    buildIndexAlterStatements('mysql', 'historical_prod', 'xmg_goods_store_list', [uniqueIndex], [uniqueIndex]),
    [],
  )
})

test('clearing an explicit BTREE method creates an ALTER that omits USING', () => {
  assert.deepEqual(buildIndexAlterStatements('mysql', 'db', 't', [{ ...uniqueIndex, method: 'DEFAULT' }], [uniqueIndex], undefined, "CREATE TABLE `t` (\n  UNIQUE KEY `g_barcode` (`g_barcode`) USING BTREE\n) ENGINE=InnoDB"), [
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
  assert.match(validateMysqlExistingIndexEdits([{ ...functionalIndex, columns: 'plan_code' }], [functionalIndex]) ?? '', /复杂索引/)
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
