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

// Parser for ArduPilot's @SYS/uarts.txt. The firmware exposes one row
// per active SERIAL slot with its physical identity and live byte
// counters, which the Connections wizard turns into "what's actually
// plugged in" by combining the row with the matching SERIALn_PROTOCOL
// param and watching the byte counters move over time. There's no
// per-board catalogue: the FC reports its own UART map.
//
// Two formats land in this file because the firmware emits different
// strings from each HAL:
//
//   ChibiOS (real flight controllers) — see AP_HAL_ChibiOS/Util.cpp
//   and UARTDriver::uart_info; format below:
//
//     SERIAL2 USART2 TX*=     324 RX*=    5112 TXBD=   681 RXBD= 10759 \
//             RXDRP=       0 FE=0 OE=0 NE=0 FlowCtrl=0
//
//   SITL — see AP_HAL_SITL/UARTDriver::uart_info:
//
//     SERIAL3 TX=     324 RX=    5112 TXBD=   681 RXBD= 10759 connected     (GPS1)
//
// Differences worth knowing:
//   * ChibiOS prints a physical chip label (OTG1/USART2/UART4) as the
//     second token; SITL omits it.
//   * ChibiOS uses TX* / RX* to indicate DMA is enabled (space when
//     not); SITL uses a plain TX/RX.
//   * ChibiOS adds RXDRP / FE / OE / NE / FlowCtrl pairs; SITL omits
//     them.
//   * The "connected" / "not connected" word is SITL-only — it isn't a
//     usable signal on real hardware, so the auto-detect logic
//     elsewhere keys off byte-counter deltas instead. We capture the
//     flag anyway for completeness.
//   * SITL ends every row with a parenthesised serial path (tcp:N,
//     GPS1); ChibiOS doesn't.

// First line of every uarts.txt — bumped if the firmware ever changes
// the row format. We accept any UARTV<n> rather than pinning to V1
// because consumers care about the rows, not the header.
const VERSION_LINE_RE = /^UARTV(\d+)\s*$/

// Row prefix: either SERIALn for a normal port, or IOMCU on boards
// with an IO co-processor (HAL_WITH_IO_MCU). IOMCU rows are reported
// but have no SERIALn_PROTOCOL param to bind to.
const ROW_PREFIX_RE = /^(SERIAL\d+|IOMCU)\s+/

// A trailing "(descriptor)" group at end of line — present on SITL
// (carries the serial path or sim identity), absent on ChibiOS.
const DESCRIPTOR_RE = /\(([^)]*)\)\s*$/

// Loose key=value scan over the stats portion of a row. Captures the
// key, an optional `*` DMA marker (printf emits ' ' when off and '*'
// when on, so we accept either), and the integer value.
const KV_RE = /([A-Z]+)([* ]?)=\s*(\d+)/gi

// SITL connected / not-connected flag. Order matters: test "not
// connected" first or "connected" wins on a substring match.
const NOT_CONNECTED_RE = /\bnot connected\b/
const CONNECTED_RE = /\bconnected\b/

// Per-row decoded payload. Numeric fields are 0 when the source format
// didn't emit them (e.g. SITL has no RXDRP), so the consumer can treat
// every field as present.
export interface UartInfo {
  // Row identifier as printed by the firmware: 'SERIAL0'..'SERIALn'
  // for normal ports, 'IOMCU' on boards with an IO co-processor.
  logical: string
  // Numeric SERIAL index (matches the SERIALn_PROTOCOL param). null for
  // IOMCU and for any future non-SERIAL row.
  index: number | null
  // Physical chip identifier when the firmware emits it (ChibiOS:
  // 'OTG1', 'USART2', 'UART4'). null on SITL.
  physical: string | null
  // Cumulative TX / RX byte counters since boot.
  txBytes: number
  rxBytes: number
  // Instantaneous bandwidth as the firmware reports it (TXBD/RXBD are
  // bytes-times-10000 / dt_ms — we expose the raw int and let the
  // consumer ask "is it nonzero" for the Activity column).
  txBd: number
  rxBd: number
  // DMA enabled on TX / RX path (ChibiOS only — always false on SITL).
  txDma: boolean
  rxDma: boolean
  // SITL "connected" flag. undefined on ChibiOS (the format omits it
  // entirely — operator should not infer anything from this on real
  // hardware).
  sitlConnected: boolean | undefined
  // Trailing parenthesised descriptor from the row, when present.
  descriptor: string | null
}

// Whole-file decoded payload.
export interface UartsTxt {
  // The UARTV<n> header version. 1 is the only version shipped so far.
  version: number
  // One entry per row, in file order. Skipped indices (where the FC
  // has a SERIAL slot reserved but no driver — e.g. SERIAL5 EMPTY on
  // the TBS_LUCID_H7) are simply absent.
  ports: UartInfo[]
}

// Tokens that look like physical labels but aren't — the key=value
// scanner would also match these. The physical-label detection rejects
// any token that's a known stats key so a row that happens to omit the
// physical label (SITL) isn't misread.
const STATS_KEYS = new Set([
  'TX',
  'RX',
  'TXBD',
  'RXBD',
  'RXDRP',
  'FE',
  'OE',
  'NE',
  'FlowCtrl',
])

// Parse a single row into a UartInfo. Returns null if the row doesn't
// begin with a recognisable SERIAL / IOMCU prefix (the caller skips
// the line in that case rather than failing the whole file).
function parseRow(line: string): UartInfo | null {
  const prefix = line.match(ROW_PREFIX_RE)
  if (!prefix || prefix[1] === undefined)
    return null
  const logical = prefix[1]
  let rest = line.slice(prefix[0].length)

  // Pull off the trailing "(descriptor)" if present so the key=value
  // scanner doesn't try to read it as a stats pair.
  let descriptor: string | null = null
  const desc = rest.match(DESCRIPTOR_RE)
  if (desc) {
    descriptor = desc[1] ?? null
    rest = rest.slice(0, rest.length - desc[0].length).trimEnd()
  }

  // ChibiOS emits an alphanumeric physical label as the second token
  // (OTG1 / USART2 / UART4). Detect by looking at the first token: if
  // it's a stats key like "TX" or a key=value pair, there's no label.
  let physical: string | null = null
  const firstToken = rest.match(/^(\S+)/)?.[1] ?? ''
  const firstKey = firstToken.replace(/[* ]?=.*$/, '')
  if (firstToken.length > 0 && !STATS_KEYS.has(firstKey) && !firstToken.startsWith('TX') && !firstToken.startsWith('RX')) {
    physical = firstToken
    rest = rest.slice(firstToken.length).trimStart()
  }

  // SITL connected flag — order matters; "not connected" is a
  // superset of "connected".
  let sitlConnected: boolean | undefined
  if (NOT_CONNECTED_RE.test(rest))
    sitlConnected = false
  else if (CONNECTED_RE.test(rest))
    sitlConnected = true

  // Key=value scan.
  const kv: Record<string, { value: number, dma: boolean }> = {}
  for (const m of rest.matchAll(KV_RE)) {
    const key = m[1]
    const value = m[3]
    if (key === undefined || value === undefined)
      continue
    kv[key] = { value: Number(value), dma: m[2] === '*' }
  }

  const index = logical.startsWith('SERIAL') ? Number(logical.slice('SERIAL'.length)) : null

  return {
    logical,
    index: Number.isFinite(index) ? index : null,
    physical,
    txBytes: kv.TX?.value ?? 0,
    rxBytes: kv.RX?.value ?? 0,
    txBd: kv.TXBD?.value ?? 0,
    rxBd: kv.RXBD?.value ?? 0,
    txDma: kv.TX?.dma ?? false,
    rxDma: kv.RX?.dma ?? false,
    sitlConnected,
    descriptor,
  }
}

// Decode a full @SYS/uarts.txt file. Throws if the header is missing
// or malformed; that's the only operator-actionable failure (every
// other line that fails to parse is silently skipped, since the
// firmware can introduce a new pair in a row format without breaking
// the rest of the row).
export function parseUartsTxt(text: string): UartsTxt {
  const lines = text.split(/\r?\n/)
  const headerMatch = lines[0]?.match(VERSION_LINE_RE)
  if (!headerMatch)
    throw new Error('uarts.txt: missing or unrecognised header (expected "UARTV<n>")')

  const version = Number(headerMatch[1])
  const ports: UartInfo[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.trim() === '')
      continue
    const port = parseRow(line)
    if (port)
      ports.push(port)
  }
  return { version, ports }
}
