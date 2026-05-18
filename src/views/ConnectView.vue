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

      <div v-if="session.connected" class="mt-4 text-center text-sm">
        <p class="text-highlighted font-medium">
          Connected via {{ session.transport.description }}
        </p>
        <p class="text-muted">
          {{ session.bytesReceived.toLocaleString() }} bytes received
        </p>
      </div>

      <div v-if="session.lastError" class="mt-4 text-center text-sm text-error">
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
        <p class="mt-2 text-center text-xs text-muted">
          Real-drone (USB) support arrives in a later slice. For now: start SITL and the bridge, then load this page with
          <code class="rounded bg-muted px-1 py-0.5">?transport=websocket&amp;host=localhost:5761</code>.
        </p>
      </template>
    </UCard>
  </div>
</template>
