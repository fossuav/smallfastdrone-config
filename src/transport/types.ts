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

// Transport layer abstraction — the seam between protocol code (MAVLink,
// MSP, 4-way, DFU) and the wire (WebSerial in production, WebSocket
// against the SITL bridge for E2E tests). Defines the Transport interface
// every concrete transport implements + the discriminated event listener
// types its `on()` method takes.
//
// Production code only imports the production transports (WebSerialTransport,
// WebUSBTransport). Test transports (WebSocketTransport) are selected at
// runtime via a URL param in main.ts. See docs/ARCHITECTURE.md "Transport
// abstraction" and docs/TESTING.md.

export type TransportKind = 'webserial' | 'websocket' | 'webusb'

export type TransportEvent = 'data' | 'close' | 'error'

export type TransportEventListener<E extends TransportEvent>
  = E extends 'data' ? (bytes: Uint8Array) => void
    : E extends 'close' ? () => void
      : E extends 'error' ? (err: Error) => void
        : never

export interface Transport {
  readonly kind: TransportKind
  /** Operator-facing description, e.g. "USB serial (CubeOrange)" or "WebSocket ws://localhost:5761". */
  readonly description: string

  connect: () => Promise<void>
  disconnect: () => Promise<void>
  send: (bytes: Uint8Array) => Promise<void>

  /** Subscribe to a transport event. Returns an unsubscribe function. */
  on: <E extends TransportEvent>(event: E, listener: TransportEventListener<E>) => () => void
}
