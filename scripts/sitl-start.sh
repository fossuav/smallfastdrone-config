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

echo "Starting SITL in $WORK"
"$BIN" -S --model copter --defaults "$DEFAULTS" >sitl.log 2>&1 &
PID=$!
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
