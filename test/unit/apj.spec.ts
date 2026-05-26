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

// Unit tests for src/protocol/apj.ts. Synthesizes .apj fixtures
// in-test (gzip + base64 + JSON-wrap) so we don't ship binary firmware
// blobs in the repo and the round-trip parser-vs-builder consistency
// is exercised directly.

import { describe, expect, it } from 'vitest'
import { parseApj } from '../../src/protocol/apj'

// Gzip a buffer the same way the parser ungzips it — browser-native
// CompressionStream. Bun ships this; Vitest's runtime uses Bun. Same
// ArrayBuffer-copy workaround as parseApj's gunzip for the strict-TS
// Uint8Array generic flavour.
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = new ArrayBuffer(bytes.byteLength)
  const fresh = new Uint8Array(buf)
  fresh.set(bytes)
  const stream = new Blob([fresh]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function base64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

// Build a valid .apj JSON string wrapping the given raw image bytes.
async function makeApj(image: Uint8Array, overrides: Record<string, unknown> = {}): Promise<string> {
  const gz = await gzip(image)
  const body: Record<string, unknown> = {
    board_id: 50,
    magic: 'APJFWv1',
    description: 'Test firmware',
    summary: 'ArduCopter V4.7.0-test',
    git_identity: 'abc1234',
    image: base64Encode(gz),
    image_size: image.length,
    ...overrides,
  }
  return JSON.stringify(body)
}

describe('parseApj', () => {
  it('parses a valid synthetic firmware', async () => {
    const image = new Uint8Array([0x01, 0x02, 0x03, 0xFE, 0xFF])
    const apj = await makeApj(image)
    const result = await parseApj(apj)
    expect(result.boardId).toBe(50)
    expect(result.description).toBe('Test firmware')
    expect(result.summary).toBe('ArduCopter V4.7.0-test')
    expect(result.gitIdentity).toBe('abc1234')
    expect(result.imageSize).toBe(5)
    expect(Array.from(result.image)).toEqual([0x01, 0x02, 0x03, 0xFE, 0xFF])
  })

  it('round-trips a larger image (gzip + base64 + parse → identical bytes)', async () => {
    // 4 KB of pseudo-random-ish data — exercises the gunzip stream beyond
    // a tiny payload.
    const image = new Uint8Array(4096)
    for (let i = 0; i < image.length; i++)
      image[i] = (i * 31 + 7) & 0xFF
    const apj = await makeApj(image)
    const result = await parseApj(apj)
    expect(result.imageSize).toBe(4096)
    expect(Array.from(result.image)).toEqual(Array.from(image))
  })

  it('accepts a .apj with no summary / git_identity (optional fields)', async () => {
    const image = new Uint8Array([0xAA])
    // Build the wire by hand to omit the optional fields.
    const gz = await gzip(image)
    const apj = JSON.stringify({
      board_id: 9,
      magic: 'APJFWv1',
      description: 'Bare firmware',
      image: base64Encode(gz),
    })
    const result = await parseApj(apj)
    expect(result.boardId).toBe(9)
    expect(result.description).toBe('Bare firmware')
    expect(result.summary).toBeUndefined()
    expect(result.gitIdentity).toBeUndefined()
  })

  it('rejects non-JSON content', async () => {
    await expect(parseApj('not json at all')).rejects.toThrow(/doesn't look like a firmware file/)
  })

  it('rejects a JSON file with the wrong magic', async () => {
    const apj = JSON.stringify({ board_id: 50, magic: 'WRONG', image: 'AA==' })
    await expect(parseApj(apj)).rejects.toThrow(/Not a SmallFastDrone firmware file/)
  })

  it('rejects a JSON file with no magic at all', async () => {
    const apj = JSON.stringify({ board_id: 50, image: 'AA==' })
    await expect(parseApj(apj)).rejects.toThrow(/Not a SmallFastDrone firmware file/)
  })

  it('rejects a file with a missing board_id', async () => {
    const apj = JSON.stringify({ magic: 'APJFWv1', image: 'AA==' })
    await expect(parseApj(apj)).rejects.toThrow(/missing its board id/)
  })

  it('rejects a file with non-numeric board_id', async () => {
    const apj = JSON.stringify({ magic: 'APJFWv1', board_id: 'fifty', image: 'AA==' })
    await expect(parseApj(apj)).rejects.toThrow(/missing its board id/)
  })

  it('rejects a file with no image data', async () => {
    const apj = JSON.stringify({ magic: 'APJFWv1', board_id: 50 })
    await expect(parseApj(apj)).rejects.toThrow(/missing its image data/)
  })

  it('rejects an image that isn\'t a valid gzip stream', async () => {
    // Valid base64 but not gzip-framed → DecompressionStream throws.
    const apj = JSON.stringify({
      magic: 'APJFWv1',
      board_id: 50,
      image: base64Encode(new Uint8Array([0, 1, 2, 3, 4, 5])),
    })
    await expect(parseApj(apj)).rejects.toThrow(/corrupt \(not a valid gzip stream\)/)
  })
})
