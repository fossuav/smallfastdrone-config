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

// Hand a generated file to the operator. A DOM concern, so it lives in
// ui/ and is only ever called from a view.
//
// Shared because three surfaces produce a file the operator must keep -
// the settings backup, the drone identity, and the exit ceremony's
// backup - and a browser download is fiddly enough (object URL, synthetic
// anchor, revoke) to be worth writing once.

// Trigger a download of `text` under `filename`.
export function downloadText(text: string, filename: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
