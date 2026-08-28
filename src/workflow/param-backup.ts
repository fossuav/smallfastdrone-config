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

// Serialise the operator's configuration to a settings-backup document,
// and read one back. Pure — no store, no Vue, no browser API — so it runs
// in Vitest's node runtime; SettingsView wires it to the params store, the
// packed-param file (src/protocol/param-pack.ts, which supplies the
// changed-from-default set) and the browser's download path.
//
// A backup is useful on its own ("save your drone's settings before you
// change something"), and it is a hard prerequisite for the SFD exit
// ceremony in docs/SECURITY.md, where lowering readout protection
// mass-erases the board: the operator's parameters have to survive that in
// a file, because nothing survives it on the drone.
//
// Restore planning — the diff against a freshly-flashed FC and the report
// of what didn't survive — is deliberately not here yet; it lands with the
// restore slice.

import type { ParamRecord } from '../protocol/params'

// Bumped only when the document shape changes incompatibly. parseBackup
// refuses anything it doesn't recognise rather than guessing, because a
// half-understood backup restored onto a drone is worse than no backup.
export const BACKUP_SCHEMA = 'sfd-param-backup/1'

// What the drone was when the snapshot was taken. Every field is present
// in the JSON (null rather than absent) so a reader never has to
// distinguish "missing" from "unknown". None of it is needed to restore —
// it's here so an operator staring at three backup files can tell which
// drone and which firmware each one came from.
export interface ParamBackupVehicle {
  sysid: number
  // Operator-facing firmware string, e.g. "4.7.0-beta". Not parsed on
  // restore; shown so the operator can see what changed underneath them.
  firmwareVersion: string | null
  // Operator-facing frame description, e.g. "Quad X".
  frameLabel: string | null
  // STM32 unique id, hex. Pairs a backup to one airframe — the exit
  // ceremony restores onto the same board it wiped, and this is how the
  // tool can warn when it isn't.
  uid: string | null
}

export interface ParamBackupEntry {
  value: number
  // MavParamType as the FC reported it. Kept because PARAM_SET needs a
  // type, but the FC is truth on restore: if a firmware changed a param's
  // type, the live type wins and this is only a record of what it was.
  type: number
}

export interface ParamBackup {
  schema: typeof BACKUP_SCHEMA
  // ISO 8601, supplied by the caller so this module stays pure.
  createdAt: string
  vehicle: ParamBackupVehicle
  params: Record<string, ParamBackupEntry>
}

// What to leave out of a backup. Both halves come from outside so this
// module stays pure: `changed` from the drone itself (the packed-param
// file names every parameter that differs from the firmware's own
// board- and frame-specific default), `isReadOnly` from the static
// parameter metadata.
export interface BackupFilter {
  changed: Set<string>
  isReadOnly: (name: string) => boolean
}

// Snapshot the operator's configuration into a backup document.
//
// A backup holds the *delta*, not the whole parameter set: only the
// parameters the drone reports as changed from its factory default, minus
// the read-only ones. That delta is the configuration — it is what
// restores cleanly onto freshly-flashed firmware, which boots at defaults,
// and it keeps a backup in the tens of entries rather than the ~1400 a
// full dump would carry.
//
// The cost is real and worth stating: a parameter sitting at its default
// when the backup was taken isn't recorded, so restoring onto a *live*
// drone cannot revert a later change to it. Restore planning is where that
// gets surfaced to the operator, not hidden.
//
// Parameter *index* is deliberately dropped: indexes shift between
// firmware builds, so name is the only stable key.
export function buildBackup(
  params: Map<string, ParamRecord>,
  vehicle: ParamBackupVehicle,
  createdAt: string,
  filter: BackupFilter,
): ParamBackup {
  const out: Record<string, ParamBackupEntry> = {}
  for (const name of [...params.keys()].sort()) {
    if (!filter.changed.has(name) || filter.isReadOnly(name))
      continue
    const record = params.get(name)!
    out[name] = { value: record.value, type: record.type }
  }
  return { schema: BACKUP_SCHEMA, createdAt, vehicle, params: out }
}

// Render a backup as the JSON that lands on disk. Indented and
// key-sorted (buildBackup already sorted the params) so two backups of the
// same drone diff cleanly in any text tool — an operator comparing
// before/after is a real workflow, and a one-line blob defeats it.
export function serializeBackup(backup: ParamBackup): string {
  return `${JSON.stringify(backup, null, 2)}\n`
}

// Read a backup document back, with errors an operator can act on.
//
// Throws rather than returning null: every caller has to stop and tell the
// operator what's wrong with the file they picked, so there is no useful
// "just carry on" path. Messages name the problem in plain language
// because they go straight to the screen.
export function parseBackup(text: string): ParamBackup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    throw new Error('That file isn\'t a settings backup — it isn\'t readable as one.')
  }

  if (!isRecord(raw))
    throw new Error('That file isn\'t a settings backup.')

  if (raw.schema !== BACKUP_SCHEMA) {
    // A file that says it's a backup but from a shape we don't know is
    // more dangerous than an unrelated file: don't try to salvage it.
    throw new Error(
      typeof raw.schema === 'string' && raw.schema.startsWith('sfd-param-backup/')
        ? 'That backup was saved by a newer version of this tool.'
        : 'That file isn\'t a settings backup.',
    )
  }

  if (typeof raw.createdAt !== 'string')
    throw new Error('That backup is damaged — it has no save date.')

  const v = raw.vehicle
  if (!isRecord(v) || typeof v.sysid !== 'number')
    throw new Error('That backup is damaged — it doesn\'t say which drone it came from.')

  if (!isRecord(raw.params))
    throw new Error('That backup is damaged — it has no settings in it.')

  const params: Record<string, ParamBackupEntry> = {}
  for (const [name, entry] of Object.entries(raw.params)) {
    if (!isRecord(entry) || typeof entry.value !== 'number' || typeof entry.type !== 'number')
      throw new Error(`That backup is damaged — the setting "${name}" is unreadable.`)
    if (!Number.isFinite(entry.value))
      throw new Error(`That backup is damaged — the setting "${name}" has no usable value.`)
    params[name] = { value: entry.value, type: entry.type }
  }

  return {
    schema: BACKUP_SCHEMA,
    createdAt: raw.createdAt,
    vehicle: {
      sysid: v.sysid,
      firmwareVersion: typeof v.firmwareVersion === 'string' ? v.firmwareVersion : null,
      frameLabel: typeof v.frameLabel === 'string' ? v.frameLabel : null,
      uid: typeof v.uid === 'string' ? v.uid : null,
    },
    params,
  }
}

// What restoring one saved parameter would do to the connected drone.
//
//   write      — the drone has it and holds a different value
//   unchanged  — the drone already matches; nothing to do
//   missing    — the drone's firmware doesn't have this parameter at all
//   readOnly   — the drone has it but won't accept a write
export type RestoreAction = 'write' | 'unchanged' | 'missing' | 'readOnly'

export interface RestoreItem {
  name: string
  backupValue: number
  // What the drone holds now; null when the parameter isn't on this
  // firmware.
  currentValue: number | null
  // The drone's type for this parameter, used for the write. The FC is
  // truth: if a firmware changed a parameter's type, the backup's record
  // of the old type is history, not instruction.
  type: number | null
  action: RestoreAction
}

export interface RestorePlan {
  items: RestoreItem[]
  toWrite: RestoreItem[]
  unchanged: RestoreItem[]
  missing: RestoreItem[]
  readOnly: RestoreItem[]
  // Parameters the drone currently holds away from its factory default
  // that the backup has nothing to say about. Restoring will NOT put
  // these back — a backup records only what had been changed when it was
  // taken, so a setting altered afterwards has no saved value to return
  // to. This is the honest cost of a delta backup and the operator is
  // told, not left to find out.
  notReverted: string[]
}

// Almost-equal threshold for parameter comparison. Integer parameters
// travel as floats through PARAM_VALUE, so an exact === would report
// spurious differences on the round trip. Mirrors the epsilon the params
// store applies to write acknowledgements; duplicated rather than
// imported so this module stays free of the Pinia/Vue graph.
const VALUE_EQ_EPS = 1e-6

function valuesMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= VALUE_EQ_EPS * Math.max(1, Math.abs(a))
}

// Work out what restoring a backup onto the connected drone would change,
// and what it can't. `current` is the drone's live parameter map;
// `filter.changed` names the parameters the drone reports as away from its
// factory defaults, which is what makes the notReverted report possible.
//
// Nothing is written here — this is the plan the operator confirms.
export function planRestore(
  backup: ParamBackup,
  current: Map<string, ParamRecord>,
  filter: BackupFilter,
): RestorePlan {
  const items: RestoreItem[] = []

  for (const name of Object.keys(backup.params).sort()) {
    const saved = backup.params[name]!
    const live = current.get(name)

    if (live === undefined) {
      items.push({ name, backupValue: saved.value, currentValue: null, type: null, action: 'missing' })
      continue
    }
    if (filter.isReadOnly(name)) {
      items.push({ name, backupValue: saved.value, currentValue: live.value, type: live.type, action: 'readOnly' })
      continue
    }
    items.push({
      name,
      backupValue: saved.value,
      currentValue: live.value,
      type: live.type,
      action: valuesMatch(saved.value, live.value) ? 'unchanged' : 'write',
    })
  }

  const saved = new Set(Object.keys(backup.params))
  const notReverted = [...filter.changed]
    .filter(name => !saved.has(name) && !filter.isReadOnly(name))
    .sort()

  return {
    items,
    toWrite: items.filter(i => i.action === 'write'),
    unchanged: items.filter(i => i.action === 'unchanged'),
    missing: items.filter(i => i.action === 'missing'),
    readOnly: items.filter(i => i.action === 'readOnly'),
    notReverted,
  }
}

// How many settings a backup holds — what the operator sees on screen
// ("482 settings saved"), and the one number that makes an empty or
// truncated backup obvious at a glance.
export function backupParamCount(backup: ParamBackup): number {
  return Object.keys(backup.params).length
}

// Filename for a saved backup. Date-stamped and sortable so a folder of
// them reads chronologically, and prefixed so it's recognisable among a
// download folder full of unrelated files.
export function backupFilename(backup: ParamBackup): string {
  // Trim the ISO string to minutes and strip the separators that are
  // awkward in filenames: 2026-08-28T14:05:09.123Z → 2026-08-28-1405.
  const stamp = backup.createdAt.slice(0, 16).replace('T', '-').replace(':', '')
  return `smallfastdrone-settings-${stamp}.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
