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

// The owner keypair: the half of SFD enablement that runs outbound. A
// drone encrypts its logs to its owner's public key, and only the
// private half opens them.
//
// PLAN.md decision 37 says where that private half lives. It is
// generated **offline** (Tools/scripts/signing/owner_key.py in the
// firmware repo) and imported here as a **non-extractable** WebCrypto
// key: the browser will then perform the key agreement and refuse to
// hand the key back, so this tool decrypts without ever being able to
// read what it decrypts with. That is the whole reason the tool is
// allowed to touch an owner key at all — see docs/SECURITY.md.
//
// Generating in the browser instead would leave nothing to back up, and
// clearing site data would destroy every log the drone ever wrote. The
// offline original is the backup and it is the operator's to keep.

const OWNER_SCHEMA = 'sfd-owner/1'

// An X25519 public key is 32 raw bytes; the private half travels as
// PKCS#8, which is the only private format WebCrypto's X25519 accepts
// (raw import is refused - verified on Chromium 148).
const PUBLIC_KEY_LEN = 32
const PKCS8_LEN = 48

// What the offline generator writes and the operator keeps.
export interface OwnerKeyFile {
  schema: typeof OWNER_SCHEMA
  public_key: string
  private_key: string
  created_at: string
}

// An owner key as this tool holds it: a public half we can read and send,
// and a private half we demonstrably cannot.
export interface OwnerKey {
  privateKey: CryptoKey
  publicKey: Uint8Array
}

function decodeBase64(value: string, expected: number, what: string): Uint8Array {
  let raw: string
  try {
    raw = atob(value)
  }
  catch {
    throw new Error(`The ${what} in this key file isn't readable.`)
  }
  if (raw.length !== expected)
    throw new Error(`The ${what} in this key file is ${raw.length} bytes; it should be ${expected}.`)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

// Read an owner key file, rejecting anything we don't fully understand
// rather than guessing. A key file that is subtly wrong ends up written
// into a drone, and after that drone is sealed it cannot be corrected.
export function parseOwnerKeyFile(text: string): OwnerKeyFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    throw new Error('That file isn\'t an owner key file.')
  }
  const file = parsed as Partial<OwnerKeyFile>
  if (file.schema !== OWNER_SCHEMA)
    throw new Error('That file isn\'t an owner key file this version understands.')
  if (typeof file.public_key !== 'string' || typeof file.private_key !== 'string')
    throw new Error('That owner key file is missing its keys.')
  decodeBase64(file.public_key, PUBLIC_KEY_LEN, 'public key')
  decodeBase64(file.private_key, PKCS8_LEN, 'private key')
  return {
    schema: OWNER_SCHEMA,
    public_key: file.public_key,
    private_key: file.private_key,
    created_at: typeof file.created_at === 'string' ? file.created_at : '',
  }
}

// Import the private half so the browser holds it and we cannot. The
// `false` is the point of this function: it makes the key
// non-extractable, so exportKey refuses and nothing in this tool - or
// injected into it - can read the bytes back out.
export async function importOwnerKey(file: OwnerKeyFile): Promise<OwnerKey> {
  const pkcs8 = decodeBase64(file.private_key, PKCS8_LEN, 'private key')
  const publicKey = decodeBase64(file.public_key, PUBLIC_KEY_LEN, 'public key')
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'X25519' }, false, ['deriveBits'])
  }
  catch {
    throw new Error('That private key isn\'t one this browser can use.')
  }
  const key = { privateKey, publicKey }
  if (!await halvesMatch(key))
    throw new Error('The two halves of that key file don\'t belong together.')
  return key
}

// Do the public and private halves of a key file actually correspond?
//
// Worth checking, and not obvious how: a non-extractable private key
// cannot be asked for its public half. So agree a secret both ways
// against a throwaway pair - our private against its public, and its
// private against our public. Those match only if our two halves do.
//
// The reason to bother is that the public half is what gets written into
// a drone, and on a sealed drone that cannot be corrected: the operator
// would hold a key that opens nothing.
async function halvesMatch(key: OwnerKey): Promise<boolean> {
  const probe = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
  const ours = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'X25519', public: probe.publicKey },
    key.privateKey,
    256,
  ))
  const theirPublic = await crypto.subtle.importKey('raw', key.publicKey as BufferSource, { name: 'X25519' }, true, [])
  const theirs = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirPublic },
    probe.privateKey,
    256,
  ))
  return ours.length === theirs.length && ours.every((b, i) => b === theirs[i])
}

// The raw X25519 agreement against a peer's public key.
//
// Raw, deliberately: the firmware's crypto_key_exchange() is this
// followed by HChaCha20, and that second step is a hash of the result
// rather than anything involving the private key. Doing it separately is
// what lets the agreement itself stay inside WebCrypto with a key we
// cannot read.
export async function agree(key: OwnerKey, peerPublic: Uint8Array): Promise<Uint8Array> {
  if (peerPublic.length !== PUBLIC_KEY_LEN)
    throw new Error(`A public key must be ${PUBLIC_KEY_LEN} bytes; this one is ${peerPublic.length}.`)
  const peer = await crypto.subtle.importKey('raw', peerPublic as BufferSource, { name: 'X25519' }, true, [])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, key.privateKey, 256))
}

// A short, stable label for a key, so an operator can tell whether the
// key in the tool is the one they think it is without reading 64 hex
// characters. Not a security check - it is there to catch the wrong file,
// not an attacker.
export async function ownerFingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey as BufferSource))
  const hex = [...digest.subarray(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`
}
