// Transport layer abstraction — the seam between protocol code (MAVLink,
// MSP, 4-way, DFU) and the wire (WebSerial in production, WebSocket
// against the SITL bridge for E2E tests).
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
