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

// MAVLink builders for individual motor testing — the protocol primitive
// behind the motor-check wizard. ArduCopter exposes MAV_CMD_DO_MOTOR_TEST
// (209): it spins ONE motor (selected by its 1-based test-order number,
// not its output channel) at a given throttle for a timeout, auto-arming
// for the duration. See ArduCopter/motor_test.cpp + GCS_MAVLink_Copter.cpp.
//
// We always drive it in PWM throttle-type mode: that path skips the RC
// calibration pre-check (motor_test.cpp), so a freshly-flashed drone with
// no RC bound can still be motor-tested on the bench. Spinning needs the
// vehicle landed, the safety switch off, and no e-stop — all true on a
// bench with props removed.

import { CommandLong } from 'mavlink-mappings/dist/lib/common'

// MAV_CMD_DO_MOTOR_TEST command id.
const MAV_CMD_DO_MOTOR_TEST = 209

// Throttle-type enum (motor_test.cpp). PWM = direct microseconds, the mode
// that bypasses the RC-cal gate.
export const MOTOR_TEST_THROTTLE_PERCENT = 0
export const MOTOR_TEST_THROTTLE_PWM = 1

// A gentle bench spin. 1150 µs is clearly visible but low-energy; well
// below anything that would lift a propless bench drone.
export const MOTOR_TEST_PWM_SPIN = 1150
// PWM that holds a motor stopped (ESC idle / disarmed throttle).
export const MOTOR_TEST_PWM_STOP = 1000

// Build a DO_MOTOR_TEST that spins a single motor identified by its
// 1-based test-order number (param1). param2 selects PWM throttle type,
// param3 the PWM value, param4 the timeout in seconds, param5 the count
// of motors to test in sequence — always 1 here, because the wizard
// drives the sequence itself so it can sync the UI to each motor.
export function buildMotorTest(
  targetSystem: number,
  targetComponent: number,
  testOrder: number,
  pwm: number,
  timeoutSec: number,
): CommandLong {
  const cmd = new CommandLong()
  cmd.targetSystem = targetSystem
  cmd.targetComponent = targetComponent
  cmd.command = MAV_CMD_DO_MOTOR_TEST as CommandLong['command']
  cmd._param1 = testOrder
  cmd._param2 = MOTOR_TEST_THROTTLE_PWM
  cmd._param3 = pwm
  cmd._param4 = timeoutSec
  cmd._param5 = 1
  cmd._param6 = 0
  cmd._param7 = 0
  cmd.confirmation = 0
  return cmd
}

// Build a DO_MOTOR_TEST that stops a motor early — a zero-spin PWM with a
// 1-second timeout. Sent when the operator answers before the spin
// times out, or as the emergency-stop action for the currently-spinning
// motor. Stopping the active test motor returns all outputs to idle.
export function buildMotorTestStop(
  targetSystem: number,
  targetComponent: number,
  testOrder: number,
): CommandLong {
  return buildMotorTest(targetSystem, targetComponent, testOrder, MOTOR_TEST_PWM_STOP, 1)
}
