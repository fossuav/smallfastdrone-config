-- Props-on motor probe: the drone measures its own motors.
--
-- With props on and the drone flat on the floor (arms resting on it), spin
-- one motor at a time in short pulses from idle, each a step stronger,
-- until its corner lifts. Which way the drone tips says where that motor
-- is; the yaw twitch as it spins up says which way it turns; a corner
-- that never lifts says its prop is pushing down. RPM from the ESCs gives
-- each motor's start throttle. Design: docs/BRINGUP.md "Props-on motor
-- measurement" (PLAN decision 48).
--
-- This is the probe: it measures and reports, and changes no setting the
-- drone keeps. The desktop (src/wizards/motor-probe/) shows the raw
-- results; the thresholds get settled on the bench.
--
-- Safety. The firmware's own motor test does the spinning, re-sent every
-- loop with a DEADMAN_S timeout, so if this script stops for any reason
-- the motor stops by itself. Only one motor ever spins. Any tilt past
-- MPRB_ABORT_DEG, a turn past YAW_ABORT_DEG, or movement while a motor
-- should only be idling stops everything, and so does losing the ground
-- station's heartbeat for MPRB_LINK_MS - a probe that carried on after the
-- laptop was unplugged would be pulsing props with nobody watching.
-- MPRB_ACTIVE is forced to 0 when the script loads: a PARAM_SET saves to
-- storage, and a probe that started itself on the next boot would spin
-- props with nobody standing back.
--
-- Throttle is a fraction of the full motor output range, the same scale
-- as MOT_SPIN_ARM / MOT_SPIN_MIN, sent as PWM so the firmware's RC
-- calibration check is skipped (a bench drone may have no receiver yet).
--
-- Results go to the desktop as NAMED_VALUE_FLOAT, per motor (test order
-- t): Mt START / LIFT (fraction, -1 = never), Mt BRG (degrees clockwise
-- from the nose of the side that lifted), Mt TILT (degrees), Mt YAW
-- (degrees the frame turned during the pulse; negative = the motor turns
-- clockwise from above), Mt RPM (peak), Mt CH (output number, 0 = no
-- telemetry). Each is sent as its motor finishes and re-sent until the
-- desktop clears MPRB_ACTIVE, so a dropped message costs nothing. Every
-- loop is also logged as MPRB.

local PARAM_TABLE_KEY = 151
local PARAM_TABLE_PREFIX = 'MPRB_'

local MAV_SEVERITY = { ERROR = 3, WARNING = 4, INFO = 6 }
local MAV_CMD_DO_MOTOR_TEST = 209
local MAV_RESULT_ACCEPTED = 0
local THROTTLE_TYPE_PWM = 1

local RAD_TO_DEG = 180 / math.pi

-- Loop timing. RUN_MS is the measuring rate; DEADMAN_S must be several
-- loops long so ordinary scheduling jitter never stops a motor early.
local RUN_MS = 10
local IDLE_MS = 500
local DEADMAN_S = 0.15

-- SERVOn_FUNCTION values for Motor1..8 and Motor9..12.
local MOTOR_FN_FIRST = 33
local MOTOR_FN_LAST = 40
local MOTOR9_FN_FIRST = 82
local MOTOR9_FN_LAST = 85
local MAX_ESCS = 16

-- Finding where each motor starts: ramp slowly from near zero until the
-- ESC reports RPM. Starting from idle rather than from stopped makes the
-- pulses consistent - ESC start-up from zero is slow and varies.
local START_FROM = 0.02
local START_RATE = 0.03 -- fraction per second
local START_CAP = 0.2 -- MOT_SPIN_ARM's own upper limit
local START_RPM = 300
local START_CONFIRM = 3 -- consecutive loops above START_RPM
local IDLE_MARGIN = 0.02
local IDLE_FALLBACK = 0.08 -- idle when there is no RPM telemetry

-- Windows around each pulse.
local SETTLE_MS = 1000 -- before the first motor: still, flat, filter settled
local IDLE_HOLD_MS = 600 -- idle before the first pulse; baseline over its tail
local BASELINE_FROM_MS = 200
local OBSERVE_MS = 200 -- after a pulse: the corner keeps rising, then drops
local REST_MIN_MS = 250
local REST_MAX_MS = 1500
local QUIET_DPS = 5 -- the drone has settled back once every rate is below this...
local QUIET_MS = 150 -- ...for this long
local MOTOR_GAP_MS = 500

-- Guards.
local STILL_DPS = 3 -- mean rate before the run that counts as still
local FLAT_DEG = 20
local YAW_ABORT_DEG = 30

local RESEND_MS = 500

local STAGE = {
  OFF = 0, SETTLING = 1, FINDING_START = 2, IDLING = 3, PULSE = 4,
  OBSERVE = 5, RESTING = 6, RAMPING = 7, GAP = 8, DONE = 9, ABORTED = 10,
}

local ABORT = {
  ARMED = 1, MOVING = 2, NOT_FLAT = 3, REFUSED = 4, MOVED_AT_IDLE = 5,
  TIPPED = 6, TURNED = 7, NO_MOTORS = 8, SCRIPT_ERROR = 9, LINK_LOST = 10,
}

local ABORT_TEXT = {
  [ABORT.ARMED] = 'drone is armed',
  [ABORT.MOVING] = 'drone was moving',
  [ABORT.NOT_FLAT] = 'drone is not flat',
  [ABORT.REFUSED] = 'motor test refused',
  [ABORT.MOVED_AT_IDLE] = 'moved while idling',
  [ABORT.TIPPED] = 'tipped past the limit',
  [ABORT.TURNED] = 'turned past the limit',
  [ABORT.NO_MOTORS] = 'no motor outputs',
  [ABORT.SCRIPT_ERROR] = 'script error',
  [ABORT.LINK_LOST] = 'lost the ground station',
}

assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 12), 'could not add param table')

-- Add one of this applet's parameters and bind to it.
local function bind_add_param(name, idx, default_value)
  assert(param:add_param(PARAM_TABLE_KEY, idx, name, default_value), string.format('could not add param %s', name))
  local p = Parameter()
  assert(p:init(PARAM_TABLE_PREFIX .. name), string.format('could not find %s%s', PARAM_TABLE_PREFIX, name))
  return p
end

--[[
  // @Param: MPRB_ACTIVE
  // @DisplayName: Motor probe run
  // @Description: Set to 1 to run the probe; the desktop sets it. Forced to 0 when the script loads.
  // @Values: 0:Off,1:Run
  // @User: Advanced
--]]
local ACTIVE = bind_add_param('ACTIVE', 1, 0)

--[[
  // @Param: MPRB_MODE
  // @DisplayName: Motor probe mode
  // @Description: How each motor is driven towards lift: short pulses of rising strength, or one slow ramp (for comparison).
  // @Values: 0:Pulses,1:Ramp
  // @User: Advanced
--]]
local MODE = bind_add_param('MODE', 2, 0)

--[[
  // @Param: MPRB_PULSE_MS
  // @DisplayName: Motor probe pulse length
  // @Description: Length of each pulse.
  // @Units: ms
  // @Range: 20 300
  // @User: Advanced
--]]
local PULSE_MS = bind_add_param('PULSE_MS', 3, 60)

--[[
  // @Param: MPRB_STEP
  // @DisplayName: Motor probe pulse step
  // @Description: How much stronger each pulse is than the last, as a fraction of the full output range.
  // @Range: 0.01 0.2
  // @User: Advanced
--]]
local STEP = bind_add_param('STEP', 4, 0.05)

--[[
  // @Param: MPRB_CAP
  // @DisplayName: Motor probe throttle cap
  // @Description: The strongest pulse (or ramp) the probe will ever send, as a fraction of the full output range. A corner that has not lifted by here is reported as not lifting.
  // @Range: 0.1 0.9
  // @User: Advanced
--]]
local CAP = bind_add_param('CAP', 5, 0.5)

--[[
  // @Param: MPRB_LIFT_DEG
  // @DisplayName: Motor probe lift threshold
  // @Description: Tilt that counts as the corner lifting.
  // @Units: deg
  // @Range: 0.2 10
  // @User: Advanced
--]]
local LIFT_DEG = bind_add_param('LIFT_DEG', 6, 1.5)

--[[
  // @Param: MPRB_ABORT_DEG
  // @DisplayName: Motor probe abort tilt
  // @Description: Tilt at which the probe stops everything.
  // @Units: deg
  // @Range: 3 45
  // @User: Advanced
--]]
local ABORT_DEG = bind_add_param('ABORT_DEG', 7, 15)

--[[
  // @Param: MPRB_GYRO_HZ
  // @DisplayName: Motor probe gyro filter
  // @Description: Gyro filter cutoff during the run, so a short pulse is not smeared. Only ever raises the drone's own setting; held in memory only and restored afterwards. 0 leaves it alone.
  // @Units: Hz
  // @Range: 0 256
  // @User: Advanced
--]]
local GYRO_HZ = bind_add_param('GYRO_HZ', 8, 60)

--[[
  // @Param: MPRB_REPEATS
  // @DisplayName: Motor probe repeats
  // @Description: Pulses at the lifting strength to average over.
  // @Range: 1 10
  // @User: Advanced
--]]
local REPEATS = bind_add_param('REPEATS', 9, 3)

--[[
  // @Param: MPRB_RAMP_RATE
  // @DisplayName: Motor probe ramp rate
  // @Description: In ramp mode, how fast the throttle rises, as a fraction of the full output range per second.
  // @Range: 0.01 0.5
  // @User: Advanced
--]]
local RAMP_RATE = bind_add_param('RAMP_RATE', 10, 0.05)

--[[
  // @Param: MPRB_LOG
  // @DisplayName: Motor probe logging
  // @Description: Log the run, turning on logging while disarmed for its duration if it is off.
  // @Values: 0:No,1:Yes
  // @User: Advanced
--]]
local LOG = bind_add_param('LOG', 11, 1)

--[[
  // @Param: MPRB_LINK_MS
  // @DisplayName: Motor probe link timeout
  // @Description: Stop the run if no heartbeat has come from the ground station for this long. 0 turns the check off.
  // @Units: ms
  // @Range: 0 10000
  // @User: Advanced
--]]
local LINK_MS = bind_add_param('LINK_MS', 12, 3000)

-- The run in progress, or the last one still being reported; nil when off.
local run = nil
local last_send_ms = 0

-- Milliseconds since boot, as a Lua number.
local function now_ms()
  return millis():tofloat()
end

-- Throttle fraction of the full output range, as the PWM the motor test takes.
local function frac_to_pwm(f)
  return math.floor(run.pwm_min + f * (run.pwm_max - run.pwm_min) + 0.5)
end

-- Ask the firmware to spin the current motor at fraction `f` for
-- DEADMAN_S. Re-sent every loop; the firmware just resets its timer.
local function spin(f)
  local r = gcs:run_command_int(MAV_CMD_DO_MOTOR_TEST,
    { p1 = run.motor, p2 = THROTTLE_TYPE_PWM, p3 = frac_to_pwm(f), p4 = DEADMAN_S, x = 1 })
  run.spinning = (r == MAV_RESULT_ACCEPTED)
  run.throttle = f
  return run.spinning
end

-- Stop the current motor now rather than at the dead-man timeout: a zero
-- timeout ends the firmware's test on its next loop.
local function stop_motor()
  if run and run.spinning then
    gcs:run_command_int(MAV_CMD_DO_MOTOR_TEST,
      { p1 = run.motor, p2 = THROTTLE_TYPE_PWM, p3 = run.pwm_min, p4 = 0, x = 1 })
    run.spinning = false
  end
  if run then
    run.throttle = 0
  end
end

-- Put back the settings the run changed for its own duration.
local function restore_params()
  if run.saved_gyro_hz then
    param:set('INS_GYRO_FILTER', run.saved_gyro_hz)
    run.saved_gyro_hz = nil
  end
  if run.saved_log then
    param:set('LOG_DISARMED', run.saved_log)
    run.saved_log = nil
  end
end

-- How many motor outputs the frame has, which is how many test-order
-- numbers the firmware's motor test accepts.
local function count_motors()
  local n = 0
  for fn = MOTOR_FN_FIRST, MOTOR_FN_LAST do
    if SRV_Channels:find_channel(fn) then
      n = n + 1
    end
  end
  for fn = MOTOR9_FN_FIRST, MOTOR9_FN_LAST do
    if SRV_Channels:find_channel(fn) then
      n = n + 1
    end
  end
  return n
end

-- The fastest-turning ESC and its output number (1-based). Only one motor
-- spins at a time, so whichever reports RPM is the one being tested -
-- which also says which output it is wired to. 0, 0 without telemetry.
local function rpm_max()
  local best, ch = 0, 0
  for i = 0, MAX_ESCS - 1 do
    local rpm = esc_telem:get_rpm(i)
    if rpm and rpm > best then
      best, ch = rpm, i + 1
    end
  end
  return best, ch
end

-- Whether any ESC reports telemetry at all. Without it there is no start
-- to find, so the run goes straight to a fallback idle.
local function telemetry_present()
  for i = 0, MAX_ESCS - 1 do
    if esc_telem:get_rpm(i) then
      return true
    end
  end
  return false
end

-- Start a fresh tilt/turn measurement from here.
local function reset_integrals()
  run.ang_r, run.ang_p, run.ang_y = 0, 0, 0
  run.tilt, run.brg = 0, 0
end

-- Read the gyro, take off the idle baseline, and integrate. Tilt is how
-- far the drone has rotated about any horizontal axis; bearing is which
-- side went up, clockwise from the nose - pitch up lifts the front,
-- roll negative lifts the right.
local function sample(dt)
  local g = ahrs:get_gyro()
  run.gx = g:x() * RAD_TO_DEG - run.bx
  run.gy = g:y() * RAD_TO_DEG - run.by
  run.gz = g:z() * RAD_TO_DEG - run.bz
  run.ang_r = run.ang_r + run.gx * dt
  run.ang_p = run.ang_p + run.gy * dt
  run.ang_y = run.ang_y + run.gz * dt
  run.tilt = math.sqrt(run.ang_r * run.ang_r + run.ang_p * run.ang_p)
  run.brg = math.atan(-run.ang_r, run.ang_p) * RAD_TO_DEG % 360
end

-- Every rate is quiet: the drone has settled back after a pulse.
local function quiet()
  return math.abs(run.gx) < QUIET_DPS and math.abs(run.gy) < QUIET_DPS and math.abs(run.gz) < QUIET_DPS
end

-- The ground station has gone quiet for longer than MPRB_LINK_MS.
local function link_lost()
  local limit = LINK_MS:get()
  return limit > 0 and now_ms() - gcs:last_seen():tofloat() > limit
end

-- Move to a new stage, noting when it began.
local function enter(stage)
  run.stage = stage
  run.t_stage = now_ms()
end

-- Milliseconds spent in the current stage.
local function in_stage()
  return now_ms() - run.t_stage
end

-- Send one motor's result to the desktop.
local function send_result(t)
  local r = run.results[t]
  if not r then
    return
  end
  local p = 'M' .. t
  gcs:send_named_float(p .. 'START', r.start)
  gcs:send_named_float(p .. 'LIFT', r.lift)
  gcs:send_named_float(p .. 'BRG', r.brg)
  gcs:send_named_float(p .. 'TILT', r.tilt)
  gcs:send_named_float(p .. 'YAW', r.yaw)
  gcs:send_named_float(p .. 'RPM', r.rpm)
  gcs:send_named_float(p .. 'CH', r.ch)
end

-- Live progress, and once finished every result, to the desktop.
local function report(force)
  local now = now_ms()
  local finished = run.stage == STAGE.DONE or run.stage == STAGE.ABORTED
  local interval = finished and RESEND_MS or 100
  if not force and now - last_send_ms < interval then
    return
  end
  last_send_ms = now
  gcs:send_named_float('MP_STATE', run.stage)
  gcs:send_named_float('MP_NMOT', run.count)
  gcs:send_named_float('MP_MOT', run.motor or 0)
  gcs:send_named_float('MP_THR', run.throttle or 0)
  gcs:send_named_float('MP_TILT', run.tilt or 0)
  gcs:send_named_float('MP_ABORT', run.abort or 0)
  if finished then
    for t = 1, run.count do
      send_result(t)
    end
  end
end

-- Stop everything and say why. Partial results stay, for the desktop.
local function abort(code)
  stop_motor()
  restore_params()
  run.abort = code
  enter(STAGE.ABORTED)
  gcs:send_text(MAV_SEVERITY.WARNING, 'Motor probe stopped: ' .. ABORT_TEXT[code])
  report(true)
end

-- Begin measuring the current motor: find where it starts.
local function begin_motor()
  run.results[run.motor] = { start = -1, lift = -1, brg = -1, tilt = 0, yaw = 0, rpm = 0, ch = 0 }
  run.level = START_FROM
  run.start_hits = 0
  run.lifts, run.sum_x, run.sum_y, run.sum_yaw, run.sum_tilt = 0, 0, 0, 0, 0
  reset_integrals()
  enter(STAGE.FINDING_START)
end

-- This motor is measured; record it and move on.
local function finish_motor(lift)
  stop_motor()
  local r = run.results[run.motor]
  r.lift = lift
  if run.lifts > 0 then
    r.brg = math.atan(run.sum_y, run.sum_x) * RAD_TO_DEG % 360
    r.tilt = run.sum_tilt / run.lifts
    r.yaw = run.sum_yaw / run.lifts
  end
  if lift < 0 then
    gcs:send_text(MAV_SEVERITY.INFO, string.format('Motor probe %d: no lift by %.0f%%', run.motor, CAP:get() * 100))
  else
    gcs:send_text(MAV_SEVERITY.INFO, string.format('Motor probe %d: lift %.0f%% side %.0f yaw %.1f',
      run.motor, lift * 100, r.brg, r.yaw))
  end
  send_result(run.motor)
  if run.motor >= run.count then
    restore_params()
    enter(STAGE.DONE)
    gcs:send_text(MAV_SEVERITY.INFO, 'Motor probe: done')
    report(true)
    return
  end
  run.motor = run.motor + 1
  enter(STAGE.GAP)
end

-- Record one pulse (or the ramp) that lifted the corner.
local function add_lift(tilt, brg, yaw)
  run.lifts = run.lifts + 1
  run.sum_x = run.sum_x + math.cos(math.rad(brg))
  run.sum_y = run.sum_y + math.sin(math.rad(brg))
  run.sum_tilt = run.sum_tilt + tilt
  run.sum_yaw = run.sum_yaw + yaw
end

-- Start a run: check the drone is ready, then hold it still while the
-- raised gyro filter settles.
local function start_run()
  run = { results = {}, spinning = false, motor = 0, throttle = 0, bx = 0, by = 0, bz = 0,
    gx = 0, gy = 0, gz = 0, count = count_motors() }
  run.pwm_min = param:get('MOT_PWM_MIN') or 1000
  run.pwm_max = param:get('MOT_PWM_MAX') or 2000
  if run.pwm_min < 800 or run.pwm_max <= run.pwm_min then
    run.pwm_min, run.pwm_max = 1000, 2000
  end
  local spin_arm = param:get('MOT_SPIN_ARM') or 0
  run.idle_fallback = spin_arm > 0 and spin_arm or IDLE_FALLBACK
  run.has_telem = telemetry_present()
  run.last_us = micros():tofloat()
  reset_integrals()
  enter(STAGE.SETTLING)
  if arming:is_armed() then
    return abort(ABORT.ARMED)
  end
  if run.count == 0 then
    return abort(ABORT.NO_MOTORS)
  end
  if link_lost() then
    return abort(ABORT.LINK_LOST)
  end
  local own_hz = param:get('INS_GYRO_FILTER')
  if own_hz and GYRO_HZ:get() > own_hz then
    run.saved_gyro_hz = own_hz
    param:set('INS_GYRO_FILTER', GYRO_HZ:get())
  end
  if LOG:get() > 0 and param:get('LOG_DISARMED') == 0 then
    run.saved_log = 0
    param:set('LOG_DISARMED', 1)
  end
  run.still_sum, run.still_n = 0, 0
  gcs:send_text(MAV_SEVERITY.INFO, string.format('Motor probe: %d motors, props on, stand back', run.count))
end

-- One measuring loop of an active run.
local function step(dt)
  sample(dt)
  local stage = run.stage

  if run.tilt > ABORT_DEG:get() then
    return abort(ABORT.TIPPED)
  end
  if link_lost() then
    return abort(ABORT.LINK_LOST)
  end
  if math.abs(run.ang_y) > YAW_ABORT_DEG then
    return abort(ABORT.TURNED)
  end

  if stage == STAGE.SETTLING then
    run.still_sum = run.still_sum + math.abs(run.gx) + math.abs(run.gy) + math.abs(run.gz)
    run.still_n = run.still_n + 1
    if in_stage() < SETTLE_MS then
      return
    end
    if run.still_sum / math.max(run.still_n, 1) > STILL_DPS or run.tilt > LIFT_DEG:get() then
      return abort(ABORT.MOVING)
    end
    if math.abs(ahrs:get_roll_rad()) * RAD_TO_DEG > FLAT_DEG or math.abs(ahrs:get_pitch_rad()) * RAD_TO_DEG > FLAT_DEG then
      return abort(ABORT.NOT_FLAT)
    end
    run.motor = 1
    return begin_motor()
  end

  if stage == STAGE.GAP then
    if in_stage() >= MOTOR_GAP_MS then
      begin_motor()
    end
    return
  end

  local r = run.results[run.motor]
  local rpm, ch = rpm_max()
  if rpm > r.rpm then
    r.rpm = rpm
  end

  if stage == STAGE.FINDING_START then
    if not run.has_telem then
      run.idle = run.idle_fallback
    else
      run.level = math.min(run.level + START_RATE * dt, START_CAP)
      if not spin(run.level) then
        return abort(ABORT.REFUSED)
      end
      if run.tilt > LIFT_DEG:get() then
        return abort(ABORT.MOVED_AT_IDLE)
      end
      run.start_hits = rpm > START_RPM and run.start_hits + 1 or 0
      if run.start_hits >= START_CONFIRM then
        r.start, r.ch = run.level, ch
        run.idle = run.level + IDLE_MARGIN
      elseif run.level >= START_CAP then
        run.idle = run.idle_fallback
      else
        return
      end
    end
    run.base_x, run.base_y, run.base_z, run.base_n = 0, 0, 0, 0
    reset_integrals()
    return enter(STAGE.IDLING)
  end

  if stage == STAGE.IDLING then
    if not spin(run.idle) then
      return abort(ABORT.REFUSED)
    end
    if run.tilt > LIFT_DEG:get() then
      return abort(ABORT.MOVED_AT_IDLE)
    end
    if in_stage() >= BASELINE_FROM_MS then
      run.base_x = run.base_x + run.gx
      run.base_y = run.base_y + run.gy
      run.base_z = run.base_z + run.gz
      run.base_n = run.base_n + 1
    end
    if in_stage() < IDLE_HOLD_MS then
      return
    end
    if run.base_n > 0 then
      run.bx = run.bx + run.base_x / run.base_n
      run.by = run.by + run.base_y / run.base_n
      run.bz = run.bz + run.base_z / run.base_n
    end
    reset_integrals()
    run.max_tilt, run.max_brg = 0, 0
    if MODE:get() == 1 then
      run.level = run.idle
      return enter(STAGE.RAMPING)
    end
    run.level = math.min(run.idle + STEP:get(), CAP:get())
    return enter(STAGE.PULSE)
  end

  if stage == STAGE.RAMPING then
    run.level = run.level + RAMP_RATE:get() * dt
    if run.level > CAP:get() then
      return finish_motor(-1)
    end
    if not spin(run.level) then
      return abort(ABORT.REFUSED)
    end
    if run.tilt >= LIFT_DEG:get() then
      add_lift(run.tilt, run.brg, run.ang_y)
      return finish_motor(run.level)
    end
    return
  end

  if run.tilt > run.max_tilt then
    run.max_tilt, run.max_brg = run.tilt, run.brg
  end

  if stage == STAGE.PULSE then
    if in_stage() >= PULSE_MS:get() then
      run.pulse_yaw = run.ang_y
      enter(STAGE.OBSERVE)
    end
    -- One command per loop: the pulse's last loop already drops to idle.
    if not spin(run.stage == STAGE.PULSE and run.level or run.idle) then
      return abort(ABORT.REFUSED)
    end
    return
  end

  if stage == STAGE.OBSERVE then
    if not spin(run.idle) then
      return abort(ABORT.REFUSED)
    end
    if in_stage() < OBSERVE_MS then
      return
    end
    if run.max_tilt >= LIFT_DEG:get() then
      add_lift(run.max_tilt, run.max_brg, run.pulse_yaw)
      if run.lifts >= REPEATS:get() then
        return finish_motor(run.level)
      end
    elseif run.level >= CAP:get() then
      return finish_motor(-1)
    else
      run.level = math.min(run.level + STEP:get(), CAP:get())
    end
    run.quiet_since = nil
    return enter(STAGE.RESTING)
  end

  if stage == STAGE.RESTING then
    if not spin(run.idle) then
      return abort(ABORT.REFUSED)
    end
    if quiet() then
      run.quiet_since = run.quiet_since or now_ms()
    else
      run.quiet_since = nil
    end
    local settled = run.quiet_since and now_ms() - run.quiet_since >= QUIET_MS
    if in_stage() >= REST_MAX_MS or (settled and in_stage() >= REST_MIN_MS) then
      reset_integrals()
      run.max_tilt, run.max_brg = 0, 0
      enter(STAGE.PULSE)
    end
  end
end

-- Log one loop, for working out thresholds from bench runs.
local function log_loop()
  if LOG:get() > 0 then
    local rpm = rpm_max()
    logger:write('MPRB', 'Mot,Stg,Thr,GX,GY,GZ,Tilt,Brg,Yaw,RPM', 'BBffffffff',
      run.motor, run.stage, run.throttle, run.gx, run.gy, run.gz, run.tilt, run.brg, run.ang_y, rpm)
  end
end

-- Stop the motor and put settings back, whatever state the run is in.
local function shutdown()
  if run then
    stop_motor()
    restore_params()
    run = nil
  end
end

-- Main loop: dormant until the desktop asks; measure while running;
-- report until the desktop has the results.
local function update()
  if ACTIVE:get() == 0 then
    shutdown()
    return IDLE_MS
  end
  if not run then
    start_run()
    return RUN_MS
  end
  if run.stage == STAGE.DONE or run.stage == STAGE.ABORTED then
    report(false)
    return 100
  end

  local now_us = micros():tofloat()
  local dt = (now_us - run.last_us) * 1e-6
  run.last_us = now_us
  if dt <= 0 or dt > 0.1 then
    dt = RUN_MS * 1e-3
  end
  step(dt)
  if run and run.stage ~= STAGE.DONE and run.stage ~= STAGE.ABORTED then
    log_loop()
    report(false)
  end
  return RUN_MS
end

-- Keep a script error from leaving a motor spinning: stop it, put the
-- settings back, and report the run as stopped.
local function protected_wrapper()
  local ok, interval = pcall(update)
  if not ok then
    gcs:send_text(MAV_SEVERITY.ERROR, 'Motor probe error: ' .. tostring(interval))
    pcall(function()
      if run then
        abort(ABORT.SCRIPT_ERROR)
      end
    end)
    return protected_wrapper, 1000
  end
  return protected_wrapper, interval
end

-- A saved MPRB_ACTIVE=1 from before a reboot must never start a run.
if ACTIVE:get() ~= 0 then
  ACTIVE:set_and_save(0)
end
gcs:send_text(MAV_SEVERITY.INFO, 'Motor probe loaded')
return protected_wrapper, IDLE_MS
