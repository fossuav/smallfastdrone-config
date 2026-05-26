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

// Recipes view — the home for tuning-flavoured wizards: named outcomes
// (indoor cinewhoop, throw-launched, first-flight failsafes) + paid Pro
// tuning entries that ride the same `locked` gating seam as the library.
// Recipes are wizards under the hood (the workflow primitive — see
// PLAN.md decision 9 + docs/WIZARDS.md "Recipes-as-wizards"); they're
// just the subset whose category is 'tune' or 'recipe'.
//
// v1 carries the `pid-autotune-pro` placeholder (locked Pro) so the
// commercial seam is visible on this surface as the cinewhoop / throw /
// failsafes wizards land. Card markup intentionally mirrors
// WizardLibraryView so the two surfaces feel like one model; refactor
// to a shared WizardCard component when there's a third consumer.

import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '../stores/session'
import { useWizardProgressStore } from '../stores/wizardProgress'
import {
  categoryLabel,
  checkPrereqs,
  getWizards,
} from '../workflow/wizard-runtime'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()

// Recipes = tune + recipe categories. Bringup wizards live in the
// library; this view doesn't show them.
const RECIPE_CATEGORIES = ['tune', 'recipe'] as const
const wizards = computed(() =>
  getWizards().filter(w => (RECIPE_CATEGORIES as readonly string[]).includes(w.manifest.category)),
)
const unlocked = computed(() => wizards.value.filter(w => !w.manifest.locked))
const locked = computed(() => wizards.value.filter(w => w.manifest.locked))

const caps = computed(() => ({
  connected: session.connected,
  heartbeat: session.hasHeartbeat,
  params_loaded: false,
}))

function prereqResult(prereqs: Parameters<typeof checkPrereqs>[0]) {
  return checkPrereqs(prereqs, caps.value)
}

function completion(wizardId: string) {
  return wizardProgress.getCompletion(session.fcUid, wizardId)
}

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
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-center gap-3">
      <UIcon name="i-lucide-book-open" class="text-primary size-7" />
      <div>
        <h1 class="text-highlighted text-2xl font-semibold">
          Tuning recipes
        </h1>
        <p class="text-muted text-sm">
          Pre-decided tuning profiles for common drone types and use cases. Pick
          the outcome you want; we set the parameters.
        </p>
      </div>
    </header>

    <!-- Unlocked recipes — populated as the seed entries (cinewhoop /
         throw / failsafes) land. Empty in v1 except for the Pro stub
         below. -->
    <section v-if="unlocked.length > 0">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <RouterLink
          v-for="w in unlocked"
          :key="w.manifest.id"
          :to="`/wizard/${w.manifest.id}`"
          class="border-default hover:border-primary group flex flex-col gap-3 rounded-lg border bg-elevated p-4 transition-colors"
          :aria-label="`Open the ${w.manifest.title} recipe`"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-md">
              <UIcon :name="w.manifest.hero" class="size-7" />
            </div>
            <div class="flex flex-col items-end gap-1">
              <UBadge color="secondary" variant="subtle" size="sm">
                {{ categoryLabel(w.manifest.category) }}
              </UBadge>
              <UBadge
                v-if="completion(w.manifest.id)"
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-check"
              >
                Done
              </UBadge>
            </div>
          </div>
          <div>
            <h2 class="text-highlighted text-base font-semibold">
              {{ w.manifest.title }}
            </h2>
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
            <p
              v-if="!prereqResult(w.manifest.prerequisites).ok"
              class="text-warning mt-1"
            >
              {{ prereqResult(w.manifest.prerequisites).missing[0] }}
            </p>
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- Pro recipes — same commercial gating seam as the library. -->
    <section v-if="locked.length > 0">
      <h2 class="text-muted mb-3 text-xs font-medium tracking-wide uppercase">
        Pro recipes — coming soon
      </h2>
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
          <UButton
            color="neutral"
            variant="outline"
            disabled
            class="mt-auto"
            block
          >
            Coming soon
          </UButton>
        </div>
      </div>
    </section>

    <!-- Empty-empty state: no recipes at all yet. Once the seed entries
         (cinewhoop / throw / failsafes) land, this disappears. -->
    <p v-if="unlocked.length === 0 && locked.length === 0" class="text-muted text-sm">
      No recipes yet — the seed entries (indoor cinewhoop, throw launch,
      first-flight failsafes) land in an upcoming slice.
    </p>
  </div>
</template>
