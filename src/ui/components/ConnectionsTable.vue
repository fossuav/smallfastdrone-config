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
// status column that reads either the live byte-flow indicator (slice
// 1) or a per-port Finding (slice 2 once "Check what's plugged in" has
// run). Presentational; rows + findings + sampling state come from
// useConnections(). Shared between the bringup ribbon's "Connections"
// tab and the standalone wizard view so they can't diverge.

import type { ConnectionRow, DetectPhase } from '../../workflow/connections'
import type { Finding, FindingStatus } from '../../workflow/uart-activity'

const props = defineProps<{
  rows: readonly ConnectionRow[]
  loading: boolean
  error: string | null
  // Slice 2 — sampling state from useConnections(). When detectPhase
  // is 'done', the Status column renders the per-row Finding instead
  // of the static Active/Quiet badge; during 'sampling' the table
  // shows a progress bar in the header.
  findings?: Map<string, Finding>
  detectPhase?: DetectPhase
  progress?: number
}>()

defineEmits<{ refresh: [], detect: [] }>()

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

// Visual mapping for each Finding status — colour + icon. Kept here
// (not in uart-activity.ts) because the workflow module is pure and
// shouldn't reach for UI tokens.
const STATUS_STYLE: Record<FindingStatus, { color: string, icon: string }> = {
  ok: { color: 'text-success', icon: 'i-lucide-check-circle-2' },
  gcs: { color: 'text-primary', icon: 'i-lucide-laptop' },
  misconfigured: { color: 'text-error', icon: 'i-lucide-alert-triangle' },
  outbound: { color: 'text-primary', icon: 'i-lucide-arrow-up-right' },
  quiet: { color: 'text-warning', icon: 'i-lucide-circle-help' },
  unused: { color: 'text-muted', icon: 'i-lucide-minus' },
  pending: { color: 'text-muted', icon: 'i-lucide-loader-circle' },
}

function findingFor(row: ConnectionRow): Finding | null {
  return props.findings?.get(row.uart.logical) ?? null
}

function styleFor(status: FindingStatus): { color: string, icon: string } {
  return STATUS_STYLE[status]
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start justify-between gap-3">
      <p class="text-muted text-xs">
        <template v-if="detectPhase === 'sampling'">
          Watching each port for activity…
        </template>
        <template v-else-if="detectPhase === 'done'">
          Your drone watched its ports for a moment. Here's what happened on each.
        </template>
        <template v-else>
          Each row is a port your drone reports. Click "Check what's plugged in" to
          watch every port for a moment — your drone tells us which ones are
          actually exchanging data.
        </template>
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          :disabled="detectPhase === 'sampling'"
          @click="$emit('refresh')"
        >
          Refresh
        </UButton>
        <UButton
          size="xs"
          color="primary"
          icon="i-lucide-search"
          :loading="detectPhase === 'sampling'"
          :disabled="loading"
          @click="$emit('detect')"
        >
          Check what's plugged in
        </UButton>
      </div>
    </div>

    <!-- Sampling progress bar — only present during the watch window. -->
    <div
      v-if="detectPhase === 'sampling'"
      class="border-default bg-elevated/40 rounded-md border p-2"
    >
      <UProgress :model-value="Math.round((progress ?? 0) * 100)" size="sm" />
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
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.uart.logical"
            class="border-default border-t align-top"
          >
            <td class="text-highlighted px-3 py-2 font-mono text-xs whitespace-nowrap">
              {{ row.uart.logical }}
            </td>
            <td class="text-default px-3 py-2 text-xs">
              {{ hardwareLabel(row) }}
            </td>
            <td class="px-3 py-2">
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
            <td class="text-default px-3 py-2 text-right text-xs whitespace-nowrap">
              {{ baudLabel(row.baud) }}
            </td>
            <td class="px-3 py-2">
              <!-- Finding: the wizard's verdict for this row, with the
                   one-line explanation underneath. Replaces the static
                   activity badge once detection has run. -->
              <template v-if="findingFor(row)">
                <div
                  class="flex items-center gap-1.5 text-xs font-medium"
                  :class="styleFor(findingFor(row)!.status).color"
                >
                  <UIcon
                    :name="styleFor(findingFor(row)!.status).icon"
                    class="size-3.5 shrink-0"
                    :class="findingFor(row)!.status === 'pending' ? 'animate-spin' : ''"
                  />
                  {{ findingFor(row)!.label }}
                </div>
                <p class="text-muted mt-0.5 text-xs leading-snug">
                  {{ findingFor(row)!.detail }}
                </p>
              </template>
              <!-- Slice-1 fallback: live byte-flow indicator. -->
              <template v-else>
                <span
                  v-if="row.active"
                  class="text-success inline-flex items-center gap-1 text-xs"
                >
                  <span class="bg-success size-1.5 rounded-full" />
                  Active
                </span>
                <span v-else class="text-muted text-xs">Quiet</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
