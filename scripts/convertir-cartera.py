#!/usr/bin/env python3
"""Convierte un export de cartera con formato ajeno al que importa la app.

La app importa un array plano de posiciones:
    [{ticker, nombre, tipo, cantidad, precio_compra, precio_manual?}, ...]

Los exports que salen de una captura del broker vienen envueltos y con otros
nombres de campo:
    {"fuente": "...", "moneda": "ARS", "cartera": [
        {"ticker": "...", "descripcion_visible": "...",
         "precio_promedio_compra": 0.0, "ultimo_precio": 0.0, ...}]}

Este script vive en el borde: traduce el formato ajeno al contrato de la app
en vez de ensuciar parsePositionsJson con esquemas de terceros.

    python3 scripts/convertir-cartera.py cartera_Cu.json > cartera_lista.json

El `tipo` no viene en el origen. Se infiere de descripcion_visible y despues se
VALIDA contra el snapshot de cotizaciones: si el ticker no aparece en el panel
inferido pero si en otro, gana el panel donde realmente esta. Si no aparece en
ninguno, queda como "otro" y se le carga precio_manual con ultimo_precio, que
es exactamente para lo que existe ese campo.
"""

import argparse
import json
import pathlib
import sys

SNAPSHOT = pathlib.Path.home() / ".local/share/ar.jeremias.carteratracker/snapshot.json"

# tipo -> panel de data912. Debe coincidir con INSTRUMENT_TYPES en
# src-tauri/src/config.rs; "otro" no tiene panel a proposito.
PANEL = {
    "accion": "arg_stocks",
    "cedear": "arg_cedears",
    "bono": "arg_bonds",
    "on": "arg_corp",
    "nota": "arg_notes",
}

# Prefijos de descripcion_visible -> tipo. Solo una primera hipotesis: el
# snapshot manda.
PREFIJOS = [
    ("cedear", "cedear"),
    ("bono", "bono"),
    ("obligacion", "on"),
    ("on ", "on"),
    ("letra", "nota"),
    ("nota", "nota"),
    ("fideicomiso", "otro"),
]


def tipo_por_descripcion(desc):
    d = (desc or "").strip().lower()
    for prefijo, tipo in PREFIJOS:
        if d.startswith(prefijo):
            return tipo
    return "accion"  # los tickers argentinos sueltos suelen ser acciones


def panel_donde_cotiza(ticker, panels):
    for tipo, panel in PANEL.items():
        if ticker in panels.get(panel, {}):
            return tipo
    return None


def limpiar_nombre(desc, tipo):
    """Saca el prefijo redundante SOLO cuando la columna Tipo ya lo dice.

    "Fideicomiso Financiero" no se saca: cae en tipo 'otro', que no conserva
    esa informacion. Y las descripciones vienen truncadas por el OCR, asi que
    sacar un prefijo puede dejar un resto inservible ("Fideicomiso Financiero
    Ri..." -> "Ri..."); en ese caso se deja la descripcion entera.
    """
    d = (desc or "").strip()
    for prefijo, tipo_que_lo_dice in (("Cedear ", "cedear"), ("Bono ", "bono")):
        if tipo == tipo_que_lo_dice and d.lower().startswith(prefijo.lower()):
            resto = d[len(prefijo):].strip()
            if len(resto.rstrip(". ")) >= 4:
                return resto
    return d


def convertir(origen, panels, avisos):
    filas = origen["cartera"] if isinstance(origen, dict) else origen
    salida = []
    for fila in filas:
        ticker = str(fila["ticker"]).strip().upper()
        desc = fila.get("descripcion_visible", "")

        supuesto = tipo_por_descripcion(desc)
        real = panel_donde_cotiza(ticker, panels) if panels else None

        if real is None:
            tipo = "otro"
            # Sin cobertura automatica: el precio del archivo es lo unico que
            # hay. Se carga como manual para que la fila valorice igual.
            manual = fila.get("ultimo_precio")
            avisos.append(
                f"{ticker}: sin cotizacion en data912 -> tipo 'otro' + "
                f"precio_manual={manual}"
            )
        else:
            tipo = real
            manual = None
            if real != supuesto and panels:
                avisos.append(
                    f"{ticker}: la descripcion sugeria '{supuesto}' pero cotiza "
                    f"en {PANEL[real]} -> '{real}'"
                )

        salida.append({
            "ticker": ticker,
            "nombre": limpiar_nombre(desc, tipo),
            "tipo": tipo,
            "cantidad": fila["cantidad"],
            "precio_compra": fila["precio_promedio_compra"],
            "precio_manual": manual,
        })
    return salida


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("entrada", help="json del broker (envuelto o array plano)")
    ap.add_argument("--snapshot", default=str(SNAPSHOT),
                    help="snapshot.json para validar en que panel cotiza cada "
                         "ticker (por defecto el de la app)")
    args = ap.parse_args()

    origen = json.loads(pathlib.Path(args.entrada).read_text(encoding="utf-8"))

    panels = {}
    snap = pathlib.Path(args.snapshot)
    if snap.exists():
        panels = json.loads(snap.read_text(encoding="utf-8"))["panels"]
    else:
        print(f"AVISO: sin {snap}; no se puede validar contra los paneles "
              "reales y el tipo queda librado a la descripcion. Abri la app y "
              "traé cotizaciones una vez para generarlo.", file=sys.stderr)

    avisos = []
    salida = convertir(origen, panels, avisos)

    for a in avisos:
        print(f"  {a}", file=sys.stderr)
    autom = sum(1 for p in salida if p["precio_manual"] is None)
    print(f"{len(salida)} posiciones | {autom} con cotizacion automatica | "
          f"{len(salida) - autom} con precio manual", file=sys.stderr)

    print(json.dumps(salida, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
