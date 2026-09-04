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

// Security posture derived from one GET_IDENTITY read. The four answers
// the firmware can give map to four different things to tell an operator,
// and the bench is what proved the firmware really answers this way.

import type { IdentityReader } from '../../src/workflow/drone-security'
import { MavResult } from 'mavlink-mappings/dist/lib/common'
import { describe, expect, it } from 'vitest'
import { SECURE_OP, SecureCommandError } from '../../src/protocol/secure-command'
import { describePosture, probeSecurityPosture } from '../../src/workflow/drone-security'

const IDENTITY = { uid: new Uint8Array(12), publicKey: new Uint8Array(32) }

function reader(answer: () => Promise<ReturnType<IdentityReader['getIdentity']>>): IdentityReader {
  return { getIdentity: answer }
}

function secureError(opts: { timedOut?: boolean, result?: MavResult, noRegion?: boolean }): SecureCommandError {
  return new SecureCommandError(
    SECURE_OP.GET_IDENTITY,
    opts.result ?? MavResult.FAILED,
    'x',
    opts.timedOut ?? false,
    opts.noRegion ?? false,
  )
}

describe('probeSecurityPosture', () => {
  it('an identity means secured startup software and a known drone', async () => {
    const posture = await probeSecurityPosture(reader(async () => IDENTITY))
    expect(posture).toBe('identified')
  })

  it('no identity yet still means the startup software is secured', async () => {
    const posture = await probeSecurityPosture(reader(async () => null))
    expect(posture).toBe('secured')
  })

  it('no identity region is part-way, not unsecured — the firmware is SFD', async () => {
    const posture = await probeSecurityPosture(reader(async () => {
      throw secureError({ noRegion: true })
    }))
    expect(posture).toBe('bootloader-outdated')
    expect(posture).not.toBe('unsecured')
  })

  it('silence means an unsigned build, which never compiles the handler', async () => {
    const posture = await probeSecurityPosture(reader(async () => {
      throw secureError({ timedOut: true, result: undefined })
    }))
    expect(posture).toBe('unsecured')
  })

  it('an UNSUPPORTED verdict means the firmware lacks the identity commands', async () => {
    const posture = await probeSecurityPosture(reader(async () => {
      throw secureError({ result: MavResult.UNSUPPORTED })
    }))
    expect(posture).toBe('unsecured')
  })

  it('never throws — an undeterminable posture is unknown, not an error', async () => {
    const posture = await probeSecurityPosture(reader(async () => {
      throw new Error('link died mid-probe')
    }))
    expect(posture).toBe('unknown')
  })

  it('a plain FAILED is not evidence of anything, so it stays unknown', async () => {
    const posture = await probeSecurityPosture(reader(async () => {
      throw secureError({ result: MavResult.FAILED })
    }))
    expect(posture).toBe('unknown')
  })
})

describe('describePosture', () => {
  it('shows the lock only where the startup software is actually secured', () => {
    expect(describePosture('identified').locked).toBe(true)
    expect(describePosture('secured').locked).toBe(true)
    expect(describePosture('bootloader-outdated').locked).toBe(false)
    expect(describePosture('unsecured').locked).toBe(false)
    expect(describePosture('unknown').locked).toBe(false)
  })

  it('never claims the drone would refuse unsigned firmware — we cannot ask that', () => {
    for (const p of ['identified', 'secured'] as const) {
      const copy = describePosture(p)
      expect(copy.detail).not.toMatch(/refuse|only run|reject|prevent/i)
    }
  })

  it('uses operator words, not MAVLink or firmware jargon', () => {
    for (const p of ['identified', 'secured', 'bootloader-outdated', 'unsecured'] as const) {
      const { label, detail } = describePosture(p)
      expect(`${label} ${detail}`).not.toMatch(/bootloader|GET_IDENTITY|SECURE_COMMAND|MAVLink|x25519/i)
    }
  })

  it('says nothing at all while the posture is unknown', () => {
    expect(describePosture('unknown')).toEqual({ locked: false, label: '', detail: '' })
  })
})
