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

// BootloaderClient against MockRawSerial — the request/response logic
// + framing decisions live here, the protocol constants and CRC in
// bootloader.spec.ts. Together they cover everything the bench-hardware
// path will hit, minus the actual transport (WebSerial) lifecycle.

import { describe, expect, it } from 'vitest'
import {
  CMD_CHIP_ERASE,
  CMD_GET_CRC,
  CMD_GET_DEVICE,
  CMD_GET_SYNC,
  CMD_PROG_MULTI,
  CMD_REBOOT,
  EOC,
  FAILED,
  INFO_BOARD_ID,
  INFO_FLASH_SIZE,
  INSYNC,
  OK,
} from '../../src/protocol/bootloader'
import { BootloaderClient } from '../../src/protocol/bootloader-client'
import { MockRawSerial } from '../../src/transport/raw-serial'

// Convenience: bytes of a plain INSYNC + OK ack.
const ACK = [INSYNC, OK] as const

// 32-bit little-endian payload for a GET_DEVICE info reply.
function infoReply(value: number): number[] {
  return [
    value & 0xFF,
    (value >>> 8) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 24) & 0xFF,
    INSYNC,
    OK,
  ]
}

describe('bootloaderClient.sync', () => {
  it('sends GET_SYNC and accepts an immediate INSYNC+OK', async () => {
    const raw = new MockRawSerial(ACK)
    const client = new BootloaderClient(raw)
    await client.sync()
    expect(raw.written).toEqual([CMD_GET_SYNC, EOC])
  })

  it('retries until the bootloader replies (multiple attempts)', async () => {
    const raw = new MockRawSerial()
    const client = new BootloaderClient(raw)
    // Feed the ack after the first attempt's timeout fires — the
    // client should retry and pick it up.
    setTimeout(() => raw.feed(ACK), 600)
    await client.sync()
    // At least one GET_SYNC was sent; the wire log may have several.
    expect(raw.written.length).toBeGreaterThanOrEqual(2)
    expect(raw.written.length % 2).toBe(0)
    for (let i = 0; i < raw.written.length; i += 2) {
      expect(raw.written[i]).toBe(CMD_GET_SYNC)
      expect(raw.written[i + 1]).toBe(EOC)
    }
  })

  it('throws a friendly error if the bootloader never replies', async () => {
    const raw = new MockRawSerial()
    const client = new BootloaderClient(raw)
    await expect(client.sync()).rejects.toThrow(/Couldn't reach the drone's bootloader/)
  }, 20_000)
})

describe('bootloaderClient.getBoardId / getFlashSize', () => {
  it('parses the info word from a GET_DEVICE reply', async () => {
    const raw = new MockRawSerial(infoReply(50))
    const client = new BootloaderClient(raw)
    const id = await client.getBoardId()
    expect(id).toBe(50)
    expect(raw.written).toEqual([CMD_GET_DEVICE, INFO_BOARD_ID, EOC])
  })

  it('returns the flash size via INFO_FLASH_SIZE', async () => {
    const raw = new MockRawSerial(infoReply(2 * 1024 * 1024))
    const client = new BootloaderClient(raw)
    const size = await client.getFlashSize()
    expect(size).toBe(2 * 1024 * 1024)
    expect(raw.written).toEqual([CMD_GET_DEVICE, INFO_FLASH_SIZE, EOC])
  })

  it('throws on a malformed info reply', async () => {
    // 6 bytes but no INSYNC+OK trailer.
    const raw = new MockRawSerial([1, 2, 3, 4, 0, 0])
    const client = new BootloaderClient(raw)
    await expect(client.getBoardId()).rejects.toThrow(/info reply was invalid/)
  })
})

describe('bootloaderClient.chipErase', () => {
  it('sends CHIP_ERASE and waits for ack', async () => {
    const raw = new MockRawSerial(ACK)
    const client = new BootloaderClient(raw)
    await client.chipErase()
    expect(raw.written).toEqual([CMD_CHIP_ERASE, EOC])
  })

  it('throws when the bootloader replies FAILED', async () => {
    const raw = new MockRawSerial([INSYNC, FAILED])
    const client = new BootloaderClient(raw)
    await expect(client.chipErase()).rejects.toThrow(/Chip erase failed/)
  })
})

describe('bootloaderClient.program', () => {
  it('streams the image in PROG_MULTI chunks and ack-gates each one', async () => {
    // 600-byte image → 252 + 252 + 96 (last partial padded to 96 = 0 mod 4).
    const image = new Uint8Array(600)
    for (let i = 0; i < image.length; i++) image[i] = i & 0xFF
    // 3 acks for 3 chunks.
    const raw = new MockRawSerial([...ACK, ...ACK, ...ACK])
    const client = new BootloaderClient(raw)
    const progress: number[] = []
    await client.program(image, p => progress.push(p))
    // Each chunk wires as [CMD, len, …data, EOC] = (len + 3) bytes. With
    // chunks of 252+252+96, frames sit at offsets 0 / 255 / 510. Verify
    // the framing markers at those offsets.
    const w = raw.written
    expect(w.length).toBe(255 + 255 + 99) // 3 frames: 2×(252+3) + (96+3)
    expect(w[0]).toBe(CMD_PROG_MULTI)
    expect(w[1]).toBe(252)
    expect(w[254]).toBe(EOC) // end of chunk 1
    expect(w[255]).toBe(CMD_PROG_MULTI)
    expect(w[256]).toBe(252)
    expect(w[509]).toBe(EOC) // end of chunk 2
    expect(w[510]).toBe(CMD_PROG_MULTI)
    expect(w[511]).toBe(96) // 96 is already 4-byte-aligned, no padding
    expect(w[608]).toBe(EOC) // end of chunk 3
    expect(progress).toEqual([252 / 600, 504 / 600, 1])
  })

  it('pads the last chunk to a 4-byte boundary with 0xFF', async () => {
    // 5-byte image — pads to 8.
    const image = new Uint8Array([1, 2, 3, 4, 5])
    const raw = new MockRawSerial(ACK)
    const client = new BootloaderClient(raw)
    await client.program(image)
    // CMD + len + 8 padded bytes + EOC = 11 bytes.
    expect(raw.written.length).toBe(11)
    expect(raw.written[0]).toBe(CMD_PROG_MULTI)
    expect(raw.written[1]).toBe(8)
    expect(raw.written.slice(2, 7)).toEqual([1, 2, 3, 4, 5])
    expect(raw.written.slice(7, 10)).toEqual([0xFF, 0xFF, 0xFF])
    expect(raw.written[10]).toBe(EOC)
  })

  it('throws on a failed program ack', async () => {
    const image = new Uint8Array([1, 2, 3, 4])
    const raw = new MockRawSerial([INSYNC, FAILED])
    const client = new BootloaderClient(raw)
    await expect(client.program(image)).rejects.toThrow(/Programming failed/)
  })

  it('rejects an empty image (caller bug)', async () => {
    const raw = new MockRawSerial()
    const client = new BootloaderClient(raw)
    await expect(client.program(new Uint8Array())).rejects.toThrow(/empty/)
  })
})

describe('bootloaderClient.verify', () => {
  it('sends GET_CRC and accepts a matching CRC', async () => {
    const raw = new MockRawSerial(infoReply(0xDEADBEEF))
    const client = new BootloaderClient(raw)
    await client.verify(0xDEADBEEF)
    expect(raw.written).toEqual([CMD_GET_CRC, EOC])
  })

  it('throws on a CRC mismatch (firmware-corrupt-in-flash)', async () => {
    const raw = new MockRawSerial(infoReply(0xDEADBEEF))
    const client = new BootloaderClient(raw)
    await expect(client.verify(0x12345678)).rejects.toThrow(/Firmware verification failed/)
  })
})

describe('bootloaderClient.reboot', () => {
  it('sends REBOOT and does not wait for a reply', async () => {
    const raw = new MockRawSerial()
    const client = new BootloaderClient(raw)
    await client.reboot()
    expect(raw.written).toEqual([CMD_REBOOT, EOC])
  })
})

describe('bootloaderClient.flash (end-to-end)', () => {
  it('walks sync → board-id → flash-size → erase → program → verify → reboot', async () => {
    const image = new Uint8Array(256)
    for (let i = 0; i < image.length; i++) image[i] = i & 0xFF
    const flashSize = 1024
    // Compute the CRC the client will expect.
    // Easiest: run flash() once with the expected CRC fed back, observe.
    // Here we'll instead pre-compute via the same helper the client uses.
    const { bootloaderCrc, padToErase } = await import('../../src/protocol/bootloader')
    const expectedCrc = bootloaderCrc(padToErase(image, flashSize))

    const raw = new MockRawSerial([
      ...ACK, //                              sync
      ...infoReply(50), //                    board id (matches)
      ...infoReply(flashSize), //             flash size
      ...ACK, //                              chip erase
      ...ACK, //                              program (single chunk: 256 bytes ≤ 252+4 → actually 252+4 chunks)
      ...ACK, //                              program (second chunk)
      ...infoReply(expectedCrc), //           verify
    ])
    const client = new BootloaderClient(raw)
    const phases: string[] = []
    await client.flash(image, 50, p => phases.push(p))
    expect(phases).toEqual(['syncing', 'erasing', 'programming', 'verifying', 'restarting'])
  })

  it('refuses to flash a board-id mismatch (different drone)', async () => {
    const image = new Uint8Array([1, 2, 3, 4])
    const raw = new MockRawSerial([
      ...ACK, //                              sync
      ...infoReply(50), //                    drone reports board 50
    ])
    const client = new BootloaderClient(raw)
    await expect(client.flash(image, 99, () => {})).rejects.toThrow(/Wrong firmware for this drone/)
  })

  it('refuses to flash an image bigger than the chip', async () => {
    const image = new Uint8Array(2048)
    const raw = new MockRawSerial([
      ...ACK,
      ...infoReply(50),
      ...infoReply(1024), //                  flash is smaller than image
    ])
    const client = new BootloaderClient(raw)
    await expect(client.flash(image, 50, () => {})).rejects.toThrow(/too large/)
  })
})
