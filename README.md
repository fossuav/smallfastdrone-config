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

The browser app will gain a WebSocket bridge to talk to this SITL instance in a later slice.

## Test

Test infrastructure (Vitest + Playwright + SITL bridge) lands in later Phase 0 slices — see [docs/TESTING.md](docs/TESTING.md) for the design. Once it lands:

```bash
bun run test            # unit + integration tests
bun run test:e2e        # end-to-end against SITL
```

Until then, "testing" means running `bun dev` and confirming the page renders, plus `bun run build` succeeds.

## What's here right now

A Vite + Vue 3 + TypeScript app with Nuxt UI 4 + Tailwind 4 styling (FOSS UAV brand palette: purple `#4A1E80` + gold `#C9A35F`), ESLint via `@antfu/eslint-config`, and a 6-route shell with a navigation bar:

- **Connect** (`/`) — splash with SFD logo and a disabled "Connect drone" button
- **Bringup** (`/wizard`), **Recipes** (`/recipes`), **Logs** (`/logs`), **Firmware** (`/firmware`), **ESC tools** (`/esc`) — operator-friendly "Coming soon" placeholders
- **Expert mode** toggle (top-right of nav, off by default, per-session) reveals a **Parameters** (`/params`) route

Each route lazy-loads as its own chunk. State lives in Pinia setup stores (currently just the UI/expert-mode store, persisted via `@vueuse/core`'s `useSessionStorage`). SmallFastDrone is vendored as a git submodule with `sitl:build/start/stop` scripts (see [SITL](#sitl) below). Subsequent Phase 0 slices add:

- Tres.js 3D drone visualization on the Connect screen
- SITL bridge + transport abstraction so the browser can talk to SITL
- MAVLink session via node-mavlink (WebSerial)
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
