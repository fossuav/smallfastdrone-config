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

// Runs the props-on motor probe applet on the connected drone: puts it on,
// starts and stops a run, collects what it reports, takes it off again,
// and sends the ground-station heartbeat it stops without. Reading the
// results is motor-probe.ts. Design: docs/BRINGUP.md "Props-on motor
// measurement" (PLAN decision 48).

import type { ProbeMotorResult } from './motor-probe'
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref } from 'vue'
import { buildGcsHeartbeat } from '../protocol/gcs-heartbeat'
import { useSessionStore } from '../stores/session'
import { useLuaEngine } from './lua-engine'
import { MOTOR_PROBE_ID, PROBE_ABORT_TEXT, PROBE_ACTIVE_PARAM, PROBE_STAGE, probeResult } from './motor-probe'

// The applet only notices MPRB_ACTIVE changing once per idle loop
// (IDLE_MS in applet.lua, 500 ms): a 0 then a 1 any faster than this could
// both land between two looks, and an old run would carry on reporting.
const ACTIVE_SETTLE_MS = 700
// The applet stops when the ground station has been quiet for 3 s.
const HEARTBEAT_MS = 1000

// Pause.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Where the probe is, as the desktop sees it.
export type ProbePhase = 'idle' | 'installing' | 'running' | 'finished' | 'stopped' | 'failed'

// Run the probe applet on the connected drone.
export function useMotorProbe(appletSource: string) {
  const lua = useLuaEngine()
  const session = useSessionStore()

  const phase = ref<ProbePhase>('idle')
  const error = ref<string | null>(null)
  // Latest value of every named value the drone has sent this run.
  const values = reactive(new Map<string, number>())
  let installed = false
  let unsubscribe: (() => void) | null = null

  // The heartbeat the applet stops without. Runs only while installed.
  const heartbeat = useIntervalFn(() => {
    session.sendMessage(buildGcsHeartbeat()).catch(() => {})
  }, HEARTBEAT_MS, { immediate: false })

  const stage = computed(() => values.get('MP_STATE') ?? PROBE_STAGE.OFF)
  const motorCount = computed(() => values.get('MP_NMOT') ?? 0)
  const currentMotor = computed(() => values.get('MP_MOT') ?? 0)
  const throttle = computed(() => values.get('MP_THR') ?? 0)
  const tiltDeg = computed(() => values.get('MP_TILT') ?? 0)
  const abortText = computed(() => {
    const code = values.get('MP_ABORT') ?? 0
    return code > 0 ? (PROBE_ABORT_TEXT[code] ?? 'The drone stopped the test.') : null
  })
  // Every motor that has reported so far, in test order.
  const results = computed(() => {
    const out: ProbeMotorResult[] = []
    for (let t = 1; t <= motorCount.value; t++) {
      const r = probeResult(t, values)
      if (r)
        out.push(r)
    }
    return out
  })

  // Put the applet on the drone and load it (no reboot). Scripting must
  // already be on. False, with `error` set, if it didn't load.
  async function install(): Promise<boolean> {
    phase.value = 'installing'
    error.value = null
    try {
      await lua.uploadApplet(MOTOR_PROBE_ID, appletSource)
      installed = true
      await lua.restartScripting()
      if (!await lua.waitForControlParam(PROBE_ACTIVE_PARAM)) {
        error.value = 'The test didn\'t load on the drone. Restart the drone and try again.'
        phase.value = 'failed'
        return false
      }
      heartbeat.resume()
      phase.value = 'idle'
      return true
    }
    catch (e) {
      error.value = `Couldn't put the test on the drone: ${e instanceof Error ? e.message : String(e)}`
      phase.value = 'failed'
      return false
    }
  }

  // Start a run, putting the applet on the drone first if it isn't. The
  // drone starts spinning motors a second or so later.
  async function start(): Promise<void> {
    if (!installed && !await install())
      return
    error.value = null
    unsubscribe?.()
    unsubscribe = null
    await session.sendMessage(buildGcsHeartbeat()).catch(() => {})
    await lua.setParam(PROBE_ACTIVE_PARAM, 0)
    await sleep(ACTIVE_SETTLE_MS)
    values.clear()
    unsubscribe = lua.subscribeNamedValues((name, value) => {
      if (name.startsWith('MP_') || /^M\d/.test(name))
        values.set(name, value)
      if (name === 'MP_STATE' && value === PROBE_STAGE.DONE)
        phase.value = 'finished'
      if (name === 'MP_STATE' && value === PROBE_STAGE.ABORTED)
        phase.value = 'stopped'
    })
    const res = await lua.setParam(PROBE_ACTIVE_PARAM, 1)
    if (!res.acked) {
      error.value = 'The drone didn\'t answer. Check the connection and try again.'
      phase.value = 'failed'
      return
    }
    phase.value = 'running'
  }

  // Stop now. Clearing the run switch stops the motor on the drone's next
  // loop; the dead-man timer stops it anyway if that message is lost.
  async function stop(): Promise<void> {
    await lua.setParam(PROBE_ACTIVE_PARAM, 0).catch(() => ({ acked: false }))
    if (phase.value === 'running')
      phase.value = 'stopped'
  }

  // Take the applet back off the drone. Safe to call more than once, and
  // from an unmount that can't wait for it.
  async function cleanup(): Promise<void> {
    unsubscribe?.()
    unsubscribe = null
    if (!installed || !session.connected) {
      heartbeat.pause()
      return
    }
    installed = false
    try {
      await lua.setParam(PROBE_ACTIVE_PARAM, 0)
      await lua.removeApplet(MOTOR_PROBE_ID)
      await lua.restartScripting()
    }
    catch {
      // Left on the drone: it forces itself off when it next loads, and
      // the next install overwrites it.
    }
    finally {
      heartbeat.pause()
    }
  }

  return {
    phase,
    error,
    stage,
    motorCount,
    currentMotor,
    throttle,
    tiltDeg,
    abortText,
    results,
    install,
    start,
    stop,
    cleanup,
  }
}
