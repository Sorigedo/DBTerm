/** Values from the grid are text, never inferred SQL keywords or numbers. */
export function tableDataLiteral(value: string | null, connType = 'sqlite'): string {
  if (value === null) return 'NULL'
  const quoted = value.replace(/'/g, "''")
  if (['mysql','mariadb','tidb','oceanBase'].includes(connType)) {
    const hex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2,'0')).join('')
    return "CONVERT(X'" + hex + "' USING utf8mb4)"
  }
  if (['postgres','kingBase','openGauss'].includes(connType)) return "E'" + quoted.split(String.fromCharCode(92)).join(String.fromCharCode(92,92)) + "'"
  if (connType === 'sqlServer') return "N'" + quoted + "'"
  if (connType === 'sqlite' && value.includes('\0')) {
    const hex = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2,'0')).join('')
    return "CAST(X'" + hex + "' AS TEXT)"
  }
  return "'" + quoted + "'"
}
