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

// MAVLink FTP client. Speaks the FILE_TRANSFER_PROTOCOL message
// (msgid 110) per https://mavlink.io/en/services/ftp.html, which
// ArduPilot's GCS_FTP implementation honours. Used by the Lua engine
// in the wizard runtime to upload applet.lua to APM/scripts/ and to
// remove it on completion; also useable as a standalone primitive for
// any future "push a file to the FC" workflow.
//
// Wire format of the FILE_TRANSFER_PROTOCOL payload (251 bytes):
//
//   0-1   seq_number   uint16 LE
//   2     session
//   3     opcode
//   4     size         (data length, 0..239)
//   5     req_opcode   (echoed by the server in responses)
//   6     burst_complete
//   7     padding
//   8-11  offset       uint32 LE
//   12+   data         (up to 239 bytes)
//
// The class enforces a single in-flight operation at a time — every
// public method awaits its full request/response cycle before
// returning. Callers serialise naturally.

import type { MavLinkData } from 'mavlink-mappings'
import type { MessageHandler } from './mavlink'
import process from 'node:process'
import { FileTransferProtocol } from 'mavlink-mappings/dist/lib/common'

// FILE_TRANSFER_PROTOCOL message id, used to filter incoming messages.
const MSGID_FILE_TRANSFER_PROTOCOL = FileTransferProtocol.MSG_ID

// Per-request response timeout. ArduPilot SITL acks within a few ms;
// real radios may take longer. 1500ms is generous without being so long
// that a stuck operation hangs the wizard runtime.
const RESPONSE_TIMEOUT_MS = 1500

// Max data bytes per FTP frame (251 byte payload - 12 byte header).
const MAX_DATA_BYTES = 239

// Reusable empty buffer for ops with no data field.
const EMPTY = new Uint8Array(0)

// FTP opcodes — subset of MAV_FTP_OPCODE we use. Full list is in
// MAVLink common dialect; the rest (BurstReadFile, CalcFileCRC32, etc.)
// aren't needed for the wizard runtime's upload-and-delete lifecycle.
export const FTP_OP = {
  TERMINATE_SESSION: 1,
  RESET_SESSIONS: 2,
  LIST_DIRECTORY: 3,
  OPEN_FILE_RO: 4,
  READ_FILE: 5,
  CREATE_FILE: 6,
  WRITE_FILE: 7,
  REMOVE_FILE: 8,
  CREATE_DIRECTORY: 9,
  REMOVE_DIRECTORY: 10,
  OPEN_FILE_WO: 11,
  TRUNCATE_FILE: 12,
  RENAME: 13,
  ACK: 128,
  NAK: 129,
} as const

// MAV_FTP_ERR values returned in the first byte of a NAK's data field.
// FAIL_ERRNO (2) means the second byte carries a POSIX errno.
const FTP_ERR_NAMES: Record<number, string> = {
  0: 'None',
  1: 'Fail',
  2: 'FailErrno',
  3: 'InvalidDataSize',
  4: 'InvalidSession',
  5: 'NoSessionsAvailable',
  6: 'EOF',
  7: 'UnknownCommand',
  8: 'FileExists',
  9: 'FileProtected',
  10: 'FileNotFound',
}

export class MavFtpError extends Error {
  constructor(
    public readonly errCode: number,
    public readonly errno: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'MavFtpError'
  }
}

// Parsed FTP frame returned by sendOp(). req_opcode identifies which
// request the server is responding to; opcode is ACK or NAK.
interface FtpResponse {
  seq: number
  session: number
  opcode: number
  size: number
  reqOpcode: number
  burstComplete: number
  offset: number
  data: Uint8Array
}

// One entry from listDirectory().
export interface FtpDirEntry {
  name: string
  isDir: boolean
  // Size in bytes for files; undefined for directories.
  size?: number
}

// Parse a LIST_DIRECTORY data blob into entries. The blob is null-separated
// records, each "F<name>\t<size>" (file) or "D<name>" (directory) — see
// GCS_FTP.cpp gen_dir_entry. Unknown/empty records are skipped.
function parseDirEntries(data: Uint8Array): FtpDirEntry[] {
  const text = new TextDecoder().decode(data)
  const out: FtpDirEntry[] = []
  for (const record of text.split('\0')) {
    if (record.length < 2)
      continue
    const kind = record[0]
    const rest = record.slice(1)
    if (kind === 'D') {
      out.push({ name: rest, isDir: true })
    }
    else if (kind === 'F') {
      const tab = rest.indexOf('\t')
      const name = tab >= 0 ? rest.slice(0, tab) : rest
      const size = tab >= 0 ? Number.parseInt(rest.slice(tab + 1), 10) : undefined
      out.push({ name, isDir: false, size: Number.isNaN(size) ? undefined : size })
    }
  }
  return out
}

export class MavFtp {
  // Sequence counter — incremented per request. Each request frame
  // carries the current seq; the server's response carries seq+1 per
  // ArduPilot's GCS_FTP. We match responses by req_opcode rather than
  // seq to stay tolerant of any seq-wraparound quirks; only one
  // operation is ever in flight so the match is unambiguous.
  private seq = 0

  constructor(
    private readonly send: (msg: MavLinkData) => Promise<void>,
    private readonly subscribe: (cb: MessageHandler) => () => void,
    private readonly targetSystem: number,
    private readonly targetComponent: number,
  ) {}

  // Upload a file to the FC. Chunks the contents into 239-byte
  // WriteFile ops, then closes the session. Throws MavFtpError on any
  // server NAK or response timeout. The remote path is what the FC's
  // filesystem sees — for ArduPilot, "APM/<rest>" maps to its scripts
  // / params / logs directory tree.
  async uploadFile(remotePath: string, contents: Uint8Array): Promise<void> {
    // CreateFile creates-or-truncates; FileExists would only fire if
    // the path collided with a directory or a write-locked file.
    const created = await this.sendOp(FTP_OP.CREATE_FILE, 0, 0, encodePath(remotePath))
    const session = created.session

    try {
      // Write chunks at increasing offsets. The server responds to each
      // WriteFile individually; we await each before sending the next.
      let offset = 0
      while (offset < contents.length) {
        const end = Math.min(offset + MAX_DATA_BYTES, contents.length)
        const chunk = contents.subarray(offset, end)
        await this.sendOp(FTP_OP.WRITE_FILE, session, offset, chunk)
        offset = end
      }
    }
    finally {
      // Always close the session, even if a write failed mid-stream,
      // so we don't leak FC-side resources.
      await this.sendOp(FTP_OP.TERMINATE_SESSION, session, 0, EMPTY).catch(() => {})
    }
  }

  // Download a file from the FC. Opens read-only and reads chunks at
  // increasing offsets until the server returns an EOF NAK or an
  // empty chunk, then closes the session. Returns the file contents
  // as a single Uint8Array.
  //
  // ArduPilot's GCS_FTP doesn't fill OpenFileRO's ACK with the file
  // size (it leaves data empty), so we can't preallocate or bound
  // the read loop by size. Driving off EOF is the portable shape and
  // is what MAVProxy's mavftp.py does too.
  async downloadFile(remotePath: string): Promise<Uint8Array> {
    const opened = await this.sendOp(FTP_OP.OPEN_FILE_RO, 0, 0, encodePath(remotePath))
    const session = opened.session

    try {
      const chunks: Uint8Array[] = []
      let offset = 0
      while (true) {
        let chunk: FtpResponse
        try {
          // ArduPilot's GCS_FTP uses the request's `size` byte as the
          // desired read length (not the data length). Asking for
          // MAX_DATA_BYTES per chunk matches what MAVProxy does and
          // keeps the round-trip count minimal for typical applet
          // payloads (~1–4 KB).
          chunk = await this.sendOp(FTP_OP.READ_FILE, session, offset, EMPTY, MAX_DATA_BYTES)
        }
        catch (e) {
          // EOF NAK is the normal end-of-file signal during read.
          if (e instanceof MavFtpError && e.errCode === 6)
            break
          throw e
        }
        if (chunk.data.byteLength === 0)
          break
        // Copy the chunk into a fresh buffer — chunk.data is a
        // subarray over the response payload, which we own for now
        // but defensively copying keeps the contract clear for any
        // future buffer-reuse optimisation.
        chunks.push(new Uint8Array(chunk.data))
        offset += chunk.data.byteLength
      }

      const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0)
      const out = new Uint8Array(totalSize)
      let pos = 0
      for (const c of chunks) {
        out.set(c, pos)
        pos += c.byteLength
      }
      return out
    }
    finally {
      await this.sendOp(FTP_OP.TERMINATE_SESSION, session, 0, EMPTY).catch(() => {})
    }
  }

  // List a directory's entries. A session-less op (unlike download, which
  // opens a file session) so it doesn't tie up an FC FTP session. Pages
  // through with `offset` = entries-to-skip until the FC returns an EOF
  // NAK. Throws MavFtpError (FailErrno) if the directory doesn't exist.
  // Entry wire format (GCS_FTP.cpp gen_dir_entry): null-separated, each
  // "F<name>\t<size>" for a file or "D<name>" for a directory.
  async listDirectory(remotePath: string): Promise<FtpDirEntry[]> {
    const out: FtpDirEntry[] = []
    let offset = 0
    while (true) {
      let resp: FtpResponse
      try {
        resp = await this.sendOp(FTP_OP.LIST_DIRECTORY, 0, offset, encodePath(remotePath))
      }
      catch (e) {
        // EOF NAK = we've paged past the last entry.
        if (e instanceof MavFtpError && e.errCode === 6)
          break
        throw e
      }
      const entries = parseDirEntries(resp.data.subarray(0, resp.size))
      if (entries.length === 0)
        break
      out.push(...entries)
      offset += entries.length
    }
    return out
  }

  // Delete a file at the given remote path. Throws MavFtpError with
  // FileNotFound if the path doesn't exist; callers that want
  // delete-if-exists semantics should swallow that case explicitly.
  async removeFile(remotePath: string): Promise<void> {
    await this.sendOp(FTP_OP.REMOVE_FILE, 0, 0, encodePath(remotePath))
  }

  // Create a directory at the given remote path. Throws FileExists if
  // the directory already exists — callers usually want to swallow
  // that case (the "make sure this exists" intent). FileNotFound here
  // means the *parent* directory is missing — create-it-then-retry is
  // the caller's responsibility (we don't recursively mkdir to keep
  // the protocol layer side-effect-free).
  async createDirectory(remotePath: string): Promise<void> {
    await this.sendOp(FTP_OP.CREATE_DIRECTORY, 0, 0, encodePath(remotePath))
  }

  // Reset the server's session table. Useful at startup to clear any
  // sessions left over from a previous client (the FC won't free them
  // until we either close them or reset).
  async resetSessions(): Promise<void> {
    await this.sendOp(FTP_OP.RESET_SESSIONS, 0, 0, EMPTY)
  }

  // Send one FTP request, await the matching response, parse it,
  // throw MavFtpError on NAK. Times out after RESPONSE_TIMEOUT_MS.
  // `sizeOverride` lets callers set the request's `size` byte
  // independently of the data length — needed for ReadFile, where
  // the byte indicates the desired read length and the data field
  // is empty.
  private async sendOp(
    opcode: number,
    session: number,
    offset: number,
    data: Uint8Array,
    sizeOverride?: number,
  ): Promise<FtpResponse> {
    const seq = this.seq++ & 0xFFFF
    const frame = buildFrame(seq, session, opcode, offset, data, sizeOverride ?? data.byteLength)

    const msg = new FileTransferProtocol()
    msg.targetNetwork = 0
    msg.targetSystem = this.targetSystem
    msg.targetComponent = this.targetComponent
    // mavlink-mappings types `payload` as uint8_t[] — assigning a
    // Uint8Array works at runtime; the cast keeps strict TS happy
    // without weakening the rest of the type.
    msg.payload = frame as unknown as number[]

    return new Promise<FtpResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const cleanup = () => {
        if (timer)
          clearTimeout(timer)
        unsubscribe?.()
      }

      unsubscribe = this.subscribe((message) => {
        if (message.msgid !== MSGID_FILE_TRANSFER_PROTOCOL)
          return
        const ftp = message.data as FileTransferProtocol
        const responsePayload = ftp.payload as unknown as ArrayLike<number>
        const responseBytes = Uint8Array.from(responsePayload)
        const response = parseFrame(responseBytes)
        if (process.env.FTP_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[ftp] resp req=${response.reqOpcode} op=${response.opcode} seq=${response.seq} session=${response.session} size=${response.size} offset=${response.offset} data[0..8]=${Array.from(response.data.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
        }
        // Match on req_opcode — the server echoes the request's
        // opcode in this field, and we only ever have one op in
        // flight so this is unambiguous.
        if (response.reqOpcode !== opcode)
          return
        cleanup()
        if (response.opcode === FTP_OP.NAK) {
          const errCode = response.data[0] ?? 0
          const errno = errCode === 2 ? response.data[1] : undefined
          const name = FTP_ERR_NAMES[errCode] ?? `err${errCode}`
          const detail = errno !== undefined ? ` (errno ${errno})` : ''
          reject(new MavFtpError(errCode, errno, `FTP ${opcodeName(opcode)} failed: ${name}${detail}`))
          return
        }
        resolve(response)
      })

      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`FTP ${opcodeName(opcode)} timed out after ${RESPONSE_TIMEOUT_MS}ms`))
      }, RESPONSE_TIMEOUT_MS)

      this.send(msg).catch((e) => {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }
}

// Encode a remote path as the data field — UTF-8 bytes, no null
// terminator. ArduPilot uses the `size` byte to know the length.
function encodePath(path: string): Uint8Array {
  return new TextEncoder().encode(path)
}

// Build a 251-byte FTP payload from the request fields. Data must fit
// in MAX_DATA_BYTES; longer payloads are caller responsibility to
// chunk before reaching this function.
function buildFrame(
  seq: number,
  session: number,
  opcode: number,
  offset: number,
  data: Uint8Array,
  size: number,
): Uint8Array {
  if (data.byteLength > MAX_DATA_BYTES)
    throw new Error(`FTP frame data is ${data.byteLength} bytes, max ${MAX_DATA_BYTES}`)
  if (size > MAX_DATA_BYTES)
    throw new Error(`FTP frame size byte ${size} > MAX_DATA_BYTES`)
  const frame = new Uint8Array(12 + MAX_DATA_BYTES)
  const view = new DataView(frame.buffer)
  view.setUint16(0, seq, true)
  frame[2] = session
  frame[3] = opcode
  frame[4] = size
  frame[5] = 0 // req_opcode unused on request
  frame[6] = 0 // burst_complete
  frame[7] = 0 // padding
  view.setUint32(8, offset, true)
  frame.set(data, 12)
  return frame
}

// Parse a FILE_TRANSFER_PROTOCOL payload into a structured response.
// The data field length is taken from the `size` byte rather than the
// payload length, because the payload is fixed-size 251 bytes with
// trailing zeros padding short responses.
function parseFrame(payload: Uint8Array): FtpResponse {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const seq = view.getUint16(0, true)
  const session = payload[2] ?? 0
  const opcode = payload[3] ?? 0
  const size = payload[4] ?? 0
  const reqOpcode = payload[5] ?? 0
  const burstComplete = payload[6] ?? 0
  const offset = view.getUint32(8, true)
  const data = payload.subarray(12, 12 + size)
  return { seq, session, opcode, size, reqOpcode, burstComplete, offset, data }
}

// Friendly opcode name for error messages, since FTP_OP is a flat
// constant object without a built-in reverse lookup.
function opcodeName(opcode: number): string {
  for (const [name, value] of Object.entries(FTP_OP)) {
    if (value === opcode)
      return name
  }
  return `op${opcode}`
}
