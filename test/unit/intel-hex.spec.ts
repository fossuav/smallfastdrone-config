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

// Intel-HEX parser unit tests — happy path + every operator-readable
// error case the firmware view needs to surface. The acceptance bar:
// for any malformed input, the thrown message reads as plain English
// to a non-expert operator (no "byte 0x04 of record 3" jargon).

import { describe, expect, it } from 'vitest'
import { parseIntelHex } from '../../src/protocol/intel-hex'

// Build an Intel-HEX record from a byte count + 16-bit address + type
// + data, computing the checksum automatically. Keeps the tests
// readable (the literal hex strings would be opaque otherwise).
function record(addr: number, type: number, data: number[] = []): string {
  const bytes: number[] = [data.length, (addr >> 8) & 0xFF, addr & 0xFF, type, ...data]
  let sum = 0
  for (const b of bytes) sum = (sum + b) & 0xFF
  const cs = ((-sum) & 0xFF)
  return `:${[...bytes, cs].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

const EOF = ':00000001FF' // canonical EOF record.

describe('parseIntelHex — happy path', () => {
  it('parses a single data record + EOF', () => {
    const text = `${record(0x0000, 0x00, [0xDE, 0xAD, 0xBE, 0xEF])}\n${EOF}\n`
    const parsed = parseIntelHex(text)
    expect(parsed.segments).toHaveLength(1)
    expect(parsed.segments[0]!.address).toBe(0x0000)
    expect(Array.from(parsed.segments[0]!.data)).toEqual([0xDE, 0xAD, 0xBE, 0xEF])
    expect(parsed.totalBytes).toBe(4)
    expect(parsed.startAddress).toBe(0)
    expect(parsed.endAddress).toBe(3)
  })

  it('coalesces contiguous records into a single segment', () => {
    const text = [
      record(0x0000, 0x00, [1, 2, 3, 4]),
      record(0x0004, 0x00, [5, 6, 7, 8]),
      record(0x0008, 0x00, [9, 10, 11, 12]),
      EOF,
    ].join('\n')
    const parsed = parseIntelHex(text)
    expect(parsed.segments).toHaveLength(1)
    expect(Array.from(parsed.segments[0]!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('honours type-04 extended linear address', () => {
    // 0x0800 at upper-16, then data at lower 0x0000 → absolute 0x08000000.
    const text = [
      record(0x0000, 0x04, [0x08, 0x00]),
      record(0x0000, 0x00, [0xAA, 0xBB]),
      EOF,
    ].join('\n')
    const parsed = parseIntelHex(text)
    expect(parsed.segments[0]!.address).toBe(0x08000000)
  })

  it('keeps non-adjacent segments separate (gap)', () => {
    const text = [
      record(0x0000, 0x00, [1, 2]),
      record(0x0010, 0x00, [3, 4]), // gap from 0x02 to 0x10
      EOF,
    ].join('\n')
    const parsed = parseIntelHex(text)
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0]!.address).toBe(0)
    expect(parsed.segments[1]!.address).toBe(0x10)
  })

  it('parses a multi-segment file with extended address (the with_bl shape)', () => {
    // Bootloader at 0x08000000, app at 0x08020000 — what
    // SFD's `_with_bl.hex` looks like in miniature.
    const text = [
      record(0x0000, 0x04, [0x08, 0x00]),
      record(0x0000, 0x00, [0xBB, 0xBB]), // bootloader stub
      record(0x0002, 0x00, [0xCC, 0xCC]), // adjacent → coalesced
      record(0x0000, 0x04, [0x08, 0x02]),
      record(0x0000, 0x00, [0xAA, 0xAA]), // app at +0x20000
      EOF,
    ].join('\n')
    const parsed = parseIntelHex(text)
    expect(parsed.segments).toHaveLength(2)
    expect(parsed.segments[0]!.address).toBe(0x08000000)
    expect(parsed.segments[0]!.data).toHaveLength(4)
    expect(parsed.segments[1]!.address).toBe(0x08020000)
    expect(parsed.totalBytes).toBe(6)
  })

  it('tolerates CRLF + trailing whitespace + blank lines', () => {
    const text = `\r\n${record(0, 0, [1, 2])}\r\n\r\n${EOF}\r\n\r\n`
    expect(parseIntelHex(text).totalBytes).toBe(2)
  })

  it('strips a UTF-8 BOM', () => {
    const text = `\uFEFF${record(0, 0, [1])}\n${EOF}\n`
    expect(parseIntelHex(text).totalBytes).toBe(1)
  })
})

describe('parseIntelHex — operator-readable errors', () => {
  it('refuses a missing EOF', () => {
    const text = `${record(0, 0, [1, 2])}\n`
    expect(() => parseIntelHex(text)).toThrow(/end-of-file marker/)
  })

  it('refuses a line that doesn\'t start with ":"', () => {
    const text = `garbage\n${record(0, 0, [1])}\n${EOF}\n`
    expect(() => parseIntelHex(text)).toThrow(/start with ":"/)
  })

  it('refuses non-hex characters', () => {
    const text = `:01000000ZZ00\n${EOF}\n`
    expect(() => parseIntelHex(text)).toThrow(/non-hex characters/)
  })

  it('refuses a bad checksum', () => {
    // record() gives a good checksum; flip one byte to break it.
    const good = record(0, 0, [1, 2])
    const bad = `${good.slice(0, -2)}00`
    const text = `${bad}\n${EOF}\n`
    expect(() => parseIntelHex(text)).toThrow(/checksum failed/)
  })

  it('refuses an unsupported record type', () => {
    // Type 0x02 (extended segment address) — out of scope for SFD.
    const text = `${record(0, 0x02, [0x12, 0x34])}\n${EOF}\n`
    expect(() => parseIntelHex(text)).toThrow(/0x02/)
  })

  it('refuses an empty file', () => {
    // EOF only, no data records.
    expect(() => parseIntelHex(`${EOF}\n`)).toThrow(/no data/)
  })

  it('refuses data after the EOF marker', () => {
    const text = `${record(0, 0, [1])}\n${EOF}\n${record(0x10, 0, [2])}\n`
    expect(() => parseIntelHex(text)).toThrow(/after end-of-file/)
  })

  it('refuses overlapping records', () => {
    const text = [
      record(0x0000, 0x00, [1, 2, 3, 4]),
      record(0x0002, 0x00, [5, 6]),
      EOF,
    ].join('\n')
    expect(() => parseIntelHex(text)).toThrow(/overlap/)
  })

  it('refuses a record whose byte-count doesn\'t match', () => {
    // Hand-craft: length byte says 2, but only 1 data byte follows.
    // Sum: 02 + 00 + 00 + 00 + 01 = 03 → checksum = 0xFD
    const text = `:0200000001FD\n${EOF}\n`
    expect(() => parseIntelHex(text)).toThrow(/byte count doesn't match|checksum/)
  })
})
