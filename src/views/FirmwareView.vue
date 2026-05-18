<script setup lang="ts">
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-cpu" class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Firmware
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Flash SmallFastDrone firmware to a flight controller in DFU mode. Pick a
      release, verify the signature, watch it land on your drone.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
