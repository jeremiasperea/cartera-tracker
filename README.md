# Cartera Tracker

App de escritorio (Tauri 2, backend en Rust, frontend HTML/CSS/JS plano sin
bundler) para seguir una cartera de acciones/CEDEARs/bonos con cotizaciones
manuales via [data912.com](https://data912.com), una API publica sin API key.

## Estado real de este proyecto

**Este codigo no se compilo ni se corrio.** El sandbox donde lo escribi no
tiene Rust instalado y no tiene salida de red hacia data912.com ni hacia
crates.io para bajar dependencias, asi que no pude correr `cargo tauri dev`
ni verificar el JSON real que devuelve la API contra los structs de Rust.
Lo que si verifique:

- Sintaxis de `app.js` (`node --check`, sin errores).
- Los 2 archivos JSON de configuracion son JSON valido.
- Los endpoints y campos de data912 (`symbol`, `c`, `pct_change`, `px_bid`,
  `px_ask`, `q_bid`, `q_ask`, `q_op`) los saque del `openapi-spec.json` real
  del repo publico que documenta esa API, no de memoria.

Lo mas probable si corres `cargo tauri dev` ahora mismo es que compile con
algun error chico de la API de Tauri v2 (nombres de metodos que cambiaron
entre versiones, por ejemplo `app.path()` vs otra forma de resolver
`app_data_dir`). Pegame el error del compilador tal cual y lo arreglamos con
precision en vez de que yo adivine de nuevo.

## Por que Tauri y no un server + browser

Elegiste Tauri, lo cual tiene una ventaja tecnica real ademas de la que ya
conoces (Rust): los `#[tauri::command]` corren del lado nativo, asi que
`fetch_quotes` le pega a data912.com desde Rust con `reqwest`, no desde el
navegador con `fetch()`. Eso evita por completo la duda de si data912.com
manda o no headers CORS para peticiones cross-origin desde un `file://` o
`http://localhost` — algo que no pude confirmar y que hubiera sido un riesgo
real en la opcion "solo HTML/JS estatico".

## Que cubre y que no

**Cubre:**
- Alta/edicion/borrado manual de posiciones (dialog nativo `<dialog>`, sin
  librerias).
- Importar JSON o CSV (reemplaza toda la cartera, pide confirmacion antes).
- Exportar la cartera a JSON (backup).
- Traer cotizaciones de 5 paneles de data912 (`arg_stocks`, `arg_cedears`,
  `arg_bonds`, `arg_corp`, `arg_notes`) con un boton que tiene cooldown de
  5 minutos **persistido en disco** (cerrar y reabrir la app no resetea la
  espera).
- Precio manual por posicion, para lo que la API no cubre.

**No cubre (a proposito, quedo fuera del alcance que definimos):**
- Importar desde imagen. Si mas adelante lo queres, la forma realista es un
  comando de Rust que mande la captura a un modelo de vision (tu propia API
  key) y te devuelva un JSON para revisar antes de guardar — nunca guardado
  automatico sin que lo mires.
- Instrumentos sin panel en data912: **fideicomisos financieros no existen
  en esta API** (lo confirme contra el `openapi-spec.json`, no hay
  `/live/arg_fideicomisos` ni nada parecido). Tu CARP del ejemplo va a
  quedar siempre en "sin datos" salvo que cargues `precio_manual` a mano.
  Con el bono BB37D no tengo certeza — puede estar en `arg_bonds` o no,
  hay que probarlo.
- Multi-moneda / tipo de cambio. Los precios de data912 para CEDEARs y
  acciones locales ya vienen en ARS, pero si en algun momento agregas algo
  en USD vas a necesitar sumar esa logica, no esta contemplada.

## Setup

Prerequisitos (no los instale, son para tu maquina):

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Tauri CLI
cargo install tauri-cli --version "^2"
```

**Si vas a compilar esto desde WSL**: un Tauri app es una ventana nativa de
verdad (webview2 en Windows, webkit2gtk en Linux). Si corres
`cargo tauri dev` con el toolchain de Rust *de Linux dentro de WSL*, vas a
necesitar WSLg para que la ventana se muestre (viene por defecto en Windows
11, no en todas las instalaciones de Windows 10). Para evitarte ese
problema, probablemente te convenga instalar el toolchain de Rust para
Windows (`x86_64-pc-windows-msvc`) y compilar/correr desde ahi, igual que
seguramente ya haces con tus otros proyectos de Tauri — WSL para editar,
Windows-target para correr la GUI.

```bash
cd cartera-tracker
cargo tauri dev
```

Antes de generar un instalador (`cargo tauri build`) hace falta:
1. Correr `cargo tauri icon ruta/a/un/icono.png` (no incluí iconos).
2. Poner `"bundle": { "active": true }` en `src-tauri/tauri.conf.json`
   (lo deje en `false` para que `dev` no se queje por iconos faltantes).

## Formato del CSV de importacion

```
ticker,nombre,tipo,cantidad,precio_compra,precio_manual
AAPL,Apple Inc.,cedear,4,24470.00,
```

- `tipo`: `accion` | `cedear` | `bono` | `on` | `nota` | `otro`.
- Sin separador de miles, punto para decimales.
- `precio_manual` es opcional, se puede dejar vacio.

En `ejemplos/cartera_ejemplo.csv` transcribi a mano los datos de tu captura
de pantalla (ticker, tipo y precio promedio de compra). Los nombres de
BB37D y CARP estaban truncados en la imagen ("Bono Pcia Bs As Regs N...",
"Fideicomiso Financiero Ri...") — completalos vos, no inventé el resto del
texto.

## Estructura

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/default.json
  src/
    main.rs        registra los comandos
    portfolio.rs    CRUD de posiciones -> portfolio.json en el dir de datos de la app
    market.rs       cliente de data912.com + cooldown -> cooldown.txt
ui/
  index.html
  style.css
  app.js            toda la logica de UI, sin build step
ejemplos/
  cartera_ejemplo.csv
```
