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

// Production transport: USB CDC-ACM via the Web Serial API. Used when the
// operator clicks "Connect drone" without the `?transport=websocket&...`
// URL param (which is the SITL-bridge override).
//
// Web Serial API requires a Chromium-family browser and a secure context
// (HTTPS or http://localhost). `connect()` must be called inside a user
// gesture handler — our Connect button click chain satisfies that.

import type { Transport, TransportEvent, TransportEventListener } from './types'

const BAUD_RATE = 115_200 // ArduPilot USB-CDC default; doesn't actually matter
//                          for CDC-ACM but the API requires a value.

interface SerialPortInfoLite {
  usbVendorId?: number
  usbProductId?: number
}

export class WebSerialTransport implements Transport {
  readonly kind = 'webserial' as const
  description = 'USB serial'

  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readerTask: Promise<void> | null = null
  private readonly listeners = {
    data: new Set<(bytes: Uint8Array) => void>(),
    close: new Set<() => void>(),
    error: new Set<(err: Error) => void>(),
  }

  // Prompt the operator to pick a serial port, open it at the FC's default
  // settings, and start a background read loop that fans data events out
  // to subscribers. Must be invoked from a user gesture handler (Web Serial
  // requirement). Throws a friendly Error if the operator cancels the
  // browser's port picker.
  async connect(): Promise<void> {
    if (!('serial' in navigator)) {
      throw new Error('Your browser doesn\'t support Web Serial. Try Chrome, Edge, or another Chromium-based browser.')
    }

    let port: SerialPort
    try {
      // Empty filters means "let the operator pick any serial device".
      // We could narrow with USB vendor/product IDs once we have a list
      // of known SFD FC boards; defaulting to any keeps the dialog
      // forgiving for prototype hardware.
      port = await navigator.serial.requestPort({ filters: [] })
    }
    catch (e) {
      // requestPort rejects with NotFoundError if the user cancels the picker.
      // Surface it as a friendly message rather than the raw DOMException.
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        throw new Error('No drone selected')
      }
      throw e
    }

    await port.open({
      baudRate: BAUD_RATE,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
    })

    this.port = port
    this.description = describePort(port.getInfo())
    this.readerTask = this.readLoop()
  }

  // Cleanly shut the port down. Safe to call when not connected, and safe
  // to call after the device was physically unplugged (errors from the
  // underlying API are swallowed because the port is going away anyway).
  async disconnect(): Promise<void> {
    // Cancelling the reader makes the readLoop's await throw, which
    // releases the lock in the finally and emits the close event.
    if (this.reader) {
      try {
        await this.reader.cancel()
      }
      catch {
        // already closing
      }
    }
    if (this.readerTask) {
      await this.readerTask.catch(() => {})
      this.readerTask = null
    }
    if (this.port) {
      try {
        await this.port.close()
      }
      catch {
        // already closed (e.g. unplugged)
      }
      this.port = null
    }
  }

  // Synchronously write a chunk of bytes to the FC. Acquires + releases the
  // writable-stream lock per send so concurrent senders don't deadlock — the
  // expected sender is the MavLinkSession, which serialises by construction.
  async send(bytes: Uint8Array): Promise<void> {
    const port = this.port
    if (!port?.writable) {
      throw new Error('Serial port not open')
    }
    const writer = port.writable.getWriter()
    try {
      await writer.write(bytes)
    }
    finally {
      writer.releaseLock()
    }
  }

  // Subscribe to a transport event ('data' | 'close' | 'error'). Returns
  // an unsubscribe function the caller must invoke to avoid leaking
  // listeners when the subscriber goes away.
  on<E extends TransportEvent>(event: E, listener: TransportEventListener<E>): () => void {
    const bucket = this.listeners[event] as Set<TransportEventListener<E>>
    bucket.add(listener)
    return () => bucket.delete(listener)
  }

  // Background task that pulls chunks out of the port's readable stream
  // and dispatches them to data subscribers. Terminates when the reader is
  // cancelled (disconnect path) or the device disappears (errors fan out
  // to error subscribers before the close event fires).
  private async readLoop(): Promise<void> {
    const port = this.port
    if (!port?.readable)
      return
    this.reader = port.readable.getReader()
    try {
      while (true) {
        const { value, done } = await this.reader.read()
        if (done)
          break
        if (value && value.length > 0) {
          for (const cb of this.listeners.data) cb(value)
        }
      }
    }
    catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      for (const cb of this.listeners.error) cb(err)
    }
    finally {
      try {
        this.reader?.releaseLock()
      }
      catch {
        // lock already released
      }
      this.reader = null
      for (const cb of this.listeners.close) cb()
    }
  }
}

// Produce an operator-friendly description of an opened serial port. Falls
// back to a generic label if the browser hides the USB identifiers (some
// non-USB serial adapters, virtual COM ports, etc.).
function describePort(info: SerialPortInfoLite): string {
  if (info.usbVendorId !== undefined) {
    const vid = info.usbVendorId.toString(16).padStart(4, '0')
    const pid = info.usbProductId?.toString(16).padStart(4, '0') ?? '????'
    return `USB serial (VID:${vid} PID:${pid})`
  }
  return 'USB serial'
}
