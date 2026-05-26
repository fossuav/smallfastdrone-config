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

// WebUSB DFU transport — the production `USBControl` for the DFU
// recovery / fresh-chip path. Talks to the chip's bootloader after
// the operator's put the board in DFU mode (BOOT0 button + USB plug,
// per FirmwareView's instructions). Stays narrowly scoped: open one
// device, expose the four DFU control operations, close.
//
// Per CLAUDE.md (Tech stack — locked):
//   - WebUSB API for DFU transport.
//   - Production code never imports test transports — this file is
//     the only USBControl implementation pulled into the runtime.
//
// We deliberately don't try to also handle MAVLink-over-USB here.
// MAVLink lives on WebSerial; DFU lives on WebUSB; the firmware
// workflow switches between them depending on path.

import type { ControlSetup, USBControl } from './usb-control'

// STMicro DFU vendor/product. Other AP-supported chips (GD32, AT32)
// have their own VID:PID — we add them here once a SFD build targets
// one. Keep this list mirroring `defaultUsbFilters` in
// `../betaflight-configurator/src/js/protocols/devices.js`.
const DFU_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0483, productId: 0xDF11 }, // STMicro STM Device in DFU Mode
]

// Functional descriptor for DFU (USB DFU 1.1 spec, table 4.2):
//   bLength             1 byte
//   bDescriptorType     1 byte (0x21)
//   bmAttributes        1 byte
//   wDetachTimeOut      2 bytes (LE)
//   wTransferSize       2 bytes (LE)
//   bcdDFUVersion       2 bytes (LE)
const DFU_FUNC_DESCRIPTOR_TYPE = 0x21

// What we hand back from `listDfuDevices()` so the UI can show
// "1 device available — `STM32 BOOTLOADER`" before opening.
export interface DfuDeviceHandle {
  // Display-only label combining manufacturer + product.
  label: string
  // The underlying WebUSB device (opaque to callers; pass back to
  // `openDfuDevice()`).
  readonly device: USBDevice
}

// Result of `openDfuDevice` — the USBControl plus the chip-side
// metadata the workflow needs to plan an erase / size the transfer.
export interface OpenedDfuDevice {
  control: USBControl
  // From the DFU functional descriptor. Boards typically advertise
  // 2048 (STM32 default). Falls back to 2048 if the descriptor read
  // fails.
  transferSize: number
  // Alt-setting string descriptors for each interface alt-setting.
  // The DFU client parses these into a memory layout via
  // `parseDfuseLayout`. We hand them up raw so the parsing stays in
  // the protocol module (no DfuSe knowledge here).
  altSettingDescriptors: string[]
  // bInterface number of the DFU interface we claimed.
  interfaceNumber: number
}

// Permission-prompt path. Has to run inside a user gesture (button
// click) — calling it from a setTimeout or page-load handler will be
// rejected by the browser. The picker shows STM-DFU devices only.
export async function requestDfuDevice(): Promise<USBDevice | null> {
  if (!('usb' in navigator)) {
    throw new Error('Your browser doesn\'t support USB device access. Use Chrome, Edge, or another Chromium-based browser.')
  }
  try {
    const device = await navigator.usb.requestDevice({ filters: DFU_FILTERS })
    return device
  }
  catch {
    // User cancelled the picker — not an error.
    return null
  }
}

// Already-authorised devices that are currently plugged in and look
// like DFU. The UI polls this (after the operator's prompted to put
// the FC in DFU mode) so we can auto-pick up a device they previously
// approved.
export async function listAuthorisedDfuDevices(): Promise<DfuDeviceHandle[]> {
  if (!('usb' in navigator))
    return []
  const devices = await navigator.usb.getDevices()
  return devices
    .filter(d =>
      DFU_FILTERS.some(f => d.vendorId === f.vendorId && d.productId === f.productId),
    )
    .map((d) => {
      const manufacturer = d.manufacturerName ?? 'STMicroelectronics'
      const product = d.productName ?? 'DFU device'
      return { label: `${manufacturer} — ${product}`, device: d }
    })
}

// Open + claim a DFU device. Resolves with a USBControl ready for
// downloads, plus the chip metadata the workflow needs. The caller
// must call `control.close()` when done.
export async function openDfuDevice(device: USBDevice): Promise<OpenedDfuDevice> {
  await device.open()
  try {
    if (device.configuration === null)
      await device.selectConfiguration(1)

    // The DFU interface is the one whose `interfaceClass` is 0xFE
    // (application-specific) and `interfaceSubclass` is 0x01 (DFU).
    const config = device.configuration!
    const dfuIface = config.interfaces.find(iface =>
      iface.alternates.some(a => a.interfaceClass === 0xFE && a.interfaceSubclass === 0x01),
    )
    if (!dfuIface)
      throw new Error('Connected USB device has no DFU interface.')

    const interfaceNumber = dfuIface.interfaceNumber
    await device.claimInterface(interfaceNumber)

    // Pull the alt-setting strings up-front — they encode the memory
    // layout in DfuSe format. Some boards index strings starting from
    // 1, some from 4; we just gather whatever each alt-setting declares.
    const altSettingDescriptors: string[] = []
    for (const alt of dfuIface.alternates) {
      const idx = alt.interfaceName ? null : alt.alternateSetting
      // WebUSB exposes the resolved string as `interfaceName` once the
      // descriptor's been read — we prefer that to a raw GET_DESCRIPTOR
      // because the browser handles the langid dance for us.
      if (alt.interfaceName) {
        altSettingDescriptors.push(alt.interfaceName)
      }
      else if (idx !== null) {
        // Fall back: empty string (DFU client treats as "no layout").
        altSettingDescriptors.push('')
      }
    }

    // DFU functional descriptor — we want wTransferSize. Read the
    // configuration descriptor and walk it. The browser caches the
    // descriptor parse, but doesn't expose the parsed result; do the
    // walk by hand.
    const transferSize = await readDfuTransferSize(device).catch(() => 2048)

    const control = new WebUsbControl(device, interfaceNumber)
    return { control, transferSize, altSettingDescriptors, interfaceNumber }
  }
  catch (e) {
    // If anything failed after open(), tidy up before re-throwing —
    // a half-open device is annoying to recover from.
    try {
      await device.close()
    }
    catch {
      /* swallow — already in an error path */
    }
    throw e
  }
}

// Walk the configuration descriptor for a class-specific DFU
// functional descriptor (0x21) and pull wTransferSize. Returns 2048
// (the STM32 default) if the descriptor isn't present.
async function readDfuTransferSize(device: USBDevice): Promise<number> {
  // GET_DESCRIPTOR (configuration). First read 9 bytes to learn the
  // total length; then read the full descriptor blob.
  const setup: ControlSetup = {
    direction: 'in',
    requestType: 'standard',
    recipient: 'device',
    request: 0x06, // GET_DESCRIPTOR
    value: 0x0200, // configuration descriptor, index 0
    index: 0,
  }
  const result = await webusbControlIn(device, setup, 9)
  if (result.length < 9)
    return 2048
  const wTotalLength = result[2]! | (result[3]! << 8)
  const full = await webusbControlIn(device, setup, wTotalLength)
  // Walk descriptors looking for the DFU functional descriptor.
  let i = 0
  while (i < full.length) {
    const bLength = full[i]!
    const bType = full[i + 1]!
    if (bLength === 0)
      break
    if (bType === DFU_FUNC_DESCRIPTOR_TYPE && bLength >= 9) {
      // wTransferSize is at bytes 5..6 of the DFU functional descriptor.
      return full[i + 5]! | (full[i + 6]! << 8)
    }
    i += bLength
  }
  return 2048
}

// Production USBControl backed by WebUSB. Sits below `dfu-client.ts`.
class WebUsbControl implements USBControl {
  constructor(
    private readonly device: USBDevice,
    private readonly interfaceNumber: number,
  ) {}

  async controlOut(setup: ControlSetup, data: Uint8Array): Promise<void> {
    // controlTransferOut wants a buffer-source. Copy into a fresh
    // ArrayBuffer-backed Uint8Array — same workaround as in apj.ts:
    // strict-TS DOM signatures want `Uint8Array<ArrayBuffer>`, not the
    // wider `Uint8Array<ArrayBufferLike>` we may receive.
    const buf = new ArrayBuffer(data.byteLength)
    const fresh = new Uint8Array(buf)
    fresh.set(data)
    const result = await this.device.controlTransferOut(
      toWebUsbSetup(setup, this.interfaceNumber),
      fresh,
    )
    if (result.status !== 'ok')
      throw new Error(`USB controlTransferOut failed: ${result.status}`)
  }

  async controlIn(setup: ControlSetup, length: number): Promise<Uint8Array> {
    return webusbControlIn(this.device, toWebUsbSetup(setup, this.interfaceNumber), length)
  }

  async readStringDescriptor(index: number): Promise<string> {
    // We don't use this path in v1 — the alt-setting strings are
    // already gathered up-front in openDfuDevice — but the contract
    // requires the method. Implement it so a future caller has it.
    const setup: ControlSetup = {
      direction: 'in',
      requestType: 'standard',
      recipient: 'device',
      request: 0x06, // GET_DESCRIPTOR
      value: (0x03 << 8) | index, // string descriptor + index
      index: 0x0409, // US English (the only langid AP boards declare)
    }
    const bytes = await webusbControlIn(this.device, setup, 255)
    // bLength + bDescriptorType + UTF-16LE bytes.
    const utf16 = bytes.slice(2)
    let str = ''
    for (let i = 0; i + 1 < utf16.length; i += 2)
      str += String.fromCharCode(utf16[i]! | (utf16[i + 1]! << 8))
    return str
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.interfaceNumber)
    }
    catch {
      /* device may already be gone */
    }
    try {
      await this.device.close()
    }
    catch {
      /* device may already be gone */
    }
  }
}

// Convert our verbose ControlSetup into WebUSB's
// USBControlTransferParameters (bmRequestType is computed from
// requestType + recipient).
function toWebUsbSetup(setup: ControlSetup, claimedInterface: number): USBControlTransferParameters {
  return {
    requestType: setup.requestType,
    recipient: setup.recipient,
    request: setup.request,
    value: setup.value,
    // For interface-recipient requests the index *is* the interface
    // number, and DFU drives all of its requests at the claimed iface.
    // For device-recipient (descriptor) requests the caller's index is
    // a langid we forward as-is.
    index: setup.recipient === 'interface' ? claimedInterface : setup.index,
  }
}

// Helper used by both the class above and `readDfuTransferSize` (which
// runs before we have a USBControl instance). Wraps controlTransferIn
// + status check + data-view → Uint8Array conversion.
async function webusbControlIn(
  device: USBDevice,
  setup: USBControlTransferParameters,
  length: number,
): Promise<Uint8Array> {
  const result = await device.controlTransferIn(setup, length)
  if (result.status !== 'ok')
    throw new Error(`USB controlTransferIn failed: ${result.status}`)
  const view = result.data!
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}
