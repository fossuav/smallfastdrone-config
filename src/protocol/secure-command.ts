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

// SECURE_COMMAND client for the SFD identity operations. ArduPilot's
// SECURE_COMMAND (msgid 11004) normally carries a signature checked
// against the bootloader's public keys; the two SFD identity operations
// are the deliberate exception (docs/SECURITY.md, "Why the identity
// commands are unsigned"), so this client sends with an empty signature
// and holds no key material of any kind. It is the tool half of the
// firmware's F4: GENERATE_IDENTITY asks the drone to make its X25519
// identity from its hardware RNG, GET_IDENTITY reads the public half
// back. Both reply with the 12-byte STM32 UID followed by the 32-byte
// public key.
//
// Replies are matched on sequence + operation — the firmware echoes
// both — and the sequence starts at a random value so a reply left
// over from an earlier session on the same link can never satisfy a
// new request. Exporting the identity file the operator keeps is a
// workflow concern; this module stops at the decoded bytes.

import type { MavLinkData } from 'mavlink-mappings'
import type { SecureCommandOp } from 'mavlink-mappings/dist/lib/ardupilotmega'
import type { MessageHandler } from './mavlink'
import { SecureCommand, SecureCommandReply } from 'mavlink-mappings/dist/lib/ardupilotmega'
import { MavResult } from 'mavlink-mappings/dist/lib/common'

// Vendor-private operation numbers ("SFD" + n), matching
// SECURE_COMMAND_GENERATE_IDENTITY / SECURE_COMMAND_GET_IDENTITY in the
// firmware's AP_CheckFirmware.h. They sit outside the SECURE_COMMAND_OP
// enum on purpose, so neither the MAVLink dialect nor mavlink-mappings
// needs changing.
export const SECURE_OP = {
  GENERATE_IDENTITY: 0x53464401,
  GET_IDENTITY: 0x53464402,
  SET_OWNER_KEY: 0x53464403,
  GET_OWNER_KEY: 0x53464404,
  SET_OWNER_GRANT: 0x53464405,
} as const

export const IDENTITY_UID_LEN = 12
export const IDENTITY_KEY_LEN = 32

// Why a GET_IDENTITY failed, as the firmware reports it in a single byte
// of reply data. Both cases used to be a bare FAILED, which conflated two
// different remedies: a drone whose bootloader predates the identity
// region needs its bootloader updated, while one whose region is merely
// empty needs an identity generated. Getting that wrong means offering to
// key a drone that cannot hold a key. Firmware older than the change
// sends no data at all, which we read as "empty" — the same assumption
// the tool made before, so nothing regresses.
export const IDENTITY_STATUS = {
  NOT_SET: 1,
  NO_REGION: 2,
} as const

// Why an owner key operation failed. Values 1 and 2 line up with the
// identity statuses but mean their own thing, so they are named
// separately rather than shared. ALREADY_SET is no longer sent — an
// unsealed drone accepts a re-claim (PLAN.md decision 39) — and is kept
// because an older firmware still sends it.
export const OWNER_STATUS = {
  NOT_SET: 1,
  NO_REGION: 2,
  ARMED: 3,
  ALREADY_SET: 4,
  NO_IDENTITY: 5,
  SEALED: 6,
  BAD_GRANT: 7,
  OTHER_DRONE: 8,
  UNSIGNED: 9,
  STALE: 10,
} as const
const IDENTITY_REPLY_LEN = IDENTITY_UID_LEN + IDENTITY_KEY_LEN

// SECURE_COMMAND's data field: 220 bytes shared between payload and
// signature. With no signature the whole of it is payload.
const DATA_CAPACITY = 220

// A GET is answered from flash immediately. GENERATE erases and rewrites
// the bootloader sector, during which the FC stalls, so it gets a much
// longer allowance.
const GET_TIMEOUT_MS = 3000
const GENERATE_TIMEOUT_MS = 15000

const EMPTY = new Uint8Array(0)

export interface DroneIdentity {
  // STM32 96-bit unique id — the nonce prefix SFD encrypts applets to.
  uid: Uint8Array
  // X25519 public key. The private half never leaves the drone.
  publicKey: Uint8Array
}

export interface SecureCommandResponse {
  result: MavResult
  data: Uint8Array
}

// Thrown when the drone answers with anything other than ACCEPTED, when
// nothing answers, or when a reply doesn't decode. `result` is the
// drone's verdict (DENIED = armed or identity already exists,
// UNSUPPORTED = firmware without the identity commands) so a workflow
// can branch on it; null means there was no verdict — a timeout
// (`timedOut`) or a malformed reply.
export class SecureCommandError extends Error {
  constructor(
    public readonly operation: number,
    public readonly result: MavResult | null,
    message: string,
    public readonly timedOut = false,
    // The drone has no identity region at all — its bootloader predates
    // one. Distinct from "no identity yet" because the operator's next
    // step is different: update the bootloader, not generate a key.
    public readonly noIdentityRegion = false,
  ) {
    super(message)
    this.name = 'SecureCommandError'
  }
}

export class SecureCommandClient {
  private seq: number

  constructor(
    private readonly send: (msg: MavLinkData) => Promise<void>,
    private readonly subscribe: (cb: MessageHandler) => () => void,
    private readonly targetSystem: number,
    private readonly targetComponent: number,
  ) {
    this.seq = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  }

  // Read the drone's identity. Resolves null when it has none yet — the
  // firmware answers FAILED to a read of a blank region — so the caller
  // can decide whether to generate. Throws SecureCommandError for any
  // other non-ACCEPTED result, a timeout, or a malformed reply.
  async getIdentity(): Promise<DroneIdentity | null> {
    const resp = await this.request(SECURE_OP.GET_IDENTITY, EMPTY, GET_TIMEOUT_MS)
    if (resp.result === MavResult.FAILED) {
      if (resp.data.byteLength === 1 && resp.data[0] === IDENTITY_STATUS.NO_REGION) {
        throw new SecureCommandError(
          SECURE_OP.GET_IDENTITY,
          resp.result,
          'This drone can\'t store an identity yet — its startup software is older than the drone\'s firmware. Update it from the Firmware page, then try again.',
          false,
          true,
        )
      }
      return null
    }
    if (resp.result !== MavResult.ACCEPTED)
      throw resultError(SECURE_OP.GET_IDENTITY, resp.result)
    return decodeIdentity(SECURE_OP.GET_IDENTITY, resp.data)
  }

  // Ask the drone to generate its identity. The firmware builds the
  // reply from the key it just wrote to flash, so what resolves here is
  // already a read-back. Throws SecureCommandError with result DENIED
  // when the drone is armed or already holds an identity — a workflow
  // treats the latter as "read it instead", not as a failure.
  async generateIdentity(): Promise<DroneIdentity> {
    const resp = await this.request(SECURE_OP.GENERATE_IDENTITY, EMPTY, GENERATE_TIMEOUT_MS)
    if (resp.result !== MavResult.ACCEPTED)
      throw resultError(SECURE_OP.GENERATE_IDENTITY, resp.result)
    return decodeIdentity(SECURE_OP.GENERATE_IDENTITY, resp.data)
  }

  // Read the owner key a drone encrypts its outbound artefacts to.
  // Resolves null when the drone has none — an unclaimed drone, which is
  // the ordinary state of one nobody has enabled — so the caller decides
  // whether to claim it.
  async getOwnerKey(): Promise<Uint8Array | null> {
    const resp = await this.request(SECURE_OP.GET_OWNER_KEY, EMPTY, GET_TIMEOUT_MS)
    if (resp.result === MavResult.FAILED) {
      if (resp.data.byteLength === 1 && resp.data[0] === OWNER_STATUS.NO_REGION) {
        throw new SecureCommandError(
          SECURE_OP.GET_OWNER_KEY,
          resp.result,
          'This drone can\'t be given an owner yet — its startup software is older than the drone\'s firmware. Update it from the Firmware page, then try again.',
          false,
          true,
        )
      }
      return null
    }
    if (resp.result !== MavResult.ACCEPTED)
      throw resultError(SECURE_OP.GET_OWNER_KEY, resp.result)
    return decodeIdentity(SECURE_OP.GET_OWNER_KEY, resp.data).publicKey
  }

  // Claim the drone for an owner. The firmware builds the reply from the
  // key it just wrote to flash, so this resolves a read-back rather than
  // an echo. Gets the long allowance: it rewrites the bootloader sector.
  //
  // A refusal carries a status byte saying which refusal it is, and the
  // messages differ because the remedies do — disarm, generate an
  // identity, update the startup software, or accept that a sealed drone
  // is claimed for good.
  async setOwnerKey(publicKey: Uint8Array): Promise<Uint8Array> {
    if (publicKey.byteLength !== IDENTITY_KEY_LEN)
      throw new SecureCommandError(SECURE_OP.SET_OWNER_KEY, null, `An owner key must be ${IDENTITY_KEY_LEN} bytes; this one is ${publicKey.byteLength}.`)
    const resp = await this.request(SECURE_OP.SET_OWNER_KEY, publicKey, GENERATE_TIMEOUT_MS)
    if (resp.result !== MavResult.ACCEPTED)
      throw ownerRefusal(resp.result, resp.data)
    return decodeIdentity(SECURE_OP.SET_OWNER_KEY, resp.data).publicKey
  }

  // Hand the drone an ownership grant SFD signed. The drone verifies it
  // against the key in its own bootloader — this tool holds nothing that
  // could — and answers with the owner key it now holds, read back from
  // flash. Gets the long allowance: it rewrites the bootloader sector.
  async setOwnerGrant(grant: Uint8Array): Promise<Uint8Array> {
    const resp = await this.request(SECURE_OP.SET_OWNER_GRANT, grant, GENERATE_TIMEOUT_MS)
    if (resp.result !== MavResult.ACCEPTED)
      throw ownerRefusal(resp.result, resp.data)
    return decodeIdentity(SECURE_OP.SET_OWNER_GRANT, resp.data).publicKey
  }

  // Send one unsigned SECURE_COMMAND and await the reply that echoes its
  // sequence and operation. Resolves with whatever verdict the drone
  // gave — interpreting it is the caller's job — and rejects on timeout
  // or a send failure. A timeout is also what a firmware without secure
  // command support looks like: it never answers.
  async request(operation: number, data: Uint8Array = EMPTY, timeoutMs = GET_TIMEOUT_MS): Promise<SecureCommandResponse> {
    if (data.byteLength > DATA_CAPACITY)
      throw new Error(`Secure command payload is ${data.byteLength} bytes, max ${DATA_CAPACITY}`)
    const sequence = this.seq
    this.seq = (this.seq + 1) >>> 0

    const msg = new SecureCommand()
    msg.targetSystem = this.targetSystem
    msg.targetComponent = this.targetComponent
    msg.sequence = sequence
    msg.operation = operation as SecureCommandOp
    msg.dataLength = data.byteLength
    msg.sigLength = 0
    // mavlink-mappings types the field as uint8_t[]; a Uint8Array
    // serialises identically. Pad to the full field so the encoder never
    // sees a short array.
    const payload = new Uint8Array(DATA_CAPACITY)
    payload.set(data)
    msg.data = payload as unknown as number[]

    return new Promise<SecureCommandResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      const cleanup = () => {
        if (timer)
          clearTimeout(timer)
        unsubscribe?.()
      }

      unsubscribe = this.subscribe((message) => {
        if (message.msgid !== SecureCommandReply.MSG_ID)
          return
        const reply = message.data as SecureCommandReply
        if (reply.sequence !== sequence || reply.operation !== operation)
          return
        cleanup()
        const bytes = Uint8Array.from(reply.data as unknown as ArrayLike<number>)
        resolve({
          result: reply.result,
          data: bytes.subarray(0, Math.min(reply.dataLength, bytes.byteLength)),
        })
      })

      timer = setTimeout(() => {
        cleanup()
        reject(new SecureCommandError(operation, null, 'The drone didn\'t answer. Its firmware may not support SFD enablement.', true))
      }, timeoutMs)

      this.send(msg).catch((e) => {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }
}

// Split an identity reply into its UID and public key. Copies, so the
// result outlives the message buffer it came from.
export function decodeIdentity(operation: number, data: Uint8Array): DroneIdentity {
  if (data.byteLength !== IDENTITY_REPLY_LEN)
    throw new SecureCommandError(operation, null, `The drone sent an identity of ${data.byteLength} bytes, expected ${IDENTITY_REPLY_LEN}.`)
  return {
    uid: data.slice(0, IDENTITY_UID_LEN),
    publicKey: data.slice(IDENTITY_UID_LEN, IDENTITY_REPLY_LEN),
  }
}

// Turn a refused claim into an error an operator can act on. Each status
// has its own remedy, and a caller given a bare DENIED has to guess
// between four quite different situations.
function ownerRefusal(result: MavResult, data: Uint8Array): SecureCommandError {
  const status = data.byteLength === 1 ? (data[0] ?? 0) : 0
  const message = {
    [OWNER_STATUS.ARMED]: 'The drone is armed. Disarm it, then try again.',
    [OWNER_STATUS.NO_IDENTITY]: 'This drone needs its own identity first. Run the enable step, then try again.',
    [OWNER_STATUS.NO_REGION]: 'This drone can\'t be given an owner yet — its startup software is older than the drone\'s firmware. Update it from the Firmware page, then try again.',
    [OWNER_STATUS.SEALED]: 'This drone is already secured for another owner, and a secured drone can\'t be given a new one.',
    [OWNER_STATUS.ALREADY_SET]: 'This drone already has an owner.',
    [OWNER_STATUS.BAD_GRANT]: 'That permission file isn\'t one this drone understands.',
    [OWNER_STATUS.OTHER_DRONE]: 'That permission was issued for a different drone.',
    [OWNER_STATUS.UNSIGNED]: 'This drone doesn\'t recognise who issued that permission. It has to come from SmallFastDrone.',
    [OWNER_STATUS.STALE]: 'That permission has been superseded — a newer one was already used on this drone. Ask for a fresh one.',
  }[status]
  if (message !== undefined)
    return new SecureCommandError(SECURE_OP.SET_OWNER_KEY, result, message)
  return resultError(SECURE_OP.SET_OWNER_KEY, result)
}

// Turn a non-ACCEPTED verdict into an error whose message an operator
// could read. The verdicts the firmware actually produces are DENIED,
// UNSUPPORTED and FAILED; the rest are covered for completeness.
function resultError(operation: number, result: MavResult): SecureCommandError {
  switch (result) {
    case MavResult.DENIED:
      return new SecureCommandError(operation, result, 'The drone refused: it is armed, or it already has an identity.')
    case MavResult.UNSUPPORTED:
      return new SecureCommandError(operation, result, 'This drone\'s firmware doesn\'t support SFD identity.')
    case MavResult.FAILED:
      return new SecureCommandError(operation, result, 'The drone couldn\'t complete the identity operation.')
    default:
      return new SecureCommandError(operation, result, `The drone answered with result ${result}.`)
  }
}
