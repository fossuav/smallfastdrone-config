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

- _Done 2026-05-27 → PROGRESS.md._ **Firmware flashing / DFU.** Both paths
  landed and are hardware-verified on TBS_LUCID_H7, routed through the security
  uploader seam.
- `[firmware]` **Bench-verify the DFU unlock (read-unprotect).** `DfuClient.readUnprotect()`
  and the recovery tab's unlock disclosure are unit-tested only — there is no
  SITL substitute for DFU, and the path has never been run against a genuinely
  read-protected board. Needs a locked H7 to confirm, including that the
  "success looks like a stall" reading holds on real silicon.
- `[firmware]` **Wider-board hardware coverage for flashing.** Only TBS_LUCID_H7
  has been exercised. MatekH743 / CubeOrange / CubeOrangePlus are wired in
  `board-flash-map.ts` but unverified; non-H7 parts (F4, F7, H723 single-bank)
  haven't been re-tested since the Rev.V workaround landed.
- `[firmware]` **Merge `SmallFastDrone-4.7-config` into the SFD beta line
  eventually, and re-point `.gitmodules`.** The submodule tracks the config
  branch (BLHeli-in-SITL + lua-encryption + the Phase 7 firmware commits) while
  `.gitmodules` `branch` still says `SmallFastDrone-4.7-beta` — only the
  `--remote` hint, but a fresh `git submodule update --remote` would follow the
  wrong branch. Re-point it at the config branch, or at the merge when there
  is one. Operator's call.
- _Done 2026-09-04 -> PROGRESS.md._ **Bench-verify the identity path.** F1–F4 (identity region,
  fixed-key posture, `GENERATE_IDENTITY` / `GET_IDENTITY`) and T1/T2 are
  compile- and unit-verified only; nothing SFD-specific runs in SITL because
  `SECURE_COMMAND` handling exists only in signed builds. Needs a Lucid H7 with
  a signed bootloader + signed SmallFastDronev1 build, then
  `Tools/scripts/signing/sfd_identity.py --generate` and the enable view.
  **Done:** the board was upgraded to a signed SmallFastDronev1 build on a
  signed bootloader, and the identity was generated through the tool's own
  `runEnableCeremony()`. Generate returned UID + public key, a second generate
  was `DENIED`, and a read after reboot returned the same key. What is *not*
  covered: the sector rewrite was never watched under load, and `NO_REGION`
  can no longer be reproduced on this board.
  Also confirms the sector-0 rewrite in `set_identity()` doesn't trip the
  watchdog and that a GET after GENERATE reads the key back from flash.
- `[bug] [firmware] [params]` **`bun run params:rebuild` is broken, so the param
  metadata is frozen before the last submodule bump.** `param_parse.py` exits 4
  with `SIM_FLOW_OFS_X already has field Units`, so the generator never writes a
  new `src/protocol/param-metadata.json` — which is why the metadata still dates
  from `c99beab` even though the submodule was bumped at `ac69ccd`. **Cause is
  an SFD commit**, `4be16989c9` "SITL: add SIM_FLOW_OFS optical flow rate offset
  for fault injection" (`libraries/SITL/SITL.cpp:203`): it documents two
  `@Param:` blocks, `FLOW_OFS_X` and `FLOW_OFS_Y`, above a single
  `AP_GROUPINFO("FLOW_OFS", ...)`. The axis-suffixed idiom is only supported for
  **Vector3** (`AP_Compass`'s `OFS_X/Y/Z` parse fine; `param_parse.py` knows
  `Vector3Parameter` and has no Vector2 equivalent), so with two blocks the
  parser folds them into one param and trips on the repeated `@Units`.
  **Now visible to operators:** on SFD firmware the board reports 1282
  parameters and 8 have no metadata at all — `VALT_POS_EXPO`,
  `EK3_FLOW_GAIN_H`, `EK3_AGL_VD_SPD`, `EK3_AGL_ABIAS_P`, `EK3_FLOW_MIN_H`,
  `LAND_FS_OPTIONS`, `FLTMODE_GCSBLOCK`, `BARO_THST_FILT` — so they render bare
  in the param browser. Fix is in the firmware repo, not here. Separately,
  `BARO_THST_FILT` is a *naming* mismatch rather than a stale one: the tree
  documents it as `@Param: 1_THST_FILT` while `AP_GROUPINFO("_THST_FILT", ...)`
  makes the real name `BARO_THST_FILT`, so the metadata carries
  `BARO1_THST_FILT` and never matches.

  **Now blocking something visible (2026-09-04):** F6 added `BRD_OPTIONS`
  **bit 10**, and the bundled metadata still describes bits 0-9 only, so the
  seal bit renders unlabelled in the param browser — on the very parameter
  whose neighbours are the flash write-protection bits, which is the worst
  place for an unlabelled checkbox. It cannot be fixed here: the generator has
  to run first. The correct idiom for the offending commit is a **single**
  `@Param:` block plus a vector marker, the way `SIM_Ship.cpp` documents
  `OFS` with `@Vector3Parameter: 1` — `param_parse.py` has no Vector2
  equivalent, so `SIM_FLOW_OFS` (a `Vector2f`) needs either that support
  adding or the two blocks collapsing into one.

- _Done 2026-09-04 -> PROGRESS.md._ **The enable ceremony can't tell "no identity yet" from
  "this bootloader can't hold one".** Found on the bench 2026-09-04, and it is
  on the upgrade path rather than off it. A drone running signed SFD firmware
  on a pre-SFD bootloader answers `GET_IDENTITY` with `FAILED` — byte for byte
  what a *blank* identity region answers. `SecureCommandClient.getIdentity()`
  maps that to `null`, which is the ceremony's "no identity yet, generate one"
  signal, so `runEnableCeremony()` generates, the firmware refuses with
  `"Failed to find identity signature"`, and the operator is told "The drone
  couldn't complete the identity operation." Dead end, for a situation with an
  obvious next step: *update this drone's bootloader first*. **Every drone
  upgrading from vanilla sits in exactly this state** between flashing SFD
  firmware and flashing the SFD bootloader. No firmware change is needed to
  **Fixed in the firmware rather than inferred in the tool**, since
  `GET_IDENTITY` is SFD's own command: a failed read now returns a status byte
  (`NOT_SET` / `NO_REGION`) and the ceremony gained a `no-region` reason.
  Firmware commit `6c1efba363` on `SmallFastDrone-4.7-config`; **not yet
  pushed**, so the submodule pin here still points at `630cce8d46`.

- _Done 2026-09-04 → PROGRESS.md._ **Tool can't flash the bootloader.**
  `flashRomfsBootloader()` in `src/workflow/bootloader-update.ts` sends
  `MAV_CMD_FLASH_BOOTLOADER`; bench-verified end to end. **Still no view** —
  it belongs in the enable ceremony (T7), which doesn't exist yet, so for now
  only the bench can drive it.

- `[firmware]` **Identity ops are vendor-private op numbers, not dialect
  entries.** `0x53464401` / `0x53464402` live as C++ constants and as
  `SECURE_OP` in the tool, outside the `SECURE_COMMAND_OP` enum. Fine for the
  tool and `sfd_identity.py`; if SFD ever wants them in MAVProxy or generated
  docs, add them to `ardupilotmega.xml` in the mavlink submodule and switch
  both sides to the enum. Low priority.

- `[ux] [wizard]` **A drone with no storage reports an errno.** A board with no
  microSD (or no mounted filesystem) fails every FTP write under `/` with
  ENOSPC, and that reaches the operator verbatim as
  `FTP CREATE_DIRECTORY failed: FailErrno (errno 28)` — a MAVLink opcode and a
  POSIX errno, breaking the microcopy rule outright. Found on the bench
  2026-09-04. Every Lua wizard depends on this path, so the failure is common
  and the copy should name the cause and the fix ("This drone has no memory
  card…"). The distinction is cheap to make: `@SYS` lists fine on a card-less
  board, so a probe there separates "no card" from "FTP is broken".

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
- _Graduated 2026-05-28 → PROGRESS.md._ **UART auto-config / Connections
  wizard.** Slice 1 has landed: live overview table read from
  `@SYS/uarts.txt` + `SERIALn_PROTOCOL/_BAUD`, surfaced as a "Set up
  connections" tab on the bringup ribbon. Slice 2 (detect-and-propose
  via byte-counter deltas) + slice 3 (per-row protocol editor + apply +
  reboot/reconnect) are queued in PROGRESS.md.
- `[wizard]` **CAN bus toggle.** A drone-settings feature toggle to bring up
  the CAN bus (DroneCAN peripherals — GPS, compass, ESCs…), in the same
  write-param + reboot + reconnect pattern as the scripting toggle.
- _Graduated 2026-05-25 → PROGRESS.md + BRINGUP.md phase 04._ **ESC setup**
  (output protocol + DShot rate + bidirectional DShot) is now scheduled as the
  first phase of the **"Set up motors" wizard** (grown from motor-check). ESC
  *firmware* (BLHeli) settings stay Phase 6 (4-way passthrough).
- `[wizard] [ux]` **Motor-check pre-defaults the expected answer (blind-check
  tradeoff).** On the identify step both the position and direction default to
  what the firmware expects (an operator request — one-click happy path), and
  the 3D highlight follows the selection, so it pre-points at the expected
  motor. The risk: a mis-wired drone is exactly when physical ≠ expected, yet a
  rushing operator can click "Next motor" x4 and pass — the failure the blind
  check existed to catch. Decide whether to keep pre-defaulting but leave the
  *model* neutral until the operator picks, or require an explicit confirm.
  (Surfaced in the 2026-05-25 screenshot UX audit.)
- `[wizard] [ux]` **ESC good-state has two equivalent actions.** When the ESCs
  are already set up well, the phase offers both "Leave as is" and "Continue",
  which do the same thing — redundant. Collapse to one obvious action in the
  already-good state. (UX audit.)
- `[wizard] [ux]` **Frame-select doesn't show the current frame.** "Pick your
  frame" gives no marker for the layout the drone is currently set to, so the
  operator can't see what they already have. Highlight the active frame. (UX
  audit.)
- `[wizard] [ux]` **Pre-flight wizard still shows developer detail.** The
  pre-flight check view displays the firmware git hash and the FC ID — the same
  operator-first leak fixed on the Connect screen (2026-05-25). Apply the same
  expert-gating: keep the firmware *version* (useful pre-flight), hide the hash
  + FC ID outside expert mode. Surfaced when the ribbon prototype mounted
  preflight inline.
- `[wizard] [ux]` **Pre-arm readiness shows in phase 00.** The pre-flight
  view's SystemStatus panel surfaces the pre-arm-checks subsystem + "Not ready
  to arm yet", but arm-readiness is a phase-05 (pre-first-flight) gate, not an
  opening-step concern — a fresh drone can't be arm-ready before it's
  configured (see docs/BRINGUP.md). The opening pre-flight should report
  hardware sanity only; move arm-readiness to the future First-hover-prep
  wizard. (The bringup ribbon's Pre-flight summary already does this.)
- `[wizard] [ux]` **Field-install panel competes with the primary action.** On
  the motor-check safety gate the "Run this at the field (no laptop)" install
  panel sits below — and visually competes with — the primary "Start motor
  check". Collapse it behind a disclosure so the primary action stands alone.
  (UX audit.)
- `[wizard]` **Force-cal for compass + accel.** Offer a "redo calibration"
  option for compass and accelerometer, shown only when the relevant cal params
  are present on the FC (so it appears only where it can actually act).
  Operator-first copy ("Recalibrate compass"), never param names.

## Shell / UX

- _Done 2026-09-04 → PROGRESS.md._ **A post-reboot param reload stalls, and
  the UI then states a wrong value as fact.** Found on the bench 2026-09-04, in the
  scripting toggle's reboot flow. After `autoReconnect()` returns, the
  settings view does `params.clear()` then `params.load()` — and on real
  hardware that load fails: *"Param fetch stalled — got 1 params, then 10s of
  silence"*. The FC is reachable (heartbeat is what ended the reconnect) but
  isn't ready to stream the full set that soon after boot. Two separate
  defects, both invisible on SITL, whose restart is slower and differently
  shaped:
  1. **The reload is sent too early and never retried.** A later load — the
     one the param browser fires on mount — succeeds against the same board
     seconds afterwards, so this is readiness, not a broken link.
  2. **`reconnectAndFinish()` doesn't check `params.error`.** `runLoad`
     catches the failure, leaves `params.value` as the empty map `clear()`
     just installed, and the view sets `phase = 'idle'` regardless. The
     operator is told **"Currently off"** for a setting the drone actually
     holds **on** — a confident wrong answer, which is worse than an error.
     The `onMounted` path already checks `params.error` and degrades to
     `unavailable`; the reconnect path must do the same.

  Reproduced end to end: toggle scripting on → apply → the board persists
  `SCR_ENABLE = 1` (verified over the wire, and the param browser reads 1 from
  the same store) while the settings card reads "Currently off" indefinitely.
  Navigating away and back renders "Currently on" from the now-populated
  store. The backup section is stuck at "Reading your drone's settings…" for
  the same reason. Fixing (1) needs a decision on the retry contract — where
  it lives (the store, `useReconnect`, or the caller) and how many attempts —
  which is why this isn't a drive-by fix.

- `[bug] [ux]` **Connecting permanently rewrites the drone's telemetry rates,
  and they then show up in every backup.** On connect, `session.ts` sends
  `REQUEST_DATA_STREAM(MAV_DATA_STREAM_ALL, 2 Hz)`; ArduPilot doesn't treat
  that as a session preference, it `set_and_save`s it into the `MAVn_*`
  stream-rate parameters. Noticed on the bench 2026-09-04 while returning the
  board to baseline: nine `MAV1_*` parameters had moved from 0 to 2 purely
  because the tool had been connected. Two consequences. The tool leaves a
  persistent mark on a drone just for having been plugged in, which is not
  what "live FC is truth" is meant to license. And since a backup holds
  exactly what differs from factory default, those nine ride along in every
  backup the operator saves — noise they didn't choose, in a document whose
  whole premise is that it holds only their configuration. Decide whether to
  request per-message rates instead (`SET_MESSAGE_INTERVAL`, which is not
  persisted), restore the previous values on disconnect, or exclude `MAVn_*`
  from backups. The first is the honest fix.

- `[test]` **The E2E suite is not idempotent on real hardware.** Under
  `BENCH=1` the specs write to the board and it keeps the writes; SITL starts
  fresh every run, so this never showed. `settings-scripting` needs
  `SCR_ENABLE` to start at 0 and leaves it at 1, so a second run of the same
  spec fails at its first assertion. A whole-suite run also leaves
  `FRAME_CLASS`, `FRAME_TYPE`, `SERIAL1_*` and `RTL_ALT*` changed. We already
  own the fix's ingredients — `param.pck` gives the firmware's own defaults
  and `planRestore` diffs against them — so a bench fixture could snapshot
  before the run and put the board back after.

- `[ux]` **SFD logo as the favicon.** Use the SmallFastDrone logo as the
  browser-tab icon.
- `[ux] [security]` **Field tools: real entitlement + custom upload.** The Pro
  rows (`locked`) and "Add your own applet" (expert) are seams — wire the real
  entitlement check (payment integration) and the custom-applet upload when they
  exist. _Secure-path half graduated 2026-08-27 → PLAN.md Phase 7 +
  [docs/SECURITY.md](docs/SECURITY.md):_ encrypted applet install routes through
  `src/security/uploader.ts` as `kind: 'lua_script'`, and the drone-side
  decryption story is now designed (per-drone identity + ECDH). What's left here
  is the commercial plumbing, not the crypto.
- `[ux]` **Quieten the "Scripting: stopped" toast on restart.** Installing /
  removing a field tool calls `restartScripting()`, which emits a STATUSTEXT
  that surfaces as a red error toast — alarming for a normal, expected restart.
  Suppress or down-rank expected scripting-lifecycle messages (pre-existing;
  more visible now the catalogue installs from one place).
- `[wizard] [ux]` **Embedded wizards' "Back to library" is a misnomer in the
  ribbon.** Mounted in the bringup ribbon, the sub-wizards' own back/cancel/done
  buttons (labelled "Back to library", "Cancel") return to the ribbon (correct
  behaviour via returnTo) but read wrong. When the ribbon graduates from preview
  to primary, give the embedded views context-aware labels (or have the ribbon
  own the back affordance). Also: a post-reconnect SITL re-drop can briefly show
  the ribbon's "connect your drone" prompt — the runner's keep-mounted-across-
  transient-drops robustness would fully fix it (the reboot-in-flight case is
  already handled).
- `[ux]` **Nav exposes not-yet-built sections.** Recipes (and likely Logs /
  Firmware) are top-level nav items that lead to a "Coming soon" dead end.
  Badge them as coming-soon or hide them until they do something, so an
  operator doesn't click into an empty page. (2026-05-25 UX audit.)
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

- `[test]` **Bringup-meta E2E is flaky under SITL load.** `wizard.spec.ts`'s
  "Bringup meta-wizard chains…" test (last + heaviest in the suite, after the
  motor-check specs reboot SITL several times) intermittently times out with a
  connection drop / unrendered sub-wizard — seen ~2 of 5 full runs, passes on
  re-run. Not a product bug (SITL post-reboot instability). Options: give SITL a
  settle/health-check between the reboot-heavy specs, split SITL instances, or
  add a connection-retry guard in the test. Until then it needs a re-run.
- `[tooling]` **Scaffold applet param-table key collisions.** `new-wizard.sh`'s
  `--lua` stub defaults `PARAM_TABLE_KEY = 0` / prefix `WIZ_`. Fine for a single
  applet, but two installed field applets would collide. Revisit when the
  **scripting-lifecycle-manager** (below) exists, or hand out keys then.
- `[infra]` **Bundle size — expert-only data is loaded eagerly.** The build now
  splits `param-metadata.json` (~1.5 MB) and `mavlink-mappings` (~1.2 MB) into
  their own chunks so the entry chunk stays under workbox's 2 MiB precache
  limit (`vite.config.ts` → `build.rollupOptions.output.manualChunks`). Both are
  still *static* imports, so the operator downloads them on first paint even
  though the param blob only feeds the expert param browser. Making
  `getParamMeta` & friends load their blob on demand would cut first-load
  weight, but it makes the accessors async and ripples into `ParamsView.vue`.
  Revisit if first-load time becomes a complaint. Related: the >500 kB
  chunk-size warnings on `tres`, `mavlink-mappings` and `param-metadata` are
  expected noise, not regressions.
- `[test]` **Composables can't be unit-tested.** Anything importing the
  session store fails to load in Vitest's node env with `Package import
  specifier "#imports" is not defined` — Nuxt UI's `useToast` reached from the
  store. That is why `useFirmwareFlash`, `useLuaEngine`, `useConnections` and
  `useSfdEnable` have no unit tests and why pure workflow logic is split into
  its own file (`sfd-enable.ts` vs `use-sfd-enable.ts`). A Vitest alias that
  stubs `#imports` (or moving toast emission out of the store) would unlock
  composable tests against a fake session.
- `[tooling]` **Scripting-lifecycle-manager.** Move scripts between an
  active and a disabled subdirectory as they're enabled/disabled, show a menu of
  installed scripts — all via FTP, without touching the underlying scripting
  infrastructure. Build this once a *second* field script exists (don't
  generalise from one).

---

## Inbox — to triage

<!-- Drop raw items here; we'll tag and file them into the sections above. -->
