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

// Lua engine helpers — the protocol-level building blocks that Lua-
// engine wizards (see docs/WIZARDS.md) consume. Wrap MavFtp (uploads
// + removals), PARAM_SET (control-param round-trips that bypass the
// params store because Lua-declared params only appear after the
// script loads), and NAMED_VALUE_FLOAT subscription (the standard
// applet → GCS telemetry path) into a single composable.
//
// Deliberately small surface. Higher-level orchestration (lifecycle
// state machine, abort handling, progress UI) is the wizard view's
// concern — this module only owns the protocol primitives.
//
// Scope notes for slice C2:
//   - No auto SCR_ENABLE-and-reboot path yet. Wizards check the flag
//     in their own DesktopView and ask the operator to enable scripting
//     via expert mode + reboot if it's off. Reboot orchestration lands
//     when there's a real wizard motivated to consume it (and a way
//     to test the reboot end-to-end against SITL, which currently
//     dies on PREFLIGHT_REBOOT_SHUTDOWN).
//   - No orphan-cleanup helper yet. Until we have a real Lua wizard
//     to leave orphans behind, premature.

import type { NamedValueFloat, ParamValue } from 'mavlink-mappings/dist/lib/common'
import { MavFtp, MavFtpError } from '../protocol/ftp'
import { buildParamSet } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id, which is what PARAM_SET
// and REQUEST_MESSAGE must target.
const COMP_ID_AUTOPILOT = 1

// MAVLink message ids we filter on. Imported as constants rather than
// reached for via class.MSG_ID at every use site for clarity.
const MSGID_PARAM_VALUE = 22
const MSGID_NAMED_VALUE_FLOAT = 251

// MAV_PARAM_TYPE_REAL32 — Lua-declared WIZ_<ID>_ACTIVE params are
// typically floats since AP_Param's Lua bridge uses REAL32 by default
// for table-added params. Callers can override for non-float params.
const MAV_PARAM_TYPE_REAL32 = 9

// PARAM_SET ack timeout — long enough for a slow USB link but short
// enough that a stuck write doesn't hang a wizard for seconds.
const PARAM_ACK_TIMEOUT_MS = 1500

// Snapshot of the FC's scripting capability. `available` is false when
// the FC doesn't expose SCR_ENABLE at all (vehicle / build without
// scripting compiled in). `enabled` is true only when SCR_ENABLE is
// settable AND its current value is non-zero.
export interface ScriptingStatus {
  available: boolean
  enabled: boolean
}

// Result of a setParam call. acked=false means the FC didn't echo a
// PARAM_VALUE for our PARAM_SET within the timeout — either the param
// doesn't exist on this FC, the connection broke, or the FC rejected
// silently. acceptedValue is the value the FC actually stored (may
// differ from the requested value if it clamped).
export interface SetParamResult {
  acked: boolean
  acceptedValue?: number
}

// Translate a kebab-case wizard id into the on-FC applet filename.
// Lua filenames need to be alphanumeric + underscore; wizard ids are
// kebab-case by convention. `wiz_` prefix keeps the scripts directory
// scannable for operator-installed scripts vs wizard-installed ones.
export function appletFilename(wizardId: string): string {
  return `wiz_${wizardId.replace(/-/g, '_')}.lua`
}

// Full path on the FC's filesystem. ArduPilot loads any *.lua file in
// APM/scripts/ at boot when SCR_ENABLE is set.
export function appletPath(wizardId: string): string {
  return `APM/scripts/${appletFilename(wizardId)}`
}

export function useLuaEngine() {
  const session = useSessionStore()
  const params = useParamsStore()

  // Build a MavFtp targeting the connected FC. Throws if there's no
  // active session — callers should guard with session.connected
  // before invoking any file-touching method.
  function getFtp(): MavFtp {
    if (!session.connected || session.sysid === null) {
      throw new Error('LuaEngine: not connected to a drone')
    }
    return new MavFtp(
      session.sendMessage,
      session.subscribeMessages,
      session.sysid,
      COMP_ID_AUTOPILOT,
    )
  }

  // Check the FC's scripting status. Triggers a params load if the
  // store is empty (the only way to know if SCR_ENABLE exists is to
  // see if the FC reported it). Returns { available, enabled } —
  // available=false means the param isn't in the FC's set, enabled
  // requires SCR_ENABLE > 0.
  async function checkScripting(): Promise<ScriptingStatus> {
    if (params.count === 0)
      await params.load()
    const scrEnable = params.params.get('SCR_ENABLE')
    if (!scrEnable)
      return { available: false, enabled: false }
    return { available: true, enabled: scrEnable.value > 0 }
  }

  // Upload a Lua applet to the FC. Ensures the APM/ + APM/scripts/
  // directory tree exists first (a fresh FC won't have them).
  // FileExists errors during the createDirectory calls are expected
  // and swallowed — they're the success case the second time around.
  async function uploadApplet(wizardId: string, source: string | Uint8Array): Promise<void> {
    const bytes = typeof source === 'string'
      ? new TextEncoder().encode(source)
      : source
    const ftp = getFtp()
    for (const dir of ['APM', 'APM/scripts']) {
      await ftp.createDirectory(dir).catch((e) => {
        if (e instanceof MavFtpError && e.errCode === 8)
          return
        throw e
      })
    }
    await ftp.uploadFile(appletPath(wizardId), bytes)
  }

  // Remove a previously-uploaded applet. Silently swallows FileNotFound
  // because wizard cleanup paths call this even when the file may
  // already be gone (prior abort, manual cleanup, etc.) — "make sure
  // it's not there" is the intent.
  async function removeApplet(wizardId: string): Promise<void> {
    const ftp = getFtp()
    await ftp.removeFile(appletPath(wizardId)).catch((e) => {
      if (e instanceof MavFtpError && e.errCode === 10)
        return
      throw e
    })
  }

  // Set a single parameter on the FC and wait for the PARAM_VALUE
  // echo. Returns the value the FC accepted, or acked=false on
  // timeout. Bypasses the params store deliberately:
  //   - Lua-declared params (the WIZ_<ID>_ACTIVE control params) only
  //     appear in the param set after the applet's add_table runs,
  //     so they may not be in the store's cached map yet.
  //   - Wizard control writes shouldn't get tangled up with the
  //     operator's pending edits in the param browser.
  async function setParam(
    name: string,
    value: number,
    type: number = MAV_PARAM_TYPE_REAL32,
  ): Promise<SetParamResult> {
    if (!session.connected || session.sysid === null)
      throw new Error('LuaEngine: not connected to a drone')
    const targetSys = session.sysid
    return new Promise<SetParamResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const settle = (result: SetParamResult) => {
        if (timer)
          clearTimeout(timer)
        unsubscribe?.()
        resolve(result)
      }

      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as ParamValue
        const echoedName = pv.paramId.replace(/\0.*$/, '')
        if (echoedName !== name)
          return
        settle({ acked: true, acceptedValue: pv.paramValue })
      })

      timer = setTimeout(settle, PARAM_ACK_TIMEOUT_MS, { acked: false })

      session.sendMessage(buildParamSet(targetSys, COMP_ID_AUTOPILOT, name, value, type)).catch(() => {
        settle({ acked: false })
      })
    })
  }

  // Subscribe to NAMED_VALUE_FLOAT messages with a specific name.
  // ArduPilot Lua scripts emit these via `gcs:send_named_float()`;
  // wizard DesktopViews use this to receive progress and result
  // telemetry from their applets. Returns an unsubscribe function.
  // The name is matched exactly after stripping the null-padding
  // ArduPilot adds to the 10-byte name slot.
  function subscribeNamedValue(
    name: string,
    cb: (value: number, timeBootMs: number) => void,
  ): () => void {
    return session.subscribeMessages((msg) => {
      if (msg.msgid !== MSGID_NAMED_VALUE_FLOAT)
        return
      const nvf = msg.data as NamedValueFloat
      const trimmed = nvf.name.replace(/\0.*$/, '').trim()
      if (trimmed !== name)
        return
      cb(nvf.value, nvf.timeBootMs)
    })
  }

  return {
    appletFilename,
    appletPath,
    checkScripting,
    uploadApplet,
    removeApplet,
    setParam,
    subscribeNamedValue,
  }
}
