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

// Seal a board's memory, and then check what sealing is supposed to
// change — the pair of behaviours PLAN.md decisions 39 and 42 rest on.
//
// **This is one way.** The seal asks for readout protection at the next
// boot, and the firmware never lowers it. Undoing it means the DFU
// read-unprotect, which mass-erases the chip: firmware, bootloader,
// identity and owner key all go. The board stays perfectly usable
// sealed; it just stops giving up its secrets and stops accepting a
// re-claim from whoever plugs in.
//
// So it takes --yes, and refuses without it.
//
// Run:
//   bun run bench:seal --yes                    # seal, then re-check
//   bun run bench:seal --check --grant <file>   # check only, no sealing

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { MavParamType, MavResult } from 'mavlink-mappings/dist/lib/common'
import {
  buildPreflightReboot,
  MavLinkSession,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import { buildParamRequestRead, buildParamSet, MSGID_PARAM_VALUE } from '../../src/protocol/params'
import { SecureCommandClient } from '../../src/protocol/secure-command'
import { isLockRequested, withLockBit } from '../../src/workflow/drone-lock'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1
const LOCK_PARAM = 'BRD_OPTIONS'
const OP_SET_OWNER_KEY = 0x53464403
const OP_SET_OWNER_GRANT = 0x53464405

const OWNER_STATUS: Record<number, string> = {
  1: 'no owner key set',
  2: 'no owner key region',
  3: 'armed',
  4: 'already claimed',
  5: 'no identity',
  6: 'already claimed and sealed',
  7: 'malformed permission',
  8: 'permission for a different drone',
  9: 'permission not signed by a trusted key',
  10: 'permission superseded',
}

function hex(b: Uint8Array): string {
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}

function why(result: MavResult, data: Uint8Array): string {
  const s = data.length === 1 ? OWNER_STATUS[data[0] ?? 0] : undefined
  return `${MavResult[result] ?? result}${s ? ` — ${s}` : ''}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const confirmed = args.includes('--yes')
  const checkOnly = args.includes('--check')
  const grantArg = args.indexOf('--grant')
  const grantPath = grantArg === -1 ? null : args[grantArg + 1]

  if (!confirmed && !checkOnly) {
    console.error('[seal] this is one way — the only way back is a DFU mass erase.')
    console.error('[seal] pass --yes to seal, or --check to look without sealing.')
    process.exit(1)
  }

  const link = openSerialLink()
  const session = new MavLinkSession()
  link.onData(bytes => session.feed(bytes))
  session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT) {
      const t = String((msg.data as { text: string }).text)
      if (/secur|lock|protect|ident/i.test(t))
        console.log(`        drone: ${t}`)
    }
  })
  await link.ready()

  const sysid = await new Promise<number>((resolve) => {
    const off = session.on((m) => {
      if (m.msgid === MSGID_HEARTBEAT && m.compid === COMP_ID_AUTOPILOT) {
        off()
        resolve(m.sysid)
      }
    })
  })

  const readOptions = async (): Promise<number> => {
    link.write(session.serialize(buildParamRequestRead(sysid, COMP_ID_AUTOPILOT, LOCK_PARAM)))
    return new Promise((resolve) => {
      const off = session.on((m) => {
        if (m.msgid !== MSGID_PARAM_VALUE)
          return
        const d = m.data as { paramId: string, paramValue: number }
        if (String(d.paramId).replace(/\0.*$/, '') === LOCK_PARAM) {
          off()
          resolve(d.paramValue)
        }
      })
    })
  }

  const before = await readOptions()
  console.log(`[seal] ${LOCK_PARAM} = ${before}; sealed = ${isLockRequested(before)}`)

  if (!checkOnly && !isLockRequested(before)) {
    const wanted = withLockBit(before)
    console.log(`[seal] setting ${LOCK_PARAM} = ${wanted} and rebooting…`)
    link.write(session.serialize(buildParamSet(sysid, COMP_ID_AUTOPILOT, LOCK_PARAM, wanted, MavParamType.INT32)))
    await sleep(2500)
    link.write(session.serialize(buildPreflightReboot(sysid, COMP_ID_AUTOPILOT)))
    await sleep(20_000)
    await link.ready()
    await sleep(6000)
    console.log(`[seal] back up; ${LOCK_PARAM} = ${await readOptions()}`)
  }

  // What sealing is meant to change, and the only way to see it from
  // here: the chip's protection level is not readable over the link, so
  // this asks the drone to do the two things whose answers differ.
  const client = new SecureCommandClient(
    async m => link.write(session.serialize(m)),
    cb => session.on(cb),
    sysid,
    COMP_ID_AUTOPILOT,
  )

  /*
    Does a re-claim by presence get refused?

    Probed with the drone's *existing* owner key, never an invented one.
    This test expects a refusal, and a test that performs a real
    irreversible write when its expectation fails is a bad test: the
    first version sent 0x42... and, on a sealed drone that happened to
    have no owner yet, claimed it for a key nobody holds. Re-sending the
    key already installed makes a surprise ACCEPTED a no-op.

    With no owner there is nothing to re-claim and nothing safe to send,
    so it says so rather than inventing a key to find out.
   */
  const current = await client.getOwnerKey().catch(() => null)
  if (current === null) {
    console.log('[seal] no owner set, so there is no re-claim to refuse — skipped.')
    console.log('[seal]   note: sealing does NOT stop a first claim on an unowned drone.')
  }
  else {
    console.log('[seal] a re-claim by presence, which a sealed drone must refuse:')
    const bare = await client.request(OP_SET_OWNER_KEY, current, 15_000)
      .catch(e => ({ result: MavResult.FAILED, data: new Uint8Array(0), err: String(e) }))
    console.log(`[seal]   ${'err' in bare ? bare.err : why(bare.result, bare.data)}`)
  }

  if (grantPath != null) {
    console.log('[seal] a permission SFD signed, which a sealed drone must still take:')
    const grant = new Uint8Array(readFileSync(grantPath))
    const applied = await client.request(OP_SET_OWNER_GRANT, grant, 15_000)
      .catch(e => ({ result: MavResult.FAILED, data: new Uint8Array(0), err: String(e) }))
    if ('err' in applied)
      console.log(`[seal]   ${applied.err}`)
    else if (applied.result === MavResult.ACCEPTED)
      console.log(`[seal]   ACCEPTED — owner is now ${hex(applied.data.subarray(12, 44))}`)
    else
      console.log(`[seal]   ${why(applied.result, applied.data)}`)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(`[seal] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
