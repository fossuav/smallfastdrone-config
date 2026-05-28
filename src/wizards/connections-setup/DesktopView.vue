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

// Connections setup wizard — operator-facing view. Slice 1 shipped the
// overview table (read @SYS/uarts.txt + SERIALn_PROTOCOL/_BAUD, render
// Betaflight-Ports-style). Slice 2 adds the "Check what's plugged in"
// flow: sample byte counters across a 4 s window, classify each port,
// render green/yellow/red findings beside the existing rows. Slice 3
// will add per-row inline editing. The table itself is the same
// component the bringup ribbon's Connections tab renders so both
// surfaces stay identical.
//
// Bringup-launched wizards honour ?returnTo=. See docs/WIZARDS.md.

import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import ConnectionsTable from '../../ui/components/ConnectionsTable.vue'
import { useConnections } from '../../workflow/connections'

// The bringup ribbon's panel already renders the live port table; when
// embedded there, this view skips it so the table doesn't appear twice
// and falls back to the action buttons only (mirrors motor-check's
// `skipEsc` pattern).
const props = defineProps<{ skipOverview?: boolean }>()

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()
const { rows, loading, error, refresh, detect, detectPhase, progress, findings } = useConnections()

const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

onMounted(() => {
  if (!props.skipOverview)
    void refresh()
})

function finish() {
  wizardProgress.markComplete(session.fcUid, 'connections-setup', 'Each port on your drone knows what\'s plugged into it.')
  router.push(returnTo.value)
}

function cancel() {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <ConnectionsTable
      v-if="!props.skipOverview"
      :rows="rows"
      :loading="loading"
      :error="error"
      :findings="findings"
      :detect-phase="detectPhase"
      :progress="progress"
      @refresh="refresh"
      @detect="detect"
    />

    <p v-if="props.skipOverview" class="text-muted text-sm">
      Once each port is set up the way you want, mark this step done to move
      on. Editing protocols inline lands in the next slice — for now, use the
      Parameters page in expert mode to change them.
    </p>

    <div class="flex justify-end gap-2 pt-2">
      <UButton color="neutral" variant="ghost" @click="cancel">
        Back
      </UButton>
      <UButton color="primary" @click="finish">
        Done
      </UButton>
    </div>
  </div>
</template>
