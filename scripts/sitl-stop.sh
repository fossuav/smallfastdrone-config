#!/usr/bin/env bash
# Stop the SITL instance started by scripts/sitl-start.sh.

set -euo pipefail

PIDFILE="/tmp/sfd-sitl.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "No SITL pidfile at $PIDFILE — nothing to stop" >&2
  exit 0
fi

PID=$(cat "$PIDFILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 0.5
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
  echo "Stopped SITL (pid $PID)"
else
  echo "SITL pid $PID not running (stale pidfile)" >&2
fi

rm -f "$PIDFILE" "${PIDFILE}.workdir"
