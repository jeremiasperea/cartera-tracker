/**
 * Escritura de la cartera y su rollback.
 *
 * Esta era la unica logica del proyecto verificada con un script descartable
 * que se borraba despues de usarlo. Es tambien la que puede perder datos en
 * silencio: antes del rollback, si fallaba el guardado el estado en memoria ya
 * estaba mutado y UI.render() nunca corria, asi que la tabla seguia mostrando
 * lo viejo sin un solo error a la vista.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { instrumentTypesFromRust, loadAppReady, plano } from "./helper.mjs";

/** App con un save_portfolio que se puede romper a voluntad. */
async function appConDisco() {
  const alerts = [];
  const guardadas = [];
  const tipos = instrumentTypesFromRust();
  let falla = null;

  const app = await loadAppReady({
    alerts,
    invoke: async (cmd, args) => {
      if (cmd === "save_portfolio") {
        if (falla) throw falla;
        guardadas.push(plano(args.positions));
        return null;
      }
      if (cmd === "get_instrument_types") return tipos;
      if (cmd === "load_portfolio") return [];
      if (cmd === "get_cooldown_status") return 0;
      return null;
    },
  });

  return {
    ...app,
    alerts,
    guardadas,
    romperDisco: (err = "no pude guardar portfolio.json: disco lleno") => { falla = err; },
    arreglarDisco: () => { falla = null; },
  };
}

const posicion = (id, extra = {}) => ({
  id, ticker: id, nombre: id, tipo: "otro",
  cantidad: 1, precio_compra: 100, precio_manual: null, ...extra,
});

describe("PortfolioOps.replaceAllPositions", () => {
  it("aplica y persiste cuando el disco anda", async () => {
    const { PortfolioOps, State, guardadas } = await appConDisco();

    const ok = await PortfolioOps.replaceAllPositions([posicion("A")], "El alta");

    assert.equal(ok, true);
    assert.equal(State.getPositions().length, 1);
    assert.equal(guardadas.length, 1, "tiene que haber llegado al disco");
    assert.equal(guardadas[0][0].id, "A");
  });

  it("revierte al estado exacto anterior si falla el guardado", async () => {
    const app = await appConDisco();
    await app.PortfolioOps.replaceAllPositions([posicion("A"), posicion("B")], "x");
    const antes = plano(app.State.getPositions());

    app.romperDisco();
    const ok = await app.PortfolioOps.replaceAllPositions([posicion("C")], "El alta");

    assert.equal(ok, false);
    assert.deepEqual(plano(app.State.getPositions()), antes,
      "el estado en memoria quedo divergiendo del disco");
  });

  it("le dice al usuario que fallo y con que motivo", async () => {
    const app = await appConDisco();
    app.romperDisco("no pude guardar portfolio.json: disco lleno");

    await app.PortfolioOps.replaceAllPositions([posicion("A")], "El alta de la posicion");

    assert.equal(app.alerts.length, 1, "un fallo silencioso es el bug original");
    assert.match(app.alerts[0], /disco lleno/, "sin el motivo real no se puede actuar");
    assert.match(app.alerts[0], /El alta de la posicion/, "deberia decir que accion se perdio");
  });

  it("un error que no es Error igual se muestra", async () => {
    const app = await appConDisco();
    app.romperDisco({ kind: "raro" });     // lo que devuelve un invoke fallido

    await app.PortfolioOps.replaceAllPositions([posicion("A")], "x");
    assert.equal(app.alerts.length, 1, "no puede quedarse mudo por la forma del error");
  });

  it("tras un fallo, el siguiente intento con disco sano funciona", async () => {
    const app = await appConDisco();
    app.romperDisco();
    await app.PortfolioOps.replaceAllPositions([posicion("A")], "x");

    app.arreglarDisco();
    const ok = await app.PortfolioOps.replaceAllPositions([posicion("A")], "x");

    assert.equal(ok, true, "el fallo anterior no puede dejar el modulo trabado");
    assert.equal(app.State.getPositions().length, 1);
  });
});

describe("PortfolioOps.addPosition", () => {
  it("agrega al final cuando el id es nuevo", async () => {
    const { PortfolioOps, State } = await appConDisco();
    await PortfolioOps.addPosition(posicion("A"));
    await PortfolioOps.addPosition(posicion("B"));

    assert.deepEqual(plano(State.getPositions()).map((p) => p.id), ["A", "B"]);
  });

  it("reemplaza en su lugar cuando el id ya existe", async () => {
    const { PortfolioOps, State } = await appConDisco();
    await PortfolioOps.addPosition(posicion("A"));
    await PortfolioOps.addPosition(posicion("B"));
    await PortfolioOps.addPosition(posicion("A", { cantidad: 99 }));

    const ids = plano(State.getPositions()).map((p) => p.id);
    assert.deepEqual(ids, ["A", "B"], "no debe duplicar ni reordenar");
    assert.equal(plano(State.getPositions())[0].cantidad, 99);
  });

  // addPosition armaba el array nuevo mutando el actual (positions.push), asi
  // que "el estado anterior" era el mismo objeto y revertir no hacia nada.
  it("no muta el array anterior, para que el rollback sirva", async () => {
    const app = await appConDisco();
    await app.PortfolioOps.addPosition(posicion("A"));
    const antes = plano(app.State.getPositions());

    app.romperDisco();
    await app.PortfolioOps.addPosition(posicion("B"));

    assert.deepEqual(plano(app.State.getPositions()), antes);
    assert.equal(app.State.getPositions().length, 1, "la B no puede haber quedado");
  });
});

describe("PortfolioOps.deletePosition", () => {
  it("borra solo la posicion pedida", async () => {
    const { PortfolioOps, State } = await appConDisco();
    await PortfolioOps.addPosition(posicion("A"));
    await PortfolioOps.addPosition(posicion("B"));

    await PortfolioOps.deletePosition("A");
    assert.deepEqual(plano(State.getPositions()).map((p) => p.id), ["B"]);
  });

  it("no borra nada si el guardado falla", async () => {
    const app = await appConDisco();
    await app.PortfolioOps.addPosition(posicion("A"));

    app.romperDisco();
    const ok = await app.PortfolioOps.deletePosition("A");

    assert.equal(ok, false);
    assert.equal(app.State.getPositions().length, 1, "se perdio una posicion real");
  });

  it("borrar un id inexistente no altera la cartera", async () => {
    const { PortfolioOps, State } = await appConDisco();
    await PortfolioOps.addPosition(posicion("A"));

    await PortfolioOps.deletePosition("NO_ESTA");
    assert.equal(State.getPositions().length, 1);
  });

  it("no borra si el usuario cancela la confirmacion", async () => {
    const alerts = [];
    const app = await loadAppReady({ alerts, confirm: false });
    await app.PortfolioOps.replaceAllPositions([posicion("A")], "x");

    const ok = await app.PortfolioOps.deletePosition("A");

    assert.equal(ok, false);
    assert.equal(app.State.getPositions().length, 1, "cancelar tiene que cancelar");
  });
});

describe("Dialogs.confirmImport", () => {
  it("reemplaza la cartera entera cuando se confirma", async () => {
    const { PortfolioOps, Dialogs, State } = await appConDisco();
    await PortfolioOps.addPosition(posicion("VIEJA"));

    Dialogs.showImportConfirmation([posicion("N1"), posicion("N2")], "un archivo");
    const ok = await Dialogs.confirmImport();

    assert.equal(ok, true);
    assert.deepEqual(plano(State.getPositions()).map((p) => p.id), ["N1", "N2"]);
  });

  // Si se descartara antes de saber si guardo, un fallo de disco obligaria a
  // volver a elegir el archivo.
  it("conserva el import pendiente si falla el guardado, para reintentar", async () => {
    const app = await appConDisco();
    app.Dialogs.showImportConfirmation([posicion("N1")], "un archivo");

    app.romperDisco();
    assert.equal(await app.Dialogs.confirmImport(), false);

    app.arreglarDisco();
    assert.equal(await app.Dialogs.confirmImport(), true, "el import se habia perdido");
    assert.deepEqual(plano(app.State.getPositions()).map((p) => p.id), ["N1"]);
  });

  it("confirmar sin import pendiente no hace nada", async () => {
    const { Dialogs, State, guardadas } = await appConDisco();
    assert.equal(await Dialogs.confirmImport(), false);
    assert.equal(State.getPositions().length, 0);
    assert.equal(guardadas.length, 0, "no deberia tocar el disco");
  });

  it("cancelar descarta el import pendiente", async () => {
    const { Dialogs, State } = await appConDisco();
    Dialogs.showImportConfirmation([posicion("N1")], "un archivo");
    Dialogs.cancelImport();

    assert.equal(await Dialogs.confirmImport(), false);
    assert.equal(State.getPositions().length, 0);
  });

  // Un array vacio es truthy, asi que este import se ejecuta y deja la cartera
  // en cero. Es lo correcto: el dialogo lo anuncia ("por 0 posiciones nuevas")
  // y es la unica forma de vaciar la cartera de una. La confusion facil seria
  // cortar con `if (!pendingImport)` creyendo que atrapa el caso vacio.
  it("importar un archivo vacio vacia la cartera", async () => {
    const { PortfolioOps, Dialogs, State, guardadas } = await appConDisco();
    await PortfolioOps.addPosition(posicion("A"));

    Dialogs.showImportConfirmation([], "un archivo vacio");
    assert.equal(await Dialogs.confirmImport(), true);
    assert.equal(State.getPositions().length, 0);
    assert.deepEqual(guardadas.at(-1), [], "el vaciado tiene que llegar al disco");
  });
});
