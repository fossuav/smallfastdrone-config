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

// useConnections — composable for the Connections wizard's live UART
// table. Wraps a one-shot fetch of @SYS/uarts.txt over MAVLink-FTP,
// parses it, and merges the per-port row with the matching
// SERIALn_PROTOCOL / SERIALn_BAUD params already in the params store.
// The detect-and-propose logic (slice 2) reads off the same store; this
// slice just renders what's currently there.

import type { UartInfo } from './uart-info'
import { ref, shallowRef } from 'vue'
import { MavFtp } from '../protocol/ftp'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { parseUartsTxt } from './uart-info'

// MAVLink component id for the autopilot — the FTP service runs there.
const COMP_ID_AUTOPILOT = 1

// Path the firmware exposes for the UART status table. See
// AP_Filesystem_Sys.cpp; the @SYS prefix is a virtual filesystem root.
const UARTS_PATH = '@SYS/uarts.txt'

// Operator-friendly protocol labels keyed by SERIALn_PROTOCOL value.
// Enum values come from AP_SerialManager/AP_SerialManager.h. Only the
// protocols an operator might reasonably encounter on a SmallFastDrone
// build get a friendly label; the long tail (Volz, Torqeedo, Generator,
// AIS, …) falls through to a "Protocol <n>" tag — those configurations
// are expert-mode territory anyway.
export const PROTOCOL_LABELS: Record<number, string> = {
  [-1]: 'Off',
  0: 'Console',
  1: 'MAVLink',
  2: 'MAVLink2',
  3: 'FrSky D',
  4: 'FrSky SPort',
  5: 'GPS',
  6: 'GPS (2nd)',
  9: 'Rangefinder',
  10: 'FrSky telemetry',
  13: 'Beacon',
  16: 'ESC telemetry',
  22: 'CAN-over-serial',
  23: 'RC input',
  28: 'Lua scripting',
  29: 'CRSF / ELRS',
  32: 'MSP',
  33: 'DJI FPV',
  34: 'Airspeed',
  35: 'ADS-B',
  37: 'VTX (SmartAudio)',
  38: 'ESC (FETtec OneWire)',
  42: 'DJI OSD (MSP DisplayPort)',
  43: 'MAVLink HL',
  44: 'VTX (Tramp)',
  45: 'DDS / XRCE',
}

// Render the SERIALn_PROTOCOL value as an operator label. Unknown
// values fall through to "Protocol <n>" so the table never goes blank
// on a firmware that adds an enum entry we haven't catalogued yet.
export function protocolLabel(value: number | null | undefined): string {
  if (value === null || value === undefined)
    return '—'
  return PROTOCOL_LABELS[value] ?? `Protocol ${value}`
}

// One row of the Connections panel — a UART from uarts.txt plus its
// current protocol/baud from the params store. `active` is the cheap
// "is anything flowing on this UART right now" signal off the
// instantaneous TXBD/RXBD; slice 2 will replace this with a
// before/after byte-counter delta over a sampling window so a UART
// that's open but momentarily silent doesn't show as inactive.
export interface ConnectionRow {
  // Original UART entry from uarts.txt — kept whole so the panel can
  // surface descriptor / DMA flags / SITL connected hint without
  // re-flattening every field.
  uart: UartInfo
  // SERIALn_PROTOCOL value from the params store, null if the param
  // isn't present (true for IOMCU rows and for any SERIAL slot the FC
  // doesn't expose a param for).
  protocol: number | null
  // SERIALn_BAUD value, null if not present.
  baud: number | null
  // Operator-friendly protocol name for the table cell.
  protocolLabel: string
  // Any byte flow seen in the last firmware sampling interval.
  active: boolean
}

// Build the rows. Pure function so the composable + tests can both
// call it without standing up a real session.
export function buildConnectionRows(
  uarts: UartInfo[],
  protocols: ReadonlyMap<string, number>,
  bauds: ReadonlyMap<string, number>,
): ConnectionRow[] {
  return uarts.map((u) => {
    const protocol = u.index !== null ? (protocols.get(`SERIAL${u.index}_PROTOCOL`) ?? null) : null
    const baud = u.index !== null ? (bauds.get(`SERIAL${u.index}_BAUD`) ?? null) : null
    return {
      uart: u,
      protocol,
      baud,
      protocolLabel: protocolLabel(protocol),
      active: u.txBd > 0 || u.rxBd > 0,
    }
  })
}

// Composable for the Connections panel. One-shot fetch on demand;
// slice 2 will add periodic refresh + a before/after delta for the
// activity column.
export function useConnections() {
  const session = useSessionStore()
  const params = useParamsStore()

  // Loading state for the fetch button; rows reactive so the table
  // re-renders after refresh().
  const loading = ref(false)
  const error = shallowRef<string | null>(null)
  const rows = shallowRef<ConnectionRow[]>([])

  // Build the per-SERIAL param lookup maps from whatever's in the
  // params store right now. Cheap to do per call; the store's already
  // the cache.
  function paramMaps(): { protocols: Map<string, number>, bauds: Map<string, number> } {
    const protocols = new Map<string, number>()
    const bauds = new Map<string, number>()
    for (const [name, p] of params.params) {
      if (name.endsWith('_PROTOCOL') && name.startsWith('SERIAL'))
        protocols.set(name, p.value)
      else if (name.endsWith('_BAUD') && name.startsWith('SERIAL'))
        bauds.set(name, p.value)
    }
    return { protocols, bauds }
  }

  // Fetch @SYS/uarts.txt + rebuild rows. Loads the params store first
  // if empty so SERIAL{n}_PROTOCOL is available for the merge.
  async function refresh() {
    if (loading.value)
      return
    if (!session.connected || session.sysid === null) {
      error.value = 'Connect to your drone first.'
      return
    }
    loading.value = true
    error.value = null
    try {
      if (params.count === 0)
        await params.load()

      const ftp = new MavFtp(
        session.sendMessage,
        session.subscribeMessages,
        session.sysid,
        COMP_ID_AUTOPILOT,
      )
      const bytes = await ftp.downloadFile(UARTS_PATH)
      const text = new TextDecoder().decode(bytes)
      const parsed = parseUartsTxt(text)
      const { protocols, bauds } = paramMaps()
      rows.value = buildConnectionRows(parsed.ports, protocols, bauds)
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loading.value = false
    }
  }

  return { rows, loading, error, refresh }
}
