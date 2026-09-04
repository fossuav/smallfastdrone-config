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

// Capture the connected drone's configuration as a backup document.
//
// Shared by the drone-settings page and the exit ceremony, which both need
// exactly this and neither of which should own it: the exit ceremony's
// backup is the operator's only way back from a mass erase, so it must be
// the same code that has been exercised on the settings page rather than a
// second implementation that looks similar.
//
// The pure half - what a backup contains and how it is rendered - lives in
// param-backup.ts and is unit-tested there. This is the I/O around it.

import type { ParamBackup } from './param-backup'
import { MavFtp } from '../protocol/ftp'
import { changedParamNames, parseParamPack } from '../protocol/param-pack'
import { isParamReadOnly } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { buildBackup } from './param-backup'

const COMP_ID_AUTOPILOT = 1
// The firmware's own account of which parameters differ from its factory
// defaults. The only authoritative source: defaults are board- and
// frame-specific, and the parameter metadata carries none at all.
const PARAM_PACK_PATH = '@PARAM/param.pck?withdefaults=1'

export function useSettingsBackup() {
  const session = useSessionStore()
  const params = useParamsStore()

  // Ask the drone which parameters it considers changed from default.
  async function fetchChangedNames(): Promise<Set<string>> {
    const sysid = session.sysid
    if (sysid === null)
      throw new Error('Connect to your drone first.')
    const ftp = new MavFtp(session.sendMessage, session.subscribeMessages, sysid, COMP_ID_AUTOPILOT)
    // Free any FTP slot a previous fetch left tied up; the firmware
    // doesn't release them on its own and a second fetch would fail on
    // OpenFileRO.
    await ftp.resetSessions()
    return changedParamNames(parseParamPack(await ftp.downloadFile(PARAM_PACK_PATH)))
  }

  // Build the backup document for the connected drone. Throws with an
  // operator-readable message if the drone can't answer - a caller about
  // to do something destructive must treat that as a full stop.
  async function capture(): Promise<ParamBackup> {
    const sysid = session.sysid
    if (sysid === null)
      throw new Error('Connect to your drone first.')
    const changed = await fetchChangedNames()
    return buildBackup(
      params.params,
      {
        sysid,
        firmwareVersion: session.firmwareVersion,
        frameLabel: session.vehicleLabel,
        uid: session.fcUid,
      },
      new Date().toISOString(),
      { changed, isReadOnly: isParamReadOnly },
    )
  }

  return { capture, fetchChangedNames }
}
