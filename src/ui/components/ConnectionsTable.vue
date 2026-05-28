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

// Connections overview table — one row per UART the FC reports, with
// its hardware identity, currently-assigned protocol, baud rate, and a
// live activity indicator. Presentational; the rows are computed in
// src/workflow/connections.ts and passed in. Used by the bringup
// ribbon's "Connections" tab panel and by the standalone
// connections-setup wizard so both surfaces show the same view.

import type { ConnectionRow } from '../../workflow/connections'

defineProps<{
  rows: readonly ConnectionRow[]
  loading: boolean
  error: string | null
}>()

defineEmits<{ refresh: [] }>()

// Render the hardware column. ChibiOS exposes the chip-level label
// (USART2, UART4, OTG1); SITL omits it and instead carries the SITL
// descriptor in parens. USB is universal — surface it explicitly so
// the operator immediately recognises the port they're plugged into.
function hardwareLabel(row: ConnectionRow): string {
  const u = row.uart
  if (u.physical && u.physical.startsWith('OTG'))
    return 'USB'
  if (u.physical)
    return u.physical
  if (u.descriptor)
    return u.descriptor
  return '—'
}

// Baud values come from the firmware in units of 1 baud, but
// SERIALn_BAUD is documented as kBd × 1000 — ArduPilot accepts both
// (values <= 1000 are multiplied internally) so what we read back is
// whatever the operator wrote. Display in the bigger of the two.
function baudLabel(baud: number | null): string {
  if (baud === null)
    return '—'
  const real = baud <= 1000 ? baud * 1000 : baud
  if (real >= 1_000_000)
    return `${(real / 1_000_000).toFixed(real % 1_000_000 === 0 ? 0 : 2)} Mbps`
  if (real >= 1_000)
    return `${Math.round(real / 1_000)} kbps`
  return `${real} bps`
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <p class="text-muted text-xs">
        Each row is a port your drone reports. "Activity" turns on when bytes
        are flowing — a quick way to spot a peripheral that isn't talking.
      </p>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        @click="$emit('refresh')"
      >
        Refresh
      </UButton>
    </div>

    <div
      v-if="error"
      class="border-error bg-error/10 text-error rounded-md border px-3 py-2 text-sm"
    >
      {{ error }}
    </div>

    <div
      v-if="rows.length === 0 && !loading && !error"
      class="border-default text-muted rounded-md border bg-elevated/30 px-3 py-6 text-center text-sm"
    >
      No port information yet — click Refresh to read it from your drone.
    </div>

    <div
      v-else-if="rows.length > 0"
      class="border-default overflow-x-auto rounded-md border"
    >
      <table class="w-full text-left text-sm">
        <thead class="bg-elevated text-muted text-xs uppercase">
          <tr>
            <th class="px-3 py-2 font-medium">
              Port
            </th>
            <th class="px-3 py-2 font-medium">
              Hardware
            </th>
            <th class="px-3 py-2 font-medium">
              Protocol
            </th>
            <th class="px-3 py-2 text-right font-medium">
              Baud
            </th>
            <th class="px-3 py-2 font-medium">
              Activity
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.uart.logical"
            class="border-default border-t"
          >
            <td class="text-highlighted px-3 py-1.5 font-mono text-xs whitespace-nowrap">
              {{ row.uart.logical }}
            </td>
            <td class="text-default px-3 py-1.5 text-xs">
              {{ hardwareLabel(row) }}
            </td>
            <td class="px-3 py-1.5">
              <span
                v-if="row.protocol === null"
                class="text-muted"
              >—</span>
              <span
                v-else-if="row.protocol === -1"
                class="text-muted italic"
              >Off</span>
              <span v-else>{{ row.protocolLabel }}</span>
            </td>
            <td class="text-default px-3 py-1.5 text-right text-xs whitespace-nowrap">
              {{ baudLabel(row.baud) }}
            </td>
            <td class="px-3 py-1.5">
              <span
                v-if="row.active"
                class="text-success inline-flex items-center gap-1 text-xs"
              >
                <span class="bg-success size-1.5 rounded-full" />
                Active
              </span>
              <span v-else class="text-muted text-xs">Quiet</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
