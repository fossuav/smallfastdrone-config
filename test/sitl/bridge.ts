// SITL bridge — pipes a single browser WebSocket client to SITL's TCP
// MAVLink port (default 127.0.0.1:5760). Zero external deps; uses Bun's
// built-in `Bun.serve` (WebSocket) and `Bun.connect` (TCP).
//
// Started manually (`bun run bridge:start`) or by the Playwright fixture
// in a later slice. See docs/TESTING.md for the architecture.
//
// Run:
//   bun run bridge:start
// Env:
//   BRIDGE_PORT  WebSocket port the browser connects to (default 5761)
//   SITL_HOST    SITL TCP host (default 127.0.0.1)
//   SITL_PORT    SITL TCP port (default 5760)

import type { Socket } from 'bun'

interface WSData {
  tcp?: Socket<undefined>
  clientId: string
}

const BRIDGE_PORT = Number.parseInt(process.env.BRIDGE_PORT ?? '5761', 10)
const SITL_HOST = process.env.SITL_HOST ?? '127.0.0.1'
const SITL_PORT = Number.parseInt(process.env.SITL_PORT ?? '5760', 10)

let nextClientId = 1

const server = Bun.serve<WSData, object>({
  port: BRIDGE_PORT,
  fetch(req, srv) {
    if (srv.upgrade(req, { data: { clientId: `c${nextClientId++}` } }))
      return
    return new Response(
      `SITL bridge\nWebSocket only. Connect via ws://localhost:${BRIDGE_PORT}\n`,
      { headers: { 'content-type': 'text/plain' } },
    )
  },
  websocket: {
    async open(ws) {
      const id = ws.data.clientId
      console.log(`[bridge] ${id} connected; opening TCP ${SITL_HOST}:${SITL_PORT}`)
      try {
        const tcp = await Bun.connect({
          hostname: SITL_HOST,
          port: SITL_PORT,
          socket: {
            data(_s, data) {
              ws.send(data)
            },
            close() {
              console.log(`[bridge] ${id} tcp closed`)
              ws.close(1000, 'SITL closed')
            },
            error(_s, err) {
              console.error(`[bridge] ${id} tcp error:`, err.message)
              ws.close(1011, 'tcp error')
            },
          },
        })
        ws.data.tcp = tcp
        console.log(`[bridge] ${id} tcp open`)
      }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[bridge] ${id} tcp connect failed: ${msg}`)
        ws.close(1011, `tcp connect failed: ${msg}`)
      }
    },
    message(ws, msg) {
      const tcp = ws.data.tcp
      if (!tcp)
        return
      if (typeof msg === 'string') {
        tcp.write(new TextEncoder().encode(msg))
      }
      else {
        tcp.write(msg)
      }
    },
    close(ws) {
      const id = ws.data.clientId
      console.log(`[bridge] ${id} ws closed`)
      ws.data.tcp?.end()
    },
  },
})

console.log(
  `[bridge] WebSocket listening on ws://localhost:${server.port}, bridging to ${SITL_HOST}:${SITL_PORT}`,
)
