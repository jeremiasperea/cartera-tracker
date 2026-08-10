/**
 * PortfolioOps: normalizarPosicion y los parsers de JSON/CSV.
 *
 * Toda posicion que entra a la cartera pasa por aca, y el archivo lo elige el
 * usuario: es la unica superficie del proyecto que consume entrada arbitraria.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadAppReady, plano } from "./helper.mjs";

const CSV_HEADER = "ticker,nombre,tipo,cantidad,precio_compra,precio_manual";

describe("PortfolioOps.normalizarPosicion", () => {
  let PortfolioOps;
  before(async () => {
    ({ PortfolioOps } = await loadAppReady());
  });

  it("normaliza ticker a mayusculas y recorta espacios", () => {
    const p = PortfolioOps.normalizarPosicion({
      ticker: "  ggal ", nombre: "  Galicia  ", tipo: "accion",
      cantidad: "10", precio_compra: "100",
    });
    assert.equal(p.ticker, "GGAL");
    assert.equal(p.nombre, "Galicia");
  });

  it("convierte cantidad y precio de string a numero", () => {
    const p = PortfolioOps.normalizarPosicion({
      ticker: "X", nombre: "X", tipo: "accion",
      cantidad: "2.5", precio_compra: "1234.56",
    });
    assert.equal(p.cantidad, 2.5);
    assert.equal(p.precio_compra, 1234.56);
  });

  it("genera un id cuando el origen no lo trae", () => {
    const a = PortfolioOps.normalizarPosicion({
      ticker: "A", nombre: "A", tipo: "otro", cantidad: 1, precio_compra: 1 });
    const b = PortfolioOps.normalizarPosicion({
      ticker: "B", nombre: "B", tipo: "otro", cantidad: 1, precio_compra: 1 });

    assert.ok(a.id && a.id.length > 0, "el id no puede quedar vacio");
    assert.notEqual(a.id, b.id, "dos altas no pueden compartir id");
  });

  it("respeta el id que ya venia", () => {
    const p = PortfolioOps.normalizarPosicion({
      id: "mio", ticker: "A", nombre: "A", tipo: "otro",
      cantidad: 1, precio_compra: 1 });
    assert.equal(p.id, "mio");
  });

  it("acepta el tipo en mayusculas o con espacios", () => {
    const p = PortfolioOps.normalizarPosicion({
      ticker: "A", nombre: "A", tipo: "  CEDEAR ", cantidad: 1, precio_compra: 1 });
    assert.equal(p.tipo, "cedear");
  });

  it("rechaza un tipo que no existe, y dice cuales valen", () => {
    assert.throws(
      () => PortfolioOps.normalizarPosicion({
        ticker: "A", nombre: "A", tipo: "cripto", cantidad: 1, precio_compra: 1 }),
      (err) => err.message.includes("cripto") && err.message.includes("cedear")
    );
  });

  it("sin tipo cae en 'otro' en vez de explotar", () => {
    const p = PortfolioOps.normalizarPosicion({
      ticker: "A", nombre: "A", cantidad: 1, precio_compra: 1 });
    assert.equal(p.tipo, "otro");
  });

  it("rechaza cantidad o precio no numericos nombrando el ticker", () => {
    for (const malo of [
      { cantidad: "diez", precio_compra: "1" },
      { cantidad: "1", precio_compra: "" },
      { cantidad: "1", precio_compra: "N/A" },
    ]) {
      assert.throws(
        () => PortfolioOps.normalizarPosicion({
          ticker: "FALLA", nombre: "x", tipo: "otro", ...malo }),
        (err) => err.message.includes("FALLA"),
        `deberia rechazar ${JSON.stringify(malo)}`
      );
    }
  });

  // Un precio manual vacio significa "sin precio manual", no 0: un 0 haria
  // valorizar la posicion en cero (ver market.test.mjs).
  it("precio_manual vacio o ausente queda en null, no en 0", () => {
    for (const valor of ["", null, undefined]) {
      const p = PortfolioOps.normalizarPosicion({
        ticker: "A", nombre: "A", tipo: "otro",
        cantidad: 1, precio_compra: 1, precio_manual: valor });
      assert.equal(p.precio_manual, null, `con precio_manual=${valor}`);
    }
  });

  it("un precio manual invalido queda en null en vez de NaN", () => {
    const p = PortfolioOps.normalizarPosicion({
      ticker: "A", nombre: "A", tipo: "otro",
      cantidad: 1, precio_compra: 1, precio_manual: "ninguno" });
    assert.equal(p.precio_manual, null, "un NaN envenenaria el total valorizado");
  });
});

describe("PortfolioOps.parsePositionsJson", () => {
  let PortfolioOps;
  before(async () => {
    ({ PortfolioOps } = await loadAppReady());
  });

  it("acepta un array de posiciones", () => {
    const r = PortfolioOps.parsePositionsJson(JSON.stringify([
      { ticker: "GGAL", nombre: "Galicia", tipo: "accion",
        cantidad: 1, precio_compra: 100 },
    ]));
    assert.equal(r.length, 1);
    assert.equal(r[0].ticker, "GGAL");
  });

  it("acepta un array vacio", () => {
    assert.deepEqual(plano(PortfolioOps.parsePositionsJson("[]")), []);
  });

  // El export de un broker suele venir envuelto en un objeto; para eso esta
  // scripts/convertir-cartera.py. Aca solo se fija que el rechazo sea claro.
  it("rechaza un objeto envolvente y lo dice", () => {
    assert.throws(
      () => PortfolioOps.parsePositionsJson('{"cartera":[]}'),
      /array de posiciones/
    );
  });

  it("propaga el error de JSON invalido", () => {
    assert.throws(() => PortfolioOps.parsePositionsJson("{no es json}"));
  });
});

describe("PortfolioOps.parsePositionsCsv", () => {
  let PortfolioOps;
  before(async () => {
    ({ PortfolioOps } = await loadAppReady());
  });

  it("lee las filas bajo el header", () => {
    const r = PortfolioOps.parsePositionsCsv(
      `${CSV_HEADER}\nGGAL,Galicia,accion,10,100,\nAAPL,Apple,cedear,2,24000,`);
    assert.equal(r.length, 2);
    assert.equal(r[0].ticker, "GGAL");
    assert.equal(r[1].tipo, "cedear");
  });

  it("no depende del orden de las columnas", () => {
    const r = PortfolioOps.parsePositionsCsv(
      "precio_compra,tipo,ticker,cantidad,nombre\n100,accion,GGAL,10,Galicia");
    assert.equal(r[0].ticker, "GGAL");
    assert.equal(r[0].precio_compra, 100);
    assert.equal(r[0].cantidad, 10);
  });

  it("precio_manual es opcional", () => {
    const r = PortfolioOps.parsePositionsCsv(
      "ticker,nombre,tipo,cantidad,precio_compra\nX,X,otro,1,1");
    assert.equal(r[0].precio_manual, null);
  });

  it("toma el precio_manual cuando la columna esta", () => {
    const r = PortfolioOps.parsePositionsCsv(`${CSV_HEADER}\nX,X,otro,1,1,555.5`);
    assert.equal(r[0].precio_manual, 555.5);
  });

  it("ignora lineas en blanco y soporta finales de linea de Windows", () => {
    const r = PortfolioOps.parsePositionsCsv(
      `${CSV_HEADER}\r\nGGAL,Galicia,accion,10,100,\r\n\r\n`);
    assert.equal(r.length, 1);
  });

  it("un CSV vacio da una cartera vacia, no un error", () => {
    assert.deepEqual(plano(PortfolioOps.parsePositionsCsv("")), []);
    assert.deepEqual(plano(PortfolioOps.parsePositionsCsv("\n\n")), []);
  });

  it("acepta el header con mayusculas y espacios", () => {
    const r = PortfolioOps.parsePositionsCsv(
      " Ticker , Nombre , TIPO , Cantidad , Precio_Compra \nX,X,otro,1,1");
    assert.equal(r[0].ticker, "X");
  });

  it("rechaza un header al que le falta una columna obligatoria", () => {
    assert.throws(
      () => PortfolioOps.parsePositionsCsv("ticker,nombre,tipo,cantidad\nX,X,otro,1"),
      /el CSV necesita header/
    );
  });

  it("solo el header da una cartera vacia", () => {
    assert.deepEqual(plano(PortfolioOps.parsePositionsCsv(CSV_HEADER)), []);
  });
});
