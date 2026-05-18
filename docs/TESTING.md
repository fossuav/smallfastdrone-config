# Testing Strategy

> Read [PLAN.md](../PLAN.md) for mission/phases and [ARCHITECTURE.md](ARCHITECTURE.md) for the transport layer this strategy depends on.

The whole point of automated tests is **catching regressions in the operator's experience**. A green test suite should mean: a non-expert operator can still complete a bringup against a fresh SFD firmware without surprises.

## Test pyramid

```
                     ▲
                    / \
                   /E2E\         Playwright + headless Chromium + SITL
                  /-----\        ~minutes; CI + on-demand locally
                 /       \
                / Integ-  \      Vitest + Bun talking MAVLink to SITL
               /  ration   \     ~seconds; CI + on-demand locally
              /-------------\
             /               \
            /     Unit         \  Vitest, pure logic, no I/O
           /                    \ ~ms; runs on save
          ▼──────────────────────▼
```

| Layer | Location | What it tests | Speed |
|---|---|---|---|
| Unit | `test/unit/` | Pure logic in stores, workflow, recipe runner, param diff, mode-switcher state machine, microcopy lookups | Sub-second |
| Integration | `test/integration/` | Protocol layer against real SITL via TCP MAVLink. No browser. | Seconds per file |
| E2E | `test/e2e/` | Full UI driven by Playwright against SITL via WebSocket bridge | Minutes total |

## SFD as a git submodule

The SFD firmware is included as a git submodule at `vendor/smallfastdrone/`, pinned to a specific commit. Tests build and run SITL from this pinned source.

**Submodule URL:** `https://github.com/fossuav/smallfastdrone.git`

**Why a submodule, not a sibling-dir reference:**

- Reproducible tests — the pinned commit is exactly what CI builds.
- Submodule bumps are deliberate PRs — every SFD version change is reviewed.
- Contributors don't need a separate clone of SFD.
- CI just runs `git submodule update --init --recursive`.

**Update workflow:**

```bash
cd vendor/smallfastdrone
git fetch origin
git checkout <commit-or-tag>
cd ../..
git add vendor/smallfastdrone
git commit -m "vendor: bump SFD to <commit-or-tag>"
```

Submodule bumps trigger the full test suite. If tests fail against a new SFD commit, either fix the tool or document a known-incompatible window in `PROGRESS.md`.

## SITL build

SITL is built once per CI run (cached via `ccache`) and once per local developer setup.

```bash
bun run sitl:build          # configures + builds SITL from vendor/smallfastdrone
bun run sitl:start          # starts a SITL instance, listening on TCP 5760
bun run sitl:stop
```

Build takes ~5–10 min cold, ~30 s with warm `ccache`. CI caches the `vendor/smallfastdrone/build/sitl/` directory keyed on the submodule SHA.

## SITL bridge

SITL exposes MAVLink over TCP. The browser PWA speaks WebSerial in production. For E2E, we use a small bridge:

```
Browser ──WebSocket──▶ Bridge ──TCP──▶ SITL
        (ws://localhost:5761)   (tcp://localhost:5760)
```

The bridge lives at `test/sitl/bridge.ts` — a Bun script with **zero external deps** (Bun built-in WebSocket server + `Bun.connect()` for TCP). Started automatically by Playwright fixtures; can be started manually for ad-hoc debugging.

For integration tests there's no bridge — Bun talks MAVLink directly to SITL's TCP port via `Bun.connect()`.

## Test transport

The transport layer abstraction (`src/transport/types.ts`) is what makes the test setup possible:

| Transport | Where | Use |
|---|---|---|
| `WebSerialTransport` | `src/transport/webserial.ts` | Production — CDC-ACM for MAVLink/MSP/4-way |
| `WebUSBTransport` | `src/transport/webusb.ts` | Production — DFU |
| `WebSocketTransport` | `src/transport/websocket.ts` | E2E — talks to the bridge |
| `TcpTransport` | `test/integration/transport/tcp.ts` | Integration — Node-side, talks MAVLink directly to SITL |

**Production code does not import test transports.** Test transport in the browser is selected via URL param at app load (`?transport=websocket&host=localhost:5761`). The production bundle contains no test code; no conditional compilation.

## What we test, by phase

Each PLAN.md phase has a paired test acceptance criterion. The wizard isn't "done" because the operator can click through it — it's done when an automated test can drive SITL through the same path.

| Phase | Test counterpart |
|---|---|
| 0 — Scaffolding | E2E: PWA loads over HTTPS, WebSocket transport connects to SITL bridge, heartbeat appears, sysid shown. Rotating 3D drone visible. |
| 1 — MAVLink + params | Integration: param fetch returns the full SITL param set; param set + save persists across SITL restart. E2E: param browser (expert mode) shows live SITL params and accepts edits. |
| 2 — Wizard skeleton | E2E: wizard advances through Pre-flight and Frame phases; gate prevents advance when verify fails. Wizard state survives SITL disconnect/reconnect. |
| 3 — Recipes | Integration: each recipe applies cleanly to SITL; dry-run diff matches actual writes; verify steps catch deliberate mismatches. E2E: recipe card → confirm → success state with operator-friendly summary. |
| 4 — Logs | Integration: `LOG_REQUEST_LIST` returns SITL log catalog; `LOG_REQUEST_DATA` download matches the `.bin` written by SITL. |
| 5 — DFU + security seam | Unit: `SignedArtifactUploader` interface contract; **lint rule** fails the build on any direct upload call outside `security/uploader.ts`. E2E: DFU view detects a simulated WebUSB DFU device (SITL itself doesn't do DFU; we mock at the WebUSB layer). |
| 6 — MSP + BLHeli | Integration: protocol mode switcher transitions MAVLink → MSP → MAVLink cleanly; `AP_BLHeli` passthrough enters and exits without stranding the FC. ESC enumeration / real flash tagged `@hil` (hardware-in-the-loop), skipped in CI. |

## Hardware-in-the-loop tests

A subset of tests requires real hardware (real ESC enumeration, real DFU flash on bench FC, real WebSerial USB device). These are tagged `@hil` and **skipped in CI**. Operators / maintainers run them on the bench before tagging a release.

`test/hil/` mirrors the `test/integration/` layout but exercises the real WebSerial / WebUSB paths.

## What goes in which layer

- **Unit:** anything that can be tested with fixtures and no MAVLink. Param diff logic, recipe step compilation, wizard state transitions, microcopy lookups, store mutation logic.
- **Integration:** anything that needs an actual ArduPilot to validate. Param ACK behavior, mode-switcher exit paths, log streaming, MSP-into-BLHeli sequencing, EKF status interpretation.
- **E2E:** anything where the operator experience is the point. Wizard advance, recipe selection, error message presentation, visual feedback during ops, expert-mode toggle behavior.

Pick the **lowest layer that genuinely validates the thing**. Don't write an integration test that could be a unit test; it's slower. Don't write an E2E test that could be an integration test; it's slower still.

## Running tests

```bash
bun run test               # unit + integration (e2e is separate due to runtime)
bun run test:unit          # Vitest, unit only, watch mode by default
bun run test:integration   # Vitest, integration (requires SITL built)
bun run test:e2e           # Playwright (auto-starts SITL + bridge)
bun run test:e2e:headed    # E2E with visible browser, for debugging
bun run test:hil           # hardware-in-the-loop (skipped in CI)
```

Local dev typically runs unit on save and integration / e2e on demand.

## CI shape

Workflow steps:

1. Checkout with `submodules: recursive`.
2. Restore SITL build cache keyed on `vendor/smallfastdrone` SHA.
3. Build SITL on cache miss; warm-cache builds skip this step.
4. `bun install`.
5. `bun run lint` + `bun run typecheck`.
6. `bun run test:unit`.
7. Start SITL + bridge as background services, `bun run test:integration`.
8. `bun run test:e2e` against the same SITL/bridge.

Skipping a layer in CI requires a passing reason logged in the PR description.

## Test writing rules

- **Operator-facing assertions in E2E tests.** Test for "Connected to your drone" not for "MAVLink heartbeat received". The test enforces the microcopy contract from `UX.md`.
- **No mocked MAVLink in integration tests.** The whole point is running against real ArduPilot. If you can't reach SITL, the test is in the wrong layer.
- **Tests must be deterministic.** Wait for explicit state transitions, never sleeps. If something is racy against SITL, fix the production code, not the test.
- **No screenshot baseline diffs in v1.** Visual regression is real work; defer until the UI stabilises.
- **Tests own their fixtures.** Param fixtures in `test/fixtures/params/`, log fixtures in `test/fixtures/logs/`. No shared mutable state between tests.
