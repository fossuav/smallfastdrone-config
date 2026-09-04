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

// Bench check — runs the protocol layer against a real flight controller
// on the bench and reports what actually happened. The hardware twin of
// `test/sitl/ftp-smoke.ts`: same protocol code, a board instead of a
// simulator.
//
// It exists because SITL cannot answer the questions that only real
// hardware can: how long a full parameter download takes over USB CDC and
// whether it drops anything; whether MAVLink FTP survives real serial
// timing; how much of the board's parameter set our bundled metadata
// actually describes; and how long a board takes to re-enumerate after a
// reboot, which is the thing the app's auto-reconnect has to tolerate and
// which SITL never does at all.
//
// Every check is read-only except `paramwrite` (writes one benign
// parameter and restores it) and `reboot` (reboots a disarmed board).
// Nothing here ever arms, spins a motor, or touches flash.
//
// Run (board attached — see test/bench/serial-link.ts):
//   bun run bench:check              # all checks
//   bun run bench:check params ftp   # named checks only
// Env:
//   BENCH_DEV   board's character device (default /dev/ttyACM0)

import type { DecodedMessage } from '../../src/protocol/mavlink'
import type { ParamRecord } from '../../src/protocol/params'
import type { SerialLink } from './serial-link'
import { MavFtp, MavFtpError } from '../../src/protocol/ftp'
import {
  buildDoSendBanner,
  buildPreflightReboot,
  buildRequestMessage,
  decodeFirmwareVersion,
  formatFcUid,
  MavLinkSession,
  MSGID_AUTOPILOT_VERSION,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import {
  buildParamRequestList,
  buildParamSet,
  buildPreflightStorageSave,
  getParamMeta,
  MSGID_PARAM_VALUE,
} from '../../src/protocol/params'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1
// Silence, not elapsed time, is what tells us a param stream has died:
// ArduPilot dribbles a big set out over many seconds but never leaves a
// long gap mid-stream. Same threshold the app's param store uses.
const SILENCE_TIMEOUT_MS = 5000
const FTP_PATH = 'APM/scripts/bench_check.lua'
// Present on every board regardless of storage: ArduPilot's virtual @SYS
// tree lives in RAM, so a download from it proves the FTP protocol path
// even when there's no card in the slot.
const FTP_VIRTUAL_PATH = '@SYS/uarts.txt'
// Below this, the bundled metadata is being generated from the wrong tree
// rather than merely lagging a firmware version.
const COVERAGE_FLOOR = 0.95
// POSIX ENOSPC. ArduPilot's FATFS layer reports it for every path under /
// when no microSD is mounted, which is how a card-less board presents.
const ERRNO_NO_STORAGE = 28

// Parameters we're willing to write and restore. Each is cosmetic on a
// bench board with nothing attached; we take the first one the board
// actually has so the check works across firmware versions.
const WRITABLE_CANDIDATES = ['NTF_LED_BRIGHT', 'LOG_BITMASK', 'SCHED_DEBUG']

interface Bench {
  session: MavLinkSession
  link: SerialLink
  send: (bytes: Uint8Array) => void
  sysid: number
}

type Outcome = 'pass' | 'fail' | 'skip'

const results: Array<{ name: string, outcome: Outcome, detail: string }> = []

// Record one check. `skip` is for a board that structurally can't answer
// the question (no card in the slot, no ESCs wired) — that's a bench
// condition, not a defect, and it must not read as a pass.
function record(name: string, outcome: Outcome, detail: string): void {
  results.push({ name, outcome, detail })
  const tag = outcome === 'pass' ? '  PASS' : outcome === 'fail' ? '  FAIL' : '  SKIP'
  console.log(`${tag}  ${name} — ${detail}`)
}

// Wait for the autopilot's next heartbeat and return the system id it
// came from. Also how we confirm a rebooted board is alive again.
function waitForHeartbeat(session: MavLinkSession, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error(`no heartbeat within ${timeoutMs}ms — is the board running firmware?`))
    }, timeoutMs)
    off = session.on((msg) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT) {
        clearTimeout(timer)
        off?.()
        resolve(msg.sysid)
      }
    })
  })
}

// Open the board, feed its bytes into a MavLinkSession, and wait for the
// first autopilot heartbeat so we know which system to address. The link
// is held for the whole run: it survives the reboot check by itself, the
// way the app's transport is meant to.
async function connect(): Promise<Bench> {
  const session = new MavLinkSession()
  const link = openSerialLink()
  link.onData(bytes => session.feed(bytes))
  const port = await link.ready()
  console.log(`[bench] ${port} open`)
  const sysid = await waitForHeartbeat(session, 10_000)
  return { session, link, send: bytes => link.write(bytes), sysid }
}

// Collect messages matching a predicate until `done` says stop or the
// timeout fires. The building block every check below shares.
function collect<T>(
  bench: Bench,
  onMessage: (msg: DecodedMessage, stop: (value: T) => void) => void,
  timeoutMs: number,
  onTimeout: () => T | Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      const outcome = onTimeout()
      if (outcome instanceof Error)
        reject(outcome)
      else resolve(outcome)
    }, timeoutMs)
    off = bench.session.on((msg) => {
      onMessage(msg, (value) => {
        clearTimeout(timer)
        off?.()
        resolve(value)
      })
    })
  })
}

// CHECK: identify. Ask for the boot banner and AUTOPILOT_VERSION so the
// report says exactly which board and build the rest of the run was
// measured against.
async function checkIdentify(bench: Bench): Promise<void> {
  const banners: string[] = []
  const collected = collect<Record<string, string>>(
    bench,
    (msg, stop) => {
      if (msg.msgid === MSGID_STATUSTEXT)
        banners.push(String((msg.data as { text: string }).text))
      if (msg.msgid === MSGID_AUTOPILOT_VERSION) {
        const d = msg.data as {
          flightSwVersion: number
          flightCustomVersion: ArrayLike<number>
          uid: bigint
          uid2: ArrayLike<number>
        }
        stop({
          version: decodeFirmwareVersion(d.flightSwVersion, d.flightCustomVersion),
          uid: formatFcUid(d.uid, d.uid2) ?? 'none',
        })
      }
    },
    8000,
    () => new Error('no AUTOPILOT_VERSION within 8s'),
  )

  bench.send(bench.session.serialize(buildDoSendBanner(bench.sysid, COMP_ID_AUTOPILOT)))
  await new Promise(r => setTimeout(r, 300))
  bench.send(bench.session.serialize(buildRequestMessage(bench.sysid, COMP_ID_AUTOPILOT, MSGID_AUTOPILOT_VERSION)))

  const info = await collected
  for (const b of banners) console.log(`        banner: ${b}`)
  record('identify', 'pass', `sysid=${bench.sysid} fw=${info.version} uid=${info.uid}`)
}

// CHECK: full parameter download. The app blocks its whole first screen
// on this, so its real duration and completeness over USB is a headline
// number. Dedupes by param index exactly as the param store does, and
// reports any index the board never sent.
async function checkParams(bench: Bench): Promise<Map<string, ParamRecord>> {
  const params = new Map<string, ParamRecord>()
  const seen = new Set<number>()
  const started = Date.now()
  let expected = 0

  // Stop on silence rather than on a total deadline, which is what the
  // app's param store does: ArduPilot dribbles a big set out over several
  // seconds, so elapsed time says nothing, but a long gap mid-stream means
  // the transfer has died.
  const done = new Promise<boolean>((resolve) => {
    let off: (() => void) | null = null
    let silence: ReturnType<typeof setTimeout> | null = null
    const finish = (complete: boolean): void => {
      if (silence)
        clearTimeout(silence)
      off?.()
      resolve(complete)
    }
    const armSilence = (): void => {
      if (silence)
        clearTimeout(silence)
      silence = setTimeout(finish, SILENCE_TIMEOUT_MS, false)
    }
    off = bench.session.on((msg) => {
      if (msg.msgid !== MSGID_PARAM_VALUE)
        return
      const pv = msg.data as { paramId: string, paramValue: number, paramType: number, paramIndex: number, paramCount: number }
      expected = pv.paramCount
      const name = pv.paramId.replace(/\0.*$/, '')
      if (!seen.has(pv.paramIndex)) {
        seen.add(pv.paramIndex)
        params.set(name, { name, value: pv.paramValue, type: pv.paramType, index: pv.paramIndex })
      }
      armSilence()
      if (pv.paramCount > 0 && seen.size >= pv.paramCount)
        finish(true)
    })
    armSilence()
  })

  bench.send(bench.session.serialize(buildParamRequestList(bench.sysid, COMP_ID_AUTOPILOT)))
  const complete = await done
  const elapsed = Date.now() - started

  const missing: number[] = []
  for (let i = 0; i < expected; i++) {
    if (!seen.has(i))
      missing.push(i)
  }

  record(
    'params',
    complete ? 'pass' : 'fail',
    complete
      ? `${params.size} params in ${(elapsed / 1000).toFixed(1)}s (${Math.round(params.size / (elapsed / 1000))}/s)`
      : `INCOMPLETE — got ${seen.size}/${expected} in ${(elapsed / 1000).toFixed(1)}s, missing ${missing.length} indices`,
  )
  return params
}

// CHECK: metadata coverage. Our bundled param-metadata.json is generated
// from the vendored SFD tree; a board on a different firmware version will
// have parameters it has never heard of. Those render in the param
// browser with no description, units or value labels, so the size of the
// gap is a real UX number, not trivia.
function checkMetadata(params: Map<string, ParamRecord>): void {
  const unknown: string[] = []
  for (const name of params.keys()) {
    if (!getParamMeta(name))
      unknown.push(name)
  }
  const described = params.size - unknown.length
  const pct = ((unknown.length / params.size) * 100).toFixed(1)
  // A board on a different firmware version will always have a handful of
  // parameters our vendored metadata predates, and those degrade
  // gracefully in the browser. A large gap means the metadata is built
  // from the wrong tree, which is a real defect.
  const examples = unknown.length > 0 ? `; ${unknown.slice(0, 8).join(', ')}` : ''
  record(
    'metadata',
    described / params.size >= COVERAGE_FLOOR ? 'pass' : 'fail',
    `${described}/${params.size} described (${pct}% undocumented)${examples}`,
  )
}

// CHECK: MAVLink FTP. Splits into two questions, because they have
// different answers on a board with an empty card slot. First, does the
// FTP protocol path work at all — proven by downloading from the virtual
// @SYS tree, which exists in RAM on every board. Second, does a
// read-write round trip work, which needs real storage and is what every
// Lua wizard depends on.
async function checkFtp(bench: Bench): Promise<void> {
  const ftp = new MavFtp(
    async (msg) => { bench.send(bench.session.serialize(msg)) },
    cb => bench.session.on(cb),
    bench.sysid,
    COMP_ID_AUTOPILOT,
  )

  await ftp.resetSessions()

  const virtualStart = Date.now()
  const sys = await ftp.downloadFile(FTP_VIRTUAL_PATH)
  record(
    'ftp-read',
    sys.byteLength > 0 ? 'pass' : 'fail',
    `${FTP_VIRTUAL_PATH}: ${sys.byteLength}B in ${Date.now() - virtualStart}ms`,
  )

  const payload = new TextEncoder().encode(
    `-- bench-check.ts fixture — ${new Date().toISOString()}\n`
    + `${'-- filler line so the upload spans several 239-byte FTP frames\n'.repeat(10)}`,
  )

  try {
    // A board with no scripts yet has no APM/scripts/; FileExists (8) just
    // means a previous run already made it.
    for (const dir of ['APM', 'APM/scripts']) {
      await ftp.createDirectory(dir).catch((e) => {
        if (e instanceof MavFtpError && e.errCode === 8)
          return
        throw e
      })
    }
    // FileNotFound (10) is the expected case on a first run.
    await ftp.removeFile(FTP_PATH).catch((e) => {
      if (e instanceof MavFtpError && e.errCode === 10)
        return
      throw e
    })

    const started = Date.now()
    await ftp.uploadFile(FTP_PATH, payload)
    const uploaded = Date.now() - started
    const got = await ftp.downloadFile(FTP_PATH)
    const elapsed = Date.now() - started

    if (got.byteLength !== payload.byteLength)
      throw new Error(`size mismatch: wrote ${payload.byteLength}, read ${got.byteLength}`)
    for (let i = 0; i < payload.byteLength; i++) {
      if (got[i] !== payload[i])
        throw new Error(`byte ${i} differs`)
    }
    await ftp.removeFile(FTP_PATH)

    record('ftp-write', 'pass', `${payload.byteLength}B round-trip ok (up ${uploaded}ms, down ${elapsed - uploaded}ms)`)
  }
  catch (e) {
    if (e instanceof MavFtpError && e.errno === ERRNO_NO_STORAGE) {
      record('ftp-write', 'skip', 'no writable filesystem — board has no microSD card mounted')
      return
    }
    throw e
  }
}

// CHECK: parameter write + persist + read back, then restore. Exercises
// the PARAM_SET / PARAM_VALUE-echo ack path the settings and wizard code
// all sit on, including the PREFLIGHT_STORAGE save that makes a change
// survive reboot.
async function checkParamWrite(bench: Bench, params: Map<string, ParamRecord>): Promise<void> {
  const name = WRITABLE_CANDIDATES.find(c => params.has(c))
  if (!name) {
    record('paramwrite', 'skip', `none of ${WRITABLE_CANDIDATES.join('/')} present on this board`)
    return
  }
  const original = params.get(name)!
  const probe = original.value === 1 ? 2 : 1

  // Set a value, wait for the FC to echo it back — that echo is the ack.
  const setAndConfirm = async (value: number): Promise<number> => {
    const echoed = collect<number>(
      bench,
      (msg, stop) => {
        if (msg.msgid !== MSGID_PARAM_VALUE)
          return
        const pv = msg.data as { paramId: string, paramValue: number }
        if (pv.paramId.replace(/\0.*$/, '') === name)
          stop(pv.paramValue)
      },
      5000,
      () => new Error(`no PARAM_VALUE echo for ${name} within 5s`),
    )
    bench.send(bench.session.serialize(buildParamSet(bench.sysid, COMP_ID_AUTOPILOT, name, value, original.type)))
    return echoed
  }

  try {
    const got = await setAndConfirm(probe)
    bench.send(bench.session.serialize(buildPreflightStorageSave(bench.sysid, COMP_ID_AUTOPILOT)))
    await new Promise(r => setTimeout(r, 500))
    record('paramwrite', got === probe ? 'pass' : 'fail', `${name}: ${original.value} → ${probe}, FC echoed ${got}`)
  }
  finally {
    // Always put the board back the way we found it, even if the check
    // above threw partway through.
    await setAndConfirm(original.value).catch(() => {})
    bench.send(bench.session.serialize(buildPreflightStorageSave(bench.sysid, COMP_ID_AUTOPILOT)))
    await new Promise(r => setTimeout(r, 500))
    console.log(`        restored ${name} = ${original.value}`)
  }
}

// CHECK: reboot and re-enumeration. The one thing SITL structurally
// cannot test — a real board's USB device disappears and comes back, and
// every reboot-then-reconnect flow in the app (settings toggles, frame
// changes, firmware flash) depends on tolerating that gap. Measures how
// long the device is actually away and whether it heartbeats afterwards.
async function checkReboot(bench: Bench): Promise<void> {
  const started = Date.now()
  // Subscribe before sending, or a fast board can reopen before we're
  // listening and the check hangs waiting for an event already past.
  const reopened = bench.link.nextOpen(60_000)
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))

  const port = await reopened
  const backAt = Date.now() - started
  const sysid = await waitForHeartbeat(bench.session, 20_000)
  record(
    'reboot',
    sysid === bench.sysid ? 'pass' : 'fail',
    `${port} back in ${backAt}ms, heartbeat from sysid=${sysid} at ${Date.now() - started}ms`,
  )
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const wants = (name: string): boolean => requested.length === 0 || requested.includes(name)

  console.log(`[bench] connecting…`)
  const bench = await connect()

  if (wants('identify'))
    await checkIdentify(bench)

  let params = new Map<string, ParamRecord>()
  if (wants('params') || wants('metadata') || wants('paramwrite'))
    params = await checkParams(bench)
  if (wants('metadata'))
    checkMetadata(params)
  if (wants('ftp'))
    await checkFtp(bench)
  if (wants('paramwrite'))
    await checkParamWrite(bench, params)
  if (wants('reboot'))
    await checkReboot(bench)

  bench.link.close()

  const failed = results.filter(r => r.outcome === 'fail')
  const skipped = results.filter(r => r.outcome === 'skip')
  const passed = results.length - failed.length - skipped.length
  const skipNote = skipped.length > 0 ? `, ${skipped.length} skipped` : ''
  const failNote = failed.length > 0 ? `, ${failed.length} FAILED` : ''
  console.log(`\n[bench] ${passed}/${results.length} passed${skipNote}${failNote}`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`[bench] FAIL: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
