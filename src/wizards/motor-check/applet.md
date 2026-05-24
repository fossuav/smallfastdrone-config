# Motor check — in-field CRSF applet

The no-laptop version of the motor-check wizard. It runs on the flight
controller and is driven entirely from the radio's CRSF (Crossfire) menu,
so an operator can verify and fix motor order + direction at the field
after a crash repair or motor swap — no laptop, no MAVLink.

This is the Lua/CRSF counterpart to the desktop motor-check wizard
(`DesktopView.vue`). The two share the same idea and the same correction
maths; keep the Lua `compute_corrections` in `applet.lua` in step with the
unit-tested TypeScript `computeCorrections` in
`src/workflow/motor-check.ts`.

## Files

Both must be installed on the FC (the tool uploads them):

- `applet.lua` → `scripts/applet.lua`
- `crsf_helper.lua` → `scripts/modules/crsf_helper.lua` (the firmware's
  standard CRSF menu helper; `require`'d by the applet, not present in
  SITL's ROMFS, so it ships alongside)

Scripting must be enabled (`SCR_ENABLE = 1`); the tool's Drone-settings
page owns that.

## Menu flow (props OFF)

A single "Motor check" menu on the transmitter:

| Item | Type | Action |
|---|---|---|
| Safety | info | "PROPS OFF first" |
| Now | info | Which motor you're on, e.g. "Motor 3 (3/6)" |
| Spin motor | command | Spins the current motor (`MAV_CMD_DO_MOTOR_TEST` via `gcs:run_command_int`) |
| Moved at | selection | Which position physically moved (the frame's positions) |
| Spins | selection | CW / CCW |
| Record + next | command | Records this motor's answer and advances |
| Apply fix | command | Computes the fix, asks for confirmation, writes it, reboots |

Spinning uses the firmware's motor-test path, so it inherits the firmware's
safety gating (landed, safety switch off, disarmed). **Apply fix** is gated
on the vehicle being disarmed and is behind a CRSF confirm step before it
writes `SERVOn_FUNCTION` (motor order) / `SERVO_BLH_RVMASK` (direction) and
reboots.

## Frames

Quad / hexa / octa, X and + (same set as the desktop wizard). Direction
reversal needs `SERVO_BLH_RVMASK`; on builds without it the applet applies
the order remap and reports that direction must be fixed by hand.

## Testing

The menu interaction rides the CRSF radio link, which SITL has no
transmitter for, so the menu flow is **hardware-verified**. What is
verified in SITL: the applet loads and registers the menu without error,
and the `run_command_int` motor-test path spins a motor. The correction
maths is covered by the TypeScript unit tests it mirrors.
