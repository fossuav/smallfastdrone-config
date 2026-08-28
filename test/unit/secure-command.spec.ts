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

// SecureCommandClient against a fake link. SECURE_COMMAND handling only
// exists in signed firmware builds, so SITL can never answer these;
// the wire shape and reply matching are pinned here instead, and the
// bench (sfd_identity.py in the firmware repo) covers the real drone.

import type { MavLinkData } from 'mavlink-mappings'
import type { SecureCommand, SecureCommandOp } from 'mavlink-mappings/dist/lib/ardupilotmega'
import type { DecodedMessage, MessageHandler } from '../../src/protocol/mavlink'
import { SecureCommandReply } from 'mavlink-mappings/dist/lib/ardupilotmega'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeIdentity,
  IDENTITY_KEY_LEN,
  IDENTITY_UID_LEN,
  SECURE_OP,
  SecureCommandClient,
  SecureCommandError,
} from '../../src/protocol/secure-command'

const SYSID = 7
const COMPID = 1

// Records what the client sends and lets a test answer as the drone would.
class FakeLink {
  sent: SecureCommand[] = []
  handlers = new Set<MessageHandler>()
  failSend: Error | null = null

  send = async (msg: MavLinkData): Promise<void> => {
    if (this.failSend)
      throw this.failSend
    this.sent.push(msg as SecureCommand)
  }

  subscribe = (cb: MessageHandler): (() => void) => {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  client(): SecureCommandClient {
    return new SecureCommandClient(this.send, this.subscribe, SYSID, COMPID)
  }

  // The sequence of the most recent command — what a drone echoes back.
  lastSequence(): number {
    const last = this.sent.at(-1)
    if (!last)
      throw new Error('nothing sent yet')
    return last.sequence
  }

  // Deliver a SECURE_COMMAND_REPLY the way the session would decode it.
  reply(sequence: number, operation: number, result: MavResult, data: Uint8Array = new Uint8Array(0)): void {
    const r = new SecureCommandReply()
    r.sequence = sequence
    r.operation = operation as SecureCommandOp
    r.result = result
    r.dataLength = data.byteLength
    const padded = new Uint8Array(220)
    padded.set(data)
    r.data = Array.from(padded)
    const msg: DecodedMessage = {
      msgid: SecureCommandReply.MSG_ID,
      msgName: SecureCommandReply.MSG_NAME,
      sysid: SYSID,
      compid: COMPID,
      seq: 0,
      data: r,
    }
    for (const h of [...this.handlers]) h(msg)
  }
}

// A recognisable 44-byte identity: uid 1..12, key 100..131.
function identityBytes(): Uint8Array {
  const out = new Uint8Array(IDENTITY_UID_LEN + IDENTITY_KEY_LEN)
  for (let i = 0; i < IDENTITY_UID_LEN; i++) out[i] = i + 1
  for (let i = 0; i < IDENTITY_KEY_LEN; i++) out[IDENTITY_UID_LEN + i] = 100 + i
  return out
}

// Let the client's async send land before a test answers it.
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('secureCommandClient.getIdentity', () => {
  it('sends an unsigned GET_IDENTITY addressed to the drone', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()

    expect(link.sent).toHaveLength(1)
    const cmd = link.sent[0]
    expect(cmd?.targetSystem).toBe(SYSID)
    expect(cmd?.targetComponent).toBe(COMPID)
    expect(cmd?.operation).toBe(SECURE_OP.GET_IDENTITY)
    expect(cmd?.dataLength).toBe(0)
    expect(cmd?.sigLength).toBe(0)
    expect((cmd?.data as unknown as ArrayLike<number>).length).toBe(220)

    link.reply(link.lastSequence(), SECURE_OP.GET_IDENTITY, MavResult.ACCEPTED, identityBytes())
    await pending
  })

  it('decodes the uid and public key from an accepted reply', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()
    link.reply(link.lastSequence(), SECURE_OP.GET_IDENTITY, MavResult.ACCEPTED, identityBytes())

    const identity = await pending
    expect(identity).not.toBeNull()
    expect(Array.from(identity?.uid ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(identity?.publicKey.byteLength).toBe(IDENTITY_KEY_LEN)
    expect(identity?.publicKey[0]).toBe(100)
    expect(identity?.publicKey[31]).toBe(131)
    // The subscription is released once the reply is matched.
    expect(link.handlers.size).toBe(0)
  })

  it('resolves null when the drone has no identity yet', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()
    link.reply(link.lastSequence(), SECURE_OP.GET_IDENTITY, MavResult.FAILED)
    expect(await pending).toBeNull()
  })

  it('ignores replies for other sequences or operations', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()
    const seq = link.lastSequence()
    link.reply((seq + 1) >>> 0, SECURE_OP.GET_IDENTITY, MavResult.FAILED)
    link.reply(seq, SECURE_OP.GENERATE_IDENTITY, MavResult.FAILED)
    expect(link.handlers.size).toBe(1)

    link.reply(seq, SECURE_OP.GET_IDENTITY, MavResult.ACCEPTED, identityBytes())
    expect(await pending).not.toBeNull()
  })

  it('reports firmware without identity support', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()
    link.reply(link.lastSequence(), SECURE_OP.GET_IDENTITY, MavResult.UNSUPPORTED)

    const err = await pending.catch(e => e)
    expect(err).toBeInstanceOf(SecureCommandError)
    expect((err as SecureCommandError).result).toBe(MavResult.UNSUPPORTED)
    expect((err as SecureCommandError).message).toMatch(/doesn't support/)
  })

  it('rejects a reply of the wrong length', async () => {
    const link = new FakeLink()
    const pending = link.client().getIdentity()
    await tick()
    link.reply(link.lastSequence(), SECURE_OP.GET_IDENTITY, MavResult.ACCEPTED, identityBytes().subarray(0, 40))

    const err = await pending.catch(e => e)
    expect(err).toBeInstanceOf(SecureCommandError)
    expect((err as SecureCommandError).result).toBeNull()
    expect((err as SecureCommandError).timedOut).toBe(false)
  })
})

describe('secureCommandClient.generateIdentity', () => {
  it('sends GENERATE_IDENTITY and returns the identity the drone wrote', async () => {
    const link = new FakeLink()
    const pending = link.client().generateIdentity()
    await tick()
    expect(link.sent[0]?.operation).toBe(SECURE_OP.GENERATE_IDENTITY)
    expect(link.sent[0]?.sigLength).toBe(0)

    link.reply(link.lastSequence(), SECURE_OP.GENERATE_IDENTITY, MavResult.ACCEPTED, identityBytes())
    const identity = await pending
    expect(identity.uid.byteLength).toBe(IDENTITY_UID_LEN)
    expect(identity.publicKey.byteLength).toBe(IDENTITY_KEY_LEN)
  })

  it('surfaces DENIED as a typed error the workflow can branch on', async () => {
    const link = new FakeLink()
    const pending = link.client().generateIdentity()
    await tick()
    link.reply(link.lastSequence(), SECURE_OP.GENERATE_IDENTITY, MavResult.DENIED)

    const err = await pending.catch(e => e)
    expect(err).toBeInstanceOf(SecureCommandError)
    expect((err as SecureCommandError).operation).toBe(SECURE_OP.GENERATE_IDENTITY)
    expect((err as SecureCommandError).result).toBe(MavResult.DENIED)
  })
})

describe('secureCommandClient.request', () => {
  it('uses a fresh sequence for every command', async () => {
    const link = new FakeLink()
    const client = link.client()
    const first = client.request(SECURE_OP.GET_IDENTITY)
    const second = client.request(SECURE_OP.GET_IDENTITY)
    await tick()

    const [a, b] = link.sent
    expect(a?.sequence).not.toBe(b?.sequence)
    expect(b?.sequence).toBe(((a?.sequence ?? 0) + 1) >>> 0)

    // Each reply lands on its own request, regardless of order.
    link.reply(b?.sequence ?? 0, SECURE_OP.GET_IDENTITY, MavResult.FAILED)
    link.reply(a?.sequence ?? 0, SECURE_OP.GET_IDENTITY, MavResult.ACCEPTED, identityBytes())
    expect((await first).result).toBe(MavResult.ACCEPTED)
    expect((await second).result).toBe(MavResult.FAILED)
  })

  it('times out with a typed error when nothing answers', async () => {
    vi.useFakeTimers()
    const link = new FakeLink()
    const pending = link.client().request(SECURE_OP.GET_IDENTITY, new Uint8Array(0), 500)
    const outcome = pending.catch(e => e)
    await vi.advanceTimersByTimeAsync(500)

    const err = await outcome
    expect(err).toBeInstanceOf(SecureCommandError)
    expect((err as SecureCommandError).result).toBeNull()
    expect((err as SecureCommandError).message).toMatch(/didn't answer/)
    expect((err as SecureCommandError).timedOut).toBe(true)
    expect(link.handlers.size).toBe(0)
  })

  it('rejects when the link cannot send, and releases the subscription', async () => {
    const link = new FakeLink()
    link.failSend = new Error('port closed')
    await expect(link.client().request(SECURE_OP.GET_IDENTITY)).rejects.toThrow('port closed')
    expect(link.handlers.size).toBe(0)
  })

  it('refuses a payload larger than the message can carry', async () => {
    const link = new FakeLink()
    await expect(link.client().request(SECURE_OP.GET_IDENTITY, new Uint8Array(221))).rejects.toThrow(/max 220/)
    expect(link.sent).toHaveLength(0)
  })
})

describe('decodeIdentity', () => {
  it('splits 44 bytes into a 12-byte uid and a 32-byte key, copying both', () => {
    const bytes = identityBytes()
    const identity = decodeIdentity(SECURE_OP.GET_IDENTITY, bytes)
    bytes.fill(0)
    expect(identity.uid[0]).toBe(1)
    expect(identity.publicKey[0]).toBe(100)
  })

  it('rejects any other length', () => {
    expect(() => decodeIdentity(SECURE_OP.GET_IDENTITY, new Uint8Array(43))).toThrow(SecureCommandError)
    expect(() => decodeIdentity(SECURE_OP.GET_IDENTITY, new Uint8Array(45))).toThrow(SecureCommandError)
  })
})
