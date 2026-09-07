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

// Reading a `.sfx` — the envelope a drone wraps its outbound artefacts
// in, so that only its owner can open them. The mirror of `.lxa`: there
// SFD encrypts to a drone, here a drone encrypts to its owner.
//
// The layout, and the reasoning behind it, are in docs/SECURITY.md
// "Outbound confidentiality". The parts that matter here:
//
//   0   6  magic "SFDX10"
//   6   1  content type          8  12  the drone's UID
//   7   1  flags                20  32  its per-artefact ephemeral public key
//  52  24  nonce                76  16  Poly1305 tag over bytes 0..75
//  92  ..  ciphertext
//
// The content key mixes two X25519 agreements: the ephemeral against the
// owner key, which only the owner can re-derive, and the drone's
// identity key against the owner key, which only that drone could have
// produced. Both agreements happen inside WebCrypto with a key this tool
// cannot read (see workflow/owner-key.ts) — everything below operates on
// their results, which are ordinary bytes by then.

import type { OwnerKey } from '../workflow/owner-key'
import { hchacha, xchacha20, xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { agree } from '../workflow/owner-key'

const MAGIC = 'SFDX10'
const OFS_TYPE = 6
const OFS_FLAGS = 7
const OFS_UID = 8
const OFS_EPK = 20
const OFS_NONCE = 52
const OFS_MAC = 76
export const SFX_HEADER_LEN = 92

const UID_LEN = 12
const KEY_LEN = 32
const NONCE_LEN = 24
const MAC_LEN = 16

const CONTEXT = new TextEncoder().encode('sfd-outbound/1')

// Block 0 of the keystream is the AEAD's one-time key, so the body
// starts at block 1 and the two never share one.
const BODY_BLOCK = 1

export const SFX_TYPE = { PARAMETERS: 1, LOG: 2 } as const
// The body is a seekable stream and carries no MAC of its own.
export const SFX_FLAG_STREAM = 1

export interface SfxHeader {
  contentType: number
  flags: number
  // The drone's STM32 UID, in the clear — which airframe this came from.
  uid: Uint8Array
  ephemeralPublicKey: Uint8Array
  nonce: Uint8Array
  mac: Uint8Array
}

export interface SfxArtefact {
  header: SfxHeader
  plaintext: Uint8Array
}

export class SfxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SfxError'
  }
}

// Is this a `.sfx` at all? Cheap enough to run on a downloaded file
// before deciding what to do with it, and a plain ArduPilot log answers
// false rather than erroring.
export function isSfx(bytes: Uint8Array): boolean {
  if (bytes.length < SFX_HEADER_LEN)
    return false
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i))
      return false
  }
  return true
}

// Read the header without opening anything. Useful on its own: it names
// the drone a file came from, which is what tells an operator they are
// holding somebody else's log rather than a corrupt one.
export function parseSfxHeader(bytes: Uint8Array): SfxHeader {
  if (!isSfx(bytes))
    throw new SfxError('That file isn\'t one of your drone\'s recordings.')
  return {
    contentType: bytes[OFS_TYPE] ?? 0,
    flags: bytes[OFS_FLAGS] ?? 0,
    uid: bytes.slice(OFS_UID, OFS_UID + UID_LEN),
    ephemeralPublicKey: bytes.slice(OFS_EPK, OFS_EPK + KEY_LEN),
    nonce: bytes.slice(OFS_NONCE, OFS_NONCE + NONCE_LEN),
    mac: bytes.slice(OFS_MAC, OFS_MAC + MAC_LEN),
  }
}

// HChaCha20 of a raw X25519 output, which is the second half of
// monocypher's crypto_key_exchange(). WebCrypto's X25519 stops at the
// raw output, so this finishes the job the firmware's one-call agreement
// does — splitting them is precisely what lets the private key stay
// inside WebCrypto.
function hashSharedSecret(raw: Uint8Array): Uint8Array {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const key = new Uint32Array(8)
  for (let i = 0; i < 8; i++)
    key[i] = view.getUint32(i * 4, true)
  // "expand 32-byte k", and a zero input, which is what
  // crypto_key_exchange passes
  const sigma = Uint32Array.from([0x61707865, 0x3320646E, 0x79622D32, 0x6B206574])
  const out = new Uint32Array(8)
  hchacha(sigma, key, new Uint32Array(4), out)
  const hashed = new Uint8Array(32)
  const outView = new DataView(hashed.buffer)
  for (let i = 0; i < 8; i++)
    outView.setUint32(i * 4, out[i] ?? 0, true)
  return hashed
}

// Re-derive the key the drone encrypted with.
async function contentKey(
  owner: OwnerKey,
  droneIdentityPublicKey: Uint8Array,
  header: SfxHeader,
  headerBytes: Uint8Array,
): Promise<Uint8Array> {
  const conf = hashSharedSecret(await agree(owner, header.ephemeralPublicKey))
  const auth = hashSharedSecret(await agree(owner, droneIdentityPublicKey))
  const input = new Uint8Array(conf.length + auth.length + CONTEXT.length + OFS_UID)
  input.set(conf, 0)
  input.set(auth, conf.length)
  input.set(CONTEXT, conf.length + auth.length)
  // magic, content type and flags, so a log and a parameter set from the
  // same drone never share a key
  input.set(headerBytes.subarray(0, OFS_UID), conf.length + auth.length + CONTEXT.length)
  return blake2b(input, { dkLen: 32 })
}

// Open a `.sfx`.
//
// Needs the drone's identity public key as well as the owner key,
// because the artefact is authenticated with the drone's identity and
// not merely concealed from everyone else. That is why the identity file
// is not just a record: without it a log cannot be read even by its
// owner.
//
// A log's body carries no MAC — see docs/SECURITY.md for why that is a
// deliberate trade against power-loss truncation. What is authenticated
// is the header, so the ephemeral key and the drone's id cannot be
// swapped. Don't describe a decrypted log as verified.
export async function openSfx(
  bytes: Uint8Array,
  owner: OwnerKey,
  droneIdentityPublicKey: Uint8Array,
): Promise<SfxArtefact> {
  const header = parseSfxHeader(bytes)
  const headerBytes = bytes.subarray(0, SFX_HEADER_LEN)
  const key = await contentKey(owner, droneIdentityPublicKey, header, headerBytes)

  // The header is authenticated as additional data over an empty
  // message, which is what the drone did.
  try {
    xchacha20poly1305(key, header.nonce, headerBytes.subarray(0, OFS_MAC)).decrypt(header.mac)
  }
  catch {
    throw new SfxError(
      'This recording isn\'t for the key you have loaded. It may belong to a different drone, or to a different owner.',
    )
  }

  const body = bytes.subarray(SFX_HEADER_LEN)
  return { header, plaintext: xchacha20(key, header.nonce, body, undefined, BODY_BLOCK) }
}
