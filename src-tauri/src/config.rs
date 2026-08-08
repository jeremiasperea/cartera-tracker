use serde::{Deserialize, Serialize};

/// Tabla unica de tipos de instrumento:
/// (id, label corto, label de formulario, panel de data912).
///
/// Hay dos labels a proposito. El corto va en la columna "Tipo" de la tabla,
/// donde el espacio es escaso; el de formulario desambigua en el desplegable
/// del dialogo, donde el usuario elige a ciegas y "ON" no dice nada.
///
/// Un panel vacio significa que data912 no cubre ese tipo y el usuario
/// necesita cargar precio_manual (p.ej. fideicomisos financieros, FCI).
///
/// Esta es la unica fuente de verdad del mapeo: el frontend la consume via
/// get_instrument_types() —para renderizar la tabla y para llenar el
/// desplegable— y el fetcher via all_panels(). Agregar un tipo aca alcanza.
const INSTRUMENT_TYPES: [(&str, &str, &str, &str); 6] = [
    ("accion", "Accion", "Accion local", "arg_stocks"),
    ("cedear", "CEDEAR", "CEDEAR", "arg_cedears"),
    ("bono", "Bono", "Bono", "arg_bonds"),
    ("on", "ON", "Obligacion negociable", "arg_corp"),
    ("nota", "Nota", "Letra / nota", "arg_notes"),
    ("otro", "Otro", "Otro (sin cotizacion automatica)", ""),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstrumentTypeConfig {
    pub id: String,
    pub label: String,
    pub form_label: String,
    pub panel: String,
}

#[tauri::command]
pub fn get_instrument_types() -> Vec<InstrumentTypeConfig> {
    INSTRUMENT_TYPES
        .iter()
        .map(|(id, label, form_label, panel)| InstrumentTypeConfig {
            id: id.to_string(),
            label: label.to_string(),
            form_label: form_label.to_string(),
            panel: panel.to_string(),
        })
        .collect()
}

/// Paneles a consultar en data912: los tipos con cobertura automatica.
pub fn all_panels() -> Vec<&'static str> {
    INSTRUMENT_TYPES
        .iter()
        .filter(|(_, _, _, panel)| !panel.is_empty())
        .map(|(_, _, _, panel)| *panel)
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

    /// El desplegable del dialogo se llena con `form_label`. Uno vacio seria
    /// una opcion en blanco: seleccionable pero imposible de identificar.
    #[test]
    fn every_type_has_labels_for_both_surfaces() {
        for t in get_instrument_types() {
            assert!(!t.label.trim().is_empty(), "label vacio en '{}'", t.id);
            assert!(
                !t.form_label.trim().is_empty(),
                "form_label vacio en '{}'",
                t.id
            );
        }
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
