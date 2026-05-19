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

// Logs view placeholder. Will host the LOG_REQUEST_LIST/DATA flow that
// pulls .bin flight logs off the FC, plus the hand-off to the
// analysis-private workflow, once Phase 4 lands. Reachable from the nav
// today as a roadmap signpost only.
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-file-text" class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Flight logs
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Download flight logs from your drone for analysis — to feed back into
      tuning, or just to keep a record of how each flight went.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
