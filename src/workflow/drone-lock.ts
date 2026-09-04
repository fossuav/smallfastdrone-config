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

// Sealing a drone's memory: the last step of the enable ceremony, and the
// only one that cannot be undone from the tool.
//
// The firmware side is F6 - `BRD_OPTIONS` bit 10, read at boot, raise-only.
// The firmware refuses it without a verified identity, and nothing in the
// firmware ever lowers it: getting back out means the DFU mass erase, which
// destroys the identity along with everything else.
//
// So the ordering matters and it is not ours to improvise: seal only a
// drone whose identity has already been generated *and verified*, never as
// part of the same action (docs/SECURITY.md, "Why this ordering is the
// security property"). This module is the arithmetic and the guard; the
// wizard supplies the deliberateness.

// BRD_OPTIONS bit 10. Named here rather than inline because a wrong bit
// would set an unrelated board option, and bits 4-6 in that same mask are
// flash write-protection.
export const LOCK_OPTION_BIT = 1 << 10

export const LOCK_PARAM = 'BRD_OPTIONS'

// Is the seal already asked for? Reads the request, which is all a
// parameter can tell us - see `sealedStateIsRequestOnly` below.
export function isLockRequested(options: number | undefined): boolean {
  if (options === undefined || !Number.isFinite(options))
    return false
  return (Math.trunc(options) & LOCK_OPTION_BIT) !== 0
}

// The value to write. Read-modify-write: BRD_OPTIONS carries nine other
// flags, including flash write protection, and clobbering them would be a
// far worse bug than failing to seal.
export function withLockBit(options: number | undefined): number {
  const current = options === undefined || !Number.isFinite(options) ? 0 : Math.trunc(options)
  return current | LOCK_OPTION_BIT
}

export type LockBlocker = 'no-identity' | 'already-sealed' | 'not-connected'

// Why the seal can't be offered, or null when it can. Mirrors the
// firmware's own refusal rather than trusting it: a drone that would
// refuse should never be shown the button.
export function lockBlocker(opts: {
  connected: boolean
  hasIdentity: boolean
  options: number | undefined
}): LockBlocker | null {
  if (!opts.connected)
    return 'not-connected'
  if (!opts.hasIdentity)
    return 'no-identity'
  if (isLockRequested(opts.options))
    return 'already-sealed'
  return null
}

// What the tool can honestly say afterwards.
//
// It cannot read the chip's protection level: that is a hardware state
// with no MAVLink representation, and the firmware's own call is a no-op
// once it is already set, so there is no signal to observe either. What
// can be confirmed is that the request is stored and survived a restart.
// The copy says exactly that and no more.
export const sealedStateIsRequestOnly = true
