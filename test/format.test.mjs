/**
 * Formateo de los numeros que se leen en la tabla.
 *
 * Es la ultima capa antes del ojo: un null que se muestra como 0 no se lee
 * como "no se", se lee como "no vale nada".
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadAppReady } from "./helper.mjs";

describe("Format.money", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("usa separador de miles y coma decimal (es-AR)", () => {
    assert.equal(Format.money(1234.5), "1.234,50");
    assert.equal(Format.money(1000000), "1.000.000,00");
  });

  it("siempre dos decimales", () => {
    assert.equal(Format.money(0), "0,00");
    assert.equal(Format.money(7), "7,00");
  });

  it("redondea a dos decimales", () => {
    assert.equal(Format.money(-99.999), "-100,00");
  });

  // El guion largo distingue "no hay dato" de un cero. Mostrarlo como 0,00
  // diria que la posicion no vale nada, que es otra cosa.
  it("null, undefined y NaN dan guion, no cero", () => {
    for (const v of [null, undefined, NaN]) {
      assert.equal(Format.money(v), "—", `con ${v}`);
    }
  });

  it("el cero si se muestra como cero", () => {
    assert.notEqual(Format.money(0), "—", "0 es un dato, no una ausencia");
  });
});

describe("Format.percentage", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("antepone el signo en las ganancias", () => {
    assert.equal(Format.percentage(12.345), "+12,35%");
  });

  it("las perdidas ya vienen con su signo", () => {
    assert.equal(Format.percentage(-3), "-3,00%");
  });

  it("null y NaN dan guion", () => {
    assert.equal(Format.percentage(null), "—");
    assert.equal(Format.percentage(NaN), "—");
  });

  it("el cero se muestra, no se oculta", () => {
    assert.equal(Format.percentage(0), "+0,00%");
  });
});

describe("Format.cooldown", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("rellena los segundos con cero", () => {
    assert.equal(Format.cooldown(59), "0:59");
    assert.equal(Format.cooldown(61), "1:01");
  });

  it("el cooldown completo son cinco minutos", () => {
    assert.equal(Format.cooldown(300), "5:00");
  });

  it("cero es 0:00, no vacio", () => {
    assert.equal(Format.cooldown(0), "0:00");
  });

  // No hay horas: si alguna vez el cooldown pasa de una hora, se ve como
  // "61:01" y no como "1:01:01". Queda documentado antes que sorprenda.
  it("por encima de la hora sigue contando minutos", () => {
    assert.equal(Format.cooldown(3661), "61:01");
  });
});

describe("Format.etiquetaManual", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  it("el manual comun no lleva advertencia", () => {
    const html = Format.etiquetaManual(false);
    assert.match(html, /manual/);
    assert.doesNotMatch(html, /warn/);
  });

  it("el manual que tapa una cotizacion se marca y se explica", () => {
    const html = Format.etiquetaManual(true);
    assert.match(html, /warn/, "necesita la clase que lo pinta distinto");
    assert.match(html, /title="[^"]+"/, "sin explicacion el icono no dice nada");
  });
});

describe("Format.motivoSinCotizacion", () => {
  let Format;
  before(async () => {
    ({ Format } = await loadAppReady());
  });

  const MOTIVOS = ["sin_snapshot", "sin_panel", "panel_fallo", "sin_cotizacion", "sin_precio"];

  it("cada motivo tiene texto corto y explicacion", () => {
    for (const motivo of MOTIVOS) {
      const html = Format.motivoSinCotizacion(motivo);
      assert.match(html, /title="[^"]{20,}"/, `${motivo} sin explicacion`);
      assert.match(html, />[^<]{3,}</, `${motivo} sin texto visible`);
    }
  });

  it("los textos cortos no se repiten entre motivos", () => {
    const cortos = MOTIVOS.map((m) => Format.motivoSinCotizacion(m).match(/>([^<]+)</)[1]);
    assert.equal(new Set(cortos).size, cortos.length,
      `dos motivos se leen igual: ${cortos.join(", ")}`);
  });

  it("un motivo desconocido no rompe la fila", () => {
    assert.match(Format.motivoSinCotizacion("algo_nuevo"), /sin datos/);
    assert.match(Format.motivoSinCotizacion(null), /sin datos/);
  });
});
