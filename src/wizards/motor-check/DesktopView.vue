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
// This slice detects + reports. Auto-correction (output remap via
// SERVOn_FUNCTION + direction reverse via SERVO_BLH_RVMASK, with a
// reboot) lands in a follow-up; see docs/WIZARDS.md.
//
// Spinning goes through MAV_CMD_DO_MOTOR_TEST (props off, landed, safety
// off). An emergency Stop is always one tap away while a motor is live,
// and we stop the motor on unmount + when stepping, so a motor is never
// left spinning.

import type { CommandAck } from 'mavlink-mappings/dist/lib/common'
import type { MotorVisual } from '../../ui/visuals/MotorCheck3D.vue'
import type { FrameMotor, MotorPosition, Spin } from '../../workflow/motor-geometry'
import { PerspectiveCamera, Vector3 } from 'three'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { buildMotorTest, buildMotorTestStop, MOTOR_TEST_PWM_SPIN } from '../../protocol/motors'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import MotorCheck3D from '../../ui/visuals/MotorCheck3D.vue'
import { frameGeometry, motorTopdownXY, positionLabel, spinLabel } from '../../workflow/motor-geometry'

const WIZARD_ID = 'motor-check'
const COMP_ID_AUTOPILOT = 1
const MSGID_COMMAND_ACK = 77
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0
const FRAME_TYPE_PLUS = 0
// Generous spin so the operator has time to look + answer without the
// motor cutting out mid-thought. Stopped explicitly when stepping/leaving.
const SPIN_TIMEOUT_SEC = 20
const ACK_TIMEOUT_MS = 2000

const session = useSessionStore()
const params = useParamsStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()

const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

type Phase = 'loading' | 'unsupported' | 'safety' | 'testing' | 'review' | 'error'
const phase = ref<Phase>('loading')
const errorMessage = ref<string | null>(null)

// The connected frame's motors, in the firmware's test order — a
// clockwise sweep from the front-right, which is the order operators
// expect to watch motors spin in. Each step still shows its motor number.
const motors = ref<FrameMotor[]>([])
const frameLabel = ref('')
// X-frame model rotated 45° for a Plus frame so its arms meet the rings.
const bodyYawDeg = ref(0)

const propsOff = ref(false)

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
    if (params.count === 0)
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
      errorMessage.value = 'This frame isn\'t supported by the motor check yet — only quad layouts for now.'
      return
    }
    // geo.motors is already in test order (clockwise from front-right).
    motors.value = geo.motors
    frameLabel.value = geo.label
    bodyYawDeg.value = frameType === FRAME_TYPE_PLUS ? 45 : 0
    phase.value = 'safety'
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
  selSpin.value = prior?.spin ?? m.spin
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

interface Result { motor: FrameMotor, observed: Observation | undefined, positionOk: boolean, spinOk: boolean }
const results = computed<Result[]>(() =>
  motors.value.map((motor) => {
    const observed = observations.value.get(motor.testOrder)
    return {
      motor,
      observed,
      positionOk: observed?.position === motor.position,
      spinOk: observed?.spin === motor.spin,
    }
  }),
)
const allOk = computed(() => results.value.every(r => r.positionOk && r.spinOk))

function finish() {
  spinning.value = false
  phase.value = 'review'
  if (allOk.value) {
    wizardProgress.markComplete(
      session.fcUid,
      WIZARD_ID,
      `All ${motors.value.length} motors in the right place, turning the right way.`,
    )
  }
}

function runAgain() {
  observations.value = new Map()
  stepIndex.value = 0
  spinning.value = false
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
  return sel?.spin ?? currentMotor.value?.spin ?? 'cw'
})

// 3D states. While testing, the graphic mirrors the operator's answer:
// the motor they've selected as "the one that moved" is highlighted and
// its prop spins the way they say (defaulting to the expected direction
// until they pick). In review, motors go green/red by result.
const motorVisuals = computed<MotorVisual[]>(() =>
  motors.value.map((m) => {
    let state: MotorVisual['state'] = 'idle'
    let spin = m.spin
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

    <!-- safety gate -->
    <div v-else-if="phase === 'safety'" class="space-y-4">
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
        <MotorCheck3D :motors="motorVisuals" :body-yaw-deg="bodyYawDeg" />
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
        <MotorCheck3D :motors="motorVisuals" :body-yaw-deg="bodyYawDeg" />
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
        <UAlert
          color="warning"
          icon="i-lucide-triangle-alert"
          title="Some motors need attention"
          description="Here's what doesn't match how your drone is set up. Auto-fixing this lands in the next update; for now, check the wiring and prop direction for the motors below."
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
                  should be {{ spinLabel(r.motor.spin) }}
                </span>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="runAgain">
          Run again
        </UButton>
        <UButton color="primary" @click="leave">
          Back to library
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
