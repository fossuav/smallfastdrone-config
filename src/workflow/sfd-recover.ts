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

// The exit ceremony: getting a customer's drone back out of SFD, whole.
//
// This is the escape hatch, and docs/SECURITY.md is explicit that it must
// be as polished as the way in. The silicon dictates the shape - dropping
// readout protection triggers a mass erase, destroying the firmware, the
// bootloader and the identity key together - so seamlessness can only come
// from what we save and put back around it.
//
// The pieces already existed separately: the backup and restore (T5), and
// the DFU read-unprotect (T4). What was missing, and what this is, is the
// sequencing - and the sequencing is where the safety lives:
//
//   1. capture the drone's settings
//   2. the operator confirms they have the file
//   3. unlock, which mass-erases                    <- destructive
//   4. flash a complete image over DFU              <- chip is blank
//   5. wait for the drone, then put the settings back
//
// **Nothing destructive may run until the operator holds their backup.**
// Step 3 onwards cannot be undone, and a drone that is erased with the
// backup still sitting unsaved in a browser tab is a drone whose
// configuration is simply gone. That ordering is the whole point of this
// module, so it is asserted rather than assumed, and every outcome -
// success or failure - carries the backup so it can be re-offered.
//
// Two things this deliberately does not do. It does not offer the
// firmware-initiated unlock (a BRD_OPTIONS bit), because that firmware
// does not exist yet - F6. And it does not put the drone into DFU: signed
// firmware refuses that request by design, so the operator does it with
// the board's own BOOT0 pads and the driver waits for the device.
//
// Pure and injectable, like runEnableCeremony: the drone lives behind
// `RecoveryDriver` so the ordering can be tested without a board.

import type { ParamBackup, RestorePlan } from './param-backup'

export type RecoverPhase
  = | 'backing-up'
    | 'awaiting-save'
    | 'awaiting-dfu'
    | 'unlocking'
    | 'flashing'
    | 'reconnecting'
    | 'restoring'
    | 'done'

export type RecoverFailure
  // Couldn't read the drone's settings, so there is nothing safe to do.
  = | 'backup-failed'
    // The operator didn't confirm they saved it. Not an error - a refusal
    // to continue, and the right one.
    | 'backup-not-saved'
    // The drone never appeared in DFU mode.
    | 'no-dfu-device'
    // The unlock didn't take. The drone may or may not have been erased.
    | 'unlock-failed'
    // The chip is blank and the new image didn't land. This is the one
    // that leaves a drone that will not boot.
    | 'flash-failed'
    // Flashed, but it never came back on the link.
    | 'no-drone-after-flash'
    // Came back, but the settings couldn't be written.
    | 'restore-failed'

export class RecoverError extends Error {
  constructor(
    public readonly reason: RecoverFailure,
    message: string,
    // Whatever we managed to capture, always. An operator who has lost
    // their drone's configuration because we swallowed it on the way to
    // reporting a different failure has been failed twice.
    public readonly backup: ParamBackup | null = null,
    // True once something irreversible has happened, so a view can say
    // "your drone needs finishing" rather than "nothing happened".
    public readonly destructive: boolean = false,
  ) {
    super(message)
    this.name = 'RecoverError'
  }
}

// What the ceremony needs from the outside world. The driver owns the
// devices and the operator prompts; this module owns only the order.
export interface RecoveryDriver {
  // Read the drone's current settings into a backup document.
  captureBackup: () => Promise<ParamBackup>
  // Put the backup in the operator's hands. Resolves true only once they
  // have it - a download that was offered is not a download that happened.
  confirmBackupSaved: (backup: ParamBackup) => Promise<boolean>
  // Wait for the operator to put the board into DFU by hand. False if
  // they gave up. Signed firmware refuses to do this over the link.
  awaitDfuDevice: () => Promise<boolean>
  // Drop readout protection. The chip mass-erases and resets itself.
  unlock: () => Promise<void>
  // Write a complete image - bootloader and firmware - to the blank chip.
  flashWithBootloader: () => Promise<void>
  // Wait for the drone to talk again after the flash.
  awaitDrone: () => Promise<boolean>
  // Write the saved settings back, reporting what actually happened.
  restore: (backup: ParamBackup) => Promise<RestorePlan>
}

export interface RecoverOutcome {
  backup: ParamBackup
  // What the restore managed. `notReverted` and `missing` are the honest
  // part: a delta backup cannot put back a setting it never recorded, and
  // a parameter can vanish between firmware versions.
  restored: RestorePlan
}

// Run the ceremony. Rejects with RecoverError naming where it stopped and
// carrying the backup, which the caller must keep offering to the operator.
export async function runExitCeremony(
  driver: RecoveryDriver,
  onPhase: (phase: RecoverPhase) => void = () => {},
): Promise<RecoverOutcome> {
  onPhase('backing-up')
  let backup: ParamBackup
  try {
    backup = await driver.captureBackup()
  }
  catch (e) {
    throw new RecoverError(
      'backup-failed',
      `Couldn't read your drone's settings, so we've stopped before changing anything. ${message(e)}`,
      null,
      false,
    )
  }

  // The gate. Everything past here is irreversible, so it is not enough to
  // have offered the file - the operator has to say they have it.
  onPhase('awaiting-save')
  if (!await driver.confirmBackupSaved(backup)) {
    throw new RecoverError(
      'backup-not-saved',
      'Save your drone\'s settings before going on. Everything after this wipes the drone, and this file is the only way to put it back.',
      backup,
      false,
    )
  }

  onPhase('awaiting-dfu')
  if (!await driver.awaitDfuDevice()) {
    throw new RecoverError(
      'no-dfu-device',
      'Your drone didn\'t appear in update mode, so nothing has been changed.',
      backup,
      false,
    )
  }

  onPhase('unlocking')
  try {
    await driver.unlock()
  }
  catch (e) {
    // The erase may or may not have run, so this cannot claim the drone is
    // untouched.
    throw new RecoverError('unlock-failed', `Couldn't unlock your drone. ${message(e)}`, backup, true)
  }

  onPhase('flashing')
  try {
    await driver.flashWithBootloader()
  }
  catch (e) {
    throw new RecoverError(
      'flash-failed',
      `Your drone was wiped but the new software didn't finish installing, so it won't start up yet. Keep it plugged in and try again. ${message(e)}`,
      backup,
      true,
    )
  }

  onPhase('reconnecting')
  if (!await driver.awaitDrone()) {
    throw new RecoverError(
      'no-drone-after-flash',
      'The new software was installed but your drone hasn\'t come back yet. Reconnect it, then put your settings back from the saved file.',
      backup,
      true,
    )
  }

  onPhase('restoring')
  let restored: RestorePlan
  try {
    restored = await driver.restore(backup)
  }
  catch (e) {
    throw new RecoverError(
      'restore-failed',
      `Your drone is working again, but its settings couldn't be put back. You still have the file - try restoring it from the Settings page. ${message(e)}`,
      backup,
      true,
    )
  }

  onPhase('done')
  return { backup, restored }
}

// Whether an operator still has something to do after the ceremony
// finished. A restore that silently dropped settings is not a success
// worth reporting as one.
export function hasUnfinishedBusiness(outcome: RecoverOutcome): boolean {
  return outcome.restored.missing.length > 0 || outcome.restored.notReverted.length > 0
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
