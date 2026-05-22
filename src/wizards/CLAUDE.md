# Wizards — authoring guidance

Directory-scoped context for `src/wizards/`. Read [docs/WIZARDS.md](../../docs/WIZARDS.md) for the full runtime contract (manifest shape, engine/view split, lifecycle). This file is the quick orientation when adding or changing a wizard.

## A wizard is a folder

`src/wizards/<id>/`:

- `manifest.ts` — required. The `WizardManifest` (see `src/workflow/wizard-runtime.ts`). Declares title/description/category/hero/outcome, `engines`, `owns_params`, `prerequisites`, lifecycle flags, optional `locked`.
- `DesktopView.vue` — required for any wizard this tool ships. The operator-facing Vue UI; orchestrates the wizard's engine via `useLuaEngine()` / the params store / the session store. Bringup-launched wizards honour a `?returnTo=` query for the back path.
- `applet.lua` — only for Lua-engine wizards. The FC-side script.

## Writing `applet.lua` — read the Lua playbooks first

Lua applets follow ArduPilot's scripting conventions, not general Lua habits. **Before writing or editing an applet, read [docs/lua/CLAUDE.md](../../docs/lua/CLAUDE.md)** (core guide), plus [CLAUDE_VEHICLE_CONTROL.md](../../docs/lua/CLAUDE_VEHICLE_CONTROL.md) if it commands the vehicle and [CLAUDE_CRSF_MENU.md](../../docs/lua/CLAUDE_CRSF_MENU.md) if it has a CRSF menu. **[docs/lua/docs.lua](../../docs/lua/docs.lua) is the API source of truth** — never invent a binding; if a signature is uncertain, it's in there.

Wizard-specific conventions on top of the ArduPilot guidance:

- The applet self-arms on a `WIZ_<ID>_ACTIVE` parameter (registered via `param:add_table` / `param:add_param`); the DesktopView drives it via `useLuaEngine().setParam`. While `ACTIVE` is 0 the applet sits dormant with a long `return update, <ms>` interval.
- Progress + results flow desktop-ward as `NAMED_VALUE_FLOAT` (`gcs:send_named_float`) — names are max 10 chars. The DesktopView subscribes via `useLuaEngine().subscribeNamedValue`.
- The applet must tolerate being killed mid-run (operator abort, USB unplug, FC reboot) and return owned params to a sane resting value on its exit path. See WIZARDS.md "Resource discipline".

## Operator-first, always

Per [docs/UX.md](../../docs/UX.md): no parameter names, no MAVLink terms, no acronyms in any operator-facing string. "Smoothing out vibration", not `INS_HNTCH_FREQ`. The wizard decides; the operator confirms — a configuration question inside a wizard is a design smell (see WIZARDS.md anti-patterns).
