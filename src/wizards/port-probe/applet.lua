-- Port probe: find out what's plugged into each serial port by listening.
--
-- Every port the desktop has handed to scripting (SERIALn_PROTOCOL 28) is
-- listened to at once, cycling through baud rates, and each device is
-- recognised by its frames - checksums included, so line noise at the wrong
-- baud can't pass for a device. Design: docs/BRINGUP.md "Finding what's
-- plugged in" (PLAN decision 49).
--
-- Recognised: ELRS / Crossfire (CRSF frames to the flight controller),
-- Ghost, FlySky iBUS, and GPS (NMEA or u-blox binary). A script can't set a
-- port's inversion or single-wire mode, so SBUS, SmartAudio, Tramp and
-- FPort are left to ArduPilot's own drivers.
--
-- It changes no setting: the desktop sets each port's role from what this
-- reports, and puts back the ones where nothing was found. It only listens
-- and spins nothing, so it needs no ground-station watchdog. PPRB_ACTIVE is
-- forced to 0 when the script loads, as every wizard applet's run switch is.
--
-- Results go to the desktop as NAMED_VALUE_FLOAT, per port n (its SERIALn
-- number): Sn FOUND (FOUND below), Sn BAUD (the baud it was found at, 0 if
-- none), Sn BYTES (the most bytes heard in one listen). Live: PP_STATE,
-- PP_NPORT, and Sn TRY (the baud a port is being listened at). Re-sent until
-- the desktop clears PPRB_ACTIVE. Each listen is logged as PPRB.

local PARAM_TABLE_KEY = 152
local PARAM_TABLE_PREFIX = 'PPRB_'

local MAV_SEVERITY = { ERROR = 3, WARNING = 4, INFO = 6 }

-- SERIALn_PROTOCOL for a port a script may open.
local PROTOCOL_SCRIPTING = 28
local MAX_SERIAL = 16

-- Baud rates in the order tried: receivers first, since they're the
-- commonest thing on a small drone and the quickest to recognise.
local BAUDS = { 420000, 416666, 115200, 230400, 460800, 57600, 38400, 9600 }
-- What can be on a port at each baud. Checking only these keeps a GPS read
-- at the wrong rate - which SITL, where baud means nothing, would allow -
-- from being reported at a rate no GPS uses.
local RC_AT = { [420000] = true, [416666] = true, [115200] = true }
local GPS_AT = { [115200] = true, [230400] = true, [460800] = true, [57600] = true, [38400] = true, [9600] = true }

local FOUND = { SILENT = 0, TRAFFIC = 1, CRSF = 2, GHOST = 3, IBUS = 4, NMEA = 5, UBX = 6 }
-- Short enough that "Port probe: SERIALn <text>" fits a 50-character
-- status message.
local FOUND_TEXT = {
  [FOUND.SILENT] = 'nothing',
  [FOUND.TRAFFIC] = 'unrecognised traffic',
  [FOUND.CRSF] = 'ELRS/Crossfire RX',
  [FOUND.GHOST] = 'Ghost RX',
  [FOUND.IBUS] = 'iBUS RX',
  [FOUND.NMEA] = 'GPS (NMEA)',
  [FOUND.UBX] = 'GPS (u-blox)',
}

-- Frame addresses to the flight controller, and their longest length field.
local CRSF_TO_FC = 0xC8
local CRSF_LEN_MAX = 62
local GHOST_TO_FC = 0x82
local GHOST_LEN_MAX = 12
-- NMEA's longest sentence, from '$' to the checksum.
local NMEA_MAX = 82

-- Listening.
local SETTLE_MS = 30 -- bytes just after a baud change are half-frames from the last one
local BUF_MAX = 384 -- room for two of any frame recognised here
local READ_MAX = 512
local TRAFFIC_BYTES = 8 -- fewer than this in a listen is a floating pin, not a device
local NEED_FRAMES = 2 -- valid frames before a device counts

local RUN_MS = 20
local IDLE_MS = 500
local REPORT_MS = 200
local RESEND_MS = 500
local CRC_ENTRIES_PER_LOOP = 32

local STAGE = { OFF = 0, PROBING = 1, DONE = 2 }

assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 3), 'could not add param table')

-- Add one of this applet's parameters and bind to it.
local function bind_add_param(name, idx, default_value)
  assert(param:add_param(PARAM_TABLE_KEY, idx, name, default_value), string.format('could not add param %s', name))
  local p = Parameter()
  assert(p:init(PARAM_TABLE_PREFIX .. name), string.format('could not find %s%s', PARAM_TABLE_PREFIX, name))
  return p
end

--[[
  // @Param: PPRB_ACTIVE
  // @DisplayName: Port probe run
  // @Description: Set to 1 to listen on every port whose role is Scripting; the desktop sets it. Forced to 0 when the script loads.
  // @Values: 0:Off,1:Run
  // @User: Advanced
--]]
local ACTIVE = bind_add_param('ACTIVE', 1, 0)

--[[
  // @Param: PPRB_DWELL_MS
  // @DisplayName: Port probe listen time
  // @Description: How long to listen at each baud rate. A GPS often sends once a second, so under a second can miss it.
  // @Units: ms
  // @Range: 300 5000
  // @User: Advanced
--]]
local DWELL_MS = bind_add_param('DWELL_MS', 2, 1200)

--[[
  // @Param: PPRB_LOG
  // @DisplayName: Port probe logging
  // @Description: Log each listen (port, baud, bytes heard, what was found).
  // @Values: 0:No,1:Yes
  // @User: Advanced
--]]
local LOG = bind_add_param('LOG', 3, 1)

-- CRC-8/DVB-S2 by table, built a few entries a loop while dormant: built
-- all at once it would cost more instructions than a script may spend in
-- one go.
local crc_table = {}

-- Build the next few CRC table entries. True once it is complete.
local function build_crc_table()
  local n = #crc_table
  for v = n, math.min(n + CRC_ENTRIES_PER_LOOP, 256) - 1 do
    local crc = v
    for _ = 1, 8 do
      if crc & 0x80 ~= 0 then
        crc = ((crc << 1) ~ 0xD5) & 0xFF
      else
        crc = (crc << 1) & 0xFF
      end
    end
    crc_table[v + 1] = crc
  end
  return #crc_table >= 256
end

-- CRC-8/DVB-S2 over bytes i..j of s: the checksum CRSF and Ghost both use.
local function crc8(s, i, j)
  local crc = 0
  for k = i, j do
    crc = crc_table[(crc ~ s:byte(k)) + 1]
  end
  return crc
end

-- Frames shaped [address][length][type .. payload][crc], CRC-8/DVB-S2 over
-- type and payload: CRSF and Ghost both. Counts valid frames to `address`.
local function count_crc8_frames(s, address, len_max)
  local n, pos = 0, 1
  local sync = string.char(address)
  while n < NEED_FRAMES do
    local i = s:find(sync, pos, true)
    if not i or i + 1 > #s then
      break
    end
    local len = s:byte(i + 1)
    local last = i + len + 1
    if len >= 2 and len <= len_max and last <= #s and crc8(s, i + 2, last - 1) == s:byte(last) then
      n = n + 1
      pos = last + 1
    else
      pos = i + 1
    end
  end
  return n
end

-- iBUS: 32-byte frames starting 0x20 0x40, whose bytes and little-endian
-- checksum add up to 0xFFFF.
local function count_ibus(s)
  local n, pos = 0, 1
  while n < NEED_FRAMES do
    local i = s:find('\x20\x40', pos, true)
    if not i or i + 31 > #s then
      break
    end
    local sum = 0
    for k = i, i + 29 do
      sum = sum + s:byte(k)
    end
    if sum + (s:byte(i + 30) | (s:byte(i + 31) << 8)) == 0xFFFF then
      n = n + 1
      pos = i + 32
    else
      pos = i + 1
    end
  end
  return n
end

-- NMEA: '$' .. '*hh', where hh is the XOR of everything between.
local function count_nmea(s)
  local n, pos = 0, 1
  while n < NEED_FRAMES do
    local i = s:find('$', pos, true)
    if not i then
      break
    end
    local star = s:find('*', i + 1, true)
    if not star then
      break
    end
    if star - i <= NMEA_MAX and star + 2 <= #s then
      local x = 0
      for k = i + 1, star - 1 do
        x = x ~ s:byte(k)
      end
      if tonumber(s:sub(star + 1, star + 2), 16) == x then
        n = n + 1
        pos = star + 3
      else
        pos = i + 1
      end
    else
      pos = i + 1
    end
  end
  return n
end

-- u-blox binary: 0xB5 0x62, class, id, little-endian length, payload, and
-- a Fletcher checksum over class to payload.
local function count_ubx(s)
  local n, pos = 0, 1
  while n < NEED_FRAMES do
    local i = s:find('\xB5\x62', pos, true)
    if not i or i + 5 > #s then
      break
    end
    local len = s:byte(i + 4) | (s:byte(i + 5) << 8)
    local last = i + 7 + len
    if last > #s then
      break
    end
    local a, b = 0, 0
    for k = i + 2, i + 5 + len do
      a = (a + s:byte(k)) & 0xFF
      b = (b + a) & 0xFF
    end
    if a == s:byte(last - 1) and b == s:byte(last) then
      n = n + 1
      pos = last + 1
    else
      pos = i + 1
    end
  end
  return n
end

-- What a listen at `baud` heard, or nil if nothing recognisable.
local function recognise(s, baud)
  if RC_AT[baud] then
    if count_crc8_frames(s, CRSF_TO_FC, CRSF_LEN_MAX) >= NEED_FRAMES then
      return FOUND.CRSF
    end
    if count_crc8_frames(s, GHOST_TO_FC, GHOST_LEN_MAX) >= NEED_FRAMES then
      return FOUND.GHOST
    end
    if count_ibus(s) >= NEED_FRAMES then
      return FOUND.IBUS
    end
  end
  if GPS_AT[baud] then
    if count_ubx(s) >= NEED_FRAMES then
      return FOUND.UBX
    end
    if count_nmea(s) >= NEED_FRAMES then
      return FOUND.NMEA
    end
  end
  return nil
end

-- The run in progress, or the last one still being reported; nil when off.
local run = nil
local last_send_ms = 0

-- Milliseconds since boot, as a Lua number.
local function now_ms()
  return millis():tofloat()
end

-- Start listening on a port at its current baud.
local function listen(p)
  p.dev:begin(BAUDS[p.bi])
  p.dev:configure_parity(0)
  p.dev:set_stop_bits(1)
  p.t0 = now_ms()
  p.buf = ''
  p.bytes = 0
  p.waiting = false
end

-- Send results (and while probing, what each port is trying) to the desktop.
local function report(force)
  local now = now_ms()
  local interval = run.stage == STAGE.DONE and RESEND_MS or REPORT_MS
  if not force and now - last_send_ms < interval then
    return
  end
  last_send_ms = now
  gcs:send_named_float('PP_STATE', run.stage)
  gcs:send_named_float('PP_NPORT', #run.ports)
  for _, p in ipairs(run.ports) do
    local s = 'S' .. p.serial
    if p.done then
      gcs:send_named_float(s .. 'FOUND', p.found)
      gcs:send_named_float(s .. 'BAUD', p.found_baud)
      gcs:send_named_float(s .. 'BYTES', p.max_bytes)
    else
      gcs:send_named_float(s .. 'TRY', BAUDS[p.bi])
    end
  end
end

-- Decide what one finished listen heard, and move that port on.
local function analyse(p)
  local baud = BAUDS[p.bi]
  local found = recognise(p.buf, baud)
  p.max_bytes = math.max(p.max_bytes, p.bytes)
  if LOG:get() > 0 then
    logger:write('PPRB', 'Port,Baud,Bytes,Found', 'BIIB', p.serial, baud, p.bytes, found or 255)
  end
  if found then
    p.found, p.found_baud, p.done = found, baud, true
  elseif p.bi < #BAUDS then
    p.bi = p.bi + 1
    listen(p)
    return
  else
    p.found = p.max_bytes >= TRAFFIC_BYTES and FOUND.TRAFFIC or FOUND.SILENT
    p.done = true
  end
  p.waiting = false
  gcs:send_text(MAV_SEVERITY.INFO, string.format('Port probe: SERIAL%d %s', p.serial, FOUND_TEXT[p.found]))
end

-- Find the ports handed to scripting and start listening on all of them.
-- find_serial counts Scripting ports in SERIALn order, so the nth one found
-- by scanning the parameters is the nth it returns.
local function start_run()
  run = { stage = STAGE.PROBING, ports = {} }
  local serials = {}
  for n = 0, MAX_SERIAL - 1 do
    if param:get(string.format('SERIAL%d_PROTOCOL', n)) == PROTOCOL_SCRIPTING then
      serials[#serials + 1] = n
    end
  end
  for idx, n in ipairs(serials) do
    local dev = serial:find_serial(idx - 1)
    if dev then
      local p = { serial = n, dev = dev, bi = 1, max_bytes = 0, found = FOUND.SILENT, found_baud = 0, done = false }
      listen(p)
      run.ports[#run.ports + 1] = p
    end
  end
  if #run.ports == 0 then
    run.stage = STAGE.DONE
    gcs:send_text(MAV_SEVERITY.WARNING, 'Port probe: no ports set to Scripting')
  else
    gcs:send_text(MAV_SEVERITY.INFO, string.format('Port probe: listening on %d ports', #run.ports))
  end
  report(true)
end

-- One loop of a run: read every port still listening, and analyse at most
-- one finished listen, so a loop never does more work than a script may.
local function step()
  local now = now_ms()
  local dwell = math.max(DWELL_MS:get(), 300)
  for _, p in ipairs(run.ports) do
    if not p.done and not p.waiting then
      local s = p.dev:readstring(READ_MAX)
      if s and #s > 0 and now - p.t0 >= SETTLE_MS then
        p.bytes = p.bytes + #s
        if #p.buf < BUF_MAX then
          p.buf = p.buf .. s:sub(1, BUF_MAX - #p.buf)
        end
      end
      if now - p.t0 >= dwell then
        p.waiting = true
      end
    end
  end
  for _, p in ipairs(run.ports) do
    if p.waiting then
      analyse(p)
      break
    end
  end
  for _, p in ipairs(run.ports) do
    if not p.done then
      return
    end
  end
  run.stage = STAGE.DONE
  gcs:send_text(MAV_SEVERITY.INFO, 'Port probe: done')
  report(true)
end

-- Main loop: dormant until the desktop asks (finishing the CRC table
-- meanwhile); listen while running; report until the desktop has it all.
local function update()
  if ACTIVE:get() == 0 then
    run = nil
    if not build_crc_table() then
      return RUN_MS
    end
    return IDLE_MS
  end
  if not build_crc_table() then
    return RUN_MS
  end
  if not run then
    start_run()
    return RUN_MS
  end
  if run.stage == STAGE.DONE then
    report(false)
    return 100
  end
  step()
  report(false)
  return RUN_MS
end

-- Keep a script error visible, and keep the script alive.
local function protected_wrapper()
  local ok, interval = pcall(update)
  if not ok then
    gcs:send_text(MAV_SEVERITY.ERROR, 'Port probe error: ' .. tostring(interval))
    return protected_wrapper, 1000
  end
  return protected_wrapper, interval
end

-- A saved PPRB_ACTIVE=1 from before a reboot must never start a run.
if ACTIVE:get() ~= 0 then
  ACTIVE:set_and_save(0)
end
gcs:send_text(MAV_SEVERITY.INFO, 'Port probe loaded')
return protected_wrapper, RUN_MS
