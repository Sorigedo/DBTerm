// Exercise both production XLSX writers; independently inspect OOXML with Python.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as xlsx from 'xlsx';

const root = new URL('../../', import.meta.url);
const single = await readFile(new URL('src/components/SqlEditor/ResultTable.tsx', root), 'utf8');
const multi = await readFile(new URL('src/components/SqlEditor/ExportDialog.tsx', root), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'production export anchors must exist');
  return source.slice(from, to).replace(/ as ArrayBuffer/g, '');
}
const columns = ['中文', '前导零', '高精度文本', '公式文本', '空值', '数字', '布尔'];
const rows = [
  ['中文\n第二行 & < >', '00123', '123456789012345678901234567890', '=1+1', null, 42, true],
  ['', '000', '0.123456789012345678901234567890', '+SUM(A1)', '', -2.5, false],
  ['末行', '01', '9007199254740993', '@SUM(A1)', null, 0, true],
];
const result = { columns, rows };
const singleCode = section(single, 'const wsData = [result.columns,', "await invoke('write_local_bytes'");
const multiCode = section(multi, 'const wb = xlsx.utils.book_new()', "const { invoke } = await import('@tauri-apps/api/core')");
const singleBytes = new Function('xlsx', 'result', 'rows', singleCode + '\nreturn buf;')(xlsx, result, rows);
const multiBytes = new Function('xlsx', 'resultSets', multiCode + '\nreturn bytes;')(xlsx, [{result}, {result: {columns: ['另表'], rows: [['保留中文']]}}]);
const fixture = await mkdtemp(join(tmpdir(), 'dbterm-xlsx-export-'));
try {
  await writeFile(join(fixture, 'single.xlsx'), singleBytes);
  await writeFile(join(fixture, 'multi.xlsx'), multiBytes);
  const inspector = String.raw`
import json, sys, zipfile, xml.etree.ElementTree as E
from pathlib import Path
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def inspect(path):
    with zipfile.ZipFile(path) as z:
        wb=E.fromstring(z.read('xl/workbook.xml'))
        names=[s.attrib['name'] for s in wb.findall('m:sheets/m:sheet',ns)]
        strings=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            strings=[''.join(s.itertext()) for s in E.fromstring(z.read('xl/sharedStrings.xml'))]
        sheets=[]
        for i in range(len(names)):
            sheet=E.fromstring(z.read('xl/worksheets/sheet'+str(i+1)+'.xml'))
            cells={}
            for c in sheet.findall('.//m:sheetData/m:row/m:c',ns):
                assert c.find('m:f',ns) is None, 'formula-like text became executable formula'
                v=c.find('m:v',ns)
                value=v.text if v is not None else ''
                if c.attrib.get('t')=='s': value=strings[int(value)]
                if c.attrib.get('t')=='inlineStr': value=''.join(c.find('m:is',ns).itertext())
                cells[c.attrib['r']]={'type':c.attrib.get('t','n'),'value':value or ''}
            sheets.append(cells)
        return {'names':names,'sheets':sheets}
print(json.dumps({name:inspect(Path(sys.argv[1])/(name+'.xlsx')) for name in ['single','multi']},ensure_ascii=False))
`;
  const decoded = JSON.parse(execFileSync('python3', ['-c', inspector, fixture], {encoding:'utf8'}));
  assert.deepEqual(decoded.single.names, ['查询结果']);
  assert.deepEqual(decoded.multi.names, ['结果1', '结果2']);
  for (const kind of ['single', 'multi']) {
    const cells = decoded[kind].sheets[0];
    for (let col = 0; col < columns.length; col++) assert.equal(cells[String.fromCharCode(65 + col) + '1'].value, columns[col]);
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < columns.length; col++) {
        const expected = rows[row][col];
        const cell = cells[String.fromCharCode(65 + col) + (row + 2)];
        if (expected == null) {
          if (kind === 'multi') assert.equal(cell, undefined);
          else assert.equal(cell.value, '');
        } else {
          assert.ok(cell);
          assert.equal(cell.value, typeof expected === 'boolean' ? (expected ? '1' : '0') : String(expected));
          assert.equal(cell.type, typeof expected === 'boolean' ? 'b' : typeof expected === 'number' ? 'n' : 'str');
        }
      }
    }
  }
  assert.equal(decoded.multi.sheets[1].A2.value, '保留中文');
  console.log(JSON.stringify({passed:true, xlsxVersion:xlsx.version, writers:2, dataCellsChecked:42, independentReader:'Python OOXML XML parser', scope:'actual writer code; no native IPC or Excel application'}));
} finally {
  await rm(fixture, {recursive:true, force:true});
}
