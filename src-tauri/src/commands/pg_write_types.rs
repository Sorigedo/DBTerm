use sqlx::PgConnection;
use std::collections::HashMap;
pub(super) async fn target_types(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> Result<HashMap<String, String>, String> {
    // Keep the inspected relation stable until the surrounding write commits.
    let target=format!("{}.{}",quote(schema),quote(table));
    sqlx::query(&format!("LOCK TABLE {target} IN ROW EXCLUSIVE MODE")).execute(&mut *conn).await.map_err(|e|e.to_string())?;
    let metadata:Vec<(String,String,String)>=sqlx::query_as("SELECT a.attname,n.nspname,t.typname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE cn.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped")
        .bind(schema).bind(table).fetch_all(conn).await.map_err(|e|e.to_string())?;
    Ok(metadata
        .into_iter()
        .map(|(column, ns, name)| (column, format!("{}.{}", quote(&ns), quote(&name))))
        .collect())
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
