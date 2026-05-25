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
// Applet load model (important): ArduPilot loads scripts from the
// scripting directory once, when the scripting engine starts. A file
// FTP'd in at runtime is NOT picked up until the engine rescans. So the
// install path is: uploadApplet (FTP) → restartScripting
// (MAV_CMD_SCRIPTING STOP_AND_RESTART, which tears down + recreates the
// Lua state and rescans) → waitForControlParam (the applet's
// WIZ_<ID>_ACTIVE param appears once it has run its add_table). This
// loads a freshly-uploaded applet WITHOUT a full FC reboot. The one
// thing that DOES need a reboot — enabling SCR_ENABLE when it's off — is
// owned by the drone-settings page, not here; wizards treat scripting-on
// as a precondition.
//
// Scope notes:
//   - No orphan-cleanup helper yet. Until we have a real Lua wizard
//     to leave orphans behind, premature.

import type { CommandAck, NamedValueFloat, ParamValue } from 'mavlink-mappings/dist/lib/common'
import type { ScriptStorageStatus } from './script-storage'
import { MavFtp, MavFtpError } from '../protocol/ftp'
import { buildScriptingRestart } from '../protocol/mavlink'
import { buildParamRequestRead, buildParamSet } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from './reconnect'
import { storageProblemFromError } from './script-storage'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id, which is what PARAM_SET
// and REQUEST_MESSAGE must target.
const COMP_ID_AUTOPILOT = 1

// MAVLink message ids we filter on. Imported as constants rather than
// reached for via class.MSG_ID at every use site for clarity.
const MSGID_PARAM_VALUE = 22
const MSGID_NAMED_VALUE_FLOAT = 251
const MSGID_COMMAND_ACK = 77

// MAV_CMD_SCRIPTING — the command buildScriptingRestart() sends. We match
// its COMMAND_ACK by this id. MAV_RESULT_ACCEPTED (0) means the FC took
// the restart request.
const MAV_CMD_SCRIPTING = 42701
const MAV_RESULT_ACCEPTED = 0

// Scripting restart ack window. The FC acks the COMMAND_LONG quickly; the
// actual state teardown + rescan happens asynchronously after.
const SCRIPTING_RESTART_ACK_TIMEOUT_MS = 3000

// After a restart, the applet runs its add_table and its control param
// appears a beat later. Poll for it rather than guessing a fixed delay.
const CONTROL_PARAM_TIMEOUT_MS = 8000
const CONTROL_PARAM_POLL_MS = 500

// MAV_PARAM_TYPE_REAL32 — Lua-declared WIZ_<ID>_ACTIVE params are
// typically floats since AP_Param's Lua bridge uses REAL32 by default
// for table-added params. Callers can override for non-float params.
const MAV_PARAM_TYPE_REAL32 = 9
// MAV_PARAM_TYPE_INT8 — SCR_ENABLE is an int8 flag.
const MAV_PARAM_TYPE_INT8 = 2

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

// Where Lua `require` looks for modules (see lua_bindings.cpp
// LUA_PATH_SCRIPTS). Field applets that `require` a helper ship it here.
const MODULES_DIR = 'APM/scripts/modules'
export function modulePath(name: string): string {
  return `${MODULES_DIR}/${name}`
}

export function useLuaEngine() {
  const session = useSessionStore()
  const params = useParamsStore()
  const { autoReconnect } = useReconnect()

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

  // Probe whether the FC has writable storage for scripts — call this
  // before offering to install, and before the scripting-enable reboot, so
  // the operator isn't put through a restart only to fail at the upload.
  // Creating APM/ is harmless: it's the standard root and usually already
  // exists, which comes back as FileExists (errCode 8) and confirms the
  // volume is writable. A FailErrno means there's nowhere to write;
  // storageProblemFromError names why (almost always a missing SD card).
  async function checkScriptStorage(): Promise<ScriptStorageStatus> {
    const ftp = getFtp()
    try {
      await ftp.createDirectory('APM')
      return 'ok'
    }
    catch (e) {
      if (e instanceof MavFtpError && e.errCode === 8)
        return 'ok'
      return storageProblemFromError(e) ?? 'unknown'
    }
  }

  // Turn scripting on: write SCR_ENABLE=1, settle, reboot, auto-reconnect,
  // reload params. This is the one reboot in the Lua lifecycle (SCR_ENABLE
  // is AP_PARAM_FLAG_ENABLE — only takes effect at boot). Returns true once
  // the FC is back with scripting enabled. The drone-settings page uses the
  // same sequence for its toggle; a field-install flow calls this so the
  // operator doesn't have to detour through settings.
  async function enableScripting(): Promise<boolean> {
    const res = await setParam('SCR_ENABLE', 1, MAV_PARAM_TYPE_INT8)
    if (!res.acked)
      return false
    await sleep(STORAGE_SETTLE_MS)
    await session.reboot()
    const back = await autoReconnect()
    if (!back)
      return false
    params.clear()
    await params.load()
    return true
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

  // Upload a Lua module (a `require`-able dependency, e.g. crsf_helper) to
  // scripts/modules/. Used by install-and-keep field wizards that ship a
  // helper alongside their applet. Ensures the directory tree exists.
  async function uploadModule(name: string, source: string | Uint8Array): Promise<void> {
    const bytes = typeof source === 'string'
      ? new TextEncoder().encode(source)
      : source
    const ftp = getFtp()
    for (const dir of ['APM', 'APM/scripts', MODULES_DIR]) {
      await ftp.createDirectory(dir).catch((e) => {
        if (e instanceof MavFtpError && e.errCode === 8)
          return
        throw e
      })
    }
    await ftp.uploadFile(modulePath(name), bytes)
  }

  // Is a wizard's applet currently present on the FC? Install-and-keep
  // (field / CRSF) wizards use this to show install status. Uses a
  // directory LISTING (a session-less FTP op) rather than opening the
  // file — opening leaves a file session that wedges a following install.
  // Any FTP error is treated as "not installed"; install is idempotent.
  async function isAppletInstalled(wizardId: string): Promise<boolean> {
    const ftp = getFtp()
    const target = appletFilename(wizardId)
    try {
      const entries = await ftp.listDirectory('APM/scripts')
      return entries.some(e => !e.isDir && e.name === target)
    }
    catch {
      return false
    }
  }

  // Restart the FC's Lua scripting engine so a freshly-uploaded applet
  // gets rescanned and loaded (see the load-model note at the top of
  // this file). Requires scripting already enabled — it's a no-op
  // otherwise. Returns true if the FC accepted the restart command.
  // Doesn't wait for the applet to finish loading; pair with
  // waitForControlParam to confirm it's live.
  async function restartScripting(): Promise<boolean> {
    if (!session.connected || session.sysid === null)
      throw new Error('LuaEngine: not connected to a drone')
    const targetSys = session.sysid
    return new Promise<boolean>((resolve) => {
      let unsubscribe: (() => void) | null = null
      const timer = setTimeout(() => {
        unsubscribe?.()
        resolve(false)
      }, SCRIPTING_RESTART_ACK_TIMEOUT_MS)
      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_COMMAND_ACK)
          return
        const ack = msg.data as CommandAck
        if ((ack.command as number) !== MAV_CMD_SCRIPTING)
          return
        clearTimeout(timer)
        unsubscribe?.()
        resolve(ack.result === MAV_RESULT_ACCEPTED)
      })
      session.sendMessage(buildScriptingRestart(targetSys, COMP_ID_AUTOPILOT)).catch(() => {
        clearTimeout(timer)
        unsubscribe?.()
        resolve(false)
      })
    })
  }

  // Read a single parameter by name. Resolves with its value, or null if
  // the FC doesn't reply within timeoutMs (param absent, or link hiccup).
  // A plain read — distinct from setParam's write+echo — used to probe
  // for a Lua-declared param that may not exist yet.
  async function readParam(name: string, timeoutMs = 1500): Promise<number | null> {
    if (!session.connected || session.sysid === null)
      throw new Error('LuaEngine: not connected to a drone')
    const targetSys = session.sysid
    return new Promise<number | null>((resolve) => {
      let unsubscribe: (() => void) | null = null
      const timer = setTimeout(() => {
        unsubscribe?.()
        resolve(null)
      }, timeoutMs)
      unsubscribe = session.subscribeMessages((msg) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as ParamValue
        if (pv.paramId.replace(/\0.*$/, '') !== name)
          return
        clearTimeout(timer)
        unsubscribe?.()
        resolve(pv.paramValue)
      })
      session.sendMessage(buildParamRequestRead(targetSys, COMP_ID_AUTOPILOT, name)).catch(() => {
        clearTimeout(timer)
        unsubscribe?.()
        resolve(null)
      })
    })
  }

  // Poll for an applet's control param to appear after a scripting
  // restart. Resolves true once the FC reports it, false if it hasn't
  // shown up within CONTROL_PARAM_TIMEOUT_MS — which means the applet
  // failed to load (bad upload, Lua error, or a param-table key
  // collision). The install path uses this to confirm the applet is
  // actually live before arming it.
  async function waitForControlParam(name: string): Promise<boolean> {
    const deadline = Date.now() + CONTROL_PARAM_TIMEOUT_MS
    while (Date.now() < deadline) {
      const value = await readParam(name, CONTROL_PARAM_POLL_MS)
      if (value !== null)
        return true
    }
    return false
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
    modulePath,
    checkScripting,
    checkScriptStorage,
    enableScripting,
    uploadApplet,
    removeApplet,
    uploadModule,
    isAppletInstalled,
    restartScripting,
    readParam,
    waitForControlParam,
    setParam,
    subscribeNamedValue,
  }
}
