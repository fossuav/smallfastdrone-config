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

// DFU primitives — pure framing + descriptor parsing. The protocol
// client (`dfu-client.spec.ts`) and the workflow exercise the full
// sequence; this file covers the pieces in isolation.

import { describe, expect, it } from 'vitest'
import {
  buildErasePagePayload,
  buildMassErasePayload,
  buildReadUnprotectPayload,
  buildSetAddressPayload,
  combineFlashLayouts,
  describeMemoryLayouts,
  DFU_STATE,
  DFU_STATUS,
  parseDfuseLayout,
  parseStatus,
  planSectorErase,
  regionCoveredBySectors,
  stateLabel,
  statusLabel,
} from '../../src/protocol/dfu'

describe('command payload builders', () => {
  it('encodes SET_ADDRESS as 0x21 + LE 32-bit address', () => {
    const p = buildSetAddressPayload(0x08020000)
    expect(Array.from(p)).toEqual([0x21, 0x00, 0x00, 0x02, 0x08])
  })

  it('encodes ERASE_PAGE as 0x41 + LE 32-bit address', () => {
    const p = buildErasePagePayload(0x08020000)
    expect(Array.from(p)).toEqual([0x41, 0x00, 0x00, 0x02, 0x08])
  })

  it('encodes mass erase as the bare 0x41 byte', () => {
    expect(Array.from(buildMassErasePayload())).toEqual([0x41])
  })
})

describe('parseStatus', () => {
  it('parses a typical OK/dfuDNLOAD_IDLE reply', () => {
    // [status=OK, pollTimeout=100ms LE, state=dfuDNLOAD_IDLE, iString=0]
    const reply = new Uint8Array([0x00, 0x64, 0x00, 0x00, DFU_STATE.dfuDNLOAD_IDLE, 0])
    const s = parseStatus(reply)
    expect(s.status).toBe(DFU_STATUS.OK)
    expect(s.pollTimeoutMs).toBe(100)
    expect(s.state).toBe(DFU_STATE.dfuDNLOAD_IDLE)
  })

  it('decodes a 24-bit pollTimeout (>255 ms)', () => {
    // 0x00FA00 = 64000 ms.
    const reply = new Uint8Array([0x00, 0x00, 0xFA, 0x00, DFU_STATE.dfuDNBUSY, 0])
    expect(parseStatus(reply).pollTimeoutMs).toBe(0x00FA00)
  })

  it('throws on a short reply', () => {
    expect(() => parseStatus(new Uint8Array([0, 0]))).toThrow(/too short/)
  })
})

describe('statusLabel / stateLabel', () => {
  it('names known status codes', () => {
    expect(statusLabel(DFU_STATUS.OK)).toBe('OK')
    expect(statusLabel(DFU_STATUS.errERASE)).toBe('errERASE')
  })

  it('falls back to a hex tag for unknown codes', () => {
    expect(statusLabel(0x7F)).toMatch(/unknown/)
  })

  it('names known states', () => {
    expect(stateLabel(DFU_STATE.dfuIDLE)).toBe('dfuIDLE')
    expect(stateLabel(DFU_STATE.dfuERROR)).toBe('dfuERROR')
  })
})

describe('parseDfuseLayout', () => {
  it('parses a uniform-sector H7 layout', () => {
    const layout = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')
    expect(layout).not.toBeNull()
    expect(layout!.name).toBe('Internal Flash')
    expect(layout!.startAddress).toBe(0x08000000)
    expect(layout!.sectors).toHaveLength(16)
    expect(layout!.sectors[0]).toEqual({
      startAddress: 0x08000000,
      size: 128 * 1024,
      capability: 'g',
    })
    expect(layout!.sectors[15]!.startAddress).toBe(0x08000000 + 15 * 128 * 1024)
  })

  it('parses a non-uniform F4 layout (4 small + 1 medium + N large)', () => {
    // F405 classic: 4×16K, 1×64K, 7×128K = total 1MB.
    const layout = parseDfuseLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg')
    expect(layout!.sectors).toHaveLength(12)
    expect(layout!.sectors[0]!.size).toBe(16 * 1024)
    expect(layout!.sectors[3]!.size).toBe(16 * 1024)
    expect(layout!.sectors[4]!.size).toBe(64 * 1024)
    expect(layout!.sectors[5]!.size).toBe(128 * 1024)
    const totalKb = layout!.sectors.reduce((a, s) => a + s.size / 1024, 0)
    expect(totalKb).toBe(4 * 16 + 64 + 7 * 128)
  })

  it('parses option-bytes-style layouts (read/only capabilities)', () => {
    const layout = parseDfuseLayout('@Option Bytes  /0x1FFF7800/01*16 e')
    // The space + 'e' capability is read+erase. Our parser tolerates
    // optional internal whitespace.
    expect(layout!.sectors[0]!.capability).toBe('e')
  })

  it('returns null for a non-DfuSe string (no leading @)', () => {
    expect(parseDfuseLayout('Random interface name')).toBeNull()
  })

  it('throws on a malformed layout', () => {
    expect(() => parseDfuseLayout('@Bad  /0x08000000/something')).toThrow(/unparseable run/)
  })
})

describe('planSectorErase', () => {
  // 16×128KB H7-style layout.
  const h7 = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')!

  it('selects only the sectors covered by the regions', () => {
    // App region at 0x08020000 (sector 1), 250KB long → crosses into
    // sector 2 (0x08040000) but stops in sector 2.
    const sectors = planSectorErase(h7, [{ address: 0x08020000, length: 250 * 1024 }])
    expect(sectors).toEqual([0x08020000, 0x08040000])
  })

  it('coalesces overlapping requests (no duplicates)', () => {
    const sectors = planSectorErase(h7, [
      { address: 0x08020000, length: 64 * 1024 },
      { address: 0x08020000 + 32 * 1024, length: 64 * 1024 }, // overlaps sector 1
    ])
    expect(sectors).toEqual([0x08020000])
  })

  it('skips read-only sectors', () => {
    // Synthetic layout: 1×16K writable + 1×16K read-only.
    const mixed = parseDfuseLayout('@Mixed  /0x08000000/01*16Kg,01*16Kr')!
    const sectors = planSectorErase(mixed, [{ address: 0x08000000, length: 32 * 1024 }])
    expect(sectors).toEqual([0x08000000]) // only the 'g' sector
  })

  it('returns sectors in ascending address order', () => {
    const sectors = planSectorErase(h7, [
      { address: 0x08100000, length: 32 * 1024 }, // sector 8
      { address: 0x08000000, length: 32 * 1024 }, // sector 0
      { address: 0x08020000, length: 32 * 1024 }, // sector 1
    ])
    expect(sectors).toEqual([0x08000000, 0x08020000, 0x08100000])
  })
})

describe('combineFlashLayouts', () => {
  it('merges all writable sectors across layouts, sorted by address', () => {
    // Dual-bank H7 split across two alt-settings.
    const bank0 = parseDfuseLayout('@Internal Flash Bank 0  /0x08000000/08*128Kg')!
    const bank1 = parseDfuseLayout('@Internal Flash Bank 1  /0x08100000/08*128Kg')!
    // Option bytes (read-only — should be excluded).
    const opt = parseDfuseLayout('@Option Bytes  /0x5200201c/01*32 e')!

    const combined = combineFlashLayouts([bank0, opt, bank1])
    expect(combined.sectors).toHaveLength(16 + 1) // 8 + 8 flash + 1 option-bytes 'e'
    expect(combined.startAddress).toBe(0x08000000)
    // Sectors are sorted by address.
    for (let i = 1; i < combined.sectors.length; i++) {
      expect(combined.sectors[i]!.startAddress).toBeGreaterThanOrEqual(
        combined.sectors[i - 1]!.startAddress,
      )
    }
  })

  it('drops read-only sectors (capability r / a)', () => {
    const readonly = parseDfuseLayout('@Locked  /0x08000000/04*16Kr')!
    const combined = combineFlashLayouts([readonly])
    expect(combined.sectors).toHaveLength(0)
  })

  it('returns an empty layout when nothing is writable', () => {
    const combined = combineFlashLayouts([])
    expect(combined.sectors).toHaveLength(0)
    expect(combined.startAddress).toBe(0)
  })
})

describe('regionCoveredBySectors', () => {
  it('returns true when a region fits inside a contiguous run of sectors', () => {
    const h7 = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')!
    expect(regionCoveredBySectors(h7, { address: 0x08020000, length: 1_500_000 })).toBe(true)
  })

  it('returns true when a region spans a dual-bank combined layout', () => {
    // Bank 0: 0x08000000..0x08100000 (1MB). Bank 1: 0x08100000..0x08200000 (1MB).
    const bank0 = parseDfuseLayout('@Internal Flash Bank 0  /0x08000000/08*128Kg')!
    const bank1 = parseDfuseLayout('@Internal Flash Bank 1  /0x08100000/08*128Kg')!
    const combined = combineFlashLayouts([bank0, bank1])
    // 1.5 MB image starting at app offset 0x20000 — crosses the bank boundary.
    expect(regionCoveredBySectors(combined, { address: 0x08020000, length: 1_500_000 })).toBe(true)
  })

  it('returns false when there is a gap between sectors covering the region', () => {
    // Two flash regions with a gap between them.
    const split = parseDfuseLayout('@Split  /0x08000000/04*16Kg')! // 0x08000000..0x08010000
    const other = parseDfuseLayout('@Other  /0x08100000/04*16Kg')! // 0x08100000..0x08110000
    const combined = combineFlashLayouts([split, other])
    // Region straddles the gap (0x08010000..0x08100000 is unmapped).
    expect(regionCoveredBySectors(combined, { address: 0x08000000, length: 0x110000 })).toBe(false)
  })

  it('returns false when the region starts before any sector', () => {
    const h7 = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')!
    expect(regionCoveredBySectors(h7, { address: 0x07000000, length: 100 })).toBe(false)
  })

  it('returns false when the region extends past the last sector', () => {
    const small = parseDfuseLayout('@Small  /0x08000000/01*16Kg')!
    expect(regionCoveredBySectors(small, { address: 0x08000000, length: 32 * 1024 })).toBe(false)
  })

  it('returns true for an empty region', () => {
    const h7 = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')!
    expect(regionCoveredBySectors(h7, { address: 0x08020000, length: 0 })).toBe(true)
  })
})

describe('describeMemoryLayouts', () => {
  it('produces a human-readable summary with address ranges + size', () => {
    const h7 = parseDfuseLayout('@Internal Flash  /0x08000000/16*128Kg')!
    const desc = describeMemoryLayouts([h7])
    expect(desc).toContain('"Internal Flash"')
    expect(desc).toContain('0x08000000')
    expect(desc).toContain('0x08200000')
    expect(desc).toContain('2048 KB')
  })

  it('handles the empty case', () => {
    expect(describeMemoryLayouts([])).toMatch(/no memory layouts/)
  })
})

describe('buildReadUnprotectPayload', () => {
  it('is the lone 0x92 command byte, never an option-byte write', () => {
    // Programming the RDP field by hand risks writing 0xCC (Level 2),
    // which is irreversible. Handing the request to the bootloader means
    // that value is never encoded anywhere in this codebase.
    expect([...buildReadUnprotectPayload()]).toEqual([0x92])
  })
})
