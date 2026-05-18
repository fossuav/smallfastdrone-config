<script setup lang="ts">
</script>

<template>
  <UApp>
    <main class="min-h-dvh flex items-center justify-center bg-default p-6">
      <UCard class="w-full max-w-md">
        <template #header>
          <h1 class="text-xl font-semibold text-highlighted">
            SmallFastDrone Config
          </h1>
        </template>

        <p class="text-muted">
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
