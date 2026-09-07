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

// Reading the *outside* of a `.lxa` — an applet SFD encrypted for one
// particular drone.
//
// This tool cannot open one and must not try. The applet is encrypted to
// the drone's identity public key, and the private half is in flash and
// never emitted; that is the whole point of giving drones identities.
// The tool is a courier.
//
// What a courier can legitimately read is the address. The v2 header
// carries the target drone's UID in the clear, precisely so the firmware
// can refuse somebody else's applet without spending a decryption on it
// — and the same field lets the tool refuse it before the upload, which
// is a better place to find out.
//
//    0   6  magic "LXA2.0"
//    6  12  target drone UID, plaintext
//   18  32  the sender's ephemeral X25519 public key
//   50  24  nonce
//   74  16  Poly1305 tag
//   90  ..  ciphertext
//
// Layout from AP_Scripting_config.h; the loader is load_encrypted_script()
// in lua_scripts.cpp.

const MAGIC = 'LXA2.0'
const UID_LEN = 12
export const LXA_HEADER_LEN = 90

export interface LxaHeader {
  // The drone this applet was encrypted for, as lower-case hex — the
  // same rendering the identity file uses.
  uid: string
  // Bytes of the encrypted applet itself, after the header.
  bodyLength: number
}

export class LxaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LxaError'
  }
}

// Is this an encrypted applet? A plain `.lua` answers false, which is
// what lets one surface take either.
export function isLxa(bytes: Uint8Array): boolean {
  if (bytes.length <= LXA_HEADER_LEN)
    return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i))
      return false
  }
  return true
}

// Read the address off the envelope. Never the contents.
export function parseLxaHeader(bytes: Uint8Array): LxaHeader {
  if (!isLxa(bytes))
    throw new LxaError('That file isn\'t an applet from SmallFastDrone.')
  const uid = [...bytes.subarray(MAGIC.length, MAGIC.length + UID_LEN)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return { uid, bodyLength: bytes.length - LXA_HEADER_LEN }
}

// Was this applet encrypted for the drone we're talking to?
//
// AUTOPILOT_VERSION's uid2 is the same 12-byte STM32 UID zero-padded to
// 18 and the session renders all of it, so the header's uid is a prefix
// — the same rule identityMatchesFc uses. With no uid known there is
// nothing to contradict, and the drone will refuse it anyway if we are
// wrong: this check exists to say so earlier and more clearly, not to be
// the thing that enforces it.
export function lxaMatchesFc(header: LxaHeader, fcUid: string | null): boolean {
  if (fcUid === null)
    return true
  return fcUid.toLowerCase().startsWith(header.uid)
}
