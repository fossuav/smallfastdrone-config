# UX Design — Operator-First

> This tool exists for **operators**, not experts. Someone who doesn't know what `INS_GYRO_FILTER` is, what `ATC_RAT_PIT_P` does, or what NED means should still be able to get a SmallFastDrone configured and flying well — and later, tuned well — by following a visual, opinionated workflow.
>
> Read [PLAN.md](../PLAN.md) for mission and [BRINGUP.md](BRINGUP.md) for workflow shape.

## Audience

The target operator:

- Has a SmallFastDrone they want to fly. May have built it themselves or received it pre-built.
- Knows their drone is a quad / hex / etc., and roughly what they want to do (indoor freestyle, outdoor cinematic, throw-launched scout, etc.).
- Does **not** know MAVLink, parameter names, PID values, filter design, EKF tuning, or coordinate frames.
- Should not need to learn any of those things to get a good outcome.

Operators may **become** experts over time. The tool accommodates growing sophistication without forcing it. Expert affordances exist behind an explicit toggle.

## Core principles

1. **One choice at a time, with a picture.** Each wizard step asks for one decision. Each decision has a visual that makes the answer obvious.
2. **Pre-decided defaults.** Recipes hide parameter complexity behind named, illustrated choices: "Indoor cinewhoop", "Outdoor freestyle", "Throw-launched scout". The operator picks an outcome; the tool picks the params.
3. **Show, don't list.** A 3D drone model rotates and highlights the active motor during motor test. A drawn frame illustrates which way to orient the drone for compass cal. A live spectrum shows filter effect in real time.
4. **No raw jargon in operator copy.** Operator-facing strings never contain parameter names, MAVLink message names, or units the operator doesn't need. Internally we may call it `ATC_RAT_PIT_P`; in the UI it's "Pitch responsiveness".
5. **Safe by default.** Defaults are conservative. Dangerous combinations are blocked outright or require explicit "I know what I'm doing" confirmation in expert mode.
6. **Recoverable mistakes.** Every change is reversible — wizard back-button restores prior state; param writes are batched with a "revert this batch" affordance.
7. **Live feedback always.** Wherever the FC reports something useful (vibration, link health, sensor health), the tool shows it visually and continuously. No buried status pages.
8. **Eye-candy is utility, not decoration.** Every animation, 3D model, or visual exists to make a decision easier or to give the operator confidence the tool is working — not to look cool. (It can also look cool.)

## Expert mode

Power-users get a toggle (top-right of the app shell) that exposes:

- Raw param browser
- Recipe internals (the steps a recipe actually performs)
- MAVLink message inspector / live feed
- Manual protocol mode controls (force MAVLink ↔ MSP ↔ 4-way)
- 4-way ESC raw settings (vs. the simplified "ESC profile" picker)
- DFU flash with operator-supplied firmware (vs. curated SFD release picker)

Expert mode is **off by default** and **per-session** — re-enable each session. Operators must not stumble into expert UI by accident.

## Visual language

### 3D drone model

The hero element. Used in:

- **Frame phase:** rotate to confirm frame class/type matches the operator's actual drone.
- **Sensor cal:** animated tilt arrows showing the next required orientation.
- **Motor test:** highlight the active motor; show prop direction.
- **Mode setup:** brief animation showing what each flight mode "feels like".
- **Connect screen:** a slow rotation while waiting for the FC.

Implementation: **Tres.js** (`@tresjs/core` + `@tresjs/cientos`) — Vue-3-native three.js wrapper, declarative scene composition via Vue components. One generic drone model with frame-class variants; no per-board models.

### 2D illustrations

For cal procedures, RC channel mapping visualization, failsafe explanation, throw-mode launch posture. SVG, Vue-reactive. Hand-drawn SVGs in `src/ui/illustrations/`. No external illustration library.

### Live data visualization

- **Spectrum plot** (filter phase): canvas-based, hand-rolled.
- **Vibration history**: small SVG sparkline.
- **Stick visualization** (RC phase): SVG sticks animating with live RC channel data.
- **Motor map** (ESC phase): SVG drone outline with reactive per-motor RPM / direction overlays.
- **Link health**: signal-bars with continuous animation.

No chart lib in v1. If a need outgrows hand-rolled canvas/SVG (e.g. interactive PID trace plotting in expert mode), revisit via PLAN.md decision.

## Microcopy guidelines

- **No parameter names.** "Pitch responsiveness" not "ATC_RAT_PIT_P".
- **No MAVLink jargon.** "Connect to drone" not "Open MAVLink session". "Loading drone settings…" not "Fetching PARAM_VALUE stream".
- **Operator-recognisable units.** Metres for altitude, percent for throttle, degrees for angles. Never centidegrees, never radians.
- **Error messages name cause and fix.** "Drone didn't respond. Check the USB cable and try Connect again." Not: "MAVLink heartbeat timeout (no HEARTBEAT in 3000ms)."
- **Confirmations explain the consequence.** "This will write 14 settings to your drone and reboot it. Your drone won't be ready to fly for about 10 seconds." Not: "Commit changes? [Y/N]".
- **Progress is visible.** Long-running operations show a progress indicator with a plain-language label — not a bare spinner.

## Accessibility

Not a v1 polish target, but baseline:

- Keyboard navigation throughout — wizard advance/back via arrow keys.
- Sufficient colour contrast (Tailwind defaults mostly OK; verify wizard accent colour).
- Status conveyed by colour + icon + text, never colour alone — operators often work in suboptimal lighting.
- Respect `prefers-reduced-motion` for animations.

## Per-view visual identity

| View | Hero visual |
|---|---|
| `ConnectView` | Animated USB icon + drone silhouette during scan; 3D drone appears once connected. |
| `WizardView` | 3D drone model + per-phase illustration; phase progress rail along one edge. |
| `RecipesView` | Recipe cards with illustrations; before/after summary on hover or focus. |
| `ParamsView` | **Expert mode only.** Plain searchable table. This is the safety hatch, not a primary surface. |
| `LogsView` | Log catalog with date / duration / size; download button per row. |
| `FirmwareView` | Animated DFU flow with visual stage indicators; firmware metadata card. |
| `EscToolsView` | Per-ESC card with live data; "ESC profile" picker visible by default; raw 4-way settings only in expert mode. |

## Anti-patterns we won't ship

- A param table as a primary surface. Operators should rarely see one.
- Modal dialogs full of acronyms.
- "Click to advance" wizards that don't visually confirm the previous step actually worked.
- Recipes presented as a list of `param=value` rows. Operators choose outcomes, not parameter assignments.
- Spinners without labels.
- Numeric values in units the operator doesn't intuit (centidegrees, raw stick units, MAVLink enums).
- "Are you sure?" prompts that don't say what will actually happen.

## Future tuning sophistication

In time we will introduce sophisticated tuning options (manual PID adjustment, custom notch placement, EKF tweaks). The constraint:

- **They still must be simple to configure.** A sophisticated capability is not a license for a sophisticated UI. Sliders with named ranges, illustrated effects, and live preview before commit.
- They go behind expert mode unless a recipe-style "guided sophistication" wrapper exists.
- Add them only when an operator-friendly framing exists. If we can't explain it without using a parameter name, we're not ready to ship it.
