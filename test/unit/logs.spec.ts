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

import type { LogSource } from '../../src/workflow/logs'
import { describe, expect, it } from 'vitest'
import { MavFtpError } from '../../src/protocol/ftp'
import { downloadFlightLog, formatSize, listFlightLogs } from '../../src/workflow/logs'

// A drone's log directory as MavFtp reports it, including the things
// that are not flight logs.
//
// The entry shape is MavFtp's `FtpDirEntry` and not a convenient
// approximation of it. An earlier version of this file invented one,
// which type-checked here and made listFlightLogs filter on a field the
// real client never sets - so directories would have been listed as
// flight logs, and these tests would have gone on passing.
function source(
  entries: Array<{ name: string, size?: number, isDir?: boolean }>,
  only?: string,
): LogSource {
  return {
    listDirectory: async (dir) => {
      // A drone answers for the one directory it has and refuses the
      // rest, which is what the search has to cope with.
      if (only !== undefined && dir !== only)
        throw new MavFtpError(10, undefined, 'FTP LIST_DIRECTORY failed: FileNotFound')
      return entries.map(e => ({ name: e.name, size: e.size, isDir: e.isDir ?? false }))
    },
    downloadFileBurst: async (path, onProgress) => {
      onProgress?.(10, 10)
      return new TextEncoder().encode(path)
    },
  }
}

describe('flight logs', () => {
  it('lists only the recordings, oldest first', async () => {
    const logs = await listFlightLogs(source([
      { name: '00000010.BIN', size: 20 },
      { name: 'LASTLOG.TXT', size: 3 },
      { name: '00000002.BIN', size: 10 },
      { name: 'subdir', isDir: true },
      { name: 'notes.bin.txt', size: 1 },
    ]))
    expect(logs.map(l => l.name)).toEqual(['00000002.BIN', '00000010.BIN'])
    expect(logs[0]?.path).toBe('/APM/LOGS/00000002.BIN')
  })

  it('never mistakes a directory for a flight log', async () => {
    // A directory named like a log is the case the invented interface
    // would have got wrong, silently.
    const logs = await listFlightLogs(source([
      { name: '00000009.BIN', isDir: true },
      { name: '00000008.BIN', size: 4 },
    ]))
    expect(logs.map(l => l.name)).toEqual(['00000008.BIN'])
  })

  it('treats a size the drone did not give as zero', async () => {
    const logs = await listFlightLogs(source([{ name: '00000001.BIN' }]))
    expect(logs[0]?.size).toBe(0)
  })

  it('finds the logs wherever this drone keeps them', async () => {
    // A real board answers for /APM/LOGS and SITL for /logs; neither
    // knows about the other, and nothing on the wire says which.
    for (const dir of ['/APM/LOGS', '/logs']) {
      const logs = await listFlightLogs(source([{ name: '00000001.BIN', size: 9 }], dir))
      expect(logs[0]?.path).toBe(`${dir}/00000001.BIN`)
    }
  })

  it('reports a drone that answers for nowhere as empty', async () => {
    expect(await listFlightLogs(source([{ name: '00000001.BIN', size: 9 }], '/nowhere'))).toEqual([])
  })

  it('does not report a link failure as an empty card', async () => {
    // "Nothing recorded yet" has to mean it. A drone that never answered
    // is a different thing and the operator can do something about it.
    const broken: LogSource = {
      listDirectory: async () => { throw new Error('FTP LIST_DIRECTORY timed out') },
      downloadFileBurst: async () => new Uint8Array(),
    }
    await expect(listFlightLogs(broken)).rejects.toThrow(/timed out/)
  })

  it('reports an empty card as empty rather than failing', async () => {
    expect(await listFlightLogs(source([{ name: 'LASTLOG.TXT', size: 3 }]))).toEqual([])
  })

  it('downloads by path and reports progress', async () => {
    const [log] = await listFlightLogs(source([{ name: '00000003.BIN', size: 5 }]))
    const seen: Array<[number, number]> = []
    const bytes = await downloadFlightLog(source([]), log!, (r, t) => seen.push([r, t]))
    expect(new TextDecoder().decode(bytes)).toBe('/APM/LOGS/00000003.BIN')
    expect(seen).toEqual([[10, 10]])
  })

  it('sizes a log the way a person would say it', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(32732)).toBe('32 KB')
    expect(formatSize(52 * 1024 * 1024)).toBe('52.0 MB')
  })
})
