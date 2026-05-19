<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { formatParamValue, getParamMeta } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const store = useParamsStore()

const search = ref('')
const showOnlyChanged = ref(false)

const filtered = computed(() => {
  const base = showOnlyChanged.value ? store.dirtyList : store.sortedList
  const q = search.value.trim().toUpperCase()
  if (!q)
    return base
  return base.filter(p => p.name.includes(q))
})

const progressPct = computed(() => {
  if (!store.progress || store.progress.total === 0)
    return 0
  return Math.min(100, Math.round((store.progress.received / store.progress.total) * 100))
})

// Inline editing — one row at a time. `editingName` tracks which row is
// in edit mode; `editText` is the input's draft text.
const editingName = ref<string | null>(null)
const editText = ref('')
const editInput = useTemplateRef<HTMLInputElement>('editInput')

function startEdit(name: string, displayedValue: string) {
  editingName.value = name
  editText.value = displayedValue
  nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

function commitEdit() {
  const name = editingName.value
  if (!name)
    return
  const parsed = Number.parseFloat(editText.value)
  if (!Number.isNaN(parsed)) {
    store.setEdit(name, parsed)
  }
  editingName.value = null
  editText.value = ''
}

function cancelEdit() {
  editingName.value = null
  editText.value = ''
}

// Per-row helpers.
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
      <!-- Pending-changes banner -->
      <div
        v-if="store.dirtyCount > 0"
        class="bg-secondary-50 border-secondary-300 text-secondary-900 dark:bg-secondary-950 dark:border-secondary-700 dark:text-secondary-100 flex flex-wrap items-center justify-between gap-3 border rounded-md px-4 py-2 text-sm"
      >
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-circle-alert" class="text-secondary size-4" />
          <span>
            {{ store.dirtyCount }} {{ store.dirtyCount === 1 ? 'change' : 'changes' }} pending — not yet written to your drone.
          </span>
        </div>
        <div class="flex items-center gap-2">
          <UButton size="xs" variant="soft" @click="store.discardAll()">
            Discard
          </UButton>
          <UButton
            size="xs"
            color="primary"
            disabled
            title="Writing to the drone lands in the next slice"
          >
            Apply
          </UButton>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Filter by name (e.g. ATC, INS_HNTCH, RTL)"
          size="md"
          class="flex-1"
        />
        <UButton
          size="sm"
          variant="soft"
          :color="showOnlyChanged ? 'secondary' : 'neutral'"
          :icon="showOnlyChanged ? 'i-lucide-eye' : 'i-lucide-eye-off'"
          :disabled="store.dirtyCount === 0"
          @click="showOnlyChanged = !showOnlyChanged"
        >
          {{ showOnlyChanged ? 'Showing changes only' : 'Show changes only' }}
        </UButton>
      </div>

      <p class="text-muted text-xs">
        {{ filtered.length.toLocaleString() }} of {{ store.count.toLocaleString() }} parameters
        <span v-if="store.dirtyCount > 0"> · {{ store.dirtyCount }} changed</span>
      </p>

      <div class="border-default max-h-[70vh] overflow-y-auto rounded-md border">
        <table class="w-full text-left text-sm">
          <thead class="bg-elevated text-muted sticky top-0 text-xs uppercase">
            <tr>
              <th class="w-[22%] px-3 py-2 font-medium">
                Name
              </th>
              <th class="w-[20%] px-3 py-2 text-right font-medium">
                Value
              </th>
              <th class="px-3 py-2 font-medium">
                Description
              </th>
              <th class="w-8" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filtered"
              :key="p.name"
              class="border-default border-t"
              :class="store.isDirty(p.name) ? 'bg-secondary-50/40 dark:bg-secondary-950/30' : ''"
              :title="meta(p.name).full || undefined"
            >
              <td class="text-highlighted px-3 py-1.5 font-mono text-xs whitespace-nowrap">
                {{ p.name }}
              </td>
              <td class="px-3 py-1.5 text-right font-mono text-xs whitespace-nowrap">
                <!-- Edit mode: text input -->
                <input
                  v-if="editingName === p.name"
                  ref="editInput"
                  v-model="editText"
                  type="text"
                  inputmode="decimal"
                  class="border-secondary-500 bg-default text-highlighted w-24 rounded border px-1 py-0.5 text-right font-mono text-xs outline-none"
                  @keydown.enter.prevent="commitEdit"
                  @keydown.escape.prevent="cancelEdit"
                  @blur="commitEdit"
                >
                <!-- Display mode: click to edit -->
                <button
                  v-else
                  type="button"
                  class="hover:bg-elevated -mx-1 cursor-text rounded px-1 py-0.5 text-right font-mono"
                  :class="store.isDirty(p.name) ? 'text-secondary font-semibold' : 'text-default'"
                  @click="startEdit(p.name, formatParamValue(store.effectiveValue(p.name) ?? p.value, p.type))"
                >
                  {{ formatParamValue(store.effectiveValue(p.name) ?? p.value, p.type) }}<span v-if="meta(p.name).units" class="text-muted ml-1 font-normal">{{ meta(p.name).units }}</span>
                </button>
                <div
                  v-if="store.isDirty(p.name)"
                  class="text-muted mt-0.5 text-[10px] font-normal"
                >
                  was {{ formatParamValue(p.value, p.type) }}
                </div>
              </td>
              <td class="text-muted px-3 py-1.5 text-xs">
                {{ meta(p.name).short || '—' }}
              </td>
              <td class="px-1 py-1.5">
                <UButton
                  v-if="store.isDirty(p.name)"
                  icon="i-lucide-undo-2"
                  variant="ghost"
                  size="xs"
                  color="neutral"
                  :aria-label="`Revert ${p.name}`"
                  title="Revert this change"
                  @click="store.revertParam(p.name)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </UCard>
</template>
