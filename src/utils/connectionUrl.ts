import type { ConnConfig, ConnType } from '../types'

const MYSQL_CONN_TYPES = new Set<ConnType>(['mysql', 'mariadb', 'tidb', 'oceanBase'])
const PG_CONN_TYPES = new Set<ConnType>(['postgres', 'kingBase', 'openGauss'])

export function connUrlScheme(type: ConnType): string {
  if (MYSQL_CONN_TYPES.has(type)) return 'mysql'
  if (PG_CONN_TYPES.has(type)) return 'postgres'
  if (type === 'redis') return 'redis'
  if (type === 'clickHouse') return 'clickhouse'
  if (type === 'mongodb') return 'mongodb'
  return ''
}

export function isPostgresConnType(type: ConnType): boolean {
  return PG_CONN_TYPES.has(type)
}

export function buildConnUrl(
  form: ConnConfig,
  type: ConnType,
  password: string,
  urlParams = '',
  showPassword = false,
  hasSavedPassword = false,
): string {
  const scheme = connUrlScheme(type)
  if (!scheme) return ''
  const host = form.host || '127.0.0.1'
  const defaultPort = type === 'redis' ? 6379
    : MYSQL_CONN_TYPES.has(type) ? 3306
    : PG_CONN_TYPES.has(type) ? 5432 : 8123
  const port = form.port ?? defaultPort
  const user = form.username || ''
  const db = form.database || ''
  const hasPwd = !!password || hasSavedPassword
  const pwd = showPassword ? encodeURIComponent(password) : '***'
  let auth = ''
  if (user && hasPwd) auth = `${encodeURIComponent(user)}:${pwd}@`
  else if (user) auth = `${encodeURIComponent(user)}@`
  else if (hasPwd && type === 'redis') auth = `:${pwd}@`
  const qs = urlParams.trim() ? `?${urlParams.trim()}` : ''
  return `${scheme}://${auth}${host}:${port}${db ? '/' + encodeURIComponent(db) : ''}${qs}`
}

export function parseConnUrl(raw: string): {
  host?: string; port?: number; username?: string; password?: string
  database?: string; urlParams?: string
} {
  try {
    if (!raw.includes('://')) return {}
    const u = new URL(raw.trim())
    const r: ReturnType<typeof parseConnUrl> = {}
    if (u.hostname) r.host = u.hostname
    if (u.port) r.port = parseInt(u.port)
    if (u.username) r.username = decodeURIComponent(u.username)
    if (u.password && u.password !== '***') r.password = decodeURIComponent(u.password)
    const db = u.pathname.replace(/^\//, '')
    if (db) r.database = decodeURIComponent(db)
    if (u.search) r.urlParams = u.search.replace(/^\?/, '')
    return r
  } catch { return {} }
}
