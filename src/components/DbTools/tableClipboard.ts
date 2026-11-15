export type GridValue = string | null
export interface GridSelection { rows: number[]; columns: number[] }
export interface GridEdit { ri: number; ci: number; oldValue: GridValue; newValue: GridValue; pkValues: GridValue[] }
export function editableGridExtra(extra:string):boolean{return !/(?:virtual|stored)[ ]+generated|^generated$|identity|auto_increment/i.test(extra.trim())}
export function validateGridBudget(edits:GridEdit[]){if(edits.length>10000)throw new Error('累计暂存超过 10000 个单元格');let bytes=0;for(const e of edits){bytes+=JSON.stringify(e).length*3;if(bytes>8*1024*1024)throw new Error('粘贴数据及原值超过 8 MiB 安全预算，请缩小区域')}return edits}
export const encodeGridText = (values: GridValue[][]) => values.map(row=>row.map(v=>{const s=v??'NULL';return /["\t\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s}).join('\t')).join('\n')
export function parseGridText(text: string): string[][] {
 if(text.length>8*1024*1024)throw new Error('剪贴板超过 8 MiB，请分批粘贴')
 const rows:string[][]=[];let row:string[]=[],value='',quoted=false,closed=false,cells=0
 for(let i=0;i<text.length;i++){const ch=text[i]
  if(quoted){if(ch==='"'){if(text[i+1]==='"'){value+='"';i++}else{quoted=false;closed=true}}else value+=ch;continue}
  if(ch==='"'&&value===''&&!closed){quoted=true;continue}
  if(ch==='\t'||ch==='\r'||ch==='\n'){if(++cells>10000)throw new Error('剪贴板超过 10000 个单元格');row.push(value);value='';closed=false;if(ch!=='\t'){rows.push(row);row=[];if(ch==='\r'&&text[i+1]==='\n')i++}continue}
  if(closed)throw new Error('剪贴板引号后的内容格式错误');value+=ch
 }
 if(quoted)throw new Error('剪贴板包含未闭合引号')
 if(row.length||value!==''||!rows.length||!/[\r\n]$/.test(text)){if(++cells>10000)throw new Error('剪贴板超过 10000 个单元格');rows.push([...row,value])}
 if(rows.some(r=>r.length!==rows[0].length))throw new Error('粘贴内容每行列数不一致')
 return rows
}
export function planGridPaste(input:{rows:GridValue[][];columns:string[];keys:string[];meta:Record<string,{nullable:boolean;editable:boolean}>;selection:GridSelection;values:GridValue[][]}):GridEdit[]{
 const {rows,columns,keys,meta,selection,values}=input
 if(!selection.rows.length||!selection.columns.length||!values.length||!values[0]?.length)throw new Error('请先选择目标单元格或列')
 if(!keys.length||keys.some(k=>!columns.includes(k)))throw new Error('未识别完整主键，禁止粘贴写入')
 if(values.some(r=>r.length!==values[0].length||r.some(v=>v!==null&&typeof v!=='string')))throw new Error('剪贴板单元格格式无效')
 let ris=[...selection.rows],cis=[...selection.columns];const scalar=values.length===1&&values[0].length===1
 if(!scalar&&ris.length===1&&cis.length===1){ris=values.map((_,i)=>ris[0]+i);cis=values[0].map((_,i)=>cis[0]+i)}
 if(!scalar&&(values.length!==ris.length||values[0].length!==cis.length))throw new Error('粘贴区域大小与选区不一致；单个值可填充整个选区')
 if(ris.length*cis.length>10000)throw new Error('一次最多粘贴 10000 个单元格')
 const edits:GridEdit[]=[]
 for(let r=0;r<ris.length;r++)for(let c=0;c<cis.length;c++){const ri=ris[r],ci=cis[c],col=columns[ci],m=meta[col]
  if(!rows[ri]||ci<0||ci>=columns.length)throw new Error('粘贴超出当前页边界，请缩小区域')
  if(!m||!m.editable||keys.includes(col))throw new Error(`字段 ${col} 是主键、生成列、只读列或缺少可靠元数据，已取消整次粘贴`)
  const next=scalar?values[0][0]:values[r][c];if(next===null&&!m.nullable)throw new Error(`字段 ${col} 不允许 NULL，已取消整次粘贴`)
  const pkValues=keys.map(k=>rows[ri][columns.indexOf(k)]);if(pkValues.some(v=>v===null||v===undefined))throw new Error('目标行主键为空，已取消整次粘贴')
  edits.push({ri,ci,oldValue:rows[ri][ci],newValue:next,pkValues:[...pkValues]})
 }return edits
}
export function mergeGridEdits(previous:GridEdit[],next:GridEdit[]):GridEdit[]{const map=new Map(previous.map(e=>[`${e.ri}:${e.ci}`,e]));for(const edit of next){const key=`${edit.ri}:${edit.ci}`,old=map.get(key);map.set(key,{...edit,oldValue:old?old.oldValue:edit.oldValue,pkValues:old?old.pkValues:edit.pkValues})}return [...map.values()].filter(e=>e.oldValue!==e.newValue)}
export function groupGridEdits(edits:GridEdit[],columns:string[],keys:string[]){const groups=new Map<number,{columns:string[];values:GridValue[];pkColumns:string[];pkValues:GridValue[];expectedValues:GridValue[]}>();for(const e of edits){const row=groups.get(e.ri)??{columns:[],values:[],pkColumns:[...keys],pkValues:[...e.pkValues],expectedValues:[]};row.columns.push(columns[e.ci]);row.values.push(e.newValue);row.expectedValues.push(e.oldValue);groups.set(e.ri,row)}return [...groups.values()]}
