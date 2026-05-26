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

// DFU client — runs the recovery / fresh-chip flash sequence over a
// `USBControl` (production: WebUSB; tests: MockUSBControl). Stateless
// beyond what DfuSe demands; the orchestrator (`workflow/firmware.ts`)
// composes it.
//
// Flow per write region:
//   1. SET_ADDRESS  (DfuSe DNLOAD wBlockNum=0, payload=[0x21,addr…])
//   2. GETSTATUS    (poll once, honour the device's bwPollTimeout)
//   3. for each chunk of <= transferSize bytes:
//        DNLOAD wBlockNum=2,3,4,…   (device auto-increments by
//                                     transferSize from the SET_ADDRESS)
//        GETSTATUS (poll until back to dfuDNLOAD_IDLE)
//
// Erase per region:
//   1. ERASE_PAGE   (DNLOAD wBlockNum=0, payload=[0x41,addr…])
//   2. GETSTATUS    (poll until back to dfuDNLOAD_IDLE)
//
// Manifest (commit to flash) at the very end:
//   1. DNLOAD wBlockNum=0, empty payload  (the "exit download" signal)
//   2. GETSTATUS until state leaves dfuMANIFEST_SYNC / dfuMANIFEST.
//      Some devices reset themselves at this point; we treat a
//      disconnect during manifest as success.

import type { ControlSetup, USBControl } from '../transport/usb-control'
import {
  buildErasePagePayload,
  buildSetAddressPayload,
  DFU_REQ,
  DFU_STATE,
  DFU_STATUS,
  parseStatus,
  stateLabel,
  statusLabel,
} from './dfu'

// Conservative default. The STM32 DFU descriptor reports the real
// wTransferSize (commonly 2048); we honour that when present and fall
// back here otherwise.
export const DEFAULT_TRANSFER_SIZE = 2048

// Cap on the number of poll attempts between operations — at the
// device's reported pollTimeout each, this gives us minutes of headroom
// for the slowest erase. The pollTimeout itself is what governs the
// actual wait.
const MAX_STATUS_POLLS = 600

// DFU control transfer setup boilerplate — bmRequestType is always
// class | interface, the request varies. Index is the bInterface (0
// for the boards we target).
function dfuSetup(request: number, direction: 'in' | 'out', value: number, iface: number): ControlSetup {
  return {
    direction,
    requestType: 'class',
    recipient: 'interface',
    request,
    value,
    index: iface,
  }
}

// A single contiguous region of flash to write at a known address.
// HexSegment-shaped (the .hex path) and also what we synthesise for
// the .apj path (one segment at the board's app address).
export interface DfuWriteRegion {
  address: number
  data: Uint8Array
}

// Operator-facing phase the workflow surfaces. Same set as the
// bootloader client uses, minus "verifying-board" (DFU doesn't know
// board ids).
export type DfuPhase = 'connecting' | 'erasing' | 'programming' | 'manifesting' | 'done'

export interface DfuFlashOptions {
  // The bytes-to-program-per-DNLOAD. STM32 boards advertise 2048 via
  // the DFU functional descriptor; the caller passes whatever it read.
  transferSize?: number
  // bInterface to address. 0 for every board we target.
  interfaceNumber?: number
  // Per-block progress (0..1, monotonically non-decreasing). Called
  // after each successful DNLOAD ack.
  onProgress?: (fraction: number) => void
  // Coarse phase callback. Drives the UI's status line.
  onPhase?: (phase: DfuPhase) => void
}

export class DfuClient {
  private readonly iface: number

  constructor(private readonly ctrl: USBControl, options: { interfaceNumber?: number } = {}) {
    this.iface = options.interfaceNumber ?? 0
  }

  // GETSTATUS — single request, parsed into a DfuStatus.
  async getStatus(): Promise<ReturnType<typeof parseStatus>> {
    const bytes = await this.ctrl.controlIn(dfuSetup(DFU_REQ.GETSTATUS, 'in', 0, this.iface), 6)
    return parseStatus(bytes)
  }

  // CLRSTATUS — clears dfuERROR back to dfuIDLE. Idempotent.
  async clearStatus(): Promise<void> {
    await this.ctrl.controlOut(dfuSetup(DFU_REQ.CLRSTATUS, 'out', 0, this.iface), new Uint8Array(0))
  }

  // ABORT — cancel whatever's in flight, return to dfuIDLE.
  async abort(): Promise<void> {
    await this.ctrl.controlOut(dfuSetup(DFU_REQ.ABORT, 'out', 0, this.iface), new Uint8Array(0))
  }

  // Bring the device to dfuIDLE, no matter what state it's in. Called
  // before any write/erase sequence so we don't fight a leftover state
  // from a previous attempt.
  async ensureIdle(): Promise<void> {
    const status = await this.getStatus()
    if (status.state === DFU_STATE.dfuIDLE)
      return
    if (status.state === DFU_STATE.dfuERROR) {
      await this.clearStatus()
      return
    }
    // dfuDNLOAD_IDLE etc. — abort gets us back to dfuIDLE.
    await this.abort()
  }

  // Issue a DfuSe SET_ADDRESS for subsequent DNLOAD writes/erases.
  // STM32 documents this as a 2-poll sequence (busy → idle).
  async setAddress(address: number): Promise<void> {
    await this.dnloadCommand(buildSetAddressPayload(address))
    await this.pollUntilIdle('set-address')
  }

  // Erase a single page at the given address. Block size = sector size
  // for that region; the caller (workflow) walks segments + sector list.
  async erasePage(address: number): Promise<void> {
    await this.dnloadCommand(buildErasePagePayload(address))
    await this.pollUntilIdle('erase')
  }

  // Push one chunk of data at the address sequence implied by the last
  // SET_ADDRESS + (block - 2) * transferSize. The caller manages the
  // running block counter.
  private async dnloadData(blockNum: number, chunk: Uint8Array): Promise<void> {
    await this.ctrl.controlOut(dfuSetup(DFU_REQ.DNLOAD, 'out', blockNum, this.iface), chunk)
    await this.pollUntilIdle('program')
  }

  // Push a DfuSe command (wBlockNum = 0). Distinguishing wrapper so the
  // call sites read like the spec.
  private async dnloadCommand(payload: Uint8Array): Promise<void> {
    await this.ctrl.controlOut(dfuSetup(DFU_REQ.DNLOAD, 'out', 0, this.iface), payload)
  }

  // Poll GETSTATUS, honouring bwPollTimeout, until the device leaves
  // any DNBUSY-ish state and lands in dfuDNLOAD_IDLE (or another
  // we-can-proceed state). Throws on any non-OK status or unexpected
  // state, naming the operation in the error.
  private async pollUntilIdle(op: string): Promise<void> {
    for (let i = 0; i < MAX_STATUS_POLLS; i++) {
      const s = await this.getStatus()
      if (s.status !== DFU_STATUS.OK) {
        throw new Error(
          `DFU ${op} failed: device reported ${statusLabel(s.status)} (state ${stateLabel(s.state)}).`,
        )
      }
      if (s.state === DFU_STATE.dfuDNLOAD_IDLE || s.state === DFU_STATE.dfuIDLE)
        return
      if (s.state !== DFU_STATE.dfuDNBUSY && s.state !== DFU_STATE.dfuDNLOAD_SYNC) {
        throw new Error(
          `DFU ${op} ended in unexpected state ${stateLabel(s.state)}.`,
        )
      }
      if (s.pollTimeoutMs > 0)
        await sleep(s.pollTimeoutMs)
    }
    throw new Error(`DFU ${op} didn't finish after ${MAX_STATUS_POLLS} status polls.`)
  }

  // Manifestation — commit the downloaded data to flash. Issued as
  // an empty DNLOAD at the end of a write sequence. Some devices
  // reset themselves once manifest completes; the controlOut may
  // throw in that case, which we treat as success.
  async manifest(): Promise<void> {
    try {
      await this.ctrl.controlOut(dfuSetup(DFU_REQ.DNLOAD, 'out', 0, this.iface), new Uint8Array(0))
    }
    catch {
      // Device may already be detaching — that's fine.
      return
    }
    // Poll once; honour the requested timeout; then either reach idle
    // or accept a transfer error (device reset).
    try {
      for (let i = 0; i < MAX_STATUS_POLLS; i++) {
        const s = await this.getStatus()
        if (s.status !== DFU_STATUS.OK) {
          throw new Error(
            `DFU manifest failed: device reported ${statusLabel(s.status)} (state ${stateLabel(s.state)}).`,
          )
        }
        if (
          s.state === DFU_STATE.dfuIDLE
          || s.state === DFU_STATE.dfuDNLOAD_IDLE
          || s.state === DFU_STATE.dfuMANIFEST_WAIT_RESET
        ) {
          return
        }
        if (s.pollTimeoutMs > 0)
          await sleep(s.pollTimeoutMs)
      }
    }
    catch {
      // The device dropping the bus mid-manifest is a normal exit on
      // boards that aren't manifestation-tolerant.
    }
  }

  // The whole sequence for one or more flash regions:
  //   ensureIdle → for each region: erase its sector list → write its
  //   bytes in transferSize chunks → manifest at the end.
  //
  // The caller (workflow) computes the *sector* erase list from the
  // device's DfuSe memory layout intersected with the regions; this
  // method just receives a list of pages to erase (so the protocol
  // stays sector-agnostic).
  async flash(
    regions: DfuWriteRegion[],
    sectorsToErase: number[],
    options: DfuFlashOptions = {},
  ): Promise<void> {
    const transferSize = options.transferSize ?? DEFAULT_TRANSFER_SIZE
    const onProgress = options.onProgress
    const onPhase = options.onPhase

    if (regions.length === 0)
      throw new Error('DfuClient.flash: no regions to write.')

    onPhase?.('connecting')
    await this.ensureIdle()

    onPhase?.('erasing')
    for (const sectorAddr of sectorsToErase)
      await this.erasePage(sectorAddr)

    onPhase?.('programming')
    const totalBytes = regions.reduce((a, r) => a + r.data.length, 0)
    let writtenBytes = 0

    for (const region of regions) {
      await this.setAddress(region.address)
      // wBlockNum starts at 2 after each SET_ADDRESS.
      let blockNum = 2
      let offset = 0
      while (offset < region.data.length) {
        const remaining = region.data.length - offset
        const len = Math.min(transferSize, remaining)
        // No padding — the device pads with 0xFF inside the page if
        // the final write is < transferSize. (STM32 DFU spec.)
        const chunk = region.data.subarray(offset, offset + len)
        await this.dnloadData(blockNum, chunk)
        offset += len
        writtenBytes += len
        blockNum++
        onProgress?.(writtenBytes / totalBytes)
      }
    }

    onPhase?.('manifesting')
    await this.manifest()
    onPhase?.('done')
  }
}

// --- helpers --------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
