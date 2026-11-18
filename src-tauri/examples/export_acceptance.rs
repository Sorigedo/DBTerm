//! Run only with a disposable fixture; no normal application startup or saved state.
#![allow(dead_code, unused_imports)]
#[path = "../src/commands/mod.rs"] mod commands;
#[path = "../src/connection_import.rs"] mod connection_import;
#[path = "../src/db_tunnel.rs"] mod db_tunnel;
#[path = "../src/keychain.rs"] mod keychain;
#[path = "../src/models.rs"] mod models;
#[path = "../src/pty.rs"] mod pty;
#[path = "../src/ssh/mod.rs"] mod ssh;
#[path = "../src/storage.rs"] mod storage;
#[path = "../src/tester.rs"] mod tester;
#[path = "../src/tracing_utils.rs"] mod tracing_utils;
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tauri::Manager;

#[tauri::command]
fn acceptance_progress(message: String) { eprintln!("probe: {message}"); }

#[tauri::command]
fn acceptance_result(result: serde_json::Value, app: tauri::AppHandle) {
    let root = std::env::var("DBTERM_ACCEPTANCE_ROOT").unwrap();
    std::fs::write(std::path::Path::new(&root).join("receipt.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    app.exit(if result["ok"].as_bool() == Some(true) { 0 } else { 1 });
}

fn main() {
    let root = std::path::PathBuf::from(std::env::var("DBTERM_ACCEPTANCE_ROOT").expect("explicit disposable fixture required"));
    assert!(root.is_absolute() && root.file_name().unwrap().to_string_lossy().starts_with("dbterm-native-export-"));
    let script = std::fs::read_to_string(root.join("probe.js")).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().build.dev_url = Some(std::env::var("DBTERM_ACCEPTANCE_URL").expect("fixture URL required").parse().unwrap());
    context.config_mut().identifier = "com.dbterm.acceptance.export".into();
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            keychain::init(&root);
            let storage = storage::Storage::new(root.clone()).unwrap();
            let config = serde_json::from_slice(&std::fs::read(root.join("fixture.json")).unwrap()).unwrap();
            storage.upsert(config).unwrap();
            app.manage(Mutex::new(storage) as storage::StorageState);
            app.manage(Arc::new(tokio::sync::Mutex::new(HashMap::new())) as commands::sqlserver::SsPool);
            app.manage(Arc::new(tokio::sync::Mutex::new(HashMap::new())) as commands::duckdb::DuckPool);
            app.manage(Arc::new(tokio::sync::Mutex::new(HashMap::new())) as commands::driver::DriverRegistry);
            app.manage(Arc::new(Mutex::new(HashMap::new())) as commands::db_export::ExportCancelMap);
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            eprintln!("acceptance page {:?}: {}", payload.event(), payload.url());
            if payload.event() == tauri::webview::PageLoadEvent::Finished { webview.eval(&script).unwrap(); }
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_export::db_stream_export,
            commands::db_extra::db_logical_backup,
            commands::db_extra::db_migrate_table,
            commands::db_extra::db_copy_table,
            commands::query::get_table_ddl,
            commands::query::execute_query,
            commands::query::table_columns,
            commands::query::update_cells,
            acceptance_progress,
            acceptance_result
        ])
        .run(context).expect("native export acceptance failed");
}
