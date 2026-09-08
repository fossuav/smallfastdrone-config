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
9. **Generous with showing, stingy with asking.** Read-only surfaces are not bloat — firmware version, frame, what's calibrated, what's on the radio, the log list. Controls are. The knife that keeps the tool small cuts questions, not information.
10. **A control must be justified by a recipe that could not do it.** If a recipe can determine the value, there is no control (PLAN decision 44). This is "configure, don't ask" as a gate rather than a preference: bloat is never decided, it is the absence of a decision, so the only defence is a test that adding has to pass. The health metric is **how often an operator has to open the param browser** — high means the recipe library has a hole, and the fix is a recipe, not a control. "They can use expert mode" is never a reason to skip building one.

## Expert mode

Power-users get a toggle (top-right of the app shell) that exposes:

- Raw param browser
- Recipe internals (the steps a recipe actually performs)
- MAVLink message inspector / live feed
- Manual protocol mode controls (force MAVLink ↔ MSP ↔ 4-way)
- 4-way ESC raw settings (vs. the simplified "ESC profile" picker)
- DFU flash with operator-supplied firmware (vs. curated SFD release picker)
- Operator-supplied / custom Lua field tools (vs. the curated catalogue)
- **Developer detail**: System ID, raw link byte counters, firmware git hash, dev hints like the SITL transport URL. An operator never needs these; an expert sometimes does. Default surfaces show what the operator needs to decide or confirm; raw FC / build / link metadata goes here.

Expert mode is **off by default** and **per-session** — re-enable each session. Operators must not stumble into expert UI by accident.

## One catalogue

There is **one** operator-facing catalogue, called **Recipes**, and it lists everything the tool can do to a drone. Bringup's steps are in it, free. Tuning recipes are in it. Securing is in it. Paid entries are in it, greyed. Internally they are all the same object (a wizard manifest — see [WIZARDS.md](WIZARDS.md)); the operator never meets that word.

The tool previously had three catalogues — a wizard library, a Recipes page and a Field tools page — each rendering the same object with different chrome. That was not a decision, it was accretion, and it is the shape competing configurators bloat into. PLAN decision 43 collapsed it.

Two things are deliberately kept out of the collapse:

- **The guided sequence.** Bringup is ordered and has a done-state — the frame builds the mixer, so a motor check before a frame choice is meaningless, and *"this drone has never had its motors checked"* is a safety fact. It stays a meta-wizard with its own ribbon, listed in the catalogue as the guided path. Its steps are individually runnable for an operator who already knows what they want. An order-free grid of everything would push the ordering back onto the operator, and then need explanatory UI to fix that — bloat arriving through the back door.
- **Read-only chrome.** The header still shows how many tools are on the radio, the security badge still shows posture. Showing is cheap; asking is what we ration.

## Settings vs procedures — when to use a wizard

Two kinds of operator task, two surfaces — don't conflate them:

- **Settings** are simple, reversible changes the operator already knows they want — flip RPM telemetry on, pick an output protocol, turn scripting on. There's nothing to guide; the right surface is an **inline quick control** they can flip in place, using the `SettingsView` reboot pattern (flip → write → reboot if needed → auto-reconnect, no babysitting). That's the only ceremony.
- **Procedures** are multi-step or need live interaction or guidance — the motor order/direction check (spin each motor, identify), sensor calibrations, the full bringup walk. These earn their wizard.

A wizard for a setting is friction (extra clicks for no benefit). A setting where a procedure belongs is dangerous (the operator skipped the guidance). Pick the right surface for the task. The bringup ribbon's Motors tab is the worked example: protocol + RPM telemetry are inline quick controls on the config panel, the order/direction check is the guided procedure below.

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
| `FieldToolsView` | Catalogue of field-installable tools (one row per tool, Install / Remove inline); scripting-on indicator; commercial gating shown as locked "Pro" rows; expert-only "Add your own applet" affordance. Reached from a header radio-icon entry point that also carries the installed-count badge. |

## Feature toggles & reboot-required changes

`SettingsView` is the operator-facing home for FC feature toggles that map to parameters (scripting on/off, and later DDS, telemetry types, etc.). The pattern, established by the Lua-scripting toggle and codified here so every future toggle follows it:

- **Confirm only when a reboot is involved.** A change that takes effect immediately should *just happen* on toggle — flip the switch, the parameter is written, done. Don't make the operator hit Apply for a change with no consequence to weigh. An explicit **Apply** step exists **only** for changes that require a restart (or are otherwise destructive/expensive), where the operator genuinely needs to opt in. A `rebootRequired`-style flag on the toggle drives which path it takes.
- **One action does the whole job.** When a reboot *is* required, the single confirm (Apply) does everything: write the parameter, restart the drone, and reconnect — with no further clicks. Don't decompose a reboot into separate "Apply", "Restart", and "Reconnect" buttons the operator has to chase in sequence. The operator expressed intent once; honour it end-to-end.
- **Reconnect is automatic, not the operator's chore.** After a restart, the tool reconnects on its own, retrying through the FC's boot window. A manual "Reconnect" affordance appears only as a *fallback* if auto-reconnect exhausts its budget — never as the default path. The operator should be able to walk away during the restart and come back to a settled, applied state.
- **Name the consequence before it happens.** The confirm copy says what will occur in operator terms — "Applying this restarts your drone (a few seconds) — we'll reconnect automatically when it's back" — not "Set SCR_ENABLE=1 and reboot".
- **Surfaces stay put across a reboot they initiated.** When a panel triggers an FC restart (a feature toggle, a quick control), the surrounding UI doesn't collapse to "connect your drone" mid-flow — the control owns its restarting/reconnecting state inline, and the parent surface stays mounted. The bringup ribbon does this via `session.rebooting`; the wizard runner via "keep mounted across transient drops." A surface that vanishes during the reboot it initiated reads as a failure to the operator, even when it isn't.

## Notifications: bell + toasts

Two surfaces, two roles — don't blur them:

- **Toasts are the *alert* path.** Fired for FC warnings / errors as they arrive (the session store thresholds STATUSTEXTs at `MAV_SEVERITY_WARNING` and below). Routine INFO never toasts: a normal boot is dozens of INFO lines, and toasting them all is noise.
- **The bell is the *audit trail*.** Browsable history of every STATUSTEXT this session, in the nav popover. Its trigger badge counts only **unread important** (warning-or-worse) messages, clearing on open. Routine INFO doesn't drive the badge — a normal boot has nothing alarming to surface — but is still listed for review.

The rule: never present routine FC chatter as something demanding attention. The badge climbing into double-digits on every connect is alarm fatigue, not signal.

## Field tools (run from the radio)

Some procedures benefit from "no laptop at the field" — installed onto the FC, run from the transmitter's CRSF menu. The operator-facing model:

- **It is a property of a recipe, not a place.** The operator's question is *"can I run this one from the radio?"*, and the answer belongs on the thing itself. A field-capable card carries a green **"On the radio"** badge when installed, else an info-blue **"Field-capable"**; the catalogue has an **On the radio** filter that narrows to those entries and gives each an Install / Remove control; the per-wizard chrome carries the same inline toggle. This replaced a dedicated Field tools page (2026-09-08, PLAN decision 43) — a whole surface for what is one attribute of a catalogue entry.
- **Selective.** The operator installs only what they pick — never an all-or-nothing bundle. Each row has its own Install / Remove.
- **One store.** The badge, the filter, the chrome toggle and the header count all read `useFieldToolsStore`, so a change anywhere reflects everywhere.
- **Scripting is handled in place.** Field tools run as scripts; if scripting is off, the filtered view offers to turn it on (write → reboot → auto-reconnect, no babysitting) rather than sending the operator to Settings.
- **Commercial gating reuses the catalogue's `locked` seam.** A paid field tool is a Pro card in the same catalogue. No second gating mechanism, and no second "coming soon" stub demonstrating the same seam twice.
- **Custom (operator-supplied) tools live behind expert mode**, same posture as operator-supplied firmware DFU.
- **An applet SmallFastDrone sent for this drone** is not expert-gated — the operator cannot read or write it, but being given one is an ordinary thing for a customer. It sits with the catalogue, because that is what it is: a recipe made for one airframe alone.

Catalogue contract + extensibility seams: see `docs/WIZARDS.md` "Field-capable wizards".

## Anti-patterns we won't ship

- A param table as a primary surface. Operators should rarely see one.
- Modal dialogs full of acronyms.
- "Click to advance" wizards that don't visually confirm the previous step actually worked.
- Recipes presented as a list of `param=value` rows. Operators choose outcomes, not parameter assignments.
- Spinners without labels.
- Numeric values in units the operator doesn't intuit (centidegrees, raw stick units, MAVLink enums).
- Making the operator babysit a reboot — separate Restart/Reconnect buttons, or a manual reconnect as the default after a restart. One confirm, then the tool handles restart + reconnect.
- "Are you sure?" prompts that don't say what will actually happen.
- **A new capability earning a new page.** The default home for anything new is an existing surface. A new top-level destination needs a reason a reader of PLAN decision 44 would accept, written down.
- **Two surfaces rendering the same object with different chrome.** If they are the same thing, they are one surface with a filter.

## Future tuning sophistication

In time we will introduce sophisticated tuning options (manual PID adjustment, custom notch placement, EKF tweaks). The constraint:

- **They still must be simple to configure.** A sophisticated capability is not a license for a sophisticated UI. Sliders with named ranges, illustrated effects, and live preview before commit.
- They go behind expert mode unless a recipe-style "guided sophistication" wrapper exists.
- Add them only when an operator-friendly framing exists. If we can't explain it without using a parameter name, we're not ready to ship it.
