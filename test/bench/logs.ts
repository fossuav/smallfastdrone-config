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

// Bench check for F13: does a claimed drone actually write its logs
// encrypted, and can only its owner read them back?
//
// SITL cannot answer this - the encryption compiles out of an unsigned
// build, and there is no owner key region off ChibiOS. It needs a board
// with a card in it.
//
// It turns logging on while disarmed so a log exists without flying,
// restarts logging so a fresh file is opened after the claim, then pulls
// the newest log off the card over MAVLink FTP and reports what the first
// bytes say. Decrypting it is the other half, and belongs to the owner's
// key:
//
//   Tools/scripts/signing/decrypt_sfx.py --owner-key ... --identity ... <file>
//
// Run:
//   bun run bench:logs [output-dir]
//
// Writes LOG_DISARMED and puts it back. Nothing here arms or spins a motor.

import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { MavParamType } from 'mavlink-mappings/dist/lib/common'
import { MavFtp } from '../../src/protocol/ftp'
import {
  buildPreflightReboot,
  buildRequestMessage,
  decodeFirmwareVersion,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import { buildParamRequestRead, buildParamSet, MSGID_PARAM_VALUE } from '../../src/protocol/params'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1
const LOG_DIR = '/APM/LOGS'
const SFX_MAGIC = 'SFDX10'
// ArduPilot's own log framing, so a plaintext log is recognised as one
// rather than merely "not encrypted"
const DF_HEAD = [0xA3, 0x95]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Read one parameter, or null if the drone doesn't answer.
async function readParam(session: MavLinkSession, link: { write: (b: Uint8Array) => void }, sysid: number, name: string): Promise<number | null> {
  return new Promise((resolve) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      resolve(null)
    }, 5000)
    off = session.on((msg) => {
      if (msg.msgid !== MSGID_PARAM_VALUE)
        return
      const d = msg.data as { paramId: string, paramValue: number }
      if (String(d.paramId).replace(/\0.*$/, '') !== name)
        return
      clearTimeout(timer)
      off?.()
      resolve(d.paramValue)
    })
    link.write(session.serialize(buildParamRequestRead(sysid, COMP_ID_AUTOPILOT, name)))
  })
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? '.'

  const link = openSerialLink()
  const session = new MavLinkSession()
  link.onData(bytes => session.feed(bytes))
  session.on((msg) => {
    if (msg.msgid === MSGID_STATUSTEXT) {
      const text = String((msg.data as { text: string }).text)
      if (/log|card|sd/i.test(text))
        console.log(`        drone: ${text}`)
    }
  })

  const port = await link.ready()
  console.log(`[logs] ${port} open`)

  const sysid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no heartbeat within 15s')), 15_000)
    const off = session.on((msg) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT) {
        clearTimeout(timer)
        off()
        resolve(msg.sysid)
      }
    })
  })
  link.write(session.serialize(buildRequestMessage(sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)))
  const version = await new Promise<string>((resolve) => {
    const off = session.on((msg) => {
      if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
        off()
        const d = msg.data as { flightSwVersion: number, flightCustomVersion: ArrayLike<number> }
        resolve(decodeFirmwareVersion(d.flightSwVersion, d.flightCustomVersion))
      }
    })
  })
  console.log(`[logs] sysid=${sysid} fw=${version}`)

  // Log while disarmed, so a log exists without flying the aircraft.
  // The original value is read first and put back at the end: a bench
  // check that leaves the board configured differently from how it found
  // it is a check that changed its own subject.
  const wasDisarmedLogging = await readParam(session, link, sysid, 'LOG_DISARMED')
  console.log(`[logs] LOG_DISARMED was ${wasDisarmedLogging ?? 'unreadable'}; enabling…`)
  link.write(session.serialize(buildParamSet(sysid, COMP_ID_AUTOPILOT, 'LOG_DISARMED', 1, MavParamType.INT8)))
  await sleep(2000)

  // A reboot is what opens a new log file, which is what makes this a
  // test of a log written *after* the claim rather than before it.
  console.log('[logs] rebooting so a fresh log is opened…')
  link.write(session.serialize(buildPreflightReboot(sysid, COMP_ID_AUTOPILOT)))
  await sleep(20_000)
  await link.ready()
  console.log('[logs] back; letting the log fill…')
  await sleep(15_000)

  const ftp = new MavFtp(
    async msg => link.write(session.serialize(msg)),
    cb => session.on(cb),
    sysid,
    COMP_ID_AUTOPILOT,
  )

  const entries = await ftp.listDirectory(LOG_DIR)
  const logs = entries
    .filter(e => !e.isDirectory && /\.BIN$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (logs.length === 0) {
    console.log(`[logs] FAIL — no logs in ${LOG_DIR}; is there a card in the board?`)
    process.exit(1)
  }
  const newest = logs[logs.length - 1]
  console.log(`[logs] ${logs.length} log(s); newest ${newest.name} (${newest.size} bytes)`)

  const bytes = await ftp.downloadFile(`${LOG_DIR}/${newest.name}`)
  const path = `${outDir}/${newest.name}`
  writeFileSync(path, bytes)
  console.log(`[logs] downloaded ${bytes.length} bytes to ${path}`)

  if (wasDisarmedLogging !== null && wasDisarmedLogging !== 1) {
    console.log(`[logs] restoring LOG_DISARMED=${wasDisarmedLogging}`)
    link.write(session.serialize(buildParamSet(sysid, COMP_ID_AUTOPILOT, 'LOG_DISARMED', wasDisarmedLogging, MavParamType.INT8)))
    await sleep(2000)
  }

  const magic = new TextDecoder().decode(bytes.subarray(0, SFX_MAGIC.length))
  if (magic === SFX_MAGIC) {
    console.log(`[logs] PASS — encrypted: header says ${SFX_MAGIC}`)
    console.log(`[logs]   content type ${bytes[6]} (2 = log), flags ${bytes[7]}`)
    console.log(`[logs]   from drone   ${[...bytes.subarray(8, 20)].map(b => b.toString(16).padStart(2, '0')).join('')}`)
    console.log('[logs] now decrypt it with the owner key:')
    console.log(`[logs]   decrypt_sfx.py --owner-key <key> --identity <json> ${path}`)
  }
  else if (bytes[0] === DF_HEAD[0] && bytes[1] === DF_HEAD[1]) {
    console.log('[logs] FAIL — this log is plaintext (ArduPilot log framing at byte 0)')
    process.exit(1)
  }
  else {
    console.log(`[logs] FAIL — unrecognised header ${[...bytes.subarray(0, 8)].map(b => b.toString(16)).join(' ')}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error(`[logs] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
