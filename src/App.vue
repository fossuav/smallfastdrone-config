<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { routes } from './router'

const navItems = computed(() =>
  routes
    .filter(r => r.meta?.label)
    .map(r => ({
      label: r.meta!.label as string,
      icon: r.meta!.icon as string,
      to: r.path,
    })),
)
</script>

<template>
  <UApp>
    <div class="min-h-dvh flex flex-col bg-default">
      <header class="border-b border-default bg-elevated">
        <div class="mx-auto max-w-7xl flex items-center justify-between gap-6 px-4 py-3">
          <RouterLink to="/" class="text-lg text-highlighted font-semibold">
            SFD Config
          </RouterLink>
          <UNavigationMenu :items="navItems" />
        </div>
      </header>

      <main class="mx-auto w-full max-w-7xl flex-1 p-6">
        <RouterView />
      </main>
    </div>
  </UApp>
</template>
