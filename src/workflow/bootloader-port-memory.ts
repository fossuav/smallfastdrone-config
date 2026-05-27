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

// Persistent "firmware port → bootloader port" pairings, keyed by the
// firmware port's USB VID:PID. Lets the firmware-flash workflow skip
// the bootloader-port picker on every flash after the first: the
// operator picks once, we remember the pairing, subsequent flashes
// auto-pick the same bootloader port (if it's currently connected).
//
// Why the pairing isn't just "remember the last bootloader port": an
// operator might switch boards mid-session (TBS Lucid H7 today,
// MatekH743 tomorrow); each board's bootloader VID:PID is different,
// so we need a per-firmware-board pairing to do the right thing.
//
// Identity is by USB VID:PID alone — `SerialPort.getInfo()` doesn't
// surface serial numbers for most CDC-ACM devices. Two physical drones
// of the same model would share VID:PID and the pairing would treat
// them interchangeably; that's fine because (a) only one is ever in
// bootloader mode at once on a given page, and (b) flashing the same
// firmware to two identical drones is the intended outcome.

const STORAGE_KEY = 'sfdc.bootloader-port-pairings'

interface PortInfo {
  usbVendorId?: number
  usbProductId?: number
}

type Pairings = Record<string, PortInfo>

// Encode a PortInfo as a stable string key for the pairings map. Falls
// back to a placeholder so a missing VID or PID doesn't collide with
// every other missing-VID/PID port.
function infoKey(info: PortInfo): string {
  const vid = info.usbVendorId ?? 'x'
  const pid = info.usbProductId ?? 'x'
  return `${vid}:${pid}`
}

function readPairings(): Pairings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Pairings
    return {}
  }
  catch {
    return {}
  }
}

function writePairings(p: Pairings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  }
  catch {
    // Quota / private-browsing / etc. Memory's a nice-to-have; the
    // picker fallback works fine without it.
  }
}

// Record that `bootloaderInfo` is the bootloader-mode port for the
// firmware port identified by `firmwareInfo`. Called after a successful
// flash so the next flash for the same firmware-board can skip the
// picker.
export function rememberBootloaderPort(
  firmwareInfo: PortInfo,
  bootloaderInfo: PortInfo,
): void {
  const pairings = readPairings()
  pairings[infoKey(firmwareInfo)] = {
    usbVendorId: bootloaderInfo.usbVendorId,
    usbProductId: bootloaderInfo.usbProductId,
  }
  writePairings(pairings)
}

// Find a `SerialPort` from `candidates` whose VID:PID matches the
// remembered bootloader pairing for `firmwareInfo` and is currently
// `connected` (physical USB device enumerated right now). Returns null
// if there's no remembered pairing, or the remembered port isn't in
// the candidates list, or it's not currently connected. The caller
// falls back to the picker.
export function findRememberedBootloaderPort(
  firmwareInfo: PortInfo,
  candidates: SerialPort[],
): SerialPort | null {
  const pairings = readPairings()
  const want = pairings[infoKey(firmwareInfo)]
  if (!want)
    return null
  for (const p of candidates) {
    if (!p.connected)
      continue
    const got = p.getInfo()
    if (got.usbVendorId === want.usbVendorId && got.usbProductId === want.usbProductId)
      return p
  }
  return null
}
