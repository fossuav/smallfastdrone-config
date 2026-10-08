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

// Installing a script product (PLAN decision 46) — the courier half.
//
// SITL cannot run what it is given here: its build has no encryption, so
// it ignores `.lxa` files entirely, and nothing can show a product
// running except a signed board. What SITL can show is everything the
// tool is responsible for: a package for another drone refused before
// anything is sent, and one for this drone landing every file in the
// folder its packing list names, with a leftover plaintext module of
// the same name removed so it cannot shadow the scrambled one.
//
// The checks read SITL's own working folder, which sitl-start.sh records,
// so this spec has nothing to look at on a bench board and skips there.
//
// The picker only appears once scripting is on, so this spec turns it on
// if it has to — and specs share one SITL and run in file-name order.
// settings-scripting.spec.ts needs scripting off when it starts, so this
// file's name must sort after it.

import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'
const WORKDIR_FILE = '/tmp/sfd-sitl.pid.workdir'

const MEMBERS = ['e2e_product.lxa', 'e2e_product.lua', 'modules/e2e_helper.lxa', 'modules/e2e_helper.lua']

// The 12-byte drone uid SITL reports, as lower-case hex. SITL fills
// AUTOPILOT_VERSION's uid2 from the first 17 characters of the host's
// machine-id, falling back to its hostname (AP_HAL_SITL/Util.cpp,
// get_system_id_unformatted), and a bundle is addressed by the first 12.
function sitlUid(): string {
  let id: string | null = null
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      id = readFileSync(path, 'latin1').slice(0, 17).split('\n')[0]!
      break
    }
    catch {}
  }
  const bytes = Buffer.alloc(12)
  bytes.write((id ?? hostname()).slice(0, 12), 'latin1')
  return bytes.toString('hex')
}

// A .lxa addressed to uid: the header at the firmware's offsets, then
// filler where ciphertext would be. SITL never tries to open it.
function lxa(uid: string): Buffer {
  return Buffer.concat([Buffer.from('LXA2.0'), Buffer.from(uid, 'hex'), Buffer.alloc(72, 0xAB), Buffer.alloc(32, 0xCD)])
}

// A two-file product as pack_lua.py lays one out.
function bundle(uid: string): { json: Buffer, app: Buffer } {
  const app = lxa(uid)
  const json = Buffer.from(JSON.stringify({
    schema: 'sfd-bundle/1',
    product: 'e2e_product',
    title: 'E2E product',
    uid,
    files: [
      { path: 'scripts/e2e_product.lxa', data: app.toString('base64') },
      { path: 'scripts/modules/e2e_helper.lxa', data: lxa(uid).toString('base64') },
    ],
  }))
  return { json, app }
}

test('a script product lands where its packing list says, and only on its own drone', async ({ page }) => {
  test.skip(Boolean(process.env.BENCH), 'reads SITL\'s working folder, which a bench board does not have')
  test.setTimeout(150_000)

  const scripts = join(readFileSync(WORKDIR_FILE, 'utf8').trim(), 'APM', 'scripts')
  const clean = (): void => {
    for (const m of MEMBERS)
      rmSync(join(scripts, m), { force: true })
  }
  clean()
  // A leftover plaintext module of the same name, as another installer
  // could have left it: the scrambled one must not sit behind it.
  mkdirSync(join(scripts, 'modules'), { recursive: true })
  writeFileSync(join(scripts, 'modules', 'e2e_helper.lua'), 'return {}\n')

  try {
    await page.goto(SITL_URL)
    await page.getByRole('button', { name: 'Connect drone' }).click()
    await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })
    await page.getByRole('link', { name: 'On the radio' }).click()

    // The picker is offered once scripting is on.
    const installOne = page.getByRole('button', { name: 'Install one…' })
    const turnOn = page.getByRole('button', { name: 'Turn on' })
    await expect(installOne.or(turnOn)).toBeVisible({ timeout: 30_000 })
    if (await turnOn.isVisible()) {
      await turnOn.click()
      await expect(installOne).toBeVisible({ timeout: 90_000 })
    }
    const picker = page.locator('input[type="file"][accept*=".sfdbundle"]')

    // Another drone's package: refused by name, and nothing is sent.
    await picker.setInputFiles({ name: 'other.sfdbundle', mimeType: 'application/json', buffer: bundle('aabbccddeeff001122334455').json })
    await expect(page.getByText(/made for a different drone/)).toBeVisible({ timeout: 15_000 })
    expect(existsSync(join(scripts, 'e2e_product.lxa'))).toBe(false)

    // This drone's: every file where the packing list put it.
    const mine = bundle(sitlUid())
    await picker.setInputFiles({ name: 'e2e_product.sfdbundle', mimeType: 'application/json', buffer: mine.json })
    await expect(page.getByText('E2E product is on your drone. It will run from now on. '
      + 'It replaced an unscrambled e2e_helper.lua that would have got in its way.')).toBeVisible({ timeout: 60_000 })
    expect(readFileSync(join(scripts, 'e2e_product.lxa')).equals(mine.app)).toBe(true)
    expect(existsSync(join(scripts, 'modules', 'e2e_helper.lxa'))).toBe(true)
    expect(existsSync(join(scripts, 'modules', 'e2e_helper.lua'))).toBe(false)
  }
  finally {
    clean()
  }
})
