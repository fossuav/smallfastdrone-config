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

// Bringup meta-wizard DesktopView. Walks the operator through a fixed
// ordered list of sub-wizards: preflight, frame-select, then motor-check.
// (Future slices grow this list to cover sensors, RC, failsafes, etc.
// per docs/BRINGUP.md — bringup picks them up automatically as long
// as their ids are listed below.) Each step links to the standalone
// sub-wizard URL with a returnTo query so the sub-wizard's back path
// flows back here rather than dumping the operator at the library.
// Bringup itself records completion when every sub-wizard is complete,
// with no separate "finish" affordance — meta-wizards don't take
// actions of their own.

import { computed, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import { getWizard } from '../../workflow/wizard-runtime'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()

// Ordered chain of sub-wizard ids. Sequence matters — later steps assume
// earlier ones have run: frame-select assumes the operator eyeballed
// sensor health via preflight, and motor-check assumes the frame is set
// (it reads FRAME_CLASS/TYPE to know the motor layout).
const SUB_WIZARD_IDS = ['preflight', 'frame-select', 'motor-check'] as const

// Per-step projection of manifest + completion record so the template
// stays declarative. Steps for unknown ids degrade gracefully — a
// typo in SUB_WIZARD_IDS shows as a "missing" placeholder row rather
// than crashing the view.
const steps = computed(() =>
  SUB_WIZARD_IDS.map((id) => {
    const reg = getWizard(id)
    return {
      id,
      manifest: reg?.manifest,
      completion: wizardProgress.getCompletion(session.fcUid, id),
    }
  }),
)

const completedCount = computed(() => steps.value.filter(s => s.completion).length)
const allComplete = computed(() =>
  steps.value.length > 0 && completedCount.value === steps.value.length,
)

// Auto-mark bringup complete once every sub-wizard is complete. No
// Finish button — bringup itself doesn't take an action, completion
// is purely derived. Guards against re-marking so the completedAt
// timestamp stays the time the operator actually finished the last
// sub-wizard, not whenever they revisited the page afterwards.
watch(
  allComplete,
  (done) => {
    if (done && !wizardProgress.isCompleted(session.fcUid, 'bringup')) {
      wizardProgress.markComplete(
        session.fcUid,
        'bringup',
        `All ${steps.value.length} bringup steps complete.`,
      )
    }
  },
  { immediate: true },
)

// Done state takes the operator back to the library. Bringup's own
// completion badge will already be visible on the library card.
function backToLibrary() {
  router.push('/wizard')
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-muted">
      Each step focuses on one part of getting your drone configured. Run them
      in order — earlier steps make sure later ones have what they need. You
      can leave and come back; we'll remember where you are for this drone.
    </p>

    <div class="text-sm">
      <span class="text-muted">Progress:</span>
      <span class="text-highlighted ml-1 font-semibold">
        {{ completedCount }} of {{ steps.length }} complete
      </span>
    </div>

    <ol class="space-y-3">
      <li
        v-for="(step, i) in steps"
        :key="step.id"
        class="border-default rounded-lg border bg-elevated/30 p-3"
      >
        <div class="flex items-start gap-3">
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            :class="step.completion ? 'bg-success/20 text-success' : 'bg-elevated text-muted'"
          >
            <UIcon v-if="step.completion" name="i-lucide-check" class="size-5" />
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-highlighted font-semibold">
                {{ step.manifest?.title ?? step.id }}
              </h3>
              <RouterLink
                :to="`/wizard/${step.id}?returnTo=/wizard/bringup`"
                class="shrink-0"
              >
                <UButton
                  :color="step.completion ? 'neutral' : 'primary'"
                  :variant="step.completion ? 'outline' : 'solid'"
                  size="sm"
                >
                  {{ step.completion ? 'Redo' : 'Start' }}
                </UButton>
              </RouterLink>
            </div>
            <p v-if="step.completion" class="text-success mt-1 text-sm">
              ✓ {{ step.completion.outcome }}
            </p>
            <p v-else-if="step.manifest" class="text-muted mt-1 text-sm">
              {{ step.manifest.description }}
            </p>
            <p v-else class="text-warning mt-1 text-sm">
              This step's wizard isn't installed — skip it for now.
            </p>
          </div>
        </div>
      </li>
    </ol>

    <div
      v-if="allComplete"
      class="border-success/40 bg-success/10 space-y-2 rounded-lg border p-4 text-center"
    >
      <UIcon name="i-lucide-party-popper" class="text-success mx-auto size-8" />
      <p class="text-highlighted font-medium">
        Bringup complete!
      </p>
      <p class="text-muted text-sm">
        Your drone has the basics sorted. Next up: failsafes, filter tuning,
        and PIDs — those land as more wizards in later slices.
      </p>
      <UButton class="mt-2" color="primary" @click="backToLibrary">
        Back to the wizard library
      </UButton>
    </div>
  </div>
</template>
