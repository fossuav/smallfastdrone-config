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

// The exit ceremony's value is its ordering, so the ordering is what these
// pin: nothing irreversible may happen until the operator holds their
// backup, and no failure may lose it.

import type { ParamBackup, RestorePlan } from '../../src/workflow/param-backup'
import type { RecoverPhase, RecoveryDriver } from '../../src/workflow/sfd-recover'
import { describe, expect, it } from 'vitest'
import { hasUnfinishedBusiness, RecoverError, runExitCeremony } from '../../src/workflow/sfd-recover'

const BACKUP: ParamBackup = {
  schema: 'sfd-param-backup/1',
  createdAt: '2026-09-04T00:00:00Z',
  vehicle: { sysid: 1, firmwareVersion: '4.7.0', frameLabel: 'Quad X', uid: 'abc' },
  params: { ATC_RAT_PIT_P: { value: 0.135, type: 9 } },
}

function plan(over: Partial<RestorePlan> = {}): RestorePlan {
  return { items: [], toWrite: [], unchanged: [], missing: [], readOnly: [], notReverted: [], ...over }
}

// Records the order things actually happened in, which is the assertion.
class FakeDrone implements RecoveryDriver {
  calls: string[] = []
  backupThrows = false
  saved = true
  dfuAppears = true
  unlockThrows = false
  flashThrows = false
  droneReturns = true
  restoreThrows = false
  restorePlan: RestorePlan = plan()

  captureBackup = async (): Promise<ParamBackup> => {
    this.calls.push('capture')
    if (this.backupThrows)
      throw new Error('link died')
    return BACKUP
  }

  confirmBackupSaved = async (): Promise<boolean> => {
    this.calls.push('confirm')
    return this.saved
  }

  awaitDfuDevice = async (): Promise<boolean> => {
    this.calls.push('dfu')
    return this.dfuAppears
  }

  unlock = async (): Promise<void> => {
    this.calls.push('unlock')
    if (this.unlockThrows)
      throw new Error('refused')
  }

  flashWithBootloader = async (): Promise<void> => {
    this.calls.push('flash')
    if (this.flashThrows)
      throw new Error('write failed')
  }

  awaitDrone = async (): Promise<boolean> => {
    this.calls.push('await')
    return this.droneReturns
  }

  restore = async (): Promise<RestorePlan> => {
    this.calls.push('restore')
    if (this.restoreThrows)
      throw new Error('write refused')
    return this.restorePlan
  }
}

async function failure(p: Promise<unknown>): Promise<RecoverError> {
  const e = await p.catch(err => err)
  expect(e).toBeInstanceOf(RecoverError)
  return e as RecoverError
}

// Anything that cannot be undone.
const DESTRUCTIVE = ['unlock', 'flash']

describe('runExitCeremony ordering', () => {
  it('runs the steps in the order the silicon forces', async () => {
    const drone = new FakeDrone()
    const phases: RecoverPhase[] = []
    const outcome = await runExitCeremony(drone, p => phases.push(p))

    expect(drone.calls).toEqual(['capture', 'confirm', 'dfu', 'unlock', 'flash', 'await', 'restore'])
    expect(phases).toEqual([
      'backing-up',
      'awaiting-save',
      'awaiting-dfu',
      'unlocking',
      'flashing',
      'reconnecting',
      'restoring',
      'done',
    ])
    expect(outcome.backup).toBe(BACKUP)
  })

  it('erases nothing until the operator says they have the backup', async () => {
    const drone = new FakeDrone()
    drone.saved = false
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('backup-not-saved')
    // The point of the whole module.
    for (const step of DESTRUCTIVE)
      expect(drone.calls).not.toContain(step)
    expect(err.destructive).toBe(false)
    // And they keep the file even though they said they hadn't saved it.
    expect(err.backup).toBe(BACKUP)
  })

  it('erases nothing when the settings could not be read at all', async () => {
    const drone = new FakeDrone()
    drone.backupThrows = true
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('backup-failed')
    expect(drone.calls).toEqual(['capture'])
    expect(err.destructive).toBe(false)
  })

  it('erases nothing when the drone never reaches update mode', async () => {
    const drone = new FakeDrone()
    drone.dfuAppears = false
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('no-dfu-device')
    for (const step of DESTRUCTIVE)
      expect(drone.calls).not.toContain(step)
    expect(err.message).toMatch(/nothing has been changed/)
  })
})

describe('runExitCeremony failures never lose the backup', () => {
  it('carries it out of a failed unlock, which may already have erased', async () => {
    const drone = new FakeDrone()
    drone.unlockThrows = true
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('unlock-failed')
    expect(err.backup).toBe(BACKUP)
    // Cannot claim the drone is untouched — the erase may have run.
    expect(err.destructive).toBe(true)
  })

  it('carries it out of a failed flash, and says the drone will not start', async () => {
    const drone = new FakeDrone()
    drone.flashThrows = true
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('flash-failed')
    expect(err.backup).toBe(BACKUP)
    expect(err.destructive).toBe(true)
    expect(err.message).toMatch(/won't start up yet/)
  })

  it('carries it out of a drone that never comes back', async () => {
    const drone = new FakeDrone()
    drone.droneReturns = false
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('no-drone-after-flash')
    expect(err.backup).toBe(BACKUP)
    expect(drone.calls).not.toContain('restore')
  })

  it('carries it out of a failed restore, and points at where to retry', async () => {
    const drone = new FakeDrone()
    drone.restoreThrows = true
    const err = await failure(runExitCeremony(drone))

    expect(err.reason).toBe('restore-failed')
    expect(err.backup).toBe(BACKUP)
    expect(err.message).toMatch(/Settings page/)
  })
})

describe('hasUnfinishedBusiness', () => {
  it('a clean restore leaves nothing to do', async () => {
    const drone = new FakeDrone()
    expect(hasUnfinishedBusiness(await runExitCeremony(drone))).toBe(false)
  })

  it('flags settings the firmware no longer has', async () => {
    const drone = new FakeDrone()
    drone.restorePlan = plan({ missing: [{ name: 'GONE_PARAM', backupValue: 1, currentValue: null, type: null, action: 'missing' }] })
    expect(hasUnfinishedBusiness(await runExitCeremony(drone))).toBe(true)
  })

  it('flags settings a delta backup could never put back', async () => {
    // Changed after the backup was taken, so it has no saved value to
    // return to — the honest cost of a delta backup.
    const drone = new FakeDrone()
    drone.restorePlan = plan({ notReverted: ['SOME_PARAM'] })
    expect(hasUnfinishedBusiness(await runExitCeremony(drone))).toBe(true)
  })
})
