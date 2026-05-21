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
# the on-disk path is just <workdir>/scripts/. Keeps E2E ready for the
# day SITL Lua testing works end-to-end — for now scripting init runs
# with SCR_ENABLE=0 (the SITL default), so the applets sit on disk
# without ever loading and the Lua wizards' E2E exercises the
# "scripting isn't enabled" path. See docs/TESTING.md "Lua wizards in
# SITL" for the full story.
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
# --model + is a plus-config quad (the canonical SITL multirotor model).
# --speedup 1 forces real-time.
#
# The intermediate "( : ; ... ) &" subshell is load-bearing: ArduPilot's
# SITL _fdm_input_step self-terminates if it sees its parent is init (orphan).
# The subshell stays alive waiting for arducopter, keeping it parented.
# The leading ":" (true) is needed so bash doesn't optimise away the subshell.
# This trick is borrowed verbatim from
# vendor/smallfastdrone/Tools/autotest/run_in_terminal_window.sh.
#
( : ; "$BIN" --model + --speedup 1 --defaults "$DEFAULTS" </dev/null >sitl.log 2>&1 ) &
sleep 0.8
PID=$(pgrep -f "$BIN" -n || true)
if [ -z "$PID" ]; then
  echo "SITL did not appear to start. Log:" >&2
  cat sitl.log >&2
  exit 1
fi
echo "$PID" >"$PIDFILE"
echo "$WORK" >"${PIDFILE}.workdir"

# Give SITL a moment, then check it survived
sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
  echo "SITL failed to start. Last log lines:" >&2
  tail -20 "$WORK/sitl.log" >&2
  rm -f "$PIDFILE" "${PIDFILE}.workdir"
  exit 1
fi

echo "SITL listening on TCP 127.0.0.1:5760 (pid $PID)"
echo "Log: $WORK/sitl.log"
echo "Stop with: bun run sitl:stop"
