# Firmware install

How SmallFastDrone firmware lands on the flight controller from this tool.
Two upload paths, one security seam.

## Two paths, two use cases

- **Via the bootloader** (over the existing USB-serial link, no DFU mode) —
  the **daily-driver upgrade**. Plug in, "Update firmware", FC reboots into
  its custom bootloader, the tool uploads the firmware via the bootloader's
  binary protocol on the same port. What Mission Planner does. ~99% of
  upgrades, including the operator-flow we want for "fresh install during
  bringup".
- **Via DFU** (WebUSB, STM32 DFU class) — the **recovery / fresh-chip /
  bricked-firmware fallback**. Operator puts the chip in DFU mode (BOOT0
  button, jumper, or — on supported boards — a magic `MAV_CMD`), tool
  flashes via WebUSB. Universal: works with no firmware running. Needed
  for blank chips and as a recovery path when MAVLink isn't talking.

The bootloader path is the front door. DFU is the safety net.

## Architectural pieces

| Module | Role |
|---|---|
| `src/protocol/apj.ts` | Parse ArduPilot's `.apj` firmware artifact (JSON + base64-encoded gzipped image). |
| `src/protocol/bootloader.ts` | The ArduPilot custom bootloader protocol — command framing, response parsing, CRC. |
| `src/protocol/dfu.ts` *(Phase 5 follow-on)* | STM32 DFU class — descriptors, GET_STATUS / DNLOAD / UPLOAD, ST DFUSE extensions for sector erase + address pointer. |
| `src/transport/webusb.ts` *(Phase 5 follow-on)* | WebUSB transport — device claim, interface select, endpoints. Production-only (test transport stays WebSocket). |
| `src/security/uploader.ts` *(Phase 5)* | `SignedArtifactUploader` interface — **all firmware upload paths route through it** (CLAUDE.md rule). v1 is passthrough; real signing/encryption lands later. |
| `src/workflow/firmware.ts` *(Phase 5)* | Orchestrator — picks bootloader vs DFU, runs the chosen path, drives the UI through progress states. |
| `src/views/FirmwareView.vue` *(Phase 5)* | Operator surface — file picker, parsed firmware metadata (board id, description, version), confirm + flash + progress + result. |

## APJ file format

ArduPilot ships firmware as `.apj` — a JSON wrapper:

```json
{
  "board_id": 50,
  "magic": "APJFWv1",
  "description": "Firmware for the CubeOrangePlus board",
  "image": "<base64 of gzipped raw image>",
  "image_size": 1234567,
  "summary": "ArduCopter V4.7.0-beta4-SFD",
  "git_identity": "210fe9473d"
}
```

The parser **validates** the magic, decodes the base64, gunzips the image
(via the browser's `DecompressionStream('gzip')` — Chromium-only is fine
per PLAN decision 17), and returns the raw image bytes plus the metadata
the UI shows the operator (board id, description, version summary). The
parser does **not** talk to the FC — it only turns a file into bytes +
fields. Board-id matching against the connected FC is the upload
orchestrator's job.

## Bootloader protocol

ArduPilot's custom bootloader (`Tools/AP_Bootloader/`, mirroring PX4's)
speaks a small binary protocol on the same UART/USB-serial the firmware
uses. Reference: `Tools/scripts/uploader.py` in the firmware repo.

Commands are single bytes + payload + `EOC (0x20)`. Responses arrive as
`INSYNC (0x12)` then a status byte: `OK (0x10)`, `FAILED (0x11)`,
`INVALID (0x13)`, etc.

| Command | Code | Use |
|---|---|---|
| `GET_SYNC` | `0x21` | Sync — first thing the tool sends; bootloader replies `INSYNC+OK`. |
| `GET_DEVICE` | `0x22` | Get an info word: board id, board rev, flash size, vec area. Param byte selects which. |
| `CHIP_ERASE` | `0x23` | Erase the whole user-flash region. Slow (~10s on a large board). |
| `PROG_MULTI` | `0x27` | Write a block of up to ~252 bytes at the current address. |
| `GET_CRC` | `0x29` | Bootloader computes CRC over the full flash region; tool compares against its own CRC of the image padded to the erase boundary. |
| `REBOOT` | `0x30` | Tell the bootloader to leave and run the firmware. No reply expected. |

Upload sequence:

1. Tell the running ArduPilot to reboot to bootloader (`MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` param1=3).
2. Disconnect the MAVLink session; the serial port disappears as the FC enumerates back as the bootloader.
3. Reopen the port at the bootloader's baud (115200 by default).
4. `GET_SYNC` → expect `INSYNC+OK`.
5. `GET_DEVICE` info=board_id → confirm matches `apj.boardId` (refuse to flash a mismatched board).
6. `GET_DEVICE` info=flash_size → sanity-check image fits.
7. `CHIP_ERASE` → wait for `INSYNC+OK` with a long timeout.
8. For each 252-byte slice of the image: `PROG_MULTI len data EOC` → `INSYNC+OK`. Surface progress %.
9. `GET_CRC` → compare against the tool's CRC of the (padded) image. Mismatch = abort, surface a clear error.
10. `REBOOT` → port closes; the new firmware starts; the session-level auto-reconnect picks it back up.

Each round-trip needs a per-command timeout. Slow ones (CHIP_ERASE, GET_CRC) need notably longer (~20s); the rest are fast.

## DFU protocol (follow-on)

STM32 DFU class (ST AN3156) over WebUSB. Operator puts the chip in DFU
mode physically (BOOT0); the tool detects a USB device matching the DFU
descriptor, claims the interface, walks the standard DFU control
transfers (GET_STATUS, DNLOAD, UPLOAD, GETSTATE, CLRSTATUS, ABORT) plus
the ST DFUSE extensions (sector erase, set-address-pointer) to flash a
.bin or .hex image at the right offsets. Reference:
`betaflight-configurator/src/js/protocols/dfu.js` is the canonical
copy-and-adapt source.

DFU is independent of the running firmware and works on a blank chip, so
this is the path for fresh boards, brick recovery, and any case where the
bootloader path can't make sync.

## Security uploader seam

Per CLAUDE.md, **all artifact uploads route through
`src/security/uploader.ts`** — bootloader-path firmware upload, DFU-path
firmware upload, future Lua applet uploads. v1 is a passthrough that just
forwards to the protocol layer; future v's interpose signature
verification and (where applicable) decryption. The interface is the
seam; the implementation is what evolves.

## UI flow

`FirmwareView` is the home. v1 surface:

1. **Pick a .apj** (operator-supplied file picker). Curated SFD release
   picker (downloads) is a future arc — needs decisions about where SFD
   firmware artifacts live, how versions are listed, and signing.
2. **Parsed metadata shown** — board id (matched against the connected
   FC), description, version summary, image size. The operator confirms
   "Yes, flash this onto my drone."
3. **Confirm + flash** — the orchestrator picks the path. Default is the
   bootloader path; DFU is offered when the bootloader path can't make
   sync, or as an opt-in "Recovery / fresh chip" alternative.
4. **Progress** — phase + percent. CHIP_ERASE has its own
   indeterminate-but-bounded indicator (10s typical, not a stall).
5. **Result** — success → "Firmware installed, drone restarting" + the
   session-level auto-reconnect rejoins the new firmware; failure → the
   clear-cause operator copy from `docs/UX.md`.

Bringup integration (a "Firmware" ribbon tab as the first area, so
fresh-install → preflight → frame → motors flows in one place) is a
deliberate **second slice** — keep the first slice focused on the
standalone FirmwareView so the protocol + UX iterate on their own.

## Testing

SITL has no bootloader and no DFU. Coverage breakdown:

- **Unit tests** at the protocol layer: APJ parse (synthetic .apj
  fixtures), bootloader command/response framing, CRC computation. These
  are the layers where things historically go wrong (off-by-one in
  framing, wrong CRC polynomial); they're fully unit-testable.
- **Bench-hardware verification** for the integrated flash: documented
  procedure (which board, which firmware, expected timings, expected
  result), run by hand. Same posture as the CRSF-menu hardware
  verification (no SITL substitute exists for the radio either). Until
  there's a hardware-in-the-loop CI rig, this is the truthful coverage
  level.
- **No SITL E2E** — `wizard.spec.ts` and friends touch the connect /
  config / wizard flows; firmware-flash specs would need a SITL
  bootloader, which doesn't exist.

## Open follow-ons (after v1)

- Curated SFD release picker (downloads from a hosted artifact source).
- DFU implementation.
- Bringup ribbon "Firmware" tab.
- Real signing/encryption in the security uploader seam.
- Bench-hardware CI rig.
