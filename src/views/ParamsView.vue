<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatParamValue, getParamMeta } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const store = useParamsStore()

const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toUpperCase()
  if (!q)
    return store.sortedList
  return store.sortedList.filter(p => p.name.includes(q))
})

const progressPct = computed(() => {
  if (!store.progress || store.progress.total === 0)
    return 0
  return Math.min(100, Math.round((store.progress.received / store.progress.total) * 100))
})

// Compose a one-line description for the table: displayName, then a fallback
// to the first sentence of the long description. Full description lands in
// a title attribute so hover shows it.
interface RowMeta {
  short: string
  full: string
  units: string
}
function meta(name: string): RowMeta {
  const m = getParamMeta(name)
  if (!m)
    return { short: '', full: '', units: '' }
  const short = m.displayName ?? (m.description ? firstSentence(m.description) : '')
  const full = m.description ?? m.displayName ?? ''
  return { short, full, units: m.units ?? '' }
}
function firstSentence(s: string): string {
  const i = s.search(/[.!?](\s|$)/)
  return i === -1 ? s : s.slice(0, i + 1)
}

onMounted(() => {
  if (session.connected && session.hasHeartbeat && store.count === 0 && !store.loading) {
    store.load()
  }
})
</script>

<template>
  <UCard class="mx-auto w-full max-w-6xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-sliders-horizontal" class="size-6 text-primary" />
        <h1 class="text-xl text-highlighted font-semibold">
          Parameters
        </h1>
        <UBadge color="secondary" variant="subtle" size="sm">
          Expert
        </UBadge>
        <div class="ml-auto flex items-center gap-2">
          <UButton
            icon="i-lucide-refresh-cw"
            variant="soft"
            size="sm"
            :loading="store.loading"
            :disabled="!session.connected || !session.hasHeartbeat"
            @click="store.load()"
          >
            {{ store.count > 0 ? 'Refresh' : 'Load' }}
          </UButton>
        </div>
      </div>
    </template>

    <!-- Disconnected -->
    <div v-if="!session.connected" class="text-muted py-8 text-center text-sm">
      Connect to a drone first to browse its parameters.
    </div>

    <!-- Loading -->
    <div v-else-if="store.loading" class="py-6 text-center text-sm">
      <p class="text-muted">
        Fetching parameters from your drone…
      </p>
      <div v-if="store.progress" class="mx-auto mt-3 max-w-md">
        <UProgress :value="progressPct" :max="100" color="primary" />
        <p class="text-muted mt-1 text-xs">
          {{ store.progress.received }} / {{ store.progress.total }}
        </p>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="store.error" class="text-error py-6 text-center text-sm">
      {{ store.error }}
    </div>

    <!-- Loaded -->
    <div v-else-if="store.count > 0" class="space-y-3">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Filter by name (e.g. ATC, INS_HNTCH, RTL)"
        size="md"
        autofocus
      />

      <p class="text-muted text-xs">
        {{ filtered.length.toLocaleString() }} of {{ store.count.toLocaleString() }} parameters
      </p>

      <div class="border-default max-h-[70vh] overflow-y-auto rounded-md border">
        <table class="w-full text-left text-sm">
          <thead class="bg-elevated text-muted sticky top-0 text-xs uppercase">
            <tr>
              <th class="w-[22%] px-3 py-2 font-medium">
                Name
              </th>
              <th class="w-[12%] px-3 py-2 text-right font-medium">
                Value
              </th>
              <th class="px-3 py-2 font-medium">
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filtered"
              :key="p.name"
              class="border-default border-t"
              :title="meta(p.name).full || undefined"
            >
              <td class="text-highlighted px-3 py-1.5 font-mono text-xs whitespace-nowrap">
                {{ p.name }}
              </td>
              <td class="text-default px-3 py-1.5 text-right font-mono text-xs whitespace-nowrap">
                {{ formatParamValue(p.value, p.type) }}<span v-if="meta(p.name).units" class="text-muted ml-1">{{ meta(p.name).units }}</span>
              </td>
              <td class="text-muted px-3 py-1.5 text-xs">
                {{ meta(p.name).short || '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </UCard>
</template>
