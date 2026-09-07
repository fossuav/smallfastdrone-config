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

// Bench driver for the outbound arc's firmware half (F11-F13): report a
// drone's identity and owner key, and optionally claim it.
//
// Claiming is the step that lets a drone encrypt its logs to somebody.
// An **unsealed** drone can be re-claimed, so a mistake on the bench is
// a correction rather than a mass erase; once sealed it cannot, because
// then a re-claim is somebody with link access re-pointing a deployed
// drone's logs at themselves. Reading is always safe; `--owner-key` is
// not - it changes who can read every log written from then on.
//
// Only the *public* half is ever passed here, so this script holds no key
// material - the private half stays wherever the operator keeps it, which
// is the open question in PLAN.md decision 37.
//
// Run:
//   bun run bench:claim                        # read-only report
//   bun run bench:claim --owner-key <file>     # claim, with a raw 32-byte public key
//   bun run bench:claim --grant <file>         # claim with a permission SFD signed
//
// Needs a signed SmallFastDronev1 build with the owner key region:
// SECURE_COMMAND exists only in signed builds, so SITL cannot stand in.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
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
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1

// vendor-private operations, matching AP_CheckFirmware.h
const OP_GET_IDENTITY = 0x53464402
const OP_SET_OWNER_KEY = 0x53464403
const OP_GET_OWNER_KEY = 0x53464404
const OP_SET_OWNER_GRANT = 0x53464405

// the status byte a refusal carries, so this reports the remedy rather
// than a bare DENIED
const OWNER_STATUS: Record<number, string> = {
  1: 'no owner key has been set',
  2: 'this bootloader has no owner key region — update it',
  3: 'the drone is armed',
  4: 'already claimed (no longer sent — an unsealed drone accepts a re-claim)',
  5: 'no identity yet — generate one first (bun run bench:enable)',
  6: 'already claimed and sealed — a sealed drone cannot be re-claimed',
  7: 'that permission is malformed or a version this drone does not know',
  8: 'that permission was issued for a different drone',
  9: 'that permission is not signed by a key this drone trusts',
  10: 'that permission has been superseded — a newer one was already applied',
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Describe a reply. `request()` resolves whatever the drone said rather
// than throwing, so the verdict has to be read - and a refusal carries a
// status byte naming which of four quite different remedies applies.
function describe(result: MavResult, data: Uint8Array): string {
  const status = data.length === 1 ? OWNER_STATUS[data[0]] : undefined
  const verdict = MavResult[result] ?? String(result)
  return status ? `${verdict} — ${status}` : verdict
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const keyArg = args.indexOf('--owner-key')
  const keyPath = keyArg === -1 ? null : args[keyArg + 1]
  const grantArg = args.indexOf('--grant')
  const grantPath = grantArg === -1 ? null : args[grantArg + 1]

  let ownerPub: Uint8Array | null = null
  if (keyPath != null) {
    ownerPub = new Uint8Array(readFileSync(keyPath))
    if (ownerPub.length !== 32) {
      console.error(`[claim] owner key must be 32 raw bytes, got ${ownerPub.length}`)
      process.exit(1)
    }
  }

  const link = openSerialLink()
  const session = new MavLinkSession()
  link.onData(bytes => session.feed(bytes))
  session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT) {
      const text = String((msg.data as { text: string }).text)
      if (/ident|secur|key|owner|bootloader/i.test(text))
        console.log(`        drone: ${text}`)
    }
  })

  const port = await link.ready()
  console.log(`[claim] ${port} open`)

  const info = await new Promise<{ sysid: number, fcUid: string | null, version: string }>((resolve, reject) => {
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
        const d = msg.data as { uid: bigint, uid2: ArrayLike<number>, flightSwVersion: number, flightCustomVersion: ArrayLike<number> }
        clearTimeout(timer)
        off?.()
        resolve({ sysid, fcUid: formatFcUid(d.uid, d.uid2), version: decodeFirmwareVersion(d.flightSwVersion, d.flightCustomVersion) })
      }
    })
  })
  console.log(`[claim] sysid=${info.sysid} fw=${info.version}`)
  console.log(`[claim] drone uid=${info.fcUid}`)

  const client = new SecureCommandClient(
    async msg => link.write(session.serialize(msg)),
    cb => session.on(cb),
    info.sysid,
    COMP_ID_AUTOPILOT,
  )

  // identity first: an owner key is refused without one, so reporting it
  // is what makes a refusal legible
  const ident = await client.request(OP_GET_IDENTITY, new Uint8Array(0), 5000)
  if (ident.result === MavResult.ACCEPTED) {
    console.log(`[claim] identity   uid=${hex(ident.data.subarray(0, 12))}`)
    console.log(`[claim]            key=${hex(ident.data.subarray(12, 44))}`)
  }
  else {
    // the identity statuses share values 1 and 2 with the owner ones but
    // not their meaning, so they are worded separately
    const why: Record<number, string> = {
      1: 'no identity has been generated',
      2: 'this bootloader has no identity region',
    }
    const detail = ident.data.length === 1 ? why[ident.data[0]] : undefined
    console.log(`[claim] identity   ${MavResult[ident.result] ?? ident.result}${detail ? ` — ${detail}` : ''}`)
  }

  const owner = await client.request(OP_GET_OWNER_KEY, new Uint8Array(0), 5000)
  if (owner.result === MavResult.ACCEPTED) {
    console.log(`[claim] owner key  ${hex(owner.data.subarray(12, 44))}`)
  }
  else {
    console.log(`[claim] owner key  ${describe(owner.result, owner.data)}`)
  }

  // A permission SFD signed, which works without anyone at the drone -
  // and unlike a bare key, works on a sealed one.
  if (grantPath != null) {
    const grant = new Uint8Array(readFileSync(grantPath))
    console.log(`[claim] applying a ${grant.length}-byte permission`)
    const applied = await client.request(OP_SET_OWNER_GRANT, grant, 15_000)
    if (applied.result !== MavResult.ACCEPTED) {
      console.log(`[claim] refused — ${describe(applied.result, applied.data)}`)
      process.exit(1)
    }
    console.log(`[claim] owner now  ${hex(applied.data.subarray(12, 44))}`)
    console.log('[claim] PASS — the drone applied it and read the key back')
    process.exit(0)
  }

  if (ownerPub == null) {
    console.log('[claim] read-only; pass --owner-key <file> or --grant <file>')
    process.exit(0)
  }

  console.log(`[claim] claiming with ${hex(ownerPub)}`)
  // 15s, as GENERATE gets: this rewrites the bootloader sector
  let stored: Uint8Array
  try {
    const set = await client.request(OP_SET_OWNER_KEY, ownerPub, 15_000)
    if (set.result !== MavResult.ACCEPTED) {
      console.log(`[claim] refused — ${describe(set.result, set.data)}`)
      process.exit(1)
    }
    stored = set.data.subarray(12, 44)
  }
  catch {
    // A write-once operation that does not answer has not necessarily
    // failed. This rewrites a flash sector, and on the bench 2026-09-07
    // both this and GENERATE_IDENTITY completed the write and delivered
    // no verdict - whether the reply was late or lost is not known. Read
    // before reporting, because "it failed" about a drone that is now
    // permanently claimed is the worst answer available.
    console.log('[claim] no verdict — reading back, because the write may still have landed')
    const after = await client.request(OP_GET_OWNER_KEY, new Uint8Array(0), 5000)
    if (after.result !== MavResult.ACCEPTED) {
      console.log(`[claim] not claimed — ${describe(after.result, after.data)}`)
      process.exit(1)
    }
    stored = after.data.subarray(12, 44)
  }
  console.log(`[claim] stored     ${hex(stored)}`)
  // the reply is read back out of flash, so comparing it is a real check
  console.log(hex(stored) === hex(ownerPub)
    ? '[claim] PASS — the drone read back the key it was given'
    : '[claim] FAIL — the drone read back a different key')
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(`[claim] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
