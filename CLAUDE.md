# CLAUDE.md

Guidance for Claude Code when working in `smallfastdrone-config`.

## What this is

`smallfastdrone-config` is a browser-based configuration tool for **SmallFastDrone**, an ArduPilot fork at `../smallfastdrone/`. The mission:

> Get a new drone configured and flying well in the shortest possible time, with the lowest possible risk.

A secondary, longer-term objective is a secured environment for signed firmware uploads, encrypted log management, and encrypted Lua scripts (with future remote key exchange). v1 of this tool ships the **seam**, not the implementation.

## Audience

**This tool is for operators, not experts.** Someone with no knowledge of MAVLink, parameter names, PIDs, filter design, or coordinate frames should still get a SmallFastDrone configured and flying well by following a visual, opinionated workflow.

See [docs/UX.md](docs/UX.md) for the full operator-first design playbook. Practical implications when implementing anything user-facing:

- **Recipes hide parameters.** Operators choose named outcomes ("Indoor cinewhoop"); the tool picks the params.
- **Visuals are utility.** 3D drone model, motor highlighting, animated cal illustrations, live spectrum — not decoration. Each visual exists to make a decision easier.
- **Expert mode is a deliberate toggle**, off by default, per-session. Param browser, raw MAVLink, manual protocol switching, raw 4-way ESC settings, operator-supplied firmware DFU all live behind it.
- **Microcopy contains zero parameter names or MAVLink terms.** Internally `ATC_RAT_PIT_P`; in the UI "Pitch responsiveness".
- **Sophisticated capability ≠ sophisticated UI.** Future advanced tuning still must be simple to configure.

When implementing UI, ask: *would a non-expert operator understand this and feel confident?* If not, find a way to show it instead of telling it.

## How we work

- **Bias for working code.** Every step ships something runnable and reviewable. Don't build three layers of scaffolding before there's anything to demo. Prefer a minimal end-to-end vertical slice that works over a complete horizontal layer that doesn't run yet.
- **The plan is provisional.** [PLAN.md](PLAN.md) is the current best guess, not a contract. Decision rows can flip, phases can split/merge/reorder, scope can shift as the operator discovers what they actually want. When that happens, update PLAN.md + PROGRESS.md — don't quietly diverge from the plan, and don't refuse to change it.
- **Small reviewable steps.** Break work into commits that are independently runnable, testable, and reviewable. If a step needs three commits before anything works, the step is too big.
- **Phases are destinations, not commits.** A phase in PLAN.md lists what's true at its conclusion. The work to get there lands as a sequence of small slices, each one green before the next starts.
- **Demonstrate, then iterate.** Land the minimum that demonstrates a capability; let the operator react to it before polishing. Polishing something the operator hasn't seen often turns out to be polishing the wrong thing.
- **Feedback flows into the playbooks.** When the operator gives substantive guidance — a new requirement, scope change, working principle, correction to a prior decision — that guidance lands in the relevant playbook (`CLAUDE.md`, `PLAN.md`, `PROGRESS.md`, or `docs/*`) in the same change. Don't apply guidance in-the-moment and let it evaporate. The playbooks should always reflect current intent, so a future reader (operator or Claude) sees the live model, not a stale snapshot. If a piece of guidance contradicts a prior decision row, revise the row in place — don't bolt the new intent on top of the old.

## Read first

- [PLAN.md](PLAN.md) — phase plan, decisions log, scope.
- [PROGRESS.md](PROGRESS.md) — current state of the build. Update when you finish a milestone or change scope.
- [docs/UX.md](docs/UX.md) — operator-first design principles, visual language, microcopy rules, expert mode, anti-patterns. **Read before touching any UI.**
- [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md) — adopted Vue / TS / formatter standards. **Read before writing any code.** Lists the "AI slop" patterns to avoid.
- [docs/TESTING.md](docs/TESTING.md) — test pyramid, SFD submodule + SITL, bridge, per-phase test acceptance. **Read before writing tests or new protocol/workflow code.**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layered design, module layout, data model.
- [docs/BRINGUP.md](docs/BRINGUP.md) — wizard phase contract and recipe library design.
- [docs/SECURITY.md](docs/SECURITY.md) — security seam, threat model, what contributors must not do.

## Tech stack — locked

Modern stack, no legacy. Same family as `../betaflight-configurator/` minus its baggage. Deviations require a PLAN.md decision.

- **Vue 3.5+** with `<script setup lang="ts">` + **Vite 7** + **Tailwind 4** + **Nuxt UI 4**
- **TypeScript** end-to-end — no `.js` files in `src/`
- **Bun** as package manager and runtime
- **Pinia** for state (Setup Stores style)
- **vue-router 4** for navigation
- **`@vueuse/core`** for composition utilities (`useRafFn`, debounce, `useElementSize`, etc.)
- **`@tresjs/core` + `@tresjs/cientos`** for 3D drone visualization (Vue-native three.js)
- **node-mavlink** (TS) for the MAVLink protocol — primary
- **MSP** + **BLHeli 4-way interface** — own implementations, minimal MSP scope (just what BLHeli passthrough needs)
- **DFU** — own STM32 DFU class implementation, ref betaflight-configurator
- **WebSerial API** for CDC-ACM transport (MAVLink, MSP, 4-way)
- **WebUSB API** for DFU transport
- **Vitest** for unit + integration tests
- **Playwright** for E2E tests
- **SFD as a git submodule** at `vendor/smallfastdrone/`, built into SITL for integration + E2E targets
- **`@antfu/eslint-config`** for lint + format (single ESLint flat config, includes Vue Style Guide rules, TS rules, and built-in `@stylistic` formatter — no Prettier)
- **vite-plugin-mkcert** for local HTTPS dev (WebAuthn-ready)
- **vite-plugin-pwa** for service worker / installable shell
- **Web Crypto API** if/when any crypto is needed (don't import shims)

**Not in v1, by decision** (see PLAN.md decisions log): i18next/vue-i18n, Storybook, ESLint, Prettier, Babel, CommonJS, polyfills, lodash/date-fns/three/d3/OpenLayers/etc.

**Do not** introduce other frontend frameworks, alternative MAVLink libraries, alternative state stores, alternative bundlers/test runners/linters, or a backend service without an explicit PLAN.md decision. Adding a runtime dep requires a PLAN.md row — see the "v1 dependency budget" section there.

## Sibling repos (read-only context)

| Path | Purpose |
|---|---|
| `../smallfastdrone/` | The ArduPilot fork this tool configures. Source of MAVLink XML, build options, param defs, vehicle CLAUDE.md files. **Also vendored** as a git submodule at `vendor/smallfastdrone/` for SITL-based testing — see [docs/TESTING.md](docs/TESTING.md). |
| `../ardupilot-beta/` | Upstream beta; useful for diffing what's SFD-specific vs upstream behaviour. |
| `../betaflight-configurator/` | Reference implementation. Same shell, different protocol (MSP). When stuck on Vue/Vite/Pinia/Tauri patterns, look here. |
| `../analysis-private/` | Log analysis sibling. Future log-handoff target after Phase 4. |
| `../smallfastdrone/libraries/AP_BLHeli/` | Authoritative reference for the FC-side MSP + BLHeli 4-way bridge. Read `AP_BLHeli.{h,cpp}` and `blheli_4way_protocol.h` before touching `protocol/msp.ts` or `protocol/fourway.ts`. |
| `../betaflight-configurator/src/js/protocols/` | Reference implementations for DFU, MSP, and 4-way protocol stacks. We're not vendoring this code, but the wire format is the same — read it when implementing ours. |
| `../betaflight-configurator/src/js/` + `images/` | Reference for visual / UX patterns: 3D drone usage, motor maps, RC stick visualization, ESC tooling layouts. Same audience as ours, similar polish target. |

## Coding rules

- **Modern only.** No legacy support, no polyfills, no Babel, no CommonJS. Pure ESM. Target evergreen Chromium (WebSerial is Chromium-only anyway). Top-level await, native fetch, Web Crypto, `crypto.randomUUID()`, structured clone — all assumed available.
- **TypeScript everywhere in `src/`.** No `.js` files. Strict mode on.
- **Follow [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md) literally.** Vue.js official Style Guide (Priority A+B) + `@antfu/eslint-config` is authoritative. The "AI slop" section enumerates patterns that look idiomatic-in-general but conflict with our standards — don't produce them.
- **Surgical changes.** Limit diffs to the scope of the task. No drive-by refactors.
- **Defer to PLAN.md.** When in doubt about scope or stack, check the decisions log before improvising.
- **Tight dependency budget.** New runtime deps require a PLAN.md row. Reach for the standard library first (`Array`, `Map`, `Set`, `structuredClone`, `Intl`, `crypto.subtle`) before adding `lodash`/`date-fns`/etc.
- **No backend in v1.** PWA is self-contained. Anything that smells like "we need a server" is out of scope unless PLAN.md says otherwise.
- **Single-drone session.** No data structures or UI flows that imply fleet state.
- **Live FC is truth.** Profiles/exports are deliberate user actions, not background sync.
- **Layered dependencies flow downward only.** UI → workflow → stores → protocol → transport. Never upward, never sideways across siblings.
- **Operator-first copy.** No parameter names, no MAVLink message names, no acronyms in user-facing strings. "Pitch responsiveness" not `ATC_RAT_PIT_P`. "Loading drone settings…" not "Fetching PARAM_VALUE stream". See [docs/UX.md](docs/UX.md) microcopy guidelines.
- **Every wizard step needs a visual.** No bare text-only wizard steps. SVG illustration, Tres.js 3D, animation, or live data — pick one. If you can't think of a visual, the step probably needs rethinking.
- **Expert mode is opt-in.** Anything power-user (param table, raw protocol, manual mode switch, operator-supplied firmware) lives behind the expert toggle. Default UX shows none of it.
- **Treat the security seam as load-bearing.** Even though crypto isn't implemented in v1, all artifact uploads route through `src/security/uploader.ts`. **DFU firmware flashing is the primary v1 use case** for this seam. Don't add direct upload paths.
- **Protocol mode switching is explicit.** When the same port carries multiple protocols (MAVLink → MSP → 4-way → MAVLink for BLHeli passthrough), state transitions are explicit and reversible. There is always a guaranteed exit path back to the starting protocol, even on error.
- **MSP scope is minimal.** We support exactly what BLHeli passthrough needs — not a general MSP client. If you want to add an MSP feature unrelated to BLHeli, propose a PLAN.md decision first.
- **No mocked MAVLink in production code.** Use SITL when testing against an actual link. Param fixtures are fine in unit tests.
- **Every protocol-layer change needs an integration test against SITL.** Every new wizard phase needs an E2E test that drives it end-to-end against SITL. Pick the lowest test layer that genuinely validates the thing (see [docs/TESTING.md](docs/TESTING.md)).
- **Production code never imports test transports.** `WebSocketTransport` and `TcpTransport` live in test paths; production imports `WebSerialTransport` / `WebUSBTransport` only.

## File / commit conventions

- Commit prefixes by area: `wizard:`, `recipe:`, `mavlink:`, `msp:`, `dfu:`, `fourway:`, `params:`, `ui:`, `transport:`, `security:`, `docs:`, `deps:`. Match betaflight-configurator commit style where unclear.
- One concern per commit.
- Update `PROGRESS.md` when you complete a milestone or change scope.
- Do **not** list Claude as author or co-author — author lines are human only. (Same rule as `../smallfastdrone/CLAUDE.md`.)

## When asked to do work

1. Read [PLAN.md](PLAN.md) for the current phase and acceptance criteria.
2. Read the relevant doc in `docs/` for the area you're touching.
3. If the task is in scope and the design is clear: do it.
4. If the task is in scope but the design has a gap: update the relevant `docs/` doc, then implement.
5. If the task is out of scope: surface it, propose adding it to PLAN.md, do not quietly expand scope.

## Available commands

To be filled in as Phase 0 lands. Anticipated:

- `bun install` — install deps
- `git submodule update --init --recursive` — pull SFD submodule (first checkout)
- `bun dev` — Vite dev server (HTTPS via mkcert)
- `bun run build` — production build
- `bun run lint` — ESLint (antfu config) — lint + format check
- `bun run lint:fix` — auto-fix
- `bun run typecheck` — vue-tsc
- `bun run sitl:build` — build SITL from `vendor/smallfastdrone/`
- `bun run sitl:start` — start SITL listening on TCP 5760
- `bun run sitl:stop` — stop SITL
- `bun run test` — unit + integration
- `bun run test:unit` — Vitest unit only, watch mode
- `bun run test:integration` — Vitest integration (requires SITL built)
- `bun run test:e2e` — Playwright (auto-starts bridge + SITL)
- `bun run test:e2e:headed` — E2E with visible browser
- `bun run test:hil` — hardware-in-the-loop (skipped in CI)

## Out of scope (don't drift here)

- Mission planning, geofence editing
- Flight control / RC stick passthrough
- Video / OSD configuration
- Multi-drone / fleet management
- Mobile (Android / iOS)
- Cloud sync / accounts
- Alternative protocols (MSP, DJI, etc.)
- Re-implementing crypto that lives in the smallfastdrone firmware PR or the existing Python encrypter
