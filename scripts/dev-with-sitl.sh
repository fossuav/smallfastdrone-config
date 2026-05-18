#!/usr/bin/env bash
# Run the full SITL stack + bridge + Vite dev server in one terminal.
# Ctrl-C tears everything down. Used via `bun run dev:sitl`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

cleanup() {
  echo
  echo "[dev:sitl] shutting down..."
  # Kill bridge and vite by exact path so we don't hit anything outside this
  # repo (the path includes $REPO_ROOT, so other projects' identically-named
  # processes are untouched).
  pkill -f "$REPO_ROOT/test/sitl/bridge.ts" 2>/dev/null || true
  pkill -f "$REPO_ROOT/node_modules/.bin/vite" 2>/dev/null || true
  "$REPO_ROOT/scripts/sitl-stop.sh" >/dev/null 2>&1 || true
  wait 2>/dev/null || true
  echo "[dev:sitl] done."
}
# EXIT trap always runs cleanup. SIGINT/SIGTERM exit cleanly so bun doesn't
# print `error: script "dev:sitl" exited with code 130` on Ctrl-C.
trap cleanup EXIT
trap 'exit 0' INT TERM

# 1. SITL — uses the subshell-parent trick from scripts/sitl-start.sh.
#    It logs into /tmp/sfd-sitl-XXXXXX/sitl.log; we don't tail that here.
echo "[dev:sitl] starting SITL..."
"$REPO_ROOT/scripts/sitl-start.sh"

# 2. Bridge — prefix output for readability when interleaved with Vite.
echo "[dev:sitl] starting bridge..."
( bun run test/sitl/bridge.ts 2>&1 | sed -u 's/^/[bridge] /' ) &

# 3. Vite dev server.
echo "[dev:sitl] starting Vite dev server..."
( bun run dev 2>&1 | sed -u 's/^/[vite]   /' ) &

# Give them a beat to print their startup banners before the helpful URL.
sleep 2

cat <<EOF

[dev:sitl] everything is up. Open the app at:

  http://localhost:5173/?transport=websocket&host=localhost:5761

Click "Connect drone" — you should see bytes counting up.

Press Ctrl-C to stop SITL + bridge + dev server together.
EOF

# Wait for any child pipeline to exit; cleanup runs via trap.
wait -n
