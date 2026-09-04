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

// What a connected drone can tell us about how secured it is, and the
// operator-facing words for it.
//
// One read of `GET_IDENTITY` separates every case we can distinguish,
// because the firmware answers differently for each (see docs/SECURITY.md):
// no answer at all means the firmware isn't a signed build, since an
// unsigned build never compiles the handler; NO_REGION means signed
// firmware on a bootloader that predates the identity region; NOT_SET
// means the region is there and empty; and a 44-byte reply is the drone's
// own identity.
//
// **What the lock does and does not claim.** The identity region exists
// only in a bootloader built as a signed one from the SFD tree, so seeing
// it does establish that the drone's startup software is SFD's secured
// build. It does *not* establish that the bootloader carries public keys
// and would therefore refuse unsigned firmware: asking that means
// `GET_PUBLIC_KEYS`, which requires a signature by a bootloader key, and
// decision 10 says the tool holds no key. So the copy below says what the
// drone is running, and never promises what it would refuse.

import type { DroneIdentity } from '../protocol/secure-command'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
import { SecureCommandError } from '../protocol/secure-command'

// Just the read half of the identity client — probing must not be able to
// generate anything by accident.
export interface IdentityReader {
  getIdentity: () => Promise<DroneIdentity | null>
}

export type SecurityPosture
  // Not asked yet, or the drone went away mid-probe.
  = | 'unknown'
    // Firmware isn't a signed SFD build; it ignores the command entirely.
    | 'unsecured'
    // Signed SFD firmware, but startup software too old to hold an identity.
    // The state a drone is in part way through an upgrade.
    | 'bootloader-outdated'
    // Secured startup software, no identity written yet.
    | 'secured'
    // Secured startup software and this drone's own identity.
    | 'identified'

export interface PostureCopy {
  // Whether to show the lock at all.
  locked: boolean
  // Short label beside the lock.
  label: string
  // One sentence for a tooltip or detail line.
  detail: string
}

// Ask the drone once. Never throws: a posture we can't determine is
// `unknown`, because a probe failing is not something to put in front of
// an operator who didn't ask for it.
export async function probeSecurityPosture(client: IdentityReader): Promise<SecurityPosture> {
  try {
    const identity = await client.getIdentity()
    return identity === null ? 'secured' : 'identified'
  }
  catch (e) {
    if (e instanceof SecureCommandError) {
      if (e.noIdentityRegion)
        return 'bootloader-outdated'
      if (e.timedOut || e.result === MavResult.UNSUPPORTED)
        return 'unsecured'
    }
    return 'unknown'
  }
}

// Operator-facing words. "Startup software" rather than "bootloader":
// the operator has no reason to know that word, and the thing it names is
// exactly "what runs when you plug it in".
export function describePosture(posture: SecurityPosture): PostureCopy {
  switch (posture) {
    case 'identified':
      return {
        locked: true,
        label: 'Secured',
        detail: 'This drone runs SmallFastDrone\'s secured firmware and startup software, and has its own identity.',
      }
    case 'secured':
      return {
        locked: true,
        label: 'Secured',
        detail: 'This drone runs SmallFastDrone\'s secured firmware and startup software. It doesn\'t have its own identity yet.',
      }
    case 'bootloader-outdated':
      return {
        locked: false,
        label: 'Part-way secured',
        detail: 'This drone runs secured firmware, but its startup software is older and can\'t hold an identity yet.',
      }
    case 'unsecured':
      return {
        locked: false,
        label: 'Not secured',
        detail: 'This drone isn\'t running SmallFastDrone secured firmware.',
      }
    default:
      return { locked: false, label: '', detail: '' }
  }
}
