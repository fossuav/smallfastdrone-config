# Props-on motor probe applet

The drone measures its own motors. With the props on and the drone flat on
the floor, resting on its arms, it spins one motor at a time in short
pulses from idle, each a step stronger, until that motor's corner lifts.

- **Which way it tips** says where the motor is (the side that went up,
  degrees clockwise from the nose).
- **The yaw twitch** as the motor spins up says which way it turns: the
  rotor kicks the frame the other way.
- **A corner that never lifts**, up to the cap, says its prop is pushing
  down — the wrong prop for that motor, or one on upside down — or that the
  cap is too low for this drone.
- **RPM from the ESCs**, where they report it, gives the throttle each
  motor starts at, and which output it is wired to.

It changes no setting the drone keeps. Design and the reasoning (why the
floor and not a block, why pulses and not a ramp): `docs/BRINGUP.md`,
"Props-on motor measurement", and PLAN decision 48.

## Driving it

The motor-probe wizard (`DesktopView.vue`, expert mode) uploads it, loads
it with a scripting restart, sends a ground-station heartbeat every second,
and sets `MPRB_ACTIVE` to 1. Results come back as NAMED_VALUE_FLOAT:

| Name | Meaning |
|---|---|
| `MP_STATE` | Stage (STAGE in the applet); 9 done, 10 stopped |
| `MP_NMOT`, `MP_MOT`, `MP_THR`, `MP_TILT` | Motor count, current motor, throttle, tilt — live |
| `MP_ABORT` | Why it stopped (ABORT in the applet), 0 if it didn't |
| `Mt START`, `Mt LIFT` | Start and lift throttle for motor test number t (fraction of the full output range; -1 = never) |
| `Mt BRG`, `Mt TILT` | Side that lifted (degrees clockwise from the nose; -1 = never) and how far |
| `Mt YAW` | Degrees the frame turned while the motor spun up; negative = motor turns clockwise |
| `Mt RPM`, `Mt CH` | Peak RPM, and the output it is wired to (1-based; 0 = no telemetry) |

Each motor's results are sent as it finishes and re-sent until
`MPRB_ACTIVE` goes back to 0. Every loop is logged as `MPRB` (motor, stage,
throttle, the three rates less the idle baseline, tilt, bearing, yaw, RPM)
for working out thresholds from bench runs.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `MPRB_ACTIVE` | 0 | Run switch. Forced to 0 when the script loads |
| `MPRB_MODE` | 0 | 0 pulses, 1 one slow ramp (for comparison) |
| `MPRB_PULSE_MS` | 60 | Pulse length |
| `MPRB_STEP` | 0.05 | How much stronger each pulse is |
| `MPRB_CAP` | 0.5 | Strongest pulse or ramp it will ever send |
| `MPRB_LIFT_DEG` | 1.5 | Tilt that counts as the corner lifting |
| `MPRB_ABORT_DEG` | 15 | Tilt at which it stops everything |
| `MPRB_GYRO_HZ` | 60 | Gyro filter cutoff for the run, if higher than the drone's own (held in memory, restored after); 0 leaves it alone |
| `MPRB_REPEATS` | 3 | Lifting pulses to average over |
| `MPRB_RAMP_RATE` | 0.05 | Ramp mode: throttle rise per second |
| `MPRB_LOG` | 1 | Log the run, turning on logging while disarmed for its duration |
| `MPRB_LINK_MS` | 3000 | Stop if the ground station's heartbeat goes quiet this long; 0 off |

Throttles are fractions of the full motor output range, the scale
`MOT_SPIN_ARM` and `MOT_SPIN_MIN` use, sent to the motor test as PWM so a
drone with no receiver yet can still be tested.

## Safety

- The firmware's own motor test does the spinning, re-sent every loop with
  a 0.15 s timeout: if the script stops for any reason, the motor stops by
  itself. Only one motor ever spins.
- It stops everything on a tilt past `MPRB_ABORT_DEG`, a turn past 30°,
  movement while a motor should only be idling, or losing the ground
  station's heartbeat.
- `MPRB_ACTIVE` is forced to 0 when the script loads. A PARAM_SET saves to
  storage, and a probe that restarted itself on the next boot would spin
  props with nobody standing back.

## Testing

On SITL (`bun run lua:check`, and `test/e2e/wizard-motor-probe.spec.ts`)
the whole chain runs, but SITL holds a grounded drone level and its
simulated ESCs report no RPM — so every motor reads "didn't lift" with no
start. Whether a corner lifts, at what power, and whether the yaw twitch
is readable, is settled on the bench.

Changing the number of parameters (`param:add_table`'s count) needs a
reboot, not a scripting restart: ArduPilot keeps a script's parameter
table for the whole boot.
