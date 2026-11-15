import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { preserveObjectDdl, objectSaveSql } from './objectDdlSafety.ts'
test('object editor preserves full header security qualifiers body and literal text', () => {
  const raw = "CREATE ALGORITHM=MERGE DEFINER=`owner`@`%` SQL SECURITY DEFINER VIEW `a`.`v` AS SELECT '`a`.keep /*x*/' FROM `a`.`table`"
  assert.equal(preserveObjectDdl(raw), raw)
})
test('saving routine or sqlite view never injects destructive DROP', () => {
  const routine = 'CREATE DEFINER=`o`@`%` PROCEDURE `p`() BEGIN SELECT 1; END'
  assert.equal(objectSaveSql(routine), routine)
  assert.equal(objectSaveSql('CREATE VIEW v AS SELECT broken'), 'CREATE VIEW v AS SELECT broken')
})
test('object save invokes only the edited SQL without automatic routine or view deletion', () => {
  const source = readFileSync(new URL('../components/SqlEditor/ObjectEditor.tsx', import.meta.url), 'utf8')
  const save = source.slice(source.indexOf('const handleSave ='), source.indexOf('// 注册保存句柄'))
  assert.ok(save.includes('const execSql = objectSaveSql(ddl)'))
  assert.match(save, /sql: execSql/)
  assert.doesNotMatch(save, /DROP\s+(?:FUNCTION|PROCEDURE|VIEW)/i)
  const loader = readFileSync(new URL('./objectEditor.ts', import.meta.url), 'utf8')
  assert.ok(loader.includes('return preserveObjectDdl(raw)'))
})
