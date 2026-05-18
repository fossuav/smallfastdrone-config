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

export class MavLinkSession {
  private readonly splitter = new MavLinkPacketSplitter()
  private readonly parser = new MavLinkPacketParser()
  private readonly protocol = new MavLinkProtocolV2()
  private readonly listeners = new Set<MessageHandler>()
  private seq = 0

  constructor() {
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

// MAVLink common HEARTBEAT message id. Re-exported so callers don't need
// to dig into the mappings tree just to identify a heartbeat.
export const MSGID_HEARTBEAT = minimal.Heartbeat.MSG_ID

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
