import { create } from 'zustand'

export interface ConnGroup {
  id: string
  name: string
}

const GROUPS_KEY    = 'conn-groups'
const MAP_KEY       = 'conn-group-map'
const COLLAPSE_KEY  = 'conn-groups-collapsed'
const GROUP_ORDER_KEY = 'conn-group-order'   // 分组之间的自定义顺序（groupId[]）
const CONN_ORDER_KEY  = 'conn-order'         // 各「桶」内连接的自定义顺序（bucket → connId[]）

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') } catch { return fallback }
}

interface GroupState {
  groups: ConnGroup[]
  connGroupMap: Record<string, string>
  collapsedGroups: string[]
  groupOrder: string[]                       // 分组自定义顺序
  connOrder: Record<string, string[]>        // bucket → connId[]，bucket 为 groupId 或 __local/__ssh/__db

  addGroup: (name: string) => string
  deleteGroup: (id: string) => void
  renameGroup: (id: string, name: string) => void
  toggleCollapsed: (id: string) => void
  moveToGroup: (connId: string, groupId: string) => void
  collapseAll: () => void
  expandAll: () => void
  setGroupOrder: (ids: string[]) => void
  setConnOrder: (bucket: string, ids: string[]) => void
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups:         load<ConnGroup[]>(GROUPS_KEY, []),
  connGroupMap:   load<Record<string, string>>(MAP_KEY, {}),
  collapsedGroups: load<string[]>(COLLAPSE_KEY, []),
  groupOrder:     load<string[]>(GROUP_ORDER_KEY, []),
  connOrder:      load<Record<string, string[]>>(CONN_ORDER_KEY, {}),

  addGroup: (name) => {
    const id = `group-${Date.now()}`
    const next = [...get().groups, { id, name }]
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
    set({ groups: next })
    return id
  },

  deleteGroup: (id) => {
    const next = get().groups.filter(g => g.id !== id)
    const map = { ...get().connGroupMap }
    Object.keys(map).forEach(k => { if (map[k] === id) delete map[k] })
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
    localStorage.setItem(MAP_KEY, JSON.stringify(map))
    set({ groups: next, connGroupMap: map })
  },

  renameGroup: (id, name) => {
    const next = get().groups.map(g => g.id === id ? { ...g, name } : g)
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
    set({ groups: next })
  },

  toggleCollapsed: (id) => {
    const cur = get().collapsedGroups
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
    set({ collapsedGroups: next })
  },

  moveToGroup: (connId, groupId) => {
    const map = { ...get().connGroupMap }
    if (groupId) map[connId] = groupId
    else delete map[connId]
    localStorage.setItem(MAP_KEY, JSON.stringify(map))
    set({ connGroupMap: map })
  },

  collapseAll: () => {
    const ids = get().groups.map(g => g.id)
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(ids))
    set({ collapsedGroups: ids })
  },

  expandAll: () => {
    localStorage.setItem(COLLAPSE_KEY, '[]')
    set({ collapsedGroups: [] })
  },

  setGroupOrder: (ids) => {
    localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(ids))
    set({ groupOrder: ids })
  },

  setConnOrder: (bucket, ids) => {
    const next = { ...get().connOrder, [bucket]: ids }
    localStorage.setItem(CONN_ORDER_KEY, JSON.stringify(next))
    set({ connOrder: next })
  },
}))
