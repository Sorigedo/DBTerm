// 对象编辑页保存句柄注册表：关闭确认弹窗的「保存并关闭」需要触发对应 tab 的保存。
// 所有标签页内容常驻挂载（仅 display 切换），故句柄在挂载期一直可用。
type SaveFn = () => Promise<boolean>   // 返回是否保存成功

const handlers = new Map<string, SaveFn>()

export function registerObjectSave(tabId: string, fn: SaveFn): void {
  handlers.set(tabId, fn)
}
export function unregisterObjectSave(tabId: string): void {
  handlers.delete(tabId)
}
export function getObjectSave(tabId: string): SaveFn | undefined {
  return handlers.get(tabId)
}
