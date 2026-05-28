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

// Unit tests for the protocol-picker presets — pin the matcher (which
// preset corresponds to a given SERIALn_PROTOCOL value), the editable
// gate (SERIAL0 / IOMCU off-limits), and the buildEdit shape so the
// param names + values written for each preset can't drift silently
// (an off-by-one would mis-write SERIAL2_PROTOCOL instead of
// SERIAL3_PROTOCOL — silently bricks a config).

import type { ConnectionRow } from '../../src/workflow/connections'
import type { UartInfo } from '../../src/workflow/uart-info'
import { describe, expect, it } from 'vitest'
import {
  buildEdit,
  isEditable,
  presetById,
  presetForRow,
  SERIAL_PRESETS,
} from '../../src/workflow/serial-protocol-presets'
import { protocolLabel } from '../../src/workflow/serial-protocols'

function uart(overrides: Partial<UartInfo> = {}): UartInfo {
  return {
    logical: 'SERIAL3',
    index: 3,
    physical: 'USART3',
    txBytes: 0,
    rxBytes: 0,
    txBd: 0,
    rxBd: 0,
    txDma: false,
    rxDma: false,
    sitlConnected: undefined,
    descriptor: null,
    ...overrides,
  }
}

function row(overrides: Partial<ConnectionRow> & { uart?: Partial<UartInfo> } = {}): ConnectionRow {
  const u = uart(overrides.uart)
  const protocol = overrides.protocol ?? null
  return {
    uart: u,
    protocol,
    baud: overrides.baud ?? null,
    protocolLabel: protocolLabel(protocol),
    active: overrides.active ?? false,
  }
}

describe('the presets list', () => {
  it('has unique ids', () => {
    const ids = SERIAL_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has unique protocol values (no two presets map to the same protocol)', () => {
    const protos = SERIAL_PRESETS.map(p => p.protocol)
    expect(new Set(protos).size).toBe(protos.length)
  })

  it('includes Off, GPS, RC receiver, telem, ESC telem, DJI OSD', () => {
    const labels = SERIAL_PRESETS.map(p => p.label.toLowerCase())
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringMatching(/off/),
      expect.stringMatching(/gps/),
      expect.stringMatching(/rc receiver/),
      expect.stringMatching(/telemetry radio/),
      expect.stringMatching(/esc telemetry/),
      expect.stringMatching(/dji/),
    ]))
  })

  it('puts Off first so it\'s the obvious top choice', () => {
    expect(SERIAL_PRESETS[0]?.id).toBe('off')
  })
})

describe('presetById', () => {
  it('returns the preset for a known id', () => {
    expect(presetById('gps')?.protocol).toBe(5)
  })

  it('returns null for unknown ids', () => {
    expect(presetById('not-a-preset')).toBeNull()
  })
})

describe('presetForRow', () => {
  it('matches a known protocol value to its preset', () => {
    expect(presetForRow(row({ protocol: 5 }))?.id).toBe('gps')
    expect(presetForRow(row({ protocol: 23 }))?.id).toBe('rc-crsf')
    expect(presetForRow(row({ protocol: -1 }))?.id).toBe('off')
  })

  it('returns null when the current protocol isn\'t in the shortlist', () => {
    // Lua scripting = 28; we don't surface it as a picker option but
    // the row still renders fine, just without a preset match.
    expect(presetForRow(row({ protocol: 28 }))).toBeNull()
  })

  it('returns null for rows with no protocol param (IOMCU etc.)', () => {
    expect(presetForRow(row({ protocol: null }))).toBeNull()
  })
})

describe('isEditable', () => {
  it('blocks SERIAL0 (the USB / GCS link the operator is using)', () => {
    expect(isEditable(row({ uart: { logical: 'SERIAL0', index: 0 } }))).toBe(false)
  })

  it('blocks IOMCU rows (no SERIALn_PROTOCOL param to bind to)', () => {
    expect(isEditable(row({ uart: { logical: 'IOMCU', index: null } }))).toBe(false)
  })

  it('allows SERIAL1..SERIAL9', () => {
    for (let i = 1; i <= 9; i++)
      expect(isEditable(row({ uart: { logical: `SERIAL${i}`, index: i } }))).toBe(true)
  })
})

describe('buildEdit', () => {
  it('writes both SERIALn_PROTOCOL and SERIALn_BAUD with the preset values', () => {
    const r = row({ uart: { logical: 'SERIAL3', index: 3 } })
    const gps = presetById('gps')!
    const edit = buildEdit(r, gps)
    expect(edit).toEqual({
      protocolParam: 'SERIAL3_PROTOCOL',
      protocolValue: 5,
      baudParam: 'SERIAL3_BAUD',
      baudValue: 230400,
    })
  })

  it('uses the row\'s actual index (no off-by-one)', () => {
    const r = row({ uart: { logical: 'SERIAL7', index: 7 } })
    const edit = buildEdit(r, presetById('telem-mavlink')!)
    expect(edit?.protocolParam).toBe('SERIAL7_PROTOCOL')
    expect(edit?.baudParam).toBe('SERIAL7_BAUD')
  })

  it('returns null for non-editable rows (SERIAL0 / IOMCU)', () => {
    const off = presetById('off')!
    expect(buildEdit(row({ uart: { logical: 'SERIAL0', index: 0 } }), off)).toBeNull()
    expect(buildEdit(row({ uart: { logical: 'IOMCU', index: null } }), off)).toBeNull()
  })

  it('the Off preset sets protocol to -1 and baud to 0', () => {
    const r = row({ uart: { logical: 'SERIAL5', index: 5 } })
    const edit = buildEdit(r, presetById('off')!)
    expect(edit?.protocolValue).toBe(-1)
    expect(edit?.baudValue).toBe(0)
  })
})
