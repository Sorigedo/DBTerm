// 新建视图/函数/存储过程设计页的草稿：向导生成 DDL 后存入，ObjectEditor 挂载时读取
import { create } from 'zustand'

export type ObjType = 'view' | 'function' | 'procedure'

export interface ObjectDraft {
  schema: string
  objType: ObjType
  name: string
  ddl: string
  mode: 'create' | 'edit'
}

interface ObjectDraftState {
  drafts: Record<string, ObjectDraft>  // tabId → draft
  setDraft: (tabId: string, draft: ObjectDraft) => void
  getDraft: (tabId: string) => ObjectDraft | undefined
  clearDraft: (tabId: string) => void
}

export const useObjectDraftStore = create<ObjectDraftState>((set, get) => ({
  drafts: {},
  setDraft: (tabId, draft) => set((s) => ({ drafts: { ...s.drafts, [tabId]: draft } })),
  getDraft: (tabId) => get().drafts[tabId],
  clearDraft: (tabId) =>
    set((s) => {
      const next = { ...s.drafts }
      delete next[tabId]
      return { drafts: next }
    }),
}))
