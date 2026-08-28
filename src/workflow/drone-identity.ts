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

// The drone identity file: what an SFD-enabled drone's public identity
// looks like on disk, and how to read one back. Pure — no store, no Vue,
// no browser API — so it runs in Vitest's node runtime; the enable
// workflow (sfd-enable.ts) builds one from the bytes the drone returns
// and the view hands it to the browser's download path.
//
// The file is what SFD needs to encrypt applets for one airframe: the
// STM32 UID (which the .lxa nonce prefix must match) and the X25519
// public key (which the applet's ephemeral key is exchanged against). It
// contains nothing secret — the private half never leaves the drone — so
// it can travel by any channel. The same document is written by
// Tools/scripts/signing/sfd_identity.py in the firmware repo, so the two
// must agree byte-for-byte on shape; docs/SECURITY.md "Drone identity
// file" is the contract both follow.

import type { DroneIdentity } from '../protocol/secure-command'
import { IDENTITY_KEY_LEN, IDENTITY_UID_LEN } from '../protocol/secure-command'

// Bumped only when the document shape changes incompatibly.
// parseIdentityFile refuses anything it doesn't recognise rather than
// guessing: an identity file is the one input SFD encrypts against, and a
// half-understood one produces applets no drone can open.
export const IDENTITY_SCHEMA = 'sfd-identity/1'

// Field names are snake_case, unlike the settings backup, because this
// document is consumed by SFD's Python tooling and written by
// sfd_identity.py; the two sides share one spelling.
export interface IdentityFile {
  schema: typeof IDENTITY_SCHEMA
  // STM32 96-bit unique id, 24 lower-case hex characters.
  uid: string
  // X25519 public key, 32 bytes, standard base64.
  public_key: string
  // APJ_BOARD_ID from AUTOPILOT_VERSION, or null when the drone didn't
  // say. Informational: tells SFD which firmware build the airframe runs.
  board_id: number | null
  // ISO 8601, supplied by the caller so this module stays pure.
  enabled_at: string
}

// Render the identity the drone returned as the file the operator keeps.
export function buildIdentityFile(identity: DroneIdentity, boardId: number | null, enabledAt: string): IdentityFile {
  return {
    schema: IDENTITY_SCHEMA,
    uid: identityUidHex(identity),
    public_key: bytesToBase64(identity.publicKey),
    board_id: boardId,
    enabled_at: enabledAt,
  }
}

// The JSON that lands on disk. Indented so it reads in a text editor —
// an operator emailing SFD their identity file will look at it first.
export function serializeIdentityFile(file: IdentityFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// Read an identity file back, with errors an operator can act on.
//
// Throws rather than returning null: every caller has to stop and tell
// the operator what's wrong with the file they picked. The uid is
// normalised to lower case so two files for the same drone compare equal
// however they were written.
export function parseIdentityFile(text: string): IdentityFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    throw new Error('That file isn\'t a drone identity — it isn\'t readable as one.')
  }

  if (!isRecord(raw))
    throw new Error('That file isn\'t a drone identity.')

  if (raw.schema !== IDENTITY_SCHEMA) {
    throw new Error(
      typeof raw.schema === 'string' && raw.schema.startsWith('sfd-identity/')
        ? 'That identity file was saved by a newer version of this tool.'
        : 'That file isn\'t a drone identity.',
    )
  }

  if (typeof raw.uid !== 'string' || !/^[0-9a-f]{24}$/i.test(raw.uid))
    throw new Error('That identity file is damaged — the drone id is unreadable.')

  const key = typeof raw.public_key === 'string' ? base64ToBytes(raw.public_key) : null
  if (key === null || key.byteLength !== IDENTITY_KEY_LEN)
    throw new Error('That identity file is damaged — the public key is unreadable.')

  if (raw.board_id !== null && typeof raw.board_id !== 'number')
    throw new Error('That identity file is damaged — the board id is unreadable.')

  if (typeof raw.enabled_at !== 'string')
    throw new Error('That identity file is damaged — it has no enable date.')

  return {
    schema: IDENTITY_SCHEMA,
    uid: raw.uid.toLowerCase(),
    public_key: raw.public_key as string,
    board_id: raw.board_id,
    enabled_at: raw.enabled_at,
  }
}

// The bytes a parsed file describes, in the shape the protocol layer
// returns from the drone — so a file can be compared against a live
// read with sameIdentity().
export function identityFromFile(file: IdentityFile): DroneIdentity {
  return {
    uid: hexToBytes(file.uid),
    publicKey: base64ToBytes(file.public_key) ?? new Uint8Array(0),
  }
}

// Lower-case hex of the 12-byte uid — the form the file and the session
// store both use.
export function identityUidHex(identity: DroneIdentity): string {
  return bytesToHex(identity.uid)
}

// Byte-for-byte equality of two identities. The enable ceremony's
// verify step hinges on this: the identity read back from flash must be
// the one the drone reported generating.
export function sameIdentity(a: DroneIdentity, b: DroneIdentity): boolean {
  return bytesEqual(a.uid, b.uid) && bytesEqual(a.publicKey, b.publicKey)
}

// Whether an identity belongs to the drone the session is talking to.
// AUTOPILOT_VERSION's uid2 is the same 12-byte STM32 UID zero-padded to
// 18, and the session store renders all 18 bytes, so the identity's uid
// must be a prefix of the store's fcUid. With no fcUid known there is
// nothing to contradict and the check passes.
export function identityMatchesFc(identity: DroneIdentity, fcUid: string | null): boolean {
  if (fcUid === null)
    return true
  return fcUid.toLowerCase().startsWith(identityUidHex(identity))
}

// Filename for a saved identity. Carries the uid so a folder of them
// from several drones stays tellable apart, and is prefixed so it's
// recognisable among a download folder full of unrelated files.
export function identityFilename(file: IdentityFile): string {
  return `sfd-identity-${file.uid}.json`
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// null when the text isn't base64 at all; length is the caller's check.
function base64ToBytes(text: string): Uint8Array | null {
  let binary: string
  try {
    binary = atob(text)
  }
  catch {
    return null
  }
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength)
    return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i])
      return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Re-exported so a caller building a placeholder identity for a test or
// a preview doesn't need to reach into the protocol layer for the sizes.
export { IDENTITY_KEY_LEN, IDENTITY_UID_LEN }
