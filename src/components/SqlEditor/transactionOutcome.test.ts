import test from 'node:test'
import assert from 'node:assert/strict'
import { transactionFinishError } from './transactionOutcome.ts'
test('confirmed rollback keeps precise receipt instead of claiming commit is uncertain',()=>{
 const message='事务此前发生错误，PostgreSQL 已回滚，本次未提交任何变更'
 assert.equal(transactionFinishError('COMMIT','DBTERM_TX_ROLLED_BACK:'+message),message)
 assert.match(transactionFinishError('COMMIT','connection lost'),/提交结果未确认/)
 assert.equal(transactionFinishError('ROLLBACK','rollback rejected'),'rollback rejected')
})
test('script COMMIT uses confirmed rollback receipt for current and skipped statement messages',async()=>{
 const { transactionCommitFailure }=await import('./transactionOutcome.ts')
 assert.deepEqual(transactionCommitFailure('DBTERM_TX_ROLLED_BACK:已回滚'),{message:'已回滚',skipped:'事务已回滚，后续语句未执行'})
 assert.match(transactionCommitFailure('connection lost').skipped,/提交结果未确认/)
})
