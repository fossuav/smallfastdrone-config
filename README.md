# smallfastdrone-config

Browser-based configuration tool for [SmallFastDrone](https://github.com/fossuav/smallfastdrone), an ArduPilot fork for small fast drones.

Designed for **operators, not experts** — get a new drone configured and flying well in the shortest possible time, with the lowest possible risk.

> **Status:** early development. Currently a Vite + Vue 3 + TypeScript scaffold; substantive features land slice-by-slice. See [PROGRESS.md](PROGRESS.md) for the current state.

## Getting started

Prerequisites: a recent Linux or macOS shell (Windows: use WSL2) with `bash`, `git`, and `curl` available.

```bash
git clone https://github.com/fossuav/smallfastdrone-config.git
cd smallfastdrone-config
bun run setup
```

The setup script installs [bun](https://bun.sh) (if missing) and project dependencies. It is idempotent — safe to re-run any time. As more slices land, the script grows to install whatever new prerequisites they need (Playwright browsers, mkcert, SITL build deps, etc.).

## Develop

```bash
bun dev          # Vite dev server at http://localhost:5173
bun run build    # production build to dist/
bun run preview  # serve the production build locally
bun run typecheck
bun run lint     # ESLint via @antfu/eslint-config (lint + format check)
bun run lint:fix # auto-fix what's auto-fixable
```

### Scaffold a wizard

```bash
bun run new:wizard <id> [Human Title...]      # desktop wizard
bun run new:wizard <id> --lua                 # + a Lua applet stub
```

Creates `src/wizards/<id>/` with a `manifest.ts` + `DesktopView.vue` (and `applet.lua` with `--lua`) following house conventions — GPL header, the manifest shape, `returnTo`/`markComplete`, and a visual placeholder. Wizards are auto-discovered, so the new one shows up in the library immediately. The output typechecks and lints clean but is a stub: every `TODO` marks a decision to make (the visual, the operator copy, the params it owns, the actual work). `--category`/`--hero` override the defaults.

## SITL

SmallFastDrone source is vendored as a git submodule at `vendor/smallfastdrone/`. `bun run setup` initialises it. Then:

```bash
bun run sitl:build   # build ArduCopter SITL (5-10 min cold, fast after — uses ccache)
bun run sitl:start   # start it on TCP 127.0.0.1:5760
bun run sitl:stop    # stop it
```

### Browser → SITL via the bridge

The browser can't speak TCP directly. A small Bun WebSocket bridge translates ws://localhost:5761 ↔ tcp://localhost:5760. One command starts SITL + bridge + dev server with interleaved output; Ctrl-C stops everything:

```bash
bun run dev:sitl
```

Open the URL it prints (<http://localhost:5173/?transport=websocket&host=localhost:5761>) and click **Connect drone**. The page shows live bytes received from SITL (MAVLink parsing arrives in the next slice).

For finer control during debugging — three terminals, individual logs:

```bash
bun run sitl:start    # terminal 1
bun run bridge:start  # terminal 2
bun dev               # terminal 3
```

## Test

Vitest covers pure logic; Playwright E2E drives the UI against SITL. See [docs/TESTING.md](docs/TESTING.md) for the design.

```bash
bun run test:unit          # Vitest: pure-logic unit tests (no I/O), fast
bun run test:unit:watch    # Vitest in watch mode
bun run test:e2e           # Playwright: starts SITL + bridge + Vite, runs the suite, tears down
bun run test:e2e:headed    # Same with a visible browser, useful for debugging
bun run test:e2e:debug     # Pause / step through tests interactively
bun run lua:check <applet.lua> [module.lua ...]   # load a Lua/CRSF applet on SITL + report errors
```

`lua:check` is the quick "does this applet load?" check for Lua/CRSF wizards: it places the applet (and any `require`'d modules) on a running SITL, enables scripting, reboots, and watches the GCS text stream for the load line and any Lua errors. The CRSF *menu interaction* still needs a real transmitter. Example:

```bash
bun run lua:check src/wizards/motor-check/applet.lua src/wizards/motor-check/crsf_helper.lua
```

`dev-setup.sh` installs the Playwright Chromium browser (~115 MB, first time only) and warns if the system libs Chromium needs (`libnss3`, `libnspr4`, …) are missing — install with `sudo bun x playwright install-deps chromium` if so.

## What's here right now

A Vite + Vue 3 + TypeScript app with Nuxt UI 4 + Tailwind 4 styling (FOSS UAV brand palette: purple `#4A1E80` + gold `#C9A35F`), ESLint via `@antfu/eslint-config`, and a 6-route shell with a navigation bar (SFD logo top-left):

- **Connect** (`/`) — splash with a slowly rotating 3D X-quad and a live "Connect drone" button
- **Bringup** (`/wizard`), **Recipes** (`/recipes`), **Logs** (`/logs`), **ESC tools** (`/esc`) — operator-friendly "Coming soon" placeholders
- **Firmware** (`/firmware`) — full operator surface for the firmware-install flow. Tabbed "Install over USB" (bootloader path; requires a connected drone; takes a `.apj` and walks reboot-to-bootloader → erase → program → verify → reboot → reconnect) and "Recovery (DFU mode)" (WebUSB DFU; operator puts the chip in DFU mode by hand; accepts `.apj` for recovery or `_with_bl.hex` for a fresh chip). All upload paths route through the security uploader seam. The bootloader path is the daily-driver; DFU is the safety net for bricked boards or fresh chips. **Bench-hardware verification still pending** — no SITL substitute exists for either flash path.
- **Settings** (`/settings`) — operator-facing drone settings. Feature toggles that write a parameter and handle the restart + reconnect for you (Lua scripting is the first), plus **Your drone's settings**: save the drone's configuration to a JSON file you can keep. A backup holds only what's been changed from the firmware's own factory defaults, minus read-only parameters — the drone itself reports which those are, via `@PARAM/param.pck?withdefaults=1` over MAVLink-FTP. Useful on its own for undoing a day's changes, and a prerequisite for the SFD recovery flow, where lowering readout protection mass-erases the board (see [docs/SECURITY.md](docs/SECURITY.md)). Restoring a backup is not built yet.
- **Expert mode** toggle (top-right of nav, off by default, per-session) reveals a **Parameters** (`/params`) route — auto-fetches the FC's full param set on mount, searchable table with descriptions + units pulled from the SFD source (regenerate after submodule bumps with `bun run params:rebuild`), click any value to edit inline (type-aware: dropdown for enum-style params like `RTL_ALT_TYPE`, decoded labels for bitmasks like `RTL_OPTIONS`, range hint in input tooltips), dirty tracking with row highlight + "was X" + per-row undo, Discard / **Apply** — Apply writes pending changes back to the drone (PARAM_SET + PREFLIGHT_STORAGE) with per-row ack indicators and a success / partial / failed summary.

Each route lazy-loads as its own chunk. State lives in Pinia setup stores (UI/expert-mode + drone session). SmallFastDrone is vendored as a git submodule with `sitl:build/start/stop` scripts. The Connect screen talks to either a real USB-attached drone (Web Serial) or SITL via a WebSocket bridge, parses MAVLink heartbeats, requests AUTOPILOT_VERSION + DO_SEND_BANNER on first heartbeat, and reports the vehicle type, autopilot (with "SmallFastDrone" detection from the boot banner), firmware version + git hash, system ID, and state (see [SITL](#sitl) below). Status messages with WARNING or worse severity surface as toasts; a bell icon in the nav opens a popover with the most recent ~50 messages, severity-coloured, with relative timestamps.

The app is an installable PWA — `vite-plugin-pwa` generates a service worker, web manifest, and icons. Drop into Chrome's "Install" menu to get a standalone window.

Phase 0 is now substantively complete. Next up: the actual feature work (param browser, recipe runner, tuning workflows). See [PROGRESS.md](PROGRESS.md).
- First Playwright E2E test (drives SITL through a heartbeat connect)
- HTTPS dev via mkcert + PWA shell via vite-plugin-pwa

After Phase 0, the bigger pieces land in order: param browser, bringup wizard, recipe library, log download, DFU firmware flashing, BLHeli ESC passthrough.

See [PLAN.md](PLAN.md) for the full plan and [PROGRESS.md](PROGRESS.md) for what's actually done.

## Project layout

```
.
├── src/                 # Vue 3 + TS app
├── scripts/             # dev-setup; future SITL build helpers
├── docs/                # architecture, UX, testing, security, coding standards
├── CLAUDE.md            # guidance for Claude Code when working in this repo
├── PLAN.md              # mission, decisions log, phase plan
├── PROGRESS.md          # current state of the build
└── README.md
```

## Documentation

- **[PLAN.md](PLAN.md)** — mission, audience, decisions log, phase plan
- **[PROGRESS.md](PROGRESS.md)** — current state, recent log
- **[docs/UX.md](docs/UX.md)** — operator-first design principles
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — layered design, module layout
- **[docs/BRINGUP.md](docs/BRINGUP.md)** — wizard contract, recipe library
- **[docs/SECURITY.md](docs/SECURITY.md)** — security seam, threat model
- **[docs/TESTING.md](docs/TESTING.md)** — test pyramid, SITL setup
- **[docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md)** — Vue / TS standards, AI-slop anti-patterns
- **[CLAUDE.md](CLAUDE.md)** — playbook for Claude Code working in this repo

## License

[GPL-3.0](LICENSE)
