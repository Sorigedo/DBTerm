import type { ConnType } from '../types'
import {
  CLICKHOUSE_FUNCTIONS,
  DUCKDB_FUNCTIONS,
  MARIADB_FUNCTIONS,
  MYSQL_FUNCTIONS,
  ORACLE_FUNCTIONS,
  POSTGRES_FUNCTIONS,
  SQLITE_FUNCTIONS,
  SQLSERVER_FUNCTIONS,
  TIDB_FUNCTIONS,
} from './sqlFunctionCatalog.ts'

// Compatibility products inherit the function surface of their base dialect.
// Version-specific additions stay here so updating the generated catalog remains mechanical.
const DIALECT_FUNCTIONS: Partial<Record<ConnType, readonly string[]>> = {
  mysql: MYSQL_FUNCTIONS,
  mariadb: MARIADB_FUNCTIONS,
  tidb: TIDB_FUNCTIONS,
  oceanBase: MYSQL_FUNCTIONS,
  postgres: POSTGRES_FUNCTIONS,
  kingBase: POSTGRES_FUNCTIONS,
  openGauss: POSTGRES_FUNCTIONS,
  sqlServer: SQLSERVER_FUNCTIONS,
  oracle: ORACLE_FUNCTIONS,
  sqlite: SQLITE_FUNCTIONS,
  duckdb: DUCKDB_FUNCTIONS,
  clickHouse: CLICKHOUSE_FUNCTIONS,
}

const DIALECT_ADDITIONS: Partial<Record<ConnType, readonly string[]>> = {
  mysql: ['JSON_TABLE', 'REGEXP_LIKE', 'REGEXP_INSTR', 'REGEXP_REPLACE', 'REGEXP_SUBSTR'],
  mariadb: ['JSON_TABLE', 'REGEXP_REPLACE', 'REGEXP_SUBSTR'],
  postgres: ['GEN_RANDOM_UUID', 'JSONB_SET_LAX', 'STRING_TO_TABLE'],
  kingBase: ['GEN_RANDOM_UUID'],
  openGauss: ['GENERATE_SERIES'],
  sqlServer: ['JSON_ARRAY', 'JSON_OBJECT', 'REGEXP_LIKE', 'REGEXP_REPLACE'],
  oracle: ['DBMS_LOB', 'JSON_SERIALIZE', 'JSON_TRANSFORM', 'SYS_EXTRACT_UTC', 'UTL_RAW'],
  sqlite: ['JSON_EACH', 'JSON_TREE', 'TIMEDIFF'],
  duckdb: ['EPOCH_MS', 'EPOCH_NS', 'EPOCH_US', 'READ_CSV', 'READ_JSON', 'READ_PARQUET'],
  clickHouse: ['FORMATDATETIME', 'GROUPARRAY', 'JSONEXTRACTSTRING', 'TO_UNIXTIMESTAMP'],
}

export function sqlFunctionsForDialect(connType: ConnType): string[] {
  return Array.from(new Set([
    ...(DIALECT_FUNCTIONS[connType] ?? []),
    ...(DIALECT_ADDITIONS[connType] ?? []),
  ])).sort()
}
