<script setup lang="ts">
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-sliders-horizontal" class="size-6 text-primary" />
        <h1 class="text-xl text-highlighted font-semibold">
          Parameters
        </h1>
        <UBadge color="secondary" variant="subtle" size="sm">
          Expert
        </UBadge>
      </div>
    </template>

    <p class="text-muted">
      Browse and edit every parameter on the connected drone. This is the
      escape hatch for things the wizard and recipes don't cover — most
      operators won't need it.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
