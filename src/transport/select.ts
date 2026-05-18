import type { Transport } from './types'
import { WebSerialTransport } from './webserial'
import { WebSocketTransport } from './websocket'

// Picks the runtime transport based on a URL parameter:
//   ?transport=websocket&host=localhost:5761  → WebSocketTransport (E2E / dev against SITL bridge)
// Default (no param)                          → WebSerialTransport (production)
//
// Production code never imports this *picker* — only the transports it
// returns. The URL-param indirection is what keeps test transports out of
// the production code path while leaving them runtime-selectable for the
// Playwright fixture and for local manual SITL testing.
export function resolveTransport(): Transport {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('transport')

  if (kind === 'websocket') {
    const host = params.get('host') ?? 'localhost:5761'
    return new WebSocketTransport(`ws://${host}`)
  }

  return new WebSerialTransport()
}
