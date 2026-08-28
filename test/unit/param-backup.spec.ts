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

// Unit tests for the settings-backup document. The round-trip is the
// contract that matters: a backup is the only thing standing between an
// operator and a mass-erased board during the SFD exit ceremony, so a
// value that changes shape on the way through — or a damaged file that
// parses as if it were fine — is the worst failure this module has.

import type { ParamRecord } from '../../src/protocol/params'
import type { BackupFilter, ParamBackupVehicle } from '../../src/workflow/param-backup'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_SCHEMA,
  backupFilename,
  backupParamCount,
  buildBackup,
  parseBackup,
  planRestore,
  serializeBackup,
} from '../../src/workflow/param-backup'

const CREATED_AT = '2026-08-28T14:05:09.123Z'

// Default filter for tests that aren't about filtering: treat every
// parameter as changed-from-default and none as read-only, so the
// document assertions below see exactly what they pass in.
const ALL: BackupFilter = { changed: new Set(), isReadOnly: () => false }
function keepAll(params: Map<string, ParamRecord>): BackupFilter {
  return { changed: new Set(params.keys()), isReadOnly: () => false }
}

const VEHICLE: ParamBackupVehicle = {
  sysid: 1,
  firmwareVersion: '4.7.0-beta',
  frameLabel: 'Quad X',
  uid: '3f0025000e51343233353132',
}

// MavParamType: 9 = REAL32, 2 = UINT8, 6 = UINT32.
function paramMap(entries: Array<[string, number, number]>): Map<string, ParamRecord> {
  const map = new Map<string, ParamRecord>()
  entries.forEach(([name, value, type], index) => {
    map.set(name, { name, value, type: type as ParamRecord['type'], index })
  })
  return map
}

const SAMPLE = paramMap([
  ['ATC_RAT_PIT_P', 0.135, 9],
  ['FRAME_CLASS', 1, 2],
  ['FRAME_TYPE', 1, 2],
  ['SERIAL3_BAUD', 230400, 6],
])

describe('buildBackup', () => {
  it('captures every parameter with its value and type', () => {
    const backup = buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE))

    expect(backupParamCount(backup)).toBe(4)
    expect(backup.params.ATC_RAT_PIT_P).toEqual({ value: 0.135, type: 9 })
    expect(backup.params.SERIAL3_BAUD).toEqual({ value: 230400, type: 6 })
    expect(backup.schema).toBe(BACKUP_SCHEMA)
    expect(backup.createdAt).toBe(CREATED_AT)
    expect(backup.vehicle).toEqual(VEHICLE)
  })

  it('sorts parameters by name so two backups diff cleanly', () => {
    const shuffled = paramMap([
      ['SERIAL3_BAUD', 230400, 6],
      ['ATC_RAT_PIT_P', 0.135, 9],
      ['FRAME_CLASS', 1, 2],
    ])

    expect(Object.keys(buildBackup(shuffled, VEHICLE, CREATED_AT, keepAll(shuffled)).params))
      .toEqual(['ATC_RAT_PIT_P', 'FRAME_CLASS', 'SERIAL3_BAUD'])
  })

  it('drops the parameter index, which is not stable across firmware builds', () => {
    const backup = buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE))

    expect(backup.params.FRAME_CLASS).not.toHaveProperty('index')
  })

  it('produces an empty document rather than throwing when nothing is loaded', () => {
    const backup = buildBackup(new Map(), VEHICLE, CREATED_AT, ALL)

    expect(backupParamCount(backup)).toBe(0)
  })
})

describe('filtering', () => {
  it('saves only parameters the drone reports as changed from default', () => {
    const filter: BackupFilter = {
      changed: new Set(['FRAME_TYPE', 'SERIAL3_BAUD']),
      isReadOnly: () => false,
    }

    expect(Object.keys(buildBackup(SAMPLE, VEHICLE, CREATED_AT, filter).params))
      .toEqual(['FRAME_TYPE', 'SERIAL3_BAUD'])
  })

  it('drops read-only parameters even when they read as changed', () => {
    const filter: BackupFilter = {
      changed: new Set(['FRAME_TYPE', 'SERIAL3_BAUD']),
      isReadOnly: name => name === 'SERIAL3_BAUD',
    }

    expect(Object.keys(buildBackup(SAMPLE, VEHICLE, CREATED_AT, filter).params))
      .toEqual(['FRAME_TYPE'])
  })

  it('saves nothing when the drone is entirely at its defaults', () => {
    const filter: BackupFilter = { changed: new Set(), isReadOnly: () => false }

    expect(backupParamCount(buildBackup(SAMPLE, VEHICLE, CREATED_AT, filter))).toBe(0)
  })
})

describe('round trip', () => {
  it('preserves every value through serialize and parse', () => {
    const backup = buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE))

    expect(parseBackup(serializeBackup(backup))).toEqual(backup)
  })

  it('preserves float precision', () => {
    const precise = paramMap([['INS_POS1_Z', -0.012345679, 9]])
    const restored = parseBackup(serializeBackup(buildBackup(precise, VEHICLE, CREATED_AT, keepAll(precise))))

    expect(restored.params.INS_POS1_Z!.value).toBe(-0.012345679)
  })

  it('preserves negative and zero values', () => {
    const edge = paramMap([
      ['SERIAL5_PROTOCOL', -1, 9],
      ['SCR_ENABLE', 0, 2],
    ])
    const restored = parseBackup(serializeBackup(buildBackup(edge, VEHICLE, CREATED_AT, keepAll(edge))))

    expect(restored.params.SERIAL5_PROTOCOL!.value).toBe(-1)
    expect(restored.params.SCR_ENABLE!.value).toBe(0)
  })

  it('writes indented JSON with a trailing newline', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))

    expect(text).toContain('\n  "schema"')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('parseBackup rejects', () => {
  it('a file that is not JSON', () => {
    expect(() => parseBackup('not json at all')).toThrow(/isn't a settings backup/)
  })

  it('json that is not an object', () => {
    expect(() => parseBackup('[1, 2, 3]')).toThrow(/isn't a settings backup/)
  })

  it('an unrelated JSON document', () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/isn't a settings backup/)
  })

  it('a backup from a newer schema, naming the reason', () => {
    const future = JSON.stringify({ schema: 'sfd-param-backup/2', params: {} })

    expect(() => parseBackup(future)).toThrow(/newer version of this tool/)
  })

  it('a backup with no save date', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    delete damaged.createdAt

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/no save date/)
  })

  it('a backup with no vehicle block', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    delete damaged.vehicle

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/which drone it came from/)
  })

  it('a backup with no params block', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    delete damaged.params

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/no settings in it/)
  })

  it('an entry whose value is not a number, naming the setting', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    damaged.params.FRAME_CLASS = { value: 'one', type: 2 }

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/"FRAME_CLASS" is unreadable/)
  })

  it('an entry with no type', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    damaged.params.FRAME_TYPE = { value: 1 }

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/"FRAME_TYPE" is unreadable/)
  })

  it('a non-finite value that JSON round-tripped to null', () => {
    const text = serializeBackup(buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE)))
    const damaged = JSON.parse(text)
    damaged.params.ATC_RAT_PIT_P = { value: null, type: 9 }

    expect(() => parseBackup(JSON.stringify(damaged))).toThrow(/"ATC_RAT_PIT_P" is unreadable/)
  })
})

describe('parseBackup tolerates', () => {
  it('missing optional vehicle detail, filling it with null', () => {
    const minimal = JSON.stringify({
      schema: BACKUP_SCHEMA,
      createdAt: CREATED_AT,
      vehicle: { sysid: 1 },
      params: { FRAME_CLASS: { value: 1, type: 2 } },
    })

    expect(parseBackup(minimal).vehicle).toEqual({
      sysid: 1,
      firmwareVersion: null,
      frameLabel: null,
      uid: null,
    })
  })
})

describe('backupFilename', () => {
  it('is date-stamped to the minute and sorts chronologically', () => {
    const backup = buildBackup(SAMPLE, VEHICLE, CREATED_AT, keepAll(SAMPLE))

    expect(backupFilename(backup)).toBe('smallfastdrone-settings-2026-08-28-1405.json')
  })

  it('orders lexically by time of day', () => {
    const morning = backupFilename(buildBackup(SAMPLE, VEHICLE, '2026-08-28T09:00:00.000Z', keepAll(SAMPLE)))
    const evening = backupFilename(buildBackup(SAMPLE, VEHICLE, '2026-08-28T21:30:00.000Z', keepAll(SAMPLE)))

    expect([evening, morning].sort()).toEqual([morning, evening])
  })
})

describe('planRestore', () => {
  const live = paramMap([
    ['ATC_RAT_PIT_P', 0.135, 9],
    ['FRAME_CLASS', 1, 2],
    ['FRAME_TYPE', 12, 2],
    ['SERIAL3_BAUD', 57600, 6],
  ])

  function backupOf(entries: Array<[string, number, number]>) {
    const map = paramMap(entries)
    return buildBackup(map, VEHICLE, CREATED_AT, keepAll(map))
  }

  it('writes only the parameters whose value differs', () => {
    const plan = planRestore(
      backupOf([['FRAME_TYPE', 1, 2], ['FRAME_CLASS', 1, 2]]),
      live,
      { changed: new Set(), isReadOnly: () => false },
    )

    expect(plan.toWrite.map(i => i.name)).toEqual(['FRAME_TYPE'])
    expect(plan.unchanged.map(i => i.name)).toEqual(['FRAME_CLASS'])
  })

  it('carries the drone\'s type for the write, not the backup\'s', () => {
    const plan = planRestore(
      backupOf([['SERIAL3_BAUD', 230400, 99]]),
      live,
      { changed: new Set(), isReadOnly: () => false },
    )

    expect(plan.toWrite[0]).toMatchObject({ name: 'SERIAL3_BAUD', type: 6, backupValue: 230400 })
  })

  it('reports parameters this firmware no longer has', () => {
    const plan = planRestore(
      backupOf([['GONE_PARAM', 5, 2]]),
      live,
      { changed: new Set(), isReadOnly: () => false },
    )

    expect(plan.missing.map(i => i.name)).toEqual(['GONE_PARAM'])
    expect(plan.missing[0]!.currentValue).toBeNull()
    expect(plan.toWrite).toHaveLength(0)
  })

  it('refuses to write parameters that are read-only on this drone', () => {
    const plan = planRestore(
      backupOf([['FRAME_TYPE', 1, 2]]),
      live,
      { changed: new Set(), isReadOnly: name => name === 'FRAME_TYPE' },
    )

    expect(plan.readOnly.map(i => i.name)).toEqual(['FRAME_TYPE'])
    expect(plan.toWrite).toHaveLength(0)
  })

  it('treats an integer that round-tripped through a float as unchanged', () => {
    const drifted = paramMap([['FRAME_TYPE', 12.0000000001, 2]])
    const plan = planRestore(
      backupOf([['FRAME_TYPE', 12, 2]]),
      drifted,
      { changed: new Set(), isReadOnly: () => false },
    )

    expect(plan.unchanged.map(i => i.name)).toEqual(['FRAME_TYPE'])
  })

  it('warns about drone changes the backup cannot revert', () => {
    // SERIAL3_BAUD was changed on the drone after the backup was taken,
    // so the backup has no saved value to put it back to.
    const plan = planRestore(
      backupOf([['FRAME_TYPE', 1, 2]]),
      live,
      { changed: new Set(['FRAME_TYPE', 'SERIAL3_BAUD']), isReadOnly: () => false },
    )

    expect(plan.notReverted).toEqual(['SERIAL3_BAUD'])
  })

  it('does not warn about read-only drone changes, which were never restorable', () => {
    const plan = planRestore(
      backupOf([['FRAME_TYPE', 1, 2]]),
      live,
      { changed: new Set(['FRAME_TYPE', 'SERIAL3_BAUD']), isReadOnly: n => n === 'SERIAL3_BAUD' },
    )

    expect(plan.notReverted).toEqual([])
  })

  it('lists every saved parameter exactly once, sorted', () => {
    const plan = planRestore(
      backupOf([['SERIAL3_BAUD', 1, 6], ['ATC_RAT_PIT_P', 9, 9], ['FRAME_CLASS', 1, 2]]),
      live,
      { changed: new Set(), isReadOnly: () => false },
    )

    expect(plan.items.map(i => i.name)).toEqual(['ATC_RAT_PIT_P', 'FRAME_CLASS', 'SERIAL3_BAUD'])
    expect(plan.toWrite.length + plan.unchanged.length + plan.missing.length + plan.readOnly.length)
      .toBe(plan.items.length)
  })

  it('plans nothing from an empty backup', () => {
    const plan = planRestore(backupOf([]), live, { changed: new Set(), isReadOnly: () => false })

    expect(plan.items).toHaveLength(0)
    expect(plan.toWrite).toHaveLength(0)
  })
})
