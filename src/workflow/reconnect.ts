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

// Reboot/auto-reconnect primitives shared by every flow that changes a
// reboot-required setting (Drone settings, motor-check correction). After
// the FC restarts the transport drops; these helpers retry connect +
// heartbeat through the restart window so the operator never has to
// reconnect by hand.
//
// Extracted from SettingsView so the bring-up subtleties live in one
// place rather than being copied per call site:
//   - settle ~1.5 s after a PARAM_SET before rebooting — ArduPilot
//     auto-saves on PARAM_SET but SITL's storage backend batches the
//     write and a reboot races the flush.
//   - wait for the post-reboot heartbeat (not just transport-open) before
//     touching params — session.connect() resolves on transport-open and
//     params.load() bails while sysid is null.

import { watch } from 'vue'
import { useSessionStore } from '../stores/session'

// Settle delay after PARAM_SET before a reboot (storage flush race).
export const STORAGE_SETTLE_MS = 1500
// Total budget to wait for the FC to come back after a reboot.
const RECONNECT_BUDGET_MS = 60_000
// Cadence between reconnect attempts.
const RECONNECT_RETRY_MS = 1500
// How long to wait for a heartbeat after a transport opens.
const HEARTBEAT_WAIT_MS = 5000
// How long to wait for the reboot-induced transport drop.
const DISCONNECT_WAIT_MS = 10_000

// Promise-based sleep — shared so call sites don't each re-roll it.
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function useReconnect() {
  const session = useSessionStore()

  // Wait for the reboot-induced transport drop, then retry connect +
  // heartbeat on a fixed cadence until a heartbeat lands or the budget
  // runs out. Each attempt disconnects first so we never reconnect onto a
  // half-open transport left by a failed prior attempt. Returns true once
  // a fresh heartbeat has set session.sysid.
  async function autoReconnect(): Promise<boolean> {
    await waitForDisconnect(DISCONNECT_WAIT_MS)
    const deadline = Date.now() + RECONNECT_BUDGET_MS
    while (Date.now() < deadline) {
      await session.disconnect().catch(() => {})
      await session.connect().catch(() => {})
      if (session.connected) {
        const gotHeartbeat = await waitForHeartbeat(HEARTBEAT_WAIT_MS)
        if (gotHeartbeat && session.sysid !== null)
          return true
      }
      await sleep(RECONNECT_RETRY_MS)
    }
    return false
  }

  // Resolve once the transport drops (session.connected false), or after a
  // timeout. After a reboot the FC takes a moment to actually exit; we wait
  // for the drop before reconnecting so we don't race the still-alive
  // pre-reboot connection.
  function waitForDisconnect(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!session.connected) {
        resolve()
        return
      }
      let stop: (() => void) | null = null
      const timer = setTimeout(() => {
        stop?.()
        resolve()
      }, timeoutMs)
      stop = watch(() => session.connected, (connected) => {
        if (!connected) {
          clearTimeout(timer)
          stop?.()
          resolve()
        }
      })
    })
  }

  // Resolve once a fresh heartbeat sets session.sysid, or after a timeout.
  function waitForHeartbeat(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (session.sysid !== null) {
        resolve(true)
        return
      }
      let stop: (() => void) | null = null
      const timer = setTimeout(() => {
        stop?.()
        resolve(false)
      }, timeoutMs)
      stop = watch(() => session.sysid, (sysid) => {
        if (sysid !== null) {
          clearTimeout(timer)
          stop?.()
          resolve(true)
        }
      })
    })
  }

  return { autoReconnect }
}
