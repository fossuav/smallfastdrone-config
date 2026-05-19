<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import logoUrl from './assets/sfd-logo.png'
import { routes } from './router'
import { useUiStore } from './stores/ui'
import MessageBell from './ui/components/MessageBell.vue'

const ui = useUiStore()

const navItems = computed(() =>
  routes
    .filter(r => r.meta?.label)
    .filter(r => !r.meta?.expert || ui.expert)
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
          <div class="flex items-center gap-6">
            <RouterLink to="/" class="flex items-center" aria-label="SmallFastDrone home">
              <img
                :src="logoUrl"
                alt="SmallFastDrone"
                class="h-10 w-auto dark:invert"
              >
            </RouterLink>
            <UNavigationMenu :items="navItems" />
          </div>

          <div class="flex items-center gap-3">
            <MessageBell />
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <span class="text-muted select-none">Expert</span>
              <USwitch v-model="ui.expert" color="secondary" />
            </label>
          </div>
        </div>
      </header>

      <main class="mx-auto w-full max-w-7xl flex-1 p-6">
        <RouterView />
      </main>
    </div>
  </UApp>
</template>
