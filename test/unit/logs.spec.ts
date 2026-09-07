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
import { downloadFlightLog, formatSize, listFlightLogs } from '../../src/workflow/logs'

// A drone's log directory as MavFtp reports it, including the things
// that are not flight logs.
function source(entries: Array<{ name: string, size: number, isDirectory?: boolean }>): LogSource {
  return {
    listDirectory: async () => entries.map(e => ({ ...e, isDirectory: e.isDirectory ?? false })),
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
      { name: 'subdir', size: 0, isDirectory: true },
      { name: 'notes.bin.txt', size: 1 },
    ]))
    expect(logs.map(l => l.name)).toEqual(['00000002.BIN', '00000010.BIN'])
    expect(logs[0]?.path).toBe('/APM/LOGS/00000002.BIN')
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
