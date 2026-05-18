// MAVLink session wrapper around node-mavlink.
//
// node-mavlink + mavlink-mappings give us typed classes for every message
// in every dialect we care about (common + ardupilotmega), plus a
// streaming v2 packet splitter and a CRC-validating parser. We polyfill
// Node's Buffer / stream APIs in vite.config.ts so the lib runs in the
// browser unchanged.
//
// Today: receive HEARTBEAT, expose typed messages via a subscriber. Sending
// (COMMAND_LONG to request AUTOPILOT_VERSION, PARAM_SET to write params,
// etc.) lands in a later slice — the serialize() path is here, ready.

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

  on(cb: MessageHandler): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

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

export function autopilotLabel(autopilot: minimal.MavAutopilot): string {
  switch (autopilot) {
    case minimal.MavAutopilot.ARDUPILOTMEGA: return 'ArduPilot'
    case minimal.MavAutopilot.PX4: return 'PX4'
    case minimal.MavAutopilot.INVALID: return 'Companion / GCS'
    case minimal.MavAutopilot.GENERIC: return 'Generic autopilot'
    default: return 'Unknown autopilot'
  }
}

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
