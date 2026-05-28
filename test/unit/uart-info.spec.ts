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

// Unit tests for the @SYS/uarts.txt parser. Two real-world fixtures
// (SITL + a hand-built ChibiOS sample matching the firmware's printf)
// pin down the differences between the two formats; a few targeted
// cases pin individual fields.

import { describe, expect, it } from 'vitest'
import { parseUartsTxt } from '../../src/workflow/uart-info'

// Captured live from `bun run sitl:start` + pymavlink FTP-get of
// @SYS/uarts.txt on 2026-05-28. SITL has no physical label, plain
// TX=/RX= (no DMA marker), a 'connected'/'not connected' word, and a
// trailing parenthesised serial path.
const SITL_FIXTURE = `UARTV1
SERIAL0 TX=    1410 RX=      60 TXBD=  2967 RXBD=   126 connected     (tcp:0:wait)
SERIAL1 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:2)
SERIAL2 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:3)
SERIAL3 TX=     324 RX=    5112 TXBD=   681 RXBD= 10759 connected     (GPS1)
SERIAL4 TX=       0 RX=       0 TXBD=     0 RXBD=     0 connected     (GPS2)
SERIAL5 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:5)
SERIAL6 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:6)
SERIAL7 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:7)
SERIAL8 TX=       0 RX=       0 TXBD=     0 RXBD=     0 not connected (tcp:8)
`

// Synthesised from the ChibiOS UARTDriver::uart_info printf format
// string in AP_HAL_ChibiOS/UARTDriver.cpp + Util::uart_info in Util.cpp
// — physical label as the second token, TX*/RX* with the DMA-on
// marker, RXDRP / FE / OE / NE / FlowCtrl trailing.
const CHIBIOS_FIXTURE = `UARTV1
SERIAL0 OTG1  TX*=    1410 RX*=      60 TXBD=  2967 RXBD=   126 RXDRP=       0 FE=0 OE=0 NE=0 FlowCtrl=0
SERIAL2 USART2 TX*=     324 RX*=    5112 TXBD=   681 RXBD= 10759 RXDRP=       0 FE=0 OE=0 NE=0 FlowCtrl=0
SERIAL4 UART4 TX =       0 RX =       0 TXBD=     0 RXBD=     0 RXDRP=       0 FlowCtrl=0
`

describe('parseUartsTxt', () => {
  it('reads the SITL fixture into 9 ports with the expected logical ids', () => {
    const parsed = parseUartsTxt(SITL_FIXTURE)
    expect(parsed.version).toBe(1)
    expect(parsed.ports.map(p => p.logical)).toEqual([
      'SERIAL0',
      'SERIAL1',
      'SERIAL2',
      'SERIAL3',
      'SERIAL4',
      'SERIAL5',
      'SERIAL6',
      'SERIAL7',
      'SERIAL8',
    ])
    expect(parsed.ports.every(p => p.physical === null)).toBe(true)
  })

  it('extracts SITL connected flag + descriptor for the GPS row', () => {
    const parsed = parseUartsTxt(SITL_FIXTURE)
    const serial3 = parsed.ports.find(p => p.logical === 'SERIAL3')!
    expect(serial3.index).toBe(3)
    expect(serial3.sitlConnected).toBe(true)
    expect(serial3.descriptor).toBe('GPS1')
    expect(serial3.txBytes).toBe(324)
    expect(serial3.rxBytes).toBe(5112)
    expect(serial3.txBd).toBe(681)
    expect(serial3.rxBd).toBe(10759)
    expect(serial3.txDma).toBe(false)
    expect(serial3.rxDma).toBe(false)
  })

  it('treats SITL "not connected" rows as such (and not as "connected")', () => {
    const parsed = parseUartsTxt(SITL_FIXTURE)
    const serial1 = parsed.ports.find(p => p.logical === 'SERIAL1')!
    expect(serial1.sitlConnected).toBe(false)
    expect(serial1.descriptor).toBe('tcp:2')
  })

  it('reads the ChibiOS fixture with physical labels + DMA markers', () => {
    const parsed = parseUartsTxt(CHIBIOS_FIXTURE)
    expect(parsed.ports.map(p => p.logical)).toEqual(['SERIAL0', 'SERIAL2', 'SERIAL4'])

    const usb = parsed.ports[0]
    expect(usb.physical).toBe('OTG1')
    expect(usb.txDma).toBe(true)
    expect(usb.rxDma).toBe(true)
    expect(usb.txBytes).toBe(1410)
    expect(usb.rxBytes).toBe(60)
    expect(usb.sitlConnected).toBeUndefined()
    expect(usb.descriptor).toBeNull()

    const gps = parsed.ports[1]
    expect(gps.physical).toBe('USART2')
    expect(gps.txDma).toBe(true)
    expect(gps.rxDma).toBe(true)

    const noDma = parsed.ports[2]
    expect(noDma.physical).toBe('UART4')
    expect(noDma.txDma).toBe(false)
    expect(noDma.rxDma).toBe(false)
  })

  it('treats IOMCU rows as a logical entry with a null index', () => {
    const parsed = parseUartsTxt(`UARTV1
IOMCU   TX*=      10 RX*=      20 TXBD=     1 RXBD=     2 RXDRP=       0 FlowCtrl=0
SERIAL0 OTG1  TX*=    1410 RX*=      60 TXBD=  2967 RXBD=   126 RXDRP=       0 FlowCtrl=0
`)
    expect(parsed.ports[0].logical).toBe('IOMCU')
    expect(parsed.ports[0].index).toBeNull()
    expect(parsed.ports[0].physical).toBeNull()
    expect(parsed.ports[0].txBytes).toBe(10)
  })

  it('skips blank lines + unrecognised rows without failing', () => {
    const parsed = parseUartsTxt(`UARTV1

SERIAL0 TX=    1 RX=    2 TXBD=  3 RXBD=  4 connected     (tcp:0)

some unrelated line that snuck in
SERIAL1 TX=    5 RX=    6 TXBD=  7 RXBD=  8 not connected (tcp:2)
`)
    expect(parsed.ports.map(p => p.logical)).toEqual(['SERIAL0', 'SERIAL1'])
  })

  it('rejects a file with no recognisable header', () => {
    expect(() => parseUartsTxt('not a uarts file\n')).toThrow(/UARTV/)
    expect(() => parseUartsTxt('')).toThrow(/UARTV/)
  })

  it('accepts a future header version', () => {
    const parsed = parseUartsTxt('UARTV2\nSERIAL0 TX=    1 RX=    2 TXBD=  3 RXBD=  4 connected (tcp:0)\n')
    expect(parsed.version).toBe(2)
    expect(parsed.ports).toHaveLength(1)
  })
})
