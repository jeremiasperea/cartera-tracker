use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Una posicion de la cartera. `precio_manual` existe para instrumentos que
/// data912 no cubre (p.ej. fideicomisos financieros) o para cuando el ticker
/// no matchea ningun panel: el usuario carga el precio a mano.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    pub ticker: String,
    pub nombre: String,
    /// "accion" | "cedear" | "bono" | "on" | "nota" | "otro"
    pub tipo: String,
    pub cantidad: f64,
    pub precio_compra: f64,
    #[serde(default)]
    pub precio_manual: Option<f64>,
}

fn portfolio_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no pude resolver el directorio de datos de la app: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("no pude crear el directorio de datos ({}): {e}", dir.display()))?;
    Ok(dir.join("portfolio.json"))
}

#[tauri::command]
pub fn load_portfolio(app: AppHandle) -> Result<Vec<Position>, String> {
    let path = portfolio_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("no pude leer portfolio.json: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw)
        .map_err(|e| format!("portfolio.json tiene un formato invalido: {e}"))
}

#[tauri::command]
pub fn save_portfolio(app: AppHandle, positions: Vec<Position>) -> Result<(), String> {
    let path = portfolio_path(&app)?;
    let raw = serde_json::to_string_pretty(&positions)
        .map_err(|e| format!("no pude serializar la cartera: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("no pude guardar portfolio.json: {e}"))
}

/// Util para debug: devuelve donde esta guardado el archivo, para que puedas
/// ir a mirarlo/respaldarlo a mano si hace falta.
#[tauri::command]
pub fn portfolio_file_path(app: AppHandle) -> Result<String, String> {
    Ok(portfolio_path(&app)?.display().to_string())
}
