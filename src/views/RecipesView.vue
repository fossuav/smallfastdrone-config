<script setup lang="ts">
/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// Recipes - the one catalogue. Everything the tool can do to a drone is
// listed here: bringup's steps (free), tuning profiles, securing, and
// paid entries greyed with a Pro badge. PLAN decision 43.
//
// It replaces three surfaces that all rendered the same object with
// different chrome - the wizard library (/wizard), the old Recipes
// ribbon, and Field tools (/field). Two things deliberately survive the
// collapse:
//
//   - The guided sequence. Bringup is ordered and has a done-state, and
//     a grid can express neither, so it stays a meta-wizard: the banner
//     at the top is the way in, and the cards for its steps say which
//     step they are rather than pretending order doesn't matter.
//   - Showing. The header still counts what's on the radio, cards still
//     carry live state. The knife cuts questions, not information.
//
// "Runs from the radio" is an attribute here, not a place: a badge on
// the card and a filter that narrows to those entries and gives each an
// Install / Remove. That filtered view also owns the scripting gate and
// the two install seams that came off the Field tools page - an applet
// SmallFastDrone made for this drone, and (expert only) one the
// operator wrote.

import type { WizardCategory } from '../workflow/wizard-runtime'
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { isLxa, LxaError, lxaMatchesFc, parseLxaHeader } from '../protocol/lxa'
import { useFieldToolsStore } from '../stores/fieldTools'
import { useSessionStore } from '../stores/session'
import { useUiStore } from '../stores/ui'
import { useWizardProgressStore } from '../stores/wizardProgress'
import { BRINGUP_AREA_IDS, requiredBringupAreas } from '../wizards/bringup/areas'
import { fieldToolFor } from '../workflow/field-tools'
import { useLuaEngine } from '../workflow/lua-engine'
import { checkPrereqs, getWizards } from '../workflow/wizard-runtime'

const session = useSessionStore()
const progress = useWizardProgressStore()
const field = useFieldToolsStore()
const ui = useUiStore()
const lua = useLuaEngine()
const route = useRoute()
const router = useRouter()

const CATALOGUE_PATH = '/recipes'
const BRINGUP_PATH = '/wizard/bringup'

// Which of the two views is showing. A filter, not a second page - the
// whole point of the collapse is that "runs from the radio" is one
// attribute of a catalogue entry.
const showingRadio = computed(() => route.query.view === 'radio')
function showAll(): void {
  void router.push({ path: CATALOGUE_PATH })
}
function showRadio(): void {
  void router.push({ path: CATALOGUE_PATH, query: { view: 'radio' } })
}

// Groups carry information: what a recipe is *for*. Order is the order
// an operator meets them - get it flying, then make it fly well, then
// decide what it is allowed to run.
interface Group {
  id: string
  label: string
  blurb: string
  categories: readonly WizardCategory[]
}
const GROUPS: readonly Group[] = [
  {
    id: 'getting-flying',
    label: 'Getting flying',
    blurb: 'Everything a new drone needs before its first flight. Free, and the guided walk above runs them in order.',
    categories: ['bringup'],
  },
  {
    id: 'tuning',
    label: 'Tuning',
    blurb: 'Pick how you want the drone to fly; we pick the settings.',
    categories: ['tune', 'recipe'],
  },
  {
    id: 'checks',
    label: 'Checks',
    blurb: 'Look at how the drone is behaving without changing anything.',
    categories: ['diagnostic'],
  },
  {
    id: 'securing',
    label: 'Securing',
    blurb: 'Give this drone its own identity, or take it back out again.',
    categories: ['safety'],
  },
]

// The bringup meta-wizard is the banner, not a card - listing it beside
// its own steps would say there are two ways to do the same thing.
const entries = computed(() => getWizards().filter(w => w.manifest.id !== 'bringup'))
const unlocked = computed(() => entries.value.filter(w => !w.manifest.locked))
const locked = computed(() => entries.value.filter(w => w.manifest.locked))

// Unlocked entries per group, skipping groups that have none yet.
const groups = computed(() =>
  GROUPS
    .map(g => ({ ...g, wizards: unlocked.value.filter(w => g.categories.includes(w.manifest.category)) }))
    .filter(g => g.wizards.length > 0),
)

// Which step of the guided bringup this recipe is, if it is one. The
// grid cannot carry the ordering, so each card says where it sits -
// otherwise an operator picking off the grid loses the one thing the
// sequence knew.
function bringupStep(wizardId: string): number | null {
  const i = (BRINGUP_AREA_IDS as readonly string[]).indexOf(wizardId)
  return i === -1 ? null : i + 1
}

// How far through the guided bringup this drone is. Counts only the
// steps that gate completion - securing never does.
const bringupProgress = computed(() => {
  const required = requiredBringupAreas()
  const done = required.filter(id => progress.isCompleted(session.fcUid, id)).length
  return { done, total: required.length, complete: done === required.length }
})

// Snapshot of FC capabilities for prereq evaluation.
const caps = computed(() => ({
  connected: session.connected,
  heartbeat: session.hasHeartbeat,
  params_loaded: false,
}))

// Evaluate prereqs against the live snapshot. A card stays clickable
// when they fail; it just says what is missing.
function prereqResult(prereqs: Parameters<typeof checkPrereqs>[0]) {
  return checkPrereqs(prereqs, caps.value)
}

// Completion record for this wizard against the connected FC, if any.
function completion(wizardId: string) {
  return progress.getCompletion(session.fcUid, wizardId)
}

// Is this wizard's field tool on the radio right now? Gated on the
// connection so a stale state never shows for a drone that has gone.
function fieldInstalled(wizardId: string): boolean {
  return session.connected && session.hasHeartbeat && field.isInstalled(wizardId)
}

// Short relative-time string for a completion timestamp. Calibrated for
// the bench-tuning cadence - operators care about "today vs last week".
function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000)
    return 'just now'
  if (diff < 3_600_000)
    return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)
    return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 172_800_000)
    return 'yesterday'
  return `${Math.floor(diff / 86_400_000)} days ago`
}

// The radio view: field-capable recipes that actually carry Lua assets.
// Manifest-driven, joined to the asset registry - a manifest cannot
// carry a .lua file, but it is still the manifest that says a recipe has
// a radio version.
const radioEntries = computed(() =>
  unlocked.value
    .filter(w => w.manifest.field_capable)
    .flatMap((w) => {
      const tool = fieldToolFor(w.manifest.id)
      return tool ? [{ manifest: w.manifest, tool }] : []
    }),
)

/*
  Installing an applet SmallFastDrone sent for this drone.

  Not behind expert mode, unlike the custom-applet seam below it: a
  custom applet is one the operator wrote, and this is the opposite -
  something they cannot read or write, addressed to their airframe. It
  is an ordinary thing for a customer to be given.

  The tool never opens it. What it does check, before uploading
  anything, is the drone written on the outside - so choosing the wrong
  file says so immediately rather than after an upload, a scripting
  restart, and a warning in a log nobody is watching.
*/
const appletInput = useTemplateRef<HTMLInputElement>('appletInput')
const appletState = ref<'idle' | 'working' | 'done' | 'failed'>('idle')
const appletMessage = ref<string | null>(null)

async function chooseApplet(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (appletInput.value)
    appletInput.value.value = ''
  if (!file)
    return

  appletState.value = 'working'
  appletMessage.value = null
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!isLxa(bytes))
      throw new LxaError('That file isn\'t an applet from SmallFastDrone. They end in .lxa.')
    const header = parseLxaHeader(bytes)
    if (!lxaMatchesFc(header, session.fcUid)) {
      throw new LxaError(
        `That applet was made for a different drone (${header.uid.slice(0, 12)}…). `
        + 'Only the drone it was made for can read it.',
      )
    }
    await lua.installEncryptedApplet(file.name, bytes)
    await lua.restartScripting()
    appletState.value = 'done'
    appletMessage.value = `${file.name} is on your drone. It will run from now on.`
  }
  catch (e) {
    appletState.value = 'failed'
    appletMessage.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  if (session.connected && session.hasHeartbeat)
    void field.refresh()
})
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-start gap-3">
      <UIcon name="i-lucide-book-open" class="text-primary size-7" />
      <div class="flex-1">
        <h1 class="text-highlighted text-2xl font-semibold">
          Recipes
        </h1>
        <p class="text-muted text-sm">
          Everything this tool can do to your drone. Pick the outcome you want; we set the parameters.
        </p>
      </div>
      <!-- The filter that replaced a page. -->
      <div class="border-default flex shrink-0 items-center gap-1 rounded-md border p-0.5">
        <UButton
          :color="showingRadio ? 'neutral' : 'primary'"
          :variant="showingRadio ? 'ghost' : 'soft'"
          size="sm"
          @click="showAll"
        >
          All
        </UButton>
        <UButton
          :color="showingRadio ? 'primary' : 'neutral'"
          :variant="showingRadio ? 'soft' : 'ghost'"
          size="sm"
          icon="i-lucide-radio"
          @click="showRadio"
        >
          On the radio
        </UButton>
      </div>
    </header>

    <!-- ===================== All recipes ===================== -->
    <template v-if="!showingRadio">
      <!-- The guided path. A grid cannot express an order or a
           done-state, so bringup keeps its own way in. -->
      <RouterLink
        :to="BRINGUP_PATH"
        class="border-default hover:border-primary flex items-center gap-4 rounded-lg border bg-elevated p-4 transition-colors"
        aria-label="Open the guided bringup"
      >
        <div class="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-md">
          <UIcon name="i-lucide-list-checks" class="size-7" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h2 class="text-highlighted text-base font-semibold">
              Guided bringup
            </h2>
            <UBadge
              v-if="completion('bringup') || bringupProgress.complete"
              color="success"
              variant="subtle"
              size="sm"
              icon="i-lucide-check"
            >
              Done
            </UBadge>
          </div>
          <p v-if="completion('bringup')" class="text-success mt-0.5 text-sm">
            {{ completion('bringup')!.outcome }}
          </p>
          <p v-else class="text-muted mt-0.5 text-sm">
            New drone? Run the steps below in the order that works, with the drone's live settings alongside.
          </p>
        </div>
        <div class="text-muted shrink-0 text-right text-xs">
          <p class="text-highlighted text-lg font-semibold tabular-nums">
            {{ bringupProgress.done }}/{{ bringupProgress.total }}
          </p>
          <p>steps done</p>
        </div>
        <UIcon name="i-lucide-chevron-right" class="text-muted size-5 shrink-0" />
      </RouterLink>

      <!-- One section per group. Groups say what a recipe is for; the
           step hint on a card says where it sits in the guided walk. -->
      <section v-for="g in groups" :key="g.id" class="space-y-3">
        <div>
          <h2 class="text-highlighted text-sm font-semibold">
            {{ g.label }}
          </h2>
          <p class="text-muted text-xs">
            {{ g.blurb }}
          </p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <RouterLink
            v-for="w in g.wizards"
            :key="w.manifest.id"
            :to="`/wizard/${w.manifest.id}?returnTo=${CATALOGUE_PATH}`"
            class="border-default hover:border-primary group flex flex-col gap-3 rounded-lg border bg-elevated p-4 transition-colors"
            :aria-label="`Open the ${w.manifest.title} recipe`"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-md">
                <UIcon :name="w.manifest.hero" class="size-7" />
              </div>
              <div class="flex flex-col items-end gap-1">
                <UBadge
                  v-if="completion(w.manifest.id)"
                  color="success"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-check"
                >
                  Done
                </UBadge>
                <UBadge
                  v-if="fieldInstalled(w.manifest.id)"
                  color="success"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-radio"
                >
                  On the radio
                </UBadge>
                <UBadge
                  v-else-if="w.manifest.field_capable"
                  color="info"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-radio"
                >
                  Field-capable
                </UBadge>
              </div>
            </div>
            <div>
              <p v-if="bringupStep(w.manifest.id)" class="text-muted text-xs font-medium tracking-wide uppercase">
                Bringup step {{ bringupStep(w.manifest.id) }}
              </p>
              <h3 class="text-highlighted text-base font-semibold">
                {{ w.manifest.title }}
              </h3>
              <p class="text-muted mt-1 text-sm">
                {{ w.manifest.description }}
              </p>
            </div>
            <div class="border-default text-muted mt-auto border-t pt-3 text-xs">
              <p v-if="completion(w.manifest.id)" class="text-success flex items-start gap-1.5">
                <UIcon name="i-lucide-circle-check" class="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {{ completion(w.manifest.id)!.outcome }}
                  <span class="text-muted">— {{ timeAgo(completion(w.manifest.id)!.completedAt) }}</span>
                </span>
              </p>
              <p v-else>
                <span class="font-medium">Outcome:</span> {{ w.manifest.outcome }}
              </p>
              <p v-if="!prereqResult(w.manifest.prerequisites).ok" class="text-warning mt-1">
                {{ prereqResult(w.manifest.prerequisites).missing[0] }}
              </p>
            </div>
          </RouterLink>
        </div>
      </section>

      <!-- Paid entries. One catalogue means one gating seam - the same
           locked flag, wherever the entry would otherwise have sat. -->
      <section v-if="locked.length > 0" class="space-y-3">
        <div>
          <h2 class="text-highlighted text-sm font-semibold">
            Pro recipes
          </h2>
          <p class="text-muted text-xs">
            Coming soon.
          </p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="w in locked"
            :key="w.manifest.id"
            class="border-default flex flex-col gap-3 rounded-lg border bg-elevated/50 p-4 opacity-75"
            :aria-label="`${w.manifest.title} — locked Pro recipe`"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="bg-secondary/10 text-secondary flex size-12 shrink-0 items-center justify-center rounded-md">
                <UIcon :name="w.manifest.hero" class="size-7" />
              </div>
              <UBadge color="warning" variant="solid" size="sm">
                Pro
              </UBadge>
            </div>
            <div>
              <h3 class="text-highlighted text-base font-semibold">
                {{ w.manifest.title }}
              </h3>
              <p class="text-muted mt-1 text-sm">
                {{ w.manifest.description }}
              </p>
            </div>
            <p v-if="w.manifest.unlock_blurb" class="text-muted text-xs italic">
              {{ w.manifest.unlock_blurb }}
            </p>
            <UButton color="neutral" variant="outline" disabled class="mt-auto" block>
              Coming soon
            </UButton>
          </div>
        </div>
      </section>
    </template>

    <!-- ===================== On the radio ===================== -->
    <template v-else>
      <p class="text-muted text-sm">
        Install these on your radio to run them from the transmitter's own menu — no laptop at the field.
      </p>

      <!-- Needs a live FC. -->
      <UCard v-if="!session.connected || !session.hasHeartbeat">
        <div class="text-muted py-8 text-center text-sm">
          <UIcon name="i-lucide-plug" class="mx-auto size-6" />
          <p class="mt-2">
            Connect your drone to manage what's on the radio.
          </p>
          <RouterLink to="/" class="text-primary mt-2 inline-block">
            Go to Connect
          </RouterLink>
        </div>
      </UCard>

      <template v-else>
        <!-- Scripting unavailable on this build. -->
        <UAlert
          v-if="field.scripting === 'unavailable'"
          color="warning"
          icon="i-lucide-triangle-alert"
          title="Radio tools aren't available on this firmware"
          description="This flight controller's firmware was built without scripting, so it can't run radio-menu tools."
        />

        <!-- Scripting off - offer to turn it on (reboot-required). -->
        <UCard v-else-if="field.scripting === 'off'">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-highlighted font-medium">
                Turn on scripting to use radio tools
              </p>
              <p class="text-muted text-sm">
                Radio tools run as scripts. We'll switch scripting on — it restarts your drone for a few seconds and reconnects automatically.
              </p>
            </div>
            <UButton
              color="primary"
              icon="i-lucide-power"
              :loading="field.busy === 'scripting'"
              @click="field.enableScripting"
            >
              Turn on
            </UButton>
          </div>
        </UCard>

        <template v-else-if="field.scripting === 'on'">
          <p class="text-muted text-xs">
            <UIcon name="i-lucide-circle-check" class="text-success mr-1 inline size-3.5 align-text-top" />
            Scripting is on.
          </p>

          <!-- Field-capable recipes, each with its own install. -->
          <ul class="space-y-2">
            <li
              v-for="e in radioEntries"
              :key="e.manifest.id"
              class="border-default flex items-start gap-3 rounded-lg border bg-elevated/30 p-3"
            >
              <div class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-md">
                <UIcon :name="e.manifest.hero" class="size-6" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h3 class="text-highlighted font-semibold">
                    {{ e.manifest.title }}
                  </h3>
                  <UBadge
                    v-if="field.installed[e.manifest.id]"
                    color="success"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-check"
                  >
                    On the radio
                  </UBadge>
                </div>
                <p class="text-muted mt-0.5 text-sm">
                  {{ e.tool.description }}
                </p>
              </div>
              <UButton
                v-if="field.installed[e.manifest.id]"
                color="neutral"
                variant="outline"
                size="sm"
                :loading="field.busy === e.manifest.id"
                @click="field.remove(e.tool)"
              >
                Remove
              </UButton>
              <UButton
                v-else
                color="primary"
                size="sm"
                icon="i-lucide-download"
                :loading="field.busy === e.manifest.id"
                @click="field.install(e.tool)"
              >
                Install
              </UButton>
            </li>
          </ul>

          <!-- Something SFD made for this airframe. Ordinary, so not
               behind expert mode. -->
          <div class="border-default mt-2 space-y-2 rounded-lg border p-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-48 flex-1">
                <p class="text-default text-sm font-medium">
                  An applet from SmallFastDrone
                </p>
                <p class="text-muted text-xs">
                  Made for this drone and scrambled so only it can read them — not us, not you, not
                  another drone.
                </p>
              </div>
              <UButton
                :disabled="!session.connected || appletState === 'working'"
                :loading="appletState === 'working'"
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-lucide-file-plus"
                @click="appletInput?.click()"
              >
                Install one…
              </UButton>
            </div>
            <input ref="appletInput" type="file" accept=".lxa" class="hidden" @change="chooseApplet">
            <UAlert
              v-if="appletState === 'done'"
              color="success"
              variant="subtle"
              icon="i-lucide-check"
              :description="appletMessage ?? ''"
            />
            <UAlert
              v-else-if="appletState === 'failed'"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="appletMessage ?? ''"
            />
          </div>

          <!-- Custom (operator-supplied) - expert-only seam. -->
          <div
            v-if="ui.expert"
            class="border-default mt-2 flex items-center justify-between gap-3 rounded-lg border border-dashed p-3"
          >
            <div>
              <p class="text-default text-sm font-medium">
                Add your own applet
              </p>
              <p class="text-muted text-xs">
                Install a custom Lua field tool you've written. Coming soon.
              </p>
            </div>
            <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-plus" disabled>
              Add…
            </UButton>
          </div>
        </template>

        <UAlert v-if="field.error" color="warning" :description="field.error" />
      </template>
    </template>
  </div>
</template>
