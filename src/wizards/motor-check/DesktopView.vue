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

// Desktop view for the motor-check wizard (docs/BRINGUP.md phase 04).
// Walks the operator, props OFF, through every motor in motor-number
// order. For each one the wizard spins it, shows which motor number it's
// driving and where that motor SHOULD be (highlighted on the drone), and
// asks the operator to confirm the motor that actually moved + which way
// it turned. Observations are compared against the firmware frame
// geometry and reported per motor.
//
// A props-in/out toggle (default props-in) sets which way each motor
// should turn. When something's wrong the review turns from report into
// fix: planCorrection() prefers switching FRAME_TYPE to a standard layout
// that matches the observed wiring + orientation, falls back to a
// SERVOn_FUNCTION remap, and reverses residual motors via SERVO_BLH_RVMASK
// (gated on the FC exposing it). "Fix this for me" writes the change,
// restarts the drone, reconnects, and re-runs the check. See docs/WIZARDS.md.
//
// Spinning goes through MAV_CMD_DO_MOTOR_TEST (props off, landed, safety
// off). An emergency Stop is always one tap away while a motor is live,
// and we stop the motor on unmount + when stepping, so a motor is never
// left spinning.

import type { CommandAck } from 'mavlink-mappings/dist/lib/common'
import type { MotorVisual } from '../../ui/visuals/MotorCheck3D.vue'
import type { CorrectionPlan } from '../../workflow/motor-check'
import type { FrameGeometry, FrameMotor, MotorPosition, Spin } from '../../workflow/motor-geometry'
import { PerspectiveCamera, Vector3 } from 'three'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { buildMotorTest, buildMotorTestStop, MOTOR_TEST_PWM_SPIN } from '../../protocol/motors'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import WizardSteps from '../../ui/components/WizardSteps.vue'
import MotorCheck3D from '../../ui/visuals/MotorCheck3D.vue'
import {
  applyReverseMask,
  collectMotorChannels,
  planCorrection,
  remapParamEdits,
  REVERSE_MASK_PARAM,
  servoFunctionParam,
} from '../../workflow/motor-check'
import { expectedSpin, frameGeometry, frameVariants, motorTopdownXY, positionLabel, spinLabel } from '../../workflow/motor-geometry'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from '../../workflow/reconnect'
import EscSetup from './EscSetup.vue'

// Skip the ESC-setup phase and open straight on the safety gate. Used when
// the wizard is embedded somewhere that already owns the ESC config — the
// bringup ribbon surfaces protocol + RPM telemetry as inline quick controls
// on its Motors panel, so the embedded check is just the order/direction
// procedure. Standalone (route-mounted) the prop is absent → ESC-setup first.
const props = withDefaults(defineProps<{ skipEsc?: boolean }>(), { skipEsc: false })
const WIZARD_ID = 'motor-check'
const COMP_ID_AUTOPILOT = 1
const MSGID_COMMAND_ACK = 77
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0
const FRAME_CLASS_QUAD = 1
const FRAME_TYPE_X = 1
// Generous spin so the operator has time to look + answer without the
// motor cutting out mid-thought. Stopped explicitly when stepping/leaving.
const SPIN_TIMEOUT_SEC = 20
const ACK_TIMEOUT_MS = 2000

const session = useSessionStore()
const params = useParamsStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()
const { autoReconnect } = useReconnect()

const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

type Phase
  = | 'loading' | 'unsupported' | 'esc-setup' | 'safety' | 'testing' | 'review'
    | 'correcting' | 'restarting' | 'reconnect-failed' | 'error'
const phase = ref<Phase>('loading')
const errorMessage = ref<string | null>(null)

// Operator-facing phase rail (docs/UX.md): the four steps of "Set up
// motors". Transient sub-states (applying a fix, restarting, reconnecting)
// map onto the step they belong to; off-flow states (loading / unsupported
// / error) hide the rail entirely.
// ESC setup drops out of the rail when the host owns it (skipEsc).
const WIZARD_STEPS = computed(() =>
  props.skipEsc
    ? ['Safety', 'Check motors', 'Results']
    : ['ESC setup', 'Safety', 'Check motors', 'Results'],
)
const flowStep = computed(() => {
  const offset = props.skipEsc ? 1 : 0
  switch (phase.value) {
    case 'esc-setup': return 0
    case 'safety': return 1 - offset
    case 'testing': return 2 - offset
    case 'review':
    case 'correcting':
    case 'restarting':
    case 'reconnect-failed': return 3 - offset
    default: return -1
  }
})

// The connected frame's motors, in the firmware's test order — a
// clockwise sweep from the front-right, which is the order operators
// expect to watch motors spin in. Each step still shows its motor number.
const motors = ref<FrameMotor[]>([])
const frameLabel = ref('')
// Full geometry kept so the review step can compute corrections.
const geometry = ref<FrameGeometry | null>(null)
// The vendored airframe model is a quad-X; use it only for that frame and
// draw a simple accurate arms-per-motor model for everything else.
const useArmsModel = computed(() =>
  !(geometry.value?.frameClass === FRAME_CLASS_QUAD && geometry.value?.frameType === FRAME_TYPE_X),
)

const propsOff = ref(false)
// Propeller orientation the operator is building for. Default props-in
// (ArduPilot standard); the toggle switches to props-out (Betaflight
// standard), which flips every motor's expected spin and targets a
// props-out frame type.
const propsOut = ref(false)
// The fix plan for a failed check (null while all-clear / before review).
const plan = ref<CorrectionPlan | null>(null)
// Set after a fix + restart so the re-run safety screen says so.
const justFixed = ref(false)

// Expected spin for a motor under the operator's chosen props orientation,
// relative to the connected frame.
function motorExpectedSpin(m: FrameMotor): Spin {
  const geo = geometry.value
  return geo ? expectedSpin(m, propsOut.value, geo) : m.spin
}

// What the operator reported, keyed by test order.
interface Observation { position: MotorPosition, spin: Spin }
const observations = ref<Map<number, Observation>>(new Map())

// Per-step state.
const stepIndex = ref(0)
const spinning = ref(false)
const selPosition = ref<MotorPosition | null>(null)
const selSpin = ref<Spin | null>(null)

const currentMotor = computed<FrameMotor | undefined>(() => motors.value[stepIndex.value])
// Motor NUMBER the operator sees — the firmware Motor{n}, 1-based.
const motorNumber = computed(() => (currentMotor.value?.motorIndex ?? 0) + 1)
const isLastStep = computed(() => stepIndex.value >= motors.value.length - 1)

onMounted(async () => {
  if (!session.connected || session.sysid === null) {
    phase.value = 'error'
    errorMessage.value = 'Please connect to your drone first, then come back.'
    return
  }
  try {
    // Always refetch: the frame and motor-output assignments
    // (SERVOn_FUNCTION) may have changed since params were last loaded —
    // e.g. the operator just ran frame-select, which the FC applies live
    // (it reassigns the motor outputs) — and we're about to spin motors
    // based on them.
    await params.load()
    const cls = params.params.get('FRAME_CLASS')
    const typ = params.params.get('FRAME_TYPE')
    if (!cls || !typ) {
      phase.value = 'unsupported'
      errorMessage.value = 'We couldn\'t read your drone\'s frame layout. Run "Pick your frame" first, then come back.'
      return
    }
    const frameType = Math.trunc(typ.value)
    const geo = frameGeometry(Math.trunc(cls.value), frameType)
    if (!geo) {
      phase.value = 'unsupported'
      errorMessage.value = 'This frame isn\'t supported by the motor check yet — quad, hexa, and octa (X and +) for now.'
      return
    }
    // geo.motors is already in test order (clockwise from front-right).
    geometry.value = geo
    motors.value = geo.motors
    frameLabel.value = geo.label
    // ESC setup runs first (it determines whether DShot direction-fix is
    // available); it advances to the safety gate when done. When the host
    // already owns ESC config (the ribbon), skip straight to the safety gate.
    phase.value = props.skipEsc ? 'safety' : 'esc-setup'
  }
  catch (e) {
    phase.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
})

onUnmounted(() => {
  void stopActiveMotor()
})

// Send a DO_MOTOR_TEST and wait for the FC's COMMAND_ACK. true = the FC
// accepted (motor will spin); false = rejected (not landed / safety on).
async function spinMotor(testOrder: number): Promise<boolean> {
  if (session.sysid === null)
    return false
  const targetSys = session.sysid
  return new Promise<boolean>((resolve) => {
    let unsub: (() => void) | null = null
    const timer = setTimeout(() => {
      unsub?.()
      resolve(false)
    }, ACK_TIMEOUT_MS)
    unsub = session.subscribeMessages((msg) => {
      if (msg.msgid !== MSGID_COMMAND_ACK)
        return
      const ack = msg.data as CommandAck
      if ((ack.command as number) !== MAV_CMD_DO_MOTOR_TEST)
        return
      clearTimeout(timer)
      unsub?.()
      resolve(ack.result === MAV_RESULT_ACCEPTED)
    })
    session.sendMessage(
      buildMotorTest(targetSys, COMP_ID_AUTOPILOT, testOrder, MOTOR_TEST_PWM_SPIN, SPIN_TIMEOUT_SEC),
    ).catch(() => {
      clearTimeout(timer)
      unsub?.()
      resolve(false)
    })
  })
}

async function stopActiveMotor() {
  const m = currentMotor.value
  if (!m || session.sysid === null)
    return
  await session.sendMessage(
    buildMotorTestStop(session.sysid, COMP_ID_AUTOPILOT, m.testOrder),
  ).catch(() => {})
}

// Begin the sequence (props-off confirmed). Enters the first step, which
// auto-spins motor 1.
function start() {
  observations.value = new Map()
  stepIndex.value = 0
  justFixed.value = false
  phase.value = 'testing'
  void enterStep()
}

// Set up the current step: restore any prior answer (default the position
// to where the motor SHOULD be), then spin it.
async function enterStep() {
  const m = currentMotor.value
  if (!m)
    return
  // Default both the position and the direction to what the firmware
  // expects, so the graphic shows the expected motor spinning the expected
  // way; the operator only changes them if reality differs.
  const prior = observations.value.get(m.testOrder)
  selPosition.value = prior?.position ?? m.position
  // Expected spin follows the props-in/out choice, not the FC's current
  // frame — so toggling props-out flips what "correct" looks like.
  selSpin.value = prior?.spin ?? motorExpectedSpin(m)
  await spinCurrent()
}

// Spin the current motor; surface a friendly reason if the FC refuses.
async function spinCurrent() {
  const m = currentMotor.value
  if (!m)
    return
  errorMessage.value = null
  const ok = await spinMotor(m.testOrder)
  if (!ok) {
    spinning.value = false
    errorMessage.value = 'Your drone wouldn\'t spin that motor. Make sure it\'s sitting still on the bench with the safety switch off, then try again.'
    return
  }
  spinning.value = true
}

function pickPosition(position: MotorPosition) {
  selPosition.value = position
}
function pickSpin(spin: Spin) {
  selSpin.value = spin
}

// Record the current answer (no-op if incomplete).
function record() {
  const m = currentMotor.value
  if (!m || selPosition.value === null || selSpin.value === null)
    return
  observations.value.set(m.testOrder, { position: selPosition.value, spin: selSpin.value })
}

async function next() {
  record()
  await stopActiveMotor()
  if (isLastStep.value) {
    finish()
    return
  }
  stepIndex.value += 1
  await enterStep()
}

async function back() {
  if (stepIndex.value === 0) {
    leave()
    return
  }
  record()
  await stopActiveMotor()
  stepIndex.value -= 1
  await enterStep()
}

async function emergencyStop() {
  await stopActiveMotor()
  spinning.value = false
}

// Per-motor report shown in the review. Position is judged against the
// current frame; spin against the chosen props orientation.
interface Result { motor: FrameMotor, observed: Observation | undefined, positionOk: boolean, spinOk: boolean }
const results = computed<Result[]>(() =>
  motors.value.map((motor) => {
    const observed = observations.value.get(motor.testOrder)
    return {
      motor,
      observed,
      positionOk: observed?.position === motor.position,
      spinOk: observed?.spin === motorExpectedSpin(motor),
    }
  }),
)

function finish() {
  spinning.value = false
  phase.value = 'review'
  // Work out the fix: read each motor channel's current output function and
  // plan against the standard layouts for this frame class, in the chosen
  // props orientation. Prefers a single FRAME_TYPE change over a remap.
  const geo = geometry.value
  plan.value = geo
    ? planCorrection(
        geo,
        observations.value,
        collectMotorChannels((channel) => {
          const p = params.params.get(servoFunctionParam(channel))
          return p ? Math.trunc(p.value) : undefined
        }),
        propsOut.value,
        frameVariants(geo.frameClass),
      )
    : null
  if (plan.value?.kind === 'none') {
    wizardProgress.markComplete(
      session.fcUid,
      WIZARD_ID,
      `All ${motors.value.length} motors in the right place, turning the right way.`,
    )
  }
}

const allOk = computed(() => plan.value?.kind === 'none')
const isInconsistent = computed(() => plan.value?.kind === 'inconsistent')
const isFrameTypeFix = computed(() => plan.value?.kind === 'frame-type')
const isRemapFix = computed(() => plan.value?.kind === 'remap')

// Does the FC expose the reverse-mask param (BLHeli builds only)? Gates
// whether we can auto-correct an individual motor's spin direction.
const rvmaskPresent = computed(() => params.params.has(REVERSE_MASK_PARAM))

// The plan's per-motor reverse list (a frame-type fix's residual, or the
// direction half of a remap fix).
const reverseChannels = computed<number[]>(() =>
  plan.value && (plan.value.kind === 'frame-type' || plan.value.kind === 'remap')
    ? plan.value.reverseChannels
    : [],
)
// A frame-type fix that actually switches layout (vs one whose only change
// is reversing a motor).
const changesFrame = computed(() =>
  plan.value?.kind === 'frame-type' && plan.value.frameType !== geometry.value?.frameType,
)
const remapsOutputs = computed(() =>
  plan.value?.kind === 'remap' && plan.value.remap.length > 0,
)
// Reverses we can't apply because the FC has no reverse-mask param.
const directionUnfixable = computed(() => reverseChannels.value.length > 0 && !rvmaskPresent.value)
// Anything we can actually write?
const canAutoFix = computed(() =>
  changesFrame.value
  || remapsOutputs.value
  || (reverseChannels.value.length > 0 && rvmaskPresent.value),
)

// Operator-facing description of the fix.
const fixSummary = computed(() => {
  const p = plan.value
  if (!p)
    return ''
  const reverses = rvmaskPresent.value ? reverseChannels.value.length : 0
  if (p.kind === 'frame-type') {
    const base = changesFrame.value
      ? `Your motors match the ${p.layoutName} layout — we'll switch your drone to it`
      : 'We\'ll correct your motors'
    const extra = reverses > 0 ? ` and reverse ${reverses} ${reverses === 1 ? 'motor' : 'motors'}` : ''
    return `${base}${extra}, then restart your drone.`
  }
  const parts: string[] = []
  if (remapsOutputs.value && p.kind === 'remap')
    parts.push(`${p.remap.length} ${p.remap.length === 1 ? 'motor is' : 'motors are'} wired to the wrong spot`)
  if (reverses > 0)
    parts.push(`${reverses} ${reverses === 1 ? 'motor is' : 'motors are'} spinning the wrong way`)
  if (parts.length === 0)
    return 'We found something to correct.'
  const list = parts.join(' and ')
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}. We'll correct it and restart your drone.`
})

// Apply the computed fix: write the order remap (and, where supported, the
// direction reverse), then restart the drone — both params take effect
// only after a reboot — reconnect, and drop back to re-run the check. We
// clear any stray pending edits first so only the motor fix gets written.
async function applyCorrections() {
  const p = plan.value
  if (!p || p.kind === 'none' || p.kind === 'inconsistent' || phase.value === 'correcting')
    return
  params.discardAll()
  if (p.kind === 'frame-type' && changesFrame.value)
    params.setEdit('FRAME_TYPE', p.frameType)
  if (p.kind === 'remap') {
    for (const edit of remapParamEdits(p.remap))
      params.setEdit(edit.name, edit.value)
  }
  if (rvmaskPresent.value && reverseChannels.value.length > 0) {
    const current = Math.trunc(params.params.get(REVERSE_MASK_PARAM)!.value)
    params.setEdit(REVERSE_MASK_PARAM, applyReverseMask(current, reverseChannels.value))
  }
  if (params.dirtyCount === 0)
    return

  phase.value = 'correcting'
  errorMessage.value = null
  await params.apply()
  if (params.lastApplyFailed > 0) {
    params.discardAll()
    phase.value = 'review'
    errorMessage.value = 'We couldn\'t save the fix to your drone. Check the connection and try again.'
    return
  }

  phase.value = 'restarting'
  await sleep(STORAGE_SETTLE_MS)
  await session.reboot()
  await reconnectThenReverify()
}

// Manual fallback from reconnect-failed — re-run the reconnect loop.
function retryReconnect() {
  void reconnectThenReverify()
}

// Wait for the drone back, reload its params, and return to the safety
// gate so the operator confirms the fix worked. Falls to reconnect-failed
// if it doesn't come back in time.
async function reconnectThenReverify() {
  phase.value = 'restarting'
  const back = await autoReconnect()
  if (!back) {
    phase.value = 'reconnect-failed'
    errorMessage.value = 'Your drone restarted but we couldn\'t reconnect. Make sure it\'s powered, then try again.'
    return
  }
  params.clear()
  await params.load()
  justFixed.value = true
  runAgain()
}

function runAgain() {
  observations.value = new Map()
  stepIndex.value = 0
  spinning.value = false
  plan.value = null
  phase.value = 'safety'
}

function leave() {
  router.push(returnTo.value)
}

// The spin direction the graphic should animate: the operator's choice
// once they've made one, otherwise the expected spin of the motor they
// currently have selected (a sensible default preview).
const displaySpin = computed<Spin>(() => {
  if (selSpin.value)
    return selSpin.value
  const sel = motors.value.find(m => m.position === selPosition.value)
  return sel ? motorExpectedSpin(sel) : 'cw'
})

// 3D states. While testing, the graphic mirrors the operator's answer:
// the motor they've selected as "the one that moved" is highlighted and
// its prop spins the way they say (defaulting to the expected direction
// until they pick). In review, motors go green/red by result.
const motorVisuals = computed<MotorVisual[]>(() =>
  motors.value.map((m) => {
    let state: MotorVisual['state'] = 'idle'
    let spin = motorExpectedSpin(m)
    if (phase.value === 'testing') {
      if (m.position === selPosition.value) {
        state = 'active'
        spin = displaySpin.value
      }
    }
    else if (phase.value === 'review') {
      const r = results.value.find(x => x.motor.testOrder === m.testOrder)
      state = r && r.positionOk && r.spinOk ? 'done' : 'mismatch'
    }
    return { key: m.testOrder, angleDeg: m.angleDeg, spin, state }
  }),
)

// Project each motor's world position onto the (square) canvas so a text
// label can sit precisely over it. Camera params MUST match the
// TresPerspectiveCamera in MotorCheck3D.vue. RING_R/RING_Y mirror its
// motor placement; the +0.4 lifts the label just above the motor.
const projCam = new PerspectiveCamera(50, 1, 0.1, 1000)
projCam.position.set(0, 3.25, 1.05)
projCam.lookAt(0, 0, 0)
projCam.updateMatrixWorld()
function labelStyle(angleDeg: number): Record<string, string> {
  const { x, y: sy } = motorTopdownXY(angleDeg)
  const ndc = new Vector3(x * 1.05, 0.12 + 0.65, sy * 1.05).project(projCam)
  return {
    left: `${(ndc.x * 0.5 + 0.5) * 100}%`,
    top: `${(-ndc.y * 0.5 + 0.5) * 100}%`,
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Phase rail — shown for the main flow, hidden for off-flow states. -->
    <WizardSteps v-if="flowStep >= 0" :steps="WIZARD_STEPS" :current="flowStep" class="pb-1" />

    <!-- loading -->
    <div v-if="phase === 'loading'" class="py-8 text-center text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      <p class="mt-2 text-sm">
        Reading your drone's motor layout…
      </p>
    </div>

    <!-- unsupported -->
    <div v-else-if="phase === 'unsupported'" class="space-y-3">
      <UAlert color="warning" title="Can't check motors yet">
        <template #description>
          {{ errorMessage }}
        </template>
      </UAlert>
      <div class="flex justify-end">
        <UButton color="neutral" variant="outline" @click="leave">
          Back to library
        </UButton>
      </div>
    </div>

    <!-- ESC setup — first phase; advances to the safety gate when done -->
    <EscSetup v-else-if="phase === 'esc-setup'" @done="phase = 'safety'" />

    <!-- safety gate -->
    <div v-else-if="phase === 'safety'" class="space-y-4">
      <UAlert
        v-if="justFixed"
        color="success"
        icon="i-lucide-circle-check"
        title="Fix applied — let's check again"
        description="We corrected the wiring and restarted your drone. Run the check once more to confirm everything's right."
      />
      <UAlert
        color="error"
        icon="i-lucide-triangle-alert"
        title="Remove all propellers first"
        description="This spins your motors one at a time. Take every propeller off before you start — a spinning prop can injure you."
      />
      <p class="text-muted text-sm">
        We'll spin each of your <strong>{{ frameLabel }}</strong>'s
        {{ motors.length }} motors in turn. Watch your drone and confirm each
        one is where it should be and turning the right way.
      </p>
      <div class="border-default flex items-center gap-3 rounded-lg border p-3">
        <USwitch v-model="propsOff" color="error" aria-label="Propellers are removed" />
        <span class="text-default text-sm">
          I've removed all propellers.
        </span>
      </div>
      <div class="border-default flex items-center justify-between gap-3 rounded-lg border p-3">
        <div>
          <span class="text-default text-sm font-medium">Props-out build</span>
          <p class="text-muted text-xs">
            Turn on if your propellers spin outward at the front — the Betaflight
            default. Most builds are props-in; leave this off if you're not sure.
          </p>
        </div>
        <USwitch v-model="propsOut" color="primary" aria-label="Props-out build" />
      </div>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="leave">
          Cancel
        </UButton>
        <UButton color="primary" :disabled="!propsOff" @click="start">
          Start motor check
        </UButton>
      </div>
    </div>

    <!-- testing -->
    <div v-else-if="phase === 'testing'" class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <div>
          <p class="text-highlighted text-lg font-semibold">
            {{ currentMotor ? positionLabel(currentMotor.position) : '' }} motor
          </p>
          <p class="text-muted text-xs">
            Motor {{ motorNumber }} · {{ stepIndex + 1 }} of {{ motors.length }}
          </p>
        </div>
        <UButton
          v-if="spinning"
          color="error"
          icon="i-lucide-octagon-x"
          @click="emergencyStop"
        >
          Stop
        </UButton>
      </div>

      <div class="relative mx-auto aspect-square w-full max-w-sm">
        <MotorCheck3D :motors="motorVisuals" :arms="useArmsModel" />
        <div
          v-for="m in motors"
          :key="m.testOrder"
          class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium"
          :class="selPosition === m.position
            ? 'bg-amber-500 text-white shadow'
            : 'bg-black/55 text-white/90'"
          :style="labelStyle(m.angleDeg)"
        >
          {{ positionLabel(m.position) }}
        </div>
      </div>

      <UAlert v-if="errorMessage" color="warning" :description="errorMessage" />

      <template v-else>
        <!-- which motor moved -->
        <div class="space-y-2">
          <p class="text-default text-center text-sm">
            Which motor on your drone moved?
          </p>
          <div class="flex flex-wrap justify-center gap-2">
            <UButton
              v-for="m in motors"
              :key="m.testOrder"
              :color="selPosition === m.position ? 'primary' : 'neutral'"
              :variant="selPosition === m.position ? 'solid' : 'outline'"
              size="sm"
              :ui="{ base: 'justify-center' }"
              class="w-32"
              @click="pickPosition(m.position)"
            >
              {{ positionLabel(m.position) }}
            </UButton>
          </div>
        </div>

        <!-- which direction -->
        <div class="space-y-2">
          <p class="text-default text-center text-sm">
            Which way did it turn?
          </p>
          <div class="flex justify-center gap-2">
            <UButton
              :color="selSpin === 'ccw' ? 'primary' : 'neutral'"
              :variant="selSpin === 'ccw' ? 'solid' : 'outline'"
              icon="i-lucide-rotate-ccw"
              :ui="{ base: 'justify-center' }"
              class="w-48"
              @click="pickSpin('ccw')"
            >
              Counter-clockwise
            </UButton>
            <UButton
              :color="selSpin === 'cw' ? 'primary' : 'neutral'"
              :variant="selSpin === 'cw' ? 'solid' : 'outline'"
              icon="i-lucide-rotate-cw"
              :ui="{ base: 'justify-center' }"
              class="w-48"
              @click="pickSpin('cw')"
            >
              Clockwise
            </UButton>
          </div>
        </div>
      </template>

      <!-- navigation -->
      <div class="flex items-center justify-between gap-2 pt-1">
        <UButton color="neutral" variant="ghost" icon="i-lucide-arrow-left" @click="back">
          {{ stepIndex === 0 ? 'Cancel' : 'Back' }}
        </UButton>
        <div class="flex gap-2">
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-rotate-cw" @click="spinCurrent">
            Spin again
          </UButton>
          <UButton color="primary" :disabled="!selPosition || !selSpin" icon="i-lucide-arrow-right" @click="next">
            {{ isLastStep ? 'Finish' : 'Next motor' }}
          </UButton>
        </div>
      </div>
    </div>

    <!-- review -->
    <div v-else-if="phase === 'review'" class="space-y-4">
      <div class="mx-auto aspect-square w-full max-w-xs">
        <MotorCheck3D :motors="motorVisuals" :arms="useArmsModel" />
      </div>

      <div v-if="allOk" class="space-y-2 py-2 text-center">
        <UIcon name="i-lucide-circle-check" class="text-success mx-auto size-10" />
        <h2 class="text-highlighted text-lg font-semibold">
          Motors all check out
        </h2>
        <p class="text-muted text-sm">
          Every motor is where it should be and turning the right way.
        </p>
      </div>

      <div v-else class="space-y-3">
        <!-- answers don't form a valid layout — no safe fix to offer -->
        <UAlert
          v-if="isInconsistent"
          color="warning"
          icon="i-lucide-triangle-alert"
          title="Those answers don't add up"
          description="A couple of motors were reported in the same spot, so we can't work out a safe fix. Give it another go, watching each motor carefully."
        />

        <!-- observed wiring matches a standard layout — switch to it -->
        <template v-else-if="isFrameTypeFix">
          <UAlert
            color="primary"
            icon="i-lucide-wand-2"
            title="Your motors match a standard layout"
            :description="fixSummary"
          />
          <UAlert
            v-if="directionUnfixable"
            color="info"
            icon="i-lucide-info"
            title="One motor can't be reversed automatically here"
            description="This drone can't reverse a motor from software. To flip a motor's spin, swap any two of its three wires (or change it in your ESC setup), then run this check again."
          />
        </template>

        <!-- non-standard wiring — remap individual outputs + report -->
        <template v-else-if="isRemapFix">
          <UAlert
            color="warning"
            icon="i-lucide-wrench"
            title="Some motors need attention"
            :description="fixSummary"
          />
          <UAlert
            v-if="directionUnfixable"
            color="info"
            icon="i-lucide-info"
            title="Direction can't be fixed automatically here"
            description="This drone can't reverse a motor from software. To flip a motor's spin, swap any two of its three wires (or change it in your ESC setup), then run this check again."
          />
          <ul class="space-y-2">
            <li
              v-for="r in results"
              :key="r.motor.testOrder"
              class="border-default flex items-start gap-2 rounded-lg border p-2 text-sm"
            >
              <UIcon
                :name="r.positionOk && r.spinOk ? 'i-lucide-check' : 'i-lucide-x'"
                :class="r.positionOk && r.spinOk ? 'text-success' : 'text-error'"
                class="mt-0.5 size-4 shrink-0"
              />
              <div>
                <span class="text-highlighted font-medium">Motor {{ r.motor.motorIndex + 1 }}</span>
                <span class="text-muted"> ({{ positionLabel(r.motor.position) }})</span>
                <span v-if="r.positionOk && r.spinOk" class="text-muted"> — correct</span>
                <template v-else>
                  <span v-if="!r.positionOk" class="text-error">
                    — you saw it move at {{ r.observed ? positionLabel(r.observed.position) : 'nowhere' }}
                  </span>
                  <span v-else-if="!r.spinOk" class="text-error">
                    — turning {{ r.observed ? spinLabel(r.observed.spin) : '?' }},
                    should be {{ spinLabel(motorExpectedSpin(r.motor)) }}
                  </span>
                </template>
              </div>
            </li>
          </ul>
        </template>
      </div>

      <UAlert v-if="errorMessage" color="error" :description="errorMessage" />

      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="runAgain">
          Run again
        </UButton>
        <UButton v-if="canAutoFix" color="primary" icon="i-lucide-wand-2" @click="applyCorrections">
          Fix this for me
        </UButton>
        <UButton v-else color="primary" @click="leave">
          Back to library
        </UButton>
      </div>
    </div>

    <!-- correcting: writing the fix -->
    <div v-else-if="phase === 'correcting'" class="py-8 text-center text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      <p class="mt-2 text-sm">
        Saving the fix to your drone…
      </p>
    </div>

    <!-- restarting: reboot + automatic reconnect -->
    <div v-else-if="phase === 'restarting'">
      <UAlert
        color="info"
        icon="i-lucide-loader-circle"
        title="Restarting your drone…"
        description="The connection will drop for a few seconds while it restarts. We'll reconnect automatically and check the motors again — no need to do anything."
      />
    </div>

    <!-- reconnect-failed: auto-reconnect gave up, manual fallback -->
    <div v-else-if="phase === 'reconnect-failed'" class="space-y-3">
      <UAlert color="warning" title="Couldn't reconnect automatically">
        <template #description>
          {{ errorMessage }}
        </template>
      </UAlert>
      <div class="flex justify-end">
        <UButton color="primary" @click="retryReconnect">
          Reconnect
        </UButton>
      </div>
    </div>

    <!-- error -->
    <div v-else class="space-y-3 py-6 text-center">
      <UIcon name="i-lucide-circle-alert" class="text-error mx-auto size-10" />
      <h2 class="text-highlighted text-lg font-semibold">
        Couldn't run the motor check
      </h2>
      <p class="text-muted text-sm">
        {{ errorMessage }}
      </p>
      <UButton color="neutral" @click="leave">
        Back to library
      </UButton>
    </div>
  </div>
</template>
