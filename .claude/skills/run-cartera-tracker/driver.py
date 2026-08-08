#!/usr/bin/env python3
"""Driver for the cartera-tracker Tauri desktop app under WSL2/WSLg.

The app is GTK + webkit2gtk. There is no CDP/devtools bridge we can reach, so
this drives it the only way that works headlessly here: a real X11 window,
XTEST synthetic clicks at window-relative pixel coordinates, and ffmpeg
screenshots of that window id.

Run subcommands from the repo root:

    python3 .claude/skills/run-cartera-tracker/driver.py launch
    python3 .claude/skills/run-cartera-tracker/driver.py shot /tmp/a.png
    python3 .claude/skills/run-cartera-tracker/driver.py click refresh
    python3 .claude/skills/run-cartera-tracker/driver.py state
    python3 .claude/skills/run-cartera-tracker/driver.py quit
    python3 .claude/skills/run-cartera-tracker/driver.py smoke   # all of it

Requires: python-xlib (pip install --user python-xlib), ffmpeg, x11-utils.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[3]
BIN = REPO / "src-tauri/target/debug/cartera-tracker"
APPDATA = pathlib.Path.home() / ".local/share/ar.jeremias.carteratracker"
STATE = pathlib.Path("/tmp/cartera-tracker-driver.json")
LOG = pathlib.Path("/tmp/cartera-tracker-app.log")

# Window size from tauri.conf.json (1280x820) plus Weston decorations.
EXPECTED_W, EXPECTED_H = 1356, 917

# Window-relative pixel centres of the header buttons, read off a screenshot at
# EXPECTED_W x EXPECTED_H. They shift if the window is resized.
BUTTONS = {
    "refresh": (686, 90),   # "Actualizar cotizaciones"
    "add": (859, 90),       # "Agregar posicion"
    "import-json": (993, 90),
    "import-csv": (1117, 90),
    "export": (1239, 90),
}


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def app_env():
    """Env that actually produces a visible X11 window under WSLg.

    DISPLAY in a stock WSL2 shell may point at a Windows-side X server that is
    not listening; :0 is WSLg's own. WAYLAND_DISPLAY must be removed or GTK
    picks the Wayland backend and the window never appears on X11 at all.
    """
    env = dict(os.environ)
    env.pop("WAYLAND_DISPLAY", None)
    env["DISPLAY"] = ":0"
    env["GDK_BACKEND"] = "x11"
    env["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
    return env


def check_display():
    if shutil.which("xset") and subprocess.run(
        ["xset", "-display", ":0", "q"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5
    ).returncode != 0:
        die("display :0 no responde. Bajo WSL2 necesitas WSLg corriendo.")


def find_window():
    """Largest sane top-level on :0 — Weston reparents, so the named
    'cartera-tracker' window is a 10x10 stub and the real content window has
    no name at all."""
    out = subprocess.run(
        ["xwininfo", "-root", "-children"],
        env=app_env(), capture_output=True, text=True, timeout=10
    ).stdout
    best = None
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("0x"):
            continue
        try:
            wid = line.split()[0]
            geo = [t for t in line.split() if "x" in t and "+" in t][0]
            wh = geo.split("+")[0]
            w, h = (int(v) for v in wh.split("x"))
        except (ValueError, IndexError):
            continue
        # skip Weston's 10x10 stubs and its 8192x8192 backdrop
        if w < 400 or h < 300 or w > 8000:
            continue
        if best is None or w * h > best[1] * best[2]:
            best = (wid, w, h)
    return best


def save_state(**kw):
    cur = load_state()
    cur.update(kw)
    STATE.write_text(json.dumps(cur))


def load_state():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def cmd_launch(_args):
    if not BIN.exists():
        die(f"falta el binario {BIN}\n  cd src-tauri && cargo build")
    check_display()
    cmd_quit([], quiet=True)

    with open(LOG, "w") as log:
        p = subprocess.Popen([str(BIN)], env=app_env(), stdout=log, stderr=log)
    print(f"lanzado pid={p.pid}, log={LOG}")

    for i in range(40):
        time.sleep(0.5)
        if p.poll() is not None:
            die(f"la app murio al arrancar. log:\n{LOG.read_text()[-2000:]}")
        found = find_window()
        if found:
            wid, w, h = found
            save_state(wid=wid, pid=p.pid, w=w, h=h)
            print(f"ventana {wid} {w}x{h} lista tras {(i + 1) * 0.5:.1f}s")
            if (w, h) != (EXPECTED_W, EXPECTED_H):
                print(f"AVISO: se esperaba {EXPECTED_W}x{EXPECTED_H}; "
                      "las coordenadas de BUTTONS pueden no coincidir")
            # el webview pinta despues de que aparece la ventana
            time.sleep(3)
            return
    die("la ventana nunca aparecio")


def require_window():
    st = load_state()
    wid = st.get("wid")
    if not wid:
        die("no hay ventana registrada — corre 'launch' primero")
    return wid, st.get("w", EXPECTED_W), st.get("h", EXPECTED_H)


def cmd_shot(args):
    if not args:
        die("uso: shot <ruta.png> [x0 y0 x1 y1]")
    wid, w, h = require_window()
    out = args[0]
    # x11grab del root da un frame negro: hay que apuntar al window id.
    # ffmpeg escupe "Cannot get the image data" y aun asi escribe el frame.
    subprocess.run(
        ["ffmpeg", "-loglevel", "quiet", "-f", "x11grab",
         "-window_id", wid, "-video_size", f"{w}x{h}", "-i", ":0",
         "-frames:v", "1", "-y", out],
        env=app_env(), capture_output=True, timeout=30
    )
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        die("ffmpeg no escribio la captura")

    from PIL import Image
    im = Image.open(out)
    if len(args) == 5:
        im = im.crop(tuple(int(v) for v in args[1:5]))
        im.save(out)
    rgb = im.convert("RGB")
    cols = sorted(rgb.getcolors(maxcolors=10 ** 6), reverse=True)
    total = rgb.size[0] * rgb.size[1]
    top_px, top_col = cols[0]
    print(f"{out} {im.size} | {len(cols)} colores | dominante {top_col} "
          f"{100 * top_px / total:.0f}%")
    if len(cols) < 50:
        print("AVISO: frame casi liso — probablemente no renderizo")


def cmd_click(args):
    if not args:
        die(f"uso: click <{'|'.join(BUTTONS)}|X Y>")
    wid, _, _ = require_window()
    if args[0] in BUTTONS:
        wx, wy = BUTTONS[args[0]]
    elif len(args) == 2:
        wx, wy = int(args[0]), int(args[1])
    else:
        die(f"boton desconocido: {args[0]}")

    from Xlib import X, display
    from Xlib.ext import xtest

    d = display.Display(":0")
    root = d.screen().root
    win = d.create_resource_object("window", int(wid, 16))
    p = win.translate_coords(root, 0, 0)
    sx, sy = -p.x + wx, -p.y + wy

    win.set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()
    # fake_input(MotionNotify) mueve el puntero de forma RELATIVA: hay que usar
    # warp_pointer para coordenadas absolutas, y confirmar que llego.
    root.warp_pointer(sx, sy)
    d.sync()
    time.sleep(0.4)
    got = root.query_pointer()
    if (got.root_x, got.root_y) != (sx, sy):
        die(f"el puntero no llego a ({sx},{sy}), quedo en "
            f"({got.root_x},{got.root_y})")

    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    time.sleep(0.1)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    time.sleep(0.3)
    print(f"clic en ventana({wx},{wy}) = pantalla({sx},{sy})")


def cmd_windows(_args):
    """Lista los toplevels de :0. Los popups nativos de <select> abren como
    ventana X aparte y NO salen en la captura de la ventana principal: hay que
    capturarlos por su propio id con
    ffmpeg -f x11grab -window_id <id> -video_size <W>x<H> -i :0 ..."""
    out = subprocess.run(
        ["xwininfo", "-root", "-children"],
        env=app_env(), capture_output=True, text=True, timeout=10
    ).stdout
    main = load_state().get("wid")
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("0x") or "8192x8192" in line:
            continue
        wid = line.split()[0]
        tag = "  <- principal" if wid == main else ""
        print(f"  {line}{tag}")


def cmd_state(_args):
    cd = APPDATA / "cooldown.txt"
    sn = APPDATA / "snapshot.json"
    pf = APPDATA / "portfolio.json"
    print(f"appdata: {APPDATA}")
    if cd.exists():
        ts = int(cd.read_text().strip() or 0)
        left = max(0, 300 - int(time.time() - ts / 1000))
        print(f"  cooldown.txt   ts={ts} restante~{left}s")
    else:
        print("  cooldown.txt   (ausente)")
    if sn.exists():
        d = json.loads(sn.read_text())
        quotes = sum(len(v) for v in d["panels"].values())
        print(f"  snapshot.json  {sn.stat().st_size}B "
              f"paneles={sorted(d['panels'])} cotizaciones={quotes} "
              f"errores={d['errores']}")
    else:
        print("  snapshot.json  (ausente)")
    print(f"  portfolio.json {'presente' if pf.exists() else '(ausente)'}")


def cmd_cooldown(args):
    """Forzar el cooldown en disco. 'expired' habilita el boton; 'now' hace que
    el backend rechace el proximo fetch con MarketError::Cooldown."""
    if not args or args[0] not in ("expired", "now"):
        die("uso: cooldown <expired|now>")
    APPDATA.mkdir(parents=True, exist_ok=True)
    ts = "0" if args[0] == "expired" else str(int(time.time() * 1000))
    (APPDATA / "cooldown.txt").write_text(ts)
    print(f"cooldown.txt = {ts} ({args[0]})")


def cmd_quit(_args, quiet=False):
    # pkill -f mataria el shell que lanzo al driver: su linea de comando
    # contiene la ruta del binario. -x compara solo el nombre del proceso.
    subprocess.run(["pkill", "-x", "cartera-tracker"], capture_output=True)
    time.sleep(1.5)
    if STATE.exists():
        STATE.unlink()
    if not quiet:
        alive = subprocess.run(["pgrep", "-x", "cartera-tracker"],
                               capture_output=True).returncode == 0
        print("app sigue viva" if alive else "app cerrada")


def wait_until(pred, timeout, label):
    """Esperar por una condicion en vez de dormir un rato fijo. fetch_quotes
    hace 5 requests secuenciales con timeout de 15s cada uno: cualquier sleep
    constante que sirva un dia falla al siguiente."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            print(f"  ({label} tras {timeout - (deadline - time.time()):.1f}s)")
            return True
        time.sleep(0.5)
    print(f"  ({label} NO ocurrio en {timeout}s)")
    return False


def cmd_smoke(_args):
    """Flujo completo: arranque -> refresh real -> reinicio -> persistencia."""
    shots = pathlib.Path("/tmp/cartera-smoke")
    shots.mkdir(exist_ok=True)
    ok = True

    def check(cond, label):
        nonlocal ok
        ok = ok and cond
        print(f"{'PASA' if cond else 'FALLA'}  {label}")

    print("== 1. arranque limpio (sin cotizaciones previas) ==")
    cmd_cooldown(["expired"])
    sn = APPDATA / "snapshot.json"
    if sn.exists():
        sn.rename(sn.with_suffix(".json.bak"))
    cmd_launch([])
    cmd_shot([str(shots / "01-vacio.png")])

    print("\n== 2. traer cotizaciones (red real a data912.com) ==")
    cmd_click(["refresh"])
    wait_until(sn.exists, 90, "snapshot escrito")
    cmd_shot([str(shots / "02-con-datos.png")])
    check(sn.exists(), "fetch_quotes escribio snapshot.json")
    if sn.exists():
        d = json.loads(sn.read_text())
        check(len(d["panels"]) == 5,
              f"los 5 paneles con cobertura ({sorted(d['panels'])})")
        check("" not in d["panels"],
              "el panel vacio de 'otro' no se pidio")

    print("\n== 3. reinicio: el snapshot debe sobrevivir ==")
    before = json.loads(sn.read_text())["fetched_at_ms"] if sn.exists() else None
    cmd_quit([], quiet=True)
    cmd_launch([])
    cmd_shot([str(shots / "03-tras-reinicio.png")])
    after = json.loads(sn.read_text())["fetched_at_ms"] if sn.exists() else None
    check(before is not None and before == after,
          "read_snapshot devolvio el snapshot persistido")

    print("\n== 4. MarketError::Cooldown por la ventana ==")
    cmd_quit([], quiet=True)
    cmd_cooldown(["expired"])
    cmd_launch([])           # boton habilitado
    cmd_cooldown(["now"])    # el backend ahora rechaza
    cmd_click(["refresh"])
    # Aca se espera un NO-evento (que no haya fetch), asi que no hay condicion
    # por la cual esperar. El rechazo es inmediato: no toca la red.
    time.sleep(4)
    cmd_shot([str(shots / "04-cooldown.png")])
    after2 = json.loads(sn.read_text())["fetched_at_ms"] if sn.exists() else None
    check(after == after2,
          "el rechazo por cooldown corto antes de cualquier request")

    cmd_quit([], quiet=True)
    print(f"\ncapturas en {shots}/  — MIRALAS, un frame liso es un fallo")
    print("RESULTADO:", "todo bien" if ok else "HAY FALLAS")
    sys.exit(0 if ok else 1)


COMMANDS = {
    "launch": cmd_launch, "shot": cmd_shot, "click": cmd_click,
    "windows": cmd_windows, "state": cmd_state, "cooldown": cmd_cooldown,
    "quit": cmd_quit, "smoke": cmd_smoke,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        print("subcomandos:", ", ".join(COMMANDS))
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])
