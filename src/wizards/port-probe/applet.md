# Port probe applet

Finds out what's plugged into each serial port by listening. Every port
whose role is Scripting (`SERIALn_PROTOCOL` 28) is listened to at once,
cycling through baud rates, and each device is recognised by its frames —
checksums included, so line noise at the wrong baud can't pass for a
device. Design and the reasoning: `docs/BRINGUP.md`, "Finding what's
plugged in", and PLAN decision 49.

| Recognised | How | At |
|---|---|---|
| ELRS / Crossfire receiver | Frames to the flight controller (`0xC8`), CRC-8/DVB-S2 | 420000, 416666, 115200 |
| Ghost receiver | Frames to the flight controller (`0x82`), CRC-8/DVB-S2 | 420000, 416666, 115200 |
| FlySky iBUS receiver | 32-byte `0x20 0x40` frames, 16-bit checksum | 420000, 416666, 115200 |
| GPS (NMEA) | `$…*hh` sentences, XOR checksum | 9600 – 460800 |
| GPS (u-blox) | `0xB5 0x62` frames, Fletcher checksum | 9600 – 460800 |

Two valid frames make a device. A receiver is only looked for at receiver
rates and a GPS only at GPS rates — on SITL, where baud means nothing, a GPS
would otherwise be "found" at 420000.

A script can't set a port's inversion or single-wire mode, so SBUS,
SmartAudio, Tramp and FPort aren't seen here; ArduPilot's own drivers are
the second pass for those.

## Driving it

The port-probe wizard (`DesktopView.vue`, expert mode) notes every port's
role, uploads this applet, sets the chosen ports to Scripting (and turns
scripting on if it was off), restarts the drone, and sets `PPRB_ACTIVE`
to 1. It then sets each port's role from the results, puts back every port
where nothing was found, and restarts again.

| Name | Meaning |
|---|---|
| `PP_STATE` | 0 off, 1 listening, 2 done |
| `PP_NPORT` | Ports being listened on |
| `Sn TRY` | The baud port n is being listened at (while listening) |
| `Sn FOUND` | What port n has: 0 nothing, 1 traffic not recognised, 2 ELRS / Crossfire, 3 Ghost, 4 iBUS, 5 GPS (NMEA), 6 GPS (u-blox) |
| `Sn BAUD` | The baud it was found at; 0 if nothing was |
| `Sn BYTES` | The most bytes heard in one listen |

Results are re-sent until `PPRB_ACTIVE` goes back to 0. Each listen is
logged as `PPRB` (port, baud, bytes heard, what was found; 255 for
nothing).

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `PPRB_ACTIVE` | 0 | Run switch. Forced to 0 when the script loads |
| `PPRB_DWELL_MS` | 1200 | How long to listen at each baud. A GPS often sends once a second, so under a second can miss it |
| `PPRB_LOG` | 1 | Log each listen |

## Limits

- A script may only spend so many instructions in one go, so the CRC table
  is built a few entries a loop while dormant, and at most one finished
  listen is analysed per loop.
- Bytes in the first 30 ms after a baud change are dropped: they're
  half-frames from the last rate.
- It only listens. Nothing it does changes a setting, so it needs no
  ground-station watchdog; the desktop owns every role change.

## Testing

`scripts/sitl-start.sh` puts a simulated ELRS / Crossfire receiver on
SERIAL5, and SITL's simulated GPS is on SERIAL3, so both detections run on
SITL (`test/e2e/wizard-port-probe.spec.ts`). Real receivers, GPS units at
their own rates, and everything else are a bench question.
