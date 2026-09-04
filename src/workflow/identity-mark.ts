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

// A drone's identity, made lookable-at.
//
// The identity is 32 bytes of public key. As hex it is 64 characters an
// operator will never read, let alone compare — but comparing is exactly
// what they may need to do: "is the file I saved the one belonging to the
// drone in front of me?". So derive a small deterministic picture from the
// key, the way SSH key art does, plus a short grouped fingerprint. Two
// different drones look obviously different at a glance; the same drone
// looks identical every time.
//
// Pure and total: same bytes in, same mark out, no I/O. Nothing here is
// secret — the public half is public by design, and the private half never
// leaves the drone.

// One cell per key byte, laid out in a grid. Hue is what distinguishes
// cells; keeping saturation and lightness fixed is what keeps the mark
// legible against both a light and a dark background.
export const MARK_COLUMNS = 8
export const MARK_ROWS = 4

export interface IdentityMarkCell {
  // 0-359, straight from the byte.
  hue: number
  // Byte's high bit, drawn as a filled vs hollow cell so the mark still
  // reads when colour doesn't (print, colour blindness, a mono theme).
  solid: boolean
}

// Derive the grid. A key of the wrong length yields an empty mark rather
// than a partial one - a half-drawn identity would invite exactly the
// false match this exists to prevent.
export function identityMarkCells(publicKey: Uint8Array): IdentityMarkCell[] {
  if (publicKey.byteLength !== MARK_COLUMNS * MARK_ROWS)
    return []
  return [...publicKey].map(byte => ({
    hue: Math.round((byte / 256) * 360),
    solid: (byte & 0x80) !== 0,
  }))
}

// Short human-comparable fingerprint: the first eight bytes as hex in
// four-character groups. Enough to tell drones apart by eye, short enough
// that someone actually will. The full key lives in the identity file.
export function identityFingerprint(publicKey: Uint8Array): string {
  if (publicKey.byteLength === 0)
    return ''
  const hex = [...publicKey.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
  return (hex.match(/.{1,4}/g) ?? []).join(' ')
}
