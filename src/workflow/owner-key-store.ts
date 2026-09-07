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

// Where the imported owner key sits between sessions.
//
// IndexedDB, because a non-extractable CryptoKey can be stored there
// directly and comes back still able to perform the agreement while
// still refusing to be exported. localStorage cannot hold one at all -
// it would mean holding the bytes, which is the thing decision 37
// exists to avoid.
//
// This copy is a convenience, never the original. The file the offline
// generator wrote is the backup; clearing site data throws this away and
// the operator imports it again. Anything here that implies otherwise
// would be telling an operator their only copy is safe when it is one
// browser setting away from gone.

import type { OwnerKey } from './owner-key'

const DB_NAME = 'sfd-owner-key'
const DB_VERSION = 1
const STORE = 'key'
const RECORD = 'owner'

// Kept behind an interface so the ceremony and the views can be tested
// without a browser, and so a different custody mechanism later is a new
// implementation rather than an edit everywhere.
export interface OwnerKeyStore {
  load: () => Promise<OwnerKey | null>
  save: (key: OwnerKey) => Promise<void>
  forget: () => Promise<void>
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Couldn\'t open local storage.'))
  })
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = work(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Local storage refused.'))
  })
}

// The real store. Failures resolve to "no key" rather than throwing:
// a browser with storage disabled should send the operator to the import
// step, not to an error page.
export function indexedDbOwnerKeyStore(): OwnerKeyStore {
  return {
    async load(): Promise<OwnerKey | null> {
      try {
        const db = await open()
        const record = await run<OwnerKey | undefined>(db, 'readonly', s => s.get(RECORD))
        db.close()
        return record ?? null
      }
      catch {
        return null
      }
    },
    async save(key: OwnerKey): Promise<void> {
      const db = await open()
      await run(db, 'readwrite', s => s.put(key, RECORD))
      db.close()
    },
    async forget(): Promise<void> {
      try {
        const db = await open()
        await run(db, 'readwrite', s => s.delete(RECORD))
        db.close()
      }
      catch {
        // nothing stored, or no storage to clear
      }
    },
  }
}

// For tests and for a session that deliberately holds a key only until
// it is closed.
export function memoryOwnerKeyStore(): OwnerKeyStore {
  let held: OwnerKey | null = null
  return {
    load: async () => held,
    save: async (key) => { held = key },
    forget: async () => { held = null },
  }
}
