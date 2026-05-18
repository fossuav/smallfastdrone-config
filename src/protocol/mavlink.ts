// Minimal MAVLink v2 stream parser, Uint8Array-only (no Buffer).
//
// node-mavlink uses Node's `Buffer` and `stream` and doesn't bundle cleanly
// for the browser; mavlink-mappings (its data layer) is pure TS but its
// per-message classes also rely on Buffer for serialise/deserialise. We
// therefore hand-roll the framing here against DataView/Uint8Array and
// pull just the enum constants from mavlink-mappings.
//
// Scope today: frame the v2 byte stream, decode HEARTBEAT (msgid 0) into
// fields we need (sysid, vehicle type, autopilot, system status). Other
// messages are emitted with their raw payload for future slices to decode.

import { MavAutopilot, MavState, MavType } from 'mavlink-mappings/dist/lib/minimal'

const STX_V2 = 0xFD
const HEADER_LEN = 10 // STX + LEN + IFLAGS + CFLAGS + SEQ + SYS + COMP + MSGID(3)
const CRC_LEN = 2
const SIG_LEN = 13
const IFLAG_SIGNED = 0x01

export interface MavLinkMessage {
  sysid: number
  compid: number
  seq: number
  msgid: number
  payload: Uint8Array
}

export type MessageHandler = (msg: MavLinkMessage) => void

// Streaming MAVLink v2 frame splitter. Feed bytes; subscribed handlers
// receive one event per complete frame. CRC and signature are not yet
// validated — frames from SITL through our bridge are trusted for now.
export class MavLinkParser {
  private buf = new Uint8Array(0)
  private readonly listeners = new Set<MessageHandler>()

  feed(bytes: Uint8Array): void {
    if (bytes.length === 0)
      return
    const next = new Uint8Array(this.buf.length + bytes.length)
    next.set(this.buf, 0)
    next.set(bytes, this.buf.length)
    this.buf = next
    this.extractFrames()
  }

  on(cb: MessageHandler): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  reset(): void {
    this.buf = new Uint8Array(0)
  }

  private extractFrames(): void {
    let cursor = 0
    while (cursor < this.buf.length) {
      const stx = this.buf.indexOf(STX_V2, cursor)
      if (stx === -1) {
        // No more frames; discard scanned bytes
        cursor = this.buf.length
        break
      }
      if (stx + HEADER_LEN > this.buf.length) {
        // Wait for more bytes to read the header
        cursor = stx
        break
      }

      const len = this.buf[stx + 1]!
      const incompat = this.buf[stx + 2]!
      const frameLen = HEADER_LEN + len + CRC_LEN + ((incompat & IFLAG_SIGNED) ? SIG_LEN : 0)
      if (stx + frameLen > this.buf.length) {
        cursor = stx
        break
      }

      const seq = this.buf[stx + 4]!
      const sysid = this.buf[stx + 5]!
      const compid = this.buf[stx + 6]!
      const msgid = this.buf[stx + 7]! | (this.buf[stx + 8]! << 8) | (this.buf[stx + 9]! << 16)
      const payload = this.buf.slice(stx + HEADER_LEN, stx + HEADER_LEN + len)

      const msg: MavLinkMessage = { sysid, compid, seq, msgid, payload }
      for (const cb of this.listeners) cb(msg)

      cursor = stx + frameLen
    }

    if (cursor > 0) {
      this.buf = this.buf.slice(cursor)
    }
  }
}

// MAVLink common HEARTBEAT message id.
export const MSGID_HEARTBEAT = 0

export interface Heartbeat {
  customMode: number
  type: MavType
  autopilot: MavAutopilot
  baseMode: number
  systemStatus: MavState
  mavlinkVersion: number
}

// Decode a HEARTBEAT payload. v2 truncates trailing zeros, so any field
// beyond the payload length is treated as 0 — matches the MAVLink spec.
export function decodeHeartbeat(payload: Uint8Array): Heartbeat {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const byteAt = (i: number) => i < payload.length ? payload[i]! : 0
  return {
    customMode: payload.length >= 4 ? view.getUint32(0, true) : 0,
    type: byteAt(4) as MavType,
    autopilot: byteAt(5) as MavAutopilot,
    baseMode: byteAt(6),
    systemStatus: byteAt(7) as MavState,
    mavlinkVersion: byteAt(8),
  }
}

// Operator-friendly label for a vehicle type, per docs/UX.md microcopy
// rule (no MAVLink jargon in user-facing strings).
export function vehicleTypeLabel(type: MavType): string {
  switch (type) {
    case MavType.QUADROTOR: return 'Quadcopter'
    case MavType.HEXAROTOR: return 'Hexacopter'
    case MavType.OCTOROTOR: return 'Octocopter'
    case MavType.TRICOPTER: return 'Tricopter'
    case MavType.HELICOPTER: return 'Helicopter'
    case MavType.COAXIAL: return 'Coaxial copter'
    case MavType.FIXED_WING: return 'Plane'
    case MavType.VTOL_TAILSITTER_QUADROTOR:
    case MavType.VTOL_TILTROTOR:
    case MavType.VTOL_FIXEDROTOR:
    case MavType.VTOL_TAILSITTER:
    case MavType.VTOL_TILTWING:
      return 'VTOL'
    case MavType.GROUND_ROVER: return 'Rover'
    case MavType.SURFACE_BOAT: return 'Boat'
    case MavType.SUBMARINE: return 'Submarine'
    case MavType.ANTENNA_TRACKER: return 'Antenna tracker'
    case MavType.GENERIC: return 'Drone'
    default: return 'Drone'
  }
}

// Operator-friendly label for the autopilot family. SmallFastDrone reports
// MavAutopilot.ARDUPILOTMEGA — we still need to look at AUTOPILOT_VERSION
// or the boot banner to confirm it's actually SFD vs vanilla ArduPilot;
// that lands in a later slice.
export function autopilotLabel(autopilot: MavAutopilot): string {
  switch (autopilot) {
    case MavAutopilot.ARDUPILOTMEGA: return 'ArduPilot'
    case MavAutopilot.PX4: return 'PX4'
    case MavAutopilot.INVALID: return 'Companion / GCS'
    case MavAutopilot.GENERIC: return 'Generic autopilot'
    default: return 'Unknown autopilot'
  }
}

// Operator-friendly system status, mostly used to flag boot vs ready.
export function systemStatusLabel(status: MavState): string {
  switch (status) {
    case MavState.UNINIT: return 'Booting'
    case MavState.BOOT: return 'Booting'
    case MavState.CALIBRATING: return 'Calibrating'
    case MavState.STANDBY: return 'Standby'
    case MavState.ACTIVE: return 'Flying'
    case MavState.CRITICAL: return 'Critical'
    case MavState.EMERGENCY: return 'Emergency'
    case MavState.POWEROFF: return 'Powering off'
    case MavState.FLIGHT_TERMINATION: return 'Flight terminated'
    default: return 'Unknown state'
  }
}
