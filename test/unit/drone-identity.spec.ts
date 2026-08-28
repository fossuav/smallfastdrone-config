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

// Unit tests for the drone identity file. The round trip and the shape
// are the contract: SFD encrypts applets against this document, and the
// firmware repo's sfd_identity.py writes the same one, so a byte that
// changes meaning on the way through means applets no drone can open.

import type { DroneIdentity } from '../../src/protocol/secure-command'
import { describe, expect, it } from 'vitest'
import {
  buildIdentityFile,
  IDENTITY_SCHEMA,
  identityFilename,
  identityFromFile,
  identityMatchesFc,
  identityUidHex,
  parseIdentityFile,
  sameIdentity,
  serializeIdentityFile,
} from '../../src/workflow/drone-identity'

const ENABLED_AT = '2026-08-28T14:05:09Z'

// uid 0x3f 0x00 0x25 ... (a real-looking STM32 UID), key 100..131.
function identity(): DroneIdentity {
  const uid = Uint8Array.from([0x3F, 0x00, 0x25, 0x00, 0x0E, 0x51, 0x34, 0x32, 0x33, 0x35, 0x31, 0x32])
  const publicKey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) publicKey[i] = 100 + i
  return { uid, publicKey }
}
const UID_HEX = '3f0025000e51343233353132'

describe('buildIdentityFile', () => {
  it('renders uid as lower-case hex and the key as base64', () => {
    const file = buildIdentityFile(identity(), 1063, ENABLED_AT)
    expect(file.schema).toBe(IDENTITY_SCHEMA)
    expect(file.uid).toBe(UID_HEX)
    expect(file.public_key).toHaveLength(44)
    expect(file.public_key).toBe(btoa(String.fromCharCode(...identity().publicKey)))
    expect(file.board_id).toBe(1063)
    expect(file.enabled_at).toBe(ENABLED_AT)
  })

  it('keeps a null board id as null rather than dropping it', () => {
    const text = serializeIdentityFile(buildIdentityFile(identity(), null, ENABLED_AT))
    expect(text).toContain('"board_id": null')
  })
})

describe('serializeIdentityFile', () => {
  it('writes indented JSON with a trailing newline, fields in contract order', () => {
    const text = serializeIdentityFile(buildIdentityFile(identity(), 1063, ENABLED_AT))
    expect(text.endsWith('}\n')).toBe(true)
    const keys = Object.keys(JSON.parse(text))
    expect(keys).toEqual(['schema', 'uid', 'public_key', 'board_id', 'enabled_at'])
  })
})

describe('parseIdentityFile', () => {
  it('round-trips what buildIdentityFile produced', () => {
    const file = buildIdentityFile(identity(), 1063, ENABLED_AT)
    expect(parseIdentityFile(serializeIdentityFile(file))).toEqual(file)
  })

  it('reads the file sfd_identity.py writes', () => {
    // As the firmware repo's probe emits it: json.dump(indent=2) of the
    // same five fields, uid from bytes.hex(), key from b64encode.
    const text = `{
  "schema": "sfd-identity/1",
  "uid": "${UID_HEX}",
  "public_key": "${btoa(String.fromCharCode(...identity().publicKey))}",
  "board_id": 1063,
  "enabled_at": "2026-08-28T14:05:09Z"
}
`
    const file = parseIdentityFile(text)
    expect(sameIdentity(identityFromFile(file), identity())).toBe(true)
    expect(file.board_id).toBe(1063)
  })

  it('normalises an upper-case uid', () => {
    const file = buildIdentityFile(identity(), null, ENABLED_AT)
    const text = serializeIdentityFile({ ...file, uid: file.uid.toUpperCase() })
    expect(parseIdentityFile(text).uid).toBe(UID_HEX)
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseIdentityFile('not json')).toThrow(/isn't readable/)
  })

  it('rejects an unrelated document and a newer schema differently', () => {
    expect(() => parseIdentityFile('{"schema":"sfd-param-backup/1"}')).toThrow(/isn't a drone identity/)
    expect(() => parseIdentityFile('{"schema":"sfd-identity/2"}')).toThrow(/newer version/)
  })

  it('rejects a damaged uid', () => {
    const file = buildIdentityFile(identity(), null, ENABLED_AT)
    expect(() => parseIdentityFile(serializeIdentityFile({ ...file, uid: 'abc' }))).toThrow(/drone id/)
    expect(() => parseIdentityFile(serializeIdentityFile({ ...file, uid: `${UID_HEX.slice(0, 22)}zz` }))).toThrow(/drone id/)
  })

  it('rejects a key that is not base64 or not 32 bytes', () => {
    const file = buildIdentityFile(identity(), null, ENABLED_AT)
    expect(() => parseIdentityFile(serializeIdentityFile({ ...file, public_key: '***' }))).toThrow(/public key/)
    expect(() => parseIdentityFile(serializeIdentityFile({ ...file, public_key: btoa('short') }))).toThrow(/public key/)
  })

  it('rejects a missing enable date and a non-numeric board id', () => {
    const file = buildIdentityFile(identity(), null, ENABLED_AT)
    const noDate = { ...file } as Record<string, unknown>
    delete noDate.enabled_at
    expect(() => parseIdentityFile(JSON.stringify(noDate))).toThrow(/enable date/)
    expect(() => parseIdentityFile(JSON.stringify({ ...file, board_id: 'x' }))).toThrow(/board id/)
  })
})

describe('identity comparisons', () => {
  it('identityFromFile restores the exact bytes', () => {
    const file = buildIdentityFile(identity(), null, ENABLED_AT)
    const back = identityFromFile(file)
    expect(Array.from(back.uid)).toEqual(Array.from(identity().uid))
    expect(Array.from(back.publicKey)).toEqual(Array.from(identity().publicKey))
  })

  it('sameIdentity is byte-for-byte on both halves', () => {
    const a = identity()
    const b = identity()
    expect(sameIdentity(a, b)).toBe(true)
    b.publicKey[31] = 0
    expect(sameIdentity(a, b)).toBe(false)
    const c = identity()
    c.uid[0] = 0
    expect(sameIdentity(a, c)).toBe(false)
  })

  it('identityMatchesFc accepts the session uid the identity is a prefix of', () => {
    // AUTOPILOT_VERSION uid2 is the 12-byte UID padded to 18 bytes, and
    // the session store renders all 18.
    expect(identityMatchesFc(identity(), `${UID_HEX}000000000000`)).toBe(true)
    expect(identityMatchesFc(identity(), `${UID_HEX.toUpperCase()}000000000000`)).toBe(true)
    expect(identityMatchesFc(identity(), `ff${UID_HEX.slice(2)}000000000000`)).toBe(false)
    expect(identityMatchesFc(identity(), null)).toBe(true)
  })

  it('identityUidHex and identityFilename carry the uid', () => {
    expect(identityUidHex(identity())).toBe(UID_HEX)
    expect(identityFilename(buildIdentityFile(identity(), null, ENABLED_AT))).toBe(`sfd-identity-${UID_HEX}.json`)
  })
})
