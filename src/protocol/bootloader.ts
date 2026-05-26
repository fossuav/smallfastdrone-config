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

// ArduPilot bootloader protocol — command framing, response parsing, and
// the CRC the bootloader expects against the flashed image. Mirrors the
// firmware-repo reference `Tools/scripts/uploader.py` (itself a PX4
// derivative). Wire format: each command is a single command byte,
// optional payload, then EOC (0x20); the bootloader replies INSYNC (0x12)
// + a status byte (OK 0x10 / FAILED 0x11 / INVALID 0x13 …) and, for
// info-getters, a small payload before the INSYNC/status pair.
//
// Pure framing + CRC. The orchestrator (workflow/firmware.ts, follow-on)
// drives the upload by composing these helpers against the serial
// transport; the security uploader seam (src/security/uploader.ts) wraps
// the whole flow. See docs/FIRMWARE.md.

// --- Commands ------------------------------------------------------------

export const CMD_GET_SYNC = 0x21 // Tool→BL: "are you there?". BL→OK.
export const CMD_GET_DEVICE = 0x22 // Tool→BL: get an info word (board id, flash size…)
export const CMD_CHIP_ERASE = 0x23 // Tool→BL: erase whole user-flash region. Slow.
export const CMD_PROG_MULTI = 0x27 // Tool→BL: write a block (≤252 bytes) at current addr
export const CMD_GET_CRC = 0x29 // Tool→BL: compute CRC over the (padded) flash
export const CMD_REBOOT = 0x30 // Tool→BL: leave bootloader, run firmware

// Frame terminator — every command ends with this byte; replies are
// framed by INSYNC + status (no EOC on the way back).
export const EOC = 0x20

// --- Responses -----------------------------------------------------------

export const INSYNC = 0x12 // Always first byte of a non-info reply
export const OK = 0x10 // Command succeeded
export const FAILED = 0x11 // Command failed
export const INVALID = 0x13 // Out-of-sync — tool should resync

// --- GET_DEVICE info codes ----------------------------------------------

export const INFO_BL_REV = 1 // Bootloader version
export const INFO_BOARD_ID = 2 // The number .apj.board_id matches against
export const INFO_BOARD_REV = 3 // Board hardware revision
export const INFO_FLASH_SIZE = 4 // Bytes of user-flash available
export const INFO_VEC_AREA = 5 // Reserved (vector-table area)

// Maximum payload bytes a single PROG_MULTI can carry. From the
// uploader.py reference; the bootloader's read buffer caps it.
export const PROG_MULTI_MAX = 252

// --- Command builders ---------------------------------------------------

// All builders return the exact bytes-on-wire the tool sends. Unit tests
// assert these byte sequences — same shape as the bootloader expects.

export function buildGetSync(): Uint8Array {
  return new Uint8Array([CMD_GET_SYNC, EOC])
}

export function buildGetDevice(info: number): Uint8Array {
  return new Uint8Array([CMD_GET_DEVICE, info, EOC])
}

export function buildChipErase(): Uint8Array {
  return new Uint8Array([CMD_CHIP_ERASE, EOC])
}

// Write a block of bytes at the bootloader's current write pointer. Caller
// pads `data` to a 4-byte boundary with 0xFF if needed (the bootloader
// programs flash in 32-bit words) and caps each block at PROG_MULTI_MAX.
export function buildProgMulti(data: Uint8Array): Uint8Array {
  if (data.length === 0)
    throw new TypeError('buildProgMulti: data is empty')
  if (data.length > PROG_MULTI_MAX)
    throw new TypeError(`buildProgMulti: data length ${data.length} exceeds PROG_MULTI_MAX (${PROG_MULTI_MAX})`)
  const out = new Uint8Array(data.length + 3)
  out[0] = CMD_PROG_MULTI
  out[1] = data.length
  out.set(data, 2)
  out[out.length - 1] = EOC
  return out
}

export function buildGetCrc(): Uint8Array {
  return new Uint8Array([CMD_GET_CRC, EOC])
}

export function buildReboot(): Uint8Array {
  return new Uint8Array([CMD_REBOOT, EOC])
}

// --- Response parsing ---------------------------------------------------

// True iff the two bytes are the bootloader's "synced + OK" reply.
export function isAck(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === INSYNC && bytes[1] === OK
}

// Operator-readable name for the second byte of a reply ('OK', 'FAILED',
// 'INVALID' …). Useful in error copy when an ack didn't arrive.
export function statusName(status: number): string {
  switch (status) {
    case OK: return 'OK'
    case FAILED: return 'FAILED'
    case INVALID: return 'INVALID (out of sync)'
    default: return `unknown (0x${status.toString(16).padStart(2, '0')})`
  }
}

// Parse a GET_DEVICE reply: 4 LE bytes (the info word) followed by
// INSYNC + OK. Returns the info word, or null if the trailing ack is
// missing / wrong.
export function parseInfoReply(bytes: Uint8Array): number | null {
  if (bytes.length < 6)
    return null
  if (bytes[4] !== INSYNC || bytes[5] !== OK)
    return null
  return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
}

// --- CRC -----------------------------------------------------------------

// The bootloader's GET_CRC walks the entire user-flash region (image
// padded to the erase boundary with 0xFF) through the same standard
// CRC-32 polynomial table that this code uses — but with **initial state
// 0** and **no final XOR / no bit reversal** of the result. The tool runs
// the same algorithm over the padded image so the two CRCs match. This is
// the non-XOR'd variant the uploader.py reference uses; do not confuse it
// with the "standard CRC-32-IEEE" (init 0xFFFFFFFF + final XOR) emitted
// by zlib / PNG.

// Precomputed CRC-32 table for the standard poly (0xEDB88320, reflected).
// Built once at module load.
const CRC32_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++)
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

// CRC the bootloader computes — see the long comment above.
export function bootloaderCrc(bytes: Uint8Array): number {
  let state = 0
  for (let i = 0; i < bytes.length; i++)
    state = CRC32_TABLE[(state ^ bytes[i]!) & 0xFF]! ^ (state >>> 8)
  return state >>> 0
}

// Pad the image to a multiple of `eraseSize` with 0xFF, the value flash
// reads as after erase. The bootloader's GET_CRC walks the full user-
// flash region (image + erase-fill); our tool-side CRC must do the same
// to compare. `eraseSize` comes from the bootloader's INFO_FLASH_SIZE
// (or a board-specific erase-block size if smaller); pass it in.
export function padToErase(image: Uint8Array, eraseSize: number): Uint8Array {
  if (eraseSize <= 0)
    throw new Error('padToErase: eraseSize must be positive')
  if (image.length === eraseSize)
    return image
  if (image.length > eraseSize)
    throw new Error(`Image (${image.length} bytes) is larger than the bootloader's flash region (${eraseSize} bytes).`)
  const out = new Uint8Array(eraseSize).fill(0xFF)
  out.set(image, 0)
  return out
}
