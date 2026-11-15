from pathlib import Path
root=Path(__file__).resolve().parents[2]
s=(root/'src-tauri/src/commands/db_extra.rs').read_text().split('pub async fn db_logical_backup(',1)[1].split('// 打开输出文件（流式写）',1)[0]
assert 'dispatch_ss_archive_ddl' in s,'archive currently embeds FK/index statements inside per-table DDL before other tables/data exist'
assert 'post_data_statements' in s,'archive needs structured deferred DDL rather than regex SQL splitting'
assert 'post-data.sql' in s,'deferred indexes/constraints must be a final archive entry'
assert s.index('zip.start_file("post-data.sql"')>s.index('total_rows_backed += row_count'),'deferred DDL entry must follow all table data'
assert 'split("ALTER' not in s
print('PASS backup uses structured post-data DDL after all table streams; no expression rewriting.')

assert 'post_data_statements.iter().chain(&constraint_statements)' in s, 'all unique indexes must precede any foreign keys'

assert '.chain(&constraint_statements).chain(&trigger_statements)' in s, 'triggers must be installed after data/index/constraints'
