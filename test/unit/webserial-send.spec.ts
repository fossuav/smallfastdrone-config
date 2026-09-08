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

// Concurrent sends over WebSerial.
//
// A WritableStream takes exactly one writer, and the transport awaits
// while holding it — so two callers that don't await each other used to
// collide with "WritableStream is already locked". Reported from a real
// board: connecting asked for AUTOPILOT_VERSION and for telemetry at the
// same time, and the second lost. Nothing caught it because the E2E
// suite runs over a WebSocket, which has no such lock.
//
// A real WritableStream is used rather than a stub, because the lock is
// the thing under test.

import { describe, expect, it } from 'vitest'
import { WebSerialTransport } from '../../src/transport/webserial'

// The slice of SerialPort the transport touches when sending.
function fakePort(written: Uint8Array[], delayMs = 0): unknown {
  return {
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        if (delayMs > 0)
          await new Promise(r => setTimeout(r, delayMs))
        written.push(chunk)
      },
    }),
    readable: null,
    async open() {},
    async close() {},
  }
}

// The transport takes its port from connect(); for this we inject it.
function transportWith(port: unknown): WebSerialTransport {
  const t = new WebSerialTransport()
  ;(t as unknown as { port: unknown }).port = port
  return t
}

describe('webSerial concurrent sends', () => {
  it('does not collide when two callers send without awaiting each other', async () => {
    const written: Uint8Array[] = []
    const t = transportWith(fakePort(written, 5))

    // Exactly the shape that failed: fired together, awaited together.
    await Promise.all([
      t.send(Uint8Array.from([1])),
      t.send(Uint8Array.from([2])),
      t.send(Uint8Array.from([3])),
    ])

    expect(written.map(c => c[0])).toEqual([1, 2, 3])
  })

  it('keeps the queue usable after a write fails', async () => {
    const written: Uint8Array[] = []
    let fail = true
    const port = {
      writable: new WritableStream<Uint8Array>({
        async write(chunk) {
          if (fail) {
            fail = false
            throw new Error('device went away')
          }
          written.push(chunk)
        },
      }),
      readable: null,
    }
    const t = transportWith(port)

    // The caller sees its own failure...
    await expect(t.send(Uint8Array.from([1]))).rejects.toThrow(/device went away/)
    // ...and a later send is not wedged behind it.
    // (a failed WritableStream errors permanently, so a fresh port stands
    // in for the reconnect that a real failure forces)
    ;(t as unknown as { port: unknown }).port = fakePort(written)
    await t.send(Uint8Array.from([2]))
    expect(written.map(c => c[0])).toEqual([2])
  })

  it('refuses to send with no port rather than throwing something obscure', async () => {
    const t = new WebSerialTransport()
    await expect(t.send(Uint8Array.from([1]))).rejects.toThrow(/not open/)
  })
})
