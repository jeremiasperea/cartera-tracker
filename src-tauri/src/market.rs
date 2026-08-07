use crate::config;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const COOLDOWN_SECONDS: i64 = 300; // 5 minutos, pedido explicitamente por el usuario
const BASE_URL: &str = "https://data912.com";

/// Errores que el frontend necesita distinguir por programa, no solo mostrar.
/// Serializa como objeto etiquetado — {"kind":"cooldown","remaining_s":42} —
/// asi el frontend hace `err.kind === "cooldown"` en vez de parsear un prefijo
/// de string. Agregar una variante no rompe al que ya maneja las existentes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MarketError {
    /// Todavia falta esperar `remaining_s` segundos para el proximo refresh.
    Cooldown { remaining_s: i64 },
    /// No se pudo construir el cliente HTTP. `message` es para mostrar.
    Client { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Quote {
    pub symbol: String,
    pub c: Option<f64>,
    pub pct_change: Option<f64>,
    pub px_bid: Option<f64>,
    pub px_ask: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MarketSnapshot {
    pub fetched_at_ms: i64,
    /// panel -> (symbol -> Quote)
    pub panels: HashMap<String, HashMap<String, Quote>>,
    /// paneles que fallaron (red, formato inesperado, etc). No aborta todo
    /// el refresh: mejor traer lo que se pueda y avisar que hubo un problema
    /// parcial, en vez de dejar al usuario sin nada.
    pub errores: Vec<String>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no pude resolver el directorio de datos de la app: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("no pude crear el directorio de datos ({}): {e}", dir.display()))?;
    Ok(dir)
}

fn cooldown_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("cooldown.txt"))
}

fn snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("snapshot.json"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn read_last_fetch(app: &AppHandle) -> i64 {
    let path = match cooldown_path(app) {
        Ok(p) => p,
        Err(_) => return 0,
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

fn write_last_fetch(app: &AppHandle, ts: i64) {
    if let Ok(path) = cooldown_path(app) {
        // Si esto falla no rompemos el refresh: en el peor caso el cooldown
        // no persiste entre reinicios de la app, que no es grave.
        let _ = fs::write(path, ts.to_string());
    }
}

fn write_snapshot(app: &AppHandle, snapshot: &MarketSnapshot) {
    // Best-effort igual que el cooldown: si no se puede escribir, el refresh
    // ya trajo los datos y el usuario los ve. Solo se pierde la persistencia.
    if let Ok(path) = snapshot_path(app) {
        if let Ok(raw) = serde_json::to_string(snapshot) {
            let _ = fs::write(path, raw);
        }
    }
}

/// Ultimo snapshot guardado en disco, o None si nunca se trajeron cotizaciones.
/// Un archivo corrupto se trata como ausente: un cache invalido no debe impedir
/// que la app arranque, y el proximo refresh lo reescribe.
#[tauri::command]
pub fn read_snapshot(app: AppHandle) -> Option<MarketSnapshot> {
    let path = snapshot_path(&app).ok()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Segundos restantes de cooldown. 0 si ya se puede pedir cotizaciones de nuevo.
/// Se persiste en disco (no solo en memoria/frontend) para que cerrar y volver
/// a abrir la app no resetee la espera.
#[tauri::command]
pub fn get_cooldown_status(app: AppHandle) -> i64 {
    let last = read_last_fetch(&app);
    let elapsed_s = (now_ms() - last) / 1000;
    (COOLDOWN_SECONDS - elapsed_s).max(0)
}

/// Trae cotizaciones de los paneles cubiertos por data912. Si el cooldown sigue
/// activo devuelve MarketError::Cooldown con los segundos restantes, que el
/// frontend usa para arrancar la cuenta regresiva.
///
/// Un panel que falla no aborta el refresh: se acumula en `errores` y se
/// devuelve Ok con lo que si se pudo traer.
#[tauri::command]
pub async fn fetch_quotes(app: AppHandle) -> Result<MarketSnapshot, MarketError> {
    let remaining = get_cooldown_status(app.clone());
    if remaining > 0 {
        return Err(MarketError::Cooldown {
            remaining_s: remaining,
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| MarketError::Client {
            message: format!("no pude crear el cliente http: {e}"),
        })?;

    let mut panels: HashMap<String, HashMap<String, Quote>> = HashMap::new();
    let mut errores = Vec::new();

    for panel in config::all_panels() {
        let url = format!("{BASE_URL}/live/{panel}");
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<Vec<Quote>>().await {
                Ok(quotes) => {
                    let map: HashMap<String, Quote> =
                        quotes.into_iter().map(|q| (q.symbol.clone(), q)).collect();
                    panels.insert(panel.to_string(), map);
                }
                Err(e) => errores.push(format!("{panel}: respuesta con formato inesperado ({e})")),
            },
            Ok(resp) => errores.push(format!("{panel}: HTTP {}", resp.status())),
            Err(e) => errores.push(format!("{panel}: fallo de red ({e})")),
        }
    }

    // Un unico timestamp para el cooldown y para el snapshot: si se llamara
    // now_ms() dos veces, el cooldown y la fecha mostrada podrian diferir.
    let fetched_at_ms = now_ms();

    // Marcamos el intento como "gastado" aunque algunos paneles hayan fallado:
    // asi el cooldown sigue haciendo su trabajo (no permitir reintentos en loop).
    write_last_fetch(&app, fetched_at_ms);

    let snapshot = MarketSnapshot {
        fetched_at_ms,
        panels,
        errores,
    };

    // Persistimos para que recargar la app no pierda las cotizaciones ya
    // traidas: el cooldown se guardaba en disco pero el snapshot no, asi que
    // tras un reinicio el usuario quedaba esperando sin datos que mostrar.
    write_snapshot(&app, &snapshot);

    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> MarketSnapshot {
        let mut stocks = HashMap::new();
        stocks.insert(
            "GGAL".to_string(),
            Quote {
                symbol: "GGAL".to_string(),
                c: Some(7250.5),
                pct_change: Some(-1.25),
                px_bid: Some(7240.0),
                px_ask: None,
            },
        );
        let mut panels = HashMap::new();
        panels.insert("arg_stocks".to_string(), stocks);

        MarketSnapshot {
            fetched_at_ms: 1_770_000_000_000,
            panels,
            errores: vec!["arg_bonds: HTTP 503".to_string()],
        }
    }

    /// El snapshot se guarda como JSON y se relee al arrancar la app: si algun
    /// campo no sobrevive el round-trip, el usuario recupera datos incompletos.
    #[test]
    fn snapshot_survives_json_round_trip() {
        let original = sample_snapshot();
        let raw = serde_json::to_string(&original).expect("serializa");
        let restored: MarketSnapshot = serde_json::from_str(&raw).expect("deserializa");

        assert_eq!(restored.fetched_at_ms, original.fetched_at_ms);
        assert_eq!(restored.errores, original.errores);

        let quote = &restored.panels["arg_stocks"]["GGAL"];
        assert_eq!(quote.symbol, "GGAL");
        assert_eq!(quote.c, Some(7250.5));
        assert_eq!(quote.pct_change, Some(-1.25));
        assert_eq!(quote.px_bid, Some(7240.0));
        assert_eq!(quote.px_ask, None);
    }

    /// Un snapshot.json corrupto se trata como "no hay cache", no como un error
    /// que impida arrancar: read_snapshot devuelve None en vez de propagar.
    #[test]
    fn corrupt_snapshot_json_deserializes_to_none() {
        assert!(serde_json::from_str::<MarketSnapshot>("{ no es json }").is_err());
        assert!(serde_json::from_str::<MarketSnapshot>("").is_err());
    }

    /// Contrato con el frontend: app.js hace `err.kind === "cooldown"` y lee
    /// `err.remaining_s`. Cambiar el tag o el rename_all de MarketError romperia
    /// la cuenta regresiva sin que nada falle en Rust.
    #[test]
    fn cooldown_error_matches_frontend_contract() {
        let raw = serde_json::to_string(&MarketError::Cooldown { remaining_s: 42 })
            .expect("serializa");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("es json");

        assert_eq!(v["kind"], "cooldown");
        assert_eq!(v["remaining_s"], 42);
    }

    /// El frontend muestra `err.message` para cualquier kind que no sea cooldown.
    #[test]
    fn client_error_carries_a_message_for_display() {
        let raw = serde_json::to_string(&MarketError::Client {
            message: "no pude crear el cliente http: timeout".to_string(),
        })
        .expect("serializa");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("es json");

        assert_eq!(v["kind"], "client");
        assert!(v["message"].as_str().expect("message es string").contains("timeout"));
    }
}
