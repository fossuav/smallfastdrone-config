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

// Unit tests for src/workflow/bootloader-port-memory.ts. Vitest runs in
// jsdom-ish Node — we stub localStorage with a Map-backed shim so the
// pairings survive within a test but reset between them.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  findRememberedBootloaderPort,
  rememberBootloaderPort,
} from '../../src/workflow/bootloader-port-memory'

// In-memory localStorage shim. The pairings module reads / writes
// `localStorage.{getItem,setItem}` only.
class FakeStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  clear(): void {
    this.map.clear()
  }
}

beforeEach(() => {
  const storage = new FakeStorage()
  // @ts-expect-error — installing a stub on global for the module's use.
  globalThis.localStorage = storage
})

// Tiny SerialPort stub matching what `findRememberedBootloaderPort`
// inspects (`connected` + `getInfo()`).
function fakePort(vid: number, pid: number, connected: boolean): SerialPort {
  return {
    connected,
    getInfo: () => ({ usbVendorId: vid, usbProductId: pid }),
  } as unknown as SerialPort
}

describe('bootloader-port memory', () => {
  it('returns null when no pairing has been saved', () => {
    const firmwareInfo = { usbVendorId: 0x1234, usbProductId: 0x5678 }
    const candidates = [fakePort(0x0483, 0x5740, true)]
    expect(findRememberedBootloaderPort(firmwareInfo, candidates)).toBeNull()
  })

  it('finds the connected port matching a saved pairing', () => {
    const firmwareInfo = { usbVendorId: 0x1234, usbProductId: 0x5678 }
    const bootloaderInfo = { usbVendorId: 0x0483, usbProductId: 0x5740 }
    rememberBootloaderPort(firmwareInfo, bootloaderInfo)

    const candidates = [
      fakePort(0xDEAD, 0xBEEF, true), // some other connected port
      fakePort(0x0483, 0x5740, true), // the bootloader port
    ]
    const found = findRememberedBootloaderPort(firmwareInfo, candidates)
    expect(found).not.toBeNull()
    expect(found!.getInfo().usbVendorId).toBe(0x0483)
    expect(found!.getInfo().usbProductId).toBe(0x5740)
  })

  it('ignores a remembered port that isn\'t currently connected', () => {
    const firmwareInfo = { usbVendorId: 0x1234, usbProductId: 0x5678 }
    rememberBootloaderPort(firmwareInfo, { usbVendorId: 0x0483, usbProductId: 0x5740 })
    const candidates = [fakePort(0x0483, 0x5740, false)] // not connected
    expect(findRememberedBootloaderPort(firmwareInfo, candidates)).toBeNull()
  })

  it('keys pairings by the firmware port — different boards don\'t collide', () => {
    const tbsFirmware = { usbVendorId: 0x1234, usbProductId: 0x5678 }
    const matekFirmware = { usbVendorId: 0xAAAA, usbProductId: 0xBBBB }
    rememberBootloaderPort(tbsFirmware, { usbVendorId: 0x0483, usbProductId: 0x5740 })
    rememberBootloaderPort(matekFirmware, { usbVendorId: 0x2E3C, usbProductId: 0xFFF1 })

    // TBS firmware lookup finds TBS bootloader, not Matek's
    const candidates = [
      fakePort(0x0483, 0x5740, true),
      fakePort(0x2E3C, 0xFFF1, true),
    ]
    const tbs = findRememberedBootloaderPort(tbsFirmware, candidates)
    expect(tbs?.getInfo().usbVendorId).toBe(0x0483)
    const matek = findRememberedBootloaderPort(matekFirmware, candidates)
    expect(matek?.getInfo().usbVendorId).toBe(0x2E3C)
  })

  it('overwrites a prior pairing for the same firmware board', () => {
    const firmwareInfo = { usbVendorId: 0x1234, usbProductId: 0x5678 }
    rememberBootloaderPort(firmwareInfo, { usbVendorId: 0x0001, usbProductId: 0x0001 })
    rememberBootloaderPort(firmwareInfo, { usbVendorId: 0x0002, usbProductId: 0x0002 })

    const candidates = [
      fakePort(0x0001, 0x0001, true),
      fakePort(0x0002, 0x0002, true),
    ]
    const found = findRememberedBootloaderPort(firmwareInfo, candidates)
    expect(found?.getInfo().usbVendorId).toBe(0x0002)
  })
})
