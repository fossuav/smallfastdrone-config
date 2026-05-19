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

// Betaflight-style row of subsystem readiness icons rendered on the
// Connect view. Each icon corresponds to one SYS_STATUS sensor bit; the
// session store derives present + enabled + healthy into ok / unhealthy
// / off. When the pre-arm subsystem reads OK the verdict line below
// says the drone is ready to arm.

import type { SubsystemKey } from '../../protocol/mavlink'
import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'

const session = useSessionStore()

interface Subsystem {
  key: SubsystemKey
  label: string
  icon: string
}

// Operator-facing label + Lucide icon per subsystem. Order chosen to
// follow the typical mental model: sensors first, then the
// "everything checks out" verdict.
const SUBSYSTEMS: Subsystem[] = [
  { key: 'gyro', label: 'Gyro', icon: 'i-lucide-orbit' },
  { key: 'accel', label: 'Accelerometer', icon: 'i-lucide-axis-3d' },
  { key: 'mag', label: 'Compass', icon: 'i-lucide-compass' },
  { key: 'baro', label: 'Barometer', icon: 'i-lucide-gauge' },
  { key: 'gps', label: 'GPS', icon: 'i-lucide-satellite' },
  { key: 'ahrs', label: 'Attitude estimator (AHRS)', icon: 'i-lucide-globe' },
  { key: 'battery', label: 'Battery', icon: 'i-lucide-battery' },
  { key: 'rc', label: 'RC link', icon: 'i-lucide-gamepad-2' },
  { key: 'prearm', label: 'Pre-arm checks', icon: 'i-lucide-shield-check' },
]

// Cross the static UI definition with the live store state. Subsystems
// not (yet) present in the store get an 'unknown' state so the icon
// renders as "waiting…" until the first SYS_STATUS arrives.
const states = computed(() => {
  const map = new Map(session.subsystems.map(s => [s.key, s.state]))
  return SUBSYSTEMS.map(s => ({
    ...s,
    state: map.get(s.key) ?? 'unknown' as const,
  }))
})

// Tailwind class string for an icon's colour treatment. Kept verbose
// rather than templated so Tailwind's purge picks up every class.
function stateClass(state: 'ok' | 'unhealthy' | 'off' | 'unknown'): string {
  switch (state) {
    case 'ok': return 'text-success bg-success/10'
    case 'unhealthy': return 'text-warning bg-warning/10'
    case 'off': return 'text-muted bg-elevated'
    default: return 'text-muted bg-elevated opacity-50'
  }
}

// Operator-facing word for the icon's tooltip + aria-label. Avoids
// MAVLink jargon — "failing" not "unhealthy bit set."
function stateText(state: 'ok' | 'unhealthy' | 'off' | 'unknown'): string {
  switch (state) {
    case 'ok': return 'OK'
    case 'unhealthy': return 'failing'
    case 'off': return 'not in use'
    default: return 'waiting…'
  }
}

const hasData = computed(() => session.subsystems.length > 0)
</script>

<template>
  <div class="space-y-2">
    <div class="text-muted text-center text-xs font-medium tracking-wide uppercase">
      System status
    </div>
    <div class="flex flex-wrap items-center justify-center gap-1.5">
      <div
        v-for="s in states"
        :key="s.key"
        class="flex size-9 items-center justify-center rounded-md border border-default transition-colors"
        :class="stateClass(s.state)"
        :title="`${s.label}: ${stateText(s.state)}`"
        role="status"
        :aria-label="`${s.label}: ${stateText(s.state)}`"
      >
        <UIcon :name="s.icon" class="size-4" />
      </div>
    </div>
    <p class="text-center text-xs">
      <template v-if="!hasData">
        <span class="text-muted">Waiting for status from your drone…</span>
      </template>
      <template v-else-if="session.readyToArm">
        <span class="text-success font-medium">✓ Ready to arm</span>
      </template>
      <template v-else>
        <span class="text-muted">Not ready to arm yet — see the bell for details.</span>
      </template>
    </p>
  </div>
</template>
