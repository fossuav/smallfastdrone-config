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

// Drone session store. Owns the transport, the MavLinkSession, the
// connection lifecycle (connect / disconnect / error surfacing), and the
// derived state every other store + view reads: vehicle type, autopilot,
// firmware string, recent STATUSTEXTs, subsystem health, ready-to-arm.
//
// On first heartbeat after a successful connect the store kicks off the
// telemetry handshake — REQUEST_MESSAGE for AUTOPILOT_VERSION (firmware
// fields), DO_SEND_BANNER (operator-readable banner that carries the
// SFD suffix), and REQUEST_DATA_STREAM (kicks SITL into streaming the
// SYS_STATUS / ATTITUDE / VFR_HUD / etc. messages it withholds from
// fresh clients by default).
//
// The send + subscribe helpers at the bottom (`sendMessage`,
// `subscribeMessages`) are the public hooks downstream stores (params,
// future wizards) use to participate in the session without holding
// onto the raw MavLinkSession instance.

import type { MavLinkData } from 'mavlink-mappings'
import type { StatusText, SysStatus } from 'mavlink-mappings/dist/lib/common'
import type { Heartbeat, MavAutopilot, MavState, MavType } from 'mavlink-mappings/dist/lib/minimal'
import type { AutopilotVersion } from 'mavlink-mappings/dist/lib/standard'
import type { MessageHandler, SubsystemStatus } from '../protocol/mavlink'
import type { Transport } from '../transport/types'
import type { WebSerialTransport } from '../transport/webserial'
import type { SecurityPosture } from '../workflow/drone-security'
import { useToast } from '@nuxt/ui/composables/useToast'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  autopilotLabel,
  buildDoSendBanner,
  buildPreflightReboot,
  buildPreflightRebootToBootloader,
  buildRequestDataStream,
  buildRequestMessage,
  decodeFirmwareVersion,
  deriveSubsystemStatus,
  formatFcUid,
  MAV_SEVERITY_ERROR_MAX,
  MAV_SEVERITY_WARNING,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
  MSGID_SYS_STATUS,
  systemStatusLabel,
  vehicleTypeLabel,
} from '../protocol/mavlink'
import { SecureCommandClient } from '../protocol/secure-command'
import { resolveTransport } from '../transport/select'
import { probeSecurityPosture } from '../workflow/drone-security'

// MAV_COMP_ID_AUTOPILOT1 — the FC's component id, which is what
// REQUEST_MESSAGE for AUTOPILOT_VERSION must target.
const COMP_ID_AUTOPILOT = 1

export interface StatusTextEntry {
  text: string
  severity: number
  receivedAt: number
}

// Drone session — connection state + parsed MAVLink heartbeat + firmware info.
export const useSessionStore = defineStore('session', () => {
  const transport = ref<Transport>(resolveTransport())
  const connected = ref(false)
  const connecting = ref(false)
  const bytesReceived = ref(0)
  const lastError = ref<string | null>(null)

  // Populated as heartbeats arrive.
  const sysid = ref<number | null>(null)
  const vehicleType = ref<MavType | null>(null)
  const autopilot = ref<MavAutopilot | null>(null)
  const systemStatus = ref<MavState | null>(null)
  const lastHeartbeatAt = ref<number | null>(null)

  // Populated by AUTOPILOT_VERSION response.
  const firmwareVersion = ref<string | null>(null)
  // Stable per-FC identifier derived from AUTOPILOT_VERSION's uid / uid2.
  // Used to key per-drone persisted state (wizard progress, eventually
  // wizard resume snapshots) so that switching drones doesn't bleed
  // state from one into the other. Null until AUTOPILOT_VERSION arrives.
  const fcUid = ref<string | null>(null)
  // APJ_BOARD_ID, which ArduPilot packs into AUTOPILOT_VERSION's
  // board_version high half. Recorded in the drone identity file so SFD
  // knows which firmware build the airframe runs. Null until
  // AUTOPILOT_VERSION arrives; 0 on SITL, which has no board id.
  const boardId = ref<number | null>(null)

  // Set true if any STATUSTEXT mentions "SFD" — the boot banner is the
  // primary place this comes through (e.g. "ArduCopter V4.7.0-beta4-SFD
  // (d0615774)"). Drives the operator-facing autopilot label.
  const isSfd = ref(false)
  // How secured this drone is, from one GET_IDENTITY read. `unknown` until
  // the probe answers, and on any drone whose answer we can't interpret.
  const securityPosture = ref<SecurityPosture>('unknown')
  let securityProbed = false

  // Ring buffer of recent STATUSTEXTs (last 50). Used by the (future) log
  // pane; toasts for the WARNING-or-worse subset happen as they arrive.
  const recentStatusTexts = ref<StatusTextEntry[]>([])
  const STATUSTEXT_HISTORY = 50
  // When the operator last opened the message bell. Messages newer than this
  // are "unread" — the bell badge counts only the unread *important* ones
  // (warning-or-worse) so a normal boot's stream of routine INFO lines
  // doesn't read as a pile of unread alerts. Reset to 0 on each connect.
  const statusReadAt = ref(0)

  // Per-subsystem present/enabled/healthy status from SYS_STATUS. Drives
  // the operator-facing status panel on the Connect view.
  const subsystems = ref<SubsystemStatus[]>([])
  // Intent flag the drone-settings page sets when it sends
  // PREFLIGHT_REBOOT_SHUTDOWN, so the UI knows to expect a connection
  // drop and render the reboot/reconnect flow rather than treating
  // the drop as an error. Cleared by the heartbeat handler once a
  // fresh heartbeat arrives post-reconnect.
  const rebooting = ref(false)

  // True when the FC's PREARM_CHECK bit is enabled and healthy — i.e. it
  // has run all its prearm checks and is willing to arm.
  const readyToArm = computed(() => {
    const prearm = subsystems.value.find(s => s.key === 'prearm')
    return prearm?.state === 'ok'
  })

  const vehicleLabel = computed(() =>
    vehicleType.value === null ? null : vehicleTypeLabel(vehicleType.value),
  )
  const autopilotLabelText = computed(() => {
    if (autopilot.value === null)
      return null
    // Operator-facing override: the drone said in its boot banner that
    // it is a SmallFastDrone.
    if (isSfd.value)
      return 'SmallFastDrone'
    return autopilotLabel(autopilot.value)
  })
  const systemStatusText = computed(() =>
    systemStatus.value === null ? null : systemStatusLabel(systemStatus.value),
  )
  const hasHeartbeat = computed(() => lastHeartbeatAt.value !== null)

  const session = new MavLinkSession()
  let versionRequested = false
  // useToast is component-context-free in @nuxt/ui — it reads a shared
  // state list that <UApp> renders. Safe to call once at store init.
  const toast = useToast()

  // Append a STATUSTEXT to the rolling history and surface meaningful ones
  // as operator toasts. The "is this SFD?" sniffer also lives here — the
  // boot banner is the only place the SFD suffix shows up.
  function recordStatusText(text: string, severity: number) {
    const entry: StatusTextEntry = { text, severity, receivedAt: Date.now() }
    recentStatusTexts.value = [...recentStatusTexts.value, entry].slice(-STATUSTEXT_HISTORY)

    // Detect SFD from any banner line, which arrives shortly after we ask
    // via DO_SEND_BANNER. Two shapes exist and both are real: a build that
    // suffixes the version ("ArduCopter V4.7.0-beta4-SFD (d0615774)"), and
    // the product build, which replaces the vehicle name outright
    // ("SmallFastDrone V4.7.0 (630cce8d)"). Matching only the suffix meant
    // the product board — the one that most obviously is a SmallFastDrone —
    // was reported as plain ArduPilot.
    if (!isSfd.value && /\bSFD\b|SmallFastDrone/i.test(text)) {
      isSfd.value = true
    }

    // Surface meaningful messages as operator toasts. NOTICE/INFO/DEBUG
    // are too chatty during boot (every EKF init line) to interrupt with.
    if (severity <= MAV_SEVERITY_ERROR_MAX) {
      toast.add({ title: text, color: 'error', icon: 'i-lucide-circle-alert' })
    }
    else if (severity === MAV_SEVERITY_WARNING) {
      toast.add({ title: text, color: 'warning', icon: 'i-lucide-triangle-alert' })
    }
  }

  // Mark the current messages as seen — called when the operator opens the
  // bell, so its unread badge clears.
  function markStatusTextsRead() {
    statusReadAt.value = Date.now()
  }

  session.on(async (msg) => {
    if (msg.msgid === MSGID_HEARTBEAT) {
      const hb = msg.data as Heartbeat
      sysid.value = msg.sysid
      vehicleType.value = hb.type
      autopilot.value = hb.autopilot
      systemStatus.value = hb.systemStatus
      lastHeartbeatAt.value = Date.now()
      // Fresh heartbeat post-reboot → clear the rebooting intent so
      // the settings UI exits the "drone is restarting" state.
      if (rebooting.value)
        rebooting.value = false

      // First heartbeat after connect: ask for AUTOPILOT_VERSION (for the
      // structured firmware fields), DO_SEND_BANNER (for the human-readable
      // string that carries the SFD suffix), and REQUEST_DATA_STREAM (to
      // kick the FC into streaming SYS_STATUS / ATTITUDE / VFR_HUD etc.,
      // which it doesn't do by default until asked).
      // How secured the drone is takes a round trip that a drone without
      // secure firmware never answers, so it runs on its own rather than
      // holding up the heartbeat handler for the timeout.
      if (!securityProbed && connected.value) {
        securityProbed = true
        void probeSecurity(msg.sysid)
      }

      if (!versionRequested && connected.value) {
        versionRequested = true
        try {
          const ver = buildRequestMessage(msg.sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)
          await transport.value.send(session.serialize(ver))
          const banner = buildDoSendBanner(msg.sysid, COMP_ID_AUTOPILOT)
          await transport.value.send(session.serialize(banner))
          const stream = buildRequestDataStream(msg.sysid, COMP_ID_AUTOPILOT, 2)
          await transport.value.send(session.serialize(stream))
        }
        catch (e) {
          // Non-fatal — heartbeat info still displayed; firmware/banner/status
          // streams just stay blank.
          lastError.value = `couldn't request telemetry: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
    else if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
      const v = msg.data as AutopilotVersion
      firmwareVersion.value = decodeFirmwareVersion(v.flightSwVersion, v.flightCustomVersion)
      fcUid.value = formatFcUid(v.uid, v.uid2)
      boardId.value = v.boardVersion >>> 16
    }
    else if (msg.msgid === MSGID_STATUSTEXT) {
      const st = msg.data as StatusText
      // text is a fixed-length char[N], null-padded.
      const text = st.text.replace(/\0.*$/, '').trim()
      if (text)
        recordStatusText(text, st.severity)
    }
    else if (msg.msgid === MSGID_SYS_STATUS) {
      const ss = msg.data as SysStatus
      subsystems.value = deriveSubsystemStatus(
        ss.onboardControlSensorsPresent,
        ss.onboardControlSensorsEnabled,
        ss.onboardControlSensorsHealth,
      )
    }
  })

  // Ask the drone how secured it is. Never rejects and never surfaces an
  // error: nothing here was requested by the operator, so a drone that
  // doesn't answer simply stays `unknown` and shows no badge at all.
  async function probeSecurity(targetSystem: number): Promise<void> {
    const client = new SecureCommandClient(
      async msg => transport.value.send(session.serialize(msg)),
      cb => session.on(cb),
      targetSystem,
      COMP_ID_AUTOPILOT,
    )
    securityPosture.value = await probeSecurityPosture(client)
  }

  let unsubscribeData: (() => void) | null = null
  let unsubscribeClose: (() => void) | null = null

  // Wipe parsed session state back to "no drone known." Called both on
  // disconnect and on connect (before transport setup), so a stale heartbeat
  // from a prior drone never bleeds into a new session.
  function resetParsed() {
    sysid.value = null
    vehicleType.value = null
    autopilot.value = null
    systemStatus.value = null
    lastHeartbeatAt.value = null
    firmwareVersion.value = null
    fcUid.value = null
    boardId.value = null
    isSfd.value = false
    securityPosture.value = 'unknown'
    securityProbed = false
    rebooting.value = false
    recentStatusTexts.value = []
    statusReadAt.value = 0
    subsystems.value = []
    bytesReceived.value = 0
    versionRequested = false
    session.reset()
  }

  // Open the transport and start consuming bytes. Idempotent — repeated
  // calls while already connected or connecting return without doing
  // anything. Errors are surfaced via `lastError` rather than thrown so
  // the Connect button can render them inline.
  async function connect() {
    if (connected.value || connecting.value)
      return
    connecting.value = true
    lastError.value = null
    resetParsed()
    try {
      await transport.value.connect()
      unsubscribeData = transport.value.on('data', (bytes) => {
        bytesReceived.value += bytes.length
        session.feed(bytes)
      })
      unsubscribeClose = transport.value.on('close', () => {
        connected.value = false
      })
      connected.value = true
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      connected.value = false
    }
    finally {
      connecting.value = false
    }
  }

  // Helpers for downstream stores (params, future wizards) that need to
  // send + receive MAVLink. Encapsulated here so the MavLinkSession
  // instance itself stays private to this store.

  // Serialize and ship one MAVLink message over the active transport.
  async function sendMessage(msg: MavLinkData): Promise<void> {
    await transport.value.send(session.serialize(msg))
  }
  // Subscribe to every decoded message the session sees. Returns an
  // unsubscribe function; the subscriber must invoke it when its
  // owner goes away.
  function subscribeMessages(cb: MessageHandler): () => void {
    return session.on(cb)
  }

  // Ask the FC to reboot. Sets `rebooting` so consumers can render
  // the expected-drop UI rather than treating the upcoming transport
  // close as an error. The reboot command itself is fire-and-forget;
  // ArduPilot may not send a COMMAND_ACK before shutting down, and we
  // can't reliably wait for one. The transport drops on its own when
  // the FC actually exits/disconnects.
  async function reboot() {
    if (!connected.value || sysid.value === null) {
      lastError.value = 'Not connected to a drone'
      return
    }
    try {
      const cmd = buildPreflightReboot(sysid.value, COMP_ID_AUTOPILOT)
      await sendMessage(cmd)
      rebooting.value = true
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
    }
  }

  // Reboot the FC into its bootloader so the firmware-flash workflow
  // can take over the serial port and run the bootloader protocol.
  // Sends MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN with param1=3 (the
  // documented bootloader-keep flag). Sets `rebooting` so the rest of
  // the UI doesn't treat the imminent transport close as an error.
  // After this returns, callers should:
  //   1. Wait briefly so the FC has time to act on the command.
  //   2. Call `transport.value.acquireRaw()` (WebSerial-only) to take
  //      over the port at bootloader baud.
  //   3. Drive the bootloader protocol via BootloaderClient.
  //   4. After REBOOT, call `connect()` again to re-establish MAVLink.
  async function rebootToBootloader() {
    if (!connected.value || sysid.value === null) {
      lastError.value = 'Not connected to a drone'
      return
    }
    try {
      const cmd = buildPreflightRebootToBootloader(sysid.value, COMP_ID_AUTOPILOT)
      await sendMessage(cmd)
      rebooting.value = true
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
    }
  }

  // Adopt an already-authorised SerialPort as the active MAVLink
  // transport. Mirrors `connect()` minus the `requestPort()` prompt —
  // used by the firmware-flash workflow's post-flash reconnect, where
  // the original firmware port is already in `navigator.serial.getPorts()`
  // and just needs to be re-opened (a user gesture isn't available
  // after a multi-second flash). Refuses to run on non-WebSerial
  // transports.
  async function attachToPort(port: SerialPort) {
    if (connected.value || connecting.value)
      return
    if (transport.value.kind !== 'webserial') {
      lastError.value = 'attachToPort: only the WebSerial transport supports this.'
      return
    }
    connecting.value = true
    lastError.value = null
    resetParsed()
    try {
      await (transport.value as WebSerialTransport).attachToPort(port)
      unsubscribeData = transport.value.on('data', (bytes) => {
        bytesReceived.value += bytes.length
        session.feed(bytes)
      })
      unsubscribeClose = transport.value.on('close', () => {
        connected.value = false
      })
      connected.value = true
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      connected.value = false
    }
    finally {
      connecting.value = false
    }
  }

  // Tear the transport down. Subscriber unsubscribe runs first so we
  // don't get a final close-event echo bouncing around mid-teardown.
  async function disconnect() {
    unsubscribeData?.()
    unsubscribeClose?.()
    unsubscribeData = null
    unsubscribeClose = null
    await transport.value.disconnect()
    connected.value = false
  }

  return {
    transport,
    connected,
    connecting,
    bytesReceived,
    lastError,
    sysid,
    vehicleType,
    autopilot,
    systemStatus,
    lastHeartbeatAt,
    firmwareVersion,
    fcUid,
    boardId,
    isSfd,
    securityPosture,
    recentStatusTexts,
    statusReadAt,
    subsystems,
    readyToArm,
    rebooting,
    vehicleLabel,
    autopilotLabelText,
    systemStatusText,
    hasHeartbeat,
    connect,
    attachToPort,
    disconnect,
    reboot,
    rebootToBootloader,
    markStatusTextsRead,
    sendMessage,
    subscribeMessages,
  }
})
