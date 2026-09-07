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

// The operator's owner key, as a view holds it. Two places need the same
// key for opposite reasons — the enable wizard writes its public half
// into a drone, the logs view opens what that drone recorded — and they
// must agree on which key is loaded, so the loading lives here rather
// than in either of them.
//
// What is held is a browser key that cannot be read back; see
// owner-key.ts. The file the operator picked is never kept: it is their
// backup, and the only copy that outlives this browser.

import type { OwnerKey } from './owner-key'
import { ref } from 'vue'
import { importOwnerKey, ownerFingerprint, parseOwnerKeyFile } from './owner-key'
import { indexedDbOwnerKeyStore } from './owner-key-store'

export function useOwnerKey() {
  const ownerKey = ref<OwnerKey | null>(null)
  // A short label so an operator can tell this is the key they meant
  // without reading 64 hex characters.
  const ownerLabel = ref<string | null>(null)
  const ownerError = ref<string | null>(null)
  const store = indexedDbOwnerKeyStore()

  async function remember(key: OwnerKey | null): Promise<void> {
    ownerKey.value = key
    ownerLabel.value = key === null ? null : await ownerFingerprint(key.publicKey)
  }

  // Pick up a key imported in an earlier session.
  async function loadOwnerKey(): Promise<void> {
    await remember(await store.load())
  }

  async function importOwnerKeyFile(text: string): Promise<boolean> {
    ownerError.value = null
    try {
      const key = await importOwnerKey(parseOwnerKeyFile(text))
      await store.save(key)
      await remember(key)
      return true
    }
    catch (e) {
      ownerError.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function forgetOwnerKey(): Promise<void> {
    await store.forget()
    await remember(null)
  }

  return { ownerKey, ownerLabel, ownerError, loadOwnerKey, importOwnerKeyFile, forgetOwnerKey }
}
