# Wizard Runtime Design

> Read [PLAN.md](../PLAN.md), [BRINGUP.md](BRINGUP.md), and [UX.md](UX.md) first.

A **wizard** is a self-contained, opinionated workflow that takes a drone from one named state to another — "frame configured," "notch tuned from a hover," "throw-mode set up," "first-flight failsafes wired." Wizards are the **primary delivery primitive** of this tool. The bringup workflow is itself a wizard (a meta-wizard that chains sub-wizards). Recipes are wizards too — the degenerate case with one step and no live state.

Wizards are designed to be **pluggable**: ship in a folder, declared via a manifest, discovered at build time, surfaced in the wizard library. New wizards land without touching the runtime.

## Operating principles

- **Opinionated, not interrogating.** The wizard picks the right engine, the right defaults, the right next step. The operator confirms; the wizard decides. Every "which option do you want?" prompt is a failure of the wizard to know its job — find a way to decide automatically, or pick a safe default with an override affordance in expert mode.
- **One outcome per wizard.** A wizard does one named thing well. If a wizard has two outcomes, split it and chain them in a meta-wizard.
- **The engine is invisible.** Operator never picks "Lua vs log vs desktop." The runtime detects FC capability, picks the best engine that works, runs it. Switching engine (e.g. "redo this from a log instead of in-flight") is an explicit affordance, not a default question.
- **Resources only when needed.** Lua wizards install when the operator starts them and uninstall when they finish or abort. Idle wizards consume zero FC resources.
- **Pure operator language.** No parameter names, no MAVLink terms, no acronyms. "Smoothing out vibration" not `INS_HNTCH_FREQ`.
- **Safe by default; lethal moves require deliberate operator action.** Anything that arms motors, changes flight surfaces, or could damage the airframe needs an explicit confirm — never a side-effect of clicking Next.

## Vocabulary

| Term | Meaning |
|---|---|
| **Wizard** | A workflow that takes the drone from one state to another. Owns a manifest, one or more engines, one or more views. |
| **Engine** | The implementation that does the work. Three kinds — `lua`, `log`, `desktop`. A wizard can declare multiple; the runtime picks the best available. |
| **View** | The operator-facing surface. Two kinds — `desktop` (Vue UI in this tool) and `crsf` (CRSF menu on the FC). Multiple views can drive the same engine. |
| **Recipe** | A wizard with one step and no live state — a named param batch applied atomically. Same runtime, simpler contract. |
| **Meta-wizard** | A wizard whose work is to run other wizards in sequence (e.g. bringup). Picks sub-wizards based on FC capability and operator goals. |

## Manifest

Each wizard ships as a folder at `src/wizards/<id>/`. Mandatory file: `manifest.ts`.

```ts
interface WizardManifest {
  id: string // stable identifier, kebab-case
  title: string // operator-facing, plain language
  description: string // one-line operator-facing
  category: 'bringup' | 'tune' | 'recipe' | 'diagnostic' | 'safety'
  hero: string // illustration path or 3D scene id

  // What the operator gets at the end. Used in cards and completion messaging.
  outcome: string // e.g. "Drone ready for first hover"

  // Engines the wizard supports. Runtime picks first viable in order.
  engines: EngineDescriptor[]

  // Desktop view is always required. CRSF view is optional gravy.
  views: { desktop: DesktopViewDescriptor, crsf?: CrsfViewDescriptor }

  // Params this wizard reads and/or writes. Declared so the runtime can:
  //   (a) lock them from concurrent edits in the param browser,
  //   (b) snapshot before/after for the operator audit log,
  //   (c) warn the operator if another wizard or recipe touches them.
  owns_params: string[]

  // Prerequisites checked before letting the operator start. Plain-language
  // strings shown to the operator; the runtime maps to programmatic checks.
  prerequisites: Prereq[]

  // Lifecycle flags.
  in_flight: boolean // runs while armed?
  requires_props_off: boolean // operator must confirm props off to start

  // Commercial / gating. v1 honours `locked: true` as "show greyed-out card
  // with description + Pro badge." Real entitlement check lands later.
  locked?: boolean
  unlock_blurb?: string // shown on the locked card
}
```

## Engine contracts

A wizard declares one or more engines in priority order. Runtime walks the list, picks the first one the connected FC supports, and runs it. Operator sees only the result.

```ts
type EngineDescriptor
  = | { kind: 'lua', applet: string, requires: LuaRequires }
    | { kind: 'log', extractor: string, message_ids: number[] }
    | { kind: 'desktop' }

interface LuaRequires {
  scripting: true // SCR_ENABLE settable + non-zero
  min_heap_kb?: number // checked against SCR_HEAP_SIZE
  ardupilot_min_version?: string // e.g. "4.7.0"
}
```

### Lua engine

The wizard ships a Lua applet at `src/wizards/<id>/applet.lua`. The runtime owns its lifecycle — operator never sees "script installed" or "scripting enabled" messaging.

```
operator clicks Start
  → runtime checks SCR_ENABLE; if zero, asks operator "enable scripting?"
    once, sets it, reboots FC
  → runtime uploads applet.lua to APM/scripts/ via MAVLink FTP
  → runtime sets WIZ_<ID>_ACTIVE = 1 (the applet self-arms on this param)
  → applet runs, reads/writes its owned params, emits progress via
    NAMED_VALUE_FLOAT or a status param
  → desktop view polls progress + renders
  → wizard completes (success / abort)
  → runtime sets WIZ_<ID>_ACTIVE = 0 (applet returns to a long sleep interval)
  → runtime deletes applet.lua from APM/scripts/
  → runtime reboots FC only if necessary (e.g. SCR_ENABLE was flipped this
    session, or the applet's exit contract requires it)
```

**Resource discipline.** A Lua wizard MUST tolerate being killed mid-run (operator Abort, USB unplugged, FC reboots) without leaving the FC in a bad param state. The applet's exit path always sets owned params to a sane resting value before returning nil. The runtime tracks `WIZ_<ID>_ACTIVE` at reconnect — if non-zero with no active session, the runtime offers a one-click "clean up previous wizard run."

**Idle cost.** When `WIZ_<ID>_ACTIVE = 0` the applet `return`s with a long interval (≥ 1000 ms) and does effectively nothing — but the script file is still loaded. **The applet file is removed on completion**, not just deactivated, so a finished wizard reclaims its full resource footprint. Reactivation costs an FTP upload (~100 ms).

**Concurrent wizards.** At most one Lua wizard active per FC. Runtime refuses to start a second until the first releases.

### Log engine

The wizard ships an extractor at `src/wizards/<id>/extractor.ts` that takes a parsed `.bin` log slice and produces a result.

```ts
interface LogExtractor {
  // Subset of message types the extractor needs. The .bin parser only
  // materialises these — anything else is skipped for speed.
  message_ids: number[]

  // Pure function: log slice in, recommended param changes out.
  extract: (log: ParsedLogSlice) => WizardResult
}
```

Log-engine flow:

```
operator clicks Start
  → wizard view tells operator: "Fly a 30-second hover, then come back."
  → operator flies, lands, downloads the .bin (Phase 4 capability)
  → operator drops the .bin onto the wizard view (or it auto-picks the
    most recent log)
  → extractor runs in-tool, produces recommended param changes
  → operator reviews + confirms; runtime writes via param store
```

Log engine is the **universal fallback** — any wizard whose work is amenable to post-flight analysis should ship one, because it works on every FC regardless of scripting support.

### Desktop engine

No flight, no scripting. Pure client-side compute + param writes. Examples: frame selection (operator picks frame, wizard writes `FRAME_CLASS` + `FRAME_TYPE`), accel cal orchestration (operator tilts drone through orientations, tool sends commands), RC channel mapping.

The Vue view *is* the engine — runtime provides the session store, param store, and completion hooks; the view drives.

## Views

### Desktop view (required)

Every wizard this tool ships has a Vue component at `src/wizards/<id>/DesktopView.vue` that:

- Reads wizard state from the FC (via params and/or `NAMED_VALUE_FLOAT` for Lua-engine wizards; via internal Vue state for desktop-engine wizards).
- Renders an operator-friendly progression — hero visual, current step, what's happening, what to do next.
- Surfaces an Abort affordance that cleanly stops the engine.
- Calls `runtime.complete(result)` on success or `runtime.abort(reason)` on cancel.

### CRSF view (optional)

For Lua-engine wizards that benefit from in-field operation, the wizard can declare a CRSF menu schema at `src/wizards/<id>/crsf-menu.lua`. This is **not a concern of this tool's runtime** — the menu is purely FC-side, served by SFD's CRSF menu stack (see `../smallfastdrone/libraries/AP_Scripting/CLAUDE_CRSF_MENU.md`). Declaring it in the manifest is informational; the wizard library card renders a "field-capable" badge so operators know they don't need a laptop for this one.

## Capability detection

Runtime detects FC capabilities once per connection (cached, invalidated on reconnect):

| Capability | Check |
|---|---|
| `scripting` | `SCR_ENABLE` parameter exists and is writable |
| `scripting_heap_kb` | `SCR_HEAP_SIZE` value (KB) |
| `crsf_menu` | `CRSF_MENU_ENABLE` exists (SFD-specific) |
| `firmware_version` | From AUTOPILOT_VERSION |
| `ftp_writable` | Probe MAVLink FTP write to a scratch path |
| `fc_uuid` | From AUTOPILOT_VERSION (uid / uid2) |

The library filters wizards by capability — wizards with no viable engine still appear but are flagged "not supported on this drone" with a one-line explanation ("your flight controller doesn't support scripting; this wizard needs it"). Never silently hide.

## State persistence

Wizard progress lives in **IndexedDB**, keyed by `${fc_uuid}_${wizard_id}`. `fc_uuid` is the FC's autopilot UID — survives reflash, distinguishes per-drone state.

Per wizard, stored:

- Current step
- Engine chosen
- Param snapshot at start (for revert)
- Operator confirmations + timestamps
- Result (on completion)

Operator can disconnect, reconnect, and resume. Runtime re-validates FC UID matches, re-detects capabilities, re-enters the wizard at its last step. If the FC UID changed (different drone), the wizard restarts fresh.

## Recipes-as-wizards

A recipe is a wizard with:

- `engines: [{ kind: 'desktop' }]`
- `in_flight: false`
- A `DesktopView` that renders the param diff + a single confirm button
- No live state

Recipes can ship as data (`recipe.json`) and the runtime wraps them in a generated manifest. Operator never sees the distinction between "wizard" and "recipe" — both are cards in the library, both run through the same runtime, both write via the param store's dirty/confirm path.

## Bringup as meta-wizard

The bringup workflow is a meta-wizard at `src/wizards/bringup/`. Its engine is `desktop`. Its DesktopView walks the operator through sub-wizards in order:

1. `frame-select`
2. `sensor-calibration`
3. `rc-setup`
4. `motor-test`
5. `failsafes-first-flight`
6. `first-hover` (Lua engine — collects hover samples)
7. `notch-from-hover` (log or Lua engine; runtime picks per FC capability)
8. `pid-autotune` (Lua engine if available, else AutoTune via mode change)
9. `mode-setup`
10. `verify`

The meta-wizard's job is sequencing + gating; sub-wizards do the actual work and own their own state. An experienced operator can launch any sub-wizard standalone from the library.

## Commercial gating (v1)

v1 honours one flag on the manifest: `locked: true`. The library renders such wizards as:

- Greyed-out card with the standard hero
- "Pro" badge corner ribbon
- `description` and `unlock_blurb` visible
- Start button replaced with "Coming soon" (no-op)

**No real entitlement check in v1.** The plumbing (manifest flag → card state) is the seam; the actual unlock flow lands when there's a payment integration to wire to. Same play as the security seam — design once, fill later.

## Anti-patterns

Wizards that fail any of these aren't ready to ship:

- **Asks the operator a configuration question** ("which filter type?"). The wizard's job is to know. If it genuinely can't decide, the answer is a recipe selector at a higher level, not a question inside the wizard.
- **Shows parameter names or units in primary copy.** "Smoothing out vibration" not "Setting INS_HNTCH_FREQ to 80 Hz" — the latter belongs in expert mode / audit log only.
- **Exposes engine choice as a question.** "Run this from a log or live in flight?" → wrong. Runtime picks; explicit "use the log instead" affordance available but not the default question.
- **Leaves the FC in a non-resting state on abort.** Owned params must be returned to a sane value, applet must be uninstalled, scripting must drop back if the wizard enabled it.
- **Writes params without batching.** All param writes go through the param store's dirty/confirm path — every change is auditable and revertable, even mid-wizard.
- **Bare text-only step.** Every step has a visual (hero illustration, 3D scene, live data, animation). No exceptions — see [UX.md](UX.md).
- **Hidden side effects on Next.** "Click Next" only advances the UI. Lethal moves (motor spin, mode change, AutoTune start) require their own explicit confirm.

## Testing

- **Unit:** manifest validation, capability matching, engine selection logic, recipe-to-wizard adaptation.
- **Integration (SITL):** every wizard runs end-to-end against SITL. Desktop-engine wizards can run headless; log-engine wizards run with a checked-in fixture `.bin`; Lua-engine wizards run with SITL configured for scripting.
- **E2E (Playwright):** each shipped wizard has at least one happy-path E2E test against SITL — operator opens library, picks wizard, runs to completion, sees expected param changes in the param browser.

## v1 scope (Phase 2)

The Phase 2 deliverable:

- Wizard runtime (`src/workflow/wizard-runtime.ts`) — capability detection, engine selection, lifecycle hooks, IndexedDB persistence
- Wizard library view (`src/views/WizardLibraryView.vue`) — cards driven by manifests, filtered by FC capability, with locked-state rendering
- Two real wizards end-to-end:
  - `frame-select` — desktop engine, writes `FRAME_CLASS` + `FRAME_TYPE`, demonstrates the contract
  - `bringup` — meta-wizard, walks through `frame-select` and a placeholder Pre-flight step, demonstrates the meta pattern
- One locked stub wizard in the library so the gating affordance is visible from day one

Deferred:

- **Lua engine implementation** — contract is shipped; first Lua wizard lands Phase 3+
- **Log engine implementation** — depends on Phase 4 (`.bin` parsing); first log wizard lands when that ships
- **CRSF menu integration** — FC-side, lives in `../smallfastdrone/`
- **Runtime wizard loading** — build-time bundle only in v1
- **Real entitlement check** — the `locked` flag is informational

## Out of scope (architectural)

- **Runtime plugin loading.** Always build-time bundled. No remote wizard URLs, no signed-payload runtime install. Third-party wizards land via fork or PR.
- **Multi-wizard concurrency.** At most one wizard active at a time. Runtime refuses to start a second.
- **Wizard-to-wizard messaging.** Sub-wizards talk to their meta-wizard via results; siblings don't talk directly.
