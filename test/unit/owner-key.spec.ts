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

// Owner key custody. These exercise real WebCrypto rather than a fake:
// the whole property under test is that the browser holds the key and we
// cannot read it, which a stub would simply assert into existence.

import { describe, expect, it } from 'vitest'
import { agree, importOwnerKey, ownerFingerprint, parseOwnerKeyFile } from '../../src/workflow/owner-key'

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// Build a key file the way the offline generator does.
async function makeFile(): Promise<{ text: string, publicKey: Uint8Array }> {
  const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return {
    text: JSON.stringify({
      schema: 'sfd-owner/1',
      public_key: b64(raw),
      private_key: b64(pkcs8),
      created_at: '2026-09-07T00:00:00Z',
    }),
    publicKey: raw,
  }
}

describe('owner key file', () => {
  it('round-trips a generated key', async () => {
    const { text, publicKey } = await makeFile()
    const key = await importOwnerKey(parseOwnerKeyFile(text))
    expect(key.publicKey).toEqual(publicKey)
  })

  it('holds the private half so it cannot be read back', async () => {
    const { text } = await makeFile()
    const key = await importOwnerKey(parseOwnerKeyFile(text))
    expect(key.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow()
  })

  it('agrees the same secret as the peer does in the other direction', async () => {
    const { text } = await makeFile()
    const key = await importOwnerKey(parseOwnerKeyFile(text))
    const peer = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
    const peerPublic = new Uint8Array(await crypto.subtle.exportKey('raw', peer.publicKey))

    const ours = await agree(key, peerPublic)
    const ourPublic = await crypto.subtle.importKey('raw', key.publicKey, { name: 'X25519' }, true, [])
    const theirs = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: ourPublic }, peer.privateKey, 256))
    expect(ours).toEqual(theirs)
  })

  it('refuses a file whose halves belong to different keys', async () => {
    // The case that matters: the public half is what gets written into a
    // drone, and on a sealed drone it cannot be corrected.
    const a = await makeFile()
    const b = await makeFile()
    const mixed = JSON.stringify({
      ...JSON.parse(a.text),
      public_key: JSON.parse(b.text).public_key,
    })
    await expect(importOwnerKey(parseOwnerKeyFile(mixed))).rejects.toThrow(/don't belong together/)
  })

  it('rejects what it does not understand rather than guessing', async () => {
    expect(() => parseOwnerKeyFile('not json')).toThrow(/isn't an owner key file/)
    expect(() => parseOwnerKeyFile('{"schema":"sfd-owner/2"}')).toThrow(/this version understands/)
    expect(() => parseOwnerKeyFile('{"schema":"sfd-owner/1"}')).toThrow(/missing its keys/)
    const short = JSON.stringify({ schema: 'sfd-owner/1', public_key: b64(new Uint8Array(31)), private_key: b64(new Uint8Array(48)) })
    expect(() => parseOwnerKeyFile(short)).toThrow(/31 bytes; it should be 32/)
  })

  it('gives a stable short fingerprint', async () => {
    const key = new Uint8Array(32).fill(7)
    const a = await ownerFingerprint(key)
    expect(a).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
    expect(await ownerFingerprint(key)).toBe(a)
    const other = new Uint8Array(32).fill(8)
    expect(await ownerFingerprint(other)).not.toBe(a)
  })
})
