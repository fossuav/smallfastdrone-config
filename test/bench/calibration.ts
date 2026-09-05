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

// Bench proof for the restore-path calibration force-save.
//
// A settings backup carries calibration *values* (INS_ACCOFFS_*,
// INS_ACCSCAL_*, COMPASS_OFS_*) but not the sensor *ids* that tell the
// drone those values belong to the sensors it currently has - the ids are
// read-only, so the backup correctly drops them. After a parameter erase
// and a restore, the drone therefore holds a good calibration it does not
// believe in, and refuses to arm. src/workflow/param-backup.ts's
// restoreTouchesCalibration() plus buildForceSaveCalibration() is the fix;
// this script is the evidence it works.
//
// It has to run on hardware. AP_InertialSensor::register_accel() sets the
// detected id in RAM but never saves it, so _accel_id_ok stays false after
// an erase - except under a SITL-only block that forces it true. The bug
// this proves is therefore invisible to SITL by construction.
//
// Phases are separate commands because the board reboots between several
// of them and two need the operator's hands:
//
//   bun run bench:calibration state      # what the drone believes now
//   bun run bench:calibration gyro       # gyro cal - HOLD STILL
//   bun run bench:calibration calibrate  # level accel cal - HOLD STILL
//   bun run bench:calibration backup     # save the backup document
//   bun run bench:calibration desync     # invalidate the sensor id + reboot
//   bun run bench:calibration verdict    # does the drone believe its cal?
//   bun run bench:calibration forcesave  # the fix, in isolation
//   bun run bench:calibration restore    # restore + force-save + verify
//
// Nothing here ever arms, spins a motor, or erases storage.

import type { DecodedMessage } from '../../src/protocol/mavlink'
import type { ParamRecord } from '../../src/protocol/params'
import type { ParamBackup } from '../../src/workflow/param-backup'
import { readFileSync, writeFileSync } from 'node:fs'
import { MavFtp } from '../../src/protocol/ftp'
import {
  buildForceSaveCalibration,
  buildPreflightReboot,
  MavLinkSession,
  MSGID_HEARTBEAT,
  MSGID_STATUSTEXT,
} from '../../src/protocol/mavlink'
import { changedParamNames, parseParamPack } from '../../src/protocol/param-pack'
import {
  buildParamRequestList,
  buildParamSet,
  isParamReadOnly,
  MSGID_COMMAND_ACK,
  MSGID_PARAM_VALUE,
} from '../../src/protocol/params'
import {
  buildBackup,
  parseBackup,
  planRestore,
  restoreTouchesCalibration,
  serializeBackup,
} from '../../src/workflow/param-backup'
import { openSerialLink } from './serial-link'

const COMP_ID_AUTOPILOT = 1
const SILENCE_TIMEOUT_MS = 5000
const PARAM_PACK_PATH = '@PARAM/param.pck?withdefaults=1'

// Where the backup document lands between the `backup` and `restore`
// phases. Outside the repo: it is bench state, not a fixture.
const BACKUP_PATH = process.env.BENCH_BACKUP ?? '/tmp/bench-calibration-backup.json'

// The prearm complaint that means "I have accel numbers but don't trust
// them" - AP_Arming.cpp's accel_calibrated_ok_all() branch. Matching the
// firmware's exact string is deliberate: a rename should break this test
// rather than silently turn it into a pass.
const ACCEL_NOT_CAL = '3D Accel calibration needed'

// AP_Arming_Copter::run_pre_arm_checks() reports the motor/frame checks
// from a block that returns before the bitwise-& chain containing the INS
// checks. So on a board with no frame set, prearm says only "Check frame
// class and type" and the accel verdict is never computed - which reads
// exactly like a pass. Detected explicitly and reported as MASKED, because
// a measurement that silently degrades into "looks fine" is worse than no
// measurement at all.
// Every prearm message that means "the INS checks did not run", not
// "they ran and passed". The frame message comes from the motor block
// that returns before the bitwise-& chain; "System not initialised" comes
// from a board still booting, which answers heartbeats well before it
// will evaluate anything. Both look like a pass and neither is one.
// AP_Arming::ins_checks() runs gyro health, gyro calibration and accel
// health ahead of the accel calibration check, each returning immediately
// on failure - so any of them hides the verdict we are measuring.
const MASKING_MESSAGES = [
  'Check frame class and type',
  'System not initialised',
  'Gyros not healthy',
  'Gyros not calibrated',
  'Accels not healthy',
]

// The mask actually seen, for the error message.
function maskedBy(lines: string[]): string | null {
  for (const mask of MASKING_MESSAGES) {
    if (lines.some(l => l.includes(mask)))
      return mask
  }
  return null
}

// MAV_CMD_PREFLIGHT_CALIBRATION param5 = 4 runs simple_accel_cal(): a
// single level-position calibration. Enough for this proof - it saves
// offsets and the accel id and sets _accel_id_ok, which is the whole
// state a restore has to reproduce - without the six-orientation dance.
const ACCEL_CAL_SIMPLE = 4
// param1 = 1 runs the gyro calibration. Needed because the boot-time one
// does not always converge, and a failed gyro check masks the accel
// verdict this test measures.
const GYRO_CAL = 1
// Every accel instance the board can report. desync has to invalidate all
// of them: accel_calibrated_ok_all() walks the full set, so leaving one
// valid would leave the verdict unchanged.
const ACCEL_ID_PARAMS = ['INS_ACC_ID', 'INS_ACC2_ID', 'INS_ACC3_ID']
const CMD_PREFLIGHT_CALIBRATION = 241
const CMD_RUN_PREARM_CHECKS = 401
const MAV_PARAM_TYPE_INT8 = 2
const MAV_PARAM_TYPE_INT16 = 3
const MAV_PARAM_TYPE_INT32 = 6

interface Bench {
  session: MavLinkSession
  send: (bytes: Uint8Array) => void
  close: () => void
  sysid: number
}

// Open the board and wait for the heartbeat that tells us which system to
// address. Shared by every phase.
async function connect(): Promise<Bench> {
  const session = new MavLinkSession()
  const link = openSerialLink()
  link.onData(bytes => session.feed(bytes))
  const port = await link.ready()
  const sysid = await new Promise<number>((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error('no heartbeat within 10s - is the board running firmware?'))
    }, 10_000)
    off = session.on((msg) => {
      if (msg.msgid === MSGID_HEARTBEAT && msg.compid === COMP_ID_AUTOPILOT) {
        clearTimeout(timer)
        off?.()
        resolve(msg.sysid)
      }
    })
  })
  console.log(`[bench] ${port} open, system ${sysid}`)
  return { session, send: bytes => link.write(bytes), close: () => link.close(), sysid }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Stream the full parameter set, stopping on silence rather than on a
// deadline - the same rule the app's param store uses, because a big set
// legitimately takes seconds but a mid-stream gap means it has died.
function streamParams(bench: Bench): Promise<Map<string, ParamRecord>> {
  const params = new Map<string, ParamRecord>()
  const seen = new Set<number>()
  return new Promise((resolve) => {
    let off: (() => void) | null = null
    let silence: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (silence)
        clearTimeout(silence)
      off?.()
      resolve(params)
    }
    const armSilence = (): void => {
      if (silence)
        clearTimeout(silence)
      silence = setTimeout(finish, SILENCE_TIMEOUT_MS)
    }
    off = bench.session.on((msg) => {
      if (msg.msgid !== MSGID_PARAM_VALUE)
        return
      const pv = msg.data as { paramId: string, paramValue: number, paramType: number, paramIndex: number, paramCount: number }
      const name = pv.paramId.replace(/\0.*$/, '')
      if (!seen.has(pv.paramIndex)) {
        seen.add(pv.paramIndex)
        params.set(name, { name, value: pv.paramValue, type: pv.paramType, index: pv.paramIndex })
      }
      armSilence()
      if (pv.paramCount > 0 && seen.size >= pv.paramCount)
        finish()
    })
    bench.send(bench.session.serialize(buildParamRequestList(bench.sysid, COMP_ID_AUTOPILOT)))
    armSilence()
  })
}

// Wait for the COMMAND_ACK matching one command id and return its result.
function awaitAck(bench: Bench, command: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      off?.()
      reject(new Error(`no COMMAND_ACK for command ${command} within ${timeoutMs}ms`))
    }, timeoutMs)
    off = bench.session.on((msg) => {
      if (msg.msgid !== MSGID_COMMAND_ACK)
        return
      const ack = msg.data as { command: number, result: number }
      if (ack.command !== command)
        return
      clearTimeout(timer)
      off?.()
      resolve(ack.result)
    })
  })
}

// Send a COMMAND_LONG built from raw params and return the ack result.
// Local rather than in src/protocol: these are bench fixtures (running a
// calibration, triggering prearm checks), not app capabilities. The
// force-save under test is NOT sent this way - it uses the shipped
// builder, so this test fails if that builder is wrong.
function sendCommand(bench: Bench, command: number, params: number[], timeoutMs = 30_000): Promise<number> {
  const cmd = buildForceSaveCalibration(bench.sysid, COMP_ID_AUTOPILOT)
  cmd.command = command as typeof cmd.command
  const fields = ['_param1', '_param2', '_param3', '_param4', '_param5', '_param6', '_param7'] as const
  fields.forEach((field, i) => {
    ;(cmd as unknown as Record<string, number>)[field] = params[i] ?? 0
  })
  const acked = awaitAck(bench, command, timeoutMs)
  bench.send(bench.session.serialize(cmd))
  return acked
}

// Collect STATUSTEXT lines for a window. The prearm verdict arrives this
// way and nowhere else.
function collectStatusText(bench: Bench, windowMs: number): Promise<string[]> {
  const lines: string[] = []
  return new Promise((resolve) => {
    const off = bench.session.on((msg: DecodedMessage) => {
      if (msg.msgid === MSGID_STATUSTEXT)
        lines.push((msg.data as { text: string }).text.replace(/\0.*$/, ''))
    })
    setTimeout(() => {
      off()
      resolve(lines)
    }, windowMs)
  })
}

// Ask the drone whether it would arm, and report specifically whether it
// trusts its accel calibration. This is the measurement the whole test
// turns on, so it reads the firmware's own words rather than inferring
// from parameter values - the values are exactly what stays valid-looking
// while the drone rejects them.
type AccelVerdict = 'trusts' | 'rejects' | 'masked'

async function accelBelieved(bench: Bench): Promise<{ verdict: AccelVerdict, lines: string[] }> {
  const collecting = collectStatusText(bench, 4000)
  await sendCommand(bench, CMD_RUN_PREARM_CHECKS, [], 10_000).catch(() => -1)
  const lines = await collecting
  if (maskedBy(lines) !== null)
    return { verdict: 'masked', lines }
  if (lines.some(l => l.includes(ACCEL_NOT_CAL)))
    return { verdict: 'rejects', lines }
  return { verdict: 'trusts', lines }
}

// Fail loudly on a masked verdict rather than letting it read as a pass.
function requireVerdict(verdict: AccelVerdict, lines: string[]): 'trusts' | 'rejects' {
  if (verdict === 'masked')
    throw new Error(`prearm stopped at "${maskedBy(lines)}" before reaching the accel check - the verdict is not measurable yet`)
  return verdict
}

// Print the accel parameters that carry the calibration, so a reader can
// see the values survived even in the run where the drone rejects them.
function reportAccelParams(params: Map<string, ParamRecord>): void {
  for (const name of ['INS_ACC_ID', 'INS_ACCOFFS_X', 'INS_ACCOFFS_Y', 'INS_ACCOFFS_Z', 'INS_ACCSCAL_X', 'INS_ACCSCAL_Y', 'INS_ACCSCAL_Z'])
    console.log(`    ${name.padEnd(14)} = ${params.get(name)?.value ?? '(absent)'}`)
}

// Download the packed parameter file and build the same backup document
// the app's Drone settings page would.
async function makeBackup(bench: Bench, params: Map<string, ParamRecord>): Promise<ParamBackup> {
  const ftp = new MavFtp(
    async msg => bench.send(bench.session.serialize(msg)),
    cb => bench.session.on(cb),
    bench.sysid,
    COMP_ID_AUTOPILOT,
  )
  await ftp.resetSessions()
  const pack = parseParamPack(await ftp.downloadFile(PARAM_PACK_PATH))
  const filter = { changed: changedParamNames(pack), isReadOnly: isParamReadOnly }
  return buildBackup(
    params,
    { sysid: bench.sysid, firmwareVersion: null, frameLabel: null, uid: null },
    new Date().toISOString(),
    filter,
  )
}

// PHASE: state. What the drone believes about its accel calibration right
// now. Safe to run at any point; run it between phases to watch the
// belief flip.
async function phaseState(bench: Bench): Promise<void> {
  const params = await streamParams(bench)
  console.log(`  ${params.size} parameters`)
  reportAccelParams(params)
  const { verdict, lines } = await accelBelieved(bench)
  console.log(`  prearm: ${lines.length} message(s)`)
  for (const line of lines)
    console.log(`    "${line}"`)
  console.log(verdict === 'masked'
    ? `  RESULT: MASKED - prearm stopped at "${maskedBy(lines)}"; the accel check never ran`
    : verdict === 'trusts'
      ? '  RESULT: drone TRUSTS its accel calibration'
      : `  RESULT: drone REJECTS its accel calibration ("${ACCEL_NOT_CAL}")`)
}

// PHASE: frame. Set a quad-X frame so prearm gets past the motor checks
// and actually evaluates the accel calibration. Without this every verdict
// in this test is masked. Quad X matches what SITL boots, and the board
// needs a frame set to arm regardless.
async function phaseFrame(bench: Bench): Promise<void> {
  for (const [name, value] of [['FRAME_CLASS', 1], ['FRAME_TYPE', 1]] as const) {
    bench.send(bench.session.serialize(
      buildParamSet(bench.sysid, COMP_ID_AUTOPILOT, name, value, MAV_PARAM_TYPE_INT16),
    ))
    console.log(`  ${name} = ${value}`)
    await sleep(300)
  }
  await sleep(2000)
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))
  console.log('  rebooting to bring the frame up - re-run `state` once it is back')
}

// PHASE: gyro. Calibrate the gyros so their check stops masking the accel
// verdict. Separate from the accel calibration because it is a
// precondition of measuring anything, not part of what is under test.
async function phaseGyro(bench: Bench): Promise<void> {
  console.log('  board must be COMPLETELY STILL - starting in 3s')
  await sleep(3000)
  const collecting = collectStatusText(bench, 20_000)
  const result = await sendCommand(bench, CMD_PREFLIGHT_CALIBRATION, [GYRO_CAL, 0, 0, 0, 0, 0, 0], 40_000)
  for (const line of await collecting)
    console.log(`    "${line}"`)
  console.log(`  COMMAND_ACK result = ${result}${result === 0 ? ' (accepted)' : ' (REJECTED)'}`)
  if (result === 0)
    return

  // calibrate_gyros() needs every gyro to converge, and this bench board
  // has a second IMU that will not - the same one an earlier firmware did
  // not detect at all. The gyro check runs ahead of the accel check and
  // returns on failure, so an unconvergeable gyro makes the thing this
  // test measures permanently unreachable.
  //
  // INS_GYR_CAL = 0 (never) skips _init_gyro() at boot, and _gyro_cal_ok
  // is constructed true, so the saved offsets are taken as good. That is a
  // bench workaround for a bad sensor, not something to suggest to an
  // operator - it is only sound here because the gyros are not what is
  // under test.
  console.log('  gyro calibration will not converge - setting INS_GYR_CAL = 0 so the accel check becomes reachable')
  bench.send(bench.session.serialize(
    buildParamSet(bench.sysid, COMP_ID_AUTOPILOT, 'INS_GYR_CAL', 0, MAV_PARAM_TYPE_INT8),
  ))
  await sleep(2000)
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))
  console.log('  rebooting - re-run `state` once the board is back')
}

// PHASE: calibrate. Level accel calibration, so there is a real
// calibration for the later phases to lose and recover.
async function phaseCalibrate(bench: Bench): Promise<void> {
  console.log('  board must be LEVEL and COMPLETELY STILL - starting in 3s')
  await sleep(3000)
  console.log('  calibrating (up to ~15s, do not touch the board)...')
  const collecting = collectStatusText(bench, 25_000)
  const result = await sendCommand(bench, CMD_PREFLIGHT_CALIBRATION, [0, 0, 0, 0, ACCEL_CAL_SIMPLE, 0, 0], 40_000)
  for (const line of await collecting)
    console.log(`    "${line}"`)
  console.log(`  COMMAND_ACK result = ${result}${result === 0 ? ' (accepted)' : ' (REJECTED)'}`)
  if (result !== 0)
    throw new Error('calibration rejected - board moving, or another calibration in progress')
  await sleep(1000)
  reportAccelParams(await streamParams(bench))
}

// PHASE: backup. Save the backup document the restore phase will use.
async function phaseBackup(bench: Bench): Promise<void> {
  const params = await streamParams(bench)
  const backup = await makeBackup(bench, params)
  writeFileSync(BACKUP_PATH, serializeBackup(backup))
  const names = Object.keys(backup.params)
  const cal = names.filter(n => /^INS_ACC\d?(?:OFFS|SCAL)_[XYZ]$/.test(n))
  console.log(`  saved ${names.length} parameters to ${BACKUP_PATH}`)
  console.log(`  calibration parameters in the backup: ${cal.length ? cal.join(', ') : 'NONE - the test cannot prove anything'}`)
  if (!cal.length)
    throw new Error('no accel calibration in the backup - run the calibrate phase first')
}

// PHASE: desync. Put the drone into the state a restore leaves it in,
// without erasing anything.
//
// The first version of this phase set FORMAT_VERSION to 0, which is the
// documented "reset all parameters" trick. On this board it did not come
// back: AP_Vehicle::load_parameters() answers a format-version mismatch
// with StorageManager::erase() plus AP_Param::erase_all(), and the board
// stopped enumerating altogether (Windows: "Device Descriptor Request
// Failed") and needed a DFU reflash. Do not reach for it again - and note
// that nothing in src/ ever did; the app wipes a drone through the DFU
// mass erase in sfd-recover.ts, which is proven.
//
// This does the same job by a different route. AP_InertialSensor's
// register_accel() clears _accel_id_ok when the saved accel id does not
// match the detected one, which is the identical branch an erased board
// takes (there the id is absent rather than wrong). The calibration values
// stay on the drone and the drone stops believing them - exactly the
// post-restore state, reached without touching storage.
async function phaseDesync(bench: Bench): Promise<void> {
  for (const name of ACCEL_ID_PARAMS) {
    bench.send(bench.session.serialize(
      buildParamSet(bench.sysid, COMP_ID_AUTOPILOT, name, 0, MAV_PARAM_TYPE_INT32),
    ))
    console.log(`  ${name} = 0 (no longer matches the detected accel)`)
    await sleep(300)
  }
  await sleep(2000)
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))
  console.log('  rebooting - re-run `verdict` once the board is back')
}

// PHASE: forcesave. Send the shipped force-save on its own and report the
// verdict either side of it. This is the isolated proof: one command, no
// other change, and the drone's answer flips.
async function phaseForceSave(bench: Bench): Promise<void> {
  const beforeRun = await accelBelieved(bench)
  const before = requireVerdict(beforeRun.verdict, beforeRun.lines)
  console.log(`  BEFORE: drone ${before === 'trusts' ? 'TRUSTS' : 'REJECTS'} the calibration`)

  const acked = awaitAck(bench, CMD_PREFLIGHT_CALIBRATION, 15_000)
  bench.send(bench.session.serialize(buildForceSaveCalibration(bench.sysid, COMP_ID_AUTOPILOT)))
  const result = await acked
  console.log(`  force-save COMMAND_ACK result = ${result}${result === 0 ? ' (accepted)' : ' (REJECTED)'}`)
  await sleep(1000)

  const afterRun = await accelBelieved(bench)
  const after = requireVerdict(afterRun.verdict, afterRun.lines)
  console.log(`  AFTER:  drone ${after === 'trusts' ? 'TRUSTS' : 'REJECTS'} the calibration`)
  console.log('')
  if (before === 'rejects' && after === 'trusts')
    console.log('  RESULT: PROVEN - the force-save alone made the restored calibration valid')
  else if (before === 'trusts')
    console.log('  RESULT: INCONCLUSIVE - the drone already trusted the calibration')
  else
    console.log('  RESULT: FAILED - the force-save did not make the calibration valid')
}

// PHASE: restore. Apply the backup exactly as the app does - writes, then
// the force-save, then the reboot - and report what the drone believes
// once it is back. With `nofix` the force-save is skipped, which is the
// counterfactual: the same restore without the fix.
//
// The verdict is taken after the reboot, not before, for two reasons. It
// is the state the operator actually meets; and an erased board has no
// frame, so a pre-reboot prearm would stop at the motor checks and never
// reach the accel verdict at all.
async function phaseRestore(bench: Bench, applyFix: boolean): Promise<void> {
  const backup = parseBackup(readFileSync(BACKUP_PATH, 'utf8'))
  const params = await streamParams(bench)

  const ftp = new MavFtp(
    async msg => bench.send(bench.session.serialize(msg)),
    cb => bench.session.on(cb),
    bench.sysid,
    COMP_ID_AUTOPILOT,
  )
  await ftp.resetSessions()
  const pack = parseParamPack(await ftp.downloadFile(PARAM_PACK_PATH))
  const plan = planRestore(backup, params, { changed: changedParamNames(pack), isReadOnly: isParamReadOnly })
  console.log(`  plan: ${plan.toWrite.length} to write, ${plan.unchanged.length} already correct, ${plan.missing.length} missing, ${plan.readOnly.length} read-only`)
  console.log(`  restoreTouchesCalibration = ${restoreTouchesCalibration(plan)}`)

  for (const item of plan.toWrite) {
    bench.send(bench.session.serialize(
      buildParamSet(bench.sysid, COMP_ID_AUTOPILOT, item.name, item.backupValue, item.type ?? MAV_PARAM_TYPE_INT16),
    ))
    await sleep(25)
  }
  await sleep(2000)
  console.log(`  wrote ${plan.toWrite.length} parameters`)

  if (applyFix && restoreTouchesCalibration(plan)) {
    const acked = awaitAck(bench, CMD_PREFLIGHT_CALIBRATION, 15_000)
    bench.send(bench.session.serialize(buildForceSaveCalibration(bench.sysid, COMP_ID_AUTOPILOT)))
    const result = await acked
    console.log(`  force-save COMMAND_ACK result = ${result}${result === 0 ? ' (accepted)' : ' (REJECTED)'}`)
  }
  else {
    console.log('  force-save SKIPPED (counterfactual run)')
  }

  await sleep(500)
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))
  console.log('  rebooting - re-run `verdict` once the board is back')
}

// PHASE: reboot. Restart the board without changing anything, so a
// verdict can be re-taken on a fresh boot. The force-save writes the
// sensor id to storage, and "it survives a restart" is the half of the
// claim that a single pre-reboot measurement cannot support.
async function phaseReboot(bench: Bench): Promise<void> {
  bench.send(bench.session.serialize(buildPreflightReboot(bench.sysid, COMP_ID_AUTOPILOT)))
  console.log('  rebooting - re-run `verdict` once the board is back')
}

// PHASE: verdict. The measurement, taken on a board that has rebooted:
// are the restored calibration values there, and does the drone believe
// them? Split from `restore` because the board re-enumerates in between.
async function phaseVerdict(bench: Bench): Promise<void> {
  const params = await streamParams(bench)
  reportAccelParams(params)
  const { verdict, lines } = await accelBelieved(bench)
  for (const line of lines)
    console.log(`    "${line}"`)
  const offsetsBack = (params.get('INS_ACCOFFS_Z')?.value ?? 0) !== 0
  console.log(`  calibration values restored: ${offsetsBack ? 'YES' : 'NO'}`)
  console.log(`  drone believes them: ${requireVerdict(verdict, lines) === 'trusts' ? 'YES' : 'NO'}`)
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  const phases: Record<string, (bench: Bench) => Promise<void>> = {
    'state': phaseState,
    'frame': phaseFrame,
    'gyro': phaseGyro,
    'calibrate': phaseCalibrate,
    'backup': phaseBackup,
    'desync': phaseDesync,
    'forcesave': phaseForceSave,
    'restore': b => phaseRestore(b, true),
    'restore-nofix': b => phaseRestore(b, false),
    'reboot': phaseReboot,
    'verdict': phaseVerdict,
  }
  const run = phase ? phases[phase] : undefined
  if (!run) {
    console.error(`usage: bun run bench:calibration <${Object.keys(phases).join('|')}>`)
    process.exit(2)
  }
  const bench = await connect()
  try {
    console.log(`[phase] ${phase}`)
    await run(bench)
  }
  finally {
    bench.close()
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(`[bench] FAIL: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
