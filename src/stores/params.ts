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

// Parameter browser store. Owns the full fetched-from-FC parameter map,
// the pending-edits map, the apply pipeline (PARAM_SET per edit, wait for
// echo, then PREFLIGHT_STORAGE save), and the per-row write state the UI
// renders. The session store provides send + subscribe helpers so this
// store stays free of direct MavLinkSession references.

import type { CommandAck, ParamValue } from 'mavlink-mappings/dist/lib/common'
import type { ParamRecord } from '../protocol/params'
import { MavCmd, MavResult } from 'mavlink-mappings/dist/lib/common'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  buildParamRequestList,
  buildParamSet,
  buildPreflightStorageSave,
  MSGID_COMMAND_ACK,
  MSGID_PARAM_VALUE,
} from '../protocol/params'
import { useSessionStore } from './session'

const COMP_ID_AUTOPILOT = 1
const SILENCE_TIMEOUT_MS = 10_000
// Per-PARAM_SET ack timeout. ArduPilot SITL replies within ~50 ms;
// 1.5 s gives ample headroom for a slow USB link.
const PARAM_ACK_TIMEOUT_MS = 1500
// PREFLIGHT_STORAGE save → COMMAND_ACK timeout. Flash write on real FCs
// takes longer than a param ack.
const STORAGE_ACK_TIMEOUT_MS = 5000
// Almost-equal threshold for float comparison: PARAM_SET sends a float
// but integer params travel through that same float; this is enough
// slop to handle the round-trip.
const VALUE_EQ_EPS = 1e-6

export type WriteState = 'pending' | 'writing' | 'acked' | 'mismatched' | 'failed'
export type ApplyStage = 'writing' | 'saving' | 'done'

interface WriteResult {
  status: 'acked' | 'mismatched' | 'failed'
  acceptedValue?: number
  message?: string
}

export const useParamsStore = defineStore('params', () => {
  const session = useSessionStore()

  const params = ref<Map<string, ParamRecord>>(new Map())
  const loading = ref(false)
  const progress = ref<{ received: number, total: number } | null>(null)
  const error = ref<string | null>(null)
  const loadedAt = ref<number | null>(null)

  // Pending edits keyed by param name. An entry exists only while the
  // operator's value differs from the FC's value. The store doesn't push
  // these anywhere — Apply / commit lands in the next slice.
  const edits = ref<Map<string, number>>(new Map())

  const sortedList = computed<ParamRecord[]>(() =>
    [...params.value.values()].sort((a, b) => a.name.localeCompare(b.name)),
  )
  const count = computed(() => params.value.size)

  const dirtyCount = computed(() => edits.value.size)
  const dirtyList = computed<ParamRecord[]>(() =>
    [...edits.value.keys()]
      .map(name => params.value.get(name))
      .filter((p): p is ParamRecord => p !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  // Apply-time state.
  const applying = ref(false)
  const applyStage = ref<ApplyStage | null>(null)
  const applyError = ref<string | null>(null)
  const writeStates = ref<Map<string, WriteState>>(new Map())
  // After an apply finishes, summary counts persist briefly so the UI can
  // surface "N saved, M failed" without polling the writeStates map.
  const lastApplyAt = ref<number | null>(null)
  const lastApplyAcked = ref(0)
  const lastApplyMismatched = ref(0)
  const lastApplyFailed = ref(0)

  // Look up the current apply-time write state for a single param row.
  // Undefined when no apply has touched the row this session.
  function writeStateOf(name: string): WriteState | undefined {
    return writeStates.value.get(name)
  }

  // Has the operator queued an edit for this param that hasn't been
  // committed to the FC yet?
  function isDirty(name: string): boolean {
    return edits.value.has(name)
  }
  // Operator's pending value for this param (undefined if not edited).
  function editedValue(name: string): number | undefined {
    return edits.value.get(name)
  }
  // What the param "is" right now from the operator's point of view —
  // the pending edit if there is one, otherwise the FC's last reported
  // value. Used by display code that doesn't care about the distinction.
  function effectiveValue(name: string): number | undefined {
    const e = edits.value.get(name)
    if (e !== undefined)
      return e
    return params.value.get(name)?.value
  }
  // Stage an edit. If the new value matches the FC's current value the
  // edit is cleared rather than stored (the row stops looking dirty).
  // No-op if the param doesn't exist in the fetched set.
  function setEdit(name: string, newValue: number) {
    const fc = params.value.get(name)
    if (!fc)
      return
    if (Object.is(newValue, fc.value)) {
      edits.value.delete(name)
    }
    else {
      edits.value.set(name, newValue)
    }
  }
  // Drop a single pending edit; the row reverts to the FC's value.
  function revertParam(name: string) {
    edits.value.delete(name)
  }
  // Drop every pending edit. Bound to the Discard button.
  function discardAll() {
    edits.value.clear()
  }

  // Fetch every parameter from the FC into the store. Re-fetching clears
  // pending edits — a reload means "give me the live state," and merging
  // live state with pending edits would surface confusing diffs.
  async function load() {
    if (loading.value)
      return
    if (!session.connected) {
      error.value = 'Connect to a drone first'
      return
    }
    if (session.sysid === null) {
      error.value = 'Waiting for heartbeat before fetching params'
      return
    }

    loading.value = true
    error.value = null
    progress.value = null
    // A reload represents "I want the current state on the FC", so pending
    // edits are dropped. Surfacing conflicts with in-flight edits is a
    // later slice.
    edits.value.clear()

    try {
      params.value = await streamParams(session.sysid)
      loadedAt.value = Date.now()
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loading.value = false
    }
  }

  // Stream PARAM_VALUE messages into a Map until the FC's reported
  // param_count is satisfied (or silence for SILENCE_TIMEOUT_MS).
  async function streamParams(targetSystem: number): Promise<Map<string, ParamRecord>> {
    const out = new Map<string, ParamRecord>()
    const seen = new Set<number>()

    return new Promise<Map<string, ParamRecord>>((resolve, reject) => {
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const finish = (err?: Error) => {
        if (silenceTimer)
          clearTimeout(silenceTimer)
        unsubscribe?.()
        if (err)
          reject(err)
        else resolve(out)
      }
      const armSilence = () => {
        if (silenceTimer)
          clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          finish(new Error(`Param fetch stalled — got ${seen.size} params, then ${SILENCE_TIMEOUT_MS / 1000}s of silence`))
        }, SILENCE_TIMEOUT_MS)
      }

      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as ParamValue
        const name = pv.paramId.replace(/\0.*$/, '')
        if (!seen.has(pv.paramIndex)) {
          seen.add(pv.paramIndex)
          out.set(name, {
            name,
            value: pv.paramValue,
            type: pv.paramType,
            index: pv.paramIndex,
          })
          progress.value = { received: seen.size, total: pv.paramCount }
        }
        armSilence()
        if (pv.paramCount > 0 && seen.size >= pv.paramCount)
          finish()
      })

      armSilence()
      session
        .sendMessage(buildParamRequestList(targetSystem, COMP_ID_AUTOPILOT))
        .catch(finish)
    })
  }

  // Apply pending edits: PARAM_SET each one, wait for the FC's PARAM_VALUE
  // echo as ack; when all done, request a PREFLIGHT_STORAGE save so changes
  // survive reboot.
  async function apply() {
    if (applying.value || edits.value.size === 0)
      return
    if (!session.connected || session.sysid === null) {
      applyError.value = 'Not connected'
      return
    }
    applying.value = true
    applyError.value = null
    applyStage.value = 'writing'

    const targets: Array<[string, number]> = [...edits.value.entries()]
    writeStates.value = new Map(targets.map(([n]) => [n, 'pending']))

    let acked = 0
    let mismatched = 0
    let failed = 0
    let anyAccepted = false

    for (const [name, newValue] of targets) {
      const existing = params.value.get(name)
      if (!existing) {
        writeStates.value.set(name, 'failed')
        failed += 1
        continue
      }

      writeStates.value.set(name, 'writing')

      const result = await writeParam(name, newValue, existing.type, session.sysid)

      switch (result.status) {
        case 'acked':
          writeStates.value.set(name, 'acked')
          params.value.set(name, { ...existing, value: result.acceptedValue ?? newValue })
          edits.value.delete(name)
          acked += 1
          anyAccepted = true
          break
        case 'mismatched':
          writeStates.value.set(name, 'mismatched')
          // Update our cached FC value to what the FC actually accepted;
          // leave the edit in place so the operator can see "asked X, got Y".
          if (result.acceptedValue !== undefined) {
            params.value.set(name, { ...existing, value: result.acceptedValue })
          }
          mismatched += 1
          anyAccepted = true
          break
        default:
          writeStates.value.set(name, 'failed')
          failed += 1
          break
      }
    }

    if (anyAccepted) {
      applyStage.value = 'saving'
      // MAV_CMD_PREFLIGHT_STORAGE is best-effort. ArduPilot auto-saves
      // param changes within ~10 s of a write, and the storage command
      // itself is marked deprecated in modern MAVLink — SITL doesn't
      // bother acking. We send it anyway in case a particular FC build
      // does want the explicit nudge, but a no-ack isn't a problem.
      await sendStorageSave(session.sysid)
    }

    applyStage.value = 'done'
    lastApplyAt.value = Date.now()
    lastApplyAcked.value = acked
    lastApplyMismatched.value = mismatched
    lastApplyFailed.value = failed
    applying.value = false
  }

  // Send one PARAM_SET and wait for the FC's PARAM_VALUE echo for that
  // name. The echo carries whatever the FC actually stored (may differ
  // if it clamped the value), so we resolve with status + acceptedValue.
  async function writeParam(name: string, value: number, type: number, targetSys: number): Promise<WriteResult> {
    return new Promise<WriteResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const settle = (r: WriteResult) => {
        if (timer)
          clearTimeout(timer)
        unsubscribe?.()
        resolve(r)
      }

      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as ParamValue
        const echoedName = pv.paramId.replace(/\0.*$/, '')
        if (echoedName !== name)
          return
        const matched = Math.abs(pv.paramValue - value) <= VALUE_EQ_EPS * Math.max(1, Math.abs(value))
        settle({
          status: matched ? 'acked' : 'mismatched',
          acceptedValue: pv.paramValue,
        })
      })

      timer = setTimeout(() => {
        settle({ status: 'failed', message: 'No response from drone' })
      }, PARAM_ACK_TIMEOUT_MS)

      session
        .sendMessage(buildParamSet(targetSys, COMP_ID_AUTOPILOT, name, value, type))
        .catch((e) => {
          settle({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
        })
    })
  }

  // Ask the FC to commit current parameters to non-volatile storage. Best
  // effort: ArduPilot auto-saves within ~10s of a PARAM_SET regardless,
  // and the storage command is marked deprecated in modern MAVLink — SITL
  // doesn't ack. Returns true only if we received an explicit ACCEPTED.
  async function sendStorageSave(targetSys: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const settle = (ok: boolean) => {
        if (timer)
          clearTimeout(timer)
        unsubscribe?.()
        resolve(ok)
      }

      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_COMMAND_ACK)
          return
        const ack = msg.data as CommandAck
        if (ack.command !== MavCmd.PREFLIGHT_STORAGE)
          return
        settle(ack.result === MavResult.ACCEPTED)
      })

      timer = setTimeout(settle, STORAGE_ACK_TIMEOUT_MS, false)

      session
        .sendMessage(buildPreflightStorageSave(targetSys, COMP_ID_AUTOPILOT))
        .catch(() => settle(false))
    })
  }

  // Clear the post-apply banner + per-row badges. Bound to the close
  // affordance on the result banner so the operator can dismiss it after
  // reading.
  function dismissApplyResult() {
    applyStage.value = null
    writeStates.value.clear()
    lastApplyAcked.value = 0
    lastApplyMismatched.value = 0
    lastApplyFailed.value = 0
    applyError.value = null
  }

  // Wipe every piece of store state. Called on disconnect so the next
  // connection starts with a clean slate; a leftover params map would
  // bleed yesterday's drone into today's view.
  function clear() {
    params.value = new Map()
    edits.value = new Map()
    progress.value = null
    error.value = null
    loadedAt.value = null
    writeStates.value = new Map()
    applyStage.value = null
    applyError.value = null
  }

  return {
    params,
    sortedList,
    count,
    loading,
    progress,
    error,
    loadedAt,
    edits,
    dirtyCount,
    dirtyList,
    isDirty,
    editedValue,
    effectiveValue,
    setEdit,
    revertParam,
    discardAll,
    load,
    clear,
    applying,
    applyStage,
    applyError,
    writeStates,
    writeStateOf,
    lastApplyAt,
    lastApplyAcked,
    lastApplyMismatched,
    lastApplyFailed,
    apply,
    dismissApplyResult,
  }
})
