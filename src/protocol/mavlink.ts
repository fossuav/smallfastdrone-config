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

// MAVLink session wrapper around node-mavlink, plus helpers for the
// specific messages the rest of the app needs to build or interpret.
//
// node-mavlink + mavlink-mappings give us typed classes for every message
// in every dialect we care about (minimal + standard + common +
// ardupilotmega), plus a streaming v2 packet splitter and a
// CRC-validating parser. We polyfill Node's Buffer / stream APIs in
// vite.config.ts so the lib runs in the browser unchanged.
//
// What lives in this file: the MavLinkSession class (feed bytes in,
// subscribe to decoded messages out, serialize messages for sending),
// re-exported message ids the stores reference, builder functions for
// the COMMAND_LONG / REQUEST_DATA_STREAM messages we send to bootstrap
// telemetry, and small operator-friendly label functions (vehicle type,
// autopilot, system status) that strip MAVLink jargon out of UI strings.

import type { MavLinkData, MavLinkDataConstructor } from 'mavlink-mappings'
import { Buffer } from 'node:buffer'
import * as ardupilotmega from 'mavlink-mappings/dist/lib/ardupilotmega'
import * as common from 'mavlink-mappings/dist/lib/common'
import * as minimal from 'mavlink-mappings/dist/lib/minimal'
import * as standard from 'mavlink-mappings/dist/lib/standard'
import {
  MavLinkPacketParser,
  MavLinkPacketSplitter,
  MavLinkProtocolV2,
} from 'node-mavlink'

// Merge the registries of every dialect we speak. Vite tree-shaking can't
// help much here because the upstream package is CommonJS — the bundle
// includes the merged metadata for all common + ArduPilot messages either
// way. Cost is small for the benefit of one decoder path for everything.
const REGISTRY = {
  ...minimal.REGISTRY,
  ...standard.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
} as Record<number, MavLinkDataConstructor<MavLinkData>>

export interface DecodedMessage {
  msgid: number
  msgName: string
  sysid: number
  compid: number
  seq: number
  data: MavLinkData
}

export type MessageHandler = (msg: DecodedMessage) => void

export interface MavLinkSessionOptions {
  /** Our GCS source system id when sending. Default 255 (conventional GCS). */
  sysid?: number
  /** Our GCS source component id when sending. Default 190 (MAV_COMP_ID_USER1). */
  compid?: number
}

export class MavLinkSession {
  private readonly splitter = new MavLinkPacketSplitter()
  private readonly parser = new MavLinkPacketParser()
  private readonly protocol: MavLinkProtocolV2
  private readonly listeners = new Set<MessageHandler>()
  private seq = 0

  // Build a session bound to the given GCS source identity. The splitter
  // is piped into the parser at construction; from then on, every chunk
  // fed via feed() is reassembled, CRC-checked, decoded against the merged
  // dialect registry, and fanned out to subscribers.
  constructor(opts: MavLinkSessionOptions = {}) {
    this.protocol = new MavLinkProtocolV2(opts.sysid ?? 255, opts.compid ?? 190)
    this.splitter.pipe(this.parser)
    this.parser.on('data', (packet) => {
      const clazz = REGISTRY[packet.header.msgid]
      if (!clazz)
        return
      const data = this.protocol.data(packet.payload, clazz)
      const msg: DecodedMessage = {
        msgid: packet.header.msgid,
        msgName: clazz.MSG_NAME,
        sysid: packet.header.sysid,
        compid: packet.header.compid,
        seq: packet.header.seq,
        data,
      }
      for (const cb of this.listeners) cb(msg)
    })
  }

  // Feed raw bytes from the transport.
  feed(bytes: Uint8Array): void {
    this.splitter.write(Buffer.from(bytes))
  }

  // Serialize a typed message into a v2 frame ready to push at the transport.
  serialize<T extends MavLinkData>(message: T): Uint8Array {
    const buf = this.protocol.serialize(message, this.seq++ & 0xFF)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  // Subscribe to every decoded message the session emits. Returns an
  // unsubscribe function; callers must invoke it to avoid leaking
  // listeners when their owning store / component goes away.
  on(cb: MessageHandler): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // Clear per-session state. Called when the operator disconnects so a
  // fresh connect starts with a clean send-sequence counter.
  reset(): void {
    this.seq = 0
    // The splitter/parser are stateful only in their internal byte buffer;
    // a fresh connection always starts mid-stream anyway, so the splitter
    // just resynchronises on the next valid STX. No explicit reset API.
  }
}

// Common MAVLink message ids re-exported so callers don't need to dig
// into the mappings tree.
export const MSGID_HEARTBEAT = minimal.Heartbeat.MSG_ID
export const MSGID_AUTOPILOT_VERSION = standard.AutopilotVersion.MSG_ID
// STATUSTEXT — operator-readable banner / prearm / runtime messages.
export const MSGID_STATUSTEXT = common.StatusText.MSG_ID
// SYS_STATUS — per-subsystem present/enabled/healthy bitmasks. Drives
// the operator-facing status panel on the Connect view.
export const MSGID_SYS_STATUS = common.SysStatus.MSG_ID

// Subset of MAV_SYS_STATUS_SENSOR bit values we surface to the operator.
// Full enum has 30+ bits; the ones below are the "is the drone ready"
// indicators that matter for a multicopter bringup.
export const SYS_STATUS_BITS = {
  gyro: 1 << 0,
  accel: 1 << 1,
  mag: 1 << 2,
  baro: 1 << 3,
  gps: 1 << 5,
  rc: 1 << 16,
  ahrs: 1 << 21,
  battery: 1 << 25,
  prearm: 1 << 28,
} as const

export type SubsystemKey = keyof typeof SYS_STATUS_BITS
export type SubsystemState = 'ok' | 'unhealthy' | 'off'

export interface SubsystemStatus {
  key: SubsystemKey
  state: SubsystemState
}

// Given a SYS_STATUS message's three bitmasks, classify each surfaced
// subsystem as ok / unhealthy / off. 'ok' means enabled AND healthy;
// 'unhealthy' means enabled but the FC says it's failing; 'off' means
// not enabled (so not contributing to the ready-to-arm verdict).
export function deriveSubsystemStatus(
  present: number,
  enabled: number,
  health: number,
): SubsystemStatus[] {
  const out: SubsystemStatus[] = []
  for (const key of Object.keys(SYS_STATUS_BITS) as SubsystemKey[]) {
    const mask = SYS_STATUS_BITS[key]
    const isPresent = (present & mask) !== 0
    const isEnabled = (enabled & mask) !== 0
    const isHealthy = (health & mask) !== 0
    let state: SubsystemState
    if (!isPresent || !isEnabled)
      state = 'off'
    else if (!isHealthy)
      state = 'unhealthy'
    else state = 'ok'
    out.push({ key, state })
  }
  return out
}

// Build a REQUEST_DATA_STREAM to ask the FC to start streaming all of
// its standard telemetry (SYS_STATUS, ATTITUDE, VFR_HUD, …) at the
// given rate. ArduPilot honours the legacy stream request and is what
// MAVProxy uses by default. Without this, SITL only emits heartbeat
// until something asks for more.
export function buildRequestDataStream(
  targetSystem: number,
  targetComponent: number,
  rateHz: number,
): common.RequestDataStream {
  const r = new common.RequestDataStream()
  r.targetSystem = targetSystem
  r.targetComponent = targetComponent
  r.reqStreamId = 0 // MAV_DATA_STREAM_ALL
  r.reqMessageRate = rateHz
  r.startStop = 1
  return r
}

// Build an ardupilotmega DO_SEND_BANNER command. ArduPilot replies with
// several STATUSTEXTs including the vehicle + version string (which is
// the only place the SFD suffix shows up — AUTOPILOT_VERSION doesn't
// carry it).
export function buildDoSendBanner(targetSystem: number, targetComponent: number): common.CommandLong {
  const cmd = new common.CommandLong()
  cmd.targetSystem = targetSystem
  cmd.targetComponent = targetComponent
  // DO_SEND_BANNER lives in the ardupilotmega dialect; common.MavCmd
  // doesn't declare it. Cast through unknown to keep TS happy without
  // weakening the common.CommandLong type elsewhere.
  cmd.command = ardupilotmega.MavCmd.DO_SEND_BANNER as unknown as common.MavCmd
  cmd._param1 = 0
  cmd._param2 = 0
  cmd._param3 = 0
  cmd._param4 = 0
  cmd._param5 = 0
  cmd._param6 = 0
  cmd._param7 = 0
  cmd.confirmation = 0
  return cmd
}

// Build a soft-reboot COMMAND_LONG (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
// command id 246). param1=1 means "reboot the autopilot." ArduPilot
// acks via COMMAND_ACK and then exits — useful to inspect the ack but
// not required, since the connection drops either way as the FC
// restarts. Used by the drone-settings page's reboot orchestration.
export function buildPreflightReboot(targetSystem: number, targetComponent: number): common.CommandLong {
  const cmd = new common.CommandLong()
  cmd.targetSystem = targetSystem
  cmd.targetComponent = targetComponent
  cmd.command = 246 as common.MavCmd // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
  cmd._param1 = 1
  cmd._param2 = 0
  cmd._param3 = 0
  cmd._param4 = 0
  cmd._param5 = 0
  cmd._param6 = 0
  cmd._param7 = 0
  cmd.confirmation = 0
  return cmd
}

// MAV_SEVERITY thresholds we care about for operator-facing toasting.
//   0..3  EMERGENCY / ALERT / CRITICAL / ERROR — surface as error toast
//   4     WARNING — surface as warning toast
//   5..7  NOTICE / INFO / DEBUG — log only, don't interrupt
export const MAV_SEVERITY_ERROR_MAX = 3
export const MAV_SEVERITY_WARNING = 4

// Project an AUTOPILOT_VERSION uid / uid2 pair into a stable hex string
// that identifies the connected flight controller across reboots and
// reflashes. uid2 is the modern 18-byte hardware identifier (MCU device
// id + extra) and is preferred when present; uid is the legacy 64-bit
// field and is used as a fallback. Returns null if neither is set
// (e.g. the FC didn't reply with AUTOPILOT_VERSION). Used as the
// per-drone partition key for wizard-progress persistence.
export function formatFcUid(uid: bigint | number | string, uid2?: ArrayLike<number>): string | null {
  if (uid2 && uid2.length > 0) {
    let allZero = true
    let hex = ''
    for (let i = 0; i < uid2.length; i++) {
      const b = uid2[i] ?? 0
      if (b !== 0)
        allZero = false
      hex += b.toString(16).padStart(2, '0')
    }
    if (!allZero)
      return hex
  }
  const n = typeof uid === 'bigint' ? uid : BigInt(uid)
  if (n === 0n)
    return null
  return n.toString(16)
}

// Decode AUTOPILOT_VERSION's flight_sw_version (uint32) + flight_custom_version
// (uint8[8] containing the build's git short hash as ASCII) into an
// operator-readable string like "4.7.0-beta (d0615774)". The custom_version
// bytes can also arrive as a number[] depending on how the mavlink-mappings
// decoder handed them back; accept either.
export function decodeFirmwareVersion(swVersion: number, customVersion: ArrayLike<number>): string {
  const type = swVersion & 0xFF
  const patch = (swVersion >> 8) & 0xFF
  const minor = (swVersion >> 16) & 0xFF
  const major = (swVersion >>> 24) & 0xFF

  const typeStr = type === 0
    ? '-dev'
    : type === 64
      ? '-alpha'
      : type === 128
        ? '-beta'
        : type === 192
          ? '-rc'
          : '' // 255 = official, no suffix

  // The custom_version is 8 bytes of ASCII git hash (ArduPilot convention),
  // null-terminated if shorter than 8 chars.
  const bytes = Uint8Array.from(customVersion)
  let end = bytes.indexOf(0)
  if (end === -1)
    end = bytes.length
  const hash = new TextDecoder().decode(bytes.slice(0, end)).trim()

  const ver = `${major}.${minor}.${patch}${typeStr}`
  return hash ? `${ver} (${hash})` : ver
}

// Build a COMMAND_LONG that asks the target FC to send a specific message.
// We use this immediately after the first heartbeat to ask for
// AUTOPILOT_VERSION (msgid 148) so the UI can show firmware details.
export function buildRequestMessage(targetSystem: number, targetComponent: number, requestedMsgId: number): common.CommandLong {
  const cmd = new common.CommandLong()
  cmd.targetSystem = targetSystem
  cmd.targetComponent = targetComponent
  cmd.command = common.MavCmd.REQUEST_MESSAGE
  cmd._param1 = requestedMsgId
  cmd._param2 = 0
  cmd._param3 = 0
  cmd._param4 = 0
  cmd._param5 = 0
  cmd._param6 = 0
  cmd._param7 = 0
  cmd.confirmation = 0
  return cmd
}

// Operator-friendly label for a vehicle type, per docs/UX.md microcopy
// rule (no MAVLink jargon in user-facing strings).
export function vehicleTypeLabel(type: minimal.MavType): string {
  switch (type) {
    case minimal.MavType.QUADROTOR: return 'Quadcopter'
    case minimal.MavType.HEXAROTOR: return 'Hexacopter'
    case minimal.MavType.OCTOROTOR: return 'Octocopter'
    case minimal.MavType.TRICOPTER: return 'Tricopter'
    case minimal.MavType.HELICOPTER: return 'Helicopter'
    case minimal.MavType.COAXIAL: return 'Coaxial copter'
    case minimal.MavType.FIXED_WING: return 'Plane'
    case minimal.MavType.VTOL_TAILSITTER_QUADROTOR:
    case minimal.MavType.VTOL_TILTROTOR:
    case minimal.MavType.VTOL_FIXEDROTOR:
    case minimal.MavType.VTOL_TAILSITTER:
    case minimal.MavType.VTOL_TILTWING:
      return 'VTOL'
    case minimal.MavType.GROUND_ROVER: return 'Rover'
    case minimal.MavType.SURFACE_BOAT: return 'Boat'
    case minimal.MavType.SUBMARINE: return 'Submarine'
    case minimal.MavType.ANTENNA_TRACKER: return 'Antenna tracker'
    case minimal.MavType.GENERIC: return 'Drone'
    default: return 'Drone'
  }
}

// Operator-friendly label for the autopilot family. Note that "ArduPilot"
// is the wire-level label; the session store may override this with
// "SmallFastDrone" when STATUSTEXT banner detection fires.
export function autopilotLabel(autopilot: minimal.MavAutopilot): string {
  switch (autopilot) {
    case minimal.MavAutopilot.ARDUPILOTMEGA: return 'ArduPilot'
    case minimal.MavAutopilot.PX4: return 'PX4'
    case minimal.MavAutopilot.INVALID: return 'Companion / GCS'
    case minimal.MavAutopilot.GENERIC: return 'Generic autopilot'
    default: return 'Unknown autopilot'
  }
}

// Operator-friendly label for the autopilot's lifecycle state, the value
// the FC reports in the HEARTBEAT system_status field.
export function systemStatusLabel(status: minimal.MavState): string {
  switch (status) {
    case minimal.MavState.UNINIT: return 'Booting'
    case minimal.MavState.BOOT: return 'Booting'
    case minimal.MavState.CALIBRATING: return 'Calibrating'
    case minimal.MavState.STANDBY: return 'Standby'
    case minimal.MavState.ACTIVE: return 'Flying'
    case minimal.MavState.CRITICAL: return 'Critical'
    case minimal.MavState.EMERGENCY: return 'Emergency'
    case minimal.MavState.POWEROFF: return 'Powering off'
    case minimal.MavState.FLIGHT_TERMINATION: return 'Flight terminated'
    default: return 'Unknown state'
  }
}
