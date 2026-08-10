/**
 * MarketOps.refreshQuotes y la cuenta regresiva.
 *
 * Aca vive el lado JS del contrato con MarketError. Rust ya verifica COMO
 * serializa el error; sin estos tests nadie verificaba que el frontend lo
 * consuma bien, que es la mitad que rompe la cuenta regresiva en silencio.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instrumentTypesFromRust, loadAppReady, relojFalso, snapshotCon } from "./helper.mjs";

/** App con fetch_quotes programable y reloj controlado. */
async function appConMercado({ alFetchear, cooldownDelBackend = 300 } = {}) {
  const alerts = [];
  const reloj = relojFalso();
  const tipos = instrumentTypesFromRust();
  let llamadasAFetch = 0;

  const app = await loadAppReady({
    alerts,
    reloj,
    invoke: async (cmd) => {
      if (cmd === "get_instrument_types") return tipos;
      if (cmd === "load_portfolio") return [];
      if (cmd === "read_snapshot") return null;
      if (cmd === "get_cooldown_status") return cooldownDelBackend;
      if (cmd === "fetch_quotes") {
        llamadasAFetch++;
        return alFetchear();
      }
      return null;
    },
  });

  return { ...app, alerts, reloj, fetches: () => llamadasAFetch };
}

const snapshotOk = () => snapshotCon({ arg_cedears: { AAPL: { c: 100 } } });

describe("MarketOps.refreshQuotes", () => {
  it("guarda el snapshot y arranca la cuenta con lo que dice el backend", async () => {
    const app = await appConMercado({
      alFetchear: snapshotOk,
      cooldownDelBackend: 287,
    });

    await app.MarketOps.refreshQuotes();

    assert.ok(app.State.getSnapshot(), "el snapshot no quedo en el estado");
    assert.equal(app.State.getCooldownRemaining(), 287,
      "deberia usar el valor del backend, no una constante local");
    assert.equal(app.alerts.length, 0);
  });

  // El contrato: el backend manda {kind:"cooldown", remaining_s:N} y el
  // frontend arranca la cuenta con ese N, sin parsear ningun string.
  it("un MarketError::Cooldown arranca la cuenta regresiva, no una alerta", async () => {
    const app = await appConMercado({
      alFetchear: () => { throw { kind: "cooldown", remaining_s: 42 }; },
    });

    await app.MarketOps.refreshQuotes();

    assert.equal(app.State.getCooldownRemaining(), 42);
    assert.equal(app.alerts.length, 0, "el cooldown no es un error que mostrar");
  });

  it("un MarketError::Client se le muestra al usuario con su mensaje", async () => {
    const app = await appConMercado({
      alFetchear: () => {
        throw { kind: "client", message: "no pude crear el cliente http: timeout" };
      },
    });

    await app.MarketOps.refreshQuotes();

    assert.equal(app.alerts.length, 1);
    assert.match(app.alerts[0], /timeout/, "sin el motivo el aviso no sirve");
    assert.equal(app.State.getCooldownRemaining(), 0, "el boton tiene que volver a quedar usable");
  });

  // Si el invoke falla por algo que no es el comando (IPC roto), Tauri rechaza
  // con un string pelado: err.kind es undefined y no debe romper nada.
  it("un error que llega como string se muestra igual", async () => {
    const app = await appConMercado({
      alFetchear: () => { throw "algo se rompio en el IPC"; },
    });

    await app.MarketOps.refreshQuotes();

    assert.equal(app.alerts.length, 1);
    assert.match(app.alerts[0], /algo se rompio en el IPC/);
  });

  it("un kind desconocido cae en el camino generico en vez de ignorarse", async () => {
    const app = await appConMercado({
      alFetchear: () => { throw { kind: "algo_nuevo", message: "vaya" }; },
    });

    await app.MarketOps.refreshQuotes();
    assert.equal(app.alerts.length, 1, "una variante nueva no puede pasar desapercibida");
  });

  it("no vuelve a pedir cotizaciones mientras el cooldown corre", async () => {
    const app = await appConMercado({ alFetchear: snapshotOk, cooldownDelBackend: 300 });

    await app.MarketOps.refreshQuotes();
    assert.equal(app.fetches(), 1);

    await app.MarketOps.refreshQuotes();
    assert.equal(app.fetches(), 1, "el segundo pedido tenia que cortarse antes de la red");
  });
});

describe("Cooldown.startCooldownCountdown", () => {
  it("descuenta un segundo por tic", async () => {
    const app = await appConMercado({ alFetchear: snapshotOk });

    app.Cooldown.startCooldownCountdown(5);
    assert.equal(app.State.getCooldownRemaining(), 5);

    app.reloj.avanzar(2);
    assert.equal(app.State.getCooldownRemaining(), 3);
  });

  it("frena en cero y no sigue a negativo", async () => {
    const app = await appConMercado({ alFetchear: snapshotOk });

    app.Cooldown.startCooldownCountdown(2);
    app.reloj.avanzar(10);

    assert.equal(app.State.getCooldownRemaining(), 0);
  });

  it("apaga el intervalo al llegar a cero", async () => {
    const app = await appConMercado({ alFetchear: snapshotOk });

    app.Cooldown.startCooldownCountdown(2);
    app.reloj.avanzar(5);

    assert.equal(app.reloj.vivos, 0, "un intervalo vivo para siempre es una fuga");
  });

  // Arrancar dos veces sin limpiar dejaria dos intervalos descontando a la vez
  // y la cuenta bajaria al doble de velocidad.
  it("arrancar de nuevo reemplaza la cuenta anterior", async () => {
    const app = await appConMercado({ alFetchear: snapshotOk });

    app.Cooldown.startCooldownCountdown(10);
    app.Cooldown.startCooldownCountdown(10);
    assert.equal(app.reloj.vivos, 1, "quedaron dos cuentas corriendo");

    app.reloj.avanzar(1);
    assert.equal(app.State.getCooldownRemaining(), 9, "descontó de a dos");
  });
});
