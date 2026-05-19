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

// Per-FC wizard completion tracking. When a wizard finishes
// successfully it records a CompletionRecord against the connected
// FC's uid; the library view reads this to show a green-tick "Done"
// badge + the specific outcome the operator achieved.
//
// Backed by useLocalStorage so completions survive page reload and
// disconnect/reconnect of the same drone. Keyed by `${fcUid}_${wizardId}`
// internally — switching to a different drone shows that drone's own
// completion history, not the previous one's.
//
// Slice A scope: completion records only. Full wizard-state persistence
// (current step, param snapshots, resume support) is Phase 2 slice B,
// when it lands the storage format here grows from CompletionRecord to
// a richer shape. The localStorage backing will move to IndexedDB at
// the same time, since IndexedDB is required for the larger payloads.

import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

// One record per (fcUid, wizardId). Outcome is the wizard's own
// human-readable summary of what it did (e.g. "Set as a Quad X"),
// distinct from the manifest's prospective `outcome` field which
// describes what the wizard *will* do.
export interface CompletionRecord {
  completedAt: number
  outcome: string
}

// Nested map: fcUid → wizardId → record. JSON-serialisable so it
// round-trips through localStorage without custom replacers.
type ProgressMap = Record<string, Record<string, CompletionRecord>>

export const useWizardProgressStore = defineStore('wizardProgress', () => {
  const progress = useLocalStorage<ProgressMap>('sfd-config:wizard-progress', {})

  // True if the given wizard has been completed on the given FC. Returns
  // false when fcUid is null (we haven't received AUTOPILOT_VERSION yet)
  // so the library doesn't flash stale badges from another drone.
  function isCompleted(fcUid: string | null, wizardId: string): boolean {
    if (!fcUid)
      return false
    return progress.value[fcUid]?.[wizardId] !== undefined
  }

  // Fetch the completion record (or undefined) for one (FC, wizard)
  // pair. The library uses this to render the outcome text + relative
  // timestamp on completed cards.
  function getCompletion(fcUid: string | null, wizardId: string): CompletionRecord | undefined {
    if (!fcUid)
      return undefined
    return progress.value[fcUid]?.[wizardId]
  }

  // Record a successful wizard run. The wizard supplies its own
  // human-readable outcome — typically more specific than the manifest
  // outcome (e.g. "Set as a Hex X" rather than "Your drone knows its
  // motor layout"). No-op when fcUid is null.
  function markComplete(fcUid: string | null, wizardId: string, outcome: string): void {
    if (!fcUid)
      return
    if (!progress.value[fcUid])
      progress.value[fcUid] = {}
    progress.value[fcUid][wizardId] = {
      completedAt: Date.now(),
      outcome,
    }
  }

  // Forget a completion. Slice A doesn't surface this in the UI, but
  // it's wired so a future "re-run from scratch" affordance has a clean
  // API to call.
  function clear(fcUid: string | null, wizardId: string): void {
    if (!fcUid)
      return
    delete progress.value[fcUid]?.[wizardId]
  }

  return { isCompleted, getCompletion, markComplete, clear }
})
