export type DateQuickFillKind = 'date' | 'time' | 'datetime'

export function resolveDateQuickFillKind(dataType: string | null | undefined): DateQuickFillKind | null {
  const type = (dataType ?? '').trim().toLowerCase()
  if (!type) return null
  if (/\b(timestamp|datetime|timestamptz|smalldatetime|datetime2|datetimeoffset)\b/.test(type)) return 'datetime'
  if (/\bdate\b/.test(type)) return 'date'
  if (/\btime\b/.test(type)) return 'time'
  return null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatDateQuickValue(date: Date, kind: DateQuickFillKind): string {
  const yyyy = date.getFullYear()
  const mm = pad2(date.getMonth() + 1)
  const dd = pad2(date.getDate())
  const hh = pad2(date.getHours())
  const mi = pad2(date.getMinutes())
  const ss = pad2(date.getSeconds())
  if (kind === 'date') return `${yyyy}-${mm}-${dd}`
  if (kind === 'time') return `${hh}:${mi}:${ss}`
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}
