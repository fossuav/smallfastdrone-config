#!/usr/bin/env bash
# Dev environment setup for smallfastdrone-config.
#
# Idempotent — safe to re-run. This script is the source of truth for
# everything needed to develop on this project. When a slice introduces
# a new prerequisite, extend this script in the same commit.
#
# Supported: Linux (Debian/Ubuntu family) and macOS. Windows users:
# run inside WSL2.

set -euo pipefail

# ----- helpers --------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

have()  { command -v "$1" >/dev/null 2>&1; }

# ----- prerequisites --------------------------------------------------

install_bun() {
  if have bun; then
    ok "bun $(bun --version) already installed"
    return
  fi
  info "installing bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  # New shells will pick it up from .bashrc; export for current process
  export PATH="$HOME/.bun/bin:$PATH"
  have bun || fail "bun install reported success but binary not on PATH; open a fresh terminal and re-run"
  ok "bun $(bun --version) installed"
}

install_project_deps() {
  info "installing project deps via bun"
  bun install
  ok "deps installed"
}

# ----- main -----------------------------------------------------------

main() {
  cd "$(dirname "$0")/.."  # repo root

  info "smallfastdrone-config dev environment setup"
  echo

  install_bun
  install_project_deps

  echo
  ok "dev environment ready"
  echo
  echo "Try:"
  echo "  bun dev          # start the Vite dev server"
  echo "  bun run build    # production build"
  echo "  bun run typecheck"
}

main "$@"
