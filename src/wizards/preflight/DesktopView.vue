<script setup lang="ts">
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

// Pre-flight check wizard. No FC writes — surfaces the drone's
// identity (vehicle, autopilot, firmware, FC uid) and the SYS_STATUS
// subsystem readiness row so the operator can look it over before
// bringup starts changing settings. "Looks good" records completion;
// the back affordance returns to wherever the wizard was launched
// from (library or bringup meta-wizard via returnTo).

import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import SystemStatus from '../../ui/components/SystemStatus.vue'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()

// Where to navigate back to on Confirm or Cancel. Defaults to the
// library; bringup passes returnTo=/wizard/bringup so the operator
// flows back into the meta-wizard mid-bringup.
const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

// Truncate the FC uid for display — the full hex is unambiguous but
// noisy in a sidebar. Operators don't need to recognise the value,
// just see that it's been received and (across reconnects) that it
// stayed the same.
const shortFcUid = computed(() => {
  if (!session.fcUid)
    return 'Waiting for it…'
  if (session.fcUid.length <= 16)
    return session.fcUid
  return `${session.fcUid.slice(0, 16)}…`
})

// Operator confirmed the basics look right — record completion and
// return to whatever sent us here.
function confirm() {
  wizardProgress.markComplete(session.fcUid, 'preflight', 'Pre-flight check passed')
  router.push(returnTo.value)
}

// Operator backed out without confirming — no completion recorded.
function cancel() {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-muted">
      Look these over. If anything's missing or red, sort it before we change
      any settings — for instance, a failing barometer wants a fix, not a
      configuration on top.
    </p>

    <dl class="border-default grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-elevated/50 p-3 text-sm">
      <dt class="text-muted">
        Vehicle:
      </dt>
      <dd class="text-default">
        {{ session.vehicleLabel ?? 'Unknown' }}
      </dd>
      <dt class="text-muted">
        Autopilot:
      </dt>
      <dd class="text-default">
        {{ session.autopilotLabelText ?? 'Unknown' }}
        <span v-if="session.firmwareVersion" class="text-muted">{{ session.firmwareVersion }}</span>
      </dd>
      <dt class="text-muted">
        State:
      </dt>
      <dd class="text-default">
        {{ session.systemStatusText ?? 'Unknown' }}
      </dd>
      <dt class="text-muted">
        FC ID:
      </dt>
      <dd class="text-default font-mono text-xs">
        {{ shortFcUid }}
      </dd>
    </dl>

    <div class="border-default border-t pt-3">
      <SystemStatus />
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <UButton color="neutral" variant="ghost" @click="cancel">
        Cancel
      </UButton>
      <UButton color="primary" @click="confirm">
        Looks good — continue
      </UButton>
    </div>
  </div>
</template>
