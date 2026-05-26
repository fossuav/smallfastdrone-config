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

// Raw byte-level duplex over a serial port — the API the bootloader
// upload (and any future raw-serial protocol) talks to. Sits below
// MAVLink: no framing, no parser, just bytes in and bytes out, with
// the few helpers a request-response protocol actually needs
// (`readExact` with a timeout; `drain` to discard stale bytes between
// commands).
//
// Production implementation: a method on `WebSerialTransport` that
// closes its MAVLink-feed read loop, reopens the port at a requested
// baud, and returns a `RawSerial` over the raw port streams. Tests
// supply a `MockRawSerial` (this file) preloaded with the bytes the
// caller-under-test is expected to see, and assert what the caller
// writes back.

// What the bootloader client / DFU client / etc. needs from the
// underlying serial link. Independent of WebSerial so the protocol
// code is unit-testable against an in-memory queue.
export interface RawSerial {
  // Wait until `nBytes` bytes are available (or `timeoutMs` elapses),
  // pull them off the buffer and return them. Throws on timeout —
  // the protocol layer turns that into operator-readable copy
  // ("Bootloader didn't respond" etc.). Pass `Infinity` to wait
  // forever, but always prefer a real timeout.
  readExact: (nBytes: number, timeoutMs: number) => Promise<Uint8Array>
  // Discard any bytes currently in the input buffer. Useful between
  // bootloader commands so a half-finished previous reply doesn't
  // leak into the next one. (After resync we know the FC is quiet.)
  drain: () => void
  // Push bytes onto the port. Resolves once the writer's flushed.
  write: (bytes: Uint8Array) => Promise<void>
  // Close the underlying port + tear down the read pump. After this
  // every method throws.
  close: () => Promise<void>
}

// In-memory `RawSerial` for unit tests. Pre-load the bytes the
// device-under-test is expected to send back; the test reads the
// callers' writes off `written`. `feed()` simulates the device
// pushing more bytes mid-test (e.g. for tests that programmatically
// time-shift responses).
export class MockRawSerial implements RawSerial {
  // The bytes the test expects the *caller* to receive on subsequent
  // `readExact` calls. The constructor preloads; `feed` appends more.
  private incoming: number[] = []
  // The bytes the caller has written, in order — the test asserts
  // against this to verify command framing.
  readonly written: number[] = []
  private closed = false
  // FIFO of pending readExact promises waiting for enough bytes.
  // Resolved when `feed` (or constructor) pushes enough.
  private waiters: Array<{ need: number, resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> | null }> = []

  constructor(initialIncoming: number[] | Uint8Array = []) {
    this.feed(initialIncoming)
  }

  // Append bytes the next `readExact` call(s) should pull. Resolves
  // any waiters whose `need` is now satisfied.
  feed(bytes: number[] | Uint8Array): void {
    for (const b of bytes)
      this.incoming.push(b)
    this.runWaiters()
  }

  async readExact(nBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.closed)
      throw new Error('RawSerial: closed')
    if (this.incoming.length >= nBytes) {
      const out = new Uint8Array(this.incoming.splice(0, nBytes))
      return out
    }
    // Not enough buffered yet — queue a waiter.
    return await new Promise<Uint8Array>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            const i = this.waiters.findIndex(w => w.resolve === resolve)
            if (i >= 0)
              this.waiters.splice(i, 1)
            reject(new Error(`RawSerial.readExact: timed out waiting for ${nBytes} bytes (had ${this.incoming.length})`))
          }, timeoutMs)
        : null
      this.waiters.push({ need: nBytes, resolve, reject, timer })
    })
  }

  drain(): void {
    this.incoming.length = 0
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed)
      throw new Error('RawSerial: closed')
    for (const b of bytes)
      this.written.push(b)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const w of this.waiters) {
      if (w.timer)
        clearTimeout(w.timer)
      w.reject(new Error('RawSerial: closed during read'))
    }
    this.waiters.length = 0
  }

  // Walk the waiter queue, resolving any whose byte requirement is met.
  private runWaiters(): void {
    while (this.waiters.length > 0 && this.incoming.length >= this.waiters[0]!.need) {
      const w = this.waiters.shift()!
      if (w.timer)
        clearTimeout(w.timer)
      w.resolve(new Uint8Array(this.incoming.splice(0, w.need)))
    }
  }
}
