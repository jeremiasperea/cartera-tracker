/**
 * Market.computeRowMetrics: la matematica de plata.
 *
 * Un error aca no rompe nada visible — devuelve numeros equivocados en
 * silencio, y son los numeros con los que el usuario decide.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadAppReady, snapshotCon } from "./helper.mjs";

/** (120/100 - 1) * 100 da 19.999999999999996, no 20. */
function casiIgual(actual, esperado, msg) {
  assert.ok(
    Math.abs(actual - esperado) < 1e-9,
    `${msg}: esperaba ~${esperado}, obtuve ${actual}`
  );
}

const posicion = (extra = {}) => ({
  id: "p1",
  ticker: "AAPL",
  nombre: "Apple Inc.",
  tipo: "cedear",
  cantidad: 10,
  precio_compra: 100,
  precio_manual: null,
  ...extra,
});

describe("Market.computeRowMetrics", () => {
  let Market;
  before(async () => {
    ({ Market } = await loadAppReady());
  });

  it("valoriza con la cotizacion viva y calcula la ganancia", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 120, pct_change: 1.5 } } });
    const r = Market.computeRowMetrics(posicion(), snap);

    assert.equal(r.precioActual, 120);
    assert.equal(r.esManual, false);
    assert.equal(r.sinCotizacion, false);
    assert.equal(r.valorizado, 1200);
    assert.equal(r.rendimientoMonto, 200);
    casiIgual(r.rendimientoPct, 20, "rendimientoPct");
    assert.equal(r.variacionDiaria, 1.5);
  });

  it("informa la perdida con signo negativo", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 80, pct_change: -2 } } });
    const r = Market.computeRowMetrics(posicion(), snap);

    assert.equal(r.valorizado, 800);
    assert.equal(r.rendimientoMonto, -200);
    casiIgual(r.rendimientoPct, -20, "rendimientoPct");
    assert.equal(r.variacionDiaria, -2);
  });

  // Esta precedencia es una decision, no un detalle: por eso el conversor de
  // carteras NO carga precio_manual en los tickers que si cotizan.
  it("el precio manual le gana a la cotizacion viva", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 120, pct_change: 1.5 } } });
    const r = Market.computeRowMetrics(posicion({ precio_manual: 90 }), snap);

    assert.equal(r.precioActual, 90, "deberia usar el manual, no el 120 vivo");
    assert.equal(r.esManual, true);
    assert.equal(r.valorizado, 900);
    assert.equal(r.rendimientoMonto, -100);
  });

  // `??` trata al 0 como valor presente; un `||` lo trataria como ausente y
  // se colaria la cotizacion viva. Este test existe para que ese cambio falle.
  it("un precio manual de 0 sigue siendo un precio, no una ausencia", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 120 } } });
    const r = Market.computeRowMetrics(posicion({ precio_manual: 0 }), snap);

    assert.equal(r.precioActual, 0);
    assert.equal(r.esManual, true);
    assert.equal(r.sinCotizacion, false);
    assert.equal(r.valorizado, 0);
    assert.equal(r.rendimientoMonto, -1000);
  });

  it("sin cotizacion ni precio manual deja los montos en null", () => {
    const r = Market.computeRowMetrics(posicion({ ticker: "NOEXISTE" }),
      snapshotCon({ arg_cedears: { AAPL: { c: 120 } } }));

    assert.equal(r.sinCotizacion, true);
    assert.equal(r.precioActual, null);
    assert.equal(r.valorizado, null, "no debe valorizar en 0: es desconocido");
    assert.equal(r.rendimientoMonto, null);
    assert.equal(r.rendimientoPct, null);
  });

  it("sin snapshot todavia, ninguna fila cotiza", () => {
    const r = Market.computeRowMetrics(posicion(), null);
    assert.equal(r.sinCotizacion, true);
    assert.equal(r.valorizado, null);
  });

  // El ticker esta en el panel pero la fila viene sin ultimo precio.
  it("una cotizacion con c en null cuenta como sin cotizacion", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: null, pct_change: 3 } } });
    const r = Market.computeRowMetrics(posicion(), snap);

    assert.equal(r.sinCotizacion, true);
    assert.equal(r.valorizado, null);
    assert.equal(r.variacionDiaria, 3, "la variacion si vino y se muestra igual");
  });

  it("el tipo 'otro' no cotiza aunque el ticker exista en un panel", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 120 } } });
    const r = Market.computeRowMetrics(posicion({ tipo: "otro" }), snap);

    assert.equal(r.sinCotizacion, true, "'otro' no tiene panel en data912");
  });

  it("busca cada tipo en su propio panel", () => {
    const snap = snapshotCon({
      arg_cedears: { XX: { c: 100 } },
      arg_stocks: { XX: { c: 200 } },
      arg_bonds: { XX: { c: 300 } },
    });
    const precio = (tipo) =>
      Market.computeRowMetrics(posicion({ ticker: "XX", tipo }), snap).precioActual;

    assert.equal(precio("cedear"), 100);
    assert.equal(precio("accion"), 200);
    assert.equal(precio("bono"), 300);
  });

  // Division por cero: valoriza igual, pero el porcentaje no existe.
  it("con precio de compra 0 valoriza pero no calcula porcentaje", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 50 } } });
    const r = Market.computeRowMetrics(
      posicion({ cantidad: 5, precio_compra: 0 }), snap);

    assert.equal(r.valorizado, 250);
    assert.equal(r.rendimientoMonto, 250);
    assert.equal(r.rendimientoPct, null, "no hay porcentaje contra un costo de 0");
  });

  it("acepta cantidades fraccionarias", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 100 } } });
    const r = Market.computeRowMetrics(
      posicion({ cantidad: 2.5, precio_compra: 80 }), snap);

    assert.equal(r.valorizado, 250);
    assert.equal(r.rendimientoMonto, 50);
  });

  it("variacion diaria ausente queda en null, no en 0", () => {
    const snap = snapshotCon({ arg_cedears: { AAPL: { c: 120 } } });
    const r = Market.computeRowMetrics(posicion(), snap);

    assert.equal(r.variacionDiaria, null, "0 diria 'no se movio', y no es lo mismo");
  });
});
