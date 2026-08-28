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

// The enable ceremony against a fake drone. The ordering it enforces —
// generate, then prove the read-back matches, then and only then hand
// over a file — is what "never lock a drone whose identity is
// unconfirmed" rests on, so every way the drone can disagree with itself
// has a case here.

import type { DroneIdentity } from '../../src/protocol/secure-command'
import type { EnableContext, EnablePhase, IdentityClient } from '../../src/workflow/sfd-enable'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
import { describe, expect, it } from 'vitest'
import { SECURE_OP, SecureCommandError } from '../../src/protocol/secure-command'
import { parseIdentityFile } from '../../src/workflow/drone-identity'
import { EnableError, runEnableCeremony } from '../../src/workflow/sfd-enable'

const UID = Uint8Array.from([0x3F, 0x00, 0x25, 0x00, 0x0E, 0x51, 0x34, 0x32, 0x33, 0x35, 0x31, 0x32])
const UID_HEX = '3f0025000e51343233353132'
const FC_UID = `${UID_HEX}000000000000`

function identityWithKey(first: number): DroneIdentity {
  const publicKey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) publicKey[i] = (first + i) & 0xFF
  return { uid: Uint8Array.from(UID), publicKey }
}

// A drone as the ceremony sees it. `stored` is what GET returns; GENERATE
// mints a new one unless the drone is armed or already has one.
class FakeDrone implements IdentityClient {
  stored: DroneIdentity | null = null
  armed = false
  unsupported = false
  silent = false
  generateFails = false
  // Substituted for the stored identity on the read after generate, to
  // fake a drone whose flash disagrees with what it reported.
  readBackOverride: DroneIdentity | null | undefined
  calls: string[] = []

  constructor(stored: DroneIdentity | null = null) {
    this.stored = stored
  }

  getIdentity = async (): Promise<DroneIdentity | null> => {
    this.calls.push('get')
    this.refuseIfNotSfd(SECURE_OP.GET_IDENTITY)
    if (this.readBackOverride !== undefined && this.calls.includes('generate'))
      return this.readBackOverride
    return this.stored
  }

  generateIdentity = async (): Promise<DroneIdentity> => {
    this.calls.push('generate')
    this.refuseIfNotSfd(SECURE_OP.GENERATE_IDENTITY)
    if (this.generateFails)
      throw new SecureCommandError(SECURE_OP.GENERATE_IDENTITY, MavResult.FAILED, 'The drone couldn\'t complete the identity operation.')
    if (this.armed || this.stored !== null)
      throw new SecureCommandError(SECURE_OP.GENERATE_IDENTITY, MavResult.DENIED, 'refused')
    this.stored = identityWithKey(200)
    return this.stored
  }

  private refuseIfNotSfd(op: number): void {
    if (this.unsupported)
      throw new SecureCommandError(op, MavResult.UNSUPPORTED, 'unsupported')
    if (this.silent)
      throw new SecureCommandError(op, null, 'no answer', true)
  }
}

function ctx(overrides: Partial<EnableContext> = {}): EnableContext {
  return { boardId: 1063, fcUid: FC_UID, now: () => '2026-08-28T14:05:09Z', ...overrides }
}

async function failure(promise: Promise<unknown>): Promise<EnableError> {
  const err = await promise.catch(e => e)
  expect(err).toBeInstanceOf(EnableError)
  return err as EnableError
}

describe('runEnableCeremony on a fresh drone', () => {
  it('generates, verifies by a fresh read, and produces the file', async () => {
    const drone = new FakeDrone()
    const phases: EnablePhase[] = []
    const outcome = await runEnableCeremony(drone, ctx(), p => phases.push(p))

    expect(drone.calls).toEqual(['get', 'generate', 'get'])
    expect(phases).toEqual(['checking', 'generating', 'verifying', 'ready'])
    expect(outcome.generated).toBe(true)
    expect(outcome.file.uid).toBe(UID_HEX)
    expect(outcome.file.board_id).toBe(1063)
    expect(outcome.file.enabled_at).toBe('2026-08-28T14:05:09Z')
    expect(outcome.filename).toBe(`sfd-identity-${UID_HEX}.json`)
    // The text is the file, and it reads back as the identity in flash.
    const parsed = parseIdentityFile(outcome.text)
    expect(parsed.public_key).toBe(outcome.file.public_key)
    expect(Array.from(outcome.identity.publicKey)).toEqual(Array.from(drone.stored?.publicKey ?? []))
  })

  it('works without a phase callback', async () => {
    await expect(runEnableCeremony(new FakeDrone(), ctx())).resolves.toBeTruthy()
  })
})

describe('runEnableCeremony on a drone that already has an identity', () => {
  it('reads instead of generating and reports generated=false', async () => {
    const drone = new FakeDrone(identityWithKey(50))
    const phases: EnablePhase[] = []
    const outcome = await runEnableCeremony(drone, ctx(), p => phases.push(p))

    expect(drone.calls).toEqual(['get', 'get'])
    expect(phases).toEqual(['checking', 'verifying', 'ready'])
    expect(outcome.generated).toBe(false)
    expect(outcome.identity.publicKey[0]).toBe(50)
  })

  it('treats a DENIED generate followed by a successful read as the same case', async () => {
    // Nothing on the first read, but by the time generate lands the
    // drone has one (a late retry, another tool). Not an error.
    const drone = new FakeDrone()
    const original = drone.getIdentity
    let reads = 0
    drone.getIdentity = async () => {
      reads++
      if (reads === 1)
        return null
      return original()
    }
    drone.stored = identityWithKey(70)
    const outcome = await runEnableCeremony(drone, ctx())
    expect(outcome.generated).toBe(false)
    expect(outcome.identity.publicKey[0]).toBe(70)
  })
})

describe('runEnableCeremony stops with a reason', () => {
  it('armed: generate is denied and there is still nothing to read', async () => {
    const drone = new FakeDrone()
    drone.armed = true
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('armed')
    expect(err.message).toMatch(/Disarm/)
  })

  it('unsupported: the drone says so', async () => {
    const drone = new FakeDrone()
    drone.unsupported = true
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('unsupported')
    expect(err.message).toMatch(/Firmware page/)
  })

  it('unsupported: the drone never answers', async () => {
    const drone = new FakeDrone()
    drone.silent = true
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('unsupported')
  })

  it('mismatch: the read-back differs from what generate reported', async () => {
    const drone = new FakeDrone()
    drone.readBackOverride = identityWithKey(1)
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('mismatch')
    expect(err.message).toMatch(/Don't lock/)
  })

  it('mismatch: the read-back is empty', async () => {
    const drone = new FakeDrone()
    drone.readBackOverride = null
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('mismatch')
  })

  it('mismatch: the identity is not the connected drone\'s', async () => {
    const drone = new FakeDrone()
    const err = await failure(runEnableCeremony(drone, ctx({ fcUid: `ff${UID_HEX.slice(2)}000000000000` })))
    expect(err.reason).toBe('mismatch')
    expect(err.message).toMatch(/connected drone/)
  })

  it('passes the ownership check when the session has no uid to compare', async () => {
    await expect(runEnableCeremony(new FakeDrone(), ctx({ fcUid: null }))).resolves.toBeTruthy()
  })

  it('failed: the drone reported an error, and its message is kept', async () => {
    const drone = new FakeDrone()
    drone.generateFails = true
    const err = await failure(runEnableCeremony(drone, ctx()))
    expect(err.reason).toBe('failed')
    expect(err.message).toMatch(/couldn't complete/)
  })

  it('never produces a file when it stops', async () => {
    const drone = new FakeDrone()
    drone.readBackOverride = identityWithKey(1)
    const phases: EnablePhase[] = []
    await runEnableCeremony(drone, ctx(), p => phases.push(p)).catch(() => {})
    expect(phases).not.toContain('ready')
  })
})
