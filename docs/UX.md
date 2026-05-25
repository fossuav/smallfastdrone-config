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

### Brand palette

- **Purple** (FOSS UAV): anchor `#4A1E80`, scaled into a `foss-50…950` Tailwind palette. Used as Nuxt UI's `primary` slot — the dominant action colour (buttons, active nav, links, icons that signal "you can act here").
- **Gold** (FOSS UAV): anchor `#C9A35F`, scaled into a `gold-50…950` palette. Used as Nuxt UI's `secondary` slot — accent for highlighted labels and decorative emphasis. Sparing use: gold draws attention; it isn't a wallpaper. **Not** the completion signal — done/complete states use green (Nuxt UI's `success`), consistently across the app (library "Done" badges, the wizard phase rail + bringup ribbon ticks, review screens). A green tick reads unambiguously as "this is finished and good"; gold is reserved for "look here," not "this passed."
- **Neutral** (SFD black/white minimalism): Tailwind's `neutral` palette — true grayscale for text, backgrounds, and structural surfaces. Most of the screen is neutral; brand colour appears where the operator needs to look.

Definitions live in `src/assets/css/main.css` (`@theme` block) and are wired into Nuxt UI via the `ui()` Vite plugin options in `vite.config.ts`. Standard Nuxt UI components pick the right intensities automatically (light mode pulls `-500/-600`, dark mode pulls `-400`).

Don't reach for raw Tailwind colour classes (`bg-blue-500`, etc.) in components — go through Nuxt UI's semantic tokens (`color="primary"`, `text-default`, `bg-elevated`) so a theme change here is the only place to update.

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
| `SettingsView` | One card per feature toggle (switch + plain-language description + current-state line). Reboot-required toggles surface an Apply confirm; the restart + reconnect is handled for the operator. |

## Feature toggles & reboot-required changes

`SettingsView` is the operator-facing home for FC feature toggles that map to parameters (scripting on/off, and later DDS, telemetry types, etc.). The pattern, established by the Lua-scripting toggle and codified here so every future toggle follows it:

- **Confirm only when a reboot is involved.** A change that takes effect immediately should *just happen* on toggle — flip the switch, the parameter is written, done. Don't make the operator hit Apply for a change with no consequence to weigh. An explicit **Apply** step exists **only** for changes that require a restart (or are otherwise destructive/expensive), where the operator genuinely needs to opt in. A `rebootRequired`-style flag on the toggle drives which path it takes.
- **One action does the whole job.** When a reboot *is* required, the single confirm (Apply) does everything: write the parameter, restart the drone, and reconnect — with no further clicks. Don't decompose a reboot into separate "Apply", "Restart", and "Reconnect" buttons the operator has to chase in sequence. The operator expressed intent once; honour it end-to-end.
- **Reconnect is automatic, not the operator's chore.** After a restart, the tool reconnects on its own, retrying through the FC's boot window. A manual "Reconnect" affordance appears only as a *fallback* if auto-reconnect exhausts its budget — never as the default path. The operator should be able to walk away during the restart and come back to a settled, applied state.
- **Name the consequence before it happens.** The confirm copy says what will occur in operator terms — "Applying this restarts your drone (a few seconds) — we'll reconnect automatically when it's back" — not "Set SCR_ENABLE=1 and reboot".

## Anti-patterns we won't ship

- A param table as a primary surface. Operators should rarely see one.
- Modal dialogs full of acronyms.
- "Click to advance" wizards that don't visually confirm the previous step actually worked.
- Recipes presented as a list of `param=value` rows. Operators choose outcomes, not parameter assignments.
- Spinners without labels.
- Numeric values in units the operator doesn't intuit (centidegrees, raw stick units, MAVLink enums).
- Making the operator babysit a reboot — separate Restart/Reconnect buttons, or a manual reconnect as the default after a restart. One confirm, then the tool handles restart + reconnect.
- "Are you sure?" prompts that don't say what will actually happen.

## Future tuning sophistication

In time we will introduce sophisticated tuning options (manual PID adjustment, custom notch placement, EKF tweaks). The constraint:

- **They still must be simple to configure.** A sophisticated capability is not a license for a sophisticated UI. Sliders with named ranges, illustrated effects, and live preview before commit.
- They go behind expert mode unless a recipe-style "guided sophistication" wrapper exists.
- Add them only when an operator-friendly framing exists. If we can't explain it without using a parameter name, we're not ready to ship it.
