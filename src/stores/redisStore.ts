// Redis 状态管理（R0–R4 独立 Store，不影响 SQL 侧 Store）
import { create } from 'zustand'

export interface RedisKeyInfo { key: string; kind: string; ttl: number }
export interface RedisDbInfo   { db: number; keys: number; expires: number }
export interface RedisServerCaps {
  version: string
  caps: number
  mode: string
  os: string
}

// 能力位定义（与 Rust 侧 CAP_* 常量对应）
export const CAP_MEMORY_USAGE  = 1 << 0
export const CAP_UNLINK        = 1 << 1
export const CAP_ACL           = 1 << 2
export const CAP_SCAN_TYPE     = 1 << 3
export const CAP_COPY          = 1 << 4
export const CAP_XAUTOCLAIM    = 1 << 5
export const CAP_ERROR_STATS   = 1 << 6
export const CAP_LATENCY_STATS = 1 << 7

export function hasCap(caps: number, cap: number): boolean {
  return (caps & cap) !== 0
}

interface RedisConnState {
  // 每个连接 ID 对应的运行时状态
  caps: RedisServerCaps | null
  activeDb: number         // 当前选中的 DB 索引
  dbList: RedisDbInfo[]    // 各 DB key 数量
}

interface RedisStore {
  // key: connectionId
  connStates: Record<string, RedisConnState>

  getCaps(connId: string): RedisServerCaps | null
  getActiveDb(connId: string): number
  getDbList(connId: string): RedisDbInfo[]

  setCaps(connId: string, caps: RedisServerCaps): void
  setActiveDb(connId: string, db: number): void
  setDbList(connId: string, list: RedisDbInfo[]): void
  clearConn(connId: string): void
}

const DEFAULT_CONN_STATE: RedisConnState = {
  caps: null,
  activeDb: 0,
  dbList: [],
}

export const useRedisStore = create<RedisStore>((set, get) => ({
  connStates: {},

  getCaps:     (id) => get().connStates[id]?.caps ?? null,
  getActiveDb: (id) => get().connStates[id]?.activeDb ?? 0,
  getDbList:   (id) => get().connStates[id]?.dbList ?? [],

  setCaps: (id, caps) => set(s => ({
    connStates: {
      ...s.connStates,
      [id]: { ...(s.connStates[id] ?? DEFAULT_CONN_STATE), caps },
    }
  })),

  setActiveDb: (id, db) => set(s => ({
    connStates: {
      ...s.connStates,
      [id]: { ...(s.connStates[id] ?? DEFAULT_CONN_STATE), activeDb: db },
    }
  })),

  setDbList: (id, dbList) => set(s => ({
    connStates: {
      ...s.connStates,
      [id]: { ...(s.connStates[id] ?? DEFAULT_CONN_STATE), dbList },
    }
  })),

  clearConn: (id) => set(s => {
    const next = { ...s.connStates }
    delete next[id]
    return { connStates: next }
  }),
}))
