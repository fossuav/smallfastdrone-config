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

// Firmware-install workflow — orchestrates the bootloader-path upload
// from operator click to "drone is back on the new firmware". Wraps the
// pure layers (apj parser, bootloader protocol, BootloaderClient) and
// drives the transport choreography (MAVLink reboot → WebSerial raw
// takeover → upload → release → MAVLink reconnect). Routes the actual
// byte push through the security uploader seam so a future signing /
// decryption interpose has the call site already correct. See
// docs/FIRMWARE.md.

import type { ApjFirmware } from '../protocol/apj'
import type { WebSerialTransport } from '../transport/webserial'
import { ref } from 'vue'
import { BootloaderClient } from '../protocol/bootloader-client'
import { defaultUploader } from '../security/uploader'
import { useSessionStore } from '../stores/session'

// Operator-facing phase labels — what's happening right now. Drives the
// UI's status copy. 'idle' = ready / not running; 'done' = success;
// 'error' = stopped, see `error`.
export type FlashPhase
  = | 'idle'
    | 'rebooting-to-bootloader' // sent the MAVLink reboot cmd
    | 'syncing' //                  reopening port + GET_SYNC retries
    | 'verifying-board' //          GET_DEVICE board id + size check
    | 'erasing' //                  CHIP_ERASE
    | 'programming' //              PROG_MULTI loop
    | 'verifying' //                GET_CRC
    | 'restarting' //               REBOOT
    | 'reconnecting' //             MAVLink reconnect
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

export function useFirmwareFlash() {
  const session = useSessionStore()

  const phase = ref<FlashPhase>('idle')
  // 0..1 during 'programming' — driven by BootloaderClient's per-block
  // callback. Otherwise undefined (the UI hides the bar).
  const progress = ref<number | null>(null)
  const error = ref<string | null>(null)

  function reset() {
    phase.value = 'idle'
    progress.value = null
    error.value = null
  }

  // Run the bootloader-path firmware upload end-to-end. Throws on any
  // failure; the caller's UI reads `phase` / `progress` / `error`.
  async function flash(apj: ApjFirmware): Promise<void> {
    if (phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'error')
      throw new Error('A firmware flash is already in progress.')

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

  return { phase, progress, error, flash, reset }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
