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

// The firmware version string, and the operator-facing half of it.
//
// Two surfaces show a firmware version and both must hide the build hash
// outside expert mode. That rule leaked once already - the Connect card
// was fixed and the pre-flight step kept showing the hash for months -
// so it is one function now, and this is what says it behaves.

import { describe, expect, it } from 'vitest'
import { decodeFirmwareVersion, withoutBuildHash } from '../../src/protocol/mavlink'

// ArduPilot packs major/minor/patch/type into flight_sw_version.
function swVersion(major: number, minor: number, patch: number, type: number): number {
  return ((major << 24) >>> 0) + (minor << 16) + (patch << 8) + type
}
const ascii = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0)))

describe('withoutBuildHash', () => {
  it('takes the build hash off a decoded version', () => {
    const version = decodeFirmwareVersion(swVersion(4, 7, 0, 128), ascii('d0615774'))
    expect(version).toBe('4.7.0-beta (d0615774)')
    expect(withoutBuildHash(version)).toBe('4.7.0-beta')
  })

  it('leaves a version that never had one alone', () => {
    expect(withoutBuildHash('4.7.0-beta')).toBe('4.7.0-beta')
    expect(withoutBuildHash('')).toBe('')
  })

  it('only strips a trailing parenthetical, not one in the middle', () => {
    expect(withoutBuildHash('4.7.0 (rc2) build')).toBe('4.7.0 (rc2) build')
  })

  it('handles the official release, which carries no suffix', () => {
    const version = decodeFirmwareVersion(swVersion(4, 6, 2, 255), ascii('abc123'))
    expect(version).toBe('4.6.2 (abc123)')
    expect(withoutBuildHash(version)).toBe('4.6.2')
  })
})
