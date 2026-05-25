# TODO — deferred issues & papercuts

Known issues, rough edges, and follow-ups we've consciously **decided not to
do right now**. This is the holding pen so nothing gets lost between sessions.

How this relates to the other docs:

- **[PLAN.md](PLAN.md)** — the roadmap: phases, decisions, scope. New
  *features* go there, not here.
- **[PROGRESS.md](PROGRESS.md)** — what's true today and the immediate next step.
- **TODO.md** (this file) — deferred *issues*: bugs, tech-debt, papercuts, and
  cleanups discovered along the way that aren't worth interrupting current work
  for. When an item gets scheduled, it graduates to PLAN.md / PROGRESS.md and
  comes off this list. When it's fixed, delete it.

Tags: `[wizard]` `[firmware]` `[3d]` `[tooling]` `[ux]` `[test]` `[infra]`.

---

## Firmware / SITL

- `[firmware]` **Firmware flashing / DFU.** Operators will need to flash SFD
  firmware. Must route through the security uploader seam (`src/security/uploader.ts`)
  — the primary v1 use case for that seam. This is a planned phase in
  [PLAN.md](PLAN.md); listed here so it stays visible until it's scheduled.
- `[firmware]` **PR the `blheli-sitl` SFD branch upstream**, then re-point the
  submodule at the merged commit. Currently the BLHeli-in-SITL support lives on
  a private branch (`vendor/smallfastdrone` @ `blheli-sitl`) that we bumped to
  for direction-correction testing — it needs to land in the SFD beta line.

## 3D / visuals

- `[3d]` **Drop the motor "donuts" in the copter graphic.** The ring indicators
  are redundant once we spin the actual props — let the spinning prop show motor
  state directly instead of an overlaid donut.
- `[3d] [ux]` **Connect screen uses the X-quad graphic, and live orientation.**
  Use the X-quad model on Connect; once connected, drive the model's orientation
  from the live vehicle attitude so it reflects the real copter orientation.
- `[3d]` **Better hex/octo frame models.** Non-quad-X frames use the simpler
  accurate procedural arms model rather than a true geometry-specific 3D model
  (deliberate — accurate beats fudging the X model). Revisit with proper models.

## Wizards / bringup

- `[wizard] [ux]` **Stronger bringup ordering + graphic.** Vertical tabbed
  layout with each step's name + done-state in the tab header; the UI responds
  to solid green completion ticks so progress through the sequence is obvious.
- `[wizard] [ux]` **In-field CRSF menu UX (motor-check).** The radio menu works
  on real hardware — logic validated end-to-end — but the operator flow needs
  polish. From the hardware review: (a) *too much scrolling* — Spin / Moved at /
  Spins / Record+next live in one flat list, so each motor is a scroll
  up-and-down; want a tighter per-motor flow. (b) *status & progress* — the
  single "Now" line isn't enough; show which motor and how far through (e.g.
  3 of 6). (c) *apply & confirm* — the compute → confirm → reboot step needs
  clearer confirmation that the fix landed. Bounded by what CRSF menus can
  render — see [docs/lua/CLAUDE_CRSF_MENU.md](docs/lua/CLAUDE_CRSF_MENU.md).
  (Labels/wording were fine on the TX.) **Agreed direction:** make the "Now"
  line *the workspace* — it shows the live state (e.g. "Motor 3/6 — spin?") and
  the selections update it in place, collapsing the per-motor loop so the
  operator isn't hunting between separate rows (fixes scrolling + progress
  together).
- `[wizard] [ux]` **"You are here" milestone track.** Show the operator where
  they are in the overall journey — configured drone → ready to fly → flying →
  tuned (etc.) — across the bringup sequence, not just per-step.
- `[wizard] [infra]` **UART auto-config.** Detect and assign serial-port
  protocols automatically instead of making the operator hand-map UARTs.
- `[wizard]` **CAN bus toggle.** A drone-settings feature toggle to bring up
  the CAN bus (DroneCAN peripherals — GPS, compass, ESCs…), in the same
  write-param + reboot + reconnect pattern as the scripting toggle.
- _Graduated 2026-05-25 → PROGRESS.md + BRINGUP.md phase 04._ **ESC setup**
  (output protocol + DShot rate + bidirectional DShot) is now scheduled as the
  first phase of the **"Set up motors" wizard** (grown from motor-check). ESC
  *firmware* (BLHeli) settings stay Phase 6 (4-way passthrough).
- `[wizard]` **Force-cal for compass + accel.** Offer a "redo calibration"
  option for compass and accelerometer, shown only when the relevant cal params
  are present on the FC (so it appears only where it can actually act).
  Operator-first copy ("Recalibrate compass"), never param names.

## Shell / UX

- `[ux]` **SFD logo as the favicon.** Use the SmallFastDrone logo as the
  browser-tab icon.
- `[ux]` **Less wordy displays.** Trim inline copy; move help / explanatory
  text into popovers or tooltips rather than paragraphs on the page. Reinforces
  the [docs/UX.md](docs/UX.md) microcopy rules.
- `[ux]` **Notifications: less invasive + actionable.** The bottom-right error
  toasts (FC status warnings + app errors) feel intrusive. Two directions to
  explore: (a) *less invasive* — shorter dwell, quieter styling, or route
  lower-severity messages straight to the nav bell instead of popping a toast;
  (b) *"click to fix"* — when a message has a known remedy, give the toast an
  action that takes the operator to the fix (e.g. a failsafe warning → the
  relevant wizard; "no SD card" → guidance). Builds on the existing
  bell/popover notification surface.

## Tooling

- `[tooling]` **Scaffold applet param-table key collisions.** `new-wizard.sh`'s
  `--lua` stub defaults `PARAM_TABLE_KEY = 0` / prefix `WIZ_`. Fine for a single
  applet, but two installed field applets would collide. Revisit when the
  **scripting-lifecycle-manager** (below) exists, or hand out keys then.
- `[tooling]` **Scripting-lifecycle-manager.** Move scripts between an
  active and a disabled subdirectory as they're enabled/disabled, show a menu of
  installed scripts — all via FTP, without touching the underlying scripting
  infrastructure. Build this once a *second* field script exists (don't
  generalise from one).

---

## Inbox — to triage

<!-- Drop raw items here; we'll tag and file them into the sections above. -->
