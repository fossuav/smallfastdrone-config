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

// Ask a running drone to flash the bootloader it carries in its own ROMFS.
//
// This is the second half of the serial upgrade path (docs/SECURITY.md,
// "Step 1 has two routes"): flashing SFD firmware over an existing
// bootloader gets a drone running SFD, but only replacing the *bootloader*
// gives it the `.apsec_data` region an identity lives in. Doing that over
// MAVLink is what lets an operator upgrade a working drone without ever
// entering DFU.
//
// Deliberately not a composable: it takes send/subscribe the way MavFtp and
// SecureCommandClient do, so it is unit-testable in node and can be driven
// from the bench as well as from a view.
//
// What the drone actually flashes is whatever was in
// `Tools/bootloaders/<board>_bl.bin` when its firmware was built. The tool
// cannot choose or inspect it — trusting the running firmware's ROMFS is
// the whole mechanism, which is why the operator must have installed a
// firmware they trust first.

import type { MavLinkData } from 'mavlink-mappings'
import type { MessageHandler } from '../protocol/mavlink'
import { CommandAck, MavResult } from 'mavlink-mappings/dist/lib/common'
import { buildFlashBootloader, MSGID_STATUSTEXT } from '../protocol/mavlink'

// MAV_CMD_FLASH_BOOTLOADER. Ours to name because it isn't in the common
// dialect's MavCmd enum that the rest of the codebase leans on.
const CMD_FLASH_BOOTLOADER = 42650

// Erasing and rewriting the boot sector is synchronous on the FC and takes
// far longer than an ordinary command. Generous on purpose: giving up early
// would leave the operator believing a bootloader write failed while it is
// still running, which is the worst moment to unplug a drone.
const DEFAULT_TIMEOUT_MS = 30_000

export type BootloaderUpdateReason = 'refused' | 'unsupported' | 'timeout'

export interface BootloaderUpdateOutcome {
  ok: boolean
  // Why it stopped, when it did.
  reason?: BootloaderUpdateReason
  // The drone's verdict, or null when it never gave one.
  result: MavResult | null
  // Anything the drone said while doing it. The firmware explains refusals
  // in text ("Bootloader not signed") rather than in the result code, so
  // this is the only place a useful reason exists.
  messages: string[]
}

// Send the command and wait for the drone's verdict.
//
// ACCEPTED covers both "flashed" and "the embedded bootloader was already
// the one installed" — ArduPilot maps NO_CHANGE to ACCEPTED so an operator
// isn't shown an error for a no-op, so the two genuinely cannot be told
// apart from here. Don't claim to the operator that bytes were written.
//
// The new bootloader takes effect at the next boot; rebooting is the
// caller's business, because the caller is the one that knows whether it
// also wants to reconnect.
export async function flashRomfsBootloader(
  send: (msg: MavLinkData) => Promise<void>,
  subscribe: (cb: MessageHandler) => () => void,
  targetSystem: number,
  targetComponent: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BootloaderUpdateOutcome> {
  const messages: string[] = []

  return new Promise<BootloaderUpdateOutcome>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null
    const done = (outcome: BootloaderUpdateOutcome): void => {
      if (timer)
        clearTimeout(timer)
      unsubscribe?.()
      resolve(outcome)
    }

    unsubscribe = subscribe((msg) => {
      // Collect the drone's narration whatever happens — on a refusal it
      // carries the only actionable detail.
      if (msg.msgid === MSGID_STATUSTEXT) {
        const text = String((msg.data as { text: string }).text).replace(/\0.*$/, '')
        if (text.length > 0)
          messages.push(text)
        return
      }
      if (msg.msgid !== CommandAck.MSG_ID)
        return
      const ack = msg.data as CommandAck
      if (Number(ack.command) !== CMD_FLASH_BOOTLOADER)
        return
      // IN_PROGRESS is a heartbeat for a long command, not a verdict.
      if (ack.result === MavResult.IN_PROGRESS)
        return

      if (ack.result === MavResult.ACCEPTED) {
        done({ ok: true, result: ack.result, messages })
        return
      }
      done({
        ok: false,
        reason: ack.result === MavResult.UNSUPPORTED ? 'unsupported' : 'refused',
        result: ack.result,
        messages,
      })
    })

    timer = setTimeout(() => {
      done({ ok: false, reason: 'timeout', result: null, messages })
    }, timeoutMs)

    send(buildFlashBootloader(targetSystem, targetComponent)).catch((e: unknown) => {
      if (timer)
        clearTimeout(timer)
      unsubscribe?.()
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

// Operator-facing explanation of a stopped update. The drone's own text is
// preferred when it gave any, since it knows why; the fallbacks cover the
// cases where it said nothing.
export function describeBootloaderUpdateFailure(outcome: BootloaderUpdateOutcome): string {
  const said = outcome.messages[outcome.messages.length - 1]
  if (said)
    return `Your drone couldn't update its startup software: ${said}`
  switch (outcome.reason) {
    case 'unsupported':
      return 'This drone\'s firmware can\'t update its own startup software. Install newer firmware first.'
    case 'timeout':
      return 'Your drone didn\'t answer while updating its startup software. Leave it powered and reconnect to check.'
    default:
      return 'Your drone refused to update its startup software.'
  }
}
