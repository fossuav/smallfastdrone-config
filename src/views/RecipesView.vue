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

// Recipes view placeholder. The wizard runtime pivot (see
// docs/WIZARDS.md) merges recipes into the wizard library; this route
// will eventually redirect to the library or render the recipe-only
// filter of it. Reachable from the nav today as a roadmap signpost only.
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-book-open" class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Tuning recipes
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Pre-decided tuning profiles for common drone types and use cases —
      indoor cinewhoop, throw launch, smooth-out-vibration-from-a-log, and
      first-flight failsafes. Pick the outcome you want; we set the
      parameters.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
