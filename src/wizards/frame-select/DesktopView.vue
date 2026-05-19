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

// Desktop view for the frame-select wizard. Renders a grid of motor-
// layout cards, lets the operator pick one, and on confirm writes
// FRAME_CLASS + FRAME_TYPE through the params store's dirty/apply
// pipeline. The hero visual on each card is a tiny topdown SVG showing
// the actual motor positions for that frame, with a forward-direction
// arrow so operators can match it against their physical drone.

import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'

const session = useSessionStore()
const paramsStore = useParamsStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()

// Frame option a card represents — visible to the operator under a
// plain-language label, but the underlying FRAME_CLASS + FRAME_TYPE
// integer pair is what gets written.
interface FrameOption {
  id: string
  label: string
  description: string
  class_: number
  type_: number
}

// The frames slice A supports. Covers the common multicopter layouts;
// Y6, OctaQuad, Heli, Tri, etc. ship in later slices once the wizard
// pattern is settled.
const FRAMES: FrameOption[] = [
  { id: 'quad-x', label: 'Quad X', description: 'Four motors at the corners — the most common layout.', class_: 1, type_: 1 },
  { id: 'quad-plus', label: 'Quad Plus', description: 'Four motors at front, back, left, right.', class_: 1, type_: 0 },
  { id: 'quad-h', label: 'Quad H', description: 'Like Quad X but with a rectangular body.', class_: 1, type_: 3 },
  { id: 'hex-x', label: 'Hex X', description: 'Six motors with two facing forward.', class_: 2, type_: 1 },
  { id: 'hex-plus', label: 'Hex Plus', description: 'Six motors with one facing forward.', class_: 2, type_: 0 },
  { id: 'octo-x', label: 'Octo X', description: 'Eight motors arranged in an X.', class_: 3, type_: 1 },
  { id: 'octo-plus', label: 'Octo Plus', description: 'Eight motors arranged in a Plus.', class_: 3, type_: 0 },
]

// Wizard state machine.
type Phase = 'loading' | 'picking' | 'confirming' | 'applying' | 'done' | 'error'
const phase = ref<Phase>('loading')
const selectedId = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const selected = computed<FrameOption | null>(() =>
  FRAMES.find(f => f.id === selectedId.value) ?? null,
)

// Compute motor positions for a (class, type) pair. Origin is centre,
// forward is up (negative Y in SVG coords). Returns positions in a
// -100..100 viewBox; consumers add a viewBox of -100 -100 200 200.
function motorPositions(class_: number, type_: number): { x: number, y: number }[] {
  if (class_ === 1) {
    if (type_ === 0)
      return polarN(4, 0) // Quad Plus
    return polarN(4, 45) // Quad X / H — visually equivalent topdown
  }
  if (class_ === 2)
    return polarN(6, type_ === 1 ? 30 : 0) // Hex X / Plus
  if (class_ === 3)
    return polarN(8, type_ === 1 ? 22.5 : 0) // Octo X / Plus
  return []
}

// N motors evenly spaced around a circle, starting at startDeg measured
// clockwise from forward (up). SVG y is positive-down so we offset the
// angle to put 0° at top.
function polarN(n: number, startDeg: number): { x: number, y: number }[] {
  const radius = 70
  const out: { x: number, y: number }[] = []
  for (let i = 0; i < n; i++) {
    const deg = startDeg + (360 * i / n)
    const rad = ((deg - 90) * Math.PI) / 180
    out.push({ x: radius * Math.cos(rad), y: radius * Math.sin(rad) })
  }
  return out
}

// Wait for an in-flight params store load to complete. Resolves the
// next time the store's `loading` flag flips false. Used when the
// wizard mounts and finds load() already running (e.g. the operator
// clicked Refresh in the param browser moments earlier) — in that case
// paramsStore.load() itself returns immediately, so we have to watch
// the flag rather than just await it.
function waitForLoad(): Promise<void> {
  return new Promise((resolve) => {
    const stop = watch(
      () => paramsStore.loading,
      (loading) => {
        if (!loading) {
          stop()
          resolve()
        }
      },
    )
  })
}

// On entry: make sure we have the FC's current parameter set, then
// confirm FRAME_CLASS + FRAME_TYPE are part of it. setEdit() is a
// silent no-op for unknown params, so the wizard cannot advance into
// picking until both names are present — otherwise the operator would
// see a successful-looking flow that wrote nothing.
onMounted(async () => {
  if (!session.connected || session.sysid === null) {
    phase.value = 'error'
    errorMessage.value = 'Please connect to your drone first, then come back.'
    return
  }

  // Trigger a fetch if we haven't done one yet; if one is already
  // running, just wait it out.
  if (paramsStore.count === 0 && !paramsStore.loading) {
    await paramsStore.load()
  }
  else if (paramsStore.loading) {
    await waitForLoad()
  }

  if (paramsStore.error) {
    phase.value = 'error'
    errorMessage.value = `Couldn't load your drone's settings: ${paramsStore.error}. Try again, or check the connection.`
    return
  }

  if (!paramsStore.params.has('FRAME_CLASS') || !paramsStore.params.has('FRAME_TYPE')) {
    phase.value = 'error'
    errorMessage.value = 'Your drone\'s firmware doesn\'t expose the frame settings this wizard configures — that means it isn\'t a multicopter, or it\'s running a build with frame selection compiled out.'
    return
  }

  phase.value = 'picking'
})

// Operator hit Retry from an error state. Reset to loading and run the
// onMounted logic again — covers transient fetch failures and the case
// where the operator reconnected after the wizard hit the no-connection
// branch.
async function retry() {
  errorMessage.value = null
  phase.value = 'loading'

  if (!session.connected || session.sysid === null) {
    phase.value = 'error'
    errorMessage.value = 'Please connect to your drone first, then come back.'
    return
  }
  if (paramsStore.count === 0 && !paramsStore.loading) {
    await paramsStore.load()
  }
  else if (paramsStore.loading) {
    await waitForLoad()
  }
  if (paramsStore.error) {
    phase.value = 'error'
    errorMessage.value = `Couldn't load your drone's settings: ${paramsStore.error}. Try again, or check the connection.`
    return
  }
  if (!paramsStore.params.has('FRAME_CLASS') || !paramsStore.params.has('FRAME_TYPE')) {
    phase.value = 'error'
    errorMessage.value = 'Your drone\'s firmware doesn\'t expose the frame settings this wizard configures — that means it isn\'t a multicopter, or it\'s running a build with frame selection compiled out.'
    return
  }
  phase.value = 'picking'
}

// Operator clicked a frame card. Just record the pick; the dedicated
// confirm step keeps Next-equals-action surprises off the table.
function pick(option: FrameOption) {
  selectedId.value = option.id
  phase.value = 'confirming'
}

// Operator pressed the back affordance from confirm — return to the
// grid without losing the previous selection (it stays highlighted).
function backToPicking() {
  phase.value = 'picking'
}

// True when the picked frame matches the FC's current configuration
// for both params — covered out separately so confirm() can short-
// circuit instead of writing nothing and looking broken.
const noChangeNeeded = ref(false)

// Operator confirmed. Stage the two param edits and hand off to the
// params store's apply pipeline. Three outcomes:
//
//   - Params aren't in the store at all → real error (the onMounted
//     guard should already have caught this, but it's checked again
//     for defence-in-depth in case the store was cleared between
//     mount and confirm).
//   - Picked frame matches what the FC already has → setEdit() is a
//     no-op for both params, nothing is dirty, we short-circuit to
//     done with a "no change needed" note. (This is the case that
//     used to mis-fire the "doesn't expose" error.)
//   - Picked frame is different → apply through the params store,
//     classify based on the store's failed counter.
async function confirm() {
  if (!selected.value)
    return
  phase.value = 'applying'
  errorMessage.value = null
  noChangeNeeded.value = false

  const target = selected.value

  if (!paramsStore.params.has('FRAME_CLASS') || !paramsStore.params.has('FRAME_TYPE')) {
    phase.value = 'error'
    errorMessage.value = 'Your drone\'s settings no longer include the frame parameters — try reconnecting and starting over.'
    return
  }

  paramsStore.setEdit('FRAME_CLASS', target.class_)
  paramsStore.setEdit('FRAME_TYPE', target.type_)

  // No dirty entries means both setEdit calls saw the new value equal
  // the current FC value. The drone is already configured the way the
  // operator just picked — that's a successful no-op, not a failure.
  if (!paramsStore.isDirty('FRAME_CLASS') && !paramsStore.isDirty('FRAME_TYPE')) {
    noChangeNeeded.value = true
    phase.value = 'done'
    wizardProgress.markComplete(session.fcUid, 'frame-select', `Already a ${target.label}`)
    return
  }

  await paramsStore.apply()

  if (paramsStore.lastApplyFailed > 0) {
    phase.value = 'error'
    errorMessage.value = 'One or more settings didn\'t take. Open expert mode → Parameters to see what happened.'
    return
  }
  phase.value = 'done'
  wizardProgress.markComplete(session.fcUid, 'frame-select', `Set as a ${target.label}`)
}

// Return to the library — bound to the Done button after a successful
// apply, and to Cancel from the confirm step.
function back() {
  router.push('/wizard')
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="phase === 'loading'" class="py-12 text-center text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      <p class="mt-2 text-sm">
        Loading your drone's current settings…
      </p>
      <p
        v-if="paramsStore.progress"
        class="mt-1 text-xs"
      >
        {{ paramsStore.progress.received }} of {{ paramsStore.progress.total }}
      </p>
    </div>

    <div v-else-if="phase === 'picking' || phase === 'confirming'">
      <p class="text-muted text-sm">
        Look at the top of your drone and pick the layout that matches. Forward
        is the way the arrow points.
      </p>

      <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <button
          v-for="f in FRAMES"
          :key="f.id"
          type="button"
          class="flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition-colors"
          :class="selectedId === f.id
            ? 'border-primary bg-primary/10'
            : 'border-default hover:border-primary hover:bg-elevated'"
          :aria-pressed="selectedId === f.id"
          @click="pick(f)"
        >
          <svg viewBox="-100 -100 200 200" class="size-20 text-default">
            <!-- arms -->
            <line
              v-for="(m, i) in motorPositions(f.class_, f.type_)"
              :key="`arm-${i}`"
              :x1="0"
              :y1="0"
              :x2="m.x"
              :y2="m.y"
              stroke="currentColor"
              stroke-width="6"
              stroke-linecap="round"
            />
            <!-- body -->
            <rect x="-18" y="-18" width="36" height="36" rx="4" fill="currentColor" />
            <!-- motors -->
            <circle
              v-for="(m, i) in motorPositions(f.class_, f.type_)"
              :key="`motor-${i}`"
              :cx="m.x"
              :cy="m.y"
              r="10"
              fill="currentColor"
            />
            <!-- forward indicator -->
            <polygon
              points="0,-95 -7,-82 7,-82"
              class="fill-primary"
            />
          </svg>
          <span class="text-sm font-medium text-highlighted">{{ f.label }}</span>
        </button>
      </div>

      <div
        v-if="phase === 'confirming' && selected"
        class="border-default mt-6 border-t pt-4"
      >
        <p class="text-default">
          Set your drone up as a
          <span class="font-semibold text-highlighted">{{ selected.label }}</span>?
          <span class="text-muted">{{ selected.description }}</span>
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="backToPicking">
            Cancel
          </UButton>
          <UButton color="primary" @click="confirm">
            Apply
          </UButton>
        </div>
      </div>
    </div>

    <div v-else-if="phase === 'applying'" class="py-12 text-center">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-primary" />
      <p class="mt-2 text-sm text-default">
        Writing to your drone…
      </p>
    </div>

    <div v-else-if="phase === 'done'" class="py-8 text-center">
      <UIcon name="i-lucide-circle-check" class="text-success size-10" />
      <h2 class="text-highlighted mt-3 text-lg font-semibold">
        Done — your drone knows its motor layout.
      </h2>
      <p v-if="selected" class="text-muted mt-1 text-sm">
        <template v-if="noChangeNeeded">
          Already set as a {{ selected.label }} — nothing to write.
        </template>
        <template v-else>
          Set as a {{ selected.label }}.
        </template>
      </p>
      <UButton class="mt-4" color="primary" @click="back">
        Back to the wizard library
      </UButton>
    </div>

    <div v-else-if="phase === 'error'" class="py-6 text-center">
      <UIcon name="i-lucide-circle-alert" class="text-error size-10" />
      <h2 class="text-highlighted mt-3 text-lg font-semibold">
        Couldn't finish setting your frame
      </h2>
      <p class="text-muted mt-1 text-sm">
        {{ errorMessage }}
      </p>
      <div class="mt-4 flex justify-center gap-2">
        <UButton color="primary" variant="outline" @click="retry">
          Retry
        </UButton>
        <UButton color="neutral" @click="back">
          Back to the library
        </UButton>
      </div>
    </div>
  </div>
</template>
