#!/usr/bin/env bash
# Build ArduCopter SITL from the vendored SmallFastDrone source.
# Slow on first run (5-10 min cold). Subsequent runs are fast via ccache.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SFD="$REPO_ROOT/vendor/smallfastdrone"

if [ ! -f "$SFD/waf" ]; then
  echo "vendor/smallfastdrone is empty — initialise submodules first:" >&2
  echo "  git submodule update --init --recursive" >&2
  echo "or run: bun run setup" >&2
  exit 1
fi

cd "$SFD"
./waf configure --board sitl
./waf copter

echo
echo "SITL built: $SFD/build/sitl/bin/arducopter"
echo "Start with: bun run sitl:start"
