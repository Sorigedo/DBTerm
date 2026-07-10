import type { ConnType } from '../../types'
import { stripSqlComments } from './sqlSplit.ts'

export type TransactionControl = 'begin' | 'commit' | 'rollback'

const TX_TYPES = new Set<ConnType>([
  'mysql', 'mariadb', 'tidb', 'oceanBase',
  'postgres', 'kingBase', 'openGauss',
  'sqlite', 'duckdb', 'sqlServer', 'oracle',
])

function normalized(sql: string): string {
  return stripSqlComments(sql)
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

/** 只识别完整的事务控制语句，避免把 PL/SQL BEGIN 块、SAVEPOINT 回滚等误判。 */
export function transactionControlStatement(sql: string, connType: ConnType): TransactionControl | null {
  if (!TX_TYPES.has(connType)) return null
  const text = normalized(sql)
  if (!text) return null

  if (connType !== 'oracle') {
    if (['mysql', 'mariadb', 'tidb', 'oceanBase'].includes(connType)) {
      if (/^(?:BEGIN(?: WORK)?|START TRANSACTION)$/.test(text)) return 'begin'
    } else if (['postgres', 'kingBase', 'openGauss', 'duckdb'].includes(connType)) {
      if (/^(?:BEGIN(?: WORK| TRANSACTION)?|START TRANSACTION)$/.test(text)) return 'begin'
    } else if (connType === 'sqlite') {
      if (/^BEGIN(?: (?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?: TRANSACTION)?$/.test(text)) return 'begin'
    } else if (connType === 'sqlServer') {
      if (/^BEGIN (?:TRAN|TRANSACTION)$/.test(text)) return 'begin'
    }
  }

  if (connType === 'sqlServer') {
    if (/^COMMIT(?: (?:TRAN|TRANSACTION))?$/.test(text)) return 'commit'
    if (/^ROLLBACK(?: (?:TRAN|TRANSACTION))?$/.test(text)) return 'rollback'
    return null
  }

  if (/^COMMIT(?: WORK)?$/.test(text)) return 'commit'
  if (/^(?:ROLLBACK|ABORT)(?: WORK)?$/.test(text)) return 'rollback'
  if (connType !== 'mysql' && connType !== 'mariadb' && connType !== 'tidb' && connType !== 'oceanBase' && /^END(?: TRANSACTION)?$/.test(text)) return 'commit'
  return null
}

/** 显式事务开始前可安全搬到同一 MySQL 会话执行的连接级语句。 */
export function isMysqlTransactionPreamble(sql: string): boolean {
  return /^(?:SET|USE)\b/.test(normalized(sql))
}

/** 仅拦截由“手动提交模式”准备自动 BEGIN 的混合脚本；显式事务脚本由用户控制边界。 */
export function shouldBlockMixedAutoTransaction(
  txMode: boolean,
  txActive: boolean,
  hasScriptTxControl: boolean,
  transactionalDmlCount: number,
  writeCount: number,
): boolean {
  return txMode
    && !txActive
    && !hasScriptTxControl
    && transactionalDmlCount > 0
    && writeCount > transactionalDmlCount
}
