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

// The identity mark exists so an operator can tell whether a saved file
// belongs to the drone in front of them. Its whole value is that the same
// key always looks the same and different keys look different, so that is
// what these pin.

import { describe, expect, it } from 'vitest'
import {
  identityFingerprint,
  identityMarkCells,
  MARK_COLUMNS,
  MARK_ROWS,
} from '../../src/workflow/identity-mark'

function key(fill: (i: number) => number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => fill(i))
}

// The real key generated on the bench, so the fixture is a shape the
// firmware actually produces.
const BENCH_KEY = Uint8Array.from(
  '24dd82cf316a5589d2bf55f29bde2aa5aaf725345b8cb6340162febf00373f5b'.match(/.{2}/g)!.map(h => Number.parseInt(h, 16)),
)

describe('identityMarkCells', () => {
  it('gives one cell per key byte', () => {
    expect(identityMarkCells(BENCH_KEY)).toHaveLength(MARK_COLUMNS * MARK_ROWS)
  })

  it('is deterministic — the same drone looks the same every time', () => {
    expect(identityMarkCells(BENCH_KEY)).toEqual(identityMarkCells(BENCH_KEY.slice()))
  })

  it('two different drones do not look the same', () => {
    const a = identityMarkCells(key(i => i))
    const b = identityMarkCells(key(i => i + 1))
    expect(a).not.toEqual(b)
  })

  it('carries a non-colour channel, so the mark reads without colour', () => {
    const cells = identityMarkCells(key(i => (i < 16 ? 0x00 : 0xFF)))
    expect(cells.slice(0, 16).every(c => !c.solid)).toBe(true)
    expect(cells.slice(16).every(c => c.solid)).toBe(true)
  })

  it('refuses a wrong-length key rather than drawing a partial mark', () => {
    // A half-drawn identity would invite the false match this prevents.
    expect(identityMarkCells(new Uint8Array(31))).toEqual([])
    expect(identityMarkCells(new Uint8Array(0))).toEqual([])
  })

  it('keeps hue in range for every possible byte', () => {
    for (const cells of [identityMarkCells(key(() => 0)), identityMarkCells(key(() => 255))]) {
      for (const c of cells) {
        expect(c.hue).toBeGreaterThanOrEqual(0)
        expect(c.hue).toBeLessThanOrEqual(360)
      }
    }
  })
})

describe('identityFingerprint', () => {
  it('groups the leading bytes so a person can actually compare them', () => {
    expect(identityFingerprint(BENCH_KEY)).toBe('24dd 82cf 316a 5589')
  })

  it('differs when the key differs', () => {
    expect(identityFingerprint(key(i => i))).not.toBe(identityFingerprint(key(i => i + 1)))
  })

  it('is empty for no key at all', () => {
    expect(identityFingerprint(new Uint8Array(0))).toBe('')
  })
})
