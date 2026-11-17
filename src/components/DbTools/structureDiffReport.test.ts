import test from 'node:test'
import assert from 'node:assert/strict'
import { formatStructureDiffReport } from './structureDiffReport.ts'

test('index definition summary explains missing and changed indexes by name and columns', () => {
  const report = formatStructureDiffReport({ ...data, tableDiff: { ...data.tableDiff, tableOptions: {
    kind: '索引和约束',
    source: 'PRIMARY KEY (`id`)\nUNIQUE KEY `uk_code` (`code`)\nKEY `idx_time` (`created_at`)',
    target: 'PRIMARY KEY (`id`)\nUNIQUE KEY `uk_code` (`code`,`tenant_id`)\nKEY `idx_old` (`created_at`)',
  } } }, 'txt')
  assert.match(report, /目标表需要新增索引 `idx_time`/)
  assert.match(report, /目标表需要删除索引 `idx_old`/)
  assert.match(report, /uk_code.*code.*tenant_id/s)
  assert.doesNotMatch(report, /CREATE TABLE/)
})

test('index summary parses backend comma-separated definitions with category prefix', () => {
  const report = formatStructureDiffReport({ ...data, tableDiff: { ...data.tableDiff, tableOptions: {
    kind: '索引和约束',
    source: '[索引和约束] PRIMARY KEY (`id`), UNIQUE KEY `uk_slot` (`device_no`,`slot_no`), KEY `idx_old` (`created_at`)',
    target: '[索引和约束] PRIMARY KEY (`id`), UNIQUE KEY `uk_slot` (`device_no`,`layer_no`), KEY `idx_new` (`created_at`)',
  } } }, 'txt')
  assert.match(report, /目标表需要新增索引 `idx_old`/)
  assert.match(report, /目标表需要删除索引 `idx_new`/)
  assert.match(report, /uk_slot.*layer_no.*slot_no/s)
  assert.doesNotMatch(report, /索引定义无法自动解析/)
  assert.match(report, /目标表需要新增索引 `idx_old`/)
  assert.match(report, /ALTER TABLE `a` ADD INDEX `idx_old`/)
  assert.match(report, /目标表需要删除索引 `idx_new`/)
  assert.match(report, /ALTER TABLE `a` DROP INDEX `idx_new`/)
  assert.match(report, /目标表索引 `uk_slot` 需要替换/)
  assert.match(report, /ALTER TABLE `a` DROP INDEX `uk_slot`/)
})

test('index summary parses the full-width category prefix returned by structure comparison', () => {
  const report = formatStructureDiffReport({ ...data, tableDiff: { ...data.tableDiff, tableOptions: {
    kind: '索引和约束',
    source: '【索引和约束】 PRIMARY KEY (`id`), UNIQUE KEY `uk_slot` (`device_no`,`slot_no`), KEY `idx_source` (`created_at`)',
    target: '【索引和约束】 PRIMARY KEY (`id`), UNIQUE KEY `uk_slot` (`device_no`,`layer_no`), KEY `idx_target` (`created_at`)',
  } } }, 'txt')
  assert.match(report, /目标表索引 `uk_slot` 需要替换/)
  assert.match(report, /目标表需要新增索引 `idx_source`/)
  assert.match(report, /目标表需要删除索引 `idx_target`/)
  assert.doesNotMatch(report, /索引定义无法自动解析/)
})

const data = { mode: 'table' as const, source: 'test.a', target: 'prod.a', alterSql: 'ALTER TABLE `a` MODIFY COLUMN `v` varchar(20);', tableDiff: { table: 'a', added: [], removed: [], modified: [{ name: 'v', before: { name: 'v', dataType: 'varchar(10)', nullable: false, key: '', defaultValue: null }, after: { name: 'v', dataType: 'varchar(20)', nullable: false, key: '', defaultValue: null }, beforeDefinition: '`v` varchar(10) NOT NULL COMMENT \'旧\'', afterDefinition: '`v` varchar(20) NOT NULL COMMENT \'新\'' }], tableOptions: null } }

test('structure diff report includes field definitions and ALTER SQL in markdown', () => {
  const report = formatStructureDiffReport(data, 'md')
  assert.match(report, /目标：prod\.a/)
  assert.match(report, /旧/)
  assert.match(report, /新/)
  assert.match(report, /ALTER TABLE/)
})

test('structure diff CSV quotes commas and newlines safely', () => {
  const report = formatStructureDiffReport({ ...data, tableDiff: { ...data.tableDiff, tableOptions: { kind: '表选项', source: 'COMMENT=\'a,b\'', target: 'COMMENT=\'x\\ny\'' } } }, 'csv')
  assert.ok(report.includes('"表级差异","a","","COMMENT=\'x\\ny\'","COMMENT=\'a,b\'"'))
})
