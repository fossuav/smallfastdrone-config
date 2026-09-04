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

// flashRomfsBootloader against a fake link. SITL has no ROMFS bootloader
// to flash and never answers this command, so the wire shape and the
// verdict handling are pinned here; the bench covers the real drone.

import type { MavLinkData } from 'mavlink-mappings'
import type { CommandLong } from 'mavlink-mappings/dist/lib/common'
import type { DecodedMessage, MessageHandler } from '../../src/protocol/mavlink'
import { CommandAck, MavResult, StatusText } from 'mavlink-mappings/dist/lib/common'
import { describe, expect, it, vi } from 'vitest'
import { FLASH_BOOTLOADER_MAGIC, MSGID_STATUSTEXT } from '../../src/protocol/mavlink'
import {
  describeBootloaderUpdateFailure,
  flashRomfsBootloader,
} from '../../src/workflow/bootloader-update'

const SYSID = 7
const COMPID = 1
const CMD_FLASH_BOOTLOADER = 42650

class FakeLink {
  sent: CommandLong[] = []
  handlers = new Set<MessageHandler>()

  send = async (msg: MavLinkData): Promise<void> => {
    this.sent.push(msg as CommandLong)
  }

  subscribe = (cb: MessageHandler): (() => void) => {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  private emit(msg: DecodedMessage): void {
    for (const cb of [...this.handlers]) cb(msg)
  }

  ack(result: MavResult, command = CMD_FLASH_BOOTLOADER): void {
    const data = new CommandAck()
    data.command = command as CommandAck['command']
    data.result = result
    this.emit({ msgid: CommandAck.MSG_ID, msgName: 'COMMAND_ACK', sysid: SYSID, compid: COMPID, seq: 0, data })
  }

  say(text: string): void {
    const data = new StatusText()
    data.text = text
    this.emit({ msgid: MSGID_STATUSTEXT, msgName: 'STATUSTEXT', sysid: SYSID, compid: COMPID, seq: 0, data })
  }
}

describe('flashRomfsBootloader', () => {
  it('sends the magic in param5, where the FC reads it as COMMAND_INT.x', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.ACCEPTED)
    await pending

    expect(link.sent).toHaveLength(1)
    const cmd = link.sent[0]!
    expect(Number(cmd.command)).toBe(CMD_FLASH_BOOTLOADER)
    expect(cmd._param5).toBe(FLASH_BOOTLOADER_MAGIC)
    expect(cmd.targetSystem).toBe(SYSID)
    expect(cmd.targetComponent).toBe(COMPID)
  })

  it('treats ACCEPTED as success', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.ACCEPTED)

    const outcome = await pending
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe(MavResult.ACCEPTED)
  })

  it('keeps what the drone said, since a refusal explains itself only in text', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.say('Bootloader not signed')
    link.ack(MavResult.FAILED)

    const outcome = await pending
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('refused')
    expect(outcome.messages).toContain('Bootloader not signed')
    expect(describeBootloaderUpdateFailure(outcome)).toContain('Bootloader not signed')
  })

  it('distinguishes a firmware that has no such command', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.UNSUPPORTED)

    const outcome = await pending
    expect(outcome.reason).toBe('unsupported')
    expect(describeBootloaderUpdateFailure(outcome)).toMatch(/can't update its own startup software/)
  })

  it('ignores IN_PROGRESS, which is a long command reporting life, not a verdict', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.IN_PROGRESS)
    link.ack(MavResult.ACCEPTED)

    const outcome = await pending
    expect(outcome.ok).toBe(true)
  })

  it('ignores acks for other commands sharing the link', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.FAILED, 246) // a reboot ack racing alongside
    link.ack(MavResult.ACCEPTED)

    const outcome = await pending
    expect(outcome.ok).toBe(true)
  })

  it('gives up after the timeout rather than hanging, and says so gently', async () => {
    vi.useFakeTimers()
    try {
      const link = new FakeLink()
      const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID, 1000)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1001)

      const outcome = await pending
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toBe('timeout')
      expect(outcome.result).toBeNull()
      // Never tells the operator to unplug — the sector write may still run.
      expect(describeBootloaderUpdateFailure(outcome)).toContain('Leave it powered')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('releases its subscription once it has an answer', async () => {
    const link = new FakeLink()
    const pending = flashRomfsBootloader(link.send, link.subscribe, SYSID, COMPID)
    await Promise.resolve()
    link.ack(MavResult.ACCEPTED)
    await pending

    expect(link.handlers.size).toBe(0)
  })
})
