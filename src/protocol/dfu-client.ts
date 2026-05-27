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
  buildMassErasePayload,
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

// Ceiling on how long we sleep between GETSTATUS polls. Mostly a guard
// against a 24-bit `bwPollTimeout` of hours that some buggy devices
// might return. Otherwise we honour the device's request — polling
// more aggressively than `bwPollTimeout` is a spec violation and has
// been observed to wedge ST H7 ROM DFU bootloaders (the device asks
// us to wait ~4-5 s during sector erase; capping at 500 ms made us
// poll 10× too fast, which the bootloader treats as a state-machine
// error). The smooth in-sector animation in `flash()` keeps the bar
// moving independently, so a longer real-poll interval doesn't hurt
// UX.
const MAX_POLL_INTERVAL_MS = 10_000

// Per-sector erase estimate for the progress-bar animation while we're
// waiting on the device. H7 typical is ~1.3 s, max ~4 s. The bar
// interpolates from sectorStart/N to (sectorStart+1)/N over this
// window (capped at 95 % until the actual ack lands), so even a long
// erase keeps the bar moving and the operator knows the flow isn't
// frozen.
const SECTOR_ERASE_ESTIMATE_MS = 2_000

// Time-based estimate for mass-erase animation. H7 mass erase is
// ~30-40 s; the actual ack might arrive earlier or later. Same shape
// as the bootloader CHIP_ERASE animation (capped at 95 % until ack).
const MASS_ERASE_ESTIMATE_MS = 35_000

// Mass erase needs its own operation budget — it's one command that
// covers the whole chip and is genuinely allowed to take 30-60 s on
// H7. The per-op timeout is for individual sector operations.
const MASS_ERASE_TIMEOUT_MS = 120_000

// Ceilings to keep a stuck device from hanging the flow forever.
// WebUSB on Windows has been observed to never resolve a
// `controlTransferIn` if the device drops a response — without these
// the UI sits frozen indefinitely with no surfaced error.
//   - GETSTATUS_TIMEOUT_MS: cap on a *single* GETSTATUS round trip.
//     On a healthy bus this lands in milliseconds, but during mass
//     erase the STM32 H7 ROM DFU bootloader has been observed to
//     stop servicing USB ISRs while it polls the flash BSY bit —
//     so a single GETSTATUS can genuinely take 20-30 s. 45 s gives
//     mass-erase headroom while still catching a really-gone device.
//   - OPERATION_TIMEOUT_MS: total budget for one set-address / erase /
//     program — H7 sector erase max is ~4 s, so 60 s is a 15× cushion.
const GETSTATUS_TIMEOUT_MS = 45_000
const OPERATION_TIMEOUT_MS = 60_000

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
  // When true, use DfuSe MASS_ERASE instead of walking per-sector
  // ERASE_PAGE commands. Sidesteps STM32 ROM-DFU quirks at flash-bank
  // boundaries (H743 dual-bank in particular). Caller must only set
  // this for full-chip flashes (e.g. `_with_bl.hex`) — mass erase wipes
  // the bootloader region too, which is fine when you're replacing it
  // and catastrophic when you're not (.apj recovery must preserve it).
  useMassErase?: boolean
}

export class DfuClient {
  private readonly iface: number

  constructor(private readonly ctrl: USBControl, options: { interfaceNumber?: number } = {}) {
    this.iface = options.interfaceNumber ?? 0
  }

  // GETSTATUS — single request, parsed into a DfuStatus. Timed out
  // because WebUSB's controlTransferIn doesn't itself: if the device
  // drops a response (rare but observed on Windows after a long
  // session) we throw a useful error instead of hanging forever.
  async getStatus(): Promise<ReturnType<typeof parseStatus>> {
    const bytes = await raceWithTimeout(
      this.ctrl.controlIn(dfuSetup(DFU_REQ.GETSTATUS, 'in', 0, this.iface), 6),
      GETSTATUS_TIMEOUT_MS,
      'DFU GETSTATUS',
    )
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
    await this.pollUntilIdle('set-address', OPERATION_TIMEOUT_MS)
  }

  // Erase a single page at the given address. Block size = sector size
  // for that region; the caller (workflow) walks segments + sector list.
  //
  // Returns to `dfuIDLE` after each erase via ABORT. Some STM32 ROM DFU
  // bootloaders — particularly on dual-bank H7 across the bank boundary
  // at 0x08100000 — wedge if the host issues a second DfuSe command
  // (ERASE_PAGE / SET_ADDRESS) directly from `dfuDNLOAD_IDLE` (where
  // we land after the previous erase) instead of `dfuIDLE`. The ABORT
  // is a cheap round trip that ensures every erase starts from a known
  // state, and is what dfu-util does between regions for the same
  // reason.
  async erasePage(address: number): Promise<void> {
    await this.dnloadCommand(buildErasePagePayload(address))
    await this.pollUntilIdle('erase', OPERATION_TIMEOUT_MS)
    try {
      await this.abort()
    }
    catch {
      // Abort failure is non-fatal — the next op will surface any
      // genuine state issue. Swallow so a flaky bus during the abort
      // doesn't tank an otherwise-successful erase.
    }
  }

  // Mass erase — wipes the entire user flash region in one command.
  // Used by the `_with_bl.hex` (full reflash including bootloader) path
  // because it's faster than walking 14+ sector erases and sidesteps
  // ROM-DFU state-machine quirks at flash-bank boundaries (the H743's
  // 0x08100000 dual-bank seam in particular has been observed to wedge
  // per-sector erase). Don't use this for `.apj` recovery — that has
  // to preserve the bootloader at the low sectors.
  async massErase(onProgress?: (fraction: number) => void): Promise<void> {
    await this.dnloadCommand(buildMassErasePayload())
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null
    if (onProgress) {
      const startedAt = Date.now()
      onProgress(0)
      interval = setInterval(() => {
        if (cancelled)
          return
        const elapsed = Date.now() - startedAt
        onProgress(Math.min(0.95, elapsed / MASS_ERASE_ESTIMATE_MS))
      }, 250)
    }
    try {
      await this.pollUntilIdle('mass erase', MASS_ERASE_TIMEOUT_MS)
      onProgress?.(1)
    }
    finally {
      cancelled = true
      if (interval)
        clearInterval(interval)
    }
    try {
      await this.abort()
    }
    catch {
      // see erasePage comment.
    }
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
  private async pollUntilIdle(op: string, timeoutMs: number = OPERATION_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (let i = 0; i < MAX_STATUS_POLLS; i++) {
      if (Date.now() > deadline)
        throw new Error(`DFU ${op} timed out after ${timeoutMs / 1000}s without completing.`)
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
        await sleep(Math.min(s.pollTimeoutMs, MAX_POLL_INTERVAL_MS))
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
    onProgress?.(0)
    if (options.useMassErase) {
      // Single DfuSe MASS_ERASE — wipes the whole chip in one go. Used
      // by the `_with_bl.hex` path; the per-sector loop below is for
      // `.apj` recovery where the bootloader has to survive.
      await this.massErase(onProgress)
    }
    else {
      const totalSectors = sectorsToErase.length
      for (let i = 0; i < totalSectors; i++) {
        const sectorStart = i / totalSectors
        const sectorEnd = (i + 1) / totalSectors
        // Tick an estimate-based animation while we wait on the device.
        // Without this the bar is frozen at sectorStart through the
        // whole 1-2 s sector erase, which reads as "stalled".
        let cancelled = false
        let interval: ReturnType<typeof setInterval> | null = null
        if (onProgress) {
          const startedAt = Date.now()
          interval = setInterval(() => {
            if (cancelled)
              return
            const elapsed = Date.now() - startedAt
            const t = Math.min(elapsed / SECTOR_ERASE_ESTIMATE_MS, 0.95)
            onProgress(sectorStart + (sectorEnd - sectorStart) * t)
          }, 100)
        }
        try {
          await this.erasePage(sectorsToErase[i]!)
        }
        catch (e) {
          const addr = sectorsToErase[i]!.toString(16).padStart(8, '0')
          const detail = e instanceof Error ? e.message : String(e)
          throw new Error(
            `Erase failed at sector 0x${addr} (${i + 1}/${totalSectors}): ${detail}`,
          )
        }
        finally {
          cancelled = true
          if (interval)
            clearInterval(interval)
        }
        onProgress?.(sectorEnd)
      }
    }

    onPhase?.('programming')
    onProgress?.(0)
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

// Race a promise against a timeout. Used to bound the WebUSB control
// transfers — those have no built-in timeout and `controlTransferIn`
// has been observed to never resolve when a Windows DFU device drops
// a response.
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])
}
