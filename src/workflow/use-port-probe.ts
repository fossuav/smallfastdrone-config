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

// Runs the port probe on the connected drone, restart to restart: hand
// the unknown ports to scripting (with the applet on the drone, and
// scripting on if it wasn't), restart, listen, then set the roles found
// - or put every port back - and restart again. Every port's role is
// noted first, in this browser, per drone, so a run interrupted anywhere
// can still be undone after a reload. Deciding is port-probe.ts.
// Design: docs/BRINGUP.md "Finding what's plugged in" (PLAN decision 49).

import type { PortEdit, PortOutcome, PortResult, PortRole } from './port-probe'
import { computed, reactive, ref, shallowRef } from 'vue'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { useLuaEngine } from './lua-engine'
import {
  outcomeEdits,
  planRoles,
  PORT_PROBE_ACTIVE_PARAM,
  PORT_PROBE_ID,
  PORT_PROBE_STAGE,
  portResult,
  PROTOCOL_SCRIPTING,
  restoreEdits,
} from './port-probe'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from './reconnect'
import { storageProblemText } from './script-storage'

// What a run needs to be undone: the ports handed over, every port's role
// before, and whether scripting was turned on for it.
interface Backup {
  probed: number[]
  roles: Array<[number, PortRole]>
  scriptingWasOff: boolean
}

// Where the backup is kept, per drone.
function backupKey(fcUid: string | null): string {
  return `sfd-config:port-probe:${fcUid ?? 'unknown'}`
}

// Read a saved backup. Browser storage can be missing or refuse; a run
// then simply can't be resumed after a reload.
function loadBackup(fcUid: string | null): Backup | null {
  try {
    const raw = localStorage.getItem(backupKey(fcUid))
    return raw ? JSON.parse(raw) as Backup : null
  }
  catch {
    return null
  }
}

// Save, or clear, the backup.
function saveBackup(fcUid: string | null, b: Backup | null): void {
  try {
    if (b)
      localStorage.setItem(backupKey(fcUid), JSON.stringify(b))
    else
      localStorage.removeItem(backupKey(fcUid))
  }
  catch {
    // Not resumable after a reload; the run itself is unaffected.
  }
}

// Where the probe is.
export type PortProbePhase
  = | 'idle' | 'interrupted' | 'preparing' | 'restarting' | 'probing'
    | 'results' | 'applying' | 'done' | 'failed'

// Every SERIALn port's role, from the parameters the drone has.
export function readRoles(value: (name: string) => number | undefined): Map<number, PortRole> {
  const roles = new Map<number, PortRole>()
  for (let n = 0; n < 16; n++) {
    const protocol = value(`SERIAL${n}_PROTOCOL`)
    if (protocol !== undefined)
      roles.set(n, { protocol, baud: value(`SERIAL${n}_BAUD`) ?? 57 })
  }
  return roles
}

// Run the port probe applet on the connected drone.
export function usePortProbe(appletSource: string) {
  const lua = useLuaEngine()
  const params = useParamsStore()
  const session = useSessionStore()
  const { reconnectAndReload } = useReconnect()

  const phase = ref<PortProbePhase>(loadBackup(session.fcUid) ? 'interrupted' : 'idle')
  const error = ref<string | null>(null)
  const values = reactive(new Map<string, number>())
  const backup = shallowRef<Backup | null>(loadBackup(session.fcUid))
  // The outcome that was applied, for the summary afterwards.
  const applied = shallowRef<PortOutcome[]>([])
  let unsubscribe: (() => void) | null = null

  const probed = computed(() => backup.value?.probed ?? [])
  const roles = computed(() => new Map(backup.value?.roles ?? []))
  const results = computed(() => {
    const out = new Map<number, PortResult>()
    for (const n of probed.value) {
      const r = portResult(n, values)
      if (r)
        out.set(n, r)
    }
    return out
  })
  const plan = computed(() => planRoles(probed.value, results.value, roles.value))
  // The baud a port is being listened at, while it is.
  function trying(serial: number): number | null {
    return values.get(`S${serial}TRY`) ?? null
  }

  // Stage some writes and save them in one batch. False if any failed.
  async function write(edits: PortEdit[]): Promise<boolean> {
    params.discardAll()
    for (const e of edits)
      params.setEdit(e.name, e.value)
    await params.apply()
    const ok = params.lastApplyFailed === 0
    params.discardAll()
    return ok
  }

  // Restart the drone and come back with its parameters. False with
  // `error` set if it didn't.
  async function restart(): Promise<boolean> {
    phase.value = 'restarting'
    await sleep(STORAGE_SETTLE_MS)
    await session.reboot()
    const outcome = await reconnectAndReload()
    if (outcome !== 'ok') {
      error.value = outcome === 'no-drone'
        ? 'Your drone didn\'t come back after restarting. Reconnect it; the ports can still be put back.'
        : 'Your drone came back, but its settings couldn\'t be read. Reconnect it and try again.'
      phase.value = 'failed'
      return false
    }
    return true
  }

  // Hand `ports` to the applet, restart, and start listening.
  async function start(ports: number[]): Promise<void> {
    error.value = null
    phase.value = 'preparing'
    const storage = storageProblemText(await lua.checkScriptStorage())
    if (storage) {
      error.value = storage
      phase.value = 'failed'
      return
    }
    const b: Backup = {
      probed: ports,
      roles: [...readRoles(name => params.params.get(name)?.value)],
      scriptingWasOff: (params.params.get('SCR_ENABLE')?.value ?? 0) === 0,
    }
    backup.value = b
    saveBackup(session.fcUid, b)
    try {
      await lua.uploadApplet(PORT_PROBE_ID, appletSource)
    }
    catch (e) {
      error.value = `Couldn't put the test on the drone: ${e instanceof Error ? e.message : String(e)}`
      phase.value = 'failed'
      return
    }
    const edits: PortEdit[] = ports.map(n => ({ name: `SERIAL${n}_PROTOCOL`, value: PROTOCOL_SCRIPTING }))
    if (b.scriptingWasOff)
      edits.push({ name: 'SCR_ENABLE', value: 1 })
    if (!await write(edits)) {
      error.value = 'We couldn\'t hand the ports over. Check the connection and try again.'
      phase.value = 'failed'
      return
    }
    if (!await restart())
      return
    phase.value = 'probing'
    if (!await lua.waitForControlParam(PORT_PROBE_ACTIVE_PARAM)) {
      error.value = 'The test didn\'t load on the drone. Put the ports back and try again.'
      phase.value = 'failed'
      return
    }
    values.clear()
    unsubscribe?.()
    unsubscribe = lua.subscribeNamedValues((name, value) => {
      if (name.startsWith('PP_') || /^S\d/.test(name))
        values.set(name, value)
      if (name === 'PP_STATE' && value === PORT_PROBE_STAGE.DONE && phase.value === 'probing')
        phase.value = 'results'
    })
    await lua.setParam(PORT_PROBE_ACTIVE_PARAM, 1)
  }

  // End the run: set the roles found (`keep`), or put every port back,
  // take the applet off, turn scripting back off if it was off, restart.
  async function finish(keep: boolean): Promise<void> {
    const b = backup.value
    if (!b)
      return
    error.value = null
    unsubscribe?.()
    unsubscribe = null
    const outcomes = keep ? plan.value : planRoles(b.probed, new Map(), new Map(b.roles))
    const edits = keep ? outcomeEdits(outcomes) : restoreEdits(b.probed, new Map(b.roles))
    if (b.scriptingWasOff)
      edits.push({ name: 'SCR_ENABLE', value: 0 })
    phase.value = 'applying'
    await lua.setParam(PORT_PROBE_ACTIVE_PARAM, 0).catch(() => ({ acked: false }))
    await lua.removeApplet(PORT_PROBE_ID).catch(() => {})
    if (!await write(edits)) {
      error.value = 'We couldn\'t save the ports\' roles. Check the connection and try again.'
      phase.value = 'failed'
      return
    }
    if (!await restart())
      return
    applied.value = outcomes
    backup.value = null
    saveBackup(session.fcUid, null)
    phase.value = 'done'
  }

  // Leaving mid-run can't wait for anything; the backup stays, so the
  // next visit offers to put the ports back.
  function detach(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return { phase, error, probed, roles, results, plan, applied, trying, start, finish, detach }
}
