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

import type { RawSerial } from './raw-serial'
import type { Transport, TransportEvent, TransportEventListener } from './types'

const BAUD_RATE = 115_200 // ArduPilot USB-CDC default; doesn't actually matter
//                          for CDC-ACM but the API requires a value.

// Open-with-retry tuning for re-acquiring the port after the FC reboots
// (firmware → bootloader and bootloader → firmware). The device briefly
// disappears + re-enumerates; `port.open()` rejects until the OS sees it
// again. ArduPilot bootloaders typically come up within ~1s; we give it
// a generous window.
const REOPEN_ATTEMPTS = 50
const REOPEN_RETRY_DELAY_MS = 200

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

  // The currently-open MAVLink port (or null). Exposed so the firmware
  // workflow can diff `getPorts()` snapshots against it — ArduPilot's
  // bootloader enumerates as a *different* USB device (different VID:PID)
  // than the running firmware on most boards, so the post-reboot port
  // isn't the same object.
  currentPort(): SerialPort | null {
    return this.port
  }

  // Snapshot which authorised ports are currently *connected* (their
  // underlying USB device is enumerated right now). Together with
  // `currentPort()`, lets the workflow distinguish "this port was
  // already physically plugged in before the reboot" from "this port
  // just appeared, so it's the bootloader". `SerialPort.connected`
  // tracks the underlying USB device's presence — false for any
  // authorised port whose physical device isn't currently attached.
  async snapshotConnectedPorts(): Promise<SerialPort[]> {
    if (!('serial' in navigator))
      return []
    const ports = await navigator.serial.getPorts()
    return ports.filter(p => p.connected)
  }

  // Cancel the MAVLink read pump + close the originally-open port,
  // *without* trying to reopen anything. Used by the firmware workflow:
  // after the FC has been told to reboot into its bootloader, we let the
  // original port go and then open whichever port the bootloader came
  // up on (often a different USB device entirely).
  async detachMavlink(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel()
      }
      catch { /* already cancelled */ }
    }
    if (this.readerTask) {
      await this.readerTask.catch(() => {})
      this.readerTask = null
    }
    if (this.port) {
      try {
        await this.port.close()
      }
      catch { /* already closed (the FC has rebooted) */ }
      this.port = null
    }
  }

  // Open the given SerialPort at the requested baud and hand back a
  // `RawSerial` over its streams. The port can be:
  //   - one freshly returned by `navigator.serial.requestPort()` inside
  //     a user gesture (the operator just picked the bootloader port);
  //   - one already in `getPorts()` (pre-authorised — typically the
  //     case for any flash after the first one to a given board).
  // Settle delay + open retries cover the case where the device is
  // still re-enumerating when we get here. Caller is responsible for
  // `close()`-ing the returned RawSerial.
  async openPortRaw(
    port: SerialPort,
    opts: { baudRate?: number, settleDelayMs?: number } = {},
  ): Promise<RawSerial> {
    if (opts.settleDelayMs && opts.settleDelayMs > 0)
      await sleep(opts.settleDelayMs)
    const baud = opts.baudRate ?? BAUD_RATE
    let lastErr: unknown = null
    for (let i = 0; i < REOPEN_ATTEMPTS; i++) {
      try {
        await port.open({ baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' })
        lastErr = null
        break
      }
      catch (e) {
        lastErr = e
        await sleep(REOPEN_RETRY_DELAY_MS)
      }
    }
    if (lastErr !== null) {
      const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
      throw new Error(`Couldn't open the bootloader port (${detail}). Try unplugging + plugging the USB cable.`)
    }
    return new PortRawSerial(port)
  }

  // Take raw control of the *same* serial port for a non-MAVLink protocol.
  // Convenience wrapper used in tests + the fallback case where the
  // bootloader actually came up on the same USB device. The firmware
  // workflow prefers the explicit detach + openPortRaw split so it can
  // handle the (common) case where the bootloader is a different device.
  async acquireRaw(opts: { baudRate?: number, settleDelayMs?: number } = {}): Promise<RawSerial> {
    const port = this.port
    if (!port)
      throw new Error('No serial port to take over — connect first.')
    await this.detachMavlink()
    // detachMavlink nulled this.port; restore the local ref for the open.
    return await this.openPortRaw(port, opts)
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// RawSerial implementation backed directly by a WebSerial `SerialPort`'s
// reader + writer. Used during firmware upload — the MAVLink data pump
// is gone, this owns the port's readable stream until `close()`.
//
// Buffers incoming bytes in a list of Uint8Arrays; `readExact` waits
// (with a timeout) until enough are queued, splices them off, and
// hands back a single contiguous Uint8Array.
class PortRawSerial implements RawSerial {
  private readonly chunks: Uint8Array[] = []
  private bufferedBytes = 0
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private waiter: { need: number, resolve: (b: Uint8Array) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> | null } | null = null
  private closed = false

  constructor(private readonly port: SerialPort) {
    void this.pump()
  }

  async readExact(nBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.closed)
      throw new Error('RawSerial: closed')
    if (this.waiter)
      throw new Error('RawSerial.readExact: concurrent reads not supported')
    if (this.bufferedBytes >= nBytes)
      return this.takeFromBuffer(nBytes)
    return await new Promise<Uint8Array>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.waiter = null
            reject(new Error(`RawSerial.readExact: timed out waiting for ${nBytes} bytes (had ${this.bufferedBytes})`))
          }, timeoutMs)
        : null
      this.waiter = { need: nBytes, resolve, reject, timer }
    })
  }

  drain(): void {
    this.chunks.length = 0
    this.bufferedBytes = 0
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed)
      throw new Error('RawSerial: closed')
    if (!this.port.writable)
      throw new Error('RawSerial: port not writable')
    const writer = this.port.writable.getWriter()
    try {
      await writer.write(bytes)
    }
    finally {
      writer.releaseLock()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.waiter) {
      if (this.waiter.timer)
        clearTimeout(this.waiter.timer)
      this.waiter.reject(new Error('RawSerial: closed during read'))
      this.waiter = null
    }
    if (this.reader) {
      try {
        await this.reader.cancel()
      }
      catch { /* already cancelled */ }
    }
    try {
      await this.port.close()
    }
    catch { /* already closed */ }
  }

  private takeFromBuffer(nBytes: number): Uint8Array {
    const out = new Uint8Array(nBytes)
    let written = 0
    while (written < nBytes) {
      const head = this.chunks[0]!
      const take = Math.min(head.length, nBytes - written)
      out.set(head.subarray(0, take), written)
      written += take
      if (take === head.length)
        this.chunks.shift()
      else
        this.chunks[0] = head.subarray(take)
    }
    this.bufferedBytes -= nBytes
    return out
  }

  private async pump(): Promise<void> {
    if (!this.port.readable)
      return
    this.reader = this.port.readable.getReader()
    try {
      while (true) {
        const { value, done } = await this.reader.read()
        if (done)
          break
        if (value && value.length > 0) {
          this.chunks.push(value)
          this.bufferedBytes += value.length
          if (this.waiter && this.bufferedBytes >= this.waiter.need) {
            const w = this.waiter
            this.waiter = null
            if (w.timer)
              clearTimeout(w.timer)
            w.resolve(this.takeFromBuffer(w.need))
          }
        }
      }
    }
    catch {
      // Reader cancelled or device went away — close() handles the rejection
      // of any pending waiter via its own path.
    }
    finally {
      try {
        this.reader?.releaseLock()
      }
      catch { /* already released */ }
      this.reader = null
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
