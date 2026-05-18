<script setup lang="ts">
import logoUrl from './assets/sfd-logo.png'
</script>

<template>
  <UApp>
    <main class="min-h-dvh flex items-center justify-center bg-default p-6">
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

        <template #footer>
          <UButton color="primary" disabled block>
            Connect drone
          </UButton>
          <p class="mt-2 text-center text-xs text-muted">
            Coming soon — connect support lands in a later slice.
          </p>
        </template>
      </UCard>
    </main>
  </UApp>
</template>
