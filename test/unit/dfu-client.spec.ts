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

// DfuClient against MockUSBControl. Together with `dfu.spec.ts` (pure
// framing) this covers the request/response logic the bench-hardware
// path will exercise, minus the actual WebUSB transport.
//
// Each test pre-seeds the mock with the GETSTATUS replies the device
// would send for the sequence under test, then asserts the bytes the
// client wrote out.

import { describe, expect, it, vi } from 'vitest'
import {
  DFU_REQ,
  DFU_STATE,
  DFU_STATUS,
  DFUSE_CMD,
} from '../../src/protocol/dfu'
import { DfuClient } from '../../src/protocol/dfu-client'
import { MockUSBControl } from '../../src/transport/usb-control'

// Build a 6-byte GETSTATUS reply for the mock to hand back.
function status(state: number, statusByte: number = DFU_STATUS.OK, pollMs: number = 0): number[] {
  return [statusByte, pollMs & 0xFF, (pollMs >>> 8) & 0xFF, (pollMs >>> 16) & 0xFF, state, 0]
}

// Convenience: queue N successive identical GETSTATUS replies.
function queueStatuses(mock: MockUSBControl, replies: number[][]): void {
  for (const r of replies)
    mock.queueIn(DFU_REQ.GETSTATUS, 0, r)
}

describe('dfuClient.ensureIdle', () => {
  it('no-ops when device is already at dfuIDLE', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuIDLE)])
    const client = new DfuClient(mock)
    await client.ensureIdle()
    // Only the one GETSTATUS — no abort, no clrstatus.
    expect(mock.log).toHaveLength(1)
    expect(mock.log[0]!.kind).toBe('in')
  })

  it('clears dfuERROR via CLRSTATUS', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuERROR, DFU_STATUS.errUNKNOWN)])
    const client = new DfuClient(mock)
    await client.ensureIdle()
    const outs = mock.log.filter(e => e.kind === 'out')
    expect(outs).toHaveLength(1)
    expect(outs[0]!.setup.request).toBe(DFU_REQ.CLRSTATUS)
  })

  it('aborts dfuDNLOAD_IDLE', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuDNLOAD_IDLE)])
    const client = new DfuClient(mock)
    await client.ensureIdle()
    const outs = mock.log.filter(e => e.kind === 'out')
    expect(outs[0]!.setup.request).toBe(DFU_REQ.ABORT)
  })
})

describe('dfuClient.setAddress', () => {
  it('issues a DfuSe SET_ADDRESS + polls until idle', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuDNBUSY, DFU_STATUS.OK, 0),
      status(DFU_STATE.dfuDNLOAD_IDLE),
    ])
    const client = new DfuClient(mock)
    await client.setAddress(0x08020000)
    // First entry is the DNLOAD payload [0x21, addr LE].
    const out = mock.log.find(e => e.kind === 'out')!
    expect(out.setup.request).toBe(DFU_REQ.DNLOAD)
    expect(out.setup.value).toBe(0) // wBlockNum=0 (command channel)
    expect(Array.from(out.data!)).toEqual([DFUSE_CMD.SET_ADDRESS, 0x00, 0x00, 0x02, 0x08])
  })

  it('surfaces an error status', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuERROR, DFU_STATUS.errADDRESS)])
    const client = new DfuClient(mock)
    await expect(client.setAddress(0x08020000)).rejects.toThrow(/errADDRESS/)
  })
})

describe('dfuClient.erasePage', () => {
  it('issues DfuSe ERASE_PAGE + waits through dfuDNBUSY → dfuDNLOAD_IDLE', async () => {
    const mock = new MockUSBControl()
    // Normal-chip path: first GETSTATUS = dfuDNBUSY, second = idle.
    queueStatuses(mock, [
      status(DFU_STATE.dfuDNBUSY),
      status(DFU_STATE.dfuDNLOAD_IDLE),
    ])
    const client = new DfuClient(mock)
    await client.erasePage(0x08020000)
    const out = mock.log.find(e => e.kind === 'out')!
    expect(Array.from(out.data!)).toEqual([DFUSE_CMD.ERASE_PAGE, 0x00, 0x00, 0x02, 0x08])
  })

  it('errors on errERASE', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuERROR, DFU_STATUS.errERASE)])
    const client = new DfuClient(mock)
    await expect(client.erasePage(0)).rejects.toThrow(/errERASE/)
  })

  it('applies the STM32H7 Rev.V workaround when the device stays in dfuDNBUSY', async () => {
    const mock = new MockUSBControl()
    // First GETSTATUS = dfuDNBUSY (normal).
    // Second GETSTATUS = STILL dfuDNBUSY (Rev.V errata).
    // drainToIdle then loops:
    //   - GETSTATUS = dfuDNBUSY (not idle)  → CLRSTATUS
    //   - GETSTATUS = dfuERROR (errUNKNOWN, not idle) → CLRSTATUS
    //   - GETSTATUS = dfuIDLE → return
    queueStatuses(mock, [
      status(DFU_STATE.dfuDNBUSY), //                    first poll
      status(DFU_STATE.dfuDNBUSY), //                    second poll — still busy
      status(DFU_STATE.dfuDNBUSY), //                    drain attempt 1: still busy
      status(DFU_STATE.dfuERROR, DFU_STATUS.errUNKNOWN), // drain attempt 2: now errored
      status(DFU_STATE.dfuIDLE), //                      drain attempt 3: idle
    ])
    const client = new DfuClient(mock)
    await client.erasePage(0x08020000)
    // Should have issued: ERASE_PAGE DNLOAD + 2 CLRSTATUS calls.
    const clearStatuses = mock.log.filter(e => e.kind === 'out' && e.setup.request === 0x04 /* CLRSTATUS */)
    expect(clearStatuses).toHaveLength(2)
  })
})

describe('dfuClient.flash — end-to-end', () => {
  it('does ensureIdle → erase each sector → set-address → DNLOAD chunks → manifest', async () => {
    const mock = new MockUSBControl()

    // Sequence of GETSTATUS replies, in the order the client polls.
    // Erase now does the dfuDNBUSY → dfuDNLOAD_IDLE two-poll dance
    // (with the H7-Rev.V workaround entry point on the second poll).
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNBUSY), //            erase sec 0, first poll
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 0, second poll
      status(DFU_STATE.dfuDNBUSY), //            erase sec 1, first poll
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 1, second poll
      status(DFU_STATE.dfuDNLOAD_IDLE), //       set-address
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk 0
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk 1
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk 2
      status(DFU_STATE.dfuMANIFEST_WAIT_RESET), // manifest
    ])

    // 5 KB image split into 2 KB + 2 KB + 1 KB chunks (transferSize=2048).
    const image = new Uint8Array(5 * 1024)
    for (let i = 0; i < image.length; i++) image[i] = i & 0xFF

    const client = new DfuClient(mock)
    const phases: string[] = []
    const progress: number[] = []
    await client.flash(
      [{ address: 0x08020000, data: image }],
      [0x08020000, 0x08040000],
      {
        transferSize: 2048,
        onPhase: p => phases.push(p),
        onProgress: p => progress.push(p),
      },
    )

    expect(phases).toEqual(['connecting', 'erasing', 'programming', 'manifesting', 'done'])

    // Progress fires:
    //   - reset to 0 at the start of the erase phase
    //   - 0.5, 1 as each of the 2 sectors finishes
    //   - reset to 0 at the start of the program phase
    //   - 0.4, 0.8, 1 as each of the 3 chunks finishes (5120 bytes total)
    expect(progress).toEqual([0, 0.5, 1, 0, 2048 / 5120, 4096 / 5120, 1])

    // Count of DNLOAD operations on the wire (commands + chunks):
    //   2 erase commands + 1 set-address + 3 data chunks + 1 manifest = 7.
    const dnloads = mock.log.filter(e => e.kind === 'out' && e.setup.request === DFU_REQ.DNLOAD)
    expect(dnloads).toHaveLength(7)

    // The data chunks should be wBlockNum 2, 3, 4 in order.
    const dataDnloads = dnloads.filter(d => d.setup.value >= 2)
    expect(dataDnloads.map(d => d.setup.value)).toEqual([2, 3, 4])

    // First and last chunk should not be padded by us — let the device
    // do that. Chunk 0 = 2048 bytes, chunk 2 = 1024 bytes.
    expect(dataDnloads[0]!.data!.length).toBe(2048)
    expect(dataDnloads[2]!.data!.length).toBe(1024)
  })

  it('writes multiple non-contiguous regions (the .hex case)', async () => {
    const mock = new MockUSBControl()
    // 2 regions × (set-address + 1 chunk poll), plus 1 erase, plus
    // ensureIdle + manifest. Erase does the dfuDNBUSY → dfuDNLOAD_IDLE
    // two-poll dance per sector.
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNBUSY), //            erase sec 0, first poll
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 0, second poll
      status(DFU_STATE.dfuDNLOAD_IDLE), //       set-address (region 0)
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk
      status(DFU_STATE.dfuDNLOAD_IDLE), //       set-address (region 1)
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk
      status(DFU_STATE.dfuIDLE), //              manifest
    ])
    const client = new DfuClient(mock)
    await client.flash(
      [
        { address: 0x08000000, data: new Uint8Array([1, 2, 3, 4]) },
        { address: 0x08020000, data: new Uint8Array([5, 6, 7, 8]) },
      ],
      [0x08000000],
      { transferSize: 2048 },
    )
    // Two SET_ADDRESS commands; data chunks restart at block 2 after
    // each — assert via the DNLOAD wBlockNums.
    const dnloads = mock.log.filter(e => e.kind === 'out' && e.setup.request === DFU_REQ.DNLOAD)
    // erase + set-addr + chunk + set-addr + chunk + manifest = 6 DNLOADs.
    expect(dnloads).toHaveLength(6)
    const dataChunks = dnloads.filter(d => d.setup.value === 2)
    expect(dataChunks).toHaveLength(2) // both regions started at block 2
  })

  it('uses MASS_ERASE instead of per-sector erase when useMassErase is set', async () => {
    const mock = new MockUSBControl()
    // ensureIdle + 1 mass-erase poll + set-address + chunk + manifest.
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNLOAD_IDLE), //       mass erase
      status(DFU_STATE.dfuDNLOAD_IDLE), //       set-address
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk
      status(DFU_STATE.dfuIDLE), //              manifest
    ])
    const client = new DfuClient(mock)
    await client.flash(
      [{ address: 0x08000000, data: new Uint8Array([1, 2, 3, 4]) }],
      // sectorsToErase is ignored when useMassErase is true.
      [0x08000000, 0x08020000, 0x08100000],
      { transferSize: 2048, useMassErase: true },
    )
    const dnloads = mock.log.filter(e => e.kind === 'out' && e.setup.request === DFU_REQ.DNLOAD)
    // One mass-erase + set-address + 1 chunk + manifest = 4 (vs 6 with
    // per-sector erase across 3 sectors). Mass erase is just `[0x41]`
    // — no address payload — distinguishing it from ERASE_PAGE.
    expect(dnloads).toHaveLength(4)
    const eraseCmd = dnloads.find(d => d.setup.value === 0 && d.data?.[0] === DFUSE_CMD.ERASE_PAGE)
    expect(eraseCmd).toBeDefined()
    expect(eraseCmd!.data!.length).toBe(1) // mass erase has no address payload
  })

  it('re-SET_ADDRESSes after the H7 Rev.V write-stuck workaround drains state', async () => {
    // Simulate a write where one chunk hits the H7 Rev.V stuck state:
    // first poll = dfuDNBUSY, wait, second poll = STILL dfuDNBUSY →
    // drainToIdle kicks in (CLRSTATUS until dfuIDLE), and the program
    // loop must re-SET_ADDRESS to the current offset before continuing.
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //                    ensureIdle
      status(DFU_STATE.dfuDNLOAD_IDLE), //             mass erase first poll (short-circuit)
      status(DFU_STATE.dfuDNLOAD_IDLE), //             set-address (initial)
      status(DFU_STATE.dfuDNLOAD_IDLE), //             chunk 0: fast-chip path → 'ok'
      // chunk 1 hits the Rev.V quirk:
      status(DFU_STATE.dfuDNBUSY), //                  chunk 1 first poll
      status(DFU_STATE.dfuDNBUSY), //                  chunk 1 second poll — still busy
      // drainToIdle:
      status(DFU_STATE.dfuDNBUSY), //                  drain attempt 1
      status(DFU_STATE.dfuERROR, DFU_STATUS.errUNKNOWN), // drain attempt 2
      status(DFU_STATE.dfuIDLE), //                    drain attempt 3 → idle ✓
      // outer loop re-SET_ADDRESSes:
      status(DFU_STATE.dfuDNLOAD_IDLE), //             set-address (resumed)
      status(DFU_STATE.dfuDNLOAD_IDLE), //             chunk 2: back to fast-chip path
      status(DFU_STATE.dfuIDLE), //                    manifest
    ])

    const image = new Uint8Array(3 * 2048) // 3 chunks of 2 KB
    const client = new DfuClient(mock)
    await client.flash(
      [{ address: 0x08020000, data: image }],
      [],
      { transferSize: 2048, useMassErase: true },
    )

    // Two SET_ADDRESS commands on the wire — initial + resume-after-drain.
    const dnloads = mock.log.filter(e => e.kind === 'out' && e.setup.request === DFU_REQ.DNLOAD)
    const setAddrs = dnloads.filter(d => d.setup.value === 0 && d.data?.[0] === DFUSE_CMD.SET_ADDRESS)
    expect(setAddrs).toHaveLength(2)
    // The resumed SET_ADDRESS should point at the offset where chunk 1
    // landed (2 chunks × 2048 = 4096 bytes into the region).
    const resumedSetAddr = setAddrs[1]!.data!
    const addr = resumedSetAddr[1]! | (resumedSetAddr[2]! << 8) | (resumedSetAddr[3]! << 16) | (resumedSetAddr[4]! << 24)
    expect(addr >>> 0).toBe((0x08020000 + 4096) >>> 0)
    // Two CLRSTATUS calls on the wire (the drainToIdle workaround).
    const clearStatuses = mock.log.filter(e => e.kind === 'out' && e.setup.request === 0x04 /* CLRSTATUS */)
    expect(clearStatuses).toHaveLength(2)
  })

  it('rejects an empty regions list', async () => {
    const client = new DfuClient(new MockUSBControl())
    await expect(client.flash([], [])).rejects.toThrow(/no regions/)
  })

  it('treats a device disconnect during manifest as success', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNLOAD_IDLE), //       set-address
      status(DFU_STATE.dfuDNLOAD_IDLE), //       chunk
      // (no manifest reply queued — controlIn will throw → swallowed)
    ])
    const client = new DfuClient(mock)
    // No sectors to erase (skip path).
    await client.flash(
      [{ address: 0x08020000, data: new Uint8Array([1, 2, 3, 4]) }],
      [],
      { transferSize: 2048 },
    )
    // Reached end without throwing.
  })
})

describe('dfuClient.readUnprotect', () => {
  // The wait is deliberately long (the device's estimate plus a 20s
  // margin), so every case here drives fake timers past it.
  // Capture the outcome rather than holding a rejectable promise across
  // the clock advance: the fail-fast paths reject before any timer runs,
  // which would otherwise surface as an unhandled rejection.
  async function runWithTimers<T>(fn: () => Promise<T>, advanceMs = 60_000): Promise<T> {
    vi.useFakeTimers()
    try {
      const outcome = fn().then(
        v => ({ ok: true as const, v }),
        e => ({ ok: false as const, e }),
      )
      await vi.advanceTimersByTimeAsync(advanceMs)
      const result = await outcome
      if (!result.ok)
        throw result.e
      return result.v
    }
    finally {
      vi.useRealTimers()
    }
  }

  it('sends the bare 0x92 command as a wBlockNum=0 download', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuDNBUSY, DFU_STATUS.OK, 5000),
    ])
    const client = new DfuClient(mock)

    await runWithTimers(() => client.readUnprotect())

    const dnload = mock.log.find(e => e.kind === 'out' && e.setup.request === DFU_REQ.DNLOAD)
    expect(dnload).toBeDefined()
    expect(dnload!.setup.value).toBe(0)
    expect([...dnload!.data!]).toEqual([DFUSE_CMD.READ_UNPROTECT])
  })

  it('treats the device going away as success, because that is what a reset looks like', async () => {
    const mock = new MockUSBControl()
    // No third status queued: the mock throws, standing in for the
    // bootloader having reset itself mid-erase.
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuDNBUSY, DFU_STATUS.OK, 5000),
    ])
    const client = new DfuClient(mock)

    await expect(runWithTimers(() => client.readUnprotect())).resolves.toBeUndefined()
  })

  it('reports completion through the progress callback', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuDNBUSY, DFU_STATUS.OK, 5000),
    ])
    const client = new DfuClient(mock)
    const seen: number[] = []

    await runWithTimers(() => client.readUnprotect(f => seen.push(f)))

    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(1)
    expect(Math.max(...seen.slice(0, -1))).toBeLessThanOrEqual(0.95)
  })

  it('fails when the device answers afterwards, meaning it never reset', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuDNBUSY, DFU_STATUS.OK, 5000),
      status(DFU_STATE.dfuIDLE),
    ])
    const client = new DfuClient(mock)

    await expect(runWithTimers(() => client.readUnprotect()))
      .rejects
      .toThrow(/didn't restart after unlocking/)
  })

  it('fails fast when the board never starts unlocking', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuIDLE), // not dfuDNBUSY — nothing happened
    ])
    const client = new DfuClient(mock)

    await expect(runWithTimers(() => client.readUnprotect()))
      .rejects
      .toThrow(/didn't start unlocking/)
  })

  it('surfaces an error status from the command itself', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE),
      status(DFU_STATE.dfuERROR, DFU_STATUS.errVENDOR),
    ])
    const client = new DfuClient(mock)

    await expect(runWithTimers(() => client.readUnprotect()))
      .rejects
      .toThrow(/Couldn't unlock this board/)
  })
})
