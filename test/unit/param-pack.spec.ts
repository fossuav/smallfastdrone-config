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

// Unit tests for the packed-parameter parser. Two layers: synthesised
// packs that exercise each branch of the format (name prefix sharing,
// every scalar type, padding, defaults present and absent), and a real
// capture from SITL — `@PARAM/param.pck?withdefaults=1`, 1396 params —
// that guards against the format being misread in a way a hand-built
// fixture would happily agree with.
//
// This parser decides what a settings backup contains, so a misread that
// dropped or mis-valued entries would silently produce a backup that
// can't restore the drone.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  changedParamNames,
  PARAM_PACK_TYPE,
  parseParamPack,
} from '../../src/protocol/param-pack'

const SITL_CAPTURE = new Uint8Array(
  readFileSync(fileURLToPath(new URL('./fixtures/param-pck-sitl.bin', import.meta.url))),
)

interface Entry {
  name: string
  type: number
  value: number
  defaultValue?: number
  padBefore?: number
}

// Build a pack the way AP_Filesystem_Param.cpp does: shared name prefixes,
// little-endian values, an optional default after the value.
function pack(entries: Entry[], magic = 0x671C): Uint8Array {
  const bytes: number[] = []
  const push16 = (v: number) => bytes.push(v & 0xFF, (v >> 8) & 0xFF)
  push16(magic)
  push16(entries.length)
  push16(entries.length)

  const sizeOf = (t: number) => (t === PARAM_PACK_TYPE.INT8 ? 1 : t === PARAM_PACK_TYPE.INT16 ? 2 : 4)
  const encode = (t: number, v: number): number[] => {
    const buf = new ArrayBuffer(sizeOf(t))
    const dv = new DataView(buf)
    if (t === PARAM_PACK_TYPE.INT8)
      dv.setInt8(0, v)
    else if (t === PARAM_PACK_TYPE.INT16)
      dv.setInt16(0, v, true)
    else if (t === PARAM_PACK_TYPE.INT32)
      dv.setInt32(0, v, true)
    else dv.setFloat32(0, v, true)
    return [...new Uint8Array(buf)]
  }

  let previous = ''
  for (const e of entries) {
    for (let i = 0; i < (e.padBefore ?? 0); i++) bytes.push(0)

    let common = 0
    while (common < previous.length && common < e.name.length
      && previous[common] === e.name[common] && common < 15) {
      common++
    }
    const suffix = e.name.slice(common)
    const hasDefault = e.defaultValue !== undefined
    bytes.push(e.type | ((hasDefault ? 1 : 0) << 4))
    bytes.push(common | ((suffix.length - 1) << 4))
    for (const ch of suffix) bytes.push(ch.charCodeAt(0))
    bytes.push(...encode(e.type, e.value))
    if (hasDefault)
      bytes.push(...encode(e.type, e.defaultValue!))
    previous = e.name
  }
  return new Uint8Array(bytes)
}

describe('parseParamPack', () => {
  it('reads the header and reports whether defaults are included', () => {
    const withDefaults = parseParamPack(pack([{ name: 'A', type: 1, value: 1 }]))
    const plain = parseParamPack(pack([{ name: 'A', type: 1, value: 1 }], 0x671B))

    expect(withDefaults.withDefaults).toBe(true)
    expect(plain.withDefaults).toBe(false)
    expect(withDefaults.totalParams).toBe(1)
  })

  it('decodes every scalar type, signed and little-endian', () => {
    const parsed = parseParamPack(pack([
      { name: 'AA', type: PARAM_PACK_TYPE.INT8, value: -5 },
      { name: 'AB', type: PARAM_PACK_TYPE.INT16, value: -3000 },
      { name: 'AC', type: PARAM_PACK_TYPE.INT32, value: -100000 },
      { name: 'AD', type: PARAM_PACK_TYPE.FLOAT, value: 0.5 },
    ]))

    expect(parsed.params.map(p => p.value)).toEqual([-5, -3000, -100000, 0.5])
  })

  it('reassembles names from the shared prefix of the previous entry', () => {
    const parsed = parseParamPack(pack([
      { name: 'SERIAL1_BAUD', type: 3, value: 57 },
      { name: 'SERIAL1_PROTOCOL', type: 1, value: 2 },
      { name: 'SERIAL2_BAUD', type: 3, value: 115 },
    ]))

    expect(parsed.params.map(p => p.name))
      .toEqual(['SERIAL1_BAUD', 'SERIAL1_PROTOCOL', 'SERIAL2_BAUD'])
  })

  it('attaches a default only where the firmware sent one', () => {
    const parsed = parseParamPack(pack([
      { name: 'AA', type: 1, value: 1, defaultValue: 0 },
      { name: 'AB', type: 1, value: 7 },
    ]))

    expect(parsed.params[0]!.defaultValue).toBe(0)
    expect(parsed.params[1]!.defaultValue).toBeNull()
  })

  it('skips the zero padding the firmware inserts between entries', () => {
    const parsed = parseParamPack(pack([
      { name: 'AA', type: PARAM_PACK_TYPE.INT8, value: 3 },
      { name: 'AB', type: PARAM_PACK_TYPE.FLOAT, value: 1.5, padBefore: 3 },
    ]))

    expect(parsed.params).toHaveLength(2)
    expect(parsed.params[1]).toMatchObject({ name: 'AB', value: 1.5 })
  })

  it('rejects a file that is too short to hold a header', () => {
    expect(() => parseParamPack(new Uint8Array([0x1B, 0x67]))).toThrow(/empty settings list/)
  })

  it('rejects an unknown magic rather than guessing', () => {
    expect(() => parseParamPack(pack([{ name: 'A', type: 1, value: 1 }], 0x1234)))
      .toThrow(/doesn't understand/)
  })

  it('rejects an unknown parameter type', () => {
    const bad = pack([{ name: 'AA', type: PARAM_PACK_TYPE.INT8, value: 1 }])
    bad[6] = 7 // AP_PARAM_GROUP — never valid in a scalar walk

    expect(() => parseParamPack(bad)).toThrow(/unknown kind/)
  })

  it('rejects a truncated entry instead of returning a partial set', () => {
    const full = pack([
      { name: 'AA', type: PARAM_PACK_TYPE.INT8, value: 1 },
      { name: 'AB', type: PARAM_PACK_TYPE.INT32, value: 99 },
    ])

    expect(() => parseParamPack(full.subarray(0, full.byteLength - 2)))
      .toThrow(/ended unexpectedly/)
  })
})

describe('changedParamNames', () => {
  it('returns the parameters that carry a default, meaning they were changed', () => {
    const parsed = parseParamPack(pack([
      { name: 'AA', type: 1, value: 1, defaultValue: 0 },
      { name: 'AB', type: 1, value: 7 },
      { name: 'AC', type: 1, value: 2, defaultValue: 1 },
    ]))

    expect(changedParamNames(parsed)).toEqual(new Set(['AA', 'AC']))
  })

  it('refuses a pack fetched without defaults, rather than answering "none"', () => {
    const plain = parseParamPack(pack([{ name: 'AA', type: 1, value: 1 }], 0x671B))

    expect(() => changedParamNames(plain)).toThrow(/didn't report which settings/)
  })
})

describe('against a real SITL capture', () => {
  it('parses every parameter the header promised', () => {
    const parsed = parseParamPack(SITL_CAPTURE)

    expect(parsed.withDefaults).toBe(true)
    expect(parsed.totalParams).toBe(1396)
    expect(parsed.params).toHaveLength(parsed.totalParams)
  })

  it('produces well-formed, unique parameter names', () => {
    const names = parseParamPack(SITL_CAPTURE).params.map(p => p.name)

    expect(names.every(n => /^[A-Z0-9_]+$/.test(n))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('FRAME_CLASS')
    expect(names).toContain('SCR_ENABLE')
  })

  it('reads the frame override SITL boots with as a changed value', () => {
    const parsed = parseParamPack(SITL_CAPTURE)
    const frameType = parsed.params.find(p => p.name === 'FRAME_TYPE')

    // scripts/sitl-start.sh writes FRAME_TYPE=1 over a firmware default
    // of 0, so this entry must carry both numbers.
    expect(frameType).toMatchObject({ value: 1, defaultValue: 0 })
  })

  it('finds far fewer changed parameters than total — the delta is the config', () => {
    const parsed = parseParamPack(SITL_CAPTURE)
    const changed = changedParamNames(parsed)

    expect(changed.size).toBeGreaterThan(0)
    expect(changed.size).toBeLessThan(parsed.params.length / 10)
    expect(changed.has('FRAME_TYPE')).toBe(true)
  })
})
