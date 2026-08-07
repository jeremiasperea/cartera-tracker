#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod market;
mod portfolio;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            config::get_instrument_types,
            portfolio::load_portfolio,
            portfolio::save_portfolio,
            portfolio::portfolio_file_path,
            market::get_cooldown_status,
            market::fetch_quotes,
            market::read_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicacion");
}
