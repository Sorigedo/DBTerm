from pathlib import Path
root=Path(__file__).resolve().parents[2]
backend=(root/'src-tauri/src/commands/db_extra.rs').read_text().split('pub async fn db_import_csv(',1)[1].split('// ── 9.',1)[0]
assert 'super::import_records::records' in backend
assert 'content.lines()' not in backend
frontend=(root/'src/components/DbTools/ImportDialog.tsx').read_text()
assert 'read_delimited_file_header' in frontend
assert 'firstLine.split' not in frontend
assert 'commands::db_export::read_delimited_file_header' in (root/'src-tauri/src/lib.rs').read_text()
print('PASS CSV preview/import share record parsing; no physical line splitting; command registered.')
