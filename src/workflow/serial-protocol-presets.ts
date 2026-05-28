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

// Operator-friendly choices for the per-row protocol picker. The
// SERIALn_PROTOCOL enum has 47 values, most of them irrelevant to a
// SmallFastDrone operator on a typical day. This file is the
// opinionated shortlist: the half-dozen things you actually plug into
// a flight controller, each paired with its recommended baud so
// picking "GPS" sets up SERIAL{n}_BAUD=38400 in one move.
//
// Picking a preset stages both the protocol AND the recommended baud
// — the operator-first promise is "you picked GPS, your drone now
// talks GPS correctly", not "you picked GPS, here are nine knobs to
// turn next." Operators who need non-standard baud rates are in
// expert-mode territory (slice 3 follow-up).

import type { ConnectionRow } from './connections'

// Enum values come from AP_SerialManager/AP_SerialManager.h:
//   None=-1, GPS=5, ESCTelemetry=16, RCIN=23, CRSF=29, MSP=32,
//   MAVLink2=2, MSP_DisplayPort=42.
// Baud values are firmware-default for that protocol unless noted.
export interface SerialProtocolPreset {
  // Stable id for radios / dropdowns. Never seen by the operator.
  id: string
  // What the operator sees in the picker.
  label: string
  // SERIALn_PROTOCOL value written when this preset is picked.
  protocol: number
  // Recommended SERIALn_BAUD value (firmware accepts kBd × 1000 or raw
  // baud; we write the raw form so MissionPlanner / QGC see the same
  // number we set). Use 0 when the protocol doesn't care (Off).
  baud: number
  // Optional one-liner shown beneath the picker option — context for
  // the operator deciding between e.g. "RC receiver (CRSF / ELRS)" and
  // "RC receiver (SBus)". Plain language, no protocol jargon.
  notes?: string
}

// The shortlist. Order matters — these render in the picker in order.
// Off goes first so "I don't want anything here" is the obvious top
// choice for a confused operator. The rest sorted by how often a
// SmallFastDrone bringup actually touches them.
export const SERIAL_PRESETS: readonly SerialProtocolPreset[] = [
  {
    id: 'off',
    label: 'Off',
    protocol: -1,
    baud: 0,
    notes: 'Nothing plugged in; port disabled.',
  },
  {
    id: 'gps',
    label: 'GPS',
    protocol: 5,
    baud: 230400,
    notes: 'Standard u-blox / NMEA GPS module.',
  },
  {
    id: 'rc-crsf',
    label: 'RC receiver (CRSF / ELRS)',
    protocol: 23,
    baud: 420000,
    notes: 'TBS Crossfire, ExpressLRS, Tracer.',
  },
  {
    id: 'telem-mavlink',
    label: 'Telemetry radio (MAVLink)',
    protocol: 2,
    baud: 57600,
    notes: '915 MHz / 433 MHz SiK / RFD radios.',
  },
  {
    id: 'esc-telem',
    label: 'ESC telemetry',
    protocol: 16,
    baud: 115200,
    notes: 'RPM / voltage / temperature back from each ESC.',
  },
  {
    id: 'dji-osd',
    label: 'DJI goggles OSD',
    protocol: 42,
    baud: 115200,
    notes: 'MSP DisplayPort for DJI O3 / Air Unit.',
  },
]

// Look up a preset by stable id. null if the id isn't in the list.
export function presetById(id: string): SerialProtocolPreset | null {
  return SERIAL_PRESETS.find(p => p.id === id) ?? null
}

// Which preset (if any) does this row's current SERIALn_PROTOCOL value
// correspond to. null when the protocol is set to something we don't
// have a preset for — the picker shows that as "Other (raw label)" and
// the operator can pick a preset to change it. We match on protocol
// only, not protocol+baud: a GPS at 38400 baud is still a GPS as far
// as the picker label is concerned, even if our preset recommends a
// different baud.
export function presetForRow(row: ConnectionRow): SerialProtocolPreset | null {
  if (row.protocol === null)
    return null
  return SERIAL_PRESETS.find(p => p.protocol === row.protocol) ?? null
}

// Rows the picker can edit. SERIAL0 is the USB link the operator is
// currently using to talk to the tool — changing its protocol risks
// stranding them with no way back. IOMCU rows have no SERIALn_PROTOCOL
// param to bind to. Both are non-editable.
export function isEditable(row: ConnectionRow): boolean {
  if (row.uart.index === null)
    return false
  if (row.uart.index === 0)
    return false
  return true
}

// Per-edit param writes. Picking a preset writes both the protocol AND
// the recommended baud so the operator gets a working configuration
// from a single action. Returns a small map keyed by param name; the
// caller pushes each entry through the params store's setEdit().
export interface SerialEdit {
  protocolParam: string
  protocolValue: number
  baudParam: string
  baudValue: number
}

export function buildEdit(row: ConnectionRow, preset: SerialProtocolPreset): SerialEdit | null {
  if (!isEditable(row))
    return null
  const n = row.uart.index!
  return {
    protocolParam: `SERIAL${n}_PROTOCOL`,
    protocolValue: preset.protocol,
    baudParam: `SERIAL${n}_BAUD`,
    baudValue: preset.baud,
  }
}
