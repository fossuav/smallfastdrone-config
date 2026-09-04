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

// The SFD enable ceremony against a real drone: the identity half (steps
// 3-5 of docs/SECURITY.md), driven through the tool's own
// `runEnableCeremony()` so what runs here is what a view would run.
//
// This is the bench test for firmware F1-F4. SITL cannot stand in for it:
// SECURE_COMMAND handling compiles only into signed builds and
// `find_public_keys()` returns null off ChibiOS, so the identity
// operations exist on hardware or nowhere.
//
// **Generation is write-once.** The drone makes its X25519 private key
// from its own hardware RNG and stores it in the bootloader sector; there
// is no rewrite short of erasing the chip. Running this against a drone
// that has no identity gives it one permanently. A drone that already has
// one is not an error - the ceremony reads and verifies it instead.
//
// The identity file it writes is the thing an operator keeps: it holds
// the UID and the *public* half only. The private half never leaves the
// chip, so nothing secret is written here.
//
// Run:
//   bun run bench:enable [output-dir]

import process from 'node:process'
import {
  buildRequestMessage,
  decodeFirmwareVersion,
  formatFcUid,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import { SecureCommandClient } from '../../src/protocol/secure-command'
import { EnableError, runEnableCeremony } from '../../src/workflow/sfd-enable'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? '.'

  const link = openSerialLink()
  const session = new MavLinkSession()
  link.onData(bytes => session.feed(bytes))
  session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT) {
      const text = String((msg.data as { text: string }).text)
      if (/ident|secur|key|bootloader/i.test(text))
        console.log(`        drone: ${text}`)
    }
  })

  const port = await link.ready()
  console.log(`[enable] ${port} open`)

  // Board id and UID come off the wire, not a constant: the ceremony uses
  // the UID to prove the identity it reads back belongs to this airframe,
  // and hardcoding it would defeat that check.
  const info = await new Promise<{ sysid: number, boardId: number, fcUid: string | null, version: string }>((resolve, reject) => {
    let sysid: number | null = null
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error('no AUTOPILOT_VERSION within 15s'))
    }, 15_000)
    off = session.on((msg) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT && sysid === null) {
        sysid = msg.sysid
        link.write(session.serialize(buildRequestMessage(sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)))
      }
      if (msg.msgid === MSGID_AUTOPILOT_VERSION && sysid !== null) {
        const d = msg.data as {
          boardVersion: number
          uid: bigint
          uid2: ArrayLike<number>
          flightSwVersion: number
          flightCustomVersion: ArrayLike<number>
        }
        clearTimeout(timer)
        off?.()
        resolve({
          sysid,
          boardId: d.boardVersion >>> 16,
          fcUid: formatFcUid(d.uid, d.uid2),
          version: decodeFirmwareVersion(d.flightSwVersion, d.flightCustomVersion),
        })
      }
    })
  })
  console.log(`[enable] sysid=${info.sysid} board=${info.boardId} fw=${info.version}`)
  console.log(`[enable] drone uid=${info.fcUid}`)

  const client = new SecureCommandClient(
    async msg => link.write(session.serialize(msg)),
    cb => session.on(cb),
    info.sysid,
    COMP_ID_AUTOPILOT,
  )

  try {
    const outcome = await runEnableCeremony(
      client,
      { boardId: info.boardId, fcUid: info.fcUid, now: () => new Date().toISOString() },
      phase => console.log(`[enable] ${phase}…`),
    )

    console.log(outcome.generated
      ? `[enable] identity GENERATED — this drone had none, and now has one permanently`
      : `[enable] identity READ — this drone already had one; generation is write-once by design`)
    console.log(`[enable]   uid        ${hex(outcome.identity.uid)}`)
    console.log(`[enable]   public key ${hex(outcome.identity.publicKey)}`)

    const path = `${outDir}/${outcome.filename}`
    await Bun.write(path, outcome.text)
    console.log(`[enable] identity file written to ${path}`)
    console.log(`[enable] (public half only — the private key never leaves the drone)`)
  }
  catch (e) {
    if (e instanceof EnableError) {
      console.error(`[enable] ceremony stopped — reason="${e.reason}"`)
      console.error(`[enable] operator would see: "${e.message}"`)
      process.exit(1)
    }
    throw e
  }

  link.close()
}

main().catch((e) => {
  console.error(`[enable] FAILED: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
