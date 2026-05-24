-- In-field motor-order / direction check, driven from the radio's CRSF
-- menu — the no-laptop version of the motor-check wizard.
--
-- Flow (props OFF): for each motor the operator opens "Spin motor", watches
-- which physical motor turns and which way, and records it via two
-- selections; "Record + next" advances. "Apply fix" works out the
-- correction (a SERVOn_FUNCTION remap for motor order + a SERVO_BLH_RVMASK
-- toggle for direction), and after a confirm step writes it and reboots.
--
-- The correction maths mirrors the tool's unit-tested computeCorrections
-- (src/workflow/motor-check.ts) — keep the two in step. Spinning reuses the
-- firmware MAV_CMD_DO_MOTOR_TEST path via gcs:run_command_int, the same
-- command the desktop wizard sends, so the landed/safety/disarmed gating is
-- the firmware's. Applying is gated on the vehicle being disarmed, behind a
-- menu confirm.

local crsf_helper = require('crsf_helper')
local STATUS = crsf_helper.CRSF_COMMAND_STATUS

local MAV_SEVERITY = { ERROR = 3, WARNING = 4, INFO = 6 }
local MAV_CMD_DO_MOTOR_TEST = 209
local THROTTLE_TYPE_PWM = 1
local SPIN_PWM = 1150 -- gentle, well below lift on a propless bench
local SPIN_TIMEOUT_S = 3
local REBOOT_DELAY_MS = 400
local MAX_SERVO_CHANNELS = 32

-- SERVOn_FUNCTION value for a motor's 0-based mixer index (k_motor1=33..,
-- k_motor9=82..). Mirrors motorFunctionId in motor-check.ts.
local function motor_function_id(idx)
  if idx < 8 then return 33 + idx end
  return 82 + (idx - 8)
end

local function is_motor_function(fn)
  return (fn >= 33 and fn <= 40) or (fn >= 82 and fn <= 85)
end

-- Frame layouts in test order, transcribed from motor-geometry.ts (itself
-- from AP_MotorsMatrix.cpp). Each motor: t = test order, mi = mixer index,
-- pos = short operator-facing position, spin = expected direction.
-- Position codes are unique within a frame — the operator picks one.
local FRAMES = {
  [1] = { -- QUAD
    [1] = { name = 'Quad X', motors = { -- X
      { t = 1, mi = 0, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 3, pos = 'RR', spin = 'cw' },
      { t = 3, mi = 1, pos = 'RL', spin = 'ccw' }, { t = 4, mi = 2, pos = 'FL', spin = 'cw' },
    } },
    [0] = { name = 'Quad +', motors = { -- Plus
      { t = 1, mi = 2, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 0, pos = 'Rt', spin = 'ccw' },
      { t = 3, mi = 3, pos = 'Aft', spin = 'cw' }, { t = 4, mi = 1, pos = 'Lt', spin = 'ccw' },
    } },
  },
  [2] = { -- HEXA
    [1] = { name = 'Hexa X', motors = {
      { t = 1, mi = 4, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 0, pos = 'Rt', spin = 'cw' },
      { t = 3, mi = 3, pos = 'RR', spin = 'ccw' }, { t = 4, mi = 5, pos = 'RL', spin = 'cw' },
      { t = 5, mi = 1, pos = 'Lt', spin = 'ccw' }, { t = 6, mi = 2, pos = 'FL', spin = 'cw' },
    } },
    [0] = { name = 'Hexa +', motors = {
      { t = 1, mi = 0, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 3, pos = 'FR', spin = 'ccw' },
      { t = 3, mi = 5, pos = 'RR', spin = 'cw' }, { t = 4, mi = 1, pos = 'Aft', spin = 'ccw' },
      { t = 5, mi = 2, pos = 'RL', spin = 'cw' }, { t = 6, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
  },
  [3] = { -- OCTA
    [1] = { name = 'Octa X', motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'cw' }, { t = 2, mi = 2, pos = 'RtF', spin = 'ccw' },
      { t = 3, mi = 7, pos = 'RtR', spin = 'cw' }, { t = 4, mi = 3, pos = 'RR', spin = 'ccw' },
      { t = 5, mi = 1, pos = 'RL', spin = 'cw' }, { t = 6, mi = 5, pos = 'LtR', spin = 'ccw' },
      { t = 7, mi = 6, pos = 'LtF', spin = 'cw' }, { t = 8, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
    [0] = { name = 'Octa +', motors = {
      { t = 1, mi = 0, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 2, pos = 'FR', spin = 'ccw' },
      { t = 3, mi = 7, pos = 'Rt', spin = 'cw' }, { t = 4, mi = 3, pos = 'RR', spin = 'ccw' },
      { t = 5, mi = 1, pos = 'Aft', spin = 'cw' }, { t = 6, mi = 5, pos = 'RL', spin = 'ccw' },
      { t = 7, mi = 6, pos = 'Lt', spin = 'cw' }, { t = 8, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
  },
}

-- Resolve the connected frame once at start.
local function load_frame()
  local cls = param:get('FRAME_CLASS')
  local typ = param:get('FRAME_TYPE')
  if cls == nil or typ == nil then return nil end
  local by_type = FRAMES[math.floor(cls + 0.5)]
  if by_type == nil then return nil end
  return by_type[math.floor(typ + 0.5)]
end

-- channel (1-based) -> current SERVOn_FUNCTION, for motor channels only.
local function read_channel_functions()
  local map = {}
  for ch = 1, MAX_SERVO_CHANNELS do
    local v = param:get('SERVO' .. ch .. '_FUNCTION')
    if v ~= nil then
      local fn = math.floor(v + 0.5)
      if is_motor_function(fn) then map[ch] = fn end
    end
  end
  return map
end

-- Turn observations into the fix. Mirrors computeCorrections: recover the
-- physical motor on each output channel, then a remap (channel ->
-- SERVOn_FUNCTION) for order + a list of channels to reverse for direction.
local function compute_corrections(frame, obs, chan_fns)
  local pos_by_fn, spin_by_pos, fn_by_pos = {}, {}, {}
  for _, m in ipairs(frame.motors) do
    local fn = motor_function_id(m.mi)
    pos_by_fn[fn] = m.pos
    spin_by_pos[m.pos] = m.spin
    fn_by_pos[m.pos] = fn
  end
  local chan_by_fn = {}
  for ch, fn in pairs(chan_fns) do chan_by_fn[fn] = ch end

  local phys_pos, phys_spin, count = {}, {}, 0
  for _, m in ipairs(frame.motors) do
    local ch = chan_by_fn[motor_function_id(m.mi)]
    local o = obs[m.t]
    if ch == nil or o == nil then return { inconsistent = true } end
    phys_pos[ch] = o.pos
    phys_spin[ch] = o.spin
    count = count + 1
  end
  -- reported positions must be a permutation of the frame's positions
  local seen = {}
  for _, p in pairs(phys_pos) do
    if seen[p] then return { inconsistent = true } end
    seen[p] = true
  end
  if count ~= #frame.motors then return { inconsistent = true } end

  local remap, reverse = {}, {}
  for ch, p in pairs(phys_pos) do
    local desired = fn_by_pos[p]
    if desired ~= nil and chan_fns[ch] ~= nil and desired ~= chan_fns[ch] then
      remap[#remap + 1] = { channel = ch, to = desired }
    end
    if phys_spin[ch] ~= spin_by_pos[p] then
      reverse[#reverse + 1] = ch
    end
  end
  return { inconsistent = false, remap = remap, reverse = reverse }
end

-- Write the fix: SERVOn_FUNCTION remap, then XOR the reverse bits into
-- SERVO_BLH_RVMASK if the FC exposes it. Returns how many reverses we
-- couldn't apply (no reverse-mask param).
local function apply_corrections(c)
  for _, r in ipairs(c.remap) do
    param:set_and_save('SERVO' .. r.channel .. '_FUNCTION', r.to)
  end
  local unfixable = 0
  if #c.reverse > 0 then
    local cur = param:get('SERVO_BLH_RVMASK')
    if cur == nil then
      unfixable = #c.reverse
    else
      local mask = math.floor(cur + 0.5)
      for _, ch in ipairs(c.reverse) do
        mask = mask ~ (1 << (ch - 1))
      end
      param:set_and_save('SERVO_BLH_RVMASK', mask)
    end
  end
  return unfixable
end

-- Session state.
local frame = load_frame()
local step = 1
local obs = {}
local sel_pos = nil
local sel_dir = nil
local pending = nil -- corrections awaiting confirm
local reboot_at = nil
local status_item -- forward ref to the dynamic INFO item

local function motor_count() return frame and #frame.motors or 0 end

local function current_motor() return frame and frame.motors[step] or nil end

-- Refresh the status INFO line.
local function refresh_status()
  if not status_item then return end
  if not frame then
    status_item.info = 'Frame not supported'
  elseif step > motor_count() then
    status_item.info = 'All ' .. motor_count() .. ' done - Apply'
  else
    local m = current_motor()
    status_item.info = 'Motor ' .. (m.mi + 1) .. ' (' .. step .. '/' .. motor_count() .. ')'
  end
end

-- COMMAND: spin the current motor.
local function on_spin(action)
  if action ~= STATUS.START then return STATUS.READY, 'Spin' end
  local m = current_motor()
  if not m then return STATUS.READY, 'Done' end
  local r = gcs:run_command_int(MAV_CMD_DO_MOTOR_TEST,
    { p1 = m.t, p2 = THROTTLE_TYPE_PWM, p3 = SPIN_PWM, p4 = SPIN_TIMEOUT_S, x = 1 })
  if r == 0 then return STATUS.READY, 'Spinning M' .. (m.mi + 1) end
  return STATUS.READY, 'Wont spin-bench?'
end

-- SELECTION callbacks just record the operator's current pick.
local function on_where(value) sel_pos = value end
local function on_dir(value) sel_dir = (value == 'CW') and 'cw' or 'ccw' end

-- COMMAND: record this motor's answer and advance.
local function on_next(action)
  if action ~= STATUS.START then return STATUS.READY, 'Next' end
  local m = current_motor()
  if not m then return STATUS.READY, 'Done' end
  if sel_pos == nil or sel_dir == nil then return STATUS.READY, 'Pick both' end
  obs[m.t] = { pos = sel_pos, spin = sel_dir }
  step = step + 1
  refresh_status()
  if step > motor_count() then return STATUS.READY, 'Done - Apply' end
  return STATUS.READY, 'Motor ' .. (current_motor().mi + 1)
end

-- COMMAND: compute + confirm + apply + reboot.
local function on_apply(action)
  if action == STATUS.START then
    if not frame then return STATUS.READY, 'No frame' end
    pending = compute_corrections(frame, obs, read_channel_functions())
    if pending.inconsistent then return STATUS.READY, 'Unclear - redo' end
    local nr, nv = #pending.remap, #pending.reverse
    if nr == 0 and nv == 0 then return STATUS.READY, 'All good!' end
    return STATUS.CONFIRMATION_NEEDED, 'Fix ' .. nr .. 'mv ' .. nv .. 'rev?'
  elseif action == STATUS.CONFIRM then
    if pending == nil or pending.inconsistent then return STATUS.READY, 'Redo' end
    if arming:is_armed() then return STATUS.READY, 'Disarm first!' end
    local unfixable = apply_corrections(pending)
    pending = nil
    reboot_at = millis():tofloat() + REBOOT_DELAY_MS
    if unfixable > 0 then return STATUS.READY, 'Order set;dir manual' end
    return STATUS.READY, 'Fixed - rebooting'
  elseif action == STATUS.CANCEL then
    pending = nil
    return STATUS.READY, 'Cancelled'
  end
  return STATUS.READY, 'Apply'
end

-- Build the position picker options for this frame.
local function position_options()
  local opts = {}
  if frame then
    for _, m in ipairs(frame.motors) do opts[#opts + 1] = m.pos end
  else
    opts = { '-' }
  end
  return opts
end

status_item = { type = 'INFO', name = 'Now' }
refresh_status()

local menu_definition = {
  name = 'Motor check',
  items = {
    { type = 'INFO', name = 'Safety', info = 'PROPS OFF first' },
    status_item,
    { type = 'COMMAND', name = 'Spin motor', info = 'Spin', callback = on_spin },
    { type = 'SELECTION', name = 'Moved at', options = position_options(), default = 1, callback = on_where },
    { type = 'SELECTION', name = 'Spins', options = { 'CW', 'CCW' }, default = 1, callback = on_dir },
    { type = 'COMMAND', name = 'Record + next', info = 'Next', callback = on_next },
    { type = 'COMMAND', name = 'Apply fix', info = 'Apply', callback = on_apply },
  },
}

-- Seed the selection defaults so the first motor's picks are non-nil.
sel_pos = position_options()[1]
sel_dir = 'cw'

local crsf_handler, crsf_delay = crsf_helper.register_menu(menu_definition)
if not crsf_handler then
  gcs:send_text(MAV_SEVERITY.ERROR, 'motor-check: CRSF menu init failed')
  return
end
gcs:send_text(MAV_SEVERITY.INFO, 'motor-check CRSF menu ready (' .. (frame and frame.name or 'frame?') .. ')')

-- Wrap the helper's event loop so we can fire the scheduled reboot (a reboot
-- inside the command callback would cut the TX off before the response).
local function main_loop()
  if reboot_at ~= nil and millis():tofloat() >= reboot_at then
    reboot_at = nil
    vehicle:reboot(false)
    return
  end
  local nf, nd = crsf_handler()
  if nf then crsf_handler = nf end
  return main_loop, nd or 200
end

return main_loop, crsf_delay
