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
import { parseDfuseLayout, planSectorErase } from '../protocol/dfu'
import { DfuClient } from '../protocol/dfu-client'
import { defaultUploader } from '../security/uploader'
import { useSessionStore } from '../stores/session'

// Operator-facing phase labels — what's happening right now. Drives the
// UI's status copy. 'idle' = ready / not running; 'done' = success;
// 'error' = stopped, see `error`.
export type FlashPhase
  = | 'idle'
    | 'rebooting-to-bootloader' // bootloader path: sent MAVLink reboot
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
// command before we try to take over the serial port. The FC needs a
// moment to act on the command, close USB, and re-enumerate as the
// bootloader. acquireRaw() additionally retries port.open() until the
// device comes back, but this initial pause keeps the first attempt
// from racing the USB stack.
const POST_REBOOT_SETTLE_MS = 1_500

// After the bootloader REBOOT, the device disappears again and comes
// back as the running firmware. Wait briefly before the MAVLink
// session.connect() (which would otherwise prompt the operator to
// re-pick the port if the device hasn't re-enumerated yet).
const POST_FLASH_SETTLE_MS = 2_000

// What the DFU path takes as input. The UI sends one of these depending
// on what file the operator picked. We keep `apj` and `hex` as separate
// discriminated variants so the workflow can give precise errors
// ("we don't have a flash map for board 7 — try the `_with_bl.hex`
// artefact instead").
export type DfuFlashSpec
  = | { kind: 'apj', apj: ApjFirmware }
    | { kind: 'hex', hex: ParsedHex, filename: string }

export function useFirmwareFlash() {
  const session = useSessionStore()

  const phase = ref<FlashPhase>('idle')
  // 0..1 during 'programming' — driven by the protocol layer's per-block
  // callback. Otherwise undefined (the UI hides the bar).
  const progress = ref<number | null>(null)
  const error = ref<string | null>(null)

  function reset() {
    phase.value = 'idle'
    progress.value = null
    error.value = null
  }

  function assertIdle() {
    if (phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'error')
      throw new Error('A firmware flash is already in progress.')
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

    try {
      // 1. Tell the FC to reboot into its bootloader (MAVLink command
      //    on the still-open MAVLink session).
      phase.value = 'rebooting-to-bootloader'
      await session.rebootToBootloader()

      // 2. Take raw control of the port. acquireRaw closes the MAVLink
      //    reader, closes the port, waits for the device to re-enumerate
      //    as the bootloader, and reopens it at bootloader baud.
      const raw = await transport.acquireRaw({
        baudRate: 115_200,
        settleDelayMs: POST_REBOOT_SETTLE_MS,
      })
      const client = new BootloaderClient(raw)

      try {
        // 3. Run the upload through the security uploader seam. The
        //    seam (currently passthrough) is the chokepoint every
        //    artifact upload goes through; the per-byte work is the
        //    transport callback below.
        await defaultUploader.upload(
          { kind: 'firmware', name: apj.summary ?? apj.description, bytes: apj.image },
          {
            runUpload: async (bytes, onProgress) => {
              await client.flash(
                bytes,
                apj.boardId,
                (p) => { phase.value = p },
                (fraction) => {
                  progress.value = fraction
                  onProgress?.(fraction)
                },
              )
            },
          },
        )
      }
      finally {
        // Always release the port — even if the upload threw — so the
        // MAVLink reconnect below isn't blocked by a dangling reader.
        await raw.close()
      }

      // 4. Bootloader has been told to reboot. Give the firmware time
      //    to come back up, then reconnect MAVLink.
      phase.value = 'reconnecting'
      await sleep(POST_FLASH_SETTLE_MS)
      await session.connect()

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
  async function flashDfu(spec: DfuFlashSpec, opened: OpenedDfuDevice): Promise<void> {
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

      // 2. Pick the right alt-setting layout — STM32 boards advertise
      //    "@Internal Flash …" plus option-bytes / OTP / etc. We want
      //    the one whose address span covers every region we plan to
      //    write.
      const layouts = opened.altSettingDescriptors
        .map(d => parseDfuseLayout(d))
        .filter((l): l is NonNullable<typeof l> => l !== null)
      const flash = layouts.find((l) => {
        const layoutEnd = l.sectors.reduce((end, s) => end + s.size, l.startAddress)
        return regions.every(r =>
          r.address >= l.startAddress
          && r.address + r.data.length <= layoutEnd,
        )
      })
      if (!flash) {
        throw new Error('DFU device doesn\'t expose a flash region covering this firmware\'s addresses.')
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

  return { phase, progress, error, flash, flashDfu, reset }
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
