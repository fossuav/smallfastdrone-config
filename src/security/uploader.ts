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

// Security uploader seam — the single chokepoint every artifact upload
// routes through (firmware reflash, Lua applet install, future mission
// upload). Per CLAUDE.md: "all artifact uploads route through
// src/security/uploader.ts" — no direct upload paths anywhere else.
//
// v1 ships the **seam**, not the implementation: the interface is
// `SignedArtifactUploader`, and `PassthroughUploader` simply forwards
// the bytes to whatever protocol-layer function the caller supplied.
// The shape is what matters — when real signing + (where applicable)
// decryption land later, the protocol callers don't change.
//
// See docs/SECURITY.md for the local-keys + remote-key-exchange flows
// this seam unblocks.

// Operator-meaningful kind of artifact being uploaded — used for routing
// (future), reporting, and the eventual signing key selection.
export type ArtifactKind = 'firmware' | 'lua-applet' | 'mission'

export interface UploadJob {
  // What we're uploading — drives the verification policy (firmware =
  // signed by the SFD release key; lua-applet = signed by the user/SFD
  // depending on origin; etc.).
  kind: ArtifactKind
  // Operator-facing label (used in progress + errors).
  name: string
  // The bytes to land on the FC. Already parsed/decompressed/etc. by
  // the caller — this layer doesn't know the format.
  bytes: Uint8Array
}

// What the uploader hands off to. The protocol layer (bootloader, DFU,
// Lua-FTP) supplies a `runUpload(bytes)` that pushes the verified bytes
// to the FC. Progress callbacks let the UI render percent + phase.
export interface UploadTransport {
  // Push the verified bytes to the FC. Resolves on success; throws on
  // failure. The protocol layer is responsible for any inner protocol
  // chatter (erase, program, verify, …).
  runUpload: (bytes: Uint8Array, onProgress?: (fraction: number) => void) => Promise<void>
}

// The seam itself. v1 is a passthrough; future implementations will
// verify signatures, decrypt where applicable, and choose keys.
export interface SignedArtifactUploader {
  upload: (job: UploadJob, transport: UploadTransport, onProgress?: (fraction: number) => void) => Promise<void>
}

// v1 implementation: no signature check, no decryption — just forward
// the bytes. **Every** production upload path uses this (or a future
// drop-in replacement). When `docs/SECURITY.md`'s signing pipeline lands,
// only this file changes; the protocol-layer callers don't.
export class PassthroughUploader implements SignedArtifactUploader {
  async upload(job: UploadJob, transport: UploadTransport, onProgress?: (fraction: number) => void): Promise<void> {
    await transport.runUpload(job.bytes, onProgress)
  }
}

// Convenience singleton — most callers just want "the default uploader".
// Future arcs might swap this for a concrete `SignedReleaseUploader`
// (firmware) / `EncryptedLuaUploader` (custom applets) chosen by job.kind.
export const defaultUploader: SignedArtifactUploader = new PassthroughUploader()
