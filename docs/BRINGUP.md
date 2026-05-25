# Bringup Workflow Design

> Read [PLAN.md](../PLAN.md), [WIZARDS.md](WIZARDS.md), and [ARCHITECTURE.md](ARCHITECTURE.md) first.

The bringup workflow is the **primary value of this tool**. It walks an operator from "I have a powered, unconfigured flight controller" to "this drone is tuned and safe to fly," in the shortest reasonable time, with the lowest reasonable risk.

Bringup is implemented as a **meta-wizard** in the wizard runtime — see [WIZARDS.md](WIZARDS.md) for the contract. Each phase below is an independently-runnable **sub-wizard** in the library. Operators can run the full meta-wizard for first bringup, or jump straight to any sub-wizard for targeted re-tuning. Recipes are wizards too (degenerate case — one step, no live state), shown alongside everything else in the same library.

## Wizard phases

Each phase is a sub-wizard (see [WIZARDS.md](WIZARDS.md) for the manifest shape). The bringup meta-wizard chains them in order and gates progression. Phase contract:

- **prerequisites** — what must be true before entering
- **actions** — what the tool does or asks the operator to do
- **verification** — automated checks against telemetry / params
- **gate** — operator confirmation; auto-pass shortcuts when all checks pass
- **visual** — every phase has a hero visual (3D drone, illustration, live data viz). No text-only phases. See [UX.md](UX.md) for the visual language.
- **engines** — `desktop` for config-only phases (Frame, RC, Mode setup); `lua` or `log` for phases that need flight data (First hover, Filters, PIDs). The wizard runtime picks the engine per FC capability — see [WIZARDS.md](WIZARDS.md).

| # | Phase | Owns | Gate | Hero visual |
|---|---|---|---|---|
| 00 | **Pre-flight** | Connect, identify FC, read firmware version, confirm SFD build; **optionally** DFU-flash a current SFD firmware image if the operator chose "fresh install" (Phase 5 capability) | Auto: heartbeat + correct build string | Animated USB icon during scan; rotating 3D drone once connected |
| 01 | **Frame** | Frame class/type, motor count, prop direction | Operator confirms frame against UI render | 3D drone in frame-class variant; operator can rotate to compare with their actual drone |
| 02 | **Sensors** | Accel cal, compass cal, baro check | Auto: cal status flags clear | 3D drone with animated tilt arrows showing the next required orientation |
| 03 | **RC** | RC protocol, channel mapping, throttle/yaw/pitch/roll trim, RC failsafe | Operator stick-test pass | SVG sticks animating live with operator's transmitter input |
| 04 | **Motors / ESCs** ("Set up motors" wizard) | ESC output protocol + bidirectional DShot + DShot rate (opinionated default DShot600 + bidir on), **then** motor order + direction, **then** ESC throttle calibration for analog ESCs; **optionally** flash BLHeli ESC firmware via 4-way passthrough (Phase 6 capability) | Operator visual motor-test pass — **props off** | 3D drone top-down with active motor highlighted + prop-direction arrows |
| 05 | **First-hover prep** | Battery / RC / GCS / EKF failsafes, arming checks, max angle/throttle | Auto: arming check passes | SVG illustration of failsafe tree with each branch lighting up green as configured |
| 06 | **First hover** | Operator hovers; tool collects 30–60 s stable hover log | Operator confirms stable hover | Live vibration sparkline + altitude trace + link-quality indicator |
| 07 | **Filters** | Notch filter from hover-log gyro spectrum, harmonic notch config | Auto: post-tune log shows clean spectrum | Live gyro spectrum plot showing peak detection and notch placement preview |
| 08 | **PIDs** | AutoTune orchestration **or** initial seed from frame template | Operator AutoTune pass | 3D drone executing AutoTune motions with progress per axis |
| 09 | **Mode setup** | Configure flight modes the operator wants — including SFD-specific (throw, acro tweaks) | Operator confirm per-mode | Per-mode brief animation showing what each mode "feels like" |
| 10 | **Verify** | Final audit: failsafes wired, RTL alt sane, geofence (if requested), throw config sanity | Operator review checklist | Checklist with per-item green-check / illustration; final celebratory drone fly-by |

Phases are advisory; an experienced operator can skip ahead but the gate must be acknowledged ("I've done this elsewhere") rather than silently bypassed.

### Phase 04 detail — the "Set up motors" wizard

Motors and ESCs are one operator task, so phase 04 is a single multi-phase wizard (grown from the original motor-check), in **dependency order**:

1. **ESC setup** — output protocol + telemetry. Opinionated SFD default: **DShot600 + bidirectional DShot** (RPM telemetry, which later feeds the phase-07 harmonic notch). Owns `MOT_PWM_TYPE`, `SERVO_DSHOT_RATE`, `SERVO_BLH_BDMASK` (+`SERVO_BLH_POLES`). Reboot-required.
2. **Motor order + direction** — spin each motor, operator identifies position + spin; the planner fixes order (`FRAME_TYPE` / `SERVOn_FUNCTION`) and direction (`SERVO_BLH_RVMASK`).
3. **ESC throttle calibration** — only for analog (PWM/OneShot) ESCs; skipped on DShot. Interactive (spins motors at max) so it gets its own props-off safety gate.

ESC setup comes **first** because the direction auto-fix (`SERVO_BLH_RVMASK`) only works on DShot ESCs — choosing the protocol up front makes the fix reliably available rather than silently absent. The in-field CRSF version covers only the order/direction check (ESC config isn't a radio-menu task). ESC *firmware* (BLHeli) settings are deferred to Phase 6 (4-way passthrough).

### Phase contract

Phases are sub-wizards; the contract lives in [WIZARDS.md](WIZARDS.md). The bringup meta-wizard adds only sequencing + gating on top — walk sub-wizards in order, block on a sub-wizard's failed `verify`, persist progress to IndexedDB. Each sub-wizard is also independently runnable from the library.

## Recipe library

Recipes are **wizards** with one step, no live state, `engines: [desktop]`. They ship data-first as `recipe.json` at `src/wizards/recipes/<id>/`, and the wizard runtime wraps each into a generated manifest. They appear in the same library as everything else — the operator sees an "indoor cinewhoop" card next to a "frame selection" card without needing to know one is a recipe and the other is a multi-step wizard.

Lift a recipe to TS code (manifest + DesktopView) only when it needs branching, computation, or a non-trivial visual.

### Initial recipes (SFD-flavoured)

Each recipe is presented to the operator as an **illustrated card with an outcome name**, not a list of parameters. The card shows: hero illustration, plain-language description ("Tighter response and gentler hover for indoor flying"), prerequisites, and a "what will change" summary in operator language. The actual param diff is visible only in expert mode.

| Recipe | Outcome label | What it does (internal) | Notes |
|---|---|---|---|
| `indoor-cinewhoop-tune` | "Indoor cinewhoop" | Filter + PID adjustments for indoor ducted quads | References `../smallfastdrone/` indoor-copter playbook |
| `throw-mode-setup` | "Throw-launch this drone" | `THROW_TYPE`, `THROW_NEXTMODE`, `THROW_MOT_START`, `THROW_ALT_MIN` | Includes `THROW_NEXTMODE=ACRO` (smallfastdrone commit `5534d1f62b`) and `THROW_SRC_INI` audit for carrier-mounted vehicles |
| `first-flight-failsafes` | "Set safe defaults for first flight" | Battery FS, RC FS, GCS FS, EKF FS — sensible SFD defaults | Conservative; assumes small fast drone |
| `notch-from-log` | "Smooth out vibration from a recent flight" | Operator points to hover .bin; tool computes peak Hz; writes `INS_HNTCH_*` | Only recipe in v1 that consumes a log |

### Recipe contract

```ts
interface Recipe {
  id: string
  title: string
  description: string
  prerequisites: string[] // human-readable, e.g. "drone is hovering", "frame_class is COPTER"
  steps: RecipeStep[]
}

type RecipeStep
  = | { type: 'set', param: string, value: number, reason?: string }
    | { type: 'verify', param: string, matches: string } // expression evaluated against current value
    | { type: 'prompt', message: string }
    | { type: 'wait_for', condition: 'armed' | 'disarmed' | 'hovering', timeout_s: number }
```

Recipes never bypass the param store's dirty/write tracking — every change is auditable, reversible, and committed in a single confirmed batch. **Dry-run before commit** is mandatory; the UI must show before/after diff.

## Operator safety rules (must hold across wizard and recipes)

1. **Props-off mode is default during bringup.** UI states this explicitly. Phases that require power are explicitly flagged.
2. **No write without read.** Always read the current value before writing; show before/after on confirm.
3. **Batch + commit, don't drip.** Stage param changes in the dirty set; present a single confirm-and-write.
4. **Persist before reboot.** Always save params to flash before any operation that triggers reboot.
5. **Gates are auditable.** Why did the operator advance? Logged in wizard state.

## SFD-specific bringup considerations

This tool is for SmallFastDrone, not vanilla ArduPilot. Defaults and recipes assume:

- **Small frame class** (sub-300 mm typical), high power-to-weight.
- **Indoor / confined-space flight** is common — tighter PIDs, conservative climb rates, careful failsafes.
- **Throw-mode launching** is a primary use case; bringup must produce a throw-ready config.
- **Carrier-mounted GPS-poor takeoffs** require `THROW_SRC_INI` handling rather than a blanket "drop SRC_INI" suggestion.

When a recipe or phase has SFD-specific reasoning, link to the relevant doc in `../smallfastdrone/` (e.g. `ArduCopter/CLAUDE.md` indoor playbook) in the recipe description, so the operator can audit the rationale.
