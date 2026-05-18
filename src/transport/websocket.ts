import type { Transport, TransportEvent, TransportEventListener } from './types'

// Browser-side WebSocket transport. In production we never use this — it's
// the bridge that lets headless / development browsers reach a SITL
// instance via `test/sitl/bridge.ts`. Selected via a URL parameter at app
// load; see src/transport/select.ts.
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

  async disconnect(): Promise<void> {
    this.ws?.close()
    this.ws = undefined
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket transport not connected')
    }
    this.ws.send(bytes)
  }

  on<E extends TransportEvent>(event: E, listener: TransportEventListener<E>): () => void {
    const bucket = this.listeners[event] as Set<TransportEventListener<E>>
    bucket.add(listener)
    return () => bucket.delete(listener)
  }
}
