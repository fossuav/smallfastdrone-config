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

// Pure helpers for reasoning about the FC's script storage (the SD card).
// Deliberately free of Vue / store imports so the errno→cause mapping is
// unit-testable without dragging the whole engine (and Nuxt UI) into the
// test runtime. The live probe that uses these — checkScriptStorage —
// lives in lua-engine.ts, since it needs an FTP session.

import { MavFtpError } from '../protocol/ftp'

// A recognised problem with the FC's script storage, inferred from the
// filesystem errno. Scripts live on the SD card, so in practice these are
// nearly always "no card inserted".
export type ScriptStorageProblem = 'no-card' | 'unformatted' | 'readonly'

// Storage probe result: 'ok' means we can install; a ScriptStorageProblem
// names a fixable cause; 'unknown' is a write failure we can't give
// targeted advice for (caller falls back to a generic message).
export type ScriptStorageStatus = 'ok' | ScriptStorageProblem | 'unknown'

// Map an FTP failure to a storage problem, or null if it isn't one we
// recognise. Shared by the storage probe and by install error handling so
// both speak the same language. Errno values come from the FC's
// AP_Filesystem_FATFS fatfs_to_errno():
//   ENOSPC (28) ← FR_NOT_ENABLED     — no volume mounted (i.e. no SD card)
//   ENXIO  (6)  ← FR_NO_FILESYSTEM   — card present but unformatted
//   EROFS  (30) ← FR_WRITE_PROTECTED — the card's write-protect lock is on
export function storageProblemFromError(e: unknown): ScriptStorageProblem | null {
  if (e instanceof MavFtpError && e.errCode === 2) {
    switch (e.errno) {
      case 28: return 'no-card'
      case 6: return 'unformatted'
      case 30: return 'readonly'
    }
  }
  return null
}
