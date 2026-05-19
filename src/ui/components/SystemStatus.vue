<script setup lang="ts">
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

const states = computed(() => {
  const map = new Map(session.subsystems.map(s => [s.key, s.state]))
  return SUBSYSTEMS.map(s => ({
    ...s,
    state: map.get(s.key) ?? 'unknown' as const,
  }))
})

function stateClass(state: 'ok' | 'unhealthy' | 'off' | 'unknown'): string {
  switch (state) {
    case 'ok': return 'text-success bg-success/10'
    case 'unhealthy': return 'text-warning bg-warning/10'
    case 'off': return 'text-muted bg-elevated'
    default: return 'text-muted bg-elevated opacity-50'
  }
}

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
