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

// The SFD enable ceremony, identity half: check the drone speaks SFD,
// give it an identity if it has none, read the identity back and prove
// it is the one the drone reported and belongs to the drone we are
// talking to, then produce the file the operator keeps. This is steps
// 3–5 of the ceremony in docs/SECURITY.md. Pure — the drone is reached
// through the IdentityClient interface and time comes from the context —
// so it runs in Vitest against a fake; useSfdEnable() wires it to the
// session store.
//
// What is deliberately not here: flashing the SFD firmware (step 1, the
// Firmware view's DFU path, and a physical BOOT0 gesture) and the lock
// (steps 6–7). The lock is a BRD_OPTIONS bit whose number the firmware
// has not settled yet (F6 in docs/SECURITY.md), and it must only ever be
// set after this ceremony has returned successfully — that ordering is
// the security property, so the lock will attach to a completed
// EnableOutcome rather than run inside this function.

import type { DroneIdentity } from '../protocol/secure-command'
import type { IdentityFile } from './drone-identity'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
import { SecureCommandError } from '../protocol/secure-command'
import {
  buildIdentityFile,
  identityFilename,
  identityMatchesFc,
  sameIdentity,
  serializeIdentityFile,
} from './drone-identity'

// What the ceremony needs from the drone. SecureCommandClient satisfies
// it; tests substitute a fake.
export interface IdentityClient {
  getIdentity: () => Promise<DroneIdentity | null>
  generateIdentity: () => Promise<DroneIdentity>
}

// Where the ceremony has got to, for the UI's status copy.
export type EnablePhase = 'checking' | 'generating' | 'verifying' | 'ready'

export interface EnableContext {
  // APJ_BOARD_ID from the session, or null if the drone hasn't said.
  boardId: number | null
  // The session's rendering of AUTOPILOT_VERSION's uid2, used to prove
  // the identity belongs to the connected drone. Null skips the check.
  fcUid: string | null
  // ISO 8601 timestamp for the file, injected so this stays pure.
  now: () => string
}

// Why a ceremony stopped, for the UI to pick the right next step:
//   unsupported — not SFD secure firmware; send the operator to Firmware
//   armed       — disarm and retry
//   mismatch    — the drone's answers disagree; do NOT lock, retry
//   no-region   — SFD firmware, but a bootloader with nowhere to put an
//                 identity: the state a drone is in part way through an
//                 upgrade. Distinct from `unsupported` because the fix is
//                 to update the bootloader, not the firmware
//   failed      — the drone reported an error; its message is in `message`
export type EnableFailure = 'unsupported' | 'armed' | 'mismatch' | 'no-region' | 'failed'

export class EnableError extends Error {
  constructor(public readonly reason: EnableFailure, message: string) {
    super(message)
    this.name = 'EnableError'
  }
}

export interface EnableOutcome {
  identity: DroneIdentity
  file: IdentityFile
  // The file's on-disk text and name, ready for the browser download.
  text: string
  filename: string
  // True when this run generated the identity; false when the drone
  // already had one and the ceremony read it instead. Either way the
  // identity is verified and the outcome is the same.
  generated: boolean
}

// Run the identity half of the ceremony. Resolves with a verified
// identity and its file; rejects with EnableError naming why it stopped.
// A drone that already has an identity is not an error — the outcome
// carries what it has, since re-generation is impossible by design
// (write-once) and unnecessary.
export async function runEnableCeremony(
  client: IdentityClient,
  ctx: EnableContext,
  onPhase: (phase: EnablePhase) => void = () => {},
): Promise<EnableOutcome> {
  onPhase('checking')
  const existing = await readIdentity(client)

  let expected: DroneIdentity
  let generated = false
  if (existing !== null) {
    expected = existing
  }
  else {
    onPhase('generating')
    try {
      expected = await client.generateIdentity()
      generated = true
    }
    catch (e) {
      if (!(e instanceof SecureCommandError) || e.result !== MavResult.DENIED)
        throw translate(e)
      // DENIED means armed, or an identity appeared between our read and
      // the generate (another tool, a retry landing late). Only a read
      // tells the two apart.
      const again = await readIdentity(client)
      if (again === null)
        throw new EnableError('armed', 'The drone is armed. Disarm it, then try again.')
      expected = again
    }
  }

  // Verify with a fresh read rather than trusting the generate reply on
  // its own. The firmware already builds that reply from flash, but a
  // second round trip is cheap and it is the step "never lock a drone
  // whose identity is unconfirmed" hangs on.
  onPhase('verifying')
  const readBack = await readIdentity(client)
  if (readBack === null || !sameIdentity(expected, readBack)) {
    throw new EnableError('mismatch', 'The identity read back from the drone doesn\'t match what it reported. Don\'t lock this drone — reconnect and try again.')
  }
  if (!identityMatchesFc(readBack, ctx.fcUid))
    throw new EnableError('mismatch', 'The identity doesn\'t belong to the connected drone. Reconnect and try again.')

  const file = buildIdentityFile(readBack, ctx.boardId, ctx.now())
  onPhase('ready')
  return {
    identity: readBack,
    file,
    text: serializeIdentityFile(file),
    filename: identityFilename(file),
    generated,
  }
}

async function readIdentity(client: IdentityClient): Promise<DroneIdentity | null> {
  try {
    return await client.getIdentity()
  }
  catch (e) {
    throw translate(e)
  }
}

// Map a protocol-layer failure onto the ceremony's reasons. A drone that
// never answers is treated as unsupported: firmware without secure
// command support ignores the message entirely, and that is by far the
// likeliest cause on a bench.
function translate(e: unknown): EnableError {
  if (e instanceof EnableError)
    return e
  if (e instanceof SecureCommandError) {
    // Order matters: a drone with no identity region is running SFD
    // firmware and answers normally, so it must not be swept into
    // "isn't running SFD secure firmware".
    if (e.noIdentityRegion)
      return new EnableError('no-region', e.message)
    if (e.result === MavResult.UNSUPPORTED || e.timedOut)
      return new EnableError('unsupported', 'This drone isn\'t running SFD secure firmware. Install it from the Firmware page, then try again.')
    return new EnableError('failed', e.message)
  }
  return new EnableError('failed', e instanceof Error ? e.message : String(e))
}
