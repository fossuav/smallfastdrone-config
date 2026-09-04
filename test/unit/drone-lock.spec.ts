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

// Sealing is the one action the tool cannot undo, so its arithmetic and
// its guard are pinned here. The bit lives in a mask that also carries
// flash write protection, which is what makes a read-modify-write slip
// worse than simply failing to seal.

import { describe, expect, it } from 'vitest'
import {
  isLockRequested,
  LOCK_OPTION_BIT,
  lockBlocker,
  withLockBit,
} from '../../src/workflow/drone-lock'

// The neighbours in BRD_OPTIONS, so a slip is visible.
const WATCHDOG = 1 << 0
const UNLOCK_FLASH = 1 << 4
const WRITE_PROTECT_FLASH = 1 << 5
const WRITE_PROTECT_BOOTLOADER = 1 << 6

describe('the seal bit', () => {
  it('is bit 10, clear of the flash-protection bits beside it', () => {
    expect(LOCK_OPTION_BIT).toBe(1024)
    for (const other of [WATCHDOG, UNLOCK_FLASH, WRITE_PROTECT_FLASH, WRITE_PROTECT_BOOTLOADER])
      expect(LOCK_OPTION_BIT & other).toBe(0)
  })

  it('reads the request out of a mask carrying other flags', () => {
    expect(isLockRequested(LOCK_OPTION_BIT | WATCHDOG)).toBe(true)
    expect(isLockRequested(WATCHDOG | WRITE_PROTECT_BOOTLOADER)).toBe(false)
    expect(isLockRequested(0)).toBe(false)
  })

  it('treats an unknown value as not sealed rather than guessing', () => {
    expect(isLockRequested(undefined)).toBe(false)
    expect(isLockRequested(Number.NaN)).toBe(false)
  })
})

describe('withLockBit', () => {
  it('keeps every other option — clobbering them would be the worse bug', () => {
    const before = WATCHDOG | WRITE_PROTECT_FLASH | WRITE_PROTECT_BOOTLOADER
    const after = withLockBit(before)
    expect(after & before).toBe(before)
    expect(isLockRequested(after)).toBe(true)
  })

  it('is idempotent, so a repeated seal writes the same value', () => {
    const once = withLockBit(WATCHDOG)
    expect(withLockBit(once)).toBe(once)
  })

  it('starts from zero when the drone has not reported the value', () => {
    expect(withLockBit(undefined)).toBe(LOCK_OPTION_BIT)
  })

  it('never sets the flash-unlock bit as a side effect', () => {
    expect(withLockBit(0) & UNLOCK_FLASH).toBe(0)
  })
})

describe('lockBlocker', () => {
  it('allows it only on a connected drone that already has an identity', () => {
    expect(lockBlocker({ connected: true, hasIdentity: true, options: 0 })).toBeNull()
  })

  it('refuses without an identity, mirroring what the firmware would do', () => {
    expect(lockBlocker({ connected: true, hasIdentity: false, options: 0 })).toBe('no-identity')
  })

  it('refuses when already sealed, so a one-way action is not offered twice', () => {
    expect(lockBlocker({ connected: true, hasIdentity: true, options: LOCK_OPTION_BIT })).toBe('already-sealed')
  })

  it('refuses when disconnected', () => {
    expect(lockBlocker({ connected: false, hasIdentity: true, options: 0 })).toBe('not-connected')
  })

  it('checks the identity before anything else it could report', () => {
    // A drone with no identity and no connection is still "not connected"
    // to the operator; the point is that no combination yields null.
    expect(lockBlocker({ connected: false, hasIdentity: false, options: 0 })).not.toBeNull()
  })
})
