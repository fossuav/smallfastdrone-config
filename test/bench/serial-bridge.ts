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

// Bench bridge — the real-hardware twin of `test/sitl/bridge.ts`. Pipes a
// browser WebSocket client to an actual flight controller's serial port
// instead of to SITL's TCP port. Same wire contract, so the app reaches a
// board on the bench with the transport it already has:
//
//   http://localhost:5173/?transport=websocket&host=localhost:5761
//
// That lets the Playwright suite run against real hardware rather than
// SITL, and lets a browser drive a board it can't otherwise see — on WSL,
// Chrome runs on Windows and the dev server on Linux. It does not replace
// validating the production WebSerial path in Chrome directly; the app
// only ever talks to a real operator's board through WebSerial.
//
// The serial link is opened once and held for the life of the bridge,
// across client connects and across board reboots: the helper behind it
// reopens the port by itself, so a reboot closes the WebSocket (which is
// what a real disconnect looks like to the app) while the port underneath
// comes back on its own, ready for the app's reconnect.
//
// Run:
//   bun run bench:bridge
// Env:
//   BRIDGE_PORT  WebSocket port the browser connects to (default 5761)
//   BENCH_PORT   board's serial port (default: found by USB VID:PID)
//   BENCH_PYTHON interpreter for the serial helper (default python.exe)

import process from 'node:process'
import { openSerialLink } from './serial-link'

interface WSData {
  clientId: string
}

const BRIDGE_PORT = Number.parseInt(process.env.BRIDGE_PORT ?? '5761', 10)

let nextClientId = 1

// The helper waits for the board rather than failing when it isn't there
// yet, so start serving immediately and let the port open underneath. A
// client that connects early simply sees no traffic until it does.
const link = openSerialLink()
link.ready(30_000).catch((e: unknown) => {
  console.error(`[bench-bridge] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})

// One client at a time, matching the SITL bridge. `client` is the socket
// currently receiving board bytes; everything else is fan-out bookkeeping.
let client: Bun.ServerWebSocket<WSData> | null = null

link.onData((bytes) => {
  client?.send(bytes)
})

// A reboot takes the port down. Close the socket so the app sees a real
// disconnect and runs its reconnect path; the link reopens underneath.
link.onClose(() => {
  console.log(`[bench-bridge] serial closed (reboot or unplug)`)
  client?.close(1000, 'serial closed')
})

link.onOpen((p) => {
  console.log(`[bench-bridge] serial open on ${p}`)
})

const server = Bun.serve<WSData, object>({
  port: BRIDGE_PORT,
  fetch(req, srv) {
    if (srv.upgrade(req, { data: { clientId: `c${nextClientId++}` } }))
      return
    return new Response(
      `Bench bridge\nWebSocket only. Connect via ws://localhost:${BRIDGE_PORT}\n`,
      { headers: { 'content-type': 'text/plain' } },
    )
  },
  websocket: {
    open(ws) {
      console.log(`[bench-bridge] ${ws.data.clientId} connected`)
      client?.close(1000, 'replaced by a newer client')
      client = ws
    },
    message(ws, msg) {
      if (client !== ws)
        return
      link.write(typeof msg === 'string' ? new TextEncoder().encode(msg) : new Uint8Array(msg))
    },
    close(ws) {
      console.log(`[bench-bridge] ${ws.data.clientId} ws closed`)
      if (client === ws)
        client = null
    },
  },
})

console.log(`[bench-bridge] WebSocket listening on ws://localhost:${server.port}`)
