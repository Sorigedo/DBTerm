/** Preserve SHOW CREATE output byte for byte except for its declared object identifier. */
export function relocateMysqlObjectDdl(
  ddl: string, kind: 'VIEW' | 'FUNCTION' | 'PROCEDURE',
  sourceSchema: string, sourceName: string, targetRef: string,
): string {
  if (/^\s*CREATE\s+OR\s+REPLACE\b/i.test(ddl)) {
    throw new Error('源定义包含 OR REPLACE，无法安全迁移')
  }
  const ident = '`(?:``|[^`])*`'
  const account = '(?:`(?:``|[^`])*`|[^\s@]+)'
  const header = new RegExp(
    '^\\s*CREATE\\s+'
      + '(?:ALGORITHM\\s*=\\s*(?:UNDEFINED|MERGE|TEMPTABLE)\\s+)?'
      + '(?:DEFINER\\s*=\\s*' + account + '@' + account + '\\s+)?'
      + '(?:SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)\\s+)?'
      + kind + '\\s+(' + ident + '(?:\\s*\\.\\s*' + ident + ')?)'
      + (kind === 'VIEW' ? '(?=\\s+AS\\b)' : '(?=\\s*\\()'),
    'i',
  )
  const match = header.exec(ddl)
  if (!match) throw new Error('无法安全解析源对象定义，目标未修改')
  const name = /^`((?:``|[^`])*)`(?:\s*\.\s*`((?:``|[^`])*)`)?$/.exec(match[1])
  if (!name) throw new Error('无法安全解析源对象名，目标未修改')
  const decode = (s: string) => s.replace(/``/g, '`')
  const actualName = decode(name[2] ?? name[1])
  const actualSchema = name[2] === undefined ? null : decode(name[1])
  if (actualName !== sourceName || (actualSchema !== null && actualSchema !== sourceSchema)) {
    throw new Error('源对象定义与选中对象不匹配，目标未修改')
  }
  const start = match[0].length - match[1].length
  return ddl.slice(0, start) + targetRef + ddl.slice(start + match[1].length)
}
