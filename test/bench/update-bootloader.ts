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

// Second half of the serial upgrade path on a real board: ask the running
// firmware to flash the bootloader it carries in ROMFS, using the tool's
// own `flashRomfsBootloader`, then reboot and prove which bootloader
// actually ended up installed.
//
// The proof matters because the obvious check doesn't work: a secure
// bootloader with a blank identity region answers GET_IDENTITY with FAILED,
// which is byte-for-byte what a bootloader with no region at all answers.
// So instead we hold the board in its bootloader and read the USB product
// string, which a secure build marks with "-Secure-" — non-destructive,
// and it doesn't require generating an identity to find out.
//
// Run:
//   bun run bench:bootloader
//
// This rewrites the sector the board boots from. Do not cut power while it
// runs. Recovery from a failed write is the physical BOOT0 pads.

import process from 'node:process'
import { BootloaderClient } from '../../src/protocol/bootloader-client'
import {
  buildPreflightRebootToBootloader,
  MavLinkSession,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import {
  describeBootloaderUpdateFailure,
  flashRomfsBootloader,
} from '../../src/workflow/bootloader-update'
import { describeUsbPort, openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1

function waitForHeartbeat(session: MavLinkSession, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error(`no heartbeat within ${timeoutMs}ms`))
    }, timeoutMs)
    off = session.on((msg) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT) {
        clearTimeout(timer)
        off?.()
        resolve(msg.sysid)
      }
    })
  })
}

async function main(): Promise<void> {
  const link = openSerialLink()
  const session = new MavLinkSession()
  link.onData(bytes => session.feed(bytes))
  session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT)
      console.log(`        drone: ${String((msg.data as { text: string }).text)}`)
  })

  const port = await link.ready()
  console.log(`[bootloader] ${port} open as ${link.mode}`)
  const sysid = await waitForHeartbeat(session, 15_000)
  console.log(`[bootloader] heartbeat from sysid=${sysid}`)

  console.log(`[bootloader] asking the drone to flash the bootloader from its ROMFS…`)
  const started = Date.now()
  const outcome = await flashRomfsBootloader(
    async msg => link.write(session.serialize(msg)),
    cb => session.on(cb),
    sysid,
    COMP_ID_AUTOPILOT,
  )
  if (!outcome.ok) {
    throw new Error(describeBootloaderUpdateFailure(outcome))
  }
  console.log(`[bootloader] drone accepted after ${Date.now() - started}ms`)
  console.log(`[bootloader] (ACCEPTED covers "flashed" and "already installed" — ArduPilot maps both)`)

  // Hold it in the bootloader so we can read what's actually there. This
  // also proves the new bootloader runs at all, which a plain reboot into
  // firmware would not distinguish from the old one still being present.
  console.log(`[bootloader] rebooting into the bootloader to see which one is installed…`)
  const inBootloader = link.nextOpen(60_000, 'bootloader')
  link.write(session.serialize(buildPreflightRebootToBootloader(sysid, COMP_ID_AUTOPILOT)))
  const blPort = await inBootloader
  const usb = await describeUsbPort(blPort)
  console.log(`[bootloader] bootloader on ${blPort}: ${usb ?? '(no USB description available)'}`)
  const secure = usb !== null && /secure/i.test(usb)
  console.log(secure
    ? `[bootloader] SECURE bootloader confirmed — this board can now hold an identity`
    : `[bootloader] NOT a secure bootloader — the firmware's ROMFS held an unsigned one`)

  // Back out to the firmware. A MAVLink reboot is useless here — the
  // bootloader doesn't speak MAVLink, and rebooting *to* the bootloader
  // set the hold flag, so it will wait indefinitely. Use its own protocol.
  console.log(`[bootloader] returning to firmware…`)
  const raw = link.rawSerial()
  const client = new BootloaderClient(raw)
  // The bootloader gates commands until a tool has identified itself.
  await client.getBootloaderRev()
  await client.getBoardId()
  const backToFirmware = link.nextOpen(60_000, 'firmware')
  await client.reboot()
  await raw.close()
  await backToFirmware.catch(() => link.ready(60_000))
  const backSysid = await waitForHeartbeat(session, 30_000)
  console.log(`[bootloader] firmware back, heartbeat from sysid=${backSysid}`)

  link.close()
  if (!secure)
    process.exitCode = 1
}

main().catch((e) => {
  console.error(`[bootloader] FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
