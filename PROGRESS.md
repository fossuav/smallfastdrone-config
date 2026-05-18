# PROGRESS

Single source of truth for what's been done, what's in flight, and what's blocked.

Update alongside any meaningful change. Keep entries short. This file replaces memory storage for project state — don't store progress in `~/.claude/projects/.../memory/`.

## Status: Planning

Project is at the planning stage. No application code exists yet. The repo currently contains:

- Plan and architecture docs (this directory)
- LICENSE, README.md (stubs)

## Phases

| Phase | Status | Notes |
|---|---|---|
| Planning | ✅ Complete (2026-05-15) | Initial plan, architecture, bringup, security docs in place |
| Phase 0 — Scaffolding | 🔧 In progress | Slices done: 1 (scaffold), 3 (lint), 2 (UI lib), 4 (router+views), 5 (Pinia+expert mode), 7 (SFD submodule + SITL), 9–10 (transport abstraction + SITL bridge — Connect button works against SITL). Browser can talk to a drone. Next: parse heartbeat to show vehicle info; later Tres.js, real WebSerial, Playwright, HTTPS+PWA. |
| Phase 1 — MAVLink + params | ⏳ Not started | node-mavlink, param fetch/set, Pinia store, param browser |
| Phase 2 — Bringup wizard | ⏳ Not started | State machine, phase gates, IndexedDB persistence |
| Phase 3 — Recipe library | ⏳ Not started | SFD-flavoured tuning recipes, dry-run + commit |
| Phase 4 — Log handling | ⏳ Not started | LOG_REQUEST_LIST/DATA pull, handoff to analysis-private |
| Phase 5 — DFU + Security seam | ⏳ Not started | WebUSB DFU flashing of SFD firmware via SignedArtifactUploader; no direct upload paths |
| Phase 6 — MSP + BLHeli passthrough | ⏳ Not started | Minimal MSP for BLHeli entry; full 4-way for ESC settings + firmware flash |

Test infrastructure (cross-cutting, lands during Phase 0 alongside the app shell):

| Item | Status | Notes |
|---|---|---|
| SFD submodule at `vendor/smallfastdrone/` | ✅ Landed (slice 7) | Pinned to SFD `SmallFastDrone-4.7-beta` HEAD `d0615774f4`. `dev-setup.sh` runs `git submodule update --init --recursive` (5-10 min first time) |
| SITL build orchestration | ✅ Landed (slice 7) | `bun run sitl:build` / `start` / `stop`. `dev-setup.sh` checks for gcc/g++/python3/ccache and warns if missing. |
| SITL bridge (`test/sitl/bridge.ts`) | ✅ Landed (slice 9-10) | Zero-dep Bun script; verified end-to-end forwarding SITL bytes to a WS client |
| Transport abstraction (incl. `WebSocketTransport`) | ✅ Landed (slice 9-10) | `src/transport/{types,websocket,webserial,select}.ts`; URL-param picker (`?transport=websocket&host=...`); WebSerial is stubbed until there's bench hardware |
| CI workflow | ⏳ Not started | Submodule checkout, ccache, layered test runs |

## Recent log

- 2026-05-18: **Phase 0 slices 9–10 — transport abstraction + SITL bridge.** First end-to-end browser↔drone connection. Files: `src/transport/{types,websocket,webserial,select}.ts` (interface + WebSocket impl + WebSerial stub + URL-param picker), `src/stores/session.ts` (connect/disconnect/byte counter), updated `ConnectView` (live button + status), `test/sitl/bridge.ts` (zero-dep Bun WebSocket↔TCP bridge), `bun run bridge:start` script, `@types/bun` dev dep, eslint config relaxes `no-console`/`process` for `test/` + `scripts/` Bun CLI files. Verified end-to-end with a Bun WS client: 317 bytes / 5 s from SITL through bridge to the client. URL param `?transport=websocket&host=localhost:5761` selects the WebSocket transport; default falls back to a WebSerial stub that tells the operator how to use SITL until WebSerial is wired up. Production code does not import test transports.
- 2026-05-18: **Phase 0 slice 7 — SFD submodule + SITL build orchestration.** SmallFastDrone added as a git submodule at `vendor/smallfastdrone/`, pinned to current `SmallFastDrone-4.7-beta` HEAD (`d0615774f4`). Scripts added: `scripts/sitl-build.sh` (waf configure --board sitl + ./waf copter), `scripts/sitl-start.sh` (runs ArduCopter SITL on TCP 127.0.0.1:5760 from a temp workdir, pidfile-tracked), `scripts/sitl-stop.sh`. `bun run sitl:build` / `sitl:start` / `sitl:stop` wired in `package.json`. `dev-setup.sh` extended to recursively init submodules and probe for SITL build prerequisites. Verified: setup completes; recursive submodule init pulled mavlink, ChibiOS, DroneCAN, gtest et al. SITL build run-time on this machine still being measured.
- 2026-05-18: **Phase 0 slice 5 — Pinia + @vueuse/core + expert-mode toggle.** First Pinia setup store (`src/stores/ui.ts`) holds the expert flag, persisted per-session via `useSessionStorage` (clears on tab close, per UX.md). A `<USwitch color="secondary">` in the nav-bar header toggles it. Added `/params` route with `meta.expert: true`; nav items filter on `expert`, so the Parameters tab appears only when the switch is on. The route URL stays reachable for deep-linking either way — the toggle gates *visibility in nav*, not access. Lazy bundle: ParamsView 0.97 KB. Main bundle 421 KB / 131 KB gzip (+16 KB raw, +5 KB gzip for Pinia + the parts of @vueuse we use).
- 2026-05-18: **FOSS UAV brand palette applied.** Sampled from `fossuav_logo.PNG`: purple anchor `#4A1E80`, gold anchor `#C9A35F`. Hand-derived 11-stop scales (`foss-*`, `gold-*`) defined in `src/assets/css/main.css` via Tailwind 4 `@theme`, wired into Nuxt UI as `primary: foss`, `secondary: gold`, `neutral: neutral`. Updated `docs/UX.md` "Visual language" with a Brand palette subsection documenting the choice.
- 2026-05-18: **Phase 0 slice 4 — app shell with 6 routes**. `src/router.ts` defines lazy-loaded routes for Connect / Bringup / Recipes / Logs / Firmware / ESC tools, each with operator-friendly placeholder content. `App.vue` is now the shell: `<UApp>` + top nav bar (`<UNavigationMenu>` driven by route metadata) + `<RouterView>`. Splash card moved into `ConnectView`. Build now chunks each view (~0.8 KB lazy per route). Main bundle: 405 KB / 127 KB gzip.
- 2026-05-18: **Phase 0 slice 2 — Nuxt UI 4 + Tailwind 4** wired in. Vite plugin (`@nuxt/ui/vite`) + Tailwind/`@nuxt/ui` CSS imports + vue-plugin in `main.ts`. Landing page now renders a styled `UCard` with a disabled "Connect drone" button. Discovered Nuxt UI 4 requires vue-router (its `<NuxtLink>` override imports `useRoute`), so vue-router 5 came along with this slice — a minimal empty-routes setup until the app-shell slice fills it in. PLAN/CLAUDE updated from "vue-router 4" → "vue-router 5" (current stable). Build: 678 modules, 270 KB JS / 175 KB CSS (gzip 92 / 23). Lint, typecheck, dev server all green.
- 2026-05-18: **Feedback-into-playbooks discipline pinned.** Substantive user guidance lands in the relevant playbook (`CLAUDE.md`, `PLAN.md`, `PROGRESS.md`, `docs/*`) in the same change — not just applied in-the-moment. Playbooks always reflect current intent. Revisions to prior decisions go in the original row, not bolted on top. Captured in CLAUDE.md "How we work".
- 2026-05-18: **Working principles pinned.** Bias for working code — every step ships something runnable and reviewable, no big-bang phases. Plan is provisional — phases / decision rows can shift as we learn what the operator actually wants; updating PLAN.md + PROGRESS.md is normal, not exceptional. Captured in CLAUDE.md "How we work" and PLAN.md "Phased delivery" preamble.
- 2026-05-18: **Test infrastructure plan.** Added [docs/TESTING.md](docs/TESTING.md). SFD becomes a git submodule at `vendor/smallfastdrone/` (URL: `https://github.com/fossuav/smallfastdrone.git`) so we can build SITL and validate the tool against real ArduPilot in CI. Test pyramid: Vitest unit (fixtures), Vitest integration (Bun→TCP→SITL), Playwright E2E (browser→WebSocket bridge→SITL). Zero-dep Bun bridge at `test/sitl/bridge.ts`. Test transport selected via URL param — production bundle contains no test code. Each phase now has a paired test acceptance criterion. Phase 0 expanded to include the full test infrastructure. Added `playwright` to dev deps. See PLAN.md decisions rows 26–30 and updated Phase 0.
- 2026-05-18: **Coding standards adopted.** Added [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md). Adopted **Vue.js official Style Guide** (Priority A + B) as authoritative Vue conventions doc; **`@antfu/eslint-config`** for enforcement (Vue + TS + formatter in one); `.editorconfig` for editor consistency. Includes an explicit "AI slop" anti-pattern list. **Walked back the Biome decision** (PLAN.md row 12 revised) — Biome's Vue SFC support is not first-class in 2026, and antfu's config is the ecosystem standard. See PLAN.md decisions rows 12, 23–25.
- 2026-05-15: **Operator-first repositioning.** Tool is for operators, not experts. Added [docs/UX.md](docs/UX.md) — operator-first design playbook (visual language, microcopy rules, expert-mode definition, anti-patterns). Param browser becomes expert-mode-only; wizard + recipes are primary surfaces. Added `@tresjs/core` + `@tresjs/cientos` (3D drone hero) and `@vueuse/core` (composition utilities) to dep budget. Updated bringup phases to specify a hero visual per phase. Updated recipe presentation: illustrated cards with outcome names, not parameter lists. See PLAN.md decisions rows 18–22.
- 2026-05-15: **Scope expansion** — added DFU firmware flashing (Phase 5, paired with security seam) and MSP + BLHeli 4-way passthrough (new Phase 6). DFU uses WebUSB; MSP+4-way ride WebSerial alongside MAVLink. ArduPilot's `AP_BLHeli` confirmed as the FC-side MSP+4-way bridge. Mission Planner explicitly displaced for these two flows. See PLAN.md decisions rows 6, 6a–6c and Phases 5–6.
- 2026-05-15: Modernized stack — TypeScript end-to-end, **Bun** as package manager + runtime, **Biome** replacing ESLint + Prettier, **dropped i18next and Storybook** from v1 scope, **dropped Babel/polyfills/CommonJS** (pure ESM, evergreen Chromium target). Added v1 dependency budget. See PLAN.md decisions rows 2, 11–17.
- 2026-05-15: Initial plan, architecture, bringup, and security docs created. Tech stack and scope decisions locked. Same family as betaflight-configurator with MAVLink replacing MSP.

## Open questions

- Param metadata schema — consume `apm.pdef.xml` from a smallfastdrone build, or derive at runtime from MAVLink? Lean: build-time XML import.
- node-mavlink browser bundle size after dialect generation. Spike in Phase 0.
- WebSerial UX for USB permission re-prompt across sessions — document for operators.
- WebUSB device-claim handoff when the FC switches between CDC-ACM (MAVLink) and DFU enumerations.
- Wizard state machine: hand-rolled vs XState. Decide at Phase 2 close.
- ESC firmware blob source — bundled, fetched on demand, or operator-supplied? Decide at Phase 6 entry.

## Blockers

None.
