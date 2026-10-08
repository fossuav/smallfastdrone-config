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

// Reading an `sfd-bundle/1` — a script product SFD packed for one drone
// (PLAN decision 46, docs/SECURITY.md "Script products").
//
// A product is usually several files: applets in APM/scripts and the
// modules they require() from APM/scripts/modules, every one of them a
// `.lxa` only the target drone can open. `pack_lua.py` in the firmware
// repo writes them into one JSON file, the same shape as an `.apj`:
//
//    {
//      "schema":  "sfd-bundle/1",
//      "product": "acro_fence",
//      "title":   "Acro fence",
//      "version": "ap_lua 3f2a9c1",          (optional)
//      "uid":     "<12-byte drone uid, hex>",
//      "files":   [{ "path": "scripts/acro_fence.lxa", "data": "<base64>" }]
//    }
//
// The tool is a courier here exactly as it is for a single `.lxa`: it
// reads the packing list and each member's address, never the contents.
// Nothing this module concludes is enforcement — the drone checks the
// address and the encryption itself — it exists so the wrong file is
// refused when it is chosen, not after an upload.

import { isLxa, lxaMatchesFc, parseLxaHeader } from './lxa'

export const BUNDLE_SCHEMA = 'sfd-bundle/1'

// The two places the firmware loads from: top-level scripts, and the
// modules/?.lxa entry on the require() path. A name is what a Lua
// module name can be, which also keeps any path trickery out.
const PATH = /^scripts\/(?:(modules)\/)?(\w+)\.lxa$/
const PRODUCT = /^\w+$/

export interface BundleFile {
  // Relative to APM/, as the bundle names it.
  path: string
  // The folder on the drone it lands in.
  dir: 'APM/scripts' | 'APM/scripts/modules'
  // The file name without `.lxa` — and so the name a same-named
  // plaintext `.lua` beside it would have.
  stem: string
  bytes: Uint8Array
}

export interface Bundle {
  product: string
  // What the operator is shown.
  title: string
  version: string | null
  // The drone every member is addressed to, lower-case hex.
  uid: string
  files: BundleFile[]
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

const NOT_A_BUNDLE = 'That file isn\'t a script package from SmallFastDrone.'

// Could these bytes be a bundle? Cheap, so a surface that takes either a
// bundle or a single `.lxa` can tell which it was given.
export function looksLikeBundle(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    // skip leading JSON whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D)
      continue
    return b === 0x7B // '{'
  }
  return false
}

// atob into bytes; null rather than a DOMException for bad input.
function base64Decode(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++)
      out[i] = binary.charCodeAt(i)
    return out
  }
  catch {
    return null
  }
}

// One member: where it goes, and that it really is an applet for the
// drone the header names.
function parseFile(entry: unknown, uid: string, seen: Set<string>): BundleFile {
  const { path, data } = (entry ?? {}) as { path?: unknown, data?: unknown }
  if (typeof path !== 'string' || typeof data !== 'string')
    throw new BundleError(`${NOT_A_BUNDLE} One of its files has no name or no contents.`)
  const m = PATH.exec(path)
  if (!m)
    throw new BundleError(`${NOT_A_BUNDLE} It wants to put a file somewhere scripts don't go (${path}).`)
  if (seen.has(path))
    throw new BundleError(`${NOT_A_BUNDLE} It lists ${path} twice.`)
  seen.add(path)

  const bytes = base64Decode(data)
  if (bytes === null || !isLxa(bytes))
    throw new BundleError(`${NOT_A_BUNDLE} ${path} inside it isn't a scrambled applet.`)
  if (parseLxaHeader(bytes).uid !== uid)
    throw new BundleError(`${NOT_A_BUNDLE} ${path} inside it was made for a different drone than the package says.`)

  return { path, dir: m[1] ? 'APM/scripts/modules' : 'APM/scripts', stem: m[2]!, bytes }
}

// Read a bundle's packing list and check every member. Throws a
// BundleError worded for an operator.
export function parseBundle(bytes: Uint8Array): Bundle {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  }
  catch {
    throw new BundleError(NOT_A_BUNDLE)
  }
  if (doc === null || typeof doc !== 'object' || doc.schema !== BUNDLE_SCHEMA)
    throw new BundleError(NOT_A_BUNDLE)

  const { product, title, version, uid, files } = doc
  if (typeof product !== 'string' || !PRODUCT.test(product)
    || typeof title !== 'string' || title.trim() === ''
    || typeof uid !== 'string' || !/^[0-9a-f]{24}$/.test(uid)
    || (version !== undefined && typeof version !== 'string')) {
    throw new BundleError(`${NOT_A_BUNDLE} Its label is incomplete.`)
  }
  if (!Array.isArray(files) || files.length === 0)
    throw new BundleError(`${NOT_A_BUNDLE} It has nothing in it.`)

  const seen = new Set<string>()
  return {
    product,
    title: title.trim(),
    version: version ?? null,
    uid,
    files: files.map(f => parseFile(f, uid, seen)),
  }
}

// Was this bundle packed for the drone we're talking to? The same
// prefix rule a single applet uses, since the header uid is the same
// 12-byte value.
export function bundleMatchesFc(bundle: Bundle, fcUid: string | null): boolean {
  return lxaMatchesFc({ uid: bundle.uid, bodyLength: 0 }, fcUid)
}
