/** Prove every projected value is its named base column before enabling writes. */
export function parseEditableProjection(sql: string): { schema: string; table: string; projected: string[] | null } | null {
 if (/\b(?:UNION|INTERSECT|EXCEPT|JOIN|WITH)\b|--|\/\*|#/.test(sql.toUpperCase())) return null
 const tick=String.fromCharCode(96)
 const ident='(?:[A-Za-z_][A-Za-z0-9_$]*|'+tick+'(?:'+tick+tick+'|[^'+tick+'])+'+tick+'|"(?:""|[^"])+")'
 const decode=(v:string)=>v.startsWith(tick)?v.slice(1,-1).split(tick+tick).join(tick):v.startsWith('"')?v.slice(1,-1).replace(/""/g,'"'):v
 const m=new RegExp('^\\s*SELECT\\s+([\\s\\S]+?)\\s+FROM\\s+('+ident+')(?:\\s*\\.\\s*('+ident+'))?(?:\\s+(?:AS\\s+)?(?!WHERE\\b|ORDER\\b|LIMIT\\b)('+ident+'))?\\s*(?:(?:WHERE|ORDER\\s+BY|LIMIT)\\s+[^;]*)?;?\\s*$','i').exec(sql)
 if(!m || /\b(?:SELECT|JOIN|UNION|GROUP|HAVING|FOR|INTO)\b/i.test(m[1]))return null
 const table=decode(m[3]??m[2]),schema=m[3]?decode(m[2]):'',alias=m[4]?decode(m[4]):table
 if(m[1].trim()==='*'||m[1].trim()===alias+'.*'||m[1].trim()===table+'.*')return {schema,table,projected:null}
 const cols:string[]=[]
 for(const part of m[1].split(',')){
  const col=new RegExp('^\\s*(?:('+ident+')\\s*\\.\\s*)?('+ident+')(?:\\s+(?:AS\\s+)?('+ident+'))?\\s*$','i').exec(part)
  if(!col)return null
  const name=decode(col[2]);if(col[1]&&![alias,table].includes(decode(col[1])))return null
  if(col[3]&&decode(col[3])!==name)return null
  if(cols.includes(name))return null;cols.push(name)
 }
 return {schema,table,projected:cols}
}
export function editableProjectionColumns(target:ReturnType<typeof parseEditableProjection>,result:string[],base:string[],pk:string[]):boolean{
 return !!target && new Set(result).size===result.length && result.every(n=>base.includes(n)) && pk.length>0 && pk.every(n=>result.includes(n)) && (target.projected===null || target.projected.length===result.length&&target.projected.every((n,i)=>n===result[i]))
}
