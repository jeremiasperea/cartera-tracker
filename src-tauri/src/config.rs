use serde::{Deserialize, Serialize};

/// Mapeo entre tipos de instrumento y paneles de la API data912.
/// Fuente única de verdad. Si cambias esto, ambos lados (Rust + JS) usan lo mismo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentTypeConfig {
    pub id: String,
    pub label: String,
    pub panel: String,
}

#[tauri::command]
pub fn get_instrument_types() -> Vec<InstrumentTypeConfig> {
    vec![
        InstrumentTypeConfig {
            id: "accion".to_string(),
            label: "Accion".to_string(),
            panel: "arg_stocks".to_string(),
        },
        InstrumentTypeConfig {
            id: "cedear".to_string(),
            label: "CEDEAR".to_string(),
            panel: "arg_cedears".to_string(),
        },
        InstrumentTypeConfig {
            id: "bono".to_string(),
            label: "Bono".to_string(),
            panel: "arg_bonds".to_string(),
        },
        InstrumentTypeConfig {
            id: "on".to_string(),
            label: "ON".to_string(),
            panel: "arg_corp".to_string(),
        },
        InstrumentTypeConfig {
            id: "nota".to_string(),
            label: "Nota".to_string(),
            panel: "arg_notes".to_string(),
        },
        InstrumentTypeConfig {
            id: "otro".to_string(),
            label: "Otro".to_string(),
            panel: "".to_string(), // no tiene panel en data912
        },
    ]
}

/// Mapea tipo → panel. Retorna None si el tipo no existe o no tiene panel.
pub fn panel_for_tipo(tipo: &str) -> Option<&'static str> {
    match tipo {
        "accion" => Some("arg_stocks"),
        "cedear" => Some("arg_cedears"),
        "bono" => Some("arg_bonds"),
        "on" => Some("arg_corp"),
        "nota" => Some("arg_notes"),
        _ => None,
    }
}
