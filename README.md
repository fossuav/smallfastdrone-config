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

Playwright E2E lands first; Vitest unit + integration come in later Phase 0 slices. See [docs/TESTING.md](docs/TESTING.md) for the design.

```bash
bun run test:e2e           # Playwright: starts SITL + bridge + Vite, runs the suite, tears down
bun run test:e2e:headed    # Same with a visible browser, useful for debugging
bun run test:e2e:debug     # Pause / step through tests interactively
```

`dev-setup.sh` installs the Playwright Chromium browser (~115 MB, first time only) and warns if the system libs Chromium needs (`libnss3`, `libnspr4`, …) are missing — install with `sudo bun x playwright install-deps chromium` if so.

## What's here right now

A Vite + Vue 3 + TypeScript app with Nuxt UI 4 + Tailwind 4 styling (FOSS UAV brand palette: purple `#4A1E80` + gold `#C9A35F`), ESLint via `@antfu/eslint-config`, and a 6-route shell with a navigation bar (SFD logo top-left):

- **Connect** (`/`) — splash with a slowly rotating 3D X-quad and a live "Connect drone" button
- **Bringup** (`/wizard`), **Recipes** (`/recipes`), **Logs** (`/logs`), **Firmware** (`/firmware`), **ESC tools** (`/esc`) — operator-friendly "Coming soon" placeholders
- **Expert mode** toggle (top-right of nav, off by default, per-session) reveals a **Parameters** (`/params`) route

Each route lazy-loads as its own chunk. State lives in Pinia setup stores (UI/expert-mode + drone session). SmallFastDrone is vendored as a git submodule with `sitl:build/start/stop` scripts. The Connect screen talks to either a real USB-attached drone (Web Serial) or SITL via a WebSocket bridge, parses MAVLink heartbeats, requests AUTOPILOT_VERSION on first heartbeat, and reports the vehicle type, autopilot, firmware version + git hash, system ID, and state (see [SITL](#sitl) below).

Subsequent Phase 0 slices add:

- HTTPS dev (mkcert) + installable PWA shell (vite-plugin-pwa)
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
