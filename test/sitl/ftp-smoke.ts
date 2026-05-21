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

// MAVLink FTP smoke test. Connects directly to a running SITL on
// SITL_HOST:SITL_PORT (defaults to 127.0.0.1:5760), waits for a
// heartbeat to learn the target system id, then runs an end-to-end
// FTP upload → download → verify → delete → confirm-deleted cycle
// against APM/scripts/ftp_smoke_test.lua. Exits non-zero on any
// mismatch or unexpected error.
//
// Run after starting SITL:
//   bun run sitl:start
//   bun run ftp:smoke
//
// This is a standalone smoke check — not part of the Playwright suite
// because it talks raw TCP without the browser / bridge. Its job is
// to validate the FTP protocol layer against SITL before the wizard
// runtime depends on it.

import type { Socket } from 'bun'
import type { MessageHandler } from '../../src/protocol/mavlink'
import { MavFtp, MavFtpError } from '../../src/protocol/ftp'
import { MavLinkSession } from '../../src/protocol/mavlink'

const SITL_HOST = process.env.SITL_HOST ?? '127.0.0.1'
const SITL_PORT = Number(process.env.SITL_PORT ?? 5760)
const REMOTE_PATH = 'APM/scripts/ftp_smoke_test.lua'

// Contents we'll round-trip through the FC. Sized at ~500 bytes so the
// upload spans two FTP frames (one per 239-byte chunk) and exercises
// the chunking path, not just the single-frame happy case.
const PAYLOAD = new TextEncoder().encode(
  `-- ftp-smoke.ts fixture — uploaded ${new Date().toISOString()}\n`
  + `-- Should round-trip byte-for-byte through MAVLink FTP.\n`
  + `${'-- filler line that exists only to push us past 239 bytes so we test chunking\n'.repeat(8)}`,
)

async function main(): Promise<void> {
  console.log(`[ftp-smoke] connecting to SITL at ${SITL_HOST}:${SITL_PORT}`)

  const session = new MavLinkSession()
  let socket: Socket | null = null

  // Bun TCP connect — small handler that pipes bytes into the session.
  const connectPromise = new Promise<Socket>((resolve, reject) => {
    Bun.connect({
      hostname: SITL_HOST,
      port: SITL_PORT,
      socket: {
        open(s) { resolve(s) },
        data(_s, data) {
          session.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        },
        error(_s, err) { reject(err) },
        close() {},
      },
    }).catch(reject)
  })
  socket = await connectPromise

  // Wait for the first heartbeat so we know which sysid to target.
  // SITL replies almost immediately; 10s is generous insurance against
  // a slow / cold start.
  const sysid = await waitForHeartbeat(session, 10_000)
  console.log(`[ftp-smoke] heartbeat from sysid=${sysid}`)

  const ftp = new MavFtp(
    async (msg) => { socket?.write(session.serialize(msg)) },
    cb => session.on(cb),
    sysid,
    1, // MAV_COMP_ID_AUTOPILOT1
  )

  // Reset sessions in case a previous run left one open.
  console.log(`[ftp-smoke] reset sessions`)
  await ftp.resetSessions()

  // Make sure the target directory tree exists. A fresh SITL working
  // directory has neither APM/ nor APM/scripts/ — without these, the
  // CreateFile below would fail with FileNotFound. Swallow FileExists
  // (8) so re-runs against an already-prepared SITL keep working.
  console.log(`[ftp-smoke] ensure APM/ and APM/scripts/ exist`)
  for (const dir of ['APM', 'APM/scripts']) {
    await ftp.createDirectory(dir).catch((e) => {
      if (e instanceof MavFtpError && e.errCode === 8)
        return
      throw e
    })
  }

  // Pre-clean — ignore FileNotFound from a fresh SITL.
  console.log(`[ftp-smoke] pre-clean ${REMOTE_PATH}`)
  await ftp.removeFile(REMOTE_PATH).catch((e) => {
    if (e instanceof MavFtpError && e.errCode === 10)
      return
    throw e
  })

  console.log(`[ftp-smoke] upload ${PAYLOAD.byteLength} bytes`)
  await ftp.uploadFile(REMOTE_PATH, PAYLOAD)

  console.log(`[ftp-smoke] download`)
  const got = await ftp.downloadFile(REMOTE_PATH)

  if (got.byteLength !== PAYLOAD.byteLength) {
    throw new Error(`size mismatch: wrote ${PAYLOAD.byteLength}, read ${got.byteLength}`)
  }
  for (let i = 0; i < PAYLOAD.byteLength; i++) {
    if (got[i] !== PAYLOAD[i])
      throw new Error(`byte ${i} mismatch: wrote 0x${PAYLOAD[i]!.toString(16)}, read 0x${got[i]!.toString(16)}`)
  }
  console.log(`[ftp-smoke] download verified — ${got.byteLength} bytes match`)

  console.log(`[ftp-smoke] delete`)
  await ftp.removeFile(REMOTE_PATH)

  console.log(`[ftp-smoke] confirm deleted`)
  try {
    await ftp.downloadFile(REMOTE_PATH)
    throw new Error(`file still readable after RemoveFile`)
  }
  catch (e) {
    if (!(e instanceof MavFtpError) || e.errCode !== 10) {
      throw e
    }
    console.log(`[ftp-smoke] confirmed FileNotFound after delete`)
  }

  console.log(`[ftp-smoke] PASS`)
  socket?.end()
}

// Wait until the first HEARTBEAT arrives and return the sender's sysid.
// Times out with a clear message rather than hanging forever if SITL
// isn't actually running on the target port.
function waitForHeartbeat(session: MavLinkSession, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null
    const timer = setTimeout(() => {
      unsubscribe?.()
      reject(new Error(`no heartbeat within ${timeoutMs}ms — is SITL running on ${SITL_HOST}:${SITL_PORT}?`))
    }, timeoutMs)

    const handler: MessageHandler = (msg) => {
      // Heartbeat msgid is 0.
      if (msg.msgid !== 0)
        return
      unsubscribe?.()
      clearTimeout(timer)
      resolve(msg.sysid)
    }
    unsubscribe = session.on(handler)
  })
}

main().catch((e) => {
  console.error(`[ftp-smoke] FAIL: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
