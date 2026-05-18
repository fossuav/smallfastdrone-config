<script setup lang="ts">
import { computed } from 'vue'
import logoUrl from '../assets/sfd-logo.png'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()

const buttonLabel = computed(() => {
  if (session.connecting)
    return 'Connecting…'
  if (session.connected)
    return 'Disconnect'
  return 'Connect drone'
})

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
        <img
          :src="logoUrl"
          alt="SmallFastDrone"
          class="mx-auto h-20 w-auto dark:invert"
        >
      </template>

      <p class="text-center text-muted">
        Get your drone configured and flying well — fast, and safely.
      </p>

      <!-- Connected, with a heartbeat: we know what the drone is. -->
      <div v-if="session.connected && session.hasHeartbeat" class="mt-4 text-center text-sm">
        <p class="text-highlighted text-base font-medium">
          Connected to your {{ session.vehicleLabel }}
        </p>
        <dl class="mt-2 inline-grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-left text-xs text-muted">
          <dt>Autopilot:</dt><dd class="text-default">
            {{ session.autopilotLabelText }}<template v-if="session.firmwareVersion">
              {{ session.firmwareVersion }}
            </template>
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
          Real-drone (USB) support arrives in a later slice. For now: start SITL and the bridge, then load this page with
          <code class="bg-muted rounded px-1 py-0.5">?transport=websocket&amp;host=localhost:5761</code>.
        </p>
      </template>
    </UCard>
  </div>
</template>
