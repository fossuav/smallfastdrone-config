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

// Listing and fetching the drone's flight recordings.
//
// Over MAVLink FTP rather than LOG_REQUEST_LIST / LOG_REQUEST_DATA,
// which is what PLAN.md originally said — see decision 41. FTP gives
// real filenames, the client is already hardware-proven here, and burst
// read makes it fast enough. The trade is that it needs a filesystem, so
// a board logging to internal flash is not covered.
//
// Pure of Vue and of the session store so it can be unit-tested; the
// view wires it up.

const LOG_DIR = '/APM/LOGS'
// A log that is still being written reports the size it had at its last
// sync, so it is offered but flagged rather than hidden — an operator
// who just landed wants the flight they just flew.
const LOG_NAME = /^\d+\.BIN$/i

export interface FlightLog {
  name: string
  path: string
  // Bytes as the drone's filesystem reports them, which lags behind for
  // a log still open.
  size: number
}

// What the view needs from the drone. MavFtp satisfies it.
export interface LogSource {
  listDirectory: (path: string) => Promise<Array<{ name: string, size: number, isDirectory: boolean }>>
  downloadFileBurst: (path: string, onProgress?: (received: number, total: number) => void) => Promise<Uint8Array>
}

// The drone's recordings, newest last — the names are sequential, so
// sorting them is sorting by age.
export async function listFlightLogs(source: LogSource): Promise<FlightLog[]> {
  const entries = await source.listDirectory(LOG_DIR)
  return entries
    .filter(e => !e.isDirectory && LOG_NAME.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => ({ name: e.name, path: `${LOG_DIR}/${e.name}`, size: e.size }))
}

export async function downloadFlightLog(
  source: LogSource,
  log: FlightLog,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  return source.downloadFileBurst(log.path, onProgress)
}

// Human-sized, because "34,127,872 bytes" tells an operator nothing they
// wanted to know.
export function formatSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
