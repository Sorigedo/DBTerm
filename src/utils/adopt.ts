// 标签撕离：把一个标签（连同其活的后端会话）从当前窗口迁移到一个新窗口。
//
// 两个瞬时内存标记（绝不落盘）：
// - detaching：原窗口因「撕离」而关闭某 tab 时打上标记，Terminal 卸载时据此跳过 close_pty，
//   把后端 PTY/SSH 会话留给新窗口接管（普通关闭仍照常清理）。
// - adopt：新窗口接管某 tab 时打上标记，Terminal 挂载时据此走「接管」而非「新建」会话：
//   不再 connect_ssh / spawn_local_shell，而是直接挂监听 + resize 触发重绘。

const detaching = new Set<string>()
const adopting = new Set<string>()

export function markDetaching(id: string): void { detaching.add(id) }
export function isDetaching(id: string): boolean { return detaching.has(id) }
export function clearDetaching(id: string): void { detaching.delete(id) }

export function markAdopt(id: string): void { adopting.add(id) }
/** 消费一次接管标记：返回是否为接管挂载（消费后清除，之后 reconnect 走正常路径）。 */
export function consumeAdopt(id: string): boolean {
  const v = adopting.has(id)
  adopting.delete(id)
  return v
}

// ── 终端画面快照 ─────────────────────────────────────────────────────
// 后端 PTY 无法重放历史滚屏，撕离时把原窗口 xterm 的画面序列化、在新窗口还原。
// serializers：各终端在挂载时登记一个「序列化当前画面」的闭包，供撕离方调用取快照。
const serializers = new Map<string, () => string>()
export function registerSerializer(id: string, fn: () => string): void { serializers.set(id, fn) }
export function unregisterSerializer(id: string): void { serializers.delete(id) }
export function snapshotTerminal(id: string): string | null {
  try { return serializers.get(id)?.() ?? null } catch { return null }
}

// adoptSnapshots：新窗口接管前暂存的画面快照，Terminal 挂载时取出写回 xterm。
const adoptSnapshots = new Map<string, string>()
export function setAdoptSnapshot(id: string, snap: string): void { adoptSnapshots.set(id, snap) }
export function consumeAdoptSnapshot(id: string): string | null {
  const v = adoptSnapshots.get(id) ?? null
  adoptSnapshots.delete(id)
  return v
}
