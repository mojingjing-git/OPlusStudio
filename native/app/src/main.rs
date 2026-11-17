#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
use commands::{
    State, cancel, export_diagnostic, initial, inputs, keymap_dismiss_warning, keymap_export,
    keymap_import, keymap_save_store, keymap_set_enabled, keymap_set_recording,
    keymap_sync_bridge, preview, run, runner_state,
};
use std::sync::atomic::Ordering;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(State::default())
        .invoke_handler(tauri::generate_handler![
            run,
            inputs,
            runner_state,
            cancel,
            initial,
            preview,
            keymap_set_enabled,
            keymap_dismiss_warning,
            keymap_set_recording,
            keymap_save_store,
            keymap_sync_bridge,
            keymap_import,
            keymap_export,
            export_diagnostic,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<State>();
                // First stop MacroRunner and release all injected keys without blocking on BLE!
                state.0.macro_runner.shutdown();
                if state.0.busy.load(Ordering::SeqCst) {
                    api.prevent_close();
                    state.0.close_requested.store(true, Ordering::SeqCst);
                    state.0.cancel.store(true, Ordering::SeqCst);
                    use tauri::Emitter;
                    let _ = window.emit("status", "正在完成操作并恢复配置，完成后关闭");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("O+ Studio could not start");
}
