import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./DataDiffPanel.tsx', import.meta.url), 'utf8')

test('panel preserves null semantics and metadata ownership before scan', () => {
  assert.ok(source.includes('equalDiffCells(sv, dv)'))
  assert.ok(source.includes('isBinaryDiffType(result.column_types[col])'))
  assert.ok(source.includes('if (!metadataReady)'))
  assert.ok(source.includes('resultSelectionKey === selectionKey'))
  assert.ok(!source.includes("String(d.srcRow[col] ?? '')"))
  assert.ok(source.includes('encoding={result.column_encodings[col]}'))
  assert.ok(source.includes('encoding={result.column_encodings[c]}'))
  assert.ok(source.includes('SET 字段按内部位图、ENUM 字段按内部序号比对并展示'))
})

test('comparison samples never generate executable synchronization SQL', () => {
  assert.doesNotMatch(source, /generateSyncSql|WHERE \$\{where\}|1=1|复制同步 SQL|复制样本 SQL/)
  assert.match(source, /JSON\.stringify\(\{ context: resultContext, sampleOnly: result\.sample_capped, result \}/)
  assert.match(source, /复制部分差异 JSON/)
})

test('comparison responses and progress are bound to immutable request epoch', () => {
  assert.ok(source.includes('requestOwner.current(epoch)'))
  assert.ok(source.includes('selectionRef.current === selectionKey'))
  assert.ok(source.includes('requestOwner.finish(epoch)'))
  assert.match(source, /if \(!current\(\)\) return/g)
  assert.match(source, /windowId: eventId/)
  assert.ok(source.includes('unlisten?.()'))
  assert.match(source, /各自快照中未发现差异/)
  assert.doesNotMatch(source, /两表数据完全一致/)
})
