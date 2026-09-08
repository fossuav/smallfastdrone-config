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

import type { ParamRecord } from '../../src/protocol/params'
import { describe, expect, it } from 'vitest'
import { buildBackup } from '../../src/workflow/param-backup'

const VEHICLE = { autopilot: null, boardId: null, firmware: null, frame: null, uid: null }

function backupOf(options: number) {
  const params = new Map<string, ParamRecord>([
    ['BRD_OPTIONS', { name: 'BRD_OPTIONS', value: options, type: 6, index: 0 }],
  ])
  return buildBackup(params, VEHICLE as never, '2026-09-08T00:00:00Z', {
    changed: new Set(['BRD_OPTIONS']),
    isReadOnly: () => false,
  })
}

describe('a backup never carries a request to seal', () => {
  it('strips the seal bit and keeps the rest', () => {
    // 1025 = the watchdog bit the board ships with, plus the seal.
    expect(backupOf(1025).params.BRD_OPTIONS?.value).toBe(1)
    expect(backupOf(1).params.BRD_OPTIONS?.value).toBe(1)
    expect(backupOf(1024).params.BRD_OPTIONS?.value).toBe(0)
  })

  it('leaves every other option alone', () => {
    // bits 4/5/6 are the write-protection options, which are settings
    expect(backupOf(0b1110000).params.BRD_OPTIONS?.value).toBe(0b1110000)
  })
})
