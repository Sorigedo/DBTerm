// S4.7 容量趋势：每次连接时快照文件大小 / 各表行数
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CapacitySnapshot {
  connId: string
  at: number
  fileSizeBytes: number
  tableRows: { name: string; rows: number }[]
}

const MAX_SNAPSHOTS_PER_CONN = 60

interface CapacityState {
  snapshots: CapacitySnapshot[]
  addSnapshot: (snap: CapacitySnapshot) => void
  getSnapshots: (connId: string) => CapacitySnapshot[]
  clear: (connId: string) => void
}

export const useCapacityStore = create<CapacityState>()(
  persist(
    (set, get) => ({
      snapshots: [],

      addSnapshot: (snap) => set(s => {
        const existing = s.snapshots.filter(x => x.connId === snap.connId)
        if (existing.length >= MAX_SNAPSHOTS_PER_CONN) {
          // Remove oldest
          const oldest = existing.sort((a, b) => a.at - b.at)[0]
          return { snapshots: s.snapshots.filter(x => x !== oldest).concat(snap) }
        }
        return { snapshots: [...s.snapshots, snap] }
      }),

      getSnapshots: (connId) => {
        return get().snapshots.filter(s => s.connId === connId).sort((a, b) => a.at - b.at)
      },

      clear: (connId) => set(s => ({ snapshots: s.snapshots.filter(x => x.connId !== connId) })),
    }),
    { name: 'dbterm_capacity_snapshots' }
  )
)
