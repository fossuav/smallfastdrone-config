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

import { describe, expect, it } from 'vitest'
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
  it('issues DfuSe ERASE_PAGE + polls until idle', async () => {
    const mock = new MockUSBControl()
    queueStatuses(mock, [status(DFU_STATE.dfuDNLOAD_IDLE)])
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
})

describe('dfuClient.flash — end-to-end', () => {
  it('does ensureIdle → erase each sector → set-address → DNLOAD chunks → manifest', async () => {
    const mock = new MockUSBControl()

    // Sequence of GETSTATUS replies, in the order the client polls:
    //   ensureIdle              — 1 poll (dfuIDLE)
    //   erase sector 0          — 1 poll (dfuDNLOAD_IDLE)
    //   erase sector 1          — 1 poll
    //   set-address             — 1 poll
    //   dnload chunk 0          — 1 poll (dfuDNLOAD_IDLE)
    //   dnload chunk 1          — 1 poll
    //   dnload chunk 2          — 1 poll
    //   manifest                — 1 poll (dfuMANIFEST_WAIT_RESET)
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 0
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 1
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

    // Progress: after 2048, 4096, 5120 bytes of 5120 total.
    expect(progress).toEqual([2048 / 5120, 4096 / 5120, 1])

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
    // ensureIdle + manifest.
    queueStatuses(mock, [
      status(DFU_STATE.dfuIDLE), //              ensureIdle
      status(DFU_STATE.dfuDNLOAD_IDLE), //       erase sec 0
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
