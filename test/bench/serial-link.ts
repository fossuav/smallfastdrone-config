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

// Bench serial link — opens a real flight controller's serial port and
// exposes it as bytes-in / bytes-out. The counterpart to `Bun.connect` in
// the SITL harnesses: where those talk TCP to a simulated vehicle, this
// talks to the actual board on the bench.
//
// Bun has no serial API, so the port is owned by a small helper process
// (`com-pipe.py`) that pipes it to stdio. On WSL that helper runs under
// *Windows* Python against the COM port directly, rather than attaching
// the board to Linux with usbipd: a board that reboots re-enumerates,
// usbipd silently drops the WSL attachment, and the character device
// never returns. Windows keeps the COM number stable across a reboot,
// which is what makes the reboot / reconnect check possible at all.
//
// The helper reopens the port by itself after it drops, so a reboot
// surfaces here as a `close` event followed by an `open` event on the
// same link — no teardown, no re-spawn.
//
// This is test-path code. Production reaches a board through
// WebSerialTransport and nothing else — see docs/TESTING.md.

import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Windows Python, because it's the side that can see the COM port. On a
// native-Linux bench set BENCH_PYTHON=python3 and the same helper drives
// /dev/ttyACM0 through pyserial unchanged.
const BENCH_PYTHON = process.env.BENCH_PYTHON ?? 'python.exe'
// Which port to open. Unset means "find the board by USB VID:PID", which
// is what you want unless two boards are plugged in.
const BENCH_PORT = process.env.BENCH_PORT

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'com-pipe.py')

export interface SerialLink {
  // The port the helper actually opened, once it reports one.
  readonly port: string | null
  // Push bytes at the board. Dropped, not queued, while the port is down.
  write: (bytes: Uint8Array) => void
  // Subscribe to bytes arriving from the board. Returns an unsubscribe fn.
  onData: (cb: (bytes: Uint8Array) => void) => () => void
  // Fires on every open, including the reopen after a reboot.
  onOpen: (cb: (port: string) => void) => () => void
  // Fires when the port drops (reboot, unplug).
  onClose: (cb: () => void) => () => void
  // Resolve once the port is open — immediately if it already is.
  ready: (timeoutMs?: number) => Promise<string>
  // Resolve on the *next* open, ignoring the current one. This is how the
  // reboot check times a re-enumeration.
  nextOpen: (timeoutMs?: number) => Promise<string>
  close: () => void
}

// Convert a WSL path to the Windows form the helper's interpreter needs.
// A no-op when BENCH_PYTHON is a Linux interpreter.
function helperPath(): string {
  if (!BENCH_PYTHON.endsWith('.exe'))
    return HELPER
  const r = Bun.spawnSync(['wslpath', '-w', HELPER])
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : HELPER
}

// Spawn the helper and start pumping bytes. Throws only if the helper
// itself can't start; a board that isn't plugged in yet is not an error,
// the helper just waits for it (see `ready`).
export function openSerialLink(port: string | undefined = BENCH_PORT): SerialLink {
  const args = [BENCH_PYTHON, helperPath()]
  if (port)
    args.push(port)

  const proc = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // python.exe warns and defaults to the Windows directory when its cwd
    // is a WSL path; give it one it can actually represent so that warning
    // never lands in the status stream.
    cwd: BENCH_PYTHON.endsWith('.exe') ? '/mnt/c' : undefined,
  })

  const dataCbs = new Set<(bytes: Uint8Array) => void>()
  const openCbs = new Set<(port: string) => void>()
  const closeCbs = new Set<() => void>()
  let openPort: string | null = null
  let stopped = false

  // Board bytes.
  void (async () => {
    for await (const chunk of proc.stdout) {
      for (const cb of dataCbs) cb(chunk)
    }
  })()

  // Status lines. The helper is line-oriented on stderr precisely so
  // stdout can stay pure binary.
  void (async () => {
    let pending = ''
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (text.startsWith('open ')) {
          openPort = text.slice(5)
          for (const cb of openCbs) cb(openPort)
        }
        else if (text.startsWith('closed')) {
          openPort = null
          for (const cb of closeCbs) cb()
        }
        else if (text.length > 0) {
          console.error(`[serial-link] ${text}`)
        }
      }
    }
  })()

  // Resolve on the next open event, with a deadline. Shared by `ready`
  // and `nextOpen`; the difference is only whether an already-open port
  // short-circuits it.
  const awaitOpen = (timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      let off: (() => void) | null = null
      const timer = setTimeout(() => {
        off?.()
        reject(new Error(
          `board did not appear within ${timeoutMs}ms`
          + `${port ? ` on ${port}` : ' (no ArduPilot USB device found)'}`,
        ))
      }, timeoutMs)
      off = ((): (() => void) => {
        const cb = (p: string): void => {
          clearTimeout(timer)
          off?.()
          resolve(p)
        }
        openCbs.add(cb)
        return () => openCbs.delete(cb)
      })()
    })

  return {
    get port() {
      return openPort
    },
    write(bytes) {
      if (stopped)
        return
      proc.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      void proc.stdin.flush()
    },
    onData(cb) {
      dataCbs.add(cb)
      return () => dataCbs.delete(cb)
    },
    onOpen(cb) {
      openCbs.add(cb)
      return () => openCbs.delete(cb)
    },
    onClose(cb) {
      closeCbs.add(cb)
      return () => closeCbs.delete(cb)
    },
    async ready(timeoutMs = 15_000) {
      return openPort ?? await awaitOpen(timeoutMs)
    },
    nextOpen(timeoutMs = 60_000) {
      return awaitOpen(timeoutMs)
    },
    close() {
      stopped = true
      proc.kill()
    },
  }
}
