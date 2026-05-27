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

// ArduPilot bootloader client — runs the upload sequence (sync → board-
// id confirm → erase → program → verify → reboot) over a `RawSerial`
// duplex. Stateless beyond what the protocol requires; the orchestrator
// (workflow/firmware.ts) drives it. Composes the framing helpers in
// `bootloader.ts` — this file is the "talk to the bootloader" layer.
//
// Unit-tested against `MockRawSerial`. Hardware path uses a `RawSerial`
// the WebSerial transport hands out via `acquireRaw`. See
// docs/FIRMWARE.md.

import type { RawSerial } from '../transport/raw-serial'
import {
  bootloaderCrc,
  buildChipErase,
  buildGetCrc,
  buildGetDevice,
  buildGetSync,
  buildProgMulti,
  buildReboot,
  INFO_BL_REV,
  INFO_BOARD_ID,
  INFO_FLASH_SIZE,
  INSYNC,
  isAck,
  padToErase,
  parseInfoReply,
  PROG_MULTI_MAX,
  statusName,
} from './bootloader'

// Per-command timeouts. Most commands ack quickly; CHIP_ERASE walks the
// whole user-flash region and is the slow one. GET_CRC also walks all
// flash. Tuned generously — these are operator-bench scenarios, not a
// hot loop.
const SHORT_TIMEOUT_MS = 2_000
const ERASE_TIMEOUT_MS = 30_000
const CRC_TIMEOUT_MS = 30_000

// Bootloader sync may need several attempts after a reboot — the chip
// is enumerating, the USB stack is settling. We send GET_SYNC up to N
// times with a short window between, then give up.
const SYNC_ATTEMPTS = 20
const SYNC_RETRY_DELAY_MS = 250
const SYNC_PER_ATTEMPT_TIMEOUT_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class BootloaderClient {
  constructor(private readonly raw: RawSerial) {}

  // Try to sync with the bootloader. Sends GET_SYNC; expects INSYNC+OK.
  // Retries — the chip may still be enumerating after the reboot.
  // Throws operator-readable copy on persistent failure.
  async sync(): Promise<void> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      try {
        await this.raw.write(buildGetSync())
        const reply = await this.raw.readExact(2, SYNC_PER_ATTEMPT_TIMEOUT_MS)
        if (isAck(reply))
          return
        lastErr = new Error(`bootloader replied ${statusName(reply[1] ?? 0)} instead of OK`)
      }
      catch (e) {
        lastErr = e
      }
      if (attempt < SYNC_ATTEMPTS - 1)
        await sleep(SYNC_RETRY_DELAY_MS)
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new Error(`Couldn't reach the drone's bootloader (${detail}). Try unplugging + plugging the USB cable.`)
  }

  // Pull a single info word (board id / board rev / flash size / …)
  // out of the bootloader. Throws if the reply is missing or malformed.
  // No drain — request/response is strictly turn-taking after sync, so the
  // buffer is always empty when we get here.
  async getInfo(info: number): Promise<number> {
    await this.raw.write(buildGetDevice(info))
    const reply = await this.raw.readExact(6, SHORT_TIMEOUT_MS)
    const value = parseInfoReply(reply)
    if (value === null)
      throw new Error(`Bootloader info reply was invalid (got ${formatBytes(reply)})`)
    return value
  }

  // Get the bootloader's protocol revision. Returning a value also
  // marks bit 0 of `done_get_device_flags` in the bootloader — required
  // (along with bits 1 and 3 from BOARD_ID + FLASH_SIZE) before the
  // bootloader will accept CHIP_ERASE / PROG_MULTI / GET_CRC. Without
  // this prerequisite call those commands reply INVALID.
  async getBootloaderRev(): Promise<number> {
    return this.getInfo(INFO_BL_REV)
  }

  // Get the bootloader's board id — what the .apj's `board_id` is
  // matched against. Convenience over getInfo.
  async getBoardId(): Promise<number> {
    return this.getInfo(INFO_BOARD_ID)
  }

  // Bytes of user-flash the bootloader reports — used both to bounds-
  // check the image and to pad it for the CRC compare.
  async getFlashSize(): Promise<number> {
    return this.getInfo(INFO_FLASH_SIZE)
  }

  // Erase the user-flash region. Slow — up to ~20s on large boards
  // (H7 / F7). The bootloader sends INSYNC+OK only when the whole
  // erase is complete; there's no per-sector ack to drive a real
  // progress bar. So we animate a time-based estimate (capped at 95 %
  // until the actual ack lands) — same approach uploader.py uses.
  // Tuned for an H7's typical ~10 s erase. Throws on failure / timeout.
  async chipErase(onProgress?: (fraction: number) => void): Promise<void> {
    await this.raw.write(buildChipErase())
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null
    if (onProgress) {
      const startedAt = Date.now()
      const expectedMs = 10_000
      onProgress(0)
      interval = setInterval(() => {
        if (cancelled)
          return
        const elapsed = Date.now() - startedAt
        onProgress(Math.min(0.95, elapsed / expectedMs))
      }, 250)
    }
    try {
      const reply = await this.raw.readExact(2, ERASE_TIMEOUT_MS)
      if (!isAck(reply))
        throw new Error(`Chip erase failed (bootloader replied ${statusName(reply[1] ?? 0)})`)
      onProgress?.(1)
    }
    finally {
      cancelled = true
      if (interval)
        clearInterval(interval)
    }
  }

  // Stream the image to the bootloader in PROG_MULTI_MAX-sized chunks
  // (padded to a 4-byte word boundary on the last chunk if needed —
  // the bootloader programs flash in 32-bit words). Calls `onProgress`
  // with a 0..1 fraction after each block.
  async program(image: Uint8Array, onProgress?: (fraction: number) => void): Promise<void> {
    if (image.length === 0)
      throw new Error('Firmware image is empty.')
    let offset = 0
    while (offset < image.length) {
      const remaining = image.length - offset
      const chunkLen = Math.min(PROG_MULTI_MAX, remaining)
      let chunk: Uint8Array = image.subarray(offset, offset + chunkLen)
      if (chunk.length % 4 !== 0) {
        // Last partial — pad to a word boundary with 0xFF (the erased
        // flash value).
        const padded = new Uint8Array(Math.ceil(chunk.length / 4) * 4).fill(0xFF)
        padded.set(chunk)
        chunk = padded
      }
      await this.raw.write(buildProgMulti(chunk))
      const reply = await this.raw.readExact(2, SHORT_TIMEOUT_MS)
      if (!isAck(reply))
        throw new Error(`Programming failed near offset ${offset} (bootloader replied ${statusName(reply[1] ?? 0)})`)
      offset += chunkLen
      onProgress?.(offset / image.length)
    }
  }

  // Pull the bootloader's CRC of its full user-flash region. Used
  // both as a pre-flash "is the firmware already what we'd install?"
  // probe (skip the erase/program cycle when it matches) and as the
  // post-flash verify. Same prerequisites as CHIP_ERASE — see
  // `getBootloaderRev`.
  async getCrc(): Promise<number> {
    await this.raw.write(buildGetCrc())
    const reply = await this.raw.readExact(6, CRC_TIMEOUT_MS)
    const got = parseInfoReply(reply)
    if (got === null)
      throw new Error(`CRC reply was invalid (got ${formatBytes(reply)})`)
    return got
  }

  // Verify the bootloader's CRC of its full user-flash region matches
  // the expected CRC (image padded to the erase boundary). Throws on
  // mismatch — that's "firmware corrupt in flash", serious enough to
  // surface and refuse the reboot.
  async verify(expectedCrc: number): Promise<void> {
    const got = await this.getCrc()
    if (got !== expectedCrc) {
      throw new Error(
        `Firmware verification failed: bootloader CRC ${hexU32(got)} doesn't match expected ${hexU32(expectedCrc)}. The flash didn't take — try again.`,
      )
    }
  }

  // Tell the bootloader to leave and run the (new) firmware. No reply
  // expected — the USB device disappears as the bootloader hands off.
  async reboot(): Promise<void> {
    await this.raw.write(buildReboot())
  }

  // Convenience: do an end-to-end flash. Returns when the bootloader
  // has been told to reboot; the caller (orchestrator) is responsible
  // for re-establishing the MAVLink session afterwards. The `skipped`
  // flag tells the caller whether the firmware was already what we'd
  // have written (CRC match → straight to REBOOT, no chip cycle).
  async flash(
    image: Uint8Array,
    expectedBoardId: number,
    onPhase: (phase: 'syncing' | 'erasing' | 'programming' | 'verifying' | 'restarting') => void,
    onProgress?: (fraction: number) => void,
  ): Promise<{ skipped: boolean }> {
    onPhase('syncing')
    await this.sync()
    // BL_REV must be queried before CHIP_ERASE / PROG_MULTI / GET_CRC
    // are allowed — the bootloader tracks "tool has identified itself
    // by asking the basics" via `done_get_device_flags` and refuses
    // those commands until bits 0 (BL_REV), 1 (BOARD_ID), and 3
    // (FLASH_SIZE) are set. We don't use the value yet, but the call
    // itself is the prerequisite.
    await this.getBootloaderRev()
    const boardId = await this.getBoardId()
    if (boardId !== expectedBoardId) {
      throw new Error(
        `Wrong firmware for this drone — the file is for board ${expectedBoardId}, the drone is board ${boardId}.`,
      )
    }
    const flashSize = await this.getFlashSize()
    if (image.length > flashSize) {
      throw new Error(
        `Firmware is too large (${image.length} bytes) for this drone's flash (${flashSize} bytes).`,
      )
    }
    const padded = padToErase(image, flashSize)
    const expectedCrc = bootloaderCrc(padded)

    // Pre-flash CRC check: if the firmware in flash already matches
    // what we'd install, skip the erase/program/verify cycle entirely
    // and just reboot. Saves a chip cycle on retries (the operator
    // re-clicked Install on a board that was already on the target
    // firmware) and — more important — avoids erasing a working board
    // when the operator picked the same `.apj` they're already running.
    onPhase('verifying')
    const currentCrc = await this.getCrc()
    if (currentCrc === expectedCrc) {
      onPhase('restarting')
      await this.reboot()
      return { skipped: true }
    }

    onPhase('erasing')
    await this.chipErase(onProgress)

    onPhase('programming')
    // Reset progress between phases so the bar restarts at 0 rather
    // than jumping straight to whatever erase left it at.
    onProgress?.(0)
    await this.program(image, onProgress)

    onPhase('verifying')
    await this.verify(expectedCrc)

    onPhase('restarting')
    await this.reboot()
    return { skipped: false }
  }
}

// --- small helpers -------------------------------------------------------

function hexU32(n: number): string {
  return `0x${n.toString(16).padStart(8, '0')}`
}

function formatBytes(bytes: Uint8Array): string {
  return `[${Array.from(bytes).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`
}

// Sentinel re-exports so callers don't have to import from two files.
export { INSYNC }
