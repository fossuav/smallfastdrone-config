-- In-field "Set up motors", driven from the radio's CRSF menu — the
-- no-laptop version of the motor-check wizard, at parity with the desktop.
--
-- ESC setup (matches the desktop's first phase): an "ESC setup" submenu
-- picks the output protocol + RPM telemetry and, on "Apply ESCs", writes
-- only the differing params (MOT_PWM_TYPE, and SERVO_BLH_BDMASK/POLES where
-- the build exposes bidir DShot) behind a confirm, then reboots.
--
-- Order/direction check (props OFF): for each motor the operator opens
-- "Spin motor", watches which physical motor turns and which way, and
-- records it via two selections; "Record + next" advances. "Apply fix"
-- plans the correction and, after a confirm step, writes it and reboots.
--
-- The correction maths mirrors the tool's unit-tested planCorrection /
-- escParamEdits (src/workflow/{motor-check,esc-setup}.ts) — keep the two in
-- step. plan_correction prefers a single FRAME_TYPE switch to a standard
-- layout that matches the observed wiring + chosen props orientation
-- (Props In/Out), falling back to a custom SERVOn_FUNCTION remap, with
-- SERVO_BLH_RVMASK reversing residual individual motors. Spinning reuses the
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

-- ESC output protocols, short labels for the radio screen. Value is
-- MOT_PWM_TYPE. Mirrors ESC_PROTOCOLS in esc-setup.ts (recommended first).
local ESC_PROTOS = {
  { label = 'DShot600', value = 6 },
  { label = 'DShot300', value = 5 },
  { label = 'DShot150', value = 4 },
  { label = 'OneShot125', value = 2 },
  { label = 'Normal PWM', value = 0 },
}
local function is_dshot(t) return t >= 4 and t <= 7 end

-- Frame layouts in test order, transcribed from motor-geometry.ts (itself
-- from AP_MotorsMatrix.cpp). Each motor: t = test order, mi = mixer index,
-- pos = short operator-facing position, spin = expected direction.
-- Position codes are unique within a frame — the operator picks one.
-- Each entry: out = props-out orientation, layout = operator-facing layout
-- name (for "switch to a standard layout"). The quad set has all eight
-- order/orientation variants the planner matches against (X / H / Betaflight
-- / DJI / clockwise / +, props-in and -out); hexa/octa carry X + Plus.
-- Positions are by airframe angle so they're consistent across a class's
-- variants (45deg = FR in every quad-X-family layout).
local FRAMES = {
  [1] = { -- QUAD
    [1] = { name = 'Quad X', layout = 'ArduPilot', out = false, motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 3, pos = 'RR', spin = 'cw' },
      { t = 3, mi = 1, pos = 'RL', spin = 'ccw' }, { t = 4, mi = 2, pos = 'FL', spin = 'cw' },
    } },
    [3] = { name = 'Quad X out', layout = 'ArduPilot out', out = true, motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'cw' }, { t = 2, mi = 3, pos = 'RR', spin = 'ccw' },
      { t = 3, mi = 1, pos = 'RL', spin = 'cw' }, { t = 4, mi = 2, pos = 'FL', spin = 'ccw' },
    } },
    [12] = { name = 'Quad BF', layout = 'Betaflight', out = false, motors = {
      { t = 1, mi = 1, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 0, pos = 'RR', spin = 'cw' },
      { t = 3, mi = 2, pos = 'RL', spin = 'ccw' }, { t = 4, mi = 3, pos = 'FL', spin = 'cw' },
    } },
    [18] = { name = 'Quad BF out', layout = 'Betaflight out', out = true, motors = {
      { t = 1, mi = 1, pos = 'FR', spin = 'cw' }, { t = 2, mi = 0, pos = 'RR', spin = 'ccw' },
      { t = 3, mi = 2, pos = 'RL', spin = 'cw' }, { t = 4, mi = 3, pos = 'FL', spin = 'ccw' },
    } },
    [13] = { name = 'Quad DJI', layout = 'DJI', out = false, motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 3, pos = 'RR', spin = 'cw' },
      { t = 3, mi = 2, pos = 'RL', spin = 'ccw' }, { t = 4, mi = 1, pos = 'FL', spin = 'cw' },
    } },
    [14] = { name = 'Quad CW', layout = 'Clockwise', out = false, motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 1, pos = 'RR', spin = 'cw' },
      { t = 3, mi = 2, pos = 'RL', spin = 'ccw' }, { t = 4, mi = 3, pos = 'FL', spin = 'cw' },
    } },
    [0] = { name = 'Quad +', layout = 'Plus', out = false, motors = {
      { t = 1, mi = 2, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 0, pos = 'Rt', spin = 'ccw' },
      { t = 3, mi = 3, pos = 'Aft', spin = 'cw' }, { t = 4, mi = 1, pos = 'Lt', spin = 'ccw' },
    } },
    [6] = { name = 'Quad + out', layout = 'Plus out', out = true, motors = {
      { t = 1, mi = 2, pos = 'Fwd', spin = 'ccw' }, { t = 2, mi = 0, pos = 'Rt', spin = 'cw' },
      { t = 3, mi = 3, pos = 'Aft', spin = 'ccw' }, { t = 4, mi = 1, pos = 'Lt', spin = 'cw' },
    } },
  },
  [2] = { -- HEXA
    [1] = { name = 'Hexa X', layout = 'X', out = false, motors = {
      { t = 1, mi = 4, pos = 'FR', spin = 'ccw' }, { t = 2, mi = 0, pos = 'Rt', spin = 'cw' },
      { t = 3, mi = 3, pos = 'RR', spin = 'ccw' }, { t = 4, mi = 5, pos = 'RL', spin = 'cw' },
      { t = 5, mi = 1, pos = 'Lt', spin = 'ccw' }, { t = 6, mi = 2, pos = 'FL', spin = 'cw' },
    } },
    [0] = { name = 'Hexa +', layout = 'Plus', out = false, motors = {
      { t = 1, mi = 0, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 3, pos = 'FR', spin = 'ccw' },
      { t = 3, mi = 5, pos = 'RR', spin = 'cw' }, { t = 4, mi = 1, pos = 'Aft', spin = 'ccw' },
      { t = 5, mi = 2, pos = 'RL', spin = 'cw' }, { t = 6, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
  },
  [3] = { -- OCTA
    [1] = { name = 'Octa X', layout = 'X', out = false, motors = {
      { t = 1, mi = 0, pos = 'FR', spin = 'cw' }, { t = 2, mi = 2, pos = 'RtF', spin = 'ccw' },
      { t = 3, mi = 7, pos = 'RtR', spin = 'cw' }, { t = 4, mi = 3, pos = 'RR', spin = 'ccw' },
      { t = 5, mi = 1, pos = 'RL', spin = 'cw' }, { t = 6, mi = 5, pos = 'LtR', spin = 'ccw' },
      { t = 7, mi = 6, pos = 'LtF', spin = 'cw' }, { t = 8, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
    [0] = { name = 'Octa +', layout = 'Plus', out = false, motors = {
      { t = 1, mi = 0, pos = 'Fwd', spin = 'cw' }, { t = 2, mi = 2, pos = 'FR', spin = 'ccw' },
      { t = 3, mi = 7, pos = 'Rt', spin = 'cw' }, { t = 4, mi = 3, pos = 'RR', spin = 'ccw' },
      { t = 5, mi = 1, pos = 'Aft', spin = 'cw' }, { t = 6, mi = 5, pos = 'RL', spin = 'ccw' },
      { t = 7, mi = 6, pos = 'Lt', spin = 'cw' }, { t = 8, mi = 4, pos = 'FL', spin = 'ccw' },
    } },
  },
}

-- Flip a spin direction. Mirrors flipSpin in motor-geometry.ts.
local function flip_spin(s) return s == 'cw' and 'ccw' or 'cw' end

-- Resolve the connected frame once at start; remember its class + type so
-- the planner can offer the other standard layouts in the class.
local frame_class, frame_type = nil, nil
local function load_frame()
  local cls = param:get('FRAME_CLASS')
  local typ = param:get('FRAME_TYPE')
  if cls == nil or typ == nil then return nil end
  frame_class = math.floor(cls + 0.5)
  frame_type = math.floor(typ + 0.5)
  local by_type = FRAMES[frame_class]
  if by_type == nil then return nil end
  return by_type[frame_type]
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

-- Recover the physical motor on each output channel from the operator's
-- observations: spin test t drives the channel currently wired to that
-- motor's function, so the reported position/spin belong to that channel.
-- Mirrors recoverPhysical in motor-check.ts.
local function recover_physical(frame, obs, chan_fns)
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
  local seen = {} -- reported positions must be a permutation of the frame's
  for _, p in pairs(phys_pos) do
    if seen[p] then return { inconsistent = true } end
    seen[p] = true
  end
  if count ~= #frame.motors then return { inconsistent = true } end
  return { inconsistent = false, phys_pos = phys_pos, phys_spin = phys_spin }
end

-- Is the output wiring the default 1:1 mapping (SERVOn drives Motor n)? A
-- standard FRAME_TYPE switch only makes sense on default wiring. Mirrors
-- wiringIsDefault in motor-check.ts.
local function wiring_is_default(chan_fns)
  local any = false
  for ch, fn in pairs(chan_fns) do
    any = true
    if fn ~= motor_function_id(ch - 1) then return false end
  end
  return any
end

-- Plan the fix, preferring a single FRAME_TYPE switch to a standard layout
-- over a custom output remap. Mirrors planCorrection in motor-check.ts.
-- Returns: { kind = 'none' } | { kind = 'inconsistent' }
--   | { kind = 'frametype', frame_type, layout, reverse = {ch..} }
--   | { kind = 'remap', remap = {{channel,to}..}, reverse = {ch..} }
local function plan_correction(frame, obs, chan_fns, props_out)
  local b = recover_physical(frame, obs, chan_fns)
  if b.inconsistent then return { kind = 'inconsistent' } end

  -- Prefer a standard layout in the chosen orientation whose motor order
  -- matches the observed wiring (default wiring only).
  if wiring_is_default(chan_fns) then
    for ft, v in pairs(FRAMES[frame_class] or {}) do
      if v.out == props_out and #v.motors == #frame.motors then
        local pos_by_index, spin_by_index = {}, {}
        for _, m in ipairs(v.motors) do
          pos_by_index[m.mi] = m.pos
          spin_by_index[m.mi] = m.spin
        end
        local order_match = true
        for ch, pos in pairs(b.phys_pos) do
          if pos_by_index[ch - 1] ~= pos then
            order_match = false
            break
          end
        end
        if order_match then
          local reverse = {}
          for ch, sp in pairs(b.phys_spin) do
            if sp ~= spin_by_index[ch - 1] then reverse[#reverse + 1] = ch end
          end
          table.sort(reverse)
          if ft == frame_type then
            if #reverse == 0 then return { kind = 'none' } end
            return { kind = 'remap', remap = {}, reverse = reverse }
          end
          return { kind = 'frametype', frame_type = ft, layout = v.layout, reverse = reverse }
        end
      end
    end
  end

  -- Fallback: remap outputs to the current frame + reverse any motor not
  -- turning the chosen-orientation way (the current frame's spin, flipped if
  -- the operator's props orientation differs from the frame's).
  local fn_by_pos, spin_by_pos = {}, {}
  for _, m in ipairs(frame.motors) do
    fn_by_pos[m.pos] = motor_function_id(m.mi)
    spin_by_pos[m.pos] = m.spin
  end
  local remap, reverse = {}, {}
  for ch, pos in pairs(b.phys_pos) do
    local desired = fn_by_pos[pos]
    if desired ~= nil and chan_fns[ch] ~= nil and desired ~= chan_fns[ch] then
      remap[#remap + 1] = { channel = ch, to = desired }
    end
    local base = spin_by_pos[pos]
    local want = (props_out == frame.out) and base or flip_spin(base)
    if b.phys_spin[ch] ~= want then reverse[#reverse + 1] = ch end
  end
  table.sort(reverse)
  if #remap == 0 and #reverse == 0 then return { kind = 'none' } end
  return { kind = 'remap', remap = remap, reverse = reverse }
end

-- Apply a plan: a FRAME_TYPE switch or a SERVOn_FUNCTION remap, then XOR the
-- reverse bits into SERVO_BLH_RVMASK if the FC exposes it. Returns how many
-- reverses we couldn't apply (no reverse-mask param). Mirrors applyCorrections.
local function apply_plan(p)
  if p.kind == 'frametype' then
    param:set_and_save('FRAME_TYPE', p.frame_type)
  elseif p.kind == 'remap' then
    for _, r in ipairs(p.remap) do
      param:set_and_save('SERVO' .. r.channel .. '_FUNCTION', r.to)
    end
  end
  local unfixable = 0
  if p.reverse and #p.reverse > 0 then
    local cur = param:get('SERVO_BLH_RVMASK')
    if cur == nil then
      unfixable = #p.reverse
    else
      local mask = math.floor(cur + 0.5)
      for _, ch in ipairs(p.reverse) do mask = mask ~ (1 << (ch - 1)) end
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
-- ESC-setup state: chosen MOT_PWM_TYPE + bidir telemetry, + pending edits.
local esc_proto = 6 -- default DShot600
local esc_bidir = true
local esc_pending = nil
-- Propeller orientation the operator is building for (props-in default).
-- Selects which standard layouts the planner considers + expected spins.
local props_out = false

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
-- Props orientation: 'In' (ArduPilot default) or 'Out' (Betaflight).
local function on_props(value) props_out = (value == 'Out') end

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

-- COMMAND: compute (frame-type-first) + confirm + apply + reboot.
local function on_apply(action)
  if action == STATUS.START then
    if not frame then return STATUS.READY, 'No frame' end
    pending = plan_correction(frame, obs, read_channel_functions(), props_out)
    if pending.kind == 'inconsistent' then return STATUS.READY, 'Unclear - redo' end
    if pending.kind == 'none' then return STATUS.READY, 'All good!' end
    if pending.kind == 'frametype' then
      return STATUS.CONFIRMATION_NEEDED, 'Set ' .. pending.layout .. '?'
    end
    return STATUS.CONFIRMATION_NEEDED, 'Fix ' .. #pending.remap .. 'mv ' .. #pending.reverse .. 'rev?'
  elseif action == STATUS.CONFIRM then
    if pending == nil or pending.kind == 'inconsistent' or pending.kind == 'none' then
      return STATUS.READY, 'Redo'
    end
    if arming:is_armed() then return STATUS.READY, 'Disarm first!' end
    local unfixable = apply_plan(pending)
    pending = nil
    reboot_at = millis():tofloat() + REBOOT_DELAY_MS
    if unfixable > 0 then return STATUS.READY, 'Set;dir manual' end
    return STATUS.READY, 'Fixed - rebooting'
  elseif action == STATUS.CANCEL then
    pending = nil
    return STATUS.READY, 'Cancelled'
  end
  return STATUS.READY, 'Apply'
end

-- ESC setup (mirrors esc-setup.ts). The bidir-dshot param exists only on
-- builds with HAL_WITH_BIDIR_DSHOT (incl. our SITL branch).
local function bidir_supported() return param:get('SERVO_BLH_BDMASK') ~= nil end

-- The param edits to realise the chosen ESC config — only what differs.
local function esc_param_edits()
  local edits = {}
  local cur = param:get('MOT_PWM_TYPE')
  if cur == nil or math.floor(cur + 0.5) ~= esc_proto then
    edits[#edits + 1] = { 'MOT_PWM_TYPE', esc_proto }
  end
  if bidir_supported() and is_dshot(esc_proto) then
    local want = 0
    if esc_bidir then
      for ch, _ in pairs(read_channel_functions()) do want = want | (1 << (ch - 1)) end
    end
    local curmask = math.floor((param:get('SERVO_BLH_BDMASK') or 0) + 0.5)
    if curmask ~= want then edits[#edits + 1] = { 'SERVO_BLH_BDMASK', want } end
    if esc_bidir then
      local poles = param:get('SERVO_BLH_POLES')
      if poles == nil or math.floor(poles + 0.5) == 0 then
        edits[#edits + 1] = { 'SERVO_BLH_POLES', 14 }
      end
    end
  end
  return edits
end

-- SELECTION callbacks record the operator's ESC picks.
local function on_esc_proto(value)
  for _, p in ipairs(ESC_PROTOS) do
    if p.label == value then esc_proto = p.value end
  end
end
local function on_esc_telem(value) esc_bidir = (value == 'On') end

-- COMMAND: compute + confirm + write ESC params + reboot (reboot-required).
local function on_esc_apply(action)
  if action == STATUS.START then
    esc_pending = esc_param_edits()
    if #esc_pending == 0 then return STATUS.READY, 'Already set' end
    return STATUS.CONFIRMATION_NEEDED, 'Set + reboot?'
  elseif action == STATUS.CONFIRM then
    if esc_pending == nil then return STATUS.READY, 'Apply' end
    if arming:is_armed() then return STATUS.READY, 'Disarm first!' end
    for _, e in ipairs(esc_pending) do param:set_and_save(e[1], e[2]) end
    esc_pending = nil
    reboot_at = millis():tofloat() + REBOOT_DELAY_MS
    return STATUS.READY, 'Set - rebooting'
  elseif action == STATUS.CANCEL then
    esc_pending = nil
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

-- Seed the ESC selections from the FC's current config so the menu opens
-- showing what's already set.
do
  local cur = param:get('MOT_PWM_TYPE')
  if cur ~= nil and is_dshot(math.floor(cur + 0.5)) then esc_proto = math.floor(cur + 0.5) end
  esc_bidir = math.floor((param:get('SERVO_BLH_BDMASK') or 0) + 0.5) > 0
end
local esc_proto_labels, esc_proto_default = {}, 1
for i, p in ipairs(ESC_PROTOS) do
  esc_proto_labels[i] = p.label
  if p.value == esc_proto then esc_proto_default = i end
end
local esc_telem_default = esc_bidir and 1 or 2 -- options { 'On', 'Off' }

-- Seed props orientation from the loaded frame so the planner's default
-- matches what the FC is currently configured as (props-out frame types set
-- it true). Operator can override before applying.
props_out = frame and frame.out or false
local props_default = props_out and 2 or 1 -- options { 'In', 'Out' }

local menu_definition = {
  name = 'Motor check',
  items = {
    { type = 'INFO', name = 'Safety', info = 'PROPS OFF first' },
    -- ESC setup first (matches the desktop wizard order): protocol +
    -- telemetry, then the order/direction check below.
    { type = 'MENU', name = 'ESC setup', items = {
      { type = 'SELECTION', name = 'Protocol', options = esc_proto_labels, default = esc_proto_default, callback = on_esc_proto },
      { type = 'SELECTION', name = 'Telemetry', options = { 'On', 'Off' }, default = esc_telem_default, callback = on_esc_telem },
      { type = 'COMMAND', name = 'Apply ESCs', info = 'Apply', callback = on_esc_apply },
    } },
    status_item,
    { type = 'COMMAND', name = 'Spin motor', info = 'Spin', callback = on_spin },
    { type = 'SELECTION', name = 'Moved at', options = position_options(), default = 1, callback = on_where },
    { type = 'SELECTION', name = 'Spins', options = { 'CW', 'CCW' }, default = 1, callback = on_dir },
    { type = 'COMMAND', name = 'Record + next', info = 'Next', callback = on_next },
    { type = 'SELECTION', name = 'Props', options = { 'In', 'Out' }, default = props_default, callback = on_props },
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
