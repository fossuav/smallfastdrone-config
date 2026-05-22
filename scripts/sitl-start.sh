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

# Lua wizard applets pre-placed into SITL's scripts/ dir at boot.
# AP_Filesystem strips the "APM/" prefix used in MAVLink FTP paths, so
# the on-disk path is just <workdir>/scripts/. Currently a no-op at
# runtime — SITL boots with SCR_ENABLE=0 and our attempts to flip it
# on for testing haven't panned out (see docs/TESTING.md "Lua wizards
# in SITL"). Kept here so the mechanism is ready for the day this works.
PRELOAD_WIZARDS=(
  imu-noise
)

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

# Pre-place wizard applets into the SITL work dir. Currently a no-op
# at runtime because SITL boots with SCR_ENABLE=0 (the default), but
# the mechanism is in place for the day Lua loading works in SITL.
if [ ${#PRELOAD_WIZARDS[@]} -gt 0 ]; then
  mkdir -p "$WORK/scripts"
  for wid in "${PRELOAD_WIZARDS[@]}"; do
    src="$REPO_ROOT/src/wizards/$wid/applet.lua"
    if [ -f "$src" ]; then
      dst_name="wiz_${wid//-/_}.lua"
      cp "$src" "$WORK/scripts/$dst_name"
      echo "Preloaded wizard applet: $wid -> scripts/$dst_name"
    fi
  done
fi

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
# --model + is a plus-config quad (the canonical SITL multirotor model).
# --speedup 1 forces real-time.
(
  : ;
  trap 'pkill -P $$ 2>/dev/null; exit 0' INT TERM
  while true; do
    "$BIN" --model + --speedup 1 --defaults "$DEFAULTS" </dev/null >>sitl.log 2>&1 || true
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
