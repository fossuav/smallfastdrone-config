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

// Finishing an exit that stopped after the wipe.
//
// The case this exists for: the drone is erased, so nothing can read its
// settings, so the ceremony cannot start over. Before this the wizard
// said "your drone needs finishing" and offered nothing that could.

import type { ParamBackup } from '../../src/workflow/param-backup'
import type { RecoveryDriver } from '../../src/workflow/sfd-recover'
import { describe, expect, it, vi } from 'vitest'
import { finishExitCeremony, runExitCeremony } from '../../src/workflow/sfd-recover'

const BACKUP = {
  schema: 'sfd-param-backup/1',
  createdAt: '2026-09-08T00:00:00Z',
  vehicle: {},
  params: { LOG_DISARMED: { value: 1, type: 6 } },
} as unknown as ParamBackup

function driver(overrides: Partial<RecoveryDriver> = {}): RecoveryDriver {
  return {
    captureBackup: async () => BACKUP,
    confirmBackupSaved: async () => true,
    awaitDfuDevice: async () => true,
    unlock: async () => {},
    flashWithBootloader: async () => {},
    awaitDrone: async () => true,
    restore: async () => ({ toWrite: [], notReverted: [], missing: [] }) as never,
    ...overrides,
  }
}

describe('finishing an exit that stopped after the wipe', () => {
  it('never reads the drone, because a wiped drone cannot be read', async () => {
    const captureBackup = vi.fn(async () => BACKUP)
    const unlock = vi.fn(async () => {})
    await finishExitCeremony(driver({ captureBackup, unlock }), BACKUP)
    // The two steps that are impossible or already done.
    expect(captureBackup).not.toHaveBeenCalled()
    expect(unlock).not.toHaveBeenCalled()
  })

  it('flashes, waits for the drone and puts the settings back', async () => {
    const order: string[] = []
    await finishExitCeremony(driver({
      flashWithBootloader: async () => {
        order.push('flash')
      },
      awaitDrone: async () => {
        order.push('wait')
        return true
      },
      restore: async () => {
        order.push('restore')
        return { toWrite: [], notReverted: [], missing: [] } as never
      },
    }), BACKUP)
    expect(order).toEqual(['flash', 'wait', 'restore'])
  })

  it('keeps carrying the backup when it fails again', async () => {
    // An operator who has already lost the drone must not also lose the
    // only thing that can put it back.
    await expect(finishExitCeremony(
      driver({
        flashWithBootloader: async () => {
          throw new Error('device went away')
        },
      }),
      BACKUP,
    )).rejects.toMatchObject({ reason: 'flash-failed', backup: BACKUP, destructive: true })
  })

  it('is what the full ceremony runs, so the two cannot drift', async () => {
    const order: string[] = []
    await runExitCeremony(driver({
      captureBackup: async () => {
        order.push('backup')
        return BACKUP
      },
      unlock: async () => {
        order.push('unlock')
      },
      flashWithBootloader: async () => {
        order.push('flash')
      },
      restore: async () => {
        order.push('restore')
        return { toWrite: [], notReverted: [], missing: [] } as never
      },
    }))
    expect(order).toEqual(['backup', 'unlock', 'flash', 'restore'])
  })
})
