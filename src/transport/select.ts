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

// Runtime transport picker. Resolves which concrete Transport
// implementation the session store should use, based on URL parameters.
// The indirection keeps test transports out of the production code path
// while leaving them runtime-selectable for the Playwright fixture and
// for local manual SITL testing.

import type { Transport } from './types'
import { WebSerialTransport } from './webserial'
import { WebSocketTransport } from './websocket'

// Returns the concrete Transport for this session.
//   ?transport=websocket&host=localhost:5761 → WebSocketTransport
//                                              (E2E / dev against SITL bridge)
//   default (no param)                       → WebSerialTransport (production)
export function resolveTransport(): Transport {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('transport')

  if (kind === 'websocket') {
    const host = params.get('host') ?? 'localhost:5761'
    return new WebSocketTransport(`ws://${host}`)
  }

  return new WebSerialTransport()
}
