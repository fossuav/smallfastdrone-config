import type { Transport, TransportEvent, TransportEventListener } from './types'

// Production transport for connecting to a real drone over USB CDC-ACM
// via the Web Serial API. Stub for this slice — real implementation lands
// when there's a bench drone to test against. The Connect view falls back
// to instructing the operator how to use SITL in the meantime.
export class WebSerialTransport implements Transport {
  readonly kind = 'webserial' as const
  readonly description = 'USB serial'

  async connect(): Promise<void> {
    throw new Error('WebSerial transport not implemented yet — start the SITL bridge and add ?transport=websocket&host=localhost:5761 to the URL')
  }

  async disconnect(): Promise<void> {}
  async send(_bytes: Uint8Array): Promise<void> {}

  on<E extends TransportEvent>(_event: E, _listener: TransportEventListener<E>): () => void {
    return () => {}
  }
}
