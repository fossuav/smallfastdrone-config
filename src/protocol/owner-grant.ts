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

// Reading an ownership grant — SFD authorising a drone to accept an
// owner key, so a drone nobody is standing next to can be claimed.
//
// The tool does not and cannot verify one: the signature is SFD's, and
// the key that checks it is in the drone's bootloader, not here. The
// drone is the judge. What this does is read the grant so the operator
// can be shown **which key it would install**, because the attack worth
// worrying about is not on the signature — it is a customer relaying a
// file somebody sent them that points somewhere else.
//
//    0   6  magic "SFDOWN"
//    6   1  version
//    7   1  reserved
//    8  12  the drone this grant is for
//   20  32  the owner public key it grants
//   52   8  counter, big-endian
//   60  64  SFD's signature over bytes 0..59

const MAGIC = 'SFDOWN'
const VERSION = 1
const OFS_UID = 8
const OFS_KEY = 20
const OFS_COUNTER = 52
const UID_LEN = 12
const KEY_LEN = 32
export const OWNER_GRANT_LEN = 124

export interface OwnerGrant {
  // The drone it is for, lower-case hex — same rendering as the
  // identity file.
  uid: string
  // The key it would make the owner.
  publicKey: Uint8Array
  // Strictly increasing per drone; the drone refuses anything not newer
  // than the last it applied.
  counter: bigint
  // The whole thing, to hand to the drone untouched.
  bytes: Uint8Array
}

export class OwnerGrantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerGrantError'
  }
}

export function parseOwnerGrant(bytes: Uint8Array): OwnerGrant {
  if (bytes.length !== OWNER_GRANT_LEN)
    throw new OwnerGrantError('That file isn\'t a permission from SmallFastDrone.')
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i))
      throw new OwnerGrantError('That file isn\'t a permission from SmallFastDrone.')
  }
  if (bytes[MAGIC.length] !== VERSION)
    throw new OwnerGrantError('That permission was made for a newer version of this tool.')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    uid: [...bytes.subarray(OFS_UID, OFS_UID + UID_LEN)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join(''),
    publicKey: bytes.slice(OFS_KEY, OFS_KEY + KEY_LEN),
    counter: view.getBigUint64(OFS_COUNTER, false),
    bytes,
  }
}

// Is this grant for the drone we're talking to? Same prefix rule the
// identity uses — and as with the identity, the drone refuses a grant
// meant for another airframe regardless. Checking here says so before
// the operator waits for a flash write.
export function grantMatchesFc(grant: OwnerGrant, fcUid: string | null): boolean {
  if (fcUid === null)
    return true
  return fcUid.toLowerCase().startsWith(grant.uid)
}
