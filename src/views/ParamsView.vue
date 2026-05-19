<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import {
  describeParamValue,
  formatParamValue,
  getParamMeta,
  getRangeHint,
} from '../protocol/params'
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

// Fill the editor with a suggested value and commit. Used by the inline
// suggestion chips for params with Values metadata.
function pickSuggestion(value: string) {
  editText.value = value
  commitEdit()
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
      <!-- Pending-changes banner: only when not mid-apply and not showing a
           just-completed result. -->
      <div
        v-if="store.dirtyCount > 0 && !store.applying && store.applyStage !== 'done'"
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
          <UButton size="xs" color="primary" @click="store.apply()">
            Apply
          </UButton>
        </div>
      </div>

      <!-- Apply-in-progress banner -->
      <div
        v-if="store.applying"
        class="bg-primary-50 border-primary-300 text-primary-900 dark:bg-primary-950 dark:border-primary-700 dark:text-primary-100 flex items-center gap-3 border rounded-md px-4 py-2 text-sm"
      >
        <UIcon name="i-lucide-loader" class="text-primary size-4 animate-spin" />
        <span v-if="store.applyStage === 'writing'">
          Writing {{ store.writeStates.size }} {{ store.writeStates.size === 1 ? 'parameter' : 'parameters' }} to your drone…
        </span>
        <span v-else-if="store.applyStage === 'saving'">
          Saving to your drone's storage so the changes survive a reboot…
        </span>
      </div>

      <!-- Apply-result banner -->
      <div
        v-if="!store.applying && store.applyStage === 'done'"
        class="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-2 text-sm"
        :class="store.lastApplyFailed > 0 || store.lastApplyMismatched > 0 || store.applyError
          ? 'bg-warning-50 border-warning-300 text-warning-900 dark:bg-warning-950 dark:border-warning-700 dark:text-warning-100'
          : 'bg-success-50 border-success-300 text-success-900 dark:bg-success-950 dark:border-success-700 dark:text-success-100'"
      >
        <div class="flex items-center gap-3">
          <UIcon
            :name="store.lastApplyFailed > 0 || store.lastApplyMismatched > 0 || store.applyError
              ? 'i-lucide-circle-alert'
              : 'i-lucide-circle-check'"
            class="size-4"
          />
          <span>
            <template v-if="store.applyError">{{ store.applyError }}</template>
            <template v-else-if="store.lastApplyFailed === 0 && store.lastApplyMismatched === 0">
              {{ store.lastApplyAcked }} {{ store.lastApplyAcked === 1 ? 'change' : 'changes' }} saved to your drone.
            </template>
            <template v-else>
              {{ store.lastApplyAcked }} saved<template v-if="store.lastApplyMismatched">, {{ store.lastApplyMismatched }} accepted with a different value</template><template v-if="store.lastApplyFailed">, {{ store.lastApplyFailed }} didn't respond</template>.
            </template>
          </span>
        </div>
        <UButton size="xs" variant="soft" @click="store.dismissApplyResult()">
          Done
        </UButton>
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

      <div class="border-default max-h-[70vh] overflow-x-auto overflow-y-auto rounded-md border">
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
              class="border-default border-t border-l-4"
              :class="store.isDirty(p.name)
                ? 'bg-secondary-100 dark:bg-secondary-900/40 border-l-secondary-500'
                : 'border-l-transparent'"
              :title="meta(p.name).full || undefined"
            >
              <td class="text-highlighted px-3 py-1.5 font-mono text-xs whitespace-nowrap">
                {{ p.name }}
              </td>
              <td class="px-3 py-1.5 text-right text-xs align-top">
                <!-- Edit mode: free-text input. For params with Values
                     metadata we render every documented value as a clickable
                     chip below — the values are hints, not constraints, so
                     the operator can pick a documented one *or* type any
                     value. The FC clamps/rejects if it doesn't like what
                     arrived (surfaced via mismatched / failed states).
                     @mousedown.prevent on each chip stops the input from
                     blurring before our click handler runs. -->
                <template v-if="editingName === p.name">
                  <input
                    ref="editInput"
                    v-model="editText"
                    type="text"
                    inputmode="decimal"
                    :title="getRangeHint(p.name) || undefined"
                    class="border-secondary-500 bg-default text-highlighted w-full rounded border px-1 py-0.5 text-right font-mono text-xs outline-none"
                    @keydown.enter.prevent="commitEdit"
                    @keydown.escape.prevent="cancelEdit"
                    @blur="commitEdit"
                  >
                  <div
                    v-if="getParamMeta(p.name)?.values"
                    class="mt-1 flex flex-col items-end gap-0.5"
                  >
                    <button
                      v-for="(label, key) in getParamMeta(p.name)?.values"
                      :key="key"
                      type="button"
                      class="bg-elevated hover:bg-secondary-100 dark:hover:bg-secondary-900/50 text-default w-full max-w-full rounded px-1.5 py-0.5 text-right text-[10px] whitespace-normal break-words"
                      @mousedown.prevent
                      @click="pickSuggestion(String(key))"
                    >
                      <span class="text-muted font-mono">{{ key }}</span> · {{ label }}
                    </button>
                  </div>
                </template>
                <!-- Display mode: click to edit -->
                <button
                  v-if="editingName !== p.name"
                  type="button"
                  class="hover:bg-elevated -mx-1 cursor-text rounded px-1 py-0.5 text-right font-mono whitespace-nowrap"
                  :class="store.isDirty(p.name) ? 'text-secondary font-semibold' : 'text-default'"
                  :title="getRangeHint(p.name) || undefined"
                  @click="startEdit(p.name, formatParamValue(store.effectiveValue(p.name) ?? p.value, p.type))"
                >
                  {{ formatParamValue(store.effectiveValue(p.name) ?? p.value, p.type) }}<span v-if="meta(p.name).units" class="text-muted ml-1 font-normal">{{ meta(p.name).units }}</span>
                </button>
                <!-- Decoded label for enums/bitmasks. Allowed to wrap so long
                     bitmask decodes don't force the column wider. -->
                <div
                  v-if="describeParamValue(p.name, store.effectiveValue(p.name) ?? p.value)"
                  class="text-muted mt-0.5 text-[10px] font-normal italic break-words whitespace-normal"
                >
                  {{ describeParamValue(p.name, store.effectiveValue(p.name) ?? p.value) }}
                </div>
                <div
                  v-if="store.isDirty(p.name)"
                  class="text-muted mt-0.5 text-[10px] font-normal whitespace-nowrap"
                >
                  was {{ formatParamValue(p.value, p.type) }}
                </div>
              </td>
              <td class="text-muted px-3 py-1.5 text-xs break-words align-top">
                {{ meta(p.name).short || '—' }}
              </td>
              <td class="px-1 py-1.5">
                <!-- Per-row write-state indicator (during/after apply). -->
                <UIcon
                  v-if="store.writeStateOf(p.name) === 'writing'"
                  name="i-lucide-loader"
                  class="text-primary size-4 animate-spin"
                  :title="`Writing ${p.name}`"
                />
                <UIcon
                  v-else-if="store.writeStateOf(p.name) === 'acked'"
                  name="i-lucide-circle-check"
                  class="text-success size-4"
                  :title="`${p.name} saved`"
                />
                <UIcon
                  v-else-if="store.writeStateOf(p.name) === 'mismatched'"
                  name="i-lucide-circle-alert"
                  class="text-warning size-4"
                  :title="`${p.name}: drone accepted a different value`"
                />
                <UIcon
                  v-else-if="store.writeStateOf(p.name) === 'failed'"
                  name="i-lucide-circle-x"
                  class="text-error size-4"
                  :title="`${p.name}: no response from drone`"
                />
                <UButton
                  v-else-if="store.isDirty(p.name)"
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
