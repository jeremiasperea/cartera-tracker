/**
 * Por que una fila no tiene precio.
 *
 * "Sin datos" a secas juntaba situaciones que piden acciones OPUESTAS. La peor
 * confusion: un panel caido y un instrumento sin cobertura se veian igual, y
 * cargarle precio manual al primero tapa la cotizacion real para siempre —
 * porque el manual le gana (ver market.test.mjs).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadAppReady, snapshotCon } from "./helper.mjs";

const pos = (extra = {}) => ({
  id: "p", ticker: "BB37D", nombre: "Bono", tipo: "bono",
  cantidad: 1, precio_compra: 100, precio_manual: null, ...extra,
});

/** Snapshot donde `panel` fallo: no viene en panels y figura en errores. */
const conPanelCaido = (panel, mensaje = "HTTP 503") => ({
  fetched_at_ms: 1,
  panels: {},
  errores: [{ panel, mensaje }],
});

describe("Market.motivoSinCotizacion", () => {
  let Market;
  before(async () => {
    ({ Market } = await loadAppReady());
  });

  it("null cuando hay precio de mercado", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: 124300 } } });
    assert.equal(Market.motivoSinCotizacion(pos(), snap), null);
  });

  it("sin_snapshot antes del primer refresh", () => {
    assert.equal(Market.motivoSinCotizacion(pos(), null), "sin_snapshot");
  });

  it("sin_panel para un tipo que data912 no cubre", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: 1 } } });
    assert.equal(Market.motivoSinCotizacion(pos({ tipo: "otro" }), snap), "sin_panel");
  });

  it("panel_fallo cuando su panel se cayo en el ultimo refresh", () => {
    assert.equal(
      Market.motivoSinCotizacion(pos(), conPanelCaido("arg_bonds")),
      "panel_fallo"
    );
  });

  // El orden importa: un panel caido no aparece en snapshot.panels, asi que
  // sin este chequeo previo la fila caeria en sin_cotizacion. La diferencia no
  // es cosmetica: sin_cotizacion invita a cargar precio manual y panel_fallo
  // lo desaconseja, porque el manual taparia la cotizacion al volver.
  it("un panel caido no se confunde con un ticker sin cotizacion", () => {
    const motivo = Market.motivoSinCotizacion(pos(), conPanelCaido("arg_bonds"));
    assert.notEqual(motivo, "sin_cotizacion", "recomendaria justo lo que no hay que hacer");
    assert.equal(motivo, "panel_fallo");
  });

  it("el fallo de OTRO panel no afecta a esta fila", () => {
    const snap = {
      fetched_at_ms: 1,
      panels: { arg_bonds: { BB37D: { symbol: "BB37D", c: 124300 } } },
      errores: [{ panel: "arg_cedears", mensaje: "HTTP 503" }],
    };
    assert.equal(Market.motivoSinCotizacion(pos(), snap), null);
  });

  it("sin_cotizacion cuando el panel vino bien y el ticker no figura", () => {
    const snap = snapshotCon({ arg_bonds: { OTRO: { c: 1 } } });
    assert.equal(Market.motivoSinCotizacion(pos(), snap), "sin_cotizacion");
  });

  it("sin_precio cuando figura en el panel pero sin ultimo precio", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: null, pct_change: 2 } } });
    assert.equal(Market.motivoSinCotizacion(pos(), snap), "sin_precio");
  });
});

describe("Market.computeRowMetrics — motivo y precio manual", () => {
  let Market;
  before(async () => {
    ({ Market } = await loadAppReady());
  });

  it("expone el motivo en la fila sin precio", () => {
    const r = Market.computeRowMetrics(pos(), conPanelCaido("arg_bonds"));
    assert.equal(r.sinCotizacion, true);
    assert.equal(r.motivo, "panel_fallo");
  });

  it("sin motivo cuando la fila si valoriza", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: 100 } } });
    assert.equal(Market.computeRowMetrics(pos(), snap).motivo, null);
  });

  // La trampa completa: un manual cargado el dia que el panel estaba caido
  // sigue tapando la cotizacion cuando el panel vuelve, y nada lo delata.
  it("avisa cuando el precio manual tapa una cotizacion disponible", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: 124300 } } });
    const r = Market.computeRowMetrics(pos({ precio_manual: 99 }), snap);

    assert.equal(r.precioActual, 99, "el manual sigue ganando");
    assert.equal(r.manualTapaCotizacion, true);
  });

  it("no avisa cuando el manual es la unica fuente de precio", () => {
    const snap = snapshotCon({ arg_bonds: {} });
    const r = Market.computeRowMetrics(pos({ tipo: "otro", precio_manual: 1257.9 }), snap);

    assert.equal(r.manualTapaCotizacion, false, "CARP es un manual legitimo");
    assert.equal(r.precioActual, 1257.9);
  });

  it("tampoco avisa si el ticker figura pero sin ultimo precio", () => {
    const snap = snapshotCon({ arg_bonds: { BB37D: { c: null } } });
    const r = Market.computeRowMetrics(pos({ precio_manual: 50 }), snap);
    assert.equal(r.manualTapaCotizacion, false, "no hay cotizacion que tapar");
  });
});

describe("Format.avisosDeCartera", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("sin problemas no genera avisos", () => {
    assert.equal(Format.avisosDeCartera({}, 0).length, 0);
  });

  it("un panel caido desaconseja el precio manual", () => {
    const [aviso] = Format.avisosDeCartera({ panel_fallo: 2 }, 0);
    assert.match(aviso, /2 posiciones/);
    assert.match(aviso, /Reintenta/i);
    assert.match(aviso, /taparia/i);
  });

  it("sin cobertura recomienda lo contrario: precio manual", () => {
    const [aviso] = Format.avisosDeCartera({ sin_panel: 1 }, 0);
    assert.match(aviso, /1 posicion/);
    assert.match(aviso, /precio manual/i);
    assert.doesNotMatch(aviso, /reintenta/i, "esto no se arregla reintentando");
  });

  it("concuerda singular y plural", () => {
    assert.match(Format.avisosDeCartera({ sin_cotizacion: 1 }, 0)[0], /1 ticker\b/);
    assert.match(Format.avisosDeCartera({ sin_cotizacion: 3 }, 0)[0], /3 tickers\b/);
  });

  // El ticker suele venir de un export del broker o de una foto de la cartera:
  // existe. La app solo sabe que no lo encontro en el panel, asi que no puede
  // afirmar que el simbolo este mal — culparia a los datos del usuario por algo
  // que no le consta. Nombra la causa que si conoce: data912 no lo publica.
  it("no acusa al ticker de estar mal: nombra la causa que si conoce", () => {
    const [aviso] = Format.avisosDeCartera({ sin_cotizacion: 1 }, 0);
    assert.match(aviso, /data912/, "deberia nombrar a la fuente que no publica el precio");
    assert.doesNotMatch(aviso, /revisa el simbolo/i);
    assert.doesNotMatch(aviso, /no (existe|figura)/i);
  });

  it("avisa de los manuales que tapan cotizacion aunque todo lo demas este bien", () => {
    const avisos = Format.avisosDeCartera({}, 1);
    assert.equal(avisos.length, 1, "no corresponde la nota del total: nada quedo sin precio");
    assert.match(avisos[0], /tapando/i);
  });

  it("junta un aviso por causa cuando conviven varias", () => {
    const avisos = Format.avisosDeCartera(
      { panel_fallo: 1, sin_panel: 1, sin_cotizacion: 1 }, 2);
    assert.ok(avisos.length >= 4, `esperaba un aviso por causa, hubo ${avisos.length}`);
    assert.match(avisos.join(" "), /total valorizado no incluye/i);
  });
});
