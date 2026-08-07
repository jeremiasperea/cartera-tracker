use serde::{Deserialize, Serialize};

/// Tabla unica de tipos de instrumento: (id, label, panel de data912).
/// Un panel vacio significa que data912 no cubre ese tipo y el usuario
/// necesita cargar precio_manual (p.ej. fideicomisos financieros, FCI).
///
/// Esta es la unica fuente de verdad del mapeo. El frontend la consume via
/// get_instrument_types() y el fetcher via all_panels(): agregar un tipo aca
/// lo hace visible en la UI y lo empieza a traer de la API sin tocar nada mas.
const INSTRUMENT_TYPES: [(&str, &str, &str); 6] = [
    ("accion", "Accion", "arg_stocks"),
    ("cedear", "CEDEAR", "arg_cedears"),
    ("bono", "Bono", "arg_bonds"),
    ("on", "ON", "arg_corp"),
    ("nota", "Nota", "arg_notes"),
    ("otro", "Otro", ""),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentTypeConfig {
    pub id: String,
    pub label: String,
    pub panel: String,
}

#[tauri::command]
pub fn get_instrument_types() -> Vec<InstrumentTypeConfig> {
    INSTRUMENT_TYPES
        .iter()
        .map(|(id, label, panel)| InstrumentTypeConfig {
            id: id.to_string(),
            label: label.to_string(),
            panel: panel.to_string(),
        })
        .collect()
}

/// Paneles a consultar en data912: los tipos con cobertura automatica.
pub fn all_panels() -> Vec<&'static str> {
    INSTRUMENT_TYPES
        .iter()
        .filter(|(_, _, panel)| !panel.is_empty())
        .map(|(_, _, panel)| *panel)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// all_panels() alimenta el fetcher: si dejara pasar el panel vacio de
    /// "otro", se pediria https://data912.com/live/ y ese request fallaria
    /// en cada refresh.
    #[test]
    fn all_panels_excludes_types_without_coverage() {
        let panels = all_panels();
        assert!(!panels.is_empty());
        assert!(panels.iter().all(|p| !p.is_empty()));
        assert!(panels.contains(&"arg_stocks"));
        assert_eq!(panels.len(), INSTRUMENT_TYPES.len() - 1); // todos menos "otro"
    }

    /// El frontend indexa por `id`: dos tipos con el mismo id harian que uno
    /// pise al otro en TIPO_PANEL/TIPO_LABEL.
    #[test]
    fn instrument_type_ids_are_unique() {
        let types = get_instrument_types();
        let mut ids: Vec<&str> = types.iter().map(|t| t.id.as_str()).collect();
        ids.sort_unstable();
        let total = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), total, "hay ids duplicados en INSTRUMENT_TYPES");
    }
}
