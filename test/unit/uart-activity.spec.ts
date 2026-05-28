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

// Activity classification matrix. The four ActivityClasses crossed
// with "protocol assigned or not" + the SERIAL0 special case give the
// findings the table renders; we pin each cell of the matrix so the
// operator copy doesn't drift on a refactor.

import type { ConnectionRow } from '../../src/workflow/connections'
import type { UartInfo } from '../../src/workflow/uart-info'
import { describe, expect, it } from 'vitest'
import { protocolLabel } from '../../src/workflow/serial-protocols'
import { classifyActivity, classifyFinding } from '../../src/workflow/uart-activity'

function uart(overrides: Partial<UartInfo> = {}): UartInfo {
  return {
    logical: 'SERIAL2',
    index: 2,
    physical: 'USART2',
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

describe('classifyActivity', () => {
  it('returns "unknown" when the sample window is too short', () => {
    expect(classifyActivity(uart(), uart({ rxBytes: 100 }), 200)).toBe('unknown')
  })

  it('returns "active" when RX bytes grew', () => {
    expect(classifyActivity(uart({ rxBytes: 10 }), uart({ rxBytes: 50 }), 4000)).toBe('active')
  })

  it('returns "outbound-only" when only TX bytes grew', () => {
    expect(classifyActivity(uart({ txBytes: 10 }), uart({ txBytes: 90 }), 4000)).toBe('outbound-only')
  })

  it('returns "silent" when neither moved', () => {
    expect(classifyActivity(uart({ txBytes: 5, rxBytes: 5 }), uart({ txBytes: 5, rxBytes: 5 }), 4000)).toBe('silent')
  })

  it('treats RX growth + TX growth as "active" (RX wins)', () => {
    expect(classifyActivity(uart(), uart({ rxBytes: 1, txBytes: 1 }), 4000)).toBe('active')
  })
})

describe('classifyFinding', () => {
  it('flags SERIAL0 as the GCS link regardless of activity', () => {
    const r = row({ uart: { logical: 'SERIAL0', index: 0, physical: 'OTG1' }, protocol: 2 })
    const finding = classifyFinding(r, 'active')
    expect(finding.status).toBe('gcs')
    expect(finding.label).toMatch(/Talking to this tool/)
  })

  it('marks active + configured as ok', () => {
    const r = row({ protocol: 5 })
    const finding = classifyFinding(r, 'active')
    expect(finding.status).toBe('ok')
    expect(finding.detail).toMatch(/GPS/)
  })

  it('marks active + no protocol as misconfigured (something\'s plugged in)', () => {
    const r = row({ protocol: -1 })
    const finding = classifyFinding(r, 'active')
    expect(finding.status).toBe('misconfigured')
    expect(finding.label).toMatch(/plugged in/i)
  })

  it('treats Console (0) the same as None (-1) — no protocol assigned', () => {
    const r = row({ protocol: 0 })
    expect(classifyFinding(r, 'active').status).toBe('misconfigured')
    expect(classifyFinding(r, 'silent').status).toBe('unused')
  })

  it('marks outbound-only + configured as one-way (DJI OSD case)', () => {
    const r = row({ protocol: 42 }) // MSP DisplayPort
    const finding = classifyFinding(r, 'outbound-only')
    expect(finding.status).toBe('outbound')
    expect(finding.detail).toMatch(/one-way/)
  })

  it('marks silent + configured as quiet (could be normal e.g. idle ESC tel)', () => {
    const r = row({ protocol: 16 }) // ESC telemetry
    const finding = classifyFinding(r, 'silent')
    expect(finding.status).toBe('quiet')
    expect(finding.label).toMatch(/ESC telemetry/)
    expect(finding.detail).toMatch(/only talks when active/i)
  })

  it('marks silent + no protocol as unused', () => {
    const r = row({ protocol: -1 })
    const finding = classifyFinding(r, 'silent')
    expect(finding.status).toBe('unused')
  })

  it('reports pending while the sample window hasn\'t closed', () => {
    const r = row({ protocol: 5 })
    const finding = classifyFinding(r, 'unknown')
    expect(finding.status).toBe('pending')
    expect(finding.label).toMatch(/Checking/)
  })

  it('uses the operator-facing protocol label in detail copy', () => {
    const r = row({ protocol: 29 }) // CRSF / ELRS
    const finding = classifyFinding(r, 'active')
    expect(finding.detail).toMatch(/CRSF \/ ELRS/)
  })
})
