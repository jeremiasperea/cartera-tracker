use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const COOLDOWN_SECONDS: i64 = 300; // 5 minutos, pedido explicitamente por el usuario
const BASE_URL: &str = "https://data912.com";

// Paneles "live" de data912 que nos importan para una cartera tipica.
// No existe panel de fideicomisos financieros ni de FCI: esos instrumentos
// siempre van a quedar en "otro" y van a necesitar precio_manual.
const PANELS: [&str; 5] = ["arg_stocks", "arg_cedears", "arg_bonds", "arg_corp", "arg_notes"];

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

fn cooldown_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no pude resolver el directorio de datos de la app: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("no pude crear el directorio de datos ({}): {e}", dir.display()))?;
    Ok(dir.join("cooldown.txt"))
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

/// Segundos restantes de cooldown. 0 si ya se puede pedir cotizaciones de nuevo.
/// Se persiste en disco (no solo en memoria/frontend) para que cerrar y volver
/// a abrir la app no resetee la espera.
#[tauri::command]
pub fn get_cooldown_status(app: AppHandle) -> i64 {
    let last = read_last_fetch(&app);
    let elapsed_s = (now_ms() - last) / 1000;
    (COOLDOWN_SECONDS - elapsed_s).max(0)
}

/// Trae cotizaciones de los 5 paneles relevantes. Devuelve Err("COOLDOWN:N")
/// si todavia faltan N segundos: el frontend parsea ese prefijo para mostrar
/// la cuenta regresiva. Es una convencion cruda a proposito, para no sumar
/// otro tipo de error serializado solo para este caso.
#[tauri::command]
pub async fn fetch_quotes(app: AppHandle) -> Result<MarketSnapshot, String> {
    let remaining = get_cooldown_status(app.clone());
    if remaining > 0 {
        return Err(format!("COOLDOWN:{remaining}"));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("no pude crear el cliente http: {e}"))?;

    let mut panels: HashMap<String, HashMap<String, Quote>> = HashMap::new();
    let mut errores = Vec::new();

    for panel in PANELS {
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

    // Marcamos el intento como "gastado" aunque algunos paneles hayan fallado:
    // asi el cooldown sigue haciendo su trabajo (no permitir reintentos en loop).
    write_last_fetch(&app, now_ms());

    Ok(MarketSnapshot {
        fetched_at_ms: now_ms(),
        panels,
        errores,
    })
}
