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
| 05 | **First-hover prep** | RC / GCS / EKF failsafes, arming checks, max angle/throttle (the battery's are set where the battery is read — see "Props-on motor measurement") | Auto: arming check passes | SVG illustration of failsafe tree with each branch lighting up green as configured |
| 06 | **First hover** | Operator hovers; tool collects 30–60 s stable hover log | Operator confirms stable hover | Live vibration sparkline + altitude trace + link-quality indicator |
| 07 | **Filters** | Notch filter from hover-log gyro spectrum, harmonic notch config | Auto: post-tune log shows clean spectrum | Live gyro spectrum plot showing peak detection and notch placement preview |
| 08 | **PIDs** | AutoTune orchestration **or** initial seed from frame template | Operator AutoTune pass | 3D drone executing AutoTune motions with progress per axis |
| 09 | **Mode setup** | Configure flight modes the operator wants — including SFD-specific (throw, acro tweaks) | Operator confirm per-mode | Per-mode brief animation showing what each mode "feels like" |
| 10 | **Verify** | Final audit: failsafes wired, RTL alt sane, geofence (if requested), throw config sanity | Operator review checklist | Checklist with per-item green-check / illustration; final celebratory drone fly-by |

Phases are advisory; an experienced operator can skip ahead but the gate must be acknowledged ("I've done this elsewhere") rather than silently bypassed.

**Pre-arm readiness is a phase-05 gate, not a phase-00 one.** The opening Pre-flight phase reports *hardware sanity* — sensors present + healthy, correct firmware — because that's what's knowable and actionable before any configuration. Whether the drone will actually *arm* depends on configuration that hasn't happened yet (frame, RC, failsafes), so the arm checks belong in phase 05 (First-hover prep), prior to first flight. UI surfaces follow this: the bringup ribbon's Pre-flight tab summarises sensor health, not arm-readiness, and arm-readiness shouldn't be presented as an opening-step concern.

### Phase 04 detail — the "Set up motors" wizard

Motors and ESCs are one operator task, so phase 04 is a single multi-phase wizard (grown from the original motor-check), in **dependency order**:

1. **ESC setup** — output protocol + telemetry. Opinionated SFD default: **DShot600 + bidirectional DShot** (RPM telemetry, which later feeds the phase-07 harmonic notch). Owns `MOT_PWM_TYPE`, `SERVO_DSHOT_RATE`, `SERVO_BLH_BDMASK` (+`SERVO_BLH_POLES`). Reboot-required.
2. **Motor order + direction** — spin each motor, operator identifies position + spin; the planner fixes order (`FRAME_TYPE` / `SERVOn_FUNCTION`) and direction (`SERVO_BLH_RVMASK`).
3. **ESC throttle calibration** — only for analog (PWM/OneShot) ESCs; skipped on DShot. Interactive (spins motors at max) so it gets its own props-off safety gate.

ESC setup comes **first** because the direction auto-fix (`SERVO_BLH_RVMASK`) only works on DShot ESCs — choosing the protocol up front makes the fix reliably available rather than silently absent. The in-field CRSF version covers only the order/direction check (ESC config isn't a radio-menu task). ESC *firmware* (BLHeli) settings are deferred to Phase 6 (4-way passthrough).

### Props-on motor measurement (in development — PLAN decision 48)

The props-off check above asks the operator, motor by motor, where it is and which way it turns — and still cannot see the commonest first-flight crash, a prop on the wrong motor or props-in and props-out mixed up. With the props on, the drone can answer all of it from its own gyro, with one confirm from the operator.

**Setup the operator does:** battery in, props on, drone flat on the floor with its arms (or motor guards, or ducts) resting on it, nose away, everyone two metres back. A drone that rests on a hanging battery or a narrow body is effectively on a block, and the measurement below does not hold for it.

**What one motor tells us:**

| What the drone feels | What it means |
|---|---|
| That corner lifts, tipping the drone away from it | Where the motor is |
| The corner never lifts, up to the cap | Its prop is pushing down — wrong prop, or upside down — or it is missing |
| A yaw twitch as the motor spins up (the rotor's reaction) | Which way the motor turns |
| RPM from the ESC (bidirectional DShot) | The output really is connected; the throttle at which it starts |

**Why the floor and not a block.** Tilt measures turning force, and "this arm pushes up" turns the drone exactly as "the opposite arm pushes down" does. On a block, a drone with every prop reversed reads as four healthy motors each at the opposite corner, and the fix would be a flip on takeoff. An arm resting on the floor cannot go down, which breaks the tie: movement means lift. Opposite arms on a quad also spin the same way, so the yaw twitch cannot break it either.

**Why pulses and not a slow ramp.** Lifting one corner off the floor needs roughly half the drone's weight on that motor — on some drones most of its throttle. As a pulse of tens of milliseconds the corner rises a millimetre or two and drops back, so the energy is bounded and the drone cannot run away. The response then arrives in a known window after each pulse; a lift has a signature a prop pushing into the floor cannot produce (a sharp tilt, then the knock of the landing); and the rotor's spin-up reaction is, on a back-of-envelope estimate for a 3" quad, several times the floor's grip where the steady drag of a ramp is not — which is what should make the direction readable at all. The bench decides that.

**How the applet runs it**, per motor:

1. Ramp from stopped until the ESC reports RPM — the motor's start throttle, the basis for spin-arm. Hold just above it as idle.
2. A ladder of short pulses from idle, each a step stronger, until one clearly lifts (or the cap). Repeat that one to average.
3. Stop that motor; settle; next.

Throughout it holds the firmware's own motor test on a 0.15 s timer, re-sent every loop: if the applet stops for any reason the motor stops by itself. It stops everything at once on any tilt past the abort angle, or on movement while it should be idle. It raises the gyro filter cutoff for the run, in memory only, so a reboot restores it even if the applet dies, and puts it back when it ends. Spin-arm is measured (worst motor's start + margin); spin-min follows ArduPilot's rule (spin-arm + about 0.03) and is checked against the ESC's error rate on the jumps from idle. A motor that needs noticeably more throttle than the others to lift is a weak motor or a damaged prop.

**The battery is read, not asked.** The test needs the flight battery in, so its voltage gives the cell count (`src/workflow/battery.ts`), and one button sets everything that follows from it: low battery comes home (or lands, without a position) at 3.5 V a cell, nearly flat lands at 3.3, no take-off below 3.6 resting, and thrust held steady from full (4.2, or 4.35 for a high-voltage pack) down to 3.3. A fresh drone needs it: its low-battery warning sits at 10.5 V whatever the pack, which blocks arming below a charged 3S, and both battery failsafes only warn. A count is read only from 3.65 to 4.36 V a cell — the window where 1S to 6S can't be mistaken for a neighbour. Lower, the operator is told to charge the pack rather than have it guessed, because the likely misreading (a flat 6S as a full 5S) sets every threshold a cell low. Above 6S, where two counts can both fit, the screen asks which. For now this lives on the probe's screen; it moves with the probe into "Set up motors".

**Motor noise** comes from the firmware's gyro FFT, which runs at full gyro rate whether armed or not. Because one motor spins at a time, what it hears during a motor's pulses is that motor's noise. Lua has no binding to read it today; SFD adds one. Parsing the log in Lua was rejected: thousands of times slower, and an owned drone's logs are encrypted to a key it does not hold.

**Slices:**

1. **Probe** — the applet plus an expert-only screen that runs it and shows each motor's raw result: start and lift throttle, which way it tipped, the yaw twitch, RPM. Plumbing tested on SITL (which holds a grounded drone level, so no lift appears there); the physics and the thresholds settled on the bench.
2. **SFD firmware** — a script binding for the gyro FFT's peaks.
3. **Per-motor noise** in the applet.
4. **Fold it into "Set up motors"** — the planner takes measured positions and directions instead of the operator's clicks, and the spin-arm / spin-min / noise results feed "Ready for first flight".

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

1. **Props-off mode is default during bringup.** UI states this explicitly. Phases that require power are explicitly flagged. The one exception is props-on motor measurement (PLAN decision 48), which spins with props on by design — behind its own confirm, on a dead-man timer, bounded to short pulses, and stopped by the drone itself on any unexpected movement.
2. **No write without read.** Always read the current value before writing; show before/after on confirm.
3. **Batch + commit, don't drip.** Stage param changes in the dirty set; present a single confirm-and-write.
4. **Persist before reboot.** Always save params to flash before any operation that triggers reboot.
5. **Gates are auditable.** Why did the operator advance? Logged in wizard state.

## SFD-specific bringup considerations

This tool is for SmallFastDrone, not vanilla ArduPilot. Defaults and recipes assume:

- **SFD firmware, any H7 board, anyone's airframe** (PLAN decision 47). The target is a drone with SFD installed, not an SFD-built drone. SFD's own board target (`SmallFastDronev1`) ships defaults that already set the frame, ESC protocol, motor directions and the RPM vibration filter — but no other board does, so bringup can never assume them. On that board those steps show as already done; everywhere else they run.
- **Small frame class** (sub-300 mm typical), high power-to-weight.
- **Indoor / confined-space flight** is common — tighter PIDs, conservative climb rates, careful failsafes.
- **Throw-mode launching** is a primary use case; bringup must produce a throw-ready config.
- **Carrier-mounted GPS-poor takeoffs** require `THROW_SRC_INI` handling rather than a blanket "drop SRC_INI" suggestion.

When a recipe or phase has SFD-specific reasoning, link to the relevant doc in `../smallfastdrone/` (e.g. `ArduCopter/CLAUDE.md` indoor playbook) in the recipe description, so the operator can audit the rationale.

## Securing (optional, last)

The bringup ribbon ends with **Secure your drone** (`sfd-enable`), which gives an
SFD drone its own identity. It is deliberately the only **optional** area: the
ribbon's completion gate counts required areas only. Bringup is about getting a
drone flying, securing is about its identity, and most drones cannot be secured
at all — gating completion on it would leave an ordinary ArduPilot drone
permanently short of finished.

The panel says which of those a drone is rather than vanishing on one that
isn't a candidate ("Not available on this drone"), per the never-silently-hide
rule in [WIZARDS.md](WIZARDS.md).
