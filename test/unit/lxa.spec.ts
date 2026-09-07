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

// Reading the outside of an encrypted applet. The tool cannot open one
// and these tests assert only what a courier may read: whether it is an
// applet at all, and which drone it is addressed to.

import { describe, expect, it } from 'vitest'
import { isLxa, LXA_HEADER_LEN, lxaMatchesFc, parseLxaHeader } from '../../src/protocol/lxa'

const UID = '350053000551333530343432'

// A .lxa as encrypt_lua.py writes one: the header at the firmware's own
// offsets, then ciphertext we neither read nor could.
function lxa(uidHex = UID, body = 64): Uint8Array {
  const bytes = new Uint8Array(LXA_HEADER_LEN + body)
  bytes.set(new TextEncoder().encode('LXA2.0'), 0)
  for (let i = 0; i < 12; i++)
    bytes[6 + i] = Number.parseInt(uidHex.slice(i * 2, i * 2 + 2), 16)
  // the ephemeral key, nonce and tag are opaque here, as they are to us
  bytes.fill(0xAB, 18, LXA_HEADER_LEN)
  bytes.fill(0xCD, LXA_HEADER_LEN)
  return bytes
}

describe('lxa', () => {
  it('recognises an encrypted applet and leaves a plain one alone', () => {
    expect(isLxa(lxa())).toBe(true)
    expect(isLxa(new TextEncoder().encode('-- an ordinary lua applet\nreturn function() end\n'))).toBe(false)
    // header but no body: nothing to run, so not one
    expect(isLxa(lxa(UID, 0))).toBe(false)
  })

  it('reads the drone it is addressed to, and nothing else', () => {
    const header = parseLxaHeader(lxa())
    expect(header.uid).toBe(UID)
    expect(header.bodyLength).toBe(64)
  })

  it('refuses to read something that is not one', () => {
    expect(() => parseLxaHeader(new Uint8Array(200))).toThrow(/isn't an applet from SmallFastDrone/)
  })

  it('matches the connected drone on the uid prefix, as the identity does', () => {
    // AUTOPILOT_VERSION pads the 12-byte STM32 UID out to 18.
    const fcUid = `${UID}000000000000`
    expect(lxaMatchesFc(parseLxaHeader(lxa()), fcUid)).toBe(true)
    expect(lxaMatchesFc(parseLxaHeader(lxa('aabbccddeeff001122334455')), fcUid)).toBe(false)
  })

  it('does not contradict a drone whose uid is unknown', () => {
    // Nothing to check against, and the drone refuses it anyway if we
    // are wrong — this check exists to say so sooner, not to enforce.
    expect(lxaMatchesFc(parseLxaHeader(lxa()), null)).toBe(true)
  })
})
