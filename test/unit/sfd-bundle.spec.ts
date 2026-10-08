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

// Reading a script product's packing list. The fixture was written by
// the firmware repo's pack_lua.py, so the first test is the two halves
// agreeing on the format; the rest build bundles by hand to reach every
// refusal.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LXA_HEADER_LEN } from '../../src/protocol/lxa'
import { bundleMatchesFc, looksLikeBundle, parseBundle } from '../../src/protocol/sfd-bundle'

const UID = '350053000551333530343432'

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))
}

// A .lxa addressed to uidHex, ciphertext we neither read nor could.
function lxa(uidHex = UID): Uint8Array {
  const bytes = new Uint8Array(LXA_HEADER_LEN + 16)
  bytes.set(new TextEncoder().encode('LXA2.0'), 0)
  for (let i = 0; i < 12; i++)
    bytes[6 + i] = Number.parseInt(uidHex.slice(i * 2, i * 2 + 2), 16)
  bytes.fill(0xAB, 18)
  return bytes
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// A bundle as pack_lua.py lays one out, with any field overridden.
function bundle(over: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: 'sfd-bundle/1',
    product: 'acro_fence',
    title: 'Acro fence',
    uid: UID,
    files: [{ path: 'scripts/acro_fence.lxa', data: b64(lxa()) }],
    ...over,
  }))
}

describe('sfd-bundle', () => {
  it('reads what pack_lua.py writes', () => {
    const b = parseBundle(fixture('sfd-bundle-two-files.sfdbundle'))
    expect(b.product).toBe('fixture_product')
    expect(b.title).toBe('Fixture product')
    expect(b.version).toBe('pack_lua fixture')
    expect(b.uid).toBe(UID)
    expect(b.files.map(f => [f.path, f.dir, f.stem])).toEqual([
      ['scripts/fixture_app.lxa', 'APM/scripts', 'fixture_app'],
      ['scripts/modules/fixture_helper.lxa', 'APM/scripts/modules', 'fixture_helper'],
    ])
    // each member is the whole .lxa, header included, ready to upload
    expect(b.files.every(f => new TextDecoder().decode(f.bytes.subarray(0, 6)) === 'LXA2.0')).toBe(true)
  })

  it('tells a bundle from a single applet', () => {
    expect(looksLikeBundle(fixture('sfd-bundle-two-files.sfdbundle'))).toBe(true)
    expect(looksLikeBundle(new TextEncoder().encode('\n  {"schema":'))).toBe(true)
    expect(looksLikeBundle(lxa())).toBe(false)
    expect(looksLikeBundle(new Uint8Array(0))).toBe(false)
  })

  it('treats a missing version as unknown, not an error', () => {
    expect(parseBundle(bundle()).version).toBeNull()
  })

  it('refuses something that is not a bundle at all', () => {
    expect(() => parseBundle(new TextEncoder().encode('not json'))).toThrow(/isn't a script package/)
    expect(() => parseBundle(bundle({ schema: 'sfd-identity/1' }))).toThrow(/isn't a script package/)
  })

  it('refuses an incomplete label', () => {
    expect(() => parseBundle(bundle({ product: 'acro-fence' }))).toThrow(/label is incomplete/)
    expect(() => parseBundle(bundle({ title: '  ' }))).toThrow(/label is incomplete/)
    expect(() => parseBundle(bundle({ uid: 'ABCD' }))).toThrow(/label is incomplete/)
    expect(() => parseBundle(bundle({ version: 3 }))).toThrow(/label is incomplete/)
    expect(() => parseBundle(bundle({ files: [] }))).toThrow(/nothing in it/)
  })

  it('puts files only where scripts load from', () => {
    for (const path of [
      'scripts/../evil.lxa',
      'scripts/a.lua',
      'scripts/modules/deeper/a.lxa',
      'logs/a.lxa',
      '/APM/scripts/a.lxa',
      'scripts/a-b.lxa',
    ]) {
      expect(() => parseBundle(bundle({ files: [{ path, data: b64(lxa()) }] })), path)
        .toThrow(/somewhere scripts don't go/)
    }
  })

  it('refuses a member that is not an applet, or not for the drone on the label', () => {
    const at = (data: string): Uint8Array => bundle({ files: [{ path: 'scripts/a.lxa', data }] })
    expect(() => parseBundle(at(b64(new TextEncoder().encode('-- plain lua'))))).toThrow(/isn't a scrambled applet/)
    expect(() => parseBundle(at('!!not base64!!'))).toThrow(/isn't a scrambled applet/)
    expect(() => parseBundle(at(b64(lxa('aabbccddeeff001122334455'))))).toThrow(/different drone than the package says/)
  })

  it('refuses the same file twice', () => {
    const file = { path: 'scripts/a.lxa', data: b64(lxa()) }
    expect(() => parseBundle(bundle({ files: [file, file] }))).toThrow(/lists scripts\/a.lxa twice/)
  })

  it('matches the connected drone on the uid prefix, as a single applet does', () => {
    const b = parseBundle(bundle())
    expect(bundleMatchesFc(b, `${UID}000000000000`)).toBe(true)
    expect(bundleMatchesFc(b, 'aabbccddeeff001122334455000000000000')).toBe(false)
    expect(bundleMatchesFc(b, null)).toBe(true)
  })
})
