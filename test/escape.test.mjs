/**
 * Escape de la tabla.
 *
 * render() arma las filas con innerHTML e interpola datos que salen de un
 * archivo elegido por el usuario. En este webview `withGlobalTauri: true` y la
 * CSP esta en null, asi que un script inyectado corre con window.__TAURI__ a
 * mano: puede llamar save_portfolio. No es un defecto cosmetico.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadAppReady } from "./helper.mjs";

const CARGAS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  "a & b",
];

describe("Format.escapeHtml (contenido de texto)", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("neutraliza las etiquetas", () => {
    assert.equal(
      Format.escapeHtml('<img src=x onerror=alert(1)>'),
      "&lt;img src=x onerror=alert(1)&gt;"
    );
  });

  it("escapa el ampersand", () => {
    assert.equal(Format.escapeHtml("a & b"), "a &amp; b");
  });

  it("null y undefined dan cadena vacia", () => {
    assert.equal(Format.escapeHtml(null), "");
    assert.equal(Format.escapeHtml(undefined), "");
  });

  // Documenta el limite, no un descuido: textContent no escapa comillas. Por
  // eso existe escapeAttr y por eso este escape no va dentro de un atributo.
  it("NO escapa comillas — no sirve para atributos", () => {
    assert.equal(Format.escapeHtml('di "hola"'), 'di "hola"');
  });
});

describe("Format.escapeAttr (valor de atributo)", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("escapa la comilla doble, que es la que rompe el atributo", () => {
    assert.equal(Format.escapeAttr('" onmouseover="x'), "&quot; onmouseover=&quot;x");
  });

  it("escapa tambien la simple, por si el atributo va con comilla simple", () => {
    assert.equal(Format.escapeAttr("' onfocus='x"), "&#39; onfocus=&#39;x");
  });

  it("ninguna carga conocida sobrevive con caracteres que rompan el atributo", () => {
    for (const carga of CARGAS) {
      const salida = Format.escapeAttr(carga);
      assert.doesNotMatch(salida, /["'<>]/, `escapo mal: ${carga} -> ${salida}`);
    }
  });

  it("escapa el ampersand primero, sin doble escape", () => {
    assert.equal(Format.escapeAttr("&"), "&amp;");
    assert.equal(Format.escapeAttr('&"'), "&amp;&quot;");
  });

  it("null y undefined dan cadena vacia", () => {
    assert.equal(Format.escapeAttr(null), "");
    assert.equal(Format.escapeAttr(undefined), "");
  });
});

/**
 * Auditar el HTML que render() arma de verdad.
 *
 * Escapar bien en Format y validar bien el id no sirve de nada si el template
 * de la fila no llama al escape. Este bloque existe porque una mutacion que
 * sacaba escapeAttr del data-id no rompia ningun test.
 */
describe("UI.render escapa lo que interpola", () => {
  const posicionHostil = (extra = {}) => ({
    id: '" onmouseover="alert(1)',
    ticker: '<img src=x onerror=alert(1)>',
    nombre: '"><script>alert(1)</script>',
    tipo: "otro",
    cantidad: 1,
    precio_compra: 100,
    precio_manual: 50,
    ...extra,
  });

  /** Renderiza saltando normalizarPosicion, para probar la ultima linea. */
  async function filaDe(posicion) {
    const htmlGenerado = [];
    const app = await loadAppReady({ htmlGenerado });
    app.State.setPositions([posicion]);
    app.UI.render();
    assert.ok(htmlGenerado.length > 0, "render no genero ninguna fila");
    return htmlGenerado.join("\n");
  }

  it("no deja escapar un id que rompa el atributo data-id", async () => {
    const html = await filaDe(posicionHostil());

    assert.doesNotMatch(html, /data-id="[^"]*"[^>]*\son\w+=/i,
      "el id se salio del atributo e inyecto un handler");
    assert.match(html, /data-id="&quot;/, "deberia haberlo escapado");
  });

  it("no deja escapar etiquetas en ticker ni nombre", async () => {
    const html = await filaDe(posicionHostil());

    assert.doesNotMatch(html, /<img\s/i, "el ticker inyecto una etiqueta");
    assert.doesNotMatch(html, /<script/i, "el nombre inyecto un script");
  });

  /**
   * Manejadores de eventos que el navegador realmente crearia.
   *
   * Hay que leer NOMBRES de atributo, no buscar texto. Dos falsos positivos
   * que hay que esquivar:
   *  - un ticker escapado queda como texto "&lt;img ... onerror=..." y no es
   *    una etiqueta, porque el < esta escapado;
   *  - un id escapado deja " onmouseover=" ADENTRO del valor de data-id, entre
   *    &quot;, donde es contenido y no un atributo nuevo.
   * Recorriendo los pares nombre="valor" los dos casos se resuelven solos.
   */
  function handlersEnEtiquetas(html) {
    const encontrados = [];
    for (const etiqueta of html.match(/<[a-z][^>]*>/gi) ?? []) {
      for (const [, nombre] of etiqueta.matchAll(/([\w-]+)\s*=\s*"[^"]*"/g)) {
        if (/^on/i.test(nombre)) encontrados.push(`${nombre} en ${etiqueta.slice(0, 60)}`);
      }
    }
    return encontrados;
  }

  it("no aparece ningun manejador de eventos en las etiquetas", async () => {
    const html = await filaDe(posicionHostil());
    assert.deepEqual(handlersEnEtiquetas(html), [], "se inyecto un handler");
  });

  it("un payload escapado queda como texto, no como etiqueta", async () => {
    const html = await filaDe(posicionHostil());
    assert.match(html, /&lt;img/, "el ticker tiene que verse, escapado");
    assert.equal(handlersEnEtiquetas(html).length, 0);
  });

  // Una comilla en el nombre es legitima y cae en contexto de texto, donde no
  // hace daño. El escape no tiene que romperla ni mutilar el nombre.
  it("una comilla en el nombre se muestra tal cual", async () => {
    const html = await filaDe(posicionHostil({
      id: "p_1", ticker: "ORLY", nombre: `O'reilly "el bueno"`, precio_manual: null }));

    assert.match(html, /O'reilly "el bueno"/);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  });

  it("una posicion normal se renderiza sin ruido de escape", async () => {
    const html = await filaDe(posicionHostil({
      id: "p_1_abc", ticker: "GGAL", nombre: "Galicia", precio_manual: null }));

    assert.match(html, /data-id="p_1_abc"/);
    assert.match(html, />GGAL</);
    assert.match(html, />Galicia</);
  });
});

describe("normalizarPosicion: el id no acepta cualquier cosa", () => {
  let PortfolioOps;
  before(async () => {
    ({ PortfolioOps } = await loadAppReady());
  });

  const norm = (id) => PortfolioOps.normalizarPosicion({
    id, ticker: "X", nombre: "X", tipo: "otro", cantidad: 1, precio_compra: 1 });

  it("descarta un id que se saldria del atributo", () => {
    const p = norm('" onmouseover="alert(1)');
    assert.notEqual(p.id, '" onmouseover="alert(1)');
    assert.match(p.id, /^[A-Za-z0-9_-]+$/, "deberia haber generado uno nuevo");
  });

  it("descarta cualquier id con caracteres de HTML", () => {
    for (const carga of CARGAS) {
      assert.doesNotMatch(norm(carga).id, /["'<>&\s]/, `paso: ${carga}`);
    }
  });

  it("conserva los ids que genera la app, para no romper el ida y vuelta", () => {
    for (const id of [
      "550e8400-e29b-41d4-a716-446655440000",   // crypto.randomUUID
      "p_1786136405782_a3f9c1",                  // el fallback
      PortfolioOps.generateId(),
    ]) {
      assert.equal(norm(id).id, id, `deberia conservarse: ${id}`);
    }
  });

  it("un id vacio o ausente se reemplaza por uno generado", () => {
    for (const id of ["", null, undefined]) {
      assert.ok(norm(id).id.length > 0, `con id=${id}`);
    }
  });

  it("un id absurdamente largo se descarta", () => {
    assert.notEqual(norm("a".repeat(500)).id, "a".repeat(500));
  });
});
