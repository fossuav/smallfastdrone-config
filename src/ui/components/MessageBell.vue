<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../../stores/session'

const session = useSessionStore()

// Reversed so the most recent message is at the top of the popover.
const messages = computed(() => [...session.recentStatusTexts].reverse())
const count = computed(() => session.recentStatusTexts.length)

// Severity → (icon, icon color, row left-border color). MAVLink severities:
// 0=EMERGENCY 1=ALERT 2=CRITICAL 3=ERROR 4=WARNING 5=NOTICE 6=INFO 7=DEBUG.
// ArduPilot sends most routine boot lines as INFO, so INFO must read as
// informational, not as "muted, ignore me" — only DEBUG falls through.
// The error/warning thresholds mirror the toast cutoff in recordStatusText
// so bell colours and toast colours agree on what "important" looks like.
function severityStyle(sev: number): { icon: string, klass: string, border: string } {
  if (sev <= 2)
    return { icon: 'i-lucide-octagon-alert', klass: 'text-error', border: 'border-l-error' }
  if (sev === 3)
    return { icon: 'i-lucide-circle-x', klass: 'text-error', border: 'border-l-error' }
  if (sev === 4)
    return { icon: 'i-lucide-triangle-alert', klass: 'text-warning', border: 'border-l-warning' }
  if (sev === 5 || sev === 6)
    return { icon: 'i-lucide-info', klass: 'text-info', border: 'border-l-info' }
  return { icon: 'i-lucide-message-square', klass: 'text-muted', border: 'border-l-default' }
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 5_000)
    return 'just now'
  if (diff < 60_000)
    return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000)
    return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}
</script>

<template>
  <UPopover :ui="{ content: 'w-96 max-w-[95vw]' }">
    <UButton
      icon="i-lucide-bell"
      variant="ghost"
      color="neutral"
      size="sm"
      aria-label="Recent messages from your drone"
    >
      <template v-if="count > 0" #trailing>
        <span class="bg-secondary text-secondary-foreground inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
          {{ count > 99 ? '99+' : count }}
        </span>
      </template>
    </UButton>

    <template #content>
      <div class="flex items-center justify-between border-b border-default px-3 py-2">
        <span class="text-highlighted text-sm font-medium">
          Recent messages
        </span>
        <span class="text-muted text-xs">
          {{ count === 0 ? 'none yet' : `${count} message${count === 1 ? '' : 's'}` }}
        </span>
      </div>

      <div v-if="count === 0" class="text-muted px-3 py-6 text-center text-sm">
        Connect to a drone to see its status messages here.
      </div>

      <ol v-else class="max-h-96 divide-y divide-default overflow-y-auto">
        <li
          v-for="(m, i) in messages"
          :key="`${m.receivedAt}-${i}`"
          class="flex items-start gap-2 border-l-4 px-3 py-2 text-sm"
          :class="severityStyle(m.severity).border"
        >
          <UIcon
            :name="severityStyle(m.severity).icon"
            class="mt-0.5 size-4 shrink-0"
            :class="severityStyle(m.severity).klass"
          />
          <div class="min-w-0 flex-1">
            <p class="text-default break-words">
              {{ m.text }}
            </p>
            <p class="text-muted mt-0.5 text-xs">
              {{ timeAgo(m.receivedAt) }}
            </p>
          </div>
        </li>
      </ol>
    </template>
  </UPopover>
</template>
