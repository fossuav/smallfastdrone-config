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

// Bringup view placeholder. Phase 2 (see PLAN.md + docs/WIZARDS.md)
// replaces this with the wizard library plus a dedicated entry point
// that launches the bringup meta-wizard. Reachable from the nav today
// as a roadmap signpost only.
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-wand-2" class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Bringup wizard
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Walks you through configuring a new drone from first power-on to first
      hover — sensor calibration, RC setup, motor test, filters, PIDs, and
      flight mode setup. One step at a time, with a picture for every choice.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
