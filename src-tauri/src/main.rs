#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::SidecarState;

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> sidecar::SidecarStatus {
    state.status.lock().unwrap().clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_status])
        .setup(|app| {
            if let Err(e) = sidecar::spawn_sidecar(app.handle()) {
                sidecar::fail(app.handle(), format!("sidecar 启动失败：{e}"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
