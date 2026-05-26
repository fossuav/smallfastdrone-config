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

// ArduPilot `.apj` firmware-artifact parser. The shape ships as JSON
// wrapping a base64-encoded gzipped raw image:
//
//   {
//     "board_id":      <number>,        // e.g. 50 for CubeOrangePlus
//     "magic":         "APJFWv1",       // file-format identifier
//     "description":   "<board name>",
//     "image":         "<base64 of gzipped raw image>",
//     "image_size":    <uncompressed bytes>,
//     "summary":       "ArduCopter V4.7.0-beta4-SFD",
//     "git_identity":  "<short hash>"
//   }
//
// This module is pure parse: turn a file's contents into bytes + fields.
// It does NOT talk to the FC, NOT verify board_id matches the connected
// board (that's the upload orchestrator's job), and NOT route through the
// security uploader seam (uploads do; parsing doesn't). Browser-native
// `DecompressionStream('gzip')` does the gunzip — modern Chromium target
// per PLAN decision 17 means no zlib dep. See docs/FIRMWARE.md.

// File-format magic. The parser rejects anything else as "not a firmware
// file we recognise" — better than failing later with a confusing decode
// error on a wrong-format file.
const APJ_MAGIC = 'APJFWv1'

export interface ApjFirmware {
  // Board this firmware targets. Compared against the bootloader's
  // BOARD_ID before flashing (refuse mismatch).
  boardId: number
  // Operator-facing board description ("Firmware for the CubeOrangePlus board").
  description: string
  // Version line ("ArduCopter V4.7.0-beta4-SFD") — shown for confirm.
  summary?: string
  // Short git hash if present in the .apj — surfaced in expert mode.
  gitIdentity?: string
  // Decompressed raw image bytes — what gets flashed onto the chip.
  image: Uint8Array
  // Decompressed image length (`image.length`, named for clarity).
  imageSize: number
}

// Standard atob → Uint8Array. Throws on invalid base64 (atob's
// DOMException becomes our "not valid base64" error in parseApj).
function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Gunzip a buffer via the browser-native (and Bun-native) compression
// streams. No external zlib dep; works in the browser and in Vitest's
// Node-like runtime. Copies the input into a fresh ArrayBuffer-backed
// Uint8Array first — strict-TS DOM signatures want `Uint8Array<ArrayBuffer>`,
// not the wider `Uint8Array<ArrayBufferLike>` that the base64-decoded
// input is typed as. The copy is cheap (firmware images are small) and
// the cast-free workaround is the most boring.
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = new ArrayBuffer(bytes.byteLength)
  const fresh = new Uint8Array(buf)
  fresh.set(bytes)
  const stream = new Blob([fresh]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Parse a `.apj` firmware artifact. Throws operator-readable errors
// (no MAVLink / protocol jargon) so callers can surface them as-is.
export async function parseApj(json: string): Promise<ApjFirmware> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json)
  }
  catch {
    throw new Error('That doesn\'t look like a firmware file — couldn\'t read it.')
  }

  if (raw.magic !== APJ_MAGIC) {
    const got = typeof raw.magic === 'string' ? `"${raw.magic}"` : 'nothing'
    throw new Error(`Not a SmallFastDrone firmware file (expected "${APJ_MAGIC}", got ${got}).`)
  }
  if (typeof raw.board_id !== 'number') {
    throw new TypeError('Firmware file is missing its board id — can\'t tell which board it\'s for.')
  }
  if (typeof raw.image !== 'string') {
    throw new TypeError('Firmware file is missing its image data.')
  }

  let compressed: Uint8Array
  try {
    compressed = base64Decode(raw.image)
  }
  catch {
    throw new Error('Firmware image data is corrupt (not valid base64).')
  }

  let image: Uint8Array
  try {
    image = await gunzip(compressed)
  }
  catch {
    throw new Error('Firmware image data is corrupt (not a valid gzip stream).')
  }

  return {
    boardId: raw.board_id,
    description: typeof raw.description === 'string' ? raw.description : '',
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    gitIdentity: typeof raw.git_identity === 'string' ? raw.git_identity : undefined,
    image,
    imageSize: image.length,
  }
}
