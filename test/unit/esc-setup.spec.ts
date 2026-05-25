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

// Unit tests for the ESC-setup logic — which params a chosen config writes,
// and when it's a no-op. Writing the wrong MOT_PWM_TYPE / mask would change
// how every motor is driven, so the edit computation is pinned down here.

import { describe, expect, it } from 'vitest'
import {
  BIDIR_MASK_PARAM,
  channelsToMask,
  escParamEdits,
  isDshot,
  isRecommendedConfig,
  MOT_PWM_TYPE_PARAM,
  MOTOR_POLES_PARAM,
  protocolLabel,
} from '../../src/workflow/esc-setup'

// Reader over a plain object of current param values.
function reader(values: Record<string, number>) {
  return (name: string) => (name in values ? values[name] : undefined)
}

describe('esc-setup helpers', () => {
  it('isDshot covers 4..7', () => {
    expect([4, 5, 6, 7].every(isDshot)).toBe(true)
    expect([0, 1, 2, 3].some(isDshot)).toBe(false)
  })

  it('protocolLabel names known protocols and falls back', () => {
    expect(protocolLabel(6)).toBe('DShot600')
    expect(protocolLabel(0)).toBe('Normal PWM')
    expect(protocolLabel(99)).toBe('Type 99')
  })

  it('channelsToMask sets the right bits (bit 0 = ch 1)', () => {
    expect(channelsToMask([1, 2, 3, 4])).toBe(0b1111)
    expect(channelsToMask([1, 3])).toBe(0b0101)
    expect(channelsToMask([])).toBe(0)
    expect(channelsToMask([5, 6])).toBe(0b110000)
  })

  it('isRecommendedConfig', () => {
    expect(isRecommendedConfig(6, 15, true)).toBe(true) // DShot + telem
    expect(isRecommendedConfig(6, 0, true)).toBe(false) // DShot, no telem
    expect(isRecommendedConfig(0, 0, true)).toBe(false) // PWM
    expect(isRecommendedConfig(6, undefined, false)).toBe(true) // DShot, no BLHeli build
  })
})

describe('escParamEdits', () => {
  const channels = [1, 2, 3, 4]

  it('no edits when already DShot600 + bidir mask matches', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 6, [BIDIR_MASK_PARAM]: 15, [MOTOR_POLES_PARAM]: 14 })
    expect(escParamEdits({ protocol: 6, bidir: true }, channels, cur, true)).toEqual([])
  })

  it('writes protocol, mask, and poles when going from PWM to DShot600 + bidir', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 0 })
    const edits = escParamEdits({ protocol: 6, bidir: true }, channels, cur, true)
    const byName = new Map(edits.map(e => [e.name, e.value]))
    expect(byName.get(MOT_PWM_TYPE_PARAM)).toBe(6)
    expect(byName.get(BIDIR_MASK_PARAM)).toBe(15)
    expect(byName.get(MOTOR_POLES_PARAM)).toBe(14)
  })

  it('does not re-write poles when already set', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 0, [MOTOR_POLES_PARAM]: 14 })
    const edits = escParamEdits({ protocol: 6, bidir: true }, channels, cur, true)
    expect(edits.some(e => e.name === MOTOR_POLES_PARAM)).toBe(false)
  })

  it('turning bidir off clears the mask only', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 6, [BIDIR_MASK_PARAM]: 15, [MOTOR_POLES_PARAM]: 14 })
    const edits = escParamEdits({ protocol: 6, bidir: false }, channels, cur, true)
    expect(edits).toEqual([{ name: BIDIR_MASK_PARAM, value: 0 }])
  })

  it('ignores bidir when the FC lacks the BLHeli param', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 0 })
    const edits = escParamEdits({ protocol: 6, bidir: true }, channels, cur, false)
    expect(edits).toEqual([{ name: MOT_PWM_TYPE_PARAM, value: 6 }])
  })

  it('ignores bidir for a non-DShot protocol', () => {
    const cur = reader({ [MOT_PWM_TYPE_PARAM]: 6, [BIDIR_MASK_PARAM]: 15 })
    const edits = escParamEdits({ protocol: 0, bidir: true }, channels, cur, true)
    expect(edits).toEqual([{ name: MOT_PWM_TYPE_PARAM, value: 0 }])
  })
})
