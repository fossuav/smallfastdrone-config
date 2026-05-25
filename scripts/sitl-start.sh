#!/usr/bin/env bash
# Start ArduCopter SITL listening on TCP 127.0.0.1:5760 (primary MAVLink).
# Runs in a temp work directory so generated files (eeprom.bin, logs,
# terrain cache) don't pollute the source tree.
# Stop with `bun run sitl:stop`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SFD="$REPO_ROOT/vendor/smallfastdrone"
BIN="$SFD/build/sitl/bin/arducopter"
DEFAULTS="$SFD/Tools/autotest/default_params/copter.parm"
PIDFILE="/tmp/sfd-sitl.pid"

if [ ! -x "$BIN" ]; then
  echo "SITL binary not built at $BIN" >&2
  echo "Run: bun run sitl:build" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "SITL already running (pid $(cat "$PIDFILE"))" >&2
  exit 1
fi

WORK=$(mktemp -d /tmp/sfd-sitl-XXXXXX)
cd "$WORK"

# Make MAVLink-FTP Lua uploads testable on SITL.
#
# Lua wizards upload their applet via MAVLink FTP to "APM/scripts/" — the
# correct path on real hardware, where the scripting directory IS
# /APM/scripts. But on SITL (posix) the scripting directory is "./scripts"
# (see vendor/.../AP_Scripting/lua_common_defs.h: SCRIPTING_DIRECTORY) and
# FTP writes land at "<workdir>/APM/scripts" — a different directory. The
# applet would never be seen by the scripting engine.
#
# Symlinking ./scripts -> APM/scripts makes both paths resolve to the same
# dir, so an FTP upload to APM/scripts/ lands exactly where SITL scripting
# scans. The wizard's upload path stays hardware-correct and unchanged.
# Created before boot so "./scripts" exists; persists across the wrapper's
# reboot loop because the workdir is reused.
mkdir -p "$WORK/APM/scripts"
ln -s APM/scripts "$WORK/scripts"

# Boot as a quad X with DShot600 (the common SFD layout) rather than SITL's
# built-in Plus/PWM, so the "Set up motors" wizard shows X positions and the
# ESC-setup phase lands already-configured (DShot is the recommended path).
# Applied as a defaults overlay layered on copter.parm.
#
# We deliberately don't set bidirectional DShot here: SERVO_BLH_BDMASK is
# #if HAL_WITH_BIDIR_DSHOT (a hardware timer/DMA feature), so it's compiled
# out of SITL even on the blheli-sitl build — bidir config is hardware-only.
# SERVO_BLH_RVMASK (direction reverse) has no such guard and IS in SITL.
printf 'FRAME_CLASS 1\nFRAME_TYPE 1\nMOT_PWM_TYPE 6\n' >"$WORK/frame.parm"

echo "Starting SITL in $WORK"
# Wrapper subshell: loops arducopter on exit so PREFLIGHT_REBOOT_SHUTDOWN
# triggers a clean restart rather than ending the SITL session. The trap
# pkills the child arducopter before exiting so sitl-stop.sh's TERM on
# the wrapper cascades into a clean SITL shutdown.
#
# The leading ":" inside ( : ; ... ) is the orphan-protection trick the
# wrapper preserves — see vendor/smallfastdrone/Tools/autotest/
# run_in_terminal_window.sh. Without it bash elides the subshell and
# SITL's _fdm_input_step self-terminates on first FDM input.
#
# --model X is a quad-X physics model, matching the X frame we boot via the
# FRAME_TYPE overlay above (--model only sets SIM physics, not the
# autopilot's FRAME_TYPE — that needs the param). --speedup 1 = real-time.
(
  : ;
  trap 'pkill -P $$ 2>/dev/null; exit 0' INT TERM
  while true; do
    "$BIN" --model X --speedup 1 --defaults "$DEFAULTS,$WORK/frame.parm" </dev/null >>sitl.log 2>&1 || true
    # Brief pause so a crash-loop doesn't peg the CPU.
    sleep 0.5
  done
) &
WRAPPER_PID=$!
echo "$WRAPPER_PID" >"$PIDFILE"
echo "$WORK" >"${PIDFILE}.workdir"

# Wait for arducopter to bind the MAVLink port.
for _ in $(seq 1 50); do
  if ss -ltn 2>/dev/null | grep -q ':5760'; then break; fi
  sleep 0.1
done
if ! ss -ltn 2>/dev/null | grep -q ':5760'; then
  echo "SITL did not bind port 5760. Last log lines:" >&2
  tail -20 "$WORK/sitl.log" >&2
  kill -TERM "$WRAPPER_PID" 2>/dev/null || true
  rm -f "$PIDFILE" "${PIDFILE}.workdir"
  exit 1
fi

echo "SITL listening on TCP 127.0.0.1:5760 (wrapper pid $WRAPPER_PID)"
echo "Log: $WORK/sitl.log"
echo "Stop with: bun run sitl:stop"
