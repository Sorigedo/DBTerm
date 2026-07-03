// 把毫秒格式化为 DataGrip 风格的时分秒毫秒：
//  382      -> "382 ms"
//  2530     -> "2 s 530 ms"
//  163603   -> "2 m 43 s 603 ms"
//  3725000  -> "1 h 2 m 5 s 0 ms"
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`
  const total = Math.round(ms)
  if (total < 1000) return `${total} ms`
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const rem = total % 1000
  const parts: string[] = []
  if (h) parts.push(`${h} h`)
  if (h || m) parts.push(`${m} m`)
  if (h || m || s) parts.push(`${s} s`)
  parts.push(`${rem} ms`)
  return parts.join(' ')
}
