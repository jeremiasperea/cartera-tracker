---
name: run-cartera-tracker
description: Build, launch, screenshot, and drive the cartera-tracker Tauri desktop app. Use when asked to run, start, test, screenshot, or click through the app, or to confirm a change works in the real window instead of only in unit tests.
---

# Run cartera-tracker

Tauri v2 desktop app: Rust backend (`src-tauri/`) + vanilla-JS webview
(`ui/`). No bundler, no npm — `cargo` builds everything and the webview
loads `ui/` straight off disk.

There is no CDP/devtools bridge into webkit2gtk, so the agent path is
**`driver.py`**: it launches the app on WSLg's X11 display, clicks with
XTEST at window-relative pixel coordinates, and screenshots the window
id with ffmpeg. Paths below are relative to the repo root.

## Prerequisites

Verified installed here: `x11-utils` (xwininfo), `x11-xserver-utils`
(xset), `ffmpeg`, `python3-pil`. The only thing this session had to add:

```bash
pip install --user python-xlib
```

Needs a working WSLg session — see the DISPLAY gotcha below.

## Build

```bash
cd src-tauri && cargo build
```

First build pulls ~440 crates and takes several minutes; later builds
are seconds. No icon generation step is needed — `src-tauri/icons/*.png`
are committed.

## Run (agent path)

```bash
python3 .claude/skills/run-cartera-tracker/driver.py smoke
```

`smoke` is the whole story in one command: clean start → real fetch from
data912.com → restart → cooldown-rejection path. It asserts each step and
drops four screenshots in `/tmp/cartera-smoke/`. **Open them.** The
assertions cannot tell a working countdown from an error dialog; only the
picture can.

Individual subcommands:

```bash
python3 .claude/skills/run-cartera-tracker/driver.py launch
python3 .claude/skills/run-cartera-tracker/driver.py shot /tmp/a.png
python3 .claude/skills/run-cartera-tracker/driver.py shot /tmp/top.png 0 60 1356 150
python3 .claude/skills/run-cartera-tracker/driver.py click refresh
python3 .claude/skills/run-cartera-tracker/driver.py click add
python3 .claude/skills/run-cartera-tracker/driver.py key ctrl+l
python3 .claude/skills/run-cartera-tracker/driver.py type /tmp/cl.json
python3 .claude/skills/run-cartera-tracker/driver.py key Return
python3 .claude/skills/run-cartera-tracker/driver.py windows
python3 .claude/skills/run-cartera-tracker/driver.py state
python3 .claude/skills/run-cartera-tracker/driver.py cooldown expired
python3 .claude/skills/run-cartera-tracker/driver.py quit
```

`shot` takes an optional `x0 y0 x1 y1` crop and prints a colour histogram —
it warns when a frame is nearly flat, which is what a failed render looks
like. Button names for `click`: `refresh`, `add`, `import-json`,
`import-csv`, `export`. `state` dumps the app-data dir (cooldown seconds
left, snapshot size, panel names, quote count). `type` and `key` send XTEST
keystrokes to the focused window — the only way to drive the native GTK
dialogs, which are outside the webview.

**Importing a JSON file end to end** (the flow that exercises
`confirmImport`):

```bash
python3 .claude/skills/run-cartera-tracker/driver.py click import-json
python3 .claude/skills/run-cartera-tracker/driver.py key ctrl+l    # barra de ubicacion GTK
python3 .claude/skills/run-cartera-tracker/driver.py type /tmp/cl.json
python3 .claude/skills/run-cartera-tracker/driver.py key Return
python3 .claude/skills/run-cartera-tracker/driver.py click 810 538  # "Reemplazar"
```

The table is taller than the window with ~18 positions; `key End` scrolls to
the totals row.

## Run (human path)

`cargo tauri dev` works, but **only** with the same env fix the driver
applies — bare `cargo tauri dev` hangs to timeout with an empty log:

```bash
cd src-tauri && env -u WAYLAND_DISPLAY DISPLAY=:0 GDK_BACKEND=x11 cargo tauri dev
```

Adds file-watching and rebuilds on change (~45s cold, seconds warm), which
`driver.py launch` does not. Prints a benign
`Disabled hardware acceleration because GTK failed to initialize GL`
warning and falls back to software rendering.

## Test

```bash
cd src-tauri && cargo test          # 12 tests (Rust)
node --test 'test/*.test.mjs'       # 120 tests (JS, node:test — sin dependencias)
```

`test/helper.mjs` carga el `ui/app.js` real en un `node:vm` y devuelve sus
módulos, así los tests corren el código que se envía y no una reimplementación.
Lee `INSTRUMENT_TYPES` desde `config.rs`, de modo que un cambio en Rust no puede
dejar los tests en verde por usar un fixture viejo.

- **Pasá el glob.** `node --test` a secas también toma `test/helper.mjs` como
  archivo de test y reporta un test fantasma de más.
- **`assert.deepStrictEqual` falla entre realms.** Los arrays creados dentro del
  `vm` tienen otro `Array.prototype`, así que comparar contra `[]` da el
  desconcertante `actual: [] expected: []`. Usá `plano(x)` del helper.

## Gotchas

- **`DISPLAY` in a stock WSL2 shell points at a Windows-side X server that
  is not listening** (`10.255.255.254:0.0` here). `xset -display $DISPLAY q`
  fails; `:0` works. This is why `cargo tauri dev` hangs to timeout with an
  empty log. `driver.py` forces `DISPLAY=:0`.
- **`WAYLAND_DISPLAY` makes GTK pick the Wayland backend**, and the window
  then never exists on X11 — `xwininfo` shows only Weston's own stubs and no
  screenshot tool can see it. Must be unset plus `GDK_BACKEND=x11`.
- **`pkill -f` kills the calling shell here.** The launch command line
  contains the pattern, so the shell matches itself — this bit twice, once
  with `pkill -f 'target/debug/cartera-tracker'` and again with
  `pkill -f 'cargo-tauri dev'`. Always match on the process name:
  `pkill -x cartera-tracker`, `pkill -x cargo-tauri`.
- **x11grab of the root region returns a pure-black frame.** Must pass
  `-window_id`. ffmpeg then prints `Cannot get the image data ...` on stderr
  and writes a perfectly good frame anyway — ignore that line.
- **Weston reparents the window.** The toplevel named `cartera-tracker` is a
  10x10 stub; the real content window has no name. `driver.py` finds it by
  picking the largest sane top-level.
- **The file chooser is a native GTK dialog, not part of the webview** — no
  amount of clicking inside the app window reaches it. Drive it with
  `key ctrl+l` to open the location bar, then `type <path>`, then
  `key Return`. Keep the path short: every character is a separate XTEST
  keystroke, and `~` does not expand.
- **Native `<select>` popups open as a separate X window** and are invisible in
  a `-window_id` capture of the main window — the screenshot shows the closed
  select as if the click did nothing. Run `driver.py windows` after clicking a
  select to find the new toplevel, then grab it by its own id:
  `ffmpeg -f x11grab -window_id <id> -video_size 378x140 -i :0 -frames:v 1 -y out.png`.
- **XTEST `fake_input(MotionNotify)` moves the pointer *relatively*.** The
  first click silently lands wherever the cursor already was. Use
  `root.warp_pointer(x, y)` and confirm with `query_pointer()` before
  pressing — `driver.py` aborts if the pointer did not land.
- **Button coordinates are pixels** tied to the 1280x820 window in
  `tauri.conf.json` (1356x917 with Weston decorations). Resize the window and
  `BUTTONS` in `driver.py` goes stale; `launch` warns when the size differs.
- **The cooldown-error path is unreachable by clicking.** The UI guards it
  twice — disabled button plus an early return in `refreshQuotes()`. To reach
  `MarketError::Cooldown`, launch with `cooldown expired` (button enabled),
  then `cooldown now` while the app is running, then click. `smoke` step 4
  does this.
- **`smoke` hits data912.com for real** and rewrites the app-data dir. Any
  existing `snapshot.json` is moved aside to `snapshot.json.bak` first.
- **Bundling is untested.** `bundle.active` is `false` and
  `src-tauri/icons/icon.icns` / `icon.ico` are 0-byte placeholders, so
  `cargo tauri build` with bundling on has never been run here.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cargo tauri dev` hangs, log empty | Wrong `DISPLAY`. Use `driver.py launch`. |
| `driver.py launch` → "la ventana nunca aparecio" | `xset -display :0 q` — if that fails WSLg is down; restart WSL. |
| Screenshot is one flat colour | You grabbed the root instead of `-window_id`, or the webview had not painted — `launch` already waits 3s after the window appears. |
| Click does nothing, no error | Pointer never moved (relative-motion trap). `driver.py` catches this; ad-hoc scripts must use `warp_pointer`. |
| Shell dies mid-command | You ran `pkill -f` with the binary path. Use `pkill -x`. |
| `ModuleNotFoundError: Xlib` | `pip install --user python-xlib` |
| Build: `icon ... is not RGBA` | An icon PNG lost its alpha channel. Regenerate as `Image.new('RGBA', ...)`. |
