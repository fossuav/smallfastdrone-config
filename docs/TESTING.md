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

### SITL launch gotcha — keep a parent alive

SITL's `_fdm_input_step` self-terminates if it sees its parent process is `init` (orphan PID 1). A naïve `arducopter ... &` from a script will work until a client connects, then SITL silently dies as the parent script exits. `setsid` / `nohup` style detachment makes it *worse*, not better.

The fix (copied verbatim from `vendor/smallfastdrone/Tools/autotest/run_in_terminal_window.sh`): wrap SITL in an intermediate subshell that waits on it.

```bash
( : ; "$BIN" --model + --speedup 1 --defaults "$DEFAULTS" </dev/null >sitl.log 2>&1 ) &
```

The leading `:` (true) is load-bearing — without it bash optimises away the subshell and we're back to orphan. `scripts/sitl-start.sh` uses this; any new SITL launcher (CI script, alternate harness) must too.

## Lua wizards in SITL

Lua-engine wizards **are** testable end-to-end against SITL. The Field tools catalogue E2E (`test/e2e/wizard-motor-check.spec.ts` → "Field tools installs Motor check on the radio…") drives the full Lua flow against a real SITL — turn scripting on (write `SCR_ENABLE=1` + reboot + auto-reconnect), FTP the applet + its shared module to `APM/scripts`, restart scripting to rescan, verify the applet is on the FC. (An earlier note here claimed end-to-end Lua testing was impossible due to `SCR_ENABLE`'s `AP_PARAM_FLAG_ENABLE` "landing too late"; that was a misdiagnosis. Scripting initialises fine after `SCR_ENABLE=1`, whether set via the boot defaults *or* via `PARAM_SET` + reboot.)

The first end-to-end Lua-engine wizard was `imu-noise` (a vibration-check demo that exercised the transient upload → arm → run → remove pattern). It's been retired — operator-useful only as a Lua-engine proof, which the motor-check field path now covers. The install-and-keep pattern (used by field tools) is the path that ships; the transient pattern's plumbing remains in `src/workflow/lua-engine.ts` ready for a future wizard that genuinely needs it.

The thing that actually blocked it was a **path mismatch unique to SITL**:

- On hardware, the scripting directory and the MAVLink-FTP root agree: both see `/APM/scripts`.
- On SITL (posix), `SCRIPTING_DIRECTORY` is `./scripts` (see `vendor/.../AP_Scripting/lua_common_defs.h`), but an FTP upload to `APM/scripts/` lands at `<workdir>/APM/scripts` — a *different* directory. The scripting engine never sees the uploaded file.

`scripts/sitl-start.sh` fixes this by symlinking `./scripts -> APM/scripts` in the work dir, so an FTP upload to the hardware-correct `APM/scripts/` path lands exactly where SITL scripting scans. The wizard's upload path is unchanged and stays correct for real hardware.

Two facts about how applets load drive the wizard lifecycle (and the test):

1. **Scripts load once, at scripting-engine start** (`lua_scripts.cpp`: `load_all_scripts_in_dir` runs before the run loop). A file FTP'd in at runtime is *not* auto-detected.
2. **`MAV_CMD_SCRIPTING` with `param1 = SCRIPTING_CMD_STOP_AND_RESTART` rescans without a reboot.** The scripting thread tears down and recreates its Lua state, re-reading the directory. So the wizard install path is **upload (FTP) → restart scripting → wait for the applet's control param** — no full FC reboot. See `src/workflow/lua-engine.ts`.

The **only** reboot in the Lua flow is the one-time **enable** of `SCR_ENABLE` when it's off — which the drone-settings page owns (write → reboot → auto-reconnect). Wizards treat scripting-on as a precondition and point the operator at Drone settings if it isn't.

The "scripting isn't enabled" fallback path is covered inside the Field tools catalogue (the page renders a "Turn on scripting" affordance when `SCR_ENABLE=0`; the field-install spec exercises both branches via its `if (turnOn.isVisible())` guard). Because the shared SITL instance carries scripting state across specs, the field-install spec tolerates scripting being already on.

## BLHeli params in SITL

Stock SITL doesn't compile AP_BLHeli (`HAVE_AP_BLHELI_SUPPORT = HAL_SUPPORT_RCOUT_SERIAL`, 0 for the sim), so the `SERVO_BLH_*` parameters — including `SERVO_BLH_RVMASK`, which the motor-check wizard uses to reverse a motor's spin direction — don't exist there. The motor-check direction-reverse fix therefore can't be exercised on stock SITL.

The SFD fork turns it on: the `SmallFastDrone-4.7-config` branch (which `vendor/smallfastdrone/` tracks) defines `HAL_SUPPORT_RCOUT_SERIAL` and `HAL_WITH_BIDIR_DSHOT` for SITL and makes AP_BLHeli compile off-hardware (guarding `UDID_START`, fixing a non-portable `%08lx`). Build SITL from the pinned submodule and `SERVO_BLH_RVMASK` / `SERVO_BLH_BDMASK` appear, so CI and fresh clones get them too. (`.gitmodules` `branch` still names the beta line — only the `--remote` hint; see TODO.md.)

Tests are written to tolerate both: the motor-check direction spec (`wizard-motor-check.spec.ts`) asserts *either* the software-reverse fix is offered (BLHeli build) *or* the manual-fix guidance is shown (stock). Props-out correction is a plain `FRAME_TYPE` change needing no reverse mask, so that path is testable on stock SITL.

## SFD identity in SITL — it isn't

`SECURE_COMMAND` handling is compiled only into signed firmware builds (`GCS_Common.cpp` dispatches it under `#if AP_SIGNED_FIRMWARE`), and `AP_CheckFirmware::find_public_keys()` returns null off ChibiOS anyway, so SITL never answers the SFD identity operations — a `GENERATE_IDENTITY` sent to SITL simply times out, which is also what a non-SFD drone looks like. The identity path is therefore tested at two layers only: **unit** (`secure-command.spec.ts`, `drone-identity.spec.ts`, `sfd-enable.spec.ts` against fakes) and **bench** on a Lucid H7 running a signed bootloader + signed SmallFastDronev1 build, with `Tools/scripts/signing/sfd_identity.py` in the firmware repo as the reference client. Don't write a SITL integration or E2E test for it; it can't pass.

## Bench testing — a real board

SITL answers most questions. Three it cannot answer at all:

- **How long a real link actually takes.** A full parameter download over USB CDC, an FTP chunk sequence at real serial timing.
- **What a reboot does.** A real board's USB device disappears and comes back as a different device. Every reboot-then-reconnect flow in the app — settings toggles, frame changes, firmware flash — depends on tolerating that gap. SITL never re-enumerates.
- **Whether our bundled parameter metadata matches the firmware in front of the operator.** SITL runs the tree we generated the metadata from, so it agrees with itself by construction.

`test/bench/` answers those against a board on the desk:

| Piece | What it is |
|---|---|
| `com-pipe.py` | Owns the serial port and pipes it to stdio. Bytes on stdout/stdin, line-oriented status on stderr. Reopens the port by itself after it drops. |
| `serial-link.ts` | Spawns the helper and presents it as bytes-in / bytes-out, with `onOpen` / `onClose` / `nextOpen` so a caller can watch a reboot happen. |
| `serial-bridge.ts` | The real-hardware twin of `test/sitl/bridge.ts`. Same `ws://localhost:5761` contract, so the app and the Playwright suite reach a board with the transport they already have. |
| `bench-check.ts` | Standalone protocol checks — identify, param download, metadata coverage, FTP, param write + persist, reboot. |

```
bun run bench:check              # all checks
bun run bench:check ftp reboot   # named checks only
bun run bench:bridge             # serve the board to the app on ws://localhost:5761
BENCH=1 bun run test:e2e         # run the E2E suite against the board, not SITL
```

**Why Windows Python on WSL.** The helper runs under `python.exe`, not the WSL interpreter, and this is not incidental. Attaching the board to Linux with `usbipd` works right up until the board reboots: it re-enumerates, usbipd silently drops the WSL attachment, and the character device never returns — so the one check that most needs real hardware is the one that path cannot run. Windows keeps the COM number stable across a reboot. On a native-Linux bench, set `BENCH_PYTHON=python3` and the same helper drives `/dev/ttyACM0` through pyserial unchanged.

**A bench board is not a drone.** `bench-check` reports `SKIP`, not `PASS`, for anything the board in front of it structurally cannot answer — no microSD means no writable filesystem, so no FTP write and no Lua wizard; no ESCs means no motor check. A skip is a bench condition, never a defect, and it must never read as a pass. The same applies to `BENCH=1 bun run test:e2e`: specs needing a configured frame, ESCs or storage are SITL-only, and a bare board failing them says nothing about the code.

**Nothing here arms anything.** Every check is read-only except the parameter write (one benign parameter, restored afterwards) and the reboot (of a disarmed board). Motor tests stay in SITL and in the props-off bringup wizard, where the operator is present.

### What `BENCH=1` can and can't run

Most E2E specs are written against SITL's *fixture*, not just against a vehicle — SITL's quad X frame, its GPS on SERIAL3, its SmallFastDrone banner. Those assertions are correct and worth keeping; they simply don't describe another board. As of 2026-09-04, on a bare TBS_LUCID_H7 with no card and no ESCs, 14 specs pass and these do not:

| Spec | Why |
|---|---|
| `connect.spec.ts` | Asserts SITL's "Quadcopter" and the "SmallFastDrone" banner. A board on a different frame or upstream firmware is a different, correct answer. |
| `wizard.spec.ts` (connections ×2) | Asserts SERIAL3 reads "GPS" — SITL's wiring. The real board reported DJI OSD on SERIAL3, which the table rendered correctly. |
| `wizard-motor-check.spec.ts` (×5, incl. ESC setup) | Needs a configured frame and ESCs. |

**Specs are not idempotent against real hardware.** SITL is rebuilt per run, so a spec can write freely; a board keeps every write. A full `BENCH=1` run leaves `FRAME_CLASS`, `FRAME_TYPE`, `SCR_ENABLE`, `SERIAL1_*` and `RTL_ALT*` changed, and re-running some specs then fails on their own leftovers — `settings-scripting` needs `SCR_ENABLE` to start at 0 and leaves it at 1, so it passes once and then can't. Until a bench fixture snapshots and restores around the run (TODO.md), **put the board back yourself afterwards** — `param.pck` carries the firmware's own defaults, so restoring is mechanical rather than guesswork.

**A bench failure is a hypothesis, not a verdict.** Check whether the board can answer the question at all before treating a red spec as a defect — and equally, don't dismiss one: the scripting spec's failure here turned out to be a real bug in the post-reboot reload (TODO.md), which SITL had been hiding.

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

`test/hil/` mirrors the `test/integration/` layout but exercises the real WebSerial / WebUSB paths. It doesn't exist yet — what exists today is `test/bench/` above, which drives a real board from Bun and from the Playwright suite. The gap `test/hil/` still has to close is the **production transport itself**: `BENCH=1` exercises the app's stores, workflows and views against real hardware, but reaches it over `WebSocketTransport`, so `WebSerialTransport` and `WebUSBTransport` remain covered only by a human in Chrome.

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
