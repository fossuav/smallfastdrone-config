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

// Which way up the drone thinks it is, live.
//
// This is the cheapest real check in the whole tool. An operator picks
// their drone up, tips it, and either the picture on screen tips the
// same way or it does not - and if it does not, they have learned in one
// second that the board is mounted at an angle the firmware doesn't know
// about, or that the IMU is unhealthy, or that the airframe's idea of
// forward isn't theirs. No wizard, no parameter, no question asked.
//
// ATTITUDE is not free, so unlike SYS_STATUS it is asked for on demand
// and stopped again: it is tens of packets a second, and on a telemetry
// radio rather than USB that matters. Consumers are reference-counted
// here, so two views can show attitude at once and the stream is still
// started once and stopped once. A stop is best-effort - the common way
// to leave this screen is to unplug the drone, and there is nothing to
// send to then.

import type { Attitude } from 'mavlink-mappings/dist/lib/common'
import type { AttitudeSample } from './attitude'
import { onScopeDispose, readonly, ref, watch } from 'vue'
import { buildSetMessageInterval, MSGID_ATTITUDE } from '../protocol/mavlink'
import { useSessionStore } from '../stores/session'

const COMP_ID_AUTOPILOT = 1
// 20 Hz. Fast enough that tipping the airframe feels like a mirror
// rather than a slideshow, slow enough to be unremarkable on a link.
const ATTITUDE_INTERVAL_US = 50_000
// -1 tells the firmware to stop sending it. 0 would mean "your default
// rate", which is not the same thing and would leave the stream running.
const STOP_INTERVAL_US = -1
// How long without a packet before we stop claiming to know. Generous
// against a busy link; short enough that a stalled picture doesn't sit
// there looking live.
const STALE_AFTER_MS = 1500

// How many live consumers, so the stream is started and stopped once.
let consumers = 0

// Subscribe to the drone's attitude for as long as the calling scope
// lives. `live` says whether what you are looking at is current - a
// consumer should say so rather than leaving a stale picture up.
export function useAttitude() {
  const session = useSessionStore()
  const attitude = ref<AttitudeSample | null>(null)
  const lastAt = ref(0)
  const live = ref(false)

  const off = session.subscribeMessages((msg) => {
    if (msg.msgid !== MSGID_ATTITUDE)
      return
    const a = msg.data as Attitude
    attitude.value = { roll: a.roll, pitch: a.pitch, yaw: a.yaw }
    lastAt.value = Date.now()
    live.value = true
  })

  const staleTimer = setInterval(() => {
    if (live.value && Date.now() - lastAt.value > STALE_AFTER_MS)
      live.value = false
  }, STALE_AFTER_MS / 2)

  // Asking twice is harmless - the firmware just sets the interval
  // again - so consumers don't coordinate on the way in. They do on the
  // way out: the count is what stops one view closing from cutting off
  // another that is still showing attitude.
  async function request(intervalUs: number): Promise<void> {
    if (!session.connected || session.sysid === null)
      return
    try {
      await session.sendMessage(
        buildSetMessageInterval(session.sysid, COMP_ID_AUTOPILOT, MSGID_ATTITUDE, intervalUs),
      )
    }
    catch {
      // Nothing to do and nothing to say: without the stream the view
      // reports itself as not live, which is the honest outcome.
    }
  }

  consumers += 1
  // Ask whenever there is a drone to ask, not only on mount. The
  // operator usually opens this view before plugging anything in, and a
  // drone that reboots comes back having forgotten the request - both
  // are ordinary, and both used to leave the picture dead.
  watch(
    () => session.connected && session.sysid !== null,
    (ready) => {
      if (ready)
        void request(ATTITUDE_INTERVAL_US)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    off()
    clearInterval(staleTimer)
    consumers -= 1
    if (consumers === 0)
      void request(STOP_INTERVAL_US)
  })

  return { attitude: readonly(attitude), live: readonly(live) }
}
