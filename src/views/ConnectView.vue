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

// Connect view — the operator's landing screen. Renders a hero card with
// the rotating drone, a Connect/Disconnect action, and (once a heartbeat
// arrives) the parsed vehicle line, firmware string, and the system
// status panel of subsystem readiness icons. All state comes from the
// session store; this view contains no protocol or transport logic.

import { computed } from 'vue'
import { useSessionStore } from '../stores/session'
import SystemStatus from '../ui/components/SystemStatus.vue'
import Drone3D from '../ui/visuals/Drone3D.vue'

const session = useSessionStore()

const buttonLabel = computed(() => {
  if (session.connecting)
    return 'Connecting…'
  if (session.connected)
    return 'Disconnect'
  return 'Connect drone'
})

// Combine in JS rather than via a Vue `<template>` between interpolations —
// the latter drops the separating whitespace once the linter reformats it.
const autopilotLine = computed(() => {
  const base = session.autopilotLabelText
  if (!base)
    return ''
  return session.firmwareVersion ? `${base} ${session.firmwareVersion}` : base
})

// Click handler for the single Connect / Disconnect button — the
// session store handles the connecting / connected state machine.
function toggle() {
  if (session.connected)
    session.disconnect()
  else session.connect()
}
</script>

<template>
  <div class="flex items-center justify-center py-12">
    <UCard class="w-full max-w-md">
      <template #header>
        <!-- Hero visual: gentle X-quad rotation. The fixed-height wrapper
             gives the WebGL canvas something to fill; if WebGL fails the
             div is just empty space and the rest of the card still works. -->
        <div class="mx-auto h-40 w-full max-w-xs">
          <Drone3D />
        </div>
      </template>

      <p class="text-center text-muted">
        Get your drone configured and flying well — fast, and safely.
      </p>

      <!-- Connected, with a heartbeat: we know what the drone is. -->
      <div v-if="session.connected && session.hasHeartbeat" class="mt-4 space-y-4 text-center text-sm">
        <div>
          <p class="text-highlighted text-base font-medium">
            Connected to your {{ session.vehicleLabel }}
          </p>
          <dl class="mt-2 inline-grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-left text-xs text-muted">
            <dt>Autopilot:</dt><dd class="text-default">
              {{ autopilotLine }}
            </dd>
            <dt>System ID:</dt><dd class="text-default">
              {{ session.sysid }}
            </dd>
            <dt>State:</dt><dd class="text-default">
              {{ session.systemStatusText }}
            </dd>
            <dt>Link:</dt><dd class="text-default">
              {{ session.bytesReceived.toLocaleString() }} bytes
            </dd>
          </dl>
        </div>
        <div class="border-default border-t pt-3">
          <SystemStatus />
        </div>
      </div>

      <!-- Connected, no heartbeat yet: link is up but the drone hasn't said hi. -->
      <div v-else-if="session.connected" class="mt-4 text-center text-sm">
        <p class="text-default">
          Connected. Waiting for your drone to say hello…
        </p>
        <p class="text-muted">
          {{ session.bytesReceived.toLocaleString() }} bytes received
        </p>
      </div>

      <div v-if="session.lastError" class="text-error mt-4 text-center text-sm">
        {{ session.lastError }}
      </div>

      <template #footer>
        <UButton
          color="primary"
          block
          :loading="session.connecting"
          @click="toggle"
        >
          {{ buttonLabel }}
        </UButton>
        <p class="text-muted mt-2 text-center text-xs">
          Plug your drone in via USB and click <em>Connect drone</em>. For SITL testing, load this page with
          <code class="bg-muted rounded px-1 py-0.5">?transport=websocket&amp;host=localhost:5761</code> instead.
        </p>
      </template>
    </UCard>
  </div>
</template>
