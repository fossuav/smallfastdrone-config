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

// Recipes view — same ribbon UX as bringup, just non-sequential: a tab
// per recipe (free-pick, not a progression), per-recipe header with an
// "On the radio" toggle for field-capable recipes, and the recipe's
// DesktopView mounted full-width below. PLAN decision 9 frames recipes
// as wizards (the workflow primitive); this is the UX expression of
// that — both surfaces share `WizardRibbon` + `FieldEnabledToggle` +
// `useFieldToolsStore`, the only difference is `numbered=false`
// (recipes don't have a 1/2/3 progression) and no auto-mark-complete
// (each recipe stands alone). Paid Pro recipes keep their own section
// below the ribbon — the ribbon represents "things you can do" so a
// dead "click for Coming soon" tab would just be friction. Once a Pro
// entry unlocks, it slots in as a tab.
//
// Card markup in the Pro section mirrors WizardLibraryView's locked
// section so the visual model stays consistent across surfaces.

import type { Component } from 'vue'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../stores/session'
import { useWizardProgressStore } from '../stores/wizardProgress'
import FieldEnabledToggle from '../ui/components/FieldEnabledToggle.vue'
import WizardRibbon from '../ui/components/WizardRibbon.vue'
import { getWizards } from '../workflow/wizard-runtime'

const session = useSessionStore()
const progress = useWizardProgressStore()
const route = useRoute()
const router = useRouter()

const RIBBON_PATH = '/recipes'

// Recipes = tune + recipe categories. Bringup lives in the library /
// the ribbon at /wizard/bringup.
const RECIPE_CATEGORIES = ['tune', 'recipe'] as const
const wizards = computed(() =>
  getWizards().filter(w => (RECIPE_CATEGORIES as readonly string[]).includes(w.manifest.category)),
)
const unlocked = computed(() => wizards.value.filter(w => !w.manifest.locked))
const locked = computed(() => wizards.value.filter(w => w.manifest.locked))

interface RecipeArea {
  id: string
  label: string
  hero: string
  description: string
  fieldCapable: boolean
  done: boolean
  outcome?: string
}
const areas = computed<RecipeArea[]>(() =>
  unlocked.value.map((w) => {
    const completion = progress.getCompletion(session.fcUid, w.manifest.id)
    return {
      id: w.manifest.id,
      label: w.manifest.title,
      hero: w.manifest.hero,
      description: w.manifest.description,
      fieldCapable: Boolean(w.manifest.field_capable),
      done: Boolean(completion),
      outcome: completion?.outcome,
    }
  }),
)

const tabs = computed(() => areas.value.map(a => ({ id: a.id, label: a.label, done: a.done })))

function isRecipeId(v: unknown): v is string {
  return typeof v === 'string' && areas.value.some(a => a.id === v)
}
const selected = computed(() =>
  isRecipeId(route.query.recipe) ? route.query.recipe : (areas.value[0]?.id ?? ''),
)
const selectedArea = computed(() => areas.value.find(a => a.id === selected.value))

function selectArea(id: string) {
  void router.push({ path: RIBBON_PATH, query: { recipe: id, returnTo: RIBBON_PATH } })
}

// Keep the URL canonical: land on /recipes (or return from an inline recipe
// to a bare /recipes) → replace with the resolved recipe + returnTo.
watch(
  () => route.query.recipe,
  () => {
    if (route.path === RIBBON_PATH && areas.value.length > 0 && !isRecipeId(route.query.recipe))
      void router.replace({ path: RIBBON_PATH, query: { recipe: selected.value, returnTo: RIBBON_PATH } })
  },
  { immediate: true },
)

// Lazy-load + mount the selected recipe's DesktopView full-width below.
const contentView = shallowRef<Component | null>(null)
watch(selected, async (id) => {
  contentView.value = null
  if (!id)
    return
  const reg = getWizards().find(w => w.manifest.id === id)
  contentView.value = (await reg?.loadDesktopView()) ?? null
}, { immediate: true })

onMounted(() => {
  // Field-tools store is refreshed app-wide on connect (App.vue); no extra
  // refresh needed here.
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-4">
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

    <!-- Ribbon of unlocked recipes — same UX as the bringup ribbon,
         non-sequential. Hidden if there's nothing unlocked yet (currently
         the seed entries haven't landed). -->
    <UCard v-if="areas.length > 0">
      <WizardRibbon
        :model-value="selected"
        :tabs="tabs"
        :numbered="false"
        @update:model-value="selectArea"
      />

      <div v-if="selectedArea" class="mt-4 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-md">
              <UIcon :name="selectedArea.hero" class="size-6" />
            </div>
            <div>
              <h2 class="text-highlighted font-semibold">
                {{ selectedArea.label }}
              </h2>
              <p class="text-muted text-sm">
                <template v-if="selectedArea.done && selectedArea.outcome">
                  <UIcon name="i-lucide-circle-check" class="text-success mr-0.5 inline size-3.5 align-text-top" />
                  {{ selectedArea.outcome }}
                </template>
                <template v-else>
                  {{ selectedArea.description }}
                </template>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <FieldEnabledToggle
              v-if="selectedArea.fieldCapable"
              :wizard-id="selectedArea.id"
            />
            <RouterLink
              :to="`/wizard/${selected}?returnTo=${RIBBON_PATH}`"
              class="text-muted hover:text-primary inline-flex shrink-0 items-center gap-1 text-sm"
            >
              Open on its own
              <UIcon name="i-lucide-arrow-up-right" class="size-4" />
            </RouterLink>
          </div>
        </div>

        <hr class="border-default">

        <component :is="contentView" v-if="contentView" :key="selected" />
        <div v-else class="text-muted py-12 text-center text-sm">
          Loading…
        </div>
      </div>
    </UCard>

    <!-- Pro recipes — same commercial gating seam as the library. Lives
         outside the ribbon so the ribbon represents "things you can do";
         once a Pro entry unlocks it slots in as a tab. -->
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

    <!-- Empty-empty state: nothing at all yet. Disappears as seed
         recipes land. -->
    <p v-if="areas.length === 0 && locked.length === 0" class="text-muted text-sm">
      No recipes yet — the seed entries (indoor cinewhoop, throw launch,
      first-flight failsafes) land in an upcoming slice.
    </p>
  </div>
</template>
