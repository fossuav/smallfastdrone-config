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

// Wizard library — the operator-facing index of every wizard the tool
// bundles. Renders one card per registered manifest, grouping unlocked
// wizards above locked Pro wizards so the catalogue of "what's
// possible" stays visible without burying the live ones. Cards link out
// to /wizard/:id which mounts the WizardRunnerView.

import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '../stores/session'
import { useWizardProgressStore } from '../stores/wizardProgress'
import {
  categoryLabel,
  checkPrereqs,
  getWizards,
} from '../workflow/wizard-runtime'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()

// Snapshot of FC capabilities for prereq evaluation. Slice A only
// needs the session-level checks; later slices grow this snapshot
// (scripting, ftp_writable, etc.) without changing the prereq schema.
const caps = computed(() => ({
  connected: session.connected,
  heartbeat: session.hasHeartbeat,
  params_loaded: false, // slice A doesn't declare this prereq anywhere
}))

// Split the registry into unlocked vs locked so the library can render
// "available now" cards above the "what's coming" Pro showcase.
const wizards = computed(() => getWizards())
const unlocked = computed(() => wizards.value.filter(w => !w.manifest.locked))
const locked = computed(() => wizards.value.filter(w => w.manifest.locked))

// Evaluate a wizard's prereqs against the live capability snapshot.
// Returns { ok, missing } — ok=false means the card stays clickable
// but shows the missing reasons inline.
function prereqResult(prereqs: Parameters<typeof checkPrereqs>[0]) {
  return checkPrereqs(prereqs, caps.value)
}

// Completion record (if any) for a wizard against the currently-
// connected FC. Returns undefined when the wizard hasn't been completed
// on this drone or when fcUid is null (no AUTOPILOT_VERSION yet).
function completion(wizardId: string) {
  return wizardProgress.getCompletion(session.fcUid, wizardId)
}

// Short relative-time string for a completion timestamp ("just now" /
// "12m ago" / "3h ago" / "yesterday" / "5 days ago"). Calibrated for
// the typical bench-tuning cadence — operators care about "today vs
// last week," not minute-precision.
function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000)
    return 'just now'
  if (diff < 3_600_000)
    return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)
    return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 172_800_000)
    return 'yesterday'
  return `${Math.floor(diff / 86_400_000)} days ago`
}
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-wand-2" class="text-primary size-7" />
        <div>
          <h1 class="text-highlighted text-2xl font-semibold">
            Bringup wizards
          </h1>
          <p class="text-muted text-sm">
            Step-by-step flows that get your drone configured the right way. Pick
            one to start, or run the full bringup from the top.
          </p>
        </div>
      </div>
      <!-- PROTOTYPE entry point — the ribbon-layout bringup (preview). -->
      <RouterLink to="/bringup" class="shrink-0">
        <UButton color="neutral" variant="outline" size="sm" trailing-icon="i-lucide-arrow-up-right">
          Ribbon layout (preview)
        </UButton>
      </RouterLink>
    </header>

    <!-- Unlocked wizards — the live catalogue. -->
    <section>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <RouterLink
          v-for="w in unlocked"
          :key="w.manifest.id"
          :to="`/wizard/${w.manifest.id}`"
          class="border-default hover:border-primary group flex flex-col gap-3 rounded-lg border bg-elevated p-4 transition-colors"
          :aria-label="`Open the ${w.manifest.title} wizard`"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="bg-primary/10 text-primary flex size-12 shrink-0 items-center justify-center rounded-md">
              <UIcon :name="w.manifest.hero" class="size-7" />
            </div>
            <div class="flex flex-col items-end gap-1">
              <UBadge color="secondary" variant="subtle" size="sm">
                {{ categoryLabel(w.manifest.category) }}
              </UBadge>
              <UBadge
                v-if="completion(w.manifest.id)"
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-check"
              >
                Done
              </UBadge>
              <UBadge
                v-if="w.manifest.field_capable"
                color="info"
                variant="subtle"
                size="sm"
                icon="i-lucide-radio"
              >
                Field-capable
              </UBadge>
            </div>
          </div>
          <div>
            <h2 class="text-highlighted text-base font-semibold">
              {{ w.manifest.title }}
            </h2>
            <p class="text-muted mt-1 text-sm">
              {{ w.manifest.description }}
            </p>
          </div>
          <div class="border-default text-muted mt-auto border-t pt-3 text-xs">
            <p v-if="completion(w.manifest.id)" class="text-success flex items-start gap-1.5">
              <UIcon name="i-lucide-circle-check" class="mt-0.5 size-3.5 shrink-0" />
              <span>
                {{ completion(w.manifest.id)!.outcome }}
                <span class="text-muted">— {{ timeAgo(completion(w.manifest.id)!.completedAt) }}</span>
              </span>
            </p>
            <p v-else>
              <span class="font-medium">Outcome:</span> {{ w.manifest.outcome }}
            </p>
            <p
              v-if="!prereqResult(w.manifest.prerequisites).ok"
              class="text-warning mt-1"
            >
              {{ prereqResult(w.manifest.prerequisites).missing[0] }}
            </p>
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- Locked Pro wizards — visible so operators know what's coming. -->
    <section v-if="locked.length > 0">
      <h2 class="text-muted mb-3 text-xs font-medium tracking-wide uppercase">
        Pro wizards — coming soon
      </h2>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="w in locked"
          :key="w.manifest.id"
          class="border-default flex flex-col gap-3 rounded-lg border bg-elevated/50 p-4 opacity-75"
          :aria-label="`${w.manifest.title} — locked Pro wizard`"
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
  </div>
</template>
