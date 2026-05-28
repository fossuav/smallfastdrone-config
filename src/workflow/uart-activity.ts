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

// Connections slice 2 — pure activity classification. Given two UART
// snapshots taken a few seconds apart, decide whether each port is
// active, silent, or only sending. Combine that with the port's
// configured protocol to land an operator-readable Finding the table
// can render with a green / yellow / red status.
//
// Why byte-counter deltas rather than the SITL-only `connected` flag:
// ChibiOS doesn't emit the flag (see uart-info.ts), and counter
// movement is a stronger signal anyway — a peripheral that's plugged
// in but silent is operationally the same as nothing plugged in. The
// counters in @SYS/uarts.txt are cumulative bytes since boot, so any
// growth between samples means real traffic.

import type { ConnectionRow } from './connections'
import type { UartInfo } from './uart-info'

// What the byte counters say about a single port. 'unknown' covers
// samples taken too close together to mean anything (dt < 500 ms).
export type ActivityClass = 'active' | 'outbound-only' | 'silent' | 'unknown'

// Classify one port from a before/after pair. RX growth is the
// strongest "something's there" signal — anything arriving means a
// peripheral is talking. TX-only growth happens for one-way protocols
// (DJI OSD MSP DisplayPort) where the FC writes but the device never
// echoes. Both quiet means either nothing plugged in or a device that
// only speaks when needed (e.g. ESC telemetry while disarmed).
export function classifyActivity(
  before: UartInfo,
  after: UartInfo,
  dtMs: number,
): ActivityClass {
  if (dtMs < 500)
    return 'unknown'
  const rxDelta = after.rxBytes - before.rxBytes
  const txDelta = after.txBytes - before.txBytes
  if (rxDelta > 0)
    return 'active'
  if (txDelta > 0)
    return 'outbound-only'
  return 'silent'
}

// Operator-readable verdict for one row. Status drives the colour
// + icon in the table; label is the short heading; detail is the
// explanation line the operator reads when they want to know why.
export type FindingStatus = 'ok' | 'gcs' | 'misconfigured' | 'outbound' | 'quiet' | 'unused' | 'pending'

export interface Finding {
  status: FindingStatus
  label: string
  detail: string
}

// SERIALn_PROTOCOL values that the operator should read as "no role
// assigned": -1 = None (the standard off value), 0 = Console (unused
// per AP_SerialManager.h).
function hasProtocol(protocol: number | null): boolean {
  return protocol !== null && protocol !== -1 && protocol !== 0
}

// Turn a row + its activity class into a Finding. The classification
// matrix is deliberately small — the operator should not have to think
// about edge cases. ESC-telem-while-disarmed and similar "quiet is
// normal" cases land under `quiet`, which the table renders in yellow
// with a "may be normal" hint rather than red alarm.
export function classifyFinding(
  row: ConnectionRow,
  activity: ActivityClass,
): Finding {
  // SERIAL0 is the GCS link the operator is using right now — TX is
  // always active (us sending) and RX usually is too (heartbeats).
  // Calling it "active" tells the operator nothing useful; calling it
  // out as the GCS port does.
  if (row.uart.index === 0) {
    return {
      status: 'gcs',
      label: 'Talking to this tool',
      detail: 'This is the USB connection you\'re using right now.',
    }
  }

  const proto = row.protocol
  const configured = hasProtocol(proto)

  if (activity === 'unknown') {
    return {
      status: 'pending',
      label: 'Checking…',
      detail: 'Watching for traffic.',
    }
  }

  if (activity === 'active' && configured) {
    return {
      status: 'ok',
      label: 'Working',
      detail: `${row.protocolLabel} is sending data.`,
    }
  }

  if (activity === 'active' && !configured) {
    return {
      status: 'misconfigured',
      label: 'Something\'s plugged in here',
      detail: 'Data is arriving but no role is assigned. Set a protocol so your drone can use it.',
    }
  }

  if (activity === 'outbound-only' && configured) {
    return {
      status: 'outbound',
      label: 'Sending',
      detail: `${row.protocolLabel} is one-way — your drone is sending but nothing's coming back. Normal for displays.`,
    }
  }

  if (activity === 'outbound-only' && !configured) {
    // Edge case: the FC shouldn't TX on an unassigned port, but it
    // can happen briefly after a config change. Treat as unused.
    return {
      status: 'unused',
      label: 'Unused',
      detail: 'No role assigned, nothing flowing in.',
    }
  }

  // activity === 'silent'
  if (configured) {
    return {
      status: 'quiet',
      label: `${row.protocolLabel} — nothing arriving`,
      detail: 'Either the device isn\'t plugged in, isn\'t powered, or only talks when active (some only speak while in use).',
    }
  }

  return {
    status: 'unused',
    label: 'Unused',
    detail: 'Nothing assigned, nothing plugged in.',
  }
}
