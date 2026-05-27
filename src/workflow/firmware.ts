/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// Firmware-install workflow — orchestrates the upload from operator
// click to "drone is back on the new firmware". Wraps the pure layers
// (apj parser, hex parser, bootloader / DFU protocols) and drives the
// transport choreography for each of the two paths:
//
//   - Bootloader path (`flash(apj)`): MAVLink reboot-to-bootloader →
//     WebSerial raw takeover → upload → release → MAVLink reconnect.
//     Works on a live, MAVLink-connected drone. Carries .apj only.
//
//   - DFU path (`flashDfu(spec)`): operator puts the drone in DFU mode
//     by hand → we open a WebUSB DFU device → read its memory layout
//     → erase covering sectors → DfuSe-write each region → manifest.
//     Works on a bricked / fresh / non-bootable drone. Carries .apj
//     (recovery — we look up the board's app address) or .hex (fresh
//     chip — addresses embedded in the file).
//
// Both routes push their bytes through the security uploader seam so a
// future signing / decryption interpose has the call site already
// correct. See docs/FIRMWARE.md.

import type { ApjFirmware } from '../protocol/apj'
import type { DfuPhase, DfuWriteRegion } from '../protocol/dfu-client'
import type { ParsedHex } from '../protocol/intel-hex'
import type { WebSerialTransport } from '../transport/webserial'
import type { OpenedDfuDevice } from '../transport/webusb'
import { ref } from 'vue'
import { lookupBoardFlash } from '../protocol/board-flash-map'
import { BootloaderClient } from '../protocol/bootloader-client'
import {
  combineFlashLayouts,
  describeMemoryLayouts,
  parseDfuseLayout,
  planSectorErase,
  regionCoveredBySectors,
} from '../protocol/dfu'
import { DfuClient } from '../protocol/dfu-client'
import { defaultUploader } from '../security/uploader'
import { useSessionStore } from '../stores/session'
import {
  findRememberedBootloaderPort,
  rememberBootloaderPort,
} from './bootloader-port-memory'

// Operator-facing phase labels — what's happening right now. Drives the
// UI's status copy. 'idle' = ready / not running; 'done' = success;
// 'error' = stopped, see `error`.
export type FlashPhase
  = | 'idle'
    | 'rebooting-to-bootloader' //  bootloader path: sent MAVLink reboot
    | 'awaiting-bootloader-port' // bootloader path: bootloader is a different
    //                              USB device (different VID:PID) than the
    //                              firmware on most boards, and the browser
    //                              hasn't seen it yet — operator needs to
    //                              pick it once. UI shows a picker button
    //                              that calls `provideBootloaderPort()`.
    | 'syncing' //                  bootloader path: GET_SYNC retries
    | 'verifying-board' //          bootloader path: GET_DEVICE check
    | 'erasing' //                  CHIP_ERASE (bootloader) / sector-erase (DFU)
    | 'programming' //              PROG_MULTI loop / DNLOAD chunks
    | 'verifying' //                bootloader path: GET_CRC
    | 'restarting' //               REBOOT (bootloader) / manifest (DFU)
    | 'reconnecting' //             bootloader path: MAVLink reconnect
    | 'done'
    | 'error'

// How long to wait after sending the MAVLink reboot-to-bootloader
// command before we surface the picker. The FC needs a moment to act
// on the command, close USB, and re-enumerate as the bootloader.
// openPortRaw() additionally retries port.open() until the device
// comes back, but this initial pause keeps the bootloader visible in
// the picker dialog when the operator clicks.
const POST_REBOOT_SETTLE_MS = 1_500

// After the bootloader REBOOT, the device disappears again and comes
// back as the running firmware. Wait briefly before we start polling
// for the firmware port — gives the USB stack time to enumerate the
// new device.
const POST_FLASH_SETTLE_MS = 2_000

// How long we wait for the firmware port to come back online after
// the bootloader REBOOT command. On most boards this is < 3s; we give
// it 15s of polling before declaring the auto-reconnect lost. If the
// timeout fires the firmware is still installed — the operator just
// needs to reconnect manually from the Connect screen.
const FIRMWARE_RECONNECT_TIMEOUT_MS = 15_000
const FIRMWARE_RECONNECT_POLL_MS = 250

// What the DFU path takes as input. The UI sends one of these depending
// on what file the operator picked. We keep `apj` and `hex` as separate
// discriminated variants so the workflow can give precise errors
// ("we don't have a flash map for board 7 — try the `_with_bl.hex`
// artefact instead").
export type DfuFlashSpec
  = | { kind: 'apj', apj: ApjFirmware }
    | { kind: 'hex', hex: ParsedHex, filename: string }

// How aggressive to be with erase. The default depends on file kind
// (mass for .hex, sectors for .apj), but the operator can override —
// see `recommendedEraseStrategy()`.
//   - 'mass'    → DfuSe MASS_ERASE (one command, wipes the whole chip).
//                 Faster, but loses anything outside the write regions
//                 (param storage, the bootloader for .apj, etc.).
//   - 'sectors' → walk the regions and erase only sectors that overlap.
//                 Slower (and may hit dual-bank H7 quirks across
//                 0x08100000), but preserves untouched flash like the
//                 param-storage area at the end of the chip.
export type EraseStrategy = 'mass' | 'sectors'

// Default erase strategy for any file kind: per-sector. Friendlier to
// operators (preserves saved settings + bootloader on `.apj`) and
// now reliable on dual-bank H7 thanks to the STM32H7 Rev.V silicon-
// errata workaround in DfuClient.erasePage. The operator can flip the
// "Wipe whole chip" switch when they want a clean slate. Function
// signature keeps the file-kind parameter for future-proofing — if a
// chip turns out to genuinely need mass-erase by default we can branch
// here without changing the orchestrator + view call sites.
export function recommendedEraseStrategy(_specKind: DfuFlashSpec['kind']): EraseStrategy {
  return 'sectors'
}

export interface DfuFlashOptions {
  // Override the default erase strategy for this run. Omit to use
  // `recommendedEraseStrategy(spec.kind)`.
  eraseStrategy?: EraseStrategy
}

export function useFirmwareFlash() {
  const session = useSessionStore()

  const phase = ref<FlashPhase>('idle')
  // 0..1 during 'programming' — driven by the protocol layer's per-block
  // callback. Otherwise undefined (the UI hides the bar).
  const progress = ref<number | null>(null)
  const error = ref<string | null>(null)
  // True after a `done` flash when the bootloader's pre-flash CRC
  // matched the image — i.e. nothing was actually written, just a
  // REBOOT. UI uses this to swap the 'done' copy from "running the
  // new firmware" to "already up to date".
  const wasSkipped = ref(false)

  // Set while the workflow is paused at 'awaiting-bootloader-port'. The
  // UI shows a picker button whose click handler calls
  // `provideBootloaderPort(port)` with the port the operator just
  // selected (or `cancelBootloaderPick()` to abort). `requestPort()`
  // *must* run inside that user gesture; we can't drive the picker
  // ourselves from inside this async chain.
  let portResolver: ((port: SerialPort) => void) | null = null
  let portRejecter: ((err: Error) => void) | null = null

  function reset() {
    phase.value = 'idle'
    progress.value = null
    error.value = null
    wasSkipped.value = false
  }

  function assertIdle() {
    if (phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'error')
      throw new Error('A firmware flash is already in progress.')
  }

  // Called by the UI after the operator picks the bootloader port from
  // navigator.serial.requestPort(). Resumes the paused flash. No-op if
  // we're not currently awaiting a port.
  function provideBootloaderPort(port: SerialPort): void {
    portResolver?.(port)
    portResolver = null
    portRejecter = null
  }

  // Called by the UI's Cancel button when the operator backs out of the
  // bootloader-port pick. Aborts the flash with a friendly error.
  function cancelBootloaderPick(): void {
    portRejecter?.(new Error('Cancelled — bootloader port not picked.'))
    portResolver = null
    portRejecter = null
  }

  // After the bootloader REBOOT command, poll for the firmware port to
  // come back online. We prefer the original SerialPort instance the
  // MAVLink session was using (browsers maintain identity across
  // device-disappear / reappear); falling back to any newly-connected
  // authorised port that isn't currently the bootloader. Returns null
  // if nothing plausible shows up within the deadline — the firmware
  // is installed regardless, the operator just needs to reconnect by
  // hand.
  async function waitForFirmwarePort(
    originalPort: SerialPort | null,
    deadlineMs: number,
  ): Promise<SerialPort | null> {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      if (originalPort && originalPort.connected)
        return originalPort
      // Fall back to any other connected authorised port — handles the
      // (rare) case where the firmware comes up as a different
      // SerialPort identity than the bootloader-mode session.
      const ports = await navigator.serial.getPorts()
      for (const p of ports) {
        if (p.connected && p !== originalPort)
          return p
      }
      await sleep(FIRMWARE_RECONNECT_POLL_MS)
    }
    return null
  }

  // Run the bootloader-path firmware upload end-to-end. Throws on any
  // failure; the caller's UI reads `phase` / `progress` / `error`.
  async function flash(apj: ApjFirmware): Promise<void> {
    assertIdle()

    // The bootloader path requires raw access to the serial port. Test
    // transports (WebSocket) don't have that — refuse early.
    if (session.transport.kind !== 'webserial') {
      throw new Error('Firmware flashing requires a USB-serial connection (not the SITL bridge).')
    }
    // Type-assert: we've checked .kind.
    const transport = session.transport as WebSerialTransport

    error.value = null
    progress.value = null
    wasSkipped.value = false

    try {
      // 1. Capture the firmware port so we can reattach to it after
      //    the bootloader REBOOT — `port.open()` on an already-
      //    authorised port needs no user gesture, unlike
      //    `requestPort()`, so we can auto-reconnect without staring
      //    down "Must be handling a user gesture" once the flash is
      //    done.
      const firmwarePort = transport.currentPort()
      const firmwareInfo = firmwarePort?.getInfo() ?? null

      // 2. Tell the FC to reboot into its bootloader (MAVLink command
      //    on the still-open MAVLink session).
      phase.value = 'rebooting-to-bootloader'
      await session.rebootToBootloader()

      // 3. Cancel the MAVLink reader + close the firmware port. The
      //    bootloader will (or already has) come up on a different
      //    USB device than the firmware on most STM32 ArduPilot boards.
      await transport.detachMavlink()
      await sleep(POST_REBOOT_SETTLE_MS)

      // 4. Try the remembered bootloader port for this firmware board
      //    first — once the operator has picked it for this VID:PID
      //    of firmware port, we save the pairing and skip the picker
      //    on every subsequent flash. If there's no remembered port,
      //    or the remembered port isn't connected right now, fall
      //    back to surfacing the picker.
      let bootloaderPort: SerialPort | null = null
      if (firmwareInfo) {
        const ports = await navigator.serial.getPorts()
        bootloaderPort = findRememberedBootloaderPort(firmwareInfo, ports)
      }
      if (!bootloaderPort) {
        phase.value = 'awaiting-bootloader-port'
        bootloaderPort = await new Promise<SerialPort>((resolve, reject) => {
          portResolver = resolve
          portRejecter = reject
        })
        // Operator picked one — remember it so the next flash to this
        // board doesn't need the picker. (Only remember when we have
        // a firmware port to key on; the recovery path doesn't.)
        if (firmwareInfo)
          rememberBootloaderPort(firmwareInfo, bootloaderPort.getInfo())
      }

      // 5. Open the bootloader port at bootloader baud.
      phase.value = 'syncing'
      const raw = await transport.openPortRaw(bootloaderPort, {
        baudRate: 115_200,
        settleDelayMs: 0,
      })
      const client = new BootloaderClient(raw)

      try {
        // 6. Run the upload through the security uploader seam. The
        //    seam (currently passthrough) is the chokepoint every
        //    artifact upload goes through; the per-byte work is the
        //    transport callback below.
        await defaultUploader.upload(
          { kind: 'firmware', name: apj.summary ?? apj.description, bytes: apj.image },
          {
            runUpload: async (bytes, onProgress) => {
              const result = await client.flash(
                bytes,
                apj.boardId,
                (p) => { phase.value = p },
                (fraction) => {
                  progress.value = fraction
                  onProgress?.(fraction)
                },
              )
              wasSkipped.value = result.skipped
            },
          },
        )
      }
      finally {
        // Always release the port — even if the upload threw — so the
        // MAVLink reconnect below isn't blocked by a dangling reader.
        await raw.close()
      }

      // 7. Bootloader has been told to reboot. Wait for the firmware
      //    port to come back online, then reattach silently — no
      //    `requestPort()` gesture trap, no manual reconnect step.
      //    If the firmware port can't be found within the timeout the
      //    flash itself still succeeded; we just leave the operator
      //    to reconnect from the Connect screen.
      phase.value = 'reconnecting'
      await sleep(POST_FLASH_SETTLE_MS)
      const reconnected = await waitForFirmwarePort(firmwarePort, FIRMWARE_RECONNECT_TIMEOUT_MS)
      if (reconnected) {
        await session.attachToPort(reconnected)
      }

      phase.value = 'done'
      progress.value = 1
    }
    catch (e) {
      phase.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  // Recovery flash: the FC is *already* in bootloader mode (typically
  // after a failed firmware install left the bootloader running) and
  // MAVLink isn't reachable. The operator picks the bootloader port
  // themselves — inside their click gesture — and hands it here, so
  // we skip the MAVLink reboot dance and go straight to GET_SYNC.
  // Same bootloader protocol as `flash()` post-reboot; the same-CRC
  // skip inside BootloaderClient.flash protects against re-flashing
  // the same firmware unnecessarily.
  async function flashViaBootloaderPort(
    apj: ApjFirmware,
    bootloaderPort: SerialPort,
  ): Promise<void> {
    assertIdle()

    if (session.transport.kind !== 'webserial') {
      throw new Error('Firmware flashing requires a USB-serial connection (not the SITL bridge).')
    }
    const transport = session.transport as WebSerialTransport

    error.value = null
    progress.value = null
    wasSkipped.value = false

    try {
      // Detach any live MAVLink session — though typically there isn't
      // one if the operator is on this recovery path. The
      // currentPort() snapshot lets us auto-reconnect to the firmware
      // port after the flash, just like the normal path.
      const firmwarePort = transport.currentPort()
      const firmwareInfo = firmwarePort?.getInfo() ?? null
      if (firmwarePort)
        await transport.detachMavlink()

      phase.value = 'syncing'
      const raw = await transport.openPortRaw(bootloaderPort, {
        baudRate: 115_200,
        settleDelayMs: 0,
      })
      const client = new BootloaderClient(raw)

      try {
        await defaultUploader.upload(
          { kind: 'firmware', name: apj.summary ?? apj.description, bytes: apj.image },
          {
            runUpload: async (bytes, onProgress) => {
              const result = await client.flash(
                bytes,
                apj.boardId,
                (p) => { phase.value = p },
                (fraction) => {
                  progress.value = fraction
                  onProgress?.(fraction)
                },
              )
              wasSkipped.value = result.skipped
            },
          },
        )
      }
      finally {
        await raw.close()
      }

      // Remember the bootloader port pairing if we have a firmware
      // port to key on — so on a future normal-path flash for this
      // board we can auto-pick. (No firmware port = the operator was
      // on the recovery path with nothing previously connected; we
      // can't pair without a key.)
      if (firmwareInfo)
        rememberBootloaderPort(firmwareInfo, bootloaderPort.getInfo())

      // Best-effort auto-reconnect — same as the normal path, but the
      // "original firmware port" is whatever we captured before
      // detaching (might be null if no MAVLink session was ever
      // established on this page load, in which case waitForFirmwarePort
      // falls back to "any newly-connected port").
      phase.value = 'reconnecting'
      await sleep(POST_FLASH_SETTLE_MS)
      const reconnected = await waitForFirmwarePort(firmwarePort, FIRMWARE_RECONNECT_TIMEOUT_MS)
      if (reconnected)
        await session.attachToPort(reconnected)

      phase.value = 'done'
      progress.value = 1
    }
    catch (e) {
      phase.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  // Run the DFU-path firmware upload end-to-end. Caller passes the
  // already-opened DFU device (the UI runs the device picker / wait
  // flow itself, inside the user gesture). We close the device once
  // we're done (or on error) — the operator unplugs + re-plugs to
  // return to normal mode.
  async function flashDfu(
    spec: DfuFlashSpec,
    opened: OpenedDfuDevice,
    options: DfuFlashOptions = {},
  ): Promise<void> {
    assertIdle()
    error.value = null
    progress.value = null

    try {
      // 1. Plan: turn the input into a list of write regions + the
      //    operator-meaningful name + bytes for the security seam.
      const regions: DfuWriteRegion[] = []
      let totalBytes = 0
      let name: string
      if (spec.kind === 'apj') {
        const layout = lookupBoardFlash(spec.apj.boardId)
        if (!layout) {
          throw new Error(
            `We don't have a DFU flash map for board ${spec.apj.boardId} yet — use the "_with_bl.hex" artefact instead, which carries its own addresses.`,
          )
        }
        if (spec.apj.image.length > layout.flashSize - (layout.appAddress - layout.flashBase)) {
          throw new Error(`Firmware is too large for this board's app region.`)
        }
        regions.push({ address: layout.appAddress, data: spec.apj.image })
        totalBytes = spec.apj.image.length
        name = spec.apj.summary ?? spec.apj.description
      }
      else {
        if (spec.hex.segments.length === 0)
          throw new Error('Firmware file is empty.')
        for (const s of spec.hex.segments)
          regions.push({ address: s.address, data: s.data })
        totalBytes = spec.hex.totalBytes
        name = spec.filename
      }

      // 2. Combine every writable sector ('g'/'e' capability) from
      //    every alt-setting the device exposes into one virtual flash
      //    layout. STM32 boards advertise "@Internal Flash …" plus
      //    "@Option Bytes" / "@OTP Memory" / etc.; on some chips the
      //    flash itself is split across multiple alt-settings (dual-
      //    bank H7). Coverage is checked sector-by-sector against this
      //    combined view, not "does any single layout's address range
      //    contain the whole region", so split flashes and chips with
      //    sparse layouts both work.
      const layouts = opened.altSettingDescriptors
        .map(d => parseDfuseLayout(d))
        .filter((l): l is NonNullable<typeof l> => l !== null)
      const flash = combineFlashLayouts(layouts)
      for (const r of regions) {
        if (!regionCoveredBySectors(flash, { address: r.address, length: r.data.length })) {
          throw new Error(
            `DFU device's flash doesn't cover 0x${r.address.toString(16).padStart(8, '0')} + ${r.data.length} bytes. Device exposed: ${describeMemoryLayouts(layouts)}.`,
          )
        }
      }
      if (flash.sectors.length === 0) {
        throw new Error(
          `DFU device didn't expose any writable flash sectors. Device exposed: ${describeMemoryLayouts(layouts)}.`,
        )
      }

      // 3. Compute the unique sectors we need to erase across all regions.
      const sectorsToErase = planSectorErase(
        flash,
        regions.map(r => ({ address: r.address, length: r.data.length })),
      )
      if (sectorsToErase.length === 0)
        throw new Error('No erasable sectors cover this firmware\'s addresses.')

      // 4. Build the DFU client + flatten bytes for the uploader seam.
      const client = new DfuClient(opened.control, { interfaceNumber: opened.interfaceNumber })
      const flat = flattenRegions(regions, totalBytes)

      // Erase strategy — operator-overridable via the DFU-tab radio,
      // sensible default per file kind:
      //   `.hex`  → mass erase (full chip; the .hex carries bootloader
      //             + firmware and ROM-DFU per-sector erase has
      //             wedged on dual-bank H7 at 0x08100000).
      //   `.apj`  → per-sector erase (preserves the bootloader at the
      //             low sectors and any param-storage at the high
      //             sectors that the firmware image doesn't cover).
      // Operator picks "Wipe the entire chip" or "Erase only what's
      // needed" from the DFU tab; this just honours that choice.
      const eraseStrategy = options.eraseStrategy ?? recommendedEraseStrategy(spec.kind)
      const useMassErase = eraseStrategy === 'mass'

      try {
        await defaultUploader.upload(
          { kind: 'firmware', name, bytes: flat },
          {
            runUpload: async (_bytes, onProgress) => {
              await client.flash(
                regions,
                sectorsToErase,
                {
                  transferSize: opened.transferSize,
                  useMassErase,
                  onProgress: (fraction) => {
                    progress.value = fraction
                    onProgress?.(fraction)
                  },
                  onPhase: (p) => { phase.value = mapDfuPhase(p) },
                },
              )
            },
          },
        )
      }
      finally {
        // Always close the WebUSB device — even on error — so the
        // operator can replug + use it again without a leaked handle.
        await opened.control.close().catch(() => undefined)
      }

      phase.value = 'done'
      progress.value = 1
    }
    catch (e) {
      phase.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
      // Best-effort close — may already have happened in finally.
      await opened.control.close().catch(() => undefined)
      throw e
    }
  }

  return {
    phase,
    progress,
    error,
    wasSkipped,
    flash,
    flashViaBootloaderPort,
    flashDfu,
    reset,
    provideBootloaderPort,
    cancelBootloaderPick,
  }
}

// Map the DFU client's coarse phase to the workflow's UI phase. The
// extra mapping lets the UI use a single switch over FlashPhase.
function mapDfuPhase(p: DfuPhase): FlashPhase {
  switch (p) {
    case 'connecting': return 'syncing'
    case 'erasing': return 'erasing'
    case 'programming': return 'programming'
    case 'manifesting': return 'restarting'
    case 'done': return 'done'
  }
}

// Concatenate every region's bytes into one buffer for the uploader
// seam. v1's passthrough ignores them; a future signed uploader will
// need a single buffer to verify / decrypt.
function flattenRegions(regions: DfuWriteRegion[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  let off = 0
  for (const r of regions) {
    out.set(r.data, off)
    off += r.data.length
  }
  return out
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
