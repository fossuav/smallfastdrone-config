# smallfastdrone-config — Implementation Plan

## Mission

**Primary:** Get a new drone configured and flying well in the shortest possible time, with the lowest possible risk.

**Secondary (design only in v1):** Provide a secured environment for uploading signed firmware, encrypted logs, and encrypted Lua scripts. Future objective: certain Lua features are installable only via this tool, requiring authentication by remote keys against a key held by the firmware. v1 must not preclude this; v1 ships the seam, not the implementation.

## Audience

**This tool is for operators, not experts.** The whole point is that someone who doesn't know MAVLink, parameter names, PID theory, or coordinate frames can still get the full benefit of the SFD stack by following a visual, opinionated workflow.

The mission collapses if we ship a "expert tool that operators can use if they read enough." Every UX decision is judged against: *would a non-expert operator understand this and feel confident?*

In time we will introduce sophisticated tuning options. They still must be simple to configure — a sophisticated capability is not a license for a sophisticated UI.

See [docs/UX.md](docs/UX.md) for the operator-first design playbook.

## Non-goals (v1)

- Multi-drone fleet management — single-drone session only.
- Mobile / Android — browser PWA only.
- Mission planning, geofencing, video / OSD — out of scope; use Mission Planner.
- General-purpose Mission Planner / QGC replacement — we cover bringup, tuning, log download, **DFU firmware flashing**, and **BLHeli ESC passthrough** explicitly. Anything else, defer to MP/QGC.
- Implementing the firmware-signing / Lua-encryption pipeline. Firmware-side support exists in the smallfastdrone PR; off-FC encryption exists in a separate Python tool. Neither is consumed in v1, but DFU uploads do route through the security seam.
- Cloud / accounts / remote-key-exchange backend.

## Decisions log

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Frontend stack | Vue 3.5+ + Vite 7 + Tailwind 4 + Nuxt UI 4 + vue-router 5 | Modern Vue + Tailwind 4 (Oxide engine). Same family as `../betaflight-configurator/` minus its legacy baggage. vue-router updated 4 → 5 (current stable as of slice 2 install). |
| 2 | Language | TypeScript end-to-end | No JS in `src/`. Modern toolchain expects TS first-class. |
| 3 | State | Pinia (Setup Stores) | Modern Vue store; composition-API native. |
| 4 | MAVLink lib | `node-mavlink` + `mavlink-mappings` with `vite-plugin-node-polyfills` for browser `Buffer`/`stream` | Ecosystem-standard MAVLink JS/TS stack — typed message classes for every common + ardupilotmega message, streaming v2 packet splitter with CRC validation, serialize for sending. Costs ~30-80 KB gzip in polyfills + the dialect registries. Initially tried mavlink-mappings-only with hand-rolled framing; switched to full node-mavlink for evolution + ecosystem alignment (operator wants typed bindings throughout). |
| 5 | Platform v1 | Browser PWA | Lowest install friction; matches operator workflow on a bench laptop. |
| 6 | Transports v1 | WebSerial (MAVLink, MSP, 4-way) + WebUSB (DFU) | Bench bringup is the dominant flow. WebUSB needed for DFU class flashing. UDP/SITL deferred. |
| 6a | DFU | WebUSB-based STM32 DFU class, our own implementation | Mirrors betaflight-configurator's `dfu.js`. Mission Planner does this poorly; this is a key differentiator. DFU uploads route through the security seam. |
| 6b | MSP | Minimal subset, only what BLHeli passthrough needs | ArduPilot's `AP_BLHeli` exposes MSP on a serial-protocol-MSP port; we need just enough MSP to enter passthrough and tunnel 4-way. Not a general MSP client. |
| 6c | BLHeli 4-way interface | Full read + write (settings + ESC firmware flash) | Match betaflight-configurator capability. Reference: betaflight `fourway.js` and `AP_BLHeli/blheli_4way_protocol.h`. |
| 7 | Source of truth | Live FC | Tool is a viewer/editor. Snapshots are deliberate operator exports, not background sync. |
| 8 | Fleet model | Single-drone session | Matches betaflight-configurator UX; cheapest. |
| 9 | Workflow primitive | Pluggable wizards (recipes subsumed as degenerate wizards) | Single runtime, single contract. Wizards are independent units declared via manifest, bundled at build time, surfaced in a wizard library. Engine choice (Lua-on-FC / log-replay / desktop-pure) is internal — runtime picks per FC capability, operator never picks. Log-replay engine guarantees universal coverage for FCs without scripting. Pluggability enables a commercial gating seam (`locked: true` flag) for paid Pro wizards. Recipes become wizards with `engines: [desktop]`, one step, no live state. Bringup workflow becomes a meta-wizard that chains sub-wizards. See [docs/WIZARDS.md](docs/WIZARDS.md). |
| 10 | Crypto in v1 | Tool-side seam only | Real crypto exists elsewhere. Don't re-implement; don't preclude. Web Crypto API only when needed. |
| 11 | Package manager + runtime | Bun | Fast install, native TS execution, single tool. Vite still does the bundling. |
| 12 | Lint + format | `@antfu/eslint-config` (ESLint flat config + stylistic formatter) | De facto standard in modern Vue/Vite/Nuxt ecosystem. Includes Vue Style Guide rules, TS rules, and a built-in formatter (no Prettier needed). Maintained by a Vue core team member. **Revised from earlier Biome choice** — Biome's Vue SFC support is not first-class in 2026. See [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md). |
| 13 | HTTPS dev | vite-plugin-mkcert | Required for WebSerial in some browsers and WebAuthn later. |
| 14 | PWA shell | vite-plugin-pwa | Service worker + installable shell. |
| 15 | i18n | Deferred until needed | English-only at start. No `t()` scaffolding for zero current benefit. |
| 16 | Component workshop | Not in v1 (no Storybook) | Over-tooling for a small PWA. Revisit only if a real component library emerges. |
| 17 | Browser target | Evergreen Chromium | WebSerial is Chromium-only. No polyfills, no Babel, no CommonJS. Pure ESM. |
| 18 | Audience | Operators, not experts | Drives every UX decision. See [docs/UX.md](docs/UX.md). |
| 19 | Primary surfaces | Wizard + Recipes; param browser is expert-mode-only | Operators choose outcomes, not parameter assignments. Param table is a safety hatch. |
| 20 | Expert mode | Per-session toggle, off by default | Hides param browser, raw MAVLink, manual protocol switch, raw 4-way ESC settings, etc. |
| 21 | 3D visualization | `@tresjs/core` + `@tresjs/cientos` | Vue-3-native three.js wrapper. Hero drone model used across wizard phases, motor test, sensor cal. |
| 22 | Composition utils | `@vueuse/core` | Modern Vue standard for `useRafFn`, debounce, `useElementSize`, etc. Saves rolling our own. |
| 23 | Coding standards (Vue) | **Vue.js official Style Guide**, Priority A + B | The authoritative Vue conventions doc. Adopted to avoid AI-generated drift. See [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md). |
| 24 | Coding standards (TS) | `@antfu/eslint-config` defaults + strict TS | No single canonical TS guide is universally adopted; antfu's TS rules encode current community best practices. |
| 25 | Editor config | `.editorconfig` (editorconfig.org) | Cross-editor consistency for indent / EOL / charset / trailing whitespace. |
| 26 | Test framework (unit + integration) | Vitest | Already chosen for unit; extended to integration tests that talk MAVLink directly to SITL. |
| 27 | Test framework (E2E) | Playwright | De facto modern PWA E2E standard. |
| 28 | SFD inclusion for tests | Git submodule at `vendor/smallfastdrone/` | Reproducible test target. Pinned commit per PR. URL: `https://github.com/fossuav/smallfastdrone.git`. |
| 29 | SITL bridge | In-repo Bun script `test/sitl/bridge.ts` | Zero external deps (Bun built-ins). Bridges browser WebSocket ↔ SITL TCP MAVLink. |
| 30 | Test transport selection | Runtime URL param (`?transport=websocket&host=...`) | No conditional compilation. Production bundle contains no test code. |

When a decision changes, update this row in place and add a note in `PROGRESS.md`.

## v1 dependency budget

Keep this list short. Adding a transitive-heavy lib (lodash, date-fns, three, d3, OpenLayers) requires a PLAN.md decision row.

**Runtime:**
- `vue` (3.5+)
- `vue-router` (5)
- `pinia`
- `@nuxt/ui` (4) + `tailwindcss` (4)
- `@vueuse/core` — composition utilities
- `@tresjs/core` + `@tresjs/cientos` — 3D drone visualization (pulls `three`)
- `node-mavlink` + `mavlink-mappings` — MAVLink v2 parsing, typed message classes, serialize for sending (browser via polyfills, see decision 4)

**Dev:**
- `vite` (7)
- `vite-plugin-mkcert`
- `vite-plugin-pwa`
- `vite-plugin-node-polyfills` — Buffer/stream/etc. shims so node-mavlink runs in the browser
- `vitest`
- `playwright`
- `eslint` + `@antfu/eslint-config`
- `typescript`
- `vue-tsc`
- `@types/bun` (for `test/sitl/bridge.ts` and future Bun CLI scripts)

**External (via git submodule, not npm):**
- `vendor/smallfastdrone/` — SFD firmware, used to build SITL for tests

That's it for the planned v1 surface. New deps land via PR with a one-line justification.

## Phased delivery

**Phases are destinations, not commits.** Each phase below lists what's true at its conclusion. The work to get there lands as a sequence of small, independently runnable, reviewable slices — never a big-bang merge. Each slice ends green and demonstrable before the next starts.

**The plan is provisional.** Phases can split, merge, reorder, or be re-scoped as the operator discovers what's actually needed. Decision rows can flip. When that happens, update this file and `PROGRESS.md` — don't diverge silently and don't treat the plan as a contract.

**Every phase has a paired automated test acceptance criterion** that drives SITL through the same path the operator would. See [docs/TESTING.md](docs/TESTING.md) "What we test, by phase" for the per-phase test contract.

### Phase 0 — Scaffolding (app + test infrastructure)
- Initialise Vue 3.5+ + Vite 7 + Nuxt UI 4 + Tailwind 4 app, TypeScript end-to-end.
- Bun as package manager + runtime.
- Pinia (Setup Stores), vue-router 4, `@vueuse/core`, Vitest, Playwright.
- `eslint` + `@antfu/eslint-config` configured per [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md); `.editorconfig` in repo root.
- `vite-plugin-mkcert` for HTTPS dev; `vite-plugin-pwa` for service-worker / installable shell.
- `@tresjs/core` + `@tresjs/cientos` integrated; placeholder generic drone 3D model rotating on the Connect screen.
- App shell: Connect / Wizard / Recipes / Logs / Firmware / EscTools routes (placeholders).
- Expert-mode toggle in shell (off by default; per-session); reveals a Params route when on.
- Operator-first microcopy in place from day one (no MAVLink jargon in any user-facing string).
- Transport abstraction (`src/transport/types.ts`); `WebSerialTransport` for production; `WebSocketTransport` for E2E (selected via `?transport=websocket&host=...` URL param).
- **SFD submodule** at `vendor/smallfastdrone/` pinned to a current SFD commit.
- **SITL build orchestration** (`bun run sitl:build` / `sitl:start` / `sitl:stop`).
- **SITL bridge** at `test/sitl/bridge.ts` — zero-dep Bun script, WebSocket ↔ TCP MAVLink.
- First E2E test: PWA loads, connects via bridge to SITL, heartbeat appears, "Connected to your drone" shown.

**Done when:** Operator can open the PWA over HTTPS, see a polished Connect screen with the rotating drone, connect to a SITL (or live FC) and see a friendly "Connected to your drone" state. The CI pipeline runs lint, typecheck, unit, integration, and the connect E2E — all green. No param ops yet.

### Phase 1 — MAVLink session + param store
- Integrate node-mavlink against `../smallfastdrone/modules/mavlink/message_definitions/v1.0/ardupilotmega.xml`.
- Param fetch via `PARAM_REQUEST_LIST` → `PARAM_VALUE` stream; param set via `PARAM_SET`; commit via `PREFLIGHT_STORAGE` write.
- Pinia `params` store: keyed by name, dirty-set tracking, write queue with retry, source attribution (fc / user / recipe).
- Param browser UI: search, group, edit, dirty diff, single confirm-and-write.
- Param metadata: import `apm.pdef.xml` from a smallfastdrone build at app build time; fall back to name-suffix unit inference (`_cm`, `_ms`, `_deg`, etc.).

**Done when:** Operator can fetch full param set, edit values, see dirty diff, commit-and-save, then disconnect/reconnect and see the new values.

### Phase 2 — Wizard runtime + first wizards
- Wizard runtime (`src/workflow/wizard-runtime.ts`): manifest discovery, capability detection, engine selection, lifecycle hooks, IndexedDB persistence keyed by `${fc_uuid}_${wizard_id}`.
- Wizard library view (`src/views/WizardLibraryView.vue`): cards driven by manifests, filtered by FC capability, locked-state rendering (`locked: true` → greyed card + Pro badge + `unlock_blurb`, no real entitlement check in v1).
- Engine implementations in scope: **desktop** only (Lua + log engines have their contracts shipped but no first implementation here — see Phase 3 and Phase 4).
- Two real wizards end-to-end:
  - `frame-select` — desktop engine, writes `FRAME_CLASS` + `FRAME_TYPE`, demonstrates the wizard contract.
  - `bringup` — meta-wizard, walks operator through `frame-select` + a placeholder Pre-flight sub-wizard, demonstrates the meta pattern.
- One locked stub wizard in the library so the commercial gating affordance is visible from day one.
- Contract is [docs/WIZARDS.md](docs/WIZARDS.md). Bringup operator-flow detail in [docs/BRINGUP.md](docs/BRINGUP.md).

**Done when:** Operator can open the wizard library, see all wizards (with correct capability + locked badges), run `frame-select` standalone to write frame params, run the `bringup` meta-wizard through its first sub-step, and resume an interrupted wizard after disconnect/reconnect.

### Phase 3 — Recipe-style wizards + first Lua engine
- SFD-flavoured desktop-engine wizards (formerly recipes), data-first as `recipe.json` wrapped in generated manifests:
  - `indoor-cinewhoop-tune`
  - `throw-mode-setup` (incl. `THROW_NEXTMODE=ACRO` per smallfastdrone commit `5534d1f62b`, and `THROW_SRC_INI` audit for carrier-mounted vehicles)
  - `first-flight-failsafes`
- First **Lua-engine** wizard end-to-end: exercises the install / arm / run / uninstall lifecycle in [docs/WIZARDS.md](docs/WIZARDS.md). Candidate: a between-flights `throw-readiness-check` that monitors throw-detect thresholds during a test toss without taking off.
- Lua lifecycle plumbing in the runtime: MAVLink FTP upload of `applet.lua`, `SCR_ENABLE` orchestration (with single operator confirm + reboot if currently off), `WIZ_<ID>_ACTIVE` control param, applet-file removal on completion, orphan detection at reconnect.

**Done when:** Operator can run any of the desktop wizards through to commit, and the Lua-engine wizard runs end-to-end against SITL with scripting enabled — applet uploaded, runs, completes, uninstalls cleanly. SITL log shows no orphan script after completion.

### Phase 4 — Log handling + first log-engine wizard
- Pull .bin via `LOG_REQUEST_LIST` / `LOG_REQUEST_DATA`.
- Save to disk via File System Access API (PWA constraint).
- Hand-off to `../analysis-private/` documented; no in-tool full-log parsing.
- **Narrow in-tool .bin parser** — only the message types declared by log-engine wizards' extractors. Skip everything else for speed. The hook satisfies the `LogExtractor` contract in [docs/WIZARDS.md](docs/WIZARDS.md).
- First **log-engine** wizard end-to-end: `notch-from-hover` (operator points at a hover .bin; extractor computes peak Hz; runtime writes `INS_HNTCH_*` via the param store).
- Log pipeline structured to allow a future `decrypt(bytes) → bytes` step (see SECURITY.md).

**Done when:** Operator can list logs on FC, download one, find it on disk, and run `notch-from-hover` against it to commit a notch-filter config — all without leaving the tool.

### Phase 5 — DFU firmware flashing + security seam
- `src/security/uploader.ts` — `SignedArtifactUploader` interface; v1 implementation is a passthrough that calls the protocol-layer file/upload primitive.
- WebUSB transport: `src/transport/webusb.ts`.
- DFU protocol: `src/protocol/dfu.ts` — STM32 DFU class implementation, mirroring betaflight-configurator's `dfu.js` (DFU descriptors, GET_STATUS / DNLOAD / UPLOAD / GETSTATE / CLRSTATUS, manifest tolerance, ST extensions for sector erase + address pointer).
- Workflow: detect DFU device on USB → parse target memory layout → verify signature via uploader → erase → flash → verify → exit DFU.
- All upload paths (firmware reflash here, Lua install future, mission upload future) routed through the uploader.
- `docs/SECURITY.md` documents the future local-keys and remote-key-exchange flows.
- No actual crypto in v1; uploader is passthrough but the call site is correct.

**Done when:** Operator can put an FC into DFU mode, the tool detects it via WebUSB, presents firmware metadata, and successfully flashes a smallfastdrone firmware image. Repo has zero direct upload calls outside `security/uploader.ts`.

### Phase 6 — MSP + BLHeli passthrough
- `src/protocol/msp.ts` — minimal MSP v1/v2 client; only the commands needed to negotiate BLHeli passthrough entry/exit. Not a general MSP client.
- `src/protocol/fourway.ts` — BLHeli 4-way interface protocol (init, read settings, write settings, ESC firmware flash, exit).
- Workflow:
  - Operator selects "ESC tools" view.
  - Tool checks the connected serial port's role: if MAVLink, send the MAVLink command that triggers `AP_BLHeli` passthrough on that link; if the port is configured as MSP, speak MSP directly.
  - Enter 4-way mode; enumerate ESCs; show per-ESC settings; allow flashing of ESC firmware.
  - Exit 4-way and restore the prior protocol mode cleanly.
- ESC firmware blobs and BLHeli settings descriptors: bundled at build time from a versioned source.

**Done when:** Operator can connect to an SFD-flashed FC, enter BLHeli passthrough, read all ESC settings, change a setting, and flash a BLHeli ESC firmware image — all without leaving the tool.

## Open architectural questions / risks

- **node-mavlink browser bundle size** after dialect generation. Spike during Phase 0; mitigate with chunking if needed. Consider parsing in a Web Worker if it dominates main-thread time.
- **Param metadata source.** `apm.pdef.xml` is generated by ArduPilot's `param_parse.py`; need a build-time pipeline or a checked-in snapshot per smallfastdrone version.
- **WebSerial UX.** Browsers re-prompt for USB permission per origin per session; document for operators.
- **HTTPS-only WebSerial.** Mirror the `local.betaflight.com` + `vite-plugin-mkcert` pattern with our own hostname.
- **Wizard state machine.** Hand-rolled unless we hit visible complexity; revisit at Phase 2 close.
- **MAVLink dialect drift.** Smallfastdrone may add custom messages over time; keep dialect XML as a build-time import, not vendored TS.
- **Bun + Vite plugin compatibility.** Most Vite plugins target Node; spike early to confirm `vite-plugin-mkcert` and `vite-plugin-pwa` work cleanly under Bun. Fallback: pnpm.
- **WebUSB device-claim conflicts.** When the FC enumerates as both CDC-ACM (WebSerial) and DFU (WebUSB) at different times, browser permission state may not transfer. Document the disconnect/reconnect dance.
- **Protocol mode switching on a single port.** When using the MAVLink USB port for BLHeli passthrough, the wire protocol changes mid-session (MAVLink → MSP → 4-way → MAVLink). Need clean state transitions and a guaranteed exit path so a half-finished BLHeli session doesn't strand the FC in passthrough mode.
- **ESC firmware blob source + provenance.** BLHeli firmware images are produced by third parties; bundling means we ship someone else's binary. Decide whether to bundle, fetch on demand, or require operator-provided blob.

## Where to find context

- ArduPilot fork (firmware): `../smallfastdrone/`
- ArduPilot upstream beta: `../ardupilot-beta/`
- Reference UI app: `../betaflight-configurator/`
- Log analysis sibling: `../analysis-private/`
- MAVLink XML: `../smallfastdrone/modules/mavlink/message_definitions/v1.0/ardupilotmega.xml`
- Build options index: `../smallfastdrone/Tools/scripts/build_options.py`
- Smallfastdrone CLAUDE files: `../smallfastdrone/CLAUDE.md`, `../smallfastdrone/ArduPlane/CLAUDE.md`, etc.
- **AP_BLHeli (MSP + 4-way bridge on FC):** `../smallfastdrone/libraries/AP_BLHeli/AP_BLHeli.{h,cpp}`, `blheli_4way_protocol.h`
- **DFU reference impl:** `../betaflight-configurator/src/js/protocols/` (DFU + WebUSB usage)
- **MSP / 4-way reference impls:** `../betaflight-configurator/src/js/` (msp/fourway modules)
