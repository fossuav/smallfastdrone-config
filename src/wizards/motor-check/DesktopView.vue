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
// Walks the operator, props OFF, through spinning each motor in turn and
// confirming it (a) sits where the firmware thinks it does and (b) turns
// the right way. We deliberately DON'T pre-highlight the motor under
// test — the operator identifies which one physically moved (that's what
// catches a mis-wire), then says which way it turned. We compare against
// the firmware's frame geometry and report any mismatches.
//
// This slice detects + reports. Auto-correction (output remap via
// SERVOn_FUNCTION + direction reverse via SERVO_BLH_RVMASK, with a
// reboot) lands in a follow-up; see docs/WIZARDS.md.
//
// All motor spinning goes through MAV_CMD_DO_MOTOR_TEST (props off,
// landed, safety off — see src/protocol/motors.ts). An emergency Stop is
// always one tap away while a motor is live, and we stop the motor on
// unmount so navigating away never leaves one spinning.

import type { CommandAck } from 'mavlink-mappings/dist/lib/common'
import type { MotorVisual } from '../../ui/visuals/MotorCheck3D.vue'
import type { FrameMotor, MotorPosition, Spin } from '../../workflow/motor-geometry'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { buildMotorTest, buildMotorTestStop, MOTOR_TEST_PWM_SPIN } from '../../protocol/motors'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import MotorCheck3D from '../../ui/visuals/MotorCheck3D.vue'
import { frameGeometry, motorTopdownXY, spinLabel } from '../../workflow/motor-geometry'

const WIZARD_ID = 'motor-check'
const COMP_ID_AUTOPILOT = 1
const MSGID_COMMAND_ACK = 77
const MAV_CMD_DO_MOTOR_TEST = 209
const MAV_RESULT_ACCEPTED = 0
// Generous spin so the operator has time to look, identify, and pick a
// direction without the motor cutting out mid-thought. Stopped explicitly
// when they confirm or leave.
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

// The connected frame's motor layout (null until loaded / if unsupported).
const motors = ref<FrameMotor[]>([])
const frameLabel = ref('')

// Safety gate — Start stays disabled until the operator confirms props off.
const propsOff = ref(false)

// What the operator reported for each motor, keyed by test order.
interface Observation { position: MotorPosition, spin: Spin }
const observations = ref<Map<number, Observation>>(new Map())

// Per-step state while testing.
const stepIndex = ref(0)
const spinning = ref(false)
const selPosition = ref<MotorPosition | null>(null)
const selSpin = ref<Spin | null>(null)

const currentMotor = computed<FrameMotor | undefined>(() => motors.value[stepIndex.value])

// Load the frame layout. FRAME_CLASS / FRAME_TYPE come from the param
// store; if the frame isn't one we have a transcribed geometry for, bail
// to 'unsupported' rather than guess a motor map.
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
    const geo = frameGeometry(Math.trunc(cls.value), Math.trunc(typ.value))
    if (!geo) {
      phase.value = 'unsupported'
      errorMessage.value = 'This frame isn\'t supported by the motor check yet — only quad layouts for now.'
      return
    }
    motors.value = geo.motors
    frameLabel.value = geo.label
    phase.value = 'safety'
  }
  catch (e) {
    phase.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
})

// Always stop any live motor when leaving the wizard.
onUnmounted(() => {
  void stopActiveMotor()
})

// Send a DO_MOTOR_TEST and wait for the FC's COMMAND_ACK. Resolves with
// true if the FC accepted (motor will spin), false otherwise (e.g. the
// drone isn't sitting still, or the safety switch is on).
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

// Best-effort stop of whatever motor is currently under test.
async function stopActiveMotor() {
  const m = currentMotor.value
  if (!m || session.sysid === null)
    return
  await session.sendMessage(
    buildMotorTestStop(session.sysid, COMP_ID_AUTOPILOT, m.testOrder),
  ).catch(() => {})
}

// Begin the test sequence (props-off confirmed).
function start() {
  observations.value = new Map()
  stepIndex.value = 0
  resetStep()
  phase.value = 'testing'
}

function resetStep() {
  spinning.value = false
  selPosition.value = null
  selSpin.value = null
}

// Spin the current motor. On a rejected command, surface a friendly
// reason and stay on the step so the operator can fix it and retry.
async function spinCurrent() {
  const m = currentMotor.value
  if (!m)
    return
  errorMessage.value = null
  const ok = await spinMotor(m.testOrder)
  if (!ok) {
    errorMessage.value = 'Your drone wouldn\'t spin that motor. Make sure it\'s sitting still on the bench with the safety switch off, then try again.'
    spinning.value = false
    return
  }
  spinning.value = true
}

// Operator taps the motor position that physically moved.
function pickPosition(position: MotorPosition) {
  if (!spinning.value)
    return
  selPosition.value = position
}

// Operator picks the direction it turned.
function pickSpin(spin: Spin) {
  if (!spinning.value)
    return
  selSpin.value = spin
}

// Record the observation, stop the motor, advance (or finish).
async function confirmStep() {
  const m = currentMotor.value
  if (!m || selPosition.value === null || selSpin.value === null)
    return
  observations.value.set(m.testOrder, { position: selPosition.value, spin: selSpin.value })
  await stopActiveMotor()
  if (stepIndex.value >= motors.value.length - 1) {
    finish()
    return
  }
  stepIndex.value += 1
  resetStep()
}

// Emergency stop — cut the live motor and clear the spinning state.
async function emergencyStop() {
  await stopActiveMotor()
  spinning.value = false
}

// Per-motor result, computed from the recorded observations.
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

// Compute results, record completion if everything checks out, show review.
function finish() {
  resetStep()
  phase.value = 'review'
  if (allOk.value) {
    wizardProgress.markComplete(
      session.fcUid,
      WIZARD_ID,
      `All ${motors.value.length} motors in the right place, turning the right way.`,
    )
  }
}

// Run the whole check again from the safety gate.
function runAgain() {
  observations.value = new Map()
  stepIndex.value = 0
  resetStep()
  phase.value = 'safety'
}

function back() {
  router.push(returnTo.value)
}

// Visual states for the 3D drone. During testing we highlight only the
// operator's current selection (never the motor actually under test — no
// hints). In review, motors go green/red by result.
const motorVisuals = computed<MotorVisual[]>(() =>
  motors.value.map((m) => {
    let state: MotorVisual['state'] = 'idle'
    if (phase.value === 'testing' && selPosition.value === m.position) {
      state = 'active'
    }
    else if (phase.value === 'review') {
      const r = results.value.find(x => x.motor.testOrder === m.testOrder)
      state = r && r.positionOk && r.spinOk ? 'done' : 'mismatch'
    }
    return { key: m.testOrder, angleDeg: m.angleDeg, spin: m.spin, state }
  }),
)

// CSS placement for the clickable hotspot over each motor. Radii are
// tuned to the (slightly tilted) top-down camera in MotorCheck3D — the
// vertical axis is squashed to match the foreshortening.
function hotspotStyle(angleDeg: number): Record<string, string> {
  const { x, y } = motorTopdownXY(angleDeg)
  return {
    left: `${50 + x * 40}%`,
    top: `${50 + y * 33}%`,
  }
}

// Hotspots are live only while a motor is spinning and not yet confirmed.
const hotspotsActive = computed(() => phase.value === 'testing' && spinning.value)
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

    <!-- unsupported / can't read frame -->
    <div v-else-if="phase === 'unsupported'" class="space-y-3">
      <UAlert color="warning" title="Can't check motors yet">
        <template #description>
          {{ errorMessage }}
        </template>
      </UAlert>
      <div class="flex justify-end">
        <UButton color="neutral" variant="outline" @click="back">
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
        {{ motors.length }} motors in turn. Watch your drone and tell us which
        one moved and which way it turned — we'll check it against how it
        should be wired.
      </p>
      <div class="border-default flex items-center gap-3 rounded-lg border p-3">
        <USwitch v-model="propsOff" color="error" aria-label="Propellers are removed" />
        <span class="text-default text-sm">
          I've removed all propellers.
        </span>
      </div>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="back">
          Cancel
        </UButton>
        <UButton color="primary" :disabled="!propsOff" @click="start">
          Start motor check
        </UButton>
      </div>
    </div>

    <!-- testing -->
    <div v-else-if="phase === 'testing'" class="space-y-4">
      <div class="flex items-center justify-between">
        <p class="text-highlighted font-medium">
          Motor {{ stepIndex + 1 }} of {{ motors.length }}
        </p>
        <UButton
          v-if="spinning"
          color="error"
          variant="solid"
          icon="i-lucide-octagon-x"
          @click="emergencyStop"
        >
          Stop
        </UButton>
      </div>

      <!-- 3D drone + clickable hotspots -->
      <div class="relative mx-auto aspect-square w-full max-w-sm">
        <MotorCheck3D :motors="motorVisuals" />
        <button
          v-for="m in motors"
          :key="m.testOrder"
          type="button"
          class="absolute size-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition"
          :class="[
            hotspotsActive ? 'cursor-pointer border-primary/70 hover:bg-primary/20' : 'pointer-events-none border-transparent',
            selPosition === m.position ? 'border-warning bg-warning/30' : '',
          ]"
          :style="hotspotStyle(m.angleDeg)"
          :aria-label="m.position"
          :disabled="!hotspotsActive"
          @click="pickPosition(m.position)"
        />
      </div>

      <UAlert v-if="errorMessage" color="warning" :description="errorMessage" />

      <!-- before spin -->
      <div v-if="!spinning" class="flex justify-center">
        <UButton color="primary" icon="i-lucide-play" @click="spinCurrent">
          Spin this motor
        </UButton>
      </div>

      <!-- during spin: identify + direction + confirm -->
      <div v-else class="space-y-3">
        <p v-if="!selPosition" class="text-default text-center">
          A motor is spinning. On your drone, tap the one that's moving.
        </p>
        <template v-else>
          <p class="text-default text-center">
            Which way is the <strong>{{ selPosition }}</strong> motor turning?
          </p>
          <div class="flex justify-center gap-2">
            <UButton
              :color="selSpin === 'ccw' ? 'primary' : 'neutral'"
              :variant="selSpin === 'ccw' ? 'solid' : 'outline'"
              icon="i-lucide-rotate-ccw"
              @click="pickSpin('ccw')"
            >
              Counter-clockwise
            </UButton>
            <UButton
              :color="selSpin === 'cw' ? 'primary' : 'neutral'"
              :variant="selSpin === 'cw' ? 'solid' : 'outline'"
              icon="i-lucide-rotate-cw"
              @click="pickSpin('cw')"
            >
              Clockwise
            </UButton>
          </div>
        </template>

        <div class="flex justify-center gap-2 pt-1">
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-rotate-cw" @click="spinCurrent">
            Spin again
          </UButton>
          <UButton
            color="primary"
            :disabled="!selPosition || !selSpin"
            @click="confirmStep"
          >
            {{ stepIndex >= motors.length - 1 ? 'Finish' : 'Next motor' }}
          </UButton>
        </div>
      </div>
    </div>

    <!-- review -->
    <div v-else-if="phase === 'review'" class="space-y-4">
      <div class="mx-auto aspect-square w-full max-w-xs">
        <MotorCheck3D :motors="motorVisuals" />
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
              <span class="text-highlighted font-medium capitalize">{{ r.motor.position }}</span>
              <span v-if="r.positionOk && r.spinOk" class="text-muted"> — correct</span>
              <template v-else>
                <span v-if="!r.positionOk" class="text-error">
                  — you saw it move at <span class="capitalize">{{ r.observed?.position ?? 'nowhere' }}</span>
                  (should be <span class="capitalize">{{ r.motor.position }}</span>)
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
        <UButton color="primary" @click="back">
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
      <UButton color="neutral" @click="back">
        Back to library
      </UButton>
    </div>
  </div>
</template>
