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

// Reading a .sfx.
//
// The fixture is **produced by the firmware's own monocypher**, at the
// firmware's own header offsets, with the body encrypted in the ragged
// 64-byte chunks AP_Logger_File's io thread actually produces. That is
// the point of it: a test that encrypted with this same code would only
// prove the code agrees with itself, and the thing worth knowing is
// whether it agrees with the drone.
//
// Its keys are fixed constants from the generator, not real key
// material.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isSfx, openSfx, parseSfxHeader, SFX_FLAG_STREAM, SFX_TYPE } from '../../src/protocol/sfx'

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))
}

const ARTEFACT = fixture('outbound-firmware-vector.sfx')
const OWNER_PKCS8 = fixture('outbound-firmware-owner.pkcs8')
const IDENTITY_PUB = fixture('outbound-firmware-identity.pub')
const PLAIN = fixture('outbound-firmware-plain.bin')

async function ownerKey(pkcs8: Uint8Array = OWNER_PKCS8) {
  return {
    privateKey: await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']),
    publicKey: new Uint8Array(32),
  }
}

describe('sfx', () => {
  it('recognises what it can and cannot read', () => {
    expect(isSfx(ARTEFACT)).toBe(true)
    // an ordinary ArduPilot log, which is the other thing that turns up
    expect(isSfx(Uint8Array.from([0xA3, 0x95, 0x80, ...Array.from({ length: 200 }).fill(0)]))).toBe(false)
    expect(isSfx(new Uint8Array(4))).toBe(false)
  })

  it('reads the header without needing a key', () => {
    const header = parseSfxHeader(ARTEFACT)
    expect(header.contentType).toBe(SFX_TYPE.LOG)
    expect(header.flags & SFX_FLAG_STREAM).toBe(SFX_FLAG_STREAM)
    expect(header.uid.length).toBe(12)
    expect(header.ephemeralPublicKey.length).toBe(32)
  })

  it('opens what the firmware encrypted', async () => {
    const { plaintext, header } = await openSfx(ARTEFACT, await ownerKey(), IDENTITY_PUB)
    expect(plaintext).toEqual(PLAIN)
    expect(header.contentType).toBe(SFX_TYPE.LOG)
  })

  it('refuses a different owner', async () => {
    const other = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', other.privateKey))
    await expect(openSfx(ARTEFACT, await ownerKey(pkcs8), IDENTITY_PUB)).rejects.toThrow(/different drone, or to a different owner/)
  })

  it('refuses the right owner with the wrong drone identity', async () => {
    // The identity is half of the agreement, not decoration: it is what
    // makes the artefact authentic rather than merely unreadable.
    const wrong = Uint8Array.from(IDENTITY_PUB)
    wrong[5] ^= 0x40
    await expect(openSfx(ARTEFACT, await ownerKey(), wrong)).rejects.toThrow(/different drone/)
  })

  it('refuses a tampered header', async () => {
    for (const [what, offset] of [['board id', 8], ['ephemeral key', 20], ['flags', 7]] as const) {
      const tampered = Uint8Array.from(ARTEFACT)
      tampered[offset] ^= 0x40
      await expect(openSfx(tampered, await ownerKey(), IDENTITY_PUB), what).rejects.toThrow()
    }
  })

  it('rejects something that is not a .sfx at all', async () => {
    await expect(openSfx(new Uint8Array(200), await ownerKey(), IDENTITY_PUB))
      .rejects
      .toThrow(/isn't one of your drone's recordings/)
  })
})
