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

// Browser-side WebSocket transport. In production we never use this — it's
// the bridge that lets headless / development browsers reach a SITL
// instance via `test/sitl/bridge.ts`. Selected via a URL parameter at app
// load; see src/transport/select.ts.

import type { Transport, TransportEvent, TransportEventListener } from './types'

export class WebSocketTransport implements Transport {
  readonly kind = 'websocket' as const
  readonly description: string

  private ws?: WebSocket
  private readonly listeners = {
    data: new Set<(bytes: Uint8Array) => void>(),
    close: new Set<() => void>(),
    error: new Set<(err: Error) => void>(),
  }

  constructor(private readonly url: string) {
    this.description = `WebSocket ${url}`
  }

  // Open the WebSocket and resolve when the bridge accepts the connection.
  // Wires up data / close / error handlers; binary frames are unwrapped
  // into Uint8Array before fanning out to subscribers.
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        this.ws = ws
        resolve()
      }
      ws.onerror = () => {
        // The browser's WebSocket Event carries no useful info on connect
        // failure; surface a plain message and let the close handler take
        // the connection down.
        const err = new Error(`WebSocket failed to connect to ${this.url}`)
        for (const cb of this.listeners.error) cb(err)
        reject(err)
      }
      ws.onmessage = (e) => {
        const bytes = e.data instanceof ArrayBuffer
          ? new Uint8Array(e.data)
          : new Uint8Array(0)
        for (const cb of this.listeners.data) cb(bytes)
      }
      ws.onclose = () => {
        this.ws = undefined
        for (const cb of this.listeners.close) cb()
      }
    })
  }

  // Close the WebSocket. Safe to call when not connected.
  async disconnect(): Promise<void> {
    this.ws?.close()
    this.ws = undefined
  }

  // Send a frame to the bridge. The bridge forwards the bytes verbatim
  // to SITL's TCP MAVLink port, so framing remains the caller's concern
  // (the MavLinkSession's serialize() produces a complete v2 packet).
  async send(bytes: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket transport not connected')
    }
    this.ws.send(bytes)
  }

  // Subscribe to a transport event ('data' | 'close' | 'error'). Returns
  // an unsubscribe function the caller must invoke to avoid leaking
  // listeners.
  on<E extends TransportEvent>(event: E, listener: TransportEventListener<E>): () => void {
    const bucket = this.listeners[event] as Set<TransportEventListener<E>>
    bucket.add(listener)
    return () => bucket.delete(listener)
  }
}
