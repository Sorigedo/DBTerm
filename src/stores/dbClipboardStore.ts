import { create } from 'zustand'
import type { ConnType } from '../types'

export type DbObjType = 'table' | 'view' | 'function' | 'procedure'

/** 库树中一个可被选中/复制的对象（表/视图/函数/存储过程） */
export interface DbObjRef {
  connectionId: string
  connType: ConnType
  schema: string
  objType: DbObjType
  name: string
}

export function sameObj(a: DbObjRef | null, b: DbObjRef | null): boolean {
  if (!a || !b) return false
  return a.connectionId === b.connectionId && a.schema === b.schema
    && a.objType === b.objType && a.name === b.name
}

interface DbClipboardState {
  /** 当前选中的对象（用于高亮 + Mod+C 复制目标），全局唯一 */
  selected: DbObjRef | null
  /** 已复制到内部剪贴板的对象（用于库内粘贴/迁移），与系统剪贴板的对象名同步设置 */
  clipboard: DbObjRef | null
  /** 多选复制时的全部表名（单选时长度为 1 = [clipboard.name]）；多表迁移用 */
  clipboardTables: string[]
  select:   (o: DbObjRef | null) => void
  copy:     (o: DbObjRef) => void
  /** 多选复制：primary 作为主对象（提供 conn/schema/objType 上下文），names 为全部表名 */
  copyMany: (primary: DbObjRef, names: string[]) => void
  clear:    () => void
}

export const useDbClipboard = create<DbClipboardState>((set) => ({
  selected: null,
  clipboard: null,
  clipboardTables: [],
  select:   (selected) => set({ selected }),
  copy:     (clipboard) => set({ clipboard, clipboardTables: [clipboard.name] }),
  copyMany: (primary, names) => set({ clipboard: primary, clipboardTables: names }),
  clear:    () => set({ clipboard: null, clipboardTables: [] }),
}))
