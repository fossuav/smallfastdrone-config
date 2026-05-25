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

// ESC output configuration — pure logic for the first phase of the
// "Set up motors" wizard. Owns the protocol choices, the opinionated SFD
// default, and the exact params a chosen config writes. Side-effect free
// and unit-tested; the UI lives in src/wizards/motor-check/EscSetup.vue.
//
// The output protocol (MOT_PWM_TYPE) already encodes the DShot speed
// (DShot150/300/600/1200), so there's no separate "DShot rate" knob at the
// operator level — picking the protocol picks the rate. Bidirectional
// DShot (RPM telemetry, feeds the harmonic notch later) is SERVO_BLH_BDMASK
// + SERVO_BLH_POLES, gated by HAL_WITH_BIDIR_DSHOT. Our SITL branch defines
// that, so the param + config path are exercisable in the sim (the
// telemetry itself is a no-op there); firmware/boards without bidir DShot
// won't expose it. Callers gate on the param's presence (bidirSupported);
// when it's missing, DShot alone is the recommended state.

// Params this phase owns.
export const MOT_PWM_TYPE_PARAM = 'MOT_PWM_TYPE'
export const BIDIR_MASK_PARAM = 'SERVO_BLH_BDMASK'
export const MOTOR_POLES_PARAM = 'SERVO_BLH_POLES'

// MOT_PWM_TYPE values (ArduCopter AP_Motors_Class): DShot variants are 4..7.
export interface EscProtocol {
  value: number
  label: string
  dshot: boolean
}

// Offered protocols, recommended first. Brushed / plain OneShot omitted —
// rare on the small-fast-drone ESCs this tool targets.
export const ESC_PROTOCOLS: EscProtocol[] = [
  { value: 6, label: 'DShot600', dshot: true },
  { value: 5, label: 'DShot300', dshot: true },
  { value: 4, label: 'DShot150', dshot: true },
  { value: 7, label: 'DShot1200', dshot: true },
  { value: 2, label: 'OneShot125', dshot: false },
  { value: 0, label: 'Normal PWM', dshot: false },
]

// SFD default: DShot600 with RPM telemetry.
export const RECOMMENDED_PROTOCOL = 6
// SERVO_BLH_POLES default for typical outrunners; only written if unset/0.
export const DEFAULT_MOTOR_POLES = 14

export function isDshot(motPwmType: number): boolean {
  return motPwmType >= 4 && motPwmType <= 7
}

export function protocolLabel(value: number): string {
  return ESC_PROTOCOLS.find(p => p.value === value)?.label ?? `Type ${value}`
}

// Bitmask of the given 1-based output channels (bit 0 = channel 1) — the
// SERVO_BLH_BDMASK convention (per output channel, like RVMASK).
export function channelsToMask(channels: number[]): number {
  return channels.reduce((mask, ch) => mask | (1 << (ch - 1)), 0)
}

// The ESC config the operator is applying.
export interface EscConfig {
  protocol: number
  // Enable bidirectional DShot (RPM telemetry). Ignored for non-DShot
  // protocols and when the FC doesn't expose the BLHeli params.
  bidir: boolean
}

export interface EscEdit {
  name: string
  value: number
}

// Compute the param edits to realise `config` on a frame whose motor output
// channels are `motorChannels`. Only returns edits that differ from the
// current values, so an already-correct setup yields no edits (→ no reboot).
// `current` reads a param's current numeric value, or undefined if absent.
// `bidirSupported` is whether the FC exposes SERVO_BLH_BDMASK (BLHeli build).
export function escParamEdits(
  config: EscConfig,
  motorChannels: number[],
  current: (name: string) => number | undefined,
  bidirSupported: boolean,
): EscEdit[] {
  const edits: EscEdit[] = []

  const curType = current(MOT_PWM_TYPE_PARAM)
  if (curType === undefined || Math.trunc(curType) !== config.protocol)
    edits.push({ name: MOT_PWM_TYPE_PARAM, value: config.protocol })

  // Bidirectional DShot is only meaningful for DShot protocols on a build
  // that exposes the BLHeli params.
  if (bidirSupported && isDshot(config.protocol)) {
    const wantMask = config.bidir ? channelsToMask(motorChannels) : 0
    const curMask = Math.trunc(current(BIDIR_MASK_PARAM) ?? 0)
    if (curMask !== wantMask)
      edits.push({ name: BIDIR_MASK_PARAM, value: wantMask })
    if (config.bidir) {
      const curPoles = current(MOTOR_POLES_PARAM)
      if (curPoles === undefined || Math.trunc(curPoles) === 0)
        edits.push({ name: MOTOR_POLES_PARAM, value: DEFAULT_MOTOR_POLES })
    }
  }

  return edits
}

// Is the FC's current ESC config already what the wizard would recommend
// (DShot + bidir where supported)? Drives whether the phase shows a tidy
// "looks good, continue" vs a "we'll set this up" prompt.
export function isRecommendedConfig(
  motPwmType: number | undefined,
  bidirMask: number | undefined,
  bidirSupported: boolean,
): boolean {
  if (motPwmType === undefined || !isDshot(Math.trunc(motPwmType)))
    return false
  if (!bidirSupported)
    return true // DShot is as good as it gets on this build
  return Math.trunc(bidirMask ?? 0) > 0
}
