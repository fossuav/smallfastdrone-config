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

// Reading an ownership grant. The tool cannot verify one — the key that
// checks the signature is in the drone's bootloader — so these assert
// only what the operator needs shown: which drone, and which key.

import { describe, expect, it } from 'vitest'
import { grantMatchesFc, OWNER_GRANT_LEN, parseOwnerGrant } from '../../src/protocol/owner-grant'

const UID = '350053000551333530343432'

function grant(uidHex = UID, counter = 1n, keyByte = 0x11): Uint8Array {
  const bytes = new Uint8Array(OWNER_GRANT_LEN)
  bytes.set(new TextEncoder().encode('SFDOWN'), 0)
  bytes[6] = 1
  for (let i = 0; i < 12; i++)
    bytes[8 + i] = Number.parseInt(uidHex.slice(i * 2, i * 2 + 2), 16)
  bytes.fill(keyByte, 20, 52)
  new DataView(bytes.buffer).setBigUint64(52, counter, false)
  bytes.fill(0x5A, 60) // SFD's signature, which only the drone can judge
  return bytes
}

describe('owner grant', () => {
  it('reads the drone, the key and the counter', () => {
    const g = parseOwnerGrant(grant(UID, 7n))
    expect(g.uid).toBe(UID)
    expect(g.counter).toBe(7n)
    expect(g.publicKey.length).toBe(32)
    expect(g.publicKey.every(b => b === 0x11)).toBe(true)
  })

  it('hands the bytes back untouched, because the drone judges them', () => {
    const bytes = grant()
    expect(parseOwnerGrant(bytes).bytes).toBe(bytes)
  })

  it('refuses anything it does not recognise rather than guessing', () => {
    expect(() => parseOwnerGrant(new Uint8Array(OWNER_GRANT_LEN))).toThrow(/isn't a permission/)
    expect(() => parseOwnerGrant(new Uint8Array(10))).toThrow(/isn't a permission/)
    const future = grant()
    future[6] = 2
    expect(() => parseOwnerGrant(future)).toThrow(/newer version/)
  })

  it('matches the connected drone on the uid prefix', () => {
    const fcUid = `${UID}000000000000`
    expect(grantMatchesFc(parseOwnerGrant(grant()), fcUid)).toBe(true)
    expect(grantMatchesFc(parseOwnerGrant(grant('aabbccddeeff001122334455')), fcUid)).toBe(false)
    // nothing to contradict, and the drone refuses it anyway if we're wrong
    expect(grantMatchesFc(parseOwnerGrant(grant()), null)).toBe(true)
  })

  it('reads a counter past what a 32-bit number holds', () => {
    // The field is 8 bytes and grants are ordered by it; a tool that
    // silently truncated would compare the wrong things.
    expect(parseOwnerGrant(grant(UID, 4294967296n)).counter).toBe(4294967296n)
  })
})
