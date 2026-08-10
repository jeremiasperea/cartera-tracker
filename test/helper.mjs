/**
 * Carga el ui/app.js REAL en un contexto aislado y devuelve sus modulos.
 *
 * app.js no exporta nada: son IIFE que corren en el scope del script y esperan
 * el webview de Tauri. En vez de reimplementar la logica para poder testearla
 * —que testearia la copia, no lo que se envia— se evalua el archivo tal cual
 * en un `node:vm` con `window.__TAURI__`, `document` y demas stubeados, y se
 * sacan los modulos por `globalThis`.
 *
 * Cada llamada a loadApp() devuelve una instancia limpia: los modulos guardan
 * estado en sus closures y compartirlo entre tests los acoplaria.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lee INSTRUMENT_TYPES desde src-tauri/src/config.rs en vez de repetirlo aca.
 *
 * Este proyecto ya se comio cuatro veces la misma duplicacion cruzada
 * (TIPO_PANEL, la const PANELS, COOLDOWN_SECONDS, las <option> del dialogo).
 * Un fixture escrito a mano seria la quinta: los tests pasarian en verde
 * mientras Rust dice otra cosa.
 */
export function instrumentTypesFromRust() {
  const rust = readFileSync(path.join(ROOT, "src-tauri/src/config.rs"), "utf8");
  const tabla = rust.match(
    /const INSTRUMENT_TYPES[^=]*=\s*\[([\s\S]*?)\n\];/
  );
  if (!tabla) {
    throw new Error(
      "no encontre INSTRUMENT_TYPES en config.rs — cambio el formato de la tabla"
    );
  }
  const filas = [...tabla[1].matchAll(
    /\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g
  )];
  if (filas.length === 0) {
    throw new Error("INSTRUMENT_TYPES no tiene filas parseables");
  }
  return filas.map(([, id, label, form_label, panel]) => ({
    id,
    label,
    form_label,
    panel,
  }));
}

/**
 * Elemento que modela de verdad el par textContent -> innerHTML, porque de eso
 * depende Format.escapeHtml.
 *
 * Un navegador escapa &, < y > al leer innerHTML, pero NO las comillas: por eso
 * ese escape sirve para contenido de texto y no para valores de atributo.
 * Emularlo mal daria tests que aprueban un escape roto.
 */
export function elementoDeTexto(registro) {
  let texto = "";
  let crudo = null;   // innerHTML asignado tal cual, sin re-escapar al leerlo
  return {
    set textContent(v) { texto = v == null ? "" : String(v); crudo = null; },
    get textContent() { return texto; },
    get innerHTML() {
      if (crudo !== null) return crudo;
      return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    // Registrar lo asignado es lo que permite auditar el HTML que arma
    // render(): sin esto no hay forma de comprobar que escapa lo que interpola.
    set innerHTML(v) {
      crudo = String(v);
      if (registro) registro.push(crudo);
    },
    appendChild() {},
    style: {},
    dataset: {},
  };
}

/** Stub de elemento DOM: devuelve algo encadenable para cualquier acceso. */
function stubElement() {
  const el = new Proxy(
    { value: "", textContent: "", innerHTML: "", hidden: false, disabled: false,
      files: [], dataset: {}, style: {} },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === "string") return () => el;
        return undefined;
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    }
  );
  return el;
}

/**
 * @param {object} opts
 * @param {(cmd: string, args: object) => Promise<any>} [opts.invoke]
 *        Handler de window.__TAURI__.core.invoke. Por defecto responde lo
 *        minimo para que initialize() no explote.
 * @param {string[]} [opts.alerts]  Array donde se acumulan los alert().
 * @param {boolean}  [opts.confirm] Que devuelve confirm(). Default true.
 * @param {string[]} [opts.htmlGenerado] Array donde se acumula cada innerHTML
 *        que la app asigna a un elemento creado con createElement — o sea, el
 *        HTML de las filas de la tabla, para poder auditar el escape.
 */
export function loadApp(opts = {}) {
  const alerts = opts.alerts ?? [];
  const htmlGenerado = opts.htmlGenerado ?? [];
  const tipos = instrumentTypesFromRust();

  const invoke = opts.invoke ?? (async (cmd) => {
    if (cmd === "get_instrument_types") return tipos;
    if (cmd === "load_portfolio") return [];
    if (cmd === "get_cooldown_status") return 0;
    if (cmd === "read_snapshot") return null;
    return null;
  });

  const ctx = {
    window: { __TAURI__: { core: { invoke } } },
    document: {
      getElementById: () => stubElement(),
      // escapeHtml crea un div y usa textContent/innerHTML: ese par tiene que
      // comportarse como el real o el test del escape no prueba nada.
      createElement: () => elementoDeTexto(htmlGenerado),
      querySelector: () => stubElement(),
    },
    crypto: {
      randomUUID: () =>
        "uuid-" + Math.random().toString(16).slice(2) + Date.now().toString(16),
    },
    alert: (msg) => alerts.push(String(msg)),
    confirm: () => opts.confirm ?? true,
    setInterval: opts.reloj ? opts.reloj.setInterval : () => 0,
    clearInterval: opts.reloj ? opts.reloj.clearInterval : () => {},
    setTimeout: (fn) => fn(),
    console,
    Blob: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  };

  // Se corta App.initialize(): arrancarlo aca dispararia los invoke y el
  // cableado de eventos, que no es lo que se esta testeando.
  const src = readFileSync(path.join(ROOT, "ui/app.js"), "utf8")
    .replace(/App\.initialize\(\);\s*$/, "");

  const MODULOS = [
    "Config", "State", "Market", "Format", "UI", "Cooldown", "Persistence",
    "MarketOps", "PortfolioOps", "Dialogs", "Export", "EventWiring", "App",
  ];

  vm.createContext(ctx);
  vm.runInContext(
    src + "\n;" + MODULOS.map((m) => `globalThis.${m} = ${m};`).join(""),
    ctx
  );

  return {
    ...Object.fromEntries(MODULOS.map((m) => [m, ctx[m]])),
    alerts, tipos, htmlGenerado,
  };
}

/** Instancia con Config ya cargada — lo que necesita casi cualquier test. */
export async function loadAppReady(opts = {}) {
  const app = loadApp(opts);
  await app.Config.load();
  return app;
}

/**
 * Trae un valor del contexto vm al realm del test.
 *
 * Los objetos y arrays que crea app.js adentro del vm tienen SU propio
 * Array.prototype, asi que assert.deepStrictEqual([], []) falla con el
 * desconcertante "actual: [] expected: []": compara prototipos, no contenido.
 * Un ida y vuelta por JSON los reconstruye con los prototipos de aca.
 */
export function plano(valor) {
  return JSON.parse(JSON.stringify(valor));
}

/**
 * Reloj falso para los intervalos: `avanzar(n)` dispara n tics a mano.
 *
 * La cuenta regresiva usa setInterval de a un segundo; esperarla de verdad
 * haria un test de cinco minutos y ademas flaky.
 */
export function relojFalso() {
  const activos = new Map();
  let siguienteId = 1;
  return {
    setInterval: (fn) => { activos.set(siguienteId, fn); return siguienteId++; },
    clearInterval: (id) => { activos.delete(id); },
    /** Dispara `tics` vueltas de todos los intervalos vivos. */
    avanzar(tics = 1) {
      for (let i = 0; i < tics; i++) {
        for (const fn of [...activos.values()]) fn();
      }
    },
    get vivos() { return activos.size; },
  };
}

/** Arma un MarketSnapshot con las cotizaciones indicadas. */
export function snapshotCon(panels, { fetched_at_ms = 1_770_000_000_000, errores = [] } = {}) {
  const salida = {};
  for (const [panel, quotes] of Object.entries(panels)) {
    salida[panel] = {};
    for (const [symbol, q] of Object.entries(quotes)) {
      salida[panel][symbol] = {
        symbol,
        c: q.c ?? null,
        pct_change: q.pct_change ?? null,
        px_bid: null,
        px_ask: null,
      };
    }
  }
  return { fetched_at_ms, panels: salida, errores };
}
