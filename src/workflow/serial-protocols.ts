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

// Operator-friendly labels for SERIALn_PROTOCOL values. Split into a
// dependency-free module so unit tests can import it without dragging
// in the Pinia / Nuxt UI graph that the composable in connections.ts
// pulls in. Enum values come from AP_SerialManager/AP_SerialManager.h
// in the firmware; only the protocols an operator on a SmallFastDrone
// build might reasonably encounter get a friendly label, with the long
// tail (Volz, Torqeedo, AIS, …) falling through to a "Protocol <n>"
// tag — those are expert-mode territory anyway.

export const PROTOCOL_LABELS: Record<number, string> = {
  [-1]: 'Off',
  0: 'Console',
  1: 'MAVLink',
  2: 'MAVLink2',
  3: 'FrSky D',
  4: 'FrSky SPort',
  5: 'GPS',
  6: 'GPS (2nd)',
  9: 'Rangefinder',
  10: 'FrSky telemetry',
  13: 'Beacon',
  16: 'ESC telemetry',
  22: 'CAN-over-serial',
  23: 'RC input',
  28: 'Lua scripting',
  29: 'CRSF / ELRS',
  32: 'MSP',
  33: 'DJI FPV',
  34: 'Airspeed',
  35: 'ADS-B',
  37: 'VTX (SmartAudio)',
  38: 'ESC (FETtec OneWire)',
  42: 'DJI OSD (MSP DisplayPort)',
  43: 'MAVLink HL',
  44: 'VTX (Tramp)',
  45: 'DDS / XRCE',
}

// Render the SERIALn_PROTOCOL value as an operator label. Unknown
// values fall through to "Protocol <n>" so the table never goes blank
// on a firmware that adds an enum entry we haven't catalogued yet.
export function protocolLabel(value: number | null | undefined): string {
  if (value === null || value === undefined)
    return '—'
  return PROTOCOL_LABELS[value] ?? `Protocol ${value}`
}
