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

// Reactive wrapper around the SFD enable ceremony for a view to drive:
// wires runEnableCeremony() (sfd-enable.ts, pure and unit-tested) to the
// connected session and exposes phase, failure and outcome as refs. Kept
// out of sfd-enable.ts because the session store cannot load in Vitest's
// node runtime. Downloading the identity file is the view's job — it
// needs a DOM anchor — and the outcome carries the text and filename
// ready for it.

import type { EnableFailure, EnableOutcome, EnablePhase } from './sfd-enable'
import { computed, ref } from 'vue'
import { SecureCommandClient } from '../protocol/secure-command'
import { useSessionStore } from '../stores/session'
import { EnableError, runEnableCeremony } from './sfd-enable'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id.
const COMP_ID_AUTOPILOT = 1

export function useSfdEnable() {
  const session = useSessionStore()

  const phase = ref<EnablePhase | 'idle' | 'error'>('idle')
  const error = ref<string | null>(null)
  const failure = ref<EnableFailure | null>(null)
  const outcome = ref<EnableOutcome | null>(null)
  const busy = computed(() => phase.value === 'checking' || phase.value === 'generating' || phase.value === 'verifying')

  function reset(): void {
    phase.value = 'idle'
    error.value = null
    failure.value = null
    outcome.value = null
  }

  // Run the ceremony against the connected drone. Resolves with the
  // outcome, or null after recording why it stopped in `error` /
  // `failure` — a view renders those rather than catching.
  async function run(): Promise<EnableOutcome | null> {
    if (busy.value)
      throw new Error('SFD enable is already running.')
    reset()
    if (!session.connected || session.sysid === null) {
      phase.value = 'error'
      failure.value = 'failed'
      error.value = 'Connect to your drone first.'
      return null
    }

    const client = new SecureCommandClient(
      session.sendMessage,
      session.subscribeMessages,
      session.sysid,
      COMP_ID_AUTOPILOT,
    )
    try {
      outcome.value = await runEnableCeremony(
        client,
        { boardId: session.boardId, fcUid: session.fcUid, now: () => new Date().toISOString() },
        (p) => { phase.value = p },
      )
      return outcome.value
    }
    catch (e) {
      phase.value = 'error'
      failure.value = e instanceof EnableError ? e.reason : 'failed'
      error.value = e instanceof Error ? e.message : String(e)
      return null
    }
  }

  return { phase, busy, error, failure, outcome, run, reset }
}
