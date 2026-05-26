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

// USB DFU 1.1 + DfuSe (STMicro) protocol primitives. Pure constants,
// builders, and parsers — no transport, no orchestration. The DFU
// client (`dfu-client.ts`) sits on top and calls these to talk to the
// chip's bootloader through whatever USBControl the transport supplies.
//
// References:
//   - USB DFU 1.1: usb.org/sites/default/files/DFU_1.1.pdf
//   - DfuSe (STMicro extensions, no public spec — AN3156): SET_ADDRESS,
//     ERASE_PAGE, MASS_ERASE encoded as the first byte of a wBlockNum=0
//     DNLOAD payload.

// --- USB DFU class request codes ------------------------------------

// All of these go via control transfer with bmRequestType =
// USB_DIR_OUT | USB_TYPE_CLASS | USB_RECIP_INTERFACE for OUT, or
// USB_DIR_IN | USB_TYPE_CLASS | USB_RECIP_INTERFACE for IN. Encoded by
// the transport — protocol layer just names the request.
export const DFU_REQ = {
  DETACH: 0x00, //   leave DFU mode (app → bootloader if applicable)
  DNLOAD: 0x01, //   host → device data (or DfuSe command in block 0)
  UPLOAD: 0x02, //   device → host (read flash) — unused here
  GETSTATUS: 0x03, // poll state machine + last operation result
  CLRSTATUS: 0x04, // clear dfuERROR and return to dfuIDLE
  GETSTATE: 0x05, // peek state without status payload
  ABORT: 0x06, //    cancel current op, return to dfuIDLE
} as const

// --- DFU state machine values (returned in GETSTATUS byte 4) --------
// We name only the ones the client actually checks against; everything
// else is reported as "unexpected state N" in errors.
export const DFU_STATE = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
} as const

// --- DFU status codes (GETSTATUS byte 0) ----------------------------
// Stored alongside the state. Anything non-zero means the previous op
// failed; the client surfaces an operator-readable label.
export const DFU_STATUS = {
  OK: 0x00,
  errTARGET: 0x01,
  errFILE: 0x02,
  errWRITE: 0x03,
  errERASE: 0x04,
  errCHECK_ERASED: 0x05,
  errPROG: 0x06,
  errVERIFY: 0x07,
  errADDRESS: 0x08,
  errNOTDONE: 0x09,
  errFIRMWARE: 0x0A,
  errVENDOR: 0x0B,
  errUSBR: 0x0C,
  errPOR: 0x0D,
  errUNKNOWN: 0x0E,
  errSTALLEDPKT: 0x0F,
} as const

// Human-readable name for a status byte. Used to build error copy
// without dragging a lookup helper into every call site.
export function statusLabel(status: number): string {
  for (const [name, code] of Object.entries(DFU_STATUS)) {
    if (code === status)
      return name
  }
  return `unknown status 0x${status.toString(16)}`
}

// Human-readable name for a state byte. Same shape as above.
export function stateLabel(state: number): string {
  for (const [name, code] of Object.entries(DFU_STATE)) {
    if (code === state)
      return name
  }
  return `unknown state 0x${state.toString(16)}`
}

// --- DfuSe command codes (first byte of a wBlockNum=0 DNLOAD payload)

// DfuSe pushes its address-set / erase commands through the same
// DNLOAD endpoint as data writes, distinguished by wBlockNum=0 and a
// command opcode in byte 0. Data writes use wBlockNum >= 2 (block 0
// = command, block 1 = reserved). The actual flash address for a data
// write is computed by the device as
//     address = lastSetAddress + (wBlockNum - 2) * wTransferSize
// so we issue SET_ADDRESS before every "different region" download.
export const DFUSE_CMD = {
  SET_ADDRESS: 0x21,
  ERASE_PAGE: 0x41, // (1-byte payload → mass erase; +addr → page)
  READ_UNPROTECT: 0x92, // not used in v1
} as const

// Status reply layout returned by GETSTATUS. Always 6 bytes.
//   [0]    bStatus      — see DFU_STATUS
//   [1..3] bwPollTimeout — 24-bit LE ms (host must wait this long before next op)
//   [4]    bState       — see DFU_STATE
//   [5]    iString      — index of optional vendor string (unused)
export interface DfuStatus {
  status: number //          DFU_STATUS.*
  pollTimeoutMs: number //   24-bit LE from bytes 1..3
  state: number //           DFU_STATE.*
}

export function parseStatus(reply: Uint8Array): DfuStatus {
  if (reply.length < 6)
    throw new Error(`DFU GETSTATUS reply was too short (${reply.length} bytes, expected 6)`)
  const pollTimeoutMs = reply[1]! | (reply[2]! << 8) | (reply[3]! << 16)
  return { status: reply[0]!, pollTimeoutMs, state: reply[4]! }
}

// Build the 5-byte DfuSe SET_ADDRESS payload. The DFU client then
// DNLOADs it with wBlockNum=0 and follows up with GETSTATUS poll.
export function buildSetAddressPayload(address: number): Uint8Array {
  const out = new Uint8Array(5)
  out[0] = DFUSE_CMD.SET_ADDRESS
  out[1] = address & 0xFF
  out[2] = (address >>> 8) & 0xFF
  out[3] = (address >>> 16) & 0xFF
  out[4] = (address >>> 24) & 0xFF
  return out
}

// Build the DfuSe ERASE_PAGE payload (address + 0x41). A single-byte
// 0x41 payload (no address) requests a mass erase — that's a separate
// helper to keep call sites obvious.
export function buildErasePagePayload(address: number): Uint8Array {
  const out = new Uint8Array(5)
  out[0] = DFUSE_CMD.ERASE_PAGE
  out[1] = address & 0xFF
  out[2] = (address >>> 8) & 0xFF
  out[3] = (address >>> 16) & 0xFF
  out[4] = (address >>> 24) & 0xFF
  return out
}

// Build the DfuSe mass-erase payload (the lone 0x41 byte).
// Avoid in v1's recovery-with-.apj path — it wipes the bootloader too.
// Currently only used by the `_with_bl.hex` flow where the bootloader
// is being re-flashed anyway.
export function buildMassErasePayload(): Uint8Array {
  return new Uint8Array([DFUSE_CMD.ERASE_PAGE])
}

// --- DfuSe memory-layout descriptor parser --------------------------

// One physical erase block of flash (or a contiguous run of identically-
// sized blocks). The DfuSe descriptor encodes these as one comma-
// separated entry per run; we expand to per-sector here so the erase
// planner doesn't have to reason about runs.
export interface DfuSector {
  // Absolute address of the first byte in this sector.
  startAddress: number
  // Bytes in this sector.
  size: number
  // Capability flag from the descriptor: 'g' = read/erase/write,
  // 'e' = read/erase, 'a' = read-only, 'r' = read-only. We only erase
  // sectors flagged 'g' (or 'e' — same for our purposes).
  capability: string
}

export interface DfuMemoryLayout {
  // Display name from the descriptor ("Internal Flash", "Option Bytes", …).
  // We only ever pick "Internal Flash" for v1 but tests can assert this.
  name: string
  // First address of the region.
  startAddress: number
  // Expanded sectors. Sum of `.size` = the region's total bytes.
  sectors: DfuSector[]
}

// Parse a DfuSe interface string descriptor:
//   "@Internal Flash  /0x08000000/16*0128Kg"
//   "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg"
//
// Returns null if the string doesn't look like a DfuSe layout (callers
// skip non-flash alt-settings rather than throwing). Throws on a
// genuinely malformed layout — that's "device descriptor we can't
// trust", which we want surfaced.
export function parseDfuseLayout(descriptor: string): DfuMemoryLayout | null {
  // The leading "@" marks a DfuSe-format descriptor. Anything else is
  // a normal interface string we don't care about.
  if (!descriptor.startsWith('@'))
    return null
  // STM truncates long descriptors at the USB string limit; the parser
  // copes by trimming whatever's after the last well-formed run.
  const parts = descriptor.slice(1).split('/')
  if (parts.length < 3)
    return null

  const name = parts[0]!.trim()
  const startAddress = Number.parseInt(parts[1]!.trim(), 16)
  if (!Number.isFinite(startAddress))
    throw new Error(`DFU layout descriptor has unparseable start address: "${parts[1]}"`)

  const sectors: DfuSector[] = []
  let cursor = startAddress
  for (const run of parts[2]!.split(',')) {
    // Some descriptors put whitespace between the size and unit / cap
    // (e.g. "01*16 e"). Strip internal whitespace so the regex is
    // unambiguous.
    const cleaned = run.replace(/\s+/g, '')
    const m = /^(\d+)\*(\d+)([KM]?)([gear])$/i.exec(cleaned)
    if (!m)
      throw new Error(`DFU layout descriptor has unparseable run: "${run}"`)
    const count = Number.parseInt(m[1]!, 10)
    let pageSize = Number.parseInt(m[2]!, 10)
    const unit = (m[3] ?? '').toUpperCase()
    const cap = m[4]!.toLowerCase()
    if (unit === 'K')
      pageSize *= 1024
    else if (unit === 'M')
      pageSize *= 1024 * 1024
    for (let i = 0; i < count; i++) {
      sectors.push({ startAddress: cursor, size: pageSize, capability: cap })
      cursor += pageSize
    }
  }

  return { name, startAddress, sectors }
}

// Given a parsed memory layout + a list of (address, length) regions
// the caller wants to write, return the *unique* sector start addresses
// the caller must erase. Skips sectors flagged read-only.
export function planSectorErase(
  layout: DfuMemoryLayout,
  regions: ReadonlyArray<{ address: number, length: number }>,
): number[] {
  const out = new Set<number>()
  for (const region of regions) {
    const regionEnd = region.address + region.length // exclusive
    for (const sec of layout.sectors) {
      if (sec.capability !== 'g' && sec.capability !== 'e')
        continue
      const sectorEnd = sec.startAddress + sec.size // exclusive
      const overlaps = region.address < sectorEnd && regionEnd > sec.startAddress
      if (overlaps)
        out.add(sec.startAddress)
    }
  }
  return Array.from(out).sort((a, b) => a - b)
}
