#!/usr/bin/env bash
# Quick "does this applet load cleanly on SITL?" check — the one-command
# version of the manual dance (place files → enable scripting → reboot →
# watch the GCS text stream for the load + any Lua errors).
#
# Usage:
#   scripts/lua-check.sh <applet.lua> [module.lua ...]
#   bun run lua:check src/wizards/<id>/applet.lua src/wizards/<id>/crsf_helper.lua
#
# Verifies the SITL-checkable half of a Lua/CRSF wizard: the applet parses,
# loads, registers (its own load message shows up), and throws no Lua
# error. The CRSF *menu interaction* still needs a real transmitter.
#
# Reuses a running SITL (scripts/sitl-start.sh) or starts one. Needs
# pymavlink — override the interpreter with PYMAV=... if yours lives
# elsewhere than the default venv.
set -euo pipefail

PIDFILE="/tmp/sfd-sitl.pid"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "usage: $0 <applet.lua> [module.lua ...]" >&2
  exit 2
fi
APPLET="$1"; shift
MODULES=("$@")
[ -f "$APPLET" ] || { echo "applet not found: $APPLET" >&2; exit 2; }

# Find a python that has pymavlink. Override with PYMAV=/path/to/python.
if [ -z "${PYMAV:-}" ]; then
  for cand in /home/andy/venv-ardupilot/bin/python python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import pymavlink' >/dev/null 2>&1; then
      PYMAV="$cand"; break
    fi
  done
fi
if [ -z "${PYMAV:-}" ]; then
  echo "no python with pymavlink found — set PYMAV=/path/to/python" >&2
  exit 2
fi

# Ensure SITL is up; start it (backgrounded) if not.
if [ ! -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "starting SITL…"
  (cd "$REPO_ROOT" && ./scripts/sitl-start.sh >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do [ -f "${PIDFILE}.workdir" ] && break; sleep 1; done
  sleep 6
fi
WORK="$(cat "${PIDFILE}.workdir")"

# Place the applet + any required modules where SITL scripting scans.
mkdir -p "$WORK/APM/scripts/modules"
cp "$APPLET" "$WORK/APM/scripts/$(basename "$APPLET")"
if [ ${#MODULES[@]} -gt 0 ]; then
  for m in "${MODULES[@]}"; do
    [ -f "$m" ] || { echo "module not found: $m" >&2; exit 2; }
    cp "$m" "$WORK/APM/scripts/modules/$(basename "$m")"
  done
fi
echo "placed $(basename "$APPLET") + ${#MODULES[@]} module(s) in $WORK"

# Enable scripting, reboot to load, then watch the GCS text stream. The
# data-stream request after reconnect is load-bearing — without it the
# post-reboot STATUSTEXT stream stays quiet.
"$PYMAV" - <<'PY'
import sys, time
from pymavlink import mavutil

m = mavutil.mavlink_connection('tcp:127.0.0.1:5760')
m.wait_heartbeat(timeout=25)
for _ in range(5):
    m.mav.param_set_send(m.target_system, m.target_component, b'SCR_ENABLE', 1,
                         mavutil.mavlink.MAV_PARAM_TYPE_INT8)
    time.sleep(2)
    m.mav.param_request_read_send(m.target_system, m.target_component, b'SCR_ENABLE', -1)
    pv = m.recv_match(type='PARAM_VALUE', blocking=True, timeout=3)
    if pv and abs(pv.param_value - 1) < 0.1:
        break
time.sleep(3)  # let the SCR_ENABLE save flush before reboot
m.mav.command_long_send(m.target_system, m.target_component,
                        mavutil.mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 0, 1, 0, 0, 0, 0, 0, 0)
time.sleep(13)

m2 = None
for _ in range(8):
    m2 = mavutil.mavlink_connection('tcp:127.0.0.1:5760')
    if m2.wait_heartbeat(timeout=8):
        break
    time.sleep(2)
if m2 is None:
    print('FAIL: SITL did not come back after reboot')
    sys.exit(1)
m2.mav.request_data_stream_send(m2.target_system, m2.target_component,
                                mavutil.mavlink.MAV_DATA_STREAM_ALL, 4, 1)

print('watching scripting messages for ~35s…')
errs = []
t = time.time()
while time.time() - t < 35:
    msg = m2.recv_match(type='STATUSTEXT', blocking=True, timeout=3)
    if not msg:
        continue
    low = msg.text.lower()
    if any(k in low for k in ('lua', 'script', 'crsf', 'menu', 'error', 'traceback')):
        print('  ', msg.text)
        if 'error' in low or 'traceback' in low:
            errs.append(msg.text)
if errs:
    print('RESULT: Lua error(s) ->', errs)
    sys.exit(1)
print('RESULT: no Lua errors (confirm your applet\'s load line appears above)')
PY
