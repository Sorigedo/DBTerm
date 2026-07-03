// 多窗口（软件多开）支持：每个 WebviewWindow 是独立的 JS 上下文，模块在各窗口各加载一次。
// 这里生成一个「每窗口唯一」的标签，仅存内存——绝不可落 localStorage，
// 因为同进程多窗口共享 localStorage，落盘会让各窗口拿到同一个 tag 从而失去隔离意义。
//
// 用途：给后端有状态会话的 key（即 tab.id）加窗口后缀，避免两个窗口对同一连接生成相同
// sessionId 而撞上同一 PTY / SSH 会话 / 持久事务（appStore querySeq、单例 query、对象浏览
// 等 id 在不同窗口里本会重复）。
//
// 注意：标签撕离时被迁移的 tab.id 原样保留（含原窗口 tag），新窗口直接复用该字符串即可
// re-attach 到同一后端会话，无需再加自己的 tag。
export const WIN_TAG: string = Math.random().toString(36).slice(2, 8)

/** 给一个基础 id 追加本窗口标签，得到全局唯一的 tab.id / sessionId。 */
export function wid(base: string): string {
  return `${base}__w${WIN_TAG}`
}
