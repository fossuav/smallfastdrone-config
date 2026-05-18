#!/usr/bin/env bash
# Start SITL and run the bridge in foreground. Used by Playwright's
# webServer config — kept distinct from sitl-start.sh because:
#   - sitl-start.sh returns once SITL is backgrounded (good for `dev:sitl`,
#     wrong for Playwright which manages its server's lifecycle by pid).
#   - The bridge is the long-running foreground process here; SITL is its
#     dependency, started first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

cleanup() {
  "$REPO_ROOT/scripts/sitl-stop.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# EXIT covers normal + signal-driven exits; explicit INT/TERM trap exits 0
# to mirror dev-with-sitl.sh and keep Playwright's teardown quiet.
trap 'exit 0' INT TERM

"$REPO_ROOT/scripts/sitl-start.sh"

# exec replaces this shell with bun so signals from Playwright go directly
# to the bridge.
exec bun run test/sitl/bridge.ts
