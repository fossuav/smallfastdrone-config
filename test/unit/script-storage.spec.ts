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

// Unit tests for the pure script-storage errno mapper. Guards the
// translation from an FC filesystem errno (carried in a FailErrno FTP
// NAK) to the operator-fixable cause — the no-SD-card case in particular,
// since that's what a fresh board hits on first field-install.

import { describe, expect, it } from 'vitest'
import { MavFtpError } from '../../src/protocol/ftp'
import { storageProblemFromError } from '../../src/workflow/script-storage'

// errCode 2 = FailErrno; second byte is the POSIX errno.
function failErrno(errno: number): MavFtpError {
  return new MavFtpError(2, errno, `FailErrno (errno ${errno})`)
}

describe('storageProblemFromError', () => {
  it('maps ENOSPC (28) ← FR_NOT_ENABLED to no-card', () => {
    expect(storageProblemFromError(failErrno(28))).toBe('no-card')
  })

  it('maps ENXIO (6) ← FR_NO_FILESYSTEM to unformatted', () => {
    expect(storageProblemFromError(failErrno(6))).toBe('unformatted')
  })

  it('maps EROFS (30) ← FR_WRITE_PROTECTED to readonly', () => {
    expect(storageProblemFromError(failErrno(30))).toBe('readonly')
  })

  it('returns null for an unrelated errno (e.g. EACCES 13)', () => {
    expect(storageProblemFromError(failErrno(13))).toBeNull()
  })

  it('returns null for non-FailErrno FTP errors (e.g. FileExists 8)', () => {
    expect(storageProblemFromError(new MavFtpError(8, undefined, 'FileExists'))).toBeNull()
  })

  it('returns null for non-FTP errors', () => {
    expect(storageProblemFromError(new Error('socket closed'))).toBeNull()
    expect(storageProblemFromError('nope')).toBeNull()
    expect(storageProblemFromError(undefined)).toBeNull()
  })
})
