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

// Freeing FTP sessions against a drone that isn't listening yet.
//
// This is the first thing to touch FTP after a reboot, and a drone
// brings its filesystem up well after it starts answering heartbeats.
// On a first boot after a mass erase that gap is widest — which is
// exactly when the exit ceremony restores settings.

import type { MessageHandler } from '../../src/protocol/mavlink'
import { FileTransferProtocol } from 'mavlink-mappings/dist/lib/common'
import { describe, expect, it } from 'vitest'
import { MavFtp } from '../../src/protocol/ftp'

const SYSID = 1
const COMPID = 1
const OP_ACK = 128

// An FTP ACK as the FC frames one: seq, session, opcode, size,
// req_opcode, burst_complete, padding, then a 4-byte offset.
function ack(seq: number, reqOpcode: number): FileTransferProtocol {
  const payload = new Uint8Array(251)
  payload[0] = seq & 0xFF
  payload[1] = (seq >> 8) & 0xFF
  payload[3] = OP_ACK
  payload[5] = reqOpcode
  const msg = new FileTransferProtocol()
  msg.payload = payload as unknown as number[]
  return msg
}

// A drone that ignores the first `deaf` requests, then answers.
function drone(deaf: number) {
  const handlers: MessageHandler[] = []
  let seen = 0
  return {
    sent: () => seen,
    send: async (msg: unknown) => {
      seen++
      if (seen <= deaf)
        return
      const req = Uint8Array.from((msg as FileTransferProtocol).payload as unknown as ArrayLike<number>)
      const seq = req[0]! | (req[1]! << 8)
      const reply = { msgid: 110, sysid: SYSID, compid: COMPID, data: ack(seq, req[3]!) }
      queueMicrotask(() => handlers.forEach(h => h(reply as never)))
    },
    subscribe: (cb: MessageHandler) => {
      handlers.push(cb)
      return () => {}
    },
  }
}

describe('freeing FTP sessions', () => {
  it('succeeds once the drone starts answering', async () => {
    const d = drone(2)
    const ftp = new MavFtp(d.send, d.subscribe, SYSID, COMPID)
    await ftp.resetSessions()
    expect(d.sent()).toBe(3)
  })

  it('answers first time on a drone that is ready', async () => {
    const d = drone(0)
    const ftp = new MavFtp(d.send, d.subscribe, SYSID, COMPID)
    await ftp.resetSessions()
    expect(d.sent()).toBe(1)
  })

  it('gives up rather than retrying forever', async () => {
    const d = drone(Number.MAX_SAFE_INTEGER)
    const ftp = new MavFtp(d.send, d.subscribe, SYSID, COMPID)
    await expect(ftp.resetSessions(2)).rejects.toThrow(/timed out/)
    expect(d.sent()).toBe(2)
  }, 20_000)
})
