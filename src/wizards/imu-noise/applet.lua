-- IMU noise check wizard applet.
--
-- Driven by WIZ_NOISE_ACTIVE param (0 = dormant, 1 = run). When the
-- desktop wizard flips ACTIVE to 1, samples the AHRS gyro magnitude
-- at 20 Hz for SAMPLE_DURATION_MS milliseconds while the operator
-- holds the drone still, then reports the max magnitude seen via a
-- NAMED_VALUE_FLOAT named "wn_max". Progress (0..100) is emitted as
-- "wn_prog" so the desktop view can render a moving bar.
--
-- On completion the applet self-disables by setting ACTIVE back to 0
-- and returns to a long-sleep dormant loop. The desktop side does
-- the same defensively in case the applet was killed mid-sample.
--
-- ArduPilot Lua scripts live in APM/scripts/ and load at boot when
-- SCR_ENABLE > 0. The same applet handles repeated wizard runs --
-- each toggle of ACTIVE starts a fresh sample.

local PARAM_TABLE_KEY = 73
local PARAM_TABLE_PREFIX = 'WIZ_NOISE_'
local SAMPLE_DURATION_MS = 5000

-- Register the parameter table the wizard's control param lives in.
-- add_table returns false if the key collides with another script's
-- table; treat as fatal and bail so the operator sees the STATUSTEXT
-- in the message bell.
if not param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 1) then
  gcs:send_text(3, 'wiz_noise: param table key collision')
  return
end
if not param:add_param(PARAM_TABLE_KEY, 1, 'ACTIVE', 0) then
  gcs:send_text(3, 'wiz_noise: failed to add ACTIVE param')
  return
end

-- Bind the control param via a Parameter object for cheap repeated
-- reads/writes in update().
local active = Parameter()
active:init(PARAM_TABLE_PREFIX .. 'ACTIVE')

-- Per-run state, reset every time ACTIVE returns to 0.
local start_time_ms = nil
local max_gyro_mag = 0
local last_progress = -10

function update()
  local v = active:get() or 0
  if v < 0.5 then
    -- Dormant: reset state and check again at a sleepy rate.
    start_time_ms = nil
    max_gyro_mag = 0
    last_progress = -10
    return update, 500
  end

  local now = millis():toint()
  if start_time_ms == nil then
    start_time_ms = now
    max_gyro_mag = 0
    last_progress = -10
    gcs:send_text(6, 'wiz_noise: sampling started')
  end

  -- Magnitude of the AHRS gyro vector in rad/s. ahrs:get_gyro() can
  -- return nil briefly during boot; skip the sample if so.
  local g = ahrs:get_gyro()
  if g then
    local mag = math.sqrt(g:x() ^ 2 + g:y() ^ 2 + g:z() ^ 2)
    if mag > max_gyro_mag then
      max_gyro_mag = mag
    end
  end

  -- Throttled progress emit (only every 5%) so the bell + NVF stream
  -- aren't flooded.
  local elapsed = now - start_time_ms
  local pct = math.floor((elapsed / SAMPLE_DURATION_MS) * 100)
  if pct > 100 then
    pct = 100
  end
  if pct >= last_progress + 5 then
    gcs:send_named_float('wn_prog', pct)
    last_progress = pct
  end

  if elapsed >= SAMPLE_DURATION_MS then
    -- Done: emit final result + self-disable. The desktop view will
    -- also write ACTIVE=0 defensively, but doing it here means the
    -- applet stops sampling immediately even if the desktop dropped
    -- off.
    gcs:send_named_float('wn_max', max_gyro_mag)
    gcs:send_text(6, string.format('wiz_noise: done max=%.4f rad/s', max_gyro_mag))
    active:set(0)
    return update, 500
  end

  -- 20 Hz sampling — high enough to catch typical airframe vibration
  -- harmonics without hogging the scripting scheduler.
  return update, 50
end

return update, 1000
