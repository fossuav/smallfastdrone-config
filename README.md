# smallfastdrone-config

Browser-based configuration tool for [SmallFastDrone](https://github.com/fossuav/smallfastdrone), an ArduPilot fork for small fast drones.

Designed for **operators, not experts** — get a new drone configured and flying well in the shortest possible time, with the lowest possible risk.

> **Status:** early development, but substantially past scaffold — connect, parameters, the bringup ribbon, firmware flashing and settings backup/restore all work today. Features land slice-by-slice. See [PROGRESS.md](PROGRESS.md) for the current state.

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

A Vite + Vue 3 + TypeScript app with Nuxt UI 4 + Tailwind 4 styling (FOSS UAV brand palette: purple `#4A1E80` + gold `#C9A35F`), ESLint via `@antfu/eslint-config`, and a nav-bar shell (SFD logo top-left). Phases 0–2 are complete; Phase 3 (recipes + Lua engine), Phase 5 (firmware) and Phase 7 (SFD enablement) are in progress. See [PROGRESS.md](PROGRESS.md) for the detail.

- **Connect** (`/`) — splash with a slowly rotating 3D X-quad and a live "Connect drone" button. Talks to a real USB drone (Web Serial) or SITL via the WebSocket bridge, parses heartbeats, and reports vehicle type, autopilot (with "SmallFastDrone" detection from the boot banner), firmware version and state.
- **Bringup** (`/wizard/bringup`) — the bringup **ribbon**: tabs per area, each with a live config panel and its child wizard mounted inline. Walks pre-flight → frame → connections → motors, marking itself complete as it goes. The nav entry lands here directly; the older wizard library still lives at `/wizard` behind an "All wizards" link.
  - **Set up connections** reads `@SYS/uarts.txt` over MAVLink-FTP into a live ports table, detects what's actually plugged in by watching byte counters, and lets you set a port's role from a short list of outcomes (GPS, RC receiver, telemetry radio…) — which writes both the protocol and its recommended baud, then restarts and reconnects for you.
  - **Set up motors** covers ESC protocol + bidirectional DShot, then a props-off order/direction check that identifies mis-wiring and fixes it — preferring a single frame-type change over an output remap. Supports quad, hexa and octa. Also installable **on the radio** as a CRSF applet for no-laptop checks at the field.
- **Field tools** (`/field`, radio icon in the header) — catalogue of applets you can install onto the drone to run from your transmitter, with per-tool install state and the paid-Pro gating seam.
- **Recipes** (`/recipes`) — hosts tuning-flavoured wizards with the same unlocked/locked-Pro card model. Seed recipes (cinewhoop, throw mode, first-flight failsafes) are still to come.
- **Firmware** (`/firmware`) — the firmware-install surface. An online picker builds a firmware.ardupilot.org download URL from vehicle/version/board dropdowns (board and version lists pulled live from GitHub). Then two tabs: "Install over USB" (the daily driver — reboots the drone to its bootloader and flashes a `.apj` over the same port) and "Recovery (DFU mode)" (WebUSB DFU for a bricked or fresh chip; takes `.apj` or `_with_bl.hex`). Both paths are **hardware-verified on TBS_LUCID_H7**, including the preserve-your-settings erase mode. The recovery tab also hides an **unlock** action for read-protected boards — destructive, and not yet bench-verified.
- **Settings** (`/settings`) — feature toggles that write a parameter and handle the restart + reconnect for you (Lua scripting is the first), plus **Your drone's settings**: save and restore its configuration. A backup holds only what's changed from the firmware's own factory defaults, minus read-only parameters — the drone reports which those are via `@PARAM/param.pck?withdefaults=1`. Restoring shows what will change (and what it *can't* put back) before writing.
- **Logs** (`/logs`) and **ESC tools** (`/esc`) — placeholders. Log download is Phase 4, ESC passthrough is Phase 6; neither has started.
- **Expert mode** toggle (top-right, off by default, per-session) reveals **Parameters** (`/params`) — the full param table with metadata-driven descriptions, units, enum dropdowns and decoded bitmasks, inline editing with dirty tracking and per-row undo, and Apply (PARAM_SET + PREFLIGHT_STORAGE) with per-row ack indicators.

Each route lazy-loads as its own chunk. State lives in Pinia setup stores. Status messages of WARNING or worse surface as toasts; a bell icon opens a popover with the most recent ~50, severity-coloured.

The app is an installable PWA — `vite-plugin-pwa` generates a service worker, web manifest, and icons. Drop into Chrome's "Install" menu to get a standalone window.

Still to come, in rough order: seed recipes, log download (Phase 4), the SFD enablement ceremonies (Phase 7 — the enable ceremony's identity half exists as a workflow with no view yet; the lock and the exit ceremony are gated on firmware work), and BLHeli ESC passthrough (Phase 6). There is no CI workflow yet. See [PLAN.md](PLAN.md) for the full plan.

## Project layout

```
.
├── src/
│   ├── protocol/        # MAVLink, FTP, params, secure command (SFD identity), bootloader, DFU, APJ/Intel-HEX
│   ├── transport/       # Web Serial / WebUSB / WebSocket (test) + mocks
│   ├── stores/          # Pinia setup stores (session, params, UI, field tools)
│   ├── workflow/        # orchestration: wizard runtime, Lua engine, firmware,
│   │                    #   motor check, connections, param backup, SFD enable + identity file
│   ├── wizards/         # one directory per wizard: manifest + view (+ applet.lua)
│   ├── security/        # the signed-artifact upload seam every upload routes through
│   ├── views/           # one per route
│   └── ui/              # shared components
├── test/
│   ├── unit/            # Vitest, pure logic (+ fixtures/)
│   ├── e2e/             # Playwright, drives the app against SITL
│   └── sitl/            # WebSocket↔TCP bridge, FTP smoke test
├── scripts/             # dev-setup, SITL build/run, wizard scaffold, lua:check
├── vendor/smallfastdrone/   # SFD firmware submodule, built into SITL for tests
├── docs/                # architecture, UX, testing, security, firmware, wizards, lua
├── CLAUDE.md            # guidance for Claude Code when working in this repo
├── PLAN.md              # mission, decisions log, phase plan
├── PROGRESS.md          # current state of the build
├── TODO.md              # deferred issues + papercuts
└── README.md
```

## Documentation

- **[PLAN.md](PLAN.md)** — mission, audience, decisions log, phase plan
- **[PROGRESS.md](PROGRESS.md)** — current state, recent log
- **[docs/UX.md](docs/UX.md)** — operator-first design principles
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — layered design, module layout
- **[TODO.md](TODO.md)** — deferred issues and papercuts (not the roadmap)
- **[docs/WIZARDS.md](docs/WIZARDS.md)** — wizard runtime contract: manifest, engines, lifecycle
- **[docs/BRINGUP.md](docs/BRINGUP.md)** — the bringup operator flow, phase by phase
- **[docs/FIRMWARE.md](docs/FIRMWARE.md)** — the two firmware-install paths, APJ / Intel-HEX, bootloader + DFU protocols
- **[docs/SECURITY.md](docs/SECURITY.md)** — SFD enablement: per-drone identity, lockdown, recovery, and the firmware work it needs
- **[docs/lua/](docs/lua/)** — ArduPilot Lua playbooks, the authority for writing applets
- **[docs/TESTING.md](docs/TESTING.md)** — test pyramid, SITL setup
- **[docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md)** — Vue / TS standards, AI-slop anti-patterns
- **[CLAUDE.md](CLAUDE.md)** — playbook for Claude Code working in this repo

## License

[GPL-3.0](LICENSE)
