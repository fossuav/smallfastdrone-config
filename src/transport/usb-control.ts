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

// Minimal USB control-transfer abstraction — what the DFU client
// (`src/protocol/dfu-client.ts`) needs to talk to a DFU device, sliced
// to keep the protocol code unit-testable. Production hosts it on the
// `WebUSBTransport`; tests supply `MockUSBControl` and assert against
// the transfer log.
//
// We expose only IN/OUT control transfers + interface string reads (for
// the DfuSe memory-layout descriptor). Bulk / interrupt / iso transfers
// aren't needed: DFU is entirely control-driven.

// Direction qualifier for the control transfer. Maps 1:1 to the
// WebUSB API's USBDirection.
export type UsbDirection = 'in' | 'out'

// Class of the control transfer's bmRequestType. DFU is a "class"
// request (the spec calls it that); reading the interface string is a
// "standard" GET_DESCRIPTOR.
export type UsbRequestType = 'standard' | 'class' | 'vendor'

// Recipient of the control transfer's bmRequestType. DFU's targets the
// interface; descriptor reads target the device.
export type UsbRecipient = 'device' | 'interface' | 'endpoint' | 'other'

// One control-transfer setup. Mirrors WebUSB's USBControlTransferParameters
// but kept verbose so tests can read what's happening without decoding
// bmRequestType.
export interface ControlSetup {
  direction: UsbDirection
  requestType: UsbRequestType
  recipient: UsbRecipient
  request: number
  value: number
  index: number
}

// What the DFU client needs from the USB stack. Implementations open /
// claim / release / close behind the scenes; the protocol layer only
// does control transfers.
export interface USBControl {
  // Host → device. `data` may be empty (some DFU commands carry no
  // payload). Resolves on success; throws with a readable error on
  // STALL / NAK timeout / disconnect.
  controlOut: (setup: ControlSetup, data: Uint8Array) => Promise<void>
  // Device → host. Reads up to `length` bytes; the device may return
  // fewer (the returned array's length reflects what came back).
  controlIn: (setup: ControlSetup, length: number) => Promise<Uint8Array>
  // Read a string descriptor by index. DfuSe's memory-layout string
  // (e.g. "@Internal Flash  /0x08000000/04*16Kg,01*64Kg,07*128Kg") is
  // exposed as the alt-setting's iInterface descriptor. We pull all the
  // alt-setting strings up-front and pass them to the layout parser.
  readStringDescriptor: (index: number) => Promise<string>
  // Drop the device after we're done flashing. The transport closes
  // its handle so the FC's re-enumeration as the running app doesn't
  // collide with our claim.
  close: () => Promise<void>
}

// In-memory `USBControl` for unit tests. Tests pre-program the device's
// response queue per (request, value) pair and inspect the log of every
// transfer the client made.
export class MockUSBControl implements USBControl {
  // Each entry records what the client asked for + any data it sent.
  readonly log: Array<{ kind: 'in' | 'out', setup: ControlSetup, data?: Uint8Array }> = []
  // String descriptors by index (DfuSe layout string lives at the
  // alt-setting's iInterface).
  readonly strings = new Map<number, string>()
  // Closed flag — once true, every call throws.
  private closed = false
  // Per-request queues of bytes the device should reply with on
  // controlIn. The first matching entry is shifted off when consumed.
  // Key: `${request}:${value}`. Lets a test reply with [INSYNC,OK] on
  // GETSTATUS first time, then a different status the second time.
  private inQueues = new Map<string, Uint8Array[]>()
  // Optional hook: called for each controlOut. Lets tests simulate the
  // device's state machine (e.g. queue an in-response in reaction to
  // a specific out).
  outHook?: (setup: ControlSetup, data: Uint8Array, mock: MockUSBControl) => void

  // Pre-load `bytes` as the next response to a controlIn matching
  // (request, value). Multiple calls queue.
  queueIn(request: number, value: number, bytes: number[] | Uint8Array): void {
    const key = `${request}:${value}`
    const arr = this.inQueues.get(key) ?? []
    arr.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    this.inQueues.set(key, arr)
  }

  async controlOut(setup: ControlSetup, data: Uint8Array): Promise<void> {
    if (this.closed)
      throw new Error('USBControl: closed')
    this.log.push({ kind: 'out', setup, data: new Uint8Array(data) })
    this.outHook?.(setup, data, this)
  }

  async controlIn(setup: ControlSetup, length: number): Promise<Uint8Array> {
    if (this.closed)
      throw new Error('USBControl: closed')
    this.log.push({ kind: 'in', setup })
    const key = `${setup.request}:${setup.value}`
    const q = this.inQueues.get(key)
    if (!q || q.length === 0)
      throw new Error(`MockUSBControl: no queued response for request=${setup.request} value=${setup.value} (length=${length})`)
    const bytes = q.shift()!
    // Mirror the real device: it may return fewer than `length` bytes.
    return bytes.length <= length ? bytes : bytes.slice(0, length)
  }

  async readStringDescriptor(index: number): Promise<string> {
    if (this.closed)
      throw new Error('USBControl: closed')
    return this.strings.get(index) ?? ''
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
