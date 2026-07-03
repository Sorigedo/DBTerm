import { create } from 'zustand'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('非 Tauri 环境')
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export interface DbCapabilities {
  versionStr: string
  dbFlavor: string  // 'mysql'|'mariadb'|'tidb'|'oceanbase'|'postgres'|'kingbase'|'opengauss'|'clickhouse'|'sqlite'|'redis'
  versionMajor: number
  versionMinor: number
  versionPatch: number
  // MySQL / MariaDB 族
  isMariaDb: boolean
  isTiDb: boolean
  isOceanBase: boolean
  hasSequences: boolean
  hasSystemVersioning: boolean
  hasInvisibleColumns: boolean
  hasGalera: boolean
  hasPerformanceSchema: boolean
  hasMgrReplication: boolean
  // PostgreSQL 族
  isKingBase: boolean
  isOpenGauss: boolean
  serverVersionNum: number
  hasPgStatStatements: boolean
  hasDeclarativePartitioning: boolean
  hasLogicalReplication: boolean
  hasParallelVacuum: boolean
  hasMerge: boolean
  // ClickHouse
  hasAsyncInsert: boolean
  hasProjections: boolean
  hasLightweightDelete: boolean
  chIsCluster: boolean
}

const DEFAULT_CAPS: DbCapabilities = {
  versionStr: '', dbFlavor: '',
  versionMajor: 0, versionMinor: 0, versionPatch: 0,
  isMariaDb: false, isTiDb: false, isOceanBase: false,
  hasSequences: false, hasSystemVersioning: false, hasInvisibleColumns: false,
  hasGalera: false, hasPerformanceSchema: false, hasMgrReplication: false,
  isKingBase: false, isOpenGauss: false, serverVersionNum: 0,
  hasPgStatStatements: false, hasDeclarativePartitioning: false,
  hasLogicalReplication: false, hasParallelVacuum: false, hasMerge: false,
  hasAsyncInsert: false, hasProjections: false, hasLightweightDelete: false,
  chIsCluster: false,
}

interface DbCapsState {
  caps: Record<string, DbCapabilities>   // connId → capabilities
  loading: Record<string, boolean>
  errors: Record<string, string>
  detectCaps: (connId: string) => Promise<void>
  getCaps: (connId: string) => DbCapabilities
  clearCaps: (connId: string) => void
}

export const useDbCapsStore = create<DbCapsState>((set, get) => ({
  caps: {},
  loading: {},
  errors: {},

  detectCaps: async (connId: string) => {
    if (get().loading[connId]) return
    set(s => ({ loading: { ...s.loading, [connId]: true }, errors: { ...s.errors, [connId]: '' } }))
    try {
      const result = await invoke<DbCapabilities>('detect_db_caps', { connId })
      set(s => ({ caps: { ...s.caps, [connId]: result }, loading: { ...s.loading, [connId]: false } }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set(s => ({ loading: { ...s.loading, [connId]: false }, errors: { ...s.errors, [connId]: msg } }))
    }
  },

  getCaps: (connId: string) => get().caps[connId] ?? DEFAULT_CAPS,

  clearCaps: (connId: string) => {
    set(s => {
      const caps = { ...s.caps }
      const loading = { ...s.loading }
      const errors = { ...s.errors }
      delete caps[connId]
      delete loading[connId]
      delete errors[connId]
      return { caps, loading, errors }
    })
  },
}))
