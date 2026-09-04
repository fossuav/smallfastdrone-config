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

// Bench firmware flash — puts a real board through the same upgrade the
// Firmware view performs, using the same code: `parseApj` to read the
// file and `BootloaderClient.flash()` to write it. Only the transport
// differs (the bench serial helper instead of WebSerial), so a pass here
// says the upgrade path itself works, not merely that the browser does.
//
// The sequence, which is the whole point of the exercise:
//   1. MAVLink reboot into the board's bootloader
//   2. wait for it to re-enumerate as the bootloader (USB pid 0x5741)
//   3. sync / identify / erase / program / verify
//   4. wait for the firmware to come back (pid 0x5740) and heartbeat
//
// Run:
//   bun run bench:flash <firmware.apj>
//
// This writes the board's flash. It refuses a file whose board id doesn't
// match — that check lives in BootloaderClient and is deliberately not
// duplicated here, so the bench exercises the real guard.

import type { DecodedMessage } from '../../src/protocol/mavlink'
import process from 'node:process'
import { parseApj } from '../../src/protocol/apj'
import { BootloaderClient } from '../../src/protocol/bootloader-client'
import {
  buildPreflightRebootToBootloader,
  buildRequestMessage,
  decodeFirmwareVersion,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1

// Wait for the autopilot's next heartbeat and return its system id.
function waitForHeartbeat(session: MavLinkSession, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error(`no heartbeat within ${timeoutMs}ms`))
    }, timeoutMs)
    off = session.on((msg: DecodedMessage) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT) {
        clearTimeout(timer)
        off?.()
        resolve(msg.sysid)
      }
    })
  })
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    throw new Error('usage: bun run bench:flash <firmware.apj>')
  }

  const firmware = await parseApj(await Bun.file(path).text())
  console.log(`[flash] ${path}`)
  console.log(`[flash] ${firmware.summary} — board ${firmware.boardId}, ${firmware.imageSize} bytes, git ${firmware.gitIdentity}`)

  const link = openSerialLink()
  const session = new MavLinkSession()
  const feed = link.onData(bytes => session.feed(bytes))

  const port = await link.ready()
  console.log(`[flash] ${port} open as ${link.mode}`)

  // Only reboot if we're actually in the firmware; a board already sitting
  // in its bootloader (a previous run that stopped half way) is ready.
  if (link.mode !== 'bootloader') {
    const sysid = await waitForHeartbeat(session, 15_000)
    console.log(`[flash] heartbeat from sysid=${sysid}, asking it to reboot into its bootloader`)
    const inBootloader = link.nextOpen(60_000, 'bootloader')
    link.write(session.serialize(buildPreflightRebootToBootloader(sysid, COMP_ID_AUTOPILOT)))
    const blPort = await inBootloader
    console.log(`[flash] bootloader up on ${blPort}`)
  }

  // Hand the link to the bootloader protocol. MAVLink decoding stops here
  // — the bootloader speaks its own byte protocol on the same wire.
  feed()
  const raw = link.rawSerial()
  const client = new BootloaderClient(raw)

  const started = Date.now()
  let lastPct = -1
  const { skipped } = await client.flash(
    firmware.image,
    firmware.boardId,
    phase => console.log(`[flash] ${phase}…`),
    (fraction) => {
      const pct = Math.floor(fraction * 100)
      if (pct >= lastPct + 10) {
        lastPct = pct
        process.stdout.write(`  ${pct}%\n`)
      }
    },
  )
  await raw.close()

  console.log(skipped
    ? `[flash] already up to date — same image already on the board`
    : `[flash] written and verified in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // Back to the firmware side: confirm it actually boots and says who it is.
  const back = link.onData(bytes => session.feed(bytes))
  await link.nextOpen(60_000, 'firmware').catch(() => link.ready(60_000))
  const sysid = await waitForHeartbeat(session, 30_000)
  console.log(`[flash] firmware back, heartbeat from sysid=${sysid}`)

  const banners: string[] = []
  const seen = session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT)
      banners.push(String((msg.data as { text: string }).text))
    if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
      const d = msg.data as { flightSwVersion: number, flightCustomVersion: ArrayLike<number> }
      console.log(`[flash] running ${decodeFirmwareVersion(d.flightSwVersion, d.flightCustomVersion)}`)
    }
  })
  link.write(session.serialize(buildRequestMessage(sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)))
  await new Promise(resolve => setTimeout(resolve, 5000))
  for (const b of banners) console.log(`        ${b}`)

  seen()
  back()
  link.close()
}

main().catch((e) => {
  console.error(`[flash] FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
