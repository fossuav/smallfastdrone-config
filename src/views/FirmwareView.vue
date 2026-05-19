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

// Firmware view placeholder. Will host DFU flashing of SFD firmware
// images via WebUSB + the security seam once Phase 5 lands. Reachable
// from the nav today as a roadmap signpost only.
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-cpu" class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Firmware
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Flash SmallFastDrone firmware to a flight controller in DFU mode. Pick a
      release, verify the signature, watch it land on your drone.
    </p>

    <p class="mt-3 text-sm text-muted">
      Coming soon.
    </p>
  </UCard>
</template>
