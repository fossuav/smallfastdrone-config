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

// Intel HEX (I8HEX/I16HEX/I32HEX) parser — turns SmallFastDrone's
// `<vehicle>_with_bl.hex` artefact into a flat list of address-tagged
// byte runs, suitable for DFU's "set address, write block" model.
//
// Why this module exists: the `.apj` artefact is the bootloader-path
// format and only carries the firmware image (no bootloader). For the
// DFU recovery / fresh-chip path, SFD also publishes `_with_bl.hex`,
// the same firmware image *plus* the bootloader, addressed to its real
// flash positions. We need to consume that here.
//
// Pure parse. No protocol, no transport, no progress reporting — just
// "bytes in → segments out". Operator-readable errors so the UI can
// surface them as-is.
//
// Format reference: Intel Hex Spec rev D. Each line:
//   :LLAAAATT[DD…]CC
//   - LL  = byte count of DD…           (2 hex digits)
//   - AAAA= record's low-16-bit address (4 hex digits)
//   - TT  = record type                 (2 hex digits)
//   - DD  = data bytes (LL of them)     (2 hex digits each)
//   - CC  = two's-complement checksum of all preceding bytes
// Record types we accept: 0x00 data, 0x01 EOF, 0x04 extended linear
// address (high-16 bits of a 32-bit address). 0x02/0x03/0x05 appear in
// some toolchains; we reject with a clear message rather than silently
// mis-flashing.

// A contiguous run of bytes at a known absolute address. The parser
// coalesces adjacent records into a single segment so the DFU layer
// can stream long writes without re-issuing SET_ADDRESS per record.
export interface HexSegment {
  // Absolute 32-bit flash address of the first byte in `data`.
  address: number
  // Bytes to write at `address`. Contiguous — segments don't overlap
  // or touch the next segment (those get merged).
  data: Uint8Array
}

export interface ParsedHex {
  // Address-ordered, non-overlapping, gap-separated segments.
  segments: HexSegment[]
  // Sum of segment lengths — total bytes to flash. Pre-computed because
  // the UI shows it during confirm.
  totalBytes: number
  // Lowest segment address. Convenience for "starting address" displays.
  startAddress: number
  // Highest segment end address (inclusive). Convenience for span checks.
  endAddress: number
}

// Parse an Intel HEX file. Throws operator-readable errors on malformed
// input — those bubble up to FirmwareView and replace its file-picker
// state with the message.
export function parseIntelHex(text: string): ParsedHex {
  // Strip BOM + normalise newlines. Some hex emitters write CRLF; some
  // write trailing whitespace. None of that's meaningful.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  // Build records first, then coalesce — keeps the validate-then-merge
  // logic readable.
  const records: { address: number, data: Uint8Array }[] = []
  let upperAddress = 0 // From most-recent type-04 record (shifted <<16).
  let sawEof = false

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!.trim()
    if (line.length === 0)
      continue
    if (line[0] !== ':')
      throw new Error(`Firmware file is corrupt (line ${lineNo + 1} doesn't start with ":").`)
    // Each record needs at least 11 chars: ":LLAAAATTCC" (no data).
    if (line.length < 11 || (line.length % 2) !== 1)
      throw new Error(`Firmware file is corrupt (line ${lineNo + 1} is the wrong length).`)

    // Parse hex bytes.
    const bytes = new Uint8Array((line.length - 1) / 2)
    for (let i = 0; i < bytes.length; i++) {
      const byte = Number.parseInt(line.slice(1 + i * 2, 3 + i * 2), 16)
      if (Number.isNaN(byte))
        throw new Error(`Firmware file is corrupt (line ${lineNo + 1} has non-hex characters).`)
      bytes[i] = byte
    }

    // Checksum: sum of every byte (count + addr + type + data + cs)
    // == 0 mod 256.
    let sum = 0
    for (const b of bytes) sum = (sum + b) & 0xFF
    if (sum !== 0)
      throw new Error(`Firmware file is corrupt (checksum failed on line ${lineNo + 1}).`)

    const dataLen = bytes[0]!
    const lowAddr = (bytes[1]! << 8) | bytes[2]!
    const recType = bytes[3]!
    if (bytes.length !== dataLen + 5)
      throw new Error(`Firmware file is corrupt (line ${lineNo + 1} byte count doesn't match).`)

    switch (recType) {
      case 0x00: {
        // Data.
        const data = bytes.slice(4, 4 + dataLen)
        records.push({ address: (upperAddress | lowAddr) >>> 0, data })
        break
      }
      case 0x01: {
        // EOF — there must be no data and we shouldn't see any more
        // records after this. We allow trailing blank lines.
        if (dataLen !== 0)
          throw new Error(`Firmware file is corrupt (EOF record on line ${lineNo + 1} has data).`)
        sawEof = true
        break
      }
      case 0x04: {
        // Extended linear address — sets the high-16 of subsequent
        // record addresses.
        if (dataLen !== 2)
          throw new Error(`Firmware file is corrupt (extended-address record on line ${lineNo + 1} has wrong length).`)
        upperAddress = ((bytes[4]! << 8) | bytes[5]!) << 16
        break
      }
      case 0x02:
      case 0x03:
      case 0x05: {
        // Segment-addressed / start-address records. SFD's hex output
        // never emits these, so refuse rather than guess.
        throw new Error(`Firmware file uses record type ${hexByte(recType)} which we don't support yet.`)
      }
      default: {
        throw new Error(`Firmware file is corrupt (unknown record type ${hexByte(recType)} on line ${lineNo + 1}).`)
      }
    }

    if (sawEof) {
      // Records after EOF would indicate a truncated/concatenated file —
      // surface that explicitly.
      for (let j = lineNo + 1; j < lines.length; j++) {
        if (lines[j]!.trim().length > 0)
          throw new Error(`Firmware file is corrupt (data found after end-of-file marker on line ${lineNo + 1}).`)
      }
      break
    }
  }

  if (!sawEof)
    throw new Error('Firmware file is corrupt (missing end-of-file marker).')
  if (records.length === 0)
    throw new Error('Firmware file contains no data.')

  // Sort by address so coalescing only has to look at neighbours, and
  // any genuinely-overlapping records become obvious.
  records.sort((a, b) => a.address - b.address)

  // Coalesce contiguous records into segments. Adjacent = "the next
  // record's address equals the previous record's address+length".
  const segments: HexSegment[] = []
  let current: { address: number, parts: Uint8Array[], length: number } | null = null
  for (const r of records) {
    if (current && r.address === current.address + current.length) {
      current.parts.push(r.data)
      current.length += r.data.length
    }
    else {
      if (current) {
        if (current.address + current.length > r.address)
          throw new Error(`Firmware file is corrupt (data records overlap near ${hexU32(r.address)}).`)
        segments.push({ address: current.address, data: concatBytes(current.parts, current.length) })
      }
      current = { address: r.address, parts: [r.data], length: r.data.length }
    }
  }
  if (current)
    segments.push({ address: current.address, data: concatBytes(current.parts, current.length) })

  let totalBytes = 0
  for (const s of segments) totalBytes += s.data.length
  const startAddress = segments[0]!.address
  const last = segments[segments.length - 1]!
  const endAddress = last.address + last.data.length - 1

  return { segments, totalBytes, startAddress, endAddress }
}

// --- helpers ---------------------------------------------------------

function concatBytes(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function hexByte(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`
}

function hexU32(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, '0')}`
}
