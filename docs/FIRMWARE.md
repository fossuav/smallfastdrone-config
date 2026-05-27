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
| `src/protocol/apj.ts` | Parse ArduPilot's `.apj` firmware artifact (JSON + base64-encoded zlib-compressed image). |
| `src/protocol/bootloader.ts` | The ArduPilot custom bootloader protocol — command framing, response parsing, CRC. |
| `src/protocol/bootloader-client.ts` | The sync → board-id confirm → erase → program → verify → reboot sequence on top of the framing primitives. |
| `src/protocol/intel-hex.ts` | Intel-HEX parser for `<vehicle>_with_bl.hex` — the bootloader-plus-firmware artefact used by the DFU fresh-chip path. |
| `src/protocol/board-flash-map.ts` | Board-id → app-flash-offset table for the DFU recovery (.apj) path; the bootloader-path never needs it because the FC bootloader knows its own layout. |
| `src/protocol/dfu.ts` | USB DFU 1.1 + DfuSe protocol primitives — request codes, state/status enums, DfuSe command payload builders (`SET_ADDRESS`, `ERASE_PAGE`, mass erase), descriptor parser, sector-erase planner. |
| `src/protocol/dfu-client.ts` | DfuClient — the ensureIdle → erase sectors → set-address + DNLOAD chunks → manifest sequence on top of the framing primitives. |
| `src/transport/raw-serial.ts` | The `RawSerial` duplex the bootloader client talks to. `MockRawSerial` for unit tests; `PortRawSerial` (via `WebSerialTransport.acquireRaw()`) for production. |
| `src/transport/usb-control.ts` | The `USBControl` interface the DFU client talks to. `MockUSBControl` for unit tests; `WebUsbControl` (via `openDfuDevice()`) for production. |
| `src/transport/webusb.ts` | WebUSB transport — DFU device permission picker, authorised-device polling, claim + control-transfer + close. Production-only (test transport stays WebSocket). |
| `src/security/uploader.ts` | `SignedArtifactUploader` interface — **all firmware upload paths route through it** (CLAUDE.md rule). v1 is passthrough; real signing/encryption lands later. |
| `src/workflow/firmware.ts` | Orchestrator — `flash(apj)` for the bootloader path, `flashDfu(spec, opened)` for the DFU path; both drive the UI's `FlashPhase` + progress. |
| `src/views/FirmwareView.vue` | Operator surface — tabbed "Install over USB" / "Recovery (DFU mode)", file picker (`.apj` everywhere, `.hex` on DFU), parsed metadata, confirm + flash + progress + result. |

## APJ file format

ArduPilot ships firmware as `.apj` — a JSON wrapper:

```json
{
  "board_id": 50,
  "magic": "APJFWv1",
  "description": "Firmware for the CubeOrangePlus board",
  "image": "<base64 of zlib-compressed raw image>",
  "image_size": 1234567,
  "summary": "ArduCopter V4.7.0-beta4-SFD",
  "git_identity": "210fe9473d"
}
```

The parser **validates** the magic, decodes the base64, inflates the
image (ArduPilot's `make_apj.py` uses `zlib.compress(img, 9)` — RFC 1950
zlib wrapper, *not* RFC 1952 gzip — which the Web Compression Streams
spec confusingly calls `'deflate'`; Chromium-only is fine per PLAN
decision 17), and returns the raw image bytes plus the metadata the UI
shows the operator (board id, description, version summary). The parser
does **not** talk to the FC — it only turns a file into bytes + fields.
Board-id matching against the connected FC is the upload orchestrator's
job.

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

## DFU protocol

USB DFU 1.1 (ST AN3156 — the DfuSe extensions for STM32) over WebUSB.
Operator puts the chip in DFU mode physically (BOOT0 button held while
plugging USB); the tool detects a USB device matching the DFU descriptor
(`VID:PID = 0x0483:0xDF11` for STMicro), claims the interface, walks the
standard DFU control transfers plus DfuSe.

### Class requests (everything is a control transfer on the DFU interface)

| Request | Code | Use |
|---|---|---|
| `DETACH` | `0x00` | Leave DFU mode (app → bootloader if applicable). Unused in our flow — we exit by REBOOT-via-manifest. |
| `DNLOAD` | `0x01` | Host → device data. wBlockNum=0 carries a DfuSe command (SET_ADDRESS / ERASE_PAGE); wBlockNum ≥ 2 carries a chunk of data at the auto-incrementing address. |
| `GETSTATUS` | `0x03` | Polled after every DNLOAD; returns `[bStatus, bwPollTimeout LE 24-bit, bState, iString]`. Host must wait the device's pollTimeout before the next op. |
| `CLRSTATUS` | `0x04` | Clear `dfuERROR` back to `dfuIDLE`. |
| `ABORT` | `0x06` | Cancel an in-flight op, return to `dfuIDLE`. |

### DfuSe commands (first byte of a wBlockNum=0 DNLOAD payload)

- `0x21 + addr LE32` — `SET_ADDRESS`. Next data DNLOADs write here +
  `(wBlockNum - 2) * wTransferSize`.
- `0x41 + addr LE32` — `ERASE_PAGE`. Erases the sector at `addr`.
- `0x41` (lone byte) — mass erase. Wipes the bootloader too; only safe
  on the `_with_bl.hex` path.

### Upload sequence

1. Discover the device (VID:PID filter + `requestDevice` permission).
2. Open + claim the DFU interface (class 0xFE / subclass 0x01).
3. Read the DFU functional descriptor for `wTransferSize` (commonly 2048
   on STM32). Read each alt-setting's `iInterface` string and parse the
   DfuSe memory-layout descriptor (`"@Internal Flash /0x08000000/16*128Kg"`).
4. `ensureIdle` — GETSTATUS; if `dfuERROR` then CLRSTATUS; if a download
   state then ABORT.
5. For each sector covered by any region we plan to write: DNLOAD
   ERASE_PAGE + poll until idle.
6. For each region: DNLOAD SET_ADDRESS + poll → DNLOAD data chunks
   (wBlockNum 2, 3, …) + poll between each → next region.
7. Manifest: DNLOAD empty payload at wBlockNum=0 + poll. Some boards
   reset themselves during manifest; we treat a controlOut throw as
   success.

Per-block progress is reported through the `onProgress(fraction)` callback;
the workflow forwards it to the UI's `UProgress` bar.

### Two artefacts, two routes

- **`.apj`** (recovery) — the same `.apj` the bootloader path uses. The
  DFU workflow looks up the board's `appAddress` in
  `board-flash-map.ts` and writes the image as a single region at that
  offset. Leaves the bootloader intact.
- **`_with_bl.hex`** (fresh chip) — Intel HEX with embedded addresses.
  The hex parser produces `{address, data}` segments; the workflow
  writes each as its own DfuSe region. Use this when the bootloader is
  missing / corrupt (a fresh chip, or recovery from a wipe).

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

`FirmwareView` is the home — a tab strip with two paths:

**Install over USB** (default — the bootloader path):

1. **Pick a `.apj`** (operator-supplied file picker). Curated SFD release
   picker (downloads) is a future arc — needs decisions about where SFD
   firmware artifacts live, how versions are listed, and signing.
2. **Parsed metadata shown** — board id (matched against the connected
   FC), description, version summary, image size. The operator confirms
   "Yes, flash this onto my drone."
3. **Confirm + flash** — orchestrator drives reboot-to-bootloader →
   raw takeover → upload → reconnect.
4. **Progress** — phase + percent. CHIP_ERASE has its own
   indeterminate-but-bounded indicator (10s typical, not a stall).
5. **Result** — success → "Done — your drone is running the new
   firmware" + the session auto-reconnects; failure → the clear-cause
   operator copy from `docs/UX.md`.

**Recovery (DFU mode)** (the safety-net path):

1. **Instructions** — illustrated 4-step "unplug → hold BOOT → plug back
   in → release" sequence. Operator-readable, no jargon.
2. **Pick a file** — accepts `.apj` (recovery) **or** `.hex` (fresh
   chip). Metadata pane shows the parsed file's shape (board for `.apj`;
   address span + segment count for `.hex`).
3. **Find DFU device** — operator clicks the button (a user gesture is
   required by WebUSB) to grant the page permission to talk to STMicro
   DFU devices. Authorised devices are then polled every 2s — appearing
   in the list as soon as the chip enumerates.
4. **Install in DFU mode** per row — flashDfu runs erase → set-address +
   DNLOAD chunks → manifest. Same `UProgress` bar as the USB path.
5. **Result** — "Done. Unplug + replug your drone to start it."
   (DFU detach is finicky on some boards; a clean replug is the
   reliable exit.)

Bringup integration (a "Firmware" ribbon tab as the first area, so
fresh-install → preflight → frame → motors flows in one place) is a
deliberate **second slice** — keep the first slice focused on the
standalone FirmwareView so the protocol + UX iterate on their own.

## Testing

SITL has no bootloader and no DFU. Coverage breakdown:

- **Unit tests** at the protocol layer: APJ parse (synthetic .apj
  fixtures), bootloader command/response framing + CRC, Intel HEX parse
  (synthetic records + every operator-readable error path), DFU framing
  + descriptor parser + sector-erase planner, BootloaderClient against
  `MockRawSerial`, DfuClient against `MockUSBControl`. These are the
  layers where things historically go wrong (off-by-one in framing,
  wrong CRC polynomial, sector-overlap maths); they're fully
  unit-testable.
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
- Bringup ribbon "Firmware" tab (so fresh-install → preflight → frame →
  motors flows in one place).
- Real signing/encryption in the security uploader seam.
- Bench-hardware CI rig.
- Programmatic DFU entry (`MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` variants
  on supported boards) as a faster alternative to the manual BOOT-button
  step.
- Board-flash-map coverage for non-H7 SFD targets, once they exist
  (until then, the `_with_bl.hex` path is the universal escape hatch).
