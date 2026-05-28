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

// useConnections — composable for the Connections wizard's live UART
// table. Wraps fetches of @SYS/uarts.txt over MAVLink-FTP, parses the
// result, and merges each port with its matching SERIALn_PROTOCOL /
// SERIALn_BAUD from the params store. Slice 2 adds detect(): two
// samples taken `DETECT_WINDOW_MS` apart let us classify each port as
// active / silent / outbound-only by byte-counter delta — the
// firmware-agnostic auto-detect signal (the SITL-only `connected` flag
// from uart-info.ts isn't usable on real hardware).

import type { Finding } from './uart-activity'
import type { UartInfo } from './uart-info'
import { ref, shallowRef } from 'vue'
import { MavFtp } from '../protocol/ftp'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { useReconnect } from './reconnect'
import { buildEdit, presetById } from './serial-protocol-presets'
import { protocolLabel } from './serial-protocols'
import { classifyActivity, classifyFinding } from './uart-activity'
import { parseUartsTxt } from './uart-info'

// Re-export so existing call sites (ConnectionsTable, the wizard view)
// don't need to know the labels moved into their own module.
export { PROTOCOL_LABELS, protocolLabel } from './serial-protocols'

// MAVLink component id for the autopilot — the FTP service runs there.
const COMP_ID_AUTOPILOT = 1

// Path the firmware exposes for the UART status table. See
// AP_Filesystem_Sys.cpp; the @SYS prefix is a virtual filesystem root.
const UARTS_PATH = '@SYS/uarts.txt'

// How long to watch byte counters before deciding a port is silent.
// 4 s catches everything operators encounter on a connected drone —
// GPS at 5+ Hz, CRSF at 50+ Hz, MAVLink heartbeats at 1 Hz, ESC tel
// when motors are spinning. Long enough that a slow heartbeat shows;
// short enough that the operator isn't drumming their fingers.
export const DETECT_WINDOW_MS = 4000

// How often to step the visible progress bar during the wait. 100 ms
// gives a smooth 40-step animation without spamming the render loop.
const PROGRESS_TICK_MS = 100

// Sampling state. 'idle' = no findings yet; 'sampling' = window open,
// progress.value is the 0..1 fraction; 'done' = findings populated.
export type DetectPhase = 'idle' | 'sampling' | 'done'

// Apply-pipeline phase when the operator commits staged protocol
// edits. 'writing' = PARAM_SETs in flight; 'restarting' = waiting for
// the FC to reboot; 'reconnecting' = waiting for a fresh heartbeat;
// 'idle' = nothing in flight. 'reading' covers the post-apply
// re-detect that confirms the new config is live.
export type ApplyPhase = 'idle' | 'writing' | 'restarting' | 'reconnecting' | 'reading'

// One row of the Connections panel — a UART from uarts.txt plus its
// current protocol/baud from the params store. `active` is the cheap
// "is anything flowing on this UART right now" signal off the
// instantaneous TXBD/RXBD; slice 2 will replace this with a
// before/after byte-counter delta over a sampling window so a UART
// that's open but momentarily silent doesn't show as inactive.
export interface ConnectionRow {
  // Original UART entry from uarts.txt — kept whole so the panel can
  // surface descriptor / DMA flags / SITL connected hint without
  // re-flattening every field.
  uart: UartInfo
  // SERIALn_PROTOCOL value from the params store, null if the param
  // isn't present (true for IOMCU rows and for any SERIAL slot the FC
  // doesn't expose a param for).
  protocol: number | null
  // SERIALn_BAUD value, null if not present.
  baud: number | null
  // Operator-friendly protocol name for the table cell.
  protocolLabel: string
  // Any byte flow seen in the last firmware sampling interval.
  active: boolean
}

// Build the rows. Pure function so the composable + tests can both
// call it without standing up a real session.
export function buildConnectionRows(
  uarts: UartInfo[],
  protocols: ReadonlyMap<string, number>,
  bauds: ReadonlyMap<string, number>,
): ConnectionRow[] {
  return uarts.map((u) => {
    const protocol = u.index !== null ? (protocols.get(`SERIAL${u.index}_PROTOCOL`) ?? null) : null
    const baud = u.index !== null ? (bauds.get(`SERIAL${u.index}_BAUD`) ?? null) : null
    return {
      uart: u,
      protocol,
      baud,
      protocolLabel: protocolLabel(protocol),
      active: u.txBd > 0 || u.rxBd > 0,
    }
  })
}

// Composable for the Connections panel. refresh() is the one-shot
// fetch the panel mounts on; detect() runs the sampling window for the
// "Check what's plugged in" flow; stageProtocol/apply edit the SERIAL
// params per row and walk the reboot/reconnect/re-detect choreography.
export function useConnections() {
  const session = useSessionStore()
  const params = useParamsStore()
  const { autoReconnect } = useReconnect()

  // Loading state for the fetch button; rows reactive so the table
  // re-renders after refresh().
  const loading = ref(false)
  const error = shallowRef<string | null>(null)
  const rows = shallowRef<ConnectionRow[]>([])

  // Detection state. findings is keyed by UartInfo.logical so the
  // table can join row → finding without a second pass.
  const detectPhase = ref<DetectPhase>('idle')
  const progress = ref(0)
  const findings = shallowRef<Map<string, Finding>>(new Map())

  // Per-row pending edits. Keyed by uart.logical (SERIAL3 etc.) so the
  // staging survives a refresh() that rebuilds the rows array. Value
  // is a preset id from serial-protocol-presets.ts; the actual param
  // names + values get resolved at apply() time.
  const pendingEdits = shallowRef<Map<string, string>>(new Map())
  const applyPhase = ref<ApplyPhase>('idle')
  const applyError = shallowRef<string | null>(null)

  // Build the per-SERIAL param lookup maps from whatever's in the
  // params store right now. Cheap to do per call; the store's already
  // the cache.
  function paramMaps(): { protocols: Map<string, number>, bauds: Map<string, number> } {
    const protocols = new Map<string, number>()
    const bauds = new Map<string, number>()
    for (const [name, p] of params.params) {
      if (name.endsWith('_PROTOCOL') && name.startsWith('SERIAL'))
        protocols.set(name, p.value)
      else if (name.endsWith('_BAUD') && name.startsWith('SERIAL'))
        bauds.set(name, p.value)
    }
    return { protocols, bauds }
  }

  // FTP one snapshot of @SYS/uarts.txt and return the parsed ports.
  // Used by both refresh() and detect(); throws on any FTP/parse
  // failure so the caller can surface a single error message.
  //
  // resetSessions() up front clears any FTP session slots the FC has
  // tied up from a previous client (the firmware doesn't free them
  // automatically). Without this, repeated wizard runs across the same
  // session can exhaust SITL's session table and downloadFile()
  // surfaces a generic "Fail" NAK on OpenFileRO.
  async function fetchUarts(): Promise<UartInfo[]> {
    if (!session.connected || session.sysid === null)
      throw new Error('Connect to your drone first.')
    const ftp = new MavFtp(
      session.sendMessage,
      session.subscribeMessages,
      session.sysid,
      COMP_ID_AUTOPILOT,
    )
    await ftp.resetSessions()
    const bytes = await ftp.downloadFile(UARTS_PATH)
    const text = new TextDecoder().decode(bytes)
    return parseUartsTxt(text).ports
  }

  // Fetch @SYS/uarts.txt + rebuild rows. Loads the params store first
  // if empty so SERIAL{n}_PROTOCOL is available for the merge.
  async function refresh() {
    if (loading.value)
      return
    loading.value = true
    error.value = null
    try {
      if (params.count === 0)
        await params.load()
      const ports = await fetchUarts()
      const { protocols, bauds } = paramMaps()
      rows.value = buildConnectionRows(ports, protocols, bauds)
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loading.value = false
    }
  }

  // Detect: take a uarts.txt snapshot, watch byte counters for
  // DETECT_WINDOW_MS, snapshot again, classify each port. Findings are
  // joined by `logical` (SERIAL0..n / IOMCU) so the panel can render
  // the verdict next to each row. Re-entry while already sampling is a
  // no-op (the button is meant to disable itself but the guard is
  // belt-and-braces).
  async function detect() {
    if (detectPhase.value === 'sampling' || loading.value)
      return
    detectPhase.value = 'sampling'
    progress.value = 0
    findings.value = new Map()
    error.value = null
    try {
      if (params.count === 0)
        await params.load()

      const before = await fetchUarts()

      // Animate progress over the watch window. performance.now() is
      // the monotonic clock — Date.now() can step backward across NTP
      // adjustments and we'd render a stuttering bar.
      const t0 = performance.now()
      while (performance.now() - t0 < DETECT_WINDOW_MS) {
        progress.value = Math.min(1, (performance.now() - t0) / DETECT_WINDOW_MS)
        await new Promise(resolve => setTimeout(resolve, PROGRESS_TICK_MS))
      }
      progress.value = 1

      const after = await fetchUarts()
      const dtMs = performance.now() - t0

      // Build the post-sample rows (latest counters + current params)
      // and pair each with the before snapshot keyed by logical id.
      const { protocols, bauds } = paramMaps()
      const beforeMap = new Map(before.map(p => [p.logical, p]))
      const newRows = buildConnectionRows(after, protocols, bauds)
      const newFindings = new Map<string, Finding>()
      for (const row of newRows) {
        const b = beforeMap.get(row.uart.logical)
        const activity = b ? classifyActivity(b, row.uart, dtMs) : 'unknown'
        newFindings.set(row.uart.logical, classifyFinding(row, activity))
      }

      rows.value = newRows
      findings.value = newFindings
      detectPhase.value = 'done'
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      detectPhase.value = 'idle'
      progress.value = 0
    }
  }

  // Stage / un-stage a protocol change for one row. Picking the
  // preset that already matches the row's current protocol clears the
  // edit (operator un-did their change) rather than staging a no-op.
  function stageProtocol(rowKey: string, presetId: string | null) {
    const next = new Map(pendingEdits.value)
    if (presetId === null) {
      next.delete(rowKey)
      pendingEdits.value = next
      return
    }
    // Don't stage if it matches the current value — that's an un-edit.
    const row = rows.value.find(r => r.uart.logical === rowKey)
    const preset = presetById(presetId)
    if (row && preset && row.protocol === preset.protocol) {
      next.delete(rowKey)
      pendingEdits.value = next
      return
    }
    next.set(rowKey, presetId)
    pendingEdits.value = next
  }

  // Clear all staged edits without writing anything.
  function discardEdits() {
    pendingEdits.value = new Map()
  }

  // Walk the apply pipeline: PARAM_SET each staged edit via the params
  // store, reboot the FC, wait for the heartbeat to come back, reload
  // params, re-run detect so the operator sees the result of their
  // change. Same write-then-reboot-then-reconnect rhythm as
  // SettingsView (scripting toggle) and motor-check's auto-correction.
  async function apply() {
    if (applyPhase.value !== 'idle' || pendingEdits.value.size === 0)
      return
    if (!session.connected || session.sysid === null) {
      applyError.value = 'Connect to your drone first.'
      return
    }
    applyError.value = null

    // Resolve every staged preset into the SERIAL{n}_PROTOCOL +
    // SERIAL{n}_BAUD param writes. Stage all of them through the
    // params store, then a single apply() does the PARAM_SET burst.
    const rowMap = new Map(rows.value.map(r => [r.uart.logical, r]))
    let staged = 0
    for (const [rowKey, presetId] of pendingEdits.value) {
      const row = rowMap.get(rowKey)
      const preset = presetById(presetId)
      if (!row || !preset)
        continue
      const edit = buildEdit(row, preset)
      if (!edit)
        continue
      params.setEdit(edit.protocolParam, edit.protocolValue)
      params.setEdit(edit.baudParam, edit.baudValue)
      staged += 2
    }
    if (staged === 0) {
      applyError.value = 'Nothing to write.'
      return
    }

    applyPhase.value = 'writing'
    try {
      await params.apply()

      // Reboot + reconnect. SERIALn_PROTOCOL is read once at boot —
      // changing it live doesn't switch the protocol — so the FC must
      // restart for the new mapping to take effect.
      applyPhase.value = 'restarting'
      await session.reboot()

      applyPhase.value = 'reconnecting'
      const back = await autoReconnect()
      if (!back) {
        applyError.value = 'Your drone didn\'t come back from its restart. Try unplugging and reconnecting.'
        applyPhase.value = 'idle'
        return
      }

      applyPhase.value = 'reading'
      await params.load()

      // Clear the staged edits — the writes either landed (in which
      // case the new values are now in params) or were rejected by
      // the FC (in which case the params store carries the
      // mismatched state and the operator can re-edit).
      pendingEdits.value = new Map()

      // Re-run detect so the operator immediately sees whether the
      // new protocol assignment is actually carrying traffic.
      await detect()

      applyPhase.value = 'idle'
    }
    catch (e) {
      applyError.value = e instanceof Error ? e.message : String(e)
      applyPhase.value = 'idle'
    }
  }

  return {
    rows,
    loading,
    error,
    refresh,
    detect,
    detectPhase,
    progress,
    findings,
    pendingEdits,
    stageProtocol,
    discardEdits,
    apply,
    applyPhase,
    applyError,
  }
}
